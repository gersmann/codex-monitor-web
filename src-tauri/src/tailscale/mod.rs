mod core;

use std::ffi::{OsStr, OsString};
use std::io::ErrorKind;
use std::process::Output;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout};

use crate::daemon_binary::resolve_daemon_binary_path;
use crate::shared::process_core::{kill_child_process_tree, tokio_command};
use crate::state::{AppState, TcpDaemonRuntime};
use crate::types::{
    TailscaleDaemonCommandPreview, TailscaleStatus, TcpDaemonState, TcpDaemonStatus,
};

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

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_port_from_remote_host(remote_host: &str) -> Option<u16> {
    if remote_host.trim().is_empty() {
        return None;
    }
    if let Ok(addr) = remote_host.trim().parse::<std::net::SocketAddr>() {
        return Some(addr.port());
    }
    remote_host
        .trim()
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
}

fn daemon_listen_addr(remote_host: &str) -> String {
    let port = parse_port_from_remote_host(remote_host).unwrap_or(4732);
    format!("0.0.0.0:{port}")
}

fn daemon_connect_addr(listen_addr: &str) -> Option<String> {
    let port = parse_port_from_remote_host(listen_addr)?;
    Some(format!("127.0.0.1:{port}"))
}

fn configured_daemon_listen_addr(settings: &crate::types::AppSettings) -> String {
    daemon_listen_addr(&settings.remote_backend_host)
}

fn sync_tcp_daemon_listen_addr(status: &mut TcpDaemonStatus, configured_listen_addr: &str) {
    if matches!(status.state, TcpDaemonState::Running) && status.listen_addr.is_some() {
        return;
    }
    status.listen_addr = Some(configured_listen_addr.to_string());
}

async fn ensure_listen_addr_available(listen_addr: &str) -> Result<(), String> {
    match tokio::net::TcpListener::bind(listen_addr).await {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(err) => Err(format!(
            "Cannot start mobile access daemon because {listen_addr} is unavailable: {err}"
        )),
    }
}

async fn refresh_tcp_daemon_runtime(runtime: &mut TcpDaemonRuntime) {
    let Some(child) = runtime.child.as_mut() else {
        runtime.status.state = TcpDaemonState::Stopped;
        runtime.status.pid = None;
        return;
    };

    match child.try_wait() {
        Ok(Some(status)) => {
            let pid = child.id();
            runtime.child = None;
            if status.success() {
                runtime.status = TcpDaemonStatus {
                    state: TcpDaemonState::Stopped,
                    pid,
                    started_at_ms: None,
                    last_error: None,
                    listen_addr: runtime.status.listen_addr.clone(),
                };
            } else {
                let failure_hint = if status.code() == Some(101) {
                    " This usually indicates a startup panic (often due to an unavailable listen port)."
                } else {
                    ""
                };
                runtime.status = TcpDaemonStatus {
                    state: TcpDaemonState::Error,
                    pid,
                    started_at_ms: runtime.status.started_at_ms,
                    last_error: Some(format!(
                        "Daemon exited with status: {status}.{failure_hint}"
                    )),
                    listen_addr: runtime.status.listen_addr.clone(),
                };
            }
        }
        Ok(None) => {
            runtime.status.state = TcpDaemonState::Running;
            runtime.status.pid = child.id();
            runtime.status.last_error = None;
        }
        Err(err) => {
            runtime.status = TcpDaemonStatus {
                state: TcpDaemonState::Error,
                pid: child.id(),
                started_at_ms: runtime.status.started_at_ms,
                last_error: Some(format!("Failed to inspect daemon process: {err}")),
                listen_addr: runtime.status.listen_addr.clone(),
            };
        }
    }
}

const DAEMON_RPC_TIMEOUT: Duration = Duration::from_millis(700);

#[derive(Debug, Clone)]
enum DaemonProbe {
    NotReachable,
    Running {
        auth_ok: bool,
        auth_error: Option<String>,
    },
    NotDaemon,
}

type DaemonLines = tokio::io::Lines<BufReader<OwnedReadHalf>>;

fn parse_daemon_error_message(response: &Value) -> Option<String> {
    response
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn is_auth_error_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("unauthorized") || lower.contains("invalid token")
}

