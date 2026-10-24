use crate::core::{markdown, theme};

pub struct ExportOptions {
    pub theme_id: String,
    pub title: String,
}

/// Offline-capable, standalone HTML export. Same pulldown-cmark pipeline as
/// the reader view, theme CSS inlined, `mermaid_js` = full mermaid.min.js
/// source when available (None falls back to a CDN script tag). The mermaid
/// library is several MB, so it (and the render bootstrap) are only emitted
/// when the document actually contains mermaid blocks. Documents with
/// headings also carry the share page's side directory (fixed panel +
/// toggle button).
pub fn export_html(source: &str, mermaid_js: Option<&str>, opts: &ExportOptions) -> String {
    let rendered = markdown::render_markdown(source);
    let theme = theme::get(&opts.theme_id).or_else(|| theme::get("light")).expect("builtin theme");

    let mut vars = String::new();
    for (k, v) in &theme.vars {
        vars.push_str(&format!("{k}:{v};"));
    }

    let title = html_escape(&opts.title);
    let scheme = if theme.dark { "dark" } else { "light" };
    let toc = toc_html(&rendered.outline);
    let dark = if theme.dark { "1" } else { "0" };

    // Library tag + render bootstrap, only for documents that actually have
    // mermaid blocks (`<pre><code class="language-mermaid">`); without any,
    // the export carries no mermaid markup at all.
    let mermaid_section = if rendered.html.contains("language-mermaid") {
        let lib = match mermaid_js {
            Some(js) => format!("<script>{js}</script>"),
            None => "<script src=\"https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.min.js\"></script>"
                .to_string(),
        };
        format!(
            r#"{lib}
<script>
(function () {{
  function render() {{
    var m = window.mermaid;
    if (!m) return;
    var dark = document.documentElement.dataset.themeDark === "1";
    m.initialize({{ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit" }});
    var codes = document.querySelectorAll("pre > code.language-mermaid");
    codes.forEach(function (code, i) {{
      var pre = code.parentElement;
      var div = document.createElement("div");
      div.className = "mermaid-block";
      pre.after(div);
      m.render("mermaid-" + i, code.textContent).then(function (r) {{
        div.innerHTML = r.svg;
        pre.hidden = true;
      }}).catch(function () {{ }});
    }});
  }}
  document.documentElement.dataset.themeDark = "{dark}";
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
}})();
</script>"#,
            lib = lib,
            dark = dark,
        )
    } else {
        String::new()
    };

    format!(
        r#"<!doctype html>
<html lang="zh-CN" data-scheme="{scheme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
:root {{{vars}}}
{EXPORT_CSS}
{md_css}
</style>
</head>
<body>
<article class="md-body">
{body}
</article>
{toc}
<script>
(function () {{
  var toc = document.getElementById("toc");
  var btn = document.getElementById("tocbtn");
  if (!toc || !btn) return;
  // Open by default where there is room for the fixed panel; toggle after.
  if (window.innerWidth < 1080) toc.classList.add("hidden");
  btn.onclick = function () {{ toc.classList.toggle("hidden"); }};
}})();
</script>
{mermaid_section}
</body>
</html>
"#,
        title = title,
        vars = vars,
        EXPORT_CSS = EXPORT_CSS,
        md_css = crate::core::style::MD_CONTENT_CSS,
        body = rendered.html,
        toc = toc,
        mermaid_section = mermaid_section,
        scheme = scheme,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The share page's side directory: a fixed panel of heading anchors plus a
/// toggle button, hidden on narrow windows by the inline script below.
/// No outline (no headings) → no markup at all.
fn toc_html(outline: &[markdown::OutlineItem]) -> String {
    if outline.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "<button id=\"tocbtn\" type=\"button\">目录</button>\n<nav id=\"toc\">\n",
    );
    for item in outline {
        let class = match item.level {
            2 => " class=\"lv2\"",
            3 => " class=\"lv3\"",
            l if l >= 4 => " class=\"lv4\"",
            _ => "",
        };
        out.push_str(&format!(
            "<a{class} href=\"#{id}\">{text}</a>\n",
            id = html_escape(&item.id),
            text = html_escape(&item.text),
        ));
    }
    out.push_str("</nav>\n");
    out
}

/// Export page shell: base reset, layout container, the side-directory panel
/// and the syntax palette (bound to `data-scheme`, unlike the share page's
/// media query). Markdown content styles come from
/// [`crate::core::style::MD_CONTENT_CSS`].
const EXPORT_CSS: &str = r#"
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 15px;
  background: var(--bg);
  color: var(--text);
}
.md-body { max-width: 860px; margin: 0 auto; padding: 40px 48px 80px; line-height: 1.75; }
:root[data-scheme="light"] { --syn-keyword:#cf222e; --syn-string:#0a3069; --syn-comment:#6e7781; --syn-number:#0550ae; --syn-const:#0550ae; --syn-function:#8250df; --syn-type:#953800; --syn-variable:#0550ae; --syn-tag:#116329; --syn-attr:#0550ae; }
:root[data-scheme="dark"] { --syn-keyword:#ff7b72; --syn-string:#a5d6ff; --syn-comment:#8b949e; --syn-number:#79c0ff; --syn-const:#79c0ff; --syn-function:#d2a8ff; --syn-type:#ffa657; --syn-variable:#0550ae; --syn-tag:#7ee787; --syn-attr:#79c0ff; }
html { scroll-behavior: smooth; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 { scroll-margin-top: 16px; }
#tocbtn { position: fixed; top: 12px; right: 12px; z-index: 21; border: 1px solid var(--border);
  background: var(--panel); color: var(--text); border-radius: 6px; padding: 4px 12px;
  font-size: 12px; cursor: pointer; }
#tocbtn:hover { border-color: var(--accent); color: var(--accent); }
#toc { position: fixed; top: 46px; right: 12px; width: 280px; max-height: 72vh; overflow: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px; z-index: 20; font-size: 13px; }
#toc.hidden { display: none; }
#toc a { display: block; color: var(--text); text-decoration: none; padding: 4px 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 4px; }
#toc a:hover { color: var(--accent); background: var(--accent-soft); }
#toc a.lv2 { padding-left: 20px; }
#toc a.lv3 { padding-left: 34px; font-size: 12px; }
#toc a.lv4 { padding-left: 48px; font-size: 12px; color: var(--muted); }
@media print { #toc, #tocbtn { display: none; } }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_embeds_side_toc_when_headings_exist() {
        let html = export_html(
            "# 概览\n\n## 用法\n\n正文\n",
            None,
            &ExportOptions { theme_id: "light".into(), title: "t".into() },
        );
        assert!(html.contains("id=\"tocbtn\""), "{}", html);
        assert!(html.contains("<nav id=\"toc\">"), "{}", html);
        assert!(html.contains("<a class=\"lv2\" href=\"#用法\">用法</a>"), "{}", html);
        assert!(html.contains("toc.classList.toggle"), "{}", html);
        // No headings → no directory markup at all.
        let html = export_html(
            "只有正文\n",
            None,
            &ExportOptions { theme_id: "light".into(), title: "t".into() },
        );
        assert!(!html.contains("<nav id=\"toc\">"), "{}", html);
        assert!(!html.contains("id=\"tocbtn\""), "{}", html);
    }

    #[test]
    fn export_contains_html_skeleton_and_mermaid() {
        let html = export_html(
            "# Hello\n\n```mermaid\ngraph TD; A-->B;\n```",
            None,
            &ExportOptions { theme_id: "dark".into(), title: "t".into() },
        );
        assert!(html.contains("<title>t</title>"));
        assert!(html.contains("data-scheme=\"dark\""));
        assert!(html.contains("<h1 id="));
        assert!(html.contains("language-mermaid"));
        assert!(html.contains("cdn.jsdelivr.net/npm/mermaid@12"));
        assert!(html.contains("--bg:#1e1e1e;"));
        // Shared markdown content styles ride along with the export shell.
        assert!(html.contains(".md-body h1"), "shared content styles embedded");
        assert!(html.contains(".md-frontmatter"), "frontmatter card styles embedded");
    }

    #[test]
    fn export_without_mermaid_blocks_skips_mermaid_markup() {
        // The ~5 MB bundle must not ride along with mermaid-free documents,
        // even when the caller offered the inline JS.
        let html = export_html(
            "# Hello\n\n正文\n",
            Some("window.mermaid = {};"),
            &ExportOptions { theme_id: "light".into(), title: "t".into() },
        );
        // No mermaid lib, no CDN tag, no render bootstrap (the shared content
        // CSS may still mention `.mermaid-block`; that rides along anyway).
        assert!(!html.contains("cdn.jsdelivr.net"), "{}", html);
        assert!(!html.contains("window.mermaid"), "{}", html);
        assert!(!html.contains("themeDark"), "{}", html);
    }

    #[test]
    fn export_with_mermaid_blocks_inlines_supplied_js() {
        let html = export_html(
            "```mermaid\ngraph TD; A-->B;\n```",
            Some("window.mermaid = {};"),
            &ExportOptions { theme_id: "light".into(), title: "t".into() },
        );
        assert!(html.contains("<script>window.mermaid = {};</script>"), "{}", html);
        assert!(!html.contains("cdn.jsdelivr.net"), "{}", html);
    }

    #[test]
    fn export_carries_callouts_math_and_marks() {
        let source = "> [!NOTE]\n> 提示内容\n\n行内 $a^2$ 与 ==高亮==\n";
        let html = export_html(
            source,
            None,
            &ExportOptions { theme_id: "light".into(), title: "t".into() },
        );
        assert!(html.contains("markdown-alert-note"), "{}", html);
        assert!(html.contains("<mark>高亮</mark>"), "{}", html);
        assert!(html.contains("<math"), "{}", html);
        // The alert palette and math layout ride in the shared content CSS.
        assert!(html.contains(".markdown-alert-caution"), "{}", html);
        assert!(html.contains(".math-display"), "{}", html);
    }
}

