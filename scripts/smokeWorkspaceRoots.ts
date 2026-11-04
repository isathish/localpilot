/**
 * Smoke checks for multi-root path resolution and the agent ignore file (bundled into scripts/smoke.ts): `name:rel`
 * paths, the fallback to the one other folder that has a file, and `.localpilotignore` matching with `!include`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveRootPath } from '../src/tools/rootPaths';
import { IgnoreMatcher, loadIgnore, parseIgnoreRules } from '../src/agent/ignoreFile';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export async function workspaceRoots(check: Check): Promise<void> {
  console.log('\n— multi-root paths and .localpilotignore —');
  const roots = [
    { name: 'web', path: '/w' },
    { name: 'backend', path: '/b' },
    { name: 'docs', path: '/d' },
  ];
  const files = new Set([path.join('/b', 'src', 'x.ts'), path.join('/b', 'src', 'both.ts'), path.join('/d', 'src', 'both.ts')]);
  const resolve = (p: string) => resolveRootPath(p, '/w', roots, (a) => files.has(a));
  const named = resolve('backend:src/x.ts');
  check('name:rel resolves against the named folder', 'abs' in named && named.abs === path.join('/b', 'src', 'x.ts'), named);
  const fallback = resolve('src/x.ts');
  check('a bare path found in one other folder resolves there with a note', 'abs' in fallback && fallback.abs === path.join('/b', 'src', 'x.ts') && /backend:src\/x\.ts/.test(fallback.note ?? ''), fallback);
  const ambiguous = resolve('src/both.ts');
  check('a bare path in several folders is an error listing them', 'error' in ambiguous && ambiguous.error.includes('backend:src/both.ts, docs:src/both.ts'), ambiguous);
  const fresh = resolve('src/new.ts');
  check('a new file stays in the primary folder', 'abs' in fresh && fresh.abs === path.join('/w', 'src', 'new.ts') && !fresh.note, fresh);

  const m = new IgnoreMatcher(parseIgnoreRules('*.env\n!sample.env\nsecrets/\n/root-only.txt\n', '.localpilotignore'));
  check('ignore: globs at any depth, negation, folders and anchoring', m.match('a/prod.env') === '.localpilotignore' && !m.match('sample.env') && m.match('secrets/k.pem') === '.localpilotignore' && m.match('root-only.txt') === '.localpilotignore' && !m.match('a/root-only.txt'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ignore-'));
  try {
    fs.writeFileSync(path.join(dir, '.clineignore'), '!include shared.ignore\n');
    fs.writeFileSync(path.join(dir, 'shared.ignore'), 'logs/\n');
    const loaded = loadIgnore(dir);
    check('ignore: .clineignore read, !include followed', loaded.match('logs/a.txt') === '.clineignore' && !loaded.match('src/a.ts'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
