import * as vscode from 'vscode';
import { AgentRunner } from '../agent/agentLoop';
import { SkillLearner } from '../agent/skillRecommender';
import { SkillCatalog } from '../agent/skillCatalog';
import { skillsDestination } from '../agent/skillInstaller';
import { ChangeTracker } from '../agent/changeTracker';
import { SkillManager } from '../agent/skills';
import { getConfig, setDefaultModel } from '../config';
import { ContextManager } from '../context/contextManager';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { SessionStore } from '../sessions/sessionStore';
import { AgentEvent, ALL_MODES, ChatMessage, ModelInfo, Session } from '../types';
import { captureUrl, inspectUrl, openInBrowser } from '../tools/browser';
import { formatReport } from '../tools/cdp';
import { captureScreenshot, ImageAttachment, pickImages, readImage, ScreenshotMode } from './images';
import { RunControl } from '../agent/runControl';
import { WorktreeChange, WorktreeManager } from '../agent/worktrees';
import { parseModelSuggestions, quickSuggestions, SuggestionFacts, suggestionPrompt, TaskSuggestion } from '../agent/taskSuggestions';
import { quickPrompt } from './inlineEdit';
import { findRipgrep, runProcess } from '../tools/search';
import * as path from 'path';

export type ToWebview =
  | { type: 'init'; sessions: ReturnType<SessionStore['list']>; activeSessionId?: string; models: ModelInfo[]; defaultModel: string; skills: { name: string; description: string }[]; agents: { name: string; description: string }[]; running: string[]; paused: string[]; platform: NodeJS.Platform }
  | { type: 'sessions'; sessions: ReturnType<SessionStore['list']> }
  | { type: 'session'; session: Session }
  | { type: 'models'; models: ModelInfo[]; defaultModel: string }
  | { type: 'skills'; skills: { name: string; description: string }[]; agents: { name: string; description: string }[] }
  | { type: 'event'; event: AgentEvent }
  | { type: 'approval'; id: string; sessionId: string; title: string; detail: string; kind: string }
  | { type: 'approvalResolved'; id: string }
  | { type: 'running'; sessionId: string; running: boolean }
  /** Pause state of a run or of one of its subagents (`childId`). `paused` = requested; `holding` = the loop has actually stopped at a step boundary. */
  | { type: 'paused'; sessionId: string; childId?: string; agent?: string; paused: boolean; holding: boolean }
  /** A message typed while the agent was busy was queued; the loop reports `steer` when it is injected. */
  | { type: 'steerQueued'; sessionId: string; id: string; content: string; images?: string[] }
  | {
      type: 'changes';
      sessionId: string;
      files: { path: string; fsPath: string; kind: 'create' | 'modify' | 'delete' | 'rename'; added?: number; removed?: number }[];
      checkpoints: number[];
      /** Present when the files come from the session's isolated worktree rather than the workspace. */
      worktree?: { path: string; applied: boolean; conflicts?: string[] };
    }
  | { type: 'image'; image: ImageAttachment }
  | { type: 'openFiles'; files: string[] }
  | { type: 'draft'; text: string }
  | { type: 'focusInput' }
  | { type: 'historyCleared'; removed: number }
  /** Task ideas for the multitask launcher: `quick` ones come instantly from the workspace, `model` ones from the model. */
  | { type: 'taskSuggestions'; source: 'quick' | 'model'; items: TaskSuggestion[]; recent: string[] }
  /** Open the multitask launcher (from the Command Palette / Agents view). */
  | { type: 'openLauncher'; kind?: 'tasks' | 'bestof' }
  | { type: 'toast'; level: 'info' | 'error'; text: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'booted' }
  | { type: 'newSession'; mode?: Session['mode']; text?: string; attachments?: string[]; images?: string[] }
  | { type: 'runParallel'; tasks: string[]; mode?: Session['mode'] }
  | { type: 'selectSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'deleteSessions'; ids: string[] }
  | { type: 'clearHistory'; keepPinned?: boolean }
  | { type: 'renameSession'; id: string; title: string }
  | { type: 'pinSession'; id: string }
  | { type: 'forkSession'; id: string; uptoIndex?: number }
  | { type: 'exportSession'; id: string }
  | { type: 'send'; sessionId: string; text: string; attachments?: string[]; images?: string[] }
  | { type: 'retry'; sessionId: string }
  | { type: 'stop'; sessionId: string }
  | { type: 'pause'; sessionId: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'steer'; sessionId: string; text: string; attachments?: string[]; images?: string[] }
  | { type: 'stopChild'; sessionId: string; childId: string }
  | { type: 'applyWorktree'; sessionId: string }
  | { type: 'discardWorktree'; sessionId: string }
  | { type: 'openWorktree'; sessionId: string }
  | { type: 'runBestOfN'; prompt: string; models: string[]; mode?: Session['mode'] }
  | { type: 'compareGroup'; groupId: string }
  | { type: 'suggestTasks'; more?: boolean }
  /** "Build" on the Prepared-plan card: switch to Agent mode and execute the checklist. */
  | { type: 'buildPlan'; sessionId: string }
  | { type: 'pauseChild'; sessionId: string; childId: string }
  | { type: 'resumeChild'; sessionId: string; childId: string }
  | { type: 'approval'; id: string; approved: boolean; remember?: boolean }
  | { type: 'setModel'; sessionId: string; model: string; makeDefault?: boolean }
  | { type: 'setMode'; sessionId: string; mode: Session['mode'] }
  | { type: 'refreshModels' }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'insertCode'; code: string }
  | { type: 'applyCodeToFile'; code: string; path?: string }
  | { type: 'attachActive' }
  | { type: 'attachRef'; ref: string }
  | { type: 'pickAttachment' }
  | { type: 'compactNow'; sessionId: string }
  | { type: 'clearSession'; sessionId: string }
  | { type: 'openSettings'; section?: string }
  | { type: 'autoSetupModels' }
  | { type: 'openExternal'; url: string }
  | { type: 'openInEditor' }
  | { type: 'attachUri'; uri: string }
  | { type: 'pickImage' }
  | { type: 'captureScreenshot'; mode?: ScreenshotMode; delayMs?: number }
  | { type: 'captureUrl'; url?: string; mobile?: boolean; fullPage?: boolean }
  | { type: 'inspectUrl'; url?: string; mobile?: boolean }
  | { type: 'openBrowser'; url?: string }
  | { type: 'requestOpenFiles' }
  | { type: 'keepChanges'; sessionId: string; fsPath?: string }
  | { type: 'undoChanges'; sessionId: string; fsPath?: string }
  | { type: 'showDiff'; sessionId: string; fsPath: string }
  | { type: 'restoreCheckpoint'; sessionId: string; messageIndex: number }
  | { type: 'runParallelPrompt' }
  | { type: 'dismissSkillTopic'; topic: string }
  /** Install a catalog skill offered under a request (`skills.autoInstall: ask`). */
  | { type: 'installCatalogSkill'; name: string; repo: string }
  | { type: 'dismissCatalogSkill'; name: string }
  | { type: 'openMarkdown'; text: string; title?: string }
  | { type: 'copyText'; text: string };

interface Sink {
  post(msg: ToWebview): void;
  /** Whether the user can currently see this surface; approvals raised while nothing is visible also get a notification. */
  visible?: () => boolean;
}

