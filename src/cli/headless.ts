import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IMAGE_EXT } from '../ui/images';
import { ProviderConfig } from '../types';
import { FinishReason } from './ndjson';

/**
 * Exit codes of one-shot runs: 0 done, 1 the run ended with an error, 3 the mistake limit, 4 incomplete (the quality
 * gate found unresolved failures, or `--require-verified` and the work could not be verified), 5 blocked (needs an
 * approval, credentials or a decision), 124 timeout, 130 stopped.
 */
export const EXIT = { ok: 0, error: 1, mistakeLimit: 3, incomplete: 4, blocked: 5, timeout: 124, aborted: 130 } as const;

/** `--help` lines for the outcome exit codes and `--require-verified`. */
export const REQUIRE_VERIFIED_HELP = '  --require-verified           exit 4 when the work is done but could not be verified (checks skipped or missing)';
export const EXIT_CODES_HELP = 'Exit codes: 0 done, 1 error, 3 mistake limit, 4 incomplete, 5 blocked (needs input), 124 timeout, 130 stopped.';

/** `--yolo`: the tools a scripted run gets (apply_patch too, since GPT-style models edit with it instead of edit_file). */
export const YOLO_TOOLS = ['read_file', 'edit_file', 'apply_patch', 'write_file', 'run_command', 'grep_search', 'file_search', 'list_dir'];

export interface RunOutcome {
  /** Ctrl+C or a stop request. */
  aborted?: boolean;
  timedOut?: boolean;
  /** The run gave up: its error message (model unreachable, mistake limit, output cut-offs…). */
  error?: string;
  /** `mistake_limit` when the consecutive-mistake limit stopped it. */
  errorKind?: string;
  /** False when it stopped at the step limit. */
  completed?: boolean;
  /** The quality gate's verdict (`completed`, `completed_unverified`, `incomplete`, `blocked`, `failed`, `cancelled`). */
  outcome?: string;
  /** `--require-verified`: `completed_unverified` counts as incomplete. */
  requireVerified?: boolean;
}

export function exitCodeFor(o: RunOutcome): number {
  if (o.timedOut) {
    return EXIT.timeout;
  }
  if (o.aborted) {
    return EXIT.aborted;
  }
  if (o.errorKind === 'mistake_limit') {
    return EXIT.mistakeLimit;
  }
  if (o.outcome === 'blocked') {
    return EXIT.blocked;
  }
  if (o.outcome === 'incomplete' || (o.outcome === 'completed_unverified' && o.requireVerified)) {
    return EXIT.incomplete;
  }
  if (o.outcome === 'failed') {
    return EXIT.error;
  }
  if (o.outcome === 'cancelled') {
    return EXIT.aborted;
  }
  return o.error ? EXIT.error : EXIT.ok;
}

export function finishReasonFor(o: RunOutcome): FinishReason {
  if (o.timedOut) {
    return 'timeout';
  }
  if (o.aborted) {
    return 'aborted';
  }
  if (o.errorKind === 'mistake_limit') {
    return 'mistake_limit';
  }
  if (o.outcome === 'blocked') {
    return 'blocked';
  }
  if (o.outcome === 'incomplete' || (o.outcome === 'completed_unverified' && o.requireVerified)) {
    return 'incomplete';
  }
  if (o.outcome === 'failed') {
    return 'error';
  }
  if (o.outcome === 'cancelled') {
    return 'aborted';
  }
  if (o.error) {
    return 'error';
  }
  return o.completed === false ? 'max_steps' : 'completed';
}

/** `--timeout 90`, `90s`, `5m`, `1h` → milliseconds; undefined when it is not a positive duration. */
export function parseDuration(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!m) {
    return undefined;
  }
  const n = Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's').toLowerCase() as 'ms' | 's' | 'm' | 'h']);
  return n > 0 ? Math.round(n) : undefined;
}

/** `-s "text"` or `-s @file.md` (relative to `cwd`) → the text; throws when the file cannot be read. */
export function readSystemArg(value: string, cwd: string): string {
  if (!value.startsWith('@')) {
    return value;
  }
  const file = value.slice(1).replace(/^~(?=\/|\\|$)/, os.homedir());
  return fs.readFileSync(path.resolve(cwd, file), 'utf8');
}

/** The prompt with piped input added as context (`cmd | localpilot "review this"`). */
export function withStdin(prompt: string, input: string): string {
  return input ? `${prompt}\n\n<stdin>\n${input}\n</stdin>` : prompt;
}

/**
 * `@path` tokens that name an existing file or folder (relative to `root`, absolute or `~/…`; `path#L10-L20` for a
 * range): images go with the message, other files are attached like `-f`. Other `@words` are left alone.
 */
export function atRefs(text: string, root: string, exists: (p: string) => boolean = fs.existsSync): { files: string[]; images: string[] } {
  const files: string[] = [];
  const images: string[] = [];
  // `#codebase` (or `@codebase` when no such file exists): the whole-project overview, as in the chat.
  if (/(?:^|\s)[#@]codebase(?![\w./-])/.test(text) && !exists(path.resolve(root, 'codebase'))) {
    files.push('codebase');
  }
  // `#memory:<name>`, `#context:<set>`, `#chat:<title or id>` (1.7), resolved by the memory and context modules.
  for (const m of text.matchAll(/(?:^|\s)#(memory|context|chat):([\w.-]+)/g)) {
    const ref = `${m[1]}:${m[2].replace(/[.]+$/, '')}`;
    if (!files.includes(ref)) {
      files.push(ref);
    }
  }
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const ref = m[1].replace(/[.,;:!?)\]]+$/, '');
    const bare = ref.replace(/#L?\d+(?:-L?\d+)?$/i, '');
    if (!bare) {
      continue;
    }
    const abs = bare.startsWith('~/') ? path.join(os.homedir(), bare.slice(2)) : path.resolve(root, bare);
    if (!exists(abs)) {
      continue;
    }
    if (IMAGE_EXT.test(bare) && bare === ref) {
      if (!images.includes(abs)) {
        images.push(abs);
      }
    } else {
      const att = bare === ref ? abs : `${abs}${ref.slice(bare.length)}`;
      if (!files.includes(att)) {
        files.push(att);
      }
    }
  }
  return { files, images };
}

/**
 * `-P <id> [-k <key>]`: the provider list for this run with `id` usable — a configured provider, or a preset added for
 * this run only — and the key, when given, referenced as a secret that lives only in this process.
 */
export function runProviderList(list: readonly ProviderConfig[], id: string, preset: ProviderConfig | undefined, keyRef?: string): { list: ProviderConfig[]; error?: string } {
  const found = list.find((p) => p.id === id);
  if (!found && !preset) {
    return { list: [...list], error: `no provider "${id}" — localpilot providers lists them, localpilot providers presets shows what -P accepts` };
  }
  const base: ProviderConfig = { ...(found ?? preset!), id, enabled: true, ...(keyRef ? { apiKey: keyRef } : {}) };
  return { list: found ? list.map((p) => (p.id === id ? base : p)) : [...list, base] };
}
