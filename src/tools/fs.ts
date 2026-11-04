import * as vscode from 'vscode';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { Tool, ToolContext, ToolResult } from '../types';
import { listRepos } from '../agent/repos';
import { getConfig } from '../config';
import { readPdf } from './pdf';
import { unifiedDiff, writePreview } from './lineDiff';
import { afterEditWritten } from '../ui/editPreview';
import { lenientMatch, looksBinary, normalizeReadArgs, ReadRequest, renderWindow, windowBudget } from './readArgs';
import { CACHE_EXPIRED, isCacheRef, toolResultCache } from '../context/toolResultCache';
import { watchNewErrors } from './editDiagnostics';
import { findRoot, NamedRoot, resolveRootPath } from './rootPaths';
import { excludedBy, excludedMessage, IGNORE_FILES, invalidateIgnore } from '../agent/ignoreFile';
import * as nodeFs from 'fs';
import { notebookToCompactText } from '../context/extractors';
import { commandLogDir } from '../terminal/commandRun';

// Windows paths are case-insensitive and VS Code lowercases drive letters (`c:\`) while models and users write `C:\`.
const foldCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when `p` is `root` or inside it. */
function isWithin(p: string, root: string): boolean {
  const a = foldCase(p);
  const b = foldCase(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Path for messages and the UI: relative to the agent's root (worktree or workspace folder). */
export function displayPath(uri: vscode.Uri, ctx: ToolContext): string {
  if (ctx.workspaceRoot && isWithin(uri.fsPath, ctx.workspaceRoot)) {
    return path.relative(ctx.workspaceRoot, uri.fsPath) || '.';
  }
  // Another workspace folder or registered repository: relative to the agent's root so the path resolves back to the
  // same file (asRelativePath would prefix the folder name, e.g. `api/src/index.ts`, which lands in folder #1).
  if (ctx.workspaceRoot) {
    const others = [...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), ...registeredRepoPaths(ctx.mainRoot ?? ctx.workspaceRoot)];
    if (others.some((r) => isWithin(uri.fsPath, r))) {
      return path.relative(ctx.workspaceRoot, uri.fsPath);
    }
  }
  return vscode.workspace.asRelativePath(uri, false);
}

let repoCache: { root: string; at: number; repos: NamedRoot[] } | undefined;
/** Registered repositories of `root`, cached for a few seconds: paths are resolved on every file tool call. */
function registeredRepos(root: string): NamedRoot[] {
  if (!repoCache || repoCache.root !== root || Date.now() - repoCache.at > 5_000) {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    repoCache = { root, at: Date.now(), repos: listRepos(root, folders, getConfig().repos).map((r) => ({ name: r.name, path: r.path })) };
  }
  return repoCache.repos;
}

const registeredRepoPaths = (root: string): string[] => registeredRepos(root).map((r) => r.path);

/**
 * The folders a tool path may name (`name:rel`) or fall back to: the workspace folders — an isolated agent's own folder
 * replaced by its copy — then the registered repositories.
 */
export function toolRoots(ctx: ToolContext): NamedRoot[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const primary = ctx.workspaceRoot ?? folders[0]?.uri.fsPath;
  const out: NamedRoot[] = folders.map((f) => ({
    name: f.name,
    path: ctx.isolatedFrom && ctx.workspaceRoot && foldCase(f.uri.fsPath) === foldCase(ctx.isolatedFrom) ? ctx.workspaceRoot : f.uri.fsPath,
  }));
  for (const r of primary ? registeredRepos(ctx.mainRoot ?? primary) : []) {
    if (!out.some((o) => foldCase(o.path) === foldCase(r.path) || o.name === r.name)) {
      out.push(r);
    }
  }
  return out;
}

/** The folder of a tool's optional `root` argument (a workspace folder or repository name); the agent's root without one. */
export function rootArg(value: unknown, ctx: ToolContext): string | undefined {
  const primary = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (typeof value !== 'string' || !value.trim()) {
    return primary;
  }
  const roots = toolRoots(ctx);
  const hit = findRoot(roots, value);
  if (!hit) {
    throw new Error(`Unknown root "${value}". Use one of: ${roots.map((r) => r.name).join(', ') || '(no folders open)'}.`);
  }
  return hit.path;
}

let ignoreWatcher: vscode.Disposable | undefined;
/** The ignore file that excludes `uri` from the agent (see agent/ignoreFile), or undefined. */
export function excludedPath(uri: vscode.Uri, ctx: ToolContext, isDir = false): string | undefined {
  if (!ignoreWatcher) {
    try {
      const w = vscode.workspace.createFileSystemWatcher(`**/{${IGNORE_FILES.join(',')}}`);
      w.onDidChange(invalidateIgnore);
      w.onDidCreate(invalidateIgnore);
      w.onDidDelete(invalidateIgnore);
      ignoreWatcher = w;
    } catch {
      ignoreWatcher = { dispose() {} };
    }
  }
  const roots = [...(ctx.workspaceRoot ? [ctx.workspaceRoot] : []), ...toolRoots(ctx).map((r) => r.path)];
  return excludedBy(uri.fsPath, roots, isDir);
}

/**
 * A refusal when `p` names a file the agent ignore file excludes; undefined otherwise (also when `p` does not resolve).
 * `resolved` is the file `p` already resolved to, when the caller resolved it differently (a file to create).
 */
export function excludedRefusal(p: unknown, ctx: ToolContext, resolved?: vscode.Uri): ToolResult | undefined {
  if (typeof p !== 'string' || !p) {
    return undefined;
  }
  try {
    const uri = resolved ?? resolveWorkspacePath(p, ctx);
    const source = excludedPath(uri, ctx);
    return source ? { content: excludedMessage(displayPath(uri, ctx), source), isError: true } : undefined;
  } catch {
    return undefined;
  }
}

export function resolveWorkspacePath(p: string, ctx: ToolContext): vscode.Uri {
  return resolveToolPath(p, ctx).uri;
}

/**
 * {@link resolveWorkspacePath} plus a note when a bare relative path was found in another workspace folder. With
 * `create` (the file is about to be written) a bare path stays in the primary folder instead.
 */
export function resolveToolPath(p: string, ctx: ToolContext, create = false): { uri: vscode.Uri; note?: string } {
  const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error('No workspace folder open');
  }
  const resolved = resolveRootPath(p, root, toolRoots(ctx), (a) => nodeFs.existsSync(a), create);
  if ('error' in resolved) {
    throw new Error(resolved.error);
  }
  let abs = resolved.abs;
  // Isolated worktree: an absolute path into the real folder it mirrors (the model may have seen it in context) is
  // the same file inside the copy — never let the agent reach around its isolation. Other folders are left alone.
  if (ctx.isolatedFrom && ctx.workspaceRoot && path.isAbsolute(p) && isWithin(abs, ctx.isolatedFrom) && !isWithin(abs, ctx.workspaceRoot)) {
    abs = path.join(ctx.workspaceRoot, path.relative(ctx.isolatedFrom, abs));
  }
  const normalized = path.normalize(abs);
  // Prevent path traversal outside the workspace unless the user opened that folder — or outside the agent's
  // isolated copy of it when it works in a worktree.
  // Repositories the user registered for multi-repository work (.localpilot/repos.json, localpilot.repos) are in reach too.
  // So are the logs of detached commands, which the agent is told to read with read_file.
  const roots = [...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []), ...(ctx.workspaceRoot ? [ctx.workspaceRoot] : []), ...registeredRepoPaths(ctx.mainRoot ?? root), commandLogDir()];
  const inside = roots.some((r) => isWithin(normalized, r));
  if (!inside) {
    throw new Error(`Path is outside the workspace: ${p}`);
  }
  return { uri: vscode.Uri.file(normalized), note: resolved.note };
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) {
    throw new Error(`Missing required string argument "${name}"`);
  }
  return v;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_READ_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The file `uri` names, or the one in its folder whose name differs only in the kind of whitespace (U+202F in macOS screenshot names). */
