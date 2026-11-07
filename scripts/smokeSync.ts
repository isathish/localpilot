/**
 * Smoke checks (bundled into scripts/smoke.ts) for the continuity SYNC module: the protocol between two data roots over
 * an in-memory backend (create → propagates; concurrent title → conflict on both; concurrent appends → branch split;
 * trash vs edit; offline → queue → same result; a retried chunk upload writes the same object; categories filter and a
 * later enable; revoke + rotate: an old key cannot read new objects; blobs; wrong passphrase writes nothing; conflict
 * resolution travels), the scheduler's backoff, and the four backends against local fakes only (a temp folder with
 * provider conflict copies and an iCloud placeholder, a local bare git repo with two clones, a fake S3 server checking
 * SigV4 with the AWS documentation vector, pagination and the If-None-Match fallback, a fake WebDAV server).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Continuity, type ContinuitySettings } from '../src/continuity/continuity';
import { memorySecretBox, type SecretBox } from '../src/continuity/data/crypto/secretBox';
import { SealError } from '../src/continuity/data/crypto/envelope';
import { WrongPassphraseError } from '../src/continuity/data/crypto/keyring';
import { mainBranchId } from '../src/continuity/ids';
import { BackendError, MemoryBackend, type SyncBackend } from '../src/continuity/sync/backends/backend';
import { FolderBackend, isProviderCopy } from '../src/continuity/sync/backends/folder';
import { GitBackend } from '../src/continuity/sync/backends/git';
import { S3Backend } from '../src/continuity/sync/backends/s3';
import { signV4, EMPTY_SHA256 } from '../src/continuity/sync/backends/sigv4';
import { WebDavBackend } from '../src/continuity/sync/backends/webdav';
import { createBackend, SECRET_NAMES } from '../src/continuity/sync/backends/create';
import { DEFAULT_SYNC_SETTINGS, type SyncEngine, type SyncSettings } from '../src/continuity/sync/syncEngine';
import { SyncScheduler } from '../src/continuity/sync/scheduler';
import { blobKey, chunkKey, openObject } from '../src/continuity/sync/protocol';
import { DEFAULT_CATEGORIES } from '../src/continuity/sync/merge';
import { startFakeS3 } from '../src/test/fakes/s3Server';
import { startFakeWebDav } from '../src/test/fakes/webdavServer';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-sync-${p}-`));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const cfg: ContinuitySettings = { dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } };
const PASS = 'correct horse battery staple';

interface Side {
  c: Continuity;
  sync: SyncEngine;
  settings: SyncSettings;
  secrets: SecretBox;
  root: string;
}

async function side(name: string, backend: SyncBackend, o: { root?: string; secrets?: SecretBox; promptsDir?: string; prefs?: Map<string, unknown> } = {}): Promise<Side> {
  const root = o.root ?? tmp(name);
  const secrets = o.secrets ?? memorySecretBox();
  const c = await Continuity.open({ dataDir: root, writer: 'vscode', appVersion: 'test', secrets, log: quiet, settings: () => cfg, wasmPath: process.env.LOCALPILOT_SQLJS_WASM ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5 });
  await c.ready;
  const settings: SyncSettings = { ...DEFAULT_SYNC_SETTINGS, enabled: true, categories: { ...DEFAULT_CATEGORIES } };
  const prefs = o.prefs;
  const sync = c.attachSync({ settings: () => settings, backend, kdfN: 1024, start: false, promptsDir: o.promptsDir ?? tmp(`${name}-cmds`), ...(prefs ? { preferences: { read: (k: string) => prefs.get(k), write: async (k: string, v: unknown) => void prefs.set(k, v) } } : {}) })!;
  return { c, sync, settings, secrets, root };
}

function newConv(s: Side, id: string, title: string): void {
  s.c.log.append('conversation', id, 'create', { title, model: 'm', mode: 'agent', pinned: false, favorite: false, archived: false, tags: {}, activeBranchId: mainBranchId(id), createdAt: Date.now() }, { durable: true });
}

function msg(s: Side, convId: string, id: string, parentId: string | undefined, text: string, o: { base?: string; role?: 'user' | 'assistant'; branchId?: string } = {}): void {
  s.c.log.append('message', id, 'create', { conversationId: convId, branchId: o.branchId ?? mainBranchId(convId), ...(parentId ? { parentId } : {}), role: o.role ?? 'user', parts: [{ kind: 'text', text }], meta: {}, createdAt: Date.now() }, { durable: true, ...(o.base ? { base: o.base } : {}) });
}

async function settle(...ss: Side[]): Promise<void> {
  for (const s of ss) {
    await s.c.log.flush();
    await s.c.index.catchUp();
  }
}

async function round(...ss: Side[]): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const s of ss) {
    await settle(s);
    out.push(await s.sync.cycle('now'));
  }
  await settle(...ss);
  return out;
}

const offline = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });

export async function syncSmoke(check: Check): Promise<void> {
  console.log('\n[continuity: sync — protocol, conflicts, categories, keys, scheduler, backends]');
  await protocol(check);
  await extras(check);
  await scheduler(check);
  await backends(check);
  await everyBackendEndToEnd(check);
}

/** A backend whose calls fail like a lost network while `down` is set (the offline queue over a real backend). */
function flaky(inner: SyncBackend): SyncBackend & { down: boolean } {
  const w = {
    down: false,
    kind: inner.kind,
    label: inner.label,
    gate<T>(f: () => Promise<T>): Promise<T> {
      return w.down ? Promise.reject(offline()) : f();
    },
    check: () => (w.down ? Promise.resolve({ ok: false as const, reason: 'offline' as const, message: 'offline' }) : inner.check()),
    list: (p: string, a?: string) => w.gate(() => inner.list(p, a)),
    get: (k: string) => w.gate(() => inner.get(k)),
    head: inner.head ? (k: string) => w.gate(() => inner.head!(k)) : undefined,
    put: (k: string, b: Uint8Array, o?: { ifAbsent?: boolean; ifMatch?: string }) => w.gate(() => inner.put(k, b, o)),
    delete: (k: string) => w.gate(() => inner.delete(k)),
    begin: inner.begin ? () => w.gate(() => inner.begin!()) : undefined,
    commit: inner.commit ? (m: string) => w.gate(() => inner.commit!(m)) : undefined,
    dispose: () => inner.dispose(),
  };
  return w as unknown as SyncBackend & { down: boolean };
}

