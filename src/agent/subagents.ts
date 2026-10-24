import { getConfig } from '../config';
import { AgentEvent, ChatMessage, Session, TodoItem, Tool, ToolContext } from '../types';
import { AgentRunner, ApprovalHandler } from './agentLoop';
import { nextWave, ParallelPool } from './parallel';
import { RunControl } from './runControl';
import { SkillManager } from './skills';
import { newId } from '../providers/http';
import { resolveAgentName, routeSubagent } from './builtinAgents';

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

export function createAgentTools(runner: AgentRunner, skills: SkillManager, emit: (e: AgentEvent) => void, approval: ScopedApprovalHandler): Tool[] {
  const loadSkill: Tool = {
    parallelSafe: true,
    definition: {
      name: 'load_skill',
      description: 'Load the full instructions of a skill by name. Call this before performing a task that matches a skill description.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    async execute(args) {
      const body = await skills.loadSkillBody(String(args.name ?? ''));
      if (!body) {
        return { content: `Unknown skill "${args.name}". Available: ${skills.allSkills.map((s) => s.name).join(', ') || '(none)'}`, isError: true };
      }
      return { content: `${body}\n\nThe skill is now loaded. Carry out each step above with the tools (write_file, edit_file, run_command, …) before replying — do not answer until the steps have actually been executed and their results confirm it.` };
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
        },
        required: ['agent', 'prompt'],
      },
    },
    async execute(args, ctx) {
      return runChild(String(args.agent), String(args.prompt), typeof args.model === 'string' ? args.model : undefined, ctx);
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
              properties: { agent: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' } },
              required: ['agent', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    async execute(args, ctx) {
      const tasks = Array.isArray(args.tasks) ? (args.tasks as { agent: string; prompt: string; model?: string }[]) : [];
      if (!tasks.length) {
        return { content: 'tasks must be a non-empty array', isError: true };
      }
      const pool = new ParallelPool(getConfig().parallel.maxConcurrency);
      const settled = await pool.map(tasks, (t) => runChild(t.agent, t.prompt, t.model, ctx));
      const out = settled.map((r, i) => {
        const header = `## Task ${i + 1} (${tasks[i].agent}): ${tasks[i].prompt.slice(0, 80)}`;
        return r.status === 'fulfilled' ? `${header}\n${r.value.content}` : `${header}\nFAILED: ${String(r.reason)}`;
      });
      return { content: out.join('\n\n'), isError: settled.every((r) => r.status === 'rejected') };
    },
  };

  async function runChild(agentName: string, prompt: string, modelRef: string | undefined, ctx: ToolContext, label?: string) {
    const cfg = getConfig();
    if (ctx.depth >= cfg.parallel.maxSubagentDepth) {
      return { content: `Subagent depth limit (${cfg.parallel.maxSubagentDepth}) reached; do the work directly instead.`, isError: true };
    }
    if (!prompt.trim()) {
      return { content: 'The subagent prompt is empty. Describe the goal, the relevant files/symbols and what to return.', isError: true };
    }
    const resolved = resolveAgentName(agentName, skills.allAgents.map((a) => a.name));
    const def = (resolved ? skills.getAgent(resolved) : undefined) ?? skills.getAgent('explore')!;
    const fallbackNote = def.name !== agentName && !resolved ? `Note: unknown subagent "${agentName}" — ran "${def.name}" instead. Available: ${skills.allAgents.map((a) => a.name).join(', ')}.\n\n` : '';
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
    emit({ sessionId: ctx.sessionId, type: 'subagent_start', payload: { childId, agent: def.name, prompt, model: child.model || undefined, label: label || undefined } });
    const user: ChatMessage = { role: 'user', content: prompt };
    try {
      const text = await runner.run({
        session: child,
        userMessage: user,
        modelRef: child.model || undefined,
        role,
        toolFilter: def.tools,
        roleOverride: `${def.systemPrompt}\n\n${SUBAGENT_CONTRACT}`,
        workspaceRoot: ctx.workspaceRoot,
        depth: ctx.depth + 1,
        signal: control.signal,
        control,
        requestApproval: (title, detail, kind) => approval(ctx.sessionId, title, detail, kind),
        // Child progress is forwarded under the parent's session id so the UI can nest it.
        emit: (e) => emit({ ...e, sessionId: ctx.sessionId, payload: { childId, agent: def.name, inner: e.type, data: e.payload }, type: e.type === 'turn_end' ? 'status' : e.type === 'assistant_delta' || e.type === 'thinking_delta' ? 'status' : e.type }),
        maxIterations: 25,
      });
      if (control.aborted && !ctx.signal.aborted) {
        const note = `Subagent "${def.name}" was stopped by the user before it finished.${text ? ` Partial output:\n${text}` : ''} Do not retry it; continue with what you have or do that part yourself.`;
        emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, error: 'Stopped by user' } });
        return { content: fallbackNote + note };
      }
      emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, result: text } });
      return { content: fallbackNote + (text || '(subagent returned no text)') };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, error: msg } });
      return { content: `Subagent failed: ${msg}`, isError: true };
    } finally {
      control.dispose();
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
                dependsOn: { type: 'array', items: { type: 'string' }, description: 'Titles or ids of tasks that must finish first' },
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
      let wanted = Array.isArray(args.ids) ? new Set((args.ids as unknown[]).map(String)) : undefined;
      // Inline tasks: turn them into checklist items first, then run exactly those.
      const inline = Array.isArray(args.tasks) ? (args.tasks as { title?: unknown; agent?: unknown; prompt?: unknown; dependsOn?: unknown }[]).filter((t) => t && typeof t.agent === 'string' && typeof t.prompt === 'string' && String(t.prompt).trim()) : [];
      if (inline.length) {
        const existing = ctx.todos.get();
        const used = new Set(existing.map((t) => t.id));
        const next = (): string => { let n = existing.length + 1; while (used.has(String(n))) { n++; } used.add(String(n)); return String(n); };
        const created: TodoItem[] = inline.map((t) => ({ id: next(), title: String(t.title || t.prompt).replace(/\s+/g, ' ').trim().slice(0, 80), status: 'pending' as const, agent: String(t.agent), prompt: String(t.prompt) }));
        // dependsOn may name other inline tasks by title or by id; resolve titles to the ids just assigned.
        inline.forEach((t, i) => {
          const deps = Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).map(String) : [];
          const ids = deps.map((d) => created.find((c) => c.title === d.slice(0, 80) || c.id === d)?.id ?? existing.find((c) => c.id === d || c.title === d)?.id).filter((d): d is string => !!d);
          if (ids.length) { created[i].dependsOn = ids; }
        });
        ctx.todos.set([...existing, ...created]);
        wanted = new Set(created.map((c) => c.id));
      }
      const all = ctx.todos.get();
      const runnable = all.filter((t) => t.status === 'pending' && t.agent && (!wanted || wanted.has(t.id)));
      if (!runnable.length) {
        return { content: 'Nothing to run: no pending todos with an "agent". Pass the work inline — run_todos_parallel({"tasks":[{"title":"…","agent":"coder","prompt":"…"},{"title":"…","agent":"tester","prompt":"…"}]}) — or add items with manage_todos first.', isError: true };
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
      while (remaining.length) {
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
          update(t.id, { status: 'in_progress' });
          const deps = (t.dependsOn ?? []).filter((d) => reports.has(d));
          const depText = deps.length ? `\n\nReports from the prerequisite items you build on:\n${deps.map((d) => `### Item ${d}\n${reports.get(d)!.slice(0, 2500)}`).join('\n\n')}` : '';
          const brief = t.prompt?.trim() || `Carry out checklist item ${t.id}: "${t.title}". Use the tools to inspect the workspace, make the change (or produce the analysis) and verify it.`;
          const r = await runChild(t.agent!, `${brief}\n\nThis is checklist item ${t.id} ("${t.title}") of a larger task — stay within its scope. The full checklist, for context only:\n${checklist}${depText}`, t.model, ctx, t.title);
          const ok = !r.isError;
          update(t.id, { status: ok ? 'done' : 'skipped', result: r.content.slice(0, 2000) });
          return r;
        });
        settled.forEach((r, i) => {
          const t = ready[i];
          const ok = r.status === 'fulfilled' && !r.value.isError;
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
      const stillWaiting = remaining.map((t) => `${t.id} (waiting for ${(t.dependsOn ?? []).filter((d) => !satisfied.has(d)).join(', ')} — an item without an agent; do it yourself, then re-run)`);
      const byId = new Map(runnable.map((t, i) => [t.id, i]));
      outcomes.sort((a, b) => (byId.get(a.t.id) ?? 0) - (byId.get(b.t.id) ?? 0));
      const out = outcomes.map(({ t, content, ok }) => `## ${t.id}. ${t.title} (${t.agent})${ok ? '' : ' — FAILED'}\n${content}`);
      const failedCount = outcomes.filter((o) => !o.ok).length;
      return {
        content: `${outcomes.length - failedCount}/${runnable.length} items completed in ${wave} wave${wave === 1 ? '' : 's'}.${failedCount ? ' Failed items were marked "skipped" — redo them yourself or re-run with fixes.' : ''}${stillWaiting.length ? `\nNot started: ${stillWaiting.join('; ')}.` : ''}\n\n${out.join('\n\n')}\n\nIntegrate the results, verify the combined change (diagnostics/tests), then update the remaining checklist items.`,
        isError: outcomes.length > 0 && failedCount === outcomes.length,
      };
    },
  };

  return [loadSkill, runSubagent, runParallel, runTodos];
}
