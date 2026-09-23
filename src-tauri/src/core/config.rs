use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Reader background image settings; all fields optional so older
/// config.json files keep loading.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackgroundConfig {
    pub enabled: Option<bool>,
    pub path: Option<String>,
    /// Blur radius in px (0-40).
    pub blur: Option<u8>,
    /// Mask strength in percent (0-100).
    pub overlay: Option<u8>,
    /// "paper" (opaque sheet) or "frosted" (translucent blur).
    pub style: Option<String>,
}

/// Zen (focus) reading mode preferences; the on/off toggle itself is a
/// session state and not persisted.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZenConfig {
    /// "auto" (first heading level with >= 2 headings), "h1", "h2" or "h3".
    pub level: Option<String>,
    /// "dim" or "dim-blur".
    pub effect: Option<String>,
    /// Emphasis boost for strong/code/mark/blockquote while in zen mode.
    pub emphasis: Option<bool>,
}

/// Split (editor + preview) layout preferences; the on/off state itself is
/// a view mode, not persisted.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SplitConfig {
    /// Which side the source editor sits on: "left" or "right".
    pub editor_side: Option<String>,
    /// Editor pane width as a fraction of the split area (0.2-0.8).
    pub ratio: Option<f32>,
}

/// Pure config store: no tauri dependency; callers resolve the file path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub last_folder: Option<String>,
    pub last_file: Option<String>,
    pub theme: Option<String>,
    pub serve_port: Option<u16>,
    pub autosave: Option<bool>,
    pub background: Option<BackgroundConfig>,
    pub zen: Option<ZenConfig>,
    pub split: Option<SplitConfig>,
    /// Recently opened file paths (most recent first, max 15).
    pub recent_files: Option<Vec<String>>,
}

pub fn load(path: &Path) -> Config {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, config: &Config) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, json).map_err(|e| e.to_string())
}
