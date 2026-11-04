import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { userMcpFile } from '../mcp/config';

/** What a new server file starts as: the shape Claude Code, Cline and LocalPilot all read. */
export const MCP_FILE_TEMPLATE = `{
  "mcpServers": {
  }
}
`;

export interface McpConfigTarget {
  kind: 'user' | 'project' | 'settings';
  label: string;
  description: string;
  /** The file to open (none for settings.json, which VS Code opens itself). */
  file?: string;
}

/** The places MCP servers are configured: the user file, each workspace folder's `.mcp.json`, and settings.json. */
export function mcpConfigTargets(folders: { name: string; path: string }[], userFile = userMcpFile()): McpConfigTarget[] {
  const multi = folders.length > 1;
  return [
    { kind: 'user', label: 'User mcp.json', description: userFile, file: userFile },
    ...folders.map((f): McpConfigTarget => ({ kind: 'project', label: multi ? `Workspace .mcp.json (${f.name})` : 'Workspace .mcp.json', description: path.join(f.path, '.mcp.json'), file: path.join(f.path, '.mcp.json') })),
    { kind: 'settings', label: 'settings.json', description: 'the localpilot.mcpServers setting' },
  ];
}

/** Creates the file from the template when it does not exist (an existing file, even an empty one, is left alone). */
export async function ensureMcpFile(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return false;
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, MCP_FILE_TEMPLATE, { encoding: 'utf8', flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') {
        throw e;
      }
    });
    return true;
  }
}

/** "Edit MCP Configuration…": picks a server file (created from a template if missing) or the setting in settings.json. */
export async function editMcpConfiguration(kind?: McpConfigTarget['kind']): Promise<void> {
  const targets = mcpConfigTargets((vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath })));
  const pick = kind && targets.filter((t) => t.kind === kind).length === 1
    ? targets.find((t) => t.kind === kind)
    : await vscode.window.showQuickPick(
        targets.map((t) => ({ label: t.label, description: t.description, t })),
        { title: 'Edit MCP configuration', placeHolder: 'Which configuration to open (a missing file is created)' }
      ).then((p) => p?.t);
  if (!pick) {
    return;
  }
  if (pick.kind === 'settings') {
    // Opens the user settings.json at the key (added when missing).
    await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'localpilot.mcpServers', edit: true } });
    return;
  }
  await ensureMcpFile(pick.file!);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pick.file!));
  const editor = await vscode.window.showTextDocument(doc);
  // The caret goes inside "mcpServers", where a new server is added.
  const at = doc.getText().indexOf('"mcpServers"');
  if (at >= 0) {
    const brace = doc.getText().indexOf('{', at);
    const pos = doc.positionAt(brace >= 0 ? brace + 1 : at);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
