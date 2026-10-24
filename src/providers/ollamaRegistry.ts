/**
 * Read-only client for the public Ollama model library (https://ollama.com/library).
 *
 * Ollama publishes no JSON API for browsing the library, so this scrapes the same HTML the website renders:
 * `/search` for models (query, capability filter, sort, paging) and `/library/<name>/tags` for the sizes of one
 * model. Parsers are tolerant — they key off stable bits (hrefs, badge text, "•"-separated metadata) rather than
 * Tailwind class names, and a page that stops parsing degrades to an empty result instead of an exception.
 */

export const OLLAMA_LIBRARY_URL = 'https://ollama.com';

export type RegistryCapability = 'tools' | 'vision' | 'thinking' | 'embedding';
export type RegistrySort = 'popular' | 'newest' | 'name';

export interface RegistrySearch {
  q?: string;
  capability?: RegistryCapability | '';
  sort?: RegistrySort;
  /** 1-based. */
  page?: number;
}

/** One model family in the library (what `ollama pull <name>` resolves to `<name>:latest`). */
export interface RegistryModel {
  name: string;
  description: string;
  /** Capability badges as published: `tools`, `vision`, `thinking`, `embedding`. */
  capabilities: string[];
  /** Size badges as published, e.g. `['1b', '4b', '12b']`. */
  sizes: string[];
  /** Human download count as shown (`4.8M`). */
  pulls?: string;
  pullsCount?: number;
  /** Only available through Ollama's cloud (needs `ollama signin`); nothing to download. */
  cloud: boolean;
  url: string;
}

export interface RegistrySearchResult {
  query: RegistrySearch;
  models: RegistryModel[];
  hasMore: boolean;
}

/** One installable tag of a library model. */
export interface RegistryTag {
  /** Full reference for `ollama pull`, e.g. `qwen3:8b`. */
  model: string;
  /** Just the tag part, e.g. `8b`. */
  tag: string;
  /** Download size in GB when the site publishes one (cloud tags do not). */
  sizeGb?: number;
  /** Context length as published, e.g. `128K`. */
  context?: string;
  /** Accepted inputs as published, e.g. `Text, Image`. */
  inputs?: string;
  updated?: string;
  digest?: string;
  /** This tag is what `<name>:latest` points at. */
  isLatest: boolean;
  /** Runs on Ollama's cloud only. */
  cloud: boolean;
}

export interface RegistryTagsResult {
  name: string;
  tags: RegistryTag[];
}

const CAPABILITIES = new Set<string>(['tools', 'vision', 'thinking', 'embedding', 'decision']);
const SIZE_RE = /^(e?\d+(\.\d+)?[bm](-a\d+(\.\d+)?b)?|\d+x\d+(\.\d+)?b)$/i;

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, ' ');
}

/** Parses an `ollama.com/search` page. Exported for tests. */
export function parseOllamaSearchHtml(html: string): { models: RegistryModel[]; hasMore: boolean } {
  const models: RegistryModel[] = [];
  const seen = new Set<string>();
  for (const li of html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? []) {
    const href = /href="\/library\/([^"?#]+)"/.exec(li);
    if (!href) {
      continue;
    }
    const name = decodeEntities(href[1]).trim();
    if (!name || seen.has(name)) {
      continue;
    }
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(li);
    // Capability / size / cloud pills are the rounded `inline-flex` spans; the download counter is an `inline-flex`
    // span too but without the pill radius.
    const badges = [...li.matchAll(/<span\b[^>]*class="inline-flex[^"]*rounded-md[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => stripTags(m[1]).toLowerCase()).filter(Boolean);
    const capabilities = badges.filter((b) => CAPABILITIES.has(b));
    const cloud = badges.includes('cloud');
    const sizes = badges.filter((b) => !CAPABILITIES.has(b) && b !== 'cloud' && SIZE_RE.test(b));
    const dl = /title="([\d,.]+)\s+downloads?"/i.exec(li);
    const pullsText = dl ? /<span\b[^>]*>\s*([\d.,]+[KMB]?)\s*<\/span>\s*<\/span>\s*<\/a>/i.exec(li)?.[1] : undefined;
    seen.add(name);
    models.push({
      name,
      description: p ? stripTags(p[1]) : '',
      capabilities,
      sizes,
      pulls: pullsText ?? (dl ? compactCount(Number(dl[1].replace(/,/g, ''))) : undefined),
      pullsCount: dl ? Number(dl[1].replace(/,/g, '')) || undefined : undefined,
      cloud: cloud && sizes.length === 0,
      url: `${OLLAMA_LIBRARY_URL}/library/${encodeURIComponent(name)}`,
    });
  }
  const hasMore = /data-has-more="true"/.test(html) || /hx-get="\/search\?[^"]*page=\d+"/.test(html);
  return { models, hasMore };
}

