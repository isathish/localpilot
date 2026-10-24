/**
 * Registries behind the model gallery for runtimes other than Ollama, sharing Ollama's result shapes so one UI
 * renders all of them:
 *
 * - **Docker Hub** `ai/` namespace — what `docker model pull ai/<name>:<tag>` downloads for Docker Model Runner.
 * - **Hugging Face** GGUF repositories — what `lms get <repo>@<quant>` downloads for LM Studio, and what Ollama
 *   pulls as `hf.co/<repo>:<quant>`.
 *
 * Both have public JSON APIs; no scraping here. Results are cached briefly like the Ollama library.
 */
import { InstallTarget } from './catalog';
import { compactCount, isValidOllamaModelRef, OllamaRegistry, RegistryModel, RegistrySearch, RegistrySearchResult, RegistryTag, RegistryTagsResult } from './ollamaRegistry';

export type GallerySource = 'ollama' | 'docker' | 'huggingface';

export interface GalleryRegistry {
  readonly source: GallerySource;
  search(s: RegistrySearch, signal?: AbortSignal): Promise<RegistrySearchResult>;
  tags(name: string, signal?: AbortSignal): Promise<RegistryTagsResult>;
  clearCache(): void;
}

export const DOCKER_HUB_URL = 'https://hub.docker.com';
export const HUGGING_FACE_URL = 'https://huggingface.co';
const PAGE_SIZE = 20;

/** Fetches JSON and the `Link` header (Hugging Face paginates with it). Injected in tests. */
export type JsonFetcher = (url: string, signal?: AbortSignal) => Promise<{ json: unknown; link?: string }>;

const defaultFetcher: JsonFetcher = async (url, signal) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), 15_000);
  signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { accept: 'application/json', 'user-agent': 'LocalPilot (VS Code extension)' } });
    if (!res.ok) {
      throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
    }
    return { json: await res.json(), link: res.headers.get('link') ?? undefined };
  } finally {
    clearTimeout(t);
  }
};

const gb = (bytes: number | undefined): number | undefined => (typeof bytes === 'number' && bytes > 0 ? Math.round((bytes / 1024 ** 3) * 100) / 100 : undefined);

