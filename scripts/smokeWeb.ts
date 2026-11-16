/**
 * Smoke checks for the web tools (bundled into scripts/smoke.ts) against a local HTTP server: web_fetch streams with a
 * byte cap (an endless body ends), refuses binary content types, and a DuckDuckGo refusal (HTTP error or its bot check)
 * is reported as an error instead of "no results".
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { duckduckgo, fetchByteCap, fetchReadable, isTextContentType } from '../src/tools/web';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export async function webTools(check: Check): Promise<void> {
  console.log('\n[Web tools: capped fetch, binary refusal, search errors]');
  let endlessSent = 0;
  const server = http.createServer((req, res) => {
    const u = req.url ?? '';
    if (u === '/endless') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const line = `${'x'.repeat(1023)}\n`;
      const pump = () => {
        while (endlessSent < 64 * 1024 * 1024) {
          endlessSent += line.length;
          if (!res.write(line)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      res.on('close', () => res.removeAllListeners('drain'));
      pump();
    } else if (u === '/image') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '2048' });
      res.end(Buffer.alloc(2048));
    } else if (u === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Hello</h1><p>World</p></body></html>');
    } else if (u.startsWith('/limited/')) {
      res.writeHead(429, { 'content-type': 'text/html' });
      res.end('slow down');
    } else if (u.startsWith('/bot/')) {
      res.writeHead(202, { 'content-type': 'text/html' });
      res.end('<html><div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div></html>');
    } else if (u.startsWith('/ok/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<a rel="nofollow" class="result__a" href="https://example.com/a">Example A</a> <a class="result__snippet" href="x">Snippet A</a>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signal = new AbortController().signal;
  try {
    check('content types: text, JSON and XML are text; images, PDFs and archives are binary', isTextContentType('text/html; charset=utf-8') && isTextContentType('application/json') && isTextContentType('application/vnd.api+json') && !isTextContentType('image/png') && !isTextContentType('application/pdf') && !isTextContentType('application/zip') && !isTextContentType('application/octet-stream'));
    const page = await fetchReadable(`${base}/page`, 20_000);
    check('web_fetch: an HTML page comes back as text', !page.error && /Hello/.test(page.text) && /World/.test(page.text), page);
    const img = await fetchReadable(`${base}/image`, 20_000);
    check('web_fetch: a binary content type is refused with a clear message', !!img.error && /not a text page \(image\/png, 2 KB\)/.test(img.error), img);
    const started = Date.now();
    const big = await fetchReadable(`${base}/endless`, 1000);
    check('web_fetch: a huge body is read only up to the byte cap, then cut', !big.error && big.text.length < 1200 && /truncated/.test(big.text) && endlessSent < 64 * 1024 * 1024 && Date.now() - started < 15_000, { len: big.text.length, sent: endlessSent, cap: fetchByteCap(1000) });
    const limited = await duckduckgo('x', 5, signal, `${base}/limited`).then(() => '', (e: Error) => e.message);
    check('web_search: DuckDuckGo rate limiting is an error naming the HTTP status, not "no results"', /HTTP 429 \(rate limited or blocked\)/.test(limited), limited);
    const bot = await duckduckgo('x', 5, signal, `${base}/bot`).then(() => '', (e: Error) => e.message);
    check('web_search: DuckDuckGo\'s bot check (202) is reported as blocked', /blocked the search with a bot check/.test(bot), bot);
    const ok = await duckduckgo('x', 5, signal, `${base}/ok`);
    check('web_search: results still parse', ok.length === 1 && ok[0].url === 'https://example.com/a', ok);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}
