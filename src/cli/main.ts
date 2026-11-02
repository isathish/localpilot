/**
 * `localpilot` — the LocalPilot coding agent in your terminal.
 *
 * Runs the exact same agent loop, tools, skills, memory, MCP servers and change tracking as the
 * VS Code extension, against the model servers you already configured (Ollama, LM Studio,
 * llama.cpp, vLLM…). Settings are read from VS Code's user settings.json, the workspace's
 * .vscode/settings.json and ~/.localpilot/config.json. Code goes only to the providers you configure: local servers
 * keep it on your machine; cloud providers (`localpilot providers add openai`) receive what you send to their models.
 */
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode'; // → src/cli/vscodeShim.ts (aliased by the CLI build)
import { AgentRunner } from '../agent/agentLoop';
import { RunControl } from '../agent/runControl';
import { WorktreeInfo, WorktreeManager } from '../agent/worktrees';
import { ChangeTracker } from '../agent/changeTracker';
import { createGatherContextTool } from '../agent/clarify';
import { SkillLearner } from '../agent/skillRecommender';
import { createMemoryTools, manageTodosTool, MemoryStore } from '../agent/memory';
import { gitTools } from '../tools/git';
import { repoGraphTool } from '../tools/repoGraph';
import { SkillManager } from '../agent/skills';
import { createAgentTools } from '../agent/subagents';
import { loadProjectSettings, ProjectSettings } from '../agent/settings';
import { HookRunner } from '../agent/hooks';
import { discoverPlugins, PluginInfo, pluginSource } from '../agent/plugins';
import { CustomCommand, discoverCommands, expandCommand, indexCommands } from '../agent/commands';
import { describeSource, installSkills, parseSkillSource, skillsDestination } from '../agent/skillInstaller';
import { SkillCatalog } from '../agent/skillCatalog';
import { getConfig } from '../config';
import { WorkspaceContext } from '../context/workspaceContext';
import { McpManager } from '../mcp/mcpManager';
import { ProviderRegistry } from '../providers/registry';
import { editorTools } from '../tools/editor';
import { fsTools } from '../tools/fs';
import { createAnalyzeWorkspaceTool } from '../tools/workspace';
import { ToolRegistry } from '../tools/registry';
import { runProcess, searchTools } from '../tools/search';
import { terminalTools } from '../tools/terminal';
import { webTools } from '../tools/web';
import { defaultTelemetryDir, Telemetry } from '../telemetry/telemetry';
import { RedisTelemetry } from '../storage/redisTelemetry';
import { AgentEvent, ALL_MODES, ChatMessage, ModelInfo, Session, TodoItem, UserAnswer, UserQuestion } from '../types';
import { addProvider, listPresets, listProviders, ProviderFlags, removeProvider, setProviderKey, Style, testProviders } from './providers';
import { setSecretValues } from '../providers/cloud';
import { ask, CLI_KEYS_PATH, CLI_SETTINGS_PATH, cliOverrides, readCliKeys, isAutoApprove, LOG_FILE, setAutoApprove, setLogLevel, setReadline, setWorkspaceRoot, USER_SETTINGS_PATH } from './vscodeShim';
import { describePolicy, getManagedPolicy, managedPolicyPath } from '../agent/managedPolicy';
import { EvalRun, formatReport, loadSuite, previousRun, projectSuites, runTask, saveRun, summarize } from '../eval/runner';
import { LEASE_MS, TeamBoard } from '../agent/teamBoard';
import { boardOwner, teamBoardTool } from '../tools/teamBoard';
import { reposTool } from '../tools/repos';
import { securityScanTool } from '../tools/security';
import { formatFindings, scanWorkspace, SEVERITY_ORDER, toSarif } from '../security/scan';

declare const __LOCALPILOT_VERSION__: string | undefined;
const VERSION = typeof __LOCALPILOT_VERSION__ === 'string' ? __LOCALPILOT_VERSION__ : '0.0.0';

// ------------------------------------------------------------------ styling
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const amber = c('38;5;214');
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const cyan = c('36');
const yellow = c('33');
const BRAND = `${amber('◆')} ${bold('LocalPilot')}`;

