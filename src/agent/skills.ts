import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { getConfig } from '../config';
import { Skill, SubagentDefinition } from '../types';
import { builtinAgents } from './builtinAgents';
import { parseFrontMatter } from './frontMatter';

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
 * Subagents are markdown files with front-matter (`name`, `description`, `tools`, `model`) and a body used as
 * the system prompt, discovered in <workspace>/.localpilot/agents, <workspace>/.claude/agents, ~/.localpilot/agents.
 */
export class SkillManager implements vscode.Disposable {
  private skills = new Map<string, Skill>();
  private agents = new Map<string, SubagentDefinition>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watchers: vscode.FileSystemWatcher[] = [];

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

  get allSkills(): Skill[] {
    return [...this.skills.values()];
  }
  get allAgents(): SubagentDefinition[] {
    return [...this.agents.values()];
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
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
    for (const p of getConfig().skillsPaths) {
      skillDirs.push({ dir: p.replace(/^~/, home), source: 'user' });
    }
    if (this.builtinDir && getConfig().builtinSkills) {
      skillDirs.push({ dir: this.builtinDir, source: 'builtin' });
    }

    for (const { dir, source } of skillDirs) {
      await this.loadSkillsFrom(dir, source);
    }
    for (const { dir, source } of agentDirs) {
      await this.loadAgentsFrom(dir, source);
    }
    this.log.info(`Skills: ${this.skills.size}, subagents: ${this.agents.size}`);
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
        const tools = typeof meta.tools === 'string' ? meta.tools.split(',').map((s) => s.trim()).filter(Boolean) : Array.isArray(meta.tools) ? (meta.tools as string[]) : undefined;
        this.agents.set(name, { name, description: (meta.description as string) || '', systemPrompt: body.trim(), tools, model: meta.model as string | undefined, source });
      } catch (e) {
        this.log.warn(`Failed to load agent ${file}: ${String(e)}`);
      }
    }
  }

  /** Compact skills index injected into the system prompt (progressive disclosure: bodies load on demand). */
  skillsIndex(): string {
    if (!this.skills.size) {
      return '';
    }
    return this.allSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  }

  agentsIndex(): string {
    return this.allAgents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  }

  async loadSkillBody(name: string): Promise<string | undefined> {
    const s = this.skills.get(name);
    if (!s) {
      return undefined;
    }
    if (!s.body) {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(s.path))).toString('utf8');
      s.body = parseFrontMatter(raw).body;
    }
    return `<skill name="${s.name}" dir="${s.dir}">\n${s.body}\n</skill>`;
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this._onDidChange.dispose();
  }
}