/** "3 weeks ago" from an ISO timestamp, matching what ollama.com prints. */
export function relativeTime(iso: string | undefined, now = Date.now()): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) {
    return undefined;
  }
  const s = Math.max(0, Math.round((now - t) / 1000));
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, name] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** Parameter-count badges guessed from a name: `Qwen3-8B` → `8b`, `Qwen3-30B-A3B` → `30b-a3b`, `gemma-3n-E4B` → `e4b`. */
export function sizesFromName(name: string): string[] {
  const out: string[] = [];
  for (const m of name.matchAll(/(?<![a-z0-9])(e?\d+(?:\.\d+)?b)(?:-(a\d+(?:\.\d+)?b))?(?![a-z0-9])/gi)) {
    const s = `${m[1]}${m[2] ? `-${m[2]}` : ''}`.toLowerCase();
    if (!out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

/** Capability guesses from a name, for registries without capability metadata. */
function capsFromName(name: string): string[] {
  const n = name.toLowerCase();
  const caps: string[] = [];
  if (/embed|bge-|e5-|minilm|nomic|arctic/.test(n)) {
    caps.push('embedding');
  }
  if (/-vl\b|vl-|vision|llava|moondream|pixtral|omni/.test(n)) {
    caps.push('vision');
  }
  return caps;
}

abstract class CachedRegistry {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    protected readonly baseUrl: string,
    private readonly ttlMs: number,
    protected readonly fetcher: JsonFetcher
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  protected async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      return hit.value as T;
    }
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

// ---------------------------------------------------------------------------------------------------- Docker Hub

interface HubRepo {
  name: string;
  description?: string;
  pull_count?: number;
  star_count?: number;
  last_updated?: string;
}
interface HubTag {
  name: string;
  full_size?: number;
  digest?: string;
  last_updated?: string;
}
interface HubPage<T> {
  count?: number;
  next?: string | null;
  results?: T[];
}

/** The `ai/` namespace on Docker Hub. Hub's search spans every namespace, so the (small) namespace is listed once and filtered here. */
export class DockerHubRegistry extends CachedRegistry implements GalleryRegistry {
  readonly source = 'docker' as const;

  constructor(baseUrl = DOCKER_HUB_URL, ttlMs = 10 * 60_000, fetcher: JsonFetcher = defaultFetcher) {
    super(baseUrl, ttlMs, fetcher);
  }

  /** Top 100 repositories by pulls: Hub refuses anonymous listing past offset 100, and the namespace is only slightly larger. */
  private async listAll(signal?: AbortSignal): Promise<HubRepo[]> {
    return this.cached('ai/', async () => {
      // Hub's `ordering=pull_count` is descending (and `-pull_count` ascending) — the opposite of its docs.
      const { json } = await this.fetcher(`${this.baseUrl}/v2/repositories/ai/?page_size=100&ordering=pull_count`, signal);
      return (json as HubPage<HubRepo>).results ?? [];
    });
  }

  /** Hub-wide search narrowed to the `ai/` namespace, to reach repositories outside the top 100. */
  private async searchHub(q: string, signal?: AbortSignal): Promise<HubRepo[]> {
    return this.cached(`search:${q}`, async () => {
      const { json } = await this.fetcher(`${this.baseUrl}/v2/search/repositories/?query=${encodeURIComponent(`ai/${q}`)}&page_size=50`, signal).catch(() => ({ json: {} }));
      const results = ((json as HubPage<{ repo_name?: string; short_description?: string; pull_count?: number; star_count?: number }>).results ?? []).filter((r) => r.repo_name?.startsWith('ai/'));
      return results.map((r) => ({ name: r.repo_name!.slice(3), description: r.short_description, pull_count: r.pull_count, star_count: r.star_count }));
    });
  }

  async search(s: RegistrySearch, signal?: AbortSignal): Promise<RegistrySearchResult> {
    const query: RegistrySearch = { q: (s.q ?? '').trim(), capability: s.capability || '', sort: s.sort || 'popular', page: Math.max(1, s.page || 1) };
    const q = query.q!.toLowerCase().replace(/^ai\//, '');
    const all = await this.listAll(signal);
    let rows = all.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q));
    if (q) {
      const seen = new Set(rows.map((r) => r.name));
      rows = rows.concat((await this.searchHub(q, signal)).filter((r) => !seen.has(r.name)));
    }
    if (query.capability) {
      rows = rows.filter((r) => capsFromName(r.name).includes(query.capability!));
    }
    rows = [...rows].sort((a, b) =>
      query.sort === 'name' ? a.name.localeCompare(b.name) : query.sort === 'newest' ? Date.parse(b.last_updated ?? '') - Date.parse(a.last_updated ?? '') : (b.pull_count ?? 0) - (a.pull_count ?? 0)
    );
    const start = (query.page! - 1) * PAGE_SIZE;
    const slice = rows.slice(start, start + PAGE_SIZE);
    return {
      query,
      hasMore: start + PAGE_SIZE < rows.length,
      models: slice.map((r) => ({
        name: `ai/${r.name}`,
        description: (r.description ?? '').trim(),
        capabilities: capsFromName(r.name),
        sizes: [],
        pulls: r.pull_count ? compactCount(r.pull_count) : undefined,
        pullsCount: r.pull_count || undefined,
        cloud: false,
        url: `${this.baseUrl}/r/ai/${encodeURIComponent(r.name)}`,
      })),
    };
  }

  async tags(name: string, signal?: AbortSignal): Promise<RegistryTagsResult> {
    const repo = name.trim().replace(/^ai\//, '');
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(repo)) {
      throw new Error(`Not a Docker Hub ai/ model: ${name}`);
    }
    return this.cached(`tags:${repo}`, async () => {
      const [tagList, detail] = await Promise.all([
        // One page of 100 (newest first); Hub refuses anonymous paging beyond that and few repos have more.
        this.fetcher(`${this.baseUrl}/v2/repositories/ai/${repo}/tags?page_size=100&ordering=last_updated`, signal).then((r) => (r.json as HubPage<HubTag>).results ?? []),
        this.fetcher(`${this.baseUrl}/v2/repositories/ai/${repo}/`, signal).then((r) => r.json as HubRepo & { full_description?: string }).catch(() => undefined),
      ]);
      const tags: RegistryTag[] = tagList.map((t) => ({
        model: `ai/${repo}:${t.name}`,
        tag: t.name,
        sizeGb: gb(t.full_size),
        updated: relativeTime(t.last_updated),
        digest: t.digest?.replace(/^sha256:/, '').slice(0, 12),
        isLatest: t.name === 'latest',
        cloud: false,
        format: /safetensors/i.test(t.name) ? 'safetensors' : /mlx/i.test(t.name) ? 'MLX' : 'GGUF',
      }));
      const latest = tags.find((t) => t.tag === 'latest');
      if (latest) {
        const twin = tags.find((t) => t !== latest && t.digest && t.digest === latest.digest);
        if (twin) {
          twin.isLatest = true;
          tags.splice(tags.indexOf(latest), 1);
        }
      }
      tags.sort((a, b) => (a.sizeGb ?? Infinity) - (b.sizeGb ?? Infinity));
      const description = detail?.description?.trim() || firstParagraph(detail?.full_description);
      return { name: `ai/${repo}`, tags, description: description || undefined };
    });
  }
}

/** First meaningful sentence(s) of an HTML/Markdown README, for a one-line description. */
export function firstParagraph(html: string | undefined, max = 240): string {
  if (!html) {
    return '';
  }
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[#*_>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const para = text.split(/(?<=[.!?])\s+(?=[A-Z])/).find((s) => s.length > 40 && !/^(see|learn|read|view|visit|download)\b/i.test(s)) ?? text;
  return para.length > max ? `${para.slice(0, max - 1).trimEnd()}…` : para;
}

// ---------------------------------------------------------------------------------------------- Hugging Face

interface HfModel {
  id: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  tags?: string[];
  lastModified?: string;
}
interface HfDetail extends HfModel {
  gguf?: { total?: number; architecture?: string; context_length?: number };
}
interface HfFile {
  type?: string;
  path: string;
  size?: number;
}

/** Hugging Face Hub, GGUF repositories only. */
export class HuggingFaceRegistry extends CachedRegistry implements GalleryRegistry {
  readonly source = 'huggingface' as const;
  /** Page cursors per query so page N can be fetched after page N-1 (the hub paginates with opaque cursors). */
  private readonly cursors = new Map<string, (string | undefined)[]>();

  constructor(baseUrl = HUGGING_FACE_URL, ttlMs = 10 * 60_000, fetcher: JsonFetcher = defaultFetcher) {
    super(baseUrl, ttlMs, fetcher);
  }

  searchUrl(s: RegistrySearch, cursor?: string): string {
    const p = new URLSearchParams();
    if (s.q) {
      p.set('search', s.q);
    }
    p.set('filter', 'gguf');
    if (s.capability === 'vision') {
      p.set('pipeline_tag', 'image-text-to-text');
    } else if (s.capability === 'embedding') {
      p.set('pipeline_tag', 'feature-extraction');
    }
    if (s.sort === 'name') {
      p.set('sort', 'id');
      p.set('direction', '1');
    } else {
      p.set('sort', s.sort === 'newest' ? 'lastModified' : 'downloads');
      p.set('direction', '-1');
    }
    p.set('limit', String(PAGE_SIZE));
    if (cursor) {
      p.set('cursor', cursor);
    }
    return `${this.baseUrl}/api/models?${p.toString()}`;
  }

  async search(s: RegistrySearch, signal?: AbortSignal): Promise<RegistrySearchResult> {
    const query: RegistrySearch = { q: (s.q ?? '').trim(), capability: s.capability || '', sort: s.sort || 'popular', page: Math.max(1, s.page || 1) };
    const key = `${query.q}|${query.capability}|${query.sort}`;
    const cursors = this.cursors.get(key) ?? [undefined];
    this.cursors.set(key, cursors);
    // Walk forward through any pages we have not seen yet; the UI loads them in order so this is normally one hop.
    let result: { models: RegistryModel[]; hasMore: boolean } = { models: [], hasMore: false };
    for (let page = 1; page <= query.page!; page++) {
      if (page > 1 && cursors[page - 1] === undefined) {
        result = { models: [], hasMore: false };
        break;
      }
      const url = this.searchUrl(query, cursors[page - 1]);
      result = await this.cached(url, async () => {
        const { json, link } = await this.fetcher(url, signal);
        const next = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1];
        const cursor = next ? new URL(next).searchParams.get('cursor') ?? undefined : undefined;
        if (cursor) {
          cursors[page] = cursor;
        }
        const list = Array.isArray(json) ? (json as HfModel[]) : [];
        return { models: list.map((m) => this.toModel(m)), hasMore: !!cursor && list.length > 0 };
      });
      if (!result.hasMore) {
        if (page < query.page!) {
          result = { models: [], hasMore: false };
        }
        break;
      }
    }
    return { query, ...result };
  }

  private toModel(m: HfModel): RegistryModel {
    const tags = m.tags ?? [];
    const caps: string[] = [];
    if (m.pipeline_tag === 'image-text-to-text' || tags.includes('image-text-to-text')) {
      caps.push('vision');
    }
    if (['feature-extraction', 'sentence-similarity'].includes(m.pipeline_tag ?? '') || tags.includes('sentence-similarity')) {
      caps.push('embedding');
    }
    return {
      name: m.id,
      description: '',
      capabilities: caps,
      sizes: sizesFromName(m.id.split('/').pop() ?? m.id),
      pulls: m.downloads ? compactCount(m.downloads) : undefined,
      pullsCount: m.downloads || undefined,
      cloud: false,
      url: `${this.baseUrl}/${m.id}`,
    };
  }

  async tags(name: string, signal?: AbortSignal): Promise<RegistryTagsResult> {
    const repo = name.trim().replace(/^hf\.co\//i, '').replace(/^huggingface\.co\//i, '');
    if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo)) {
      throw new Error(`Not a Hugging Face repository: ${name}`);
    }
    return this.cached(`tags:${repo}`, async () => {
      const [detail, tree] = await Promise.all([
        this.fetcher(`${this.baseUrl}/api/models/${repo}`, signal).then((r) => r.json as HfDetail).catch(() => undefined),
        this.fetcher(`${this.baseUrl}/api/models/${repo}/tree/main?recursive=true`, signal).then((r) => (Array.isArray(r.json) ? (r.json as HfFile[]) : [])),
      ]);
      const hasProjector = tree.some((f) => /(^|\/)mmproj.*\.gguf$/i.test(f.path));
      const ctx = detail?.gguf?.context_length;
      const vision = hasProjector || detail?.pipeline_tag === 'image-text-to-text';
      const groups = groupQuants(tree);
      const tags: RegistryTag[] = [...groups.entries()].map(([quant, bytes]) => ({
        model: quant === 'latest' ? `hf.co/${repo}` : `hf.co/${repo}:${quant}`,
        tag: quant,
        sizeGb: gb(bytes),
        context: ctx ? `${Math.round(ctx / 1024)}K` : undefined,
        inputs: vision ? 'Text, Image' : 'Text',
        updated: relativeTime(detail?.lastModified),
        // Ollama's `hf.co/<repo>` with no tag picks Q4_K_M when the repo has one.
        isLatest: quant === 'latest' || quant.toUpperCase() === 'Q4_K_M',
        cloud: false,
        format: 'GGUF',
      }));
      tags.sort((a, b) => (a.sizeGb ?? Infinity) - (b.sizeGb ?? Infinity));
      return { name: repo, tags };
    });
  }
}

/** Total bytes per quantisation. Sharded repos keep each quant in a folder; flat repos encode it in the filename. */
export function groupQuants(allFiles: HfFile[]): Map<string, number> {
  const out = new Map<string, number>();
  // Vision projector files (`mmproj-*.gguf`) accompany every quant and are not quants themselves.
  const files = allFiles.filter((f) => f.type !== 'directory' && /\.gguf$/i.test(f.path) && !/(^|\/)mmproj/i.test(f.path));
  const flat = files.filter((f) => !f.path.includes('/'));
  // Common prefix of the filenames, cut back to a separator so `…-Q4_K_M` / `…-Q8_0` do not lose their `Q`.
  const raw = commonPrefix(flat.map((f) => f.path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '.gguf')));
  const prefix = raw.slice(0, Math.max(raw.lastIndexOf('-'), raw.lastIndexOf('_'), raw.lastIndexOf('.')) + 1);
  for (const f of files) {
    let quant: string;
    if (f.path.includes('/')) {
      quant = f.path.split('/')[0];
    } else {
      const base = f.path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '.gguf').replace(/\.gguf$/i, '');
      quant = flat.length > 1 ? base.slice(prefix.length).replace(/^[-_.]+/, '') : quantFromName(base) ?? '';
      if (!quant) {
        quant = quantFromName(base) ?? 'latest';
      }
    }
    out.set(quant, (out.get(quant) ?? 0) + (f.size ?? 0));
  }
  return out;
}

