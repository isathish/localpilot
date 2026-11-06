import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { dispatch, MiniElement, miniDocument } from './miniDom';
import { contextBreakdown, formatBreakdown, historyBreakdown } from '../context/contextBreakdown';
import { compactionDetails, ContextManager } from '../context/contextManager';
import { formatCodebase, queryTerms, relatedFiles } from '../context/codebaseContext';
import { FileIndex, indexStatusText, scanUnits, ScanUnit } from '../context/fileIndex';
import { indexStatusItem } from '../ui/indexStatusBar';
import { WorkspaceContext } from '../context/workspaceContext';
import { markRepoGraphStale } from '../context/repoGraph';
import { atRefs } from '../cli/headless';
import { mentionKind } from '../telemetry/catalog';
import { ChatMessage, LLMProvider, ModelInfo, ToolDefinition } from '../types';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

suite('Context breakdown', () => {
  test('splits the prompt into system, rules, memory, tools, MCP tools and the history parts', () => {
    const rules = 'Always run the tests. '.repeat(40);
    const memory = 'Uses pnpm. '.repeat(10);
    const system = `You are LocalPilot. ${'Mode text. '.repeat(30)}\n${rules}\n${memory}`;
    const tools: ToolDefinition[] = [
      { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      { name: 'mcp_github__create_issue', description: 'Create an issue on GitHub with a long description', parameters: { type: 'object', properties: {} } },
    ];
    const messages: ChatMessage[] = [
      { role: 'user', content: `<attachment path="a.ts">\n${'const x = 1;\n'.repeat(50)}</attachment>\n\nExplain a.ts` },
      { role: 'assistant', content: 'It defines x.', toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"b.ts"}' }] },
      { role: 'tool', toolCallId: '1', content: 'file text '.repeat(40) },
      { role: 'user', content: '<conversation_summary>\nEarlier work\n</conversation_summary>', meta: { summary: true } },
    ];
    const b = contextBreakdown({ system, rules, memory, tools, messages });
    assert.ok(b.rules > 0 && b.memory > 0 && b.system > 0, JSON.stringify(b));
    assert.ok(b.tools > 0 && b.mcpTools > b.tools, 'the MCP tool has the longer definition');
    assert.ok(b.files > b.conversation, 'the attached file outweighs the question');
    assert.ok(b.toolResults > 0 && b.summary > 0);
    // The history parts are what historyBreakdown measures on its own.
    const h = historyBreakdown(messages);
    assert.deepStrictEqual([b.conversation, b.files, b.toolResults, b.summary], [h.conversation, h.files, h.toolResults, h.summary]);
    // A server-reported total rescales every part.
    const scaled = contextBreakdown({ system, rules, memory, tools, messages, total: 10_000 });
    const sum = Object.values(scaled).reduce((a, v) => a + v, 0);
    assert.ok(Math.abs(sum - 10_000) <= 9, `sum ${sum}`);
    // Text tool protocol: the definitions are inside the system prompt and are not counted twice.
    const inSystem = contextBreakdown({ system: `${system}\n${JSON.stringify(tools)}`, rules, memory, tools, toolsInSystem: true, messages: [] });
    assert.ok(inSystem.system < contextBreakdown({ system: `${system}\n${JSON.stringify(tools)}`, rules, memory, tools, messages: [] }).system);
  });

  test('/context lists the non-empty parts, largest first, with their share', () => {
    const text = formatBreakdown({ system: 100, rules: 0, memory: 0, tools: 300, mcpTools: 0, conversation: 50, files: 0, toolResults: 0, summary: 0 }, 1000);
    assert.deepStrictEqual(text.split('\n'), ['- Tools: 300 tokens (30%)', '- System prompt: 100 tokens (10%)', '- Conversation: 50 tokens (5%)']);
  });
});

suite('Compaction details', () => {
  const msgs = (): ChatMessage[] => [
    { role: 'user', content: '<attachment path="docs/a.md">\nhello\n</attachment>\n\nFirst request' },
    { role: 'assistant', content: 'Reading.', toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"src/x.ts"}' }, { id: '2', name: 'read_file', arguments: '{"files":[{"path":"src/y.ts"},{"path":"src/x.ts"}]}' }] },
    { role: 'tool', toolCallId: '1', content: 'x' },
    { role: 'tool', toolCallId: '2', content: 'y' },
    { role: 'assistant', content: 'Done with the first.' },
    { role: 'user', content: 'Second request' },
    { role: 'assistant', content: 'OK' },
  ];

  test('counts what went into the summary and what stayed', () => {
    const all = msgs();
    const d = compactionDetails(all.slice(0, 5), undefined, all.slice(5), 1000, 300, 'model');
    assert.deepStrictEqual(d.dropped, { messages: 5, requests: 1, replies: 2, toolCalls: 2, toolOutputs: 2, files: ['docs/a.md', 'src/x.ts', 'src/y.ts'], moreFiles: 0 });
    assert.deepStrictEqual(d.kept, { messages: 2, request: false, priorSummaries: 0 });
    // The running turn's request is kept, not counted as dropped.
    const k = compactionDetails(all.slice(0, 5), all[0], all.slice(5), 1000, 300, 'digest');
    assert.strictEqual(k.dropped.requests, 0);
    assert.strictEqual(k.kept.request, true);
    assert.strictEqual(k.kept.messages, 3);
    assert.strictEqual(k.method, 'digest');
  });

  test('a compaction stores its details on the summary message', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push({ role: 'user', content: `request ${i} ${'words '.repeat(30)}` }, { role: 'assistant', content: `reply ${i}`, toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: `{"path":"f${i}.ts"}` }] }, { role: 'tool', toolCallId: `c${i}`, content: 'text '.repeat(40) });
    }
    const cm = new ContextManager({ compactionThreshold: 0.1, maxToolOutputChars: 10_000, strategy: 'basic' });
    const model = { id: 'm', name: 'm', contextWindow: 8192 } as ModelInfo;
    const res = await cm.compact(history, {} as LLMProvider, model, undefined, 4);
    assert.ok(res.removed > 0);
    const summary = res.messages[0];
    assert.ok(summary.meta?.summary && summary.meta.compaction, 'details on the summary message');
    assert.strictEqual(summary.meta.compaction!.method, 'digest');
    assert.strictEqual(summary.meta.compaction, res.details);
    assert.strictEqual(res.details!.dropped.messages + res.details!.kept.messages, history.length);
    assert.ok(res.details!.dropped.files.includes('f0.ts'));
  });
});

