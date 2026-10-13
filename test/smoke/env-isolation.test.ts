import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context: Context = BACKGROUND_CONTEXT;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isolatedEnv(id: string, cwd: string): ExecutionEnv {
  const inner = new NodeExecutionEnv({ cwd });
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "id") {
        return id;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as ExecutionEnv;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

describe("pi-durable 1.1.0 env isolation", () => {
  it("gives each conversation its own env id and files", async () => {
    const rootDir = await tempDir("ppa-env-");
    const dirA = path.join(rootDir, "a");
    const dirB = path.join(rootDir, "b");
    await Promise.all([
      import("node:fs/promises").then((fs) => fs.mkdir(dirA)),
      import("node:fs/promises").then((fs) => fs.mkdir(dirB)),
    ]);

    const seen: { conversationId: string; cwd: string; envId: string }[] = [];
    const stamp = defineTool({
      name: "stamp",
      description: "Write this environment id into stamp.txt",
      parameters: Type.Object({}),
      replay: "unsafe",
      execute: async (_args, api, toolContext) => {
        const env = api.env;
        if (env === undefined) {
          throw new Error("missing env");
        }
        const written = await env.writeFile("stamp.txt", env.id, toolContext);
        if (!written.ok) {
          throw new Error(written.error.message);
        }
        return { content: [{ type: "text", text: env.id }] };
      },
    });

    const faux = fauxProvider({ api: "faux", provider: "faux" });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "stamp", tools: [stamp] }));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("stamp", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("stamp", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done-a"),
      fauxAssistantMessage(fauxToolCall("stamp", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done-b"),
    ]);

    const harness = await Harness.open(
      await openNodeSqliteStorage(path.join(rootDir, "session.sqlite")),
      {
        models,
        registry,
        settings: {
          compaction: { enabled: false },
          retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        },
        env: ({ conversationId, cwd }) => {
          if (cwd === undefined) {
            throw new Error(`conversation ${conversationId} has no cwd`);
          }
          const env = isolatedEnv(`env:${String(conversationId)}`, cwd);
          seen.push({ conversationId: String(conversationId), cwd, envId: env.id });
          return env;
        },
      },
      context,
    );

    try {
      const alpha = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: dirA },
      });
      const beta = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: dirB },
        },
        context,
      );

      const first = await alpha.submit({ type: "input", content: "stamp twice", requestId: "alpha" }, context);
      expect((await first.wait(context)).status).toBe("done");
      const second = await beta.submit({ type: "input", content: "stamp once", requestId: "beta" }, context);
      expect((await second.wait(context)).status).toBe("done");

      const stampA = await readFile(path.join(dirA, "stamp.txt"), "utf8");
      const stampB = await readFile(path.join(dirB, "stamp.txt"), "utf8");
      expect(stampA).toBe(`env:${alpha.id}`);
      expect(stampB).toBe(`env:${beta.id}`);
      expect(stampA).not.toBe(stampB);

      const seenA = seen.filter((call) => call.conversationId === String(alpha.id));
      const seenB = seen.filter((call) => call.conversationId === String(beta.id));
      expect(seenA.length).toBeGreaterThan(0);
      expect(seenB.length).toBeGreaterThan(0);
      expect(new Set(seenA.map((call) => call.envId))).toEqual(new Set([`env:${alpha.id}`]));
      expect(new Set(seenB.map((call) => call.envId))).toEqual(new Set([`env:${beta.id}`]));
      expect(seenA.every((call) => call.cwd === dirA)).toBe(true);
      expect(seenB.every((call) => call.cwd === dirB)).toBe(true);
    } finally {
      await harness.close(context);
    }
  });

  it("keeps two harness loops from seeing each other's files", async () => {
    const [left, right] = await Promise.all([runLoop("left"), runLoop("right")]);
    // Each storage's root conversation id is 1, so isolation is the directory, not that id.
    expect(left.conversationId).toBe(right.conversationId);
    expect(left.dir).not.toBe(right.dir);
    expect(left.text).toContain("loop:left");
    expect(right.text).toContain("loop:right");
    expect(left.text).not.toContain("loop:right");
    expect(right.text).not.toContain("loop:left");
  });
});

async function runLoop(name: string): Promise<{ dir: string; conversationId: string; text: string }> {
  const dir = await tempDir(`ppa-loop-${name}-`);
  const work = path.join(dir, "work");
  await import("node:fs/promises").then((fs) => fs.mkdir(work));
  const stamp = defineTool({
    name: "stamp",
    description: "Write this environment id into stamp.txt",
    parameters: Type.Object({}),
    replay: "unsafe",
    execute: async (_args, api, toolContext) => {
      const env = api.env;
      if (env === undefined) {
        throw new Error("missing env");
      }
      const body = `loop:${name}\n${env.id}\n`;
      const written = await env.writeFile("stamp.txt", body, toolContext);
      if (!written.ok) {
        throw new Error(written.error.message);
      }
      return { content: [{ type: "text", text: body }] };
    },
  });
  const faux = fauxProvider({ api: "faux", provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "stamp", tools: [stamp] }));
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("stamp", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const harness = await Harness.open(
    await openNodeSqliteStorage(path.join(dir, "session.sqlite")),
    {
      models,
      registry,
      settings: {
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      },
      env: ({ conversationId, cwd }) => {
        if (cwd === undefined) {
          throw new Error("missing cwd");
        }
        return isolatedEnv(`env:${conversationId}`, cwd);
      },
    },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: work },
    });
    const submission = await root.submit({ type: "input", content: name, requestId: name }, context);
    expect((await submission.wait(context)).status).toBe("done");
    return {
      dir: work,
      conversationId: String(root.id),
      text: await readFile(path.join(work, "stamp.txt"), "utf8"),
    };
  } finally {
    await harness.close(context);
  }
}
