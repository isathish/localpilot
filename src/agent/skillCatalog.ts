import * as fs from 'fs/promises';
import * as path from 'path';
import { ParallelPool } from './parallel';
import { userText } from './clarify';
import { describeSource, discoverSkills, InstalledSkill, installSkills, parseSkillSource, SkillSource } from './skillInstaller';
import { containsPhrase, recommendSkills, SkillLike, SkillMatch, tokenize, triggers } from './skillRecommender';

/**
 * Skill catalog: the skills offered by configured repositories (collections in the Agent Skills format), indexed
 * by name and description so a request can be matched against skills that are *not installed yet*. When the best
 * match for a request lives in the catalog rather than on disk, the agent installs it on the spot (or offers to,
 * depending on `localpilot.skills.autoInstall`) and then loads it like any other skill.
 *
 * The index (one small record per skill) is cached in a JSON file shared by the extension and the CLI and refreshed
 * in the background once it is older than `ttlMs`; matching never waits for the network. Skills the user removed
 * after an automatic install, or declined, are not installed again.
 */
export const DEFAULT_SKILL_REPOSITORIES = ['anthropics/skills/skills', 'obra/superpowers/skills', 'github/awesome-copilot/skills'];

export interface CatalogEntry {
  name: string;
  description: string;
  /** Repository source as configured (owner/repo[/path][@ref]). */
  repo: string;
  /** Folder of the skill inside the repository. */
  dir: string;
}

export interface CatalogMatch extends CatalogEntry {
  score: number;
}

interface CatalogState {
  version: 1;
  /** Entries keyed by repository source; refreshed per repository. */
  repos: Record<string, { fetched: number; entries: Omit<CatalogEntry, 'repo'>[]; error?: string }>;
  /** Skills installed automatically: name → repo. A skill that later disappears from disk was removed on purpose. */
  autoInstalled: Record<string, string>;
  /** Skill names the user declined. */
  dismissed: string[];
}

export interface SkillCatalogOptions {
  /** Absolute path of the JSON cache file. */
  cacheFile: string;
  /** Repository sources to index; read on every refresh so settings changes apply without a restart. */
  repositories: () => string[];
  log?: { info(msg: string): void; warn(msg: string): void };
  fetchImpl?: typeof fetch;
  /** Age after which the index is refreshed in the background (default 24 h). */
  ttlMs?: number;
}

/** Below this recommender score (one name word or trigger phrase hit) a catalog skill is not installed on the user's behalf. */
export const AUTO_INSTALL_MIN_SCORE = 4;
/** A catalog skill must beat the best installed match by this factor to be installed instead of it. */
const BEAT_INSTALLED_BY = 1.25;
/** A request word found in at most this many catalog skills is specific enough to qualify the skill on its own. */
const RARE_TOKEN_MAX_DF = 3;
const MAX_ENTRIES_PER_REPO = 600;
const EMPTY: CatalogState = { version: 1, repos: {}, autoInstalled: {}, dismissed: [] };

