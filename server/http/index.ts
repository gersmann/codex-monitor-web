import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import type { WebSocket as WsWebSocket } from "ws";
import {
  contentTypeForPath,
  readStaticResponse,
  resolveStaticRoot,
} from "./staticServer.js";
import type { JsonRecord, RpcErrorShape } from "../types.js";

const HTTP_REQUEST_WARN_AFTER_MS = 5_000;
const APP_SERVER_DEBUG_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "error",
  "serverRequest/resolved",
]);

type SocketMessage = {
  event: string;
  payload: unknown;
};

type ClosableSocket = {
  close: () => void;
};

type ClosableWebSocketServer = {
  close: (callback: () => void) => void;
};

let nextHttpRequestId = 1;

type RuntimeConfig = {
  host: string;
  port: number;
  debugServerLogs: boolean;
  clientLogsEnabled: boolean;
};

function parseRuntimePort(value: string | undefined): number {
  const parsed = Number(value ?? "4318");
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed;
  }
  return 4318;
}

function readRuntimeConfig(): RuntimeConfig {
  return {
    host: process.env.CODEX_MONITOR_WEB_HOST?.trim() || "127.0.0.1",
    port: parseRuntimePort(process.env.CODEX_MONITOR_WEB_PORT),
    debugServerLogs: process.env.CODEX_MONITOR_WEB_DEBUG?.trim() === "1",
    clientLogsEnabled: process.env.CODEX_MONITOR_WEB_CLIENT_LOGS?.trim() !== "0",
  };
}

function isRpcError(value: unknown): value is RpcErrorShape {
  return Boolean(
    value &&
      typeof value === "object" &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "object",
  );
}

function rpcErrorStatus(error: RpcErrorShape): number {
  const status = error.error.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }
  return 400;
}

function responseHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json",
  };
}

function staticResponseHeaders(contentType: string, contentLength: number) {
  return {
    "content-type": contentType,
    "content-length": String(contentLength),
  };
}

function writeJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  response.writeHead(statusCode, responseHeaders());
  response.end(JSON.stringify(payload));
}

export class InvalidJsonBodyError extends Error {}

export async function readRequestBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidJsonBodyError(`Request body must be valid JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export function summarizeParams(params: Record<string, unknown>) {
  const keys = Object.keys(params).sort((left, right) => left.localeCompare(right));
  const summary: Record<string, unknown> = { keys };
  for (const key of ["workspaceId", "threadId", "id", "path"]) {
    if (key in params) {
      summary[key] = params[key];
    }
  }
  return summary;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function summarizeAppServerPayload(payload: unknown) {
  const event = asRecord(payload);
  if (!event) {
    return null;
  }
  const message = asRecord(event.message);
  const method = typeof message?.method === "string" ? message.method : null;
  if (!method || !APP_SERVER_DEBUG_METHODS.has(method)) {
    return null;
  }
  const params = asRecord(message?.params) ?? {};
  return {
    workspaceId:
      typeof event.workspace_id === "string" ? event.workspace_id : String(event.workspace_id ?? ""),
    method,
    summary: summarizeParams(params),
  };
}

export function summarizeClientLogPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { message: String(payload) };
  }
  const record = payload as Record<string, unknown>;
  return {
    level: typeof record.level === "string" ? record.level : "error",
    source: typeof record.source === "string" ? record.source : "unknown",
    message:
      typeof record.message === "string"
        ? record.message
        : JSON.stringify(record.message ?? null),
    href: typeof record.href === "string" ? record.href : undefined,
    userAgent:
      typeof record.userAgent === "string" ? record.userAgent : undefined,
    stack: typeof record.stack === "string" ? record.stack : undefined,
    details: record.details,
  };
}

type HttpApp = {
  close: () => Promise<void>;
  getHealth: () => { threadCount: number };
  handleRpc: (method: string, params: JsonRecord) => Promise<unknown>;
};
type HttpRequestContext = {
  app: HttpApp;
  staticRoot: string | null;
};
type ShutdownReason = "sigint" | "sigterm" | "app-request";
type ShutdownHandler = (reason: ShutdownReason) => Promise<void>;
type ShutdownState = {
  promise: Promise<void> | null;
};
type ServerRef = {
  current: import("node:http").Server | null;
};
type ShutdownRef = {
  current: ShutdownHandler | null;
};

function writeNotFound(response: import("node:http").ServerResponse) {
  writeJson(response, 404, { error: { message: "Not found" } });
}

function logBroadcastLifecycle(message: SocketMessage) {
  if (!readRuntimeConfig().debugServerLogs || message.event !== "app-server-event") {
    return;
  }
  const lifecycle = summarizeAppServerPayload(message.payload);
  if (!lifecycle) {
    return;
  }
  console.log(
    `codex-monitor-web:event ${lifecycle.method}`,
    {
      workspaceId: lifecycle.workspaceId,
      ...lifecycle.summary,
    },
  );
}

function broadcastToOpenSockets(sockets: Set<WsWebSocket>, encoded: string) {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encoded);
    }
  }
}

function logClientPayload(payload: Record<string, unknown>) {
  console.warn(
    "codex-monitor-web:client",
    summarizeClientLogPayload(payload),
  );
}

function logClientPayloadParseFailure(error: unknown) {
  console.warn(
    "codex-monitor-web:client failed to parse client log payload",
    error,
  );
}

function logRpcFailure(
  requestId: number,
  method: string,
  statusCode: number,
  elapsedMs: number,
  error: unknown,
) {
  console.warn(
    `codex-monitor-web:http #${requestId} <- ${method} ${statusCode} ${elapsedMs}ms`,
    error,
  );
}

