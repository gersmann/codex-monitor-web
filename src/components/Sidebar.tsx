import type { RateLimitSnapshot, ThreadSummary, WorkspaceInfo } from "../types";
import { FolderKanban, Layers } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

type SidebarProps = {
  workspaces: WorkspaceInfo[];
  threadsByWorkspace: Record<string, ThreadSummary[]>;
  threadStatusById: Record<
    string,
    { isProcessing: boolean; hasUnread: boolean; isReviewing: boolean }
  >;
  threadListLoadingByWorkspace: Record<string, boolean>;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  accountRateLimits: RateLimitSnapshot | null;
  onAddWorkspace: () => void;
  onSelectHome: () => void;
  onSelectWorkspace: (id: string) => void;
  onConnectWorkspace: (workspace: WorkspaceInfo) => void;
  onAddAgent: (workspace: WorkspaceInfo) => void;
  onAddWorktreeAgent: (workspace: WorkspaceInfo) => void;
  onToggleWorkspaceCollapse: (workspaceId: string, collapsed: boolean) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onDeleteThread: (workspaceId: string, threadId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onDeleteWorktree: (workspaceId: string) => void;
};

export function Sidebar({
  workspaces,
  threadsByWorkspace,
  threadStatusById,
  threadListLoadingByWorkspace,
  activeWorkspaceId,
  activeThreadId,
  accountRateLimits,
  onAddWorkspace,
  onSelectHome,
  onSelectWorkspace,
  onConnectWorkspace,
  onAddAgent,
  onAddWorktreeAgent,
  onToggleWorkspaceCollapse,
  onSelectThread,
  onDeleteThread,
  onDeleteWorkspace,
  onDeleteWorktree,
}: SidebarProps) {
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(
    new Set<string>(),
  );
  const [addMenuAnchor, setAddMenuAnchor] = useState<{
    workspaceId: string;
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!addMenuAnchor) {
      return;
    }
    function handlePointerDown(event: Event) {
      const target = event.target as Node | null;
      if (addMenuRef.current && target && addMenuRef.current.contains(target)) {
        return;
      }
      setAddMenuAnchor(null);
    }
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handlePointerDown, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handlePointerDown, true);
    };
  }, [addMenuAnchor]);

  async function showThreadMenu(
    event: React.MouseEvent,
    workspaceId: string,
    threadId: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const archiveItem = await MenuItem.new({
      text: "Archive",
      action: () => onDeleteThread(workspaceId, threadId),
    });
    const copyItem = await MenuItem.new({
      text: "Copy ID",
      action: async () => {
        await navigator.clipboard.writeText(threadId);
      },
    });
    const menu = await Menu.new({ items: [copyItem, archiveItem] });
    const window = getCurrentWindow();
    const position = new LogicalPosition(event.clientX, event.clientY);
    await menu.popup(position, window);
  }

  async function showWorkspaceMenu(
    event: React.MouseEvent,
    workspaceId: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const deleteItem = await MenuItem.new({
      text: "Delete",
      action: () => onDeleteWorkspace(workspaceId),
    });
    const menu = await Menu.new({ items: [deleteItem] });
    const window = getCurrentWindow();
    const position = new LogicalPosition(event.clientX, event.clientY);
    await menu.popup(position, window);
  }

  async function showWorktreeMenu(
    event: React.MouseEvent,
    workspaceId: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const deleteItem = await MenuItem.new({
      text: "Delete worktree",
      action: () => onDeleteWorktree(workspaceId),
    });
    const menu = await Menu.new({ items: [deleteItem] });
    const window = getCurrentWindow();
    const position = new LogicalPosition(event.clientX, event.clientY);
    await menu.popup(position, window);
  }

  const usagePercent = accountRateLimits?.primary?.usedPercent;
  const globalUsagePercent = accountRateLimits?.secondary?.usedPercent;
  const credits = accountRateLimits?.credits ?? null;
  const creditsLabel = credits?.hasCredits
    ? credits.unlimited
      ? "Credits: unlimited"
      : credits.balance
        ? `Credits: ${credits.balance}`
        : "Credits"
    : null;

  const primaryWindowLabel = (() => {
    const minutes = accountRateLimits?.primary?.windowDurationMins ?? null;
    if (!minutes || minutes <= 0) {
      return "Session";
    }
    if (minutes % 60 === 0) {
      return `${minutes / 60}H session`;
    }
    return `${minutes}m session`;
  })();

  const secondaryWindowLabel = (() => {
    const minutes = accountRateLimits?.secondary?.windowDurationMins ?? null;
    if (!minutes || minutes <= 0) {
      return "Global session";
    }
    return "Global session";
  })();

  const primaryUsageLabel =
    typeof usagePercent === "number"
      ? `${primaryWindowLabel}: ${Math.min(Math.max(Math.round(usagePercent), 0), 100)}%`
      : `${primaryWindowLabel}: --`;
  const secondaryUsageLabel =
    typeof globalUsagePercent === "number"
      ? `${secondaryWindowLabel}: ${Math.min(Math.max(Math.round(globalUsagePercent), 0), 100)}%`
      : `${secondaryWindowLabel}: --`;

  const rootWorkspaces = workspaces.filter(
    (entry) => (entry.kind ?? "main") !== "worktree" && !entry.parentId,
  );
  const worktreesByParent = new Map<string, WorkspaceInfo[]>();
  workspaces
    .filter((entry) => (entry.kind ?? "main") === "worktree" && entry.parentId)
    .forEach((entry) => {
      const parentId = entry.parentId as string;
      const list = worktreesByParent.get(parentId) ?? [];
      list.push(entry);
      worktreesByParent.set(parentId, list);
    });
  worktreesByParent.forEach((entries) => {
    entries.sort((a, b) => a.name.localeCompare(b.name));
  });

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div>
          <button
            className="subtitle subtitle-button"
            onClick={onSelectHome}
            data-tauri-drag-region="false"
            aria-label="Open home"
          >
            <FolderKanban className="sidebar-nav-icon" />
            Projects
          </button>
        </div>
        <button
          className="ghost workspace-add"
          onClick={onAddWorkspace}
          data-tauri-drag-region="false"
          aria-label="Add workspace"
        >
          +
        </button>
      </div>
      <div className="sidebar-body">
        <div className="workspace-list">
          {rootWorkspaces.map((entry) => {
            const threads = threadsByWorkspace[entry.id] ?? [];
            const isCollapsed = entry.settings.sidebarCollapsed;
            const showThreads = !isCollapsed && threads.length > 0;
            const isLoadingThreads =
              threadListLoadingByWorkspace[entry.id] ?? false;
            const showThreadLoader =
              !isCollapsed && isLoadingThreads && threads.length === 0;
            const worktrees = worktreesByParent.get(entry.id) ?? [];

            return (
              <div key={entry.id} className="workspace-card">
                <div
                  className={`workspace-row ${
                    entry.id === activeWorkspaceId ? "active" : ""
                  }`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectWorkspace(entry.id)}
                  onContextMenu={(event) => showWorkspaceMenu(event, entry.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectWorkspace(entry.id);
                    }
                  }}
                >
                  <div>
                    <div className="workspace-name-row">
                      <div className="workspace-title">
                        <span className="workspace-name">{entry.name}</span>
                        <button
                          className={`workspace-toggle ${
                            isCollapsed ? "" : "expanded"
                          }`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleWorkspaceCollapse(entry.id, !isCollapsed);
                          }}
                          data-tauri-drag-region="false"
                          aria-label={
                            isCollapsed ? "Show agents" : "Hide agents"
                          }
                          aria-expanded={!isCollapsed}
                        >
                          <span className="workspace-toggle-icon">›</span>
                        </button>
                      </div>
                      <button
                        className="ghost workspace-add"
                        onClick={(event) => {
                          event.stopPropagation();
                          const rect = (
                            event.currentTarget as HTMLElement
                          ).getBoundingClientRect();
                          const menuWidth = 200;
                          const left = Math.min(
                            Math.max(rect.left, 12),
                            window.innerWidth - menuWidth - 12,
                          );
                          const top = rect.bottom + 8;
                          setAddMenuAnchor((prev) =>
                            prev?.workspaceId === entry.id
                              ? null
                              : {
                                  workspaceId: entry.id,
                                  top,
                                  left,
                                  width: menuWidth,
                                },
                          );
                        }}
                        data-tauri-drag-region="false"
                        aria-label="Add agent options"
                        aria-expanded={addMenuAnchor?.workspaceId === entry.id}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  {!entry.connected && (
                    <span
                      className="connect"
                      onClick={(event) => {
                        event.stopPropagation();
                        onConnectWorkspace(entry);
                      }}
                    >
                      connect
                    </span>
                  )}
                </div>
                {addMenuAnchor?.workspaceId === entry.id &&
                  createPortal(
                    <div
                      className="workspace-add-menu"
                      ref={addMenuRef}
                      style={{
                        top: addMenuAnchor.top,
                        left: addMenuAnchor.left,
                        width: addMenuAnchor.width,
                      }}
                    >
                      <button
                        className="workspace-add-option"
                        onClick={(event) => {
                          event.stopPropagation();
                          setAddMenuAnchor(null);
                          onAddAgent(entry);
                        }}
                      >
                        New agent
                      </button>
                      <button
                        className="workspace-add-option"
                        onClick={(event) => {
                          event.stopPropagation();
                          setAddMenuAnchor(null);
                          onAddWorktreeAgent(entry);
                        }}
                      >
                        New worktree agent
                      </button>
                    </div>,
                    document.body,
                  )}
                {!isCollapsed && worktrees.length > 0 && (
                  <div className="worktree-section">
                    <div className="worktree-header">
                      <Layers className="worktree-header-icon" aria-hidden />
                      Worktrees
                    </div>
                    <div className="worktree-list">
                      {worktrees.map((worktree) => {
                        const worktreeThreads =
                          threadsByWorkspace[worktree.id] ?? [];
                        const worktreeCollapsed =
                          worktree.settings.sidebarCollapsed;
                        const showWorktreeThreads =
                          !worktreeCollapsed && worktreeThreads.length > 0;
                        const isLoadingWorktreeThreads =
                          threadListLoadingByWorkspace[worktree.id] ?? false;
                        const showWorktreeLoader =
                          !worktreeCollapsed &&
                          isLoadingWorktreeThreads &&
                          worktreeThreads.length === 0;
                        const worktreeBranch = worktree.worktree?.branch ?? "";

                        return (
                          <div key={worktree.id} className="worktree-card">
                            <div
                              className={`worktree-row ${
                                worktree.id === activeWorkspaceId ? "active" : ""
                              }`}
                              role="button"
                              tabIndex={0}
                              onClick={() => onSelectWorkspace(worktree.id)}
                              onContextMenu={(event) =>
                                showWorktreeMenu(event, worktree.id)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  onSelectWorkspace(worktree.id);
                                }
                              }}
                            >
                              <div className="worktree-label">
                                {worktreeBranch || worktree.name}
                              </div>
                              <div className="worktree-actions">
                                <button
                                  className={`worktree-toggle ${
                                    worktreeCollapsed ? "" : "expanded"
                                  }`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onToggleWorkspaceCollapse(
                                      worktree.id,
                                      !worktreeCollapsed,
                                    );
                                  }}
                                  data-tauri-drag-region="false"
                                  aria-label={
                                    worktreeCollapsed ? "Show agents" : "Hide agents"
                                  }
                                  aria-expanded={!worktreeCollapsed}
                                >
                                  <span className="worktree-toggle-icon">›</span>
                                </button>
                                {!worktree.connected && (
                                  <span
                                    className="connect"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onConnectWorkspace(worktree);
                                    }}
                                  >
                                    connect
                                  </span>
                                )}
                              </div>
                            </div>
                            {showWorktreeThreads && (
                              <div className="thread-list thread-list-nested">
                                {(expandedWorkspaces.has(worktree.id)
                                  ? worktreeThreads
                                  : worktreeThreads.slice(0, 3)
                                ).map((thread) => (
                                  <div
                                    key={thread.id}
                                    className={`thread-row ${
                                      worktree.id === activeWorkspaceId &&
                                      thread.id === activeThreadId
                                        ? "active"
                                        : ""
                                    }`}
                                    onClick={() =>
                                      onSelectThread(worktree.id, thread.id)
                                    }
                                    onContextMenu={(event) =>
                                      showThreadMenu(event, worktree.id, thread.id)
                                    }
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(event) => {
                                      if (
                                        event.key === "Enter" ||
                                        event.key === " "
                                      ) {
                                        event.preventDefault();
                                        onSelectThread(worktree.id, thread.id);
                                      }
                                    }}
                                  >
                                    <span
                                      className={`thread-status ${
                                        threadStatusById[thread.id]?.isReviewing
                                          ? "reviewing"
                                          : threadStatusById[thread.id]?.isProcessing
                                            ? "processing"
                                            : threadStatusById[thread.id]?.hasUnread
                                              ? "unread"
                                              : "ready"
                                      }`}
                                      aria-hidden
                                    />
                                    <span className="thread-name">{thread.name}</span>
                                    <div className="thread-menu">
                                      <button
                                        className="thread-menu-trigger"
                                        aria-label="Thread menu"
                                        onMouseDown={(event) =>
                                          event.stopPropagation()
                                        }
                                        onClick={(event) =>
                                          showThreadMenu(
                                            event,
                                            worktree.id,
                                            thread.id,
                                          )
                                        }
                                      >
                                        ...
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                {worktreeThreads.length > 3 && (
                                  <button
                                    className="thread-more"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setExpandedWorkspaces((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(worktree.id)) {
                                          next.delete(worktree.id);
                                        } else {
                                          next.add(worktree.id);
                                        }
                                        return next;
                                      });
                                    }}
                                  >
                                    {expandedWorkspaces.has(worktree.id)
                                      ? "Show less"
                                      : `${worktreeThreads.length - 3} more...`}
                                  </button>
                                )}
                              </div>
                            )}
                            {showWorktreeLoader && (
                              <div
                                className="thread-loading thread-loading-nested"
                                aria-label="Loading agents"
                              >
                                <span className="thread-skeleton thread-skeleton-wide" />
                                <span className="thread-skeleton" />
                                <span className="thread-skeleton thread-skeleton-short" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {showThreads && (
                  <div className="thread-list">
                    {(expandedWorkspaces.has(entry.id)
                      ? threads
                      : threads.slice(0, 3)
                    ).map((thread) => (
                      <div
                        key={thread.id}
                        className={`thread-row ${
                          entry.id === activeWorkspaceId &&
                          thread.id === activeThreadId
                            ? "active"
                            : ""
                        }`}
                        onClick={() => onSelectThread(entry.id, thread.id)}
                        onContextMenu={(event) =>
                          showThreadMenu(event, entry.id, thread.id)
                        }
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelectThread(entry.id, thread.id);
                          }
                        }}
                      >
                        <span
                          className={`thread-status ${
                            threadStatusById[thread.id]?.isReviewing
                              ? "reviewing"
                              : threadStatusById[thread.id]?.isProcessing
                                ? "processing"
                                : threadStatusById[thread.id]?.hasUnread
                                  ? "unread"
                                  : "ready"
                          }`}
                          aria-hidden
                        />
                        <span className="thread-name">{thread.name}</span>
                        <div className="thread-menu">
                          <button
                            className="thread-menu-trigger"
                            aria-label="Thread menu"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) =>
                              showThreadMenu(event, entry.id, thread.id)
                            }
                          >
                            ...
                          </button>
                        </div>
                      </div>
                    ))}
                    {threads.length > 3 && (
                      <button
                        className="thread-more"
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpandedWorkspaces((prev) => {
                            const next = new Set(prev);
                            if (next.has(entry.id)) {
                              next.delete(entry.id);
                            } else {
                              next.add(entry.id);
                            }
                            return next;
                          });
                        }}
                      >
                        {expandedWorkspaces.has(entry.id)
                          ? "Show less"
                          : `${threads.length - 3} more...`}
                      </button>
                    )}
                  </div>
                )}
                {showThreadLoader && (
                  <div className="thread-loading" aria-label="Loading agents">
                    <span className="thread-skeleton thread-skeleton-wide" />
                    <span className="thread-skeleton" />
                    <span className="thread-skeleton thread-skeleton-short" />
                  </div>
                )}
              </div>
            );
          })}
          {!rootWorkspaces.length && (
            <div className="empty">Add a workspace to start.</div>
          )}
        </div>
      </div>
      <div className="sidebar-footer">
        <div className="usage-stack">
          <span className="usage-row">{primaryUsageLabel}</span>
          {accountRateLimits?.secondary && (
            <span className="usage-row">{secondaryUsageLabel}</span>
          )}
        </div>
        {creditsLabel && <div className="usage-meta">{creditsLabel}</div>}
      </div>
    </aside>
  );
}
