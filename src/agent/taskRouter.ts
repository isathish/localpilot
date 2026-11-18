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
  /**
   * An incidental match: skipped when the message opens with a build verb ("Add a retry strategy", "Write tests for the
   * error parser", "Update the project README"), where the noun names what to build, not what the user wants.
   */
  incidental?: boolean;
}

/** Verbs that ask for something to be built or changed. A message that opens with one is a change request first. */
const BUILD_VERBS = new Set([
  'add', 'create', 'implement', 'build', 'make', 'write', 'update', 'change', 'modify', 'remove', 'delete', 'rename', 'migrate', 'convert', 'port',
  'upgrade', 'replace', 'move', 'generate', 'scaffold', 'wire', 'hook', 'integrate', 'support', 'introduce', 'extend', 'enable', 'disable', 'bump',
  'set', 'setup', 'expose', 'document', 'use', 'switch', 'include', 'insert', 'append', 'configure', 'allow', 'adjust', 'tweak', 'improve', 'optimize',
  'optimise', 'handle', 'translate', 'localize', 'style', 'restyle', 'redesign', 'rewrite', 'drop', 'keep', 'show', 'hide', 'display', 'log', 'store',
  'save', 'persist', 'cache', 'validate', 'sanitize', 'parse', 'export', 'import', 'apply', 'continue', 'finish', 'complete', 'do', 'execute',
]);

