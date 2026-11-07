// `localpilot sync …` (design §17.3): set up or join an end-to-end encrypted sync remote (folder, Git, S3-compatible,
// WebDAV), sync now, pause / resume, devices, conflicts and their resolution, passphrase change, key rotation, device
// removal, turning sync off. Settings go to ~/.localpilot/config.json, storage secrets and data keys to the CLI key file
// (keys.json, 0600). Passphrases: a hidden prompt, or LOCALPILOT_SYNC_PASSPHRASE (and LOCALPILOT_SYNC_NEW_PASSPHRASE
// for `passphrase`) for headless use. Also the interactive `/sync` slash command.
import * as path from 'path';
import * as vscode from 'vscode';
import { createTwoFilesPatch } from 'diff';
import { getConfig } from '../config';
import type { Continuity } from '../continuity/continuity';
import { WrongPassphraseError } from '../continuity/data/crypto/keyring';
import { BackendKind } from '../continuity/sync/backends/backend';
import { SECRET_NAMES } from '../continuity/sync/backends/create';
import { ConflictRow, Resolution } from '../continuity/sync/conflicts';
import { platformLabel } from '../continuity/sync/devices';
import { backendConfig, SyncEngine } from '../continuity/sync/syncEngine';
import { FAVORITES_KEY, PreferenceAccess } from '../continuity/sync/extras';
import { askHidden, openCliContinuity } from './continuityCmd';
import type { Style } from './providers';
import { loadSettings, readCliKeys, writeCliKey } from './vscodeShim';

export const SYNC_USAGE = `localpilot sync setup --backend folder|git|s3|webdav [backend flags] [--device-name n]
    folder:  --folder <path>
    git:     --git-url <url> [--git-branch localpilot-sync]
    s3:      --endpoint <url> --bucket <b> --access-key <id> [--region r] [--prefix p] [--path-style|--virtual-hosted]
             secret key: prompted, or LOCALPILOT_SYNC_SECRET
    webdav:  --url <url> [--username u]   password: prompted, or LOCALPILOT_SYNC_SECRET
localpilot sync status|devices|conflicts [--json]
localpilot sync now | pause | resume
localpilot sync resolve <conflictId> [--keep mine|theirs|both]   (a text conflict without --keep prints the diff)
localpilot sync passphrase | rotate-key | remove-device <deviceId> [--rotate] | off | start-over --yes
Passphrase: prompted, or LOCALPILOT_SYNC_PASSPHRASE (new one for "passphrase": LOCALPILOT_SYNC_NEW_PASSPHRASE).`;

const SUBS = ['setup', 'status', 'now', 'pause', 'resume', 'devices', 'conflicts', 'resolve', 'passphrase', 'rotate-key', 'remove-device', 'off', 'start-over', 'help'];

const ago = (t?: number) => {
  if (!t) {
    return 'never';
  }
  const d = Date.now() - t;
  return d < 60e3 ? 'just now' : d < 3600e3 ? `${Math.floor(d / 60e3)} min ago` : d < 86400e3 ? `${Math.floor(d / 3600e3)} h ago` : `${Math.floor(d / 86400e3)} d ago`;
};

async function newPassphrase(env = 'LOCALPILOT_SYNC_PASSPHRASE'): Promise<string | undefined> {
  if (process.env[env]) {
    return process.env[env];
  }
  const a = await askHidden('New sync passphrase (it cannot be recovered): ');
  if (!a) {
    return undefined;
  }
  const b = await askHidden('Again: ');
  if (a !== b) {
    throw new Error('the two passphrases differ');
  }
  return a;
}

async function passphrase(prompt = 'Sync passphrase: '): Promise<string | undefined> {
  return process.env.LOCALPILOT_SYNC_PASSPHRASE || (await askHidden(prompt));
}

async function update(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('localpilot').update(key, value, vscode.ConfigurationTarget.Global);
}

