import { getConfig } from '../config';
import { Tool } from '../types';
import { withTimeout } from '../providers/http';
import { resolveApiKey } from '../providers/cloud';

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 LocalPilot/0.1';

export const webSearchTool: Tool = {
  approvalKind: 'network',
  parallelSafe: true,
  definition: {
    name: 'web_search',
    description: 'Search the web and return titles, URLs and snippets. Use web_fetch to read a result in full.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'integer', description: 'Default from settings (6)' } },
      required: ['query'],
    },
  },
  async execute(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return { content: 'query is required', isError: true };
    }
    const cfg = getConfig().webSearch;
    const max = Number(args.max_results ?? cfg.maxResults);
    const ok = await ctx.requestApproval('Web search', query, 'network');
    if (!ok) {
      return { content: 'User declined the web search.', isError: true };
    }
    let hits: SearchHit[];
    try {
      switch (cfg.provider) {
        case 'searxng':
          hits = await searxng(query, cfg.searxngUrl ?? 'http://localhost:8888', max, ctx.signal);
          break;
        case 'brave':
          hits = await brave(query, resolveApiKey({ apiKey: cfg.apiKey }) ?? '', max, ctx.signal);
          break;
        case 'tavily':
          hits = await tavily(query, resolveApiKey({ apiKey: cfg.apiKey }) ?? '', max, ctx.signal);
          break;
        default:
          hits = await duckduckgo(query, max, ctx.signal);
      }
    } catch (e) {
      if (ctx.signal.aborted) {
        throw e;
      }
      // A blocked or failed search is not "no results": say what happened so the model does not conclude nothing exists.
      return { content: `Web search failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    if (!hits.length) {
      return { content: `No results for "${query}".` };
    }
    return {
      content: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n'),
      data: hits,
    };
  },
};

export const webFetchTool: Tool = {
  approvalKind: 'network',
  parallelSafe: true,
  definition: {
    name: 'web_fetch',
    description: 'Fetch a web page or API URL and return its readable text content (HTML is converted to plain text / markdown-ish).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, max_chars: { type: 'integer', description: 'Default 20000' } },
      required: ['url'],
    },
  },
  async execute(args, ctx) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) {
      return { content: 'Only http(s) URLs are supported.', isError: true };
    }
    const ok = await ctx.requestApproval('Fetch URL', url, 'network');
    if (!ok) {
      return { content: 'User declined the fetch.', isError: true };
    }
    const r = await fetchReadable(url, Number(args.max_chars ?? 20000), ctx.signal);
    return r.error ? { content: r.error, isError: true } : { content: `Source: ${url}\n\n${r.text}` };
  },
};

/** Content types web_fetch reads as text; anything else that names a type is binary (images, archives, PDFs, media). */
export function isTextContentType(ct: string): boolean {
  const t = ct.split(';')[0].trim().toLowerCase();
  return !t || t.startsWith('text/') || /^application\/(json|xml|xhtml\+xml|javascript|ecmascript|x-javascript|x-yaml|yaml|toml|x-toml|ld\+json|graphql|x-www-form-urlencoded|x-ndjson|ndjson|csv|x-sh|x-httpd-php|rtf)$/.test(t) || /\+(json|xml)$/.test(t);
}

/** Most bytes of a response body web_fetch reads: enough for `max` characters of text out of a heavy HTML page. */
export function fetchByteCap(maxChars: number): number {
  return Math.min(8 * 1024 * 1024, Math.max(1024 * 1024, maxChars * 16));
}

/** The body's first `cap` bytes as text (the rest is never downloaded), and whether it was cut. */
async function readCapped(res: Response, cap: number): Promise<{ text: string; cut: boolean }> {
  const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1];
  const decoder = (() => {
    try {
      return new TextDecoder(charset || 'utf-8');
    } catch {
      return new TextDecoder('utf-8'); // a label Node does not know
    }
  })();
  if (!res.body) {
    const all = await res.text();
    return { text: all.slice(0, cap), cut: all.length > cap };
  }
  const reader = res.body.getReader();
  const parts: string[] = [];
  let read = 0;
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const room = cap - read;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      parts.push(decoder.decode(chunk, { stream: true }));
      read += chunk.byteLength;
      if (read >= cap) {
        cut = true;
        break;
      }
    }
  } finally {
    if (cut) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
  parts.push(decoder.decode());
  return { text: parts.join(''), cut };
}

/** A page as readable text (HTML converted), cut at `max` characters; also used for `@https://…` mentions. */
export async function fetchReadable(url: string, max: number, signal?: AbortSignal): Promise<{ text: string; error?: string }> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain,*/*' }, signal: withTimeout(20_000, signal), redirect: 'follow' });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { text: '', error: `HTTP ${res.status} ${res.statusText}` };
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!isTextContentType(ct)) {
    await res.body?.cancel().catch(() => undefined);
    const size = Number(res.headers.get('content-length'));
    return { text: '', error: `${url} is not a text page (${ct.split(';')[0].trim()}${size > 0 ? `, ${(size / 1024).toFixed(0)} KB` : ''}), so it was not read. web_fetch reads HTML, text and JSON; download a file like this with a command instead${/pdf/i.test(ct) ? ' and read it with read_pdf' : ''}.` };
  }
  // Streamed with a byte cap: a huge page or an endless stream never fills memory before it is cut to `max`.
  const body = await readCapped(res, fetchByteCap(max));
  if (!ct && /\u0000/.test(body.text.slice(0, 4096))) {
    return { text: '', error: `${url} returned binary data without a content type, so it was not read.` };
  }
  const text = ct.includes('html') ? htmlToText(body.text) : body.text;
  if (text.length > max) {
    return { text: text.slice(0, max) + `\n\n[truncated ${text.length - max}${body.cut ? '+' : ''} chars]` };
  }
  return { text: body.cut ? `${text}\n\n[truncated: the page is larger than ${(fetchByteCap(max) / 1024 / 1024).toFixed(0)} MB]` : text };
}

/** DuckDuckGo's HTML results. A refusal (an HTTP error, or its bot check, served as 202) is an error, not "no results". */
export async function duckduckgo(q: string, max: number, signal: AbortSignal, base = 'https://html.duckduckgo.com'): Promise<SearchHit[]> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/html/?q=${encodeURIComponent(q)}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: withTimeout(15_000, signal),
  });
  const advice = 'try again in a minute, or set localpilot.webSearch.provider to searxng, brave or tavily';
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`DuckDuckGo answered HTTP ${res.status}${res.status === 429 || res.status === 403 ? ' (rate limited or blocked)' : ''} — ${advice}.`);
  }
  const html = await res.text();
  if (res.status === 202 || (/anomaly-modal|anomaly\.js|challenge-form/i.test(html) && !/class="result__a"/.test(html))) {
    throw new Error(`DuckDuckGo blocked the search with a bot check (HTTP ${res.status}) — ${advice}.`);
  }
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < max) {
    let url = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) {
      url = decodeURIComponent(uddg[1]);
    }
    hits.push({ title: stripTags(m[2]), url, snippet: stripTags(m[3]) });
  }
  return hits;
}

