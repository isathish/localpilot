// The Agent map webview (`localpilot.openAgentMap`): every agent LocalPilot has and how work flows between them, built
// from the live configuration and registries by agentMapData.ts. Every change made from the map goes through the same
// settings and managers as Settings and the CLI, and the map redraws when any of them changes.
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseFrontMatter } from '../agent/frontMatter';
import { SkillLearner } from '../agent/skillRecommender';
import { SkillManager } from '../agent/skills';
import { classifyTask, TaskRoute } from '../agent/taskRouter';
import { toolDisabled } from '../agent/toolAliases';
import { configTarget, getConfig, setSkillEnabled } from '../config';
import { McpManager } from '../mcp/mcpManager';
import { pickForRole, ProviderRegistry } from '../providers/registry';
import { Tool } from '../types';
import { agentTemplate, AgentMapModel, APPROVAL_OPTIONS, ApprovalKind, buildAgentMap, MapInputs, RoleKey, ROLE_SETTING, routePath, routeTarget, skillTemplate, slugName } from './agentMapData';

export type ToAgentMap =
  | { type: 'model'; model: AgentMapModel; hasFolder: boolean }
  | { type: 'route'; text: string; route: TaskRoute; label: string; path: string[] }
  | { type: 'toast'; level: 'info' | 'error'; text: string };

export type FromAgentMap =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'classify'; text: string }
  | { type: 'action'; id: string; arg?: string; value?: unknown };

const ROLES: RoleKey[] = ['agent', 'reasoning', 'fast', 'coding', 'vision'];

