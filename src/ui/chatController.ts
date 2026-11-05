import * as vscode from 'vscode';
import { Telemetry } from '../telemetry/telemetry';
import { AgentRunner } from '../agent/agentLoop';
import { SkillLearner } from '../agent/skillRecommender';
import { SkillCatalog } from '../agent/skillCatalog';
import { skillsDestination } from '../agent/skillInstaller';
import { ChangeTracker } from '../agent/changeTracker';
import { ChangedFile, gitCheckpoint, relativeIn, RestoreType } from '../agent/checkpoints';
import { rewindAttachments } from './rewindDraft';
import { SkillManager } from '../agent/skills';
import { configTarget, getConfig, setDefaultModel, setSkillEnabled } from '../config';
import { ContextManager, effectiveContextWindow, tokenCalibration } from '../context/contextManager';
import { currentEditor, EditorState, WorkspaceContext } from '../context/workspaceContext';
import { FileIndex } from '../context/fileIndex';
import { MentionHit } from '../context/mentionSearch';
import { MAX_ATTACHMENT_BYTES, searchCommits } from '../context/mentionResolvers';
import { formatSize } from '../context/extractors';
import { ProviderRegistry } from '../providers/registry';
import { isEmptySession, SessionStore } from '../sessions/sessionStore';
import { HistoryPage, HistoryQuery } from '../sessions/historyQuery';
import { archiveCompaction } from '../sessions/transcriptArchive';
import { contextReport, memoryReport } from '../agent/reports';
import { AgentEvent, ALL_MODES, ChatMessage, ModelInfo, Session, UserAnswer, UserQuestion } from '../types';
import { captureUrl, inspectUrl, openInBrowser } from '../tools/browser';
import { formatReport } from '../tools/cdp';
import { MAX_ATTACHMENTS } from './imageSize';
import { captureScreenshot, IMAGE_EXT, ImageAttachment, pickImages, readImage, ScreenshotMode } from './images';
import { RunControl } from '../agent/runControl';
import { MessageQueue, QueueRow, queueLabel } from '../agent/messageQueue';
import { WorktreeChange, WorktreeManager } from '../agent/worktrees';
import { parseModelSuggestions, quickSuggestions, SuggestionFacts, suggestionPrompt, TaskSuggestion } from '../agent/taskSuggestions';
import { quickPrompt } from './inlineEdit';
import { correctPromptNames, PromptFix } from '../agent/promptCorrector';
import { userText } from '../agent/clarify';
import { findRipgrep, runProcess } from '../tools/search';
import { releaseIntegratedTerminal } from '../tools/terminal';
import { agentTaskPrompt, CommandManager, CustomCommand, deepPlanningPrompt, expandCommand, parseTaskArgs, skillTaskPrompt } from '../agent/commands';
import { teamPrompt } from '../agent/teamBrief';
import { findSlashToken, normalizeCommandName, pickSlashTarget, SlashToken, spliceSlashToken } from '../agent/slashNames';
import { PlanTurnOutcome, saveImplementationPlan } from '../agent/deepPlanning';
import { BASIC_KEEP_ASSISTANT, basicSummary } from '../context/basicCompaction';
import * as path from 'path';
import { describePolicy, getManagedPolicy } from '../agent/managedPolicy';
import { formatBoard, TeamBoard } from '../agent/teamBoard';
import { isPdfPath, openPdf } from './pdf/open';
import { detachCommand, onCommandRunChange, runningCommands, stopCommand } from '../terminal/commandRun';
import type { McpManager } from '../mcp/mcpManager';
import { parseMcpSlash, withoutMcpPromptImages } from '../mcp/prompts';
import { handleMcpChatAction, McpChatMessage, mcpChatStatus } from './mcpChat';
import { RunNotifier } from './runNotifier';
import { addManualModel, favoriteModels, manualModelProviders, toggleFavoriteModel } from './modelPicker';
import { parseThinkChoice } from '../agent/thinking';
import { affectsAutoApprove, AutoApproveMsg, autoApproveState, setAutoApprove } from './autoApproveBar';
import { affectsUiPrefs, checkPathsExist, PathsExistMsg, uiPrefsMsg, UiPrefsMsg } from './chatUiExtras';
import type { WhatsNew } from './whatsNew';
import { toDecision } from '../agent/approvalLevel';
import type { ApprovalDecision } from '../types';
import type { AttemptRecord, HealingService, RecoveryState, ResumeInfo, TaskOutcome } from '../agent/healing';
import { forgetRecovery, phaseBeforeInterrupt, recoveryStateOf } from './healingAccess';

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
  | McpChatMessage
  | UiPrefsMsg
  | PathsExistMsg
  /**
   * `liveFrom` is set while the session is running: messages from that index on belong to the turn in flight and are
   * drawn from the live event stream (see `replay`), not from the transcript — otherwise a tab switch or reopen
   * mid-run would show every step twice.
   */
  | { type: 'session'; session: Session; liveFrom?: number; offers?: SkillOffer; cwd?: string }
  /**
   * Everything a freshly created webview missed about a run in flight, in the order it happened: events (text
   * deltas coalesced), queued steering messages and the approvals still waiting for an answer. `startedAt` keeps the
   * elapsed-time counter honest; `truncated` means the run outgrew the buffer and only its tail is replayed.
   */
  | { type: 'replay'; sessionId: string; items: ToWebview[]; startedAt: number; status?: string; truncated: boolean }
  /** `contextWindow` is the `localpilot.contextWindow` setting (0 = model maximum) so the meter shows the window a model is actually given. */
  /** `autoModel`: the id the router would answer an Auto chat with right now (the default model if set and reachable, else the best fit). */
  | { type: 'models'; models: ModelInfo[]; defaultModel: string; autoModel?: string; contextWindow: number; providerNames?: Record<string, string>; visionRouting?: boolean; favorites?: string[]; manualProviders?: string[]; thinking?: string }
  | { type: 'skills'; skills: { name: string; description: string }[]; agents: { name: string; description: string }[]; commands?: CommandListItem[]; skillsMode: 'auto' | 'ask' | 'off' }
  | { type: 'event'; event: AgentEvent }
  /** Result of an Install click on a registry skill offer, so the chip can settle or offer a retry. */
  | { type: 'skillInstall'; sessionId: string; name: string; ok: boolean; error?: string }
  /**
   * `mandatory`: asked every time (no "Allow for session"), because the command is dangerous or the organization's
   * policy requires it. `waitingSameKind`: other prompts of this chat (parallel workers) an "allow all" would answer too.
   */
  | { type: 'approval'; id: string; sessionId: string; title: string; detail: string; kind: string; mandatory: boolean; mandatoryReason?: 'dangerous' | 'policy'; waitingSameKind: number }
  /** The kinds a chat answered "Allow all … in this chat" for, shown as removable chips by the auto-approve bar. */
  | { type: 'sessionGrants'; sessionId: string; kinds: string[] }
  /** The agent asks the user questions (ask_user); answered with `answer`. */
  | { type: 'question'; id: string; sessionId: string; questions: UserQuestion[] }
  | { type: 'questionResolved'; id: string }
  | { type: 'approvalResolved'; id: string }
  | AutoApproveMsg
  | { type: 'running'; sessionId: string; running: boolean }
  /** Pause state of a run or of one of its subagents (`childId`). `paused` = requested; `holding` = the loop has actually stopped at a step boundary. */
  | { type: 'paused'; sessionId: string; childId?: string; agent?: string; paused: boolean; holding: boolean }
  /** A run_command call (tool call id) started, was detached (Proceed While Running) or ended. */
  | { type: 'commandState'; sessionId: string; id: string; state: 'running' | 'detached' | 'done'; logPath?: string }
  /** A message typed while the agent was busy was queued; the loop reports `steer` when it is injected. */
  | { type: 'steerQueued'; sessionId: string; id: string; content: string; images?: string[]; fixes?: PromptFix[] }
  /** A message waits for a manual compaction to finish before it starts a run. */
  | { type: 'sendQueued'; sessionId: string }
  /** Pending steers and after-turn messages of a chat, for the queue banner; `removed` = cancelled steer rows to drop. */
  | { type: 'queue'; sessionId: string; items: QueueRow[]; label: string; removed?: string[] }
  /** A message never started a run (no model could read its images, a custom command failed to expand): the chat drops its placeholder turn. */
  | { type: 'sendRejected'; sessionId: string }
  | {
      type: 'changes';
      sessionId: string;
      files: { path: string; fsPath: string; kind: 'create' | 'modify' | 'delete' | 'rename'; added?: number; removed?: number }[];
      /** Turns with file snapshots (a restore reverts every turn from the one picked on). */
      checkpoints: number[];
      /** Turns with a git checkpoint taken before them. */
      gitCheckpoints?: number[];
      checkpointsEnabled?: boolean;
      /** Files changed since the latest user message, for View changes under the latest answer. */
      lastTurn?: { key: number; files: number };
      /** Present when the files come from the session's isolated worktree rather than the workspace. */
      worktree?: { path: string; applied: boolean; conflicts?: string[] };
    }
  | { type: 'image'; image: ImageAttachment }
  | { type: 'insertMention'; ref: string }
  | { type: 'openFiles'; files: string[]; active?: string; selection?: boolean }
  | { type: 'mentionResults'; query: string; items: MentionHit[]; commits?: { sha: string; subject: string }[] }
  /** `append`: add the text below the current draft and the attachments to its chips instead of replacing them. */
  | { type: 'draft'; text: string; images?: string[]; attachments?: string[]; append?: boolean; merge?: boolean }
  /** Answer to `checkpointExists`: whether Reset Code can put the files back, and the message's draft (text, attachment refs) for the inline editor. */
  | { type: 'checkpointExistsResult'; sessionId: string; index: number; exists: boolean; reason?: string; text?: string; attachments?: string[] }
  /** The inline edit was not resent (refused, or nothing rewound): the editor at `index` leaves its busy state. */
  | { type: 'editAndRegenerateResult'; sessionId: string; index: number; ok: false }
  /** Names in the message just sent were corrected; the chat updates the bubble it already shows. */
  | { type: 'promptCorrected'; sessionId: string; text: string; fixes: PromptFix[] }
  | { type: 'focusInput' }
  | { type: 'historyCleared'; removed: number }
  /** Answer to `listSessions`: one page of the sorted, filtered history (`seq` echoes the request). */
  | { type: 'sessionPage'; seq: number; page: HistoryPage }
  /** Task ideas for the multitask launcher: `quick` ones come instantly from the workspace, `model` ones from the model. */
  | { type: 'taskSuggestions'; source: 'quick' | 'model'; items: TaskSuggestion[]; recent: string[] }
  /** Open the multitask launcher (from the Command Palette / Agents view). */
  | { type: 'openLauncher'; kind?: 'tasks' | 'bestof' }
  /** `action`: a button on the toast that posts `msg` back (e.g. Undo after Reject). */
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string; action?: { label: string; msg: FromWebview } }
  /** "Improve prompt" progress: the rewritten draft streams in (`delta`), then `done` or `error`. */
  | { type: 'improvedPrompt'; sessionId: string; delta?: string; done?: boolean; text?: string; error?: string }
  /** The chat's self-healing was interrupted (window closed mid-recovery): the Recovery interrupted card; `state: null` removes it. */
  | { type: 'recoveryInterrupted'; sessionId: string; state: InterruptedState | null };

/**
 * What the Recovery interrupted card shows: the service's synchronous resume index entry, then (posted again once
 * the persisted state is read) the active failures, the attempts, the intervention and the phase it stopped in.
 */
export type InterruptedState = ResumeInfo & {
  sessionId: string;
  recoveryId: string;
  lastPhase?: string;
  active?: RecoveryState['active'];
  attempts?: Pick<AttemptRecord, 'n' | 'category' | 'rootCause' | 'result'>[];
  intervention?: RecoveryState['intervention'];
};

export type RecoveryAction = 'resume' | 'retryWithGuidance' | 'approveInstall' | 'rollback' | 'openMergeEditor' | 'acceptRisk' | 'dismiss';

