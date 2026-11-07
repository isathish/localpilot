// The VS Code side of continuity's conversations (design §16): webview messages of the navigator (views, counts,
// projects, search with inline filters, row actions), the Trash / Versions / Knowledge pages, the branch switcher,
// Regenerate with…, Compare, export / import / secure share, remote-update banners; plus the commands
// `localpilot.continuity.openNavigator`, `.openTrash`, `.exportConversations`, `.importConversations`.
import * as path from 'path';
import * as vscode from 'vscode';
import type { Continuity } from '../continuity/continuity';
import type { ConversationManager } from '../continuity/conversation/conversationManager';
import { exportFileName, ExportFormat } from '../continuity/conversation/export';
import { createShare, findSecrets, formatCode, isShareFile, openShare, redactSecrets, WrongShareCodeError } from '../continuity/conversation/share';
import type { ConversationRow } from '../continuity/data/index/queries';
import type { ChatMessage, Session } from '../types';
import type { ChatController, Sink, ToWebview } from './chatController';
import type { ContinuityHandle } from './continuityData';
import type { ContinuityFromWebview, ContinuityPageName, NavProject, NavRow, NavView } from './continuityMessages';
import { quickPrompt } from './inlineEdit';
import { getConfig } from '../config';
import type { SessionStore } from '../sessions/sessionStore';
import type { MemoryStore } from '../agent/memory';
import { memoryAction, memoryPageData } from './memoryHost';
import { contextAction, contextPageData, modelSwitchNotice, onChatOpened } from './contextHost';
import { checkpointMessageIndex, checkpointsPageData } from './sessionHost';
import type { SyncHost } from './syncHost';
import { importCheckpointBundle } from '../continuity/sync/extras';

const FORMAT_LABEL: Record<ExportFormat, string> = { json: 'JSON', markdown: 'Markdown', html: 'HTML', pdf: 'PDF (print-ready page)' };

