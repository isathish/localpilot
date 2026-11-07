// The index's RPC surface, shared by the worker and the in-process client (tests, fallback). Only these methods are
// callable; arguments are structured-cloned data.
import type { IndexEngine } from './engine';

export const INDEX_METHODS = ['status', 'history', 'counts', 'search', 'searchMemory', 'conversation', 'messages', 'branches', 'memory', 'versions', 'query', 'rebuild', 'catchUp', 'persist', 'pruneVersions', 'syncEvent', 'enforceCap', 'dispose'] as const;
export type IndexMethod = (typeof INDEX_METHODS)[number];

export function dispatch(engine: IndexEngine, method: string, args: unknown[]): unknown {
  if (!(INDEX_METHODS as readonly string[]).includes(method)) {
    throw new Error(`unknown index method ${method}`);
  }
  const m = method as IndexMethod;
  switch (m) {
    case 'persist':
      return engine.persist(args[0] !== false);
    case 'dispose':
      engine.dispose();
      return true;
    default: {
      const fn = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[m];
      return fn.apply(engine, args);
    }
  }
}
