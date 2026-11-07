// Landing page behaviour: the feature slider (tabs, autoplay with progress, typed headlines), the hero walkthrough,
// the typed agent run, copy buttons, scroll reveal, pointer spotlight and the reading-progress bar.
// Everything degrades: without this script every panel's content is still in the page and the first one shows.
(() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ---------------------------------------------------------------- typing */
  // Types `el`'s data-text into it; the full text stays in data-text for readers and search.
  const typed = new WeakMap();
  function typeInto(el, speed = 28) {
    const text = el.dataset.text || el.textContent;
    clearTimeout(typed.get(el));
    if (calm) { el.textContent = text; return; }
    el.classList.add('typing');
    el.textContent = '';
    let i = 0;
    const step = () => {
      i++;
      el.textContent = text.slice(0, i);
      if (i < text.length) typed.set(el, setTimeout(step, speed));
      else typed.set(el, setTimeout(() => el.classList.remove('typing'), 900));
    };
    step();
  }

  /* ---------------------------------------------------------------- feature slider */
  const slider = $('.lp-slider');
  if (slider) {
    const tablist = $('.lp-tabs', slider);
    const tabs = $$('[role="tab"]', tablist);
    const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
    const ind = $('.lp-tab-ind', tablist);
    const playBtn = $('.lp-play', slider);
    const DURATION = 7000;
    let cur = 0, timer = 0, paused = calm, hovering = false, visible = false, started = 0, left = DURATION;

    const moveInd = () => {
      const t = tabs[cur];
      if (!ind || !t) return;
      ind.style.width = `${t.offsetWidth}px`;
      ind.style.height = `${t.offsetHeight}px`;
      ind.style.transform = `translate(${t.offsetLeft}px, ${t.offsetTop}px)`;
    };
    const keepInView = () => {
      const t = tabs[cur];
      const want = t.offsetLeft - (tablist.clientWidth - t.offsetWidth) / 2;
      tablist.scrollTo({ left: Math.max(0, want), behavior: calm ? 'auto' : 'smooth' });
    };
    const running = () => !paused && !hovering && visible;
    const schedule = () => {
      clearTimeout(timer);
      slider.classList.toggle('playing', running());
      if (!running()) return;
      started = Date.now();
      timer = setTimeout(() => show((cur + 1) % tabs.length, 1), left);
    };
    const halt = () => { // remember how much of this slide's time is left
      if (running()) left = Math.max(400, left - (Date.now() - started));
      clearTimeout(timer);
    };

    function show(n, dir = 1, focus = false) {
      const prev = cur;
      cur = n;
      tabs.forEach((t, i) => {
        const on = i === n;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        // restart the active tab's progress fill
        const fill = $('.lp-tab-fill', t);
        if (fill) { fill.style.animation = 'none'; void fill.offsetWidth; fill.style.animation = ''; }
      });
      panels.forEach((p, i) => {
        if (i === n) {
          p.hidden = false;
          p.classList.remove('from-left', 'from-right');
          if (prev !== n && !calm) p.classList.add(dir < 0 ? 'from-left' : 'from-right');
          const h = $('.lp-type', p);
          if (h) typeInto(h);
        } else {
          p.hidden = true;
        }
      });
      if (focus) tabs[n].focus();
      moveInd();
      keepInView();
      left = DURATION;
      slider.style.setProperty('--dur', `${DURATION}ms`);
      schedule();
    }

    tabs.forEach((t, i) => {
      t.addEventListener('click', () => show(i, i >= cur ? 1 : -1));
      t.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); show((cur + d + tabs.length) % tabs.length, d, true); }
        else if (e.key === 'Home') { e.preventDefault(); show(0, -1, true); }
        else if (e.key === 'End') { e.preventDefault(); show(tabs.length - 1, 1, true); }
      });
    });
    // Pause while the pointer or keyboard focus is inside, and while it is off screen.
    slider.addEventListener('pointerenter', () => { halt(); hovering = true; schedule(); });
    slider.addEventListener('pointerleave', () => { hovering = false; schedule(); });
    slider.addEventListener('focusin', () => { halt(); hovering = true; schedule(); });
    slider.addEventListener('focusout', (e) => { if (!slider.contains(e.relatedTarget)) { hovering = false; schedule(); } });
    playBtn?.addEventListener('click', () => {
      paused = !paused;
      playBtn.setAttribute('aria-pressed', String(paused));
      playBtn.setAttribute('aria-label', paused ? 'Play the slideshow' : 'Pause the slideshow');
      slider.classList.toggle('paused', paused);
      left = DURATION;
      show(cur);
    });
    // Plays only while a good part of it is on screen (measured on scroll and resize, so it works everywhere).
    const checkVisible = () => {
      const r = slider.getBoundingClientRect();
      const now = r.top < innerHeight * 0.8 && r.bottom > innerHeight * 0.2;
      if (now === visible) return;
      if (!now) halt();
      visible = now;
      schedule();
    };
    addEventListener('scroll', checkVisible, { passive: true });
    addEventListener('resize', checkVisible);
    slider.classList.add('js');
    slider.classList.toggle('paused', paused);
    addEventListener('resize', moveInd);
    document.fonts?.ready.then(moveInd);
    show(0);
    checkVisible();
  }

  /* ---------------------------------------------------------------- hero walkthrough */
  const stage = $('.lp-stage');
  if (stage) {
    const parts = $$('[data-hot]', stage);
    let step = 1, held = false;
    const set = (n) => { step = n; parts.forEach((el) => el.classList.toggle('on', el.dataset.hot === String(n))); };
    parts.forEach((el) => {
      const n = Number(el.dataset.hot);
      el.addEventListener('pointerenter', () => { held = true; set(n); });
      el.addEventListener('pointerleave', () => { held = false; });
      el.addEventListener('focus', () => { held = true; set(n); });
      el.addEventListener('blur', () => { held = false; });
      el.addEventListener('click', () => set(n));
    });
    set(1);
    if (!calm) setInterval(() => { if (!held) set((step % 4) + 1); }, 2600);
  }

  /* ---------------------------------------------------------------- reading progress and hero tilt */
  const progress = $('.lp-progress');
  const onScroll = () => {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    if (progress) progress.style.transform = `scaleX(${max > 0 ? h.scrollTop / max : 0})`;
    if (stage && !calm) stage.style.setProperty('--p', Math.min(1, h.scrollTop / 520).toFixed(3));
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------------------------------------------------------- typed agent run */
  const term = $('.lp-term');
  if (term) {
    term.classList.add('js');
    const lines = $$('.t-line', term);
    const steps = $$('.lp-steps li');
    const showLines = (n) => {
      lines.forEach((l, i) => l.classList.toggle('on', i < n));
      const at = n ? Number(lines[Math.min(n, lines.length) - 1].dataset.step) : -1;
      steps.forEach((s) => {
        const k = Number(s.dataset.step);
        s.classList.toggle('on', k === at);
        s.classList.toggle('done', k < at);
      });
    };
    if (calm) {
      showLines(lines.length);
    } else {
      let n = 0, runTimer = 0, runOn = false;
      const tick = () => {
        n = n > lines.length ? 0 : n + 1;
        showLines(Math.min(n, lines.length));
        runTimer = setTimeout(tick, n === 0 ? 500 : n >= lines.length ? 3200 : 520);
      };
      new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting && !runOn) { runOn = true; tick(); }
        else if (!e.isIntersecting && runOn) { clearTimeout(runTimer); runOn = false; }
      }), { threshold: 0.3 }).observe(term);
      showLines(0);
    }
  }

  /* ---------------------------------------------------------------- copy buttons */
  $$('.lp-copy').forEach((b) => b.addEventListener('click', () => {
    navigator.clipboard?.writeText(b.dataset.copy).then(() => {
      b.classList.add('done');
      setTimeout(() => b.classList.remove('done'), 1400);
    });
  }));

  /* ---------------------------------------------------------------- pointer spotlight */
  $$('.lp-card, .lp-mini .card, .lp-panel').forEach((c) => c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', `${e.clientX - r.left}px`);
    c.style.setProperty('--my', `${e.clientY - r.top}px`);
  }));

  /* ---------------------------------------------------------------- reveal on scroll */
  const reveal = $$('.lp-flow, .lp-says > div, .lp-start li, .lp-sub-head, .lp-orbit, .lp-head, .landing .section-head, .lp-card, .lp-mini .card, .lp-slider, .lp-run-text, .lp-term, .advisor, .compare, .proof, .faq details, .lp-final .wrap');
  if (!calm && 'IntersectionObserver' in window) {
    reveal.forEach((el) => {
      el.classList.add('lp-reveal');
      const group = [...el.parentElement.children].filter((x) => x.classList.contains('lp-reveal'));
      el.style.setProperty('--d', `${Math.min(group.indexOf(el), 8) * 70}ms`);
    });
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveal.forEach((el) => io.observe(el));
  }
})();