/** Parses an `ollama.com/library/<name>/tags` page. Exported for tests. */
export function parseOllamaTagsHtml(name: string, html: string): RegistryTag[] {
  const tags: RegistryTag[] = [];
  const seen = new Set<string>();
  // Every tag row links to `/library/<name>:<tag>` and is followed by its metadata; the mobile layout repeats the
  // same text, so dedupe by reference and take the first (richest) occurrence.
  const re = /<a href="\/library\/([^"]+:[^"]+)"[^>]*>([\s\S]*?)(?=<a href="\/library\/|<\/section>|$)/g;
  for (const m of html.matchAll(re)) {
    const model = decodeEntities(m[1]).trim();
    if (!model.startsWith(`${name}:`) || seen.has(model)) {
      continue;
    }
    const text = stripTags(m[2]);
    const parts = text.split('•').map((s) => s.trim());
    const size = parts.map((s) => /^(\d+(?:\.\d+)?)\s*(GB|MB|TB)$/i.exec(s)).find(Boolean);
    const ctx = /(\d+(?:\.\d+)?[KM]?)\s*context window/i.exec(text);
    const inputs = /((?:Text|Image|Audio|Video)(?:,\s*(?:Text|Image|Audio|Video))*)\s+input/i.exec(text);
    const updated = /(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|yesterday|today)/i.exec(text);
    const digest = /\b([0-9a-f]{12})\b/.exec(text);
    const cloud = /\bcloud\b/i.test(model.split(':')[1]) || /\b(Low|Medium|High)\s+Usage\b/i.test(text);
    seen.add(model);
    tags.push({
      model,
      tag: model.slice(name.length + 1),
      sizeGb: size ? toGb(Number(size[1]), size[2]) : undefined,
      context: ctx?.[1],
      inputs: inputs?.[1],
      updated: updated?.[1],
      digest: digest?.[1],
      isLatest: /^\s*latest\b/i.test(text.slice(model.length)) || model.endsWith(':latest'),
      cloud,
    });
  }
  // `:latest` duplicates a concrete tag with the same digest; keep the concrete one and mark it.
  const latest = tags.find((t) => t.tag === 'latest');
  if (latest) {
    const twin = tags.find((t) => t !== latest && t.digest && t.digest === latest.digest);
    if (twin) {
      twin.isLatest = true;
      tags.splice(tags.indexOf(latest), 1);
    }
  }
  return tags;
}

function toGb(n: number, unit: string): number {
  const u = unit.toUpperCase();
  const gb = u === 'TB' ? n * 1024 : u === 'MB' ? n / 1024 : n;
  return Math.round(gb * 100) / 100;
}

function compactCount(n: number): string {
  if (!Number.isFinite(n)) {
    return '';
  }
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
}

/** Model references Ollama accepts: `name`, `name:tag`, `user/name:tag`, `hf.co/org/repo:Q4_K_M`, `registry/ns/name`. */
export function isValidOllamaModelRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(ref) && ref.length <= 200;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), 15_000);
  signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { accept: 'text/html', 'user-agent': 'LocalPilot (VS Code extension)' } });
    if (!res.ok) {
      throw new Error(`ollama.com answered HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Browses ollama.com so the user can install any public model, not only the curated catalog. Results are cached briefly. */
export class OllamaRegistry {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly baseUrl = OLLAMA_LIBRARY_URL,
    private readonly ttlMs = 10 * 60_000,
    private readonly fetcher: (url: string, signal?: AbortSignal) => Promise<string> = fetchText
  ) {}

  searchUrl(s: RegistrySearch): string {
    const p = new URLSearchParams();
    p.set('q', (s.q ?? '').trim());
    // `c=local` hides cloud-only models; a capability adds a second `c`. Both are what the site's own filters send.
    p.append('c', 'local');
    if (s.capability) {
      p.append('c', s.capability);
    }
    if (s.sort && s.sort !== 'popular') {
      p.set('o', s.sort);
    }
    if (s.page && s.page > 1) {
      p.set('page', String(s.page));
    }
    return `${this.baseUrl}/search?${p.toString()}`;
  }

  async search(s: RegistrySearch, signal?: AbortSignal): Promise<RegistrySearchResult> {
    const query: RegistrySearch = { q: (s.q ?? '').trim(), capability: s.capability || '', sort: s.sort || 'popular', page: Math.max(1, s.page || 1) };
    const url = this.searchUrl(query);
    const parsed = await this.cached(url, async () => parseOllamaSearchHtml(await this.fetcher(url, signal)));
    return { query, ...parsed };
  }

  async tags(name: string, signal?: AbortSignal): Promise<RegistryTagsResult> {
    const clean = name.trim().replace(/^library\//, '');
    if (!isValidOllamaModelRef(clean) || clean.includes(':')) {
      throw new Error(`Not a library model name: ${name}`);
    }
    const url = `${this.baseUrl}/library/${clean}/tags`;
    const tags = await this.cached(url, async () => parseOllamaTagsHtml(clean, await this.fetcher(url, signal)));
    return { name: clean, tags };
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      return hit.value as T;
    }
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}
