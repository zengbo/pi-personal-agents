import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxExecutionEnv } from "../../src/sandbox/env.ts";
import { FILE_OP_SCRIPT, parseFileOpArgv, runFileOp } from "../../src/sandbox/file-op.ts";
import { MAX_FILE_BYTES } from "../../src/sandbox/flags.ts";
import { createPodmanDriver, PodmanOutputTooLargeError, type PodmanClient, type PodmanExecResult } from "../../src/sandbox/podman.ts";
import { SandboxPool, type SandboxDriver, type SandboxSession } from "../../src/sandbox/pool.ts";
import { createSessionLeaf } from "../../src/sandbox/workspace-helper.ts";

const context = BACKGROUND_CONTEXT;

describe("sandbox execution env", () => {
  it("rejects a symlink target, a hard link, and a path escape without returning file bytes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-env-"));
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "SENTINEL-SECRET-BYTES");
    const ops: string[] = [];
    const backed = scriptBacked(ops);
    const pool = backed.pool;
    try {
      const leaf = sessionLeaf(root, "ops", "sess");
      symlinkSync(outside, path.join(leaf, "link.txt"));
      writeFileSync(path.join(leaf, "real.txt"), "linked-bytes");
      writeFileSync(path.join(leaf, "plain.txt"), "inside");
      linkSync(path.join(leaf, "real.txt"), path.join(leaf, "hard.txt"));
      symlinkSync(path.join(leaf, "plain.txt"), path.join(leaf, "inner.txt"));
      const env = new SandboxExecutionEnv(pool, backed.client, session(leaf, "sess"));
      const linked = await env.readTextFile("/workspace/link.txt", context);
      expect(linked.ok).toBe(false);
      if (!linked.ok) {
        expect(linked.error.message).toBe("escape");
      }
      expect(JSON.stringify(linked)).not.toContain("SENTINEL-SECRET-BYTES");
      const hard = await env.readTextFile("hard.txt", context);
      expect(hard.ok).toBe(false);
      if (!hard.ok) {
        expect(hard.error.message).toBe("hardlink");
      }
      expect(JSON.stringify(hard)).not.toContain("linked-bytes");
      const inner = await env.readTextFile("inner.txt", context);
      expect(inner.ok).toBe(false);
      if (!inner.ok) {
        expect(inner.error.message).toBe("symlink");
      }
      expect(JSON.stringify(inner)).not.toContain("inside");
      const callsBeforeEscape = ops.length;
      const escaped = await env.readTextFile("../outside.txt", context);
      expect(escaped.ok).toBe(false);
      if (!escaped.ok) {
        expect(escaped.error.message).toBe("dotdot");
      }
      expect(ops).toHaveLength(callsBeforeEscape);
      expect(JSON.stringify(escaped)).not.toContain("SENTINEL-SECRET-BYTES");
      const absolute = await env.readTextFile("/etc/passwd", context);
      expect(absolute.ok).toBe(false);
      if (!absolute.ok) {
        expect(absolute.error.message).toBe("escape");
      }
      expect(ops).toHaveLength(callsBeforeEscape);
      const real = await env.readTextFile("plain.txt", context);
      expect(real.ok ? real.value : "").toBe("inside");
      expect(ops).toContain("read");
      expect(FILE_OP_SCRIPT).toContain('head -c "$((max_bytes + 1))"');
      expect(FILE_OP_SCRIPT).toContain("too_large");
      expect(FILE_OP_SCRIPT).toContain("realpath -e");
      expect(readFileSync(path.resolve("src/sandbox/env.ts"), "utf8")).not.toContain("node:fs");
      const direct = runFileOp(leaf, "read", path.join(leaf, "link.txt"));
      expect(direct.exitCode).not.toBe(0);
      expect(direct.stderr.trim()).toBe("escape");
      expect(direct.stdout.toString("utf8")).not.toContain("SENTINEL-SECRET-BYTES");
      const directDot = runFileOp(leaf, "read", `${leaf}/../outside.txt`);
      expect(directDot.stderr.trim()).toBe("dotdot");
      expect(directDot.stdout.toString("utf8")).not.toContain("SENTINEL-SECRET-BYTES");
    } finally {
      await pool.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps session files invisible to another session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-env-"));
    const ops: string[] = [];
    const backed = scriptBacked(ops);
    const pool = backed.pool;
    try {
      const left = sessionLeaf(root, "ops", "left");
      const right = sessionLeaf(root, "ops", "right");
      const a = new SandboxExecutionEnv(pool, backed.client, session(left, "left"));
      const b = new SandboxExecutionEnv(pool, backed.client, session(right, "right"));
      const wrote = await a.writeFile("secret.txt", "session-a-only", context);
      expect(wrote.ok).toBe(true);
      const other = await b.readTextFile("secret.txt", context);
      expect(other.ok).toBe(false);
      expect(JSON.stringify(other)).not.toContain("session-a-only");
      const own = await a.readTextFile("secret.txt", context);
      expect(own.ok ? own.value : "").toBe("session-a-only");
      expect(ops).toContain("write");
      expect(ops).toContain("read");
      expect(FILE_OP_SCRIPT).toContain("tee --");
      const binary = await a.writeFile("bin.dat", new Uint8Array([0xff, 0x00, 0x41]), context);
      expect(binary.ok).toBe(true);
      const round = await a.readBinaryFile("bin.dat", context);
      expect(round.ok ? [...round.value] : []).toEqual([0xff, 0x00, 0x41]);
    } finally {
      await pool.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not pass secret environment variables into the container", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-env-"));
    const recorded: (Readonly<Record<string, string>> | undefined)[] = [];
    const client: PodmanClient = {
      create: async () => "c1",
      start: async () => undefined,
      stop: async () => undefined,
      exec: async (_runtime, _id, _command, options) => {
        recorded.push(options?.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const pool = new SandboxPool(createPodmanDriver(client), { idleMs: 60_000 });
    try {
      const leaf = path.join(root, "leaf");
      mkdirSync(leaf, { recursive: true });
      const env = new SandboxExecutionEnv(pool, client, session(leaf, "sess"));
      const result = await env.exec("true", { env: { OPENAI_API_KEY: "super-secret-token", PATH: "/usr/bin" } }, context);
      expect(result.ok).toBe(true);
      const encoded = JSON.stringify(recorded);
      expect(encoded).not.toContain("super-secret-token");
      expect(encoded).toContain("/usr/bin");
      expect(encoded).toContain("http://10.0.2.2:8888");
    } finally {
      await pool.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a write larger than 8 MiB before exec", async () => {
    let started = 0;
    let execs = 0;
    const client: PodmanClient = {
      create: async () => "c",
      start: async () => undefined,
      stop: async () => undefined,
      exec: async (_runtime, _id, _command, options) => {
        execs += 1;
        expect(options?.stdin?.byteLength).toBe(MAX_FILE_BYTES);
        return emptyExec();
      },
    };
    const driver: SandboxDriver = {
      start() {
        started += 1;
        return Promise.resolve({ containerId: "c" });
      },
      stop() {
        return Promise.resolve();
      },
    };
    const pool = new SandboxPool(driver, { idleMs: 60_000 });
    try {
      const env = new SandboxExecutionEnv(pool, client, session("/tmp/unused-leaf", "sess"));
      const wrote = await env.writeFile("big.bin", Buffer.alloc(MAX_FILE_BYTES + 1), context);
      expect(wrote.ok).toBe(false);
      if (!wrote.ok) {
        expect(wrote.error.message).toBe("too_large");
      }
      const appended = await env.appendFile("big.bin", Buffer.alloc(MAX_FILE_BYTES + 1), context);
      expect(appended.ok).toBe(false);
      if (!appended.ok) {
        expect(appended.error.message).toBe("too_large");
      }
      expect(execs).toBe(0);
      expect(started).toBe(0);
      const counted = await env.writeFile("exact.bin", Buffer.alloc(MAX_FILE_BYTES), context);
      expect(counted.ok).toBe(true);
      expect(execs).toBe(1);
      expect(started).toBe(1);
    } finally {
      await pool.shutdown();
    }
  });

  it("returns too_large for a read past 8 MiB and does not emit the bytes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-env-"));
    const backed = scriptBacked([]);
    const pool = backed.pool;
    try {
      const leaf = sessionLeaf(root, "ops", "sess");
      writeFileSync(path.join(leaf, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 0xab));
      const direct = runFileOp(leaf, "read", path.join(leaf, "big.bin"));
      expect(direct.exitCode).not.toBe(0);
      expect(direct.stderr.trim()).toBe("too_large");
      expect(direct.stdout.length).toBe(0);
      writeFileSync(path.join(leaf, "exact.bin"), Buffer.alloc(MAX_FILE_BYTES, 0x11));
      const exactRead = runFileOp(leaf, "read", path.join(leaf, "exact.bin"));
      expect(exactRead.exitCode).toBe(0);
      expect(exactRead.stdout.length).toBe(MAX_FILE_BYTES);
      expect(exactRead.stdout[0]).toBe(0x11);
      expect(exactRead.stdout[MAX_FILE_BYTES - 1]).toBe(0x11);
      const env = new SandboxExecutionEnv(pool, backed.client, session(leaf, "sess"));
      const read = await env.readBinaryFile("big.bin", context);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.error.message).toBe("too_large");
      }
      expect(JSON.stringify(read)).not.toMatch(/ab{8,}/);
    } finally {
      await pool.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists a file whose name contains a newline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-env-"));
    const backed = scriptBacked([]);
    const pool = backed.pool;
    try {
      const leaf = sessionLeaf(root, "ops", "sess");
      writeFileSync(path.join(leaf, "a\nb.txt"), "x");
      const env = new SandboxExecutionEnv(pool, backed.client, session(leaf, "sess"));
      const listed = await env.listDir("/workspace", context);
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value.map((entry) => entry.name)).toContain("a\nb.txt");
        expect(listed.value.find((entry) => entry.name === "a\nb.txt")?.kind).toBe("file");
      }
    } finally {
      await pool.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps an oversized exec stream to too_large", async () => {
    const client: PodmanClient = {
      create: async () => "c",
      start: async () => undefined,
      stop: async () => undefined,
      exec: () => Promise.reject(new PodmanOutputTooLargeError()),
    };
    const pool = new SandboxPool(createPodmanDriver(client), { idleMs: 60_000 });
    try {
      const env = new SandboxExecutionEnv(pool, client, session("/tmp/unused-leaf", "sess"));
      const read = await env.readTextFile("note.txt", context);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.error.message).toBe("too_large");
      }
    } finally {
      await pool.shutdown();
    }
  });
});

