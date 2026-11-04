import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolContext } from '../types';
import { listRepos } from '../agent/repos';
import { getConfig } from '../config';

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

let repoCache: { root: string; at: number; paths: string[] } | undefined;
/** Registered repositories of `root`, cached for a few seconds: paths are resolved on every file tool call. */
function registeredRepoPaths(root: string): string[] {
  if (!repoCache || repoCache.root !== root || Date.now() - repoCache.at > 5_000) {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    repoCache = { root, at: Date.now(), paths: listRepos(root, folders, getConfig().repos).map((r) => r.path) };
  }
  return repoCache.paths;
}

export function resolveWorkspacePath(p: string, ctx: ToolContext): vscode.Uri {
  const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error('No workspace folder open');
  }
  let abs = path.isAbsolute(p) ? p : path.join(root, p);
  // Isolated worktree: an absolute path into the real folder it mirrors (the model may have seen it in context) is
  // the same file inside the copy — never let the agent reach around its isolation. Other folders are left alone.
  if (ctx.isolatedFrom && ctx.workspaceRoot && path.isAbsolute(p) && isWithin(abs, ctx.isolatedFrom) && !isWithin(abs, ctx.workspaceRoot)) {
    abs = path.join(ctx.workspaceRoot, path.relative(ctx.isolatedFrom, abs));
  }
  const normalized = path.normalize(abs);
  // Prevent path traversal outside the workspace unless the user opened that folder — or outside the agent's
  // isolated copy of it when it works in a worktree.
  // Repositories the user registered for multi-repository work (.localpilot/repos.json, localpilot.repos) are in reach too.
  const roots = [...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []), ...(ctx.workspaceRoot ? [ctx.workspaceRoot] : []), ...registeredRepoPaths(ctx.mainRoot ?? root)];
  const inside = roots.some((r) => isWithin(normalized, r));
  if (!inside) {
    throw new Error(`Path is outside the workspace: ${p}`);
  }
  return vscode.Uri.file(normalized);
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) {
    throw new Error(`Missing required string argument "${name}"`);
  }
  return v;
}

export const readFileTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'read_file',
    description:
      'Read a file from the workspace. Returns numbered lines. For large files use start_line/end_line to read a range (1-based, inclusive).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute path' },
        start_line: { type: 'integer', description: 'First line to read (1-based)' },
        end_line: { type: 'integer', description: 'Last line to read (inclusive)' },
      },
      required: ['path'],
    },
  },
  async execute(args, ctx) {
    const uri = resolveWorkspacePath(str(args.path, 'path'), ctx);
    const doc = await vscode.workspace.openTextDocument(uri);
    const start = Math.max(1, Number(args.start_line ?? 1));
    // At most 2,000 lines per read and 2,000 characters per line (minified code): a whole large file in one result
    // would only be cut from the middle later, without telling the model where to continue.
    const end = Math.min(doc.lineCount, Number(args.end_line ?? Math.min(doc.lineCount, start + 799)), start + 1999);
    const lines: string[] = [];
    for (let i = start - 1; i < end; i++) {
      const t = doc.lineAt(i).text;
      lines.push(`${String(i + 1).padStart(5)} | ${t.length > 2000 ? `${t.slice(0, 2000)} … [line cut: ${t.length.toLocaleString()} characters]` : t}`);
    }
    const header = `File: ${displayPath(uri, ctx)} (${doc.lineCount} lines total, showing ${start}-${end})`;
    const more = end < doc.lineCount && args.end_line !== undefined && Number(args.end_line) > end ? `\n… read the rest with start_line ${end + 1}` : '';
    return { content: `${header}\n${lines.join('\n')}${more}` };
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
    const uri = resolveWorkspacePath(str(args.path, 'path'), ctx);
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
    const ok = await ctx.requestApproval(`${exists ? 'Overwrite' : 'Create'} ${displayPath(uri, ctx)}`, `${content.length} characters`, 'write');
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
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      return { content: 'Failed to apply edit.', isError: true };
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
    return { content: `${exists ? 'Updated' : 'Created'} ${displayPath(uri, ctx)} (${doc.lineCount} lines).${note}`, data: { path: uri.fsPath, kind: exists ? 'update' : 'create' } };
  },
};

