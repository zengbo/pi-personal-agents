/** Shown when a caller asks for gVisor. runsc is not started and is not a selectable runtime. */
export const RUNSC_DISABLED_MESSAGE = "runsc is disabled until a set-property path exists";

/** crun is the only runtime the controller will store or start. */
export function refuseDisabledRuntime(runtime: unknown): string | undefined {
  if (runtime === "crun") {
    return undefined;
  }
  return RUNSC_DISABLED_MESSAGE;
}
