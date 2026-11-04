import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseJsonc } from './settings';
import { evaluatePermission } from './permissions';
import type { ProviderConfig } from '../types';
import type { OtlpSettings } from '../telemetry/otlp';
import { sanitizeProviderConfig } from '../providers/sanitize';

/**
 * Organisation policy: a settings file an administrator deploys to a system location, which users and projects cannot
 * override. It tightens; it never loosens. Deny and ask rules beat any project `allow`, approvals cannot be set below
 * the floor, cloud providers, web access, MCP servers and skill downloads can be restricted, and every tool call can be
 * written to an audit log.
 *
 *   macOS    /Library/Application Support/LocalPilot/managed-settings.json
 *   Linux    /etc/localpilot/managed-settings.json
 *   Windows  %ProgramData%\LocalPilot\managed-settings.json
 *   any      $LOCALPILOT_MANAGED_SETTINGS (a path; for testing or a non-standard deployment)
 */
export type ApprovalKind = 'terminal' | 'write' | 'delete' | 'network' | 'mcp';

export interface ManagedPolicy {
  /** File the policy was read from; undefined when none is deployed. */
  source?: string;
  /** Same rule syntax as settings.json (`Bash(rm:*)`, `Read(.env)`, `WebFetch(domain:x.com)`); deny and ask win over any project allow. */
  permissions: { deny: string[]; ask: string[]; allow: string[] };
  /** Floor per approval kind: `ask` = never auto-approved, `never` = always refused. */
  approvals: Partial<Record<ApprovalKind, 'ask' | 'never'>>;
  /** Forbid `permissions.defaultMode` bypassPermissions/acceptEdits and Auto mode (the model approving for you). */
  disableBypassPermissions: boolean;
  /** false: providers outside this machine and the private network are not loaded. */
  allowCloudProviders: boolean;
  /** When set, only providers whose host matches one of these (`*.corp.example`, `api.openai.com`) are loaded. */
  allowedProviderHosts?: string[];
  /** false: web_search, web_fetch and the browser tools are removed. */
  allowWebAccess: boolean;
  /** When set, only these MCP servers start; an entry with a `url` or `command` also pins what the name may point at. */
  allowedMcpServers?: McpAllowEntry[];
  /** MCP servers the organisation provides (the mcp.json shape plus `alwaysEnabled`); they win over any user or project server of the same name. */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** true: remote (non-stdio) servers start only when their URL is one the policy lists. */
  blockPersonalRemoteMcp: boolean;
  /** Providers the organisation configures: merged in and locked; users supply only their keys. */
  providers?: ProviderConfig[];
  /** When set, only models whose `provider/model` id matches one of these globs are listed or routed to. */
  allowedModels?: string[];
  /** When set, overrides the user's telemetry settings (see applyTelemetryPolicy). */
  telemetry?: TelemetryPolicy;
  /** false: skills are never downloaded (catalog auto-install, `/skill install`). */
  allowSkillInstall: boolean;
  /** JSONL file every tool call and approval is appended to (`~` and `${workspaceFolder}` are expanded). */
  auditLog?: string;
  /** Shown to users wherever the policy blocks something, e.g. "Contact it-security@corp.example". */
  message?: string;
}

export interface McpAllowEntry {
  name: string;
  url?: string;
  command?: string;
}

export interface TelemetryPolicy {
  /** Forces local recording on or off. */
  enabled?: boolean;
  /** false (the default once `telemetry` is set): Redis storage and the user's OTLP export are off. */
  allowRemoteExport: boolean;
  /** The organisation's collector: exported to regardless of the user's opt-out and OTEL_* variables. */
  otlp?: Partial<OtlpSettings>;
}

const NONE: ManagedPolicy = { permissions: { deny: [], ask: [], allow: [] }, approvals: {}, disableBypassPermissions: false, allowCloudProviders: true, allowWebAccess: true, allowSkillInstall: true, blockPersonalRemoteMcp: false };

