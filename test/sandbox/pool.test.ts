import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_RUNNING_SANDBOXES, SANDBOX_MEMORY_BYTES } from "../../src/sandbox/flags.ts";
import { createPodmanDriver, demuxPodmanFrames, type CommandRunner, type PodmanClient } from "../../src/sandbox/podman.ts";
import { SandboxPool, type SandboxDriver, type SandboxSession } from "../../src/sandbox/pool.ts";
import { buildSandboxSpec, specKeepsSandbox } from "../../src/sandbox/spec.ts";
import { ensureWorkspace, WorkspaceModeError } from "../../src/sandbox/workspace.ts";
import { chmodSync, mkdirSync, statSync } from "node:fs";

describe("sandbox pool", () => {
  it("queues the fourth sandbox until one stops", async () => {
    const started: string[] = [];
    const driver: SandboxDriver = {
      start: (session) => {
        started.push(session.session);
        return Promise.resolve({ containerId: session.session });
      },
      stop: () => Promise.resolve(),
    };
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const pool = new SandboxPool(driver, {
      idleMs: 1000,
      schedule: (ms, fn) => {
        const item = { at: now + ms, fn };
        timers.push(item);
        return () => {
          const index = timers.indexOf(item);
          if (index >= 0) {
            timers.splice(index, 1);
          }
        };
      },
    });
    const leases = await Promise.all([1, 2, 3].map((n) => pool.acquire(session(String(n)))));
    expect(pool.runningCount()).toBe(MAX_RUNNING_SANDBOXES);
    let fourthStarted = false;
    const fourth = pool.acquire(session("4")).then((lease) => {
      fourthStarted = true;
      return lease;
    });
    await Promise.resolve();
    expect(fourthStarted).toBe(false);
    expect(pool.queuedCount()).toBe(1);
    leases[0]?.release();
    now = 1000;
    for (const timer of [...timers]) {
      if (timer.at <= now) {
        timer.fn();
      }
    }
    const lease = await fourth;
    expect(started).toEqual(["1", "2", "3", "4"]);
    lease.release();
    await pool.shutdown();
  });

  it("releases the slot when stop throws and starts the queued sandbox", async () => {
    const started: string[] = [];
    const driver: SandboxDriver = {
      start: (session) => {
        started.push(session.session);
        return Promise.resolve({ containerId: `ctr-${session.session}` });
      },
      stop: () => Promise.reject(new Error("podman stop failed token=super-secret-token")),
    };
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const pool = new SandboxPool(driver, {
      idleMs: 1000,
      schedule: (ms, fn) => {
        const item = { at: now + ms, fn };
        timers.push(item);
        return () => {
          const index = timers.indexOf(item);
          if (index >= 0) {
            timers.splice(index, 1);
          }
        };
      },
    });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const leases = await Promise.all([1, 2, 3].map((n) => pool.acquire(session(String(n)))));
      const fourth = pool.acquire(session("4"));
      await Promise.resolve();
      expect(pool.queuedCount()).toBe(1);
      leases[0]?.release();
      now = 1000;
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          timer.fn();
        }
      }
      const lease = await fourth;
      await flush();
      expect(rejections).toEqual([]);
      expect(started).toEqual(["1", "2", "3", "4"]);
      expect(pool.runningCount()).toBe(MAX_RUNNING_SANDBOXES);
      expect(pool.queuedCount()).toBe(0);
      expect(lease.containerId).toBe("ctr-4");
      const logged = stderr.join("");
      expect(logged).toContain("sandbox stop failed: ctr-1");
      expect(logged).not.toContain("super-secret-token");
      lease.release();
    } finally {
      process.stderr.write = originalWrite;
      process.off("unhandledRejection", onRejection);
      await pool.shutdown().catch(() => undefined);
    }
  });

  it("cancels a queued sandbox", async () => {
    const driver: SandboxDriver = {
      start: (session) => Promise.resolve({ containerId: session.session }),
      stop: () => Promise.resolve(),
    };
    const pool = new SandboxPool(driver, { idleMs: 60_000 });
    await Promise.all([1, 2, 3].map((n) => pool.acquire(session(String(n)))));
    const controller = new AbortController();
    const queued = pool.acquire(session("4"), controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow(/aborted/);
    expect(pool.queuedCount()).toBe(0);
    await pool.shutdown();
  });

  it("applies runsc limits before start and refuses a failed set-property", async () => {
    const events: string[] = [];
    const client: PodmanClient = {
      create: async (runtime) => {
        events.push(`create:${runtime}`);
        return "id1";
      },
      start: async () => {
        events.push("start");
      },
      stop: async () => {
        events.push("stop");
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    const commands: string[][] = [];
    const runner: CommandRunner = {
      run: (argv) => {
        commands.push([...argv]);
        return Promise.resolve({ code: 0 });
      },
    };
    const driver = createPodmanDriver(client, runner);
    await driver.start(session("s", "runsc"));
    expect(events).toEqual(["create:runsc", "start"]);
    expect(commands[0]?.slice(0, 4)).toEqual(["systemctl", "--user", "set-property", "libpod-conmon-id1.scope"]);
    expect(commands[0]?.join(" ")).toContain("MemoryMax=768M");
    const failing: CommandRunner = { run: () => Promise.resolve({ code: 1 }) };
    const blocked = createPodmanDriver(client, failing);
    await expect(blocked.start(session("s2", "runsc"))).rejects.toThrow(/not started/);
    expect(events).toContain("stop");
  });

  it("refuses to raise the concurrency cap", () => {
    const driver: SandboxDriver = { start: () => Promise.resolve({ containerId: "x" }), stop: () => Promise.resolve() };
    expect(() => new SandboxPool(driver, { maxRunning: 4 })).toThrow(/cannot exceed 3/);
  });
});

describe("sandbox spec", () => {
  it("keeps the mandatory restrictions and the workspace leaf mount only", () => {
    const spec = buildSandboxSpec({ name: "ppa-ops-1", workspaceLeaf: "/home/sbx/workspaces/ops/1" });
    expect(specKeepsSandbox(spec)).toBe(true);
    expect(spec.cap_drop).toEqual(["ALL"]);
    expect(spec.privileged).toBe(false);
    expect(spec.env_host).toBe(false);
    expect(spec.resource_limits.memory.limit).toBe(SANDBOX_MEMORY_BYTES);
    expect(spec.mounts.filter((mount) => mount.type === "bind")).toEqual([
      expect.objectContaining({ destination: "/workspace", source: "/home/sbx/workspaces/ops/1" }),
    ]);
    expect(JSON.stringify(spec)).not.toContain("cap_add");
    expect(JSON.stringify(spec)).not.toContain("podman.sock");
    expect(() => buildSandboxSpec({ name: "bad", workspaceLeaf: "/home/agentctl/secrets" })).toThrow(/protected|secrets/);
  });

  it("demuxes podman exec frames without mixing streams", () => {
    const stdout = Buffer.from("out");
    const stderr = Buffer.from("err");
    const frame = (stream: number, payload: Buffer) => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const decoded = demuxPodmanFrames(Buffer.concat([frame(1, stdout), frame(2, stderr)]));
    expect(decoded).toEqual({ stdout: "out", stderr: "err" });
  });
});

describe("workspace directories", () => {
  it("creates a 0750 parent and a 0777 leaf, and refuses a looser parent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-ws-"));
    try {
      const leaf = ensureWorkspace(root, "ops", "sess");
      expect(statSync(path.join(root, "ops")).mode & 0o777).toBe(0o750);
      expect(statSync(leaf).mode & 0o777).toBe(0o777);
      const loose = path.join(root, "chief");
      mkdirSync(loose);
      chmodSync(loose, 0o755);
      expect(() => ensureWorkspace(root, "chief", "sess")).toThrow(WorkspaceModeError);
      expect(statSync(loose).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function session(name: string, runtime: "crun" | "runsc" = "crun"): SandboxSession {
  return { bot: "ops", session: name, runtime, workspaceLeaf: `/tmp/ppa-leaf-${name}` };
}
