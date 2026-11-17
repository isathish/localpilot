/**
 * Smoke checks (bundled into scripts/smoke.ts) for the continuity DATA layer: ids, HLC, envelopes, segments and leases,
 * the reducer (property test over 200 interleavings and every merge rule), the sql.js index (incremental == rebuild,
 * search filters, size cap, corrupt file, worker RPC), crypto, migration of real-looking 1.6 data, retention, compaction
 * and backups. Temp dirs only; no network.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { hash26, idTime, isEntityId, newId, stableId, ulid } from '../src/continuity/ids';
import { Lease, leaseIsFree, readLease, withFileLock } from '../src/continuity/data/lease';
import { streamLastSeq } from '../src/continuity/data/eventLog';
import { readStreamDir } from '../src/continuity/data/segment';
import { compactOtherStreams } from '../src/continuity/data/compaction';
import { DataManager } from '../src/continuity/data/dataManager';
import { listBackups } from '../src/continuity/data/backup';
import { newKdf } from '../src/continuity/data/crypto/keyring';
import { FolderBackend } from '../src/continuity/sync/backends/folder';
import { Hlc, MAX_FUTURE_MS } from '../src/continuity/hlc';
import { EventEnvelope, upgradePayload, validateEnvelope } from '../src/continuity/events';
import { FileEventLog, readOrCreateDevice } from '../src/continuity/data/eventLog';
import { listSegments, readSegmentLines } from '../src/continuity/data/segment';
import { DEFAULT_RULES, EntityState, noteEdit, reduce, trashedAt } from '../src/continuity/data/reducer';
import { merge3 } from '../src/continuity/data/textMerge';
import { BlobStore } from '../src/continuity/data/blobs';
import { blobName, open as openSealed, seal, SealError } from '../src/continuity/data/crypto/envelope';
import { changePassphrase, createKeyring, deriveKek, rotateKey, unlockKeyring, WrongPassphraseError } from '../src/continuity/data/crypto/keyring';
import { IndexEngine, loadSqlJs } from '../src/continuity/data/index/engine';
import { LocalIndexClient, WorkerIndexClient } from '../src/continuity/data/index/indexClient';
import { parseInlineFilters, toMatch } from '../src/continuity/data/index/queries';
import { Migration } from '../src/continuity/data/migration';
import { Retention } from '../src/continuity/data/retention';
import { readBackup, restoreBackup, writeBackup, WrongBackupPassphraseError } from '../src/continuity/data/backup';
import { compactOwnStream, redactOwnStream } from '../src/continuity/data/compaction';
import { Continuity } from '../src/continuity/continuity';
import { memorySecretBox } from '../src/continuity/data/crypto/secretBox';
import { chatMessageOf, legacyMessageId, messageFields } from '../src/continuity/conversation/payloads';
import { makeFixture, originalsUntouched } from '../src/test/fixtures/continuityFixtures';
import { ChatMessage } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-cont-${p}-`));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A deterministic PRNG for the property test. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function ev(stream: string, seq: number, hlc: string, ent: EventEnvelope['ent'], eid: string, op: EventEnvelope['op'], p: Record<string, unknown>, base?: string): EventEnvelope {
  return { v: 1, id: `${stream}:${seq}`, stream, seq, hlc, dev: hlc.split('-').slice(2).join('-'), ent, eid, op, sv: 1, p, ...(base ? { base } : {}) };
}

/** Canonical JSON (keys sorted at every level) of everything but the bounded version/edit bookkeeping. */
function stableState(s: EntityState | undefined): string {
  if (!s) {
    return 'undefined';
  }
  const { texts: _t, edits: _e, ...rest } = s;
  void _t;
  void _e;
  const canon = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(canon(rest));
}

