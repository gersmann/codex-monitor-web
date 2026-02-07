mod core;

use std::io::ErrorKind;

use tauri::State;

use crate::daemon_binary::resolve_daemon_binary_path;
use crate::shared::process_core::tokio_command;
use crate::state::AppState;
use crate::types::{TailscaleDaemonCommandPreview, TailscaleStatus};

use self::core as tailscale_core;

#[cfg(any(target_os = "android", target_os = "ios"))]
const UNSUPPORTED_MESSAGE: &str = "Tailscale integration is only available on desktop.";

fn trim_to_non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
}

#[tauri::command]
pub(crate) async fn tailscale_status() -> Result<TailscaleStatus, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return Ok(tailscale_core::unavailable_status(
            None,
            UNSUPPORTED_MESSAGE.to_string(),
        ));
    }

    let version_output = tokio_command("tailscale").arg("version").output().await;
    let version_output = match version_output {
        Ok(output) => output,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(tailscale_core::unavailable_status(
                None,
                "Tailscale CLI not found on PATH.".to_string(),
            ));
        }
        Err(err) => {
            return Err(format!("Failed to run tailscale version: {err}"));
        }
    };

    let version = trim_to_non_empty(std::str::from_utf8(&version_output.stdout).ok())
        .and_then(|raw| raw.lines().next().map(str::trim).map(str::to_string));

    let status_output = tokio_command("tailscale")
        .arg("status")
        .arg("--json")
        .output()
        .await
        .map_err(|err| format!("Failed to run tailscale status --json: {err}"))?;

    if !status_output.status.success() {
        let stderr_text = trim_to_non_empty(std::str::from_utf8(&status_output.stderr).ok())
            .unwrap_or_else(|| "tailscale status returned a non-zero exit code.".to_string());
        return Ok(TailscaleStatus {
            installed: true,
            running: false,
            version,
            dns_name: None,
            host_name: None,
            tailnet_name: None,
            ipv4: Vec::new(),
            ipv6: Vec::new(),
            suggested_remote_host: None,
            message: stderr_text,
        });
    }

    let payload = std::str::from_utf8(&status_output.stdout)
        .map_err(|err| format!("Invalid UTF-8 from tailscale status: {err}"))?;
    tailscale_core::status_from_json(version, payload)
}

#[tauri::command]
pub(crate) async fn tailscale_daemon_command_preview(
    state: State<'_, AppState>,
) -> Result<TailscaleDaemonCommandPreview, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return Err(UNSUPPORTED_MESSAGE.to_string());
    }

    let daemon_path = resolve_daemon_binary_path()?;
    let data_dir = state
        .settings_path
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| "Unable to resolve app data directory".to_string())?;
    let settings = state.app_settings.lock().await.clone();
    let token_configured = settings
        .remote_backend_token
        .as_deref()
        .map(str::trim)
        .map(|value| !value.is_empty())
        .unwrap_or(false);

    Ok(tailscale_core::daemon_command_preview(
        &daemon_path,
        &data_dir,
        token_configured,
    ))
}
