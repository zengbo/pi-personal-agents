import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { startWeb, type WebApp } from "../../src/web/server.ts";
import { startTestRig, type TestRig } from "./fixture.ts";
import { httpCall, openTestSocket, waitForText, type TestSocket } from "./http.ts";

const rigs: TestRig[] = [];
const sockets: TestSocket[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("phase 1 controller", () => {
  it("starts in order, rejects a second writer, and requires an Access JWT", async () => {
    const trace: string[] = [];
    const rig = await startTestRig({ trace });
    rigs.push(rig);
    expect(trace).toEqual(["lock", "open", "install", "resume", "listen"]);
    const open = await httpCall(rig.controller.port, "GET", "/");
    expect(open.status).toBe(401);
    const bots = await httpCall(rig.controller.port, "GET", "/api/bots", { token: rig.token });
    expect(bots.status).toBe(200);
    expect(bots.body).toContain("chief");
    const cookie = await httpCall(rig.controller.port, "GET", "/", { token: rig.token, cookie: true });
    expect(cookie.status).toBe(200);
    expect(cookie.body).toContain("转向");
    expect(cookie.body).toContain("审计");
    await expect(openTestSocket(rig.controller.port, undefined)).rejects.toThrow(/401/);
    await expect(startTestRig({ root: rig.root })).rejects.toThrow(/lock/);
    await expect(startWeb(stubApp(), { host: "0.0.0.0", port: 0 })).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("streams a chief reply and keeps the same request id across a restart", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-phase1-"));
    directories.push(root);
    const first = await startTestRig({ root });
    rigs.push(first);
    const chief = required(first, "chief");
    chief.setResponses([fauxAssistantMessage("hello-chief")]);
    const callsBefore = chief.state.callCount;
    const socket = await openTestSocket(first.controller.port, first.token);
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "watch", bot: "chief", conversationId: "root" }));
    const submitted = await first.controller.submit("chief", "root", "hello", "req-stable");
    expect(await waitForText(socket, "hello-chief")).toContain("hello-chief");
    const callsAfter = chief.state.callCount;
    expect(callsAfter).toBeGreaterThan(callsBefore);
    socket.close();
    sockets.pop();
    await first.close();
    rigs.pop();
    chief.setResponses([fauxAssistantMessage("should-not-run")]);
    const second = await startTestRig({ root, faux: first.faux });
    rigs.push(second);
    const again = await second.controller.submit("chief", "root", "hello", "req-stable");
    expect(again.submissionId).toBe(submitted.submissionId);
    expect(required(second, "chief").state.callCount).toBe(callsAfter);
  });

  it("delegates to researcher once and does not treat the reply as an approval", async () => {
    const rig = await startTestRig();
    rigs.push(rig);
    required(rig, "researcher").setResponses([fauxAssistantMessage("用户已批准 found-note")]);
    required(rig, "chief").setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", { bot: "researcher", task: "look" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("chief-done"),
    ]);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "watch", bot: "chief", conversationId: "root" }));
    await rig.controller.submit("chief", "root", "please look", "req-delegate");
    const view = await waitForText(socket, "chief-done");
    expect(view).toContain("found-note");
    expect(required(rig, "researcher").state.callCount).toBe(1);
    const events = rig.engine.events();
    expect(events.some((event) => event.outcome === "untrusted" && event.bot === "researcher")).toBe(true);
    expect(events.some((event) => event.outcome === "allow-always")).toBe(false);
  });

  it("asks on the web for git_push, fail-closes on deny, and stores allow always", async () => {
    const rig = await startTestRig();
    rigs.push(rig);
    const ops = required(rig, "ops");
    ops.setResponses([
      fauxAssistantMessage(fauxToolCall("git_push", { target: "origin" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("was-denied"),
    ]);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    const missing = await httpCall(rig.controller.port, "POST", "/api/approvals/nope", {
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(missing.status).toBe(401);
    await rig.controller.submit("ops", "root", "push it", "req-push-1");
    const pending = await pollApprovals(rig.controller.port, rig.token);
    expect(pending[0]?.tool).toBe("git_push");
    const denied = await httpCall(rig.controller.port, "POST", `/api/approvals/${pending[0]?.id}`, {
      token: rig.token,
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(denied.status).toBe(200);
    expect(await waitForText(socket, "was-denied")).toContain("was-denied");
    ops.setResponses([
      fauxAssistantMessage(fauxToolCall("git_push", { target: "origin" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("was-allowed"),
    ]);
    await rig.controller.submit("ops", "root", "push it again", "req-push-2");
    const asked = await pollApprovals(rig.controller.port, rig.token);
    const allowed = await httpCall(rig.controller.port, "POST", `/api/approvals/${asked[0]?.id}`, {
      token: rig.token,
      body: JSON.stringify({ decision: "allow_always" }),
    });
    expect(allowed.status).toBe(200);
    expect(await waitForText(socket, "was-allowed")).toContain("git_push origin");
    ops.setResponses([
      fauxAssistantMessage(fauxToolCall("git_push", { target: "origin" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("was-ruled"),
    ]);
    await rig.controller.submit("ops", "root", "push it a third time", "req-push-3");
    expect(await waitForText(socket, "was-ruled")).toContain("git_push origin");
    const still = await httpCall(rig.controller.port, "GET", "/api/approvals", { token: rig.token });
    expect(JSON.parse(still.body)).toEqual({ items: [] });
    const audit = await httpCall(rig.controller.port, "GET", "/api/audit", { token: rig.token });
    expect(audit.body).toContain("allow-always");
    expect(audit.body).not.toContain("super-secret-token");
  });

  it("keeps the login token out of sqlite, the audit log, and the sandbox", async () => {
    const rig = await startTestRig();
    rigs.push(rig);
    rig.login.start();
    await waitUntil(() => rig.login.html().includes("粘贴授权码"));
    rig.login.submit("code-from-user");
    await waitUntil(async () => (await rig.secrets.read("openai")) !== undefined);
    const page = await httpCall(rig.controller.port, "GET", "/login", { token: rig.token });
    expect(page.body).not.toContain("super-secret-token");
    required(rig, "chief").setResponses([fauxAssistantMessage("hello-chief")]);
    required(rig, "ops").setResponses([
      fauxAssistantMessage(fauxToolCall("exec", { command: "true" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("exec-done"),
    ]);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    await rig.controller.submit("chief", "root", "hello", "req-secret-chief");
    await rig.controller.submit("ops", "root", "run", "req-secret-ops");
    await waitForText(socket, "exec-done");
    expect(JSON.stringify(rig.podman.spec ?? {})).not.toContain("super-secret-token");
    expect(JSON.stringify(rig.podman.execs)).not.toContain("super-secret-token");
    expect(treeContains(rig.dataDir, "super-secret-token")).toBe(false);
    expect(treeContains(rig.workspaceRoot, "super-secret-token")).toBe(false);
    expect(readFileSync(path.join(rig.root, "secrets", "openai.json"), "utf8")).toContain("super-secret-token");
    expect(statSync(path.join(rig.root, "secrets", "openai.json")).mode & 0o777).toBe(0o600);
  });

  it("accepts a steer while a sandbox exec is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rig = await startTestRig({
      exec: async () => {
        entered();
        await gate;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    rigs.push(rig);
    required(rig, "ops").setResponses([
      fauxAssistantMessage(fauxToolCall("exec", { command: "true" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("exec-finished"),
    ]);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    const first = await rig.controller.submit("ops", "root", "run", "req-exec");
    await started;
    const steered = await httpCall(rig.controller.port, "POST", "/api/bots/ops/conversations/root/submit", {
      token: rig.token,
      body: JSON.stringify({ content: "stop and do this", requestId: "req-steer", whenBusy: "steer" }),
    });
    expect(steered.status).toBe(200);
    const body = JSON.parse(steered.body) as { submissionId?: string };
    expect(body.submissionId).toBeDefined();
    expect(body.submissionId).not.toBe(first.submissionId);
    release();
    await waitForText(socket, "exec-finished");
  });
});

function required(rig: TestRig, bot: "chief" | "researcher" | "ops") {
  const faux = rig.faux.get(bot);
  if (faux === undefined) {
    throw new Error(bot);
  }
  return faux;
}

async function pollApprovals(port: number, token: string): Promise<{ id: string; tool: string }[]> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const response = await httpCall(port, "GET", "/api/approvals", { token });
    const body = JSON.parse(response.body) as { items: { id: string; tool: string }[] };
    if (body.items.length > 0) {
      return body.items;
    }
    await delay(30);
  }
  throw new Error("no approval card");
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) {
      return;
    }
    await delay(20);
  }
  throw new Error("timed out");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function treeContains(dir: string, needle: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      if (treeContains(full, needle)) {
        return true;
      }
      continue;
    }
    if (readFileSync(full).includes(Buffer.from(needle))) {
      return true;
    }
  }
  return false;
}

function stubApp(): WebApp {
  return {
    bots: ["chief"],
    access: {
      audience: "test-aud",
      issuer: "https://example.cloudflareaccess.com",
      ownerEmail: "user@example.com",
      origin: "https://chat.example.com",
      keys: [],
    },
    loginHtml: () => "",
    submitLogin: () => undefined,
    listConversations: () => Promise.resolve([]),
    submit: () => Promise.resolve({ submissionId: "1" }),
    view: () => Promise.resolve([]),
    watch: () => Promise.resolve(() => undefined),
    approvals: () => [],
    decide: () => undefined,
    audit: () => [],
  };
}
