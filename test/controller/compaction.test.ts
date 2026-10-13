import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { controllerCompaction } from "../../src/controller/runtime.ts";

const childScript = fileURLToPath(new URL("./compact-child.ts", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("conversation compaction", () => {
  it("uses pi-durable's built-in compaction policy", () => {
    expect(controllerCompaction()).toEqual(DEFAULT_COMPACTION_POLICY);
    expect(controllerCompaction().enabled).toBe(true);
    expect(controllerCompaction({ keepRecentTokens: 200 }).keepRecentTokens).toBe(200);
  });

  it("compacts a long conversation, continues, and does not replay exec after a crash", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-compact-"));
    directories.push(root);
    const execLog = path.join(root, "exec.log");
    const markerPath = path.join(root, "marker");
    const seenPath = path.join(root, "seen.json");
    const shared = {
      PPA_ROOT: root,
      PPA_EXEC_LOG: execLog,
      PPA_MARKER: markerPath,
      PPA_SEEN: seenPath,
    };
    const build = spawnChild(["build"], { ...shared, PPA_CRASH: "1" });
    try {
      await waitForFile(seenPath, 20_000);
      await waitForFile(markerPath, 20_000);
    } catch (error) {
      build.child.kill("SIGKILL");
      const stderr = await build.stderr;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`, { cause: error });
    }
    const seen = JSON.parse(readFileSync(seenPath, "utf8")) as { sawSummary: boolean; sawBulk: boolean; sawTrust: boolean };
    expect(seen).toEqual({ sawSummary: true, sawBulk: false, sawTrust: true });
    build.child.kill("SIGKILL");
    const crashed = await build.done;
    expect(crashed.code).not.toBe(0);
    const recover = spawnChild(["recover"], shared);
    const recoverResult = await recover.done;
    if (recoverResult.code !== 0) {
      throw new Error(`recover exited ${recoverResult.code}\n${recoverResult.stderr}`);
    }
    const report = JSON.parse(recoverResult.stdout) as {
      runs: number;
      keptSummary: boolean;
      continued: boolean;
    };
    expect(report.runs).toBe(1);
    expect(report.keptSummary).toBe(true);
    expect(report.continued).toBe(true);
  }, 90_000);
});

function spawnChild(args: string[], extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, ["--experimental-strip-types", childScript, ...args], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
  return { child, done, stderr: done.then((result) => result.stderr) };
}

function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if (readFileSync(file, "utf8").length > 0) {
          clearInterval(timer);
          resolve();
          return;
        }
      } catch {
        // The child has not written the file yet.
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${file}`));
      }
    }, 30);
  });
}