export function managedPolicyPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string {
  const system = platform === 'darwin' ? '/Library/Application Support/LocalPilot/managed-settings.json' : platform === 'win32' ? path.win32.join(env.ProgramData ?? 'C:\\ProgramData', 'LocalPilot', 'managed-settings.json') : '/etc/localpilot/managed-settings.json';
  // The environment can point elsewhere only where no administrator deployed a policy: it must not replace one.
  // Only an absolute path counts: a relative one would follow whatever folder LocalPilot runs in, and the policy's
  // skills, rules and commands folders next to it with it.
  const override = env.LOCALPILOT_MANAGED_SETTINGS;
  return override && path.isAbsolute(override) && !exists(system) ? override : system;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function mcpAllowList(v: unknown): McpAllowEntry[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: McpAllowEntry[] = [];
  for (const x of v) {
    const o = obj(x);
    const name = typeof x === 'string' ? str(x) : str(o?.name);
    if (name) {
      out.push({ name, ...(str(o?.url) ? { url: str(o?.url) } : {}), ...(str(o?.command) ? { command: str(o?.command) } : {}) });
    }
  }
  return out;
}

function telemetryPolicy(v: unknown): TelemetryPolicy | undefined {
  const t = obj(v);
  if (!t) {
    return undefined;
  }
  const o = obj(t.otlp);
  let otlp: Partial<OtlpSettings> | undefined;
  if (o) {
    otlp = {};
    if (typeof o.enabled === 'boolean') {
      otlp.enabled = o.enabled;
    }
    if (str(o.endpoint)) {
      otlp.endpoint = str(o.endpoint);
    }
    const h = obj(o.headers);
    if (h) {
      otlp.headers = Object.fromEntries(Object.entries(h).filter((e): e is [string, string] => typeof e[1] === 'string'));
    }
    if (typeof o.metricsInterval === 'number' && o.metricsInterval > 0) {
      otlp.metricsInterval = o.metricsInterval;
    }
    if (Array.isArray(o.exporters)) {
      otlp.exporters = strings(o.exporters);
    }
    if (typeof o.traceSamplePercent === 'number') {
      otlp.traceSamplePercent = Math.max(0, Math.min(100, o.traceSamplePercent));
    }
    if (typeof o.recordContent === 'boolean') {
      otlp.recordContent = o.recordContent;
    }
  }
  return { ...(typeof t.enabled === 'boolean' ? { enabled: t.enabled } : {}), allowRemoteExport: t.allowRemoteExport === true, ...(otlp ? { otlp } : {}) };
}

/** Pure: a policy from parsed JSON. Unknown keys are ignored; anything malformed falls back to the permissive default for that key. */
export function normalizePolicy(raw: unknown, source?: string): ManagedPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const perm = (r.permissions && typeof r.permissions === 'object' ? r.permissions : {}) as Record<string, unknown>;
  const appr = (r.approvals && typeof r.approvals === 'object' ? r.approvals : {}) as Record<string, unknown>;
  const approvals: ManagedPolicy['approvals'] = {};
  for (const k of ['terminal', 'write', 'delete', 'network', 'mcp'] as ApprovalKind[]) {
    if (appr[k] === 'ask' || appr[k] === 'never') {
      approvals[k] = appr[k] as 'ask' | 'never';
    }
  }
  // MCP tools were governed by the network floor before they had their own: a policy written then still covers them.
  if (!approvals.mcp && approvals.network) {
    approvals.mcp = approvals.network;
  }
  return {
    source,
    permissions: { deny: strings(perm.deny), ask: strings(perm.ask), allow: strings(perm.allow) },
    approvals,
    disableBypassPermissions: r.disableBypassPermissions === true,
    allowCloudProviders: r.allowCloudProviders !== false,
    allowedProviderHosts: Array.isArray(r.allowedProviderHosts) ? strings(r.allowedProviderHosts) : undefined,
    allowWebAccess: r.allowWebAccess !== false,
    allowedMcpServers: mcpAllowList(r.allowedMcpServers),
    mcpServers: obj(r.mcpServers) ? Object.fromEntries(Object.entries(obj(r.mcpServers)!).filter((e): e is [string, Record<string, unknown>] => !!e[0].trim() && !!obj(e[1]))) : undefined,
    blockPersonalRemoteMcp: r.blockPersonalRemoteMcp === true,
    providers: Array.isArray(r.providers) ? r.providers.filter((x) => !!obj(x) && str(obj(x)!.id) && str(obj(x)!.baseUrl)).map((x) => sanitizeProviderConfig(x as ProviderConfig)) : undefined,
    allowedModels: Array.isArray(r.allowedModels) ? strings(r.allowedModels) : undefined,
    telemetry: telemetryPolicy(r.telemetry),
    allowSkillInstall: r.allowSkillInstall !== false,
    auditLog: typeof r.auditLog === 'string' && r.auditLog.trim() ? r.auditLog.trim() : undefined,
    message: typeof r.message === 'string' && r.message.trim() ? r.message.trim() : undefined,
  };
}

