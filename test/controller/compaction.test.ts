import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DEFAULT_COMPACTION_POLICY, type Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { BotName } from "../../src/bots/extensions.ts";
import { controllerCompaction } from "../../src/controller/runtime.ts";
import { startTestRig, type TestRig } from "./fixture.ts";
import { openTestSocket, waitForText } from "./http.ts";

const childScript = fileURLToPath(new URL("./compact-child.ts", import.meta.url));
const directories: string[] = [];
const rigs: TestRig[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
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

  it("keeps a tool call and its result paired when compaction runs before the result is recorded", async () => {
    const ops = smallWindowFaux(80_000);
    let opsHarness: Harness | undefined;
    let summarizedDuringExec = false;
    let summarizerOrphan = false;
    let summarizerSawInflight = false;
    let summarizerSawEarly = false;
    const after = { orphan: true, sawCall: false, sawResult: false, sawSummary: false, sawMissing: true };
    const factory = requeueFactory(ops, (context) => {
      const messages = context.messages;
      const blob = JSON.stringify(messages);
      if (blob.includes("context summarization assistant")) {
        summarizedDuringExec = true;
        summarizerOrphan = hasOrphanToolResult(messages);
        summarizerSawInflight = blob.includes("inflight-tool");
        summarizerSawEarly = blob.includes("early-tool");
        return fauxAssistantMessage("## Goal\nsummary-keeps-harbor");
      }
      if (!blob.includes("early-tool")) {
        return fauxAssistantMessage(fauxToolCall("exec", { command: "early-tool" }, { id: "call-early" }), { stopReason: "toolUse" });
      }
      if (!blob.includes("BULK-harbor-token")) {
        return fauxAssistantMessage("early-done");
      }
      if (!blob.includes("please start inflight-tool")) {
        return fauxAssistantMessage("ack-turn");
      }
      if (!blob.includes("call-inflight")) {
        return fauxAssistantMessage(fauxToolCall("exec", { command: "inflight-tool" }, { id: "call-inflight" }), { stopReason: "toolUse" });
      }
      after.orphan = hasOrphanToolResult(messages);
      after.sawCall = blob.includes("call-inflight");
      after.sawResult = resultTextFor(messages, "call-inflight").includes("exit 0");
      after.sawSummary = blob.includes("summary-keeps-harbor");
      after.sawMissing = blob.includes("Tool result unavailable");
      return fauxAssistantMessage("after-pair");
    });
    const rig = await startTestRig({
      faux: opsMap(ops),
      compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200, backgroundTokens: 0 },
      onHarness: (bot, harness) => {
        if (bot === "ops") {
          opsHarness = harness;
        }
      },
      prepare: (models) => {
        models.get("ops")?.setResponses([factory]);
      },
      exec: async (_runtime, _id, command) => {
        const text = typeof command === "string" ? command : command.join(" ");
        if (text.includes("inflight-tool")) {
          const harness = opsHarness;
          if (harness === undefined) {
            throw new Error("ops harness missing");
          }
          const conversation = await harness.root(BACKGROUND_CONTEXT);
          const taskId = await conversation.compact(undefined, BACKGROUND_CONTEXT);
          await waitTerminal(harness, taskId);
          if (!summarizedDuringExec) {
            throw new Error("summarizer did not run before the tool result was recorded");
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    rigs.push(rig);
    ops.setResponses([factory]);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    await rig.controller.submit("ops", "root", "run the early tool", "pair-early");
    await waitForText(socket, "early-done");
    await rig.controller.submit("ops", "root", longText("BULK-harbor-token"), "pair-bulk");
    await waitForText(socket, "ack-turn");
    await rig.controller.submit("ops", "root", "please start inflight-tool", "pair-inflight");
    const view = await waitForText(socket, "after-pair");
    socket.close();
    expect(summarizedDuringExec).toBe(true);
    expect(summarizerOrphan).toBe(false);
    expect(summarizerSawEarly).toBe(true);
    expect(summarizerSawInflight).toBe(false);
    expect(after.orphan).toBe(false);
    expect(after.sawCall).toBe(true);
    expect(after.sawResult).toBe(true);
    expect(after.sawSummary).toBe(true);
    expect(after.sawMissing).toBe(false);
    expect(view).toContain("summary-keeps-harbor");
    expect(view).toContain("exit 0");
  }, 60_000);

  it("does not ask again or rerun git_push after approval, compaction, and a crash", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-compact-push-"));
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
    const build = spawnChild(["push-build"], { ...shared, PPA_CRASH: "1" });
    try {
      await waitForFile(markerPath, 40_000);
    } catch (error) {
      build.child.kill("SIGKILL");
      const stderr = await build.stderr;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`, { cause: error });
    }
    build.child.kill("SIGKILL");
    const crashed = await build.done;
    expect(crashed.code).not.toBe(0);
    const recover = spawnChild(["push-recover"], shared);
    const recoverResult = await recover.done;
    if (recoverResult.code !== 0) {
      throw new Error(`recover exited ${recoverResult.code}\n${recoverResult.stderr}`);
    }
    const report = JSON.parse(recoverResult.stdout) as {
      runs: number;
      pushes: number;
      pending: number;
      keptSummary: boolean;
      memo: boolean;
    };
    expect(report.runs).toBe(1);
    expect(report.pushes).toBe(1);
    expect(report.pending).toBe(0);
    expect(report.keptSummary).toBe(true);
    expect(report.memo).toBe(true);
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

function smallWindowFaux(contextWindow: number) {
  return fauxProvider({
    api: "faux",
    provider: "faux",
    models: [
      {
        id: "faux-1",
        contextWindow,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}

function opsMap(ops: ReturnType<typeof fauxProvider>): Map<BotName, ReturnType<typeof fauxProvider>> {
  const faux = new Map<BotName, ReturnType<typeof fauxProvider>>();
  faux.set("chief", fauxProvider({ api: "faux", provider: "faux" }));
  faux.set("researcher", fauxProvider({ api: "faux", provider: "faux" }));
  faux.set("ops", ops);
  return faux;
}

function requeueFactory(
  ops: ReturnType<typeof fauxProvider>,
  respond: FauxResponseFactory,
): FauxResponseFactory {
  const factory: FauxResponseFactory = (context, options, state, model) => {
    ops.appendResponses([factory]);
    return respond(context, options, state, model);
  };
  return factory;
}

function hasOrphanToolResult(messages: readonly { role?: string; content?: unknown; toolCallId?: string }[]): boolean {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isToolCall(part)) {
          calls.add(part.id);
        }
      }
    }
    if (message.role === "toolResult" && (message.toolCallId === undefined || !calls.has(message.toolCallId))) {
      return true;
    }
  }
  return false;
}

function resultTextFor(messages: readonly { role?: string; content?: unknown; toolCallId?: string }[], callId: string): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolCallId !== callId || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

function isToolCall(part: unknown): part is { id: string } {
  return typeof part === "object" && part !== null && "type" in part && part.type === "toolCall" && "id" in part && typeof part.id === "string";
}

async function waitTerminal(harness: Harness, taskId: Awaited<ReturnType<Awaited<ReturnType<Harness["root"]>>["compact"]>>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await harness.getTask(taskId, BACKGROUND_CONTEXT);
    if (task?.state.status === "terminal") {
      if (task.state.outcome.status !== "completed") {
        throw new Error(`compaction ended ${task.state.outcome.status}`);
      }
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("compaction did not finish");
}

function longText(marker: string): string {
  return `${marker}\n${"word ".repeat(8000)}`;
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
