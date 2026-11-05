import { getConfig } from '../config';
import { AgentEvent, ChatMessage, Session, TodoItem, Tool, ToolContext, ToolDefinition, ToolResult } from '../types';
import { AgentRunner, ApprovalHandler, claimsChange } from './agentLoop';
import { nextWave, ParallelPool } from './parallel';
import { RunControl } from './runControl';
import { SkillManager } from './skills';
import { newId } from '../providers/http';
import { classifyModelError } from './resilience';
import { resolveAgentName, routeSubagent } from './builtinAgents';
import { agentToolFilter } from './toolAliases';
import { findRepo } from './repos';
import { reposFor } from '../tools/repos';
import { releaseIntegratedTerminal } from '../tools/terminal';
import { ChildWrites, childMutated, childRecovery, isHealingSynthetic, verificationLine } from './childEvents';

/** Appended to every subagent persona (built-in or custom). */
const SUBAGENT_CONTRACT = `# You are a subagent
- The parent agent only sees your final message, and there is no user to answer questions: never call ask_user and never end with a question. If the brief is ambiguous, call gather_context and read the relevant code, choose the most plausible interpretation, state it under "Interpretation" at the top of your report, and carry on.
- Treat typos and shorthand in the brief charitably; verify against the code rather than taking names literally.
- Finish by writing one complete, self-contained final report (paths with line numbers, what you verified, what you could not).`;

/**
 * Tools that let the main agent delegate work: load_skill (progressive disclosure of skill instructions),
 * run_subagent (one isolated child agent with its own context window) and run_parallel_subagents
 * (fan-out several children concurrently and collect their reports).
 */
export type ScopedApprovalHandler = (sessionId: string, ...args: Parameters<ApprovalHandler>) => ReturnType<ApprovalHandler>;

/** Tools whose effects a from-scratch rerun on another model would repeat. */
const MUTATING_TOOLS = new Set(['edit_file', 'apply_patch', 'write_file', 'notebook_edit', 'create_directory', 'delete_path', 'run_command', 'git_commit', 'run_subagent', 'run_parallel_subagents', 'run_todos_parallel']);