let cached: { file: string; mtime: number; checkedAt: number; policy: ManagedPolicy } | undefined;

/**
 * The deployed policy, re-read when the file changes (checked at most every few seconds, so an administrator's update
 * applies without a restart). A file that exists but cannot be parsed is treated as the strictest reading of what
 * could be read, never as "no policy": it is logged and its parseable keys still apply.
 */
export function getManagedPolicy(log?: { warn(m: string): void }): ManagedPolicy {
  const file = managedPolicyPath();
  const now = Date.now();
  if (cached && cached.file === file && now - cached.checkedAt < 5_000) {
    return cached.policy;
  }
  let mtime = -1;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cached = { file, mtime: -1, checkedAt: now, policy: NONE };
    return NONE;
  }
  if (cached && cached.file === file && cached.mtime === mtime) {
    cached.checkedAt = now;
    return cached.policy;
  }
  let policy: ManagedPolicy;
  try {
    policy = normalizePolicy(parseJsonc(fs.readFileSync(file, 'utf8')), file);
  } catch (e) {
    log?.warn(`managed policy ${file} could not be read: ${e instanceof Error ? e.message : String(e)} — cloud providers, web access, remote MCP servers, telemetry export and skill downloads are blocked until it is fixed`);
    policy = { ...NONE, source: file, allowCloudProviders: false, allowWebAccess: false, allowSkillInstall: false, disableBypassPermissions: true, blockPersonalRemoteMcp: true, telemetry: { allowRemoteExport: false }, approvals: { terminal: 'ask', write: 'ask', delete: 'ask', network: 'ask', mcp: 'ask' } };
  }
  cached = { file, mtime, checkedAt: now, policy };
  return policy;
}

/** For tests: forget the cached policy. */
export function resetManagedPolicyCache(): void {
  cached = undefined;
}

export const isManaged = (p: ManagedPolicy) => !!p.source;

const by = (p: ManagedPolicy) => `your organization's policy${p.message ? ` (${p.message})` : ''}`;

/** The policy's verdict on a tool call before any project rule: deny, force a prompt, or nothing to say. */
export function policyVerdict(p: ManagedPolicy, toolName: string, args: Record<string, unknown>, root?: string): { decision: 'deny' | 'ask' | 'none'; reason?: string } {
  if (!isManaged(p)) {
    return { decision: 'none' };
  }
  const v = evaluatePermission({ deny: p.permissions.deny, ask: p.permissions.ask, allow: [], additionalDirectories: [] }, toolName, args, { root });
  if (v.decision === 'deny' || v.decision === 'ask') {
    return { decision: v.decision, reason: `rule \`${v.rule}\` in ${by(p)}` };
  }
  return { decision: 'none' };
}

/** The approval mode after the floor: a policy `ask` turns "always" into "ask", `never` refuses outright. */
export function flooredApproval<M extends string>(p: ManagedPolicy, kind: ApprovalKind, mode: M): M | 'ask' | 'never' {
  const floor = p.approvals[kind];
  if (floor === 'never') {
    return 'never';
  }
  if (floor === 'ask' && mode === 'always') {
    return 'ask';
  }
  return mode;
}

/**
 * A server's MCP autoApprove list turns an "ask" into "always", but only for the plain category prompt: never when the
 * prompt is mandatory or the organisation set an approval floor for the kind.
 */
export function autoApprovedMode<M extends string>(p: ManagedPolicy, kind: ApprovalKind, mode: M, opts?: { autoApprove?: boolean; mandatory?: boolean }): M | 'always' {
  return opts?.autoApprove && kind === 'mcp' && mode === 'ask' && !opts.mandatory && !p.approvals[kind] ? 'always' : mode;
}