function quantFromName(s: string): string | undefined {
  return /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP\d|NVFP\d))$/i.exec(s)?.[1];
}

function commonPrefix(strs: string[]): string {
  if (strs.length < 2) {
    return '';
  }
  let p = strs[0];
  for (const s of strs.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) {
      i++;
    }
    p = p.slice(0, i);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------- install refs

/** Reference a runtime installs for a gallery tag: `qwen3:8b`, `ai/qwen3:8b`, `hf.co/org/repo:Q4_K_M`, `org/repo@q4_k_m`. */
export function galleryInstallRef(source: GallerySource, target: InstallTarget, tag: Pick<RegistryTag, 'model' | 'tag'>): string | undefined {
  if (source === 'ollama') {
    return target === 'ollama' ? tag.model : undefined;
  }
  if (source === 'docker') {
    return target === 'docker' ? tag.model : undefined;
  }
  const repo = tag.model.replace(/^hf\.co\//, '').replace(/:[^/]*$/, '');
  if (target === 'ollama') {
    return tag.model;
  }
  if (target === 'lmstudio') {
    return tag.tag === 'latest' ? repo : `${repo}@${tag.tag.toLowerCase()}`;
  }
  return undefined;
}

/** Validates what the webview asks a runtime to download, per runtime syntax. */
export function isValidInstallRef(target: InstallTarget, ref: string): boolean {
  if (ref.length > 240 || /\.\./.test(ref)) {
    return false;
  }
  if (target === 'ollama') {
    return isValidOllamaModelRef(ref);
  }
  if (target === 'docker') {
    return /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,3}(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/i.test(ref);
  }
  return /^[A-Za-z0-9][\w.-]*(\/[A-Za-z0-9][\w.-]*)?(@[\w.-]+)?$/.test(ref);
}

export function createGalleryRegistries(): Record<GallerySource, GalleryRegistry> {
  return { ollama: new OllamaRegistry(), docker: new DockerHubRegistry(), huggingface: new HuggingFaceRegistry() };
}
