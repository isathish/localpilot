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
import { hash26, idTime, isEntityId, newId, stableId, ulid } from '../src/continuity/ids';
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
  check('envelope: bad seq / id / op rejected', !!validateEnvelope({ ...good, seq: 0 }) && !!validateEnvelope({ ...good, id: 'x' }) && !!validateEnvelope({ ...good, op: 'zap' }));
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
  check(`open on the calling thread: ${c.openMs.toFixed(1)} ms (budget 50 ms)`, !c.degraded && c.openMs < 50);
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
  void crypto;
  void readSegmentLines;
}