async function statLenient(uri: vscode.Uri, shown: string): Promise<{ uri: vscode.Uri; stat: vscode.FileStat }> {
  try {
    return { uri, stat: await vscode.workspace.fs.stat(uri) };
  } catch {
    const dir = vscode.Uri.file(path.dirname(uri.fsPath));
    const names = await Promise.resolve(vscode.workspace.fs.readDirectory(dir)).then(
      (entries) => entries.map(([n]) => n),
      () => [] as string[]
    );
    const hit = lenientMatch(path.basename(uri.fsPath), names);
    if (!hit) {
      throw new Error(`${shown} not found. Check the path with list_dir or file_search.`);
    }
    const alt = vscode.Uri.file(path.join(dir.fsPath, hit));
    return { uri: alt, stat: await vscode.workspace.fs.stat(alt) };
  }
}

/** The first bytes of a file on disk; empty when it cannot be read directly. */
async function headBytes(fsPath: string, n = 8192): Promise<Uint8Array> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(fsPath, 'r');
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return new Uint8Array();
  } finally {
    await fh?.close();
  }
}

/** One file (or cached tool output) of a read_file call. Throws when the file cannot be found. */
async function readOne(req: ReadRequest, ctx: ToolContext, maxChars: number): Promise<ToolResult> {
  if (isCacheRef(req.path)) {
    return readOneFile(req, ctx, maxChars);
  }
  const { note } = resolveToolPath(req.path, ctx);
  const refused = excludedRefusal(req.path, ctx);
  if (refused) {
    return refused;
  }
  const r = await readOneFile(req, ctx, maxChars);
  return note ? { ...r, content: `${note}\n${r.content}` } : r;
}

