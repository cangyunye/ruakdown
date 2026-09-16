use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd, html};
use syntect::parsing::{ParseState, ScopeStack, SyntaxSet};
use syntect::util::LinesWithEndings;
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
/// Fenced code blocks are syntax-highlighted (classed spans, colors from the
/// `--syn-*` theme variables).
pub fn render_markdown(source: &str) -> RenderedDoc {
    let mut outline: Vec<OutlineItem> = Vec::new();
    let mut current: Option<(u8, String)> = None;

    // Single parse pass: collect outline items and the event stream together.
    let mut events: Vec<Event> = Vec::new();
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
            Event::Text(ref t) | Event::Code(ref t) => {
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
        events.push(event);
    }

    let mut html_out = String::with_capacity(source.len() * 2);
    html::push_html(&mut html_out, highlight_code_events(events).into_iter());
    let html_out = inject_heading_ids(&html_out, &outline);

    RenderedDoc { html: html_out, outline }
}

/// Replace each code-block event run with one raw-HTML event carrying the
/// highlighted `<pre><code>`; the HTML writer passes `Event::Html` through
/// verbatim, so everything else keeps its default rendering. Shared by the
/// full-document render and the large-doc per-block renderer so their outputs
/// stay byte-identical.
pub(crate) fn highlight_code_events(events: Vec<Event>) -> Vec<Event> {
    let mut out = Vec::with_capacity(events.len());
    let mut iter = events.into_iter().peekable();
    while let Some(event) = iter.next() {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                let lang = match &kind {
                    CodeBlockKind::Fenced(info) => info.split([' ', '\t']).next().unwrap_or(""),
                    CodeBlockKind::Indented => "",
                }
                .to_string();
                let mut code = String::new();
                while let Some(next) = iter.next() {
                    match next {
                        Event::Text(t) => code.push_str(&t),
                        Event::End(TagEnd::CodeBlock) => break,
                        _ => {}
                    }
                }
                out.push(Event::Html(render_code_block(&lang, &code).into()));
            }
            other => out.push(other),
        }
    }
    out
}

/// Wrap highlighted code in the same shape pulldown-cmark emits
/// (`<pre><code class="language-x">…</code></pre>`); mermaid.ts and the
/// export path depend on the `language-*` class.
fn render_code_block(lang: &str, code: &str) -> String {
    let attr = if lang.is_empty() {
        String::new()
    } else {
        format!(" class=\"language-{lang}\"")
    };
    format!("<pre><code{attr}>{}</code></pre>\n", highlight_cached(lang, code))
}

/// Memoized block highlights. Typing re-renders the whole document on every
/// debounce tick and unchanged code blocks dominate that cost, so reuse their
/// HTML keyed by a 64-bit hash of (lang, code).
fn highlight_cached(lang: &str, code: &str) -> String {
    static CACHE: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        lang.hash(&mut hasher);
        code.hash(&mut hasher);
        hasher.finish()
    };
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return hit.clone();
    }
    let html = highlight_code(lang, code);
    let mut guard = cache.lock().unwrap();
    if guard.len() >= 1024 {
        guard.clear();
    }
    guard.insert(key, html.clone());
    html
}

fn syntax_set() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Highlight one code block into HTML with semantic token classes
/// (`tok-keyword`, `tok-string`, …) colored via CSS variables. Blocks without
/// a recognized language (and mermaid, which the frontend re-renders) come
/// back as escaped plain text.
fn highlight_code(lang: &str, code: &str) -> String {
    let token = lang.trim().to_ascii_lowercase();
    if token.is_empty() || token == "mermaid" {
        return escape_html(code);
    }
    let ss = syntax_set();
    let Some(syntax) = ss.find_syntax_by_token(&token) else {
        return escape_html(code);
    };

    let mut parse_state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut out = String::with_capacity(code.len() * 2);
    for line in LinesWithEndings::from(code) {
        let ops = match parse_state.parse_line(line, ss) {
            Ok(ops) => ops,
            Err(_) => {
                escape_into(line, &mut out);
                continue;
            }
        };
        let mut cur = 0;
        for (i, op) in &ops {
            if *i > cur {
                write_span(&mut out, &stack, &line[cur..*i]);
                cur = *i;
            }
            let _ = stack.apply(op);
        }
        write_span(&mut out, &stack, &line[cur..line.len()]);
    }
    out
}

fn write_span(out: &mut String, stack: &ScopeStack, text: &str) {
    match token_class(stack) {
        Some(class) => {
            out.push_str("<span class=\"");
            out.push_str(class);
            out.push_str("\">");
            escape_into(text, out);
            out.push_str("</span>");
        }
        None => escape_into(text, out),
    }
}

