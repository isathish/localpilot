import * as vscode from 'vscode';
import { MemoryStore } from '../agent/memory';
import { SkillManager } from '../agent/skills';
import { DEFAULT_PROVIDERS, getConfig, McpServerConfig } from '../config';
import { McpManager } from '../mcp/mcpManager';
import { autoDetectProviders, ProbeResult, probeProvider, recommendModel } from '../providers/discovery';
import { ProviderRegistry } from '../providers/registry';
import { SessionStore } from '../sessions/sessionStore';
import { ModelInfo, ProviderConfig } from '../types';

export { probeProvider, recommendModel };
export type { ProbeResult };

export type SettingsPage = 'settings' | 'setup';
export type SettingsSection = 'providers' | 'models' | 'agent' | 'completions' | 'web' | 'memory' | 'mcp' | 'advanced';

/** One setting as shown in the UI: effective value plus where it comes from. */
interface SettingEntry {
  value: unknown;
  default: unknown;
  scope: 'default' | 'user' | 'workspace';
  userValue?: unknown;
  workspaceValue?: unknown;
}

type ToSettings =
  | { type: 'state'; page: SettingsPage; section?: SettingsSection; version: string; hasWorkspace: boolean; settings: Record<string, SettingEntry>; models: ModelInfo[]; skills: { name: string; description: string; source: string }[]; agents: { name: string; description: string; source: string }[]; mcp: { name: string; tools: number; error?: string }[]; memory: { project: number; global: number }; sessions: number; welcomed: boolean }
  | { type: 'probe'; results: ProbeResult[]; dockerModelRunner?: string }
  | { type: 'testResult'; id: string; result: ProbeResult }
  | { type: 'busy'; busy: boolean }
  | { type: 'toast'; level: 'info' | 'error'; text: string };

type FromSettings =
  | { type: 'ready' }
  | { type: 'set'; key: string; value: unknown; scope: 'user' | 'workspace' }
  | { type: 'reset'; key: string; scope: 'user' | 'workspace' }
  | { type: 'test'; provider: ProviderConfig }
  | { type: 'probe' }
  | { type: 'refreshModels' }
  | { type: 'command'; id: string; args?: unknown[] }
  | { type: 'finishSetup'; model?: string; approvals?: 'safe' | 'balanced' | 'autonomous'; inlineCompletion?: boolean; providers?: ProviderConfig[] }
  | { type: 'openExternal'; url: string };

/** Keys (relative to `localpilot.`) that the UI may read and write. Anything else is rejected. */
const SETTING_KEYS = [
  'providers', 'defaultModel', 'contextWindow', 'maxOutputTokens', 'temperature', 'thinking', 'keepAlive', 'compactionThreshold', 'maxToolOutputChars',
  'approvals.terminal', 'approvals.write', 'approvals.delete', 'approvals.network', 'parallel.maxConcurrency', 'parallel.maxSubagentDepth',
  'webSearch.provider', 'webSearch.searxngUrl', 'webSearch.apiKey', 'webSearch.maxResults',
  'inlineCompletion.enabled', 'inlineCompletion.model', 'inlineCompletion.debounceMs', 'inlineCompletion.maxTokens',
  'mcpServers', 'skillsPaths', 'memory.enabled', 'systemPromptAppend', 'showWelcomeOnStartup', 'terminal.runInIntegratedTerminal', 'terminal.reveal',
] as const;

/** Commands the webview is allowed to trigger. */
const ALLOWED_COMMANDS = new Set([
  'localpilot.openChat', 'localpilot.newSession', 'localpilot.openMemory', 'localpilot.clearMemory', 'localpilot.reloadSkills', 'localpilot.showLogs', 'localpilot.installCli',
  'localpilot.refreshModels', 'localpilot.openWelcome', 'localpilot.openSettings', 'localpilot.openTerminal', 'workbench.action.openSettingsJson', 'workbench.action.openWorkspaceSettingsFile',
  'workbench.action.openWalkthrough', 'workbench.action.openSettings',
]);

const PRESETS: Record<'safe' | 'balanced' | 'autonomous', Record<'terminal' | 'write' | 'delete' | 'network', 'ask' | 'always' | 'never'>> = {
  safe: { terminal: 'ask', write: 'ask', delete: 'ask', network: 'ask' },
  balanced: { terminal: 'ask', write: 'always', delete: 'ask', network: 'always' },
  autonomous: { terminal: 'always', write: 'always', delete: 'ask', network: 'always' },
};

export const WELCOMED_KEY = 'localpilot.welcomed';