async function readOneFile(req: ReadRequest, ctx: ToolContext, maxChars: number): Promise<ToolResult> {
  if (isCacheRef(req.path)) {
    const text = toolResultCache.get(req.path);
    if (text === undefined) {
      return { content: `${req.path}: ${CACHE_EXPIRED}`, isError: true };
    }
    const lines = text.split('\n');
    const w = renderWindow((i) => lines[i], lines.length, req.start, req.end, maxChars);
    return { content: `Cached output: ${req.path} (${lines.length} lines total, showing ${w.start}-${w.end})\n${w.text}` };
  }
  const asked = resolveWorkspacePath(req.path, ctx);
  const { uri, stat } = await statLenient(asked, displayPath(asked, ctx));
  const shown = displayPath(uri, ctx);
  if (stat.type & vscode.FileType.Directory) {
    return { content: `${shown} is a directory, not a file. Use list_dir to see what it contains.`, isError: true };
  }
  if (/\.pdf$/i.test(uri.fsPath)) {
    const pages = req.start !== undefined || req.end !== undefined ? `${req.start ?? 1}-${req.end ?? ''}` : undefined;
    const r = await readPdf({ path: uri.fsPath, pages }, ctx);
    return { ...r, content: `(read_file on a PDF: start_line/end_line are page numbers; prefer read_pdf)\n${r.content}` };
  }
  if (stat.size > MAX_READ_BYTES) {
    return { content: `${shown} is ${(stat.size / 1024 / 1024).toFixed(0)} MB, too large to read (limit 100 MB). Search it with grep_search, or print a range with run_command (sed -n '1000,1100p' or grep -n).`, isError: true };
  }
  if (IMAGE_EXT.test(uri.fsPath)) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { content: `${shown} is an image of ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 10 MB limit for images.`, isError: true };
    }
    const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
    const data = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('base64');
    return { content: `[image ${shown}: ${ext}, ${stat.size.toLocaleString()} bytes]`, images: [{ name: shown, data, mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }] };
  }
  // An open editor holds text (maybe unsaved); otherwise check the first bytes on disk before decoding the file as text.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (/\.ipynb$/i.test(uri.fsPath)) {
    const nb = await readNotebook(uri, open, shown, req, maxChars);
    if (nb) {
      return nb;
    }
  }
  if (!open && uri.scheme === 'file' && looksBinary(await headBytes(uri.fsPath))) {
    return { content: `${shown}: binary file, ${stat.size.toLocaleString()} bytes. It cannot be shown as text.`, isError: true };
  }
  let total: number;
  let line: (i: number) => string;
  try {
    const doc = open ?? (await vscode.workspace.openTextDocument(uri));
    total = doc.lineCount;
    line = (i) => doc.lineAt(i).text;
  } catch {
    // VS Code does not open very large files as documents; read them from disk.
    const lines = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').split(/\r?\n/);
    total = lines.length;
    line = (i) => lines[i];
  }
  const w = renderWindow(line, total, req.start, req.end, maxChars);
  return { content: `File: ${shown} (${total} lines total, showing ${w.start}-${w.end})\n${w.text}` };
}

