import http from "node:http";
import { MAX_FILE_BYTES } from "./flags.ts";
import type { SandboxDriver, SandboxSession } from "./pool.ts";
import { RUNSC_DISABLED_MESSAGE } from "./runtime-guard.ts";
import { buildSandboxSpec, specKeepsSandbox, type SandboxSpec } from "./spec.ts";
import type { RuntimeKind } from "./pool.ts";

/** Hijack output grew past MAX_FILE_BYTES. The extra bytes are not returned. */
export class PodmanOutputTooLargeError extends Error {
  constructor() {
    super("too_large");
    this.name = "PodmanOutputTooLargeError";
  }
}

export interface PodmanExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Raw stdout frames. File operations use this so binary writes survive the exec. */
  readonly stdoutBytes?: Uint8Array;
}

export interface PodmanExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Present only when the container command must read stdin (tee). */
  readonly stdin?: Uint8Array;
}

export interface PodmanClient {
  create(runtime: RuntimeKind, spec: SandboxSpec): Promise<string>;
  start(runtime: RuntimeKind, id: string): Promise<void>;
  stop(runtime: RuntimeKind, id: string): Promise<void>;
  exec(
    runtime: RuntimeKind,
    id: string,
    command: string | readonly string[],
    options: PodmanExecOptions | undefined,
  ): Promise<PodmanExecResult>;
}

export function containerName(session: SandboxSession): string {
  const raw = `ppa-${session.bot}-${session.session}`;
  return raw.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60);
}

/**
 * Production start is crun only: create, then start.
 * runsc is refused before create. Scope properties are not applied from this process.
 * crun limits stay on the podman spec (memory, pids, cpu, cap_drop, no_new_privileges, read-only).
 */
export function createPodmanDriver(client: PodmanClient): SandboxDriver {
  return {
    async start(session) {
      if (session.runtime !== "crun") {
        throw new Error(RUNSC_DISABLED_MESSAGE);
      }
      const spec = buildSandboxSpec({
        name: containerName(session),
        workspaceLeaf: session.workspaceLeaf,
      });
      if (!specKeepsSandbox(spec)) {
        throw new Error("refusing to start a weakened sandbox");
      }
      const id = await client.create("crun", spec);
      await client.start("crun", id);
      return { containerId: id };
    },
    async stop(session, containerId) {
      if (session.runtime !== "crun") {
        throw new Error(RUNSC_DISABLED_MESSAGE);
      }
      await client.stop("crun", containerId);
    },
  };
}

/** Docker/Podman multiplexed exec frames: 1 byte stream, 3 zero, uint32 BE length. */
export function demuxPodmanFrameBuffers(buffer: Buffer): { stdout: Buffer; stderr: Buffer } {
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
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

export function demuxPodmanFrames(buffer: Buffer): { stdout: string; stderr: string } {
  const frames = demuxPodmanFrameBuffers(buffer);
  return {
    stdout: frames.stdout.toString("utf8"),
    stderr: frames.stderr.toString("utf8"),
  };
}

/** One multiplexed output frame: stream byte, three zero bytes, uint32 BE length. */
export function muxPodmanFrame(stream: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = stream & 0xff;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * Multiplexed stdout/stderr. A frame bigger than MAX_FILE_BYTES is rejected
 * before its body is kept. Payload (not the 8-byte headers) past the cap is too.
 */
class CappedFrames {
  private readonly parts: Buffer[] = [];
  private header = Buffer.alloc(0);
  private remaining: number | undefined;
  private payload = 0;
  private retained = 0;

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === undefined) {
        const need = 8 - this.header.length;
        const take = Math.min(need, chunk.length - offset);
        const next = Buffer.alloc(this.header.length + take);
        this.header.copy(next, 0);
        chunk.copy(next, this.header.length, offset, offset + take);
        this.header = next;
        offset += take;
        if (this.header.length < 8) {
          return;
        }
        const size = this.header.readUInt32BE(4);
        if (size > MAX_FILE_BYTES || this.payload + size > MAX_FILE_BYTES) {
          this.header = Buffer.alloc(0);
          throw new PodmanOutputTooLargeError();
        }
        this.keep(this.header);
        this.payload += size;
        this.remaining = size;
        this.header = Buffer.alloc(0);
        continue;
      }
      if (this.remaining === 0) {
        this.remaining = undefined;
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - offset);
      const piece = Buffer.alloc(take);
      chunk.copy(piece, 0, offset, offset + take);
      this.keep(piece);
      offset += take;
      this.remaining -= take;
      if (this.remaining === 0) {
        this.remaining = undefined;
      }
    }
  }

  concat(): Buffer {
    if (this.header.length > 0) {
      this.parts.push(this.header);
      this.header = Buffer.alloc(0);
    }
    return Buffer.concat(this.parts);
  }

  private keep(piece: Buffer): void {
    this.retained += piece.length;
    if (this.retained > MAX_FILE_BYTES + 4096) {
      throw new PodmanOutputTooLargeError();
    }
    this.parts.push(piece);
  }
}

