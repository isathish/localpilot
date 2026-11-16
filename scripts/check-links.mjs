#!/usr/bin/env node
// Offline link and anchor check for the built website (Jekyll's _site). Every internal link (relative, root-relative
// under the base URL, or an absolute URL to the site itself) must point to a page or file that exists, and every
// #fragment must match an id (or <a name>) on the target page. External links are not checked here (the Docs
// workflow checks those separately and lets them fail softly).
//   node scripts/check-links.mjs _site [--base /localpilot] [--site https://isathish.github.io]
//   node scripts/check-links.mjs --self-test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const o = { dir: '', base: '', site: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') o.base = argv[++i];
    else if (argv[i] === '--site') o.site = argv[++i];
    else if (argv[i] === '--self-test') o.selfTest = true;
    else o.dir = argv[i];
  }
  o.base = '/' + (o.base || '').replace(/^\/+|\/+$/g, '');
  if (o.base === '/') o.base = '';
  o.site = (o.site || '').replace(/\/+$/, '');
  return o;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const unescapeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Strips <pre>, <code>, <script>, <style>, <template> and comments: links shown as code are not links. */
const strip = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(pre|code|script|style|template|textarea)\b[\s\S]*?<\/\1>/gi, '');

export function checkSite(dir, { base = '', site = '' } = {}) {
  const root = path.resolve(dir);
  const files = walk(root);
  const html = files.filter((f) => /\.html?$/i.test(f));
  const anchors = new Map();
  const anchorsOf = (file) => {
    if (!anchors.has(file)) {
      const src = fs.readFileSync(file, 'utf8');
      const ids = new Set();
      for (const m of src.matchAll(/\s(?:id|name)\s*=\s*(["'])(.*?)\1/gi)) ids.add(unescapeHtml(m[2]));
      anchors.set(file, ids);
    }
    return anchors.get(file);
  };
  /** URL path (without the base) → file in the site, or undefined. */
  const resolveFile = (urlPath) => {
    const rel = decode(urlPath).replace(/^\/+/, '');
    const p = path.join(root, rel);
    if (!p.startsWith(root)) return undefined;
    const tries = urlPath.endsWith('/') || rel === '' ? [path.join(p, 'index.html')] : [p, p + '.html', path.join(p, 'index.html')];
    return tries.find((t) => fs.existsSync(t) && fs.statSync(t).isFile());
  };
  const broken = [];
  let checked = 0;
  for (const file of html) {
    const pageUrl = '/' + path.relative(root, file).split(path.sep).join('/');
    const src = strip(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/<(a|link|img|script|source|iframe)\b[^>]*?\s(href|src)\s*=\s*(["'])(.*?)\3/gi)) {
      let url = unescapeHtml(m[4]).trim();
      if (!url || /^(mailto|tel|javascript|data|blob|about):/i.test(url) || url.includes('{{') || url.includes('{%')) continue;
      if (site && (url === site + base || url.startsWith(site + base + '/') || url.startsWith(site + base + '#'))) url = url.slice(site.length);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) continue; // external
      const [beforeHash, frag = ''] = url.split('#', 2);
      const pathPart = beforeHash.split('?')[0];
      let target;
      if (pathPart === '') {
        target = file;
      } else {
        let abs;
        if (pathPart.startsWith('/')) {
          if (base && pathPart !== base && !pathPart.startsWith(base + '/')) {
            broken.push({ page: pageUrl, url, why: `root-relative link outside the base URL ${base}` });
            continue;
          }
          abs = pathPart.slice(base.length) || '/';
        } else {
          abs = new URL(pathPart, 'http://x' + pageUrl).pathname;
        }
        target = resolveFile(abs);
        if (!target) {
          broken.push({ page: pageUrl, url, why: 'no such page or file' });
          continue;
        }
      }
      checked++;
      const id = decode(frag);
      if (id && !/^(top|!)/.test(id) && /\.html?$/i.test(target) && !anchorsOf(target).has(id)) {
        broken.push({ page: pageUrl, url, why: `no element with id "${id}" on ${'/' + path.relative(root, target).split(path.sep).join('/')}` });
      }
    }
  }
  return { pages: html.length, checked, broken };
}

function selfTest() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-links-'));
  const w = (f, s) => (fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }), fs.writeFileSync(path.join(d, f), s));
  w('index.html', '<a href="/lp/docs/a/">a</a><a href="docs/a/#sec">sec</a><a href="https://site.dev/lp/docs/b.html#x">b</a><a href="https://example.com/nope">ext</a><a href="#here">self</a><h1 id="here">x</h1><code><a href="/lp/missing/">shown as code</a></code>');
  w('docs/a/index.html', '<h2 id="sec">S</h2><a href="../b.html">b</a><a href="../b#gone">gone</a><img src="/lp/assets/x.png"><a href="/elsewhere/">outside</a><a href="/lp/docs/c/">c</a>');
  w('docs/b.html', '<p id="x">x</p><a name="y"></a>');
  w('assets/x.png', '');
  const r = checkSite(d, { base: '/lp', site: 'https://site.dev' });
  fs.rmSync(d, { recursive: true, force: true });
  const urls = r.broken.map((b) => b.url).sort();
  const want = ['../b#gone', '/elsewhere/', '/lp/docs/c/'];
  const ok = JSON.stringify(urls) === JSON.stringify(want);
  console.log(ok ? `check-links self-test passed (${r.checked} links checked)` : `check-links self-test FAILED: broken ${JSON.stringify(r.broken, null, 1)}, expected ${want.join(', ')}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if (o.selfTest) selfTest();
  if (!o.dir || !fs.existsSync(o.dir)) {
    console.error('usage: node scripts/check-links.mjs <site dir> [--base /localpilot] [--site https://host]');
    process.exit(2);
  }
  const r = checkSite(o.dir, o);
  for (const b of r.broken) console.log(`::error title=Broken link::${b.page} → ${b.url} (${b.why})`);
  console.log(`${r.pages} pages, ${r.checked} internal links checked, ${r.broken.length} broken`);
  process.exit(r.broken.length ? 1 : 0);
}
