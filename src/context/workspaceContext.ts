import * as vscode from 'vscode';
import * as path from 'path';
import { runProcess } from '../tools/search';
import { buildInstructions, InstructionFile } from './instructions';
import { folderRelativePath, normalizeContextPath, pathsInText, ruleApplies } from './ruleConditions';
import { identifiersIn, NameVocabulary } from '../agent/promptCorrector';
import { mentionKind, recordTelemetry } from '../telemetry/catalog';
import * as nodeFs from 'fs';
import { getConfig } from '../config';
import { AttachmentKind, attachmentKind, binaryNote, extractDocumentText, formatSize, looksBinary, splitAttachmentRef } from './extractors';
import { describePdfError, extractPdfText, formatPdfText } from '../pdf/extract';
import { isCommitRef, isUrlRef } from './mentionRefs';
import { MAX_ATTACHMENT_BYTES, readCommit, readFolderContent, readUrl } from './mentionResolvers';
import { formatRootsOverview } from '../tools/rootPaths';
import { excludedBy } from '../agent/ignoreFile';

async function readHead(fsPath: string, n = 8192): Promise<Uint8Array> {
  const fh = await nodeFs.promises.open(fsPath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export const TREE_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/__pycache__/**,**/.next/**,**/target/**,**/coverage/**,**/.vscode-test/**}';

/** Well-known files that reveal the stack / tooling, shown in the project map when present. */
const STACK_MARKERS: [RegExp, string][] = [
  [/^package\.json$/, 'Node.js'],
  [/^tsconfig(\..*)?\.json$/, 'TypeScript'],
  [/^(pyproject\.toml|requirements.*\.txt|setup\.py|Pipfile)$/, 'Python'],
  [/^go\.mod$/, 'Go'],
  [/^Cargo\.toml$/, 'Rust'],
  [/^(pom\.xml|build\.gradle(\.kts)?)$/, 'Java/Kotlin'],
  [/\.(csproj|fsproj|sln)$/, '.NET'],
  [/^Gemfile$/, 'Ruby'],
  [/^composer\.json$/, 'PHP'],
  [/^pubspec\.yaml$/, 'Dart/Flutter'],
  [/^(Dockerfile|docker-compose.*\.ya?ml|compose\.ya?ml)$/, 'Docker'],
  [/^Makefile$/, 'Make'],
  [/^(vite|next|nuxt|astro|svelte|webpack|esbuild|rollup)\.config\.[cm]?[jt]s$/, 'bundler config'],
  [/^(jest|vitest|playwright|cypress)\.config\.[cm]?[jt]s$/, 'test config'],
];

/** Enough of a text editor to read the file and its selection from. */
export type EditorState = Pick<vscode.TextEditor, 'document' | 'selection' | 'selections'>;

const isTextScheme = (uri: vscode.Uri) => uri.scheme === 'file' || uri.scheme === 'untitled';
let lastEditor: { uri: vscode.Uri; selections: readonly vscode.Selection[] } | undefined;
let editorTracking: vscode.Disposable | undefined;

function rememberEditor(ed: vscode.TextEditor | undefined): void {
  if (ed && isTextScheme(ed.document.uri)) {
    lastEditor = { uri: ed.document.uri, selections: ed.selections };
  }
}

/** Remembers the last focused text editor, so focusing the chat (e.g. as an editor tab) keeps the editor context. */
function trackEditors(): vscode.Disposable {
  if (!editorTracking) {
    rememberEditor(vscode.window.activeTextEditor);
    const subs = [vscode.window.onDidChangeActiveTextEditor(rememberEditor), vscode.window.onDidChangeTextEditorSelection((e) => rememberEditor(e.textEditor))];
    editorTracking = new vscode.Disposable(() => {
      subs.forEach((d) => d.dispose());
      editorTracking = undefined;
    });
  }
  return editorTracking;
}

/** The active text editor or, when focus is elsewhere (chat tab, panel), the last text editor that is still open. */
export function currentEditor(): EditorState | undefined {
  const active = vscode.window.activeTextEditor;
  if (active && isTextScheme(active.document.uri)) {
    return active;
  }
  const last = lastEditor;
  if (!last) {
    return active;
  }
  const key = last.uri.toString();
  const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
  if (visible) {
    return visible;
  }
  const inTab = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key));
  const document = inTab ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === key) : undefined;
  return document ? { document, selection: last.selections[0], selections: last.selections } : active;
}