/** Preferences sync in the CLI: the allow-listed settings of ~/.localpilot/config.json (favorites live in VS Code only). */
export function cliPreferences(): PreferenceAccess {
  return {
    read: (key) => (key === FAVORITES_KEY ? undefined : vscode.workspace.getConfiguration('localpilot').inspect(key)?.globalValue),
    write: async (key, value) => (key === FAVORITES_KEY ? undefined : update(key, value)),
  };
}

/** Opens continuity with the sync engine attached (no timers: one-shot commands). */
async function open(o: { cwd: string; dataDir?: string; version?: string }): Promise<{ c: Continuity; e: SyncEngine } | { error: string }> {
  const warnings: string[] = [];
  const c = await openCliContinuity({ cwd: o.cwd, dataDir: o.dataDir, log: { info: () => undefined, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) }, schedules: false, autoMigrate: false, version: o.version });
  if (c.degraded) {
    await c.dispose();
    return { error: `conversation storage is not available: ${c.degraded}` };
  }
  await c.ready;
  if (c.indexFailed) {
    await c.dispose();
    return { error: `the search index is not available: ${c.indexFailed}` };
  }
  const e = c.attachSync({ settings: () => getConfig().sync, start: false, passphraseHint: () => process.env.LOCALPILOT_SYNC_PASSPHRASE, preferences: cliPreferences() })!;
  return { c, e };
}

function mineSide(c: ConflictRow, me: string, keep: 'mine' | 'theirs' | 'both'): Resolution {
  if (keep === 'both') {
    return 'both';
  }
  const oursIsMine = c.ours.device === me || c.theirs.device !== me;
  return (keep === 'mine') === oursIsMine ? 'ours' : 'theirs';
}

