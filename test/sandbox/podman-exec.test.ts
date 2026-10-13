import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { demuxPodmanFrameBuffers, muxPodmanFrame, UnixPodmanClient } from "../../src/sandbox/podman.ts";

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

  it("writes stdin frames on the upgraded socket and keeps stdout bytes", async () => {
    let seen = Buffer.alloc(0);
    const server = await listen(undefined, (req, socket, head) => {
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
        const payload = Buffer.from([0xff, 0x00, 0x41]);
        socket.write(muxPodmanFrame(1, payload));
        socket.end();
      });
    });
    try {
      const client = new UnixPodmanClient({ crun: server.socketPath });
      const result = await client.exec("crun", "ctr", ["tee", "--", "/workspace/note.txt"], {
        stdin: new Uint8Array([9, 8, 7]),
      });
      expect(result.exitCode).toBe(0);
      expect([...(result.stdoutBytes ?? [])]).toEqual([0xff, 0x00, 0x41]);
      const frames = demuxPodmanFrameBuffers(seen);
      expect([...frames.stdout]).toEqual([9, 8, 7]);
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
