// The device registry (design §14.3). Each device is a `device` entity in the log (name, platform, app versions,
// streams), written by that device; "Remove device" (revocation) may be written by any device (LWW `revokedAt`). The
// remote device files (`devices/<id>.json.lpe`) add what changes every cycle (last seen, upload heads) without logging
// it. Removing a device stops listing it as active; rotating the key afterwards keeps it from reading anything new.
// Pure Node.
import * as os from 'os';
import type { DeviceFields } from '../events';
import type { FileEventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';

export interface DeviceRow {
  id: string;
  name: string;
  platform?: string;
  appVersions?: Partial<Record<'vscode' | 'cli', string>>;
  lastSeen?: number;
  revokedAt?: number;
  streams: string[];
  thisDevice: boolean;
}

interface RawDevice {
  id: string;
  name: string | null;
  platform: string | null;
  app_versions: string | null;
  last_seen: number | null;
  revoked_at: number | null;
  streams: string | null;
  this_device: number;
}

const json = <T>(s: string | null, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};

/** A readable platform label: "macOS (arm64)". */
export function platformLabel(p?: string): string {
  if (!p) {
    return '';
  }
  const [os0, arch] = p.split('-');
  const name = os0 === 'darwin' ? 'macOS' : os0 === 'win32' ? 'Windows' : os0 === 'linux' ? 'Linux' : os0;
  return arch ? `${name} (${arch})` : name;
}

const DAY = 86_400_000;

export class DeviceRegistry {
  constructor(private readonly o: { log: FileEventLog; index: IndexClient; writer: 'vscode' | 'cli'; appVersion: string; now?: () => number }) {}

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  get thisDeviceId(): string {
    return this.o.log.device.deviceId;
  }

  async list(remote: Record<string, { name?: string; lastSeen?: number; heads?: Record<string, number>; revokedAt?: number }> = {}): Promise<DeviceRow[]> {
    const rows = await this.o.index.query<RawDevice>('syncDevices', {}).catch(() => [] as RawDevice[]);
    const byId = new Map<string, DeviceRow>();
    for (const r of rows) {
      byId.set(r.id, {
        id: r.id,
        name: r.name || r.id,
        platform: r.platform ?? undefined,
        appVersions: json(r.app_versions, {}),
        lastSeen: r.last_seen ?? undefined,
        revokedAt: r.revoked_at ?? undefined,
        streams: json<string[]>(r.streams, []),
        thisDevice: r.id === this.thisDeviceId,
      });
    }
    // Devices whose registration has not been pulled yet still show (from their remote file).
    for (const [id, d] of Object.entries(remote)) {
      const cur = byId.get(id);
      if (cur) {
        cur.lastSeen = Math.max(cur.lastSeen ?? 0, d.lastSeen ?? 0) || undefined;
        cur.revokedAt ??= d.revokedAt;
      } else {
        byId.set(id, { id, name: d.name || id, lastSeen: d.lastSeen, revokedAt: d.revokedAt, streams: Object.keys(d.heads ?? {}), thisDevice: id === this.thisDeviceId });
      }
    }
    if (!byId.has(this.thisDeviceId)) {
      const d = this.o.log.device;
      byId.set(d.deviceId, { id: d.deviceId, name: d.name, platform: d.platform, streams: [], thisDevice: true, lastSeen: this.now });
    }
    return [...byId.values()].sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }

  /**
   * Registers (or refreshes) this device: a `device` create when it is new or its name, app version or streams
   * changed, else nothing (last seen lives in the remote device file; the logged one moves at most daily).
   */
  async register(o: { name?: string; streams: string[] }): Promise<boolean> {
    const d = this.o.log.device;
    const cur = (await this.list()).find((x) => x.thisDevice && x.platform !== undefined);
    const name = (o.name || cur?.name || d.name || os.hostname()).trim().slice(0, 80);
    const appVersions = { ...(cur?.appVersions ?? {}), [this.o.writer]: this.o.appVersion };
    const streams = [...new Set([...(cur?.streams ?? []), ...o.streams])].sort();
    const same = cur && cur.name === name && JSON.stringify(cur.appVersions ?? {}) === JSON.stringify(appVersions) && JSON.stringify([...cur.streams].sort()) === JSON.stringify(streams) && this.now - (cur.lastSeen ?? 0) < DAY;
    if (same) {
      return false;
    }
    const fields: DeviceFields = { name, platform: d.platform, appVersions, lastSeen: this.now, streams };
    this.o.log.append('device', d.deviceId, cur ? 'patch' : 'create', fields, { durable: true });
    return true;
  }

  /** Renames this device (other devices see it after their next sync). */
  rename(name: string): void {
    const n = name.trim().slice(0, 80);
    if (!n) {
      throw new Error('Give the device a name');
    }
    this.o.log.append('device', this.thisDeviceId, 'patch', { name: n }, { durable: true });
  }

  /** "Remove device": it is no longer listed as active (its data stays). Rotate the key so it cannot read new data. */
  revoke(deviceId: string): void {
    if (deviceId === this.thisDeviceId) {
      throw new Error('To stop syncing this device, turn sync off instead');
    }
    this.o.log.append('device', deviceId, 'patch', { revokedAt: this.now }, { durable: true, base: this.o.log.peekHlc() });
  }

  /** Lists this device again after a removal. */
  reinstate(deviceId: string): void {
    this.o.log.append('device', deviceId, 'patch', { revokedAt: null }, { durable: true, base: this.o.log.peekHlc() });
  }
}
