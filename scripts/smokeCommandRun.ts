/**
 * Smoke checks (bundled into scripts/smoke.ts) for Proceed While Running: detaching a command, its log, the cap,
 * auto-detach, stop and log pruning.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandLog, CommandRun, commandLogDir, formatCommandOutcome, pruneCommandLogs, runningCommands, setCommandLogDir, stopCommand } from '../src/terminal/commandRun';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export async function commandRuns(check: Check): Promise<void> {
  console.log('\n[proceed while running]');
  const prev = commandLogDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-smoke-cmdlogs-'));
  setCommandLogDir(dir);
  try {
    const live: string[] = [];
    const done = new CommandRun({ id: 'smoke-1', sessionId: 's', command: 'echo', kill: () => undefined, onOutput: (c) => live.push(c) });
    done.push('\u001b[1mhi\u001b[0m\r\n');
    done.finish(0);
    const o1 = await done.result;
    check('finished command: full output, exit code, live chunk without ANSI', o1.output === 'hi\n' && o1.exitCode === 0 && live.join('') === 'hi\n', { o1, live });
    check('finished command formats like before', formatCommandOutcome('echo', o1).content === '$ echo\nhi\n[exit code 0]');

    let killed = 0;
    const run = new CommandRun({ id: 'smoke-2', sessionId: 's', command: 'serve', kill: () => killed++, detachAfterMs: 30, timeoutMs: 10 });
    run.push('booting\n');
    const o2 = await run.result;
    check('auto-detach answers with the partial output and a log path', !!o2.detached && o2.output === 'booting\n' && killed === 0, o2);
    run.push('ready\n');
    const log = o2.detached ? fs.readFileSync(o2.detached.logPath, 'utf8') : '';
    check('later output is appended to the log', log.includes('booting') && log.includes('ready'), log);
    check('detached result tells the agent to read the log', /still running\. Further output goes to .+; read it with read_file/.test(formatCommandOutcome('serve', o2).content));
    stopCommand('smoke-2');
    run.finish(null);
    check('stop kills a detached command and ends it', killed === 1 && run.state === 'done' && runningCommands('s').length === 0, { killed, state: run.state });

    const capFile = path.join(dir, 'cap.log');
    const capped = new CommandLog(capFile, 4);
    capped.write('abcdefgh');
    capped.close('\n[exit code 1]\n');
    const capText = fs.readFileSync(capFile, 'utf8');
    check('log cap keeps the head, notes the truncation and the exit code', capText.startsWith('abcd\n[log truncated') && capText.endsWith('[exit code 1]\n'), capText);

    const old = path.join(dir, 'old.log');
    fs.writeFileSync(old, '');
    const past = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, past, past);
    check('logs older than a day are pruned, newer ones kept', pruneCommandLogs(dir) === 1 && !fs.existsSync(old) && fs.existsSync(capFile));
  } finally {
    setCommandLogDir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
