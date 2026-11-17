// LocalPilot Markdown reader. The extension renders Markdown → HTML (VS Code's engine) and posts it here; this
// script lays it out, builds the outline, adds copy buttons to code blocks, draws Mermaid diagrams, keeps the view
// and the source editor scrolled together and routes link clicks back.
(function () {
  const vscode = acquireVsCodeApi();
  const nonce = (document.currentScript && document.currentScript.nonce) || '';
  const $ = (id) => document.getElementById(id);
  const els = { doc: $('doc'), outline: $('outline'), list: $('outline-list'), filter: $('filter'), title: $('title'), subtitle: $('subtitle'), toc: $('toc'), find: $('find'), wrap: $('wrap'), copy: $('copy'), save: $('save'), open: $('open'), smaller: $('smaller'), larger: $('larger'), toasts: $('toasts'), prefs: $('prefs'), prefsPop: $('prefs-pop'), sizeVal: $('size-val'), more: $('more'), morePop: $('more-pop'), ask: $('ask'), askSel: $('ask-sel') };
  const post = (m) => vscode.postMessage(m);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = Object.assign({ outline: null, wrap: false }, vscode.getState() || {});
  const save = () => vscode.setState(state);
  let markdown = '';
  let view = { syncScroll: false, isFile: false, outlineDepth: 3, pathRef: '', lineOffset: 0 };
  let generation = 0;
  let canAsk = false;
  /** Characters of a selection quoted into the chat (the host's MAX_QUOTE, sent with each render). */
  let maxQuote = Infinity;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const ASK_KEY = isMac ? "⌘'" : "Ctrl+'";
  // Older markup (and the preview harness) may lack the live region; it is created here then.
  els.askLive = $('ask-live') || Object.assign(document.body.appendChild(document.createElement('div')), { id: 'ask-live', className: 'sr-only' });
  els.askLive.setAttribute('aria-live', 'polite');
  els.askSel.textContent = 'Ask LocalPilot';
  els.askSel.title = `Ask LocalPilot (${ASK_KEY})`;
  els.ask.title = `Ask LocalPilot about this document (${ASK_KEY})`;
  for (const b of [els.askSel, els.ask]) { b.setAttribute('aria-keyshortcuts', isMac ? "Meta+'" : "Control+'"); }
  const DEFAULT_PREFS = { fontSize: 15, width: 'normal', font: 'sans', lineHeight: 1.65 };
  let prefs = Object.assign({}, DEFAULT_PREFS);
  /** Settles when the current document's Mermaid diagrams are drawn (an export waits for it). */
  let mermaidDone = Promise.resolve();

  // The same codicon-style set as the chat and settings views (media/chat.js, media/settings.js `const I`), so one action has one icon.
  const I = {
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    download: '<svg viewBox="0 0 16 16"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 12.5h10"/></svg>',
    link: '<svg viewBox="0 0 16 16"><path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.9.9M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.9-.9"/></svg>',
    code: '<svg viewBox="0 0 16 16"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/></svg>',
    image: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="M13.5 10.5l-3-3-4 4-1.5-1.5-2.5 2.5"/></svg>',
    file: '<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8h4M6 10.5h4"/></svg>',
    warn: '<svg viewBox="0 0 16 16"><path d="M8 2.2l6.3 11.3H1.7z"/><path d="M8 6.6v3.2M8 11.7h.01"/></svg>',
    error: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.7M8 11h.01"/></svg>',
    info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 7.3V11M8 5h.01"/></svg>',
    tip: '<svg viewBox="0 0 16 16"><path d="M6 11.5h4M6.5 13.5h3M8 2a4 4 0 0 0-2.3 7.3c.5.4.8.9.8 1.5v.7h3v-.7c0-.6.3-1.1.8-1.5A4 4 0 0 0 8 2z"/></svg>',
    important: '<svg viewBox="0 0 16 16"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H9l-3 2.5V11H4.5A1.5 1.5 0 0 1 3 9.5z"/><path d="M8 5v2.6M8 9.2h.01"/></svg>',
    caution: '<svg viewBox="0 0 16 16"><path d="M5.6 2h4.8L14 5.6v4.8L10.4 14H5.6L2 10.4V5.6z"/><path d="M8 5v3.6M8 10.8h.01"/></svg>',
  };
  const ICON_COPY = I.copy;

  function toast(text, level) {
    const t = document.createElement('div'); t.className = `toast ${level || 'info'}`; t.setAttribute('role', level === 'error' ? 'alert' : 'status');
    t.innerHTML = level === 'error' ? I.error : ''; t.appendChild(document.createTextNode(text));
    els.toasts.appendChild(t); setTimeout(() => t.remove(), 2600);
  }
  const copyText = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast('Could not copy', 'error'));
  /** Copy from a button: its icon turns into a check for 1.2 s (as in the chat and settings views); a failure still toasts. */
  function copyFrom(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
      const ic = btn.querySelector('svg'); if (!ic || btn.classList.contains('copied')) { return; }
      const was = ic.outerHTML; ic.outerHTML = I.check; btn.classList.add('copied');
      setTimeout(() => { const now = btn.querySelector('svg'); if (now) { now.outerHTML = was; } btn.classList.remove('copied'); }, 1200);
    }, () => toast('Could not copy', 'error'));
  }
  const slug = (s) => String(s).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'section';

  // Same rules as parseLinkTarget in src/ui/markdown/render.ts (a test checks the two agree).
  // <parseLinkTarget>
  function parseLinkTarget(href) {
    const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    const h = String(href == null ? '' : href).trim();
    if (!h) { return undefined; }
    if (h.startsWith('#')) { return h.length > 1 ? { kind: 'anchor', anchor: safeDecode(h.slice(1)) } : undefined; }
    if (/^(https?:\/\/|mailto:)/i.test(h)) { return { kind: 'external', href: h }; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !/^[a-z]:[\\/]/i.test(h)) { return undefined; }
    const hash = h.indexOf('#');
    const frag = hash >= 0 ? h.slice(hash + 1) : '';
    const p = safeDecode((hash >= 0 ? h.slice(0, hash) : h).replace(/\?.*$/, ''));
    if (!p) { return undefined; }
    const out = { kind: 'path', path: p };
    const pos = /^(.*?):L?(\d+)(?:-L?(\d+))?(?::\d+)?$/.exec(p);
    if (pos && pos[1] && !/^[a-z]$/i.test(pos[1])) {
      out.path = pos[1]; out.line = Number(pos[2]);
      if (pos[3]) { out.endLine = Number(pos[3]); }
    }
    const lines = /^L(\d+)(?:-L?(\d+))?$/i.exec(frag);
    const page = /^page=(\d+)$/i.exec(frag);
    if (lines) { out.line = Number(lines[1]); if (lines[2]) { out.endLine = Number(lines[2]); } }
    else if (page) { out.page = Number(page[1]); }
    else if (frag) { out.anchor = safeDecode(frag); }
    if (out.endLine !== undefined && out.line !== undefined && out.endLine < out.line) { delete out.endLine; }
    return out;
  }
  // </parseLinkTarget>

  const ALERTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };
  const headingSel = () => Array.from({ length: view.outlineDepth }, (_, i) => `h${i + 1}`).join(', ');

  function decorate(article) {
    // GitHub alerts: > [!NOTE] … (VS Code's engine leaves them as plain blockquotes).
    for (const bq of article.querySelectorAll('blockquote')) {
      const p = bq.querySelector(':scope > p:first-child');
      const m = p && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.innerHTML);
      if (!m) { continue; }
      const kind = m[1].toUpperCase();
      p.innerHTML = p.innerHTML.slice(m[0].length).replace(/^<br\s*\/?>\s*/i, '');
      if (!p.innerHTML.trim()) { p.remove(); }
      const box = document.createElement('div');
      box.className = `markdown-alert markdown-alert-${kind.toLowerCase()}`;
      if (bq.hasAttribute('data-line')) { box.setAttribute('data-line', bq.getAttribute('data-line')); }
      box.innerHTML = `<p class="markdown-alert-title">${I[{ NOTE: 'info', TIP: 'tip', IMPORTANT: 'important', WARNING: 'warn', CAUTION: 'caution' }[kind]]}${ALERTS[kind]}</p>`;
      while (bq.firstChild) { box.appendChild(bq.firstChild); }
      bq.replaceWith(box);
    }
    // The engine's own alert titles (no icon of their own) get the same icons.
    for (const t of article.querySelectorAll('.markdown-alert-title')) {
      if (t.querySelector('svg')) { continue; }
      const k = (/markdown-alert-(note|tip|important|warning|caution)/.exec(t.parentElement.className) || [])[1];
      if (k) { t.insertAdjacentHTML('afterbegin', I[{ note: 'info', tip: 'tip', important: 'important', warning: 'warn', caution: 'caution' }[k]]); }
    }
    // Heading ids + outline.
    const heads = [...article.querySelectorAll(headingSel())];
    const used = new Set();
    const items = heads.map((h) => {
      let id = h.id || slug(h.textContent); let n = 2; const base = id;
      while (used.has(id)) { id = `${base}-${n++}`; }
      used.add(id); h.id = id;
      return { id, level: Number(h.tagName[1]), text: h.textContent.trim() };
    });
    const minLevel = Math.min(...items.map((i) => i.level));
    els.list.innerHTML = items.length ? `<div class="grp">On this page</div>${items.map((i) => `<a href="#${esc(i.id)}" class="l${i.level - minLevel + 1}" data-id="${esc(i.id)}">${esc(i.text)}</a>`).join('')}` : '';
    els.filter.classList.toggle('hidden', items.length <= 12);
    if (els.filter.value) { applyFilter(); }
    // A narrow reader keeps the drawer as the user left it; it never opens over the page by itself.
    const wantToc = narrow.matches ? !els.outline.classList.contains('hidden') : state.outline === null ? items.length >= 4 && window.innerWidth >= 720 : state.outline;
    setOutline(!!wantToc && items.length > 0, false);
    els.toc.disabled = !items.length;
    // [[toc]] / [TOC] on its own line expands to a nested list of the headings.
    for (const p of article.querySelectorAll('p')) {
      if (!/^\s*(\[\[toc\]\]|\[toc\])\s*$/i.test(p.textContent) || p.children.length) { continue; }
      p.replaceWith(inlineToc(items, minLevel));
    }
    // Tables scroll inside a frame so their header can stay in view.
    for (const t of article.querySelectorAll('table')) {
      if (t.parentElement.classList.contains('table-wrap')) { continue; }
      const w = document.createElement('div'); w.className = 'table-wrap';
      t.replaceWith(w); w.appendChild(t);
    }
    // Code blocks: language label, copy, and "copy as path:line" for blocks we can place in the source.
    for (const pre of article.querySelectorAll('pre')) {
      if (pre.closest('.code')) { continue; }
      const code = pre.querySelector('code');
      const lang = ((code && [...code.classList].find((c) => c.startsWith('language-'))) || '').replace('language-', '');
      const wrap = document.createElement('div'); wrap.className = 'code';
      const head = document.createElement('div'); head.className = 'code-head';
      const lineEl = [pre, code].find((el) => el && blockLine(el) !== undefined);
      const dl = lineEl ? blockLine(lineEl) : undefined;
      head.innerHTML = `<span class="lang">${esc(lang || 'text')}</span>${view.pathRef && dl !== undefined ? `<button class="cp ref" title="Copy as path:line" aria-label="Copy as path:line">${I.link}<span>path:line</span></button>` : ''}<button class="cp" title="Copy code" aria-label="Copy code">${ICON_COPY}<span>Copy</span></button>`;;
      const cp = head.querySelector('.cp:not(.ref)'); cp.onclick = () => copyFrom(cp, (code || pre).textContent);
      const ref = head.querySelector('.ref');
      if (ref) {
        // data-line is the fence line; the code starts on the next one (both 0-based, the reference is 1-based).
        const first = dl + 2 + view.lineOffset;
        const n = Math.max(1, (code || pre).textContent.replace(/\n$/, '').split('\n').length);
        ref.onclick = () => copyFrom(ref, `${view.pathRef}:${first}${n > 1 ? `-${first + n - 1}` : ''}`);
      }
      if (lineEl) { wrap.setAttribute('data-line', String(dl)); lineEl.removeAttribute('data-line'); }
      pre.replaceWith(wrap); wrap.appendChild(head); wrap.appendChild(pre);
    }
    // Task-list checkboxes are read-only here.
    for (const cb of article.querySelectorAll('input[type="checkbox"]')) { cb.disabled = true; }
    for (const img of article.querySelectorAll('img')) { img.loading = 'lazy'; }
  }

  function inlineToc(items, minLevel) {
    const root = document.createElement('ul'); root.className = 'inline-toc';
    const stack = [{ level: minLevel - 1, ul: root }];
    for (const i of items) {
      while (stack.length > 1 && stack[stack.length - 1].level >= i.level) { stack.pop(); }
      let parent = stack[stack.length - 1];
      while (parent.level < i.level - 1) {
        const holder = parent.ul.lastElementChild || parent.ul.appendChild(document.createElement('li'));
        const ul = holder.appendChild(document.createElement('ul'));
        parent = { level: parent.level + 1, ul }; stack.push(parent);
      }
      const li = document.createElement('li');
      li.innerHTML = `<a href="#${esc(i.id)}">${esc(i.text)}</a>`;
      parent.ul.appendChild(li);
      stack.push({ level: i.level, ul: li.appendChild(document.createElement('ul')) });
    }
    for (const ul of root.querySelectorAll('ul')) { if (!ul.children.length) { ul.remove(); } }
    return root;
  }

  function properties(meta, mode) {
    const keys = meta && typeof meta === 'object' ? Object.keys(meta) : [];
    if (!keys.length || mode === 'hidden') { return ''; }
    const val = (v) => Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : typeof v === 'string' ? v : JSON.stringify(v);
    const rows = keys.map((k) => `<tr><th>${esc(k)}</th><td>${esc(val(meta[k]))}</td></tr>`).join('');
    return `<details class="props"${mode === 'expanded' ? ' open' : ''}><summary>Properties (${keys.length})</summary><table>${rows}</table></details>`;
  }

  // Under 640 px the outline is a drawer over the page: a scrim behind it, and a click outside or Escape closes it.
  const scrim = document.createElement('div'); scrim.className = 'scrim hidden'; scrim.setAttribute('aria-hidden', 'true');
  els.outline.before(scrim);
  const narrow = window.matchMedia('(max-width: 640px)');
  const drawerOpen = () => narrow.matches && !els.outline.classList.contains('hidden');
  function setOutline(on, remember, moveFocus) {
    const was = !els.outline.classList.contains('hidden');
    els.outline.classList.toggle('hidden', !on);
    scrim.classList.toggle('hidden', !on);
    els.toc.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('with-outline', on);
    if (remember) { state.outline = on; save(); }
    if (!moveFocus || !narrow.matches || was === on) { return; }
    if (on) { const a = els.list.querySelector('a:not(.hidden)'); if (a) { a.focus({ preventScroll: true }); } } else { els.toc.focus({ preventScroll: true }); }
  }
  const closeDrawer = () => { if (drawerOpen()) { setOutline(false, false, true); } };
  scrim.addEventListener('mousedown', closeDrawer);
  els.doc.addEventListener('mousedown', closeDrawer);
  els.list.addEventListener('click', (e) => { if (e.target.closest('a[href]')) { closeDrawer(); } });
  function applyFilter() {
    const q = els.filter.value.trim().toLowerCase();
    for (const a of els.list.querySelectorAll('a')) { a.classList.toggle('hidden', !!q && !a.textContent.toLowerCase().includes(q)); }
  }
  els.filter.addEventListener('input', applyFilter);
  els.filter.addEventListener('keydown', (e) => {
    // In the drawer, a first Escape clears the filter and a second one closes the drawer.
    if (e.key === 'Escape' && drawerOpen() && els.filter.value) { els.filter.value = ''; applyFilter(); e.stopPropagation(); }
    else if (e.key === 'Escape' && !drawerOpen()) { els.filter.value = ''; applyFilter(); els.doc.focus(); }
    else if (e.key === 'Enter') { const a = els.list.querySelector('a:not(.hidden)'); if (a) { a.click(); } }
  });
  function setWrap(on) {
    state.wrap = on; save();
    document.body.classList.toggle('wrap-code', on);
    els.wrap.setAttribute('aria-pressed', String(on));
    const item = els.morePop.querySelector('[data-act="wrap"]'); if (item) { item.setAttribute('aria-checked', String(on)); }
  }
  setWrap(!!state.wrap);

  // ---- Mermaid: loaded on demand from the bundled copy, re-drawn when the theme changes. ----
  let mermaidLoad = null;
  function loadMermaid(src) {
    if (window.mermaid) { return Promise.resolve(window.mermaid); }
    if (!mermaidLoad) {
      mermaidLoad = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.nonce = nonce; s.src = src;
        s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid did not load')));
        s.onerror = () => { mermaidLoad = null; reject(new Error('Mermaid could not be loaded')); };
        document.head.appendChild(s);
      });
    }
    return mermaidLoad;
  }
  function mermaidTheme() {
    const c = document.body.classList;
    if (c.contains('vscode-high-contrast-light')) { return 'base'; }
    return c.contains('vscode-dark') || c.contains('vscode-high-contrast') ? 'dark' : 'default';
  }
  let mermaidSrc = '';
  async function renderMermaid(gen) {
    const blocks = [...els.doc.querySelectorAll('pre > code.language-mermaid')];
    const figures = [...els.doc.querySelectorAll('figure.mermaid')];
    if (!mermaidSrc || (!blocks.length && !figures.length)) { return; }
    let mermaid;
    try { mermaid = await loadMermaid(mermaidSrc); } catch (err) { toast(err.message, 'error'); return; }
    if (gen !== generation) { return; }
    const font = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() || 'sans-serif';
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mermaidTheme(), fontFamily: font });
    // Fresh blocks become figures; existing figures are re-drawn from their source (theme change).
    for (const code of blocks) {
      const block = code.closest('.code') || code.parentElement;
      const fig = document.createElement('figure');
      fig.className = 'mermaid';
      fig.dataset.source = code.textContent;
      if (block.hasAttribute('data-line')) { fig.setAttribute('data-line', block.getAttribute('data-line')); }
      fig.hidden = true;
      block.before(fig);
      fig.appendChild(block);
    }
    let n = 0;
    for (const fig of els.doc.querySelectorAll('figure.mermaid')) {
      const id = `lp-mermaid-${gen}-${n++}`;
      const source = fig.dataset.source || '';
      const block = fig.querySelector('.code');
      try {
        const { svg } = await mermaid.render(id, source);
        if (gen !== generation) { return; }
        fig.querySelector('.mermaid-error')?.remove();
        let holder = fig.querySelector('.mermaid-svg');
        if (!holder) {
          holder = document.createElement('div'); holder.className = 'mermaid-svg';
          fig.prepend(holder);
          fig.prepend(figureBar(fig));
        }
        holder.innerHTML = svg;
        if (block) { block.hidden = true; }
      } catch (err) {
        document.getElementById(`d${id}`)?.remove();
        document.getElementById(id)?.remove();
        if (gen !== generation) { return; }
        fig.querySelector('.mermaid-svg')?.remove();
        fig.querySelector('.fig-bar')?.remove();
        let e = fig.querySelector('.mermaid-error');
        if (!e) { e = document.createElement('div'); e.className = 'mermaid-error'; e.setAttribute('role', 'note'); fig.prepend(e); }
        e.innerHTML = I.warn; e.append(`Mermaid: ${(err && err.message ? err.message : String(err)).split('\n').slice(0, 4).join(' ')}`);
        if (block) { block.hidden = false; }
      }
      fig.hidden = false;
    }
  }
  function figureBar(fig) {
    const bar = document.createElement('div'); bar.className = 'fig-bar';
    bar.innerHTML = `<button data-act="src" title="Copy the Mermaid source">${I.code}<span>Copy source</span></button><button data-act="svg" title="Copy the diagram as SVG">${I.copy}<span>Copy SVG</span></button><button data-act="save" title="Save the diagram as an SVG file">${I.download}<span>Save SVG…</span></button>`;
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) { return; }
      const svg = () => (fig.querySelector('.mermaid-svg svg') || {}).outerHTML || '';
      if (b.dataset.act === 'src') { copyFrom(b, fig.dataset.source || ''); }
      else if (b.dataset.act === 'svg') { copyFrom(b, svg()); }
      else { post({ type: 'saveAs', svg: svg(), name: `${els.title.textContent.replace(/\.(md|markdown)$/i, '')}-diagram` }); }
    });
    return bar;
  }
  // Only a theme change re-renders; the reader's own body classes (outline, wrap) must not.
  let lastTheme = mermaidTheme();
  new MutationObserver(() => {
    const t = mermaidTheme(); if (t === lastTheme) { return; }
    lastTheme = t;
    if (els.doc.querySelector('figure.mermaid')) { mermaidDone = renderMermaid(++generation); }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // Missing local images: a visible placeholder instead of a broken icon.
  els.doc.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.missing) { return; }
    img.dataset.missing = '1';
    const ph = document.createElement('span'); ph.className = 'img-missing';
    const name = decodeURIComponent((img.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop() || 'image');
    ph.innerHTML = I.image; ph.append(`Image not found: ${img.alt || name}`);
    ph.title = img.getAttribute('src') || '';
    img.replaceWith(ph);
  }, true);

  // ---- Scroll sync with the source editor ----
  let suppressUntil = 0;
  const blockLine = (el) => { const v = Number(el.getAttribute('data-line')); return el.hasAttribute('data-line') && Number.isFinite(v) ? v : undefined; };
  function lineBlocks() {
    const out = [];
    for (const el of els.doc.querySelectorAll('article [data-line]')) {
      const line = blockLine(el);
      if (line === undefined || el.closest('[hidden]') || (out.length && line < out[out.length - 1].line)) { continue; }
      out.push({ el, line });
    }
    return out;
  }
  const topOf = (el) => el.getBoundingClientRect().top - els.doc.getBoundingClientRect().top + els.doc.scrollTop;
  function scrollToLine(line) {
    const blocks = lineBlocks();
    if (!blocks.length) { return; }
    let i = 0;
    while (i + 1 < blocks.length && blocks[i + 1].line <= line) { i++; }
    const cur = blocks[i], next = blocks[i + 1];
    let y = topOf(cur.el);
    if (line > cur.line) {
      const end = next ? topOf(next.el) : y + cur.el.getBoundingClientRect().height;
      const span = next ? next.line - cur.line : Math.max(1, line - cur.line + 1);
      y += (end - y) * Math.min(1, (line - cur.line) / span);
    }
    suppressUntil = Date.now() + 300;
    els.doc.scrollTo({ top: Math.max(0, y - 8), behavior: 'instant' });
  }
  function visibleLine() {
    const blocks = lineBlocks();
    if (!blocks.length) { return undefined; }
    const top = els.doc.scrollTop + 8;
    let i = 0;
    while (i + 1 < blocks.length && topOf(blocks[i + 1].el) <= top) { i++; }
    const cur = blocks[i], next = blocks[i + 1];
    const y = topOf(cur.el);
    if (!next || top <= y) { return cur.line; }
    const ny = topOf(next.el);
    return Math.floor(cur.line + (next.line - cur.line) * Math.min(1, Math.max(0, (top - y) / Math.max(1, ny - y))));
  }
  let syncTimer = 0;
  let lastSent = -1;
  function sendLine() {
    if (Date.now() < suppressUntil) { return; }
    const line = visibleLine();
    if (line !== undefined && line !== lastSent) { lastSent = line; post({ type: 'revealLine', line }); }
  }

  // Scroll-spy for the outline, and the view → editor half of scroll sync.
  let spyTimer = 0;
  els.doc.addEventListener('scroll', () => {
    if (view.syncScroll && Date.now() >= suppressUntil && !syncTimer) {
      syncTimer = setTimeout(() => { syncTimer = 0; sendLine(); }, 50);
    }
    if (spyTimer) { return; }
    spyTimer = setTimeout(() => {
      spyTimer = 0;
      const top = els.doc.getBoundingClientRect().top + 24;
      let current = null;
      for (const h of els.doc.querySelectorAll(headingSel())) { if (h.getBoundingClientRect().top <= top) { current = h.id; } else { break; } }
      for (const a of els.list.querySelectorAll('a')) {
        const on = a.dataset.id === current;
        if (on && !a.classList.contains('on') && !els.outline.classList.contains('hidden')) { a.scrollIntoView({ block: 'nearest' }); }
        a.classList.toggle('on', on);
      }
    }, 80);
  }, { passive: true });

  // Double-click a block to open the source at that line.
  els.doc.addEventListener('dblclick', (e) => {
    if (!view.isFile || e.target.closest('a, button, input, summary, .fig-bar')) { return; }
    const el = e.target.closest('[data-line]');
    const line = el && blockLine(el);
    if (line !== undefined) { post({ type: 'openSourceAt', line }); }
  });

  function scrollToAnchor(anchor) {
    const want = String(anchor || '');
    const t = document.getElementById(want) || document.getElementById(slug(want)) || [...els.doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((h) => slug(h.textContent) === slug(want));
    if (t) { suppressUntil = Date.now() + 300; t.scrollIntoView({ block: 'start' }); }
    else { toast(`No heading "${want}" in this document`, 'error'); }
  }

  // Links: anchors scroll, workspace paths open in VS Code, http(s) opens externally, anything else is ignored.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) { return; }
    e.preventDefault();
    const t = parseLinkTarget(a.getAttribute('href') || '');
    if (!t) { return; }
    if (t.kind === 'anchor') {
      const el = document.getElementById(t.anchor) || document.getElementById(slug(t.anchor));
      if (el) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    } else if (t.kind === 'external') { post({ type: 'openLink', href: t.href }); }
    else { post({ type: 'openPath', path: t.path, line: t.line, endLine: t.endLine, anchor: t.anchor, page: t.page }); }
  });

  // ---- Reading controls ("Aa"), the ⋯ menu, export and Ask LocalPilot ----
  function applyPrefs(p, css) {
    prefs = Object.assign({}, prefs, p || {});
    for (const [k, v] of Object.entries(css || {})) { if (/^--[\w-]+$/.test(k) && typeof v === 'string') { document.documentElement.style.setProperty(k, v); } }
    for (const seg of els.prefsPop.querySelectorAll('.seg[data-key]')) {
      for (const b of seg.querySelectorAll('button')) { b.setAttribute('aria-pressed', String(String(prefs[seg.dataset.key]) === b.dataset.v)); }
    }
    els.sizeVal.textContent = String(prefs.fontSize);
  }
  const pops = [[els.prefs, els.prefsPop], [els.more, els.morePop]];
  function setPop(btn, pop, on) {
    for (const [b, p] of pops) {
      const show = on && p === pop;
      p.classList.toggle('hidden', !show); b.setAttribute('aria-expanded', String(show));
    }
    if (!on) { return; }
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.right = `${Math.max(6, window.innerWidth - r.right)}px`;
    // Narrow-only items are display:none on wide readers; focus the first one that is shown.
    const first = [...pop.querySelectorAll('button')].find((b) => b.offsetParent); if (first) { first.focus({ preventScroll: true }); }
  }
  const closePops = () => { for (const [b, p] of pops) { if (!p.classList.contains('hidden')) { setPop(b, p, false); } } };
  els.prefs.onclick = () => setPop(els.prefs, els.prefsPop, els.prefsPop.classList.contains('hidden'));
  els.more.onclick = () => setPop(els.more, els.morePop, els.morePop.classList.contains('hidden'));
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.pop, #prefs, #more')) { closePops(); } });
  els.prefsPop.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) { return; }
    if (b.dataset.reset) { applyPrefs(DEFAULT_PREFS); post({ type: 'prefs', patch: DEFAULT_PREFS }); return; }
    if (b.dataset.size) { post({ type: 'fontSize', delta: Number(b.dataset.size) }); return; }
    const key = b.closest('.seg').dataset.key;
    const value = key === 'lineHeight' ? Number(b.dataset.v) : b.dataset.v;
    applyPrefs({ [key]: value }); // pressed state at once; the host saves and applies it to every reader
    post({ type: 'prefs', patch: { [key]: value } });
  });
  els.morePop.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) { return; }
    closePops();
    // Toolbar actions folded into the menu on narrow readers.
    const bar = { copy: els.copy, save: els.save, open: els.open, wrap: els.wrap }[b.dataset.act];
    if (bar) { bar.click(); return; }
    if (b.dataset.act === 'settings') { post({ type: 'openSettings' }); return; }
    if (b.dataset.act !== 'clipboard') { toast(`Preparing ${b.dataset.act.toUpperCase()}…`); }
    void sendExport(b.dataset.act);
  });

  // The page as the reader shows it (diagrams drawn), minus the reader's own buttons and hidden fallbacks.
  async function sendExport(target) {
    await mermaidDone.catch(() => undefined);
    const article = els.doc.querySelector('article');
    if (!article) { toast('Nothing to export yet', 'error'); return; }
    const clone = article.cloneNode(true);
    for (const n of clone.querySelectorAll('.fig-bar, .code-head button, [hidden]')) { n.remove(); }
    const props = els.doc.querySelector('details.props');
    const themeClass = ['vscode-high-contrast-light', 'vscode-high-contrast', 'vscode-dark', 'vscode-light'].find((c) => document.body.classList.contains(c)) || '';
    post({ type: 'exportHtml', target, html: clone.outerHTML, preface: props ? props.outerHTML : undefined, vars: document.documentElement.getAttribute('style') || '', themeClass });
  }

  els.ask.onclick = () => post({ type: 'ask' });
  // A floating "Ask LocalPilot" next to a text selection in the document.
  function selectionInDoc() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { return undefined; }
    const text = sel.toString().trim();
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!text || !node || !node.closest('article.md')) { return undefined; }
    return { text, range, node };
  }
  function setAskSel(show) {
    const was = !els.askSel.classList.contains('hidden');
    els.askSel.classList.toggle('hidden', !show);
    if (show !== was) { els.askLive.textContent = show ? 'Ask LocalPilot button available' : ''; }
  }
  /** Shows the pill below the end of the selection (its last line box), as in the PDF viewer; hidden when it scrolled out of view. */
  function placeAskSel() {
    const s = canAsk && selectionInDoc();
    const rects = s ? s.range.getClientRects() : [];
    const r = rects.length ? rects[rects.length - 1] : s && s.range.getBoundingClientRect();
    const box = els.doc.getBoundingClientRect();
    if (!s || !r || r.bottom < box.top || r.top > box.bottom) { setAskSel(false); return; }
    setAskSel(true);
    els.askSel.style.top = `${Math.max(44, Math.min(window.innerHeight - 34, r.bottom + 6))}px`;
    els.askSel.style.left = `${Math.max(6, Math.min(window.innerWidth - els.askSel.offsetWidth - 6, r.right - els.askSel.offsetWidth))}px`;
  }
  let selTimer = 0;
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(placeAskSel, 120); });
  /** The source lines a selection covers (0-based, body-relative): the start block's line to the line before the block after the end block. */
  function selectionLines(s) {
    const blockOf = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return e ? e.closest('[data-line]') : null; };
    const first = blockOf(s.range.startContainer) || s.node.closest('[data-line]');
    const last = blockOf(s.range.endContainer);
    const line = first ? blockLine(first) : undefined;
    const endStart = last ? blockLine(last) : undefined;
    if (line === undefined || endStart === undefined) { return { line }; }
    const next = lineBlocks().find((b) => b.line > endStart);
    const endLine = next ? next.line - 1 : Math.max(endStart, markdown.split('\n').length - 1 - view.lineOffset);
    return { line, endLine: Math.max(line, endLine) };
  }
  function askAboutSelection(key) {
    const s = selectionInDoc(); if (!s) { setAskSel(false); return; }
    const text = s.text.slice(0, maxQuote);
    post({ type: 'askSelection', text, ...selectionLines(s), ...(s.text.length > text.length ? { total: s.text.length } : {}), ...(key ? { key: true } : {}) });
    setAskSel(false);
  }
  els.askSel.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  els.askSel.onclick = () => askAboutSelection(false);
  let selFrame = 0;
  els.doc.addEventListener('scroll', () => { if (!selFrame && !els.askSel.classList.contains('hidden')) { selFrame = requestAnimationFrame(() => { selFrame = 0; placeAskSel(); }); } }, { passive: true });

  els.toc.onclick = () => setOutline(els.outline.classList.contains('hidden'), true, true);
  els.find.onclick = () => post({ type: 'find' });
  els.wrap.onclick = () => setWrap(!state.wrap);
  els.copy.onclick = () => post({ type: 'copy' });
  els.save.onclick = () => post({ type: 'saveAs' });
  els.open.onclick = () => post({ type: 'openEditor' });
  els.smaller.onclick = () => post({ type: 'fontSize', delta: -1 });
  els.larger.onclick = () => post({ type: 'fontSize', delta: 1 });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Focus goes back to the button that opened the popover, or to the outline button when the drawer closes.
      const open = pops.find(([, p]) => !p.classList.contains('hidden'));
      if (open) { closePops(); open[0].focus({ preventScroll: true }); return; }
      if (drawerOpen()) { e.preventDefault(); closeDrawer(); return; }
    }
    if (e.target.closest('input, textarea')) { return; }
    // Ctrl/Cmd+' asks about the selection in the document, else about the document (the host drops the keybinding's duplicate).
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === "'") {
      e.preventDefault();
      if (canAsk) { if (selectionInDoc()) { askAboutSelection(true); } else { post({ type: 'ask', key: true }); } }
      return;
    }
    if (e.key === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) { els.prefs.click(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && !window.getSelection().toString()) { e.preventDefault(); els.copy.click(); }
      return;
    }
    if (e.key === 'o') { els.toc.click(); }
    else if (e.key === 'w') { els.wrap.click(); }
    else if (e.key === '+' || e.key === '=') { els.larger.click(); }
    else if (e.key === '-') { els.smaller.click(); }
    else if (e.key === '/' && !els.toc.disabled) {
      e.preventDefault();
      setOutline(true, true);
      els.filter.classList.remove('hidden');
      els.filter.focus();
    }
  });
  window.addEventListener('resize', () => { if (state.outline === null && els.list.innerHTML && window.innerWidth < 720) { setOutline(false, false); } });

  // Rendered HTML comes from VS Code's Markdown engine over text the model or a file wrote. The CSP already blocks
  // inline script; this strips what it would not — embedded frames, forms, on* attributes and script: URLs — so
  // a document can only ever be a document.
  function scrub(html) {
    const t = document.createElement('template'); t.innerHTML = String(html || '');
    for (const n of t.content.querySelectorAll('script,iframe,object,embed,link,meta,base,form,style')) { n.remove(); }
    for (const n of t.content.querySelectorAll('*')) { for (const a of [...n.attributes]) { if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction|srcdoc)$/i.test(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value))) { n.removeAttribute(a.name); } } }
    return t.innerHTML;
  }
  // Error, empty-document and deleted-file states. Buttons post their action as the message type.
  function stateCard(kind, title, message, actions) {
    const d = document.createElement('div'); d.className = `state-card ${kind}`; d.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    d.innerHTML = `<span class="sc-ico" aria-hidden="true">${kind === 'error' ? I.error : I.file}</span>${title ? `<div class="sc-title">${esc(title)}</div>` : ''}${message ? `<div class="sc-msg">${esc(message)}</div>` : ''}<div class="sc-acts">${actions.map(([t, label, primary]) => `<button class="btn${primary ? ' primary' : ''}" data-post="${esc(t)}">${esc(label)}</button>`).join('')}</div>`;
    d.addEventListener('click', (e) => { const b = e.target.closest('button[data-post]'); if (b) { post({ type: b.dataset.post }); } });
    return d;
  }
  function showDeleted(on) {
    let b = $('deleted');
    if (!on) { if (b) { b.remove(); } return; }
    if (b) { return; }
    b = document.createElement('div'); b.id = 'deleted'; b.className = 'banner'; b.setAttribute('role', 'status');
    b.innerHTML = `${I.warn}<span class="bn-msg">This file was deleted or moved. You are reading the last version.</span><span class="bn-acts"><button class="btn" data-post="saveAs">Save a copy…</button><button class="btn" data-post="close">Close</button></span>`;
    b.addEventListener('click', (e) => { const x = e.target.closest('button[data-post]'); if (x) { post({ type: x.dataset.post }); } });
    $('layout').before(b);
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
      const gen = ++generation;
      view = {
        syncScroll: !!m.syncScroll,
        isFile: !!m.isFile,
        outlineDepth: Math.max(2, Math.min(6, Number(m.outlineDepth) || 3)),
        pathRef: typeof m.pathRef === 'string' ? m.pathRef : '',
        lineOffset: Number(m.lineOffset) || 0,
      };
      mermaidSrc = typeof m.mermaidSrc === 'string' ? m.mermaidSrc : '';
      const words = Number.isFinite(m.words) ? m.words : 0;
      if (m.prefsCss) { applyPrefs(m.prefs, m.prefsCss); }
      else { document.documentElement.style.setProperty('--fs', `${Number(m.fontSize) || 14}px`); }
      canAsk = !!m.canAsk;
      maxQuote = Number(m.maxQuote) || Infinity;
      els.ask.classList.toggle('hidden', !canAsk);
      els.title.textContent = m.title || ''; els.subtitle.textContent = words > 0 ? `${m.subtitle || ''} · ${words.toLocaleString()} words · ~${Math.max(1, Math.round(words / 220))} min` : (m.subtitle || '');
      const open = els.doc.querySelector('details.props');
      els.doc.innerHTML = `${properties(m.frontMatter, m.frontMatterMode)}<article class="md">${scrub(m.html)}</article>`;
      // Keep the Properties table as the reader left it across live reloads.
      const props = els.doc.querySelector('details.props');
      if (props && open) { props.open = open.open; }
      els.save.title = m.isFile ? 'Save a copy as…' : 'Save as…';
      els.open.title = m.isFile ? 'Open in editor' : 'Open as a new Markdown document';
      els.morePop.querySelector('[data-act="save"] span').textContent = els.save.title;
      els.morePop.querySelector('[data-act="open"] span').textContent = els.open.title;
      els.save.setAttribute('aria-label', els.save.title.replace(/…$/, '')); els.open.setAttribute('aria-label', els.open.title);
      els.doc.title = m.isFile ? 'Double-click a block to open the source at that line' : '';
      const article = els.doc.querySelector('article');
      decorate(article);
      if (!article.textContent.trim() && !article.querySelector('img, svg, table, hr, pre, input')) { article.replaceWith(stateCard('empty', '', 'This document is empty.', [['openEditor', m.isFile ? 'Open in editor' : 'Open as Markdown', true]])); }
      els.doc.scrollTop = y; // live reload keeps your place
      suppressUntil = Date.now() + 300;
      state.source = m.persist && m.persist.kind === 'file' ? m.persist : undefined;
      save();
      mermaidDone = renderMermaid(gen);
    } else if (m.type === 'error') {
      // The render failed: the last page would be stale and "Rendering…" would never end, so say so and offer a way out.
      generation++;
      els.doc.innerHTML = ''; els.doc.title = '';
      els.doc.appendChild(stateCard('error', String(m.title || "Couldn't render this document"), String(m.message || ''), [['reload', 'Retry', true], ['openEditor', 'Open in editor'], ['close', 'Close']]));
      const first = els.doc.querySelector('.state-card button'); if (first) { first.focus(); }
    } else if (m.type === 'deleted') { showDeleted(true); }
    else if (m.type === 'restored') { showDeleted(false); }
    else if (m.type === 'prefs') { applyPrefs(m.prefs, m.css); }
    else if (m.type === 'requestExport') { void sendExport(m.target); }
    else if (m.type === 'scrollToLine') {
      if (view.syncScroll && Number.isFinite(m.line)) { scrollToLine(m.line); }
    } else if (m.type === 'scrollToAnchor') { scrollToAnchor(m.anchor); }
    else if (m.type === 'toast') { toast(m.text, m.level); }
  }
  post({ type: 'ready' });
})();
