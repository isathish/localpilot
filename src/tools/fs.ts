import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolContext } from '../types';

export function resolveWorkspacePath(p: string, ctx: ToolContext): vscode.Uri {
  const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error('No workspace folder open');
  }
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  const normalized = path.normalize(abs);
  // Prevent path traversal outside the workspace unless the user opened that folder.
  const inside = vscode.workspace.workspaceFolders?.some((f) => normalized.startsWith(f.uri.fsPath + path.sep) || normalized === f.uri.fsPath);
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
    const end = Math.min(doc.lineCount, Number(args.end_line ?? Math.min(doc.lineCount, start + 799)));
    const lines: string[] = [];
    for (let i = start - 1; i < end; i++) {
      lines.push(`${String(i + 1).padStart(5)} | ${doc.lineAt(i).text}`);
    }
    const header = `File: ${vscode.workspace.asRelativePath(uri)} (${doc.lineCount} lines total, showing ${start}-${end})`;
    return { content: `${header}\n${lines.join('\n')}` };
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
    const content = typeof args.content === 'string' ? args.content : '';
    let exists = true;
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.type & vscode.FileType.Directory) {
        const rel = vscode.workspace.asRelativePath(uri);
        const label = rel === uri.fsPath || rel === '.' || rel === '' ? 'The workspace root' : `"${rel}"`;
        return { content: `${label} is a directory, not a file. Pass a file path such as "${path.posix.join(label === 'The workspace root' ? '' : rel, 'file.txt')}".`, isError: true };
      }
    } catch {
      exists = false;
    }
    const ok = await ctx.requestApproval(`${exists ? 'Overwrite' : 'Create'} ${vscode.workspace.asRelativePath(uri)}`, `${content.length} characters`, 'write');
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
    return { content: `${exists ? 'Updated' : 'Created'} ${vscode.workspace.asRelativePath(uri)} (${doc.lineCount} lines).`, data: { path: uri.fsPath, kind: exists ? 'update' : 'create' } };
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
    const oldText = typeof args.old_text === 'string' ? args.old_text : '';
    const newText = typeof args.new_text === 'string' ? args.new_text : '';
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    let range: vscode.Range;
    if (!oldText) {
      range = new vscode.Range(doc.lineCount, 0, doc.lineCount, 0);
    } else {
      const first = text.indexOf(oldText);
      if (first < 0) {
        // Try a whitespace-insensitive match to tolerate indentation drift from the model.
        const loose = fuzzyFind(text, oldText);
        if (!loose) {
          return { content: `old_text not found in ${vscode.workspace.asRelativePath(uri)}. Re-read the file and retry with the exact text.`, isError: true };
        }
        range = new vscode.Range(doc.positionAt(loose.start), doc.positionAt(loose.end));
      } else {
        if (text.indexOf(oldText, first + 1) >= 0) {
          return { content: 'old_text matches more than once; include more surrounding context to make it unique.', isError: true };
        }
        range = new vscode.Range(doc.positionAt(first), doc.positionAt(first + oldText.length));
      }
    }
    const ok = await ctx.requestApproval(`Edit ${vscode.workspace.asRelativePath(uri)}`, diffPreview(oldText, newText), 'write');
    if (!ok) {
      return { content: 'User declined the edit.', isError: true };
    }
    await ctx.trackChange(uri.fsPath);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, oldText ? newText : `\n${newText}`);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    return { content: `Edited ${vscode.workspace.asRelativePath(uri)} at line ${range.start.line + 1}.`, data: { path: uri.fsPath, line: range.start.line + 1 } };
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
    return { content: `Created ${vscode.workspace.asRelativePath(uri)}/` };
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
    const ok = await ctx.requestApproval(`Delete ${vscode.workspace.asRelativePath(uri)}`, 'This moves the path to the trash.', 'delete');
    if (!ok) {
      return { content: 'User declined the deletion.', isError: true };
    }
    await ctx.trackChange(uri.fsPath);
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
    return { content: `Deleted ${vscode.workspace.asRelativePath(uri)}` };
  },
};

function fuzzyFind(haystack: string, needle: string): { start: number; end: number } | undefined {
  const norm = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
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
