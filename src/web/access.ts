import crypto from "node:crypto";

export class AccessError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super("unauthorized");
    this.name = "AccessError";
    this.reason = reason;
  }
}

export interface AccessKey {
  readonly kid: string;
  readonly key: crypto.KeyObject;
}

export interface AccessCheck {
  readonly audience: string;
  readonly issuer?: string;
  readonly keys: readonly AccessKey[];
  readonly now?: () => number;
}

export function verifyAccessJwt(token: string, check: AccessCheck): { email: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AccessError("malformed");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) {
    throw new AccessError("malformed");
  }
  const header = parseJson(encodedHeader);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new AccessError("alg");
  }
  const key = check.keys.find((item) => item.kid === header.kid)?.key;
  if (key === undefined) {
    throw new AccessError("kid");
  }
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  if (!verifier.verify(key, base64url(encodedSignature))) {
    throw new AccessError("sig");
  }
  const payload = parseJson(encodedPayload);
  const now = (check.now ?? Date.now)();
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) {
    throw new AccessError("exp");
  }
  const audience = payload.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(check.audience)) {
    throw new AccessError("aud");
  }
  if (check.issuer !== undefined && payload.iss !== check.issuer) {
    throw new AccessError("iss");
  }
  return { email: typeof payload.email === "string" ? payload.email : "" };
}

export function tokenFromRequest(header: string | undefined, cookie: string | undefined): string | undefined {
  if (header !== undefined && header.length > 0) {
    return header;
  }
  if (cookie === undefined) {
    return undefined;
  }
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "CF_Authorization") {
      return rest.join("=");
    }
  }
  return undefined;
}

function parseJson(encoded: string): Record<string, unknown> {
  try {
    const value = JSON.parse(base64url(encoded).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AccessError("malformed");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccessError) {
      throw error;
    }
    throw new AccessError("malformed");
  }
}

function base64url(encoded: string): Buffer {
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}