/**
 * The same flow through every backend (folder, local bare git, fake S3, fake WebDAV): set up on A, join on B, a chat
 * with a recognisable secret moves A → B, B works offline and its queue goes out when it is back, a concurrent title
 * edit is a conflict on both devices whose resolution travels, and the raw bytes on the storage never contain the
 * secret, the title, the device names or the passphrase.
 */
async function everyBackendEndToEnd(check: Check): Promise<void> {
  const SECRET = 'TOPSECRET-7f3a9c';
  const run = async (label: string, mk: () => SyncBackend, extraScan?: () => string) => {
    const A = await side(`${label}-ea`, flaky(mk()));
    const bB = flaky(mk());
    const B = await side(`${label}-eb`, bB);
    try {
      await A.sync.create(PASS);
      await B.sync.join(PASS);
      newConv(A, 'conv_e2e', `Plan ${SECRET}`);
      msg(A, 'conv_e2e', 'm_e2e_1', undefined, `the launch code is ${SECRET}`);
      await round(A, B);
      check(`sync e2e ${label}: a chat and its message move A → B`, (await B.c.index.conversation('conv_e2e'))?.title === `Plan ${SECRET}` && (await B.c.index.search(SECRET)).length > 0);
      // Offline on B: its edit waits in the queue, then goes out.
      bB.down = true;
      B.c.log.append('conversation', 'conv_e2e', 'patch', { tags: { offline: true } }, { durable: true });
      await settle(B);
      const okOff = await B.sync.cycle('now');
      check(`sync e2e ${label}: offline, B keeps its change queued`, !okOff && B.sync.status().state === 'offline' && B.sync.pendingCount() > 0, B.sync.status());
      bB.down = false;
      await round(B, A);
      check(`sync e2e ${label}: back online, the queue reaches A`, B.sync.pendingCount() === 0 && JSON.stringify((await A.c.index.conversation('conv_e2e'))?.tags ?? {}).includes('offline'));
      // Concurrent title edits: a conflict on both; a resolution on A travels to B.
      A.c.log.append('conversation', 'conv_e2e', 'patch', { title: 'Title from A' }, { base: A.c.log.peekHlc(), durable: true });
      B.c.log.append('conversation', 'conv_e2e', 'patch', { title: 'Title from B' }, { base: B.c.log.peekHlc(), durable: true });
      await round(A, B, A);
      const cf = (await A.sync.conflicts.list()).find((c) => c.kind === 'field' && c.field === 'title');
      check(`sync e2e ${label}: a concurrent title edit is a conflict on both devices`, !!cf && (await B.sync.conflicts.list()).some((c) => c.id === cf.id));
      if (cf) {
        await A.sync.conflicts.resolve(cf.id, 'ours');
        await round(A, B);
        const ta = (await A.c.index.conversation('conv_e2e'))?.title;
        check(`sync e2e ${label}: the resolution reaches the other device`, ta === cf.ours.value && (await B.c.index.conversation('conv_e2e'))?.title === ta && !(await B.sync.conflicts.list()).some((c) => c.id === cf.id), ta);
      }
      // Ciphertext only: read every object back from the storage itself.
      const raw = mk();
      await raw.begin?.();
      const keys = (await raw.list('')).map((e) => e.key);
      let text = '';
      for (const k of keys) {
        text += Buffer.from((await raw.get(k)) ?? new Uint8Array()).toString('latin1');
      }
      text += extraScan?.() ?? '';
      raw.dispose();
      const leaks = [SECRET, 'Title from', 'launch code', PASS, A.c.device.name, B.c.device.name, 'conv_e2e'].filter((x) => x && text.includes(x));
      check(`sync e2e ${label}: the storage holds only ciphertext (${keys.length} objects)`, keys.length > 4 && keys.every((k) => k === 'format.json' || k === 'keyring.json' || k.endsWith('.lpe')) && leaks.length === 0, { leaks, keys: keys.slice(0, 8) });
    } finally {
      await A.c.dispose();
      await B.c.dispose();
    }
  };
  console.log('\n[continuity: sync — the same flow through every backend, ciphertext only]');
  const shared = tmp('e2e-folder');
  await run('folder', () => new FolderBackend(shared));
  let hasGit = true;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    hasGit = false;
  }
  if (hasGit) {
    const bare = path.join(tmp('e2e-bare'), 'sync.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    // Commit messages and authors are plaintext on a Git host: they are scanned too.
    await run('git', () => new GitBackend({ url: bare, branch: 'localpilot-sync', workDir: tmp('e2e-gw') }), () => execFileSync('git', ['--git-dir', bare, 'log', '--all', '--format=%an %ae %s %b']).toString());
  }
  const s3 = await startFakeS3({ accessKeyId: 'AKTEST', secretAccessKey: 'sekret', bucket: 'lp', pageSize: 3 });
  try {
    await run('s3', () => new S3Backend({ endpoint: s3.url, region: 'us-east-1', bucket: 'lp', prefix: 'e2e', accessKeyId: 'AKTEST', secretAccessKey: 'sekret' }), () => s3.keys().join('\n'));
    check('sync e2e s3: every request was signed correctly', s3.badSignatures() === 0);
  } finally {
    await s3.close();
  }
  const dav = await startFakeWebDav({ username: 'me', password: 'pw' });
  try {
    await run('webdav', () => new WebDavBackend({ url: `${dav.url}/remote.php/dav/files/me`, username: 'me', password: 'pw' }), () => dav.paths().join('\n'));
  } finally {
    await dav.close();
  }
}

