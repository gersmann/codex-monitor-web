import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import * as Sentry from "@sentry/react";
import type {
  CustomPromptOption,
  DebugEntry,
  ServiceTier,
  ThreadListSortKey,
  WorkspaceInfo,
} from "@/types";
import { CHAT_SCROLLBACK_DEFAULT } from "@utils/chatScrollback";
import { useAppServerEvents } from "@app/hooks/useAppServerEvents";
import { initialState, threadReducer } from "./useThreadsReducer";
import { useThreadStorage } from "./useThreadStorage";
import { useThreadLinking } from "./useThreadLinking";
import { useThreadEventHandlers } from "./useThreadEventHandlers";
import { useThreadActions } from "./useThreadActions";
import { useThreadMessaging } from "./useThreadMessaging";
import { useThreadApprovals } from "./useThreadApprovals";
import { useThreadAccountInfo } from "./useThreadAccountInfo";
import { useThreadRateLimits } from "./useThreadRateLimits";
import { useThreadSelectors } from "./useThreadSelectors";
import { useThreadStatus } from "./useThreadStatus";
import { useThreadUserInput } from "./useThreadUserInput";
import { useThreadTitleAutogeneration } from "./useThreadTitleAutogeneration";
import {
  archiveThread as archiveThreadService,
  importClientThreadMetadata as importClientThreadMetadataService,
  pinThread as pinThreadService,
  setThreadName as setThreadNameService,
  unpinThread as unpinThreadService,
} from "@services/tauri";
import {
  loadCustomNames,
  loadDetachedReviewLinks,
  loadPinnedThreads,
  loadThreadCodexParams,
  MIGRATED_THREAD_METADATA_STORAGE_KEY,
  MAX_PINS_SOFT_LIMIT,
} from "@threads/utils/threadStorage";
import { getParentThreadIdFromThread } from "@threads/utils/threadRpc";
import { getSubagentDescendantThreadIds } from "@threads/utils/subagentTree";

type UseThreadsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onWorkspaceConnected: (id: string) => void;
  onDebug?: (entry: DebugEntry) => void;
  ensureWorkspaceRuntimeCodexArgs?: (
    workspaceId: string,
    threadId: string | null,
  ) => Promise<void>;
  model?: string | null;
  effort?: string | null;
  serviceTier?: ServiceTier | null | undefined;
  collaborationMode?: Record<string, unknown> | null;
  accessMode?: "read-only" | "current" | "full-access";
  onSelectServiceTier?: (tier: ServiceTier | null | undefined) => void;
  reviewDeliveryMode?: "inline" | "detached";
  steerEnabled?: boolean;
  threadTitleAutogenerationEnabled?: boolean;
  chatHistoryScrollbackItems?: number | null;
  customPrompts?: CustomPromptOption[];
  onMessageActivity?: () => void;
  threadSortKey?: ThreadListSortKey;
  onThreadCodexMetadataDetected?: (
    workspaceId: string,
    threadId: string,
    metadata: { modelId: string | null; effort: string | null },
  ) => void;
};

function buildWorkspaceThreadKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`;
}

const CASCADE_ARCHIVE_SKIP_TTL_MS = 120_000;

export function useThreads({
  activeWorkspace,
  onWorkspaceConnected,
  onDebug,
  ensureWorkspaceRuntimeCodexArgs,
  model,
  effort,
  serviceTier,
  collaborationMode,
  accessMode,
  onSelectServiceTier,
  reviewDeliveryMode = "inline",
  steerEnabled = false,
  threadTitleAutogenerationEnabled = false,
  chatHistoryScrollbackItems,
  customPrompts = [],
  onMessageActivity,
  threadSortKey = "updated_at",
  onThreadCodexMetadataDetected,
}: UseThreadsOptions) {
  const maxItemsPerThread =
    chatHistoryScrollbackItems === undefined
      ? CHAT_SCROLLBACK_DEFAULT
      : chatHistoryScrollbackItems;

  const [state, dispatch] = useReducer(
    threadReducer,
    maxItemsPerThread,
    (initialMaxItemsPerThread) => ({
      ...initialState,
      maxItemsPerThread: initialMaxItemsPerThread,
    }),
  );
  useEffect(() => {
    dispatch({ type: "setMaxItemsPerThread", maxItemsPerThread });
  }, [dispatch, maxItemsPerThread]);
  const loadedThreadsRef = useRef<Record<string, boolean>>({});
  const replaceOnResumeRef = useRef<Record<string, boolean>>({});
  const pendingInterruptsRef = useRef<Set<string>>(new Set());
  const planByThreadRef = useRef(state.planByThread);
  const itemsByThreadRef = useRef(state.itemsByThread);
  const threadsByWorkspaceRef = useRef(state.threadsByWorkspace);
  const activeTurnIdByThreadRef = useRef(state.activeTurnIdByThread);
  const detachedReviewStartedNoticeRef = useRef<Set<string>>(new Set());
  const detachedReviewCompletedNoticeRef = useRef<Set<string>>(new Set());
  const detachedReviewParentByChildRef = useRef<Record<string, string>>({});
  const subagentThreadByWorkspaceThreadRef = useRef<Record<string, true>>({});
  const threadParentByIdRef = useRef(state.threadParentById);
  const cascadeArchiveSkipRef = useRef<Record<string, number>>({});
  const detachedReviewLinksByWorkspaceRef = useRef<Record<string, Record<string, string>>>({});
  planByThreadRef.current = state.planByThread;
  itemsByThreadRef.current = state.itemsByThread;
  threadsByWorkspaceRef.current = state.threadsByWorkspace;
  activeTurnIdByThreadRef.current = state.activeTurnIdByThread;
  threadParentByIdRef.current = state.threadParentById;
  const rateLimitsByWorkspaceRef = useRef(state.rateLimitsByWorkspace);
  rateLimitsByWorkspaceRef.current = state.rateLimitsByWorkspace;
  const { approvalAllowlistRef, handleApprovalDecision, handleApprovalRemember } =
    useThreadApprovals({ dispatch, onDebug });
  const { handleUserInputSubmit } = useThreadUserInput({ dispatch });
  const {
    threadActivityRef,
    pinnedThreadsVersion,
    getCustomName,
    recordThreadActivity,
    isThreadPinned,
    getPinTimestamp,
  } = useThreadStorage({
    threadsByWorkspace: state.threadsByWorkspace,
  });
  const clientMetadataMigrationStartedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || clientMetadataMigrationStartedRef.current) {
      return;
    }
    if (window.localStorage.getItem(MIGRATED_THREAD_METADATA_STORAGE_KEY) === "1") {
      return;
    }
    const pinnedThreads = loadPinnedThreads();
    const threadCodexParams = loadThreadCodexParams();
    const detachedReviewLinks = loadDetachedReviewLinks();
    const customNames = loadCustomNames();
    const hasLegacyMetadata =
      Object.keys(pinnedThreads).length > 0 ||
      Object.keys(threadCodexParams).length > 0 ||
      Object.keys(detachedReviewLinks).length > 0 ||
      Object.keys(customNames).length > 0;
    if (!hasLegacyMetadata) {
      window.localStorage.setItem(MIGRATED_THREAD_METADATA_STORAGE_KEY, "1");
      return;
    }
    clientMetadataMigrationStartedRef.current = true;
    void importClientThreadMetadataService({
      pinnedThreads,
      threadCodexParams,
      detachedReviewLinks,
      customNames,
    })
      .then(() => {
        window.localStorage.setItem(MIGRATED_THREAD_METADATA_STORAGE_KEY, "1");
      })
      .catch((error) => {
        clientMetadataMigrationStartedRef.current = false;
        onDebug?.({
          id: `${Date.now()}-client-thread-metadata-import-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread metadata import error",
          payload: error instanceof Error ? error.message : String(error),
        });
      });
  }, [onDebug]);

  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const { activeThreadId, activeItems } = useThreadSelectors({
    activeWorkspaceId,
    activeThreadIdByWorkspace: state.activeThreadIdByWorkspace,
    itemsByThread: state.itemsByThread,
  });

  const getCurrentRateLimits = useCallback(
    (workspaceId: string) => rateLimitsByWorkspaceRef.current[workspaceId] ?? null,
    [],
  );

  const { refreshAccountRateLimits } = useThreadRateLimits({
    activeWorkspaceId,
    activeWorkspaceConnected: activeWorkspace?.connected,
    getCurrentRateLimits,
    dispatch,
    onDebug,
  });
  const { refreshAccountInfo } = useThreadAccountInfo({
    activeWorkspaceId,
    activeWorkspaceConnected: activeWorkspace?.connected,
    dispatch,
    onDebug,
  });

  const { markProcessing, markReviewing, setActiveTurnId } = useThreadStatus({
    dispatch,
  });

  const pushThreadErrorMessage = useCallback(
    (threadId: string, message: string) => {
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: message,
      });
      if (threadId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId, hasUnread: true });
      }
    },
    [activeThreadId, dispatch],
  );

  const safeMessageActivity = useCallback(() => {
    try {
      void onMessageActivity?.();
    } catch {
      // Ignore refresh errors to avoid breaking the UI.
    }
  }, [onMessageActivity]);

  const setThreadLoaded = useCallback((threadId: string, isLoaded: boolean) => {
    loadedThreadsRef.current[threadId] = isLoaded;
  }, []);

  const renameThread = useCallback(
    (workspaceId: string, threadId: string, newName: string) => {
      dispatch({
        type: "setThreadName",
        workspaceId,
        threadId,
        name: newName,
        storedName: newName,
      });
      void Promise.resolve(
        setThreadNameService(workspaceId, threadId, newName),
      ).catch((error) => {
        onDebug?.({
          id: `${Date.now()}-client-thread-rename-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/name/set error",
          payload: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [dispatch, onDebug],
  );

  const onSubagentThreadDetected = useCallback(
    (workspaceId: string, threadId: string) => {
      if (!workspaceId || !threadId) {
        return;
      }
      subagentThreadByWorkspaceThreadRef.current[
        buildWorkspaceThreadKey(workspaceId, threadId)
      ] = true;
    },
    [],
  );

  const isSubagentThread = useCallback(
    (workspaceId: string, threadId: string) =>
      Boolean(
        subagentThreadByWorkspaceThreadRef.current[
          buildWorkspaceThreadKey(workspaceId, threadId)
        ],
      ),
    [],
  );

  const { applyCollabThreadLinks, applyCollabThreadLinksFromThread, updateThreadParent } =
    useThreadLinking({
      dispatch,
      threadParentById: state.threadParentById,
      onSubagentThreadDetected,
    });

  const handleWorkspaceConnected = useCallback(
    (workspaceId: string) => {
      onWorkspaceConnected(workspaceId);
      void refreshAccountRateLimits(workspaceId);
      void refreshAccountInfo(workspaceId);
    },
    [onWorkspaceConnected, refreshAccountRateLimits, refreshAccountInfo],
  );

  const handleAccountUpdated = useCallback(
    (workspaceId: string) => {
      void refreshAccountRateLimits(workspaceId);
      void refreshAccountInfo(workspaceId);
    },
    [refreshAccountRateLimits, refreshAccountInfo],
  );

  const isThreadHidden = useCallback(
    (workspaceId: string, threadId: string) =>
      Boolean(state.hiddenThreadIdsByWorkspace[workspaceId]?.[threadId]),
    [state.hiddenThreadIdsByWorkspace],
  );

  const getActiveTurnId = useCallback(
    (threadId: string) => activeTurnIdByThreadRef.current[threadId] ?? null,
    [],
  );

  const registerDetachedReviewChild = useCallback(
    (workspaceId: string, parentId: string, childId: string) => {
      if (!workspaceId || !parentId || !childId || parentId === childId) {
        return;
      }
      detachedReviewParentByChildRef.current[childId] = parentId;
      const existingWorkspaceLinks =
        detachedReviewLinksByWorkspaceRef.current[workspaceId] ?? {};
      if (existingWorkspaceLinks[childId] !== parentId) {
        const nextLinksByWorkspace = {
          ...detachedReviewLinksByWorkspaceRef.current,
          [workspaceId]: {
            ...existingWorkspaceLinks,
            [childId]: parentId,
          },
        };
        detachedReviewLinksByWorkspaceRef.current = nextLinksByWorkspace;
      }

      const timestamp = Date.now();
      recordThreadActivity(workspaceId, parentId, timestamp);
      dispatch({
        type: "setThreadTimestamp",
        workspaceId,
        threadId: parentId,
        timestamp,
      });

      const noticeKey = `${parentId}->${childId}`;
      if (!detachedReviewStartedNoticeRef.current.has(noticeKey)) {
        detachedReviewStartedNoticeRef.current.add(noticeKey);
        dispatch({
          type: "addAssistantMessage",
          threadId: parentId,
          text: `Detached review started. [Open review thread](/thread/${childId})`,
        });
      }

      if (parentId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId: parentId, hasUnread: true });
      }
      safeMessageActivity();
    },
    [activeThreadId, dispatch, recordThreadActivity, safeMessageActivity],
  );

  useEffect(() => {
    const nextLinksByWorkspace: Record<string, Record<string, string>> = {};
    Object.entries(state.threadsByWorkspace).forEach(([workspaceId, threads]) => {
      threads.forEach((thread) => {
        if (!thread.detachedReviewParentId) {
          return;
        }
        nextLinksByWorkspace[workspaceId] ??= {};
        nextLinksByWorkspace[workspaceId][thread.id] = thread.detachedReviewParentId;
        detachedReviewParentByChildRef.current[thread.id] = thread.detachedReviewParentId;
      });
    });
    detachedReviewLinksByWorkspaceRef.current = nextLinksByWorkspace;
  }, [state.threadsByWorkspace]);

  useEffect(() => {
    const linksByWorkspace = detachedReviewLinksByWorkspaceRef.current;
    Object.entries(state.threadsByWorkspace).forEach(([workspaceId, threads]) => {
      const workspaceLinks = linksByWorkspace[workspaceId];
      if (!workspaceLinks) {
        return;
      }
      const threadIds = new Set(threads.map((thread) => thread.id));
      Object.entries(workspaceLinks).forEach(([childId, parentId]) => {
        if (!childId || !parentId || childId === parentId) {
          return;
        }
        if (!threadIds.has(childId) || !threadIds.has(parentId)) {
          return;
        }
        if (state.threadParentById[childId]) {
          return;
        }
        updateThreadParent(parentId, [childId]);
      });
    });
  }, [state.threadParentById, state.threadsByWorkspace, updateThreadParent]);

  const handleReviewExited = useCallback(
    (workspaceId: string, threadId: string) => {
      const parentId = detachedReviewParentByChildRef.current[threadId];
      if (!parentId) {
        return;
      }
      delete detachedReviewParentByChildRef.current[threadId];

      const timestamp = Date.now();
      recordThreadActivity(workspaceId, parentId, timestamp);
      dispatch({
        type: "setThreadTimestamp",
        workspaceId,
        threadId: parentId,
        timestamp,
      });
      const noticeKey = `${parentId}->${threadId}`;
      const alreadyNotified = detachedReviewCompletedNoticeRef.current.has(noticeKey);
      if (!alreadyNotified) {
        detachedReviewCompletedNoticeRef.current.add(noticeKey);
        dispatch({
          type: "addAssistantMessage",
          threadId: parentId,
          text: `Detached review completed. [Open review thread](/thread/${threadId})`,
        });
      }
      if (parentId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId: parentId, hasUnread: true });
      }
      safeMessageActivity();
    },
    [
      activeThreadId,
      dispatch,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const { onUserMessageCreated } = useThreadTitleAutogeneration({
    enabled: threadTitleAutogenerationEnabled,
    itemsByThreadRef,
    threadsByWorkspaceRef,
    getCustomName,
    renameThread,
    onDebug,
  });

  const threadHandlers = useThreadEventHandlers({
    activeThreadId,
    dispatch,
    getItemsForThread: (threadId) => itemsByThreadRef.current[threadId] ?? [],
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
    onWorkspaceConnected: handleWorkspaceConnected,
    applyCollabThreadLinks,
    onReviewExited: handleReviewExited,
    approvalAllowlistRef,
    pendingInterruptsRef,
  });

  const handleAccountLoginCompleted = useCallback(
    (workspaceId: string) => {
      handleAccountUpdated(workspaceId);
    },
    [handleAccountUpdated],
  );

  const handleThreadStarted = useCallback(
    (workspaceId: string, thread: Record<string, unknown>) => {
      threadHandlers.onThreadStarted(workspaceId, thread);
      const threadId = String(thread.id ?? "").trim();
      if (!threadId) {
        return;
      }
      const parentThreadId = getParentThreadIdFromThread(thread);
      if (!parentThreadId) {
        return;
      }
      updateThreadParent(parentThreadId, [threadId]);
      onSubagentThreadDetected(workspaceId, threadId);
    },
    [onSubagentThreadDetected, threadHandlers, updateThreadParent],
  );

  const handleThreadArchived = useCallback(
    (workspaceId: string, threadId: string) => {
      if (!workspaceId || !threadId) {
        return;
      }
      threadHandlers.onThreadArchived?.(workspaceId, threadId);
      dispatch({ type: "setThreadPinnedAt", workspaceId, threadId, pinnedAt: null });
      void unpinThreadService(workspaceId, threadId).catch((error) => {
        onDebug?.({
          id: `${Date.now()}-client-thread-unpin-on-archive-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/unpin on archive error",
          payload: error instanceof Error ? error.message : String(error),
        });
      });

      const skipKey = buildWorkspaceThreadKey(workspaceId, threadId);
      const skipAt = cascadeArchiveSkipRef.current[skipKey] ?? null;
      if (skipAt !== null) {
        delete cascadeArchiveSkipRef.current[skipKey];
        if (
          skipAt > 0 &&
          Date.now() - skipAt >= 0 &&
          Date.now() - skipAt < CASCADE_ARCHIVE_SKIP_TTL_MS
        ) {
          return;
        }
      }

      const descendants = getSubagentDescendantThreadIds({
        rootThreadId: threadId,
        threadParentById: threadParentByIdRef.current,
        isSubagentThread: (candidateId) =>
          isSubagentThread(workspaceId, candidateId),
      });
      if (descendants.length === 0) {
        return;
      }

      onDebug?.({
        id: `${Date.now()}-client-thread-archive-cascade`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/archive cascade",
        payload: { workspaceId, rootThreadId: threadId, descendantCount: descendants.length },
      });

      const now = Date.now();
      Object.entries(cascadeArchiveSkipRef.current).forEach(([key, timestamp]) => {
        if (now - timestamp >= CASCADE_ARCHIVE_SKIP_TTL_MS) {
          delete cascadeArchiveSkipRef.current[key];
        }
      });

      void (async () => {
        for (const descendantId of descendants) {
          const descendantKey = buildWorkspaceThreadKey(workspaceId, descendantId);
          cascadeArchiveSkipRef.current[descendantKey] = Date.now();
          try {
            await archiveThreadService(workspaceId, descendantId);
          } catch (error) {
            delete cascadeArchiveSkipRef.current[descendantKey];
            onDebug?.({
              id: `${Date.now()}-client-thread-archive-cascade-error`,
              timestamp: Date.now(),
              source: "error",
              label: "thread/archive cascade error",
              payload: {
                workspaceId,
                rootThreadId: threadId,
                threadId: descendantId,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      })();
    },
    [dispatch, isSubagentThread, onDebug, threadHandlers],
  );

  const handleThreadUnarchived = useCallback(
    (workspaceId: string, threadId: string) => {
      threadHandlers.onThreadUnarchived?.(workspaceId, threadId);
    },
    [threadHandlers],
  );

  const handlers = useMemo(
    () => ({
      ...threadHandlers,
      onThreadStarted: handleThreadStarted,
      onThreadArchived: handleThreadArchived,
      onThreadUnarchived: handleThreadUnarchived,
      onAccountUpdated: handleAccountUpdated,
      onAccountLoginCompleted: handleAccountLoginCompleted,
    }),
    [
      threadHandlers,
      handleThreadStarted,
      handleThreadArchived,
      handleThreadUnarchived,
      handleAccountUpdated,
      handleAccountLoginCompleted,
    ],
  );

  useAppServerEvents(handlers);

  const {
    startThreadForWorkspace: startThreadForWorkspaceInternal,
    forkThreadForWorkspace,
    resumeThreadForWorkspace,
    refreshThread,
    resetWorkspaceThreads,
    listThreadsForWorkspaces,
    listThreadsForWorkspace,
    loadOlderThreadsForWorkspace,
    archiveThread,
  } = useThreadActions({
    dispatch,
    itemsByThread: state.itemsByThread,
    threadsByWorkspace: state.threadsByWorkspace,
    activeThreadIdByWorkspace: state.activeThreadIdByWorkspace,
    activeTurnIdByThread: state.activeTurnIdByThread,
    threadParentById: state.threadParentById,
    threadListCursorByWorkspace: state.threadListCursorByWorkspace,
    threadStatusById: state.threadStatusById,
    threadSortKey,
    onDebug,
    getCustomName,
    threadActivityRef,
    loadedThreadsRef,
    replaceOnResumeRef,
    applyCollabThreadLinksFromThread,
    updateThreadParent,
    onSubagentThreadDetected,
    onThreadCodexMetadataDetected,
  });

  const pinThread = useCallback(
    (workspaceId: string, threadId: string): boolean => {
      if (isThreadPinned(workspaceId, threadId)) {
        return false;
      }
      const currentPinsForWorkspace = (state.threadsByWorkspace[workspaceId] ?? []).filter(
        (thread) => thread.pinnedAt !== null && thread.pinnedAt !== undefined,
      ).length;
      if (currentPinsForWorkspace >= MAX_PINS_SOFT_LIMIT) {
        console.warn(
          `Pin limit reached (${MAX_PINS_SOFT_LIMIT}). Consider unpinning some threads.`,
        );
      }
      const pinnedAt = Date.now();
      dispatch({ type: "setThreadPinnedAt", workspaceId, threadId, pinnedAt });
      void pinThreadService(workspaceId, threadId).catch((error) => {
        dispatch({ type: "setThreadPinnedAt", workspaceId, threadId, pinnedAt: null });
        onDebug?.({
          id: `${Date.now()}-client-thread-pin-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/pin error",
          payload: error instanceof Error ? error.message : String(error),
        });
      });
      return true;
    },
    [dispatch, isThreadPinned, onDebug, state.threadsByWorkspace],
  );

  const unpinThread = useCallback(
    (workspaceId: string, threadId: string) => {
      if (!isThreadPinned(workspaceId, threadId)) {
        return;
      }
      const previousPinnedAt = getPinTimestamp(workspaceId, threadId);
      dispatch({ type: "setThreadPinnedAt", workspaceId, threadId, pinnedAt: null });
      void unpinThreadService(workspaceId, threadId).catch((error) => {
        dispatch({
          type: "setThreadPinnedAt",
          workspaceId,
          threadId,
          pinnedAt: previousPinnedAt,
        });
        onDebug?.({
          id: `${Date.now()}-client-thread-unpin-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/unpin error",
          payload: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [dispatch, getPinTimestamp, isThreadPinned, onDebug],
  );

  const ensureWorkspaceRuntimeCodexArgsBestEffort = useCallback(
    async (workspaceId: string, threadId: string | null, phase: string) => {
      if (!ensureWorkspaceRuntimeCodexArgs) {
        return;
      }
      try {
        await ensureWorkspaceRuntimeCodexArgs(workspaceId, threadId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        onDebug?.({
          id: `${Date.now()}-client-thread-runtime-codex-args-sync-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/runtime-codex-args sync error",
          payload: `${phase}: ${detail}`,
        });
      }
    },
    [ensureWorkspaceRuntimeCodexArgs, onDebug],
  );

  const getWorkspaceThreadIds = useCallback(
    (workspaceId: string, includeThreadId?: string) => {
      const visibleThreadIds = (state.threadsByWorkspace[workspaceId] ?? [])
        .map((thread) => String(thread.id ?? "").trim())
        .filter((threadId) => threadId.length > 0);
      const hiddenThreadIds = Object.keys(
        state.hiddenThreadIdsByWorkspace[workspaceId] ?? {},
      );
      const activeThreadIdForWorkspace =
        state.activeThreadIdByWorkspace[workspaceId] ?? null;
      const threadIds = new Set([...visibleThreadIds, ...hiddenThreadIds]);
      if (activeThreadIdForWorkspace) {
        threadIds.add(activeThreadIdForWorkspace);
      }
      if (includeThreadId) {
        threadIds.add(includeThreadId);
      }
      return Array.from(threadIds);
    },
    [
      state.activeThreadIdByWorkspace,
      state.hiddenThreadIdsByWorkspace,
      state.threadsByWorkspace,
    ],
  );

  const hasProcessingThreadInWorkspace = useCallback(
    (workspaceId: string, excludedThreadId?: string) =>
      getWorkspaceThreadIds(workspaceId, excludedThreadId).some(
        (candidateThreadId) =>
          candidateThreadId !== excludedThreadId &&
          Boolean(state.threadStatusById[candidateThreadId]?.isProcessing),
      ),
    [getWorkspaceThreadIds, state.threadStatusById],
  );

  const shouldPreflightRuntimeCodexArgsForSend = useCallback(
    (workspaceId: string, threadId: string) =>
      !hasProcessingThreadInWorkspace(workspaceId, threadId),
    [hasProcessingThreadInWorkspace],
  );

  const startThreadForWorkspace = useCallback(
    async (workspaceId: string, options?: { activate?: boolean }) => {
      await ensureWorkspaceRuntimeCodexArgsBestEffort(workspaceId, null, "start");
      return startThreadForWorkspaceInternal(workspaceId, options);
    },
    [ensureWorkspaceRuntimeCodexArgsBestEffort, startThreadForWorkspaceInternal],
  );

  const startThread = useCallback(async () => {
    if (!activeWorkspaceId) {
      return null;
    }
    return startThreadForWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, startThreadForWorkspace]);

  const ensureThreadForActiveWorkspace = useCallback(async () => {
    if (!activeWorkspace) {
      return null;
    }
    let threadId = activeThreadId;
    if (!threadId) {
      threadId = await startThreadForWorkspace(activeWorkspace.id);
      if (!threadId) {
        return null;
      }
    } else if (!loadedThreadsRef.current[threadId]) {
      await ensureWorkspaceRuntimeCodexArgsBestEffort(
        activeWorkspace.id,
        threadId,
        "resume",
      );
      await resumeThreadForWorkspace(activeWorkspace.id, threadId);
    }
    return threadId;
  }, [
    activeWorkspace,
    activeThreadId,
    ensureWorkspaceRuntimeCodexArgsBestEffort,
    resumeThreadForWorkspace,
    startThreadForWorkspace,
  ]);

  const ensureThreadForWorkspace = useCallback(
    async (workspaceId: string) => {
      const currentActiveThreadId = state.activeThreadIdByWorkspace[workspaceId] ?? null;
      const shouldActivate = workspaceId === activeWorkspaceId;
      let threadId = currentActiveThreadId;
      if (!threadId) {
        threadId = await startThreadForWorkspace(workspaceId, {
          activate: shouldActivate,
        });
        if (!threadId) {
          return null;
        }
      } else if (!loadedThreadsRef.current[threadId]) {
        await ensureWorkspaceRuntimeCodexArgsBestEffort(workspaceId, threadId, "resume");
        await resumeThreadForWorkspace(workspaceId, threadId);
      }
      if (shouldActivate && currentActiveThreadId !== threadId) {
        dispatch({ type: "setActiveThreadId", workspaceId, threadId });
      }
      return threadId;
    },
    [
      activeWorkspaceId,
      dispatch,
      ensureWorkspaceRuntimeCodexArgsBestEffort,
      loadedThreadsRef,
      resumeThreadForWorkspace,
      startThreadForWorkspace,
      state.activeThreadIdByWorkspace,
    ],
  );

  const {
    interruptTurn,
    sendUserMessage,
    sendUserMessageToThread,
    startFork,
    startReview,
    startUncommittedReview,
    startResume,
    startCompact,
    startApps,
    startMcp,
    startFast,
    startStatus,
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
  } = useThreadMessaging({
    activeWorkspace,
    activeThreadId,
    accessMode,
    model,
    effort,
    serviceTier,
    collaborationMode,
    onSelectServiceTier,
    reviewDeliveryMode,
    steerEnabled,
    customPrompts,
    ensureWorkspaceRuntimeCodexArgs,
    shouldPreflightRuntimeCodexArgsForSend,
    threadStatusById: state.threadStatusById,
    activeTurnIdByThread: state.activeTurnIdByThread,
    rateLimitsByWorkspace: state.rateLimitsByWorkspace,
    pendingInterruptsRef,
    dispatch,
    getCustomName,
    markProcessing,
    markReviewing,
    setActiveTurnId,
    recordThreadActivity,
    safeMessageActivity,
    onDebug,
    pushThreadErrorMessage,
    ensureThreadForActiveWorkspace,
    ensureThreadForWorkspace,
    refreshThread,
    forkThreadForWorkspace,
    updateThreadParent,
    registerDetachedReviewChild,
    renameThread,
  });

  const hasLocalThreadSnapshot = useCallback(
    (threadId: string | null) => {
      if (!threadId) {
        return false;
      }
      return (
        loadedThreadsRef.current[threadId] === true ||
        (itemsByThreadRef.current[threadId]?.length ?? 0) > 0
      );
    },
    [itemsByThreadRef, loadedThreadsRef],
  );

  const setActiveThreadId = useCallback(
    (threadId: string | null, workspaceId?: string) => {
      const targetId = workspaceId ?? activeWorkspaceId;
      if (!targetId) {
        return;
      }
      const currentThreadId = state.activeThreadIdByWorkspace[targetId] ?? null;
      dispatch({ type: "setActiveThreadId", workspaceId: targetId, threadId });
      if (threadId && currentThreadId !== threadId) {
        Sentry.metrics.count("thread_switched", 1, {
          attributes: {
            workspace_id: targetId,
            thread_id: threadId,
            reason: "select",
          },
        });
      }
      if (threadId) {
        void (async () => {
          const hasLocalSnapshot = hasLocalThreadSnapshot(threadId);
          if (hasLocalSnapshot) {
            loadedThreadsRef.current[threadId] = true;
            return;
          }
          const hasActiveTurnInWorkspace = hasProcessingThreadInWorkspace(targetId);
          if (!hasActiveTurnInWorkspace) {
            await ensureWorkspaceRuntimeCodexArgsBestEffort(targetId, threadId, "resume");
          }
          await resumeThreadForWorkspace(targetId, threadId);
        })();
      }
    },
    [
      activeWorkspaceId,
      ensureWorkspaceRuntimeCodexArgsBestEffort,
      hasLocalThreadSnapshot,
      hasProcessingThreadInWorkspace,
      loadedThreadsRef,
      resumeThreadForWorkspace,
      state.activeThreadIdByWorkspace,
    ],
  );

  const removeThread = useCallback(
    (workspaceId: string, threadId: string) => {
      unpinThread(workspaceId, threadId);
      dispatch({ type: "hideThread", workspaceId, threadId });
      void archiveThread(workspaceId, threadId);
    },
    [archiveThread, unpinThread],
  );

  return {
    activeThreadId,
    setActiveThreadId,
    hasLocalThreadSnapshot,
    activeItems,
    approvals: state.approvals,
    userInputRequests: state.userInputRequests,
    threadsByWorkspace: state.threadsByWorkspace,
    threadParentById: state.threadParentById,
    isSubagentThread,
    threadStatusById: state.threadStatusById,
    threadResumeLoadingById: state.threadResumeLoadingById,
    threadListLoadingByWorkspace: state.threadListLoadingByWorkspace,
    threadListPagingByWorkspace: state.threadListPagingByWorkspace,
    threadListCursorByWorkspace: state.threadListCursorByWorkspace,
    activeTurnIdByThread: state.activeTurnIdByThread,
    turnDiffByThread: state.turnDiffByThread,
    tokenUsageByThread: state.tokenUsageByThread,
    rateLimitsByWorkspace: state.rateLimitsByWorkspace,
    accountByWorkspace: state.accountByWorkspace,
    planByThread: state.planByThread,
    lastAgentMessageByThread: state.lastAgentMessageByThread,
    pinnedThreadsVersion,
    refreshAccountRateLimits,
    refreshAccountInfo,
    interruptTurn,
    removeThread,
    pinThread,
    unpinThread,
    isThreadPinned,
    getPinTimestamp,
    renameThread,
    startThread,
    startThreadForWorkspace,
    forkThreadForWorkspace,
    listThreadsForWorkspaces,
    listThreadsForWorkspace,
    refreshThread,
    resetWorkspaceThreads,
    loadOlderThreadsForWorkspace,
    sendUserMessage,
    sendUserMessageToThread,
    startFork,
    startReview,
    startUncommittedReview,
    startResume,
    startCompact,
    startApps,
    startMcp,
    startFast,
    startStatus,
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
    handleApprovalDecision,
    handleApprovalRemember,
    handleUserInputSubmit,
  };
}