function takeFrames(
  frames: CappedFrames,
  chunk: Buffer,
  destroy: () => void,
  fail: (error: unknown) => void,
  settled: () => boolean,
): void {
  if (settled()) {
    return;
  }
  try {
    frames.push(chunk);
  } catch (error) {
    destroy();
    fail(error);
  }
}

export interface PodmanSockets {
  readonly crun: string;
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
    options: PodmanExecOptions | undefined,
  ): Promise<PodmanExecResult> {
    const cmd = typeof command === "string" ? ["bash", "-lc", command] : [...command];
    const stdin = options?.stdin === undefined ? undefined : Buffer.from(options.stdin);
    const created = await this.request(
      runtime,
      "POST",
      `/v4.0.0/libpod/containers/${encodeURIComponent(id)}/exec`,
      Buffer.from(JSON.stringify({
        AttachStdin: stdin !== undefined,
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
    const streamed = await this.hijack(
      runtime,
      "POST",
      `/v4.0.0/libpod/exec/${encodeURIComponent(execId)}/start`,
      Buffer.from(JSON.stringify({ Detach: false, Tty: false })),
      stdin,
    );
    const inspected = await this.request(runtime, "GET", `/v4.0.0/libpod/exec/${encodeURIComponent(execId)}/json`, Buffer.alloc(0));
    const exitCode = (JSON.parse(inspected.toString("utf8")) as { ExitCode?: number }).ExitCode ?? 1;
    const frames = demuxPodmanFrameBuffers(streamed);
    return {
      exitCode,
      stdout: frames.stdout.toString("utf8"),
      stderr: frames.stderr.toString("utf8"),
      stdoutBytes: frames.stdout,
    };
  }

  private request(
    runtime: RuntimeKind,
    method: string,
    path: string,
    body: Buffer,
    headers: Record<string, string> = {},
  ): Promise<Buffer> {
    if (runtime !== "crun") {
      return Promise.reject(new Error(RUNSC_DISABLED_MESSAGE));
    }
    const socketPath = this.sockets.crun;
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

  /**
   * Exec start may answer 200 with a body, or 101 and then multiplexed output frames.
   * Stdin on the upgraded socket is raw bytes (no 8-byte header). socket.end() half-closes it.
   */
  private hijack(
    runtime: RuntimeKind,
    method: string,
    requestPath: string,
    body: Buffer,
    stdin: Buffer | undefined,
  ): Promise<Buffer> {
    if (runtime !== "crun") {
      return Promise.reject(new Error(RUNSC_DISABLED_MESSAGE));
    }
    const socketPath = this.sockets.crun;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (payload: Buffer): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(payload);
      };
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error instanceof Error ? error : new Error("podman exec failed"));
      };
      const req = http.request(
        {
          socketPath,
          path: requestPath,
          method,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            Upgrade: "tcp",
            Connection: "Upgrade",
          },
        },
        (res) => {
          const frames = new CappedFrames();
          res.on("data", (chunk: Buffer) => {
            takeFrames(frames, chunk, () => {
              res.destroy();
            }, fail, () => settled);
          });
          res.on("end", () => {
            const status = res.statusCode ?? 500;
            if (status >= 400) {
              fail(new Error(`podman ${method} ${requestPath} failed (${status})`));
              return;
            }
            if (stdin !== undefined) {
              fail(new Error("podman exec start did not upgrade for stdin"));
              return;
            }
            finish(frames.concat());
          });
          res.on("error", fail);
        },
      );
      req.on("upgrade", (_response, socket, head) => {
        const frames = new CappedFrames();
        if (head.length > 0) {
          takeFrames(frames, head, () => {
            socket.destroy();
          }, fail, () => settled);
        }
        socket.on("data", (chunk: Buffer) => {
          takeFrames(frames, chunk, () => {
            socket.destroy();
          }, fail, () => settled);
        });
        socket.on("error", fail);
        socket.on("end", () => {
          finish(frames.concat());
        });
        if (settled) {
          return;
        }
        if (stdin !== undefined && stdin.length > 0) {
          socket.write(stdin);
        }
        socket.end();
      });
      req.on("error", fail);
      req.end(body);
    });
  }
}
