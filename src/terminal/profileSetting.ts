import * as vscode from 'vscode';
import { getConfig } from '../config';
import { isSupportedShell, profileNames, profileOsKey, ResolvedProfile, resolveTerminalProfile, TerminalProfileEntry } from './profiles';

/** This platform's `terminal.integrated.profiles.<os>` (empty in the CLI, which does not read VS Code's terminal settings). */
function platformProfiles(): Record<string, TerminalProfileEntry | null> {
  return vscode.workspace.getConfiguration('terminal.integrated').get<Record<string, TerminalProfileEntry | null>>(`profiles.${profileOsKey()}`) ?? {};
}

/** The shell chosen in `localpilot.terminal.profile`, or undefined for VS Code's default shell (also when the profile is not a shell, such as tmux or wsl). */
export function agentTerminalProfile(): ResolvedProfile | undefined {
  const p = resolveTerminalProfile(getConfig().terminal.profile, platformProfiles());
  return p && isSupportedShell(p) ? p : undefined;
}

/** `shellPath`/`shellArgs`/`env` for createTerminal; empty for the default shell. */
export function agentTerminalShellOptions(): Pick<vscode.TerminalOptions, 'shellPath' | 'shellArgs' | 'env'> {
  const p = agentTerminalProfile();
  return p ? { shellPath: p.path, shellArgs: p.args, ...(p.env ? { env: p.env } : {}) } : {};
}

/** `localpilot.selectTerminalProfile`: pick the shell profile the agent's commands run in. */
export async function selectTerminalProfile(): Promise<void> {
  const current = getConfig().terminal.profile;
  const names = profileNames(platformProfiles());
  const items: (vscode.QuickPickItem & { value: string })[] = [
    { label: 'default', description: "VS Code's default terminal shell", value: 'default' },
    ...names.map((n) => {
      const r = resolveTerminalProfile(n, platformProfiles());
      const description = !r ? 'not found on this machine; the default shell is used' : isSupportedShell(r) ? [r.path, ...r.args].join(' ') : `${r.path}: not a shell the agent can run commands in; the default shell is used`;
      return { label: n, description, value: n };
    }),
  ].map((i) => (i.value === current ? { ...i, detail: '$(check) current' } : i));
  const pick = await vscode.window.showQuickPick(items, { title: 'LocalPilot: Agent Terminal Profile', placeHolder: 'Shell for the agent terminal, background commands and the hidden fallback process' });
  if (pick) {
    await vscode.workspace.getConfiguration('localpilot').update('terminal.profile', pick.value, vscode.ConfigurationTarget.Global);
  }
}
