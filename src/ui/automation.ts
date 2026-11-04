import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Launcher } from '../cli/schedule';
import { findImportable, importInto, readImport, SOURCE_LABEL } from '../sessions/importers';
import { SessionStore } from '../sessions/sessionStore';
import { cliShim } from './cli';

/**
 * How scheduled runs created from VS Code start the CLI: the installed `localpilot` shim (it follows extension
 * updates), else VS Code's own runtime as Node with this extension's dist/cli.js.
 */
export function extensionLauncher(ctx: vscode.ExtensionContext): Launcher {
  const shim = process.platform === 'win32' ? path.join(os.homedir(), 'bin', 'localpilot.cmd') : path.join(os.homedir(), '.local', 'bin', 'localpilot');
  if (fs.existsSync(shim)) {
    return { command: shim, args: [] };
  }
  return { command: process.execPath, args: [vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'cli.js').fsPath], env: { ELECTRON_RUN_AS_NODE: '1', ...cliShim(ctx).env } };
}

/** `localpilot.importSessions`: pick Claude Code and Codex chats of this workspace and add them to the history. */
export function registerSessionImport(ctx: vscode.ExtensionContext, store: SessionStore): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('localpilot.importSessions', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!folder) {
        void vscode.window.showWarningMessage('Open a folder first: chats are imported for the workspace they were held in.');
        return;
      }
      const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Looking for Claude Code and Codex chats…' }, async () => findImportable(folder));
      if (!found.length) {
        void vscode.window.showInformationMessage(`No Claude Code (~/.claude/projects) or Codex (~/.codex/sessions) chats for ${path.basename(folder)}.`);
        return;
      }
      const known = store.list();
      const items = found.map((c) => {
        const done = known.some((s) => s.origin === c.source && s.createdAt === c.createdAt);
        return { label: c.title, description: `${SOURCE_LABEL[c.source]}${done ? ' · already imported' : ''}`, detail: `${new Date(c.updatedAt).toLocaleString()} · ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}`, picked: !done, candidate: c };
      });
      const picks = await vscode.window.showQuickPick(items, { canPickMany: true, matchOnDescription: true, matchOnDetail: true, title: 'Import chats into LocalPilot history', placeHolder: 'Chats from Claude Code and Codex in this folder' });
      if (!picks?.length) {
        return;
      }
      let created = 0;
      const failed: string[] = [];
      for (const p of picks) {
        try {
          created += (await importInto(store, readImport(p.candidate))).created ? 1 : 0;
        } catch (e) {
          failed.push(`${p.label}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const skipped = picks.length - created - failed.length;
      const msg = `Imported ${created} chat${created === 1 ? '' : 's'}${skipped ? ` (${skipped} already in the history)` : ''}.`;
      if (failed.length) {
        void vscode.window.showWarningMessage(`${msg} Could not read ${failed.length}: ${failed.join('; ')}`);
      } else {
        const open = await vscode.window.showInformationMessage(`${msg} They are in the chat's history list.`, 'Open Chat');
        if (open) {
          await vscode.commands.executeCommand('localpilot.openChat');
        }
      }
    })
  );
}
