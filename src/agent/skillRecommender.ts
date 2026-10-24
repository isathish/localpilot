import * as fs from 'fs/promises';
import * as path from 'path';
import { userText } from './clarify';

/**
 * Skill recommendation and learning.
 *
 * - `recommendSkills` matches a request against the skill index (name, description, quoted trigger phrases) so
 *   the agent is nudged to load the right playbook — and the user sees the suggestion as chips in the chat.
 * - `SkillLearner` remembers what kinds of requests come up and which skills get used. When the same kind of
 *   request keeps recurring with no skill covering it, it recommends creating one, so the workspace's skill set
 *   grows out of real usage instead of guesswork.
 */

export interface SkillLike {
  name: string;
  description: string;
}

export interface SkillMatch {
  name: string;
  description: string;
  score: number;
}

const STOP = new Set(
  'the a an and or but if then else for to of in on at by with from into onto as is are be was were been being do does did done doing have has had having can could should would will shall may might must this that these those it its they them their there here where when how what which who whom why not no yes please pls just also some any all every each more most less least very really so too up out off over under again new old my our your his her me we you i us he she one two three use used using want need like get got go going come let give take see look know think say said tell help thing things stuff way ways bit lot kind sort'.split(/\s+/)
);

/** Lower-cases, strips punctuation and plural/inflection suffixes, drops stop words and short tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/n['’]t\b/g, ' not')
    .replace(/['’](s|re|ve|ll|d|m)\b/g, '')
    .replace(/[`"'’“”()[\]{}<>]/g, ' ')
    .split(/[^a-z0-9+#.-]+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => (w.length >= 3 || /^(ci|cd|ui|ux|db|pr|js|ts|py|go|ai|ml|qa|io|os|k8s|sql|api|cli|e2e)$/.test(w)) && !STOP.has(w))
    .map(stem);
}

function stem(w: string): string {
  if (w.length <= 4) {
    return w;
  }
  // Plural first, then one derivational suffix: tests/testing → test, deployments → deploy, parsers → parser.
  let s = w.replace(/ies$/, 'y').replace(/(ss)$|s$/, '$1');
  const m = /(ations?|ions?|ing|ed|ments?)$/.exec(s);
  if (m && s.length - m[0].length >= 3) {
    s = s.slice(0, -m[0].length);
    if (s.length >= 4) {
      s = s.replace(/([bdgmnprt])\1$/, '$1'); // running → run, planning → plan (but add stays add)
    }
  }
  return s;
}

/**
 * Phrases a skill author quoted in the description ("deploy", "release") count as explicit triggers. Only real
 * quotes delimit a phrase — an apostrophe inside a word (doesn't) is not a quote — and blank phrases are dropped.
 * A phrase counts when it occurs verbatim; only phrases with several content words also match non-adjacently.
 */
