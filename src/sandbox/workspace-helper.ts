/**
 * sbx-side session leaf creator.
 * The process that runs this file must be the workspace owner (systemd User=sbx).
 * It only creates one session directory under an existing <root>/<bot> parent.
 * Names are single path components. Creation uses openat2 from that parent, not a joined path.
 * The leaf is mode 0700 and owned by this process. Parents are not chmod'd.
 * Importing this module does not listen; the guard at the bottom does.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BOT_NAME = /^[a-z][a-z0-9-]{0,40}$/;
export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
export const LEAF_MODE = 0o700;

export class WorkspaceHelperError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "WorkspaceHelperError";
    this.code = code;
  }
}

export function assertLeafNames(bot: string, session: string): void {
  if (!isSingleComponent(bot) || !BOT_NAME.test(bot)) {
    throw new WorkspaceHelperError("invalid_bot");
  }
  if (!isSingleComponent(session) || !SESSION_NAME.test(session)) {
    throw new WorkspaceHelperError("invalid_session");
  }
}

function isSingleComponent(name: string): boolean {
  if (name.length === 0 || name === "." || name === "..") {
    return false;
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return false;
  }
  return true;
}

/**
 * openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS) plus mkdirat.
 * `..`, slashes, and symlinks are rejected here even if the TypeScript checks are skipped.
 * Exits 0 and prints one JSON object. The error field is a fixed code.
 */
export const LEAF_OPENAT_SCRIPT = String.raw`
import ctypes, errno, json, os, re, stat, sys

SYS_openat2 = 437
AT_FDCWD = -100
O_RDONLY = 0
O_DIRECTORY = 0x10000
O_NOFOLLOW = 0x20000
O_CLOEXEC = 0x80000
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08
LOOSE = 0o027
LEAF_MODE = 0o700
BOT_RE = re.compile(r"^[a-z][a-z0-9-]{0,40}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")

class open_how(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint64),
        ("mode", ctypes.c_uint64),
        ("resolve", ctypes.c_uint64),
    ]

libc = ctypes.CDLL(None, use_errno=True)

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")

def fail(code):
    emit({"ok": False, "error": code})
    sys.exit(0)

def openat2(dirfd, name, flags, resolve):
    how = open_how(flags, 0, resolve)
    fd = libc.syscall(
        ctypes.c_long(SYS_openat2),
        ctypes.c_int(dirfd),
        ctypes.c_char_p(name),
        ctypes.byref(how),
        ctypes.c_size_t(ctypes.sizeof(how)),
    )
    if fd < 0:
        return None, ctypes.get_errno()
    return fd, 0

def component(name, pattern, code):
    if not isinstance(name, str) or "\x00" in name or "/" in name or "\\" in name:
        fail(code)
    if name in (".", "..") or pattern.fullmatch(name) is None:
        fail(code)

def mode_loose(fd):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        return True
    return (stat.S_IMODE(info.st_mode) & LOOSE) != 0

def main():
    if os.geteuid() == 0:
        fail("refusing_root")
    req = json.loads(sys.stdin.read())
    root = req.get("root")
    bot = req.get("bot")
    session = req.get("session")
    if not isinstance(root, str) or not root.startswith("/"):
        fail("relative_root")
    component(bot, BOT_RE, "invalid_bot")
    component(session, SESSION_RE, "invalid_session")
    root_fd, err = openat2(
        AT_FDCWD,
        os.fsencode(root),
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
        RESOLVE_NO_SYMLINKS,
    )
    if root_fd is None:
        fail("root_symlink" if err == errno.ELOOP else "root")
    try:
        if mode_loose(root_fd):
            fail("root_loose")
        bot_fd, err = openat2(
            root_fd,
            os.fsencode(bot),
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
            RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH,
        )
        if bot_fd is None:
            if err == errno.ELOOP:
                fail("parent_symlink")
            if err == errno.ENOENT:
                fail("parent_missing")
            fail("parent")
        try:
            if mode_loose(bot_fd):
                fail("parent_loose")
            leaf_flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
            leaf_resolve = RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH
            leaf_fd, err = openat2(bot_fd, os.fsencode(session), leaf_flags, leaf_resolve)
            if leaf_fd is None and err == errno.ENOENT:
                try:
                    os.mkdir(session, LEAF_MODE, dir_fd=bot_fd)
                except FileExistsError:
                    pass
                leaf_fd, err = openat2(bot_fd, os.fsencode(session), leaf_flags, leaf_resolve)
            if leaf_fd is None:
                try:
                    existing = os.lstat(session, dir_fd=bot_fd)
                except FileNotFoundError:
                    existing = None
                if existing is not None and stat.S_ISLNK(existing.st_mode):
                    fail("leaf_symlink")
                if err == errno.ELOOP:
                    fail("leaf_symlink")
                if err == errno.ENOTDIR:
                    fail("leaf_not_directory")
                fail("leaf")
            try:
                os.fchmod(leaf_fd, LEAF_MODE)
                info = os.fstat(leaf_fd)
                if not stat.S_ISDIR(info.st_mode):
                    fail("leaf_not_directory")
                if stat.S_IMODE(info.st_mode) != LEAF_MODE:
                    fail("leaf_mode")
                if info.st_uid != os.geteuid():
                    fail("leaf_owner")
                root_real = os.path.realpath("/proc/self/fd/%d" % root_fd)
                leaf_real = os.path.realpath("/proc/self/fd/%d" % leaf_fd)
                prefix = root_real.rstrip("/") + "/"
                if not leaf_real.startswith(prefix) or leaf_real[len(prefix):] != bot + "/" + session:
                    fail("escape")
            finally:
                os.close(leaf_fd)
        finally:
            os.close(bot_fd)
    finally:
        os.close(root_fd)
    emit({"ok": True})

try:
    main()
except SystemExit:
    raise
except Exception:
    fail("failed")
`;

