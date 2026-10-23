import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { getConfig } from '../config';
import { Skill, SubagentDefinition } from '../types';

/**
 * Skills are folders containing a SKILL.md with YAML front-matter (`name`, `description`) and a markdown body
 * of instructions, following the Agent Skills convention used by Claude Code / Copilot.
 * Discovery locations (in priority order):
 *   <workspace>/.localpilot/skills/*, <workspace>/.claude/skills/*, <workspace>/.github/skills/*,
 *   ~/.localpilot/skills/*, ~/.claude/skills/*, ~/.agents/skills/*, plus `localpilot.skillsPaths`.
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

  constructor(private readonly log: vscode.LogOutputChannel) {
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

export function parseFrontMatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) {
    return { meta: {}, body: raw };
  }
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    let v: unknown = kv[2].trim();
    if (typeof v === 'string') {
      if (/^\[.*\]$/.test(v)) {
        v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      } else {
        v = v.replace(/^['"]|['"]$/g, '');
      }
    }
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

function builtinAgents(): SubagentDefinition[] {
  return [
    {
      name: 'explore',
      source: 'builtin',
      description: 'Fast read-only codebase exploration and Q&A. Use to locate files, understand structure, or answer questions without editing.',
      tools: ['read_file', 'list_dir', 'file_search', 'grep_search', 'find_symbol', 'find_references', 'get_diagnostics'],
      systemPrompt:
        'You are a read-only code exploration agent. Investigate the workspace with search and read tools to answer the question precisely. Never edit files or run commands. Return a concise report with exact file paths and line numbers, and quote the relevant code.',
    },
    {
      name: 'coder',
      source: 'builtin',
      description: 'Implements a well-specified code change end to end (edit files, run build/tests, fix errors).',
      systemPrompt:
        'You are an implementation agent. Make the requested change with minimal, idiomatic edits, verify with diagnostics/tests when possible, and report exactly what you changed (files, functions) and anything left undone.',
    },
    {
      name: 'reviewer',
      source: 'builtin',
      description: 'Reviews code or a diff for bugs, security issues and style problems without editing.',
      tools: ['read_file', 'list_dir', 'file_search', 'grep_search', 'find_symbol', 'find_references', 'get_diagnostics', 'run_command'],
      systemPrompt:
        'You are a meticulous code reviewer. Identify correctness bugs, security vulnerabilities (OWASP top 10), race conditions, missing error handling and style inconsistencies. Rank findings by severity with file:line references and concrete fixes. Do not edit files.',
    },
    {
      name: 'researcher',
      source: 'builtin',
      description: 'Researches a topic on the web and summarises findings with sources.',
      tools: ['web_search', 'web_fetch', 'read_file'],
      systemPrompt:
        'You are a research agent. Use web_search then web_fetch the most relevant results. Cross-check at least two sources. Return a structured summary with citations (URLs) and note anything uncertain.',
    },
  ];
}
