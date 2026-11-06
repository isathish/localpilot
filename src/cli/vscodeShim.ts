 
/**
 * Node implementation of the subset of the `vscode` API that LocalPilot's agent core uses.
 * It lets the same providers, tools, skills, memory and change tracker run in a plain terminal
 * (the `localpilot` CLI) with no editor process. Documents are a real in-memory model: edits are
 * applied to the open document and written on `save()`, exactly like the editor path.
 */
import * as cp from 'child_process';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { stripJsonc } from '../agent/jsonc';
import { DEFAULT_PROVIDERS } from '../providers/defaultProviders';
import { shellInvocation } from '../terminal/shell';

// ------------------------------------------------------------------ primitives
export class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
  static from(...ds: { dispose(): void }[]): Disposable {
    return new Disposable(() => ds.forEach((d) => d.dispose()));
  }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>();
  readonly event = (l: (e: T) => void): Disposable => {
    this.listeners.add(l);
    return new Disposable(() => this.listeners.delete(l));
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      l(e);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  readonly scheme: string;
  readonly path: string;
  readonly query: string;
  private constructor(scheme: string, p: string, query = '') {
    this.scheme = scheme;
    this.path = p;
    this.query = query;
  }
  get fsPath(): string {
    return this.path;
  }
  static file(p: string): Uri {
    return new Uri('file', path.resolve(p));
  }
  static parse(s: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^?]*)(?:\?(.*))?$/i.exec(s);
    if (!m) {
      return Uri.file(s);
    }
    return new Uri(m[1], decodeURIComponent(m[2]), m[3] ?? '');
  }
  static from(c: { scheme: string; path?: string; query?: string }): Uri {
    return new Uri(c.scheme, c.path ?? '', c.query ?? '');
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, path.join(base.path, ...segments), base.query);
  }
  with(change: { scheme?: string; path?: string; query?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.query ?? this.query);
  }
  toString(): string {
    return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}`;
  }
  toJSON(): unknown {
    return { scheme: this.scheme, path: this.path };
  }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
  isBefore(o: Position): boolean {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isEqual(o: Position): boolean {
    return this.line === o.line && this.character === o.character;
  }
  translate(dl = 0, dc = 0): Position {
    return new Position(this.line + dl, this.character + dc);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c!, d!);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
}

export class Selection extends Range {
  get active(): Position {
    return this.end;
  }
  get anchor(): Position {
    return this.start;
  }
}

export class Location {
  constructor(readonly uri: Uri, readonly range: Range) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class ThemeIcon {
  constructor(readonly id: string) {}
}
export class Diagnostic {
  constructor(readonly range: Range, readonly message: string, readonly severity = 0) {}
}
export class SymbolInformation {}
export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;
  constructor(base: Uri | string | { uri: Uri }, readonly pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri ? base : base.uri;
    this.base = this.baseUri.fsPath;
  }
}
export class TabInputText {
  constructor(readonly uri: Uri) {}
}
export class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri
  ) {}
}
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}
export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}
export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
}

// ------------------------------------------------------------------ documents
const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  json: 'json', jsonc: 'jsonc', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown', html: 'html', css: 'css', scss: 'scss', sql: 'sql', xml: 'xml', txt: 'plaintext',
};

export class TextDocument {
  private text: string;
  isDirty = false;
  readonly languageId: string;
  constructor(readonly uri: Uri, text: string) {
    this.text = text;
    this.languageId = LANGS[path.extname(uri.fsPath).slice(1).toLowerCase()] ?? 'plaintext';
  }
  get fileName(): string {
    return this.uri.fsPath;
  }
  get lineCount(): number {
    return this.text.split('\n').length;
  }
  getText(range?: Range): string {
    if (!range) {
      return this.text;
    }
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  lineAt(line: number | Position): { text: string; lineNumber: number; range: Range; isEmptyOrWhitespace: boolean } {
    const n = typeof line === 'number' ? line : line.line;
    const text = (this.text.split('\n')[n] ?? '').replace(/\r$/, '');
    return { text, lineNumber: n, range: new Range(n, 0, n, text.length), isEmptyOrWhitespace: !text.trim() };
  }
  positionAt(offset: number): Position {
    const before = this.text.slice(0, Math.max(0, Math.min(offset, this.text.length)));
    const lines = before.split('\n');
    return new Position(lines.length - 1, lines[lines.length - 1].length);
  }
  offsetAt(pos: Position): number {
    const lines = this.text.split('\n');
    if (pos.line >= lines.length) {
      return this.text.length;
    }
    let off = 0;
    for (let i = 0; i < pos.line; i++) {
      off += lines[i].length + 1;
    }
    return off + Math.min(pos.character, lines[pos.line].length);
  }
  /** @internal apply edits bottom-up so earlier offsets stay valid. */
  _apply(edits: { range: Range; text: string }[]): void {
    const sorted = edits.map((e) => ({ s: this.offsetAt(e.range.start), e: this.offsetAt(e.range.end), t: e.text })).sort((a, b) => b.s - a.s);
    for (const e of sorted) {
      this.text = this.text.slice(0, e.s) + e.t + this.text.slice(e.e);
    }
    this.isDirty = true;
  }
  /** @internal refresh a clean document from disk, keeping the same instance. */
  _reset(text: string): void {
    this.text = text;
  }
  async save(): Promise<boolean> {
    await fsp.mkdir(path.dirname(this.uri.fsPath), { recursive: true });
    await fsp.writeFile(this.uri.fsPath, this.text, 'utf8');
    this.isDirty = false;
    return true;
  }
}

const docs = new Map<string, TextDocument>();

export class WorkspaceEdit {
  readonly edits = new Map<string, { range: Range; text: string }[]>();
  /** Files to create (write_file on a new path); applied before text edits so an edit to a new file lands on it. */
  readonly creates = new Map<string, { contents: Uint8Array; overwrite: boolean }>();
  replace(uri: Uri, range: Range, text: string): void {
    const list = this.edits.get(uri.fsPath) ?? [];
    list.push({ range, text });
    this.edits.set(uri.fsPath, list);
  }
  insert(uri: Uri, pos: Position, text: string): void {
    this.replace(uri, new Range(pos, pos), text);
  }
  delete(uri: Uri, range: Range): void {
    this.replace(uri, range, '');
  }
  createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }): void {
    this.creates.set(uri.fsPath, { contents: options?.contents ?? new Uint8Array(), overwrite: !!options?.overwrite || !options?.ignoreIfExists });
  }
  /** Files to delete (apply_patch); applied last, to ~/.localpilot/trash like delete_path. */
  readonly deletes = new Set<string>();
  deleteFile(uri: Uri, _options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this.deletes.add(uri.fsPath);
  }
}

// ------------------------------------------------------------------ configuration
export const USER_SETTINGS_PATH = (() => {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Code', 'User', 'settings.json');
})();
/** The extension's snapshot of the active profile's user settings when available, else the first VS Code-family settings.json found. */
export function userSettingsPath(): string {
  const snapshot = process.env.LOCALPILOT_VSCODE_SETTINGS;
  if (snapshot && fs.existsSync(snapshot)) {
    return snapshot;
  }
  if (fs.existsSync(USER_SETTINGS_PATH)) {
    return USER_SETTINGS_PATH;
  }
  const appData = path.dirname(path.dirname(path.dirname(USER_SETTINGS_PATH)));
  for (const app of ['Code - Insiders', 'Cursor', 'VSCodium', 'Code - OSS', 'Windsurf']) {
    const file = path.join(appData, app, 'User', 'settings.json');
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return USER_SETTINGS_PATH;
}
export const CLI_SETTINGS_PATH = path.join(os.homedir(), '.localpilot', 'config.json');

/** Settings files that exist but do not parse: their settings are ignored and the CLI refuses to overwrite them. */
const brokenFiles = new Set<string>();
function readJsonc(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const v = raw.trim() ? JSON.parse(stripJsonc(raw)) : {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('not a JSON object');
    }
    brokenFiles.delete(file);
    return v as Record<string, unknown>;
  } catch (e) {
    if (!brokenFiles.has(file)) {
      brokenFiles.add(file);
      process.stderr.write(`\x1b[33m!\x1b[0m ${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); its settings are ignored until it is fixed.\n`);
    }
    return {};
  }
}
function assertWritable(file: string): void {
  if (brokenFiles.has(file)) {
    throw new Error(`fix ${file} first: it is not valid JSON`);
  }
}

/** Defaults the CLI applies when no settings file sets a key and the caller passes none (package.json's defaults in VS Code). */
export const SETTING_DEFAULTS: Readonly<Record<string, unknown>> = {
  'healing.enabled': true,
  'healing.autoDetect': true,
  'healing.autoRetry': true,
  'healing.autoFix': true,
  'healing.regressionRequired': true,
  'healing.maxRepairAttempts': 3,
  'healing.maxTotalAttempts': 8,
  'healing.extraSteps': 16,
  'healing.taskDeadlineMinutes': 60,
  'healing.checkTiming': 'onComplete',
  'healing.scopeTests': true,
  'healing.checkTimeoutSeconds': 300,
  'healing.checkTimeBudgetSeconds': 900,
  'healing.baseline': 'fast',
  'healing.checks': [],
  'healing.policies': {},
  'healing.dependencyInstall': 'ask',
  'healing.gitConflicts': 'escalate',
  'healing.securityCheck': 'changed',
  'healing.delegateFixes': true,
  'healing.memory': 'workspace',
};
const settingDefault = (key: string): unknown => {
  const v = SETTING_DEFAULTS[key];
  return v && typeof v === 'object' ? structuredClone(v) : v;
};

/** Flattened `localpilot.*` settings. Precedence: VS Code user settings < workspace .vscode/settings.json < ~/.localpilot/config.json < CLI flags. */
const settings: Record<string, unknown> = {};
export const cliOverrides: Record<string, unknown> = {};
function flatten(obj: Record<string, unknown>, into: Record<string, unknown>, prefix = ''): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !['providers', 'mcpServers', 'repos', 'headers', 'policies', 'toolApprovals'].includes(key.split('.').pop()!)) {
      flatten(v as Record<string, unknown>, into, key);
    } else {
      into[key] = v;
    }
  }
}

/** Settings a cloned repo's .vscode/settings.json must not set unless the workspace is trusted (they choose endpoints, commands and approvals). */
const SENSITIVE_WORKSPACE_KEYS = ['providers', 'defaultModel', 'routing.', 'mcpServers', 'approvals.', 'autoMode.', 'hooks.', 'pluginPaths', 'skillsPaths', 'skills.repositories', 'webSearch.', 'storage.redis.', 'terminal.', 'inlineCompletion.model', 'healing.enabled', 'healing.checks', 'healing.securityCheck'];
let trustWorkspace = process.env.LOCALPILOT_TRUST_WORKSPACE === '1';
export function setTrustWorkspace(v: boolean): void {
  trustWorkspace = v;
}
/** Workspace keys skipped by the last loadSettings because the workspace is not trusted. */
export const ignoredWorkspaceSettings: string[] = [];
const isSensitive = (key: string) => SENSITIVE_WORKSPACE_KEYS.some((p) => {
  const base = p.replace(/\.$/, '');
  return key === base || key.startsWith(`${base}.`);
});
/** Read only from user settings or ~/.localpilot/config.json, never from a workspace, trusted or not (`scope: application` in VS Code). */
const isUserOnly = (key: string) => key === 'routing.fallbackModels' || key === 'mcp.toolApprovals' || key === 'hooks.enabled' || key === 'healing.dependencyInstall' || key === 'healing.securityCheck' || key === 'approvals' || key.startsWith('approvals.') || key === 'autoMode' || key.startsWith('autoMode.') || key.startsWith('telemetry.otlp.');

export function loadSettings(workspaceRoot?: string): void {
  for (const k of Object.keys(settings)) {
    delete settings[k];
  }
  ignoredWorkspaceSettings.length = 0;
  const fromVsCode = (file: string, workspace: boolean) => {
    const flat: Record<string, unknown> = {};
    flatten(readJsonc(file), flat);
    for (const [k, v] of Object.entries(flat)) {
      if (k.startsWith('localpilot.')) {
        const key = k.slice('localpilot.'.length);
        if (workspace && isUserOnly(key)) {
          continue;
        }
        if (workspace && !trustWorkspace && isSensitive(key)) {
          ignoredWorkspaceSettings.push(key);
          continue;
        }
        settings[key] = v;
      }
    }
  };
  fromVsCode(userSettingsPath(), false);
  if (workspaceRoot) {
    fromVsCode(path.join(workspaceRoot, '.vscode', 'settings.json'), true);
  }
  const cli: Record<string, unknown> = {};
  flatten(readJsonc(CLI_SETTINGS_PATH), cli);
  for (const [k, v] of Object.entries(cli)) {
    const key = k.replace(/^localpilot\./, '');
    // Providers added from the CLI join VS Code's list by id instead of replacing it, so both keep working.
    settings[key] = key === 'providers' ? mergeProviders(settings.providers ?? DEFAULT_PROVIDERS, v) : v;
  }
  Object.assign(settings, cliOverrides);
}

/** The merged `localpilot.*` settings the CLI runs with, by flattened key (`/settings`, `localpilot config`). */
export function effectiveSettings(): Record<string, unknown> {
  return { ...settings };
}

/** `over` entries replace or extend same-id entries of `base` field by field; new ids are appended (patches of unknown ids are dropped). */
export function mergeProviders(base: unknown, over: unknown): unknown {
  if (!Array.isArray(over)) {
    return base;
  }
  const out = Array.isArray(base) ? base.map((p) => ({ ...(p as object) })) as Record<string, unknown>[] : [];
  for (const o of over as Record<string, unknown>[]) {
    const i = out.findIndex((p) => p.id === o?.id);
    if (i >= 0) {
      out[i] = { ...out[i], ...o };
    } else if (o && typeof o === 'object' && o.type && o.baseUrl) {
      out.push({ ...o });
    }
  }
  return out;
}

/** The CLI's own config file (`~/.localpilot/config.json`), raw. */
export function readCliConfig(): Record<string, unknown> {
  return readJsonc(CLI_SETTINGS_PATH);
}

export async function writeCliConfig(cfg: Record<string, unknown>): Promise<void> {
  assertWritable(CLI_SETTINGS_PATH);
  await fsp.mkdir(path.dirname(CLI_SETTINGS_PATH), { recursive: true });
  await fsp.writeFile(CLI_SETTINGS_PATH, JSON.stringify(cfg, null, 2) + '\n');
  loadSettings(workspaceRoot);
  configEmitter.fire({ affectsConfiguration: (s: string) => s === 'localpilot' || s.startsWith('localpilot.providers') });
}

/**
 * API keys for `${secret:<name>}` references when running outside VS Code, which has the OS keychain the CLI cannot
 * reach. Readable by the owner only. `LOCALPILOT_KEY_<NAME>` environment variables work too.
 */
export const CLI_KEYS_PATH = path.join(os.homedir(), '.localpilot', 'keys.json');

export function readCliKeys(): Record<string, string> {
  const raw = readJsonc(CLI_KEYS_PATH);
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]));
}

export async function writeCliKey(name: string, key: string | undefined): Promise<void> {
  const keys = readCliKeys();
  assertWritable(CLI_KEYS_PATH);
  if (key) {
    keys[name] = key;
  } else {
    delete keys[name];
  }
  await fsp.mkdir(path.dirname(CLI_KEYS_PATH), { recursive: true, mode: 0o700 });
  await fsp.writeFile(CLI_KEYS_PATH, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  // writeFile keeps the mode of an existing file: tighten it in case it was created more permissively.
  await fsp.chmod(CLI_KEYS_PATH, 0o600).catch(() => undefined);
}

const configEmitter = new EventEmitter<{ affectsConfiguration(s: string): boolean }>();

// ------------------------------------------------------------------ interaction (terminal)
let rl: readline.Interface | undefined;
export function setReadline(r: readline.Interface | undefined): void {
  rl = r;
}
let autoApprove = false;
export function setAutoApprove(v: boolean): void {
  autoApprove = v;
}
export function isAutoApprove(): boolean {
  return autoApprove;
}
/** Where prompts and pickers are written: stderr in --print / piped runs, so stdout carries the answer only. */
let promptOut: NodeJS.WritableStream = process.stdout;
export function setPromptOutput(s: NodeJS.WritableStream): void {
  promptOut = s;
}
/** Terminal prompts run one at a time, in order: parallel tool calls and subagents queue instead of sharing a line. */
let promptChain: Promise<unknown> = Promise.resolve();
export function withPromptLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = promptChain.then(fn, fn);
  promptChain = run.catch(() => undefined);
  return run;
}
/** Read one line; undefined without a TTY, on Ctrl+D (interface closed) or when `signal` aborts (the run was stopped). */
export async function ask(question: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!process.stdin.isTTY || signal?.aborted) {
    return undefined;
  }
  // One-shot runs have no REPL interface: a temporary one per prompt (closed after, so the terminal is back in
  // cooked mode and Ctrl+C / Ctrl+Z reach the run). Callers hold withPromptLock, so these never overlap.
  const own = !rl;
  const r = rl ?? readline.createInterface({ input: process.stdin, output: promptOut });
  if (own) {
    // Ctrl+C at the prompt stops the run (the one-shot SIGINT handler) instead of being swallowed by readline.
    r.on('SIGINT', () => {
      if (process.listenerCount('SIGINT')) {
        process.emit('SIGINT');
      } else {
        r.close();
        process.kill(process.pid, 'SIGINT');
      }
    });
  }
  let cleanup = () => {};
  try {
    return await new Promise<string | undefined>((resolve) => {
      const done = () => resolve(undefined);
      r.once('close', done);
      signal?.addEventListener('abort', done, { once: true });
      cleanup = () => {
        r.off('close', done);
        signal?.removeEventListener('abort', done);
      };
      r.question(question, signal ? { signal } : {}, resolve);
    });
  } finally {
    cleanup();
    if (own) {
      r.close();
    }
  }
}

// ------------------------------------------------------------------ workspace
let workspaceRoot: string | undefined = process.cwd();
export function setWorkspaceRoot(root: string | undefined): void {
  workspaceRoot = root ? path.resolve(root) : undefined;
  loadSettings(workspaceRoot);
}

function globSource(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1);
      if (end < 0) {
        re += '\\{';
        continue;
      }
      re += `(?:${glob.slice(i + 1, end).split(',').map((s) => globSource(s.trim())).join('|')})`;
      i = end;
    } else {
      re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
  }
  return re;
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`);
}

