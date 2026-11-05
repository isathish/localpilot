import { randomUUID } from 'crypto';
import type { ToolCallDecision, ToolResult } from '../../types';
import { isDenialText } from '../approvalLevel';
import { classifyModelError } from '../resilience';
import { parseDotnet } from './parsers/dotnet';
import { parseEslint } from './parsers/eslint';
import { parseGeneric } from './parsers/generic';
import { parseConflictMarkers, parseGit } from './parsers/git';
import { parseGo } from './parsers/go';
import { parseJsTest } from './parsers/jsTest';
import { parseJvm } from './parsers/jvm';
import { parseMcp } from './parsers/mcp';
import { parsePython } from './parsers/python';
import { parseRust } from './parsers/rust';
import { parseTypescript } from './parsers/typescript';
import { clip, defaultClass, defaultSeverity, lines, make, MAX_FAILURES, relativiseText, topFrame, withDuplicates, type ParsedFailure, type Parser } from './parsers/common';
import { exactSignature, genericSignature, relativePath } from './signature';
import type { CheckEcosystem, CheckKind, CheckSpec, ExecResult, Failure, FailureCategory, FailureSource, Severity } from './types';

export type ClassifyInput =
  | {
      kind: 'model';
      /** A `ModelFailure` (incl. 'overload') when the caller already classified the error. */
      failure?: string;
      error?: unknown;
      modelName: string;
      root?: string;
    }
  | {
      kind: 'tool';
      name: string;
      args: Record<string, unknown>;
      result?: ToolResult;
      decision?: ToolCallDecision;
      callId?: string;
      root?: string;
    }
  | {
      kind: 'check';
      spec: Pick<CheckSpec, 'id' | 'kind' | 'ecosystem'> & Partial<CheckSpec>;
      outcome: ExecResult;
      /** The check ran in a worktree without installed dependencies: missing modules are not missing dependencies. */
      worktreeMissingDeps?: boolean;
      root?: string;
    }
  | { kind: 'diagnostics'; text: string; file?: string; root?: string }
  | { kind: 'loop'; reason: 'identical_calls' | 'mistake_limit' | 'step_limit' | 'deadline' | string; message?: string; root?: string };

const ALL_PARSERS: Parser[] = [parseTypescript, parseEslint, parseJsTest, parsePython, parseGo, parseRust, parseJvm, parseDotnet, parseGit];

const BY_ECOSYSTEM: Record<CheckEcosystem, Parser[]> = {
  node: [parseTypescript, parseEslint, parseJsTest],
  python: [parsePython],
  go: [parseGo],
  rust: [parseRust],
  maven: [parseJvm],
  gradle: [parseJvm],
  dotnet: [parseDotnet],
  make: ALL_PARSERS,
  custom: ALL_PARSERS,
};

const KIND_FALLBACK: Record<CheckKind, FailureCategory> = {
  build: 'build', typecheck: 'typescript', lint: 'lint', test: 'unit_test', security: 'security', custom: 'unknown',
};

/** OOM / resource exhaustion reported by local model servers (Ollama, llama.cpp, vLLM). */
export const OVERLOAD = /out of memory|\bOOM\b|CUDA error|failed to allocate|model requires more system memory|insufficient memory|llama runner process has terminated/i;

/** Signatures, id and source on a parsed failure. */
function finalise(p: ParsedFailure, source: FailureSource, root: string | undefined): Failure {
  return { ...p, id: randomUUID(), source: p.source ?? source, signature: exactSignature(p, root), generic: genericSignature(p, root) };
}

/** One failure per exact signature (later duplicates folded into its evidence), at most MAX_FAILURES. */
function dedupe(list: Failure[]): Failure[] {
  const bySig = new Map<string, { kept: Failure; dups: Failure[] }>();
  for (const f of list) {
    const hit = bySig.get(f.signature);
    if (hit) {
      hit.dups.push(f);
    } else if (bySig.size < MAX_FAILURES) {
      bySig.set(f.signature, { kept: f, dups: [] });
    }
  }
  return [...bySig.values()].map((e) => withDuplicates(e.kept, e.dups));
}

/**
 * Specific toolchain parsers first; the generic parser fills in what they did not see (install errors, port clashes,
 * database errors, corruption, and Node stack traces when no test runner reported the failure).
 */
