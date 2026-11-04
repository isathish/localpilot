import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandLog, CommandRun, commandLogDir, detachCommand, formatCommandOutcome, pruneCommandLogs, runningCommands, setCommandLogDir, stopCommand } from '../terminal/commandRun';
import { runCommandTool } from '../tools/terminal';
import { ToolContext } from '../types';

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

suite('Proceed While Running (detached commands)', () => {
  let dir: string;
  let prevDir: string;

  setup(() => {
    prevDir = commandLogDir();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cmdlogs-'));
    setCommandLogDir(dir);
  });
  teardown(() => {
    setCommandLogDir(prevDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a finished command answers with its full output and exit code', async () => {
    const chunks: string[] = [];
    const run = new CommandRun({ id: 'c-finish', sessionId: 's', command: 'build', kill: () => undefined, onOutput: (c) => chunks.push(c) });
    run.push('\u001b[32mok\u001b[0m\r\n');
    run.finish(0);
    const o = await run.result;
    assert.strictEqual(o.output, 'ok\n');
    assert.strictEqual(o.exitCode, 0);
    assert.deepStrictEqual(chunks, ['ok\n'], 'live output is streamed without ANSI codes');
    assert.strictEqual(runningCommands('s').length, 0);
  });

  test('detach returns the partial output and later output grows the log', async () => {
    let killed = 0;
    const run = new CommandRun({ id: 'c-detach', sessionId: 's', command: 'npm run dev', kill: () => killed++ });
    run.push('starting\n');
    assert.ok(detachCommand('c-detach'));
    const o = await run.result;
    assert.strictEqual(o.output, 'starting\n');
    assert.ok(o.detached && o.detached.logPath.startsWith(dir), JSON.stringify(o));
    const text = formatCommandOutcome('npm run dev', o).content;
    assert.match(text, /Command is still running\. Further output goes to .*; read it with read_file\./);
    run.push('listening on 3000\n');
    const log = fs.readFileSync(o.detached!.logPath, 'utf8');
    assert.ok(log.includes('starting') && log.includes('listening on 3000'), log);
    run.finish(0);
    assert.match(fs.readFileSync(o.detached!.logPath, 'utf8'), /\[exit code 0\]\s*$/);
    assert.strictEqual(killed, 0, 'detaching never kills');
  });

  test('stop kills a detached command', async () => {
    let killed = 0;
    const run = new CommandRun({ id: 'c-stop', sessionId: 's', command: 'watch', kill: () => killed++ });
    run.detach();
    await run.result;
    assert.ok(stopCommand('c-stop'));
    assert.strictEqual(killed, 1);
    run.finish(null);
    assert.strictEqual(run.state, 'done');
    assert.ok(fs.readFileSync(run.logPath!, 'utf8').includes('[stopped by the user]'));
  });

  test('the timeout kills only when no detach timer is set', async () => {
    let killed = 0;
    const run = new CommandRun({ id: 'c-timeout', sessionId: 's', command: 'sleep', kill: () => killed++, timeoutMs: 50 });
    await until(() => killed === 1);
    run.finish(null);
    const o = await run.result;
    assert.match(o.output, /timed out after/);
    const auto = new CommandRun({ id: 'c-auto', sessionId: 's', command: 'sleep', kill: () => killed++, timeoutMs: 50, detachAfterMs: 120 });
    const a = await auto.result;
    assert.ok(a.detached, 'detached by the timer');
    assert.strictEqual(killed, 1, 'the hard timeout is off while the detach timer runs');
    auto.stop();
  });

  test('the log is capped with a truncation note', () => {
    const file = path.join(dir, 'cap.log');
    const log = new CommandLog(file, 10);
    log.write('0123456789abcdef');
    log.write('more');
    log.close('\n[exit code 0]\n');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith('0123456789\n[log truncated'), text);
    assert.ok(!text.includes('more') && text.endsWith('[exit code 0]\n'), text);
  });

  test('day-old logs are pruned', () => {
    const old = path.join(dir, 'old.log');
    const fresh = path.join(dir, 'fresh.log');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'y');
    const past = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, past, past);
    assert.strictEqual(pruneCommandLogs(dir), 1);
    assert.ok(!fs.existsSync(old) && fs.existsSync(fresh));
  });

  test('run_command auto-detaches a long command after the configured seconds and stop kills it', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    this.timeout(30_000);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prevIntegrated = cfg.inspect<boolean>('terminal.runInIntegratedTerminal')?.globalValue;
    const prevDetach = cfg.inspect<number>('terminal.autoDetachSeconds')?.globalValue;
    await cfg.update('terminal.runInIntegratedTerminal', false, vscode.ConfigurationTarget.Global);
    await cfg.update('terminal.autoDetachSeconds', 2, vscode.ConfigurationTarget.Global);
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-detach-')));
    try {
      const live: string[] = [];
      const ctx: ToolContext = { sessionId: 'detach-test', workspaceRoot: ws, signal: new AbortController().signal, depth: 0, progress: () => undefined, trackChange: async () => undefined, requestApproval: async () => true, callId: 'call-auto', output: (c) => live.push(c) };
      const script = `let n = 0; setInterval(() => console.log('tick ' + n++), 200);`;
      const started = Date.now();
      const r = await runCommandTool.execute({ command: `"${process.execPath}" -e "${script}"` }, ctx);
      assert.ok(Date.now() - started < 10_000, 'the agent was not held until the timeout');
      assert.ok(!r.isError, r.content);
      assert.match(r.content, /Command is still running/);
      const logPath = (r.data as { logPath: string }).logPath;
      assert.ok(live.join('').includes('tick 0'), 'output streamed live');
      const size = fs.statSync(logPath).size;
      await until(() => fs.statSync(logPath).size > size);
      assert.ok(stopCommand('call-auto'));
      await until(() => runningCommands('detach-test').length === 0);
      const after = fs.statSync(logPath).size;
      await wait(600);
      assert.strictEqual(fs.statSync(logPath).size, after, 'no output after Stop');
    } finally {
      await cfg.update('terminal.runInIntegratedTerminal', prevIntegrated, vscode.ConfigurationTarget.Global);
      await cfg.update('terminal.autoDetachSeconds', prevDetach, vscode.ConfigurationTarget.Global);
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