/** Create or reuse the session leaf. Does not create or chmod the parent. */
export function openatCreateLeaf(root: string, bot: string, session: string): void {
  if (process.getuid?.() === 0) {
    throw new WorkspaceHelperError("refusing_root");
  }
  if (!path.isAbsolute(root)) {
    throw new WorkspaceHelperError("relative_root");
  }
  const result = spawnSync("python3", ["-c", LEAF_OPENAT_SCRIPT], {
    input: JSON.stringify({ root, bot, session }),
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 64 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new WorkspaceHelperError("failed");
  }
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  let parsed: { ok?: boolean; error?: string };
  try {
    parsed = JSON.parse(line) as { ok?: boolean; error?: string };
  } catch {
    throw new WorkspaceHelperError("failed");
  }
  if (parsed.ok === true) {
    return;
  }
  const code = typeof parsed.error === "string" && parsed.error.length > 0 && parsed.error.length < 64 ? parsed.error : "failed";
  throw new WorkspaceHelperError(code);
}

export function createSessionLeaf(root: string, bot: string, session: string): string {
  assertLeafNames(bot, session);
  openatCreateLeaf(root, bot, session);
  return sessionLeafPath(root, bot, session);
}

export function sessionLeafPath(root: string, bot: string, session: string): string {
  assertLeafNames(bot, session);
  if (!path.isAbsolute(root)) {
    throw new WorkspaceHelperError("relative_root");
  }
  const leaf = path.join(root, bot, session);
  const relative = path.relative(root, leaf);
  if (relative !== path.join(bot, session) || relative.split(path.sep).includes("..")) {
    throw new WorkspaceHelperError("escape");
  }
  return leaf;
}

export interface WorkspaceHelper {
  close(): Promise<void>;
}

/**
 * Listen for one JSON line per connection: {"bot","session"}.
 * systemd passes the listening socket as fd 3. Tests pass socketPath.
 */
export function startWorkspaceHelper(options: {
  readonly root: string;
  readonly socketPath?: string;
  readonly fd?: number;
}): Promise<WorkspaceHelper> {
  if (process.getuid?.() === 0) {
    return Promise.reject(new WorkspaceHelperError("refusing_root"));
  }
  if (!path.isAbsolute(options.root)) {
    return Promise.reject(new WorkspaceHelperError("relative_root"));
  }
  const socketPath = options.socketPath;
  if (options.fd === undefined && (socketPath === undefined || socketPath.length === 0)) {
    return Promise.reject(new WorkspaceHelperError("socket_path"));
  }
  if (socketPath !== undefined && fs.existsSync(socketPath)) {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) {
      return Promise.reject(new WorkspaceHelperError("socket_path"));
    }
    fs.unlinkSync(socketPath);
  }
  const server = net.createServer((socket) => {
    socket.setTimeout(5_000);
    void handleConnection(socket, options.root).catch(() => {
      socket.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      reject(error);
    };
    server.once("error", fail);
    const ready = (): void => {
      server.off("error", fail);
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (socketPath !== undefined) {
                try {
                  fs.unlinkSync(socketPath);
                } catch {
                  // The socket is already gone.
                }
              }
              if (error !== undefined) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    };
    if (options.fd !== undefined) {
      server.listen({ fd: options.fd }, ready);
      return;
    }
    server.listen(socketPath, ready);
  });
}

async function handleConnection(socket: net.Socket, root: string): Promise<void> {
  try {
    const request = await readRequest(socket);
    const bot = field(request, "bot");
    const session = field(request, "session");
    if (bot === undefined || session === undefined) {
      reply(socket, "invalid_json");
      return;
    }
    createSessionLeaf(root, bot, session);
    reply(socket, undefined);
  } catch (error) {
    const code = error instanceof WorkspaceHelperError ? error.code : "failed";
    reply(socket, code);
  }
}

function field(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const item = value[key as keyof typeof value];
  return typeof item === "string" ? item : undefined;
}

function reply(socket: net.Socket, error: string | undefined): void {
  const body = error === undefined ? { ok: true } : { ok: false, error };
  socket.end(`${JSON.stringify(body)}\n`);
}

function readRequest(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (code: string): void => {
      if (done) {
        return;
      }
      done = true;
      reject(new WorkspaceHelperError(code));
    };
    socket.on("error", () => {
      fail("unavailable");
    });
    socket.on("timeout", () => {
      fail("timeout");
    });
    socket.on("end", () => {
      fail("invalid_json");
    });
    socket.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > 1024) {
        fail("too_large");
        return;
      }
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const newline = buf.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      done = true;
      try {
        resolve(JSON.parse(buf.subarray(0, newline).toString("utf8")) as unknown);
      } catch {
        reject(new WorkspaceHelperError("invalid_json"));
      }
    });
  });
}

