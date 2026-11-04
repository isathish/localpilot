import * as fs from 'fs';
import * as vscode from 'vscode';
import { ProviderConfig } from '../types';
import { editableProviders } from '../config';
import { expandHome, freePort, portInUse, which } from '../providers/colibriSetup';
import { checkGatewayPrereqs, gatewayDashboard, gatewayEnv, GatewayId, gatewayModels, GatewayModels, gatewayNeedsKey, GATEWAYS, installAndStartCommand, installCommand, needsProviders, nodeVersion, startCommand, terminalShell } from '../providers/gatewaySetup';
import { findPreset } from '../providers/presets';
import { resolveApiKey } from '../providers/cloud';

export interface GatewayHost {
  log: vscode.LogOutputChannel;
  /** Refresh providers and models once a gateway answers. */
  onReady(): Promise<void>;
}

/**
 * `LocalPilot: Start gateway`: makes OmniRoute or LiteLLM usable end to end. Adds the provider (marked cloud), reuses
 * a gateway that already runs, moves to a free port when another server holds it, installs a missing gateway after
 * checking its runtime, starts it bound to 127.0.0.1 in a terminal, waits until it answers, and says clearly when it
 * runs but has no upstream provider connected yet (OmniRoute then lists only its `auto` routes).
 */
export class GatewayLauncher implements vscode.Disposable {
  private readonly terminals = new Map<GatewayId, vscode.Terminal>();
  /** Gateways whose start is being waited on; an old terminal alone (pip install, a failed start) does not block a new start. */
  private readonly starting = new Set<GatewayId>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly host: GatewayHost) {
    this.subs.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [id, term] of this.terminals) {
          if (term === t) {
            this.terminals.delete(id);
          }
        }
      })
    );
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
  }

  private get settings() {
    return vscode.workspace.getConfiguration('localpilot');
  }

  /** The configured provider for a gateway (by preset id, or a provider on its default port), or undefined. */
  private provider(id: GatewayId): ProviderConfig | undefined {
    const list = this.settings.get<ProviderConfig[]>('providers', []) ?? [];
    return list.find((p) => p.id === id) ?? list.find((p) => new RegExp(`:${GATEWAYS[id].defaultPort}(/|$)`).test(p.baseUrl));
  }

  private portOf(p: ProviderConfig | undefined, id: GatewayId): number {
    const m = p ? /:(\d+)(\/|$)/.exec(p.baseUrl) : null;
    return m ? Number(m[1]) : GATEWAYS[id].defaultPort;
  }

  /** Adds the gateway's provider (from its preset) or updates its port; always marked cloud. */
  private async ensureProvider(id: GatewayId, port: number): Promise<ProviderConfig> {
    const { list, target } = editableProviders();
    // Located in this same list: each settings read returns fresh objects, so an object from another read is never found.
    const at = list.findIndex((p) => p.id === id);
    const i = at >= 0 ? at : list.findIndex((p) => new RegExp(`:${GATEWAYS[id].defaultPort}(/|$)`).test(p.baseUrl));
    const existing = i >= 0 ? list[i] : undefined;
    const baseUrl = `http://localhost:${port}/v1`;
    let cfg: ProviderConfig;
    if (existing) {
      cfg = { ...existing, baseUrl, cloud: existing.cloud ?? true };
      list[i] = cfg;
    } else {
      cfg = { ...(findPreset(id)?.cfg ?? { id, type: 'openai', displayName: GATEWAYS[id].label }), baseUrl, cloud: true };
      list.push(cfg);
    }
    if (JSON.stringify(existing) !== JSON.stringify(cfg)) {
      await this.settings.update('providers', list, target);
    }
    return cfg;
  }

  async start(which_?: GatewayId): Promise<void> {
    const id = which_ ?? (await this.pickGateway());
    if (!id) {
      return;
    }
    const spec = GATEWAYS[id];
    let port = this.portOf(this.provider(id), id);
    const key = resolveApiKey(this.provider(id) ?? { apiKey: undefined });

    // 1. Already running: register it and report what it can route to.
    const running = await gatewayModels(port, key);
    if (running) {
      await this.ensureProvider(id, port);
      await this.host.onReady();
      return this.report(id, port, running, true);
    }
    if (await gatewayNeedsKey(port, key)) {
      const cfg = await this.ensureProvider(id, port);
      const pick = await vscode.window.showWarningMessage(`${spec.label} is running on port ${port} but needs its master key.`, 'Set API key');
      if (pick) {
        await vscode.commands.executeCommand('localpilot.setProviderApiKey', cfg.id);
      }
      await this.host.onReady();
      return;
    }
    if (this.starting.has(id)) {
      this.terminals.get(id)?.show(true);
      void vscode.window.showInformationMessage(`${spec.label} is still starting in its terminal.`);
      return;
    }
    // 2. Something else holds the port: use the next free one.
    if (await portInUse(port)) {
      const next = await freePort(port + 1);
      const pick = next && (await vscode.window.showWarningMessage(`Port ${port} is used by another program. Run ${spec.label} on port ${next} instead?`, { modal: true }, `Use port ${next}`));
      if (!pick || !next) {
        return;
      }
      port = next;
    }
    await this.ensureProvider(id, port);

    // 3. Installed? Otherwise install (after checking the runtime it needs).
    const exe = which(spec.bin) ?? which(`${spec.bin}.cmd`);
    let config: string | undefined;
    if (id === 'litellm') {
      config = await this.litellmConfig();
      if (!config) {
        return;
      }
    }
    if (!exe) {
      const pre = checkGatewayPrereqs(id, which, id === 'omniroute' ? await nodeVersion() : undefined);
      if (!pre.ok) {
        const pick = await vscode.window.showErrorMessage(`${spec.label} can't be installed yet: ${pre.problem}.${pre.hint ? `\n\n${pre.hint}` : ''}`, { modal: true }, 'Open install guide');
        if (pick) {
          void vscode.env.openExternal(vscode.Uri.parse(id === 'omniroute' ? 'https://nodejs.org/en/download' : 'https://www.python.org/downloads/'));
        }
        return;
      }
      const install = installCommand(id);
      const go = await vscode.window.showInformationMessage(`${spec.label} is not installed. Install it with \`${install}\` and start it?`, { modal: true, detail: id === 'omniroute' ? 'It runs on this machine and forwards to the cloud providers you connect in its dashboard. LocalPilot binds it to 127.0.0.1.' : 'After installing, run Start gateway again (pip may put litellm in a folder your PATH does not have yet).' }, 'Install and start', 'Copy command');
      if (go === 'Copy command') {
        await vscode.env.clipboard.writeText(install);
        return;
      }
      if (go !== 'Install and start') {
        return;
      }
      if (id === 'litellm') {
        this.terminal(id).sendText(install);
        // The pip shell is not the gateway's: the next Start gateway opens a fresh terminal for the proxy.
        this.terminals.delete(id);
        return;
      }
      // npm puts `omniroute` on the terminal's PATH, so the start part uses the bare name.
      return this.run(id, port, installAndStartCommand(id, port), 'install');
    }
    return this.run(id, port, startCommand(id, { port, exe, config }), 'start');
  }

  private async pickGateway(): Promise<GatewayId | undefined> {
    const items = await Promise.all(
      (Object.keys(GATEWAYS) as GatewayId[]).map(async (id) => {
        const port = this.portOf(this.provider(id), id);
        const up = await gatewayModels(port);
        const installed = !!which(GATEWAYS[id].bin);
        return { label: GATEWAYS[id].label, description: up ? `running on ${port}` : installed ? 'installed' : 'not installed', detail: id === 'omniroute' ? 'One local endpoint for many cloud providers, with automatic fallback. Connect providers in its dashboard.' : 'Proxy for the models listed in your LiteLLM config file.', id };
      })
    );
    return (await vscode.window.showQuickPick(items, { title: 'LocalPilot: start a gateway', placeHolder: 'Gateways run on this machine and forward prompts to cloud models' }))?.id;
  }

  private async litellmConfig(): Promise<string | undefined> {
    const current = this.settings.get<string>('gateways.litellmConfig', '');
    if (current) {
      const file = expandHome(current);
      if (fs.existsSync(file)) {
        return file;
      }
      const choose = await vscode.window.showErrorMessage(`LiteLLM config file not found: ${file}`, { modal: true }, 'Choose config file…');
      if (!choose) {
        return undefined;
      }
    } else {
      const pick = await vscode.window.showInformationMessage('LiteLLM serves the models listed in a config file (model_list).', { modal: true }, 'Choose config file…', 'How to write one');
      if (pick === 'How to write one') {
        void vscode.env.openExternal(vscode.Uri.parse('https://docs.litellm.ai/docs/proxy/configs'));
        return undefined;
      }
      if (!pick) {
        return undefined;
      }
    }
    const uri = await vscode.window.showOpenDialog({ canSelectFiles: true, filters: { YAML: ['yaml', 'yml'] }, title: 'LiteLLM config file' });
    if (!uri?.[0]) {
      return undefined;
    }
    await this.settings.update('gateways.litellmConfig', uri[0].fsPath, vscode.ConfigurationTarget.Global);
    return uri[0].fsPath;
  }

  private terminal(id: GatewayId): vscode.Terminal {
    this.terminals.get(id)?.dispose();
    const t = vscode.window.createTerminal({ name: `LocalPilot · ${GATEWAYS[id].label}`, env: gatewayEnv(id), ...terminalShell() });
    this.terminals.set(id, t);
    t.show(true);
    return t;
  }

  private async run(id: GatewayId, port: number, command: string, phase: 'install' | 'start'): Promise<void> {
    const spec = GATEWAYS[id];
    const term = this.terminal(id);
    term.sendText(command);
    this.host.log.info(`gateway: ${command}`);
    this.starting.add(id);
    let models: GatewayModels | undefined;
    try {
      models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `LocalPilot: ${phase === 'install' ? `installing and starting ${spec.label}` : `starting ${spec.label}`}…`, cancellable: true }, async (progress, token) => {
        const started = Date.now();
        const limit = phase === 'install' ? 15 * 60_000 : 5 * 60_000;
        let closed = false;
        const sub = vscode.window.onDidCloseTerminal((t) => t === term && (closed = true));
        try {
          while (!token.isCancellationRequested && !closed && Date.now() - started < limit) {
            const m = await gatewayModels(port, resolveApiKey(this.provider(id) ?? { apiKey: undefined }));
            if (m) {
              return m;
            }
            progress.report({ message: `${Math.round((Date.now() - started) / 1000)} s — watch its terminal` });
            await new Promise((r) => setTimeout(r, 2000));
          }
        } finally {
          sub.dispose();
        }
        if (closed) {
          void vscode.window.showWarningMessage(`The ${spec.label} terminal closed before it answered. Its output shows why; run Start gateway again after fixing it.`);
        } else if (!token.isCancellationRequested) {
          void vscode.window.showWarningMessage(`${spec.label} did not answer on port ${port}. Check its terminal.`);
        }
        return undefined;
      });
    } finally {
      this.starting.delete(id);
    }
    if (!models) {
      return;
    }
    await this.host.onReady();
    return this.report(id, port, models, false);
  }

  /** What the gateway can route to; a gateway with no upstream provider is reported as not ready yet. */
  private report(id: GatewayId, port: number, m: GatewayModels, already: boolean): void {
    const spec = GATEWAYS[id];
    const open = (pick?: string) => {
      if (pick === 'Open dashboard') {
        void vscode.env.openExternal(vscode.Uri.parse(gatewayDashboard(id, port)));
      } else if (pick === 'Refresh models') {
        void vscode.commands.executeCommand('localpilot.refreshModels');
      }
    };
    if (needsProviders(m)) {
      const what = id === 'omniroute' ? `lists only its routes (${m.routes.slice(0, 3).join(', ') || 'none'}) and has no provider connected, so requests have nowhere to go. Connect a provider in its dashboard (Providers), then refresh models.` : 'has no models: add them to model_list in its config file.';
      void vscode.window.showWarningMessage(`${spec.label} is running on port ${port} but ${what}`, 'Open dashboard', 'Refresh models').then(open);
      return;
    }
    void vscode.window.showInformationMessage(`${spec.label} ${already ? 'is running' : 'started'} on port ${port}: ${m.models.length} model${m.models.length === 1 ? '' : 's'}${m.routes.length ? ` and ${m.routes.length} route${m.routes.length === 1 ? '' : 's'} (${m.routes.slice(0, 2).join(', ')})` : ''}. Pick them as ${id}/<model>; automatic picks keep preferring local models.`, 'Open dashboard').then(open);
  }

  /** `LocalPilot: Stop gateway`: stops a gateway this extension started (its terminal). */
  async stop(which_?: GatewayId): Promise<void> {
    const ids = which_ ? [which_] : ([...this.terminals.keys()] as GatewayId[]);
    if (!ids.length) {
      void vscode.window.showInformationMessage('No gateway was started from LocalPilot. Stop it where it runs.');
      return;
    }
    for (const id of ids) {
      const t = this.terminals.get(id);
      t?.sendText('\u0003', false);
      t?.dispose();
      this.terminals.delete(id);
    }
    await this.host.onReady();
    void vscode.window.showInformationMessage(`Stopped ${ids.map((i) => GATEWAYS[i].label).join(' and ')}.`);
  }
}
