import { buildAppServerEvent } from "../appServer.js";
import { extractThreadIdFromParams, extractTurnIdFromParams, ThreadStateService } from "./codexThreadStateService.js";
import type { AppServerEventPayload, JsonRecord } from "../types.js";
import {
  CodexAppServerClient,
  type AppServerNotificationMessage,
} from "../vendor/codexSdk.js";
import type { TerminalBroadcastMessage } from "../terminal.js";

type BroadcastMessage = {
  event: "app-server-event";
  payload: AppServerEventPayload;
};

type BroadcastFn = (message: BroadcastMessage | TerminalBroadcastMessage) => void;

const APP_SERVER_GLOBAL_NOTIFICATION_METHODS = new Set([
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "app/list/updated",
  "configWarning",
  "deprecationNotice",
  "model/rerouted",
  "skills/changed",
]);

export type AppServerRuntimeContext = {
  broadcast: BroadcastFn;
  appServerClients: Map<string, CodexAppServerClient>;
  appServerClientWorkspaceIds: Map<string, Set<string>>;
  appServerNotificationUnsubscribers: Map<string, () => void>;
  connectedWorkspaceIds: Set<string>;
  threadState: ThreadStateService;
  appServerClientKey: (settings: JsonRecord, workspaceId?: string | null) => string;
  appServerClientOptions: (
    settings: JsonRecord,
    workspaceId?: string | null,
  ) => ConstructorParameters<typeof CodexAppServerClient>[0];
};

export class AppServerRuntimeService {
  constructor(private readonly context: AppServerRuntimeContext) {}

  createDetachedAppServerClient(settings: JsonRecord, workspaceId?: string | null) {
    return new CodexAppServerClient(this.context.appServerClientOptions(settings, workspaceId));
  }

  buildAppServerClient(settings: JsonRecord, workspaceId?: string | null) {
    const key = this.context.appServerClientKey(settings, workspaceId);
    const existing = this.context.appServerClients.get(key);
    if (existing) {
      if (workspaceId) {
        if (!this.context.appServerClientWorkspaceIds.has(key)) {
          this.context.appServerClientWorkspaceIds.set(key, new Set());
        }
        this.context.appServerClientWorkspaceIds.get(key)?.add(workspaceId);
      }
      return existing;
    }

    const client = new CodexAppServerClient(this.context.appServerClientOptions(settings, workspaceId));
    this.context.appServerClients.set(key, client);
    if (workspaceId) {
      this.context.appServerClientWorkspaceIds.set(key, new Set([workspaceId]));
    }
    this.context.appServerNotificationUnsubscribers.set(
      key,
      client.onNotification((message) => {
        void this.handleAppServerNotification(key, message);
      }),
    );
    return client;
  }

  async resetAppServerClients() {
    await Promise.all(Array.from(this.context.appServerClients.values(), (client) => client.close()));
    this.context.appServerClients.clear();
    this.context.appServerClientWorkspaceIds.clear();
    this.context.appServerNotificationUnsubscribers.clear();
  }

  hasActiveAppServerRuntime() {
    return this.context.appServerClients.size > 0;
  }

  async close() {
    await Promise.all(Array.from(this.context.appServerClients.values(), (client) => client.close()));
    this.context.appServerClients.clear();
    this.context.appServerClientWorkspaceIds.clear();
    this.context.appServerNotificationUnsubscribers.clear();
  }

  private workspaceIdsForClient(key: string) {
    const workspaceIds = this.context.appServerClientWorkspaceIds.get(key);
    if (workspaceIds && workspaceIds.size > 0) {
      return Array.from(workspaceIds);
    }
    return Array.from(this.context.connectedWorkspaceIds);
  }

  private inferThreadIdForNotification(workspaceIds: string[], params: JsonRecord) {
    const turnId = extractTurnIdFromParams(params);
    if (turnId) {
      const thread = this.context.threadState.findStoredThreadForTurn(workspaceIds, turnId);
      if (thread) {
        return this.context.threadState.resolveAppServerThreadId(thread);
      }
    }
    if (workspaceIds.length !== 1) {
      return null;
    }
    const activeThreads = this.context.threadState.listThreads().filter(
      (thread) => thread.workspaceId === workspaceIds[0] && Boolean(thread.activeTurnId),
    );
    if (activeThreads.length === 1) {
      return this.context.threadState.resolveAppServerThreadId(activeThreads[0]!);
    }
    return null;
  }

  private enrichNotificationParams(workspaceIds: string[], params: JsonRecord) {
    if (extractThreadIdFromParams(params)) {
      return params;
    }
    const inferredThreadId = this.inferThreadIdForNotification(workspaceIds, params);
    if (!inferredThreadId) {
      return params;
    }
    return {
      ...params,
      threadId: inferredThreadId,
    };
  }

  private resolveWorkspaceIdsForNotification(
    key: string,
    method: string,
    params: JsonRecord,
  ) {
    const threadId = extractThreadIdFromParams(params);
    if (threadId) {
      const thread = this.context.threadState.findThreadByAppServerThreadId(threadId);
      if (thread) {
        return [thread.workspaceId];
      }
    }
    const turnId = extractTurnIdFromParams(params);
    if (turnId) {
      const thread = this.context.threadState.findStoredThreadByTurnId(turnId);
      if (thread) {
        return [thread.workspaceId];
      }
    }
    if (method === "thread/started") {
      const thread =
        params.thread && typeof params.thread === "object" && !Array.isArray(params.thread)
          ? (params.thread as JsonRecord)
          : null;
      const workspaceId =
        (thread ? this.context.threadState.resolveWorkspaceIdForCwd(String(thread.cwd ?? "")) : null) ??
        null;
      if (workspaceId) {
        return [workspaceId];
      }
    }
    if (APP_SERVER_GLOBAL_NOTIFICATION_METHODS.has(method)) {
      return this.workspaceIdsForClient(key);
    }
    return [];
  }

  async handleAppServerNotification(
    key: string,
    message: AppServerNotificationMessage,
  ) {
    const workspaceIds = this.resolveWorkspaceIdsForNotification(key, message.method, message.params);
    const normalizedParams = this.enrichNotificationParams(workspaceIds, message.params);
    await this.context.threadState.applyAppServerNotificationToState(
      workspaceIds,
      message.method,
      normalizedParams,
    );
    for (const workspaceId of workspaceIds) {
      this.context.broadcast({
        event: "app-server-event",
        payload: buildAppServerEvent(workspaceId, message.method, normalizedParams, message.id),
      });
    }
  }
}