/** A notebook as compact cells (line numbers index that text); undefined when it is not notebook JSON, so it reads as text. */
async function readNotebook(uri: vscode.Uri, open: vscode.TextDocument | undefined, shown: string, req: ReadRequest, maxChars: number): Promise<ToolResult | undefined> {
  let nb: { text: string; cells: number };
  try {
    nb = notebookToCompactText(open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
  } catch {
    return undefined;
  }
  const lines = nb.text.split('\n');
  const w = renderWindow((i) => lines[i], lines.length, req.start, req.end, maxChars);
  return { content: `Notebook: ${shown} (${nb.cells} cells as ${lines.length} lines; line numbers count this view, not the .ipynb JSON (edit cells with notebook_edit by cell number); showing ${w.start}-${w.end})\n${w.text}` };
}

export const readFileTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'read_file',
    description:
      'Read files from the workspace. Returns numbered lines, at most 2,000 lines per file; use start_line/end_line (1-based, inclusive) to read further. Read several files at once with "files" (up to 8, read in parallel). Images are shown to vision models. Also reads lp-cache:// references from truncated tool output.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute path' },
        start_line: { type: 'integer', description: 'First line to read (1-based)' },
        end_line: { type: 'integer', description: 'Last line to read (inclusive)' },
        files: {
          type: 'array',
          description: 'Several files in one call, instead of path',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
            required: ['path'],
          },
        },
      },
    },
  },
  async execute(args, ctx) {
    const reqs = normalizeReadArgs(args);
    if (typeof reqs === 'string') {
      return { content: reqs, isError: true };
    }
    // Windows fit the tool-output limit, so the result is never truncated (and re-cached) by the agent loop.
    const budget = windowBudget(getConfig().maxToolOutputChars, reqs.length);
    if (reqs.length === 1) {
      return readOne(reqs[0], ctx, budget);
    }
    const results = await Promise.all(
      reqs.map((r) => readOne(r, ctx, budget).catch((e: unknown): ToolResult => ({ content: `File: ${r.path}\nError: ${e instanceof Error ? e.message : String(e)}`, isError: true })))
    );
    const images = results.flatMap((r) => r.images ?? []);
    return { content: results.map((r) => r.content).join('\n\n'), isError: results.every((r) => r.isError), images: images.length ? images : undefined };
  },
};

export const writeFileTool: Tool = {
  approvalKind: 'write',
  definition: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Creates parent directories. Prefer edit_file for small changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  async execute(args, ctx) {
    // Create-or-overwrite: a bare path never falls back to another folder's file of the same name.
    const { uri } = resolveToolPath(str(args.path, 'path'), ctx, true);
    const refused = excludedRefusal(args.path, ctx, uri);
    if (refused) {
      return refused;
    }
    let content: string;
    let note = '';
    if (typeof args.content === 'string') {
      content = args.content;
    } else if (args.content !== null && typeof args.content === 'object' && /\.jsonc?$/i.test(uri.fsPath)) {
      // Models sometimes pass a JSON file's content as the parsed object instead of its text.
      content = `${JSON.stringify(args.content, null, 2)}\n`;
      note = ' (content was an object; written as JSON)';
    } else {
      return { content: 'write_file needs "content": the complete file text as a string. Nothing was written.', isError: true };
    }
    let exists = true;
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.type & vscode.FileType.Directory) {
        const rel = displayPath(uri, ctx);
        const label = rel === uri.fsPath || rel === '.' || rel === '' ? 'The workspace root' : `"${rel}"`;
        return { content: `${label} is a directory, not a file. Pass a file path such as "${path.posix.join(label === 'The workspace root' ? '' : rel, 'file.txt')}".`, isError: true };
      }
    } catch {
      exists = false;
    }
    const current = exists ? await Promise.resolve(vscode.workspace.openTextDocument(uri)).then((d) => d.getText(), () => undefined) : undefined;
    const proposal = [{ fsPath: uri.fsPath, before: current, proposed: content }];
    const ok = await ctx.requestApproval(`${exists ? 'Overwrite' : 'Create'} ${displayPath(uri, ctx)}`, writePreview(current, content), 'write', { preview: proposal });
    if (!ok) {
      return { content: 'User declined the write.', isError: true };
    }
    await ctx.trackChange(uri.fsPath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    const edit = new vscode.WorkspaceEdit();
    if (exists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
    } else {
      edit.createFile(uri, { overwrite: true, contents: Buffer.from(content, 'utf8') });
    }
    const errors = watchNewErrors(uri);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      errors.dispose();
      return { content: 'Failed to apply edit.', isError: true };
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
    await afterEditWritten(proposal).catch(() => undefined);
    return { content: `${exists ? 'Updated' : 'Created'} ${displayPath(uri, ctx)} (${doc.lineCount} lines).${note}${await errors.report()}`, data: { path: uri.fsPath, kind: exists ? 'update' : 'create' } };
  },
};

