import * as fs from 'fs';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { getSystemProfile } from '../providers/system';
import {
  checkPrereqs,
  ColiLauncher,
  coliCommand,
  colibriReady,
  COLIBRI_GIT_URL,
  dashboardUrl,
  DEFAULT_CHECKOUT,
  DEFAULT_MODELS_DIR,
  expandHome,
  findColibri,
  freeDiskGb,
  freePort,
  installCommand,
  launcherIn,
  modelChoices,
  probePort,
  runColi,
  setupArgs,
  statusProgress,
} from '../providers/colibriSetup';
import { terminalShell } from '../providers/gatewaySetup';

const TERMINAL = 'LocalPilot · colibri';

export interface ColibriHost {
  log: vscode.LogOutputChannel;
  /** Re-detect providers, refresh models and the status bar once a server is up. */
  onReady(port: number): Promise<string[]>;
}

/**
 * `LocalPilot: Start colibri`, end to end: finds colibri (configured folder, PATH, ~/colibri) or installs it, lets the
 * user pick a model that fits when nothing is set up yet, avoids a port another server holds, then runs colibri's own
 * `coli setup` in a terminal (which installs on first use and afterwards just starts the server) and waits until the
 * OpenAI endpoint answers. A colibri that is already running is reused instead of started twice.
 */
