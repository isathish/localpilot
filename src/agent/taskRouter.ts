// Auto mode: what kind of task a message is, and therefore which mode, specialist and model role answer it.
// Deterministic and offline (no model call before the model call): ordered rules over the message and its context,
// each naming the words it matched, so the choice is explained in the chat and easy to override.
import type { ModelRole } from '../providers/catalog';
import type { Session, SpecialistId } from '../types';

export type TaskKind = 'question' | 'explain' | 'project' | 'plan' | 'architect' | 'review' | 'debug' | 'test' | 'refactor' | 'terminal' | 'multitask' | 'code';

export interface TaskInput {
  text: string;
  /** Images attached to this message. */
  images?: number;
  /** Files and other context attached to this message. */
  attachments?: number;
  /** Errors VS Code currently shows in the workspace (Problems panel). */
  diagnostics?: number;
  /** A folder is open: without one, modes that edit files are not available. */
  hasFolder?: boolean;
}

export interface TaskRoute {
  kind: TaskKind;
  mode: Session['mode'];
  specialist?: SpecialistId;
  /** Model role for this turn when the chat's model is Auto. */
  role: ModelRole;
  /** One line for the chat: why this mode ("error in the message", "asks a question"…). */
  reason: string;
}

interface Rule {
  kind: TaskKind;
  test: RegExp;
  why: string;
}

