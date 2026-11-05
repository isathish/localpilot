/**
 * `REPO_ROOT` for the module smokes when they are bundled into scripts/smoke.ts (out/smoke.js): the folder above the
 * bundle that holds scripts/healing/fixtures. scripts/healing/run.js defines it at build time instead.
 */
import * as fs from 'fs';
import * as path from 'path';

const g = globalThis as { REPO_ROOT?: string };

function findRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'healing', 'fixtures'))) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      return process.cwd();
    }
  }
}

g.REPO_ROOT ??= findRoot(__dirname);

export const repoRoot: string = g.REPO_ROOT;
