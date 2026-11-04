import { fuzzyMatch } from '../context/mentionSearch';

/** What the provider search looks at; both the CLI's presets and the Settings page's have these fields. */
export interface SearchablePreset {
  key: string;
  label: string;
  /** Host or short hint shown under the name (Settings), e.g. `api.groq.com`. */
  sub?: string;
  env?: string;
  cfg: { baseUrl: string };
}

export interface PresetHit<T> {
  preset: T;
  score: number;
  /** Matched character offsets in the label, for highlighting. */
  labelHl: number[];
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Presets ranked for a typed query with the same fuzzy scorer as the `@` menu: the name counts most, then the key,
 * then the host and the key's environment variable. An exact name or key, then a name prefix, always lead. Presets
 * that match nowhere are left out; ties keep the list order. `media/settings.js` mirrors this ranking.
 */
export function rankPresets<T extends SearchablePreset>(query: string, presets: readonly T[]): PresetHit<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return presets.map((preset) => ({ preset, score: 0, labelHl: [] }));
  }
  const hits: (PresetHit<T> & { i: number })[] = [];
  presets.forEach((preset, i) => {
    const label = fuzzyMatch(q, preset.label);
    const key = fuzzyMatch(q, preset.key);
    const host = fuzzyMatch(q, preset.sub || hostOf(preset.cfg.baseUrl));
    const env = preset.env ? fuzzyMatch(q, preset.env) : undefined;
    const scores = [label ? label.score : -Infinity, key ? key.score - 1 : -Infinity, host ? host.score - 6 : -Infinity, env ? env.score - 8 : -Infinity];
    let score = Math.max(...scores);
    if (score === -Infinity) {
      return;
    }
    const name = preset.label.toLowerCase();
    if (name === q || preset.key === q) {
      score += 100;
    } else if (name.startsWith(q) || preset.key.startsWith(q)) {
      score += 20;
    }
    hits.push({ preset, score, labelHl: label?.positions ?? [], i });
  });
  return hits.sort((a, b) => b.score - a.score || a.i - b.i).map(({ preset, score, labelHl }) => ({ preset, score, labelHl }));
}

/** The one preset a typed name clearly means: the best hit when its letters mostly fall on word starts or runs. */
export function bestPreset<T extends SearchablePreset>(query: string, presets: readonly T[]): T | undefined {
  const q = query.trim();
  const top = q ? rankPresets(q, presets)[0] : undefined;
  return top && top.score >= q.length * 5 ? top.preset : undefined;
}
