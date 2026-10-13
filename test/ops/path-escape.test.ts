import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PathEscapeError, readWorkspaceFile, selfTest } from "../../ops/tests/path-escape-check.js";

describe("workspace path escape checks", () => {
  it("rejects symlink, dotdot, and hardlink escapes", () => {
    expect(() => {
      selfTest();
    }).not.toThrow();
  });

  it("does not return the outside sentinel when a symlink is rejected", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "ppa-out-"));
    const root = mkdtempSync(path.join(tmpdir(), "ppa-root-"));
    try {
      writeFileSync(path.join(outside, "secret.txt"), "sentinel-secret-value");
      writeFileSync(path.join(root, "ok.txt"), "visible");
      expect(readWorkspaceFile(root, "ok.txt").toString("utf8")).toBe("visible");
      expect(() => readWorkspaceFile(root, "missing.txt")).toThrow(PathEscapeError);
      try {
        readWorkspaceFile(root, "../secret.txt");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(PathEscapeError);
        expect(error instanceof PathEscapeError ? error.code : "").toBe("dotdot");
        expect(String(error)).not.toContain("sentinel-secret-value");
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});