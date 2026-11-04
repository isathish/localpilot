import * as vscode from 'vscode';
import { getConfig } from '../../config';
import { ContextManager, effectiveContextWindow, tokenCalibration } from '../../context/contextManager';
import { WorkspaceContext } from '../../context/workspaceContext';
import { MemoryStore } from '../../agent/memory';
import { SkillManager } from '../../agent/skills';
import { PluginInfo } from '../../agent/plugins';
import { describePlugin } from '../../agent/pluginInstaller';
import { contextPercent, contextReport, memoryReport } from '../../agent/reports';
import { McpManager } from '../../mcp/mcpManager';
import { ProviderRegistry } from '../../providers/registry';
import { SessionStore } from '../../sessions/sessionStore';
import { archiveCompaction } from '../../sessions/transcriptArchive';
import { Session } from '../../types';
import { Style } from '../providers';
import { parseSettingValue, settingKey, settingsRows } from '../settingsView';
import { cliOverrides, effectiveSettings, isAutoApprove, setAutoApprove, CLI_SETTINGS_PATH } from '../vscodeShim';

export interface InfoSlashContext {
  session: () => Session;
  store: SessionStore;
  providers: ProviderRegistry;
  skills: SkillManager;
  memory: MemoryStore;
  workspace: WorkspaceContext;
  plugins: PluginInfo[];
  mcp?: McpManager;
  style: Style;
  /** Markdown → terminal text. */
  md: (s: string) => string;
  /** Progress on the status line ('' clears it). */
  status: (s: string) => void;
  /** Auto-approve was switched: redraw the prompt (it shows `[auto]`). */
  onAutoApprove?: () => void;
  out?: NodeJS.WritableStream;
}

/**
 * `/compact`, `/skills`, `/agents`, `/mcp`, `/memory`, `/context`, `/yes`, `/settings` and `/plugins`
 * in the REPL. Returns false for any other command.
 */
