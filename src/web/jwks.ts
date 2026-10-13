import type { AccessKey } from "./access.ts";

export const JWKS_REFRESH_MS = 10 * 60 * 1000;
export const JWKS_UNKNOWN_KID_MIN_MS = 30 * 1000;

export interface JwksCacheOptions {
  readonly intervalMs?: number;
  readonly minRefetchMs?: number;
  readonly now?: () => number;
  readonly schedule?: (ms: number, fn: () => void) => () => void;
}

/**
 * Loads Access signing keys. A timer refreshes them, and an unknown `kid`
 * refetches immediately unless one already ran inside the minimum gap.
 */
export class JwksCache {
  private keys: AccessKey[] = [];
  private lastFetch = 0;
  private readonly load: () => Promise<readonly AccessKey[]>;
  private readonly intervalMs: number;
  private readonly minRefetchMs: number;
  private readonly now: () => number;
  private readonly schedule: (ms: number, fn: () => void) => () => void;

  constructor(load: () => Promise<readonly AccessKey[]>, options: JwksCacheOptions = {}) {
    this.load = load;
    this.intervalMs = options.intervalMs ?? JWKS_REFRESH_MS;
    this.minRefetchMs = options.minRefetchMs ?? JWKS_UNKNOWN_KID_MIN_MS;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((ms, fn) => {
        const timer = setInterval(fn, ms);
        timer.unref();
        return () => {
          clearInterval(timer);
        };
      });
  }

  current(): readonly AccessKey[] {
    return this.keys;
  }

  start(): () => void {
    return this.schedule(this.intervalMs, () => {
      void this.refresh(true);
    });
  }

  async refresh(force: boolean): Promise<{ fetched: boolean; keys: readonly AccessKey[] }> {
    const now = this.now();
    if (!force && now - this.lastFetch < this.minRefetchMs) {
      return { fetched: false, keys: this.keys };
    }
    this.lastFetch = now;
    const keys = await this.load();
    this.keys = [...keys];
    return { fetched: true, keys: this.keys };
  }

  refetchForUnknownKid(): Promise<{ fetched: boolean; keys: readonly AccessKey[] }> {
    return this.refresh(false);
  }
}