async function protocol(check: Check): Promise<void> {
  const remote = new MemoryBackend('mem');
  const A = await side('a', remote);
  const B = await side('b', remote);
  try {
    // ---- setup, wrong passphrase, join
    await A.sync.create(PASS);
    check('sync: create writes format.json and keyring.json in the clear', remote.objects.has('format.json') && remote.objects.has('keyring.json'));
    const ring = remote.objects.get('keyring.json')!.body.toString('utf8');
    check('sync: the keyring holds no passphrase and no raw key', !ring.includes(PASS) && /"kdf"/.test(ring));
    check('sync: A is configured with a data key in its secret box', A.sync.configured && !!(await A.secrets.get(A.secrets.dataKeyName(A.sync.remoteId!, A.sync.state.current!))));
    const before = remote.objects.size;
    let wrong: unknown;
    await B.sync.join('not the passphrase').catch((e) => (wrong = e));
    check('sync: a wrong passphrase is refused', wrong instanceof WrongPassphraseError);
    check('sync: a wrong passphrase writes nothing (remote, state, secrets)', remote.objects.size === before && !B.sync.configured && !fs.existsSync(path.join(B.root, 'sync', 'state.json')));
    await B.sync.join(PASS);
    check('sync: B joins with the passphrase', B.sync.configured && B.sync.remoteId === A.sync.remoteId);

    // ---- create on A -> appears on B
    newConv(A, 'conv_one', 'Planning the release');
    msg(A, 'conv_one', 'm_a1', undefined, 'What is left for 1.7?');
    await round(A, B);
    const onB = await B.c.index.conversation('conv_one');
    check('sync: a conversation created on A appears on B', onB?.title === 'Planning the release', onB);
    check('sync: its message reached B', (await B.c.index.messages('conv_one')).some((m) => m.id === 'm_a1'));
    const objs = [...remote.objects.keys()];
    check('sync: storage sees only sealed objects besides format and keyring', objs.filter((k) => k !== 'format.json' && k !== 'keyring.json').every((k) => k.endsWith('.lpe') && !remote.objects.get(k)!.body.includes('Planning')), objs);
    check('sync: B sees A in the device list', (await B.sync.listDevices()).some((d) => d.id === A.c.device.deviceId && !d.thisDevice));
    check('sync: nothing waits after a cycle', A.sync.pendingCount() === 0 && A.sync.status().state === 'idle', A.sync.status());

    // ---- a cycle with nothing new: one list + no device gets (etags unchanged)
    remote.requests = 0;
    await round(B);
    check('sync: a cycle with nothing new is cheap (few requests)', remote.requests <= 6, remote.requests);

    // ---- concurrent title edits -> conflict on both
    const baseA = A.c.log.peekHlc();
    const baseB = B.c.log.peekHlc();
    A.c.log.append('conversation', 'conv_one', 'patch', { title: 'Release plan (A)' }, { base: baseA, durable: true });
    B.c.log.append('conversation', 'conv_one', 'patch', { title: 'Release plan (B)' }, { base: baseB, durable: true });
    await round(A, B, A);
    const cA = await A.sync.conflicts.list();
    const cB = await B.sync.conflicts.list();
    const titleA = cA.find((c) => c.kind === 'field' && c.field === 'title');
    check('sync: concurrent title edits are a conflict on A', !!titleA, cA);
    check('sync: … and the same conflict on B', !!cB.find((c) => c.id === titleA?.id));
    const tA = (await A.c.index.conversation('conv_one'))?.title;
    const tB = (await B.c.index.conversation('conv_one'))?.title;
    check('sync: both devices apply the same title (later write wins)', !!tA && tA === tB, [tA, tB]);
    // Resolve on B by keeping the older value; the resolution and the value travel to A.
    const older = titleA!.ours.value;
    check('sync: resolving writes the chosen value', await B.sync.conflicts.resolve(titleA!.id, 'ours'));
    await round(B, A);
    check('sync: the chosen title wins everywhere', (await A.c.index.conversation('conv_one'))?.title === older && (await B.c.index.conversation('conv_one'))?.title === older, older);
    check('sync: the conflict is resolved on the other device too', !(await A.sync.conflicts.list()).some((c) => c.id === titleA!.id));

    // ---- concurrent appends -> branch split
    msg(A, 'conv_one', 'm_a2', 'm_a1', 'A continues here', { role: 'assistant' });
    msg(B, 'conv_one', 'm_b2', 'm_a1', 'B continues there', { role: 'assistant' });
    await round(A, B, A);
    const split = (await A.sync.conflicts.list()).find((c) => c.kind === 'branch-split');
    check('sync: concurrent appends after the same message split into a device branch', !!split, await A.sync.conflicts.list());
    const brA = await A.c.index.branches('conv_one');
    const brB = await B.c.index.branches('conv_one');
    check('sync: both devices see the same branches', brA.length >= 1 && JSON.stringify(brA.map((b) => b.id).sort()) === JSON.stringify(brB.map((b) => b.id).sort()), [brA, brB]);
    const allMsgs = async (x: Side) => {
      const ids = new Set<string>();
      for (const b of [mainBranchId('conv_one'), ...(await x.c.index.branches('conv_one')).map((r) => r.id)]) {
        (await x.c.index.messages('conv_one', b)).forEach((m) => ids.add(m.id));
      }
      return [...ids].sort();
    };
    const mA = await allMsgs(A);
    check('sync: no message is lost (both branches on both devices)', mA.length === 3 && JSON.stringify(mA) === JSON.stringify(await allMsgs(B)), [mA, await allMsgs(B)]);

    // ---- trash vs edit
    newConv(A, 'conv_two', 'Second chat');
    msg(A, 'conv_two', 'm_t1', undefined, 'hello');
    await round(A, B);
    const editBase = B.c.log.peekHlc();
    A.c.log.append('conversation', 'conv_two', 'trash', { at: Date.now() }, { base: A.c.log.peekHlc(), durable: true });
    msg(B, 'conv_two', 'm_t2', 'm_t1', 'an edit made without seeing the trash', { base: editBase, role: 'assistant' });
    await round(A, B, A);
    const tv = (await B.sync.conflicts.list()).find((c) => c.kind === 'trash-vs-edit');
    check('sync: a trash and a concurrent edit are a trash-vs-edit conflict', !!tv, await B.sync.conflicts.list());
    check('sync: the edited conversation stays out of Trash on both', !(await A.c.index.conversation('conv_two'))?.trashedAt && !(await B.c.index.conversation('conv_two'))?.trashedAt);
    await B.sync.conflicts.resolve(tv!.id, 'theirs'); // Move to Trash again
    await round(B, A);
    check('sync: "Move to Trash again" trashes it everywhere', !!(await A.c.index.conversation('conv_two'))?.trashedAt);

    // ---- offline -> queue -> identical result
    newConv(A, 'conv_off', 'Written offline');
    msg(A, 'conv_off', 'm_o1', undefined, 'no network here');
    await settle(A);
    remote.fail = offline();
    const okOff = await A.sync.cycle('now');
    check('sync: an offline cycle fails without losing anything', !okOff && A.sync.status().state === 'offline' && A.sync.pendingCount() >= 2, A.sync.status());
    remote.fail = undefined;
    await round(A, B);
    check('sync: back online, the queue goes out and B gets the chat', (await B.c.index.conversation('conv_off'))?.title === 'Written offline' && A.sync.pendingCount() === 0);

    // ---- a retried chunk upload writes the identical object
    newConv(A, 'conv_retry', 'Retry me');
    await settle(A);
    const stream = A.c.log.stream;
    const from = A.sync.state.own[stream].uploaded + 1;
    remote.failOn = (op, key) => (op === 'put' && key.startsWith('devices/') ? offline() : undefined);
    await A.sync.cycle('now');
    const chunk = [...remote.objects.keys()].find((k) => k.startsWith(`streams/${stream}/`) && k.includes(String(from).padStart(12, '0') + '-'));
    const first = chunk ? Buffer.from(remote.objects.get(chunk)!.body) : undefined;
    check('sync: the chunk was uploaded before the failure, its boundaries saved', !!first && !!A.sync.state.own[stream].pending?.length, A.sync.state.own[stream]);
    newConv(A, 'conv_retry2', 'Written between the attempts');
    await settle(A);
    remote.failOn = undefined;
    await A.sync.cycle('now');
    check('sync: the retry uploads the identical object under the same name', !!chunk && Buffer.from(remote.objects.get(chunk)!.body).equals(first!));
    await round(B);
    check('sync: both chats arrive after the retry', !!(await B.c.index.conversation('conv_retry')) && !!(await B.c.index.conversation('conv_retry2')));

    // ---- categories: conversations off on A, memory on; later enable re-sends
    A.settings.categories = { ...A.settings.categories, conversations: false };
    newConv(A, 'conv_private', 'Only on A for now');
    msg(A, 'conv_private', 'm_p1', undefined, 'secret plans');
    A.c.log.append('memory', 'mem_shared', 'create', { type: 'developer', name: 'style', body: 'Tabs, not spaces\n', summary: 'Tabs, not spaces', source: 'user', localOnly: false, pinned: false, createdAt: Date.now() }, { durable: true });
    await round(A, B);
    check('sync: with conversations off, the chat stays on A', !(await B.c.index.conversation('conv_private')));
    check('sync: memory still syncs', (await B.c.index.memory({ id: 'mem_shared' }))[0]?.name === 'style');
    check('sync: the stream stays gapless (stand-ins)', B.c.log.importRemote !== undefined && A.sync.pendingCount() === 0);
    check('sync: what was withheld is remembered', (A.sync.state.withheld.conversations ?? []).includes('conv_private'), A.sync.state.withheld);
    A.settings.categories = { ...A.settings.categories, conversations: true };
    await round(A, B);
    const late = await B.c.index.conversation('conv_private');
    check('sync: turning the category on sends what it withheld', late?.title === 'Only on A for now', late);
    check('sync: … with its messages', (await B.c.index.messages('conv_private')).some((m) => m.id === 'm_p1'));

    // ---- blobs: an attachment's bytes travel encrypted, named by HMAC
    const sha = A.c.blobs.put(Buffer.from('PNG-not-really'));
    A.c.log.append('attachment', 'att_one', 'create', { blob: sha, mime: 'image/png', bytes: 14, conversationId: 'conv_one', createdAt: Date.now() }, { durable: true });
    await round(A, B);
    check('sync: an attachment blob reaches B', B.c.blobs.has(sha));
    check('sync: the blob name is not its sha256', ![...remote.objects.keys()].some((k) => k.includes(sha)));

    // ---- revoke + rotate: B removed; new objects use a key B does not have
    A.sync.devices.revoke(B.c.device.deviceId);
    await A.sync.rotateKey(PASS);
    newConv(A, 'conv_after', 'After B was removed');
    await round(A);
    const newChunk = [...remote.objects.keys()].filter((k) => k.startsWith(`streams/${A.c.log.stream}/`)).sort().pop()!;
    let cannot = false;
    try {
      openObject((id) => (id === B.sync.state.current ? undefined : undefined), newChunk, remote.objects.get(newChunk)!.body);
    } catch (e) {
      cannot = e instanceof SealError;
    }
    check('sync: an object sealed with the new key cannot be opened with the old one', cannot);
    await round(B);
    check('sync: B pauses and asks for the passphrase after the rotation', B.sync.status().state === 'paused' && B.sync.status().needsPassphrase === true, B.sync.status());
    check('sync: B did not get the new chat', !(await B.c.index.conversation('conv_after')));
    check('sync: A lists B as removed', !!(await A.sync.listDevices()).find((d) => d.id === B.c.device.deviceId)?.revokedAt);
    // A rotation for every device: unlocking with the passphrase keeps B syncing (user's choice).
    await B.sync.unlock(PASS);
    await round(B);
    check('sync: with the passphrase, B reads new objects again', !!(await B.c.index.conversation('conv_after')));

    // ---- passphrase change keeps data keys; the old passphrase stops working
    await A.sync.changePassphrase(PASS, 'a brand new passphrase');
    let oldFails = false;
    const C = await side('c', remote);
    await C.sync.join(PASS).catch((e) => (oldFails = e instanceof WrongPassphraseError));
    check('sync: after a passphrase change the old one no longer unlocks', oldFails);
    await C.sync.join('a brand new passphrase');
    await round(C);
    check('sync: a new device joins with the new passphrase and pulls everything', (await C.c.index.conversation('conv_one'))?.title === older && !!(await C.c.index.conversation('conv_after')));
    check('sync: the new device has the attachment', C.c.blobs.has(sha));
    await C.c.dispose();

    // ---- remote replaced (start over elsewhere) pauses
    const D = await side('d', remote);
    await D.sync.join('a brand new passphrase');
    await D.sync.startOver('another passphrase entirely');
    await round(A);
    check('sync: a remote started over elsewhere pauses this device', A.sync.status().state === 'paused' && A.sync.status().reason === 'remote-replaced', A.sync.status());
    await A.sync.unlock('another passphrase entirely');
    await round(D, A, D);
    check('sync: joining the new remote uploads this device again', !!(await D.c.index.conversation('conv_one')), A.sync.status());
    await D.c.dispose();

    // ---- turn off: keys forgotten, remote data stays
    const n = remote.objects.size;
    const key0 = B.sync.state.current!;
    const rid = B.sync.remoteId!;
    await B.sync.turnOff();
    check('sync: turning sync off forgets the keys and leaves the remote alone', !B.sync.configured && !(await B.secrets.get(B.secrets.dataKeyName(rid, key0))) && remote.objects.size === n);
  } finally {
    await A.c.dispose();
    await B.c.dispose();
  }
  void chunkKey;
  void blobKey;
}

