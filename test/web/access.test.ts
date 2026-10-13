import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCESS_CLOCK_SKEW_MS, AccessError, originAllowed, verifyAccessJwt, type AccessKey } from "../../src/web/access.ts";
import { signJwt } from "../controller/fixture.ts";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys: AccessKey[] = [{ kid: "test", key: publicKey }];
const issuer = "https://example.cloudflareaccess.com";
const ownerEmail = "user@example.com";

describe("access jwt", () => {
  it("rejects a wrong issuer and a not-before time past the skew", () => {
    expectReason(
      () => verifyAccessJwt(signJwt(privateKey, claims({ iss: "https://evil.cloudflareaccess.com" })), check()),
      "iss",
    );
    const now = 1_700_000_000_000;
    const issued = Math.floor(now / 1000);
    const ahead = Math.floor((now + ACCESS_CLOCK_SKEW_MS) / 1000) + 1;
    expectReason(() => verifyAccessJwt(signJwt(privateKey, claims({ nbf: ahead, iat: issued, exp: issued + 600 })), check(now)), "nbf");
    expectReason(() => verifyAccessJwt(signJwt(privateKey, claims({ nbf: issued, iat: ahead, exp: issued + 600 })), check(now)), "iat");
  });

  it("accepts nbf and iat inside the skew and still rejects an unextended expiry", () => {
    const now = 1_700_000_000_000;
    const edge = Math.floor((now + ACCESS_CLOCK_SKEW_MS) / 1000);
    expect(verifyAccessJwt(signJwt(privateKey, claims({ nbf: edge, iat: edge, exp: edge + 1 })), check(now)).email).toBe(ownerEmail);
    const expired = Math.floor(now / 1000);
    expectReason(
      () => verifyAccessJwt(signJwt(privateKey, claims({ nbf: expired, iat: expired, exp: expired })), check(now)),
      "exp",
    );
  });

  it("rejects a missing or different owner email", () => {
    expectReason(() => verifyAccessJwt(signJwt(privateKey, claims({}, ["email"])), check()), "email");
    expectReason(() => verifyAccessJwt(signJwt(privateKey, claims({ email: "" })), check()), "email");
    expectReason(() => verifyAccessJwt(signJwt(privateKey, claims({ email: "other@example.com" })), check()), "email");
  });

  it("accepts only the exact configured origin", () => {
    expect(originAllowed("https://chat.example.com", "https://chat.example.com")).toBe(true);
    expect(originAllowed(undefined, "https://chat.example.com")).toBe(false);
    expect(originAllowed("https://evil.example", "https://chat.example.com")).toBe(false);
    expect(originAllowed(["https://chat.example.com"], "https://chat.example.com")).toBe(false);
  });
});

function check(now?: number) {
  return {
    audience: "test-aud",
    issuer,
    ownerEmail,
    origin: "https://chat.example.com",
    keys,
    now: now === undefined ? undefined : () => now,
  };
}

function claims(overrides: Record<string, unknown> = {}, omit: readonly string[] = []): Record<string, unknown> {
  const issued = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    aud: "test-aud",
    iss: issuer,
    exp: issued + 600,
    iat: issued,
    nbf: issued,
    email: ownerEmail,
    ...overrides,
  };
  for (const key of omit) {
    delete payload[key];
  }
  return payload;
}

function expectReason(run: () => void, name: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AccessError);
    expect((error as AccessError).reason).toBe(name);
    return;
  }
  throw new Error(`expected ${name}`);
}
