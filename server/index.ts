import { createServer } from "node:http";
import process from "node:process";
import { WebSocketServer } from "ws";
import type { WebSocket as WsWebSocket } from "ws";
import { CodexCompanionServer } from "./codex.js";
import { resolveDataDir } from "./paths.js";
import { CompanionStorage } from "./storage.js";
import type { RpcErrorShape } from "./types.js";

const DEFAULT_PORT = Number(process.env.CODEX_MONITOR_WEB_PORT ?? "4318");
const DEFAULT_HOST = process.env.CODEX_MONITOR_WEB_HOST?.trim() || "127.0.0.1";
const HTTP_REQUEST_WARN_AFTER_MS = 5_000;
const DEBUG_SERVER_LOGS =
  process.env.CODEX_MONITOR_WEB_DEBUG?.trim() === "1";
const CLIENT_LOGS_ENABLED =
  process.env.CODEX_MONITOR_WEB_CLIENT_LOGS?.trim() !== "0";
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

function isRpcError(value: unknown): value is RpcErrorShape {
  return Boolean(
    value &&
      typeof value === "object" &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "object",
  );
}

function responseHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json",
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

async function readRequestBody(
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
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function summarizeParams(params: Record<string, unknown>) {
  const keys = Object.keys(params).sort();
  const summary: Record<string, unknown> = { keys };
  for (const key of ["workspaceId", "threadId", "id", "path"]) {
    if (key in params) {
      summary[key] = params[key];
    }
  }
  return summary;
}

function summarizeAppServerPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const event = payload as {
    workspace_id?: unknown;
    message?: { method?: unknown; params?: unknown };
  };
  const message =
    event.message && typeof event.message === "object" && !Array.isArray(event.message)
      ? event.message
      : null;
  const method = typeof message?.method === "string" ? message.method : null;
  if (!method || !APP_SERVER_DEBUG_METHODS.has(method)) {
    return null;
  }
  const params =
    message?.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? (message.params as Record<string, unknown>)
      : {};
  return {
    workspaceId:
      typeof event.workspace_id === "string" ? event.workspace_id : String(event.workspace_id ?? ""),
    method,
    summary: summarizeParams(params),
  };
}

function summarizeClientLogPayload(payload: unknown) {
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

async function main() {
  const sockets = new Set<WsWebSocket>();
  const storage = new CompanionStorage(resolveDataDir());
  let shutdownPromise: Promise<void> | null = null;
  let server: import("node:http").Server | null = null;
  const requestShutdown = () => {
    if (!server) {
      return;
    }
    void shutdown("app-request");
  };
  const app = new CodexCompanionServer(storage, (message: SocketMessage) => {
    if (DEBUG_SERVER_LOGS && message.event === "app-server-event") {
      const lifecycle = summarizeAppServerPayload(message.payload);
      if (lifecycle) {
        console.log(
          `[codex-monitor-web:event] ${lifecycle.method}`,
          {
            workspaceId: lifecycle.workspaceId,
            ...lifecycle.summary,
          },
        );
      }
    }
    const encoded = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoded);
      }
    }
  }, requestShutdown);
  await app.initialize();

  const websocketServer: WebSocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );

    if (request.method === "OPTIONS") {
      writeJson(response, 204, {});
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      writeJson(response, 200, {
        ok: true,
        ...(await app.getHealth()),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/client-log") {
      try {
        const payload = await readRequestBody(request);
        if (CLIENT_LOGS_ENABLED) {
          console.error(
            "[codex-monitor-web:client]",
            summarizeClientLogPayload(payload),
          );
        }
        writeJson(response, 204, {});
      } catch (error) {
        console.error(
          "[codex-monitor-web:client] failed to parse client log payload",
          error,
        );
        writeJson(response, 400, {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (request.method !== "POST" || !url.pathname.startsWith("/api/rpc/")) {
      writeJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    const method = url.pathname.slice("/api/rpc/".length);
    const requestId = nextHttpRequestId++;
    const startedAt = Date.now();
    let warningTimer: NodeJS.Timeout | null = null;

    try {
      const params = await readRequestBody(request);
      if (DEBUG_SERVER_LOGS) {
        console.log(
          `[codex-monitor-web:http] #${requestId} -> ${method}`,
          summarizeParams(params),
        );
      }
      warningTimer = setTimeout(() => {
        console.warn(
          `[codex-monitor-web:http] #${requestId} still running after ${Date.now() - startedAt}ms (${method})`,
        );
      }, HTTP_REQUEST_WARN_AFTER_MS);
      warningTimer.unref?.();

      const result = await app.handleRpc(method, params);
      if (isRpcError(result)) {
        console.warn(
          `[codex-monitor-web:http] #${requestId} <- ${method} 400 ${Date.now() - startedAt}ms ${result.error.message}`,
        );
        writeJson(response, 400, result);
        return;
      }

      if (DEBUG_SERVER_LOGS) {
        console.log(
          `[codex-monitor-web:http] #${requestId} <- ${method} 200 ${Date.now() - startedAt}ms`,
        );
      }
      writeJson(response, 200, result);
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      console.error(
        `[codex-monitor-web:http] #${requestId} <- ${method} 500 ${elapsedMs}ms`,
        error,
      );
      writeJson(response, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      if (warningTimer) {
        clearTimeout(warningTimer);
      }
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    if (url.pathname !== "/events") {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`[codex-monitor-web] listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  });

  const shutdown = async (reason: "sigint" | "sigterm" | "app-request") => {
    if (shutdownPromise) {
      return await shutdownPromise;
    }
    shutdownPromise = (async () => {
      console.log(`[codex-monitor-web] shutting down (${reason})`);
      for (const socket of sockets) {
        try {
          (socket as unknown as ClosableSocket).close();
        } catch {
          // Ignore websocket shutdown errors during process teardown.
        }
      }
      await app.close();
      await new Promise<void>((resolve) => {
        (websocketServer as unknown as ClosableWebSocketServer).close(() => {
          resolve();
        });
      });
      if (server) {
        await new Promise<void>((resolve) => {
          server?.close(() => {
            resolve();
          });
        });
      }
    })();
    return await shutdownPromise;
  };
  process.once("SIGINT", () => {
    void shutdown("sigint").finally(() => {
      process.exit(0);
    });
  });
  process.once("SIGTERM", () => {
    void shutdown("sigterm").finally(() => {
      process.exit(0);
    });
  });
}

void main().catch((error) => {
  console.error("[codex-monitor-web] failed to start", error);
  process.exitCode = 1;
});