/** The hidden steer turn that continues an interrupted recovery; the engine reruns the checks before the model is called. */
export const RESUME_PROMPT = 'Continue the interrupted task. LocalPilot will first re-run the checks.';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'mcpStatus' }
  | { type: 'mcpToggle'; name: string; enabled: boolean }
  | { type: 'mcpRestart'; name: string }
  /** Rewrite the composer draft into a precise request (or cancel the rewrite in progress when `cancel`). */
  | { type: 'improvePrompt'; sessionId: string; text: string; cancel?: boolean }
  | { type: 'booted' }
  | { type: 'newSession'; mode?: Session['mode']; text?: string; attachments?: string[]; images?: string[] }
  | { type: 'runParallel'; tasks: string[]; mode?: Session['mode'] }
  | { type: 'selectSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'deleteSessions'; ids: string[] }
  | { type: 'clearHistory'; keepPinned?: boolean }
  | ({ type: 'listSessions'; seq: number } & HistoryQuery)
  | { type: 'renameSession'; id: string; title: string }
  | { type: 'pinSession'; id: string }
  | { type: 'forkSession'; id: string; uptoIndex?: number }
  | { type: 'exportSession'; id: string; format?: 'markdown' | 'html' }
  /** `modeOverride`: an empty-chat suggestion runs this one turn in Ask or Agent mode; the chat keeps its own mode. */
  | { type: 'send'; sessionId: string; text: string; attachments?: string[]; images?: string[]; modeOverride?: string }
  | { type: 'retry'; sessionId: string }
  | { type: 'stop'; sessionId: string }
  /** Proceed While Running / Stop on a running command row (`id` = the run_command tool call id). */
  | { type: 'detachCommand'; id: string }
  | { type: 'stopCommand'; id: string }
  | { type: 'pause'; sessionId: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'steer'; sessionId: string; text: string; attachments?: string[]; images?: string[] }
  /** "Send after this turn": starts a new turn once the run in flight ends (or right away when idle). */
  | { type: 'queueAfterTurn'; sessionId: string; text: string; attachments?: string[]; images?: string[] }
  /** Withdraw a queued steer or after-turn message; `edit` puts its text back into the composer. */
  | { type: 'cancelQueued'; sessionId: string; id: string; edit?: boolean }
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
  /** `feedback`: the reason given with a denial; the agent reads it instead of a bare refusal. */
  | { type: 'approval'; id: string; approved: boolean; remember?: boolean; feedback?: string }
  /** Take back an "Allow all … in this chat" grant: the next action of that kind asks again. */
  | { type: 'revokeGrant'; sessionId: string; kind: string }
  /** The toast's "Open log" button. */
  | { type: 'showLog' }
  /** A toggle in the composer's auto-approve bar (`approvals.<key>` or `autoMode`). */
  | { type: 'setApproval'; key: string; value: string }
  /** Answers to a `question` prompt; `answers: null` = skipped. */
  | { type: 'answer'; id: string; answers: UserAnswer[] | null }
  | { type: 'setModel'; sessionId: string; model: string; makeDefault?: boolean }
  /** The composer's Think chip: this chat's thinking level (`null` follows `localpilot.thinking`). */
  | { type: 'setThink'; sessionId: string; think: string | null }
  /** Star in the model menu. */
  | { type: 'toggleFavoriteModel'; model: string }
  /** Enter on text that matches no model: use it as a model id with that provider. */
  | { type: 'useModelId'; sessionId: string; providerId: string; modelId: string }
  /** The user is about to send (composer focused / typing): load the session's model so the first token comes sooner. */
  | { type: 'warm'; sessionId: string }
  | { type: 'setMode'; sessionId: string; mode: Session['mode'] }
  | { type: 'setSkills'; sessionId: string; mode?: string | null; pinned?: string[] }
  | { type: 'refreshModels' }
  | { type: 'detectModels' }
  | { type: 'openFile'; path: string; line?: number; sessionId?: string }
  | { type: 'insertCode'; code: string }
  | { type: 'applyCodeToFile'; code: string; path?: string }
  | { type: 'attachActive' }
  | { type: 'attachRef'; ref: string }
  | { type: 'pickAttachment' }
  /** `retry`: "Compact and retry" on a turn the model rejected as too long sends the last message again afterwards. */
  | { type: 'compactNow'; sessionId: string; retry?: boolean }
  | { type: 'clearSession'; sessionId: string }
  | { type: 'openSettings'; section?: string }
  | { type: 'setTipsEnabled'; enabled: boolean }
  | { type: 'autoSetupModels' }
  | { type: 'openExternal'; url: string }
  | { type: 'openInEditor' }
  | { type: 'attachUri'; uri: string; insert?: boolean }
  | { type: 'pickImage' }
  | { type: 'captureScreenshot'; mode?: ScreenshotMode; delayMs?: number }
  | { type: 'captureUrl'; url?: string; mobile?: boolean; fullPage?: boolean }
  | { type: 'inspectUrl'; url?: string; mobile?: boolean }
  | { type: 'openBrowser'; url?: string }
  | { type: 'requestOpenFiles' }
  | { type: 'mentionSearch'; query: string }
  | { type: 'openMention'; ref: string }
  /** The webview's script hit an error (uncaught exception, rejected promise or a handler that threw): logged host-side so a dead UI is never silent. */
  | { type: 'clientError'; where: string; message: string; stack?: string }
  | { type: 'keepChanges'; sessionId: string; fsPath?: string }
  | { type: 'undoChanges'; sessionId: string; fsPath?: string }
  /** Undo of the last reject, within the tracker's redo window. */
  | { type: 'redoChanges'; sessionId: string; token: number }
  | { type: 'showDiff'; sessionId: string; fsPath: string }
  /** `restoreType`: files only (`workspace`), conversation only (`task`) or both (the default). */
  | { type: 'restoreCheckpoint'; sessionId: string; messageIndex: number; restoreType?: RestoreType }
  /** Multi-file diff of what changed since the latest user message (`turn`) or in the whole chat (`session`). */
  | { type: 'viewChanges'; sessionId: string; scope: 'turn' | 'session' }
  | { type: 'openCheckpointSetting' }
  /** Edit & resend: drop this user message and everything after it, keep files as they are, put the text in the composer. */
  | { type: 'editMessage'; sessionId: string; messageIndex: number }
  /** Inline edit: rewind to the user message at `index` (and its files with `restoreWorkspace`), then send the edited message. */
  | { type: 'editAndRegenerate'; sessionId: string; index: number; text: string; images?: string[]; attachments?: string[]; restoreWorkspace?: boolean }
  | { type: 'checkpointExists'; sessionId: string; index: number }
  | { type: 'runParallelPrompt' }
  | { type: 'dismissSkillTopic'; topic: string }
  /** Install a catalog skill offered under a request (`skills.autoInstall: ask`). */
  | { type: 'installCatalogSkill'; name: string; repo: string; sessionId?: string }
  | { type: 'dismissCatalogSkill'; name: string; sessionId?: string }
  | { type: 'openMarkdown'; text: string; title?: string }
  /** Path links in an answer, batch-checked so links to files that do not exist render as plain code. */
  | { type: 'pathsExist'; seq: number; paths: string[]; sessionId?: string }
  | { type: 'dismissWhatsNew' }
  | { type: 'openChangelog' }
  | { type: 'copyText'; text: string }
  /**
   * A button on a recovery card. `text`: the guidance of `retryWithGuidance`; `attempt`: the attempt a `rollback` undoes
   * (absent: every fix attempt); `file`: the conflicted file of `openMergeEditor`.
   */
  | { type: 'recoveryAction'; sessionId: string; recoveryId?: string; action: RecoveryAction; text?: string; attempt?: number; file?: string };

export interface Sink {
  post(msg: ToWebview): void;
  /** Whether the user can currently see this surface; approvals raised while nothing is visible also get a notification. */
  visible?: () => boolean;
  /** The surface shows prompts for this session natively (the @localpilot participant) instead of as cards. */
  handlesPrompts?: (sessionId: string) => boolean;
}

/** An approval the agent is waiting on; kept so a re-created webview can show the prompt again and a hidden one can mirror it as a notification. */
interface PendingApproval {
  sessionId: string;
  title: string;
  detail: string;
  kind: string;
  /** Answered each time, never remembered for the session: a dangerous command or the organization's policy. */
  mandatory?: boolean;
  mandatoryReason?: 'dangerous' | 'policy';
  resolve: (d: ApprovalDecision) => void;
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

/** How a message is sent. `resume`: the hidden steer turn that continues an interrupted recovery (AgentRunOptions.resume). */
interface SendOptions {
  modelRef?: string;
  permissionAllow?: string[];
  display?: string;
  unattended?: boolean;
  mode?: Session['mode'];
  resume?: boolean;
  /** The queue task this run executes (recorded in its recovery state). */
  taskId?: string;
}

/** Shared brain behind the sidebar view, editor panels and the @localpilot chat participant. */
export class ChatController implements vscode.Disposable {
  private sinks = new Set<Sink>();
  private runs = new Map<string, RunControl>();
  /** Session id -> models uninstalled while that chat was running; its pin is reset to Auto when the run ends. */
  private readonly removedWhileRunning = new Map<string, Set<string>>();
  /** Sessions whose current run was stopped by the user, so a queued task records `cancelled` rather than done/failed. */
  private readonly stoppedByUser = new Set<string>();
  private replays = new Map<string, RunReplay>();
  private offers = new Map<string, SkillOffer>();
  private approvals = new Map<string, PendingApproval>();
  /** Native notifications for finished runs and long auto-approved commands (`localpilot.notifications`). */
  private readonly notifier = new RunNotifier(() => this.anySurfaceVisible(), {
    retry: (id) => this.retry(id),
    keep: (id) => {
      this.tracker.keep(id);
      this.pushChanges(id);
    },
  });
  /** ask_user prompts waiting for the user, by id. */
  private questions = new Map<string, { sessionId: string; questions: UserQuestion[]; resolve: (a: UserAnswer[] | null | undefined) => void; mirrored: boolean }>();
  /** Run status from before a session started waiting on a prompt, restored once its last prompt is answered. */
  private statusBeforePrompt = new Map<string, string | undefined>();
  private sessionApprovalMemory = new Map<string, Set<string>>();
  /** Change-tracker turn key of the last run started; keys only increase so Restore checkpoint survives compaction, /clear and Edit. */
  private lastCheckpoint = 0;
  private activeSessionId?: string;
  /** Where the model menu's stars are kept (the extension's globalState); unset, nothing is starred. */
  modelPrefs?: vscode.Memento;
  /** The "What's new" card shown on the empty chat after an update (set by the extension host). */
  whatsNew?: WhatsNew;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChangeActive = new vscode.EventEmitter<Session | undefined>();
  readonly onDidChangeActive = this._onDidChangeActive.event;
  private readonly _onDidChangeRuns = new vscode.EventEmitter<void>();
  readonly onDidChangeRuns = this._onDidChangeRuns.event;
  private readonly _onAgentEvent = new vscode.EventEmitter<AgentEvent>();
  /** Every agent event broadcast to the chat surfaces (the task queue watches its chats' errors). */
  readonly onAgentEvent = this._onAgentEvent.event;
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
  /** Marks this window's worktrees (`vscode:<store hash>`, set by the extension host) so only it prunes them. */
  worktreeOwner = 'vscode';
  /** The self-healing engine's service (set by the extension host): recovery card actions and the interrupted-state index. */
  healing?: HealingService;
  /** Set once the window is closing: runs are stopped with reason `shutdown`, so their recovery state stays resumable. */
  private shuttingDown = false;
  /** Self-healing outcome of each chat's last top-level turn that reported one. */
  private readonly outcomes = new Map<string, { outcome: TaskOutcome; interventionId?: string; report?: string }>();
  private _commands?: CommandManager;
  private commandsSub?: vscode.Disposable;
  private _mcp?: McpManager;
  private mcpSub?: vscode.Disposable;
  /** MCP servers for the composer's server popover and `/mcp:<server>:<prompt>`; set by the extension host. */
  get mcp(): McpManager | undefined {
    return this._mcp;
  }
  set mcp(m: McpManager | undefined) {
    this.mcpSub?.dispose();
    this._mcp = m;
    this.mcpSub = m?.onDidChange(() => this.broadcast(mcpChatStatus(m)));
  }
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
    const offCommands = onCommandRunChange((r) => this.broadcast({ type: 'commandState', sessionId: r.sessionId, id: r.id, state: r.state, logPath: r.logPath }));
    this.disposables.push(
      new vscode.Disposable(offCommands),
      // The composer's auto-approve bar follows the settings, also when they change in the Settings UI or another window.
      vscode.workspace.onDidChangeConfiguration((e) => affectsAutoApprove(e) && this.broadcast(autoApproveState(this.log))),
      vscode.workspace.onDidChangeConfiguration((e) => affectsUiPrefs(e) && this.broadcast(uiPrefsMsg(this.whatsNew?.pending))),
      store.onDidChange(() => this.broadcast({ type: 'sessions', sessions: store.list() })),
      // Retention pruning and history clearing drop chats in the store: release their snapshots too.
      store.onDidDelete((id) => {
        tracker.forget(id);
        this.outcomes.delete(id);
        if (this.healing) {
          forgetRecovery(this.healing, id).catch((e) => this.log.warn(`Self-healing: could not forget the recovery state of ${id}: ${e instanceof Error ? e.message : String(e)}`));
        }
      }),
      providers.onDidChange(() => void this.pushModels()),
      providers.onDidRemoveModels((ids) => this.dropRemovedModels(ids)),
      // New/installed/removed skills and subagents show up in `/skill`, `/agent` and the suggestion chips right away.
      skills.onDidChange(() => this.broadcast(this.skillsMsg())),
      tracker.onDidChange(() => {
        for (const id of new Set([...this.store.list().map((s) => s.id)])) {
          if (this.tracker.forSession(id).length || id === this.activeSessionId) {
            this.pushChanges(id);
          }
        }
      }),
      // The empty chat offers actions on the file you are looking at ("Explain dice.py"), so it follows the editor.
      // Selection changes fire on every caret move: only "has a selection" flipping is worth a message.
      vscode.window.onDidChangeActiveTextEditor(() => this.pushOpenFiles()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const sel = e.selections.some((x) => !x.isEmpty);
        if (sel !== this.lastSelection) {
          this.pushOpenFiles();
        }
      })
    );
  }
  private lastSelection = false;
  private openFilesTimer: ReturnType<typeof setTimeout> | undefined;
  private fileIndex?: FileIndex;
  /** The workspace file index behind the `@` menu, built on the first search. */
  private get mentionIndex(): FileIndex {
    return (this.fileIndex ??= new FileIndex());
  }
  private pushOpenFiles(): void {
    clearTimeout(this.openFilesTimer);
    this.openFilesTimer = setTimeout(() => this.broadcast(this.openFilesMsg()), 250);
  }
  /** A live editor for `st`: the active one, or the remembered editor's document re-shown without taking focus. */
  private async editorFor(st: EditorState): Promise<vscode.TextEditor> {
    const active = vscode.window.activeTextEditor;
    if (active && active.document === st.document) {
      return active;
    }
    const key = st.document.uri.toString();
    const column =
      vscode.window.visibleTextEditors.find((e) => e.document === st.document)?.viewColumn ??
      vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key))?.viewColumn;
    return vscode.window.showTextDocument(st.document, { viewColumn: column, preserveFocus: true, selection: st.selection });
  }
  private openFilesMsg(): ToWebview {
    const ed = currentEditor();
    this.lastSelection = !!ed && ed.selections.some((x) => !x.isEmpty);
    const active = ed && ed.document.uri.scheme === 'file' ? vscode.workspace.asRelativePath(ed.document.uri) : undefined;
    return { type: 'openFiles', files: this.workspace.openEditors(), active, selection: this.lastSelection };
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
    return [...this.sinks].some((s) => !s.handlesPrompts && (!s.visible || s.visible()));
  }

  /** True when prompts of this session need native UI: the participant owns it, or no surface can show cards. */
  private promptsNative(sessionId: string): boolean {
    const s = [...this.sinks];
    return s.some((x) => x.handlesPrompts?.(sessionId)) || !s.some((x) => !x.handlesPrompts);
  }

  /** Prefills the composer (used by Settings → "Create skill" and other entry points). */
  draft(text: string): void {
    // A view revealed just now may still be loading; it picks the draft up when it boots.
    this.pendingDraft = { text, at: Date.now() };
    this.broadcast({ type: 'draft', text });
  }
  private pendingDraft?: { text: string; at: number; attachments?: string[]; append?: boolean };

  /** Adds chips and a draft paragraph to the current chat's composer and focuses it, without sending ("Add to Chat"). */
  addToComposer(text: string, attachments: string[] = []): void {
    this.pendingDraft = { text, at: Date.now(), attachments, append: true };
    this.broadcast({ type: 'draft', text, attachments, append: true });
  }

  /** Adds an image to the composer of every chat surface (the PDF viewer's "Attach page as image"). */
  attachImage(img: ImageAttachment): void {
    // No chat webview yet (revealed just now, still resolving): it gets the image when it boots.
    if (![...this.sinks].some((s) => !s.handlesPrompts)) {
      this.pendingImages = [...this.pendingImages.filter((p) => Date.now() - p.at < 15_000), { img, at: Date.now() }];
    }
    this.broadcast({ type: 'image', image: img });
  }
  private pendingImages: { img: ImageAttachment; at: number }[] = [];

  /** Answers the surface that asked (side bar or editor tab); without one (commands) every surface gets it. */
  private replyTo(reply: Sink | undefined, m: ToWebview): void {
    if (reply) {
      reply.post(m);
    } else {
      this.broadcast(m);
    }
  }

  private broadcast(msg: ToWebview): void {
    // A toast that points at the log gets a button that opens it.
    if (msg.type === 'toast' && !msg.action && /\blog\b/i.test(msg.text)) {
      msg = { ...msg, action: { label: 'Open log', msg: { type: 'showLog' } } };
    }
    this.record(msg);
    if (msg.type === 'event') {
      this._onAgentEvent.fire(msg.event);
    }
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
      try {
        s.post(msg);
      } catch (e) {
        this.log.warn(`chat surface failed to handle ${msg.type}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Chats with a manual compaction in flight: a second click does not start another, and a message waits for it. */
  private readonly compacting = new Map<string, Promise<void>>();
  /** Chats whose run is being set up (before `runs` has it), so two quick sends cannot both start one. */
  private readonly starting = new Set<string>();
  /** "Send after this turn" messages, per chat. */
  private readonly afterTurn = new MessageQueue();
  /** What the user typed for each pending steer (the queued message also carries attachment blocks), for the banner and ✎. */
  private readonly steerDrafts = new Map<string, { text: string; attachments: string[]; images?: string[] }>();
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
        try {
          s.post({ type: 'event', event });
        } catch (e) {
          this.log.warn(`chat surface failed to handle ${event.type}: ${e instanceof Error ? e.message : String(e)}`);
        }
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
      case 'queue':
      case 'approval':
      case 'question':
      case 'paused':
      case 'commandState':
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
      } else if (e.type === 'tool_progress') {
        // Live command output: one growing item per call, so a chatty build does not flood the replay buffer.
        const p = e.payload as { id?: string; chunk?: string } | undefined;
        const last = r.items[r.items.length - 1];
        const lp = last?.type === 'event' && last.event.type === 'tool_progress' ? (last.event.payload as { id?: string; chunk?: string }) : undefined;
        if (lp && p?.id && lp.id === p.id) {
          lp.chunk = `${lp.chunk ?? ''}${p?.chunk ?? ''}`.slice(-REPLAY_RESULT_LIMIT);
        } else {
          r.items.push({ type: 'event', event: { ...e, payload: { ...p } } });
        }
        r.bytes += (p?.chunk ?? '').length + (p?.id ? 0 : 400);
      } else if (e.type === 'tool_end') {
        // Results are shown collapsed in the step row; a huge one is trimmed here and read in full from the transcript later.
        const p = e.payload as { content?: unknown; data?: { content?: unknown } } | undefined;
        const trim = (c: unknown) => (typeof c === 'string' && c.length > REPLAY_RESULT_LIMIT ? `${c.slice(0, REPLAY_RESULT_LIMIT)}\n… (${(c.length - REPLAY_RESULT_LIMIT).toLocaleString()} more characters)` : c);
        const payload = p && typeof p === 'object' ? { ...p, content: trim(p.content), ...(p.data && typeof p.data === 'object' && 'content' in p.data ? { data: { ...p.data, content: trim(p.data.content) } } : {}) } : p;
        r.items.push({ type: 'event', event: { ...e, payload } });
        const q = payload as { content?: unknown; data?: { content?: unknown; image?: { data?: unknown } } } | undefined;
        const len = (c: unknown) => (typeof c === 'string' ? c.length : 0);
        r.bytes += 200 + len(q?.content) + len(q?.data?.content) + len(q?.data?.image?.data);
      } else if (e.type === 'recovery' && recoveryKey(e)) {
        // The card is updated in place by id: only its latest state needs replaying.
        const key = recoveryKey(e);
        r.items = r.items.filter((m) => !(m.type === 'event' && m.event.type === 'recovery' && recoveryKey(m.event) === key));
        r.items.push(msg);
        r.bytes += 1000;
      } else {
        if (e.type === 'steer') {
          this.forgetSteers(sid!, ((e.payload as { ids?: string[] } | undefined)?.ids) ?? []);
        }
        r.items.push(msg);
        let size = 200;
        try {
          size += JSON.stringify(e.payload ?? '').length;
        } catch {
          /* circular or unserialisable: count the flat estimate */
        }
        r.bytes += size;
      }
    } else {
      if (msg.type === 'paused') {
        // Only the latest pause state of the run / of each worker matters.
        r.items = r.items.filter((m) => !(m.type === 'paused' && m.childId === msg.childId));
      } else if (msg.type === 'queue') {
        r.items = r.items.filter((m) => m.type !== 'queue');
      }
      r.items.push(msg);
      r.bytes += msg.type === 'steerQueued' ? msg.content.length + 200 : 400;
    }
    if (r.bytes > REPLAY_BYTES_LIMIT) {
      // Restart from what is persisted: a late webview shows those messages from the transcript and only the tail live.
      const session = this.store.get(sid!);
      r.base = session ? session.messages.length : r.base;
      r.anchor = undefined;
      r.items = r.items.filter((m) => m.type === 'approval' || m.type === 'question' || m.type === 'steerQueued' || m.type === 'queue');
      r.bytes = 0;
      r.truncated = true;
    }
  }

  /** An approval has been answered (or the agent moved on): it must not be shown again on reopen. */
  private forgetApproval(id: string): void {
    for (const r of this.replays.values()) {
      const i = r.items.findIndex((m) => (m.type === 'approval' || m.type === 'question') && m.id === id);
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
    if (ids.some((id) => this.steerDrafts.delete(id))) {
      // After the `steer` event itself, so the chat has already marked those rows as added.
      queueMicrotask(() => this.broadcastQueue(sessionId));
    }
  }

  /**
   * Index of the first message the current run appended. Compaction replaces the array with `[summary, ...recent]`
   * (same objects for the kept tail), so the run's user message is looked up again rather than trusting the index.
   */
  private runBase(session: Session, r: RunReplay): number {
    if (!r.anchor) {
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
    // The folder the chat works in, for the task header's badge.
    const cwd = session.worktree ? path.join(session.worktree.path, session.worktree.subdir ?? '') : this.workspace?.root;
    if (!r) {
      return { type: 'session', session, offers, cwd };
    }
    const base = Math.min(this.runBase(session, r), session.messages.length);
    // The user's own message of the turn is shown from the transcript; everything the loop appended after it is live.
    const first = session.messages[base];
    const liveFrom = first && first === r.anchor ? base + 1 : base;
    return { type: 'session', session, liveFrom, offers, cwd };
  }

  /** Updates a session's skill offers and redraws it where it is shown. */
  private setOffers(sessionId: string, next: SkillOffer | undefined): void {
    if (next && (next.available || next.create || next.ready)) {
      this.offers.set(sessionId, next);
    } else {
      this.offers.delete(sessionId);
    }
    const s = this.store.peek(sessionId);
    if (s && !this.runs.has(sessionId) && s.id === this.activeSessionId) {
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
    this.postInterrupted(s.id);
    this._onDidChangeActive.fire(s);
    // A prompt of the chat the user just left is now out of sight.
    this.mirrorPendingApprovals();
  }

  private pushChanges(sessionId: string): void {
    // Coalesced: tool results can land many times a second (parallel reads, several workers), and each push shells
    // out to git for worktree sessions. One computation in flight per session; a request that arrives meanwhile
    // runs once more afterwards so the result is never stale.
    const st = this.pushState.get(sessionId) ?? { pending: false, running: false };
    this.pushState.set(sessionId, st);
    // Entries of chats that no longer exist go once the map grows (it gained one per chat that ever ran a worktree).
    if (this.pushState.size > 100) {
      const live = new Set(this.store.list().map((x) => x.id));
      for (const [id, v] of this.pushState) {
        if (!live.has(id) && !v.running && !v.pending) {
          clearTimeout(v.timer);
          this.pushState.delete(id);
        }
      }
    }
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
    this.broadcast({
      type: 'changes',
      sessionId,
      files: tracked,
      checkpoints: this.tracker.checkpoints(sessionId),
      gitCheckpoints: (session?.checkpoints?.history ?? []).filter((e) => gitCheckpoint(session?.checkpoints, e.run)).map((e) => e.run),
      checkpointsEnabled: getConfig().checkpointsEnabled,
      lastTurn: await this.lastTurnChanges(session),
    });
  }

  /** How many files changed since the active chat's latest message (git when it has a checkpoint, else the turn's snapshots). */
  private async lastTurnChanges(s: Session | undefined): Promise<{ key: number; files: number } | undefined> {
    const key = s && lastTurnKey(s);
    if (!s || key === undefined || s.worktree || this.runs.has(s.id) || s.id !== this.activeSessionId) {
      return undefined;
    }
    const entry = gitCheckpoint(s.checkpoints, key);
    const changed = entry && this.runner.checkpoints ? await this.runner.checkpoints.changedFiles(entry).catch(() => undefined) : undefined;
    // Counted the way viewChanges lists them, so the button never promises files the diff leaves out.
    const viewable = async ([fsPath, original]: [string, string | undefined]) => this.inWorkspace(fsPath) && (original !== undefined || (await ChatController.exists(fsPath)));
    let files = 0;
    for (const snap of this.tracker.turnOriginals(s.id, key)) {
      if ((!changed || relativeIn(entry!.root!, snap[0]) === undefined) && (await viewable(snap))) {
        files++;
      }
    }
    if (changed) {
      files += changed.filter((f) => this.inWorkspace(path.join(entry!.root!, ...f.path.split('/')), entry!.root)).length;
    }
    return { key, files };
  }

  /** Whether a file belongs to the open workspace (a repository root can sit above it). */
  private inWorkspace(fsPath: string, root?: string): boolean {
    return vscode.workspace.workspaceFolders?.length ? !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath)) : !!root && relativeIn(root, fsPath) !== undefined;
  }

  private static exists(fsPath: string): Promise<boolean> {
    return Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).then(
      () => true,
      () => false
    );
  }

  /** Whether this session's agent should work in an isolated worktree, per `localpilot.worktrees.mode`. */
  private shouldIsolate(session: Session): boolean {
    const mode = getConfig().worktrees.mode;
    return !!this.worktrees && !!this.workspace.root && !session.direct && (mode === 'always' || (mode === 'parallel' && !!session.isolated));
  }

  /** Create the session's worktree if it needs one and does not have it yet. Quietly falls back to the workspace outside git. */
  private async ensureWorktree(session: Session, status: (text: string) => void, signal?: AbortSignal): Promise<void> {
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
      // In a subfolder of the repository the agent works in the same subfolder of the copy.
      const subdir = path.relative(repo, this.workspace.root);
      // Unsaved editor buffers are what the model sees in context, so the copy starts from them too.
      const overlay: Record<string, string> = {};
      for (const d of vscode.workspace.textDocuments) {
        if (!d.isDirty || d.uri.scheme !== 'file') {continue;}
        const rel = path.relative(repo, d.uri.fsPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {continue;}
        overlay[rel.split(path.sep).join('/')] = d.getText();
      }
      const unsaved = Object.keys(overlay).length;
      if (unsaved) {
        status(`Copied ${unsaved} unsaved file(s) into the isolated workspace`);
        this.log.info(`worktree for ${session.id}: copied ${unsaved} unsaved file(s)`);
      }
      const wt = await this.worktrees.create(repo, session.id, { progress: status, signal, subdir, owner: this.worktreeOwner, overlay });
      // Stopped, or the chat was deleted, while the copy was being made: nothing will use it.
      if (signal?.aborted || !this.store.get(session.id)) {
        await this.worktrees.remove(wt).catch((e) => this.log.warn(`worktree for ${session.id} could not be removed: ${String(e)}`));
        return;
      }
      session.worktree = wt;
      session.isolated = true;
      this.store.save(session);
      this.telemetry?.record({ type: 'worktree', action: 'create', durationMs: Date.now() - started });
    } catch (e) {
      if (signal?.aborted) {
        return;
      }
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
    const run = this.runs.get(sessionId);
    if ((run && !run.holding) || (!run && this.starting.has(sessionId))) {
      this.broadcast({ type: 'toast', level: 'info', text: 'Pause or stop the agent before applying its changes.' });
      return undefined;
    }
    const wt = session.worktree;
    try {
      const res = await this.worktrees.apply(wt, (fsPath) => this.tracker.beforeChange(fsPath, sessionId));
      this.applyConflicts.set(sessionId, res.conflicts);
      this.telemetry?.record({ type: 'worktree', action: 'apply', files: res.files.length, conflicts: res.conflicts.length });
      // Further work in the worktree is measured from here, so applying again never re-applies these changes.
      let rebaseError: string | undefined;
      try {
        await this.worktrees.rebase(wt);
      } catch (e) {
        rebaseError = e instanceof Error ? e.message : String(e);
      }
      this.store.save(session);
      this.tracker.keep(sessionId); // applied = the user's decision; the workspace diff is now visible in git itself
      this.pushChanges(sessionId);
      if (rebaseError) {
        this.broadcast({ type: 'toast', level: 'error', text: `Applied ${res.files.length} file${res.files.length === 1 ? '' : 's'}, but the new base could not be recorded: ${rebaseError}` });
        return { files: res.files.length, conflicts: res.conflicts };
      }
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
  async discardWorktree(sessionId: string, opts: { confirm?: boolean } = {}): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session?.worktree || !this.worktrees) {
      return;
    }
    if (opts.confirm) {
      const n = (await this.worktrees.changes(session.worktree).catch(() => [])).length;
      if (n && (await vscode.window.showWarningMessage(`Discard the agent's ${n} unapplied file change${n === 1 ? '' : 's'}?`, { modal: true }, 'Discard')) !== 'Discard') {
        return;
      }
    }
    if (this.runs.has(sessionId)) {
      this.stop(sessionId);
    }
    releaseIntegratedTerminal(sessionId);
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

  /** `/deep-planning`: the plan a finished turn ended with, as `implementation_plan.md` in the chat's workspace. */
  private async writeImplementationPlan(sessionId: string, outcome: PlanTurnOutcome): Promise<void> {
    const root = this.sessionRoot(sessionId);
    if (!root) {
      return;
    }
    try {
      if (await saveImplementationPlan(root, outcome)) {
        this.broadcast({ type: 'toast', level: 'info', text: 'Plan saved to implementation_plan.md — switch to Agent mode and say "implement the plan" to carry it out.' });
      }
    } catch (e) {
      this.log.warn(`could not write implementation_plan.md: ${String(e)}`);
    }
  }

  /** A custom command or workflow named inside a message without a leading command (`please /review this`). */
  private inlineCommand(text: string): { command: CustomCommand; args: string; inline: SlashToken } | undefined {
    const commands = this._commands;
    if (!commands) {
      return undefined;
    }
    const known = (name: string) => {
      const c = commands.get(name);
      return !!c && c.source !== 'builtin';
    };
    const tok = findSlashToken(text, known);
    const command = tok && commands.get(tok.name);
    return tok && command ? { command, args: '', inline: tok } : undefined;
  }

  /** `/newtask [note]`: a new chat that starts from a hand-off summary of this one, linked to it as its parent. */
  private async newTask(sessionId: string, note: string): Promise<void> {
    const s = this.store.get(sessionId);
    if (!s || this.isRunning(s.id) || this.compacting.has(s.id)) {
      return;
    }
    if (!s.messages.some((m) => m.role === 'assistant' && m.content.trim())) {
      this.broadcast({ type: 'toast', level: 'info', text: 'Nothing to hand off yet — /newtask summarises a chat that has some work in it.' });
      return;
    }
    let finished: () => void = () => undefined;
    this.compacting.set(s.id, new Promise<void>((r) => (finished = r)));
    try {
      const { provider, model: picked } = await this.providers.resolve(s.model);
      const model = { ...picked, contextWindow: effectiveContextWindow(picked, getConfig().contextWindow) };
      const cm = new ContextManager({ compactionThreshold: 0, maxToolOutputChars: getConfig().maxToolOutputChars, keepAlive: getConfig().keepAlive || undefined, scale: () => tokenCalibration.scale(model.id), strategy: getConfig().compactionStrategy === 'basic' ? 'basic' : 'agentic' });
      this.broadcast({ type: 'toast', level: 'info', text: cm.strategy === 'basic' ? 'Preparing the hand-off…' : `Summarising this chat for the new task with ${model.name}…` });
      // Everything is summarised (nothing kept verbatim). A chat too long or a summary that fails gets compact()'s
      // size-capped digest, one that times out or is too short to compact the deterministic digest here.
      const digest = () => basicSummary(s.messages, BASIC_KEEP_ASSISTANT, Math.floor(model.contextWindow * 0.4) * 4);
      const res = await cm.compact(s.messages, provider, model, AbortSignal.timeout(180_000), 0, true).catch((e) => {
        this.log.warn(`newtask: summary failed, handing off the digest instead (${e instanceof Error ? e.message : String(e)})`);
        return { summary: '' };
      });
      const summary = res.summary.trim() || digest();
      const child = this.createSession(s.mode);
      child.model = s.model;
      child.title = (note || `${s.title} (continued)`).slice(0, 60);
      child.parentId = s.id;
      child.parentTitle = s.title;
      child.skills = s.skills ? structuredClone(s.skills) : undefined;
      child.messages = [
        {
          role: 'user',
          content: `<conversation_summary>\n${summary}\n</conversation_summary>\n${note ? `Note for this task: ${note}\n` : ''}This is a new task continuing the chat "${s.title}"; the summary above is the context it hands over.`,
          meta: { summary: true, timestamp: Date.now() },
        },
      ];
      this.store.save(child);
      this.setActive(child);
      this.broadcast({ type: 'toast', level: 'info', text: `New task started from a summary of "${s.title}"` });
      this.broadcast({ type: 'focusInput' });
    } catch (e) {
      this.log.warn(`newtask: ${e instanceof Error ? e.message : String(e)}`);
      this.broadcast({ type: 'toast', level: 'error', text: `Could not summarise this chat for a new task (${e instanceof Error ? e.message : String(e)})` });
    } finally {
      this.compacting.delete(s.id);
      finished();
    }
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
    if (session.id === this.activeSessionId) {
      this.broadcast(this.sessionMsg(session));
    }
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
      const msgs = (this.store.peek(row.id)?.messages ?? []).filter((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.steer && !m.meta?.summary && !m.meta?.toolImages);
      for (const m of msgs.reverse()) {
        const t = promptText(m);
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
    releaseIntegratedTerminal(sessionId);
    if (session?.worktree && this.worktrees) {
      await this.worktrees.remove(session.worktree).catch(() => undefined);
    }
  }

  /** Folder hooks run in for a session: its worktree while isolated, otherwise the workspace. */
  private sessionRoot(sessionId: string): string | undefined {
    const wt = this.store.get(sessionId)?.worktree;
    return wt ? path.join(wt.path, wt.subdir ?? '') : this.workspace.root;
  }

  /** Delete worktrees left behind by sessions that no longer exist (e.g. after a crash). */
  async pruneWorktrees(): Promise<number> {
    await this.loaded.catch(() => undefined);
    if (!this.store.loadedOk || !this.worktrees || !this.workspace.root) {
      return 0;
    }
    const repo = await this.worktrees.repoRoot(this.workspace.root);
    if (!repo) {
      return 0;
    }
    return this.worktrees.prune(repo, new Set(this.store.list().map((s) => s.id)), this.worktreeOwner);
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

  async handle(msg: FromWebview, reply?: Sink): Promise<void> {
    switch (msg.type) {
      case 'mcpStatus':
        this.broadcast(mcpChatStatus(this._mcp));
        return;
      case 'mcpToggle':
      case 'mcpRestart':
        await handleMcpChatAction(this._mcp, msg, (level, text) => this.broadcast({ type: 'toast', level, text }), (m) => this.broadcast(m));
        return;
      case 'setApproval': {
        const err = await setAutoApprove(msg.key, msg.value, this.log);
        if (err) {
          this.broadcast({ type: 'toast', level: 'error', text: err });
          this.broadcast(autoApproveState(this.log));
        }
        return;
      }
      case 'ready': {
        await this.sendInit();
        this.broadcast(mcpChatStatus(this._mcp));
        this.broadcast(autoApproveState(this.log));
        // Opening the chat is the earliest sign a request is coming: start loading its model now.
        const s = this.activeSessionId ? this.store.get(this.activeSessionId) : undefined;
        if (s && !this.runs.has(s.id)) {
          void this.warm(s).catch(() => undefined);
        }
        return;
      }
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
        // Before stopping: the aborted run's `send` drains the queue, which must not start a turn in a chat being deleted.
        this.afterTurn.clear(msg.id);
        this.stop(msg.id);
        this.tracker.forget(msg.id);
        await this.runner.hooks?.sessionEnd(msg.id, 'other', this.sessionRoot(msg.id));
        await this.dropWorktree(msg.id);
        await this.store.delete(msg.id);
        clearTimeout(this.pushState.get(msg.id)?.timer);
        this.pushState.delete(msg.id);
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
      case 'listSessions': {
        const { type: _type, seq, ...q } = msg;
        this.replyTo(reply, { type: 'sessionPage', seq, page: this.store.listSessions(q) });
        return;
      }
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
        if (msg.format === 'html') {
          const html = await this.store.exportHtml(msg.id);
          const name = (this.store.peek(msg.id)?.title ?? 'chat').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';
          const base = vscode.workspace.workspaceFolders?.[0]?.uri;
          const target = html && (await vscode.window.showSaveDialog({ defaultUri: base ? vscode.Uri.joinPath(base, `${name}.html`) : undefined, filters: { HTML: ['html'] }, saveLabel: 'Export' }));
          if (target) {
            await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
            void vscode.window.showInformationMessage(`Chat exported to ${vscode.workspace.asRelativePath(target)}`);
          }
          return;
        }
        const md = await this.store.exportMarkdown(msg.id);
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
        await vscode.window.showTextDocument(doc);
        return;
      }
      case 'improvePrompt':
        if (msg.cancel) {
          this.improving.get(msg.sessionId)?.abort();
        } else {
          await this.improvePrompt(msg.sessionId, msg.text);
        }
        return;
      case 'send':
        await this.send(msg.sessionId, msg.text, msg.attachments ?? [], msg.images, msg.modeOverride === 'ask' || msg.modeOverride === 'agent' ? { mode: msg.modeOverride } : {});
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
            const last = s?.messages.slice().reverse().find((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.toolImages && !m.meta?.toolResults);
            const prompt = (last ? (last.meta?.display ?? userText(last.content)) : '').replace(/^\/skill \S+\s*/, '').trim();
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
      case 'pathsExist': {
        const wt = msg.sessionId ? this.store.peek(msg.sessionId)?.worktree : undefined;
        const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
        const exists = await checkPathsExist(Array.isArray(msg.paths) ? msg.paths : [], { folders, worktreeRoot: wt ? path.join(wt.path, wt.subdir ?? '') : undefined });
        (reply ?? { post: (m: ToWebview) => this.broadcast(m) }).post({ type: 'pathsExistResult', seq: msg.seq, sessionId: msg.sessionId, exists });
        return;
      }
      case 'dismissWhatsNew':
        await this.whatsNew?.dismiss();
        this.broadcast(uiPrefsMsg());
        return;
      case 'openChangelog': {
        const file = this.whatsNew?.changelog;
        if (file) {
          await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file)).then(undefined, () => vscode.window.showTextDocument(vscode.Uri.file(file)));
        }
        return;
      }
      case 'stop':
        return this.stop(msg.sessionId);
      case 'recoveryAction':
        return this.recoveryAction(msg);
      case 'detachCommand':
        detachCommand(msg.id);
        return;
      case 'stopCommand':
        stopCommand(msg.id);
        return;
      case 'pause':
        return void this.pause(msg.sessionId);
      case 'resume':
        return void this.resume(msg.sessionId);
      case 'steer':
        await this.steer(msg.sessionId, msg.text, msg.attachments ?? [], msg.images);
        return;
      case 'queueAfterTurn':
        return this.queueAfterTurn(msg.sessionId, msg.text, msg.attachments ?? [], msg.images);
      case 'cancelQueued':
        return this.cancelQueued(msg.sessionId, msg.id, !!msg.edit);
      case 'stopChild':
        return void this.childControl(msg.sessionId, msg.childId)?.stop();
      case 'pauseChild':
        return void this.childControl(msg.sessionId, msg.childId)?.pause();
      case 'resumeChild':
        return void this.childControl(msg.sessionId, msg.childId)?.resume();
      case 'approval': {
        const pending = this.approvals.get(msg.id);
        if (pending) {
          const remember = msg.approved && msg.remember && !pending.mandatory;
          if (remember) {
            this.rememberApproval(pending.sessionId, pending.kind);
          }
          this.settleApproval(msg.id, msg.approved, msg.approved ? undefined : msg.feedback);
          if (remember) {
            // Parallel workers may already be waiting on the same kind of action.
            for (const [id, other] of [...this.approvals]) {
              if (other.sessionId === pending.sessionId && other.kind === pending.kind && !other.mandatory) {
                this.settleApproval(id, true);
              }
            }
          }
        }
        return;
      }
      case 'revokeGrant':
        if (this.sessionApprovalMemory.get(msg.sessionId)?.delete(msg.kind)) {
          this.broadcastGrants(msg.sessionId);
        }
        return;
      case 'showLog':
        await vscode.commands.executeCommand('localpilot.showLogs');
        return;
      case 'answer':
        this.settleQuestion(msg.id, msg.answers);
        return;
      case 'setModel': {
        const s = this.store.get(msg.sessionId);
        if (s && (s.model !== msg.model || msg.makeDefault)) {
          this.telemetry?.record({ type: 'model_selected', sid: s.id, model: msg.model, source: 'picker', makeDefault: msg.makeDefault || undefined });
        }
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
      case 'setThink': {
        const s = this.store.get(msg.sessionId);
        if (s) {
          const level = msg.think === null || msg.think === undefined ? undefined : parseThinkChoice(msg.think);
          s.think = level;
          this.store.save(s);
          this.broadcast(this.sessionMsg(s));
        }
        return;
      }
      case 'toggleFavoriteModel':
        await toggleFavoriteModel(this.modelPrefs, msg.model);
        return this.pushModels();
      case 'useModelId': {
        const id = await addManualModel(msg.providerId, msg.modelId);
        await this.providers.listModels(true).catch(() => []);
        const s = this.store.get(msg.sessionId);
        if (s) {
          s.model = id;
          this.store.save(s);
          this.broadcast(this.sessionMsg(s));
        }
        return this.pushModels();
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
          if (s.mode !== msg.mode) {
            this.telemetry?.record({ type: 'mode_switch', sid: s.id, from: s.mode, to: msg.mode, source: 'picker' });
          }
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
      case 'detectModels':
        await vscode.commands.executeCommand('localpilot.refreshModels');
        return;
      case 'openFile': {
        const root = this.workspace.root;
        const absolute = msg.path.startsWith('/') || /^[a-z]:[\\/]/i.test(msg.path);
        // Relative refs may carry a multi-root `folder/` prefix or live in a folder other than the first.
        let uri = absolute ? vscode.Uri.file(msg.path) : root ? await this.workspace.resolveRef(msg.path) : undefined;
        // A worktree chat's paths name files in its isolated copy, not the main checkout.
        const wt = msg.sessionId ? this.store.peek(msg.sessionId)?.worktree : undefined;
        if (wt) {
          const wtRoot = path.join(wt.path, wt.subdir ?? '');
          const from = path.join(wt.repo, wt.subdir ?? '');
          const within = (p: string, dir: string) => { const r = path.relative(dir, p); return !r.startsWith('..') && !path.isAbsolute(r); };
          if (!absolute || (within(msg.path, from) && !within(msg.path, wtRoot))) {
            const candidate = vscode.Uri.file(path.join(wtRoot, absolute ? path.relative(from, msg.path) : msg.path));
            if (await vscode.workspace.fs.stat(candidate).then(() => true, () => false)) {
              uri = candidate;
            }
          }
        }
        if (!uri) {
          return;
        }
        const stat = await vscode.workspace.fs.stat(uri).then((s) => s, () => undefined);
        if (stat && stat.type & vscode.FileType.Directory) {
          await vscode.commands.executeCommand('revealInExplorer', uri);
          return;
        }
        try {
          // `x.pdf:3` arrives as line 3: for a PDF that is the page.
          if (isPdfPath(uri.path)) {
            await openPdf(uri, msg.line);
            return;
          }
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
        const st = currentEditor();
        if (!st) {
          this.broadcast({ type: 'toast', level: 'error', text: 'No active editor to insert into' });
          return;
        }
        const ed = await this.editorFor(st);
        await ed.edit((b) => (ed.selection.isEmpty ? b.insert(ed.selection.active, msg.code) : b.replace(ed.selection, msg.code)));
        return;
      }
      case 'applyCodeToFile': {
        let ed: vscode.TextEditor | undefined;
        if (msg.path) {
          const root = this.workspace.root;
          const uri = path.isAbsolute(msg.path) ? vscode.Uri.file(msg.path) : root ? vscode.Uri.joinPath(vscode.Uri.file(root), msg.path) : undefined;
          try {
            ed = uri && (await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preserveFocus: true }));
          } catch {
            this.broadcast({ type: 'toast', level: 'error', text: `Cannot open ${msg.path}` });
            return;
          }
        } else {
          const st = currentEditor();
          ed = st && (await this.editorFor(st));
        }
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
        this.replyTo(reply, { type: 'toast', level: 'info', text: `attach:${msg.ref.replace(/^@/, '')}` });
        return;
      case 'attachActive':
      case 'pickAttachment':
        return; // handled by the view (needs the session's local attachment list)
      case 'compactNow': {
        const s = this.store.get(msg.sessionId);
        if (!s || this.isRunning(s.id) || this.compacting.has(s.id)) {
          return;
        }
        let finished: () => void = () => undefined;
        let compacted = false;
        this.compacting.set(s.id, new Promise<void>((r) => (finished = r)));
        try {
          const { provider, model: picked } = await this.providers.resolve(s.model);
          const model = { ...picked, contextWindow: effectiveContextWindow(picked, getConfig().contextWindow) };
          const cm = new ContextManager({ compactionThreshold: 0, maxToolOutputChars: getConfig().maxToolOutputChars, keepAlive: getConfig().keepAlive || undefined, scale: () => tokenCalibration.scale(model.id), strategy: getConfig().compactionStrategy === 'basic' ? 'basic' : 'agentic' });
          if (s.messages.length > 6 && cm.strategy !== 'basic') {
            this.broadcast({ type: 'toast', level: 'info', text: `Compacting with ${model.name}…` });
          }
          const snapshot = s.messages;
          const len = snapshot.length;
          // A server that stalls must not leave the chat stuck in "compacting": give up after 3 minutes, history unchanged.
          const res = await cm.compact(s.messages, provider, model, AbortSignal.timeout(180_000), 4, false);
          if (!this.store.get(s.id)) {
            return; // the chat was deleted meanwhile
          }
          if (s.messages !== snapshot || s.messages.length !== len) {
            this.broadcast({ type: 'toast', level: 'info', text: 'The chat changed while compacting — left as it was' });
            return;
          }
          if (res.removed > 0) {
            archiveCompaction(this.store, s.id, s.compactions, s.messages, res.messages);
            s.messages = res.messages;
            s.compactions++;
            // contextTokens includes the system prompt and tools, which compaction leaves alone: subtract what was saved.
            s.contextTokens = Math.max(0, s.contextTokens - (res.before - res.after));
            this.store.save(s);
            if (s.id === this.activeSessionId) {
              this.broadcast(this.sessionMsg(s));
            }
          }
          this.broadcast({ type: 'toast', level: 'info', text: res.removed > 0 ? `Compacted ${res.removed} messages: ${res.before.toLocaleString()} → ${res.after.toLocaleString()} tokens` : 'Nothing to compact yet — the conversation is still short' });
          compacted = true;
        } catch (e) {
          this.log.warn(`compact: ${e instanceof Error ? e.message : String(e)}`);
          this.broadcast({ type: 'toast', level: 'error', text: `Could not compact — the conversation was left as it was (${e instanceof Error ? e.message : String(e)})` });
        } finally {
          this.compacting.delete(s.id);
          finished();
        }
        if (msg.retry && compacted && this.store.get(s.id)) {
          await this.retry(s.id);
        }
        return;
      }
      case 'clearSession': {
        if (this.compacting.has(msg.sessionId)) {
          this.broadcast({ type: 'toast', level: 'info', text: 'Wait for the compaction to finish' });
          return;
        }
        const s = this.store.get(msg.sessionId);
        if (s && !this.isRunning(s.id)) {
          await this.runner.hooks?.sessionEnd(s.id, 'clear', this.sessionRoot(s.id));
          s.messages = [];
          s.contextTokens = 0;
          s.compactions = 0;
          s.todos = [];
          s.workingSet = [];
          await this.store.clearArchive(s.id);
          this.tracker.dropTurnsFrom(s.id, 0);
          this.store.save(s);
          this.broadcast(this.sessionMsg(s));
        }
        return;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('localpilot.openSettings', msg.section);
        return;
      case 'setTipsEnabled': {
        // The only setting the chat writes directly; the uiPrefs push that follows the change hides the row everywhere.
        // Written to the scope that holds the value in effect, so a workspace showTips: true doesn't win silently.
        const enabled = msg.enabled === true;
        await vscode.workspace.getConfiguration('localpilot').update('showTips', enabled, configTarget('showTips'));
        if (!enabled && vscode.workspace.getConfiguration('localpilot').get<boolean>('showTips') === false) {
          this.toast('Tips turned off. Turn them back on in Settings → Agent & approvals.');
        }
        return;
      }
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
            const stat = await vscode.workspace.fs.stat(uri);
            const rel = vscode.workspace.asRelativePath(uri);
            if (!(stat.type & vscode.FileType.Directory) && IMAGE_EXT.test(uri.fsPath)) {
              // readImage explains a refusal (over 12 MB or 7,680 px) itself.
              const img = await readImage(uri.fsPath);
              if (img) {
                this.replyTo(reply, { type: 'image', image: img });
              }
            } else if (!(stat.type & vscode.FileType.Directory) && stat.size > MAX_ATTACHMENT_BYTES) {
              this.replyTo(reply, { type: 'toast', level: 'error', text: `${path.basename(uri.fsPath)} is ${formatSize(stat.size)}, over the ${formatSize(MAX_ATTACHMENT_BYTES)} attachment limit` });
            } else {
              this.replyTo(reply, msg.insert ? { type: 'insertMention', ref: rel } : { type: 'toast', level: 'info', text: `attach:${rel}` });
            }
          }
        } catch {
          /* ignore */
        }
        return;
      }
      case 'pickImage':
        for (const img of await pickImages()) {
          this.replyTo(reply, { type: 'image', image: img });
        }
        return;
      case 'captureUrl':
        await this.captureUrl(msg.url, { mobile: msg.mobile, fullPage: msg.fullPage }, reply);
        return;
      case 'inspectUrl':
        await this.inspectUrl(msg.url, { mobile: msg.mobile }, reply);
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
          this.replyTo(reply, { type: 'image', image: img });
        } else {
          const hint = process.platform === 'linux' ? ' (install gnome-screenshot, spectacle, scrot or grim+slurp)' : '';
          this.broadcast({ type: 'toast', level: 'error', text: mode === 'region' || mode === 'window' ? `Screenshot cancelled${hint}` : `Screenshot failed${hint}` });
        }
        return;
      }
      case 'requestOpenFiles':
        this.broadcast(this.openFilesMsg());
        return;
      case 'mentionSearch': {
        // Commits too, once the text could be a message word or a hash (not a path).
        const q = msg.query.trim();
        const [items, commits] = await Promise.all([this.mentionIndex.search(msg.query, this.workspace.openEditors()), q.length >= 3 && !/[/"]/.test(q) ? searchCommits(q, this.workspace.root, 10).catch(() => []) : []]);
        this.broadcast({ type: 'mentionResults', query: msg.query, items, commits });
        return;
      }
      case 'openMention': {
        const command = ({ problems: 'workbench.actions.view.problems', terminal: 'workbench.action.terminal.focus', git: 'workbench.view.scm', workspace: 'workbench.view.explorer', editors: 'workbench.action.showAllEditors' } as Record<string, string>)[msg.ref.replace(/^@/, '')];
        if (command) {
          await vscode.commands.executeCommand(command);
        }
        return;
      }
      case 'clientError':
        this.log.error(`chat webview (${msg.where}): ${msg.message}${msg.stack ? `\n${msg.stack}` : ''}`);
        return;
      case 'keepChanges':
        this.tracker.keep(msg.sessionId, msg.fsPath);
        return;
      case 'undoChanges': {
        const { count: n, token } = await this.tracker.reject(msg.sessionId, msg.fsPath);
        this.broadcast({ type: 'toast', level: 'info', text: `Reverted ${n} file${n === 1 ? '' : 's'}`, ...(token !== undefined ? { action: { label: 'Undo', msg: { type: 'redoChanges', sessionId: msg.sessionId, token } } } : {}) });
        return;
      }
      case 'redoChanges': {
        const n = typeof msg.token === 'number' ? await this.tracker.redo(msg.token) : 0;
        this.broadcast({ type: 'toast', level: n ? 'info' : 'warn', text: n ? `Restored the agent's edits to ${n} file${n === 1 ? '' : 's'}` : 'Too late to undo: the rejected edits are no longer kept' });
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
        await this.discardWorktree(msg.sessionId, { confirm: true });
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
        if (s.mode !== 'agent') {
          this.telemetry?.record({ type: 'mode_switch', sid: s.id, from: s.mode, to: 'agent', source: 'plan' });
        }
        s.mode = 'agent';
        this.store.save(s);
        this.broadcast(this.sessionMsg(s));
        await this.send(s.id, 'Implement the plan: run the checklist with run_todos_parallel, then verify the combined result and summarise.');
        return;
      }
      case 'restoreCheckpoint':
        await this.rewindTo(msg.sessionId, msg.messageIndex, msg.restoreType ?? 'both', reply);
        return;
      case 'editMessage':
        await this.rewindTo(msg.sessionId, msg.messageIndex, 'edit', reply);
        return;
      case 'editAndRegenerate':
        if (!(await this.editAndRegenerate(msg))) {
          this.replyTo(reply, { type: 'editAndRegenerateResult', sessionId: msg.sessionId, index: msg.index, ok: false });
        }
        return;
      case 'checkpointExists':
        this.replyTo(reply, { type: 'checkpointExistsResult', sessionId: msg.sessionId, index: msg.index, ...(await this.checkpointExists(msg.sessionId, msg.index)) });
        return;
      case 'viewChanges':
        await this.viewChanges(msg.sessionId, msg.scope);
        return;
      case 'openCheckpointSetting':
        await vscode.commands.executeCommand('localpilot.openSettings', 'agent');
        return;
    }
  }

  /**
   * Rewinds a chat to one of the user's messages. `edit` and `task` remove that message and everything after it and
   * put it (text, images, attachments) back into the composer, keeping the files; `workspace` puts the files back as
   * they were before that turn and keeps the chat; `both` does both ("Restore checkpoint"). Files come back from the
   * turn's git checkpoint when there is one (changes made by shell commands included), else from the file snapshots.
   * `resend` (inline edit) leaves the composer and the success toast alone; false when nothing (or not all) was rewound.
   */
  private async rewindTo(sessionId: string, messageIndex: number, type: RestoreType | 'edit', reply?: Sink, opts: { resend?: boolean } = {}): Promise<boolean> {
    if (this.compacting.has(sessionId)) {
      this.broadcast({ type: 'toast', level: 'info', text: 'Wait for the compaction to finish' });
      return false;
    }
    if (this.isRunning(sessionId)) {
      if (type === 'edit') {
        this.broadcast({ type: 'toast', level: 'error', text: 'Stop the running agent before editing a message' });
        return false;
      }
      // A restore cancels the run first: its edits are what the user wants undone.
      if (!(await this.stopAndWait(sessionId))) {
        this.broadcast({ type: 'toast', level: 'error', text: 'The agent did not stop in time; try restoring again' });
        return false;
      }
    }
    const s = this.store.get(sessionId);
    const target = s?.messages[messageIndex];
    if (!s || !target || target.role !== 'user') {
      return false;
    }
    const key = target.meta?.checkpoint;
    const revertFiles = type === 'workspace' || type === 'both';
    const rewindChat = type !== 'workspace';
    // Worktree-isolated runs work in their own copy; their changes stay there until applied or discarded.
    let restore = { restored: 0, failed: 0 };
    let safetyStash: string | undefined;
    if (revertFiles && key !== undefined && !s.worktree) {
      const entry = gitCheckpoint(s.checkpoints, key);
      try {
        if (entry && this.runner.checkpoints) {
          const r = await this.runner.checkpoints.restoreWorkspace(entry);
          if (!r.ok) {
            this.telemetry?.record({ type: 'checkpoint', action: 'restore', outcome: 'failed' });
            const saved = r.safetyStash ? ' Your state before the restore is saved in git stash ("localpilot pre-restore").' : '';
            this.broadcast({ type: 'toast', level: 'error', text: `Could not restore the checkpoint: ${r.error}.${saved}` });
            return false;
          }
          // The git snapshot covers only its repository; edits outside it (another root folder) come back from the turn snapshots.
          const outside = await this.tracker.restoreTurn(s.id, key, (p) => relativeIn(entry.root!, p) === undefined);
          restore = { restored: r.files + outside.restored, failed: outside.failed };
          safetyStash = r.safetyStash;
          await this.tracker.settle(s.id);
        } else {
          restore = await this.tracker.restoreTurn(s.id, key);
        }
      } catch (e) {
        this.telemetry?.record({ type: 'checkpoint', action: 'restore', outcome: 'failed' });
        throw e;
      }
    }
    if (rewindChat) {
      // A message from before a compaction gets the original messages back from the transcript archive.
      s.messages = await this.store.historyBefore(s, messageIndex);
      s.contextTokens = 0;
      // The removed turns can no longer be restored (snapshots of files that failed to restore stay for a retry).
      if (key !== undefined && !restore.failed) {
        this.tracker.dropTurnsFrom(s.id, key);
        await this.runner.checkpoints?.dropFrom(s, key).catch((e) => this.log.warn(`checkpoint cleanup: ${String(e)}`));
      }
      this.store.save(s);
    }
    this.telemetry?.record({
      type: 'checkpoint',
      action: revertFiles ? 'restore' : 'rewind',
      outcome: revertFiles && (key === undefined || s.worktree) ? 'skipped' : restore.failed ? 'failed' : 'ok',
      files: revertFiles ? restore.restored : undefined,
    });
    if (rewindChat) {
      this.broadcast(this.sessionMsg(s));
      if (!opts.resend) {
        this.replyTo(reply, { type: 'draft', text: promptText(target), images: target.images, attachments: rewindAttachments(target.content) });
      }
    }
    this.pushChanges(s.id);
    if (opts.resend && !restore.failed) {
      return true;
    }
    const n = (k: number) => `${k} file${k === 1 ? '' : 's'}`;
    const stashNote = safetyStash ? ' (your previous state is in git stash "localpilot pre-restore")' : '';
    const what = type === 'workspace' ? 'Restored files' : 'Restored checkpoint';
    this.broadcast({
      type: 'toast',
      level: 'info',
      text:
        type === 'edit'
          ? 'Edit the message and send it again — later turns were removed, files were kept'
          : type === 'task'
            ? 'Rewound the conversation — files were kept as they are'
            : s.worktree
              ? `${type === 'both' ? 'Rewound the conversation — f' : 'F'}iles in the isolated worktree were not reverted; use Discard to drop the agent's changes`
              : key === undefined
                ? 'No checkpoint was recorded for this message — files were not changed'
                : restore.failed
                  ? `${what} — reverted ${n(restore.restored)}; ${restore.failed} could not be restored (see the LocalPilot log)`
                  : restore.restored
                    ? `${what} — reverted ${n(restore.restored)}${stashNote}`
                    : type === 'both'
                      ? 'Rewound the conversation — no file changes since this message'
                      : 'No file changes since this message',
    });
    return !restore.failed;
  }

  /**
   * Inline edit of a past message: Reset Chat (`restoreWorkspace` false) rewinds the conversation and keeps the files,
   * Reset Code also puts the files back to that turn's checkpoint; then the edited message is sent. Nothing is cut
   * when the edit is empty or the rewind fails (a failed send gives the edited text back to the composer); false when
   * nothing was resent, so the editor is released.
   */
  private async editAndRegenerate(msg: Extract<FromWebview, { type: 'editAndRegenerate' }>): Promise<boolean> {
    const text = msg.text.trim();
    let images = msg.images?.filter(Boolean) ?? [];
    if (!text && !images.length) {
      this.broadcast({ type: 'toast', level: 'error', text: 'The edited message is empty — type something or press Esc to cancel' });
      return false;
    }
    const attachments = [...new Set(msg.attachments ?? [])];
    if (attachments.length > MAX_ATTACHMENTS) {
      this.broadcast({ type: 'toast', level: 'error', text: `Up to ${MAX_ATTACHMENTS} attachments per message` });
      return false;
    }
    if (msg.restoreWorkspace && !(await this.checkpointExists(msg.sessionId, msg.index)).exists) {
      this.broadcast({ type: 'toast', level: 'error', text: 'No checkpoint for this message: use Reset Chat to keep the files as they are' });
      return false;
    }
    // An `/mcp:` turn's prompt images are fetched again when it is expanded again: only the user's own are sent.
    if (parseMcpSlash(text)) {
      images = withoutMcpPromptImages(images, this.store.get(msg.sessionId)?.messages[msg.index]) ?? [];
    }
    if (!(await this.rewindTo(msg.sessionId, msg.index, msg.restoreWorkspace ? 'both' : 'task', undefined, { resend: true }))) {
      if (!this.store.get(msg.sessionId)?.messages[msg.index]) {
        this.broadcast({ type: 'draft', text, images, attachments });
      }
      return false;
    }
    await this.send(msg.sessionId, text || 'Describe what you see in the attached image(s).', attachments, images.length ? images : undefined);
    return true;
  }

  /** Whether Reset Code / Restore files has something to put back for the user message at `index`, plus its editable draft. */
  private async checkpointExists(sessionId: string, index: number): Promise<{ exists: boolean; reason?: string; text?: string; attachments?: string[] }> {
    const s = this.store.get(sessionId);
    const target = s?.messages[index];
    if (!s || !target || target.role !== 'user') {
      return { exists: false, reason: 'This message is no longer in the chat' };
    }
    const draft = { text: promptText(target), attachments: rewindAttachments(target.content) };
    const key = target.meta?.checkpoint;
    if (s.worktree) {
      return { exists: false, reason: 'This chat works in an isolated worktree: use Discard to drop the agent\'s changes', ...draft };
    }
    if (key === undefined) {
      return { exists: false, reason: 'No checkpoint was recorded for this message', ...draft };
    }
    const entry = gitCheckpoint(s.checkpoints, key);
    if (entry && this.runner.checkpoints && (await this.runner.checkpoints.exists(entry).catch(() => false))) {
      return { exists: true, ...draft };
    }
    if (this.tracker.checkpoints(s.id).some((t) => t >= key)) {
      return { exists: true, ...draft };
    }
    return {
      exists: false,
      reason: getConfig().checkpointsEnabled ? 'No checkpoint for this message: no file changes were recorded since it ran' : 'No checkpoint for this message: checkpoints are off (localpilot.checkpoints.enabled)',
      ...draft,
    };
  }

  /** Stops a chat's run and waits (up to `ms`) for it to wind down; false when it is still running. */
  private async stopAndWait(sessionId: string, ms = 15_000): Promise<boolean> {
    this.stop(sessionId);
    const deadline = Date.now() + ms;
    while (this.runs.has(sessionId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return !this.runs.has(sessionId);
  }

  /** Multi-file diff of what changed since the chat's latest message (`turn`) or of everything the chat changed (`session`). */
  private async viewChanges(sessionId: string, scope: 'turn' | 'session'): Promise<void> {
    const s = this.store.get(sessionId);
    if (!s) {
      return;
    }
    type Item = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];
    const exists = ChatController.exists;
    const inWorkspace = (fsPath: string, root?: string) => this.inWorkspace(fsPath, root);
    const fromSnapshots = async (originals: [string, string | undefined][], turn?: number): Promise<Item[]> => {
      const items: Item[] = [];
      for (const [fsPath, original] of originals) {
        const file = vscode.Uri.file(fsPath);
        const now = await exists(fsPath);
        if ((now || original !== undefined) && inWorkspace(fsPath)) {
          items.push([file, original === undefined ? undefined : ChangeTracker.originalUri(s.id, fsPath, turn), now ? file : undefined]);
        }
      }
      return items;
    };
    let items: Item[];
    let title: string;
    if (scope === 'session') {
      title = 'Changes in this chat';
      items = await fromSnapshots(this.tracker.forSession(s.id).map((c) => [c.fsPath, c.original]));
      if (!items.length) {
        this.broadcast({ type: 'toast', level: 'info', text: 'No file changes found in this chat' });
        return;
      }
    } else {
      title = 'Changes since your last message';
      const key = lastTurnKey(s);
      const entry = key !== undefined ? gitCheckpoint(s.checkpoints, key) : undefined;
      if (entry && this.runner.checkpoints) {
        let files: ChangedFile[];
        try {
          files = await this.runner.checkpoints.changedFiles(entry);
        } catch (e) {
          this.log.warn(`view changes: ${String(e)}`);
          this.broadcast({ type: 'toast', level: 'error', text: `Could not list the changes: ${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        items = files
          .map((f): Item => {
            const file = vscode.Uri.file(path.join(entry.root!, ...f.path.split('/')));
            return [file, f.status === 'A' ? undefined : ChangeTracker.checkpointUri(entry.root!, entry.sha!, entry.kind, file.fsPath), f.status === 'D' ? undefined : file];
          })
          .filter(([file]) => inWorkspace(file.fsPath, entry.root));
        const outside = [...this.tracker.turnOriginals(s.id, key!)].filter(([fsPath]) => relativeIn(entry.root!, fsPath) === undefined);
        items.push(...(await fromSnapshots(outside, key)));
      } else {
        items = key !== undefined ? await fromSnapshots([...this.tracker.turnOriginals(s.id, key)], key) : [];
      }
      if (!items.length) {
        const text =
          key === undefined
            ? 'No checkpoint was recorded for your last message'
            : !entry && !getConfig().checkpointsEnabled
              ? 'No file edits found since your last message — checkpoints are off (localpilot.checkpoints.enabled), so changes made by commands are not tracked'
              : 'No file changes found since your last message';
        this.broadcast({ type: 'toast', level: 'info', text });
        return;
      }
    }
    await vscode.commands.executeCommand('vscode.changes', title, items);
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
    post(uiPrefsMsg(this.whatsNew?.pending));
    // Commands that outlive a run (detached dev servers) keep their Stop control on rows this webview draws later.
    for (const r of runningCommands()) {
      post({ type: 'commandState', sessionId: r.sessionId, id: r.id, state: r.state, logPath: r.logPath });
    }
    for (const [id, kinds] of this.sessionApprovalMemory) {
      if (kinds.size) {
        post({ type: 'sessionGrants', sessionId: id, kinds: [...kinds] });
      }
    }
    const s = this.activeSession;
    if (s) {
      post(this.sessionMsg(s));
      this.pushChanges(s.id);
      this.postInterrupted(s.id, post);
      this._onDidChangeActive.fire(s);
    }
    if (this.pendingDraft && Date.now() - this.pendingDraft.at < 15_000) {
      post({ type: 'draft', text: this.pendingDraft.text, attachments: this.pendingDraft.attachments, append: this.pendingDraft.append });
    }
    this.pendingDraft = undefined;
    for (const p of this.pendingImages.splice(0)) {
      if (Date.now() - p.at < 15_000) {
        post({ type: 'image', image: p.img });
      }
    }
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

  /** Chats pinned to a model that was uninstalled go back to Auto instead of falling back on every turn. */
  private dropRemovedModels(ids: string[]): void {
    const gone = new Set(ids);
    for (const summary of this.store.list()) {
      if (!summary.model || !gone.has(summary.model)) {
        continue;
      }
      if (this.runs.has(summary.id)) {
        this.removedWhileRunning.set(summary.id, new Set([...(this.removedWhileRunning.get(summary.id) ?? []), ...ids]));
        continue;
      }
      const s = this.store.get(summary.id);
      if (s) {
        s.model = '';
        this.store.save(s);
        if (s.id === this.activeSessionId) {
          this.broadcast(this.sessionMsg(s));
        }
      }
    }
    void this.pushModels();
  }

  /** The model list plus what "Auto" resolves to right now, so the picker never shows a model the router would not pick. */
  private async modelsMsg(): Promise<ToWebview> {
    const models = await this.providers.listModels().catch(() => []);
    const autoModel = models.length ? await this.providers.route({ role: 'agent', start: false }).then((r) => r.model.id, () => undefined) : undefined;
    // Group headings in the picker use the provider's name ("LM Studio", "colibri"), not its settings id.
    const providerNames = Object.fromEntries(this.providers.all.map((p) => [p.id, p.displayName]));
    return { type: 'models', models, defaultModel: getConfig().defaultModel, autoModel, contextWindow: getConfig().contextWindow, providerNames, visionRouting: getConfig().routing.enabled, favorites: favoriteModels(this.modelPrefs), manualProviders: manualModelProviders(getConfig().providers), thinking: getConfig().thinking };
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
  async captureUrl(url?: string, opts: { mobile?: boolean; fullPage?: boolean } = {}, reply?: Sink): Promise<boolean> {
    const target = url || (await this.askUrl('Screenshot a web page'));
    if (!target) {
      return false;
    }
    this.broadcast({ type: 'toast', level: 'info', text: `Rendering ${target}…` });
    try {
      const shot = await captureUrl(target, { mobile: opts.mobile, fullPage: opts.fullPage });
      this.replyTo(reply, { type: 'image', image: { name: shot.name, data: shot.data, mime: shot.mime } });
      return true;
    } catch (e) {
      this.broadcast({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** DevTools-style inspection: attaches the screenshot and drafts a message carrying the console/network/perf report. */
  async inspectUrl(url?: string, opts: { mobile?: boolean } = {}, reply?: Sink): Promise<boolean> {
    const target = url || (await this.askUrl('Inspect a web page (screenshot + console + network)'));
    if (!target) {
      return false;
    }
    this.broadcast({ type: 'toast', level: 'info', text: `Inspecting ${target}…` });
    try {
      const r = await inspectUrl(target, { mobile: opts.mobile, includeText: false });
      if (r.screenshot) {
        this.replyTo(reply, { type: 'image', image: { name: `${new URL(r.finalUrl).hostname}-inspect.png`, data: r.screenshot, mime: 'image/png' } });
      }
      const errors = r.console.filter((c) => c.level === 'error').length;
      const failed = r.network.filter((e) => e.error || (e.status ?? 0) >= 400).length;
      const summary = errors || failed || r.layout.length ? `${errors} console error${errors === 1 ? '' : 's'}, ${failed} failed request${failed === 1 ? '' : 's'}, ${r.layout.length} layout issue${r.layout.length === 1 ? '' : 's'}` : 'no errors detected';
      this.replyTo(reply, { type: 'draft', text: `I inspected ${r.finalUrl} (${summary}). Analyse the screenshot and this DevTools report, explain the root causes and fix them:\n\n\`\`\`\n${formatReport(r, { maxConsole: 15, maxNetwork: 10 })}\n\`\`\`` });
      return true;
    } catch (e) {
      this.broadcast({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  private readonly improving = new Map<string, AbortController>();

  /**
   * "Improve prompt": the chat's model rewrites the draft into a precise, self-contained request, using what the user
   * is looking at to resolve "this"/"it", and streams it back into the composer for review — nothing is sent.
   */
  private async improvePrompt(sessionId: string, draft: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session || !draft.trim()) {
      this.broadcast({ type: 'improvedPrompt', sessionId, done: true, error: 'Type a request first.' });
      return;
    }
    this.improving.get(sessionId)?.abort();
    const abort = new AbortController();
    this.improving.set(sessionId, abort);
    const lastOf = (role: 'user' | 'assistant') => [...session.messages].reverse().find((m) => m.role === role && !m.meta?.hidden && m.content.trim())?.content;
    const clip = (t: string | undefined, n: number) => (t && t.length > n ? `${t.slice(0, n)}…` : t ?? '');
    const editor = this.workspace.activeEditorContext();
    const open = this.workspace.contextEditors().slice(0, 12);
    const map = await this.workspace.projectMap().catch(() => '');
    const previous = lastOf('user') ? `User: ${clip(lastOf('user'), 600)}\nAssistant: ${clip(lastOf('assistant'), 900)}` : '';
    const context = [
      `Mode: ${session.mode}`,
      editor ? `# Editor\n${editor}` : '',
      open.length ? `# Open editors\n${open.join(', ')}` : '',
      map ? `# Project\n${map}` : '',
      previous ? `# Previous exchange in this chat\n${previous}` : '',
    ].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: IMPROVE_PROMPT_SYSTEM },
      { role: 'user', content: `<context>\n${context}\n</context>\n\n<request>\n${draft.trim()}\n</request>` },
    ];
    try {
      const raw = await quickPrompt(this.providers, messages, {
        modelRef: session.model || undefined,
        signal: abort.signal,
        maxTokens: 700,
        temperature: 0.2,
        onDelta: (delta) => this.broadcast({ type: 'improvedPrompt', sessionId, delta }),
      });
      const text = cleanImprovedPrompt(raw);
      this.broadcast({ type: 'improvedPrompt', sessionId, done: true, ...(text ? { text } : { error: 'The model returned nothing — your draft is unchanged.' }) });
    } catch (e) {
      this.broadcast({ type: 'improvedPrompt', sessionId, done: true, error: abort.signal.aborted ? 'cancelled' : `Could not improve the prompt: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (this.improving.get(sessionId) === abort) {
        this.improving.delete(sessionId);
      }
    }
  }

  /**
   * Fixes misspelled file names and identifiers in a request against the workspace (`localpilot.prompts.autoCorrect`)
   * and tells the chat, which already shows the message as typed, what was changed.
   */
  private async correctNames(sessionId: string, text: string, announce = true): Promise<{ text: string; fixes: PromptFix[] }> {
    if (!getConfig().autoCorrectPrompts || text.trimStart().startsWith('/')) {
      return { text, fixes: [] };
    }
    try {
      const result = correctPromptNames(text, await this.workspace.nameVocabulary());
      if (result.fixes.length) {
        this.log.info(`prompt: corrected ${result.fixes.map((f) => `${f.from} → ${f.to}`).join(', ')}`);
      }
      if (result.fixes.length && announce) {
        this.broadcast({ type: 'promptCorrected', sessionId, text: result.text, fixes: result.fixes });
      }
      return result;
    } catch (e) {
      this.log.debug(`prompt correction skipped: ${e instanceof Error ? e.message : String(e)}`);
      return { text, fixes: [] };
    }
  }

  async send(sessionId: string, text: string, attachments: string[] = [], images?: string[], opts: SendOptions = {}): Promise<string> {
    if (!this.store.get(sessionId)) {
      throw new Error('Session not found');
    }
    // A manual compaction rewrites the history when it finishes; a turn started meanwhile would be dropped by it.
    while (this.compacting.has(sessionId)) {
      this.broadcast({ type: 'toast', level: 'info', text: 'Compacting this chat — your message is sent when it finishes' });
      this.broadcast({ type: 'sendQueued', sessionId });
      await this.compacting.get(sessionId);
    }
    const session = this.store.get(sessionId);
    if (!session) {
      return ''; // deleted while it was compacting
    }
    if (this.runs.has(sessionId) || this.starting.has(sessionId)) {
      // A run that is still being set up registers within moments; wait for it so the message is not dropped.
      for (let i = 0; i < 50 && !this.runs.has(sessionId) && this.starting.has(sessionId); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.runs.has(sessionId) || this.starting.has(sessionId)) {
        if (opts.resume) {
          return ''; // a resume turn is never a visible steer: the chat is already continuing
        }
        // Busy: the message becomes a steering instruction for the running agent instead of being refused.
        await this.steer(sessionId, text, attachments, images);
        return '';
      }
      // The other send ended without starting a run (a slash command answered locally, a start that was cancelled):
      // steering would drop this message, so it starts a run of its own.
      if (this.compacting.has(sessionId)) {
        return this.send(sessionId, text, attachments, images, opts);
      }
    }
    this.starting.add(sessionId);
    try {
      return await this.startRun(session, sessionId, text, attachments, images, opts);
    } finally {
      this.starting.delete(sessionId);
      this.drainQueue(sessionId);
    }
  }

  private async startRun(session: Session, sessionId: string, text: string, attachments: string[], images: string[] | undefined, opts: SendOptions): Promise<string> {
    // A resume turn is LocalPilot's own hidden steer, never a slash command or a prompt to correct.
    const mcpSlash = opts.display || opts.resume ? undefined : parseMcpSlash(text);
    let mcpPromptImages = 0;
    if (mcpSlash) {
      // `/mcp:<server>:<prompt> args…`: the prompt's messages become this turn; the chat shows what was typed.
      this.telemetry?.record({ type: 'slash', command: 'mcp' });
      this.runStatus.set(sessionId, `Getting ${mcpSlash.server}:${mcpSlash.prompt}…`);
      this._onDidChangeRuns.fire();
      try {
        if (!this._mcp) {
          throw new Error('no MCP servers are running');
        }
        const r = await this._mcp.getPrompt(mcpSlash.server, mcpSlash.prompt, mcpSlash.args);
        opts = { ...opts, display: text.trim() };
        text = r.text || `(${mcpSlash.prompt} returned only images)`;
        images = r.images.length ? [...(images ?? []), ...r.images.map((i) => i.data)] : images;
        mcpPromptImages = r.images.length;
      } catch (e) {
        this.runStatus.delete(sessionId);
        this._onDidChangeRuns.fire();
        this.broadcast({ type: 'toast', level: 'error', text: `/mcp:${mcpSlash.server}:${mcpSlash.prompt}: ${e instanceof Error ? e.message : String(e)}` });
        this.broadcast({ type: 'sendRejected', sessionId });
        return '';
      }
    }
    const slash = opts.display || opts.resume ? undefined : this.handleSlash(session, text) ?? this.inlineCommand(text);
    if (slash !== undefined) {
      const custom = typeof slash === 'object' && 'command' in slash;
      this.telemetry?.record({ type: 'slash', command: custom ? slash.command.name : (/^\/([\w.:@-]+)/.exec(text.trim())?.[1] ?? '?'), custom: custom || undefined });
    }
    let planTurn = false;
    if (typeof slash === 'object' && 'command' in slash) {
      // A custom command expands inside this run (which holds `starting`), so a message sent meanwhile is steering for it.
      const cmd = slash.command;
      const fail = (t: string): string => {
        this.runStatus.delete(sessionId);
        this._onDidChangeRuns.fire();
        this.broadcast({ type: 'toast', level: 'error', text: t });
        this.broadcast({ type: 'sendRejected', sessionId });
        return '';
      };
      this.runStatus.set(sessionId, `Preparing ${cmd.invoke}…`);
      this._onDidChangeRuns.fire();
      let prompt: string;
      try {
        const expanded = await expandCommand(cmd, slash.args, { root: this.sessionRoot(sessionId) });
        for (const n of expanded.notes) {
          this.broadcast({ type: 'toast', level: 'warn', text: n });
        }
        prompt = expanded.prompt;
      } catch (e) {
        return fail(`${cmd.invoke}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!prompt) {
        return fail(`${cmd.invoke}: the command file has no prompt body.`);
      }
      if (cmd.source === 'builtin' && (cmd.name === 'pr' || cmd.name === 'fix-ci') && !session.worktree) {
        session.direct = true;
        this.store.save(session);
      }
      opts = { ...opts, modelRef: cmd.model ?? opts.modelRef, permissionAllow: cmd.allowedTools, display: text.trim() };
      // A command named mid-message is replaced by its prompt where it stands; the rest of the message stays as context.
      text = slash.inline ? spliceSlashToken(text, slash.inline, prompt) : prompt;
    } else if (typeof slash === 'object') {
      // `/skill <name> <task>` and `/agent <name> <task>` become the prompt of this same run; the chat shows what was typed.
      opts = { ...opts, display: text.trim() };
      text = slash.rewrite;
      planTurn = !!slash.planTurn;
    } else if (slash !== undefined) {
      return slash;
    }
    this.stoppedByUser.delete(sessionId);
    const control = new RunControl(sessionId);
    this.runs.set(sessionId, control);
    this.replays.set(sessionId, { base: session.messages.length, startedAt: Date.now(), items: [], bytes: 0, truncated: false });
    if (this.afterTurn.list(sessionId).length) {
      // Messages still waiting behind this turn go into its replay, so a chat surface opened now shows their banner.
      this.broadcastQueue(sessionId);
    }
    this.offers.delete(sessionId);
    control.onDidChange((c) => this.onControlChange(sessionId, c));
    const checkpoint = (this.lastCheckpoint = Math.max(Date.now(), this.lastCheckpoint + 1));
    this.tracker.beginTurn(sessionId, checkpoint);
    this.runStatus.set(sessionId, 'Starting…');
    this.broadcast({ type: 'running', sessionId, running: true });
    this._onDidChangeRuns.fire();
    const endEarly = (): string => {
      this.runs.delete(sessionId);
      this.replays.delete(sessionId);
      this.runStatus.delete(sessionId);
      this.deliverLeftovers(sessionId, control);
      this.broadcast({ type: 'running', sessionId, running: false });
      this._onDidChangeRuns.fire();
      return '';
    };
    if (images?.length) {
      // Routing sends an image turn to a vision model when the chat's own cannot see; refuse only when none can.
      let blind: string | undefined;
      try {
        const { model } = await this.providers.route({ modelRef: opts.modelRef ?? session.model, role: session.mode === 'plan' ? 'reasoning' : 'agent', needsVision: true, signal: control.signal });
        blind = model.supportsVision ? undefined : model.name;
      } catch {
        /* routing errors surface in the run itself */
      }
      if (blind || control.aborted) {
        if (blind && !control.aborted) {
          this.broadcast({ type: 'toast', level: 'error', text: `${blind} cannot read images — pick a vision model, set localpilot.routing.vision (with routing on) or install one (gemma4, qwen2.5vl, llava…)` });
        }
        endEarly();
        this.broadcast({ type: 'sendRejected', sessionId });
        // The message never became part of the chat: give its text back and drop the bubble the view already shows.
        this.broadcast({ type: 'draft', text: opts.display ?? text, images });
        this.broadcast(this.sessionMsg(session));
        return '';
      }
    }
    await this.ensureWorktree(session, (t) => {
      this.runStatus.set(sessionId, t);
      this.broadcast({ type: 'event', event: { sessionId, type: 'status', payload: t } });
      this._onDidChangeRuns.fire();
    }, control.signal);
    if (control.aborted) {
      return endEarly();
    }

    const corrected = opts.display || opts.resume ? { text, fixes: [] } : await this.correctNames(sessionId, text);
    text = corrected.text;
    let content = text;
    const attachedBlocks = await this.readAttachments(attachments, session);
    if (attachedBlocks.some(Boolean)) {
      content = `${attachedBlocks.filter(Boolean).join('\n\n')}\n\n${text}`;
    }
    if (images?.length) {
      content = `${content}\n\n[${images.length} image${images.length === 1 ? '' : 's'} attached]`;
    }
    const meta: ChatMessage['meta'] = { checkpoint, ...(opts.resume ? { hidden: true } : {}), ...(opts.display ? { display: opts.display } : {}), ...(mcpPromptImages ? { mcpPromptImages } : {}), ...(corrected.fixes.length ? { corrections: corrected.fixes } : {}) };
    const userMessage: ChatMessage = { role: 'user', content, images, meta };
    // `/deep-planning`: this turn runs in Plan mode, then the chat returns to the mode it was in.
    const modeBefore = planTurn && session.mode !== 'plan' ? session.mode : undefined;
    if (modeBefore) {
      session.mode = 'plan';
      if (sessionId === this.activeSessionId) {
        this.broadcast(this.sessionMsg(session));
      }
    }

    // A fatal error of this run (not a subagent's): `/deep-planning` then keeps any existing plan file as it is.
    let turnErrored = false;
    this.outcomes.delete(sessionId);
    if (opts.resume) {
      this.broadcast({ type: 'recoveryInterrupted', sessionId, state: null });
    }
    try {
      const result = await this.runner.run({
        session,
        userMessage,
        onUserMessage: (m) => {
          const r = this.replays.get(sessionId);
          if (r) {
            r.anchor = m;
            r.base = session.messages.indexOf(m);
          }
          this.store.save(session);
          if (sessionId === this.activeSessionId) {
            this.broadcast(this.sessionMsg(session));
          }
        },
        modelRef: opts.modelRef,
        mode: planTurn ? undefined : opts.mode,
        permissionAllow: opts.permissionAllow,
        signal: control.signal,
        control,
        workspaceRoot: session.worktree ? path.join(session.worktree.path, session.worktree.subdir ?? '') : undefined,
        isolatedFrom: session.worktree ? path.join(session.worktree.repo, session.worktree.subdir ?? '') : undefined,
        emit: (e) => {
          this.broadcast({ type: 'event', event: e });
          this.notifier.event(e);
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
          if (e.type === 'error' && !(e.payload as { childId?: string } | undefined)?.childId) {
            turnErrored = true;
          }
          if (e.type === 'turn_end' && !(e.payload as { childId?: string } | undefined)?.childId) {
            const p = e.payload as { outcome?: TaskOutcome; interventionId?: string; recovery?: { interventionId?: string; report?: string } } | undefined;
            if (p?.outcome) {
              this.outcomes.set(sessionId, { outcome: p.outcome, interventionId: p.interventionId ?? p.recovery?.interventionId, report: p.recovery?.report });
            }
          }
          if (e.type === 'turn_end' && planTurn && !(e.payload as { childId?: string } | undefined)?.childId) {
            const p = e.payload as { text?: string; completed?: boolean };
            void this.writeImplementationPlan(sessionId, { text: String(p?.text ?? ''), completed: p?.completed, errored: turnErrored, aborted: control.aborted });
          }
        },
        requestApproval: (title, detail, kind, opts) => this.requestApproval(sessionId, title, detail, kind, opts),
        willPrompt: (kind, mandatory) => this.willPromptApproval(sessionId, kind, mandatory),
        // Unattended runs (task queue) have nobody to answer: ask_user falls back to the agent's recommendations.
        askUser: opts.unattended ? async () => null : (questions) => this.requestQuestions(sessionId, questions),
        unattended: opts.unattended,
        resume: opts.resume || undefined,
        taskId: opts.taskId,
      });
      return result;
    } catch (e) {
      turnErrored = true;
      // The agent loop already surfaced model failures with a friendlier message; don't show them twice.
      if (!(e as { reported?: boolean }).reported) {
        const msg = e instanceof Error ? e.message : String(e);
        this.broadcast({ type: 'event', event: { sessionId, type: 'error', payload: msg } });
      }
      return '';
    } finally {
      if (modeBefore && session.mode === 'plan') {
        session.mode = modeBefore;
        if (sessionId === this.activeSessionId) {
          this.broadcast(this.sessionMsg(session));
        }
      }
      if (this.runs.get(sessionId) === control) {
        this.runs.delete(sessionId);
        this.replays.delete(sessionId);
        this.runStatus.delete(sessionId);
      }
      this.deliverLeftovers(sessionId, control);
      const removed = this.runs.has(sessionId) ? undefined : this.removedWhileRunning.get(sessionId);
      if (removed) {
        this.removedWhileRunning.delete(sessionId);
        if (removed.has(session.model)) {
          session.model = '';
        }
      }
      this.store.save(session);
      this.broadcast({ type: 'running', sessionId, running: false });
      if (removed && !session.model && sessionId === this.activeSessionId) {
        this.broadcast(this.sessionMsg(session));
      }
      this._onDidChangeRuns.fire();
      // Also refreshes View changes under the answer (the turn may have changed files through commands only).
      this.pushChanges(sessionId);
      // Last agent of a batch done: offer the review (compare and pick for Best of N, review each for split tasks).
      if (session.group && session.group.size > 1 && !this.groupSessions(session.group.id).some((s) => this.runs.has(s.id))) {
        this.notifier.groupFinished(session.group, session.group.size);
      }
      // A run the user stopped needs no notice; group runs get the review offer above instead.
      const silent = control.aborted || (!!session.group && session.group.size > 1);
      const healed = this.outcomes.get(sessionId);
      const attention = healed?.outcome === 'incomplete' || healed?.outcome === 'blocked';
      this.notifier.finished(sessionId, session.title, silent, turnErrored ? 'error' : attention ? 'attention' : 'ok', this.tracker.forSession(sessionId).length, attention ? healed?.report : undefined);
    }
  }

  /** Replays the last user turn after a failure: drops the failed exchange and sends the same message again. */
  async retry(sessionId: string): Promise<string> {
    const session = this.store.get(sessionId);
    if (!session || this.runs.has(sessionId)) {
      return '';
    }
    if (this.compacting.has(sessionId)) {
      this.broadcast({ type: 'toast', level: 'info', text: 'Wait for the compaction to finish' });
      return '';
    }
    let idx = session.messages.length - 1;
    while (idx >= 0 && !(session.messages[idx].role === 'user' && !session.messages[idx].meta?.hidden && !session.messages[idx].meta?.toolImages && !session.messages[idx].meta?.toolResults && !session.messages[idx].meta?.summary && !session.messages[idx].meta?.steer)) {
      idx--;
    }
    if (idx < 0) {
      return '';
    }
    const last = session.messages[idx];
    const removed = session.messages.slice(idx);
    session.messages = session.messages.slice(0, idx);
    this.store.save(session);
    this.broadcast(this.sessionMsg(session));
    // Attachments are already inlined in the stored content, so send it verbatim with no new attachments; `display`
    // keeps the chat showing the original prompt and skips slash commands and name correction, which already ran.
    // A /skill, /agent or custom-command turn is expanded again so it keeps the command's model and allowed tools.
    const content = last.content.replace(/\n\n\[\d+ images? attached\]$/, '');
    const result = last.meta?.display?.startsWith('/')
      ? await this.send(sessionId, last.meta.display, [], last.meta.display.startsWith('/mcp:') ? withoutMcpPromptImages(last.images, last) : last.images)
      : await this.send(sessionId, content, [], last.images, { display: last.meta?.display ?? userText(content) });
    if (session.messages[idx]?.role !== 'user') {
      // The run never started (cancelled, refused): put the exchange back instead of losing it.
      session.messages.splice(idx, 0, ...removed);
      this.store.save(session);
      this.broadcast(this.sessionMsg(session));
    }
    return result;
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

  /**
   * Runs one task-queue entry as its own chat and resolves when the agent finishes. `isolated` puts it in a
   * worktree (under `worktrees.mode: parallel`) so tasks running side by side do not edit the same checkout.
   * A task requeued with `resume` continues in its own chat with the resume turn when that chat still exists.
   */
  async runQueuedTask(
    task: { id?: string; prompt: string; mode: Session['mode']; model?: string; sessionId?: string; resume?: boolean },
    started: (sessionId: string) => void,
    isolated: boolean
  ): Promise<{ ok: boolean; error?: string; cancelled?: boolean; outcome?: TaskOutcome; interventionId?: string; shutdown?: boolean }> {
    const existing = task.resume && task.sessionId ? this.store.get(task.sessionId) : undefined;
    let s: Session;
    if (existing) {
      s = existing;
    } else {
      s = this.createSession(task.mode);
      s.title = task.prompt.slice(0, 60);
      s.isolated = isolated;
      if (task.model) {
        s.model = task.model;
      }
      this.store.save(s);
    }
    started(s.id);
    let error: string | undefined;
    let ended = false;
    let answer = '';
    const off = this.onAgentEvent((e) => {
      if (e.sessionId !== s.id || (e.payload && typeof e.payload === 'object' && 'childId' in e.payload)) {
        return;
      }
      if (e.type === 'turn_end') {
        ended = true;
        answer = String((e.payload as { text?: unknown } | undefined)?.text ?? '');
      } else if (e.type === 'error') {
        error = (e.payload && typeof e.payload === 'object' ? String((e.payload as { message?: string }).message ?? '') : String(e.payload ?? '')).slice(0, 300);
      }
    });
    try {
      // Already running (the user clicked Resume as the queue requeued it): follow that run instead of steering into it.
      const text = existing && this.busy(s.id)
        ? (await this.settled(s.id), answer)
        : existing
        ? await this.send(s.id, RESUME_PROMPT, [], undefined, { modelRef: task.model, unattended: true, resume: true, taskId: task.id })
        : await this.send(s.id, task.prompt, [], undefined, { modelRef: task.model, unattended: true, taskId: task.id });
      if (this.shuttingDown) {
        return { ok: false, shutdown: true };
      }
      if (this.stoppedByUser.delete(s.id)) {
        return { ok: false, cancelled: true, outcome: 'cancelled', error: 'Stopped by the user.' };
      }
      const reported = this.outcomes.get(s.id);
      // No outcome on the turn_end: self-healing is off (the old "has an answer and no error" rule) or the final model
      // failure threw before any turn_end was emitted (failed).
      const outcome: TaskOutcome = reported?.outcome ?? (ended && text.trim() && !error ? 'completed' : 'failed');
      const ok = outcome === 'completed' || outcome === 'completed_unverified';
      return {
        ok,
        outcome,
        interventionId: reported?.interventionId,
        error: ok ? undefined : error ?? reported?.report?.slice(0, 300) ?? 'The agent stopped without an answer.',
      };
    } finally {
      off.dispose();
    }
  }

  private busy(sessionId: string): boolean {
    return this.runs.has(sessionId) || this.starting.has(sessionId);
  }

  /** Resolves once the chat has no run in flight (`starting` ends without an event, so it is also polled). */
  private settled(sessionId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!this.busy(sessionId)) {
          sub.dispose();
          clearInterval(timer);
          resolve();
        }
      };
      const sub = this.onDidChangeRuns(check);
      const timer = setInterval(check, 250);
      check();
    });
  }

  /** Self-healing outcome of the chat's last turn (undefined when it reported none). */
  lastOutcome(sessionId: string): TaskOutcome | undefined {
    return this.outcomes.get(sessionId)?.outcome ?? this.store.peek(sessionId)?.recovery?.outcome;
  }

  /** Continues an interrupted recovery: the hidden steer turn, run with `resume` so the engine reruns the checks first. */
  async resumeRecovery(sessionId: string): Promise<string> {
    if (!this.store.get(sessionId)) {
      this.broadcast({ type: 'toast', level: 'warn', text: 'This chat no longer exists — its recovery cannot be resumed' });
      return '';
    }
    if (this.busy(sessionId)) {
      this.broadcast({ type: 'toast', level: 'info', text: 'This chat is still running — stop it before resuming the recovery' });
      return '';
    }
    return this.send(sessionId, RESUME_PROMPT, [], undefined, { resume: true });
  }

  /**
   * Posts the Recovery interrupted card for the chat on screen again. The extension host calls it once
   * `healing.scanUnfinished()` has resolved: the restored chat's webview is usually ready before the index is filled.
   */
  refreshInterrupted(): void {
    if (this.activeSessionId) {
      this.postInterrupted(this.activeSessionId);
    }
  }

  /** The interrupted index entry of an idle chat (undefined while it runs or when it has none). */
  private interruptedInfo(sessionId: string): ResumeInfo | undefined {
    if (!this.healing || this.busy(sessionId)) {
      return undefined;
    }
    try {
      const info = this.healing.resumeInfo(sessionId);
      return info?.phase === 'interrupted' ? info : undefined;
    } catch (e) {
      this.log.warn(`Self-healing: could not read the recovery state of ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  /**
   * Shows the Recovery interrupted card for a chat whose recovery was cut off by a closed window (idle chats only):
   * the index entry right away, then the persisted failures, attempts and root cause once they are read.
   */
  private postInterrupted(sessionId: string, post: (m: ToWebview) => void = (m) => this.broadcast(m)): void {
    const info = this.interruptedInfo(sessionId);
    const healing = this.healing;
    if (!info || !healing) {
      return;
    }
    post({ type: 'recoveryInterrupted', sessionId, state: { ...info, sessionId, recoveryId: sessionId } });
    void (async () => {
      let state: RecoveryState | undefined;
      try {
        state = await recoveryStateOf(healing, sessionId);
      } catch (e) {
        this.log.warn(`Self-healing: could not load the recovery state of ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      // Resumed, dismissed or rolled back meanwhile: the card is gone and stays gone.
      const now = this.interruptedInfo(sessionId);
      if (!state || !now) {
        return;
      }
      const lastPhase = phaseBeforeInterrupt(state);
      post({
        type: 'recoveryInterrupted',
        sessionId,
        state: {
          ...now,
          sessionId,
          recoveryId: sessionId,
          ...(lastPhase ? { lastPhase } : {}),
          active: state.active,
          attempts: state.attempts.map((a) => ({ n: a.n, category: a.category, ...(a.rootCause ? { rootCause: a.rootCause } : {}), ...(a.result ? { result: a.result } : {}) })),
          ...(state.intervention ? { intervention: state.intervention } : {}),
        },
      });
    })();
  }

  /** A button on a recovery card (live or interrupted). */
  private async recoveryAction(msg: Extract<FromWebview, { type: 'recoveryAction' }>): Promise<void> {
    const sid = msg.sessionId;
    const healing = this.healing;
    const fail = (what: string, e: unknown) => {
      const text = `${what}: ${e instanceof Error ? e.message : String(e)}`;
      this.log.warn(`Self-healing: ${text}`);
      this.broadcast({ type: 'toast', level: 'error', text });
    };
    switch (msg.action) {
      case 'resume':
      case 'approveInstall':
        // An install is approved through the normal (mandatory) approval prompt the resumed engine raises again.
        await this.resumeRecovery(sid);
        return;
      case 'retryWithGuidance': {
        const text = msg.text?.trim();
        if (text) {
          await this.send(sid, text);
        }
        return;
      }
      case 'openMergeEditor':
        return this.openMergeEditor(sid, msg.file ?? msg.text);
      default:
        break;
    }
    if (!healing) {
      this.broadcast({ type: 'toast', level: 'warn', text: 'Self-healing is not available in this window' });
      return;
    }
    // Restoring files or closing the recovery under a live engine would pull the ground from under its fix or validation.
    if ((msg.action === 'rollback' || msg.action === 'dismiss') && this.busy(sid)) {
      this.broadcast({ type: 'toast', level: 'info', text: `This chat is still running — stop it before ${msg.action === 'rollback' ? 'rolling back' : 'dismissing the recovery'}` });
      return;
    }
    switch (msg.action) {
      case 'rollback': {
        this.runStatus.set(sid, 'Rolling back fixes…');
        this.broadcast({ type: 'event', event: { sessionId: sid, type: 'status', payload: 'Rolling back fixes…' } });
        try {
          const r = await healing.rollback(sid, msg.attempt, this.sessionRoot(sid));
          const skipped = r.skipped.length ? ` · kept ${r.skipped.length} (${[...new Set(r.skipped.map((x) => x.reason.replace(/_/g, ' ')))].join(', ')})` : '';
          this.broadcast({ type: 'toast', level: r.skipped.length ? 'warn' : 'info', text: r.restored.length || r.skipped.length ? `Rolled back ${r.restored.length} file${r.restored.length === 1 ? '' : 's'}${skipped}` : 'No fix attempts to roll back' });
          this.broadcast({ type: 'recoveryInterrupted', sessionId: sid, state: null });
        } catch (e) {
          fail('Rollback failed', e);
        } finally {
          if (!this.runs.has(sid)) {
            this.runStatus.delete(sid);
          }
          this._onDidChangeRuns.fire();
          this.pushChanges(sid);
        }
        return;
      }
      case 'acceptRisk': {
        const pick = await vscode.window.showWarningMessage(
          'Accept the security risk and keep the finding in the code?',
          { modal: true, detail: 'LocalPilot stops treating this security finding as a failure for this task. The decision is recorded in the recovery state and the audit log.' },
          'Accept risk'
        );
        if (pick !== 'Accept risk') {
          return;
        }
        try {
          const risk = await healing.acceptRisk(sid, 'user');
          this.broadcast({ type: 'toast', level: risk ? 'info' : 'warn', text: risk ? `Accepted the risk of ${risk.signatures.length} security finding${risk.signatures.length === 1 ? '' : 's'}` : 'No open security finding to accept' });
        } catch (e) {
          fail('Could not record the accepted risk', e);
        }
        return;
      }
      case 'dismiss':
        try {
          await healing.dismiss(sid);
        } catch (e) {
          fail('Could not dismiss the recovery', e);
        }
        this.broadcast({ type: 'recoveryInterrupted', sessionId: sid, state: null });
        return;
      default:
        this.log.warn(`Self-healing: unknown recovery action ${String((msg as { action?: unknown }).action)}`);
    }
  }

  /** Opens a conflicted file in VS Code's merge editor, or as a plain editor when the git extension cannot. */
  private async openMergeEditor(sessionId: string, file: string | undefined): Promise<void> {
    const root = this.sessionRoot(sessionId);
    let rel = file?.trim();
    if (!rel && root) {
      try {
        rel = (await runProcess('git', ['diff', '--name-only', '--diff-filter=U'], root, undefined, 10_000)).split(/\r?\n/).find(Boolean);
      } catch {
        /* not a git checkout: nothing to open */
      }
    }
    if (!rel) {
      this.broadcast({ type: 'toast', level: 'warn', text: 'No conflicted file to open' });
      return;
    }
    const uri = vscode.Uri.file(path.isAbsolute(rel) || !root ? rel : path.join(root, rel));
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch (e) {
      this.log.debug(`merge editor unavailable (${e instanceof Error ? e.message : String(e)}); opening ${uri.fsPath}`);
      try {
        await vscode.window.showTextDocument(uri, { preview: false });
      } catch (e2) {
        this.broadcast({ type: 'toast', level: 'error', text: `Could not open ${rel}: ${e2 instanceof Error ? e2.message : String(e2)}` });
      }
    }
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
    const keepPinned = opts.keepPinned !== false;
    // A chat whose run starts while the clear is in progress is spared: the busy check is made just before each delete.
    const busy = (id: string) => this.runs.has(id) || this.starting.has(id) || this.compacting.has(id);
    const all = this.store.list();
    const pinned = new Set(keepPinned ? all.filter((s) => s.pinned).map((s) => s.id) : []);
    const idle = all.filter((s) => !busy(s.id) && !pinned.has(s.id)).map((s) => ({ id: s.id, root: this.sessionRoot(s.id), hadMessages: !!s.messageCount }));
    const n = await this.store.clearExcept((id) => busy(id) || pinned.has(id));
    const remaining = new Set(this.store.list().map((s) => s.id));
    for (const s of idle) {
      if (remaining.has(s.id)) {
        continue;
      }
      this.tracker.forget(s.id);
      if (this.sessionApprovalMemory.delete(s.id)) {
        this.broadcastGrants(s.id);
      }
      this.afterTurn.clear(s.id);
      if (s.hadMessages) {
        await this.runner.hooks?.sessionEnd(s.id, 'other', s.root);
      }
    }
    const kept = remaining.size;
    const current = this.activeSessionId ? this.store.get(this.activeSessionId) : undefined;
    if (!current) {
      const next = this.store.list()[0];
      this.setActive(next ? this.store.get(next.id)! : this.createSession('agent'));
    }
    this.broadcast({ type: 'historyCleared', removed: n });
    this.broadcast({ type: 'toast', level: 'info', text: n ? `Cleared ${n} chat${n === 1 ? '' : 's'}${kept ? ` · kept ${kept} running/pinned` : ''}` : 'Nothing to clear' });
    return n;
  }

  stop(sessionId: string): void {
    if (this.runs.has(sessionId)) {
      this.stoppedByUser.add(sessionId);
    }
    this.runs.get(sessionId)?.stop();
    for (const [id, pending] of this.approvals) {
      if (pending.sessionId === sessionId) {
        this.settleApproval(id, false);
      }
    }
    for (const [id, pending] of this.questions) {
      if (pending.sessionId === sessionId) {
        this.settleQuestion(id, null);
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

  /** Reads the attachments of a message; any that could not be read are reported in one toast instead of being dropped silently. */
  private async readAttachments(attachments: string[], session?: Session): Promise<string[]> {
    if (attachments.length > MAX_ATTACHMENTS) {
      this.broadcast({ type: 'toast', level: 'warn', text: `Only the first ${MAX_ATTACHMENTS} of ${attachments.length} attachments were read` });
      attachments = attachments.slice(0, MAX_ATTACHMENTS);
    }
    const root = session?.worktree ? path.join(session.worktree.path, session.worktree.subdir ?? '') : undefined;
    const blocks = await Promise.all(attachments.map((a) => this.workspace.readAttachment(a, root)));
    if (!root) {
      this.mentionIndex.noteAttached(attachments);
    }
    const failed = attachments.filter((_, i) => !blocks[i] || /^<attachment [^>]*error="not found"/.test(blocks[i]));
    if (failed.length) {
      this.broadcast({ type: 'toast', level: 'warn', text: `Could not attach ${failed.join(', ')}` });
    }
    // Binaries, unreadable documents and oversized PDFs are attached as a note; say so in the chat too.
    const notes = blocks.map((b) => /^<(?:attachment|url_content) [^>]*(?:kind="(?:binary|image)"|error="(?!not found)[^"]*")[^>]*>\n([^\n]*)/.exec(b ?? '')?.[1]).filter((n): n is string => !!n);
    if (notes.length) {
      this.broadcast({ type: 'toast', level: 'info', text: notes.join(' ') });
    }
    return blocks;
  }

  /** Queue a user message for a running (or paused) agent; it is appended at the next step boundary. */
  async steer(sessionId: string, text: string, attachments: string[] = [], images?: string[]): Promise<boolean> {
    const c = this.runs.get(sessionId);
    if (!text.trim()) {
      return false;
    }
    const original = text;
    // The run ended (or never started) before the message could be queued: send it as a new turn instead of dropping it.
    const fallback = async () => {
      // A stopped run lingers in `runs` until its cleanup finishes; steering into it again would loop.
      for (let i = 0; i < 100 && c && this.runs.get(sessionId) === c; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (c && this.runs.get(sessionId) === c) {
        return false;
      }
      await this.send(sessionId, original, attachments, images);
      return true;
    };
    if (!c) {
      return fallback();
    }
    // A steer is shown in its own row, so its corrections go there rather than onto the turn's request bubble.
    const corrected = await this.correctNames(sessionId, text, false);
    text = corrected.text;
    const fixes = corrected.fixes;
    let content = text;
    const attachedBlocks = await this.readAttachments(attachments, this.store.get(sessionId));
    if (attachedBlocks.some(Boolean)) {
      content = `${attachedBlocks.filter(Boolean).join('\n\n')}\n\n${text}`;
    }
    if (this.runs.get(sessionId) !== c || c.aborted) {
      return fallback();
    }
    const id = `steer_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.steerDrafts.set(id, { text: original, attachments, images });
    if (!c.steer({ role: 'user', content, images, meta: { steerId: id, ...(fixes.length ? { corrections: fixes } : {}) } })) {
      this.steerDrafts.delete(id);
      return fallback();
    }
    this.broadcast({ type: 'steerQueued', sessionId, id, content: text, images, ...(fixes.length ? { fixes } : {}) });
    this.broadcastQueue(sessionId);
    this.runStatus.set(sessionId, c.holding ? 'Paused · 1 message waiting' : 'Will take your message into account at the next step');
    this._onDidChangeRuns.fire();
    return true;
  }

  /** Messages queued for a run that ended before taking them: a follow-up turn, or back to the composer when it was stopped. */
  private deliverLeftovers(sessionId: string, control: RunControl): void {
    const left = control.close();
    for (const m of left) {
      this.steerDrafts.delete(m.meta?.steerId ?? '');
    }
    if (!left.length) {
      this.broadcastQueue(sessionId);
      return;
    }
    const joined = left.map((m) => m.content).join('\n\n');
    const images = left.flatMap((m) => m.images ?? []);
    if (!control.aborted) {
      // Ahead of any "send after this turn" message; `send` starts it once this run has fully let go of the chat.
      this.afterTurn.add(sessionId, { text: joined, attachments: [], images: images.length ? images : undefined }, true);
      this.broadcastQueue(sessionId);
      return;
    }
    this.broadcastQueue(sessionId);
    this.broadcast({ type: 'draft', text: joined });
    this.broadcast({ type: 'toast', level: 'warn', text: 'Your queued message was not delivered — it is back in the composer.' });
  }

  /** "Send after this turn": waits in the chat's queue while it is busy, otherwise it is an ordinary send. */
  private async queueAfterTurn(sessionId: string, text: string, attachments: string[], images?: string[]): Promise<void> {
    if (!text.trim() && !images?.length) {
      return;
    }
    // Idle (or only compacting, which `send` already waits for): nothing to wait behind.
    if (!this.runs.has(sessionId) && !this.starting.has(sessionId)) {
      await this.send(sessionId, text, attachments, images);
      return;
    }
    this.afterTurn.add(sessionId, { text, attachments, images });
    this.broadcastQueue(sessionId);
  }

  /** Cancels a queued message: an after-turn one, or a steer the loop has not injected yet (it never reaches the model). */
  private cancelQueued(sessionId: string, id: string, edit: boolean): void {
    let draft: { text: string; attachments: string[]; images?: string[] } | undefined = this.afterTurn.remove(sessionId, id);
    let removed: string[] | undefined;
    if (!draft) {
      const m = this.runs.get(sessionId)?.removeSteer(id);
      if (m) {
        draft = this.steerDrafts.get(id) ?? { text: m.content, attachments: [], images: m.images };
        this.steerDrafts.delete(id);
        this.forgetSteers(sessionId, [id]);
        removed = [id];
      }
    }
    if (!draft) {
      this.broadcast({ type: 'toast', level: 'info', text: 'That message was already delivered.' });
      this.broadcastQueue(sessionId);
      return;
    }
    this.broadcastQueue(sessionId, removed);
    if (edit) {
      // Merged into whatever the user is composing rather than replacing it.
      this.broadcast({ type: 'draft', text: draft.text, images: draft.images, attachments: draft.attachments, merge: true });
    }
  }

  private broadcastQueue(sessionId: string, removed?: string[]): void {
    const steers: QueueRow[] = (this.runs.get(sessionId)?.pendingSteers() ?? [])
      .filter((m) => m.meta?.steerId)
      .map((m) => ({ id: m.meta!.steerId!, kind: 'steer', text: this.steerDrafts.get(m.meta!.steerId!)?.text ?? m.content }));
    const items: QueueRow[] = [...steers, ...this.afterTurn.list(sessionId).map((q): QueueRow => ({ id: q.id, kind: 'after', text: q.text || '(image)' }))];
    this.broadcast({ type: 'queue', sessionId, items, label: queueLabel(items), ...(removed?.length ? { removed } : {}) });
  }

  /** The chat is idle again: the oldest after-turn message starts the next turn (and leaves the queue, so it runs once). */
  private drainQueue(sessionId: string): void {
    if (this.runs.has(sessionId) || this.starting.has(sessionId)) {
      return;
    }
    if (!this.store.get(sessionId)) {
      this.afterTurn.clear(sessionId);
      return;
    }
    const next = this.afterTurn.shift(sessionId);
    if (!next) {
      return;
    }
    this.broadcastQueue(sessionId);
    void this.send(sessionId, next.text, next.attachments, next.images).catch(() => undefined);
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

  private approvalMandatory(kind: string, mandatory?: boolean): boolean {
    return !!this.mandatoryReason(kind, mandatory);
  }

  /**
   * Why a prompt is asked every time, if it is. An organization floor for this kind (or a policy that forbids bypassing
   * prompts) is never answered from session memory; a caller's `mandatory` is a destructive command or an
   * organization `ask` rule, told apart by whether the policy has any ask rules for non-terminal actions.
   */
  private mandatoryReason(kind: string, mandatory?: boolean): 'dangerous' | 'policy' | undefined {
    const managed = getManagedPolicy(this.log);
    if (managed.approvals[kind as keyof typeof managed.approvals] || managed.disableBypassPermissions) {
      return 'policy';
    }
    if (!mandatory) {
      return undefined;
    }
    return kind !== 'terminal' && managed.permissions.ask.length ? 'policy' : 'dangerous';
  }

  /** False when `requestApproval` would answer from "Allow for session" without showing anything. */
  willPromptApproval(sessionId: string, kind: string, mandatory?: boolean): boolean {
    return this.approvalMandatory(kind, mandatory) || !this.sessionApprovalMemory.get(sessionId)?.has(kind);
  }

  requestApproval(sessionId: string, title: string, detail: string, kind: string, opts?: { mandatory?: boolean }): Promise<ApprovalDecision> {
    const mandatoryReason = this.mandatoryReason(kind, opts?.mandatory);
    const mandatory = !!mandatoryReason;
    if (!this.willPromptApproval(sessionId, kind, mandatory)) {
      return Promise.resolve({ ok: true });
    }
    this.notifier.asked(sessionId);
    const id = `${sessionId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(id, { sessionId, title, detail, kind, mandatory, mandatoryReason, resolve, mirrored: false });
      if (this.promptsNative(sessionId)) {
        // The @localpilot participant runs this session, or no surface can show the card — fall back to a native dialog.
        void vscode.window.showWarningMessage(`${title}\n${detail}`.slice(0, 1000), { modal: true }, ...(mandatory ? ['Allow'] : ['Allow', 'Allow for session'])).then((choice) => {
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
      const waitingSameKind = mandatory ? 0 : [...this.approvals].filter(([other, p]) => other !== id && p.sessionId === sessionId && p.kind === kind && !p.mandatory).length;
      this.broadcast({ type: 'approval', id, sessionId, title, detail, kind, mandatory, mandatoryReason, waitingSameKind });
      this.markWaiting(sessionId, `Waiting for your approval: ${title}`);
      this.mirrorPendingApprovals();
    });
  }

  /** Answers a pending approval once, whichever surface answered it, and takes the prompt down everywhere. */
  private settleApproval(id: string, ok: boolean, feedback?: string): void {
    const pending = this.approvals.get(id);
    if (!pending) {
      return;
    }
    this.approvals.delete(id);
    this.forgetApproval(id);
    pending.resolve(toDecision({ ok, feedback }));
    this.broadcast({ type: 'approvalResolved', id });
    this.clearWaiting(pending.sessionId);
  }

  /** Whether the session waits on an approval or a question shown in the chat. */
  hasPendingPrompt(sessionId: string): boolean {
    return [...this.approvals.values(), ...this.questions.values()].some((p) => p.sessionId === sessionId);
  }

  /** Number of sessions waiting on the user. */
  pendingCount(): number {
    return new Set([...this.approvals.values(), ...this.questions.values()].map((p) => p.sessionId)).size;
  }

  private markWaiting(sessionId: string, status: string): void {
    if (!this.statusBeforePrompt.has(sessionId)) {
      this.statusBeforePrompt.set(sessionId, this.runStatus.get(sessionId));
    }
    this.runStatus.set(sessionId, status);
    this._onDidChangeRuns.fire();
  }

  private clearWaiting(sessionId: string): void {
    const next = [...this.approvals.values()].find((p) => p.sessionId === sessionId);
    if (next || [...this.questions.values()].some((p) => p.sessionId === sessionId)) {
      this.runStatus.set(sessionId, next ? `Waiting for your approval: ${next.title}` : 'Waiting for your answer');
    } else if (this.statusBeforePrompt.has(sessionId)) {
      const before = this.statusBeforePrompt.get(sessionId);
      this.statusBeforePrompt.delete(sessionId);
      // A run that ended meanwhile already cleared its status.
      if (this.runs.has(sessionId) && before !== undefined) {
        this.runStatus.set(sessionId, before);
      } else {
        this.runStatus.delete(sessionId);
      }
    }
    this._onDidChangeRuns.fire();
  }

  /**
   * Shows the agent's questions as a card in the chat and waits for the answers (`null` = skipped). Resolves
   * undefined at once when no chat surface can show the card (or the @localpilot participant runs this session), so
   * ask_user falls back to native pickers.
   */
  requestQuestions(sessionId: string, questions: UserQuestion[]): Promise<UserAnswer[] | null | undefined> {
    if (this.promptsNative(sessionId)) {
      return Promise.resolve(undefined);
    }
    const id = `${sessionId}:q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      this.questions.set(id, { sessionId, questions, resolve, mirrored: false });
      this.broadcast({ type: 'question', id, sessionId, questions });
      this.markWaiting(sessionId, 'Waiting for your answer');
      this.mirrorPendingApprovals();
    });
  }

  private settleQuestion(id: string, answers: UserAnswer[] | null): void {
    const pending = this.questions.get(id);
    if (!pending) {
      return;
    }
    this.questions.delete(id);
    this.forgetApproval(id);
    pending.resolve(answers);
    this.broadcast({ type: 'questionResolved', id });
    this.clearWaiting(pending.sessionId);
  }

  /**
   * Every prompt the user cannot see (no chat surface visible, or the chat shows another session, as for a background
   * agent of a parallel batch) gets a native notification, once, so an agent never stalls unnoticed. Chosen in the
   * notification, the answer also closes the prompt in the webview; dismissed, the prompt simply stays in the chat.
   */
  private mirrorPendingApprovals(): void {
    if (!this.approvals.size && !this.questions.size) {
      return;
    }
    const visible = this.anySurfaceVisible();
    const unseen = (sessionId: string): boolean => !visible || sessionId !== this.activeSessionId;
    for (const pending of this.questions.values()) {
      if (pending.mirrored || !unseen(pending.sessionId)) {
        continue;
      }
      pending.mirrored = true;
      const session = this.store.get(pending.sessionId);
      const n = pending.questions.length;
      void vscode.window
        .showInformationMessage(`LocalPilot${session ? ` · ${session.title}` : ''} has ${n === 1 ? 'a question' : `${n} questions`} for you`, 'Show chat')
        .then((choice) => choice && vscode.commands.executeCommand('localpilot.openSession', pending.sessionId));
    }
    for (const [id, pending] of this.approvals) {
      if (pending.mirrored || !unseen(pending.sessionId)) {
        continue;
      }
      pending.mirrored = true;
      const session = this.store.get(pending.sessionId);
      void vscode.window
        .showWarningMessage(`LocalPilot${session ? ` · ${session.title}` : ''}: ${pending.title}`, ...(pending.mandatory ? ['Allow', 'Deny', 'Show chat'] : ['Allow', 'Allow for session', 'Deny', 'Show chat']))
        .then((choice) => {
          if (!this.approvals.has(id)) {
            return; // already answered in the webview
          }
          if (choice === 'Show chat') {
            void vscode.commands.executeCommand('localpilot.openSession', pending.sessionId);
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
    const added = !set.has(kind);
    set.add(kind);
    this.sessionApprovalMemory.set(sessionId, set);
    if (added) {
      this.broadcastGrants(sessionId);
    }
  }

  private broadcastGrants(sessionId: string): void {
    this.broadcast({ type: 'sessionGrants', sessionId, kinds: [...(this.sessionApprovalMemory.get(sessionId) ?? [])] });
  }

  /** Slash commands handled locally (no model call). Returns undefined when the text is a normal prompt. */
  /** Returns the reply to a command handled here, `{ rewrite }` for a command that runs as a rewritten prompt, `{ command }` for a custom command to expand, or undefined for a normal prompt. */
  private handleSlash(session: Session, text: string): string | { rewrite: string; planTurn?: boolean } | { command: CustomCommand; args: string; inline?: SlashToken } | undefined {
    const m = /^\/([\w.:@-]+)\s*(.*)$/s.exec(text.trim());
    if (!m) {
      return undefined;
    }
    const [, typed, rest] = m;
    // Names match in any case, with or without `.md` (`/Review.md` runs `/review`).
    const cmd = normalizeCommandName(typed);
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
            '- `/mode agent|multitask|debug|plan|ask` — switch mode',
            '- `/compact` (or `/smol`) — summarise older messages to free context · `/newtask [note]` — continue in a new chat that starts from a summary of this one',
            '- `/deep-planning <task>` — investigate, ask, then write an implementation plan (Plan mode for that turn) · `/team <task>` — split the task for background workers and the shared board (Multitask mode) · `/newrule [topic]` (or `/init`) — write a project rule file',
            '- `/clear` — clear this session',
            '- `/skills` — list skills · `/agents` — list subagents · `/commands` — list custom commands',
            '- `/skill <name> <task>` — run a task with a skill preloaded · `/skill install <owner/repo|url|folder>` — install a skill · `/skill browse [words]` — search the skill registry',
            '- `/skill mode auto|ask|off` — how this chat uses skills · `/skill pin <name>` / `unpin` — load a skill into every request of this chat',
            '- `/agent <name> <task>` — delegate directly to a subagent',
            '- `/memory` — instruction files in force (CLAUDE.md, AGENTS.md…) and saved memory notes · `/permissions` — permission rules · `/hooks` — configured hooks',
            '- `/context` — show context usage · `/board` — the shared task board (`.localpilot/board`)',
            ...(custom.length ? ['', '**Custom commands** (`.claude/commands`, `.localpilot/commands`, Cline workflows, plugins)', ...custom.map((c) => `- \`${c.invoke}${c.argumentHint ? ` ${c.argumentHint}` : ''}\` — ${c.description || c.file}`)] : []),
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
        // Both kinds of standing context: the instruction files you write, and the notes the agent saved itself.
        void Promise.all([this.workspace.instructionFiles(), this.runner.memory?.list().catch(() => []) ?? []]).then(([files, notes]) => say(memoryReport(files, notes, getConfig().memoryEnabled)));
        return '';
      }
      case 'permissions': {
        const p = this.runner.projectSettings?.();
        if (!p) {
          return say('Permission rules are not available.');
        }
        const fmt = (list: string[]) => (list.length ? list.map((r) => `\`${r}\``).join(', ') : '_none_');
        const org = getManagedPolicy(this.log);
        const orgLines = describePolicy(org);
        return say([
          ...(orgLines.length ? [`**Organization policy** (from \`${org.source}\`; cannot be changed here)${org.message ? ` — ${org.message}` : ''}`, ...orgLines.map((l) => `- ${l}`), ''] : []),`**Permission rules** (from ${p.sources.length ? p.sources.map((s) => `\`${vscode.workspace.asRelativePath(s)}\``).join(', ') : 'no settings file'})`, `- deny: ${fmt(p.permissions.deny)}`, `- ask: ${fmt(p.permissions.ask)}`, `- allow: ${fmt(p.permissions.allow)}`, p.permissions.defaultMode ? `- defaultMode: \`${p.permissions.defaultMode}\`` : '', '', 'Edit `.localpilot/settings.json` or `.claude/settings.json`: `{ "permissions": { "allow": ["Bash(npm run test:*)"], "deny": ["Read(.env)"] } }`.'].filter((l) => l !== '').join('\n'));
      }
      case 'board': {
        // The board is shared: always the real checkout's, also for a chat working in an isolated worktree.
        const root = this.workspace.root;
        if (!root) {
          return say('Open a folder to use the shared board.');
        }
        void new TeamBoard(root).list().then((all) => say(`**Shared board** (\`.localpilot/board\`)\n\n${all.length ? formatBoard(all).split('\n').map((l) => `- ${l}`).join('\n') : formatBoard(all)}\n\nAsk the agent to put work on the board, or run \`localpilot work\` (one or more terminals, **LocalPilot: Work on Shared Board**) to take tasks from it.`));
        return '';
      }
      case 'hooks': {
        const p = this.runner.projectSettings?.();
        const entries = Object.entries(p?.hooks ?? {});
        const off = getConfig().hooksEnabled ? '' : 'Hooks are disabled (localpilot.hooks.enabled = false).\n\n';
        return say(off + (entries.length ? `**Hooks**\n${entries.map(([ev, ms]) => `- **${ev}**: ${ms.map((mm) => `${mm.matcher ? `\`${mm.matcher}\` → ` : ''}${mm.hooks.map((h) => `\`${h.command.length > 60 ? `${h.command.slice(0, 60)}…` : h.command}\``).join(', ')}`).join('; ')}`).join('\n')}` : 'No hooks configured. Add to `.localpilot/settings.json` or `.claude/settings.json`: `{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/check.sh" }] }] } }`. Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, SessionStart, PreCompact, Notification.'));
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
        return say(contextReport(session, win, win ? effectiveContextWindow(win, getConfig().contextWindow) : undefined));
      }
      case 'clear':
        void this.handle({ type: 'clearSession', sessionId: session.id });
        return '';
      case 'compact':
      case 'smol':
        void this.handle({ type: 'compactNow', sessionId: session.id });
        return '';
      case 'newtask':
        void this.newTask(session.id, rest.trim());
        return '';
      case 'deep-planning':
        if (!rest.trim()) {
          return say('Usage: `/deep-planning <task>` — investigates the code, asks what it cannot tell, then writes `implementation_plan.md` (the turn runs in Plan mode).');
        }
        return { rewrite: deepPlanningPrompt(rest), planTurn: true };
      case 'team':
        if (!rest.trim()) {
          return say('Usage: `/team <task>` — splits the task into pieces on the shared board and hands them to background workers (switches this chat to Multitask mode).');
        }
        // The coordinator brief needs Multitask mode (delegation tools, no direct edits); the chat stays in it, as with /mode.
        if (session.mode !== 'multitask') {
          this.telemetry?.record({ type: 'mode_switch', sid: session.id, from: session.mode, to: 'multitask', source: 'slash' });
          session.mode = 'multitask';
          this.store.save(session);
          this.broadcast(this.sessionMsg(session));
        }
        return { rewrite: teamPrompt(rest) };
      case 'mode':
        if ((ALL_MODES as readonly string[]).includes(rest.trim())) {
          if (session.mode !== rest.trim()) {
            this.telemetry?.record({ type: 'mode_switch', sid: session.id, from: session.mode, to: rest.trim(), source: 'slash' });
          }
          session.mode = rest.trim() as Session['mode'];
          this.store.save(session);
          this.broadcast(this.sessionMsg(session));
          return '';
        }
        return say('Usage: `/mode agent|multitask|debug|plan|ask`');
      case 'model':
        if (rest.trim()) {
          this.telemetry?.record({ type: 'model_selected', sid: session.id, model: rest.trim(), source: 'slash' });
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
        return { rewrite: skillTaskPrompt(skill.name, parseTaskArgs(rest).task) };
      }
      case 'agent': {
        const { name, task } = parseTaskArgs(rest);
        if (!this.skills.getAgent(name)) {
          return say(`Unknown subagent "${name}". Try /agents.`);
        }
        if (!task) {
          return say('Usage: `/agent <name> <task>`');
        }
        return { rewrite: agentTaskPrompt(name, task) };
      }
      default: {
        // Built-in command, then a skill of that name (`/<skill-name> <task>`), then a custom command or workflow.
        const skill = this.skills.enabledSkills.find((s) => normalizeCommandName(s.name) === cmd);
        const target = pickSlashTarget(this._commands?.get(cmd), skill);
        if (target && 'skill' in target) {
          return { rewrite: skillTaskPrompt(target.skill.name, rest) };
        }
        if (target) {
          return { command: target.command, args: rest };
        }
        return undefined; // let the model see it
      }
    }
  }

  dispose(): void {
    // Not a user Stop: the engines persist `interrupted` (resumable on the next start) instead of `cancelled`.
    this.shuttingDown = true;
    for (const [, c] of this.runs) {
      c.stop('shutdown');
    }
    clearTimeout(this.deltaTimer);
    clearTimeout(this.openFilesTimer);
    this.fileIndex?.dispose();
    this.notifier.dispose();
    this.pendingDeltas.clear();
    this._onDidChangeActive.dispose();
    this._onDidChangeRuns.dispose();
    this._onAgentEvent.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Instructions for "Improve prompt": sharpen the request, never change what is asked or start doing it. */
export const IMPROVE_PROMPT_SYSTEM = `You rewrite a developer's request to LocalPilot — a coding agent working inside VS Code on the project described in <context> — so the agent can act on it without guessing.
Rules:
- Keep the intent, scope and language of the request. Never add features, requirements, constraints or technologies the user did not ask for.
- Fix spelling and grammar and expand shorthand ("fn" → function, "tests?" → a full request).
- Resolve vague references ("this", "it", "the file", "here") with the editor context: name the actual file, symbol, selection or error.
- If the expected result or how to check it is implied (tests pass, an error disappears, a page renders), say so in one short clause; otherwise leave it out.
- A question stays a question ("why does X crash?" asks for the cause, not a fix) unless it plainly asks for a change. Otherwise match the mode: Ask → a question; Plan → a request for a plan; Agent, Debug and Multitask → a direct instruction.
- Be concise: one to four sentences, or a short bullet list for several distinct parts. Write it as the user, addressed to the agent.
- Do not answer the request, solve the task or explain your changes. Output only the rewritten request — no preamble, quotes, headings or code fences.`;

/** The model's rewrite without the wrappers small models add anyway ("Rewritten request:", quotes, a code fence). */
/** What the user typed for a stored prompt: the command line they entered, or the content without the context blocks the UI prepended. */
/** Identity of a recovery card: its id, prefixed by the subagent for a child's card (wrapped under `payload.data`). */
function recoveryKey(e: AgentEvent): string | undefined {
  const p = e.payload as { id?: unknown; childId?: unknown; data?: { id?: unknown } } | undefined;
  if (!p || typeof p !== 'object') {
    return undefined;
  }
  const id = typeof p.childId === 'string' ? p.data?.id : p.id;
  return typeof id === 'string' ? `${typeof p.childId === 'string' ? p.childId : ''}:${id}` : undefined;
}

/** Checkpoint key of a chat's latest user message. */
function lastTurnKey(s: Session): number | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const k = s.messages[i].role === 'user' ? s.messages[i].meta?.checkpoint : undefined;
    if (k !== undefined) {
      return k;
    }
  }
  return undefined;
}

function promptText(m: ChatMessage): string {
  return (m.meta?.display ?? userText(m.content)).replace(/\n\n\[\d+ images? attached\]$/, '').trim();
}

export function cleanImprovedPrompt(raw: string): string {
  let t = raw.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) {
    t = fence[1].trim();
  }
  t = t.replace(/^(?:\*\*)?(?:rewritten|improved|revised)?\s*(?:request|prompt)\s*:(?:\*\*)?\s*/i, '').replace(/^<request>\s*|\s*<\/request>$/g, '');
  if (/^(["'“])[\s\S]*(["'”])$/.test(t) && !t.slice(1, -1).includes(t[0])) {
    t = t.slice(1, -1).trim();
  }
  return t;
}