/** Which conditional rules a set of context paths turns on: the rules cache is reused while this stays the same. */
const appliedKey = (files: InstructionFile[], contextPaths: readonly string[]) =>
  files
    .filter((f) => f.paths && ruleApplies(f.paths, contextPaths))
    .map((f) => f.file)
    .join('\n');

/** Lightweight workspace context: file tree snapshot, open editors, selections, diagnostics summary. */
export class WorkspaceContext implements vscode.Disposable {
  private treeCache?: { text: string; max: number; at: number };
  private mapCache?: { text: string; at: number };
  private namesCache?: { files: Set<string>; stems: Set<string>; at: number };
  private rulesCache?: { text: string; max: number; at: number; files: InstructionFile[]; applied: string; paths: readonly string[] };
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly rulesWatcher: vscode.FileSystemWatcher;
  private readonly editorTracking = trackEditors();

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    const invalidate = () => {
      this.treeCache = undefined;
      this.mapCache = undefined;
      this.namesCache = undefined;
    };
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
    // Rules files are re-read only when one of them changes, not on every prompt build.
    this.rulesWatcher = vscode.workspace.createFileSystemWatcher('**/{.localpilot/rules.md,.localpilot/rules.local.md,.localpilot/rules/*,.localpilot/CLAUDE.md,AGENTS.md,CLAUDE.md,CLAUDE.local.md,.claude/CLAUDE.md,.claude/rules/*,.cursorrules,.cursor/rules/*,.github/copilot-instructions.md,.windsurfrules,.clinerules,.clinerules/*,.cline/rules/*}');
    const dropRules = () => (this.rulesCache = undefined);
    this.rulesWatcher.onDidChange(dropRules);
    this.rulesWatcher.onDidCreate(dropRules);
    this.rulesWatcher.onDidDelete(dropRules);
  }

  dispose(): void {
    this.watcher.dispose();
    this.rulesWatcher.dispose();
    this.editorTracking.dispose();
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Concatenated project instructions in Claude Code's order — user-level `~/.claude/CLAUDE.md`, ancestor folders'
   * CLAUDE.md, the project's AGENTS.md / CLAUDE.md / .claude/CLAUDE.md / .cursorrules / copilot-instructions and rule
   * folders, then CLAUDE.local.md — with `@path` imports resolved; capped. Conditional rules (`paths:` / `globs:`)
   * are included when one of `contextPaths` matches.
   */
  async loadInstructions(maxChars = 12000, contextPaths: readonly string[] = []): Promise<string> {
    // Files outside the workspace (user level, ancestors, imports) have no watcher: refresh those on a short TTL.
    const c = this.rulesCache;
    if (c && c.max === maxChars && Date.now() - c.at < 60_000 && appliedKey(c.files, contextPaths) === c.applied) {
      return c.text;
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    try {
      const { text, files } = await buildInstructions(roots, { maxChars, contextPaths });
      this.rulesCache = { text, max: maxChars, at: Date.now(), files, applied: appliedKey(files, contextPaths), paths: contextPaths };
      return text;
    } catch (e) {
      this.log.warn(`instructions: ${String(e)}`);
      return this.rulesCache?.text ?? '';
    }
  }

  /** Re-read the instruction files on the next prompt (a rule was switched, created or deleted). */
  invalidateInstructions(): void {
    this.rulesCache = undefined;
  }

  /** The instruction files currently in force (for `/memory` and the settings UI). */
  async instructionFiles(): Promise<InstructionFile[]> {
    await this.loadInstructions(this.rulesCache?.max ?? 12000, this.rulesCache?.paths ?? []);
    return this.rulesCache?.files ?? [];
  }

  /** Conditional rules that `contextPaths` bring into the prompt (and that fit under the size cap). */
  conditionalRulesFor(contextPaths: readonly string[]): InstructionFile[] {
    return (this.rulesCache?.files ?? []).filter((f) => f.paths && f.note !== 'omitted' && ruleApplies(f.paths, contextPaths));
  }

  /**
   * The files in context for conditional rules, workspace-relative and POSIX: paths in the user message (attachments
   * included), open and visible editors, and the session's working set.
   */
  contextPaths(message: string, workingSet: readonly string[] = []): string[] {
    const out = new Set(pathsInText(message));
    const uris = [...vscode.window.visibleTextEditors.map((e) => e.document.uri), ...vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri : undefined))];
    for (const uri of uris) {
      if (uri?.scheme === 'file') {
        const rel = vscode.workspace.asRelativePath(uri, false);
        const n = rel !== uri.fsPath ? normalizeContextPath(rel) : undefined;
        if (n) {
          out.add(n);
        }
      }
    }
    const folderNames = (vscode.workspace.workspaceFolders ?? []).map((f) => f.name);
    for (const p of workingSet) {
      const n = folderRelativePath(p, folderNames);
      if (n) {
        out.add(n);
      }
    }
    return [...out];
  }

  /** `git status` + `git diff` for the @git mention. */
  async gitContext(maxChars = 16000, root = this.root): Promise<string> {
    if (!root) {
      return '';
    }
    try {
      const [status, diff, staged] = await Promise.all([
        runProcess('git', ['--no-optional-locks', 'status', '--short', '--branch'], root),
        runProcess('git', ['--no-optional-locks', 'diff', '--stat'], root),
        runProcess('git', ['--no-optional-locks', 'diff', '--cached'], root),
      ]);
      const head = `<git>\n# status\n${status.trim()}\n\n# unstaged (stat)\n${diff.trim() || '(none)'}\n\n# staged diff\n`;
      const tail = '\n</git>';
      const marker = '\n…(truncated)';
      let body = staged.trim() || '(none)';
      if (head.length + body.length + tail.length > maxChars) {
        body = body.slice(0, Math.max(0, maxChars - head.length - marker.length - tail.length)) + marker;
      }
      return head + body + tail;
    } catch (e) {
      return `<git>Not a git repository or git unavailable: ${String(e)}</git>`;
    }
  }

  /** Short `git status` + `diff --stat`: enough to tell what the user is currently working on. */
  async gitSummary(maxChars = 2500, root = this.root): Promise<string> {
    if (!root) {
      return '';
    }
    try {
      const [status, stat] = await Promise.all([runProcess('git', ['--no-optional-locks', 'status', '--short', '--branch'], root, undefined, 5000), runProcess('git', ['--no-optional-locks', 'diff', '--stat', 'HEAD'], root, undefined, 5000)]);
      const out = [status.trim(), stat.trim()].filter(Boolean).join('\n');
      return out.length > maxChars ? out.slice(0, maxChars) + '\n…(truncated)' : out;
    } catch {
      return '';
    }
  }

  /**
   * The workspace folders of a multi-root workspace, one `name — path — git <branch>@<sha>` line each (empty with a
   * single folder).
   */
  async rootsOverview(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length < 2) {
      return '';
    }
    const key = folders.map((f) => `${f.name}=${f.uri.fsPath}`).join('\0');
    if (this.rootsCache?.key === key && Date.now() - this.rootsCache.at < 30_000) {
      return this.rootsCache.text;
    }
    const git = async (cwd: string) => {
      try {
        const [branch, sha] = await Promise.all([runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, undefined, 3000, [0]), runProcess('git', ['rev-parse', '--short', 'HEAD'], cwd, undefined, 3000, [0])]);
        return sha.trim() ? { branch: branch.trim() === 'HEAD' ? '' : branch.trim(), sha: sha.trim() } : undefined;
      } catch {
        return undefined;
      }
    };
    const roots = await Promise.all(folders.map(async (f) => ({ name: f.name, path: f.uri.fsPath, git: await git(f.uri.fsPath) })));
    const text = formatRootsOverview(roots);
    this.rootsCache = { key, at: Date.now(), text };
    return text;
  }
  private rootsCache?: { key: string; at: number; text: string };

  /** `root` lists another folder (an isolated worktree) instead of the workspace; those listings are not cached. */
  async fileTree(maxEntries = 400, root?: string): Promise<string> {
    if (!root && this.treeCache && this.treeCache.max === maxEntries && Date.now() - this.treeCache.at < 5 * 60_000) {
      return this.treeCache.text;
    }
    const files = await vscode.workspace.findFiles(root ? new vscode.RelativePattern(vscode.Uri.file(root), '**/*') : '**/*', TREE_EXCLUDE, maxEntries);
    const base = root ?? this.root;
    // Files the agent ignore file excludes stay listed, lock-marked.
    const rel = files.map((f) => `${base ? path.relative(base, f.fsPath) : f.fsPath}${excludedBy(f.fsPath, [...(base ? [base] : []), ...(vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath)]) ? ' 🔒' : ''}`).sort();
    const truncated = files.length >= maxEntries ? `\n... (truncated at ${maxEntries} entries; use file_search/grep_search for more)` : '';
    const text = rel.join('\n') + truncated;
    if (!root) {
      this.treeCache = { text, max: maxEntries, at: Date.now() };
    }
    return text;
  }

  /**
   * Compact orientation for the system prompt (a few hundred characters): top-level folders with file counts and
   * their immediate subfolders, root files, and the stack markers found. Cheap enough to include on every turn so
   * the model knows where things live before its first tool call.
   */
  async projectMap(maxFiles = 3000): Promise<string> {
    const root = this.root;
    if (!root) {
      return '';
    }
    if (this.mapCache && Date.now() - this.mapCache.at < 5 * 60_000) {
      return this.mapCache.text;
    }
    let text = '';
    try {
      const files = await vscode.workspace.findFiles('**/*', TREE_EXCLUDE, maxFiles);
      const dirs = new Map<string, { count: number; sub: Set<string> }>();
      const rootFiles: string[] = [];
      for (const f of files) {
        const rel = path.relative(root, f.fsPath).split(path.sep);
        if (rel.length === 1) {
          rootFiles.push(rel[0]);
          continue;
        }
        let d = dirs.get(rel[0]);
        if (!d) {
          d = { count: 0, sub: new Set() };
          dirs.set(rel[0], d);
        }
        d.count++;
        if (rel.length > 2) {
          d.sub.add(rel[1]);
        }
      }
      const folders = [...dirs.entries()]
        .filter(([name]) => !name.startsWith('.') || name === '.github')
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 14)
        .map(([name, d]) => {
          const sub = [...d.sub].sort();
          const shown = sub.slice(0, 8).join(', ') + (sub.length > 8 ? `, +${sub.length - 8}` : '');
          return `${name}/ (${d.count}${files.length >= maxFiles ? '+' : ''} files${shown ? `: ${shown}` : ''})`;
        });
      const stack = new Set<string>();
      for (const f of rootFiles) {
        for (const [re, label] of STACK_MARKERS) {
          if (re.test(f)) {
            stack.add(label);
          }
        }
      }
      const roots = rootFiles
        .filter((f) => !f.startsWith('.') || /^\.(env\.example|nvmrc|tool-versions)$/.test(f))
        .sort()
        .slice(0, 16);
      const lines = [
        folders.length ? `Folders: ${folders.join('; ')}` : '',
        roots.length ? `Root files: ${roots.join(', ')}${rootFiles.length > roots.length ? `, +${rootFiles.length - roots.length}` : ''}` : '',
        stack.size ? `Stack markers: ${[...stack].join(', ')}` : '',
      ].filter(Boolean);
      text = lines.join('\n');
    } catch (e) {
      this.log.warn(`projectMap failed: ${String(e)}`);
    }
    this.mapCache = { text, at: Date.now() };
    return text;
  }

  /**
   * The names a request may refer to, for correcting misspelled ones (see promptCorrector): file base names in the
   * workspace (cached until files are created or deleted, at most five minutes) and the identifiers in open editors.
   */
  async nameVocabulary(maxFiles = 5000): Promise<NameVocabulary> {
    if (!this.root) {
      return { files: new Set(), identifiers: new Set() };
    }
    if (!this.namesCache || Date.now() - this.namesCache.at > 5 * 60_000) {
      const files = new Set<string>();
      const stems = new Set<string>();
      try {
        for (const f of await vscode.workspace.findFiles('**/*', TREE_EXCLUDE, maxFiles)) {
          const base = path.basename(f.fsPath);
          files.add(base);
          identifiersIn(base.replace(/\.[^.]+$/, ''), stems);
        }
      } catch (e) {
        this.log.warn(`nameVocabulary failed: ${String(e)}`);
      }
      this.namesCache = { files, stems, at: Date.now() };
    }
    const identifiers = new Set(this.namesCache.stems);
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') {
        identifiersIn(doc.getText(), identifiers);
      }
    }
    return { files: this.namesCache.files, identifiers };
  }

  /** Automatic context: the active file and selection, unless the agent ignore file excludes the file. */
  activeEditorContext(): string {
    const ed = currentEditor();
    if (!ed || (ed.document.uri.scheme === 'file' && this.excludedFile(ed.document.uri.fsPath))) {
      return '';
    }
    const doc = ed.document;
    const rel = vscode.workspace.asRelativePath(doc.uri);
    const sel = ed.selection;
    let out = `Active file: ${rel} (${doc.languageId}, ${doc.lineCount} lines), cursor at line ${sel.active.line + 1}`;
    if (!sel.isEmpty) {
      const text = doc.getText(sel);
      out += `\nSelected text (lines ${sel.start.line + 1}-${sel.end.line + 1}):\n\`\`\`${doc.languageId}\n${text.slice(0, 6000)}\n\`\`\``;
    }
    return out;
  }

  /** True when the active editor has a non-empty selection ("this" then has an obvious referent). */
  hasSelection(): boolean {
    const ed = currentEditor();
    return !!ed && !ed.selection.isEmpty;
  }

  openEditors(): string[] {
    return vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : undefined))
      .filter((x): x is string => !!x);
  }

  /** Open editors for automatic context: without files the agent ignore file excludes. */
  contextEditors(): string[] {
    return this.openEditors().filter((p) => !this.excludedFile(p));
  }

  /** The agent ignore file (.localpilotignore …) excluding `p` — absolute, or relative as `asRelativePath` writes it. */
  excludedFile(p: string): string | undefined {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
    let abs = p;
    if (!path.isAbsolute(p)) {
      const [head, ...rest] = p.split('/');
      const named = folders.length > 1 && rest.length ? folders.find((f) => f.name === head) : undefined;
      const base = this.root ?? folders[0]?.path;
      if (!named && !base) {
        return undefined;
      }
      abs = named ? path.join(named.path, ...rest) : path.join(base!, p);
    }
    return excludedBy(abs, [...(this.root ? [this.root] : []), ...folders.map((f) => f.path)]);
  }

  /** Diagnostics at `minSeverity` or worse; with warnings included each line is tagged and errors come first. */
  diagnosticsSummary(max = 20, minSeverity = vscode.DiagnosticSeverity.Error): string {
    const found: { severity: vscode.DiagnosticSeverity; line: string }[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity <= minSeverity) {
          found.push({ severity: d.severity, line: `${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}: ${d.message}` });
        }
      }
    }
    const tagged = minSeverity > vscode.DiagnosticSeverity.Error;
    return found
      .sort((a, b) => a.severity - b.severity)
      .slice(0, max)
      .map((f) => (tagged ? `[${f.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning'}] ${f.line}` : f.line))
      .join('\n');
  }

  /**
   * Maps an attachment path to a file: absolute paths as-is; in multi-root workspaces `asRelativePath` prefixes the
   * folder name, so a leading segment naming a folder picks that folder; otherwise the first folder that has the file.
   */
  async resolveRef(p: string): Promise<vscode.Uri> {
    if (path.isAbsolute(p)) {
      return vscode.Uri.file(p);
    }
    const folders = vscode.workspace.workspaceFolders!;
    const [head, ...rest] = p.split('/');
    const named = folders.length > 1 && rest.length ? folders.find((f) => f.name === head) : undefined;
    const candidates = named ? [vscode.Uri.joinPath(named.uri, rest.join('/'))] : [];
    candidates.push(...folders.map((f) => vscode.Uri.joinPath(f.uri, p)));
    for (const uri of candidates) {
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        /* try the next folder */
      }
    }
    return candidates[0];
  }

  /** A path inside `root`: relative refs resolve against it and absolute main-checkout paths are remapped into it. */
  private inRoot(p: string, root: string): string {
    if (!path.isAbsolute(p)) {
      return path.join(root, p);
    }
    const own = path.relative(root, p);
    if (!own.startsWith('..') && !path.isAbsolute(own)) {
      return p;
    }
    const main = this.root;
    const rel = main ? path.relative(main, p) : '..';
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(root, rel) : rel === '' ? root : p;
  }

  /** A PDF as attached context: its text from `from` to `to` (pages), up to `localpilot.pdf.maxChars`. */
  private async pdfAttachment(uri: vscode.Uri, rel: string, from?: number, to?: number): Promise<string> {
    const tag = (attrs: string, body: string) => `<attachment path="${rel}" kind="pdf"${attrs}>\n${body}\n</attachment>`;
    const { maxReadSizeMB, maxChars } = getConfig().pdf;
    const size = (await nodeFs.promises.stat(uri.fsPath)).size;
    if (size > maxReadSizeMB * 1024 * 1024) {
      return tag(' error="too large"', `(PDF ${path.basename(uri.fsPath)} is ${formatSize(size)}, over the ${maxReadSizeMB} MB limit of localpilot.pdf.maxReadSizeMB)`);
    }
    try {
      const r = await extractPdfText(uri.fsPath, { from, to: to ?? from, maxChars });
      if (from !== undefined && from > r.numPages) {
        return tag(' error="bad range"', `(Page ${from} is past the end: the PDF has ${r.numPages} page${r.numPages === 1 ? '' : 's'})`);
      }
      const pages = r.pages.length ? `${r.from === r.to ? r.from : `${r.from}-${r.to}`} of ${r.numPages}` : `0 of ${r.numPages}`;
      return tag(` pages="${pages}"`, formatPdfText(r, rel));
    } catch (e) {
      this.log.warn(`PDF attachment failed: ${rel}: ${String(e)}`);
      return tag(' error="unreadable"', `(${describePdfError(e, false)})`);
    }
  }

  /** Supplies the last terminal command + output for `@terminal` (set by the extension; absent in the CLI). */
  terminalContext?: () => string;

  /** Asks whether an `@https://…` mention may be fetched when network approvals are `ask` (absent: refused). */
  approveUrl?: (url: string) => Promise<boolean>;

  /**
   * Reads a file or a `file#L10-L20` reference as attached context; also resolves special mentions. `root` (an
   * isolated chat's worktree folder) replaces the main checkout for relative paths, @git and @workspace.
   */
  async readAttachment(ref: string, root?: string): Promise<string> {
    const out = await this.readAttachmentBody(ref, root);
    // An explicit mention overrides the agent ignore file; the note keeps the model from reaching for the file itself.
    const shown = /^<attachment path="([^"]+)"(?![^>]*\berror=)/.exec(out)?.[1]?.replace(/&quot;/g, '"');
    const source = shown && (root && !path.isAbsolute(shown) ? excludedBy(path.join(root, shown), [root]) : this.excludedFile(shown));
    return source ? `(Note: ${shown} is excluded by ${source}; it is attached because the user mentioned it, but the file tools will not read or change it.)\n${out}` : out;
  }

  private async readAttachmentBody(ref: string, root?: string): Promise<string> {
    recordTelemetry({ type: 'mention', kind: mentionKind(ref) });
    const special = ref.replace(/^@/, '');
    switch (special) {
      case 'terminal':
        return this.terminalContext?.() ?? '<terminal_output>Terminal context is only available inside VS Code.</terminal_output>';
      case 'workspace':
        return `<workspace_tree root="${root ?? this.root ?? ''}">\n${await this.fileTree(400, root)}\n</workspace_tree>`;
      case 'problems': {
        const d = this.diagnosticsSummary(60, vscode.DiagnosticSeverity.Warning);
        return `<problems>\n${d || 'No errors or warnings reported.'}\n</problems>`;
      }
      case 'git':
        return this.gitContext(16000, root ?? this.root);
      case 'selection': {
        const ed = currentEditor();
        if (!ed) {
          return '';
        }
        const sel = ed.selection.isEmpty ? undefined : ed.selection;
        const text = sel ? ed.document.getText(sel) : ed.document.getText();
        const rel = vscode.workspace.asRelativePath(ed.document.uri);
        return `<attachment path="${rel}"${sel ? ` lines="${sel.start.line + 1}-${sel.end.line + 1}"` : ''}>\n${text.slice(0, 40000)}\n</attachment>`;
      }
      case 'editors': {
        const open = this.openEditors();
        return `<open_editors>\n${open.join('\n') || '(none)'}\n</open_editors>`;
      }
    }
    if (isUrlRef(special)) {
      return readUrl(special, this.approveUrl);
    }
    if (isCommitRef(special)) {
      const roots = [root ?? this.root, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)].filter((r): r is string => !!r);
      const commit = await readCommit(special, roots);
      if (commit) {
        return commit;
      }
    }
    const parts = splitAttachmentRef(ref);
    const p = parts.path;
    const start = parts.start !== undefined ? String(parts.start) : undefined;
    const end = parts.end !== undefined ? String(parts.end) : undefined;
    if (!root && !vscode.workspace.workspaceFolders?.length && !path.isAbsolute(p)) {
      return '';
    }
    const uri = root ? vscode.Uri.file(this.inRoot(p, root)) : await this.resolveRef(p);
    const label = (u: vscode.Uri) => {
      const r = root ? path.relative(root, u.fsPath) : undefined;
      return r !== undefined && r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : vscode.workspace.asRelativePath(u);
    };
    try {
      // Directories: the tree and the direct child files instead of failing.
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        return await readFolderContent(uri, label(uri), this.log);
      }
      // Documents and binaries by extension, before the editor gets a chance to refuse them (or open them as garbage).
      const kind = attachmentKind(uri.fsPath);
      if (kind === 'pdf') {
        return await this.pdfAttachment(uri, label(uri), parts.start, parts.end);
      }
      const name = path.basename(uri.fsPath);
      if (kind !== 'image' && stat.size > MAX_ATTACHMENT_BYTES) {
        return `<attachment path="${label(uri)}" error="too large">\n(${name} is ${formatSize(stat.size)}, over the ${formatSize(MAX_ATTACHMENT_BYTES)} attachment limit; read parts of it with read_file)\n</attachment>`;
      }
      const binary = (k: AttachmentKind = 'binary') => `<attachment path="${label(uri)}" kind="${k}">\n${binaryNote(name, stat.size, k)}\n</attachment>`;
      if (kind === 'image' || kind === 'binary') {
        return binary(kind);
      }
      if (kind === 'text' && uri.scheme === 'file' && looksBinary(await readHead(uri.fsPath))) {
        return binary();
      }
      let text: string;
      if (kind === 'ipynb' || kind === 'docx') {
        try {
          text = (await extractDocumentText(name, await vscode.workspace.fs.readFile(uri), kind)) ?? '';
        } catch (e) {
          this.log.warn(`attachment read failed: ${ref}: ${String(e)}`);
          return `<attachment path="${label(uri)}" kind="${kind}" error="unreadable">\n(Could not read ${name}: ${e instanceof Error ? e.message : String(e)})\n</attachment>`;
        }
        if (start) {
          text = text.split('\n').slice(Math.max(0, Number(start) - 1), end ? Number(end) : Number(start)).join('\n');
        }
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        text = doc.getText();
        if (start) {
          const s = Math.max(0, Number(start) - 1);
          const e = end ? Number(end) : s + 1;
          text = doc.getText(new vscode.Range(s, 0, e, 0));
        }
      }
      // A whole large file would crowd out everything else in the prompt; the agent reads the rest with read_file.
      const MAX = 60_000;
      if (text.length > MAX) {
        const shownLines = text.slice(0, MAX).split('\n').length;
        const from = (start ? Number(start) : 1) + shownLines - 1;
        const rest = kind === 'docx' ? `attach ${label(uri)}#L${from} for the rest` : `read the rest with read_file from line ${from}`;
        text = `${text.slice(0, MAX)}\n… [attachment cut at ${MAX.toLocaleString()} of ${text.length.toLocaleString()} characters; ${rest}]`;
      }
      return `<attachment path="${label(uri)}"${kind !== 'text' ? ` kind="${kind}"` : ''}${start ? ` lines="${start}-${end ?? start}"` : ''}>\n${text}\n</attachment>`;
    } catch (e) {
      this.log.warn(`attachment read failed: ${ref}: ${String(e)}`);
      // Say so instead of dropping it: the model and the chat both see which attachment was missing.
      return `<attachment path="${p.replace(/"/g, '&quot;')}" error="not found"></attachment>`;
    }
  }
}
