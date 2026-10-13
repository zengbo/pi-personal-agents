import crypto from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { CompactionPolicy, Harness } from "@earendil-works/pi-durable";
import { FileCredentialStore } from "../../src/auth/file-credential-store.ts";
import { LoginSession, type LoginDriver } from "../../src/auth/login.ts";
import { BOTS, type BotName } from "../../src/bots/extensions.ts";
import { startController, type RunningController } from "../../src/controller/runtime.ts";
import { AuditLog } from "../../src/policy/audit.ts";
import { PolicyEngine } from "../../src/policy/engine.ts";
import { PolicyStore } from "../../src/policy/store.ts";
import type { PodmanClient, PodmanExecOptions, PodmanExecResult } from "../../src/sandbox/podman.ts";
import { createPodmanDriver } from "../../src/sandbox/podman.ts";
import { SandboxPool } from "../../src/sandbox/pool.ts";
import { startWorkspaceHelper, type WorkspaceHelper } from "../../src/sandbox/workspace-helper.ts";
import type { SandboxSpec } from "../../src/sandbox/spec.ts";
import type { RuntimeKind } from "../../src/sandbox/pool.ts";
import type { AccessKey } from "../../src/web/access.ts";

export interface TestRigOptions {
  readonly root?: string;
  readonly trace?: string[];
  readonly faux?: Map<BotName, ReturnType<typeof fauxProvider>>;
  readonly exec?: PodmanClient["exec"];
  readonly prepare?: (faux: Map<BotName, ReturnType<typeof fauxProvider>>) => void;
  readonly compaction?: Partial<CompactionPolicy>;
  readonly onHarness?: (bot: BotName, harness: Harness) => void;
}

export interface TestRig {
  readonly root: string;
  readonly dataDir: string;
  readonly workspaceRoot: string;
  readonly controller: RunningController;
  readonly token: string;
  readonly podman: FakePodman;
  readonly engine: PolicyEngine;
  readonly login: LoginSession;
  readonly secrets: FileCredentialStore;
  readonly faux: Map<BotName, ReturnType<typeof fauxProvider>>;
  close(): Promise<void>;
}

export class FakePodman implements PodmanClient {
  readonly events: string[] = [];
  readonly execs: { command: string | readonly string[]; env?: Readonly<Record<string, string>>; stdin?: Uint8Array }[] = [];
  spec: SandboxSpec | undefined;
  private readonly execImpl: PodmanClient["exec"] | undefined;

  constructor(execImpl?: PodmanClient["exec"]) {
    this.execImpl = execImpl;
  }

  async create(runtime: RuntimeKind, spec: SandboxSpec): Promise<string> {
    this.events.push(`create:${runtime}`);
    this.spec = spec;
    return `ctr-${this.events.length}`;
  }

  async start(runtime: RuntimeKind, id: string): Promise<void> {
    this.events.push(`start:${runtime}:${id}`);
  }

  async stop(runtime: RuntimeKind, id: string): Promise<void> {
    this.events.push(`stop:${runtime}:${id}`);
  }

  async exec(
    runtime: RuntimeKind,
    id: string,
    command: string | readonly string[],
    options: PodmanExecOptions | undefined,
  ): Promise<PodmanExecResult> {
    this.execs.push({ command, env: options?.env, stdin: options?.stdin });
    if (this.execImpl !== undefined) {
      return this.execImpl(runtime, id, command, options);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

export async function startTestRig(options?: TestRigOptions): Promise<TestRig> {
  const root = options?.root ?? mkdtempSync(path.join(tmpdir(), "ppa-phase1-"));
  const dataDir = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspaces");
  const secretsDir = path.join(root, "secrets");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keys: AccessKey[] = [{ kid: "test", key: publicKey }];
  const issued = Math.floor(Date.now() / 1000);
  const token = signJwt(privateKey, {
    aud: "test-aud",
    iss: "https://example.cloudflareaccess.com",
    exp: issued + 600,
    iat: issued,
    nbf: issued,
    email: "user@example.com",
  });
  const models = options?.faux ?? new Map<BotName, ReturnType<typeof fauxProvider>>();
  if (models.size === 0) {
    for (const bot of BOTS) {
      models.set(bot, fauxProvider({ api: "faux", provider: "faux" }));
    }
  }
  const secrets = new FileCredentialStore(secretsDir);
  const login = new LoginSession(silentLogin(), secrets, "openai");
  const engine = new PolicyEngine(new PolicyStore(path.join(dataDir, "policy.sqlite")), new AuditLog(path.join(dataDir, "audit.jsonl")));
  options?.prepare?.(models);
  const podman = new FakePodman(options?.exec);
  const pool = new SandboxPool(createPodmanDriver(podman));
  prepareWorkspaceParents(workspaceRoot);
  const workspaceSocket = path.join(root, "workspace.sock");
  const helper = await startWorkspaceHelper({ root: workspaceRoot, socketPath: workspaceSocket });
  let controller: RunningController;
  try {
    controller = await startController({
    dataDir,
    workspaceRoot,
    workspaceSocket,
    port: 0,
    access: {
      audience: "test-aud",
      issuer: "https://example.cloudflareaccess.com",
      ownerEmail: "user@example.com",
      origin: "https://chat.example.com",
      keys,
    },
    modelsFor: (bot) => {
      const faux = models.get(bot);
      if (faux === undefined) {
        throw new Error(bot);
      }
      const catalog = createModels();
      catalog.setProvider(faux.provider);
      return catalog;
    },
    modelRef: { provider: "faux", modelId: "faux-1" },
    pool,
    client: podman,
    engine,
    login,
    trace: options?.trace,
    compaction: options?.compaction,
    onHarness: options?.onHarness,
  });
  } catch (error) {
    await helper.close();
    throw error;
  }
  return {
    root,
    dataDir,
    workspaceRoot,
    controller,
    token,
    podman,
    engine,
    login,
    secrets,
    faux: models,
    close: () => closeRig(controller, helper),
  };
}

async function closeRig(controller: RunningController, helper: WorkspaceHelper): Promise<void> {
  await controller.close();
  await helper.close();
}

function prepareWorkspaceParents(root: string): void {
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o750);
  for (const bot of BOTS) {
    const parent = path.join(root, bot);
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o750);
  }
}

export function signJwt(key: crypto.KeyObject, payload: Record<string, unknown>, kid = "test"): string {
  const header = base64url(JSON.stringify({ alg: "RS256", kid }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function silentLogin(): LoginDriver {
  return {
    async login(interaction) {
      interaction.notify({ type: "info", message: "打开登录页" });
      await interaction.prompt({ type: "manual_code", message: "粘贴授权码" });
      return { type: "oauth", access: "super-secret-token", refresh: "refresh-secret", expires: 0 };
    },
  };
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
