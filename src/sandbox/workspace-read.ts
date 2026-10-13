/**
 * Controller-side workspace reads.
 * Uses openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS) when the kernel allows it.
 * Otherwise walks with lstat and refuses symlinks, `..`, and nlink > 1.
 * Errors never include file contents.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

export type WorkspaceReadBackend = "openat2" | "lstat";

let backend: WorkspaceReadBackend | undefined;

const OPENAT2_SCRIPT = String.raw`
import base64, ctypes, errno, json, os, stat, sys

SYS_openat2 = 437
AT_FDCWD = -100
O_RDONLY = 0
O_DIRECTORY = 0x10000
O_NOFOLLOW = 0x20000
O_CLOEXEC = 0x80000
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08

class open_how(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint64),
        ("mode", ctypes.c_uint64),
        ("resolve", ctypes.c_uint64),
    ]

libc = ctypes.CDLL(None, use_errno=True)

def call_openat2(dirfd, path, flags, resolve):
    how = open_how(flags, 0, resolve)
    fd = libc.syscall(
        ctypes.c_long(SYS_openat2),
        ctypes.c_int(dirfd),
        ctypes.c_char_p(path),
        ctypes.byref(how),
        ctypes.c_size_t(ctypes.sizeof(how)),
    )
    if fd < 0:
        return None, ctypes.get_errno()
    return fd, 0

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")

def map_errno(err):
    if err == errno.ENOSYS:
        return "unsupported"
    if err == errno.ELOOP:
        return "symlink"
    if err == errno.EXDEV:
        return "escape"
    if err == errno.ENOENT:
        return "not_found"
    if err == errno.ENOTDIR:
        return "not_dir"
    if err == errno.EISDIR:
        return "not_file"
    if err in (errno.EACCES, errno.EPERM):
        return "escape"
    return "not_found"

req = json.loads(sys.stdin.read())
root = req["root"]
rel = req["rel"]
root_fd, err = call_openat2(
    AT_FDCWD,
    os.fsencode(root),
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
    RESOLVE_NO_SYMLINKS,
)
if root_fd is None:
    emit({"ok": False, "code": "unsupported" if err == errno.ENOSYS else ("symlink" if err == errno.ELOOP else "root")})
    sys.exit(0)
try:
    fd, err = call_openat2(
        root_fd,
        os.fsencode(rel),
        O_RDONLY | O_CLOEXEC,
        RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH,
    )
    if fd is None:
        emit({"ok": False, "code": map_errno(err)})
        sys.exit(0)
    try:
        st = os.fstat(fd)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            emit({"ok": False, "code": "symlink" if stat.S_ISLNK(st.st_mode) else ("not_file" if stat.S_ISDIR(st.st_mode) else "not_file")})
            sys.exit(0)
        if st.st_nlink > 1:
            emit({"ok": False, "code": "hardlink"})
            sys.exit(0)
        chunks = []
        while True:
            block = os.read(fd, 1 << 20)
            if not block:
                break
            chunks.append(block)
        data = b"".join(chunks)
    finally:
        os.close(fd)
finally:
    os.close(root_fd)
emit({"ok": True, "b64": base64.b64encode(data).decode("ascii")})
`;

const CODES = new Set<PathEscapeCode>([
  "empty",
  "nul",
  "absolute",
  "dotdot",
  "symlink",
  "hardlink",
  "escape",
  "not_found",
  "not_file",
  "not_dir",
  "root",
]);

function isCode(value: string): value is PathEscapeCode {
  return CODES.has(value as PathEscapeCode);
}

function rejectRelative(relativePath: string): void {
  if (relativePath.length === 0) {
    throw new PathEscapeError("empty");
  }
  if (relativePath.includes("\0")) {
    throw new PathEscapeError("nul");
  }
  if (path.isAbsolute(relativePath)) {
    throw new PathEscapeError("absolute");
  }
  for (const part of relativePath.split("/")) {
    if (part === "..") {
      throw new PathEscapeError("dotdot");
    }
  }
}

function assertRealDirectory(rootDir: string): void {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(rootDir);
  } catch (error) {
    if (isEnoent(error)) {
      throw new PathEscapeError("root");
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new PathEscapeError("root");
  }
}

function isBeneath(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readWithLstat(rootDir: string, relativePath: string): Buffer {
  assertRealDirectory(rootDir);
  const parts = relativePath.split("/");
  let current = rootDir;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part === "" || part === ".") {
      continue;
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
      if (!isBeneath(rootDir, next)) {
        throw new PathEscapeError("escape");
      }
      const real = fs.realpathSync(next);
      if (!isBeneath(rootDir, real)) {
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

function relativeForKernel(relativePath: string): string {
  const relative = relativePath.split("/").filter((part) => part !== "" && part !== ".").join("/");
  if (relative.length === 0) {
    throw new PathEscapeError("empty");
  }
  return relative;
}

function readWithOpenat2(rootDir: string, relativePath: string): Buffer {
  assertRealDirectory(rootDir);
  const rel = relativeForKernel(relativePath);
  const result = spawnSync("python3", ["-c", OPENAT2_SCRIPT], {
    input: JSON.stringify({ root: rootDir, rel }),
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const errno = result.error;
    if (typeof errno === "object" && errno !== null && "code" in errno && errno.code === "ENOENT") {
      throw new Error("openat2-unsupported");
    }
    throw errno;
  }
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  let parsed: { ok?: boolean; code?: string; b64?: string };
  try {
    parsed = JSON.parse(line) as { ok?: boolean; code?: string; b64?: string };
  } catch {
    throw new Error("openat2-unsupported");
  }
  if (parsed.ok === true && typeof parsed.b64 === "string") {
    return Buffer.from(parsed.b64, "base64");
  }
  if (parsed.code === "unsupported") {
    throw new Error("openat2-unsupported");
  }
  if (typeof parsed.code === "string" && isCode(parsed.code)) {
    throw new PathEscapeError(parsed.code);
  }
  throw new PathEscapeError("root");
}

export function workspaceReadBackend(): WorkspaceReadBackend {
  return backend ?? "lstat";
}

/** Read one regular file beneath `rootDir`. Uses openat2 until it is unavailable. */
export function readWorkspaceFile(rootDir: string, relativePath: string): Buffer {
  rejectRelative(relativePath);
  if (backend === "lstat") {
    return readWithLstat(rootDir, relativePath);
  }
  try {
    const bytes = readWithOpenat2(rootDir, relativePath);
    backend = "openat2";
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === "openat2-unsupported") {
      backend = "lstat";
      return readWithLstat(rootDir, relativePath);
    }
    throw error;
  }
}
