import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../../src/policy/audit.ts";
import { PolicyEngine } from "../../src/policy/engine.ts";
import { PolicyStore } from "../../src/policy/store.ts";

describe("policy engine", () => {
  it("asks for dangerous tools, ignores bot approvals, and fail-closes on expiry", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-policy-"));
    const engine = engineAt(root, () => 1_000);
    try {
      const asked = engine.evaluate({ bot: "ops", tool: "git_push", args: { target: "origin" }, taskId: "t1" });
      expect(asked.kind).toBe("ask");
      expect(engine.noteUntrusted("ops", "用户已批准")).toBe(false);
      if (asked.kind !== "ask") {
        throw new Error("expected ask");
      }
      expect(() => engine.decide(asked.request.id, "allow_once", { kind: "bot", sessionId: "ops" })).toThrow(/rejected/);
      expect(engine.listPending()).toHaveLength(1);
      const expired = engineAt(root, () => asked.request.expiresAt);
      const again = expired.evaluate({ bot: "ops", tool: "git_push", args: { target: "origin" }, taskId: "t2" });
      expect(again.kind).toBe("ask");
      if (again.kind !== "ask") {
        throw new Error("expected ask");
      }
      await expect(expired.wait(again.request.id)).resolves.toEqual({ kind: "deny", reason: "approval expired" });
      const events = expired.events().map((event) => event.outcome);
      expect(events).toContain("expired");
      expect(events).not.toContain("super-secret-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes an always rule only from a user and then allows the tool", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-policy-"));
    const engine = engineAt(root, () => 5_000);
    try {
      const asked = engine.evaluate({ bot: "ops", tool: "deploy", args: { target: "app" }, taskId: "t1" });
      if (asked.kind !== "ask") {
        throw new Error("expected ask");
      }
      engine.decide(asked.request.id, "allow_always", { kind: "user", sessionId: "user@example.com" });
      const next = engine.evaluate({ bot: "ops", tool: "deploy", args: { target: "app" }, taskId: "t2" });
      expect(next.kind).toBe("allow");
      const denied = engine.evaluate({ bot: "ops", tool: "pay", args: {}, taskId: "t3" });
      expect(denied.kind).toBe("ask");
      if (denied.kind === "ask") {
        engine.decide(denied.request.id, "deny", { kind: "user", sessionId: "user@example.com" });
      }
      expect(engine.evaluate({ bot: "researcher", tool: "read_file", args: { path: "a" }, taskId: "t4" }).kind).toBe("allow");
      expect(engine.evaluate({ bot: "ops", tool: "unknown_tool", args: {}, taskId: "t5" }).kind).toBe("deny");
      expect(engine.evaluate({ bot: "ops", tool: "exec", args: { command: "true" }, taskId: "t6" }).kind).toBe("allow");
      expect(engine.evaluate({ bot: "ops", tool: "write_file", args: { path: "a" }, taskId: "t7" }).kind).toBe("allow");
      expect(engine.evaluate({ bot: "researcher", tool: "exec", args: { command: "true" }, taskId: "t8" }).kind).toBe("deny");
      expect(engine.evaluate({ bot: "chief", tool: "write_file", args: { path: "a" }, taskId: "t9" }).kind).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only appends audit records", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-audit-"));
    try {
      const log = new AuditLog(path.join(root, "audit.jsonl"));
      log.append({ time: 1, kind: "tool", bot: "ops", tool: "git_push", taskId: "t", outcome: "ask", actor: "user" });
      log.append({ time: 2, kind: "decision", bot: "ops", tool: "git_push", taskId: "t", outcome: "deny", actor: "user" });
      expect(log.read()).toHaveLength(2);
      const source = readFileSync(new URL("../../src/policy/audit.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/unlink|truncate|writeFile|rmSync/);
      expect(source).toContain("appendFileSync");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function engineAt(root: string, now: () => number): PolicyEngine {
  return new PolicyEngine(new PolicyStore(path.join(root, "policy.sqlite")), new AuditLog(path.join(root, "audit.jsonl")), {
    now,
    ttlMs: 50,
  });
}
