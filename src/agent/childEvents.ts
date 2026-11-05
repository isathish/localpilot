import * as path from 'path';
import type { AgentEvent, ToolContext } from '../types';

/**
 * Helpers for reading a subagent's own events. Events a child forwards to its parent are wrapped by `subagents.ts` as
 * `{ type, payload: { childId, agent, inner, data } }`, so a nested child's fields (tool `origin`, `recovery`) sit under
 * `payload.data`, while the child's own events carry them on `payload` directly. Both shapes are read here.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);

/** The `origin` of a tool event, from the child's own payload or a wrapped grandchild's `payload.data`. */
export function childEventOrigin(e: AgentEvent): string | undefined {
  const p = obj(e.payload);
  const origin = p?.origin ?? obj(p?.data)?.origin;
  return typeof origin === 'string' ? origin : undefined;
}

/** True for a successful mutating tool call the child itself chose (engine-run verification commands do not count). */
export function childMutated(e: AgentEvent, mutating: ReadonlySet<string>): boolean {
  if (e.type !== 'tool_end' || childEventOrigin(e) === 'healing') {
    return false;
  }
  const p = obj(e.payload);
  return typeof p?.name === 'string' && !p.isError && mutating.has(p.name);
}

/**
 * Set by the agent loop only on the context of the engine's own synthetic `run_parallel_subagents` call
 * (`meta.synthetic === 'healing'`). A task's `origin: 'healing'` is honoured only then: a model cannot start a fixer worker.
 */
export type HealingSyntheticContext = ToolContext & { healingSynthetic?: true };

export const isHealingSynthetic = (ctx: ToolContext): boolean => (ctx as HealingSyntheticContext).healingSynthetic === true;

/** Tools whose successful call wrote, edited or deleted files. */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'delete_path', 'notebook_edit']);
/** Delegating tools: their result `data.writtenFiles` lists what their own children wrote. */
const DELEGATE_TOOLS = new Set(['run_subagent', 'run_parallel_subagents', 'run_todos_parallel']);

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/**
 * Collects the files a child run wrote from its own `tool_start`/`tool_end` events, so the parent can report them
 * (`subagent_end.payload.writtenFiles`) and the root session's healing engine can hash and roll them back.
 * Paths come from the tool result (`data.path`/`data.paths`, absolute), else from the call's `path` argument.
 */
export class ChildWrites {
  private readonly args = new Map<string, Obj>();
  private readonly files = new Set<string>();

  constructor(private readonly root?: string) {}

  note(e: AgentEvent): void {
    const p = obj(e.payload);
    if (!p || p.inner !== undefined || typeof p.name !== 'string') {
      return;
    }
    const id = typeof p.id === 'string' ? p.id : undefined;
    if (e.type === 'tool_start') {
      if (id && (WRITE_TOOLS.has(p.name) || DELEGATE_TOOLS.has(p.name))) {
        this.args.set(id, obj(p.args) ?? {});
      }
      return;
    }
    if (e.type !== 'tool_end') {
      return;
    }
    const args = id ? this.args.get(id) : undefined;
    if (id) {
      this.args.delete(id);
    }
    const data = obj(p.data);
    if (DELEGATE_TOOLS.has(p.name)) {
      this.add(strs(data?.writtenFiles));
      return;
    }
    if (p.isError || !WRITE_TOOLS.has(p.name) || p.origin === 'healing') {
      return;
    }
    const fromData = [...strs([data?.path]), ...strs(data?.paths)];
    this.add(fromData.length ? fromData : strs([args?.path]));
  }

  add(paths: readonly string[]): void {
    for (const f of paths) {
      this.files.add(path.isAbsolute(f) || !this.root ? f : path.resolve(this.root, f));
    }
  }

  list(): string[] {
    return [...this.files];
  }
}

/** The optional `recovery` object of a child's `turn_end` payload. */
export function childRecovery(payload: unknown): Obj | undefined {
  const p = obj(payload);
  return obj(p?.recovery) ?? obj(obj(p?.data)?.recovery);
}

const failureText = (f: unknown): string => {
  if (typeof f === 'string') {
    return f;
  }
  const o = obj(f);
  if (!o) {
    return '';
  }
  const where = typeof o.file === 'string' ? `${o.file}${typeof o.line === 'number' ? `:${o.line}` : ''}` : typeof o.test === 'string' ? o.test : '';
  const head = [o.code, o.title, o.key, o.message].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  return [head, where && !head?.includes(where) ? `(${where})` : ''].filter(Boolean).join(' ');
};

/** One "Verification: …" line summarising a worker's recovery object, or undefined when there is nothing to say. */
export function verificationLine(recovery: Obj | undefined): string | undefined {
  if (!recovery) {
    return undefined;
  }
  if (typeof recovery.healthy === 'boolean') {
    const failures = Array.isArray(recovery.failures) ? recovery.failures : [];
    if (recovery.healthy && !failures.length) {
      return 'Verification: scoped checks pass.';
    }
    const shown = failures.map(failureText).filter(Boolean).slice(0, 3);
    const more = failures.length > shown.length ? ` (+${failures.length - shown.length} more)` : '';
    const n = failures.length;
    return `Verification: ${n ? `${n} failure${n === 1 ? '' : 's'} remain${n === 1 ? 's' : ''}` : 'checks still failing'}${shown.length ? `: ${shown.join('; ')}${more}` : ''}.`;
  }
  const report = typeof recovery.report === 'string' ? recovery.report.trim() : '';
  if (report) {
    return `Verification: ${report.replace(/^Verification:\s*/i, '')}`;
  }
  return typeof recovery.outcome === 'string' && recovery.outcome ? `Verification: ${recovery.outcome.replace(/_/g, ' ')}.` : undefined;
}
