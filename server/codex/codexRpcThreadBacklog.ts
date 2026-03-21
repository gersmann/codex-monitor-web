import {
  defineRpcMethod,
  dispatchTypedRpc,
  isRpcError,
} from "./rpcHandlerRegistry.js";
import type { JsonRecord, RpcErrorShape, StoredThread, ThreadBacklogItem } from "../types.js";

export type ThreadBacklogRpcContext = {
  getThreadForWorkspace: (workspaceId: string, threadId: string) => StoredThread | null;
  createBacklogItem: (text: string) => ThreadBacklogItem;
  sortBacklog: (backlog: ThreadBacklogItem[]) => ThreadBacklogItem[];
  persistThreads: () => Promise<void>;
  notFound: (message: string) => RpcErrorShape;
  badRequest: (message: string) => RpcErrorShape;
};

type BacklogThreadParams = {
  thread: StoredThread;
};
type AddBacklogItemParams = BacklogThreadParams & {
  text: string;
};
type UpdateBacklogItemParams = AddBacklogItemParams & {
  itemId: string;
};
type DeleteBacklogItemParams = BacklogThreadParams & {
  itemId: string;
};

function parseBacklogThread(
  context: ThreadBacklogRpcContext,
  params: JsonRecord,
): BacklogThreadParams | RpcErrorShape {
  const workspaceId = String(params.workspaceId ?? "");
  const threadId = String(params.threadId ?? "");
  const thread = context.getThreadForWorkspace(workspaceId, threadId);
  if (!thread) {
    return context.notFound("Thread not found.");
  }
  return { thread };
}

function parseText(text: unknown): string | null {
  const normalized = typeof text === "string" ? text.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

async function persistThreadBacklogChange<T>(
  context: ThreadBacklogRpcContext,
  thread: StoredThread,
  result: T,
) {
  thread.updatedAt = Date.now();
  await context.persistThreads();
  return result;
}

function parseAddBacklogItemParams(
  context: ThreadBacklogRpcContext,
  params: JsonRecord,
): AddBacklogItemParams | RpcErrorShape {
  const base = parseBacklogThread(context, params);
  if (isRpcError(base)) {
    return base;
  }
  const text = parseText(params.text);
  if (!text) {
    return context.badRequest("Backlog text is required.");
  }
  return {
    ...base,
    text,
  };
}

function parseUpdateBacklogItemParams(
  context: ThreadBacklogRpcContext,
  params: JsonRecord,
): UpdateBacklogItemParams | RpcErrorShape {
  const base = parseAddBacklogItemParams(context, params);
  if (isRpcError(base)) {
    return base;
  }
  return {
    ...base,
    itemId: String(params.itemId ?? ""),
  };
}

function parseDeleteBacklogItemParams(
  context: ThreadBacklogRpcContext,
  params: JsonRecord,
): DeleteBacklogItemParams | RpcErrorShape {
  const base = parseBacklogThread(context, params);
  if (isRpcError(base)) {
    return base;
  }
  return {
    ...base,
    itemId: String(params.itemId ?? ""),
  };
}

const THREAD_BACKLOG_RPC_HANDLERS = {
  get_thread_backlog: defineRpcMethod(parseBacklogThread, (_context, params) => {
    return params.thread.backlog;
  }),
  add_thread_backlog_item: defineRpcMethod(
    parseAddBacklogItemParams,
    async (context, params) => {
      const item = context.createBacklogItem(params.text);
      params.thread.backlog = context.sortBacklog([item, ...params.thread.backlog]);
      return await persistThreadBacklogChange(context, params.thread, item);
    },
  ),
  update_thread_backlog_item: defineRpcMethod(
    parseUpdateBacklogItemParams,
    async (context, params) => {
      const item = params.thread.backlog.find((entry) => entry.id === params.itemId);
      if (!item) {
        return context.notFound("Backlog item not found.");
      }
      item.text = params.text;
      item.updatedAt = Date.now();
      return await persistThreadBacklogChange(context, params.thread, item);
    },
  ),
  delete_thread_backlog_item: defineRpcMethod(
    parseDeleteBacklogItemParams,
    async (context, params) => {
      const nextBacklog = params.thread.backlog.filter((entry) => entry.id !== params.itemId);
      if (nextBacklog.length === params.thread.backlog.length) {
        return context.notFound("Backlog item not found.");
      }
      params.thread.backlog = nextBacklog;
      return await persistThreadBacklogChange(context, params.thread, null);
    },
  ),
};

export function handleThreadBacklogRpc(
  context: ThreadBacklogRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  return dispatchTypedRpc(THREAD_BACKLOG_RPC_HANDLERS, context, method, params);
}
