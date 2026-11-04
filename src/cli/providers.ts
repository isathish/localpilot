import * as readline from 'readline';
import * as vscode from 'vscode';
import { isCloudProvider, isRemoteUrl, keyStatus, resolveApiKey, secretEnvName, setSecretValues } from '../providers/cloud';
import { probeProvider, ProbeResult } from '../providers/discovery';
import { bedrockRegion, findPreset, PROVIDER_PRESETS, PresetGroup, presetFor, withRegion } from '../providers/presets';
import { ProviderConfig } from '../types';
import { DEFAULT_PROVIDERS } from '../providers/defaultProviders';
import { sanitizeProviderConfig } from '../providers/sanitize';
import { CLI_KEYS_PATH, CLI_SETTINGS_PATH, readCliConfig, writeCliConfig, writeCliKey } from './vscodeShim';
import { getManagedPolicy, isManaged, mergeManagedProviders } from '../agent/managedPolicy';

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  amber(s: string): string;
  cyan(s: string): string;
}

export interface ProviderFlags {
  id?: string;
  url?: string;
  type?: string;
  name?: string;
  key?: string;
  keyEnv?: string;
  cloud?: boolean;
  removeKey?: boolean;
  /** AWS region for the Bedrock preset. */
  region?: string;
}

const GROUP_LABEL: Record<PresetGroup, string> = { local: 'On this machine', gateway: 'Gateways (local, forward to cloud models)', cloud: 'Cloud APIs (your key)' };

/** Every configured provider, disabled ones included (getConfig() drops those). */
export function configured(): ProviderConfig[] {
  // VS Code's language models (`vscode-lm`) exist only inside VS Code.
  // The organisation's providers are listed too: users supply their key with `providers key <id>`.
  return mergeManagedProviders(vscode.workspace.getConfiguration('localpilot').get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS) ?? [], getManagedPolicy()).filter((p) => p.type !== 'vscode-lm');
}

/** Providers written by the CLI itself (~/.localpilot/config.json), as stored. */
function cliProviders(cfg = readCliConfig()): ProviderConfig[] {
  const v = cfg.providers ?? cfg['localpilot.providers'];
  return Array.isArray(v) ? (v as ProviderConfig[]) : [];
}

async function saveCliProviders(list: ProviderConfig[]): Promise<void> {
  const cfg = readCliConfig();
  delete cfg['localpilot.providers'];
  cfg.providers = list;
  await writeCliConfig(cfg);
}

/** Adds or updates fields of one provider in the CLI's own list (merged over VS Code's by id). */
async function patchProvider(id: string, patch: Partial<ProviderConfig>): Promise<void> {
  const list = cliProviders();
  const i = list.findIndex((p) => p.id === id);
  const next = i >= 0 ? list.map((p, j) => (j === i ? { ...p, ...patch } : p)) : [...list, { id, ...patch } as ProviderConfig];
  await saveCliProviders(next.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as unknown as ProviderConfig));
}

/** The organisation's provider with this id, when the policy provides one. */
function orgProvider(id: string): ProviderConfig | undefined {
  const pol = getManagedPolicy();
  return isManaged(pol) ? pol.providers?.find((m) => m.id === id) : undefined;
}

/** Sets a provider's key in the CLI's list. A new entry for an organisation provider carries its type and endpoint (as Settings does), never a bare stub. */
async function patchKey(id: string, apiKey: string | undefined): Promise<void> {
  const org = orgProvider(id);
  if (org && !cliProviders().some((p) => p.id === id)) {
    if (apiKey) {
      await patchProvider(id, { type: org.type, baseUrl: org.baseUrl, apiKey });
    }
    return;
  }
  await patchProvider(id, { apiKey });
}

function keyText(p: ProviderConfig, st: Style): string {
  const k = keyStatus(p);
  if (k.source === 'none') {
    return isRemoteUrl(p.baseUrl) || p.type === 'anthropic' ? st.red('no API key') : st.dim('no key');
  }
  if (!k.ok) {
    return st.red(k.source === 'env' ? `${k.env} not set` : `key missing (set ${secretEnvName(p.apiKey!.replace(/^\$\{secret:|\}$/g, ''))} or run: localpilot providers key ${p.id})`);
  }
  return st.dim(k.source === 'keychain' ? 'key stored' : k.source === 'env' ? `key from $${k.env}` : 'key in settings');
}