function sessionLeaf(root: string, bot: string, sessionName: string): string {
  chmodSync(root, 0o750);
  const parent = path.join(root, bot);
  if (!existsSync(parent)) {
    mkdirSync(parent);
  }
  chmodSync(parent, 0o750);
  return createSessionLeaf(root, bot, sessionName);
}

function session(leaf: string, name: string): SandboxSession {
  return { bot: "ops", session: name, runtime: "crun", workspaceLeaf: leaf };
}

function scriptBacked(ops: string[]): { pool: SandboxPool; client: PodmanClient } {
  const leaves = new Map<string, string>();
  const driver: SandboxDriver = {
    start(current) {
      const id = `${current.bot}/${current.session}`;
      leaves.set(id, current.workspaceLeaf);
      return Promise.resolve({ containerId: id });
    },
    stop() {
      return Promise.resolve();
    },
  };
  const client: PodmanClient = {
    create: async () => "c",
    start: async () => undefined,
    stop: async () => undefined,
    exec: async (_runtime, id, command, options) => {
      const parsed = parseFileOpArgv(command);
      if (parsed === undefined) {
        ops.push("shell");
        return emptyExec();
      }
      ops.push(parsed.op);
      const leaf = leaves.get(id);
      if (leaf === undefined) {
        return { exitCode: 1, stdout: "", stderr: "unknown\n", stdoutBytes: new Uint8Array() };
      }
      const target = toHost(leaf, parsed.path);
      const extra = parsed.op === "rename" && parsed.extra !== undefined ? toHost(leaf, parsed.extra) : parsed.extra;
      const ran = runFileOp(leaf, parsed.op, target, options?.stdin, extra);
      return { exitCode: ran.exitCode, stdout: ran.stdout.toString("utf8"), stderr: ran.stderr, stdoutBytes: ran.stdout };
    },
  };
  return { pool: new SandboxPool(driver, { idleMs: 60_000 }), client };
}

function toHost(leaf: string, containerPath: string): string {
  if (containerPath === "/workspace") {
    return leaf;
  }
  if (containerPath.startsWith("/workspace/")) {
    return path.join(leaf, containerPath.slice("/workspace/".length));
  }
  return containerPath;
}

function emptyExec(): PodmanExecResult {
  return { exitCode: 0, stdout: "", stderr: "", stdoutBytes: new Uint8Array() };
}
