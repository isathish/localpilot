import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXT_ID = 'localpilot.localpilot-agent';
/** Where VS Code and its forks install extensions (the same folders the shell shim searches). */
export const EXTENSION_DIRS = ['.vscode', '.vscode-insiders', '.cursor', '.vscode-oss', '.vscodium'];

/** `localpilot.localpilot-agent-1.6.0` (optionally `-darwin-arm64`) → `1.6.0`; undefined for other folders. */
export function extensionVersion(dirName: string): string | undefined {
  const m = new RegExp(`^${EXT_ID.replace('.', '\\.')}-(\\d+\\.\\d+\\.\\d+)(?:-[\\w.-]+)?$`, 'i').exec(dirName);
  return m?.[1];
}

/** Numeric comparison of `x.y.z` versions: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
  }
  return 0;
}

/** The newest LocalPilot extension installed in any editor, with its folder; undefined when none is found. */
export function newestInstalledExtension(home = os.homedir()): { version: string; dir: string } | undefined {
  let best: { version: string; dir: string } | undefined;
  for (const d of EXTENSION_DIRS) {
    const root = path.join(home, d, 'extensions');
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const v = extensionVersion(n);
      if (v && (!best || compareVersions(v, best.version) > 0) && fs.existsSync(path.join(root, n, 'dist', 'cli.js'))) {
        best = { version: v, dir: path.join(root, n) };
      }
    }
  }
  return best;
}

/** A notice when this CLI is older than the newest installed extension (a stale copy run directly); undefined otherwise. */
export function versionNotice(cliVersion: string, newest: { version: string; dir: string } | undefined): string | undefined {
  if (!newest || cliVersion === '0.0.0' || compareVersions(cliVersion, newest.version) >= 0) {
    return undefined;
  }
  return `This CLI is v${cliVersion}, but LocalPilot v${newest.version} is installed (${newest.dir}). Run that one: node "${path.join(newest.dir, 'dist', 'cli.js')}", or run "LocalPilot: Install 'localpilot' CLI in PATH" again so the command picks the newest.`;
}
