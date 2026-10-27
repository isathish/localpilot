import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ProviderRegistry } from '../providers/registry';
import { getSystemProfile } from '../providers/system';
import { analyzeUsage, bonusFromUsage, rankModels, suggestModels, TUNE_LABELS, TUNE_ROLES, TuneRole, TuneSuggestion, UsageProfile } from '../providers/usageAdvisor';
import { Telemetry } from '../telemetry/telemetry';

const APPLIED_KEY = 'localpilot.autoTune.applied';
const DECLINED_KEY = 'localpilot.autoTune.declined';
const NOTIFIED_KEY = 'localpilot.autoTune.notified';
/** Days of telemetry the advisor learns from (recent runs weigh more, see analyzeUsage). */
const WINDOW_DAYS = 14;
/** A role is not re-tuned within this long of its last automatic change, so the setting cannot flap. */
const REAPPLY_MS = 12 * 3600_000;
/** Re-read telemetry at most this often (it is a scan of the JSONL files). */
const REFRESH_MS = 2 * 60_000;
/** Look for setting changes after this many finished runs (and at most once per CHECK_MS). */
const RUNS_PER_CHECK = 8;
const CHECK_MS = 20 * 60_000;

export type AutoTuneMode = 'auto' | 'suggest' | 'off';

interface AppliedEntry {
  value: string;
  previous?: string;
  at: number;
}

export interface TuneReport {
  mode: AutoTuneMode;
  analysed: { runs: number; calls: number; models: number; days: number };
  suggestions: TuneSuggestion[];
  rankings: { role: TuneRole; label: string; setting: string; current?: string; models: ReturnType<typeof rankModels> }[];
  history: { setting: string; value: string; previous?: string; at: number }[];
}

/**
 * Learns from local telemetry which installed models work best per role. Feeds the router a usage bonus (Auto picks
 * prefer models that finish their runs quickly and reliably) and, in `auto` mode, writes better picks to the role
 * settings — never over a model the user chose by hand unless that model is measurably failing, and always with Undo.
 */
