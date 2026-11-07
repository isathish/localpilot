import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { entropy, scanText } from '../../security/scan';
import type { Failure, FailureCategory, MemoryEntry } from './types';
import { FAILURE_CATEGORIES } from './types';
import { renameWithRetry } from './fsRetry';

/**
 * Recovery Memory (design §8): fixes that worked (and attempts that did not) keyed by failure signature, offered to
 * later fix prompts as suggestions only. The `project` file is shared through git, so it is untrusted prompt input:
 * nothing is read for a prompt unless `readable`, and every returned entry is sanitised. No direct vscode import.
 */

export type MemoryScope = 'workspace' | 'project' | 'off';

export const PROJECT_MEMORY_FILE = '.localpilot/recovery-memory.json';
export const MEMORY_CAP = 500;
export const PATCH_SUMMARY_MAX = 1536;
export const PROMPT_LINE_MAX = 200;
const SIMILARITY_MIN = 0.6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface FailureMemoryOptions {
  now?: () => number;
  log?: (msg: string) => void;
  cap?: number;
  /** False when the scope is `project` and the workspace is untrusted: nothing reaches a prompt. */
  readable?: boolean;
}

export interface MemoryRecordInput {
  rootCause: string;
  strategy: string;
  patchSummary?: string;
  files?: string[];
  success: boolean;
  validation?: { checks: string[]; passed: boolean; regressionClean: boolean };
  ecosystem: string;
  codeFingerprint?: string;
}

export type MemoryMatch = 'exact' | 'generic' | 'similar';

export interface MemorySuggestion {
  /** Sanitised copy, safe to render in a fix prompt. */
  entry: MemoryEntry;
  match: MemoryMatch;
  /** 1 for exact/generic, the token Jaccard for similar. */
  score: number;
  /** The code at the failure differs from when the fix was made (weak signal; still suggested). */
  codeChanged: boolean;
}

/** `<storage>/recovery/memory.json` (workspace), `.localpilot/recovery-memory.json` (project), or none. */
export function memoryPath(scope: MemoryScope, where: { storageDir?: string; root?: string }): string | undefined {
  if (scope === 'workspace') {
    return where.storageDir ? path.join(where.storageDir, 'recovery', 'memory.json') : undefined;
  }
  if (scope === 'project') {
    return where.root ? path.join(where.root, PROJECT_MEMORY_FILE) : undefined;
  }
  return undefined;
}

/** True for the memory file and anything under `.localpilot/`: excluded from changed-file and fingerprint scope. */
export function isMemoryPath(file: string, root?: string): boolean {
  let rel = file;
  if (root && path.isAbsolute(file)) {
    rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return false;
    }
  }
  rel = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return rel === '.localpilot' || rel.startsWith('.localpilot/');
}

// ---- Redaction ----

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/g,
];
const KEYED_ASSIGNMENT = /((?:[\w.-]*?)(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|credential)[\w.-]*["']?\s*[:=]\s*["'`]?)([^"'`\s,;)]{8,})/gi;
const ANY_ASSIGNMENT = /([:=]\s*["'`]?)([A-Za-z0-9+/_\-.]{24,}={0,2})/g;

const mixed = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);
const TOKEN = /[A-Za-z0-9+/_\-.=]{12,}/g;
const flagged = (line: string) => scanText('.env', line, { secrets: true, code: false }).length > 0;

/** A line the security scanner (security/scan.ts SECRET_RULES) still flags: random-looking tokens masked, else the whole line. */
function scrubLine(line: string): string {
  if (!flagged(line)) {
    return line;
  }
  const out = line.replace(TOKEN, (t) => (/\d/.test(t) || entropy(t) >= 3.3 ? '[REDACTED]' : t));
  return flagged(out) ? '[REDACTED]' : out;
}

