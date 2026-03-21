import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { Readable } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvalidJsonBodyError,
  attachEventsUpgradeHandler,
  handleHttpRequest,
  readRequestBody,
  summarizeAppServerPayload,
  summarizeClientLogPayload,
  summarizeParams,
} from "./index.js";

const activeServers = new Set<HttpServer>();
const activeWebSocketServers = new Set<WebSocketServer>();

function createRequest(body: string): IncomingMessage {
  return Readable.from([body]) as IncomingMessage;
}

async function listen(server: HttpServer) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  activeServers.add(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve server address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: HttpServer) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForWebSocketOpen(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });
}

async function waitForWebSocketClose(socket: WebSocket) {
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
}

afterEach(async () => {
  await Promise.all(
    Array.from(activeWebSocketServers).map(
      (websocketServer) =>
        new Promise<void>((resolve) => {
          websocketServer.close(() => resolve());
        }),
    ),
  );
  activeWebSocketServers.clear();
  await Promise.all(Array.from(activeServers).map(closeServer));
  activeServers.clear();
});

describe("server/index helpers", () => {
  it("reads JSON object request bodies", async () => {
    await expect(readRequestBody(createRequest('{"workspaceId":"ws-1","count":2}'))).resolves.toEqual({
      workspaceId: "ws-1",
      count: 2,
    });
  });

  it("rejects malformed JSON request bodies", async () => {
    await expect(readRequestBody(createRequest("{oops"))).rejects.toBeInstanceOf(
      InvalidJsonBodyError,
    );
  });

  it("summarizes debug app-server payloads", () => {
    expect(
      summarizeAppServerPayload({
        workspace_id: "ws-1",
        message: {
          method: "thread/status/changed",
          params: {
            path: "/tmp/demo",
            threadId: "thread-1",
            ignored: true,
          },
        },
      }),
    ).toEqual({
      workspaceId: "ws-1",
      method: "thread/status/changed",
      summary: {
        keys: ["ignored", "path", "threadId"],
        path: "/tmp/demo",
        threadId: "thread-1",
      },
    });
  });

  it("normalizes client log payloads and parameter summaries", () => {
    expect(summarizeParams({ z: true, workspaceId: "ws-1", path: "/tmp/demo" })).toEqual({
      keys: ["path", "workspaceId", "z"],
      workspaceId: "ws-1",
      path: "/tmp/demo",
    });
    expect(summarizeClientLogPayload({ message: { nested: true } })).toEqual({
      level: "error",
      source: "unknown",
      message: "{\"nested\":true}",
      href: undefined,
      userAgent: undefined,
      stack: undefined,
      details: undefined,
    });
  });
});

describe("server/index HTTP and websocket integration", () => {
  it("routes RPC requests through the live HTTP entrypoint", async () => {
    const app = {
      close: vi.fn().mockResolvedValue(undefined),
      getHealth: vi.fn().mockResolvedValue({ threadCount: 0 }),
      handleRpc: vi.fn().mockResolvedValue({ ok: true }),
    };
    const server = createServer(handleHttpRequest.bind(null, { app, staticRoot: null }));
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/rpc/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(app.handleRpc).toHaveBeenCalledWith("ping", { workspaceId: "ws-1" });
  });

  it("maps structured rpc errors to the response status code", async () => {
    const app = {
      close: vi.fn().mockResolvedValue(undefined),
      getHealth: vi.fn().mockResolvedValue({ threadCount: 0 }),
      handleRpc: vi.fn().mockResolvedValue({
        error: {
          status: 404,
          message: "Workspace not found.",
        },
      }),
    };
    const server = createServer(handleHttpRequest.bind(null, { app, staticRoot: null }));
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/rpc/list_workspace_files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "missing" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        status: 404,
        message: "Workspace not found.",
      },
    });
  });

  it("keeps structured bad request rpc errors at 400", async () => {
    const app = {
      close: vi.fn().mockResolvedValue(undefined),
      getHealth: vi.fn().mockResolvedValue({ threadCount: 0 }),
      handleRpc: vi.fn().mockResolvedValue({
        error: {
          status: 400,
          message: "Branch name is required.",
        },
      }),
    };
    const server = createServer(handleHttpRequest.bind(null, { app, staticRoot: null }));
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/rpc/create_git_branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1", name: "" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        status: 400,
        message: "Branch name is required.",
      },
    });
  });

  it("surfaces thrown rpc failures as internal server errors", async () => {
    const app = {
      close: vi.fn().mockResolvedValue(undefined),
      getHealth: vi.fn().mockResolvedValue({ threadCount: 0 }),
      handleRpc: vi.fn().mockRejectedValue(new Error("database offline")),
    };
    const server = createServer(handleHttpRequest.bind(null, { app, staticRoot: null }));
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/rpc/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "database offline",
      },
    });
  });

  it("upgrades websocket connections on /events", async () => {
    const app = {
      close: vi.fn().mockResolvedValue(undefined),
      getHealth: vi.fn().mockResolvedValue({ threadCount: 0 }),
      handleRpc: vi.fn().mockResolvedValue({ ok: true }),
    };
    const server = createServer(handleHttpRequest.bind(null, { app, staticRoot: null }));
    const websocketServer = new WebSocketServer({ noServer: true });
    activeWebSocketServers.add(websocketServer);
    attachEventsUpgradeHandler(server, websocketServer);
    const baseUrl = await listen(server);
    const wsUrl = baseUrl.replace("http://", "ws://");

    const connectionPromise = new Promise<void>((resolve) => {
      websocketServer.on("connection", () => resolve());
    });
    const socket = new WebSocket(`${wsUrl}/events`);
    await waitForWebSocketOpen(socket);
    await connectionPromise;
    socket.close();
    await waitForWebSocketClose(socket);
  });
});
