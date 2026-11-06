import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig } from '../config';
import { ChangeTracker } from '../agent/changeTracker';
import { planCodeApply } from '../agent/codeApplyPlan';
import { withEditPreview } from './editPreview';

/** What the chat's code-block Apply / Create button asks for. */
export interface CodeApplyRequest {
  sessionId?: string;
  code: string;
  /** Path from the block's fence info or the line before it (workspace-relative or absolute); absent = the active file. */
  path?: string;
  /** The chat found no such file: create it (after confirming the path). */
  create?: boolean;
  /** The fence language, used when the block is handed to the agent to merge. */
  lang?: string;
}

export interface CodeApplyDeps {
  tracker: ChangeTracker;
  /** The chat's folder (relative paths resolve against it); undefined = no folder open. */
  root?: string;
  /** The editor the chat would insert into (Apply without a path targets its file). */
  activeDocument?: vscode.TextDocument;
  /** Whether the chat's mode may edit files (the agent can be asked to merge a fragment). */
  canAskAgent: boolean;
  /** Hands a prompt to the chat (a steer while it runs, a new turn when idle). */
  askAgent(text: string): Promise<void>;
  toast(level: 'info' | 'warn' | 'error', text: string, action?: { label: string; fsPath: string }): void;
  /** Tests answer the prompts. */
  ui?: {
    confirmPath?(rel: string, root: string): Promise<string | undefined>;
    pickPartial?(rel: string, canAskAgent: boolean): Promise<'agent' | 'replace' | undefined>;
    confirmApply?(rel: string, what: string): Promise<boolean>;
  };
}

export type CodeApplyOutcome = 'created' | 'replaced' | 'merged' | 'same' | 'asked-agent' | 'cancelled' | 'failed';

const inside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The workspace folder that contains `fsPath`, or undefined (paths outside every folder are not written). */
function owningRoot(fsPath: string, root?: string): string | undefined {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  return [root, ...folders].find((r): r is string => !!r && inside(r, fsPath));
}

async function exists(fsPath: string): Promise<boolean> {
  return Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).then(
    (s) => !(s.type & vscode.FileType.Directory),
    () => false
  );
}

async function currentText(fsPath: string): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === vscode.Uri.file(fsPath).fsPath);
  if (open) {
    return open.getText();
  }
  try {
    return (await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath))).getText();
  } catch {
    return undefined;
  }
}

/**
 * Apply (or create a file from) a chat code block. Every write goes through the change tracker first, so it joins the
 * chat's review queue (M or A) and the latest message's checkpoint, never a raw write; edits to an existing file are
 * shown as a proposed diff and wait for a confirmation unless `localpilot.diffPreview` is off.
 */