export function triggers(description: string): string[] {
  const out: string[] = [];
  for (const m of description.matchAll(/["“]([^"”]{2,40})["”]|(?:^|[\s(])'([^']{2,40})'(?=$|[\s),.;:!?])/g)) {
    const phrase = (m[1] ?? m[2] ?? '').toLowerCase().trim();
    if (/[a-z0-9]/.test(phrase)) {
      out.push(phrase);
    }
  }
  return out;
}

/** 1 + ln(N / df) per description token: words shared by many skills carry little signal. */
function inverseDocumentFrequency(skills: SkillLike[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const s of skills) {
    for (const t of new Set(tokenize(s.description))) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const n = Math.max(1, skills.length);
  return new Map([...df].map(([t, d]) => [t, 1 + Math.log(n / d)]));
}

/** True when `phrase` occurs in `text` as whole words (so "ship" does not match "relationship"). */
export function containsPhrase(text: string, phrase: string): boolean {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, 'i').test(text);
}

/**
 * Scores skills against a request. A skill is recommended when its name, a quoted trigger phrase or several
 * description terms occur in the request. Returns up to `max` matches, strongest first.
 */
export function recommendSkills(request: string, skills: SkillLike[], max = 3): SkillMatch[] {
  const text = userText(request).toLowerCase();
  const tokens = new Set(tokenize(text));
  if (!tokens.size) {
    return [];
  }
  const out: SkillMatch[] = [];
  const idf = inverseDocumentFrequency(skills);
  for (const s of skills) {
    const nameTokens = tokenize(s.name.replace(/[-_]/g, ' '));
    const descTokens = new Set(tokenize(s.description));
    let score = 0;
    let evidence = 0;
    for (const t of nameTokens) {
      if (tokens.has(t)) {
        score += 4;
        evidence++;
      }
    }
    for (const trig of triggers(s.description)) {
      const tt = tokenize(trig);
      if (containsPhrase(text, trig)) {
        score += 4;
        evidence++;
      } else if (tt.length > 1 && tt.every((t) => tokens.has(t))) {
        // All the phrase's content words appear, just not adjacently ("tests… write" for "write tests for").
        score += 2.5;
        evidence++;
      }
    }
    let descHits = 0;
    let descScore = 0;
    for (const t of descTokens) {
      if (tokens.has(t)) {
        descHits++;
        descScore += idf.get(t) ?? 1;
      }
    }
    // Distinctive words ("bug", "dockerfile") count more than ones every skill uses ("code"); long "USE WHEN"
    // descriptions match everything a little, so normalise by length.
    score += (descScore * 1.2) / Math.max(1, Math.log2(descTokens.size / 10 + 1));
    if (descHits >= 2) {
      evidence++;
    }
    if (evidence > 0 && score >= 2.5) {
      out.push({ name: s.name, description: s.description, score: Math.round(score * 10) / 10 });
    }
  }
  // Only keep runners-up that are in the same league as the best match; weak tails are noise in the UI and the prompt.
  const ranked = out.sort((a, b) => b.score - a.score);
  return ranked.filter((m, i) => i === 0 || m.score >= ranked[0].score * 0.5).slice(0, max);
}

/** Coarse "kind of request" key: the main verb plus the two most specific nouns, e.g. "deploy|docker|staging". */
export function topicKey(request: string): string | undefined {
  const text = userText(request);
  const verb = /\b(fix|debug|refactor|implement|add|create|write|test|review|deploy|release|document|explain|migrate|convert|optimi[sz]e|design|plan|setup|set up|configure|install|build|generate|scaffold|analy[sz]e|benchmark|profile|lint|format|translate|upgrade|commit|publish)\b/i.exec(text)?.[1].toLowerCase().replace(/\s+/g, '');
  const verbStems = new Set(verb ? tokenize(verb) : []);
  const nouns = tokenize(text).filter((t) => !verbStems.has(t) && !/^(fix|debug|refactor|implement|add|creat|writ|test|review|deploy|releas|document|explain|migrat|convert|optimi|design|plan|setup|configur|install|build|generat|scaffold|analy|benchmark|profil|lint|format|translat|upgrad|commit|publish)/.test(t));
  if (!verb && nouns.length < 2) {
    return undefined;
  }
  const picked = [...new Set(nouns)].sort((a, b) => b.length - a.length).slice(0, 2).sort();
  return [verb ?? '*', ...picked].join('|');
}

export interface SkillCreateSuggestion {
  topic: string;
  slug: string;
  count: number;
  samples: string[];
}

export interface SkillSuggestions {
  /** Existing skills that match the request. */
  skills: SkillMatch[];
  /** A recurring kind of request that no skill covers yet. */
  create?: SkillCreateSuggestion;
}

interface LearningState {
  version: 1;
  topics: Record<string, { count: number; last: number; samples: string[]; coveredBy?: string }>;
  skillUse: Record<string, { count: number; last: number }>;
  dismissed: string[];
}

const EMPTY: LearningState = { version: 1, topics: {}, skillUse: {}, dismissed: [] };
const RECUR_THRESHOLD = 3;
const RETENTION_MS = 60 * 24 * 60 * 60_000;

/** Persists request topics and skill usage (JSON file) and derives "create a skill for this" recommendations. */
export class SkillLearner {
  private state: LearningState = { ...EMPTY, topics: {}, skillUse: {}, dismissed: [] };
  private loaded?: Promise<void>;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    /** Absolute path of the JSON file holding the learning state. */
    private readonly file: string,
    private readonly log?: { warn(msg: string): void }
  ) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = await fs.readFile(this.file, 'utf8');
        const parsed = JSON.parse(raw) as Partial<LearningState>;
        if (parsed && parsed.version === 1) {
          this.state = { version: 1, topics: parsed.topics ?? {}, skillUse: parsed.skillUse ?? {}, dismissed: parsed.dismissed ?? [] };
        }
      } catch {
        /* first run */
      }
      const cutoff = Date.now() - RETENTION_MS;
      for (const [k, v] of Object.entries(this.state.topics)) {
        if (v.last < cutoff) {
          delete this.state.topics[k];
        }
      }
    })();
    return this.loaded;
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 500);
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      this.log?.warn(`skill learning: could not save ${this.file}: ${String(e)}`);
    }
  }

  /** Records a top-level request and the skills recommended for it; returns suggestions for the UI/prompt. */
  async observeRequest(request: string, skills: SkillLike[]): Promise<SkillSuggestions> {
    await this.load();
    const matches = recommendSkills(request, skills);
    const topic = topicKey(request);
    let create: SkillCreateSuggestion | undefined;
    if (topic) {
      const t = (this.state.topics[topic] ??= { count: 0, last: 0, samples: [] });
      t.count++;
      t.last = Date.now();
      const sample = userText(request).replace(/\s+/g, ' ').slice(0, 160);
      if (sample && !t.samples.includes(sample)) {
        t.samples = [...t.samples, sample].slice(-5);
      }
      t.coveredBy = matches[0]?.name;
      if (!matches.length && t.count >= RECUR_THRESHOLD && !this.state.dismissed.includes(topic)) {
        create = { topic, slug: slugFor(topic), count: t.count, samples: t.samples };
      }
      this.scheduleSave();
    }
    return { skills: matches, create };
  }

  async recordSkillUsed(name: string): Promise<void> {
    await this.load();
    const u = (this.state.skillUse[name] ??= { count: 0, last: 0 });
    u.count++;
    u.last = Date.now();
    this.scheduleSave();
  }

  async dismiss(topic: string): Promise<void> {
    await this.load();
    if (!this.state.dismissed.includes(topic)) {
      this.state.dismissed.push(topic);
      this.scheduleSave();
    }
  }

  /** Usage counts for the settings page. */
  async usage(): Promise<{ skillUse: Record<string, { count: number; last: number }>; recurring: SkillCreateSuggestion[] }> {
    await this.load();
    const recurring = Object.entries(this.state.topics)
      .filter(([k, v]) => v.count >= RECUR_THRESHOLD && !v.coveredBy && !this.state.dismissed.includes(k))
      .map(([k, v]) => ({ topic: k, slug: slugFor(k), count: v.count, samples: v.samples }))
      .sort((a, b) => b.count - a.count);
    return { skillUse: this.state.skillUse, recurring };
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
  }
}