/** Shared brain behind the sidebar view, editor panels and the @localpilot chat participant. */
export class ChatController implements vscode.Disposable {
  private sinks = new Set<Sink>();
  private runs = new Map<string, RunControl>();
  private approvals = new Map<string, (ok: boolean) => void>();
  private sessionApprovalMemory = new Map<string, Set<string>>();
  private activeSessionId?: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChangeActive = new vscode.EventEmitter<Session | undefined>();
  readonly onDidChangeActive = this._onDidChangeActive.event;
  private readonly _onDidChangeRuns = new vscode.EventEmitter<void>();
  readonly onDidChangeRuns = this._onDidChangeRuns.event;
  /** Latest status line per running session (for the Agents view). */
  readonly runStatus = new Map<string, string>();

  /** Skill usage/recurrence tracker (set by the extension host). */
  learner?: SkillLearner;
  /** Installable skills from the configured repositories (set by the extension host). */
  catalog?: SkillCatalog;
  /** Rendered Markdown reader for long answers and generated documents (set by the extension host). */
  markdownViewer?: { showText(text: string, title?: string): Promise<void> };
  /** Resolves once sessions and skills are loaded; `sendInit` waits for it so an early webview never sees an empty store. */
  loaded: Promise<unknown> = Promise.resolve();

  constructor(
    readonly store: SessionStore,
    readonly runner: AgentRunner,
    readonly providers: ProviderRegistry,
    readonly skills: SkillManager,
    readonly workspace: WorkspaceContext,
    readonly tracker: ChangeTracker,
    private readonly log: vscode.LogOutputChannel,
    readonly worktrees?: WorktreeManager
  ) {
    this.disposables.push(
      store.onDidChange(() => this.broadcast({ type: 'sessions', sessions: store.list() })),
      providers.onDidChange(() => void this.pushModels()),
      // New/installed/removed skills and subagents show up in `/skill`, `/agent` and the suggestion chips right away.
      skills.onDidChange(() => this.broadcast({ type: 'skills', skills: skills.allSkills.map((s) => ({ name: s.name, description: s.description })), agents: skills.allAgents.map((a) => ({ name: a.name, description: a.description })) })),
      tracker.onDidChange(() => {
        for (const id of new Set([...this.store.list().map((s) => s.id)])) {
          if (this.tracker.forSession(id).length || id === this.activeSessionId) {
            this.pushChanges(id);
          }
        }
      })
    );
  }

  attach(sink: Sink): vscode.Disposable {
    this.sinks.add(sink);
    return new vscode.Disposable(() => this.sinks.delete(sink));
  }

  /** Prefills the composer (used by Settings → "Create skill" and other entry points). */
  draft(text: string): void {
    this.broadcast({ type: 'draft', text });
  }

  private broadcast(msg: ToWebview): void {
    // Fast models emit 100+ tokens/s; one webview message per token per host adds up. Text deltas are coalesced
    // for a few ms and flushed before anything else so event order is preserved.
    if (msg.type === 'event' && (msg.event.type === 'assistant_delta' || msg.event.type === 'thinking_delta') && typeof msg.event.payload === 'string') {
      const pending = this.pendingDeltas.get(msg.event.sessionId);
      if (pending && pending.type === msg.event.type) {
        pending.payload += msg.event.payload;
      } else {
        if (pending) {
          this.flushDeltas();
        }
        this.pendingDeltas.set(msg.event.sessionId, { sessionId: msg.event.sessionId, type: msg.event.type, payload: msg.event.payload });
      }
      this.deltaTimer ??= setTimeout(() => this.flushDeltas(), 25);
      return;
    }
    this.flushDeltas();
    for (const s of this.sinks) {
      s.post(msg);
    }
  }

  private readonly pendingDeltas = new Map<string, { sessionId: string; type: 'assistant_delta' | 'thinking_delta'; payload: string }>();
  private deltaTimer?: NodeJS.Timeout;

