use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[cfg(target_os = "macos")]
use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuEvent, MenuItemBuilder, PredefinedMenuItem};
#[cfg(target_os = "macos")]
use tauri::tray::TrayIconBuilder;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager, Runtime};

const MAX_RECENT_THREADS: usize = 8;
#[cfg(target_os = "macos")]
const TRAY_ID: &str = "codex-monitor-tray";
#[cfg(target_os = "macos")]
const TRAY_QUIT_ID: &str = "tray_quit";
#[cfg(target_os = "macos")]
const TRAY_EMPTY_ID: &str = "tray_recent_empty";
pub(crate) const TRAY_OPEN_THREAD_EVENT: &str = "tray-open-thread";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayRecentThreadEntry {
    pub(crate) workspace_id: String,
    pub(crate) workspace_label: String,
    pub(crate) thread_id: String,
    pub(crate) thread_label: String,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayOpenThreadPayload {
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
}

#[derive(Default)]
pub(crate) struct TrayState {
    recent_threads: Mutex<Vec<TrayRecentThreadEntry>>,
    recent_targets_by_menu_id: Mutex<HashMap<String, TrayOpenThreadPayload>>,
}

#[tauri::command]
pub(crate) fn set_tray_recent_threads<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, TrayState>,
    entries: Vec<TrayRecentThreadEntry>,
) -> Result<(), String> {
    let normalized = normalize_recent_threads(entries);
    {
        let mut recent_threads = state
            .recent_threads
            .lock()
            .map_err(|_| "failed to lock tray recent threads".to_string())?;
        if *recent_threads == normalized {
            return Ok(());
        }
        *recent_threads = normalized;
    }

    #[cfg(target_os = "macos")]
    update_tray_menu(&app, &state)?;

    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn initialize<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &TrayState,
) -> tauri::Result<()> {
    let menu = build_tray_menu(app, state)?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Codex Monitor")
        .show_menu_on_left_click(true)
        .icon(load_tray_icon()?)
        .icon_as_template(true)
        .on_menu_event(handle_tray_menu_event::<R>);

    builder.build(app)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn initialize<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _state: &TrayState,
) -> tauri::Result<()> {
    Ok(())
}

fn normalize_recent_threads(entries: Vec<TrayRecentThreadEntry>) -> Vec<TrayRecentThreadEntry> {
    let mut deduped = HashMap::<(String, String), TrayRecentThreadEntry>::new();
    for entry in entries.into_iter() {
        let workspace_id = entry.workspace_id.trim();
        let thread_id = entry.thread_id.trim();
        let thread_label = entry.thread_label.trim();
        let workspace_label = entry.workspace_label.trim();
        if workspace_id.is_empty()
            || thread_id.is_empty()
            || thread_label.is_empty()
            || workspace_label.is_empty()
        {
            continue;
        }
        let key = (workspace_id.to_string(), thread_id.to_string());
        let should_replace = deduped
            .get(&key)
            .map(|current| entry.updated_at > current.updated_at)
            .unwrap_or(true);
        if should_replace {
            deduped.insert(
                key,
                TrayRecentThreadEntry {
                    workspace_id: workspace_id.to_string(),
                    workspace_label: workspace_label.to_string(),
                    thread_id: thread_id.to_string(),
                    thread_label: thread_label.to_string(),
                    updated_at: entry.updated_at,
                },
            );
        }
    }

    let mut normalized: Vec<_> = deduped.into_values().collect();
    normalized.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.thread_label.cmp(&right.thread_label))
            .then_with(|| left.workspace_label.cmp(&right.workspace_label))
    });
    normalized.truncate(MAX_RECENT_THREADS);
    normalized
}

#[cfg(target_os = "macos")]
fn update_tray_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &TrayState,
) -> Result<(), String> {
    let menu = build_tray_menu(app, state).map_err(|error| error.to_string())?;
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray icon not initialized".to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn build_tray_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &TrayState,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    let recent_threads = state
        .recent_threads
        .lock()
        .map(|entries| entries.clone())
        .unwrap_or_default();
    let (recent_items, recent_targets) = build_recent_menu_items(app, &recent_threads)?;
    if let Ok(mut targets) = state.recent_targets_by_menu_id.lock() {
        *targets = recent_targets;
    }
    for item in &recent_items {
        menu.append(item)?;
    }
    let separator = PredefinedMenuItem::separator(app)?;
    menu.append(&separator)?;
    let quit_item = MenuItemBuilder::with_id(TRAY_QUIT_ID, "Quit").build(app)?;
    menu.append(&quit_item)?;
    Ok(menu)
}

