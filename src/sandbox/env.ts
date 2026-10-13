import type { Context } from "@earendil-works/chord";
import path from "node:path";
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { SANDBOX_PROXY_ENV } from "./flags.ts";
import {
  CONTAINER_WORKSPACE,
  confineWorkspacePath,
  fileOpArgv,
} from "./file-op.ts";
import type { PodmanClient, PodmanExecResult } from "./podman.ts";
import type { SandboxPool, SandboxSession } from "./pool.ts";

const SECRET_NAME = /token|secret|password|passwd|cookie|authorization|api[_-]?key|credential/i;
const OP_CODES = new Set([
  "escape",
  "dotdot",
  "nul",
  "symlink",
  "hardlink",
  "not_found",
  "not_file",
  "not_directory",
  "invalid",
  "unknown",
  "root",
]);

export function containerEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = { ...SANDBOX_PROXY_ENV };
  if (extra === undefined) {
    return env;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (SECRET_NAME.test(key) || SECRET_NAME.test(value) || value.includes("/home/agentctl")) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * One conversation's files and shell. `id` is `<bot>/<session>`.
 * Every file operation is a container exec. This process does not open the leaf.
 */
export class SandboxExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private readonly pool: SandboxPool;
  private readonly client: PodmanClient;
  private readonly session: SandboxSession;

  constructor(pool: SandboxPool, client: PodmanClient, session: SandboxSession) {
    this.pool = pool;
    this.client = client;
    this.session = session;
    this.id = `${session.bot}/${session.session}`;
    this.cwd = CONTAINER_WORKSPACE;
  }

  async absolutePath(input: string, _context: Context): Promise<Result<string, FileError>> {
    try {
      return ok(confineWorkspacePath(this.cwd, input));
    } catch (error) {
      return err(asFileError(error, input));
    }
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(path.posix.join(...parts));
  }

  async readTextFile(filePath: string, context: Context): Promise<Result<string, FileError>> {
    const binary = await this.readBinaryFile(filePath, context);
    if (!binary.ok) {
      return binary;
    }
    return ok(new TextDecoder().decode(binary.value));
  }

  async readBinaryFile(filePath: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.runOp("read", filePath, undefined, undefined, context);
  }

  async readTextLines(filePath: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(filePath, context);
    if (!text.ok) {
      return text;
    }
    const lines = text.value.split("\n");
    const max = options?.maxLines;
    return ok(max === undefined ? lines : lines.slice(0, max));
  }

  async openTextLineReader(filePath: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(filePath, context);
    if (!text.ok) {
      return text;
    }
    const lines = text.value.split("\n");
    let index = 0;
    return ok({
      readLine: () => {
        if (index >= lines.length) {
          return Promise.resolve(ok(undefined));
        }
        const line = lines[index] ?? "";
        index += 1;
        const last = index === lines.length;
        const terminated = !last || text.value.endsWith("\n");
        return Promise.resolve(ok<TextLine, FileError>({ text: line, terminated }));
      },
      close: () => Promise.resolve(),
    });
  }

  async openBinaryReader(filePath: string, _options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const binary = await this.readBinaryFile(filePath, context);
    if (!binary.ok) {
      return binary;
    }
    const bytes = binary.value;
    const info = await this.fileInfo(filePath, context);
    if (!info.ok) {
      return info;
    }
    return ok({
      info: () => Promise.resolve(ok(info.value)),
      read: (offset, length) => {
        const start = Math.max(0, offset);
        const end = Math.min(bytes.length, start + length);
        return Promise.resolve(ok(bytes.slice(start, end)));
      },
      scanLines: () => Promise.resolve(err(new FileError("not_supported", "not_supported", filePath))),
      close: () => Promise.resolve(),
    });
  }

  async writeFile(filePath: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const wrote = await this.runOp("write", filePath, toBytes(content), undefined, context);
    return wrote.ok ? ok(undefined) : wrote;
  }

  async appendFile(filePath: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const wrote = await this.runOp("append", filePath, toBytes(content), undefined, context);
    return wrote.ok ? ok(undefined) : wrote;
  }

  async truncateFile(filePath: string, size: number, context: Context): Promise<Result<void, FileError>> {
    if (!Number.isInteger(size) || size < 0) {
      return err(new FileError("invalid", "invalid", filePath));
    }
    const truncated = await this.runOp("truncate", filePath, undefined, String(size), context);
    return truncated.ok ? ok(undefined) : truncated;
  }

  async flushFile(filePath: string, context: Context): Promise<Result<void, FileError>> {
    const flushed = await this.runOp("flush", filePath, undefined, undefined, context);
    return flushed.ok ? ok(undefined) : flushed;
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    let destination: string;
    try {
      destination = confineWorkspacePath(this.cwd, destinationPath);
    } catch (error) {
      return err(asFileError(error, destinationPath));
    }
    const renamed = await this.runOp("rename", sourcePath, undefined, destination, context);
    return renamed.ok ? ok(undefined) : renamed;
  }

  async fileInfo(filePath: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const container = this.tryConfine(filePath);
    if (!container.ok) {
      return container;
    }
    const stat = await this.runOp("stat", container.value, undefined, undefined, context);
    if (!stat.ok) {
      return stat;
    }
    const line = Buffer.from(stat.value).toString("utf8").trim();
    const match = /^(file|directory) (\d+) (\d+)$/.exec(line);
    if (match === null) {
      return err(new FileError("unknown", "unknown", filePath));
    }
    const kind = match[1];
    const size = match[2];
    const mtime = match[3];
    if ((kind !== "file" && kind !== "directory") || size === undefined || mtime === undefined) {
      return err(new FileError("unknown", "unknown", filePath));
    }
    return ok({
      name: path.posix.basename(container.value),
      path: container.value,
      kind,
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    });
  }

  async listDir(dirPath: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const container = this.tryConfine(dirPath);
    if (!container.ok) {
      return container;
    }
    const listed = await this.runOp("list", container.value, undefined, undefined, context);
    if (!listed.ok) {
      return listed;
    }
    const text = Buffer.from(listed.value).toString("utf8");
    const entries: FileInfo[] = [];
    if (text.length === 0) {
      return ok(entries);
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const parts = line.split("\t");
      const name = parts[0];
      const kind = parts[1];
      const size = parts[2];
      const mtime = parts[3];
      if (name === undefined || !isKind(kind) || size === undefined || mtime === undefined || !/^\d+$/.test(size) || !/^\d+$/.test(mtime)) {
        return err(new FileError("unknown", "unknown", dirPath));
      }
      entries.push({
        name,
        path: path.posix.join(container.value, name),
        kind,
        size: Number(size),
        mtimeMs: Number(mtime) * 1000,
      });
    }
    return ok(entries);
  }

  async openDirReader(dirPath: string, context: Context): Promise<Result<DirReader, FileError>> {
    const listed = await this.listDir(dirPath, context);
    if (!listed.ok) {
      return listed;
    }
    let index = 0;
    const entries = listed.value;
    return ok({
      next: (maxEntries) => {
        const slice = entries.slice(index, index + maxEntries);
        index += slice.length;
        return Promise.resolve(ok({ entries: slice, done: index >= entries.length }));
      },
      close: () => Promise.resolve(),
    });
  }

  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    for (const target of targets) {
      const confined = this.tryConfine(target.path);
      if (!confined.ok) {
        return confined;
      }
    }
    const snapshots = new Map<string, string>();
    let closed = false;
    const poll = async (): Promise<void> => {
      if (closed) {
        return;
      }
      for (const target of targets) {
        const listed = await this.listDir(target.path, context);
        const signature = listed.ok
          ? listed.value.map((entry) => `${entry.path}\t${entry.kind}\t${entry.size}\t${entry.mtimeMs}`).join("\n")
          : `missing:${listed.error.code}`;
        const previous = snapshots.get(target.path);
        snapshots.set(target.path, signature);
        if (!closed && previous !== undefined && previous !== signature) {
          onChange({ paths: [target.path] });
        }
      }
    };
    await poll();
    const timer = setInterval(() => {
      void poll().catch(() => undefined);
    }, 500);
    timer.unref();
    return ok({
      mode: "polling",
      close: () => {
        closed = true;
        clearInterval(timer);
        return Promise.resolve();
      },
    });
  }

  async canonicalPath(filePath: string, context: Context): Promise<Result<string, FileError>> {
    return this.absolutePath(filePath, context);
  }

  async exists(filePath: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.runOp("exists", filePath, undefined, undefined, context);
    if (!result.ok) {
      if (result.error.code === "not_found") {
        return ok(false);
      }
      return result;
    }
    return ok(Buffer.from(result.value).toString("utf8").trim() === "yes");
  }

  async createDir(dirPath: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const created = await this.runOp("mkdir", dirPath, undefined, options?.recursive === true ? "recursive" : "plain", context);
    return created.ok ? ok(undefined) : created;
  }

  async remove(filePath: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const confined = this.tryConfine(filePath);
    if (!confined.ok) {
      return confined;
    }
    if (confined.value === CONTAINER_WORKSPACE) {
      return err(new FileError("invalid", "refusing to remove the workspace root", filePath));
    }
    const mode = options?.recursive === true
      ? (options.force === true ? "recursive-force" : "recursive")
      : (options?.force === true ? "force" : "plain");
    const removed = await this.runOp("rm", confined.value, undefined, mode, context);
    return removed.ok ? ok(undefined) : removed;
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const safe = safeTempComponent(prefix ?? "tmp-");
    if (safe === undefined) {
      return err(new FileError("invalid", "invalid", prefix ?? ".tmp"));
    }
    const created = await this.runOp("mktemp-dir", CONTAINER_WORKSPACE, undefined, safe, context);
    if (!created.ok) {
      return created;
    }
    return this.tempPath(created.value);
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const prefix = safeTempComponent(options?.prefix ?? "tmp-");
    const suffix = safeTempComponent(options?.suffix ?? "");
    if (prefix === undefined || suffix === undefined) {
      return err(new FileError("invalid", "invalid", "temp"));
    }
    const created = await this.runOp("mktemp-file", prefix, undefined, suffix, context, true);
    if (!created.ok) {
      return created;
    }
    return this.tempPath(created.value);
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", "aborted"));
    }
    let lease: { release(): void; containerId: string } | undefined;
    try {
      lease = await this.pool.acquire(this.session, context.abortSignal);
      const result = await withAbort(
        this.client.exec(this.session.runtime, lease.containerId, command, {
          cwd: CONTAINER_WORKSPACE,
          env: containerEnv(options?.env),
        }),
        context.abortSignal,
      );
      options?.onOutput?.(result.stdout, context, { stream: "stdout" });
      if (result.stderr.length > 0) {
        options?.onOutput?.(result.stderr, context, { stream: "stderr" });
      }
      return ok({ exitCode: result.exitCode });
    } catch (error) {
      if (context.abortSignal?.aborted) {
        return err(new ExecutionError("aborted", "aborted"));
      }
      const message = error instanceof Error ? error.name : "unknown";
      return err(new ExecutionError("unknown", message));
    } finally {
      lease?.release();
    }
  }

  async cleanup(_context: Context): Promise<void> {
    // The pool is shared by every bot. Idle timeout and controller shutdown stop containers.
  }

  private tryConfine(input: string): Result<string, FileError> {
    try {
      return ok(confineWorkspacePath(this.cwd, input));
    } catch (error) {
      return err(asFileError(error, input));
    }
  }

  private tempPath(stdout: Uint8Array): Result<string, FileError> {
    const relative = Buffer.from(stdout).toString("utf8").trim();
    if (relative.length === 0 || relative.startsWith("/") || relative.split("/").includes("..")) {
      return err(new FileError("invalid", "escape", ".tmp"));
    }
    return ok(`${CONTAINER_WORKSPACE}/${relative}`);
  }

  private async runOp(
    op: string,
    requestPath: string,
    stdin: Uint8Array | undefined,
    extra: string | undefined,
    context: Context,
    literalPath = false,
  ): Promise<Result<Uint8Array, FileError>> {
    let containerPath = requestPath;
    if (!literalPath) {
      const confined = this.tryConfine(requestPath);
      if (!confined.ok) {
        return confined;
      }
      containerPath = confined.value;
    }
    if (context.abortSignal?.aborted) {
      return err(new FileError("aborted", "aborted", requestPath));
    }
    let lease: { release(): void; containerId: string } | undefined;
    try {
      lease = await this.pool.acquire(this.session, context.abortSignal);
      const result = await withAbort(
        this.client.exec(this.session.runtime, lease.containerId, fileOpArgv(op, containerPath, extra), {
          cwd: CONTAINER_WORKSPACE,
          env: containerEnv(undefined),
          stdin,
        }),
        context.abortSignal,
      );
      return decodeOpResult(result, requestPath);
    } catch (error) {
      if (context.abortSignal?.aborted) {
        return err(new FileError("aborted", "aborted", requestPath));
      }
      if (error instanceof FileError) {
        return err(error);
      }
      return err(new FileError("unknown", "unknown", requestPath));
    } finally {
      lease?.release();
    }
  }
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? Buffer.from(content) : content;
}

