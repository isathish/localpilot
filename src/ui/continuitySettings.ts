// Settings → Continuity & sync → Sync (design §16.3): what the form shows (status, whether the backend's secret is
// stored, devices, the last connection test) and the actions its buttons run (through SyncHost: VS Code input boxes for
// passphrases and secrets, never the webview).
import { getConfig } from '../config';
import { platformLabel } from '../continuity/sync/devices';
import { CATEGORY_LABELS, SYNC_CATEGORIES, SyncCategory } from '../continuity/sync/merge';
import type { SyncHost, SyncStatusView } from './syncHost';

export type SyncSettingsAction = 'setup' | 'test' | 'now' | 'pause' | 'resume' | 'setSecret' | 'pickFolder' | 'changePassphrase' | 'rotateKey' | 'turnOff' | 'startOver' | 'unlock' | 'renameDevice' | 'removeDevice' | 'openManager' | 'setCategory';

export interface SyncSettingsView {
  status: SyncStatusView;
  hasSecret: boolean;
  devices: { id: string; name: string; platform: string; lastSeen?: number; revokedAt?: number; thisDevice: boolean }[];
  categories: { id: SyncCategory; label: string; on: boolean; withheld: number }[];
  test?: { ok: boolean; message: string; at: number };
  thisDevice: string;
}

export class SyncSettings {
  private lastTest?: { ok: boolean; message: string; at: number };

  constructor(private readonly host: SyncHost, private readonly openManager: () => Promise<void>) {}

  async view(): Promise<SyncSettingsView> {
    const s = getConfig().sync;
    const e = this.host.engine;
    const devices = e?.configured ? await e.listDevices().catch(() => []) : [];
    const withheld = e ? e.state.withheld : {};
    const kind = s.backend === 's3' || s.backend === 'webdav' ? s.backend : undefined;
    return {
      status: this.host.view(),
      hasSecret: kind ? await this.host.hasSecret(kind) : true,
      devices: devices.map((d) => ({ id: d.id, name: d.name, platform: platformLabel(d.platform), lastSeen: d.lastSeen, revokedAt: d.revokedAt, thisDevice: d.thisDevice })),
      categories: SYNC_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id], on: s.categories[id], withheld: withheld[id]?.length ?? 0 })),
      ...(this.lastTest ? { test: this.lastTest } : {}),
      thisDevice: this.host.deviceName(),
    };
  }

  /** Runs one form action; returns a toast line when there is something to say. */
  async action(a: SyncSettingsAction, o: { deviceId?: string; category?: SyncCategory; on?: boolean } = {}): Promise<string | undefined> {
    switch (a) {
      case 'test': {
        const r = await this.host.test();
        this.lastTest = { ...r, at: Date.now() };
        return undefined;
      }
      case 'openManager':
        await this.openManager();
        return undefined;
      case 'setCategory':
        if (o.category && SYNC_CATEGORIES.includes(o.category)) {
          await this.host.setCategory(o.category, !!o.on);
        }
        return undefined;
      case 'removeDevice':
        if (o.deviceId) {
          await this.host.removeDevice(o.deviceId);
        }
        return undefined;
      case 'renameDevice':
        await this.host.renameDevice();
        return undefined;
      default:
        await this.host.handle({ type: 'syncAction', action: a });
        return undefined;
    }
  }
}
