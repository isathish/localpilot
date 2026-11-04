import { createSchedule, deleteSchedule, Launcher, nextRun, parseCron, scheduleRow, ScheduleStore, schedulerKind, startDetached } from '../cli/schedule';
import { Tool } from '../types';

/**
 * The `schedule` tool: lets the agent set up recurring runs ("every night at 3 run the tests and fix what fails"),
 * list them, delete one or start one now. Changes ask like a terminal command; listing does not.
 * `launcher` says how the OS scheduler starts the CLI from this host (the shim, or a runtime plus dist/cli.js).
 */
export function createScheduleTool(launcher: () => Launcher, store = () => new ScheduleStore()): Tool {
  return {
    // No approvalKind: list stays available in Ask and Plan mode; create, delete and run_now ask (as terminal commands).
    definition: {
      name: 'schedule',
      description:
        'Scheduled agent runs on this machine (the OS scheduler runs `localpilot schedule run <name>`; no service stays running). ' +
        '"list" shows the schedules with their next run and last result. "create" adds one: name, a 5-field cron expression (minute hour day-of-month month day-of-week, local time; e.g. "0 3 * * 1-5" = 03:00 on weekdays), ' +
        'a self-contained prompt (the run has no conversation: say what to do, which files, how to verify), optional mode (agent, plan, ask), model and timeout ("30m"). ' +
        'Each run is unattended (every edit and command is approved) and writes a Markdown report under ~/.localpilot/schedules/reports. "delete" removes one; "run_now" starts one in the background.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'delete', 'run_now'] },
          name: { type: 'string', description: 'create/delete/run_now: letters, digits, - and _' },
          cron: { type: 'string', description: 'create: 5-field cron expression, or @hourly / @daily / @weekly / @monthly' },
          prompt: { type: 'string', description: 'create: the task each run carries out' },
          cwd: { type: 'string', description: 'create: folder to run in (default: this workspace)' },
          mode: { type: 'string', enum: ['agent', 'plan', 'ask'] },
          model: { type: 'string', description: 'create: provider/model (default: the configured default)' },
          timeout: { type: 'string', description: 'create: stop a run after this long, e.g. "20m" (default 30m)' },
        },
        required: ['action'],
      },
    },
    async execute(args, ctx) {
      const st = store();
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const action = String(args.action ?? 'list');
      if (action === 'list') {
        const all = st.list();
        return { content: all.length ? `${all.map((s) => scheduleRow(s, st.history(s.name, 1)[0])).join('\n')}\n\nReports: ${st.reportsDir}` : 'No schedules yet.' };
      }
      if (ctx.readOnly) {
        return { content: `schedule ${action} changes the machine's scheduled runs; it is not available in ${ctx.mode ?? 'this'} mode.`, isError: true };
      }
      if (!name) {
        return { content: `${action} needs a name.`, isError: true };
      }
      const existing = st.get(name);
      try {
        if (action === 'create') {
          if (existing) {
            return { content: `A schedule "${name}" already exists (${existing.cron}); delete it first or pick another name.`, isError: true };
          }
          const cron = String(args.cron ?? '');
          parseCron(cron);
          const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : ctx.mainRoot ?? ctx.workspaceRoot ?? process.cwd();
          const prompt = String(args.prompt ?? '');
          if (!(await ctx.requestApproval(`Schedule "${name}" (${cron})`, `Runs unattended in ${cwd} via ${schedulerKind()}${args.mode ? ` in ${String(args.mode)} mode` : ''}:\n\n${prompt.slice(0, 800)}`, 'terminal'))) {
            return { content: 'The user declined to create this schedule.', isError: true };
          }
          const s = await createSchedule({ name, cron, prompt, cwd, mode: typeof args.mode === 'string' ? args.mode : undefined, model: typeof args.model === 'string' ? args.model : undefined, timeout: typeof args.timeout === 'string' ? args.timeout : undefined }, launcher(), st);
          const next = nextRun(parseCron(s.cron), new Date());
          return { content: `Scheduled "${s.name}" (${s.cron}) in ${s.cwd}${next ? `; next run ${next.toISOString()}` : ''}. Reports go to ${st.reportsDir}.` };
        }
        if (!existing) {
          return { content: `No schedule "${name}". Existing: ${st.list().map((s) => s.name).join(', ') || 'none'}.`, isError: true };
        }
        if (action === 'delete') {
          if (!(await ctx.requestApproval(`Delete schedule "${name}"`, `${existing.cron} in ${existing.cwd}:\n\n${existing.prompt.slice(0, 400)}`, 'terminal'))) {
            return { content: 'The user declined to delete this schedule.', isError: true };
          }
          await deleteSchedule(name, st);
          return { content: `Deleted schedule "${name}".` };
        }
        if (action === 'run_now') {
          if (!(await ctx.requestApproval(`Run schedule "${name}" now`, `Unattended in ${existing.cwd}:\n\n${existing.prompt.slice(0, 600)}`, 'terminal'))) {
            return { content: 'The user declined to start this run.', isError: true };
          }
          startDetached(name, launcher());
          return { content: `Started "${name}" in the background; its report will be in ${st.reportsDir} (schedule list shows the result when it finishes).` };
        }
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
      return { content: `Unknown action "${action}".`, isError: true };
    },
  };
}
