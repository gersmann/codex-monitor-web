use tauri::State;

use crate::shared::local_usage_core;
use crate::state::AppState;
use crate::types::LocalUsageSnapshot;

#[tauri::command]
pub(crate) async fn local_usage_snapshot(
    days: Option<u32>,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<LocalUsageSnapshot, String> {
    local_usage_core::local_usage_snapshot_core(&state.workspaces, days, workspace_path).await
}
