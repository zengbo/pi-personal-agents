import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const childScript = fileURLToPath(new URL("./crash-child.ts", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pi-durable 1.1.0 crash recovery", () => {
  it("does not replay an unsafe tool and keeps the request id", async () => {
    const report = await crashAndRecover("unsafe");
    expect(report.runs).toBe(1);
    expect(report.status).toBe("done");
    expect(report.answer).toBe("recovered");
    expect(report.submissionId).toBe(report.originalSubmissionId);
    expect(report.diagnostics.some((item) => item.code === "interrupted")).toBe(true);
    expect(report.diagnostics.some((item) => item.message.includes("was interrupted"))).toBe(true);
  });

  it("replays a tool only when replay is safe", async () => {
    const report = await crashAndRecover("safe");
    expect(report.runs).toBe(2);
    expect(report.status).toBe("done");
    expect(report.answer).toBe("recovered");
    expect(report.submissionId).toBe(report.originalSubmissionId);
    expect(report.diagnostics.some((item) => item.code === "interrupted")).toBe(false);
  });
});

interface Diagnostic {
  code?: string;
  message: string;
}

interface Report {
  originalSubmissionId: string;
  submissionId: string;
  runs: number;
  status: string;
  answer: string;
  diagnostics: Diagnostic[];
}

async function crashAndRecover(replay: "safe" | "unsafe"): Promise<Report> {
  const dir = mkdtempSync(path.join(tmpdir(), "ppa-crash-"));
  directories.push(dir);
  const databasePath = path.join(dir, "session.sqlite");
  const markerPath = path.join(dir, "marker");
  const runsPath = path.join(dir, "runs.log");
  const submissionPath = path.join(dir, "submission");

  const crash = spawnChild(["crash", replay, markerPath, runsPath, submissionPath], databasePath, {
    PPA_CRASH: "1",
  });
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

  const recover = spawnChild(["recover", replay, markerPath, runsPath, submissionPath], databasePath, {});
  const recoverResult = await recover.done;
  if (recoverResult.code !== 0) {
    throw new Error(`recover exited ${recoverResult.code}\n${recoverResult.stderr}`);
  }
  const parsed = JSON.parse(recoverResult.stdout) as {
    submissionId: string;
    runs: number;
    status: string;
    answer: string;
    diagnostics: Diagnostic[];
  };
  return {
    originalSubmissionId: readFileSync(submissionPath, "utf8").trim(),
    ...parsed,
  };
}

function spawnChild(
  args: string[],
  databasePath: string,
  extraEnv: Record<string, string>,
): {
  child: ReturnType<typeof spawn>;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  stderr: Promise<string>;
} {
  const child = spawn(process.execPath, ["--experimental-strip-types", childScript, databasePath, ...args], {
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
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
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
