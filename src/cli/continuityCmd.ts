// `localpilot data …`: the continuity data layer from the terminal (stats, backup, restore, rebuild-index, migrate,
// gc), and the CLI's way to open Continuity (same data root as VS Code: ~/.localpilot/continuity).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { getConfig } from '../config';
import { Continuity, continuityDataDir } from '../continuity/continuity';
import { isEncryptedBackup, WrongBackupPassphraseError } from '../continuity/data/backup';
import { cliKeysBox } from '../continuity/data/crypto/secretBox';
import { cliDataDir } from '../sessions/cliStorage';
import { readCliKeys, userSettingsPath, writeCliKey } from './vscodeShim';
import type { Style } from './providers';

export const DATA_USAGE = `localpilot data stats [--json]                 sizes, counts, index and migration state
localpilot data backup [-o file] [--encrypt]   back up conversations, memory and attachments
localpilot data restore <file>                 merge a backup in (never removes newer data)
localpilot data rebuild-index                  rebuild the search index from the change log
localpilot data migrate [--status|--retry|--remove-backup]   the import of LocalPilot 1.6 data
localpilot data gc                             remove attachments nothing refers to any more
Backup passphrases: prompted, or LOCALPILOT_BACKUP_PASSPHRASE.`;

const EXTENSION_ID = 'localpilot.localpilot-agent';

/** Opens continuity for the CLI. `schedules`/`autoMigrate` off for one-shot commands. */
export async function openCliContinuity(o: { cwd: string; dataDir?: string; log: { info(m: string): void; warn(m: string): void; error(m: string): void }; schedules?: boolean; autoMigrate?: boolean; version?: string }): Promise<Continuity> {
  const vscodeGlobal = path.join(path.dirname(userSettingsPath()), 'globalStorage', EXTENSION_ID);
  const home = path.join(os.homedir(), '.localpilot');
  return Continuity.open({
    dataDir: continuityDataDir(getConfig().continuity.dataDir || (o.dataDir ? path.join(o.dataDir, 'continuity') : '')),
    writer: 'cli',
    appVersion: o.version ?? '0.0.0',
    secrets: cliKeysBox(readCliKeys, writeCliKey),
    log: o.log,
    settings: () => getConfig().continuity,
    wasmPath: process.env.LOCALPILOT_SQLJS_WASM || path.join(__dirname, 'sqljs', 'sql-wasm.wasm'),
    workerPath: path.join(__dirname, 'continuityWorker.js'),
    schedules: o.schedules,
    autoMigrate: o.autoMigrate,
    migration: {
      cliDataDir: cliDataDir(o.dataDir),
      home,
      workspaceFolders: [o.cwd],
      ...(fs.existsSync(vscodeGlobal) ? { vscodeGlobalStorage: vscodeGlobal, extensionId: EXTENSION_ID } : {}),
    },
  });
}

const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);

async function askHidden(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const out = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WritableStream };
  let prompted = false;
  out._writeToOutput = (s: string) => {
    if (!prompted) {
      process.stderr.write(s);
      prompted = true;
    }
  };
  const answer = await new Promise<string>((res) => rl.question(question, res));
  rl.close();
  process.stderr.write('\n');
  return answer;
}

async function passphrase(confirm: boolean): Promise<string | undefined> {
  const env = process.env.LOCALPILOT_BACKUP_PASSPHRASE;
  if (env) {
    return env;
  }
  const a = await askHidden('Backup passphrase: ');
  if (!a || !confirm) {
    return a || undefined;
  }
  const b = await askHidden('Again: ');
  if (a !== b) {
    throw new Error('the two passphrases differ');
  }
  return a;
}

