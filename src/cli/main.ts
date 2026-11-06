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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode'; // → src/cli/vscodeShim.ts (aliased by the CLI build)
import { AgentRunner } from '../agent/agentLoop';
import { RunControl } from '../agent/runControl';
import { parseRunLine } from '../agent/messageQueue';
import { WorktreeInfo, WorktreeManager } from '../agent/worktrees';
import { ChangeTracker } from '../agent/changeTracker';
import { autoLabel, classifyTask, TaskRoute } from '../agent/taskRouter';
import { CheckpointService, isOrphanCheckpoint, pruneSnapshotDirs, snapshotFolder } from '../agent/checkpoints';
import { nextTurnKey, undoPicker } from './undoPicker';
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
import { promptDirs, promptItems, searchPrompts } from '../agent/promptLibrary';
import { agentTaskPrompt, CustomCommand, deepPlanningPrompt, discoverCommands, expandCommand, parseTaskArgs, resolveSlashMessage, skillTaskPrompt } from '../agent/commands';
import { saveImplementationPlan } from '../agent/deepPlanning';
import { normalizeCommandName, spliceSlashToken } from '../agent/slashNames';
import { describeSource, installSkills, parseSkillSource, skillsDestination } from '../agent/skillInstaller';
import { SkillCatalog } from '../agent/skillCatalog';
import { getConfig } from '../config';
import { WorkspaceContext } from '../context/workspaceContext';
import { McpManager, signInMcpServer } from '../mcp/mcpManager';
import { cliMcpOAuth } from './mcpOAuth';
import { loadMcpFiles } from '../mcp/config';
import { cliMcpTrust } from '../mcp/trust';
import { parseMcpSlash } from '../mcp/prompts';
import { createProvider, ProviderRegistry } from '../providers/registry';
import { findOllamaBinary, launchOllama, ollamaServerEnv } from '../providers/ollamaLauncher';
import { isLoopbackUrl } from '../providers/cloud';
import { browserInspectTool, browserScreenshotTool } from '../tools/browser';
import { editorTools } from '../tools/editor';
import { fsTools } from '../tools/fs';
import { notebookTools } from '../tools/notebook';
import { applyPatchTool } from '../tools/applyPatchTool';
import { patchArg, patchSummary } from '../tools/applyPatch';
import { pdfTools } from '../tools/pdf';
import { createAnalyzeWorkspaceTool } from '../tools/workspace';
import { ToolRegistry } from '../tools/registry';
import { runProcess, searchTools } from '../tools/search';
import { terminalTools } from '../tools/terminal';
import { webTools } from '../tools/web';
import { defaultTelemetryDir, Telemetry } from '../telemetry/telemetry';
import { setTelemetryRecorder } from '../telemetry/catalog';
import { attachOtlp } from '../telemetry/otlpSetup';
import { RedisTelemetry } from '../storage/redisTelemetry';
import { AgentEvent, ALL_MODES, ApprovalDecision, ChatMessage, isSpecialistId, ModelInfo, Session, SPECIALIST_IDS, TodoItem, UserAnswer, UserQuestion } from '../types';
import { SPECIALISTS } from '../agent/builtinAgents';
import { parseApprovalAnswer, toDecision } from '../agent/approvalLevel';
import { shouldRingBell } from '../ui/notifyPolicy';
import { addProvider, listPresets, listProviders, ProviderFlags, removeProvider, setProviderKey, Style, testProviders } from './providers';
import { cmdMcp, parseMcpArgs } from './mcpCmd';
import { setSecretValues } from '../providers/cloud';
import { ask, withPromptLock, setPromptOutput, CLI_KEYS_PATH, CLI_SETTINGS_PATH, cliOverrides, readCliKeys, isAutoApprove, LOG_FILE, ignoredWorkspaceSettings, setAutoApprove, setLogLevel, setReadline, setTrustWorkspace, setWorkspaceRoot, userSettingsPath } from './vscodeShim';
import { audit as auditPolicy, describePolicy, getManagedPolicy, managedPolicyPath } from '../agent/managedPolicy';
import { EvalRun, formatReport, loadSuite, previousRun, projectSuites, runTask, saveRun, summarize } from '../eval/runner';
import { LEASE_MS, TeamBoard, canFinish } from '../agent/teamBoard';
import { boardOwner, teamBoardTool } from '../tools/teamBoard';
import { reposTool } from '../tools/repos';
import { securityScanTool } from '../tools/security';
import { formatFindings, ScanResult, scanWorkspace, SEVERITY_ORDER, toSarif } from '../security/scan';
import { describePlugin, installPlugin, loadMarketplace, Marketplace, pluginsDir, removePlugin, scaffoldPlugin, searchPlugins, setPluginEnabled, validatePlugin } from '../agent/pluginInstaller';
import { SessionStore } from '../sessions/sessionStore';
import { turnUsageLabel, usageDelta } from '../agent/usageFormat';
import { cmdHistory, findSession, newestFirst, openCliStore, pickSession, resumeBanner } from './sessions';
import { cmdHistoryImport } from './historyImport';
import { cliLauncher, cmdSchedule } from './schedule';
import { createScheduleTool } from '../tools/schedule';
import { AcpHost, AcpServer, acpApprovalOverrides, serveAcp } from './acp';
import { teamPrompt } from '../agent/teamBrief';
import { sessionSlash } from './slash/sessions';
import { infoSlash } from './slash/info';
import { createCompleter } from './completer';
import { exitSummary, gitState, nextMode, statusLineText } from './statusLine';
import { contextPercent } from '../agent/reports';
import { effectiveContextWindow } from '../context/contextManager';
import { NdjsonWriter, runUsage } from './ndjson';
import { atRefs, EXIT_CODES_HELP, exitCodeFor, parseDuration, readSystemArg, REQUIRE_VERIFIED_HELP, RunOutcome, runProviderList, withStdin, YOLO_TOOLS, finishReasonFor } from './headless';
import { CliHealing, attemptBudget, createCliHealing } from './healing';
import { RecoveryNotes, RESUME_PROMPT, outcomeBlock, stateDetail } from './recoveryRender';
import { recoverySlash, RECOVERY_USAGE } from './slash/recovery';
import { cmdRecovery, resumableRecovery } from './recoveryCmd';
import { escalationReport, isTerminalPhase, type CompletionContract, type NextAction, type RecoveryEventPayload, type RecoverySummary } from '../agent/healing';
import { cmdConfig, ConfigSources, doctorReport } from './configCmd';
import { newestInstalledExtension, versionNotice } from './versionCheck';
import { readImage } from '../ui/images';
import { findPreset } from '../providers/presets';
import { parseThinkChoice, ThinkChoice } from '../agent/thinking';
import { rememberThinking, savedThinking, sessionThinking } from './thinkingPref';
import { DEFAULT_PROVIDERS } from '../providers/defaultProviders';
import type { ProviderConfig } from '../types';
import { deleteCommandLogs, detachWaiting, pruneCommandLogs, setCommandLogDir, stopAllCommands } from '../terminal/commandRun';

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
  localpilot doctor                       check servers, settings and tools [--json]; doctor log opens the log file
  localpilot config [kind] [--json]       what is in force: rules, skills, agents, commands, hooks, mcp, tools, plugins
  localpilot plugin search|install|remove|enable|disable|list|new|validate   plugins from marketplaces (Claude Code format) [--project]
  localpilot scan [folder]               security scan: vulnerable dependencies (OSV.dev), secrets, risky code [--fail-on high] [--sarif out.sarif] [--json out.json] [--offline]
  localpilot work [--once] [--max N]      take tasks from the shared board (.localpilot/board) until none is left
  localpilot eval [--models a,b]         benchmark models on real coding tasks [--suite file.json] [--tasks id,…] [--keep] [--json out.json]
  localpilot providers                    local and cloud providers: reachability, models, key state
  localpilot providers presets            providers you can add (Ollama, LM Studio… OpenAI, Claude, Gemini, OpenRouter…)
  localpilot providers add <preset|url>   add one [--id <id>] [--key <key> | --key-env VAR] [--url <url>] [--region <aws-region>] [--cloud]
  localpilot providers key <id> [key]     set its API key (prompted if omitted, or piped in) [--key-env VAR] [--remove-key]
  localpilot providers test [id]          check a provider and list its models
  localpilot providers remove <id>        remove a provider added here (disables a VS Code one for the CLI)
  localpilot mcp [list] [--json]          MCP servers in force; without arguments in a terminal, a menu to manage them
  localpilot mcp add <name> <url> | add <name> [--env K=V]… -- <command> [args…]   add one [--transport stdio|http|sse]
                                          [--header "K: V"]… [--scope user|project] (~/.localpilot/mcp.json or ./.mcp.json)
  localpilot mcp remove|enable|disable|auth <name>   remove, switch on/off, or sign in to a remote server
  localpilot skill install <source>       install a skill (owner/repo[/path], github URL, SKILL.md URL or folder) [--user]
  localpilot skill search <words>         find skills in the catalog repositories (localpilot.skills.repositories); add --install for the best match
  localpilot -c | -r [id]                continue the last session / pick one to resume (with a task: run it there)
  localpilot recovery list|show <id>|resume <id>|clear [id]   self-healing state of this folder's sessions: interrupted,
                                          incomplete and blocked tasks; resume one (checks re-run first) or forget finished ones
  localpilot history                      saved sessions in this folder [--json] [--limit 50]; history delete <id>;
                                          history export <id> [-o file.md|file.html]; history import [claude|codex] [N|all]
  localpilot schedule create <name> --cron "0 3 * * *" --prompt "…"   scheduled unattended runs via cron/launchd/Task
                                          Scheduler [--cwd] [--mode] [--model] [--timeout]; schedule list|run|pause|resume|delete|history <name>
  localpilot --acp                        Agent Client Protocol server on stdio (Zed, JetBrains, Neovim)
  localpilot --ide [options] "task"       open the task in VS Code instead