/**
 * Settings, provider manager and first-run setup — one webview panel with two pages.
 * The webview never touches configuration directly; every change is validated here and written with the VS Code API.
 */
export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private page: SettingsPage = 'settings';
  private section?: SettingsSection;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly providers: ProviderRegistry,
    private readonly skills: SkillManager,
    private readonly mcp: McpManager,
    private readonly memory: MemoryStore,
    private readonly store: SessionStore,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localpilot') && this.panel) {
          void this.pushState();
        }
      }),
      providers.onDidChange(() => this.panel && void this.pushState()),
      mcp.onDidChange(() => this.panel && void this.pushState())
    );
  }

  /** True while the panel exists (visible or in a background tab). */
  get isOpen(): boolean {
    return !!this.panel;
  }

  show(page: SettingsPage = 'settings', section?: SettingsSection): void {
    this.page = page;
    this.section = section;
    if (this.panel) {
      this.panel.title = this.title();
      this.panel.reveal();
      void this.pushState();
      return;
    }
    const panel = vscode.window.createWebviewPanel('localpilot.settings', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview);
    this.panel = panel;
    panel.webview.onDidReceiveMessage((m: FromSettings) => void this.handle(m).catch((e) => this.post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) })));
    panel.onDidDispose(() => (this.panel = undefined));
  }

  private title(): string {
    return this.page === 'setup' ? 'Welcome to LocalPilot' : 'LocalPilot Settings';
  }

  private post(m: ToSettings): void {
    void this.panel?.webview.postMessage(m);
  }

  // ------------------------------------------------------------------ messages
  private async handle(m: FromSettings): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.pushState();
      case 'set':
        return this.update(m.key, m.value, m.scope);
      case 'reset':
        return this.update(m.key, undefined, m.scope);
      case 'test': {
        const result = await probeProvider(sanitizeProvider(m.provider), true);
        return this.post({ type: 'testResult', id: result.id, result });
      }
      case 'probe':
        return this.probeAll();
      case 'refreshModels':
        this.post({ type: 'busy', busy: true });
        await this.providers.listModels(true).catch(() => []);
        this.post({ type: 'busy', busy: false });
        return this.pushState();
      case 'command':
        if (!ALLOWED_COMMANDS.has(m.id)) {
          throw new Error(`Command not allowed: ${m.id}`);
        }
        await vscode.commands.executeCommand(m.id, ...(m.args ?? []));
        if (m.id.startsWith('localpilot.')) {
          void this.pushState();
        }
        return;
      case 'finishSetup':
        return this.finishSetup(m);
      case 'openExternal':
        if (/^https?:\/\//i.test(m.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
        return;
    }
  }

  private async update(key: string, value: unknown, scope: 'user' | 'workspace'): Promise<void> {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown setting: ${key}`);
    }
    if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
      throw new Error('Open a folder to use workspace settings');
    }
    const clean = key === 'providers' && Array.isArray(value) ? value.map((p) => sanitizeProvider(p as ProviderConfig)) : key === 'mcpServers' && value !== undefined ? sanitizeMcpServers(value) : value;
    await vscode.workspace.getConfiguration('localpilot').update(key, clean, scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
    this.log.info(`settings: ${key} ${clean === undefined ? 'reset' : 'updated'} (${scope})`);
  }

  private async finishSetup(m: Extract<FromSettings, { type: 'finishSetup' }>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    if (m.providers?.length) {
      // Merge: keep everything the user already configured, add newly detected servers.
      const existing = cfg.get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS).map(sanitizeProvider);
      const known = new Set(existing.map((p) => p.baseUrl.replace(/\/+$/, '')));
      const added = m.providers.map(sanitizeProvider).filter((p) => !known.has(p.baseUrl));
      if (added.length) {
        await cfg.update('providers', [...existing, ...added], vscode.ConfigurationTarget.Global);
      }
    }
    if (m.model) {
      await cfg.update('defaultModel', m.model, vscode.ConfigurationTarget.Global);
    }
    if (m.approvals) {
      for (const [k, v] of Object.entries(PRESETS[m.approvals])) {
        await cfg.update(`approvals.${k}`, v, vscode.ConfigurationTarget.Global);
      }
    }
    if (typeof m.inlineCompletion === 'boolean') {
      await cfg.update('inlineCompletion.enabled', m.inlineCompletion, vscode.ConfigurationTarget.Global);
    }
    await this.ctx.globalState.update(WELCOMED_KEY, true);
    this.panel?.dispose();
    await vscode.commands.executeCommand('localpilot.openChat');
    vscode.window.setStatusBarMessage('LocalPilot is ready — start chatting', 4000);
  }

  private async probeAll(): Promise<void> {
    this.post({ type: 'busy', busy: true });
    // Settings + well-known endpoints + Docker containers; nothing is written from here (the wizard merges on finish).
    const report = await autoDetectProviders(this.log, { write: false });
    this.post({ type: 'probe', results: report.results, dockerModelRunner: report.dockerModelRunner });
    this.post({ type: 'busy', busy: false });
  }

  private async pushState(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const settings: Record<string, SettingEntry> = {};
    for (const key of SETTING_KEYS) {
      const i = cfg.inspect<unknown>(key);
      const scope = i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined ? 'workspace' : i?.globalValue !== undefined ? 'user' : 'default';
      settings[key] = { value: cfg.get(key), default: i?.defaultValue, scope, userValue: i?.globalValue, workspaceValue: i?.workspaceValue ?? i?.workspaceFolderValue };
    }
    const models = await this.providers.listModels().catch(() => []);
    const notes = await this.memory.list().catch(() => []);
    this.post({
      type: 'state',
      page: this.page,
      section: this.section,
      version: String((this.ctx.extension.packageJSON as { version?: string }).version ?? ''),
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
      settings,
      models,
      skills: this.skills.allSkills.map((s) => ({ name: s.name, description: s.description, source: s.source })),
      agents: this.skills.allAgents.map((a) => ({ name: a.name, description: a.description, source: a.source })),
      mcp: this.mcp.status,
      memory: { project: notes.filter((n) => n.scope === 'project').length, global: notes.filter((n) => n.scope === 'global').length },
      sessions: this.store.list().length,
      welcomed: !!this.ctx.globalState.get(WELCOMED_KEY),
    });
    this.section = undefined;
  }

  // ------------------------------------------------------------------ html
  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<link rel="stylesheet" href="${media('settings.css')}" />
<title>LocalPilot</title>
</head>
<body data-logo="${media('logo.svg')}">
<div id="app" aria-busy="true"><div class="loading" role="status"><div class="boot-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H13l-4.5 4v-4h-2A2.5 2.5 0 0 1 4 13.5z"/><circle cx="9" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><path d="M12 3V1.5"/><circle cx="12" cy="1.2" r=".8" fill="currentColor" stroke="none"/></svg></div><span class="boot-dots"><i></i><i></i><i></i></span><span class="sr">Loading LocalPilot Settings…</span></div></div>
<div id="toasts"></div>
<script nonce="${nonce}" src="${media('settings.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Validate the MCP server map coming from the form: non-empty names and commands, string args, string env values. */
export function sanitizeMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mcpServers must be an object');
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [rawName, rawCfg] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim().replace(/[^\w.-]+/g, '-');
    const c = (rawCfg ?? {}) as Partial<McpServerConfig>;
    const command = String(c.command ?? '').trim();
    if (!name || !command) {
      throw new Error(`MCP server "${rawName || '?'}" needs a name and a command`);
    }
    const entry: McpServerConfig = { command };
    if (Array.isArray(c.args) && c.args.length) {
      entry.args = c.args.map(String);
    }
    if (c.env && typeof c.env === 'object' && !Array.isArray(c.env)) {
      entry.env = Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, String(v)]));
    }
    if (typeof c.cwd === 'string' && c.cwd.trim()) {
      entry.cwd = c.cwd.trim();
    }
    if (c.enabled === false) {
      entry.enabled = false;
    }
    out[name] = entry;
  }
  return out;
}

/** Keep only known fields and normalise URLs/ids so a malformed form can't produce a broken provider. */
export function sanitizeProvider(p: ProviderConfig): ProviderConfig {
  const id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  const type: ProviderConfig['type'] = p.type === 'ollama' ? 'ollama' : 'openai';
  let baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `http://${baseUrl}`;
  }
  const out: ProviderConfig = { id, type, baseUrl };
  if (p.displayName && String(p.displayName).trim()) {
    out.displayName = String(p.displayName).trim();
  }
  if (p.apiKey && String(p.apiKey).trim()) {
    out.apiKey = String(p.apiKey).trim();
  }
  if (Array.isArray(p.models) && p.models.length) {
    out.models = p.models.map((m) => String(m).trim()).filter(Boolean);
  }
  if (typeof p.contextWindow === 'number' && p.contextWindow > 0) {
    out.contextWindow = Math.round(p.contextWindow);
  }
  if (p.enabled === false) {
    out.enabled = false;
  }
  return out;
}
