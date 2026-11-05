/**
 * Smoke checks for src/agent/healing/recoveryStore.ts (design §7.1, scan part of §7.2).
 *   node scripts/healing/run.js scripts/healing/store.smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LOCK_STALE_MS, RecoveryStore, rootSessionId } from '../../src/agent/healing/recoveryStore';
import type { InterventionRecord, RecoveryState } from '../../src/agent/healing/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

function state(sessionId: string, patch: Partial<RecoveryState> = {}): RecoveryState {
  return {
    version: 1,
    rev: 0,
    sessionId,
    turnKey: 2,
    phase: 'executing',
    startedAt: 1000,
    updatedAt: 1000,
    owner: { pid: 0, host: '', kind: 'cli' },
    baseline: undefined,
    checks: {},
    changedFiles: [],
    agentWrites: {},
    approvals: [],
    acceptedRisks: [],
    attempts: [],
    perCategory: {},
    seen: {},
    active: [],
    extraStepsUsed: 0,
    ...patch,
  };
}

function deadPid(): number {
  for (let pid = 999_999; pid > 900_000; pid -= 7) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
        return pid;
      }
    }
  }
  return 999_999;
}

function tmpsOf(file: string): string[] {
  const base = `${path.basename(file)}.`;
  return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(base) && n.endsWith('.tmp'));
}

function intervention(id: string, sessionId: string, createdAt: number): InterventionRecord {
  return {
    id,
    sessionId,
    reason: 'exhausted',
    category: 'typescript',
    title: `TS2345 in src/a.ts (${id})`,
    rootCause: 'wrong argument type',
    attemptsSummary: '3 attempts, not fixed',
    patches: [],
    nextActions: [{ action: 'resume', label: 'Resume', command: '/recovery resume' }],
    createdAt,
  };
}

export async function storeSmoke(check: Check): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-recovery-store-'));
  const warnings: string[] = [];
  const log = { warn: (m: string) => warnings.push(m), info: () => undefined };
  const host = os.hostname();
  try {
    const store = new RecoveryStore(dir, { owner: { kind: 'vscode' }, log });

    // Concurrent saves: serialised, the last rev wins on disk.
    const s = state('sess-a');
    const saves: Promise<boolean>[] = [];
    for (let i = 0; i < 20; i++) {
      s.extraStepsUsed = i;
      saves.push(store.save(s));
    }
    const results = await Promise.all(saves);
    check('every save reports success', results.every((r) => r === true));
    const back = await new RecoveryStore(dir, { owner: { kind: 'cli' } }).load('sess-a');
    check('concurrent saves keep the last rev', back?.rev === 20 && back.extraStepsUsed === 19, back && { rev: back.rev, steps: back.extraStepsUsed });
    check('save sets owner and updatedAt', back?.owner.pid === process.pid && back.owner.kind === 'vscode' && back.updatedAt > 1000, back?.owner);
    check('no tmp file left behind', tmpsOf(store.statePath('sess-a')).length === 0, tmpsOf(store.statePath('sess-a')));

    // Child sessions resolve to the root file.
    check('root session id', rootSessionId('sess-a::w1::w2') === 'sess-a');
    const child = await store.load('sess-a::worker-1');
    check('child sid loads the root state', child?.sessionId === 'sess-a' && child.rev === 20);

    // New fields round-trip.
    const full = state('sess-b', {
      phase: 'validating',
      taskId: 'task-1',
      recoveryStartedAt: 1234,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      agentWrites: { 'src/a.ts': 'abc123', 'src/gone.ts': null },
      activeScope: { attempt: 2, files: ['src/a.ts'] },
      approvals: [{ at: 5, kind: 'install', command: 'npm i left-pad', decision: 'approved', mandatory: true, origin: 'healing' }],
      acceptedRisks: [{ by: 'user', at: 6, signatures: ['deadbeef'] }],
      checkAllowance: { commandsHash: 'h', turnKey: 2, at: 7 },
      attempts: [{ n: 1, category: 'typescript', signature: 'sig', strategy: 'fix', mode: 'inline', patches: [], result: 'not_fixed', startedAt: 8 }],
      perCategory: { typescript: 1 },
      pendingAction: { kind: 'install', command: 'npm i left-pad', status: 'started', at: 9 },
    });
    await store.save(full);
    const fb = await new RecoveryStore(dir, { owner: { kind: 'cli' } }).load('sess-b');
    check(
      'new fields round-trip',
      !!fb &&
        fb.recoveryStartedAt === 1234 &&
        JSON.stringify(fb.changedFiles) === JSON.stringify(full.changedFiles) &&
        JSON.stringify(fb.agentWrites) === JSON.stringify(full.agentWrites) &&
        JSON.stringify(fb.activeScope) === JSON.stringify(full.activeScope) &&
        JSON.stringify(fb.approvals) === JSON.stringify(full.approvals) &&
        JSON.stringify(fb.acceptedRisks) === JSON.stringify(full.acceptedRisks) &&
        fb.pendingAction?.status === 'started' &&
        fb.checkAllowance?.commandsHash === 'h' &&
        fb.taskId === 'task-1',
      fb,
    );

    // Crash between tmp write and rename: the complete, newer tmp is promoted; a truncated one is dropped.
    const file = store.statePath('sess-b');
    const crashedTmp = `${file}.${deadPid()}.1.tmp`;
    fs.writeFileSync(crashedTmp, JSON.stringify({ ...fb, rev: (fb?.rev ?? 0) + 1, phase: 'regression' }));
    const fresh = new RecoveryStore(dir, { owner: { kind: 'cli' } });
    const rec = await fresh.load('sess-b');
    check('tmp-file crash recovery promotes the newer complete write', rec?.phase === 'regression' && rec.rev === (fb?.rev ?? 0) + 1, rec?.phase);
    check('tmp file consumed', tmpsOf(file).length === 0);
    fs.writeFileSync(crashedTmp, '{"version":1,"sessionId":"sess-b","pha');
    const kept = await fresh.load('sess-b');
    check('truncated tmp of a dead writer ignored and removed', kept?.phase === 'regression' && tmpsOf(file).length === 0);
    fs.writeFileSync(`${file}.tmp`, '{"version":1,"sessionId":"sess-b","pha');
    await fresh.load('sess-b');
    check('legacy .tmp name still cleaned up', tmpsOf(file).length === 0);

    // A tmp of a live foreign writer is never touched (it may be mid-write) until it is older than the stale age.
    const liveTmp = `${file}.${process.ppid}.7.tmp`;
    fs.writeFileSync(liveTmp, '{"version":1,"sessionId":"sess-b","pha');
    const whileLive = await fresh.load('sess-b');
    check('live writer tmp left alone', whileLive?.phase === 'regression' && fs.existsSync(liveTmp));
    const old = (Date.now() - LOCK_STALE_MS - 5000) / 1000;
    fs.utimesSync(liveTmp, old, old);
    await fresh.load('sess-b');
    check('old tmp of a live pid is dropped', !fs.existsSync(liveTmp));

    // A live foreign owner lock: its tmp files are ignored, even complete and newer ones.
    fs.writeFileSync(store.lockPath('sess-b'), JSON.stringify({ pid: process.ppid, host, at: Date.now() }));
    fs.writeFileSync(crashedTmp, JSON.stringify({ ...rec, rev: 77, phase: 'fixing' }));
    const underLock = await fresh.load('sess-b');
    check('tmp ignored while a live foreign process owns the lock', underLock?.phase === 'regression' && fs.existsSync(crashedTmp));
    fs.rmSync(store.lockPath('sess-b'));
    check('tmp promoted once the owner is gone', (await fresh.load('sess-b'))?.rev === 77);

    fs.rmSync(file);
    fs.writeFileSync(crashedTmp, JSON.stringify({ ...rec, rev: 99 }));
    const onlyTmp = await fresh.load('sess-b');
    check('tmp alone (crash before first rename) is recovered', onlyTmp?.rev === 99 && fs.existsSync(file));
    const after = state('sess-b');
    await fresh.save(after);
    check('rev continues after recovery', after.rev === 100, after.rev);

    // load()/listStates() while saves are in flight (same and other store): every save lands.
    const big = (n: number): Partial<RecoveryState> => ({ changedFiles: Array.from({ length: 20_000 }, (_, i) => `src/dir-${n}/file-${i}.ts`) });
    const writer = new RecoveryStore(dir, { owner: { kind: 'vscode' }, log });
    const reader = new RecoveryStore(dir, { owner: { kind: 'cli' }, pid: process.ppid, log });
    const f1 = state('sess-f', big(1));
    const first = writer.save(f1);
    const pending: Promise<unknown>[] = [];
    const flights: Promise<boolean>[] = [first];
    for (let i = 0; i < 6; i++) {
      pending.push(writer.load('sess-f'), reader.load('sess-f'), reader.listStates());
      const next = state('sess-f', { ...big(i + 2), rev: f1.rev });
      flights.push(writer.save(next));
    }
    let settled = false;
    const allFlights = Promise.all(flights).finally(() => (settled = true));
    while (!settled) {
      await reader.load('sess-f');
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(pending);
    const landed = await allFlights;
    const onDisk = JSON.parse(fs.readFileSync(writer.statePath('sess-f'), 'utf8')) as RecoveryState;
    check('saves in flight during load() all land', landed.every((x) => x) && onDisk.rev === f1.rev + 6 && onDisk.changedFiles[0] === 'src/dir-7/file-0.ts', {
      landed,
      rev: onDisk.rev,
    });
    check('no tmp left after concurrent load/save', tmpsOf(writer.statePath('sess-f')).length === 0);

    // A failed write is reported, not swallowed.
    const roDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-recovery-ro-'));
    try {
      const ro = new RecoveryStore(roDir, { owner: { kind: 'vscode' }, log });
      check('save to a writable dir reports success', await ro.save(state('sess-ro')));
      fs.chmodSync(roDir, 0o555);
      let writable = false;
      try {
        fs.writeFileSync(path.join(roDir, 'probe'), '');
        writable = true;
      } catch {
        // Expected: the directory is read-only.
      }
      if (!writable) {
        const before = warnings.length;
        const ok = await ro.save(state('sess-ro', { phase: 'fixing' }));
        check('save into a read-only directory resolves false and warns', ok === false && warnings.length > before);
        check('addIntervention into a read-only directory resolves false', (await ro.addIntervention(intervention('i-ro', 'sess-ro', 1))) === false);
      }
    } finally {
      fs.chmodSync(roDir, 0o755);
      fs.rmSync(roDir, { recursive: true, force: true });
    }

    // Exclusive acquire: of two racing processes exactly one owns the lock.
    const p1 = new RecoveryStore(dir, { owner: { kind: 'vscode' } });
    const p2 = new RecoveryStore(dir, { owner: { kind: 'cli' }, pid: process.ppid });
    const race = await Promise.all([p1.acquire('sess-race'), p2.acquire('sess-race')]);
    check('racing acquire: exactly one owner', race.filter((r) => r === 'owned').length === 1 && race.filter((r) => r === 'readonly').length === 1, race);
    fs.writeFileSync(p1.lockPath('sess-race2'), JSON.stringify({ pid: deadPid(), host, at: Date.now() }));
    const takeover = await Promise.all([p1.acquire('sess-race2'), p2.acquire('sess-race2')]);
    check('racing takeover of a stale lock: exactly one owner', takeover.filter((r) => r === 'owned').length === 1, takeover);
    await Promise.all([p1.dispose(), p2.dispose()]);

    // Corrupt JSON: logged, treated as absent, kept as .corrupt.
    fs.writeFileSync(store.statePath('sess-c'), '{ not json');
    const corrupt = await store.load('sess-c');
    check(
      'corrupt state treated as absent, kept as .corrupt, logged',
      corrupt === undefined && fs.existsSync(`${store.statePath('sess-c')}.corrupt`) && warnings.some((w) => w.includes('corrupt')),
    );

    // Locks: readonly while a live owner holds it, takeover when stale or dead.
    const liveOther = { pid: process.ppid, host, at: Date.now() };
    fs.writeFileSync(store.lockPath('sess-d'), JSON.stringify(liveOther));
    await store.save(state('sess-d'));
    const s2 = new RecoveryStore(dir, { owner: { kind: 'cli' }, log });
    check('readonly when another live process holds the lock', (await s2.acquire('sess-d')) === 'readonly' && s2.isReadonly('sess-d'));
    const d = (await s2.load('sess-d'))!;
    const revBefore = d.rev;
    d.phase = 'fixing';
    await s2.save(d);
    check('readonly store does not write', (await store.load('sess-d'))?.rev === revBefore && (await store.load('sess-d'))?.phase === 'executing');

    fs.writeFileSync(store.lockPath('sess-d'), JSON.stringify({ ...liveOther, at: Date.now() - LOCK_STALE_MS - 1000 }));
    check('stale lock (older than 2 min) taken over', (await s2.acquire('sess-d')) === 'owned' && s2.isOwned('sess-d'));
    const lockNow = JSON.parse(fs.readFileSync(store.lockPath('sess-d'), 'utf8')) as { pid: number; host: string; at: number };
    check('lock file carries pid, host, at', lockNow.pid === process.pid && lockNow.host === host && Date.now() - lockNow.at < 5000, lockNow);
    await s2.release('sess-d');
    check('release removes our lock', !fs.existsSync(store.lockPath('sess-d')));

    fs.writeFileSync(store.lockPath('sess-d'), JSON.stringify({ pid: deadPid(), host, at: Date.now() }));
    check('dead-pid lock on the same host taken over', (await s2.acquire('sess-d')) === 'owned');
    await s2.release('sess-d');
    fs.writeFileSync(store.lockPath('sess-d'), JSON.stringify({ pid: deadPid(), host: 'other-host.example', at: Date.now() }));
    check('fresh lock of another host stays readonly', (await s2.acquire('sess-d')) === 'readonly');
    fs.rmSync(store.lockPath('sess-d'));

    // markInterrupted: phase interrupted + lock released.
    const m = new RecoveryStore(dir, { owner: { kind: 'vscode' } });
    check('acquire free lock', (await m.acquire('sess-m')) === 'owned');
    const ms = state('sess-m', { phase: 'validating' });
    await m.save(ms);
    await m.markInterrupted('sess-m', ms);
    const mb = await m.load('sess-m');
    check('markInterrupted persists interrupted and releases the lock', mb?.phase === 'interrupted' && !fs.existsSync(m.lockPath('sess-m')) && !m.isOwned('sess-m'));

    // scanUnfinished.
    const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-recovery-scan-'));
    try {
      const w = new RecoveryStore(scanDir, { owner: { kind: 'vscode' } });
      await w.save(
        state('dead-owner', {
          phase: 'fixing',
          attempts: [
            { n: 1, category: 'unit_test', signature: 's1', strategy: 'fix', mode: 'inline', patches: [], result: 'not_fixed', startedAt: 1 },
            { n: 2, category: 'unit_test', signature: 's1', strategy: 'fix', mode: 'inline', patches: [], startedAt: 2 },
          ],
        }),
      );
      await w.save(state('live-owner', { phase: 'validating' }));
      await w.save(state('was-interrupted', { phase: 'interrupted', active: [] }));
      await w.save(state('done', { phase: 'completed', outcome: 'completed' }));
      await w.save(state('idle', { phase: 'idle' }));
      await w.save(state('stale-owner', { phase: 'verifying' }));
      fs.writeFileSync(w.lockPath('dead-owner'), JSON.stringify({ pid: deadPid(), host, at: Date.now() }));
      fs.writeFileSync(w.lockPath('live-owner'), JSON.stringify({ pid: process.ppid, host, at: Date.now() }));
      fs.writeFileSync(w.lockPath('stale-owner'), JSON.stringify({ pid: process.ppid, host: 'elsewhere', at: Date.now() - LOCK_STALE_MS - 1 }));

      const scanner = new RecoveryStore(scanDir, { owner: { kind: 'cli' }, maxAttempts: () => 3 });
      const found = await scanner.scanUnfinished();
      const ids = found.map((f) => f.sid).sort();
      check('scanUnfinished returns dead/stale/interrupted only', JSON.stringify(ids) === JSON.stringify(['dead-owner', 'stale-owner', 'was-interrupted']), ids);
      const dead = found.find((f) => f.sid === 'dead-owner');
      check('summary has phase, attempt, max, category', dead?.phase === 'interrupted' && dead.attempt === 2 && dead.max === 3 && dead.category === 'unit_test', dead);
      const reread = new RecoveryStore(scanDir, { owner: { kind: 'cli' } });
      check('scan persisted interrupted', (await reread.load('dead-owner'))?.phase === 'interrupted' && (await reread.load('stale-owner'))?.phase === 'interrupted');
      check('live owner left alone', (await reread.load('live-owner'))?.phase === 'validating');
      check('terminal and idle left alone', (await reread.load('done'))?.phase === 'completed' && (await reread.load('idle'))?.phase === 'idle');
      const keptAttempts = await reread.load('dead-owner');
      check('scan keeps everything else', keptAttempts?.attempts.length === 2);

      const since = await reread.listStates({ since: Date.now() - 60_000 });
      check('listStates returns all states', since.length === 6, since.map((x) => x.sessionId));
      check('listStates since filters', (await reread.listStates({ since: Date.now() + 60_000 })).length === 0);

      // Attempt dirs, deleteSession, prune.
      const ad = reread.attemptDir('dead-owner::child', 2);
      fs.mkdirSync(ad, { recursive: true });
      fs.writeFileSync(path.join(ad, 'x.json'), '{}');
      check('attemptDir under the root session', ad === path.join(scanDir, 'dead-owner', 'attempt-2'));
      await reread.removeAttempts('dead-owner');
      check('removeAttempts', !fs.existsSync(path.join(scanDir, 'dead-owner')));
      fs.mkdirSync(reread.attemptDir('done', 1), { recursive: true });
      await reread.addIntervention(intervention('i-done', 'done', 1));
      await reread.deleteSession('done');
      check(
        'deleteSession removes state, attempts and interventions',
        !fs.existsSync(reread.statePath('done')) && !fs.existsSync(path.join(scanDir, 'done')) && (await reread.listInterventions({ includeResolved: true })).length === 0,
      );
      const later = new RecoveryStore(scanDir, { owner: { kind: 'cli' }, now: () => Date.now() + 31 * 86_400_000 });
      fs.writeFileSync(later.lockPath('live-owner'), JSON.stringify({ pid: process.ppid, host, at: Date.now() + 31 * 86_400_000 }));
      const pruned = await later.prune(30);
      const left = (await later.listStates()).map((x) => x.sessionId);
      check('prune drops old states but keeps live-locked ones', pruned === 4 && JSON.stringify(left) === JSON.stringify(['live-owner']), { pruned, left });
    } finally {
      fs.rmSync(scanDir, { recursive: true, force: true });
    }

    // Interventions index.
    const iv = new RecoveryStore(dir, { owner: { kind: 'vscode' } });
    await Promise.all([
      iv.addIntervention(intervention('i1', 'sess-a', 10)),
      iv.addIntervention(intervention('i2', 'sess-b::worker', 20)),
      iv.addIntervention(intervention('i3', 'sess-b', 30)),
    ]);
    const open = await new RecoveryStore(dir, { owner: { kind: 'cli' } }).listInterventions();
    check('interventions: concurrent adds all persisted, newest first', JSON.stringify(open.map((i) => i.id)) === JSON.stringify(['i3', 'i2', 'i1']), open.map((i) => i.id));
    check('intervention fields round-trip', open[2]?.nextActions[0]?.command === '/recovery resume' && open[2].rootCause === 'wrong argument type');
    await iv.addIntervention({ ...intervention('i1', 'sess-a', 10), title: 'updated' });
    check('add replaces by id', (await iv.listInterventions()).filter((i) => i.id === 'i1').map((i) => i.title).join() === 'updated');
    check('resolve returns true once', (await iv.resolveIntervention('i2', 50)) && !(await iv.resolveIntervention('i2', 60)));
    check('resolved hidden from open list', (await iv.listInterventions()).every((i) => i.id !== 'i2'));
    const all = await iv.listInterventions({ includeResolved: true });
    check('resolved kept with resolvedAt', all.find((i) => i.id === 'i2')?.resolvedAt === 50);
    check('filter by root session', (await iv.listInterventions({ sessionId: 'sess-b::x' })).map((i) => i.id).join() === 'i3');

    // Two processes (different pids) adding interventions at the same time: none is lost.
    const ivA = new RecoveryStore(dir, { owner: { kind: 'vscode' }, pid: 424_242 });
    const ivB = new RecoveryStore(dir, { owner: { kind: 'cli' }, pid: 434_343 });
    const adds: Promise<boolean>[] = [];
    for (let i = 0; i < 12; i++) {
      adds.push(ivA.addIntervention(intervention(`pa-${i}`, 'sess-x', 100 + i)), ivB.addIntervention(intervention(`pb-${i}`, 'sess-y', 200 + i)));
    }
    const addResults = await Promise.all(adds);
    const ids = (await iv.listInterventions({ includeResolved: true })).map((i) => i.id);
    const missing = [...Array(12).keys()].flatMap((i) => [`pa-${i}`, `pb-${i}`]).filter((id) => !ids.includes(id));
    check('cross-process interventions: concurrent adds all persisted', addResults.every((x) => x) && missing.length === 0, missing);
    check('interventions lock released', !fs.existsSync(path.join(dir, 'interventions.lock')));

    await Promise.all([store.dispose(), s2.dispose(), m.dispose(), iv.dispose(), fresh.dispose(), writer.dispose(), reader.dispose(), ivA.dispose(), ivB.dispose()]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
