import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Project / user settings files in the Claude Code format (`settings.json`), read from both the `.claude` and the
 * `.localpilot` folders so a repository already set up for Claude Code works unchanged.
 *
 * Layers, lowest to highest precedence:
 *   ~/.claude/settings.json → ~/.localpilot/settings.json
 *   → <root>/.claude/settings.json → <root>/.localpilot/settings.json
 *   → <root>/.claude/settings.local.json → <root>/.localpilot/settings.local.json
 *
 * Lists (permission rules, hooks) are concatenated across layers; objects (env, enabledPlugins) are merged with the
 * higher layer winning; scalars take the highest layer.
 */

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SubagentStop' | 'SessionStart' | 'SessionEnd' | 'PreCompact' | 'Notification';

export const HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification'];

export interface HookCommand {
  type: 'command';
  command: string;
  /** Seconds; default 60. */
  timeout?: number;
  /** Set for hooks contributed by a plugin: `${CLAUDE_PLUGIN_ROOT}` in the command resolves to this folder. */
  pluginRoot?: string;
}

export interface HookMatcher {
  /** Regex (or exact name / `*`) matched against the tool name — or the trigger for SessionStart / PreCompact. */
  matcher?: string;
  hooks: HookCommand[];
}

export interface PermissionSettings {
  allow: string[];
  deny: string[];
  ask: string[];
  /** `default` asks per the approval settings; `acceptEdits` approves file edits; `plan` is read-only; `bypassPermissions` approves everything. */
  defaultMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk';
  /** Directories outside the workspace the agent may read/edit. */
  additionalDirectories: string[];
}

export interface ProjectSettings {
  permissions: PermissionSettings;
  hooks: Partial<Record<HookEvent, HookMatcher[]>>;
  env: Record<string, string>;
  /** `plugin-name` or `plugin-name@marketplace` → enabled. Missing = enabled. */
  enabledPlugins: Record<string, boolean>;
  /** Default model (`provider/model`) for the project. */
  model?: string;
  /** Files the settings were assembled from, lowest precedence first. */
  sources: string[];
}

export function emptySettings(): ProjectSettings {
  return { permissions: { allow: [], deny: [], ask: [], additionalDirectories: [] }, hooks: {}, env: {}, enabledPlugins: {}, sources: [] };
}

/** Settings file candidates for a root folder, lowest precedence first. */
export function settingsFilesFor(root: string): string[] {
  return [path.join(root, '.claude', 'settings.json'), path.join(root, '.localpilot', 'settings.json'), path.join(root, '.claude', 'settings.local.json'), path.join(root, '.localpilot', 'settings.local.json')];
}

export function userSettingsFiles(home = os.homedir()): string[] {
  return [path.join(home, '.claude', 'settings.json'), path.join(home, '.localpilot', 'settings.json')];
}

/** JSON with `//` and `/* *\/` comments and trailing commas (settings files are hand-edited). */
export function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\"'])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(stripped);
}

const asStringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((s) => s.trim()) : typeof v === 'string' && v.trim() ? [v.trim()] : []);

function normalizeHooks(raw: unknown, pluginRoot?: string): Partial<Record<HookEvent, HookMatcher[]>> {
  const out: Partial<Record<HookEvent, HookMatcher[]>> = {};
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  for (const [event, matchers] of Object.entries(raw as Record<string, unknown>)) {
    if (!HOOK_EVENTS.includes(event as HookEvent) || !Array.isArray(matchers)) {
      continue;
    }
    const list: HookMatcher[] = [];
    for (const m of matchers) {
      if (!m || typeof m !== 'object') {
        continue;
      }
      const mm = m as { matcher?: unknown; hooks?: unknown };
      const hooks: HookCommand[] = [];
      for (const h of Array.isArray(mm.hooks) ? mm.hooks : []) {
        const hh = h as { type?: unknown; command?: unknown; timeout?: unknown };
        if ((hh.type === undefined || hh.type === 'command') && typeof hh.command === 'string' && hh.command.trim()) {
          hooks.push({ type: 'command', command: hh.command, timeout: typeof hh.timeout === 'number' && hh.timeout > 0 ? hh.timeout : undefined, pluginRoot });
        }
      }
      if (hooks.length) {
        list.push({ matcher: typeof mm.matcher === 'string' ? mm.matcher : undefined, hooks });
      }
    }
    if (list.length) {
      out[event as HookEvent] = list;
    }
  }
  return out;
}