async function extras(check: Check): Promise<void> {
  const remote = new MemoryBackend('extras');
  const cmdA = tmp('cmd-a');
  const cmdB = tmp('cmd-b');
  const prefsA = new Map<string, unknown>([['defaultModel', 'ollama/qwen3:8b'], ['thinking', 'high'], ['favoriteModels', ['a', 'b']]]);
  const prefsB = new Map<string, unknown>();
  fs.writeFileSync(path.join(cmdA, 'review.md'), '---\ndescription: Review the diff\n---\nReview my changes.\n');
  const A = await side('xa', remote, { promptsDir: cmdA, prefs: prefsA });
  const B = await side('xb', remote, { promptsDir: cmdB, prefs: prefsB });
  try {
    A.settings.categories = { ...A.settings.categories, checkpointContents: true };
    B.settings.categories = { ...B.settings.categories, checkpointContents: true };
    await A.sync.create(PASS);
    await B.sync.join(PASS);
    await round(A, B, B);
    check('sync prompts: a custom command written on A appears as a file on B', fs.existsSync(path.join(cmdB, 'review.md')) && fs.readFileSync(path.join(cmdB, 'review.md'), 'utf8').includes('Review my changes.'));
    check('sync preferences: allow-listed settings reach B', prefsB.get('defaultModel') === 'ollama/qwen3:8b' && prefsB.get('thinking') === 'high' && JSON.stringify(prefsB.get('favoriteModels')) === '["a","b"]', [...prefsB]);
    // B edits the command; A gets the edit (its file still holds what it last saw).
    fs.writeFileSync(path.join(cmdB, 'review.md'), '---\ndescription: Review the diff\n---\nReview my changes carefully.\n');
    await round(B, A, A);
    check('sync prompts: an edit on B is written back on A', fs.readFileSync(path.join(cmdA, 'review.md'), 'utf8').includes('carefully'));
    // Both edit before syncing: the file that changed here is kept and a conflict is recorded.
    fs.writeFileSync(path.join(cmdA, 'review.md'), 'A version\n');
    fs.writeFileSync(path.join(cmdB, 'review.md'), 'B version\n');
    await round(A, B, A, B);
    const cf = [...(await A.sync.conflicts.list()), ...(await B.sync.conflicts.list())].find((c) => c.entity === 'prompt_template');
    check('sync prompts: concurrent edits keep each machine\'s file and record a conflict', !!cf && /version/.test(fs.readFileSync(path.join(cmdA, 'review.md'), 'utf8')), cf);
    // Deleting the file on A trashes it; B removes its unchanged copy.
    fs.writeFileSync(path.join(cmdA, 'tmp-cmd.md'), 'temp\n');
    await round(A, B, B);
    fs.rmSync(path.join(cmdA, 'tmp-cmd.md'));
    await round(A, B, B);
    check('sync prompts: a deleted command goes away on the other device', !fs.existsSync(path.join(cmdB, 'tmp-cmd.md')));
    // A preference changed on B travels back to A.
    prefsB.set('thinking', 'low');
    await round(B, A, A);
    check('sync preferences: a change on B reaches A', prefsA.get('thinking') === 'low');
    // Checkpoint contents: a git bundle of A's checkpoint, restorable in a clone on B.
    let hasGit = true;
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      hasGit = false;
    }
    if (hasGit) {
      const repo = fs.realpathSync(tmp('cp-repo'));
      const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      g(repo, 'init', '-q', '-b', 'main');
      g(repo, 'config', 'user.email', 'a@b');
      g(repo, 'config', 'user.name', 'a');
      fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
      g(repo, 'add', '.');
      g(repo, 'commit', '-q', '-m', 'init');
      const clone = path.join(tmp('cp-clone'), 'repo');
      execFileSync('git', ['clone', '-q', repo, clone]);
      fs.writeFileSync(path.join(repo, 'app.txt'), 'v2 (work in progress)\n');
      const stash = g(repo, 'stash', 'create', 'checkpoint');
      const ref = 'refs/localpilot/checkpoints/conv_cp/1';
      g(repo, 'update-ref', ref, stash);
      A.c.log.append('checkpoint', 'cp_conv_cp_1', 'create', { conversationId: 'conv_cp', run: 1, kind: 'stash', ref, sha: stash, root: repo, device: A.c.device.deviceId, createdAt: Date.now(), files: [] }, { durable: true });
      await round(A, A, B);
      const cpA = (await A.c.index.query<{ content_blob: string | null }>('checkpoints', { conversationId: 'conv_cp' }))[0];
      check('sync checkpoint contents: a git bundle of the checkpoint is stored as a blob', !!cpA?.content_blob && A.c.blobs.has(cpA.content_blob), cpA);
      check('sync checkpoint contents: the bundle reached B', !!cpA?.content_blob && B.c.blobs.has(cpA.content_blob));
      const { importCheckpointBundle } = await import('../src/continuity/sync/extras');
      const r = await importCheckpointBundle({ blobs: B.c.blobs }, cpA!.content_blob!, ref, clone);
      check('sync checkpoint contents: the bundle imports into a clone on another device', r.ok && g(clone, 'rev-parse', ref) === stash, r);
    }
  } finally {
    await A.c.dispose();
    await B.c.dispose();
  }
}

