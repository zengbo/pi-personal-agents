import http from "node:http";
import type { Duplex } from "node:stream";
import type { AuditEvent } from "../policy/audit.ts";
import type { ApprovalChoice, ApprovalRequest } from "../policy/engine.ts";
import { AccessError, originAllowed, tokenFromRequest, verifyAccessJwt, type AccessCheck } from "./access.ts";
import { WEB_PAGE } from "./page.ts";
import { acceptWebSocket } from "./ws.ts";

export interface ViewEntry {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

export interface WebApp {
  readonly bots: readonly string[];
  access: AccessCheck;
  loginHtml(): string;
  submitLogin(code: string): void;
  listConversations(bot: string): Promise<readonly { id: string }[]>;
  submit(input: {
    bot: string;
    conversationId: string;
    content: string;
    requestId: string;
    whenBusy?: "steer" | "followUp";
  }): Promise<{ submissionId: string }>;
  view(bot: string, conversationId: string): Promise<readonly ViewEntry[]>;
  watch(bot: string, conversationId: string, onView: (entries: readonly ViewEntry[]) => void): Promise<() => void>;
  approvals(): readonly ApprovalRequest[];
  decide(id: string, decision: ApprovalChoice, sessionId: string): void;
  audit(): readonly AuditEvent[];
}

export async function startWeb(app: WebApp, options: { host?: string; port: number }): Promise<{ port: number; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("the web server only binds 127.0.0.1");
  }
  const server = http.createServer((request, response) => {
    void handle(app, request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      send(response, 500, "error");
    });
  });
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void acceptUpgrade(app, request, socket, head).catch(() => {
      failUpgrade(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(options.port, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function acceptUpgrade(
  app: WebApp,
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  if (!originAllowed(request.headers.origin, app.access.origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    socket.end();
    return;
  }
  const claims = await authorize(app, request.headers["cf-access-jwt-assertion"], request.headers.cookie);
  if (claims === undefined) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    socket.end();
    return;
  }
  const client = acceptWebSocket(request, socket, head, (text) => {
    void onSocket(app, claims.email, client, text).catch(() => {
      client?.close();
    });
  });
  if (client === undefined) {
    socket.end();
  }
}

async function authorize(
  app: WebApp,
  header: string | string[] | undefined,
  cookie: string | string[] | undefined,
): Promise<{ email: string } | undefined> {
  const token = tokenFromRequest(one(header), one(cookie));
  if (token === undefined) {
    return undefined;
  }
  try {
    return verifyAccessJwt(token, app.access);
  } catch (error) {
    if (error instanceof AccessError && error.reason === "kid" && app.access.refreshKeys !== undefined) {
      try {
        const fetched = await app.access.refreshKeys();
        if (fetched) {
          return verifyAccessJwt(token, app.access);
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

async function handle(app: WebApp, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && !originAllowed(request.headers.origin, app.access.origin)) {
    send(response, 403, "forbidden");
    return;
  }
  const claims = await authorize(app, request.headers["cf-access-jwt-assertion"], request.headers.cookie);
  if (claims === undefined) {
    send(response, 401, "unauthorized");
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    send(response, 200, WEB_PAGE, "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/login") {
    send(response, 200, app.loginHtml(), "text/html; charset=utf-8");
    return;
  }
  if (request.method === "POST" && url.pathname === "/login/code") {
    const body = await readBody(request);
    const code = new URLSearchParams(body).get("code") ?? "";
    app.submitLogin(code);
    send(response, 200, "ok");
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/bots") {
    send(response, 200, JSON.stringify({ bots: app.bots }), "application/json");
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/approvals") {
    send(response, 200, JSON.stringify({ items: app.approvals() }), "application/json");
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/audit") {
    send(response, 200, JSON.stringify({ events: app.audit() }), "application/json");
    return;
  }
  const approval = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && approval !== null) {
    const body = parseObject(await readBody(request));
    if (body === undefined) {
      send(response, 400, "bad json");
      return;
    }
    const decision = body.decision;
    if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny") {
      send(response, 400, "bad decision");
      return;
    }
    const id = approval[1];
    if (id === undefined) {
      send(response, 400, "bad id");
      return;
    }
    app.decide(id, decision, claims.email);
    send(response, 200, "ok");
    return;
  }
  const conversations = /^\/api\/bots\/([^/]+)\/conversations$/.exec(url.pathname);
  if (request.method === "GET" && conversations !== null) {
    const bot = conversations[1];
    if (bot === undefined) {
      send(response, 400, "bad bot");
      return;
    }
    send(response, 200, JSON.stringify({ conversations: await app.listConversations(bot) }), "application/json");
    return;
  }
  const submit = /^\/api\/bots\/([^/]+)\/conversations\/([^/]+)\/submit$/.exec(url.pathname);
  if (request.method === "POST" && submit !== null) {
    const bot = submit[1];
    const conversationId = submit[2];
    if (bot === undefined || conversationId === undefined) {
      send(response, 400, "bad path");
      return;
    }
    const body = parseObject(await readBody(request));
    if (body === undefined) {
      send(response, 400, "bad json");
      return;
    }
    const whenBusy = body.whenBusy === "steer" || body.whenBusy === "followUp" ? body.whenBusy : undefined;
    const result = await app.submit({
      bot,
      conversationId,
      content: typeof body.content === "string" ? body.content : "",
      requestId: typeof body.requestId === "string" ? body.requestId : `web-${Date.now()}`,
      whenBusy,
    });
    send(response, 200, JSON.stringify(result), "application/json");
    return;
  }
  send(response, 404, "not found");
}

async function onSocket(
  app: WebApp,
  email: string,
  client: { send(text: string): void; close(): void } | undefined,
  text: string,
): Promise<void> {
  if (client === undefined || email.length === 0) {
    client?.close();
    return;
  }
  const message = parseObject(text);
  if (message === undefined) {
    client.close();
    return;
  }
  const type = asString(message.type);
  const bot = asString(message.bot);
  const conversationId = asString(message.conversationId);
  if (type === "watch" && bot !== undefined && conversationId !== undefined) {
    const entries = await app.view(bot, conversationId);
    client.send(JSON.stringify({ type: "view", bot, conversationId, entries }));
    client.send(JSON.stringify({ type: "approvals", items: app.approvals() }));
    await app.watch(bot, conversationId, (next) => {
      client.send(JSON.stringify({ type: "view", bot, conversationId, entries: next }));
      client.send(JSON.stringify({ type: "approvals", items: app.approvals() }));
    });
    return;
  }
  if (type === "submit" && bot !== undefined && conversationId !== undefined) {
    const whenBusy = message.whenBusy === "steer" || message.whenBusy === "followUp" ? message.whenBusy : undefined;
    await app.submit({
      bot,
      conversationId,
      content: asString(message.content) ?? "",
      requestId: asString(message.requestId) ?? `ws-${Date.now()}`,
      whenBusy,
    });
    return;
  }
  const decision = message.decision;
  const id = asString(message.id);
  if (type === "decide" && id !== undefined && (decision === "allow_once" || decision === "allow_always" || decision === "deny")) {
    app.decide(id, decision, email);
    client.send(JSON.stringify({ type: "approvals", items: app.approvals() }));
  }
}

function send(response: http.ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function failUpgrade(socket: Duplex): void {
  if (!socket.destroyed && socket.writable) {
    socket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  }
  socket.destroy();
}
