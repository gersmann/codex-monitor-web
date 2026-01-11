import type { WorkspaceInfo } from "../types";

type MainHeaderProps = {
  workspace: WorkspaceInfo;
  branchName: string;
};

export function MainHeader({ workspace, branchName }: MainHeaderProps) {
  return (
    <header className="main-header" data-tauri-drag-region>
      <div className="workspace-header">
        <div className="branch-pill">{branchName}</div>
        <div>
          <div className="workspace-title">{workspace.name}</div>
          <div className="workspace-meta">{workspace.path}</div>
        </div>
      </div>
    </header>
  );
}
