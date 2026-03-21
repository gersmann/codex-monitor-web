import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ThreadStatusById } from "../../../utils/threadStatus";
import { buildThreadRowVisibility } from "../components/threadRowVisibility";

type RowWithThread = {
  thread: {
    id: string;
  };
  depth: number;
};

type UseSubagentTreeVisibilityParams<T extends RowWithThread> = {
  rows: T[];
  getThreadKey: (row: T) => string;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  threadStatusById: ThreadStatusById;
  getWorkspaceId: (row: T) => string;
};

export function useSubagentTreeVisibility<T extends RowWithThread>({
  rows,
  getThreadKey,
  activeWorkspaceId,
  activeThreadId,
  threadStatusById,
  getWorkspaceId,
}: UseSubagentTreeVisibilityParams<T>) {
  const [expandedThreadKeys, setExpandedThreadKeys] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const previousDescendantCountsRef = useRef<Map<string, number>>(new Map());

  const treeState = useMemo(() => {
    const rowsWithChildren = new Set<T>();
    const descendantCounts = new Map<string, number>();
    const activeDescendantThreadKeys = new Set<string>();
    const stack: T[] = [];
    const currentThreadKeys = new Set<string>();

    rows.forEach((row) => {
      currentThreadKeys.add(getThreadKey(row));
      while (stack.length > 0 && row.depth <= stack[stack.length - 1].depth) {
        stack.pop();
      }

      const isRowActive =
        (getWorkspaceId(row) === activeWorkspaceId && row.thread.id === activeThreadId) ||
        Boolean(threadStatusById[row.thread.id]?.isProcessing) ||
        Boolean(threadStatusById[row.thread.id]?.isReviewing);

      stack.forEach((ancestor) => {
        rowsWithChildren.add(ancestor);
        const ancestorKey = getThreadKey(ancestor);
        descendantCounts.set(ancestorKey, (descendantCounts.get(ancestorKey) ?? 0) + 1);
        if (isRowActive) {
          activeDescendantThreadKeys.add(ancestorKey);
        }
      });

      stack.push(row);
    });

    return {
      rowsWithChildren,
      descendantCounts,
      activeDescendantThreadKeys,
      currentThreadKeys,
    };
  }, [
    activeThreadId,
    activeWorkspaceId,
    getThreadKey,
    getWorkspaceId,
    rows,
    threadStatusById,
  ]);

  useEffect(() => {
    const previousDescendantCounts = previousDescendantCountsRef.current;
    previousDescendantCountsRef.current = treeState.descendantCounts;
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }

    setExpandedThreadKeys((prev) => {
      let changed = false;
      const next = new Set<string>();

      prev.forEach((threadKey) => {
        if (treeState.currentThreadKeys.has(threadKey)) {
          next.add(threadKey);
        } else {
          changed = true;
        }
      });

      rows.forEach((row) => {
        if (!treeState.rowsWithChildren.has(row)) {
          return;
        }
        const threadKey = getThreadKey(row);
        const currentCount = treeState.descendantCounts.get(threadKey) ?? 0;
        const previousCount = previousDescendantCounts.get(threadKey) ?? 0;
        const isCurrentlyCollapsed =
          !treeState.activeDescendantThreadKeys.has(threadKey) && !next.has(threadKey);

        if (currentCount > previousCount && isCurrentlyCollapsed) {
          next.add(threadKey);
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [getThreadKey, rows, treeState]);

  const isRowExpanded = useCallback(
    (row: T) => {
      if (!treeState.rowsWithChildren.has(row)) {
        return true;
      }
      const threadKey = getThreadKey(row);
      return (
        treeState.activeDescendantThreadKeys.has(threadKey) ||
        expandedThreadKeys.has(threadKey)
      );
    },
    [expandedThreadKeys, getThreadKey, treeState.activeDescendantThreadKeys, treeState.rowsWithChildren],
  );

  const visibility = useMemo(
    () =>
      buildThreadRowVisibility(
        rows,
        (row) => treeState.rowsWithChildren.has(row) && !isRowExpanded(row),
      ),
    [isRowExpanded, rows, treeState.rowsWithChildren],
  );

  const toggleRow = useCallback(
    (row: T) => {
      if (!treeState.rowsWithChildren.has(row)) {
        return;
      }
      const threadKey = getThreadKey(row);
      if (treeState.activeDescendantThreadKeys.has(threadKey)) {
        return;
      }
      setExpandedThreadKeys((prev) => {
        const next = new Set(prev);
        if (next.has(threadKey)) {
          next.delete(threadKey);
        } else {
          next.add(threadKey);
        }
        return next;
      });
    },
    [getThreadKey, treeState.activeDescendantThreadKeys, treeState.rowsWithChildren],
  );

  return {
    visibleRows: visibility.visibleRows,
    rowsWithChildren: visibility.rowsWithChildren,
    isRowExpanded,
    toggleRow,
  };
}
