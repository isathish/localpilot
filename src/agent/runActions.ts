/**
 * What the chat's run-card buttons ask the agent to do, as plain messages: a failed step's Retry / Edit & retry / Skip,
 * a command's Rerun, a test run's Re-run failed / Fix failures, and Continue after a stop. The chat sends the text as a
 * steer while the run lasts and as a new turn once it ended, so every action goes through the normal tools and
 * approval rules. Pure: no vscode.
 */

export type ToolFailureAction = 'retry' | 'edit' | 'skip' | 'rerun' | 'rerunFailed' | 'fixFailures';

export interface ToolFailureRequest {
  action: ToolFailureAction;
  /** Tool name of the step (`edit_file`, `run_command`). */
  tool: string;
  /** The step's arguments as JSON; for `edit` the user's edited arguments (JSON, or a plain command for run_command). */
  args?: string;
  /** First line of the step's error. */
  error?: string;
  /** `rerunFailed` / `fixFailures`: the failing tests (name, then " (file:line): message" when known). */
  tests?: string[];
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string | undefined): string => clip(String(s ?? '').split('\n').find((l) => l.trim()) ?? '', 300).trim();

function parsed(args: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(args ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** "`edit_file` on src/a.ts" / "the command `npm test`": the step in a few words. */
function stepName(tool: string, args: Record<string, unknown>): string {
  if (tool === 'run_command' && typeof args.command === 'string') {
    return `the command \`${clip(args.command, 200)}\``;
  }
  const target = typeof args.path === 'string' ? args.path : typeof args.url === 'string' ? args.url : typeof args.query === 'string' ? args.query : '';
  return `\`${tool}\`${target ? ` on ${clip(target, 160)}` : ''}`;
}

/** The message for a run-card action, or undefined when the request is incomplete (an empty edit). */
export function toolFailurePrompt(r: ToolFailureRequest): string | undefined {
  const args = parsed(r.args);
  const step = stepName(r.tool, args);
  const why = firstLine(r.error);
  switch (r.action) {
    case 'retry':
      if (r.tool === 'run_subagent' && typeof args.prompt === 'string') {
        return `The ${typeof args.agent === 'string' && args.agent ? args.agent : 'worker'} task failed${why ? ` (${why})` : ''}. Delegate it again with run_subagent${typeof args.agent === 'string' && args.agent ? ` to the ${args.agent} agent` : ''}, with this task:\n${clip(args.prompt, 4000)}`;
      }
      return `The step ${step} failed${why ? ` (${why})` : ''}. Try it again: first re-read whatever it depends on (the file may have changed), then repeat the step.`;
    case 'skip':
      return `Skip the failed step ${step} and carry on with the rest of the task without it. Mention in your final answer that it was skipped.`;
    case 'rerun':
      return `Run ${step} again exactly as written (run_command, same working directory) and tell me the result.`;
    case 'edit': {
      const raw = String(r.args ?? '').trim();
      if (!raw) {
        return undefined;
      }
      if (r.tool === 'run_command' && !raw.startsWith('{')) {
        return `Instead of the failed command, run this one exactly as written and continue from its result:\n\`\`\`sh\n${raw}\n\`\`\``;
      }
      return `Retry the failed \`${r.tool}\` step with these arguments exactly, then continue:\n\`\`\`json\n${clip(raw, 8000)}\n\`\`\``;
    }
    case 'rerunFailed': {
      const names = (r.tests ?? []).map((t) => t.split(' (')[0]).filter(Boolean).slice(0, 20);
      return `Re-run only the failing tests${names.length ? ` (${names.join(', ')})` : ''} of ${step}, using the test runner's own filter option, and report the result.`;
    }
    case 'fixFailures': {
      const list = (r.tests ?? []).slice(0, 20).map((t) => `- ${clip(t, 300)}`).join('\n');
      return `Fix the failing tests from ${step}.${list ? `\n${list}` : ''}\nFind the cause in the code under test (change a test only when the test itself is wrong), then re-run the tests to confirm.`;
    }
    default:
      return undefined;
  }
}

/** The turn that picks a stopped or interrupted run back up. */
export const CONTINUE_PROMPT = 'Continue the task where you left off. Check what was already done (changed files, finished checklist items) before doing anything else, and do not repeat finished steps.';
