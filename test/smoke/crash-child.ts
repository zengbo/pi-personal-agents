/**
 * Child process for the crash-recovery smoke test.
 * `crash` mode runs a tool and hangs so the parent can SIGKILL it.
 * `recover` mode reopens the same SQLite file and resumes.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const context = BACKGROUND_CONTEXT;
const databasePath = requiredArg(2);
const mode = requiredArg(3);
const replayArg = requiredArg(4);
const markerPath = requiredArg(5);
const runsPath = requiredArg(6);
const submissionPath = requiredArg(7);
const replay = replayArg === "safe" ? "safe" : "unsafe";

const touch = defineTool({
  name: "touch",
  description: "Record that this execution started",
  parameters: Type.Object({}),
  replay,
  execute: async () => {
    appendFileSync(runsPath, "run\n");
    if (process.env.PPA_CRASH === "1") {
      writeFileSync(markerPath, "started\n");
      await new Promise(() => {});
    }
    return { content: [{ type: "text", text: "finished" }] };
  },
});

const faux = fauxProvider({ api: "faux", provider: "faux" });
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: "smoke", tools: [touch] }));

let hanging = false;
const harness = await Harness.open(
  await openNodeSqliteStorage(databasePath),
  {
    models,
    registry,
    settings: {
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    },
  },
  context,
);

try {
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  if (mode === "crash") {
    faux.setResponses([fauxAssistantMessage(fauxToolCall("touch", {}), { stopReason: "toolUse" })]);
    const submission = await root.submit({ type: "input", content: "go", requestId: "smoke-1" }, context);
    writeFileSync(submissionPath, `${submission.id}\n`);
    hanging = true;
    await new Promise(() => {});
  } else if (mode === "recover") {
    faux.setResponses([fauxAssistantMessage("recovered")]);
    harness.resume();
    const again = await root.submit({ type: "input", content: "go", requestId: "smoke-1" }, context);
    const settled = await again.wait(context);
    const page = await root.entries({ order: "ascending" }, 40, undefined, context);
    const diagnostics: { code?: string; message: string }[] = [];
    for (const entry of page.items) {
      if (!ToolResultEntry.is(entry)) {
        continue;
      }
      for (const diagnostic of entry.data.diagnostics) {
        const item: { code?: string; message: string } = { message: diagnostic.message };
        if (diagnostic.code !== undefined) {
          item.code = diagnostic.code;
        }
        diagnostics.push(item);
      }
    }
    let answer = "";
    if (settled.status === "done" && settled.type === "input") {
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      answer = assistantText(entry?.model?.[0]);
    }
    const runs = readFileSync(runsPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0).length;
    process.stdout.write(
      `${JSON.stringify({
        submissionId: String(again.id),
        runs,
        status: settled.status,
        reason: settled.status === "unanswered" ? settled.reason : undefined,
        answer,
        diagnostics,
      })}\n`,
    );
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  if (!hanging) {
    await harness.close(context);
  }
}

function requiredArg(index: number): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing argv ${index}`);
  }
  return value;
}

function assistantText(message: Message | undefined): string {
  if (message === undefined || message.role !== "assistant") {
    return "";
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
