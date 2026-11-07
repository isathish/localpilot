// VS Code side of the continuity DATA layer: opens Continuity after the chats loaded (never blocking activation), the
// data commands (Rebuild index, Back up now, Restore from backup, Open data folder) and what Settings → Continuity &
// sync shows and does.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { Continuity, continuityDataDir } from '../continuity/continuity';
import { isEncryptedBackup, WrongBackupPassphraseError } from '../continuity/data/backup';
import { secretStorageBox } from '../continuity/data/crypto/secretBox';
import type { DataStats } from '../continuity/data/dataManager';
import { cliDataDir } from '../sessions/cliStorage';

export interface ContinuityHandle {
  /** Settles once Continuity is open (degraded or not); undefined only when opening was skipped. */
  readonly opened: Promise<Continuity | undefined>;
  current?: Continuity;
}

export type ContinuityAction = 'rebuildIndex' | 'openFolder' | 'retryMigration' | 'removeMigrationBackup' | 'emptyTrash' | 'backupNow' | 'restoreBackup';

/** What Settings → Continuity & sync shows. */
export interface ContinuityView {
  state: 'opening' | 'ready' | 'degraded';
  reason?: string;
  stats?: DataStats;
  indexState?: string;
  migrationProgress?: { state: string; done: number; total: number; failed: number };
  busy?: ContinuityAction;
}

/**
 * Opens continuity once `loaded` settled (the SessionStore read its chats). The data root is the setting, else
 * LOCALPILOT_CONTINUITY_DIR, else ~/.localpilot/continuity; extension tests without either get a throwaway folder.
 */
export function openContinuity(context: vscode.ExtensionContext, log: vscode.LogOutputChannel, loaded: Promise<unknown>): ContinuityHandle {
  const handle: ContinuityHandle = { opened: Promise.resolve(undefined) };
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const setting = getConfig().continuity.dataDir;
  const dataDir = testMode && !setting && !process.env.LOCALPILOT_CONTINUITY_DIR ? fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-continuity-')) : continuityDataDir(setting);
  // Tests never import the developer's real CLI chats, memory or commands unless they point LOCALPILOT_DATA_DIR somewhere.
  const withCli = !testMode || !!process.env.LOCALPILOT_DATA_DIR;
  const dist = path.join(context.extensionPath, 'dist');
  (handle as { opened: Promise<Continuity | undefined> }).opened = loaded
    .catch(() => undefined)
    .then(() =>
      Continuity.open({
        dataDir,
        writer: 'vscode',
        appVersion: String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0'),
        secrets: secretStorageBox(context.secrets),
        log,
        settings: () => getConfig().continuity,
        wasmPath: process.env.LOCALPILOT_SQLJS_WASM || path.join(dist, 'sqljs', 'sql-wasm.wasm'),
        workerPath: path.join(dist, 'continuityWorker.js'),
        migration: {
          vscodeStorage: context.storageUri?.scheme === 'file' ? context.storageUri.fsPath : undefined,
          workspaceFolders: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
          vscodeGlobalStorage: context.globalStorageUri.scheme === 'file' ? context.globalStorageUri.fsPath : undefined,
          extensionId: context.extension.id,
          ...(withCli ? { cliDataDir: cliDataDir(), home: path.join(os.homedir(), '.localpilot') } : {}),
        },
      })
    )
    .then((c) => {
      handle.current = c;
      log.info(c.degraded ? `continuity: off (${c.degraded})` : `continuity: data in ${c.dataDir} (opened in ${c.openMs.toFixed(1)} ms on the extension host)`);
      return c;
    });
  return handle;
}

const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function askNewPassphrase(): Promise<string | undefined> {
  const first = await vscode.window.showInputBox({ title: 'Backup passphrase', prompt: 'Anyone with the backup file and this passphrase can read it. It cannot be recovered.', password: true, ignoreFocusOut: true, validateInput: (v) => (v.length < 8 ? 'Use at least 8 characters' : undefined) });
  if (!first) {
    return undefined;
  }
  const again = await vscode.window.showInputBox({ title: 'Backup passphrase (again)', password: true, ignoreFocusOut: true, validateInput: (v) => (v !== first ? 'The two passphrases differ' : undefined) });
  return again === first ? first : undefined;
}

