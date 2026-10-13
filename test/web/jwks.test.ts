import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAccessJwt, type AccessKey } from "../../src/web/access.ts";
import { JwksCache } from "../../src/web/jwks.ts";
import { signJwt } from "../controller/fixture.ts";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

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

  it("keeps the previous keys when a timed refresh throws", async () => {
    let now = 0;
    let loads = 0;
    let fail = false;
    const timers: { fn: () => void }[] = [];
    const cache = new JwksCache(
      async () => {
        loads += 1;
        if (fail) {
          throw new Error("access jwks request failed token=super-secret-token");
        }
        const key: AccessKey = { kid: "k1", key: publicKey };
        return [key];
      },
      {
        minRefetchMs: 30_000,
        now: () => now,
        schedule(_ms, fn) {
          timers.push({ fn });
          return () => undefined;
        },
      },
    );
    expect((await cache.refresh(true)).fetched).toBe(true);
    cache.start();
    fail = true;
    now = 30_000;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const timer = timers[0];
      if (timer === undefined) {
        throw new Error("timer missing");
      }
      timer.fn();
      await settle();
      expect(rejections).toEqual([]);
      expect(loads).toBe(2);
      expect(cache.current()[0]?.kid).toBe("k1");
      expect(verifyAccessJwt(ownerToken(), { ...accessCheck(), keys: cache.current() }).email).toBe("user@example.com");
      expect(stderr.join("")).toContain("jwks refresh failed");
      expect(stderr.join("")).not.toContain("super-secret-token");
      now = 31_000;
      expect((await cache.refetchForUnknownKid()).fetched).toBe(false);
      expect(loads).toBe(2);
    } finally {
      process.stderr.write = original;
      process.off("unhandledRejection", onRejection);
    }
  });
});

function ownerToken(): string {
  const issued = Math.floor(Date.now() / 1000);
  return signJwt(
    privateKey,
    {
      aud: "test-aud",
      iss: "https://example.cloudflareaccess.com",
      exp: issued + 600,
      iat: issued,
      nbf: issued,
      email: "user@example.com",
    },
    "k1",
  );
}

function accessCheck() {
  return {
    audience: "test-aud",
    issuer: "https://example.cloudflareaccess.com",
    ownerEmail: "user@example.com",
    origin: "https://chat.example.com",
    keys: [] as AccessKey[],
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await flush();
  }
}
