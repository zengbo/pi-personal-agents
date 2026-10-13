/**
 * Child process for compaction crash recovery.
 * `build` grows a long ops conversation until pi-durable compacts it, then hangs in exec.
 * `recover` reopens the same database and must not run that exec again.
 */
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { CompactionPolicy, Harness } from "@earendil-works/pi-durable";
import { BOTS, type BotName } from "../../src/bots/extensions.ts";
import { startTestRig } from "./fixture.ts";
import { httpCall, openTestSocket, waitForText } from "./http.ts";

const mode = process.argv[2];
const root = requiredEnv("PPA_ROOT");
const execLog = requiredEnv("PPA_EXEC_LOG");
const markerPath = requiredEnv("PPA_MARKER");
const seenPath = requiredEnv("PPA_SEEN");

const compaction: CompactionPolicy = {
  enabled: true,
  reserveTokens: 1000,
  keepRecentTokens: 800,
  backgroundTokens: 0,
};

let phase: "chat" | "push" | "settled" | "exec" | "recover" = mode === "recover" || mode === "push-recover" ? "recover" : "chat";
let opsHarness: Harness | undefined;
let summarizedAfterApproval = false;

try {
  const rig = await startWhenUnlocked();
  if (mode === "build") {
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    await rig.controller.submit("ops", "root", longText("BULK-harbor-token"), "compact-bulk");
    await waitForText(socket, "ack-turn", 20_000);
    await rig.controller.submit("ops", "root", longText("TAIL-marker"), "compact-tail");
    await waitForText(socket, "summary-keeps-harbor", 20_000);
    const seen = await readSeen();
    if (!seen.sawSummary || seen.sawBulk || !seen.sawTrust) {
      throw new Error(`compaction context ${JSON.stringify(seen)}`);
    }
    phase = "exec";
    await rig.controller.submit("ops", "root", "run the tests", "compact-exec");
    await new Promise(() => {});
  } else if (mode === "push-build") {
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    await rig.controller.submit("ops", "root", "hello", "compact-hello");
    await waitForText(socket, "ack-early", 20_000);
    await rig.controller.submit("ops", "root", longText("BULK-harbor-token"), "compact-bulk");
    await waitForText(socket, "ack-bulk", 20_000);
    phase = "push";
    await rig.controller.submit("ops", "root", "push the branch", "compact-push");
    const pending = await pollApprovals(rig.controller.port, rig.token);
    phase = "settled";
    const decided = await httpCall(rig.controller.port, "POST", `/api/approvals/${pending[0]?.id ?? ""}`, {
      token: rig.token,
      body: JSON.stringify({ decision: "allow_once" }),
    });
    if (decided.status !== 200) {
      throw new Error(`approval failed ${decided.status}`);
    }
    const settled = await waitForText(socket, "push-settled", 20_000);
    if (!settled.includes("git_push origin")) {
      throw new Error("git_push did not execute after approval");
    }
    const harness = opsHarness;
    if (harness === undefined) {
      throw new Error("ops harness missing");
    }
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    const taskId = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    await waitTerminal(harness, taskId);
    if (!summarizedAfterApproval) {
      throw new Error("compaction did not summarize after approval");
    }
    phase = "exec";
    await rig.controller.submit("ops", "root", "run the tests", "compact-exec");
    await new Promise(() => {});
  } else if (mode === "recover" || mode === "push-recover") {
    const submitted = await rig.controller.submit("ops", "root", "run the tests", "compact-exec");
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    const text = await waitForText(socket, "recovered-after-compact", 20_000);
    await rig.controller.submit("ops", "root", "continue after recovery", "compact-after");
    const continued = await waitForText(socket, "continued-after-compact", 20_000);
    socket.close();
    const runs = readFileSync(execLog, "utf8")
      .split("\n")
      .filter((line) => line.length > 0).length;
    const approvals = JSON.parse(
      (await httpCall(rig.controller.port, "GET", "/api/approvals", { token: rig.token })).body,
    ) as { items: unknown[] };
    process.stdout.write(
      `${JSON.stringify({
        submissionId: submitted.submissionId,
        runs,
        pushes: countOf(continued, "git_push origin"),
        pending: approvals.items.length,
        memo: directoryHas(path.join(root, "data"), "approved"),
        keptSummary: text.includes("summary-keeps-harbor") && continued.includes("summary-keeps-harbor"),
        continued: continued.includes("continued-after-compact"),
      })}\n`,
    );
    await rig.close();
  } else {
    throw new Error(`unknown mode ${mode ?? ""}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}

function respond(requeue: () => void): FauxResponseFactory {
  return (context) => {
    // streamSimple and completeSimple share one queue and consume each factory once.
    requeue();
    const blob = JSON.stringify(context.messages);
    if (blob.includes("context summarization assistant")) {
      if (phase === "settled") {
        summarizedAfterApproval = true;
      }
      return fauxAssistantMessage("## Goal\nsummary-keeps-harbor");
    }
    if (blob.includes("summary-keeps-harbor") && blob.includes("TAIL-marker")) {
      writeFileSync(
        seenPath,
        `${JSON.stringify({
          sawSummary: true,
          sawBulk: blob.includes("BULK-harbor-token"),
          sawTrust: blob.includes("Only an authenticated user can approve a tool"),
        })}\n`,
      );
    }
    if (phase === "push") {
      return fauxAssistantMessage(fauxToolCall("git_push", { target: "origin" }), { stopReason: "toolUse" });
    }
    if (phase === "settled") {
      return fauxAssistantMessage("push-settled");
    }
    if (phase === "chat" && mode === "push-build") {
      if (!blob.includes("BULK-harbor-token")) {
        return fauxAssistantMessage("ack-early");
      }
      return fauxAssistantMessage("ack-bulk");
    }
    if (phase === "exec") {
      return fauxAssistantMessage(fauxToolCall("exec", { command: "true" }), { stopReason: "toolUse" });
    }
    if (phase === "recover") {
      if (blob.includes("continue after recovery")) {
        return fauxAssistantMessage("continued-after-compact");
      }
      return fauxAssistantMessage("recovered-after-compact");
    }
    return fauxAssistantMessage("ack-turn");
  };
}

async function startWhenUnlocked() {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const ops = fauxProvider({
        api: "faux",
        provider: "faux",
        models: [
          {
            id: "faux-1",
            contextWindow: mode === "push-build" || mode === "push-recover" ? 80_000 : 20_000,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      const faux = new Map<BotName, ReturnType<typeof fauxProvider>>();
      for (const bot of BOTS) {
        faux.set(bot, bot === "ops" ? ops : fauxProvider({ api: "faux", provider: "faux" }));
      }
      return await startTestRig({
        root,
        faux,
        compaction,
        onHarness: (bot, harness) => {
          if (bot === "ops") {
            opsHarness = harness;
          }
        },
        prepare: (models) => {
          const ops = models.get("ops");
          if (ops === undefined) {
            throw new Error("ops");
          }
          const next = respond(() => {
            ops.appendResponses([next]);
          });
          ops.setResponses([next]);
        },
        exec: async () => {
          appendFileSync(execLog, "exec\n");
          if (process.env.PPA_CRASH === "1") {
            writeFileSync(markerPath, "exec\n");
            await new Promise(() => {});
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/lock|busy|SQLITE_BUSY/.test(message)) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
  throw last;
}

async function readSeen(): Promise<{ sawSummary: boolean; sawBulk: boolean; sawTrust: boolean }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return JSON.parse(readFileSync(seenPath, "utf8")) as { sawSummary: boolean; sawBulk: boolean; sawTrust: boolean };
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }
  throw new Error("compaction did not record the following request");
}

function longText(marker: string): string {
  return `${marker}\n${"word ".repeat(8000)}`;
}

async function pollApprovals(port: number, token: string): Promise<{ id: string; tool: string }[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await httpCall(port, "GET", "/api/approvals", { token });
    const body = JSON.parse(response.body) as { items: { id: string; tool: string }[] };
    if (body.items.length > 0) {
      return body.items;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
  }
  throw new Error("no approval");
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

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function directoryHas(dir: string, needle: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      if (readFileSync(full).includes(needle)) {
        return true;
      }
    } catch {
      // Skip directories and unreadable files.
    }
  }
  return false;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}
