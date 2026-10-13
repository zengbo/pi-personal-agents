import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

export const TEST_ORIGIN = "https://chat.example.com";

export function httpCall(
  port: number,
  method: string,
  pathname: string,
  options?: { token?: string; cookie?: boolean; body?: string; origin?: string | false },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (method !== "GET" && method !== "HEAD" && options?.origin !== false) {
      headers.Origin = options?.origin ?? TEST_ORIGIN;
    }
    if (options?.token !== undefined) {
      if (options.cookie === true) {
        headers.Cookie = `CF_Authorization=${options.token}`;
      } else {
        headers["Cf-Access-Jwt-Assertion"] = options.token;
      }
    }
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(options.body));
    }
    const request = http.request({ hostname: "127.0.0.1", port, method, path: pathname, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
    if (options?.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

export interface TestSocket {
  send(text: string): void;
  next(timeoutMs?: number): Promise<unknown>;
  close(): void;
}

export function openTestSocket(
  port: number,
  token: string | undefined,
  options?: { origin?: string | false },
): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const lines = [
      "GET /ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
    ];
    if (options?.origin !== false) {
      lines.push(`Origin: ${options?.origin ?? TEST_ORIGIN}`);
    }
    if (token !== undefined) {
      lines.push(`Cf-Access-Jwt-Assertion: ${token}`);
    }
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let buffer = Buffer.alloc(0);
    let handshake = false;
    let closed: Error | undefined;
    const messages: unknown[] = [];
    const waiters: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
    const fail = (error: Error): void => {
      closed ??= error;
      if (!handshake) {
        reject(error);
      }
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };
    const deliver = (text: string): void => {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
      const waiter = waiters.shift();
      if (waiter === undefined) {
        messages.push(parsed);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshake) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          return;
        }
        const header = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 4);
        if (!header.startsWith("HTTP/1.1 101")) {
          socket.end();
          fail(new Error(header.split("\r\n")[0] ?? "websocket rejected"));
          return;
        }
        handshake = true;
        resolve({
          send(text: string) {
            socket.write(clientFrame(Buffer.from(text)));
          },
          next(timeoutMs = 10_000) {
            if (closed !== undefined) {
              return Promise.reject(closed);
            }
            const queued = messages.shift();
            if (queued !== undefined) {
              return Promise.resolve(queued);
            }
            return new Promise((resolveNext, rejectNext) => {
              const timer = setTimeout(() => {
                const index = waiters.findIndex((item) => item.timer === timer);
                if (index >= 0) {
                  waiters.splice(index, 1);
                }
                rejectNext(new Error("websocket timed out"));
              }, timeoutMs);
              waiters.push({ resolve: resolveNext, reject: rejectNext, timer });
            });
          },
          close() {
            socket.end();
            socket.destroy();
          },
        });
      }
      const parsed = parseFrames(buffer);
      buffer = Buffer.from(parsed.rest);
      for (const text of parsed.messages) {
        deliver(text);
      }
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => fail(new Error("websocket closed")));
  });
}

export async function waitForText(socket: TestSocket, needle: string, timeoutMs = 15_000): Promise<string> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const message = (await socket.next(timeoutMs - (Date.now() - started))) as {
      type?: string;
      entries?: { text?: string }[];
    };
    if (message.type !== "view" || message.entries === undefined) {
      continue;
    }
    last = message.entries.map((entry) => entry.text ?? "").join("\n");
    if (last.includes(needle)) {
      return last;
    }
  }
  throw new Error(`timed out waiting for ${needle}; last=${last}`);
}

function clientFrame(payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
  header[0] = 0x81;
  if (payload.length < 126) {
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, masked]);
}

function parseFrames(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = (buffer[offset] ?? 0) & 0x0f;
    const second = buffer[offset + 1] ?? 0;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length < offset + 4) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length < offset + 10) {
        break;
      }
      length = buffer.readUInt32BE(offset + 6);
      header = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + header + maskLength + length) {
      break;
    }
    const payload = Buffer.from(buffer.subarray(offset + header + maskLength, offset + header + maskLength + length));
    if (masked) {
      const mask = buffer.subarray(offset + header, offset + header + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
    }
    offset += header + maskLength + length;
    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    }
  }
  return { messages, rest: buffer.subarray(offset) };
}
