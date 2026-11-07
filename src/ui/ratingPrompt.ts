// "How's LocalPilot working for you?": a star rating asked at a good moment, which sends the user to the Marketplace
// review form (where only they can post a rating: the Marketplace has no API for submitting one) and, for a low
// rating, also offers a GitHub issue. The real Marketplace average and count are read from its public gallery API.

/** `globalState` key of the rating state below. */
export const RATING_STATE = 'localpilot.rating';
/** `globalState` key of the cached Marketplace statistics. */
export const RATING_STATS = 'localpilot.rating.stats';

export const EXTENSION_ID = 'localpilot.localpilot-agent';
export const MARKETPLACE_URL = `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`;
/** Opens the Marketplace page on its "Rating & Review" tab, where a signed-in user writes the review. */
export const REVIEW_URL = `${MARKETPLACE_URL}&ssr=false#review-details`;
export const REPO_URL = 'https://github.com/isathish/localpilot';

const DAY = 86_400_000;
/** Completed runs before the first ask: someone who has used it, not someone trying it once. */
export const RUNS_BEFORE_ASK = 8;
/** Days after the first run before the first ask. */
export const DAYS_BEFORE_ASK = 3;
/** Days between asks after "Later". */
export const DAYS_BETWEEN_ASKS = 45;
/** Asks in total; after that only the command and Settings offer it. */
export const MAX_ASKS = 3;
const STATS_TTL = DAY;

export interface RatingState {
  /** First completed run on this machine (ms). */
  firstRunAt?: number;
  /** Completed runs counted so far. */
  runs: number;
  /** When the card was last shown and put off. */
  lastAskedAt?: number;
  asks: number;
  /** The user's own rating, kept on this machine only. */
  rated?: { stars: number; at: number; version: string };
  /** "Don't ask again". */
  never?: boolean;
}

export interface MarketplaceStats {
  /** Average rating, 0–5. */
  average: number;
  /** Number of ratings. */
  count: number;
  installs?: number;
  /** When it was read (ms). */
  at: number;
}

/** What the chat shows: the card itself and the links its buttons open. */
export interface RatingCard {
  stats?: MarketplaceStats;
  /** Marketplace review form, or the GitHub repository for editors without the VS Code Marketplace (Cursor, VSCodium). */
  reviewUrl: string;
  /** Where the store link goes: `marketplace` (VS Code) or `github` (other editors: a star on the repository). */
  store: 'marketplace' | 'github';
  /** The user's rating, when they have given one (the command shows the card again to change it). */
  rated?: number;
}

/** Minimal `vscode.Memento` surface, so the logic runs (and is tested) without VS Code. */
export interface RatingMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export function initialState(): RatingState {
  return { runs: 0, asks: 0 };
}

/** Whether the card should appear now: enough use, not too soon, never after a rating or "Don't ask again". */
export function shouldAsk(s: RatingState, now: number): boolean {
  if (s.never || s.rated || s.asks >= MAX_ASKS) {
    return false;
  }
  if (s.runs < RUNS_BEFORE_ASK || s.firstRunAt === undefined || now - s.firstRunAt < DAYS_BEFORE_ASK * DAY) {
    return false;
  }
  return s.lastAskedAt === undefined || now - s.lastAskedAt >= DAYS_BETWEEN_ASKS * DAY;
}

/** The Marketplace page for VS Code; editors that use another gallery (Cursor, VSCodium, Windsurf…) get the repository. */
export function storeFor(appName: string): { store: RatingCard['store']; reviewUrl: string } {
  return /visual studio code/i.test(appName) ? { store: 'marketplace', reviewUrl: REVIEW_URL } : { store: 'github', reviewUrl: REPO_URL };
}

