import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { WorkspaceInfo } from "../types";
import type { GitFileStatus } from "../types";

export async function pickWorkspacePath(): Promise<string | null> {
  const selection = await open({ directory: true, multiple: false });
  if (!selection || Array.isArray(selection)) {
    return null;
  }
  return selection;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return invoke<WorkspaceInfo[]>("list_workspaces");
}

export async function addWorkspace(
  path: string,
  codex_bin: string | null,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("add_workspace", { path, codex_bin });
}

export async function connectWorkspace(id: string): Promise<void> {
  return invoke("connect_workspace", { id });
}

export async function startThread(workspace_id: string) {
  return invoke<any>("start_thread", { workspace_id });
}

export async function sendUserMessage(
  workspace_id: string,
  thread_id: string,
  text: string,
) {
  return invoke("send_user_message", { workspace_id, thread_id, text });
}

export async function respondToServerRequest(
  workspace_id: string,
  request_id: number,
  decision: "accept" | "decline",
) {
  return invoke("respond_to_server_request", {
    workspace_id,
    request_id,
    result: { decision },
  });
}

export async function getGitStatus(workspace_id: string): Promise<{
  branchName: string;
  files: GitFileStatus[];
  totalAdditions: number;
  totalDeletions: number;
}> {
  return invoke("get_git_status", { workspaceId: workspace_id });
}