async fn send_rpc_request(
    writer: &mut OwnedWriteHalf,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let mut payload = serde_json::to_string(&json!({
        "id": id,
        "method": method,
        "params": params,
    }))
    .map_err(|err| err.to_string())?;
    payload.push('\n');
    writer
        .write_all(payload.as_bytes())
        .await
        .map_err(|err| err.to_string())
}

async fn read_rpc_response(lines: &mut DaemonLines, expected_id: u64) -> Result<Value, String> {
    for _ in 0..12 {
        let line = match timeout(DAEMON_RPC_TIMEOUT, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => return Err("connection closed".to_string()),
            Ok(Err(err)) => return Err(err.to_string()),
            Err(_) => return Err("timed out waiting for daemon response".to_string()),
        };
        if line.trim().is_empty() {
            continue;
        }
        let parsed: Value = serde_json::from_str(&line).map_err(|err| err.to_string())?;
        let id = parsed.get("id").and_then(Value::as_u64);
        if id == Some(expected_id) {
            return Ok(parsed);
        }
    }
    Err("did not receive expected daemon response".to_string())
}

async fn send_and_expect_result(
    writer: &mut OwnedWriteHalf,
    lines: &mut DaemonLines,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    send_rpc_request(writer, id, method, params).await?;
    let response = read_rpc_response(lines, id).await?;
    if let Some(message) = parse_daemon_error_message(&response) {
        return Err(message);
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "daemon response missing result".to_string())
}

async fn probe_daemon(listen_addr: &str, token: Option<&str>) -> DaemonProbe {
    let Some(connect_addr) = daemon_connect_addr(listen_addr) else {
        return DaemonProbe::NotReachable;
    };

    let stream = match timeout(DAEMON_RPC_TIMEOUT, TcpStream::connect(&connect_addr)).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(_)) | Err(_) => return DaemonProbe::NotReachable,
    };

    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    match send_and_expect_result(&mut writer, &mut lines, 1, "ping", json!({})).await {
        Ok(_) => DaemonProbe::Running {
            auth_ok: true,
            auth_error: None,
        },
        Err(message) => {
            if !is_auth_error_message(&message) {
                return DaemonProbe::NotDaemon;
            }

            let trimmed_token = token.map(str::trim).filter(|value| !value.is_empty());
            let Some(auth_token) = trimmed_token else {
                return DaemonProbe::Running {
                    auth_ok: false,
                    auth_error: Some(
                        "Daemon is running but requires a remote backend token.".to_string(),
                    ),
                };
            };

            match send_and_expect_result(
                &mut writer,
                &mut lines,
                2,
                "auth",
                json!({ "token": auth_token }),
            )
            .await
            {
                Ok(_) => {
                    match send_and_expect_result(&mut writer, &mut lines, 3, "ping", json!({}))
                        .await
                    {
                        Ok(_) => DaemonProbe::Running {
                            auth_ok: true,
                            auth_error: None,
                        },
                        Err(ping_error) => DaemonProbe::Running {
                            auth_ok: false,
                            auth_error: Some(format!(
                                "Daemon is running but ping failed after auth: {ping_error}"
                            )),
                        },
                    }
                }
                Err(auth_error) => {
                    if is_auth_error_message(&auth_error) {
                        DaemonProbe::Running {
                            auth_ok: false,
                            auth_error: Some(format!(
                                "Daemon is running but token authentication failed: {auth_error}"
                            )),
                        }
                    } else {
                        DaemonProbe::NotDaemon
                    }
                }
            }
        }
    }
}

async fn request_daemon_shutdown(listen_addr: &str, token: Option<&str>) -> Result<(), String> {
    let Some(connect_addr) = daemon_connect_addr(listen_addr) else {
        return Err("invalid daemon listen address".to_string());
    };

    let stream = timeout(DAEMON_RPC_TIMEOUT, TcpStream::connect(&connect_addr))
        .await
        .map_err(|_| format!("Timed out connecting to daemon at {connect_addr}"))?
        .map_err(|err| format!("Failed to connect to daemon at {connect_addr}: {err}"))?;

    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    match send_and_expect_result(&mut writer, &mut lines, 1, "ping", json!({})).await {
        Ok(_) => {}
        Err(message) if is_auth_error_message(&message) => {
            let auth_token = token
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "Daemon is running but requires a remote backend token.".to_string()
                })?;
            send_and_expect_result(
                &mut writer,
                &mut lines,
                2,
                "auth",
                json!({ "token": auth_token }),
            )
            .await
            .map_err(|err| format!("Daemon authentication failed: {err}"))?;
        }
        Err(message) => {
            return Err(format!("Daemon ping failed: {message}"));
        }
    }

    send_and_expect_result(&mut writer, &mut lines, 3, "daemon_shutdown", json!({}))
        .await
        .map(|_| ())
        .map_err(|err| format!("Daemon shutdown request failed: {err}"))
}

