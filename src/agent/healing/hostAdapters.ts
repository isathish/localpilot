import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { RepoGraph } from '../../context/repoGraph';
import { scanText, scanWorkspace, type Finding, type ScanOptions, type ScanResult } from '../../security/scan';
import type { RepoGraphView } from './engine';
import { FailureMemory, isMemoryPath, memoryPath, type MemoryScope } from './failureMemory';
import { exactSignature, genericSignature } from './signature';
import type { Failure, ResumeInfo } from './types';

/**
 * Host-side adapters behind `HealingServiceOptions` (design §1): the security stage over changed files, dependency
 * advisories, the repo graph view, the provider probe, the last-writer lookup and the per-root failure memory.
 * No VS Code imports, so the extension and the CLI can share them.
 */

const BLOCKING = new Set<Finding['severity']>(['high', 'critical']);
const MAX_SCAN_BYTES = 1_000_000;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp[34]|mov|wasm|so|dylib|dll|exe|bin|vsix|lock)$/i;

const rel = (root: string, file: string): string | undefined => {
  const r = (path.isAbsolute(file) ? path.relative(root, file) : file).split(path.sep).join('/').replace(/^(\.\/)+/, '');
  return !r || r === '..' || r.startsWith('../') || path.isAbsolute(r) ? undefined : r;
};

/** High and critical findings as `security` failures (policy class: never waived by the model). */
export function findingsToFailures(findings: readonly Finding[], root: string, checkId = 'security'): Failure[] {
  const out = new Map<string, Failure>();
  for (const f of findings) {
    if (!BLOCKING.has(f.severity)) {
      continue;
    }
    const file = f.file ? rel(root, f.file) ?? f.file : undefined;
    const where = file ? `${file}${f.line ? `:${f.line}` : ''}` : '';
    const message = (f.package ? `${f.package.name}: ${f.title}` : f.title).replace(/\s+/g, ' ').slice(0, 300);
    const base = {
      category: 'security' as const,
      cls: 'policy' as const,
      severity: f.severity,
      code: f.id,
      message,
      ...(file ? { file } : {}),
      ...(f.line ? { line: f.line } : {}),
      ...(f.package ? { symbol: f.package.name } : {}),
    };
    const pkg = f.package ? `${f.package.name}@${f.package.version} (${f.package.ecosystem}) ` : '';
    const evidence = `[${f.severity}] ${pkg}${f.title}${where ? ` — ${where}` : ''} (${f.id})${f.fix ? `. Fix: ${f.fix}` : ''}`.slice(0, 2048);
    const signature = exactSignature(base, root);
    if (!out.has(signature)) {
      out.set(signature, { ...base, id: randomUUID(), evidence, source: { kind: 'check', checkId }, signature, generic: genericSignature(base, root) });
    }
  }
  return [...out.values()];
}

/** `securityScan`: the offline secret and risky-code rules of `security/scan.ts` over the changed files only. */
export function changedFilesScan(read: (fsPath: string) => Promise<string | undefined> = readText): (root: string, files: string[], signal: AbortSignal) => Promise<Failure[]> {
  return async (root, files, signal) => {
    const findings: Finding[] = [];
    for (const f of new Set(files.map((x) => rel(root, x)).filter((x): x is string => !!x))) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      }
      if (BINARY.test(f) || /\.min\.(js|css)$/.test(f) || isMemoryPath(f) || f.split('/').includes('node_modules')) {
        continue;
      }
      const text = await read(path.join(root, f));
      if (text === undefined || text.includes('\0')) {
        continue;
      }
      findings.push(...scanText(f, text, { secrets: true, code: true }));
    }
    return findingsToFailures(findings, root);
  };
}

