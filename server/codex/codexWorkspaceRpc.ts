import type { JsonRecord, RpcErrorShape, StoredWorkspace } from "../types.js";

export type WorkspaceRpcContext = {
  listWorkspaces: () => StoredWorkspace[];
  isWorkspaceConnected: (workspaceId: string) => boolean;
  directoryExists: (targetPath: string) => Promise<boolean>;
  addWorkspaceFromPath: (
    targetPath: string,
  ) => Promise<(StoredWorkspace & { connected: boolean }) | RpcErrorShape>;
  handleWorkspaceGitRpc: (
    method: string,
    params: JsonRecord,
  ) => Promise<unknown | RpcErrorShape | undefined>;
  addCloneWorkspace: (
    sourceWorkspaceId: string,
    copiesFolder: string,
    copyName: string,
  ) => Promise<unknown | RpcErrorShape>;
  connectWorkspace: (workspaceId: string) => unknown | RpcErrorShape;
  updateWorkspaceSettingsRecord: (
    workspaceId: string,
    settings: JsonRecord,
  ) => Promise<unknown | RpcErrorShape>;
  removeWorkspaceCascade: (workspaceId: string) => Promise<unknown | RpcErrorShape>;
  openWorkspaceIn: (targetPath: string) => unknown | RpcErrorShape;
  setWorkspaceRuntimeCodexArgs: (params: JsonRecord) => Promise<unknown | RpcErrorShape>;
};

export async function handleWorkspaceRpc(
  context: WorkspaceRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  switch (method) {
    case "list_workspaces":
      return context.listWorkspaces().map((workspace) => ({
        ...workspace,
        connected: context.isWorkspaceConnected(workspace.id),
      }));
    case "is_workspace_path_dir": {
      const targetPath = String(params.path ?? "");
      if (!targetPath) {
        return false;
      }
      return await context.directoryExists(targetPath);
    }
    case "add_workspace": {
      const targetPath = String(params.path ?? "");
      return await context.addWorkspaceFromPath(targetPath);
    }
    case "add_workspace_from_git_url":
    case "add_worktree":
    case "rename_worktree":
    case "rename_worktree_upstream":
    case "apply_worktree_changes":
    case "worktree_setup_status":
    case "worktree_setup_mark_ran":
      return await context.handleWorkspaceGitRpc(method, params);
    case "add_clone":
      return await context.addCloneWorkspace(
        String(params.sourceWorkspaceId ?? ""),
        String(params.copiesFolder ?? ""),
        String(params.copyName ?? ""),
      );
    case "connect_workspace":
      return context.connectWorkspace(String(params.id ?? ""));
    case "update_workspace_settings": {
      const workspaceId = String(params.id ?? "");
      const settings =
        params.settings && typeof params.settings === "object"
          ? (params.settings as JsonRecord)
          : {};
      return await context.updateWorkspaceSettingsRecord(workspaceId, settings);
    }
    case "remove_workspace":
    case "remove_worktree":
      return await context.removeWorkspaceCascade(String(params.id ?? ""));
    case "open_workspace_in":
      return context.openWorkspaceIn(String(params.path ?? ""));
    case "get_open_app_icon":
      return null;
    case "set_workspace_runtime_codex_args":
      return await context.setWorkspaceRuntimeCodexArgs(params);
    default:
      return undefined;
  }
}
