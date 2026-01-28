use std::fs::File;
use std::io::Read;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Window};

use crate::codex_config;
use crate::codex_home;
use crate::remote_backend;
use crate::state::AppState;
use crate::storage::write_settings;
use crate::types::AppSettings;
use crate::window;

const GLOBAL_AGENTS_FILENAME: &str = "AGENTS.md";
const GLOBAL_CONFIG_FILENAME: &str = "config.toml";

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct GlobalAgentsResponse {
    pub exists: bool,
    pub content: String,
    pub truncated: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct GlobalConfigResponse {
    pub exists: bool,
    pub content: String,
    pub truncated: bool,
}

fn resolve_default_codex_home() -> Result<PathBuf, String> {
    codex_home::resolve_default_codex_home().ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
}

fn canonical_existing_dir(path: &PathBuf) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve CODEX_HOME: {err}"))?;
    if !canonical.is_dir() {
        return Err("CODEX_HOME is not a directory".to_string());
    }
    Ok(Some(canonical))
}

#[tauri::command]
pub(crate) async fn get_app_settings(
    state: State<'_, AppState>,
    window: Window,
) -> Result<AppSettings, String> {
    let mut settings = state.app_settings.lock().await.clone();
    if let Ok(Some(collab_enabled)) = codex_config::read_collab_enabled() {
        settings.experimental_collab_enabled = collab_enabled;
    }
    if let Ok(Some(collaboration_modes_enabled)) =
        codex_config::read_collaboration_modes_enabled()
    {
        settings.experimental_collaboration_modes_enabled = collaboration_modes_enabled;
    }
    if let Ok(Some(steer_enabled)) = codex_config::read_steer_enabled() {
        settings.experimental_steer_enabled = steer_enabled;
    }
    if let Ok(Some(unified_exec_enabled)) = codex_config::read_unified_exec_enabled() {
        settings.experimental_unified_exec_enabled = unified_exec_enabled;
    }
    let _ = window::apply_window_appearance(&window, settings.theme.as_str());
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn update_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
    window: Window,
) -> Result<AppSettings, String> {
    let _ = codex_config::write_collab_enabled(settings.experimental_collab_enabled);
    let _ = codex_config::write_collaboration_modes_enabled(
        settings.experimental_collaboration_modes_enabled,
    );
    let _ = codex_config::write_steer_enabled(settings.experimental_steer_enabled);
    let _ = codex_config::write_unified_exec_enabled(settings.experimental_unified_exec_enabled);
    write_settings(&state.settings_path, &settings)?;
    let mut current = state.app_settings.lock().await;
    *current = settings.clone();
    let _ = window::apply_window_appearance(&window, settings.theme.as_str());
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn get_codex_config_path() -> Result<String, String> {
    codex_config::config_toml_path()
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
        .and_then(|path| {
            path.to_str()
                .map(|value| value.to_string())
                .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
        })
}

#[tauri::command]
pub(crate) async fn read_global_agents_md(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<GlobalAgentsResponse, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response = remote_backend::call_remote(&*state, app, "read_global_agents_md", serde_json::json!({})).await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    let codex_home = resolve_default_codex_home()?;
    let canonical_home = match canonical_existing_dir(&codex_home)? {
        Some(path) => path,
        None => {
            return Ok(GlobalAgentsResponse {
                exists: false,
                content: String::new(),
                truncated: false,
            })
        }
    };

    let agents_path = canonical_home.join(GLOBAL_AGENTS_FILENAME);
    if !agents_path.exists() {
        return Ok(GlobalAgentsResponse {
            exists: false,
            content: String::new(),
            truncated: false,
        });
    }

    let canonical_agents = agents_path
        .canonicalize()
        .map_err(|err| format!("Failed to open AGENTS.md: {err}"))?;
    if !canonical_agents.starts_with(&canonical_home) {
        return Err("Invalid AGENTS.md path".to_string());
    }

    let mut file =
        File::open(&canonical_agents).map_err(|err| format!("Failed to open AGENTS.md: {err}"))?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|err| format!("Failed to read AGENTS.md: {err}"))?;
    let content =
        String::from_utf8(buffer).map_err(|_| "AGENTS.md is not valid UTF-8".to_string())?;

    Ok(GlobalAgentsResponse {
        exists: true,
        content,
        truncated: false,
    })
}