async function readText(fsPath: string): Promise<string | undefined> {
  try {
    const st = await fs.promises.stat(fsPath);
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) {
      return undefined;
    }
    return (await fs.promises.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

/**
 * `dependencyScan` (`securityCheck: 'full'`): lockfile advisories from OSV.dev, only after `approve` (the network
 * approval) said yes; declined or unreachable means no findings rather than a failure the model could not fix.
 */
export function osvDependencyScan(
  approve: (root: string, signal: AbortSignal) => Promise<boolean>,
  opts: { scan?: (root: string, o: ScanOptions) => Promise<ScanResult>; log?: (msg: string) => void } = {}
): (root: string, signal: AbortSignal) => Promise<Failure[]> {
  const scan = opts.scan ?? scanWorkspace;
  return async (root, signal) => {
    if (!(await approve(root, signal))) {
      return [];
    }
    const r = await scan(root, { kinds: { dependencies: true, secrets: false, code: false }, signal });
    for (const s of r.skipped) {
      opts.log?.(`Self-healing dependency check: ${s}`);
    }
    return findingsToFailures(r.findings.filter((f) => f.kind === 'dependency'), root);
  };
}

/** The engine's view of a `buildRepoGraph` result: importers + imports, and direct import edges. */
export function repoGraphView(g: Pick<RepoGraph, 'root' | 'deps' | 'rdeps'>): RepoGraphView {
  const key = (f: string) => rel(g.root, f) ?? f.split(path.sep).join('/');
  return {
    neighbours: (file) => {
      const k = key(file);
      return [...new Set([...(g.rdeps.get(k) ?? []), ...(g.deps.get(k) ?? [])])].filter((x) => x !== k);
    },
    importEdge: (a, b) => !!g.deps.get(key(a))?.has(key(b)),
  };
}

export interface ProbeTarget {
  healthCheck(signal?: AbortSignal): Promise<boolean>;
}

/** `probe`: the provider behind a model ref (`provider/model`) or provider id answers its health check. Unknown = true. */
export function providerProbe(lookup: (id: string) => ProbeTarget | undefined | Promise<ProbeTarget | undefined>): (target: string, signal?: AbortSignal) => Promise<boolean> {
  return async (target, signal) => {
    const slash = target.indexOf('/');
    const ids = slash > 0 ? [target, target.slice(0, slash)] : [target];
    for (const id of ids) {
      const p = await Promise.resolve(lookup(id)).catch(() => undefined);
      if (p) {
        return p.healthCheck(signal).catch(() => false);
      }
    }
    return true;
  };
}

/** `foreignWriter`: the live session that most recently started changing `fsPath` (tracked changes of running chats). */
export function lastWriter(
  changes: readonly { sessionId: string; fsPath: string; changedAt: number }[],
  live: ReadonlySet<string>,
  fsPath: string,
  same: (a: string, b: string) => boolean = (a, b) => path.resolve(a) === path.resolve(b)
): string | undefined {
  let best: { sessionId: string; changedAt: number } | undefined;
  for (const c of changes) {
    if (live.has(c.sessionId) && same(c.fsPath, fsPath) && (!best || c.changedAt > best.changedAt)) {
      best = c;
    }
  }
  return best?.sessionId;
}

/**
 * `memory(root)`: one FailureMemory per file and readability. The `project` file is prompt input written by others,
 * so it is readable only in a trusted workspace (design §8).
 */
export function memoryResolver(o: { scope: () => MemoryScope; storageDir: string; trusted: () => boolean; log?: (msg: string) => void }): (root: string) => FailureMemory | undefined {
  const cache = new Map<string, FailureMemory>();
  return (root) => {
    const scope = o.scope();
    const file = memoryPath(scope, { storageDir: o.storageDir, root });
    if (!file) {
      return undefined;
    }
    const readable = scope !== 'project' || o.trusted();
    const key = `${file}|${readable}`;
    let m = cache.get(key);
    if (!m) {
      m = new FailureMemory(file, { readable, log: o.log });
      cache.set(key, m);
    }
    return m;
  };
}

/** The pre-attempt snapshot of `file` (workspace-relative) in an attempt folder; `null` = the file did not exist. */
export async function readAttemptSnapshot(attemptDir: string, file: string): Promise<{ text: string; binary: boolean } | null | undefined> {
  const r = file.split(path.sep).join('/');
  try {
    const p = JSON.parse(await fs.promises.readFile(path.join(attemptDir, `${createHash('sha1').update(r).digest('hex')}.json`), 'utf8')) as { v?: number; file?: string; existed?: boolean; content?: string; base64?: boolean };
    if (p.v !== 1 || p.file !== r) {
      return undefined;
    }
    return p.existed && typeof p.content === 'string' ? { text: p.base64 ? '' : p.content, binary: !!p.base64 } : null;
  } catch {
    return undefined;
  }
}

/** The interrupted recoveries the user should hear about: those the task queue does not already resume on its own. */
export function interruptedNotice(interrupted: readonly (ResumeInfo & { sid: string })[], resumedByQueue: ReadonlySet<string>): { text: string; sids: string[] } | undefined {
  const open = interrupted.filter((i) => !resumedByQueue.has(i.sid));
  if (!open.length) {
    return undefined;
  }
  const one = open.length === 1 ? open[0] : undefined;
  const text = one
    ? `LocalPilot: a self-healing recovery was interrupted when the window closed (attempt ${one.attempt}/${one.max}${one.category ? `, ${one.category.replace(/_/g, ' ')}` : ''}). Resume it to re-run the checks and continue.`
    : `LocalPilot: ${open.length} self-healing recoveries were interrupted when the window closed. Resume them to re-run the checks and continue.`;
  return { text, sids: open.map((i) => i.sid) };
}
