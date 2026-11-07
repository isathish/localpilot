// Hybrid logical clock (design §5.4): `<physical ms, 12 hex>-<counter, 4 hex>-<deviceId>`. Lexical order is a total
// order consistent with causality: a device never issues a stamp lower than one it has issued or observed. A remote
// stamp more than 10 minutes in the future does not drag the local clock with it (clock skew is reported instead).
// Pure: no vscode.

/** How far ahead of the local wall clock a remote stamp may move this clock. */
export const MAX_FUTURE_MS = 10 * 60 * 1000;
const MAX_COUNTER = 0xffff;

export interface HlcParts {
  pt: number;
  c: number;
  dev: string;
}

export function formatHlc(pt: number, c: number, dev: string): string {
  return `${Math.max(0, Math.floor(pt)).toString(16).padStart(12, '0')}-${c.toString(16).padStart(4, '0')}-${dev}`;
}

export function parseHlc(h: string): HlcParts | undefined {
  const m = /^([0-9a-f]{12})-([0-9a-f]{4})-(.+)$/.exec(h);
  return m ? { pt: parseInt(m[1], 16), c: parseInt(m[2], 16), dev: m[3] } : undefined;
}

export class Hlc {
  private pt = 0;
  private c = 0;

  constructor(readonly deviceId: string, private readonly now: () => number = Date.now) {}

  /** A new stamp, greater than every stamp this clock issued or observed. */
  tick(): string {
    const wall = Math.floor(this.now());
    if (wall > this.pt) {
      this.pt = wall;
      this.c = 0;
    } else if (this.c >= MAX_COUNTER) {
      // The counter is full: borrow the next millisecond.
      this.pt += 1;
      this.c = 0;
    } else {
      this.c += 1;
    }
    return formatHlc(this.pt, this.c, this.deviceId);
  }

  /**
   * Advances the clock past a stamp received from elsewhere. Returns `skewMs` when the stamp is more than
   * MAX_FUTURE_MS ahead of the local wall clock (the clock then moves to `now + MAX_FUTURE_MS` only).
   */
  observe(remote: string): { skewMs?: number } {
    const r = parseHlc(remote);
    if (!r) {
      return {};
    }
    const wall = Math.floor(this.now());
    let rpt = r.pt;
    let rc = r.c;
    let skewMs: number | undefined;
    if (rpt > wall + MAX_FUTURE_MS) {
      skewMs = rpt - wall;
      rpt = wall + MAX_FUTURE_MS;
      rc = 0;
    }
    if (rpt > this.pt) {
      this.pt = rpt;
      this.c = rc;
    } else if (rpt === this.pt) {
      this.c = Math.max(this.c, rc);
    }
    return skewMs === undefined ? {} : { skewMs };
  }

  /** The last stamp issued or observed (without ticking). */
  peek(): string {
    return formatHlc(this.pt, this.c, this.deviceId);
  }

  static compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Physical milliseconds of a stamp (0 when it does not parse). */
  static physical(h: string): number {
    return parseHlc(h)?.pt ?? 0;
  }

  static device(h: string): string {
    return parseHlc(h)?.dev ?? '';
  }
}
