import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("ops/tests/sandbox-env.sh");
const script = readFileSync(scriptPath, "utf8");
const SBX_OVERRIDES = [
  "SBX_NFT_SNAPSHOT",
  "SBX_TINYPROXY_CONF",
  "SBX_LISTEN_SNAPSHOT",
  "SBX_WORKSPACE_ROOT",
  "SBX_SLICE_LIMITS",
] as const;

function directEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of SBX_OVERRIDES) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

function runSourced(body: string): { status: number; stderr: string } {
  try {
    execFileSync("bash", ["-c", body], {
      encoding: "utf8",
      env: { ...process.env, PPA_SCRIPT: scriptPath },
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return { status: failed.status ?? 1, stderr: failed.stderr ?? "" };
  }
}

describe("VPS environment script", () => {
  it("lists 48 implemented checks and parses", () => {
    execFileSync("bash", ["-n", scriptPath]);
    const listed = execFileSync("bash", [scriptPath, "--list"], { encoding: "utf8", env: directEnv() })
      .trim()
      .split("\n");
    expect(listed).toHaveLength(48);
    const ids = listed.map((line) => {
      const id = line.split("\t")[0];
      expect(id, line).toBeTruthy();
      return id ?? "";
    });
    expect(new Set(ids).size).toBe(48);
    for (const id of ids) {
      expect(script).toContain(`test_${id.replaceAll("-", "_")}()`);
    }
  });

  it("keeps the sandbox flags and does not call ssh", () => {
    for (const flag of [
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--read-only",
      "keep-id:uid=1000,gid=1000",
      "--memory 768m",
      "--memory-swap 768m",
      "--pids-limit 256",
      "--cpus 1",
      "FilterDefaultDeny",
      "sbx_egress",
      "MAX_SANDBOXES=3",
    ]) {
      expect(script).toContain(flag);
    }
    expect(script).not.toContain("--privileged");
    expect(script).not.toContain("--cap-add");
    expect(script).not.toContain("--env-host");
    expect(script).not.toContain("--volume");
    expect(script).not.toContain("--mount");
    expect(script).not.toContain("chmod 0777");
    expect(script).not.toContain("FilterDefaultDeny No");
    expect(script).not.toMatch(/\bssh\s+-/);
    expect(script).not.toContain("scp ");
    expect(script).not.toContain("cat /home/agentctl/secrets");
  });

  it("refuses a direct run when an SBX_* test override is set", () => {
    for (const name of SBX_OVERRIDES) {
      let status = 0;
      let stderr = "";
      try {
        execFileSync("bash", [scriptPath, "--list"], {
          encoding: "utf8",
          env: directEnv({ [name]: "/tmp/ppa-not-the-host" }),
        });
      } catch (error) {
        const failed = error as { status?: number; stderr?: string };
        status = failed.status ?? 1;
        stderr = failed.stderr ?? "";
      }
      expect(status, name).not.toBe(0);
      expect(stderr, name).toContain(name);
    }
    const listed = execFileSync("bash", [scriptPath, "--list"], { encoding: "utf8", env: directEnv() });
    expect(listed).toContain("H14");
  });

  it("fails require_dir_mode on mode 0755 even when the owner matches", () => {
    const result = runSourced(`
      set -euo pipefail
      source "$PPA_SCRIPT"
      owner="$(id -un)"
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      mkdir -m 0700 "$work/ok"
      if ! require_dir_mode "$work/ok" 700 "$owner"; then
        echo "mode 0700 should pass" >&2
        exit 1
      fi
      mkdir -m 0755 "$work/loose"
      if require_dir_mode "$work/loose" 700 "$owner"; then
        echo "mode 0755 should fail" >&2
        exit 1
      fi
      mkdir -m 0700 "$work/target"
      ln -s "$work/target" "$work/link"
      if require_dir_mode "$work/link" 700 "$owner"; then
        echo "symlink should fail" >&2
        exit 1
      fi
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails test_H14 when FilterDefaultDeny is No", () => {
    const result = runSourced(`
      set -euo pipefail
      source "$PPA_SCRIPT"
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      conf="$work/tinyproxy.conf"
      snap="$work/listen.txt"
      printf '%s\\n' 'FilterDefaultDeny No' > "$conf"
      printf '%s\\n' 'LISTEN 0 128 127.0.0.1:8888' > "$snap"
      export SBX_TINYPROXY_CONF="$conf"
      export SBX_LISTEN_SNAPSHOT="$snap"
      if test_H14; then
        echo "FilterDefaultDeny No should fail" >&2
        exit 1
      fi
      printf '%s\\n' 'FilterDefaultDeny Yes' > "$conf"
      if ! test_H14; then
        echo "FilterDefaultDeny Yes should pass when the proxy port is open" >&2
        exit 1
      fi
      rm -f "$conf"
      if test_H14; then
        echo "missing tinyproxy config should fail" >&2
        exit 1
      fi
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails test_H13 without port 8888 and test_H15 when a parent is looser than 0750", () => {
    const result = runSourced(`
      set -euo pipefail
      source "$PPA_SCRIPT"
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      nft="$work/nft.txt"
      printf '%s\\n' 'ip protocol tcp drop' > "$nft"
      export SBX_NFT_SNAPSHOT="$nft"
      if test_H13; then
        echo "nft rules without 8888 should fail" >&2
        exit 1
      fi
      printf '%s\\n' 'tcp dport 8888 drop' > "$nft"
      if ! test_H13; then
        echo "nft rules with 8888 and drop should pass" >&2
        exit 1
      fi

      root="$work/ws"
      mkdir -p "$root/bot/sess"
      chmod 0755 "$root"
      chmod 0750 "$root/bot"
      chmod 0777 "$root/bot/sess"
      export SBX_WORKSPACE_ROOT="$root"
      if test_H15; then
        echo "0755 workspace root should fail" >&2
        exit 1
      fi
      chmod 0750 "$root"
      chmod 0755 "$root/bot"
      if test_H15; then
        echo "0755 bot parent should fail even when the leaf is 0777" >&2
        exit 1
      fi
      chmod 0750 "$root/bot"
      if ! test_H15; then
        echo "0750 parents and 0777 leaf should pass" >&2
        exit 1
      fi
    `);
    expect(result.status, result.stderr).toBe(0);
  });
});
