// LocalPilot continuity pages in the chat webview (design §16.2): Trash, Versions, Compare answers, and the
// Knowledge & continuity pages (Memory, Context, Checkpoints, Sync). Opened from the navigator; Back returns to it.
// Uses the helpers chat.js exposes as window.LPChat (post, esc, el, icons, markdown); loaded after chat.js.
(function () {
  const api = window.LPChat;
  if (!api) { return; }
  const { post, esc, el, I, timeAgo, md } = api;
  const TITLES = { trash: 'Trash', versions: 'Versions', memory: 'Memory', context: 'Context', checkpoints: 'Checkpoints', sync: 'Sync', compare: 'Compare answers' };
  const root = el('div', 'cpage hidden');
  root.id = 'cpage'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
  (document.getElementById('app') || document.body).appendChild(root);
  let cur = null;

  function close(goBack) {
    root.classList.add('hidden'); root.innerHTML = '';
    const back = cur && cur.back; cur = null;
    if (goBack && back) { back(); } else { const i = document.getElementById('input'); if (i) { i.focus(); } }
  }
  function frame(title, sub, actions) {
    root.innerHTML = '';
    const head = el('div', 'cp-head', `<button class="cp-back" data-c="back" title="Back (Esc)" aria-label="Back">${I.reply}</button><div class="cp-title"><h2>${esc(title)}</h2>${sub ? `<span class="cp-sub">${sub}</span>` : ''}</div><span class="cp-acts">${actions || ''}</span>`);
    const body = el('div', 'cp-body'); body.setAttribute('tabindex', '-1');
    root.append(head, body);
    root.setAttribute('aria-label', title);
    head.querySelector('[data-c="back"]').onclick = () => close(true);
    return body;
  }
  function loading(page) {
    const body = frame(TITLES[page] || page);
    body.innerHTML = '<div class="cp-empty"><span class="spinner"></span>Loading…</div>';
  }
  function request() {
    if (!cur) { return; }
    if (cur.page === 'versions') { post({ type: 'continuityPage', page: 'versions', params: cur.params }); }
    else { post({ type: 'continuityPage', page: cur.page, params: cur.params }); }
  }
  function open(page, params, o) {
    cur = { page, params: params || {}, back: o && o.back };
    root.classList.remove('hidden');
    loading(page);
    request();
    setTimeout(() => { const b = root.querySelector('.cp-back'); if (b) { b.focus(); } }, 0);
  }
  // Esc: back to the list from a sub-view (memory editor, versions), else close the page.
  function subBack() { if (cur && cur.page === 'context' && cur.params.view === 'edit') { cur.params.view = 'library'; cur.edit = null; if (cur.data) { context(cur.data); } return true; } if (cur && cur.page === 'memory' && cur.params.view && cur.params.view !== 'list') { cur.params.view = 'list'; cur.edit = null; cur.versions = null; if (cur.data) { memory(cur.data); } return true; } return false; }
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); if (!subBack()) { close(true); } } });

  const row = (cls, html) => el('div', `cp-row ${cls || ''}`, html);
  const ago = (t) => { const a = timeAgo(t); return a === 'now' ? 'just now' : `${a} ago`; };
  const when = (t) => (t ? `<span title="${esc(new Date(t).toLocaleString())}">${esc(ago(t))}</span>` : '');

  function trash(d) {
    const rows = d.rows || [];
    const nm = (d.memory || []).length;
    const ns = (d.contextSets || []).length;
    const what = [rows.length ? `${rows.length} conversation${rows.length === 1 ? '' : 's'}` : '', nm ? `${nm} memory note${nm === 1 ? '' : 's'}` : '', ns ? `${ns} context set${ns === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    const body = frame('Trash', what ? `${what} · kept ${d.retentionDays ? `${d.retentionDays} days` : 'until you empty it'}` : '', what ? `<button class="btn sm danger" data-c="empty" title="Empty Trash" aria-label="Empty Trash">${I.trash}<span>Empty Trash</span></button>` : '');
    root.querySelector('[data-c="empty"]')?.addEventListener('click', () => post({ type: 'convAction', ids: [], action: 'emptyTrash' }));
    const mem = d.memory || [];
    if (mem.length) { memTrash(body, mem, d); }
    const sets = d.contextSets || [];
    if (sets.length) { ctxTrash(body, sets); }
    if (!rows.length && (mem.length || sets.length)) { return; }
    if (!rows.length) { body.innerHTML = `<div class="cp-empty">${I.trash}<p>Trash is empty.</p><p class="cp-note">Deleted conversations wait here${d.retentionDays ? ` for ${d.retentionDays} days` : ''} before they are removed for good. Settings → Continuity &amp; sync sets how long.</p></div>`; return; }
    const list = el('div', 'cp-list'); list.setAttribute('role', 'list');
    for (const r of rows) {
      const it = row('', `<span class="cp-main"><span class="cp-name">${esc(r.title || 'New chat')}</span><span class="cp-meta">${esc(r.projectName || '')}${r.projectName ? ' · ' : ''}${r.messageCount} message${r.messageCount === 1 ? '' : 's'} · deleted ${when(r.trashedAt)}</span></span><span class="cp-ra"><button class="btn sm" data-c="restore" title="Restore" aria-label="Restore">${I.restore}<span>Restore</span></button><button class="btn sm ghost danger" data-c="purge" title="Delete permanently" aria-label="Delete permanently">${I.trash}</button></span>`);
      it.setAttribute('role', 'listitem');
      it.onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) { return; } if (b.dataset.c === 'restore') { b.disabled = true; post({ type: 'convAction', ids: [r.id], action: 'restore' }); it.remove(); } else { post({ type: 'convAction', ids: [r.id], action: 'purge' }); } };
      list.appendChild(it);
    }
    body.insertBefore(list, body.firstChild);
  }
  /** Memory notes in Trash (MEMORY): Restore puts a project/developer note's file back. */
  function memTrash(body, mem, d) {
    const sec = el('section', 'cp-sec', `<h3>Memory notes <span class="cp-count">${mem.length}</span></h3>`);
    const list = el('div', 'cp-list'); list.setAttribute('role', 'list');
    for (const m of mem) {
      const it = row('', `<span class="cp-main"><span class="cp-name">${esc(m.name)}</span><span class="cp-meta">${esc(MEM_LABEL[m.type] || m.type)} memory · deleted ${when(m.trashedAt)}</span></span><span class="cp-ra"><button class="btn sm" data-c="restore" title="Restore" aria-label="Restore ${esc(m.name)}">${I.restore}<span>Restore</span></button><button class="btn sm ghost danger" data-c="purge" title="Delete permanently" aria-label="Delete ${esc(m.name)} permanently">${I.trash}</button></span>`);
      it.setAttribute('role', 'listitem');
      it.onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) { return; } memAct(b.dataset.c, { id: m.id }); it.remove(); };
      list.appendChild(it);
    }
    sec.appendChild(list);
    body.appendChild(sec);
    void d;
  }

  /** Context sets in Trash (CONTEXT). */
  function ctxTrash(body, sets) {
    const sec = el('section', 'cp-sec', `<h3>Context sets <span class="cp-count">${sets.length}</span></h3>`);
    const list = el('div', 'cp-list'); list.setAttribute('role', 'list');
    for (const x of sets) {
      const it = row('', `<span class="cp-main"><span class="cp-name">${esc(x.name)}</span><span class="cp-meta">${(x.items || []).length} item${(x.items || []).length === 1 ? '' : 's'} · deleted ${when(x.trashedAt)}</span></span><span class="cp-ra"><button class="btn sm" data-c="restore" title="Restore" aria-label="Restore ${esc(x.name)}">${I.restore}<span>Restore</span></button><button class="btn sm ghost danger" data-c="purge" title="Delete permanently" aria-label="Delete ${esc(x.name)} permanently">${I.trash}</button></span>`);
      it.setAttribute('role', 'listitem');
      it.onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) { return; } post({ type: 'contextAction', action: b.dataset.c === 'restore' ? 'restore' : 'purge', id: x.id }); it.remove(); };
      list.appendChild(it);
    }
    sec.appendChild(list);
    body.appendChild(sec);
  }

  const FIELD = { title: 'Title', pinned: 'Pinned', favorite: 'Favorite', archived: 'Archived', tags: 'Tags', activeBranchId: 'Branch', model: 'Model', mode: 'Mode', summary: 'Summary', projectId: 'Project', mergedFrom: 'Merged' };
  function describe(v) {
    if (v.op === 'trash') { return 'Moved to Trash'; }
    if (v.op === 'restore') { return 'Restored from Trash'; }
    if (v.op === 'purge') { return 'Deleted permanently'; }
    const f = v.fields || {};
    if (v.op === 'create') { return `Created${typeof f.title === 'string' ? ` · “${esc(f.title)}”` : ''}`; }
    const parts = Object.keys(f).filter((k) => FIELD[k]).map((k) => {
      const x = f[k];
      if (k === 'title') { return `Title → “${esc(x)}”`; }
      if (k === 'tags') { return `Tags ${Object.entries(x || {}).map(([t, on]) => `${on ? '+' : '−'}${esc(t)}`).join(' ')}`; }
      if (typeof x === 'boolean') { return `${FIELD[k]} ${x ? 'on' : 'off'}`; }
      if (k === 'activeBranchId') { return 'Switched branch'; }
      return FIELD[k];
    });
    return parts.length ? parts.join(' · ') : 'Activity (messages, usage)';
  }
  function versions(d) {
    const body = frame('Versions', esc(d.title || ''));
    const br = d.branches || [];
    const active = br.length ? (d.active || '') : '';
    const bsec = el('section', 'cp-sec', `<h3>Branches <span class="cp-count">${br.length}</span></h3><p class="cp-note">An edited or regenerated message starts a branch; nothing is overwritten. Switching changes what the chat shows.</p>`);
    const bl = el('div', 'cp-list');
    br.slice().reverse().forEach((b, i) => {
      const name = b.label || (b.reason ? { edit: 'Edited message', regenerate: 'Regenerated answer', continue: 'Continued from a message', 'device-split': 'Continued on another device', 'restore-version': 'Restored version', manual: 'Branch' }[b.reason] || b.reason : 'Main');
      const it = row('', `<span class="cp-main"><span class="cp-name">${esc(name)}</span><span class="cp-meta">${when(b.createdAt)}${i === 0 && br.length > 1 ? ' · newest' : ''}</span></span><span class="cp-ra"><button class="btn sm" data-c="switch" title="Show this branch in the chat" aria-label="Show this branch">${I.branch}<span>Show</span></button><button class="btn sm ghost" data-c="rename" title="Rename branch" aria-label="Rename branch">${I.rename}</button></span>`);
      it.onclick = (e) => { const x = e.target.closest('[data-c]'); if (!x) { return; } post({ type: 'branch', sessionId: d.id, action: x.dataset.c === 'switch' ? 'switch' : 'rename', branchId: b.id }); if (x.dataset.c === 'switch') { close(false); } };
      bl.appendChild(it);
    });
    bsec.appendChild(bl);
    const vsec = el('section', 'cp-sec', '<h3>History</h3><p class="cp-note">Restore puts an earlier title and flags back as a new change; the newer values stay in this list.</p>');
    const vl = el('div', 'cp-list');
    const vs = (d.versions || []).filter((v) => v.op !== 'patch' || Object.keys(v.fields || {}).some((k) => FIELD[k]));
    for (const v of vs.slice(0, 200)) {
      const restorable = v.op === 'create' || Object.keys(v.fields || {}).some((k) => ['title', 'pinned', 'favorite', 'archived', 'tags', 'activeBranchId'].includes(k));
      const it = row('', `<span class="cp-main"><span class="cp-name">${describe(v)}</span><span class="cp-meta">${when(v.at)}${v.device ? ` · ${esc(String(v.device).replace(/^dev_/, '').slice(0, 8))}` : ''}</span></span>${restorable ? '<span class="cp-ra"><button class="btn sm ghost" data-c="restore">Restore</button></span>' : ''}`);
      it.onclick = (e) => { if (e.target.closest('[data-c="restore"]')) { post({ type: 'restoreVersion', ent: 'conversation', id: d.id, hlc: v.hlc }); } };
      vl.appendChild(it);
    }
    if (!vs.length) { vl.appendChild(el('div', 'cp-empty', 'No changes recorded yet.')); }
    vsec.appendChild(vl);
    void active;
    body.append(bsec, vsec);
  }

  // ---- Memory manager (MEMORY, design §7 / §16.2): six types, list, New, Edit, Move to type, Local only, Pin,
  // Versions with a line diff, Trash. Project and developer notes open in the editor (their files are the surface).
  const MEM_TYPES = [['project', 'Project'], ['developer', 'Developer'], ['conversation', 'Conversation'], ['task', 'Task'], ['knowledge', 'Knowledge'], ['agent', 'Agent']];
  const MEM_LABEL = Object.fromEntries(MEM_TYPES);
  const FILE_TYPES = new Set(['project', 'developer']);
  function memAct(action, extra) { post({ type: 'memoryAction', action, ...extra }); }
  function expiresIn(t) { const d = Math.ceil((t - Date.now()) / 86400e3); return d <= 0 ? 'expired' : `expires in ${d} day${d === 1 ? '' : 's'}`; }
  function memory(d) {
    if (cur.params.view === 'edit') { return memEditor(d); }
    if (cur.params.view === 'versions' && cur.versions) { return memVersions(d); }
    const items = d.items || [];
    const counts = d.counts || {};
    const sel = cur.params.type || (items.length && !counts.project && counts.developer ? 'developer' : 'project');
    cur.params.type = sel;
    const info = (d.types || []).find((t) => t.id === sel) || { description: '' };
    const body = frame('Memory', `${items.length} note${items.length === 1 ? '' : 's'}${d.all ? ' · all projects' : ' · this project and yours'}`, `<button class="btn sm" data-c="new" title="New note" aria-label="New note">${I.plus}<span>New</span></button><button class="btn sm ghost" data-c="settings" title="Memory settings" aria-label="Memory settings">${I.gear}</button>`);
    root.querySelector('[data-c="settings"]').onclick = () => { post({ type: 'openSettings', section: 'memory' }); close(false); };
    root.querySelector('[data-c="new"]').onclick = () => { cur.params.view = 'edit'; cur.edit = { type: FILE_TYPES.has(sel) || sel === 'agent' ? (sel === 'agent' ? 'knowledge' : sel) : sel, name: '', body: '' }; memory(d); };
    if (d.enabled === false) { body.appendChild(el('p', 'cp-note mm-warn', `${I.warn}<span>Memory is turned off (Settings → Memory): notes are kept but not given to the agent.</span>`)); }
    const tabs = el('div', 'cp-tabs', `${MEM_TYPES.map(([k, l]) => `<button class="vchip${sel === k ? ' on' : ''}" data-t="${k}" aria-pressed="${sel === k}">${l}<i>${counts[k] || 0}</i></button>`).join('')}<select class="cp-tsel" aria-label="Memory type">${MEM_TYPES.map(([k, l]) => `<option value="${k}"${sel === k ? ' selected' : ''}>${l} (${counts[k] || 0})</option>`).join('')}</select>`);
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Memory type');
    tabs.onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { cur.params.type = b.dataset.t; cur.open = null; memory(d); } };
    tabs.onchange = (e) => { cur.params.type = e.target.value; cur.open = null; memory(d); };
    body.appendChild(tabs);
    const head = el('div', 'mm-head', `<p class="cp-note">${esc(info.description || '')}${FILE_TYPES.has(sel) ? ` <a class="lnk" data-c="folder" role="button" tabindex="0">Open folder</a>` : ''}</p><input class="mm-search" type="search" placeholder="Filter ${esc((MEM_LABEL[sel] || '').toLowerCase())} notes" aria-label="Filter notes" value="${esc(cur.q || '')}"><label class="mm-all"><input type="checkbox" data-c="all"${d.all ? ' checked' : ''}> All projects</label>`);
    body.appendChild(head);
    const fl = head.querySelector('[data-c="folder"]'); if (fl) { fl.onclick = () => memAct('openFolder', { to: sel }); fl.onkeydown = (e) => { if (e.key === 'Enter') { fl.click(); } }; }
    head.querySelector('[data-c="all"]').onchange = (e) => { cur.params.all = e.target.checked; request(); };
    const list = el('div', 'cp-list'); list.setAttribute('role', 'list');
    body.appendChild(list);
    const draw = () => {
      const q = (cur.q || '').toLowerCase();
      const shown = items.filter((x) => x.type === sel && (!q || `${x.name} ${x.summary || ''} ${x.body || ''}`.toLowerCase().includes(q)));
      list.innerHTML = '';
      if (!shown.length) { list.appendChild(el('div', 'cp-empty', `${I.memory}<p>${q ? `No ${esc((MEM_LABEL[sel] || '').toLowerCase())} notes match.` : `No ${esc((MEM_LABEL[sel] || '').toLowerCase())} notes yet.`}</p><p class="cp-note">${esc(MEM_EMPTY[sel] || '')}</p>`)); return; }
      for (const m of shown) { list.appendChild(memRow(m, d)); }
    };
    const search = head.querySelector('.mm-search');
    search.oninput = () => { cur.q = search.value; draw(); };
    draw();
  }
  const MEM_EMPTY = {
    project: 'The agent saves facts about this project here with memory_save (build commands, conventions, decisions). The files are in .localpilot/memory — commit them to share with your team.',
    developer: 'Your preferences and habits, for every project ("I prefer pnpm", "answer briefly"). Ask the agent to remember them, or add one with New.',
    conversation: 'A summary of each long chat is kept here automatically (after a compaction or every 20 messages). Use "Remember in this chat" on a message to add one.',
    task: 'The checklist of a plan or todo list while it runs; it moves to Trash some days after every item is done (Settings → Memory).',
    knowledge: 'Reference material you want at hand: use "Save to knowledge" on a message, or New. The agent reads it when asked (#memory:name) or when memory_search finds it.',
    agent: 'Lessons the agent learned: pitfalls and their fixes, and what fixed which kind of failure. Listed by name in the prompt; the agent reads them when relevant.',
  };
  function memScope(m, d) {
    if (m.type === 'conversation') { return m.conversationId ? `chat “${esc((d.titles || {})[m.conversationId] || 'untitled')}”` : 'a chat'; }
    if (m.type === 'task') { return m.taskRef ? esc(String(m.taskRef).replace(/^plan:/, 'plan ').replace(/^todos:.*/, 'todo list')) : 'a task'; }
    if (m.type === 'project') { return m.file ? esc(m.file) : 'this project'; }
    if (m.type === 'developer') { return 'every project'; }
    return m.projectId ? 'this project' : 'every project';
  }
  function memRow(m, d) {
    const badges = [m.pinned ? '<span class="cp-tag">pinned</span>' : '', m.localOnly ? '<span class="cp-tag" title="Never sent to a cloud model">local only</span>' : '', m.expiresAt ? `<span class="cp-tag${m.expired ? ' warn' : ''}">${esc(expiresIn(m.expiresAt))}</span>` : '', m.source === 'auto' ? '<span class="cp-tag">auto</span>' : ''].join(' ');
    const it = row('mm-row', `<span class="cp-main"><span class="cp-name">${esc(m.name)} ${badges}</span><span class="cp-meta">${esc(m.summary || '')}</span><span class="cp-meta">${memScope(m, d)} · updated ${when(m.updatedAt)}</span></span><span class="cp-ra"><button class="btn sm ghost" data-c="edit" title="${FILE_TYPES.has(m.type) && m.path ? 'Open the note file' : 'Edit'}" aria-label="Edit ${esc(m.name)}">${I.edit}<span>Edit</span></button><button class="btn sm ghost" data-c="more" title="More actions" aria-label="More actions for ${esc(m.name)}" aria-expanded="${cur.open === m.id}">${I.list}</button></span>`);
    it.setAttribute('role', 'listitem');
    const wrap = el('div', 'mm-item'); wrap.appendChild(it);
    if (cur.open === m.id) {
      const acts = el('div', 'mm-acts', `<label class="mm-move"><span>Move to</span> <select data-c="move" aria-label="Move to type"><option value="">type…</option>${MEM_TYPES.filter(([k]) => k !== m.type).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label><button class="btn sm ghost" data-c="local" aria-pressed="${!!m.localOnly}" title="${m.localOnly ? 'Local only is on: never sent to a cloud model' : 'Local only: never send this note to a cloud model'}" aria-label="Local only">${m.localOnly ? I.check : I.key}<span>Local only</span></button><button class="btn sm ghost" data-c="pin" aria-pressed="${!!m.pinned}" title="${m.pinned ? 'Unpin' : 'Pin: listed first'}" aria-label="${m.pinned ? 'Unpin' : 'Pin'}">${I.pin}<span>${m.pinned ? 'Unpin' : 'Pin'}</span></button><button class="btn sm ghost" data-c="versions" title="Versions" aria-label="Versions">${I.history}<span>Versions</span></button>${FILE_TYPES.has(m.type) && m.path ? `<button class="btn sm ghost" data-c="open" title="Open file" aria-label="Open file">${I.open}<span>Open file</span></button>` : ''}<button class="btn sm ghost danger" data-c="trash" title="Move to Trash" aria-label="Move to Trash">${I.trash}<span>Move to Trash</span></button>`);
      acts.setAttribute('role', 'group'); acts.setAttribute('aria-label', `Actions for ${m.name}`);
      wrap.appendChild(acts);
      acts.querySelector('[data-c="move"]').onchange = (e) => { if (e.target.value) { memAct('move', { id: m.id, to: e.target.value }); busy(acts); } };
    }
    wrap.onclick = (e) => {
      const b = e.target.closest('[data-c]'); if (!b || b.tagName === 'SELECT') { return; }
      const c = b.dataset.c;
      if (c === 'more') { cur.open = cur.open === m.id ? null : m.id; rerender(); return; }
      if (c === 'edit') { if (FILE_TYPES.has(m.type) && m.path) { memAct('open', { id: m.id }); } else { cur.params.view = 'edit'; cur.edit = { id: m.id, type: m.type, name: m.name, body: m.body || '', fileBacked: FILE_TYPES.has(m.type) }; rerender(); } return; }
      if (c === 'open') { memAct('open', { id: m.id }); return; }
      if (c === 'local') { memAct('localOnly', { id: m.id, on: !m.localOnly }); busy(b.parentNode); return; }
      if (c === 'pin') { memAct('pin', { id: m.id, on: !m.pinned }); busy(b.parentNode); return; }
      if (c === 'versions') { cur.versionsOf = m; memAct('versions', { id: m.id }); return; }
      if (c === 'trash') { memAct('trash', { id: m.id }); wrap.classList.add('mm-gone'); return; }
    };
    return wrap;
  }
  function busy(n) { if (n) { n.classList.add('mm-busy'); } }
  function rerender() { if (cur && cur.data) { memory(cur.data); } }
  function memEditor(d) {
    const e = cur.edit || { type: 'knowledge', name: '', body: '' };
    const isNew = !e.id;
    const body = frame(isNew ? 'New memory note' : `Edit “${e.name}”`, isNew ? '' : esc(MEM_LABEL[e.type] || e.type));
    root.querySelector('.cp-back').onclick = () => subBack();
    const types = MEM_TYPES.filter(([k]) => k !== 'agent' || !isNew);
    const form = el('form', 'mm-form', `${isNew ? `<label>Type <select name="type">${types.map(([k, l]) => `<option value="${k}"${e.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label><p class="cp-note mm-tdesc"></p>` : ''}<label>Name <input name="name" required maxlength="80" value="${esc(e.name)}"${!isNew && e.fileBacked ? ' disabled' : ''} placeholder="${isNew ? 'e.g. api-conventions' : ''}"></label><label>Text <textarea name="body" rows="10" required placeholder="Markdown; short bullets work best">${esc(e.body)}</textarea></label>${isNew ? '<label class="mm-check"><input type="checkbox" name="localOnly"> Local only: never send to a cloud model</label>' : ''}<div class="mm-btns"><button type="button" class="btn sm ghost" data-c="cancel">Cancel</button><button type="submit" class="btn sm">${I.check}<span>Save</span></button></div>`);
    body.appendChild(form);
    const tsel = form.querySelector('select[name="type"]'); const tdesc = form.querySelector('.mm-tdesc');
    const syncDesc = () => { if (tsel && tdesc) { const t = (d.types || []).find((x) => x.id === tsel.value); tdesc.textContent = t ? t.description : ''; } };
    if (tsel) { tsel.onchange = syncDesc; syncDesc(); }
    form.querySelector('[data-c="cancel"]').onclick = () => { cur.params.view = 'list'; cur.edit = null; rerender(); };
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const fields = { name: String(fd.get('name') || e.name || '').trim(), body: String(fd.get('body') || ''), ...(isNew ? { type: String(fd.get('type') || e.type), localOnly: fd.get('localOnly') === 'on' } : {}) };
      if (!fields.name || !fields.body.trim()) { return; }
      form.querySelector('[type="submit"]').disabled = true;
      cur.pendingType = fields.type || e.type;
      memAct(isNew ? 'create' : 'update', { id: e.id, fields });
    };
    setTimeout(() => { const f = form.querySelector(isNew ? 'input[name="name"]' : 'textarea'); if (f) { f.focus(); } }, 0);
  }
  /** Line diff (LCS) of two texts: [{ op: ' ' | '+' | '-', text }]. Small notes only (capped). */
  function lineDiff(a, b) {
    const x = String(a || '').split('\n').slice(0, 400); const y = String(b || '').split('\n').slice(0, 400);
    const n = x.length; const m = y.length; const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) { for (let j = m - 1; j >= 0; j--) { L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]); } }
    const out = []; let i = 0; let j = 0;
    while (i < n && j < m) { if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: '-', text: x[i++] }); } else { out.push({ op: '+', text: y[j++] }); } }
    while (i < n) { out.push({ op: '-', text: x[i++] }); } while (j < m) { out.push({ op: '+', text: y[j++] }); }
    return out;
  }
  function memVersions(d) {
    const v = cur.versions; const m = cur.versionsOf || {};
    const body = frame(`Versions of “${v.name}”`, `${esc(MEM_LABEL[v.itemType] || v.itemType)} · ${v.versions.length} change${v.versions.length === 1 ? '' : 's'}`);
    root.querySelector('.cp-back').onclick = () => subBack();
    body.appendChild(el('p', 'cp-note', 'Each save is kept. Pick one to see what changed against the note now; Restore puts its text back as a new change.'));
    const current = (d.items || []).find((x) => x.id === v.id) || m;
    const withBody = v.versions.filter((x) => x.body !== undefined);
    const list = el('div', 'cp-list'); list.setAttribute('role', 'list');
    v.versions.forEach((x) => {
      const what = x.op === 'trash' ? 'Moved to Trash' : x.op === 'restore' ? 'Restored' : x.op === 'purge' ? 'Deleted' : x.op === 'create' ? 'Created' : x.body !== undefined ? 'Text changed' : (x.changes || []).map((k) => ({ localOnly: 'Local only', pinned: 'Pin', name: 'Renamed', expiresAt: 'Expiry', type: 'Type' }[k] || k)).join(' · ') || 'Changed';
      const it = row(cur.vsel === x.hlc ? 'on' : '', `<span class="cp-main"><span class="cp-name">${esc(what)}</span><span class="cp-meta">${when(x.at)} · ${esc(String(x.device || '').replace(/^dev_/, '').slice(0, 8))}</span></span>${x.body !== undefined ? '<span class="cp-ra"><button class="btn sm ghost" data-c="show">Compare</button><button class="btn sm ghost" data-c="restore">Restore</button></span>' : ''}`);
      it.setAttribute('role', 'listitem');
      it.onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) { return; } if (b.dataset.c === 'show') { cur.vsel = x.hlc; memVersions(d); } else { memAct('restoreVersion', { id: v.id, hlc: x.hlc }); b.disabled = true; } };
      list.appendChild(it);
    });
    if (!v.versions.length) { list.appendChild(el('div', 'cp-empty', 'No changes recorded yet.')); }
    body.appendChild(list);
    const pick = withBody.find((x) => x.hlc === cur.vsel);
    if (pick) {
      const diff = lineDiff(pick.body, current.body);
      const sec = el('section', 'cp-sec', `<h3>That version → now</h3>`);
      const pre = el('pre', 'mm-diff'); pre.setAttribute('aria-label', 'Line changes from that version to the current text');
      pre.innerHTML = diff.map((l) => `<span class="dl ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}"><i aria-hidden="true">${l.op === ' ' ? '&nbsp;' : l.op}</i>${esc(l.text) || '&nbsp;'}</span>`).join('');
      if (diff.every((l) => l.op === ' ')) { sec.appendChild(el('p', 'cp-note', 'Same text as now.')); } else { sec.appendChild(pre); }
      body.appendChild(sec);
    }
  }
  // ---- Context library and "Context of this chat" (CONTEXT, design §8 / §16.2): named context sets attached with
  // #context:<name>, and what the model saw on each request of this chat (items, excluded, breakdown).
  const KIND = { file: 'File', glob: 'Files matching', snippet: 'Snippet', memory: 'Memory note', conversation: 'Earlier chat', url: 'Link' };
  const SNAP_KIND = { file: 'File', selection: 'Context', memory: 'Memory', rule: 'Rule', summary: 'Summary', library: 'Context set', history: 'Earlier chat', tool: 'Tool output' };
  const BD = { system: 'System prompt', rules: 'Rules', memory: 'Memory', tools: 'Tools', mcpTools: 'MCP tools', conversation: 'Conversation', files: 'Attached files', toolResults: 'Tool output', summary: 'Compaction summary' };
  const REASONS = { localOnly: 'Local only: never sent to a cloud model', budget: 'Over the memory budget: listed by name only', ignored: 'Ignored' };
  const PHASE = { turn: 'answer', 'before-compaction': 'before compaction', 'after-compaction': 'after compaction' };
  const slug = (n) => String(n || '').trim().toLowerCase().replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const tok = (n) => { const v = Number(n) || 0; return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)); };
  function ctxAct(action, extra) { post({ type: 'contextAction', action, ...extra }); }
  function context(d) {
    if (cur.params.view === 'edit' && cur.edit) { return ctxEditor(d); }
    const view = cur.params.view === 'chat' ? 'chat' : 'library';
    cur.params.view = view;
    const sets = d.sets || [];
    const body = frame('Context', view === 'chat' ? esc((d.chat && d.chat.title) || 'This chat') : `${sets.length} context set${sets.length === 1 ? '' : 's'}${d.all ? ' · all projects' : ''}`, `<button class="btn sm" data-c="new" title="New context set" aria-label="New context set">${I.plus}<span>New set</span></button>`);
    root.querySelector('[data-c="new"]').onclick = () => { cur.params.view = 'edit'; cur.edit = { name: '', description: '', items: [], localOnly: false, scope: 'project' }; context(d); };
    const tabs = el('div', 'cp-tabs', `<button class="vchip${view === 'library' ? ' on' : ''}" data-t="library" aria-pressed="${view === 'library'}">${I.layers}Library<i>${sets.length}</i></button><button class="vchip${view === 'chat' ? ' on' : ''}" data-t="chat" aria-pressed="${view === 'chat'}"${d.chat ? '' : ' disabled title="Open a chat first"'}>${I.eye || I.list}Context of this chat<i>${(d.snapshots || []).length}</i></button><select class="cp-tsel" aria-label="View"><option value="library"${view === 'library' ? ' selected' : ''}>Library (${sets.length})</option><option value="chat"${view === 'chat' ? ' selected' : ''}${d.chat ? '' : ' disabled'}>Context of this chat</option></select>`);
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Context view');
    const go = (v) => { cur.params.view = v; if (v === 'library') { delete cur.params.snapshotId; } context(d); };
    tabs.onclick = (e) => { const b = e.target.closest('[data-t]'); if (b && !b.disabled) { go(b.dataset.t); } };
    tabs.onchange = (e) => go(e.target.value);
    body.appendChild(tabs);
    if (view === 'chat') { return ctxChat(body, d); }
    const head = el('div', 'mm-head', `<p class="cp-note">Named sets of files, folders, snippets, memory notes and earlier chats. Attach one to a message with <code>#context:name</code>, or with <b>Attach</b> here.</p><label class="mm-all"><input type="checkbox" data-c="all"${d.all ? ' checked' : ''}> All projects</label>`);
    body.appendChild(head);
    head.querySelector('[data-c="all"]').onchange = (e) => { cur.params.all = e.target.checked; request(); };
    const list = el('div', 'cp-list'); list.setAttribute('role', 'list');
    if (!sets.length) {
      list.appendChild(el('div', 'cp-empty', `${I.layers}<p>No context sets yet.</p><p class="cp-note">Keep the files and notes you attach again and again as a set: <b>New set</b>${d.chat && (d.chat.files || []).length ? ', or start from the files of this chat' : ''}.</p>${d.chat && (d.chat.files || []).length ? '<button class="btn sm" data-c="fromchat">New from this chat</button>' : ''}`));
      const fc = list.querySelector('[data-c="fromchat"]'); if (fc) { fc.onclick = () => { cur.params.view = 'edit'; cur.edit = { name: '', description: '', items: (d.chat.files || []).map((f) => ({ kind: 'file', ref: f })), localOnly: false, scope: 'project' }; context(d); }; }
    }
    for (const x of sets) {
      const badges = [x.localOnly ? '<span class="cp-tag" title="Never sent to a cloud model">local only</span>' : '', x.projectId ? '' : '<span class="cp-tag" title="Available in every project">all projects</span>'].filter(Boolean).join(' ');
      const kinds = [...new Set((x.items || []).map((i) => KIND[i.kind] || i.kind))].join(', ');
      const n = (x.items || []).length;
      const it = row('', `<span class="cp-main"><span class="cp-name" title="${esc(x.name)}">${esc(x.name)}</span><span class="cp-meta" title="${esc(kinds)}">${badges ? `${badges} ` : ''}<code>#context:${esc(slug(x.name))}</code> · ${n} item${n === 1 ? '' : 's'} · ${when(x.updatedAt)}</span>${x.description ? `<span class="cp-meta">${esc(x.description)}</span>` : ''}</span><span class="cp-ra"><button class="btn sm" data-c="attach" title="Attach to the message you are writing" aria-label="Attach ${esc(x.name)} to the chat">${I.plus}<span>Attach</span></button><button class="btn sm ghost" data-c="edit" title="Edit" aria-label="Edit ${esc(x.name)}">${I.edit}</button><button class="btn sm ghost danger" data-c="trash" title="Move to Trash" aria-label="Move ${esc(x.name)} to Trash">${I.trash}</button></span>`);
      it.setAttribute('role', 'listitem');
      it.onclick = (e) => {
        const b = e.target.closest('[data-c]'); if (!b) { return; }
        if (b.dataset.c === 'attach') { ctxAct('attach', { id: x.id }); close(false); }
        else if (b.dataset.c === 'edit') { cur.params.view = 'edit'; cur.edit = { id: x.id, name: x.name, description: x.description || '', items: (x.items || []).map((i) => ({ ...i })), localOnly: !!x.localOnly, scope: x.projectId ? 'project' : 'user' }; context(d); }
        else if (b.dataset.c === 'trash') { ctxAct('trash', { id: x.id }); it.classList.add('mm-gone'); }
      };
      list.appendChild(it);
    }
    body.appendChild(list);
  }
  function ctxEditor(d) {
    const e = cur.edit; const isNew = !e.id;
    const body = frame(isNew ? 'New context set' : `Edit “${e.name}”`, '');
    root.querySelector('.cp-back').onclick = () => { cur.params.view = 'library'; cur.edit = null; context(d); };
    const kinds = d.kinds || Object.keys(KIND);
    const form = el('form', 'mm-form cx-form', `<label>Name <input name="name" required maxlength="80" value="${esc(e.name)}" placeholder="e.g. release-process"></label><p class="cp-note cx-slug"></p><label>Description <input name="description" maxlength="200" value="${esc(e.description || '')}" placeholder="What the set is for (optional)"></label><fieldset class="cx-items"><legend>Items</legend><div class="cx-list"></div><div class="cx-add"><select aria-label="Kind of item to add">${kinds.map((k) => `<option value="${k}">${esc(KIND[k] || k)}</option>`).join('')}</select><button type="button" class="btn sm" data-c="add">${I.plus}<span>Add item</span></button>${d.chat && (d.chat.files || []).length ? `<button type="button" class="btn sm ghost" data-c="fromchat" title="Add the files attached to this chat and its working files">Add files of this chat (${d.chat.files.length})</button>` : ''}</div></fieldset><label>Available in <select name="scope"><option value="project"${e.scope !== 'user' ? ' selected' : ''}>This project</option><option value="user"${e.scope === 'user' ? ' selected' : ''}>Every project</option></select></label><label class="mm-check"><input type="checkbox" name="localOnly"${e.localOnly ? ' checked' : ''}> Local only: never sent to a cloud model</label><div class="mm-btns"><button type="button" class="btn" data-c="cancel">Cancel</button><button type="submit" class="btn primary">${isNew ? 'Create' : 'Save'}</button></div>`);
    body.appendChild(form);
    const listEl = form.querySelector('.cx-list');
    const PH = { file: 'src/app.ts', glob: 'src/**/*.test.ts', snippet: 'A name for the snippet', memory: 'note-name', conversation: 'Conversation title or id', url: 'https://…' };
    const draw = () => {
      listEl.innerHTML = e.items.length ? '' : '<p class="cp-note">No items yet: add files, folders (as a glob such as <code>docs/**</code>), snippets, memory notes or earlier chats.</p>';
      e.items.forEach((it, i) => {
        const r = el('div', `cx-item${it.kind === 'snippet' ? ' snip' : ''}`, `<span class="cx-kind">${esc(KIND[it.kind] || it.kind)}</span><input class="cx-ref" value="${esc(it.ref || '')}" placeholder="${esc(PH[it.kind] || '')}" aria-label="${esc(KIND[it.kind] || it.kind)} ${i + 1}">${it.kind === 'snippet' ? `<textarea class="cx-text" rows="3" aria-label="Snippet text ${i + 1}" placeholder="The text to include">${esc(it.text || '')}</textarea>` : ''}<button type="button" class="x" data-rm="${i}" aria-label="Remove item ${i + 1}" title="Remove">×</button>`);
        r.querySelector('.cx-ref').oninput = (ev) => { it.ref = ev.target.value; };
        const t = r.querySelector('.cx-text'); if (t) { t.oninput = (ev) => { it.text = ev.target.value; }; }
        listEl.appendChild(r);
      });
    };
    listEl.onclick = (ev) => { const b = ev.target.closest('[data-rm]'); if (b) { e.items.splice(Number(b.dataset.rm), 1); draw(); } };
    const nameIn = form.querySelector('input[name="name"]'); const slugEl = form.querySelector('.cx-slug');
    const syncSlug = () => { slugEl.innerHTML = nameIn.value.trim() ? `Attach with <code>#context:${esc(slug(nameIn.value))}</code>` : ''; e.name = nameIn.value; };
    nameIn.oninput = syncSlug; syncSlug();
    form.querySelector('input[name="description"]').oninput = (ev) => { e.description = ev.target.value; };
    form.querySelector('[data-c="add"]').onclick = () => { e.items.push({ kind: form.querySelector('.cx-add select').value, ref: '' }); draw(); const ins = listEl.querySelectorAll('.cx-ref'); if (ins.length) { ins[ins.length - 1].focus(); } };
    const fc = form.querySelector('[data-c="fromchat"]'); if (fc) { fc.onclick = () => { for (const f of d.chat.files) { if (!e.items.some((x) => x.kind === 'file' && x.ref === f)) { e.items.push({ kind: 'file', ref: f }); } } draw(); }; }
    form.querySelector('[data-c="cancel"]').onclick = () => { cur.params.view = 'library'; cur.edit = null; context(d); };
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const fields = { name: String(fd.get('name') || '').trim(), description: String(fd.get('description') || ''), items: e.items.filter((x) => (x.ref || '').trim() || (x.kind === 'snippet' && (x.text || '').trim())), localOnly: fd.get('localOnly') === 'on', scope: fd.get('scope') === 'user' ? 'user' : 'project' };
      if (!fields.name) { nameIn.focus(); return; }
      form.querySelector('[type="submit"]').disabled = true;
      ctxAct(isNew ? 'create' : 'update', { id: e.id, fields });
    };
    draw();
    setTimeout(() => nameIn.focus(), 0);
  }
  function ctxChat(body, d) {
    const s = d.snapshot; const snaps = d.snapshots || [];
    if (!s) { body.appendChild(el('div', 'cp-empty', `${I.eye || I.list}<p>Nothing recorded for this chat yet.</p><p class="cp-note">What the model sees is recorded with every answer from LocalPilot 1.7 on: the files, memory, rules and summaries in the request, and what was left out.</p>`)); return; }
    if (snaps.length > 1) {
      const sel = el('label', 'cx-pick', `<span>Request</span><select aria-label="Which request">${snaps.map((x) => `<option value="${esc(x.id)}"${x.id === s.id ? ' selected' : ''}>${esc(new Date(x.at).toLocaleString())} · ${esc(String(x.model || '').split('/').pop())} · ${tok(x.usedTokens)} · ${esc(PHASE[x.phase] || x.phase)}</option>`).join('')}</select>`);
      sel.querySelector('select').onchange = (e) => { cur.params.snapshotId = e.target.value; request(); };
      body.appendChild(sel);
    }
    const pct = s.window ? Math.round((Number(s.usedTokens || 0) / s.window) * 100) : 0;
    body.appendChild(el('p', 'cp-note', `${esc(String(s.model || '').split('/').pop())}${s.remote ? ' (cloud)' : ' (local)'} · ${tok(s.usedTokens)} of ${tok(s.window)} tokens (${pct}%) · ${when(s.createdAt)}${s.phase && s.phase !== 'turn' ? ` · ${esc(PHASE[s.phase])}` : ''}`));
    const b = s.breakdown;
    if (b) {
      const keys = Object.keys(BD).filter((k) => Number(b[k]) > 0).sort((x, y) => b[y] - b[x]);
      const sec = el('section', 'cp-sec', '<h3>What filled the window</h3>');
      const bl = el('div', 'cx-bars');
      for (const k of keys) { const w = Math.max(1, Math.min(100, Math.round((b[k] / Math.max(1, s.window)) * 100))); bl.appendChild(el('div', 'cx-bar', `<span class="k">${esc(BD[k])}</span><b>${tok(b[k])}</b><i style="--w:${w}%" aria-hidden="true"></i>`)); }
      sec.appendChild(bl); body.appendChild(sec);
    }
    const items = s.items || [];
    const isec = el('section', 'cp-sec', `<h3>Items <span class="cp-count">${items.length}</span></h3>`);
    const il = el('div', 'cp-list'); il.setAttribute('role', 'list');
    for (const it of items) {
      const r = row('', `<span class="cp-main"><span class="cp-name">${esc(it.ref)}</span><span class="cp-meta">${esc(SNAP_KIND[it.kind] || it.kind)}${it.hash ? ` · sha256 ${esc(it.hash.slice(0, 12))}…` : ''}</span></span><span class="cx-tok">${it.tokens ? tok(it.tokens) : '—'}</span>`);
      r.setAttribute('role', 'listitem'); il.appendChild(r);
    }
    if (!items.length) { il.appendChild(el('div', 'cp-empty', 'Only the conversation itself.')); }
    isec.appendChild(il); body.appendChild(isec);
    const ex = s.excluded || [];
    const xsec = el('section', 'cp-sec', `<h3>Excluded <span class="cp-count">${ex.length}</span></h3>`);
    const xl = el('div', 'cp-list');
    for (const x of ex) { xl.appendChild(row('', `<span class="cp-main"><span class="cp-name">${esc(x.ref)}</span><span class="cp-meta">${esc(REASONS[x.reason] || x.reason)}</span></span>`)); }
    if (!ex.length) { xl.appendChild(el('p', 'cp-note', 'Nothing was left out of this request.')); }
    xsec.appendChild(xl); body.appendChild(xsec);
    const c = s.compaction;
    const ws = s.workingSet || []; const td = s.todos || [];
    const msec = el('section', 'cp-sec', '<h3>State kept with it</h3>');
    msec.appendChild(el('p', 'cp-note', `${ws.length} working file${ws.length === 1 ? '' : 's'}${td.length ? ` · ${td.filter((t) => t.status === 'done').length}/${td.length} todos done` : ''}${(s.attachments || []).length ? ` · ${s.attachments.length} attachment${s.attachments.length === 1 ? '' : 's'}` : ''}${c ? ` · compaction: ${c.summarized || 0} messages summarised, ${c.kept || 0} kept` : ''}. A chat reopened after a restart or on another device gets these back; files changed since are marked.`));
    body.appendChild(msec);
  }
  // ---- Checkpoints (SESSION): the checkpoint taken before each agent turn, per project, newest first.
  const CP_KIND = { stash: 'git snapshot', commit: 'git snapshot (clean tree)', files: 'file snapshots' };
  const CP_RESTORE = [['both', 'Files and chat', 'Put the files and the chat back as they were before this turn'], ['workspace', 'Files only', 'Put the files back; keep the chat'], ['task', 'Chat only', 'Rewind the chat to this turn; keep the files']];
  function cpAct(action, r, extra) { post({ type: 'checkpointAction', action, sessionId: r.conversationId, run: r.run, ...(extra || {}) }); }
  function checkpoints(d) {
    const rows = d.rows || [];
    const scope = d.all ? 'every project' : 'this project';
    const body = frame('Checkpoints', rows.length ? `${rows.length}${d.total > rows.length ? ` of ${d.total}` : ''} in ${scope}` : '', d.project ? `<button class="btn sm ghost" data-c="scope" aria-pressed="${!!d.all}" title="${d.all ? 'Show this project only' : 'Show every project'}">${I.layers || ''}<span>${d.all ? 'This project' : 'All projects'}</span></button>` : '');
    root.querySelector('[data-c="scope"]')?.addEventListener('click', () => { cur.params = { ...cur.params, all: !d.all }; request(); });
    if (!rows.length) { body.innerHTML = `<div class="cp-empty">${I.restore}<p>No checkpoints in ${scope} yet.</p><p class="cp-note">A checkpoint is taken before each agent turn (Settings → Agent → Checkpoints). From here you can see what a turn changed and put the files, the chat or both back.</p></div>`; return; }
    const list = el('div', 'cp-list'); list.setAttribute('role', 'list');
    for (const r of rows) {
      const files = Array.isArray(r.files) ? r.files : [];
      const where = r.thisDevice ? '' : r.hasContent ? ` · from ${esc(r.device || 'another device')}` : ` · <span class="cp-tag warn">Content on ${esc(r.device || 'another device')}</span>`;
      const meta = `Before turn ${esc(r.run)} · ${when(r.createdAt)} · ${esc(CP_KIND[r.kind] || r.kind || 'checkpoint')}${files.length ? ` · ${files.length} file${files.length === 1 ? '' : 's'} changed` : ''}${r.restoredAt ? ` · restored ${when(r.restoredAt)}` : ''}${where}`;
      const dis = r.available ? '' : ` disabled title="${esc(r.why || 'Not available here')}"`;
      const it = el('div', 'mm-item cpk');
      it.setAttribute('role', 'listitem');
      it.innerHTML = `<div class="cp-row"><span class="cp-main"><span class="cp-name">${esc(r.title || 'New chat')}</span><span class="cp-meta">${meta}</span></span></div>${files.length ? `<details class="cpk-files"><summary>Changed files</summary><ul>${files.slice(0, 40).map((f) => `<li title="${esc(f.path)}"><b class="st st-${esc(f.status)}">${esc(f.status)}</b><span>${esc(f.path)}</span></li>`).join('')}${files.length > 40 ? `<li class="more">+${files.length - 40} more</li>` : ''}</ul></details>` : ''}<div class="mm-acts"><button class="btn sm ghost" data-c="view"${dis || ' title="Open the changes since this checkpoint in a diff"'} aria-label="View changes">${I.diff || I.open}<span>View changes</span></button><button class="btn sm ghost" data-c="restore" aria-haspopup="true" aria-expanded="false"${dis || ' title="Restore: files and chat, files only, or chat only"'} aria-label="Restore">${I.restore}<span>Restore…</span></button><button class="btn sm ghost" data-c="open" title="Open the chat" aria-label="Open chat">${I.open}<span>Open chat</span></button>${r.available || (!r.thisDevice && !r.hasContent) ? '' : `<span class="cp-note cpk-why">${esc(r.why || '')}</span>`}</div>`;
      it.onclick = (e) => {
        const b = e.target.closest('[data-c]'); if (!b || b.disabled) { return; }
        const c = b.dataset.c;
        if (c === 'open') { cpAct('open', r); close(false); return; }
        if (c === 'view') { cpAct('view', r); return; }
        if (c === 'restore') {
          const open = it.querySelector('.cpk-pick');
          if (open) { open.remove(); b.setAttribute('aria-expanded', 'false'); return; }
          const pick = el('div', 'cpk-pick', CP_RESTORE.map(([k, l, t]) => `<button class="btn sm${k === 'both' ? '' : ' ghost'}" data-r="${k}" title="${esc(t)}">${esc(l)}</button>`).join(''));
          pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', 'Restore what');
          pick.onclick = (ev) => { const x = ev.target.closest('[data-r]'); if (!x) { return; } ev.stopPropagation(); pick.remove(); b.setAttribute('aria-expanded', 'false'); cpAct('restore', r, { restoreType: x.dataset.r }); };
          it.appendChild(pick); b.setAttribute('aria-expanded', 'true');
          const f = pick.querySelector('button'); if (f) { f.focus(); }
        }
      };
      list.appendChild(it);
    }
    body.appendChild(list);
    body.appendChild(el('p', 'cp-note', 'Restore asks before it changes anything; in a git repository your current state is saved in git stash first. A checkpoint taken on another device lists its files here; its content stays there unless sync carries checkpoint contents.'));
  }
  // ---- Sync manager (SYNC): status, queue, Sync now / Pause, conflicts, devices, what syncs, activity, keys.
  const SYNC_LINE = { off: 'Sync is off', idle: 'Up to date', syncing: 'Syncing…', offline: 'Offline', paused: 'Paused', error: 'Sync failed', unavailable: 'Sync is not available' };
  const CF_KIND = { field: 'Changed on two devices', 'text-merge': 'Edited on two devices', 'branch-split': 'Continued on two devices', 'trash-vs-edit': 'Deleted on one device, edited on another', 'remote-damaged': 'Damaged on the storage', 'clock-skew': 'Clock ahead' };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function syncDot(st) { return st.state === 'off' || st.state === 'unavailable' ? 'off' : st.conflicts || st.state === 'error' || st.state === 'offline' || (st.state === 'paused' && st.reason !== 'user') ? 'err' : st.state === 'syncing' ? 'busy' : st.state === 'idle' ? 'ok' : 'off'; }
  function syncAct(action, extra) { post({ type: 'syncAction', action, ...(extra || {}) }); }
  function fmtSize(b) { return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`; }
  function cfActions(c) {
    const k = c.kind;
    const b = (r, label, primary, title) => `<button class="btn sm${primary ? '' : ' ghost'}" data-r="${r}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
    if (k === 'field') { return b('ours', `Keep ${c.oursDevice}'s`, c.applied === 'ours') + b('theirs', `Keep ${c.theirsDevice}'s`, c.applied !== 'ours'); }
    if (k === 'text-merge') { return `<button class="btn sm" data-x="compare" title="Open both versions side by side">${I.compare || I.diff}<span>Compare…</span></button>` + b('ours', `Keep ${c.oursDevice}'s`) + b('theirs', `Keep ${c.theirsDevice}'s`) + b('both', 'Keep both'); }
    if (k === 'branch-split') { return b('keep-applied', 'Keep both', true, 'Both lines stay; switch between them with the branch switcher') + b('theirs', `Use ${c.theirsDevice}'s branch`); }
    if (k === 'trash-vs-edit') { return b('keep-applied', 'Keep it', true, 'It stays out of Trash with the edit') + b('theirs', 'Move to Trash again'); }
    if (k === 'remote-damaged') { return `<button class="btn sm ghost" data-x="reupload" title="Upload this device's history again">${I.refresh}<span>Re-upload from this device</span></button>` + b('keep-applied', 'Dismiss'); }
    return b('keep-applied', 'Dismiss', true);
  }
  function sync(d) {
    const st = d.status || { state: 'unavailable' };
    const busy = st.state === 'syncing';
    const configured = !!d.configured && d.enabled;
    const acts = configured ? `<button class="btn sm" data-c="now"${busy && !st.elsewhere ? ' disabled' : ''} title="Sync now">${busy ? '<span class="spinner"></span>' : I.sync}<span>Sync now</span></button>${st.state === 'paused' && st.reason === 'user' ? `<button class="btn sm ghost" data-c="resume" title="Resume automatic sync">${I.play}<span>Resume</span></button>` : `<button class="btn sm ghost" data-c="pause" title="Pause automatic sync"${st.state === 'paused' ? ' disabled' : ''}>${I.pause}<span>Pause</span></button>`}` : '';
    const sub = configured ? `${esc(SYNC_LINE[st.state] || st.state)}${st.lastSync ? ` · last ${esc(ago(st.lastSync))}` : ''}` : '';
    const body = frame('Sync', sub, acts);
    const head = root.querySelector('.cp-acts');
    if (head) { head.onclick = (e) => { const b = e.target.closest('[data-c]'); if (b && !b.disabled) { syncAct(b.dataset.c); if (b.dataset.c === 'now') { b.disabled = true; b.innerHTML = `<span class="spinner"></span><span>Sync now</span>`; } } }; }
    if (!configured) {
      const need = d.configured && !d.enabled;
      body.innerHTML = `<div class="cp-empty"><span class="sdot off" aria-hidden="true"></span><p><b>${need ? 'Sync is turned off on this device.' : 'Sync is off.'}</b> This computer (${esc((d.device && d.device.name) || '')}) keeps its conversations, memory and backups locally.</p><p class="cp-note">Sync with a folder (iCloud Drive, Dropbox, OneDrive, Google Drive), a Git repository, S3-compatible storage or WebDAV. Everything is encrypted on this device with your passphrase before it leaves; the storage only sees ciphertext.</p><div class="sy-btns"><button class="btn sm" data-c="setup">${I.sync}<span>Set up sync…</span></button><button class="btn sm ghost" data-c="settings">${I.gear}<span>Sync settings…</span></button></div></div>`;
      body.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { syncAct(b.dataset.c); if (b.dataset.c === 'settings') { close(false); } }));
      return;
    }
    // ---- status card
    const card = el('section', `cp-sec sy-status sy-${syncDot(st)}`);
    const waiting = [st.pending ? plural(st.pending, 'change') : '', st.pendingBlobs ? plural(st.pendingBlobs, 'attachment') : ''].filter(Boolean).join(' and ');
    let line = `<b>${esc(SYNC_LINE[st.state] || st.state)}</b>`;
    if (st.state === 'offline') { line += ` — ${waiting ? `${esc(waiting)} waiting` : 'nothing waiting'}; it retries on its own`; }
    else if (st.state === 'paused' && st.reason !== 'user') { line = `<b>Sync paused</b> — ${esc(st.message || st.reason || '')}`; }
    else if (st.state === 'error') { line += ` — ${esc(st.message || '')}`; }
    else if (st.state === 'syncing') { line += st.elsewhere ? ' in another window or the CLI' : ''; }
    else { line += waiting ? ` · ${esc(waiting)} waiting` : ''; }
    // Same signal as the navigator's dot: open conflicts need a choice even when everything else is up to date.
    if (st.conflicts && st.state !== 'off' && st.state !== 'unavailable') { line += ` · ${esc(plural(st.conflicts, 'conflict'))} to resolve`; }
    const fix = st.needsPassphrase || st.reason === 'passphrase' || st.reason === 'remote-replaced' ? `<button class="btn sm" data-c="unlock">${I.key}<span>Enter passphrase…</span></button>` : st.reason === 'auth' && (d.backend === 's3' || d.backend === 'webdav') ? `<button class="btn sm" data-c="setSecret">${I.key}<span>Update credentials…</span></button>` : st.state === 'paused' && st.reason !== 'user' ? `<button class="btn sm" data-c="settings">${I.gear}<span>Fix…</span></button>` : '';
    card.innerHTML = `<div class="sy-line" role="status" aria-live="polite"><span class="sdot ${syncDot(st)}" aria-hidden="true"></span><span>${line}</span></div><p class="cp-note">${esc(d.backendLabel || '')}: <span class="sy-where" title="${esc(d.label || '')}">${esc(d.label || '')}</span> · end-to-end encrypted · every ${esc(d.interval || 5)} min and after changes</p><div class="sy-btns">${fix}<button class="btn sm ghost" data-c="settings">${I.gear}<span>Sync settings…</span></button></div>`;
    card.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { syncAct(b.dataset.c); if (b.dataset.c === 'settings') { close(false); } }));
    body.appendChild(card);
    // ---- conflicts
    const cfs = d.conflicts || [];
    const cs = el('section', 'cp-sec sy-conflicts', `<h3>Conflicts <span class="cp-count">${cfs.length}</span></h3>`);
    cs.id = 'sy-conflicts';
    if (!cfs.length) { cs.appendChild(el('p', 'cp-note', 'None. When the same thing changes on two devices before they sync, it is listed here; LocalPilot keeps the later change until you choose.')); }
    const cl = el('div', 'cp-list'); cl.setAttribute('role', 'list');
    for (const c of cfs) {
      const it = el('div', 'mm-item sy-cf'); it.setAttribute('role', 'listitem');
      const what = c.label ? `${esc(c.label)}` : esc(c.entity);
      const sides = c.kind === 'field' ? `<div class="sy-sides"><div><span>${esc(c.oursDevice)}</span><code>${esc(c.ours || '—')}</code></div><div><span>${esc(c.theirsDevice)}</span><code>${esc(c.theirs || '—')}</code></div></div>` : c.kind === 'text-merge' ? `<div class="sy-sides"><div><span>${esc(c.oursDevice)}</span><pre>${esc((c.ours || '').slice(0, 240))}</pre></div><div><span>${esc(c.theirsDevice)}</span><pre>${esc((c.theirs || '').slice(0, 240))}</pre></div></div>` : '';
      it.innerHTML = `<div class="cp-row"><span class="cp-main"><span class="cp-name">${esc(CF_KIND[c.kind] || c.kind)}${c.field && c.kind === 'field' ? ` · ${esc(c.field)}` : ''}</span><span class="cp-meta">${what} · ${when(c.createdAt)}</span></span></div>${sides}<div class="mm-acts">${cfActions(c)}</div>`;
      it.onclick = (e) => {
        const r = e.target.closest('[data-r]'); const x = e.target.closest('[data-x]');
        if (r) { it.classList.add('mm-busy'); post({ type: 'resolveConflict', id: c.id, resolution: r.dataset.r }); }
        else if (x && x.dataset.x === 'compare') { syncAct('showConflict', { id: c.id }); }
        else if (x && x.dataset.x === 'reupload') { syncAct('reupload'); }
      };
      cl.appendChild(it);
    }
    cs.appendChild(cl); body.appendChild(cs);
    // ---- devices
    const devs = d.devices || [];
    const ds = el('section', 'cp-sec', `<h3>Devices <span class="cp-count">${devs.filter((x) => !x.revokedAt).length}</span></h3>`);
    const dl = el('div', 'cp-list'); dl.setAttribute('role', 'list');
    for (const x of devs) {
      const r = row(x.revokedAt ? 'sy-revoked' : '', `<span class="cp-main"><span class="cp-name">${esc(x.name)}${x.thisDevice ? ' <span class="cp-tag">this device</span>' : ''}${x.revokedAt ? ' <span class="cp-tag warn">removed</span>' : ''}</span><span class="cp-meta">${esc([x.platform, x.app].filter(Boolean).join(' · '))}${x.thisDevice ? '' : x.lastSeen ? ` · last seen ${when(x.lastSeen)}` : ' · not seen yet'}</span></span><span class="cp-ra">${x.thisDevice ? `<button class="btn sm ghost" data-d="rename" title="Rename this device" aria-label="Rename this device">${I.rename}<span>Rename</span></button>` : x.revokedAt ? `<button class="btn sm ghost" data-d="reinstate" title="List it as an active device again">${I.undo}<span>List again</span></button>` : `<button class="btn sm ghost" data-d="remove" title="Remove this device (and rotate the key)" aria-label="Remove ${esc(x.name)}">${I.trash}<span>Remove…</span></button>`}</span>`);
      r.setAttribute('role', 'listitem');
      r.onclick = (e) => { const b = e.target.closest('[data-d]'); if (!b) { return; } syncAct(b.dataset.d === 'rename' ? 'renameDevice' : b.dataset.d === 'reinstate' ? 'reinstate' : 'removeDevice', { deviceId: x.id }); };
      dl.appendChild(r);
    }
    ds.appendChild(dl); body.appendChild(ds);
    // ---- what syncs
    const cats = d.categories || [];
    const ws = el('section', 'cp-sec', '<h3>What syncs</h3>');
    const grid = el('div', 'sy-cats');
    for (const k of cats) {
      const lab = el('label', 'mm-check', `<input type="checkbox"${k.on ? ' checked' : ''}><span>${esc(k.label)}${k.withheld ? ` <span class="cp-tag" title="Held back while it was off; sent when you turn it on">${k.withheld} held back</span>` : ''}</span>`);
      lab.querySelector('input').onchange = (e) => syncAct('setCategory', { category: k.id, on: e.target.checked });
      grid.appendChild(lab);
    }
    ws.appendChild(grid);
    ws.appendChild(el('p', 'cp-note', 'API keys and credentials never sync. Turning a category off keeps it on this device; turning it on later sends what it held back.'));
    body.appendChild(ws);
    // ---- activity
    const act = d.activity || [];
    const as = el('section', 'cp-sec', '<h3>Activity</h3>');
    const al = el('div', 'cp-list sy-act');
    for (const a of act.slice(0, 12)) {
      const what = a.kind === 'sync' ? (a.up || a.down ? `↑ ${a.up} · ↓ ${a.down}${a.bytes ? ` · ${fmtSize(a.bytes)}` : ''}` : 'Nothing new') : a.kind === 'offline' ? 'Offline' : a.kind === 'paused' ? 'Paused' : 'Failed';
      al.appendChild(row(a.error ? 'sy-err' : '', `<span class="cp-main"><span class="cp-name">${esc(what)}</span>${a.error ? `<span class="cp-meta" title="${esc(a.error)}">${esc(a.error)}</span>` : ''}</span><span class="cp-meta">${when(a.at)}</span>`));
    }
    if (!act.length) { al.appendChild(el('p', 'cp-note', 'No sync yet.')); }
    as.appendChild(al); body.appendChild(as);
    // ---- keys
    const ks = el('section', 'cp-sec', '<h3>Passphrase and key</h3>');
    const kb = el('div', 'sy-btns', `<button class="btn sm ghost" data-c="changePassphrase">${I.key}<span>Change passphrase…</span></button><button class="btn sm ghost" data-c="rotateKey">${I.refresh}<span>Rotate key…</span></button><button class="btn sm ghost" data-c="turnOff">${I.x}<span>Turn off sync…</span></button><button class="btn sm ghost danger" data-c="startOver" title="Forgot the passphrase? Delete the synced data and upload again from this device">${I.warn}<span>Start over…</span></button>`);
    kb.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => syncAct(b.dataset.c)));
    ks.appendChild(kb);
    ks.appendChild(el('p', 'cp-note', 'The passphrase never leaves your devices and cannot be recovered. The storage sees object names, sizes and times — never titles, messages, code, memory or device names.'));
    body.appendChild(ks);
    if (cur && cur.params && cur.params.view === 'conflicts') { setTimeout(() => { const t = document.getElementById('sy-conflicts'); if (t) { t.scrollIntoView({ block: 'start' }); } }, 0); cur.params.view = ''; }
  }
  function off(page, why) {
    const body = frame(TITLES[page] || page);
    body.innerHTML = `<div class="cp-empty"><p>${why === 'starting' ? 'Conversation storage is still starting — try again in a moment.' : `Conversation storage is off: ${esc(why)}`}</p></div>`;
  }

  function compare(m) {
    cur = { page: 'compare', params: {}, back: null };
    root.classList.remove('hidden');
    const items = m.items || [];
    const body = frame('Compare answers', `${items.length} answers to the same request`);
    const tabs = el('div', 'cmp-tabs'); tabs.setAttribute('role', 'tablist');
    const grid = el('div', 'cmp-grid');
    items.forEach((x, i) => {
      const t = el('button', `cmp-tab${i === 0 ? ' on' : ''}`, `${esc(x.model ? x.model.split('/').pop() : `Answer ${i + 1}`)}${x.current ? ' · shown' : ''}`); t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', String(i === 0));
      const col = el('article', `cmp-col${i === 0 ? ' on' : ''}`, `<header><b>${esc(x.model || `Answer ${i + 1}`)}</b><span>${when(x.createdAt)}${x.current ? ' · in the chat now' : ''}</span>${x.current ? '' : `<button class="btn sm" data-id="${esc(x.id)}">Use this one</button>`}</header><div class="body">${md ? md(x.text || '') : esc(x.text || '')}</div>`);
      col.setAttribute('role', 'tabpanel');
      t.onclick = () => { tabs.querySelectorAll('.cmp-tab').forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', String(k === i)); }); grid.querySelectorAll('.cmp-col').forEach((c, k) => c.classList.toggle('on', k === i)); };
      tabs.appendChild(t); grid.appendChild(col);
    });
    grid.onclick = (e) => {
      const b = e.target.closest('[data-id]'); if (!b) { return; }
      // The answers are siblings: stepping the switcher to that one shows its branch.
      const cur0 = items.findIndex((x) => x.current); const want = items.findIndex((x) => x.id === b.dataset.id);
      post({ type: 'branch', sessionId: m.sessionId, action: 'step', messageId: items[cur0 >= 0 ? cur0 : 0].id, delta: want - (cur0 >= 0 ? cur0 : 0) });
      close(false);
    };
    body.append(tabs, grid);
  }

  function receive(m) {
    if (!cur) { return; }
    if (m.type === 'syncStatus') { if (cur.page === 'sync' && cur.data && !root.querySelector('.mm-busy')) { const was = cur.data.status && cur.data.status.state; cur.data.status = { ...m }; if (was !== m.state || m.state !== 'syncing') { request(); } } return; }
    if (m.type === 'versionsList' && cur.page === 'versions') { versions({ ...m, id: m.id }); return; }
    if (m.type === 'memoryVersions' && cur.page === 'memory') { cur.versions = m; cur.vsel = null; cur.params.view = 'versions'; if (cur.data) { memory(cur.data); } return; }
    if (m.type === 'memoryDone') {
      if (m.error) { const s = root.querySelector('.mm-form [type="submit"]'); if (s) { s.disabled = false; } return; }
      if (api.toast && m.note) { api.toast(m.note, 'info'); }
      if (cur.page === 'memory') { if (m.action === 'create' || m.action === 'update' || m.action === 'move') { cur.params.view = 'list'; cur.edit = null; if (cur.pendingType && m.action !== 'update') { cur.params.type = cur.pendingType; } if (m.action === 'move') { cur.open = null; } } if (m.action === 'restoreVersion') { cur.params.view = 'list'; cur.versions = null; } }
      request(); return;
    }
    if (m.type === 'contextDone') {
      if (m.error) { const sb = root.querySelector('.cx-form [type="submit"]'); if (sb) { sb.disabled = false; } return; }
      if (api.toast && m.note && m.action !== 'attach') { api.toast(m.note, 'info'); }
      if (cur.page === 'context' && (m.action === 'create' || m.action === 'update')) { cur.params.view = 'library'; cur.edit = null; }
      if (cur.page === 'context' || cur.page === 'trash') { request(); }
      return;
    }
    if (m.type !== 'continuityPage' || m.page !== cur.page) { return; }
    const d = m.data || {};
    if (d.off) { off(m.page, d.off); return; }
    cur.data = d;
    // A refresh while the editor is open keeps what is being typed.
    if (m.page === 'memory' && cur.params.view === 'edit' && root.querySelector('.mm-form')) { return; }
    if (m.page === 'context' && cur.params.view === 'edit' && root.querySelector('.cx-form')) { return; }
    ({ trash, versions, memory, context, checkpoints, sync }[m.page] || (() => undefined))(d);
  }
  function refresh() { if (cur && cur.page !== 'compare' && !root.classList.contains('hidden')) { request(); } }

  window.LPContinuity = { open, receive, refresh, compare, close };
})();