export class ColibriLauncher implements vscode.Disposable {
  private terminal?: vscode.Terminal;
  private waiting?: Promise<boolean>;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly host: ColibriHost) {
    this.subs.push(vscode.window.onDidCloseTerminal((t) => t === this.terminal && (this.terminal = undefined)));
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
  }

  private get settings() {
    return vscode.workspace.getConfiguration('localpilot');
  }

  async start(opts: { reconfigure?: boolean } = {}): Promise<void> {
    const cfg = getConfig().colibri;
    let port = cfg.port;

    // 1. Already serving: register it and offer what makes sense next, instead of a second server on the same port.
    const state = await probePort(port);
    if (state === 'colibri' && !opts.reconfigure) {
      const models = await this.host.onReady(port);
      // Not awaited, so the command finishes; the buttons act whenever they are clicked.
      void vscode.window.showInformationMessage(`colibri is already running on port ${port}${models.length ? ` (${models.join(', ')})` : ''}. LocalPilot uses it where it fits.`, 'Switch model…', 'Stop colibri', 'Open dashboard').then((pick) => {
        if (pick === 'Switch model…') {
          void this.start({ reconfigure: true });
        } else if (pick === 'Stop colibri') {
          void this.stop();
        } else if (pick === 'Open dashboard') {
          void vscode.env.openExternal(vscode.Uri.parse(dashboardUrl(port)));
        }
      });
      return;
    }
    // A start we launched is still loading: show its terminal and keep waiting rather than starting again.
    if (this.waiting && this.terminal) {
      this.terminal.show(true);
      void vscode.window.showInformationMessage('colibri is still starting in its terminal.');
      return;
    }
    // 2. Another server (often vLLM, which also defaults to 8000) holds the port: move colibri to a free one.
    if (state === 'other') {
      const next = await freePort(port + 1);
      const pick = next && (await vscode.window.showWarningMessage(`Port ${port} is used by another server (vLLM uses 8000 too). Run colibri on port ${next} instead?`, { modal: true }, `Use port ${next}`));
      if (!pick || !next) {
        return;
      }
      port = next;
      await this.settings.update('colibri.port', port, vscode.ConfigurationTarget.Global);
    }

    // 3. Find colibri, or install it.
    let launcher = findColibri({ configured: cfg.path });
    if (!launcher && cfg.path) {
      const fix = await vscode.window.showWarningMessage(`${cfg.path} is not a colibri folder (no c/coli launcher).`, 'Choose another folder', 'Install colibri', 'Forget this folder');
      if (fix === 'Forget this folder') {
        await this.settings.update('colibri.path', undefined, vscode.ConfigurationTarget.Global);
        return this.start(opts);
      }
      if (fix === 'Choose another folder') {
        launcher = await this.chooseFolder();
      } else if (fix === 'Install colibri') {
        return this.install(port);
      }
      if (!launcher) {
        return;
      }
    }
    if (!launcher) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(cloud-download) Install colibri', description: 'recommended', detail: `Clones ${COLIBRI_GIT_URL} into ${DEFAULT_CHECKOUT()}, builds or downloads the engine and downloads a model that fits this machine.`, id: 'install' },
          { label: '$(folder-opened) I have colibri: choose its folder…', detail: 'A git checkout (with c/coli) or an unpacked release (with coli).', id: 'folder' },
          { label: '$(link-external) Open colibri on GitHub', id: 'github' },
        ],
        { title: 'LocalPilot: start colibri', placeHolder: 'colibri is not installed: it runs huge mixture-of-experts models by streaming experts from disk' }
      );
      if (!pick) {
        return;
      }
      if (pick.id === 'github') {
        return void vscode.env.openExternal(vscode.Uri.parse(COLIBRI_GIT_URL));
      }
      if (pick.id === 'install') {
        return this.install(port);
      }
      launcher = await this.chooseFolder();
      if (!launcher) {
        return;
      }
    }

    // 4. Which model: the configured one, a new pick when switching, or colibri's own recommendation.
    let model = cfg.model;
    if (opts.reconfigure) {
      model = await this.pickModel(cfg.modelsDir);
      if (!model) {
        return;
      }
      await this.settings.update('colibri.model', model === 'recommended' ? undefined : model, vscode.ConfigurationTarget.Global);
      if (state === 'colibri') {
        await this.stop(true);
      }
    }
    const args = setupArgs({ port, model: model === 'recommended' ? undefined : model, modelsDir: cfg.modelsDir, backend: cfg.backend, reconfigure: opts.reconfigure });
    const found = launcher;
    await this.run(coliCommand(launcher, args), launcher.folder, port, opts.reconfigure ? 'install' : 'start', () => found);
  }

  /** Clone colibri and run its setup, after checking prerequisites, the folder, the model and free disk space. */
  private async install(port: number): Promise<void> {
    const pre = checkPrereqs();
    if (pre.missing.length) {
      const pick = await vscode.window.showErrorMessage(`Installing colibri needs ${pre.missing.join(' and ')}. Install ${pre.missing.length > 1 ? 'them' : 'it'}, then run Start colibri again.${pre.hint ? `\n\n${pre.hint}` : ''}`, { modal: true }, ...(pre.hint ? ['Copy install command'] : []), 'Open colibri on GitHub');
      if (pick === 'Copy install command' && pre.hint) {
        await vscode.env.clipboard.writeText(pre.hint);
      } else if (pick === 'Open colibri on GitHub') {
        void vscode.env.openExternal(vscode.Uri.parse(COLIBRI_GIT_URL));
      }
      return;
    }
    let folder = DEFAULT_CHECKOUT();
    const where = await vscode.window.showQuickPick(
      [
        { label: `$(home) ${folder}`, description: 'default', id: 'default' },
        { label: '$(folder-opened) Choose another folder…', id: 'choose' },
      ],
      { title: 'Install colibri: where should the checkout go?' }
    );
    if (!where) {
      return;
    }
    if (where.id === 'choose') {
      const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'Folder to install colibri into (a "colibri" folder is created inside)' });
      if (!uri?.[0]) {
        return;
      }
      folder = vscode.Uri.joinPath(uri[0], 'colibri').fsPath;
    }
    // A folder that is already a checkout (an earlier install) is reused rather than cloned over.
    const existing = launcherIn(folder);
    if (!existing && fs.existsSync(folder) && fs.readdirSync(folder).length) {
      void vscode.window.showErrorMessage(`${folder} exists and is not a colibri checkout. Choose another folder.`);
      return;
    }
    if (/^\/mnt\/[a-z]\//i.test(folder) && process.platform === 'linux') {
      const go = await vscode.window.showWarningMessage('On WSL, models on /mnt/c load many times slower than on the Linux disk.', 'Install anyway');
      if (!go) {
        return;
      }
    }
    const cfg = getConfig().colibri;
    const model = cfg.model || (await this.pickModel(cfg.modelsDir));
    if (!model) {
      return;
    }
    await this.settings.update('colibri.path', folder, vscode.ConfigurationTarget.Global);
    if (model !== 'recommended') {
      await this.settings.update('colibri.model', model, vscode.ConfigurationTarget.Global);
    }
    const args = setupArgs({ port, model: model === 'recommended' ? undefined : model, modelsDir: cfg.modelsDir, backend: cfg.backend });
    const command = existing ? coliCommand(existing, args) : installCommand(folder, args);
    this.host.log.info(`colibri: installing into ${folder}${model !== 'recommended' ? ` with ${model}` : ''}`);
    // The launcher exists only once the clone finished: look it up on each status check.
    await this.run(command, existing ? folder : undefined, port, 'install', () => launcherIn(folder));
  }

  /** Catalog models ranked for this machine, plus colibri's own recommendation. Returns a catalog id, a folder or 'recommended'. */
  private async pickModel(modelsDir?: string): Promise<string | undefined> {
    const profile = await getSystemProfile().catch(() => undefined);
    const dir = expandHome(modelsDir || DEFAULT_MODELS_DIR());
    const free = freeDiskGb(dir);
    const ram = profile?.ramGb ?? 16;
    const choices = modelChoices(ram, free);
    const items: (vscode.QuickPickItem & { id: string })[] = [
      { label: '$(sparkle) Let colibri recommend', description: 'picks the best model for this machine', id: 'recommended' },
      { label: 'Models that fit', kind: vscode.QuickPickItemKind.Separator, id: '' },
      ...choices.filter((c) => c.fit !== 'too-big').map((c) => ({ label: `${c.fit === 'ram' ? '$(zap)' : '$(database)'} ${c.spec.name}`, description: `${c.spec.paramsB >= 1000 ? `${(c.spec.paramsB / 1000).toFixed(1)}T` : `${c.spec.paramsB}B`}${c.spec.coder ? ' · coder' : ''}${c.spec.vision ? ' · vision' : ''}`, detail: `${c.enoughDisk ? '' : '$(warning) '}${c.note}`, id: c.spec.name })),
      { label: 'Other', kind: vscode.QuickPickItemKind.Separator, id: '' },
      { label: '$(folder-opened) A model folder I already have…', id: 'folder' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `colibri model · ${Math.round(ram)} GB RAM${free !== undefined ? ` · ${Math.floor(free)} GB free in ${dir}` : ''}`, matchOnDescription: true, matchOnDetail: true });
    if (!pick) {
      return undefined;
    }
    if (pick.id === 'folder') {
      const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'colibri model folder (a converted snapshot)' });
      return uri?.[0]?.fsPath;
    }
    const chosen = choices.find((c) => c.spec.name === pick.id);
    if (chosen && !chosen.enoughDisk) {
      const go = await vscode.window.showWarningMessage(`${chosen.spec.name} is a ${chosen.spec.diskGb} GB download but only ${Math.floor(free ?? 0)} GB is free in ${dir}. Set localpilot.colibri.modelsDir to a bigger disk, or pick a smaller model.`, { modal: true }, 'Download anyway');
      if (!go) {
        return undefined;
      }
    }
    return pick.id;
  }

  private async chooseFolder(): Promise<ColiLauncher | undefined> {
    const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'colibri folder (a checkout with c/coli, or an unpacked release)' });
    if (!uri?.[0]) {
      return undefined;
    }
    const launcher = launcherIn(uri[0].fsPath);
    if (!launcher) {
      void vscode.window.showErrorMessage(`${uri[0].fsPath} has no colibri launcher (c/coli or coli). Choose the folder you cloned or unpacked colibri into.`);
      return undefined;
    }
    await this.settings.update('colibri.path', uri[0].fsPath, vscode.ConfigurationTarget.Global);
    return launcher;
  }

  /** Runs `command` in the colibri terminal and waits (with progress) until the server answers. */
  private async run(command: string, cwd: string | undefined, port: number, phase: 'install' | 'start', launcher: () => ColiLauncher | undefined): Promise<void> {
    const cfg = getConfig();
    const slots = Math.min(cfg.colibri.kvSlots, Math.max(1, cfg.parallel.maxConcurrency));
    this.terminal?.dispose();
    // setup and start take no --kv-slots; `coli serve` reads COLI_KV_SLOTS from its environment.
    this.terminal = vscode.window.createTerminal({ name: TERMINAL, cwd, env: slots > 1 ? { COLI_KV_SLOTS: String(slots) } : undefined, ...terminalShell() });
    this.terminal.show(true);
    this.terminal.sendText(command);
    this.host.log.info(`colibri: ${command}`);
    const term = this.terminal;
    this.waiting = this.wait(port, phase, term, launcher);
    const up = await this.waiting.finally(() => (this.waiting = undefined));
    if (!up) {
      return;
    }
    const models = await this.host.onReady(port);
    // Not awaited: the command is done once the server answers, whether or not the notification is dismissed.
    void vscode.window.showInformationMessage(`colibri is serving ${models.join(', ') || 'a model'} on port ${port}. LocalPilot routes to it where it fits.`, 'Open dashboard').then((pick) => pick && vscode.env.openExternal(vscode.Uri.parse(dashboardUrl(port))));
  }

  private wait(port: number, phase: 'install' | 'start', term: vscode.Terminal, launcher: () => ColiLauncher | undefined): Promise<boolean> {
    // A first install downloads the engine and up to hundreds of GB of model: allow hours. A start loads the resident part.
    const limitMs = phase === 'install' ? 12 * 3600_000 : 20 * 60_000;
    const title = phase === 'install' ? 'LocalPilot: setting up colibri (engine and model download)…' : 'LocalPilot: starting colibri (loading the resident part of the model)…';
    return Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
        const started = Date.now();
        let closed = false;
        const sub = vscode.window.onDidCloseTerminal((t) => t === term && (closed = true));
        let lastStatus = 0;
        let detail = '';
        try {
          while (!token.isCancellationRequested && !closed && Date.now() - started < limitMs) {
            if (await colibriReady(port)) {
              return true;
            }
            // Every 20 s, colibri's own status (install progress, state) when the launcher can report it.
            const l = launcher();
            if (l && Date.now() - lastStatus > 20_000) {
              lastStatus = Date.now();
              detail = statusProgress(await runColi(l, ['status', '--json'], 10_000)) ?? detail;
            }
            const s = Math.round((Date.now() - started) / 1000);
            const elapsed = s < 120 ? `${s} s` : `${Math.floor(s / 60)} min`;
            progress.report({ message: `${elapsed}${detail ? ` · ${detail}` : ''} — progress is in the colibri terminal` });
            await new Promise((r) => setTimeout(r, 3000));
          }
        } finally {
          sub.dispose();
        }
        if (closed) {
          void vscode.window.showWarningMessage('The colibri terminal closed before the server answered. Run Start colibri again; an interrupted download resumes where it stopped.', 'Start colibri').then((p) => p && this.start());
        } else if (token.isCancellationRequested) {
          void vscode.window.showInformationMessage('Stopped waiting. colibri keeps going in its terminal and LocalPilot picks it up when it answers.');
        } else {
          void vscode.window.showWarningMessage(`colibri did not answer on port ${port} in time. Check its terminal${launcher() ? ' or run `coli logs -n 50`' : ''}.`);
        }
        return false;
      })
    );
  }

  /** `LocalPilot: Stop colibri`: `coli stop`, then the terminal this extension started. */
  async stop(quiet = false): Promise<void> {
    const cfg = getConfig().colibri;
    const launcher = findColibri({ configured: cfg.path });
    if (launcher) {
      await runColi(launcher, ['stop'], 30_000).catch(() => undefined);
    }
    if (this.terminal) {
      this.terminal.sendText('\u0003', false);
      this.terminal.dispose();
      this.terminal = undefined;
    }
    for (let i = 0; i < 10 && (await probePort(cfg.port)) === 'colibri'; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const still = (await probePort(cfg.port)) === 'colibri';
    await this.host.onReady(cfg.port);
    if (!quiet) {
      void vscode.window[still ? 'showWarningMessage' : 'showInformationMessage'](still ? `colibri is still answering on port ${cfg.port}. It was not started by LocalPilot; stop it where it runs (coli stop).` : 'colibri stopped.');
    }
  }
}
