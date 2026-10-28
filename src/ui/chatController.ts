import * as vscode from 'vscode';
import { Telemetry } from '../telemetry/telemetry';
import { AgentRunner } from '../agent/agentLoop';
import { SkillLearner } from '../agent/skillRecommender';
import { SkillCatalog } from '../agent/skillCatalog';
import { skillsDestination } from '../agent/skillInstaller';
import { ChangeTracker } from '../agent/changeTracker';
import { SkillManager } from '../agent/skills';
import { getConfig, setDefaultModel, setSkillEnabled } from '../config';
import { ContextManager, effectiveContextWindow } from '../context/contextManager';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { isEmptySession, SessionSearchHit, SessionStore } from '../sessions/sessionStore';
import { AgentEvent, ALL_MODES, ChatMessage, ModelInfo, Session } from '../types';
import { captureUrl, inspectUrl, openInBrowser } from '../tools/browser';
import { formatReport } from '../tools/cdp';
import { captureScreenshot, ImageAttachment, pickImages, readImage, ScreenshotMode } from './images';
import { RunControl } from '../agent/runControl';
import { WorktreeChange, WorktreeManager } from '../agent/worktrees';
import { parseModelSuggestions, quickSuggestions, SuggestionFacts, suggestionPrompt, TaskSuggestion } from '../agent/taskSuggestions';
import { quickPrompt } from './inlineEdit';
import { findRipgrep, runProcess } from '../tools/search';
import { CommandManager, CustomCommand, expandCommand } from '../agent/commands';
import * as path from 'path';

/** Custom slash commands as listed for the composer's autocomplete. */
export type CommandListItem = { invoke: string; description: string; argumentHint?: string; source: string };

/**
 * Actionable skill suggestions from a session's last request (install a registry skill, create one for a recurring
 * request, use one just installed). Kept until the next request so they outlive the live turn they arrived with.
 */
export type SkillOffer = {
  available?: { name: string; description: string; repo: string };
  create?: { topic: string; slug: string; count: number; samples: string[] };
  ready?: { name: string; prompt: string };
};

