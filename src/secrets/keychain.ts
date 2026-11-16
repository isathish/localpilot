// The operating system's credential store, reached through the tools every desktop already has: `security` on macOS,
// Credential Manager (advapi32 through PowerShell) on Windows, the Secret Service (`secret-tool`, libsecret) on Linux.
// Pure Node, so the extension and the CLI share it. A value is only ever written to the child's stdin, never put on a
// command line, where other users could read it in the process list.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Service name every LocalPilot entry is filed under. */
export const KEYCHAIN_SERVICE = 'LocalPilot';

export interface Keychain {
  /** Shown to the user: "macOS Keychain", "Windows Credential Manager"… */
  readonly label: string;
  /** The tool is there (it may still fail, e.g. no Secret Service running). */
  available(): Promise<boolean>;
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program with `input` on stdin. Replaceable in tests, which check that secrets only ever travel there. */
export type Runner = (file: string, args: string[], input?: string) => Promise<RunResult>;

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

export const spawnRunner: Runner = (file, args, input) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    // A keychain that waits for a password dialog nobody answers must not hang the store forever.
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });

/** Quotes one argument for `security -i`, which splits its input line like a shell does with double quotes. */
function securityQuote(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** macOS: generic passwords in the login keychain through /usr/bin/security (or `keychainFile`, for tests). */
export class MacKeychain implements Keychain {
  readonly label = 'macOS Keychain';
  constructor(
    private readonly run: Runner = spawnRunner,
    private readonly bin = '/usr/bin/security',
    private readonly keychainFile?: string
  ) {}

  private tail(): string[] {
    return this.keychainFile ? [this.keychainFile] : [];
  }

  async available(): Promise<boolean> {
    return fs.existsSync(this.bin);
  }

  async get(account: string): Promise<string | undefined> {
    const r = await this.run(this.bin, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', ...this.tail()]);
    if (r.code === 0) {
      return r.stdout.replace(/\r?\n$/, '');
    }
    // 44 = errSecItemNotFound.
    if (r.code === 44) {
      return undefined;
    }
    throw new KeychainError(`macOS Keychain: ${r.stderr.trim() || `security exited with ${r.code}`}`);
  }

  async set(account: string, value: string): Promise<void> {
    // `security -i` reads the command from stdin, so the value never shows up in `ps`.
    const line = ['add-generic-password', '-U', '-s', securityQuote(KEYCHAIN_SERVICE), '-a', securityQuote(account), '-l', securityQuote(`${KEYCHAIN_SERVICE} (${account})`), '-w', securityQuote(value), ...this.tail().map(securityQuote)].join(' ');
    const r = await this.run(this.bin, ['-i'], `${line}\n`);
    if (r.code !== 0 || /error|returned -\d+|could not/i.test(r.stderr)) {
      throw new KeychainError(`macOS Keychain: ${r.stderr.trim() || `security exited with ${r.code}`}`);
    }
  }

  async delete(account: string): Promise<void> {
    const r = await this.run(this.bin, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, ...this.tail()]);
    if (r.code !== 0 && r.code !== 44) {
      throw new KeychainError(`macOS Keychain: ${r.stderr.trim() || `security exited with ${r.code}`}`);
    }
  }
}

/** Linux and BSD: the Secret Service (GNOME Keyring, KWallet…) through `secret-tool` from libsecret. */
export class SecretServiceKeychain implements Keychain {
  readonly label = 'Secret Service (libsecret)';
  constructor(
    private readonly run: Runner = spawnRunner,
    private readonly bin = 'secret-tool',
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async available(): Promise<boolean> {
    return !!onPath(this.bin, this.env);
  }

  async get(account: string): Promise<string | undefined> {
    const r = await this.run(this.bin, ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
    if (r.code === 0) {
      return r.stdout.replace(/\r?\n$/, '');
    }
    // Not found: exit 1 and nothing on stderr. Anything else (no D-Bus session, locked collection) is an error.
    if (r.code === 1 && !r.stderr.trim()) {
      return undefined;
    }
    throw new KeychainError(`Secret Service: ${r.stderr.trim() || `secret-tool exited with ${r.code}`}`);
  }

  async set(account: string, value: string): Promise<void> {
    const r = await this.run(this.bin, ['store', `--label=${KEYCHAIN_SERVICE} (${account})`, 'service', KEYCHAIN_SERVICE, 'account', account], value);
    if (r.code !== 0) {
      throw new KeychainError(`Secret Service: ${r.stderr.trim() || `secret-tool exited with ${r.code}`}`);
    }
  }

  async delete(account: string): Promise<void> {
    const r = await this.run(this.bin, ['clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
    if (r.code !== 0 && !(r.code === 1 && !r.stderr.trim())) {
      throw new KeychainError(`Secret Service: ${r.stderr.trim() || `secret-tool exited with ${r.code}`}`);
    }
  }
}

/** The C# helper PowerShell compiles: CredReadW / CredWriteW / CredDeleteW on generic credentials. */
const WIN_CRED_TYPE = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LocalPilotCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == 1168) { return null; }
      throw new System.ComponentModel.Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (c.CredentialBlobSize > 0) { Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize); }
      return Convert.ToBase64String(b);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string base64) {
    byte[] b = Convert.FromBase64String(base64);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(b.Length, 1));
    try {
      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
      if (!CredWriteW(ref c, 0)) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static void Delete(string target) {
    if (!CredDeleteW(target, 1, 0)) {
      int e = Marshal.GetLastWin32Error();
      if (e != 1168) { throw new System.ComponentModel.Win32Exception(e); }
    }
  }
}`;

/** A PowerShell single-quoted string. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Windows: generic credentials in Credential Manager (target `LocalPilot/<account>`), through PowerShell calling
 * advapi32. Values travel base64-encoded on stdin and stdout, so console code pages cannot mangle them.
 */
export class WindowsKeychain implements Keychain {
  readonly label = 'Windows Credential Manager';
  constructor(
    private readonly run: Runner = spawnRunner,
    private readonly bin = 'powershell.exe'
  ) {}

  private script(body: string): string[] {
    const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${WIN_CRED_TYPE}\n'@\n${body}`;
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }

  private target(account: string): string {
    return `${KEYCHAIN_SERVICE}/${account}`;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async get(account: string): Promise<string | undefined> {
    const r = await this.run(this.bin, this.script(`$v = [LocalPilotCred]::Read(${psQuote(this.target(account))})\nif ($null -eq $v) { exit 3 }\n[Console]::Out.Write($v)`));
    if (r.code === 3) {
      return undefined;
    }
    if (r.code !== 0) {
      throw new KeychainError(`Windows Credential Manager: ${r.stderr.trim() || `PowerShell exited with ${r.code}`}`);
    }
    return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
  }

  async set(account: string, value: string): Promise<void> {
    const r = await this.run(
      this.bin,
      this.script(`$in = [Console]::In.ReadToEnd().Trim()\n[LocalPilotCred]::Write(${psQuote(this.target(account))}, ${psQuote(account)}, $in)`),
      Buffer.from(value, 'utf8').toString('base64')
    );
    if (r.code !== 0) {
      throw new KeychainError(`Windows Credential Manager: ${r.stderr.trim() || `PowerShell exited with ${r.code}`}`);
    }
  }

  async delete(account: string): Promise<void> {
    const r = await this.run(this.bin, this.script(`[LocalPilotCred]::Delete(${psQuote(this.target(account))})`));
    if (r.code !== 0) {
      throw new KeychainError(`Windows Credential Manager: ${r.stderr.trim() || `PowerShell exited with ${r.code}`}`);
    }
  }
}

/** In memory, for tests: never touches the real keychain. */
export class MemoryKeychain implements Keychain {
  readonly entries = new Map<string, string>();
  constructor(
    readonly label = 'test keychain',
    private readonly up = true
  ) {}
  async available(): Promise<boolean> {
    return this.up;
  }
  async get(account: string): Promise<string | undefined> {
    return this.entries.get(account);
  }
  async set(account: string, value: string): Promise<void> {
    this.entries.set(account, value);
  }
  async delete(account: string): Promise<void> {
    this.entries.delete(account);
  }
}

function onPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, bin);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * This machine's keychain, or undefined when there is none to use. `LOCALPILOT_KEYCHAIN=none` turns it off (tests,
 * headless servers that unlock the store with LOCALPILOT_SECRETS_PASSPHRASE instead).
 */
export function systemKeychain(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, run: Runner = spawnRunner): Keychain | undefined {
  if (/^(none|off|0|false)$/i.test(env.LOCALPILOT_KEYCHAIN ?? '')) {
    return undefined;
  }
  if (platform === 'darwin') {
    return new MacKeychain(run);
  }
  if (platform === 'win32') {
    return new WindowsKeychain(run, path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  return new SecretServiceKeychain(run, 'secret-tool', env);
}
