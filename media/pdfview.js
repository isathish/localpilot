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
    loading: $('loading'), loadingText: $('loadingText'), zoomDefault: $('zoomDefault'), askLive: $('askLive'),
  };
  // Older markup (and the preview harness) may lack these; both are created here then.
  if (!els.zoomDefault) { els.zoomDefault = new Option('Default (Auto)', 'default'); els.zoomDefault.id = 'zoomDefault'; els.zoom.prepend(els.zoomDefault); }
  if (!els.askLive) { els.askLive = document.createElement('div'); els.askLive.id = 'askLive'; els.askLive.className = 'sr-only'; els.askLive.setAttribute('aria-live', 'polite'); document.body.appendChild(els.askLive); }
  // Relationships the template declares; set here too so the preview harness (its own copy of the markup) gets them.
  els.panel.setAttribute('aria-labelledby', 'panelTitle');
  for (const [tab, view] of [[els.tabOutline, els.outlineView], [els.tabThumbs, els.thumbsView]]) {
    tab.setAttribute('aria-controls', view.id); view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-labelledby', tab.id);
  }
  for (const b of [els.colors, els.more]) { b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'menu'); }
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const ASK_KEY = isMac ? "⌘'" : "Ctrl+'";
  /** Characters of a selection quoted into the chat (the host's MAX_QUOTE). */
  const maxQuote = Number(cfg.maxQuote) || Infinity;
  const ZOOM_LABELS = { auto: 'Auto', 'page-width': 'Page width', 'page-fit': 'Page fit', 'page-actual': 'Actual size' };
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
  /** The pending reload came from the file changing on disk (not a retry), so the user is told why the view refreshed. */
  let diskReload = false;
  let reloadToastAt = 0;

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
  // Until the first page renders the toolbar has nothing to act on, so it is disabled and the view says what it is opening.
  const busyControls = () => [els.prev, els.next, els.page, els.zoomOut, els.zoom, els.zoomIn, els.findToggle, els.rotate];
  let loadingTimer;
  function showLoading(name, size, range) {
    clearTimeout(loadingTimer);
    els.loadingText.textContent = `Opening ${name}… (${fmtMB(size)})`;
    els.loading.hidden = false;
    els.container.setAttribute('aria-busy', 'true');
    for (const c of busyControls()) { c.disabled = true; }
    // Range mode fetches pages as they come into view; a slow first page is expected, so say so.
    if (range) { loadingTimer = setTimeout(() => { if (!els.loading.hidden) { els.loadingText.textContent = 'Loading pages on demand…'; } }, 3000); }
  }
  function hideLoading() {
    clearTimeout(loadingTimer);
    if (els.loading.hidden) { return; }
    els.loading.hidden = true;
    els.container.removeAttribute('aria-busy');
    for (const c of busyControls()) { c.disabled = false; }
    if (pdfDoc) { els.prev.disabled = viewer.currentPageNumber <= 1; els.next.disabled = viewer.currentPageNumber >= viewer.pagesCount; }
  }

  // Panels that only show information close with Escape and hand focus back to whatever opened them; the password
  // and too-large panels block the document, so they stay until answered.
  let panelOpener = null;
  let panelDismiss = false;
  function showPanel(html, actions, opts) {
    hideLoading();
    const o = opts || {};
    panelDismiss = !!o.dismiss;
    panelOpener = o.dismiss && document.activeElement !== document.body ? document.activeElement : null;
    els.panel.removeAttribute('aria-modal');
    els.panel.innerHTML = o.title
      ? `<div class="msg"><b id="panelTitle">${esc(o.title)}</b>${html}</div><div class="actions"></div>`
      : `<div class="msg" id="panelTitle">${html}</div><div class="actions"></div>`;
    const row = els.panel.querySelector('.actions');
    for (const a of actions || []) {
      const b = document.createElement('button'); b.className = a.primary ? 'btn primary' : 'btn'; b.textContent = a.label;
      b.addEventListener('click', a.run); row.appendChild(b);
    }
    els.panel.classList.remove('hidden');
    const first = row.querySelector('button'); if (first) { first.focus(); }
  }
  function hidePanel() {
    const back = panelOpener; panelOpener = null; panelDismiss = false;
    const had = els.panel.contains(document.activeElement);
    els.panel.classList.add('hidden'); els.panel.innerHTML = ''; els.panel.removeAttribute('aria-modal');
    if (had) { (back && back.isConnected && !back.disabled ? back : els.container).focus(); }
  }
  const systemViewer = { label: 'Open with system viewer', run: () => post({ type: 'openExternal' }) };

  function setProgress(fraction) {
    if (fraction === null || fraction >= 1) { els.progress.classList.add('hidden'); return; }
    els.progress.classList.remove('hidden');
    els.progress.firstElementChild.style.width = `${Math.max(3, Math.round(fraction * 100))}%`;
  }

  function reload(fromDisk) {
    reloading = true; diskReload = !!fromDisk;
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

  /** The file bytes as a Uint8Array, also when they arrive JSON-encoded (a Node Buffer becomes {type: 'Buffer', data}). */
  function bytes(d) {
    if (d instanceof Uint8Array) { return d; }
    if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) { return new Uint8Array(d.buffer || d, d.byteOffset || 0, d.byteLength); }
    if (d && Array.isArray(d.data)) { return Uint8Array.from(d.data); }
    if (Array.isArray(d)) { return Uint8Array.from(d); }
    return d;
  }

  async function open(m) {
    await closeDocument();
    const gen = generation;
    hidePanel();
    showLoading(m.name, m.size, m.mode === 'range');
    fileName = m.name; fileSize = m.size;
    const fromDisk = diskReload; diskReload = false;
    document.title = m.name;
    applyPrefs(m.prefs);
    if (!reloading) {
      // A page link that arrived while the host was still reading the file (landing.asked) beats the saved position.
      const asked = landing && landing.asked ? landing.page : m.page;
      landing = { page: asked || state.page || 1, asked: !!asked, scale: state.scale || m.scale || prefs.defaultZoom, rotation: state.rotation || 0 };
    }
    reloading = false;
    try { await ensureWorker(); } catch (e) {
      showPanel(`Could not start the PDF renderer: ${esc(e && e.message)}`, [{ label: 'Reload', run: () => restartWorker() }, systemViewer]);
      return;
    }
    const urls = { cmaps: cfg.cmaps, standardFonts: cfg.standardFonts, wasm: cfg.wasm, iccs: cfg.iccs };
    const init = m.mode === 'range'
      ? { range: new HostRangeTransport(m.length, bytes(m.initial)), rangeChunkSize: 262144 }
      : { data: bytes(m.data) };
    try {
      loadingTask = pdfjsLib.getDocument(pdfLoadOptions(urls, init));
    } catch (e) {
      // getDocument throws at once on bad input (not via task.promise): show it instead of an endless spinner.
      if (gen !== generation) { return; }
      setProgress(null);
      showPanel(`Could not open ${esc(fileName)}: ${esc((e && e.message) || e)}`, [{ label: 'Reload', primary: true, run: () => reload() }, systemViewer]);
      return;
    }
    const task = loadingTask;
    task.onProgress = ({ loaded, total }) => { if (gen === generation) { setProgress(total ? loaded / total : null); } };
    task.onPassword = (update, reason) => askPassword(update, reason === PasswordResponses.INCORRECT_PASSWORD, fromDisk);
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
      if (fromDisk && Date.now() - reloadToastAt >= 2000) { reloadToastAt = Date.now(); toast(`Reloaded: ${fileName} changed on disk`); }
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
  function askPassword(update, wrong, fromDisk) {
    hideLoading();
    panelOpener = null; panelDismiss = false;
    els.panel.setAttribute('aria-modal', 'true');
    els.panel.innerHTML = `<div class="msg" id="panelTitle">${fromDisk && !wrong ? 'The file changed on disk. ' : ''}<b>${esc(fileName)}</b> is password-protected.${wrong ? '<div class="err">Incorrect password, try again.</div>' : ''}</div>
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
    if (l.page && l.page <= viewer.pagesCount) { viewer.currentPageNumber = l.page; } else if (l.asked && l.page > viewer.pagesCount) { toast(`This PDF has only ${viewer.pagesCount} pages`); }
    landing = null;
    syncSidebar();
    hideLoading();
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
  eventBus.on('rotationchanging', ({ pagesRotation }) => {
    state.rotation = pagesRotation; saveState();
    // Thumbnails are drawn at the rotation of the moment, so redraw them (lazily, as for a fresh document).
    if (!pdfDoc) { return; }
    buildThumbs(pdfDoc);
    if (!els.sidebar.classList.contains('hidden') && !els.thumbsView.classList.contains('hidden')) { observeThumbs(); }
    markThumb(viewer.currentPageNumber);
  });
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
  const resetZoom = () => { viewer.currentScaleValue = prefs.defaultZoom; els.zoom.value = prefs.defaultZoom; };
  els.zoom.addEventListener('change', () => { if (els.zoom.value === 'default') { resetZoom(); } else if (els.zoom.value !== 'custom') { viewer.currentScaleValue = els.zoom.value; } });
  els.zoomIn.addEventListener('click', () => viewer.increaseScale());
  els.zoomOut.addEventListener('click', () => viewer.decreaseScale());
  els.rotate.addEventListener('click', () => { viewer.pagesRotation = (viewer.pagesRotation + 90) % 360; });
  els.ask.addEventListener('click', () => post({ type: 'ask' }));
  els.ask.title = `Ask LocalPilot about this PDF (${ASK_KEY})`;
  els.ask.setAttribute('aria-keyshortcuts', isMac ? "Meta+'" : "Control+'");
  els.sidebarToggle.addEventListener('click', () => {
    const show = els.sidebar.classList.contains('hidden');
    state.sidebar = show ? (state.sidebarTab || defaultTab()) : 'hidden'; saveState();
    syncSidebar();
  });
  els.tabOutline.addEventListener('click', () => { state.sidebar = state.sidebarTab = 'outline'; saveState(); syncSidebar(); });
  els.tabThumbs.addEventListener('click', () => { state.sidebar = state.sidebarTab = 'thumbnails'; saveState(); syncSidebar(); });
  // Left/Right (and Home/End) move between the tabs and select them; only the selected tab is in the Tab order.
  for (const tab of [els.tabOutline, els.tabThumbs]) {
    tab.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { return; }
      e.preventDefault();
      const target = e.key === 'Home' ? els.tabOutline : e.key === 'End' ? els.tabThumbs : tab === els.tabOutline ? els.tabThumbs : els.tabOutline;
      if (target === tab || target.disabled) { return; }
      target.click(); target.focus();
    });
  }
  els.container.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !pdfDoc) { return; }
    e.preventDefault();
    viewer.updateScale({ drawingDelay: 200, scaleFactor: e.deltaY < 0 ? 1.1 : 1 / 1.1 });
  }, { passive: false });

  // ------------------------------------------------------------------ menus
  let menuAnchor = null;
  function openMenu(anchor, items) {
    const m = els.menu;
    if (menuAnchor && menuAnchor !== anchor) { menuAnchor.setAttribute('aria-expanded', 'false'); }
    menuAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
    m.innerHTML = '';
    for (const it of items) {
      if (it === '-') { const hr = document.createElement('div'); hr.className = 'menu-sep'; m.appendChild(hr); continue; }
      if (it.heading) { const h = document.createElement('div'); h.setAttribute('role', 'presentation'); h.textContent = it.heading; h.style.cssText = 'padding: 4px 10px 2px 26px; font-size: 11px; color: var(--muted);'; m.appendChild(h); continue; }
      const b = document.createElement('button'); b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span class="check">${it.checked ? '✓' : ''}</span><span>${esc(it.label)}</span>`;
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => { closeMenu(true); it.run(); });
      m.appendChild(b);
    }
    m.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    m.style.top = `${r.bottom + 4}px`;
    m.style.left = `${Math.max(6, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 6))}px`;
    const first = m.querySelector('button:not(:disabled)'); if (first) { first.focus(); }
  }
  /** Closes the menu; `refocus` (Escape, a chosen item) puts focus back on the button that opened it. */
  function closeMenu(refocus) {
    if (els.menu.classList.contains('hidden')) { return; }
    els.menu.classList.add('hidden');
    const a = menuAnchor; menuAnchor = null;
    if (a) { a.setAttribute('aria-expanded', 'false'); if (refocus) { a.focus(); } }
  }
  els.menu.addEventListener('keydown', (e) => {
    const items = [...els.menu.querySelectorAll('button:not(:disabled)')];
    if (!items.length) { return; }
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: (i + 1) % items.length, ArrowUp: (i - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); items[to].focus(); } else if (e.key === 'Tab') { e.preventDefault(); closeMenu(true); }
  });
  // Clicking the open menu's own button toggles it closed (its click handler sees the menu already hidden).
  let menuToggled = null;
  document.addEventListener('mousedown', (e) => {
    if (els.menu.contains(e.target)) { return; }
    const a = menuAnchor && menuAnchor.contains(e.target) ? menuAnchor : null;
    menuToggled = a; closeMenu(false);
  });
  const menuButton = (b, items) => b.addEventListener('click', () => {
    if (menuToggled === b) { menuToggled = null; return; }
    if (menuAnchor === b) { closeMenu(true); } else { openMenu(b, items()); }
  });
  const setColors = (v) => { applyPrefs({ ...prefs, pageColors: v }); post({ type: 'prefs', patch: { pageColors: v } }); };
  menuButton(els.colors, () => [
    { label: 'Auto (follow theme)', checked: prefs.pageColors === 'auto', run: () => setColors('auto') },
    { label: 'Original', checked: prefs.pageColors === 'original', run: () => setColors('original') },
    { label: 'Dark', checked: prefs.pageColors === 'dark', run: () => setColors('dark') },
    { label: 'Sepia', checked: prefs.pageColors === 'sepia', run: () => setColors('sepia') },
  ]);
  // Toolbar buttons hidden by the narrow-width CSS (pdfview.css) move into the ⋯ menu at the same breakpoints.
  const narrow = { s: matchMedia('(max-width: 560px)'), m: matchMedia('(max-width: 480px)'), l: matchMedia('(max-width: 360px)') };
  const syncMoreTitle = () => { els.more.title = narrow.s.matches ? 'More actions (rotate, colours…)' : 'More actions'; };
  narrow.s.addEventListener('change', syncMoreTitle); syncMoreTitle();
  menuButton(els.more, () => {
    const tinted = effectiveColors() === 'dark' || effectiveColors() === 'sepia';
    const page = viewer.currentPageNumber || 1;
    const hidden = [
      ...(narrow.l.matches ? [
        { label: 'Previous page', disabled: !pdfDoc || page <= 1, run: () => viewer.previousPage() },
        { label: 'Next page', disabled: !pdfDoc || page >= viewer.pagesCount, run: () => viewer.nextPage() },
        '-',
      ] : []),
      ...(narrow.s.matches ? [
        { label: 'Zoom in', disabled: !pdfDoc, run: () => viewer.increaseScale() },
        { label: 'Zoom out', disabled: !pdfDoc, run: () => viewer.decreaseScale() },
        { label: 'Rotate clockwise', disabled: !pdfDoc, run: () => { viewer.pagesRotation = (viewer.pagesRotation + 90) % 360; } },
        { label: 'Rotate counter-clockwise', disabled: !pdfDoc, run: () => { viewer.pagesRotation = (viewer.pagesRotation + 270) % 360; } },
        '-',
      ] : []),
      ...(narrow.m.matches ? [
        { heading: 'Page colours' },
        { label: 'Auto (follow theme)', checked: prefs.pageColors === 'auto', run: () => setColors('auto') },
        { label: 'Original', checked: prefs.pageColors === 'original', run: () => setColors('original') },
        { label: 'Dark', checked: prefs.pageColors === 'dark', run: () => setColors('dark') },
        { label: 'Sepia', checked: prefs.pageColors === 'sepia', run: () => setColors('sepia') },
        '-',
      ] : []),
    ];
    return [
      ...hidden,
      { label: 'Attach page as image', disabled: !pdfDoc, run: () => void attachPageImage() },
      { label: 'Copy page text', disabled: !pdfDoc, run: () => void copyPageText() },
      ...(tinted && !narrow.m.matches ? [{ label: 'Show original colours', run: () => setColors('original') }] : []),
      '-',
      { label: 'Document properties', disabled: !pdfDoc, run: () => void showProperties() },
      { label: 'Open with system viewer', run: () => post({ type: 'openExternal' }) },
      { label: 'Reveal in file manager', run: () => post({ type: 'reveal' }) },
      '-',
      { label: 'Viewer settings…', run: () => post({ type: 'openSettings' }) },
    ];
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
    if (mod && e.key === '0') { e.preventDefault(); if (pdfDoc) { resetZoom(); } return; }
    // Ctrl/Cmd+' asks about the selection when there is one in the pages, else about the PDF (the host drops the keybinding's duplicate).
    if (mod && e.key === "'") { e.preventDefault(); const s = selectionInDoc(); if (s) { askAboutSelection(s, true); } else { post({ type: 'ask', key: true }); } return; }
    if (e.key === 'Escape') {
      if (!els.menu.classList.contains('hidden')) { closeMenu(true); } else if (panelDismiss && !els.panel.classList.contains('hidden')) { hidePanel(); } else if (!els.findbar.classList.contains('hidden')) { closeFind(); }
      return;
    }
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
    els.zoomDefault.textContent = `Default (${ZOOM_LABELS[prefs.defaultZoom] || 'Auto'})`;
    els.zoom.title = `Zoom. Reset zoom (${isMac ? '⌘0' : 'Ctrl+0'}) goes to ${(ZOOM_LABELS[prefs.defaultZoom] || 'Auto').toLowerCase()}`;
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
    els.tabOutline.tabIndex = outline ? 0 : -1; els.tabThumbs.tabIndex = outline ? -1 : 0;
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
  // The outline is a tree: rows carry aria-level, parents a chevron and aria-expanded, children sit in a role=group.
  // Long outlines open folded below the top level (over 40 entries) and get a filter (over 12).
  const OUTLINE_FILTER_MIN = 12;
  const OUTLINE_FOLD_MIN = 40;
  let outlineFilter = null;
  let outlineTree = null;
  async function buildOutline(doc, gen) {
    els.outlineView.innerHTML = ''; outlineItems = []; hasOutline = false; outlineFilter = outlineTree = null;
    const outline = await doc.getOutline().catch(() => null);
    if (gen !== generation || !outline || !outline.length) { syncSidebar(); return; }
    hasOutline = true;
    let total = 0;
    const count = (items, depth) => { for (const it of items) { total++; if (it.items && depth < 6) { count(it.items, depth + 1); } } };
    count(outline, 1);
    const fold = total > OUTLINE_FOLD_MIN;
    if (total > OUTLINE_FILTER_MIN) {
      const f = outlineFilter = document.createElement('input');
      f.type = 'search'; f.className = 'filter'; f.placeholder = 'Filter outline'; f.setAttribute('aria-label', 'Filter outline');
      f.addEventListener('input', applyOutlineView);
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const first = visibleOutline()[0]; if (first) { first.go(); } }
        else if (e.key === 'Escape' && f.value) { e.preventDefault(); e.stopPropagation(); f.value = ''; applyOutlineView(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); const first = visibleOutline()[0]; if (first) { focusOutline(first); } }
      });
      els.outlineView.appendChild(f);
    }
    outlineTree = document.createElement('div'); outlineTree.className = 'otree'; outlineTree.setAttribute('role', 'tree'); outlineTree.setAttribute('aria-label', 'Outline');
    const render = (items, depth, parentEl, parent) => {
      for (const it of items) {
        const node = document.createElement('div'); node.className = 'onode'; node.setAttribute('role', 'none');
        const row = document.createElement('div'); row.className = `oi d${Math.min(depth, 4)}`; row.title = it.title || ''; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth)); row.tabIndex = -1;
        if (it.bold) { row.classList.add('b'); } if (it.italic) { row.classList.add('i'); }
        const kids = it.items && it.items.length && depth < 6 ? it.items : null;
        const entry = { el: row, node, page: undefined, parent, title: (it.title || '').toLowerCase(), group: null, chev: null, expanded: !fold };
        entry.go = () => {
          if (it.dest) { void linkService.goToDestination(it.dest); } else if (it.url && /^(https?:|mailto:)/i.test(it.url)) { post({ type: 'openLink', href: it.url }); }
        };
        if (kids) {
          const chev = document.createElement('button'); chev.className = 'chev'; chev.tabIndex = -1;
          chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
          chev.addEventListener('click', (e) => { e.stopPropagation(); setExpanded(entry, !entry.expanded); focusOutline(entry); });
          row.appendChild(chev); entry.chev = chev;
        } else {
          const pad = document.createElement('span'); pad.className = 'chev'; pad.setAttribute('aria-hidden', 'true'); row.appendChild(pad);
        }
        const label = document.createElement('span'); label.className = 't'; label.textContent = it.title || '(untitled)'; row.appendChild(label);
        row.addEventListener('click', () => { focusOutline(entry); entry.go(); });
        row.addEventListener('keydown', (e) => outlineKey(e, entry));
        node.appendChild(row);
        parentEl.appendChild(node);
        outlineItems.push(entry);
        if (it.dest) { void destPage(doc, it.dest).then((p) => { entry.page = p; queueHighlight(); }); }
        if (kids) {
          const group = document.createElement('div'); group.setAttribute('role', 'group'); node.appendChild(group); entry.group = group;
          render(kids, depth + 1, group, entry);
        }
      }
    };
    render(outline, 1, outlineTree, null);
    els.outlineView.appendChild(outlineTree);
    outlineItems[0].el.tabIndex = 0;
    applyOutlineView();
    syncSidebar();
  }
  function setExpanded(entry, open) {
    if (!entry.group) { return; }
    entry.expanded = open;
    applyOutlineView();
    if (pdfDoc) { highlightOutline(viewer.currentPageNumber); }
  }
  const outlineQuery = () => (outlineFilter ? outlineFilter.value.trim().toLowerCase() : '');
  /** Shows the rows that folding and the filter allow; a filter shows the matches with their parents, unfolded. */
  function applyOutlineView() {
    const q = outlineQuery();
    const shown = new Set();
    if (q) { for (const it of outlineItems) { if (it.title.includes(q)) { for (let p = it; p && !shown.has(p); p = p.parent) { shown.add(p); } } } }
    for (const it of outlineItems) {
      it.node.hidden = !!q && !shown.has(it);
      if (it.group) {
        const open = q ? true : it.expanded;
        it.group.hidden = !open;
        it.el.setAttribute('aria-expanded', String(open));
        it.chev.setAttribute('aria-label', open ? 'Collapse' : 'Expand');
      }
    }
    outlineTree.dataset.empty = q && !shown.size ? 'No matching entries' : '';
    // Keep one row in the Tab order even when the filter hid the one that had it.
    const vis = visibleOutline();
    if (vis.length && !vis.some((it) => it.el.tabIndex === 0)) { for (const it of outlineItems) { it.el.tabIndex = it === vis[0] ? 0 : -1; } }
  }
  const visibleOutline = () => outlineItems.filter((it) => !it.node.closest('[hidden]'));
  function focusOutline(entry) {
    for (const it of outlineItems) { it.el.tabIndex = it === entry ? 0 : -1; }
    entry.el.focus();
  }
  function outlineKey(e, entry) {
    if (e.altKey || e.ctrlKey || e.metaKey) { return; }
    const vis = visibleOutline();
    const i = vis.indexOf(entry);
    const go = (t) => { e.preventDefault(); if (t) { focusOutline(t); } };
    const open = entry.group && !entry.group.hidden;
    switch (e.key) {
      case 'Enter': case ' ': e.preventDefault(); entry.go(); break;
      case 'ArrowDown': go(vis[i + 1]); break;
      case 'ArrowUp': if (i <= 0 && outlineFilter) { e.preventDefault(); outlineFilter.focus(); } else { go(vis[i - 1]); } break;
      case 'Home': go(vis[0]); break;
      case 'End': go(vis[vis.length - 1]); break;
      case 'ArrowRight': e.preventDefault(); if (entry.group && !open) { setExpanded(entry, true); } else if (open) { go(vis[i + 1]); } break;
      // While filtering every parent shows unfolded, so Left only climbs to the parent.
      case 'ArrowLeft': e.preventDefault(); if (open && !outlineQuery()) { setExpanded(entry, false); } else if (entry.parent) { go(entry.parent); } break;
    }
  }
  // Destinations resolve one by one; mark the current entry once they settle rather than after each.
  let hlTimer = 0;
  const queueHighlight = () => { if (!hlTimer) { hlTimer = setTimeout(() => { hlTimer = 0; if (pdfDoc) { highlightOutline(viewer.currentPageNumber); } }, 60); } };
  function highlightOutline(page) {
    let best = null;
    for (const it of outlineItems) { if (it.page !== undefined && it.page <= page && (!best || it.page >= best.page)) { best = it; } }
    // The current entry may sit inside a folded parent: mark the nearest visible ancestor instead.
    let mark = best;
    while (mark && mark.parent && !outlineShows(mark)) { mark = mark.parent; }
    for (const it of outlineItems) {
      it.el.classList.toggle('on', it === mark);
      if (it === best) { it.el.setAttribute('aria-current', 'location'); } else { it.el.removeAttribute('aria-current'); }
    }
  }
  const outlineShows = (it) => { for (let p = it.parent; p; p = p.parent) { if (!p.expanded) { return false; } } return true; };

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
    showPanel(`<table class="props">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`, [{ label: 'Close', run: hidePanel }], { title: 'Document properties', dismiss: true });
  }

  // Ask about selection: a floating "Ask LocalPilot" pill below the end of a text-layer selection (same as the Markdown reader).
  els.askSel.textContent = 'Ask LocalPilot';
  els.askSel.title = `Ask LocalPilot (${ASK_KEY})`;
  els.askSel.setAttribute('aria-keyshortcuts', isMac ? "Meta+'" : "Control+'");
  function selectionInDoc() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { return undefined; }
    const text = String(sel).trim();
    const node = sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
    const pageEl = node && node.closest ? node.closest('.page') : null;
    if (!text || !pageEl || !node.closest('.textLayer')) { return undefined; }
    return { text, range: sel.getRangeAt(0), page: Number(pageEl.dataset.pageNumber) || viewer.currentPageNumber };
  }
  function setAskSel(show) {
    const was = !els.askSel.classList.contains('hidden');
    els.askSel.classList.toggle('hidden', !show);
    if (show !== was) { els.askLive.textContent = show ? 'Ask LocalPilot button available' : ''; }
  }
  function askAboutSelection(s, key) {
    const text = s.text.slice(0, maxQuote);
    post({ type: 'askSelection', text, page: s.page, ...(s.text.length > text.length ? { total: s.text.length } : {}), ...(key ? { key: true } : {}) });
    setAskSel(false);
  }
  /** Shows the pill below the end of the selection (its last line box); hidden when there is none or it scrolled out of view. */
  function placeAskSel() {
    const s = selectionInDoc();
    const rects = s ? s.range.getClientRects() : [];
    const r = rects.length ? rects[rects.length - 1] : s && s.range.getBoundingClientRect();
    const box = els.container.getBoundingClientRect();
    if (!s || !r || r.bottom < box.top || r.top > box.bottom) { setAskSel(false); return; }
    setAskSel(true);
    els.askSel.style.top = `${Math.max(44, Math.min(window.innerHeight - 34, r.bottom + 6))}px`;
    els.askSel.style.left = `${Math.max(6, Math.min(window.innerWidth - els.askSel.offsetWidth - 6, r.right - els.askSel.offsetWidth))}px`;
  }
  let selTimer;
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(placeAskSel, 150); });
  els.askSel.addEventListener('mousedown', (e) => e.preventDefault());
  els.askSel.addEventListener('click', () => { const s = selectionInDoc(); if (s) { askAboutSelection(s, false); } else { setAskSel(false); } });
  // The pill follows the selection while the pages scroll (pdf.js also scrolls on zoom and re-layout).
  let selFrame = 0;
  els.container.addEventListener('scroll', () => { if (!selFrame && !els.askSel.classList.contains('hidden')) { selFrame = requestAnimationFrame(() => { selFrame = 0; placeAskSel(); }); } }, { passive: true });

  // ------------------------------------------------------------------ host messages
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') { return; }
    switch (m.type) {
      case 'loading': showLoading(m.name, m.size, false); break;
      case 'open': void open(m); break;
      case 'rangeData': {
        const r = inflight.get(m.id); inflight.delete(m.id);
        if (r && r.gen === generation) { r.split.fill(r.part, bytes(m.data)); }
        pump();
        break;
      }
      case 'rangeError': {
        const r = inflight.get(m.id); inflight.delete(m.id);
        if (r && r.gen === generation) { rangeFailed(r, m.message); }
        pump();
        break;
      }
      case 'reload': reload(true); break;
      case 'goToPage':
        if (!(m.page >= 1)) { break; }
        // Before the pages exist (or while a reload is pending) the link's page waits in landing for pagesinit.
        if (!pdfDoc || landing) { landing = { ...(landing || {}), page: m.page, asked: true }; break; }
        if (m.page > viewer.pagesCount) { toast(`This PDF has only ${viewer.pagesCount} pages`); }
        viewer.currentPageNumber = Math.min(m.page, viewer.pagesCount);
        break;
      case 'prefs':
        // A changed sidebar setting replaces the tab's own choice, so the new setting shows at once.
        if (m.prefs && m.prefs.sidebar !== prefs.sidebar) { delete state.sidebar; delete state.sidebarTab; saveState(); }
        { const zoomChanged = m.prefs && m.prefs.defaultZoom !== prefs.defaultZoom; applyPrefs(m.prefs); if (zoomChanged && pdfDoc) { resetZoom(); } }
        break;
      case 'toast': toast(m.text, m.level); break;
      case 'attachPageImage': void attachPageImage(); break;
      case 'tooLarge':
        showPanel(`<b>This PDF is ${esc(fmtMB(m.size))}, larger than your limit of ${esc(fmtMB(m.max))}.</b><br><span class="muted">It can still open page by page.</span>`, [
          { label: 'Open anyway (page by page)', primary: true, run: () => { hidePanel(); post({ type: 'openAnyway' }); } }, systemViewer,
          { label: 'Change limit…', run: () => post({ type: 'openSettings' }) },
        ]);
        break;
    }
  });
  applyColors();
  post({ type: 'ready' });
})();
