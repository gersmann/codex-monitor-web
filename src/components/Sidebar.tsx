import type { ThreadSummary, WorkspaceInfo } from "../types";
import { useState } from "react";

type SidebarProps = {
  workspaces: WorkspaceInfo[];
  threadsByWorkspace: Record<string, ThreadSummary[]>;
  threadStatusById: Record<string, { isProcessing: boolean; hasUnread: boolean }>;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  onAddWorkspace: () => void;
  onSelectWorkspace: (id: string) => void;
  onConnectWorkspace: (workspace: WorkspaceInfo) => void;
  onAddAgent: (workspace: WorkspaceInfo) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onDeleteThread: (workspaceId: string, threadId: string) => void;
};

export function Sidebar({
  workspaces,
  threadsByWorkspace,
  threadStatusById,
  activeWorkspaceId,
  activeThreadId,
  onAddWorkspace,
  onSelectWorkspace,
  onConnectWorkspace,
  onAddAgent,
  onSelectThread,
  onDeleteThread,
}: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(
    new Set<string>(),
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div>
          <div className="subtitle">Workspaces</div>
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
      <div className="workspace-list">
        {workspaces.map((entry) => (
          <div key={entry.id} className="workspace-card">
            <div
              className={`workspace-row ${
                entry.id === activeWorkspaceId ? "active" : ""
              }`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectWorkspace(entry.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectWorkspace(entry.id);
                }
              }}
            >
              <div>
                <div className="workspace-name-row">
                  <span className="workspace-name">{entry.name}</span>
                  <button
                    className="ghost workspace-add"
                    onClick={(event) => {
                      event.stopPropagation();
                      onAddAgent(entry);
                    }}
                    data-tauri-drag-region="false"
                    aria-label="Add agent"
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
            {(threadsByWorkspace[entry.id] ?? []).length > 0 && (
              <div className="thread-list">
                {(expandedWorkspaces.has(entry.id)
                  ? threadsByWorkspace[entry.id] ?? []
                  : (threadsByWorkspace[entry.id] ?? []).slice(0, 3)
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
                        threadStatusById[thread.id]?.isProcessing
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
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpen((prev) =>
                            prev === thread.id ? null : thread.id,
                          );
                        }}
                      >
                        ...
                      </button>
                      {menuOpen === thread.id && (
                        <div className="thread-menu-popup">
                          <button
                            className="thread-menu-item"
                            onClick={() => {
                              onDeleteThread(entry.id, thread.id);
                              setMenuOpen(null);
                            }}
                          >
                            Archive
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {(threadsByWorkspace[entry.id] ?? []).length > 3 && (
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
                      : `${(threadsByWorkspace[entry.id] ?? []).length - 3} more...`}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {!workspaces.length && (
          <div className="empty">Add a workspace to start.</div>
        )}
      </div>
    </aside>
  );
}
