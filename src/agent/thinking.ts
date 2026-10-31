import { Session, ThinkingLevel } from '../types';

/** What the model sends as `think`: false = no reasoning, true = the model's default, or an effort level. */
export type ThinkParam = boolean | 'low' | 'medium' | 'high';

/** Who is asking: an agent run (by mode and nesting depth) or a quick helper call. */
export type ThinkPurpose = { mode: Session['mode']; depth: number } | 'helper';

/**
 * How hard the model should think for one call, from `localpilot.thinking`:
 * - `off`: never (sent explicitly — thinking models otherwise reason by default).
 * - `auto`: deeper where a wrong turn is expensive (Plan, Debug), medium for the main agent and Multitask, light for
 *   Ask and for subagents (they run many short steps), none for helpers.
 * - `on` / a level: that setting for every agent run.
 * Helpers — compaction summaries, the auto-mode reviewer, inline edits — never think: they are short, frequent and
 * the user is waiting on them.
 */
export function thinkFor(level: ThinkingLevel, purpose: ThinkPurpose): ThinkParam {
  if (level === 'off' || purpose === 'helper') {
    return false;
  }
  if (level === 'on') {
    return true;
  }
  if (level !== 'auto') {
    return level;
  }
  if (purpose.depth > 0) {
    return 'low';
  }
  switch (purpose.mode) {
    case 'plan':
    case 'debug':
      return 'high';
    case 'ask':
      return 'low';
    default:
      return 'medium';
  }
}
