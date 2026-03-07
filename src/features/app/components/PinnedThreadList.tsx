import type { MouseEvent } from "react";

import type { ThreadSummary } from "../../../types";
import type { ThreadStatusById } from "../../../utils/threadStatus";
import { useSubagentTreeVisibility } from "../hooks/useSubagentTreeVisibility";
import { ThreadRow } from "./ThreadRow";

type PinnedThreadRow = {
  thread: ThreadSummary;
  depth: number;
  workspaceId: string;
};

type PinnedThreadListProps = {
  rows: PinnedThreadRow[];
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  threadStatusById: ThreadStatusById;
  pendingUserInputKeys?: Set<string>;
  getWorkspaceLabel?: (workspaceId: string) => string | null;
  getThreadTime: (thread: ThreadSummary) => string | null;
  getThreadArgsBadge?: (workspaceId: string, threadId: string) => string | null;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onShowThreadMenu: (
    event: MouseEvent,
    workspaceId: string,
    threadId: string,
    canPin: boolean,
  ) => void;
};

export function PinnedThreadList({
  rows,
  activeWorkspaceId,
  activeThreadId,
  threadStatusById,
  pendingUserInputKeys,
  getWorkspaceLabel,
  getThreadTime,
  getThreadArgsBadge,
  isThreadPinned,
  onSelectThread,
  onShowThreadMenu,
}: PinnedThreadListProps) {
  const { visibleRows, rowsWithChildren, isRowExpanded, toggleRow } = useSubagentTreeVisibility({
    rows,
    getThreadKey: (row) => `${row.workspaceId}:${row.thread.id}`,
    activeWorkspaceId,
    activeThreadId,
    threadStatusById,
    getWorkspaceId: (row) => row.workspaceId,
  });

  return (
    <div className="thread-list pinned-thread-list">
      {visibleRows.map((row) => {
        const { thread, depth, workspaceId } = row;
        return (
          <ThreadRow
            key={`${workspaceId}:${thread.id}`}
            thread={thread}
            depth={depth}
            workspaceId={workspaceId}
            indentUnit={14}
            activeWorkspaceId={activeWorkspaceId}
            activeThreadId={activeThreadId}
            threadStatusById={threadStatusById}
            pendingUserInputKeys={pendingUserInputKeys}
            workspaceLabel={getWorkspaceLabel?.(workspaceId) ?? null}
            getThreadTime={getThreadTime}
            getThreadArgsBadge={getThreadArgsBadge}
            isThreadPinned={isThreadPinned}
            onSelectThread={onSelectThread}
            onShowThreadMenu={onShowThreadMenu}
            hasSubagentChildren={rowsWithChildren.has(row)}
            subagentsExpanded={isRowExpanded(row)}
            onToggleSubagents={() => toggleRow(row)}
          />
        );
      })}
    </div>
  );
}