${bold('Options')}
  --auto                       each message picks its mode (Ask, Plan, Agent, Debug, a specialist…) from what it asks
  --ask | --plan | --agent     mode (default: agent); --multitask coordinates background workers, --debug fixes bugs
  -c, --continue               continue the most recent session in this folder (sessions are saved after every turn)
  -r, --resume [id]            resume a saved session by id or list number; without one, pick from a numbered list
  --data-dir <dir>             where sessions are saved (default ~/.localpilot, or LOCALPILOT_DATA_DIR)
  --hooks-dir <dir>            also run the hook scripts in this folder (PreToolUse.sh, TaskStart.py…; repeatable,
                               or LOCALPILOT_HOOKS_DIR)
  -i, --isolate                work in an isolated git worktree (your checkout is untouched); the result is applied
                               back as uncommitted changes when the run ends — --no-apply keeps it in the worktree
  -m, --model <provider/model> model for this run (e.g. ollama/gemma4:e4b)
  --thinking [level]           how hard reasoning models think: auto, off, low, medium (the default without a level),
                               high or max; remembered for later sessions
  -f, --file <path>           attach a file (repeatable; path#L10-L20 for a range)
  -y, --yes                    approve every command / edit / network call (CI, scripts)
  -C, --cwd <dir>              workspace root (default: current directory)
  -p, --print                  print the final answer only (no tool log; implies non-interactive); also when stdout
                               is not a terminal
  --json                       one-shot runs: one JSON event per line on stdout, then a run_result line
  --timeout <s>                stop the run after this long (90, 90s, 5m) and exit with code 124
  --retries <n>                stop after n failed steps in a row (localpilot.maxConsecutiveMistakes); exit code 3
${REQUIRE_VERIFIED_HELP}
  --yolo                       for CI: --yes, only the core file and command tools, --retries 3, no MCP unless --mcp
  -s, --system <text|@file>    add to the system prompt; --system-replace uses it instead of LocalPilot's persona
  -P, --provider <id>          use this provider (configured, or a preset such as openai) for this run
  -k, --key <key>              its API key for this run only (--save-key stores it like \`providers key\`)
  --no-mcp                     do not start MCP servers
  --compaction <strategy>      how a full context is compacted: agentic (model summary), basic (no model call) or off
  --trust-workspace            use providers, MCP servers, approvals and hooks from ./.vscode/settings.json
  -v, --verbose                show tool arguments and debug logs
  --settings | --setup         open LocalPilot Settings / the setup wizard in VS Code
  -h, --help · --version
  ${EXIT_CODES_HELP}

${bold('In a session')}
  /team <task>   split the task for background workers and the shared board (multitask mode)
  /mode ask|agent|plan|debug|multitask (or review, test, …)   /model <name>   /models   /providers   /undo   /keep   /changes   /clear   /help   /exit
  /thinking auto|off|low|medium|high|max   how hard the model thinks in this session (remembered)
  /history   saved sessions   /resume [N|id]   switch to one   /fork [name]   branch this session and continue in the copy
  ${RECOVERY_USAGE}   self-healing state of this session: re-run the checks and continue, undo fix attempts, past attempts
  /isolate   work in a git worktree from now on   /apply   bring its changes into your checkout   /discard   throw them away
  /undo [N [f|c|b]]   go back to an earlier turn: restore its files, the chat or both (Esc Esc at an empty prompt)   /undo all   revert every pending change
  /commands  custom slash commands (.claude/commands, .localpilot/commands, plugins) and MCP prompts   /prompts [words]   saved prompts (search)   /permissions   /hooks   settings.json rules
  /mcp:<server>:<prompt> args…   run an MCP server's prompt (arguments by position or key=value)
  /skill <name> <task>   run a task with a skill preloaded   /agent <name> <task>   hand a task to a subagent (also as -p "/skill …")
  /<skill-name> <task>   same as /skill   /deep-planning <task>   plan in Plan mode, saved to implementation_plan.md   /newrule   write a project rule
  /compact   summarise older messages   /context   context use   /memory   instruction files and memory notes
  /skills   /agents   /plugins   lists   /mcp [enable|disable|restart <name> [--save]]   MCP servers, their tools and errors
  /yes on|off   auto-approve (the prompt shows [auto])   /settings [filter]   effective settings   /settings set <key> <value>   save one
  Tab completes /commands and @paths (@path attaches a file or image)   Shift+Tab cycles the mode
  Ctrl+C stops the current run; press it again to quit. Ctrl+Z pauses after the current step (again to resume);
  anything you type while a run is going is handed to the agent at its next step; start a line with >> to send it
  after the turn instead. /queue lists both kinds and /queue rm N cancels one. Ctrl+B while a command runs lets the
  agent continue and leaves the command running (its later output goes to ~/.localpilot/cmd-logs).

${bold('Settings')} read from ${dim(userSettingsPath())}, ./.vscode/settings.json and ${dim(CLI_SETTINGS_PATH)}.
${bold('API keys')} \${env:NAME} works everywhere. Keys VS Code keeps in your OS keychain (\${secret:id}) are read here from
${dim(CLI_KEYS_PATH)} (set with \`localpilot providers key <id>\`) or LOCALPILOT_KEY_<ID>.
Log: ${dim(LOG_FILE)}`;

// ------------------------------------------------------------------ args
interface Args {
  prompt: string;
  mode: Session['mode'];
  /** --auto: each message picks its own mode from what it asks. */
  auto?: boolean;
  model?: string;
  files: string[];
  yes: boolean;
  cwd: string;
  print: boolean;
  mcp: boolean;
  /** Apply security-sensitive settings from the workspace's .vscode/settings.json. */
  trustWorkspace?: boolean;
  verbose: boolean;
  cmd?: 'models' | 'doctor' | 'ide' | 'settings' | 'setup' | 'help' | 'version' | 'skill-install' | 'skill-search' | 'providers' | 'eval' | 'work' | 'scan' | 'plugin' | 'history' | 'config' | 'mcp' | 'acp' | 'recovery';
  /** `mcp …`: the words after `mcp` (it parses its own flags). */
  mcpArgv?: string[];
  /** `--json` without a file: NDJSON events for one-shot runs, JSON output for `config` and `doctor`. */
  json?: boolean;
  /** Headless runs: overall time limit (ms), mistake limit, and the `--yolo` preset (`--mcp` keeps MCP with it). */
  timeoutMs?: number;
  retries?: number;
  yolo?: boolean;
  mcpFlag?: boolean;
  /** `-s/--system`: text added to the system prompt, or used instead of the persona with `--system-replace`. */
  system?: string;
  systemReplace?: boolean;
  /** `-P/--provider`: provider for this run; `-k/--key` its key (`--save-key` stores it). */
  runProvider?: string;
  saveKey?: boolean;
  /** `history [list|delete|export]`: JSON output, rows shown, export file. */
  historyOpts: { json: boolean; limit: number; output?: string };
  /** `-c`: continue the newest saved session. `-r [id]`: resume one (`true` = pick from a list). */
  continue: boolean;
  resume?: string | true;
  /** `--data-dir`: root of the saved sessions instead of ~/.localpilot. */
  dataDir?: string;
  /** `--hooks-dir` (repeatable): more folders of hook scripts named after their event. */
  hooksDirs?: string[];
  /** `plugin <action>`: search, install, remove, enable, disable, list, new, validate, marketplaces. */
  pluginAction?: string;
  /** `plugin install --project`: into the workspace's .localpilot/plugins instead of ~/.localpilot/plugins. */
  project: boolean;
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
  /** `--thinking [level]`: this session's thinking level (a bare flag = medium). */
  thinking?: ThinkChoice;
  /** `--require-verified`: a done-but-unverified run exits 4 (incomplete). */
  requireVerified?: boolean;
  /** `recovery resume <id>`: this run is the resume turn of an interrupted / unfinished recovery. */
  recoveryResume?: boolean;
  /** A usage error found while parsing (unknown option, bad value): main prints it and exits 2. */
  error?: string;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { prompt: '', mode: 'agent', files: [], yes: false, cwd: process.cwd(), print: false, mcp: true, verbose: false, user: false, install: false, isolate: false, apply: true, provider: {}, evalOpts: { models: [], tasks: [], keep: false }, workOpts: { once: false }, scanOpts: { failOn: 'high', offline: false }, project: false, historyOpts: { json: false, limit: 50 }, continue: false };
  const words: string[] = [];
  // `--name=value` is the same as `--name value` (up to a `--`, after which everything is prompt text).
  const end = argv.indexOf('--');
  argv = argv.flatMap((x, i) => ((end < 0 || i < end) && /^--[\w-]+=/.test(x) ? [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)] : [x]));
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i] ?? '';
    if (x === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (x === '--auto') {a.auto = true;}
    else if (x === '--ask') {a.mode = 'ask';}
    else if (x === '--plan') {a.mode = 'plan';}
    else if (x === '--multitask') {a.mode = 'multitask';}
    else if (x === '--debug') {a.mode = 'debug';}
    else if (x === '--isolate' || x === '-i') {a.isolate = true;}
    else if (x === '--no-apply') {a.apply = false;}
    else if (x === '--agent') {a.mode = 'agent';}
    else if (x === '-m' || x === '--model') {a.model = next();}
    // The level is optional: `--thinking "fix the bug"` thinks at medium and keeps the prompt.
    else if (x === '--thinking') {const v = argv[i + 1]; const lvl = v && !v.startsWith('-') ? parseThinkChoice(v) : undefined; if (lvl) {i++;} a.thinking = lvl ?? 'medium';}
    else if (x === '-f' || x === '--file') {a.files.push(next());}
    else if (x === '-y' || x === '--yes') {a.yes = true;}
    else if (x === '-C' || x === '--cwd') {a.cwd = path.resolve(next());}
    else if (x === '-p' || x === '--print') {a.print = true;}
    else if (x === '--no-mcp') {a.mcp = false;}
    else if (x === '--trust-workspace') {a.trustWorkspace = true;}
    else if (x === '-v' || x === '--verbose') {a.verbose = true;}
    else if (x === '--ide' || x === '--vscode') {a.cmd = 'ide';}
    else if (x === '--settings') {a.cmd = 'settings';}
    else if (x === '--acp') {a.cmd = 'acp';}
    else if (x === '--setup') {a.cmd = 'setup';}
    else if (x === '-h' || x === '--help') {a.cmd = 'help';}
    else if (x === '--version' || x === '-V') {a.cmd = 'version';}
    else if (x === '--parallel') {a.cmd = a.cmd ?? 'ide';} // parallel sessions live in the editor's Agents panel
    else if (x === '-P' || x === '--provider') {a.runProvider = next().toLowerCase();}
    else if (x === '--save-key') {a.saveKey = true;}
    else if (x === '-s' || x === '--system') {a.system = next();}
    else if (x === '--system-replace') {a.systemReplace = true;}
    else if (x === '--timeout') {const v = next(); a.timeoutMs = parseDuration(v); if (!a.timeoutMs) {a.error = a.error ?? `--timeout takes a duration in seconds (90, 90s, 5m; got "${v}")`;}}
    else if (x === '--retries') {const v = next(); if (/^\d+$/.test(v)) {a.retries = Number(v);} else {a.error = a.error ?? `--retries takes a number (got "${v}")`;}}
    else if (x === '--yolo') {a.yolo = true;}
    else if (x === '--mcp') {a.mcpFlag = true;}
    else if (x === 'config' && !words.length && !a.cmd) {a.cmd = 'config';}
    else if (x === '--user' || x === '-u') {a.user = true;}
    else if (x === '--install') {a.install = true;}
    else if (x === '--key' || x === '-k') {a.provider.key = next();}
    else if (x === '--key-env') {a.provider.keyEnv = next();}
    else if (x === '--remove-key') {a.provider.removeKey = true;}
    else if (x === '--url') {a.provider.url = next();}
    else if (x === '--region') {a.provider.region = next();}
    else if (x === '--id') {a.provider.id = next();}
    else if (x === '--type') {a.provider.type = next();}
    else if (x === '--name') {a.provider.name = next();}
    else if (x === '--cloud') {a.provider.cloud = true;}
    else if (x === '--no-cloud') {a.provider.cloud = false;}
    else if (x === 'eval' && !words.length && !a.cmd) {a.cmd = 'eval';}
    else if (x === 'work' && !words.length && !a.cmd) {a.cmd = 'work';}
    else if (x === 'scan' && !words.length && !a.cmd) {a.cmd = 'scan';}
    else if (x === 'plugin' && !words.length && !a.cmd) {a.cmd = 'plugin'; a.pluginAction = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'list';}
    else if (x === '--project') {a.project = true;}
    else if (x === '--fail-on') {
      const v = next();
      if (['low', 'medium', 'high', 'critical', 'none'].includes(v)) {
        a.scanOpts.failOn = v as Args['scanOpts']['failOn'];
      } else {
        a.error = a.error ?? `--fail-on must be one of low, medium, high, critical, none${v ? ` (got "${v}")` : ''}`;
      }
    }
    else if (x === '--sarif') {a.scanOpts.sarif = next();}
    else if (x === '--offline') {a.scanOpts.offline = true;}
    else if (x === '--once') {a.workOpts.once = true;}
    else if (x === '--max') {a.workOpts.max = Math.max(1, Number(next()) || 1);}
    else if (x === '--models') {a.evalOpts.models.push(...next().split(',').map((m) => m.trim()).filter(Boolean));}
    else if (x === '--suite') {a.evalOpts.suite = next();}
    else if (x === '--tasks') {a.evalOpts.tasks.push(...next().split(',').map((t) => t.trim()).filter(Boolean));}
    else if (x === '--keep') {a.evalOpts.keep = true;}
    else if (x === '--json' && a.cmd === 'history') {a.historyOpts.json = true;}
    else if (x === '--limit') {a.historyOpts.limit = Math.max(1, Math.floor(Number(next())) || 50);}
    else if (x === '-o' || x === '--output') {a.historyOpts.output = next();}
    else if (x === '-c' || x === '--continue') {a.continue = true;}
    // `-r` takes an id (or list number) only when one follows; `-r "fix the bug"` is a picker plus a task.
    else if (x === '-r' || x === '--resume') {a.resume = /^(?:cli-|s_)[0-9a-z]+$|^\d{1,4}$/i.test(argv[i + 1] ?? '') ? next() : true;}
    else if (x === '--data-dir') {a.dataDir = path.resolve(next());}
    else if (x === '--hooks-dir') {(a.hooksDirs ??= []).push(path.resolve(next()));}
    else if (x === '--compaction') {const v = next(); if (/^(agentic|basic|off)$/.test(v)) {cliOverrides['compaction.strategy'] = v;} else {a.error = `--compaction takes agentic, basic or off (got "${v}")`;}}
    else if (x === 'history' && !words.length && !a.cmd) {a.cmd = 'history';}
    else if (x === 'recovery' && !words.length && !a.cmd) {a.cmd = 'recovery';}
    else if (x === '--require-verified') {a.requireVerified = true;}
    // `eval`/`scan --json out.json` write a report file; anywhere else `--json` is a flag (NDJSON for runs, JSON output).
    else if (x === '--json' && (a.cmd === 'eval' || a.cmd === 'scan') && /\.json$|[/\\]/i.test(argv[i + 1] ?? '')) {a.evalOpts.json = next(); a.scanOpts.json = a.evalOpts.json;}
    else if (x === '--json') {a.json = true;}
    else if (x === 'providers' && !words.length && !a.cmd) {a.cmd = 'providers';}
    else if (x === 'mcp' && !words.length && !a.cmd) {a.cmd = 'mcp'; a.mcpArgv = argv.slice(i + 1); break;}
    else if (x === 'skill' && !words.length && !a.cmd && ['search', 'find'].includes(argv[i + 1] ?? '')) {a.cmd = 'skill-search'; i++;}
    else if (x === 'skill' && !words.length && !a.cmd && ['install', 'add'].includes(argv[i + 1] ?? '')) {a.cmd = 'skill-install'; i++;}
    else if (!x.startsWith('-') && !words.length && !a.cmd && ['models', 'doctor', 'help', 'version'].includes(x)) {a.cmd = x as Args['cmd'];}
    else if (x.startsWith('-') && x.length > 1) {a.error = a.error ?? `unknown option ${x}`;}
    else {words.push(x);}
  }
  a.prompt = words.join(' ').trim();
  if (a.yolo) {
    a.yes = true;
    a.retries ??= 3;
    a.mcp = !!a.mcpFlag && a.mcp;
  }
  if (a.retries !== undefined) {
    cliOverrides.maxConsecutiveMistakes = a.retries;
  }
  return a;
}

