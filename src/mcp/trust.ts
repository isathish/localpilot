import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeJsonAtomic } from './config';

/**
 * Project `.mcp.json` servers run commands from the repository, so each one needs the user's yes before it starts.
 * A yes is remembered per server and configuration (`mcpTrustKey`): changing a server's command asks again.
 */
export interface McpTrust {
  isTrusted(key: string): boolean;
  /** Asks whether to start these servers; resolves true to start them (and remembers that). */
  ask(names: string[], file: string, keys: string[]): Promise<boolean>;
  /** Wait for the answer before starting servers (the CLI) instead of asking in the background (VS Code). */
  blocking?: boolean;
}

const STATE_KEY = 'localpilot.mcpTrusted';

function question(names: string[], file: string): string {
  return `This workspace defines MCP server${names.length > 1 ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')} in ${path.basename(file)}. They run commands from the repository. Start them?`;
}

/** VS Code: trusted keys live in the workspace state; the question is a notification with "Open file". */
export function workspaceMcpTrust(state: vscode.Memento): McpTrust {
  const trusted = () => new Set(state.get<string[]>(STATE_KEY, []));
  return {
    isTrusted: (key) => trusted().has(key),
    async ask(names, file, keys) {
      for (;;) {
        const pick = await vscode.window.showWarningMessage(`LocalPilot: ${question(names, file)}`, 'Start', 'Open file', 'Not now');
        if (pick === 'Open file') {
          await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
          continue;
        }
        if (pick !== 'Start') {
          return false;
        }
        await state.update(STATE_KEY, [...new Set([...trusted(), ...keys])]);
        return true;
      }
    },
  };
}

export interface CliMcpTrustOptions {
  /** Reads one answer from the terminal (the shim's `ask` under its prompt lock); never the auto-approving picker. */
  prompt: (question: string) => Promise<string | undefined>;
  /** Whether there is a terminal to ask in; defaults to stdin being a TTY. */
  interactive?: () => boolean;
  file?: string;
}

/**
 * The CLI: trusted keys per workspace folder in ~/.localpilot/mcp-trust.json; `--trust-workspace` trusts everything.
 * Only a typed yes starts servers: `-y` does not answer this question, and with no terminal they stay stopped.
 */
export function cliMcpTrust(workspace: string, trustAll: () => boolean, opts: CliMcpTrustOptions): McpTrust {
  const file = opts.file ?? path.join(os.homedir(), '.localpilot', 'mcp-trust.json');
  const interactive = opts.interactive ?? (() => !!process.stdin.isTTY);
  const read = (): Record<string, string[]> => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string[]>) : {};
    } catch {
      return {};
    }
  };
  const ws = path.resolve(workspace);
  return {
    blocking: true,
    isTrusted: (key) => trustAll() || (Array.isArray(read()[ws]) && read()[ws].includes(key)),
    async ask(names, mcpFile, keys) {
      const answer = interactive() ? await opts.prompt(`${question(names, mcpFile)} [y/N] `) : undefined;
      if (!/^\s*y(es)?\s*$/i.test(answer ?? '')) {
        process.stderr.write(`MCP servers from ${mcpFile} were not started (pass --trust-workspace to start them without asking).\n`);
        return false;
      }
      const all = read();
      all[ws] = [...new Set([...(Array.isArray(all[ws]) ? all[ws] : []), ...keys])];
      await writeJsonAtomic(file, all).catch(() => undefined);
      return true;
    },
  };
}

/** VS Code: an invalid server file shows its field errors with a button that opens it. */
export function showMcpFileProblems(file: string, problems: string[]): void {
  const shown = problems.slice(0, 3).join('; ') + (problems.length > 3 ? ` (and ${problems.length - 3} more)` : '');
  void vscode.window.showErrorMessage(`LocalPilot: invalid MCP configuration in ${file}: ${shown}`, 'Open file').then((pick) => {
    if (pick === 'Open file') {
      void vscode.window.showTextDocument(vscode.Uri.file(file));
    }
  });
}
