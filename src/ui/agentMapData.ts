// The Agent map's model: every agent LocalPilot has (Auto, modes, specialists, subagents), the skills and tools they
// reach and the model each one runs on, as nodes and edges. Pure: built from plain configuration and registry
// snapshots (see agentMap.ts for where each comes from), so it is unit-tested without VS Code.
import { BY_KIND, TaskKind, TaskRoute } from '../agent/taskRouter';
import { SPECIALISTS } from '../agent/builtinAgents';
import { toolDisabled } from '../agent/toolAliases';
import { SPECIALIST_IDS, SpecialistId } from '../types';

export type NodeKind = 'auto' | 'role' | 'mode' | 'specialist' | 'subagent' | 'skill' | 'tools' | 'mcp';
export type RoleKey = 'agent' | 'reasoning' | 'fast' | 'coding' | 'vision';
export type ModeId = 'ask' | 'agent' | 'plan' | 'debug' | 'multitask';
export type ToolGroup = 'read' | 'write' | 'delete' | 'terminal' | 'network' | 'delegate';
export type ApprovalKind = 'terminal' | 'write' | 'delete' | 'network' | 'mcp';

/** The setting each model role is stored in (all under `localpilot.`). */
export const ROLE_SETTING: Record<RoleKey, string> = { agent: 'defaultModel', reasoning: 'routing.reasoning', fast: 'routing.fast', coding: 'routing.coding', vision: 'routing.vision' };
/** The approval setting of each tool group that asks (read and delegation tools never ask). */
export const APPROVAL_SETTING: Record<ApprovalKind, string> = { terminal: 'approvals.terminal', write: 'approvals.write', delete: 'approvals.delete', network: 'approvals.network', mcp: 'approvals.mcp' };
export const SKILLS_DISABLED_SETTING = 'skills.disabled';
export const TOOLS_DISABLED_SETTING = 'disabledTools';

const ROLES: { key: RoleKey; label: string; use: string; empty: string }[] = [
  { key: 'agent', label: 'Default model', use: 'Ask, Agent, Debug, Multitask and most specialists', empty: 'Best available model' },
  { key: 'reasoning', label: 'Reasoning', use: 'Plan mode, Architect and Review (when Auto picks them)', empty: 'Keeps the chat model' },
  { key: 'fast', label: 'Fast', use: 'Short questions in Auto and read-only subagents (explore, clarifier, planner, researcher)', empty: 'Smallest tool-capable model that fits' },
  { key: 'coding', label: 'Coding', use: 'Subagents that edit or run (coder, tester, debugger, docs)', empty: 'Keeps the chat model' },
  { key: 'vision', label: 'Vision', use: 'Turns with images when the chat model cannot see', empty: 'Best available vision model' },
];

interface ModeDef { label: string; desc: string; reads: 'yes'; edits: 'yes' | 'no' | 'workers'; runs: 'yes' | 'read-only'; role: RoleKey; groups: ToolGroup[]; mcp: 'all' | 'read-only' }
export const MODES: Record<ModeId, ModeDef> = {
  ask: { label: 'Ask', desc: 'Answers questions about the code. Reads, never edits; commands are limited to read-only ones.', reads: 'yes', edits: 'no', runs: 'read-only', role: 'agent', groups: ['read', 'terminal', 'network', 'delegate'], mcp: 'read-only' },
  agent: { label: 'Agent', desc: 'Makes the change end to end: reads, edits files, runs commands and checks its work.', reads: 'yes', edits: 'yes', runs: 'yes', role: 'agent', groups: ['read', 'write', 'delete', 'terminal', 'network', 'delegate'], mcp: 'all' },
  plan: { label: 'Plan', desc: 'Investigates and writes a plan to confirm before anything is built. Read-only.', reads: 'yes', edits: 'no', runs: 'read-only', role: 'reasoning', groups: ['read', 'terminal', 'network', 'delegate'], mcp: 'read-only' },
  debug: { label: 'Debug', desc: 'Reproduces a failure, finds the root cause, fixes it and verifies the fix.', reads: 'yes', edits: 'yes', runs: 'yes', role: 'agent', groups: ['read', 'write', 'delete', 'terminal', 'network', 'delegate'], mcp: 'all' },
  multitask: { label: 'Multitask', desc: 'Splits the work into independent tasks and runs them on parallel workers; only the workers edit files.', reads: 'yes', edits: 'workers', runs: 'yes', role: 'agent', groups: ['read', 'terminal', 'network', 'delegate'], mcp: 'read-only' },
};
const MODE_ORDER: ModeId[] = ['ask', 'agent', 'plan', 'debug', 'multitask'];

