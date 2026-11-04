import * as vscode from 'vscode';
import * as path from 'path';
import { ProposedEdit, Tool, ToolContext, ToolResult } from '../types';
import { displayPath, excludedRefusal, resolveToolPath } from './fs';
import { unifiedDiff } from './lineDiff';
import { parsePatch, patchArg, PatchError, PatchOp, planPatch, PlannedFile } from './applyPatch';
import { afterEditWritten } from '../ui/editPreview';
import { watchNewErrors } from './editDiagnostics';

const FORMAT = `Format:
*** Begin Patch
*** Update File: src/app.ts
@@ function main
 context line
-old line
+new line
*** Add File: src/new.ts
+first line
*** Delete File: src/old.ts
*** End Patch`;

/** Diff lines shown for the whole patch (approval card and tool result). */
const MAX_DIFF_LINES = 400;

/** Text of every file the patch names (undefined = missing); open editors win over the disk, as in edit_file. */
async function readAll(ops: PatchOp[], uris: Map<string, vscode.Uri>): Promise<Map<string, string | undefined>> {
  const names = [...new Set(ops.flatMap((op) => (op.type === 'update' && op.moveTo ? [op.path, op.moveTo] : [op.path])))];
  const texts = await Promise.all(
    names.map(async (n) => {
      const uri = uris.get(n)!;
      const st = await Promise.resolve(vscode.workspace.fs.stat(uri)).then(
        (s) => s,
        () => undefined
      );
      if (!st) {
        return undefined;
      }
      if (st.type & vscode.FileType.Directory) {
        throw new PatchError(`${n} is a directory, not a file.`);
      }
      return (await vscode.workspace.openTextDocument(uri)).getText();
    })
  );
  return new Map(names.map((n, i) => [n, texts[i]]));
}

function describe(f: PlannedFile, ctx: ToolContext, uris: Map<string, vscode.Uri>): string {
  const shown = (p: string) => displayPath(uris.get(p)!, ctx);
  switch (f.kind) {
    case 'add':
      return `${f.before === undefined ? 'Added' : 'Replaced'} ${shown(f.path)}`;
    case 'delete':
      return `Deleted ${shown(f.path)}`;
    case 'move':
      return `Moved ${shown(f.path)} → ${shown(f.moveTo!)}`;
    default:
      return `Updated ${shown(f.path)}`;
  }
}

function diffs(plan: PlannedFile[], ctx: ToolContext, uris: Map<string, vscode.Uri>): string {
  const per = Math.max(40, Math.floor(MAX_DIFF_LINES / plan.length));
  return plan
    .map((f) => {
      const d = f.kind === 'delete' ? '' : unifiedDiff(f.before ?? '', f.after ?? '', { maxLines: per });
      return `${describe(f, ctx, uris)}${f.fuzz ? ` (context matched ignoring ${f.fuzz === 1 ? 'trailing' : 'surrounding'} whitespace)` : ''}${d ? `\n${d}` : ''}`;
    })
    .join('\n\n');
}

function proposals(plan: PlannedFile[], uris: Map<string, vscode.Uri>): ProposedEdit[] {
  return plan.map((f) => ({ fsPath: uris.get(f.moveTo ?? f.path)!.fsPath, before: f.before, proposed: f.after }));
}