// ------------------------------------------------------------------ VS Code hand-off (previous CLI behaviour)
function openInVsCode(pathname: string, params: Record<string, string>, cwd: string): never {
  const cp = require('child_process') as typeof import('child_process');
  const crypto = require('crypto') as typeof import('crypto');
  const extra: Record<string, string> = { v: '2' };
  if (pathname === 'run') {
    // The extension trusts a run request only through this one-time file; a bare link (from a web page) asks first.
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(os.homedir(), '.localpilot', 'handoff');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...params, at: Date.now() }), { mode: 0o600 });
    extra.id = id;
  }
  // Values are encoded twice: VS Code decodes the query once before the handler splits it on '&'.
  const q = Object.entries({ ...params, ...extra }).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(encodeURIComponent(v))}`).join('&');
  const url = `vscode://localpilot.localpilot-agent/${pathname}${q ? `?${q}` : ''}`;
  // On Windows the launcher is a .cmd that needs cmd.exe; every argument is quoted so the '&' in the query does not split the command.
  const launch = (bin: string) => process.platform === 'win32'
    ? cp.spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[bin, '--open-url', url, cwd].map((a) => `"${a}"`).join(' ')}"`], { stdio: 'inherit', windowsVerbatimArguments: true })
    : cp.spawnSync(bin, ['--open-url', url, cwd], { stdio: 'inherit' });
  // A shim installed by an older version may point at a launcher that does not exist.
  const configured = process.env.LOCALPILOT_CODE_BIN;
  let code = configured && fs.existsSync(configured) ? configured : 'code';
  let r = launch(code);
  // cmd.exe reports a missing program as exit status 9009 instead of ENOENT.
  if (code !== 'code' && ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || (process.platform === 'win32' && r.status === 9009))) {
    code = 'code';
    r = launch(code);
  }
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
  private running = new Map<string, { label: string; start: number; tail?: string; healing?: boolean }>();
  /** The last rows printed were self-healing verification commands (grouped under one `verification` heading). */
  private verifying = false;
  thinking = 0;
  constructor(private readonly verbose: boolean, readonly quiet: boolean) {}

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
    this.verifying = false;
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
  /** `healing`: a self-healing check the engine ran (not the model): dimmed, indented under a `verification` heading. */
  toolStart(id: string, name: string, args: Record<string, unknown>, healing = false): void {
    if (this.quiet) {
      return;
    }
    this.clearStatus();
    this.flushPending();
    this.breakLine();
    const label = toolLabel(name, args);
    this.running.set(id, { label, start: Date.now(), healing });
    if (healing && !this.verifying) {
      process.stdout.write(`  ${dim('verification')}\n`);
    }
    this.verifying = healing;
    process.stdout.write(`${healing ? '    ' : '  '}${dim('⟳')} ${dim(label)}${this.verbose ? ` ${dim(JSON.stringify(args).slice(0, 200))}` : ''}\n`);
  }
  /** Live run_command output: its latest line on the status line, with the detach hint. */
  toolOutput(id: string, chunk: string): void {
    const r = this.running.get(id);
    if (this.quiet || !r) {
      return;
    }
    r.tail = `${r.tail ?? ''}${chunk}`.slice(-2000);
    const last = r.tail.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    this.status(`${last || 'running…'}${tty ? '  (Ctrl+B: proceed while it runs)' : ''}`);
  }
  toolEnd(id: string, name: string, isError: boolean, content: string, data: unknown, cached?: boolean, healing = false): void {
    if (this.quiet) {
      return;
    }
    const r = this.running.get(id);
    this.running.delete(id);
    const dur = r ? Date.now() - r.start : 0;
    const meta = cached ? dim(' cached') : dur > 800 ? dim(` ${(dur / 1000).toFixed(1)}s`) : '';
    if (healing || r?.healing) {
      // Only the verdict and, for a failure, the tail of the output: the engine extracts the evidence for the model.
      if (tty && r && this.verifying) {
        process.stdout.write('\x1b[1A\x1b[2K');
      }
      process.stdout.write(`    ${isError ? red('✗') : dim('✓')} ${dim(r?.label ?? name)}${meta}\n`);
      if (isError && content) {
        const lines = content.replace(/^\$ .*\n/, '').replace(/\n\[exit code [^\]]*\]$/, '').split('\n').filter((l) => l.trim());
        process.stdout.write(lines.slice(-8).map((l) => `      ${dim('│')} ${dim(l)}`).join('\n') + (lines.length ? '\n' : ''));
      }
      this.verifying = true;
      return;
    }
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
    this.verifying = false;
    const done = items.filter((t) => t.status === 'done').length;
    process.stdout.write(`  ${amber('☰')} ${bold(`Plan ${done}/${items.length}`)}\n${items.map((t) => `    ${t.status === 'done' ? green('✓') : t.status === 'in_progress' ? amber('▸') : t.status === 'skipped' ? dim('–') : dim('○')} ${t.status === 'done' ? dim(t.title) : t.title}`).join('\n')}\n`);
  }
  note(s: string): void {
    if (this.quiet) {
      // --print / piped: stdout must carry the answer only, so advisory notes go to stderr (--json: only JSON there).
      if (!ndjson) {
        process.stderr.write(`  ${dim(s)}\n`);
      }
      return;
    }
    this.clearStatus();
    this.flushPending();
    this.breakLine();
    this.verifying = false;
    process.stdout.write(`  ${dim(s)}\n`);
  }
  /** Pre-styled lines (the self-healing outcome block): stdout, or stderr in --print / piped runs (nothing with --json). */
  block(lines: string[]): void {
    if (!lines.length || ndjson) {
      return;
    }
    if (this.quiet) {
      process.stderr.write(`${lines.map((l) => `  ${l}`).join('\n')}\n`);
      return;
    }
    this.clearStatus();
    this.flushPending();
    this.breakLine();
    this.verifying = false;
    process.stdout.write(`\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
  }
  error(s: string): void {
    if (ndjson) {
      return; // written as an NDJSON error record
    }
    this.clearStatus();
    this.flushPending();
    this.breakLine();
    (this.quiet ? process.stderr : process.stdout).write(`${red('✖')} ${s}\n`);
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
    case 'read_file': return Array.isArray(a.files) ? `Read ${a.files.length} files: ${s(a.files.map((f: unknown) => (f && typeof f === 'object' ? (f as { path?: unknown }).path : f)).join(', '))}` : `Read ${s(a.path)}${a.start_line ? ` (lines ${a.start_line}–${a.end_line ?? ''})` : ''}`;
    case 'read_pdf': return `Read PDF ${s(a.path)}${a.pages ? ` (pages ${s(a.pages)})` : ''}`;
    case 'edit_file': return `Edit ${s(a.path)}`;
    case 'apply_patch': return `Patch ${s(patchSummary(patchArg(a)))}`;
    case 'write_file': return `Write ${s(a.path)}`;
    case 'notebook_edit': return `${s(a.action || 'Edit')} cell ${s(a.cell)} of ${s(a.path)}`;
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
    case 'team_board': return `Board: ${s(a.action)}${a.id ? ` ${s(a.id)}` : ''}${a.title ? ` "${s(a.title, 60)}"` : ''}${a.to ? ` to ${s(a.to, 40)}` : ''}`;
    case 'schedule': return `Schedule: ${s(a.action)}${a.name ? ` ${s(a.name)}` : ''}${a.cron ? ` (${s(a.cron)})` : ''}`;
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
    case 'mcp_read_resource': return `Read ${s(a.uri)} from ${s(a.server)}`;
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
  /** Saved sessions of this folder (shared with VS Code's history); chats in it are written after every turn. */
  store?: SessionStore;
  telemetry: Telemetry;
  /** Optional Redis store behind `telemetry`; its socket must be closed for the process to exit. */
  telemetryRemote?: RedisTelemetry;
  /** Merged settings.json (permission rules, hooks) for the working folder. */
  settings: ProjectSettings;
  plugins: PluginInfo[];
  /** Custom slash commands (.claude/commands, .localpilot/commands, plugins), by `/name`. */
  commands: CustomCommand[];
  /** Self-healing: the service the runner uses and its recovery store (`~/.localpilot/recovery`). */
  healing: CliHealing;
}

/** Stop what keeps the process alive (MCP servers, Redis telemetry) after a subcommand or one-shot run. */
async function shutdown(core: Core): Promise<void> {
  core.mcp?.dispose();
  await core.telemetry.flush().catch(() => undefined);
  core.telemetryRemote?.dispose();
}

/** Earlier CLI versions kept global notes one level too deep (`memory/memory`): move them up (best effort). */
function migrateGlobalMemory(dir: string): void {
  const old = path.join(dir, 'memory');
  try {
    if (!fs.statSync(old).isDirectory()) {
      return;
    }
    for (const f of fs.readdirSync(old)) {
      if (f.endsWith('.md') && !fs.existsSync(path.join(dir, f))) {
        try {
          fs.renameSync(path.join(old, f), path.join(dir, f));
        } catch {
          // leave it where it is
        }
      }
    }
    fs.rmdirSync(old); // only when it is empty now
  } catch {
    // nothing to migrate
  }
}

async function boot(args: Args, emit: (e: AgentEvent) => void, approve: (sid: string, title: string, detail: string, kind: string, opts?: { mandatory?: boolean }) => Promise<boolean | ApprovalDecision>): Promise<Core> {
  const log = vscode.window.createOutputChannel('LocalPilot CLI', { log: true });
  const providers = new ProviderRegistry(log);
  // A run that needs a model on a local Ollama that is installed but stopped starts it (same as in VS Code).
  providers.startLocalServer = async (p) => {
    if (p.type !== 'ollama' || !isLoopbackUrl(p.baseUrl) || !(await findOllamaBinary())) {
      return undefined;
    }
    const base = p.baseUrl.replace(/\/+$/, '');
    process.stderr.write(dim(`Starting Ollama at ${base}…\n`));
    const cfg = getConfig();
    const r = await launchOllama({
      baseUrl: base,
      up: () => createProvider({ id: 'probe', type: 'ollama', baseUrl: base }).healthCheck().catch(() => false),
      env: ollamaServerEnv({ maxConcurrency: cfg.parallel.maxConcurrency, flashAttention: cfg.ollama.flashAttention, kvCacheType: cfg.ollama.kvCacheType }),
    });
    if (!r.ok && r.pid) {
      try {
        process.kill(r.pid);
      } catch {
        // already gone
      }
    }
    process.stderr.write(r.ok ? dim('Ollama is running.\n') : `${red('✖')} Could not start Ollama: ${r.error ?? 'unknown error'}\n`);
    return r.ok;
  };
  const tools = new ToolRegistry();
  const skills = new SkillManager(log, path.join(__dirname, '..', 'skills'));
  const workspace = new WorkspaceContext(log);
  const tracker = new ChangeTracker(log);
  migrateGlobalMemory(path.join(os.homedir(), '.localpilot', 'memory'));
  const memory = new MemoryStore(vscode.Uri.file(path.join(os.homedir(), '.localpilot')), log, () => getConfig().memoryLimits);
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
  setTelemetryRecorder(telemetry);
  // Opt-in OTLP export (settings or OTEL_* variables); `shutdown` flushes it with the rest of the telemetry.
  attachOtlp(telemetry, { settings: () => getConfig().telemetry.otlp, version: VERSION, out: (l) => process.stderr.write(`${dim(l)}\n`), warn: (m) => process.stderr.write(`\x1b[33m!\x1b[0m ${m}\n`) });
  runner.telemetry = telemetry;
  providers.telemetry = telemetry;
  // Same checkpoints as in VS Code: a git ref before each turn, file snapshots under ~/.localpilot/checkpoints.
  const lpHome = path.join(os.homedir(), '.localpilot');
  tracker.persistDir = path.join(lpHome, 'checkpoints');
  // Detached commands log to ~/.localpilot/cmd-logs and die with the CLI: their output pipes end with it.
  setCommandLogDir(path.join(lpHome, 'cmd-logs'));
  pruneCommandLogs();
  process.once('exit', () => stopAllCommands());
  const checkpoints = new CheckpointService({ globalStorageDir: lpHome, enabled: () => getConfig().checkpointsEnabled, log, defaultRoot: () => args.cwd });
  runner.checkpoints = checkpoints;
  void (async () => {
    checkpoints.pruneScratch();
    pruneSnapshotDirs(tracker.persistDir!, (sid) => isOrphanCheckpoint(sid, undefined));
    await checkpoints.pruneRefs(args.cwd, (sid, last) => isOrphanCheckpoint(sid, undefined, Date.now(), last));
  })().catch((e) => log.warn(`checkpoint prune: ${String(e)}`));
  // Claude Code-compatible project configuration: settings.json, plugins, custom commands (both .claude and .localpilot).
  const roots = [args.cwd];
  let settings = await loadProjectSettings(roots, { log, hookDirs: args.hooksDirs });
  const plugins = await discoverPlugins(roots, { extraDirs: getConfig().pluginPaths, enabledPlugins: settings.enabledPlugins });
  const pluginParts = pluginSource(plugins);
  const pluginLayers = pluginParts.settingsLayers();
  if (pluginLayers.length) {
    settings = await loadProjectSettings(roots, { log, extra: pluginLayers, hookDirs: args.hooksDirs });
  }
  runner.projectSettings = () => settings;
  runner.hooks = new HookRunner(() => (getConfig().hooksEnabled ? settings : { ...settings, hooks: {} }), log, (text) => process.stderr.write(`${dim('hook:')} ${text}\n`));
  skills.plugins = pluginParts;
  const commands = await discoverCommands(roots, { plugins: pluginParts, log });
  const sessions = new Map<string, Session>();
  // No language server in the terminal: these would silently report nothing, so point the model at real checks instead.
  const noLsp = new Set(['get_diagnostics', 'find_symbol', 'find_references']);
  const termOnly = (list: typeof editorTools) => list.map((t) => (noLsp.has(t.definition.name) ? { ...t, execute: async () => ({ content: "Not available in the terminal (no language server). Run the project's type checker, linter or tests with run_command (e.g. npx tsc --noEmit, eslint, pytest); use grep_search or repo_graph for definitions and references.", isError: true }) } : t));
  tools.registerAll([...fsTools, ...notebookTools, applyPatchTool, ...pdfTools, ...termOnly(searchTools), ...terminalTools, ...termOnly(editorTools), ...webTools, browserScreenshotTool, browserInspectTool, ...createMemoryTools(memory), manageTodosTool, createGatherContextTool(workspace, sessions), createAnalyzeWorkspaceTool(() => getConfig().parallel.maxConcurrency), repoGraphTool, ...gitTools, teamBoardTool, reposTool, securityScanTool]);
  tools.registerAll(createAgentTools(runner, skills, emit, approve));
  tools.registerAll([createScheduleTool(() => cliLauncher())]);
  await skills.refresh();
  let mcp: McpManager | undefined;
  const pluginMcp = pluginParts.mcpServers();
  if (args.mcp && (Object.keys(getConfig().mcpServers).length || Object.keys(pluginMcp).length || (await loadMcpFiles(roots)).some((l) => Object.keys(l.servers).length || l.problems.length))) {
    mcp = new McpManager(tools, log, VERSION);
    mcp.extraServers = () => pluginMcp;
    mcp.projectFolders = () => roots;
    mcp.trust = cliMcpTrust(args.cwd, () => !!args.trustWorkspace, { prompt: (q) => withPromptLock(() => ask(`${yellow('?')} ${q}`)) });
    mcp.oauth = cliMcpOAuth((m) => log.info(m));
    mcp.onFileProblems = (file, problems) => (ndjson ? ndjson.error(`invalid MCP configuration in ${file}: ${problems.join('; ')}`, { kind: 'mcp_config', file, problems }) : process.stderr.write(`${yellow('!')} invalid MCP configuration in ${file}:\n${problems.map((p) => `  ${p}`).join('\n')}\n`));
    await mcp.reload();
  }
  const healing = cliHealing(args, { log, telemetry, tracker, providers, mcp: () => mcp, approve: (title, detail, kind) => approve('', title, detail, kind).then((d) => toDecision(d).ok) });
  runner.healing = healing.service;
  return { providers, tools, skills, workspace, tracker, memory, runner, catalog, mcp, log, sessions, telemetry, telemetryRemote: redis, settings, plugins, commands, healing };
}

/** Workspace trust as the settings shim sees it: `--trust-workspace` or LOCALPILOT_TRUST_WORKSPACE=1 (untrusted by default). */
function workspaceTrusted(args: Pick<Args, 'trustWorkspace'>): boolean {
  return !!args.trustWorkspace || process.env.LOCALPILOT_TRUST_WORKSPACE === '1';
}

/** The self-healing service over the CLI's providers, MCP servers and change tracker (recovery state in ~/.localpilot/recovery). */
function cliHealing(args: Args, d: { log: vscode.LogOutputChannel; telemetry?: Telemetry; tracker?: ChangeTracker; providers?: ProviderRegistry; mcp?: () => McpManager | undefined; approve?: (title: string, detail: string, kind: string) => Promise<boolean> }): CliHealing {
  return createCliHealing({
    cwd: args.cwd,
    config: () => getConfig().healing,
    log: d.log,
    telemetry: d.telemetry,
    isTrusted: () => workspaceTrusted(args),
    approve: d.approve ?? (async () => false),
    mcpRestart: async (server) => {
      const m = d.mcp?.();
      return m ? m.restart(server) : false;
    },
    provider: d.providers && ((id) => d.providers!.get(id)),
    settle: d.tracker && ((sid) => d.tracker!.settle(sid)),
    writers: d.tracker && (() => d.tracker!.all()),
    audit: (event) => auditPolicy(getManagedPolicy(), event, args.cwd, d.log),
  });
}

/** Stops the run in progress with the `shutdown` reason, waits (bounded) for it to persist its state, then exits. */
async function stopForShutdown(core: Core, code: number): Promise<never> {
  shutdownCode = code;
  const run = liveRun;
  if (run) {
    run.control.stop('shutdown');
    await Promise.race([run.done.catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
    // The run's own save comes after its hooks settle, which can outlast the wait above: save the chat here too, so a
    // closed terminal or a cancelled CI job never loses it (`localpilot -c` and `recovery resume` need it).
    if (core.store?.has(run.session.id)) {
      core.store.save(run.session);
      await core.store.flush(run.session).catch(() => undefined);
    }
  }
  await core.healing.store.flush().catch(() => undefined);
  core.mcp?.dispose();
  process.exit(code);
}

function newSession(mode: Session['mode'], model: string): Session {
  const now = Date.now();
  return { id: `cli-${now.toString(36)}`, title: 'CLI session', createdAt: now, updatedAt: now, model, mode, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [], todos: [], workingSet: [] };
}

/** The signal of the run in progress, for approvals asked by subagents (they go through boot's callback). */
let activeSignal: AbortSignal | undefined;
/** Whether the last runTurn reached a final answer (false when it stopped at the step limit). */
let lastTurnCompleted = true;
/** Whether the last runTurn's turn_end said `completed: true` (a hook-blocked prompt or a stop leaves it false). */
let lastTurnAnswered = false;
/** The error the last runTurn ended with (an error event of the main run), for exit codes and `run_result`. */
let lastTurnError: { message: string; kind?: string } | undefined;
/** `--json` one-shot runs: every event also goes out as NDJSON. */
let ndjson: NdjsonWriter | undefined;
/** The self-healing verdict of the last runTurn (turn_end `outcome` / `contract`); `ended` is false when it threw before turn_end. */
let lastTurnHealing: { ended: boolean; outcome?: string; contract?: CompletionContract } = { ended: false };
/** The run in progress, so a hangup / SIGTERM can stop it as a shutdown (its recovery stays resumable) and wait for it. */
let liveRun: { control: RunControl; done: Promise<unknown>; session: Session } | undefined;
/** Set when SIGHUP / SIGTERM is shutting the CLI down: the run's normal ending must not exit with its own code first. */
let shutdownCode: number | undefined;

/** A failure outside the run: an `{type:'error', kind}` record with --json, else `✖ message` (and a hint) on stderr. */
function reportError(message: string, kind: string, hint?: string): void {
  if (ndjson) {
    ndjson.error(message, { kind });
  } else {
    console.error(`${red('✖')} ${message}${hint ? `\n${dim(hint)}` : ''}`);
  }
}
let lastTurnKey = 0;

/** Kinds of action the user answered "always" for in this session (never deletes or destructive commands). */
const alwaysKinds = new Set<string>();
/** --print / piped runs: prompts go to stderr so stdout carries the answer only. */
let promptToStderr = false;
/** -p is non-interactive: approvals are denied (unless --yes) and ask_user takes the recommendations. */
let printMode = false;
/** --yes was passed (an "always" answer does not stop ask_user from asking). */
let yesMode = false;
const KIND: Record<string, string> = { terminal: 'terminal', write: 'file edit', delete: 'delete', network: 'network', mcp: 'MCP tool' };

async function approvalDecision(title: string, detail: string, kind: string, rl?: readline.Interface, signal?: AbortSignal, opts?: { mandatory?: boolean }): Promise<boolean | ApprovalDecision> {
  // A prompt the organization's policy requires (a floor for this kind, or no bypassing at all) is never answered by --yes or an earlier "always".
  const managed = getManagedPolicy();
  const mandatory = !!opts?.mandatory || !!managed.approvals[kind as keyof typeof managed.approvals] || managed.disableBypassPermissions;
  const rememberable = kind !== 'delete' && !/destructive/i.test(title);
  const preApproved = () => !mandatory && (isAutoApprove() || (rememberable && alwaysKinds.has(kind)));
  if (preApproved()) {
    return true;
  }
  const out = promptToStderr ? process.stderr : process.stdout;
  // Refusals nobody typed are a bare `false`: the agent loop counts them as failed calls, not as a user's denial.
  if (printMode) {
    process.stderr.write(`${yellow('!')} ${title} — denied (-p is non-interactive${mandatory ? '' : '; pass --yes'})\n`);
    return false;
  }
  if (!process.stdin.isTTY) {
    out.write(`${yellow('!')} ${title} — denied (${mandatory ? `your organization's policy requires an answer${isAutoApprove() ? ' even with --yes' : ''}; no TTY` : 'no TTY; pass --yes to auto-approve'})\n`);
    return false;
  }
  // One prompt at a time: the block printed is the one being answered, and an "always" answer covers the queued ones.
  return withPromptLock(async () => {
    if (preApproved()) {
      return true;
    }
    if (signal?.aborted) {
      return false;
    }
    const body = detail.split('\n').slice(0, 24).map((l) => `  ${dim('│')} ${l}`).join('\n');
    out.write(`\n${yellow('!')} ${bold(title)} ${dim(`(${KIND[kind] ?? kind})`)}\n${body}${detail.split('\n').length > 24 ? `\n  ${dim('│ …')}` : ''}\n`);
    setReadline(rl);
    const a = (await ask(`  ${amber('Allow?')} ${dim(mandatory ? '[y]es · [n]o' : rememberable ? `[y]es · [n]o · [a]lways allow ${KIND[kind] ?? kind} this session` : '[y]es · [n]o')} ${dim('· n <reason> tells the agent why')} `, signal))?.trim() ?? 'n';
    const answer = parseApprovalAnswer(a);
    if (!mandatory && answer.choice === 'always') {
      if (rememberable) {
        alwaysKinds.add(kind);
      }
      return true;
    }
    // `n use src/b.ts instead`: the reason reaches the model in place of a bare refusal.
    return answer.choice === 'yes' ? true : { ok: false, feedback: answer.feedback };
  });
}

/** A yes/no approval (plugin installs and other callers that take no reason). */
async function approval(title: string, detail: string, kind: string, rl?: readline.Interface, signal?: AbortSignal, opts?: { mandatory?: boolean }): Promise<boolean> {
  return toDecision(await approvalDecision(title, detail, kind, rl, signal, opts)).ok;
}

/**
 * ask_user in the terminal: numbered options with their explanations; answer with numbers ("2", "1,3" for multi-select)
 * or your own words, Enter takes the recommended option. Ctrl+D skips (the agent goes with its recommendations).
 */
async function askQuestions(questions: UserQuestion[], rl?: readline.Interface, signal?: AbortSignal): Promise<UserAnswer[] | null> {
  return withPromptLock(() => askQuestionsNow(questions, rl, signal));
}

async function askQuestionsNow(questions: UserQuestion[], rl: readline.Interface | undefined, signal: AbortSignal | undefined): Promise<UserAnswer[] | null> {
  setReadline(rl);
  const answers: UserAnswer[] = [];
  for (const [i, q] of questions.entries()) {
    if (signal?.aborted) {
      return null;
    }
    const n = questions.length > 1 ? dim(` (${i + 1}/${questions.length})`) : '';
    const opts = q.options.map((o, k) => `  ${amber(String(k + 1))}. ${bold(o.label)}${o.label === q.recommended ? ` ${amber('(recommended)')}` : ''}${o.description ? `\n     ${dim(o.description)}` : ''}`).join('\n');
    const hint = q.options.length ? dim(`${q.multiSelect ? 'numbers separated by commas' : 'a number'}, or your own words${q.recommended ? ' · Enter = recommended' : ''}`) : dim('your answer');
    (promptToStderr ? process.stderr : process.stdout).write(`\n${yellow('?')}${n} ${q.header ? `${dim(`[${q.header}]`)} ` : ''}${bold(q.question)}\n${opts}${opts ? '\n' : ''}  ${hint}\n`);
    const a = await ask('  > ', signal);
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

async function runTurn(core: Core, session: Session, text: string, files: string[], r: Renderer, rl: readline.Interface | undefined, control: RunControl, opts: { modelRef?: string; permissionAllow?: string[]; display?: string; images?: string[]; toolFilter?: string[]; roleOverride?: string; resume?: boolean } = {}): Promise<string> {
  let content = text;
  const root = session.worktree ? path.join(session.worktree.path, session.worktree.subdir ?? '') : undefined;
  const blocks = await Promise.all(files.map((f) => core.workspace.readAttachment(f, root, { query: text })));
  if (blocks.some(Boolean)) {
    content = `${blocks.filter(Boolean).join('\n\n')}\n\n${text}`;
  }
  // Increasing turn keys, recorded on the message, so /undo can find a turn's checkpoint after compaction or a resume.
  const checkpoint = (lastTurnKey = nextTurnKey(session, lastTurnKey));
  const userMessage: ChatMessage = { role: 'user', content, ...(opts.images?.length ? { images: opts.images } : {}), meta: { checkpoint, ...(opts.display ? { display: opts.display } : {}) } };
  // Auto mode (--auto, /mode auto): this message picks its mode, specialist and, with an Auto model, its model role.
  let auto: TaskRoute | undefined;
  if (session.autoMode && !opts.resume && !opts.display && !opts.roleOverride) {
    auto = classifyTask({ text, images: opts.images?.length ?? 0, attachments: files.length, hasFolder: true });
    session.mode = auto.mode;
    session.specialist = auto.specialist;
    userMessage.meta = { ...userMessage.meta, autoRoute: { mode: auto.mode, ...(auto.specialist ? { specialist: auto.specialist } : {}), kind: auto.kind, reason: auto.reason } };
    r.note(`Auto → ${autoLabel(auto)} · ${auto.reason}`);
  }
  core.tracker.beginTurn(session.id, checkpoint);
  activeSignal = control.signal;
  const usageBefore = session.usage && { ...session.usage };
  let final = '';
  lastTurnCompleted = true;
  lastTurnAnswered = false;
  lastTurnError = undefined;
  lastTurnHealing = { ended: false };
  /** The newest `recovery` card of the main run, and the turn_end recovery summary, for the outcome block. */
  let recovery: RecoveryEventPayload | undefined;
  let summary: RecoverySummary | undefined;
  const notes = new RecoveryNotes(STYLE);
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
  let result: string;
  const turnStarted = Date.now();
  const rootSid = ChangeTracker.rootSession(session.id);
  core.healing.live.add(rootSid);
  try {
    const run = core.runner.run({
      session,
      userMessage,
      resume: opts.resume,
      // Nobody can answer a prompt (piped or -p without --yes): installs are not attempted and the task is reported blocked.
      unattended: (!process.stdin.isTTY || printMode) && !yesMode,
      modelRef: opts.modelRef,
      ...(auto ? { mode: auto.mode, specialist: auto.specialist, taskRole: auto.role } : {}),
      permissionAllow: opts.permissionAllow,
      toolFilter: opts.toolFilter,
      roleOverride: opts.roleOverride,
      signal: control.signal,
      control,
      workspaceRoot: session.worktree ? path.join(session.worktree.path, session.worktree.subdir ?? '') : undefined,
      isolatedFrom: session.worktree ? path.join(session.worktree.repo, session.worktree.subdir ?? '') : undefined,
      emit: (e) => {
        const p = e.payload as Record<string, unknown>;
        ndjson?.event(e);
        // Errors of the main run end it (subagents' carry their childId and only fail that subagent).
        if (e.type === 'error' && !(p && typeof p === 'object' && p.childId)) {
          lastTurnError = { message: p && typeof p === 'object' ? String(p.message ?? p.latest ?? 'error') : String(e.payload), kind: p && typeof p === 'object' && typeof p.kind === 'string' ? p.kind : undefined };
        }
        switch (e.type) {
          case 'assistant_delta': r.text(String(e.payload)); break;
          case 'thinking_delta': r.status(`Thinking… ${dim(String(e.payload).replace(/\s+/g, ' ').slice(-60))}`); break;
          case 'status': if (typeof e.payload === 'string') {r.status(e.payload);} break;
          case 'tool_start': if (!p.childId) {r.toolStart(String(p.id), String(p.name), (p.args as Record<string, unknown>) ?? {}, p.origin === 'healing');} break;
          case 'tool_progress': if (!p.childId) {r.toolOutput(String(p.id), String(p.chunk ?? ''));} break;
          case 'tool_end': if (!p.childId) {r.toolEnd(String(p.id), String(p.name), !!p.isError, String(p.content ?? ''), p.data, !!p.cached, p.origin === 'healing'); core.store?.save(session);} break;
          // A recovery phase change (checks starting, a fix attempt) comes before the long waits: the chat is written at once,
          // so a crash or a hard kill there (Windows has no SIGTERM) still leaves it on disk for -c and recovery resume.
          case 'recovery': if (!p.childId) {recovery = p as unknown as RecoveryEventPayload; notes.lines(recovery).forEach((l) => r.note(l)); if (core.store) { core.store.save(session); void core.store.flush(session).catch(() => undefined); }} break;
          case 'todos': r.todos((e.payload as TodoItem[]) ?? []); break;
          case 'memory': r.note(`Saved to memory: ${((p.saved as string[]) ?? []).join(', ')}`); break;
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
          case 'rules_applied': r.note(`Conditional rules applied: ${((p.files as string[]) ?? []).join(', ')}`); break;
          case 'hook': if (!p.childId && p.status !== 'running') {r.note(`⚙ ${p.event} ${p.name}${p.tool ? ` (${p.tool})` : ''} → ${p.status === 'blocked' ? yellow('blocked') : p.status === 'failed' ? red('failed') : 'ok'}${typeof p.ms === 'number' ? dim(` ${p.ms} ms`) : ''}`);} break;
          case 'subagent_start': r.note(`↳ subagent ${p.agent}: ${String(p.label || p.prompt).slice(0, 80)}`); break;
          case 'nudge': r.note(p.reason === 'length' ? `↺ the reply was cut off at the output limit — ${p.continued ? 'asking the model to continue' : 'asking for a shorter call'}` : `↺ ${p.reason === 'malformed' ? 'the tool call did not parse' : p.reason === 'shown' ? 'the tool call was written as text, not made' : p.reason === 'stale' ? 'the workers already finished; asking for their results' : 'the reply claimed an action no tool performed'} — asking the model to act`); break;
          case 'steer': r.note(`↩ your message${Number(p.count) === 1 ? ' was' : 's were'} added to the conversation`); break;
          case 'subagent_end': r.note(`↲ subagent ${p.agent} ${p.error ? red('failed') : 'done'}`); break;
          case 'error': r.error(e.payload && typeof e.payload === 'object' ? String(p.message ?? p.latest ?? 'error') : String(e.payload)); break;
          case 'turn_end':
            final = String(p.text ?? ''); lastTurnCompleted = p.completed !== false; lastTurnAnswered = p.completed === true;
            lastTurnHealing = { ended: true, ...(typeof p.outcome === 'string' ? { outcome: p.outcome } : {}), ...(p.contract ? { contract: p.contract as CompletionContract } : {}) };
            summary = p.recovery as RecoverySummary | undefined;
            break;
        }
      },
      requestApproval: (title, detail, kind, opts) => approvalDecision(title, detail, kind, rl, control.signal, opts),
      // Questions need someone at the terminal; scripted runs (no TTY, --yes) go with the agent's recommendations.
      askUser: process.stdin.isTTY && !yesMode && !printMode ? (questions) => askQuestions(questions, rl, control.signal) : undefined,
    });
    liveRun = { control, done: run, session };
    result = await run;
  } finally {
    if (liveRun?.control === control) {
      liveRun = undefined;
    }
    core.healing.live.delete(rootSid);
    offControl();
    if (activeSignal === control.signal) {
      activeSignal = undefined;
    }
    // Flush the stream filter even when the run rejects, so a dangling fence or <tool_call> does not leak into the next turn.
    r.end();
    // A stopped or failed run started TaskCancel / TaskError hooks; one-shot and piped runs exit right after, so let them finish.
    await core.runner.hooksSettled(5_000);
    // Written now rather than debounced: one-shot runs exit right after, and `-c` must find this turn.
    if (core.store?.has(session.id)) {
      core.store.save(session);
      await core.store.flush(session);
    }
    await recoveryOutcome(core, session.id, r, turnStarted, recovery, summary).catch((e) => core.log.warn(`recovery outcome: ${String(e)}`));
  }
  const spent = turnUsageLabel(usageDelta(usageBefore, session.usage));
  if (spent) {
    r.note(spent);
  }
  // A long run that finished rings the terminal bell, so a user in another window notices (`localpilot.notifications`).
  if (!control.aborted && shouldRingBell(getConfig().notifications, !!process.stdout.isTTY, Date.now() - turnStarted)) {
    process.stdout.write('\x07');
  }
  return final || result;
}

/**
 * The end-of-turn self-healing block (design §9.5): `Incomplete:` / `Blocked:` with the root cause and next commands,
 * `Not verified`, or the verified footer. On the throw path (no turn_end) the escalation persisted before the throw is shown.
 */
async function recoveryOutcome(core: Core, sid: string, r: Renderer, since: number, card: RecoveryEventPayload | undefined, summary: RecoverySummary | undefined): Promise<void> {
  if (ndjson || !getConfig().healing.enabled) {
    return; // NDJSON carries the recovery events and the run_result outcome
  }
  let outcome = lastTurnHealing.ended ? lastTurnHealing.outcome : undefined;
  let report = summary?.report;
  let next: readonly NextAction[] | undefined = card?.intervention?.nextActions;
  if (!lastTurnHealing.ended || outcome === 'incomplete' || outcome === 'blocked') {
    const state = await core.healing.store.load(sid).catch(() => undefined);
    const open = state?.intervention && !state.intervention.resolvedAt && state.updatedAt >= since ? state.intervention : undefined;
    if (state && open && isTerminalPhase(state.phase)) {
      outcome = outcome ?? state.phase;
      report = report ?? escalationReport(state, open);
      next = next?.length ? next : open.nextActions;
    }
  }
  const lines = outcomeBlock({ outcome, report: r.quiet ? report?.split('\n')[0] : report, nextActions: next }, STYLE);
  r.block(lines);
}

/** Create an isolated worktree for the CLI session (seeded with the checkout's uncommitted work) and route tools into it. */
async function isolate(core: Core, session: Session, cwd: string, r: Renderer, signal?: AbortSignal): Promise<{ info: WorktreeInfo; mgr: WorktreeManager } | undefined> {
  const mgr = new WorktreeManager(() => getConfig().worktrees.location, core.log);
  const repo = await mgr.repoRoot(cwd);
  if (!repo) {
    return undefined;
  }
  // Started in a subfolder of the repository: work in the same subfolder of the copy. CLI worktrees are never pruned
  // by the extension.
  const real = (() => { try { return fs.realpathSync.native(cwd); } catch { return path.resolve(cwd); } })();
  let info: WorktreeInfo;
  try {
    info = await mgr.create(repo, session.id, { progress: (t) => r.status(t), signal, subdir: path.relative(repo, real), owner: 'cli' });
  } catch (e) {
    if (signal?.aborted) {
      return undefined; // stopped while the copy was being made; create() already removed it
    }
    throw e;
  }
  if (signal?.aborted) {
    await mgr.remove(info).catch(() => undefined);
    return undefined;
  }
  session.worktree = info; // runTurn routes the tools into it
  r.note(`Isolated: working in ${info.path} (your checkout stays untouched)`);
  return { info, mgr };
}

/** Forget an isolated worktree a saved session still names: it ended with that run (or was kept for the user), and this run works in the checkout. */
function detachWorktree(session: Session, store: { save(s: Session): void }): void {
  if (!session.worktree) {
    return;
  }
  const kept = fs.existsSync(session.worktree.path) ? session.worktree.path : undefined;
  session.worktree = undefined;
  store.save(session);
  if (kept) {
    process.stderr.write(dim(`the isolated worktree of this session is still at ${kept}; this run works in the checkout\n`));
  }
}

/** Read piped stdin to the end, keeping at most `cap` characters (a note marks the cut). */
function readStdin(cap = 200_000): Promise<string> {
  return new Promise<string>((resolve) => {
    let s = '';
    let truncated = false;
    process.stdin.on('data', (d) => {
      if (s.length < cap) {
        s += d;
      } else {
        truncated = true;
      }
    });
    process.stdin.on('end', () => resolve(s.length > cap || truncated ? `${s.slice(0, cap)}\n[… stdin truncated at ${cap.toLocaleString()} characters]` : s));
  });
}

/** Report a failed worktree step without a stack trace and end the process. */
async function fatal(core: Core, e: unknown): Promise<never> {
  reportError(e instanceof Error ? e.message : String(e), 'isolate');
  core.mcp?.dispose();
  await core.runner.hooksSettled(5_000);
  await core.telemetry.flush();
  process.exit(1);
}

/** Apply the worktree's result to the checkout (or not), report, and remove the worktree; false when it was kept. */
async function finishIsolated(wt: { info: WorktreeInfo; mgr: WorktreeManager }, apply: boolean, r: Renderer, quiet: boolean): Promise<boolean> {
  const say = (s: string) => (quiet ? process.stderr.write(`${s}\n`) : console.log(s));
  let changes: Awaited<ReturnType<WorktreeManager['changes']>>;
  try {
    changes = await wt.mgr.changes(wt.info);
  } catch (e) {
    say(yellow(`could not read the isolated worktree's changes (${e instanceof Error ? e.message : String(e)}); left in ${wt.info.path}`));
    return false;
  }
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
    return false; // keep the worktree for the user to inspect
  }
  await wt.mgr.remove(wt.info);
  return true;
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

/** `/skill <name> <task>` or `/agent <name> <task>`: the prompt to run, or why it cannot run (same prompts as the chat). */
function taskCommand(core: Core, kind: string, rest: string): { prompt: string } | { error: string } | undefined {
  const { name, task } = parseTaskArgs(rest);
  if (!name) {
    return undefined;
  }
  if (kind === 'agent') {
    if (!core.skills.getAgent(name)) {
      return { error: `Unknown subagent "${name}". Subagents: ${core.skills.allAgents.map((a) => a.name).join(', ')}` };
    }
    return task ? { prompt: agentTaskPrompt(name, task) } : { error: 'Usage: /agent <name> <task>' };
  }
  const skill = core.skills.resolveSkill(name)?.skill;
  if (!skill) {
    const similar = core.skills.similarSkillNames(name);
    return { error: `Unknown skill "${name}".${similar.length ? ` Did you mean ${similar.join(', ')}?` : ''} Install one with: localpilot skill install <owner/repo|url>` };
  }
  return { prompt: skillTaskPrompt(skill.name, task) };
}

async function cmdModels(core: Core): Promise<void> {
  await core.providers.listModels(true);
  const models = await core.providers.listModelsStartingLocal();
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
  console.log(dim(`\n${amber('●')} = default. Use another with: localpilot --model <id> …; /model switches the current session; set defaultModel to change the default${models.some((m) => m.remote) ? '. Cloud models answer only when chosen; automatic picks prefer local ones.' : ''}`));
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

/** `localpilot mcp …`: manage the server files; `auth` connects once so a remote server can sign in. */
async function cliMcp(args: Args): Promise<number> {
  const m = parseMcpArgs(args.mcpArgv ?? []);
  if (m.cwd) {
    args.cwd = path.resolve(m.cwd);
    setWorkspaceRoot(args.cwd);
  }
  const log =vscode.window.createOutputChannel('LocalPilot CLI', { log: true });
  const settings = await loadProjectSettings([args.cwd], { log });
  const plugins = await discoverPlugins([args.cwd], { extraDirs: getConfig().pluginPaths, enabledPlugins: settings.enabledPlugins });
  const trust = cliMcpTrust(args.cwd, () => !!args.trustWorkspace, { prompt: (q) => ask(q) });
  return cmdMcp(m, {
    cwd: args.cwd,
    st: STYLE,
    pluginServers: pluginSource(plugins).mcpServers(),
    isTrusted: (k) => trust.isTrusted(k),
    ask: (q) => ask(q),
    authenticate: async (name, cfg) => {
      const oauth = cliMcpOAuth((m) => log.info(m));
      try {
        const r = await signInMcpServer(name, cfg, oauth, log, VERSION);
        return `${r.signedIn ? 'Signed in to' : 'Connected to'} "${name}": ${r.tools} tool${r.tools === 1 ? '' : 's'}`;
      } finally {
        oauth.dispose();
      }
    },
  });
}

/** `localpilot plugin …`: marketplaces, install/remove/enable/disable, and authoring (new, validate). */
async function cmdPlugin(core: Core, args: Args, renderer: Renderer): Promise<number> {
  const action = args.pluginAction ?? 'list';
  const arg = args.prompt.trim();
  const dest = pluginsDir(args.project ? 'project' : 'user', args.cwd);
  const settingsFile = args.project ? path.join(args.cwd, '.localpilot', 'settings.json') : path.join(os.homedir(), '.localpilot', 'settings.json');
  const markets = async () => {
    const out: Marketplace[] = [];
    for (const spec of getConfig().pluginMarketplaces) {
      renderer.status(`Fetching marketplace ${spec}…`);
      try {
        out.push(await loadMarketplace(spec, { refresh: true }));
      } catch (e) {
        console.error(`${red('✖')} ${spec}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    renderer.status('');
    return out;
  };
  switch (action) {
    case 'list': {
      if (!core.plugins.length) {
        console.log(dim('No plugins installed. Find some with `localpilot plugin search <words>`.'));
        return 0;
      }
      for (const p of core.plugins) {
        console.log(`${p.enabled ? green('●') : dim('○')} ${bold(p.name)} ${dim(`${p.version ?? ''} · ${p.source} · ${p.root}`)}\n  ${describePlugin(p).summary.replace(/^[^:]*: /, '')}${p.enabled ? '' : dim(' (disabled)')}`);
      }
      return 0;
    }
    case 'marketplaces': {
      for (const m of await markets()) {
        console.log(`${bold(m.name)} ${dim(`${m.spec} · ${m.plugins.length} plugins`)}`);
      }
      return 0;
    }
    case 'search': {
      const found = searchPlugins(await markets(), arg);
      const have = new Set(core.plugins.map((p) => p.name));
      for (const { entry, market } of found.slice(0, 40)) {
        console.log(`${have.has(entry.name) ? green('✔') : ' '} ${bold(entry.name)} ${dim([entry.category, entry.version, market.name].filter(Boolean).join(' · '))}\n    ${(entry.description ?? '').slice(0, 140)}`);
      }
      console.log(dim(`\n${found.length} match${found.length === 1 ? '' : 'es'}${found.length > 40 ? ' (first 40 shown)' : ''}. Install with: localpilot plugin install <name> [--project]`));
      return 0;
    }
    case 'install': {
      const [name, mk] = arg.split('@');
      const all = await markets();
      const hit = all.filter((m) => !mk || m.name === mk).flatMap((market) => market.plugins.filter((e) => e.name === name).map((entry) => ({ entry, market })))[0];
      if (!hit) {
        console.error(`${red('✖')} No plugin "${arg}" in ${all.map((m) => m.name).join(', ') || 'the configured marketplaces'}. Search with \`localpilot plugin search\`.`);
        return 2;
      }
      try {
        const r = await installPlugin(hit.entry, hit.market, dest, {
          confirm: async (_p, d) => {
            if (!d.runs.length || isAutoApprove()) {
              return true;
            }
            console.log(`${amber('!')} ${d.summary}\n  This plugin runs commands on your machine:\n${d.runs.map((r) => `    ${r}`).join('\n')}`);
            return approval(`Install ${hit.entry.name}?`, '', 'terminal');
          },
        });
        if (!r) {
          console.log(dim('Not installed.'));
          return 1;
        }
        console.log(`${green('✔')} Installed ${describePlugin(r.plugin).summary} → ${r.dir}`);
        return 0;
      } catch (e) {
        console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case 'remove':
    case 'uninstall': {
      const ok = await removePlugin(arg, dest);
      console.log(ok ? `${green('✔')} Removed ${arg}` : `${red('✖')} No plugin "${arg}" in ${dest}${args.project ? '' : ' (add --project for the workspace)'}`);
      return ok ? 0 : 2;
    }
    case 'enable':
    case 'disable': {
      await setPluginEnabled(settingsFile, arg, action === 'enable');
      console.log(`${green('✔')} ${arg} ${action}d in ${settingsFile}`);
      return 0;
    }
    case 'new': {
      const files = await scaffoldPlugin(args.cwd, arg || 'my-plugin');
      console.log(`${green('✔')} Created ${path.dirname(path.dirname(files[0]))}\n${files.map((f) => `  ${dim(path.relative(args.cwd, f))}`).join('\n')}\nCheck it with: localpilot plugin validate ${path.relative(args.cwd, path.dirname(path.dirname(files[0])))}`);
      return 0;
    }
    case 'validate': {
      const dir = path.resolve(args.cwd, arg || '.');
      const v = await validatePlugin(dir);
      for (const e of v.errors) {
        console.log(`${red('✖')} ${e}`);
      }
      for (const w of v.warnings) {
        console.log(`${amber('!')} ${w}`);
      }
      if (v.plugin && !v.errors.length) {
        console.log(`${green('✔')} ${describePlugin(v.plugin).summary}`);
      }
      return v.errors.length ? 1 : 0;
    }
  }
  console.error(`${red('✖')} Unknown action "${action}". Use: list, search, install, remove, enable, disable, marketplaces, new, validate.`);
  return 2;
}

/** `localpilot scan`: the security scan for a terminal or CI job; exit 1 when a finding reaches --fail-on. */
async function cmdScan(args: Args, renderer: Renderer): Promise<number> {
  const o = { ...args.scanOpts };
  if (!o.offline && !getManagedPolicy().allowWebAccess) {
    o.offline = true;
    console.error(dim("Dependency check skipped: web access is disabled by your organization's policy."));
  }
  let r: ScanResult;
  try {
    r = await scanWorkspace(args.cwd, { kinds: { dependencies: !o.offline, secrets: true, code: true }, path: args.prompt ? path.resolve(args.cwd, args.prompt) : undefined, progress: (t) => renderer.status(t) });
  } catch (e) {
    renderer.status('');
    console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
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
  const at = SEVERITY_ORDER.indexOf(o.failOn as (typeof SEVERITY_ORDER)[number]);
  const code = o.failOn !== 'none' && r.findings.some((f) => SEVERITY_ORDER.indexOf(f.severity) >= at) ? 1 : 0;
  // An incomplete dependency check must not pass a CI gate.
  // Notes about lockfiles the scan does not read are informational, not a failed check.
  const depSkip = o.offline ? undefined : r.skipped.find((t) => t.startsWith('dependencies:') && !/not checked$|no supported lockfile found$/.test(t));
  if (depSkip) {
    console.error(`${red('✖')} ${depSkip}`);
    return code || 2;
  }
  return code;
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
  let consecutiveFailures = 0;
  const failures = new Map<string, number>();
  try {
    await core.providers.resolve(getConfig().defaultModel);
  } catch (e) {
    console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}\n${dim('Run `localpilot doctor` to see which servers are reachable, or `localpilot --setup` to configure one in VS Code.')}`);
    return 2;
  }
  console.log(`${BRAND} working on the shared board in ${args.cwd}${args.workOpts.once ? ' (one task)' : ''} — Ctrl+C to stop\n`);
  while (!ctl.signal.aborted && (args.workOpts.max === undefined || done < args.workOpts.max)) {
    const session = newSession(args.mode, getConfig().defaultModel);
    if (args.auto) {
      session.autoMode = true;
    }
    core.sessions.set(session.id, session);
    const owner = boardOwner(session.id);
    const task = await board.claim(owner);
    if (!task) {
      core.sessions.delete(session.id);
      const all = await board.list();
      // Others are still working on live claims: wait for them; otherwise the board is finished (or blocked).
      const now = Date.now();
      const finishable = canFinish(all);
      const pending = all.some((t) => t.status === 'claimed' && !!t.leaseUntil && Date.parse(t.leaseUntil) >= now) || all.some((t) => t.status === 'open' && finishable.has(t.id));
      if (args.workOpts.once || !pending) {
        console.log(dim(all.length ? `Nothing left to take (${all.filter((t) => t.status === 'done').length}/${all.length} done).` : 'The board is empty: add tasks with the team_board tool or as .localpilot/board/<id>.md.'));
        const byId = new Map(all.map((t) => [t.id, t]));
        // Whether following open, unfinishable prerequisites from `from` leads back to `id` (a dependsOn cycle).
        const loops = (id: string, from: string, seen = new Set<string>()): boolean => {
          if (from === id) {
            return true;
          }
          if (seen.has(from)) {
            return false;
          }
          seen.add(from);
          return (byId.get(from)?.dependsOn ?? []).some((d) => byId.get(d)?.status === 'open' && !finishable.has(d) && loops(id, d, seen));
        };
        for (const t of all.filter((x) => x.status === 'open')) {
          const unmet = t.dependsOn
            .map((d) => ({ d, dep: byId.get(d) }))
            .filter((x) => x.dep?.status !== 'done')
            .map((x) => (!x.dep ? `${x.d} (unknown dependency)` : x.dep.status === 'failed' ? `${x.d} (failed prerequisite)` : x.dep.status === 'open' && !finishable.has(x.d) ? `${x.d} (${loops(t.id, x.d) ? 'circular dependsOn' : 'blocked'})` : `${x.d} (${x.dep.status})`));
          if (unmet.length) {
            console.log(dim(`  ${finishable.has(t.id) ? 'waiting' : 'cannot run'}: ${t.id} waits on ${unmet.join(', ')}`));
          }
        }
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
    const heartbeat = setInterval(() => void board.update(task.id, owner, { renew: true }).catch((e) => renderer.status(`lease renew failed: ${e}`)), LEASE_MS / 3);
    const notes = task.notes.filter((n) => n.text !== 'claimed').map((n) => `- ${n.by}: ${n.text}`).join('\n');
    const prompt = `You are working on "${task.title}" (id ${task.id}) from the team's shared task board.\n\n${task.brief}${notes ? `\n\nNotes from earlier work on it:\n${notes}` : ''}\n\nDo the work and verify it. Then call team_board with action "complete", id "${task.id}" and a summary of what changed and how you verified it. If you cannot finish, call team_board "release" with a note saying what is done and what is left (or "fail" with the reason if it cannot be done).`;
    let ok = true;
    let reported = false;
    let final = '';
    try {
      const run = new RunControl(session.id);
      const stop = () => run.stop('the worker was stopped');
      ctl.signal.addEventListener('abort', stop, { once: true });
      final = await runTurn(core, session, prompt, [], renderer, undefined, run, { display: `board: ${task.id}` }).finally(() => ctl.signal.removeEventListener('abort', stop));
    } catch (e) {
      ok = false;
      reported = !!(e as { reported?: boolean } | undefined)?.reported;
      final = e instanceof Error ? e.message : String(e);
    } finally {
      clearInterval(heartbeat);
    }
    // The agent normally closes its own claim; if it did not, close it from the outcome so the task never stays stuck.
    const completed = ok && lastTurnCompleted;
    const failedTimes = ok ? 0 : (failures.get(task.id) ?? 0) + 1;
    if (!ok) {
      if (!reported) {
        renderer.error(final);
      }
      failures.set(task.id, failedTimes);
    }
    const after = await board.get(task.id);
    if (after?.status === 'claimed' && after.owner === owner) {
      await board.update(task.id, owner, ctl.signal.aborted
        ? { note: 'released: the worker was stopped', status: 'open' }
        : !ok && failedTimes >= 3
          ? { status: 'failed', note: `failed: ${final.slice(0, 300)}`, result: final.slice(0, 2000) }
          : !ok
            ? { note: `released: ${final.slice(0, 300)}`, status: 'open' }
            : !completed
              ? { note: `released: stopped at the step limit — ${final.slice(0, 300)}`, status: 'open' }
              : { note: 'completed (closed by the worker)', status: 'done', result: final.slice(0, 2000) });
    }
    core.sessions.delete(session.id);
    const end = await board.get(task.id);
    console.log(`  ${end?.status === 'done' ? green('✔ done') : end?.status === 'failed' ? red('✖ failed') : dim(`↩ ${end?.status ?? '?'}`)}\n`);
    done++;
    if (args.workOpts.once) {
      break;
    }
    if (ok) {
      consecutiveFailures = 0;
    } else if (!ctl.signal.aborted) {
      consecutiveFailures++;
      if (consecutiveFailures >= 5) {
        console.error(`${red('✖')} Stopping: ${consecutiveFailures} tasks in a row failed.`);
        return 1;
      }
      // Back off before the next claim so a failing model or server is not hammered in a tight loop.
      const wait = Math.min(5_000 * 2 ** (consecutiveFailures - 1), 5 * 60_000);
      renderer.status(`Retrying in ${Math.round(wait / 1000)} s…`);
      await new Promise<void>((r) => {
        const wake = () => {
          clearTimeout(timer);
          ctl.signal.removeEventListener('abort', wake);
          r();
        };
        const timer = setTimeout(wake, wait);
        ctl.signal.addEventListener('abort', wake, { once: true });
      });
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
    // A model the CLI cannot reach (a cloud key only in VS Code's secret storage) would be replaced by a fallback.
    const route = await core.providers.route({ modelRef: model }).catch((e) => e as Error);
    if (route instanceof Error || route.fallback || (route.model.id !== model && route.model.modelId !== model)) {
      const why = `${model} is not available to the CLI — missing key? set LOCALPILOT_KEY_<ID> or run localpilot providers key <id>`;
      run.results.push(...tasks.map((t) => ({ task: t.id, category: t.category, model, pass: false, skipped: why, durationMs: 0, steps: 0, toolCalls: 0, toolErrors: 0, promptTokens: 0, completionTokens: 0 })));
      console.log(`  ${dim(`skipped: ${why}${route instanceof Error ? ` (${route.message})` : ''}`)}`);
      continue;
    }
    for (const task of tasks) {
      if (ctl.signal.aborted) {
        break;
      }
      process.stdout.write(`  ${task.id.padEnd(26)} `);
      let r: Awaited<ReturnType<typeof runTask>>;
      try {
        r = await runTask(core.runner, task, model, { signal: ctl.signal, keep: o.keep });
      } catch (e) {
        r = { task: task.id, category: task.category, model, pass: false, reason: e instanceof Error ? e.message : String(e), durationMs: 0, steps: 0, toolCalls: 0, toolErrors: 0, promptTokens: 0, completionTokens: 0 };
      }
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
  const report = formatReport(run, prev);
  console.log(`\n${md(report)}\n`);
  if (o.json) {
    await fs.promises.writeFile(o.json, JSON.stringify({ ...run, summary: summarize(run.results) }, null, 2));
  }
  // A partial run is no baseline for the next comparison.
  if (ctl.signal.aborted) {
    console.log(yellow('Interrupted — results not saved'));
    return 130;
  }
  try {
    console.log(dim(`Saved ${await saveRun(run)}`));
  } catch (e) {
    console.log(yellow(`! Could not save the run: ${e instanceof Error ? e.message : String(e)}`));
  }
  // Exit 1 when anything that ran failed, so CI can gate on a benchmark.
  return run.results.some((r) => !r.pass && !r.skipped) ? 1 : 0;
}

/** What `localpilot config` and `doctor --json` list: the objects this process runs the agent with. */
function configSources(core: Core, args: Args): ConfigSources {
  return { roots: [args.cwd], skills: core.skills, settings: core.settings, hookDirs: args.hooksDirs, plugins: core.plugins, tools: core.tools, mcp: core.mcp };
}

/**
 * `-P <id> [-k <key>] [--save-key]`: make the provider usable for this run (a preset not configured yet is added for
 * this run only) and qualify a bare `-m` with it. The key stays in this process unless --save-key. Returns a problem.
 */
async function useRunProvider(args: Args): Promise<string | undefined> {
  const id = args.runProvider!;
  const key = args.provider.key;
  const configured = () => vscode.workspace.getConfiguration('localpilot').get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS) ?? [];
  if (key && args.saveKey) {
    const err = (s: string) => process.stderr.write(`${s}\n`);
    const code = configured().some((p) => p.id === id) ? await setProviderKey(id, key, {}, STYLE, err) : findPreset(id) ? await addProvider(id, { key }, STYLE, err) : 2;
    if (code === 2) {
      return `could not store the key for "${id}" — localpilot providers presets lists the providers -P accepts`;
    }
    setWorkspaceRoot(args.cwd);
  }
  const secret = `localpilot-run-${id}`;
  const useKey = !!key && !args.saveKey;
  if (useKey) {
    setSecretValues({ [secret]: key });
  }
  const r = runProviderList(configured(), id, findPreset(id)?.cfg, useKey ? `\${secret:${secret}}` : undefined);
  if (r.error) {
    return r.error;
  }
  cliOverrides.providers = r.list;
  if (args.model && !args.model.startsWith(`${id}/`)) {
    args.model = `${id}/${args.model}`;
    cliOverrides.defaultModel = args.model;
  }
  setWorkspaceRoot(args.cwd);
  return undefined;
}

/** `doctor log`: the log file's path, opened in the default app when there is a terminal to come back to. */
function doctorLog(): number {
  console.log(LOG_FILE);
  if (!fs.existsSync(LOG_FILE)) {
    console.error(dim('(no log yet)'));
    return 0;
  }
  if (process.stdout.isTTY) {
    const cp = require('child_process') as typeof import('child_process');
    const [bin, ...rest] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open'];
    cp.spawn(bin, [...rest, LOG_FILE], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
  return 0;
}

/** `--acp`: LocalPilot as an Agent Client Protocol agent on stdio. The editor shows the chat and answers approvals. */
async function cmdAcp(args: Args): Promise<number> {
  let server: AcpServer | undefined;
  // Nothing is approved without the editor unless --yes: settings that allow a kind always ask the client here.
  if (!args.yes) {
    Object.assign(cliOverrides, acpApprovalOverrides(getConfig().approvals));
    setWorkspaceRoot(args.cwd);
  }
  // Subagents ask through boot's callback (no session of the client's): their prompts go to the session that runs them.
  const core = await boot(args, () => undefined, async (_sid, title, detail, kind, opts) => {
    const sid = server?.activeSessionId();
    return sid && server ? server.approve(sid, title, detail, kind as Parameters<AcpServer['approve']>[3], opts) : false;
  });
  const stores = new Map<string, SessionStore>();
  const storeFor = async (cwd: string): Promise<SessionStore> => {
    const key = path.resolve(cwd);
    let st = stores.get(key);
    if (!st) {
      st = await openCliStore(key, args.dataDir, core.log);
      stores.set(key, st);
    }
    return st;
  };
  let turnKey = 0;
  const host: AcpHost = {
    version: VERSION,
    autoApprove: () => args.yes,
    defaultModel: () => getConfig().defaultModel,
    models: async () => (await core.providers.listModels().catch(() => [] as ModelInfo[])).map((m) => ({ id: m.id, name: m.name })),
    newSession: async (cwd) => {
      const s = (await storeFor(cwd)).create(args.model ?? getConfig().defaultModel, args.mode);
      core.sessions.set(s.id, s);
      return s;
    },
    loadSession: async (id, cwd) => {
      const st = await storeFor(cwd);
      const hit = findSession(newestFirst(st.list()), id).session;
      const s = hit ? st.get(hit.id) : undefined;
      if (s) {
        core.sessions.set(s.id, s);
      }
      return s;
    },
    run: async (r) => {
      const st = await storeFor(r.cwd);
      const control = new RunControl(r.session.id, undefined, r.signal);
      const checkpoint = (turnKey = nextTurnKey(r.session, turnKey));
      core.tracker.beginTurn(r.session.id, checkpoint);
      let completed = true;
      let error: { message: string; kind?: string } | undefined;
      try {
        await core.runner.run({
          session: r.session,
          userMessage: { role: 'user', content: r.text, ...(r.images.length ? { images: r.images } : {}), meta: { checkpoint } },
          modelRef: r.session.model || undefined,
          signal: control.signal,
          control,
          workspaceRoot: path.resolve(r.cwd) === path.resolve(args.cwd) ? undefined : r.cwd,
          emit: (e) => {
            const p = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
            if (e.type === 'error' && !p.childId) {
              error = { message: String(p.message ?? p.latest ?? e.payload ?? 'error'), kind: typeof p.kind === 'string' ? p.kind : undefined };
            }
            if (e.type === 'turn_end' && !p.childId) {
              completed = p.completed !== false;
            }
            r.emit(e);
          },
          requestApproval: r.requestApproval,
        });
      } finally {
        control.dispose();
        st.save(r.session);
        await st.flush(r.session);
      }
      return { text: '', completed, error };
    },
  };
  const served = serveAcp(host);
  server = served.server;
  process.stderr.write(`LocalPilot ${VERSION}: Agent Client Protocol on stdio (${args.cwd})\n`);
  await served.done;
  for (const st of stores.values()) {
    st.dispose();
  }
  await shutdown(core);
  return 0;
}

async function cmdDoctor(core: Core, args?: Args): Promise<void> {
  const newer = versionNotice(VERSION, newestInstalledExtension());
  if (args?.json) {
    await core.providers.listModelsStartingLocal().catch(() => undefined);
    const rg = await runProcess('rg', ['--version']).then(() => true).catch(() => false);
    console.log(JSON.stringify({ version: VERSION, newerExtension: newer ?? null, settingsFiles: [userSettingsPath(), CLI_SETTINGS_PATH], log: LOG_FILE, ...(await doctorReport(configSources(core, args))), ripgrep: rg, node: process.version, platform: process.platform }, null, 2));
    return;
  }
  console.log(`${BRAND} ${dim(`v${VERSION}`)} doctor\n`);
  if (newer) {
    console.log(`${yellow('!')} ${newer}\n`);
  }
  console.log(`${bold('Settings')}\n  ${dim(userSettingsPath())}\n  ${dim(CLI_SETTINGS_PATH)}`);
  const cfg = getConfig();
  console.log(`  default model: ${cfg.defaultModel || dim('auto')}   approvals: terminal=${cfg.approvals.terminal} write=${cfg.approvals.write} delete=${cfg.approvals.delete} network=${cfg.approvals.network} mcp=${cfg.approvals.mcp}`);
  const org = getManagedPolicy();
  console.log(`\n${bold('Organization policy')}\n  ${org.source ? `${org.source}${org.message ? dim(` — ${org.message}`) : ''}\n${describePolicy(org).map((l) => `  ${amber('●')} ${l}`).join('\n') || dim('  (no restrictions)')}` : dim(`none (${managedPolicyPath()})`)}`);
  console.log(`\n${bold('Providers')}`);
  // An installed Ollama that is stopped is started here too, so the list shows what runs will actually get.
  await core.providers.listModelsStartingLocal().catch(() => undefined);
  await listProviders(STYLE, (l) => console.log(`  ${l}`), { compact: true });
  console.log(`\n${bold('Workspace')}\n  ${core.workspace.root ?? dim('(none)')}`);
  console.log(`  skills: ${core.skills.allSkills.length}   subagents: ${core.skills.allAgents.length}   mcp servers: ${core.mcp ? core.mcp.status.map((s) => `${s.name}(${s.error ? red('failed') : s.state === 'disabled' ? dim('off') : `${s.tools} tools`})`).join(', ') : dim('none configured')}`);
  const rg = await runProcess('rg', ['--version']).then(() => true).catch(() => false);
  console.log(`  ripgrep: ${rg ? green('found') : dim('not on PATH (using built-in search)')}   node: ${process.version}   platform: ${process.platform}`);
  console.log(`  log: ${dim(LOG_FILE)} ${dim('(localpilot doctor log opens it)')}`);
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
  // `schedule …` parses its own options (--cron, --prompt…) and only manages files and the OS scheduler.
  if (process.argv[2] === 'schedule') {
    process.exitCode = await cmdSchedule(process.argv.slice(3), STYLE, cliLauncher());
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd && args.json) {
    ndjson = new NdjsonWriter();
  }
  if (args.error) {
    reportError(args.error, 'usage', 'See: localpilot --help');
    process.exit(2);
  }
  // `recovery list|show|clear` only read the stores; `recovery resume <id>` becomes a one-shot resume turn in that session.
  if (args.cmd === 'recovery') {
    setWorkspaceRoot(args.cwd);
    const log = vscode.window.createOutputChannel('LocalPilot CLI', { log: true });
    const sessions = await openCliStore(args.cwd, args.dataDir, log);
    const { store } = cliHealing(args, { log });
    const r = await cmdRecovery(args.prompt.split(/\s+/).filter(Boolean), { store, sessions: sessions.list(), budget: (st) => attemptBudget(getConfig().healing, st), style: STYLE, json: !!args.json }).catch((e) => {
      console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}`);
      return { code: 1 } as Awaited<ReturnType<typeof cmdRecovery>>;
    });
    sessions.dispose();
    await store.flush();
    if (!r.resume) {
      process.exit(r.code);
    }
    args.cmd = undefined;
    args.resume = r.resume;
    args.recoveryResume = true;
    args.prompt = r.guidance ? `${RESUME_PROMPT}\n\n${r.guidance}` : RESUME_PROMPT;
    if (args.json) {
      ndjson = new NdjsonWriter();
    }
  }
  if (!args.cmd && !args.prompt && process.stdin.isTTY && (args.yolo || args.systemReplace || args.timeoutMs)) {
    const oneShot = [args.yolo && '--yolo', args.systemReplace && '--system-replace', args.timeoutMs && '--timeout'].filter(Boolean);
    reportError(`${oneShot.join(', ')} ${oneShot.length > 1 ? 'are' : 'is'} for one-shot runs: localpilot <flags> "task" (or pipe the task in)`, 'usage');
    process.exit(2);
  }
  if (args.cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (args.cmd === 'version') {
    console.log(VERSION);
    return;
  }
  if (args.cmd === 'ide') {
    openInVsCode(args.prompt ? 'run' : 'new', { mode: args.mode, prompt: args.prompt, files: args.files.join(','), parallel: process.argv.includes('--parallel') ? '1' : '' }, args.cwd);
  }
  if (args.cmd === 'settings' || args.cmd === 'setup') {
    openInVsCode(args.cmd, {}, args.cwd);
  }

  if (args.trustWorkspace) {
    setTrustWorkspace(true);
  }
  setWorkspaceRoot(args.cwd);
  if (ignoredWorkspaceSettings.length) {
    const msg = `Ignoring security-sensitive settings from ${path.join(args.cwd, '.vscode', 'settings.json')} (${ignoredWorkspaceSettings.join(', ')}) — pass --trust-workspace to use them.`;
    if (ndjson) {
      ndjson.event({ type: 'status', sessionId: '', payload: msg });
    } else {
      process.stderr.write(`${dim(msg)}\n`);
    }
  }
  if (args.model) {
    cliOverrides.defaultModel = args.model;
    setWorkspaceRoot(args.cwd);
  }
  if (args.yes) {
    setAutoApprove(true);
  }
  // --json keeps stderr to JSON error records: log lines stay in the log file only.
  setLogLevel(args.verbose ? 'debug' : args.json && !args.cmd ? 'off' : 'warn');
  // Keys for `${secret:id}` references: VS Code keeps them in the OS keychain, the CLI in its own key file.
  setSecretValues(readCliKeys());
  if (args.cmd === 'doctor' && args.prompt === 'log') {
    process.exitCode = doctorLog();
    return;
  }
  if (!args.cmd && args.provider.key && !args.runProvider) {
    reportError('-k/--key goes with -P/--provider <id> (to store a key: localpilot providers key <id>)', 'usage');
    process.exit(2);
  }
  if (args.runProvider) {
    const problem = await useRunProvider(args).catch((e) => (e instanceof Error ? e.message : String(e)));
    if (problem) {
      reportError(problem, 'provider');
      process.exit(2);
    }
  }
  /** `--system-replace`: the persona this run uses instead of LocalPilot's. */
  let systemReplace: string | undefined;
  if (args.system !== undefined || args.systemReplace) {
    let text: string;
    try {
      text = readSystemArg(args.system ?? '', args.cwd).trim();
    } catch (e) {
      reportError(`-s/--system: ${e instanceof Error ? e.message : String(e)}`, 'usage');
      process.exit(2);
    }
    if (!text) {
      reportError(args.systemReplace ? '--system-replace needs -s <text|@file>' : '-s/--system is empty', 'usage');
      process.exit(2);
    }
    if (args.systemReplace) {
      systemReplace = text;
    } else {
      cliOverrides.systemPromptAppend = [getConfig().systemPromptAppend, text].filter((t) => t?.trim()).join('\n\n');
      setWorkspaceRoot(args.cwd);
    }
  }
  if (args.cmd === 'mcp') {
    process.exitCode = await cliMcp(args).catch((e) => {
      console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    });
    process.exit(process.exitCode ?? 0);
  }
  if (args.cmd === 'providers') {
    process.exitCode = await cmdProviders(args).catch((e) => {
      console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    });
    return;
  }
  if (args.cmd === 'history') {
    const store = await openCliStore(args.cwd, args.dataDir, vscode.window.createOutputChannel('LocalPilot CLI', { log: true }));
    // A deleted chat takes its checkpoint refs, private indexes and file snapshots with it, as in VS Code.
    const lpHome = path.join(os.homedir(), '.localpilot');
    const cps = new CheckpointService({ globalStorageDir: lpHome, enabled: () => true, defaultRoot: () => args.cwd });
    const deleteCheckpoints = async (s: Session): Promise<{ checkpoints: number; logs: number }> => {
      const roots = s.checkpoints?.history.map((e) => e.root) ?? [];
      const snapshotDir = path.join(lpHome, 'checkpoints');
      const used = await cps.diskUsage({ snapshotDir, sessionId: s.id, roots }).catch(() => undefined);
      await cps.deleteSession(s.id, roots);
      fs.rmSync(path.join(snapshotDir, snapshotFolder(s.id)), { recursive: true, force: true });
      return { checkpoints: used?.total ?? 0, logs: deleteCommandLogs(s.id, path.join(lpHome, 'cmd-logs')) };
    };
    const words = args.prompt.split(/\s+/).filter(Boolean);
    const run = words[0] === 'import' ? cmdHistoryImport(store, words.slice(1), { json: args.historyOpts.json }, STYLE, args.cwd, process.stdin.isTTY ? (q) => ask(q) : undefined) : cmdHistory(store, words, { ...args.historyOpts, deleteCheckpoints }, STYLE, args.cwd);
    process.exitCode = await run.catch((e) => {
      console.error(`${red('✖')} ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    });
    store.dispose();
    return;
  }
  if (args.cmd === 'acp') {
    process.exitCode = await cmdAcp(args);
    process.exit(process.exitCode);
  }

  // A one-shot run whose output goes to a pipe or file prints the answer only, as with -p.
  const quiet = args.print || (!args.prompt && !process.stdin.isTTY) || (!args.cmd && (!!args.json || (!!args.prompt && !process.stdout.isTTY)));
  if (ndjson && !args.prompt && process.stdin.isTTY) {
    reportError('--json is for one-shot runs: localpilot --json "task" (or pipe the task in)', 'usage');
    process.exit(2);
  }
  if (quiet || !process.stdout.isTTY) {
    setPromptOutput(process.stderr);
    promptToStderr = true;
  }
  printMode = args.print && !args.yes;
  yesMode = args.yes;
  const renderer = new Renderer(args.verbose, quiet);
  // The scan needs no agent: never start MCP servers (including repository plugins' commands) for it.
  if (args.cmd === 'scan') {
    process.exitCode = await cmdScan(args, renderer);
    process.exit(process.exitCode ?? 0);
  }
  if (['models', 'plugin', 'skill-install', 'skill-search'].includes(args.cmd ?? '') || (args.cmd === 'config' && args.prompt && !['mcp', 'tools'].includes(args.prompt))) {
    args.mcp = false;
  }
  let rl: readline.Interface | undefined;
  const core = await boot(args, (e) => {
    if (e.type === 'status' && typeof e.payload === 'string') {
      renderer.status(e.payload);
    }
  }, (_sid, title, detail, kind, opts) => approvalDecision(title, detail, kind, rl, activeSignal, opts));

  // Subcommands end the process when done: MCP servers or Redis telemetry would otherwise keep it alive.
  if (['models', 'skill-install', 'skill-search', 'doctor', 'eval', 'plugin', 'work', 'config'].includes(args.cmd ?? '')) {
    try {
      if (args.cmd === 'models') {
        await cmdModels(core);
      } else if (args.cmd === 'skill-install') {
        await cmdSkillInstall(core, args, renderer);
      } else if (args.cmd === 'skill-search') {
        await cmdSkillSearch(core, args, renderer);
      } else if (args.cmd === 'doctor') {
        await cmdDoctor(core, args);
      } else if (args.cmd === 'config') {
        renderer.status('');
        process.exitCode = await cmdConfig(args.prompt, !!args.json, configSources(core, args), STYLE);
      } else if (args.cmd === 'eval') {
        process.exitCode = await cmdEval(core, args);
      } else if (args.cmd === 'plugin') {
        process.exitCode = await cmdPlugin(core, args, renderer);
      } else {
        process.exitCode = await cmdWork(core, args, renderer);
      }
    } finally {
      await shutdown(core);
    }
    process.exit(process.exitCode ?? 0);
  }

  // -P without -m: the provider's own default model, else its model that is the global default, else its first one.
  if (args.runProvider && !args.model) {
    const own = getConfig().providers.find((p) => p.id === args.runProvider)?.defaultModel?.trim();
    const mine = own ? [] : (await core.providers.listModels(true).catch(() => [] as ModelInfo[])).filter((m) => m.providerId === args.runProvider);
    const pick = own ? `${args.runProvider}/${own}` : (mine.find((m) => m.id === getConfig().defaultModel) ?? mine[0])?.id;
    if (!pick) {
      reportError(`${args.runProvider} lists no models — is it reachable and is its key right? (localpilot providers test ${args.runProvider})`, 'provider');
      process.exit(2);
    }
    cliOverrides.defaultModel = pick;
    setWorkspaceRoot(args.cwd);
  }
  // Resolve the model up front so a missing server fails fast with a useful message.
  let modelInfo: ModelInfo;
  try {
    modelInfo = (await core.providers.resolve(getConfig().defaultModel)).model;
  } catch (e) {
    reportError(e instanceof Error ? e.message : String(e), 'provider', 'Run `localpilot doctor` to see which servers are reachable, or `localpilot --setup` to configure one in VS Code.');
    process.exit(2);
  }
  const store = await openCliStore(args.cwd, args.dataDir, core.log);
  core.store = store;
  core.runner.archive = store;
  const out = quiet ? process.stderr : process.stdout;
  let resumed: Session | undefined;
  if (args.continue || args.resume !== undefined) {
    const list = newestFirst(store.list());
    let pick = args.continue && args.resume === undefined ? list[0] : undefined;
    if (args.resume === true) {
      if (!process.stdin.isTTY) {
        reportError('-r without an id needs a terminal to pick from; pass the id or number (localpilot history lists them)', 'usage');
        process.exit(2);
      }
      pick = await pickSession(list, STYLE, (q) => ask(q), out);
      if (!pick && list.length) {
        process.exit(0);
      }
    } else if (typeof args.resume === 'string') {
      const hit = findSession(list, args.resume);
      if (!hit.session) {
        reportError(hit.ambiguous ? `"${args.resume}" matches ${hit.ambiguous.length} sessions` : `no saved session "${args.resume}" in ${args.cwd}`, 'usage', 'See: localpilot history');
        process.exit(2);
      }
      pick = hit.session;
    }
    resumed = pick && store.get(pick.id);
    if (!resumed && !quiet) {
      out.write(dim('No saved session in this folder yet — starting a new one.\n'));
    }
  }
  if (args.recoveryResume && !resumed) {
    reportError(`session ${String(args.resume)} could not be read`, 'usage', 'See: localpilot recovery list');
    process.exit(2);
  }
  if (resumed) {
    // -m and a mode flag apply to the resumed chat; otherwise it keeps its own model (when it is still reachable).
    if (args.model) {
      resumed.model = modelInfo.id;
    } else if (resumed.model !== modelInfo.id && !(await core.providers.resolve(resumed.model).then(() => true, () => false))) {
      out.write(dim(`${resumed.model} is not available — continuing with ${modelInfo.id}\n`));
      resumed.model = modelInfo.id;
    }
    if (args.mode !== 'agent') {
      resumed.mode = args.mode;
    }
  }
  let session: Session = resumed ?? store.create(modelInfo.id, args.mode);
  // --auto: every message picks its mode; a resumed chat keeps its own Auto setting unless --auto asks for it.
  if (args.auto) {
    session.autoMode = true;
  }
  session.think = sessionThinking(args.thinking, session.think, savedThinking());
  if (args.thinking) {
    await rememberThinking(args.thinking);
  }
  core.sessions.set(session.id, session);
  detachWorktree(session, store);
  if (!resumed) {
    void store.prune(getConfig().sessionRetention, [session.id]).catch((e) => core.log.warn(`session prune: ${String(e)}`));
  } else if (!quiet) {
    out.write(`${resumeBanner(session, STYLE)}\n\n`);
  }
  // Self-healing: states whose process died are marked interrupted; the resumed chat's is shown in detail (and a
  // `recovery resume` runs the resume turn), other interrupted ones in this folder get a one-line notice.
  const healingNote = (lines: string[]): void => {
    if (!lines.length) {
      return;
    }
    if (ndjson) {
      ndjson.event({ type: 'status', sessionId: session.id, payload: lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '') });
    } else {
      out.write(`${lines.join('\n')}\n\n`);
    }
  };
  const unfinished = await core.healing.service.scanUnfinished().catch((e) => {
    core.log.warn(`recovery scan: ${String(e)}`);
    return [];
  });
  void core.healing.store.prune(30).catch((e) => core.log.warn(`recovery prune: ${String(e)}`));
  const resumeTurn = !!args.recoveryResume;
  if (resumed) {
    const state = await core.healing.store.load(session.id).catch(() => undefined);
    if (state && (resumableRecovery(state) || args.recoveryResume)) {
      const lines = stateDetail(state, attemptBudget(getConfig().healing, state), STYLE, { inRepl: !args.prompt });
      const hint = `localpilot recovery resume ${session.id}`;
      healingNote(args.prompt && !args.recoveryResume ? [...lines, dim(`  Your prompt runs as a new task${lines.some((l) => l.includes(hint)) ? '' : `; to continue the recovery: ${hint}`}`)] : lines);
    }
  }
  const folderIds = new Set(store.list().map((x) => x.id));
  const elsewhere = unfinished.filter((u) => u.sid !== session.id && folderIds.has(u.sid));
  if (elsewhere.length) {
    healingNote([dim(`⟲ ${elsewhere.length} interrupted self-healing recover${elsewhere.length === 1 ? 'y' : 'ies'} in this folder (${elsewhere.map((u) => u.sid).slice(0, 3).join(', ')}${elsewhere.length > 3 ? ', …' : ''}) — localpilot recovery list`)]);
  }
  // A closed terminal or SIGTERM is a shutdown, not a user stop: the run's recovery is saved as interrupted (resumable).
  for (const [sig, code] of [['SIGHUP', 129], ['SIGTERM', 143]] as const) {
    process.once(sig, () => void stopForShutdown(core, code));
  }
  /** Where the agent works: the isolated copy of the start folder, or the start folder itself. */
  const runRoot = (): string => (session.worktree ? path.join(session.worktree.path, session.worktree.subdir ?? '') : args.cwd);
  const notGit = `--isolate needs a git repository (${args.cwd} is not one)`;
  const cwdLabel = vscode.workspace.asRelativePath(args.cwd) === args.cwd ? path.basename(args.cwd) : args.cwd;
  /**
   * `/name args` runs a command, or a skill of that name (built-in command, then skill, then custom command); a custom
   * command or workflow named inside the message is expanded where it stands. Undefined: send the text as typed.
   */
  const expandSlash = async (text: string, note: (n: string) => void): Promise<{ text: string; opts: { modelRef?: string; permissionAllow?: string[]; display?: string } } | undefined> => {
    const mcpHit = parseMcpSlash(text);
    if (mcpHit) {
      if (!core.mcp) {
        throw new Error(`/mcp:${mcpHit.server}:${mcpHit.prompt}: no MCP servers are running`);
      }
      const r = await core.mcp.getPrompt(mcpHit.server, mcpHit.prompt, mcpHit.args);
      if (r.images.length) {
        note(`${r.images.length} image${r.images.length > 1 ? 's' : ''} from the prompt ${r.images.length > 1 ? 'are' : 'is'} not sent from the terminal`);
      }
      return { text: r.text, opts: { display: text.trim() } };
    }
    const hit = resolveSlashMessage(text, core.commands, core.skills.enabledSkills);
    if (!hit) {
      return undefined;
    }
    if ('skill' in hit) {
      return { text: skillTaskPrompt(hit.skill, hit.task), opts: { display: text.trim() } };
    }
    const { prompt, notes } = await expandCommand(hit.command, hit.args, { root: runRoot() });
    notes.forEach(note);
    if (!prompt) {
      throw new Error(`${hit.command.invoke}: the command file has no prompt body`);
    }
    return { text: hit.inline ? spliceSlashToken(text, hit.inline, prompt) : prompt, opts: { modelRef: hit.command.model, permissionAllow: hit.command.allowedTools, display: text.trim() } };
  };
  /** `/name args` as a one-shot prompt runs the custom command (like `claude -p "/cmd"`); anything else is sent as typed. */
  const prepare = async (text: string): Promise<{ text: string; opts: { modelRef?: string; permissionAllow?: string[]; display?: string } }> => {
    const m = /^\/([\w:-]+)\s*([\s\S]*)$/.exec(text.trim());
    const task = m && (m[1] === 'skill' || m[1] === 'agent') ? taskCommand(core, m[1], m[2]) : undefined;
    if (task) {
      if ('error' in task) {
        reportError(task.error, 'usage');
        process.exit(2);
      }
      return { text: task.prompt, opts: { display: text.trim() } };
    }
    try {
      return (await expandSlash(text, (n) => process.stderr.write(`${yellow('!')} ${n}\n`))) ?? { text, opts: {} };
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), 'command');
      process.exit(2);
    }
  };

  /** --timeout: stops the run when the time is up; `fired()` tells the exit code. */
  const deadline = (ctl: RunControl): { fired: () => boolean; clear: () => void } => {
    let fired = false;
    const timer = args.timeoutMs ? setTimeout(() => {
      fired = true;
      const msg = `timed out after ${Math.round(args.timeoutMs! / 1000)} s (--timeout)`;
      if (ndjson) {
        ndjson.error(msg, { kind: 'timeout' });
      } else {
        process.stderr.write(`${red('✖')} ${msg}\n`);
      }
      ctl.stop(msg);
    }, args.timeoutMs) : undefined;
    return { fired: () => fired, clear: () => clearTimeout(timer) };
  };
  /**
   * One headless turn (a task argument, or the task piped in): `@path` attachments, the --yolo tool set and
   * --system-replace persona, then the exit code for the outcome and, with --json, the `run_result` line.
   */
  const headless = async (task: string, extra: string, ctl: RunControl, timedOut: () => boolean): Promise<{ answer: string; code: number }> => {
    const prepared = await prepare(task);
    if (extra) {
      prepared.text = withStdin(prepared.text, extra);
    }
    const refs = atRefs(task, runRoot());
    const images = (await Promise.all(refs.images.map((f) => readImage(f)))).flatMap((i) => (i ? [i.data] : []));
    const before = session.usage && { ...session.usage };
    const started = Date.now();
    let answer = '';
    let thrown: string | undefined;
    try {
      answer = await runTurn(core, session, prepared.text, [...args.files, ...refs.files], renderer, undefined, ctl, { ...prepared.opts, ...(args.recoveryResume ? { display: `localpilot recovery resume ${session.id}` } : {}), images, toolFilter: args.yolo ? YOLO_TOOLS : undefined, roleOverride: systemReplace, resume: resumeTurn });
    } catch (e) {
      if (!ctl.signal.aborted) {
        thrown = e instanceof Error ? e.message : String(e);
        // A failure the run already reported (error event) is not printed twice.
        if (!(e as { reported?: boolean } | undefined)?.reported) {
          if (ndjson) {
            ndjson.error(thrown);
          } else {
            renderer.error(thrown);
          }
        }
      }
    }
    // The quality gate's verdict from turn_end; the final model failure throws without one, which is `failed`.
    const healed = lastTurnHealing.ended ? lastTurnHealing.outcome : thrown && getConfig().healing.enabled ? 'failed' : undefined;
    const outcome: RunOutcome = { aborted: ctl.signal.aborted, timedOut: timedOut(), error: lastTurnError?.message ?? thrown, errorKind: lastTurnError?.kind, completed: lastTurnCompleted, outcome: healed, requireVerified: args.requireVerified };
    ndjson?.result({ finishReason: finishReasonFor(outcome), text: answer, ...runUsage(before, session.usage), durationMs: Date.now() - started, model: session.model || modelInfo.id, sessionId: session.id, ...(healed ? { outcome: healed } : {}), ...(lastTurnHealing.contract ? { contract: lastTurnHealing.contract } : {}) });
    return { answer, code: exitCodeFor(outcome) };
  };

  // One-shot mode -----------------------------------------------------------
  if (args.prompt) {
    if (!quiet) {
      process.stdout.write(`${BRAND} ${dim(`${modelInfo.id} · ${args.mode} · ${cwdLabel}`)}\n\n`);
    }
    const ctl = new RunControl(session.id);
    process.on('SIGINT', () => {
      if (!ctl.signal.aborted) {
        ctl.stop();
      } else {
        core.runner.cancelBackground();
      }
    });
    // Cooked terminal: Ctrl+Z arrives as SIGTSTP; hold the agent instead of suspending the process.
    // Children in our process group (hooks, git, rg) were stopped by the tty too; continue them right away.
    process.on('SIGTSTP', () => {
      ctl.togglePause();
      if (process.platform !== 'win32') {
        try { process.kill(0, 'SIGCONT'); } catch { /* ignore */ }
      }
    });
    const limit = deadline(ctl);
    const wt = args.isolate ? await isolate(core, session, args.cwd, renderer, ctl.signal).catch((e) => fatal(core, e)) : undefined;
    if (ctl.signal.aborted) {
      process.exit(shutdownCode ?? (limit.fired() ? 124 : 130));
    }
    if (args.isolate && !wt) {
      reportError(notGit, 'isolate');
      process.exit(2);
    }
    // `cmd | localpilot "review this"`: the piped input goes with the prompt (or the /skill, /agent or command's task).
    const input = process.stdin.isTTY ? '' : (await readStdin()).trim();
    const { answer, code } = await headless(args.prompt, input, ctl, limit.fired);
    limit.clear();
    if (quiet) {
      if (!ndjson && answer.trim()) {
        process.stdout.write(answer.trimEnd() + '\n');
      }
    } else {
      changesSummary(core, session);
      if (core.tracker.forSession(session.id).length) {
        core.tracker.keep(session.id, undefined, false); // one-shot runs keep their edits; the summary above tells the user what changed
      }
    }
    if (wt && (await finishIsolated(wt, args.apply && !ctl.signal.aborted, renderer, quiet).catch((e) => fatal(core, e)))) {
      session.worktree = undefined;
      store.save(session);
      await store.flush(session);
    }
    // The automatic memory save runs after the answer; give it a moment before the process ends.
    if (!ctl.signal.aborted) {
      renderer.status('Saving what this run learned to memory…');
      process.once('SIGINT', () => core.runner.cancelBackground());
      await core.runner.idle(45_000);
      renderer.status('');
    }
    core.mcp?.dispose();
    // After finishIsolated the worktree may be gone, so hooks run in the real workspace.
    await core.runner.hooks?.sessionEnd(session.id, 'other', args.cwd, { signal: ctl.signal });
    await core.telemetry.flush();
    core.telemetryRemote?.dispose();
    process.exit(shutdownCode ?? code);
  }

  // Interactive REPL --------------------------------------------------------
  if (!process.stdin.isTTY) {
    // Piped stdin: treat the whole input as one prompt.
    const input = await readStdin();
    const ctl = new RunControl(session.id);
    // First Ctrl+C stops the run (and the process groups it started); a second one exits right away.
    process.once('SIGINT', () => {
      ctl.stop();
      process.once('SIGINT', () => process.exit(130));
    });
    const limit = deadline(ctl);
    let code = 0;
    try {
      const wt = args.isolate ? await isolate(core, session, args.cwd, renderer, ctl.signal).catch((e) => fatal(core, e)) : undefined;
      if (args.isolate && !wt) {
        reportError(notGit, 'isolate');
        process.exit(2);
      }
      const r = await headless(input.trim(), '', ctl, limit.fired);
      limit.clear();
      code = r.code;
      if (!ndjson && r.answer.trim()) {
        process.stdout.write(r.answer.trimEnd() + '\n');
      }
      if (wt && (await finishIsolated(wt, args.apply && !ctl.signal.aborted, renderer, true).catch((e) => fatal(core, e)))) {
        session.worktree = undefined;
        store.save(session);
        await store.flush(session);
      }
    } finally {
      await shutdown(core);
    }
    process.exit(shutdownCode ?? (ctl.signal.aborted && !code ? 130 : code));
  }

  process.stdout.write(`${BRAND} ${dim(`v${VERSION}`)}  ${dim('·')}  ${cyan(modelInfo.id)}  ${dim('·')}  ${amber(args.mode)}  ${dim('·')}  ${dim(cwdLabel)}\n${dim('Type a task, /help for commands, Tab to complete, Shift+Tab for the next mode, Ctrl+C to stop a run, Ctrl+Z to pause it, /exit to quit.')}\n\n`);
  const newer = versionNotice(VERSION, newestInstalledExtension());
  if (newer) {
    process.stdout.write(`${yellow('!')} ${newer}\n\n`);
  }
  /** The prompt: `[auto]` in front while every action is auto-approved. */
  const promptText = (): string => `${isAutoApprove() ? `${yellow('[auto]')} ` : ''}${amber('◆')} `;
  /** Shift+Tab sends a Tab that readline would complete on: the completer skips that one. */
  let shiftTab = false;
  const BUILTIN_SLASH = ['/help', '/exit', '/quit', '/mode', '/team', '/model', '/models', '/providers', '/changes', '/undo', '/keep', '/isolate', '/apply', '/discard', '/clear', '/file', '/attach', '/doctor', '/history', '/resume', '/fork', '/recovery', '/skill', '/agent', '/commands', '/prompts', '/permissions', '/hooks', '/queue', '/deep-planning', '/compact', '/smol', '/skills', '/agents', '/mcp', '/memory', '/context', '/yes', '/thinking', '/settings', '/plugins'];
  const completer = createCompleter({
    commands: () => [...BUILTIN_SLASH, ...core.commands.map((c) => c.invoke), ...core.skills.enabledSkills.map((s) => `/${s.name}`), ...(core.mcp?.promptCommands ?? []).map((p) => p.invoke)],
    root: () => runRoot(),
    skip: () => shiftTab,
  });
  process.stdin.prependListener('keypress', (_s: string | undefined, key: { name?: string; shift?: boolean } | undefined) => {
    shiftTab = key?.name === 'tab' && !!key.shift;
  });
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: promptText(), historySize: 200, completer });
  setReadline(rl);
  let current: RunControl | undefined;
  let currentRun: Promise<unknown> | undefined;
  let busy = false;
  let pendingFiles = [...args.files];
  let isolated: { info: WorktreeInfo; mgr: WorktreeManager } | undefined = args.isolate ? await isolate(core, session, args.cwd, renderer) : undefined;
  if (args.isolate && !isolated) {
    console.log(yellow(`${notGit} — this session works in place`));
  }
  /** Lines typed after the run stopped, or steering it never took: they become the next prompt. */
  const deferred: string[] = [];
  /** `>>` lines typed during a run: each starts a turn of its own once the run ends (also after Ctrl+C). */
  const afterTurn: string[] = [];
  const leftovers = (ctl: RunControl | undefined): void => {
    const left = ctl?.close().map((m) => m.content) ?? [];
    if (left.length) {
      renderer.note(`↩ ${left.length === 1 ? 'your queued message was' : `${left.length} queued messages were`} not delivered — sending ${left.length === 1 ? 'it' : 'them'} next`);
      deferred.unshift(...left);
    }
  };
  /** /resume and /fork: the REPL continues in `next` (not while working in an isolated worktree, which belongs to this one). */
  const switchTo = (next: Session, how: 'Resumed' | 'Forked'): boolean => {
    if (isolated) {
      console.log(yellow('this session works in an isolated worktree — /apply or /discard it first'));
      return false;
    }
    store.save(session, true);
    core.sessions.delete(session.id);
    session = next;
    core.sessions.set(session.id, session);
    detachWorktree(session, store);
    // "Always allow" answers were given for the chat being left.
    alwaysKinds.clear();
    console.log(resumeBanner(session, STYLE, how));
    return true;
  };
  rl.on('SIGINT', () => {
    if (current) {
      current.stop();
      process.stdout.write(`\n${dim('stopped')}\n`);
    } else if (busy) {
      process.stdout.write(`\n${dim('wait for the current command to finish')}\n`);
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
  // Ctrl+B while the agent waits for a command: Proceed While Running (the command keeps going, output to its log).
  process.stdin.on('keypress', (_s: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
    if (key?.ctrl && key.name === 'b' && current) {
      const n = detachWaiting();
      if (n) {
        renderer.note(`↗ ${n === 1 ? 'command' : `${n} commands`} left running; the agent continues`);
      }
    }
  });
  // Esc twice at an empty prompt opens the /undo turn picker (two quick presses can arrive as one meta+Esc key).
  let lastEsc = 0;
  process.stdin.on('keypress', (_s: string | undefined, key: { name?: string; meta?: boolean } | undefined) => {
    if (key?.name !== 'escape' || current || busy || rl!.line) {
      lastEsc = 0;
      return;
    }
    const now = Date.now();
    if (!key.meta && now - lastEsc > 700) {
      lastEsc = now;
      return;
    }
    lastEsc = 0;
    busy = true;
    process.stdout.write('\n');
    void slash('/undo')
      .catch((e) => renderer.error(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        busy = false;
        void next();
      });
  });
  // Shift+Tab at the prompt: the next mode (agent → multitask → debug → plan → ask), keeping what is typed.
  process.stdin.on('keypress', (_s: string | undefined, key: { name?: string; shift?: boolean } | undefined) => {
    if (key?.name !== 'tab' || !key.shift || current || busy) {
      return;
    }
    const to = nextMode(session.mode);
    core.telemetry.record({ type: 'mode_switch', sid: session.id, from: session.mode, to, source: 'cli' });
    session.mode = to;
    store.save(session);
    process.stdout.write(`\r\x1b[2K${dim(`mode → ${to}`)}\n`);
    rl!.prompt(true);
  });
  rl.on('close', async () => {
    // Ctrl+D mid-run: stop the agent (and its run_command process groups) before exiting. Leaving the CLI is a
    // shutdown, so an active recovery is kept as interrupted and `localpilot -c` can resume it.
    const wasRunning = !!current;
    if (current) {
      current.stop('shutdown');
      await Promise.race([currentRun?.catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
    }
    core.mcp?.dispose();
    if (isolated) {
      process.stdout.write(yellow(`isolated worktree kept at ${isolated.info.path} — apply it with: git -C ${isolated.info.path} add -AN && git -C ${isolated.info.path} diff --binary ${isolated.info.base} | git -C ${isolated.info.repo} apply\n`));
    }
    // Writes still waiting for their debounce (a /mode or /model change) land before the process ends.
    store.dispose();
    process.stdout.write(`${exitSummary(session, STYLE)}\n`);
    void (session.messages.length ? core.runner.hooks?.sessionEnd(session.id, 'prompt_input_exit', runRoot()) : Promise.resolve())
      ?.then(() => core.telemetry.flush())
      .finally(() => {
        core.telemetryRemote?.dispose();
        process.exit(wasRunning ? 130 : 0);
      });
  });

  /** `/recovery resume [guidance]`: a resume turn — the checks re-run before the model is asked; edits are never replayed. */
  const resumeRecovery = async (guidance?: string): Promise<void> => {
    rl!.setPrompt('');
    current = new RunControl(session.id);
    try {
      currentRun = runTurn(core, session, guidance ? `${RESUME_PROMPT}\n\n${guidance}` : RESUME_PROMPT, pendingFiles, renderer, rl, current, { display: `/recovery resume${guidance ? ` ${guidance}` : ''}`, resume: true });
      await currentRun;
      pendingFiles = [];
      changesSummary(core, session);
    } catch (e) {
      renderer.error(e instanceof Error ? e.message : String(e));
    } finally {
      leftovers(current);
      current = undefined;
      currentRun = undefined;
      process.stdout.write('\n');
      rl!.setPrompt(promptText());
    }
  };

  const slash = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'help': console.log(HELP); return true;
      case 'exit': case 'quit': case 'q': rl!.close(); return true;
      case 'mode':
        if (arg === 'auto') { if (!session.autoMode) { core.telemetry.record({ type: 'mode_switch', sid: session.id, from: session.mode, to: 'auto', source: 'cli' }); } session.autoMode = true; console.log(dim('mode → auto (each message picks its mode)')); }
        else if ((ALL_MODES as readonly string[]).includes(arg)) { if (session.mode !== arg) { core.telemetry.record({ type: 'mode_switch', sid: session.id, from: session.mode, to: arg, source: 'cli' }); } session.mode = arg as Session['mode']; session.specialist = undefined; session.autoMode = undefined; console.log(dim(`mode → ${arg}`)); }
        // Specialists (review, test, …) run in their base mode with a built-in agent's playbook, as in the VS Code chat.
        else if (isSpecialistId(arg)) { const base = SPECIALISTS[arg].base; core.telemetry.record({ type: 'mode_switch', sid: session.id, from: session.mode, to: `${base}:${arg}`, source: 'cli' }); session.mode = base; session.specialist = arg; session.autoMode = undefined; console.log(dim(`mode → ${arg} (runs in ${base})`)); }
        else { console.log(dim(`mode is ${session.specialist && SPECIALISTS[session.specialist]?.base === session.mode ? `${session.specialist} (${session.mode})` : session.mode}; use /mode auto|ask|agent|plan|debug|multitask or ${SPECIALIST_IDS.join('|')}`)); }
        return true;
      case 'team': {
        // `/team <task>`: a coordinator brief in Multitask mode (the session stays in it, as with /mode).
        if (!arg) {
          console.log(dim('usage: /team <task>  — split the task for background workers and the shared board (multitask mode)'));
          return true;
        }
        if (session.mode !== 'multitask') {
          core.telemetry.record({ type: 'mode_switch', sid: session.id, from: session.mode, to: 'multitask', source: 'cli' });
          session.mode = 'multitask';
          console.log(dim('mode → multitask'));
        }
        rl!.setPrompt('');
        current = new RunControl(session.id);
        try {
          const run = runTurn(core, session, teamPrompt(arg), pendingFiles, renderer, rl, current, { display: line });
          currentRun = run;
          await run;
          pendingFiles = [];
          changesSummary(core, session);
        } catch (e) {
          renderer.error(e instanceof Error ? e.message : String(e));
        } finally {
          leftovers(current);
          current = undefined;
          currentRun = undefined;
          process.stdout.write('\n');
          rl!.setPrompt(promptText());
        }
        return true;
      }
      case 'model': {
        if (!arg) { console.log(dim(`model is ${session.model}`)); return true; }
        const models = await core.providers.listModels();
        const m = models.find((x) => x.id === arg || x.modelId === arg || x.name === arg) ?? models.find((x) => x.id.includes(arg));
        if (!m) { console.log(red(`no model matches "${arg}" — /models lists them`)); return true; }
        core.telemetry.record({ type: 'model_selected', sid: session.id, model: m.id, source: 'cli' });
        session.model = m.id; cliOverrides.defaultModel = m.id; setWorkspaceRoot(args.cwd);
        console.log(dim(`model → ${m.id}`)); return true;
      }
      case 'models': await cmdModels(core); return true;
      case 'thinking': case 'think': {
        if (!arg) { console.log(dim(`thinking is ${session.think ?? `${getConfig().thinking} (the localpilot.thinking setting)`}; use /thinking auto|off|low|medium|high|max`)); return true; }
        const level = parseThinkChoice(arg);
        if (!level) { console.log(red(`"${arg}" is not a thinking level — use auto, off, low, medium, high or max`)); return true; }
        session.think = level; store.save(session); await rememberThinking(level);
        console.log(dim(`thinking → ${level}`)); return true;
      }
      case 'providers': await listProviders(STYLE); return true;
      case 'changes': changesSummary(core, session); if (!core.tracker.forSession(session.id).length) { console.log(dim('no pending changes')); } return true;
      case 'undo': {
        if (arg !== 'all') {
          await undoPicker(arg, { session, store, tracker: core.tracker, checkpoints: core.runner.checkpoints, ask: (q) => ask(q), style: STYLE, prefill: (t) => setImmediate(() => rl!.write(t)) });
          return true;
        }
        const n = await core.tracker.undo(session.id); console.log(n ? yellow(`reverted ${n} file${n === 1 ? '' : 's'}`) : dim('nothing to undo')); return true;
      }
      case 'keep': core.tracker.keep(session.id); console.log(green('changes kept')); return true;
      case 'isolate': {
        if (isolated) { console.log(dim(`already isolated in ${isolated.info.path}`)); return true; }
        isolated = await isolate(core, session, args.cwd, renderer);
        if (!isolated) { console.log(red('not a git repository — cannot isolate')); }
        return true;
      }
      case 'apply': case 'discard': {
        if (!isolated) { console.log(dim('this session is not isolated — /isolate first')); return true; }
        if (cmd === 'apply') {
          if (!(await finishIsolated(isolated, true, renderer, false))) { return true; }
        } else {
          const changes = await isolated.mgr.changes(isolated.info).catch(() => []);
          await isolated.mgr.remove(isolated.info);
          console.log(yellow(`discarded the isolated worktree${changes.length ? ` (${changes.length} changed file${changes.length === 1 ? '' : 's'})` : ''}`));
        }
        isolated = undefined;
        session.worktree = undefined;
        store.save(session);
        return true;
      }
      case 'clear':
        await core.runner.hooks?.sessionEnd(session.id, 'clear', runRoot());
        session.messages = []; session.contextTokens = 0; session.compactions = 0; session.todos = []; alwaysKinds.clear(); await store.clearArchive(session.id); store.save(session); console.log(dim('conversation cleared')); return true;
      case 'file': case 'attach': if (arg) { pendingFiles.push(arg); console.log(dim(`will attach ${arg}`)); } return true;
      case 'doctor': await cmdDoctor(core); return true;
      case 'history': case 'resume': case 'fork':
        return sessionSlash(cmd, arg, { store, current: () => session, switchTo, ask: (q) => ask(q), style: STYLE });
      case 'recovery':
        return recoverySlash(cmd, arg, { service: core.healing.service, store: core.healing.store, sessionId: () => session.id, root: runRoot, budget: (st) => attemptBudget(getConfig().healing, st), resume: resumeRecovery, style: STYLE });
      case 'compact': case 'smol': case 'skills': case 'agents': case 'mcp': case 'memory': case 'context': case 'yes': case 'auto': case 'settings': case 'plugins':
        return infoSlash(cmd, arg, { session: () => session, store, providers: core.providers, skills: core.skills, memory: core.memory, workspace: core.workspace, plugins: core.plugins, mcp: core.mcp, style: STYLE, md, status: (t) => (t ? renderer.status(t) : renderer.clearStatus()), onAutoApprove: () => rl!.setPrompt(promptText()) });
      case 'skill': case 'agent': {
        const task = taskCommand(core, cmd, arg);
        if (!task || 'error' in task) { console.log(task ? red(task.error) : dim(`usage: /${cmd} <name> <task>`)); return true; }
        rl!.setPrompt('');
        current = new RunControl(session.id);
        try {
          currentRun = runTurn(core, session, task.prompt, pendingFiles, renderer, rl, current, { display: line });
          await currentRun;
          pendingFiles = [];
          changesSummary(core, session);
        } catch (e) {
          renderer.error(e instanceof Error ? e.message : String(e));
        } finally {
          leftovers(current);
          current = undefined;
          currentRun = undefined;
          process.stdout.write('\n');
          rl!.setPrompt(promptText());
        }
        return true;
      }
      case 'prompts': {
        // Saved prompts are the custom commands in .localpilot/commands (this folder) and ~/.localpilot/commands.
        const items = promptItems(core.commands, promptDirs(args.cwd, os.homedir()), [args.cwd]);
        const q = arg.trim();
        const shown = q ? searchPrompts(items, q) : items;
        console.log(shown.length ? shown.map((i) => `  ${bold(i.invoke)}${i.argumentHint ? ` ${dim(i.argumentHint)}` : ''}  ${i.description || i.body.split('\n')[0].slice(0, 80)}  ${dim(i.scope === 'workspace' ? 'workspace' : i.scope === 'user' ? 'you' : i.origin)}`).join('\n') : dim(q ? `no saved prompt matches “${q}”` : 'no saved prompts — add markdown files under .localpilot/commands (this folder) or ~/.localpilot/commands (you); save them from the VS Code chat with ⋯ → Save as prompt…'));
        return true;
      }
      case 'commands': {
        console.log(core.commands.length ? core.commands.map((c) => `  ${bold(c.invoke)}${c.argumentHint ? ` ${dim(c.argumentHint)}` : ''}  ${c.description}${c.plugin ? dim(`  (plugin ${c.plugin})`) : ''}`).join('\n') : dim('no custom commands — add markdown files under .localpilot/commands or .claude/commands'));
        const prompts = core.mcp?.promptCommands ?? [];
        if (prompts.length) {
          console.log(`${bold('MCP prompts')}\n${prompts.map((p) => `  ${bold(p.invoke)}${p.argumentHint ? ` ${dim(p.argumentHint)}` : ''}  ${p.description}`).join('\n')}`);
        }
        return true;
      }
      case 'permissions': {
        const p = core.settings.permissions;
        const fmt = (l: string[]) => (l.length ? l.join(', ') : dim('none'));
        console.log(`  deny:  ${fmt(p.deny)}\n  ask:   ${fmt(p.ask)}\n  allow: ${fmt(p.allow)}${p.defaultMode ? `\n  defaultMode: ${p.defaultMode}` : ''}\n  ${dim(core.settings.sources.length ? `from ${core.settings.sources.join(', ')}` : 'no settings.json found')}`);
        return true;
      }
      case 'hooks': {
        const entries = Object.entries(core.settings.hooks);
        if (!getConfig().hooksEnabled) {
          console.log(yellow('  Hooks are disabled (localpilot.hooks.enabled = false).'));
        }
        console.log(entries.length ? entries.map(([ev, ms]) => `  ${bold(ev)}: ${ms.map((m) => `${m.matcher ? `${m.matcher} → ` : ''}${m.hooks.map((h) => h.command).join(', ')}`).join('; ')}`).join('\n') : dim('no hooks configured (settings.json → "hooks")'));
        return true;
      }
      default: {
        // `/deep-planning <task>` runs one turn in Plan mode and saves its answer as implementation_plan.md. It is
        // built in, so it beats a command or skill of that name, and its task text is never expanded.
        const planning = normalizeCommandName(cmd) === 'deep-planning';
        let hit: Awaited<ReturnType<typeof expandSlash>>;
        try {
          hit = planning ? undefined : await expandSlash(line, (n) => console.log(yellow(`  ${n}`)));
        } catch (e) {
          console.log(red(e instanceof Error ? e.message : String(e)));
          return true;
        }
        if (planning && !arg) {
          console.log(dim('usage: /deep-planning <task>'));
          return true;
        }
        if (hit || planning) {
          const modeBefore = planning && session.mode !== 'plan' ? session.mode : undefined;
          if (modeBefore) {
            session.mode = 'plan';
          }
          rl!.setPrompt('');
          current = new RunControl(session.id);
          try {
            const run = hit ? runTurn(core, session, hit.text, pendingFiles, renderer, rl, current, hit.opts) : runTurn(core, session, deepPlanningPrompt(arg), pendingFiles, renderer, rl, current, { display: line });
            currentRun = run;
            const answer = await run;
            pendingFiles = [];
            changesSummary(core, session);
            // Only a finished answer is a plan: an error, the step limit or a stop leaves any existing file alone.
            if (planning && (await saveImplementationPlan(runRoot(), { text: answer, completed: lastTurnAnswered, errored: !!lastTurnError, aborted: current.aborted }))) {
              console.log(dim(`plan saved to implementation_plan.md — /mode agent, then "implement the plan"`));
            }
          } catch (e) {
            renderer.error(e instanceof Error ? e.message : String(e));
          } finally {
            if (modeBefore && session.mode === 'plan') {
              session.mode = modeBefore;
            }
            leftovers(current);
            current = undefined;
            currentRun = undefined;
            process.stdout.write('\n');
            rl!.setPrompt(promptText());
          }
          return true;
        }
        console.log(dim(`unknown command /${cmd} — /help`));
        return false;
      }
    }
  };

  const runPrompt = async (line: string): Promise<void> => {
    // The input stays live during the run so Ctrl+C / Ctrl+Z / steering lines keep working; only the prompt goes away.
    rl!.setPrompt('');
    current = new RunControl(session.id);
    try {
      // A custom command or workflow named mid-message (`then /review it`) is expanded where it stands.
      const inline = line.startsWith('/') ? undefined : await expandSlash(line, (n) => console.log(yellow(`  ${n}`)));
      // `@path` (Tab-completed) attaches that file, or sends that image, with the message.
      const refs = atRefs(line, runRoot());
      const images = (await Promise.all(refs.images.map((f) => readImage(f)))).flatMap((i) => (i ? [i.data] : []));
      currentRun = runTurn(core, session, inline?.text ?? line, [...pendingFiles, ...refs.files], renderer, rl, current, { ...inline?.opts, images });
      await currentRun;
      pendingFiles = [];
      changesSummary(core, session);
    } catch (e) {
      renderer.error(e instanceof Error ? e.message : String(e));
    } finally {
      leftovers(current);
      current = undefined;
      currentRun = undefined;
      process.stdout.write('\n');
      rl!.setPrompt(promptText());
    }
  };
  /** Prompts the next queued lines (typed too late to steer the last run), or shows the prompt. */
  const next = async (): Promise<void> => {
    // Leftover steering first (it belongs to the turn that just ended), then each `>>` line as a turn of its own.
    while (!current && (deferred.length || afterTurn.length)) {
      await runPrompt(deferred.length ? deferred.splice(0).join('\n\n') : afterTurn.shift()!);
    }
    await promptWithStatus();
  };
  /** The dim status line (`model · mode · ctx 34% · main +3 −1 · auto:off · $0.02`), then the prompt. */
  const promptWithStatus = async (): Promise<void> => {
    if (process.stdout.isTTY) {
      const win = core.providers.cachedModels().find((m) => m.id === (session.model || getConfig().defaultModel));
      const ctxPercent = contextPercent(session.contextTokens, win ? effectiveContextWindow(win, getConfig().contextWindow) : undefined);
      const git = await gitState(runRoot());
      if (current) {
        return; // a run started meanwhile
      }
      process.stdout.write(`${dim(statusLineText({ model: session.model || modelInfo.id, mode: session.mode, ctxPercent, git, auto: isAutoApprove(), costUsd: session.usage?.costUsd }))}\n`);
    }
    rl!.setPrompt(promptText());
    rl!.prompt();
  };
  /** `/queue`: steers the running agent has not read yet, then the `>>` lines waiting for the turn to end. */
  let steerSeq = 0;
  const queueRows = (): { kind: 'steer' | 'after'; text: string; steerId?: string }[] => [
    ...(current?.pendingSteers() ?? []).map((m) => ({ kind: 'steer' as const, text: m.content, steerId: m.meta?.steerId })),
    ...afterTurn.map((text) => ({ kind: 'after' as const, text })),
  ];
  const queueCommand = (line: string): boolean => {
    const cmd = parseRunLine(line);
    if (cmd.kind === 'list') {
      const rows = queueRows();
      console.log(rows.length ? rows.map((r, i) => `  ${i + 1}. ${r.kind === 'steer' ? amber('steering') : cyan('next turn')}  ${r.text.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n') : dim('the queue is empty'));
      return true;
    }
    if (cmd.kind === 'remove') {
      const row = queueRows()[cmd.index - 1];
      const gone = !row ? false : row.kind === 'steer' ? !!(row.steerId && current?.removeSteer(row.steerId)) : afterTurn.splice(cmd.index - 1 - (current?.pendingSteers().length ?? 0), 1).length > 0;
      console.log(gone ? dim(`removed ${cmd.index}: ${row!.text.replace(/\s+/g, ' ').slice(0, 80)}`) : yellow(`no queued message ${cmd.index} — /queue lists them`));
      return true;
    }
    if (cmd.kind === 'queueUsage') {
      console.log(dim('/queue lists queued messages · /queue rm N removes one'));
      return true;
    }
    return false;
  };

  void promptWithStatus();
  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (current) {
      // Typed while the agent works: queue it for the next step rather than refusing or waiting.
      if (line && queueCommand(line)) {
        return;
      }
      const run = parseRunLine(line);
      if (run.kind === 'after') {
        if (run.text) {
          afterTurn.push(run.text);
          renderer.note(`↩ runs after this turn (${afterTurn.length} queued): ${run.text.slice(0, 80)}`);
        }
        return;
      }
      if (line) {
        if (!current.aborted && current.steer({ role: 'user', content: line, meta: { steerId: `cli_${++steerSeq}` } })) {
          renderer.note(`↩ queued for the agent: ${line.slice(0, 80)}${current.paused ? ' (Ctrl+Z to resume)' : ''}`);
        } else {
          deferred.push(line);
          renderer.note(`↩ the run is ending — this runs next: ${line.slice(0, 80)}`);
        }
      }
      return;
    }
    if (busy) {
      if (line) { renderer.note('busy — wait for the current command to finish'); }
      return;
    }
    if (!line) { rl!.prompt(); return; }
    if (queueCommand(line)) {
      rl!.prompt();
      return;
    }
    if (line.startsWith('>>')) {
      // Nothing is running, so "after this turn" is now.
      const text = line.slice(2).trim();
      if (text) { await runPrompt(text); }
      await next();
      return;
    }
    if (line.startsWith('/')) {
      busy = true;
      try {
        if (await slash(line)) {
          core.telemetry.record({ type: 'slash', command: line.slice(1).split(/\s+/)[0] });
        }
      } catch (e) {
        renderer.error(e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
      }
      await next();
      return;
    }
    await runPrompt(line);
    await next();
  });
}

main().catch((e) => {
  console.error(`${red('✖')} ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
