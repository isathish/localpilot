import * as vscode from 'vscode';
import { FileIndexStatus } from '../context/fileIndex';

export const REBUILD_INDEX_COMMAND = 'localpilot.rebuildFileIndex';
/** A scan that finishes sooner than this never shows in the status bar (no flicker on small workspaces). */
const SHOW_AFTER_MS = 800;

const SEMANTIC = 'No semantic (embedding) index: LocalPilot finds code by text, file name, symbols and the import graph.';

/** Text and tooltip of the status bar item; undefined when there is nothing worth showing (small repo, scan done). */
export function indexStatusItem(s: FileIndexStatus | undefined): { text: string; tooltip: string } | undefined {
  if (!s || s.state === 'idle') {
    return undefined;
  }
  if (s.state === 'indexing') {
    return { text: `$(sync~spin) Indexing ${s.pct}%`, tooltip: `LocalPilot is listing the workspace's files for @ mentions: ${s.files.toLocaleString()} found so far.` };
  }
  if (s.files > s.listed) {
    const total = `${s.files.toLocaleString()}${s.capped ? '+' : ''}`;
    return {
      text: `$(list-tree) ${s.listed.toLocaleString()} of ${total} files`,
      tooltip: `Large repo: the @ menu lists ${s.listed.toLocaleString()} of ${total} files. The agent's search tools (grep_search, file_search, repo_graph) still cover every file.\n${SEMANTIC}\nClick to rescan.`,
    };
  }
  return undefined;
}

/** The status bar item for the `@` file index: scan progress, then the large-repo note. Click rescans. */
export function createIndexStatusBar(source: { onDidChangeIndex: vscode.Event<FileIndexStatus>; indexStatus: FileIndexStatus | undefined }): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('localpilot.fileIndex', vscode.StatusBarAlignment.Right, 89);
  item.name = 'LocalPilot file index';
  item.command = { command: REBUILD_INDEX_COMMAND, title: 'Rebuild file index' };
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const render = (s: FileIndexStatus | undefined) => {
    const v = indexStatusItem(s);
    if (!v) {
      since = 0;
      item.hide();
      return;
    }
    item.text = v.text;
    item.tooltip = v.tooltip;
    if (s?.state === 'indexing') {
      since ||= Date.now();
      const wait = SHOW_AFTER_MS - (Date.now() - since);
      if (wait > 0) {
        clearTimeout(timer);
        timer = setTimeout(() => render(source.indexStatus), wait);
        return;
      }
    } else {
      since = 0;
    }
    item.show();
  };
  const sub = source.onDidChangeIndex(render);
  render(source.indexStatus);
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    sub.dispose();
    item.dispose();
  });
}
