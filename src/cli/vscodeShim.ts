 
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
export class TabInputText {
  constructor(readonly uri: Uri) {}
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
    const text = this.text.split('\n')[n] ?? '';
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
export const CLI_SETTINGS_PATH = path.join(os.homedir(), '.localpilot', 'config.json');

function readJsonc(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Flattened `localpilot.*` settings. Precedence: VS Code user settings < workspace .vscode/settings.json < ~/.localpilot/config.json < CLI flags. */
const settings: Record<string, unknown> = {};
export const cliOverrides: Record<string, unknown> = {};
function flatten(obj: Record<string, unknown>, into: Record<string, unknown>, prefix = ''): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !['providers', 'mcpServers'].includes(key.split('.').pop()!)) {
      flatten(v as Record<string, unknown>, into, key);
    } else {
      into[key] = v;
    }
  }
}
export function loadSettings(workspaceRoot?: string): void {
  for (const k of Object.keys(settings)) {
    delete settings[k];
  }
  const fromVsCode = (file: string) => {
    const flat: Record<string, unknown> = {};
    flatten(readJsonc(file), flat);
    for (const [k, v] of Object.entries(flat)) {
      if (k.startsWith('localpilot.')) {
        settings[k.slice('localpilot.'.length)] = v;
      }
    }
  };
  fromVsCode(USER_SETTINGS_PATH);
  if (workspaceRoot) {
    fromVsCode(path.join(workspaceRoot, '.vscode', 'settings.json'));
  }
  const cli: Record<string, unknown> = {};
  flatten(readJsonc(CLI_SETTINGS_PATH), cli);
  for (const [k, v] of Object.entries(cli)) {
    settings[k.replace(/^localpilot\./, '')] = v;
  }
  Object.assign(settings, cliOverrides);
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
export async function ask(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const own = !rl;
  const r = rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => r.question(question, resolve));
  } finally {
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

function globToRegExp(glob: string): RegExp {
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
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.trim().replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
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
    return [...docs.values()];
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
        return (v === undefined ? def : v) as T;
      },
      inspect<T>(key: string) {
        const v = settings[prefix + key] as T | undefined;
        return { key, globalValue: v, defaultValue: undefined as T | undefined, workspaceValue: undefined as T | undefined, workspaceFolderValue: undefined as T | undefined };
      },
      async update(key: string, value: unknown): Promise<void> {
        // CLI-side changes (e.g. default model) go to ~/.localpilot/config.json; VS Code's settings.json is never written.
        const cfg = readJsonc(CLI_SETTINGS_PATH);
        if (value === undefined) {
          delete cfg[prefix + key];
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
    return true;
  },
  async findFiles(include: string, exclude?: string | null, maxResults = 10_000): Promise<Uri[]> {
    if (!workspaceRoot) {
      return [];
    }
    const out: Uri[] = [];
    await walk(workspaceRoot, '', globToRegExp(include), exclude ? globToRegExp(exclude) : undefined, out, maxResults);
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
      return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : e.isSymbolicLink() ? FileType.SymbolicLink : FileType.File]);
    },
    async stat(uri: Uri): Promise<{ type: FileType; size: number; mtime: number; ctime: number }> {
      const s = await fsp.stat(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
    },
    async createDirectory(uri: Uri): Promise<void> {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    async delete(uri: Uri, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
      await fsp.rm(uri.fsPath, { recursive: !!opts?.recursive, force: true });
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
export function setLogLevel(level: (typeof LEVELS)[number]): void {
  stderrLevel = LEVELS.indexOf(level);
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
    process.stdout.write(`${icon} ${msg}\n`);
    return undefined;
  }
  if (autoApprove) {
    return labels[0];
  }
  const a = await ask(`${icon} ${msg}\n  [${labels.map((l, i) => `${i + 1}:${l}`).join('  ')}] > `);
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
  tabGroups: { all: [] as never[] },
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
    const a = await ask(`\x1b[33m?\x1b[0m ${opts?.title ? `${opts.title}: ` : ''}${opts?.prompt ?? ''} `);
    return a === undefined ? undefined : a || opts?.value;
  },
  async showQuickPick(items: (string | { label: string })[] | Promise<(string | { label: string })[]>, opts?: { title?: string; placeHolder?: string }): Promise<any> {
    const list = await items;
    const labels = list.map((i) => (typeof i === 'string' ? i : i.label).replace(/\$\([^)]*\)\s*/g, ''));
    process.stdout.write(`\x1b[33m?\x1b[0m ${opts?.title ?? opts?.placeHolder ?? 'Choose'}\n${labels.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}\n`);
    const a = await ask('  > ');
    if (a === undefined || !a.trim()) {
      return undefined;
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
        const child = cp.spawn(process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh', process.platform === 'win32' ? ['/c', text] : ['-lc', text], { cwd, detached: true, stdio: 'ignore' });
        child.unref();
        process.stdout.write(`\x1b[2m↗ started in background (pid ${child.pid}): ${text}\x1b[0m\n`);
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
