import { AuditLog, type AuditEvent } from "./audit.ts";
import { PolicyStore, type PolicyRule } from "./store.ts";

export const DANGEROUS_TOOLS = [
  "send_external",
  "git_push",
  "deploy",
  "pay",
  "delete_outside",
  "add_egress_domain",
  "set_runtime",
  "forward_channel",
] as const;

const ALLOW_BY_DEFAULT = new Set(["read_file", "search_notes", "delegate"]);
/** Workspace writes and sandbox exec stay inside the session leaf. They are not approvals. */
const OPS_WORKSPACE_TOOLS = new Set(["write_file", "exec"]);

export type ApprovalChoice = "allow_once" | "allow_always" | "deny";

export interface ApprovalRequest {
  readonly id: string;
  readonly bot: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly taskId: string;
  readonly expiresAt: number;
  status: "pending" | ApprovalChoice | "expired";
}

export type PolicyOutcome =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "ask"; readonly request: ApprovalRequest };

export interface ApprovalActor {
  readonly kind: string;
  readonly sessionId?: string;
}

export interface PolicyEngineOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly id?: () => string;
}

interface Waiter {
  resolve: (outcome: PolicyOutcome) => void;
}

/**
 * Decisions are made outside the model. Only an authenticated user actor can
 * allow or deny a pending request. Text from another bot is ignored.
 * Expiry and thrown callers fail closed (deny).
 */
export class PolicyEngine {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly id: () => string;
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private counter = 0;
  private readonly store: PolicyStore;
  private readonly audit: AuditLog;

  constructor(store: PolicyStore, audit: AuditLog, options: PolicyEngineOptions = {}) {
    this.store = store;
    this.audit = audit;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.id = options.id ?? (() => {
      this.counter += 1;
      return `apr-${this.counter}`;
    });
  }

  evaluate(input: {
    bot: string;
    tool: string;
    args: Readonly<Record<string, unknown>>;
    taskId: string;
  }): PolicyOutcome {
    const matched = this.matchRule(input.bot, input.tool, input.args);
    if (matched !== undefined) {
      this.record("tool", input, matched.decision, "rule");
      if (matched.decision === "deny") {
        return { kind: "deny", reason: "denied by rule" };
      }
      return { kind: "allow" };
    }
    if (allowedByDefault(input.bot, input.tool)) {
      this.record("tool", input, "allow", "default");
      return { kind: "allow" };
    }
    if (!isDangerous(input.tool)) {
      this.record("tool", input, "deny", "fail-closed");
      return { kind: "deny", reason: "fail closed" };
    }
    const request: ApprovalRequest = {
      id: this.id(),
      bot: input.bot,
      tool: input.tool,
      args: input.args,
      taskId: input.taskId,
      expiresAt: this.now() + this.ttlMs,
      status: "pending",
    };
    this.pending.set(request.id, request);
    this.record("tool", input, "ask", "user");
    return { kind: "ask", request };
  }

