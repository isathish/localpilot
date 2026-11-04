/** How a thinking level becomes each API's reasoning option (pure; tested in thinkingLevel.test.ts). */

export type ThinkLevel = 'low' | 'medium' | 'high' | 'max';

/** `reasoning_effort` / Ollama levels stop at high: `max` asks for the most the API offers. */
export function effortOf(level: ThinkLevel): 'low' | 'medium' | 'high' {
  return level === 'max' ? 'high' : level;
}

/** OpenRouter's unified `reasoning` object: an effort, or reasoning switched off. */
export function openRouterReasoning(think: boolean | ThinkLevel): { effort: 'low' | 'medium' | 'high' } | { enabled: boolean } {
  if (typeof think === 'boolean') {
    return { enabled: think };
  }
  return { effort: effortOf(think) };
}

/** Thinking tokens `max` asks a budget-style Claude model for; the other levels are a share of it. */
export const MAX_THINKING_BUDGET = 32_000;
const BUDGET_RATIO: Record<ThinkLevel, number> = { low: 0.125, medium: 0.375, high: 0.75, max: 1 };
/** Room left for the answer itself: thinking shares `max_tokens` with it. */
export const ANSWER_ROOM = 4096;

/**
 * `budget_tokens` for a level: its share of the maximum budget, at least 1024 (Anthropic's minimum) and small enough
 * to leave room for the answer within the model's output limit (`modelMax`, when known).
 */
export function anthropicBudget(level: ThinkLevel, modelMax?: number): number {
  const want = Math.round(BUDGET_RATIO[level] * MAX_THINKING_BUDGET);
  const upper = modelMax && modelMax > 0 ? Math.max(1024, modelMax - ANSWER_ROOM) : MAX_THINKING_BUDGET;
  return Math.max(1024, Math.min(want, upper));
}

/** Anthropic `output_config.effort`: `max` exists for Opus-class models only; the rest stop at high. */
export function anthropicEffort(level: ThinkLevel, model: string): 'low' | 'medium' | 'high' | 'max' {
  return level === 'max' && !/opus|fable|mythos/i.test(model) ? 'high' : level;
}
