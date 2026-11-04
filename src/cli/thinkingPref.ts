import { parseThinkChoice, ThinkChoice } from '../agent/thinking';
import { ThinkingLevel } from '../types';
import { readCliConfig, writeCliConfig } from './vscodeShim';

/** Where the CLI remembers the last `--thinking` / `/thinking` choice in ~/.localpilot/config.json. */
export const THINKING_PREF_KEY = 'cli.thinking';

/** The remembered level, if one was chosen before and is still a valid level. */
export function savedThinking(cfg: Record<string, unknown> = readCliConfig()): ThinkChoice | undefined {
  const v = cfg[THINKING_PREF_KEY];
  return typeof v === 'string' && v.trim() ? parseThinkChoice(v) : undefined;
}

/** Remembers `level` for the next CLI session (best effort: a broken config file is left alone). */
export async function rememberThinking(level: ThinkChoice): Promise<void> {
  const cfg = readCliConfig();
  if (cfg[THINKING_PREF_KEY] === level) {
    return;
  }
  await writeCliConfig({ ...cfg, [THINKING_PREF_KEY]: level }).catch(() => undefined);
}

/** The level for a new or resumed CLI session: `--thinking` wins, then the session's own, then the remembered one. */
export function sessionThinking(flag: ThinkChoice | undefined, own: ThinkingLevel | undefined, saved: ThinkChoice | undefined): ThinkingLevel | undefined {
  return flag ?? own ?? saved;
}
