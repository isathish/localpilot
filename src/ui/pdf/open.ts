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
  const live = livePdfViews.views.get(file.toString());
  if (live) {
    live.reveal(n);
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', n ? file.with({ fragment: `page=${n}` }) : file, PDF_VIEW_TYPE);
}

export const isPdfPath = (p: string): boolean => /\.pdf$/i.test(p);
