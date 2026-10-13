import http from "node:http";
import { RUNSC_SCOPE_PROPERTIES } from "./flags.ts";
import type { SandboxDriver, SandboxSession } from "./pool.ts";
import { buildSandboxSpec, specKeepsSandbox, type SandboxSpec } from "./spec.ts";
import type { RuntimeKind } from "./pool.ts";

export interface PodmanExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PodmanClient {
  create(runtime: RuntimeKind, spec: SandboxSpec): Promise<string>;
  start(runtime: RuntimeKind, id: string): Promise<void>;
  stop(runtime: RuntimeKind, id: string): Promise<void>;
  exec(
    runtime: RuntimeKind,
    id: string,
    command: string | readonly string[],
    options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } | undefined,
  ): Promise<PodmanExecResult>;
}

export interface CommandRunner {
  run(argv: readonly string[]): Promise<{ readonly code: number }>;
}

export function containerName(session: SandboxSession): string {
  const raw = `ppa-${session.bot}-${session.session}`;
  return raw.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60);
}

/**
 * crun: create then start. runsc: create, set the conmon scope limits, then start.
 * A failed set-property does not start the container.
 */
export function createPodmanDriver(client: PodmanClient, runner: CommandRunner): SandboxDriver {
  return {
    async start(session) {
      const spec = buildSandboxSpec({
        name: containerName(session),
        workspaceLeaf: session.workspaceLeaf,
      });
      if (!specKeepsSandbox(spec)) {
        throw new Error("refusing to start a weakened sandbox");
      }
      const id = await client.create(session.runtime, spec);
      if (session.runtime === "runsc") {
        const result = await runner.run([
          "systemctl",
          "--user",
          "set-property",
          `libpod-conmon-${id}.scope`,
          ...RUNSC_SCOPE_PROPERTIES,
        ]);
        if (result.code !== 0) {
          await client.stop(session.runtime, id);
          throw new Error("runsc limits were not applied; container was not started");
        }
      }
      await client.start(session.runtime, id);
      return { containerId: id };
    },
    async stop(session, containerId) {
      await client.stop(session.runtime, containerId);
    },
  };
}

/** Docker/Podman multiplexed exec frames: 1 byte stream, 3 zero, uint32 BE length. */
export function demuxPodmanFrames(buffer: Buffer): { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset] ?? 0;
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) {
      break;
    }
    const chunk = buffer.subarray(start, end);
    if (stream === 2) {
      stderr.push(chunk);
    } else {
      stdout.push(chunk);
    }
    offset = end;
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

export interface PodmanSockets {
  readonly crun: string;
  readonly runsc: string;
}

export class UnixPodmanClient implements PodmanClient {
  private readonly sockets: PodmanSockets;

  constructor(sockets: PodmanSockets) {
    this.sockets = sockets;
  }

  async create(runtime: RuntimeKind, spec: SandboxSpec): Promise<string> {
    const body = await this.request(runtime, "POST", "/v4.0.0/libpod/containers/create", Buffer.from(JSON.stringify(spec)));
    const parsed = JSON.parse(body.toString("utf8")) as { Id?: string };
    if (typeof parsed.Id !== "string" || parsed.Id.length === 0) {
      throw new Error("podman create did not return an id");
    }
    return parsed.Id;
  }

  async start(runtime: RuntimeKind, id: string): Promise<void> {
    await this.request(runtime, "POST", `/v4.0.0/libpod/containers/${encodeURIComponent(id)}/start`, Buffer.alloc(0));
  }

  async stop(runtime: RuntimeKind, id: string): Promise<void> {
    await this.request(runtime, "POST", `/v4.0.0/libpod/containers/${encodeURIComponent(id)}/stop`, Buffer.alloc(0));
    await this.request(runtime, "DELETE", `/v4.0.0/libpod/containers/${encodeURIComponent(id)}?force=true`, Buffer.alloc(0));
  }

  async exec(
    runtime: RuntimeKind,
    id: string,
    command: string | readonly string[],
    options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } | undefined,
  ): Promise<PodmanExecResult> {
    const cmd = typeof command === "string" ? ["bash", "-lc", command] : [...command];
    const created = await this.request(
      runtime,
      "POST",
      `/v4.0.0/libpod/containers/${encodeURIComponent(id)}/exec`,
      Buffer.from(JSON.stringify({
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Privileged: false,
        Cmd: cmd,
        WorkingDir: options?.cwd ?? "/workspace",
        Env: options?.env === undefined ? undefined : Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
      })),
    );
    const execId = (JSON.parse(created.toString("utf8")) as { Id?: string }).Id;
    if (typeof execId !== "string") {
      throw new Error("podman exec did not return an id");
    }
    const streamed = await this.request(
      runtime,
      "POST",
      `/v4.0.0/libpod/exec/${encodeURIComponent(execId)}/start`,
      Buffer.from(JSON.stringify({ Detach: false, Tty: false })),
      { Upgrade: "tcp", Connection: "Upgrade" },
    );
    const inspected = await this.request(runtime, "GET", `/v4.0.0/libpod/exec/${encodeURIComponent(execId)}/json`, Buffer.alloc(0));
    const exitCode = (JSON.parse(inspected.toString("utf8")) as { ExitCode?: number }).ExitCode ?? 1;
    const frames = demuxPodmanFrames(streamed);
    return { exitCode, stdout: frames.stdout, stderr: frames.stderr };
  }

  private request(
    runtime: RuntimeKind,
    method: string,
    path: string,
    body: Buffer,
    headers: Record<string, string> = {},
  ): Promise<Buffer> {
    const socketPath = runtime === "crun" ? this.sockets.crun : this.sockets.runsc;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path,
          method,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on("end", () => {
            const payload = Buffer.concat(chunks);
            const status = res.statusCode ?? 500;
            if (status >= 400) {
              reject(new Error(`podman ${method} ${path} failed (${status})`));
              return;
            }
            resolve(payload);
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }
}
