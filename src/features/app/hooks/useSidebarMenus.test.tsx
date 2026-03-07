/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceInfo } from "../../../types";
import { useSidebarMenus } from "./useSidebarMenus";

describe("useSidebarMenus", () => {
  it("builds thread menu items including fork and archive", async () => {
    const onDeleteThread = vi.fn();
    const onForkThread = vi.fn();
    const onSyncThread = vi.fn();
    const onPinThread = vi.fn();
    const onUnpinThread = vi.fn();
    const isThreadPinned = vi.fn(() => false);
    const onRenameThread = vi.fn();
    const onReloadWorkspaceThreads = vi.fn();
    const onDeleteWorkspace = vi.fn();
    const onDeleteWorktree = vi.fn();

    const { result } = renderHook(() =>
      useSidebarMenus({
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
      }),
    );

    const items = result.current.getThreadMenuItems("ws-1", "thread-1", true);
    expect(items.map((item) => item.label)).toEqual([
      "Rename",
      "Fork",
      "Sync from server",
      "Pin",
      "Copy ID",
      "Archive",
    ]);

    await items[1]?.onSelect();
    expect(onForkThread).toHaveBeenCalledWith("ws-1", "thread-1");

    await items[5]?.onSelect();
    expect(onDeleteThread).toHaveBeenCalledWith("ws-1", "thread-1");
  });

  it("builds worktree and clone menu items", () => {
    const onDeleteThread = vi.fn();
    const onForkThread = vi.fn();
    const onSyncThread = vi.fn();
    const onPinThread = vi.fn();
    const onUnpinThread = vi.fn();
    const isThreadPinned = vi.fn(() => false);
    const onRenameThread = vi.fn();
    const onReloadWorkspaceThreads = vi.fn();
    const onDeleteWorkspace = vi.fn();
    const onDeleteWorktree = vi.fn();

    const { result } = renderHook(() =>
      useSidebarMenus({
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
      }),
    );

    const worktree: WorkspaceInfo = {
      id: "worktree-1",
      name: "feature/test",
      path: "/tmp/worktree-1",
      kind: "worktree",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        worktreeSetupScript: "",
      },
      worktree: { branch: "feature/test" },
    };

    const clone: WorkspaceInfo = {
      ...worktree,
      id: "clone-1",
      kind: "main",
    };

    expect(result.current.getWorktreeMenuItems(worktree).map((item) => item.label)).toEqual([
      "Reload threads",
      "Delete worktree",
    ]);
    expect(result.current.getCloneMenuItems(clone).map((item) => item.label)).toEqual([
      "Reload threads",
      "Delete clone",
    ]);
  });
});
