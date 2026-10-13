import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFileOpArgv } from "../../src/sandbox/file-op.ts";
import type { PodmanExecResult } from "../../src/sandbox/podman.ts";
import { startTestRig, type TestRig } from "./fixture.ts";
import { openTestSocket, waitForText, type TestSocket } from "./http.ts";

const rigs: TestRig[] = [];
const sockets: TestSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

describe("workspace file ops through the helper and container exec", () => {
  it("creates a 0700 leaf, binds it, and does not open it on the host", async () => {
    const memory = new Map<string, Map<string, Buffer>>();
    const rig = await startTestRig({
      exec: async (_runtime, id, command, options) => simulate(memory, id, command, options?.stdin),
    });
    rigs.push(rig);
    const ops = required(rig);
    ops.setResponses([
      fauxAssistantMessage(fauxToolCall("write_file", { path: "note.txt", content: "leaf-secret" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_file", { path: "note.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("exec", { command: "printf hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("ops-roundtrip"),
    ]);
    const socket = await openTestSocket(rig.controller.port, rig.token);
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    const opsDir = path.join(rig.workspaceRoot, "ops");
    const trap = trapLeafOpens(opsDir);
    try {
      await rig.controller.submit("ops", "root", "write and read", "req-leaf-ops");
      const view = await waitForText(socket, "ops-roundtrip");
      expect(view).toContain("wrote");
      expect(view).toContain("leaf-secret");
      expect(view).toContain("exit 0");
      const names = fs.readdirSync(opsDir);
      expect(names).toHaveLength(1);
      const leaf = path.join(opsDir, names[0] ?? "");
      expect(fs.statSync(leaf).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(leaf)).toEqual([]);
      const bind = rig.podman.spec?.mounts.find((mount) => mount.type === "bind");
      expect(bind?.destination).toBe("/workspace");
      expect(bind?.source).toBe(path.resolve(leaf));
      const parsed = rig.podman.execs.map((entry) => parseFileOpArgv(entry.command));
      expect(parsed.some((entry) => entry?.op === "write" && entry.path === "/workspace/note.txt")).toBe(true);
      expect(parsed.some((entry) => entry?.op === "read" && entry.path === "/workspace/note.txt")).toBe(true);
      const write = rig.podman.execs.find((entry) => parseFileOpArgv(entry.command)?.op === "write");
      expect(Buffer.from(write?.stdin ?? new Uint8Array()).toString("utf8")).toBe("leaf-secret");
      expect(rig.podman.execs.some((entry) => entry.command === "printf hi")).toBe(true);
      expect(trap.hits).toEqual([]);
      expect(memory.get(containerId(rig))?.get("/workspace/note.txt")?.toString("utf8")).toBe("leaf-secret");
    } finally {
      trap.restore();
    }
  });
});

function required(rig: TestRig) {
  const faux = rig.faux.get("ops");
  if (faux === undefined) {
    throw new Error("ops");
  }
  return faux;
}

function containerId(rig: TestRig): string {
  const started = rig.podman.events.find((event) => event.startsWith("start:crun:"));
  const id = started?.slice("start:crun:".length);
  if (id === undefined || id.length === 0) {
    throw new Error("missing container");
  }
  return id;
}

function simulate(
  memory: Map<string, Map<string, Buffer>>,
  id: string,
  command: string | readonly string[],
  stdin: Uint8Array | undefined,
): PodmanExecResult {
  const parsed = parseFileOpArgv(command);
  if (parsed === undefined) {
    return done(0, Buffer.alloc(0));
  }
  let bucket = memory.get(id);
  if (bucket === undefined) {
    bucket = new Map();
    memory.set(id, bucket);
  }
  if (parsed.op === "write") {
    bucket.set(parsed.path, Buffer.from(stdin ?? new Uint8Array()));
    return done(0, Buffer.alloc(0));
  }
  if (parsed.op === "read") {
    const bytes = bucket.get(parsed.path);
    return bytes === undefined ? done(1, Buffer.alloc(0), "not_found\n") : done(0, bytes);
  }
  if (parsed.op === "stat" && parsed.path === "/workspace") {
    return done(0, Buffer.from("directory 0 0\n"));
  }
  if (parsed.op === "list") {
    return done(0, Buffer.alloc(0));
  }
  if (parsed.op === "exists") {
    const yes = parsed.path === "/workspace" || bucket.has(parsed.path);
    return done(0, Buffer.from(yes ? "yes\n" : "no\n"));
  }
  return done(1, Buffer.alloc(0), "not_found\n");
}

function done(exitCode: number, stdout: Buffer, stderr = ""): PodmanExecResult {
  return { exitCode, stdout: stdout.toString("utf8"), stderr, stdoutBytes: stdout };
}

function trapLeafOpens(leaf: string): { hits: string[]; restore(): void } {
  const hits: string[] = [];
  const note = (file: unknown): void => {
    const value = typeof file === "string" ? file : file instanceof URL ? file.pathname : "";
    if (value.length === 0) {
      return;
    }
    const resolved = path.resolve(value);
    if (resolved.startsWith(`${leaf}${path.sep}`)) {
      hits.push(resolved);
    }
  };
  const originals = {
    openSync: fs.openSync,
    open: fs.open,
    readFileSync: fs.readFileSync,
    readFile: fs.readFile,
    writeFileSync: fs.writeFileSync,
    writeFile: fs.writeFile,
    appendFileSync: fs.appendFileSync,
    appendFile: fs.appendFile,
    watch: fs.watch,
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream,
    promisesOpen: fs.promises.open,
    promisesReadFile: fs.promises.readFile,
    promisesWriteFile: fs.promises.writeFile,
  };
  const wrap = <T extends (file: fs.PathLike, ...args: never[]) => unknown>(fn: T): T => {
    return ((file: fs.PathLike, ...args: never[]) => {
      note(file);
      return fn(file, ...args);
    }) as T;
  };
  fs.openSync = wrap(fs.openSync);
  fs.open = wrap(fs.open);
  fs.readFileSync = wrap(fs.readFileSync);
  fs.readFile = wrap(fs.readFile);
  fs.writeFileSync = wrap(fs.writeFileSync);
  fs.writeFile = wrap(fs.writeFile);
  fs.appendFileSync = wrap(fs.appendFileSync);
  fs.appendFile = wrap(fs.appendFile);
  fs.watch = wrap(fs.watch);
  fs.createReadStream = wrap(fs.createReadStream);
  fs.createWriteStream = wrap(fs.createWriteStream);
  fs.promises.open = wrap(fs.promises.open);
  fs.promises.readFile = wrap(fs.promises.readFile);
  fs.promises.writeFile = wrap(fs.promises.writeFile);
  return {
    hits,
    restore() {
      fs.openSync = originals.openSync;
      fs.open = originals.open;
      fs.readFileSync = originals.readFileSync;
      fs.readFile = originals.readFile;
      fs.writeFileSync = originals.writeFileSync;
      fs.writeFile = originals.writeFile;
      fs.appendFileSync = originals.appendFileSync;
      fs.appendFile = originals.appendFile;
      fs.watch = originals.watch;
      fs.createReadStream = originals.createReadStream;
      fs.createWriteStream = originals.createWriteStream;
      fs.promises.open = originals.promisesOpen;
      fs.promises.readFile = originals.promisesReadFile;
      fs.promises.writeFile = originals.promisesWriteFile;
    },
  };
}