export class AgentMapPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private pushSeq = 0;
  /** Skill usage, set by the extension host (the learner records which skills runs loaded). */
  learner?: SkillLearner;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly providers: ProviderRegistry,
    private readonly skills: SkillManager,
    private readonly mcp: McpManager,
    private readonly tools: () => Tool[],
    private readonly log: vscode.LogOutputChannel
  ) {
    const later = () => this.panel && this.schedule();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('localpilot') && later()),
      vscode.workspace.onDidChangeWorkspaceFolders(later),
      skills.onDidChange(later),
      mcp.onDidChange(later),
      providers.onDidChange(later)
    );
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      this.schedule();
      return;
    }
    const panel = vscode.window.createWebviewPanel('localpilot.agentMap', 'Agent Map', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m: FromAgentMap) => void this.handle(m).catch((e) => this.post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) })));
    panel.onDidDispose(() => {
      this.panel = undefined;
      clearTimeout(this.timer);
    });
    this.panel = panel;
  }

  /** Coalesces bursts (a settings write fires several change events) into one redraw. */
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push(), 150);
  }

  private post(m: ToAgentMap): void {
    this.panel?.webview.postMessage(m).then(undefined, () => undefined);
  }

  private async push(): Promise<void> {
    const seq = ++this.pushSeq;
    const model = await this.snapshot();
    if (seq === this.pushSeq) {
      this.post({ type: 'model', model, hasFolder: !!vscode.workspace.workspaceFolders?.length });
    }
  }

  /** The map as it stands now (also used by the tests). */
  async snapshot(): Promise<AgentMapModel> {
    return buildAgentMap(await this.collect());
  }

  /** Reads every source the map draws: settings, the router's current picks, agents, skills, tools and MCP servers. */
  async collect(): Promise<MapInputs> {
    const cfg = getConfig();
    const models = await this.providers.listModels().catch(() => []);
    const resolved: Partial<Record<RoleKey, string>> = {};
    const route = (role: 'agent' | 'reasoning' | 'fast') => this.providers.route({ role, start: false }).then((r) => r.model.id, () => undefined);
    const [agent, reasoning, fast] = await Promise.all([route('agent'), route('reasoning'), route('fast')]);
    const auto = cfg.localOnlyModels ? models.filter((m) => !m.remote) : models;
    Object.assign(resolved, {
      agent,
      reasoning,
      fast,
      // routeSubagent: writers use routing.coding or keep the chat model.
      coding: cfg.routing.coding && models.some((m) => m.id === cfg.routing.coding) ? cfg.routing.coding : agent,
      vision: (cfg.routing.vision && models.find((m) => m.id === cfg.routing.vision && m.supportsVision)?.id) || pickForRole(auto, 'vision')?.id,
    });
    for (const r of ROLES) {
      if (!resolved[r]) {
        delete resolved[r];
      }
    }
    const pluginSkillDirs = (this.skills.plugins?.skillDirs() ?? []).map((d) => d.dir);
    const pluginAgentDirs = (this.skills.plugins?.agentDirs() ?? []).map((d) => d.dir);
    const files = await agentFiles(this.agentDirs(pluginAgentDirs));
    const usage = await this.learner?.usage(this.skills.enabledSkills).catch(() => undefined);
    const under = (p: string, dirs: string[]) => dirs.some((d) => p === d || p.startsWith(d + path.sep));
    return {
      defaultModel: cfg.defaultModel || undefined,
      routing: { enabled: cfg.routing.enabled, vision: cfg.routing.vision, reasoning: cfg.routing.reasoning, fast: cfg.routing.fast, coding: cfg.routing.coding },
      localOnly: cfg.localOnlyModels,
      resolved,
      models: models.map((m) => ({ id: m.id, name: m.name, remote: m.remote })),
      agents: this.skills.allAgents.map((a) => {
        const file = a.source === 'builtin' ? undefined : files.get(a.name);
        return { name: a.name, description: a.description, source: a.source, tools: a.tools, model: a.model, skills: a.skills, file, plugin: !!file && under(file, pluginAgentDirs) };
      }),
      skills: this.skills.allSkills.map((s) => ({ name: s.name, description: s.description, source: s.source, disabled: s.disabled, alwaysEnabled: s.alwaysEnabled, path: s.path, plugin: under(s.dir, pluginSkillDirs) })),
      skillUse: usage?.skillUse,
      tools: this.tools().map((t) => ({ name: t.definition.name, description: t.definition.description.split(/(?<=\.)\s/)[0].slice(0, 160), approvalKind: t.approvalKind, readOnly: t.readOnly })),
      disabledTools: cfg.disabledTools,
      approvals: { ...cfg.approvals },
      mcp: this.mcp.status.map((s) => ({ name: s.name, state: s.state, tools: s.tools, error: s.error, source: s.source, transport: s.transport })),
      hasFolder: !!vscode.workspace.workspaceFolders?.length,
    };
  }

  /** Agent folders in the loader's priority order: workspace, user, then plugins. */
  private agentDirs(pluginDirs: string[]): string[] {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const home = os.homedir();
    return [...roots.flatMap((r) => [path.join(r, '.localpilot', 'agents'), path.join(r, '.claude', 'agents')]), path.join(home, '.localpilot', 'agents'), path.join(home, '.claude', 'agents'), ...pluginDirs];
  }

  // ------------------------------------------------------------------ messages
  async handle(m: FromAgentMap): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        return this.push();
      case 'classify': {
        const text = String(m.text ?? '').slice(0, 4000);
        const errors = [...vscode.languages.getDiagnostics()].reduce((n, [, list]) => n + list.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length, 0);
        const route = classifyTask({ text, hasFolder: !!vscode.workspace.workspaceFolders?.length, diagnostics: errors });
        return this.post({ type: 'route', text, route, label: routeTarget(route), path: routePath(route) });
      }
      case 'action':
        return this.action(m.id, m.arg, m.value);
    }
  }

  private async action(id: string, arg: string | undefined, value: unknown): Promise<void> {
    const c = () => vscode.workspace.getConfiguration('localpilot');
    const write = async (key: string, v: unknown) => c().update(key, v, configTarget(key));
    switch (id) {
      case 'setRole': {
        const role = arg as RoleKey;
        if (!ROLES.includes(role)) {
          throw new Error(`Unknown model role "${arg}"`);
        }
        const v = typeof value === 'string' && value.trim() ? value.trim() : undefined;
        await write(ROLE_SETTING[role], v);
        return this.toast(`${role} role: ${v ?? 'automatic'}`);
      }
      case 'toggleSkill': {
        const skill = this.skills.getSkill(String(arg));
        if (!skill) {
          throw new Error(`Unknown skill "${arg}"`);
        }
        if (!value && skill.alwaysEnabled) {
          throw new Error(`“${skill.name}” is always on: your organization requires it`);
        }
        await setSkillEnabled(skill.name, !!value);
        await this.skills.refresh();
        return this.toast(value ? `“${skill.name}” enabled` : `“${skill.name}” disabled — the agent no longer sees it`);
      }
      case 'toggleTool': {
        const name = String(arg);
        const key = 'disabledTools';
        const target = configTarget(key);
        const i = c().inspect<string[]>(key);
        const cur = (target === vscode.ConfigurationTarget.Global ? i?.globalValue : target === vscode.ConfigurationTarget.Workspace ? i?.workspaceValue : i?.workspaceFolderValue) ?? [];
        const next = value ? cur.filter((n) => n !== name) : cur.includes(name) ? cur : [...cur, name];
        await c().update(key, next.length ? next : undefined, target);
        // A pattern (`browser_*`) or the other scope can still switch it off: say so rather than claim it is on.
        if (value && toolDisabled(name, getConfig().disabledTools)) {
          throw new Error(`${name} is still off: a pattern in localpilot.disabledTools matches it. Edit the setting to change that.`);
        }
        return this.toast(`${name} ${value ? 'switched on' : 'switched off'}`);
      }
      case 'setApproval': {
        const kind = arg as ApprovalKind;
        const options = APPROVAL_OPTIONS[kind];
        if (!options || !options.some((o) => o.value === value)) {
          throw new Error(`Invalid approval "${String(value)}" for ${arg}`);
        }
        await write(`approvals.${kind}`, value);
        return this.toast(`Approval for ${kind}: ${String(value)}`);
      }
      case 'toggleMcp':
        await this.mcp.setEnabled(String(arg), !!value);
        return this.toast(`${arg} ${value ? 'enabled' : 'disabled'}`);
      case 'restartMcp':
        if (!(await this.mcp.restart(String(arg)))) {
          throw new Error(`${arg} did not restart: ${this.mcp.status.find((s) => s.name === arg)?.error ?? 'see the LocalPilot log'}`);
        }
        return this.toast(`${arg} restarted`);
      case 'openFile': {
        const file = String(arg);
        if (!this.skills.allSkills.some((s) => s.path === file)) {
          throw new Error('Only skill files can be opened from here');
        }
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
        return;
      }
      case 'openAgent': {
        const file = (await agentFiles(this.agentDirs((this.skills.plugins?.agentDirs() ?? []).map((d) => d.dir)))).get(String(arg));
        if (!file) {
          throw new Error(`No file found for the subagent "${arg}"`);
        }
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
        return;
      }
      case 'copyAgent': {
        const def = this.skills.getAgent(String(arg));
        if (!def) {
          throw new Error(`Unknown subagent "${arg}"`);
        }
        return this.create('agent', def.name, { description: def.description, tools: def.tools, systemPrompt: def.systemPrompt });
      }
      case 'newAgent':
        return this.create('agent');
      case 'newSkill':
        return this.create('skill');
      case 'openSettings':
        await vscode.commands.executeCommand('localpilot.openSettings', typeof arg === 'string' ? arg : undefined);
        return;
      default:
        throw new Error(`Unknown action "${id}"`);
    }
  }

  private toast(text: string): void {
    this.post({ type: 'toast', level: 'info', text });
  }

  /** New subagent or skill file from a template (or a copy of a built-in agent), opened for editing. */
  private async create(kind: 'agent' | 'skill', name?: string, base?: { description: string; tools?: string[]; systemPrompt: string }): Promise<void> {
    const raw =
      name ??
      (await vscode.window.showInputBox({
        title: kind === 'agent' ? 'New subagent' : 'New skill',
        prompt: 'Name (lower-case words joined by dashes)',
        placeHolder: kind === 'agent' ? 'e.g. migration-helper' : 'e.g. release-checklist',
        validateInput: (v) => (slugName(v) ? undefined : 'Use letters, digits and dashes'),
      }));
    const slug = raw ? slugName(raw) : '';
    if (!slug) {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const scopes = [...(root ? [{ label: 'This workspace', description: `.localpilot/${kind}s`, dir: path.join(root, '.localpilot') }] : []), { label: 'All my workspaces', description: `~/.localpilot/${kind}s`, dir: path.join(os.homedir(), '.localpilot') }];
    const scope = scopes.length === 1 ? scopes[0] : await vscode.window.showQuickPick(scopes, { title: `Where should “${slug}” live?` });
    if (!scope) {
      return;
    }
    const file = kind === 'agent' ? path.join(scope.dir, 'agents', `${slug}.md`) : path.join(scope.dir, 'skills', slug, 'SKILL.md');
    const exists = await fs.stat(file).then(() => true, () => false);
    if (!exists) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, kind === 'agent' ? agentTemplate(slug, base) : skillTemplate(slug), 'utf8');
      this.log.info(`agent map: created ${file}`);
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    await this.skills.refresh();
    this.toast(exists ? `${slug} already exists: opened it` : `Created ${kind === 'agent' ? 'subagent' : 'skill'} “${slug}”: describe it and save`);
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const look = getConfig().appearance;
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<link rel="stylesheet" href="${media('agentMap.css')}" />
<title>Agent Map</title>
</head>
<body data-density="${look.density}" data-text-size="${look.textSize}" data-motion="${look.motion}">
<div id="app" aria-busy="true"><div class="loading" role="status">Loading the agent map…</div></div>
<div id="toasts" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${media('agentMap.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Agent name → file, first folder wins (the loader's priority). The name is the front matter's `name:` or the file name. */
async function agentFiles(dirs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const dir of dirs) {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    for (const f of entries.filter((e) => e.endsWith('.md')).sort()) {
      const file = path.join(dir, f);
      const raw = await fs.readFile(file, 'utf8').catch(() => '');
      const meta = raw ? parseFrontMatter(raw).meta : {};
      const name = (typeof meta.name === 'string' && meta.name.trim()) || f.replace(/\.md$/, '');
      if (!out.has(name)) {
        out.set(name, file);
      }
    }
  }
  return out;
}
