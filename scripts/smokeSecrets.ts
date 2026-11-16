/**
 * Smoke checks (bundled into scripts/smoke.ts) for the encrypted secret store: round trip; the whole file is sealed so
 * neither names nor values are on disk; a wrong key, a wrong passphrase and a tampered file are rejected; no keychain
 * and no passphrase is refused (no plain-text fallback); two store instances writing in turn never lose an entry and see
 * each other's changes; "last used"; the move of the legacy plain-text files (deleted only once every value reads
 * back, an unreadable one left alone); and the keychain commands, built with a fake runner, carry values on stdin only.
 * Everything uses temp folders and an in-memory keychain: never the developer's keychain or ~/.localpilot.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MacKeychain, MemoryKeychain, Runner, SecretServiceKeychain, systemKeychain, WindowsKeychain } from '../src/secrets/keychain';
import { MASTER_KEY_ACCOUNT, SecretStore, SecretStoreLockedError } from '../src/secrets/store';
import { migrateLegacyFile } from '../src/secrets/cliSecrets';
import { keyForName, nameForKey, StoreSecretStorage } from '../src/secrets/storeStorage';
import { secretUsage, usedBy } from '../src/secrets/usage';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

async function rejects(p: Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof SecretStoreLockedError && re.test(e.message);
  }
}

export async function secretsSmoke(check: Check): Promise<void> {
  console.log('\n[Secret store]');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-secrets-smoke-'));
  try {
    // ---------------------------------------------------------------- round trip, keychain mode
    const dir = path.join(root, 'a');
    const kc = new MemoryKeychain('Fake Keychain');
    const a = await SecretStore.open({ dir, keychain: kc });
    a.set('openai', 'sk-ROUNDTRIP-openai-123', 'test');
    a.setMany({ 'localpilot.mcp.oauth.https://mcp.example.com': '{"access_token":"tok-XYZ"}', anthropic: 'sk-ant-ROUNDTRIP' }, 'test');
    const st = a.status();
    check('store: set / get / has / all round trip', a.get('openai') === 'sk-ROUNDTRIP-openai-123' && a.has('anthropic') && !a.has('nope') && Object.keys(a.all()).length === 3);
    check('store: status says AES-256-GCM, unlocked by the keychain, with the count', st.cipher === 'AES-256-GCM' && st.mode === 'keychain' && st.unlockedBy === 'Fake Keychain' && st.count === 3 && st.bytes > 0 && st.file === path.join(dir, 'secrets.db'), st);
    check('store: the key was created in the keychain (32 bytes, base64)', Buffer.from(kc.entries.get(MASTER_KEY_ACCOUNT) ?? '', 'base64').length === 32);
    const meta = a.list().find((m) => m.name === 'openai');
    check('store: list gives metadata only', !!meta && meta.source === 'test' && meta.length === 'sk-ROUNDTRIP-openai-123'.length && !('value' in (meta as object)) && meta.createdAt > 0);
    const raw = fs.readFileSync(path.join(dir, 'secrets.db'));
    check('store: the whole file is sealed (no names, no values, not SQLite)', raw.subarray(0, 6).toString() === 'LPSEC1' && raw[6] === 1 && !raw.includes('openai') && !raw.includes('sk-ROUNDTRIP') && !raw.includes('mcp.example.com') && !raw.includes('SQLite format'));
    if (process.platform !== 'win32') {
      check('store: file readable by the owner only (0600)', (fs.statSync(path.join(dir, 'secrets.db')).mode & 0o777) === 0o600);
    }
    check('store: an empty value is refused', (() => { try { a.set('x', ''); return false; } catch { return true; } })());
    check('store: delete', a.delete('anthropic') && !a.delete('anthropic') && a.get('anthropic') === undefined);
    a.close();
    const again = await SecretStore.open({ dir, keychain: kc });
    check('store: reopened with the same keychain key, values are there', again.get('openai') === 'sk-ROUNDTRIP-openai-123' && again.get('anthropic') === undefined);
    again.close();

    // ---------------------------------------------------------------- wrong or missing key, tampering
    const other = new MemoryKeychain('Fake Keychain');
    other.entries.set(MASTER_KEY_ACCOUNT, Buffer.alloc(32, 7).toString('base64'));
    check('store: a different key in the keychain is rejected', await rejects(SecretStore.open({ dir, keychain: other }), /could not be decrypted/));
    check('store: the key missing from the keychain is a clear error (no new key over old data)', await rejects(SecretStore.open({ dir, keychain: new MemoryKeychain('Fake Keychain') }), /missing from the Fake Keychain/));
    check('store: keychain turned off for a keychain-sealed file is refused', await rejects(SecretStore.open({ dir, keychain: null, passphrase: 'x' }), /LOCALPILOT_KEYCHAIN=none/));

    const pdir = path.join(root, 'p');
    const p = await SecretStore.open({ dir: pdir, keychain: null, passphrase: 'correct horse' });
    p.set('groq', 'gsk-PASSPHRASE-1');
    p.close();
    const praw = fs.readFileSync(path.join(pdir, 'secrets.db'));
    check('store: passphrase mode (mode byte 2), sealed', praw[6] === 2 && !praw.includes('groq') && !praw.includes('gsk-PASSPHRASE'));
    const reopened = await SecretStore.open({ dir: pdir, keychain: null, passphrase: 'correct horse' });
    check('store: passphrase reopens it', reopened.get('groq') === 'gsk-PASSPHRASE-1' && reopened.status().unlockedBy === 'passphrase');
    reopened.close();
    check('store: a wrong passphrase is rejected', await rejects(SecretStore.open({ dir: pdir, keychain: null, passphrase: 'wrong horse' }), /passphrase is wrong/));
    check('store: no passphrase for a passphrase file says what to set', await rejects(SecretStore.open({ dir: pdir, keychain: null, passphrase: '' }), /LOCALPILOT_SECRETS_PASSPHRASE/));
    const tampered = Buffer.from(praw);
    tampered[tampered.length - 3] ^= 0x01;
    fs.writeFileSync(path.join(pdir, 'secrets.db'), tampered);
    check('store: a changed byte in the ciphertext is rejected', await rejects(SecretStore.open({ dir: pdir, keychain: null, passphrase: 'correct horse' }), /could not be decrypted/));
    const header = Buffer.from(praw);
    header[10] ^= 0x01; // inside the salt: authenticated as additional data
    fs.writeFileSync(path.join(pdir, 'secrets.db'), header);
    check('store: a changed header (salt) is rejected', await rejects(SecretStore.open({ dir: pdir, keychain: null, passphrase: 'correct horse' }), /could not be decrypted/));
    fs.writeFileSync(path.join(pdir, 'secrets.db'), '{"plain":"text"}');
    check('store: a file that is not a store is refused, not overwritten', (await rejects(SecretStore.open({ dir: pdir, keychain: null, passphrase: 'correct horse' }), /not a LocalPilot secret store/)) && fs.readFileSync(path.join(pdir, 'secrets.db'), 'utf8') === '{"plain":"text"}');

    const none = path.join(root, 'none');
    check('store: no keychain and no passphrase is refused (no plain-text fallback)', (await rejects(SecretStore.open({ dir: none, keychain: null, passphrase: '' }), /LOCALPILOT_SECRETS_PASSPHRASE/)) && !fs.existsSync(path.join(none, 'secrets.db')));
    const broken: MemoryKeychain = Object.assign(new MemoryKeychain('Broken Keychain'), { set: async () => undefined });
    check('store: a keychain that drops the key is not trusted', await rejects(SecretStore.open({ dir: path.join(root, 'broken'), keychain: broken, passphrase: '' }), /did not work/));
    const fellBack = await SecretStore.open({ dir: path.join(root, 'broken2'), keychain: broken, passphrase: 'pp' });
    check('store: a failing keychain with a passphrase set uses the passphrase', fellBack.status().mode === 'passphrase');
    fellBack.close();

    // ---------------------------------------------------------------- two writers, refresh
    const sdir = path.join(root, 'shared');
    const skc = new MemoryKeychain();
    const [x, y] = await Promise.all([SecretStore.open({ dir: sdir, keychain: skc }), SecretStore.open({ dir: sdir, keychain: skc })]);
    check('store: two first opens at once agree on one key', skc.entries.size === 1 && fs.existsSync(path.join(sdir, 'secrets.db')));
    const seen: string[] = [];
    y.onDidChange((names) => seen.push(...names));
    for (let i = 0; i < 20; i++) {
      (i % 2 ? y : x).set(`k${i}`, `v${i}`);
    }
    const all = x.all();
    check('store: two instances writing in turn lose nothing', Array.from({ length: 20 }, (_, i) => all[`k${i}`] === `v${i}`).every(Boolean) && Object.keys(y.all()).length === 20, Object.keys(all));
    seen.length = 0;
    x.set('fresh', 'from-x');
    const changed = y.refresh();
    check('store: refresh sees another instance\'s change and reports it', changed.includes('fresh') && seen.includes('fresh') && y.get('fresh') === 'from-x');
    x.delete('fresh');
    check('store: a read picks up another instance\'s delete', y.get('fresh') === undefined);
    fs.writeFileSync(path.join(sdir, 'secrets.db.lock'), JSON.stringify({ pid: 999999, host: os.hostname(), at: 0 }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(sdir, 'secrets.db.lock'), old, old);
    x.set('after-stale-lock', '1');
    check('store: a stale lock (dead process) is broken', y.get('after-stale-lock') === '1' && !fs.existsSync(path.join(sdir, 'secrets.db.lock')));

    // ---------------------------------------------------------------- last used
    let now = 1_000_000;
    const t = await SecretStore.open({ dir: path.join(root, 'touch'), keychain: new MemoryKeychain(), now: () => now });
    t.set('used', 'v');
    t.touch('used');
    const first = t.list()[0].lastUsedAt;
    const stamp = fs.statSync(t.file).mtimeMs;
    now += 10_000;
    t.touch('used');
    const unchanged = t.list()[0].lastUsedAt === first && fs.statSync(t.file).mtimeMs === stamp;
    now += 61_000;
    t.touch('used');
    t.touch('missing');
    check('store: touch records last use, at most once a minute', first === 1_000_000 && unchanged && t.list()[0].lastUsedAt === now);
    t.close();

    // ---------------------------------------------------------------- legacy files
    const ldir = path.join(root, 'legacy');
    fs.mkdirSync(ldir);
    const keysJson = path.join(ldir, 'keys.json');
    fs.writeFileSync(keysJson, JSON.stringify({ anthropic: 'sk-legacy-ant', 'sync:r1:k1': 'ZGF0YWtleQ==', x: 'same' }));
    const corrupt = path.join(ldir, 'secrets.json');
    fs.writeFileSync(corrupt, '{ not json');
    const ls = await SecretStore.open({ dir: path.join(ldir, 'store'), keychain: new MemoryKeychain() });
    ls.set('x', 'same');
    const m = migrateLegacyFile(ls, keysJson);
    check('legacy keys.json: moved into the store, then deleted', !!m && m.deleted && !m.error && ls.get('anthropic') === 'sk-legacy-ant' && ls.get('sync:r1:k1') === 'ZGF0YWtleQ==' && !fs.existsSync(keysJson) && ls.list().find((e) => e.name === 'anthropic')?.source === 'migrated:keys.json', m);
    const bad = migrateLegacyFile(ls, corrupt);
    check('legacy file that is not valid JSON is left untouched', !!bad && !bad.deleted && /not valid JSON/.test(bad.error ?? '') && fs.readFileSync(corrupt, 'utf8') === '{ not json');
    fs.writeFileSync(keysJson, JSON.stringify({ anthropic: 'sk-OTHER-value' }));
    const conflict = migrateLegacyFile(ls, keysJson);
    check('legacy value for a name the store has differently is kept under another name', !!conflict?.deleted && ls.get('anthropic') === 'sk-legacy-ant' && ls.get('anthropic.from-keys') === 'sk-OTHER-value');
    fs.writeFileSync(keysJson, JSON.stringify({ newone: 'sk-new' }));
    const realAll = ls.all.bind(ls);
    let calls = 0;
    // The read-back after the write does not show the value: the file must stay.
    (ls as unknown as { all: () => Record<string, string> }).all = () => (++calls > 1 ? {} : realAll());
    const unverified = migrateLegacyFile(ls, keysJson);
    (ls as unknown as { all: () => Record<string, string> }).all = realAll;
    check('legacy file is kept when a value does not read back', !!unverified && !unverified.deleted && fs.existsSync(keysJson), unverified);
    ls.close();

    // ---------------------------------------------------------------- adapters and usage
    check('storage keys: provider prefix maps to the bare name and back', nameForKey('localpilot.provider.openai') === 'openai' && keyForName('openai') === 'localpilot.provider.openai' && nameForKey('localpilot.mcp.oauth.x') === 'localpilot.mcp.oauth.x' && keyForName('localpilot.sync.s3.secretAccessKey') === 'localpilot.sync.s3.secretAccessKey');
    const ad = await SecretStore.open({ dir: path.join(root, 'adapter'), keychain: new MemoryKeychain() });
    const storage = new StoreSecretStorage(ad);
    const events: string[] = [];
    storage.onDidChange((e) => events.push(e.key));
    await storage.store('localpilot.mcp.oauth.https://a', 'tok');
    await storage.store('localpilot.provider.groq', 'gsk');
    check('StoreSecretStorage: SecretStorage shape over the store', (await storage.get('localpilot.mcp.oauth.https://a')) === 'tok' && ad.get('groq') === 'gsk' && events.includes('localpilot.provider.groq') && (await storage.keys()).includes('localpilot.provider.groq'));
    storage.dispose();
    ad.close();
    const use = secretUsage({ providers: [{ id: 'openai', displayName: 'OpenAI', apiKey: '${secret:openai}' }, { id: 'gw', headers: { 'X-Key': 'Bearer ${secret:gw-token}' } }], webSearchApiKey: '${secret:webSearch}', mcpServers: { github: { env: { TOKEN: '${secret:gh}' } } } });
    check('usage: providers, headers, web search, MCP servers, sign-in tokens and sync', usedBy('openai', use)[0] === 'provider OpenAI' && usedBy('gw-token', use)[0] === 'provider gw' && usedBy('webSearch', use)[0] === 'web search' && usedBy('gh', use)[0] === 'MCP github' && /MCP sign-in/.test(usedBy('localpilot.mcp.oauth.https://x', use)[0]) && usedBy('sync:r:k', use)[0] === 'sync' && !usedBy('orphan', use).length);

    // ---------------------------------------------------------------- keychain commands
    const calls2: { file: string; args: string[]; input?: string }[] = [];
    const fake = (reply: Partial<{ code: number; stdout: string; stderr: string }> = {}): Runner => async (file, args, input) => {
      calls2.push({ file, args, input });
      return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    };
    const secret = 'sk-"quoted" \\ value';
    await new MacKeychain(fake()).set('acct', secret);
    const mac = calls2.pop()!;
    check('macOS keychain: set runs `security -i` with the value on stdin only', mac.file === '/usr/bin/security' && mac.args.join(' ') === '-i' && !!mac.input?.includes('add-generic-password -U -s "LocalPilot" -a "acct"') && mac.input.includes('-w "sk-\\"quoted\\" \\\\ value"'), mac);
    check('macOS keychain: get reads -w output; 44 is "not found"', (await new MacKeychain(fake({ stdout: 'abc\n' })).get('acct')) === 'abc' && (await new MacKeychain(fake({ code: 44 })).get('acct')) === undefined && calls2.every((c) => !c.args.includes(secret)));
    await new SecretServiceKeychain(fake()).set('acct', secret);
    const lin = calls2.pop()!;
    check('Secret Service: secret-tool store with the value on stdin only', lin.file === 'secret-tool' && lin.args[0] === 'store' && lin.args.includes('LocalPilot') && lin.args.includes('acct') && lin.input === secret && !lin.args.some((a) => a.includes(secret)));
    check('Secret Service: exit 1 without an error is "not found", with one an error', (await new SecretServiceKeychain(fake({ code: 1 })).get('acct')) === undefined && (await new SecretServiceKeychain(fake({ code: 1, stderr: 'Cannot autolaunch D-Bus' })).get('acct').then(() => false, () => true)));
    await new WindowsKeychain(fake()).set('acct', secret);
    const win = calls2.pop()!;
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const script = Buffer.from(win.args[win.args.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le');
    check('Windows Credential Manager: PowerShell + advapi32, the value base64 on stdin only', win.input === b64 && !win.args.some((a) => a.includes(secret) || a.includes(b64)) && /CredWriteW/.test(script) && script.includes("'LocalPilot/acct'") && !script.includes(secret) && !script.includes(b64));
    check('Windows Credential Manager: get decodes base64; exit 3 is "not found"', (await new WindowsKeychain(fake({ stdout: Buffer.from('k€y').toString('base64') })).get('a')) === 'k€y' && (await new WindowsKeychain(fake({ code: 3 })).get('a')) === undefined);
    check('systemKeychain: LOCALPILOT_KEYCHAIN=none turns it off; one per platform', systemKeychain({ LOCALPILOT_KEYCHAIN: 'none' }, 'darwin') === undefined && systemKeychain({}, 'darwin') instanceof MacKeychain && systemKeychain({}, 'win32') instanceof WindowsKeychain && systemKeychain({}, 'linux') instanceof SecretServiceKeychain);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