export class SkillCatalog {
  private state: CatalogState = { ...EMPTY, repos: {}, autoInstalled: {}, dismissed: [] };
  private loaded?: Promise<void>;
  private refreshing?: Promise<CatalogEntry[]>;
  private readonly ttl: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: SkillCatalogOptions) {
    this.ttl = opts.ttlMs ?? 24 * 60 * 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(this.opts.cacheFile, 'utf8')) as Partial<CatalogState>;
        if (parsed?.version === 1) {
          this.state = { version: 1, repos: parsed.repos ?? {}, autoInstalled: parsed.autoInstalled ?? {}, dismissed: parsed.dismissed ?? [] };
        }
      } catch {
        /* first run */
      }
    })();
    return this.loaded;
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.opts.cacheFile), { recursive: true });
      await fs.writeFile(this.opts.cacheFile, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      this.opts.log?.warn(`skill catalog: could not save ${this.opts.cacheFile}: ${String(e)}`);
    }
  }

  /** Repositories whose index is missing or older than the TTL. */
  private stale(repos: string[]): string[] {
    const cutoff = Date.now() - this.ttl;
    return repos.filter((r) => (this.state.repos[r]?.fetched ?? 0) < cutoff);
  }

  /** The cached entries of the configured repositories; kicks off a background refresh when any is stale. */
  async entries(): Promise<CatalogEntry[]> {
    await this.load();
    const repos = this.opts.repositories();
    if (this.stale(repos).length) {
      void this.refresh().catch(() => undefined);
    }
    return this.collect(repos);
  }

  private collect(repos: string[]): CatalogEntry[] {
    return repos.flatMap((repo) => (this.state.repos[repo]?.entries ?? []).map((e) => ({ ...e, repo })));
  }

  /** True when every configured repository has an index on disk. */
  async ready(): Promise<boolean> {
    await this.load();
    return this.opts.repositories().every((r) => !!this.state.repos[r]);
  }

  /** Re-indexes stale (or, with `force`, all) repositories; concurrent calls share one run. Never throws per repo. */
  refresh(force = false, signal?: AbortSignal): Promise<CatalogEntry[]> {
    this.refreshing ??= (async () => {
      try {
        await this.load();
        const repos = this.opts.repositories();
        const todo = force ? repos : this.stale(repos);
        await new ParallelPool(3).map(todo, async (repo) => {
          try {
            const src = parseSkillSource(repo);
            if (!src || src.kind === 'local') {
              throw new Error(`"${repo}" is not a GitHub repository or SKILL.md URL`);
            }
            const found = await discoverSkills(src, { fetchImpl: this.fetchImpl, signal, maxSkills: MAX_ENTRIES_PER_REPO });
            this.state.repos[repo] = { fetched: Date.now(), entries: found.map((f) => ({ name: f.name, description: f.description, dir: f.dir })) };
            this.opts.log?.info(`skill catalog: ${found.length} skills from ${describeSource(src)}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Keep the previous index when a refresh fails (offline, rate limited); retry after a short back-off.
            const prev = this.state.repos[repo];
            this.state.repos[repo] = { fetched: Date.now() - this.ttl + 10 * 60_000, entries: prev?.entries ?? [], error: msg };
            this.opts.log?.warn(`skill catalog: ${repo}: ${msg}`);
          }
        });
        for (const repo of Object.keys(this.state.repos)) {
          if (!repos.includes(repo)) {
            delete this.state.repos[repo];
          }
        }
        if (todo.length) {
          await this.save();
        }
        return this.collect(repos);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** Last error per repository (for Settings / doctor output). */
  async status(): Promise<{ repo: string; skills: number; fetched?: number; error?: string }[]> {
    await this.load();
    return this.opts.repositories().map((repo) => {
      const r = this.state.repos[repo];
      return { repo, skills: r?.entries.length ?? 0, fetched: r?.fetched, error: r?.error };
    });
  }

  /**
   * The catalog skill to install for `request`, if one matches better than anything installed: it must score at
   * least `AUTO_INSTALL_MIN_SCORE`, beat the best installed skill clearly, and not have been removed or declined.
   */
  async match(request: string, installed: SkillLike[]): Promise<CatalogMatch | undefined> {
    const entries = await this.entries();
    return this.pick(request, installed, entries);
  }

  /**
   * Pure ranking step (exposed for tests). A catalog of hundreds of skills shares many words with any request, so
   * only candidates with a *specific* link qualify: a quoted trigger phrase occurs in the request, most of the
   * skill's name words do (at least one of them not common across the catalog), or the request uses words that are
   * rare across the whole catalog and this skill is about them. The best such tier is ranked together with the
   * installed skills by the normal recommender.
   */
  pick(request: string, installed: SkillLike[], entries: CatalogEntry[]): CatalogMatch | undefined {
    const text = userText(request).toLowerCase();
    const tokens = [...new Set(tokenize(text))];
    if (!tokens.length) {
      return undefined;
    }
    const have = new Set(installed.map((s) => s.name));
    const blocked = new Set([...this.state.dismissed, ...Object.keys(this.state.autoInstalled).filter((n) => !have.has(n))]);
    const all = dedupe(entries);
    const candidates = all.filter((e) => !have.has(e.name) && !blocked.has(e.name));
    if (!candidates.length) {
      return undefined;
    }
    const nameDf = new Map<string, number>();
    const anyDf = new Map<string, number>();
    const nameTokensOf = new Map<string, string[]>();
    for (const e of all) {
      const nt = tokenize(e.name.replace(/[-_]/g, ' '));
      nameTokensOf.set(e.name, nt);
      for (const t of new Set(nt)) {
        nameDf.set(t, (nameDf.get(t) ?? 0) + 1);
      }
      for (const t of new Set([...nt, ...tokenize(e.description)])) {
        anyDf.set(t, (anyDf.get(t) ?? 0) + 1);
      }
    }
    const genericMin = Math.max(4, Math.ceil(all.length * 0.02));
    // Tier 1: the whole name (or a quoted trigger phrase) is in the request; tier 2: most of the name; tier 3: the
    // request uses two or more words that are rare across the catalog and this skill is about them.
    const tiers: CatalogEntry[][] = [[], [], []];
    for (const e of candidates) {
      const nt = nameTokensOf.get(e.name) ?? [];
      const hits = nt.filter((n) => tokens.some((t) => similar(t, n)));
      const coverage = nt.length ? hits.length / nt.length : 0;
      const specific = hits.some((h) => (nameDf.get(h) ?? 0) < genericMin);
      // Quoted single words that half the catalog uses ("review", "markdown") are not specific triggers.
      const trigger = triggers(e.description).some((tr) => {
        const tt = tokenize(tr);
        return containsPhrase(text, tr) && (tt.length >= 2 || (tt.length === 1 && (anyDf.get(tt[0]) ?? 0) < genericMin));
      });
      if ((coverage === 1 && specific) || trigger) {
        tiers[0].push(e);
      } else if (coverage >= 0.6 && specific) {
        tiers[1].push(e);
      } else {
        const mine = new Set([...nt, ...tokenize(e.description)]);
        if (tokens.filter((t) => t.length >= 4 && mine.has(t) && (anyDf.get(t) ?? 0) <= RARE_TOKEN_MAX_DF).length >= 2) {
          tiers[2].push(e);
        }
      }
    }
    const strong = tiers.find((t) => t.length);
    if (!strong) {
      return undefined;
    }
    const byName = new Map(strong.map((e) => [e.name, e]));
    // Rank installed and catalog skills together so their scores share one vocabulary weighting.
    const ranked = recommendSkills(request, [...installed, ...strong], 10);
    const bestInstalled = ranked.find((m) => have.has(m.name))?.score ?? 0;
    const top = ranked.find((m) => byName.has(m.name));
    if (!top || top.score < AUTO_INSTALL_MIN_SCORE || top.score < bestInstalled * BEAT_INSTALLED_BY) {
      return undefined;
    }
    return { ...byName.get(top.name)!, score: top.score };
  }

  /**
   * Ranked catalog search for the browse command / CLI. The entry the agent would install for `query` (the strict
   * match, ignoring what is installed) comes first, followed by the looser recommender ranking.
   */
  async search(query: string, max = 10): Promise<CatalogMatch[]> {
    const entries = dedupe(await this.entries());
    const byName = new Map(entries.map((e) => [e.name, e]));
    const best = this.pick(query, [], entries);
    const ranked = recommendSkills(query, entries, max).flatMap((m: SkillMatch) => (byName.has(m.name) ? [{ ...byName.get(m.name)!, score: m.score }] : []));
    return best ? [best, ...ranked.filter((m) => m.name !== best.name)].slice(0, max) : ranked;
  }

  /**
   * Installs one catalog entry into `dest`. With `auto`, the install is recorded as automatic so that a skill the
   * user later deletes is not installed again; explicit installs (browse, CLI) are not recorded.
   */
  async install(entry: CatalogEntry, dest: string, opts: { signal?: AbortSignal; timeoutMs?: number; progress?: (t: string) => void; replace?: boolean; auto?: boolean } = {}): Promise<InstalledSkill | undefined> {
    const src = sourceFor(entry);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
    try {
      const installed = await installSkills(src, { dest, only: [entry.name], signal: ac.signal, fetchImpl: this.fetchImpl, progress: opts.progress, onExists: async () => !!opts.replace });
      const one = installed[0];
      if (one && opts.auto) {
        await this.load();
        this.state.autoInstalled[one.name] = entry.repo;
        await this.save();
      }
      return one;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Marks a skill the user does not want installed automatically. */
  async dismiss(name: string): Promise<void> {
    await this.load();
    if (!this.state.dismissed.includes(name)) {
      this.state.dismissed.push(name);
      await this.save();
    }
  }
}

/** The installer source for one catalog entry (its exact folder, so only that skill is fetched). */
export function sourceFor(entry: CatalogEntry): SkillSource {
  const base = parseSkillSource(entry.repo);
  if (!base || base.kind !== 'github') {
    return base ?? { kind: 'local', path: entry.repo };
  }
  return { ...base, path: entry.dir };
}

/** Same name offered by several repositories: the first configured repository wins. */
function dedupe(entries: CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(e.name) && seen.add(e.name));
}

/** Stems are crude ("write" vs "writ" from "writing"): tokens of 4+ letters match when one begins with the other. */
function similar(a: string, b: string): boolean {
  return a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
}