const GROUPS: Record<ToolGroup, { label: string; desc: string; approval?: ApprovalKind }> = {
  read: { label: 'Read & search', desc: 'Reading files, searching, symbols, diagnostics and editor state. Never asks.' },
  write: { label: 'Edit files', desc: 'Creating and editing files and notebooks.', approval: 'write' },
  delete: { label: 'Delete files', desc: 'Deleting files and folders.', approval: 'delete' },
  terminal: { label: 'Terminal', desc: 'Running shell commands.', approval: 'terminal' },
  network: { label: 'Web & browser', desc: 'Web search, fetching pages and the headless browser.', approval: 'network' },
  delegate: { label: 'Delegation & skills', desc: 'Starting subagents, loading skills, todos, memory and questions to you. Never asks.' },
};
const GROUP_ORDER: ToolGroup[] = ['read', 'write', 'delete', 'terminal', 'network', 'delegate'];
/** Tools that start other agents or load playbooks: they put a tool in the delegation group whatever else it is. */
const DELEGATION = /^(run_subagent|run_parallel_subagents|run_todos_parallel|load_skill|todo_\w+|update_todos|ask_user|memory_\w+|team_\w+)$/;

export const APPROVAL_OPTIONS: Record<ApprovalKind, { value: string; label: string }[]> = {
  terminal: [{ value: 'always', label: 'Always run' }, { value: 'safe', label: 'Run safe commands, ask otherwise' }, { value: 'ask', label: 'Ask every time' }, { value: 'never', label: 'Never run' }],
  write: [{ value: 'always', label: 'Always allow' }, { value: 'ask', label: 'Ask every time' }, { value: 'never', label: 'Never allow' }],
  delete: [{ value: 'always', label: 'Always allow' }, { value: 'ask', label: 'Ask every time' }, { value: 'never', label: 'Never allow' }],
  network: [{ value: 'always', label: 'Always allow' }, { value: 'ask', label: 'Ask every time' }, { value: 'never', label: 'Never allow' }],
  mcp: [{ value: 'always', label: 'Always allow' }, { value: 'ask', label: 'Ask every time' }, { value: 'never', label: 'Never allow' }],
};

// ------------------------------------------------------------------ inputs

export interface MapAgentInput { name: string; description: string; source: 'workspace' | 'user' | 'builtin'; tools?: string[]; model?: string; skills?: string[]; file?: string; plugin?: boolean }
export interface MapSkillInput { name: string; description: string; source: 'managed' | 'workspace' | 'user' | 'builtin'; disabled?: boolean; alwaysEnabled?: boolean; path: string; plugin?: boolean }
export interface MapToolInput { name: string; description: string; approvalKind?: ApprovalKind; readOnly?: boolean }
export interface MapMcpInput { name: string; state: string; tools: number; error?: string; source?: string; transport?: string }

/** Everything the map is drawn from: a snapshot of the configuration and registries (see agentMap.ts collect()). */
export interface MapInputs {
  defaultModel?: string;
  routing: { enabled: boolean; vision?: string; reasoning?: string; fast?: string; coding?: string };
  localOnly: boolean;
  /** The model each role resolves to right now (router decision), when one could be resolved. */
  resolved?: Partial<Record<RoleKey, string>>;
  /** Installed, enabled models: the choices of a role's model picker. */
  models?: { id: string; name?: string; remote?: boolean }[];
  agents: MapAgentInput[];
  skills: MapSkillInput[];
  /** Skill use the learner recorded: count and last use (ms). */
  skillUse?: Record<string, { count: number; last: number }>;
  tools: MapToolInput[];
  disabledTools: string[];
  approvals: Record<ApprovalKind, string>;
  mcp: MapMcpInput[];
  hasFolder?: boolean;
}

// ------------------------------------------------------------------ model

