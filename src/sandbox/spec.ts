import path from "node:path";
import {
  SANDBOX_CPU_PERIOD,
  SANDBOX_CPU_QUOTA,
  SANDBOX_IMAGE,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_PIDS_LIMIT,
  SANDBOX_PROXY_ENV,
} from "./flags.ts";

export interface SandboxMount {
  readonly type: "bind" | "tmpfs";
  readonly source: string;
  readonly destination: string;
  readonly options: readonly string[];
}

/** Libpod SpecGenerator fields this controller sends. Security-relevant ones are required. */
export interface SandboxSpec {
  readonly image: string;
  readonly name: string;
  readonly command: readonly string[];
  readonly env_host: false;
  readonly httpproxy: false;
  readonly privileged: false;
  readonly cap_drop: readonly ["ALL"];
  readonly no_new_privileges: true;
  readonly read_only_filesystem: true;
  readonly userns: { readonly nsmode: "keep-id:uid=1000,gid=1000" };
  readonly netns: { readonly nsmode: "pasta" };
  readonly cgroupns: { readonly nsmode: "private" };
  readonly work_dir: "/workspace";
  readonly env: { readonly [key: string]: string };
  readonly resource_limits: {
    readonly memory: { readonly limit: number; readonly swap: number };
    readonly pids: { readonly limit: number };
    readonly cpu: { readonly quota: number; readonly period: number };
  };
  readonly mounts: readonly SandboxMount[];
}

const PROTECTED_PREFIXES = ["/home/agentctl", "/run/sbx", "/var/run/secrets", "/run/user"];

export function assertMountSourceAllowed(source: string): void {
  const resolved = path.resolve(source);
  for (const prefix of PROTECTED_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`)) {
      throw new Error("refusing to mount a protected path into the sandbox");
    }
  }
  if (resolved === "/secrets" || resolved.endsWith(`${path.sep}secrets`) || resolved.includes(`${path.sep}secrets${path.sep}`)) {
    throw new Error("refusing to mount a secrets path into the sandbox");
  }
}

export function buildSandboxSpec(input: { name: string; workspaceLeaf: string }): SandboxSpec {
  assertMountSourceAllowed(input.workspaceLeaf);
  const leaf = path.resolve(input.workspaceLeaf);
  return {
    image: SANDBOX_IMAGE,
    name: input.name,
    command: ["sleep", "infinity"],
    env_host: false,
    httpproxy: false,
    privileged: false,
    cap_drop: ["ALL"],
    no_new_privileges: true,
    read_only_filesystem: true,
    userns: { nsmode: "keep-id:uid=1000,gid=1000" },
    netns: { nsmode: "pasta" },
    cgroupns: { nsmode: "private" },
    work_dir: "/workspace",
    env: { ...SANDBOX_PROXY_ENV },
    resource_limits: {
      memory: { limit: SANDBOX_MEMORY_BYTES, swap: SANDBOX_MEMORY_BYTES },
      pids: { limit: SANDBOX_PIDS_LIMIT },
      cpu: { quota: SANDBOX_CPU_QUOTA, period: SANDBOX_CPU_PERIOD },
    },
    mounts: [
      {
        type: "tmpfs",
        source: "tmpfs",
        destination: "/tmp",
        options: ["rw", "nosuid", "nodev", "noexec", "size=67108864"],
      },
      {
        type: "tmpfs",
        source: "tmpfs",
        destination: "/home/sbx",
        options: ["rw", "nosuid", "nodev", "noexec", "size=16777216"],
      },
      {
        type: "bind",
        source: leaf,
        destination: "/workspace",
        options: ["rbind", "rw"],
      },
    ],
  };
}

/** True when a spec still has every mandatory restriction and no secret mount. */
export function specKeepsSandbox(spec: SandboxSpec): boolean {
  if (spec.privileged !== false || spec.env_host !== false || spec.httpproxy !== false) {
    return false;
  }
  if (spec.cap_drop.length !== 1 || spec.cap_drop[0] !== "ALL") {
    return false;
  }
  if (!spec.no_new_privileges || !spec.read_only_filesystem) {
    return false;
  }
  if (spec.userns.nsmode !== "keep-id:uid=1000,gid=1000") {
    return false;
  }
  if (spec.resource_limits.memory.limit > SANDBOX_MEMORY_BYTES || spec.resource_limits.memory.swap > SANDBOX_MEMORY_BYTES) {
    return false;
  }
  if (spec.resource_limits.pids.limit > SANDBOX_PIDS_LIMIT) {
    return false;
  }
  if (spec.resource_limits.cpu.quota > SANDBOX_CPU_QUOTA) {
    return false;
  }
  const binds = spec.mounts.filter((mount) => mount.type === "bind");
  if (binds.length !== 1 || binds[0]?.destination !== "/workspace") {
    return false;
  }
  const encoded = JSON.stringify(spec);
  if (encoded.includes("cap_add") || encoded.includes("/home/agentctl") || encoded.includes("podman.sock")) {
    return false;
  }
  return true;
}
