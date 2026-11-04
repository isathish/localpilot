import * as fs from 'fs';
import * as path from 'path';
import type { McpServerConfig } from '../config';
import { transportKind } from './transports';

const SCRIPT = /\.(m?js|cjs|py)$/i;

function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The files of a stdio server worth watching: a `.js`, `.mjs`, `.cjs` or `.py` file, or anything under a `build/` or
 * `dist/` folder, named by its command or arguments and inside one of `roots` (not under `node_modules`). Relative
 * paths resolve against the server's `cwd`, else the first root. Whether the files exist is not checked here.
 */
export function mcpWatchTargets(cfg: Pick<McpServerConfig, 'type' | 'url' | 'command' | 'args' | 'cwd'>, roots: string[]): string[] {
  if (transportKind(cfg) !== 'stdio' || !roots.length) {
    return [];
  }
  const base = cfg.cwd && path.isAbsolute(cfg.cwd) ? cfg.cwd : roots[0];
  const out = new Set<string>();
  for (const raw of [cfg.command ?? '', ...(cfg.args ?? [])]) {
    const arg = String(raw).trim();
    // Flags (`--port=3000`), unexpanded references and URLs are not files.
    if (!arg || arg.startsWith('-') || arg.includes('${') || /^[a-z][\w+.-]*:\/\//i.test(arg)) {
      continue;
    }
    const segs = arg.split(/[\\/]/);
    if (!SCRIPT.test(arg) && !segs.slice(0, -1).some((s) => s === 'build' || s === 'dist')) {
      continue;
    }
    const file = path.resolve(base, arg);
    if (file.split(/[\\/]/).includes('node_modules') || !roots.some((r) => inside(file, path.resolve(r)))) {
      continue;
    }
    out.add(file);
  }
  return [...out];
}

/**
 * Watches the script files of stdio servers and calls `onChange(server)` 500 ms after the last change to any of them.
 * The parent folder is watched (by file name), so editors that save by replacing the file are seen too.
 */
export class McpServerFileWatcher {
  private readonly servers = new Map<string, { watchers: fs.FSWatcher[]; timer?: ReturnType<typeof setTimeout>; key: string }>();

  constructor(private readonly onChange: (server: string, file: string) => void, private readonly debounceMs = 500) {}

  /** Starts (or replaces) the watch of one server's files; an empty list stops it. Missing files are skipped. */
  watch(server: string, files: string[]): void {
    const existing = files.filter((f) => fs.existsSync(f));
    const key = existing.slice().sort().join('\n');
    if (this.servers.get(server)?.key === key) {
      return;
    }
    this.unwatch(server);
    if (!existing.length) {
      return;
    }
    const byDir = new Map<string, Map<string, string>>();
    for (const f of existing) {
      const dir = path.dirname(f);
      byDir.set(dir, (byDir.get(dir) ?? new Map()).set(path.basename(f), f));
    }
    const entry: { watchers: fs.FSWatcher[]; timer?: ReturnType<typeof setTimeout>; key: string } = { watchers: [], key };
    for (const [dir, names] of byDir) {
      try {
        const w = fs.watch(dir, { persistent: false }, (_ev, name) => {
          const file = name ? names.get(String(name)) : undefined;
          if (!file) {
            return;
          }
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            entry.timer = undefined;
            if (this.servers.get(server) === entry) {
              this.onChange(server, file);
            }
          }, this.debounceMs);
          entry.timer.unref?.();
        });
        w.on('error', () => w.close());
        entry.watchers.push(w);
      } catch {
        /* the folder went away: nothing to watch */
      }
    }
    this.servers.set(server, entry);
  }

  unwatch(server: string): void {
    const entry = this.servers.get(server);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    entry.watchers.forEach((w) => w.close());
    this.servers.delete(server);
  }

  /** Servers currently watched. */
  get watched(): string[] {
    return [...this.servers.keys()];
  }

  dispose(): void {
    for (const name of [...this.servers.keys()]) {
      this.unwatch(name);
    }
  }
}
