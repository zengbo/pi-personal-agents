import type { JsonValue } from "@earendil-works/chord";
import { ToolTask, hook } from "@earendil-works/pi-durable";
import { refuseDisabledRuntime } from "../sandbox/runtime-guard.ts";
import type { PolicyEngine } from "./engine.ts";

interface StoredDecision {
  decision: "allow" | "deny";
  reason: string;
  [key: string]: JsonValue;
}

function runtimeArgument(args: unknown): unknown {
  if (typeof args !== "object" || args === null || !("runtime" in args)) {
    return undefined;
  }
  return args.runtime;
}

/** beforeTool hook. A stored memo is reused so recovery does not ask again. */
export function policyExtensionHook(bot: string, engine: PolicyEngine) {
  return hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      try {
        if (call.name === "set_runtime") {
          const refused = refuseDisabledRuntime(runtimeArgument(call.arguments));
          if (refused !== undefined) {
            return { block: refused };
          }
        }
        const memoKey = `approval:${String(api.taskId)}`;
        const stored = (await api.memo(memoKey, context)) as StoredDecision | undefined;
        if (stored?.decision === "allow") {
          return undefined;
        }
        if (stored?.decision === "deny") {
          return { block: stored.reason };
        }
        const outcome = engine.evaluate({
          bot,
          tool: call.name,
          args: call.arguments,
          taskId: String(api.taskId),
        });
        if (outcome.kind === "allow") {
          return undefined;
        }
        if (outcome.kind === "deny") {
          await api.memo(memoKey, { decision: "deny", reason: outcome.reason } satisfies StoredDecision, context);
          return { block: outcome.reason };
        }
        const decided = await engine.wait(outcome.request.id, context.abortSignal);
        const saved: StoredDecision =
          decided.kind === "allow"
            ? { decision: "allow", reason: "approved" }
            : { decision: "deny", reason: decided.kind === "deny" ? decided.reason : "fail closed" };
        await api.memo(memoKey, saved, context);
        if (saved.decision === "deny") {
          return { block: saved.reason };
        }
        return undefined;
      } catch {
        return { block: "policy failed closed" };
      }
    },
  });
}
