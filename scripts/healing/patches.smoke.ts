/**
 * Smoke checks for src/agent/healing/patchManager.ts and treeSnapshot.ts (design §2.4, §5.4).
 *   node scripts/healing/run.js scripts/healing/patches.smoke.ts
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PatchManager, failureScore } from '../../src/agent/healing/patchManager';
import { diff, snapshot, wholeTreeKey } from '../../src/agent/healing/treeSnapshot';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const tmp = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-patches-${tag}-`));
const rm = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
const write = (root: string, rel: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel));
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));

/** Simulates a write tool: hook before, write, hook after. */
async function agentWrite(pm: PatchManager, root: string, rel: string, text: string | undefined, writer?: string): Promise<void> {
  await pm.beforeWrite(path.join(root, rel), writer);
  if (text === undefined) {
    fs.rmSync(path.join(root, rel), { force: true });
  } else {
    write(root, rel, text);
  }
  await pm.afterWrite([path.join(root, rel)], writer);
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function patchesSmoke(check: Check): Promise<void> {
  const root = tmp('ws');
  const store = tmp('store');
  const persistDir = (attempt: number, sid?: string) => path.join(store, sid ?? 's1', `attempt-${attempt}`);
  let settled = 0;
  try {
    const original = 'line 1\nline 2\r\nline 3\n\ttabbed ü\n';
    const binary = Buffer.from([0, 255, 1, 254, 0x80, 10, 13]);
    write(root, 'src/a.ts', original);
    write(root, 'src/b.ts', 'export const b = 1;\n');
    write(root, 'assets/logo.bin', binary);

    const pm = new PatchManager({ root, persistDir, sessionId: 's1', settle: () => void settled++ });
    pm.openScope(1);
    await agentWrite(pm, root, 'src/a.ts', 'line 1\nline TWO\nline 3\n\ttabbed ü\nline 4\n');
    await agentWrite(pm, root, 'src/a.ts', 'second write in the same scope\n');
    await agentWrite(pm, root, 'src/new.ts', 'export const n = 1;\n');
    await agentWrite(pm, root, 'assets/logo.bin', 'not binary any more');
    await agentWrite(pm, root, 'src/b.ts', undefined);

    const p1 = await pm.patches(1);
    const pa = p1.find((p) => p.file === 'src/a.ts');
    check('patches list each changed file once', p1.map((p) => p.file).join(',') === 'assets/logo.bin,src/a.ts,src/b.ts,src/new.ts', p1);
    check('patch stats against the pre-attempt content', pa?.added === 1 && pa.removed === 4 && /^@@/.test(pa.preview), pa);
    check('new file counted as added, deleted file as removed', p1.find((p) => p.file === 'src/new.ts')?.added === 1 && p1.find((p) => p.file === 'src/b.ts')?.removed === 1, p1);
    check('persisted snapshots under the attempt dir', fs.readdirSync(persistDir(1)).filter((n) => n.endsWith('.json')).length === 4);

    const hashNow = pm.agentHash('src/a.ts');
    check('afterWrite hashes the current content (sha1)', typeof hashNow === 'string' && hashNow.length === 40);
    check('afterWrite hashes a deleted file as null', pm.agentHash('src/b.ts') === null);
    check('changedFiles / scope files', pm.changedFiles().length === 4 && pm.changedFiles(1).length === 4 && pm.turnChangedFiles().length === 4, pm.changedFiles());
    check('user edit not detected for the agent content', !(await pm.userEdited('src/a.ts')));

    const ser = JSON.parse(JSON.stringify(pm.serialise())) as ReturnType<PatchManager['serialise']>;
    check('serialise carries changedFiles, agentWrites, activeScope', ser.changedFiles.length === 4 && ser.agentWrites['src/b.ts'] === null && ser.activeScope?.attempt === 1 && ser.activeScope.files.length === 4, ser);

    const rb = await pm.rollback(1);
    check('rollback restores modified files byte-equal', read(root, 'src/a.ts').equals(Buffer.from(original)) && read(root, 'assets/logo.bin').equals(binary), rb);
    check('rollback deletes files that did not exist', !exists(root, 'src/new.ts'));
    check('rollback recreates deleted files', read(root, 'src/b.ts').toString() === 'export const b = 1;\n');
    check('rollback result lists restored files, settle called', rb.restored.length === 4 && rb.skipped.length === 0 && settled === 1, rb);
    check('rolled-back patches keep their records', (await pm.patches(1)).every((p) => p.result === 'rolled_back'));
    check('rollback closes the active scope', pm.activeAttempt() === undefined);

    // User-edit skip, and newest-first rollback across scopes.
    const pm2 = new PatchManager({ root });
    pm2.openScope(1);
    await agentWrite(pm2, root, 'src/a.ts', 'attempt 1\n');
    await agentWrite(pm2, root, 'src/c.ts', 'attempt 1 c\n');
    pm2.openScope(2);
    await agentWrite(pm2, root, 'src/a.ts', 'attempt 2\n');
    await agentWrite(pm2, root, 'src/c.ts', 'attempt 2 c\n');
    write(root, 'src/c.ts', 'user typed this\n');
    check('userEdited detects a foreign change', await pm2.userEdited('src/c.ts'));
    const rb2 = await pm2.rollback();
    check('newest-first rollback restores across scopes', read(root, 'src/a.ts').equals(Buffer.from(original)), read(root, 'src/a.ts').toString());
    check('user-edited file skipped', read(root, 'src/c.ts').toString() === 'user typed this\n' && rb2.skipped.some((s) => s.file === 'src/c.ts' && s.reason === 'user_edited'), rb2);
    fs.rmSync(path.join(root, 'src/c.ts'));

    // Identical patches get identical hashes.
    const pm3 = new PatchManager({ root });
    pm3.openScope(1);
    await agentWrite(pm3, root, 'src/a.ts', 'fixed\n');
    const h1 = await pm3.attemptHash(1);
    const d1 = (await pm3.patches(1))[0]?.diffHash;
    await pm3.rollback(1);
    pm3.openScope(2);
    await agentWrite(pm3, root, 'src/a.ts', 'fixed\n');
    check('identical patch => identical diffHash', !!d1 && d1 === (await pm3.patches(2))[0]?.diffHash && h1 === (await pm3.attemptHash(2)), [d1, h1]);
    pm3.openScope(3);
    await agentWrite(pm3, root, 'src/a.ts', 'fixed differently\n');
    check('different patch => different hash', (await pm3.attemptHash(3)) !== h1);
    const turnDiff = await pm3.diffFor(['src/a.ts'], 80);
    check('diffFor shows the turn diff with headers', turnDiff.startsWith('--- a/src/a.ts\n+++ b/src/a.ts') && turnDiff.includes('+fixed differently'), turnDiff);
    await pm3.rollback();

    // Excluded paths.
    const pm4 = new PatchManager({ root, isExcluded: (rel) => rel === 'MEMORY.md' });
    pm4.openScope(1);
    await agentWrite(pm4, root, '.localpilot/recovery-memory.json', '{}');
    await agentWrite(pm4, root, 'MEMORY.md', '# memory');
    await pm4.noteCommandChanges(['.localpilot/checks.json', 'package-lock.json']);
    check('.localpilot/ and the memory file are excluded', pm4.changedFiles().join(',') === 'package-lock.json', pm4.changedFiles());
    check('command changes are reported but not restorable', pm4.changedFiles(1).join(',') === 'package-lock.json' && (await pm4.patches(1)).length === 0);
    await pm4.noteCommandChanges(['*']);
    check('unknown tree change is reported as *', pm4.turnChangedFiles().includes('*'));
    const rb4 = await pm4.rollback(1);
    check('command-changed file is skipped as unknown', rb4.skipped.some((s) => s.file === 'package-lock.json' && s.reason === 'unknown'), rb4);
    check('writersOf records the writer', pm4.writersOf('package-lock.json').join() === 'self');
    fs.rmSync(path.join(root, '.localpilot'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'MEMORY.md'), { force: true });

    // Persisted restore after a "restart": a fresh manager from the serialised state + the attempt dir.
    const pm5 = new PatchManager({ root, persistDir, sessionId: 's2' });
    pm5.openScope(4);
    await agentWrite(pm5, root, 'src/a.ts', 'before restart\n', 'worker-1');
    await agentWrite(pm5, root, 'src/fresh.ts', 'new\n', 'worker-1');
    const saved = JSON.parse(JSON.stringify(pm5.serialise()));
    let restoredVia = 0;
    const pm6 = PatchManager.restore(saved, {
      root,
      persistDir,
      restoreFile: async (fsPath, content) => {
        restoredVia++;
        if (content === undefined) {
          fs.rmSync(fsPath, { force: true });
        } else {
          fs.writeFileSync(fsPath, content);
        }
      },
    });
    check('restored manager keeps changed files and active scope', pm6.changedFiles().join(',') === 'src/a.ts,src/fresh.ts' && pm6.activeAttempt() === 4);
    const loaded = await pm6.restoreFromDisk('s2', 4);
    check('restoreFromDisk loads the attempt snapshots', loaded === 2, loaded);
    check('restored agentWrites still match (no user edit)', !(await pm6.userEdited('src/a.ts')));
    const rb6 = await pm6.rollback(4);
    check('persisted restore rolls back byte-equal via restoreFile', read(root, 'src/a.ts').equals(Buffer.from(original)) && !exists(root, 'src/fresh.ts') && restoredVia === 2, rb6);
    const pm7 = PatchManager.restore(saved, { root });
    check('without snapshots, restored scope files are not rolled back', (await pm7.rollback()).skipped.length === 2);

    // A tampered or misnamed snapshot can never restore a path outside the workspace.
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    fs.writeFileSync(outside, 'keep me\n');
    const evilDir = persistDir(5, 's3');
    fs.mkdirSync(evilDir, { recursive: true });
    const evilRel = path.relative(root, outside).split(path.sep).join('/');
    const sha = (t: string) => createHash('sha1').update(t).digest('hex');
    fs.writeFileSync(path.join(evilDir, `${sha(evilRel)}.json`), JSON.stringify({ v: 1, file: evilRel, existed: false, at: 0 }));
    fs.writeFileSync(path.join(evilDir, `${sha('src/other.ts')}.json`), JSON.stringify({ v: 1, file: 'src/a.ts', existed: false, at: 0 }));
    const pmEvil = new PatchManager({ root, persistDir, sessionId: 's3' });
    const evilLoaded = await pmEvil.restoreFromDisk('s3', 5);
    await pmEvil.rollback();
    check('snapshots outside the root or under the wrong name are ignored', evilLoaded === 0 && fs.existsSync(outside) && exists(root, 'src/a.ts'), evilLoaded);
    fs.rmSync(outside, { force: true });

    // A failed restore keeps the scope eligible; the next rollback retries only that file.
    let failOnce = true;
    const pm8 = new PatchManager({
      root,
      restoreFile: async (fsPath, content) => {
        if (failOnce && fsPath.endsWith('b.ts')) {
          failOnce = false;
          throw new Error('EBUSY: resource busy');
        }
        if (content === undefined) {
          fs.rmSync(fsPath, { force: true });
        } else {
          fs.writeFileSync(fsPath, content);
        }
      },
    });
    pm8.openScope(1);
    await agentWrite(pm8, root, 'src/a.ts', 'a broken\n');
    await agentWrite(pm8, root, 'src/b.ts', 'b broken\n');
    const rb8a = await pm8.rollback();
    check('errored restore reported, other files restored', rb8a.restored.join() === 'src/a.ts' && rb8a.skipped.some((s) => s.file === 'src/b.ts' && s.reason === 'error'), rb8a);
    check('errored file shows as kept until retried', (await pm8.patches(1)).find((p) => p.file === 'src/b.ts')?.result === 'kept');
    const rb8b = await pm8.rollback();
    check('second rollback retries only the errored file', rb8b.restored.join() === 'src/b.ts' && rb8b.skipped.length === 0 && read(root, 'src/b.ts').toString() === 'export const b = 1;\n', rb8b);
    check('retried scope reports every patch rolled back', (await pm8.patches(1)).every((p) => p.result === 'rolled_back') && (await pm8.rollback()).restored.length === 0);

    // A snapshot without a confirmed agent write (failed write tool) never overwrites a later user edit.
    const pm9 = new PatchManager({ root });
    pm9.openScope(1);
    await pm9.beforeWrite(path.join(root, 'src/a.ts'));
    write(root, 'src/a.ts', 'user edit after a failed write\n');
    const rb9 = await pm9.rollback();
    check('unconfirmed write + user edit is skipped as user_edited', read(root, 'src/a.ts').toString() === 'user edit after a failed write\n' && rb9.skipped.some((s) => s.file === 'src/a.ts' && s.reason === 'user_edited'), rb9);
    write(root, 'src/a.ts', original);

    // clearPersisted() removes every attempt folder of the session, also ones only on disk after a restart.
    const pm10 = new PatchManager({ root, persistDir, sessionId: 's4' });
    for (const n of [1, 2, 3]) {
      pm10.openScope(n);
      await agentWrite(pm10, root, 'src/a.ts', `attempt ${n}\n`);
    }
    const pm11 = PatchManager.restore(JSON.parse(JSON.stringify(pm10.serialise())), { root, persistDir, sessionId: 's4' });
    await pm11.restoreFromDisk('s4', 3);
    await pm11.rollback();
    await pm11.clearPersisted();
    const left = fs.existsSync(path.join(store, 's4')) ? fs.readdirSync(path.join(store, 's4')).filter((n) => n.startsWith('attempt-')) : [];
    check('clearPersisted after restore removes all attempt folders', left.length === 0, left);

    check(
      'score ignores preexisting and foreign failures',
      failureScore([
        { severity: 'critical' },
        { severity: 'high' },
        { severity: 'medium' },
        { severity: 'low' },
        { severity: 'info' },
        { severity: 'critical', preexisting: true },
        { severity: 'high', foreign: true },
      ]) === 114,
    );

    await treeSmoke(check);
  } finally {
    rm(root);
    rm(store);
  }
}

async function treeSmoke(check: Check): Promise<void> {
  const dir = tmp('walk');
  try {
    write(dir, 'src/a.ts', 'const a = 1;\n');
    write(dir, 'node_modules/x/index.js', 'x');
    const noGit = async () => ({ code: 128, stdout: '' });
    const s1 = await snapshot(dir, undefined, noGit);
    check('walk snapshot without git', s1.kind === 'walk' && s1.entries.has('src/a.ts') && !s1.entries.has('node_modules/x/index.js'), [...s1.entries.keys()]);
    check('unchanged tree => empty diff', diff(s1, await snapshot(dir, undefined, noGit)).length === 0);
    const k1 = await wholeTreeKey(dir, noGit);
    write(dir, 'src/a.ts', 'const a = 2; // sed -i rewrite\n');
    write(dir, 'src/gen.ts', 'generated\n');
    write(dir, 'node_modules/x/index.js', 'changed');
    const s2 = await snapshot(dir, undefined, noGit);
    check('walk diff detects a rewrite and a new file', diff(s1, s2).join(',') === 'src/a.ts,src/gen.ts', diff(s1, s2));
    check('whole-tree key changes without git', k1 !== (await wholeTreeKey(dir, noGit)));
    const u = await snapshot(dir, undefined, noGit, { walkFiles: 1 });
    check('over-bound walk is unknown and diffs as *', u.kind === 'unknown' && diff(s1, u).join() === '*');
  } finally {
    rm(dir);
  }

  if (!hasGit()) {
    check('git snapshot (git not installed, skipped)', true);
    return;
  }
  const repo = tmp('git');
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'smoke@example.com');
    git('config', 'user.name', 'smoke');
    git('config', 'commit.gpgsign', 'false');
    write(repo, 'pkg/src/a.ts', 'const a = 1;\n');
    write(repo, 'pkg/src/dirty.ts', 'v1\n');
    write(repo, 'other.ts', 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    write(repo, 'pkg/src/dirty.ts', 'v2\n');
    const root = path.join(repo, 'pkg');
    const g1 = await snapshot(root);
    check('git snapshot lists dirty files root-relative', g1.kind === 'git' && [...g1.entries.keys()].join() === 'src/dirty.ts', [...g1.entries.keys()]);
    const key1 = await wholeTreeKey(root);
    write(repo, 'pkg/src/a.ts', 'const a = 2;\n');
    write(repo, 'pkg/src/dirty.ts', 'v3 (longer)\n');
    write(repo, 'pkg/src/new.ts', 'new\n');
    write(repo, 'other.ts', 'outside the root\n');
    const g2 = await snapshot(root);
    check('git diff detects a sed-like rewrite, a re-modified dirty file and a new file', diff(g1, g2).join(',') === 'src/a.ts,src/dirty.ts,src/new.ts', diff(g1, g2));
    const key2 = await wholeTreeKey(root);
    check('whole-tree key is git-based and changes with the tree', key1.startsWith('git:') && key1 !== key2, [key1, key2]);
    check('whole-tree key is stable for an unchanged tree', key2 === (await wholeTreeKey(root)));
  } finally {
    rm(repo);
  }
}
