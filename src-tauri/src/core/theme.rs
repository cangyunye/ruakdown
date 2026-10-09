use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub name: String,
    pub dark: bool,
    pub vars: BTreeMap<String, String>,
}

/// Picker metadata derived from each theme JSON: registry id + display name
/// (the JSON `name` field) + scheme. `list_themes` hands these to the
/// frontend so the picker needs no hardcoded labels.
#[derive(Debug, Clone, Serialize)]
pub struct ThemeMeta {
    pub id: String,
    pub name: String,
    pub dark: bool,
}

/// The builtin registry: `(id, file)`. Adding a theme = dropping a JSON into
/// `resources/themes/` and adding one line here — picker order follows this
/// list, and every test below iterates it, so nothing else needs touching.
const BUILTINS: &[(&str, &str)] = &[
    ("light", include_str!("../../resources/themes/light.json")),
    ("dark", include_str!("../../resources/themes/dark.json")),
    ("graphite", include_str!("../../resources/themes/graphite.json")),
    ("sunset-coast", include_str!("../../resources/themes/sunset-coast.json")),
    ("verdant", include_str!("../../resources/themes/verdant.json")),
    ("sky", include_str!("../../resources/themes/sky.json")),
    ("newsprint", include_str!("../../resources/themes/newsprint.json")),
    ("plum-wine", include_str!("../../resources/themes/plum-wine.json")),
    ("mountain-stream", include_str!("../../resources/themes/mountain-stream.json")),
    ("wudang", include_str!("../../resources/themes/wudang.json")),
    ("cyberpunk", include_str!("../../resources/themes/cyberpunk.json")),
    ("phantom-violet", include_str!("../../resources/themes/phantom-violet.json")),
];

pub fn get(id: &str) -> Option<Theme> {
    let (_, raw) = BUILTINS.iter().find(|(bid, _)| *bid == id)?;
    serde_json::from_str(raw).ok()
}

/// Registry ids in picker order.
pub fn ids() -> impl Iterator<Item = &'static str> {
    BUILTINS.iter().map(|(id, _)| *id)
}

/// All builtins in picker order.
pub fn list() -> Vec<ThemeMeta> {
    BUILTINS
        .iter()
        .filter_map(|(id, raw)| {
            serde_json::from_str::<Theme>(raw).ok().map(|t| ThemeMeta {
                id: id.to_string(),
                name: t.name,
                dark: t.dark,
            })
        })
        .collect()
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
        for (id, raw) in BUILTINS {
            let t: Theme = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("theme {id} does not parse: {e}"));
            assert!(!t.name.is_empty(), "{id} needs a display name");
            assert!(t.vars.contains_key("--bg"), "{id} missing --bg");
        }
        assert_eq!(list().len(), BUILTINS.len(), "list() covers every builtin");
        assert!(get("dark").unwrap().dark);
        assert!(!get("light").unwrap().dark);
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
        // The neon additions are dark themes.
        for id in ["cyberpunk", "phantom-violet"] {
            let t = get(id).unwrap_or_else(|| panic!("missing theme: {id}"));
            assert!(t.dark, "{id} should be a dark theme");
            assert!(t.vars.contains_key("--reader-overlay-rgb"));
        }
    }

    #[test]
    fn builtin_themes_define_all_required_vars() {
        for (id, raw) in BUILTINS {
            let t: Theme = serde_json::from_str(raw).unwrap();
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

    /// 赛博朋克 is the neon-on-void theme: near-black indigo ground, electric
    /// cyan headings/accent and hot magenta links, with a darker code void.
    #[test]
    fn cyberpunk_is_neon_on_void() {
        let t = get("cyberpunk").unwrap();
        assert!(luma(&t.vars["--bg"]) < 0.06, "ground is near-black void");
        assert!(luma(&t.vars["--text"]) > 0.6, "body text stays readable");
        assert_eq!(
            t.vars["--heading"], t.vars["--accent"],
            "headings and accent share the electric cyan"
        );
        assert!(luma(&t.vars["--pre-bg"]) < luma(&t.vars["--bg"]), "pre sinks below the void");
        assert!(t.vars["--accent-soft"].starts_with("rgba(0, 229, 255"));
    }

    /// 魅影紫罗兰 is the phantom violet theme: deep aubergine ground washed in
    /// violet — headings, links and accent all in the iris family, code tinted.
    #[test]
    fn phantom_violet_is_iris_on_aubergine() {
        let t = get("phantom-violet").unwrap();
        assert!(luma(&t.vars["--bg"]) < 0.1, "ground is deep aubergine");
        assert!(luma(&t.vars["--text"]) > 0.6, "body text stays readable");
        assert_eq!(
            t.vars["--link"], t.vars["--accent"],
            "link and accent share the iris violet"
        );
        assert_eq!(t.vars["--code-bg"], "#251c44", "code keeps the violet cast");
        assert!(t.vars["--accent-soft"].starts_with("rgba(166, 132, 255"));
    }
}
