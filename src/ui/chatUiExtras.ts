import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import type { WhatsNewCard } from './whatsNew';

/** Chat preferences the webview needs beyond the models: tips, the auto-compact threshold and the What's new card. */
export type UiPrefsMsg = { type: 'uiPrefs'; showTips: boolean; compactionThreshold: number; autoCompact: boolean; whatsNew?: WhatsNewCard };
/** Answer to `pathsExist`: which of the asked paths name a file or folder (`seq` echoes the request). */
export type PathsExistMsg = { type: 'pathsExistResult'; seq: number; sessionId?: string; exists: Record<string, boolean> };

export function uiPrefsMsg(whatsNew?: WhatsNewCard): UiPrefsMsg {
  const cfg = getConfig();
  return { type: 'uiPrefs', showTips: cfg.showTips !== false, compactionThreshold: cfg.compactionThreshold, autoCompact: cfg.compactionStrategy !== 'off', whatsNew };
}

export function affectsUiPrefs(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration('localpilot.showTips') || e.affectsConfiguration('localpilot.compactionThreshold') || e.affectsConfiguration('localpilot.compaction.strategy');
}

/** Most paths checked per request; an answer naming hundreds of files only gets its first ones checked. */
export const MAX_PATH_CHECKS = 200;

export interface PathRoots {
  /** Workspace folders, in order (multi-root refs may start with a folder name). */
  folders: { name: string; fsPath: string }[];
  /** The chat's isolated worktree folder: its relative paths name files there first. */
  worktreeRoot?: string;
}

/** Where a path from an answer may live: absolute as is; relative in the worktree, a named folder, then every folder. */
export function pathCandidates(ref: string, roots: PathRoots): string[] {
  const p = ref.replace(/^file:\/\//, '').replace(/[#?].*$/, '');
  if (!p || p.includes('\0')) {
    return [];
  }
  if (path.isAbsolute(p) || /^[a-z]:[\\/]/i.test(p)) {
    return [p];
  }
  if (p.split(/[\\/]/).includes('..')) {
    return [];
  }
  const out: string[] = [];
  if (roots.worktreeRoot) {
    out.push(path.join(roots.worktreeRoot, p));
  }
  const [head, ...rest] = p.split('/');
  const named = roots.folders.length > 1 && rest.length ? roots.folders.find((f) => f.name === head) : undefined;
  if (named) {
    out.push(path.join(named.fsPath, rest.join('/')));
  }
  out.push(...roots.folders.map((f) => path.join(f.fsPath, p)));
  return [...new Set(out)];
}

/** Which paths exist (deduplicated, capped at MAX_PATH_CHECKS). `exists` is injectable for tests. */
export async function checkPathsExist(paths: string[], roots: PathRoots, exists: (abs: string) => Promise<boolean> = statExists): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 0 && p.length < 1024))].slice(0, MAX_PATH_CHECKS);
  await Promise.all(unique.map(async (p) => {
    for (const c of pathCandidates(p, roots)) {
      if (await exists(c)) {
        out[p] = true;
        return;
      }
    }
    out[p] = false;
  }));
  return out;
}

function statExists(abs: string): Promise<boolean> {
  return fs.promises.stat(abs).then(() => true, () => false);
}