export const editFileTool: Tool = {
  approvalKind: 'write',
  definition: {
    name: 'edit_file',
    description:
      'Replace an exact text snippet in a file. `old_text` must appear exactly once (include a few lines of context to make it unique). Use empty old_text to append, or insert_line (instead of old_text) to insert new_text before that line. Keep old_text and new_text under 6,000 characters each; for larger changes send several edit_file calls in one response. Returns a diff of the change.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to replace (must match once)' },
        new_text: { type: 'string', description: 'Replacement text' },
        insert_line: { type: 'integer', description: 'Insert new_text before this line (1-based; line count + 1 appends) instead of replacing old_text' },
      },
      required: ['path', 'new_text'],
    },
  },
  async execute(args, ctx) {
    const { uri, note: rootNote } = resolveToolPath(str(args.path, 'path'), ctx);
    const refused = excludedRefusal(args.path, ctx, uri);
    if (refused) {
      return refused;
    }
    const r = await editResolved(uri, args, ctx, rootNote);
    return rootNote ? { ...r, content: `${rootNote}\n${r.content}` } : r;
  },
};

/** edit_file on the file `args.path` resolved to; `rootNote` says when that is in another workspace folder. */
async function editResolved(uri: vscode.Uri, args: Record<string, unknown>, ctx: ToolContext, rootNote?: string): Promise<ToolResult> {
  const rawInsert = args.insert_line ?? args.insertLine;
  const insertAt = rawInsert === undefined || rawInsert === null || rawInsert === '' ? undefined : Number(rawInsert);
  const rawOld = args.old_text ?? args.old_string ?? (insertAt !== undefined ? '' : undefined);
  const rawNew = args.new_text ?? args.new_string;
  if (insertAt !== undefined && !Number.isInteger(insertAt)) {
    return { content: `insert_line must be a whole line number (got ${JSON.stringify(rawInsert)}). Nothing was changed.`, isError: true };
  }
  if (typeof rawOld !== 'string' || typeof rawNew !== 'string') {
    return { content: 'edit_file needs "old_text" (exact text to replace, "" to append) and "new_text" (replacement) as strings. Nothing was changed.', isError: true };
  }
  let oldText = rawOld;
  let newText = rawNew;
  let note = '';
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    // Models routinely "append to" a file that does not exist yet; with nothing to match that is a create.
    if (!oldText && (insertAt === undefined || insertAt === 1)) {
      return writeFileTool.execute({ path: args.path, content: newText }, ctx);
    }
    return { content: `${displayPath(uri, ctx)} does not exist, so there is nothing to replace. Use write_file to create it.`, isError: true };
  }
  const tooBig = [['old_text', oldText], ['new_text', newText]].find(([, t]) => t.length > MAX_EDIT_CHARS);
  if (tooBig) {
    return { content: `${tooBig[0]} is ${tooBig[1].length.toLocaleString()} characters (limit ${MAX_EDIT_CHARS.toLocaleString()}). Split the edit into several smaller edit_file calls (send them in one response), or use write_file to replace the whole file. Nothing was changed.`, isError: true };
  }
  const text = doc.getText();
  // Models write "\n"; keep the file's own line endings (CRLF or LF) and convert the model's text to match.
  const crlf = text.includes('\r\n');
  const lf = (s: string) => s.replace(/\r\n/g, '\n');
  const eol = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : lf(s));
  if (insertAt !== undefined) {
    return insertLines(uri, doc, insertAt, eol(lf(newText).replace(/\n$/, '')), crlf ? '\r\n' : '\n', ctx, rootNote);
  }
  // Small models copy read_file's line-number gutter ("   12 | ") into old_text/new_text; take it off before matching.
  const bare = !text.includes(eol(oldText)) ? stripGutter(lf(oldText)) : undefined;
  if (bare !== undefined && text.includes(eol(bare))) {
    oldText = bare;
    newText = stripGutter(lf(newText)) ?? newText;
    note = ' (the "NN | " line-number prefixes from read_file were removed from old_text/new_text — leave them out next time)';
  }
  oldText = eol(oldText);
  newText = eol(newText);
  const baseNew = newText;
  // Finds old_text in `t` (exactly once, else whitespace-insensitively); a string is the error to report.
  const locate = (t: string): { start: number; end: number; replaced: string; newText: string; fuzzy: boolean } | string => {
    const first = t.indexOf(oldText);
    if (first < 0) {
      // Try a whitespace-insensitive match to tolerate indentation drift from the model.
      const loose = fuzzyFind(t, oldText);
      if (!loose) {
        return `old_text not found in ${displayPath(uri, ctx)}. Re-read the file and retry with the exact text.`;
      }
      // The match starts after the line's indentation; replace from the line start and give new_text the file's indentation.
      const lineStart = t.lastIndexOf('\n', loose.start - 1) + 1;
      const start = /^[ \t]*$/.test(t.slice(lineStart, loose.start)) ? lineStart : loose.start;
      const replaced = t.slice(start, loose.end);
      return { start, end: loose.end, replaced, newText: start === lineStart ? eol(reindent(lf(oldText), lf(replaced), lf(baseNew))) : baseNew, fuzzy: true };
    }
    if (t.indexOf(oldText, first + 1) >= 0) {
      return 'old_text matches more than once; include more surrounding context to make it unique.';
    }
    return { start: first, end: first + oldText.length, replaced: oldText, newText: baseNew, fuzzy: false };
  };
  let replaced = oldText;
  let range: vscode.Range;
  let expected = '';
  // The file as the edit below will leave it, for the diff preview.
  let proposed = `${text}${crlf ? '\r\n' : '\n'}${newText}`;
  if (!oldText) {
    range = new vscode.Range(doc.lineCount, 0, doc.lineCount, 0);
  } else {
    const m = locate(text);
    if (typeof m === 'string') {
      return { content: m, isError: true };
    }
    replaced = m.replaced;
    newText = m.newText;
    if (m.fuzzy) {
      note = ' (matched ignoring whitespace; indentation adapted to the file — re-read and check)';
    }
    range = new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end));
    expected = doc.getText(range);
    proposed = text.slice(0, m.start) + newText + text.slice(m.end);
  }
  const proposal = [{ fsPath: uri.fsPath, before: text, proposed }];
  const ok = await ctx.requestApproval(`Edit ${displayPath(uri, ctx)}${rootNote ? ` ${rootNote}` : ''}`, diffPreview(lf(replaced), lf(newText)), 'write', { preview: proposal });
  if (!ok) {
    return { content: 'User declined the edit.', isError: true };
  }
  await ctx.trackChange(uri.fsPath);
  // The file may have changed while the approval prompt was open: never apply a stale range. Re-opening gets the
  // live document in the editor and a fresh read from disk in the CLI.
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return { content: 'The file changed while waiting for approval — re-read it and retry.', isError: true };
  }
  if (!oldText) {
    range = new vscode.Range(doc.lineCount, 0, doc.lineCount, 0);
  } else if (doc.getText(range) !== expected) {
    const m = locate(doc.getText());
    if (typeof m === 'string' || m.replaced !== replaced) {
      return { content: 'The file changed while waiting for approval — re-read it and retry.', isError: true };
    }
    newText = m.newText;
    range = new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end));
  }
  const before = doc.getText();
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, oldText ? newText : `${crlf ? '\r\n' : '\n'}${newText}`);
  const errors = watchNewErrors(uri);
  if (!(await vscode.workspace.applyEdit(edit))) {
    errors.dispose();
    return { content: `Failed to apply the edit to ${displayPath(uri, ctx)} (the file may be read-only or changed underneath). Re-read it and retry.`, isError: true };
  }
  if (!(await doc.save())) {
    errors.dispose();
    return { content: `Edited ${displayPath(uri, ctx)} in the editor but could not save it to disk.`, isError: true };
  }
  await afterEditWritten(proposal).catch(() => undefined);
  return { content: `Edited ${displayPath(uri, ctx)} at line ${range.start.line + 1}.${note}${await diffSection(uri, before)}${await errors.report()}`, data: { path: uri.fsPath, line: range.start.line + 1 } };
}

