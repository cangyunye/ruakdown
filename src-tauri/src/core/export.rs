use crate::core::{markdown, theme};

pub struct ExportOptions {
    pub theme_id: String,
    pub title: String,
}

/// Offline-capable, standalone HTML export. Same pulldown-cmark pipeline as
/// the reader view, theme CSS inlined, `mermaid_js` = full mermaid.min.js
/// source when available (None falls back to a CDN script tag).
pub fn export_html(source: &str, mermaid_js: Option<&str>, opts: &ExportOptions) -> String {
    let rendered = markdown::render_markdown(source);
    let theme = theme::get(&opts.theme_id).or_else(|| theme::get("light")).expect("builtin theme");

    let mut vars = String::new();
    for (k, v) in &theme.vars {
        vars.push_str(&format!("{k}:{v};"));
    }

    let mermaid_script = match mermaid_js {
        Some(js) => format!("<script>{js}</script>"),
        None => "<script src=\"https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.min.js\"></script>"
            .to_string(),
    };

    let title = html_escape(&opts.title);
    let scheme = if theme.dark { "dark" } else { "light" };

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
{mermaid_script}
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
</script>
</body>
</html>
"#,
        title = title,
        vars = vars,
        EXPORT_CSS = EXPORT_CSS,
        md_css = crate::core::style::MD_CONTENT_CSS,
        body = rendered.html,
        mermaid_script = mermaid_script,
        dark = if theme.dark { "1" } else { "0" },
        scheme = scheme,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Export page shell: base reset, layout container and the syntax palette
/// (bound to `data-scheme`, unlike the share page's media query). Markdown
/// content styles come from [`crate::core::style::MD_CONTENT_CSS`].
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
:root[data-scheme="dark"] { --syn-keyword:#ff7b72; --syn-string:#a5d6ff; --syn-comment:#8b949e; --syn-number:#79c0ff; --syn-const:#79c0ff; --syn-function:#d2a8ff; --syn-type:#ffa657; --syn-variable:#79c0ff; --syn-tag:#7ee787; --syn-attr:#79c0ff; }
"#;

#[cfg(test)]
mod tests {
    use super::*;

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
}