/** Runs one data action with progress and a result message; returns the message (Settings shows it as a toast). */
export async function runContinuityAction(c: Continuity | undefined, action: ContinuityAction, log: vscode.LogOutputChannel): Promise<string | undefined> {
  if (!c || c.degraded) {
    const why = c?.degraded ?? 'still starting';
    void vscode.window.showWarningMessage(`Conversation storage is not available: ${why}.`);
    return undefined;
  }
  switch (action) {
    case 'openFolder':
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(c.dataDir, 'device.json')));
      return undefined;
    case 'rebuildIndex': {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rebuilding the conversation index…' }, () => c.data.rebuildIndex());
      const st = await c.index.status();
      const msg = `Conversation index rebuilt: ${st.events.toLocaleString()} events, ${fmtBytes(st.bytes)}.`;
      void vscode.window.showInformationMessage(msg);
      return msg;
    }
    case 'retryMigration': {
      const s = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Importing chats and memory from LocalPilot 1.6…' }, () => c.data.retryMigration());
      const msg = s.failed.length ? `${s.failed.length} file(s) still cannot be read. See the LocalPilot log for details.` : 'Every file was imported.';
      void (s.failed.length ? vscode.window.showWarningMessage(msg) : vscode.window.showInformationMessage(msg));
      return msg;
    }
    case 'removeMigrationBackup': {
      const st = c.data.migrationStatus();
      const pick = await vscode.window.showWarningMessage(`Remove the copies of your LocalPilot 1.6 files (${fmtBytes(st.backupBytes)})?`, { modal: true, detail: 'Your conversations and memory are already imported and stay. Only the safety copies taken before the import are deleted.' }, 'Remove');
      if (pick !== 'Remove') {
        return undefined;
      }
      const bytes = c.data.removeMigrationBackup();
      const msg = `Removed the migration backup (${fmtBytes(bytes)}).`;
      void vscode.window.showInformationMessage(msg);
      return msg;
    }
    case 'emptyTrash': {
      const counts = await c.index.counts().catch(() => undefined);
      const pick = await vscode.window.showWarningMessage(`Delete ${counts?.trash ?? 'all'} conversation(s) and every other item in Trash permanently?`, { modal: true, detail: 'This cannot be undone. Backups made before now still contain them.' }, 'Empty Trash');
      if (pick !== 'Empty Trash') {
        return undefined;
      }
      const n = await c.data.emptyTrash();
      const msg = n ? `Deleted ${n} item(s) permanently.` : 'Trash is already empty.';
      void vscode.window.showInformationMessage(msg);
      return msg;
    }
    case 'backupNow': {
      const how = await vscode.window.showQuickPick(
        [
          { label: 'Back up', description: 'not encrypted', value: 'plain' as const },
          { label: 'Back up with a passphrase…', description: 'AES-256-GCM, key from your passphrase', value: 'sealed' as const },
        ],
        { title: 'Back up conversations, memory and attachments' }
      );
      if (!how) {
        return undefined;
      }
      const passphrase = how.value === 'sealed' ? await askNewPassphrase() : undefined;
      if (how.value === 'sealed' && !passphrase) {
        return undefined;
      }
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Backing up…' }, () => c.data.backup({ passphrase }));
      const msg = `Backup written: ${path.basename(r.file)} (${fmtBytes(r.bytes)}, ${r.events.toLocaleString()} events${r.encrypted ? ', encrypted' : ''}).`;
      void vscode.window.showInformationMessage(msg, 'Show in folder').then((p) => p && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.file)));
      return msg;
    }
    case 'restoreBackup': {
      const pick = await vscode.window.showOpenDialog({ title: 'Restore from a LocalPilot backup', canSelectMany: false, defaultUri: vscode.Uri.file(c.data.backupsDir), filters: { 'LocalPilot backup': ['lpbackup'] } });
      const file = pick?.[0]?.fsPath;
      if (!file) {
        return undefined;
      }
      let passphrase: string | undefined;
      if (isEncryptedBackup(file)) {
        passphrase = await vscode.window.showInputBox({ title: 'Backup passphrase', prompt: `${path.basename(file)} is encrypted.`, password: true, ignoreFocusOut: true });
        if (!passphrase) {
          return undefined;
        }
      }
      try {
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restoring…' }, () => c.data.restore(file, passphrase));
        const msg = r.imported ? `Restored ${r.imported.toLocaleString()} change(s) from ${r.streams} log(s)${r.blobs ? ` and ${r.blobs} attachment(s)` : ''}. Nothing newer was removed.` : 'Everything in this backup is already here.';
        if (r.refused.length) {
          log.warn(`continuity restore: ${r.refused.map((x) => `${x.stream}: ${x.reason}`).join('; ')}`);
        }
        void vscode.window.showInformationMessage(msg);
        return msg;
      } catch (e) {
        const msg = e instanceof WrongBackupPassphraseError ? 'That passphrase does not open this backup.' : `Could not restore: ${e instanceof Error ? e.message : String(e)}`;
        void vscode.window.showErrorMessage(msg);
        return msg;
      }
    }
  }
}

export function registerContinuityCommands(context: vscode.ExtensionContext, handle: ContinuityHandle, log: vscode.LogOutputChannel): void {
  const run = (a: ContinuityAction) => async () => runContinuityAction(await handle.opened, a, log);
  context.subscriptions.push(
    vscode.commands.registerCommand('localpilot.continuity.rebuildIndex', run('rebuildIndex')),
    vscode.commands.registerCommand('localpilot.continuity.backupNow', run('backupNow')),
    vscode.commands.registerCommand('localpilot.continuity.restoreBackup', run('restoreBackup')),
    vscode.commands.registerCommand('localpilot.continuity.openDataFolder', run('openFolder')),
    { dispose: () => void handle.current?.dispose() }
  );
}

/** Settings → Continuity & sync data. */
export async function continuityView(handle: ContinuityHandle): Promise<ContinuityView> {
  const c = handle.current;
  if (!c) {
    return { state: 'opening' };
  }
  if (c.degraded) {
    return { state: 'degraded', reason: c.degraded };
  }
  const stats = await c.data.stats();
  const p = c.migration.progress;
  return { state: 'ready', stats, indexState: c.indexFailed ? `failed: ${c.indexFailed}` : stats.index?.state, migrationProgress: { state: p.state, done: p.done, total: p.total, failed: p.failed } };
}
