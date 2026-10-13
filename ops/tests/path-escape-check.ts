/**
 * Fallback workspace read used by the VPS environment suite.
 * Walks with lstat. The Phase 1 controller read path uses openat2 when the kernel allows it.
 * Rejects `..`, symbolic links at any component, and regular files with nlink > 1.
 * Errors never include file contents.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PathEscapeCode =
  | "empty"
  | "nul"
  | "absolute"
  | "dotdot"
  | "symlink"
  | "hardlink"
  | "escape"
  | "not_found"
  | "not_file"
  | "not_dir"
  | "root";

export class PathEscapeError extends Error {
  readonly code: PathEscapeCode;

  constructor(code: PathEscapeCode) {
    super(code);
    this.name = "PathEscapeError";
    this.code = code;
  }
}

function isBeneath(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function readWorkspaceFile(rootDir: string, relativePath: string): Buffer {
  if (relativePath.length === 0) {
    throw new PathEscapeError("empty");
  }
  if (relativePath.includes("\0")) {
    throw new PathEscapeError("nul");
  }
  if (path.isAbsolute(relativePath)) {
    throw new PathEscapeError("absolute");
  }

  const root = fs.realpathSync(rootDir);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory()) {
    throw new PathEscapeError("root");
  }

  const parts = relativePath.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new PathEscapeError("dotdot");
    }

    const next = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if (isEnoent(error)) {
        throw new PathEscapeError("not_found");
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new PathEscapeError("symlink");
    }

    const rest = parts.slice(index + 1);
    const last = rest.every((item) => item === "" || item === ".");
    if (last) {
      if (!stat.isFile()) {
        throw new PathEscapeError("not_file");
      }
      if (stat.nlink > 1) {
        throw new PathEscapeError("hardlink");
      }
      if (!isBeneath(root, next)) {
        throw new PathEscapeError("escape");
      }
      const real = fs.realpathSync(next);
      if (!isBeneath(root, real)) {
        throw new PathEscapeError("escape");
      }
      return fs.readFileSync(next);
    }
    if (!stat.isDirectory()) {
      throw new PathEscapeError("not_dir");
    }
    current = next;
  }
  throw new PathEscapeError("empty");
}

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
