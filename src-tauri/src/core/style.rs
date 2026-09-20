//! Single-source CSS shared by the reader view, the HTML export and the LAN
//! share page. The file lives in `resources/` so the frontend can `@import`
//! it (via a relative path through Vite) while Rust embeds it verbatim —
//! editing it updates all three surfaces at once.

/// Markdown content styles (`.md-body` scoped); see the file header for the
/// consumer list and the variable contract.
pub const MD_CONTENT_CSS: &str = include_str!("../../resources/md-content.css");

#[cfg(test)]
mod tests {
    #[test]
    fn shared_css_is_non_empty_and_md_body_scoped() {
        assert!(super::MD_CONTENT_CSS.contains(".md-body h1"));
        assert!(super::MD_CONTENT_CSS.contains(".md-frontmatter"));
        assert!(super::MD_CONTENT_CSS.contains(".tok-keyword"));
    }
}
