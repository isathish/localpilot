import * as vscode from 'vscode';
import { installPlugin, InstallResult, Marketplace, MarketplaceEntry, pluginsDir } from '../agent/pluginInstaller';

/**
 * Installs a marketplace plugin for the user (`~/.localpilot/plugins`) or this workspace (`.localpilot/plugins`):
 * asks where when a folder is open and `scope` is not given, shows what the plugin runs on this machine (hooks, MCP
 * servers) and asks before writing anything. Resolves undefined when the user cancelled; throws when it failed.
 */
export async function installMarketplacePlugin(entry: MarketplaceEntry, market: Marketplace, scope?: 'user' | 'project'): Promise<InstallResult | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const where =
    scope ??
    (root
      ? (await vscode.window.showQuickPick([{ label: 'For me', description: '~/.localpilot/plugins — every workspace', id: 'user' as const }, { label: 'For this workspace', description: '.localpilot/plugins — commit it to share with the team', id: 'project' as const }], { title: `Install ${entry.name}` }))?.id
      : 'user');
  if (!where) {
    return undefined;
  }
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${entry.name}…` }, () =>
    installPlugin(entry, market, pluginsDir(where, root), {
      // Hooks and MCP servers run commands on this machine: show them and ask before anything is installed.
      confirm: async (_p, d) => !d.runs.length || (await vscode.window.showWarningMessage(`${d.summary}\n\nThis plugin runs commands on your machine:\n${d.runs.slice(0, 12).join('\n')}`, { modal: true }, 'Install')) === 'Install',
    })
  );
}

