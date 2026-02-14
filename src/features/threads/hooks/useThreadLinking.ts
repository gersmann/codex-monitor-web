import { useCallback } from "react";
import type { Dispatch } from "react";
import type { ThreadAction } from "./useThreadsReducer";
import { asString, normalizeStringList } from "@threads/utils/threadNormalize";

type UseThreadLinkingOptions = {
  dispatch: Dispatch<ThreadAction>;
  threadParentById: Record<string, string>;
  onSubagentThreadDetected?: (workspaceId: string, threadId: string) => void;
};

export function useThreadLinking({
  dispatch,
  threadParentById,
  onSubagentThreadDetected,
}: UseThreadLinkingOptions) {
  const wouldCreateThreadCycle = useCallback(
    (parentId: string, childId: string) => {
      const visited = new Set([childId]);
      let current: string | undefined = parentId;
      while (current) {
        if (visited.has(current)) {
          return true;
        }
        visited.add(current);
        current = threadParentById[current];
      }
      return false;
    },
    [threadParentById],
  );

  const updateThreadParent = useCallback(
    (parentId: string, childIds: string[]) => {
      if (!parentId || childIds.length === 0) {
        return;
      }
      childIds.forEach((childId) => {
        if (!childId || childId === parentId) {
          return;
        }
        const existingParent = threadParentById[childId];
        if (existingParent === parentId) {
          return;
        }
        if (existingParent) {
          return;
        }
        if (wouldCreateThreadCycle(parentId, childId)) {
          return;
        }
        dispatch({ type: "setThreadParent", threadId: childId, parentId });
      });
    },
    [dispatch, threadParentById, wouldCreateThreadCycle],
  );

  const applyCollabThreadLinks = useCallback(
    (
      workspaceId: string,
      fallbackThreadId: string,
      item: Record<string, unknown>,
    ) => {
      const itemType = asString(item?.type ?? "");
      if (itemType !== "collabToolCall" && itemType !== "collabAgentToolCall") {
        return;
      }
      const sender = asString(item.senderThreadId ?? item.sender_thread_id ?? "");
      const parentId = sender || fallbackThreadId;
      if (!parentId) {
        return;
      }
      const receivers = [
        ...normalizeStringList(item.receiverThreadId ?? item.receiver_thread_id),
        ...normalizeStringList(item.receiverThreadIds ?? item.receiver_thread_ids),
        ...normalizeStringList(item.newThreadId ?? item.new_thread_id),
      ];
      updateThreadParent(parentId, receivers);
      receivers.forEach((receiver) => {
        if (!receiver) {
          return;
        }
        onSubagentThreadDetected?.(workspaceId, receiver);
      });
    },
    [onSubagentThreadDetected, updateThreadParent],
  );

  const applyCollabThreadLinksFromThread = useCallback(
    (
      workspaceId: string,
      fallbackThreadId: string,
      thread: Record<string, unknown>,
    ) => {
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      turns.forEach((turn) => {
        const turnRecord = turn as Record<string, unknown>;
        const turnItems = Array.isArray(turnRecord.items)
          ? (turnRecord.items as Record<string, unknown>[])
          : [];
        turnItems.forEach((item) => {
          applyCollabThreadLinks(workspaceId, fallbackThreadId, item);
        });
      });
    },
    [applyCollabThreadLinks],
  );

  return {
    applyCollabThreadLinks,
    applyCollabThreadLinksFromThread,
    updateThreadParent,
  };
}