export async function infoSlash(cmd: string, arg: string, ctx: InfoSlashContext): Promise<boolean> {
  const st = ctx.style;
  const out = ctx.out ?? process.stdout;
  const say = (t: string) => out.write(`${t}\n`);
  const session = ctx.session();
  switch (cmd) {
    case 'compact':
    case 'smol': {
      const { provider, model: picked } = await ctx.providers.resolve(session.model);
      const model = { ...picked, contextWindow: effectiveContextWindow(picked, getConfig().contextWindow) };
      const cm = new ContextManager({ compactionThreshold: 0, maxToolOutputChars: getConfig().maxToolOutputChars, keepAlive: getConfig().keepAlive || undefined, scale: () => tokenCalibration.scale(model.id), strategy: getConfig().compactionStrategy === 'basic' ? 'basic' : 'agentic' });
      if (session.messages.length > 6 && cm.strategy !== 'basic') {
        ctx.status(`Compacting with ${model.name}…`);
      }
      try {
        // A compaction the user asked for never drops history on failure; a stalled server gives up after 3 minutes.
        const res = await cm.compact(session.messages, provider, model, AbortSignal.timeout(180_000), 4, false);
        if (res.removed > 0) {
          archiveCompaction(ctx.store, session.id, session.compactions, session.messages, res.messages);
          session.messages = res.messages;
          session.compactions++;
          session.contextTokens = Math.max(0, session.contextTokens - (res.before - res.after));
          ctx.store.save(session);
        }
        ctx.status('');
        say(res.removed > 0 ? st.dim(`compacted ${res.removed} messages: ${res.before.toLocaleString()} → ${res.after.toLocaleString()} tokens`) : st.dim('nothing to compact yet — the conversation is still short'));
      } catch (e) {
        ctx.status('');
        say(st.red(`could not compact — the conversation was left as it was (${e instanceof Error ? e.message : String(e)})`));
      }
      return true;
    }
    case 'skills': {
      const all = ctx.skills.allSkills;
      say(all.length ? all.map((s) => `  ${s.disabled ? st.dim('○') : st.green('●')} ${st.bold(s.name)} ${st.dim(`(${s.source}${s.disabled ? ', disabled' : ''})`)}  ${s.description.replace(/\s+/g, ' ').slice(0, 120)}\n    ${st.dim(s.path)}`).join('\n') : st.dim('no skills — add folders with SKILL.md under .localpilot/skills/, or: localpilot skill search <words>'));
      return true;
    }
    case 'agents': {
      const all = ctx.skills.allAgents;
      say(all.length ? all.map((a) => `  ${st.bold(a.name)} ${st.dim(`(${a.source}${a.model ? `, ${a.model}` : ''})`)}  ${a.description.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n') : st.dim('no subagents'));
      say(st.dim('/agent <name> <task> hands a task to one'));
      return true;
    }
    case 'mcp':
      await mcpSlash(arg, ctx, say);
      return true;
    case 'memory': {
      const [files, notes] = await Promise.all([ctx.workspace.instructionFiles(), ctx.memory.list().catch(() => [])]);
      say(ctx.md(memoryReport(files, notes, getConfig().memoryEnabled, 'cli')));
      return true;
    }
    case 'context': {
      const win = ctx.providers.cachedModels().find((m) => m.id === (session.model || getConfig().defaultModel));
      const eff = win ? effectiveContextWindow(win, getConfig().contextWindow) : undefined;
      const pct = contextPercent(session.contextTokens, eff);
      say(ctx.md(`${contextReport(session, win, eff)}${pct !== undefined ? ` · ${pct}% used` : ''}`));
      return true;
    }
    case 'yes':
    case 'auto': {
      const v = arg.toLowerCase();
      if (!['on', 'off', ''].includes(v)) {
        say(st.dim('usage: /yes on|off'));
        return true;
      }
      setAutoApprove(v ? v === 'on' : !isAutoApprove());
      ctx.onAutoApprove?.();
      say(isAutoApprove() ? st.yellow('auto-approve on: commands, edits and network calls run without asking (except what your organization requires)') : st.dim('auto-approve off: you are asked again'));
      return true;
    }
    case 'settings':
      await settingsSlash(arg, ctx, say);
      return true;
    case 'plugins': {
      if (!ctx.plugins.length) {
        say(st.dim('no plugins installed — localpilot plugin search <words>'));
        return true;
      }
      say(ctx.plugins.map((p) => `  ${p.enabled ? st.green('●') : st.dim('○')} ${st.bold(p.name)} ${st.dim(`${p.version ?? ''} · ${p.source} · ${p.root}`)}\n    ${describePlugin(p).summary.replace(/^[^:]*: /, '')}${p.enabled ? '' : st.dim(' (disabled)')}`).join('\n'));
      return true;
    }
    default:
      return false;
  }
}

/** `/mcp` lists the servers; `/mcp enable|disable|restart <name> [--save]` (enable/disable last for this session unless --save). */
async function mcpSlash(arg: string, ctx: InfoSlashContext, say: (t: string) => void): Promise<void> {
  const st = ctx.style;
  const words = arg.split(/\s+/).filter(Boolean);
  const save = words.includes('--save');
  const [action, name] = words.filter((w) => w !== '--save');
  const mcp = ctx.mcp;
  if (!mcp) {
    say(st.dim('no MCP servers are running (none configured, or started with --no-mcp)'));
    return;
  }
  if (!action || action === 'list') {
    const list = mcp.status;
    if (!list.length) {
      say(st.dim('no MCP servers configured'));
      return;
    }
    for (const s of list) {
      const dot = s.state === 'connected' ? st.green('●') : s.state === 'disabled' ? st.dim('○') : s.state === 'error' ? st.red('●') : st.yellow('●');
      say(`  ${dot} ${st.bold(s.name)} ${st.dim(`${s.state}${s.transport ? ` · ${s.transport}` : ''}${s.source ? ` · ${s.source}` : ''} · ${s.tools} tool${s.tools === 1 ? '' : 's'}`)}`);
      if (s.error) {
        say(`    ${st.red(s.error)}`);
      }
      if (s.toolList?.length) {
        say(`    ${st.dim(s.toolList.map((t) => t.name).join(', '))}`);
      }
      if (s.prompts?.length) {
        say(`    ${st.dim(`prompts: ${s.prompts.map((p) => `/mcp:${s.name}:${p.name}`).join(', ')}`)}`);
      }
    }
    say(st.dim('/mcp enable|disable|restart <name> [--save]'));
    return;
  }
  if (!['enable', 'disable', 'restart'].includes(action) || !name) {
    say(st.dim('usage: /mcp [list] · /mcp enable|disable|restart <name> [--save]'));
    return;
  }
  if (!mcp.status.some((s) => s.name === name)) {
    say(st.red(`no MCP server "${name}" — /mcp lists them`));
    return;
  }
  try {
    if (action === 'restart') {
      if (mcp.status.find((s) => s.name === name)?.state === 'disabled') {
        say(st.dim(`${name} is switched off — /mcp enable ${name}`));
        return;
      }
      ctx.status(`Restarting ${name}…`);
      const up = await mcp.restart(name);
      ctx.status('');
      say(up ? st.green(`${name} restarted`) : st.red(`${name} did not start: ${mcp.status.find((s) => s.name === name)?.error ?? 'unknown error'}`));
      return;
    }
    const on = action === 'enable';
    ctx.status(`${on ? 'Starting' : 'Stopping'} ${name}…`);
    // Both, so a server switched off for the session and then enabled with --save really runs again.
    await mcp.setSessionEnabled(name, on);
    if (save) {
      await mcp.setEnabled(name, on);
    }
    ctx.status('');
    const s = mcp.status.find((x) => x.name === name);
    const scope = save ? st.dim(' (saved)') : st.dim(' for this session (add --save to keep it)');
    if (!on) {
      say(s && s.state !== 'disabled' ? st.red(`${name} is still ${s.state}`) : `${st.yellow(`${name} disabled`)}${scope}`);
    } else if (s?.state === 'connected') {
      say(`${st.green(`${name} enabled`)}${scope} ${st.dim(`· ${s.tools} tool${s.tools === 1 ? '' : 's'}`)}`);
    } else {
      say(`${st.yellow(`${name} enabled but not running (${s?.state ?? 'unknown'})`)}${scope}${s?.error ? `\n  ${st.red(s.error)}` : ''}`);
    }
  } catch (e) {
    ctx.status('');
    say(st.red(e instanceof Error ? e.message : String(e)));
  }
}

/** `/settings [filter]` prints the effective settings; `/settings set <key> <value>` and `/settings unset <key>` write ~/.localpilot/config.json. */
async function settingsSlash(arg: string, ctx: InfoSlashContext, say: (t: string) => void): Promise<void> {
  const st = ctx.style;
  const m = /^(set|unset)\s+(\S+)\s*([\s\S]*)$/.exec(arg.trim());
  if (!m) {
    const rows = settingsRows(effectiveSettings(), arg);
    say(rows.length ? rows.map((r) => `  ${r.replace(/^([^=]+)=/, (_, k: string) => `${st.cyan(k)}=`)}`).join('\n') : st.dim(arg ? `no setting matches "${arg}"` : 'no settings set — every option has its default'));
    say(st.dim(`VS Code user settings < .vscode/settings.json < ${CLI_SETTINGS_PATH} < flags. /settings set <key> <value> writes ${CLI_SETTINGS_PATH}`));
    return;
  }
  const key = settingKey(m[2]);
  if (!key) {
    say(st.red(`"${m[2]}" is not a setting key (e.g. thinking, compaction.strategy, approvals.terminal)`));
    return;
  }
  if (m[1] === 'set' && !m[3].trim()) {
    say(st.dim('usage: /settings set <key> <value>'));
    return;
  }
  const value = m[1] === 'set' ? parseSettingValue(m[3]) : undefined;
  try {
    await vscode.workspace.getConfiguration('localpilot').update(key, value, vscode.ConfigurationTarget.Global);
  } catch (e) {
    say(st.red(e instanceof Error ? e.message : String(e)));
    return;
  }
  say(st.dim(value === undefined ? `${key} removed from ${CLI_SETTINGS_PATH}` : `${key} = ${JSON.stringify(value)} saved to ${CLI_SETTINGS_PATH}`));
  if (key in cliOverrides) {
    say(st.yellow(`a command-line flag sets ${key} for this run; the saved value applies from the next one`));
  }
}