/** Something the inspector can do. `id` is what the webview sends back; the host maps it to a setting or command. */
export type MapAction =
  | { kind: 'select'; id: 'setRole' | 'setApproval'; label: string; arg: string; setting: string; value: string; options: { value: string; label: string }[] }
  | { kind: 'toggle'; id: 'toggleSkill' | 'toggleMcp' | 'toggleTool'; label: string; arg: string; setting: string; on: boolean; locked?: string }
  | { kind: 'button'; id: 'openFile' | 'openAgent' | 'restartMcp' | 'openSettings' | 'newAgent' | 'newSkill' | 'copyAgent'; label: string; arg?: string; icon?: string };

export interface MapItem { name: string; desc: string; on: boolean; action?: MapAction }

export interface MapNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Short second line: the model, source or status. */
  sub?: string;
  /** Layer of the layered layout: 0 Auto and roles · 1 modes · 2 subagents · 3 skills · 4 tools and MCP. */
  col: number;
  /** Heading the node sits under in its column and in the list view. */
  group: string;
  source?: string;
  /** off: switched off; warn: needs attention; error: failed. Always also said in words (`sub` / badges). */
  status?: 'on' | 'off' | 'warn' | 'error';
  badges: string[];
  desc: string;
  facts: [string, string][];
  /** Modes and specialists: what the agent may do. */
  can?: { reads: string; edits: string; runs: string };
  role?: RoleKey;
  model?: string;
  actions: MapAction[];
  /** Tools of a tool group / MCP server, with their on/off switches. */
  items?: MapItem[];
  /** Lower-case text the search box matches: name, kind, source, description. */
  search: string;
}

export type EdgeKind = 'route' | 'runs-in' | 'playbook' | 'delegate' | 'preload' | 'skill' | 'tool' | 'model';
export interface MapEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  /** main: always drawn · weak: drawn faint · focus: only drawn when one end is hovered, focused or selected. */
  tier: 'main' | 'weak' | 'focus';
}

export interface AgentMapModel {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Auto's routing table: kind of task → mode, specialist and model role. */
  routes: { kind: TaskKind; mode: ModeId; specialist?: SpecialistId; role: RoleKey; target: string }[];
  counts: { modes: number; specialists: number; subagents: number; customAgents: number; skills: number; skillsOn: number; tools: number; toolsOff: number; mcp: number; mcpConnected: number };
  localOnly: boolean;
  routingEnabled: boolean;
}

const KIND_LABEL: Record<TaskKind, string> = { question: 'a question', explain: 'explain code', project: 'about the whole project', plan: 'asks for a plan', architect: 'asks for a design', review: 'asks for a review', debug: 'describes an error', test: 'asks for tests', refactor: 'asks to restructure', terminal: 'asks to run commands', multitask: 'several independent tasks', code: 'asks for a change' };

const nodeId = {
  mode: (m: string) => `mode:${m}`,
  spec: (s: string) => `spec:${s}`,
  agent: (a: string) => `agent:${a}`,
  skill: (s: string) => `skill:${s}`,
  tools: (g: string) => `tools:${g}`,
  mcp: (s: string) => `mcp:${s}`,
  role: (r: string) => `role:${r}`,
};
export { nodeId };

/** Which tool group a tool belongs to. */
export function toolGroup(t: MapToolInput): ToolGroup {
  if (DELEGATION.test(t.name)) {
    return 'delegate';
  }
  switch (t.approvalKind) {
    case 'write':
    case 'delete':
    case 'terminal':
    case 'network':
      return t.approvalKind;
    default:
      return 'read';
  }
}