async function walk(dir: string, rel: string, include: RegExp, exclude: RegExp | undefined, out: Uri[], max: number): Promise<void> {
  if (out.length >= max) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) {
      return;
    }
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (exclude && (exclude.test(r) || exclude.test(`${r}/`) || exclude.test(`${r}/x`))) {
      continue;
    }
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === 'node_modules') {
        continue;
      }
      await walk(path.join(dir, e.name), r, include, exclude, out, max);
    } else if (include.test(r)) {
      out.push(Uri.file(path.join(dir, e.name)));
    }
  }
}

export const workspace = {
  get workspaceFolders(): { uri: Uri; name: string; index: number }[] | undefined {
    return workspaceRoot ? [{ uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 }] : undefined;
  },
  get textDocuments(): TextDocument[] {
    // Only unsaved documents: clean ones may be stale, so callers read the disk for those.
    return [...docs.values()].filter((d) => d.isDirty);
  },
  asRelativePath(p: string | Uri): string {
    const fp = typeof p === 'string' ? p : p.fsPath;
    return workspaceRoot && fp.startsWith(workspaceRoot + path.sep) ? fp.slice(workspaceRoot.length + 1) : fp;
  },
  getConfiguration(section?: string) {
    const prefix = section && section !== 'localpilot' ? `${section.replace(/^localpilot\./, '')}.` : '';
    return {
      get<T>(key: string, def?: T): T {
        const v = settings[prefix + key];
        return (v !== undefined ? v : def !== undefined ? def : settingDefault(prefix + key)) as T;
      },
      inspect<T>(key: string) {
        // Only what is saved in ~/.localpilot/config.json counts as the user's value; -m and VS Code's settings are not ours to clear.
        const saved: Record<string, unknown> = {};
        flatten(readJsonc(CLI_SETTINGS_PATH), saved);
        const v = (saved[prefix + key] ?? saved[`localpilot.${prefix}${key}`]) as T | undefined;
        return { key, globalValue: v, defaultValue: settingDefault(prefix + key) as T | undefined, workspaceValue: undefined as T | undefined, workspaceFolderValue: undefined as T | undefined };
      },
      async update(key: string, value: unknown): Promise<void> {
        // CLI-side changes (e.g. default model) go to ~/.localpilot/config.json; VS Code's settings.json is never written.
        const cfg = readJsonc(CLI_SETTINGS_PATH);
        assertWritable(CLI_SETTINGS_PATH);
        if (value === undefined) {
          delete cfg[prefix + key];
          delete cfg[`localpilot.${prefix}${key}`];
        } else {
          cfg[prefix + key] = value;
        }
        await fsp.mkdir(path.dirname(CLI_SETTINGS_PATH), { recursive: true });
        await fsp.writeFile(CLI_SETTINGS_PATH, JSON.stringify(cfg, null, 2) + '\n');
        loadSettings(workspaceRoot);
        configEmitter.fire({ affectsConfiguration: (s: string) => s === 'localpilot' || `localpilot.${prefix}${key}`.startsWith(s) });
      },
    };
  },
  onDidChangeConfiguration: configEmitter.event,
  onDidChangeTextDocument: () => new Disposable(),
  onDidSaveTextDocument: () => new Disposable(),
  createFileSystemWatcher: () => ({ onDidChange: () => new Disposable(), onDidCreate: () => new Disposable(), onDidDelete: () => new Disposable(), dispose() {} }),
  registerTextDocumentContentProvider: () => new Disposable(),
  async openTextDocument(uriOrOptions: Uri | string | { content?: string; language?: string }): Promise<TextDocument> {
    if (typeof uriOrOptions === 'object' && !(uriOrOptions instanceof Uri)) {
      return new TextDocument(Uri.from({ scheme: 'untitled', path: `untitled-${Date.now()}` }), uriOrOptions.content ?? '');
    }
    const uri = typeof uriOrOptions === 'string' ? Uri.file(uriOrOptions) : uriOrOptions;
    const cached = docs.get(uri.fsPath);
    if (cached?.isDirty) {
      return cached;
    }
    const text = await fsp.readFile(uri.fsPath, 'utf8'); // throws for missing files, like the editor
    if (cached) {
      cached._reset(text);
      return cached;
    }
    const doc = new TextDocument(uri, text);
    docs.set(uri.fsPath, doc);
    return doc;
  },
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    for (const [fsPath, c] of edit.creates) {
      if (fs.existsSync(fsPath) && !c.overwrite) {
        continue;
      }
      await fsp.mkdir(path.dirname(fsPath), { recursive: true });
      await fsp.writeFile(fsPath, c.contents);
      docs.set(fsPath, new TextDocument(Uri.file(fsPath), Buffer.from(c.contents).toString('utf8')));
    }
    for (const [fsPath, edits] of edit.edits) {
      let doc = docs.get(fsPath);
      if (!doc) {
        doc = new TextDocument(Uri.file(fsPath), fs.existsSync(fsPath) ? await fsp.readFile(fsPath, 'utf8') : '');
        docs.set(fsPath, doc);
      }
      doc._apply(edits);
    }
    for (const fsPath of edit.deletes) {
      if (fs.existsSync(fsPath)) {
        await workspace.fs.delete(Uri.file(fsPath), { useTrash: true });
      }
      docs.delete(fsPath);
    }
    return true;
  },
  async findFiles(include: string | RelativePattern, exclude?: string | RelativePattern | null, maxResults = 10_000): Promise<Uri[]> {
    // A RelativePattern searches its own folder (an isolated worktree), not the workspace root.
    const base = typeof include === 'string' ? workspaceRoot : include.baseUri.fsPath || include.base;
    if (!base) {
      return [];
    }
    const glob = (g: string | RelativePattern): RegExp => globToRegExp(typeof g === 'string' ? g : g.pattern);
    const out: Uri[] = [];
    await walk(base, '', glob(include), exclude ? glob(exclude) : undefined, out, maxResults);
    return out;
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      return new Uint8Array(await fsp.readFile(uri.fsPath));
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, content);
      docs.delete(uri.fsPath);
    },
    async readDirectory(uri: Uri): Promise<[string, FileType][]> {
      const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
      // Like VS Code: a symlink reports its target's type plus SymbolicLink, and Unknown when the link is broken.
      return Promise.all(entries.map(async (e): Promise<[string, FileType]> => {
        if (!e.isSymbolicLink()) {
          return [e.name, e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : FileType.Unknown];
        }
        const st = await fsp.stat(path.join(uri.fsPath, e.name)).catch(() => undefined);
        return [e.name, st ? (st.isDirectory() ? FileType.Directory : st.isFile() ? FileType.File : FileType.Unknown) | FileType.SymbolicLink : FileType.Unknown];
      }));
    },
    async stat(uri: Uri): Promise<{ type: FileType; size: number; mtime: number; ctime: number }> {
      const s = await fsp.stat(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
    },
    async createDirectory(uri: Uri): Promise<void> {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    async delete(uri: Uri, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
      if (opts?.useTrash) {
        // No system trash from a terminal: deleted paths go to ~/.localpilot/trash so they can be recovered.
        const exists = await fsp.lstat(uri.fsPath).then(
          () => true,
          () => false
        );
        if (exists) {
          const trash = path.join(os.homedir(), '.localpilot', 'trash');
          await fsp.mkdir(trash, { recursive: true });
          const dest = path.join(trash, `${Date.now()}-${path.basename(uri.fsPath)}`);
          try {
            await fsp.rename(uri.fsPath, dest);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EXDEV') {
              throw e;
            }
            await fsp.cp(uri.fsPath, dest, { recursive: true });
            await fsp.rm(uri.fsPath, { recursive: true });
          }
        }
      } else {
        await fsp.rm(uri.fsPath, { recursive: !!opts?.recursive, force: true });
      }
      docs.delete(uri.fsPath);
    },
    async rename(a: Uri, b: Uri): Promise<void> {
      await fsp.rename(a.fsPath, b.fsPath);
    },
  },
};

