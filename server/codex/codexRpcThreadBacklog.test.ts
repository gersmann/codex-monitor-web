import { describe, expect, it, vi } from "vitest";
import { handleThreadBacklogRpc, type ThreadBacklogRpcContext } from "./codexRpcThreadBacklog.js";
import type { StoredThread } from "../types.js";

function createContext(thread: StoredThread | null): ThreadBacklogRpcContext {
  return {
    getThreadForWorkspace: (workspaceId, threadId) =>
      thread && thread.workspaceId === workspaceId && thread.id === threadId ? thread : null,
    createBacklogItem: (text) => ({
      id: "item-1",
      text,
      createdAt: 1,
      updatedAt: 1,
    }),
    sortBacklog: (backlog) => backlog,
    persistThreads: vi.fn().mockResolvedValue(undefined),
    notFound: (message) => ({ error: { status: 404, message } }),
    badRequest: (message) => ({ error: { status: 400, message } }),
  };
}

describe("codexRpcThreadBacklog", () => {
  it("returns thread backlog when thread exists", async () => {
    const thread = {
      id: "thread-1",
      workspaceId: "ws-1",
      sdkThreadId: "sdk-thread-1",
      cwd: "/tmp/ws-1",
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null,
      name: null,
      preview: "Thread One",
      activeTurnId: null,
      turns: [],
      modelId: null,
      effort: null,
      backlog: [{ id: "item-1", text: "Follow up", createdAt: 1, updatedAt: 1 }],
      tokenUsage: null,
    } satisfies StoredThread;
    const context = createContext(thread);

    const result = await handleThreadBacklogRpc(context, "get_thread_backlog", {
      workspaceId: "ws-1",
      threadId: "thread-1",
    });

    expect(result).toEqual(thread.backlog);
  });

  it("adds, updates, and deletes backlog items", async () => {
    const thread = {
      id: "thread-1",
      workspaceId: "ws-1",
      sdkThreadId: "sdk-thread-1",
      cwd: "/tmp/ws-1",
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
    } satisfies StoredThread;
    const context = createContext(thread);

    const created = await handleThreadBacklogRpc(context, "add_thread_backlog_item", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      text: "  Follow up  ",
    });
    expect(created).toEqual({
      id: "item-1",
      text: "Follow up",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(thread.backlog).toHaveLength(1);

    const updated = await handleThreadBacklogRpc(context, "update_thread_backlog_item", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "item-1",
      text: "Updated",
    });
    expect(updated).toEqual({
      id: "item-1",
      text: "Updated",
      createdAt: 1,
      updatedAt: expect.any(Number),
    });

    const deleted = await handleThreadBacklogRpc(context, "delete_thread_backlog_item", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "item-1",
    });
    expect(deleted).toBeNull();
    expect(thread.backlog).toEqual([]);
  });

  it("returns typed errors for invalid requests and unknown methods", async () => {
    const thread = {
      id: "thread-1",
      workspaceId: "ws-1",
      sdkThreadId: "sdk-thread-1",
      cwd: "/tmp/ws-1",
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
    } satisfies StoredThread;
    const context = createContext(thread);

    const missingThread = await handleThreadBacklogRpc(context, "get_thread_backlog", {
      workspaceId: "ws-1",
      threadId: "missing",
    });
    expect(missingThread).toEqual({
      error: { status: 404, message: "Thread not found." },
    });

    const missingText = await handleThreadBacklogRpc(context, "add_thread_backlog_item", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      text: "   ",
    });
    expect(missingText).toEqual({
      error: { status: 400, message: "Backlog text is required." },
    });

    const unknown = await handleThreadBacklogRpc(context, "unknown_method", {});
    expect(unknown).toBeUndefined();
  });
});
