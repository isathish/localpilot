import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { click, dispatch, MiniElement, miniDocument } from './miniDom';
import { nextInQueue, queueFiles, reviewSummary } from '../agent/reviewQueue';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

interface Review {
  renderChanges: () => void;
  syncEditTag: (card: MiniElement, rows: unknown[]) => void;
  state: { session: { id: string } | null; changes: Map<string, unknown[]>; reviewed: Map<string, unknown[]>; conflicts: Map<string, unknown[]>; worktree: Map<string, unknown>; running: Set<string>; paused: Map<string, unknown> };
  els: { changes: MiniElement; changesList: MiniElement; changesLabel: MiniElement; changesMeter: MiniElement };
  posted: Record<string, unknown>[];
  toasts: string[];
  doc: ReturnType<typeof miniDocument>;
}

/**
 * The review queue of `media/chat.js` (the Changes panel: renderChanges, its row actions and keys) and the edit cards'
 * review tag, lifted out of the browser IIFE and run against the panel markup of the preview harness in ./miniDom.
 */
function loadReview(): Review {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
  const cut = (from: string, to: string): string => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    assert.ok(a > 0 && b > a, `${from.trim()} … ${to.trim()} not found in media/chat.js`);
    return src.slice(a, b);
  };
  const line = (prefix: string): string => {
    const l = src.split('\n').find((x) => x.trim().startsWith(prefix));
    assert.ok(l, `${prefix} not found in media/chat.js`);
    return l;
  };
  const html = fs.readFileSync(path.join(EXT_ROOT, 'scripts', 'ui-preview.html'), 'utf8');
  const markup = /<div id="changes" class="panel hidden">[\s\S]*?<\/ul><\/div>/.exec(html);
  assert.ok(markup, 'changes panel markup not found in scripts/ui-preview.html');
  const doc = miniDocument();
  const host = doc.body.appendChild(doc.createElement('div'));
  host.innerHTML = markup[0];
  const byId = (id: string): MiniElement => {
    const e = host.querySelector(`#${id}`);
    assert.ok(e, `#${id} missing`);
    return e;
  };
  const els = { changes: byId('changes'), changesList: byId('changesList'), changesLabel: byId('changesLabel'), changesToggle: byId('changesToggle'), changesMeter: byId('changesMeter'), messages: doc.body.appendChild(doc.createElement('div')) };
  const state = { session: { id: 's1' }, changes: new Map(), reviewed: new Map(), conflicts: new Map(), worktree: new Map(), running: new Set(), paused: new Map() };
  const posted: Record<string, unknown>[] = [];
  const toasts: string[] = [];
  const icon = '<svg></svg>';
  const sandbox: Record<string, unknown> = {
    document: Object.assign(doc, { activeElement: null }),
    I: { undo: icon, check: icon, restore: icon, diff: icon, x: icon, git: icon, open: icon, edit: icon },
    state,
    els,
    post: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
    toast: (t: string) => toasts.push(t),
    closeRejectConfirm: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  vm.runInNewContext(
    `${line('const esc = ')}\n${line('function el(')}\n${cut('  let changesSig = ', '  function renderChips() {')}\n${cut("  /** The review decision on an edit card's file", '  function syncEditTags(')}\nout_ = { renderChanges, syncEditTag };`,
    sandbox,
    { timeout: 5_000 }
  );
  const out = sandbox.out_ as Pick<Review, 'renderChanges' | 'syncEditTag'>;
  return { ...out, state: state as unknown as Review['state'], els, posted, toasts, doc };
}

const rows = (r: Review): MiniElement[] => r.els.changesList.querySelectorAll('li.change');
const head = (r: Review, a: string): MiniElement | null => r.els.changes.querySelector(`.panel-head [data-a="${a}"]`);

