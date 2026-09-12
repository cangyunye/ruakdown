use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub level: u8,
    pub text: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedDoc {
    pub html: String,
    pub outline: Vec<OutlineItem>,
}

pub(crate) fn md_options() -> Options {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts
}

/// Render markdown to HTML and extract the heading outline.
/// Heading ids are injected so the frontend can scroll-sync with the outline.
pub fn render_markdown(source: &str) -> RenderedDoc {
    let mut outline: Vec<OutlineItem> = Vec::new();
    let mut current: Option<(u8, String)> = None;

    for event in Parser::new_ext(source, md_options()) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                current = Some((level as u8, String::new()));
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, text)) = current.take() {
                    let text = text.trim().to_string();
                    let id = make_heading_id(&text, outline.len() + 1);
                    outline.push(OutlineItem { level, text, id });
                }
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some((_, buf)) = current.as_mut() {
                    buf.push_str(&t);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some((_, buf)) = current.as_mut() {
                    buf.push(' ');
                }
            }
            _ => {}
        }
    }

    let mut html_out = String::with_capacity(source.len() * 2);
    html::push_html(&mut html_out, Parser::new_ext(source, md_options()));
    let html_out = inject_heading_ids(&html_out, &outline);

    RenderedDoc { html: html_out, outline }
}

/// GitHub-ish slug: ASCII alnum lowercased, other alphanumerics (CJK etc.) kept,
/// everything else collapsed to '-'. The running index keeps ids unique.
pub(crate) fn make_heading_id(text: &str, index: usize) -> String {
    let mut slug = String::new();
    let mut last_dash = true;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.extend(ch.to_lowercase());
            last_dash = false;
        } else if ch.is_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        format!("heading-{index}")
    } else {
        format!("{slug}-{index}")
    }
}

/// pulldown-cmark emits bare `<hN>` tags in document order, so ids can be
/// injected sequentially by matching `<hN>` occurrences against the outline.
fn inject_heading_ids(html: &str, outline: &[OutlineItem]) -> String {
    let mut result = String::with_capacity(html.len() + outline.len() * 32);
    let mut rest = html;
    for item in outline {
        let needle = format!("<h{}>", item.level);
        if let Some(pos) = rest.find(&needle) {
            result.push_str(&rest[..pos]);
            result.push_str(&format!("<h{} id=\"{}\">", item.level, item.id));
            rest = &rest[pos + needle.len()..];
        } else {
            break;
        }
    }
    result.push_str(rest);
    result
}

/// Rewrite relative `<img src="...">` references to the Tauri asset protocol so
/// images next to the markdown file actually load inside the webview.
/// Absolute URLs (http/https/data/anchors) are left untouched.
pub fn rewrite_img_srcs(html: &str, base: Option<&std::path::Path>) -> String {
    use percent_encoding::percent_decode_str;

    const ASSET_SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');

    let Some(base) = base else {
        return html.to_string();
    };
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() + 128);
    let mut cursor = 0usize;
    loop {
        let Some(off) = lower[cursor..].find("<img") else {
            break;
        };
        let img_abs = cursor + off;
        let tag_end = lower[img_abs..]
            .find('>')
            .map(|p| (img_abs + p).min(html.len()))
            .unwrap_or(html.len());
        out.push_str(&html[cursor..img_abs]);
        let src_off = lower[img_abs..tag_end].find("src=\"");
        match src_off {
            None => {
                out.push_str(&html[img_abs..tag_end]);
                cursor = tag_end;
            }
            Some(src_off) => {
                let val_start = img_abs + src_off + 5;
                let val_end = html[val_start..]
                    .find('"')
                    .map(|p| val_start + p)
                    .unwrap_or(tag_end)
                    .min(html.len());
                let raw = &html[val_start..val_end];
                out.push_str(&html[img_abs..val_start]);
                let decoded = percent_decode_str(raw).decode_utf8_lossy().to_string();
                let absolute = ["http://", "https://", "data:", "#", "asset:"]
                    .iter()
                    .any(|p| decoded.to_ascii_lowercase().starts_with(p));
                if absolute || decoded.is_empty() {
                    out.push_str(raw);
                } else {
                    let rel = decoded.replace('\\', "/");
                    let full = base.join(rel.trim_start_matches('/'));
                    let full = dunce::simplified(&full).to_string_lossy();
                    let enc = percent_encoding::utf8_percent_encode(&full, ASSET_SET);
                    if cfg!(windows) {
                        out.push_str(&format!("http://asset.localhost/{enc}"));
                    } else {
                        out.push_str(&format!("asset://localhost/{enc}"));
                    }
                }
                out.push('"');
                cursor = val_end + 1;
            }
        }
        if cursor >= html.len() {
            break;
        }
    }
    out.push_str(&html[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outline_and_ids() {
        let doc = render_markdown("# 标题 A\n\ntext\n\n## Section Two\n\ntext\n\n# 标题 A");
        assert_eq!(doc.outline.len(), 3);
        assert_eq!(doc.outline[0].text, "标题 A");
        assert_ne!(doc.outline[0].id, doc.outline[2].id);
        assert!(doc.html.contains("<h1 id="));
    }

    #[test]
    fn mermaid_block_keeps_language_class() {
        let doc = render_markdown("```mermaid\ngraph TD; A-->B;\n```");
        assert!(doc.html.contains("language-mermaid"));
    }

    /// Benchmark for the large-document chunked-rendering design.
    /// Run with: cargo test bench_large_document -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_large_document() {
        let unit = "# 章节标题\n\n这是一段中文正文,包含**加粗**、*斜体*和`行内代码`,用于模拟真实文档密度。\n\n- 列表项一\n- 列表项二\n- 列表项三\n\n| 列A | 列B | 列C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n\n```rust\nfn main() {\n    println!(\"hello\");\n}\n```\n\n> 一段引用文字。\n\n";
        for mb in [1usize, 5, 10] {
            let repeats = mb * 1024 * 1024 / unit.len();
            let source: String = unit.repeat(repeats);
            let t0 = std::time::Instant::now();
            let doc = render_markdown(&source);
            let render = t0.elapsed();
            let t1 = std::time::Instant::now();
            let _ = Parser::new_ext(&source, md_options()).count();
            let parse_only = t1.elapsed();
            println!(
                "{mb}MB source: full render {:?} (html {} bytes, {} headings), parse-only {:?}",
                render,
                doc.html.len(),
                doc.outline.len(),
                parse_only
            );
        }
    }
}