const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export function createAgentTools(runner: AgentRunner, skills: SkillManager, emit: (e: AgentEvent) => void, approval: ScopedApprovalHandler): Tool[] {
  const loadSkill: Tool = {
    parallelSafe: true,
    // The allowed names are read on every access so the definition the model sees always matches what is installed
    // and enabled — a static list would invite calls for skills that no longer exist.
    get definition(): ToolDefinition {
      const names = skills.enabledSkills.map((s) => s.name);
      return {
        name: 'load_skill',
        description:
          'Load the full step-by-step instructions of an installed skill (expert playbook) so you can follow them. Call it FIRST, before other tools, when the task matches a skill listed under "Available skills" — and only with a name from that list; never invent one. Skip it when the skill was already loaded in this conversation. After loading, carry out the steps with the tools; do not just summarise them.',
        parameters: {
          type: 'object' as const,
          properties: {
            name: {
              type: 'string',
              description: names.length ? `Exact skill name from the Available skills list. Currently installed: ${names.join(', ')}.` : 'Exact skill name from the Available skills list (none are installed right now).',
              ...(names.length && names.length <= 40 ? { enum: names } : {}),
            },
          },
          required: ['name'],
        },
      };
    },
    async execute(args) {
      const raw = String(args.name ?? '').trim();
      const resolved = skills.resolveSkill(raw);
      if (!resolved) {
        const disabled = skills.getSkill(raw)?.disabled;
        const similar = skills.similarSkillNames(raw);
        const available = skills.enabledSkills.map((s) => s.name);
        return {
          content: disabled
            ? `The skill "${raw}" is disabled by the user and must not be used. Continue without it.`
            : `Unknown skill "${raw}".${similar.length ? ` Did you mean: ${similar.join(', ')}?` : ''} Only these skills exist: ${available.join(', ') || '(none)'}. Do not invent skill names — if none applies, continue with the ordinary tools.`,
          isError: true,
        };
      }
      const body = await skills.loadSkillBody(resolved.skill.name);
      const note = resolved.exact ? '' : `(Resolved "${raw}" to the installed skill "${resolved.skill.name}".)\n`;
      return { content: `${note}${body}\n\nThe skill "${resolved.skill.name}" is now loaded. Carry out each step above with the tools (write_file, edit_file, run_command, …) before replying — do not answer until the steps have actually been executed and their results confirm it. Do not call load_skill for this skill again.` };
    },
  };

  const runSubagent: Tool = {
    definition: {
      name: 'run_subagent',
      description:
        'Delegate a self-contained task to a subagent that runs with its own fresh context window and returns a final report. Use for exploration, research, planning, reviews, testing, debugging or isolated implementation work. The subagent cannot see this conversation or ask the user anything, so include all necessary context (files, symbols, acceptance criteria) in the prompt. Vague brief? Delegate to "clarifier" first, or call gather_context yourself.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Subagent name (see Available subagents): "clarifier", "explore", "planner", "coder", "tester", "debugger", "reviewer", "docs", "researcher" or a custom one. Common aliases ("review", "debug", "test") are accepted.' },
          prompt: { type: 'string', description: 'Complete, self-contained task description: goal, relevant files/symbols, constraints, and exactly what to return' },
          model: { type: 'string', description: 'Optional provider/model override' },
          skills: { type: 'array', items: { type: 'string' }, description: 'Optional: installed skill names whose instructions the subagent must follow (loaded into its brief). Skills you are working with are passed on automatically.' },
        },
        required: ['agent', 'prompt'],
      },
    },
    async execute(args, ctx) {
      return runChild(String(args.agent), String(args.prompt), typeof args.model === 'string' ? args.model : undefined, ctx, undefined, strList(args.skills));
    },
  };

  const runParallel: Tool = {
    definition: {
      name: 'run_parallel_subagents',
      description: 'Run several independent subagent tasks concurrently and return all reports. Ideal for investigating multiple files/areas at once or splitting a large change into independent pieces.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Independent tasks to run in parallel',
            items: {
              type: 'object',
              properties: { agent: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, skills: { type: 'array', items: { type: 'string' }, description: 'Optional installed skill names this task must follow' }, repo: { type: 'string', description: 'Optional repository name (see the repos tool): the subagent works inside that repository instead of this workspace' }},
              required: ['agent', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    async execute(args, ctx) {
      let raw = args.tasks;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch {
          // reported below as not an array
        }
      }
      const given = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      if (!given.length) {
        return { content: 'tasks must be a non-empty array', isError: true };
      }
      // Validate every task before any child runs: one malformed task must not throw away the others' reports.
      const tasks = given.map((t) => ({ ...(t && typeof t === 'object' ? t : {}), prompt: t?.prompt ?? t?.task ?? t?.description })) as { agent: string; prompt: string; model?: string; skills?: unknown; repo?: unknown; origin?: unknown }[];
      const invalid = tasks.map((t, i) => (typeof t.agent === 'string' && t.agent.trim() && typeof t.prompt === 'string' && t.prompt.trim() ? '' : `task ${i + 1}: needs "agent" and "prompt" strings`)).filter(Boolean);
      if (invalid.length) {
        return { content: `${invalid.join('; ')}. Nothing was run.`, isError: true };
      }
      // Tasks for other repositories run with that repository as their workspace (multi-repository work).
      const repos = tasks.some((t) => typeof t.repo === 'string' && t.repo.trim()) ? reposFor(ctx) : [];
      const roots = tasks.map((t) => (typeof t.repo === 'string' && t.repo.trim() ? findRepo(repos, t.repo) : undefined));
      const missing = tasks.map((t, i) => (typeof t.repo === 'string' && t.repo.trim() && !roots[i] ? t.repo : '')).filter(Boolean);
      if (missing.length) {
        return { content: `Unknown repositor${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}. Known: ${repos.map((r) => r.name).join(', ') || '(none — see the repos tool)'}.`, isError: true };
      }
      const pool = new ParallelPool(getConfig().parallel.maxConcurrency);
      // A subagent in another repository is told where it is: paths it writes are relative to that repository's root.
      const inRepo = (t: (typeof tasks)[number], i: number) => (roots[i] ? `You are working in the repository "${roots[i]!.name}" (${roots[i]!.path}). Every relative path is relative to that repository's root: write "server.js", not "${roots[i]!.name}/server.js". Make and verify the change there.\n\n${t.prompt}` : t.prompt);
      // `origin: 'healing'` is honoured only on the engine's synthetic call; a model passing it gets an ordinary worker.
      const origin = isHealingSynthetic(ctx) ? 'healing' : undefined;
      const settled = await pool.map(tasks, (t, i) => runChild(t.agent, inRepo(t, i), t.model, roots[i] ? { ...ctx, workspaceRoot: roots[i]!.path, isolatedFrom: undefined } : ctx, roots[i]?.name, strList(t.skills), origin && t.origin === 'healing' ? origin : undefined));
      const out = settled.map((r, i) => {
        const header = `## Task ${i + 1} (${tasks[i].agent}${roots[i] ? ` in ${roots[i]!.name}` : ''}): ${String(tasks[i].prompt ?? '').slice(0, 80)}`;
        return r.status === 'fulfilled' ? `${header}\n${r.value.content}` : `${header}\nFAILED: ${String(r.reason)}`;
      });
      const writtenFiles = [...new Set(settled.flatMap((r) => (r.status === 'fulfilled' ? (r.value.data?.writtenFiles ?? []) : [])))];
      return { content: out.join('\n\n'), isError: settled.every((r) => r.status === 'rejected' || r.value.isError), data: writtenFiles.length ? { writtenFiles } : undefined };
    },
  };

  /** The agent names in `requested` that match no installed subagent, plus the names that do exist. */
  const unknownAgents = (requested: string[]): { unknown: string[]; available: string[] } => {
    const available = skills.allAgents.map((a) => a.name);
    return { unknown: [...new Set(requested.filter((n) => !resolveAgentName(n, available)))], available };
  };

  async function runChild(agentName: string, prompt: string, modelRef: string | undefined, ctx: ToolContext, label?: string, extraSkills?: string[], origin?: 'healing'): Promise<ToolResult & { data?: { writtenFiles: string[] } }> {
    if (ctx.signal.aborted) {
      return { content: 'Not started: the user stopped the run.', isError: true };
    }
    const cfg = getConfig();
    if (ctx.depth >= cfg.parallel.maxSubagentDepth) {
      return { content: `Subagent depth limit (${cfg.parallel.maxSubagentDepth}) reached; do the work directly instead.`, isError: true };
    }
    if (!prompt.trim()) {
      return { content: 'The subagent prompt is empty. Describe the goal, the relevant files/symbols and what to return.', isError: true };
    }
    const available = skills.allAgents.map((a) => a.name);
    const resolved = resolveAgentName(agentName, available);
    const def = resolved ? skills.getAgent(resolved) : undefined;
    if (!def) {
      return { content: `Unknown subagent "${agentName}". Available: ${available.join(', ')}. Call again with one of these names.`, isError: true };
    }
    const childId = `${ctx.sessionId}::${def.name}::${newId('sub')}`;
    const { role, modelRef: routedModel } = routeSubagent(def, modelRef, ctx.modelRef, cfg.routing);
    const child: Session = {
      id: childId,
      title: `${def.name}: ${prompt.slice(0, 40)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: routedModel ?? '',
      messageCount: 0,
      messages: [],
      contextTokens: 0,
      compactions: 0,
      // A read-only parent (Plan/Ask) only ever spawns read-only children, whatever persona was asked for.
      mode: ctx.readOnly ? 'ask' : 'agent',
      attachments: [],
    };
    // Own control under the parent's: pausing/stopping the parent reaches this child, while the user can also
    // pause or stop just this lane — the parent then carries on with a "stopped" report instead of failing.
    // Registered before subagent_start so a UI reacting to that event can already address the child.
    const control = ctx.control ? ctx.control.child(childId, label ? `${def.name} · ${label}` : def.name) : new RunControl(childId, undefined, ctx.signal, label ? `${def.name} · ${label}` : def.name);
    emit({ sessionId: ctx.sessionId, type: 'subagent_start', payload: { childId, agent: def.name, prompt, model: child.model || undefined, label: label || undefined, origin } });
    const announcedModel = child.model;
    const user: ChatMessage = { role: 'user', content: prompt };
    // The router may have picked a different (smaller) model for a read-only child. If that model stalls or cannot
    // be reached, run the child again on the parent's model instead of losing the lane — a broken small model must
    // not take the whole swarm down.
    // Read-only children leave the choice to the router (child.model is empty here); it fills child.model in.
    const routedElsewhere = !modelRef && !def.model && !routedModel && !!ctx.modelRef;
    // The model came from the task or the agent file: that is a choice, never spread. Inherited from the parent (or
    // left to the router): when it is saturated the router may run this worker on a comparable idle model instead.
    const spreadable = !modelRef && !def.model;
    let fellBack = false;
    /** True once the child changed something (edited, ran a command, delegated): it can no longer start over elsewhere. */
    let mutated = false;
    /** False when the child's turn hit its step limit instead of reaching a final answer. */
    let completed = true;
    /** The worker's self-healing verdict (`turn_end.payload.recovery`), reported with its result. */
    let recovery: Record<string, unknown> | undefined;
    /** Files the child (or its own children) wrote: reported so the root session's healing engine can track them. */
    const writes = new ChildWrites(ctx.workspaceRoot);
    const written = () => {
      const files = writes.list();
      return files.length ? files : undefined;
    };
    const result = (content: string, isError?: boolean) => {
      const writtenFiles = written();
      return { content, isError, data: writtenFiles ? { writtenFiles } : undefined };
    };
    const attempt = () =>
      runner.run({
        session: child,
        userMessage: user,
        modelRef: child.model || undefined,
        role,
        // Only engine-started fixers run their own healing engine (worker mode); other children just route writes.
        healingRole: origin === 'healing' ? 'fixer' : undefined,
        spreadModels: spreadable && !fellBack,
        // Agents registered from other sources may still name Claude Code or Cline tools.
        // Claude `mcp__…` entries are also kept as written: they are matched against the names MCP tools were registered under.
        toolFilter: def.tools && agentToolFilter(def.tools),
        roleOverride: `${def.systemPrompt}\n\n${SUBAGENT_CONTRACT}`,
        // The parent's active skills, the agent file's `skills:` and anything the task named: the swarm follows one playbook.
        skills: [...new Set([...(ctx.skills ?? []), ...(def.skills ?? []), ...(extraSkills ?? [])])],
        workspaceRoot: ctx.workspaceRoot,
        isolatedFrom: ctx.isolatedFrom,
        depth: ctx.depth + 1,
        // Every request the child (or its own children) makes is booked into the parent chat as subagent usage.
        onUsage: (u, m, p) => ctx.recordUsage?.(u, m, p),
        signal: control.signal,
        control,
        requestApproval: (title, detail, kind, opts) => approval(ctx.sessionId, title, detail, kind, opts),
        // Child progress is forwarded under the parent's session id so the UI can nest it. The wrapper puts the child's
        // own payload under `payload.data`: its tool `origin` and `recovery` fields are read there, not top-level.
        emit: (e) => {
          writes.note(e);
          if (e.type === 'turn_end') {
            completed = (e.payload as { completed?: boolean } | undefined)?.completed !== false;
            recovery = childRecovery(e.payload) ?? recovery;
          } else if (childMutated(e, MUTATING_TOOLS)) {
            // Engine-run verification commands (origin 'healing') neither block the fall-back nor back a claim.
            mutated = true;
          }
          emit({ ...e, sessionId: ctx.sessionId, payload: { childId, agent: def.name, inner: e.type, data: e.payload }, type: e.type === 'turn_end' ? 'status' : e.type === 'assistant_delta' || e.type === 'thinking_delta' ? 'status' : e.type });
        },
        maxIterations: 25,
        maxModelRetries: routedElsewhere && !fellBack ? 0 : undefined,
        // A side model that has not produced a token in a minute is not loading, it is dead; the parent's model is ready.
        firstTokenTimeoutMs: routedElsewhere && !fellBack ? 60_000 : undefined,
        sideModelOf: routedElsewhere && !fellBack ? ctx.modelRef : undefined,
      });
    try {
      let text: string;
      try {
        text = await attempt();
      } catch (e) {
        const kind = classifyModelError(e);
        // A router-chosen side model (read-only pick, or a spread onto an idle model) that stalls is retried on the
        // parent's model; an explicitly chosen model, or the parent's own, is not second-guessed.
        const onSideModel = (routedElsewhere || spreadable) && !!ctx.modelRef && !!child.model && child.model !== ctx.modelRef;
        if (!onSideModel || mutated || control.aborted || !(kind === 'stall' || kind === 'network' || kind === 'server')) {
          throw e;
        }
        fellBack = true;
        if (child.model) {
          runner.markModelUnresponsive(child.model);
        }
        emit({ sessionId: ctx.sessionId, type: 'status', payload: `${def.name}: ${child.model || 'the routed model'} is not responding — retrying on ${ctx.modelRef}` });
        child.messages = [];
        child.contextTokens = 0;
        recovery = undefined;
        child.model = ctx.modelRef!;
        text = await attempt();
      }
      if (control.aborted) {
        const partial = text ? ` Partial output:\n${text}` : '';
        const note = ctx.signal.aborted ? `Stopped by the user before it finished.${partial}` : `Subagent "${def.name}" was stopped by the user before it finished.${partial} Do not retry it; continue with what you have or do that part yourself.`;
        emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, error: 'Stopped by user', writtenFiles: written() } });
        return result(note, true);
      }
      if (!completed) {
        emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, error: 'Ran out of steps', writtenFiles: written() } });
        return result(`Subagent "${def.name}" ran out of steps before finishing.${text ? ` Partial output:\n${text}` : ''}`, true);
      }
      emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, result: text, model: child.model && child.model !== announcedModel ? child.model : undefined, recovery, writtenFiles: written() } });
      // Small models sometimes report work they never did. The parent can only verify what it is told, so say so
      // when the report claims a change but the worker made no edit, write or command at all.
      const unbacked = !mutated && child.mode === 'agent' && (claimsChange(text, prompt) || /\bI\s+(?:created|wrote|edited|updated|fixed|modified|added|saved|deleted|removed|renamed)\b/i.test(text));
      const verified = verificationLine(recovery);
      return result(`${text || '(subagent returned no text)'}${verified ? `\n\n${verified}` : ''}${unbacked ? '\n\n[LocalPilot: this worker made no file edits, writes or commands, although its report says it changed something. Check before relying on it.]' : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, error: msg, writtenFiles: written() } });
      return result(`Subagent failed: ${msg}`, true);
    } finally {
      control.dispose();
      releaseIntegratedTerminal(childId);
    }
  }

  const runTodos: Tool = {
    definition: {
      name: 'run_todos_parallel',
      description:
        'Run pieces of work as background workers at the same time. Either pass them inline as "tasks" (each with agent + a complete prompt — the fastest way) or run the pending checklist items that carry an "agent" (set agent/prompt/dependsOn with manage_todos). Independent items run concurrently; items with "dependsOn" wait for their prerequisites and receive their reports, so a whole plan runs in dependency waves with one call. Each item is marked in_progress → done/skipped as it runs and the user watches the checklist. Items without an agent are left for you to do yourself.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Optional: only run these todo ids (default: every pending item that has an agent)' },
          tasks: {
            type: 'array',
            description: 'Optional shortcut: define the pieces of work right here instead of calling manage_todos first. Each becomes a checklist item and runs now.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short label shown in the checklist' },
                agent: { type: 'string', description: 'Worker: coder, tester, docs, explore, reviewer, debugger, researcher…' },
                prompt: { type: 'string', description: 'Complete self-contained brief: goal, exact files, constraints, how to verify, what to report' },
                dependsOn: { type: 'array', items: { type: 'string' }, description: 'Tasks that must finish first: titles of tasks in this batch, their 1-based positions in this list, or ids of existing checklist items' },
                skills: { type: 'array', items: { type: 'string' }, description: 'Optional installed skill names this item must follow' },
              },
              required: ['agent', 'prompt'],
            },
          },
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.todos) {
        return { content: 'No checklist in this context. Call manage_todos first.', isError: true };
      }
      if (ctx.readOnly) {
        return { content: 'run_todos_parallel executes the plan and is only available in Agent mode. Finish the checklist here; the user can switch to Agent mode and say "implement the plan".', isError: true };
      }
      const parse = (v: unknown): unknown => {
        if (typeof v !== 'string') {
          return v;
        }
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      };
      const selectorGiven = args.tasks !== undefined || args.ids !== undefined;
      const rawIds = parse(args.ids);
      const idList = Array.isArray(rawIds) ? rawIds.map(String) : typeof rawIds === 'string' || typeof rawIds === 'number' ? [String(rawIds)] : [];
      const rawTasks = parse(args.tasks);
      // Inline tasks: turn them into checklist items first, then run exactly those.
      const inline = Array.isArray(rawTasks) ? (rawTasks as { title?: unknown; agent?: unknown; prompt?: unknown; dependsOn?: unknown; skills?: unknown }[]).filter((t) => t && typeof t.agent === 'string' && typeof t.prompt === 'string' && String(t.prompt).trim()) : [];
      if (selectorGiven && !inline.length && !idList.length) {
        return { content: 'run_todos_parallel: "tasks" must be an array of {title, agent, prompt} and "ids" an array of checklist ids; nothing was run.', isError: true };
      }
      // A selector was supplied: never fall back to every pending item.
      let wanted = selectorGiven ? new Set(idList) : undefined;
      if (inline.length) {
        const bad = unknownAgents(inline.map((t) => String(t.agent)));
        if (bad.unknown.length) {
          return { content: `Unknown subagent${bad.unknown.length === 1 ? '' : 's'}: ${bad.unknown.map((n) => `"${n}"`).join(', ')}. Available: ${bad.available.join(', ')}. Call again with these names; nothing was run.`, isError: true };
        }
        const existing = ctx.todos.get();
        const used = new Set(existing.map((t) => t.id));
        const norm = (x: unknown) => String(x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const next = (): string => { let n = existing.length + 1; while (used.has(String(n))) { n++; } used.add(String(n)); return String(n); };
        // Models often restate the checklist they just wrote as inline tasks; an inline task that repeats a pending
        // item (same prompt, or same title) runs that item instead of adding a duplicate that leaves the original pending.
        const matched = new Set<string>();
        const created: TodoItem[] = [];
        const resolvedIds: string[] = inline.map((t) => {
          const dup = existing.find((e) => e.status === 'pending' && !matched.has(e.id) && (norm(e.prompt) === norm(t.prompt) || (t.title && norm(e.title) === norm(t.title)) || norm(e.title) === norm(t.prompt).slice(0, 80)));
          if (dup) {
            matched.add(dup.id);
            dup.agent = String(t.agent) || dup.agent;
            dup.prompt = String(t.prompt).trim() ? String(t.prompt) : dup.prompt;
            if (strList(t.skills)?.length) { dup.skills = strList(t.skills); }
            return dup.id;
          }
          const item: TodoItem = { id: next(), title: String(t.title || t.prompt).replace(/\s+/g, ' ').trim().slice(0, 80), status: 'pending', agent: String(t.agent), prompt: String(t.prompt), ...(strList(t.skills)?.length ? { skills: strList(t.skills) } : {}) };
          created.push(item);
          return item.id;
        });
        const all = [...existing, ...created];
        // dependsOn names tasks in this batch (by title, prompt or 1-based position) before existing checklist items,
        // so "2" means the second inline task even when an older item already has id 2.
        const resolveDep = (d: string): string | undefined => {
          const k = inline.findIndex((x) => !!norm(d) && (norm(x.title) === norm(d) || norm(x.prompt) === norm(d)));
          if (k >= 0) { return resolvedIds[k]; }
          const pos = /^\d+$/.test(d.trim()) ? Number(d.trim()) : 0;
          if (pos >= 1 && pos <= inline.length) { return resolvedIds[pos - 1]; }
          return all.find((c) => c.id === d || c.title === d.slice(0, 80))?.id;
        };
        inline.forEach((t, i) => {
          const deps = Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).map(String) : [];
          const ids = deps.map(resolveDep).filter((d): d is string => !!d && d !== resolvedIds[i]);
          const item = all.find((c) => c.id === resolvedIds[i]);
          if (item && ids.length) { item.dependsOn = [...new Set([...(item.dependsOn ?? []), ...ids])]; }
        });
        ctx.todos.set(all);
        wanted = new Set(resolvedIds);
      }
      const all = ctx.todos.get();
      const runnable = all.filter((t) => t.status === 'pending' && t.agent && (!wanted || wanted.has(t.id)));
      if (!runnable.length) {
        return { content: 'Nothing to run: no pending todos with an "agent". Pass the work inline — run_todos_parallel({"tasks":[{"title":"…","agent":"coder","prompt":"…"},{"title":"…","agent":"tester","prompt":"…"}]}) — or add items with manage_todos first.', isError: true };
      }
      const bad = unknownAgents(runnable.map((t) => t.agent!));
      if (bad.unknown.length) {
        return { content: `Unknown subagent${bad.unknown.length === 1 ? '' : 's'}: ${bad.unknown.map((n) => `"${n}"`).join(', ')} (items ${runnable.filter((t) => bad.unknown.includes(t.agent!)).map((t) => t.id).join(', ')}). Available: ${bad.available.join(', ')}. Fix the items' agent with manage_todos and re-run; nothing was run.`, isError: true };
      }
      const update = (id: string, patch: Partial<TodoItem>) => ctx.todos!.set(ctx.todos!.get().map((t) => (t.id === id ? { ...t, ...patch } : t)));
      const pool = new ParallelPool(getConfig().parallel.maxConcurrency);
      const known = new Set(all.map((t) => t.id));
      const satisfied = new Set(all.filter((t) => t.status === 'done').map((t) => t.id));
      const failed = new Set(all.filter((t) => t.status === 'skipped').map((t) => t.id));
      for (const t of runnable) {
        for (const d of t.dependsOn ?? []) {
          if (!known.has(d)) {
            satisfied.add(d);
          }
        }
      }
      const checklist = all.map((t) => `${t.id}. ${t.title}${t.agent ? ` → ${t.agent}` : ''}${t.dependsOn?.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`).join('\n');
      const reports = new Map<string, string>();
      const outcomes: { t: TodoItem; content: string; ok: boolean }[] = [];
      let remaining = [...runnable];
      let wave = 0;
      const STOPPED = 'Stopped by the user before it finished.';
      const todoWrites = new Set<string>();
      const writesData = () => (todoWrites.size ? { writtenFiles: [...todoWrites] } : undefined);
      while (remaining.length) {
        if (ctx.signal.aborted) {
          break;
        }
        const { ready, blocked, cyclic } = nextWave(remaining, satisfied, failed);
        for (const t of blocked) {
          const why = (t.dependsOn ?? []).filter((d) => failed.has(d));
          update(t.id, { status: 'skipped', result: `Not run: prerequisite ${why.join(', ')} failed.` });
          outcomes.push({ t, content: `Not run — prerequisite ${why.join(', ')} failed or was skipped.`, ok: false });
          failed.add(t.id);
        }
        for (const t of cyclic) {
          update(t.id, { status: 'skipped', result: 'Not run: circular dependsOn.' });
          outcomes.push({ t, content: 'Not run — circular dependsOn between checklist items. Fix the dependencies with manage_todos and re-run.', ok: false });
          failed.add(t.id);
        }
        remaining = remaining.filter((t) => !blocked.includes(t) && !cyclic.includes(t));
        if (!ready.length) {
          break;
        }
        wave++;
        emit({ sessionId: ctx.sessionId, type: 'status', payload: `Running ${ready.length} checklist item${ready.length === 1 ? '' : 's'} in parallel (wave ${wave})…` });
        const settled = await pool.map(ready, async (t) => {
          if (ctx.signal.aborted) {
            return { content: STOPPED, isError: true };
          }
          update(t.id, { status: 'in_progress' });
          const deps = (t.dependsOn ?? []).filter((d) => reports.has(d));
          const depText = deps.length ? `\n\nReports from the prerequisite items you build on:\n${deps.map((d) => `### Item ${d}\n${reports.get(d)!.slice(0, 2500)}`).join('\n\n')}` : '';
          const brief = t.prompt?.trim() || `Carry out checklist item ${t.id}: "${t.title}". Use the tools to inspect the workspace, make the change (or produce the analysis) and verify it.`;
          const r = await runChild(t.agent!, `${brief}\n\nThis is checklist item ${t.id} ("${t.title}") of a larger task — stay within its scope. The full checklist, for context only:\n${checklist}${depText}`, t.model, ctx, t.title, t.skills);
          const ok = !r.isError;
          r.data?.writtenFiles.forEach((f) => todoWrites.add(f));
          // Stopped mid-way: the item goes back to pending (not done, not skipped) so it can be run again.
          update(t.id, ok ? { status: 'done', result: r.content.slice(0, 2000) } : ctx.signal.aborted ? { status: 'pending', result: STOPPED } : { status: 'skipped', result: r.content.slice(0, 2000) });
          return r;
        });
        settled.forEach((r, i) => {
          const t = ready[i];
          const ok = r.status === 'fulfilled' && !r.value.isError;
          if (!ok && ctx.signal.aborted) {
            return;
          }
          const content = r.status === 'fulfilled' ? r.value.content : String(r.reason);
          if (ok) {
            satisfied.add(t.id);
            reports.set(t.id, content);
          } else {
            failed.add(t.id);
          }
          outcomes.push({ t, content, ok });
        });
        remaining = remaining.filter((t) => !ready.includes(t));
      }
      if (ctx.signal.aborted) {
        const finished = new Set(outcomes.filter((o) => o.ok).map((o) => o.t.id));
        for (const t of runnable) {
          const now = ctx.todos.get().find((x) => x.id === t.id);
          if (!finished.has(t.id) && now && (now.status === 'pending' || now.status === 'in_progress')) {
            update(t.id, { status: 'pending', result: STOPPED });
          }
        }
        const done = outcomes.filter((o) => o.ok);
        return {
          content: `Stopped: ${done.length} of ${runnable.length} items finished; the rest are still pending.${done.length ? `\n\n${done.map(({ t, content }) => `## ${t.id}. ${t.title} (${t.agent})\n${content}`).join('\n\n')}` : ''}`,
          isError: true,
          data: writesData(),
        };
      }
      const remainingIds = new Set(remaining.map((t) => t.id));
      const stillWaiting = remaining.map((t) => {
        const unmet = (t.dependsOn ?? []).filter((d) => d !== t.id && !satisfied.has(d));
        const manual = unmet.filter((d) => !remainingIds.has(d));
        return manual.length
          ? `${t.id} (waiting for ${manual.join(', ')} — an item without an agent; do it yourself, then re-run)`
          : `${t.id} (waiting for item ${unmet.join(', ')}, which is still waiting itself)`;
      });
      const byId = new Map(runnable.map((t, i) => [t.id, i]));
      outcomes.sort((a, b) => (byId.get(a.t.id) ?? 0) - (byId.get(b.t.id) ?? 0));
      const out = outcomes.map(({ t, content, ok }) => `## ${t.id}. ${t.title} (${t.agent})${ok ? '' : ' — FAILED'}\n${content}`);
      const failedCount = outcomes.filter((o) => !o.ok).length;
      return {
        content: `${outcomes.length - failedCount}/${runnable.length} items completed in ${wave} wave${wave === 1 ? '' : 's'}.${failedCount ? ' Failed items were marked "skipped" — redo them yourself or re-run with fixes.' : ''}${stillWaiting.length ? `\nNot started: ${stillWaiting.join('; ')}.` : ''}\n\n${out.join('\n\n')}\n\nIntegrate the results, verify the combined change (diagnostics/tests), then update the remaining checklist items.`,
        isError: outcomes.length > 0 && failedCount === outcomes.length,
        data: writesData(),
      };
    },
  };

  return [loadSkill, runSubagent, runParallel, runTodos];
}
