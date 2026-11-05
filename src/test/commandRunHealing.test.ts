import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandRun, CommandRunOptions, commandLogDir, detachCommand, detachWaiting, onCommandRunChange, runningCommands, setCommandLogDir, stopCommand } from '../terminal/commandRun';
import { runCommandTool } from '../tools/terminal';
import { HealingRawOutcome, ToolContext } from '../types';
import { removeTemp } from './removeTemp';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await wait(50);
  }
}

const optsOf = (run: CommandRun) => (run as unknown as { o: CommandRunOptions }).o;

suite('Self-healing command runs (timeouts, no detach)', () => {
  let dir: string;
  let prevDir: string;

  setup(() => {
    prevDir = commandLogDir();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-heal-cmd-'));
    setCommandLogDir(dir);
  });
  teardown(() => {
    setCommandLogDir(prevDir);
    removeTemp(dir);
  });

  test('timedOut is set only by the hard timeout', async () => {
    let run: CommandRun | undefined;
    run = new CommandRun({ id: 'h-timeout', sessionId: 'h', command: 'sleep', kill: () => run!.finish(null), timeoutMs: 50 });
    const o = await run.result;
    assert.strictEqual(o.timedOut, true);
    assert.match(o.output, /timed out after/);

    const ac = new AbortController();
    const cancelled: CommandRun = new CommandRun({ id: 'h-cancel', sessionId: 'h', command: 'sleep', kill: () => cancelled.finish(null), timeoutMs: 5000, signal: ac.signal });
    ac.abort();
    const c = await cancelled.result;
    assert.strictEqual(c.timedOut, undefined);
    assert.match(c.output, /\[cancelled\]/);

    const stopped: CommandRun = new CommandRun({ id: 'h-stop', sessionId: 'h', command: 'sleep', kill: () => stopped.finish(null), timeoutMs: 5000 });
    stopped.stop();
    const s = await stopped.result;
    assert.strictEqual(s.timedOut, undefined);
  });

  test('a noDetach run is stopped, not detached, by any detach request', async () => {
    let killed = 0;
    const run = new CommandRun({ id: 'h-nodetach', sessionId: 'h-nd', command: 'tsc', kill: () => killed++, noDetach: true });
    run.push('checking\n');
    assert.strictEqual(detachWaiting('h-nd'), 0, 'Ctrl+B skips it');
    assert.strictEqual(killed, 0);
    assert.strictEqual(detachCommand('h-nodetach'), false);
    assert.strictEqual(killed, 1, 'the process tree is killed');
    run.finish(null);
    const o = await run.result;
    assert.ok(!o.detached, JSON.stringify(o));
    assert.match(o.output, /checking[\s\S]*cannot run in the background/);
    assert.strictEqual(run.logPath, undefined, 'no log file');
    assert.strictEqual(runningCommands('h-nd').length, 0);
  });

  test('run_command with healingExec never detaches, reports the raw outcome and keeps the model cap', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    this.timeout(40_000);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prevIntegrated = cfg.inspect<boolean>('terminal.runInIntegratedTerminal')?.globalValue;
    const prevDetach = cfg.inspect<number>('terminal.autoDetachSeconds')?.globalValue;
    await cfg.update('terminal.runInIntegratedTerminal', false, vscode.ConfigurationTarget.Global);
    await cfg.update('terminal.autoDetachSeconds', 1, vscode.ConfigurationTarget.Global);
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-heal-ws-')));
    const seen: CommandRun[] = [];
    const unsubscribe = onCommandRunChange((r) => {
      if (!seen.includes(r)) {
        seen.push(r);
      }
    });
    try {
      const base: Omit<ToolContext, 'callId'> = { sessionId: 'heal-test', workspaceRoot: ws, signal: new AbortController().signal, depth: 0, progress: () => undefined, trackChange: async () => undefined, requestApproval: async () => true };
      const raw: HealingRawOutcome[] = [];
      // 100k characters, more than the default capture keeps, then hang past the 2 s healing timeout.
      const script = `process.stdout.write('x'.repeat(100000) + 'END\\n'); setTimeout(() => {}, 5000)`;
      const healingExec = { origin: 'healing' as const, noAutoDetach: true as const, timeoutSeconds: 2, checkSpecMatch: false, rawOutcome: (o: HealingRawOutcome) => raw.push(o) };
      const r = await runCommandTool.execute({ command: `"${process.execPath}" -e "${script}"` }, { ...base, callId: 'heal-1', healingExec });
      assert.strictEqual(raw.length, 1);
      assert.strictEqual(raw[0].timedOut, true, JSON.stringify({ ...raw[0], output: raw[0].output.slice(-200) }));
      assert.ok(!raw[0].detached, 'never detached by the auto-detach timer');
      assert.ok(raw[0].output.includes('x'.repeat(100000) + 'END'), 'raw outcome carries the full output');
      assert.ok('exitCode' in raw[0]);
      assert.doesNotMatch(r.content, /Command is still running/);
      assert.strictEqual(optsOf(seen.find((s) => s.id === 'heal-1')!).timeoutMs, 2000);

      // A throwing collector must not break the tool.
      const thrown = await runCommandTool.execute({ command: 'echo ok' }, { ...base, callId: 'heal-2', healingExec: { ...healingExec, rawOutcome: () => { throw new Error('boom'); } } });
      assert.ok(!thrown.isError, thrown.content);
      assert.match(thrown.content, /ok\n\[exit code 0\]/);

      // Healing raises the cap to 3600 s; a model call keeps 600 s.
      const big = runCommandTool.execute({ command: 'sleep 30' }, { ...base, callId: 'heal-3', healingExec: { ...healingExec, timeoutSeconds: 5000 } });
      await until(() => seen.some((s) => s.id === 'heal-3'));
      assert.strictEqual(optsOf(seen.find((s) => s.id === 'heal-3')!).timeoutMs, 3_600_000);
      assert.strictEqual(optsOf(seen.find((s) => s.id === 'heal-3')!).detachAfterMs, 0);
      stopCommand('heal-3');
      await big;
      const model = runCommandTool.execute({ command: 'sleep 30', timeout_seconds: 5000 }, { ...base, callId: 'model-1' });
      await until(() => seen.some((s) => s.id === 'model-1'));
      const modelRun = seen.find((s) => s.id === 'model-1')!;
      assert.strictEqual(optsOf(modelRun).timeoutMs, 600_000);
      assert.ok(!optsOf(modelRun).noDetach);
      stopCommand('model-1');
      await model;
    } finally {
      unsubscribe();
      stopCommand('heal-3');
      stopCommand('model-1');
      await cfg.update('terminal.runInIntegratedTerminal', prevIntegrated, vscode.ConfigurationTarget.Global);
      await cfg.update('terminal.autoDetachSeconds', prevDetach, vscode.ConfigurationTarget.Global);
      removeTemp(ws);
    }
  });
});
