import * as vscode from 'vscode';
import type { MarkdownViewer } from '../markdownViewer';
import { ExportTarget } from './export';
import { askAboutFile, MarkdownViewSession, ReaderChat } from './viewSession';

const isMarkdown = (u: vscode.Uri) => /\.(md|markdown)$/i.test(u.path);
const isDocument = (u: vscode.Uri) => /\.(md|markdown|pdf)$/i.test(u.path);

/** The document in focus: a text editor, or a custom editor tab (Markdown reader, PDF viewer). */
function activeDocument(): vscode.Uri | undefined {
  const ed = vscode.window.activeTextEditor;
  if (ed && (ed.document.languageId === 'markdown' || isDocument(ed.document.uri))) {
    return ed.document.uri;
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
}

/** Ask LocalPilot, export and "open to the side" for the Markdown reader (palette, Explorer and editor title). */
export function registerMarkdownCommands(viewer: MarkdownViewer, chat: ReaderChat): vscode.Disposable[] {
  const exportCmd = (target: ExportTarget) => async (arg?: unknown) => {
    let session = arg instanceof vscode.Uri ? MarkdownViewSession.forUri(arg) : MarkdownViewSession.active();
    if (!session) {
      const uri = arg instanceof vscode.Uri ? arg : activeDocument();
      if (!uri || !isMarkdown(uri)) {
        void vscode.window.showInformationMessage('Open a Markdown file or the Markdown reader first.');
        return;
      }
      // Diagrams only exist once the reader has drawn them, so the export goes through a reader.
      await viewer.showFile(uri);
      session = MarkdownViewSession.forUri(uri);
    }
    session?.requestExport(target);
  };
  return [
    vscode.commands.registerCommand('localpilot.askAboutDocument', async (arg?: unknown) => {
      if (!(arg instanceof vscode.Uri)) {
        const session = MarkdownViewSession.active();
        if (session) {
          return session.ask();
        }
      }
      const uri = arg instanceof vscode.Uri ? arg : activeDocument();
      if (!uri || !isDocument(uri)) {
        void vscode.window.showInformationMessage('Open a Markdown or PDF document first.');
        return;
      }
      await askAboutFile(chat, uri);
    }),
    vscode.commands.registerCommand('localpilot.exportMarkdownHtml', exportCmd('html')),
    vscode.commands.registerCommand('localpilot.exportMarkdownPdf', exportCmd('pdf')),
    vscode.commands.registerCommand('localpilot.openMarkdownViewerToSide', async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : activeDocument();
      if (!uri || !isMarkdown(uri)) {
        void vscode.window.showInformationMessage('Open a Markdown file first.');
        return;
      }
      await viewer.showFile(uri, vscode.ViewColumn.Beside);
    }),
  ];
}