function probeLine(r: ProbeResult | undefined, st: Style): string {
  if (!r) {
    return st.dim('disabled');
  }
  return r.ok ? st.green(`${r.models.length} model${r.models.length === 1 ? '' : 's'} · ${r.latencyMs} ms`) : st.red(r.error ?? 'unreachable');
}

/** `localpilot providers` — configured providers, local first, with reachability and key state. */
export async function listProviders(st: Style, out: (s: string) => void = console.log, opts: { compact?: boolean } = {}): Promise<void> {
  const list = configured();
  if (!list.length) {
    out(`${st.red('✖')} No providers configured. Add one: localpilot providers add ollama  ·  localpilot providers presets`);
    return;
  }
  const probes = new Map((await Promise.all(list.filter((p) => p.enabled !== false).map((p) => probeProvider(p, true)))).map((r) => [r.id, r]));
  for (const [cloud, title] of [[false, 'Local'], [true, 'Cloud']] as const) {
    const group = list.filter((p) => isCloudProvider(p) === cloud);
    if (!group.length) {
      continue;
    }
    if (!opts.compact) {
      out(`${st.bold(title)} ${st.dim(cloud ? '— prompts and code are sent to the provider' : '— code stays on this machine')}`);
    }
    for (const p of group) {
      const r = probes.get(p.id);
      const dot = p.enabled === false ? st.dim('○') : r?.ok ? st.green('●') : st.red('●');
      const k = keyStatus(p);
      const keyMissing = p.enabled !== false && ((k.source !== 'none' && !k.ok) || (k.source === 'none' && (isRemoteUrl(p.baseUrl) || p.type === 'anthropic')));
      // A missing key explains the failed probe: say that once instead of both.
      const state = keyMissing ? keyText(p, st) : `${probeLine(r, st)}${cloud || p.apiKey ? `  ${keyText(p, st)}` : ''}`;
      if (opts.compact) {
        // doctor: one line per provider, as before cloud providers existed.
        out(`${dot} ${st.bold((p.displayName || p.id).padEnd(22))} ${st.dim((p.baseUrl ?? '').padEnd(34))} ${state}${cloud ? st.yellow('  cloud') : ''}`);
      } else {
        out(`  ${dot} ${st.bold((p.displayName || p.id).padEnd(22))} ${st.cyan(p.id.padEnd(14))} ${st.dim(`${(p.type ?? '?').padEnd(9)} ${p.baseUrl ?? ''}`)}`);
        out(`      ${state}`);
      }
    }
  }
  if (!opts.compact) {
    out(st.dim(`\nAdd one: localpilot providers add <preset|url>  ·  presets: localpilot providers presets  ·  key: localpilot providers key <id>`));
  }
}

/** `localpilot providers presets` — what `providers add` accepts. */
export function listPresets(st: Style, out: (s: string) => void = console.log): void {
  const have = new Set(configured().map((p) => p.id));
  for (const group of ['local', 'cloud', 'gateway'] as const) {
    out(st.bold(GROUP_LABEL[group]));
    for (const pr of PROVIDER_PRESETS.filter((x) => x.group === group)) {
      out(`  ${have.has(pr.cfg.id) ? st.green('✓') : st.dim('·')} ${st.cyan(pr.key.padEnd(13))} ${pr.label.padEnd(22)} ${st.dim(pr.env ? `$${pr.env}` : pr.cfg.baseUrl)}`);
    }
  }
  out(st.dim('\n✓ = configured. Add: localpilot providers add <name> [--key <key> | --key-env VAR]'));
}

/** Reads a key without echoing it (TTY), or from piped stdin. */
export async function readSecret(prompt: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) {
      data += chunk;
    }
    return data.trim() || undefined;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const mute = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let prompted = false;
  mute._writeToOutput = (s: string) => {
    // Show the prompt once, then nothing of what is typed.
    if (!prompted) {
      prompted = true;
      mute.output.write(s);
    }
  };
  try {
    const v = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    process.stdout.write('\n');
    return v.trim() || undefined;
  } finally {
    rl.close();
  }
}

/** Stores a key for the CLI and returns the reference to put in the provider. */
async function storeKey(id: string, key: string): Promise<string> {
  await writeCliKey(id, key);
  setSecretValues({ [id]: key });
  return `\${secret:${id}}`;
}

