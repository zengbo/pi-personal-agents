/**
 * Process entry for the systemd unit (`node --experimental-strip-types src/controller.ts`).
 * Importing this module does not open sockets; the guard below does.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { FileCredentialStore } from "./auth/file-credential-store.ts";
import { LoginSession, chatgptLoginDriver } from "./auth/login.ts";
import { startController } from "./controller/runtime.ts";
import { BOTS } from "./bots/extensions.ts";
import { AuditLog } from "./policy/audit.ts";
import { PolicyEngine } from "./policy/engine.ts";
import { PolicyStore } from "./policy/store.ts";
import { createPodmanDriver, UnixPodmanClient, type CommandRunner } from "./sandbox/podman.ts";
import { SandboxPool } from "./sandbox/pool.ts";
import type { AccessKey } from "./web/access.ts";
import crypto from "node:crypto";

async function main(): Promise<void> {
  const audience = requiredEnv("CLOUDFLARE_ACCESS_AUD");
  const jwksUrl = requiredEnv("CLOUDFLARE_ACCESS_JWKS_URL");
  const issuer = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  const dataDir = process.env.PPA_DATA_DIR ?? "/home/agentctl/data";
  const secretsDir = process.env.PPA_SECRETS_DIR ?? "/home/agentctl/secrets";
  const workspaceRoot = process.env.PPA_WORKSPACE_ROOT ?? "/home/sbx/workspaces";
  const port = Number(process.env.PPA_PORT ?? "8787");
  const keys = await loadJwks(jwksUrl);
  const store = new FileCredentialStore(secretsDir);
  const models = createModels({ credentials: store });
  models.setProvider(openaiProvider());
  const login = new LoginSession(await chatgptLoginDriver(), store, "openai");
  const audit = new AuditLog(`${dataDir}/audit.jsonl`);
  const engine = new PolicyEngine(new PolicyStore(`${dataDir}/policy.sqlite`), audit);
  const client = new UnixPodmanClient({
    crun: "/run/sbx/podman.sock",
    runsc: "/run/sbx/podman-runsc.sock",
  });
  const pool = new SandboxPool(createPodmanDriver(client, sbxRunner()));
  const controller = await startController({
    dataDir,
    workspaceRoot,
    port,
    access: {
      audience,
      issuer: issuer === undefined ? undefined : `https://${issuer}`,
      keys,
    },
    modelsFor: () => models,
    modelRef: { provider: "openai", modelId: process.env.PPA_MODEL_ID ?? "gpt-5.1" },
    pool,
    client,
    engine,
    login,
  });
  process.stdout.write(`listening 127.0.0.1:${controller.port} bots=${BOTS.join(",")}\n`);
}

function sbxRunner(): CommandRunner {
  return {
    run(argv) {
      const prefix =
        process.getuid?.() === 1001 ? [...argv] : ["runuser", "-u", "sbx", "--", "env", "XDG_RUNTIME_DIR=/run/user/1001", ...argv];
      const [bin, ...args] = prefix;
      if (bin === undefined) {
        return Promise.resolve({ code: 1 });
      }
      return new Promise((resolve) => {
        const child = spawn(bin, args, { stdio: "ignore" });
        child.once("error", () => resolve({ code: 1 }));
        child.once("exit", (code) => resolve({ code: code ?? 1 }));
      });
    },
  };
}

async function loadJwks(url: string): Promise<AccessKey[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("access jwks request failed");
  }
  const body = (await response.json()) as { keys?: { kid?: string; kty?: string; n?: string; e?: string }[] };
  const keys: AccessKey[] = [];
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || jwk.kid === undefined || jwk.n === undefined || jwk.e === undefined) {
      continue;
    }
    keys.push({
      kid: jwk.kid,
      key: crypto.createPublicKey({ key: jwk, format: "jwk" }),
    });
  }
  if (keys.length === 0) {
    throw new Error("access jwks had no rsa keys");
  }
  return keys;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "controller failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