export function parseOutput(output: string, root: string, parsers: Parser[] = ALL_PARSERS): ParsedFailure[] {
  // Workspace paths (which may contain spaces) become relative before any parser sees them.
  const text = relativiseText(output, root);
  const specific = parsers.flatMap((p) => p(text, root));
  const sawTests = specific.some((f) => f.category === 'unit_test' || f.category === 'integration_test');
  const specificLines = new Set(specific.flatMap((f) => lines(f.evidence).map((l) => l.trim()).filter(Boolean)));
  const extra = parseGeneric(text, root).filter((g) => {
    if (sawTests && (g.category === 'runtime' || g.category === 'dependency') && g.code !== 'EADDRINUSE') {
      return false;
    }
    if (g.category === 'database' && g.code === 'migration' && (sawTests || specificLines.has(lines(g.evidence)[0].trim()))) {
      return false;
    }
    return !specific.some((s) => s.category === g.category && (s.message.includes(g.message) || g.message.includes(s.message) || (!!s.symbol && s.symbol === g.symbol)));
  });
  return [...specific, ...extra];
}

/** Text of a tool result without the `$ command` echo and `[exit code N]` trailer of run_command. */
function commandOutput(content: string): string {
  return content.replace(/^\$ [^\n]*\n/, '').replace(/\n\[exit code [^\]]*\]\s*$/, '');
}

function exitCodeOf(result: ToolResult | undefined): number | null | undefined {
  const data = result?.data as { exitCode?: number | null; detached?: boolean } | undefined;
  if (data?.detached) {
    return undefined;
  }
  if (data && 'exitCode' in data) {
    return data.exitCode ?? null;
  }
  const m = /\[exit code (-?\d+|null)\]\s*$/.exec(result?.content ?? '');
  return m ? (m[1] === 'null' ? null : Number(m[1])) : undefined;
}

const firstLine = (text: string) => lines(text).map((l) => l.trim()).find(Boolean) ?? '';

/** The most telling line of an unparsed failure: the last error-looking line, else the last non-empty one. */
function telling(text: string): string {
  const ls = lines(text).map((l) => l.trim()).filter(Boolean);
  return [...ls].reverse().find((l) => /\b(error|fail(?:ed|ure)?|exception|fatal|cannot|not found|denied)\b/i.test(l)) ?? ls[ls.length - 1] ?? '';
}