  private flushDeltas(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = undefined;
    }
    if (!this.pendingDeltas.size) {
      return;
    }
    const events = [...this.pendingDeltas.values()];
    this.pendingDeltas.clear();
    for (const event of events) {
      for (const s of this.sinks) {
        s.post({ type: 'event', event });
      }
    }
  }

  /** Used by agent-level tools (subagents) to surface progress in the UI. */
  emitEvent(e: AgentEvent): void {
    this.broadcast({ type: 'event', event: e });
  }

  get activeSession(): Session | undefined {
    return this.activeSessionId ? this.store.get(this.activeSessionId) : undefined;
  }

  get runningSessionIds(): string[] {
    return [...this.runs.keys()];
  }

  get pausedSessionIds(): string[] {
    return [...this.runs].filter(([, c]) => c.pausedBySelf).map(([id]) => id);
  }

  isPaused(sessionId: string): boolean {
    return this.runs.get(sessionId)?.pausedBySelf ?? false;
  }

  /** Subagent controls of a running session, for views that list them. */
  childControls(sessionId: string): RunControl[] {
    return this.runs.get(sessionId)?.descendants() ?? [];
  }

  private childControl(sessionId: string, childId: string): RunControl | undefined {
    const c = this.runs.get(sessionId)?.find(childId);
    return c && c.id !== sessionId ? c : undefined;
  }

  private setActive(s: Session): void {
    this.activeSessionId = s.id;
    this.broadcast({ type: 'session', session: s });
    this.pushChanges(s.id);
    this._onDidChangeActive.fire(s);
  }

  private pushChanges(sessionId: string): void {
    void this.pushChangesAsync(sessionId);
  }

  /** Last known conflicts from applying a worktree, shown until the next apply. */
  private readonly applyConflicts = new Map<string, string[]>();

  private async pushChangesAsync(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    const tracked = this.tracker.forSession(sessionId).map((c) => ({ path: vscode.workspace.asRelativePath(c.fsPath), fsPath: c.fsPath, kind: c.original === undefined ? ('create' as const) : ('modify' as const) }));
    if (session?.worktree && this.worktrees) {
      // Pending work in the isolated copy; files already applied to the workspace are tracked like any other edit.
      const pending = await this.worktrees.changes(session.worktree).catch(() => [] as WorktreeChange[]);
      if (pending.length || !tracked.length) {
        this.broadcast({
          type: 'changes',
          sessionId,
          files: pending.map((f) => ({ path: f.path, fsPath: path.join(session.worktree!.path, f.path), kind: f.kind, added: f.added, removed: f.removed })),
          checkpoints: [],
          worktree: { path: session.worktree.path, applied: !!session.worktree.appliedAt, conflicts: this.applyConflicts.get(sessionId) },
        });
        return;
      }
    }
    this.broadcast({ type: 'changes', sessionId, files: tracked, checkpoints: this.tracker.checkpoints(sessionId) });
  }

  /** Whether this session's agent should work in an isolated worktree, per `localpilot.worktrees.mode`. */
  private shouldIsolate(session: Session): boolean {
    const mode = getConfig().worktrees.mode;
    return !!this.worktrees && !!this.workspace.root && (mode === 'always' || (mode === 'parallel' && !!session.isolated));
  }

  /** Create the session's worktree if it needs one and does not have it yet. Quietly falls back to the workspace outside git. */
  private async ensureWorktree(session: Session, status: (text: string) => void): Promise<void> {
    if (!this.worktrees || !this.workspace.root || !this.shouldIsolate(session)) {
      return;
    }
    if (session.worktree && (await import('fs')).existsSync(session.worktree.path)) {
      return;
    }
    const repo = await this.worktrees.repoRoot(this.workspace.root);
    if (!repo) {
      if (!this.warnedNoGit) {
        this.warnedNoGit = true;
        this.broadcast({ type: 'toast', level: 'info', text: 'Not a git repository — agents edit the workspace directly (isolated worktrees need git).' });
      }
      return;
    }
    try {
      session.worktree = await this.worktrees.create(repo, session.id, { progress: status });
      session.isolated = true;
      this.store.save(session);
    } catch (e) {
      this.log.warn(`worktree for ${session.id} could not be created, editing the workspace directly: ${String(e)}`);
      this.broadcast({ type: 'toast', level: 'error', text: `Could not create an isolated worktree (${e instanceof Error ? e.message : String(e)}); this chat edits the workspace directly.` });
    }
  }
  private warnedNoGit = false;

  /** Bring the session's worktree changes onto the workspace as uncommitted edits; the chat can keep going afterwards. */
  async applyWorktree(sessionId: string): Promise<{ files: number; conflicts: string[] } | undefined> {
    const session = this.store.get(sessionId);
    if (!session?.worktree || !this.worktrees) {
      return undefined;
    }
    const wt = session.worktree;
    try {
      const res = await this.worktrees.apply(wt, (fsPath) => this.tracker.beforeChange(fsPath, sessionId));
      this.applyConflicts.set(sessionId, res.conflicts);
      // Further work in the worktree is measured from here, so applying again never re-applies these changes.
      await this.worktrees.rebase(wt);
      this.store.save(session);
      this.tracker.keep(sessionId); // applied = the user's decision; the workspace diff is now visible in git itself
      this.pushChanges(sessionId);
      this.broadcast({
        type: 'toast',
        level: res.conflicts.length ? 'error' : 'info',
        text: res.conflicts.length ? `Applied ${res.files.length} file(s); ${res.conflicts.length} with conflict markers: ${res.conflicts.join(', ')}` : `Applied ${res.files.length} file(s) to the workspace`,
      });
      return { files: res.files.length, conflicts: res.conflicts };
    } catch (e) {
      this.broadcast({ type: 'toast', level: 'error', text: `Could not apply the changes: ${e instanceof Error ? e.message : String(e)}` });
      return undefined;
    }
  }

  /** Diff of one worktree file against the session's base (what the agent started from). */
  async showWorktreeDiff(session: Session, rel: string): Promise<void> {
    if (!session.worktree) {
      return;
    }
    const left = vscode.Uri.from({ scheme: 'localpilot-wtbase', path: `/${rel}`, query: encodeURIComponent(session.id) });
    const right = vscode.Uri.file(path.join(session.worktree.path, rel));
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(rel)} (before ↔ agent's copy)`, { preview: true });
  }

  /** Throw the session's worktree away (its unapplied changes with it). A later message creates a fresh one. */
  async discardWorktree(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session?.worktree || !this.worktrees) {
      return;
    }
    if (this.runs.has(sessionId)) {
      this.stop(sessionId);
    }
    await this.worktrees.remove(session.worktree);
    session.worktree = undefined;
    this.applyConflicts.delete(sessionId);
    this.store.save(session);
    this.pushChanges(sessionId);
  }

  /** Run the same prompt on several models at once, each in its own worktree, so the best result can be picked. */
  async runBestOfN(prompt: string, models: string[], mode: Session['mode'] = 'agent'): Promise<string[]> {
    const picked = [...new Set(models)].slice(0, 8);
    const groupId = `g_${Date.now().toString(36)}`;
    const ids: string[] = [];
    for (const model of picked) {
      const s = this.createSession(mode);
      s.model = model;
      s.isolated = true;
      s.group = { id: groupId, kind: 'bestOf', prompt, size: picked.length };
      s.title = `${prompt.slice(0, 40)} · ${model.split('/').pop()}`;
      this.store.save(s);
      ids.push(s.id);
    }
    for (const id of ids) {
      void this.send(id, prompt);
    }
    const first = this.store.get(ids[0]);
    if (first) {
      this.setActive(first);
    }
    return ids;
  }

  /** Plan mode produced a checklist: keep the plan as a file and remember title/summary for the "Prepared plan" card. */
  private async savePlan(session: Session, text: string): Promise<void> {
    const todos = session.todos ?? [];
    const heading = text.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
    const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l && !/^#|^[-*\d]|^```|^Understood as:/i.test(l)) ?? '';
    const title = (heading || session.title || 'Plan').replace(/[*_`]/g, '').slice(0, 80);
    const summary = firstLine.replace(/[*_`]/g, '').slice(0, 160);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'plan';
    const rel = `.localpilot/plans/${slug}-${session.id.slice(-6)}.plan.md`;
    const body = `# ${title}\n\n${summary ? `${summary}\n\n` : ''}${text.trim()}\n\n## Checklist\n${todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.agent ? ` _(${t.agent})_` : ''}`).join('\n')}\n`;
    let file = rel;
    if (this.workspace.root) {
      try {
        const uri = vscode.Uri.file(path.join(this.workspace.root, rel));
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(body, 'utf8'));
      } catch (e) {
        this.log.warn(`could not save plan file: ${String(e)}`);
        file = '';
      }
    }
    session.plan = { file, title, summary };
    this.store.save(session);
    this.broadcast({ type: 'session', session });
  }

  /** Workspace facts the task suggestions are derived from. */
  private async suggestionFacts(): Promise<SuggestionFacts> {
    const [projectMap, gitSummary] = await Promise.all([this.workspace.projectMap().catch(() => ''), this.workspace.gitSummary().catch(() => '')]);
    let count = 0;
    let files = 0;
    let sample: string | undefined;
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const errs = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      if (errs.length) {
        count += errs.length;
        files++;
        sample ??= vscode.workspace.asRelativePath(uri);
      }
    }
    let todos: number | undefined;
    const rg = await findRipgrep();
    if (rg && this.workspace.root) {
      try {
        const out = await runProcess(rg, ['-c', '--no-messages', '-e', '\\b(TODO|FIXME)\\b', '--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist', '--glob', '!out', '.'], this.workspace.root, undefined, 8000);
        todos = out.split('\n').filter(Boolean).reduce((n, l) => n + (Number(l.split(':').pop()) || 0), 0);
      } catch {
        todos = undefined;
      }
    }
    const recent = [...new Set(this.store.list().flatMap((s) => (this.store.get(s.id)?.messages ?? []).filter((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.steer).map((m) => m.content.replace(/<[a-z_]+[^>]*>[\s\S]*?<\/[a-z_]+>\s*/g, '').trim()).filter((t) => t && !t.startsWith('/'))).reverse())].slice(0, 20);
    return { projectMap, gitSummary, errors: { count, files, sample }, todos, recent };
  }

  /** Send quick ideas right away; with `more`, ask the model for project-specific ones as well. */
  async suggestTasks(more: boolean): Promise<void> {
    const facts = await this.suggestionFacts();
    this.broadcast({ type: 'taskSuggestions', source: 'quick', items: quickSuggestions(facts), recent: facts.recent });
    if (!more) {
      return;
    }
    try {
      const text = await quickPrompt(this.providers, suggestionPrompt(facts), { maxTokens: 700, temperature: 0.4 });
      const items = parseModelSuggestions(text);
      this.broadcast({ type: 'taskSuggestions', source: 'model', items, recent: facts.recent });
      if (!items.length) {
        this.broadcast({ type: 'toast', level: 'info', text: 'The model did not return usable ideas — try again or type your own task.' });
      }
    } catch (e) {
      this.broadcast({ type: 'taskSuggestions', source: 'model', items: [], recent: facts.recent });
      this.broadcast({ type: 'toast', level: 'error', text: `Could not get ideas from the model: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** Open the multitask launcher in the attached chat UI; false when no UI is attached. */
  openLauncher(kind?: 'tasks' | 'bestof'): boolean {
    if (!this.sinks.size) {
      return false;
    }
    this.broadcast({ type: 'openLauncher', kind });
    return true;
  }

  /** Sessions of a Best-of-N group, in creation order. */
  groupSessions(groupId: string): Session[] {
    return this.store
      .list()
      .filter((s) => s.group?.id === groupId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => this.store.get(s.id)!)
      .filter(Boolean);
  }

  /** Remove the worktree of a session that is being deleted. */
  private async dropWorktree(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (session?.worktree && this.worktrees) {
      await this.worktrees.remove(session.worktree).catch(() => undefined);
    }
  }

  /** Delete worktrees left behind by sessions that no longer exist (e.g. after a crash). */
  async pruneWorktrees(): Promise<number> {
    if (!this.worktrees || !this.workspace.root) {
      return 0;
    }
    const repo = await this.worktrees.repoRoot(this.workspace.root);
    if (!repo) {
      return 0;
    }
    return this.worktrees.prune(repo, new Set(this.store.list().map((s) => s.id)));
  }

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  async handle(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return this.sendInit();
      case 'booted':
        return;
      case 'newSession': {
        const s = this.createSession(msg.mode ?? 'agent');
        const text = msg.text?.trim();
        if (text) {
          s.title = text.slice(0, 60);
          this.store.save(s);
        }
        this.setActive(s);
        if (text) {
          // "Send in a new tab": the prompt starts streaming in the fresh session while the previous one keeps running.
          void this.send(s.id, text, msg.attachments ?? [], msg.images);
        }
        return;
      }
      case 'runParallel': {
        const tasks = msg.tasks.map((t) => t.trim()).filter(Boolean);
        if (tasks.length) {
          await this.runParallel(tasks, msg.mode ?? 'agent');
        }
        return;
      }
      case 'selectSession': {
        const s = this.store.get(msg.id);
        if (s) {
          this.setActive(s);
        }
        return;
      }
      case 'deleteSession':
        this.stop(msg.id);
        this.tracker.keep(msg.id);
        await this.dropWorktree(msg.id);
        await this.store.delete(msg.id);
        if (this.activeSessionId === msg.id) {
          const next = this.store.list()[0]?.id;
          const s = next ? this.store.get(next) : undefined;
          if (s) {
            this.setActive(s);
          } else {
            await this.handle({ type: 'newSession' });
          }
        }
        return;
      case 'deleteSessions': {
        for (const id of msg.ids) {
          await this.handle({ type: 'deleteSession', id });
        }
        return;
      }
      case 'clearHistory':
        await this.clearHistory({ keepPinned: msg.keepPinned !== false });
        return;
      case 'renameSession':
        return this.store.rename(msg.id, msg.title);
      case 'pinSession':
        return this.store.togglePin(msg.id);
      case 'forkSession': {
        const s = this.store.fork(msg.id, msg.uptoIndex);
        if (s) {
          this.setActive(s);
        }
        return;
      }
      case 'exportSession': {
        const md = await this.store.exportMarkdown(msg.id);
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
        await vscode.window.showTextDocument(doc);
        return;
      }
      case 'send':
        await this.send(msg.sessionId, msg.text, msg.attachments ?? [], msg.images);
        return;
      case 'retry':
        await this.retry(msg.sessionId);
        return;
      case 'dismissSkillTopic':
        await this.learner?.dismiss(msg.topic);
        return;
      case 'installCatalogSkill': {
        if (!this.catalog) {
          return;
        }
        const entries = await this.catalog.entries();
        const entry = entries.find((e) => e.name === msg.name && e.repo === msg.repo) ?? entries.find((e) => e.name === msg.name);
        if (!entry) {
          void vscode.window.showWarningMessage(`"${msg.name}" is no longer in the skill catalog.`);
          return;
        }
        const cfg = getConfig();
        const dest = skillsDestination(cfg.skillAutoInstallScope, this.workspace.root);
        try {
          const one = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing skill "${entry.name}" from ${entry.repo}…` }, () => this.catalog!.install(entry, dest, { replace: true }));
          await this.skills.refresh();
          if (one) {
            void vscode.window.showInformationMessage(`Installed "${one.name}" into ${dest}. Send your request again or force it with /skill ${one.name} <task>.`);
          }
        } catch (e) {
          void vscode.window.showErrorMessage(`Could not install "${entry.name}": ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      case 'dismissCatalogSkill':
        await this.catalog?.dismiss(msg.name);
        return;
      case 'openMarkdown': {
        const title = msg.title?.trim() || this.store.get(this.activeSessionId ?? '')?.title || 'Answer';
        if (this.markdownViewer) {
          await this.markdownViewer.showText(msg.text, title.slice(0, 80));
        } else {
          const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: msg.text });
          await vscode.window.showTextDocument(doc, { preview: false });
        }
        return;
      }
      case 'stop':
        return this.stop(msg.sessionId);
      case 'pause':
        return void this.pause(msg.sessionId);
      case 'resume':
        return void this.resume(msg.sessionId);
      case 'steer':
        await this.steer(msg.sessionId, msg.text, msg.attachments ?? [], msg.images);
        return;
      case 'stopChild':
        return void this.childControl(msg.sessionId, msg.childId)?.stop();
      case 'pauseChild':
        return void this.childControl(msg.sessionId, msg.childId)?.pause();
      case 'resumeChild':
        return void this.childControl(msg.sessionId, msg.childId)?.resume();
      case 'approval': {
        const resolve = this.approvals.get(msg.id);
        if (resolve) {
          this.approvals.delete(msg.id);
          resolve(msg.approved);
          this.broadcast({ type: 'approvalResolved', id: msg.id });
        }
        return;
      }
      case 'setModel': {
        const s = this.store.get(msg.sessionId);
        if (s) {
          s.model = msg.model;
          this.store.save(s);
        }
        if (msg.makeDefault) {
          await setDefaultModel(msg.model);
        }
        return;
      }
      case 'setMode': {
        const s = this.store.get(msg.sessionId);
        if (s) {
          s.mode = msg.mode;
          this.store.save(s);
        }
        return;
      }
      case 'refreshModels':
        await this.providers.listModels(true);
        return this.pushModels();
      case 'openFile': {
        const root = this.workspace.root;
        const uri = msg.path.startsWith('/') || /^[a-z]:\\/i.test(msg.path) ? vscode.Uri.file(msg.path) : root ? vscode.Uri.joinPath(vscode.Uri.file(root), msg.path) : undefined;
        if (!uri) {
          return;
        }
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const ed = await vscode.window.showTextDocument(doc, { preview: true });
          if (msg.line) {
            const pos = new vscode.Position(Math.max(0, msg.line - 1), 0);
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
        } catch {
          this.broadcast({ type: 'toast', level: 'error', text: `Cannot open ${msg.path}` });
        }
        return;
      }
      case 'insertCode': {
        const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
        if (!ed) {
          this.broadcast({ type: 'toast', level: 'error', text: 'No active editor to insert into' });
          return;
        }
        await ed.edit((b) => (ed.selection.isEmpty ? b.insert(ed.selection.active, msg.code) : b.replace(ed.selection, msg.code)));
        return;
      }
      case 'applyCodeToFile': {
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
          this.broadcast({ type: 'toast', level: 'error', text: 'Open the target file first' });
          return;
        }
        const full = new vscode.Range(0, 0, ed.document.lineCount, 0);
        await ed.edit((b) => b.replace(full, msg.code));
        return;
      }
      case 'attachRef':
        // Special context chip (e.g. @terminal) added from a command outside the webview.
        this.broadcast({ type: 'toast', level: 'info', text: `attach:@${msg.ref.replace(/^@/, '')}` });
        return;
      case 'attachActive':
      case 'pickAttachment':
        return; // handled by the view (needs the session's local attachment list)
      case 'compactNow': {
        const s = this.store.get(msg.sessionId);
        if (!s || this.isRunning(s.id)) {
          return;
        }
        const { provider, model } = await this.providers.resolve(s.model);
        const cm = new ContextManager({ compactionThreshold: 0, maxToolOutputChars: getConfig().maxToolOutputChars });
        const res = await cm.compact(s.messages, provider, model, undefined, 4);
        s.messages = res.messages;
        s.compactions++;
        s.contextTokens = res.after;
        this.store.save(s);
        this.broadcast({ type: 'session', session: s });
        this.broadcast({ type: 'toast', level: 'info', text: `Compacted: ${res.before} → ${res.after} tokens` });
        return;
      }
      case 'clearSession': {
        const s = this.store.get(msg.sessionId);
        if (s && !this.isRunning(s.id)) {
          s.messages = [];
          s.contextTokens = 0;
          s.compactions = 0;
          s.todos = [];
          s.workingSet = [];
          this.store.save(s);
          this.broadcast({ type: 'session', session: s });
        }
        return;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('localpilot.openSettings', msg.section);
        return;
      case 'autoSetupModels':
        await vscode.commands.executeCommand('localpilot.autoSetupModels');
        return;
      case 'openExternal':
        if (/^https?:\/\//i.test(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
      case 'openInEditor':
        await vscode.commands.executeCommand('localpilot.openChatInEditor');
        return;
      case 'attachUri': {
        try {
          const uri = vscode.Uri.parse(msg.uri);
          if (uri.scheme === 'file') {
            const img = await readImage(uri.fsPath);
            if (img) {
              this.broadcast({ type: 'image', image: img });
            } else {
              this.broadcast({ type: 'toast', level: 'info', text: `attach:${vscode.workspace.asRelativePath(uri)}` });
            }
          }
        } catch {
          /* ignore */
        }
        return;
      }
      case 'pickImage':
        for (const img of await pickImages()) {
          this.broadcast({ type: 'image', image: img });
        }
        return;
      case 'captureUrl':
        await this.captureUrl(msg.url, { mobile: msg.mobile, fullPage: msg.fullPage });
        return;
      case 'inspectUrl':
        await this.inspectUrl(msg.url, { mobile: msg.mobile });
        return;
      case 'openBrowser': {
        const url = msg.url || (await this.askUrl('Open in the VS Code browser view'));
        if (url) {
          try {
            await openInBrowser(url);
          } catch (e) {
            this.broadcast({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) });
          }
        }
        return;
      }
      case 'captureScreenshot': {
        const mode = msg.mode ?? 'region';
        const img = await captureScreenshot(mode, { delayMs: msg.delayMs });
        if (img) {
          this.broadcast({ type: 'image', image: img });
        } else {
          const hint = process.platform === 'linux' ? ' (install gnome-screenshot, spectacle, scrot or grim+slurp)' : '';
          this.broadcast({ type: 'toast', level: 'error', text: mode === 'region' || mode === 'window' ? `Screenshot cancelled${hint}` : `Screenshot failed${hint}` });
        }
        return;
      }
      case 'requestOpenFiles':
        this.broadcast({ type: 'openFiles', files: this.workspace.openEditors() });
        return;
      case 'keepChanges':
        this.tracker.keep(msg.sessionId, msg.fsPath);
        return;
      case 'undoChanges': {
        const n = await this.tracker.undo(msg.sessionId, msg.fsPath);
        this.broadcast({ type: 'toast', level: 'info', text: `Reverted ${n} file${n === 1 ? '' : 's'}` });
        return;
      }
      case 'showDiff': {
        const s = this.store.get(msg.sessionId);
        if (s?.worktree && msg.fsPath.startsWith(s.worktree.path)) {
          await this.showWorktreeDiff(s, path.relative(s.worktree.path, msg.fsPath));
        } else {
          await this.tracker.showDiff(msg.sessionId, msg.fsPath);
        }
        return;
      }
      case 'applyWorktree':
        await this.applyWorktree(msg.sessionId);
        return;
      case 'discardWorktree':
        await this.discardWorktree(msg.sessionId);
        return;
      case 'openWorktree': {
        const s = this.store.get(msg.sessionId);
        if (s?.worktree) {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.worktree.path), { forceNewWindow: true });
        }
        return;
      }
      case 'runBestOfN':
        await this.runBestOfN(msg.prompt, msg.models, msg.mode ?? 'agent');
        return;
      case 'compareGroup':
        await vscode.commands.executeCommand('localpilot.compareResults', msg.groupId);
        return;
      case 'copyText':
        await vscode.env.clipboard.writeText(msg.text);
        return;
      case 'runParallelPrompt':
        await vscode.commands.executeCommand('localpilot.runParallelTasks');
        return;
      case 'suggestTasks':
        await this.suggestTasks(!!msg.more);
        return;
      case 'buildPlan': {
        const s = this.store.get(msg.sessionId);
        if (!s || this.runs.has(s.id)) {
          return;
        }
        s.mode = 'agent';
        this.store.save(s);
        this.broadcast({ type: 'session', session: s });
        await this.send(s.id, 'Implement the plan: run the checklist with run_todos_parallel, then verify the combined result and summarise.');
        return;
      }
      case 'restoreCheckpoint': {
        const s = this.store.get(msg.sessionId);
        if (!s || this.isRunning(s.id)) {
          this.broadcast({ type: 'toast', level: 'error', text: 'Stop the running agent before restoring a checkpoint' });
          return;
        }
        const target = s.messages[msg.messageIndex];
        if (!target || target.role !== 'user') {
          return;
        }
        const reverted = await this.tracker.restoreToTurn(s.id, msg.messageIndex);
        const prompt = target.content.replace(/<[a-z_]+[^>]*>[\s\S]*?<\/[a-z_]+>\s*/g, '').replace(/\n\n\[\d+ images? attached\]$/, '').trim();
        s.messages = s.messages.slice(0, msg.messageIndex);
        s.contextTokens = 0;
        this.store.save(s);
        this.broadcast({ type: 'session', session: s });
        this.pushChanges(s.id);
        this.broadcast({ type: 'draft', text: prompt });
        this.broadcast({ type: 'toast', level: 'info', text: reverted ? `Restored checkpoint — reverted ${reverted} file${reverted === 1 ? '' : 's'}` : 'Restored checkpoint' });
        return;
      }
    }
  }

  async sendInit(): Promise<void> {
    await this.loaded.catch(() => undefined);
    // The active chat may have been removed behind our back (retention, Settings → clear); never point at a ghost.
    if (!this.activeSessionId || !this.store.get(this.activeSessionId)) {
      this.activeSessionId = this.store.list()[0]?.id ?? this.store.create(getConfig().defaultModel).id;
    }
    // Boot must not wait on model discovery (several servers × health probes can take seconds, or hang on a dead
    // host): send what we know now with the cached model list, then push the fresh list when it arrives.
    const init = (models: ModelInfo[]): ToWebview => ({
      type: 'init',
      sessions: this.store.list(),
      activeSessionId: this.activeSessionId,
      models,
      defaultModel: getConfig().defaultModel,
      skills: this.skills.allSkills.map((s) => ({ name: s.name, description: s.description })),
      agents: this.skills.allAgents.map((a) => ({ name: a.name, description: a.description })),
      running: [...this.runs.keys()],
      paused: this.pausedSessionIds,
      platform: process.platform,
    });
    this.broadcast(init(this.providers.cachedModels()));
    const s = this.activeSession;
    if (s) {
      this.broadcast({ type: 'session', session: s });
      this.pushChanges(s.id);
      this._onDidChangeActive.fire(s);
    }
    await this.pushModels();
  }

  private async pushModels(): Promise<void> {
    const models = await this.providers.listModels().catch(() => []);
    this.broadcast({ type: 'models', models, defaultModel: getConfig().defaultModel });
  }

  /** Entry point used by webviews and commands. Runs are per-session, so several sessions can stream at once. */
  private async askUrl(title: string): Promise<string | undefined> {
    const v = await vscode.window.showInputBox({ title, prompt: 'http(s) URL — a dev server such as localhost:3000, or any web page', placeHolder: 'http://localhost:3000', value: this.lastUrl, ignoreFocusOut: true });
    const url = v?.trim();
    if (url) {
      this.lastUrl = url;
    }
    return url || undefined;
  }
  private lastUrl = '';

  /** Renders a URL headlessly and attaches the screenshot to the composer (also used by the command palette). */
  async captureUrl(url?: string, opts: { mobile?: boolean; fullPage?: boolean } = {}): Promise<boolean> {
    const target = url || (await this.askUrl('Screenshot a web page'));
    if (!target) {
      return false;
    }
    this.broadcast({ type: 'toast', level: 'info', text: `Rendering ${target}…` });
    try {
      const shot = await captureUrl(target, { mobile: opts.mobile, fullPage: opts.fullPage });
      this.broadcast({ type: 'image', image: { name: shot.name, data: shot.data, mime: shot.mime } });
      return true;
    } catch (e) {
      this.broadcast({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** DevTools-style inspection: attaches the screenshot and drafts a message carrying the console/network/perf report. */
  async inspectUrl(url?: string, opts: { mobile?: boolean } = {}): Promise<boolean> {
    const target = url || (await this.askUrl('Inspect a web page (screenshot + console + network)'));
    if (!target) {
      return false;
    }
    this.broadcast({ type: 'toast', level: 'info', text: `Inspecting ${target}…` });
    try {
      const r = await inspectUrl(target, { mobile: opts.mobile, includeText: false });
      if (r.screenshot) {
        this.broadcast({ type: 'image', image: { name: `${new URL(r.finalUrl).hostname}-inspect.png`, data: r.screenshot, mime: 'image/png' } });
      }
      const errors = r.console.filter((c) => c.level === 'error').length;
      const failed = r.network.filter((e) => e.error || (e.status ?? 0) >= 400).length;
      const summary = errors || failed || r.layout.length ? `${errors} console error${errors === 1 ? '' : 's'}, ${failed} failed request${failed === 1 ? '' : 's'}, ${r.layout.length} layout issue${r.layout.length === 1 ? '' : 's'}` : 'no errors detected';
      this.broadcast({ type: 'draft', text: `I inspected ${r.finalUrl} (${summary}). Analyse the screenshot and this DevTools report, explain the root causes and fix them:\n\n\`\`\`\n${formatReport(r, { maxConsole: 15, maxNetwork: 10 })}\n\`\`\`` });
      return true;
    } catch (e) {
      this.broadcast({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async send(sessionId: string, text: string, attachments: string[] = [], images?: string[]): Promise<string> {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (this.runs.has(sessionId)) {
      // Busy: the message becomes a steering instruction for the running agent instead of being refused.
      await this.steer(sessionId, text, attachments, images);
      return '';
    }
    const slash = this.handleSlash(session, text);
    if (slash !== undefined) {
      return slash;
    }
    if (images?.length) {
      try {
        const { model } = await this.providers.resolve(session.model);
        if (!model.supportsVision) {
          this.broadcast({ type: 'toast', level: 'error', text: `${model.name} cannot read images — pick a vision model (gemma4, nemotron-3.5-bolt, qwen2.5vl, llava…)` });
          return '';
        }
      } catch {
        /* resolve errors surface below */
      }
    }

    const control = new RunControl(sessionId);
    this.runs.set(sessionId, control);
    control.onDidChange((c) => this.onControlChange(sessionId, c));
    this.tracker.beginTurn(sessionId, session.messages.length);
    this.runStatus.set(sessionId, 'Starting…');
    this.broadcast({ type: 'running', sessionId, running: true });
    this._onDidChangeRuns.fire();
    await this.ensureWorktree(session, (t) => {
      this.runStatus.set(sessionId, t);
      this.broadcast({ type: 'event', event: { sessionId, type: 'status', payload: t } });
      this._onDidChangeRuns.fire();
    });
    if (control.aborted) {
      this.runs.delete(sessionId);
      this.runStatus.delete(sessionId);
      this.broadcast({ type: 'running', sessionId, running: false });
      this._onDidChangeRuns.fire();
      return '';
    }

    let content = text;
    const attachedBlocks = await Promise.all(attachments.map((a) => this.workspace.readAttachment(a)));
    if (attachedBlocks.some(Boolean)) {
      content = `${attachedBlocks.filter(Boolean).join('\n\n')}\n\n${text}`;
    }
    if (images?.length) {
      content = `${content}\n\n[${images.length} image${images.length === 1 ? '' : 's'} attached]`;
    }
    const userMessage: ChatMessage = { role: 'user', content, images };

    try {
      const result = await this.runner.run({
        session,
        userMessage,
        signal: control.signal,
        control,
        workspaceRoot: session.worktree?.path,
        emit: (e) => {
          this.broadcast({ type: 'event', event: e });
          if (e.type === 'status' && typeof e.payload === 'string') {
            this.runStatus.set(sessionId, e.payload);
            this._onDidChangeRuns.fire();
          } else if (e.type === 'tool_start') {
            const p = e.payload as { name: string };
            this.runStatus.set(sessionId, `Running ${p.name}`);
            this._onDidChangeRuns.fire();
          }
          if (e.type === 'turn_end' || e.type === 'tool_end') {
            this.store.save(session);
            if (session.worktree) {
              this.pushChanges(sessionId);
            }
          }
          if (e.type === 'turn_end' && session.mode === 'plan' && session.todos?.length) {
            void this.savePlan(session, String((e.payload as { text?: string })?.text ?? ''));
          }
        },
        requestApproval: (title, detail, kind) => this.requestApproval(sessionId, title, detail, kind),
      });
      return result;
    } catch (e) {
      // The agent loop already surfaced model failures with a friendlier message; don't show them twice.
      if (!(e as { reported?: boolean }).reported) {
        const msg = e instanceof Error ? e.message : String(e);
        this.broadcast({ type: 'event', event: { sessionId, type: 'error', payload: msg } });
      }
      return '';
    } finally {
      this.runs.delete(sessionId);
      this.runStatus.delete(sessionId);
      this.store.save(session);
      this.broadcast({ type: 'running', sessionId, running: false });
      this._onDidChangeRuns.fire();
      if (session.worktree) {
        this.pushChanges(sessionId);
      }
      // Last agent of a batch done: offer the review (compare and pick for Best of N, review each for split tasks).
      if (session.group && session.group.size > 1 && !this.groupSessions(session.group.id).some((s) => this.runs.has(s.id))) {
        const g = session.group;
        const label = g.kind === 'bestOf' ? 'Compare results' : 'Review results';
        const text = g.kind === 'bestOf' ? `All ${g.size} agents finished “${g.prompt.slice(0, 50)}”. Compare their results and apply the best one.` : `All ${g.size} agents finished their tasks. Review what each one changed and apply what you like.`;
        void vscode.window.showInformationMessage(text, label).then((pick) => {
          if (pick) {
            void vscode.commands.executeCommand('localpilot.compareResults', g.id);
          }
        });
      }
    }
  }

  /** Replays the last user turn after a failure: drops the failed exchange and sends the same message again. */
  async retry(sessionId: string): Promise<string> {
    const session = this.store.get(sessionId);
    if (!session || this.runs.has(sessionId)) {
      return '';
    }
    let idx = session.messages.length - 1;
    while (idx >= 0 && !(session.messages[idx].role === 'user' && !session.messages[idx].meta?.hidden && !session.messages[idx].meta?.toolImages && !session.messages[idx].meta?.summary)) {
      idx--;
    }
    if (idx < 0) {
      return '';
    }
    const last = session.messages[idx];
    session.messages = session.messages.slice(0, idx);
    this.store.save(session);
    this.broadcast({ type: 'session', session });
    // Attachments are already inlined in the stored content, so send it verbatim with no new attachments.
    return this.send(sessionId, last.content.replace(/\n\n\[\d+ images? attached\]$/, ''), [], last.images);
  }

  /** Start a new session for an externally supplied prompt (CLI / URI handler). */
  async runPrompt(prompt: string, mode: Session['mode'] = 'agent', attachments: string[] = []): Promise<string> {
    const s = this.createSession(mode);
    s.title = prompt.slice(0, 60);
    this.setActive(s);
    void this.send(s.id, prompt, attachments);
    return s.id;
  }

  /** Launch several independent agent sessions at once (one per task) and return their ids. */
  async runParallel(tasks: string[], mode: Session['mode'] = 'agent'): Promise<string[]> {
    const ids: string[] = [];
    const groupId = `g_${Date.now().toString(36)}`;
    for (const task of tasks) {
      const s = this.createSession(mode);
      s.title = task.slice(0, 60);
      s.isolated = true;
      s.group = { id: groupId, kind: 'batch', prompt: tasks.length === 1 ? task : `${tasks.length} tasks: ${tasks.map((t) => t.slice(0, 30)).join(' · ')}`, size: tasks.length };
      this.store.save(s);
      ids.push(s.id);
    }
    // Fire all runs without awaiting; each streams into its own session.
    for (let i = 0; i < ids.length; i++) {
      void this.send(ids[i], tasks[i]);
    }
    const first = this.store.get(ids[0]);
    if (first) {
      this.setActive(first);
    }
    return ids;
  }

  /** Creates a chat and applies the retention limit so history cannot grow without bound. */
  private createSession(mode: Session['mode']): Session {
    const cfg = getConfig();
    const s = this.store.create(cfg.defaultModel, mode);
    void this.store.prune(cfg.sessionRetention, [...this.runs.keys(), s.id, ...(this.activeSessionId ? [this.activeSessionId] : [])]).then((n) => {
      if (n) {
        this.log.info(`Session retention: removed ${n} old chat(s) (limit ${cfg.sessionRetention})`);
      }
    });
    return s;
  }

  /**
   * "Clear chat history": removes every idle chat (optionally keeping pinned ones), reverts nothing on disk, stops no
   * agent — running chats are always kept — and leaves the user in a fresh chat. Returns the number removed.
   */
  async clearHistory(opts: { keepPinned?: boolean } = {}): Promise<number> {
    const keep = new Set<string>(this.runs.keys());
    if (opts.keepPinned !== false) {
      for (const s of this.store.list()) {
        if (s.pinned) {
          keep.add(s.id);
        }
      }
    }
    for (const s of this.store.list()) {
      if (!keep.has(s.id)) {
        this.tracker.keep(s.id);
        this.sessionApprovalMemory.delete(s.id);
      }
    }
    const n = await this.store.clearExcept(keep);
    const current = this.activeSessionId ? this.store.get(this.activeSessionId) : undefined;
    if (!current) {
      const next = this.store.list()[0];
      this.setActive(next ? this.store.get(next.id)! : this.createSession('agent'));
    }
    this.broadcast({ type: 'historyCleared', removed: n });
    this.broadcast({ type: 'toast', level: 'info', text: n ? `Cleared ${n} chat${n === 1 ? '' : 's'}${keep.size ? ` · kept ${keep.size} running/pinned` : ''}` : 'Nothing to clear' });
    return n;
  }

  stop(sessionId: string): void {
    this.runs.get(sessionId)?.stop();
    for (const [id, resolve] of this.approvals) {
      if (id.startsWith(sessionId)) {
        resolve(false);
        this.approvals.delete(id);
      }
    }
  }

  /** Hold the agent after its current step; `resume` continues. Returns the new paused state (undefined when not running). */
  pause(sessionId: string): boolean | undefined {
    const c = this.runs.get(sessionId);
    if (!c) {
      return undefined;
    }
    c.pause();
    return true;
  }

  resume(sessionId: string): boolean | undefined {
    const c = this.runs.get(sessionId);
    if (!c) {
      return undefined;
    }
    c.resume();
    return false;
  }

  togglePause(sessionId: string): boolean | undefined {
    const c = this.runs.get(sessionId);
    return c ? c.togglePause() : undefined;
  }

  /** Queue a user message for a running (or paused) agent; it is appended at the next step boundary. */
  async steer(sessionId: string, text: string, attachments: string[] = [], images?: string[]): Promise<boolean> {
    const c = this.runs.get(sessionId);
    if (!c || !text.trim()) {
      return false;
    }
    let content = text;
    const attachedBlocks = await Promise.all(attachments.map((a) => this.workspace.readAttachment(a)));
    if (attachedBlocks.some(Boolean)) {
      content = `${attachedBlocks.filter(Boolean).join('\n\n')}\n\n${text}`;
    }
    const id = `steer_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    c.steer({ role: 'user', content, images, meta: { steerId: id } });
    this.broadcast({ type: 'steerQueued', sessionId, id, content: text, images });
    this.runStatus.set(sessionId, c.holding ? 'Paused · 1 message waiting' : 'Will take your message into account at the next step');
    this._onDidChangeRuns.fire();
    return true;
  }

  private onControlChange(sessionId: string, c: RunControl): void {
    const root = this.runs.get(sessionId);
    if (!root) {
      return;
    }
    if (c === root) {
      if (c.holding) {
        this.runStatus.set(sessionId, c.pendingSteering ? `Paused · ${c.pendingSteering} message${c.pendingSteering === 1 ? '' : 's'} waiting` : 'Paused');
      } else if (c.paused) {
        this.runStatus.set(sessionId, 'Pausing after this step…');
      } else if (this.runStatus.get(sessionId)?.startsWith('Paus')) {
        this.runStatus.set(sessionId, 'Resuming…');
      }
      this.broadcast({ type: 'paused', sessionId, paused: c.pausedBySelf, holding: c.holding });
    } else {
      this.broadcast({ type: 'paused', sessionId, childId: c.id, agent: c.label, paused: c.pausedBySelf, holding: c.holding });
    }
    this._onDidChangeRuns.fire();
  }

  requestApproval(sessionId: string, title: string, detail: string, kind: string): Promise<boolean> {
    const remembered = this.sessionApprovalMemory.get(sessionId);
    if (remembered?.has(kind)) {
      return Promise.resolve(true);
    }
    const id = `${sessionId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<boolean>((resolve) => {
      this.approvals.set(id, resolve);
      if (this.sinks.size === 0) {
        // No UI attached (e.g. chat participant path) — fall back to a native dialog.
        void vscode.window.showWarningMessage(`${title}\n${detail}`.slice(0, 1000), { modal: true }, 'Allow', 'Allow for session').then((choice) => {
          if (choice === 'Allow for session') {
            this.rememberApproval(sessionId, kind);
          }
          this.approvals.delete(id);
          resolve(!!choice);
        });
        return;
      }
      this.broadcast({ type: 'approval', id, sessionId, title, detail, kind });
      if (![...this.sinks].some((s) => !s.visible || s.visible())) {
        // Chat UI exists but is hidden: mirror the prompt as a notification so a background agent never stalls unnoticed.
        const session = this.store.get(sessionId);
        void vscode.window
          .showWarningMessage(`LocalPilot${session ? ` · ${session.title}` : ''}: ${title}`, 'Allow', 'Allow for session', 'Deny', 'Show chat')
          .then((choice) => {
            if (!this.approvals.has(id)) {
              return; // already answered in the webview
            }
            if (choice === 'Show chat') {
              void vscode.commands.executeCommand('localpilot.openChat');
              return;
            }
            if (choice === undefined) {
              return; // notification dismissed; the webview prompt stays open
            }
            if (choice === 'Allow for session') {
              this.rememberApproval(sessionId, kind);
            }
            this.approvals.delete(id);
            resolve(choice !== 'Deny');
            this.broadcast({ type: 'approvalResolved', id });
          });
      }
    });
  }

  rememberApproval(sessionId: string, kind: string): void {
    const set = this.sessionApprovalMemory.get(sessionId) ?? new Set<string>();
    set.add(kind);
    this.sessionApprovalMemory.set(sessionId, set);
  }

  /** Slash commands handled locally (no model call). Returns undefined when the text is a normal prompt. */
  private handleSlash(session: Session, text: string): string | undefined {
    const m = /^\/(\w+)\s*(.*)$/s.exec(text.trim());
    if (!m) {
      return undefined;
    }
    const [, cmd, rest] = m;
    const say = (t: string) => {
      session.messages.push({ role: 'user', content: text, meta: { timestamp: Date.now() } }, { role: 'assistant', content: t, meta: { timestamp: Date.now() } });
      this.store.save(session);
      this.broadcast({ type: 'session', session });
      return t;
    };
    switch (cmd) {
      case 'help':
        return say(
          [
            '**Slash commands**',
            '- `/model <provider/model>` — switch model for this session',
            '- `/mode agent|ask|plan` — switch mode',
            '- `/compact` — summarise older messages to free context',
            '- `/clear` — clear this session',
            '- `/skills` — list skills · `/agents` — list subagents',
            '- `/skill <name> <task>` — run a task with a skill preloaded · `/skill install <owner/repo|url|folder>` — install a skill · `/skill browse [words]` — search the skill catalog',
            '- `/agent <name> <task>` — delegate directly to a subagent',
            '- `/context` — show context usage',
          ].join('\n')
        );
      case 'skills':
        return say(this.skills.allSkills.map((s) => `- **${s.name}** (${s.source}): ${s.description}`).join('\n') || 'No skills found. Add folders with SKILL.md under `.localpilot/skills/`.');
      case 'agents':
        return say(this.skills.allAgents.map((a) => `- **${a.name}** (${a.source}): ${a.description}`).join('\n'));
      case 'context':
        return say(`Context: ~${session.contextTokens.toLocaleString()} tokens · ${session.messages.length} messages · ${session.compactions} compactions · model ${session.model || '(default)'}`);
      case 'clear':
        void this.handle({ type: 'clearSession', sessionId: session.id });
        return '';
      case 'compact':
        void this.handle({ type: 'compactNow', sessionId: session.id });
        return '';
      case 'mode':
        if ((ALL_MODES as readonly string[]).includes(rest.trim())) {
          session.mode = rest.trim() as Session['mode'];
          this.store.save(session);
          this.broadcast({ type: 'session', session });
          return '';
        }
        return say('Usage: `/mode agent|ask|plan`');
      case 'model':
        if (rest.trim()) {
          session.model = rest.trim();
          this.store.save(session);
          this.broadcast({ type: 'session', session });
          return '';
        }
        return say('Usage: `/model provider/model-id`');
      case 'skill': {
        const [name, ...task] = rest.trim().split(/\s+/);
        if (name === 'install' || name === 'add') {
          void vscode.commands.executeCommand('localpilot.installSkill', task.length ? { source: task.join(' ') } : undefined);
          return say(task.length ? `Installing skill from ${task.join(' ')}…` : 'Opening the skill installer…');
        }
        if (name === 'browse' || name === 'search' || name === 'catalog') {
          void vscode.commands.executeCommand('localpilot.browseSkills', task.join(' '));
          return say('Opening the skill catalog…');
        }
        const skill = this.skills.getSkill(name);
        if (!skill) {
          const hint = /[/:.]/.test(name) ? ` To install a skill from GitHub or a URL use \`/skill install ${name}\`.` : '';
          return say(`Unknown skill "${name}". Try /skills.${hint}`);
        }
        void this.send(session.id, `Use the "${name}" skill for this task: ${task.join(' ') || 'follow the skill instructions.'}\nFirst call load_skill("${name}"), then perform every step the skill describes using the tools, then report what you did.`);
        return '';
      }
      case 'agent': {
        const [name, ...task] = rest.trim().split(/\s+/);
        if (!this.skills.getAgent(name)) {
          return say(`Unknown subagent "${name}". Try /agents.`);
        }
        void this.send(session.id, `Delegate this to the "${name}" subagent via run_subagent and relay its report: ${task.join(' ')}`);
        return '';
      }
      default:
        return undefined; // let the model see it
    }
  }

  dispose(): void {
    for (const [, c] of this.runs) {
      c.stop();
    }
    clearTimeout(this.deltaTimer);
    this.pendingDeltas.clear();
    this._onDidChangeActive.dispose();
    this._onDidChangeRuns.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
