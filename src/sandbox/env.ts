import type { Context } from "@earendil-works/chord";
import fs from "node:fs";
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
import type { PodmanClient } from "./podman.ts";
import type { SandboxPool, SandboxSession } from "./pool.ts";
import { PathEscapeError, readWorkspaceFile } from "./workspace-read.ts";

const SECRET_NAME = /token|secret|password|passwd|cookie|authorization|api[_-]?key|credential/i;

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
 * Reads use openat2. Exec goes through the pool and never inherits the controller environment.
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
    this.cwd = "/workspace";
  }

  async absolutePath(input: string, _context: Context): Promise<Result<string, FileError>> {
    try {
      return ok(this.containerPath(input));
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

  async readBinaryFile(filePath: string, _context: Context): Promise<Result<Uint8Array, FileError>> {
    try {
      const host = this.hostFile(filePath);
      return ok(readWorkspaceFile(this.session.workspaceLeaf, host.relative));
    } catch (error) {
      return err(asFileError(error, filePath));
    }
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

  async writeFile(filePath: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    return this.mutate(filePath, (host) => {
      const data = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
      const fd = fs.openSync(host, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
      try {
        fs.writeFileSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
    });
  }

  async appendFile(filePath: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    return this.mutate(filePath, (host) => {
      const data = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
      const fd = fs.openSync(host, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o644);
      try {
        fs.writeFileSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
    });
  }

  async truncateFile(filePath: string, size: number, _context: Context): Promise<Result<void, FileError>> {
    return this.mutate(filePath, (host) => {
      const fd = fs.openSync(host, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try {
        fs.ftruncateSync(fd, size);
      } finally {
        fs.closeSync(fd);
      }
    });
  }

  async flushFile(filePath: string, _context: Context): Promise<Result<void, FileError>> {
    return this.mutate(filePath, (host) => {
      const fd = fs.openSync(host, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    });
  }

  async renameFile(sourcePath: string, destinationPath: string, _context: Context): Promise<Result<void, FileError>> {
    try {
      const source = this.hostFile(sourcePath);
      const destination = this.hostFile(destinationPath);
      this.assertParentsReal(destination.relative);
      fs.renameSync(source.absolute, destination.absolute);
      return ok(undefined);
    } catch (error) {
      return err(asFileError(error, sourcePath));
    }
  }

  async fileInfo(filePath: string, _context: Context): Promise<Result<FileInfo, FileError>> {
    try {
      const host = this.hostFile(filePath);
      const stat = fs.lstatSync(host.absolute);
      if (stat.isSymbolicLink()) {
        return err(new FileError("invalid", "symlink", filePath));
      }
      return ok(toInfo(host.container, stat));
    } catch (error) {
      return err(asFileError(error, filePath));
    }
  }

  async listDir(dirPath: string, _context: Context): Promise<Result<FileInfo[], FileError>> {
    try {
      const host = this.hostDir(dirPath);
      const names = fs.readdirSync(host.absolute);
      const entries: FileInfo[] = [];
      for (const name of names) {
        const stat = fs.lstatSync(path.join(host.absolute, name));
        entries.push(toInfo(path.posix.join(host.container, name), stat));
      }
      return ok(entries);
    } catch (error) {
      return err(asFileError(error, dirPath));
    }
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

  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, _context: Context): Promise<Result<FileWatcher, FileError>> {
    const watchers: fs.FSWatcher[] = [];
    try {
      for (const target of targets) {
        const host = this.hostDir(target.path);
        const watcher = fs.watch(host.absolute, { recursive: target.recursive === true }, () => {
          onChange({ paths: [target.path] });
        });
        watchers.push(watcher);
      }
    } catch (error) {
      for (const watcher of watchers) {
        watcher.close();
      }
      return err(asFileError(error, targets[0]?.path ?? "/workspace"));
    }
    return ok({
      mode: "native",
      close: () => {
        for (const watcher of watchers) {
          watcher.close();
        }
        return Promise.resolve();
      },
    });
  }

  async canonicalPath(filePath: string, context: Context): Promise<Result<string, FileError>> {
    return this.absolutePath(filePath, context);
  }

  async exists(filePath: string, _context: Context): Promise<Result<boolean, FileError>> {
    try {
      const host = this.hostFile(filePath);
      return ok(fs.existsSync(host.absolute));
    } catch (error) {
      if (error instanceof FileError && error.code === "invalid") {
        return err(error);
      }
      return ok(false);
    }
  }

  async createDir(dirPath: string, options: { recursive?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    try {
      const host = this.hostDir(dirPath);
      this.assertParentsReal(path.posix.dirname(host.relative));
      fs.mkdirSync(host.absolute, { recursive: options?.recursive === true });
      return ok(undefined);
    } catch (error) {
      return err(asFileError(error, dirPath));
    }
  }

  async remove(filePath: string, options: { recursive?: boolean; force?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    try {
      const host = this.hostFile(filePath);
      if (host.relative.length === 0) {
        return err(new FileError("invalid", "refusing to remove the workspace root", filePath));
      }
      fs.rmSync(host.absolute, { recursive: options?.recursive === true, force: options?.force === true });
      return ok(undefined);
    } catch (error) {
      return err(asFileError(error, filePath));
    }
  }

  async createTempDir(prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
    try {
      const base = path.join(this.session.workspaceLeaf, ".tmp");
      fs.mkdirSync(base, { recursive: true });
      const created = fs.mkdtempSync(path.join(base, prefix ?? "tmp-"));
      const relative = path.relative(this.session.workspaceLeaf, created);
      return ok(path.posix.join("/workspace", relative.split(path.sep).join("/")));
    } catch (error) {
      return err(asFileError(error, prefix ?? ".tmp"));
    }
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, _context: Context): Promise<Result<string, FileError>> {
    try {
      const base = path.join(this.session.workspaceLeaf, ".tmp");
      fs.mkdirSync(base, { recursive: true });
      const fd = fs.openSync(path.join(base, `${options?.prefix ?? "tmp-"}${Date.now()}${options?.suffix ?? ""}`), "wx", 0o644);
      const filename = path.basename(fs.readlinkSync(`/proc/self/fd/${fd}`));
      fs.closeSync(fd);
      return ok(`/workspace/.tmp/${filename}`);
    } catch (error) {
      return err(asFileError(error, "temp"));
    }
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
          cwd: "/workspace",
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

  private mutate(filePath: string, write: (host: string) => void): Result<void, FileError> {
    try {
      const host = this.hostFile(filePath);
      this.assertParentsReal(path.posix.dirname(host.relative));
      if (fs.existsSync(host.absolute) && fs.lstatSync(host.absolute).isSymbolicLink()) {
        return err(new FileError("invalid", "symlink", filePath));
      }
      write(host.absolute);
      return ok(undefined);
    } catch (error) {
      return err(asFileError(error, filePath));
    }
  }

  private containerPath(input: string): string {
    return this.hostFile(input).container;
  }

  private hostFile(input: string): { container: string; relative: string; absolute: string } {
    const container = normalizeContainer(this.cwd, input);
    const relative = container === "/workspace" ? "" : container.slice("/workspace/".length);
    return {
      container,
      relative,
      absolute: relative.length === 0 ? this.session.workspaceLeaf : path.join(this.session.workspaceLeaf, relative),
    };
  }

  private hostDir(input: string): { container: string; relative: string; absolute: string } {
    const host = this.hostFile(input);
    if (host.relative.length > 0) {
      const stat = fs.lstatSync(host.absolute);
      if (stat.isSymbolicLink()) {
        throw new FileError("invalid", "symlink", input);
      }
      if (!stat.isDirectory()) {
        throw new FileError("not_directory", "not_directory", input);
      }
    }
    return host;
  }

  private assertParentsReal(relativeDir: string): void {
    if (relativeDir === "." || relativeDir.length === 0 || relativeDir === "/") {
      return;
    }
    const parts = relativeDir.split("/").filter((part) => part.length > 0 && part !== ".");
    let current = this.session.workspaceLeaf;
    for (const part of parts) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) {
        return;
      }
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new FileError("invalid", "symlink", relativeDir);
      }
    }
  }
}

function normalizeContainer(cwd: string, input: string): string {
  const joined = input.startsWith("/") ? input : path.posix.join(cwd, input);
  const normalized = path.posix.normalize(joined);
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
    throw new FileError("invalid", "escape", input);
  }
  if (normalized.split("/").includes("..")) {
    throw new FileError("invalid", "dotdot", input);
  }
  return normalized;
}

function toInfo(containerPath: string, stat: fs.Stats): FileInfo {
  const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
  return {
    name: path.posix.basename(containerPath),
    path: containerPath,
    kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
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
  if (error instanceof PathEscapeError) {
    if (error.code === "not_found" || error.code === "root") {
      return new FileError("not_found", error.code, requestPath);
    }
    if (error.code === "not_dir") {
      return new FileError("not_directory", error.code, requestPath);
    }
    if (error.code === "not_file") {
      return new FileError("is_directory", error.code, requestPath);
    }
    return new FileError("invalid", error.code, requestPath);
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return new FileError("not_found", "not_found", requestPath);
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP") {
    return new FileError("invalid", "symlink", requestPath);
  }
  return new FileError("unknown", "unknown", requestPath);
}
