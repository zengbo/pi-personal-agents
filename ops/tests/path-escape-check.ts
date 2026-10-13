/**
 * VPS environment suite entry for workspace reads.
 * The implementation lives in src/sandbox/workspace-read.ts (openat2, lstat fallback).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PathEscapeError,
  readWorkspaceFile,
  type PathEscapeCode,
} from "../../src/sandbox/workspace-read.ts";

export { PathEscapeError, readWorkspaceFile, workspaceReadBackend } from "../../src/sandbox/workspace-read.ts";
export type { PathEscapeCode, WorkspaceReadBackend } from "../../src/sandbox/workspace-read.ts";

function expectCode(fn: () => void, code: PathEscapeCode): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof PathEscapeError && error.code === code) {
      return;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

/** Temp-dir negative tests. Prints nothing on success. */
export function selfTest(): void {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ppa-escape-out-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppa-escape-root-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "sentinel-secret-value");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "ok.txt"), "ok");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked"));
    fs.symlinkSync(outside, path.join(root, "linked-dir"));
    fs.linkSync(path.join(outside, "secret.txt"), path.join(root, "hard"));

    const ok = readWorkspaceFile(root, "nested/ok.txt");
    if (ok.toString("utf8") !== "ok") {
      throw new Error("positive read mismatch");
    }
    expectCode(() => {
      readWorkspaceFile(root, "linked");
    }, "symlink");
    expectCode(() => {
      readWorkspaceFile(root, "linked-dir/secret.txt");
    }, "symlink");
    expectCode(() => {
      readWorkspaceFile(root, "../secret.txt");
    }, "dotdot");
    expectCode(() => {
      readWorkspaceFile(root, "nested/../../secret.txt");
    }, "dotdot");
    expectCode(() => {
      readWorkspaceFile(root, "hard");
    }, "hardlink");
    expectCode(() => {
      readWorkspaceFile(root, path.join(outside, "secret.txt"));
    }, "absolute");
    const leaked = readWorkspaceFile(root, "nested/ok.txt").toString("utf8");
    if (leaked.includes("sentinel-secret-value")) {
      throw new Error("sentinel leaked into a workspace read");
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return fs.realpathSync(entry) === fs.realpathSync(new URL(import.meta.url).pathname);
}

if (invokedDirectly()) {
  const command = process.argv[2];
  if (command === "self-test") {
    selfTest();
    process.stdout.write("PASS path-escape\n");
  } else if (command === "read" && process.argv[3] !== undefined && process.argv[4] !== undefined) {
    const bytes = readWorkspaceFile(process.argv[3], process.argv[4]);
    process.stdout.write(bytes);
  } else {
    process.stderr.write("usage: path-escape-check.ts self-test | read <root> <relative>\n");
    process.exitCode = 2;
  }
}