/**
 * Masks well-known secret shapes (including multi-line private keys) and high-entropy assignments, then runs every
 * line through the scanner's secret rules so a rule added there also applies here.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(KEYED_ASSIGNMENT, (m, lead: string, value: string) =>
    value === '[REDACTED]' || /^(?:x+|\*+|<[^>]*>|\$\{.*\}|process\.env.*|os\.environ.*)$/i.test(value) || entropy(value) < 3 ? m : `${lead}[REDACTED]`,
  );
  out = out.replace(ANY_ASSIGNMENT, (m, lead: string, value: string) => (mixed(value) && entropy(value) >= 4.2 ? `${lead}[REDACTED]` : m));
  return out.split('\n').map(scrubLine).join('\n');
}

// ---- Sanitising for prompt use ----

const FENCE = /```+|~~~+/g;
const URL_RE = /\b(?:https?|ftp|file|data|javascript):\/?\/?\S+|\bwww\.\S+/gi;
const INSTRUCTION_RES: RegExp[] = [
  /\b(?:ignore|disregard|forget)\b/i,
  /\byou\s+(?:must|should|shall|will|need to|are now|have to)\b/i,
  /\b(?:system|assistant|user|developer|human|tool)\s*:/i,
  /\b(?:run|execute|exec|curl|wget|sudo|bash|sh|rm|chmod)\s+\S/i,
  /\b(?:run|execute)\s*[`'"]/i,
  /<\|[^|>]*\|>|\[\/?INST\]|<\/?(?:system|assistant|user)>/i,
  /\b(?:instructions?|prompt)\b.*\b(?:previous|prior|above|new|following)\b|\b(?:previous|prior|above|new|following)\b.*\binstructions?\b/i,
];

const instructionLike = (s: string) => INSTRUCTION_RES.some((re) => re.test(s));
// Soft hyphen, Mongolian vowel separator, zero-width, bidi and other format characters that hide words from the rules.
const INVISIBLE = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** One line, at most `max` chars, without fences, URLs or instruction-like sentences. */
export function sanitiseLine(text: string, max = PROMPT_LINE_MAX): string {
  const kept: string[] = [];
  let fenced = false;
  for (const line of String(text ?? '').normalize('NFKC').replace(INVISIBLE, '').split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    for (const raw of line.split(/(?<=[.!?;])\s+/)) {
      const seg = raw.replace(FENCE, '').replace(URL_RE, '').replace(/[\u0000-\u001f\u007f\u00a0\u2028\u2029]/g, ' ').trim();
      if (seg && !instructionLike(seg)) {
        kept.push(seg);
      }
    }
  }
  const one = kept.join(' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Diff excerpt without fences (rca renders it inside one fence), at most 1.5 KB. */
export function sanitisePatch(text: string, max = PATCH_SUMMARY_MAX): string {
  const body = String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(?:```|~~~)/.test(l))
    .map((l) => l.replace(FENCE, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''))
    .join('\n')
    .trim();
  return clampBytes(body, max);
}

function clampBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) {
    return s;
  }
  let cut = s.slice(0, max);
  while (Buffer.byteLength(cut, 'utf8') > max - 4) {
    cut = cut.slice(0, -1);
  }
  const nl = cut.lastIndexOf('\n');
  return `${nl > max / 2 ? cut.slice(0, nl) : cut}\n…`;
}

/** A copy of `entry` that is safe to put in a fix prompt. */
export function sanitiseForPrompt(entry: MemoryEntry): MemoryEntry {
  return {
    ...entry,
    code: entry.code && /^[\w:.\-/@]{1,40}$/.test(entry.code) ? entry.code : undefined,
    messageNorm: sanitiseLine(entry.messageNorm, 300),
    rootCause: sanitiseLine(entry.rootCause),
    strategy: sanitiseLine(entry.strategy),
    patchSummary: sanitisePatch(entry.patchSummary),
    files: entry.files.filter((f) => typeof f === 'string' && /^[\w@./+\- ]{1,200}$/.test(f) && !f.includes('..')).slice(0, 10),
    ecosystem: /^[\w-]{1,20}$/.test(entry.ecosystem) ? entry.ecosystem : 'unknown',
    validation: { ...entry.validation, checks: entry.validation.checks.map((c) => sanitiseLine(c, 60)).filter(Boolean).slice(0, 10) },
  };
}

// ---- Matching ----

/** Lowercased message with paths, quoted literals and numbers abstracted. */
export function normaliseMessage(message: string): string {
  return String(message ?? '')
    .toLowerCase()
    .replace(/(?:[a-z]:)?(?:[\w.@-]*[\\/])+[\w.@-]+/g, '<path>')
    .replace(/\b0x[0-9a-f]+\b/g, '<n>')
    .replace(/\b\d+(?:\.\d+)*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/[^a-z0-9_<>]+/).filter((t) => t.length >= 2));
}

export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) {
    return 0;
  }
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) {
      inter++;
    }
  }
  return inter / (ta.size + tb.size - inter);
}

const TIER: Record<MemoryMatch, number> = { exact: 0, generic: 1, similar: 2 };
const recency = (e: MemoryEntry) => e.lastUsedAt ?? e.lastValidatedAt ?? e.createdAt;

// ---- Store ----

interface MemoryFile {
  version: 1;
  entries: MemoryEntry[];
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Coerces one stored entry; undefined when it is unusable. */
function coerce(raw: unknown): MemoryEntry | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const category = r.category as FailureCategory;
  if (typeof r.id !== 'string' || !r.id || typeof r.generic !== 'string' || !(FAILURE_CATEGORIES as readonly string[]).includes(category)) {
    return undefined;
  }
  const v = (r.validation && typeof r.validation === 'object' ? r.validation : {}) as Record<string, unknown>;
  return {
    id: r.id.slice(0, 64),
    signature: str(r.signature, 500),
    generic: str(r.generic, 500),
    category,
    code: typeof r.code === 'string' && r.code ? r.code.slice(0, 80) : undefined,
    messageNorm: str(r.messageNorm, 300),
    rootCause: str(r.rootCause, 2000),
    strategy: str(r.strategy, 500),
    patchSummary: str(r.patchSummary, PATCH_SUMMARY_MAX * 2),
    files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string').slice(0, 50) : [],
    success: r.success === true,
    validation: {
      checks: Array.isArray(v.checks) ? v.checks.filter((c): c is string => typeof c === 'string').slice(0, 20) : [],
      passed: v.passed === true,
      regressionClean: v.regressionClean === true,
    },
    reuseAllowed: r.reuseAllowed !== false,
    uses: num(r.uses),
    successes: num(r.successes),
    failures: num(r.failures),
    createdAt: optNum(r.createdAt) ?? 0,
    lastUsedAt: optNum(r.lastUsedAt),
    lastValidatedAt: optNum(r.lastValidatedAt),
    ecosystem: str(r.ecosystem, 40) || 'unknown',
    codeFingerprint: typeof r.codeFingerprint === 'string' && r.codeFingerprint ? r.codeFingerprint.slice(0, 80) : undefined,
  };
}

/**
 * Listeners told about every recorded fix outcome (1.7: continuity keeps the fixes that worked as `agent` memory
 * items, "what fixed which failure category"). Module-level because each workspace root has its own FailureMemory.
 */
export const failureMemoryListeners = new Set<(entry: MemoryEntry) => void>();

export class FailureMemory {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly cap: number;
  private readonly readable: boolean;
  private chain: Promise<unknown> = Promise.resolve();
  private cache: { key: string; entries: MemoryEntry[]; unreadable: boolean } | undefined;
  /** The file exists but could not be parsed (merge conflict, truncation) or is over the size cap: never overwrite it as-is. */
  private unreadable = false;

  constructor(readonly file: string | undefined, opts: FailureMemoryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.cap = Math.max(1, Math.floor(opts.cap ?? MEMORY_CAP));
    this.readable = opts.readable !== false;
  }

  get enabled(): boolean {
    return !!this.file;
  }

  /** Stores the outcome of a fix attempt; merges into an entry with the same generic signature, ecosystem, outcome and strategy. */
  async record(failure: Failure, input: MemoryRecordInput): Promise<MemoryEntry | undefined> {
    const entry = await this.recordEntry(failure, input);
    if (entry) {
      for (const l of failureMemoryListeners) {
        try {
          l(entry);
        } catch {
          // a listener's failure is its own
        }
      }
    }
    return entry;
  }

  private async recordEntry(failure: Failure, input: MemoryRecordInput): Promise<MemoryEntry | undefined> {
    if (!this.file) {
      return undefined;
    }
    // Design §8: a success only when the fix held and validation (including the regression check) passed.
    const ok = input.success && (!input.validation || (input.validation.passed && input.validation.regressionClean));
    return this.mutate((entries) => {
      const now = this.now();
      const strategy = redactSecrets(input.strategy).trim().slice(0, 500);
      const fields = {
        signature: failure.signature,
        rootCause: redactSecrets(input.rootCause).trim().slice(0, 2000),
        patchSummary: clampBytes(redactSecrets(input.patchSummary ?? '').trim(), PATCH_SUMMARY_MAX),
        files: (input.files ?? []).map((f) => f.replace(/\\/g, '/')).filter((f) => !isMemoryPath(f)).slice(0, 50),
        validation: input.validation ?? { checks: [], passed: ok, regressionClean: ok },
        codeFingerprint: input.codeFingerprint,
      };
      const same = entries.find(
        (e) => e.generic === failure.generic && e.ecosystem === input.ecosystem && e.success === ok && e.strategy.toLowerCase() === strategy.toLowerCase(),
      );
      if (same) {
        Object.assign(same, fields);
        if (ok) {
          same.successes++;
          same.lastValidatedAt = now;
        } else {
          same.failures++;
        }
        same.lastUsedAt = now;
        return { ...same };
      }
      const entry: MemoryEntry = {
        id: `mem_${crypto.randomBytes(6).toString('hex')}`,
        generic: failure.generic,
        category: failure.category,
        code: failure.code,
        messageNorm: redactSecrets(normaliseMessage(failure.message)),
        strategy,
        success: ok,
        reuseAllowed: true,
        uses: 0,
        successes: ok ? 1 : 0,
        failures: ok ? 0 : 1,
        createdAt: now,
        lastUsedAt: now,
        lastValidatedAt: ok ? now : undefined,
        ecosystem: input.ecosystem,
        ...fields,
      };
      entries.push(entry);
      return { ...entry };
    });
  }

  /** Successful, reusable fixes for `failure`, sanitised; [] when the store is unreadable. */
  async suggest(failure: Failure, ecosystem: string, limit = 2, currentFingerprint?: string): Promise<MemorySuggestion[]> {
    if (!this.file || !this.readable || limit <= 0) {
      return [];
    }
    return this.match(await this.load(), failure, ecosystem, (e) => e.success && e.reuseAllowed)
      .sort(
        (a, b) =>
          TIER[a.match] - TIER[b.match] ||
          b.score - a.score ||
          b.entry.successes - b.entry.failures - (a.entry.successes - a.entry.failures) ||
          recency(b.entry) - recency(a.entry),
      )
      .slice(0, limit)
      .map((s) => ({
        ...s,
        entry: sanitiseForPrompt(s.entry),
        codeChanged: !!currentFingerprint && !!s.entry.codeFingerprint && s.entry.codeFingerprint !== currentFingerprint,
      }));
  }

  /** Recorded attempts that did not work for `failure` (exact or generic match), sanitised, newest first. */
  async failedAttempts(failure: Failure, ecosystem: string, limit = 2): Promise<MemoryEntry[]> {
    if (!this.file || !this.readable || limit <= 0) {
      return [];
    }
    return this.match(await this.load(), failure, ecosystem, (e) => !e.success)
      .filter((s) => s.match !== 'similar')
      .sort((a, b) => recency(b.entry) - recency(a.entry))
      .slice(0, limit)
      .map((s) => sanitiseForPrompt(s.entry));
  }

  /** Revalidation: the outcome of an attempt that used suggestion `id`. */
  async markOutcome(id: string, success: boolean): Promise<MemoryEntry | undefined> {
    if (!this.file) {
      return undefined;
    }
    return this.mutate((entries) => {
      const e = entries.find((x) => x.id === id);
      if (!e) {
        return undefined;
      }
      const now = this.now();
      e.uses++;
      e.lastUsedAt = now;
      if (success) {
        e.successes++;
        e.lastValidatedAt = now;
      } else {
        e.failures++;
        if (e.failures >= 2 && e.failures > e.successes) {
          e.reuseAllowed = false;
        }
      }
      return { ...e };
    });
  }

  /** Dashboard "Don't suggest again" (and its undo). */
  async setReuse(id: string, allowed: boolean): Promise<boolean> {
    if (!this.file) {
      return false;
    }
    return this.mutate((entries) => {
      const e = entries.find((x) => x.id === id);
      if (e) {
        e.reuseAllowed = allowed;
      }
      return !!e;
    });
  }

  async remove(id: string): Promise<boolean> {
    if (!this.file) {
      return false;
    }
    return this.mutate((entries) => {
      const i = entries.findIndex((x) => x.id === id);
      if (i >= 0) {
        entries.splice(i, 1);
      }
      return i >= 0;
    });
  }

  /** All entries (raw, for the Dashboard), most recently used first. */
  async list(): Promise<MemoryEntry[]> {
    if (!this.file) {
      return [];
    }
    return (await this.load()).map((e) => ({ ...e })).sort((a, b) => recency(b) - recency(a));
  }

  private match(entries: MemoryEntry[], failure: Failure, ecosystem: string, keep: (e: MemoryEntry) => boolean): MemorySuggestion[] {
    const norm = normaliseMessage(failure.message);
    const out: MemorySuggestion[] = [];
    for (const e of entries) {
      if (!keep(e)) {
        continue;
      }
      if (failure.signature && e.signature === failure.signature) {
        out.push({ entry: e, match: 'exact', score: 1, codeChanged: false });
      } else if (failure.generic && e.generic === failure.generic && e.ecosystem === ecosystem) {
        out.push({ entry: e, match: 'generic', score: 1, codeChanged: false });
      } else if (e.ecosystem === ecosystem && e.category === failure.category && (e.code ?? '') === (failure.code ?? '')) {
        const score = jaccard(norm, e.messageNorm);
        if (score >= SIMILARITY_MIN) {
          out.push({ entry: e, match: 'similar', score, codeChanged: false });
        }
      }
    }
    return out;
  }

  private async load(): Promise<MemoryEntry[]> {
    const file = this.file as string;
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch (e) {
      this.cache = undefined;
      this.unreadable = (e as NodeJS.ErrnoException).code !== 'ENOENT';
      return [];
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (this.cache?.key === key) {
      this.unreadable = this.cache.unreadable;
      return this.cache.entries;
    }
    let entries: MemoryEntry[] = [];
    let unreadable = false;
    if (stat.size > MAX_FILE_BYTES) {
      unreadable = true;
      this.log(`failure memory: ${file} is larger than ${MAX_FILE_BYTES} bytes; ignored`);
    } else {
      try {
        const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
        const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : undefined;
        if (!Array.isArray(list)) {
          throw new Error('no entries list');
        }
        const seen = new Set<string>();
        entries = list.map(coerce).filter((e): e is MemoryEntry => {
          if (!e || seen.has(e.id)) {
            return false;
          }
          seen.add(e.id);
          return true;
        });
      } catch (e) {
        unreadable = true;
        this.log(`failure memory: cannot read ${file}: ${(e as Error).message}`);
      }
    }
    this.unreadable = unreadable;
    this.cache = { key, entries, unreadable };
    return entries;
  }

  /** Read-modify-write, serialised within the process; the file is replaced atomically. */
  private mutate<T>(fn: (entries: MemoryEntry[]) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const entries = (await this.load()).map((e) => ({ ...e }));
      if (this.unreadable) {
        await this.backupUnreadable();
      }
      const result = fn(entries);
      this.evict(entries);
      await this.write(entries);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Moves an unparseable or oversized store aside (`<file>.corrupt-<time>`) so a write never silently replaces it. */
  private async backupUnreadable(): Promise<void> {
    const file = this.file as string;
    let backup = `${file}.corrupt-${this.now()}`;
    if (await fsp.stat(backup).then(() => true, () => false)) {
      backup += `-${crypto.randomBytes(3).toString('hex')}`;
    }
    await fsp.rename(file, backup);
    this.unreadable = false;
    this.cache = undefined;
    this.log(`failure memory: ${file} could not be read; kept it as ${backup} and started a new store`);
  }

  private evict(entries: MemoryEntry[]): void {
    if (entries.length <= this.cap) {
      return;
    }
    const drop = new Set(
      [...entries]
        .sort((a, b) => recency(a) - recency(b))
        .slice(0, entries.length - this.cap)
        .map((e) => e.id),
    );
    for (let i = entries.length - 1; i >= 0; i--) {
      if (drop.has(entries[i].id)) {
        entries.splice(i, 1);
      }
    }
  }

  private async write(entries: MemoryEntry[]): Promise<void> {
    const file = this.file as string;
    const data: MemoryFile = { version: 1, entries };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await renameWithRetry(tmp, file);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    this.cache = undefined;
  }
}
