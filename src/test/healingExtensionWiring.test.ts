import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CHECKS_FILE, CHECKS_TEMPLATE } from '../agent/healing';
import { changedFilesScan, findingsToFailures, interruptedNotice, lastWriter, memoryResolver, osvDependencyScan, providerProbe, readAttemptSnapshot, repoGraphView } from '../agent/healing/hostAdapters';
import type { QueueTask } from '../agent/taskQueue';
import { ensureChecksFile } from '../healingHost';
import { queueTaskFor, RECOVERY_COMMANDS, recoveryTarget } from '../ui/recoveryCommands';

const signal = () => new AbortController().signal;
const QUEUE_WHEN = 'viewItem == queueTask.incomplete || viewItem == queueTask.needsInput';

suite('Self-healing: extension wiring', () => {
  let dir: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-heal-ext-'));
  });
  teardown(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  test('recovery command arguments: ids, Agents view nodes and dashboard items', () => {
    assert.deepStrictEqual(recoveryTarget('s1', 'iv1'), { sessionId: 's1', interventionId: 'iv1' });
    assert.deepStrictEqual(recoveryTarget({ kind: 'task', task: { id: 'q1', sessionId: 's2', interventionId: 'iv2' } }), { sessionId: 's2', taskId: 'q1', interventionId: 'iv2' });
    assert.deepStrictEqual(recoveryTarget({ kind: 'session', session: { id: 's3' } }), { sessionId: 's3' });
    assert.deepStrictEqual(recoveryTarget({ sessionId: 's4', id: 'iv4' }), { sessionId: 's4', interventionId: 'iv4' });
    assert.strictEqual(recoveryTarget({ kind: 'task', task: { id: 'q9' } }), undefined);
    assert.strictEqual(recoveryTarget(undefined), undefined);
  });

  test('a recovery maps to the latest incomplete or waiting queue task of its chat', () => {
    const t = (id: string, status: QueueTask['status'], sessionId?: string) => ({ id, status, sessionId, prompt: id, mode: 'agent', createdAt: 0 }) as QueueTask;
    const queue = { list: [t('a', 'incomplete', 's1'), t('b', 'done', 's1'), t('c', 'needs_input', 's1'), t('d', 'incomplete', 's2')] };
    assert.strictEqual(queueTaskFor(queue, { sessionId: 's1' })?.id, 'c');
    assert.strictEqual(queueTaskFor(queue, { sessionId: 's1', taskId: 'a' })?.id, 'a');
    assert.strictEqual(queueTaskFor(queue, { sessionId: 's3' }), undefined);
  });

  test('security stage: secrets in changed files block, outside and low findings do not', async () => {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'keys.ts'), "export const KEY = 'AKIAIOSFODNN7EXAMPLQ';\n");
    await fs.writeFile(path.join(dir, 'src', 'ok.ts'), 'export const x = 1;\n');
    const scan = changedFilesScan();
    const found = await scan(dir, ['src/keys.ts', path.join(dir, 'src', 'ok.ts'), '../outside.ts', 'missing.ts'], signal());
    assert.strictEqual(found.length, 1);
    const f = found[0];
    assert.strictEqual(f.category, 'security');
    assert.strictEqual(f.cls, 'policy');
    assert.strictEqual(f.code, 'aws-access-key');
    assert.strictEqual(f.file, 'src/keys.ts');
    assert.strictEqual(f.line, 1);
    assert.ok(f.signature && f.generic && f.id);
    assert.ok(!f.evidence.includes('AKIAIOSFODNN7EXAMPLQ'), 'the secret is masked');
    assert.deepStrictEqual(findingsToFailures([{ kind: 'code', severity: 'low', id: 'eval', title: 'eval', file: 'a.ts' }], dir), []);
    const twice = findingsToFailures([{ kind: 'secret', severity: 'high', id: 'k', title: 't', file: 'a.ts', line: 2 }, { kind: 'secret', severity: 'high', id: 'k', title: 't', file: 'a.ts', line: 2 }], dir);
    assert.strictEqual(twice.length, 1, 'duplicates fold into one signature');
  });

  test('dependency advisories only after the network approval', async () => {
    let scanned = 0;
    const scan = async (root: string) => {
      scanned++;
      return {
        root, files: 0, dependencies: 1, skipped: [],
        findings: [{ kind: 'dependency' as const, severity: 'critical' as const, id: 'GHSA-xxxx', title: 'Prototype pollution', file: 'package-lock.json', package: { ecosystem: 'npm', name: 'lodash', version: '4.17.0' }, fix: '4.17.21' }],
      };
    };
    const denied = await osvDependencyScan(async () => false, { scan })(dir, signal());
    assert.deepStrictEqual(denied, []);
    assert.strictEqual(scanned, 0);
    const allowed = await osvDependencyScan(async () => true, { scan })(dir, signal());
    assert.strictEqual(scanned, 1);
    assert.strictEqual(allowed.length, 1);
    assert.strictEqual(allowed[0].symbol, 'lodash');
    assert.strictEqual(allowed[0].severity, 'critical');
  });

  test('repo graph view: neighbours and import edges, absolute or relative', () => {
    const deps = new Map([['src/a.ts', new Set(['src/b.ts'])], ['src/b.ts', new Set<string>()]]);
    const rdeps = new Map([['src/b.ts', new Set(['src/a.ts', 'src/c.ts'])]]);
    const g = repoGraphView({ root: dir, deps, rdeps });
    assert.deepStrictEqual([...g.neighbours('src/b.ts')].sort(), ['src/a.ts', 'src/c.ts']);
    assert.deepStrictEqual(g.neighbours(path.join(dir, 'src', 'a.ts')), ['src/b.ts']);
    assert.strictEqual(g.importEdge('src/a.ts', 'src/b.ts'), true);
    assert.strictEqual(g.importEdge('src/b.ts', 'src/a.ts'), false);
  });

  test('provider probe: model ref or provider id; unknown targets are not reported down', async () => {
    const asked: string[] = [];
    const probe = providerProbe((id) => (id === 'ollama' ? { healthCheck: async () => (asked.push(id), false) } : undefined));
    assert.strictEqual(await probe('ollama/qwen3:8b'), false);
    assert.strictEqual(await probe('ollama'), false);
    assert.strictEqual(await probe('other/model'), true);
    assert.deepStrictEqual(asked, ['ollama', 'ollama']);
    const throws = providerProbe(() => ({ healthCheck: () => Promise.reject(new Error('down')) }));
    assert.strictEqual(await throws('x'), false);
  });

  test('foreign writer: the most recent live session that changed the file', () => {
    const file = path.join(dir, 'a.ts');
    const changes = [
      { sessionId: 's1', fsPath: file, changedAt: 1 },
      { sessionId: 's2', fsPath: file, changedAt: 5 },
      { sessionId: 's3', fsPath: file, changedAt: 9 },
      { sessionId: 's2', fsPath: path.join(dir, 'b.ts'), changedAt: 20 },
    ];
    assert.strictEqual(lastWriter(changes, new Set(['s1', 's2']), file), 's2');
    assert.strictEqual(lastWriter(changes, new Set(['s4']), file), undefined);
  });

  test('failure memory: per scope, project file unread in untrusted workspaces, off = none', () => {
    let scope: 'workspace' | 'project' | 'off' = 'workspace';
    let trusted = false;
    const memory = memoryResolver({ scope: () => scope, storageDir: dir, trusted: () => trusted });
    const ws = memory('/repo')!;
    assert.strictEqual(ws.file, path.join(dir, 'recovery', 'memory.json'));
    assert.strictEqual(memory('/other'), ws, 'one workspace store for every root');
    scope = 'project';
    const untrusted = memory('/repo')!;
    assert.strictEqual(untrusted.file, path.join('/repo', '.localpilot', 'recovery-memory.json'));
    assert.strictEqual((untrusted as unknown as { readable: boolean }).readable, false);
    trusted = true;
    const readable = memory('/repo')!;
    assert.notStrictEqual(readable, untrusted);
    assert.strictEqual((readable as unknown as { readable: boolean }).readable, true);
    scope = 'off';
    assert.strictEqual(memory('/repo'), undefined);
  });

  test('attempt snapshots for Open diff', async () => {
    const write = (rel: string, rec: object) => fs.writeFile(path.join(dir, `${createHash('sha1').update(rel).digest('hex')}.json`), JSON.stringify(rec));
    await write('src/a.ts', { v: 1, file: 'src/a.ts', existed: true, content: 'before', at: 1 });
    await write('src/new.ts', { v: 1, file: 'src/new.ts', existed: false, at: 1 });
    assert.deepStrictEqual(await readAttemptSnapshot(dir, 'src/a.ts'), { text: 'before', binary: false });
    assert.strictEqual(await readAttemptSnapshot(dir, 'src/new.ts'), null);
    assert.strictEqual(await readAttemptSnapshot(dir, 'src/gone.ts'), undefined);
  });

  test('start-up notice skips recoveries the queue resumes by itself', () => {
    const items = [{ sid: 's1', phase: 'interrupted' as const, attempt: 2, max: 3, category: 'typescript' as const }, { sid: 's2', phase: 'interrupted' as const, attempt: 1, max: 3 }];
    assert.strictEqual(interruptedNotice(items, new Set(['s1', 's2'])), undefined);
    const one = interruptedNotice(items, new Set(['s2']))!;
    assert.deepStrictEqual(one.sids, ['s1']);
    assert.ok(one.text.includes('attempt 2/3') && one.text.includes('typescript'), one.text);
    assert.deepStrictEqual(interruptedNotice(items, new Set())!.sids, ['s1', 's2']);
  });

  test('checks.json is created from the template once and never overwritten', async () => {
    const first = await ensureChecksFile(dir);
    assert.strictEqual(first.created, true);
    assert.strictEqual(first.file, path.join(dir, CHECKS_FILE));
    assert.strictEqual(await fs.readFile(first.file, 'utf8'), CHECKS_TEMPLATE);
    await fs.writeFile(first.file, '{"checks":[]}');
    const second = await ensureChecksFile(dir);
    assert.strictEqual(second.created, false);
    assert.strictEqual(await fs.readFile(first.file, 'utf8'), '{"checks":[]}');
  });

  test('package.json contributes the recovery commands and the queue task menus', () => {
    const pkg = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON as {
      contributes: { commands: { command: string; category?: string }[]; menus: Record<string, { command: string; when?: string }[]> };
    };
    for (const id of Object.values(RECOVERY_COMMANDS)) {
      const c = pkg.contributes.commands.find((x) => x.command === id);
      assert.ok(c, `${id} contributed`);
      assert.strictEqual(c!.category, 'LocalPilot');
    }
    const items = pkg.contributes.menus['view/item/context'];
    for (const id of [RECOVERY_COMMANDS.open, RECOVERY_COMMANDS.resume, RECOVERY_COMMANDS.rollback]) {
      assert.ok(items.some((m) => m.command === id && m.when === QUEUE_WHEN), `${id} on incomplete/waiting queue tasks`);
    }
  });

  test('activation registers the commands and extends the API', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    await ext.activate();
    const api = ext.exports as { lastOutcome(sid: string): unknown; recovery: { state(sid: string): Promise<unknown>; interventions(): Promise<unknown[]>; resume: unknown; rollback: unknown } };
    const registered = await vscode.commands.getCommands(true);
    for (const id of Object.values(RECOVERY_COMMANDS)) {
      assert.ok(registered.includes(id), `${id} registered`);
    }
    assert.strictEqual(api.lastOutcome('no-such-session'), undefined);
    assert.strictEqual(await api.recovery.state('no-such-session'), undefined);
    assert.ok(Array.isArray(await api.recovery.interventions()));
    assert.strictEqual(typeof api.recovery.resume, 'function');
    assert.strictEqual(typeof api.recovery.rollback, 'function');
  });
});
