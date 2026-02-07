mod core;

use std::ffi::{OsStr, OsString};
use std::io::ErrorKind;
use std::process::Output;

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

fn tailscale_binary_candidates() -> Vec<OsString> {
    let mut candidates = vec![OsString::from("tailscale")];

    #[cfg(target_os = "macos")]
    {
        candidates.push(OsString::from(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ));
        candidates.push(OsString::from("/opt/homebrew/bin/tailscale"));
        candidates.push(OsString::from("/usr/local/bin/tailscale"));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(OsString::from("/usr/bin/tailscale"));
        candidates.push(OsString::from("/usr/sbin/tailscale"));
        candidates.push(OsString::from("/snap/bin/tailscale"));
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push(OsString::from(
            "C:\\Program Files\\Tailscale\\tailscale.exe",
        ));
        candidates.push(OsString::from(
            "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
        ));
    }

    candidates
}

fn missing_tailscale_message() -> String {
    #[cfg(target_os = "macos")]
    {
        return "Tailscale CLI not found on PATH or standard install paths (including /Applications/Tailscale.app/Contents/MacOS/Tailscale).".to_string();
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Tailscale CLI not found on PATH or standard install paths.".to_string()
    }
}

async fn resolve_tailscale_binary() -> Result<Option<(OsString, Output)>, String> {
    let mut failures: Vec<String> = Vec::new();
    for binary in tailscale_binary_candidates() {
        let output = tokio_command(&binary).arg("version").output().await;
        match output {
            Ok(version_output) => return Ok(Some((binary, version_output))),
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => failures.push(format!("{}: {err}", OsStr::new(&binary).to_string_lossy())),
        }
    }

    if failures.is_empty() {
        Ok(None)
    } else {
        Err(format!(
            "Failed to run tailscale version from candidate paths: {}",
            failures.join(" | ")
        ))
    }
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

    let Some((tailscale_binary, version_output)) = resolve_tailscale_binary().await? else {
        return Ok(tailscale_core::unavailable_status(
            None,
            missing_tailscale_message(),
        ));
    };

    let version = trim_to_non_empty(std::str::from_utf8(&version_output.stdout).ok())
        .and_then(|raw| raw.lines().next().map(str::trim).map(str::to_string));

    let status_output = tokio_command(&tailscale_binary)
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

#[cfg(test)]
mod tests {
    use super::tailscale_binary_candidates;

    #[test]
    fn includes_path_candidate() {
        let candidates = tailscale_binary_candidates();
        assert!(!candidates.is_empty());
        assert_eq!(candidates[0].to_string_lossy(), "tailscale");

        #[cfg(target_os = "macos")]
        {
            assert!(candidates.iter().any(|candidate| {
                candidate.to_string_lossy()
                    == "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
            }));
        }
    }
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
