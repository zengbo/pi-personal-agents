import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const childScript = fileURLToPath(new URL("./rss-child.ts", import.meta.url));
const LIMIT = 400 * 1024 * 1024;

describe("controller memory", () => {
  it("stays under 400 MB RSS with three idle bots", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", childScript], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    const rss = Number(result.stdout.trim());
    expect(rss).toBeGreaterThan(0);
    expect(rss).toBeLessThan(LIMIT);
  }, 60_000);
});