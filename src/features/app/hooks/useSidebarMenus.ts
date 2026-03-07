import { useCallback } from "react";

import type { WorkspaceInfo } from "../../../types";

export type SidebarMenuItem = {
  key: string;
  label: string;
  onSelect: () => void | Promise<void>;
  active?: boolean;
  destructive?: boolean;
};

type SidebarMenuHandlers = {
  onDeleteThread: (workspaceId: string, threadId: string) => void;
  onForkThread: (workspaceId: string, threadId: string) => void;
  onSyncThread: (workspaceId: string, threadId: string) => void;
  onPinThread: (workspaceId: string, threadId: string) => void;
  onUnpinThread: (workspaceId: string, threadId: string) => void;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  onRenameThread: (workspaceId: string, threadId: string) => void;
  onReloadWorkspaceThreads: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onDeleteWorktree: (workspaceId: string) => void;
};

export function useSidebarMenus({
  onDeleteThread,
  onForkThread,
  onSyncThread,
  onPinThread,
  onUnpinThread,
  isThreadPinned,
  onRenameThread,
  onReloadWorkspaceThreads,
  onDeleteWorkspace,
  onDeleteWorktree,
}: SidebarMenuHandlers) {
  const getThreadMenuItems = useCallback(
    (workspaceId: string, threadId: string, canPin: boolean): SidebarMenuItem[] => {
      const items: SidebarMenuItem[] = [
        {
          key: "rename",
          label: "Rename",
          onSelect: () => onRenameThread(workspaceId, threadId),
        },
        {
          key: "fork",
          label: "Fork",
          onSelect: () => onForkThread(workspaceId, threadId),
        },
        {
          key: "sync",
          label: "Sync from server",
          onSelect: () => onSyncThread(workspaceId, threadId),
        },
      ];
      if (canPin) {
        const pinned = isThreadPinned(workspaceId, threadId);
        items.push({
          key: "pin",
          label: pinned ? "Unpin" : "Pin",
          active: pinned,
          onSelect: () => {
            if (pinned) {
              onUnpinThread(workspaceId, threadId);
              return;
            }
            onPinThread(workspaceId, threadId);
          },
        });
      }
      items.push(
        {
          key: "copy-id",
          label: "Copy ID",
          onSelect: async () => {
            try {
              await navigator.clipboard.writeText(threadId);
            } catch {
              // Clipboard failures are non-fatal here.
            }
          },
        },
        {
          key: "archive",
          label: "Archive",
          destructive: true,
          onSelect: () => onDeleteThread(workspaceId, threadId),
        },
      );
      return items;
    },
    [
      isThreadPinned,
      onDeleteThread,
      onForkThread,
      onPinThread,
      onRenameThread,
      onSyncThread,
      onUnpinThread,
    ],
  );

  const getWorkspaceMenuItems = useCallback(
    (workspaceId: string): SidebarMenuItem[] => [
      {
        key: "reload",
        label: "Reload threads",
        onSelect: () => onReloadWorkspaceThreads(workspaceId),
      },
      {
        key: "delete",
        label: "Delete",
        destructive: true,
        onSelect: () => onDeleteWorkspace(workspaceId),
      },
    ],
    [onDeleteWorkspace, onReloadWorkspaceThreads],
  );

  const getWorktreeMenuItems = useCallback(
    (worktree: WorkspaceInfo): SidebarMenuItem[] => [
      {
        key: "reload",
        label: "Reload threads",
        onSelect: () => onReloadWorkspaceThreads(worktree.id),
      },
      {
        key: "delete-worktree",
        label: "Delete worktree",
        destructive: true,
        onSelect: () => onDeleteWorktree(worktree.id),
      },
    ],
    [onDeleteWorktree, onReloadWorkspaceThreads],
  );

  const getCloneMenuItems = useCallback(
    (clone: WorkspaceInfo): SidebarMenuItem[] => [
      {
        key: "reload",
        label: "Reload threads",
        onSelect: () => onReloadWorkspaceThreads(clone.id),
      },
      {
        key: "delete-clone",
        label: "Delete clone",
        destructive: true,
        onSelect: () => onDeleteWorkspace(clone.id),
      },
    ],
    [onDeleteWorkspace, onReloadWorkspaceThreads],
  );

  return {
    getThreadMenuItems,
    getWorkspaceMenuItems,
    getWorktreeMenuItems,
    getCloneMenuItems,
  };
}