// ------------------------------------------------------------------ logging
export interface LogOutputChannel {
  trace(m: string): void;
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  appendLine(m: string): void;
  show(): void;
  dispose(): void;
}
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
let stderrLevel = 3;
/** The least severe level also shown on stderr (`off`: the log file only, e.g. `--json` runs). */
export function setLogLevel(level: (typeof LEVELS)[number] | 'off'): void {
  stderrLevel = level === 'off' ? LEVELS.length : LEVELS.indexOf(level);
}
export const LOG_FILE = path.join(os.homedir(), '.localpilot', 'cli.log');
function writeLog(level: number, name: string, m: string): void {
  const line = `${new Date().toISOString()} [${LEVELS[level]}] [${name}] ${m}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* ignore */
  }
  if (level >= stderrLevel) {
    process.stderr.write(`\x1b[2m${line}\x1b[0m`);
  }
}

// ------------------------------------------------------------------ window
async function pick(icon: string, msg: string, items: unknown[]): Promise<string | undefined> {
  const labels = items.filter((i) => typeof i === 'string') as string[];
  if (!labels.length) {
    promptOut.write(`${icon} ${msg}\n`);
    return undefined;
  }
  if (autoApprove) {
    return labels[0];
  }
  const a = await withPromptLock(() => ask(`${icon} ${msg}\n  [${labels.map((l, i) => `${i + 1}:${l}`).join('  ')}] > `));
  if (a === undefined) {
    return undefined;
  }
  const n = Number(a);
  return Number.isInteger(n) && n >= 1 && n <= labels.length ? labels[n - 1] : labels.find((l) => l.toLowerCase().startsWith(a.trim().toLowerCase()));
}

export const window = {
  activeTextEditor: undefined,
  visibleTextEditors: [] as never[],
  activeTerminal: undefined,
  terminals: [] as never[],
  tabGroups: { all: [] as never[], activeTabGroup: { activeTab: undefined }, onDidChangeTabs: () => new Disposable() },
  createOutputChannel(name: string, _opts?: { log: true }): LogOutputChannel {
    return {
      trace: (m) => writeLog(0, name, m),
      debug: (m) => writeLog(1, name, m),
      info: (m) => writeLog(2, name, m),
      warn: (m) => writeLog(3, name, m),
      error: (m) => writeLog(4, name, m),
      appendLine: (m) => writeLog(2, name, m),
      show() {},
      dispose() {},
    };
  },
  createTextEditorDecorationType: () => ({ dispose() {} }),
  onDidChangeActiveTextEditor: () => new Disposable(),
  onDidChangeTextEditorSelection: () => new Disposable(),
  onDidChangeVisibleTextEditors: () => new Disposable(),
  onDidStartTerminalShellExecution: () => new Disposable(),
  onDidEndTerminalShellExecution: () => new Disposable(),
  onDidCloseTerminal: () => new Disposable(),
  async showTextDocument(doc: TextDocument) {
    process.stdout.write(`\x1b[2m(open ${workspace.asRelativePath(doc.uri)} in your editor)\x1b[0m\n`);
    return { document: doc, selection: new Selection(0, 0, 0, 0), revealRange() {}, edit: async () => true };
  },
  showInformationMessage: (msg: string, ...items: unknown[]) => pick('›', msg, items),
  showWarningMessage: (msg: string, ...items: unknown[]) => pick('!', msg, items),
  showErrorMessage: (msg: string, ...items: unknown[]) => pick('✖', msg, items),
  async showInputBox(opts?: { prompt?: string; title?: string; value?: string }): Promise<string | undefined> {
    const a = await withPromptLock(() => ask(`\x1b[33m?\x1b[0m ${opts?.title ? `${opts.title}: ` : ''}${opts?.prompt ?? ''} `));
    return a === undefined ? undefined : a || opts?.value;
  },
  async showQuickPick(items: (string | { label: string })[] | Promise<(string | { label: string })[]>, opts?: { title?: string; placeHolder?: string; canPickMany?: boolean }): Promise<any> {
    const list = await items;
    const labels = list.map((i) => (typeof i === 'string' ? i : i.label).replace(/\$\([^)]*\)\s*/g, ''));
    const a = await withPromptLock(() => {
      promptOut.write(`\x1b[33m?\x1b[0m ${opts?.title ?? opts?.placeHolder ?? 'Choose'}\n${labels.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}\n`);
      return ask(opts?.canPickMany ? '  numbers separated by commas > ' : '  > ');
    });
    if (a === undefined || !a.trim()) {
      return undefined;
    }
    if (opts?.canPickMany) {
      const picked = [...new Set(a.split(',').map((x) => Number(x.trim()) - 1))].filter((k) => Number.isInteger(k) && k >= 0 && k < list.length);
      return picked.length ? picked.map((k) => list[k]) : undefined;
    }
    const n = Number(a);
    const idx = Number.isInteger(n) && n >= 1 && n <= list.length ? n - 1 : labels.findIndex((l) => l.toLowerCase().includes(a.trim().toLowerCase()));
    return idx >= 0 ? list[idx] : undefined;
  },
  /** Background commands in the CLI become detached processes (there is no terminal panel to show). */
  createTerminal(opts: { name?: string; cwd?: string | Uri } | string) {
    const name = typeof opts === 'string' ? opts : opts.name ?? 'LocalPilot';
    return {
      name,
      show() {},
      sendText(text: string) {
        const cwd = typeof opts === 'object' && opts.cwd ? (typeof opts.cwd === 'string' ? opts.cwd : opts.cwd.fsPath) : workspaceRoot;
        const sh = shellInvocation(text, { login: true });
        const dir = path.join(os.homedir(), '.localpilot', 'bg');
        const log = path.join(dir, `${Date.now()}-${name.replace(/[^\w.-]+/g, '_').slice(0, 60)}.log`);
        let fd: number | undefined;
        try {
          fs.mkdirSync(dir, { recursive: true });
          fd = fs.openSync(log, 'a');
        } catch {
          fd = undefined;
        }
        const out = fd ?? 'ignore';
        const child = cp.spawn(sh.file, sh.args, { cwd, detached: true, stdio: ['ignore', out, out], windowsVerbatimArguments: sh.windowsVerbatimArguments, windowsHide: true });
        if (fd !== undefined) {
          fs.closeSync(fd);
        }
        child.on('error', (e) => process.stderr.write(`background command failed to start: ${e.message}\n`));
        child.unref();
        promptOut.write(`\x1b[2m↗ started in background (pid ${child.pid}${fd !== undefined ? `, output → ${log}` : ''}): ${text}\x1b[0m\n`);
      },
      dispose() {},
    };
  },
  setStatusBarMessage: () => new Disposable(),
  withProgress: async (_o: unknown, task: (p: { report(): void }) => Promise<unknown>) => task({ report() {} }),
};

export const languages = {
  getDiagnostics: (): [] => [],
  // No language servers outside VS Code: diagnostics never change.
  onDidChangeDiagnostics: () => new Disposable(),
  registerInlineCompletionItemProvider: () => new Disposable(),
  registerCodeActionsProvider: () => new Disposable(),
};
export const commands = {
  async executeCommand(): Promise<undefined> {
    return undefined; // no language server or editor commands outside VS Code
  },
  registerCommand: () => new Disposable(),
  getCommands: async () => [] as string[],
};
export const env = {
  appRoot: '',
  appName: 'LocalPilot CLI',
  clipboard: { writeText: async () => undefined, readText: async () => '' },
  openExternal: async (uri: Uri) => {
    process.stdout.write(`\x1b[2m(open ${uri.toString()})\x1b[0m\n`);
    return true;
  },
};
export const extensions = { getExtension: () => undefined };
export const lm = { registerLanguageModelChatProvider: () => new Disposable() };
export const chat = { createChatParticipant: () => ({ dispose() {} }) };