export type ToWebview =
  | { type: 'init'; sessions: ReturnType<SessionStore['list']>; activeSessionId?: string; models: ModelInfo[]; defaultModel: string; contextWindow: number; skills: { name: string; description: string }[]; agents: { name: string; description: string }[]; commands?: CommandListItem[]; skillsMode: 'auto' | 'ask' | 'off'; running: string[]; paused: string[]; platform: NodeJS.Platform }
  | { type: 'sessions'; sessions: ReturnType<SessionStore['list']> }
  /**
   * `liveFrom` is set while the session is running: messages from that index on belong to the turn in flight and are
   * drawn from the live event stream (see `replay`), not from the transcript — otherwise a tab switch or reopen
   * mid-run would show every step twice.
   */
  | { type: 'session'; session: Session; liveFrom?: number; offers?: SkillOffer }
  /**
   * Everything a freshly created webview missed about a run in flight, in the order it happened: events (text
   * deltas coalesced), queued steering messages and the approvals still waiting for an answer. `startedAt` keeps the
   * elapsed-time counter honest; `truncated` means the run outgrew the buffer and only its tail is replayed.
   */
  | { type: 'replay'; sessionId: string; items: ToWebview[]; startedAt: number; status?: string; truncated: boolean }
  /** `contextWindow` is the `localpilot.contextWindow` setting (0 = model maximum) so the meter shows the window a model is actually given. */
  /** `autoModel`: the id the router would answer an Auto chat with right now (the default model if set and reachable, else the best fit). */
  | { type: 'models'; models: ModelInfo[]; defaultModel: string; autoModel?: string; contextWindow: number; providerNames?: Record<string, string> }
  | { type: 'skills'; skills: { name: string; description: string }[]; agents: { name: string; description: string }[]; commands?: CommandListItem[]; skillsMode: 'auto' | 'ask' | 'off' }
  | { type: 'event'; event: AgentEvent }
  /** Result of an Install click on a registry skill offer, so the chip can settle or offer a retry. */
  | { type: 'skillInstall'; sessionId: string; name: string; ok: boolean; error?: string }
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
  /** Answer to `searchSessions`: chats whose messages contain the query, with the matching line. */
  | { type: 'searchResults'; query: string; hits: SessionSearchHit[] }
  /** Task ideas for the multitask launcher: `quick` ones come instantly from the workspace, `model` ones from the model. */
  | { type: 'taskSuggestions'; source: 'quick' | 'model'; items: TaskSuggestion[]; recent: string[] }
  /** Open the multitask launcher (from the Command Palette / Agents view). */
  | { type: 'openLauncher'; kind?: 'tasks' | 'bestof' }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'booted' }
  | { type: 'newSession'; mode?: Session['mode']; text?: string; attachments?: string[]; images?: string[] }
  | { type: 'runParallel'; tasks: string[]; mode?: Session['mode'] }
  | { type: 'selectSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'deleteSessions'; ids: string[] }
  | { type: 'clearHistory'; keepPinned?: boolean }
  | { type: 'searchSessions'; query: string }
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
  /** The user is about to send (composer focused / typing): load the session's model so the first token comes sooner. */
  | { type: 'warm'; sessionId: string }
  | { type: 'setMode'; sessionId: string; mode: Session['mode'] }
  | { type: 'setSkills'; sessionId: string; mode?: string | null; pinned?: string[] }
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
  /** The webview's script hit an error (uncaught exception, rejected promise or a handler that threw): logged host-side so a dead UI is never silent. */
  | { type: 'clientError'; where: string; message: string; stack?: string }
  | { type: 'keepChanges'; sessionId: string; fsPath?: string }
  | { type: 'undoChanges'; sessionId: string; fsPath?: string }
  | { type: 'showDiff'; sessionId: string; fsPath: string }
  | { type: 'restoreCheckpoint'; sessionId: string; messageIndex: number }
  /** Edit & resend: drop this user message and everything after it, keep files as they are, put the text in the composer. */
  | { type: 'editMessage'; sessionId: string; messageIndex: number }
  | { type: 'runParallelPrompt' }
  | { type: 'dismissSkillTopic'; topic: string }
  /** Install a catalog skill offered under a request (`skills.autoInstall: ask`). */
  | { type: 'installCatalogSkill'; name: string; repo: string; sessionId?: string }
  | { type: 'dismissCatalogSkill'; name: string; sessionId?: string }
  | { type: 'openMarkdown'; text: string; title?: string }
  | { type: 'copyText'; text: string };

export interface Sink {
  post(msg: ToWebview): void;
  /** Whether the user can currently see this surface; approvals raised while nothing is visible also get a notification. */
  visible?: () => boolean;
}

/** An approval the agent is waiting on; kept so a re-created webview can show the prompt again and a hidden one can mirror it as a notification. */
interface PendingApproval {
  sessionId: string;
  title: string;
  detail: string;
  kind: string;
  resolve: (ok: boolean) => void;
  /** A native notification for this prompt is already on screen. */
  mirrored: boolean;
}

/**
 * What a webview that was closed (or opened late) needs in order to rebuild a run in flight. Messages the loop has
 * already appended to the session (from `base` on) are *not* drawn from the transcript while the run lasts; the
 * replayed items cover them, exactly as the live stream did.
 */
interface RunReplay {
  base: number;
  /** The run's own user message once the loop has appended it; lets `base` be recomputed after a compaction rewrites the array. */
  anchor?: ChatMessage;
  startedAt: number;
  items: ToWebview[];
  bytes: number;
  truncated: boolean;
}

/** Tool results bigger than this are trimmed in the replay buffer; the full text is in the transcript once the run ends. */
const REPLAY_RESULT_LIMIT = 16_000;
/** Beyond this the buffer restarts from the messages persisted so far (only the tail of a very long run is replayed). */
const REPLAY_BYTES_LIMIT = 6_000_000;

/** Shared brain behind the sidebar view, editor panels and the @localpilot chat participant. */
export class ChatController implements vscode.Disposable {
  private sinks = new Set<Sink>();
  private runs = new Map<string, RunControl>();
  private replays = new Map<string, RunReplay>();
  private offers = new Map<string, SkillOffer>();
  private approvals = new Map<string, PendingApproval>();
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
  /** Local-only worktree metrics for the dashboard. */
  telemetry?: Pick<Telemetry, 'record'>;
  private _commands?: CommandManager;
  private commandsSub?: vscode.Disposable;
  /** Custom slash commands (.claude/commands, .localpilot/commands, plugins); set by the extension host. */
  get commands(): CommandManager | undefined {
    return this._commands;
  }
  set commands(m: CommandManager | undefined) {
    this.commandsSub?.dispose();
    this._commands = m;
    this.commandsSub = m?.onDidChange(() => this.broadcast(this.skillsMsg()));
  }

  private commandList(): CommandListItem[] {
    return (this._commands?.all ?? []).map((c) => ({ invoke: c.invoke, description: c.description, argumentHint: c.argumentHint, source: c.plugin ? `plugin:${c.plugin}` : c.source }));
  }

  private skillsMsg(): ToWebview {
    return { type: 'skills', skills: this.skills.enabledSkills.map((s) => ({ name: s.name, description: s.description })), agents: this.skills.allAgents.map((a) => ({ name: a.name, description: a.description })), commands: this.commandList(), skillsMode: getConfig().skillAutoInstall };
  }

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
    // Running chats and the one on screen keep their transcript in memory; the rest can be read back on demand.
    store.inUse = (id) => this.runs.has(id) || id === this.activeSessionId;
    this.disposables.push(
      store.onDidChange(() => this.broadcast({ type: 'sessions', sessions: store.list() })),
      providers.onDidChange(() => void this.pushModels()),
      // New/installed/removed skills and subagents show up in `/skill`, `/agent` and the suggestion chips right away.
      skills.onDidChange(() => this.broadcast(this.skillsMsg())),
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
    return new vscode.Disposable(() => {
      this.sinks.delete(sink);
      // The surface that showed a pending prompt is gone; make sure the user can still answer it.
      this.mirrorPendingApprovals();
    });
  }

  /** Short notice in every attached chat surface (hook messages, command notes). */
  toast(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.broadcast({ type: 'toast', level, text });
  }

  /** Called by hosts when a chat surface is hidden or shown — a prompt nobody can see is mirrored as a notification. */
  surfaceVisibilityChanged(): void {
    this.mirrorPendingApprovals();
  }

  private anySurfaceVisible(): boolean {
    return [...this.sinks].some((s) => !s.visible || s.visible());
  }

  /** Prefills the composer (used by Settings → "Create skill" and other entry points). */
  draft(text: string): void {
    // A view revealed just now may still be loading; it picks the draft up when it boots.
    this.pendingDraft = { text, at: Date.now() };
    this.broadcast({ type: 'draft', text });
  }
  private pendingDraft?: { text: string; at: number };

  private broadcast(msg: ToWebview): void {
    this.record(msg);
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

  /** Session id a UI message belongs to, for the replay buffer. */
  private static sessionOf(msg: ToWebview): string | undefined {
    switch (msg.type) {
      case 'event':
        return msg.event.sessionId;
      case 'steerQueued':
      case 'approval':
      case 'paused':
        return msg.sessionId;
      default:
        return undefined;
    }
  }

  /** Appends a run-scoped UI message to its session's replay buffer (no-op for sessions that are not running). */
  private record(msg: ToWebview): void {
    const sid = ChatController.sessionOf(msg);
    const r = sid ? this.replays.get(sid) : undefined;
    if (!r) {
      return;
    }
    if (msg.type === 'event') {
      const e = msg.event;
      if ((e.type === 'assistant_delta' || e.type === 'thinking_delta') && typeof e.payload === 'string') {
        const last = r.items[r.items.length - 1];
        if (last?.type === 'event' && last.event.type === e.type && typeof last.event.payload === 'string') {
          last.event.payload += e.payload;
        } else {
          r.items.push({ type: 'event', event: { ...e } });
        }
        r.bytes += e.payload.length;
      } else if (e.type === 'tool_end') {
        // Results are shown collapsed in the step row; a huge one is trimmed here and read in full from the transcript later.
        const p = e.payload as { content?: unknown; data?: { content?: unknown } } | undefined;
        const trim = (c: unknown) => (typeof c === 'string' && c.length > REPLAY_RESULT_LIMIT ? `${c.slice(0, REPLAY_RESULT_LIMIT)}\n… (${(c.length - REPLAY_RESULT_LIMIT).toLocaleString()} more characters)` : c);
        const payload = p && typeof p === 'object' ? { ...p, content: trim(p.content), ...(p.data && typeof p.data === 'object' && 'content' in p.data ? { data: { ...p.data, content: trim(p.data.content) } } : {}) } : p;
        r.items.push({ type: 'event', event: { ...e, payload } });
        r.bytes += typeof (payload as { content?: unknown } | undefined)?.content === 'string' ? ((payload as { content: string }).content.length) : 200;
      } else {
        if (e.type === 'steer') {
          this.forgetSteers(sid!, ((e.payload as { ids?: string[] } | undefined)?.ids) ?? []);
        }
        r.items.push(msg);
        r.bytes += 200;
      }
    } else {
      if (msg.type === 'paused') {
        // Only the latest pause state of the run / of each worker matters.
        r.items = r.items.filter((m) => !(m.type === 'paused' && m.childId === msg.childId));
      }
      r.items.push(msg);
      r.bytes += msg.type === 'steerQueued' ? msg.content.length + 200 : 400;
    }
    if (r.bytes > REPLAY_BYTES_LIMIT) {
      // Restart from what is persisted: a late webview shows those messages from the transcript and only the tail live.
      const session = this.store.get(sid!);
      r.base = session ? session.messages.length : r.base;
      r.anchor = undefined;
      r.items = r.items.filter((m) => m.type === 'approval' || m.type === 'steerQueued');
      r.bytes = 0;
      r.truncated = true;
    }
  }

  /** An approval has been answered (or the agent moved on): it must not be shown again on reopen. */
  private forgetApproval(id: string): void {
    for (const r of this.replays.values()) {
      const i = r.items.findIndex((m) => m.type === 'approval' && m.id === id);
      if (i >= 0) {
        r.items.splice(i, 1);
      }
    }
  }

  /** Steering rows the loop has injected are part of the event stream now; drop the queued copies so a replay shows them once. */
  private forgetSteers(sessionId: string, ids: string[]): void {
    const r = this.replays.get(sessionId);
    if (r && ids.length) {
      const drop = new Set(ids);
      r.items = r.items.filter((m) => !(m.type === 'steerQueued' && drop.has(m.id)));
    }
  }

  /**
   * Index of the first message the current run appended. Compaction replaces the array with `[summary, ...recent]`
   * (same objects for the kept tail), so the run's user message is looked up again rather than trusting the index.
   */
  private runBase(session: Session, r: RunReplay): number {
    if (!r.anchor) {
      const first = session.messages[r.base];
      if (first && first.role === 'user' && !first.meta?.hidden && !first.meta?.summary) {
        r.anchor = first;
      }
      return r.base;
    }
    const idx = session.messages.indexOf(r.anchor);
    if (idx >= 0) {
      r.base = idx;
    } else {
      // The run's opening message went into the summary: everything after the last summary is this run's.
      let last = -1;
      session.messages.forEach((m, i) => { if (m.meta?.summary) { last = i; } });
      r.base = Math.min(last + 1, session.messages.length);
    }
    return r.base;
  }

  /** `session` message for the UI; while the session runs, the turn in flight is drawn from the replay stream instead of the transcript. */
  private sessionMsg(session: Session): ToWebview {
    const offers = this.offers.get(session.id);
    const r = this.replays.get(session.id);
    if (!r) {
      return { type: 'session', session, offers };
    }
    const base = Math.min(this.runBase(session, r), session.messages.length);
    // The user's own message of the turn is shown from the transcript; everything the loop appended after it is live.
    const first = session.messages[base];
    const liveFrom = first && first === r.anchor ? base + 1 : base;
    return { type: 'session', session, liveFrom, offers };
  }

  /** Updates a session's skill offers and redraws it where it is shown. */
  private setOffers(sessionId: string, next: SkillOffer | undefined): void {
    if (next && (next.available || next.create || next.ready)) {
      this.offers.set(sessionId, next);
    } else {
      this.offers.delete(sessionId);
    }
    const s = this.store.peek(sessionId);
    if (s && !this.runs.has(sessionId)) {
      this.broadcast(this.sessionMsg(s));
    }
  }

  /** What a newly attached webview needs to show a run in flight as if it had been watching all along. */
  private replayMsg(sessionId: string): ToWebview | undefined {
    const r = this.replays.get(sessionId);
    return r ? { type: 'replay', sessionId, items: r.items, startedAt: r.startedAt, status: this.runStatus.get(sessionId), truncated: r.truncated } : undefined;
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
    this.broadcast(this.sessionMsg(s));
    this.pushChanges(s.id);
    this._onDidChangeActive.fire(s);
  }

  private pushChanges(sessionId: string): void {
    // Coalesced: tool results can land many times a second (parallel reads, several workers), and each push shells
    // out to git for worktree sessions. One computation in flight per session; a request that arrives meanwhile
    // runs once more afterwards so the result is never stale.
    const st = this.pushState.get(sessionId) ?? { pending: false, running: false };
    this.pushState.set(sessionId, st);
    if (st.running) {
      st.pending = true;
      return;
    }
    if (st.timer) {
      return;
    }
    st.timer = setTimeout(() => {
      st.timer = undefined;
      st.running = true;
      void this.pushChangesAsync(sessionId)
        .catch((e) => this.log.warn(`changes for ${sessionId}: ${String(e)}`))
        .finally(() => {
          st.running = false;
          if (st.pending) {
            st.pending = false;
            this.pushChanges(sessionId);
          }
        });
    }, 150);
  }
  private readonly pushState = new Map<string, { pending: boolean; running: boolean; timer?: ReturnType<typeof setTimeout> }>();

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
      const started = Date.now();
      session.worktree = await this.worktrees.create(repo, session.id, { progress: status });
      session.isolated = true;
      this.store.save(session);
      this.telemetry?.record({ type: 'worktree', action: 'create', durationMs: Date.now() - started });
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
      this.telemetry?.record({ type: 'worktree', action: 'apply', files: res.files.length, conflicts: res.conflicts.length });
      // Further work in the worktree is measured from here, so applying again never re-applies these changes.
      await this.worktrees.rebase(wt);
      this.store.save(session);
      this.tracker.keep(sessionId); // applied = the user's decision; the workspace diff is now visible in git itself
      this.pushChanges(sessionId);
      this.broadcast({
        type: 'toast',
        level: res.conflicts.length ? 'error' : 'info',
        text: res.conflicts.length ? `Applied ${res.files.length} file${res.files.length === 1 ? '' : 's'}; ${res.conflicts.length} with conflict markers: ${res.conflicts.join(', ')}` : `Applied ${res.files.length} file${res.files.length === 1 ? '' : 's'} to the workspace`,
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
    this.telemetry?.record({ type: 'worktree', action: 'discard' });
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
    this.broadcast(this.sessionMsg(session));
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
    // Newest chats first, stopping at 20 prompts, so this never reads the whole history back from disk.
    const recentSet = new Set<string>();
    for (const row of this.store.list().sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (recentSet.size >= 20) {
        break;
      }
      const msgs = (this.store.peek(row.id)?.messages ?? []).filter((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.steer);
      for (const m of msgs.reverse()) {
        const t = m.content.replace(/<[a-z_]+[^>]*>[\s\S]*?<\/[a-z_]+>\s*/g, '').trim();
        if (t && !t.startsWith('/') && recentSet.size < 20) {
          recentSet.add(t);
        }
      }
    }
    const recent = [...recentSet];
    return { projectMap, gitSummary, errors: { count, files, sample }, todos, recent };
  }

  /** Send quick ideas right away; with `more`, ask the model for project-specific ones as well. */
  async suggestTasks(more: boolean): Promise<void> {
    const facts = await this.suggestionFacts();
    this.broadcast({ type: 'taskSuggestions', source: 'quick', items: quickSuggestions(facts), recent: facts.recent });
    if (!more) {
      return;
    }
    // A stalled stream must not leave the launcher saying "Asking the model for more…" forever.
    const ac = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error('the model stopped responding')), 90_000);
    };
    const total = setTimeout(() => ac.abort(new Error('timed out after 3 minutes')), 180_000);
    try {
      arm();
      const text = await quickPrompt(this.providers, suggestionPrompt(facts), { maxTokens: 700, temperature: 0.4, signal: ac.signal, onDelta: arm });
      const items = parseModelSuggestions(text);
      this.broadcast({ type: 'taskSuggestions', source: 'model', items, recent: facts.recent });
      if (!items.length) {
        this.broadcast({ type: 'toast', level: 'info', text: 'The model did not return usable ideas — try again or type your own task.' });
      }
    } catch (e) {
      const why = ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : e;
      this.broadcast({ type: 'taskSuggestions', source: 'model', items: [], recent: facts.recent });
      this.broadcast({ type: 'toast', level: 'error', text: `Could not get ideas from the model: ${why instanceof Error ? why.message : String(why)}` });
    } finally {
      clearTimeout(idle);
      clearTimeout(total);
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

  /** Folder hooks run in for a session: its worktree while isolated, otherwise the workspace. */
  private sessionRoot(sessionId: string): string | undefined {
    return this.store.get(sessionId)?.worktree?.path ?? this.workspace.root;
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

  /** Pre-loads the model that would answer this session's next message (Plan mode routes to the reasoning model). */
  private async warm(session: Session): Promise<void> {
    if (!getConfig().prewarm) {
      return;
    }
    await this.providers.warm(session.model, session.mode === 'plan' ? 'reasoning' : 'agent');
  }

  async handle(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return this.sendInit();
      case 'booted':
        return;
      case 'newSession': {
        const text = msg.text?.trim();
        // "New chat" on a chat nobody has used yet just re-arms it (mode may change) instead of leaving another empty
        // "New chat" in the history every time the button is pressed.
        const cur = !text && this.activeSessionId ? this.store.get(this.activeSessionId) : undefined;
        if (cur && isEmptySession(cur) && !this.runs.has(cur.id)) {
          if (msg.mode && cur.mode !== msg.mode) {
            cur.mode = msg.mode;
            this.store.save(cur, true);
          }
          this.setActive(cur);
          this.broadcast({ type: 'focusInput' });
          return;
        }
        const s = this.createSession(msg.mode ?? 'agent');
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
        await this.runner.hooks?.sessionEnd(msg.id, 'other', this.sessionRoot(msg.id));
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
      case 'searchSessions':
        this.broadcast({ type: 'searchResults', query: msg.query, hits: this.store.search(msg.query) });
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
        for (const [sid, o] of [...this.offers]) {
          if (o.create?.topic === msg.topic) {
            this.setOffers(sid, { ...o, create: undefined });
          }
        }
        return;
      case 'installCatalogSkill': {
        if (!this.catalog) {
          return;
        }
        const sid = msg.sessionId;
        const report = (ok: boolean, error?: string) => sid && this.broadcast({ type: 'skillInstall', sessionId: sid, name: msg.name, ok, error });
        const entries = await this.catalog.entries();
        const entry = entries.find((e) => e.name === msg.name && e.repo === msg.repo) ?? entries.find((e) => e.name === msg.name);
        if (!entry) {
          report(false, 'no longer in the skill catalog');
          void vscode.window.showWarningMessage(`"${msg.name}" is no longer in the skill catalog.`);
          return;
        }
        const cfg = getConfig();
        const dest = skillsDestination(cfg.skillAutoInstallScope, this.workspace.root);
        try {
          // Already on disk (installed meanwhile, or disabled): keep that copy and just make it usable.
          const existing = this.skills.getSkill(entry.name);
          const one = existing
            ? { name: existing.name, dir: path.dirname(existing.path) }
            : await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing skill "${entry.name}" from ${entry.repo}…` }, () => this.catalog!.install(entry, dest, { replace: false }));
          if (!one) {
            throw new Error('the repository has no such skill folder');
          }
          if (this.skills.getSkill(one.name)?.disabled || cfg.skillsDisabled.includes(one.name)) {
            await setSkillEnabled(one.name, true);
          }
          await this.skills.refresh();
          report(true);
          if (sid) {
            const s = this.store.peek(sid);
            const last = s?.messages.slice().reverse().find((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.toolImages);
            const prompt = String(last?.meta?.display ?? last?.content ?? '').replace(/^\/skill \S+\s*/, '').trim();
            this.setOffers(sid, { ...this.offers.get(sid), available: undefined, ready: { name: one.name, prompt } });
          }
          void vscode.window.showInformationMessage(existing ? `"${one.name}" is ready to use.` : `Installed "${one.name}" into ${dest}.`);
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          report(false, err);
          void vscode.window.showErrorMessage(`Could not install "${entry.name}": ${err}`);
        }
        return;
      }
      case 'dismissCatalogSkill':
        await this.catalog?.dismiss(msg.name);
        if (msg.sessionId && this.offers.get(msg.sessionId)?.available?.name === msg.name) {
          this.setOffers(msg.sessionId, { ...this.offers.get(msg.sessionId), available: undefined });
        }
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
        const pending = this.approvals.get(msg.id);
        if (pending) {
          this.settleApproval(msg.id, msg.approved);
        }
        return;
      }
      case 'setModel': {
        const s = this.store.get(msg.sessionId);
        if (s) {
          s.model = msg.model;
          this.store.save(s);
          void this.warm(s);
        }
        if (msg.makeDefault) {
          await setDefaultModel(msg.model);
        }
        return;
      }
      case 'warm': {
        const s = this.store.get(msg.sessionId);
        if (s && !this.runs.has(s.id)) {
          void this.warm(s);
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
      case 'setSkills': {
        const s = this.store.get(msg.sessionId);
        if (!s) {
          return;
        }
        const mode = msg.mode === 'auto' || msg.mode === 'ask' || msg.mode === 'off' ? msg.mode : undefined;
        const known = new Set(this.skills.enabledSkills.map((k) => k.name));
        const pinned = (Array.isArray(msg.pinned) ? msg.pinned : s.skills?.pinned ?? []).filter((n): n is string => typeof n === 'string' && known.has(n));
        s.skills = mode || pinned.length ? { ...(mode ? { mode } : {}), ...(pinned.length ? { pinned } : {}) } : undefined;
        this.store.save(s);
        this.broadcast(this.sessionMsg(s));
        return;
      }
      case 'refreshModels':
        await this.providers.listModels(true);
        return this.pushModels();
      case 'openFile': {
        const root = this.workspace.root;
        const uri = msg.path.startsWith('/') || /^[a-z]:[\\/]/i.test(msg.path) ? vscode.Uri.file(msg.path) : root ? vscode.Uri.joinPath(vscode.Uri.file(root), msg.path) : undefined;
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
        const { provider, model: picked } = await this.providers.resolve(s.model);
        const model = { ...picked, contextWindow: effectiveContextWindow(picked, getConfig().contextWindow) };
        const cm = new ContextManager({ compactionThreshold: 0, maxToolOutputChars: getConfig().maxToolOutputChars });
        const res = await cm.compact(s.messages, provider, model, undefined, 4);
        s.messages = res.messages;
        if (res.removed > 0) {
          s.compactions++;
        }
        s.contextTokens = res.after;
        this.store.save(s);
        this.broadcast(this.sessionMsg(s));
        this.broadcast({ type: 'toast', level: 'info', text: res.removed > 0 ? `Compacted: ${res.before} → ${res.after} tokens` : 'Nothing to compact yet — the conversation is still short' });
        return;
      }
      case 'clearSession': {
        const s = this.store.get(msg.sessionId);
        if (s && !this.isRunning(s.id)) {
          await this.runner.hooks?.sessionEnd(s.id, 'clear', this.sessionRoot(s.id));
          s.messages = [];
          s.contextTokens = 0;
          s.compactions = 0;
          s.todos = [];
          s.workingSet = [];
          this.store.save(s);
          this.broadcast(this.sessionMsg(s));
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
      case 'clientError':
        this.log.error(`chat webview (${msg.where}): ${msg.message}${msg.stack ? `\n${msg.stack}` : ''}`);
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
        this.broadcast(this.sessionMsg(s));
        await this.send(s.id, 'Implement the plan: run the checklist with run_todos_parallel, then verify the combined result and summarise.');
        return;
      }
      case 'restoreCheckpoint':
        await this.rewindTo(msg.sessionId, msg.messageIndex, true);
        return;
      case 'editMessage':
        await this.rewindTo(msg.sessionId, msg.messageIndex, false);
        return;
    }
  }

  /**
   * Rewinds a chat to one of the user's messages so it can be edited and sent again: that message and everything
   * after it are removed and its text goes back into the composer. With `revertFiles` the files changed since that
   * turn are restored too ("Restore checkpoint"); without it the work on disk is kept ("Edit").
   */
  private async rewindTo(sessionId: string, messageIndex: number, revertFiles: boolean): Promise<void> {
    const s = this.store.get(sessionId);
    if (!s || this.isRunning(s.id)) {
      this.broadcast({ type: 'toast', level: 'error', text: `Stop the running agent before ${revertFiles ? 'restoring a checkpoint' : 'editing a message'}` });
      return;
    }
    const target = s.messages[messageIndex];
    if (!target || target.role !== 'user') {
      return;
    }
    const reverted = revertFiles ? await this.tracker.restoreToTurn(s.id, messageIndex) : 0;
    const prompt = target.content.replace(/<[a-z_]+[^>]*>[\s\S]*?<\/[a-z_]+>\s*/g, '').replace(/\n\n\[\d+ images? attached\]$/, '').trim();
    s.messages = s.messages.slice(0, messageIndex);
    s.contextTokens = 0;
    this.store.save(s);
    this.broadcast(this.sessionMsg(s));
    if (revertFiles) {
      this.pushChanges(s.id);
    }
    this.broadcast({ type: 'draft', text: prompt });
    this.broadcast({
      type: 'toast',
      level: 'info',
      text: revertFiles ? (reverted ? `Restored checkpoint — reverted ${reverted} file${reverted === 1 ? '' : 's'}` : 'Restored checkpoint') : 'Edit the message and send it again — later turns were removed, files were kept',
    });
  }

  /**
   * Boot payload for a webview. With `sink` given (a view that just loaded or reloaded) everything goes to that
   * surface only — other hosts already have it — and the runs in flight are replayed to it so it shows the same
   * live turns, worker lanes and pending approvals as a webview that was watching all along.
   */
  async sendInit(sink?: Sink): Promise<void> {
    await this.loaded.catch(() => undefined);
    // The active chat may have been removed behind our back (retention, Settings → clear); never point at a ghost.
    if (!this.activeSessionId || !this.store.get(this.activeSessionId)) {
      this.activeSessionId = this.store.list()[0]?.id ?? this.store.create(getConfig().defaultModel).id;
    }
    const post = (m: ToWebview) => {
      if (!sink) {
        this.broadcast(m);
      } else if (this.sinks.has(sink)) {
        // Keep ordering with the live stream: anything coalesced so far goes out before the snapshot.
        this.flushDeltas();
        sink.post(m);
      }
    };
    // Boot must not wait on model discovery (several servers × health probes can take seconds, or hang on a dead
    // host): send what we know now with the cached model list, then push the fresh list when it arrives.
    const init = (models: ModelInfo[]): ToWebview => ({
      type: 'init',
      sessions: this.store.list(),
      activeSessionId: this.activeSessionId,
      models,
      defaultModel: getConfig().defaultModel,
      contextWindow: getConfig().contextWindow,
      skills: this.skills.enabledSkills.map((s) => ({ name: s.name, description: s.description })),
      agents: this.skills.allAgents.map((a) => ({ name: a.name, description: a.description })),
      commands: this.commandList(),
      skillsMode: getConfig().skillAutoInstall,
      running: [...this.runs.keys()],
      paused: this.pausedSessionIds,
      platform: process.platform,
    });
    post(init(this.providers.cachedModels()));
    const s = this.activeSession;
    if (s) {
      post(this.sessionMsg(s));
      this.pushChanges(s.id);
      this._onDidChangeActive.fire(s);
    }
    if (this.pendingDraft && Date.now() - this.pendingDraft.at < 15_000) {
      post({ type: 'draft', text: this.pendingDraft.text });
    }
    this.pendingDraft = undefined;
    // Runs in flight: the active one first so the visible transcript fills in before background tabs are rebuilt.
    // Only for a specific surface — webviews that were attached all along already have these turns.
    const active = this.activeSessionId;
    for (const id of sink ? [...this.runs.keys()].sort((a, b) => Number(b === active) - Number(a === active)) : []) {
      const replay = this.replayMsg(id);
      if (replay) {
        post(replay);
      }
    }
    if (!sink) {
      await this.pushModels();
      return;
    }
    post(await this.modelsMsg());
  }

  private async pushModels(): Promise<void> {
    this.broadcast(await this.modelsMsg());
  }

  /** The model list plus what "Auto" resolves to right now, so the picker never shows a model the router would not pick. */
  private async modelsMsg(): Promise<ToWebview> {
    const models = await this.providers.listModels().catch(() => []);
    const autoModel = models.length ? await this.providers.route({ role: 'agent' }).then((r) => r.model.id, () => undefined) : undefined;
    // Group headings in the picker use the provider's name ("LM Studio", "colibri"), not its settings id.
    const providerNames = Object.fromEntries(this.providers.all.map((p) => [p.id, p.displayName]));
    return { type: 'models', models, defaultModel: getConfig().defaultModel, autoModel, contextWindow: getConfig().contextWindow, providerNames };
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

  async send(sessionId: string, text: string, attachments: string[] = [], images?: string[], opts: { modelRef?: string; permissionAllow?: string[]; display?: string } = {}): Promise<string> {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (this.runs.has(sessionId)) {
      // Busy: the message becomes a steering instruction for the running agent instead of being refused.
      await this.steer(sessionId, text, attachments, images);
      return '';
    }
    const slash = opts.display ? undefined : this.handleSlash(session, text);
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
    this.replays.set(sessionId, { base: session.messages.length, startedAt: Date.now(), items: [], bytes: 0, truncated: false });
    this.offers.delete(sessionId);
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
      this.replays.delete(sessionId);
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
    const userMessage: ChatMessage = { role: 'user', content, images, meta: opts.display ? { display: opts.display } : undefined };

    try {
      const result = await this.runner.run({
        session,
        userMessage,
        modelRef: opts.modelRef,
        permissionAllow: opts.permissionAllow,
        signal: control.signal,
        control,
        workspaceRoot: session.worktree?.path,
        emit: (e) => {
          this.broadcast({ type: 'event', event: e });
          if (e.type === 'skill_suggestions') {
            const p = e.payload as SkillOffer | undefined;
            if (p?.available || p?.create) {
              this.offers.set(sessionId, { available: p.available, create: p.create });
            }
          }
          if (e.type === 'status' && typeof e.payload === 'string') {
            this.runStatus.set(sessionId, e.payload);
            this._onDidChangeRuns.fire();
          } else if (e.type === 'tool_start') {
            const p = e.payload as { name: string };
            this.runStatus.set(sessionId, `Running ${p.name}`);
            this._onDidChangeRuns.fire();
          }
          if (e.type === 'turn_end' || (e.type === 'tool_end' && !(e.payload as { childId?: string } | undefined)?.childId)) {
            // Persist after the agent's own tool results; a subagent's steps are saved with its parent's next result.
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
      this.replays.delete(sessionId);
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
    this.broadcast(this.sessionMsg(session));
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
        if (s.messageCount) {
          await this.runner.hooks?.sessionEnd(s.id, 'other', this.sessionRoot(s.id));
        }
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
    for (const [id, pending] of this.approvals) {
      if (pending.sessionId === sessionId) {
        this.settleApproval(id, false);
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
      this.approvals.set(id, { sessionId, title, detail, kind, resolve, mirrored: false });
      if (this.sinks.size === 0) {
        // No UI attached (e.g. chat participant path) — fall back to a native dialog.
        void vscode.window.showWarningMessage(`${title}\n${detail}`.slice(0, 1000), { modal: true }, 'Allow', 'Allow for session').then((choice) => {
          if (!this.approvals.has(id)) {
            return; // the run was stopped meanwhile
          }
          if (choice === 'Allow for session') {
            this.rememberApproval(sessionId, kind);
          }
          this.settleApproval(id, !!choice);
        });
        return;
      }
      // Recorded in the replay buffer too, so a chat that is closed and reopened while the agent waits shows the prompt again.
      this.broadcast({ type: 'approval', id, sessionId, title, detail, kind });
      this.mirrorPendingApprovals();
    });
  }

  /** Answers a pending approval once, whichever surface answered it, and takes the prompt down everywhere. */
  private settleApproval(id: string, ok: boolean): void {
    const pending = this.approvals.get(id);
    if (!pending) {
      return;
    }
    this.approvals.delete(id);
    this.forgetApproval(id);
    pending.resolve(ok);
    this.broadcast({ type: 'approvalResolved', id });
  }

  /**
   * While no chat surface is visible, every prompt still waiting gets a native notification (once), so an agent that
   * raised it just before the chat was hidden, closed or moved never stalls unnoticed. Chosen in the notification, the
   * answer also closes the prompt in the webview; dismissed, the prompt simply stays in the chat.
   */
  private mirrorPendingApprovals(): void {
    if (!this.approvals.size || this.anySurfaceVisible()) {
      return;
    }
    for (const [id, pending] of this.approvals) {
      if (pending.mirrored) {
        continue;
      }
      pending.mirrored = true;
      const session = this.store.get(pending.sessionId);
      void vscode.window
        .showWarningMessage(`LocalPilot${session ? ` · ${session.title}` : ''}: ${pending.title}`, 'Allow', 'Allow for session', 'Deny', 'Show chat')
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
            this.rememberApproval(pending.sessionId, pending.kind);
          }
          this.settleApproval(id, choice !== 'Deny');
        });
    }
  }

  rememberApproval(sessionId: string, kind: string): void {
    const set = this.sessionApprovalMemory.get(sessionId) ?? new Set<string>();
    set.add(kind);
    this.sessionApprovalMemory.set(sessionId, set);
  }

  /** Slash commands handled locally (no model call). Returns undefined when the text is a normal prompt. */
  private handleSlash(session: Session, text: string): string | undefined {
    const m = /^\/([\w:-]+)\s*(.*)$/s.exec(text.trim());
    if (!m) {
      return undefined;
    }
    const [, cmd, rest] = m;
    const say = (t: string) => {
      session.messages.push({ role: 'user', content: text, meta: { timestamp: Date.now() } }, { role: 'assistant', content: t, meta: { timestamp: Date.now() } });
      this.store.save(session);
      this.broadcast(this.sessionMsg(session));
      return t;
    };
    switch (cmd) {
      case 'help': {
        const custom = this._commands?.all ?? [];
        return say(
          [
            '**Slash commands**',
            '- `/model <provider/model>` — switch model for this session',
            '- `/mode agent|ask|plan` — switch mode',
            '- `/compact` — summarise older messages to free context',
            '- `/clear` — clear this session',
            '- `/skills` — list skills · `/agents` — list subagents · `/commands` — list custom commands',
            '- `/skill <name> <task>` — run a task with a skill preloaded · `/skill install <owner/repo|url|folder>` — install a skill · `/skill browse [words]` — search the skill registry',
            '- `/skill mode auto|ask|off` — how this chat uses skills · `/skill pin <name>` / `unpin` — load a skill into every request of this chat',
            '- `/agent <name> <task>` — delegate directly to a subagent',
            '- `/memory` — instruction files in force (CLAUDE.md, AGENTS.md…) · `/permissions` — permission rules · `/hooks` — configured hooks',
            '- `/context` — show context usage',
            ...(custom.length ? ['', '**Custom commands** (`.claude/commands`, `.localpilot/commands`, plugins)', ...custom.map((c) => `- \`${c.invoke}${c.argumentHint ? ` ${c.argumentHint}` : ''}\` — ${c.description || c.file}`)] : []),
          ].join('\n')
        );
      }
      case 'commands': {
        const custom = this._commands?.all ?? [];
        const line = (c: CustomCommand) => {
          const extras = [c.allowedTools.length ? `allowed-tools: ${c.allowedTools.map((r) => `\`${r}\``).join(', ')}` : '', c.model ? `model: \`${c.model}\`` : ''].filter(Boolean);
          return `- **${c.invoke}**${c.argumentHint ? ` \`${c.argumentHint}\`` : ''} (${c.plugin ? `plugin ${c.plugin}` : c.source}): ${c.description}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
        };
        return say(custom.length ? custom.map(line).join('\n') : 'No custom commands. Add markdown files under `.localpilot/commands/` or `.claude/commands/` (front-matter: `description`, `argument-hint`, `allowed-tools`, `model`; body: the prompt, with `$ARGUMENTS`, `@file` and `!` + backtick-quoted shell commands).');
      }
      case 'memory': {
        void this.workspace.instructionFiles().then((files) => {
          say(files.length ? `**Instruction files in force** (in prompt order)\n${files.map((f) => `- \`${f.label}\` (${f.scope})`).join('\n')}` : 'No instruction files found. Create `CLAUDE.md` or `AGENTS.md` in the workspace, `.claude/CLAUDE.md`, `CLAUDE.local.md` for personal notes, or `~/.claude/CLAUDE.md` for every project. Lines with `@path` import other files.');
        });
        return '';
      }
      case 'permissions': {
        const p = this.runner.projectSettings?.();
        if (!p) {
          return say('Permission rules are not available.');
        }
        const fmt = (list: string[]) => (list.length ? list.map((r) => `\`${r}\``).join(', ') : '_none_');
        return say([`**Permission rules** (from ${p.sources.length ? p.sources.map((s) => `\`${vscode.workspace.asRelativePath(s)}\``).join(', ') : 'no settings file'})`, `- deny: ${fmt(p.permissions.deny)}`, `- ask: ${fmt(p.permissions.ask)}`, `- allow: ${fmt(p.permissions.allow)}`, p.permissions.defaultMode ? `- defaultMode: \`${p.permissions.defaultMode}\`` : '', '', 'Edit `.localpilot/settings.json` or `.claude/settings.json`: `{ "permissions": { "allow": ["Bash(npm run test:*)"], "deny": ["Read(.env)"] } }`.'].filter((l) => l !== '').join('\n'));
      }
      case 'hooks': {
        const p = this.runner.projectSettings?.();
        const entries = Object.entries(p?.hooks ?? {});
        return say(entries.length ? `**Hooks**\n${entries.map(([ev, ms]) => `- **${ev}**: ${ms.map((mm) => `${mm.matcher ? `\`${mm.matcher}\` → ` : ''}${mm.hooks.map((h) => `\`${h.command.length > 60 ? `${h.command.slice(0, 60)}…` : h.command}\``).join(', ')}`).join('; ')}`).join('\n')}` : 'No hooks configured. Add to `.localpilot/settings.json` or `.claude/settings.json`: `{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/check.sh" }] }] } }`. Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, SessionStart, PreCompact, Notification.');
      }
      case 'skills': {
        const all = this.skills.allSkills;
        const ss = session.skills ?? {};
        const mode = ss.mode ?? getConfig().skillAutoInstall;
        const header = `Skills in this chat: **${mode}**${ss.mode ? ' (chat override)' : ' (global setting)'}${ss.pinned?.length ? ` · pinned: ${ss.pinned.map((p) => `\`${p}\``).join(', ')}` : ''}. Change with \`/skill mode auto|ask|off\`, \`/skill pin <name>\`, \`/skill unpin <name>\`.`;
        return say(`${header}\n\n${all.map((s) => `- **${s.name}** (${s.source}${s.disabled ? ', disabled' : ''}): ${s.description}`).join('\n') || 'No skills found. Add folders with SKILL.md under `.localpilot/skills/`, or open Settings → Skills to install from the registry.'}`);
      }
      case 'agents':
        return say(this.skills.allAgents.map((a) => `- **${a.name}** (${a.source}): ${a.description}`).join('\n'));
      case 'context': {
        const win = this.providers.cachedModels().find((m) => m.id === (session.model || getConfig().defaultModel));
        const eff = win ? effectiveContextWindow(win, getConfig().contextWindow) : undefined;
        const window = eff ? ` of ${eff.toLocaleString()}${win && win.contextWindow > eff ? ` (model supports ${win.contextWindow.toLocaleString()}; raise \`localpilot.contextWindow\` or set it to 0 for the model's maximum)` : ''}` : '';
        return say(`Context: ~${session.contextTokens.toLocaleString()}${window} tokens · ${session.messages.length} messages · ${session.compactions} compactions · model ${session.model || '(default)'}`);
      }
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
          this.broadcast(this.sessionMsg(session));
          return '';
        }
        return say('Usage: `/mode agent|ask|plan`');
      case 'model':
        if (rest.trim()) {
          session.model = rest.trim();
          this.store.save(session);
          this.broadcast(this.sessionMsg(session));
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
        if (name === 'mode') {
          const m = task[0];
          if (m === 'auto' || m === 'ask' || m === 'off') {
            session.skills = { ...session.skills, mode: m };
          } else if (m === 'inherit' || m === 'default' || m === 'global') {
            session.skills = { ...session.skills, mode: undefined };
          } else {
            return say('Usage: `/skill mode auto|ask|off|inherit` — registry skills in this chat: install matches as the request starts, offer them as a chip, or `off` (no registry lookups and no skill suggestions; pinned skills and /skill still work).');
          }
          this.store.save(session);
          this.broadcast(this.sessionMsg(session));
          return say(`Skills in this chat: **${session.skills.mode ?? `${getConfig().skillAutoInstall} (global)`}**.`);
        }
        if (name === 'pin' || name === 'unpin') {
          const target = this.skills.resolveSkill(task[0] ?? '')?.skill;
          if (!target) {
            return say(`Unknown skill "${task[0] ?? ''}". Try /skills.`);
          }
          const pinned = new Set(session.skills?.pinned ?? []);
          name === 'pin' ? pinned.add(target.name) : pinned.delete(target.name);
          session.skills = { ...session.skills, pinned: [...pinned] };
          this.store.save(session);
          this.broadcast(this.sessionMsg(session));
          return say(name === 'pin' ? `Pinned **${target.name}**: its instructions are loaded into every request of this chat.` : `Unpinned **${target.name}**.`);
        }
        const resolved = this.skills.resolveSkill(name);
        if (!resolved) {
          const hint = /[/:.]/.test(name) ? ` To install a skill from GitHub or a URL use \`/skill install ${name}\`.` : '';
          const similar = this.skills.similarSkillNames(name);
          const disabled = this.skills.getSkill(name)?.disabled ? ` "${name}" is disabled — enable it in Settings → Skills.` : '';
          return say(`Unknown skill "${name}".${disabled}${similar.length ? ` Did you mean ${similar.map((s) => `\`${s}\``).join(', ')}?` : ''} Try /skills.${hint}`);
        }
        const skill = resolved.skill;
        void this.send(session.id, `Use the "${skill.name}" skill for this task: ${task.join(' ') || 'follow the skill instructions.'}\nIts instructions are loaded for you; perform every step the skill describes using the tools, then report what you did.`);
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
      default: {
        const custom = this._commands?.get(cmd);
        if (custom) {
          void this.runCustomCommand(session, custom, rest, text);
          return '';
        }
        return undefined; // let the model see it
      }
    }
  }

  /** Expands a custom slash command (arguments, !`cmd`, @file) and sends the prompt with the command's model / allowed-tools. */
  private async runCustomCommand(session: Session, cmd: CustomCommand, argText: string, typed: string): Promise<void> {
    this.runStatus.set(session.id, `Preparing ${cmd.invoke}…`);
    this.broadcast({ type: 'event', event: { sessionId: session.id, type: 'status', payload: `Preparing ${cmd.invoke}…` } });
    try {
      const { prompt, notes } = await expandCommand(cmd, argText, { root: session.worktree?.path ?? this.workspace.root });
      for (const n of notes) {
        this.broadcast({ type: 'toast', level: 'warn', text: n });
      }
      if (!prompt) {
        this.broadcast({ type: 'toast', level: 'error', text: `${cmd.invoke}: the command file has no prompt body.` });
        return;
      }
      await this.send(session.id, prompt, [], undefined, { modelRef: cmd.model, permissionAllow: cmd.allowedTools, display: typed.trim() });
    } catch (e) {
      this.runStatus.delete(session.id);
      this.broadcast({ type: 'event', event: { sessionId: session.id, type: 'error', payload: `${cmd.invoke}: ${e instanceof Error ? e.message : String(e)}` } });
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