/** Builds the whole map. Deterministic: the same inputs give the same nodes and edges in the same order. */
export function buildAgentMap(i: MapInputs): AgentMapModel {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const has = new Set<string>();
  const add = (n: Omit<MapNode, 'search'>) => {
    nodes.push({ ...n, search: [n.label, n.kind, n.source ?? '', n.group, n.desc, n.sub ?? '', ...n.badges].join(' ').toLowerCase() });
    has.add(n.id);
  };
  const edge = (e: MapEdge) => {
    if (has.has(e.from) && has.has(e.to) && !edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)) {
      edges.push(e);
    }
  };
  const short = (ref?: string) => (ref ? ref.split('/').slice(1).join('/') || ref : undefined);
  const disabledTool = (name: string) => toolDisabled(name, i.disabledTools);
  const toolOn = (name: string) => i.tools.some((t) => t.name === name) && !disabledTool(name);
  const modelOptions = (key: RoleKey) => [
    { value: '', label: `Automatic: ${ROLES.find((r) => r.key === key)!.empty.toLowerCase()}` },
    ...(key === 'fast' ? [{ value: 'session', label: 'Always the chat model' }] : []),
    ...(i.models ?? []).map((m) => ({ value: m.id, label: `${m.name ?? m.id}${m.remote ? ' (cloud)' : ''}` })),
  ];
  const roleValue = (key: RoleKey): string | undefined => (key === 'agent' ? i.defaultModel : i.routing[key]);

  // ---- Auto
  const routes = (Object.keys(BY_KIND) as TaskKind[]).map((kind) => {
    const r = BY_KIND[kind];
    return { kind, mode: r.mode as ModeId, ...(r.specialist ? { specialist: r.specialist } : {}), role: r.role as RoleKey, target: r.specialist ? nodeId.spec(r.specialist) : nodeId.mode(r.mode) };
  });
  add({
    id: 'auto',
    kind: 'auto',
    label: 'Auto',
    sub: 'Routes each message',
    col: 0,
    group: 'Auto',
    badges: [],
    desc: 'Auto reads each message (offline, no model call) and picks the mode, specialist and model role that fit it. Short questions with nothing attached go to the Fast role.',
    facts: routes.map((r) => [KIND_LABEL[r.kind], `${r.specialist ? SPECIALISTS[r.specialist].label : MODES[r.mode].label} · ${r.role}`]),
    actions: [{ kind: 'button', id: 'openSettings', label: 'Model routing settings', arg: 'models', icon: 'gear' }],
  });

  // ---- Model roles
  for (const r of ROLES) {
    const value = roleValue(r.key);
    const resolved = i.resolved?.[r.key];
    const enabled = r.key === 'agent' || i.routing.enabled;
    add({
      id: nodeId.role(r.key),
      kind: 'role',
      label: r.label,
      sub: value === 'session' ? 'Chat model' : short(value) ?? (resolved ? `Auto → ${short(resolved)}` : 'Automatic'),
      col: 0,
      group: 'Model roles',
      status: enabled ? undefined : 'off',
      badges: [...(value ? ['set'] : ['automatic']), ...(enabled ? [] : ['routing off']), ...(i.localOnly && r.key !== 'agent' ? ['local only'] : [])],
      desc: `Used for: ${r.use}.`,
      facts: [
        ['Setting', `localpilot.${ROLE_SETTING[r.key]}`],
        ['Configured', value || `(empty) ${r.empty}`],
        ['Resolves to now', resolved ?? 'No model available'],
        ...(i.localOnly ? [['Local only', 'Automatic picks stay on this machine'] as [string, string]] : []),
      ],
      role: r.key,
      model: resolved,
      actions: [{ kind: 'select', id: 'setRole', label: 'Model', arg: r.key, setting: ROLE_SETTING[r.key], value: value ?? '', options: modelOptions(r.key) }],
    });
  }

  // ---- Modes and specialists
  const roleSub = (role: RoleKey) => {
    const m = i.resolved?.[role] ?? roleValue(role);
    return `${role} role${m ? ` · ${short(m)}` : ''}`;
  };
  const canOf = (d: { reads: string; edits: string; runs: string }) => ({ reads: d.reads === 'yes' ? 'Yes' : 'No', edits: d.edits === 'yes' ? 'Yes' : d.edits === 'workers' ? 'Through its workers' : 'No', runs: d.runs === 'yes' ? 'Yes' : 'Read-only commands' });
  for (const m of MODE_ORDER) {
    const d = MODES[m];
    const kinds = routes.filter((r) => r.target === nodeId.mode(m)).map((r) => KIND_LABEL[r.kind]);
    add({
      id: nodeId.mode(m),
      kind: 'mode',
      label: d.label,
      sub: roleSub(d.role),
      col: 1,
      group: 'Modes',
      badges: [d.edits === 'yes' ? 'edits' : d.edits === 'workers' ? 'workers edit' : 'read-only'],
      desc: d.desc,
      facts: [['Model role', d.role], ...(kinds.length ? [['Auto picks it for', kinds.join(', ')] as [string, string]] : [])],
      can: canOf(d),
      role: d.role,
      model: i.resolved?.[d.role],
      actions: [],
    });
  }
  for (const s of SPECIALIST_IDS) {
    const d = SPECIALISTS[s];
    const base = MODES[d.base as ModeId];
    const route = routes.find((r) => r.specialist === s);
    const role = route?.role ?? base.role;
    add({
      id: nodeId.spec(s),
      kind: 'specialist',
      label: d.label,
      sub: `${base.label} mode · ${roleSub(role)}`,
      col: 1,
      group: 'Specialists',
      badges: [base.edits === 'yes' ? 'edits' : 'read-only'],
      desc: d.brief,
      facts: [['Runs in', `${base.label} mode`], ['Playbook', d.agent ? `${d.agent} subagent` : 'none (brief only)'], ['Model role', role], ...(route ? [['Auto picks it when a message', KIND_LABEL[route.kind]] as [string, string]] : [])],
      can: canOf(base),
      role,
      model: i.resolved?.[role],
      actions: [],
    });
  }

  // ---- Subagents
  const MUTATING = /^(edit_file|apply_patch|write_file|notebook_edit|create_directory|delete_path|run_command|run_subagent|run_parallel_subagents|run_todos_parallel)$/;
  const agentRole = (a: MapAgentInput): RoleKey => (a.tools && !a.tools.some((t) => MUTATING.test(t)) ? 'fast' : 'coding');
  const custom = i.agents.filter((a) => a.source !== 'builtin');
  const agentList = [...i.agents.filter((a) => a.source === 'builtin'), ...custom];
  for (const a of agentList) {
    const role = agentRole(a);
    const src = a.plugin ? 'plugin' : a.source;
    const usedBy = SPECIALIST_IDS.filter((s) => SPECIALISTS[s].agent === a.name).map((s) => SPECIALISTS[s].label);
    const modelLine = a.model ? a.model : role === 'fast' ? `fast role${i.resolved?.fast ? ` → ${i.resolved.fast}` : ''}` : `coding role${i.resolved?.coding ? ` → ${i.resolved.coding}` : ''}`;
    add({
      id: nodeId.agent(a.name),
      kind: 'subagent',
      label: a.name,
      sub: `${src} · ${a.model ? short(a.model) : `${role} role`}`,
      col: 2,
      group: a.source === 'builtin' ? 'Built-in subagents' : 'Your subagents',
      source: src,
      badges: [src, ...(a.tools ? [a.tools.some((t) => MUTATING.test(t)) ? 'restricted tools' : 'read-only'] : ['all tools'])],
      desc: a.description || '(no description)',
      facts: [
        ['Source', src + (a.file ? ` · ${a.file}` : '')],
        ['Model', modelLine],
        ['Tools', a.tools ? (a.tools.length ? a.tools.join(', ') : 'none') : "All of the parent mode's tools"],
        ...(a.skills?.length ? [['Preloads skills', a.skills.join(', ')] as [string, string]] : []),
        ...(usedBy.length ? [['Playbook of', usedBy.join(', ')] as [string, string]] : []),
        ['Started by', toolOn('run_subagent') || toolOn('run_parallel_subagents') ? 'Any mode (read-only in Ask and Plan)' : 'Nobody: run_subagent is switched off'],
      ],
      role: a.model ? undefined : role,
      model: a.model ?? i.resolved?.[role],
      actions: a.source === 'builtin'
        ? [{ kind: 'button', id: 'copyAgent', label: 'Customize (copy to workspace)', arg: a.name, icon: 'edit' }]
        : [{ kind: 'button', id: 'openAgent', label: 'Edit agent file', arg: a.name, icon: 'edit' }],
    });
  }

  // ---- Skills
  const skillList = [...i.skills].sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled) || order(a.source) - order(b.source) || a.name.localeCompare(b.name));
  const loadSkillOn = toolOn('load_skill');
  for (const s of skillList) {
    const src = s.plugin ? 'plugin' : s.source;
    const use = i.skillUse?.[s.name];
    const preloadedBy = i.agents.filter((a) => a.skills?.includes(s.name)).map((a) => a.name);
    add({
      id: nodeId.skill(s.name),
      kind: 'skill',
      label: s.name,
      sub: `${src}${s.disabled ? ' · off' : ''}${use?.count ? ` · used ${use.count}×` : ''}`,
      col: 3,
      group: 'Skills',
      source: src,
      status: s.disabled ? 'off' : undefined,
      badges: [src, s.disabled ? 'disabled' : 'enabled', ...(s.alwaysEnabled ? ['always on'] : [])],
      desc: s.description || '(no description)',
      facts: [
        ['Source', `${src} · ${s.path}`],
        ['State', s.disabled ? 'Disabled: the agent does not see it' : s.alwaysEnabled ? 'Always on (required by your organization)' : 'Enabled'],
        ['Loaded by', s.disabled ? 'Nobody while disabled' : loadSkillOn ? 'Every mode and every subagent with load_skill, on demand' : 'Nobody: load_skill is switched off'],
        ...(preloadedBy.length ? [['Preloaded by', preloadedBy.join(', ')] as [string, string]] : []),
        ['Recent use', use?.count ? `${use.count} time${use.count === 1 ? '' : 's'}${use.last ? `, last ${new Date(use.last).toISOString().slice(0, 10)}` : ''}` : 'Not used yet'],
        ['Pin', 'Pin it for one chat from that chat’s Skills menu, or type /skill'],
      ],
      actions: [
        { kind: 'toggle', id: 'toggleSkill', label: 'Enabled', arg: s.name, setting: SKILLS_DISABLED_SETTING, on: !s.disabled, ...(s.alwaysEnabled ? { locked: 'Required by your organization' } : {}) },
        { kind: 'button', id: 'openFile', label: 'Open SKILL.md', arg: s.path, icon: 'file' },
      ],
    });
  }

  // ---- Tools (by group) and MCP servers
  const own = i.tools.filter((t) => !t.name.startsWith('mcp_'));
  for (const g of GROUP_ORDER) {
    const list = own.filter((t) => toolGroup(t) === g).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) {
      continue;
    }
    const meta = GROUPS[g];
    const off = list.filter((t) => disabledTool(t.name)).length;
    const level = meta.approval ? i.approvals[meta.approval] : undefined;
    add({
      id: nodeId.tools(g),
      kind: 'tools',
      label: meta.label,
      sub: `${list.length - off}/${list.length} on${level ? ` · ${approvalWord(level)}` : ' · no approval'}`,
      col: 4,
      group: 'Tools',
      status: off === list.length ? 'off' : level === 'never' ? 'off' : undefined,
      badges: [level ? `approval: ${level}` : 'never asks', ...(off ? [`${off} off`] : [])],
      desc: meta.desc,
      facts: [['Tools', String(list.length)], ['Switched off', off ? String(off) : 'none'], ...(meta.approval ? [['Approval setting', `localpilot.${APPROVAL_SETTING[meta.approval]}`] as [string, string]] : [])],
      items: list.map((t) => ({ name: t.name, desc: t.description, on: !disabledTool(t.name), action: { kind: 'toggle', id: 'toggleTool', label: t.name, arg: t.name, setting: TOOLS_DISABLED_SETTING, on: !disabledTool(t.name), ...(disabledTool(t.name) && !i.disabledTools.includes(t.name) ? { locked: 'Switched off by a pattern in localpilot.disabledTools' } : {}) } })),
      actions: meta.approval ? [{ kind: 'select', id: 'setApproval', label: 'Approval', arg: meta.approval, setting: APPROVAL_SETTING[meta.approval], value: level ?? '', options: APPROVAL_OPTIONS[meta.approval] }] : [],
    });
  }
  for (const s of [...i.mcp].sort((a, b) => a.name.localeCompare(b.name))) {
    const managed = s.source === 'managed' || s.source === 'plugin';
    const on = s.state !== 'disabled';
    const status: MapNode['status'] = !on ? 'off' : s.state === 'error' ? 'error' : s.state === 'auth_required' ? 'warn' : undefined;
    add({
      id: nodeId.mcp(s.name),
      kind: 'mcp',
      label: s.name,
      sub: `${stateWord(s.state)} · ${s.tools} tool${s.tools === 1 ? '' : 's'}`,
      col: 4,
      group: 'MCP servers',
      source: s.source,
      status,
      badges: ['MCP', stateWord(s.state), ...(s.source ? [s.source] : [])],
      desc: s.error ? `Error: ${s.error}` : `MCP server${s.transport ? ` (${s.transport})` : ''}. Its tools follow the MCP approval setting unless a per-tool rule says otherwise.`,
      facts: [['State', stateWord(s.state)], ['Tools', String(s.tools)], ['Approval', `${approvalWord(i.approvals.mcp)} (localpilot.approvals.mcp)`], ...(s.source ? [['Configured in', s.source] as [string, string]] : [])],
      actions: [
        { kind: 'toggle', id: 'toggleMcp', label: 'Enabled', arg: s.name, setting: 'mcpServers', on, ...(s.source === 'plugin' ? { locked: 'Comes from a plugin: switch the plugin off instead' } : {}) },
        ...(on ? [{ kind: 'button' as const, id: 'restartMcp' as const, label: 'Restart', arg: s.name, icon: 'refresh' }] : []),
        { kind: 'select', id: 'setApproval', label: 'Approval (all MCP tools)', arg: 'mcp', setting: APPROVAL_SETTING.mcp, value: i.approvals.mcp, options: APPROVAL_OPTIONS.mcp },
        ...(managed ? [] : [{ kind: 'button' as const, id: 'openSettings' as const, label: 'Server settings', arg: 'mcp', icon: 'gear' }]),
      ],
    });
  }

  // ---- Edges
  for (const r of routes) {
    const kinds = routes.filter((x) => x.target === r.target).map((x) => KIND_LABEL[x.kind]);
    edge({ from: 'auto', to: r.target, kind: 'route', label: kinds.join(', '), tier: 'main' });
  }
  for (const s of SPECIALIST_IDS) {
    const d = SPECIALISTS[s];
    edge({ from: nodeId.spec(s), to: nodeId.mode(d.base), kind: 'runs-in', tier: 'focus' });
    if (d.agent) {
      edge({ from: nodeId.spec(s), to: nodeId.agent(d.agent), kind: 'playbook', label: 'playbook', tier: 'main' });
    }
  }
  const delegates = toolOn('run_subagent') || toolOn('run_parallel_subagents');
  const groupsPresent = GROUP_ORDER.filter((g) => has.has(nodeId.tools(g)));
  for (const m of MODE_ORDER) {
    const d = MODES[m];
    edge({ from: nodeId.mode(m), to: nodeId.role(d.role), kind: 'model', tier: 'focus' });
    if (delegates) {
      for (const a of agentList) {
        edge({ from: nodeId.mode(m), to: nodeId.agent(a.name), kind: 'delegate', label: d.edits === 'no' ? 'read-only' : undefined, tier: m === 'agent' || m === 'multitask' ? 'weak' : 'focus' });
      }
    }
    if (loadSkillOn) {
      skillList.filter((s) => !s.disabled).forEach((s) => edge({ from: nodeId.mode(m), to: nodeId.skill(s.name), kind: 'skill', tier: 'focus' }));
    }
    d.groups.filter((g) => groupsPresent.includes(g)).forEach((g) => edge({ from: nodeId.mode(m), to: nodeId.tools(g), kind: 'tool', tier: 'focus' }));
    i.mcp.forEach((s) => edge({ from: nodeId.mode(m), to: nodeId.mcp(s.name), kind: 'tool', label: d.mcp === 'read-only' ? 'read-only tools' : undefined, tier: 'focus' }));
  }
  for (const s of SPECIALIST_IDS) {
    const role = routes.find((r) => r.specialist === s)?.role ?? MODES[SPECIALISTS[s].base as ModeId].role;
    edge({ from: nodeId.spec(s), to: nodeId.role(role), kind: 'model', tier: 'focus' });
  }
  for (const a of agentList) {
    const id = nodeId.agent(a.name);
    if (!a.model) {
      edge({ from: id, to: nodeId.role(agentRole(a)), kind: 'model', tier: 'focus' });
    }
    (a.skills ?? []).forEach((s) => edge({ from: id, to: nodeId.skill(s), kind: 'preload', label: 'preloads', tier: 'main' }));
    const canLoad = !a.tools || a.tools.includes('load_skill');
    if (canLoad && loadSkillOn) {
      skillList.filter((s) => !s.disabled).forEach((s) => edge({ from: id, to: nodeId.skill(s.name), kind: 'skill', tier: 'focus' }));
    }
    for (const g of groupsPresent) {
      const inGroup = own.filter((t) => toolGroup(t) === g).map((t) => t.name);
      if (!a.tools || a.tools.some((t) => inGroup.includes(t))) {
        edge({ from: id, to: nodeId.tools(g), kind: 'tool', tier: 'focus' });
      }
    }
    for (const s of i.mcp) {
      if (!a.tools || a.tools.some((t) => t.startsWith(`mcp__${s.name}`) || t.startsWith(`mcp_${s.name}`))) {
        edge({ from: id, to: nodeId.mcp(s.name), kind: 'tool', tier: 'focus' });
      }
    }
  }

  const skillsOn = i.skills.filter((s) => !s.disabled).length;
  return {
    nodes,
    edges,
    routes,
    counts: {
      modes: MODE_ORDER.length,
      specialists: SPECIALIST_IDS.length,
      subagents: i.agents.length,
      customAgents: custom.length,
      skills: i.skills.length,
      skillsOn,
      tools: own.length,
      toolsOff: own.filter((t) => disabledTool(t.name)).length,
      mcp: i.mcp.length,
      mcpConnected: i.mcp.filter((s) => s.state === 'connected').length,
    },
    localOnly: i.localOnly,
    routingEnabled: i.routing.enabled,
  };
}