/** The message's first verb, after a list marker and politeness ("please", "can you", "let's"…), lower-cased. */
export function leadVerb(text: string): string {
  let t = text.trim().replace(/^(\d+[.)]|[-*•])\s+/, '');
  for (let i = 0; i < 4; i++) {
    const next = t.replace(/^(please|pls|kindly|ok(ay)?|so|now|then|also|and|next|first|finally|go ahead and|can you|could you|would you|will you|let'?s|let us|i (want|need|would like) (you )?to|i'?d like (you )?to|help me|try to)[\s,:]+/i, '');
    if (next === t) {
      break;
    }
    t = next;
  }
  return (/^[a-z']+/i.exec(t)?.[0] ?? '').toLowerCase();
}

/** "error" as part of a feature's name (error handling, the error parser…) rather than an error that happened. */
const ERR = String.raw`errors?(?!\s+(?:handling|handlers?|parser|parsing|class(?:es)?|types?|boundar(?:y|ies)|pages?|screens?|modules?|codes?|reporting|reporter|logging|logs?\b|format\w*|messages? (?:format|style|text|copy)|states?|budget|rates?|tracking|tracker|views?|components?|banners?|toasts?|dialogs?|helpers?|utils?|model))`;
/** A failure the user reports: an error signature, something that fails or crashes, a bug that exists. */
const REPORTED_FAILURE = new RegExp(
  String.raw`\b(exception|traceback|stack ?trace|crash(es|ed|ing)?|segfault|panic(s|ked|king)?|broken|doesn'?t work|does not work|isn'?t working|is not working|not working|stopped working|no longer works?|fails?|failing|failed|regression|throws (an?|the)|throwing|threw|hangs|freezes|undefined is not|cannot read|can'?t read|null pointer|TypeError|ReferenceError|SyntaxError|ENOENT|EADDRINUSE|ECONNREFUSED|exit code [1-9]|bug (in|where|when|with|that|on)\b|(a|the|this|that|there'?s a|found a) bug\b(?!\s+(tracker|reports?|templates?|labels?|bount))|${ERR} (when|on|in|after|while|during|at|about|saying|says|that|from)\b|(an?|the|this|that|these|those|getting|get|got|gets|seeing|see|saw|shows?|showing|throws?|returns?|returning|raises?|with) ${ERR}\b)\b|\b${ERR}:|(^|[.!?]\s*)(please\s+|can you\s+|could you\s+)?(debug|diagnose|troubleshoot)\b`,
  'i'
);
/** "…if the request fails", "when saving errors": a condition to handle, not a failure that happened. */
const HYPOTHETICAL = /\b(if|whether|in case|unless|so that|in the event|whenever|when)\b[^.?!,;]{0,60}/gi;

/** Planning intent: asked to plan, or how / which way to go about something — not the word "plan" or "approach" alone. */
const PLAN_INTENT = /(^\s*(let'?s |please |can you |could you )?plan\b|\bplan (how|out|for|the (steps|work|migration|rollout|implementation))\b|\b(make|create|write|draft|come up with|propose|outline|give me|suggest|prepare|put together|sketch)\s+(me\s+)?(a|an|the)\s+([\w-]+\s+){0,2}(plan|roadmap)\b|\b(help me|let'?s|we need to) plan\b|\bhow should (i|we)\b|\bwhat('s| is| would be) (the )?(best|right|cleanest|simplest|recommended) (way|approach|strategy|order)\b|\b(which|what) approach\b|\bwhat are the steps\b|\bbreak (it|this|that|the [\w-]+) down\b|\bbefore (you|we) (start|build|code|write|change|touch)\b|\bthink through\b)/i;

// Order matters: the first rule that matches wins. Specific intents come before the broad "build something" verbs, so
// "fix the failing test" is debugging and "write tests for x" is testing, not generic coding.
const RULES: Rule[] = [
  { kind: 'review', test: /\b(code[- ]?review|review (my|the|this|these|our)|audit|look over|security (review|issues|holes)|vulnerabilit|what('s| is) wrong with (my|this|the) (code|pr|change|diff)|review\b(?!.*\bfix\b))/i, why: 'asks for a review', incidental: true },
  { kind: 'debug', test: REPORTED_FAILURE, why: 'describes an error', incidental: true },
  { kind: 'test', test: /\b((write|add|generate|create|run|cover|increase)\b.{0,40}\b(unit |integration |e2e |)tests?\b|test coverage|tests? for\b)/i, why: 'asks for tests' },
  { kind: 'refactor', test: /\b(refactor\w*|clean ?up|restructure|simplify|deduplicate|extract (a |the )?(function|method|class|component|module)|split (up )?(this|the) (file|module|class)|rename\b.{0,40}\b(across|everywhere|throughout))\b/i, why: 'asks to restructure code' },
  { kind: 'architect', test: /\b(architecture|architect|system design|design (a|the|an|our) (system|service|api|schema|architecture|data model)|high[- ]level design|trade-?offs?|scalab\w+ (plan|design))\b/i, why: 'asks for a design', incidental: true },
  { kind: 'plan', test: PLAN_INTENT, why: 'asks for a plan' },
  { kind: 'project', test: /\b(this (whole )?(project|codebase|repo(sitory)?)|the (whole )?(project|codebase|repo(sitory)?)|overview of|onboard\w*|understand (the |this )?(codebase|project|repo))\b/i, why: 'is about the whole project', incidental: true },
  { kind: 'terminal', test: /^\s*(run|execute|start|stop|restart|install|uninstall|deploy|build|launch)\b.{0,60}\b(npm|pnpm|yarn|pip|poetry|cargo|go|docker|kubectl|make|gradle|mvn|dotnet|git|brew|apt|server|container|script|command)\b|^\s*(npm|pnpm|yarn|pip|cargo|docker|kubectl|make|git|brew)\s+\S/i, why: 'asks to run commands' },
  { kind: 'explain', test: /^\s*(explain|walk me through|what does|what do|how does|how do\b.{0,30}\bwork|why does|why do|what is the (purpose|role)|describe)\b/i, why: 'asks for an explanation' },
  { kind: 'code', test: /\b(add|create|implement|build|make|write|update|change|modify|fix|remove|delete|rename|migrate|convert|port|upgrade|replace|move|generate|scaffold|wire|hook up|integrate|support)\b/i, why: 'asks for a change' },
];

/** The first rule the message matches, reading it for intent: a leading build verb outranks incidental nouns. */
function matchRule(text: string): Rule | undefined {
  const build = BUILD_VERBS.has(leadVerb(text));
  const reported = text.replace(HYPOTHETICAL, ' ');
  return RULES.find((r) => !(build && r.incidental) && r.test.test(r.kind === 'debug' ? reported : text));
}

/** What Auto does with each kind of task (also drawn by the Agent map). */
export const BY_KIND: Record<TaskKind, { mode: Session['mode']; specialist?: SpecialistId; role: ModelRole }> = {
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
  const actionable = items.filter((l) => !!matchRule(l));
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
    const hit = matchRule(text);
    // A question that only mentions a fix ("how would I fix this?") is still a question, unless it names an error.
    // A polite request ("Can you add a toggle?") opens with the verb once the politeness is set aside: a change.
    const lead = leadVerb(text);
    if (hit && hit.kind === 'code' && isQuestion(text) && !(BUILD_VERBS.has(lead) || lead === 'fix')) {
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