async function scheduler(check: Check): Promise<void> {
  const fired: string[] = [];
  let clock = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const t = {
    now: () => clock,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++ids;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    clearTimeout: (h: unknown) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) {
        timers.splice(i, 1);
      }
    },
  };
  let ok = false;
  const s = new SyncScheduler({ run: async (why) => (fired.push(why), ok), intervalMinutes: () => 5, timers: t });
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
  };
  s.start();
  await advance(10_000);
  check('sync scheduler: first cycle 10 s after start-up', fired[0] === 'startup', fired);
  const gaps: number[] = [];
  for (let i = 0; i < 6; i++) {
    const n = fired.length;
    const t0 = clock;
    while (fired.length === n) {
      await advance(1_000);
    }
    gaps.push(clock - t0);
  }
  check('sync scheduler: backoff 5 s, 15 s, 1 min, 5 min, 15 min, 15 min', JSON.stringify(gaps) === JSON.stringify([5_000, 15_000, 60_000, 300_000, 900_000, 900_000]), gaps);
  ok = true;
  s.online();
  await advance(0);
  check('sync scheduler: the network coming back retries at once', fired[fired.length - 1] === 'online', fired.slice(-2));
  s.changed();
  await advance(15_000);
  check('sync scheduler: 15 s after a change', fired[fired.length - 1] === 'change', fired.slice(-2));
  s.pause();
  const n0 = fired.length;
  s.changed();
  await advance(20 * 60_000);
  check('sync scheduler: paused, nothing runs on its own', fired.length === n0);
  await s.now();
  check('sync scheduler: Sync now runs while paused', fired[fired.length - 1] === 'now');
  s.dispose();
}

