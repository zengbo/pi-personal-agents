import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const childScript = fileURLToPath(new URL("./kill-child.ts", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("controller kill -9", () => {
  it("resumes the conversation and does not replay a sandbox exec", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-kill-"));
    directories.push(root);
    const execLog = path.join(root, "exec.log");
    const markerPath = path.join(root, "marker");
    const submissionPath = path.join(root, "submission");
    const shared = {
      PPA_ROOT: root,
      PPA_EXEC_LOG: execLog,
      PPA_MARKER: markerPath,
      PPA_SUBMISSION: submissionPath,
    };
    const crash = spawnChild(["crash"], { ...shared, PPA_CRASH: "1" });
    try {
      await waitForFile(markerPath, 20_000);
      await waitForFile(submissionPath, 5_000);
    } catch (error) {
      crash.child.kill("SIGKILL");
      const stderr = await crash.stderr;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`, { cause: error });
    }
    crash.child.kill("SIGKILL");
    const crashResult = await crash.done;
    expect(crashResult.code).not.toBe(0);
    const recover = spawnChild(["recover"], shared);
    const recoverResult = await recover.done;
    if (recoverResult.code !== 0) {
      throw new Error(`recover exited ${recoverResult.code}\n${recoverResult.stderr}`);
    }
    const report = JSON.parse(recoverResult.stdout) as { submissionId: string; runs: number; text: string };
    expect(report.submissionId).toBe(readFileSync(submissionPath, "utf8").trim());
    expect(report.runs).toBe(1);
    expect(report.text).toContain("recovered");
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

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
