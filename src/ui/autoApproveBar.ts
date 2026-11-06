import * as vscode from 'vscode';
import { getConfig } from '../config';
import { getManagedPolicy, ManagedPolicy } from '../agent/managedPolicy';
import { GrantKind, setWorkspaceGrant, workspaceGrant } from '../agent/workspaceApprovals';

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
  /** "Always allow in this workspace" is on for this kind (kept in the extension's workspace state, not in settings). */
  workspaceGrant?: boolean;
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
    const granted = key !== 'autoMode' && !!workspaceGrant(key);
    return { ...i, ...(locked ? { locked } : {}), ...((key === 'autoMode' && workspaceScope(key) !== undefined) || granted ? { overriddenBy: 'workspace' } : {}), ...(granted ? { workspaceGrant: true } : {}) } as AutoApproveItem;
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
  if (item.workspaceGrant) {
    // The workspace grant is what makes this "Always": choosing anything else ends it (Always keeps it).
    if (value === 'always') {
      return undefined;
    }
    await setWorkspaceGrant(item.key as GrantKind, false);
  }
  // Approval settings are User-only (`scope: application`): VS Code refuses a workspace write, so those always go to
  // User settings; Auto Mode follows the scope it is set in.
  const target = item.key === 'autoMode' ? workspaceScope(item.key) ?? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Global;
  await section().update(SETTING[item.key], key === 'autoMode' ? value === 'on' : value, target);
  return undefined;
}

/** Settings whose change redraws the bar. */
export const affectsAutoApprove = (e: vscode.ConfigurationChangeEvent) => e.affectsConfiguration('localpilot.approvals') || e.affectsConfiguration('localpilot.autoMode.enabled');

const MODE_NAMES: Record<string, string> = { ask: 'Ask', safe: 'Safe only', always: 'Always', never: 'Never' };
const KIND_NAMES: Record<string, string> = { write: 'File edits', delete: 'Deleting files', terminal: 'Terminal commands', network: 'Network', mcp: 'MCP tools' };

/**
 * Why an approval prompt was shown, for its footer ("Asked because Terminal commands = Ask"): the organization's
 * policy, a destructive command, or the approval setting that applies to this kind of action.
 */
export function approvalReason(kind: string, mandatoryReason?: 'dangerous' | 'policy', mode?: string): string {
  if (mandatoryReason === 'policy') {
    return "your organization's policy requires it";
  }
  if (mandatoryReason === 'dangerous') {
    return 'the command looks destructive';
  }
  const name = KIND_NAMES[kind] ?? kind;
  if (mode === 'safe') {
    return `${name} = Safe only, and this command is not on the safe list`;
  }
  if (mode === 'always') {
    return 'a permission rule or the agent asked for confirmation';
  }
  return `${name} = ${MODE_NAMES[mode ?? 'ask'] ?? 'Ask'}`;
}

/**
 * "Always allow in this workspace": grants the kind in this workspace's extension state (see workspaceApprovals.ts),
 * because the approval settings are User-only and VS Code refuses to write them to the workspace. Returns an error
 * text when the policy rules it out or there is no folder.
 */
export async function allowInWorkspace(kind: string, log?: vscode.LogOutputChannel): Promise<string | undefined> {
  const item = autoApproveState(log).items.find((i) => i.key === kind);
  if (!item || kind === 'autoMode') {
    return `Cannot always allow ${kind}`;
  }
  if (item.locked?.values.includes('always')) {
    return item.locked.reason;
  }
  if (!vscode.workspace.workspaceFolders?.length) {
    return 'Open a folder first: "always allow in this workspace" is saved in its settings';
  }
  return (await setWorkspaceGrant(item.key as GrantKind, true)) ? undefined : 'This window has no workspace state to save the choice in';
}
