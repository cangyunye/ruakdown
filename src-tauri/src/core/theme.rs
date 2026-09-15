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
const SUNSET_COAST: &str = include_str!("../../resources/themes/sunset-coast.json");
const VERDANT: &str = include_str!("../../resources/themes/verdant.json");
const SKY: &str = include_str!("../../resources/themes/sky.json");
const NEWSPRINT: &str = include_str!("../../resources/themes/newsprint.json");
const PLUM_WINE: &str = include_str!("../../resources/themes/plum-wine.json");
const MOUNTAIN_STREAM: &str = include_str!("../../resources/themes/mountain-stream.json");
const WUDANG: &str = include_str!("../../resources/themes/wudang.json");

pub const BUILTIN_IDS: &[&str] = &[
    "light",
    "dark",
    "graphite",
    "sunset-coast",
    "verdant",
    "sky",
    "newsprint",
    "plum-wine",
    "mountain-stream",
    "wudang",
];

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
        "sunset-coast" => SUNSET_COAST,
        "verdant" => VERDANT,
        "sky" => SKY,
        "newsprint" => NEWSPRINT,
        "plum-wine" => PLUM_WINE,
        "mountain-stream" => MOUNTAIN_STREAM,
        "wudang" => WUDANG,
        _ => return None,
    };
    serde_json::from_str(raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_themes_parse() {
        assert_eq!(list().len(), 10);
        assert!(get("dark").unwrap().dark);
        assert!(!get("light").unwrap().dark);
        assert!(get("dark").unwrap().vars.contains_key("--bg"));
        // All scenic additions are light themes.
        for id in [
            "sunset-coast",
            "verdant",
            "sky",
            "newsprint",
            "plum-wine",
            "mountain-stream",
            "wudang",
        ] {
            let t = get(id).unwrap_or_else(|| panic!("missing theme: {id}"));
            assert!(!t.dark, "{id} should be a light theme");
            assert!(t.vars.contains_key("--reader-overlay-rgb"));
        }
    }
}