/** Runs `localpilot data <sub> …`; returns the exit code. */
export async function cmdData(argv: string[], st: Style, o: { cwd: string; version?: string }): Promise<number> {
  const args = [...argv];
  let dataDir: string | undefined;
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
      if (i >= 0 && args[i + 1]) {
        const v = args[i + 1];
        args.splice(i, 2);
        return v;
      }
    }
    return undefined;
  };
  dataDir = value('--data-dir');
  dataDir = dataDir ? path.resolve(dataDir) : undefined;
  const json = flag('--json');
  const sub = args.shift() ?? 'stats';
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(DATA_USAGE);
    return 0;
  }
  if (!['stats', 'backup', 'restore', 'rebuild-index', 'migrate', 'gc'].includes(sub)) {
    console.error(`${st.red('✖')} unknown data command "${sub}"\n${DATA_USAGE}`);
    return 2;
  }
  const warnings: string[] = [];
  const log = { info: () => undefined, warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m) };
  const c = await openCliContinuity({ cwd: o.cwd, dataDir, log, schedules: false, autoMigrate: false, version: o.version });
  try {
    if (c.degraded) {
      console.error(`${st.red('✖')} conversation storage is not available: ${c.degraded}`);
      return 1;
    }
    await c.ready;
    if (c.indexFailed && sub !== 'backup' && sub !== 'restore') {
      console.error(`${st.amber('!')} search index unavailable: ${c.indexFailed}`);
    }
    switch (sub) {
      case 'stats': {
        const s = await c.data.stats();
        if (json) {
          console.log(JSON.stringify(s, null, 2));
          return 0;
        }
        const rows: [string, string][] = [
          ['Data folder', s.dataDir],
          ['Device', `${s.deviceName} (${s.deviceId})`],
          ['Conversations', `${s.conversations ?? '?'} · ${s.messages ?? '?'} messages · ${s.trash ?? 0} in Trash`],
          ['Change log', `${fmtBytes(s.bytes.logs)} in ${s.streams} log(s)`],
          ['Search index', `${fmtBytes(s.bytes.index)} · ${s.index?.state ?? 'unavailable'}${s.index ? ` · ${s.index.fts}` : ''}`],
          ['Attachments', fmtBytes(s.bytes.blobs)],
          ['Backups', `${s.backups} · ${fmtBytes(s.bytes.backups)}${s.lastBackup ? ` · last ${new Date(s.lastBackup.at).toLocaleString()}` : ''}`],
          ['Import from 1.6', `${s.migration.state} · ${s.migration.sources} file(s) · ${s.migration.failed.length} failed · backup ${fmtBytes(s.migration.backupBytes)}`],
        ];
        for (const [k, v] of rows) {
          console.log(`  ${st.dim(k.padEnd(16))} ${v}`);
        }
        return 0;
      }
      case 'backup': {
        const file = value('-o', '--output');
        const pass = flag('--encrypt') ? await passphrase(true) : undefined;
        if (argv.includes('--encrypt') && !pass) {
          console.error(`${st.red('✖')} --encrypt needs a passphrase: run in a terminal or set LOCALPILOT_BACKUP_PASSPHRASE`);
          return 2;
        }
        const r = await c.data.backup({ passphrase: pass, file: file ? path.resolve(o.cwd, file) : undefined });
        console.log(`${st.green('✔')} ${r.file} (${fmtBytes(r.bytes)}, ${r.events} events, ${r.blobs} attachment(s)${r.encrypted ? ', encrypted' : ''})`);
        return 0;
      }
      case 'restore': {
        const file = args[0] ? path.resolve(o.cwd, args[0]) : undefined;
        if (!file || !fs.existsSync(file)) {
          console.error(`${st.red('✖')} restore needs a backup file`);
          return 2;
        }
        const pass = isEncryptedBackup(file) ? await passphrase(false) : undefined;
        try {
          const r = await c.data.restore(file, pass);
          console.log(`${st.green('✔')} restored ${r.imported} change(s) from ${r.streams} log(s), ${r.blobs} attachment(s); ${r.skipped} already here`);
          for (const x of r.refused) {
            console.log(`  ${st.amber('!')} ${x.stream}: ${x.reason}`);
          }
          return 0;
        } catch (e) {
          console.error(`${st.red('✖')} ${e instanceof WrongBackupPassphraseError ? 'that passphrase does not open this backup' : e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      case 'rebuild-index': {
        const t0 = Date.now();
        await c.data.rebuildIndex();
        const s = await c.index.status();
        console.log(`${st.green('✔')} index rebuilt: ${s.events} events, ${fmtBytes(s.bytes)} in ${Date.now() - t0} ms`);
        return 0;
      }
      case 'migrate': {
        if (flag('--remove-backup')) {
          console.log(`${st.green('✔')} removed the migration backup (${fmtBytes(c.data.removeMigrationBackup())})`);
          return 0;
        }
        if (!flag('--status')) {
          const retry = flag('--retry');
          const p = await c.migration.run(retry ? { retry: true } : {});
          await c.index.catchUp();
          if (p.state === 'busy') {
            console.log(`${st.amber('!')} another LocalPilot window or CLI is importing right now`);
          }
        }
        const s = c.data.migrationStatus();
        if (json) {
          console.log(JSON.stringify(s, null, 2));
          return 0;
        }
        console.log(`  ${st.dim('State'.padEnd(10))} ${s.state}${s.completedAt ? ` (${new Date(s.completedAt).toLocaleString()})` : ''}`);
        console.log(`  ${st.dim('Imported'.padEnd(10))} ${s.sources} file(s), ${s.events} change(s)`);
        console.log(`  ${st.dim('Backup'.padEnd(10))} ${s.backupDir ?? 'none'} (${fmtBytes(s.backupBytes)})`);
        for (const f of s.failed) {
          console.log(`  ${st.red('✖')} ${f.path}: ${f.error}`);
        }
        return s.failed.length ? 1 : 0;
      }
      case 'gc': {
        const r = await c.data.gc();
        console.log(`${st.green('✔')} removed ${r.removed} unused attachment(s) (${fmtBytes(r.bytes)})`);
        return 0;
      }
    }
    return 0;
  } finally {
    await c.dispose();
    if (process.env.LOCALPILOT_DEBUG && warnings.length) {
      console.error(warnings.join('\n'));
    }
  }
}