export function slugFor(topic: string): string {
  return topic
    .split('|')
    .filter((p) => p && p !== '*')
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'new-skill';
}

/** Prompt the user can send to have the agent write the skill file for a recurring request type. */
export function createSkillPrompt(s: SkillCreateSuggestion): string {
  return `Create a reusable skill at .localpilot/skills/${s.slug}/SKILL.md for requests like these, which have come up ${s.count} times:\n${s.samples.map((x) => `- "${x}"`).join('\n')}\n\nUse YAML front-matter (name: ${s.slug}, description: one sentence saying when to use it, with 2–3 quoted trigger phrases) and a Markdown body with the concrete, step-by-step procedure that worked in this project: commands to run, files/patterns to follow, how to verify. Keep it under 60 lines. Then reload skills with the localpilot.reloadSkills command.`;
}

/** Hidden steering text so the model loads the matching skill before starting. */
export function skillHint(matches: SkillMatch[]): string {
  if (!matches.length) {
    return '';
  }
  return `Skills that match this request: ${matches.map((m) => `"${m.name}" (${m.description.replace(/\s+/g, ' ').slice(0, 120)})`).join('; ')}. Required first step: call load_skill("${matches[0].name}") before any other tool — the skill holds project-specific steps and formats you cannot know otherwise — then follow its instructions. Skip it only if the skill clearly does not apply.`;
}
