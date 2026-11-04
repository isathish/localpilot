import { getConfig } from '../config';
import { collectInstructionFiles } from '../context/instructions';
import { discoverCommands } from '../agent/commands';
import { discoverHookScripts } from '../agent/hookScripts';
import { describePolicy, getManagedPolicy, managedPolicyPath, toolAllowed } from '../agent/managedPolicy';
import { PluginInfo, pluginSource } from '../agent/plugins';
import { ProjectSettings } from '../agent/settings';
import { SkillManager } from '../agent/skills';
import { toolDisabled } from '../agent/toolAliases';
import { McpManager } from '../mcp/mcpManager';
import { isCloudProvider, keyStatus } from '../providers/cloud';
import { probeProvider } from '../providers/discovery';
import { ToolRegistry } from '../tools/registry';
import { configured, Style } from './providers';

export const CONFIG_KINDS = ['rules', 'skills', 'agents', 'commands', 'hooks', 'mcp', 'tools', 'plugins'] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

/** One row of `localpilot config <kind>`: what it is, where it comes from, and whether it is in force. */
export interface ConfigItem {
  name: string;
  /** workspace, user, builtin, plugin, settings, mcp… */
  source: string;
  path?: string;
  enabled: boolean;
  description?: string;
  /** Tools: the approval they need (`none` for read-only ones). */
  approval?: string;
  /** Anything else worth showing (hook event, MCP state, rule globs…). */
  detail?: string;
}

/** What the listings read: the same objects the agent runs with. */
export interface ConfigSources {
  roots: string[];
  skills: SkillManager;
  settings: ProjectSettings;
  hookDirs?: string[];
  plugins: PluginInfo[];
  tools: ToolRegistry;
  mcp?: McpManager;
}

export async function configItems(kind: ConfigKind, src: ConfigSources): Promise<ConfigItem[]> {
  switch (kind) {
    case 'rules':
      return (await collectInstructionFiles(src.roots, undefined, { includeDisabled: true })).map((f) => ({
        name: f.label,
        source: f.scope,
        path: f.file,
        enabled: !f.disabled,
        ...(f.paths ? { detail: `conditional: ${f.paths.length ? f.paths.join(', ') : 'never'}` } : {}),
      }));
    case 'skills':
      return src.skills.allSkills.map((s) => ({ name: s.name, source: s.source, path: s.path, enabled: !s.disabled, description: s.description }));
    case 'agents':
      return src.skills.allAgents.map((a) => ({ name: a.name, source: a.source, enabled: true, description: a.description, ...(a.model || a.tools ? { detail: [a.model ? `model ${a.model}` : '', a.tools ? `tools ${a.tools.join(', ')}` : ''].filter(Boolean).join(' · ') } : {}) }));
    case 'commands':
      return (await discoverCommands(src.roots, { plugins: pluginSource(src.plugins), includeDisabled: true })).map((c) => ({ name: c.invoke, source: c.plugin ? `plugin ${c.plugin}` : c.source, path: c.file, enabled: !c.disabled, description: c.description }));
    case 'hooks': {
      const on = getConfig().hooksEnabled;
      const scripts = await discoverHookScripts(src.roots, { extraDirs: src.hookDirs });
      const fromScripts = new Set(scripts.map((s) => s.command));
      const configured = Object.entries(src.settings.hooks).flatMap(([event, matchers]) => (matchers ?? []).flatMap((m) => m.hooks.filter((h) => !fromScripts.has(h.command)).map((h) => ({
        name: h.name ?? h.command,
        source: h.pluginRoot ? 'plugin' : 'settings',
        ...(h.pluginRoot ? { path: h.pluginRoot } : {}),
        enabled: on,
        detail: `${event}${m.matcher ? ` (${m.matcher})` : ''}: ${h.command}`,
      }))));
      const files = scripts.map((s) => ({ name: s.name, source: s.scope, path: s.file, enabled: on && s.enabled && !!s.event, detail: s.event ? `${s.event}${s.matcher ? ` (${s.matcher})` : ''}${s.enabled ? '' : ' — not executable'}` : 'not an event name (never run)' }));
      return [...configured, ...files];
    }
    case 'mcp':
      return (src.mcp?.status ?? []).map((s) => ({
        name: s.name,
        source: s.source ?? 'settings',
        enabled: s.state !== 'disabled',
        detail: `${s.state}${s.transport ? ` · ${s.transport}` : ''} · ${s.tools} tool${s.tools === 1 ? '' : 's'}${s.error ? ` · ${s.error}` : ''}`,
      }));
    case 'tools': {
      const disabled = getConfig().disabledTools;
      const policy = getManagedPolicy();
      return src.tools.list().map((t) => ({
        name: t.definition.name,
        source: t.definition.name.startsWith('mcp_') ? 'mcp' : 'builtin',
        enabled: !toolDisabled(t.definition.name, disabled) && toolAllowed(policy, t.definition.name),
        approval: t.approvalKind ?? 'none',
        description: t.definition.description.split('\n')[0].slice(0, 160),
      })).sort((a, b) => a.name.localeCompare(b.name));
    }
    case 'plugins':
      return src.plugins.map((p) => ({ name: p.name, source: p.source, path: p.root, enabled: p.enabled, description: p.description, ...(p.version ? { detail: `v${p.version}` } : {}) }));
  }
}