/** Whether a provider at `baseUrl` may be used. */
export function providerAllowed(p: ManagedPolicy, baseUrl: string, cloud: boolean): { ok: boolean; reason?: string } {
  if (!isManaged(p)) {
    return { ok: true };
  }
  if (cloud && !p.allowCloudProviders) {
    return { ok: false, reason: `cloud providers are disabled by ${by(p)}` };
  }
  if (p.allowedProviderHosts) {
    let host = '';
    try {
      host = new URL(baseUrl).hostname.toLowerCase();
    } catch {
      /* invalid URL: not allowed */
    }
    const ok = p.allowedProviderHosts.some((h) => {
      const pat = h.toLowerCase();
      return pat.startsWith('*.') ? host === pat.slice(2) || host.endsWith(pat.slice(1)) : host === pat;
    });
    if (!ok) {
      return { ok: false, reason: `${host || baseUrl} is not on the provider allowlist in ${by(p)}` };
    }
  }
  return { ok: true };
}

/** Tools that reach the internet: switched off by the policy's `allowWebAccess` or `localpilot.webSearch.enabled`. */
export const WEB_TOOLS = /^(web_search|web_fetch|browser_\w+|open_browser)$/;
/** Whether a tool is available under the policy (web access, MCP allowlist for `mcp__<server>__…` tools). */
export function toolAllowed(p: ManagedPolicy, name: string): boolean {
  if (!isManaged(p)) {
    return true;
  }
  if (!p.allowWebAccess && WEB_TOOLS.test(name)) {
    return false;
  }
  return true;
}

/** What decides whether an MCP server may start: its name, where it came from and what it points at. */
export interface McpServerRef {
  source?: string;
  url?: string;
  command?: string;
  type?: string;
}