suite('#codebase', () => {
  test('query terms skip filler and split identifiers', () => {
    const t = queryTerms('Explain how the chatController handles retry_policy in the codebase');
    assert.ok(t.includes('chatController') && t.includes('Controller') && t.includes('retry_policy') && t.includes('policy'), t.join(','));
    assert.ok(!t.includes('Explain') && !t.includes('codebase'));
  });

  test('related files rank symbol definitions and file names over path matches', () => {
    const files = ['src/ui/chatController.ts', 'src/retry/policy.ts', 'docs/retry.md', 'src/other.ts'];
    const symbols = new Map([['RetryPolicy', [{ file: 'src/agent/resilience.ts', kind: 'class', line: 10 }]]]);
    const r = relatedFiles('where is RetryPolicy and the chatController', files, symbols);
    assert.match(r[0], /^src\/agent\/resilience\.ts \(class RetryPolicy/);
    assert.ok(r.some((l) => l.startsWith('src/ui/chatController.ts (file name')), r.join('\n'));
    assert.ok(!r.some((l) => l.startsWith('src/other.ts')));
    assert.deepStrictEqual(relatedFiles('explain this', files, symbols), []);
  });

  test('the block says there is no semantic index and cuts the file list to fit', () => {
    const tree = Array.from({ length: 5000 }, (_, i) => `src/module${i}/file${i}.ts`).join('\n');
    const out = formatCodebase({ root: '/w', map: 'Folders: src/', graph: '10 source files', tree, related: ['src/a.ts (file name)'], terms: ['a'] });
    assert.ok(out.startsWith('<codebase root="/w">') && out.endsWith('</codebase>'));
    assert.match(out, /no semantic \(embedding\) index/);
    assert.match(out, /# Related to the request/);
    assert.match(out, /file list cut to fit/);
    assert.ok(out.length < 26_000, String(out.length));
  });

  test('#codebase and @codebase reach the CLI and telemetry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cb-'));
    try {
      assert.deepStrictEqual(atRefs('explain #codebase please', root).files, ['codebase']);
      assert.deepStrictEqual(atRefs('see @codebase', root).files, ['codebase']);
      assert.deepStrictEqual(atRefs('issue #codebases and #12', root).files, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.strictEqual(mentionKind('#codebase'), 'codebase');
    assert.strictEqual(mentionKind('@codebase'), 'codebase');
  });

  test('readAttachment(#codebase) describes the workspace', async function () {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.skip();
    }
    const dir = path.join(root!, 'lp-codebase');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'paymentRetry.ts'), 'export class PaymentRetry {}\n');
    fs.writeFileSync(path.join(dir, 'src', 'main.ts'), "import { PaymentRetry } from './paymentRetry';\nnew PaymentRetry();\n");
    const log = vscode.window.createOutputChannel('lp-codebase-test', { log: true });
    const ws = new WorkspaceContext(log);
    markRepoGraphStale(root);
    try {
      const out = await ws.readAttachment('#codebase', undefined, { query: 'How does PaymentRetry work?' });
      assert.ok(out.startsWith('<codebase root='), out.slice(0, 200));
      assert.match(out, /# Import graph/);
      assert.match(out, /lp-codebase\/src\/paymentRetry\.ts \(class PaymentRetry/);
      assert.match(out, /no semantic \(embedding\) index/);
    } finally {
      ws.dispose();
      log.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('File index status', () => {
  const unit = (pattern: string): ScanUnit => ({ folder: vscode.Uri.file(path.resolve('/w')), pattern });

  test('scanUnits keeps up to the limit, counts past it and reports progress per unit', async () => {
    const sizes: Record<string, number> = { '*': 3, 'a/**/*': 4, 'b/**/*': 5 };
    const progress: string[] = [];
    const r = await scanUnits([unit('*'), unit('a/**/*'), unit('b/**/*')], async (u, max) => Array.from({ length: Math.min(max, sizes[u.pattern]) }, (_, i) => `${u.pattern}${i}`), 6, 100, (p) => progress.push(`${p.done}/${p.total}:${p.files}`));
    assert.strictEqual(r.kept.length, 6);
    assert.strictEqual(r.files, 12);
    assert.strictEqual(r.capped, false);
    assert.deepStrictEqual(progress, ['1/3:3', '2/3:7', '3/3:12']);
    const capped = await scanUnits([unit('*'), unit('a/**/*'), unit('b/**/*')], async (u, max) => Array.from({ length: Math.min(max, sizes[u.pattern]) }, () => u.pattern), 6, 8, () => undefined);
    assert.deepStrictEqual([capped.files, capped.capped], [8, true]);
    // A folder that cannot be read counts as empty instead of failing the scan.
    const broken = await scanUnits([unit('*'), unit('a/**/*')], async (u) => { if (u.pattern === '*') { throw new Error('EACCES'); } return ['x']; }, 6, 100, () => undefined);
    assert.strictEqual(broken.files, 1);
  });

  test('status text: progress while indexing, the large-repo note after, nothing for a small repo', () => {
    assert.strictEqual(indexStatusText({ state: 'indexing', files: 1240, listed: 0, pct: 38, limit: 5000 }), `Indexing ${(1240).toLocaleString()} files… 38%`);
    assert.strictEqual(indexStatusText({ state: 'ready', files: 12400, listed: 5000, pct: 100, limit: 5000 }), `Large repo: ${(5000).toLocaleString()} of ${(12400).toLocaleString()} files listed`);
    assert.strictEqual(indexStatusText({ state: 'ready', files: 80, listed: 80, pct: 100, limit: 5000 }), '');
    assert.strictEqual(indexStatusItem({ state: 'ready', files: 80, listed: 80, pct: 100, limit: 5000 }), undefined);
    assert.match(indexStatusItem({ state: 'indexing', files: 10, listed: 0, pct: 5, limit: 5000 })!.text, /sync~spin.*5%/);
    const big = indexStatusItem({ state: 'ready', files: 200000, listed: 5000, pct: 100, capped: true, limit: 5000 })!;
    assert.ok(big.text.includes(`of ${(200000).toLocaleString()}+ files`), big.text);
    assert.match(big.tooltip, /No semantic \(embedding\) index/);
  });

  test('a real scan of the test workspace ends ready with the files it found', async function () {
    if (!vscode.workspace.workspaceFolders?.length) {
      this.skip();
    }
    const index = new FileIndex(3);
    const seen: string[] = [];
    const sub = index.onDidChangeStatus((s) => seen.push(s.state));
    const root = vscode.workspace.workspaceFolders![0].uri;
    const dir = vscode.Uri.joinPath(root, 'lp-index-scan');
    try {
      for (const n of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, n), new TextEncoder().encode('x'));
      }
      await index.rebuild();
      assert.strictEqual(index.status.state, 'ready');
      assert.ok(index.status.files >= 4, JSON.stringify(index.status));
      assert.strictEqual(index.status.listed, 3, 'the listing stops at the limit');
      assert.ok(seen.includes('indexing') && seen[seen.length - 1] === 'ready', seen.join(','));
      // A rescan after files change stops at the listing limit, keeps the full count and shows no progress.
      const counted = index.status.files;
      seen.length = 0;
      (index as unknown as { stale: boolean }).stale = true;
      await index.list();
      await (index as unknown as { building?: Promise<unknown> }).building;
      assert.strictEqual(index.status.state, 'ready');
      assert.strictEqual(index.status.files, counted, JSON.stringify(index.status));
      assert.ok(!seen.includes('indexing'), seen.join(','));
    } finally {
      sub.dispose();
      index.dispose();
      await vscode.workspace.fs.delete(dir, { recursive: true });
    }
  });
});

type Fn = (...a: unknown[]) => unknown;
interface ChatPieces { compactionEl: Fn; ctxBreakdownHtml: Fn; openFolderMenu: Fn; syncFolderChip: Fn; chatFolder: Fn; indexNote: Fn; mentionRefs: (t: string) => string[]; MENTIONS: string[][] }

/** Pieces of media/chat.js run against the preview harness's composer markup (see chatReview.test.ts). */
function loadChat() {
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
  const chip = /<button id="folderBtn"[\s\S]*?<\/button>/.exec(html);
  assert.ok(chip, 'folderBtn missing from scripts/ui-preview.html');
  const doc = miniDocument();
  const host = doc.body.appendChild(doc.createElement('div'));
  host.innerHTML = chip[0];
  const posted: Record<string, unknown>[] = [];
  const toasts: string[] = [];
  const menus: { anchor: MiniElement; items: Record<string, unknown>[]; opts: Record<string, unknown> }[] = [];
  const icon = '<svg></svg>';
  const state = { session: null as unknown, workspace: {} as Record<string, unknown>, running: new Set<string>(), pendingSend: new Set<string>(), models: [] };
  const sandbox: Record<string, unknown> = {
    document: doc,
    I: new Proxy({}, { get: () => icon }),
    LIVE_DOT: icon,
    state,
    els: { folderBtn: host.querySelector('#folderBtn'), messages: doc.body.appendChild(doc.createElement('div')) },
    post: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
    toast: (t: string) => toasts.push(t),
    openMenu: (anchor: MiniElement, items: Record<string, unknown>[], opts: Record<string, unknown>) => menus.push({ anchor, items, opts }),
    renderSession: () => undefined,
    mentionHits: { asked: 'x', query: 'x' },
    fchip: (p: string) => `<span class="fchip">${p}</span>`,
    console,
  };
  vm.runInNewContext(
    [
      line('const esc = '),
      line('function el('),
      line('function fmtTok('),
      line('function setState('),
      cut('  function lazyFill(', '  /** Settled rows keep'),
      cut('  /**\n   * A compaction, folded', '  /**\n   * Defers building'),
      cut('  // What fills the window (host `context` events', '  /** The model can take more than'),
      cut('  /** Multi-root: the workspace folders', '  /** The context strip\'s status'),
      cut('  // `codebase` is the # trigger', '\n\n  const state = {'),
      line('const MENTION_RE = '),
      cut('  /** `#codebase`, `#git` …', '  /** Opens what a sent message'),
      'out_ = { compactionEl, ctxBreakdownHtml, openFolderMenu, syncFolderChip, chatFolder, indexNote, mentionRefs, MENTIONS };',
    ].join('\n'),
    sandbox,
    { timeout: 5_000 }
  );
  const out = sandbox.out_ as ChatPieces;
  return { ...out, state, posted, toasts, menus, doc, chip: host.querySelector('#folderBtn')! };
}

suite('Chat webview: workspace and context', () => {
  const roots = [{ name: 'web', path: '/w/web', branch: 'main', errors: 0 }, { name: 'api', path: '/w/api', branch: 'dev', errors: 2 }];

  test('the folder chip shows the chat folder; an empty chat changes it, a chat with messages starts a new one', () => {
    const c = loadChat();
    c.state.workspace = { folders: 2, roots };
    c.state.session = { id: 's1', mode: 'agent', folder: '/w/api', messages: [] };
    c.syncFolderChip();
    assert.ok(!c.chip.classList.contains('hidden'));
    assert.strictEqual(c.chip.querySelector('.lbl')!.textContent, 'api');
    // The click handler (els.folderBtn.onclick) opens this menu.
    c.openFolderMenu(c.chip);
    const menu = c.menus[c.menus.length - 1];
    const web = menu.items.find((i) => i.label === 'web')!;
    assert.strictEqual(menu.items.find((i) => i.label === 'api')!.selected, true);
    (web.onPick as () => void)();
    assert.deepStrictEqual(c.posted.pop(), { type: 'setFolder', sessionId: 's1', folder: '/w/web' });
    assert.strictEqual((c.state.session as { folder?: string }).folder, undefined, 'the first folder is the default (unset)');
    // With messages the chat keeps its folder: the chip says so and a pick opens a new chat there.
    c.state.session = { id: 's2', mode: 'debug', folder: '/w/api', messages: [{ role: 'user', content: 'hi' }] };
    c.syncFolderChip();
    assert.ok(c.chip.classList.contains('locked'));
    assert.match(c.chip.title, /start a new chat/);
    c.openFolderMenu(c.chip);
    const locked = c.menus[c.menus.length - 1];
    assert.strictEqual(locked.items[0].group, 'New chat in');
    (locked.items.find((i) => i.label === 'web')!.onPick as () => void)();
    assert.deepStrictEqual(c.posted.pop(), { type: 'newSession', mode: 'debug', folder: '/w/web' });
    (locked.items.find((i) => i.label === 'Add folder to workspace…')!.onPick as () => void)();
    assert.deepStrictEqual(c.posted.pop(), { type: 'workspaceAction', action: 'addFolder' });
    // One folder: no chip.
    c.state.workspace = { folders: 1 };
    c.syncFolderChip();
    assert.ok(c.chip.classList.contains('hidden'));
  });

  test('#codebase and the other context variables become attachments', () => {
    const c = loadChat();
    assert.strictEqual(c.MENTIONS[0][0], 'codebase');
    assert.deepStrictEqual([...c.mentionRefs('Explain #codebase and @src/a.ts, see #git')], ['src/a.ts', 'codebase', 'git']);
    assert.deepStrictEqual([...c.mentionRefs('# Heading, issue #12, #codebases')], []);
  });

  test('the context card lists what fills the window with links that reach real actions', () => {
    const c = loadChat();
    c.state.session = { id: 's1', contextBreakdown: { system: 2000, rules: 1500, memory: 0, tools: 3000, mcpTools: 900, conversation: 400, files: 0, toolResults: 200, summary: 0 } };
    const card = c.doc.createElement('div');
    card.innerHTML = c.ctxBreakdownHtml({ win: 32768 }) as string;
    const rows = card.querySelectorAll('.r.bd');
    assert.deepStrictEqual(rows.map((r) => r.querySelector('.k')!.textContent.split(' · ')[0]), ['Tools', 'System prompt', 'Rules', 'MCP tools', 'Conversation', 'Tool output']);
    assert.deepStrictEqual(card.querySelectorAll('[data-c="fix"]').map((b) => b.dataset.fix), ['customize', 'mcp', 'compact']);
    // While the agent runs there is nothing to compact yet.
    c.state.running.add('s1');
    card.innerHTML = c.ctxBreakdownHtml({ win: 32768 }) as string;
    assert.deepStrictEqual(card.querySelectorAll('[data-c="fix"]').map((b) => b.dataset.fix), ['customize', 'mcp']);
    c.state.session = { id: 's1' };
    assert.match(c.ctxBreakdownHtml({ win: 1 }) as string, /Shown after the next request/);
  });

  test('the compaction note opens to what was kept and summarised', () => {
    const c = loadChat();
    const det = c.compactionEl({ before: 18400, after: 5200, method: 'digest', dropped: { messages: 9, requests: 2, replies: 3, toolCalls: 4, toolOutputs: 4, files: ['a.ts', 'b.ts'], moreFiles: 3 }, kept: { messages: 6, request: true, priorSummaries: 1 } }, 'The summary') as MiniElement;
    assert.match(det.querySelector('summary .label')!.textContent, /Context compacted/);
    assert.match(det.querySelector('summary .meta')!.textContent, /18\.4k → 5\.2k/);
    assert.strictEqual(det.querySelector('.cmp'), null, 'built on first open');
    (det as unknown as { open: boolean }).open = true;
    dispatch(det, 'toggle');
    const text = det.querySelector('.cmp')!.textContent;
    assert.match(text, /the latest 6 messages, including the request in progress/);
    assert.match(text, /2 requests, 3 replies, 4 tool calls, 4 tool outputs, and 1 earlier summary merged in/);
    assert.match(text, /\+3 more/);
    assert.match(text, /A digest of the messages/);
    assert.strictEqual(det.querySelector('.cmp-sum')!.textContent, 'The summary');
  });

  test('the large-repo note appears only when the index lists part of the files', () => {
    const c = loadChat();
    c.state.workspace = { index: { state: 'ready', files: 12400, listed: 5000, pct: 100 } };
    assert.strictEqual((c.indexNote() as { text: string }).text, `Large repo: ${(5000).toLocaleString()} of ${(12400).toLocaleString()} files listed`);
    c.state.workspace = { index: { state: 'ready', files: 50, listed: 50, pct: 100 } };
    assert.strictEqual(c.indexNote(), null);
  });
});
