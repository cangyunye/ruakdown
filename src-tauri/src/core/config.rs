use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Pure config store: no tauri dependency; callers resolve the file path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub last_folder: Option<String>,
    pub last_file: Option<String>,
    pub theme: Option<String>,
    pub serve_port: Option<u16>,
    pub autosave: Option<bool>,
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