const sameUrl = (a: string, b: string) => {
  const norm = (u: string) => {
    try {
      const x = new URL(u.trim());
      return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`;
    } catch {
      return u.trim().replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
};
/** A command pinned by the policy matches the configured one exactly or by program name (`npx` = `/usr/local/bin/npx`). */
const sameCommand = (pinned: string, cmd: string) => pinned === cmd || (!/[\\/]/.test(pinned) && path.basename(cmd).replace(/\.(exe|cmd|bat)$/i, '') === pinned);

/** URLs the policy itself names: its own servers and the allowlist's pinned URLs. */
export function policyMcpUrls(p: ManagedPolicy): string[] {
  return [...Object.values(p.mcpServers ?? {}).map((c) => str(c.url)), ...(p.allowedMcpServers ?? []).map((a) => a.url)].filter((u): u is string => !!u);
}

/** Why the policy keeps an MCP server from starting, or undefined when it may. Servers the policy itself provides always may. */
export function mcpServerBlocked(p: ManagedPolicy, name: string, cfg?: McpServerRef): string | undefined {
  if (!isManaged(p) || cfg?.source === 'managed') {
    return undefined;
  }
  const remote = !!cfg && (!!cfg.url || (!!cfg.type && cfg.type !== 'stdio')) && !cfg.command;
  if (remote && p.blockPersonalRemoteMcp && !(cfg.url && policyMcpUrls(p).some((u) => sameUrl(u, cfg.url!)))) {
    return `remote MCP servers outside ${by(p)} are blocked`;
  }
  if (!p.allowedMcpServers) {
    return undefined;
  }
  const entries = p.allowedMcpServers.filter((a) => a.name === name);
  if (!entries.length) {
    return `not on the MCP server allowlist in ${by(p)}`;
  }
  if (!cfg) {
    return undefined;
  }
  const ok = entries.some((a) => (!a.url || (!!cfg.url && sameUrl(a.url, cfg.url))) && (!a.command || (!!cfg.command && sameCommand(a.command, cfg.command))));
  return ok ? undefined : `"${name}" points at ${cfg.url ?? cfg.command ?? 'another server'}, not the one allowed by ${by(p)}`;
}

export function mcpServerAllowed(p: ManagedPolicy, name: string, cfg?: McpServerRef): boolean {
  return !mcpServerBlocked(p, name, cfg);
}

/** The organisation's MCP servers, and which of them users cannot switch off. */
export function managedMcpServers(p: ManagedPolicy): { servers: Record<string, Record<string, unknown>>; alwaysEnabled: string[] } {
  if (!isManaged(p) || !p.mcpServers) {
    return { servers: {}, alwaysEnabled: [] };
  }
  const servers: Record<string, Record<string, unknown>> = {};
  const alwaysEnabled: string[] = [];
  for (const [name, c] of Object.entries(p.mcpServers)) {
    const { alwaysEnabled: always, ...rest } = c;
    servers[name] = always === true ? { ...rest, enabled: true } : rest;
    if (always === true) {
      alwaysEnabled.push(name);
    }
  }
  return { servers, alwaysEnabled };
}

/** The provider list in effect: the organisation's providers first (only the user's key is taken from a same-id entry), then the user's others. */
export function mergeManagedProviders(user: ProviderConfig[], p: ManagedPolicy): ProviderConfig[] {
  if (!isManaged(p) || !p.providers?.length) {
    return user;
  }
  const managed = p.providers.map((m) => {
    const own = user.find((u) => u.id === m.id)?.apiKey;
    return own ? { ...m, apiKey: own } : { ...m };
  });
  const ids = new Set(managed.map((m) => m.id));
  return [...managed, ...user.filter((u) => !ids.has(u.id))];
}

/** Whether `cfg` is one of the organisation's providers as it configured it (exempt from the provider host and cloud limits). */
export function isManagedProvider(p: ManagedPolicy, cfg: Pick<ProviderConfig, 'id' | 'baseUrl'>): boolean {
  return isManaged(p) && !!p.providers?.some((m) => m.id === cfg.id && m.baseUrl === cfg.baseUrl);
}

const modelGlob = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
/** Whether a `provider/model` id is on the policy's model allowlist (globs; no allowlist = every model). */
export function modelAllowed(p: ManagedPolicy, id: string): boolean {
  return !isManaged(p) || !p.allowedModels || p.allowedModels.some((g) => modelGlob(g).test(id));
}

const orgOtlp = (t: TelemetryPolicy | undefined) => (t?.otlp && t.otlp.enabled !== false && t.otlp.endpoint ? t.otlp : undefined);

/** The user's telemetry settings after the organisation's `telemetry` policy: its collector wins, the user's export only when allowed. */
export function policyTelemetry<T extends { enabled: boolean; otlp: OtlpSettings }>(p: ManagedPolicy, telemetry: T): T {
  const t = isManaged(p) ? p.telemetry : undefined;
  if (!t) {
    return telemetry;
  }
  const org = orgOtlp(t);
  const otlp: OtlpSettings = org
    ? { enabled: true, endpoint: org.endpoint!, headers: org.headers ?? {}, metricsInterval: org.metricsInterval ?? 60, exporters: org.exporters?.length ? org.exporters : ['otlp'], traceSamplePercent: org.traceSamplePercent ?? 100, recordContent: org.recordContent === true, managed: true }
    : { ...telemetry.otlp, enabled: t.allowRemoteExport && telemetry.otlp.enabled };
  return { ...telemetry, enabled: t.enabled ?? (org ? true : telemetry.enabled), otlp };
}

/** Redis telemetry storage sends data off the process: off under a telemetry policy unless it allows remote export. */
export function policyRedis<R extends { enabled: boolean }>(p: ManagedPolicy, redis: R): R {
  const t = isManaged(p) ? p.telemetry : undefined;
  return t && !t.allowRemoteExport ? { ...redis, enabled: false } : redis;
}

/** Where the organisation's rules, skills and commands live: next to the policy file. */
export function managedDir(kind: 'rules' | 'skills' | 'commands', policyFile = managedPolicyPath()): string {
  return path.join(path.dirname(policyFile), kind);
}

/** `alwaysEnabled: true` front matter: the item cannot be switched off. */
export const alwaysEnabled = (meta: Record<string, unknown>) => meta.alwaysEnabled === true || (typeof meta.alwaysEnabled === 'string' && /^(true|yes)$/i.test(meta.alwaysEnabled.trim()));

/** The policy per Settings control, so the Settings page can lock exactly what the policy decides. */
export interface PolicyLocks {
  /** Setting key → the reason it cannot be changed. */
  locked: Record<string, string>;
  /** Approval values the floor leaves out, per approval setting (`approvals.terminal` → ['always']). */
  disabledOptions: Record<string, string[]>;
  approvals: ManagedPolicy['approvals'];
  allowCloudProviders: boolean;
  allowedProviderHosts?: string[];
  /** The organisation's providers (keys left out): shown locked, users fill in the key. */
  providers: ProviderConfig[];
  allowedModels?: string[];
  allowedMcpServers?: McpAllowEntry[];
  blockPersonalRemoteMcp: boolean;
  /** Names of the organisation's MCP servers, and those users cannot switch off. */
  mcpServers: string[];
  mcpAlwaysEnabled: string[];
  /** Where the organisation's collector is, when it exports regardless of the user's settings. */
  telemetryEndpoint?: string;
}

export function policyLocks(p: ManagedPolicy): PolicyLocks | undefined {
  if (!isManaged(p)) {
    return undefined;
  }
  const locked: Record<string, string> = {};
  const disabledOptions: Record<string, string[]> = {};
  for (const [k, floor] of Object.entries(p.approvals)) {
    if (floor === 'never') {
      locked[`approvals.${k}`] = 'Always blocked by your organization';
    } else if (floor === 'ask') {
      disabledOptions[`approvals.${k}`] = ['always'];
    }
  }
  if (p.disableBypassPermissions) {
    locked['autoMode.enabled'] = 'Auto mode is off by your organization';
  }
  if (!p.allowWebAccess) {
    locked['webSearch.enabled'] = 'Web access is off by your organization';
  }
  if (!p.allowSkillInstall) {
    locked['skills.autoInstall'] = 'Skill downloads are off by your organization';
  }
  const t = p.telemetry;
  const org = orgOtlp(t)?.endpoint;
  if (t) {
    if (t.enabled !== undefined || org) {
      locked['telemetry.enabled'] = org && t.enabled === undefined ? `Your organization exports telemetry to ${org}` : 'Set by your organization';
    }
    if (org || !t.allowRemoteExport) {
      for (const k of ['telemetry.otlp.enabled', 'telemetry.otlp.endpoint', 'telemetry.otlp.headers', 'telemetry.otlp.exporters', 'telemetry.otlp.traceSamplePercent', 'telemetry.otlp.recordContent', 'telemetry.otlp.metricsInterval']) {
        locked[k] = org ? `Your organization exports telemetry to ${org}` : 'Telemetry export is off by your organization';
      }
    }
    if (!t.allowRemoteExport) {
      locked['storage.redis.enabled'] = 'Telemetry export is off by your organization';
    }
  }
  const mcp = managedMcpServers(p);
  return {
    locked,
    disabledOptions,
    approvals: p.approvals,
    allowCloudProviders: p.allowCloudProviders,
    allowedProviderHosts: p.allowedProviderHosts,
    providers: (p.providers ?? []).map(({ apiKey: _key, ...rest }) => rest),
    allowedModels: p.allowedModels,
    allowedMcpServers: p.allowedMcpServers,
    blockPersonalRemoteMcp: p.blockPersonalRemoteMcp,
    mcpServers: Object.keys(mcp.servers),
    mcpAlwaysEnabled: mcp.alwaysEnabled,
    telemetryEndpoint: org,
  };
}

/**
 * The value in effect for each setting the policy decides (locked, or held at an approval floor), so Settings shows
 * what applies rather than the user's stored value. `cfg` is getConfig() output, which already has the policy applied.
 */
export function policyEffectiveValues(
  p: ManagedPolicy,
  cfg: { approvals: Record<ApprovalKind, string>; telemetry: { enabled: boolean; otlp: OtlpSettings }; storage: { redis: { enabled: boolean } } },
): Record<string, unknown> {
  const locks = policyLocks(p);
  if (!locks) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, mode] of Object.entries(cfg.approvals) as [ApprovalKind, string][]) {
    const eff = flooredApproval(p, k, mode);
    if (locks.locked[`approvals.${k}`] || eff !== mode) {
      out[`approvals.${k}`] = eff;
    }
  }
  const fixed: Record<string, unknown> = {
    'autoMode.enabled': false,
    'webSearch.enabled': false,
    'skills.autoInstall': 'off',
    'telemetry.enabled': cfg.telemetry.enabled,
    'storage.redis.enabled': cfg.storage.redis.enabled,
  };
  for (const key of Object.keys(locks.locked)) {
    if (key in fixed) {
      out[key] = fixed[key];
    } else if (key.startsWith('telemetry.otlp.') && key !== 'telemetry.otlp.headers') {
      // Headers can carry the organisation's collector credentials: never echoed to the webview.
      out[key] = cfg.telemetry.otlp[key.slice('telemetry.otlp.'.length) as keyof OtlpSettings];
    }
  }
  return out;
}

/** One line per restriction, for `/permissions`, `localpilot doctor` and the Settings banner. */
export function describePolicy(p: ManagedPolicy): string[] {
  if (!isManaged(p)) {
    return [];
  }
  const out: string[] = [];
  if (p.permissions.deny.length) {
    out.push(`Always blocked: ${p.permissions.deny.join(', ')}`);
  }
  if (p.permissions.ask.length) {
    out.push(`Always asks: ${p.permissions.ask.join(', ')}`);
  }
  const floors = Object.entries(p.approvals).map(([k, v]) => `${k} ${v === 'never' ? 'refused' : 'needs approval'}`);
  if (floors.length) {
    out.push(`Approvals: ${floors.join(', ')}`);
  }
  if (p.disableBypassPermissions) {
    out.push('Bypass modes and Auto mode are off');
  }
  if (!p.allowCloudProviders) {
    out.push('Cloud providers are off');
  }
  if (p.allowedProviderHosts) {
    out.push(`Provider hosts allowed: ${p.allowedProviderHosts.join(', ') || 'none'}`);
  }
  if (!p.allowWebAccess) {
    out.push('Web search, web fetch and the browser are off');
  }
  if (p.allowedMcpServers) {
    out.push(`MCP servers allowed: ${p.allowedMcpServers.map((a) => (a.url || a.command ? `${a.name} (${a.url ?? a.command})` : a.name)).join(', ') || 'none'}`);
  }
  if (p.mcpServers && Object.keys(p.mcpServers).length) {
    out.push(`MCP servers provided: ${Object.keys(p.mcpServers).join(', ')}`);
  }
  if (p.blockPersonalRemoteMcp) {
    out.push('Remote MCP servers not listed by the organization are blocked');
  }
  if (p.providers?.length) {
    out.push(`Providers provided: ${p.providers.map((x) => x.displayName ?? x.id).join(', ')}`);
  }
  if (p.allowedModels) {
    out.push(`Models allowed: ${p.allowedModels.join(', ') || 'none'}`);
  }
  if (p.telemetry) {
    const org = p.telemetry.otlp && p.telemetry.otlp.enabled !== false ? p.telemetry.otlp.endpoint : undefined;
    out.push(`Telemetry: ${p.telemetry.enabled === false ? 'recording off' : p.telemetry.enabled ? 'recording on' : 'recording as you set it'}${org ? `, exported to ${org}` : ''}${p.telemetry.allowRemoteExport ? '' : ', your own export (OTLP, Redis) is off'}`);
  }
  if (!p.allowSkillInstall) {
    out.push('Skill downloads are off');
  }
  if (p.auditLog) {
    out.push(`Tool calls are logged to ${p.auditLog}`);
  }
  return out;
}

/** Expands `~` and `${workspaceFolder}` in the audit path. */
export function auditPath(p: ManagedPolicy, root?: string): string | undefined {
  if (!p.auditLog) {
    return undefined;
  }
  return p.auditLog.replace(/^~(?=[\\/]|$)/, os.homedir()).replace(/\$\{workspaceFolder\}/g, root ?? process.cwd());
}

/** Appends one audit record (JSON Lines). Best effort: an unwritable log is reported once, never blocks the agent. */
let auditWarned = false;
export function audit(p: ManagedPolicy, record: Record<string, unknown>, root?: string, log?: { warn(m: string): void }): void {
  const file = auditPath(p, root);
  if (!file) {
    return;
  }
  const line = `${JSON.stringify({ ts: new Date().toISOString(), user: safeUser(), host: os.hostname(), workspace: root, ...record })}\n`;
  fs.promises
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.promises.appendFile(file, line, 'utf8'))
    .catch((e) => {
      if (!auditWarned) {
        auditWarned = true;
        log?.warn(`audit log ${file} is not writable: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
}

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}
