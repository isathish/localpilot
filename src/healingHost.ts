import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChangeTracker } from './agent/changeTracker';
import {
  attemptCap, CHECKS_FILE, CHECKS_TEMPLATE, checkSemaphore, clearChecksCache, discoverChecks, HealingService, recoveryBus, RecoveryStore,
  type FailureMemory, type HealingEngineConfig, type RecoveryState,
} from './agent/healing';
import { changedFilesScan, lastWriter, memoryResolver, osvDependencyScan, providerProbe, readAttemptSnapshot, repoGraphView } from './agent/healing/hostAdapters';
import { audit, flooredApproval, getManagedPolicy } from './agent/managedPolicy';
import { getConfig } from './config';
import { buildRepoGraph } from './context/repoGraph';
import type { McpManager } from './mcp/mcpManager';
import type { ProviderRegistry } from './providers/registry';
import type { Telemetry } from './telemetry/telemetry';
import { samePath } from './terminal/terminalManager';
import { deleteUri } from './tools/fs';

/** Serves the pre-attempt snapshots behind "Open diff" on an applied patch (Dashboard → Applied Patches). */
export const RECOVERY_SNAPSHOT_SCHEME = 'localpilot-recovery';

export interface HealingHostDeps {
  /** `<storageUri|globalStorageUri>`: the recovery store and workspace failure memory live under `recovery/`. */
  storageDir: string;
  log: vscode.LogOutputChannel;
  telemetry: Telemetry;
  providers: ProviderRegistry;
  tracker: ChangeTracker;
  mcp: McpManager;
  /** Sessions with a run in flight (foreign-failure attribution). */
  liveSessions: () => readonly string[];
  root: () => string | undefined;
}

export interface HealingHost {
  service: HealingService;
  store: RecoveryStore;
  memory: (root: string) => FailureMemory | undefined;
}

/** `getConfig().healing`, with `healing.checks` from User settings only while the workspace is untrusted. */
function healingConfig(): HealingEngineConfig {
  const cfg = getConfig().healing;
  if (vscode.workspace.isTrusted) {
    return cfg;
  }
  const user = vscode.workspace.getConfiguration('localpilot').inspect<unknown>('healing.checks')?.globalValue;
  return { ...cfg, checks: Array.isArray(user) ? user : [] };
}

/** ChangeTracker-compatible restore: open documents are edited and saved, missing files recreated, `undefined` deletes. */
export async function restoreWorkspaceFile(fsPath: string, content: string | undefined): Promise<void> {
  const uri = vscode.Uri.file(fsPath);
  const exists = await Promise.resolve(vscode.workspace.fs.stat(uri)).then(() => true, () => false);
  if (content === undefined) {
    if (exists) {
      await deleteUri(uri);
    }
  } else if (!exists) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  } else {
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }
}

/** The OSV.dev check of `securityCheck: 'full'` asks like `security_scan` does: policy, `approvals.network`, then the user. */
function networkApproval(log: vscode.LogOutputChannel): (root: string, signal: AbortSignal) => Promise<boolean> {
  let window = false;
  return async (root, signal) => {
    const policy = getManagedPolicy(log);
    const record = (decision: string) => audit(policy, { event: 'recovery_dependency_check', decision }, root, log);
    if (!policy.allowWebAccess) {
      record('blocked');
      return false;
    }
    const mode = flooredApproval(policy, 'network', getConfig().approvals.network);
    if (mode === 'never') {
      record('denied');
      return false;
    }
    if (mode === 'always' || window) {
      record('auto');
      return true;
    }
    const ask = vscode.window.showWarningMessage(
      'Self-healing: check this workspace\'s dependencies against OSV.dev? Package names and versions from the lockfiles are sent to api.osv.dev; no code leaves the machine.',
      'Allow',
      'Allow for This Window',
      'Skip'
    );
    const aborted = new Promise<undefined>((resolve) => (signal.aborted ? resolve(undefined) : signal.addEventListener('abort', () => resolve(undefined), { once: true })));
    const pick = await Promise.race([ask, aborted]);
    window = pick === 'Allow for This Window';
    const ok = pick === 'Allow' || window;
    record(ok ? 'approved' : 'denied');
    return ok;
  };
}

/** The process-wide self-healing service of this window with every host dependency from design §1. */
export function createHealingHost(d: HealingHostDeps): HealingHost {
  const store = new RecoveryStore(path.join(d.storageDir, 'recovery'), {
    owner: { kind: 'vscode' },
    log: d.log,
    maxAttempts: (s: RecoveryState) => {
      const last = s.attempts[s.attempts.length - 1];
      const cfg = getConfig().healing;
      return last ? attemptCap(last.category, cfg.maxRepairAttempts) : cfg.maxRepairAttempts;
    },
  });
  const memory = memoryResolver({ scope: () => getConfig().healing.memory, storageDir: d.storageDir, trusted: () => vscode.workspace.isTrusted, log: (m) => d.log.warn(`Self-healing memory: ${m}`) });
  const service = new HealingService({
    store,
    memory,
    config: healingConfig,
    telemetry: d.telemetry,
    log: d.log,
    bus: recoveryBus,
    semaphore: checkSemaphore,
    discover: discoverChecks,
    isTrusted: () => vscode.workspace.isTrusted,
    repoGraph: async (root) => repoGraphView(await buildRepoGraph(root)),
    securityScan: changedFilesScan(),
    dependencyScan: osvDependencyScan(networkApproval(d.log), { log: (m) => d.log.info(m) }),
    mcpRestart: (server) => d.mcp.restart(server),
    probe: providerProbe((id) => d.providers.get(id)),
    restoreFile: restoreWorkspaceFile,
    settle: (sid) => d.tracker.settle(sid),
    foreignWriter: (fsPath) => lastWriter(d.tracker.all(), new Set(d.liveSessions().map((s) => ChangeTracker.rootSession(s))), fsPath, (a, b) => samePath(a, b)),
    audit: (event) => audit(getManagedPolicy(d.log), event, d.root(), d.log),
    owner: 'vscode',
  });
  return { service, store, memory };
}

/** Creates `.localpilot/checks.json` from the template when it is missing; returns its path and whether it was created. */
export async function ensureChecksFile(root: string): Promise<{ file: string; created: boolean }> {
  const file = path.join(root, CHECKS_FILE);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, CHECKS_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return { file, created: false };
    }
    throw e;
  }
  clearChecksCache(root);
  return { file, created: true };
}

/**
 * Snapshot documents for "Open diff": `localpilot-recovery:/<file>?<sid>&<attempt>` is the file before that attempt
 * (empty when it did not exist yet).
 */
export function registerRecoverySnapshots(store: RecoveryStore): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(RECOVERY_SNAPSHOT_SCHEME, {
    provideTextDocumentContent: async (uri) => {
      const q = new URLSearchParams(uri.query);
      const sid = q.get('sid') ?? '';
      const attempt = Number(q.get('attempt'));
      const snap = sid && Number.isInteger(attempt) && attempt > 0 ? await readAttemptSnapshot(store.attemptDir(sid, attempt), uri.path.replace(/^\//, '')) : undefined;
      if (snap === undefined) {
        return '(the snapshot of this attempt is no longer available)';
      }
      return snap === null ? '' : snap.binary ? '(binary file)' : snap.text;
    },
  });
}

export function recoverySnapshotUri(sid: string, attempt: number, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: RECOVERY_SNAPSHOT_SCHEME, path: `/${file.split(path.sep).join('/').replace(/^\/+/, '')}`, query: new URLSearchParams({ sid, attempt: String(attempt) }).toString() });
}
