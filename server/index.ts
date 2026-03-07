import { createServer } from "node:http";
import process from "node:process";
import { WebSocket, WebSocketServer } from "ws";
import { CodexCompanionServer } from "./codex.js";
import { resolveDataDir } from "./paths.js";
import { CompanionStorage } from "./storage.js";

const DEFAULT_PORT = Number(process.env.CODEX_MONITOR_WEB_PORT ?? "4318");
const DEFAULT_HOST = process.env.CODEX_MONITOR_WEB_HOST?.trim() || "127.0.0.1";

type SocketMessage = {
  event: string;
  payload: unknown;
};

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

async function main() {
  const sockets = new Set<WebSocket>();
  const storage = new CompanionStorage(resolveDataDir());
  const app = new CodexCompanionServer(storage, (message: SocketMessage) => {
    const encoded = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoded);
      }
    }
  });
  await app.initialize();

  const websocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );

    if (request.method === "OPTIONS") {
      writeJson(response, 204, {});
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      writeJson(response, 200, { ok: true, dataDir: resolveDataDir() });
      return;
    }

    if (request.method !== "POST" || !url.pathname.startsWith("/api/rpc/")) {
      writeJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    const method = url.pathname.slice("/api/rpc/".length);
    try {
      const params = await readRequestBody(request);
      const result = await app.handleRpc(method, params);
      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        typeof (result as { error?: unknown }).error === "object"
      ) {
        writeJson(response, 400, result);
        return;
      }
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
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
}

void main().catch((error) => {
  console.error("[codex-monitor-web] failed to start", error);
  process.exitCode = 1;
});