export class ContinuityHost implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private branchTimer?: NodeJS.Timeout;
  private wired?: ConversationManager;

  constructor(
    private readonly controller: ChatController,
    private readonly store: SessionStore,
    private readonly cont: ContinuityHandle,
    private readonly log: vscode.LogOutputChannel
  ) {
    void cont.opened.then((c) => this.wire(c));
    this.subs.push(
      controller.onDidChangeActive((s) => s && this.scheduleBranches(s.id)),
      // CONTEXT: a reopened chat gets its context back from its latest snapshot; the ring's card its items.
      controller.onDidChangeActive((s) => s && void this.chatOpened(s).catch((e) => this.log.debug(`context: ${String(e)}`))),
      store.onDidSave(({ session }) => session.id === this.controller.activeSession?.id && this.scheduleBranches(session.id))
    );
    // CONTEXT (§8.4): a smaller window after a model switch means a compaction before the next request.
    // (Optional: test doubles of the controller may not have the event.)
    const onModel = (controller as Partial<Pick<ChatController, 'onDidChangeModel'>>).onDidChangeModel;
    if (onModel) {
      this.subs.push(
        onModel(({ session, to }) => {
          // SESSION: the next model session of this chat says the user switched.
          this.c?.sessions?.bridge.modelChanged(session.id);
          const info = this.controller.providers?.cachedModels().find((m) => m.id === to);
          const note = modelSwitchNotice(session, info);
          if (note) {
            this.post({ type: 'contextNotice', sessionId: session.id, text: note, kind: 'window' });
          }
        })
      );
    }
  }

  dispose(): void {
    clearTimeout(this.branchTimer);
    this.subs.forEach((d) => d.dispose());
  }

  private get c(): Continuity | undefined {
    const c = this.cont.current;
    return c && !c.degraded ? c : undefined;
  }

  private get mgr(): ConversationManager | undefined {
    return this.c?.conversations;
  }

  private wire(c: Continuity | undefined): void {
    const mgr = c?.conversations;
    if (!mgr || this.wired === mgr) {
      return;
    }
    this.wired = mgr;
    // The merge summary is written by the chat's model, only when the user asked for a merge.
    mgr.summarize = async (prompt, text) => {
      const msgs: ChatMessage[] = [{ role: 'system', content: prompt }, { role: 'user', content: text }];
      return quickPrompt(this.controller.providers, msgs, { maxTokens: 600, temperature: 0.2, modelRef: this.controller.activeSession?.model || undefined });
    };
    const d = mgr.onRemoteChange((ch) => {
      const label = ch.local ? 'another window or the CLI' : `device ${ch.device.replace(/^dev_/, '').slice(0, 8)}`;
      this.controller.publish({ type: 'remoteUpdate', sessionId: ch.id, device: label, kind: ch.kind, applied: ch.applied });
      const s = this.store.has(ch.id) ? this.store.get(ch.id) : undefined;
      if (ch.applied && s) {
        this.controller.redraw(s);
      }
      this.controller.publish({ type: 'navChanged' });
    });
    this.subs.push({ dispose: () => d.dispose() });
  }

  private async chatOpened(s: Session): Promise<void> {
    const svc = this.c?.context;
    if (!svc || !(await this.indexReady())) {
      return;
    }
    await onChatOpened(svc, s, {
      root: s.folder ?? this.controller.workspace?.root,
      running: this.controller.isRunning(s.id),
      sink: { post: (m) => this.post(m) },
      save: (x) => this.store.has(x.id) && this.store.save(x),
      redraw: (x) => this.controller.redraw(x),
    });
  }

  private post(m: ToWebview, reply?: Sink): void {
    this.controller.publish(m, reply);
  }

  private toast(text: string, level: 'info' | 'warn' | 'error' = 'info', action?: { label: string; msg: ContinuityFromWebview }): void {
    this.post({ type: 'toast', level, text, ...(action ? { action } : {}) });
  }

  private scheduleBranches(id: string): void {
    clearTimeout(this.branchTimer);
    this.branchTimer = setTimeout(() => void this.pushBranches(id).catch(() => undefined), 400);
  }

  private async pushBranches(id: string, reply?: Sink): Promise<void> {
    const mgr = this.mgr;
    if (!mgr || !(await this.indexReady())) {
      return;
    }
    const b = await mgr.branches(id);
    this.post({ type: 'branches', sessionId: id, active: b.active, branches: b.branches, siblings: b.siblings }, reply);
  }

  private async indexReady(): Promise<boolean> {
    const c = this.c;
    if (!c || c.indexFailed) {
      return false;
    }
    const st = await c.index.status().catch(() => undefined);
    return st?.state === 'ready' || st?.state === 'catching-up';
  }

  /** The project of this window's first folder (the navigator's "This project"). */
  private async currentProject(): Promise<string | undefined> {
    const root = this.controller.workspace?.root;
    if (!root || !this.c?.projects) {
      return undefined;
    }
    return (this.c.projects.peek(root) ?? (await this.c.projects.resolve(root).catch(() => undefined)))?.id;
  }

  async handle(msg: ContinuityFromWebview, reply?: Sink): Promise<void> {
    try {
      await this.dispatch(msg, reply);
    } catch (e) {
      this.log.warn(`continuity: ${msg.type} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      this.toast(`${e instanceof Error ? e.message : String(e)}`, 'error');
      this.post({ type: 'navChanged' }, reply);
    }
  }

  /** The MemoryStore (set by extension.ts): the Memory manager edits note files through it. */
  memory?: MemoryStore;
  /** SYNC (set by extension.ts): the Sync manager page and its actions. */
  sync?: SyncHost;

  private async dispatch(msg: ContinuityFromWebview, reply?: Sink): Promise<void> {
    const mgr = this.mgr;
    if (msg.type === 'nav') {
      return this.nav(msg, reply);
    }
    if (msg.type === 'continuityPage' && msg.page === 'memory' && this.c?.memory) {
      return this.page('memory', msg.params ?? {}, reply);
    }
    if (msg.type === 'continuityPage' && msg.page === 'context' && this.c?.context) {
      return this.page('context', msg.params ?? {}, reply);
    }
    if (msg.type === 'continuityPage' && msg.page === 'checkpoints' && this.c?.sessions) {
      return this.page('checkpoints', msg.params ?? {}, reply);
    }
    if (msg.type === 'checkpointAction') {
      return this.checkpointAction(msg);
    }
    if (msg.type === 'syncAction' || msg.type === 'resolveConflict') {
      await this.sync?.handle(msg);
      if (msg.type === 'resolveConflict' || msg.action !== 'settings') {
        this.post({ type: 'continuityPage', page: 'sync', data: await this.sync?.pageData() }, reply);
      }
      return;
    }
    if (msg.type === 'continuityPage' && msg.page === 'sync' && this.sync) {
      this.post({ type: 'continuityPage', page: 'sync', data: await this.sync.pageData() }, reply);
      return;
    }
    if (msg.type === 'contextAction') {
      return contextAction(msg, {
        c: () => this.c,
        store: this.store,
        post: (m) => this.post(m as ToWebview, reply),
        toast: (t, l) => this.toast(t, l),
        activeSessionId: () => this.controller.activeSession?.id,
        compose: (text) => this.controller.addToComposer(text),
        openPage: (params) => this.post({ type: 'openContinuityPage', page: 'context', params }, reply),
      });
    }
    if (msg.type === 'memoryAction') {
      if (!this.memory) {
        return;
      }
      return memoryAction(msg, { c: () => this.c, memory: this.memory, store: this.store, post: (m, r) => this.post(m as ToWebview, r), toast: (t, l) => this.toast(t, l), activeSessionId: () => this.controller.activeSession?.id }, reply);
    }
    if (!mgr) {
      this.toast(this.cont.current?.degraded ? `Conversation storage is off: ${this.cont.current.degraded}` : 'Conversation storage is still starting — try again in a moment.', 'warn');
      return;
    }
    switch (msg.type) {
      case 'convAction':
        return this.convAction(mgr, msg);
      case 'setTags': {
        let { add, remove } = msg;
        if (!add && !remove) {
          const rows = await Promise.all(msg.ids.map((id) => mgr.conversation(id)));
          const current = [...new Set(rows.flatMap((r) => r?.tags ?? []))];
          const v = await vscode.window.showInputBox({ title: msg.ids.length > 1 ? `Tags for ${msg.ids.length} conversations` : 'Tags', prompt: 'Comma-separated. Remove a tag by deleting it (or write -tag).', value: current.join(', '), ignoreFocusOut: true });
          if (v === undefined) {
            return;
          }
          const want = v.split(',').map((t) => t.trim()).filter(Boolean);
          add = want.filter((t) => !t.startsWith('-'));
          remove = [...want.filter((t) => t.startsWith('-')).map((t) => t.slice(1)), ...(msg.ids.length === 1 ? current.filter((t) => !add!.map((a) => a.toLowerCase()).includes(t)) : [])];
        }
        await mgr.setTags(msg.ids, add ?? [], remove ?? []);
        this.c?.context?.forgetTags(msg.ids);
        this.post({ type: 'navChanged' });
        return;
      }
      case 'exportConversations':
        return this.exportConversations(mgr, msg.ids, msg.format);
      case 'importConversations':
        return this.importConversations(mgr);
      case 'shareConversation':
        return this.share(mgr, msg.id);
      case 'branch':
        return this.branch(mgr, msg);
      case 'branches':
        return this.pushBranches(msg.sessionId, reply);
      case 'regenerateWith': {
        if (this.controller.isRunning(msg.sessionId)) {
          this.toast('Stop the running agent first', 'warn');
          return;
        }
        if (msg.model) {
          await this.controller.handle({ type: 'setModel', sessionId: msg.sessionId, model: msg.model });
        }
        await this.controller.retry(msg.sessionId);
        return;
      }
      case 'compareVersions': {
        const items = await mgr.compare(msg.sessionId, msg.messageId);
        if (items.length < 2) {
          this.toast('There is only one answer to this request — use Regenerate (or Regenerate with…) to get another', 'info');
          return;
        }
        this.post({ type: 'compare', sessionId: msg.sessionId, messageId: msg.messageId, items }, reply);
        return;
      }
      case 'versions': {
        const v = await mgr.versions(msg.id);
        const row = await mgr.conversation(msg.id);
        this.post({ type: 'versionsList', ent: 'conversation', id: msg.id, title: row?.title ?? 'Conversation', versions: v.versions, branches: v.branches }, reply);
        return;
      }
      case 'restoreVersion': {
        const s = await mgr.restoreVersion(msg.id, msg.hlc);
        if (s) {
          this.controller.redraw(s);
        }
        this.toast('Restored that version — the newer one is still in the history');
        this.post({ type: 'navChanged' });
        const v = await mgr.versions(msg.id);
        const row = await mgr.conversation(msg.id);
        this.post({ type: 'versionsList', ent: 'conversation', id: msg.id, title: row?.title ?? 'Conversation', versions: v.versions, branches: v.branches }, reply);
        return;
      }
      case 'continuityPage':
        return this.page(msg.page, msg.params ?? {}, reply);
      case 'remoteReload': {
        if (this.controller.isRunning(msg.sessionId)) {
          this.toast('It reloads when the agent finishes', 'info');
          return;
        }
        const s = (await mgr.reloadIfIdle(msg.sessionId, true)) ? this.store.get(msg.sessionId) : await mgr.load(msg.sessionId);
        if (s) {
          this.controller.redraw(s);
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- navigator

  private async nav(msg: Extract<ContinuityFromWebview, { type: 'nav' }>, reply?: Sink): Promise<void> {
    if (this.sync) {
      // The navigator's Sync manager dot.
      this.post({ type: 'syncStatus', ...this.sync.view() }, reply);
    }
    const mgr = this.mgr;
    const empty = { rows: [], total: 0, offset: 0, limit: 0 };
    if (!mgr || !(await this.indexReady())) {
      const c = this.cont.current;
      const st = c?.degraded ? 'off' : c && !c.indexFailed ? ((await c.index.status().catch(() => undefined))?.state ?? 'loading') : c?.indexFailed ? 'failed' : 'loading';
      this.post({ type: 'navPage', seq: msg.seq, indexState: st, projects: [], page: empty }, reply);
      return;
    }
    const current = await this.currentProject();
    const projectId = msg.projectId === 'this' ? current : msg.projectId && msg.projectId !== 'all' ? msg.projectId : undefined;
    const counts = await mgr.counts(projectId);
    const all = await mgr.counts();
    const infos = await this.c!.projects!.list().catch(() => []);
    const missing = new Set(infos.filter((p) => !p.exists).map((p) => p.id));
    const projects: NavProject[] = all.projects.map((p) => ({ id: p.id, name: p.name, count: p.count, ...(p.id === current ? { current: true } : {}), ...(missing.has(p.id) ? { missing: true } : {}) }));
    projects.sort((a, b) => Number(!!b.current) - Number(!!a.current));
    const q = (msg.query ?? '').trim();
    const offset = Math.max(0, msg.offset ?? 0);
    const limit = Math.min(200, msg.limit ?? 50);
    let page: { rows: NavRow[]; total: number; offset: number; limit: number; query?: string };
    if (q) {
      const view = msg.view;
      const hits = await mgr.search({
        text: q,
        projectId: projectId ?? 'all',
        includeArchived: view === 'archived' || view === 'all',
        includeTrash: view === 'trash',
        ...(view === 'pinned' ? { is: 'pinned' as const } : view === 'favorites' ? { is: 'favorite' as const } : view === 'trash' ? { is: 'trashed' as const } : view === 'archived' ? { is: 'archived' as const } : {}),
        ...(msg.tag ? { tag: msg.tag } : {}),
        limit: 200,
      });
      const seen = new Map<string, NavRow>();
      for (const h of hits) {
        if (seen.has(h.conversationId) || !h.conversationId) {
          continue;
        }
        const row = await mgr.conversation(h.conversationId);
        if (row) {
          seen.set(h.conversationId, { ...row, snippet: h.field === 'title' ? undefined : h.snippet, field: h.field, role: h.role, messageId: h.messageId });
        }
      }
      const rows = [...seen.values()];
      page = { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit, query: q };
    } else {
      const r = await mgr.list({ view: msg.view, projectId: projectId ?? 'all', tag: msg.tag, offset, limit, sort: (['newest', 'oldest', 'tokens', 'cost', 'size', 'title'].includes(msg.sort ?? '') ? msg.sort : 'newest') as 'newest' });
      page = { ...r, rows: r.rows };
    }
    page.rows = page.rows.map((r) => ({ ...r, inStore: this.store.has(r.id) }));
    const tags = [...new Set(page.rows.flatMap((r) => r.tags))].sort();
    this.post({ type: 'navPage', seq: msg.seq, indexState: 'ready', counts, projects, currentProject: current, page, tags }, reply);
  }

  private async open(mgr: ConversationManager, id: string): Promise<Session | undefined> {
    if (this.store.has(id)) {
      await this.controller.handle({ type: 'selectSession', id });
      return this.store.get(id);
    }
    const s = await mgr.load(id);
    if (!s) {
      this.toast('That conversation could not be opened (it may be in Trash)', 'warn');
      return undefined;
    }
    this.controller.present(s);
    return s;
  }

  private async convAction(mgr: ConversationManager, msg: Extract<ContinuityFromWebview, { type: 'convAction' }>): Promise<void> {
    const ids = msg.ids.filter((x) => typeof x === 'string' && x);
    const n = ids.length;
    const what = n === 1 ? 'conversation' : `${n} conversations`;
    switch (msg.action) {
      case 'open':
        await this.open(mgr, ids[0]);
        break;
      case 'rename':
        if (msg.title?.trim()) {
          await mgr.rename(ids[0], msg.title);
        }
        break;
      case 'favorite':
      case 'unfavorite':
        await mgr.setFlags(ids, { favorite: msg.action === 'favorite' });
        break;
      case 'archive':
      case 'unarchive':
        await mgr.setFlags(ids, { archived: msg.action === 'archive' });
        this.toast(msg.action === 'archive' ? `Archived ${what}` : `Moved ${what} out of Archived`, 'info', msg.action === 'archive' ? { label: 'Undo', msg: { type: 'convAction', ids, action: 'unarchive' } } : undefined);
        break;
      case 'pin':
      case 'unpin':
        await mgr.setFlags(ids, { pinned: msg.action === 'pin' });
        break;
      case 'trash': {
        for (const id of ids) {
          if (this.store.has(id)) {
            // The controller stops the run, drops its worktree and queue; the store's delete moves it to Trash.
            await this.controller.handle({ type: 'deleteSession', id });
          }
        }
        await mgr.trash(ids.filter((id) => !this.store.has(id)));
        this.toast(`Moved ${what} to Trash`, 'info', { label: 'Undo', msg: { type: 'convAction', ids, action: 'restore' } });
        break;
      }
      case 'restore': {
        const restored = await mgr.restore(ids);
        this.toast(restored ? `Restored ${what}` : 'Nothing to restore');
        break;
      }
      case 'purge': {
        const pick = await vscode.window.showWarningMessage(`Delete ${what} permanently?`, { modal: true, detail: 'Messages, transcript archive, run traces and checkpoints go. Backups made before now still contain them.' }, 'Delete permanently');
        if (pick !== 'Delete permanently') {
          return;
        }
        await mgr.purge(ids);
        this.toast(`Deleted ${what} permanently`);
        break;
      }
      case 'emptyTrash': {
        const counts = await mgr.counts();
        const notes = this.c?.memory ? (await this.c.memory.list({ projectId: 'all', trash: true, limit: 2000 }).catch(() => [])).length : 0;
        const pick = await vscode.window.showWarningMessage(`Empty Trash (${counts.trash} conversation${counts.trash === 1 ? '' : 's'}${notes ? `, ${notes} memory note${notes === 1 ? '' : 's'}` : ''})?`, { modal: true, detail: 'Everything in Trash is deleted permanently. Backups made before now still contain it.' }, 'Empty Trash');
        if (pick !== 'Empty Trash') {
          return;
        }
        const k = await this.c!.data.emptyTrash();
        this.toast(k ? `Deleted ${k} item(s) permanently` : 'Trash is already empty');
        break;
      }
      case 'duplicate': {
        const s = await mgr.duplicate(ids[0], msg.uptoMessageId);
        if (s) {
          this.controller.present(s);
          this.toast(`Duplicated as “${s.title}”`);
        }
        break;
      }
      case 'merge': {
        let other = msg.otherId;
        if (!other) {
          const page = await mgr.list({ view: 'all', projectId: 'all', limit: 200 });
          const pick = await vscode.window.showQuickPick(
            page.rows.filter((r) => r.id !== ids[0]).map((r) => ({ label: r.title, description: `${r.projectName ?? ''}${r.projectName ? ' · ' : ''}${r.messageCount} messages`, id: r.id })),
            { title: 'Merge with…', placeHolder: 'The new conversation continues this one with a summary of the one you pick' }
          );
          other = pick?.id;
        }
        if (!other) {
          return;
        }
        const s = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Merging conversations…' }, () => mgr.merge(ids[0], other!));
        if (s) {
          this.controller.present(s);
          this.toast(`Merged into “${s.title}”`);
        }
        break;
      }
      case 'repoint': {
        const root = this.controller.workspace?.root;
        if (!root || !msg.projectId || !this.c?.projects) {
          return;
        }
        await this.c.projects.repoint(msg.projectId, root);
        await mgr.sync();
        this.toast('Linked: those chats now belong to this folder');
        break;
      }
    }
    this.post({ type: 'navChanged' });
  }

  // ---------------------------------------------------------------------------------------------- export / share

  private async exportConversations(mgr: ConversationManager, ids: string[], format: ExportFormat): Promise<void> {
    if (!ids.length) {
      return;
    }
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (ids.length === 1) {
      const out = await mgr.exportText(ids[0], format);
      if (!out) {
        return;
      }
      if (format === 'markdown') {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: out.text }));
        return;
      }
      const name = exportFileName(out.title, out.ext);
      const target = await vscode.window.showSaveDialog({ defaultUri: base ? vscode.Uri.joinPath(base, name) : undefined, filters: format === 'json' ? { JSON: ['json'] } : { HTML: ['html'] }, saveLabel: 'Export' });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(out.text, 'utf8'));
      if (format === 'pdf') {
        await vscode.env.openExternal(target);
        void vscode.window.showInformationMessage('Opened the print-ready page in your browser: Print → Save as PDF.');
      } else {
        void vscode.window.showInformationMessage(`Exported to ${vscode.workspace.asRelativePath(target)}`);
      }
      return;
    }
    const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: `Export ${ids.length} here`, defaultUri: base });
    const dir = pick?.[0];
    if (!dir) {
      return;
    }
    const taken = new Set<string>();
    let n = 0;
    for (const id of ids) {
      const out = await mgr.exportText(id, format);
      if (out) {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, exportFileName(out.title, out.ext, taken)), Buffer.from(out.text, 'utf8'));
        n++;
      }
    }
    void vscode.window.showInformationMessage(`Exported ${n} conversation${n === 1 ? '' : 's'} (${FORMAT_LABEL[format]}) to ${dir.fsPath}`, 'Show folder').then((p) => p && vscode.commands.executeCommand('revealFileInOS', dir));
  }

  private async importConversations(mgr: ConversationManager): Promise<void> {
    const pick = await vscode.window.showOpenDialog({ title: 'Import conversations', canSelectMany: true, filters: { 'LocalPilot conversations': ['json', 'lpshare'] } });
    if (!pick?.length) {
      return;
    }
    let last: Session | undefined;
    for (const uri of pick) {
      const data = Buffer.from(await vscode.workspace.fs.readFile(uri));
      try {
        if (isShareFile(data)) {
          const code = await vscode.window.showInputBox({ title: `Share code for ${path.basename(uri.fsPath)}`, prompt: 'The 52-character code the sender gave you (dashes optional).', password: true, ignoreFocusOut: true });
          if (!code) {
            continue;
          }
          last = mgr.importDoc(openShare(data, code), 'share');
        } else {
          last = mgr.importText(data.toString('utf8'));
        }
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof WrongShareCodeError ? e.message : `Could not import ${path.basename(uri.fsPath)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (last) {
      this.controller.present(last);
      this.toast(pick.length > 1 ? `Imported ${pick.length} conversations` : `Imported “${last.title}”`);
      this.post({ type: 'navChanged' });
    }
  }

  private async share(mgr: ConversationManager, id: string): Promise<void> {
    const s = this.store.has(id) ? this.store.get(id) : (await mgr.materialize(id))?.session;
    if (!s) {
      return;
    }
    let session = s;
    const secrets = findSecrets(s);
    if (secrets.length) {
      const pick = await vscode.window.showWarningMessage(
        `This conversation contains ${secrets.length} secret${secrets.length === 1 ? '' : 's'} (${[...new Set(secrets.map((x) => x.title.split(':')[0]))].slice(0, 3).join(', ')}).`,
        { modal: true, detail: 'Redact replaces the secret values with [REDACTED] in the shared copy; your conversation is not changed.' },
        'Redact',
        'Keep'
      );
      if (!pick) {
        return;
      }
      if (pick === 'Redact') {
        session = redactSecrets(s).session;
      }
    }
    const { data, code } = createShare(session);
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({ defaultUri: base ? vscode.Uri.joinPath(base, exportFileName(s.title, 'lpshare')) : undefined, filters: { 'LocalPilot share': ['lpshare'] }, saveLabel: 'Save share file' });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, data);
    const pretty = formatCode(code);
    const copy = await vscode.window.showInformationMessage(
      `Share code (shown once): ${pretty}`,
      { modal: true, detail: 'Send the file and this code separately. Anyone with both can read the conversation; without the code the file is unreadable. LocalPilot does not keep the code.' },
      'Copy code'
    );
    if (copy) {
      await vscode.env.clipboard.writeText(pretty);
      this.toast('Share code copied');
    }
  }

  // ---------------------------------------------------------------------------------------------- branches

  private async branch(mgr: ConversationManager, msg: Extract<ContinuityFromWebview, { type: 'branch' }>): Promise<void> {
    if (this.controller.isRunning(msg.sessionId)) {
      this.toast('Stop the running agent before switching branches', 'warn');
      return;
    }
    let s: Session | undefined;
    switch (msg.action) {
      case 'switch':
        s = msg.branchId ? await mgr.switchBranch(msg.sessionId, msg.branchId) : undefined;
        break;
      case 'step':
        s = msg.messageId ? await mgr.stepSibling(msg.sessionId, msg.messageId, msg.delta ?? 1) : undefined;
        break;
      case 'continueFrom':
        s = msg.messageId ? await mgr.continueFrom(msg.sessionId, msg.messageId) : undefined;
        if (s) {
          this.toast('Continuing from that message on a new branch — the later messages stay on the previous one');
        }
        break;
      case 'duplicateFrom': {
        const d = msg.messageId ? await mgr.duplicate(msg.sessionId, msg.messageId) : undefined;
        if (d) {
          this.controller.present(d);
          this.toast(`Duplicated up to that message as “${d.title}”`);
        }
        return;
      }
      case 'rename':
        if (msg.branchId) {
          const label = msg.label ?? (await vscode.window.showInputBox({ title: 'Branch name', ignoreFocusOut: true }));
          if (label) {
            await mgr.renameBranch(msg.branchId, label);
          }
        }
        break;
    }
    if (s) {
      this.controller.redraw(s);
    }
    await this.pushBranches(msg.sessionId);
  }

  /** A Checkpoints page button: open the chat at that turn, then View changes or Restore through the chat's own paths. */
  private async checkpointAction(msg: Extract<ContinuityFromWebview, { type: 'checkpointAction' }>): Promise<void> {
    const id = msg.sessionId;
    const s = this.store.has(id) ? this.store.get(id) : undefined;
    if (msg.action === 'open' || !s) {
      if (s) {
        await this.controller.handle({ type: 'selectSession', id });
      } else if (this.mgr) {
        await this.open(this.mgr, id);
      }
      return;
    }
    const index = checkpointMessageIndex(s, msg.run);
    if (index < 0) {
      this.toast('That turn is no longer in the chat (it was rewound or edited)', 'warn');
      return;
    }
    if (this.controller.activeSession?.id !== id) {
      await this.controller.handle({ type: 'selectSession', id });
    }
    // SYNC: a checkpoint taken on another device restores here once its synced contents are in this repository.
    const c = this.c;
    if (c?.sessions && c.sync) {
      const row = (await c.sessions.checkpoints({ conversationId: id }).catch(() => [])).find((r) => r.run === msg.run);
      const root = s.folder ?? this.controller.workspace?.root;
      if (row && row.device && row.device !== c.device.deviceId && row.contentBlob && row.ref && root) {
        const r = await importCheckpointBundle({ blobs: c.blobs, fetchBlob: (sha) => c.sync!.fetchBlob(sha) }, row.contentBlob, row.ref, root);
        if (!r.ok) {
          this.toast(`This checkpoint's contents cannot be used here: ${r.message}`, 'warn');
          return;
        }
      }
    }
    if (msg.action === 'view') {
      await this.controller.handle({ type: 'viewChanges', sessionId: id, scope: 'turn', run: msg.run });
      return;
    }
    const type = msg.restoreType ?? 'both';
    const label = type === 'task' ? 'Rewind the chat to this turn' : type === 'workspace' ? 'Put the files back as they were before this turn' : 'Put the files and the chat back as they were before this turn';
    const pick = await vscode.window.showWarningMessage(`${label}?`, { modal: true, detail: type === 'task' ? 'The messages from this turn on are removed (they stay in the conversation\'s versions).' : 'Your current state is saved in git stash first when the folder is a git repository.' }, 'Restore');
    if (pick === 'Restore') {
      await this.controller.handle({ type: 'restoreCheckpoint', sessionId: id, messageIndex: index, restoreType: type });
      this.post({ type: 'navChanged' });
    }
  }

  // ---------------------------------------------------------------------------------------------- pages

  private async page(page: ContinuityPageName, params: Record<string, unknown>, reply?: Sink): Promise<void> {
    const c = this.c;
    const mgr = this.mgr;
    // The Memory manager needs only memory (MEMORY), not the conversation manager.
    if (page === 'memory' && c?.memory) {
      this.post({ type: 'continuityPage', page, data: await memoryPageData(c, this.store, params) }, reply);
      return;
    }
    // The Context library (CONTEXT): sets, and what the model saw in this chat.
    if (page === 'context' && c?.context) {
      this.post({ type: 'continuityPage', page, data: await contextPageData(c, this.store, params, this.controller.activeSession?.id) }, reply);
      return;
    }
    // The Checkpoints page (SESSION): per project, newest first, with View changes / Restore / Open chat.
    if (page === 'checkpoints' && c?.sessions) {
      this.post({ type: 'continuityPage', page, data: await checkpointsPageData(c, this.store, params, await this.currentProject()) }, reply);
      return;
    }
    if (!c || !mgr) {
      this.post({ type: 'continuityPage', page, data: { off: this.cont.current?.degraded ?? 'starting' } }, reply);
      return;
    }
    let data: unknown;
    switch (page) {
      case 'trash': {
        const r = await mgr.list({ view: 'trash', projectId: 'all', limit: 200 });
        const days = getConfig().continuity.trashRetentionDays;
        // Memory notes in Trash have their own rows (MEMORY).
        const memory = c.memory ? await c.memory.list({ projectId: 'all', trash: true, limit: 200 }).catch(() => []) : [];
        // Context sets in Trash (CONTEXT).
        const contextSets = c.context ? await c.context.library.list({ trash: 'only' }).catch(() => []) : [];
        data = { rows: r.rows, total: r.total, retentionDays: days, memory, contextSets };
        break;
      }
      case 'versions': {
        const id = String(params.id ?? '');
        const v = await mgr.versions(id);
        const row: ConversationRow | undefined = await mgr.conversation(id);
        data = { id, title: row?.title ?? 'Conversation', versions: v.versions, branches: v.branches };
        break;
      }
      case 'memory':
        data = await memoryPageData(c, this.store, params);
        break;
      case 'context':
        data = await contextPageData(c, this.store, params, this.controller.activeSession?.id);
        break;
      case 'checkpoints':
        // SESSION attaches before the page can be asked for; until then the page says it is starting.
        data = { off: 'starting' };
        break;
      case 'sync':
        data = { state: 'off', device: c.device.name, deviceId: c.device.deviceId, devices: await c.index.query('syncEvents', {}).catch(() => []) };
        break;
    }
    this.post({ type: 'continuityPage', page, data }, reply);
  }
}

/** Waits (up to `ms`) for a chat webview to attach, revealing the chat first. */
async function withChat(controller: ChatController, reveal: () => void, ms = 4000): Promise<boolean> {
  reveal();
  const until = Date.now() + ms;
  while (!controller.hasSurface() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return controller.hasSurface();
}

/** Opens a continuity page in the chat (revealing it first). */
export async function showContinuityPage(controller: ChatController, reveal: () => void, page: ContinuityPageName, params?: Record<string, unknown>): Promise<void> {
  if (await withChat(controller, reveal)) {
    controller.publish({ type: 'openContinuityPage', page, ...(params ? { params } : {}) });
  }
}

export function registerConversationCommands(context: vscode.ExtensionContext, controller: ChatController, handle: ContinuityHandle, reveal: () => void): void {
  const host = () => controller.continuityHost as ContinuityHost | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('localpilot.continuity.openNavigator', async (view?: NavView) => {
      if (await withChat(controller, reveal)) {
        controller.publish({ type: 'openNavigator', ...(typeof view === 'string' ? { view } : {}) });
      }
    }),
    vscode.commands.registerCommand('localpilot.continuity.openTrash', async () => {
      if (await withChat(controller, reveal)) {
        controller.publish({ type: 'openContinuityPage', page: 'trash' });
      }
    }),
    vscode.commands.registerCommand('localpilot.continuity.openMemoryManager', async (type?: string) => {
      if (await withChat(controller, reveal)) {
        controller.publish({ type: 'openContinuityPage', page: 'memory', ...(typeof type === 'string' ? { params: { type } } : {}) });
      }
    }),
    vscode.commands.registerCommand('localpilot.continuity.openCheckpoints', async (all?: boolean) => {
      if (await withChat(controller, reveal)) {
        controller.publish({ type: 'openContinuityPage', page: 'checkpoints', ...(all === true ? { params: { all: true } } : {}) });
      }
    }),
    vscode.commands.registerCommand('localpilot.continuity.openContextLibrary', async (view?: string) => {
      if (await withChat(controller, reveal)) {
        controller.publish({ type: 'openContinuityPage', page: 'context', ...(view === 'chat' ? { params: { view: 'chat' } } : {}) });
      }
    }),
    vscode.commands.registerCommand('localpilot.continuity.exportConversations', async (ids?: string[]) => {
      const c = await handle.opened;
      const mgr = c && !c.degraded ? c.conversations : undefined;
      if (!mgr) {
        void vscode.window.showWarningMessage('Conversation storage is not available yet.');
        return;
      }
      let pickIds = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
      if (!pickIds.length) {
        await c!.ready;
        const page = await mgr.list({ view: 'all', projectId: 'all', limit: 500 });
        const picks = await vscode.window.showQuickPick(
          page.rows.map((r) => ({ label: r.title, description: `${r.projectName ?? ''}${r.projectName ? ' · ' : ''}${new Date(r.updatedAt).toLocaleDateString()}`, id: r.id })),
          { title: 'Export conversations', canPickMany: true, placeHolder: 'Pick one or more conversations' }
        );
        pickIds = (picks ?? []).map((p) => p.id);
      }
      if (!pickIds.length) {
        return;
      }
      const format = await vscode.window.showQuickPick(
        (Object.keys(FORMAT_LABEL) as ExportFormat[]).map((f) => ({ label: FORMAT_LABEL[f], f })),
        { title: 'Export as' }
      );
      if (format) {
        await host()?.handle({ type: 'exportConversations', ids: pickIds, format: format.f });
      }
    }),
    vscode.commands.registerCommand('localpilot.continuity.importConversations', async () => {
      await handle.opened;
      await host()?.handle({ type: 'importConversations' });
    })
  );
}
