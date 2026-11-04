import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfig } from '../config';
import { checkReadOnlyCommand, isReadOnlyOrSafe } from '../agent/commandGuard';
import { profileInvocation } from '../terminal/profiles';
import { agentTerminalProfile } from '../terminal/profileSetting';
import { CommandRun, formatCommandOutcome, OutputCapture } from '../terminal/commandRun';
import { IntegratedRunOptions, IntegratedRunResult } from '../terminal/terminalManager';
import { Tool } from '../types';
import { displayPath, resolveWorkspacePath } from './fs';

/** Runner that executes in a visible, branded VS Code terminal (set by the extension; absent in the CLI). */
export interface IntegratedTerminalRunner {
  run(sessionId: string, command: string, cwd: string, signal: AbortSignal, timeoutMs: number, reveal: boolean, opts?: IntegratedRunOptions): Promise<IntegratedRunResult | undefined>;
  release?(sessionId: string): void;
}
let integrated: IntegratedTerminalRunner | undefined;
export function setIntegratedTerminalRunner(r: IntegratedTerminalRunner | undefined): void {
  integrated = r;
}
/** Close the agent terminal a chat or subagent ran its commands in. */
export function releaseIntegratedTerminal(sessionId: string): void {
  integrated?.release?.(sessionId);
}

/** How long a `background: true` command is watched (startup errors, the port it listens on) before it is detached. */
const BACKGROUND_GRACE_MS = 3000;

const DANGEROUS = /\b(rm\s+-rf\s+[\/~]|sudo\b|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|git\s+push\s+--force|git\s+reset\s+--hard|chmod\s+-R\s+777)/i;

export const runCommandTool: Tool = {
  approvalKind: 'terminal',
  definition: {
    name: 'run_command',
    description:
      'Run a shell command in the workspace root and return its stdout/stderr. Use for builds, tests, git, package managers. Long-running servers should be started with background=true. A command that keeps running past the detach timer (or that the user lets proceed) returns its output so far and keeps running; its later output is appended to a log file you can read with read_file.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command line' },
        cwd: { type: 'string', description: 'Working directory relative to workspace (optional)' },
        timeout_seconds: { type: 'integer', description: 'Default 120' },
        background: { type: 'boolean', description: 'Start it, return its first few seconds of output and do not wait (for servers/watchers); later output goes to a log file' },
        requires_approval: { type: 'boolean', description: 'Set true for an impactful command (installs, deletes, deploys, pushes, system changes) so the user confirms it even when commands are auto-approved' },
      },
      required: ['command'],
    },
  },
  async execute(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) {
      return { content: 'command is required', isError: true };
    }
    const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    // Models often pass the workspace root itself (absolute) as cwd; joining that onto root gave a nonexistent path.
    let cwd = typeof args.cwd === 'string' && args.cwd.trim() ? path.resolve(root, args.cwd.trim()) : root;
    if (ctx.workspaceRoot && cwd !== root) {
      // Isolated worktree: the real checkout maps onto the copy; either way never run outside the workspace.
      try {
        cwd = resolveWorkspacePath(cwd, ctx).fsPath;
      } catch {
        return { content: `cwd must be inside the ${ctx.isolatedFrom ? 'isolated ' : ''}workspace (${root}): ${cwd}`, isError: true };
      }
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { content: `cwd does not exist or is not a directory: ${cwd}. Omit cwd to run in the workspace root (${root}).`, isError: true };
    }
    if (ctx.readOnly) {
      // Plan/Ask: read-only commands only, refused before any approval card is shown.
      const guard = checkReadOnlyCommand(command);
      if (!guard.ok) {
        return { content: `${ctx.mode === 'ask' ? 'Ask' : 'Plan'} mode: ${guard.reason}. Only read-only commands run in ${ctx.mode === 'ask' ? 'Ask' : 'Plan'} mode.`, isError: true };
      }
    }
    const dangerous = DANGEROUS.test(command);
    const confirm = args.requires_approval === true || args.requires_approval === 'true';
    const ok = await ctx.requestApproval(
      dangerous ? 'Potentially destructive command' : 'Run command',
      `$ ${command}\nin ${displayPath(vscode.Uri.file(cwd), ctx) || cwd}`,
      'terminal',
      { dangerous, confirm, safeCommand: !dangerous && !confirm && isReadOnlyOrSafe(command).ok }
    );
    if (!ok) {
      return { content: 'User declined to run the command.', isError: true };
    }
    if (ctx.signal.aborted) {
      return { content: 'Not run: the user stopped the run.', isError: true };
    }

    const termCfg = getConfig().terminal;
    const explicit = Number(args.timeout_seconds) > 0;
    const timeoutMs = Math.min(600, explicit ? Number(args.timeout_seconds) : 120) * 1000;
    // Background commands detach after a short look at their startup output; others after the auto-detach timer
    // (sooner when the model asked for a shorter timeout). With the timer off the old hard kill at the timeout applies.
    const auto = Math.max(0, termCfg.autoDetachSeconds) * 1000;
    const detachAfterMs = args.background ? BACKGROUND_GRACE_MS : auto ? (explicit ? Math.min(auto, timeoutMs) : auto) : 0;
    const id = ctx.callId ?? `cmd-${Date.now().toString(36)}`;
    const onOutput = ctx.output;
    if (integrated && termCfg.runInIntegratedTerminal) {
      // Visible, branded terminal via shell integration; the user sees the command run live.
      const r = await integrated.run(ctx.sessionId, command, cwd, ctx.signal, timeoutMs, termCfg.reveal, { id, onOutput, detachAfterMs }).catch(() => undefined);
      if (r) {
        const res = formatCommandOutcome(command, r);
        return { ...res, data: { ...res.data, terminal: true } };
      }
    }
    const profile = agentTerminalProfile();
    const sh = profileInvocation(command, profile, { login: true });
    const child = cp.spawn(sh.file, sh.args, {
      cwd,
      windowsVerbatimArguments: sh.windowsVerbatimArguments,
      env: { ...process.env, ...profileEnv(profile?.env), CI: '1', GIT_PAGER: 'cat', PAGER: 'cat', FORCE_COLOR: '0', NO_COLOR: '1' },
      // Own process group so a timeout/stop can take down everything the command started, not just the shell.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const run = new CommandRun({ id, sessionId: ctx.sessionId, command, kill: () => killTree(child), onOutput, detachAfterMs, timeoutMs, signal: ctx.signal, capture: new OutputCapture(50_000, 150_000) });
    const push = (d: string) => run.push(d);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => run.fail(e.message));
    child.on('close', (code) => run.finish(code));
    return formatCommandOutcome(command, await run.result);
  },
};

/** A profile's env for a child process: null entries unset the variable, so they become undefined. */
function profileEnv(env: Record<string, string | null> | undefined): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, v ?? undefined]));
}

/** Kill the shell and every process it started (servers, watchers, test runners). */
export function killTree(child: cp.ChildProcess): void {
  // No exitCode check: the shell may be gone while a backgrounded child still holds the output pipes.
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'));
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

export { stripAnsi } from '../terminal/commandRun';

export const terminalTools: Tool[] = [runCommandTool];
