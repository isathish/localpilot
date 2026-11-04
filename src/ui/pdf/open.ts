import * as vscode from 'vscode';

export const PDF_VIEW_TYPE = 'localpilot.pdfViewer';

interface LiveView {
  reveal(page?: number): void;
}

/** Open PDF viewers by file URI, so a link to an open file turns the page instead of opening a second tab. */
export const livePdfViews = {
  views: new Map<string, LiveView>(),
  add(key: string, v: LiveView): void {
    this.views.set(key, v);
  },
  delete(key: string, v: LiveView): void {
    if (this.views.get(key) === v) {
      this.views.delete(key);
    }
  },
};

/** Opens a PDF in the LocalPilot viewer, at `page` when given (chat links pass `x.pdf:3` as line 3). */
export async function openPdf(uri: vscode.Uri, page?: number): Promise<void> {
  const file = uri.with({ fragment: '' });
  const n = page && page > 0 ? Math.floor(page) : undefined;
  const key = file.toString();
  const live = livePdfViews.views.get(key);
  if (live) {
    live.reveal(n);
    return;
  }
  // A tab of this file whose viewer is still starting (a second link clicked right after the first): focus that tab
  // and go to the page once its viewer has registered, instead of opening the file again.
  const tab = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === PDF_VIEW_TYPE && t.input.uri.with({ fragment: '' }).toString() === key);
  if (tab) {
    await vscode.commands.executeCommand('vscode.openWith', (tab.input as vscode.TabInputCustom).uri, PDF_VIEW_TYPE);
    for (let i = 0; i < 50; i++) {
      const v = livePdfViews.views.get(key);
      if (v) {
        v.reveal(n);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', n ? file.with({ fragment: `page=${n}` }) : file, PDF_VIEW_TYPE);
}

export const isPdfPath = (p: string): boolean => /\.pdf$/i.test(p);
