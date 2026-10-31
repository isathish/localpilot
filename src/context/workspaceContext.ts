import * as vscode from 'vscode';
import * as path from 'path';
import { runProcess } from '../tools/search';
import { buildInstructions, InstructionFile } from './instructions';
import { identifiersIn, NameVocabulary } from '../agent/promptCorrector';

const TREE_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/__pycache__/**,**/.next/**,**/target/**,**/coverage/**,**/.vscode-test/**}';

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

/** Lightweight workspace context: file tree snapshot, open editors, selections, diagnostics summary. */
export class WorkspaceContext implements vscode.Disposable {
  private treeCache?: { text: string; max: number; at: number };
  private mapCache?: { text: string; at: number };
  private namesCache?: { files: Set<string>; stems: Set<string>; at: number };
  private rulesCache?: { text: string; max: number; at: number; files: InstructionFile[] };
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly rulesWatcher: vscode.FileSystemWatcher;

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
    this.rulesWatcher = vscode.workspace.createFileSystemWatcher('**/{.localpilot/rules.md,.localpilot/rules.local.md,.localpilot/rules/*,.localpilot/CLAUDE.md,AGENTS.md,CLAUDE.md,CLAUDE.local.md,.claude/CLAUDE.md,.claude/rules/*,.cursorrules,.cursor/rules/*,.github/copilot-instructions.md,.windsurfrules}');
    const dropRules = () => (this.rulesCache = undefined);
    this.rulesWatcher.onDidChange(dropRules);
    this.rulesWatcher.onDidCreate(dropRules);
    this.rulesWatcher.onDidDelete(dropRules);
  }

  dispose(): void {
    this.watcher.dispose();
    this.rulesWatcher.dispose();
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Concatenated project instructions in Claude Code's order — user-level `~/.claude/CLAUDE.md`, ancestor folders'
   * CLAUDE.md, the project's AGENTS.md / CLAUDE.md / .claude/CLAUDE.md / .cursorrules / copilot-instructions and rule
   * folders, then CLAUDE.local.md — with `@path` imports resolved; capped.
   */
  async loadInstructions(maxChars = 12000): Promise<string> {
    // Files outside the workspace (user level, ancestors, imports) have no watcher: refresh those on a short TTL.
    if (this.rulesCache && this.rulesCache.max === maxChars && Date.now() - this.rulesCache.at < 60_000) {
      return this.rulesCache.text;
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    try {
      const { text, files } = await buildInstructions(roots, { maxChars });
      this.rulesCache = { text, max: maxChars, at: Date.now(), files };
      return text;
    } catch (e) {
      this.log.warn(`instructions: ${String(e)}`);
      return this.rulesCache?.text ?? '';
    }
  }

  /** The instruction files currently in force (for `/memory` and the settings UI). */
  async instructionFiles(): Promise<InstructionFile[]> {
    await this.loadInstructions(this.rulesCache?.max ?? 12000);
    return this.rulesCache?.files ?? [];
  }

  /** `git status` + `git diff` for the @git mention. */
  async gitContext(maxChars = 16000): Promise<string> {
    const root = this.root;
    if (!root) {
      return '';
    }
    try {
      const [status, diff, staged] = await Promise.all([
        runProcess('git', ['status', '--short', '--branch'], root),
        runProcess('git', ['diff', '--stat'], root),
        runProcess('git', ['diff', '--cached'], root),
      ]);
      let out = `<git>\n# status\n${status.trim()}\n\n# unstaged (stat)\n${diff.trim() || '(none)'}\n\n# staged diff\n${staged.trim() || '(none)'}\n</git>`;
      if (out.length > maxChars) {
        out = out.slice(0, maxChars) + '\n…(truncated)';
      }
      return out;
    } catch (e) {
      return `<git>Not a git repository or git unavailable: ${String(e)}</git>`;
    }
  }

  /** Short `git status` + `diff --stat`: enough to tell what the user is currently working on. */
  async gitSummary(maxChars = 2500): Promise<string> {
    const root = this.root;
    if (!root) {
      return '';
    }
    try {
      const [status, stat] = await Promise.all([runProcess('git', ['status', '--short', '--branch'], root, undefined, 5000), runProcess('git', ['diff', '--stat', 'HEAD'], root, undefined, 5000)]);
      const out = [status.trim(), stat.trim()].filter(Boolean).join('\n');
      return out.length > maxChars ? out.slice(0, maxChars) + '\n…(truncated)' : out;
    } catch {
      return '';
    }
  }

  async fileTree(maxEntries = 400): Promise<string> {
    if (this.treeCache && this.treeCache.max === maxEntries && Date.now() - this.treeCache.at < 5 * 60_000) {
      return this.treeCache.text;
    }
    const files = await vscode.workspace.findFiles('**/*', TREE_EXCLUDE, maxEntries);
    const root = this.root;
    const rel = files.map((f) => (root ? path.relative(root, f.fsPath) : f.fsPath)).sort();
    const truncated = files.length >= maxEntries ? `\n... (truncated at ${maxEntries} entries; use file_search/grep_search for more)` : '';
    const text = rel.join('\n') + truncated;
    this.treeCache = { text, max: maxEntries, at: Date.now() };
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

  activeEditorContext(): string {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
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
    const ed = vscode.window.activeTextEditor;
    return !!ed && !ed.selection.isEmpty;
  }

  openEditors(): string[] {
    return vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : undefined))
      .filter((x): x is string => !!x);
  }

  diagnosticsSummary(max = 20): string {
    const all = vscode.languages.getDiagnostics();
    const lines: string[] = [];
    for (const [uri, diags] of all) {
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          lines.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}: ${d.message}`);
          if (lines.length >= max) {
            return lines.join('\n');
          }
        }
      }
    }
    return lines.join('\n');
  }

  /** Reads a file or a `file#L10-L20` reference as attached context; also resolves special mentions. */
  /** Supplies the last terminal command + output for `@terminal` (set by the extension; absent in the CLI). */
  terminalContext?: () => string;

  async readAttachment(ref: string): Promise<string> {
    switch (ref) {
      case 'terminal':
        return this.terminalContext?.() ?? '<terminal_output>Terminal context is only available inside VS Code.</terminal_output>';
      case 'workspace':
        return `<workspace_tree root="${this.root ?? ''}">\n${await this.fileTree()}\n</workspace_tree>`;
      case 'problems': {
        const d = this.diagnosticsSummary(60);
        return `<problems>\n${d || 'No errors reported.'}\n</problems>`;
      }
      case 'git':
        return this.gitContext();
      case 'selection': {
        const ed = vscode.window.activeTextEditor;
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
    const m = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref);
    if (!m) {
      return '';
    }
    const [, p, start, end] = m;
    if (!vscode.workspace.workspaceFolders?.length && !path.isAbsolute(p)) {
      return '';
    }
    const uri = path.isAbsolute(p) ? vscode.Uri.file(p) : vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, p);
    try {
      // Directories: attach a listing instead of failing.
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        return `<directory path="${vscode.workspace.asRelativePath(uri)}">\n${entries.map(([n, t]) => (t === vscode.FileType.Directory ? `${n}/` : n)).join('\n')}\n</directory>`;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      let text = doc.getText();
      if (start) {
        const s = Math.max(0, Number(start) - 1);
        const e = end ? Number(end) : s + 1;
        text = doc.getText(new vscode.Range(s, 0, e, 0));
      }
      return `<attachment path="${vscode.workspace.asRelativePath(uri)}"${start ? ` lines="${start}-${end ?? start}"` : ''}>\n${text}\n</attachment>`;
    } catch (e) {
      this.log.warn(`attachment read failed: ${ref}: ${String(e)}`);
      return '';
    }
  }
}