async fn wait_for_daemon_shutdown(listen_addr: &str, token: Option<&str>) -> bool {
    for _ in 0..20 {
        if matches!(
            probe_daemon(listen_addr, token).await,
            DaemonProbe::NotReachable
        ) {
            return true;
        }
        sleep(Duration::from_millis(100)).await;
    }
    false
}

#[cfg(unix)]
fn is_pid_running(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return true;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(code) => code != libc::ESRCH,
        None => false,
    }
}

#[cfg(unix)]
async fn find_listener_pid(port: u16) -> Option<u32> {
    let target = format!(":{port}");
    let output = match tokio_command("lsof")
        .args(["-nP", "-iTCP"])
        .arg(&target)
        .args(["-sTCP:LISTEN", "-t"])
        .output()
        .await
    {
        Ok(output) => output,
        Err(err) if err.kind() == ErrorKind::NotFound => return None,
        Err(_) => return None,
    };

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.code() == Some(1) && stdout.trim().is_empty() && stderr.trim().is_empty() {
            return None;
        }
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|line| line.trim().parse::<u32>().ok())
}

#[cfg(unix)]
async fn kill_pid_gracefully(pid: u32) -> Result<(), String> {
    let term_result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    if term_result != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::ESRCH) {
            return Err(format!("Failed to stop daemon process {pid}: {err}"));
        }
        return Ok(());
    }

    for _ in 0..12 {
        if !is_pid_running(pid) {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }

    let kill_result = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    if kill_result != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::ESRCH) {
            return Err(format!("Failed to force-stop daemon process {pid}: {err}"));
        }
    }

    for _ in 0..8 {
        if !is_pid_running(pid) {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }

    Err(format!("Daemon process {pid} is still running."))
}

#[cfg(not(unix))]
async fn find_listener_pid(_port: u16) -> Option<u32> {
    None
}

#[cfg(not(unix))]
async fn kill_pid_gracefully(_pid: u32) -> Result<(), String> {
    Err("Stopping external daemon by pid is not supported on this platform.".to_string())
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
    use super::{
        daemon_listen_addr, ensure_listen_addr_available, parse_port_from_remote_host,
        sync_tcp_daemon_listen_addr, tailscale_binary_candidates,
    };
    use crate::types::{TcpDaemonState, TcpDaemonStatus};

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

    #[test]
    fn parses_listen_port_from_host() {
        assert_eq!(
            parse_port_from_remote_host("100.100.100.1:4732"),
            Some(4732)
        );
        assert_eq!(
            parse_port_from_remote_host("[fd7a:115c:a1e0::1]:4545"),
            Some(4545)
        );
        assert_eq!(parse_port_from_remote_host("example.ts.net"), None);
    }

    #[test]
    fn builds_listen_addr_with_fallback_port() {
        assert_eq!(
            daemon_listen_addr("mac.example.ts.net:8888"),
            "0.0.0.0:8888"
        );
        assert_eq!(daemon_listen_addr("mac.example.ts.net"), "0.0.0.0:4732");
    }

    #[test]
    fn syncs_listen_addr_for_stopped_state() {
        let mut status = TcpDaemonStatus {
            state: TcpDaemonState::Stopped,
            pid: None,
            started_at_ms: None,
            last_error: None,
            listen_addr: Some("0.0.0.0:4732".to_string()),
        };

        sync_tcp_daemon_listen_addr(&mut status, "0.0.0.0:7777");
        assert_eq!(status.listen_addr.as_deref(), Some("0.0.0.0:7777"));
    }

    #[test]
    fn keeps_running_listen_addr_when_present() {
        let mut status = TcpDaemonStatus {
            state: TcpDaemonState::Running,
            pid: Some(42),
            started_at_ms: Some(1),
            last_error: None,
            listen_addr: Some("0.0.0.0:4732".to_string()),
        };

        sync_tcp_daemon_listen_addr(&mut status, "0.0.0.0:7777");
        assert_eq!(status.listen_addr.as_deref(), Some("0.0.0.0:4732"));
    }

    #[test]
    fn listen_addr_preflight_fails_when_port_is_in_use() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind ephemeral listener");
            let occupied = listener.local_addr().expect("local addr").to_string();

            let error = ensure_listen_addr_available(&occupied)
                .await
                .expect_err("expected occupied port error");
            assert!(error.contains("unavailable"));
        });
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

