import { useCallback, useMemo } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { AppServerEvent, DebugEntry, RateLimitSnapshot, TurnPlan } from "@/types";
import { getAppServerRawMethod } from "@utils/appServerEvents";
import { useThreadApprovalEvents } from "./useThreadApprovalEvents";
import { useThreadItemEvents } from "./useThreadItemEvents";
import { useThreadTurnEvents } from "./useThreadTurnEvents";
import { useThreadUserInputEvents } from "./useThreadUserInputEvents";
import type { ThreadAction } from "./useThreadsReducer";

type ThreadEventHandlersOptions = {
  activeThreadId: string | null;
  dispatch: Dispatch<ThreadAction>;
  planByThreadRef: MutableRefObject<Record<string, TurnPlan | null>>;
  getCurrentRateLimits?: (workspaceId: string) => RateLimitSnapshot | null;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  isThreadHidden: (workspaceId: string, threadId: string) => boolean;
  setThreadLoaded: (threadId: string, isLoaded: boolean) => void;
  markProcessing: (threadId: string, isProcessing: boolean) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  setActiveTurnId: (threadId: string, turnId: string | null) => void;
  getActiveTurnId: (threadId: string) => string | null;
  safeMessageActivity: () => void;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  onUserMessageCreated?: (
    workspaceId: string,
    threadId: string,
    text: string,
  ) => void | Promise<void>;
  pushThreadErrorMessage: (threadId: string, message: string) => void;
  onDebug?: (entry: DebugEntry) => void;
  onWorkspaceConnected: (workspaceId: string) => void;
  applyCollabThreadLinks: (
    workspaceId: string,
    threadId: string,
    item: Record<string, unknown>,
  ) => void;
  onReviewExited?: (workspaceId: string, threadId: string) => void;
  approvalAllowlistRef: MutableRefObject<Record<string, string[][]>>;
  pendingInterruptsRef: MutableRefObject<Set<string>>;
};

export function getAppServerDebugLabel(method: string) {
  if (method === "configWarning") {
    return "config warning";
  }
  if (method === "deprecationNotice") {
    return "deprecation warning";
  }
  if (method === "model/rerouted") {
    return "model rerouted";
  }
  if (method === "item/mcpToolCall/progress") {
    return "mcp tool progress";
  }
  if (method === "fuzzyFileSearch/sessionUpdated") {
    return "fuzzy file search updated";
  }
  if (method === "fuzzyFileSearch/sessionCompleted") {
    return "fuzzy file search completed";
  }
  if (method === "mcpServer/oauthLogin/completed") {
    return "mcp oauth completed";
  }
  if (method === "rawResponseItem/completed") {
    return "raw response completed";
  }
  if (method === "windows/worldWritableWarning") {
    return "windows writable warning";
  }
  if (method === "windowsSandbox/setupCompleted") {
    return "windows sandbox setup completed";
  }
  return method || "event";
}

function truncateDebugValue(value: string, maxLength = 240) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function compactNestedDebugRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of ["id", "threadId", "thread_id", "turnId", "turn_id", "itemId", "item_id", "status", "type"]) {
    const next = source[key];
    if (next !== undefined && next !== null && next !== "") {
      compact[key] = next;
    }
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

export function buildAppServerDebugPayload(event: AppServerEvent) {
  const method = getAppServerRawMethod(event) ?? "";
  const message =
    event.message && typeof event.message === "object" && !Array.isArray(event.message)
      ? (event.message as Record<string, unknown>)
      : {};
  const params =
    message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? (message.params as Record<string, unknown>)
      : {};

  const summary: Record<string, unknown> = {
    workspaceId: event.workspace_id,
    method: method || null,
  };

  for (const key of ["threadId", "thread_id", "turnId", "turn_id", "itemId", "item_id", "requestId", "request_id", "loginId", "login_id", "success", "willRetry"]) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "") {
      summary[key] = value;
    }
  }

  for (const key of ["message", "error", "delta", "stdin", "diff"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      summary[key] = truncateDebugValue(value);
    }
  }

  for (const key of ["thread", "turn", "item", "status", "tokenUsage", "rateLimits"]) {
    const compact = compactNestedDebugRecord(params[key]);
    if (compact !== undefined) {
      summary[key] = compact;
    }
  }

  return summary;
}

