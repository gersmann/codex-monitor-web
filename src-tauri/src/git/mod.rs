use tauri::State;

use crate::shared::git_ui_core;
use crate::state::AppState;
use crate::types::{
    GitCommitDiff, GitFileDiff, GitHubIssuesResponse, GitHubPullRequestComment,
    GitHubPullRequestDiff, GitHubPullRequestsResponse, GitLogResponse,
};

#[tauri::command]
pub(crate) async fn get_git_status(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    git_ui_core::get_git_status_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn stage_git_file(
    workspace_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::stage_git_file_core(&state.workspaces, workspace_id, path).await
}

#[tauri::command]
pub(crate) async fn stage_git_all(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::stage_git_all_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn unstage_git_file(
    workspace_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::unstage_git_file_core(&state.workspaces, workspace_id, path).await
}

#[tauri::command]
pub(crate) async fn revert_git_file(
    workspace_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::revert_git_file_core(&state.workspaces, workspace_id, path).await
}

#[tauri::command]
pub(crate) async fn revert_git_all(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::revert_git_all_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn commit_git(
    workspace_id: String,
    message: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::commit_git_core(&state.workspaces, workspace_id, message).await
}

#[tauri::command]
pub(crate) async fn push_git(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::push_git_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn pull_git(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::pull_git_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn fetch_git(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::fetch_git_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn sync_git(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::sync_git_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn list_git_roots(
    workspace_id: String,
    depth: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    git_ui_core::list_git_roots_core(&state.workspaces, workspace_id, depth).await
}

/// Helper function to get the combined diff for a workspace (used by commit message generation)
pub(crate) async fn get_workspace_diff(
    workspace_id: &str,
    state: &State<'_, AppState>,
) -> Result<String, String> {
    let repo_root = git_ui_core::resolve_repo_root_for_workspace_core(
        &state.workspaces,
        workspace_id.to_string(),
    )
    .await?;
    git_ui_core::collect_workspace_diff_core(&repo_root)
}

#[tauri::command]
pub(crate) async fn get_git_diffs(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<GitFileDiff>, String> {
    git_ui_core::get_git_diffs_core(&state.workspaces, &state.app_settings, workspace_id).await
}

#[tauri::command]
pub(crate) async fn get_git_log(
    workspace_id: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<GitLogResponse, String> {
    git_ui_core::get_git_log_core(&state.workspaces, workspace_id, limit).await
}

#[tauri::command]
pub(crate) async fn get_git_commit_diff(
    workspace_id: String,
    sha: String,
    state: State<'_, AppState>,
) -> Result<Vec<GitCommitDiff>, String> {
    git_ui_core::get_git_commit_diff_core(&state.workspaces, &state.app_settings, workspace_id, sha)
        .await
}

#[tauri::command]
pub(crate) async fn get_git_remote(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    git_ui_core::get_git_remote_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn get_github_issues(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<GitHubIssuesResponse, String> {
    git_ui_core::get_github_issues_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn get_github_pull_requests(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<GitHubPullRequestsResponse, String> {
    git_ui_core::get_github_pull_requests_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn get_github_pull_request_diff(
    workspace_id: String,
    pr_number: u64,
    state: State<'_, AppState>,
) -> Result<Vec<GitHubPullRequestDiff>, String> {
    git_ui_core::get_github_pull_request_diff_core(&state.workspaces, workspace_id, pr_number).await
}

#[tauri::command]
pub(crate) async fn get_github_pull_request_comments(
    workspace_id: String,
    pr_number: u64,
    state: State<'_, AppState>,
) -> Result<Vec<GitHubPullRequestComment>, String> {
    git_ui_core::get_github_pull_request_comments_core(&state.workspaces, workspace_id, pr_number)
        .await
}

#[tauri::command]
pub(crate) async fn list_git_branches(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    git_ui_core::list_git_branches_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn checkout_git_branch(
    workspace_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::checkout_git_branch_core(&state.workspaces, workspace_id, name).await
}

#[tauri::command]
pub(crate) async fn create_git_branch(
    workspace_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git_ui_core::create_git_branch_core(&state.workspaces, workspace_id, name).await
}