#[tauri::command]
pub(crate) async fn tailscale_daemon_start(
    state: State<'_, AppState>,
) -> Result<TcpDaemonStatus, String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Err("Tailscale daemon start is only supported on desktop.".to_string());
    }

    let settings = state.app_settings.lock().await.clone();
    let token = settings
        .remote_backend_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Set a Remote backend token before starting mobile access daemon.".to_string()
        })?;
    let listen_addr = configured_daemon_listen_addr(&settings);
    let listen_port = parse_port_from_remote_host(&listen_addr)
        .ok_or_else(|| format!("Invalid daemon listen address: {listen_addr}"))?;
    let daemon_binary = resolve_daemon_binary_path()?;

    let data_dir = state
        .settings_path
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| "Unable to resolve app data directory".to_string())?;

    let mut runtime = state.tcp_daemon.lock().await;
    refresh_tcp_daemon_runtime(&mut runtime).await;
    if matches!(runtime.status.state, TcpDaemonState::Running) {
        return Ok(runtime.status.clone());
    }

    match probe_daemon(&listen_addr, Some(token)).await {
        DaemonProbe::Running {
            auth_ok,
            auth_error,
        } => {
            let pid = find_listener_pid(listen_port).await;
            runtime.child = None;
            runtime.status = TcpDaemonStatus {
                state: TcpDaemonState::Running,
                pid,
                started_at_ms: runtime.status.started_at_ms,
                last_error: auth_error.clone(),
                listen_addr: Some(listen_addr.clone()),
            };
            if !auth_ok {
                return Err(auth_error.unwrap_or_else(|| {
                    "Daemon is already running but authentication failed.".to_string()
                }));
            }
            return Ok(runtime.status.clone());
        }
        DaemonProbe::NotDaemon => {
            return Err(format!(
                "Cannot start mobile access daemon because {listen_addr} is already in use by another process."
            ));
        }
        DaemonProbe::NotReachable => {}
    }

    ensure_listen_addr_available(&listen_addr).await?;

    let child = tokio_command(&daemon_binary)
        .arg("--listen")
        .arg(&listen_addr)
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--token")
        .arg(token)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|err| format!("Failed to start mobile access daemon: {err}"))?;

    runtime.status = TcpDaemonStatus {
        state: TcpDaemonState::Running,
        pid: child.id(),
        started_at_ms: Some(now_unix_ms()),
        last_error: None,
        listen_addr: Some(listen_addr),
    };
    runtime.child = Some(child);

    Ok(runtime.status.clone())
}

