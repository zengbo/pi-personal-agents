import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JwksCache } from "../../src/web/jwks.ts";
import { startWeb, type WebApp } from "../../src/web/server.ts";
import { signJwt } from "../controller/fixture.ts";
import { httpCall, openTestSocket, type TestSocket } from "../controller/http.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuer = "https://example.cloudflareaccess.com";
const ownerEmail = "user@example.com";
const servers: { close(): Promise<void> }[] = [];
const sockets: TestSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("web guards", () => {
  it("returns 401 for a wrong issuer, a future nbf, and a non-owner email", async () => {
    const web = await listen();
    const wrongIss = await httpCall(web.port, "GET", "/api/bots", { token: token({ iss: "https://evil.cloudflareaccess.com" }) });
    expect(wrongIss.status).toBe(401);
    const future = Math.floor(Date.now() / 1000) + 120;
    const early = await httpCall(web.port, "GET", "/api/bots", { token: token({ nbf: future }) });
    expect(early.status).toBe(401);
    const issuedLate = await httpCall(web.port, "GET", "/api/bots", { token: token({ iat: future }) });
    expect(issuedLate.status).toBe(401);
    const missingEmail = await httpCall(web.port, "GET", "/api/bots", { token: token({}, ["email"]) });
    expect(missingEmail.status).toBe(401);
    const other = await httpCall(web.port, "GET", "/api/bots", { token: token({ email: "other@example.com" }) });
    expect(other.status).toBe(401);
    const inside = await httpCall(web.port, "GET", "/api/bots", { token: token({ nbf: Math.floor(Date.now() / 1000) + 30 }) });
    expect(inside.status).toBe(200);
  });

  it("rejects a foreign or missing Origin on POST and the WebSocket upgrade", async () => {
    const decided: string[] = [];
    const web = await listen({
      decide(_id, _decision, sessionId) {
        decided.push(sessionId);
      },
    });
    const paths = ["/api/approvals/card-1", "/api/bots/chief/conversations/root/submit", "/login/code"];
    for (const pathname of paths) {
      const foreign = await httpCall(web.port, "POST", pathname, {
        token: token(),
        origin: "https://evil.example",
        body: JSON.stringify({ decision: "deny", content: "x", requestId: "r" }),
      });
      expect(foreign.status).toBe(403);
      const missing = await httpCall(web.port, "POST", pathname, {
        token: token(),
        cookie: true,
        origin: false,
        body: JSON.stringify({ decision: "deny", content: "x", requestId: "r" }),
      });
      expect(missing.status).toBe(403);
    }
    await expect(openTestSocket(web.port, token(), { origin: "https://evil.example" })).rejects.toThrow(/403/);
    await expect(openTestSocket(web.port, token(), { origin: false })).rejects.toThrow(/403/);
    const allowed = await httpCall(web.port, "POST", "/api/approvals/card-1", {
      token: token(),
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(allowed.status).toBe(200);
    expect(decided).toEqual([ownerEmail]);
    const socket = await openTestSocket(web.port, token());
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "decide", id: "card-2", decision: "allow_once" }));
    await socket.next();
    expect(decided).toEqual([ownerEmail, ownerEmail]);
  });

  it("returns 400 for malformed POST JSON and closes a bad WebSocket message", async () => {
    const web = await listen();
    const bad = await httpCall(web.port, "POST", "/api/approvals/card-1", { token: token(), body: "{" });
    expect(bad.status).toBe(400);
    expect(bad.body).toBe("bad json");
    const array = await httpCall(web.port, "POST", "/api/bots/chief/conversations/root/submit", {
      token: token(),
      body: "[]",
    });
    expect(array.status).toBe(400);
    const bots = await httpCall(web.port, "GET", "/api/bots", { token: token() });
    expect(bots.status).toBe(200);
    const socket = await openTestSocket(web.port, token());
    sockets.push(socket);
    socket.send("not-json");
    await expect(socket.next()).rejects.toThrow(/websocket closed/);
    const still = await httpCall(web.port, "GET", "/api/bots", { token: token() });
    expect(still.status).toBe(200);
  });

  it("refetches an unknown kid once, then stays on 401 inside the gap", async () => {
    let keys = [{ kid: "rotated", key: publicKey }];
    let loads = 0;
    const cache = new JwksCache(async () => {
      loads += 1;
      return keys;
    });
    const access = {
      audience: "test-aud",
      issuer,
      ownerEmail,
      origin: "https://chat.example.com",
      keys: [] as { kid: string; key: typeof publicKey }[],
      refreshKeys: async () => false,
    };
    access.refreshKeys = async () => {
      const result = await cache.refetchForUnknownKid();
      if (result.fetched) {
        access.keys = [...result.keys];
      }
      return result.fetched;
    };
    const web = await listen({ access });
    const rotated = await httpCall(web.port, "GET", "/api/bots", { token: token({}, [], "rotated") });
    expect(rotated.status).toBe(200);
    expect(loads).toBe(1);
    keys = [{ kid: "later", key: publicKey }];
    const blocked = await httpCall(web.port, "GET", "/api/bots", { token: token({}, [], "other") });
    expect(blocked.status).toBe(401);
    expect(loads).toBe(1);
  });

  it("returns 401 when an unknown-kid refetch throws and keeps serving", async () => {
    let loads = 0;
    const cache = new JwksCache(async () => {
      loads += 1;
      throw new Error("access jwks request failed");
    });
    const access = {
      audience: "test-aud",
      issuer,
      ownerEmail,
      origin: "https://chat.example.com",
      keys: [{ kid: "test", key: publicKey }],
      refreshKeys: async () => false,
    };
    access.refreshKeys = async () => {
      const result = await cache.refetchForUnknownKid();
      if (result.fetched) {
        access.keys = [...result.keys];
      }
      return result.fetched;
    };
    const web = await listen({ access });
    const denied = await httpCall(web.port, "GET", "/api/bots", { token: token({}, [], "missing") });
    expect(denied.status).toBe(401);
    await expect(openTestSocket(web.port, token({}, [], "missing"))).rejects.toThrow(/401/);
    const ok = await httpCall(web.port, "GET", "/api/bots", { token: token() });
    expect(ok.status).toBe(200);
    expect(loads).toBe(1);
  });

  it("requires the access team domain and the owner email at startup", async () => {
    const base = {
      CLOUDFLARE_ACCESS_AUD: "aud",
      CLOUDFLARE_ACCESS_JWKS_URL: "https://example.invalid/jwks",
      CLOUDFLARED_HOSTNAME: "chat.example.com",
      PPA_OWNER_EMAIL: "owner@example.com",
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    };
    const missingIssuer = await runController({ ...base, CLOUDFLARE_ACCESS_TEAM_DOMAIN: "" });
    expect(missingIssuer.code).not.toBe(0);
    expect(missingIssuer.stderr).toContain("missing CLOUDFLARE_ACCESS_TEAM_DOMAIN");
    const missingOwner = await runController({ ...base, PPA_OWNER_EMAIL: "" });
    expect(missingOwner.code).not.toBe(0);
    expect(missingOwner.stderr).toContain("missing PPA_OWNER_EMAIL");
  });
});

async function listen(partial?: Partial<WebApp> & { access?: WebApp["access"] }): Promise<{ port: number; close(): Promise<void> }> {
  const access = partial?.access ?? {
    audience: "test-aud",
    issuer,
    ownerEmail,
    origin: "https://chat.example.com",
    keys: [{ kid: "test", key: publicKey }],
  };
  const app: WebApp = {
    bots: ["chief"],
    access,
    loginHtml: () => "",
    submitLogin: () => undefined,
    listConversations: () => Promise.resolve([{ id: "root" }]),
    submit: () => Promise.resolve({ submissionId: "1" }),
    view: () => Promise.resolve([]),
    watch: () => Promise.resolve(() => undefined),
    approvals: () => [],
    decide: partial?.decide ?? (() => undefined),
    audit: () => [],
  };
  const server = await startWeb(app, { port: 0 });
  servers.push(server);
  return server;
}

function token(overrides: Record<string, unknown> = {}, omit: readonly string[] = [], kid = "test"): string {
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
  return signJwt(privateKey, payload, kid);
}

function runController(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "src/controller.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`controller hung: ${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}
