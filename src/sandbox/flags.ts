/** Container limits. These values are the floor; callers must not lower the drops or raise the ceilings. */
export const SANDBOX_IMAGE = "localhost/sandbox-base:1";
export const SANDBOX_PROXY = "http://10.0.2.2:8888";
export const MAX_RUNNING_SANDBOXES = 3;
export const SANDBOX_IDLE_MS = 10 * 60 * 1000;
export const SANDBOX_MEMORY_BYTES = 768 * 1024 * 1024;
export const SANDBOX_PIDS_LIMIT = 256;
export const SANDBOX_CPU_PERIOD = 100_000;
export const SANDBOX_CPU_QUOTA = 100_000;

export const SANDBOX_PROXY_ENV = {
  HTTP_PROXY: SANDBOX_PROXY,
  HTTPS_PROXY: SANDBOX_PROXY,
  http_proxy: SANDBOX_PROXY,
  https_proxy: SANDBOX_PROXY,
} as const;

export const RUNSC_SCOPE_PROPERTIES = ["MemoryMax=768M", "TasksMax=256", "CPUQuota=100%"] as const;