export function useThreadEventHandlers({
  activeThreadId,
  dispatch,
  planByThreadRef,
  getCurrentRateLimits,
  getCustomName,
  isThreadHidden,
  setThreadLoaded,
  markProcessing,
  markReviewing,
  setActiveTurnId,
  getActiveTurnId,
  safeMessageActivity,
  recordThreadActivity,
  onUserMessageCreated,
  pushThreadErrorMessage,
  onDebug,
  onWorkspaceConnected,
  applyCollabThreadLinks,
  onReviewExited,
  approvalAllowlistRef,
  pendingInterruptsRef,
}: ThreadEventHandlersOptions) {
  const onApprovalRequest = useThreadApprovalEvents({
    dispatch,
    approvalAllowlistRef,
  });
  const onRequestUserInput = useThreadUserInputEvents({ dispatch });

  const {
    onAgentMessageDelta,
    onAgentMessageCompleted,
    onItemStarted,
    onItemCompleted,
    onReasoningSummaryDelta,
    onReasoningSummaryBoundary,
    onReasoningTextDelta,
    onPlanDelta,
    onCommandOutputDelta,
    onTerminalInteraction,
    onFileChangeOutputDelta,
  } = useThreadItemEvents({
    activeThreadId,
    dispatch,
    getCustomName,
    markProcessing,
    markReviewing,
    safeMessageActivity,
    recordThreadActivity,
    applyCollabThreadLinks,
    onUserMessageCreated,
    onReviewExited,
  });

  const {
    onThreadStarted,
    onThreadNameUpdated,
    onThreadArchived,
    onThreadUnarchived,
    onTurnStarted,
    onTurnCompleted,
    onThreadStatusChanged,
    onThreadClosed,
    onTurnPlanUpdated,
    onTurnDiffUpdated,
    onThreadTokenUsageUpdated,
    onAccountRateLimitsUpdated,
    onTurnError,
  } = useThreadTurnEvents({
    dispatch,
    planByThreadRef,
    getCurrentRateLimits,
    getCustomName,
    isThreadHidden,
    setThreadLoaded,
    markProcessing,
    markReviewing,
    setActiveTurnId,
    getActiveTurnId,
    pendingInterruptsRef,
    pushThreadErrorMessage,
    safeMessageActivity,
    recordThreadActivity,
  });

  const onBackgroundThreadAction = useCallback(
    (workspaceId: string, threadId: string, action: string) => {
      if (action !== "hide") {
        return;
      }
      dispatch({ type: "hideThread", workspaceId, threadId });
    },
    [dispatch],
  );

  const onServerRequestResolved = useCallback(
    (workspaceId: string, payload: { threadId: string; requestId: string | number }) => {
      dispatch({
        type: "removeApproval",
        workspaceId,
        requestId: payload.requestId,
      });
      dispatch({
        type: "removeUserInputRequest",
        workspaceId,
        requestId: payload.requestId,
      });
    },
    [dispatch],
  );

  const onAppServerEvent = useCallback(
    (event: AppServerEvent) => {
      const method = getAppServerRawMethod(event) ?? "";
      const inferredSource = method === "codex/stderr" ? "stderr" : "event";
      onDebug?.({
        id: `${Date.now()}-server-event`,
        timestamp: Date.now(),
        source: inferredSource,
        label: getAppServerDebugLabel(method),
        payload: buildAppServerDebugPayload(event),
      });
    },
    [onDebug],
  );

  const handlers = useMemo(
    () => ({
      onWorkspaceConnected,
      onApprovalRequest,
      onRequestUserInput,
      onBackgroundThreadAction,
      onAppServerEvent,
      onAgentMessageDelta,
      onAgentMessageCompleted,
      onItemStarted,
      onItemCompleted,
      onReasoningSummaryDelta,
      onReasoningSummaryBoundary,
      onReasoningTextDelta,
      onPlanDelta,
      onCommandOutputDelta,
      onTerminalInteraction,
      onFileChangeOutputDelta,
      onThreadStarted,
      onThreadNameUpdated,
      onThreadArchived,
      onThreadUnarchived,
      onTurnStarted,
      onTurnCompleted,
      onThreadStatusChanged,
      onThreadClosed,
      onTurnPlanUpdated,
      onTurnDiffUpdated,
      onThreadTokenUsageUpdated,
      onAccountRateLimitsUpdated,
      onTurnError,
      onServerRequestResolved,
    }),
    [
      onWorkspaceConnected,
      onApprovalRequest,
      onRequestUserInput,
      onBackgroundThreadAction,
      onAppServerEvent,
      onAgentMessageDelta,
      onAgentMessageCompleted,
      onItemStarted,
      onItemCompleted,
      onReasoningSummaryDelta,
      onReasoningSummaryBoundary,
      onReasoningTextDelta,
      onPlanDelta,
      onCommandOutputDelta,
      onTerminalInteraction,
      onFileChangeOutputDelta,
      onThreadStarted,
      onThreadNameUpdated,
      onThreadArchived,
      onThreadUnarchived,
      onTurnStarted,
      onTurnCompleted,
      onThreadStatusChanged,
      onThreadClosed,
      onTurnPlanUpdated,
      onTurnDiffUpdated,
      onThreadTokenUsageUpdated,
      onAccountRateLimitsUpdated,
      onTurnError,
      onServerRequestResolved,
    ],
  );

  return handlers;
}