suite('Chat review queue', () => {
  const pending = [
    { path: 'b.py', fsPath: '/w/b.py', kind: 'create', added: 4, removed: 0 },
    { path: 'd.py', fsPath: '/w/d.py', kind: 'delete', added: 0, removed: 9 },
  ];
  const reviewed = [
    { path: 'a.py', fsPath: '/w/a.py', kind: 'modify', state: 'accepted' },
    { path: 'c.py', fsPath: '/w/c.py', kind: 'modify', state: 'rejected', redoUntil: Date.now() + 7 * 86_400_000 }, // computed when the suite loads, which can be many minutes before it runs
  ];

  test('pending and reviewed files share one list in path order, with progress in the head', () => {
    const r = loadReview();
    r.state.changes.set('s1', pending);
    r.state.reviewed.set('s1', reviewed);
    r.renderChanges();
    assert.ok(!r.els.changes.classList.contains('hidden'));
    assert.deepStrictEqual(rows(r).map((li) => `${li.dataset.file}:${li.dataset.state}`), ['/w/a.py:accepted', '/w/b.py:pending', '/w/c.py:rejected', '/w/d.py:pending']);
    assert.match(r.els.changesLabel.textContent, /^4 files changed · 2 reviewed/);
    assert.ok(!r.els.changesMeter.classList.contains('hidden'));
    assert.strictEqual(r.els.changesMeter.firstElementChild!.style.width, '50%');
    assert.strictEqual(r.els.changesMeter.getAttribute('aria-valuenow'), '2');
    const review = head(r, 'review')!;
    assert.ok(review.classList.contains('primary') && !review.classList.contains('hidden'), 'Review is the primary action');
    assert.ok(!head(r, 'keepAll')!.classList.contains('primary'), 'Accept all is secondary while Review is primary');
    // The roving tab stop starts on the first file still waiting for review.
    assert.deepStrictEqual(rows(r).filter((li) => li.getAttribute('tabindex') === '0').map((li) => li.dataset.file), ['/w/b.py']);
  });

  test('row actions: accept, reject, open the diff (a deleted file too), restore a rejected file', () => {
    const r = loadReview();
    r.state.changes.set('s1', pending);
    r.state.reviewed.set('s1', reviewed);
    r.renderChanges();
    const [a, b, c, d] = rows(r);
    click(b.querySelector('[data-a="keep"]')!);
    click(d.querySelector('[data-a="undo"]')!);
    click(d.querySelector('button.name')!);
    click(c.querySelector('[data-a="restore"]')!);
    click(a.querySelector('button.name')!);
    assert.deepStrictEqual(r.posted, [
      { type: 'keepChanges', sessionId: 's1', fsPath: '/w/b.py' },
      { type: 'undoChanges', sessionId: 's1', fsPath: '/w/d.py' },
      { type: 'review', sessionId: 's1', scope: 'session', fsPath: '/w/d.py' },
      { type: 'restoreEdits', sessionId: 's1', fsPath: '/w/c.py' },
      { type: 'openFile', path: '/w/a.py', sessionId: 's1' },
    ]);
    assert.ok(!a.querySelector('[data-a="keep"]'), 'an accepted row has no Accept / Reject');
    assert.match(a.textContent, /Accepted/);
  });

  test('Restore edits explains itself once the redo window has passed', () => {
    const r = loadReview();
    r.state.changes.set('s1', pending);
    r.state.reviewed.set('s1', [{ ...reviewed[1], redoUntil: undefined }]);
    r.renderChanges();
    const btn = r.els.changesList.querySelector('li[data-file="/w/c.py"] [data-a="restore"]')!;
    assert.strictEqual(btn.getAttribute('aria-disabled'), 'true');
    assert.match(btn.title, /No longer kept: use Restore checkpoint on the message/);
    click(btn);
    assert.deepStrictEqual(r.posted, []);
    assert.deepStrictEqual(r.toasts, ['No longer kept: use Restore checkpoint on the message']);
  });

  test('keys on a row: j / k move the tab stop, a accepts, r rejects, Enter opens the diff', () => {
    const r = loadReview();
    r.state.changes.set('s1', pending);
    r.state.reviewed.set('s1', reviewed);
    r.renderChanges();
    const at = (): string | undefined => rows(r).find((li) => li.getAttribute('tabindex') === '0')?.dataset.file;
    dispatch(rows(r)[1], 'keydown', { key: 'j' });
    assert.strictEqual(at(), '/w/c.py');
    dispatch(rows(r)[2], 'keydown', { key: 'j' });
    assert.strictEqual(at(), '/w/d.py');
    dispatch(rows(r)[3], 'keydown', { key: 'k' });
    assert.strictEqual(at(), '/w/c.py');
    dispatch(rows(r)[1], 'keydown', { key: 'a' });
    dispatch(rows(r)[3], 'keydown', { key: 'r' });
    dispatch(rows(r)[3], 'keydown', { key: 'Enter' });
    dispatch(rows(r)[2], 'keydown', { key: 'a' }); // a rejected row: nothing to accept
    assert.deepStrictEqual(r.posted, [
      { type: 'keepChanges', sessionId: 's1', fsPath: '/w/b.py' },
      { type: 'undoChanges', sessionId: 's1', fsPath: '/w/d.py' },
      { type: 'review', sessionId: 's1', scope: 'session', fsPath: '/w/d.py' },
    ]);
  });

  test('every file decided: Clear reviewed replaces Review, the bulk actions go', () => {
    const r = loadReview();
    r.state.changes.set('s1', []);
    r.state.reviewed.set('s1', reviewed);
    r.renderChanges();
    assert.ok(!r.els.changes.classList.contains('hidden'), 'reviewed rows keep the panel up until the next message');
    assert.match(r.els.changesLabel.textContent, /^2 files changed · 2 reviewed/);
    assert.ok(head(r, 'clearReviewed'), 'Review turned into Clear reviewed');
    assert.ok(!head(r, 'review'));
    assert.ok(head(r, 'keepAll')!.classList.contains('hidden') && head(r, 'undoAll')!.classList.contains('hidden'));
    r.state.reviewed.set('s1', []);
    r.renderChanges();
    assert.ok(r.els.changes.classList.contains('hidden'));
  });

  test('conflicts from applying an isolated copy come first, with Resolve in the merge editor', () => {
    const r = loadReview();
    r.state.changes.set('s1', []);
    r.state.worktree.set('s1', { path: '/wt', applied: true, conflicts: ['README.md'] });
    r.state.conflicts.set('s1', [{ path: 'README.md', fsPath: '/w/README.md' }]);
    r.renderChanges();
    assert.ok(!r.els.changes.classList.contains('hidden'));
    assert.match(r.els.changesLabel.textContent, /1 conflict to resolve/);
    const [row] = rows(r);
    assert.strictEqual(row.dataset.state, 'conflict');
    click(row.querySelector('[data-a="merge"]')!);
    assert.deepStrictEqual(r.posted, [{ type: 'recoveryAction', sessionId: 's1', action: 'openMergeEditor', file: '/w/README.md' }]);
  });

  test('an isolated copy: each row applies or discards its own file, opening shows the copy\'s diff, and a running agent blocks both', () => {
    const r = loadReview();
    r.state.changes.set('s1', [
      { path: 'src/a.py', fsPath: '/wt/src/a.py', kind: 'modify', added: 1, removed: 1 },
      { path: 'b.py', fsPath: '/wt/b.py', kind: 'create', added: 3, removed: 0 },
    ]);
    r.state.worktree.set('s1', { path: '/wt', applied: false });
    r.renderChanges();
    assert.strictEqual(head(r, 'applyWorktree')!.textContent.trim(), 'Apply all');
    assert.strictEqual(head(r, 'discardWorktree')!.textContent.trim(), 'Discard all');
    const [b, a] = rows(r);
    click(a.querySelector('[data-a="keep"]')!);
    click(b.querySelector('[data-a="undo"]')!);
    click(a.querySelector('button.name')!);
    dispatch(b, 'keydown', { key: 'a' });
    assert.deepStrictEqual(r.posted, [
      { type: 'applyWorktree', sessionId: 's1', files: ['src/a.py'] },
      { type: 'discardWorktree', sessionId: 's1', files: ['b.py'] },
      { type: 'showDiff', sessionId: 's1', fsPath: '/wt/src/a.py' },
      { type: 'applyWorktree', sessionId: 's1', files: ['b.py'] },
    ]);
    r.posted.length = 0;
    r.state.running.add('s1');
    r.renderChanges();
    const keep = rows(r)[0].querySelector('[data-a="keep"]')!;
    assert.strictEqual(keep.getAttribute('aria-disabled'), 'true');
    click(keep);
    dispatch(rows(r)[0], 'keydown', { key: 'r' });
    assert.deepStrictEqual(r.posted, [], 'nothing is applied or discarded while the agent still edits the copy');
    assert.deepStrictEqual(r.toasts, ['Pause or stop the agent first', 'Pause or stop the agent first']);
  });

  test('an isolated copy with a conflict from an earlier per-file apply lists the C row first and says so in the short label', () => {
    const r = loadReview();
    r.state.changes.set('s1', [{ path: 'b.py', fsPath: '/wt/b.py', kind: 'modify' }]);
    r.state.worktree.set('s1', { path: '/wt', applied: true, conflicts: ['src/app.py'] });
    r.state.conflicts.set('s1', [{ path: 'src/app.py', fsPath: '/w/src/app.py' }]);
    r.renderChanges();
    assert.deepStrictEqual(rows(r).map((li) => li.dataset.state), ['conflict', 'pending']);
    assert.match(r.els.changesLabel.textContent, /1 file changed in isolated copy · 1 conflict to resolve/);
    assert.match(r.els.changesLabel.querySelector('.short')!.textContent, /^1 file · 1 conflict$/);
  });

  test('a file the user edited before deciding is tagged "edited by you" in the queue and on its edit card', () => {
    const r = loadReview();
    r.state.changes.set('s1', [{ path: 'b.py', fsPath: '/w/b.py', kind: 'modify', added: 1, removed: 0, userEdited: true }]);
    r.state.reviewed.set('s1', [{ path: 'a.py', fsPath: '/w/a.py', kind: 'modify', state: 'accepted', userEdited: true }]);
    r.renderChanges();
    const [a, b] = rows(r);
    assert.ok(a.querySelector('.tag.byyou') && b.querySelector('.tag.byyou'));
    assert.match(b.getAttribute('aria-label')!, /edited by you, not reviewed/);
    const card = r.doc.createElement('div');
    card.innerHTML = '<div class="card-head"><span class="rtag hidden"></span></div>';
    card.dataset.path = 'a.py';
    r.syncEditTag(card, [{ path: 'a.py', fsPath: '/w/a.py', state: 'accepted', userEdited: true }]);
    const tag = card.querySelector('.rtag')!;
    assert.strictEqual(tag.textContent, 'Accepted · edited by you');
    assert.ok(tag.classList.contains('byyou') && tag.classList.contains('accepted'));
    r.syncEditTag(card, [{ path: 'a.py', fsPath: '/w/a.py', state: 'pending', userEdited: true }]);
    assert.strictEqual(tag.textContent, 'Edited by you', 'a pending file the user changed is tagged before the decision');
    assert.strictEqual(tag.getAttribute('aria-label'), 'Edited by you');
  });

  test('an edit card shows the review decision on its file', () => {
    const r = loadReview();
    const card = r.doc.createElement('div');
    card.innerHTML = '<div class="card-head"><span class="rtag hidden"></span></div>';
    card.dataset.path = 'src/c.py';
    r.syncEditTag(card, [{ path: 'src/c.py', fsPath: '/w/src/c.py', state: 'rejected' }]);
    const tag = card.querySelector('.rtag')!;
    assert.strictEqual(tag.textContent, 'Rejected');
    assert.ok(tag.classList.contains('rejected') && !tag.classList.contains('hidden'));
    card.dataset.path = './other.py';
    r.syncEditTag(card, [{ path: 'x/other.py', fsPath: '/w/x/other.py', state: 'accepted' }]);
    assert.strictEqual(tag.textContent, 'Accepted', 'matched by the end of the absolute path');
    r.syncEditTag(card, []);
    assert.ok(tag.classList.contains('hidden'));
  });
});

