// `localpilot secrets status|list|set|delete|import-env`: the encrypted secret store shared with VS Code (API keys, MCP
// sign-in tokens, sync credentials). Values are read from a hidden prompt or stdin and are never printed.
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { cliMigration, cliSecretError, cliSecretsFile, cliSecretStore, openCliSecrets } from '../secrets/cliSecrets';
import { SecretStore } from '../secrets/store';
import { secretUsage, usedBy } from '../secrets/usage';
import { configured, readSecret, Style } from './providers';

export const SECRETS_HELP = `localpilot secrets status [--json]              where the store is, how it is protected, how many secrets it holds
localpilot secrets list [--json]                names, what uses each, where it came from, last changed and used
localpilot secrets set <name> [-]               store a value: typed at a hidden prompt, or piped in (- or no terminal)
localpilot secrets delete <name>                remove one (says what still references it)
localpilot secrets import-env <name> <ENV_VAR>  copy an environment variable into the store once
Values are never printed. The store is ~/.localpilot/secrets.db, AES-256-GCM, unlocked by the OS keychain (or
LOCALPILOT_SECRETS_PASSPHRASE where there is none). Settings reference a secret as \${secret:<name>}.`;

const NAME = /^[A-Za-z0-9_.:-]+$/;

function usage(): Map<string, string[]> {
  const ws = vscode.workspace.getConfiguration('localpilot');
  const cfg = getConfig();
  return secretUsage({ providers: configured(), webSearchApiKey: ws.get<string>('webSearch.apiKey', ''), mcpServers: cfg.mcpServers });
}

function ago(t: number | undefined, now = Date.now()): string {
  if (!t) {
    return 'never';
  }
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`;
}

function sizeText(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** One line for `doctor`: how the store is protected, or why it is locked. */
export function secretStoreLine(st: Style): string {
  const s = cliSecretStore();
  if (!s) {
    return `${st.red('●')} locked: ${cliSecretError() ?? 'not opened'}`;
  }
  const x = s.status();
  return `${st.green('●')} ${x.count} secret${x.count === 1 ? '' : 's'} · ${x.cipher} · unlocked by ${x.unlockedBy} ${st.dim(x.file)}`;
}

export async function cmdSecrets(argv: string[], st: Style, out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  const json = argv.includes('--json');
  const words = argv.filter((a) => a !== '--json');
  const [sub = 'status', ...rest] = words;
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    out(SECRETS_HELP);
    return 0;
  }
  const store = cliSecretStore() ?? (await openCliSecrets());
  if (!store) {
    const why = cliSecretError() ?? 'the secret store could not be opened';
    if (json && sub === 'status') {
      out(JSON.stringify({ file: cliSecretsFile(), locked: true, error: why }, null, 2));
    } else {
      err(`${st.red('✖')} ${why}`);
    }
    return 1;
  }
  for (const m of cliMigration()) {
    if (m.error) {
      err(`${st.yellow('!')} ${m.error}`);
    }
  }
  switch (sub) {
    case 'status':
      return status(store, json, st, out);
    case 'list':
    case 'ls':
      return list(store, json, st, out);
    case 'set':
    case 'add':
      return set(store, rest, st, out, err);
    case 'delete':
    case 'rm':
    case 'remove':
      return remove(store, rest[0], st, out, err);
    case 'import-env':
      return importEnv(store, rest, st, out, err);
    default:
      err(`${st.red('✖')} unknown secrets command "${sub}"\n${SECRETS_HELP}`);
      return 2;
  }
}

function status(store: SecretStore, json: boolean, st: Style, out: (s: string) => void): number {
  const s = store.status();
  if (json) {
    out(JSON.stringify({ ...s, locked: false }, null, 2));
    return 0;
  }
  out(`${st.bold('Secret store')} ${st.dim(s.file)}`);
  out(`  ${s.cipher}, the whole file (names and values) · unlocked by ${s.unlockedBy}${s.mode === 'passphrase' ? st.dim(' (LOCALPILOT_SECRETS_PASSPHRASE)') : ''}`);
  out(`  ${s.count} secret${s.count === 1 ? '' : 's'} · ${sizeText(s.bytes)}`);
  return 0;
}

function list(store: SecretStore, json: boolean, st: Style, out: (s: string) => void): number {
  const use = usage();
  const rows = store.list().map((m) => ({ name: m.name, usedBy: usedBy(m.name, use), source: m.source, createdAt: m.createdAt, updatedAt: m.updatedAt, lastUsedAt: m.lastUsedAt ?? null }));
  if (json) {
    out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    out(st.dim('No secrets stored. Add a provider key: localpilot providers key <id>   ·   any value: localpilot secrets set <name>'));
    return 0;
  }
  const w = Math.min(40, Math.max(...rows.map((r) => r.name.length)));
  for (const r of rows) {
    out(`  ${st.cyan(r.name.padEnd(w))}  ${(r.usedBy.join(', ') || st.yellow('not used')).padEnd(24)}  ${st.dim(`${r.source || '—'} · changed ${ago(r.updatedAt)} · used ${ago(r.lastUsedAt ?? undefined)}`)}`);
  }
  return 0;
}

async function set(store: SecretStore, rest: string[], st: Style, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const [name, dash, extra] = rest;
  if (!name || !NAME.test(name) || (dash !== undefined && dash !== '-') || extra !== undefined) {
    err(`${st.red('✖')} Usage: localpilot secrets set <name> [-]   (letters, digits, . _ - :; the value is prompted for or piped in, never an argument)`);
    return 2;
  }
  const value = await readSecret(`Value for ${name}: `);
  if (!value) {
    err(`${st.red('✖')} No value given: nothing stored.`);
    return 2;
  }
  store.set(name, value, 'cli');
  out(`${st.green('✓')} Stored ${name} in the encrypted secret store. Reference it as \${secret:${name}}.`);
  return 0;
}

function remove(store: SecretStore, name: string | undefined, st: Style, out: (s: string) => void, err: (s: string) => void): number {
  if (!name) {
    err(`${st.red('✖')} Usage: localpilot secrets delete <name>`);
    return 2;
  }
  const users = usedBy(name, usage());
  if (!store.delete(name)) {
    err(`${st.red('✖')} No secret named "${name}" (localpilot secrets list)`);
    return 1;
  }
  out(`${st.green('✓')} Deleted ${name}.${users.length ? st.yellow(` Still referenced by ${users.join(', ')}: enter a new value there.`) : ''}`);
  return 0;
}

function importEnv(store: SecretStore, rest: string[], st: Style, out: (s: string) => void, err: (s: string) => void): number {
  const [name, env] = rest;
  if (!name || !env || !NAME.test(name)) {
    err(`${st.red('✖')} Usage: localpilot secrets import-env <name> <ENV_VAR>`);
    return 2;
  }
  const value = process.env[env]?.trim();
  if (!value) {
    err(`${st.red('✖')} $${env} is not set in this shell: nothing to import.`);
    return 1;
  }
  store.set(name, value, `env:${env}`);
  out(`${st.green('✓')} Copied $${env} into the secret store as ${name}. Reference it as \${secret:${name}}; the variable is not needed any more.`);
  return 0;
}