export class ModelTuner implements vscode.Disposable {
  private usage?: UsageProfile;
  private loadedAt = 0;
  private loading?: Promise<UsageProfile>;
  private runsSinceCheck = 0;
  private lastCheck = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly telemetry: Telemetry,
    private readonly providers: ProviderRegistry,
    private readonly state: vscode.Memento,
    private readonly log: vscode.LogOutputChannel
  ) {
    const off = telemetry.onEvent((e) => {
      if (e.type === 'run') {
        this.runsSinceCheck++;
        this.schedule(5000);
      }
    });
    this.disposables.push(new vscode.Disposable(off));
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localpilot.models.autoTune') || e.affectsConfiguration('localpilot.routing.enabled')) {
          void this.refresh(true);
        }
      })
    );
  }

  get mode(): AutoTuneMode {
    return getConfig().autoTune;
  }

  /** Initial analysis shortly after start-up, once discovery has settled. */
  start(delayMs = 15_000): void {
    this.schedule(delayMs, true);
  }

  private schedule(ms: number, check = false): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick(check).catch((e) => this.log.warn(`auto-tune: ${e instanceof Error ? e.message : String(e)}`));
    }, ms);
  }

  private async tick(forceCheck: boolean): Promise<void> {
    await this.refresh();
    const due = forceCheck || (this.runsSinceCheck >= RUNS_PER_CHECK && Date.now() - this.lastCheck >= CHECK_MS);
    if (due && this.mode !== 'off') {
      this.runsSinceCheck = 0;
      this.lastCheck = Date.now();
      await this.autoApply();
    }
  }

  /** Re-reads telemetry (throttled) and hands the router the learned bonus. */
  async refresh(force = false): Promise<UsageProfile> {
    if (this.mode === 'off') {
      this.providers.usageBonus = undefined;
    }
    if (!force && this.usage && Date.now() - this.loadedAt < REFRESH_MS) {
      return this.usage;
    }
    if (this.loading) {
      return this.loading;
    }
    this.loading = (async () => {
      try {
        const events = await this.telemetry.events(WINDOW_DAYS);
        const usage = analyzeUsage(events);
        this.usage = usage;
        this.loadedAt = Date.now();
        this.providers.usageBonus = this.mode === 'off' ? undefined : bonusFromUsage(usage);
        return usage;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  async suggestions(): Promise<TuneSuggestion[]> {
    const usage = await this.refresh();
    const models = await this.providers.listModels().catch(() => []);
    if (models.length < 2) {
      return [];
    }
    const profile = await getSystemProfile().catch(() => undefined);
    const cfg = getConfig();
    return suggestModels(models, usage, { defaultModel: cfg.defaultModel, routing: cfg.routing, completionModel: cfg.inlineCompletion.model }, profile);
  }

  /** Everything the dashboard shows: per-role ranking with evidence, open suggestions and what was changed. */
  async report(): Promise<TuneReport> {
    const usage = await this.refresh();
    const models = await this.providers.listModels().catch(() => []);
    const profile = await getSystemProfile().catch(() => undefined);
    const cfg = getConfig();
    const settings = { defaultModel: cfg.defaultModel, routing: cfg.routing, completionModel: cfg.inlineCompletion.model };
    const current: Record<TuneRole, string | undefined> = { agent: cfg.defaultModel || undefined, reasoning: cfg.routing.reasoning, coding: cfg.routing.coding, fast: cfg.routing.fast, completion: cfg.inlineCompletion.model, vision: cfg.routing.vision };
    const applied = this.state.get<Record<string, AppliedEntry>>(APPLIED_KEY, {});
    return {
      mode: this.mode,
      analysed: { runs: usage.runs, calls: usage.calls, models: usage.models.size, days: WINDOW_DAYS },
      suggestions: models.length >= 2 ? suggestModels(models, usage, settings, profile) : [],
      rankings: TUNE_ROLES.map((role) => ({ role, label: TUNE_LABELS[role], setting: role, current: current[role], models: rankModels(models, usage, role, profile, 4) })).filter((r) => r.models.length),
      history: Object.entries(applied)
        .map(([setting, a]) => ({ setting, value: a.value, previous: a.previous, at: a.at }))
        .sort((a, b) => b.at - a.at),
    };
  }

  private settingValue(key: string): { global?: string; workspace?: string } {
    const info = vscode.workspace.getConfiguration('localpilot').inspect<string>(key);
    return { global: info?.globalValue || undefined, workspace: info?.workspaceValue || info?.workspaceFolderValue || undefined };
  }

  /**
   * In `auto` mode writes the suggestions that are safe to apply; in `suggest` mode offers them once each. Returns the
   * suggestions it applied.
   */
  async autoApply(): Promise<TuneSuggestion[]> {
    const mode = this.mode;
    if (mode === 'off' || !getConfig().routing.enabled) {
      return [];
    }
    const declined = new Set(this.state.get<string[]>(DECLINED_KEY, []));
    const applied = { ...this.state.get<Record<string, AppliedEntry>>(APPLIED_KEY, {}) };
    const toApply: TuneSuggestion[] = [];
    const toOffer: TuneSuggestion[] = [];
    for (const s of await this.suggestions()) {
      if (s.kind !== 'setting' || s.confidence === 'low' || declined.has(pairKey(s))) {
        continue;
      }
      const v = this.settingValue(s.setting);
      if (v.workspace) {
        continue; // a workspace pins its own model; a user-level write would not even take effect
      }
      const last = applied[s.setting];
      if (last && Date.now() - last.at < REAPPLY_MS) {
        continue;
      }
      const setByUs = !v.global || v.global === last?.value;
      if (mode === 'auto' && (setByUs || s.currentStruggling)) {
        toApply.push(s);
      } else {
        toOffer.push(s);
      }
    }
    for (const s of toApply) {
      await this.write(s, applied);
    }
    if (toApply.length) {
      await this.state.update(APPLIED_KEY, applied);
      this.notifyApplied(toApply);
    }
    await this.offer(toOffer);
    return toApply;
  }

  private async write(s: TuneSuggestion, applied: Record<string, AppliedEntry>): Promise<void> {
    const previous = this.settingValue(s.setting).global;
    await vscode.workspace.getConfiguration('localpilot').update(s.setting, s.suggested, vscode.ConfigurationTarget.Global);
    applied[s.setting] = { value: s.suggested, previous, at: Date.now() };
    this.log.info(`auto-tune: ${s.setting} ${previous ?? '(auto)'} → ${s.suggested} (${s.reason})`);
  }

  private notifyApplied(list: TuneSuggestion[]): void {
    const what = list.map((s) => `${TUNE_LABELS[s.role]} → ${short(s.suggested)}`).join(', ');
    const why = list.length === 1 ? ` ${list[0].reason}.` : '';
    void vscode.window.showInformationMessage(`LocalPilot tuned models from your usage: ${what}.${why}`, 'Undo', 'Details').then(async (pick) => {
      if (pick === 'Undo') {
        await this.undo(list);
      } else if (pick === 'Details') {
        void vscode.commands.executeCommand('localpilot.openSettings', 'dashboard');
      }
    });
  }

  /** Restores the previous values and remembers the declined picks so they are not applied again. */
  async undo(list: TuneSuggestion[]): Promise<void> {
    const applied = { ...this.state.get<Record<string, AppliedEntry>>(APPLIED_KEY, {}) };
    const declined = new Set(this.state.get<string[]>(DECLINED_KEY, []));
    for (const s of list) {
      const a = applied[s.setting];
      await vscode.workspace.getConfiguration('localpilot').update(s.setting, a?.previous || undefined, vscode.ConfigurationTarget.Global);
      delete applied[s.setting];
      declined.add(pairKey(s));
    }
    await this.state.update(APPLIED_KEY, applied);
    await this.state.update(DECLINED_KEY, [...declined].slice(-200));
  }

  private async offer(list: TuneSuggestion[]): Promise<void> {
    const notified = new Set(this.state.get<string[]>(NOTIFIED_KEY, []));
    const fresh = list.filter((s) => !notified.has(pairKey(s)));
    if (!fresh.length) {
      return;
    }
    fresh.forEach((s) => notified.add(pairKey(s)));
    await this.state.update(NOTIFIED_KEY, [...notified].slice(-200));
    const s = fresh[0];
    const more = fresh.length > 1 ? ` (+${fresh.length - 1} more suggestion${fresh.length === 2 ? '' : 's'})` : '';
    const pick = await vscode.window.showInformationMessage(`LocalPilot suggests ${short(s.suggested)} for ${TUNE_LABELS[s.role]} instead of ${short(s.current)} — ${s.reason}.${more}`, 'Apply', fresh.length > 1 ? 'Review all' : 'Details', "Don't suggest");
    if (pick === 'Apply') {
      await this.applyNow([s]);
    } else if (pick === 'Review all') {
      await this.pick(fresh);
    } else if (pick === 'Details') {
      void vscode.commands.executeCommand('localpilot.openSettings', 'dashboard');
    } else if (pick === "Don't suggest") {
      const declined = new Set(this.state.get<string[]>(DECLINED_KEY, []));
      declined.add(pairKey(s));
      await this.state.update(DECLINED_KEY, [...declined].slice(-200));
    }
  }

  /** Applies the given suggestions now (user-initiated: Apply buttons, the command, the dashboard). */
  async applyNow(list: TuneSuggestion[]): Promise<void> {
    const applied = { ...this.state.get<Record<string, AppliedEntry>>(APPLIED_KEY, {}) };
    for (const s of list) {
      await this.write(s, applied);
    }
    await this.state.update(APPLIED_KEY, applied);
    if (list.length) {
      vscode.window.setStatusBarMessage(`LocalPilot: ${list.map((s) => `${TUNE_LABELS[s.role]} → ${short(s.suggested)}`).join(', ')}`, 5000);
    }
  }

  /** Applies a suggestion the dashboard identified by role + model. */
  async applyFromDashboard(role: string, model: string): Promise<boolean> {
    const s = (await this.suggestions()).find((x) => x.role === role && x.suggested === model);
    if (!s) {
      return false;
    }
    await this.applyNow([{ ...s, kind: 'setting' }]);
    return true;
  }

  /** The `LocalPilot: Tune Models From Usage` command: analyse now and let the user pick what to apply. */
  async runCommand(): Promise<void> {
    await this.refresh(true);
    const list = await this.suggestions();
    if (!list.length) {
      const u = this.usage;
      const action = await vscode.window.showInformationMessage(
        u && u.runs + u.calls
          ? `LocalPilot analysed ${u.runs} run${u.runs === 1 ? '' : 's'} and ${u.calls} model call${u.calls === 1 ? '' : 's'} from the last ${WINDOW_DAYS} days: your current models are the best installed fit for every role.`
          : 'LocalPilot has no usage recorded yet. Use the chat for a while (telemetry stays on this machine) and it will learn which installed models work best for each role.',
        'Open Dashboard'
      );
      if (action) {
        void vscode.commands.executeCommand('localpilot.openSettings', 'dashboard');
      }
      return;
    }
    await this.pick(list);
  }

  private async pick(list: TuneSuggestion[]): Promise<void> {
    const items = list.map((s) => ({
      label: `${TUNE_LABELS[s.role]}: ${short(s.suggested)}`,
      description: `instead of ${short(s.current)} · ${s.confidence} confidence${s.kind === 'routing' ? ' · Auto routing already prefers it' : ''}`,
      detail: s.reason,
      picked: s.kind === 'setting' && s.confidence !== 'low',
      s,
    }));
    const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'LocalPilot: tune models from usage', placeHolder: 'Pick the changes to apply to your settings' });
    if (picked?.length) {
      await this.applyNow(picked.map((p) => p.s));
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.providers.usageBonus = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

const pairKey = (s: TuneSuggestion) => `${s.setting}=${s.suggested}`;
const short = (id?: string) => (id ? id.slice(id.indexOf('/') + 1) : 'automatic');
