import * as vscode from 'vscode';
import { stripAnsi } from '../tools/terminal';

/** One shell command observed in any VS Code terminal (via shell integration). */
export interface TerminalExecutionRecord {
  terminal: vscode.Terminal;
  terminalName: string;
  command: string;
  cwd?: string;
  output: string;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
}

export interface IntegratedRunResult {
  output: string;
  exitCode: number | undefined;
}

const MAX_OUTPUT = 64_000;
const MAX_RECORDS = 30;
const BANNER = '\x1b[38;5;214m◆\x1b[0m \x1b[1mLocalPilot\x1b[0m terminal — type \x1b[36mlocalpilot "your task"\x1b[0m or \x1b[36mlocalpilot --help\x1b[0m';

/**
 * Everything LocalPilot does with VS Code terminals:
 *  - runs agent commands in a branded "LocalPilot Agent" terminal through shell integration, streaming
 *    the output back to the agent while the user watches it live (falls back to a child process when
 *    the shell has no integration);
 *  - records the commands the *user* runs in any terminal so `@terminal` and the terminal context-menu
 *    actions can hand the last command + output to the model;
 *  - opens the branded LocalPilot terminal with the `localpilot` CLI on PATH.
 */
export class TerminalManager implements vscode.Disposable {
  private readonly records: TerminalExecutionRecord[] = [];
  private readonly byExecution = new Map<vscode.TerminalShellExecution, TerminalExecutionRecord>();
  private readonly agentTerminals = new Map<string, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidRecord = new vscode.EventEmitter<TerminalExecutionRecord>();
  readonly onDidRecord = this._onDidRecord.event;
  /** Extra env for terminals we open (puts the `localpilot` shim on PATH). */
  cliEnv: Record<string, string> = {};

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((e) => this.onStart(e)),
      vscode.window.onDidEndTerminalShellExecution((e) => this.onEnd(e)),
      vscode.window.onDidCloseTerminal((t) => {
        for (const [sid, term] of this.agentTerminals) {
          if (term === t) {
            this.agentTerminals.delete(sid);
          }
        }
      })
    );
  }

  // ------------------------------------------------------------------ observation
  private onStart(e: vscode.TerminalShellExecutionStartEvent): void {
    const rec: TerminalExecutionRecord = {
      terminal: e.terminal,
      terminalName: e.terminal.name,
      command: e.execution.commandLine.value,
      cwd: e.execution.cwd?.fsPath,
      output: '',
      startedAt: Date.now(),
    };
    this.byExecution.set(e.execution, rec);
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) {
      this.records.shift();
    }
    void this.pump(e.execution, rec);
  }

  private async pump(exec: vscode.TerminalShellExecution, rec: TerminalExecutionRecord): Promise<void> {
    try {
      for await (const chunk of exec.read()) {
        if (rec.output.length < MAX_OUTPUT) {
          rec.output += chunk;
        }
      }
    } catch (err) {
      this.log.debug(`terminal read ended: ${String(err)}`);
    }
  }

  private onEnd(e: vscode.TerminalShellExecutionEndEvent): void {
    const rec = this.byExecution.get(e.execution);
    if (!rec) {
      return;
    }
    rec.exitCode = e.exitCode;
    rec.endedAt = Date.now();
    rec.output = stripAnsi(rec.output).replace(/\r\n?/g, '\n');
    this.byExecution.delete(e.execution);
    this._onDidRecord.fire(rec);
  }

  /** Most recent finished command in `terminal` (default: the active terminal, then any terminal). */
  lastExecution(terminal?: vscode.Terminal): TerminalExecutionRecord | undefined {
    const t = terminal ?? vscode.window.activeTerminal;
    const finished = this.records.filter((r) => r.endedAt !== undefined).reverse();
    return finished.find((r) => !t || r.terminal === t) ?? finished[0];
  }

  /** Last failed command across terminals — what "Fix with LocalPilot" should look at. */
  lastFailure(): TerminalExecutionRecord | undefined {
    return [...this.records].reverse().find((r) => r.endedAt !== undefined && r.exitCode !== undefined && r.exitCode !== 0);
  }

  get recordCount(): number {
    return this.records.length;
  }

  /** Prompt-ready block for a recorded command. */
  format(rec: TerminalExecutionRecord | undefined, maxChars = 12_000): string {
    if (!rec) {
      return '<terminal_output>No terminal command has been captured yet. Run a command in a VS Code terminal with shell integration, then try again.</terminal_output>';
    }
    let out = rec.output.trim();
    if (out.length > maxChars) {
      out = `${out.slice(0, maxChars / 2)}\n…[${out.length - maxChars} chars omitted]…\n${out.slice(-maxChars / 2)}`;
    }
    return `<terminal_output terminal="${rec.terminalName}"${rec.cwd ? ` cwd="${vscode.workspace.asRelativePath(rec.cwd) || rec.cwd}"` : ''} exit_code="${rec.exitCode ?? '?'}">\n$ ${rec.command}\n${out || '(no output)'}\n</terminal_output>`;
  }

  // ------------------------------------------------------------------ branded terminals
  private brand(): { iconPath: vscode.Uri; color: vscode.ThemeColor } {
    return { iconPath: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg'), color: new vscode.ThemeColor('terminal.ansiYellow') };
  }

  /** The user-facing LocalPilot terminal: branded, with the `localpilot` CLI available on PATH. */
  openCliTerminal(cwd?: string): vscode.Terminal {
    const term = vscode.window.createTerminal({ name: 'LocalPilot', cwd, env: this.cliEnv, ...this.brand(), message: BANNER });
    term.show();
    return term;
  }

  /** Options for the contributed "LocalPilot" terminal profile (same terminal, created by VS Code's "+" menu). */
  profileOptions(): vscode.TerminalOptions {
    return { name: 'LocalPilot', env: this.cliEnv, ...this.brand(), message: BANNER };
  }

  private agentTerminal(sessionId: string, cwd: string): vscode.Terminal {
    const existing = this.agentTerminals.get(sessionId);
    if (existing && existing.exitStatus === undefined) {
      return existing;
    }
    const term = vscode.window.createTerminal({ name: 'LocalPilot Agent', cwd, ...this.brand(), isTransient: true });
    this.agentTerminals.set(sessionId, term);
    return term;
  }

  private async waitForShellIntegration(term: vscode.Terminal, timeoutMs: number): Promise<vscode.TerminalShellIntegration | undefined> {
    if (term.shellIntegration) {
      return term.shellIntegration;
    }
    return new Promise((resolve) => {
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === term) {
          clearTimeout(timer);
          sub.dispose();
          resolve(e.shellIntegration);
        }
      });
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(undefined);
      }, timeoutMs);
    });
  }

  /**
   * Run `command` in the session's LocalPilot Agent terminal. Resolves with captured output and exit code,
   * or `undefined` when shell integration is unavailable so the caller can fall back to a child process.
   */
  async run(sessionId: string, command: string, cwd: string, signal: AbortSignal, timeoutMs: number, reveal: boolean): Promise<IntegratedRunResult | undefined> {
    const term = this.agentTerminal(sessionId, cwd);
    if (reveal) {
      term.show(true);
    }
    const si = await this.waitForShellIntegration(term, 4000);
    if (!si) {
      this.log.info('terminal: shell integration not available, falling back to child process');
      return undefined;
    }
    const inCwd = si.cwd?.fsPath === cwd ? command : `cd ${quote(cwd)} && ${command}`;
    const exec = si.executeCommand(inCwd);
    let output = '';
    let exitCode: number | undefined;
    const done = new Promise<'done'>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === exec) {
          exitCode = e.exitCode;
          sub.dispose();
          resolve('done');
        }
      });
    });
    const reader = (async () => {
      for await (const chunk of exec.read()) {
        if (output.length < MAX_OUTPUT) {
          output += chunk;
        }
      }
    })();
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
    const aborted = new Promise<'aborted'>((r) => signal.addEventListener('abort', () => r('aborted'), { once: true }));
    const result = await Promise.race([done, timeout, aborted]);
    if (result !== 'done') {
      term.sendText('\u0003', false); // Ctrl+C the running command
      output += `\n[${result === 'timeout' ? `timed out after ${timeoutMs / 1000}s` : 'cancelled'}]`;
    }
    await Promise.race([reader, new Promise((r) => setTimeout(r, 500))]);
    return { output: stripAnsi(output).replace(/\r\n?/g, '\n'), exitCode };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidRecord.dispose();
  }
}

function quote(p: string): string {
  return process.platform === 'win32' ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}