function logStartupFailure(error: unknown) {
  console.warn("codex-monitor-web failed to start", error);
}

function createBroadcastHandler(sockets: Set<WsWebSocket>) {
  return (message: SocketMessage) => {
    logBroadcastLifecycle(message);
    broadcastToOpenSockets(sockets, JSON.stringify(message));
  };
}

async function handleHealthRequest(
  response: import("node:http").ServerResponse,
  app: HttpApp,
) {
  writeJson(response, 200, {
    ok: true,
    ...(await app.getHealth()),
  });
}

async function handleStaticAssetRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  staticRoot: string | null,
  pathname: string,
) {
  if ((request.method !== "GET" && request.method !== "HEAD") || pathname.startsWith("/api/")) {
    return false;
  }
  if (!staticRoot) {
    writeNotFound(response);
    return true;
  }
  const staticResponse = await readStaticResponse(staticRoot, pathname);
  if (!staticResponse) {
    writeNotFound(response);
    return true;
  }
  response.writeHead(
    200,
    staticResponseHeaders(
      contentTypeForPath(staticResponse.filePath),
      staticResponse.body.length,
    ),
  );
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  response.end(staticResponse.body);
  return true;
}

async function handleClientLogRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  config: RuntimeConfig,
) {
  if (request.method !== "POST") {
    return false;
  }
  try {
    const payload = await readRequestBody(request);
    if (config.clientLogsEnabled) {
      logClientPayload(payload);
    }
    writeJson(response, 204, {});
  } catch (error) {
    logClientPayloadParseFailure(error);
    writeJson(response, 400, {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
  return true;
}

async function handleRpcRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  pathname: string,
  app: HttpApp,
  config: RuntimeConfig,
) {
  if (request.method !== "POST" || !pathname.startsWith("/api/rpc/")) {
    return false;
  }

  const method = pathname.slice("/api/rpc/".length);
  const requestId = nextHttpRequestId++;
  const startedAt = Date.now();
  let warningTimer: NodeJS.Timeout | null = null;

  try {
    const params = await readRequestBody(request);
    if (config.debugServerLogs) {
      console.log(
        `codex-monitor-web:http #${requestId} -> ${method}`,
        summarizeParams(params),
      );
    }
    warningTimer = setTimeout(() => {
      console.warn(
        `codex-monitor-web:http #${requestId} still running after ${Date.now() - startedAt}ms (${method})`,
      );
    }, HTTP_REQUEST_WARN_AFTER_MS);
    warningTimer.unref?.();

    const result = await app.handleRpc(method, params);
    if (isRpcError(result)) {
      const statusCode = rpcErrorStatus(result);
      console.warn(
        `codex-monitor-web:http #${requestId} <- ${method} ${statusCode} ${Date.now() - startedAt}ms ${result.error.message}`,
      );
      writeJson(response, statusCode, result);
      return true;
    }

    if (config.debugServerLogs) {
      console.log(
        `codex-monitor-web:http #${requestId} <- ${method} 200 ${Date.now() - startedAt}ms`,
      );
    }
    writeJson(response, 200, result);
  } catch (error) {
    const statusCode = error instanceof InvalidJsonBodyError ? 400 : 500;
    const elapsedMs = Date.now() - startedAt;
    logRpcFailure(requestId, method, statusCode, elapsedMs, error);
    writeJson(response, statusCode, {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    if (warningTimer) {
      clearTimeout(warningTimer);
    }
  }

  return true;
}

export async function handleHttpRequest(
  context: HttpRequestContext,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) {
  const config = readRuntimeConfig();
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "127.0.0.1"}`,
  );

  if (request.method === "OPTIONS") {
    writeJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    await handleHealthRequest(response, context.app);
    return;
  }

  if (await handleStaticAssetRequest(request, response, context.staticRoot, url.pathname)) {
    return;
  }

  if (url.pathname === "/api/client-log" && await handleClientLogRequest(request, response, config)) {
    return;
  }

  if (await handleRpcRequest(request, response, url.pathname, context.app, config)) {
    return;
  }

  writeNotFound(response);
}

function emitUpgradedConnection(
  websocketServer: WebSocketServer,
  request: import("node:http").IncomingMessage,
  websocket: WsWebSocket,
) {
  websocketServer.emit("connection", websocket, request);
}

export function handleEventsUpgrade(
  websocketServer: WebSocketServer,
  request: import("node:http").IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
) {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "127.0.0.1"}`,
  );
  if (url.pathname !== "/events") {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(
    request,
    socket,
    head,
    emitUpgradedConnection.bind(null, websocketServer, request),
  );
}

export function attachEventsUpgradeHandler(
  server: import("node:http").Server,
  websocketServer: WebSocketServer,
) {
  server.on("upgrade", handleEventsUpgrade.bind(null, websocketServer));
}

function removeSocket(sockets: Set<WsWebSocket>, socket: WsWebSocket) {
  sockets.delete(socket);
}

function registerSocket(sockets: Set<WsWebSocket>, socket: WsWebSocket) {
  sockets.add(socket);
  socket.once("close", removeSocket.bind(null, sockets, socket));
}

async function closeWebSocketServer(websocketServer: WebSocketServer) {
  await promisify(
    (websocketServer as unknown as ClosableWebSocketServer).close.bind(websocketServer),
  )();
}

async function closeHttpServer(server: import("node:http").Server) {
  await promisify(server.close.bind(server))();
}

async function shutdownServer(
  app: HttpApp,
  sockets: Set<WsWebSocket>,
  websocketServer: WebSocketServer,
  getServer: () => import("node:http").Server | null,
  state: ShutdownState,
  reason: ShutdownReason,
) {
  if (state.promise) {
    return await state.promise;
  }
  state.promise = (async () => {
    console.log("Web companion shutting down", { reason });
    for (const socket of sockets) {
      try {
        (socket as unknown as ClosableSocket).close();
      } catch {
        // Ignore websocket shutdown errors during process teardown.
      }
    }
    await app.close();
    await closeWebSocketServer(websocketServer);
    const server = getServer();
    if (server) {
      await closeHttpServer(server);
    }
  })();
  return await state.promise;
}

function createShutdownHandler(
  app: HttpApp,
  sockets: Set<WsWebSocket>,
  websocketServer: WebSocketServer,
  getServer: () => import("node:http").Server | null,
) {
  const state: ShutdownState = { promise: null };
  return shutdownServer.bind(
    null,
    app,
    sockets,
    websocketServer,
    getServer,
    state,
  );
}

function getServerFromRef(serverRef: ServerRef) {
  return serverRef.current;
}

function requestAppShutdown(serverRef: ServerRef, shutdownRef: ShutdownRef) {
  if (!serverRef.current || !shutdownRef.current) {
    return;
  }
  void shutdownRef.current("app-request");
}

function exitProcess() {
  process.exit(0);
}

function shutdownForSignal(
  shutdown: ShutdownHandler,
  reason: Exclude<ShutdownReason, "app-request">,
) {
  void shutdown(reason).finally(exitProcess);
}

function attachShutdownSignalHandlers(shutdown: ShutdownHandler) {
  process.once("SIGINT", shutdownForSignal.bind(null, shutdown, "sigint"));
  process.once("SIGTERM", shutdownForSignal.bind(null, shutdown, "sigterm"));
}

export async function main() {
  const config = readRuntimeConfig();
  const [{ CompanionStorage }, { resolveDataDir }, { CodexCompanionServer }] =
    await Promise.all([
      import("../storage.js"),
      import("../paths.js"),
      import("../codex.js"),
    ]);
  const sockets = new Set<WsWebSocket>();
  const storage = new CompanionStorage(resolveDataDir());
  const staticRoot = resolveStaticRoot();
  const serverRef: ServerRef = { current: null };
  const shutdownRef: ShutdownRef = { current: null };
  const app = new CodexCompanionServer(
    storage,
    createBroadcastHandler(sockets),
    requestAppShutdown.bind(null, serverRef, shutdownRef),
  );
  await app.initialize();

  const websocketServer: WebSocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on("connection", registerSocket.bind(null, sockets));

  const shutdown = createShutdownHandler(
    app,
    sockets,
    websocketServer,
    getServerFromRef.bind(null, serverRef),
  );
  shutdownRef.current = shutdown;
  const server = createServer(handleHttpRequest.bind(null, { app, staticRoot }));
  serverRef.current = server;
  attachEventsUpgradeHandler(server, websocketServer);

  server.listen(config.port, config.host, () => {
    console.log(
      `codex-monitor-web listening on http://${config.host}:${config.port}`,
      staticRoot ? { staticRoot } : undefined,
    );
  });
  attachShutdownSignalHandlers(shutdown);
}

function isEntrypoint(moduleUrl: string, argvEntry: string | undefined) {
  if (!argvEntry) {
    return false;
  }
  return fileURLToPath(moduleUrl) === path.resolve(argvEntry);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  void main().catch((error) => {
    logStartupFailure(error);
    process.exitCode = 1;
  });
}