suite('Review queue order', () => {
  test('next and previous wrap around the pending files', () => {
    const q = ['/a', '/b', '/c'];
    assert.strictEqual(nextInQueue(q, '/a'), '/b');
    assert.strictEqual(nextInQueue(q, '/c'), '/a');
    assert.strictEqual(nextInQueue(q, '/a', -1), '/c');
    assert.strictEqual(nextInQueue(q, undefined), '/a');
    assert.strictEqual(nextInQueue(q, undefined, -1), '/c');
    assert.strictEqual(nextInQueue(['/a'], '/a'), undefined, 'the only file has no other');
    assert.strictEqual(nextInQueue([], '/a'), undefined);
  });

  test('after a decision the queue continues from where the file was', () => {
    const order = ['/a', '/b', '/c', '/d'];
    assert.strictEqual(nextInQueue(['/a', '/c', '/d'], '/b', 1, order), '/c');
    assert.strictEqual(nextInQueue(['/a', '/c', '/d'], '/b', -1, order), '/a');
    assert.strictEqual(nextInQueue(['/a'], '/d', 1, order), '/a', 'wraps to the start');
  });

  test('a turn scope limits the queue to that turn\'s files', () => {
    assert.deepStrictEqual(queueFiles(['/a', '/b', '/c'], new Set(['/b', '/x'])), ['/b']);
    assert.deepStrictEqual(queueFiles(['/a', '/c'], new Set(['/b'])), [], 'the turn is done even with other files pending');
    assert.deepStrictEqual(queueFiles(['/a'], undefined), ['/a']);
  });

  test('the summary counts accepted and rejected files', () => {
    assert.strictEqual(reviewSummary([{ fsPath: '/a', state: 'accepted' }, { fsPath: '/b', state: 'rejected' }, { fsPath: '/c', state: 'accepted' }]), 'All 3 files reviewed: 2 accepted, 1 rejected');
    assert.strictEqual(reviewSummary([{ fsPath: '/a', state: 'accepted' }, { fsPath: '/b', state: 'accepted' }]), 'All 2 files reviewed: 2 accepted');
    assert.strictEqual(reviewSummary([{ fsPath: '/a', state: 'rejected' }]), '1 file reviewed: rejected');
  });
});
