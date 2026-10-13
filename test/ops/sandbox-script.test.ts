import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scriptPath = "ops/tests/sandbox-env.sh";
const script = readFileSync(scriptPath, "utf8");

describe("VPS environment script", () => {
  it("lists 48 implemented checks and parses", () => {
    execFileSync("bash", ["-n", scriptPath]);
    const listed = execFileSync("bash", [scriptPath, "--list"], { encoding: "utf8" })
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
});