  wait(requestId: string, signal?: AbortSignal): Promise<PolicyOutcome> {
    const request = this.pending.get(requestId);
    if (request === undefined) {
      return Promise.resolve({ kind: "deny", reason: "unknown approval" });
    }
    if (this.now() >= request.expiresAt) {
      return Promise.resolve(this.expire(request));
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(requestId) ?? [];
      waiters.push({ resolve });
      this.waiters.set(requestId, waiters);
      const remaining = Math.max(0, request.expiresAt - this.now());
      const timer = setTimeout(() => {
        this.timers.delete(requestId);
        resolve(this.expire(request));
      }, remaining);
      this.timers.set(requestId, timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.clearTimer(requestId);
          resolve({ kind: "deny", reason: "aborted" });
        },
        { once: true },
      );
    });
  }

  decide(requestId: string, choice: ApprovalChoice, actor: ApprovalActor): void {
    if (actor.kind !== "user" || actor.sessionId === undefined || actor.sessionId.length === 0) {
      this.audit.append(this.event("ignored", "unknown", "unknown", "", "rejected-non-user", actor.kind));
      throw new Error("approval rejected");
    }
    const request = this.pending.get(requestId);
    if (request === undefined || request.status !== "pending") {
      throw new Error("approval is not pending");
    }
    if (this.now() >= request.expiresAt) {
      this.expire(request);
      throw new Error("approval expired");
    }
    request.status = choice;
    this.pending.delete(requestId);
    this.clearTimer(requestId);
    if (choice === "allow_always") {
      const rule: PolicyRule = {
        id: `rule-${request.id}`,
        bot: request.bot,
        tool: request.tool,
        args: stringArgs(request.args),
        decision: "allow",
        scope: "always",
        expiresAt: null,
        createdBy: "user",
      };
      this.store.insert(rule);
      this.audit.append(this.event("rule", request.bot, request.tool, request.taskId, "allow-always", "user"));
    }
    const outcome: PolicyOutcome =
      choice === "deny"
        ? { kind: "deny", reason: "denied by user" }
        : { kind: "allow" };
    this.audit.append(this.event("decision", request.bot, request.tool, request.taskId, choice, "user"));
    this.settle(requestId, outcome);
  }

  /** Bot text, tool output, and page contents are not approvals. */
  noteUntrusted(bot: string, text: string): false {
    this.audit.append(this.event("ignored", bot, "", "", "untrusted", `bot:${bot}`));
    void text;
    return false;
  }

  events() {
    return this.audit.read();
  }

  listPending(): readonly ApprovalRequest[] {
    const now = this.now();
    const open: ApprovalRequest[] = [];
    for (const request of this.pending.values()) {
      if (request.status === "pending" && now < request.expiresAt) {
        open.push(request);
      }
    }
    return open;
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(requestId);
    }
  }

  private expire(request: ApprovalRequest): PolicyOutcome {
    if (request.status !== "pending") {
      return request.status === "deny" || request.status === "expired"
        ? { kind: "deny", reason: "approval expired" }
        : { kind: "allow" };
    }
    request.status = "expired";
    this.pending.delete(request.id);
    this.clearTimer(request.id);
    this.audit.append(this.event("decision", request.bot, request.tool, request.taskId, "expired", "timeout"));
    const outcome: PolicyOutcome = { kind: "deny", reason: "approval expired" };
    this.settle(request.id, outcome);
    return outcome;
  }

  private settle(requestId: string, outcome: PolicyOutcome): void {
    const waiters = this.waiters.get(requestId) ?? [];
    this.waiters.delete(requestId);
    for (const waiter of waiters) {
      waiter.resolve(outcome);
    }
  }

  private matchRule(bot: string, tool: string, args: Readonly<Record<string, unknown>>): PolicyRule | undefined {
    const now = this.now();
    let found: PolicyRule | undefined;
    for (const rule of this.store.list()) {
      if (rule.expiresAt !== null && rule.expiresAt <= now) {
        continue;
      }
      if (rule.tool !== tool) {
        continue;
      }
      if (rule.bot !== "*" && rule.bot !== bot) {
        continue;
      }
      if (!argsMatch(rule.args, args)) {
        continue;
      }
      if (rule.decision === "deny") {
        return rule;
      }
      if (found === undefined || (found.bot === "*" && rule.bot === bot)) {
        found = rule;
      }
    }
    return found;
  }

  private record(
    kind: AuditEvent["kind"],
    input: { bot: string; tool: string; taskId: string },
    outcome: string,
    actor: string,
  ): void {
    this.audit.append(this.event(kind, input.bot, input.tool, input.taskId, outcome, actor));
  }

  private event(
    kind: AuditEvent["kind"],
    bot: string,
    tool: string,
    taskId: string,
    outcome: string,
    actor: string,
  ): AuditEvent {
    return { time: this.now(), kind, bot, tool, taskId, outcome, actor };
  }
}

function isDangerous(tool: string): boolean {
  return (DANGEROUS_TOOLS as readonly string[]).includes(tool);
}

function allowedByDefault(bot: string, tool: string): boolean {
  if (ALLOW_BY_DEFAULT.has(tool)) {
    return true;
  }
  return bot === "ops" && OPS_WORKSPACE_TOOLS.has(tool);
}

function argsMatch(expected: Readonly<Record<string, string>>, actual: Readonly<Record<string, unknown>>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      return false;
    }
  }
  return true;
}

function stringArgs(args: Readonly<Record<string, unknown>>): Record<string, string> {
  const matched: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      matched[key] = value;
    }
  }
  return matched;
}
