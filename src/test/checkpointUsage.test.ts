import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointService, dirBytes, diskUsageRevs, formatBytes, snapshotFolder } from '../agent/checkpoints';

suite('Checkpoint disk usage and cleanup on delete', () => {
  test('byte formatting, snapshot folder names and the git revisions counted', () => {
    assert.strictEqual(formatBytes(820), '820 B');
    assert.strictEqual(formatBytes(12 * 1024), '12 KB');
    assert.strictEqual(formatBytes(3.44 * 1024 * 1024), '3.4 MB');
    assert.strictEqual(formatBytes(1.2 * 1024 ** 3), '1.2 GB');
    assert.strictEqual(snapshotFolder('s_abc::worker 1'), 's_abc');
    assert.strictEqual(snapshotFolder('cli-a.b'), 'cli-a_b');
    assert.deepStrictEqual(diskUsageRevs(), ['--glob=refs/localpilot/checkpoints/*', '--not', '--branches', '--tags', '--remotes', 'HEAD']);
    const own = diskUsageRevs('s_1');
    assert.strictEqual(own[0], '--glob=refs/localpilot/checkpoints/s_1/*');
    assert.ok(own.includes('--exclude=refs/localpilot/checkpoints/s_1/*') && own.indexOf('--exclude=refs/localpilot/checkpoints/s_1/*') < own.indexOf('--glob=refs/localpilot/checkpoints/*'), 'other chats’ checkpoints are subtracted');
  });

  test('a chat’s checkpoints are counted (snapshots and git objects only they keep) and gone once it is deleted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cpu-'));
    const repo = path.join(dir, 'repo');
    const storage = path.join(dir, 'storage');
    const snaps = path.join(dir, 'snapshots');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
      git('add', '.');
      git('commit', '-qm', 'init');
      const svc = new CheckpointService({ globalStorageDir: storage, enabled: () => true, defaultRoot: () => repo });
      const s: any = { id: 's_usage', messages: [] };
      const other: any = { id: 's_other', messages: [] };
      fs.writeFileSync(path.join(repo, 'a.txt'), 'x'.repeat(5000));
      fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked file');
      await svc.snapshot(s, 1, repo);
      await svc.snapshot(other, 1, repo);
      fs.mkdirSync(path.join(snaps, 's_usage'), { recursive: true });
      fs.writeFileSync(path.join(snaps, 's_usage', '1.json'), '{"files":{}}');
      fs.mkdirSync(path.join(snaps, 's_other'), { recursive: true });
      fs.writeFileSync(path.join(snaps, 's_other', '1.json'), '{}');
      assert.strictEqual(dirBytes(snaps), 14);

      const all = await svc.diskUsage({ snapshotDir: snaps });
      assert.strictEqual(all.snapshots, 14);
      assert.ok(all.git > 0, 'stash and untracked-file commits are only reachable from checkpoint refs');
      const mine = await svc.diskUsage({ snapshotDir: snaps, sessionId: 's_usage' });
      assert.strictEqual(mine.snapshots, 12);
      assert.ok(mine.git <= all.git);

      await svc.deleteSession('s_usage', [repo]);
      assert.deepStrictEqual(await svc.refs('s_usage', repo), []);
      assert.strictEqual((await svc.diskUsage({ sessionId: 's_usage' })).git, 0);
      assert.ok((await svc.refs('s_other', repo)).length, 'other chats keep their checkpoints');
      assert.strictEqual(await svc.diskUsage({ snapshotDir: path.join(dir, 'missing') }).then((u) => u.snapshots), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