/** Larger old_text/new_text is refused: small models garble long verbatim copies, and one bad character fails the match. */
const MAX_EDIT_CHARS = 6000;

/** The change from `before` to the file's current text, as a unified diff section of a tool result. */
async function diffSection(uri: vscode.Uri, before: string): Promise<string> {
  const after = (await vscode.workspace.openTextDocument(uri)).getText();
  const diff = unifiedDiff(before, after, { maxLines: 200 });
  return diff ? `\n\nDiff:\n${diff}` : '';
}

/** edit_file with insert_line: `text` (already in the file's line endings, no trailing newline) goes before line `at`. */
async function insertLines(uri: vscode.Uri, doc: vscode.TextDocument, at: number, text: string, eolStr: string, ctx: ToolContext, rootNote?: string): Promise<ToolResult> {
  const count = (t: string) => (t === '' ? 0 : t.split(/\r?\n/).length - (/\n$/.test(t) ? 1 : 0));
  const total = count(doc.getText());
  if (at < 1 || at > total + 1) {
    return { content: `insert_line ${at} is out of range: ${displayPath(uri, ctx)} has ${total} lines, so use 1-${total + 1} (${total + 1} appends). Nothing was changed.`, isError: true };
  }
  const current = doc.getText();
  const at0 = at <= total ? doc.offsetAt(new vscode.Position(at - 1, 0)) : current.length;
  const inserted = at <= total || current === '' || /\n$/.test(current) ? `${text}${eolStr}` : `${eolStr}${text}`;
  const proposal = [{ fsPath: uri.fsPath, before: current, proposed: current.slice(0, at0) + inserted + current.slice(at0) }];
  const ok = await ctx.requestApproval(`Edit ${displayPath(uri, ctx)}${rootNote ? ` ${rootNote}` : ''}`, diffPreview('', text.replace(/\r\n/g, '\n')), 'write', { preview: proposal });
  if (!ok) {
    return { content: 'User declined the edit.', isError: true };
  }
  await ctx.trackChange(uri.fsPath);
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return { content: 'The file changed while waiting for approval — re-read it and retry.', isError: true };
  }
  const before = doc.getText();
  if (count(before) !== total) {
    return { content: 'The file changed while waiting for approval — re-read it and retry.', isError: true };
  }
  const end = doc.positionAt(before.length);
  const edit = new vscode.WorkspaceEdit();
  if (at <= total) {
    edit.insert(uri, new vscode.Position(at - 1, 0), `${text}${eolStr}`);
  } else {
    edit.insert(uri, end, before === '' || /\n$/.test(before) ? `${text}${eolStr}` : `${eolStr}${text}`);
  }
  const errors = watchNewErrors(uri);
  if (!(await vscode.workspace.applyEdit(edit))) {
    errors.dispose();
    return { content: `Failed to apply the edit to ${displayPath(uri, ctx)} (the file may be read-only or changed underneath). Re-read it and retry.`, isError: true };
  }
  if (!(await doc.save())) {
    errors.dispose();
    return { content: `Edited ${displayPath(uri, ctx)} in the editor but could not save it to disk.`, isError: true };
  }
  await afterEditWritten(proposal).catch(() => undefined);
  const n = text.split('\n').length;
  return { content: `Inserted ${n} line${n === 1 ? '' : 's'} at line ${at} of ${displayPath(uri, ctx)}.${await diffSection(uri, before)}${await errors.report()}`, data: { path: uri.fsPath, line: at } };
}

