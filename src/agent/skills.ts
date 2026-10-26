import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { getConfig } from '../config';
import { Skill, SubagentDefinition } from '../types';
import { builtinAgents } from './builtinAgents';
import { parseFrontMatter } from './frontMatter';
import type { PluginSource } from './plugins';

export { parseFrontMatter } from './frontMatter';

/**
 * Skills are folders containing a SKILL.md with YAML front-matter (`name`, `description`) and a markdown body
 * of instructions, following the Agent Skills convention used by Claude Code / Copilot.
 * Discovery locations (in priority order):
 *   <workspace>/.localpilot/skills/*, <workspace>/.claude/skills/*, <workspace>/.github/skills/*,
 *   ~/.localpilot/skills/*, ~/.claude/skills/*, ~/.agents/skills/*, plus `localpilot.skillsPaths`,
 *   then the skills bundled with the extension (`<extension>/skills/*`, source "builtin") — a workspace or user
 *   skill with the same name overrides a bundled one.
 *
 * Subagents are markdown files with front-matter (`name`, `description`, `tools`, `model`, `skills`) and a body used
 * as the system prompt (`skills` names skills preloaded into every run of that subagent), discovered in <workspace>/.localpilot/agents, <workspace>/.claude/agents, ~/.localpilot/agents.
 */
export class SkillManager implements vscode.Disposable {
  private skills = new Map<string, Skill>();
  private agents = new Map<string, SubagentDefinition>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watchers: vscode.FileSystemWatcher[] = [];
  /** Plugins whose `skills/` and `agents/` folders are loaded after the user's own (set by the extension). */
  plugins?: PluginSource;

  constructor(
    private readonly log: vscode.LogOutputChannel,
    /** Folder with the skills shipped inside the extension package. */
    private readonly builtinDir?: string
  ) {
    for (const glob of ['**/.localpilot/{skills,agents}/**', '**/.claude/{skills,agents}/**', '**/.github/skills/**']) {
      const w = vscode.workspace.createFileSystemWatcher(glob);
      const reload = () => void this.refresh();
      w.onDidChange(reload);
      w.onDidCreate(reload);
      w.onDidDelete(reload);
      this.watchers.push(w);
    }
  }

