import * as vscode from 'vscode';

/**
 * Ctrl/Cmd+' inside a viewer webview reaches two handlers: the webview script, which knows the selection, and the
 * `localpilot.askAboutDocument` keybinding, because webviews forward key presses to the workbench. The webview's ask
 * wins: the host notes it here, and the command, run while a viewer tab is focused, waits a moment for that note and
 * stands down when it came in.
 */
const asked = new Map<string, number>();
const WINDOW_MS = 1500;
const WAIT_MS = 250;

const keyOf = (id: vscode.Uri | string): string => (typeof id === 'string' ? id : id.with({ fragment: '', query: '' }).toString());

/** A viewer's webview handled Ctrl/Cmd+' itself for `id` (the document's URI, or a reader's own id). */
export function noteViewerKeyAsk(id: vscode.Uri | string): void {
  const now = Date.now();
  for (const [k, at] of asked) {
    if (now - at > WINDOW_MS) {
      asked.delete(k);
    }
  }
  asked.set(keyOf(id), now);
}

/** True when the command should do nothing because the focused viewer already answered the same key press. */
export async function viewerAnsweredKey(id: vscode.Uri | string): Promise<boolean> {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputWebview)) {
    return false;
  }
  const key = keyOf(id);
  const seen = () => {
    const at = asked.get(key);
    return at !== undefined && Date.now() - at < WINDOW_MS;
  };
  if (!seen()) {
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }
  if (!seen()) {
    return false;
  }
  asked.delete(key);
  return true;
}
