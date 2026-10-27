import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfig } from '../config';
import { Tool } from '../types';
import { displayPath, resolveWorkspacePath } from './fs';

/** Runner that executes in a visible, branded VS Code terminal (set by the extension; absent in the CLI). */
export interface IntegratedTerminalRunner {
  run(sessionId: string, command: string, cwd: string, signal: AbortSignal, timeoutMs: number, reveal: boolean): Promise<{ output: string; exitCode: number | undefined } | undefined>;
}
let integrated: IntegratedTerminalRunner | undefined;
export function setIntegratedTerminalRunner(r: IntegratedTerminalRunner | undefined): void {
  integrated = r;
}

const DANGEROUS = /\b(rm\s+-rf\s+[\/~]|sudo\b|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|git\s+push\s+--force|git\s+reset\s+--hard|chmod\s+-R\s+777)/i;

export const runCommandTool: Tool = {
  approvalKind: 'terminal',
  definition: {
    name: 'run_command',
    description:
      'Run a shell command in the workspace root and return its stdout/stderr. Use for builds, tests, git, package managers. Long-running servers should be started with background=true.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command line' },
        cwd: { type: 'string', description: 'Working directory relative to workspace (optional)' },
        timeout_seconds: { type: 'integer', description: 'Default 120' },
        background: { type: 'boolean', description: 'Start in an integrated terminal and do not wait (for servers/watchers)' },
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
      // Isolated worktree: map the real checkout onto the copy and never run outside it.
      try {
        cwd = resolveWorkspacePath(cwd, ctx).fsPath;
      } catch {
        return { content: `cwd must be inside the isolated workspace (${root}): ${cwd}`, isError: true };
      }
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { content: `cwd does not exist or is not a directory: ${cwd}. Omit cwd to run in the workspace root (${root}).`, isError: true };
    }
    const dangerous = DANGEROUS.test(command);
    const ok = await ctx.requestApproval(
      dangerous ? 'Potentially destructive command' : 'Run command',
      `$ ${command}\nin ${displayPath(vscode.Uri.file(cwd), ctx) || cwd}`,
      'terminal'
    );
    if (!ok) {
      return { content: 'User declined to run the command.', isError: true };
    }

    if (args.background) {
      const term = vscode.window.createTerminal({ name: `LocalPilot: ${command.slice(0, 30)}`, cwd });
      term.show(true);
      term.sendText(command);
      return { content: `Started in background terminal "${term.name}". Output is not captured; ask the user to check the terminal if needed.` };
    }

    const timeoutMs = Math.min(600, Number(args.timeout_seconds ?? 120)) * 1000;
    const termCfg = getConfig().terminal;
    if (integrated && termCfg.runInIntegratedTerminal) {
      // Visible, branded terminal via shell integration; the user sees the command run live.
      const r = await integrated.run(ctx.sessionId, command, cwd, ctx.signal, timeoutMs, termCfg.reveal).catch(() => undefined);
      if (r) {
        const cleaned = r.output.trim();
        return { content: `$ ${command}\n${cleaned || '(no output)'}\n[exit code ${r.exitCode ?? 'null'}]`, isError: r.exitCode !== 0, data: { exitCode: r.exitCode ?? null, terminal: true } };
      }
    }
    const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/zsh';
    return new Promise((resolve) => {
      const child = cp.spawn(shell, process.platform === 'win32' ? ['/c', command] : ['-lc', command], {
        cwd,
        env: { ...process.env, CI: '1', GIT_PAGER: 'cat', PAGER: 'cat', FORCE_COLOR: '0', NO_COLOR: '1' },
        // Own process group so a timeout/stop can take down everything the command started, not just the shell.
        detached: process.platform !== 'win32',
      });
      let out = '';
      const cap = 200_000;
      const push = (d: Buffer) => {
        if (out.length < cap) {
          out += d.toString();
        }
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      const timer = setTimeout(() => {
        killTree(child);
        out += `\n[timed out after ${timeoutMs / 1000}s]`;
      }, timeoutMs);
      const onAbort = () => killTree(child);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({ content: `Failed to start: ${e.message}`, isError: true });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const cleaned = stripAnsi(out).trim();
        resolve({
          content: `$ ${command}\n${cleaned || '(no output)'}\n[exit code ${code ?? 'null'}]`,
          isError: code !== 0,
          data: { exitCode: code },
        });
      });
    });
  },
};

/** Removes CSI colour/cursor codes and OSC sequences (titles, hyperlinks, shell-integration 633/133 markers). */
/** Kill the shell and every process it started (servers, watchers, test runners). */
function killTree(child: cp.ChildProcess): void {
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

export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[=>NOM78]/g, '');
}

export const terminalTools: Tool[] = [runCommandTool];