export async function continuitySmoke(check: Check): Promise<void> {
  console.log('\n[continuity: ids, HLC, envelopes]');
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_000);
  check('ulid: 26 chars, monotonic within a millisecond', a.length === 26 && b > a, [a, b]);
  check('newId: prefix + time', /^m_[0-9A-Z]{26}$/.test(newId('m', 42)) && idTime(newId('m', 1_700_000_000_123)) === 1_700_000_000_123);
  check('stableId: deterministic, lower-case, no time', stableId('m', 's_1', '0', 'user', 'hi') === stableId('m', 's_1', '0', 'user', 'hi') && stableId('m', 'x') !== stableId('m', 'y') && idTime(stableId('m', 'x')) === undefined && hash26('a').length === 26);
  check('isEntityId: safe names only', isEntityId('s_01H') && isEntityId('cli-abc.1') && !isEntityId('../x') && !isEntityId('.hidden') && !isEntityId('a/b'));
  let wall = 1_000_000;
  const clock = new Hlc('dev_A', () => wall);
  const h1 = clock.tick();
  wall = 900_000; // clock goes backwards
  const h2 = clock.tick();
  check('HLC: monotonic when the wall clock goes backwards', h2 > h1 && Hlc.physical(h2) === 1_000_000, [h1, h2]);
  const far = `${(wall + MAX_FUTURE_MS * 3).toString(16).padStart(12, '0')}-0000-dev_B`;
  const r = clock.observe(far);
  const h3 = clock.tick();
  check('HLC: a remote stamp far in the future is clamped and reported', !!r.skewMs && Hlc.physical(h3) <= wall + MAX_FUTURE_MS + 1 && h3 > h2, [r, h3]);
  clock.observe(`${(1_000_500).toString(16).padStart(12, '0')}-0007-dev_C`);
  check('HLC: observe moves past a remote stamp', clock.tick() > `${(1_000_500).toString(16).padStart(12, '0')}-0007-dev_C`);
  check('HLC: compare / physical / device', Hlc.compare('0001-0000-a', '0002-0000-a') < 0 && Hlc.device(h1) === 'dev_A');
  const good = ev('dev_A.1', 1, h1, 'conversation', 's_1', 'create', { title: 'x' });
  check('envelope: valid', validateEnvelope(good) === undefined);
  check('envelope: bad seq / id / op rejected; an unknown op (a newer build) is well-formed but never applied', !!validateEnvelope({ ...good, seq: 0 }) && !!validateEnvelope({ ...good, id: 'x' }) && !!validateEnvelope({ ...good, op: 'Zap!' as never }) && validateEnvelope({ ...good, op: 'zap' as never }) === undefined && reduce(undefined, { ...good, op: 'zap' as never }).changed.length === 0);
  check('envelope: unknown kind and newer sv are well-formed but not applied', validateEnvelope({ ...good, ent: 'hologram' }) === undefined && upgradePayload('conversation', 99, {}) === undefined && reduce(undefined, { ...good, sv: 99 }).changed.length === 0);

  console.log('\n[continuity: event log, segments, leases]');
  const root = tmp('log');
  const log = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 5, segmentMaxBytes: 600 });
  const dev = readOrCreateDevice(root);
  check('device.json created once and reused', dev.deviceId === log.device.deviceId && /^dev_/.test(dev.deviceId));
  const appended: EventEnvelope[] = [];
  for (let i = 0; i < 12; i++) {
    appended.push(log.append('conversation', 's_a', 'patch', { title: `Title ${i}` }));
  }
  await log.flush();
  const back: EventEnvelope[] = [];
  for await (const e of log.read(log.stream)) {
    back.push(e);
  }
  check('append -> read round trip, gapless seq', back.length === 12 && back.every((e, i) => e.seq === i + 1 && e.id === appended[i].id));
  check('rotation at the segment size cap', listSegments(log.ownStreamDir).length > 1, listSegments(log.ownStreamDir).map((f) => path.basename(f.file)));
  const loc = log.locOf(appended[7])!;
  check('readAt by location', (await log.readAt(loc)).p.title === 'Title 7');
  const log2 = FileEventLog.open({ root, writer: 'vscode', log: quiet });
  check('two writers get two streams', log2.stream !== log.stream && log2.stream.startsWith(dev.deviceId));
  await log2.dispose();
  // Torn last line + dead-pid takeover.
  const active = listSegments(log.ownStreamDir).filter((f) => !f.compact).pop()!;
  await log.dispose();
  fs.appendFileSync(active.file, '{"v":1,"id":"torn');
  fs.writeFileSync(path.join(log.ownStreamDir, 'lease.json'), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), kind: 'cli', at: Date.now() }));
  const reopened = FileEventLog.open({ root, writer: 'cli', log: quiet });
  check('lease of a dead pid is taken over (same stream)', reopened.stream === log.stream);
  check('torn last line repaired, seq continues', reopened.repairedBytes > 0 && reopened.lastSequence === 12 && reopened.append('conversation', 's_a', 'patch', { pinned: true }).seq === 13);
  await reopened.dispose();
  const other = FileEventLog.open({ root: tmp('log2'), writer: 'cli', log: quiet });
  const foreign = 'dev_ZZZ.1';
  const mk = (seq: number) => ev(foreign, seq, `${seq.toString(16).padStart(12, '0')}-0000-dev_ZZZ`, 'conversation', 's_f', 'patch', { title: `f${seq}` });
  const imp = await other.importRemote(foreign, [mk(1), mk(2), mk(3)]);
  let gap = '';
  await other.importRemote(foreign, [mk(5)]).catch((e: Error) => (gap = e.message));
  const again = await other.importRemote(foreign, [mk(2), mk(3), mk(4)]);
  check('importRemote: appends, dedups, rejects a gap', imp.imported === 3 && /gap/.test(gap) && again.imported === 1 && again.skipped === 2, { imp, gap, again });
  await other.dispose();

  console.log('\n[continuity: reducer and merge rules]');
  const H = (ms: number, c: number, d: string) => `${ms.toString(16).padStart(12, '0')}-${c.toString(16).padStart(4, '0')}-${d}`;
  let st = reduce(undefined, ev('dev_A.1', 1, H(10, 0, 'dev_A'), 'conversation', 's_r', 'create', { title: 'One', pinned: false, tags: { a: true } })).state;
  st = reduce(st, ev('dev_B.1', 1, H(12, 0, 'dev_B'), 'conversation', 's_r', 'patch', { pinned: true, tags: { b: true } })).state;
  st = reduce(st, ev('dev_A.1', 2, H(11, 0, 'dev_A'), 'conversation', 's_r', 'patch', { pinned: false, tags: { a: false } })).state;
  check('LWW per field (older patch loses), map fields merged per key', st.fields.pinned === true && JSON.stringify(st.fields.tags) === '{"a":false,"b":true}', st.fields);
  const st2 = reduce(st, ev('dev_B.1', 1, H(12, 0, 'dev_B'), 'conversation', 's_r', 'patch', { pinned: true, tags: { b: true } })).state;
  check('re-applying an event changes nothing', stableState(st2) === stableState(st));
  let tr = reduce(st, ev('dev_A.1', 3, H(20, 0, 'dev_A'), 'conversation', 's_r', 'trash', { at: 20 })).state;
  check('trash sets trashedAt', trashedAt(tr) === 20);
  tr = reduce(tr, ev('dev_A.1', 4, H(21, 0, 'dev_A'), 'conversation', 's_r', 'restore', { at: 21 })).state;
  check('restore clears it (LWW register)', trashedAt(tr) === undefined);
  const purged = reduce(tr, ev('dev_A.1', 5, H(22, 0, 'dev_A'), 'conversation', 's_r', 'purge', { at: 22 })).state;
  const after = reduce(purged, ev('dev_B.1', 9, H(30, 0, 'dev_B'), 'conversation', 's_r', 'patch', { title: 'Zombie' }));
  check('purge is terminal', !!purged.purged && !after.changed.length && after.state.fields.title === undefined);
  // Title conflict: concurrent non-default titles from two devices.
  const t0 = reduce(undefined, ev('dev_A.1', 1, H(10, 0, 'dev_A'), 'conversation', 's_t', 'create', { title: 'New chat' })).state;
  const tA = reduce(t0, ev('dev_A.1', 2, H(20, 0, 'dev_A'), 'conversation', 's_t', 'patch', { title: 'API bug' }, H(10, 0, 'dev_A')));
  const tB = reduce(tA.state, ev('dev_B.1', 1, H(21, 0, 'dev_B'), 'conversation', 's_t', 'patch', { title: 'Postgres down' }, H(10, 0, 'dev_A')));
  const tB2 = reduce(reduce(t0, ev('dev_B.1', 1, H(21, 0, 'dev_B'), 'conversation', 's_t', 'patch', { title: 'Postgres down' }, H(10, 0, 'dev_A'))).state, ev('dev_A.1', 2, H(20, 0, 'dev_A'), 'conversation', 's_t', 'patch', { title: 'API bug' }, H(10, 0, 'dev_A')));
  check('concurrent titles: later wins, a field conflict is reported in either order', tB.state.fields.title === 'Postgres down' && tB.conflicts[0]?.kind === 'field' && tB2.state.fields.title === 'Postgres down' && tB2.conflicts[0]?.id === tB.conflicts[0]?.id, [tB.conflicts, tB2.conflicts]);
  const seq = reduce(tA.state, ev('dev_B.1', 1, H(21, 0, 'dev_B'), 'conversation', 's_t', 'patch', { title: 'Seen it' }, H(20, 0, 'dev_A')));
  check('a title written after seeing the other is no conflict', !seq.conflicts.length && seq.state.fields.title === 'Seen it');
  // Trash vs edit.
  const c0 = reduce(undefined, ev('dev_A.1', 1, H(10, 0, 'dev_A'), 'conversation', 's_x', 'create', { title: 'T' })).state;
  const trashed = reduce(c0, ev('dev_A.1', 2, H(20, 0, 'dev_A'), 'conversation', 's_x', 'trash', { at: 20 }, H(10, 0, 'dev_A'))).state;
  const edited = noteEdit(trashed, 's_x', { hlc: H(19, 0, 'dev_B'), base: H(10, 0, 'dev_A') });
  const editedFirst = reduce(noteEdit(c0, 's_x', { hlc: H(19, 0, 'dev_B'), base: H(10, 0, 'dev_A') }).state, ev('dev_A.1', 2, H(20, 0, 'dev_A'), 'conversation', 's_x', 'trash', { at: 20 }, H(10, 0, 'dev_A')));
  check('trash vs a concurrent edit: restored, conflict reported, same in either order', trashedAt(edited.state) === undefined && edited.conflicts[0]?.kind === 'trash-vs-edit' && trashedAt(editedFirst.state) === undefined && editedFirst.conflicts[0]?.kind === 'trash-vs-edit');
  const seenEdit = noteEdit(trashed, 's_x', { hlc: H(25, 0, 'dev_B'), base: H(20, 0, 'dev_A') });
  check('an edit that saw the trash does not restore', trashedAt(seenEdit.state) === 20 && !seenEdit.conflicts.length);
  // 3-way text merge.
  check('merge3: clean merge of separate lines', merge3('a\nb\nc\nd', 'A\nb\nc\nd', 'a\nb\nc\nD').text === 'A\nb\nc\nD' && !merge3('a\nb\nc\nd', 'A\nb\nc\nd', 'a\nb\nc\nD').conflict);
  const ov = merge3('a\nb\nc', 'a\nX\nc', 'a\nY\nc');
  check('merge3: overlap -> later side applied, conflict', ov.text === 'a\nY\nc' && ov.conflict);
  const m0 = reduce(undefined, ev('dev_A.1', 1, H(10, 0, 'dev_A'), 'memory', 'mem_1', 'create', { type: 'project', name: 'build', body: 'one\ntwo\nthree\nfour' })).state;
  const ma = ev('dev_A.1', 2, H(20, 0, 'dev_A'), 'memory', 'mem_1', 'patch', { body: 'ONE\ntwo\nthree\nfour' }, H(10, 0, 'dev_A'));
  const mb = ev('dev_B.1', 1, H(21, 0, 'dev_B'), 'memory', 'mem_1', 'patch', { body: 'one\ntwo\nthree\nFOUR' }, H(10, 0, 'dev_A'));
  const mab = reduce(reduce(m0, ma).state, mb).state;
  const mba = reduce(reduce(m0, mb).state, ma).state;
  check('memory body: concurrent edits merged line by line, same in either order', mab.fields.body === 'ONE\ntwo\nthree\nFOUR' && mba.fields.body === mab.fields.body, [mab.fields.body, mba.fields.body]);
  const mc = ev('dev_B.1', 1, H(21, 0, 'dev_B'), 'memory', 'mem_1', 'patch', { body: 'Uno\ntwo\nthree\nfour' }, H(10, 0, 'dev_A'));
  const mOver = reduce(reduce(m0, ma).state, mc);
  check('memory body: overlapping edits -> text-merge conflict, later applied', mOver.state.fields.body === 'Uno\ntwo\nthree\nfour' && mOver.conflicts[0]?.kind === 'text-merge');
  // Property test: 3 streams, 200 interleavings keeping per-stream order -> identical state.
  const rand = rng(7);
  const streams: EventEnvelope[][] = ['dev_A', 'dev_B', 'dev_C'].map((d, k) => {
    const list: EventEnvelope[] = [];
    for (let i = 0; i < 25; i++) {
      const t = 100 + i * 3 + k;
      const pick = Math.floor(rand() * 6);
      const p: Record<string, unknown> = pick === 0 ? { title: `${d} ${i}` } : pick === 1 ? { pinned: rand() > 0.5 } : pick === 2 ? { tags: { [`t${Math.floor(rand() * 4)}`]: rand() > 0.3 } } : pick === 3 ? { model: `m${i}` } : {};
      const op: EventEnvelope['op'] = pick === 4 ? (rand() > 0.5 ? 'trash' : 'restore') : i === 0 && k === 0 ? 'create' : 'patch';
      list.push(ev(`${d}.1`, i + 1, H(t, 0, d), 'conversation', 's_p', op, op === 'trash' || op === 'restore' ? { at: t } : p, rand() > 0.5 ? H(t - 5, 0, 'dev_A') : undefined));
    }
    return list;
  });
  let reference: string | undefined;
  let mismatch = 0;
  for (let run = 0; run < 200; run++) {
    const cursors = [0, 0, 0];
    let s: EntityState | undefined;
    while (cursors.some((c, i) => c < streams[i].length)) {
      const open = [0, 1, 2].filter((i) => cursors[i] < streams[i].length);
      const i = open[Math.floor(rand() * open.length)];
      s = reduce(s, streams[i][cursors[i]++], DEFAULT_RULES).state;
    }
    const sig = stableState(s);
    reference ??= sig;
    if (sig !== reference) {
      mismatch++;
    }
  }
  check('property: 200 random interleavings of 3 streams give the same state', mismatch === 0, mismatch);
  // Same for memory bodies (3-way merges) and for a conversation's trash register against messages appended to it.
  const lines = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta'];
  const memStreams: EventEnvelope[][] = ['dev_A', 'dev_B', 'dev_C'].map((d, k) =>
    Array.from({ length: 8 }, (_, i) => {
      const t = 200 + i * 3 + k;
      const body = lines.map((l, j) => (j % 3 === k && j <= i ? `${l}-${d}${i}` : l)).join('\n');
      return ev(`${d}.1`, i + 1, H(t, 0, d), 'memory', 'mem_p', i === 0 && k === 0 ? 'create' : 'patch', { body }, H(t - 4 - Math.floor(rand() * 6), 0, 'dev_A'));
    })
  );
  const convStreams: EventEnvelope[][] = ['dev_A', 'dev_B'].map((d, k) =>
    Array.from({ length: 10 }, (_, i) => ev(`${d}.1`, i + 1, H(300 + i * 2 + k, 0, d), 'conversation', 's_q', i % 4 === 0 ? 'trash' : i % 4 === 2 ? 'restore' : 'patch', i % 2 === 0 ? { at: i } : { title: `${d}${i}` }, H(300 + i * 2 + k - 3, 0, 'dev_A')))
  );
  const edits = Array.from({ length: 6 }, (_, i) => ({ hlc: H(301 + i * 3, 1, 'dev_C'), base: H(298 + i * 3, 0, 'dev_A') }));
  let memRef: string | undefined;
  let convRef: string | undefined;
  let memBad = 0;
  let convBad = 0;
  for (let run = 0; run < 200; run++) {
    const cur = [0, 0, 0];
    let m: EntityState | undefined;
    while (cur.some((c, i) => c < memStreams[i].length)) {
      const open = [0, 1, 2].filter((i) => cur[i] < memStreams[i].length);
      const i = open[Math.floor(rand() * open.length)];
      m = reduce(m, memStreams[i][cur[i]++]).state;
    }
    const ms = String(m?.fields.body);
    memRef ??= ms;
    memBad += ms === memRef ? 0 : 1;
    const cc = [0, 0, 0];
    let cs: EntityState | undefined;
    const all = [...convStreams, edits as unknown as EventEnvelope[]];
    while (cc.some((c, i) => c < all[i].length)) {
      const open = [0, 1, 2].filter((i) => cc[i] < all[i].length);
      const i = open[Math.floor(rand() * open.length)];
      cs = i === 2 ? noteEdit(cs, 's_q', edits[cc[i]++]).state : reduce(cs, all[i][cc[i]++]).state;
    }
    const sig = JSON.stringify([cs?.fields.title, trashedAt(cs), cs?.clocks.trashedAt]);
    convRef ??= sig;
    convBad += sig === convRef ? 0 : 1;
  }
  check('property: memory bodies merge to the same text in 200 interleavings', memBad === 0, [memBad, memRef]);
  check('property: trash register vs appended messages settles the same in 200 interleavings', convBad === 0, [convBad, convRef]);

  console.log('\n[continuity: crypto]');
  const rfc = await deriveKek('password', { alg: 'scrypt', N: 1024, r: 8, p: 16, salt: Buffer.from('NaCl').toString('base64') });
  check('scrypt known answer (RFC 7914 vector)', rfc.toString('hex') === 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162');
  const fixedKey = { keyId: '00112233445566778899aabbccddeeff', dek: Buffer.alloc(32, 7) };
  const kat = seal(fixedKey, 'streams/dev_A.1/000000000001-000000000002.lpe', 'hello', { iv: Buffer.alloc(12, 1) });
  check('LPE1 layout: magic | keyId | iv | ct | tag', kat.subarray(0, 4).toString() === 'LPE1' && kat.subarray(4, 20).toString('hex') === fixedKey.keyId && kat.subarray(20, 32).equals(Buffer.alloc(12, 1)));
  check('seal/open round trip', openSealed([fixedKey], 'streams/dev_A.1/000000000001-000000000002.lpe', kat).toString() === 'hello');
  const tampered = Buffer.from(kat);
  tampered[40] ^= 1;
  const fails = (f: () => unknown) => {
    try {
      f();
      return false;
    } catch (e) {
      return e instanceof SealError;
    }
  };
  check('tampered byte fails authentication', fails(() => openSealed([fixedKey], 'streams/dev_A.1/000000000001-000000000002.lpe', tampered)));
  check('object moved to another name (AAD) fails', fails(() => openSealed([fixedKey], 'streams/dev_A.1/000000000003-000000000004.lpe', kat)));
  check('unknown key id fails', fails(() => openSealed([{ ...fixedKey, keyId: 'ff'.repeat(16) }], 'x', seal({ ...fixedKey, keyId: 'ee'.repeat(16) }, 'x', 'y'))));
  const ring = await createKeyring('correct horse battery', { N: 2 ** 14 });
  const unlocked = await unlockKeyring(ring.file, 'correct horse battery');
  let wrong = false;
  await unlockKeyring(ring.file, 'wrong horse').catch((e) => (wrong = e instanceof WrongPassphraseError));
  check('keyring: right passphrase unlocks the DEK, wrong one fails', unlocked[0].dek.equals(ring.keys[0].dek) && wrong);
  const changed = await changePassphrase(ring.file, 'correct horse battery', 'new staple', { N: 2 ** 14 });
  const afterChange = await unlockKeyring(changed, 'new staple');
  check('passphrase change keeps the DEK and changes the salt', afterChange[0].dek.equals(ring.keys[0].dek) && changed.kdf.salt !== ring.file.kdf.salt);
  const oldObj = seal(ring.keys[0], 'o1', 'old data');
  const rot = await rotateKey(changed, 'new staple');
  const newObj = seal(rot.key, 'o2', 'new data');
  check('rotation: new current key, old objects still readable, old key cannot read new objects', rot.file.current !== ring.file.current && openSealed(rot.keys, 'o1', oldObj).toString() === 'old data' && fails(() => openSealed([ring.keys[0]], 'o2', newObj)));
  check('blob names are keyed HMACs', blobName(Buffer.alloc(32, 1), 'ab'.repeat(32)) !== blobName(Buffer.alloc(32, 2), 'ab'.repeat(32)));

  console.log('\n[continuity: index]');
  const SQL = await loadSqlJs(process.env.LOCALPILOT_SQLJS_WASM);
  const iroot = tmp('idx');
  const ilog = FileEventLog.open({ root: iroot, writer: 'cli', log: quiet, flushMs: 1 });
  const conv = (id: string, title: string, extra: Record<string, unknown> = {}) => ilog.append('conversation', id, 'create', { title, model: 'ollama/qwen3', mode: 'agent', pinned: false, favorite: false, archived: false, tags: {}, activeBranchId: `br_${id}`, createdAt: Date.now(), ...extra });
  ilog.append('project', 'prj_api', 'create', { name: 'api', fingerprints: { pathHash: { [ilog.device.deviceId]: 'h1' } }, paths: { [ilog.device.deviceId]: '/w/api' }, createdAt: 1 });
  conv('s_1', 'Fix ECONNREFUSED', { projectId: 'prj_api', tags: { release: true } });
  conv('s_2', 'Write docs', { favorite: true });
  conv('s_3', 'Old archived', { archived: true });
  const msg = (cid: string, id: string, parent: string | undefined, role: string, parts: unknown[]) => ilog.append('message', id, 'create', { conversationId: cid, branchId: `br_${cid}`, ...(parent ? { parentId: parent } : {}), role, parts, meta: {}, createdAt: Date.now() });
  ilog.append('branch', 'br_s_1', 'create', { conversationId: 's_1', createdAt: 1 });
  msg('s_1', 'm_1', undefined, 'user', [{ kind: 'text', text: 'The api fails with ECONNREFUSED on startup' }]);
  msg('s_1', 'm_2', 'm_1', 'assistant', [{ kind: 'text', text: 'Run this:\n```sh\ndocker compose up -d postgres\n```' }, { kind: 'tool_call', callId: 'c1', name: 'run_command', args: '{"command":"npm test"}' }]);
  msg('s_1', 'm_3', 'm_2', 'tool', [{ kind: 'tool_result', callId: 'c1', name: 'run_command', text: 'Traceback: KeyError email', isError: true }]);
  msg('s_2', 'm_4', undefined, 'user', [{ kind: 'text', text: 'Document the postgres setup' }]);
  ilog.append('memory', 'mem_b', 'create', { type: 'project', name: 'build', body: 'npm test needs postgres', summary: 'npm test', projectId: 'prj_api', source: 'user', tags: {}, createdAt: 1 });
  await ilog.flush();
  const eng = new IndexEngine({ root: iroot, deviceId: ilog.device.deviceId, ownStream: ilog.stream, sqlJs: SQL, persistIntervalMs: 0 });
  await eng.init();
  check(`FTS module probed (${eng.fts}); bundled sql.js has no FTS5, so FTS4`, eng.fts === 'fts4' || eng.fts === 'fts5');
  const counts = eng.counts();
  check('counts: All / Favorites / Archived / projects', counts.all === 2 && counts.favorites === 1 && counts.archived === 1 && counts.projects[0]?.name === 'api' && counts.projects[0].count === 1, counts);
  check('history: project filter and tags', eng.history({ projectId: 'prj_api' }).rows.map((r) => r.id).join() === 's_1' && eng.history({ tag: 'release' }).total === 1);
  const hits = eng.search('econnrefused');
  check('search: words in titles and messages', hits.some((h) => h.field === 'title' && h.conversationId === 's_1') && hits.some((h) => h.messageId === 'm_1') && hits.every((h) => h.conversationId === 's_1'), hits);
  check('search: in:code finds code blocks and tool args only', eng.search('in:code docker').map((h) => h.messageId).join() === 'm_2' && !eng.search('in:code econnrefused').length);
  check('search: in:errors finds failed tool output', eng.search('in:errors keyerror').map((h) => h.messageId).join() === 'm_3');
  check('search: from:user, project:, is:favorite, -exclude', eng.search('postgres from:user').every((h) => h.role === 'user') && eng.search('postgres project:api').every((h) => h.conversationId === 's_1') && eng.search('is:favorite postgres').every((h) => h.conversationId === 's_2') && !eng.search('postgres -docs -compose -document -setup').some((h) => h.conversationId === 's_2'));
  check('search snippets mark the match', hits.some((h) => h.snippet.includes('\u0002')));
  check('inline filter parser', JSON.stringify(parseInlineFilters('in:code,errors from:user tag:x is:pinned after:2026-01-01 boom')) .includes('"text":"boom"') && toMatch('foo.bar -baz "a b" pre*', 'fts4') === '"foo bar" "a b" pre* NOT baz');
  check('messages: path of the branch with body locations', eng.messages('s_1').map((m) => m.id).join() === 'm_1,m_2,m_3' && (await ilog.readAt(eng.messages('s_1')[2].loc)).eid === 'm_3');
  check('memory rows and memory search', eng.memory({ type: 'project' })[0]?.name === 'build' && eng.searchMemory('postgres')[0]?.memoryId === 'mem_b');
  // Incremental == rebuild after more random events.
  const r2 = rng(3);
  for (let i = 0; i < 300; i++) {
    const id = `s_${1 + Math.floor(r2() * 3)}`;
    const k = Math.floor(r2() * 5);
    if (k === 0) {
      ilog.append('conversation', id, 'patch', { title: `T${i}` });
    } else if (k === 1) {
      ilog.append('conversation', id, 'patch', { favorite: r2() > 0.5, tags: { [`x${i % 3}`]: r2() > 0.5 } });
    } else if (k === 2) {
      ilog.append('conversation', id, r2() > 0.5 ? 'trash' : 'restore', { at: i });
    } else {
      msg(id, `m_r${i}`, undefined, r2() > 0.5 ? 'user' : 'assistant', [{ kind: 'text', text: `word${i} common` }]);
    }
  }
  await ilog.flush();
  eng.catchUp();
  const dump = (e: IndexEngine) => JSON.stringify([e.history({ view: 'all', limit: 500 }), e.history({ view: 'trash', limit: 500 }), e.counts(), e.search('common').length, e.messages('s_2').length]);
  const incremental = dump(eng);
  eng.rebuild();
  check('incremental index == full rebuild', dump(eng) === incremental);
  eng.dispose();
  const reloaded = new IndexEngine({ root: iroot, deviceId: ilog.device.deviceId, sqlJs: SQL });
  await reloaded.init();
  check('loads the persisted index file', dump(reloaded) === incremental && reloaded.status().holder);
  reloaded.dispose();
  fs.writeFileSync(path.join(iroot, 'index', 'index.sqlite'), Buffer.from('this is not a database at all'));
  const healed = new IndexEngine({ root: iroot, deviceId: ilog.device.deviceId, sqlJs: SQL });
  await healed.init();
  check('a corrupt index file is rebuilt from the log', dump(healed) === incremental);
  // Size cap: archived old chats lose their message text, titles stay.
  ilog.append('conversation', 's_old', 'create', { title: 'Ancient archived chat', archived: true, createdAt: 1, updatedAt: 1, tags: {}, pinned: false, favorite: false, model: '', mode: 'agent', activeBranchId: 'br_s_old' });
  ilog.append('message', 'm_old', 'create', { conversationId: 's_old', branchId: 'br_s_old', role: 'user', parts: [{ kind: 'text', text: 'zanzibar '.repeat(2000) }], meta: {}, createdAt: 1 });
  await ilog.flush();
  healed.catchUp();
  healed.db.run("UPDATE conversations SET updated_at = 1 WHERE id = 's_old'");
  const dropped = healed.enforceCap(0.01);
  check('size cap: old archived chats become title-only', dropped >= 1 && !healed.search({ text: 'zanzibar', includeArchived: true, in: ['messages'] }).length && healed.search({ text: 'ancient', includeArchived: true }).length === 1 && healed.counts().titleOnly >= 1);
  healed.dispose();
  // Worker RPC round trip (the bundled worker built next to the smoke bundle).
  const workerFile = process.env.LOCALPILOT_CONTINUITY_WORKER;
  if (workerFile && fs.existsSync(workerFile)) {
    const wc = new WorkerIndexClient(workerFile, { root: iroot, deviceId: ilog.device.deviceId, wasmPath: process.env.LOCALPILOT_SQLJS_WASM, watch: false });
    await wc.ready;
    const st0 = await wc.status();
    const wh = await wc.search({ text: 'common', includeTrash: true, includeArchived: true });
    check('worker RPC: status and search across the thread boundary', st0.state === 'ready' && wh.length > 0, st0);
    await wc.dispose();
  } else {
    check('worker bundle present for the RPC check', false, workerFile);
  }
  await ilog.dispose();

  console.log('\n[continuity: migration]');
  const fx = makeFixture();
  const mroot = tmp('mig');
  const mlog = FileEventLog.open({ root: mroot, writer: 'vscode', log: quiet, flushMs: 1 });
  const mblobs = new BlobStore(mroot);
  const interrupted = await new Migration({ root: mroot, log: mlog, blobs: mblobs, sources: fx.sources, failAfter: 3 }).run();
  check('migration interrupted after 3 files', interrupted.state === 'failed' && !new Migration({ root: mroot, log: mlog, blobs: mblobs, sources: fx.sources }).readState().completedAt);
  const mig = new Migration({ root: mroot, log: mlog, blobs: mblobs, sources: fx.sources, logger: quiet });
  const full = await mig.run();
  const seqAfter = mlog.lastSequence;
  const status = mig.status();
  check('resumed migration completes; the corrupt chat is recorded as failed', full.state === 'done' && status.failed.length === 1 && /s_corrupt/.test(status.failed[0].path), status);
  const meng = new IndexEngine({ root: mroot, deviceId: mlog.device.deviceId, sqlJs: SQL });
  await meng.init();
  const mh = meng.history({ limit: 100 }).rows;
  check('every chat imported once (VS Code, other workspace, CLI), empty chat skipped', [fx.ids.vscodeChat, fx.ids.archivedChat, fx.ids.cliChat, fx.ids.goneChat].every((id) => mh.some((r) => r.id === id)) && !mh.some((r) => r.id === fx.ids.emptyChat) && mh.length === 4, mh.map((r) => r.id));
  check('message counts: archive + current, no duplicate of the archived copy', Object.entries(fx.expectedMessages).every(([id, n]) => meng.messages(id).length === n), Object.fromEntries(Object.keys(fx.expectedMessages).map((id) => [id, meng.messages(id).length])));
  check('origin, pin, project from folder and from workspace.json', mh.find((r) => r.id === fx.ids.cliChat)?.origin === 'cli' && !!mh.find((r) => r.id === fx.ids.vscodeChat)?.pinned && mh.find((r) => r.id === fx.ids.vscodeChat)?.projectId === mh.find((r) => r.id === fx.ids.cliChat)?.projectId && mh.find((r) => r.id === fx.ids.goneChat)?.projectName === 'deleted-app');
  const firstMsg = meng.messages(fx.ids.vscodeChat)[0];
  const body = await mlog.readAt(firstMsg.loc);
  const att = (body.p as { parts: { kind: string; attachmentId?: string }[] }).parts.find((p) => p.kind === 'image');
  const attRow = att ? (meng.db.get<{ blob: string }>('SELECT blob FROM attachments WHERE id = ?', [att.attachmentId!])) : undefined;
  check('images became blobs + attachment entities', !!attRow && mblobs.get(attRow.blob)?.toString('base64') === 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
  check('search finds migrated errors and code', meng.search('in:errors econnrefused').some((h) => h.conversationId === fx.ids.vscodeChat) && meng.search('in:code docker').length > 0);
  check('traces -> agent session + execution events; recovery -> interrupted run; checkpoint', (meng.query('agentSessions', { conversationId: fx.ids.vscodeChat }) as { outcome: string }[]).length === 2 && meng.query('executionEvents', { agentSessionId: 'as_' + hash26('tr_1') }).length === 2 && (meng.query('checkpoints', { conversationId: fx.ids.vscodeChat }) as unknown[]).length === 1);
  const mems = meng.memory({});
  check('memory: project note, VS Code + CLI global notes as developer memory', mems.some((m) => m.type === 'project' && m.name === 'build' && !!m.projectId) && mems.filter((m) => m.type === 'developer').length === 2, mems.map((m) => `${m.type}:${m.name}`));
  check('custom command -> prompt template', (meng.db.get<{ n: number }>('SELECT count(*) AS n FROM prompt_templates')?.n ?? 0) === 1);
  const msgId = legacyMessageId(fx.ids.vscodeChat, { role: 'user', content: 'The client fails with ECONNREFUSED 127.0.0.1:5432' }, 0);
  check('message ids are deterministic (the bridge reproduces them)', firstMsg.id === msgId);
  const rerun = await new Migration({ root: mroot, log: mlog, blobs: mblobs, sources: fx.sources }).run({ force: true });
  check('re-running the migration writes no new events', rerun.state === 'done' && mlog.lastSequence === seqAfter, [seqAfter, mlog.lastSequence]);
  check('originals untouched, copies in legacy-backup', originalsUntouched(fx).length === 0 && status.backupBytes > 0 && fs.existsSync(path.join(status.backupDir!, 'vscode', 'abc123', 'sessions', `${fx.ids.vscodeChat}.json`)));
  fs.writeFileSync(path.join(path.dirname(status.failed[0].path), 's_corrupt.json'), JSON.stringify({ id: 's_corrupt', title: 'Fixed', messages: [{ role: 'user', content: 'now readable' }], createdAt: 1, updatedAt: 2, model: '', mode: 'agent' }));
  await mig.run({ retry: true });
  check('Retry imports a fixed file', mig.status().failed.length === 0);
  meng.dispose();
  // The CLI ran 1.7 first (it sees only its own sources); a VS Code window opened later still imports its profile.
  const groot = tmp('mig-groups');
  const glog = FileEventLog.open({ root: groot, writer: 'cli', log: quiet, flushMs: 1 });
  const cliOnly = new Migration({ root: groot, log: glog, blobs: new BlobStore(groot), sources: { cliDataDir: fx.sources.cliDataDir, home: fx.sources.home } });
  await cliOnly.run();
  const vsLater = new Migration({ root: groot, log: glog, blobs: new BlobStore(groot), sources: fx.sources });
  const neededBefore = vsLater.needed();
  await vsLater.run();
  const geng = new IndexEngine({ root: groot, deviceId: glog.device.deviceId, sqlJs: SQL });
  await geng.init();
  check('migration per source group: VS Code chats imported after a CLI-only first run', neededBefore && !vsLater.needed() && geng.history({ limit: 50 }).total === 5 /* the corrupt chat was fixed above */, geng.history({ limit: 50 }).rows.map((r) => r.id));
  geng.dispose();
  await glog.dispose();

  console.log('\n[continuity: payloads round trip]');
  const blobs2 = new BlobStore(tmp('pl'));
  const original: ChatMessage = { role: 'assistant', content: 'x'.repeat(70 * 1024), thinking: 'hmm', toolCalls: [{ id: 'c', name: 'read_file', arguments: '{"path":"a"}' }], meta: { timestamp: 5, model: 'm' } };
  const p = messageFields('s_1', 'br_s_1', undefined, original, { blobs: blobs2 });
  const restored = chatMessageOf('m_x', p.fields, { blobs: blobs2 });
  check('ChatMessage -> payload -> ChatMessage (big text via blob)', restored.content === original.content && restored.thinking === 'hmm' && restored.toolCalls?.[0].arguments === '{"path":"a"}' && restored.meta?.id === 'm_x' && (p.fields.parts[0] as { truncated?: boolean }).truncated === true);

  console.log('\n[continuity: retention, compaction, backup]');
  let now = Date.UTC(2026, 0, 1);
  const rroot = tmp('ret');
  const rlog = FileEventLog.open({ root: rroot, writer: 'cli', log: quiet, flushMs: 1, now: () => now, segmentMaxBytes: 2000 });
  const rindex = new LocalIndexClient({ root: rroot, deviceId: rlog.device.deviceId, ownStream: rlog.stream, sqlJs: SQL, now: () => now });
  const rblobs = new BlobStore(rroot, () => now);
  const ret = new Retention({ log: rlog, index: rindex, blobs: rblobs, settings: () => ({ trashRetentionDays: 30, historyDays: 90 }), now: () => now });
  const purgedHook: string[] = [];
  ret.onPurge((_e, id) => void purgedHook.push(id));
  for (const id of ['s_keep', 's_gone']) {
    rlog.append('conversation', id, 'create', { title: id, tags: {}, pinned: false, favorite: false, archived: false, model: '', mode: 'agent', activeBranchId: `br_${id}`, createdAt: now });
    rlog.append('message', `m_${id}`, 'create', { conversationId: id, branchId: `br_${id}`, role: 'user', parts: [{ kind: 'text', text: `secret text of ${id}` }], meta: {}, createdAt: now });
  }
  const blobSha = rblobs.put('attachment of s_gone');
  // Blob ages come from the file system: date it to the injected clock.
  fs.utimesSync(rblobs.pathOf(blobSha), new Date(now), new Date(now));
  rlog.append('attachment', 'att_g', 'create', { blob: blobSha, mime: 'text/plain', bytes: 20, conversationId: 's_gone', createdAt: now });
  rlog.append('conversation', 's_gone', 'trash', { at: now }, { durable: true });
  await rlog.flush();
  await rindex.ready;
  await rindex.catchUp();
  now += 10 * 86_400_000;
  let res = await ret.run();
  check('retention: nothing purged before trashRetentionDays', res.purged === 0 && (await rindex.counts()).trash === 1);
  now += 25 * 86_400_000;
  res = await ret.run();
  const raw = listSegments(rlog.ownStreamDir).map((f) => fs.readFileSync(f.file, 'utf8')).join('');
  check('retention: purged after 30 days, hook ran, payload redacted in place', res.purged === 1 && purgedHook.includes('s_gone') && (await rindex.counts()).trash === 0 && !raw.includes('secret text of s_gone') && raw.includes('secret text of s_keep'));
  now += 8 * 86_400_000;
  res = await ret.run();
  check('blob GC removes the purged chat\'s unreferenced blob after 7 days', !rblobs.has(blobSha), res.blobs);
  // Compaction: old segments become a base; the index rebuilt from it sees the same chats.
  for (let i = 0; i < 40; i++) {
    rlog.append('conversation', 's_keep', 'patch', { title: `keep ${i}` });
  }
  await rlog.flush();
  now += 100 * 86_400_000;
  rlog.append('conversation', 's_keep', 'patch', { favorite: true });
  await rlog.flush();
  await rindex.catchUp();
  const beforeC = JSON.stringify(await rindex.history({ limit: 50 }));
  const comp = compactOwnStream(rlog, { historyDays: 90, now: () => now });
  await rindex.rebuild();
  const afterC = JSON.stringify(await rindex.history({ limit: 50 }));
  check('compaction: old segments -> one base, same index after rebuild', comp.segments > 0 && listSegments(rlog.ownStreamDir).some((f) => f.compact) && afterC === beforeC, comp);
  check('redaction keeps line lengths (locations stay valid)', (await redactOwnStream(rlog, new Set(['s_nothing']))) === 0);
  // Backup round trip, encrypted and plain.
  const bdir = tmp('bk');
  const plain = await writeBackup({ log: rlog, blobs: rblobs, dir: bdir, now: () => now });
  const sealedB = await writeBackup({ log: rlog, blobs: rblobs, dir: bdir, file: path.join(bdir, 'sealed.lpbackup'), passphrase: 'pw for backup', kdfN: 2 ** 14, now: () => now });
  let wrongB = false;
  await readBackup(sealedB.file, 'nope').catch((e) => (wrongB = e instanceof WrongBackupPassphraseError));
  check('encrypted backup: wrong passphrase refused', wrongB && !fs.readFileSync(sealedB.file).includes(Buffer.from('keep 3')));
  const target = tmp('restore');
  const tlog = FileEventLog.open({ root: target, writer: 'cli', log: quiet, flushMs: 1 });
  tlog.append('conversation', 's_new_here', 'create', { title: 'Only on the new machine', tags: {}, pinned: false, favorite: false, archived: false, model: '', mode: 'agent', activeBranchId: 'br_x', createdAt: now });
  await tlog.flush();
  const restoredB = await restoreBackup({ log: tlog, blobs: new BlobStore(target), file: sealedB.file, passphrase: 'pw for backup' });
  const tindex = new LocalIndexClient({ root: target, deviceId: tlog.device.deviceId, sqlJs: SQL });
  await tindex.ready;
  const trows = (await tindex.history({ limit: 50 })).rows.map((r) => r.id).sort();
  check('restore merges into a newer root without losing its data', restoredB.imported > 0 && trows.join() === 's_keep,s_new_here', [restoredB, trows]);
  const again2 = await restoreBackup({ log: tlog, blobs: new BlobStore(target), file: plain.file });
  check('restoring the same backup twice adds nothing', again2.imported === 0);
  await tindex.dispose();
  await tlog.dispose();
  await rindex.dispose();
  await rlog.dispose();

  console.log('\n[continuity: Continuity.open]');
  const croot = tmp('open');
  const c = await Continuity.open({ dataDir: croot, writer: 'cli', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings: () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } }), wasmPath: process.env.LOCALPILOT_SQLJS_WASM ?? '', workerPath: process.env.LOCALPILOT_CONTINUITY_WORKER ?? '', schedules: false, migration: makeFixture().sources });
  await c.ready;
  // 50 ms on a developer machine; shared CI runners (Windows especially) stall for tens of ms at random, so they get
  // 250 ms. Either budget still catches the real regression: work moved back onto the calling thread takes seconds.
  const openBudget = process.env.CI ? 250 : 50;
  check(`open on the calling thread: ${c.openMs.toFixed(1)} ms (budget ${openBudget} ms)`, !c.degraded && c.openMs < openBudget);
  for (let i = 0; i < 40 && c.migration.status().state !== 'partial' && c.migration.status().state !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await c.index.catchUp();
  const stats = await c.data.stats();
  check('migration ran in the background; stats see it', (stats.conversations ?? 0) >= 4 && stats.bytes.logs > 0 && stats.migration.sources > 0, { conv: stats.conversations, mig: stats.migration.state });
  await c.dispose();
  const blocked = path.join(tmp('deg'), 'file');
  fs.writeFileSync(blocked, 'not a folder');
  const d = await Continuity.open({ dataDir: path.join(blocked, 'inside'), writer: 'cli', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings: () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } }), wasmPath: '', workerPath: '', schedules: false });
  let threw = false;
  try {
    void d.log;
  } catch {
    threw = true;
  }
  check('an unusable data dir gives a degraded instance, never a throw', !!d.degraded && threw);
  await hardening(check, SQL);
  void crypto;
  void readSegmentLines;
}

