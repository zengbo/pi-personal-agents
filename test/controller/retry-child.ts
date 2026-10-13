/**
 * Child process for a crash during model-call backoff.
 * `backoff` runs one exec, then a retryable model error, and hangs in the durable sleep.
 * `recover` reopens the same database and must not run that exec again.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, Harness } from "@earendil-works/pi-durable";
import { BOTS, type BotName } from "../../src/bots/extensions.ts";
import { startTestRig } from "./fixture.ts";
import { openTestSocket, waitForText } from "./http.ts";

const mode = process.argv[2];
const root = requiredEnv("PPA_ROOT");
const execLog = requiredEnv("PPA_EXEC_LOG");
const markerPath = requiredEnv("PPA_MARKER");
const backoffMs = 15_000;

let opsHarness: Harness | undefined;

try {
  const rig = await startWhenUnlocked();
  if (mode === "backoff") {
    const harness = opsHarness;
    if (harness === undefined) {
      throw new Error("ops harness missing");
    }
    // root() applies agent only when the conversation is created. Submit later calls root() again and would leave the model unset.
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    watch.start(async (value) => {
      const at = retryAt(value);
      if (at !== undefined) {
        writeMarker(at);
      }
    });
    await rig.controller.submit("ops", "root", "run once", "retry-backoff");
    await new Promise(() => undefined);
  } else if (mode === "recover") {
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    const view = await waitForText(socket, "recovered-after-backoff", 25_000);
    socket.close();
    const runs = readFileSync(execLog, "utf8").split("\n").filter((line) => line.length > 0).length;
    process.stdout.write(`${JSON.stringify({ runs, continued: view.includes("recovered-after-backoff") })}\n`);
    await rig.close();
  } else {
    throw new Error(`unknown mode ${mode ?? ""}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function writeMarker(at: number): void {
  try {
    readFileSync(markerPath);
  } catch {
    appendFileSync(markerPath, `${at}\n`);
  }
}

function retryAt(view: ConversationView): number | undefined {
  const live = view.docs["pi.live"];
  if (live === undefined) {
    return undefined;
  }
  const generation = live["generation"];
  if (typeof generation !== "object" || generation === null || Array.isArray(generation)) {
    return undefined;
  }
  const retry = generation["retry"];
  if (typeof retry !== "object" || retry === null || Array.isArray(retry)) {
    return undefined;
  }
  const at = retry["at"];
  return typeof at === "number" ? at : undefined;
}

async function startWhenUnlocked() {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const ops = fauxProvider({ api: "faux", provider: "faux" });
      const faux = new Map<BotName, ReturnType<typeof fauxProvider>>();
      for (const bot of BOTS) {
        faux.set(bot, bot === "ops" ? ops : fauxProvider({ api: "faux", provider: "faux" }));
      }
      return await startTestRig({
        root,
        faux,
        retry: { baseDelayMs: backoffMs, maxAgentDelayMs: backoffMs },
        onHarness: (bot, harness) => {
          if (bot === "ops") {
            opsHarness = harness;
          }
        },
        prepare: (models) => {
          const provider = models.get("ops");
          if (provider === undefined) {
            throw new Error("ops");
          }
          if (mode === "recover") {
            provider.setResponses([fauxAssistantMessage("recovered-after-backoff")]);
            return;
          }
          provider.setResponses([
            fauxAssistantMessage(fauxToolCall("exec", { command: "retry-touch" }), { stopReason: "toolUse" }),
            fauxAssistantMessage("503 overloaded", { stopReason: "error", errorMessage: "503 overloaded" }),
          ]);
        },
        exec: async (_runtime, _id, command) => {
          const text = typeof command === "string" ? command : command.join(" ");
          if (text.includes("retry-touch")) {
            appendFileSync(execLog, "run\n");
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}
