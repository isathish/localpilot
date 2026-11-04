import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig } from '../config';
import { ApprovalDecision, ProposedEdit } from '../types';

export const PROPOSED_SCHEME = 'localpilot-proposed';
/** Diff tabs opened for one approval (apply_patch may touch many files). */
const MAX_TABS = 5;
const OPEN_TIMEOUT_MS = 5_000;
/** An approved edit opens its file once written, if it is written within this time. */
const REVEAL_WINDOW_MS = 120_000;

/** Both sides of every preview: `?side=original` is the file before the edit, `?side=proposed` what the tool will write. */
class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? '';
  }

  set(uri: vscode.Uri, text: string): void {
    this.content.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  forget(fsPath: string): void {
    for (const side of ['original', 'proposed']) {
      this.content.delete(sideUri(fsPath, side).toString());
    }
  }
}

const provider = new ProposedContentProvider();
/** Latest preview of each file: an older approval closing must not close the newer tab that replaced its own. */
const generation = new Map<string, number>();
/** Files whose previewed edit was approved, waiting to be written. */
const approved = new Map<string, number>();
let nextGen = 0;

function sideUri(fsPath: string, side: string): vscode.Uri {
  return vscode.Uri.file(fsPath).with({ scheme: PROPOSED_SCHEME, query: `side=${side}` });
}

/** No editor to show tabs in: the terminal CLI. */
const headless = () => vscode.env.appName === 'LocalPilot CLI' || !vscode.window.tabGroups?.onDidChangeTabs;

/** Registers the `localpilot-proposed` content provider (next to the change tracker's `localpilot-original`). */
export function registerProposedContent(): vscode.Disposable {
  if (headless()) {
    return new vscode.Disposable(() => undefined);
  }
  return vscode.Disposable.from(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider),
    // A closed diff tab no longer needs its two texts.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const t of e.closed) {
        if (t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSED_SCHEME && !proposedTabs(t.input.modified.fsPath).length) {
          provider.forget(t.input.modified.fsPath);
        }
      }
    })
  );
}

function proposedTabs(fsPath?: string): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) =>
    g.tabs.filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSED_SCHEME && (fsPath === undefined || t.input.modified.fsPath === vscode.Uri.file(fsPath).fsPath))
  );
}

/** True while a preview diff of `fsPath` (any file when omitted) is open. */
export function hasProposedTab(fsPath?: string): boolean {
  return !headless() && proposedTabs(fsPath).length > 0;
}

/** Opens `Original ↔ LocalPilot (proposed)` diffs without taking focus; gives up waiting after 5 s and never throws. */
async function openDiffs(edits: ProposedEdit[]): Promise<void> {
  const shown = edits.slice(0, MAX_TABS);
  const open = Promise.all(
    shown.map(async (e) => {
      const left = sideUri(e.fsPath, 'original');
      const right = sideUri(e.fsPath, 'proposed');
      provider.set(left, e.before ?? '');
      provider.set(right, e.proposed ?? '');
      const title = `${path.basename(e.fsPath)}: Original ↔ LocalPilot (proposed)`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: shown.length === 1, preserveFocus: true });
    })
  ).catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([open, new Promise<void>((r) => (timer = setTimeout(r, OPEN_TIMEOUT_MS)))]);
  clearTimeout(timer);
}

async function closeDiffs(fsPaths: string[]): Promise<void> {
  const tabs = fsPaths.flatMap((p) => proposedTabs(p));
  if (tabs.length) {
    await Promise.resolve(vscode.window.tabGroups.close(tabs, true)).catch(() => undefined);
  }
  fsPaths.forEach((p) => provider.forget(p));
}

/**
 * Runs `ask` (the approval prompt) with a diff of each proposed edit open beside it (`localpilot.diffPreview`), and
 * closes the diffs once the user answers. A newer preview of the same file replaces the older tab.
 */
export async function withEditPreview<T extends boolean | ApprovalDecision>(edits: ProposedEdit[] | undefined, ask: () => Promise<T>): Promise<T> {
  if (!edits?.length || getConfig().diffPreview === 'off' || headless()) {
    return ask();
  }
  const gens = new Map(edits.map((e) => [e.fsPath, ++nextGen]));
  gens.forEach((g, p) => generation.set(p, g));
  await openDiffs(edits);
  let result: T | undefined;
  try {
    result = await ask();
    return result;
  } finally {
    const ok = result === true || (typeof result === 'object' && !!result && result.ok);
    const mine = edits.map((e) => e.fsPath).filter((p) => generation.get(p) === gens.get(p));
    mine.forEach((p) => generation.delete(p));
    await closeDiffs(mine);
    if (ok) {
      edits.forEach((e) => approved.set(e.fsPath, Date.now()));
    }
  }
}

/**
 * After an edit tool wrote its files: a file whose preview was approved opens normally (without focus); an edit
 * approved without a prompt gets its diff only under `diffPreview: always`.
 */
export async function afterEditWritten(edits: ProposedEdit[]): Promise<void> {
  if (headless()) {
    return;
  }
  const mode = getConfig().diffPreview;
  const unprompted: ProposedEdit[] = [];
  for (const e of edits) {
    const at = approved.get(e.fsPath);
    approved.delete(e.fsPath);
    if (at !== undefined && Date.now() - at < REVEAL_WINDOW_MS) {
      if (e.proposed !== undefined) {
        await Promise.resolve(vscode.window.showTextDocument(vscode.Uri.file(e.fsPath), { preview: true, preserveFocus: true })).catch(() => undefined);
      }
    } else if (mode === 'always') {
      unprompted.push(e);
    }
  }
  if (unprompted.length) {
    unprompted.forEach((e) => generation.set(e.fsPath, ++nextGen));
    await openDiffs(unprompted);
  }
}