  /** Every skill on disk, including disabled ones (for Settings). */
  get allSkills(): Skill[] {
    return [...this.skills.values()];
  }
  /** Skills the agent may see and load. */
  get enabledSkills(): Skill[] {
    return this.allSkills.filter((s) => !s.disabled);
  }
  get allAgents(): SubagentDefinition[] {
    return [...this.agents.values()];
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Finds an enabled skill by name, tolerating the ways models mangle names: case, `_`/space for `-`, a dropped
   * or added `-skill` suffix, or a close misspelling. Returns the match and whether it was exact.
   */
  resolveSkill(raw: string): { skill: Skill; exact: boolean } | undefined {
    const exact = this.skills.get(raw);
    if (exact && !exact.disabled) {
      return { skill: exact, exact: true };
    }
    const norm = normalizeSkillName(raw);
    if (!norm) {
      return undefined;
    }
    const enabled = this.enabledSkills;
    const byNorm = enabled.find((s) => normalizeSkillName(s.name) === norm);
    if (byNorm) {
      return { skill: byNorm, exact: false };
    }
    // One clear fuzzy winner: within a small edit distance, and no second skill as close.
    const scored = enabled.map((s) => ({ s, d: editDistance(norm, normalizeSkillName(s.name)) })).sort((a, b) => a.d - b.d);
    const best = scored[0];
    const limit = norm.length <= 5 ? 1 : norm.length <= 10 ? 2 : 3;
    if (best && best.d <= limit && (!scored[1] || scored[1].d > best.d)) {
      return { skill: best.s, exact: false };
    }
    return undefined;
  }

  /** Enabled skill names closest to `raw` (for "did you mean" messages). */
  similarSkillNames(raw: string, max = 3): string[] {
    const norm = normalizeSkillName(raw);
    const tokens = new Set(norm.split('-').filter((t) => t.length >= 3));
    return this.enabledSkills
      .map((s) => {
        const n = normalizeSkillName(s.name);
        const shared = n.split('-').filter((t) => tokens.has(t)).length;
        return { name: s.name, score: shared * 10 - editDistance(norm, n) };
      })
      .filter((x) => x.score > -Math.max(4, norm.length))
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((x) => x.name);
  }

  getAgent(name: string): SubagentDefinition | undefined {
    return this.agents.get(name);
  }

  async refresh(): Promise<void> {
    this.skills.clear();
    this.agents.clear();
    for (const a of builtinAgents()) {
      this.agents.set(a.name, a);
    }
    const home = os.homedir();
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const skillDirs: { dir: string; source: Skill['source'] }[] = [];
    const agentDirs: { dir: string; source: Skill['source'] }[] = [];
    for (const r of roots) {
      skillDirs.push({ dir: path.join(r, '.localpilot', 'skills'), source: 'workspace' });
      skillDirs.push({ dir: path.join(r, '.claude', 'skills'), source: 'workspace' });
      skillDirs.push({ dir: path.join(r, '.github', 'skills'), source: 'workspace' });
      agentDirs.push({ dir: path.join(r, '.localpilot', 'agents'), source: 'workspace' });
      agentDirs.push({ dir: path.join(r, '.claude', 'agents'), source: 'workspace' });
    }
    skillDirs.push({ dir: path.join(home, '.localpilot', 'skills'), source: 'user' });
    skillDirs.push({ dir: path.join(home, '.claude', 'skills'), source: 'user' });
    skillDirs.push({ dir: path.join(home, '.agents', 'skills'), source: 'user' });
    agentDirs.push({ dir: path.join(home, '.localpilot', 'agents'), source: 'user' });
    agentDirs.push({ dir: path.join(home, '.claude', 'agents'), source: 'user' });
    const cfg = getConfig();
    for (const p of cfg.skillsPaths) {
      skillDirs.push({ dir: p.replace(/^~/, home), source: 'user' });
    }
    // Plugins come after the user's own folders, so a local skill or agent of the same name wins.
    for (const d of this.plugins?.skillDirs() ?? []) {
      skillDirs.push(d);
    }
    for (const d of this.plugins?.agentDirs() ?? []) {
      agentDirs.push(d);
    }
    if (this.builtinDir && cfg.builtinSkills) {
      skillDirs.push({ dir: this.builtinDir, source: 'builtin' });
    }

    for (const { dir, source } of skillDirs) {
      await this.loadSkillsFrom(dir, source);
    }
    const disabled = new Set(cfg.skillsDisabled);
    for (const s of this.skills.values()) {
      s.disabled = disabled.has(s.name) || undefined;
    }
    for (const { dir, source } of agentDirs) {
      await this.loadAgentsFrom(dir, source);
    }
    this.log.info(`Skills: ${this.skills.size}${disabled.size ? ` (${this.allSkills.filter((s) => s.disabled).length} disabled)` : ''}, subagents: ${this.agents.size}`);
    this._onDidChange.fire();
  }

  private async loadSkillsFrom(dir: string, source: Skill['source']): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      const skillPath = path.join(dir, name, 'SKILL.md');
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(skillPath))).toString('utf8');
        const { meta, body } = parseFrontMatter(raw);
        const skillName = (meta.name as string) || name;
        if (this.skills.has(skillName)) {
          continue; // earlier (higher priority) wins
        }
        this.skills.set(skillName, {
          name: skillName,
          description: (meta.description as string) || body.split('\n').find((l) => l.trim())?.slice(0, 200) || '',
          path: skillPath,
          dir: path.join(dir, name),
          body,
          source,
        });
      } catch {
        /* no SKILL.md */
      }
    }
  }

  private async loadAgentsFrom(dir: string, source: Skill['source']): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return;
    }
    for (const [file, type] of entries) {
      if (type !== vscode.FileType.File || !file.endsWith('.md')) {
        continue;
      }
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, file)))).toString('utf8');
        const { meta, body } = parseFrontMatter(raw);
        const name = (meta.name as string) || file.replace(/\.md$/, '');
        const list = (v: unknown): string[] | undefined => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : Array.isArray(v) ? (v as unknown[]).map(String).filter(Boolean) : undefined);
        this.agents.set(name, { name, description: (meta.description as string) || '', systemPrompt: body.trim(), tools: list(meta.tools), skills: list(meta.skills), model: meta.model as string | undefined, source });
      } catch (e) {
        this.log.warn(`Failed to load agent ${file}: ${String(e)}`);
      }
    }
  }

  /** Compact skills index injected into the system prompt (progressive disclosure: bodies load on demand). */
  skillsIndex(): string {
    const enabled = this.enabledSkills;
    if (!enabled.length) {
      return '';
    }
    return enabled.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}`).join('\n');
  }

  agentsIndex(): string {
    return this.allAgents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  }

  /** Full instructions of an enabled skill, wrapped for the prompt. Resolves mangled names; disabled skills are not loadable. */
  async loadSkillBody(name: string): Promise<string | undefined> {
    const s = this.resolveSkill(name)?.skill;
    if (!s) {
      return undefined;
    }
    if (!s.body) {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(s.path))).toString('utf8');
      s.body = parseFrontMatter(raw).body;
    }
    return `<skill name="${s.name}" dir="${s.dir}">\n${s.body.trim()}\n</skill>`;
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this._onDidChange.dispose();
  }
}

/** `My PDF_Skill` → `my-pdf`; the comparison key for resolving names a model mangled. */
export function normalizeSkillName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-?skills?$/, '');
}

/** Optimal string alignment distance: insert / delete / substitute / adjacent transposition each cost 1 ("pfd" → "pdf" = 1). */
function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) {
    rows[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}
