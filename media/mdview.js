// LocalPilot Markdown reader. The extension renders Markdown → HTML (VS Code's engine) and posts it here; this
// script lays it out, builds the outline, adds copy buttons to code blocks and routes link clicks back.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const els = { doc: $('doc'), outline: $('outline'), title: $('title'), subtitle: $('subtitle'), toc: $('toc'), copy: $('copy'), save: $('save'), open: $('open'), smaller: $('smaller'), larger: $('larger'), toasts: $('toasts') };
  const post = (m) => vscode.postMessage(m);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = vscode.getState() || { outline: null };
  let markdown = '';

  function toast(text, level) {
    const t = document.createElement('div'); t.className = `toast ${level || 'info'}`; t.textContent = text;
    els.toasts.appendChild(t); setTimeout(() => t.remove(), 2600);
  }
  const slug = (s) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'section';

  function decorate() {
    // Heading ids + outline.
    const heads = [...els.doc.querySelectorAll('h1, h2, h3')];
    const used = new Set();
    const items = heads.map((h) => {
      let id = h.id || slug(h.textContent); let n = 2; const base = id;
      while (used.has(id)) { id = `${base}-${n++}`; }
      used.add(id); h.id = id;
      return { id, level: Number(h.tagName[1]), text: h.textContent.trim() };
    });
    els.outline.innerHTML = items.length ? `<div class="grp">On this page</div>${items.map((i) => `<a href="#${esc(i.id)}" class="l${i.level}" data-id="${esc(i.id)}">${esc(i.text)}</a>`).join('')}` : '';
    const wantToc = state.outline === null ? items.length >= 4 && window.innerWidth >= 720 : state.outline;
    setOutline(!!wantToc && items.length > 0, false);
    els.toc.disabled = !items.length;
    // Code blocks: language label + copy.
    for (const pre of els.doc.querySelectorAll('pre')) {
      if (pre.closest('.code')) { continue; }
      const code = pre.querySelector('code');
      const lang = ((code && [...code.classList].find((c) => c.startsWith('language-'))) || '').replace('language-', '');
      const wrap = document.createElement('div'); wrap.className = 'code';
      const head = document.createElement('div'); head.className = 'code-head';
      head.innerHTML = `<span class="lang">${esc(lang || 'text')}</span><button class="cp" title="Copy code"><svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg><span>Copy</span></button>`;
      head.querySelector('.cp').onclick = () => navigator.clipboard.writeText((code || pre).textContent).then(() => toast('Code copied'));
      pre.replaceWith(wrap); wrap.appendChild(head); wrap.appendChild(pre);
    }
    // Task-list checkboxes are read-only here.
    for (const cb of els.doc.querySelectorAll('input[type="checkbox"]')) { cb.disabled = true; }
    // External images shouldn't break layout.
    for (const img of els.doc.querySelectorAll('img')) { img.loading = 'lazy'; }
  }

  function setOutline(on, remember) {
    els.outline.classList.toggle('hidden', !on);
    els.toc.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('with-outline', on);
    if (remember) { state.outline = on; vscode.setState(state); }
  }

  // Scroll-spy for the outline.
  let spyTimer = 0;
  els.doc.addEventListener('scroll', () => {
    if (spyTimer) { return; }
    spyTimer = setTimeout(() => {
      spyTimer = 0;
      const top = els.doc.getBoundingClientRect().top + 24;
      let current = null;
      for (const h of els.doc.querySelectorAll('h1, h2, h3')) { if (h.getBoundingClientRect().top <= top) { current = h.id; } else { break; } }
      for (const a of els.outline.querySelectorAll('a')) { a.classList.toggle('on', a.dataset.id === current); }
    }, 80);
  }, { passive: true });

  // Links: anchors scroll, workspace paths open in VS Code, http(s) opens externally.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) { return; }
    const href = a.getAttribute('href') || '';
    e.preventDefault();
    if (href.startsWith('#')) {
      const t = document.getElementById(decodeURIComponent(href.slice(1)));
      if (t) { t.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) { post({ type: 'openLink', href }); return; }
    const m = /^([^#?]+?)(?::(\d+))?(?:#.*)?$/.exec(href);
    if (m) { post({ type: 'openPath', path: decodeURI(m[1]), line: m[2] ? Number(m[2]) : undefined }); }
  });

  els.toc.onclick = () => setOutline(els.outline.classList.contains('hidden'), true);
  els.copy.onclick = () => post({ type: 'copy' });
  els.save.onclick = () => post({ type: 'saveAs' });
  els.open.onclick = () => post({ type: 'openEditor' });
  els.smaller.onclick = () => post({ type: 'fontSize', delta: -1 });
  els.larger.onclick = () => post({ type: 'fontSize', delta: 1 });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) { return; }
    if (e.key === 'o') { els.toc.click(); }
    else if (e.key === '+' || e.key === '=') { els.larger.click(); }
    else if (e.key === '-') { els.smaller.click(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && !window.getSelection().toString()) { e.preventDefault(); els.copy.click(); }
  });
  window.addEventListener('resize', () => { if (state.outline === null && els.outline.innerHTML && window.innerWidth < 720) { setOutline(false, false); } });

  // Rendered HTML comes from VS Code's Markdown engine over text the model or a file wrote. The CSP already blocks
  // inline script; this strips what it would not — embedded frames, forms, on* attributes and script: URLs — so
  // a document can only ever be a document.
  function scrub(html) {
    const t = document.createElement('template'); t.innerHTML = String(html || '');
    for (const n of t.content.querySelectorAll('script,iframe,object,embed,link,meta,base,form,style')) { n.remove(); }
    for (const n of t.content.querySelectorAll('*')) { for (const a of [...n.attributes]) { if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction|srcdoc)$/i.test(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value))) { n.removeAttribute(a.name); } } }
    return t.innerHTML;
  }
  let reported = 0;
  function reportError(where, err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[LocalPilot markdown] ${where}: ${message}`, err);
    if (reported++ < 20) { try { post({ type: 'clientError', where, message, stack: err instanceof Error && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : undefined }); } catch { /* bridge gone */ } }
  }
  window.addEventListener('error', (e) => reportError('uncaught', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('unhandled rejection', e.reason));

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') { return; }
    try { onMessage(m); } catch (err) { reportError(`message '${m.type}'`, err); }
  });
  function onMessage(m) {
    if (m.type === 'content') {
      const y = els.doc.scrollTop;
      markdown = String(m.markdown || '');
      const words = Number.isFinite(m.words) ? m.words : 0;
      document.documentElement.style.setProperty('--fs', `${Number(m.fontSize) || 14}px`);
      els.title.textContent = m.title || ''; els.subtitle.textContent = `${m.subtitle || ''} · ${words.toLocaleString()} words · ~${Math.max(1, Math.round(words / 220))} min`;
      els.doc.innerHTML = `<article class="md">${scrub(m.html)}</article>`;
      els.save.title = m.isFile ? 'Save a copy as…' : 'Save as…';
      els.open.title = m.isFile ? 'Open in editor' : 'Open as a new Markdown document';
      decorate();
      els.doc.scrollTop = y; // live reload keeps your place
    } else if (m.type === 'toast') { toast(m.text, m.level); }
  }
  post({ type: 'ready' });
})();
