import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { DEFAULT_RETRY_POLICY, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { controllerRetry } from "../../src/controller/runtime.ts";
import { startTestRig, type TestRig } from "./fixture.ts";
import { httpCall, openTestSocket, waitForText } from "./http.ts";

const childScript = fileURLToPath(new URL("./retry-child.ts", import.meta.url));
const rigs: TestRig[] = [];
const directories: string[] = [];
const fastRetry = { baseDelayMs: 20, maxAgentDelayMs: 1000 };

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("model call retry", () => {
  it("uses pi-durable's built-in retry policy", () => {
    expect(controllerRetry()).toEqual(DEFAULT_RETRY_POLICY);
    expect(controllerRetry().enabled).toBe(true);
    expect(controllerRetry().maxRetries).toBe(3);
    expect(retryDelayMs(controllerRetry(), 1)).toBe(2000);
    expect(retryDelayMs(controllerRetry(), 2)).toBe(4000);
    expect(retryDelayMs(controllerRetry(), 3)).toBe(8000);
    expect(retryDelayMs(controllerRetry(), 10)).toBe(60_000);
    expect(isRetryableAssistantError(modelError("503 overloaded"))).toBe(true);
    expect(isRetryableAssistantError(modelError("429 too many requests"))).toBe(true);
    expect(isRetryableAssistantError(modelError("network error"))).toBe(true);
    expect(isRetryableAssistantError(modelError("400 validation failed"))).toBe(false);
    expect(isRetryableAssistantError(modelError("401 invalid api key"))).toBe(false);
    expect(isRetryableAssistantError(modelError("429 insufficient_quota"))).toBe(false);
  });

  it("retries a transient failure and then succeeds", async () => {
    const { rig, harness } = await openRig();
    const ops = required(rig, "ops");
    const marks: number[] = [];
    const stamp = (message: ReturnType<typeof fauxAssistantMessage>) => () => {
      marks.push(Date.now());
      return message;
    };
    ops.setResponses([
      stamp(modelError("503 overloaded")),
      stamp(modelError("503 overloaded")),
      stamp(fauxAssistantMessage("retry-ok")),
    ]);
    const submitted = await rig.controller.submit("ops", "root", "try again", "retry-transient");
    const settled = await settle(harness, submitted.submissionId);
    expect(settled.status).toBe("done");
    expect(ops.state.callCount).toBe(3);
    expect(marks).toHaveLength(3);
    expect((marks[1] ?? 0) - (marks[0] ?? 0)).toBeGreaterThanOrEqual(retryDelayMs(fastRetry, 1) - 5);
    expect((marks[2] ?? 0) - (marks[1] ?? 0)).toBeGreaterThanOrEqual(retryDelayMs(fastRetry, 2) - 5);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    expect(await waitForText(socket, "retry-ok")).toContain("retry-ok");
    socket.close();
  });

  it("fails fast on an auth or validation error", async () => {
    const { rig, harness } = await openRig();
    const ops = required(rig, "ops");
    ops.setResponses([modelError("401 invalid api key")]);
    const auth = await rig.controller.submit("ops", "root", "auth", "retry-auth");
    const authSettled = await settle(harness, auth.submissionId);
    expect(authSettled.status).toBe("unanswered");
    if (authSettled.status === "unanswered") {
      expect(authSettled.reason).toBe("model_error");
      expect(authSettled.detail).toBe("401 invalid api key");
    }
    expect(ops.state.callCount).toBe(1);
    ops.setResponses([modelError("400 validation failed")]);
    const invalid = await rig.controller.submit("ops", "root", "validate", "retry-validation");
    const invalidSettled = await settle(harness, invalid.submissionId);
    expect(invalidSettled.status).toBe("unanswered");
    if (invalidSettled.status === "unanswered") {
      expect(invalidSettled.detail).toBe("400 validation failed");
    }
    expect(ops.state.callCount).toBe(2);
  });

  it("surfaces the provider error when retries are exhausted", async () => {
    const { rig, harness } = await openRig();
    const ops = required(rig, "ops");
    ops.setResponses([
      modelError("503 overloaded"),
      modelError("503 overloaded"),
      modelError("503 overloaded"),
      modelError("503 overloaded"),
    ]);
    const submitted = await rig.controller.submit("ops", "root", "give up", "retry-exhausted");
    const settled = await settle(harness, submitted.submissionId);
    expect(settled.status).toBe("unanswered");
    if (settled.status === "unanswered") {
      expect(settled.reason).toBe("model_error");
      expect(settled.detail).toBe("503 overloaded");
    }
    expect(ops.state.callCount).toBe(4);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    expect(await waitForText(socket, "503 overloaded")).toContain("503 overloaded");
    socket.close();
  });

  it("does not re-run a tool or ask for approval again when the next model call is retried", async () => {
    const { rig, harness } = await openRig();
    const ops = required(rig, "ops");
    ops.setResponses([
      fauxAssistantMessage(fauxToolCall("exec", { command: "printf once" }), { stopReason: "toolUse" }),
      modelError("429 too many requests"),
      fauxAssistantMessage("after-exec-retry"),
    ]);
    const execSubmit = await rig.controller.submit("ops", "root", "run it", "retry-exec");
    const execSettled = await settle(harness, execSubmit.submissionId);
    expect(execSettled.status).toBe("done");
    expect(ops.state.callCount).toBe(3);
    expect(rig.podman.execs.filter((entry) => entry.command === "printf once")).toHaveLength(1);
    ops.setResponses([
      fauxAssistantMessage(fauxToolCall("git_push", { target: "origin" }), { stopReason: "toolUse" }),
      modelError("503 overloaded"),
      fauxAssistantMessage("after-push-retry"),
    ]);
    const callsBeforePush = ops.state.callCount;
    const pushSubmit = await rig.controller.submit("ops", "root", "push it", "retry-push");
    const pending = await pollApprovals(rig.controller.port, rig.token);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool).toBe("git_push");
    const allowed = await httpCall(rig.controller.port, "POST", `/api/approvals/${pending[0]?.id}`, {
      token: rig.token,
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(allowed.status).toBe(200);
    const pushSettled = await settle(harness, pushSubmit.submissionId);
    expect(pushSettled.status).toBe("done");
    expect(ops.state.callCount - callsBeforePush).toBe(3);
    expect(rig.engine.listPending()).toHaveLength(0);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    const view = await waitForText(socket, "after-push-retry");
    expect(view.split("git_push origin").length - 1).toBe(1);
    socket.close();
  });

  it("recovers a crash during backoff without running the tool again", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-retry-crash-"));
    directories.push(root);
    const execLog = path.join(root, "exec.log");
    const markerPath = path.join(root, "marker");
    const shared = { PPA_ROOT: root, PPA_EXEC_LOG: execLog, PPA_MARKER: markerPath };
    const build = spawnChild(["backoff"], shared);
    try {
      await waitForFile(markerPath, 20_000);
    } catch (error) {
      build.child.kill("SIGKILL");
      const stderr = await build.stderr;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`, { cause: error });
    }
    const until = Number(readFileSync(markerPath, "utf8").trim());
    expect(until).toBeGreaterThan(Date.now());
    build.child.kill("SIGKILL");
    const crashed = await build.done;
    expect(crashed.code).not.toBe(0);
    const recover = spawnChild(["recover"], shared);
    const recoverResult = await recover.done;
    if (recoverResult.code !== 0) {
      throw new Error(`recover exited ${recoverResult.code}\n${recoverResult.stderr}`);
    }
    const report = JSON.parse(recoverResult.stdout) as { runs: number; continued: boolean };
    expect(report.runs).toBe(1);
    expect(report.continued).toBe(true);
    expect(readFileSync(execLog, "utf8").split("\n").filter((line) => line.length > 0)).toHaveLength(1);
  }, 40_000);
});

function modelError(errorMessage: string) {
  return fauxAssistantMessage(errorMessage, { stopReason: "error", errorMessage });
}

async function openRig(): Promise<{ rig: TestRig; harness: Harness }> {
  let harness: Harness | undefined;
  const rig = await startTestRig({
    retry: fastRetry,
    onHarness: (bot, opened) => {
      if (bot === "ops") {
        harness = opened;
      }
    },
  });
  rigs.push(rig);
  if (harness === undefined) {
    throw new Error("ops harness missing");
  }
  return { rig, harness };
}

function required(rig: TestRig, bot: "chief" | "researcher" | "ops") {
  const faux = rig.faux.get(bot);
  if (faux === undefined) {
    throw new Error(bot);
  }
  return faux;
}

async function settle(harness: Harness, submissionId: string) {
  const submission = await harness.submission(Number(submissionId) as SubmissionId, BACKGROUND_CONTEXT);
  if (submission === undefined) {
    throw new Error("missing submission");
  }
  return submission.wait(BACKGROUND_CONTEXT);
}

async function pollApprovals(port: number, token: string): Promise<{ id: string; tool: string }[]> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const response = await httpCall(port, "GET", "/api/approvals", { token });
    const body = JSON.parse(response.body) as { items: { id: string; tool: string }[] };
    if (body.items.length > 0) {
      return body.items;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
  }
  throw new Error("no approval card");
}

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

function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      try {
        readFileSync(file);
        resolve();
      } catch (error) {
        if (Date.now() - started > timeoutMs) {
          reject(error);
          return;
        }
        setTimeout(tick, 30);
      }
    };
    tick();
  });
}
