import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_RUNNING_SANDBOXES, RUNSC_SCOPE_PROPERTIES, SANDBOX_MEMORY_BYTES } from "../../src/sandbox/flags.ts";
import { createPodmanDriver, demuxPodmanFrames, type PodmanClient } from "../../src/sandbox/podman.ts";
import { SandboxPool, type SandboxDriver, type SandboxSession } from "../../src/sandbox/pool.ts";
import { RUNSC_DISABLED_MESSAGE } from "../../src/sandbox/runtime-guard.ts";
import { buildSandboxSpec, specKeepsSandbox } from "../../src/sandbox/spec.ts";

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

  it("starts crun without set-property and refuses runsc before create", async () => {
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
    const driver = createPodmanDriver(client);
    await driver.start(session("s", "crun"));
    expect(events).toEqual(["create:crun", "start"]);
    await expect(driver.start(session("s2", "runsc"))).rejects.toThrow(RUNSC_DISABLED_MESSAGE);
    expect(events).toEqual(["create:crun", "start"]);
    const driverSource = readFileSync(path.resolve("src/sandbox/podman.ts"), "utf8");
    const controllerSource = readFileSync(path.resolve("src/controller.ts"), "utf8");
    expect(driverSource).not.toMatch(/"runuser"/);
    expect(driverSource).not.toMatch(/"set-property"/);
    expect(controllerSource).not.toMatch(/"runuser"/);
    expect([...RUNSC_SCOPE_PROPERTIES]).toEqual(["MemoryMax=768M", "TasksMax=256", "CPUQuota=100%"]);
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

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function session(name: string, runtime: "crun" | "runsc" = "crun"): SandboxSession {
  return { bot: "ops", session: name, runtime, workspaceLeaf: `/tmp/ppa-leaf-${name}` };
}
