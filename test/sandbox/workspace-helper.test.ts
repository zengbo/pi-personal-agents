import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { refuseDisabledRuntime, RUNSC_DISABLED_MESSAGE } from "../../src/sandbox/runtime-guard.ts";
import { parentAclArgs } from "../../src/sandbox/workspace.ts";
import {
  createSessionLeaf,
  LEAF_MODE,
  LEAF_OPENAT_SCRIPT,
  openatCreateLeaf,
  requestSessionLeaf,
  startWorkspaceHelper,
  WorkspaceHelperError,
} from "../../src/sandbox/workspace-helper.ts";

describe("sbx workspace helper", () => {
  it("creates a 0700 leaf owned by this process and does not loosen the parent", () => {
    const root = tree();
    try {
      const parent = bot(root, "ops");
      const leaf = createSessionLeaf(root, "ops", "sess");
      expect(statSync(parent).mode & 0o777).toBe(0o750);
      expect(statSync(leaf).mode & 0o777).toBe(LEAF_MODE);
      expect(statSync(leaf).uid).toBe(process.getuid?.());
      expect(statSync(root).mode & 0o777).toBe(0o750);
      createSessionLeaf(root, "ops", "sess");
      expect(statSync(leaf).mode & 0o777).toBe(LEAF_MODE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a parent looser than 0750 and does not chmod it", () => {
    const root = tree();
    try {
      const parent = bot(root, "ops", 0o755);
      expect(() => createSessionLeaf(root, "ops", "sess")).toThrow(WorkspaceHelperError);
      expect(statSync(parent).mode & 0o777).toBe(0o755);
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create a missing bot parent", () => {
    const root = tree();
    try {
      expect(() => createSessionLeaf(root, "ops", "sess")).toThrow(/parent_missing/);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malicious names and does not create directories for them", () => {
    const root = tree();
    const outside = mkdtempSync(path.join(tmpdir(), "ppa-outside-"));
    try {
      bot(root, "ops");
      const attacks = [
        ["..", "sess"],
        ["../etc", "sess"],
        ["/etc", "sess"],
        ["foo/bar", "sess"],
        ["ops", ".."],
        ["ops", "../etc"],
        ["ops", "foo/bar"],
        ["ops", "foo/../../tmp/pwn"],
        ["ops", "/tmp/pwn"],
        ["ops", ""],
        ["ops", "."],
        ["ops", "a\0b"],
        ["ops", "has space"],
        ["Ops", "sess"],
        ["ops", `a${"b".repeat(90)}`],
        ["", "sess"],
        [".", "sess"],
      ];
      for (const [name, session] of attacks) {
        expect(() => createSessionLeaf(root, name ?? "", session ?? ""), `${name}/${session}`).toThrow(WorkspaceHelperError);
      }
      expect(readdirSync(path.join(root, "ops"))).toEqual([]);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked bot directory and a symlinked leaf without writing outside", () => {
    const root = tree();
    const outside = mkdtempSync(path.join(tmpdir(), "ppa-outside-"));
    try {
      const link = path.join(root, "ops");
      symlinkSync(outside, link);
      expect(() => openatCreateLeaf(root, "ops", "sess")).toThrow(WorkspaceHelperError);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readdirSync(outside)).toEqual([]);

      rmSync(link);
      const parent = bot(root, "ops");
      const leafLink = path.join(parent, "sess");
      symlinkSync(outside, leafLink);
      expect(() => openatCreateLeaf(root, "ops", "sess")).toThrow(/leaf_symlink/);
      expect(lstatSync(leafLink).isSymbolicLink()).toBe(true);
      expect(readdirSync(outside)).toEqual([]);
      expect(LEAF_OPENAT_SCRIPT).not.toContain("os.path.join");
      expect(LEAF_OPENAT_SCRIPT).not.toMatch(/os\.chmod\(/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects dotdot in the openat script even when the TypeScript check is skipped", () => {
    const root = tree();
    try {
      bot(root, "ops");
      expect(() => openatCreateLeaf(root, "..", "sess")).toThrow(WorkspaceHelperError);
      expect(() => openatCreateLeaf(root, "ops", "..")).toThrow(WorkspaceHelperError);
      expect(() => openatCreateLeaf(root, "ops/../../tmp", "sess")).toThrow(WorkspaceHelperError);
      expect(readdirSync(root).sort()).toEqual(["ops"]);
      expect(readdirSync(path.join(root, "ops"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the client request a leaf without creating it", async () => {
    const root = tree();
    const socketPath = path.join(root, "helper.sock");
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.end('{"ok":true}\n');
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => resolve());
    });
    try {
      bot(root, "ops");
      const leaf = await requestSessionLeaf(socketPath, root, "ops", "sess");
      expect(leaf).toBe(path.join(root, "ops", "sess"));
      expect(statSync(path.join(root, "ops")).mode & 0o777).toBe(0o750);
      let missing = false;
      try {
        statSync(leaf);
      } catch {
        missing = true;
      }
      expect(missing).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the leaf through the socket and refuses a malicious request there", async () => {
    const root = tree();
    const socketPath = path.join(root, "helper.sock");
    bot(root, "ops");
    const helper = await startWorkspaceHelper({ root, socketPath });
    try {
      const leaf = await requestSessionLeaf(socketPath, root, "ops", "sess");
      expect(statSync(leaf).mode & 0o777).toBe(0o700);
      expect(() => requestSessionLeaf(socketPath, root, "ops", "..")).toThrow(/invalid_session/);
      const refused = await rawRequest(socketPath, { bot: "ops", session: "../etc" });
      expect(refused).toContain("invalid_session");
      expect(readdirSync(path.join(root, "ops"))).toEqual(["sess"]);
      const runtime = readFileSync(path.resolve("src/controller/runtime.ts"), "utf8");
      expect(runtime).toContain("requestSessionLeaf");
      expect(runtime).not.toContain("ensureWorkspace");
      expect(runtime).not.toMatch(/mkdirSync\(options\.workspaceRoot/);
    } finally {
      await helper.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the controller unit from writable workspaces and the helper running as sbx", () => {
    const controller = readFileSync(path.resolve("ops/systemd/agentctl-controller.service"), "utf8");
    const service = readFileSync(path.resolve("ops/systemd/sbx-workspace.service"), "utf8");
    const socket = readFileSync(path.resolve("ops/systemd/sbx-workspace.socket"), "utf8");
    expect(controller).toContain("NoNewPrivileges=yes");
    expect(controller).toContain("ProtectSystem=strict");
    expect(controller).toContain("ReadWritePaths=/home/agentctl/data /home/agentctl/secrets");
    const readWrite = controller.split("\n").find((line) => line.startsWith("ReadWritePaths="));
    expect(readWrite).toBe("ReadWritePaths=/home/agentctl/data /home/agentctl/secrets");
    expect(service).toContain("User=sbx");
    expect(service).toContain("NoNewPrivileges=yes");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ReadWritePaths=/home/sbx/workspaces");
    expect(socket.split("\n").find((line) => line.startsWith("SocketMode="))).toBe("SocketMode=0660");
    expect(parentAclArgs("/home/sbx/workspaces/ops")).toEqual(["setfacl", "-m", "u:agentctl:rx", "/home/sbx/workspaces/ops"]);
    expect(refuseDisabledRuntime("runsc")).toBe(RUNSC_DISABLED_MESSAGE);
    expect(refuseDisabledRuntime("crun")).toBeUndefined();
  });
});

function rawRequest(socketPath: string, body: { bot: string; session: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(0x0a)) {
        socket.end();
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(body)}\n`);
    });
  });
}

function tree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ppa-helper-"));
  chmodSync(root, 0o750);
  return root;
}

function bot(root: string, name: string, mode = 0o750): string {
  const parent = path.join(root, name);
  mkdirSync(parent);
  chmodSync(parent, mode);
  return parent;
}
