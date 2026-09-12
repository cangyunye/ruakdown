use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct ThemeInfo {
    pub id: String,
    pub name: String,
    pub dark: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub name: String,
    pub dark: bool,
    pub vars: BTreeMap<String, String>,
}

const LIGHT: &str = include_str!("../../resources/themes/light.json");
const DARK: &str = include_str!("../../resources/themes/dark.json");
const GRAPHITE: &str = include_str!("../../resources/themes/graphite.json");

pub const BUILTIN_IDS: &[&str] = &["light", "dark", "graphite"];

pub fn list() -> Vec<ThemeInfo> {
    BUILTIN_IDS
        .iter()
        .filter_map(|id| get(id).map(|t| ThemeInfo { id: id.to_string(), name: t.name, dark: t.dark }))
        .collect()
}

pub fn get(id: &str) -> Option<Theme> {
    let raw = match id {
        "light" => LIGHT,
        "dark" => DARK,
        "graphite" => GRAPHITE,
        _ => return None,
    };
    serde_json::from_str(raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_themes_parse() {
        assert_eq!(list().len(), 3);
        assert!(get("dark").unwrap().dark);
        assert!(!get("light").unwrap().dark);
        assert!(get("dark").unwrap().vars.contains_key("--bg"));
    }
}
