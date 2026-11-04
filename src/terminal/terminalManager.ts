import * as path from 'path';
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
    const cap = new OutputCapture(MAX_OUTPUT / 4, (MAX_OUTPUT * 3) / 4);
    try {
      for await (const chunk of exec.read()) {
        cap.push(chunk);
        rec.output = cap.text();
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
    // Nobody answers prompts in the agent terminal: pagers print straight through and editors exit at once.
    const env = { CI: '1', GIT_PAGER: 'cat', PAGER: 'cat', GH_PAGER: 'cat', MANPAGER: 'cat', AWS_PAGER: '', GIT_EDITOR: 'true', VISUAL: 'true', EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_TERMINAL_PROMPT: '0' };
    const term = vscode.window.createTerminal({ name: 'LocalPilot Agent', cwd, env, ...this.brand(), isTransient: true });
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
    if (signal.aborted) {
      return { output: 'Not run: the user stopped the run.', exitCode: undefined };
    }
    const term = this.agentTerminal(sessionId, cwd);
    if (reveal) {
      term.show(true);
    }
    const si = await this.waitForShellIntegration(term, 4000);
    if (!si) {
      this.log.info('terminal: shell integration not available, falling back to child process');
      return undefined;
    }
    if (signal.aborted) {
      return { output: 'Not run: the user stopped the run.', exitCode: undefined };
    }
    // Always cd: a reused shell may sit in a directory (or a removed worktree) other than the one it reports.
    const exec = si.executeCommand(inDir(cwd, command, (term.state as { shell?: string }).shell ?? vscode.env.shell));
    const cap = new OutputCapture();
    let exitCode: number | undefined;
    let sub: vscode.Disposable | undefined;
    const done = new Promise<'done'>((resolve) => {
      sub = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === exec) {
          exitCode = e.exitCode;
          resolve('done');
        }
      });
    });
    const reader = (async () => {
      for await (const chunk of exec.read()) {
        cap.push(chunk);
      }
    })();
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
    const aborted = new Promise<'aborted'>((r) => signal.addEventListener('abort', () => r('aborted'), { once: true }));
    const result = await Promise.race([done, timeout, aborted]);
    sub?.dispose();
    if (result !== 'done') {
      term.sendText('\u0003', false); // Ctrl+C the running command
    }
    await Promise.race([reader, new Promise((r) => setTimeout(r, 500))]);
    let output = cap.text();
    if (result !== 'done') {
      output += `\n[${result === 'timeout' ? `timed out after ${timeoutMs / 1000}s` : 'cancelled'}]`;
    }
    if (result !== 'done') {
      // ^C may not reach a pager or prompt that grabbed the TTY: never hand a possibly stuck shell to the next command.
      term.dispose();
      if (this.agentTerminals.get(sessionId) === term) {
        this.agentTerminals.delete(sessionId);
      }
    }
    return { output: stripAnsi(output).replace(/\r\n?/g, '\n'), exitCode };
  }

  /** Close the agent terminal of a chat or subagent that is finished (or whose worktree is going away). */
  release(sessionId: string): void {
    this.agentTerminals.get(sessionId)?.dispose();
    this.agentTerminals.delete(sessionId);
  }

  dispose(): void {
    this.agentTerminals.forEach((t) => t.dispose());
    this.agentTerminals.clear();
    this.disposables.forEach((d) => d.dispose());
    this._onDidRecord.dispose();
  }
}

/** Keeps the start and a rolling end of long output: failures and summaries are reported last. */
export class OutputCapture {
  private head = '';
  private tail = '';
  private dropped = 0;

  constructor(private readonly headMax = 16_000, private readonly tailMax = 48_000) {}

  push(chunk: string): void {
    if (this.head.length < this.headMax) {
      const take = chunk.slice(0, this.headMax - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    this.tail += chunk;
    if (this.tail.length > this.tailMax) {
      this.dropped += this.tail.length - this.tailMax;
      this.tail = this.tail.slice(-this.tailMax);
    }
  }

  text(): string {
    return this.dropped ? `${this.head}\n…[${this.dropped} characters of output omitted]…\n${this.tail}` : this.head + this.tail;
  }
}

/** Whether two directories are the same; on Windows case and separators do not matter. */
export function samePath(a: string | undefined, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (a === undefined) {
    return false;
  }
  if (platform === 'win32') {
    return path.win32.relative(a, b) === '';
  }
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  return trim(a) === trim(b);
}

/** `command` run in `cwd`, in the syntax of the terminal's shell (PowerShell 5.1 has no `&&`). */
export function inDir(cwd: string, command: string, shell: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const name = shell ? path.win32.basename(shell) : '';
    if (!shell || /^(pwsh|powershell)(\.exe)?$/i.test(name)) {
      return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; if ($?) { ${command} }`;
    }
    if (/^cmd(\.exe)?$/i.test(name)) {
      return `cd /d "${cwd}" && ${command}`;
    }
  }
  return `cd '${cwd.replace(/'/g, `'\\''`)}' && ${command}`;
}