export const applyPatchTool: Tool = {
  approvalKind: 'write',
  definition: {
    name: 'apply_patch',
    description: `Edit files with a patch: update, add, move and delete several files in one call. Each change shows 3 lines of unchanged context (" "), the removed lines ("-") and the added lines ("+"); "@@ <line>" names a nearby line such as a function header when the context alone is ambiguous. Lines of an added file all start with "+".\n${FORMAT}`,
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'The whole patch, from "*** Begin Patch" to "*** End Patch"' } },
      required: ['input'],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const raw = patchArg(args);
    if (!raw) {
      return { content: `apply_patch needs "input": the patch text.\n${FORMAT}`, isError: true };
    }
    let ops: PatchOp[];
    const uris = new Map<string, vscode.Uri>();
    const notes: string[] = [];
    let plan: PlannedFile[];
    try {
      ops = parsePatch(raw);
      for (const op of ops) {
        for (const p of op.type === 'update' && op.moveTo ? [op.path, op.moveTo] : [op.path]) {
          // An added file or a move target is created: a bare path stays in the primary folder.
          const resolved = resolveToolPath(p, ctx, op.type === 'add' || p !== op.path);
          uris.set(p, resolved.uri);
          if (resolved.note && !notes.includes(resolved.note)) {
            notes.push(resolved.note);
          }
          const refused = excludedRefusal(p, ctx, resolved.uri);
          if (refused) {
            return { ...refused, content: `${refused.content}\nNothing was changed.` };
          }
        }
      }
      const texts = await readAll(ops, uris);
      plan = planPatch(ops, (p) => texts.get(p));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: `${msg}\nNothing was changed.${e instanceof PatchError && /^Line \d+|must start/.test(msg) ? `\n${FORMAT}` : ''}`, isError: true };
    }
    const names = plan.map((f) => displayPath(uris.get(f.moveTo ?? f.path)!, ctx));
    const title = `Apply patch to ${names.length === 1 ? names[0] : `${names.length} files`}${notes.length ? ` ${notes.join(' ')}` : ''}`;
    const deletes = plan.some((f) => f.kind === 'delete');
    const ok = await ctx.requestApproval(title, diffs(plan, ctx, uris), deletes ? 'delete' : 'write', { preview: proposals(plan, uris) });
    if (!ok) {
      return { content: 'User declined the patch. Nothing was changed.', isError: true };
    }
    // Files may have changed while the approval waited: plan again from what is there now, never from stale text.
    try {
      const texts = await readAll(ops, uris);
      if (plan.some((f) => texts.get(f.path) !== f.before)) {
        plan = planPatch(ops, (p) => texts.get(p));
      }
    } catch (e) {
      return { content: `The files changed while waiting for approval and the patch no longer applies: ${e instanceof Error ? e.message : String(e)}\nRe-read them and retry.`, isError: true };
    }
    for (const f of plan) {
      await ctx.trackChange(uris.get(f.path)!.fsPath);
      if (f.moveTo) {
        await ctx.trackChange(uris.get(f.moveTo)!.fsPath);
      }
    }
    const edit = new vscode.WorkspaceEdit();
    const toSave: vscode.Uri[] = [];
    for (const f of plan) {
      const uri = uris.get(f.path)!;
      if (f.kind === 'delete') {
        edit.deleteFile(uri, { ignoreIfNotExists: true });
      } else if (f.kind === 'move') {
        const target = uris.get(f.moveTo!)!;
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
        edit.createFile(target, { overwrite: true, contents: Buffer.from(f.after ?? '', 'utf8') });
        edit.deleteFile(uri, { ignoreIfNotExists: true });
      } else if (f.before === undefined) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
        edit.createFile(uri, { overwrite: true, contents: Buffer.from(f.after ?? '', 'utf8') });
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), f.after ?? '');
        toSave.push(uri);
      }
    }
    const watches = plan.filter((f) => f.kind !== 'delete').map((f) => ({ label: f.moveTo ?? f.path, watch: watchNewErrors(uris.get(f.moveTo ?? f.path)!) }));
    if (!(await vscode.workspace.applyEdit(edit))) {
      watches.forEach((w) => w.watch.dispose());
      return { content: 'Failed to apply the patch (a file may be read-only or changed underneath). Re-read the files and retry.', isError: true };
    }
    const unsaved: string[] = [];
    for (const uri of toSave) {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (!(await doc.save())) {
        unsaved.push(displayPath(uri, ctx));
      }
    }
    await afterEditWritten(proposals(plan, uris)).catch(() => undefined);
    const fuzzy = plan.some((f) => f.fuzz) ? '\nSome context only matched after ignoring whitespace; re-read those files to check.' : '';
    const warn = unsaved.length ? `\nEdited in the editor but not saved to disk: ${unsaved.join(', ')}.` : '';
    const problems = (await Promise.all(watches.map((w) => w.watch.report(w.label)))).join('');
    return {
      content: `${notes.map((n) => `${n}\n`).join('')}Applied the patch (${plan.length} file${plan.length === 1 ? '' : 's'}).${fuzzy}${warn}\n\n${diffs(plan, ctx, uris)}${problems}`,
      data: { paths: plan.map((f) => uris.get(f.moveTo ?? f.path)!.fsPath) },
    };
  },
};