/** Every kind at once (`localpilot config --json` with no kind). */
export async function allConfigItems(src: ConfigSources): Promise<Record<ConfigKind, ConfigItem[]>> {
  const out = {} as Record<ConfigKind, ConfigItem[]>;
  for (const k of CONFIG_KINDS) {
    out[k] = await configItems(k, src);
  }
  return out;
}

export function formatConfigItems(kind: ConfigKind, items: readonly ConfigItem[], st: Style): string {
  if (!items.length) {
    return st.dim(`  no ${kind}`);
  }
  return items.map((i) => {
    const head = `  ${i.enabled ? st.green('●') : st.dim('○')} ${st.bold(i.name)} ${st.dim(`(${i.source}${i.approval ? `, approval: ${i.approval}` : ''}${i.enabled ? '' : ', off'})`)}`;
    const desc = i.description ? `  ${i.description.replace(/\s+/g, ' ').slice(0, 100)}` : '';
    const more = [i.detail, i.path].filter(Boolean).map((l) => `\n    ${st.dim(String(l))}`).join('');
    return `${head}${desc}${more}`;
  }).join('\n');
}

/** `localpilot config [kind] [--json]`; exit code 2 for an unknown kind. */
export async function cmdConfig(kind: string, json: boolean, src: ConfigSources, st: Style, out: (s: string) => void = console.log): Promise<number> {
  if (kind && !(CONFIG_KINDS as readonly string[]).includes(kind)) {
    out(`${st.red('✖')} Unknown: config ${kind}. Use one of: ${CONFIG_KINDS.join(', ')}`);
    return 2;
  }
  if (json) {
    out(JSON.stringify(kind ? await configItems(kind as ConfigKind, src) : await allConfigItems(src), null, 2));
    return 0;
  }
  for (const k of kind ? [kind as ConfigKind] : CONFIG_KINDS) {
    const items = await configItems(k, src);
    out(`${st.bold(k[0].toUpperCase() + k.slice(1))} ${st.dim(`(${items.length})`)}\n${formatConfigItems(k, items, st)}\n`);
  }
  return 0;
}

/** Providers as `doctor --json` reports them: reachability and key state, never the key. */
export async function providerReport(): Promise<Record<string, unknown>[]> {
  return Promise.all(configured().map(async (p) => {
    const r = p.enabled === false ? undefined : await probeProvider(p, true);
    const k = keyStatus(p);
    return { id: p.id, name: p.displayName || p.id, type: p.type, baseUrl: p.baseUrl, cloud: isCloudProvider(p), enabled: p.enabled !== false, reachable: !!r?.ok, latencyMs: r?.ok ? r.latencyMs : undefined, models: r?.models.length ?? 0, error: r && !r.ok ? r.error : undefined, key: { source: k.source, ok: k.ok, ...(k.env ? { env: k.env } : {}) } };
  }));
}

/** The machine-readable part of `doctor` that does not depend on the CLI's process state. */
export async function doctorReport(src: ConfigSources): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  const org = getManagedPolicy();
  return {
    defaultModel: cfg.defaultModel || null,
    approvals: cfg.approvals,
    policy: org.source ? { source: org.source, message: org.message, rules: describePolicy(org) } : { source: null, path: managedPolicyPath() },
    providers: await providerReport(),
    workspace: src.roots[0] ?? null,
    skills: src.skills.allSkills.length,
    subagents: src.skills.allAgents.length,
    mcp: await configItems('mcp', src),
    hooksEnabled: cfg.hooksEnabled,
  };
}
