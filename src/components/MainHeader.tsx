import { useEffect, useRef, useState } from "react";
import type { BranchInfo, WorkspaceInfo } from "../types";

type MainHeaderProps = {
  workspace: WorkspaceInfo;
  branchName: string;
  branches: BranchInfo[];
  onCheckoutBranch: (name: string) => Promise<void> | void;
  onCreateBranch: (name: string) => Promise<void> | void;
};

export function MainHeader({
  workspace,
  branchName,
  branches,
  onCheckoutBranch,
  onCreateBranch,
}: MainHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const recentBranches = branches.slice(0, 12);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleClick = (event: MouseEvent) => {
      if (!menuRef.current) {
        return;
      }
      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setIsCreating(false);
        setNewBranch("");
        setError(null);
      }
    };
    window.addEventListener("mousedown", handleClick);
    return () => {
      window.removeEventListener("mousedown", handleClick);
    };
  }, [menuOpen]);

  return (
    <header className="main-header" data-tauri-drag-region>
      <div className="workspace-header">
        <div className="workspace-title-line">
          <span className="workspace-title">{workspace.name}</span>
          <span className="workspace-separator" aria-hidden>
            ›
          </span>
          <div className="workspace-branch-menu" ref={menuRef}>
            <button
              type="button"
              className="workspace-branch-button"
              onClick={() => setMenuOpen((prev) => !prev)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-tauri-drag-region="false"
            >
              <span className="workspace-branch">{branchName}</span>
              <span className="workspace-branch-caret" aria-hidden>
                ›
              </span>
            </button>
            {menuOpen && (
              <div
                className="workspace-branch-dropdown"
                role="menu"
                data-tauri-drag-region="false"
              >
                <div className="branch-actions">
                  {!isCreating ? (
                    <button
                      type="button"
                      className="branch-action"
                      onClick={() => setIsCreating(true)}
                      data-tauri-drag-region="false"
                    >
                      <span className="branch-action-icon">+</span>
                      Create branch
                    </button>
                  ) : (
                    <div className="branch-create">
                      <input
                        value={newBranch}
                        onChange={(event) => setNewBranch(event.target.value)}
                        placeholder="new-branch-name"
                        className="branch-input"
                        autoFocus
                        data-tauri-drag-region="false"
                      />
                      <button
                        type="button"
                        className="branch-create-button"
                        onClick={async () => {
                          const name = newBranch.trim();
                          if (!name) {
                            return;
                          }
                          try {
                            await onCreateBranch(name);
                            setMenuOpen(false);
                            setIsCreating(false);
                            setNewBranch("");
                            setError(null);
                          } catch (err) {
                            setError(
                              err instanceof Error ? err.message : String(err),
                            );
                          }
                        }}
                        data-tauri-drag-region="false"
                      >
                        Create + checkout
                      </button>
                    </div>
                  )}
                </div>
                <div className="branch-list" role="none">
                  {recentBranches.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      className={`branch-item${
                        branch.name === branchName ? " is-active" : ""
                      }`}
                      onClick={async () => {
                        if (branch.name === branchName) {
                          return;
                        }
                        try {
                          await onCheckoutBranch(branch.name);
                          setMenuOpen(false);
                          setIsCreating(false);
                          setNewBranch("");
                          setError(null);
                        } catch (err) {
                          setError(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      }}
                      role="menuitem"
                      data-tauri-drag-region="false"
                    >
                      {branch.name}
                    </button>
                  ))}
                  {recentBranches.length === 0 && (
                    <div className="branch-empty">No branches found</div>
                  )}
                </div>
                {error && <div className="branch-error">{error}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
