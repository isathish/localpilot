import * as fs from 'fs';
import * as path from 'path';

export const PLAN_FILE = 'implementation_plan.md';

/** How a `/deep-planning` turn ended, as seen by the chat or the CLI. */
export interface PlanTurnOutcome {
  text: string;
  /** turn_end's `completed`: the model gave a final answer (not a hook block, the step limit or a stop). */
  completed?: boolean;
  errored?: boolean;
  aborted?: boolean;
}

/** The plan to keep, or undefined when the turn did not finish cleanly (an error or partial text is never a plan). */
export function planToSave(o: PlanTurnOutcome): string | undefined {
  if (o.completed !== true || o.errored || o.aborted) {
    return undefined;
  }
  return o.text.trim() || undefined;
}

/** Write `implementation_plan.md` in `root` for a finished turn; returns the file written, or undefined if left alone. */
export async function saveImplementationPlan(root: string, o: PlanTurnOutcome): Promise<string | undefined> {
  const plan = planToSave(o);
  if (!plan) {
    return undefined;
  }
  const file = path.join(root, PLAN_FILE);
  await fs.promises.writeFile(file, `${plan}\n`, 'utf8');
  return file;
}
