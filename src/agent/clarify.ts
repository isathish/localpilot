import type { WorkspaceContext } from '../context/workspaceContext';
import { Session, Tool, TodoItem } from '../types';

/**
 * Request clarification: detects prompts that are too short, vague or point at an unnamed target
 * ("fix this", "make it faster", "tests?") and gives the agent the surrounding workspace context so it
 * can resolve the intent itself — restating the task and its assumptions — instead of guessing blindly or
 * stalling on a question the user could have answered by glancing at their editor.
 */

export interface RequestAssessment {
  /** True when the request can be acted on as written. */
  clear: boolean;
  /** Human-readable reasons the request looks ambiguous (empty when clear). */
  reasons: string[];
}

export interface AssessOptions {
  /** Context blocks (@file, @selection, images…) were attached to the message. */
  hasAttachments?: boolean;
  hasImages?: boolean;
  /** The active editor has a non-empty selection, so "this" has a referent. */
  hasSelection?: boolean;
  /** Earlier user/assistant turns exist, so "it"/"that" may legitimately refer back to them. */
  hasHistory?: boolean;
}

const ACTION_VERBS =
  /\b(fix|repair|refactor|clean(?:\s*up)?|improve|optimi[sz]e|speed(?:\s*up)?|simplify|rewrite|update|change|modify|rename|move|remove|delete|add|implement|create|write|build|make|generate|convert|migrate|port|test|document|explain|describe|summari[sz]e|review|check|verify|validate|debug|handle|finish|complete|do|redo|undo|revert|format|lint|tidy|polish|enhance|extend|upgrade|bump|run|execute|start|stop|restart|show|list|find|search|look|open|read|deploy|release|commit|push|pull|merge|rebase|install|uninstall|compile|analy[sz]e|compare|translate|extract|inline|split|sort|ensure|help|print|log|wrap|replace|insert|apply|continue|retry|try|use|set(?:\s*up)?|configure|enable|disable|turn|switch|toggle|design|plan|outline|propose|suggest|recommend|investigate|look into|figure out)\b/i;
