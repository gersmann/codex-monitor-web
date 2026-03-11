import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAppServerUserInputItems, CodexCompanionServer } from "./codex.js";
import { CompanionStorage } from "./storage.js";
import type { StoredThread, StoredWorkspace } from "./types.js";
import type { TerminalRuntime } from "./terminal.js";

const tempDirs: string[] = [];

async function createServerFixture(
  broadcast: (message: { event: string; payload: Record<string, unknown> }) => void = () => {},
  terminalRuntime?: TerminalRuntime | null,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-server-"));
  tempDirs.push(dir);
  const storage = new CompanionStorage(dir);
  const workspacePath = path.join(dir, "workspace");
  const workspace: StoredWorkspace = {
    id: "ws-1",
    name: "Workspace",
    path: workspacePath,
    settings: {
      sidebarCollapsed: false,
    },
  };
  const thread: StoredThread = {
    id: "thread-1",
    workspaceId: "ws-1",
    sdkThreadId: "sdk-thread-1",
    cwd: workspacePath,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    name: null,
    preview: "Thread One",
    activeTurnId: null,
    turns: [],
    modelId: null,
    effort: null,
    backlog: [],
    tokenUsage: null,
  };
  await storage.writeWorkspaces([workspace]);
  await storage.writeThreads([thread]);
  const server = new CodexCompanionServer(storage, broadcast, undefined, terminalRuntime);
  await server.initialize();
  return { dir, storage, server, workspace, thread };
}

async function runGit(cwd: string, args: string[]) {
  return await new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve();
    });
  });
}

