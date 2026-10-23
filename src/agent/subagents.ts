import { getConfig } from '../config';
import { AgentEvent, ChatMessage, Session, Tool, ToolContext } from '../types';
import { AgentRunner, ApprovalHandler } from './agentLoop';
import { ParallelPool } from './parallel';
import { SkillManager } from './skills';
import { newId } from '../providers/http';

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
      return { content: body };
    },
  };

  const runSubagent: Tool = {
    definition: {
      name: 'run_subagent',
      description:
        'Delegate a self-contained task to a subagent that runs with its own fresh context window and returns a final report. Use for exploration, research, reviews or isolated implementation work. The subagent cannot see this conversation, so include all necessary context in the prompt.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Subagent name (see Available subagents), e.g. "explore", "coder", "reviewer", "researcher"' },
          prompt: { type: 'string', description: 'Complete, self-contained task description and what to return' },
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
    const def = skills.getAgent(agentName) ?? skills.getAgent('explore')!;
    const childId = `${ctx.sessionId}::${def.name}::${newId('sub')}`;
    const child: Session = {
      id: childId,
      title: `${def.name}: ${prompt.slice(0, 40)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: modelRef ?? def.model ?? '',
      messageCount: 0,
      messages: [],
      contextTokens: 0,
      compactions: 0,
      mode: 'agent',
      attachments: [],
    };
    emit({ sessionId: ctx.sessionId, type: 'subagent_start', payload: { childId, agent: def.name, prompt } });
    const user: ChatMessage = { role: 'user', content: prompt };
    try {
      const text = await runner.run({
        session: child,
        userMessage: user,
        modelRef: child.model || undefined,
        toolFilter: def.tools,
        roleOverride: `${def.systemPrompt}\n\nYou are a subagent. Finish by writing a complete final report; the parent agent only sees your last message.`,
        depth: ctx.depth + 1,
        signal: ctx.signal,
        requestApproval: (title, detail, kind) => approval(ctx.sessionId, title, detail, kind),
        // Child progress is forwarded under the parent's session id so the UI can nest it.
        emit: (e) => emit({ ...e, sessionId: ctx.sessionId, payload: { childId, agent: def.name, inner: e.type, data: e.payload }, type: e.type === 'turn_end' ? 'status' : e.type === 'assistant_delta' || e.type === 'thinking_delta' ? 'status' : e.type }),
        maxIterations: 25,
      });
      emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, result: text } });
      return { content: text || '(subagent returned no text)' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ sessionId: ctx.sessionId, type: 'subagent_end', payload: { childId, agent: def.name, error: msg } });
      return { content: `Subagent failed: ${msg}`, isError: true };
    }
  }

  return [loadSkill, runSubagent, runParallel];
}
