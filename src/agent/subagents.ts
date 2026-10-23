import { getConfig } from '../config';
import { AgentEvent, ChatMessage, Session, TodoItem, Tool, ToolContext } from '../types';
import { AgentRunner, ApprovalHandler } from './agentLoop';
import { ParallelPool } from './parallel';
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

  async function runChild(agentName: string, prompt: string, modelRef: string | undefined, ctx: ToolContext) {
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
      mode: 'agent',
      attachments: [],
    };
    emit({ sessionId: ctx.sessionId, type: 'subagent_start', payload: { childId, agent: def.name, prompt, model: child.model || undefined } });
    const user: ChatMessage = { role: 'user', content: prompt };
    try {
      const text = await runner.run({
        session: child,
        userMessage: user,
        modelRef: child.model || undefined,
        role,
        toolFilter: def.tools,
        roleOverride: `${def.systemPrompt}\n\n${SUBAGENT_CONTRACT}`,
        depth: ctx.depth + 1,
        signal: ctx.signal,
        requestApproval: (title, detail, kind) => approval(ctx.sessionId, title, detail, kind),
        // Child progress is forwarded under the parent's session id so the UI can nest it.
        emit: (e) => emit({ ...e, sessionId: ctx.sessionId, payload: { childId, agent: def.name, inner: e.type, data: e.payload }, type: e.type === 'turn_end' ? 'status' : e.type === 'assistant_delta' || e.type === 'thinking_delta' ? 'status' : e.type }),
        maxIterations: 25,
      });
      emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, result: text } });
      return { content: fallbackNote + (text || '(subagent returned no text)') };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, error: msg } });
      return { content: `Subagent failed: ${msg}`, isError: true };
    }
  }

  const runTodos: Tool = {
    definition: {
      name: 'run_todos_parallel',
      description:
        'Execute the pending checklist items that carry an "agent" and "prompt" (set them with manage_todos) as concurrent subagents, one per item, and mark each item in_progress → done/skipped as it runs. Use after splitting a large task into independent pieces: the user watches progress in the checklist while the pieces run in parallel. Items without agent/prompt, and items that depend on each other, are left for you to do in order.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Optional: only run these todo ids (default: every pending item that has agent + prompt)' },
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.todos) {
        return { content: 'No checklist in this context. Call manage_todos first.', isError: true };
      }
      const wanted = Array.isArray(args.ids) ? new Set((args.ids as unknown[]).map(String)) : undefined;
      const runnable = ctx.todos.get().filter((t) => t.status === 'pending' && t.agent && t.prompt && (!wanted || wanted.has(t.id)));
      if (!runnable.length) {
        return { content: 'Nothing to run: no pending todos with both "agent" and "prompt". Add them with manage_todos (e.g. {"id":"2","title":"…","status":"pending","agent":"coder","prompt":"…"}).', isError: true };
      }
      const update = (id: string, patch: Partial<TodoItem>) => ctx.todos!.set(ctx.todos!.get().map((t) => (t.id === id ? { ...t, ...patch } : t)));
      const pool = new ParallelPool(getConfig().parallel.maxConcurrency);
      const settled = await pool.map(runnable, async (t) => {
        update(t.id, { status: 'in_progress' });
        const r = await runChild(t.agent!, `${t.prompt}\n\nThis is checklist item "${t.title}" of a larger task; stay within its scope.`, t.model, ctx);
        update(t.id, { status: r.isError ? 'skipped' : 'done', result: r.content.slice(0, 2000) });
        return r;
      });
      const out = settled.map((r, i) => {
        const t = runnable[i];
        const header = `## ${t.id}. ${t.title} (${t.agent})`;
        return r.status === 'fulfilled' ? `${header}${r.value.isError ? ' — FAILED' : ''}\n${r.value.content}` : `${header} — FAILED\n${String(r.reason)}`;
      });
      const failed = settled.filter((r) => r.status === 'rejected' || r.value.isError).length;
      return {
        content: `${runnable.length - failed}/${runnable.length} items completed.${failed ? ' Failed items were marked "skipped" — redo them yourself or re-run with fixes.' : ''}\n\n${out.join('\n\n')}\n\nIntegrate the results, verify the combined change (diagnostics/tests), then update the remaining checklist items.`,
        isError: failed === runnable.length,
      };
    },
  };

  return [loadSkill, runSubagent, runParallel, runTodos];
}
