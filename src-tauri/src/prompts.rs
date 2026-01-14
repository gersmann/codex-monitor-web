use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use tokio::task;

#[derive(Serialize, Clone)]
pub(crate) struct CustomPromptEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) description: Option<String>,
    #[serde(rename = "argumentHint")]
    pub(crate) argument_hint: Option<String>,
    pub(crate) content: String,
}

fn resolve_home_dir() -> Option<PathBuf> {
    if let Ok(value) = env::var("HOME") {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    if let Ok(value) = env::var("USERPROFILE") {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    None
}

fn resolve_codex_home() -> Option<PathBuf> {
    if let Ok(value) = env::var("CODEX_HOME") {
        if !value.trim().is_empty() {
            let path = PathBuf::from(value.trim());
            if path.exists() {
                return path.canonicalize().ok().or(Some(path));
            }
            return None;
        }
    }
    resolve_home_dir().map(|home| home.join(".codex"))
}

fn default_prompts_dir() -> Option<PathBuf> {
    resolve_codex_home().map(|home| home.join("prompts"))
}

fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>, String) {
    let mut segments = content.split_inclusive('\n');
    let Some(first_segment) = segments.next() else {
        return (None, None, String::new());
    };
    let first_line = first_segment.trim_end_matches(['\r', '\n']);
    if first_line.trim() != "---" {
        return (None, None, content.to_string());
    }

    let mut description: Option<String> = None;
    let mut argument_hint: Option<String> = None;
    let mut frontmatter_closed = false;
    let mut consumed = first_segment.len();

    for segment in segments {
        let line = segment.trim_end_matches(['\r', '\n']);
        let trimmed = line.trim();

        if trimmed == "---" {
            frontmatter_closed = true;
            consumed += segment.len();
            break;
        }

        if trimmed.is_empty() || trimmed.starts_with('#') {
            consumed += segment.len();
            continue;
        }

        if let Some((key, value)) = trimmed.split_once(':') {
            let mut val = value.trim().to_string();
            if val.len() >= 2 {
                let bytes = val.as_bytes();
                let first = bytes[0];
                let last = bytes[bytes.len() - 1];
                if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
                    val = val[1..val.len().saturating_sub(1)].to_string();
                }
            }
            match key.trim().to_ascii_lowercase().as_str() {
                "description" => description = Some(val),
                "argument-hint" | "argument_hint" => argument_hint = Some(val),
                _ => {}
            }
        }

        consumed += segment.len();
    }

    if !frontmatter_closed {
        return (None, None, content.to_string());
    }

    let body = if consumed >= content.len() {
        String::new()
    } else {
        content[consumed..].to_string()
    };
    (description, argument_hint, body)
}

fn discover_prompts_in(dir: &Path) -> Vec<CustomPromptEntry> {
    let mut out: Vec<CustomPromptEntry> = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return out,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_file = fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let is_md = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }
        let Some(name) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let (description, argument_hint, body) = parse_frontmatter(&content);
        out.push(CustomPromptEntry {
            name,
            path: path.to_string_lossy().to_string(),
            description,
            argument_hint,
            content: body,
        });
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
pub(crate) async fn prompts_list(_workspace_id: String) -> Result<Vec<CustomPromptEntry>, String> {
    let Some(dir) = default_prompts_dir() else {
        return Ok(Vec::new());
    };
    task::spawn_blocking(move || discover_prompts_in(&dir))
        .await
        .map_err(|_| "prompt discovery failed".to_string())
}
