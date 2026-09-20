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
        body = rendered.html,
        mermaid_script = mermaid_script,
        dark = if theme.dark { "1" } else { "0" },
        scheme = scheme,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Mirror of the reader markdown styles (index.css) for standalone export.
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
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
  color: var(--heading); line-height: 1.35; margin: 1.6em 0 0.6em; font-weight: 650;
}
.md-body h1 { font-size: 1.9em; margin-top: 0.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.md-body h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
.md-body h3 { font-size: 1.25em; }
.md-frontmatter {
  margin: 0 0 1.6em; padding: 10px 14px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 8px; font-size: 13px; line-height: 1.6;
}
.md-frontmatter .fm-row { display: flex; gap: 12px; padding: 2px 0; align-items: baseline; }
.md-frontmatter .fm-key { flex: none; min-width: 88px; color: var(--muted); font-weight: 600; overflow-wrap: anywhere; }
.md-frontmatter .fm-val { color: var(--text); overflow-wrap: anywhere; }
.md-frontmatter .fm-title .fm-val { font-size: 1.5em; font-weight: 700; color: var(--heading); line-height: 1.4; padding-bottom: 2px; }
.md-frontmatter .fm-desc .fm-val { color: var(--muted); font-style: italic; }
.md-frontmatter .fm-items { display: flex; flex-direction: column; gap: 2px; }
.md-frontmatter .fm-item { display: block; }
.md-frontmatter .fm-pair-key { color: var(--muted); }
.md-frontmatter .fm-sep { color: var(--muted); }
.md-frontmatter .fm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.md-frontmatter .fm-chip { padding: 1px 10px; border-radius: 999px; border: 1px solid; font-size: 12px; line-height: 1.6; white-space: nowrap; }
.md-frontmatter .chip-0 { color: var(--chip-0); background: color-mix(in srgb, var(--chip-0) 12%, transparent); border-color: color-mix(in srgb, var(--chip-0) 30%, transparent); }
.md-frontmatter .chip-1 { color: var(--chip-1); background: color-mix(in srgb, var(--chip-1) 12%, transparent); border-color: color-mix(in srgb, var(--chip-1) 30%, transparent); }
.md-frontmatter .chip-2 { color: var(--chip-2); background: color-mix(in srgb, var(--chip-2) 14%, transparent); border-color: color-mix(in srgb, var(--chip-2) 30%, transparent); }
.md-frontmatter .chip-3 { color: var(--chip-3); background: color-mix(in srgb, var(--chip-3) 12%, transparent); border-color: color-mix(in srgb, var(--chip-3) 30%, transparent); }
.md-frontmatter .chip-4 { color: var(--chip-4); background: color-mix(in srgb, var(--chip-4) 12%, transparent); border-color: color-mix(in srgb, var(--chip-4) 30%, transparent); }
.md-frontmatter .chip-5 { color: var(--chip-5); background: color-mix(in srgb, var(--chip-5) 10%, transparent); border-color: color-mix(in srgb, var(--chip-5) 30%, transparent); }
.md-frontmatter .chip-6 { color: var(--chip-6); background: color-mix(in srgb, var(--chip-6) 12%, transparent); border-color: color-mix(in srgb, var(--chip-6) 30%, transparent); }
.md-frontmatter .chip-7 { color: var(--chip-7); background: color-mix(in srgb, var(--chip-7) 12%, transparent); border-color: color-mix(in srgb, var(--chip-7) 30%, transparent); }
.md-body p { margin: 0.8em 0; }
.md-body a { color: var(--link); text-decoration: none; }
.md-body a:hover { text-decoration: underline; }
.md-body code {
  font-family: "Cascadia Code", Consolas, "Courier New", monospace;
  font-size: 0.9em; background: var(--code-bg); color: var(--code-text);
  padding: 0.15em 0.4em; border-radius: 5px;
}
.md-body pre {
  background: var(--pre-bg); border: 1px solid var(--pre-border); border-radius: 8px;
  padding: 14px 16px; overflow: auto; line-height: 1.6;
}
.md-body pre code { background: transparent; color: var(--text); padding: 0; border-radius: 0; font-size: 0.88em; }
:root[data-scheme="light"] { --syn-keyword:#cf222e; --syn-string:#0a3069; --syn-comment:#6e7781; --syn-number:#0550ae; --syn-const:#0550ae; --syn-function:#8250df; --syn-type:#953800; --syn-variable:#0550ae; --syn-tag:#116329; --syn-attr:#0550ae; }
:root[data-scheme="dark"] { --syn-keyword:#ff7b72; --syn-string:#a5d6ff; --syn-comment:#8b949e; --syn-number:#79c0ff; --syn-const:#79c0ff; --syn-function:#d2a8ff; --syn-type:#ffa657; --syn-variable:#79c0ff; --syn-tag:#7ee787; --syn-attr:#79c0ff; }
.md-body pre code .tok-keyword { color: var(--syn-keyword); }
.md-body pre code .tok-string { color: var(--syn-string); }
.md-body pre code .tok-comment { color: var(--syn-comment); font-style: italic; }
.md-body pre code .tok-number { color: var(--syn-number); }
.md-body pre code .tok-const { color: var(--syn-const); }
.md-body pre code .tok-function { color: var(--syn-function); }
.md-body pre code .tok-type { color: var(--syn-type); }
.md-body pre code .tok-variable { color: var(--syn-variable); }
.md-body pre code .tok-tag { color: var(--syn-tag); }
.md-body pre code .tok-attr { color: var(--syn-attr); }
.md-body blockquote {
  margin: 1em 0; padding: 0.2em 1em; border-left: 4px solid var(--quote-border);
  color: var(--quote-text); background: var(--panel); border-radius: 0 6px 6px 0;
}
.md-body table { border-collapse: collapse; margin: 1em 0; width: 100%; }
.md-body th, .md-body td { border: 1px solid var(--table-border); padding: 6px 12px; text-align: left; }
.md-body th { background: var(--panel); }
.md-body tr:nth-child(2n) td { background: var(--panel); }
.md-body img { max-width: 100%; border-radius: 6px; }
.md-body hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
.md-body ul, .md-body ol { padding-left: 1.6em; margin: 0.8em 0; }
.md-body li { margin: 0.25em 0; }
.md-body input[type="checkbox"] { accent-color: var(--accent); margin-right: 0.4em; }
.mermaid-block {
  margin: 1em 0; padding: 12px; background: var(--mermaid-bg);
  border: 1px solid var(--border); border-radius: 8px; overflow: auto; text-align: center;
}
.mermaid-block svg { max-width: 100%; height: auto; }
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
    }
}
