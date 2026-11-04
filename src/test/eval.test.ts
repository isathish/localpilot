import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { AgentRunner } from '../agent/agentLoop';
import { checkStatic, EvalRun, loadSuite, previousRun, projectSuites, runTask, saveRun, writeFiles } from '../eval/runner';
import { BUILTIN_SUITE, EvalTask } from '../eval/suite';

suite('Benchmark (eval runner)', () => {
  test('project suites: sorted by name, saved runs left out', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-evals-'));
    try {
      const dir = path.join(root, '.localpilot', 'evals');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify({ name: 'b', tasks: [] }));
      await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify({ name: 'a', tasks: [] }));
      await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ suite: 'x', results: [] }));
      assert.deepStrictEqual(await projectSuites(root), [path.join(dir, 'a.json'), path.join(dir, 'b.json')]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('task files must stay inside the task folder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-evals-'));
    try {
      const dir = path.join(root, 'task');
      await fs.mkdir(dir);
      await assert.rejects(writeFiles(dir, { '../escape.txt': 'x' }), /must stay inside the task folder/);
      await assert.rejects(fs.access(path.join(root, 'escape.txt')));
      await writeFiles(dir, { 'sub/ok.txt': 'x' });
      assert.strictEqual(await fs.readFile(path.join(dir, 'sub', 'ok.txt'), 'utf8'), 'x');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('ask-impact: unaffected files fail in any order, backslash paths pass', () => {
    const task = BUILTIN_SUITE.tasks.find((t) => t.id === 'ask-impact')!;
    const check = (answer: string) => checkStatic(task, () => undefined, answer);
    assert.ok(check('app/other.ts could break, as could lib/trip.ts and app/summary.ts.'));
    assert.ok(check('lib/trip.ts, app/summary.ts, app/other.ts'));
    assert.strictEqual(check('lib/trip.ts and app/summary.ts'), undefined);
    assert.strictEqual(check('lib\\trip.ts, app\\summary.ts'), undefined);
  });

  test('suite files: malformed tasks are rejected by id, files default to {}', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-evals-'));
    try {
      const write = async (name: string, tasks: unknown[]) => {
        const f = path.join(root, name);
        await fs.writeFile(f, JSON.stringify({ name: 'x', tasks }));
        return f;
      };
      await assert.rejects(loadSuite(await write('a.json', [{ id: 'no-prompt', verify: {} }])), /no-prompt/);
      await assert.rejects(loadSuite(await write('b.json', [{ id: 'bad-re', prompt: 'p', verify: { files: [{ path: 'a.py', pattern: 'round(' }] } }])), /bad-re/);
      const ok = await loadSuite(await write('c.json', [{ id: 'ok', title: 'ok', category: 'edit', prompt: 'p', verify: { answer: 'yes' } }]));
      assert.deepStrictEqual(ok.tasks[0].files, {});
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('saved runs: names are file-safe, the baseline is the same suite only', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-evals-home-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const result = (model: string) => ({ task: 't', category: 'edit' as const, model, pass: true, durationMs: 1, steps: 1, toolCalls: 0, toolErrors: 0, promptTokens: 0, completionTokens: 0 });
      const run = (suite: string, startedAt: string): EvalRun => ({ suite, startedAt, host: 'h', results: [result('m')] });
      await saveRun(run('api', '2026-01-01T00:00:00.000Z'));
      await saveRun(run('backend-api', '2026-01-02T00:00:00.000Z'));
      const prev = await previousRun('api', 'm', '2026-02-01T00:00:00.000Z');
      assert.strictEqual(prev?.suite, 'api');
      const file = await saveRun(run('team/backend', '2026-01-03T00:00:00.000Z'));
      assert.strictEqual(path.dirname(file), path.join(home, '.localpilot', 'evals'));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test('a cancelled run is skipped without calling the agent', async () => {
    let called = false;
    const runner = { run: async () => { called = true; return 'done'; } } as unknown as AgentRunner;
    const task: EvalTask = { id: 't', title: 't', category: 'edit', files: {}, prompt: 'p', verify: {} };
    const ctl = new AbortController();
    ctl.abort();
    const r = await runTask(runner, task, 'm', { signal: ctl.signal });
    assert.strictEqual(r.skipped, 'cancelled');
    assert.strictEqual(called, false);
  });
});
