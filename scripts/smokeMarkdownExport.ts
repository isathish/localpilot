/** Smoke checks for the Markdown reader's export and reading controls (bundled into scripts/smoke.ts; no VS Code needed). */
import { buildExportDocument, rewriteImageSources, sanitizeExportHtml } from '../src/ui/markdown/export';
import { DEFAULT_PREFS, readPrefs } from '../src/ui/markdown/prefs';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export function markdownExport(check: Check): void {
  console.log('\n— markdown export —');
  const article = sanitizeExportHtml('<article><p onclick="x()">a</p><script>alert(1)</script><a href="javascript:x">b</a><code> onclick = ok</code></article>');
  check('export sanitiser strips scripts and handlers, keeps code text', !/<script|onclick="|javascript:/.test(article) && article.includes(' onclick = ok'), article);
  const doc = buildExportDocument({ title: 't', article, css: '', theme: 'light', prefs: DEFAULT_PREFS });
  check('exported page has a strict CSP and no script', doc.includes("default-src 'none'") && !/<script/i.test(doc));
  check('exported page lets linked local images (over 5 MB) load', /img-src [^;]*\bfile:/.test(doc));
  const img = rewriteImageSources('<img src="vr://a.png" loading="lazy">', new Map([['vr://a.png', 'data:image/png;base64,AA==']]), (s) => s.startsWith('vr:'));
  check('local images are embedded and not lazy', img === '<img src="data:image/png;base64,AA==">', img);
  check('the old reader font size is migrated', readPrefs(undefined, 19).fontSize === 19 && readPrefs({}, 19).fontSize === DEFAULT_PREFS.fontSize);
}
