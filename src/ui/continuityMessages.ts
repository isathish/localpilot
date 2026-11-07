// Webview messages of the continuity navigator and pages (design §16.4), added to the chat controller's unions and
// handled in continuityHost.ts. Types only (plus the set of message names the controller hands over).
import type { BranchRow, ConversationRow, NavCounts, VersionRow } from '../continuity/data/index/queries';
import type { Siblings } from '../continuity/conversation/conversationManager';
import type { MemoryFromWebview, MemoryToWebview } from './memoryHost';
import type { ContextFromWebview, ContextToWebview } from './contextHost';

export type NavView = 'all' | 'pinned' | 'favorites' | 'archived' | 'trash';
export type ConvActionName = 'open' | 'rename' | 'favorite' | 'unfavorite' | 'archive' | 'unarchive' | 'pin' | 'unpin' | 'trash' | 'restore' | 'purge' | 'emptyTrash' | 'duplicate' | 'merge' | 'repoint';
export type ContinuityPageName = 'trash' | 'versions' | 'memory' | 'context' | 'checkpoints' | 'sync';

/** A navigator row: the index's conversation row plus a search snippet when the list answers a query. */
export type NavRow = ConversationRow & { snippet?: string; field?: string; role?: string; messageId?: string; inStore?: boolean };

export interface NavProject {
  id: string;
  name: string;
  count: number;
  current?: boolean;
  /** The folder is gone on this device (moved or deleted): the navigator offers "This is the same project". */
  missing?: boolean;
}

export type ContinuityFromWebview =
  | { type: 'nav'; seq: number; view: NavView; projectId?: string; query?: string; offset?: number; limit?: number; sort?: string; tag?: string }
  | { type: 'convAction'; ids: string[]; action: ConvActionName; uptoMessageId?: string; otherId?: string; projectId?: string; title?: string }
  /** Without `add`/`remove` the host asks (an input box prefilled with the current tags). */
  | { type: 'setTags'; ids: string[]; add?: string[]; remove?: string[] }
  | { type: 'exportConversations'; ids: string[]; format: 'json' | 'markdown' | 'html' | 'pdf' }
  | { type: 'importConversations' }
  | { type: 'shareConversation'; id: string; branchId?: string }
  | { type: 'branch'; sessionId: string; action: 'switch' | 'step' | 'continueFrom' | 'duplicateFrom' | 'rename'; branchId?: string; messageId?: string; delta?: number; label?: string }
  | { type: 'branches'; sessionId: string }
  | { type: 'regenerateWith'; sessionId: string; messageId?: string; model?: string }
  | { type: 'compareVersions'; sessionId: string; messageId: string }
  | { type: 'versions'; ent: 'conversation'; id: string }
  | { type: 'restoreVersion'; ent: 'conversation'; id: string; hlc: string }
  | { type: 'continuityPage'; page: ContinuityPageName; params?: Record<string, unknown> }
  /** The "Updated on <device>" banner's Reload. */
  | { type: 'remoteReload'; sessionId: string }
  /** Checkpoints page (SESSION): View changes since it, Restore (task / workspace / both, the chat's existing restore), Open chat. */
  | { type: 'checkpointAction'; action: 'view' | 'restore' | 'open'; sessionId: string; run: number; restoreType?: 'task' | 'workspace' | 'both' }
  /** Memory manager page, "Remember in this chat", "Save to knowledge", `#memory:` suggestions (MEMORY). */
  | MemoryFromWebview
  /** Context library, "What did the model see?", related conversations, `#context:` / `#chat:` suggestions (CONTEXT). */
  | ContextFromWebview;

export type ContinuityToWebview =
  | { type: 'navPage'; seq: number; indexState: string; counts?: NavCounts; projects: NavProject[]; currentProject?: string; page: { rows: NavRow[]; total: number; offset: number; limit: number; query?: string }; tags?: string[] }
  /** Something in the navigator changed (an action finished): it asks for its page again. */
  | { type: 'navChanged' }
  | { type: 'continuityPage'; page: ContinuityPageName; data: unknown }
  | { type: 'branches'; sessionId: string; active: string; branches: BranchRow[]; siblings: Record<string, Siblings> }
  | { type: 'remoteUpdate'; sessionId: string; device: string; kind: 'updated' | 'continued'; applied: boolean }
  | { type: 'versionsList'; ent: 'conversation'; id: string; title: string; versions: VersionRow[]; branches: BranchRow[] }
  | { type: 'compare'; sessionId: string; messageId: string; items: { id: string; model?: string; text: string; createdAt: number; current: boolean }[] }
  /** Commands: open the navigator, or a page (Trash…). */
  | { type: 'openNavigator'; view?: NavView }
  | { type: 'openContinuityPage'; page: ContinuityPageName; params?: Record<string, unknown> }
  | MemoryToWebview
  | ContextToWebview;

export const CONTINUITY_MESSAGES = new Set<string>(['nav', 'convAction', 'setTags', 'exportConversations', 'importConversations', 'shareConversation', 'branch', 'branches', 'regenerateWith', 'compareVersions', 'versions', 'restoreVersion', 'continuityPage', 'remoteReload', 'memoryAction', 'contextAction', 'checkpointAction']);
