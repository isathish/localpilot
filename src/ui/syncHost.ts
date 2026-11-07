// The VS Code side of SYNC (design §14, §16): starts the engine on an open continuity, the set-up / join / change
// passphrase / rotate key / turn off / start over flows (passphrases and storage secrets only ever go through VS Code
// input boxes into SecretStorage), the Sync manager page and its actions, conflict resolution (text conflicts open VS
// Code's diff editor on `localpilot-version:` documents), the status pushed to the chat (navigator dot) and Settings,
// and the `localpilot.sync.*` commands.
import * as vscode from 'vscode';
import { getConfig } from '../config';
import type { Continuity } from '../continuity/continuity';
import { WrongPassphraseError } from '../continuity/data/crypto/keyring';
import { BackendError, BackendKind } from '../continuity/sync/backends/backend';
import { SECRET_NAMES } from '../continuity/sync/backends/create';
import { ConflictRow, Resolution } from '../continuity/sync/conflicts';
import { platformLabel } from '../continuity/sync/devices';
import { CATEGORY_LABELS, SYNC_CATEGORIES, SyncCategory } from '../continuity/sync/merge';
import { backendConfig, SyncEngine, SyncStatus } from '../continuity/sync/syncEngine';
import { FAVORITES_KEY } from '../continuity/sync/extras';
import type { ContinuityHandle } from './continuityData';

export type SyncActionName = 'now' | 'pause' | 'resume' | 'setup' | 'settings' | 'renameDevice' | 'removeDevice' | 'rotateKey' | 'unlock' | 'reupload' | 'changePassphrase' | 'turnOff' | 'startOver' | 'showConflict' | 'test' | 'setSecret' | 'pickFolder' | 'setCategory' | 'reinstate';

export type SyncFromWebview =
  | { type: 'syncAction'; action: SyncActionName; deviceId?: string; name?: string; id?: string; category?: SyncCategory; on?: boolean }
  | { type: 'resolveConflict'; id: string; resolution: Resolution };

export type SyncToWebview = { type: 'syncStatus' } & SyncStatusView;

/** What the chat (navigator dot) and Settings show about sync. */
export interface SyncStatusView {
  state: SyncStatus['state'] | 'unavailable';
  pending: number;
  pendingBlobs: number;
  conflicts: number;
  lastSync?: number;
  reason?: string;
  message?: string;
  needsPassphrase?: boolean;
  configured: boolean;
  enabled: boolean;
  backend: BackendKind;
  label?: string;
  elsewhere?: boolean;
}

const BACKEND_LABEL: Record<BackendKind, string> = { folder: 'Folder', git: 'Git repository', s3: 'S3-compatible storage', webdav: 'WebDAV' };

/** A rough passphrase strength for the hint under the input box. */
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3; label: string } {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/, /\s/].filter((r) => r.test(p)).length;
  const words = p.trim().split(/\s+/).filter(Boolean).length;
  const bits = p.length * Math.log2(Math.max(10, classes * 18)) * (new Set(p).size / Math.max(1, p.length) > 0.4 ? 1 : 0.6);
  if (p.length < 8) {
    return { score: 0, label: 'too short' };
  }
  if (bits >= 90 || (words >= 5 && p.length >= 25)) {
    return { score: 3, label: 'strong' };
  }
  if (bits >= 60 || (words >= 4 && p.length >= 18)) {
    return { score: 2, label: 'good' };
  }
  return { score: 1, label: 'weak — a few unrelated words make a stronger one' };
}

export interface SyncHostDeps {
  context: vscode.ExtensionContext;
  handle: ContinuityHandle;
  log: vscode.LogOutputChannel;
  /** Sends a message to the chat webview(s). */
  publish(m: unknown): void;
  /** Settings → Continuity & sync refresh (status, devices). */
  onChanged?(): void;
}

