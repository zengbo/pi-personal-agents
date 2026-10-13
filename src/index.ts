/**
 * Phase 1 controller: one harness per bot, a Podman sandbox, and an approval gate.
 */
export const PHASE = 1 as const;

/** pi-durable engines field. CI and local installs refuse older Node. */
export const NODE_ENGINE = ">=22.19.0" as const;

export { startController } from "./controller/runtime.ts";
export { BOTS } from "./bots/extensions.ts";
export { MAX_RUNNING_SANDBOXES } from "./sandbox/flags.ts";
