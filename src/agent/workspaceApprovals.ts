/**
 * "Always allow in this workspace" for a whole kind of action (terminal commands, file edits…). The approval settings
 * are User-only (`scope: application`: a cloned repository must not approve its own actions), so VS Code refuses to
 * write them to the workspace. The grant lives in the extension's per-workspace state instead, which no repository
 * file can set, and `getConfig().approvals` reads it on top of the User value. Destructive commands still ask
 * (`approvals.dangerousAlwaysAsk`) and an organization floor still applies: both are enforced after this value.
 */

export type GrantKind = 'terminal' | 'write' | 'delete' | 'network' | 'mcp';
export const GRANT_KINDS: readonly GrantKind[] = ['terminal', 'write', 'delete', 'network', 'mcp'];

/** The slice of `vscode.Memento` this needs (the CLI has no workspace state: nothing is granted there). */
export interface GrantStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY = 'localpilot.workspaceApprovals';
let store: GrantStore | undefined;
const listeners = new Set<() => void>();

export function setWorkspaceApprovalStore(s: GrantStore | undefined): void {
  store = s;
}

/** Kinds granted "always" in this workspace. */
export function workspaceGrants(): GrantKind[] {
  const v = store?.get<unknown>(KEY);
  return Array.isArray(v) ? GRANT_KINDS.filter((k) => v.includes(k)) : [];
}

export function workspaceGrant(kind: string): 'always' | undefined {
  return (workspaceGrants() as string[]).includes(kind) ? 'always' : undefined;
}

/** Grants or revokes a kind; false when there is no workspace store (CLI, tests without a context). */
export async function setWorkspaceGrant(kind: GrantKind, on: boolean): Promise<boolean> {
  if (!store || !GRANT_KINDS.includes(kind)) {
    return false;
  }
  const cur = workspaceGrants();
  const next = on ? [...new Set([...cur, kind])] : cur.filter((k) => k !== kind);
  await store.update(KEY, next.length ? next : undefined);
  for (const l of [...listeners]) {
    l();
  }
  return true;
}

export function onDidChangeWorkspaceGrants(l: () => void): { dispose(): void } {
  listeners.add(l);
  return { dispose: () => void listeners.delete(l) };
}