/** agentctl calls this. It does not create directories. */
export function requestSessionLeaf(socketPath: string, root: string, bot: string, session: string): Promise<string> {
  assertLeafNames(bot, session);
  const leaf = sessionLeafPath(root, bot, session);
  return askHelper(socketPath, bot, session).then((response) => {
    if (!response.ok) {
      throw new WorkspaceHelperError(response.error ?? "failed");
    }
    return leaf;
  });
}

function askHelper(socketPath: string, bot: string, session: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      fn();
    };
    socket.setTimeout(5_000);
    socket.on("timeout", () => {
      finish(() => {
        reject(new WorkspaceHelperError("timeout"));
      });
    });
    socket.on("error", () => {
      finish(() => {
        reject(new WorkspaceHelperError("unavailable"));
      });
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ bot, session })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length > 1024) {
        finish(() => {
          reject(new WorkspaceHelperError("invalid_response"));
        });
        return;
      }
      const newline = buf.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buf.subarray(0, newline).toString("utf8")) as unknown;
      } catch {
        finish(() => {
          reject(new WorkspaceHelperError("invalid_response"));
        });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || !("ok" in parsed) || typeof parsed.ok !== "boolean") {
        finish(() => {
          reject(new WorkspaceHelperError("invalid_response"));
        });
        return;
      }
      const error = "error" in parsed && typeof parsed.error === "string" ? parsed.error : undefined;
      const ok = parsed.ok;
      finish(() => {
        resolve({ ok, error });
      });
    });
  });
}

/**
 * sd_listen_fds(3): fd 3 is the socket only when LISTEN_FDS=1 and LISTEN_PID
 * is unset or equal to this process. A mismatched LISTEN_PID is not our socket.
 */
export function systemdListenFd(): number | undefined {
  if (process.env.LISTEN_FDS !== "1") {
    return undefined;
  }
  const listenPid = process.env.LISTEN_PID;
  if (listenPid !== undefined && listenPid !== String(process.pid)) {
    return undefined;
  }
  return 3;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const root = flag("--root") ?? process.env.PPA_WORKSPACE_ROOT ?? "/home/sbx/workspaces";
  const socketPath = flag("--socket");
  const fd = socketPath === undefined ? systemdListenFd() : undefined;
  delete process.env.LISTEN_FDS;
  delete process.env.LISTEN_PID;
  delete process.env.LISTEN_FDNAMES;
  void startWorkspaceHelper({ root, socketPath, fd }).catch(() => {
    process.stderr.write("workspace helper failed\n");
    process.exitCode = 1;
  });
}