function order(source: string): number {
  return ['managed', 'workspace', 'user', 'builtin'].indexOf(source);
}

function approvalWord(v: string): string {
  return v === 'always' ? 'runs without asking' : v === 'safe' ? 'asks unless safe' : v === 'ask' ? 'asks first' : v === 'never' ? 'blocked' : v;
}

function stateWord(s: string): string {
  return s === 'auth_required' ? 'sign-in needed' : s;
}

/** The node ids a routed message passes through: Auto → specialist (→ its playbook) or mode → model role. */
export function routePath(r: Pick<TaskRoute, 'mode' | 'specialist' | 'role'>): string[] {
  const role = (['agent', 'reasoning', 'fast', 'vision'] as string[]).includes(r.role) ? r.role : 'agent';
  const path = ['auto'];
  if (r.specialist) {
    path.push(nodeId.spec(r.specialist), nodeId.mode(r.mode));
    const agent = SPECIALISTS[r.specialist].agent;
    if (agent) {
      path.push(nodeId.agent(agent));
    }
  } else {
    path.push(nodeId.mode(r.mode));
  }
  path.push(nodeId.role(role));
  return path;
}

/** The label Auto shows for a route ("Review", "Debug"). */
export function routeTarget(r: Pick<TaskRoute, 'mode' | 'specialist'>): string {
  return r.specialist ? SPECIALISTS[r.specialist].label : MODES[r.mode as ModeId]?.label ?? r.mode;
}

