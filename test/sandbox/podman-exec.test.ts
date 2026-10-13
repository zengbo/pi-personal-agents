import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../../src/sandbox/flags.ts";
import { muxPodmanFrame, PodmanOutputTooLargeError, UnixPodmanClient } from "../../src/sandbox/podman.ts";

describe("podman exec stdin", () => {
  it("reads a normal exec body when the server does not upgrade", async () => {
    const server = await listen((req, res) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url.endsWith("/exec")) {
        res.end(JSON.stringify({ Id: "exec-1" }));
        return;
      }
      if (req.method === "GET" && url.endsWith("/json")) {
        res.end(JSON.stringify({ ExitCode: 0 }));
        return;
      }
      res.end(muxPodmanFrame(1, Buffer.from("body-out")));
    });
    try {
      const client = new UnixPodmanClient({ crun: server.socketPath });
      const result = await client.exec("crun", "ctr", "true", undefined);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("body-out");
      expect([...(result.stdoutBytes ?? [])]).toEqual([...Buffer.from("body-out")]);
    } finally {
      await server.close();
    }
  });

  it("writes raw stdin bytes on the upgraded socket", async () => {
    const stdin = Buffer.from([0x00, 0xff, 0x09, 0x0a, 0x41, 0x00]);
    let seen = Buffer.alloc(0);
    const server = await listen(undefined, (req, socket, head) => {
      socket.on("error", () => undefined);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: tcp\r\nConnection: Upgrade\r\n\r\n");
      const declared = Number(req.headers["content-length"] ?? 0);
      const chunks: Buffer[] = [];
      if (head.length > declared) {
        chunks.push(head.subarray(declared));
      }
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      socket.on("end", () => {
        seen = Buffer.concat(chunks);
        socket.write(muxPodmanFrame(1, Buffer.from([0xff, 0x00, 0x41])));
        socket.end();
      });
    });
    try {
      const client = new UnixPodmanClient({ crun: server.socketPath });
      const result = await client.exec("crun", "ctr", ["tee", "--", "/workspace/note.txt"], { stdin });
      expect(result.exitCode).toBe(0);
      expect([...(result.stdoutBytes ?? [])]).toEqual([0xff, 0x00, 0x41]);
      expect(Buffer.compare(seen, stdin)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("accepts one multiplexed stdout frame of exactly MAX_FILE_BYTES", async () => {
    const payload = Buffer.alloc(MAX_FILE_BYTES, 0x61);
    const server = await listen(undefined, (_req, socket) => {
      socket.on("error", () => undefined);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: tcp\r\nConnection: Upgrade\r\n\r\n");
      const frame = muxPodmanFrame(1, payload);
      socket.write(frame.subarray(0, 8));
      socket.write(frame.subarray(8));
      socket.end();
    });
    try {
      const client = new UnixPodmanClient({ crun: server.socketPath });
      const result = await client.exec("crun", "ctr", "true", undefined);
      expect(result.exitCode).toBe(0);
      expect(result.stdoutBytes?.byteLength).toBe(MAX_FILE_BYTES);
      expect(result.stdoutBytes?.[0]).toBe(0x61);
      expect(result.stdoutBytes?.[MAX_FILE_BYTES - 1]).toBe(0x61);
    } finally {
      await server.close();
    }
  });

  it("aborts when multiplexed stdout exceeds MAX_FILE_BYTES", async () => {
    const server = await listen(undefined, (_req, socket) => {
      socket.on("error", () => undefined);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: tcp\r\nConnection: Upgrade\r\n\r\n");
      socket.write(muxPodmanFrame(1, Buffer.alloc(MAX_FILE_BYTES + 1, 0x7a)));
      socket.end();
    });
    try {
      const client = new UnixPodmanClient({ crun: server.socketPath });
      const error = await client.exec("crun", "ctr", "true", undefined).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PodmanOutputTooLargeError);
      expect(error instanceof Error ? error.message : "").toBe("too_large");
      expect(JSON.stringify(error)).not.toContain("z".repeat(32));
    } finally {
      await server.close();
    }
  });

  it("aborts a non-upgraded body larger than MAX_FILE_BYTES", async () => {
    const server = await listen((_req, res) => {
      res.end(muxPodmanFrame(1, Buffer.alloc(MAX_FILE_BYTES + 1, 0x7a)));
    });
    try {
      const client = new UnixPodmanClient({ crun: server.socketPath });
      await expect(client.exec("crun", "ctr", "true", undefined)).rejects.toBeInstanceOf(PodmanOutputTooLargeError);
    } finally {
      await server.close();
    }
  });
});

function listen(
  onRequest: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | undefined,
  onUpgrade?: (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void,
): Promise<{ socketPath: string; close(): Promise<void> }> {
  const root = mkdtempSync(path.join(tmpdir(), "ppa-podman-"));
  const socketPath = path.join(root, "podman.sock");
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url.includes("/containers/") && url.endsWith("/exec")) {
      res.end(JSON.stringify({ Id: "exec-1" }));
      return;
    }
    if (req.method === "GET" && url.endsWith("/json")) {
      res.end(JSON.stringify({ ExitCode: 0 }));
      return;
    }
    if (onRequest !== undefined) {
      onRequest(req, res);
      return;
    }
    res.writeHead(500);
    res.end();
  });
  if (onUpgrade !== undefined) {
    server.on("upgrade", (req, socket, head) => {
      onUpgrade(req, socket, head);
    });
  }
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        close: () => new Promise((done) => {
          server.close(() => {
            rmSync(root, { recursive: true, force: true });
            done();
          });
        }),
      });
    });
  });
}