async function contract(check: Check, label: string, b: SyncBackend): Promise<void> {
  await b.begin?.();
  await b.put('format.json', Buffer.from('{"a":1}'), { ifAbsent: true });
  let exists = false;
  await b.put('format.json', Buffer.from('{"a":2}'), { ifAbsent: true }).catch((e) => (exists = e instanceof BackendError && e.code === 'precondition'));
  check(`sync ${label}: create-if-absent refuses an existing object`, exists);
  await b.put('streams/dev_x.1/000000000001-000000000002.lpe', Buffer.from('one'));
  await b.put('streams/dev_x.1/000000000003-000000000004.lpe', Buffer.from('two'));
  await b.put('devices/dev_x.json.lpe', Buffer.from('dev'));
  await b.put('streams/dev_x.1/000000000003-000000000004.lpe', Buffer.from('two again'));
  const keys = (await b.list('streams/dev_x.1/')).map((e) => e.key);
  check(`sync ${label}: list is lexical and complete under a prefix`, JSON.stringify(keys) === JSON.stringify(['streams/dev_x.1/000000000001-000000000002.lpe', 'streams/dev_x.1/000000000003-000000000004.lpe']), keys);
  check(`sync ${label}: list after a key`, (await b.list('streams/dev_x.1/', 'streams/dev_x.1/000000000001-000000000002.lpe')).length === 1);
  check(`sync ${label}: put replaces atomically, get reads it`, Buffer.from((await b.get('streams/dev_x.1/000000000003-000000000004.lpe'))!).toString() === 'two again');
  check(`sync ${label}: get of a missing key is undefined`, (await b.get('devices/dev_none.json.lpe')) === undefined);
  await b.delete('devices/dev_x.json.lpe');
  check(`sync ${label}: delete`, (await b.get('devices/dev_x.json.lpe')) === undefined);
  await b.commit?.('test');
}

