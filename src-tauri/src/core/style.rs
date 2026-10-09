//! Single-source CSS shared by the reader view, the HTML export and the LAN
//! share page. The file lives in `resources/` so the frontend can `@import`
//! it (via a relative path through Vite) while Rust embeds it verbatim —
//! editing it updates all three surfaces at once.

/// Markdown content styles (`.md-body` scoped); see the file header for the
/// consumer list and the variable contract.
pub const MD_CONTENT_CSS: &str = include_str!("../../resources/md-content.css");

#[cfg(test)]
mod tests {
    use super::MD_CONTENT_CSS;
    use crate::core::theme;
    use std::collections::HashSet;

    /// App-chrome stylesheet, embedded read-only for the slot contract test
    /// below (the engine that owns `:root` defaults and `--hover`/zen vars).
    const INDEX_CSS: &str = include_str!("../../../src/index.css");
    const EXPORT_RS: &str = include_str!("export.rs");
    const SERVE_RS: &str = include_str!("serve.rs");

    #[test]
    fn shared_css_is_non_empty_and_md_body_scoped() {
        assert!(MD_CONTENT_CSS.contains(".md-body h1"));
        assert!(MD_CONTENT_CSS.contains(".md-frontmatter"));
        assert!(MD_CONTENT_CSS.contains(".tok-keyword"));
    }

    // ---- theme slot contract (THEMES.md 「样式槽位的拓展」) ----
    //
    // The two style engines may consume a `--slot` WITHOUT a fallback only
    // where that slot is supplied on every surface the file ships to:
    // app (:root defaults + theme JSON at runtime), export (theme JSON
    // inlined + EXPORT_CSS shell), share (static blocks in serve.rs — the
    // share page never reads theme JSONs). A slot missing its fallback or
    // its share-page mirror fails here; see the `kbd`/`--hover` precedent.

    /// Remove `/*…*/` (both files) and `//…` (Rust sources) so the scanners
    /// only see real CSS. Byte-wise: non-ASCII bytes can never form the
    /// ASCII patterns we match, so mangling comments is harmless.
    fn strip_comments(text: &str, line_comments: bool) -> String {
        let b = text.as_bytes();
        let mut out: Vec<u8> = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(b.len());
                out.push(b' ');
            } else if line_comments && i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'/' {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn is_name_byte(b: u8) -> bool {
        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
    }

    /// Every `--x:` definition in a stylesheet text.
    fn css_defs(css: &str) -> HashSet<String> {
        let b = css.as_bytes();
        let mut out = HashSet::new();
        let mut i = 0;
        while i + 1 < b.len() {
            if b[i] == b'-' && b[i + 1] == b'-' {
                let mut j = i + 2;
                while j < b.len() && is_name_byte(b[j]) {
                    j += 1;
                }
                if j > i + 2 {
                    let mut k = j;
                    while k < b.len() && (b[k] == b' ' || b[k] == b'\t') {
                        k += 1;
                    }
                    if k < b.len() && b[k] == b':' {
                        out.insert(String::from_utf8_lossy(&b[i..j]).into_owned());
                    }
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
        out
    }

    /// Slots consumed with no fallback — `var(--x)` but not `var(--x, …)`.
    fn css_hard_uses(css: &str) -> HashSet<String> {
        let b = css.as_bytes();
        let mut out = HashSet::new();
        let mut i = 0;
        while i + 4 < b.len() {
            if &b[i..i + 4] == b"var(" {
                let mut j = i + 4;
                while j < b.len() && (b[j] as char).is_whitespace() {
                    j += 1;
                }
                if j + 1 < b.len() && b[j] == b'-' && b[j + 1] == b'-' {
                    let mut k = j + 2;
                    while k < b.len() && is_name_byte(b[k]) {
                        k += 1;
                    }
                    if k > j + 2 && k < b.len() && (b[k] == b')' || b[k] == b',') {
                        if b[k] == b')' {
                            out.insert(String::from_utf8_lossy(&b[j..k]).into_owned());
                        }
                        i = k;
                        continue;
                    }
                }
            }
            i += 1;
        }
        out
    }

    /// Union of slots offered by the builtin theme JSONs.
    fn theme_union() -> HashSet<String> {
        theme::ids()
            .filter_map(theme::get)
            .flat_map(|t| t.vars.keys().cloned().collect::<Vec<_>>())
            .collect()
    }

    #[test]
    fn index_css_resolves_its_fallback_free_uses() {
        let index_defs = css_defs(&strip_comments(INDEX_CSS, false));
        let theme_union = theme_union();
        let uses = css_hard_uses(&strip_comments(INDEX_CSS, false));
        let missing: Vec<String> = uses
            .iter()
            .filter(|s| !index_defs.contains(*s) && !theme_union.contains(*s))
            .cloned()
            .collect();
        assert!(
            missing.is_empty(),
            "index.css consumes slots with no definition and no fallback: {missing:?}"
        );
    }

    #[test]
    fn md_content_css_resolves_on_all_three_surfaces() {
        let theme_union = theme_union();
        let export_defs = css_defs(&strip_comments(EXPORT_RS, true));
        let serve_defs = css_defs(&strip_comments(SERVE_RS, true));
        let index_defs = css_defs(&strip_comments(INDEX_CSS, false));
        let uses = css_hard_uses(&strip_comments(MD_CONTENT_CSS, false));
        let missing: Vec<String> = uses
            .iter()
            .filter(|s| {
                // export: theme JSON inlined + export shell
                !(theme_union.contains(*s) || export_defs.contains(*s))
                    // share page: static blocks only, never reads theme JSONs
                    || !serve_defs.contains(*s)
                    // app: runtime theme JSON + :root defaults
                    || !(theme_union.contains(*s) || index_defs.contains(*s))
            })
            .cloned()
            .collect();
        assert!(
            missing.is_empty(),
            "md-content.css consumes slots unsupplied on some surface: {missing:?}"
        );
    }

    #[test]
    fn every_theme_json_slot_has_a_static_default_in_index_css() {
        let index_defs = css_defs(&strip_comments(INDEX_CSS, false));
        let union = theme_union();
        let missing: Vec<String> = union
            .iter()
            .filter(|s| !index_defs.contains(*s))
            .cloned()
            .collect();
        assert!(
            missing.is_empty(),
            "theme JSON slots without a :root default in index.css: {missing:?}"
        );
    }
}