export const listDirTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'list_dir',
    description: 'List files and folders in a directory (non-recursive). Folders end with "/".',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path, "." for workspace root' } }, required: ['path'] },
  },
  async execute(args, ctx) {
    const { uri, note } = resolveToolPath(typeof args.path === 'string' && args.path ? args.path : '.', ctx);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    // Entries the agent ignore file excludes stay visible, marked, so the model knows not to reach for them.
    const sources = new Set<string>();
    const lines = entries
      .filter(([n]) => n !== '.git' && n !== 'node_modules')
      .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === vscode.FileType.Directory ? -1 : 1))
      .map(([n, t]) => {
        const dir = t === vscode.FileType.Directory;
        const source = excludedPath(vscode.Uri.joinPath(uri, n), ctx, dir);
        if (source) {
          sources.add(source);
        }
        return `${n}${dir ? '/' : ''}${source ? ' 🔒' : ''}`;
      });
    const locked = sources.size ? `\n(🔒 excluded by ${[...sources].join(', ')}: the file tools will not read or change these)` : '';
    return { content: `${note ? `${note}\n` : ''}${lines.length ? lines.join('\n') : '(empty directory)'}${locked}` };
  },
};

export const createDirTool: Tool = {
  approvalKind: 'write',
  definition: {
    name: 'create_directory',
    description: 'Create a directory (recursively).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  async execute(args, ctx) {
    const uri = resolveWorkspacePath(str(args.path, 'path'), ctx);
    await vscode.workspace.fs.createDirectory(uri);
    return { content: `Created ${displayPath(uri, ctx)}/` };
  },
};

/** Deletes to the trash, or permanently where the file system has none (Remote-SSH, WSL, containers); the CLI uses ~/.localpilot/trash. */
export async function deleteUri(uri: vscode.Uri, recursive = false): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive, useTrash: true });
  } catch {
    await vscode.workspace.fs.delete(uri, { recursive, useTrash: false });
  }
}