export class SyncHost implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private engineSubs: { dispose(): void }[] = [];
  private wired?: SyncEngine;
  /** Conflict sides by URI (the diff editor's documents). */
  private readonly docs = new Map<string, string>();
  private readonly docEmitter = new vscode.EventEmitter<vscode.Uri>();

  constructor(private readonly d: SyncHostDeps) {
    void d.handle.opened.then((c) => this.attach(c));
    this.subs.push(
      vscode.window.onDidChangeWindowState((s) => (s.focused ? this.engine?.scheduler.focused() : undefined)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localpilot.sync')) {
          this.engine?.resetBackend();
          const s = getConfig().sync;
          if (s.enabled && this.engine?.configured) {
            this.engine.start(2_000);
          }
          this.push();
        }
      }),
      this.docEmitter
    );
  }

  /** The two sides of a text conflict for VS Code's diff editor (registered by registerSyncCommands). */
  readonly versions: vscode.TextDocumentContentProvider = { onDidChange: this.docEmitter.event, provideTextDocumentContent: (uri) => this.docs.get(uri.toString()) ?? '' };

  get engine(): SyncEngine | undefined {
    const c = this.d.handle.current;
    return c && !c.degraded ? c.sync : undefined;
  }

  private attach(c: Continuity | undefined): void {
    if (!c || c.degraded) {
      this.push();
      return;
    }
    const engine = c.attachSync({
      settings: () => getConfig().sync,
      warn: (m) => this.d.log.warn(m),
      info: (m) => this.d.log.info(m),
      // Preferences: the user-level values of the allow-listed settings, and the starred models (globalState).
      preferences: {
        read: (key) => (key === FAVORITES_KEY ? this.d.context.globalState.get<unknown>(FAVORITES_KEY) : vscode.workspace.getConfiguration('localpilot').inspect(key)?.globalValue),
        write: async (key, value) => {
          if (key === FAVORITES_KEY) {
            await this.d.context.globalState.update(FAVORITES_KEY, value);
          } else {
            await vscode.workspace.getConfiguration('localpilot').update(key, value, vscode.ConfigurationTarget.Global);
          }
        },
      },
    });
    if (!engine || this.wired === engine) {
      return;
    }
    this.wired = engine;
    this.engineSubs.push(
      engine.onStatus(() => this.push()),
      engine.onPulled(({ events, devices }) => this.d.log.info(`sync: ${events} change(s) from ${devices.length} device(s)`))
    );
    this.push();
  }

  /** This device's name as other devices see it (the setting, else the name continuity chose). */
  deviceName(): string {
    const c = this.d.handle.current;
    return getConfig().sync.deviceName || (c && !c.degraded ? c.device.name : '');
  }

  /** Status for the chat and Settings. */
  view(): SyncStatusView {
    const s = getConfig().sync;
    const e = this.engine;
    if (!e) {
      return { state: 'unavailable', pending: 0, pendingBlobs: 0, conflicts: 0, configured: false, enabled: s.enabled, backend: s.backend, reason: this.d.handle.current?.degraded ?? 'starting' };
    }
    const st = e.status();
    return { ...st, enabled: s.enabled, backend: s.backend, label: labelOf(s.backend, backendConfig(s)) };
  }

  push(): void {
    this.d.publish({ type: 'syncStatus', ...this.view() });
    this.d.onChanged?.();
  }

  dispose(): void {
    this.subs.forEach((x) => x.dispose());
    this.engineSubs.forEach((x) => x.dispose());
  }

  private need(): SyncEngine | undefined {
    const e = this.engine;
    if (!e) {
      void vscode.window.showWarningMessage(this.d.handle.current?.degraded ? `Sync needs conversation storage, which is off: ${this.d.handle.current.degraded}` : 'Conversation storage is still starting — try again in a moment.');
    }
    return e;
  }

  // ---------------------------------------------------------------------------------------------- passphrases

  private async askPassphrase(title: string, prompt: string): Promise<string | undefined> {
    return vscode.window.showInputBox({ title, prompt, password: true, ignoreFocusOut: true, validateInput: (v) => (v ? undefined : 'Enter the passphrase') });
  }

  private async askNewPassphrase(title: string): Promise<string | undefined> {
    const first = await vscode.window.showInputBox({
      title,
      prompt: 'It encrypts everything sync stores. Every device needs it once; it cannot be recovered. A few unrelated words make a good one.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => {
        const s = passphraseStrength(v);
        return s.score === 0 ? 'Use at least 8 characters' : { message: `Strength: ${s.label}`, severity: s.score >= 2 ? vscode.InputBoxValidationSeverity.Info : vscode.InputBoxValidationSeverity.Warning };
      },
    });
    if (!first) {
      return undefined;
    }
    const again = await vscode.window.showInputBox({ title: `${title} (again)`, password: true, ignoreFocusOut: true, validateInput: (v) => (v !== first ? 'The two passphrases differ' : undefined) });
    return again === first ? first : undefined;
  }

  // ---------------------------------------------------------------------------------------------- flows

  /** Set up (empty storage) or join (storage with LocalPilot data). */
  async setup(): Promise<boolean> {
    const e = this.need();
    if (!e) {
      return false;
    }
    const s = getConfig().sync;
    const cfg = backendConfig(s);
    const missing = missingFields(cfg);
    if (missing) {
      const pick = await vscode.window.showInformationMessage(`To set up sync, ${missing}.`, 'Open Settings');
      if (pick) {
        await vscode.commands.executeCommand('localpilot.openSettings', 'continuity', { key: 'sync.backend' });
      }
      return false;
    }
    if (s.backend === 's3' && !(await this.d.context.secrets.get(SECRET_NAMES.s3Secret))) {
      if (!(await this.setSecret('s3'))) {
        return false;
      }
    }
    if (s.backend === 'webdav' && !(await this.d.context.secrets.get(SECRET_NAMES.webdavPassword)) && !(await this.d.context.secrets.get(SECRET_NAMES.webdavToken))) {
      if (!(await this.setSecret('webdav'))) {
        return false;
      }
    }
    const probe = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${labelOf(s.backend, cfg)}…` }, () => e.inspect());
    if (!probe.ok) {
      const pick = await vscode.window.showErrorMessage(`Cannot use this storage: ${probe.message}`, probe.reason === 'auth' && (s.backend === 's3' || s.backend === 'webdav') ? 'Update credentials…' : 'Open Settings');
      if (pick === 'Update credentials…') {
        await this.setSecret(s.backend as 's3' | 'webdav');
      } else if (pick) {
        await vscode.commands.executeCommand('localpilot.openSettings', 'continuity', { key: 'sync.backend' });
      }
      return false;
    }
    try {
      if (probe.initialised) {
        for (;;) {
          const pass = await this.askPassphrase('Join sync', `${probe.label ?? 'This storage'} already holds LocalPilot data. Enter the sync passphrase you chose on your other device.`);
          if (!pass) {
            return false;
          }
          try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Unlocking…' }, () => e.join(pass));
            break;
          } catch (err) {
            if (err instanceof WrongPassphraseError) {
              const again = await vscode.window.showErrorMessage(`This passphrase does not unlock ${probe.label ?? 'this storage'}. Nothing was changed.`, 'Try again');
              if (again) {
                continue;
              }
              return false;
            }
            throw err;
          }
        }
      } else {
        const pass = await this.askNewPassphrase('Create a sync passphrase');
        if (!pass) {
          return false;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Setting up sync…' }, () => e.create(pass));
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Sync was not set up: ${errText(err)}`);
      return false;
    }
    await vscode.workspace.getConfiguration('localpilot').update('sync.enabled', true, vscode.ConfigurationTarget.Global);
    e.start(500);
    void e.syncNow().then(() => this.push());
    void vscode.window.showInformationMessage(probe.initialised ? 'Sync is on: this device is pulling your history now.' : 'Sync is on. On your other devices, choose the same storage and enter the same passphrase.');
    this.push();
    return true;
  }

  async unlock(): Promise<void> {
    const e = this.need();
    if (!e) {
      return;
    }
    const pass = await this.askPassphrase('Sync passphrase', 'The sync key was changed on another device (or sync was started over). Enter the current sync passphrase.');
    if (!pass) {
      return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Unlocking…' }, () => e.unlock(pass));
      void e.syncNow();
      void vscode.window.showInformationMessage('Sync continues.');
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof WrongPassphraseError ? 'This passphrase does not unlock the sync data. Nothing was changed.' : `Could not unlock: ${errText(err)}`);
    }
    this.push();
  }

  async changePassphrase(): Promise<void> {
    const e = this.need();
    if (!e || !this.configuredOrSay(e)) {
      return;
    }
    const old = await this.askPassphrase('Change sync passphrase', 'Enter the current sync passphrase.');
    if (!old) {
      return;
    }
    const next = await this.askNewPassphrase('New sync passphrase');
    if (!next) {
      return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Changing the passphrase…' }, () => e.changePassphrase(old, next));
      void vscode.window.showInformationMessage('Passphrase changed. Devices already syncing keep working; new devices join with the new passphrase.');
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof WrongPassphraseError ? 'The current passphrase is not right. Nothing was changed.' : `Could not change the passphrase: ${errText(err)}`);
    }
  }

  async rotateKey(reason = ''): Promise<boolean> {
    const e = this.need();
    if (!e || !this.configuredOrSay(e)) {
      return false;
    }
    const pass = await this.askPassphrase('Rotate sync key', `${reason}A new key encrypts everything uploaded from now on; earlier data stays readable. Your other devices ask for the passphrase once. Enter the sync passphrase.`);
    if (!pass) {
      return false;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rotating the key…' }, () => e.rotateKey(pass));
      void e.syncNow();
      void vscode.window.showInformationMessage('New sync key in use. Your other devices will ask for the passphrase once.');
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof WrongPassphraseError ? 'The passphrase is not right. Nothing was changed.' : `Could not rotate the key: ${errText(err)}`);
      return false;
    }
  }

  async turnOff(): Promise<void> {
    const e = this.need();
    if (!e) {
      return;
    }
    const pick = await vscode.window.showWarningMessage('Turn off sync on this device?', { modal: true, detail: 'This device stops syncing and forgets its sync key. Everything stays on this device and on the storage; your other devices keep syncing. Turning it on again needs the passphrase.' }, 'Turn Off');
    if (pick !== 'Turn Off') {
      return;
    }
    await e.turnOff();
    await vscode.workspace.getConfiguration('localpilot').update('sync.enabled', false, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('Sync is off on this device.');
    this.push();
  }

  async startOver(): Promise<void> {
    const e = this.need();
    if (!e) {
      return;
    }
    const pick = await vscode.window.showWarningMessage('Start over with a new passphrase?', { modal: true, detail: 'Everything LocalPilot stored on the sync storage — from every device — is deleted and uploaded again from this device, encrypted with a new passphrase. Other devices keep their local data and must join again with the new passphrase. Use this when the passphrase is forgotten.' }, 'Delete and Start Over');
    if (pick !== 'Delete and Start Over') {
      return;
    }
    const pass = await this.askNewPassphrase('New sync passphrase');
    if (!pass) {
      return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting over…' }, () => e.startOver(pass));
      await vscode.workspace.getConfiguration('localpilot').update('sync.enabled', true, vscode.ConfigurationTarget.Global);
      e.start(500);
      void e.syncNow();
      void vscode.window.showInformationMessage('Sync started over from this device. On your other devices, enter the new passphrase.');
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not start over: ${errText(err)}`);
    }
    this.push();
  }

  /** S3 secret key / WebDAV password into SecretStorage. */
  async setSecret(kind: 's3' | 'webdav'): Promise<boolean> {
    const v = await vscode.window.showInputBox({
      title: kind === 's3' ? 'S3 secret access key' : 'WebDAV password',
      prompt: kind === 's3' ? 'Kept in the OS keychain on this device, never in settings.' : 'Your password or an app password (Nextcloud: Settings → Security → App passwords). Kept in the OS keychain.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (x) => (x ? undefined : 'Required'),
    });
    if (!v) {
      return false;
    }
    await this.d.context.secrets.store(kind === 's3' ? SECRET_NAMES.s3Secret : SECRET_NAMES.webdavPassword, v);
    this.engine?.resetBackend();
    if (this.engine?.status().reason === 'auth') {
      this.engine.resume();
    }
    this.push();
    return true;
  }

  async hasSecret(kind: 's3' | 'webdav'): Promise<boolean> {
    return kind === 's3' ? !!(await this.d.context.secrets.get(SECRET_NAMES.s3Secret)) : !!(await this.d.context.secrets.get(SECRET_NAMES.webdavPassword)) || !!(await this.d.context.secrets.get(SECRET_NAMES.webdavToken));
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const e = this.need();
    if (!e) {
      return { ok: false, message: 'Conversation storage is not available' };
    }
    const r = await e.inspect();
    if (!r.ok) {
      return { ok: false, message: r.message };
    }
    return { ok: true, message: r.joined ? 'Connected — this device syncs with it.' : r.initialised ? 'Connected — it holds LocalPilot data: Set up sync joins it with your passphrase.' : 'Connected — empty: Set up sync creates the encrypted remote.' };
  }

  async pickFolder(): Promise<void> {
    const pick = await vscode.window.showOpenDialog({ title: 'Folder to sync through', canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use this folder' });
    const p = pick?.[0]?.fsPath;
    if (p) {
      await vscode.workspace.getConfiguration('localpilot').update('sync.folder.path', p, vscode.ConfigurationTarget.Global);
    }
  }

  async setCategory(cat: SyncCategory, on: boolean): Promise<void> {
    const cur = getConfig().sync.categories;
    await vscode.workspace.getConfiguration('localpilot').update('sync.categories', { ...cur, [cat]: on }, vscode.ConfigurationTarget.Global);
  }

  async renameDevice(name?: string): Promise<void> {
    const e = this.need();
    if (!e) {
      return;
    }
    const cur = (await e.listDevices()).find((x) => x.thisDevice)?.name;
    const n = name ?? (await vscode.window.showInputBox({ title: 'Name of this device', value: cur, prompt: 'Shown in the device list of your other devices.', validateInput: (v) => (v.trim() ? undefined : 'Give it a name') }));
    if (!n?.trim()) {
      return;
    }
    await vscode.workspace.getConfiguration('localpilot').update('sync.deviceName', n.trim(), vscode.ConfigurationTarget.Global);
    if (e.configured) {
      e.devices.rename(n.trim());
    }
    this.push();
  }

  async removeDevice(id: string): Promise<void> {
    const e = this.need();
    if (!e) {
      return;
    }
    const dev = (await e.listDevices()).find((x) => x.id === id);
    const name = dev?.name ?? id;
    const pick = await vscode.window.showWarningMessage(`Remove ${name} from sync?`, { modal: true, detail: `It is no longer listed as an active device; what it synced stays. To keep it from reading anything new, rotate the key too (your other devices ask for the passphrase once). Also revoke its access at your storage provider if it had its own credentials.` }, 'Remove and Rotate Key', 'Remove Only');
    if (!pick) {
      return;
    }
    e.devices.revoke(id);
    if (pick === 'Remove and Rotate Key') {
      await this.rotateKey(`${name} was removed. `);
    }
    void e.syncNow();
    this.push();
  }

  /** Resolves a conflict; text conflicts open the diff editor first unless a resolution is given. */
  async resolve(id: string, resolution?: Resolution): Promise<boolean> {
    const e = this.need();
    if (!e) {
      return false;
    }
    const c = await e.conflicts.get(id);
    if (!c) {
      return false;
    }
    let r = resolution;
    let merged: string | undefined;
    if (c.kind === 'text-merge' && (!r || r === 'merged')) {
      const pick = await this.textConflict(c);
      if (!pick) {
        return false;
      }
      r = pick.resolution;
      merged = pick.merged;
    }
    if (!r) {
      return false;
    }
    const ok = await e.conflicts.resolve(id, r, merged);
    if (ok) {
      void e.syncNow();
    }
    this.push();
    return ok;
  }

  /** Opens both versions side by side and asks which to keep (or to edit a merge). */
  private async textConflict(c: ConflictRow): Promise<{ resolution: Resolution; merged?: string } | undefined> {
    const name = c.label ?? c.entityId;
    const left = vscode.Uri.parse(`localpilot-version:/${encodeURIComponent(c.id)}/${encodeURIComponent(sideLabel(c.ours.device))}.md`);
    const right = vscode.Uri.parse(`localpilot-version:/${encodeURIComponent(c.id)}/${encodeURIComponent(sideLabel(c.theirs.device))}-.md`);
    this.docs.set(left.toString(), String(c.ours.value ?? ''));
    this.docs.set(right.toString(), String(c.theirs.value ?? ''));
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name}: ${sideLabel(c.ours.device)} ↔ ${sideLabel(c.theirs.device)}`, { preview: true });
    const pick = await vscode.window.showQuickPick(
      [
        { label: `Keep ${sideLabel(c.ours.device)}'s`, description: 'left side', r: 'ours' as Resolution },
        { label: `Keep ${sideLabel(c.theirs.device)}'s`, description: 'right side', r: 'theirs' as Resolution },
        { label: 'Keep both', description: 'one after the other', r: 'both' as Resolution },
        { label: 'Edit merged…', description: 'start from both and edit', r: 'merged' as Resolution },
      ],
      { title: `Resolve “${name}”`, ignoreFocusOut: true }
    );
    if (!pick) {
      return undefined;
    }
    if (pick.r !== 'merged') {
      return { resolution: pick.r };
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `${String(c.ours.value ?? '').replace(/\s+$/, '')}\n\n${String(c.theirs.value ?? '').replace(/^\s+/, '')}` });
    await vscode.window.showTextDocument(doc, { preview: false });
    const done = await vscode.window.showInformationMessage(`Edit the merged “${name}”, then keep it.`, 'Use This Text', 'Cancel');
    if (done !== 'Use This Text') {
      return undefined;
    }
    return { resolution: 'merged', merged: doc.getText() };
  }

  /** Handles the chat webview's sync messages (Sync manager page). */
  async handle(msg: SyncFromWebview): Promise<void> {
    if (msg.type === 'resolveConflict') {
      await this.resolve(msg.id, msg.resolution);
      return;
    }
    const e = this.engine;
    switch (msg.action) {
      case 'now':
        if (!e?.configured) {
          await this.setup();
          return;
        }
        await e.syncNow();
        this.push();
        return;
      case 'pause':
        e?.pause();
        this.push();
        return;
      case 'resume':
        e?.resume();
        void e?.syncNow();
        this.push();
        return;
      case 'setup':
        await this.setup();
        return;
      case 'settings':
        await vscode.commands.executeCommand('localpilot.openSettings', 'continuity', { key: 'sync.backend' });
        return;
      case 'renameDevice':
        await this.renameDevice(msg.name);
        return;
      case 'removeDevice':
        if (msg.deviceId) {
          await this.removeDevice(msg.deviceId);
        }
        return;
      case 'reinstate':
        if (msg.deviceId && e) {
          e.devices.reinstate(msg.deviceId);
          this.push();
        }
        return;
      case 'rotateKey':
        await this.rotateKey();
        return;
      case 'unlock':
        await this.unlock();
        return;
      case 'reupload':
        if (e) {
          e.reupload();
          void e.syncNow();
          void vscode.window.showInformationMessage('This device uploads its history again.');
        }
        return;
      case 'changePassphrase':
        await this.changePassphrase();
        return;
      case 'turnOff':
        await this.turnOff();
        return;
      case 'startOver':
        await this.startOver();
        return;
      case 'showConflict':
        if (msg.id) {
          await this.resolve(msg.id);
        }
        return;
      case 'test': {
        const r = await this.test();
        void (r.ok ? vscode.window.showInformationMessage(r.message) : vscode.window.showErrorMessage(r.message));
        return;
      }
      case 'setSecret': {
        const b = getConfig().sync.backend;
        if (b === 's3' || b === 'webdav') {
          await this.setSecret(b);
        }
        return;
      }
      case 'pickFolder':
        await this.pickFolder();
        return;
      case 'setCategory':
        if (msg.category && SYNC_CATEGORIES.includes(msg.category)) {
          await this.setCategory(msg.category, !!msg.on);
        }
        return;
    }
  }

  private configuredOrSay(e: SyncEngine): boolean {
    if (!e.configured) {
      void vscode.window.showInformationMessage('Sync is not set up on this device.', 'Set Up Sync…').then((p) => p && this.setup());
      return false;
    }
    return true;
  }

  /** Sync manager page data. */
  async pageData(): Promise<unknown> {
    const e = this.engine;
    const s = getConfig().sync;
    if (!e) {
      return { off: this.d.handle.current?.degraded ?? 'starting' };
    }
    const status = this.view();
    const devices = e.configured
      ? (await e.listDevices()).map((d) => ({ id: d.id, name: d.name, platform: platformLabel(d.platform), lastSeen: d.lastSeen, revokedAt: d.revokedAt, thisDevice: d.thisDevice, app: Object.entries(d.appVersions ?? {}).map(([k, v]) => `${k === 'vscode' ? 'VS Code' : 'CLI'} ${v}`).join(', ') }))
      : [];
    const conflicts = e.configured ? await e.conflicts.list().catch(() => []) : [];
    const names = new Map(devices.map((d) => [d.id, d.name]));
    const activity = await this.d.handle.current!.index.query<{ at: number; kind: string; uploaded: number | null; downloaded: number | null; bytes: number | null; error: string | null }>('syncEvents', {}).catch(() => []);
    const withheld = Object.fromEntries(Object.entries(e.state.withheld).map(([k, v]) => [k, v?.length ?? 0]));
    return {
      status,
      enabled: s.enabled,
      configured: e.configured,
      backend: s.backend,
      backendLabel: BACKEND_LABEL[s.backend],
      label: status.label,
      interval: s.intervalMinutes,
      device: { id: this.d.handle.current!.device.deviceId, name: s.deviceName || this.d.handle.current!.device.name },
      devices,
      conflicts: conflicts.map((c) => ({ id: c.id, kind: c.kind, entity: c.entity, field: c.field, label: c.label ?? '', ours: preview(c.ours.value), theirs: preview(c.theirs.value), oursDevice: names.get(c.ours.device) ?? sideLabel(c.ours.device), theirsDevice: names.get(c.theirs.device) ?? sideLabel(c.theirs.device), applied: c.applied, createdAt: c.createdAt })),
      activity: activity.slice(0, 20).map((a) => ({ at: a.at, kind: a.kind, up: a.uploaded ?? 0, down: a.downloaded ?? 0, bytes: a.bytes ?? 0, error: a.error ?? undefined })),
      categories: SYNC_CATEGORIES.map((k) => ({ id: k, label: CATEGORY_LABELS[k], on: s.categories[k], withheld: withheld[k] ?? 0 })),
    };
  }
}

