import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface SocketMessage {
  send(text: string): void;
  close(): void;
}

/** Minimal RFC 6455 text socket. One frame per message, up to 1 MiB. */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  onText: (text: string) => void,
): SocketMessage | undefined {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    return undefined;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffer = Buffer.from(head);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0] ?? 0;
      const second = buffer[1] ?? 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) {
          return;
        }
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) {
          return;
        }
        const big = buffer.readUInt32BE(6);
        length = big;
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) {
        return;
      }
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
        }
      }
      buffer = buffer.subarray(offset + maskLength + length);
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        socket.write(frame(payload, 0xA));
        continue;
      }
      if (opcode === 0x1) {
        onText(payload.toString("utf8"));
      }
    }
  });
  return {
    send(text: string) {
      socket.write(frame(Buffer.from(text), 0x1));
    },
    close() {
      socket.end();
    },
  };
}

export function frame(payload: Buffer, opcode: number): Buffer {
  const header = payload.length < 126 ? Buffer.alloc(2) : payload.length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (payload.length < 126) {
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 127;
    header.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([header, payload]);
}