export const deleteTool: Tool = {
  approvalKind: 'delete',
  definition: {
    name: 'delete_path',
    description: 'Delete a file or directory (moved to trash when possible).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  async execute(args, ctx) {
    const uri = resolveWorkspacePath(str(args.path, 'path'), ctx);
    const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).then(
      (st) => st,
      () => undefined
    );
    const isDir = !!stat && (stat.type & vscode.FileType.Directory) !== 0;
    const noTrash = !!vscode.env.remoteName;
    const cli = vscode.env.appName === 'LocalPilot CLI';
    const detail = noTrash
      ? `This permanently deletes the path.${isDir ? ' Undo cannot bring a deleted folder back.' : ''}`
      : `This moves the ${isDir ? 'folder' : 'path'} to the trash${cli ? ' (~/.localpilot/trash)' : ''}.${isDir ? ' Undo cannot bring a deleted folder back.' : ''}`;
    const ok = await ctx.requestApproval(`Delete ${displayPath(uri, ctx)}`, detail, 'delete');
    if (!ok) {
      return { content: 'User declined the deletion.', isError: true };
    }
    // A folder has no text snapshot: tracking it would record it as created, and undo would delete it again.
    if (!isDir) {
      await ctx.trackChange(uri.fsPath);
    }
    await deleteUri(uri, true);
    return { content: `Deleted ${displayPath(uri, ctx)}` };
  },
};

/** `text` without read_file's `   12 | ` gutter when every non-empty line carries one; undefined when it does not. */
export function stripGutter(text: string): string | undefined {
  const lines = text.split('\n');
  const gutter = /^ *\d+ \| ?/;
  if (!lines.some((l) => l.trim()) || !lines.every((l) => !l.trim() || gutter.test(l))) {
    return undefined;
  }
  return lines.map((l) => l.replace(gutter, '')).join('\n');
}

/**
 * `newText` re-indented for a whitespace-insensitive match: each indentation used in `oldText` maps to the file's
 * indentation on the matching line; other lines swap the common old indentation for the first matched line's.
 */
function reindent(oldText: string, matched: string, newText: string): string {
  const indentOf = (l: string) => /^[ \t]*/.exec(l)![0];
  const oldLines = oldText.split('\n').filter((l) => l.trim());
  const fileLines = matched.split('\n').filter((l) => l.trim());
  const map = new Map<string, string>();
  if (oldLines.length === fileLines.length) {
    oldLines.forEach((l, i) => {
      if (!map.has(indentOf(l))) {
        map.set(indentOf(l), indentOf(fileLines[i]));
      }
    });
  }
  const oldIndent = oldLines.map(indentOf).reduce((a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) {
      i++;
    }
    return a.slice(0, i);
  }, oldLines.length ? indentOf(oldLines[0]) : '');
  const fileIndent = indentOf(matched);
  return newText
    .split('\n')
    .map((l) => {
      if (!l.trim()) {
        return l;
      }
      const mapped = map.get(indentOf(l));
      if (mapped !== undefined) {
        return mapped + l.slice(indentOf(l).length);
      }
      return l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l;
    })
    .join('\n');
}

function fuzzyFind(haystack: string, needle: string): { start: number; end: number } | undefined {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  const n = norm(needle);
  if (!n) {
    return undefined;
  }
  // Build a map from normalized index -> original index.
  const map: number[] = [];
  let out = '';
  let prevSpace = false;
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i];
    if (ch === '\r' && haystack[i + 1] === '\n') {
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (prevSpace) {
        continue;
      }
      prevSpace = true;
      out += ' ';
      map.push(i);
    } else {
      if (ch === '\n' && out.endsWith(' ')) {
        out = out.slice(0, -1);
        map.pop();
      }
      prevSpace = ch === '\n';
      out += ch;
      map.push(i);
    }
  }
  const idx = out.indexOf(n);
  if (idx < 0 || out.indexOf(n, idx + 1) >= 0) {
    return undefined;
  }
  return { start: map[idx], end: map[idx + n.length - 1] + 1 };
}

export function diffPreview(oldText: string, newText: string): string {
  const o = oldText.split('\n').slice(0, 40).map((l) => `- ${l}`);
  const n = newText.split('\n').slice(0, 40).map((l) => `+ ${l}`);
  return [...o, ...n].join('\n');
}

export const fsTools: Tool[] = [readFileTool, writeFileTool, editFileTool, listDirTool, createDirTool, deleteTool];