// Order matters: the first rule that matches wins. Specific intents come before the broad "build something" verbs, so
// "fix the failing test" is debugging and "write tests for x" is testing, not generic coding.
const RULES: Rule[] = [
  { kind: 'review', test: /\b(code[- ]?review|review (my|the|this|these|our)|audit|look over|security (review|issues|holes)|vulnerabilit|what('s| is) wrong with (my|this|the) (code|pr|change|diff)|review\b(?!.*\bfix\b))/i, why: 'asks for a review' },
  { kind: 'debug', test: /\b(error|exception|traceback|stack ?trace|crash(es|ed|ing)?|segfault|panic|bug|broken|doesn'?t work|does not work|not working|fails?|failing|failed|regression|undefined is not|cannot read|null pointer|TypeError|ReferenceError|SyntaxError|ENOENT|EADDRINUSE|exit code [1-9])\b/i, why: 'describes an error' },
  { kind: 'test', test: /\b((write|add|generate|create|run|cover|increase)\b.{0,40}\b(unit |integration |e2e |)tests?\b|test coverage|tests? for\b)/i, why: 'asks for tests' },
  { kind: 'refactor', test: /\b(refactor\w*|clean ?up|restructure|simplify|deduplicate|extract (a |the )?(function|method|class|component|module)|split (up )?(this|the) (file|module|class)|rename\b.{0,40}\b(across|everywhere|throughout))\b/i, why: 'asks to restructure code' },
  { kind: 'architect', test: /\b(architecture|architect|system design|design (a|the|an|our) (system|service|api|schema|architecture|data model)|high[- ]level design|trade-?offs?|scalab\w+ (plan|design))\b/i, why: 'asks for a design' },
  { kind: 'plan', test: /\b(plan|roadmap|strategy|approach|how should (i|we)|what('s| is) the best way to|steps to|break (it|this) down|before (you|we) (start|build|code))\b/i, why: 'asks for a plan' },
  { kind: 'project', test: /\b(this (whole )?(project|codebase|repo(sitory)?)|the (whole )?(project|codebase|repo(sitory)?)|overview of|onboard\w*|understand (the |this )?(codebase|project|repo))\b/i, why: 'is about the whole project' },
  { kind: 'terminal', test: /^\s*(run|execute|start|stop|restart|install|uninstall|deploy|build|launch)\b.{0,60}\b(npm|pnpm|yarn|pip|poetry|cargo|go|docker|kubectl|make|gradle|mvn|dotnet|git|brew|apt|server|container|script|command)\b|^\s*(npm|pnpm|yarn|pip|cargo|docker|kubectl|make|git|brew)\s+\S/i, why: 'asks to run commands' },
  { kind: 'explain', test: /^\s*(explain|walk me through|what does|what do|how does|how do\b.{0,30}\bwork|why does|why do|what is the (purpose|role)|describe)\b/i, why: 'asks for an explanation' },
  { kind: 'code', test: /\b(add|create|implement|build|make|write|update|change|modify|fix|remove|delete|rename|migrate|convert|port|upgrade|replace|move|generate|scaffold|wire|hook up|integrate|support)\b/i, why: 'asks for a change' },
];

const BY_KIND: Record<TaskKind, { mode: Session['mode']; specialist?: SpecialistId; role: ModelRole }> = {
  question: { mode: 'ask', role: 'agent' },
  explain: { mode: 'ask', specialist: 'explain', role: 'agent' },
  project: { mode: 'ask', specialist: 'project', role: 'agent' },
  plan: { mode: 'plan', role: 'reasoning' },
  architect: { mode: 'plan', specialist: 'architect', role: 'reasoning' },
  review: { mode: 'ask', specialist: 'review', role: 'reasoning' },
  debug: { mode: 'debug', role: 'agent' },
  test: { mode: 'agent', specialist: 'test', role: 'agent' },
  refactor: { mode: 'agent', specialist: 'refactor', role: 'agent' },
  terminal: { mode: 'agent', specialist: 'terminal', role: 'agent' },
  multitask: { mode: 'multitask', role: 'agent' },
  code: { mode: 'agent', role: 'agent' },
};

/** Modes that need a folder (they edit files or run commands). */
const WRITES: ReadonlySet<Session['mode']> = new Set(['agent', 'debug', 'multitask']);

/** Three or more independent work items ("1. … 2. … 3. …" or bullets with verbs) or "in parallel": split across workers. */
function looksMultitask(text: string): boolean {
  if (/\b(in parallel|at the same time|simultaneously|separately)\b/i.test(text)) {
    return true;
  }
  const items = text.split('\n').filter((l) => /^\s*(\d+[.)]|[-*•])\s+\S/.test(l));
  const actionable = items.filter((l) => RULES.some((r) => r.kind !== 'question' && r.test.test(l)));
  return actionable.length >= 3;
}

/** A question with nothing to change: it ends with "?" or starts with a question word, and asks for no edit. */
function isQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) || /^(what|why|how|when|where|which|who|is|are|can|could|should|does|do|will|would)\b/i.test(t);
}

/**
 * The task a message describes. `role` is the model role for an Auto model: `reasoning` for plans, designs and reviews,
 * `fast` for a short question with nothing attached, `agent` otherwise.
 */
export function classifyTask(i: TaskInput): TaskRoute {
  const text = i.text.trim();
  let kind: TaskKind | undefined;
  let why = '';
  if (looksMultitask(text)) {
    kind = 'multitask';
    why = 'lists several independent tasks';
  } else {
    const hit = RULES.find((r) => r.test.test(text));
    // A question that only mentions a fix ("how would I fix this?") is still a question, unless it names an error.
    if (hit && hit.kind === 'code' && isQuestion(text)) {
      kind = 'question';
      why = 'asks a question';
    } else if (hit) {
      kind = hit.kind;
      why = hit.why;
    }
  }
  if (!kind && (i.diagnostics ?? 0) > 0 && /\b(this|it|these|them|problems?|errors?|warnings?)\b/i.test(text) && text.length < 120) {
    kind = 'debug';
    why = `${i.diagnostics} error${i.diagnostics === 1 ? '' : 's'} in the workspace`;
  }
  if (!kind) {
    kind = isQuestion(text) || !i.hasFolder ? 'question' : 'code';
    why = kind === 'question' ? 'asks a question' : 'asks for a change';
  }
  let { mode, specialist, role } = BY_KIND[kind];
  // A short question with nothing attached is answered fastest by a small model.
  if (kind === 'question' && text.length <= 160 && !(i.attachments ?? 0) && !(i.images ?? 0)) {
    role = 'fast';
  }
  if (i.hasFolder === false && WRITES.has(mode)) {
    mode = 'ask';
    specialist = kind === 'debug' || kind === 'code' || kind === 'test' || kind === 'refactor' || kind === 'terminal' || kind === 'multitask' ? undefined : specialist;
    why += '; no folder open, so read-only';
  }
  return { kind, mode, ...(specialist ? { specialist } : {}), role, reason: why };
}

/** "Debug", "Review"…: what the chat shows after "Auto →". */
export function autoLabel(r: Pick<TaskRoute, 'mode' | 'specialist'>): string {
  const names: Record<string, string> = { ask: 'Ask', agent: 'Agent', plan: 'Plan', debug: 'Debug', multitask: 'Multitask', explain: 'Explain', project: 'Project', architect: 'Architect', review: 'Review', test: 'Test', refactor: 'Refactor', terminal: 'Terminal' };
  return names[r.specialist ?? r.mode] ?? r.mode;
}