async function readGitStdout(cwd: string, args: string[]) {
  return await new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function installFakeGh(dir: string, scriptBody: string) {
  const binDir = path.join(dir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "gh");
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env node
${scriptBody}
`,
    "utf8",
  );
  await fs.chmod(scriptPath, 0o755);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
}

function mockAppServerClient(
  server: CodexCompanionServer,
  client: Partial<{
    accountRateLimitsRead: (...args: unknown[]) => Promise<unknown>;
    accountRead: (...args: unknown[]) => Promise<unknown>;
    appsList: (...args: unknown[]) => Promise<unknown>;
    archiveThread: (...args: unknown[]) => Promise<unknown>;
    collaborationModeList: (...args: unknown[]) => Promise<unknown>;
    compactThread: (...args: unknown[]) => Promise<unknown>;
    cancelLogin: (...args: unknown[]) => Promise<unknown>;
    experimentalFeatureList: (...args: unknown[]) => Promise<unknown>;
    forkThread: (...args: unknown[]) => Promise<unknown>;
    interruptTurn: (...args: unknown[]) => Promise<unknown>;
    listThreads: (...args: unknown[]) => Promise<unknown>;
    listMcpServerStatus: (...args: unknown[]) => Promise<unknown>;
    modelList: (...args: unknown[]) => Promise<unknown>;
    onNotification: (...args: unknown[]) => () => void;
    readThreadWithTurns: (...args: unknown[]) => Promise<unknown>;
    rollbackThread: (...args: unknown[]) => Promise<unknown>;
    resumeThread: (...args: unknown[]) => Promise<unknown>;
    sendResponse: (...args: unknown[]) => Promise<unknown>;
    skillsList: (...args: unknown[]) => Promise<unknown>;
    startLogin: (...args: unknown[]) => Promise<unknown>;
    startReview: (...args: unknown[]) => Promise<unknown>;
    startThread: (...args: unknown[]) => Promise<unknown>;
    startTurn: (...args: unknown[]) => Promise<unknown>;
    steerTurn: (...args: unknown[]) => Promise<unknown>;
    setThreadName: (...args: unknown[]) => Promise<unknown>;
    request: (...args: unknown[]) => Promise<unknown>;
  }>,
) {
  (
    server as unknown as {
      buildAppServerClient: () => typeof client;
    }
  ).buildAppServerClient = () => client;
}

function mockDetachedAppServerClient(
  server: CodexCompanionServer,
  client: Partial<{
    archiveThread: (...args: unknown[]) => Promise<unknown>;
    close: () => Promise<void>;
    onNotification: (...args: unknown[]) => () => void;
    readThreadWithTurns: (...args: unknown[]) => Promise<unknown>;
    startThread: (...args: unknown[]) => Promise<unknown>;
    startTurn: (...args: unknown[]) => Promise<unknown>;
    waitForNotification: (...args: unknown[]) => Promise<unknown>;
  }>,
) {
  (
    server as unknown as {
      createDetachedAppServerClient: () => typeof client;
    }
  ).createDetachedAppServerClient = () => client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("workspace file listing", () => {
  it("respects gitignore while keeping visible hidden files", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.mkdir(path.join(workspace.path, "nested"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, ".gitignore"),
      ["ignored.txt", "nested/", "dist/", ""].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(workspace.path, ".env"), "SECRET=1\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "src", "kept.ts"), "export {};\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "ignored.txt"), "ignore me\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "nested", "secret.ts"), "hidden\n", "utf8");
    await fs.mkdir(path.join(workspace.path, "dist"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, "dist", "bundle.js"), "bundle\n", "utf8");

    const result = await server.handleRpc("list_workspace_files", { workspaceId: "ws-1" });

    expect(result).toEqual([".env", ".gitignore", "src/kept.ts"]);
  });

  it("falls back to recursive listing for non-git workspaces", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.mkdir(path.join(workspace.path, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, ".env"), "SECRET=1\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "src", "kept.ts"), "export {};\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "node_modules", "ignored.js"), "noop\n", "utf8");

    const result = await server.handleRpc("list_workspace_files", { workspaceId: "ws-1" });

    expect(result).toEqual([".env", "src/kept.ts"]);
  });
});

describe("buildAppServerUserInputItems", () => {
  it("maps text, images, and mentions to app-server input items", () => {
    expect(
      buildAppServerUserInputItems("Ship it", ["/tmp/image.png", "https://example.com/a.png"], [
        { name: "Calendar", path: "app://calendar" },
      ]),
    ).toEqual([
      { type: "text", text: "Ship it", text_elements: [] },
      { type: "localImage", path: "/tmp/image.png" },
      { type: "image", url: "https://example.com/a.png" },
      { type: "mention", name: "Calendar", path: "app://calendar" },
    ]);
  });
});

describe("CodexCompanionServer phase 1 rpc support", () => {
  it("stores backlog items per thread", async () => {
    const { server, storage } = await createServerFixture();

    const created = (await server.handleRpc("add_thread_backlog_item", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      text: "Follow up after the benchmark run.",
    })) as { id: string; text: string };

    expect(created.text).toBe("Follow up after the benchmark run.");

    const listed = await server.handleRpc("get_thread_backlog", {
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(listed).toEqual([
      expect.objectContaining({
        id: created.id,
        text: "Follow up after the benchmark run.",
      }),
    ]);

    const persisted = await storage.readThreads();
    expect(persisted[0]?.backlog).toEqual([
      expect.objectContaining({
        id: created.id,
        text: "Follow up after the benchmark run.",
      }),
    ]);
  });

  it("updates and deletes backlog items", async () => {
    const { server } = await createServerFixture();
    const created = (await server.handleRpc("add_thread_backlog_item", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      text: "First draft",
    })) as { id: string };

    const updated = await server.handleRpc("update_thread_backlog_item", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: created.id,
      text: "Updated draft",
    });
    expect(updated).toEqual(
      expect.objectContaining({
        id: created.id,
        text: "Updated draft",
      }),
    );

    const deleted = await server.handleRpc("delete_thread_backlog_item", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: created.id,
    });
    expect(deleted).toBeNull();

    const listed = await server.handleRpc("get_thread_backlog", {
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(listed).toEqual([]);
  });

  it("routes start_thread through codex app-server and persists the remote thread id", async () => {
    const { server, storage, workspace } = await createServerFixture();
    const startThread = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-thread-2",
        cwd: workspace.path,
        preview: "Fresh thread",
        createdAt: 10,
        updatedAt: 11,
        turns: [],
        status: "idle",
      },
      model: "gpt-5-codex",
    });
    mockAppServerClient(server, { startThread });

    const result = await server.handleRpc("start_thread", { workspaceId: "ws-1" });

    expect(startThread).toHaveBeenCalledWith({
      cwd: workspace.path,
      approvalPolicy: "on-request",
    });
    expect(result).toEqual({
      thread: {
        id: "sdk-thread-2",
        preview: "Fresh thread",
        createdAt: 10,
        updatedAt: 11,
        cwd: workspace.path,
      },
    });
    const persisted = await storage.readThreads();
    expect(persisted.find((thread) => thread.id === "sdk-thread-2")).toMatchObject({
      sdkThreadId: "sdk-thread-2",
      workspaceId: "ws-1",
      modelId: "gpt-5-codex",
    });
  });

  it("routes send_user_message through turn/start and persists the active turn", async () => {
    const { server, storage, workspace, thread } = await createServerFixture();
    const startTurn = vi.fn().mockResolvedValue({
      turn: {
        id: "turn-2",
        status: "active",
        items: [],
      },
    });
    mockAppServerClient(server, { startTurn });

    const result = await server.handleRpc("send_user_message", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      text: "Ship it",
      model: "gpt-5-codex",
      effort: "high",
      serviceTier: "fast",
      accessMode: "workspace-write",
      images: ["/tmp/mock.png"],
      appMentions: [{ name: "Calendar", path: "app://calendar" }],
      collaborationMode: { mode: "delegate" },
    });

    expect(startTurn).toHaveBeenCalledWith({
      threadId: "sdk-thread-1",
      input: [
        { type: "text", text: "Ship it", text_elements: [] },
        { type: "localImage", path: "/tmp/mock.png" },
        { type: "mention", name: "Calendar", path: "app://calendar" },
      ],
      cwd: workspace.path,
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [workspace.path],
        networkAccess: true,
      },
      model: "gpt-5-codex",
      effort: "high",
      serviceTier: "fast",
      collaborationMode: { mode: "delegate" },
    });
    expect(result).toEqual({
      turn: {
        id: "turn-2",
        threadId: "thread-1",
      },
    });
    const persisted = (await storage.readThreads()).find((entry) => entry.id === thread.id);
    expect(persisted?.activeTurnId).toBe("turn-2");
    expect(persisted?.modelId).toBe("gpt-5-codex");
    expect(persisted?.effort).toBe("high");
    expect(persisted?.turns.at(-1)).toMatchObject({
      id: "turn-2",
      status: "active",
    });
  });

  it("preserves explicit null serviceTier overrides when starting a turn", async () => {
    const { server, workspace } = await createServerFixture();
    const startTurn = vi.fn().mockResolvedValue({
      turn: {
        id: "turn-2",
        status: "active",
        items: [],
      },
    });
    mockAppServerClient(server, { startTurn });

    await server.handleRpc("send_user_message", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      text: "Ship it",
      serviceTier: null,
      accessMode: "workspace-write",
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "sdk-thread-1",
        cwd: workspace.path,
        serviceTier: null,
      }),
    );
  });

  it("routes turn_interrupt through turn/interrupt using the active turn id", async () => {
    const { server, storage, thread } = await createServerFixture();
    await storage.writeThreads([{ ...thread, activeTurnId: "turn-live" }]);
    await server.initialize();
    const interruptTurn = vi.fn().mockResolvedValue({});
    mockAppServerClient(server, { interruptTurn });

    const result = await server.handleRpc("turn_interrupt", {
      workspaceId: "ws-1",
      threadId: "thread-1",
    });

    expect(interruptTurn).toHaveBeenCalledWith({
      threadId: "sdk-thread-1",
      turnId: "turn-live",
    });
    expect(result).toEqual({ turnId: "turn-live" });
  });

  it("clears stored active turn state when turn/completed omits the turn payload", async () => {
    const { server, storage, thread } = await createServerFixture();
    await storage.writeThreads([
      {
        ...thread,
        activeTurnId: "turn-live",
        turns: [
          {
            id: "turn-live",
            status: "active",
            createdAt: 1,
            completedAt: null,
            items: [],
            errorMessage: null,
          },
        ],
      },
    ]);
    await server.initialize();
    await (
      server as unknown as {
        handleAppServerNotification: (
          key: string,
          message: {
            method: string;
            params: Record<string, unknown>;
          },
        ) => Promise<void>;
      }
    ).handleAppServerNotification("client-key", {
      method: "turn/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-live",
      },
    });

    const persisted = (await storage.readThreads()).find((entry) => entry.id === "thread-1");
    expect(persisted?.activeTurnId).toBeNull();
    expect(persisted?.turns[0]).toMatchObject({
      id: "turn-live",
      status: "completed",
    });
    expect(persisted?.turns[0]?.completedAt).not.toBeNull();
  });

  it("refreshes stale active turn state from app-server before starting a new turn", async () => {
    const { server, storage, workspace, thread } = await createServerFixture();
    await storage.writeThreads([{ ...thread, activeTurnId: "turn-stale" }]);
    await server.initialize();
    const readThreadWithTurns = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-thread-1",
        cwd: workspace.path,
        preview: "Thread One",
        createdAt: 1,
        updatedAt: 3,
        status: { type: "idle" },
        turns: [],
      },
    });
    const startTurn = vi.fn().mockResolvedValue({
      turn: {
        id: "turn-2",
        status: "active",
        items: [],
      },
    });
    mockAppServerClient(server, { readThreadWithTurns, startTurn });

    const result = await server.handleRpc("send_user_message", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      text: "Ship it",
      accessMode: "workspace-write",
    });

    expect(readThreadWithTurns).toHaveBeenCalledWith("sdk-thread-1");
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      turn: {
        id: "turn-2",
        threadId: "thread-1",
      },
    });
  });

  it("does not rewrite a live in-progress turn with no item statuses to completed on resume", async () => {
    const { server, workspace } = await createServerFixture();
    await server.initialize();
    const resumeThread = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-thread-1",
        cwd: workspace.path,
        preview: "Thread One",
        createdAt: 1,
        updatedAt: 3,
        status: { type: "active" },
        activeTurnId: "turn-live",
        turns: [
          {
            id: "turn-live",
            status: "inProgress",
            items: [],
          },
        ],
      },
    });
    mockAppServerClient(server, { resumeThread });

    const result = await server.handleRpc("resume_thread", {
      workspaceId: "ws-1",
      threadId: "sdk-thread-1",
    });

    expect(result).toEqual({
      thread: expect.objectContaining({
        id: "sdk-thread-1",
        activeTurnId: "turn-live",
        status: { type: "active" },
        turns: [
          expect.objectContaining({
            id: "turn-live",
            status: "inProgress",
            items: [],
          }),
        ],
      }),
    });
  });

  it("does not rewrite a live in-progress turn when some streamed items still lack statuses", async () => {
    const { server, workspace } = await createServerFixture();
    await server.initialize();
    const resumeThread = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-thread-1",
        cwd: workspace.path,
        preview: "Thread One",
        createdAt: 1,
        updatedAt: 3,
        status: { type: "idle" },
        activeTurnId: null,
        turns: [
          {
            id: "turn-live",
            status: "inProgress",
            items: [
              { id: "item-1", type: "reasoning", status: "completed" },
              { id: "item-2", type: "agentMessage" },
            ],
          },
        ],
      },
    });
    mockAppServerClient(server, { resumeThread });

    const result = await server.handleRpc("resume_thread", {
      workspaceId: "ws-1",
      threadId: "sdk-thread-1",
    });

    expect(result).toEqual({
      thread: expect.objectContaining({
        id: "sdk-thread-1",
        activeTurnId: null,
        status: { type: "idle" },
        turns: [
          expect.objectContaining({
            id: "turn-live",
            status: "inProgress",
            items: [
              expect.objectContaining({ id: "item-1", status: "completed" }),
              expect.objectContaining({ id: "item-2" }),
            ],
          }),
        ],
      }),
    });
  });

  it("updates stored thread items when item notifications carry threadId on the item payload", async () => {
    const { server, storage, thread } = await createServerFixture();
    await storage.writeThreads([
      {
        ...thread,
        activeTurnId: "turn-live",
        turns: [
          {
            id: "turn-live",
            status: "active",
            createdAt: 1,
            completedAt: null,
            items: [],
            errorMessage: null,
          },
        ],
      },
    ]);
    await server.initialize();

    await (
      server as unknown as {
        handleAppServerNotification: (
          key: string,
          message: {
            method: string;
            params: Record<string, unknown>;
          },
        ) => Promise<void>;
      }
    ).handleAppServerNotification("client-key", {
      method: "item/completed",
      params: {
        item: {
          id: "item-1",
          turnId: "turn-live",
          threadId: "sdk-thread-1",
          type: "agentMessage",
          text: "Done",
        },
      },
    });

    const persisted = (await storage.readThreads()).find((entry) => entry.id === "thread-1");
    expect(persisted?.turns[0]?.items).toEqual([
      expect.objectContaining({
        id: "turn-live:item-1",
        type: "agentMessage",
        text: "Done",
      }),
    ]);
  });

  it("broadcasts item notifications with an inferred threadId when only turnId is present", async () => {
    const broadcast = vi.fn();
    const { server, storage, thread } = await createServerFixture(broadcast);
    await storage.writeThreads([
      {
        ...thread,
        activeTurnId: "turn-live",
        turns: [
          {
            id: "turn-live",
            status: "active",
            createdAt: 1,
            completedAt: null,
            items: [],
            errorMessage: null,
          },
        ],
      },
    ]);
    await server.initialize();

    await (
      server as unknown as {
        handleAppServerNotification: (
          key: string,
          message: {
            method: string;
            params: Record<string, unknown>;
          },
        ) => Promise<void>;
      }
    ).handleAppServerNotification("client-key", {
      method: "item/started",
      params: {
        item: {
          id: "item-1",
          turnId: "turn-live",
          type: "commandExecution",
          status: "inProgress",
        },
      },
    });

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "app-server-event",
        payload: expect.objectContaining({
          workspace_id: "ws-1",
          message: expect.objectContaining({
            method: "item/started",
            params: expect.objectContaining({
              threadId: "sdk-thread-1",
            }),
          }),
        }),
      }),
    );
  });

  it("does not surface stale local active turn ids in list_threads when app-server reports idle", async () => {
    const { server, storage, thread } = await createServerFixture();
    await storage.writeThreads([{ ...thread, activeTurnId: "turn-stale" }]);
    const listThreads = vi.fn().mockResolvedValue({
      data: [
        {
          id: "sdk-thread-1",
          cwd: thread.cwd,
          preview: "Thread One",
          createdAt: 1,
          updatedAt: 5,
          status: { type: "idle" },
        },
      ],
      nextCursor: null,
    });
    mockAppServerClient(server, { listThreads });

    const result = await server.handleRpc("list_threads", {
      workspaceId: "ws-1",
      cursor: null,
      limit: 20,
      sortKey: "updated_at",
    });

    expect(result).toMatchObject({
      data: [
        {
          id: "thread-1",
          updatedAt: 5,
        },
      ],
    });
    const returnedThread = (result as { data: Array<Record<string, unknown>> }).data[0];
    expect(returnedThread?.activeTurnId).toBeUndefined();
  });

  it("lists threads against the requested workspace-scoped app-server runtime", async () => {
    const { server, workspace, thread } = await createServerFixture();
    const otherWorkspace: StoredWorkspace = {
      id: "ws-2",
      name: "Workspace 2",
      path: path.join(path.dirname(workspace.path), "workspace-2"),
      settings: {
        sidebarCollapsed: false,
      },
    };
    await fs.mkdir(otherWorkspace.path, { recursive: true });
    const otherThread: StoredThread = {
      id: "thread-2",
      workspaceId: "ws-2",
      sdkThreadId: "sdk-thread-2",
      cwd: otherWorkspace.path,
      createdAt: 10,
      updatedAt: 20,
      archivedAt: null,
      name: null,
      preview: "Thread Two",
      activeTurnId: null,
      turns: [],
      modelId: null,
      effort: null,
      backlog: [],
      tokenUsage: null,
    };
    await server["storage"].writeWorkspaces([workspace, otherWorkspace]);
    await server["storage"].writeThreads([thread, otherThread]);
    await server.initialize();
    const buildAppServerClient = vi.fn().mockImplementation((_settings, targetWorkspaceId) => {
      if (targetWorkspaceId !== "ws-1") {
        throw new Error(`unexpected workspace ${String(targetWorkspaceId)}`);
      }
      return {
        listThreads: vi.fn().mockResolvedValue({
          data: [
            {
              id: "sdk-thread-1",
              cwd: thread.cwd,
              preview: "Thread One",
              createdAt: 1,
              updatedAt: 5,
            },
          ],
          nextCursor: null,
        }),
      };
    });
    (
      server as unknown as {
        buildAppServerClient: typeof buildAppServerClient;
      }
    ).buildAppServerClient = buildAppServerClient;

    const result = await server.handleRpc("list_threads", {
      workspaceId: "ws-1",
      cursor: null,
      limit: 20,
      sortKey: "updated_at",
    });

    expect(buildAppServerClient).toHaveBeenCalledWith(expect.anything(), "ws-1");
    expect(result).toMatchObject({
      data: [
        {
          id: "thread-1",
        },
      ],
      nextCursor: null,
    });
  });

  it("keeps locally archived threads hidden across list_threads refreshes", async () => {
    const { server, storage, thread } = await createServerFixture();
    await storage.writeThreads([
      {
        ...thread,
        archivedAt: 1234,
      },
    ]);
    await server.initialize();
    const listThreads = vi.fn().mockResolvedValue({
      data: [
        {
          id: "sdk-thread-1",
          cwd: thread.cwd,
          preview: "Thread One",
          createdAt: 1,
          updatedAt: 5,
        },
      ],
      nextCursor: null,
    });
    mockAppServerClient(server, { listThreads });

    const result = await server.handleRpc("list_threads", {
      workspaceId: "ws-1",
      cursor: null,
      limit: 20,
      sortKey: "updated_at",
    });

    expect(result).toEqual({
      data: [],
      nextCursor: null,
    });
  });

  it("surfaces archived threads again after thread/unarchived notification", async () => {
    const { server, storage, thread } = await createServerFixture();
    await storage.writeThreads([
      {
        ...thread,
        archivedAt: 1234,
      },
    ]);
    await server.initialize();
    await (
      server as unknown as {
        handleAppServerNotification: (
          key: string,
          message: {
            method: string;
            params: Record<string, unknown>;
          },
        ) => Promise<void>;
      }
    ).handleAppServerNotification("client-key", {
      method: "thread/unarchived",
      params: {
        threadId: "sdk-thread-1",
      },
    });
    const listThreads = vi.fn().mockResolvedValue({
      data: [
        {
          id: "sdk-thread-1",
          cwd: thread.cwd,
          preview: "Thread One",
          createdAt: 1,
          updatedAt: 5,
        },
      ],
      nextCursor: null,
    });
    mockAppServerClient(server, { listThreads });

    const result = await server.handleRpc("list_threads", {
      workspaceId: "ws-1",
      cursor: null,
      limit: 20,
      sortKey: "updated_at",
    });

    expect(result).toMatchObject({
      data: [
        {
          id: "thread-1",
          updatedAt: 5,
        },
      ],
      nextCursor: null,
    });
    const persisted = (await storage.readThreads()).find((entry) => entry.id === "thread-1");
    expect(persisted?.archivedAt).toBeNull();
  });

  it("clears stored active turn state when turn/completed omits the turn payload", async () => {
    const { server, storage, thread } = await createServerFixture();
    await storage.writeThreads([
      {
        ...thread,
        activeTurnId: "turn-live",
        turns: [
          {
            id: "turn-live",
            status: "active",
            createdAt: 1,
            completedAt: null,
            items: [],
            errorMessage: null,
          },
        ],
      },
    ]);
    await server.initialize();
    await (
      server as unknown as {
        handleAppServerNotification: (
          key: string,
          message: {
            method: string;
            params: Record<string, unknown>;
          },
        ) => Promise<void>;
      }
    ).handleAppServerNotification("client-key", {
      method: "turn/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-live",
      },
    });

    const persisted = (await storage.readThreads()).find((entry) => entry.id === "thread-1");
    expect(persisted?.activeTurnId).toBeNull();
    expect(persisted?.turns[0]).toMatchObject({
      id: "turn-live",
      status: "completed",
    });
    expect(persisted?.turns[0]?.completedAt).not.toBeNull();
  });

  it("refreshes stale active turn state from app-server before starting a new turn", async () => {
    const { server, storage, workspace, thread } = await createServerFixture();
    await storage.writeThreads([{ ...thread, activeTurnId: "turn-stale" }]);
    await server.initialize();
    const readThreadWithTurns = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-thread-1",
        cwd: workspace.path,
        preview: "Thread One",
        createdAt: 1,
        updatedAt: 3,
        status: { type: "idle" },
        turns: [],
      },
    });
    const startTurn = vi.fn().mockResolvedValue({
      turn: {
        id: "turn-2",
        status: "active",
        items: [],
      },
    });
    mockAppServerClient(server, { readThreadWithTurns, startTurn });

    const result = await server.handleRpc("send_user_message", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      text: "Ship it",
      accessMode: "workspace-write",
    });

    expect(readThreadWithTurns).toHaveBeenCalledWith("sdk-thread-1");
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      turn: {
        id: "turn-2",
        threadId: "thread-1",
      },
    });
  });

  it("routes respond_to_server_request through app-server sendResponse", async () => {
    const { server } = await createServerFixture();
    const sendResponse = vi.fn().mockResolvedValue(undefined);
    mockAppServerClient(server, { sendResponse });

    const result = await server.handleRpc("respond_to_server_request", {
      workspaceId: "ws-1",
      requestId: 42,
      result: { decision: "approved" },
    });

    expect(sendResponse).toHaveBeenCalledWith(42, { decision: "approved" });
    expect(result).toBeNull();
  });

  it("persists approval prefix rules without duplicating entries", async () => {
    const { dir, server } = await createServerFixture();
    vi.stubEnv("CODEX_HOME", path.join(dir, "codex-home"));

    const first = await server.handleRpc("remember_approval_rule", {
      workspaceId: "ws-1",
      command: ["git", "status"],
    });
    const second = await server.handleRpc("remember_approval_rule", {
      workspaceId: "ws-1",
      command: ["git", "status"],
    });

    expect(first).toMatchObject({ ok: true, rulesPath: expect.any(String) });
    expect(second).toMatchObject({ ok: true, rulesPath: expect.any(String) });
    const rulesPath = (first as { rulesPath: string }).rulesPath;
    const contents = await fs.readFile(rulesPath, "utf8");
    expect(
      contents.match(
        /prefix_rule\(\s*pattern = \["git", "status"\],\s*decision = "allow",\s*\)/g,
      ),
    ).toHaveLength(1);
    expect(contents).toContain('pattern = ["git", "status"]');
  });

  it("forwards app-server server requests with their request id", async () => {
    const messages: Array<{ event: string; payload: { workspace_id: string; message: Record<string, unknown> } }> = [];
    const { server } = await createServerFixture((message) => {
      messages.push(message as { event: string; payload: { workspace_id: string; message: Record<string, unknown> } });
    });
    await (
      server as unknown as {
        handleAppServerNotification: (
          key: string,
          message: {
            id?: string | number;
            method: string;
            params: Record<string, unknown>;
          },
        ) => Promise<void>;
      }
    ).handleAppServerNotification("client-key", {
      id: 7,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-live",
        itemId: "item-1",
        questions: [],
      },
    });

    expect(messages[0]?.payload.message).toMatchObject({
      id: 7,
      method: "item/tool/requestUserInput",
    });
  });

  it("routes turn_steer through codex app-server", async () => {
    const { server } = await createServerFixture();
    const steerTurn = vi.fn().mockResolvedValue({ turnId: "turn-2" });
    mockAppServerClient(server, { steerTurn });

    const result = await server.handleRpc("turn_steer", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-active",
      text: "Refine the patch",
      images: ["/tmp/image.png"],
      appMentions: [{ name: "Calendar", path: "app://calendar" }],
    });

    expect(steerTurn).toHaveBeenCalledWith({
      threadId: "sdk-thread-1",
      expectedTurnId: "turn-active",
      input: [
        { type: "text", text: "Refine the patch", text_elements: [] },
        { type: "localImage", path: "/tmp/image.png" },
        { type: "mention", name: "Calendar", path: "app://calendar" },
      ],
    });
    expect(result).toEqual({ turnId: "turn-2" });
  });

  it("imports a detached review thread after review/start", async () => {
    const { server, storage, workspace } = await createServerFixture();
    const startReview = vi.fn().mockResolvedValue({
      turn: { id: "turn-review", status: "active", items: [] },
      reviewThreadId: "sdk-review-1",
    });
    const resumeThread = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-review-1",
        cwd: workspace.path,
        preview: "Review thread",
        createdAt: 10,
        updatedAt: 20,
        turns: [],
        status: "idle",
      },
    });
    mockAppServerClient(server, { startReview, resumeThread });

    const result = await server.handleRpc("start_review", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      target: { type: "custom", instructions: "Review this patch" },
      delivery: "detached",
    });

    expect(result).toEqual({
      turn: { id: "turn-review", status: "active", items: [] },
      reviewThreadId: "sdk-review-1",
    });
    const threads = await storage.readThreads();
    expect(threads.some((thread) => thread.id === "sdk-review-1")).toBe(true);
  });

  it("persists forked threads returned by thread/fork", async () => {
    const { server, storage, workspace } = await createServerFixture();
    const forkThread = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-fork-1",
        cwd: workspace.path,
        preview: "Forked thread",
        createdAt: 30,
        updatedAt: 40,
        turns: [],
        status: "idle",
      },
    });
    mockAppServerClient(server, { forkThread });

    const result = await server.handleRpc("fork_thread", {
      workspaceId: "ws-1",
      threadId: "thread-1",
    });

    expect(result).toEqual({
      thread: {
        id: "sdk-fork-1",
        cwd: workspace.path,
        preview: "Forked thread",
        createdAt: 30,
        updatedAt: 40,
        turns: [],
        status: "idle",
      },
    });
    const threads = await storage.readThreads();
    expect(threads.some((thread) => thread.id === "sdk-fork-1")).toBe(true);
  });

  it("rolls a thread back to a selected user message and preserves local metadata", async () => {
    const { server, storage, workspace, thread } = await createServerFixture();
    const storedThread: StoredThread = {
      ...thread,
      name: "Pinned title",
      backlog: [
        {
          id: "backlog-1",
          text: "later",
          createdAt: 11,
          updatedAt: 11,
        },
      ],
      turns: [
        {
          id: "turn-1",
          createdAt: 1,
          completedAt: 2,
          status: "completed",
          errorMessage: null,
          items: [
            {
              id: "item-user-1",
              type: "userMessage",
              content: [{ type: "text", text: "First draft" }],
            },
            {
              id: "item-agent-1",
              type: "agentMessage",
              text: "Reply",
            },
          ],
        },
        {
          id: "turn-2",
          createdAt: 3,
          completedAt: 4,
          status: "completed",
          errorMessage: null,
          items: [
            {
              id: "item-user-2",
              type: "userMessage",
              content: [{ type: "text", text: "Second draft" }],
            },
          ],
        },
      ],
    };
    await storage.writeThreads([storedThread]);
    await server.initialize();

    const rollbackThread = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-thread-1",
        cwd: workspace.path,
        preview: "Rolled back",
        createdAt: 1,
        updatedAt: 99,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "item-user-1",
                type: "userMessage",
                content: [{ type: "text", text: "First draft" }],
              },
            ],
          },
        ],
        status: "idle",
      },
    });
    mockAppServerClient(server, { rollbackThread });

    const result = await server.handleRpc("rollback_thread_to_message", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      messageItemId: "item-user-1",
    });

    expect(rollbackThread).toHaveBeenCalledWith("sdk-thread-1", 2);
    expect(result).toEqual({
      restoredText: "First draft",
      thread: {
        id: "thread-1",
        cwd: workspace.path,
        preview: "Pinned title",
        createdAt: 1,
        updatedAt: 99,
        activeTurnId: null,
        source: "appServer",
        model: null,
        modelReasoningEffort: null,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            createdAt: 1,
            completedAt: 2,
            items: [
              {
                id: "item-user-1",
                type: "userMessage",
                content: [{ type: "text", text: "First draft" }],
              },
            ],
            errorMessage: null,
          },
        ],
        tokenUsage: null,
      },
    });
    const threads = await storage.readThreads();
    expect(threads[0]?.name).toBe("Pinned title");
    expect(threads[0]?.backlog).toEqual(storedThread.backlog);
  });

  it("rejects rollback targets that are not user messages", async () => {
    const { server, storage, thread } = await createServerFixture();
    const storedThread: StoredThread = {
      ...thread,
      turns: [
        {
          id: "turn-1",
          createdAt: 1,
          completedAt: 2,
          status: "completed",
          errorMessage: null,
          items: [
            {
              id: "item-agent-1",
              type: "agentMessage",
              text: "Reply",
            },
          ],
        },
      ],
    };
    await storage.writeThreads([storedThread]);
    await server.initialize();

    const result = await server.handleRpc("rollback_thread_to_message", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      messageItemId: "item-agent-1",
    });

    expect(result).toEqual({
      error: { message: "Only user messages can be used as rollback targets." },
    });
  });

  it("preserves a local thread rename when app-server sync omits the name", async () => {
    const { server, storage, workspace, thread } = await createServerFixture();
    await storage.writeThreads([{ ...thread, name: "Pinned local title" }]);
    await server.initialize();

    const resumeThread = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-thread-1",
        cwd: workspace.path,
        preview: "External preview",
        createdAt: 10,
        updatedAt: 20,
        turns: [],
        status: "idle",
      },
    });
    mockAppServerClient(server, { resumeThread });

    const syncStoredThreadFromAppServer = (
      server as unknown as {
        syncStoredThreadFromAppServer: (
          workspaceId: string,
          threadId: string,
          existing?: StoredThread | null,
        ) => Promise<StoredThread>;
      }
    ).syncStoredThreadFromAppServer.bind(server);

    const existingThread = (await storage.readThreads())[0] ?? null;
    const synced = await syncStoredThreadFromAppServer("ws-1", "sdk-thread-1", existingThread);

    expect(synced.name).toBe("Pinned local title");
    const threads = await storage.readThreads();
    expect(threads.find((entry) => entry.id === "thread-1")?.name).toBe("Pinned local title");
  });

  it("generates run metadata from a detached app-server turn", async () => {
    const { server } = await createServerFixture();
    const startThread = vi.fn().mockResolvedValue({
      thread: { id: "meta-thread-1" },
    });
    const waitForNotification = vi.fn().mockResolvedValue({
      threadId: "meta-thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    const startTurn = vi.fn().mockResolvedValue({
      threadId: "meta-thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    });
    const readThreadWithTurns = vi.fn().mockResolvedValue({
      thread: {
        id: "meta-thread-1",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                type: "agentMessage",
                text: '{"title":"Fix Login Redirect Loop","worktreeName":"fix/login-redirect-loop"}',
              },
            ],
          },
        ],
      },
    });
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const onNotification = vi.fn().mockReturnValue(() => undefined);
    mockDetachedAppServerClient(server, {
      archiveThread,
      close,
      onNotification,
      readThreadWithTurns,
      startThread,
      startTurn,
      waitForNotification,
    });

    const result = await server.handleRpc("generate_run_metadata", {
      workspaceId: "ws-1",
      prompt: "Fix the login redirect loop",
    });

    expect(startThread).toHaveBeenCalledWith({
      cwd: expect.any(String),
      approvalPolicy: "never",
    });
    expect(startTurn).toHaveBeenCalledWith({
      threadId: "meta-thread-1",
      input: expect.any(Array),
      cwd: expect.any(String),
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
      outputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          worktreeName: { type: "string" },
        },
        required: ["title", "worktreeName"],
        additionalProperties: false,
      },
    });
    expect(readThreadWithTurns).toHaveBeenCalledWith("meta-thread-1");
    expect(archiveThread).toHaveBeenCalledWith("meta-thread-1");
    expect(close).toHaveBeenCalled();
    expect(result).toEqual({
      title: "Fix Login Redirect Loop",
      worktreeName: "fix/login-redirect-loop",
    });
  });

  it("generates commit messages from a detached app-server turn", async () => {
    const { server, storage, workspace } = await createServerFixture();
    await storage.writeSettings({
      commitMessagePrompt:
        "Summarize these changes as a single conventional commit message. Changes:\n{diff}",
    });
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\nworld\n", "utf8");

    let notificationHandler:
      | ((message: { method: string; params: Record<string, unknown> }) => void)
      | null = null;
    const startThread = vi.fn().mockResolvedValue({
      thread: { id: "meta-thread-2" },
    });
    const startTurn = vi.fn().mockImplementation(async () => {
      notificationHandler?.({
        method: "item/agentMessage/delta",
        params: {
          threadId: "meta-thread-2",
          delta: "fix: refine git metadata parity",
        },
      });
      return {
        threadId: "meta-thread-2",
        turn: { id: "turn-2", status: "inProgress" },
      };
    });
    const waitForNotification = vi.fn().mockResolvedValue({
      threadId: "meta-thread-2",
      turn: { id: "turn-2", status: "completed" },
    });
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const onNotification = vi.fn().mockImplementation((callback) => {
      notificationHandler = callback as typeof notificationHandler;
      return () => {
        notificationHandler = null;
      };
    });
    mockDetachedAppServerClient(server, {
      archiveThread,
      close,
      onNotification,
      startThread,
      startTurn,
      waitForNotification,
    });

    const result = await server.handleRpc("generate_commit_message", {
      workspaceId: "ws-1",
      commitMessageModelId: "gpt-5-codex-mini",
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "meta-thread-2",
        model: "gpt-5-codex-mini",
      }),
    );
    expect(result).toBe("fix: refine git metadata parity");
    expect(archiveThread).toHaveBeenCalledWith("meta-thread-2");
    expect(close).toHaveBeenCalled();
  });

  it("generates agent descriptions from a detached app-server turn", async () => {
    const { server } = await createServerFixture();
    const startThread = vi.fn().mockResolvedValue({
      thread: { id: "meta-thread-3" },
    });
    const startTurn = vi.fn().mockResolvedValue({
      threadId: "meta-thread-3",
      turn: { id: "turn-3", status: "inProgress" },
    });
    const waitForNotification = vi.fn().mockResolvedValue({
      threadId: "meta-thread-3",
      turn: { id: "turn-3", status: "completed" },
    });
    const readThreadWithTurns = vi.fn().mockResolvedValue({
      thread: {
        id: "meta-thread-3",
        turns: [
          {
            id: "turn-3",
            items: [
              {
                type: "agentMessage",
                text:
                  '{"description":"Triages flaky integration failures","developerInstructions":"Reproduce failing scenarios first.\\nIdentify nondeterministic dependencies.\\nPrefer minimal fixes and add regression coverage."}',
              },
            ],
          },
        ],
      },
    });
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const onNotification = vi.fn().mockReturnValue(() => undefined);
    mockDetachedAppServerClient(server, {
      archiveThread,
      close,
      onNotification,
      readThreadWithTurns,
      startThread,
      startTurn,
      waitForNotification,
    });

    const result = await server.handleRpc("generate_agent_description", {
      workspaceId: "ws-1",
      description: "Make an agent that stabilizes flaky integration tests",
    });

    expect(result).toEqual({
      description: "Triages flaky integration failures",
      developerInstructions:
        "Reproduce failing scenarios first.\nIdentify nondeterministic dependencies.\nPrefer minimal fixes and add regression coverage.",
    });
    expect(archiveThread).toHaveBeenCalledWith("meta-thread-3");
    expect(close).toHaveBeenCalled();
  });

  it("reads local usage snapshots from CODEX_HOME sessions", async () => {
    const { server, workspace } = await createServerFixture();
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-codex-home-"));
    tempDirs.push(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);

    const now = new Date();
    const year = `${now.getFullYear()}`;
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    const sessionDir = path.join(codexHome, "sessions", year, month, day);
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: workspace.path },
      }),
      JSON.stringify({
        type: "turn_context",
        payload: { cwd: workspace.path, model: "gpt-5-codex" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now.toISOString(),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 4,
              output_tokens: 6,
            },
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now.getTime() + 1_000).toISOString(),
        payload: { type: "agent_message" },
      }),
    ];
    await fs.writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");

    const result = await server.handleRpc("local_usage_snapshot", {
      days: 7,
      workspacePath: workspace.path,
    });

    expect(result).toMatchObject({
      totals: {
        last7DaysTokens: 16,
        last30DaysTokens: 16,
        cacheHitRatePercent: 40,
        peakDay: `${year}-${month}-${day}`,
        peakDayTokens: 16,
      },
      topModels: [{ model: "gpt-5-codex", tokens: 16, sharePercent: 100 }],
    });
    expect((result as { days: Array<{ day: string; totalTokens: number; agentRuns: number }> }).days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          day: `${year}-${month}-${day}`,
          totalTokens: 16,
          agentRuns: 1,
        }),
      ]),
    );
  });

  it("does not double count last usage before total usage snapshots", async () => {
    const { server, workspace } = await createServerFixture();
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-codex-home-"));
    tempDirs.push(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);

    const now = new Date();
    const year = `${now.getFullYear()}`;
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    const sessionDir = path.join(codexHome, "sessions", year, month, day);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: workspace.path },
        }),
        JSON.stringify({
          timestamp: now.toISOString(),
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: new Date(now.getTime() + 1_000).toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 20,
                cached_input_tokens: 0,
                output_tokens: 10,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await server.handleRpc("local_usage_snapshot", {
      days: 7,
      workspacePath: workspace.path,
    });

    expect(result).toMatchObject({
      totals: {
        last7DaysTokens: 30,
        last30DaysTokens: 30,
        peakDayTokens: 30,
      },
    });
  });

  it("does not double count last usage between total usage snapshots", async () => {
    const { server, workspace } = await createServerFixture();
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-codex-home-"));
    tempDirs.push(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);

    const now = new Date();
    const year = `${now.getFullYear()}`;
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    const sessionDir = path.join(codexHome, "sessions", year, month, day);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: workspace.path },
        }),
        JSON.stringify({
          timestamp: now.toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: new Date(now.getTime() + 1_000).toISOString(),
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 2,
                cached_input_tokens: 0,
                output_tokens: 1,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: new Date(now.getTime() + 2_000).toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 12,
                cached_input_tokens: 0,
                output_tokens: 6,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await server.handleRpc("local_usage_snapshot", {
      days: 7,
      workspacePath: workspace.path,
    });

    expect(result).toMatchObject({
      totals: {
        last7DaysTokens: 18,
        last30DaysTokens: 18,
        peakDayTokens: 18,
      },
    });
  });

  it("skips local usage files whose session workspace does not match the filter", async () => {
    const { server } = await createServerFixture();
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-codex-home-"));
    tempDirs.push(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);

    const now = new Date();
    const year = `${now.getFullYear()}`;
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    const sessionDir = path.join(codexHome, "sessions", year, month, day);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/tmp/project-alpha" },
        }),
        JSON.stringify({
          timestamp: now.toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await server.handleRpc("local_usage_snapshot", {
      days: 7,
      workspacePath: "/tmp/other-project",
    });

    expect(result).toMatchObject({
      totals: {
        last7DaysTokens: 0,
        last30DaysTokens: 0,
        peakDay: null,
        peakDayTokens: 0,
      },
      topModels: [],
    });
  });

  it("reuses a cached local usage snapshot for identical requests", async () => {
    const { server, workspace } = await createServerFixture();
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-codex-home-"));
    tempDirs.push(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);

    const now = new Date();
    const year = `${now.getFullYear()}`;
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    const sessionDir = path.join(codexHome, "sessions", year, month, day);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: workspace.path },
        }),
        JSON.stringify({
          timestamp: now.toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const readdirSpy = vi.spyOn(fs, "readdir");

    const first = await server.handleRpc("local_usage_snapshot", {
      days: 7,
      workspacePath: workspace.path,
    });
    const second = await server.handleRpc("local_usage_snapshot", {
      days: 7,
      workspacePath: workspace.path,
    });

    expect(first).toEqual(second);
    expect(readdirSpy).toHaveBeenCalledTimes(7);
  });

  it("deduplicates concurrent local usage snapshot requests", async () => {
    const { server, workspace } = await createServerFixture();
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-codex-home-"));
    tempDirs.push(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);

    const now = new Date();
    const year = `${now.getFullYear()}`;
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    const sessionDir = path.join(codexHome, "sessions", year, month, day);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: workspace.path },
        }),
        JSON.stringify({
          timestamp: now.toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const readdirSpy = vi.spyOn(fs, "readdir");

    const [first, second] = await Promise.all([
      server.handleRpc("local_usage_snapshot", {
        days: 7,
        workspacePath: workspace.path,
      }),
      server.handleRpc("local_usage_snapshot", {
        days: 7,
        workspacePath: workspace.path,
      }),
    ]);

    expect(first).toEqual(second);
    expect(readdirSpy).toHaveBeenCalledTimes(7);
  });

  it("routes model_list through codex app-server", async () => {
    const { server } = await createServerFixture();
    const modelList = vi.fn().mockResolvedValue({ data: [{ id: "gpt-5-codex" }] });
    mockAppServerClient(server, { modelList });

    const result = await server.handleRpc("model_list", { workspaceId: "ws-1" });

    expect(modelList).toHaveBeenCalledWith();
    expect(result).toEqual({ data: [{ id: "gpt-5-codex" }] });
  });

  it("augments skills_list with source path metadata", async () => {
    const { server, workspace } = await createServerFixture();
    const skillsDir = path.join(workspace.path, ".agents", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const skillsList = vi.fn().mockResolvedValue({ data: [{ name: "review" }] });
    mockAppServerClient(server, { skillsList });

    const result = await server.handleRpc("skills_list", { workspaceId: "ws-1" });

    expect(skillsList).toHaveBeenCalledWith({
      cwd: workspace.path,
      skillsPaths: [skillsDir],
    });
    expect(result).toEqual({
      data: [{ name: "review" }],
      sourcePaths: [skillsDir],
      sourceErrors: [],
    });
  });

  it("merges account_read fallback auth details", async () => {
    const { server } = await createServerFixture();
    const accountRead = vi.fn().mockResolvedValue({
      account: { type: "chatgpt" },
      requiresOpenaiAuth: true,
    });
    mockAppServerClient(server, { accountRead });
    (
      server as unknown as {
        readAuthAccountFallback: () => Promise<{ email: string; planType: string }>;
      }
    ).readAuthAccountFallback = async () => ({
      email: "dev@example.com",
      planType: "plus",
    });

    const result = await server.handleRpc("account_read", { workspaceId: "ws-1" });

    expect(result).toEqual({
      account: {
        type: "chatgpt",
        email: "dev@example.com",
        planType: "plus",
      },
      requiresOpenaiAuth: true,
    });
  });

  it("wraps codex_login and codex_login_cancel around app-server auth flows", async () => {
    const { server } = await createServerFixture();
    const startLogin = vi.fn().mockResolvedValue({
      login_id: "login-1",
      auth_url: "https://example.com/auth",
    });
    const cancelLogin = vi.fn().mockResolvedValue({
      canceled: true,
      status: "canceled",
    });
    mockAppServerClient(server, { startLogin, cancelLogin });

    const started = await server.handleRpc("codex_login", { workspaceId: "ws-1" });
    const canceled = await server.handleRpc("codex_login_cancel", { workspaceId: "ws-1" });

    expect(started).toEqual({
      loginId: "login-1",
      authUrl: "https://example.com/auth",
      raw: {
        login_id: "login-1",
        auth_url: "https://example.com/auth",
      },
    });
    expect(cancelLogin).toHaveBeenCalledWith("login-1");
    expect(canceled).toEqual({
      canceled: true,
      status: "canceled",
      raw: {
        canceled: true,
        status: "canceled",
      },
    });
  });

  it("does not respawn runtime args when the workspace is connected but no app-server runtime exists", async () => {
    const { server } = await createServerFixture();
    const resetAppServerClients = vi.fn().mockResolvedValue(undefined);
    (
      server as unknown as {
        resetAppServerClients: typeof resetAppServerClients;
      }
    ).resetAppServerClients = resetAppServerClients;

    await server.handleRpc("connect_workspace", { id: "ws-1" });
    const result = await server.handleRpc("set_workspace_runtime_codex_args", {
      workspaceId: "ws-1",
      codexArgs: "--profile web",
    });

    expect(resetAppServerClients).not.toHaveBeenCalled();
    expect(result).toEqual({
      appliedCodexArgs: "--profile web",
      respawned: false,
    });
  });

  it("respawns app-server clients when connected workspace runtime args change and a runtime exists", async () => {
    const { server } = await createServerFixture();
    const resetAppServerClients = vi.fn().mockResolvedValue(undefined);
    (
      server as unknown as {
        resetAppServerClients: typeof resetAppServerClients;
      }
    ).resetAppServerClients = resetAppServerClients;
    (
      server as unknown as {
        hasActiveAppServerRuntime: () => boolean;
      }
    ).hasActiveAppServerRuntime = () => true;

    await server.handleRpc("connect_workspace", { id: "ws-1" });
    const result = await server.handleRpc("set_workspace_runtime_codex_args", {
      workspaceId: "ws-1",
      codexArgs: "--profile web",
    });

    expect(resetAppServerClients).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      appliedCodexArgs: "--profile web",
      respawned: true,
    });
  });

  it("does not respawn app-server clients when runtime args are unchanged", async () => {
    const { server } = await createServerFixture();
    const resetAppServerClients = vi.fn().mockResolvedValue(undefined);
    (
      server as unknown as {
        resetAppServerClients: typeof resetAppServerClients;
      }
    ).resetAppServerClients = resetAppServerClients;
    (
      server as unknown as {
        hasActiveAppServerRuntime: () => boolean;
      }
    ).hasActiveAppServerRuntime = () => true;

    await server.handleRpc("connect_workspace", { id: "ws-1" });
    await server.handleRpc("set_workspace_runtime_codex_args", {
      workspaceId: "ws-1",
      codexArgs: "--profile web",
    });
    resetAppServerClients.mockClear();

    const result = await server.handleRpc("set_workspace_runtime_codex_args", {
      workspaceId: "ws-1",
      codexArgs: "--profile web",
    });

    expect(resetAppServerClients).not.toHaveBeenCalled();
    expect(result).toEqual({
      appliedCodexArgs: "--profile web",
      respawned: false,
    });
  });

  it("supports admin parity methods and url-only opener behavior", async () => {
    const { server } = await createServerFixture(() => {}, null);

    expect(await server.handleRpc("ping", {})).toEqual({ ok: true });
    expect(await server.handleRpc("daemon_shutdown", {})).toEqual({ ok: true });
    expect(await server.handleRpc("open_workspace_in", { path: "https://example.com" })).toBeNull();
    expect(await server.handleRpc("open_workspace_in", { path: "/tmp/project" })).toEqual({
      error: {
        message: "open_workspace_in only supports http(s) URLs in the web companion.",
      },
    });

    const info = await server.handleRpc("daemon_info", {});
    expect(info).toMatchObject({
      name: "codex-monitor-web",
      mode: "typescript",
      transport: "http",
      capabilities: {
        terminal: expect.any(Boolean),
      },
    });
  });

  it("routes terminal RPCs through the configured terminal runtime", async () => {
    const openSession = vi.fn().mockResolvedValue({ id: "term-1" });
    const writeSession = vi.fn().mockResolvedValue(undefined);
    const resizeSession = vi.fn().mockResolvedValue(undefined);
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const terminalRuntime: TerminalRuntime = {
      openSession,
      writeSession,
      resizeSession,
      closeSession,
      closeAll,
    };
    const { server, workspace } = await createServerFixture(() => {}, terminalRuntime);

    expect(
      await server.handleRpc("terminal_open", {
        workspaceId: "ws-1",
        terminalId: "term-1",
        cols: 120,
        rows: 40,
        restoreOnly: true,
      }),
    ).toEqual({ id: "term-1" });
    expect(openSession).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      terminalId: "term-1",
      cwd: workspace.path,
      cols: 120,
      rows: 40,
      restoreOnly: true,
    });

    expect(
      await server.handleRpc("terminal_write", {
        workspaceId: "ws-1",
        terminalId: "term-1",
        data: "echo hi\n",
      }),
    ).toBeNull();
    expect(writeSession).toHaveBeenCalledWith("ws-1", "term-1", "echo hi\n");

    expect(
      await server.handleRpc("terminal_resize", {
        workspaceId: "ws-1",
        terminalId: "term-1",
        cols: 132,
        rows: 44,
      }),
    ).toBeNull();
    expect(resizeSession).toHaveBeenCalledWith("ws-1", "term-1", 132, 44);

    expect(
      await server.handleRpc("terminal_close", {
        workspaceId: "ws-1",
        terminalId: "term-1",
      }),
    ).toBeNull();
    expect(closeSession).toHaveBeenCalledWith("ws-1", "term-1");

    await server.close();
    expect(closeAll).toHaveBeenCalled();

    expect(await server.handleRpc("daemon_info", {})).toMatchObject({
      capabilities: {
        terminal: true,
      },
    });
  });
});

describe("CodexCompanionServer git/worktree support", () => {
  it("initializes a git repo after confirmation", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await fs.writeFile(path.join(workspace.path, "README.md"), "# Repo\n", "utf8");

    const preview = await server.handleRpc("init_git_repo", {
      workspaceId: "ws-1",
      branch: "main",
      force: false,
    });
    const result = await server.handleRpc("init_git_repo", {
      workspaceId: "ws-1",
      branch: "main",
      force: true,
    });

    expect(preview).toEqual({ status: "needs_confirmation", entryCount: 1 });
    expect(result).toMatchObject({ status: "initialized" });
    await expect(fs.stat(path.join(workspace.path, ".git"))).resolves.toBeTruthy();
  });

  it("returns git status and branch data for a workspace repo", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\nworld\n", "utf8");

    const status = await server.handleRpc("get_git_status", { workspaceId: "ws-1" });
    const branches = await server.handleRpc("list_git_branches", { workspaceId: "ws-1" });

    expect(status).toMatchObject({
      branchName: "main",
      totalAdditions: expect.any(Number),
      totalDeletions: expect.any(Number),
    });
    expect((status as { files: Array<{ path: string; status: string }> }).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", status: "M" }),
      ]),
    );
    expect(branches).toEqual({
      branches: expect.arrayContaining([
        expect.objectContaining({ name: "main", lastCommit: expect.any(Number) }),
      ]),
    });
  });

  it("expands untracked directories into file entries in git status and diffs", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.mkdir(path.join(workspace.path, "untracked-dir"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, "untracked-dir", "nested.txt"), "nested\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "loose.txt"), "loose\n", "utf8");

    const status = await server.handleRpc("get_git_status", { workspaceId: "ws-1" });
    const diffs = await server.handleRpc("get_git_diffs", { workspaceId: "ws-1" });

    expect((status as { files: Array<{ path: string }> }).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "loose.txt" }),
        expect.objectContaining({ path: "untracked-dir/nested.txt" }),
      ]),
    );
    expect((status as { files: Array<{ path: string }> }).files).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "untracked-dir/" })]),
    );
    expect(diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "loose.txt" }),
        expect.objectContaining({ path: "untracked-dir/nested.txt" }),
      ]),
    );
  });

  it("stages files from expanded untracked directories when stage_git_all runs", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\nworld\n", "utf8");
    await fs.mkdir(path.join(workspace.path, "untracked-dir"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, "untracked-dir", "nested.txt"), "nested\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "loose.txt"), "loose\n", "utf8");

    await server.handleRpc("stage_git_all", { workspaceId: "ws-1" });

    const status = await server.handleRpc("get_git_status", { workspaceId: "ws-1" });
    expect((status as { stagedFiles: Array<{ path: string }> }).stagedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt" }),
        expect.objectContaining({ path: "loose.txt" }),
        expect.objectContaining({ path: "untracked-dir/nested.txt" }),
      ]),
    );

    const cachedNames = (await readGitStdout(
      workspace.path,
      ["diff", "--cached", "--name-only", "--"],
    ))
      .split(/\r?\n/)
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    expect(cachedNames).toEqual(
      expect.arrayContaining(["tracked.txt", "loose.txt", "untracked-dir/nested.txt"]),
    );
  });

  it("times out a hanging pre-commit hook instead of hanging commit_git forever", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\nworld\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await fs.mkdir(path.join(workspace.path, ".git", "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nsleep 1\n",
      "utf8",
    );
    await fs.chmod(path.join(workspace.path, ".git", "hooks", "pre-commit"), 0o755);
    vi.stubEnv("CODEX_MONITOR_GIT_COMMIT_TIMEOUT_MS", "100");

    await expect(
      server.handleRpc("commit_git", {
        workspaceId: "ws-1",
        message: "feat: test timeout",
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("tracks worktree setup markers", async () => {
    const { server, storage, workspace } = await createServerFixture();
    const worktreeWorkspace: StoredWorkspace = {
      ...workspace,
      id: "ws-worktree",
      kind: "worktree",
      worktree: { branch: "feat/test" },
      settings: {
        ...workspace.settings,
        worktreeSetupScript: "npm install",
      },
    };
    await storage.writeWorkspaces([workspace, worktreeWorkspace]);
    await server.initialize();

    const before = await server.handleRpc("worktree_setup_status", {
      workspaceId: "ws-worktree",
    });
    await server.handleRpc("worktree_setup_mark_ran", {
      workspaceId: "ws-worktree",
    });
    const after = await server.handleRpc("worktree_setup_status", {
      workspaceId: "ws-worktree",
    });

    expect(before).toEqual({ shouldRun: true, script: "npm install" });
    expect(after).toEqual({ shouldRun: false, script: "npm install" });
  });

  it("applies worktree changes back to the parent repo", async () => {
    const { dir, server, storage, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await runGit(workspace.path, ["branch", "feat/test"]);

    const worktreePath = path.join(dir, "worktree");
    await runGit(workspace.path, ["worktree", "add", worktreePath, "feat/test"]);
    await fs.writeFile(path.join(worktreePath, "tracked.txt"), "hello\nfrom worktree\n", "utf8");

    const worktreeWorkspace: StoredWorkspace = {
      ...workspace,
      id: "ws-worktree",
      path: worktreePath,
      kind: "worktree",
      parentId: workspace.id,
      worktree: { branch: "feat/test" },
    };
    await storage.writeWorkspaces([workspace, worktreeWorkspace]);
    await server.initialize();

    const result = await server.handleRpc("apply_worktree_changes", {
      workspaceId: "ws-worktree",
    });

    expect(result).toBeNull();
    await expect(fs.readFile(path.join(workspace.path, "tracked.txt"), "utf8")).resolves.toBe(
      "hello\nfrom worktree\n",
    );
  });

  it("returns GitHub issues and pull requests through gh", async () => {
    const { dir, server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["remote", "add", "origin", "git@github.com:openai/codex.git"]);
    await installFakeGh(
      dir,
      `
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ number: 12, title: "Bug", url: "https://github.com/openai/codex/issues/12", updatedAt: "2026-03-08T12:00:00Z" }]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ number: 34, title: "Fix", url: "https://github.com/openai/codex/pull/34", updatedAt: "2026-03-08T12:00:00Z", createdAt: "2026-03-07T12:00:00Z", body: "Body", headRefName: "feature", baseRefName: "main", isDraft: false, author: { login: "octocat" } }]));
  process.exit(0);
}
if (args[0] === "api" && args[1].includes("is:issue")) {
  process.stdout.write("23\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1].includes("is:pr")) {
  process.stdout.write("45\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + JSON.stringify(args));
process.exit(1);
`,
    );

    const issues = await server.handleRpc("get_github_issues", { workspaceId: "ws-1" });
    const pullRequests = await server.handleRpc("get_github_pull_requests", { workspaceId: "ws-1" });

    expect(issues).toEqual({
      total: 23,
      issues: [
        {
          number: 12,
          title: "Bug",
          url: "https://github.com/openai/codex/issues/12",
          updatedAt: "2026-03-08T12:00:00Z",
        },
      ],
    });
    expect(pullRequests).toEqual({
      total: 45,
      pullRequests: [
        {
          number: 34,
          title: "Fix",
          url: "https://github.com/openai/codex/pull/34",
          updatedAt: "2026-03-08T12:00:00Z",
          createdAt: "2026-03-07T12:00:00Z",
          body: "Body",
          headRefName: "feature",
          baseRefName: "main",
          isDraft: false,
          author: { login: "octocat" },
        },
      ],
    });
  });

  it("returns GitHub pull request diffs, comments, and supports checkout", async () => {
    const { dir, server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["remote", "add", "origin", "https://github.com/openai/codex.git"]);
    await installFakeGh(
      dir,
      `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write([
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\\n"));
  process.exit(0);
}
if (args[0] === "api" && args[1].includes("/issues/7/comments")) {
  process.stdout.write(JSON.stringify([{ id: 99, body: "Looks good", createdAt: "2026-03-08T12:00:00Z", url: "https://github.com/openai/codex/pull/7#issuecomment-99", author: { login: "reviewer" } }]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "checkout") {
  fs.writeFileSync(path.join(process.cwd(), "checked-out-pr.txt"), args[2], "utf8");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + JSON.stringify(args));
process.exit(1);
`,
    );

    const diff = await server.handleRpc("get_github_pull_request_diff", {
      workspaceId: "ws-1",
      prNumber: 7,
    });
    const comments = await server.handleRpc("get_github_pull_request_comments", {
      workspaceId: "ws-1",
      prNumber: 7,
    });
    const checkoutResult = await server.handleRpc("checkout_github_pull_request", {
      workspaceId: "ws-1",
      prNumber: 7,
    });

    expect(diff).toEqual([
      {
        path: "new.txt",
        status: "R",
        diff: [
          "diff --git a/old.txt b/new.txt",
          "similarity index 100%",
          "rename from old.txt",
          "rename to new.txt",
          "--- a/old.txt",
          "+++ b/new.txt",
          "@@ -1 +1 @@",
          "-before",
          "+after",
        ].join("\n"),
      },
    ]);
    expect(comments).toEqual([
      {
        id: 99,
        body: "Looks good",
        createdAt: "2026-03-08T12:00:00Z",
        url: "https://github.com/openai/codex/pull/7#issuecomment-99",
        author: { login: "reviewer" },
      },
    ]);
    expect(checkoutResult).toBeNull();
    await expect(fs.readFile(path.join(workspace.path, "checked-out-pr.txt"), "utf8")).resolves.toBe("7");
  });

  it("returns a typed error when the workspace remote is not GitHub", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["remote", "add", "origin", "git@gitlab.com:openai/codex.git"]);

    const result = await server.handleRpc("get_github_issues", { workspaceId: "ws-1" });

    expect(result).toEqual({
      error: {
        message: "Remote is not a GitHub repository.",
      },
    });
  });

  it("creates a GitHub repo, adds origin, pushes HEAD, and returns the remote URL", async () => {
    const { dir, server, workspace } = await createServerFixture();
    const remoteRepo = path.join(dir, "remote.git");
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(dir, ["init", "--bare", remoteRepo]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await installFakeGh(
      dir,
      `
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("octocat\\n");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "create") {
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get" && args[2] === "git_protocol") {
  process.stdout.write("https\\n");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view" && args[3] === "--json") {
  process.stdout.write(${JSON.stringify(remoteRepo + "\n")});
  process.exit(0);
}
if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + JSON.stringify(args));
process.exit(1);
`,
    );

    const result = await server.handleRpc("create_github_repo", {
      workspaceId: "ws-1",
      repo: "demo",
      visibility: "private",
      branch: "main",
    });

    expect(result).toEqual({
      status: "ok",
      repo: "octocat/demo",
      remoteUrl: remoteRepo,
    });
    await expect(fs.readFile(path.join(remoteRepo, "HEAD"), "utf8")).resolves.toContain("main");
  });

  it("returns partial when push or default branch update fails after repo creation", async () => {
    const { dir, server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await installFakeGh(
      dir,
      `
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "create") {
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get" && args[2] === "git_protocol") {
  process.stdout.write("ssh\\n");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view" && args[3] === "--json") {
  process.stdout.write("git@github.com:openai/codex.git\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
  process.stderr.write("patch failed");
  process.exit(1);
}
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("ignored\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + JSON.stringify(args));
process.exit(1);
`,
    );
    await runGit(workspace.path, ["remote", "add", "origin", "git@github.com:openai/codex.git"]);

    const result = await server.handleRpc("create_github_repo", {
      workspaceId: "ws-1",
      repo: "openai/codex",
      visibility: "public",
      branch: "main",
    });

    expect(result).toEqual({
      status: "partial",
      repo: "openai/codex",
      remoteUrl: "git@github.com:openai/codex.git",
      pushError: expect.any(String),
      defaultBranchError: "patch failed",
    });
  });

  it("rejects create_github_repo when origin points at another repository", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["remote", "add", "origin", "git@github.com:openai/other.git"]);

    const result = await server.handleRpc("create_github_repo", {
      workspaceId: "ws-1",
      repo: "openai/codex",
      visibility: "public",
    });

    expect(result).toEqual({
      error: {
        message:
          "Origin remote already points to 'openai/other', but 'openai/codex' was requested. Remove or reconfigure origin to continue.",
      },
    });
  });
});
