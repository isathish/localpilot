import { ChatMessage } from '../types';

/** A ready-made task a user can hand to an agent, written for people who do not speak "developer". */
export interface TaskSuggestion {
  title: string;
  /** One line of context: why this is suggested / what it will touch. */
  detail?: string;
  kind: 'fix' | 'test' | 'docs' | 'cleanup' | 'feature' | 'review' | 'explore';
}

export interface SuggestionFacts {
  /** Compact project map (folders, stack markers), as built for the system prompt. */
  projectMap: string;
  /** `git status --short` style summary, '' outside git. */
  gitSummary: string;
  /** Problems-panel errors right now. */
  errors: { count: number; files: number; sample?: string };
  /** Number of TODO / FIXME comments found (undefined when not counted). */
  todos?: number;
  /** Recent prompts the user typed, newest first. */
  recent: string[];
}

/**
 * Cheap, deterministic ideas computed from what the workspace looks like right now — shown instantly while the
 * model-generated ones load. Wording stays plain: the agent gets the detail it needs, the user sees the outcome.
 */
export function quickSuggestions(f: SuggestionFacts): TaskSuggestion[] {
  const out: TaskSuggestion[] = [];
  const map = f.projectMap.toLowerCase();
  const has = (re: RegExp) => re.test(map);
  if (f.errors.count > 0) {
    out.push({
      kind: 'fix',
      title: `Fix the ${f.errors.count} error${f.errors.count === 1 ? '' : 's'} VS Code is showing`,
      detail: `${f.errors.files} file${f.errors.files === 1 ? '' : 's'}${f.errors.sample ? ` · e.g. ${f.errors.sample}` : ''}`,
    });
  }
  const changed = f.gitSummary.split('\n').filter((l) => /^\s*[ MADRCU?!]{1,2}\s/.test(l) && !l.startsWith('##')).length;
  if (changed > 0) {
    out.push({ kind: 'review', title: 'Review my uncommitted changes and tidy them up', detail: `${changed} changed file${changed === 1 ? '' : 's'} · finds mistakes, dead code and missing tests` });
    out.push({ kind: 'docs', title: 'Write a clear commit message for my current changes', detail: 'Summarises what changed and why' });
  }
  if (!has(/readme/)) {
    out.push({ kind: 'docs', title: 'Write a README that explains how to set up and run this project', detail: 'Install steps, how to start it, how to run tests' });
  }
  const hasTests = has(/\b(tests?|__tests__|spec|specs)\b|\.test\.|\.spec\.|jest|vitest|mocha|pytest|go test|cargo test/);
  if (hasTests) {
    out.push({ kind: 'test', title: 'Run the test suite and fix anything that fails', detail: 'Reports what was broken and how it was fixed' });
  } else {
    out.push({ kind: 'test', title: 'Add tests for the most important parts of the code', detail: 'Starts with the code that would hurt most if it broke' });
  }
  if (f.todos && f.todos > 0) {
    out.push({ kind: 'cleanup', title: `Resolve the ${f.todos} TODO / FIXME note${f.todos === 1 ? '' : 's'} left in the code`, detail: 'Finishes or removes each one' });
  }
  if (has(/package\.json|requirements\.txt|pyproject|go\.mod|cargo\.toml|gemfile|pom\.xml|build\.gradle/)) {
    out.push({ kind: 'cleanup', title: 'Update dependencies safely and fix anything that breaks', detail: 'Minor and patch versions first; runs the tests after' });
  }
  // Things the user asked for before are good candidates to re-run or continue; they outrank the generic ideas.
  for (const r of f.recent.slice(0, 3)) {
    const t = r.replace(/\s+/g, ' ').trim();
    if (t.length > 8 && t.length < 120 && !out.some((o) => o.title.toLowerCase() === t.toLowerCase())) {
      out.push({ kind: 'feature', title: t, detail: 'From your recent prompts' });
    }
  }
  out.push({ kind: 'review', title: 'Find and fix the slowest parts of the app', detail: 'Looks for repeated work, large loops, blocking calls' });
  out.push({ kind: 'feature', title: 'Make error messages shown to users clearer and more helpful', detail: 'Plain language, says what to do next' });
  out.push({ kind: 'fix', title: 'Check every place that takes user input and add validation', detail: 'Forms, URLs, files, command-line arguments' });
  out.push({ kind: 'explore', title: 'Explain how this project is organised and where to start reading', detail: 'A short guided tour, no changes made' });
  return dedupe(out).slice(0, 12);
}

/** Prompt for the model to propose tasks tailored to the project; answers are parsed with `parseModelSuggestions`. */
export function suggestionPrompt(f: SuggestionFacts): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You suggest small, self-contained tasks a coding agent could do right now in this repository. Write for a non-technical reader: one short sentence per task describing the outcome, no jargon, no file paths in the title. Return ONLY a JSON array of 6 objects: {"title": string, "detail": string, "kind": "fix"|"test"|"docs"|"cleanup"|"feature"|"review"|"explore"}. "detail" is one short line saying what will be looked at.',
    },
    {
      role: 'user',
      content: `Project map:\n${f.projectMap.slice(0, 4000)}\n\nGit status:\n${f.gitSummary.slice(0, 1200) || '(clean)'}\n\nProblems: ${f.errors.count} error(s) in ${f.errors.files} file(s)${f.errors.sample ? ` (e.g. ${f.errors.sample})` : ''}.${f.todos ? ` TODO/FIXME notes: ${f.todos}.` : ''}\n\nSuggest 6 tasks.`,
    },
  ];
}

export function parseModelSuggestions(text: string): TaskSuggestion[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) {
    return [];
  }
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) {
      return [];
    }
    const kinds = new Set(['fix', 'test', 'docs', 'cleanup', 'feature', 'review', 'explore']);
    return dedupe(
      arr
        .map((x) => x as { title?: unknown; detail?: unknown; kind?: unknown })
        .filter((x) => typeof x.title === 'string' && x.title.trim().length > 3)
        .map((x) => ({
          title: String(x.title).replace(/\s+/g, ' ').trim().replace(/[.。]$/, '').slice(0, 140),
          detail: typeof x.detail === 'string' ? x.detail.replace(/\s+/g, ' ').trim().slice(0, 160) : undefined,
          kind: (kinds.has(String(x.kind)) ? String(x.kind) : 'feature') as TaskSuggestion['kind'],
        }))
    ).slice(0, 8);
  } catch {
    return [];
  }
}

/** Autocomplete candidates for a partially typed task, best first. */
export function completeTask(input: string, pool: TaskSuggestion[], recent: string[]): string[] {
  const q = input.trim().toLowerCase();
  if (q.length < 2) {
    return [];
  }
  const words = q.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  const whole = words.slice(0, -1);
  // Every finished word must appear as a word; the word being typed must start a word. "write a re" therefore
  // completes to "Write a README…" but not to "Review…" or "…where".
  const score = (t: string): number => {
    const l = t.toLowerCase();
    if (l === q) {
      return -1;
    }
    if (l.startsWith(q)) {
      return 100;
    }
    const tokens = l.split(/[^a-z0-9]+/).filter(Boolean);
    if (!whole.every((w) => tokens.includes(w)) || !tokens.some((tk) => tk.startsWith(last))) {
      return 0;
    }
    return 60 - Math.min(30, Math.max(0, l.length - q.length) / 4);
  };
  const cands = [...new Set([...pool.map((p) => p.title), ...recent])];
  return cands
    .map((t) => ({ t, s: score(t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map((x) => x.t);
}

function dedupe(items: TaskSuggestion[]): TaskSuggestion[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}