/** Light markdown → ANSI so streamed answers stay readable in a terminal. */
function md(s: string): string {
  if (!tty) {
    return s;
  }
  return s
    .replace(/^(#{1,6})\s+(.*)$/gm, (_, _h, t) => bold(amber(t)))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => bold(t))
    .replace(/`([^`\n]+)`/g, (_, t) => cyan(t))
    .replace(/^(\s*)[-*]\s+/gm, (_, sp) => `${sp}${amber('•')} `);
}

const STYLE: Style = { bold, dim, red, green, yellow, amber, cyan };

const HELP = `${BRAND} ${dim(`v${VERSION}`)} — local-first coding agent for your terminal

${bold('Usage')}
  localpilot [options] "task"            run one task in agent mode and exit
  localpilot                              interactive session (REPL)
  localpilot models                       list models from your providers (cloud ones are marked)
  localpilot doctor                       check servers, settings and tools
  localpilot scan [folder]               security scan: vulnerable dependencies (OSV.dev), secrets, risky code [--fail-on high] [--sarif out.sarif] [--json out.json] [--offline]
  localpilot work [--once] [--max N]      take tasks from the shared board (.localpilot/board) until none is left
  localpilot eval [--models a,b]         benchmark models on real coding tasks [--suite file.json] [--tasks id,…] [--keep] [--json out.json]
  localpilot providers                    local and cloud providers: reachability, models, key state
  localpilot providers presets            providers you can add (Ollama, LM Studio… OpenAI, Claude, Gemini, OpenRouter…)
  localpilot providers add <preset|url>   add one [--id <id>] [--key <key> | --key-env VAR] [--url <url>] [--cloud]
  localpilot providers key <id> [key]     set its API key (prompted if omitted, or piped in) [--key-env VAR] [--remove-key]
  localpilot providers test [id]          check a provider and list its models
  localpilot providers remove <id>        remove a provider added here (disables a VS Code one for the CLI)
  localpilot skill install <source>       install a skill (owner/repo[/path], github URL, SKILL.md URL or folder) [--user]
  localpilot skill search <words>         find skills in the catalog repositories (localpilot.skills.repositories); add --install for the best match
  localpilot --ide [options] "task"       open the task in VS Code instead

${bold('Options')}
  --ask | --plan | --agent     mode (default: agent); --multitask coordinates background workers, --debug fixes bugs
  -i, --isolate                work in an isolated git worktree (your checkout is untouched); the result is applied
                               back as uncommitted changes when the run ends — --no-apply keeps it in the worktree
  -m, --model <provider/model> model for this run (e.g. ollama/gemma4:e4b)
  -f, --file <path>            attach a file (repeatable; path#L10-L20 for a range)
  -y, --yes                    approve every command / edit / network call (CI, scripts)
  -C, --cwd <dir>              workspace root (default: current directory)
  -p, --print                  print the final answer only (no tool log; implies non-interactive)
  --no-mcp                     do not start MCP servers
  -v, --verbose                show tool arguments and debug logs
  --settings | --setup         open LocalPilot Settings / the setup wizard in VS Code
  -h, --help · --version

${bold('In a session')}
  /mode agent|multitask|debug|plan|ask   /model <name>   /models   /providers   /undo   /keep   /changes   /clear   /help   /exit
  /isolate   work in a git worktree from now on   /apply   bring its changes into your checkout   /discard   throw them away
  /commands  custom slash commands (.claude/commands, .localpilot/commands, plugins)   /permissions   /hooks   settings.json rules
  Ctrl+C stops the current run; press it again to quit. Ctrl+Z pauses after the current step (again to resume);
  anything you type while a run is going is handed to the agent at its next step.

${bold('Settings')} read from ${dim(USER_SETTINGS_PATH)}, ./.vscode/settings.json and ${dim(CLI_SETTINGS_PATH)}.
${bold('API keys')} \${env:NAME} works everywhere. Keys VS Code keeps in your OS keychain (\${secret:id}) are read here from
${dim(CLI_KEYS_PATH)} (set with \`localpilot providers key <id>\`) or LOCALPILOT_KEY_<ID>.
Log: ${dim(LOG_FILE)}`;

// ------------------------------------------------------------------ args
interface Args {
  prompt: string;
  mode: Session['mode'];
  model?: string;
  files: string[];
  yes: boolean;
  cwd: string;
  print: boolean;
  mcp: boolean;
  verbose: boolean;
  cmd?: 'models' | 'doctor' | 'ide' | 'settings' | 'setup' | 'help' | 'version' | 'skill-install' | 'skill-search' | 'providers' | 'eval' | 'work' | 'scan';
  /** `scan`: exit 1 at or above this severity; SARIF/JSON outputs; skip the online dependency check. */
  scanOpts: { failOn: 'low' | 'medium' | 'high' | 'critical' | 'none'; sarif?: string; json?: string; offline: boolean };
  /** `work`: stop after one task; give up waiting after this many seconds with nothing claimable. */
  workOpts: { once: boolean; max?: number };
  /** `eval`: models to compare, suite file, task ids, keep workspaces. */
  evalOpts: { models: string[]; suite?: string; tasks: string[]; keep: boolean; json?: string };
  /** `providers add|key|remove|test|presets` options. */
  provider: ProviderFlags;
  /** `skill install`: write into ~/.localpilot/skills instead of the workspace. */
  user: boolean;
  /** `skill search --install`: install the best match. */
  install: boolean;
  /** Work in an isolated git worktree; one-shot runs apply the result automatically unless --no-apply. */
  isolate: boolean;
  apply: boolean;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { prompt: '', mode: 'agent', files: [], yes: false, cwd: process.cwd(), print: false, mcp: true, verbose: false, user: false, install: false, isolate: false, apply: true, provider: {}, evalOpts: { models: [], tasks: [], keep: false }, workOpts: { once: false }, scanOpts: { failOn: 'high', offline: false } };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i] ?? '';
    if (x === '--ask') {a.mode = 'ask';}
    else if (x === '--plan') {a.mode = 'plan';}
    else if (x === '--multitask') {a.mode = 'multitask';}
    else if (x === '--debug') {a.mode = 'debug';}
    else if (x === '--isolate' || x === '-i') {a.isolate = true;}
    else if (x === '--no-apply') {a.apply = false;}
    else if (x === '--agent') {a.mode = 'agent';}
    else if (x === '-m' || x === '--model') {a.model = next();}
    else if (x.startsWith('--model=')) {a.model = x.slice(8);}
    else if (x === '-f' || x === '--file') {a.files.push(next());}
    else if (x === '-y' || x === '--yes') {a.yes = true;}
    else if (x === '-C' || x === '--cwd') {a.cwd = path.resolve(next());}
    else if (x === '-p' || x === '--print') {a.print = true;}
    else if (x === '--no-mcp') {a.mcp = false;}
    else if (x === '-v' || x === '--verbose') {a.verbose = true;}
    else if (x === '--ide' || x === '--vscode') {a.cmd = 'ide';}
    else if (x === '--settings') {a.cmd = 'settings';}
    else if (x === '--setup') {a.cmd = 'setup';}
    else if (x === '-h' || x === '--help') {a.cmd = 'help';}
    else if (x === '--version' || x === '-V') {a.cmd = 'version';}
    else if (x === '--parallel' || x === '-P') {a.cmd = a.cmd ?? 'ide';} // parallel sessions live in the editor's Agents panel
    else if (x === '--user' || x === '-u') {a.user = true;}
    else if (x === '--install') {a.install = true;}
    else if (x === '--key') {a.provider.key = next();}
    else if (x === '--key-env') {a.provider.keyEnv = next();}
    else if (x === '--remove-key') {a.provider.removeKey = true;}
    else if (x === '--url') {a.provider.url = next();}
    else if (x === '--id') {a.provider.id = next();}
    else if (x === '--type') {a.provider.type = next();}
    else if (x === '--name') {a.provider.name = next();}
    else if (x === '--cloud') {a.provider.cloud = true;}
    else if (x === '--no-cloud') {a.provider.cloud = false;}
    else if (x === 'eval' && !words.length && !a.cmd) {a.cmd = 'eval';}
    else if (x === 'work' && !words.length && !a.cmd) {a.cmd = 'work';}
    else if (x === 'scan' && !words.length && !a.cmd) {a.cmd = 'scan';}
    else if (x === '--fail-on') {const v = next(); a.scanOpts.failOn = (['low', 'medium', 'high', 'critical', 'none'].includes(v) ? v : 'high') as Args['scanOpts']['failOn'];}
    else if (x === '--sarif') {a.scanOpts.sarif = next();}
    else if (x === '--offline') {a.scanOpts.offline = true;}
    else if (x === '--once') {a.workOpts.once = true;}
    else if (x === '--max') {a.workOpts.max = Math.max(1, Number(next()) || 1);}
    else if (x === '--models') {a.evalOpts.models.push(...next().split(',').map((m) => m.trim()).filter(Boolean));}
    else if (x === '--suite') {a.evalOpts.suite = next();}
    else if (x === '--tasks') {a.evalOpts.tasks.push(...next().split(',').map((t) => t.trim()).filter(Boolean));}
    else if (x === '--keep') {a.evalOpts.keep = true;}
    else if (x === '--json') {a.evalOpts.json = next(); a.scanOpts.json = a.evalOpts.json;}
    else if (x === 'providers' && !words.length && !a.cmd) {a.cmd = 'providers';}
    else if (x === 'skill' && !words.length && !a.cmd && ['search', 'find'].includes(argv[i + 1] ?? '')) {a.cmd = 'skill-search'; i++;}
    else if (x === 'skill' && !words.length && !a.cmd && ['install', 'add'].includes(argv[i + 1] ?? '')) {a.cmd = 'skill-install'; i++;}
    else if (!x.startsWith('-') && !words.length && !a.cmd && ['models', 'doctor', 'help', 'version'].includes(x)) {a.cmd = x as Args['cmd'];}
    else {words.push(x);}
  }
  a.prompt = words.join(' ').trim();
  return a;
}

// ------------------------------------------------------------------ VS Code hand-off (previous CLI behaviour)
function openInVsCode(pathname: string, params: Record<string, string>, cwd: string): never {
  const cp = require('child_process') as typeof import('child_process');
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `vscode://localpilot.localpilot-agent/${pathname}${q ? `?${q}` : ''}`;
  const code = process.env.LOCALPILOT_CODE_BIN || 'code';
  const r = cp.spawnSync(code, ['--open-url', url, cwd], { stdio: 'inherit' });
  if (r.error) {
    console.error(red(`Could not launch VS Code (${code}): ${r.error.message}. Set LOCALPILOT_CODE_BIN to your 'code' binary.`));
    process.exit(1);
  }
  process.exit(r.status ?? 0);
}

// ------------------------------------------------------------------ stream filter
const MARKERS = ['```', '<tool_call>', '<tool_response>'];
/** Holds back fenced / tagged tool-protocol blocks while they stream and drops them once complete, so the terminal shows prose only. */
class StreamFilter {
  private buf = '';
  push(delta: string): string {
    this.buf += delta;
    return this.drain(false);
  }
  flush(): string {
    return this.drain(true);
  }
  private drain(final: boolean): string {
    let out = '';
    while (this.buf) {
      let i = -1;
      let marker = '';
      for (const m of MARKERS) {
        const k = this.buf.indexOf(m);
        if (k >= 0 && (i < 0 || k < i)) {
          i = k;
          marker = m;
        }
      }
      // Bare JSON tool calls on their own line: hold the line until it ends, then drop it if it is a call.
      const bare = /(^|\n)[ \t]*\{/.exec(this.buf);
      if (bare && (i < 0 || bare.index + bare[1].length < i)) {
        const start = bare.index + bare[1].length;
        const nl = this.buf.indexOf('\n', start);
        if (nl < 0 && !final) {
          out += this.buf.slice(0, start);
          this.buf = this.buf.slice(start);
          break;
        }
        const lineEnd = nl < 0 ? this.buf.length : nl;
        const line = this.buf.slice(start, lineEnd);
        out += this.buf.slice(0, start) + (StreamFilter.isToolCall(line) ? '' : line);
        this.buf = this.buf.slice(lineEnd);
        if (StreamFilter.isToolCall(line) && this.buf.startsWith('\n') && (out.endsWith('\n') || !out)) {
          this.buf = this.buf.slice(1); // avoid leaving a blank line where the call was
        }
        continue;
      }
      if (i < 0) {
        const hold = final ? 0 : this.partialSuffix();
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
      out += this.buf.slice(0, i);
      this.buf = this.buf.slice(i);
      const close = marker === '```' ? '```' : marker.replace('<', '</');
      const end = this.buf.indexOf(close, marker.length);
      if (end < 0) {
        if (final) {
          // Unterminated block at the end of the turn: a fence is probably real code, tags are protocol junk.
          out += marker === '```' ? this.buf : '';
          this.buf = '';
        }
        break;
      }
      const block = this.buf.slice(0, end + close.length);
      this.buf = this.buf.slice(end + close.length);
      out += marker === '```' && !StreamFilter.isToolCall(block) ? block : '';
    }
    return out;
  }
  private partialSuffix(): number {
    for (let n = Math.min(this.buf.length, 15); n > 0; n--) {
      const tail = this.buf.slice(-n);
      if (MARKERS.some((m) => m.startsWith(tail))) {
        return n;
      }
    }
    return 0;
  }
  static isToolCall(fenced: string): boolean {
    const body = fenced.replace(/^```[\w-]*\s*/, '').replace(/```$/, '').trim();
    return body.startsWith('{') && /"name"\s*:/.test(body) && /"(arguments|parameters|args)"\s*:/.test(body);
  }
}

// ------------------------------------------------------------------ renderer
class Renderer {
  private filter = new StreamFilter();
  private line = '';
  private running = new Map<string, { label: string; start: number }>();
  thinking = 0;
  constructor(private readonly verbose: boolean, private readonly quiet: boolean) {}

  private breakLine(): void {
    if (this.line && !this.line.endsWith('\n')) {
      process.stdout.write('\n');
    }
    this.line = '';
  }
  private pending = '';
  text(raw: string): void {
    const delta = this.filter.push(raw);
    if (!delta || this.quiet) {
      return; // quiet (--print / piped) mode prints the final answer once at the end
    }
    this.clearStatus();
    // Render markdown per complete line so inline markup split across stream deltas still formats.
    this.pending += delta;
    const nl = this.pending.lastIndexOf('\n');
    if (nl >= 0) {
      process.stdout.write(md(this.pending.slice(0, nl + 1)));
      this.pending = this.pending.slice(nl + 1);
      this.line = '';
    }
    if (this.pending.length > 400) {
      process.stdout.write(this.pending); // very long line: show progress without waiting for a newline
      this.line += this.pending;
      this.pending = '';
    }
  }
  private flushPending(): void {
    if (this.pending) {
      process.stdout.write(md(this.pending));
      this.line += this.pending;
      this.pending = '';
    }
  }
  private statusShown = false;
  private statusText = '';
  private spinTimer: NodeJS.Timeout | undefined;
  private spinFrame = 0;
  private static readonly FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  /** Animated brand spinner + status line; redrawn on a timer so it keeps moving while the model thinks. */
  status(s: string): void {
    if (this.quiet || !tty) {
      return;
    }
    if (this.line && !this.statusShown) {
      process.stdout.write('\n'); // keep partially streamed prose intact
      this.line = '';
    }
    this.statusText = s;
    this.statusShown = true;
    this.drawStatus();
    if (!this.spinTimer && !process.env.LOCALPILOT_NO_SPINNER) {
      this.spinTimer = setInterval(() => this.drawStatus(), 90);
      this.spinTimer.unref();
    }
  }
  private drawStatus(): void {
    const frame = amber(Renderer.FRAMES[this.spinFrame++ % Renderer.FRAMES.length]);
    const width = Math.max(20, (process.stdout.columns || 100) - 4);
    process.stdout.write(`\r\x1b[2K${frame} ${dim(this.statusText.slice(0, width))}`);
  }
  clearStatus(): void {
    if (this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = undefined;
    }
    if (tty && this.statusShown) {
      process.stdout.write('\r\x1b[2K');
      this.statusShown = false;
    }
  }
  toolStart(id: string, name: string, args: Record<string, unknown>): void {
    if (this.quiet) {
      return;
    }
    this.clearStatus();
    this.flushPending();
    this.breakLine();
    const label = toolLabel(name, args);
    this.running.set(id, { label, start: Date.now() });
    process.stdout.write(`  ${dim('⟳')} ${dim(label)}${this.verbose ? ` ${dim(JSON.stringify(args).slice(0, 200))}` : ''}\n`);
  }
  toolEnd(id: string, name: string, isError: boolean, content: string, data: unknown, cached?: boolean): void {
    if (this.quiet) {
      return;
    }
    const r = this.running.get(id);
    this.running.delete(id);
    const dur = r ? Date.now() - r.start : 0;
    const meta = cached ? dim(' cached') : dur > 800 ? dim(` ${(dur / 1000).toFixed(1)}s`) : '';
    if (tty && r) {
      process.stdout.write('\x1b[1A\x1b[2K'); // rewrite the ⟳ line in place
    }
    process.stdout.write(`  ${isError ? red('✗') : green('✓')} ${r?.label ?? name}${meta}\n`);
    const d = data as { exitCode?: number } | undefined;
    if (name === 'run_command' && content) {
      const body = content.replace(/^\$ .*\n/, '').replace(/\n\[exit code [^\]]*\]$/, '');
      const lines = body.split('\n');
      const shown = lines.length > 30 ? [...lines.slice(0, 12), dim(`… ${lines.length - 24} lines …`), ...lines.slice(-12)] : lines;
      process.stdout.write(shown.map((l) => `    ${dim('│')} ${isError ? l : dim(l)}`).join('\n') + '\n');
      if (typeof d?.exitCode === 'number' && d.exitCode !== 0) {
        process.stdout.write(`    ${red(`exit ${d.exitCode}`)}\n`);
      }
    } else if (isError || this.verbose) {
      process.stdout.write(`    ${dim('│')} ${(isError ? red : dim)(content.split('\n').slice(0, 6).join('\n    │ ').slice(0, 1200))}\n`);
    }
  }
  todos(items: TodoItem[]): void {
    if (this.quiet || !items.length) {
      return;
    }
    this.clearStatus();
    this.flushPending();
    this.breakLine();
    const done = items.filter((t) => t.status === 'done').length;
    process.stdout.write(`  ${amber('☰')} ${bold(`Plan ${done}/${items.length}`)}\n${items.map((t) => `    ${t.status === 'done' ? green('✓') : t.status === 'in_progress' ? amber('▸') : t.status === 'skipped' ? dim('–') : dim('○')} ${t.status === 'done' ? dim(t.title) : t.title}`).join('\n')}\n`);
  }
  note(s: string): void {
    if (this.quiet) {
      // --print / piped: stdout must carry the answer only, so advisory notes go to stderr.
      process.stderr.write(`  ${dim(s)}\n`);
      return;
    }
    this.clearStatus();
    this.flushPending();
    this.breakLine();
    process.stdout.write(`  ${dim(s)}\n`);
  }
  error(s: string): void {
    this.clearStatus();
    this.flushPending();
    this.breakLine();
    process.stdout.write(`${red('✖')} ${s}\n`);
  }
  end(): void {
    const rest = this.filter.flush();
    if (rest && !this.quiet) {
      this.pending += rest;
    }
    this.clearStatus();
    this.flushPending();
    this.breakLine();
  }
}

function toolLabel(name: string, a: Record<string, unknown>): string {
  const s = (v: unknown, n = 70) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  switch (name) {
    case 'read_file': return `Read ${s(a.path)}${a.start_line ? ` (lines ${a.start_line}–${a.end_line ?? ''})` : ''}`;
    case 'edit_file': return `Edit ${s(a.path)}`;
    case 'write_file': return `Write ${s(a.path)}`;
    case 'list_dir': return `List ${s(a.path || '.')}`;
    case 'create_directory': return `Create folder ${s(a.path)}`;
    case 'delete_path': return `Delete ${s(a.path)}`;
    case 'grep_search': return `Search "${s(a.query)}"`;
    case 'file_search': return `Find files ${s(a.pattern)}`;
    case 'find_symbol': return `Look up ${s(a.query)}`;
    case 'find_references': return `References to ${s(a.symbol)}`;
    case 'repo_graph': return `Import graph: ${s(a.action)}${a.path ? ` ${s(a.path)}` : ''}`;
    case 'security_scan': return `Security scan${Array.isArray(a.kinds) && a.kinds.length ? `: ${s(a.kinds.join(', '))}` : ''}${a.path ? ` in ${s(a.path)}` : ''}`;
    case 'repos': return `Repos: ${s(a.action)}${a.command ? ` $ ${s(a.command, 60)}` : a.query ? ` "${s(a.query, 40)}"` : ''}${Array.isArray(a.repos) && a.repos.length ? ` in ${s(a.repos.join(', '), 40)}` : ''}`;
    case 'team_board': return `Board: ${s(a.action)}${a.id ? ` ${s(a.id)}` : ''}${a.title ? ` "${s(a.title, 60)}"` : ''}`;
    case 'git_status': return `Git ${s(a.action || 'status')}${a.path ? ` ${s(a.path)}` : ''}`;
    case 'git_commit': return `Commit${a.branch ? ` on ${s(a.branch)}` : ''}: ${s(String(a.message ?? '').split('\n')[0], 70)}`;
    case 'git_push': return 'Push branch';
    case 'pull_request': return `Pull request: ${s(a.action)}${a.number ? ` #${s(a.number)}` : ''}${a.title ? ` "${s(a.title, 60)}"` : ''}`;
    case 'ci_status': return `CI ${s(a.action)}${a.run_id ? ` ${s(a.run_id)}` : ''}`;
    case 'run_command': return `$ ${s(a.command, 100)}`;
    case 'get_diagnostics': return 'Check diagnostics';
    case 'web_search': return `Web search "${s(a.query)}"`;
    case 'web_fetch': return `Fetch ${s(a.url)}`;
    case 'run_subagent': return `Subagent ${s(a.agent)}: ${s(a.prompt, 60)}`;
    case 'run_parallel_subagents': return `${(a.tasks as unknown[] | undefined)?.length ?? 0} subagents in parallel`;
    case 'load_skill': return `Load skill ${s(a.name)}`;
    case 'manage_todos': return 'Update plan';
    case 'memory_save': return `Remember ${s(a.name)}`;
    case 'memory_read': return `Recall ${s(a.name)}`;
    default: return `${name} ${s(a, 60)}`;
  }
}

// ------------------------------------------------------------------ core
interface Core {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  skills: SkillManager;
  workspace: WorkspaceContext;
  tracker: ChangeTracker;
  memory: MemoryStore;
  runner: AgentRunner;
  catalog: SkillCatalog;
  mcp?: McpManager;
  log: vscode.LogOutputChannel;
  /** Live sessions, so gather_context can see the working set and recent turns. */
  sessions: Map<string, Session>;
  telemetry: Telemetry;
  /** Optional Redis store behind `telemetry`; its socket must be closed for the process to exit. */
  telemetryRemote?: RedisTelemetry;
  /** Merged settings.json (permission rules, hooks) for the working folder. */
  settings: ProjectSettings;
  plugins: PluginInfo[];
  /** Custom slash commands (.claude/commands, .localpilot/commands, plugins), by `/name`. */
  commands: CustomCommand[];
}

async function boot(args: Args, emit: (e: AgentEvent) => void, approve: (sid: string, title: string, detail: string, kind: string) => Promise<boolean>): Promise<Core> {
  const log = vscode.window.createOutputChannel('LocalPilot CLI', { log: true });
  const providers = new ProviderRegistry(log);
  const tools = new ToolRegistry();
  const skills = new SkillManager(log, path.join(__dirname, '..', 'skills'));
  const workspace = new WorkspaceContext(log);
  const tracker = new ChangeTracker(log);
  const memory = new MemoryStore(vscode.Uri.file(path.join(os.homedir(), '.localpilot', 'memory')), log, () => getConfig().memoryLimits);
  const learner = new SkillLearner(path.join(os.homedir(), '.localpilot', 'skill-learning.json'), log);
  const catalog = new SkillCatalog({ cacheFile: process.env.LOCALPILOT_SKILL_CATALOG || path.join(os.homedir(), '.localpilot', 'skill-catalog.json'), repositories: () => getConfig().skillRepositories, log });
  const runner = new AgentRunner(providers, tools, skills, workspace, log, tracker, memory, learner, catalog);
  // Same local store as the extension, so CLI runs show up on the dashboard (events only; the CLI has its own log file).
  // With `storage.redis.enabled` in the user's settings they go to the same Redis.
  const redisCfg = getConfig().storage.redis;
  let redis: RedisTelemetry | undefined;
  try {
    redis = redisCfg.enabled ? new RedisTelemetry(redisCfg.url) : undefined;
  } catch (e) {
    log.warn(`telemetry: invalid localpilot.storage.redis.url (${e instanceof Error ? e.message : String(e)}); writing to files`);
  }
  const telemetry = new Telemetry({ dir: defaultTelemetryDir(), retentionDays: () => getConfig().telemetry.retentionDays, enabled: () => getConfig().telemetry.enabled, remote: () => redis });
  runner.telemetry = telemetry;
  providers.telemetry = telemetry;
  // Claude Code-compatible project configuration: settings.json, plugins, custom commands (both .claude and .localpilot).
  const roots = [args.cwd];
  let settings = await loadProjectSettings(roots, { log });
  const plugins = await discoverPlugins(roots, { extraDirs: getConfig().pluginPaths, enabledPlugins: settings.enabledPlugins });
  const pluginParts = pluginSource(plugins);
  const pluginLayers = pluginParts.settingsLayers();
  if (pluginLayers.length) {
    settings = await loadProjectSettings(roots, { log, extra: pluginLayers });
  }
  runner.projectSettings = () => settings;
  runner.hooks = new HookRunner(() => (getConfig().hooksEnabled ? settings : { ...settings, hooks: {} }), log, (text) => process.stderr.write(`${dim('hook:')} ${text}\n`));
  skills.plugins = pluginParts;
  const commands = await discoverCommands(roots, { plugins: pluginParts, log });
  const sessions = new Map<string, Session>();
  tools.registerAll([...fsTools, ...searchTools, ...terminalTools, ...editorTools, ...webTools, ...createMemoryTools(memory), manageTodosTool, createGatherContextTool(workspace, sessions), createAnalyzeWorkspaceTool(() => getConfig().parallel.maxConcurrency), repoGraphTool, ...gitTools, teamBoardTool, reposTool, securityScanTool]);
  tools.registerAll(createAgentTools(runner, skills, emit, approve));
  await skills.refresh();
  let mcp: McpManager | undefined;
  const pluginMcp = pluginParts.mcpServers();
  if (args.mcp && (Object.keys(getConfig().mcpServers).length || Object.keys(pluginMcp).length)) {
    mcp = new McpManager(tools, log, VERSION);
    mcp.extraServers = () => pluginMcp;
    await mcp.reload();
  }
  return { providers, tools, skills, workspace, tracker, memory, runner, catalog, mcp, log, sessions, telemetry, telemetryRemote: redis, settings, plugins, commands };
}

function newSession(mode: Session['mode'], model: string): Session {
  const now = Date.now();
  return { id: `cli-${now.toString(36)}`, title: 'CLI session', createdAt: now, updatedAt: now, model, mode, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [], todos: [], workingSet: [] };
}

async function approval(title: string, detail: string, kind: string, rl?: readline.Interface): Promise<boolean> {
  if (isAutoApprove()) {
    return true;
  }
  if (!process.stdin.isTTY) {
    process.stdout.write(`${yellow('!')} ${title} — denied (no TTY; pass --yes to auto-approve)\n`);
    return false;
  }
  const KIND: Record<string, string> = { terminal: 'terminal', write: 'file edit', delete: 'delete', network: 'network' };
  const body = detail.split('\n').slice(0, 24).map((l) => `  ${dim('│')} ${l}`).join('\n');
  process.stdout.write(`\n${yellow('!')} ${bold(title)} ${dim(`(${KIND[kind] ?? kind})`)}\n${body}${detail.split('\n').length > 24 ? `\n  ${dim('│ …')}` : ''}\n`);
  setReadline(rl);
  const a = (await ask(`  ${amber('Allow?')} ${dim('[y]es · [n]o · [a]lways this session')} `))?.trim().toLowerCase() ?? 'n';
  if (a === 'a' || a === 'always') {
    setAutoApprove(true);
    return true;
  }
  return a === 'y' || a === 'yes';
}

/**
 * ask_user in the terminal: numbered options with their explanations; answer with numbers ("2", "1,3" for multi-select)
 * or your own words, Enter takes the recommended option. Ctrl+D skips (the agent goes with its recommendations).
 */
async function askQuestions(questions: UserQuestion[], rl?: readline.Interface): Promise<UserAnswer[] | null> {
  setReadline(rl);
  const answers: UserAnswer[] = [];
  for (const [i, q] of questions.entries()) {
    const n = questions.length > 1 ? dim(` (${i + 1}/${questions.length})`) : '';
    const opts = q.options.map((o, k) => `  ${amber(String(k + 1))}. ${bold(o.label)}${o.label === q.recommended ? ` ${amber('(recommended)')}` : ''}${o.description ? `\n     ${dim(o.description)}` : ''}`).join('\n');
    const hint = q.options.length ? dim(`${q.multiSelect ? 'numbers separated by commas' : 'a number'}, or your own words${q.recommended ? ' · Enter = recommended' : ''}`) : dim('your answer');
    process.stdout.write(`\n${yellow('?')}${n} ${q.header ? `${dim(`[${q.header}]`)} ` : ''}${bold(q.question)}\n${opts}${opts ? '\n' : ''}  ${hint}\n`);
    const a = await ask('  > ');
    if (a === undefined) {
      return null;
    }
    const t = a.trim();
    const nums = /^\d+(?:\s*,\s*\d+)*$/.test(t) ? t.split(',').map((x) => Number(x) - 1).filter((k) => k >= 0 && k < q.options.length) : [];
    if (!t) {
      answers.push({ question: q.question, selected: q.recommended ? [q.recommended] : [] });
    } else if (nums.length) {
      answers.push({ question: q.question, selected: (q.multiSelect ? nums : nums.slice(0, 1)).map((k) => q.options[k].label) });
    } else {
      answers.push({ question: q.question, selected: [], other: t });
    }
  }
  return answers;
}

async function runTurn(core: Core, session: Session, text: string, files: string[], r: Renderer, rl: readline.Interface | undefined, control: RunControl, opts: { modelRef?: string; permissionAllow?: string[]; display?: string } = {}): Promise<string> {
  let content = text;
  const blocks = await Promise.all(files.map((f) => core.workspace.readAttachment(f)));
  if (blocks.some(Boolean)) {
    content = `${blocks.filter(Boolean).join('\n\n')}\n\n${text}`;
  }
  const userMessage: ChatMessage = { role: 'user', content, meta: opts.display ? { display: opts.display } : undefined };
  core.tracker.beginTurn(session.id, session.messages.length);
  let final = '';
  // Pause / resume feedback, for the main run and for subagents the user paused or stopped individually.
  const offControl = control.onDidChange((c) => {
    const who = c === control ? '' : `${c.label ?? 'subagent'}: `;
    if (c.aborted && c !== control) {
      r.note(`■ ${who}stopped`);
    } else if (c.holding) {
      r.note(`⏸ ${who}paused${c === control ? ' — type to add instructions, Ctrl+Z to resume, Ctrl+C to stop' : ''}`);
    } else if (c.paused) {
      r.note(`⏸ ${who}pausing after the current step…`);
    } else if (c.pendingSteering === 0 && !c.aborted) {
      r.note(`▶ ${who}resumed`);
    }
  });
  const result = await core.runner.run({
    session,
    userMessage,
    modelRef: opts.modelRef,
    permissionAllow: opts.permissionAllow,
    signal: control.signal,
    control,
    workspaceRoot: session.worktree?.path,
    emit: (e) => {
      const p = e.payload as Record<string, unknown>;
      switch (e.type) {
        case 'assistant_delta': r.text(String(e.payload)); break;
        case 'thinking_delta': r.status(`Thinking… ${dim(String(e.payload).replace(/\s+/g, ' ').slice(-60))}`); break;
        case 'status': if (typeof e.payload === 'string') {r.status(e.payload);} break;
        case 'tool_start': if (!p.childId) {r.toolStart(String(p.id), String(p.name), (p.args as Record<string, unknown>) ?? {});} break;
        case 'tool_end': if (!p.childId) {r.toolEnd(String(p.id), String(p.name), !!p.isError, String(p.content ?? ''), p.data, !!p.cached);} break;
        case 'todos': r.todos((e.payload as TodoItem[]) ?? []); break;
        case 'compaction': r.note(`Context compacted ${(p.before as number).toLocaleString()} → ${(p.after as number).toLocaleString()} tokens`); break;
        case 'skill_suggestions': {
          const sk = (p.skills as { name: string }[]) ?? []; const cr = p.create as { slug: string; count: number } | undefined;
          const inst = p.installed as { name: string; repo: string; dir: string } | undefined; const avail = p.available as { name: string; repo: string } | undefined;
          const pre = (p.preloaded as { name: string; reason: string }[]) ?? [];
          if (inst) {r.note(`Installed skill "${inst.name}" from ${inst.repo} → ${inst.dir}`);}
          if (pre.length) {r.note(`Using skill${pre.length === 1 ? '' : 's'}: ${pre.map((s) => `${s.name}${s.reason === 'pinned' ? ' (pinned)' : s.reason === 'forced' ? ' (requested)' : ''}`).join(', ')}`);}
          if (sk.length) {r.note(`Skills that may apply: ${sk.map((s) => s.name).join(', ')}`);}
          if (avail) {r.note(`"${avail.name}" from ${avail.repo} matches this request but is not installed — localpilot skill search ${avail.name} --install`);}
          if (cr) {r.note(`"${cr.slug}" requests have come up ${cr.count}× without a skill — ask me to create one (.localpilot/skills/${cr.slug}/SKILL.md)`);}
          break;
        }
        case 'clarify': r.note(`Request looks ambiguous (${((p.reasons as string[]) ?? []).join('; ')}) — interpreting it from editor, errors and git context`); break;
        case 'subagent_start': r.note(`↳ subagent ${p.agent}: ${String(p.label || p.prompt).slice(0, 80)}`); break;
        case 'nudge': r.note(`↺ ${p.reason === 'malformed' ? 'the tool call did not parse' : p.reason === 'shown' ? 'the tool call was written as text, not made' : p.reason === 'stale' ? 'the workers already finished; asking for their results' : 'the reply claimed an action no tool performed'} — asking the model to act`); break;
        case 'steer': r.note(`↩ your message${Number(p.count) === 1 ? ' was' : 's were'} added to the conversation`); break;
        case 'subagent_end': r.note(`↲ subagent ${p.agent} ${p.error ? red('failed') : 'done'}`); break;
        case 'error': r.error(String(e.payload)); break;
        case 'turn_end': final = String(p.text ?? ''); break;
      }
    },
    requestApproval: (title, detail, kind) => approval(title, detail, kind, rl),
    // Questions need someone at the terminal; scripted runs (no TTY, --yes) go with the agent's recommendations.
    askUser: process.stdin.isTTY && !isAutoApprove() ? (questions) => askQuestions(questions, rl) : undefined,
  }).finally(offControl);
  r.end();
  return final || result;
}

/** Create an isolated worktree for the CLI session (seeded with the checkout's uncommitted work) and route tools into it. */
async function isolate(core: Core, session: Session, cwd: string, r: Renderer): Promise<{ info: WorktreeInfo; mgr: WorktreeManager } | undefined> {
  const mgr = new WorktreeManager(getConfig().worktrees.location, core.log);
  const repo = await mgr.repoRoot(cwd);
  if (!repo) {
    return undefined;
  }
  const info = await mgr.create(repo, session.id, { progress: (t) => r.status(t) });
  session.worktree = info; // runTurn routes the tools into it
  r.note(`Isolated: working in ${info.path} (your checkout stays untouched)`);
  return { info, mgr };
}

/** Apply the worktree's result to the checkout (or not), report, and remove the worktree. */
async function finishIsolated(wt: { info: WorktreeInfo; mgr: WorktreeManager }, apply: boolean, r: Renderer, quiet: boolean): Promise<void> {
  const changes = await wt.mgr.changes(wt.info).catch(() => []);
  const say = (s: string) => (quiet ? process.stderr.write(`${s}\n`) : console.log(s));
  if (!changes.length) {
    say(dim('isolated worktree: no changes'));
  } else if (apply) {
    const res = await wt.mgr.apply(wt.info);
    say(green(`applied ${res.files.length} file${res.files.length === 1 ? '' : 's'} from the isolated worktree to your checkout (uncommitted)`));
    if (res.conflicts.length) {
      say(yellow(`conflict markers in: ${res.conflicts.join(', ')}`));
    }
  } else {
    say(yellow(`${changes.length} changed file${changes.length === 1 ? '' : 's'} left in ${wt.info.path} (not applied)`));
    for (const c of changes) {
      say(`  ${c.kind === 'create' ? green('A') : c.kind === 'delete' ? red('D') : yellow('M')} ${c.path}  ${dim(`+${c.added} −${c.removed}`)}`);
    }
    return; // keep the worktree for the user to inspect
  }
  await wt.mgr.remove(wt.info);
}

function changesSummary(core: Core, session: Session): void {
  const files = core.tracker.forSession(session.id);
  if (!files.length) {
    return;
  }
  process.stdout.write(`\n${amber('✎')} ${bold(`${files.length} file${files.length === 1 ? '' : 's'} changed`)} ${dim('— /undo to revert, /keep to accept')}\n${files.map((f) => `  ${f.original === undefined ? green('A') : yellow('M')} ${vscode.workspace.asRelativePath(f.fsPath)}`).join('\n')}\n`);
}

// ------------------------------------------------------------------ subcommands
function modelLine(m: ModelInfo, def: string): string {
  const tags = [m.remote ? yellow('cloud') : '', m.supportsTools ? green('tools') : dim('prompt-tools'), m.supportsVision ? 'vision' : '', m.supportsFim ? 'fim' : ''].filter(Boolean).join(' ');
  return `  ${m.id === def ? amber('●') : dim('○')} ${bold(m.id.padEnd(44))} ${dim(`${Math.round(m.contextWindow / 1024)}k`)}  ${tags}`;
}

async function cmdModels(core: Core): Promise<void> {
  const models = await core.providers.listModels(true);
  const def = getConfig().defaultModel;
  if (!models.length) {
    console.log(`${red('✖')} No models found. Start Ollama (ollama serve), LM Studio, llama.cpp or vLLM, or add a cloud API: localpilot providers add openai --key <key>   (all: localpilot providers presets)`);
    return;
  }
  const by = new Map<string, ModelInfo[]>();
  for (const m of models) {
    by.set(m.providerId, [...(by.get(m.providerId) ?? []), m]);
  }
  for (const [pid, list] of by) {
    console.log(`${bold(pid)} ${dim(core.providers.get(pid)?.baseUrl ?? '')}`);
    for (const m of list) {
      console.log(modelLine(m, def));
    }
  }
  console.log(dim(`\n${amber('●')} = default. Change with: localpilot --model <id> … or /model in a session${models.some((m) => m.remote) ? '. Cloud models answer only when chosen; automatic picks prefer local ones.' : ''}`));
}

/** `localpilot providers [list|presets|add|key|remove|test] …` */
async function cmdProviders(args: Args): Promise<number> {
  const [sub = 'list', target, value] = args.prompt ? args.prompt.split(/\s+/) : [];
  switch (sub) {
    case 'list': case 'ls': await listProviders(STYLE); return 0;
    case 'presets': case 'available': listPresets(STYLE); return 0;
    case 'add': return addProvider(target ?? '', args.provider, STYLE);
    case 'key': case 'set-key':
      if (!target) { console.error(`${red('✖')} Usage: localpilot providers key <id> [key] [--key-env VAR] [--remove-key]`); return 2; }
      return setProviderKey(target, value ?? args.provider.key, args.provider, STYLE);
    case 'remove': case 'rm':
      if (!target) { console.error(`${red('✖')} Usage: localpilot providers remove <id>`); return 2; }
      return removeProvider(target, STYLE);
    case 'test': case 'check': return testProviders(target, STYLE);
    default:
      console.error(`${red('✖')} Unknown: providers ${sub}. Try: list, presets, add, key, test, remove`);
      return 2;
  }
}

/** `localpilot scan`: the security scan for a terminal or CI job; exit 1 when a finding reaches --fail-on. */
async function cmdScan(args: Args, renderer: Renderer): Promise<number> {
  const o = args.scanOpts;
  const r = await scanWorkspace(args.cwd, { kinds: { dependencies: !o.offline, secrets: true, code: true }, path: args.prompt || undefined, progress: (t) => renderer.status(t) });
  renderer.status('');
  console.log(formatFindings(r, 200));
  const fs = await import('fs');
  if (o.sarif) {
    await fs.promises.writeFile(o.sarif, JSON.stringify(toSarif(r, VERSION), null, 2));
    console.log(dim(`SARIF written to ${o.sarif}`));
  }
  if (o.json) {
    await fs.promises.writeFile(o.json, JSON.stringify(r, null, 2));
  }
  if (o.failOn === 'none') {
    return 0;
  }
  const at = SEVERITY_ORDER.indexOf(o.failOn);
  return r.findings.some((f) => SEVERITY_ORDER.indexOf(f.severity) >= at) ? 1 : 0;
}

/**
 * `localpilot work`: take tasks from the shared board (.localpilot/board) one after another until none is left. Run it
 * in several terminals, or on several machines sharing the folder, and they split the board between them.
 */
async function cmdWork(core: Core, args: Args, renderer: Renderer): Promise<number> {
  const board = new TeamBoard(args.cwd);
  const ctl = new AbortController();
  process.once('SIGINT', () => ctl.abort());
  let done = 0;
  let idleSince = 0;
  console.log(`${BRAND} working on the shared board in ${args.cwd}${args.workOpts.once ? ' (one task)' : ''} — Ctrl+C to stop\n`);
  while (!ctl.signal.aborted && (args.workOpts.max === undefined || done < args.workOpts.max)) {
    const session = newSession(args.mode, getConfig().defaultModel);
    core.sessions.set(session.id, session);
    const owner = boardOwner(session.id);
    const task = await board.claim(owner);
    if (!task) {
      const all = await board.list();
      // Others are still working (or their tasks unblock ours later): wait for them; otherwise the board is finished.
      const pending = all.some((t) => t.status === 'claimed' || (t.status === 'open' && t.dependsOn.every((d) => all.find((x) => x.id === d)?.status !== 'failed')));
      if (args.workOpts.once || !pending) {
        console.log(dim(all.length ? `Nothing left to take (${all.filter((t) => t.status === 'done').length}/${all.length} done).` : 'The board is empty: add tasks with the team_board tool or as .localpilot/board/<id>.md.'));
        break;
      }
      idleSince ||= Date.now();
      renderer.status(`Waiting for tasks claimed by others to finish… (${Math.round((Date.now() - idleSince) / 1000)} s)`);
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    idleSince = 0;
    console.log(`${amber('●')} ${bold(task.id)} ${task.title} ${dim(`(${owner})`)}`);
    // Keep the claim alive while the agent works, so a long task is not taken over by another worker.
    const heartbeat = setInterval(() => void board.update(task.id, owner, { renew: true }), LEASE_MS / 3);
    const notes = task.notes.filter((n) => n.text !== 'claimed').map((n) => `- ${n.by}: ${n.text}`).join('\n');
    const prompt = `You are working on "${task.title}" (id ${task.id}) from the team's shared task board.\n\n${task.brief}${notes ? `\n\nNotes from earlier work on it:\n${notes}` : ''}\n\nDo the work and verify it. Then call team_board with action "complete", id "${task.id}" and a summary of what changed and how you verified it. If you cannot finish, call team_board "release" with a note saying what is done and what is left (or "fail" with the reason if it cannot be done).`;
    let ok = true;
    let final = '';
    try {
      const run = new RunControl(session.id);
      const stop = () => run.stop('the worker was stopped');
      ctl.signal.addEventListener('abort', stop, { once: true });
      final = await runTurn(core, session, prompt, [], renderer, undefined, run, { display: `board: ${task.id}` }).finally(() => ctl.signal.removeEventListener('abort', stop));
    } catch (e) {
      ok = false;
      final = e instanceof Error ? e.message : String(e);
    } finally {
      clearInterval(heartbeat);
    }
    // The agent normally closes its own claim; if it did not, close it from the outcome so the task never stays stuck.
    const after = await board.get(task.id);
    if (after?.status === 'claimed' && after.owner === owner) {
      await board.update(task.id, owner, ctl.signal.aborted || !ok ? { note: `released: ${ctl.signal.aborted ? 'the worker was stopped' : final.slice(0, 300)}`, status: 'open' } : { note: 'completed (closed by the worker)', status: 'done', result: final.slice(0, 2000) });
    }
    const end = await board.get(task.id);
    console.log(`  ${end?.status === 'done' ? green('✔ done') : end?.status === 'failed' ? red('✖ failed') : dim(`↩ ${end?.status ?? '?'}`)}\n`);
    done++;
    if (args.workOpts.once) {
      break;
    }
  }
  return 0;
}

/** `localpilot eval`: the benchmark, one task at a time per model (a local server serves one request well at a time). */
async function cmdEval(core: Core, args: Args): Promise<number> {
  const o = args.evalOpts;
  let suite;
  try {
    suite = await loadSuite(o.suite ?? (await projectSuites(args.cwd))[0]);
  } catch (e) {
    console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const tasks = o.tasks.length ? suite.tasks.filter((t) => o.tasks.includes(t.id)) : suite.tasks;
  if (!tasks.length) {
    console.error(`${red('✖')} No tasks match ${o.tasks.join(', ')}. Tasks: ${suite.tasks.map((t) => t.id).join(', ')}`);
    return 2;
  }
  const models = o.models.length ? o.models : [args.model ?? getConfig().defaultModel].filter(Boolean);
  if (!models.length) {
    const auto = await core.providers.resolve('').catch(() => undefined);
    if (auto) {
      models.push(auto.model.id);
    }
  }
  if (!models.length) {
    console.error(`${red('✖')} No model to evaluate. Pass --models provider/model[,…] (see \`localpilot models\`).`);
    return 2;
  }
  setAutoApprove(true);
  const run: EvalRun = { suite: suite.name, startedAt: new Date().toISOString(), host: os.hostname(), results: [] };
  const ctl = new AbortController();
  process.once('SIGINT', () => ctl.abort());
  console.log(`${BRAND} benchmark ${bold(suite.name)}: ${tasks.length} task${tasks.length === 1 ? '' : 's'} × ${models.length} model${models.length === 1 ? '' : 's'}\n`);
  for (const model of models) {
    console.log(bold(model));
    for (const task of tasks) {
      if (ctl.signal.aborted) {
        break;
      }
      process.stdout.write(`  ${task.id.padEnd(26)} `);
      const r = await runTask(core.runner, task, model, { signal: ctl.signal, keep: o.keep });
      run.results.push(r);
      console.log(r.skipped ? dim(`skipped (${r.skipped})`) : `${r.pass ? green('✔ pass') : red('✖ fail')}  ${dim(`${(r.durationMs / 1000).toFixed(0)} s · ${r.steps} steps · ${r.toolCalls} tools${r.workspace ? ` · ${r.workspace}` : ''}`)}${r.pass ? '' : `\n    ${dim(String(r.reason).slice(0, 240))}`}`);
    }
  }
  const prev = new Map<string, EvalRun>();
  for (const m of models) {
    const p = await previousRun(suite.name, m, run.startedAt);
    if (p) {
      prev.set(m, p);
    }
  }
  const saved = await saveRun(run);
  const report = formatReport(run, prev);
  console.log(`\n${md(report)}\n\n${dim(`Saved ${saved}`)}`);
  if (o.json) {
    await import('fs').then((fs) => fs.promises.writeFile(o.json!, JSON.stringify({ ...run, summary: summarize(run.results) }, null, 2)));
  }
  // Exit 1 when anything that ran failed, so CI can gate on a benchmark.
  return run.results.some((r) => !r.pass && !r.skipped) ? 1 : 0;
}

async function cmdDoctor(core: Core): Promise<void> {
  console.log(`${BRAND} ${dim(`v${VERSION}`)} doctor\n`);
  console.log(`${bold('Settings')}\n  ${dim(USER_SETTINGS_PATH)}\n  ${dim(CLI_SETTINGS_PATH)}`);
  const cfg = getConfig();
  console.log(`  default model: ${cfg.defaultModel || dim('auto')}   approvals: terminal=${cfg.approvals.terminal} write=${cfg.approvals.write} delete=${cfg.approvals.delete} network=${cfg.approvals.network}`);
  const org = getManagedPolicy();
  console.log(`\n${bold('Organization policy')}\n  ${org.source ? `${org.source}${org.message ? dim(` — ${org.message}`) : ''}\n${describePolicy(org).map((l) => `  ${amber('●')} ${l}`).join('\n') || dim('  (no restrictions)')}` : dim(`none (${managedPolicyPath()})`)}`);
  console.log(`\n${bold('Providers')}`);
  await listProviders(STYLE, (l) => console.log(`  ${l}`), { compact: true });
  console.log(`\n${bold('Workspace')}\n  ${core.workspace.root ?? dim('(none)')}`);
  console.log(`  skills: ${core.skills.allSkills.length}   subagents: ${core.skills.allAgents.length}   mcp servers: ${core.mcp ? core.mcp.status.map((s) => `${s.name}(${s.error ? red('failed') : `${s.tools} tools`})`).join(', ') : dim('none configured')}`);
  const rg = await runProcess('rg', ['--version']).then(() => true).catch(() => false);
  console.log(`  ripgrep: ${rg ? green('found') : dim('not on PATH (using built-in search)')}   node: ${process.version}   platform: ${process.platform}`);
}

async function cmdSkillSearch(core: Core, args: Args, renderer: Renderer): Promise<void> {
  if (!args.prompt) {
    console.error(`${red('✖')} Usage: localpilot skill search <words> [--install] [--user]`);
    process.exitCode = 2;
    return;
  }
  const repos = getConfig().skillRepositories;
  if (!repos.length) {
    console.error(`${red('✖')} No skill repositories configured (localpilot.skills.repositories).`);
    process.exitCode = 2;
    return;
  }
  if (!(await core.catalog.ready())) {
    renderer.status(`Indexing ${repos.join(', ')}…`);
    await core.catalog.refresh();
    renderer.status('');
  }
  const have = new Set(core.skills.allSkills.map((s) => s.name));
  const hits = await core.catalog.search(args.prompt, 10);
  for (const s of await core.catalog.status()) {
    if (s.error) {
      console.log(`  ${yellow('!')} ${s.repo}: ${s.error}`);
    }
  }
  if (!hits.length) {
    console.log(`  ${dim('No catalog skill matches')} "${args.prompt}" ${dim(`(${repos.join(', ')}). Try other words, or browse: localpilot skill search ""`)}`);
    return;
  }
  hits.forEach((h, i) => {
    console.log(`  ${have.has(h.name) ? green('✓') : i === 0 ? yellow('★') : dim('·')} ${bold(h.name)} ${dim(`${h.repo} · ${h.score}`)}\n    ${dim(h.description.replace(/\s+/g, ' ').slice(0, 140))}`);
  });
  if (!args.install) {
    console.log(`\n${dim('Install the best match with')} localpilot skill search "${args.prompt}" --install ${dim('or any of them with')} localpilot skill install <repo>/<dir>`);
    return;
  }
  // The first hit is what the agent itself would install for this request.
  const pick = hits.find((h) => !have.has(h.name)) ?? hits[0];
  const dest = skillsDestination(args.user ? 'user' : 'workspace', args.cwd);
  const one = await core.catalog.install(pick, dest, { replace: args.yes, progress: (t) => renderer.status(t) });
  renderer.status('');
  await core.skills.refresh();
  if (one) {
    console.log(`\n  ${green('✓')} ${bold(one.name)} ${dim(`(${one.files} file${one.files === 1 ? '' : 's'}) → ${one.dir}`)}\n${dim('The agent loads it when a request matches; force it with')} /skill ${one.name} <task>`);
  } else {
    console.log(`\n  ${dim(`"${pick.name}" is already installed in ${dest} (use -y to replace it)`)}`);
  }
}

// ------------------------------------------------------------------ main
async function cmdSkillInstall(core: Core, args: Args, renderer: Renderer): Promise<void> {
  const src = parseSkillSource(args.prompt);
  if (!args.prompt || !src) {
    console.error(`${red('✖')} Usage: localpilot skill install <owner/repo[/path] | github URL | SKILL.md URL | folder> [--user]`);
    process.exitCode = 2;
    return;
  }
  const dest = skillsDestination(args.user ? 'user' : 'workspace', args.cwd);
  console.log(`${dim('Installing from')} ${describeSource(src)} ${dim('into')} ${dest}`);
  const installed = await installSkills(src, {
    dest,
    progress: (t) => renderer.status(t),
    onExists: async (name) => {
      if (args.yes) {
        return true;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((r) => rl.question(`${yellow('!')} "${name}" is already installed there. Replace it? [y/N] `, r));
      rl.close();
      return /^y(es)?$/i.test(answer.trim());
    },
  });
  renderer.status('');
  await core.skills.refresh();
  for (const i of installed) {
    console.log(`  ${green('✓')} ${bold(i.name)} ${dim(`(${i.files} file${i.files === 1 ? '' : 's'}) → ${i.dir}`)}`);
  }
  if (!installed.length) {
    console.log(`  ${dim('nothing installed')}`);
  } else {
    console.log(`\n${dim('The agent loads it when a request matches; force it with')} /skill ${installed[0].name} <task>`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (args.cmd === 'version') {
    console.log(VERSION);
    return;
  }
  if (args.cmd === 'ide') {
    openInVsCode(args.prompt ? 'run' : 'new', { mode: args.mode, prompt: args.prompt, files: args.files.join(','), parallel: process.argv.includes('--parallel') || process.argv.includes('-P') ? '1' : '' }, args.cwd);
  }
  if (args.cmd === 'settings' || args.cmd === 'setup') {
    openInVsCode(args.cmd, {}, args.cwd);
  }

  setWorkspaceRoot(args.cwd);
  if (args.model) {
    cliOverrides.defaultModel = args.model;
    setWorkspaceRoot(args.cwd);
  }
  if (args.yes) {
    setAutoApprove(true);
  }
  setLogLevel(args.verbose ? 'debug' : 'warn');
  // Keys for `${secret:id}` references: VS Code keeps them in the OS keychain, the CLI in its own key file.
  setSecretValues(readCliKeys());
  if (args.cmd === 'providers') {
    process.exitCode = await cmdProviders(args);
    return;
  }

  const quiet = args.print || (!args.prompt && !process.stdin.isTTY);
  const renderer = new Renderer(args.verbose, quiet);
  let rl: readline.Interface | undefined;
  const core = await boot(args, (e) => {
    if (e.type === 'status' && typeof e.payload === 'string') {
      renderer.status(e.payload);
    }
  }, (_sid, title, detail, kind) => approval(title, detail, kind, rl));

  if (args.cmd === 'models') {
    return cmdModels(core);
  }
  if (args.cmd === 'skill-install') {
    return cmdSkillInstall(core, args, renderer);
  }
  if (args.cmd === 'skill-search') {
    return cmdSkillSearch(core, args, renderer);
  }
  if (args.cmd === 'doctor') {
    return cmdDoctor(core);
  }
  if (args.cmd === 'eval') {
    process.exitCode = await cmdEval(core, args);
    return;
  }
  if (args.cmd === 'scan') {
    process.exitCode = await cmdScan(args, renderer);
    return;
  }
  if (args.cmd === 'work') {
    process.exitCode = await cmdWork(core, args, renderer);
    return;
  }

  // Resolve the model up front so a missing server fails fast with a useful message.
  let modelInfo: ModelInfo;
  try {
    modelInfo = (await core.providers.resolve(getConfig().defaultModel)).model;
  } catch (e) {
    console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}\n${dim('Run `localpilot doctor` to see which servers are reachable, or `localpilot --setup` to configure one in VS Code.')}`);
    process.exit(2);
  }
  const session = newSession(args.mode, modelInfo.id);
  core.sessions.set(session.id, session);
  const cwdLabel = vscode.workspace.asRelativePath(args.cwd) === args.cwd ? path.basename(args.cwd) : args.cwd;
  /** `/name args` as a one-shot prompt runs the custom command (like `claude -p "/cmd"`); anything else is sent as typed. */
  const prepare = async (text: string): Promise<{ text: string; opts: { modelRef?: string; permissionAllow?: string[]; display?: string } }> => {
    const m = /^\/([\w:-]+)\s*([\s\S]*)$/.exec(text.trim());
    const custom = m ? indexCommands(core.commands).get(`/${m[1]}`) : undefined;
    if (!custom) {
      return { text, opts: {} };
    }
    const { prompt, notes } = await expandCommand(custom, m![2], { root: session.worktree?.path ?? args.cwd });
    notes.forEach((n) => process.stderr.write(`${yellow('!')} ${n}\n`));
    return { text: prompt, opts: { modelRef: custom.model, permissionAllow: custom.allowedTools, display: text.trim() } };
  };

  // One-shot mode -----------------------------------------------------------
  if (args.prompt) {
    if (!quiet) {
      process.stdout.write(`${BRAND} ${dim(`${modelInfo.id} · ${args.mode} · ${cwdLabel}`)}\n\n`);
    }
    const ctl = new RunControl(session.id);
    process.once('SIGINT', () => ctl.stop());
    // Cooked terminal: Ctrl+Z arrives as SIGTSTP; hold the agent instead of suspending the process.
    process.on('SIGTSTP', () => ctl.togglePause());
    const wt = args.isolate ? await isolate(core, session, args.cwd, renderer) : undefined;
    const prepared = await prepare(args.prompt);
    const answer = await runTurn(core, session, prepared.text, args.files, renderer, undefined, ctl, prepared.opts);
    if (quiet) {
      process.stdout.write(answer.trimEnd() + '\n');
    } else {
      changesSummary(core, session);
      if (core.tracker.forSession(session.id).length) {
        core.tracker.keep(session.id); // one-shot runs keep their edits; the summary above tells the user what changed
      }
    }
    if (wt) {
      await finishIsolated(wt, args.apply && !ctl.signal.aborted, renderer, quiet);
    }
    core.mcp?.dispose();
    // After finishIsolated the worktree may be gone, so hooks run in the real workspace.
    await core.runner.hooks?.sessionEnd(session.id, 'other', args.cwd, { signal: ctl.signal });
    await core.telemetry.flush();
    core.telemetryRemote?.dispose();
    process.exit(ctl.signal.aborted ? 130 : 0);
  }

  // Interactive REPL --------------------------------------------------------
  if (!process.stdin.isTTY) {
    // Piped stdin: treat the whole input as one prompt.
    const input = await new Promise<string>((resolve) => {
      let s = '';
      process.stdin.on('data', (d) => (s += d));
      process.stdin.on('end', () => resolve(s));
    });
    const prepared = await prepare(input.trim());
    const answer = await runTurn(core, session, prepared.text, args.files, renderer, undefined, new RunControl(session.id), prepared.opts);
    process.stdout.write(answer.trimEnd() + '\n');
    core.mcp?.dispose();
    await core.telemetry.flush();
    core.telemetryRemote?.dispose();
    return;
  }

  process.stdout.write(`${BRAND} ${dim(`v${VERSION}`)}  ${dim('·')}  ${cyan(modelInfo.id)}  ${dim('·')}  ${amber(args.mode)}  ${dim('·')}  ${dim(cwdLabel)}\n${dim('Type a task, /help for commands, Ctrl+C to stop a run, Ctrl+Z to pause it, /exit to quit.')}\n\n`);
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${amber('◆')} `, historySize: 200 });
  setReadline(rl);
  let current: RunControl | undefined;
  let pendingFiles = [...args.files];
  let isolated: { info: WorktreeInfo; mgr: WorktreeManager } | undefined = args.isolate ? await isolate(core, session, args.cwd, renderer) : undefined;
  rl.on('SIGINT', () => {
    if (current) {
      current.stop();
      process.stdout.write(`\n${dim('stopped')}\n`);
    } else {
      process.stdout.write('\n');
      rl!.close();
    }
  });
  // Ctrl+Z: hold the run after its current step (again to resume) instead of suspending the process.
  rl.on('SIGTSTP', () => {
    if (current) {
      current.togglePause();
    }
  });
  rl.on('close', () => {
    core.mcp?.dispose();
    if (isolated) {
      process.stdout.write(yellow(`isolated worktree kept at ${isolated.info.path} — run \`localpilot --isolate\` again or apply it with git\n`));
    }
    process.stdout.write(dim('bye\n'));
    void (session.messages.length ? core.runner.hooks?.sessionEnd(session.id, 'prompt_input_exit', isolated?.info.path ?? args.cwd) : Promise.resolve())
      ?.then(() => core.telemetry.flush())
      .finally(() => {
        core.telemetryRemote?.dispose();
        process.exit(0);
      });
  });

  const slash = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'help': console.log(HELP); return true;
      case 'exit': case 'quit': case 'q': rl!.close(); return true;
      case 'mode':
        if ((ALL_MODES as readonly string[]).includes(arg)) { session.mode = arg as Session['mode']; console.log(dim(`mode → ${arg}`)); } else { console.log(dim(`mode is ${session.mode}; use /mode agent|multitask|debug|plan|ask`)); }
        return true;
      case 'model': {
        if (!arg) { console.log(dim(`model is ${session.model}`)); return true; }
        const models = await core.providers.listModels();
        const m = models.find((x) => x.id === arg || x.modelId === arg || x.name === arg) ?? models.find((x) => x.id.includes(arg));
        if (!m) { console.log(red(`no model matches "${arg}" — /models lists them`)); return true; }
        session.model = m.id; cliOverrides.defaultModel = m.id; setWorkspaceRoot(args.cwd);
        console.log(dim(`model → ${m.id}`)); return true;
      }
      case 'models': await cmdModels(core); return true;
      case 'providers': await listProviders(STYLE); return true;
      case 'changes': changesSummary(core, session); if (!core.tracker.forSession(session.id).length) { console.log(dim('no pending changes')); } return true;
      case 'undo': { const n = await core.tracker.undo(session.id); console.log(n ? yellow(`reverted ${n} file${n === 1 ? '' : 's'}`) : dim('nothing to undo')); return true; }
      case 'keep': core.tracker.keep(session.id); console.log(green('changes kept')); return true;
      case 'isolate': {
        if (isolated) { console.log(dim(`already isolated in ${isolated.info.path}`)); return true; }
        isolated = await isolate(core, session, args.cwd, renderer);
        if (!isolated) { console.log(red('not a git repository — cannot isolate')); }
        return true;
      }
      case 'apply': case 'discard': {
        if (!isolated) { console.log(dim('this session is not isolated — /isolate first')); return true; }
        await finishIsolated(isolated, cmd === 'apply', renderer, false);
        isolated = undefined;
        session.worktree = undefined;
        return true;
      }
      case 'clear':
        await core.runner.hooks?.sessionEnd(session.id, 'clear', isolated?.info.path ?? args.cwd);
        session.messages = []; session.contextTokens = 0; session.todos = []; console.log(dim('conversation cleared')); return true;
      case 'file': case 'attach': if (arg) { pendingFiles.push(arg); console.log(dim(`will attach ${arg}`)); } return true;
      case 'doctor': await cmdDoctor(core); return true;
      case 'commands':
        console.log(core.commands.length ? core.commands.map((c) => `  ${bold(c.invoke)}${c.argumentHint ? ` ${dim(c.argumentHint)}` : ''}  ${c.description}${c.plugin ? dim(`  (plugin ${c.plugin})`) : ''}`).join('\n') : dim('no custom commands — add markdown files under .localpilot/commands or .claude/commands'));
        return true;
      case 'permissions': {
        const p = core.settings.permissions;
        const fmt = (l: string[]) => (l.length ? l.join(', ') : dim('none'));
        console.log(`  deny:  ${fmt(p.deny)}\n  ask:   ${fmt(p.ask)}\n  allow: ${fmt(p.allow)}${p.defaultMode ? `\n  defaultMode: ${p.defaultMode}` : ''}\n  ${dim(core.settings.sources.length ? `from ${core.settings.sources.join(', ')}` : 'no settings.json found')}`);
        return true;
      }
      case 'hooks': {
        const entries = Object.entries(core.settings.hooks);
        console.log(entries.length ? entries.map(([ev, ms]) => `  ${bold(ev)}: ${ms.map((m) => `${m.matcher ? `${m.matcher} → ` : ''}${m.hooks.map((h) => h.command).join(', ')}`).join('; ')}`).join('\n') : dim('no hooks configured (settings.json → "hooks")'));
        return true;
      }
      default: {
        const custom = indexCommands(core.commands).get(`/${cmd}`);
        if (custom) {
          const { prompt, notes } = await expandCommand(custom, arg, { root: session.worktree?.path ?? args.cwd });
          notes.forEach((n) => console.log(yellow(`  ${n}`)));
          if (!prompt) { console.log(red(`${custom.invoke}: the command file has no prompt body`)); return true; }
          rl!.setPrompt('');
          current = new RunControl(session.id);
          try {
            await runTurn(core, session, prompt, pendingFiles, renderer, rl, current, { modelRef: custom.model, permissionAllow: custom.allowedTools, display: line });
            pendingFiles = [];
            changesSummary(core, session);
          } catch (e) {
            renderer.error(e instanceof Error ? e.message : String(e));
          } finally {
            current = undefined;
            process.stdout.write('\n');
            rl!.setPrompt(PROMPT);
          }
          return true;
        }
        console.log(dim(`unknown command /${cmd} — /help`));
        return true;
      }
    }
  };

  rl.prompt();
  const PROMPT = `${amber('◆')} `;
  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (current) {
      // Typed while the agent works: queue it for the next step rather than refusing or waiting.
      if (line) {
        current.steer({ role: 'user', content: line });
        renderer.note(`↩ queued for the agent: ${line.slice(0, 80)}${current.paused ? ' (Ctrl+Z to resume)' : ''}`);
      }
      return;
    }
    if (!line) { rl!.prompt(); return; }
    if (line.startsWith('/')) { await slash(line); rl!.prompt(); return; }
    // The input stays live during the run so Ctrl+C / Ctrl+Z / steering lines keep working; only the prompt goes away.
    rl!.setPrompt('');
    current = new RunControl(session.id);
    try {
      await runTurn(core, session, line, pendingFiles, renderer, rl, current);
      pendingFiles = [];
      changesSummary(core, session);
    } catch (e) {
      renderer.error(e instanceof Error ? e.message : String(e));
    } finally {
      current = undefined;
      process.stdout.write('\n');
      rl!.setPrompt(PROMPT);
      rl!.prompt();
    }
  });
}

main().catch((e) => {
  console.error(`${red('✖')} ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