#[tauri::command]
pub(crate) async fn write_global_agents_md(
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        remote_backend::call_remote(
            &*state,
            app,
            "write_global_agents_md",
            serde_json::json!({ "content": content }),
        )
        .await?;
        return Ok(());
    }

    let codex_home = resolve_default_codex_home()?;
    std::fs::create_dir_all(&codex_home)
        .map_err(|err| format!("Failed to create CODEX_HOME: {err}"))?;
    let canonical_home = codex_home
        .canonicalize()
        .map_err(|err| format!("Failed to resolve CODEX_HOME: {err}"))?;
    if !canonical_home.is_dir() {
        return Err("CODEX_HOME is not a directory".to_string());
    }

    let agents_path = canonical_home.join(GLOBAL_AGENTS_FILENAME);
    let target_path = if agents_path.exists() {
        let canonical_agents = agents_path
            .canonicalize()
            .map_err(|err| format!("Failed to resolve AGENTS.md: {err}"))?;
        if !canonical_agents.starts_with(&canonical_home) {
            return Err("Invalid AGENTS.md path".to_string());
        }
        canonical_agents
    } else {
        agents_path
    };

    std::fs::write(&target_path, content)
        .map_err(|err| format!("Failed to write AGENTS.md: {err}"))
}

#[tauri::command]
pub(crate) async fn read_global_codex_config(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<GlobalConfigResponse, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response = remote_backend::call_remote(
            &*state,
            app,
            "read_global_codex_config",
            serde_json::json!({}),
        )
        .await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    let codex_home = resolve_default_codex_home()?;
    let canonical_home = match canonical_existing_dir(&codex_home)? {
        Some(path) => path,
        None => {
            return Ok(GlobalConfigResponse {
                exists: false,
                content: String::new(),
                truncated: false,
            })
        }
    };

    let config_path = canonical_home.join(GLOBAL_CONFIG_FILENAME);
    if !config_path.exists() {
        return Ok(GlobalConfigResponse {
            exists: false,
            content: String::new(),
            truncated: false,
        });
    }

    let canonical_config = config_path
        .canonicalize()
        .map_err(|err| format!("Failed to open config.toml: {err}"))?;
    if !canonical_config.starts_with(&canonical_home) {
        return Err("Invalid config.toml path".to_string());
    }

    let mut file = File::open(&canonical_config)
        .map_err(|err| format!("Failed to open config.toml: {err}"))?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|err| format!("Failed to read config.toml: {err}"))?;
    let content =
        String::from_utf8(buffer).map_err(|_| "config.toml is not valid UTF-8".to_string())?;

    Ok(GlobalConfigResponse {
        exists: true,
        content,
        truncated: false,
    })
}

#[tauri::command]
pub(crate) async fn write_global_codex_config(
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        remote_backend::call_remote(
            &*state,
            app,
            "write_global_codex_config",
            serde_json::json!({ "content": content }),
        )
        .await?;
        return Ok(());
    }

    let codex_home = resolve_default_codex_home()?;
    std::fs::create_dir_all(&codex_home)
        .map_err(|err| format!("Failed to create CODEX_HOME: {err}"))?;
    let canonical_home = codex_home
        .canonicalize()
        .map_err(|err| format!("Failed to resolve CODEX_HOME: {err}"))?;
    if !canonical_home.is_dir() {
        return Err("CODEX_HOME is not a directory".to_string());
    }

    let config_path = canonical_home.join(GLOBAL_CONFIG_FILENAME);
    let target_path = if config_path.exists() {
        let canonical_config = config_path
            .canonicalize()
            .map_err(|err| format!("Failed to resolve config.toml: {err}"))?;
        if !canonical_config.starts_with(&canonical_home) {
            return Err("Invalid config.toml path".to_string());
        }
        canonical_config
    } else {
        config_path
    };

    std::fs::write(&target_path, content)
        .map_err(|err| format!("Failed to write config.toml: {err}"))
}