/**
 * Hardening of the continuity data layer (design §26): leases (atomic takeover, live pids never stale by age, a log that
 * lost its lease moves on), device binding (a copied data folder), purge redaction in every local stream and in
 * backups, compaction of streams nobody writes (and of owners' newer bases), a base over a segment it covers in part,
 * run details pruned with the history window, unknown ops kept, streamed and framed backups, blob re-use vs GC, one
 * automatic backup at a time, lock files for shared read-merge-write files and the folder keyring.
 */
async function hardening(check: Check, SQL: Awaited<ReturnType<typeof loadSqlJs>>): Promise<void> {
  const DAY = 86_400_000;
  const conv = (log: FileEventLog, id: string, at: number) => log.append('conversation', id, 'create', { title: id, tags: {}, pinned: false, favorite: false, archived: false, model: '', mode: 'agent', activeBranchId: `br_${id}`, createdAt: at });
  const say = (log: FileEventLog, convId: string, id: string, text: string, at: number) => log.append('message', id, 'create', { conversationId: convId, branchId: `br_${convId}`, role: 'user', parts: [{ kind: 'text', text }], meta: {}, createdAt: at });
  const allText = (root: string) =>
    fs
      .readdirSync(path.join(root, 'streams'))
      .flatMap((s) => listSegments(path.join(root, 'streams', s)).map((f) => fs.readFileSync(f.file, 'utf8')))
      .join('');

  console.log('\n[continuity: hardening — leases]');
  {
    const dir = tmp('lease');
    const file = path.join(dir, 'lease.json');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), kind: 'cli', at: Date.now() - 3600_000 }));
    check('lease: a live pid on this host is never stale by age alone', !leaseIsFree(file));
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'some-other-host', kind: 'cli', at: Date.now() - 3600_000 }));
    check('lease: another host\'s lease is stale by age (its pid cannot be checked)', leaseIsFree(file));
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 4242, host: os.hostname(), kind: 'cli', at: Date.now() }));
    // Another taker holds the take-over claim: this one must not take the lease too.
    fs.writeFileSync(`${file}.claim`, JSON.stringify({ pid: process.pid, token: 'other', at: Date.now() }));
    const l1 = new Lease(file, { kind: 'a', refreshMs: 0 });
    check('lease: a stale lease is not taken while another taker holds the claim', !l1.tryClaim() && !l1.isHeld);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.claim`, old, old);
    const l2 = new Lease(file, { kind: 'b', refreshMs: 0 });
    const l3 = new Lease(file, { kind: 'c', refreshMs: 0 });
    const won = [l2.tryClaim(), l3.tryClaim()];
    check('lease: a claim left by a dead taker is cleared; exactly one of two takers wins', won.filter(Boolean).length === 1 && readLease(file)?.token === (won[0] ? l2.token : l3.token) && !fs.existsSync(`${file}.claim`), won);
    l2.release();
    l3.release();
    // A log whose lease another process took moves to a stream of its own.
    const root = tmp('lease-log');
    const log = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1 });
    const first = log.stream;
    log.append('conversation', 's_l', 'patch', { title: 'before' });
    await log.flush();
    let rotated = '';
    log.onRotate((r) => (rotated = `${r.from}>${r.to}`));
    fs.writeFileSync(path.join(log.ownStreamDir, 'lease.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), kind: 'vscode', at: Date.now(), token: 'thief' }));
    const e = log.append('conversation', 's_l', 'patch', { title: 'after' });
    await log.flush();
    const firstText = listSegments(path.join(root, 'streams', first)).map((f) => fs.readFileSync(f.file, 'utf8')).join('');
    check('log: after losing its lease it writes to a new stream (re-stamped), never the taken one', log.stream !== first && e.stream === log.stream && e.id === `${log.stream}:1` && rotated === `${first}>${log.stream}` && !firstText.includes('"after"') && (await log.readAt(log.locOf(e)!)).p.title === 'after', { first, now: log.stream, rotated });
    await log.dispose();
  }

  console.log('\n[continuity: hardening — device identity bound to the machine]');
  {
    const root = tmp('device');
    const a = readOrCreateDevice(root, 'A', Date.now, { fingerprint: 'fp_machine_a' });
    const copied = readOrCreateDevice(root, 'B', Date.now, { fingerprint: 'fp_machine_b' });
    const againA = readOrCreateDevice(root, 'A', Date.now, { fingerprint: 'fp_machine_a' });
    const againB = readOrCreateDevice(root, 'B', Date.now, { fingerprint: 'fp_machine_b' });
    const file = JSON.parse(fs.readFileSync(path.join(root, 'device.json'), 'utf8')) as { deviceId: string; host: string; others: Record<string, { deviceId: string }> };
    check('device: a copied data folder gets a device id of its own; each machine keeps its id', a.deviceId !== copied.deviceId && againA.deviceId === a.deviceId && againB.deviceId === copied.deviceId && file.deviceId === a.deviceId && file.others.fp_machine_b.deviceId === copied.deviceId, file);
    const legacy = tmp('device-170');
    fs.writeFileSync(path.join(legacy, 'device.json'), JSON.stringify({ v: 1, deviceId: 'dev_LEGACY', name: 'old', platform: 'x', createdAt: 1 }));
    const bound = readOrCreateDevice(legacy, undefined, Date.now, { fingerprint: 'fp_here' });
    check('device: a 1.7.0 device.json keeps its id and is bound to the first machine that opens it', bound.deviceId === 'dev_LEGACY' && JSON.parse(fs.readFileSync(path.join(legacy, 'device.json'), 'utf8')).host === 'fp_here');
    // Streams of the copied identity stay readable as that device's history.
    const la = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1, fingerprint: 'fp_machine_a' });
    la.append('conversation', 's_dev', 'patch', { title: 'from A' });
    await la.dispose();
    const lb = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1, fingerprint: 'fp_machine_b' });
    const streams = await lb.streams();
    check('device: the copy writes its own stream; the original\'s stays as another device\'s', lb.device.deviceId === copied.deviceId && lb.stream.startsWith(copied.deviceId) && streams.some((s) => s.device === a.deviceId && !s.own && s.lastSeq === 1));
    await lb.dispose();
    check('device: the machine id lives outside the data folder (tests: a temp file)', !!process.env.LOCALPILOT_MACHINE_ID_FILE && !process.env.LOCALPILOT_MACHINE_ID_FILE.startsWith(os.homedir() + path.sep + '.localpilot') && fs.existsSync(process.env.LOCALPILOT_MACHINE_ID_FILE));
  }

  console.log('\n[continuity: hardening — purge reaches every local stream and later backups]');
  {
    let now = Date.UTC(2026, 3, 1);
    const root = tmp('purge-all');
    const SECRET = 'PURGE-ME-91c2';
    // A process that ended (its stream is nobody's now), a live other process, and a copy of another device's stream.
    const ended = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1, now: () => now });
    conv(ended, 's_x', now);
    say(ended, 's_x', 'm_x_ended', `${SECRET} written by the CLI`, now);
    const live = FileEventLog.open({ root, writer: 'vscode', log: quiet, flushMs: 1, now: () => now, pid: process.pid });
    const me = FileEventLog.open({ root, writer: 'vscode', log: quiet, flushMs: 1, now: () => now });
    const endedStream = ended.stream;
    await ended.dispose();
    check('purge test: three streams (one ended, one live, ours)', new Set([endedStream, live.stream, me.stream]).size === 3);
    say(live, 's_x', 'm_x_live', `${SECRET} in a window still open`, now);
    await live.flush();
    const remote = 'dev_REMOTE1.1';
    const H = (ms: number) => `${ms.toString(16).padStart(12, '0')}-0000-dev_REMOTE1`;
    await me.importRemote(remote, [ev(remote, 1, H(now), 'message', 'm_x_remote', 'create', { conversationId: 's_x', branchId: 'br_s_x', role: 'assistant', parts: [{ kind: 'text', text: `${SECRET} from the other device` }], meta: {}, createdAt: now })]);
    say(me, 's_keep', 'm_keep', 'KEEP-THIS-TEXT', now);
    await me.flush();
    const index = new LocalIndexClient({ root, deviceId: me.device.deviceId, ownStream: me.stream, sqlJs: SQL, now: () => now });
    await index.ready;
    await index.catchUp();
    const ret = new Retention({ log: me, index, blobs: new BlobStore(root, () => now), settings: () => ({ trashRetentionDays: 30, historyDays: 90 }), now: () => now });
    await ret.purge([{ ent: 'conversation', id: 's_x' }]);
    const liveDir = live.ownStreamDir;
    const others = fs.readdirSync(path.join(root, 'streams')).filter((s) => s !== live.stream).flatMap((s) => listSegments(path.join(root, 'streams', s)).map((f) => fs.readFileSync(f.file, 'utf8'))).join('');
    check('purge: redacted in the stream of a process that ended and in other devices\' copies, not only our own', !others.includes(SECRET) && others.includes('KEEP-THIS-TEXT'));
    const liveText = listSegments(liveDir).map((f) => fs.readFileSync(f.file, 'utf8')).join('');
    check('purge: a stream another live process writes is left to it (single writer)', liveText.includes(SECRET));
    // A backup taken now leaves the purged content out, even what still sits in the live stream.
    const b = await writeBackup({ log: me, blobs: new BlobStore(root), dir: tmp('purge-bk'), now: () => now });
    const plainText = zlib.gunzipSync(fs.readFileSync(b.file)).toString('utf8');
    check('purge: later backups leave the purged content out (index set or a scan of purge events)', !plainText.includes(SECRET) && plainText.includes('KEEP-THIS-TEXT') && plainText.includes('"redacted":true'));
    // The live process's own retention pass redacts its stream (it learns the purge from the index).
    const lindex = new LocalIndexClient({ root, deviceId: live.device.deviceId, ownStream: live.stream, sqlJs: SQL, now: () => now });
    await lindex.ready;
    await lindex.catchUp();
    const lret = new Retention({ log: live, index: lindex, blobs: new BlobStore(root, () => now), settings: () => ({ trashRetentionDays: 0, historyDays: 90 }), now: () => now });
    const lr = await lret.run();
    check('purge: the live process redacts its own stream at its next retention pass', lr.redacted > 0 && !allText(root).includes(SECRET), lr);
    // A purge that arrives through sync is redacted the same way.
    await me.importRemote(remote, [ev(remote, 2, H(now + 1), 'message', 'm_y_remote', 'create', { conversationId: 's_y', branchId: 'br_s_y', role: 'assistant', parts: [{ kind: 'text', text: 'SYNCED-AWAY-TEXT' }], meta: {}, createdAt: now }), ev(remote, 3, H(now + 2), 'conversation', 's_y', 'purge', { at: now })]);
    const hooked: string[] = [];
    ret.onPurge((_e, id) => void hooked.push(id));
    await ret.redactRemote([{ ent: 'conversation', id: 's_y' }]);
    check('purge from another device: hooks run and every local copy is redacted', hooked.includes('s_y') && !allText(root).includes('SYNCED-AWAY-TEXT'));
    await lindex.dispose();
    await index.dispose();
    await live.dispose();
    await me.dispose();
    now += DAY;
  }

  console.log('\n[continuity: hardening — compaction of other streams, owners\' bases, overlap]');
  {
    let now = Date.UTC(2026, 0, 1);
    const root = tmp('compact-others');
    const ended = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1, now: () => now, segmentMaxBytes: 600 });
    const endedStream = ended.stream;
    for (let i = 0; i < 30; i++) {
      ended.append('conversation', 's_o', 'patch', { title: `old ${i}` });
    }
    const live = FileEventLog.open({ root, writer: 'vscode', log: quiet, flushMs: 1, now: () => now, segmentMaxBytes: 600, pid: process.pid });
    for (let i = 0; i < 30; i++) {
      live.append('conversation', 's_live', 'patch', { title: `live ${i}` });
    }
    await live.flush();
    const me = FileEventLog.open({ root, writer: 'vscode', log: quiet, flushMs: 1, now: () => now });
    await ended.dispose();
    now += 120 * DAY;
    const before = listSegments(path.join(root, 'streams', endedStream)).length;
    const r = compactOtherStreams(me, { historyDays: 90, now: () => now });
    const after = listSegments(path.join(root, 'streams', endedStream));
    check('compaction: a stream nobody writes is compacted (under its lease), a live one is left to its writer', r.streams === 1 && before > 1 && after.length === 1 && after[0].compact && listSegments(live.ownStreamDir).every((f) => !f.compact), { r, before, after: after.map((f) => path.basename(f.file)) });
    check('compaction: the stream nobody writes keeps its last seq and lease is released', streamLastSeq(path.join(root, 'streams', endedStream)) === 30 && !fs.existsSync(path.join(root, 'streams', endedStream, 'lease.json')));
    const reopenEnded = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1, now: () => now });
    check('a process that takes the compacted stream again continues its seq', reopenEnded.stream === endedStream && reopenEnded.append('conversation', 's_o', 'patch', { pinned: true }).seq === 31);
    await reopenEnded.dispose();
    // An owner's newer base replaces what it covers in a local copy that is already past it.
    const remote = 'dev_OWNER1.1';
    const H = (ms: number, c = 0) => `${ms.toString(16).padStart(12, '0')}-${c.toString(16).padStart(4, '0')}-dev_OWNER1`;
    const evs = Array.from({ length: 8 }, (_, i) => ev(remote, i + 1, H(1000 + i), 'conversation', 's_owned', i ? 'patch' : 'create', { title: `t${i}` }));
    await me.importRemote(remote, evs);
    const baseEvents = [ev(remote, 5, H(1004), 'conversation', 's_owned', 'create', { title: 't4', __clocks: { title: H(1004) } })];
    baseEvents[0].id = `${remote}:5.0`;
    const replaced = me.importBase(remote, 5, baseEvents, { replace: true });
    const read: number[] = [];
    for (const { e } of readStreamDir(path.join(root, 'streams', remote), 1)) {
      read.push(e.seq);
    }
    check('owner\'s base over a local copy that is ahead: installed, readers see base then 6..8 once', replaced && read.join() === '5,6,7,8' && streamLastSeq(path.join(root, 'streams', remote)) === 8, read);
    // A crash between writing a base and removing what it covers leaves both: readers skip the overlap.
    const odir = path.join(root, 'streams', 'dev_OVERLAP.1');
    fs.mkdirSync(odir, { recursive: true });
    const oe = (seq: number) => JSON.stringify(ev('dev_OVERLAP.1', seq, `${(2000 + seq).toString(16).padStart(12, '0')}-0000-dev_OVERLAP`, 'conversation', 's_ov', 'patch', { title: `o${seq}` }));
    fs.writeFileSync(path.join(odir, '000000000001.jsonl'), [1, 2].map(oe).join('\n') + '\n');
    // A segment the base covers in part (3 and 4 are in the base too).
    fs.writeFileSync(path.join(odir, '000000000003.jsonl'), [3, 4, 5, 6].map(oe).join('\n') + '\n');
    fs.writeFileSync(path.join(odir, 'compact-000000000004.jsonl'), oe(4).replace('"id":"dev_OVERLAP.1:4"', '"id":"dev_OVERLAP.1:4.0"') + '\n');
    const oseq: number[] = [];
    for (const { e } of readStreamDir(odir, 1)) {
      oseq.push(e.seq);
    }
    check('a base and the segments it covers both on disk (crash in between): no event is read twice', oseq.join() === '4,5,6' && streamLastSeq(odir) === 6, oseq);
    await live.dispose();
    await me.dispose();
  }

  console.log('\n[continuity: hardening — run details pruned with the window, unknown ops kept]');
  {
    let now = Date.UTC(2026, 0, 1);
    const root = tmp('prune');
    const log = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1, now: () => now, segmentMaxBytes: 500 });
    log.append('agent_session', 'as_1', 'create', { conversationId: 's_r', run: 1, mode: 'agent', startedAt: now, outcome: 'ok', writer: log.stream });
    for (let i = 0; i < 10; i++) {
      log.append('execution_event', `ex_${i}`, 'create', { agentSessionId: 'as_1', conversationId: 's_r', seq: i, kind: 'tool', name: 'read_file', status: 'ok' });
    }
    log.append('context_snapshot', 'cs_1', 'create', { conversationId: 's_r', items: [], createdAt: now });
    log.append('model_session', 'ms_1', 'create', { conversationId: 's_r', model: 'm', startedAt: now });
    await log.flush();
    // A newer LocalPilot's event (an op this build does not know) in a stream nobody writes.
    const ndir = path.join(root, 'streams', 'dev_NEWER1.1');
    fs.mkdirSync(ndir, { recursive: true });
    const H = (ms: number) => `${ms.toString(16).padStart(12, '0')}-0000-dev_NEWER1`;
    const newer = [ev('dev_NEWER1.1', 1, H(now), 'conversation', 's_n', 'create', { title: 'n' }), { ...ev('dev_NEWER1.1', 2, H(now + 1), 'conversation', 's_n', 'patch', { star: 5 }), op: 'rate' as never }, ev('dev_NEWER1.1', 3, H(now + 2), 'conversation', 's_n', 'patch', { title: 'n2' })];
    fs.writeFileSync(path.join(ndir, '000000000001.jsonl'), newer.map((e) => JSON.stringify(e)).join('\n') + '\n');
    now += 200 * DAY;
    log.append('conversation', 's_r', 'patch', { title: 'still here' });
    await log.flush();
    const c = compactOwnStream(log, { historyDays: 90, now: () => now });
    const base = listSegments(log.ownStreamDir).find((f) => f.compact);
    const kinds = base ? readSegmentLines(base.file).map((r) => r.e.ent) : [];
    check('run details (steps, context snapshots, model sessions) older than the window are dropped; the run stays', c.segments > 0 && kinds.includes('agent_session') && !kinds.some((k) => k === 'execution_event' || k === 'context_snapshot' || k === 'model_session'), kinds);
    compactOtherStreams(log, { historyDays: 90, now: () => now });
    const nbase = listSegments(ndir).find((f) => f.compact);
    const nops = nbase ? readSegmentLines(nbase.file).map((r) => r.e.op) : [];
    check('compaction keeps an event of an op this build does not know, as it is', nops.includes('rate' as never) && nops.includes('create'), nops);
    await log.dispose();
  }

  console.log('\n[continuity: hardening — streamed, framed backups]');
  {
    const root = tmp('bk2');
    const log = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1 });
    conv(log, 's_b', Date.now());
    for (let i = 0; i < 50; i++) {
      say(log, 's_b', `m_b${i}`, `line ${i} ${'x'.repeat(200)}`, Date.now());
    }
    await log.flush();
    const blobs = new BlobStore(root);
    blobs.put('a blob in the backup');
    const dir = tmp('bk2-out');
    const sealedFile = (await writeBackup({ log, blobs, dir, file: path.join(dir, 's.lpbackup'), passphrase: 'pw for backup', kdfN: 2 ** 14 })).file;
    const head = fs.readFileSync(sealedFile).subarray(0, 6).toString('utf8');
    const target = tmp('bk2-restore');
    const tlog = FileEventLog.open({ root: target, writer: 'cli', log: quiet, flushMs: 1 });
    const r = await restoreBackup({ log: tlog, blobs: new BlobStore(target), file: sealedFile, passphrase: 'pw for backup' });
    check('backup: encrypted backups are framed (LPBK2) and restore as a stream', head === 'LPBK2\n' && r.imported === 51 && r.blobs === 1, { head, r });
    const cut = path.join(dir, 'cut.lpbackup');
    const full = fs.readFileSync(sealedFile);
    fs.writeFileSync(cut, full.subarray(0, full.length - 10));
    let cutErr = '';
    await readBackup(cut, 'pw for backup').catch((e: Error) => (cutErr = e.message));
    check('backup: a cut-short encrypted backup is detected, not half-restored', /cut short|damaged/.test(cutErr), cutErr);
    // 1.7.0's single-object format is still read.
    const kdf = newKdf({ N: 2 ** 14 });
    const dek = await deriveKek('old pw', kdf);
    const key = { keyId: crypto.createHash('sha256').update(kdf.salt).digest('hex').slice(0, 32), dek };
    const lines = [JSON.stringify({ kind: 'header', v: 1, deviceId: 'dev_OLD', createdAt: 1, streams: [] }), JSON.stringify(ev('dev_OLD1.1', 1, '000000000001-0000-dev_OLD1', 'conversation', 's_old', 'create', { title: 'from 1.7.0' }))];
    const v1 = path.join(dir, 'v1.lpbackup');
    fs.writeFileSync(v1, Buffer.concat([Buffer.from(`LPBK1\n${JSON.stringify(kdf)}\n`), seal(key as never, 'localpilot-backup', `${lines.join('\n')}\n`)]));
    const r1 = await restoreBackup({ log: tlog, blobs: new BlobStore(target), file: v1, passphrase: 'old pw' });
    check('backup: a 1.7.0 encrypted backup (LPBK1) still restores', r1.imported === 1 && r1.refused.length === 0, r1);
    await tlog.dispose();
    await log.dispose();
  }

  console.log('\n[continuity: hardening — blob re-use vs GC, one automatic backup at a time]');
  {
    let now = Date.UTC(2026, 0, 1);
    const root = tmp('blob-gc');
    const blobs = new BlobStore(root, () => now);
    const sha = blobs.put('re-used attachment');
    fs.utimesSync(blobs.pathOf(sha), new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    blobs.put('re-used attachment'); // attached again: the event referencing it is not indexed yet
    const gone = blobs.gc(new Set(), 7);
    check('blob: putting an existing blob refreshes it, so a GC before the index catches up keeps it', blobs.has(sha) && gone.removed === 0);
    now += 0;
    const log = FileEventLog.open({ root, writer: 'cli', log: quiet, flushMs: 1 });
    conv(log, 's_auto', Date.now());
    await log.flush();
    const index = new LocalIndexClient({ root, deviceId: log.device.deviceId, ownStream: log.stream, sqlJs: SQL });
    await index.ready;
    const ret = new Retention({ log, index, blobs, settings: () => ({ trashRetentionDays: 30, historyDays: 90 }) });
    const mk = () => new DataManager({ root, log, index, blobs, migration: {} as Migration, retention: ret, backup: () => ({ enabled: true, intervalDays: 1, keep: 4 }) });
    const [b1, b2] = await Promise.all([mk().autoBackup(), mk().autoBackup()]);
    check('automatic backup: two processes due at once write one backup', [b1, b2].filter(Boolean).length === 1 && listBackups(path.join(root, 'backups')).length === 1);
    await index.dispose();
    await log.dispose();
  }

  console.log('\n[continuity: hardening — lock files for shared files]');
  {
    const dir = tmp('locks');
    const file = path.join(dir, 'seen.json');
    fs.writeFileSync(`${file}.lock`, 'someone');
    const t0 = Date.now();
    const ran = withFileLock(file, () => 'ran', { waitMs: 80 });
    check('withFileLock: waits for a held lock (then runs rather than hang)', ran === 'ran' && Date.now() - t0 >= 70 && fs.existsSync(`${file}.lock`));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    let inside = false;
    withFileLock(file, () => (inside = fs.readFileSync(`${file}.lock`, 'utf8') !== 'someone'));
    check('withFileLock: a stale lock is broken, held while fn runs, removed after', inside && !fs.existsSync(`${file}.lock`));
    // Folder keyring compare-and-swap: two changes from the same version, one wins.
    const fb = new FolderBackend(tmp('kr-folder'));
    await fb.put('keyring.json', Buffer.from('{"v":1}'));
    const etag = (await fb.head('keyring.json'))!.etag!;
    const results = await Promise.allSettled([fb.put('keyring.json', Buffer.from('{"v":1,"by":"device A"}'), { ifMatch: etag }), fb.put('keyring.json', Buffer.from('{"v":1,"by":"device B, longer"}'), { ifMatch: etag })]);
    const ok = results.filter((x) => x.status === 'fulfilled').length;
    const final = String(await fb.get('keyring.json'));
    check('folder keyring: two compare-and-swaps from one version, exactly one lands', ok === 1 && (final.includes('device A') || final.includes('device B')) && !fs.readdirSync(path.join(fb.root)).some((n) => n.endsWith('.lock')), { ok, final });
  }
}