/** Pointing words that need something in view to make sense. */
const DEICTIC = /\b(this|these|those|it|them|here|above|below|the (?:error|bug|issue|problem|failure|crash|warning|function|method|class|file|component|code|thing|stuff|rest|same|other one))\b/i;
const VAGUE_GOAL = /\b(better|nicer|cleaner|faster|quicker|prettier|simpler|smarter|modern(?:i[sz]e)?|robust|readable|efficient|proper(?:ly)?|right|correct(?:ly)?|good|great|nice|ok|okay|work(?:s|ing)?)\b/i;
const GREETING = /^(hi|hello|hey|yo|thanks|thank you|ty|thx|ok|okay|cool|great|nice|good|sure|yes|no|yep|nope|done|bye|lol|k)(\s+(there|all|everyone|again|a lot|so much))?[\s!.]*$/i;
/** Words that do not name a target on their own; what remains after removing them and the verb is the "object". */
const FILLER = /\b(please|pls|can|could|would|you|u|just|also|now|then|and|or|to|for|in|on|of|with|at|by|from|into|the|a|an|this|that|these|those|it|its|them|my|our|your|all|some|any|everything|something|anything|here|there|up|out|more|less|bit|little|again|properly|quickly|really|very|so|too|as|well|is|are|be|should|like|want|need|make|sure|code|stuff|thing|things|whole|entire|current|existing)\b/gi;
/** Something concrete to act on: a path, symbol, quoted string, line reference, URL, issue number… */
const CONCRETE_ANCHOR = /(`[^`]+`|"[^"]{3,}"|'[^']{3,}'|\b[\w./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|css|scss|html|json|ya?ml|toml|md|sql|sh|vue|svelte)\b|\b[a-z]+[A-Z]\w+\b|\b\w+(?:_\w+)+\b|\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b|#\d+|(?::|\bline\s*|\bL)\d+|https?:\/\/|\b\w+\(\)|\/[\w.-]+\/[\w./-]*|@\w+)/;
const STACK_TRACE = /(Traceback \(most recent call last\)|^\s+at .+\(.+:\d+:\d+\)|Error: .+\n|Exception in thread|panic:|\berror\[E\d+\]|TS\d{4}:)/m;
const CONTEXT_BLOCK = /<(attachment|directory|workspace_tree|problems|git|open_editors|terminal_output|selection)\b[^>]*>[\s\S]*?<\/\1>/g;

/** Strip context blocks the UI prepends (`<attachment>`, `<git>` …) so only the user's own words are assessed. */
export function userText(content: string): string {
  return content.replace(CONTEXT_BLOCK, '').replace(/\[\d+ images? attached\]/g, '').trim();
}

export function hasContextBlocks(content: string): boolean {
  CONTEXT_BLOCK.lastIndex = 0;
  return CONTEXT_BLOCK.test(content);
}

export function assessRequest(content: string, opts: AssessOptions = {}): RequestAssessment {
  const text = userText(content);
  const anchoredByContext = !!opts.hasAttachments || !!opts.hasImages || !!opts.hasSelection;
  if (!text) {
    return anchoredByContext ? { clear: true, reasons: [] } : { clear: false, reasons: ['the message is empty'] };
  }
  if (GREETING.test(text) || text.startsWith('/')) {
    return { clear: true, reasons: [] };
  }
  // Error dumps, stack traces and long briefs are complete requests by themselves.
  if (STACK_TRACE.test(text) || text.length > 600) {
    return { clear: true, reasons: [] };
  }

  const words = text.split(/\s+/).filter(Boolean);
  const followUp = !!opts.hasHistory;
  // "go ahead", "do it", "implement the plan" — short replies inside a conversation refer to it.
  if (followUp && words.length <= 4) {
    return { clear: true, reasons: [] };
  }
  const anchored = anchoredByContext || CONCRETE_ANCHOR.test(text);
  const isQuestion = /\?\s*$/.test(text) || /^(what|why|how|where|when|which|who|can|could|should|is|are|does|do|did|will)\b/i.test(text);
  const hasVerb = ACTION_VERBS.test(text);
  // "write tests for the parser" names a target ("tests parser"); "clean it up" does not.
  const object = text.replace(ACTION_VERBS, ' ').replace(FILLER, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const short = words.length <= 8;
  const reasons: string[] = [];

  if (!followUp && words.length <= 2 && !anchored && !object) {
    reasons.push(`it is only ${words.length} word${words.length === 1 ? '' : 's'} long`);
  }
  if (!followUp && short && DEICTIC.test(text) && !anchored) {
    reasons.push('it refers to "this/it/the error" without naming a file, symbol or selection');
  }
  if (!followUp && hasVerb && !isQuestion && !anchored && !object) {
    reasons.push('it names an action but not what to apply it to');
  }
  if (short && VAGUE_GOAL.test(text) && !isQuestion && !anchored) {
    reasons.push('the goal ("better", "faster", "work"…) is not measurable');
  }
  if (!followUp && !hasVerb && !isQuestion && !anchored && words.length <= 3) {
    reasons.push('it is neither a question nor an instruction');
  }
  return { clear: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Workspace signals that usually disambiguate a vague request: what the user is looking at and working on. */
export async function gatherRequestContext(workspace: WorkspaceContext, session?: Pick<Session, 'workingSet' | 'todos' | 'messages'>): Promise<string> {
  const parts: string[] = [];
  const editor = workspace.activeEditorContext();
  parts.push(`## Editor\n${editor || 'No active editor.'}`);
  const open = workspace.openEditors();
  if (open.length) {
    parts.push(`## Open editors\n${open.slice(0, 15).join('\n')}`);
  }
  if (session?.workingSet?.length) {
    parts.push(`## Files touched in this session (most recent last)\n${session.workingSet.slice(-10).join('\n')}`);
  }
  const todos = session?.todos?.filter((t) => t.status !== 'done') ?? [];
  if (todos.length) {
    parts.push(`## Open checklist items\n${todos.map((t: TodoItem) => `- [${t.status}] ${t.title}`).join('\n')}`);
  }
  const lastTurns = (session?.messages ?? []).filter((m) => (m.role === 'user' && !m.meta?.hidden && !m.meta?.toolImages) || (m.role === 'assistant' && m.content.trim())).slice(-4, -1);
  if (lastTurns.length) {
    parts.push(`## Recent conversation\n${lastTurns.map((m) => `${m.role}: ${userText(m.content).replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')}`);
  }
  const errors = workspace.diagnosticsSummary(12);
  if (errors) {
    parts.push(`## Current errors (Problems panel)\n${errors}`);
  }
  const git = await workspace.gitSummary();
  if (git) {
    parts.push(`## Uncommitted changes\n${git}`);
  }
  return parts.join('\n\n');
}

/** Hidden steering message appended after an unclear request (depth 0 only). */
export function clarificationSteer(assessment: RequestAssessment, context: string): string {
  return [
    `The request above may be ambiguous: ${assessment.reasons.join('; ')}. Resolve the intent yourself before acting, using this snapshot of the workspace:`,
    '',
    context,
    '',
    'Procedure:',
    '1. Infer the most plausible target and goal from the active file / selection, open editors, recent files, errors, uncommitted changes and the conversation so far. Read the relevant code if needed. Treat typos and shorthand charitably.',
    '2. Begin your reply with one line "Understood as: <precise restatement>" followed by any assumptions, then carry the task out.',
    '3. Only if two interpretations would lead to materially different work, and the context does not settle it, call ask_user once with 2–4 concrete options instead.',
  ].join('\n');
}

/** `gather_context` tool: the same workspace snapshot, callable on demand by the agent and its subagents. */
export function createGatherContextTool(workspace: WorkspaceContext, sessions?: { get(id: string): Session | undefined }): Tool {
  return {
    parallelSafe: true,
    definition: {
      name: 'gather_context',
      description:
        'Snapshot of what the user is working on: active file and selection, open editors, files touched this session, open checklist items, recent conversation, current errors and uncommitted git changes. Call this first when a request is vague or refers to "this"/"it" without naming a target, to infer the intended file or symbol instead of asking.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, ctx) {
      const session = sessions?.get(ctx.sessionId.split('::')[0]);
      const snapshot = await gatherRequestContext(workspace, session ?? (ctx.todos ? { todos: ctx.todos.get(), messages: [], workingSet: [] } : undefined));
      return { content: `${snapshot}\n\nUse this to decide the target; state your interpretation ("Understood as: …") and proceed.` };
    },
  };
}