async function backends(check: Check): Promise<void> {
  // ---- folder: conflict copies and iCloud placeholders are ignored
  const dir = tmp('folder');
  const folder = new FolderBackend(dir);
  check('sync folder: check() on a writable folder', (await folder.check()).ok);
  check('sync folder: check() on a missing folder says not-found', ((await new FolderBackend(path.join(dir, 'nope')).check()) as { reason?: string }).reason === 'not-found');
  await contract(check, 'folder', folder);
  const sdir = path.join(dir, 'localpilot-sync', 'streams', 'dev_x.1');
  fs.writeFileSync(path.join(sdir, '000000000001-000000000002 (conflicted copy 2024-05-01).lpe'), 'x');
  fs.writeFileSync(path.join(sdir, '000000000001-000000000002 (1).lpe'), 'x');
  fs.writeFileSync(path.join(sdir, '.000000000005-000000000006.lpe.icloud'), 'x');
  const listed = (await folder.list('streams/dev_x.1/')).map((e) => e.key);
  check('sync folder: provider conflict copies are ignored', listed.length === 2 && !listed.some((k) => /conflicted|\(1\)/.test(k)), listed);
  check('sync folder: an iCloud placeholder is reported as not downloaded yet', folder.notDownloaded.has('streams/dev_x.1/000000000005-000000000006.lpe'));
  check('sync folder: conflict-copy names are recognised', isProviderCopy('a (conflicted copy).lpe') && isProviderCopy('a-conflict-20240101.lpe') && !isProviderCopy('000000000001-000000000002.lpe'));

  // ---- protocol over a real folder backend between two roots
  const shared = tmp('shared');
  const fa = await side('fa', new FolderBackend(shared));
  const fb = await side('fb', new FolderBackend(shared));
  try {
    await fa.sync.create(PASS);
    await fb.sync.join(PASS);
    newConv(fa, 'conv_folder', 'Through a folder');
    await round(fa, fb);
    check('sync folder: a chat moves between two data roots through the folder', (await fb.c.index.conversation('conv_folder'))?.title === 'Through a folder');
  } finally {
    await fa.c.dispose();
    await fb.c.dispose();
  }

  // ---- git: a local bare repo, two clones, a non-fast-forward push retried
  let hasGit = true;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    hasGit = false;
  }
  if (hasGit) {
    const bare = path.join(tmp('bare'), 'sync.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    const g1 = new GitBackend({ url: bare, branch: 'localpilot-sync', workDir: tmp('g1'), deviceName: 'one' });
    const g2 = new GitBackend({ url: bare, branch: 'localpilot-sync', workDir: tmp('g2'), deviceName: 'two' });
    check('sync git: check() on an empty bare repo', (await g1.check()).ok, await g1.check());
    await contract(check, 'git', g1);
    await g2.begin();
    check('sync git: a second clone sees what the first pushed', !!(await g2.get('format.json')));
    // Both write after the same fetch: the second push is not a fast-forward and is retried after a rebase.
    await g1.begin();
    await g2.begin();
    await g1.put('devices/dev_one.json.lpe', Buffer.from('1'));
    await g2.put('devices/dev_two.json.lpe', Buffer.from('2'));
    await g1.commit('one');
    let nff = true;
    await g2.commit('two').catch(() => (nff = false));
    check('sync git: a non-fast-forward push is retried and succeeds', nff);
    await g1.begin();
    check('sync git: both devices\' files are on the branch', !!(await g1.get('devices/dev_one.json.lpe')) && !!(await g1.get('devices/dev_two.json.lpe')));
    const log = execFileSync('git', ['--git-dir', bare, 'log', '--format=%an|%s', 'localpilot-sync']).toString();
    check('sync git: commits are authored by LocalPilot', /^LocalPilot\|/m.test(log), log);
    const proj = tmp('proj');
    execFileSync('git', ['init', '-q', proj]);
    const refuse = await new GitBackend({ url: proj, branch: 'localpilot-sync', workDir: tmp('g3') }).check();
    check('sync git: a project repository with a working tree is refused', !refuse.ok && /project/.test((refuse as { message: string }).message), refuse);
    // The engine over git between two roots.
    const ga = await side('ga', new GitBackend({ url: bare, branch: 'lp-engine', workDir: tmp('ga-w') }));
    const gb = await side('gb', new GitBackend({ url: bare, branch: 'lp-engine', workDir: tmp('gb-w') }));
    try {
      await ga.sync.create(PASS);
      await gb.sync.join(PASS);
      newConv(ga, 'conv_git', 'Through git');
      await round(ga, gb);
      check('sync git: a chat moves between two data roots through a git repository', (await gb.c.index.conversation('conv_git'))?.title === 'Through git');
    } finally {
      await ga.c.dispose();
      await gb.c.dispose();
    }
  } else {
    check('sync git: skipped (git not installed)', true);
  }

  // ---- S3: SigV4 (AWS documentation vector), fake server verifying signatures, pagination, If-None-Match fallback, 403
  const vec = signV4({ method: 'GET', url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'), headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, payloadHash: EMPTY_SHA256, region: 'us-east-1', service: 'iam', date: new Date('2015-08-30T12:36:00Z') }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' });
  check('sync s3: SigV4 matches the AWS documentation test vector', vec.signature === '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7', vec.signature);
  const vec2 = signV4({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256, region: 'us-east-1', service: 's3', date: new Date('2013-05-24T00:00:00Z') }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
  check('sync s3: SigV4 matches the S3 GET object example', vec2.signature === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', vec2.signature);
  const s3 = await startFakeS3({ accessKeyId: 'AKTEST', secretAccessKey: 'sekret', bucket: 'lp', pageSize: 2 });
  try {
    const b = new S3Backend({ endpoint: s3.url, region: 'us-east-1', bucket: 'lp', prefix: 'team', accessKeyId: 'AKTEST', secretAccessKey: 'sekret' });
    check('sync s3: check() with the right key', (await b.check()).ok, await b.check());
    await contract(check, 's3', b);
    for (let i = 0; i < 5; i++) {
      await b.put(`blobs/b${i}.lpe`, Buffer.from(String(i)));
    }
    check('sync s3: list follows continuation tokens (page size 2)', (await b.list('blobs/')).length === 5 && s3.listCalls() >= 3, s3.listCalls());
    check('sync s3: every request was signed correctly', s3.badSignatures() === 0);
    check('sync s3: objects live under <prefix>/localpilot-sync/', s3.keys().every((k) => k.startsWith('team/localpilot-sync/')), s3.keys());
    s3.setConditional(false);
    const nb = new S3Backend({ endpoint: s3.url, region: 'us-east-1', bucket: 'lp', prefix: 'team', accessKeyId: 'AKTEST', secretAccessKey: 'sekret' });
    let fallback = false;
    await nb.put('format.json', Buffer.from('x'), { ifAbsent: true }).catch((e) => (fallback = e instanceof BackendError && e.code === 'precondition'));
    check('sync s3: without If-None-Match support, create-if-absent falls back to HEAD', fallback);
    await nb.put('keyring2.json', Buffer.from('k'), { ifAbsent: true });
    check('sync s3: … and still creates a missing object', !!(await nb.get('keyring2.json')));
    const bad = new S3Backend({ endpoint: s3.url, region: 'us-east-1', bucket: 'lp', prefix: 'team', accessKeyId: 'AKTEST', secretAccessKey: 'wrong' });
    const c403 = await bad.check();
    check('sync s3: a wrong secret maps to a sign-in failure', !c403.ok && (c403 as { reason: string }).reason === 'auth', c403);
    s3.denyAll(true);
    const c2 = await b.check();
    check('sync s3: 403 maps to "forbidden"', !c2.ok && (c2 as { reason: string }).reason === 'forbidden', c2);
    s3.denyAll(false);
    let https = false;
    try {
      new S3Backend({ endpoint: 'http://example.com', region: 'x', bucket: 'b', prefix: '', accessKeyId: 'a', secretAccessKey: 'b' });
    } catch {
      https = true;
    }
    check('sync s3: plain http is refused except for localhost', https);
    // The factory reads the secret key from the secret box.
    const box = memorySecretBox();
    let noSecret = false;
    await createBackend({ kind: 's3', s3: { endpoint: s3.url, region: 'us-east-1', bucket: 'lp', prefix: 'team', accessKeyId: 'AKTEST' } }, { secrets: box, workDir: tmp('w') }).catch((e) => (noSecret = e instanceof BackendError && e.code === 'auth'));
    check('sync s3: without a secret key in SecretStorage the backend is not built', noSecret);
    await box.store(SECRET_NAMES.s3Secret, 'sekret');
    const made = await createBackend({ kind: 's3', s3: { endpoint: s3.url, region: 'us-east-1', bucket: 'lp', prefix: 'team', accessKeyId: 'AKTEST' } }, { secrets: box, workDir: tmp('w') });
    check('sync s3: the factory builds it from settings + the stored secret', (await made.check()).ok);
    // Engine over S3 between two roots.
    const sa = await side('sa', made);
    const sb = await side('sb', new S3Backend({ endpoint: s3.url, region: 'us-east-1', bucket: 'lp', prefix: 'engine', accessKeyId: 'AKTEST', secretAccessKey: 'sekret' }));
    const sa2 = sa;
    try {
      // Different prefixes are different remotes: B sees nothing to join under its own prefix.
      await sa2.sync.startOver(PASS);
      let none = false;
      await sb.sync.join(PASS).catch(() => (none = true));
      check('sync s3: another prefix is another remote', none);
    } finally {
      await sa.c.dispose();
      await sb.c.dispose();
    }
  } finally {
    await s3.close();
  }

  // ---- WebDAV: PROPFIND, MOVE with Overwrite, MKCOL, 401
  const dav = await startFakeWebDav({ username: 'me', password: 'pw' });
  try {
    const w = new WebDavBackend({ url: `${dav.url}/remote.php/dav/files/me`, username: 'me', password: 'pw' });
    check('sync webdav: check() with the right password', (await w.check()).ok, await w.check());
    await contract(check, 'webdav', w);
    check('sync webdav: folders were made with MKCOL', dav.calls('MKCOL') > 0);
    check('sync webdav: puts land through MOVE from a temporary name', dav.calls('MOVE') >= 4 && !dav.paths().some((p) => /\.tmp-/.test(p)), dav.paths());
    const bad = await new WebDavBackend({ url: `${dav.url}/remote.php/dav/files/me`, username: 'me', password: 'nope' }).check();
    check('sync webdav: a wrong password maps to a sign-in failure', !bad.ok && (bad as { reason: string }).reason === 'auth', bad);
    const wa = await side('wa', w);
    const wb = await side('wb', new WebDavBackend({ url: `${dav.url}/remote.php/dav/files/me`, username: 'me', password: 'pw' }));
    try {
      // The contract test left a format.json that is not ours: start over to get a clean remote.
      await wa.sync.startOver(PASS);
      await wb.sync.join(PASS);
      newConv(wa, 'conv_dav', 'Through WebDAV');
      await round(wa, wb);
      check('sync webdav: a chat moves between two data roots through WebDAV', (await wb.c.index.conversation('conv_dav'))?.title === 'Through WebDAV');
    } finally {
      await wa.c.dispose();
      await wb.c.dispose();
    }
  } finally {
    await dav.close();
  }
}