/** Valid file name for a new subagent or skill: lower-case words joined by dashes. */
export function slugName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** A starter subagent file (`.localpilot/agents/<name>.md`) in the format the agent loader reads. */
export function agentTemplate(name: string, base?: { description: string; tools?: string[]; systemPrompt: string }): string {
  const tools = base?.tools?.length ? `tools: ${base.tools.join(', ')}\n` : '# tools: read_file, grep_search, file_search, edit_file, run_command   (leave out for all tools)\n';
  return `---\nname: ${name}\ndescription: ${base?.description ?? 'What this agent does and when to delegate to it, in one sentence.'}\n${tools}# model: ollama/qwen2.5-coder:14b   (leave out to follow the routing roles)\n# skills: my-skill   (skills preloaded into every run)\n---\n${base?.systemPrompt ?? `You are the ${name} agent.\n- Read the relevant code before changing anything.\n- Do the task in the brief, verify it, and finish with one self-contained report: what you did, with file paths and line numbers, and what you could not verify.`}\n`;
}

/** A starter skill (`.localpilot/skills/<name>/SKILL.md`). */
export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: When to use this skill, in one sentence with two or three quoted trigger phrases.\n---\n# ${name}\n\n1. First step: the command to run or the files to read.\n2. The change to make, and the patterns of this project it follows.\n3. How to verify it worked.\n`;
}
