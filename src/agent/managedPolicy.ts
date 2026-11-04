import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseJsonc } from './settings';
import { evaluatePermission } from './permissions';

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
export type ApprovalKind = 'terminal' | 'write' | 'delete' | 'network';

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
  /** When set, only MCP servers with these names start. */
  allowedMcpServers?: string[];
  /** false: skills are never downloaded (catalog auto-install, `/skill install`). */
  allowSkillInstall: boolean;
  /** JSONL file every tool call and approval is appended to (`~` and `${workspaceFolder}` are expanded). */
  auditLog?: string;
  /** Shown to users wherever the policy blocks something, e.g. "Contact it-security@corp.example". */
  message?: string;
}

const NONE: ManagedPolicy = { permissions: { deny: [], ask: [], allow: [] }, approvals: {}, disableBypassPermissions: false, allowCloudProviders: true, allowWebAccess: true, allowSkillInstall: true };

export function managedPolicyPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string {
  const system = platform === 'darwin' ? '/Library/Application Support/LocalPilot/managed-settings.json' : platform === 'win32' ? path.win32.join(env.ProgramData ?? 'C:\\ProgramData', 'LocalPilot', 'managed-settings.json') : '/etc/localpilot/managed-settings.json';
  // The environment can point elsewhere only where no administrator deployed a policy: it must not replace one.
  return env.LOCALPILOT_MANAGED_SETTINGS && !exists(system) ? env.LOCALPILOT_MANAGED_SETTINGS : system;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);

/** Pure: a policy from parsed JSON. Unknown keys are ignored; anything malformed falls back to the permissive default for that key. */
export function normalizePolicy(raw: unknown, source?: string): ManagedPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const perm = (r.permissions && typeof r.permissions === 'object' ? r.permissions : {}) as Record<string, unknown>;
  const appr = (r.approvals && typeof r.approvals === 'object' ? r.approvals : {}) as Record<string, unknown>;
  const approvals: ManagedPolicy['approvals'] = {};
  for (const k of ['terminal', 'write', 'delete', 'network'] as ApprovalKind[]) {
    if (appr[k] === 'ask' || appr[k] === 'never') {
      approvals[k] = appr[k] as 'ask' | 'never';
    }
  }
  return {
    source,
    permissions: { deny: strings(perm.deny), ask: strings(perm.ask), allow: strings(perm.allow) },
    approvals,
    disableBypassPermissions: r.disableBypassPermissions === true,
    allowCloudProviders: r.allowCloudProviders !== false,
    allowedProviderHosts: Array.isArray(r.allowedProviderHosts) ? strings(r.allowedProviderHosts) : undefined,
    allowWebAccess: r.allowWebAccess !== false,
    allowedMcpServers: Array.isArray(r.allowedMcpServers) ? strings(r.allowedMcpServers) : undefined,
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
    log?.warn(`managed policy ${file} could not be read: ${e instanceof Error ? e.message : String(e)} — cloud providers, web access and skill downloads are blocked until it is fixed`);
    policy = { ...NONE, source: file, allowCloudProviders: false, allowWebAccess: false, allowSkillInstall: false, disableBypassPermissions: true, approvals: { terminal: 'ask', write: 'ask', delete: 'ask', network: 'ask' } };
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

const WEB_TOOLS = /^(web_search|web_fetch|browser_\w+|open_browser)$/;
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

export function mcpServerAllowed(p: ManagedPolicy, name: string): boolean {
  return !isManaged(p) || !p.allowedMcpServers || p.allowedMcpServers.includes(name);
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
    out.push(`MCP servers allowed: ${p.allowedMcpServers.join(', ') || 'none'}`);
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
