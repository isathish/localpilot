// LocalPilot Markdown reader. The extension renders Markdown → HTML (VS Code's engine) and posts it here; this
// script lays it out, builds the outline, adds copy buttons to code blocks, draws Mermaid diagrams, keeps the view
// and the source editor scrolled together and routes link clicks back.
(function () {
  const vscode = acquireVsCodeApi();
  const nonce = (document.currentScript && document.currentScript.nonce) || '';
  const $ = (id) => document.getElementById(id);
  const els = { doc: $('doc'), outline: $('outline'), list: $('outline-list'), filter: $('filter'), title: $('title'), subtitle: $('subtitle'), toc: $('toc'), wrap: $('wrap'), copy: $('copy'), save: $('save'), open: $('open'), smaller: $('smaller'), larger: $('larger'), toasts: $('toasts'), prefs: $('prefs'), prefsPop: $('prefs-pop'), sizeVal: $('size-val'), more: $('more'), morePop: $('more-pop'), ask: $('ask'), askSel: $('ask-sel') };
  const post = (m) => vscode.postMessage(m);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = Object.assign({ outline: null, wrap: false }, vscode.getState() || {});
  const save = () => vscode.setState(state);
  let markdown = '';
  let view = { syncScroll: false, isFile: false, outlineDepth: 3, pathRef: '', lineOffset: 0 };
  let generation = 0;
  let canAsk = false;
  let prefs = { fontSize: 15, width: 'normal', font: 'sans', lineHeight: 1.65 };
  /** Settles when the current document's Mermaid diagrams are drawn (an export waits for it). */
  let mermaidDone = Promise.resolve();

  const ICON_COPY = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';

  function toast(text, level) {
    const t = document.createElement('div'); t.className = `toast ${level || 'info'}`; t.textContent = text;
    els.toasts.appendChild(t); setTimeout(() => t.remove(), 2600);
  }
  const copyText = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast('Could not copy', 'error'));
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
      box.innerHTML = `<p class="markdown-alert-title">${ALERTS[kind]}</p>`;
      while (bq.firstChild) { box.appendChild(bq.firstChild); }
      bq.replaceWith(box);
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
    const wantToc = state.outline === null ? items.length >= 4 && window.innerWidth >= 720 : state.outline;
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
      head.innerHTML = `<span class="lang">${esc(lang || 'text')}</span>${view.pathRef && dl !== undefined ? '<button class="cp ref" title="Copy as path:line">path:line</button>' : ''}<button class="cp" title="Copy code">${ICON_COPY}<span>Copy</span></button>`;
      head.querySelector('.cp:not(.ref)').onclick = () => copyText((code || pre).textContent, 'Code');
      const ref = head.querySelector('.ref');
      if (ref) {
        // data-line is the fence line; the code starts on the next one (both 0-based, the reference is 1-based).
        const first = dl + 2 + view.lineOffset;
        const n = Math.max(1, (code || pre).textContent.replace(/\n$/, '').split('\n').length);
        ref.onclick = () => copyText(`${view.pathRef}:${first}${n > 1 ? `-${first + n - 1}` : ''}`, 'Reference');
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

  function setOutline(on, remember) {
    els.outline.classList.toggle('hidden', !on);
    els.toc.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('with-outline', on);
    if (remember) { state.outline = on; save(); }
  }
  function applyFilter() {
    const q = els.filter.value.trim().toLowerCase();
    for (const a of els.list.querySelectorAll('a')) { a.classList.toggle('hidden', !!q && !a.textContent.toLowerCase().includes(q)); }
  }
  els.filter.addEventListener('input', applyFilter);
  els.filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { els.filter.value = ''; applyFilter(); els.doc.focus(); }
    else if (e.key === 'Enter') { const a = els.list.querySelector('a:not(.hidden)'); if (a) { a.click(); } }
  });
  function setWrap(on) {
    state.wrap = on; save();
    document.body.classList.toggle('wrap-code', on);
    els.wrap.setAttribute('aria-pressed', String(on));
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
        if (!e) { e = document.createElement('div'); e.className = 'mermaid-error'; fig.prepend(e); }
        e.textContent = `Mermaid: ${(err && err.message ? err.message : String(err)).split('\n').slice(0, 4).join(' ')}`;
        if (block) { block.hidden = false; }
      }
      fig.hidden = false;
    }
  }
  function figureBar(fig) {
    const bar = document.createElement('div'); bar.className = 'fig-bar';
    bar.innerHTML = '<button data-act="src" title="Copy the Mermaid source">Copy source</button><button data-act="svg" title="Copy the diagram as SVG">Copy SVG</button><button data-act="save" title="Save the diagram as an SVG file">Save SVG…</button>';
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) { return; }
      const svg = () => (fig.querySelector('.mermaid-svg svg') || {}).outerHTML || '';
      if (b.dataset.act === 'src') { copyText(fig.dataset.source || '', 'Source'); }
      else if (b.dataset.act === 'svg') { copyText(svg(), 'SVG'); }
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
    ph.textContent = `Image not found: ${img.alt || name}`;
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
    const first = pop.querySelector('button'); if (first) { first.focus({ preventScroll: true }); }
  }
  const closePops = () => { for (const [b, p] of pops) { if (!p.classList.contains('hidden')) { setPop(b, p, false); } } };
  els.prefs.onclick = () => setPop(els.prefs, els.prefsPop, els.prefsPop.classList.contains('hidden'));
  els.more.onclick = () => setPop(els.more, els.morePop, els.morePop.classList.contains('hidden'));
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.pop, #prefs, #more')) { closePops(); } });
  els.prefsPop.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) { return; }
    if (b.dataset.size) { post({ type: 'fontSize', delta: Number(b.dataset.size) }); return; }
    const key = b.closest('.seg').dataset.key;
    const value = key === 'lineHeight' ? Number(b.dataset.v) : b.dataset.v;
    applyPrefs({ [key]: value }); // pressed state at once; the host saves and applies it to every reader
    post({ type: 'prefs', patch: { [key]: value } });
  });
  els.morePop.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) { return; }
    closePops();
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
  let selTimer = 0;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const s = canAsk && selectionInDoc();
      els.askSel.classList.toggle('hidden', !s);
      if (!s) { return; }
      const r = s.range.getBoundingClientRect();
      els.askSel.style.top = `${Math.max(44, Math.min(window.innerHeight - 34, r.bottom + 6))}px`;
      els.askSel.style.left = `${Math.max(6, Math.min(window.innerWidth - els.askSel.offsetWidth - 6, r.right - els.askSel.offsetWidth))}px`;
    }, 120);
  });
  els.askSel.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  els.askSel.onclick = () => {
    const s = selectionInDoc(); if (!s) { return; }
    const el = s.node.closest('[data-line]') || (s.range.startContainer.parentElement && s.range.startContainer.parentElement.closest('[data-line]'));
    const line = el ? blockLine(el) : undefined;
    post({ type: 'askSelection', text: s.text.slice(0, 20000), line });
    els.askSel.classList.add('hidden');
  };
  els.doc.addEventListener('scroll', () => els.askSel.classList.add('hidden'), { passive: true });

  els.toc.onclick = () => setOutline(els.outline.classList.contains('hidden'), true);
  els.wrap.onclick = () => setWrap(!state.wrap);
  els.copy.onclick = () => post({ type: 'copy' });
  els.save.onclick = () => post({ type: 'saveAs' });
  els.open.onclick = () => post({ type: 'openEditor' });
  els.smaller.onclick = () => post({ type: 'fontSize', delta: -1 });
  els.larger.onclick = () => post({ type: 'fontSize', delta: 1 });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.pop:not(.hidden)')) { closePops(); return; }
    if (e.target.closest('input, textarea')) { return; }
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
      els.ask.classList.toggle('hidden', !canAsk);
      els.title.textContent = m.title || ''; els.subtitle.textContent = `${m.subtitle || ''} · ${words.toLocaleString()} words · ~${Math.max(1, Math.round(words / 220))} min`;
      const open = els.doc.querySelector('details.props');
      els.doc.innerHTML = `${properties(m.frontMatter, m.frontMatterMode)}<article class="md">${scrub(m.html)}</article>`;
      // Keep the Properties table as the reader left it across live reloads.
      const props = els.doc.querySelector('details.props');
      if (props && open) { props.open = open.open; }
      els.save.title = m.isFile ? 'Save a copy as…' : 'Save as…';
      els.open.title = m.isFile ? 'Open in editor' : 'Open as a new Markdown document';
      els.doc.title = m.isFile ? 'Double-click a block to open the source at that line' : '';
      decorate(els.doc.querySelector('article'));
      els.doc.scrollTop = y; // live reload keeps your place
      suppressUntil = Date.now() + 300;
      state.source = m.persist && m.persist.kind === 'file' ? m.persist : undefined;
      save();
      mermaidDone = renderMermaid(gen);
    } else if (m.type === 'prefs') { applyPrefs(m.prefs, m.css); }
    else if (m.type === 'requestExport') { void sendExport(m.target); }
    else if (m.type === 'scrollToLine') {
      if (view.syncScroll && Number.isFinite(m.line)) { scrollToLine(m.line); }
    } else if (m.type === 'scrollToAnchor') { scrollToAnchor(m.anchor); }
    else if (m.type === 'toast') { toast(m.text, m.level); }
  }
  post({ type: 'ready' });
})();