/** Runs `localpilot sync <sub> …`; returns the exit code. */
export async function cmdSync(argv: string[], st: Style, o: { cwd: string; version?: string }): Promise<number> {
  // Runs before the CLI's normal start-up: read ~/.localpilot/config.json (and VS Code's user settings) now.
  loadSettings(o.cwd);
  const args = [...argv];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i >= 0) {
      args.splice(i, 1);
      return true;
    }
    return false;
  };
  const value = (...names: string[]) => {
    for (const n of names) {
      const i = args.indexOf(n);
      if (i >= 0 && args[i + 1] !== undefined) {
        const v = args[i + 1];
        args.splice(i, 2);
        return v;
      }
    }
    return undefined;
  };
  const dd = value('--data-dir');
  const dataDir = dd ? path.resolve(dd) : undefined;
  const json = flag('--json');
  const sub = args.shift() ?? 'status';
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(SYNC_USAGE);
    return 0;
  }
  if (!SUBS.includes(sub)) {
    console.error(`${st.red('✖')} unknown sync command "${sub}"\n${SYNC_USAGE}`);
    return 2;
  }
  // ---- setup: settings first (so the backend can be built), then create or join
  if (sub === 'setup') {
    const backend = (value('--backend') ?? getConfig().sync.backend) as BackendKind;
    if (!['folder', 'git', 's3', 'webdav'].includes(backend)) {
      console.error(`${st.red('✖')} --backend must be folder, git, s3 or webdav`);
      return 2;
    }
    await update('sync.backend', backend);
    const set = async (k: string, v: string | undefined, resolvePath = false) => (v !== undefined ? update(k, resolvePath ? path.resolve(o.cwd, v) : v) : undefined);
    await set('sync.folder.path', value('--folder', '--path'), true);
    await set('sync.git.url', value('--git-url'));
    await set('sync.git.branch', value('--git-branch'));
    await set('sync.s3.endpoint', value('--endpoint'));
    await set('sync.s3.region', value('--region'));
    await set('sync.s3.bucket', value('--bucket'));
    await set('sync.s3.prefix', value('--prefix'));
    await set('sync.s3.accessKeyId', value('--access-key'));
    await set('sync.webdav.url', value('--url'));
    await set('sync.webdav.username', value('--username'));
    await set('sync.deviceName', value('--device-name'));
    if (flag('--path-style')) {
      await update('sync.s3.pathStyle', true);
    } else if (flag('--virtual-hosted')) {
      await update('sync.s3.pathStyle', false);
    }
    if (backend === 's3' || backend === 'webdav') {
      const name = backend === 's3' ? SECRET_NAMES.s3Secret : SECRET_NAMES.webdavPassword;
      const have = readCliKeys()[name];
      const secret = process.env.LOCALPILOT_SYNC_SECRET || (have ? undefined : await askHidden(backend === 's3' ? 'S3 secret access key: ' : 'WebDAV password: '));
      if (secret) {
        await writeCliKey(name, secret);
      } else if (!have) {
        console.error(`${st.red('✖')} the ${backend === 's3' ? 'secret access key' : 'password'} is needed: run in a terminal or set LOCALPILOT_SYNC_SECRET`);
        return 2;
      }
    }
  }
  const opened = await open({ cwd: o.cwd, dataDir, version: o.version });
  if ('error' in opened) {
    console.error(`${st.red('✖')} ${opened.error}`);
    return 1;
  }
  const { c, e } = opened;
  try {
    switch (sub) {
      case 'setup': {
        const probe = await e.inspect();
        if (!probe.ok) {
          console.error(`${st.red('✖')} cannot use ${probe.label ?? 'this storage'}: ${probe.message}`);
          return 1;
        }
        try {
          if (probe.initialised) {
            const pass = await passphrase(`${probe.label} holds LocalPilot data. Sync passphrase: `);
            if (!pass) {
              console.error(`${st.red('✖')} the sync passphrase is needed: run in a terminal or set LOCALPILOT_SYNC_PASSPHRASE`);
              return 2;
            }
            await e.join(pass);
          } else {
            const pass = await newPassphrase();
            if (!pass) {
              console.error(`${st.red('✖')} a new sync passphrase is needed: run in a terminal or set LOCALPILOT_SYNC_PASSPHRASE`);
              return 2;
            }
            await e.create(pass);
          }
        } catch (err) {
          console.error(`${st.red('✖')} ${err instanceof WrongPassphraseError ? `this passphrase does not unlock ${probe.label}; nothing was changed` : err instanceof Error ? err.message : String(err)}`);
          return 1;
        }
        await update('sync.enabled', true);
        const ok = await e.cycle('now');
        const s = e.status();
        console.log(`${st.green('✔')} sync ${probe.initialised ? 'joined' : 'set up'}: ${probe.label} (end-to-end encrypted)`);
        console.log(`  ${ok && s.state !== 'error' ? `sent ${s.pending ? 'part of ' : ''}this device's history${e.state.last ? ` (${e.state.last.uploaded} up, ${e.state.last.downloaded} down)` : ''}` : `${st.amber('!')} first sync: ${s.message ?? s.state}`}`);
        if (!probe.initialised) {
          console.log(`  ${st.dim('On your other devices: same storage, same passphrase (localpilot sync setup … or VS Code: Set Up Sync…).')}`);
        }
        return 0;
      }
      case 'status': {
        const s = e.status();
        const cfg = getConfig().sync;
        if (json) {
          console.log(JSON.stringify({ ...s, enabled: cfg.enabled, remoteId: e.remoteId, device: c.device.deviceId }, null, 2));
          return 0;
        }
        const rows: [string, string][] = [
          ['State', `${s.state}${s.reason && s.state !== 'idle' ? ` (${s.reason})` : ''}${s.message ? ` — ${s.message}` : ''}`],
          ['Storage', `${cfg.backend}: ${JSON.stringify(backendConfig(cfg)[cfg.backend] ?? {})}`],
          ['Last sync', ago(s.lastSync)],
          ['Waiting', `${s.pending} change(s), ${s.pendingBlobs} attachment(s)`],
          ['Conflicts', String(s.conflicts || (await e.conflicts.count()))],
          ['This device', `${cfg.deviceName || c.device.name} (${c.device.deviceId})`],
        ];
        for (const [k, v] of rows) {
          console.log(`  ${st.dim(k.padEnd(12))} ${v}`);
        }
        if (!e.configured) {
          console.log(`  ${st.dim('Set it up: localpilot sync setup --backend folder --folder ~/Dropbox/LocalPilot')}`);
        }
        return 0;
      }
      case 'now': {
        if (!e.configured || !getConfig().sync.enabled) {
          console.error(`${st.red('✖')} sync is not set up on this device: localpilot sync setup …`);
          return 1;
        }
        await e.cycle('now');
        const s = e.status();
        if (s.state === 'error' || s.state === 'offline' || (s.state === 'paused' && s.reason !== 'user')) {
          console.error(`${st.red('✖')} ${s.message ?? s.state}`);
          return 1;
        }
        const l = e.state.last;
        console.log(`${st.green('✔')} synced: sent ${l?.uploaded ?? 0}, received ${l?.downloaded ?? 0} change(s)${s.conflicts ? ` · ${st.amber(`${s.conflicts} conflict(s)`)}: localpilot sync conflicts` : ''}`);
        return 0;
      }
      case 'pause':
        e.pause();
        console.log(`${st.green('✔')} sync paused on this device (localpilot sync resume to continue)`);
        return 0;
      case 'resume':
        e.resume();
        console.log(`${st.green('✔')} sync resumed`);
        return 0;
      case 'devices': {
        const devs = await e.listDevices();
        if (json) {
          console.log(JSON.stringify(devs, null, 2));
          return 0;
        }
        for (const d of devs) {
          console.log(`  ${d.thisDevice ? st.green('●') : d.revokedAt ? st.red('○') : '○'} ${st.bold(d.name)} ${st.dim(d.id)}  ${platformLabel(d.platform)}  ${d.thisDevice ? 'this device' : d.revokedAt ? st.red('removed') : `last seen ${ago(d.lastSeen)}`}`);
        }
        return 0;
      }
      case 'conflicts': {
        const list = await e.conflicts.list();
        if (json) {
          console.log(JSON.stringify(list, null, 2));
          return 0;
        }
        if (!list.length) {
          console.log(`  ${st.dim('no conflicts')}`);
          return 0;
        }
        for (const x of list) {
          const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).replace(/\s+/g, ' ').slice(0, 60);
          console.log(`  ${st.amber(x.kind.padEnd(14))} ${x.id}  ${x.label ?? x.entityId}${x.field && x.kind === 'field' ? `.${x.field}` : ''}`);
          if (x.kind === 'field' || x.kind === 'text-merge') {
            console.log(`      ${st.dim(x.ours.device.slice(0, 16).padEnd(16))} ${show(x.ours.value)}\n      ${st.dim(x.theirs.device.slice(0, 16).padEnd(16))} ${show(x.theirs.value)}`);
          }
        }
        console.log(`  ${st.dim('localpilot sync resolve <id> --keep mine|theirs|both')}`);
        return 0;
      }
      case 'resolve': {
        const id = args[0];
        const keep = value('--keep') as 'mine' | 'theirs' | 'both' | undefined;
        const x = id ? await e.conflicts.get(id) : undefined;
        if (!x) {
          console.error(`${st.red('✖')} no conflict "${id ?? ''}" (localpilot sync conflicts lists them)`);
          return 1;
        }
        if (!keep) {
          if (x.kind === 'text-merge') {
            process.stdout.write(createTwoFilesPatch(`mine (${x.ours.device})`, `theirs (${x.theirs.device})`, String(x.ours.value ?? ''), String(x.theirs.value ?? '')));
          }
          console.log(`${st.dim(`choose with: localpilot sync resolve ${x.id} --keep mine|theirs${x.kind === 'text-merge' ? '|both' : ''}`)}`);
          return 0;
        }
        if (!['mine', 'theirs', 'both'].includes(keep)) {
          console.error(`${st.red('✖')} --keep must be mine, theirs or both`);
          return 2;
        }
        const r: Resolution = x.kind === 'branch-split' || x.kind === 'trash-vs-edit' ? (keep === 'theirs' ? 'theirs' : 'keep-applied') : x.kind === 'remote-damaged' || x.kind === 'clock-skew' ? 'keep-applied' : mineSide(x, c.device.deviceId, keep);
        await e.conflicts.resolve(x.id, r);
        if (e.configured && getConfig().sync.enabled) {
          await e.cycle('now');
        }
        console.log(`${st.green('✔')} resolved (${keep})`);
        return 0;
      }
      case 'passphrase': {
        const old = await passphrase('Current sync passphrase: ');
        const next = await newPassphrase('LOCALPILOT_SYNC_NEW_PASSPHRASE');
        if (!old || !next) {
          console.error(`${st.red('✖')} both passphrases are needed (or LOCALPILOT_SYNC_PASSPHRASE and LOCALPILOT_SYNC_NEW_PASSPHRASE)`);
          return 2;
        }
        await e.changePassphrase(old, next);
        console.log(`${st.green('✔')} passphrase changed; devices already syncing keep working`);
        return 0;
      }
      case 'rotate-key': {
        const pass = await passphrase();
        if (!pass) {
          return 2;
        }
        await e.rotateKey(pass);
        await e.cycle('now');
        console.log(`${st.green('✔')} new sync key in use; your other devices ask for the passphrase once`);
        return 0;
      }
      case 'remove-device': {
        const id = args[0];
        if (!id) {
          console.error(`${st.red('✖')} remove-device needs a device id (localpilot sync devices)`);
          return 2;
        }
        e.devices.revoke(id);
        if (flag('--rotate')) {
          const pass = await passphrase();
          if (pass) {
            await e.rotateKey(pass);
          }
        }
        await e.cycle('now');
        console.log(`${st.green('✔')} removed ${id}${args.includes('--rotate') ? '' : ' (add --rotate so it cannot read new data)'}`);
        return 0;
      }
      case 'off':
        await e.turnOff();
        await update('sync.enabled', false);
        console.log(`${st.green('✔')} sync is off on this device (the storage and your other devices are unchanged)`);
        return 0;
      case 'start-over': {
        if (!flag('--yes')) {
          console.error(`${st.red('✖')} this deletes every device's synced copies and uploads again from this device; add --yes to confirm`);
          return 2;
        }
        const pass = await newPassphrase();
        if (!pass) {
          return 2;
        }
        await e.startOver(pass);
        await update('sync.enabled', true);
        await e.cycle('now');
        console.log(`${st.green('✔')} started over; other devices must join again with the new passphrase`);
        return 0;
      }
    }
    return 0;
  } catch (err) {
    console.error(`${st.red('✖')} ${err instanceof WrongPassphraseError ? 'that passphrase is not right; nothing was changed' : err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await c.dispose();
  }
}

/** `/sync [now|status|pause|resume]` in the interactive CLI. */
export async function syncSlash(arg: string, o: { c?: Continuity; style: Style }): Promise<boolean> {
  const st = o.style;
  const e = o.c && !o.c.degraded ? (o.c.sync ?? o.c.attachSync({ settings: () => getConfig().sync, start: false })) : undefined;
  if (!e) {
    console.log(st.dim('sync is not available (conversation storage is off or still starting)'));
    return true;
  }
  const w = arg.trim().split(/\s+/)[0] || 'status';
  if (w === 'now') {
    if (!e.configured || !getConfig().sync.enabled) {
      console.log(st.dim('sync is not set up: localpilot sync setup --backend folder --folder <path>'));
      return true;
    }
    await e.syncNow();
  } else if (w === 'pause') {
    e.pause();
  } else if (w === 'resume') {
    e.resume();
  } else if (w !== 'status') {
    console.log(st.dim('usage: /sync [status|now|pause|resume]   (more: localpilot sync --help)'));
    return true;
  }
  const s = e.status();
  console.log(`${s.state === 'idle' ? st.green('●') : s.state === 'off' ? '○' : st.amber('●')} sync ${s.state}${s.message ? ` — ${s.message}` : ''} · last ${ago(s.lastSync)} · ${s.pending} waiting${s.conflicts ? ` · ${s.conflicts} conflict(s)` : ''}`);
  return true;
}
