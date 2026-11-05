import * as vscode from 'vscode';
import { getConfig } from '../config';
import { getManagedPolicy, ManagedPolicy } from '../agent/managedPolicy';

/** One toggle of the composer's auto-approve bar. `values` are the choices in order; `locked`: a policy floor forbids the rest. */
export interface AutoApproveItem {
  key: 'write' | 'delete' | 'terminal' | 'network' | 'mcp' | 'autoMode';
  label: string;
  value: string;
  values: string[];
  /** Values the organization's policy rules out, with the reason. */
  locked?: { values: string[]; reason: string };
  /** The value comes from the workspace (or folder) settings, so a change here is written there. */
  overriddenBy?: 'workspace';
}

export interface AutoApproveMsg {
  type: 'autoApprove';
  items: AutoApproveItem[];
  /** "Edit, Web": the categories that run without asking. */
  summary: string;
}

const SETTING: Record<AutoApproveItem['key'], string> = { write: 'approvals.write', delete: 'approvals.delete', terminal: 'approvals.terminal', network: 'approvals.network', mcp: 'approvals.mcp', autoMode: 'autoMode.enabled' };

const section = () => vscode.workspace.getConfiguration('localpilot', vscode.workspace.workspaceFolders?.[0]?.uri);
/** The workspace scope that holds a value for this toggle, if any; the folder scope wins over the workspace, as in VS Code. */
function workspaceScope(key: AutoApproveItem['key']): vscode.ConfigurationTarget | undefined {
  const i = section().inspect(SETTING[key]);
  if (i?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  return i?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : undefined;
}

const LABELS: Record<AutoApproveItem['key'], string> = { write: 'Edit files', delete: 'Delete', terminal: 'Commands', network: 'Web', mcp: 'MCP', autoMode: 'Auto Mode' };
const SHORT: Record<AutoApproveItem['key'], string> = { write: 'Edit', delete: 'Delete', terminal: 'Commands', network: 'Web', mcp: 'MCP', autoMode: 'Auto Mode' };

/** Short names of what runs without asking: categories set to always (Commands also under safe), plus Auto Mode. */
export function autoApproveSummary(items: Pick<AutoApproveItem, 'key' | 'value'>[]): string {
  const on = items.filter((i) => (i.key === 'autoMode' ? i.value === 'on' : i.value === 'always' || (i.key === 'terminal' && i.value === 'safe')));
  return on.map((i) => (i.key === 'terminal' && i.value === 'safe' ? 'Safe commands' : SHORT[i.key])).join(', ') || 'none';
}

function lockFor(p: ManagedPolicy, key: AutoApproveItem['key']): AutoApproveItem['locked'] {
  if (key === 'autoMode') {
    return p.disableBypassPermissions ? { values: ['on'], reason: "Your organization's policy turns auto mode off." } : undefined;
  }
  const floor = p.approvals[key];
  if (floor === 'never') {
    return { values: ['always', 'safe', 'ask'], reason: "Your organization's policy blocks this." };
  }
  if (floor === 'ask') {
    return { values: ['always', 'safe'], reason: "Your organization's policy requires approval." };
  }
  return undefined;
}

/** The bar's current state, read from the settings and the organization's policy. */
export function autoApproveState(log?: vscode.LogOutputChannel): AutoApproveMsg {
  const cfg = getConfig();
  const policy = getManagedPolicy(log);
  const modes = ['ask', 'always', 'never'];
  const items: AutoApproveItem[] = [
    { key: 'write', label: LABELS.write, value: cfg.approvals.write, values: modes },
    { key: 'delete', label: LABELS.delete, value: cfg.approvals.delete, values: modes },
    { key: 'terminal', label: LABELS.terminal, value: cfg.approvals.terminal, values: ['ask', 'safe', 'always', 'never'] },
    { key: 'network', label: LABELS.network, value: cfg.approvals.network, values: modes },
    { key: 'mcp', label: LABELS.mcp, value: cfg.approvals.mcp, values: modes },
    { key: 'autoMode', label: LABELS.autoMode, value: cfg.autoMode.enabled ? 'on' : 'off', values: ['off', 'on'] },
  ].map((i) => {
    const key = i.key as AutoApproveItem['key'];
    const locked = lockFor(policy, key);
    return { ...i, ...(locked ? { locked } : {}), ...(workspaceScope(key) !== undefined ? { overriddenBy: 'workspace' } : {}) } as AutoApproveItem;
  });
  return { type: 'autoApprove', items, summary: autoApproveSummary(items) };
}

/** Writes one toggle to the scope it comes from (workspace or folder when set there, else user settings); the agent reads it at its next approval, so it applies mid-run. */
export async function setAutoApprove(key: string, value: string, log?: vscode.LogOutputChannel): Promise<string | undefined> {
  const item = autoApproveState(log).items.find((i) => i.key === key);
  if (!item || !item.values.includes(value)) {
    return `Unknown approval setting ${key}=${value}`;
  }
  if (item.locked?.values.includes(value)) {
    return item.locked.reason;
  }
  // A user-scope write would be shadowed by the workspace value, so the click would appear to do nothing.
  const target = workspaceScope(item.key) ?? vscode.ConfigurationTarget.Global;
  await section().update(SETTING[item.key], key === 'autoMode' ? value === 'on' : value, target);
  return undefined;
}

/** Settings whose change redraws the bar. */
export const affectsAutoApprove = (e: vscode.ConfigurationChangeEvent) => e.affectsConfiguration('localpilot.approvals') || e.affectsConfiguration('localpilot.autoMode.enabled');
