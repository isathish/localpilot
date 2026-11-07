// SESSION in the terminal: `localpilot recovery runs [<id>]` lists agent runs that did not finish (a crash, a closed
// terminal) with what ran and the files they changed; `localpilot history show --runs <id>` lists a conversation's runs.
import * as vscode from 'vscode';
import type { Continuity } from '../continuity/continuity';
import type { AgentSessionRow, ExecutionEventRow } from '../continuity/session/crashRecovery';
import type { SessionManager } from '../continuity/session/sessionManager';
import { openCliContinuity } from './continuityCmd';
import type { Style } from './providers';

export const RECOVERY_RUNS_USAGE = 'localpilot recovery runs [<conversation id>] [--json]   runs a crash or a closed terminal cut off, with what ran';

const STATUS_MARK: Record<string, string> = { ok: '✔', error: '✖', denied: '⊘', cancelled: '◼', running: '…' };

function when(t: number): string {
  return t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

/** One line per step of a run ("What ran"). */
export function eventLines(events: ExecutionEventRow[], st: Style, more = 0): string[] {
  const out: string[] = [];
  if (more) {
    out.push(st.dim(`      … ${more} earlier step${more === 1 ? '' : 's'}`));
  }
  for (const e of events) {
    const mark = e.status ? (STATUS_MARK[e.status] ?? '·') : '·';
    const color = e.status === 'error' ? st.red : e.status === 'running' ? st.amber : (s: string) => s;
    const tail = e.error ?? e.detail;
    out.push(`      ${color(mark)} ${e.kind === 'tool' ? e.name : st.dim(e.name)}${tail ? st.dim(` · ${tail.replace(/\s+/g, ' ').slice(0, 100)}`) : ''}${e.status === 'running' ? st.amber(' (was running)') : ''}`);
  }
  return out;
}

/** A run's heading line. */
export function runLine(r: AgentSessionRow, st: Style): string {
  const outcome = r.outcome === 'interrupted' ? st.amber('interrupted') : r.outcome === 'error' ? st.red('error') : r.outcome === 'running' ? st.amber('running') : st.dim(r.outcome);
  const tokens = (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
  return `  ${outcome} ${st.bold(r.title ?? `run ${r.run}`)} ${st.dim(`· ${when(r.startedAt)}${r.model ? ` · ${r.model}` : ''}${tokens ? ` · ${tokens.toLocaleString('en-US')} tokens` : ''}${r.recovery ? ` · self-healing ${r.recovery.phase}` : ''} · ${r.id}`)}`;
}

/** Prints runs with their steps and files; JSON when asked. */
export async function printRuns(mgr: SessionManager, runs: AgentSessionRow[], st: Style, o: { json?: boolean; limit?: number; out?: NodeJS.WritableStream } = {}): Promise<void> {
  const out = o.out ?? process.stdout;
  const say = (t: string) => out.write(`${t}\n`);
  if (o.json) {
    const rows = [];
    for (const r of runs) {
      rows.push({ ...r, events: await mgr.events(r.id) });
    }
    say(JSON.stringify(rows, null, 2));
    return;
  }
  for (const r of runs) {
    say(runLine(r, st));
    const ev = await mgr.events(r.id);
    const limit = o.limit ?? 12;
    eventLines(ev.slice(-limit), st, Math.max(0, ev.length - limit)).forEach(say);
    if (r.filesTouched.length) {
      say(st.dim(`      changed: ${r.filesTouched.slice(0, 8).join(', ')}${r.filesTouched.length > 8 ? `, +${r.filesTouched.length - 8} more` : ''}`));
    }
  }
}

/** `localpilot recovery runs [<id>] [--json]`. Returns the exit code. */
export async function cmdRecoveryRuns(argv: string[], st: Style, o: { cwd: string; dataDir?: string; version?: string; log: vscode.LogOutputChannel }): Promise<number> {
  const json = argv.includes('--json');
  const ref = argv.find((a) => !a.startsWith('-'));
  const c: Continuity = await openCliContinuity({ cwd: o.cwd, dataDir: o.dataDir, log: o.log, schedules: false, autoMigrate: false, version: o.version });
  try {
    if (c.degraded) {
      console.error(st.red(`conversation storage is off: ${c.degraded}`));
      return 1;
    }
    await c.ready;
    if (c.indexFailed) {
      console.error(st.red(`the conversation index could not start: ${c.indexFailed}`));
      return 1;
    }
    const mgr = c.attachSessions()!;
    let runs = await mgr.interrupted();
    if (ref) {
      const ids = await c.index.query<string>('conversationIds', {});
      const hits = ids.filter((id) => id === ref || id.startsWith(ref));
      if (hits.length !== 1) {
        console.error(st.red(hits.length ? `"${ref}" matches ${hits.length} conversations` : `no conversation "${ref}" (localpilot history --all-projects lists them)`));
        return 2;
      }
      runs = runs.filter((r) => r.conversationId === hits[0]);
    }
    if (!runs.length && !json) {
      console.log(st.dim(ref ? 'No interrupted runs in that conversation.' : 'No interrupted runs. Runs a crash or a closed terminal cut off are listed here with what ran.'));
      return 0;
    }
    if (!json) {
      const titles = new Map<string, string>();
      for (const r of runs) {
        if (!titles.has(r.conversationId)) {
          titles.set(r.conversationId, (await c.index.conversation(r.conversationId).catch(() => undefined))?.title ?? r.conversationId);
        }
      }
      for (const [conv, title] of titles) {
        console.log(`${st.bold(title)} ${st.dim(conv)}`);
        await printRuns(mgr, runs.filter((r) => r.conversationId === conv), st);
      }
      console.log(st.dim('localpilot -r <id> reopens the chat; there the Run interrupted card (VS Code) or "continue" picks the task up.'));
      return 0;
    }
    await printRuns(mgr, runs, st, { json: true });
    return 0;
  } finally {
    await c.dispose();
  }
}