/** `localpilot providers add <preset|url>` */
export async function addProvider(target: string, flags: ProviderFlags, st: Style, out: (s: string) => void = console.log): Promise<number> {
  if (!target) {
    out(`${st.red('✖')} Usage: localpilot providers add <preset|url> [--id <id>] [--key <key> | --key-env VAR] [--region <aws-region>] [--cloud]   (presets: localpilot providers presets)`);
    return 2;
  }
  const isUrl = /^https?:\/\//i.test(target) || /^[\w.-]+:\d+/.test(target);
  const preset = isUrl ? undefined : findPreset(target, { fuzzy: true });
  if (!isUrl && !preset) {
    out(`${st.red('✖')} Unknown provider "${target}". See: localpilot providers presets — or pass a URL.`);
    return 2;
  }
  if (preset && !findPreset(target)) {
    out(st.dim(`Using preset ${preset.label} for '${target}'`));
  }
  const base: ProviderConfig = preset
    ? { ...preset.cfg }
    : { id: flags.id || (target.replace(/^https?:\/\//i, '').split(/[/:]/)[0] || 'custom'), type: 'openai', baseUrl: target, displayName: flags.name };
  const taken = new Set(configured().map((p) => p.id));
  let id = (flags.id || base.id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  // Adding a preset that is one of the built-in local servers updates that entry instead of creating "ollama-2".
  const existing = configured().find((p) => p.id === id);
  const builtin = !flags.id && !!existing && DEFAULT_PROVIDERS.some((d) => d.id === id && d.baseUrl === existing.baseUrl);
  if (!flags.id && !builtin) {
    for (let n = 2; taken.has(id); n++) {
      id = `${base.id}-${n}`;
    }
  } else if (flags.id && taken.has(id)) {
    out(`${st.red('✖')} A provider with id "${id}" already exists. Pick another with --id, or change it: localpilot providers key ${id}`);
    return 2;
  }
  const cfg: ProviderConfig = { ...base, id, ...(builtin && existing?.enabled === false ? { enabled: true } : {}) };
  if (flags.url) {
    cfg.baseUrl = flags.url;
  }
  if (flags.region) {
    const url = withRegion(cfg.baseUrl, flags.region);
    if (!bedrockRegion(cfg.baseUrl) || (url === cfg.baseUrl && bedrockRegion(url) !== flags.region.trim().toLowerCase())) {
      out(`${st.red('✖')} --region applies to Amazon Bedrock endpoints and takes an AWS region such as us-west-2${bedrockRegion(cfg.baseUrl) ? ` (got "${flags.region}")` : ''}.`);
      return 2;
    }
    cfg.baseUrl = url;
  }
  if (flags.type === 'ollama' || flags.type === 'openai' || flags.type === 'anthropic') {
    cfg.type = flags.type;
  }
  if (flags.name) {
    cfg.displayName = flags.name;
  }
  // A cloud API stays cloud behind a proxy or a regional URL; the URL alone would call a localhost proxy "local".
  if (flags.cloud !== undefined) {
    cfg.cloud = flags.cloud;
  } else if (preset?.group === 'cloud') {
    cfg.cloud = true;
  }
  if (flags.keyEnv) {
    cfg.apiKey = `\${env:${flags.keyEnv}}`;
  } else if (flags.key) {
    cfg.apiKey = await storeKey(id, flags.key);
  } else if (preset?.group === 'cloud' && !resolveApiKey(cfg) && process.stdin.isTTY) {
    // A cloud API without its key is useless: ask once (not echoed), unless the usual variable already has one.
    out(st.dim(`${preset.env} is not set. Paste the key (get one at ${preset.keyUrl}), or press Enter to skip:`));
    const k = await readSecret('API key: ');
    if (k) {
      cfg.apiKey = await storeKey(id, k);
    }
  }
  await patchProvider(id, sanitizeProviderConfig(cfg));
  out(`${st.green('✓')} Added ${st.bold(cfg.displayName || id)} as ${st.cyan(id)} ${st.dim(`(${cfg.baseUrl})`)} to ${st.dim(CLI_SETTINGS_PATH)}`);
  return reportProbe(cfg, st, out);
}

async function reportProbe(cfg: ProviderConfig, st: Style, out: (s: string) => void): Promise<number> {
  const r = await probeProvider(cfg, true);
  if (!r.ok) {
    out(`${st.yellow('!')} Not reachable yet: ${r.error}`);
    const pr = presetFor(cfg);
    if (pr?.keyUrl && /key|401|403|auth/i.test(r.error ?? '')) {
      out(st.dim(`  Get a key at ${pr.keyUrl}, then: localpilot providers key ${cfg.id}`));
    }
    return 1;
  }
  out(`${st.green('●')} Connected in ${r.latencyMs} ms · ${r.models.length} model${r.models.length === 1 ? '' : 's'}${isCloudProvider(cfg) ? st.dim('  (cloud: automatic picks still prefer local models)') : ''}`);
  for (const m of r.models.slice(0, 12)) {
    out(`  ${st.dim('○')} ${m.id}`);
  }
  if (r.models.length > 12) {
    out(st.dim(`  … ${r.models.length - 12} more (localpilot models)`));
  }
  if (r.models[0]) {
    out(st.dim(`Use one: localpilot -m ${r.models[0].id} "your task"`));
  }
  return 0;
}

/** `localpilot providers key <id> [key]` — stores, replaces or removes a provider's key for the CLI. */
export async function setProviderKey(id: string, key: string | undefined, flags: ProviderFlags, st: Style, out: (s: string) => void = console.log): Promise<number> {
  const p = configured().find((x) => x.id === id);
  if (!p) {
    out(`${st.red('✖')} No provider "${id}". Configured: ${configured().map((x) => x.id).join(', ') || 'none'}`);
    return 2;
  }
  if (flags.removeKey) {
    await writeCliKey(id, undefined);
    await patchKey(id, undefined);
    out(`${st.green('✓')} Removed the key of ${id}`);
    return 0;
  }
  if (flags.keyEnv) {
    await patchKey(id, `\${env:${flags.keyEnv}}`);
    out(`${st.green('✓')} ${id} reads its key from $${flags.keyEnv}${process.env[flags.keyEnv] ? '' : st.yellow(' (not set in this shell)')}`);
  } else {
    const k = key ?? (await readSecret(`API key for ${p.displayName || id}: `));
    if (!k) {
      out(`${st.red('✖')} No key given. Usage: localpilot providers key ${id} <key>  (or pipe it in, or --key-env VAR)`);
      return 2;
    }
    const ref = await storeKey(id, k);
    // Keep a VS Code keychain reference as it is: the CLI resolves `${secret:id}` from its own key file.
    if (p.apiKey !== ref) {
      await patchKey(id, ref);
    }
    out(`${st.green('✓')} Key for ${id} saved to ${st.dim(CLI_KEYS_PATH)} (readable by you only)`);
  }
  return reportProbe(configured().find((x) => x.id === id)!, st, out);
}

/** `localpilot providers remove <id>` — removes a CLI-added provider (and its key); a VS Code one is disabled for the CLI. */
export async function removeProvider(id: string, st: Style, out: (s: string) => void = console.log): Promise<number> {
  if (!configured().some((p) => p.id === id)) {
    out(`${st.red('✖')} No provider "${id}".`);
    return 2;
  }
  if (orgProvider(id)) {
    out(`${st.red('✖')} ${id} is provided by your organization's policy and cannot be removed or disabled. Forget your key with: localpilot providers key ${id} --remove-key`);
    return 2;
  }
  const mine = cliProviders();
  if (mine.some((p) => p.id === id)) {
    await saveCliProviders(mine.filter((p) => p.id !== id));
    await writeCliKey(id, undefined);
  }
  // Still listed: it comes from VS Code's settings or the built-in defaults, which the CLI never writes.
  if (configured().some((p) => p.id === id)) {
    await patchProvider(id, { enabled: false });
    const p = configured().find((x) => x.id === id);
    const builtin = DEFAULT_PROVIDERS.some((d) => d.id === id && d.baseUrl === p?.baseUrl);
    out(`${st.green('✓')} ${builtin ? `${id} is a built-in default: disabled it for the CLI. Re-enable it with: localpilot providers add ${id}` : `${id} is defined in VS Code settings: disabled it for the CLI. Remove it in VS Code under Settings → Providers.`}`);
    return 0;
  }
  out(`${st.green('✓')} Removed ${id} and its stored key`);
  return 0;
}

/** `localpilot providers test [id]` */
export async function testProviders(id: string | undefined, st: Style, out: (s: string) => void = console.log): Promise<number> {
  const list = configured().filter((p) => (id ? p.id === id : p.enabled !== false));
  if (!list.length) {
    out(`${st.red('✖')} ${id ? `No provider "${id}".` : 'No enabled providers.'}`);
    return 2;
  }
  let code = 0;
  for (const p of list) {
    out(`${st.bold(p.displayName || p.id)} ${st.dim(`${p.id} · ${p.baseUrl}`)}`);
    code = Math.max(code, await reportProbe(p, st, out));
  }
  return code;
}