function decodeOpResult(result: PodmanExecResult, requestPath: string): Result<Uint8Array, FileError> {
  const stdout = result.stdoutBytes === undefined ? Buffer.from(result.stdout) : Buffer.from(result.stdoutBytes);
  if (result.exitCode !== 0) {
    return err(fileErrorFromStderr(result.stderr, requestPath));
  }
  return ok(stdout);
}

function fileErrorFromStderr(stderr: string, requestPath: string): FileError {
  const token = stderr.trim().split("\n")[0] ?? "";
  if (!OP_CODES.has(token)) {
    return new FileError("unknown", "unknown", requestPath);
  }
  if (token === "not_found" || token === "root") {
    return new FileError("not_found", token, requestPath);
  }
  if (token === "not_directory") {
    return new FileError("not_directory", token, requestPath);
  }
  if (token === "not_file") {
    return new FileError("is_directory", token, requestPath);
  }
  return new FileError("invalid", token, requestPath);
}

function isKind(value: string | undefined): value is FileKind {
  return value === "file" || value === "directory" || value === "symlink";
}

function safeTempComponent(value: string): string | undefined {
  if (!/^[A-Za-z0-9._-]{0,40}$/.test(value)) {
    return undefined;
  }
  return value;
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return work;
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    if (signal.aborted) {
      onAbort();
      work.then(
        () => undefined,
        () => undefined,
      );
      return;
    }
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function asFileError(error: unknown, requestPath: string): FileError {
  if (error instanceof FileError) {
    return error;
  }
  return new FileError("unknown", "unknown", requestPath);
}