#[tauri::command]
pub(crate) async fn tailscale_daemon_stop(
    state: State<'_, AppState>,
) -> Result<TcpDaemonStatus, String> {
    let settings = state.app_settings.lock().await.clone();
    let configured_listen_addr = configured_daemon_listen_addr(&settings);
    let listen_port = parse_port_from_remote_host(&configured_listen_addr);

    let mut runtime = state.tcp_daemon.lock().await;
    let mut stop_error: Option<String> = None;
    if let Some(mut child) = runtime.child.take() {
        kill_child_process_tree(&mut child).await;
        let _ = child.wait().await;
    } else if let Some(port) = listen_port {
        match probe_daemon(
            &configured_listen_addr,
            settings.remote_backend_token.as_deref(),
        )
        .await
        {
            DaemonProbe::Running { .. } => {
                if let Err(shutdown_error) = request_daemon_shutdown(
                    &configured_listen_addr,
                    settings.remote_backend_token.as_deref(),
                )
                .await
                {
                    let pid = find_listener_pid(port).await;
                    if let Some(pid) = pid {
                        if let Err(err) = kill_pid_gracefully(pid).await {
                            stop_error = Some(format!("{shutdown_error}; {err}"));
                        } else {
                            stop_error = None;
                        }
                    } else {
                        stop_error = Some(shutdown_error);
                    }
                } else if !wait_for_daemon_shutdown(
                    &configured_listen_addr,
                    settings.remote_backend_token.as_deref(),
                )
                .await
                {
                    stop_error =
                        Some("Daemon acknowledged shutdown but is still reachable.".to_string());
                }
            }
            DaemonProbe::NotDaemon => {
                stop_error = Some(format!(
                    "Port {port} is in use by a non-daemon process; refusing to stop it."
                ));
            }
            DaemonProbe::NotReachable => {}
        }
    }

    let probe_after_stop = probe_daemon(
        &configured_listen_addr,
        settings.remote_backend_token.as_deref(),
    )
    .await;
    let pid_after_stop = match listen_port {
        Some(port) => find_listener_pid(port).await,
        None => None,
    };
    runtime.status = match probe_after_stop {
        DaemonProbe::Running { auth_error, .. } => TcpDaemonStatus {
            state: TcpDaemonState::Error,
            pid: pid_after_stop,
            started_at_ms: runtime.status.started_at_ms,
            last_error: Some(
                stop_error
                    .or(auth_error)
                    .unwrap_or_else(|| "Daemon is still running after stop attempt.".to_string()),
            ),
            listen_addr: runtime.status.listen_addr.clone(),
        },
        DaemonProbe::NotDaemon => TcpDaemonStatus {
            state: TcpDaemonState::Error,
            pid: pid_after_stop,
            started_at_ms: runtime.status.started_at_ms,
            last_error: Some(stop_error.unwrap_or_else(|| {
                "Configured port is now occupied by a non-daemon process.".to_string()
            })),
            listen_addr: runtime.status.listen_addr.clone(),
        },
        DaemonProbe::NotReachable => TcpDaemonStatus {
            state: TcpDaemonState::Stopped,
            pid: None,
            started_at_ms: None,
            last_error: stop_error,
            listen_addr: runtime.status.listen_addr.clone(),
        },
    };
    sync_tcp_daemon_listen_addr(&mut runtime.status, &configured_listen_addr);

    Ok(runtime.status.clone())
}

#[tauri::command]
pub(crate) async fn tailscale_daemon_status(
    state: State<'_, AppState>,
) -> Result<TcpDaemonStatus, String> {
    let settings = state.app_settings.lock().await.clone();
    let configured_listen_addr = configured_daemon_listen_addr(&settings);
    let listen_port = parse_port_from_remote_host(&configured_listen_addr);

    let mut runtime = state.tcp_daemon.lock().await;
    refresh_tcp_daemon_runtime(&mut runtime).await;

    if !matches!(runtime.status.state, TcpDaemonState::Running) {
        let pid = match listen_port {
            Some(port) => find_listener_pid(port).await,
            None => None,
        };
        runtime.status = match probe_daemon(
            &configured_listen_addr,
            settings.remote_backend_token.as_deref(),
        )
        .await
        {
            DaemonProbe::Running {
                auth_ok: _,
                auth_error,
            } => TcpDaemonStatus {
                state: TcpDaemonState::Running,
                pid,
                started_at_ms: runtime.status.started_at_ms,
                last_error: auth_error,
                listen_addr: runtime.status.listen_addr.clone(),
            },
            DaemonProbe::NotDaemon => TcpDaemonStatus {
                state: TcpDaemonState::Error,
                pid,
                started_at_ms: runtime.status.started_at_ms,
                last_error: Some(format!(
                    "Configured daemon port {configured_listen_addr} is occupied by a non-daemon process."
                )),
                listen_addr: runtime.status.listen_addr.clone(),
            },
            DaemonProbe::NotReachable => TcpDaemonStatus {
                state: TcpDaemonState::Stopped,
                pid: None,
                started_at_ms: None,
                last_error: None,
                listen_addr: runtime.status.listen_addr.clone(),
            },
        };
    }

    sync_tcp_daemon_listen_addr(&mut runtime.status, &configured_listen_addr);

    Ok(runtime.status.clone())
}