#[cfg(target_os = "macos")]
fn build_recent_menu_items<R: Runtime>(
    app: &tauri::AppHandle<R>,
    entries: &[TrayRecentThreadEntry],
) -> tauri::Result<(
    Vec<tauri::menu::MenuItem<R>>,
    HashMap<String, TrayOpenThreadPayload>,
)> {
    if entries.is_empty() {
        let empty_item = MenuItemBuilder::with_id(TRAY_EMPTY_ID, "No recent threads")
            .enabled(false)
            .build(app)?;
        return Ok((vec![empty_item], HashMap::new()));
    }

    let mut items = Vec::with_capacity(entries.len());
    let mut targets = HashMap::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let menu_id = format!("tray_recent_{index}");
        let item = MenuItemBuilder::with_id(menu_id.clone(), &entry.thread_label).build(app)?;
        items.push(item);
        targets.insert(
            menu_id,
            TrayOpenThreadPayload {
                workspace_id: entry.workspace_id.clone(),
                thread_id: entry.thread_id.clone(),
            },
        );
    }
    Ok((items, targets))
}

#[cfg(target_os = "macos")]
fn handle_tray_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        TRAY_QUIT_ID => app.exit(0),
        id => {
            let state = app.state::<TrayState>();
            let payload = state
                .recent_targets_by_menu_id
                .lock()
                .ok()
                .and_then(|targets| targets.get(id).cloned());
            if let Some(payload) = payload {
                show_main_window(app);
                emit_open_thread_event(app, payload);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn emit_open_thread_event<R: Runtime>(app: &tauri::AppHandle<R>, payload: TrayOpenThreadPayload) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(TRAY_OPEN_THREAD_EVENT, payload);
    } else {
        let _ = app.emit(TRAY_OPEN_THREAD_EVENT, payload);
    }
}

#[cfg(target_os = "macos")]
fn load_tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/tray-icon.png")).map(|image| image.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_recent_threads, TrayOpenThreadPayload, TrayRecentThreadEntry, MAX_RECENT_THREADS,
    };

    fn recent_entry(
        workspace_id: &str,
        workspace_label: &str,
        thread_id: &str,
        thread_label: &str,
        updated_at: i64,
    ) -> TrayRecentThreadEntry {
        TrayRecentThreadEntry {
            workspace_id: workspace_id.to_string(),
            workspace_label: workspace_label.to_string(),
            thread_id: thread_id.to_string(),
            thread_label: thread_label.to_string(),
            updated_at,
        }
    }

    #[test]
    fn normalize_recent_threads_sorts_limits_and_deduplicates() {
        let entries = vec![
            recent_entry("ws-1", "One", "t-1", "Alpha", 10),
            recent_entry("ws-2", "Two", "t-2", "Beta", 50),
            recent_entry("ws-1", "One", "t-1", "Alpha", 20),
            recent_entry(" ", "Two", "t-3", "Ignored", 30),
        ]
        .into_iter()
        .chain((0..12).map(|index| {
            recent_entry(
                "ws-extra",
                "Extra",
                &format!("t-extra-{index}"),
                &format!("Thread {index}"),
                index,
            )
        }))
        .collect();

        let normalized = normalize_recent_threads(entries);

        assert_eq!(normalized.len(), MAX_RECENT_THREADS);
        assert_eq!(normalized[0].thread_id, "t-2");
        assert_eq!(normalized[1].thread_id, "t-1");
        assert_eq!(normalized[1].updated_at, 20);
        assert!(!normalized
            .iter()
            .any(|entry| entry.thread_label == "Ignored"));
    }

    #[test]
    fn tray_open_payload_round_trips_expected_fields() {
        let payload = TrayOpenThreadPayload {
            workspace_id: "ws-1".into(),
            thread_id: "thread-1".into(),
        };

        assert_eq!(payload.workspace_id, "ws-1");
        assert_eq!(payload.thread_id, "thread-1");
    }
}
