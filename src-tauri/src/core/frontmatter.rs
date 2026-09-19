//! Frontmatter (YAML-style `---` metadata block) rendering.
//!
//! pulldown-cmark parses the block when `ENABLE_YAML_STYLE_METADATA_BLOCKS`
//! is on but writes nothing for it; here the raw metadata text becomes a
//! declarative key-value card prepended to the rendered document.

use pulldown_cmark::{Event, Tag, TagEnd};

use crate::core::markdown::escape_html;

/// Raw metadata text carried by a metadata-block event run, if one is present.
pub(crate) fn metadata_text(events: &[Event]) -> Option<String> {
    let mut in_block = false;
    let mut raw = String::new();
    for event in events {
        match event {
            Event::Start(Tag::MetadataBlock(_)) => in_block = true,
            Event::End(TagEnd::MetadataBlock(_)) => in_block = false,
            Event::Text(t) if in_block => raw.push_str(t),
            _ => {}
        }
    }
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// Render metadata text as the property card. Returns "" when no usable
/// top-level keys were found.
pub(crate) fn card_html(raw: &str) -> String {
    let mut rows: Vec<(String, String)> = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented || trimmed.starts_with("- ") {
            // Continuation of the previous key: nested values and list items
            // are folded into one comma-joined display value.
            if let Some((_, val)) = rows.last_mut() {
                let piece = trimmed.strip_prefix("- ").unwrap_or(trimmed);
                if !piece.is_empty() {
                    if !val.is_empty() {
                        val.push_str(", ");
                    }
                    val.push_str(piece);
                }
            }
            continue;
        }
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let key = trimmed[..colon].trim();
        if key.is_empty() {
            continue;
        }
        rows.push((key.to_string(), scalar_value(trimmed[colon + 1..].trim())));
    }
    if rows.is_empty() {
        return String::new();
    }
    let mut out = String::from("<div class=\"md-frontmatter\">");
    for (key, val) in rows {
        out.push_str("<div class=\"fm-row\"><span class=\"fm-key\">");
        out.push_str(&escape_html(&key));
        out.push_str("</span><span class=\"fm-val\">");
        out.push_str(&escape_html(&val));
        out.push_str("</span></div>");
    }
    out.push_str("</div>\n");
    out
}

/// Strip one layer of quoting or flow-list brackets from a scalar value.
fn scalar_value(val: &str) -> String {
    let unbracketed = if val.starts_with('[') && val.ends_with(']') && val.len() >= 2 {
        &val[1..val.len() - 1]
    } else {
        val
    };
    let bytes = unbracketed.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        unbracketed[1..unbracketed.len() - 1].to_string()
    } else {
        unbracketed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_renders_keys_values_lists_and_quotes() {
        let card = card_html("title: 示例文档\ntags:\n  - rust\n  - tauri\nquoted: \"a: b\"\n# 注释\n\n");
        assert!(card.contains(">title</span><span class=\"fm-val\">示例文档<"));
        assert!(card.contains(">rust, tauri<"));
        assert!(card.contains(">a: b<"));
        assert!(!card.contains("注释"));
        assert!(card.starts_with("<div class=\"md-frontmatter\">"));
    }

    #[test]
    fn card_escapes_html_and_handles_empty() {
        assert!(card_html("v: <b>&amp;</b>").contains("&lt;b&gt;&amp;amp;&lt;/b&gt;"));
        assert_eq!(card_html("# only a comment\n\n"), "");
        assert_eq!(card_html(""), "");
        assert_eq!(card_html("no colon line\n"), "");
    }
}
