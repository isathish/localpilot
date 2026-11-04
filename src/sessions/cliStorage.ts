import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Root of the CLI's own data: `--data-dir`, else `LOCALPILOT_DATA_DIR`, else `~/.localpilot`. */
export function cliDataDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = override || env.LOCALPILOT_DATA_DIR;
  return dir ? path.resolve(dir) : path.join(os.homedir(), '.localpilot');
}

/** The folder path both sides hash: resolved, symlinks followed, Windows drive letter in lower case. */
export function normalizeWorkspacePath(root: string): string {
  let p = path.resolve(root);
  try {
    p = fs.realpathSync.native(p);
  } catch {
    // not on disk (yet): hash the resolved path
  }
  p = p.replace(/[\\/]+$/, '') || p;
  return /^[A-Z]:/.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
}

/**
 * Where the CLI keeps the state of one workspace folder (`<data>/workspaces/<sha256(path)[0:16]>`). VS Code computes
 * the same folder from its workspace path to list the CLI's chats in its history.
 */
export function cliWorkspaceDir(root: string, dataDir = cliDataDir()): string {
  const hash = crypto.createHash('sha256').update(normalizeWorkspacePath(root)).digest('hex').slice(0, 16);
  return path.join(path.resolve(dataDir), 'workspaces', hash);
}

/** The CLI's saved chats for a folder (what VS Code lists in its history when `localpilot.history.includeCli` is on). */
export function cliSessionsDir(root: string, dataDir = cliDataDir()): string {
  return path.join(cliWorkspaceDir(root, dataDir), 'sessions');
}
