// Setup advisor on the home page. Mirrors the extension's own sizing (src/providers/system.ts buildProfile and
// src/providers/catalog.ts starterPlan) so the advice matches what LocalPilot does after install.
(function () {
  var form = document.getElementById('advisor');
  var out = document.getElementById('advisor-result');
  if (!form || !out) { return; }
  var cfg = window.LP_ADVISOR || {};

  // Catalog subset: runtime footprint in GB, Ollama tag and LM Studio repo (from src/providers/catalog.ts).
  var M = {
    'gemma4:e2b': { gb: 4.6, lms: 'lmstudio-community/gemma-4-E2B-it-GGUF', what: 'tools + images' },
    'gemma4:e4b': { gb: 6.6, lms: 'lmstudio-community/gemma-4-E4B-it-GGUF', what: 'tools + images' },
    'gemma4:12b': { gb: 8.0, lms: 'lmstudio-community/gemma-4-12B-it-GGUF', what: 'tools + images' },
    'gemma4:31b': { gb: 19, lms: 'lmstudio-community/gemma-4-31B-it-GGUF', what: 'tools + images' },
    'qwen2.5-coder:1.5b': { gb: 1.0, lms: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF', what: 'fill-in-the-middle' },
    'qwen2.5-coder:7b': { gb: 4.7, lms: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', what: 'coding + FIM' },
    'qwen2.5-coder:14b': { gb: 9.0, lms: 'Qwen/Qwen2.5-Coder-14B-Instruct-GGUF', what: 'coding + tools' },
    'gpt-oss:20b': { gb: 14, lms: 'lmstudio-community/gpt-oss-20b-GGUF', what: 'agent + reasoning' },
    'starcoder2:3b': { gb: 1.7, lms: '', what: 'fill-in-the-middle' },
    'llama3.2:3b': { gb: 2.0, lms: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF', what: 'small, tools' },
    'llama3.2:1b': { gb: 1.3, lms: 'lmstudio-community/Llama-3.2-1B-Instruct-GGUF', what: 'tiny, tools' },
    'qwen2.5vl:3b': { gb: 3.2, lms: '', what: 'images only' },
  };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var val = function (n) { var el = form.querySelector('input[name="' + n + '"]:checked'); return el ? el.value : ''; };

  function budget(os, ram, vram) {
    var b;
    if (os === 'mac') { b = ram <= 8 ? ram * 0.5 : ram <= 16 ? ram * 0.6 : ram * 0.7; }
    else if (os !== 'macintel' && vram >= 4) { b = Math.max(vram - 1, Math.min(vram * 1.5, ram * 0.5)); }
    else { b = ram * 0.5; }
    return Math.max(1, Math.round(b * 10) / 10);
  }
  function starter(b) {
    var agent = b >= 9 ? 'gemma4:e4b' : b >= 4 ? 'gemma4:e2b' : b >= 2.5 ? 'llama3.2:3b' : 'llama3.2:1b';
    var picks = [{ role: 'Chat & agent', id: agent }];
    if (agent.indexOf('gemma4') === 0 && M[agent].gb + M['starcoder2:3b'].gb <= b) { picks.push({ role: 'Inline completions', id: 'starcoder2:3b' }); }
    return picks;
  }
  function largest(ids, b) { var fit = ids.filter(function (id) { return M[id].gb <= b; }); return fit.length ? fit[fit.length - 1] : ''; }
  var AGENTS = ['llama3.2:3b', 'gemma4:e2b', 'gemma4:e4b', 'qwen2.5-coder:14b', 'gpt-oss:20b'];

  function picksFor(goal, b) {
    var p = [];
    if (goal === 'complete') {
      p.push({ role: 'Inline completions', id: 'qwen2.5-coder:1.5b' });
      var chat = largest(AGENTS, Math.max(0, b * 0.9 - 1));
      if (chat) { p.push({ role: 'Chat & agent', id: chat }); }
    } else if (goal === 'parallel') {
      // Two models that fit together: workers that find one busy run on the other instead of queuing.
      var main = largest(AGENTS, b * 0.62);
      var helper = main ? largest(['llama3.2:1b', 'llama3.2:3b', 'gemma4:e2b', 'gemma4:e4b'], Math.min(b - M[main].gb, M[main].gb - 0.1)) : '';
      if (main) { p.push({ role: 'Chat & coding workers', id: main }); }
      if (helper) { p.push({ role: 'Read-only subagents', id: helper }); }
    } else if (goal === 'vision') {
      var v = largest(['gemma4:e2b', 'gemma4:e4b', 'gemma4:12b', 'gemma4:31b'], b);
      p.push(v ? { role: 'Chat, agent & images', id: v } : { role: 'Images', id: 'qwen2.5vl:3b' });
    } else {
      // ~10% headroom for the editor and KV cache; like the starter plan, a slightly tight Gemma 4 e2b beats a tiny model.
      var a = largest(AGENTS, b * 0.9);
      if (b >= 4 && (!a || a.indexOf('llama') === 0)) { a = 'gemma4:e2b'; }
      p.push({ role: 'Chat & agent', id: a || 'llama3.2:1b' });
      if (a && M[a].gb + 1 <= b) { p.push({ role: 'Inline completions', id: 'qwen2.5-coder:1.5b' }); }
    }
    return p;
  }

  function render(e) {
    var os = val('os'); var ram = Number(val('ram')); var rt = val('rt'); var goal = val('goal');
    var gpuSet = form.querySelector('[data-gpu]');
    gpuSet.hidden = os === 'mac' || os === 'macintel';
    var vram = gpuSet.hidden ? 0 : Number(val('vram'));
    var offline = form.querySelector('input[name="offline"]').checked;
    var b = budget(os, ram, vram);
    var auto = rt === 'none' && goal === 'agent';
    var picks = auto ? starter(b) : picksFor(goal, b);
    var total = picks.reduce(function (s, x) { return s + M[x.id].gb; }, 0);
    var size = b < 4 ? 'very small models (about 3B)' : b < 9 ? 'small models (up to about 7B)' : b < 18 ? 'mid-size models (up to about 14B)' : b < 40 ? 'large models (up to about 32B)' : 'anything, including 70B+';
    var mac = os === 'mac' || os === 'macintel';

    var rows = picks.map(function (x) {
      return '<li><span class="role">' + esc(x.role) + '</span><code>' + esc(x.id) + '</code><span class="gb">' + esc(M[x.id].gb) + ' GB · ' + esc(M[x.id].what) + '</span></li>';
    }).join('');

    var get;
    if (rt === 'none') {
      get = 'In the LocalPilot chat, click <strong>Set up automatically</strong>. It installs Ollama (no admin rights needed) and downloads ' + (auto ? 'these models' : 'a starter model') + '.' + (auto ? '' : ' Then install the models above from <strong>Settings → Models</strong>.');
    } else if (rt === 'ollama') {
      get = 'LocalPilot finds Ollama on its own. Pull the models:<pre><code>' + picks.map(function (x) { return 'ollama pull ' + esc(x.id); }).join('\n') + '</code></pre>';
    } else if (rt === 'lmstudio') {
      var lms = picks.filter(function (x) { return M[x.id].lms; });
      get = 'Download ' + (lms.length ? lms.map(function (x) { return '<code>' + esc(M[x.id].lms) + '</code>'; }).join(' and ') : 'a model of about ' + esc(Math.floor(b)) + ' GB or less') + ' in LM Studio, then start its server in the Developer tab. LocalPilot finds <code>localhost:1234</code> on its own.';
    } else {
      get = 'Start your server, then add its <code>/v1</code> address in <strong>Settings → Providers</strong> (llama.cpp on <code>:8080</code> and vLLM on <code>:8000</code> are found on their own). Serve a model of about ' + esc(Math.floor(b)) + ' GB or less, such as the ones above.';
    }

    var notes = [];
    if (b < 4) { notes.push('With this much memory only very small models run. They handle single-file fixes and questions; multi-step agent tasks are hit and miss.'); }
    if (goal === 'parallel' && picks.length < 2) { notes.push('There is room for one model only, so parallel agents share it and take turns. It works, but slowly.'); }
    if (goal === 'vision' && picks[0].id === 'qwen2.5vl:3b') { notes.push('No tool-calling vision model fits; this one only reads images, so pair it with a small agent model.'); }
    if (os === 'macintel' || (!mac && !vram)) { notes.push('Without a GPU, models run on the CPU: expect a few tokens per second from 7B models.'); }
    if (offline) { notes.push('Download the models while online. After that, chat, edits, tests and completions work without a network. To stop the two optional network features, set <code>localpilot.skills.autoInstall</code> to <code>off</code> and <code>localpilot.approvals.network</code> to <code>never</code>. <a href="' + esc(cfg.privacy || '#') + '">What goes where</a>'); }

    out.innerHTML =
      '<div class="adv-head"><div><b>About ' + esc(b) + ' GB for models</b><span>Comfortable with ' + esc(size) + '.</span></div><div class="adv-total"><b>' + esc(Math.round(total * 10) / 10) + ' GB</b><span>to download</span></div></div>' +
      '<ul class="adv-models">' + rows + '</ul>' +
      '<ol class="adv-steps">' +
      '<li><b>Install LocalPilot</b><span><a href="' + esc(cfg.market || '#') + '">From the Marketplace</a>, or in a terminal:<pre><code>code --install-extension ' + esc(cfg.ext || '') + '</code></pre></span></li>' +
      '<li><b>Get the model' + (picks.length > 1 ? 's' : '') + '</b><span>' + get + '</span></li>' +
      '<li><b>Run a first task</b><span>Open the chat (' + (mac ? '⌘⇧L' : 'Ctrl+Shift+L') + '), keep the mode on <b>Agent</b> and ask for something small, such as “find the failing test and fix it”. Review the diff, then keep it. <a href="' + esc(cfg.start || '#') + '">Step-by-step guide</a></span></li>' +
      '</ol>' +
      (notes.length ? '<ul class="adv-notes">' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' : '') +
      '<p class="adv-fine">A starting point from LocalPilot\'s built-in model catalog, not a benchmark. <a href="' + esc(cfg.models || '#') + '">How models are sized</a></p>';

    if (e && typeof window.gtag === 'function') { window.gtag('event', 'setup_advisor', { os: os, ram: ram, vram: vram, runtime: rt, goal: goal, offline: offline }); }
  }

  form.addEventListener('change', render);
  render();
})();
