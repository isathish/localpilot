// LocalPilot PDF viewer. The host posts the PDF bytes (whole, or by range for large files); pdf.js renders them with
// its virtualised PDFViewer, so only visible pages hold canvases. Loaded by the inline module in pdfEditor.ts after
// pdf.mjs and pdf_viewer.mjs, which it reads from globalThis. No document script runs: scripting and XFA are off,
// forms render flat and every link goes through the host.
(function () {
  const vscode = acquireVsCodeApi();
  const { pdfjsLib, pdfjsViewer } = globalThis;
  const cfg = JSON.parse(document.getElementById('pdf-config').textContent || '{}');
  const $ = (id) => document.getElementById(id);
  const els = {
    sidebarToggle: $('sidebarToggle'), prev: $('prev'), next: $('next'), page: $('page'), total: $('total'), zoomOut: $('zoomOut'), zoom: $('zoom'), zoomCustom: $('zoomCustom'), zoomIn: $('zoomIn'), rotate: $('rotate'),
    colors: $('colors'), findToggle: $('findToggle'), ask: $('ask'), more: $('more'), findbar: $('findbar'), findInput: $('findInput'), findPrev: $('findPrev'), findNext: $('findNext'), findCase: $('findCase'),
    findWord: $('findWord'), findAll: $('findAll'), findCount: $('findCount'), findClose: $('findClose'), progress: $('progress'), sidebar: $('sidebar'), tabOutline: $('tabOutline'), tabThumbs: $('tabThumbs'),
    outlineView: $('outlineView'), thumbsView: $('thumbsView'), container: $('viewerContainer'), viewer: $('viewer'), panel: $('panel'), askSel: $('askSel'), menu: $('menu'), toasts: $('toasts'),
  };
  const post = (m) => vscode.postMessage(m);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = Object.assign({ page: 1, scale: undefined, rotation: 0, sidebar: undefined }, vscode.getState() || {});
  const saveState = () => vscode.setState(state);
  window.addEventListener('error', (e) => post({ type: 'clientError', where: 'window', message: String(e.message), stack: e.error && e.error.stack }));
  window.addEventListener('unhandledrejection', (e) => post({ type: 'clientError', where: 'promise', message: String((e.reason && e.reason.message) || e.reason), stack: e.reason && e.reason.stack }));

  // Same as pdfLoadOptions in src/pdf/options.ts (a test checks the two blocks agree).
  function pdfLoadOptions(urls, init) {
    // pdf-load-options:begin
    return {
      ...init,
      cMapUrl: urls.cmaps,
      cMapPacked: true,
      standardFontDataUrl: urls.standardFonts,
      wasmUrl: urls.wasm,
      iccUrl: urls.iccs,
      useWorkerFetch: false,
      enableXfa: false,
      isOffscreenCanvasSupported: true,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: false,
      maxImageSize: 64 * 1024 * 1024,
      canvasMaxAreaInBytes: 256 * 1024 * 1024,
    };
    // pdf-load-options:end
  }

  function toast(text, level) {
    const t = document.createElement('div'); t.className = `toast ${level || 'info'}`; t.textContent = text;
    els.toasts.appendChild(t); setTimeout(() => t.remove(), 2800);
  }
  const fmtMB = (b) => { const mb = b / 1048576; return mb < 1 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`; };

  // ------------------------------------------------------------------ worker
  // Webviews cannot start a Worker from a resource URL, so the packaged worker runs from a blob (it has no imports).
  let worker;
  let workerUrl;
  let everLoaded = false;
  async function ensureWorker() {
    if (worker) { return; }
    if (!workerUrl) {
      const src = await (await fetch(cfg.worker)).blob();
      workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    const w = new Worker(workerUrl, { type: 'module' });
    worker = w;
    w.addEventListener('error', (e) => {
      post({ type: 'clientError', where: 'worker', message: String(e.message || 'worker error') });
      if (!everLoaded && pdfjsLib.GlobalWorkerOptions.workerPort === w) {
        // The worker never started: let pdf.js pick (it retries, then runs on the main thread where that is allowed).
        pdfjsLib.GlobalWorkerOptions.workerPort = null;
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        worker = 'pdfjs';
        reload();
        return;
      }
      showPanel('The PDF renderer stopped.', [{ label: 'Reload', run: () => restartWorker() }]);
    });
    pdfjsLib.GlobalWorkerOptions.workerPort = w;
  }
  function restartWorker() {
    try { worker && worker.terminate && worker.terminate(); } catch { /* gone */ }
    worker = undefined; pdfjsLib.GlobalWorkerOptions.workerPort = null;
    reload();
  }

  // ------------------------------------------------------------------ viewer
  const { AnnotationMode, AnnotationEditorType, PasswordResponses } = pdfjsLib;
  const eventBus = new pdfjsViewer.EventBus();
  const linkService = new pdfjsViewer.PDFLinkService({ eventBus, externalLinkTarget: pdfjsViewer.LinkTarget.NONE });
  const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
  const viewer = new pdfjsViewer.PDFViewer({
    container: els.container, viewer: els.viewer, eventBus, linkService, findController,
    annotationMode: AnnotationMode.ENABLE, annotationEditorMode: AnnotationEditorType.DISABLE, textLayerMode: 1, removePageBorders: false, maxCanvasPixels: 16777216,
    imageResourcesPath: cfg.images, pageColors: null,
  });
  linkService.setViewer(viewer);

  let pdfDoc = null;
  let loadingTask = null;
  let generation = 0;
  let prefs = { pageColors: 'auto', sidebar: 'auto', defaultZoom: 'auto' };
  let fileName = 'document.pdf';
  let fileSize = 0;
  /** Where to land once pages exist: the link's page or the saved position (first open), else what was on screen. */
  let landing = null;
  let reloading = false;

  // ------------------------------------------------------------------ range transport
  const MAX_RANGE = 4 * 1024 * 1024;
  const MAX_INFLIGHT = 8;
  let rangeSeq = 0;
  const inflight = new Map();
  const queue = [];
  function pump() {
    while (inflight.size < MAX_INFLIGHT && queue.length) {
      const r = queue.shift();
      if (r.gen !== generation) { continue; }
      inflight.set(r.id, r);
      post({ type: 'range', id: r.id, begin: r.begin, end: r.end });
    }
  }
  // pdf.js matches each reply to its request by `begin` and completes the request on the first reply, so a split
  // request must come back as one onDataRange(begin, bytes) with the original begin. Tested in pdfViewer.test.ts.
  // pdf-range-split:begin
  function splitRange(begin, end, max, deliver) {
    const parts = [];
    for (let b = begin; b < end; b += max) { parts.push({ begin: b, end: Math.min(end, b + max), done: false }); }
    if (parts.length === 1) { return { parts, fill: (part, data) => { if (!part.done) { part.done = true; deliver(begin, data); } } }; }
    const buffer = new Uint8Array(end - begin);
    let left = parts.length;
    return {
      parts,
      fill(part, data) {
        if (part.done) { return; }
        part.done = true;
        buffer.set(data.subarray(0, part.end - part.begin), part.begin - begin);
        if (--left === 0) { deliver(begin, buffer); }
      },
    };
  }
  // pdf-range-split:end
  class HostRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    requestDataRange(begin, end) {
      // Larger requests are split on 4 MB boundaries, a multiple of the 256 KB chunk size pdf.js aligns to.
      const split = splitRange(begin, end, MAX_RANGE, (b, data) => this.onDataRange(b, data));
      for (const part of split.parts) {
        queue.push({ id: ++rangeSeq, gen: generation, split, part, begin: part.begin, end: part.end, tries: 0 });
      }
      pump();
    }
  }
  function rangeFailed(r, message) {
    if (r.tries < 1) {
      // One retry, a moment later: the host may be refusing because an earlier generation's reads are still pending.
      setTimeout(() => { if (r.gen === generation) { queue.push({ ...r, id: ++rangeSeq, tries: r.tries + 1 }); pump(); } }, 400);
      return;
    }
    setProgress(null);
    showPanel(`Could not read part of ${esc(fileName)}: ${esc(message)}`, [{ label: 'Reload', primary: true, run: () => reload() }, systemViewer]);
  }

  // ------------------------------------------------------------------ loading
  function showPanel(html, actions) {
    els.panel.innerHTML = `<div class="msg">${html}</div><div class="actions"></div>`;
    const row = els.panel.querySelector('.actions');
    for (const a of actions || []) {
      const b = document.createElement('button'); b.className = a.primary ? 'btn primary' : 'btn'; b.textContent = a.label;
      b.addEventListener('click', a.run); row.appendChild(b);
    }
    els.panel.classList.remove('hidden');
    const first = row.querySelector('button'); if (first) { first.focus(); }
  }
  const hidePanel = () => { els.panel.classList.add('hidden'); els.panel.innerHTML = ''; };
  const systemViewer = { label: 'Open with system viewer', run: () => post({ type: 'openExternal' }) };

  function setProgress(fraction) {
    if (fraction === null || fraction >= 1) { els.progress.classList.add('hidden'); return; }
    els.progress.classList.remove('hidden');
    els.progress.firstElementChild.style.width = `${Math.max(3, Math.round(fraction * 100))}%`;
  }

  function reload() {
    reloading = true;
    landing = { page: viewer.currentPageNumber || state.page, scale: viewer.currentScaleValue || state.scale, rotation: viewer.pagesRotation || 0 };
    post({ type: 'ready' });
  }

  async function closeDocument() {
    generation++;
    queue.length = 0; inflight.clear();
    const task = loadingTask; loadingTask = null;
    if (pdfDoc) { viewer.setDocument(null); linkService.setDocument(null); pdfDoc = null; }
    // A task whose worker never started never finishes destroying; do not wait on it forever.
    if (task) { await Promise.race([task.destroy().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]); }
    clearThumbs();
  }

  async function open(m) {
    await closeDocument();
    const gen = generation;
    hidePanel();
    fileName = m.name; fileSize = m.size;
    document.title = m.name;
    applyPrefs(m.prefs);
    if (!reloading) {
      landing = { page: m.page || state.page || 1, scale: state.scale || m.scale || prefs.defaultZoom, rotation: state.rotation || 0 };
    }
    reloading = false;
    try { await ensureWorker(); } catch (e) {
      showPanel(`Could not start the PDF renderer: ${esc(e && e.message)}`, [{ label: 'Reload', run: () => restartWorker() }, systemViewer]);
      return;
    }
    const urls = { cmaps: cfg.cmaps, standardFonts: cfg.standardFonts, wasm: cfg.wasm, iccs: cfg.iccs };
    const init = m.mode === 'range'
      ? { range: new HostRangeTransport(m.length, m.initial), rangeChunkSize: 262144 }
      : { data: m.data };
    loadingTask = pdfjsLib.getDocument(pdfLoadOptions(urls, init));
    const task = loadingTask;
    task.onProgress = ({ loaded, total }) => { if (gen === generation) { setProgress(total ? loaded / total : null); } };
    task.onPassword = (update, reason) => askPassword(update, reason === PasswordResponses.INCORRECT_PASSWORD);
    setProgress(0.02);
    try {
      const doc = await task.promise;
      if (gen !== generation) { return; }
      pdfDoc = doc;
      everLoaded = true;
      setProgress(null);
      viewer.setDocument(doc);
      linkService.setDocument(doc, null);
      els.total.textContent = `/ ${doc.numPages}`;
      els.page.max = String(doc.numPages);
      void buildOutline(doc, gen);
      buildThumbs(doc);
    } catch (e) {
      if (gen !== generation) { return; }
      setProgress(null);
      const name = (e && e.name) || '';
      if (name === 'PasswordException') {
        showPanel('This PDF is password-protected.', [{ label: 'Enter password', primary: true, run: () => reload() }, systemViewer]);
      } else if (name === 'InvalidPDFException') {
        showPanel(`<b>Not a valid PDF.</b><br><span class="muted">${esc(fileName)} could not be read; it may be damaged or not a PDF at all.</span>`, [systemViewer]);
      } else {
        showPanel(`Could not open ${esc(fileName)}: ${esc((e && e.message) || e)}`, [{ label: 'Reload', primary: true, run: () => reload() }, systemViewer]);
      }
    }
  }

  // The password stays in this webview: it goes to pdf.js and nowhere else, and is never stored.
  function askPassword(update, wrong) {
    els.panel.innerHTML = `<div class="msg"><b>${esc(fileName)}</b> is password-protected.${wrong ? '<div class="err">Incorrect password, try again.</div>' : ''}</div>
<form class="pw"><input type="password" autocomplete="off" placeholder="Password" aria-label="Password" /><button class="btn primary" type="submit">Open</button><button class="btn" type="button" data-cancel>Cancel</button></form>`;
    els.panel.classList.remove('hidden');
    const form = els.panel.querySelector('form');
    const input = form.querySelector('input');
    input.focus();
    form.addEventListener('submit', (e) => { e.preventDefault(); const pw = input.value; hidePanel(); update(pw); });
    form.querySelector('[data-cancel]').addEventListener('click', () => {
      showPanel('This PDF is password-protected.', [{ label: 'Enter password', primary: true, run: () => askPassword(update, false) }, systemViewer]);
    });
  }

  // Preset zooms (Auto, Page width, Page fit) follow the view when the editor or the sidebar changes size.
  let fitTimer;
  new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      const v = viewer.currentScaleValue;
      if (pdfDoc && /^(auto|page-width|page-fit)$/.test(v)) { viewer.currentScaleValue = v; }
    }, 100);
  }).observe(els.container);
  eventBus.on('pagesinit', () => {
    const l = landing || { page: 1, scale: prefs.defaultZoom, rotation: 0 };
    viewer.pagesRotation = l.rotation || 0;
    viewer.currentScaleValue = String(l.scale || prefs.defaultZoom);
    if (l.page && l.page <= viewer.pagesCount) { viewer.currentPageNumber = l.page; }
    landing = null;
    syncSidebar();
  });
  eventBus.on('pagechanging', ({ pageNumber }) => {
    els.page.value = String(pageNumber);
    els.prev.disabled = pageNumber <= 1;
    els.next.disabled = pageNumber >= viewer.pagesCount;
    state.page = pageNumber; saveState(); notePosition();
    highlightOutline(pageNumber);
    markThumb(pageNumber);
  });
  eventBus.on('scalechanging', ({ scale, presetValue }) => {
    const v = presetValue || String(scale);
    const match = [...els.zoom.options].find((o) => o.value === v && o !== els.zoomCustom);
    if (match) { els.zoom.value = v; els.zoomCustom.hidden = true; } else {
      els.zoomCustom.textContent = `${Math.round(scale * 100)}%`; els.zoomCustom.hidden = false; els.zoom.value = 'custom';
    }
    state.scale = presetValue || scale; saveState(); notePosition();
  });
  eventBus.on('rotationchanging', ({ pagesRotation }) => { state.rotation = pagesRotation; saveState(); });
  let posTimer;
  function notePosition() {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => { if (pdfDoc && state.page) { post({ type: 'position', page: state.page, scale: state.scale || 'auto' }); } }, 1000);
  }

  // ------------------------------------------------------------------ links
  // External links never navigate the webview: http(s) and mailto go through the host, anything else is dropped.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) { return; }
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) { return; }
    e.preventDefault(); e.stopPropagation();
    if (/^(https?:|mailto:)/i.test(href)) { post({ type: 'openLink', href }); } else { toast('Link blocked: only web and mail links open from a PDF', 'error'); }
  }, true);
  linkService.executeNamedAction = function (action) {
    if (action === 'NextPage') { viewer.nextPage(); } else if (action === 'PrevPage') { viewer.previousPage(); } else if (action === 'FirstPage') { viewer.currentPageNumber = 1; } else if (action === 'LastPage') { viewer.currentPageNumber = viewer.pagesCount; }
  };

  // ------------------------------------------------------------------ toolbar
  els.prev.addEventListener('click', () => viewer.previousPage());
  els.next.addEventListener('click', () => viewer.nextPage());
  els.page.addEventListener('change', () => {
    const n = Math.max(1, Math.min(viewer.pagesCount || 1, Math.floor(Number(els.page.value)) || 1));
    viewer.currentPageNumber = n; els.page.value = String(n);
  });
  els.page.addEventListener('keydown', (e) => { if (e.key === 'Enter') { els.page.dispatchEvent(new Event('change')); els.container.focus(); } });
  els.zoom.addEventListener('change', () => { if (els.zoom.value !== 'custom') { viewer.currentScaleValue = els.zoom.value; } });
  els.zoomIn.addEventListener('click', () => viewer.increaseScale());
  els.zoomOut.addEventListener('click', () => viewer.decreaseScale());
  els.rotate.addEventListener('click', () => { viewer.pagesRotation = (viewer.pagesRotation + 90) % 360; });
  els.ask.addEventListener('click', () => post({ type: 'ask' }));
  els.sidebarToggle.addEventListener('click', () => {
    const show = els.sidebar.classList.contains('hidden');
    state.sidebar = show ? (state.sidebarTab || defaultTab()) : 'hidden'; saveState();
    syncSidebar();
  });
  els.tabOutline.addEventListener('click', () => { state.sidebar = state.sidebarTab = 'outline'; saveState(); syncSidebar(); });
  els.tabThumbs.addEventListener('click', () => { state.sidebar = state.sidebarTab = 'thumbnails'; saveState(); syncSidebar(); });
  els.container.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !pdfDoc) { return; }
    e.preventDefault();
    viewer.updateScale({ drawingDelay: 200, scaleFactor: e.deltaY < 0 ? 1.1 : 1 / 1.1 });
  }, { passive: false });

  // ------------------------------------------------------------------ menus
  function openMenu(anchor, items) {
    const m = els.menu;
    m.innerHTML = '';
    for (const it of items) {
      if (it === '-') { const hr = document.createElement('div'); hr.className = 'menu-sep'; m.appendChild(hr); continue; }
      const b = document.createElement('button'); b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span class="check">${it.checked ? '✓' : ''}</span><span>${esc(it.label)}</span>`;
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      m.appendChild(b);
    }
    m.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    m.style.top = `${r.bottom + 4}px`;
    m.style.left = `${Math.max(6, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 6))}px`;
    const first = m.querySelector('button:not(:disabled)'); if (first) { first.focus(); }
  }
  const closeMenu = () => els.menu.classList.add('hidden');
  document.addEventListener('mousedown', (e) => { if (!els.menu.contains(e.target) && e.target !== els.more && e.target !== els.colors) { closeMenu(); } });
  const setColors = (v) => { applyPrefs({ ...prefs, pageColors: v }); post({ type: 'prefs', patch: { pageColors: v } }); };
  els.colors.addEventListener('click', () => openMenu(els.colors, [
    { label: 'Auto (follow theme)', checked: prefs.pageColors === 'auto', run: () => setColors('auto') },
    { label: 'Original', checked: prefs.pageColors === 'original', run: () => setColors('original') },
    { label: 'Dark', checked: prefs.pageColors === 'dark', run: () => setColors('dark') },
    { label: 'Sepia', checked: prefs.pageColors === 'sepia', run: () => setColors('sepia') },
  ]));
  els.more.addEventListener('click', () => {
    const tinted = effectiveColors() === 'dark' || effectiveColors() === 'sepia';
    openMenu(els.more, [
      { label: 'Attach page as image', disabled: !pdfDoc, run: () => void attachPageImage() },
      { label: 'Copy page text', disabled: !pdfDoc, run: () => void copyPageText() },
      ...(tinted ? [{ label: 'Show original colours', run: () => setColors('original') }] : []),
      '-',
      { label: 'Document properties', disabled: !pdfDoc, run: () => void showProperties() },
      { label: 'Open with system viewer', run: () => post({ type: 'openExternal' }) },
      { label: 'Reveal in file manager', run: () => post({ type: 'reveal' }) },
    ]);
  });

  // ------------------------------------------------------------------ find
  function openFind() {
    els.findbar.classList.remove('hidden'); els.findToggle.setAttribute('aria-pressed', 'true');
    const sel = String(window.getSelection() || '').trim();
    if (sel && sel.length < 200 && !sel.includes('\n')) { els.findInput.value = sel; find(''); }
    els.findInput.focus(); els.findInput.select();
  }
  function closeFind() {
    els.findbar.classList.add('hidden'); els.findToggle.setAttribute('aria-pressed', 'false'); els.findCount.textContent = '';
    eventBus.dispatch('findbarclose', { source: null });
    els.container.focus();
  }
  function find(type, previous) {
    eventBus.dispatch('find', {
      source: null, type, query: els.findInput.value, caseSensitive: els.findCase.checked, entireWord: els.findWord.checked,
      highlightAll: els.findAll.checked, findPrevious: !!previous, matchDiacritics: false,
    });
  }
  els.findToggle.addEventListener('click', () => (els.findbar.classList.contains('hidden') ? openFind() : closeFind()));
  els.findClose.addEventListener('click', closeFind);
  els.findInput.addEventListener('input', () => find(''));
  els.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); find('again', e.shiftKey); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  els.findNext.addEventListener('click', () => find('again', false));
  els.findPrev.addEventListener('click', () => find('again', true));
  els.findCase.addEventListener('change', () => find('casesensitivitychange'));
  els.findWord.addEventListener('change', () => find('entirewordchange'));
  els.findAll.addEventListener('change', () => find('highlightallchange'));
  const showCount = ({ matchesCount }) => {
    const { current, total } = matchesCount || {};
    els.findCount.textContent = !els.findInput.value ? '' : total ? `${current} of ${total}${total >= 1000 ? '+' : ''}` : 'No matches';
  };
  eventBus.on('updatefindmatchescount', showCount);
  eventBus.on('updatefindcontrolstate', showCount);

  // ------------------------------------------------------------------ keys
  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); els.page.focus(); els.page.select(); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); viewer.increaseScale(); return; }
    if (mod && e.key === '-') { e.preventDefault(); viewer.decreaseScale(); return; }
    if (mod && e.key === '0') { e.preventDefault(); viewer.currentScaleValue = 'auto'; return; }
    if (e.key === 'Escape') { if (!els.menu.classList.contains('hidden')) { closeMenu(); } else if (!els.findbar.classList.contains('hidden')) { closeFind(); } return; }
    if (mod || e.altKey || typing(e.target) || !pdfDoc) { return; }
    switch (e.key) {
      case 'n': case 'j': case 'PageDown': if (e.key !== 'PageDown' || isFitPage()) { e.preventDefault(); viewer.nextPage(); } break;
      case 'p': case 'k': case 'PageUp': if (e.key !== 'PageUp' || isFitPage()) { e.preventDefault(); viewer.previousPage(); } break;
      case 'Home': e.preventDefault(); viewer.currentPageNumber = 1; break;
      case 'End': e.preventDefault(); viewer.currentPageNumber = viewer.pagesCount; break;
      case 'r': viewer.pagesRotation = (viewer.pagesRotation + 90) % 360; break;
      case 'R': viewer.pagesRotation = (viewer.pagesRotation + 270) % 360; break;
    }
  });
  // PageUp/PageDown scroll by a screen; with a whole page on screen that is one page anyway, so turn it exactly.
  const isFitPage = () => viewer.currentScaleValue === 'page-fit';

  // ------------------------------------------------------------------ page colours
  function effectiveColors() {
    const c = document.body.classList;
    if (prefs.pageColors !== 'auto') { return prefs.pageColors; }
    if (c.contains('vscode-high-contrast') || c.contains('vscode-high-contrast-light')) { return 'hc'; }
    return c.contains('vscode-dark') ? 'dark' : 'original';
  }
  let appliedHc = false;
  function applyColors() {
    const eff = effectiveColors();
    document.body.classList.toggle('pc-dark', eff === 'dark');
    document.body.classList.toggle('pc-sepia', eff === 'sepia');
    const hc = eff === 'hc';
    if (hc === appliedHc) { return; }
    appliedHc = hc;
    // High contrast is drawn by pdf.js itself (exact, but it needs a fresh render of every page).
    const css = getComputedStyle(document.body);
    viewer.pageColors = hc ? { background: css.getPropertyValue('--vscode-editor-background').trim() || 'Canvas', foreground: css.getPropertyValue('--vscode-editor-foreground').trim() || 'CanvasText' } : null;
    if (pdfDoc) {
      landing = { page: viewer.currentPageNumber, scale: viewer.currentScaleValue, rotation: viewer.pagesRotation };
      const doc = pdfDoc;
      viewer.setDocument(null); viewer.setDocument(doc);
    }
  }
  new MutationObserver(applyColors).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  function applyPrefs(p) {
    if (!p) { return; }
    prefs = { ...prefs, ...p };
    applyColors();
    syncSidebar();
  }

  // ------------------------------------------------------------------ sidebar: outline and thumbnails
  let outlineItems = [];
  let hasOutline = false;
  const defaultTab = () => (hasOutline ? 'outline' : 'thumbnails');
  function syncSidebar() {
    let mode = state.sidebar || prefs.sidebar;
    if (mode === 'auto') { mode = window.innerWidth < 640 || !pdfDoc ? 'hidden' : defaultTab(); }
    const show = mode !== 'hidden' && !!pdfDoc;
    els.sidebar.classList.toggle('hidden', !show);
    els.sidebarToggle.setAttribute('aria-pressed', String(show));
    if (!show) { return; }
    const outline = mode === 'outline' && hasOutline;
    els.outlineView.classList.toggle('hidden', !outline);
    els.thumbsView.classList.toggle('hidden', outline);
    els.tabOutline.disabled = !hasOutline;
    els.tabOutline.setAttribute('aria-selected', String(outline));
    els.tabThumbs.setAttribute('aria-selected', String(!outline));
    if (!outline) { observeThumbs(); }
  }
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(syncSidebar, 120); });

  async function destPage(doc, dest) {
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) { return undefined; }
      const ref = explicit[0];
      return (typeof ref === 'object' && ref ? await doc.getPageIndex(ref) : Number(ref)) + 1;
    } catch { return undefined; }
  }
  async function buildOutline(doc, gen) {
    els.outlineView.innerHTML = ''; outlineItems = []; hasOutline = false;
    const outline = await doc.getOutline().catch(() => null);
    if (gen !== generation || !outline || !outline.length) { syncSidebar(); return; }
    hasOutline = true;
    const render = (items, depth, parent) => {
      for (const it of items) {
        const row = document.createElement('a'); row.className = `oi d${Math.min(depth, 4)}`; row.textContent = it.title || '(untitled)'; row.title = it.title || ''; row.setAttribute('role', 'treeitem'); row.tabIndex = 0;
        if (it.bold) { row.classList.add('b'); } if (it.italic) { row.classList.add('i'); }
        const go = () => {
          if (it.dest) { void linkService.goToDestination(it.dest); } else if (it.url && /^(https?:|mailto:)/i.test(it.url)) { post({ type: 'openLink', href: it.url }); }
        };
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { go(); } });
        parent.appendChild(row);
        const entry = { el: row, page: undefined };
        outlineItems.push(entry);
        if (it.dest) { void destPage(doc, it.dest).then((p) => { entry.page = p; }); }
        if (it.items && it.items.length && depth < 6) { render(it.items, depth + 1, parent); }
      }
    };
    render(outline, 1, els.outlineView);
    syncSidebar();
  }
  function highlightOutline(page) {
    let best = null;
    for (const it of outlineItems) { if (it.page !== undefined && it.page <= page && (!best || it.page >= best.page)) { best = it; } }
    for (const it of outlineItems) { it.el.classList.toggle('on', it === best); }
  }

  // Thumbnails render lazily at 120 px into a canvas that becomes a blob image; at most 60 are kept (LRU).
  const THUMB_W = 120;
  const MAX_THUMBS = 60;
  const thumbUrls = new Map();
  let thumbObserver = null;
  function clearThumbs() {
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    for (const url of thumbUrls.values()) { URL.revokeObjectURL(url); }
    thumbUrls.clear(); els.thumbsView.innerHTML = '';
  }
  function buildThumbs(doc) {
    clearThumbs();
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= doc.numPages; n++) {
      const t = document.createElement('button'); t.className = 'thumb'; t.dataset.page = String(n); t.title = `Page ${n}`;
      t.innerHTML = `<span class="img"></span><span class="n">${n}</span>`;
      t.addEventListener('click', () => { viewer.currentPageNumber = n; });
      frag.appendChild(t);
    }
    els.thumbsView.appendChild(frag);
  }
  function observeThumbs() {
    if (thumbObserver || !pdfDoc) { return; }
    const gen = generation;
    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) { void renderThumb(e.target, gen); } }
    }, { root: els.thumbsView, rootMargin: '200px 0px' });
    els.thumbsView.querySelectorAll('.thumb').forEach((t) => thumbObserver.observe(t));
    // The first screenful does not wait for the observer's first callback.
    setTimeout(() => {
      const box = els.thumbsView.getBoundingClientRect();
      for (const t of els.thumbsView.children) {
        const r = t.getBoundingClientRect();
        if (r.top > box.bottom + 200) { break; }
        if (r.bottom >= box.top) { void renderThumb(t, gen); }
      }
    }, 50);
  }
  async function renderThumb(el, gen) {
    const n = Number(el.dataset.page);
    if (thumbUrls.has(n) || el.dataset.busy || !pdfDoc) {
      if (thumbUrls.has(n)) { const u = thumbUrls.get(n); thumbUrls.delete(n); thumbUrls.set(n, u); }
      return;
    }
    el.dataset.busy = '1';
    try {
      const page = await pdfDoc.getPage(n);
      const vp1 = page.getViewport({ scale: 1, rotation: viewer.pagesRotation });
      const vp = page.getViewport({ scale: THUMB_W / vp1.width, rotation: viewer.pagesRotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, viewport: vp, annotationMode: AnnotationMode.ENABLE }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      canvas.width = canvas.height = 0;
      if (!blob || gen !== generation) { return; }
      const url = URL.createObjectURL(blob);
      thumbUrls.set(n, url);
      el.querySelector('.img').innerHTML = `<img src="${url}" alt="Page ${n}" />`;
      while (thumbUrls.size > MAX_THUMBS) {
        const [old, oldUrl] = thumbUrls.entries().next().value;
        thumbUrls.delete(old); URL.revokeObjectURL(oldUrl);
        const oldEl = els.thumbsView.querySelector(`.thumb[data-page="${old}"] .img`);
        if (oldEl) { oldEl.innerHTML = ''; }
      }
    } catch { /* a page that fails to render keeps its placeholder */ } finally { delete el.dataset.busy; }
  }
  function markThumb(n) {
    const prev = els.thumbsView.querySelector('.thumb.on'); if (prev) { prev.classList.remove('on'); }
    const cur = els.thumbsView.querySelector(`.thumb[data-page="${n}"]`);
    if (cur) { cur.classList.add('on'); if (!els.thumbsView.classList.contains('hidden')) { cur.scrollIntoView({ block: 'nearest' }); } }
  }

  // ------------------------------------------------------------------ page actions
  const MAX_IMAGE = 12 * 1024 * 1024;
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  /** The page as a PNG on white: at most 2000 px wide, 2x at most, scaled down further to stay under 12 MB. */
  async function renderPagePng(n) {
    const page = await pdfDoc.getPage(n);
    const base = page.getViewport({ scale: 1, rotation: viewer.pagesRotation });
    let scale = Math.min(2, 2000 / base.width);
    for (let attempt = 0; attempt < 3; attempt++) {
      const vp = page.getViewport({ scale, rotation: viewer.pagesRotation });
      const canvas = new OffscreenCanvas(Math.max(1, Math.floor(vp.width)), Math.max(1, Math.floor(vp.height)));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      // The print intent renders without animation frames, so it also completes while the view is in the background.
      await page.render({ canvas: null, canvasContext: ctx, viewport: vp, intent: 'print', annotationMode: AnnotationMode.ENABLE }).promise;
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      if (blob.size <= MAX_IMAGE) { return blob; }
      scale *= Math.sqrt(MAX_IMAGE / blob.size) * 0.9;
    }
    return undefined;
  }
  async function attachPageImage() {
    if (!pdfDoc) { return; }
    const n = viewer.currentPageNumber;
    try {
      const blob = await renderPagePng(n);
      if (!blob) { toast('This page is too large to attach as an image', 'error'); return; }
      const stem = fileName.replace(/\.pdf$/i, '');
      post({ type: 'attachImage', name: `${stem}-p${n}.png`, data: await blobToBase64(blob), mime: 'image/png' });
    } catch (e) {
      toast(`Could not render page ${n}: ${(e && e.message) || e}`, 'error');
    }
  }
  async function pageText(n) {
    const page = await pdfDoc.getPage(n);
    const tc = await page.getTextContent();
    return tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('').replace(/\n{3,}/g, '\n\n').trim();
  }
  async function copyPageText() {
    if (!pdfDoc) { return; }
    try { post({ type: 'copyText', text: await pageText(viewer.currentPageNumber) }); } catch (e) { toast(`Could not read the page text: ${(e && e.message) || e}`, 'error'); }
  }
  async function showProperties() {
    if (!pdfDoc) { return; }
    const { info } = await pdfDoc.getMetadata().catch(() => ({ info: {} }));
    const page = await pdfDoc.getPage(viewer.currentPageNumber);
    const [, , w, h] = page.view;
    const date = (s) => { const d = s && pdfjsLib.PDFDateString.toDateObject(s); return d ? d.toLocaleString() : ''; };
    const rows = [
      ['File', fileName], ['Size', fmtMB(fileSize)], ['Pages', String(pdfDoc.numPages)], ['Title', info.Title], ['Author', info.Author], ['Subject', info.Subject],
      ['Keywords', info.Keywords], ['Created', date(info.CreationDate)], ['Modified', date(info.ModDate)], ['Creator', info.Creator], ['Producer', info.Producer],
      ['PDF version', info.PDFFormatVersion], ['Page size', `${Math.round((w / 72) * 25.4)} × ${Math.round((h / 72) * 25.4)} mm`], ['Fast web view', info.IsLinearized ? 'Yes' : 'No'],
    ].filter(([, v]) => v);
    showPanel(`<b>Document properties</b><table class="props">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`, [{ label: 'Close', run: hidePanel }]);
  }

  // Ask about selection: a floating button next to a text-layer selection.
  let selTimer;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim() : '';
      const node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
      const pageEl = node && node.closest ? node.closest('.page') : null;
      if (!text || !pageEl || !node.closest('.textLayer')) { els.askSel.classList.add('hidden'); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      els.askSel.dataset.page = pageEl.dataset.pageNumber || String(viewer.currentPageNumber);
      els.askSel.style.top = `${Math.max(44, r.top - 34)}px`;
      els.askSel.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - 170))}px`;
      els.askSel.classList.remove('hidden');
    }, 150);
  });
  els.askSel.addEventListener('mousedown', (e) => e.preventDefault());
  els.askSel.addEventListener('click', () => {
    const text = String(window.getSelection() || '').trim().slice(0, 4000);
    if (text) { post({ type: 'askSelection', text, page: Number(els.askSel.dataset.page) || viewer.currentPageNumber }); }
    els.askSel.classList.add('hidden');
  });

  // ------------------------------------------------------------------ host messages
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') { return; }
    switch (m.type) {
      case 'open': void open(m); break;
      case 'rangeData': {
        const r = inflight.get(m.id); inflight.delete(m.id);
        if (r && r.gen === generation) { r.split.fill(r.part, m.data); }
        pump();
        break;
      }
      case 'rangeError': {
        const r = inflight.get(m.id); inflight.delete(m.id);
        if (r && r.gen === generation) { rangeFailed(r, m.message); }
        pump();
        break;
      }
      case 'reload': reload(); break;
      case 'goToPage': if (pdfDoc && m.page >= 1) { viewer.currentPageNumber = Math.min(m.page, viewer.pagesCount); } break;
      case 'prefs': applyPrefs(m.prefs); break;
      case 'toast': toast(m.text, m.level); break;
      case 'attachPageImage': void attachPageImage(); break;
      case 'tooLarge':
        showPanel(`<b>This PDF is ${esc(fmtMB(m.size))}.</b><br><span class="muted">That is over the ${esc(fmtMB(m.max))} limit of <code>localpilot.pdfViewer.maxFileSizeMB</code>. It can still open page by page.</span>`, [
          { label: 'Open anyway (range mode)', primary: true, run: () => { hidePanel(); post({ type: 'openAnyway' }); } }, systemViewer,
        ]);
        break;
    }
  });
  applyColors();
  post({ type: 'ready' });
})();