export async function applyCodeBlock(req: CodeApplyRequest, deps: CodeApplyDeps): Promise<CodeApplyOutcome> {
  const sid = req.sessionId;
  if (!sid) {
    deps.toast('error', 'Open a chat first');
    return 'failed';
  }
  let fsPath: string | undefined;
  if (req.path) {
    const rel = req.path.replace(/^\.\//, '');
    fsPath = path.isAbsolute(rel) ? rel : deps.root ? path.resolve(deps.root, ...rel.split('/')) : undefined;
    if (!fsPath) {
      deps.toast('error', 'Open a folder to apply code blocks to files');
      return 'failed';
    }
  } else {
    const doc = deps.activeDocument;
    if (!doc) {
      deps.toast('error', 'Open the target file first');
      return 'failed';
    }
    if (doc.uri.scheme !== 'file') {
      deps.toast('error', 'Save the file first: Apply writes to files on disk so the change can be reviewed');
      return 'failed';
    }
    fsPath = doc.uri.fsPath;
  }
  let root = owningRoot(fsPath, deps.root);
  if (!root) {
    deps.toast('error', `${req.path ?? path.basename(fsPath)} is outside the workspace`);
    return 'failed';
  }
  if (!(await exists(fsPath))) {
    // Create: the path is confirmed (and can be changed) before anything is written.
    const rel0 = path.relative(root, fsPath).split(path.sep).join('/');
    const ask = deps.ui?.confirmPath ?? confirmPathBox;
    const picked = await ask(rel0, root);
    if (!picked) {
      return 'cancelled';
    }
    fsPath = path.isAbsolute(picked) ? picked : path.resolve(root, ...picked.split('/'));
    root = owningRoot(fsPath, deps.root);
    if (!root) {
      deps.toast('error', `${picked} is outside the workspace`);
      return 'failed';
    }
    if (await exists(fsPath)) {
      deps.toast('error', `${picked} already exists: use Apply to change it`);
      return 'failed';
    }
    const plan = planCodeApply(undefined, req.code);
    return (await write(fsPath, plan.kind === 'create' ? plan.text : req.code, sid, deps, true)) ? done(deps, 'created', fsPath, root) : 'failed';
  }
  const rel = path.relative(root, fsPath).split(path.sep).join('/');
  const current = await currentText(fsPath);
  if (current === undefined) {
    deps.toast('error', `Cannot read ${rel}`);
    return 'failed';
  }
  let plan = planCodeApply(current, req.code);
  if (plan.kind === 'same') {
    deps.toast('info', `${rel} already matches this code block`);
    return 'same';
  }
  if (plan.kind === 'partial') {
    const pick = await (deps.ui?.pickPartial ?? pickPartialQuick)(rel, deps.canAskAgent);
    if (!pick) {
      return 'cancelled';
    }
    if (pick === 'agent') {
      const fence = '```';
      await deps.askAgent(`Merge this code block into ${rel}. Change only what the block changes and keep the rest of the file as it is.\n\n${fence}${req.lang ?? ''}\n${req.code.replace(/\n+$/, '')}\n${fence}`);
      return 'asked-agent';
    }
    plan = { kind: 'replace', text: req.code.endsWith('\n') ? req.code : `${req.code}\n` };
  }
  const text = plan.text;
  const what = plan.kind === 'merge' ? `Replace lines ${plan.from + 1}–${plan.to + 1} of ${rel} with this code block?` : `Replace the contents of ${rel} with this code block?`;
  if (getConfig().diffPreview !== 'off') {
    const confirm = deps.ui?.confirmApply ?? confirmBox;
    const ok = await withEditPreview([{ fsPath, before: current, proposed: text }], () => confirm(rel, what));
    if (!ok) {
      return 'cancelled';
    }
  }
  const outcome = plan.kind === 'merge' ? 'merged' : 'replaced';
  return (await write(fsPath, text, sid, deps, false)) ? done(deps, outcome, fsPath, root) : 'failed';
}

function done(deps: CodeApplyDeps, outcome: 'created' | 'replaced' | 'merged', fsPath: string, root: string): CodeApplyOutcome {
  const rel = path.relative(root, fsPath).split(path.sep).join('/');
  const verb = outcome === 'created' ? 'Created' : outcome === 'merged' ? 'Merged the code block into' : 'Applied the code block to';
  deps.toast('info', `${verb} ${rel}: it is waiting for review in the Changes list`, { label: 'Review', fsPath });
  return outcome;
}

/** Snapshot through the change tracker, then write and save (a new file is created with its folders). */
async function write(fsPath: string, text: string, sid: string, deps: CodeApplyDeps, create: boolean): Promise<boolean> {
  const uri = vscode.Uri.file(fsPath);
  try {
    await deps.tracker.beforeChange(fsPath, sid);
    const edit = new vscode.WorkspaceEdit();
    if (create) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fsPath)));
      edit.createFile(uri, { overwrite: false, contents: Buffer.from(text, 'utf8') });
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error('the editor refused the edit');
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true }).then(undefined, () => undefined);
    return true;
  } catch (e) {
    // Nothing was written (or the write failed): a snapshot taken for a file the chat had not touched is dropped again.
    await deps.tracker.settle(sid).catch(() => undefined);
    deps.toast('error', `Could not write ${path.basename(fsPath)}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function confirmPathBox(rel: string, root: string): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({
    title: 'Create a file from this code block',
    prompt: `Path of the new file, relative to ${path.basename(root)}`,
    value: rel,
    valueSelection: [rel.lastIndexOf('/') + 1, rel.length],
    validateInput: (s) => {
      const t = s.trim();
      if (!t) {
        return 'Enter a file path';
      }
      const abs = path.isAbsolute(t) ? t : path.resolve(root, ...t.split('/'));
      return inside(root, abs) || (vscode.workspace.workspaceFolders ?? []).some((f) => inside(f.uri.fsPath, abs)) ? undefined : 'The file must be inside the workspace';
    },
  });
  return v?.trim() || undefined;
}

async function pickPartialQuick(rel: string, canAskAgent: boolean): Promise<'agent' | 'replace' | undefined> {
  type Item = vscode.QuickPickItem & { id: 'agent' | 'replace' };
  const items: Item[] = [
    ...(canAskAgent ? [{ id: 'agent' as const, label: '$(sparkle) Ask the agent to merge it', detail: `The agent edits ${rel} in this chat; the change waits for your review` }] : []),
    { id: 'replace', label: '$(replace-all) Replace the whole file', detail: `${rel} becomes exactly this block (shown in a diff first)` },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Merge into ${rel}`,
    placeHolder: canAskAgent ? 'This block looks like part of the file, and LocalPilot could not tell where it goes' : 'This block looks like part of the file. Switch to Agent mode to have the agent merge it',
  });
  return pick?.id;
}

async function confirmBox(rel: string, what: string): Promise<boolean> {
  // Not modal: a modal dialog would cover the diff it asks about.
  return (await vscode.window.showInformationMessage(`${what} The proposed ${rel} is open in a diff; once applied it waits for review in the Changes list.`, 'Apply', 'Cancel')) === 'Apply';
}