const tail = (text: string, max = 2048) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`);

/** A missing module in a worktree that has no installed dependencies: an environment gap, not a repairable failure. */
const worktreeMissingModule = (f: ParsedFailure): boolean =>
  f.category === 'dependency' && /Cannot find (?:module|package)|ModuleNotFoundError|No module named|MODULE_NOT_FOUND/i.test(`${f.code ?? ''} ${f.message}`);

/** Git commands that can leave conflicts (or list them, for `status`). */
const GIT_CONFLICT_SUBCOMMAND = /^(?:merge|rebase|cherry-pick|revert|pull|am|status|stash\s+(?:pop|apply))\b/;
const GIT_CONFLICT_TOOLS = /^(?:git_status|git_(?:pull|merge|rebase|cherry_pick|revert|stash_pop|stash_apply))$/;

/** A shell command one of whose `git` invocations can report conflicts; global options (`-C dir`, `-c k=v`) skipped. */
function gitMayConflict(command: string): boolean {
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const m = /^\s*(?:\S+=\S*\s+)*git\s+(.*)$/.exec(part);
    if (!m) {
      continue;
    }
    const rest = m[1].replace(/^(?:(?:-[Cc]|--git-dir|--work-tree)\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*/, '');
    if (GIT_CONFLICT_SUBCOMMAND.test(rest)) {
      return true;
    }
  }
  return false;
}

function classifyModel(input: Extract<ClassifyInput, { kind: 'model' }>): Failure[] {
  const raw = input.error instanceof Error ? input.error.message : input.error === undefined ? '' : String(input.error);
  const body = `${raw} ${(input.error as { body?: string } | undefined)?.body ?? ''}`;
  let kind = input.failure ?? (input.error !== undefined ? classifyModelError(input.error) : 'other');
  if ((kind === 'server' || kind === 'other' || kind === 'network') && OVERLOAD.test(body)) {
    kind = 'overload';
  }
  const map: Record<string, { category: FailureCategory; cls: Failure['cls'] } | undefined> = {
    network: { category: 'model_unavailable', cls: 'transient' },
    unroutable: { category: 'model_unavailable', cls: 'transient' },
    server: { category: 'model_unavailable', cls: 'transient' },
    ratelimit: { category: 'model_unavailable', cls: 'transient' },
    stall: { category: 'model_timeout', cls: 'transient' },
    overload: { category: 'model_overload', cls: 'environmental' },
    toolcall: { category: 'model_output', cls: 'deterministic' },
    malformed: { category: 'model_output', cls: 'deterministic' },
    empty: { category: 'model_output', cls: 'deterministic' },
    output: { category: 'model_output', cls: 'deterministic' },
    auth: { category: 'permission', cls: 'policy' },
    quota: { category: 'permission', cls: 'policy' },
    other: { category: 'unknown', cls: 'fatal' },
  };
  // Context overflow is handled by compaction, not by healing.
  if (kind === 'overflow') {
    return [];
  }
  const m = map[kind] ?? map.other!;
  const message = clip(firstLine(raw) || `${input.modelName}: ${kind}`, 300);
  const p = make(m.category, { code: `model:${kind}`, message, cls: m.cls, symbol: input.modelName, evidence: raw || message }, input.root);
  return [finalise(p, { kind: 'model' }, input.root)];
}

function permission(name: string, decision: ToolCallDecision, root: string | undefined): ParsedFailure {
  const why = decision.deniedByUser ? 'denied by the user' : `blocked by ${decision.blockedBy}`;
  return make('permission', { code: decision.deniedByUser ? 'denied' : `blocked:${decision.blockedBy}`, message: `${name} ${why}`, symbol: name }, root);
}

const SECURITY_ROW = /^\[(critical|high)\] (.*)$/;

function securityFindings(content: string, root: string | undefined): ParsedFailure[] {
  const out: ParsedFailure[] = [];
  for (const l of lines(content)) {
    const m = SECURITY_ROW.exec(l.trim());
    if (!m) {
      continue;
    }
    const sev = m[1] as Severity;
    // Dependency: "pkg ver (eco) — title (ids) in file. Fix: …"; code/secret: "title — file:line (id). Fix: …".
    const dep = /^(\S+) \S+ \([^)]+\) — (.*) \(([^)]+)\) in (\S+?)(?::(\d+))?\. Fix:/.exec(m[2]);
    const code = dep ? undefined : /^(.*) — (\S+?)(?::(\d+))? \(([^)]+)\)\. Fix:/.exec(m[2]);
    if (dep) {
      out.push(make('security', { code: dep[3].split(', ')[0], message: `${dep[1]}: ${dep[2]}`, file: dep[4], line: dep[5] ? Number(dep[5]) : undefined, severity: sev, symbol: dep[1], evidence: l.trim() }, root));
    } else if (code) {
      out.push(make('security', { code: code[4], message: code[1], file: code[2], line: code[3] ? Number(code[3]) : undefined, severity: sev, evidence: l.trim() }, root));
    } else {
      out.push(make('security', { message: m[2].replace(/\. Fix:.*$/, ''), severity: sev, evidence: l.trim() }, root));
    }
  }
  return out;
}

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'delete_path', 'create_directory']);

/** Texts an edit tool writes (whole content or replacement fragments). */
function writtenTexts(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['content', 'new_text', 'new_string', 'text']) {
    if (typeof args[k] === 'string') {
      out.push(args[k] as string);
    }
  }
  if (Array.isArray(args.edits)) {
    for (const e of args.edits as Record<string, unknown>[]) {
      if (e && typeof e.new_text === 'string') {
        out.push(e.new_text);
      }
    }
  }
  return out;
}

function classifyTool(input: Extract<ClassifyInput, { kind: 'tool' }>): Failure[] {
  const { name, args, result, decision } = input;
  const root = input.root ?? '';
  const source: FailureSource = { kind: 'tool', tool: name, callId: input.callId };
  const done = (list: ParsedFailure[]) => dedupe(list.map((p) => finalise(p, source, input.root)));
  const content = result?.content ?? '';
  if (decision && (decision.deniedByUser || decision.blockedBy)) {
    return done([permission(name, decision, input.root)]);
  }
  if (result?.isError && isDenialText(content.trim())) {
    return done([permission(name, { deniedByUser: true }, input.root)]);
  }

  if (name === 'run_command') {
    const exit = exitCodeOf(result);
    const command = typeof args.command === 'string' ? args.command : '';
    const output = commandOutput(content);
    // Merges and rebases exit 1 on conflicts; status exits 0 while listing unmerged paths. Diffs and logs never count.
    const conflicts = gitMayConflict(command) ? parseGit(output, root) : [];
    if (conflicts.length) {
      return done(conflicts);
    }
    if (exit === 0 || exit === undefined) {
      return [];
    }
    if (exit === null && /^Failed to start:/.test(content)) {
      return done([make('tool', { code: 'spawn', message: content, evidence: content }, input.root)]);
    }
    const parsed = parseOutput(output, root);
    if (parsed.length) {
      return done(parsed);
    }
    return done([make('tool', { code: `exit:${exit}`, message: telling(output) || `${command} exited with ${exit}`, evidence: tail(output), symbol: command.split(/\s+/)[0] || undefined }, input.root)]);
  }

  if (name.startsWith('mcp_')) {
    if (!result?.isError) {
      return [];
    }
    const server = /^mcp_(.+?)__/.exec(name)?.[1];
    const parsed = parseMcp(content, root).map((p) => ({ ...p, symbol: server }));
    if (parsed.length) {
      return done(parsed);
    }
    return done([make('mcp', { code: 'MCP:error', message: firstLine(content) || `${name} failed`, cls: 'deterministic', severity: 'low', notExecuted: false, symbol: server, evidence: content }, input.root)]);
  }

  if (name === 'security_scan') {
    const findings = (result?.data as { findings?: number } | undefined)?.findings ?? 0;
    return findings > 0 ? done(securityFindings(content, input.root)) : [];
  }

  if (name.startsWith('git_') || name === 'pull_request') {
    const conflicts = GIT_CONFLICT_TOOLS.test(name) ? parseGit(content, root) : [];
    if (conflicts.length) {
      return done(conflicts);
    }
    return result?.isError ? done([make('tool', { message: firstLine(content) || `${name} failed`, evidence: tail(content) }, input.root)]) : [];
  }

  if (EDIT_TOOLS.has(name)) {
    const file = typeof args.path === 'string' ? args.path : undefined;
    const out: ParsedFailure[] = [];
    if (!result?.isError && file) {
      for (const t of writtenTexts(args)) {
        out.push(...parseConflictMarkers(t, file, root));
      }
      out.push(...parseDiagnosticsText(content, file, root));
    }
    if (result?.isError) {
      out.push(make('tool', { code: name, message: firstLine(content) || `${name} failed`, file, evidence: tail(content) }, input.root));
    }
    return done(out);
  }

  return result?.isError ? done([make('tool', { code: name, message: firstLine(content) || `${name} failed`, evidence: tail(content) }, input.root)]) : [];
}

function classifyCheck(input: Extract<ClassifyInput, { kind: 'check' }>): Failure[] {
  const { spec, outcome } = input;
  const root = input.root ?? '';
  const source: FailureSource = { kind: 'check', checkId: spec.id };
  if (outcome.skipped) {
    return [];
  }
  if (outcome.timedOut) {
    const p = make('check_timeout', { code: 'timeout', message: `${spec.id} timed out${spec.timeoutSeconds ? ` after ${spec.timeoutSeconds}s` : ''}`, evidence: tail(outcome.output) }, input.root);
    return [finalise(p, source, input.root)];
  }
  if (outcome.exitCode === 0) {
    return [];
  }
  const parsers = spec.kind === 'lint' && spec.ecosystem === 'node' ? [parseEslint, parseTypescript] : BY_ECOSYSTEM[spec.ecosystem] ?? ALL_PARSERS;
  let parsed = parseOutput(outcome.output, root, parsers);
  if (!parsed.length && parsers !== ALL_PARSERS) {
    parsed = parseOutput(outcome.output, root);
  }
  if (input.worktreeMissingDeps && parsed.some(worktreeMissingModule)) {
    // Nothing to repair: the check is unverified in this worktree, not failed.
    parsed = parsed.filter((f) => !worktreeMissingModule(f));
    if (!parsed.length) {
      return [];
    }
  }
  if (!parsed.length) {
    const category = KIND_FALLBACK[spec.kind] ?? 'unknown';
    parsed = [make(category, { code: outcome.exitCode === null ? 'exit:null' : `exit:${outcome.exitCode}`, message: telling(outcome.output) || `${spec.id} failed`, evidence: tail(outcome.output) }, input.root)];
  }
  return dedupe(parsed.map((p) => finalise(p, source, input.root)));
}

const DIAG_HEADING = /^New (?:errors|problems)(?: after this edit)?(?: in (.+?))?:\s*$/;
const DIAG_ROW = /^\s*(\d+): (.*)$/;
const GET_DIAG = /^(.+?):(\d+):(\d+) \[Error\] (.*?)(?: \(([\w.-]+)\))?\s*$/;

function diagCategory(file: string | undefined, source?: string): FailureCategory {
  if (source) {
    return /^(?:ts|typescript|js)$/i.test(source) ? 'typescript' : /eslint|lint|ruff|flake8|pylint/i.test(source) ? 'lint' : 'compile';
  }
  return file && /\.[cm]?[jt]sx?$/.test(file) ? 'typescript' : 'compile';
}

/** `New errors after this edit:` / `New problems in x:` sections of edit results and `get_diagnostics` error rows. */
function parseDiagnosticsText(text: string, file: string | undefined, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  for (let i = 0; i < ls.length; i++) {
    const h = DIAG_HEADING.exec(ls[i].trim());
    if (h) {
      const where = h[1] ?? file;
      let j = i + 1;
      for (; j < ls.length; j++) {
        const r = DIAG_ROW.exec(ls[j]);
        if (!r) {
          break;
        }
        const code = /\b(TS\d{4,5})\b/.exec(r[2])?.[1];
        out.push(make(diagCategory(where), { code, message: r[2], file: where, line: Number(r[1]), evidence: `${ls[i].trim()}\n${ls[j]}` }, root));
      }
      i = j - 1;
      continue;
    }
    const g = GET_DIAG.exec(ls[i]);
    if (g) {
      out.push(make(diagCategory(g[1], g[5]), { message: g[4], file: g[1], line: Number(g[2]), column: Number(g[3]), code: /\b(TS\d{4,5})\b/.exec(g[4])?.[1], evidence: ls[i] }, root));
    }
  }
  return out;
}

const LOOP_MESSAGES: Record<string, string> = {
  identical_calls: 'The same tool call was repeated too often',
  mistake_limit: 'Too many consecutive mistakes',
  step_limit: 'Step limit reached',
  deadline: 'Task deadline reached',
};

/** Error Classifier (design §3.2): model errors, tool results, check output, diagnostics and loop stops -> failures. */
export function classify(input: ClassifyInput): Failure[] {
  switch (input.kind) {
    case 'model':
      return classifyModel(input);
    case 'tool':
      return classifyTool(input);
    case 'check':
      return classifyCheck(input);
    case 'diagnostics': {
      const root = input.root ?? '';
      return dedupe(parseDiagnosticsText(input.text, input.file, root).map((p) => finalise(p, { kind: 'diagnostics' }, input.root)));
    }
    case 'loop': {
      const p = make('loop', { code: `loop:${input.reason}`, message: input.message ?? LOOP_MESSAGES[input.reason] ?? input.reason, cls: defaultClass('loop'), severity: defaultSeverity('loop') }, input.root);
      return [finalise(p, { kind: 'loop' }, input.root)];
    }
  }
}

export interface FailureGroup {
  /** The failure to fix first (a compile error before the tests it breaks; else the most severe). */
  lead: Failure;
  failures: Failure[];
  /** Workspace-relative files of the group. */
  files: string[];
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const COMPILE_LIKE = new Set<FailureCategory>(['compile', 'typescript', 'build']);

/**
 * Groups failures with the same file and code; test failures whose innermost project frame is in a file with a
 * compile error join that compile error's group. Groups are ordered most severe first.
 */
export function groupFailures(failures: readonly Failure[], root?: string): FailureGroup[] {
  const groups = new Map<string, Failure[]>();
  const compileByFile = new Map<string, string>();
  const keyOf = (f: Failure) => (f.file ? `${relativePath(f.file, root)}|${f.code ?? f.category}` : `sig|${f.signature}`);
  for (const f of failures) {
    if (COMPILE_LIKE.has(f.category) && f.file) {
      const file = relativePath(f.file, root);
      if (!compileByFile.has(file)) {
        compileByFile.set(file, keyOf(f));
      }
    }
  }
  for (const f of failures) {
    let key = keyOf(f);
    if (f.category === 'unit_test' || f.category === 'integration_test') {
      const frame = topFrame(relativiseText(f.evidence, root), root);
      const hit = (frame && compileByFile.get(frame.file)) ?? (f.file ? compileByFile.get(relativePath(f.file, root)) : undefined);
      if (hit) {
        key = hit;
      }
    }
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const rank = (f: Failure) => (COMPILE_LIKE.has(f.category) ? 10 : 0) + SEVERITY_RANK[f.severity];
  return [...groups.values()]
    .map((list) => {
      const lead = [...list].sort((a, b) => rank(b) - rank(a))[0];
      const files = [...new Set(list.map((f) => (f.file ? relativePath(f.file, root) : '')).filter(Boolean))];
      return { lead, failures: list, files };
    })
    .sort((a, b) => rank(b.lead) - rank(a.lead));
}
