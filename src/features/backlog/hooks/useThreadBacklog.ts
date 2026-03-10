import { useCallback, useEffect, useState } from "react";
import type { ThreadBacklogItem } from "@/types";
import {
  addThreadBacklogItem,
  deleteThreadBacklogItem,
  getThreadBacklog,
  updateThreadBacklogItem,
} from "@services/tauri";

type UseThreadBacklogArgs = {
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
};

export function useThreadBacklog({ activeWorkspaceId, activeThreadId }: UseThreadBacklogArgs) {
  const [itemsByThread, setItemsByThread] = useState<Record<string, ThreadBacklogItem[]>>({});
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [errorByThread, setErrorByThread] = useState<Record<string, string | null>>({});

  const activeItems = activeThreadId ? itemsByThread[activeThreadId] ?? [] : [];
  const activeError = activeThreadId ? errorByThread[activeThreadId] ?? null : null;
  const isLoading = activeThreadId ? loadingThreadId === activeThreadId : false;

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId || !activeThreadId) {
      return;
    }
    const threadId = activeThreadId;
    setLoadingThreadId(threadId);
    setErrorByThread((prev) => ({ ...prev, [threadId]: null }));
    try {
      const result = await getThreadBacklog(activeWorkspaceId, threadId);
      const nextItems = Array.isArray(result) ? result : [];
      setItemsByThread((prev) => ({ ...prev, [threadId]: nextItems }));
    } catch (error) {
      setErrorByThread((prev) => ({
        ...prev,
        [threadId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setLoadingThreadId((current) => (current === threadId ? null : current));
    }
  }, [activeThreadId, activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId || !activeThreadId) {
      return;
    }
    void refresh();
  }, [activeThreadId, activeWorkspaceId, refresh]);

  const addItem = useCallback(
    async (text: string) => {
      if (!activeWorkspaceId || !activeThreadId) {
        throw new Error("No active thread.");
      }
      const item = await addThreadBacklogItem(activeWorkspaceId, activeThreadId, text);
      setItemsByThread((prev) => ({
        ...prev,
        [activeThreadId]: [item, ...(prev[activeThreadId] ?? [])],
      }));
      setErrorByThread((prev) => ({ ...prev, [activeThreadId]: null }));
    },
    [activeThreadId, activeWorkspaceId],
  );

  const updateItem = useCallback(
    async (itemId: string, text: string) => {
      if (!activeWorkspaceId || !activeThreadId) {
        throw new Error("No active thread.");
      }
      const updated = (await updateThreadBacklogItem(
        activeWorkspaceId,
        activeThreadId,
        itemId,
        text,
      )) as ThreadBacklogItem;
      setItemsByThread((prev) => ({
        ...prev,
        [activeThreadId]: (prev[activeThreadId] ?? []).map((item) =>
          item.id === itemId ? updated : item,
        ),
      }));
      setErrorByThread((prev) => ({ ...prev, [activeThreadId]: null }));
    },
    [activeThreadId, activeWorkspaceId],
  );

  const deleteItem = useCallback(
    async (itemId: string) => {
      if (!activeWorkspaceId || !activeThreadId) {
        throw new Error("No active thread.");
      }
      await deleteThreadBacklogItem(activeWorkspaceId, activeThreadId, itemId);
      setItemsByThread((prev) => ({
        ...prev,
        [activeThreadId]: (prev[activeThreadId] ?? []).filter((item) => item.id !== itemId),
      }));
      setErrorByThread((prev) => ({ ...prev, [activeThreadId]: null }));
    },
    [activeThreadId, activeWorkspaceId],
  );

  return {
    activeItems,
    activeError,
    isLoading,
    refresh,
    addItem,
    updateItem,
    deleteItem,
  };
}