export const editFileTool: Tool = {
  approvalKind: 'write',
  definition: {
    name: 'edit_file',
    description:
      'Replace an exact text snippet in a file. `old_text` must appear exactly once (include a few lines of context to make it unique). Use empty old_text to append.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to replace (must match once)' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  async execute(args, ctx) {
    const uri = resolveWorkspacePath(str(args.path, 'path'), ctx);
    const rawOld = args.old_text ?? args.old_string;
    const rawNew = args.new_text ?? args.new_string;
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
      if (!oldText) {
        return writeFileTool.execute({ path: args.path, content: newText }, ctx);
      }
      return { content: `${displayPath(uri, ctx)} does not exist, so there is nothing to replace. Use write_file to create it.`, isError: true };
    }
    const text = doc.getText();
    // Models write "\n"; a CRLF file only matches (and stays consistent) with its own line endings.
    const crlf = text.includes('\r\n');
    const eol = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    // Small models copy read_file's line-number gutter ("   12 | ") into old_text/new_text; take it off before matching.
    const bare = !text.includes(eol(oldText)) ? stripGutter(lf(oldText)) : undefined;
    if (bare !== undefined && text.includes(eol(bare))) {
      oldText = bare;
      newText = stripGutter(lf(newText)) ?? newText;
      note = ' (the "NN | " line-number prefixes from read_file were removed from old_text/new_text — leave them out next time)';
    }
    oldText = eol(oldText);
    newText = eol(newText);
    let replaced = oldText;
    let range: vscode.Range;
    if (!oldText) {
      range = new vscode.Range(doc.lineCount, 0, doc.lineCount, 0);
    } else {
      const first = text.indexOf(oldText);
      if (first < 0) {
        // Try a whitespace-insensitive match to tolerate indentation drift from the model.
        const loose = fuzzyFind(text, oldText);
        if (!loose) {
          return { content: `old_text not found in ${displayPath(uri, ctx)}. Re-read the file and retry with the exact text.`, isError: true };
        }
        // The match starts after the line's indentation; replace from the line start and give new_text the file's indentation.
        const lineStart = text.lastIndexOf('\n', loose.start - 1) + 1;
        const start = /^[ \t]*$/.test(text.slice(lineStart, loose.start)) ? lineStart : loose.start;
        replaced = text.slice(start, loose.end);
        if (start === lineStart) {
          newText = eol(reindent(lf(oldText), lf(replaced), lf(newText)));
        }
        note = ' (matched ignoring whitespace; indentation adapted to the file — re-read and check)';
        range = new vscode.Range(doc.positionAt(start), doc.positionAt(loose.end));
      } else {
        if (text.indexOf(oldText, first + 1) >= 0) {
          return { content: 'old_text matches more than once; include more surrounding context to make it unique.', isError: true };
        }
        range = new vscode.Range(doc.positionAt(first), doc.positionAt(first + oldText.length));
      }
    }
    const ok = await ctx.requestApproval(`Edit ${displayPath(uri, ctx)}`, diffPreview(lf(replaced), lf(newText)), 'write');
    if (!ok) {
      return { content: 'User declined the edit.', isError: true };
    }
    await ctx.trackChange(uri.fsPath);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, oldText ? newText : `${crlf ? '\r\n' : '\n'}${newText}`);
    if (!(await vscode.workspace.applyEdit(edit))) {
      return { content: `Failed to apply the edit to ${displayPath(uri, ctx)} (the file may be read-only or changed underneath). Re-read it and retry.`, isError: true };
    }
    if (!(await doc.save())) {
      return { content: `Edited ${displayPath(uri, ctx)} in the editor but could not save it to disk.`, isError: true };
    }
    return { content: `Edited ${displayPath(uri, ctx)} at line ${range.start.line + 1}.${note}`, data: { path: uri.fsPath, line: range.start.line + 1 } };
  },
};

export const listDirTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'list_dir',
    description: 'List files and folders in a directory (non-recursive). Folders end with "/".',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path, "." for workspace root' } }, required: ['path'] },
  },
  async execute(args, ctx) {
    const uri = resolveWorkspacePath(typeof args.path === 'string' && args.path ? args.path : '.', ctx);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const lines = entries
      .filter(([n]) => n !== '.git' && n !== 'node_modules')
      .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === vscode.FileType.Directory ? -1 : 1))
      .map(([n, t]) => (t === vscode.FileType.Directory ? `${n}/` : n));
    return { content: lines.length ? lines.join('\n') : '(empty directory)' };
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
    const detail = isDir ? 'This moves the folder to the trash. Undo cannot bring a deleted folder back.' : 'This moves the path to the trash.';
    const ok = await ctx.requestApproval(`Delete ${displayPath(uri, ctx)}`, detail, 'delete');
    if (!ok) {
      return { content: 'User declined the deletion.', isError: true };
    }
    // A folder has no text snapshot: tracking it would record it as created, and undo would delete it again.
    if (!isDir) {
      await ctx.trackChange(uri.fsPath);
    }
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
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
