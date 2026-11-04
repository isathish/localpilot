import { Session, ThinkingLevel } from '../types';

/** What the model sends as `think`: false = no reasoning, true = the model's default, or an effort level. */
export type ThinkParam = boolean | 'low' | 'medium' | 'high' | 'max';

/** Who is asking: an agent run (by mode and nesting depth) or a quick helper call. */
export type ThinkPurpose = { mode: Session['mode']; depth: number } | 'helper';

/** Levels a chat (composer chip, `/thinking`, `--thinking`) can choose; `auto` follows the mode. */
export const THINK_CHOICES = ['auto', 'off', 'low', 'medium', 'high', 'max'] as const;
export type ThinkChoice = (typeof THINK_CHOICES)[number];

/** A typed level (`High`, `none`, `on`), or undefined when it is not one. A bare `--thinking` means medium. */
export function parseThinkChoice(raw: string | undefined): ThinkChoice | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) {
    return 'medium';
  }
  if (v === 'none' || v === 'false' || v === 'no') {
    return 'off';
  }
  if (v === 'on' || v === 'true' || v === 'yes') {
    return 'medium';
  }
  if (v === 'min' || v === 'minimal') {
    return 'low';
  }
  if (v === 'xhigh' || v === 'maximum') {
    return 'max';
  }
  return (THINK_CHOICES as readonly string[]).includes(v) ? (v as ThinkChoice) : undefined;
}

/** The chat's own level when it chose one, else the `localpilot.thinking` setting. */
export function thinkingLevel(session: Pick<Session, 'think'> | undefined, global: ThinkingLevel): ThinkingLevel {
  return session?.think ?? global;
}

/**
 * How hard the model should think for one call, from the chat's level or `localpilot.thinking`:
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
