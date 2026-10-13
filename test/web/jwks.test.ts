import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AccessKey } from "../../src/web/access.ts";
import { JwksCache } from "../../src/web/jwks.ts";

const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

describe("jwks cache", () => {
  it("refreshes on the timer and rate-limits an unknown kid", async () => {
    let now = 1_000_000;
    let generation = 0;
    const loads: number[] = [];
    const timers: { ms: number; fn: () => void }[] = [];
    const cache = new JwksCache(
      async () => {
        loads.push(now);
        generation += 1;
        const key: AccessKey = { kid: `k${generation}`, key: publicKey };
        return [key];
      },
      {
        intervalMs: 10,
        minRefetchMs: 30_000,
        now: () => now,
        schedule(ms, fn) {
          timers.push({ ms, fn });
          return () => undefined;
        },
      },
    );

    expect((await cache.refresh(true)).fetched).toBe(true);
    expect(loads).toEqual([now]);
    cache.start();
    expect(timers[0]?.ms).toBe(10);
    timers[0]?.fn();
    await flush();
    expect(loads).toHaveLength(2);

    now += 1_000;
    expect((await cache.refetchForUnknownKid()).fetched).toBe(false);
    expect(loads).toHaveLength(2);

    now += 30_000;
    const again = await cache.refetchForUnknownKid();
    expect(again.fetched).toBe(true);
    expect(again.keys[0]?.kid).toBe("k3");
    expect(loads).toHaveLength(3);

    now += 1;
    expect((await cache.refresh(true)).fetched).toBe(true);
    expect(loads).toHaveLength(4);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
