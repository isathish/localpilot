import { getConfig } from '../config';
import { Tool } from '../types';
import { withTimeout } from '../providers/http';

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
    switch (cfg.provider) {
      case 'searxng':
        hits = await searxng(query, cfg.searxngUrl ?? 'http://localhost:8888', max, ctx.signal);
        break;
      case 'brave':
        hits = await brave(query, cfg.apiKey ?? '', max, ctx.signal);
        break;
      case 'tavily':
        hits = await tavily(query, cfg.apiKey ?? '', max, ctx.signal);
        break;
      default:
        hits = await duckduckgo(query, max, ctx.signal);
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
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain,*/*' }, signal: withTimeout(20_000, ctx.signal), redirect: 'follow' });
    if (!res.ok) {
      return { content: `HTTP ${res.status} ${res.statusText}`, isError: true };
    }
    const ct = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    const text = ct.includes('html') ? htmlToText(raw) : raw;
    const max = Number(args.max_chars ?? 20000);
    return { content: `Source: ${url}\n\n${text.length > max ? text.slice(0, max) + `\n\n[truncated ${text.length - max} chars]` : text}` };
  },
};

async function duckduckgo(q: string, max: number, signal: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: withTimeout(15_000, signal),
  });
  const html = await res.text();
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
