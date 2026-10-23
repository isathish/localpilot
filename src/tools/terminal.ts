import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import { Tool } from '../types';

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
    const cwd = typeof args.cwd === 'string' && args.cwd ? vscode.Uri.joinPath(vscode.Uri.file(root), args.cwd).fsPath : root;
    const dangerous = DANGEROUS.test(command);
    const ok = await ctx.requestApproval(
      dangerous ? 'Potentially destructive command' : 'Run command',
      `$ ${command}\nin ${vscode.workspace.asRelativePath(cwd) || cwd}`,
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
    const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/zsh';
    return new Promise((resolve) => {
      const child = cp.spawn(shell, process.platform === 'win32' ? ['/c', command] : ['-lc', command], {
        cwd,
        env: { ...process.env, CI: '1', GIT_PAGER: 'cat', PAGER: 'cat', FORCE_COLOR: '0', NO_COLOR: '1' },
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
        child.kill('SIGKILL');
        out += `\n[timed out after ${timeoutMs / 1000}s]`;
      }, timeoutMs);
      ctx.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ content: `Failed to start: ${e.message}`, isError: true });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
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

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export const terminalTools: Tool[] = [runCommandTool];