/** One parsed settings file (or a plugin's contribution) in the normalised shape. */
export function normalizeSettings(raw: unknown, source: string, pluginRoot?: string): ProjectSettings {
  const s = emptySettings();
  s.sources = [source];
  if (!raw || typeof raw !== 'object') {
    return s;
  }
  const r = raw as Record<string, unknown>;
  const p = (r.permissions ?? {}) as Record<string, unknown>;
  s.permissions.allow = asStringList(p.allow);
  s.permissions.deny = asStringList(p.deny);
  s.permissions.ask = asStringList(p.ask);
  s.permissions.additionalDirectories = asStringList(p.additionalDirectories);
  const mode = p.defaultMode;
  if (mode === 'default' || mode === 'acceptEdits' || mode === 'plan' || mode === 'bypassPermissions' || mode === 'dontAsk') {
    s.permissions.defaultMode = mode;
  }
  s.hooks = normalizeHooks(r.hooks, pluginRoot);
  if (r.env && typeof r.env === 'object') {
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        s.env[k] = String(v);
      }
    }
  }
  if (r.enabledPlugins && typeof r.enabledPlugins === 'object') {
    for (const [k, v] of Object.entries(r.enabledPlugins as Record<string, unknown>)) {
      if (typeof v === 'boolean') {
        s.enabledPlugins[k] = v;
      }
    }
  }
  if (typeof r.model === 'string' && r.model.trim()) {
    s.model = r.model.trim();
  }
  return s;
}

/** Merge layers, lowest precedence first. */
export function mergeSettings(layers: ProjectSettings[]): ProjectSettings {
  const out = emptySettings();
  const uniq = (list: string[]) => [...new Set(list)];
  for (const l of layers) {
    out.permissions.allow.push(...l.permissions.allow);
    out.permissions.deny.push(...l.permissions.deny);
    out.permissions.ask.push(...l.permissions.ask);
    out.permissions.additionalDirectories.push(...l.permissions.additionalDirectories);
    if (l.permissions.defaultMode) {
      out.permissions.defaultMode = l.permissions.defaultMode;
    }
    for (const [event, matchers] of Object.entries(l.hooks) as [HookEvent, HookMatcher[]][]) {
      out.hooks[event] = [...(out.hooks[event] ?? []), ...matchers];
    }
    Object.assign(out.env, l.env);
    Object.assign(out.enabledPlugins, l.enabledPlugins);
    if (l.model) {
      out.model = l.model;
    }
    out.sources.push(...l.sources);
  }
  out.permissions.allow = uniq(out.permissions.allow);
  out.permissions.deny = uniq(out.permissions.deny);
  out.permissions.ask = uniq(out.permissions.ask);
  out.permissions.additionalDirectories = uniq(out.permissions.additionalDirectories);
  return out;
}

export async function readSettingsFile(file: string, log?: { warn(m: string): void }): Promise<ProjectSettings | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  if (!text.trim()) {
    return undefined;
  }
  try {
    return normalizeSettings(parseJsonc(text), file);
  } catch (e) {
    log?.warn(`settings: cannot parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Reads and merges every settings layer for the given workspace roots. */
export async function loadProjectSettings(roots: string[], opts: { home?: string; log?: { warn(m: string): void }; extra?: ProjectSettings[] } = {}): Promise<ProjectSettings> {
  const files = [...userSettingsFiles(opts.home), ...roots.flatMap((r) => settingsFilesFor(r))];
  const layers = (await Promise.all(files.map((f) => readSettingsFile(f, opts.log)))).filter((l): l is ProjectSettings => !!l);
  // Plugin contributions sit below every settings file, so a project can still deny what a plugin allows.
  return mergeSettings([...(opts.extra ?? []), ...layers]);
}

/**
 * Keeps the merged settings current: re-read when a settings file changes in the workspace (user-level files are
 * re-read on a short interval, since the editor only watches the workspace).
 */
export class ProjectSettingsManager implements vscode.Disposable {
  private settings: ProjectSettings = emptySettings();
  private readonly _onDidChange = new vscode.EventEmitter<ProjectSettings>();
  readonly onDidChange = this._onDidChange.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private loadedAt = 0;
  private loading?: Promise<ProjectSettings>;
  /** Settings contributed by plugins (hooks, mcp are handled by their own managers); refreshed by the plugin manager. */
  pluginLayers: ProjectSettings[] = [];

  constructor(private readonly log: vscode.LogOutputChannel, private readonly homeDir = os.homedir()) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{.claude,.localpilot}/settings{,.local}.json');
    const reload = () => void this.reload();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  get current(): ProjectSettings {
    // User-level files have no watcher: refresh lazily when the snapshot is older than a minute.
    if (Date.now() - this.loadedAt > 60_000 && !this.loading) {
      void this.reload();
    }
    return this.settings;
  }

  get roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  async reload(): Promise<ProjectSettings> {
    if (this.loading) {
      return this.loading;
    }
    this.loading = (async () => {
      try {
        const next = await loadProjectSettings(this.roots, { home: this.homeDir, log: this.log, extra: this.pluginLayers });
        const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
        this.settings = next;
        this.loadedAt = Date.now();
        if (changed) {
          const hooks = Object.values(next.hooks).reduce((n, m) => n + m.reduce((k, x) => k + x.hooks.length, 0), 0);
          const rules = next.permissions.allow.length + next.permissions.deny.length + next.permissions.ask.length;
          this.log.info(`settings: ${next.sources.length} file(s), ${rules} permission rule(s), ${hooks} hook(s)`);
          this._onDidChange.fire(next);
        }
        return next;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
  }
}
