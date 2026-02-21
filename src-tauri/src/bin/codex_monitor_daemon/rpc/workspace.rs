use super::*;
use crate::shared::workspace_rpc;
use serde::de::DeserializeOwned;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileReadRequest {
    scope: file_policy::FileScope,
    kind: file_policy::FileKind,
    workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteRequest {
    scope: file_policy::FileScope,
    kind: file_policy::FileKind,
    workspace_id: Option<String>,
    content: String,
}

fn parse_file_read_request(params: &Value) -> Result<FileReadRequest, String> {
    serde_json::from_value(params.clone()).map_err(|err| err.to_string())
}

fn parse_file_write_request(params: &Value) -> Result<FileWriteRequest, String> {
    serde_json::from_value(params.clone()).map_err(|err| err.to_string())
}

fn parse_workspace_request<T: DeserializeOwned>(params: &Value) -> Result<T, String> {
    workspace_rpc::from_params(params)
}

pub(super) async fn try_handle(
    state: &DaemonState,
    method: &str,
    params: &Value,
    client_version: &str,
) -> Option<Result<Value, String>> {
    match method {
        "list_workspaces" => {
            let workspaces = state.list_workspaces().await;
            Some(serde_json::to_value(workspaces).map_err(|err| err.to_string()))
        }
        "is_workspace_path_dir" => {
            let request: workspace_rpc::IsWorkspacePathDirRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            let is_dir = state.is_workspace_path_dir(request.path).await;
            Some(serde_json::to_value(is_dir).map_err(|err| err.to_string()))
        }
        "add_workspace" => {
            let request: workspace_rpc::AddWorkspaceRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let workspace = match state
                .add_workspace(request.path, request.codex_bin, client_version.to_string())
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(workspace).map_err(|err| err.to_string()))
        }
        "add_workspace_from_git_url" => {
            let request: workspace_rpc::AddWorkspaceFromGitUrlRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            let workspace = match state
                .add_workspace_from_git_url(
                    request.url,
                    request.destination_path,
                    request.target_folder_name,
                    request.codex_bin,
                    client_version.to_string(),
                )
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(workspace).map_err(|err| err.to_string()))
        }
        "add_worktree" => {
            let request: workspace_rpc::AddWorktreeRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let workspace = match state
                .add_worktree(
                    request.parent_id,
                    request.branch,
                    request.name,
                    request.copy_agents_md,
                    client_version.to_string(),
                )
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(workspace).map_err(|err| err.to_string()))
        }
        "worktree_setup_status" => {
            let request: workspace_rpc::WorkspaceIdRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let status = match state.worktree_setup_status(request.workspace_id).await {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(status).map_err(|err| err.to_string()))
        }
        "worktree_setup_mark_ran" => {
            let request: workspace_rpc::WorkspaceIdRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .worktree_setup_mark_ran(request.workspace_id)
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "connect_workspace" => {
            let request: workspace_rpc::IdRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .connect_workspace(request.id, client_version.to_string())
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "set_workspace_runtime_codex_args" => {
            let request: workspace_rpc::SetWorkspaceRuntimeCodexArgsRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            Some(
                state
                    .set_workspace_runtime_codex_args(
                        request.workspace_id,
                        request.codex_args,
                        client_version.to_string(),
                    )
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|e| e.to_string())),
            )
        }
        "remove_workspace" => {
            let request: workspace_rpc::IdRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .remove_workspace(request.id)
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "remove_worktree" => {
            let request: workspace_rpc::IdRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .remove_worktree(request.id)
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "rename_worktree" => {
            let request: workspace_rpc::RenameWorktreeRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            let workspace = match state
                .rename_worktree(request.id, request.branch, client_version.to_string())
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(workspace).map_err(|err| err.to_string()))
        }
        "rename_worktree_upstream" => {
            let request: workspace_rpc::RenameWorktreeUpstreamRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            Some(
                state
                    .rename_worktree_upstream(
                        request.id,
                        request.old_branch,
                        request.new_branch,
                    )
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "update_workspace_settings" => {
            let request: workspace_rpc::UpdateWorkspaceSettingsRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            let workspace = match state
                .update_workspace_settings(
                    request.id,
                    request.settings,
                    client_version.to_string(),
                )
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(workspace).map_err(|err| err.to_string()))
        }
        "update_workspace_codex_bin" => {
            let request: workspace_rpc::UpdateWorkspaceCodexBinRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            let workspace = match state
                .update_workspace_codex_bin(request.id, request.codex_bin)
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(workspace).map_err(|err| err.to_string()))
        }
        "list_workspace_files" => {
            let request: workspace_rpc::WorkspaceIdRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let files = match state.list_workspace_files(request.workspace_id).await {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(files).map_err(|err| err.to_string()))
        }
        "read_workspace_file" => {
            let request: workspace_rpc::ReadWorkspaceFileRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            let response = match state
                .read_workspace_file(request.workspace_id, request.path)
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(response).map_err(|err| err.to_string()))
        }
        "add_clone" => {
            let request: workspace_rpc::AddCloneRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let workspace = match state
                .add_clone(
                    request.source_workspace_id,
                    request.copies_folder,
                    request.copy_name,
                    client_version.to_string(),
                )
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(workspace).map_err(|err| err.to_string()))
        }
        "file_read" => {
            let request = match parse_file_read_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let response = match state
                .file_read(request.scope, request.kind, request.workspace_id)
                .await
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(response).map_err(|err| err.to_string()))
        }
        "file_write" => {
            let request = match parse_file_write_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            if let Err(err) = state
                .file_write(
                    request.scope,
                    request.kind,
                    request.workspace_id,
                    request.content,
                )
                .await
            {
                return Some(Err(err));
            }
            Some(serde_json::to_value(json!({ "ok": true })).map_err(|err| err.to_string()))
        }
        "get_app_settings" => {
            let settings = state.get_app_settings().await;
            Some(serde_json::to_value(settings).map_err(|err| err.to_string()))
        }
        "update_app_settings" => {
            let settings_value = match params {
                Value::Object(map) => map.get("settings").cloned().unwrap_or(Value::Null),
                _ => Value::Null,
            };
            let settings: AppSettings = match serde_json::from_value(settings_value) {
                Ok(value) => value,
                Err(err) => return Some(Err(err.to_string())),
            };
            let updated = match state.update_app_settings(settings).await {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(updated).map_err(|err| err.to_string()))
        }
        "apply_worktree_changes" => {
            let request: workspace_rpc::WorkspaceIdRequest = match parse_workspace_request(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .apply_worktree_changes(request.workspace_id)
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "open_workspace_in" => {
            let request: workspace_rpc::OpenWorkspaceInRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            Some(
                state
                    .open_workspace_in(
                        request.path,
                        request.app,
                        request.args,
                        request.command,
                    )
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "get_open_app_icon" => {
            let request: workspace_rpc::GetOpenAppIconRequest =
                match parse_workspace_request(params) {
                    Ok(value) => value,
                    Err(err) => return Some(Err(err)),
                };
            let icon = match state.get_open_app_icon(request.app_name).await {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(icon).map_err(|err| err.to_string()))
        }
        "local_usage_snapshot" => {
            let days = parse_optional_u32(params, "days");
            let workspace_path = parse_optional_string(params, "workspacePath");
            let snapshot = match state.local_usage_snapshot(days, workspace_path).await {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(serde_json::to_value(snapshot).map_err(|err| err.to_string()))
        }
        _ => None,
    }
}