const preview = (v: unknown): string => {
  const t = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  return t.length > 600 ? `${t.slice(0, 600)}…` : t;
};

function sideLabel(device: string): string {
  if (!device || device === 'remote') {
    return 'other device';
  }
  return device.startsWith('dev_') ? `device ${device.slice(4, 12)}` : device;
}

function errText(e: unknown): string {
  if (e instanceof BackendError) {
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** What is missing in the settings before a backend can be built ("choose a folder"). */
export function missingFields(cfg: ReturnType<typeof backendConfig>): string | undefined {
  switch (cfg.kind) {
    case 'folder':
      return cfg.folder?.path ? undefined : 'choose the folder to sync through';
    case 'git':
      return cfg.git?.url ? undefined : 'enter the URL of a dedicated Git repository';
    case 's3':
      return cfg.s3?.endpoint && cfg.s3.bucket && cfg.s3.accessKeyId ? undefined : 'enter the S3 endpoint, bucket and access key ID';
    case 'webdav':
      return cfg.webdav?.url ? undefined : 'enter the WebDAV URL';
  }
}

export function labelOf(kind: BackendKind, cfg: ReturnType<typeof backendConfig>): string {
  switch (kind) {
    case 'folder':
      return cfg.folder?.path || 'a folder';
    case 'git':
      return (cfg.git?.url || 'a Git repository').replace(/\/\/[^@/]+@/, '//***@');
    case 's3':
      return cfg.s3?.bucket ? `s3://${cfg.s3.bucket}${cfg.s3.prefix ? `/${cfg.s3.prefix}` : ''}` : 'S3 storage';
    case 'webdav':
      return cfg.webdav?.url || 'WebDAV';
  }
}

/** `localpilot.sync.*` commands. */
export function registerSyncCommands(context: vscode.ExtensionContext, host: SyncHost, openManager: (params?: Record<string, unknown>) => Promise<void>): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('localpilot-version', host.versions),
    vscode.commands.registerCommand('localpilot.sync.setup', async () => {
      const s = getConfig().sync;
      if (missingFields(backendConfig(s))) {
        await vscode.commands.executeCommand('localpilot.openSettings', 'continuity', { key: 'sync.backend' });
        return;
      }
      await host.setup();
    }),
    vscode.commands.registerCommand('localpilot.sync.now', async () => {
      const e = host.engine;
      if (!e?.configured) {
        await host.setup();
        return;
      }
      const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Syncing…' }, () => e.syncNow());
      const st = e.status();
      if (!ok || st.state === 'error' || st.state === 'offline' || st.state === 'paused') {
        void vscode.window.showWarningMessage(`Sync: ${st.message ?? st.state}`);
      }
    }),
    vscode.commands.registerCommand('localpilot.sync.openManager', () => openManager()),
    vscode.commands.registerCommand('localpilot.sync.showConflicts', () => openManager({ view: 'conflicts' })),
    vscode.commands.registerCommand('localpilot.sync.changePassphrase', () => host.changePassphrase()),
    vscode.commands.registerCommand('localpilot.sync.rotateKey', () => host.rotateKey()),
    vscode.commands.registerCommand('localpilot.sync.turnOff', () => host.turnOff())
  );
}
