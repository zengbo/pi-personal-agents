/**
 * Phase 0 baseline.
 * The controller process, sandbox driver, policy engine, and web server are Phase 1.
 */
export const PHASE = 0 as const;

/** pi-durable engines field. CI and local installs refuse older Node. */
export const NODE_ENGINE = ">=22.19.0" as const;