/// Innermost decisive scope wins: walk the stack inside-out and map the first
/// recognized scope's atoms to a token class. Scopes we don't style (punctuation,
/// meta, plain variables) fall through so the text keeps the default color.
fn token_class(stack: &ScopeStack) -> Option<&'static str> {
    for scope in stack.as_slice().iter().rev() {
        let scope_str = scope.to_string();
        let mut atoms = scope_str.split('.');
        let Some(a0) = atoms.next() else {
            continue;
        };
        let a1 = atoms.next();
        let class = match (a0, a1) {
            ("comment", _) => Some("tok-comment"),
            ("string", _) => Some("tok-string"),
            ("constant", Some("numeric" | "character")) => Some("tok-number"),
            ("constant", _) => Some("tok-const"),
            ("keyword", Some("operator")) => None,
            ("keyword" | "storage", _) => Some("tok-keyword"),
            ("support", Some("function")) => Some("tok-function"),
            ("support", Some("type" | "class")) => Some("tok-type"),
            ("support", Some("constant")) => Some("tok-const"),
            ("support", _) => Some("tok-variable"),
            ("entity", Some("name")) => match atoms.next() {
                Some("function") => Some("tok-function"),
                Some("tag") => Some("tok-tag"),
                Some(_) => Some("tok-type"),
                None => None,
            },
            ("entity", Some("other")) => Some("tok-attr"),
            ("entity", _) => Some("tok-type"),
            _ => None,
        };
        if class.is_some() {
            return class;
        }
    }
    None
}

fn escape_into(text: &str, out: &mut String) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    escape_into(text, &mut out);
    out
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
        // Mermaid blocks are handed to mermaid.ts untouched — no token spans.
        assert!(!doc.html.contains("tok-"), "{}", doc.html);
    }

    #[test]
    fn rust_code_block_is_highlighted() {
        let doc = render_markdown("```rust\nfn main() { let x = 42; }\n```");
        assert!(doc.html.contains("language-rust"));
        assert!(doc.html.contains("tok-keyword"), "{}", doc.html);
        assert!(doc.html.contains("tok-number"), "{}", doc.html);
        assert!(!doc.html.contains("<span style"), "{}", doc.html);
    }

    #[test]
    fn unknown_language_stays_plain() {
        let doc = render_markdown("```weirdlang\na < b && c > d\n```");
        assert!(doc.html.contains("language-weirdlang"));
        assert!(doc.html.contains("a &lt; b &amp;&amp; c &gt; d"), "{}", doc.html);
        assert!(!doc.html.contains("tok-"), "{}", doc.html);
    }

    #[test]
    fn code_html_is_escaped() {
        let doc = render_markdown("```\n<script>alert(1)</script>\n```");
        assert!(!doc.html.contains("<script>"), "{}", doc.html);
        assert!(doc.html.contains("&lt;script&gt;"), "{}", doc.html);
    }

    /// Throughput check for the syntax highlighter (SyntaxSet cold load,
    /// steady-state MB/s, memoized re-render). Run with:
    /// cargo test --release bench_code_highlight -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_code_highlight() {
        let t0 = std::time::Instant::now();
        let _ = render_markdown("```rust\nlet x = 1;\n```");
        println!("cold render (incl. SyntaxSet load): {:?}", t0.elapsed());

        let unit = "```rust\nfn main() {\n    let x = {n}; // block {n}\n    println!(\"{}\", x);\n}\n\n```\n\n";
        let mut source = String::new();
        for n in 0..8192 {
            source.push_str(&unit.replace("{n}", &n.to_string()));
        }
        let mb = source.len() as f64 / 1024.0 / 1024.0;
        let t1 = std::time::Instant::now();
        let doc = render_markdown(&source);
        let elapsed = t1.elapsed();
        println!(
            "{mb:.2}MB source (half code) rendered in {elapsed:?} → {:.2} MB/s, {} html bytes",
            mb / elapsed.as_secs_f64(),
            doc.html.len()
        );

        // Memoized re-render: a realistic doc stays under the cache cap, so
        // unchanged blocks (i.e. everything not being edited) are reused.
        let small: String = (0..512)
            .map(|n| unit.replace("{n}", &n.to_string()))
            .collect();
        let _ = render_markdown(&small);
        let t2 = std::time::Instant::now();
        let _ = render_markdown(&small);
        println!(
            "re-render of {}KB doc with warm block cache: {:?}",
            small.len() / 1024,
            t2.elapsed()
        );
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
