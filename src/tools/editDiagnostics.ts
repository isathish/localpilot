import * as vscode from 'vscode';
import { getConfig } from '../config';

/** The parts of a diagnostic that identify it across an edit. */
export interface ErrorKey {
  line: number;
  message: string;
}

/**
 * Error-severity diagnostics in `after` that were not in `before`, as `<line>: <message>` with 1-based lines, at most
 * `max`. An error counts as old when `before` had the same message on the same 0-based line or, since an edit shifts
 * the lines below it, the same message on another line that no other error matched (each old error is used once).
 */
export function newErrorLines(before: readonly ErrorKey[], after: readonly ErrorKey[], max = 10): string[] {
  const key = (d: ErrorKey) => `${d.line}\u0000${d.message}`;
  const exact = new Set(before.map(key));
  const unmoved = new Set(after.map(key).filter((k) => exact.has(k)));
  // Old errors with no exact match are available, once each, to errors with the same message that moved.
  const moved = new Map<string, number>();
  for (const d of before) {
    if (!unmoved.has(key(d))) {
      moved.set(d.message, (moved.get(d.message) ?? 0) + 1);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of after) {
    const k = key(d);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    if (unmoved.has(k)) {
      continue;
    }
    const left = moved.get(d.message) ?? 0;
    if (left > 0) {
      moved.set(d.message, left - 1);
      continue;
    }
    out.push(`${d.line + 1}: ${d.message.replace(/\s*\n\s*/g, ' ')}`);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

const errorsOf = (uri: vscode.Uri): ErrorKey[] =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
    .map((d) => ({ line: d.range.start.line, message: d.message }));

/** Watches one file across an edit; `report()` resolves to a tool-result section ('' when nothing new). */
export interface NewErrorWatch {
  /** `label` names the file in the heading, for results that cover several files. */
  report(label?: string): Promise<string>;
  /** Stop listening without reporting (the edit was not applied). */
  dispose(): void;
}

const NONE: NewErrorWatch = { report: async () => '', dispose() {} };

/**
 * Call before an edit is applied: records the file's errors and listens for the language server's next publish, so a
 * publish that lands before `report()` is not missed. `report()` waits up to `maxMs` for it, then lists new errors.
 */
export function watchNewErrors(uri: vscode.Uri, maxMs = 1500): NewErrorWatch {
  // The CLI has no language servers: no event, no wait.
  if (!getConfig().edit.reportNewErrors || vscode.env.appName === 'LocalPilot CLI' || typeof vscode.languages.onDidChangeDiagnostics !== 'function') {
    return NONE;
  }
  let before: ErrorKey[];
  try {
    before = errorsOf(uri);
  } catch {
    return NONE;
  }
  let published: (() => void) | undefined;
  let seen = false;
  const sub = vscode.languages.onDidChangeDiagnostics((e) => {
    if (e.uris.some((u) => u.toString() === uri.toString())) {
      seen = true;
      published?.();
    }
  });
  return {
    async report(label?: string) {
      try {
        await new Promise<void>((resolve) => {
          // Language servers often publish syntax then semantic results: wait until publishes stop for 250 ms, at
          // most `maxMs` in all.
          let settle: ReturnType<typeof setTimeout> | undefined;
          const done = () => {
            clearTimeout(settle);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, maxMs);
          published = () => {
            clearTimeout(settle);
            settle = setTimeout(done, 250);
          };
          if (seen) {
            published();
          }
        });
      } finally {
        sub.dispose();
      }
      const lines = newErrorLines(before, errorsOf(uri));
      return lines.length ? `\n\nNew problems${label ? ` in ${label}` : ''}:\n${lines.join('\n')}` : '';
    },
    dispose: () => sub.dispose(),
  };
}
