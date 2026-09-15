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

    /// The full set of CSS vars every theme JSON must define; index.css and
    /// the reader overlay depend on all of them.
    const REQUIRED_VARS: &[&str] = &[
        "--bg",
        "--panel",
        "--border",
        "--text",
        "--muted",
        "--heading",
        "--link",
        "--accent",
        "--accent-soft",
        "--code-bg",
        "--code-text",
        "--pre-bg",
        "--pre-border",
        "--quote-border",
        "--quote-text",
        "--table-border",
        "--mermaid-bg",
        "--reader-overlay-rgb",
    ];

    /// Relative luminance of a `#rrggbb` color, 0 (black) to 1 (white).
    fn luma(hex: &str) -> f32 {
        let h = hex.trim().trim_start_matches('#');
        assert_eq!(h.len(), 6, "not a #rrggbb color: {hex}");
        let ch = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap() as f32;
        (0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4)) / 255.0
    }

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

    #[test]
    fn builtin_themes_define_all_required_vars() {
        for id in BUILTIN_IDS {
            let t = get(id).unwrap_or_else(|| panic!("missing theme: {id}"));
            for var in REQUIRED_VARS {
                assert!(
                    t.vars.contains_key(*var),
                    "theme {id} is missing required var {var}"
                );
            }
        }
    }

    /// 论道武当 is the black-white weave theme: paper-white ground, ink-black
    /// text/accent, and ink-dark code blocks with reversed (light) text.
    #[test]
    fn wudang_is_ink_on_paper_weave() {
        let t = get("wudang").unwrap();
        assert!(luma(&t.vars["--bg"]) > 0.85, "ground must stay paper-white");
        assert!(luma(&t.vars["--panel"]) > 0.8, "panel stays light");
        assert!(luma(&t.vars["--text"]) < 0.2, "body text is ink black");
        assert!(luma(&t.vars["--heading"]) < 0.05, "headings are pure ink");
        assert_eq!(
            t.vars["--link"], t.vars["--accent"],
            "link and accent share the ink color"
        );
        assert!(luma(&t.vars["--link"]) < 0.1, "accent is ink black");
        // The ink-dyed blocks: dark code surfaces carrying light text.
        assert!(
            luma(&t.vars["--code-bg"]) < 0.12,
            "inline code is an ink block"
        );
        assert!(
            luma(&t.vars["--code-text"]) > 0.85,
            "code text is reversed light"
        );
        assert!(
            luma(&t.vars["--pre-bg"]) < 0.12,
            "pre block is an ink block"
        );
        assert!(t.vars["--accent-soft"].starts_with("rgba(17, 17, 17"));
    }
}