/** A prefilled GitHub issue for a low rating: the version and platform, and a place for what went wrong. */
export function issueUrl(stars: number, version: string, platform: string, appName: string): string {
  const title = `Feedback (${stars}★): `;
  const body = `**What went wrong or could be better?**\n\n\n\n---\nLocalPilot ${version} · ${appName} · ${platform}`;
  return `${REPO_URL}/issues/new?labels=feedback&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** The average, count and installs in a gallery `extensionquery` answer (flags 0x100 = statistics). */
export function parseGalleryStats(json: unknown, now: number): MarketplaceStats | undefined {
  const ext = (json as { results?: { extensions?: { statistics?: { statisticName: string; value: number }[] }[] }[] })?.results?.[0]?.extensions?.[0];
  if (!ext?.statistics) {
    return undefined;
  }
  const stat = (name: string) => ext.statistics!.find((s) => s.statisticName === name)?.value;
  const count = stat('ratingcount') ?? 0;
  const average = stat('averagerating') ?? 0;
  return { average: Math.round(average * 10) / 10, count, installs: stat('install'), at: now };
}

/** Reads the Marketplace statistics (public, no key). Undefined when offline or the gallery does not answer in time. */
export async function fetchMarketplaceStats(now: number, fetchFn: typeof fetch = fetch, timeoutMs = 4000): Promise<MarketplaceStats | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
      body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }], flags: 0x100 }),
      signal: ctl.signal,
    });
    return res.ok ? parseGalleryStats(await res.json(), now) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

/**
 * When to ask for a rating and what happens after. Counts completed runs, shows the card at most `MAX_ASKS` times
 * (`DAYS_BETWEEN_ASKS` apart), never again after a rating or "Don't ask again". The user's stars stay on this machine.
 */
export class RatingPrompt {
  private card: RatingCard | undefined;
  private readonly onChange = new Set<() => void>();

  constructor(
    private readonly mem: RatingMemento,
    private readonly version: string,
    private readonly appName: string,
    private readonly deps: { now?: () => number; fetchStats?: (now: number) => Promise<MarketplaceStats | undefined> } = {}
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get state(): RatingState {
    return { ...initialState(), ...(this.mem.get<RatingState>(RATING_STATE) ?? {}) };
  }

  /** The card to show above the composer, until it is answered or put off. */
  get pending(): RatingCard | undefined {
    return this.card;
  }

  /** Called when the card appears or goes away, so the chat can redraw. */
  subscribe(fn: () => void): () => void {
    this.onChange.add(fn);
    return () => this.onChange.delete(fn);
  }

  private changed(): void {
    this.onChange.forEach((fn) => fn());
  }

  /** The Marketplace average and count, cached for a day; a stale value is kept when the gallery does not answer. */
  async stats(force = false): Promise<MarketplaceStats | undefined> {
    const cached = this.mem.get<MarketplaceStats>(RATING_STATS);
    if (!force && cached && this.now() - cached.at < STATS_TTL) {
      return cached;
    }
    const fresh = await (this.deps.fetchStats ?? fetchMarketplaceStats)(this.now()).catch(() => undefined);
    if (fresh) {
      await this.mem.update(RATING_STATS, fresh);
      return fresh;
    }
    return cached;
  }

  /** A run finished. Successful ones count toward the first ask; the card appears once it is time. */
  async noteRun(ok: boolean): Promise<void> {
    if (!ok) {
      return;
    }
    const s = this.state;
    s.runs++;
    s.firstRunAt ??= this.now();
    await this.mem.update(RATING_STATE, s);
    if (!this.card && shouldAsk(s, this.now())) {
      await this.show();
    }
  }

  /** Shows the card now (the "Rate LocalPilot" command; also after a rating, to change it). */
  async show(): Promise<RatingCard> {
    const { store, reviewUrl } = storeFor(this.appName);
    const rated = this.state.rated?.stars;
    this.card = { store, reviewUrl, ...(rated ? { rated } : {}) };
    this.changed();
    const stats = store === 'marketplace' ? await this.stats() : undefined;
    if (stats && this.card) {
      this.card = { ...this.card, stats };
      this.changed();
    }
    return this.card ?? { store, reviewUrl };
  }

  /**
   * The user picked `stars`. Kept on this machine; the card closes. Returns the links for the follow-up: the review
   * form (always offered, whatever the rating) and, for 1–3 stars, a prefilled GitHub issue.
   */
  async rate(stars: number, platform: string): Promise<{ reviewUrl: string; store: RatingCard['store']; issueUrl?: string }> {
    const n = Math.max(1, Math.min(5, Math.round(stars)));
    const s = this.state;
    s.rated = { stars: n, at: this.now(), version: this.version };
    await this.mem.update(RATING_STATE, s);
    this.card = undefined;
    this.changed();
    const { store, reviewUrl } = storeFor(this.appName);
    return { reviewUrl, store, ...(n <= 3 ? { issueUrl: issueUrl(n, this.version, platform, this.appName) } : {}) };
  }

  /** "Later" (`forever` false) puts it off for `DAYS_BETWEEN_ASKS`; "Don't ask again" ends it. */
  async dismiss(forever: boolean): Promise<void> {
    const s = this.state;
    s.asks++;
    s.lastAskedAt = this.now();
    if (forever) {
      s.never = true;
    }
    await this.mem.update(RATING_STATE, s);
    this.card = undefined;
    this.changed();
  }
}
