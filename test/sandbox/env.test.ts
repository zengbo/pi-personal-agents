import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxExecutionEnv } from "../../src/sandbox/env.ts";
import { createPodmanDriver, type PodmanClient } from "../../src/sandbox/podman.ts";
import { SandboxPool } from "../../src/sandbox/pool.ts";
import { ensureWorkspace } from "../../src/sandbox/workspace.ts";

const context = BACKGROUND_CONTEXT;

describe("sandbox execution env", () => {
  it("rejects a symlink, a hard link, and a path escape without returning file bytes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-env-"));
    const pool = new SandboxPool(idleDriver(), { idleMs: 60_000 });
    try {
      const leaf = ensureWorkspace(root, "ops", "sess");
      const outside = path.join(root, "outside.txt");
      writeFileSync(outside, "SENTINEL-SECRET-BYTES");
      symlinkSync(outside, path.join(leaf, "link.txt"));
      writeFileSync(path.join(leaf, "real.txt"), "linked-bytes");
      writeFileSync(path.join(leaf, "plain.txt"), "inside");
      linkSync(path.join(leaf, "real.txt"), path.join(leaf, "hard.txt"));
      const env = new SandboxExecutionEnv(pool, recordingClient().client, session(leaf, "sess"));
      const linked = await env.readTextFile("/workspace/link.txt", context);
      expect(linked.ok).toBe(false);
      expect(JSON.stringify(linked)).not.toContain("SENTINEL-SECRET-BYTES");
      const hard = await env.readTextFile("hard.txt", context);
      expect(hard.ok).toBe(false);
      expect(JSON.stringify(hard)).not.toContain("linked-bytes");
      const escaped = await env.readTextFile("../outside.txt", context);
      expect(escaped.ok).toBe(false);
      expect(JSON.stringify(escaped)).not.toContain("SENTINEL-SECRET-BYTES");
      const real = await env.readTextFile("plain.txt", context);
      expect(real.ok ? real.value : "").toBe("inside");
    } finally {
      await pool.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps session files invisible to another session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-env-"));
    const pool = new SandboxPool(idleDriver(), { idleMs: 60_000 });
    try {
      const left = ensureWorkspace(root, "ops", "left");
      const right = ensureWorkspace(root, "ops", "right");
      const client = recordingClient();
      const a = new SandboxExecutionEnv(pool, client.client, session(left, "left"));
      const b = new SandboxExecutionEnv(pool, client.client, session(right, "right"));
      const wrote = await a.writeFile("secret.txt", "session-a-only", context);
      expect(wrote.ok).toBe(true);
      const other = await b.readTextFile("secret.txt", context);
      expect(other.ok).toBe(false);
      expect(JSON.stringify(other)).not.toContain("session-a-only");
      const own = await a.readTextFile("secret.txt", context);
      expect(own.ok ? own.value : "").toBe("session-a-only");
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
    const pool = new SandboxPool(createPodmanDriver(client, { run: async () => ({ code: 0 }) }), { idleMs: 60_000 });
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
});

function session(leaf: string, name: string) {
  return { bot: "ops", session: name, runtime: "crun" as const, workspaceLeaf: leaf };
}

function idleDriver() {
  return {
    start: () => Promise.resolve({ containerId: "c" }),
    stop: () => Promise.resolve(),
  };
}

function recordingClient(): { client: PodmanClient } {
  const client: PodmanClient = {
    create: async () => "c",
    start: async () => undefined,
    stop: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  return { client };
}