async function searxng(q: string, base: string, max: number, signal: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&format=json`, { headers: { 'user-agent': UA }, signal: withTimeout(15_000, signal) });
  if (!res.ok) {
    throw new Error(`SearXNG at ${base} answered HTTP ${res.status}${res.status === 403 ? ' (is the JSON format enabled in its settings.yml?)' : ''}.`);
  }
  const json = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (json.results ?? []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
}

async function brave(q: string, key: string, max: number, signal: AbortSignal): Promise<SearchHit[]> {
  if (!key) {
    throw new Error('Brave Search requires localpilot.webSearch.apiKey');
  }
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${max}`, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: withTimeout(15_000, signal),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 || res.status === 403 ? `Brave Search rejected the API key (HTTP ${res.status})` : `Brave Search failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (json.web?.results ?? []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? '' }));
}

async function tavily(q: string, key: string, max: number, signal: AbortSignal): Promise<SearchHit[]> {
  if (!key) {
    throw new Error('Tavily requires localpilot.webSearch.apiKey');
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: max }),
    signal: withTimeout(15_000, signal),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 || res.status === 403 ? `Tavily rejected the API key (HTTP ${res.status})` : `Tavily search failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (json.results ?? []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
}

export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, '');
  // Prefer main/article content when present.
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(s);
  if (main && main[2].length > 500) {
    s = main[2];
  }
  s = s
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\`\`\`\n${stripTags(c)}\n\`\`\`\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${stripTags(c)}\``)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, c) => `\n${'#'.repeat(Number(l))} ${stripTags(c)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `\n- ${stripTags(c)}`)
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, c) => {
      const t = stripTags(c).trim();
      return t && /^https?:/.test(href) ? `[${t}](${href})` : t;
    })
    .replace(/<(br|\/p|\/div|\/tr|\/section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export const webTools: Tool[] = [webSearchTool, webFetchTool];
