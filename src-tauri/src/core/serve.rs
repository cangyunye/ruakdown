use axum::extract::{Path as AxumPath, State as AxumState};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// Everything the preview server and the app commands share.
pub struct Shared {
    pub current_file: Arc<Mutex<Option<String>>>,
}

pub struct ServeHandle {
    pub url: String,
    shutdown: watch::Sender<bool>,
}

impl ServeHandle {
    pub fn new(url: String, shutdown: watch::Sender<bool>) -> Self {
        Self { url, shutdown }
    }
}

pub fn stop(handle: Option<ServeHandle>) {
    if let Some(h) = handle {
        let _ = h.shutdown.send(true);
    }
}

/// Bind and spawn the preview server. Returns the bound URL.
pub async fn start(
    shared: Arc<Shared>,
    host: String,
    port: u16,
    shutdown_rx: watch::Receiver<bool>,
) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .map_err(|e| format!("绑定 {host}:{port} 失败: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();

    let app = Router::new()
        .route("/", get(root))
        .route("/api/doc", get(api_doc))
        .route("/static/{*path}", get(static_file))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(shared);

    let url = format!("http://{addr}/");
    tauri::async_runtime::spawn(async move {
        let shutdown = async move {
            let mut rx = shutdown_rx;
            loop {
                if rx.changed().await.is_err() || *rx.borrow() {
                    break;
                }
            }
        };
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(shutdown)
            .await;
    });
    Ok(url)
}

async fn root() -> Html<&'static str> {
    Html(SERVE_PAGE)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiDoc {
    title: String,
    html: String,
    file: Option<String>,
}

async fn api_doc(AxumState(shared): AxumState<Arc<Shared>>) -> Response {
    let current = shared.current_file.lock().unwrap().clone();
    let Some(path) = current else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "当前没有打开的文档" })),
        )
            .into_response();
    };
    let task = tauri::async_runtime::spawn_blocking(move || -> Result<ApiDoc, String> {
        let ft = crate::core::file::read_text(Path::new(&path)).map_err(|e| e.to_string())?;
        let rendered = crate::core::markdown::render_markdown(&ft.text);
        let title = Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "文档".to_string());
        Ok(ApiDoc {
            title,
            html: rendered.html,
            file: Some(path),
        })
    })
    .await;
    match task {
        Ok(Ok(doc)) => Json(doc).into_response(),
        Ok(Err(_)) | Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "文档读取失败或已被移动" })),
        )
            .into_response(),
    }
}

const TEXT_EXT: &[(&str, &str)] = &[
    ("html", "text/html; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("js", "text/javascript; charset=utf-8"),
    ("svg", "image/svg+xml"),
    ("json", "application/json"),
];
const BINARY_EXT: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("ico", "image/x-icon"),
    ("bmp", "image/bmp"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("pdf", "application/pdf"),
];

/// Serve files that live next to (or under) the currently open document, so
/// relative images in the markdown resolve. Traversal outside the doc dir is
/// rejected.
async fn static_file(
    AxumState(shared): AxumState<Arc<Shared>>,
    AxumPath(raw): AxumPath<String>,
) -> Response {
    let decoded = percent_decode_str(&raw).decode_utf8_lossy().into_owned();
    if decoded.split(['/', '\\']).any(|seg| seg == "..") {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let current = shared.current_file.lock().unwrap().clone();
    let Some(current) = current else {
        return (StatusCode::NOT_FOUND, "no document open").into_response();
    };
    let Some(dir) = Path::new(&current).parent().map(Path::to_path_buf) else {
        return (StatusCode::NOT_FOUND, "no document dir").into_response();
    };
    let rel = decoded.trim_start_matches(['/', '\\']);
    let full: PathBuf = dir.join(rel);
    let (Ok(canon), Ok(dir_canon)) = (full.canonicalize(), dir.canonicalize()) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !canon.starts_with(&dir_canon) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Some(ct) = content_type_for(&name) else {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported type").into_response();
    };
    match tokio::fs::read(&canon).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, ct)], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

pub fn content_type_for(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    let ext = ext.as_deref()?;
    TEXT_EXT
        .iter()
        .chain(BINARY_EXT.iter())
        .find(|(e, _)| *e == ext)
        .map(|(_, t)| *t)
}

const SERVE_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ruakdown 预览</title>
<style>
:root { --bg:#ffffff; --panel:#f6f8fa; --border:#d1d9e0; --text:#1f2328; --muted:#59636e;
  --heading:#1f2328; --link:#0969da; --accent:#0969da; --accent-soft:rgba(9,105,218,.12);
  --code-bg:#f0f2f5; --code-text:#1f2328; --pre-bg:#f6f8fa; --pre-border:#e4e8ec;
  --quote-border:#d1d9e0; --quote-text:#59636e; --table-border:#d1d9e0; --mermaid-bg:#ffffff;
  --syn-keyword:#cf222e; --syn-string:#0a3069; --syn-comment:#6e7781; --syn-number:#0550ae;
  --syn-const:#0550ae; --syn-function:#8250df; --syn-type:#953800; --syn-variable:#0550ae;
  --syn-tag:#116329; --syn-attr:#0550ae; }
* { box-sizing: border-box; }
body { margin:0; font-family:"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
  font-size:15px; background:var(--bg); color:var(--text); }
#bar { padding:8px 16px; background:var(--panel); border-bottom:1px solid var(--border);
  color:var(--muted); font-size:13px; display:flex; justify-content:space-between; }
#doc { max-width:860px; margin:0 auto; padding:32px 48px 80px; line-height:1.75; }
#doc h1,#doc h2,#doc h3,#doc h4,#doc h5,#doc h6 { color:var(--heading); line-height:1.35; margin:1.6em 0 .6em; }
#doc h1 { font-size:1.9em; border-bottom:1px solid var(--border); padding-bottom:.3em; }
#doc h2 { font-size:1.5em; border-bottom:1px solid var(--border); padding-bottom:.25em; }
#doc a { color:var(--link); }
#doc code { font-family:Consolas,monospace; font-size:.9em; background:var(--code-bg);
  color:var(--code-text); padding:.15em .4em; border-radius:5px; }
#doc pre { background:var(--pre-bg); border:1px solid var(--pre-border); border-radius:8px;
  padding:14px 16px; overflow:auto; }
#doc pre code { background:transparent; color:var(--text); padding:0; }
#doc pre code .tok-keyword { color:var(--syn-keyword); }
#doc pre code .tok-string { color:var(--syn-string); }
#doc pre code .tok-comment { color:var(--syn-comment); font-style:italic; }
#doc pre code .tok-number { color:var(--syn-number); }
#doc pre code .tok-const { color:var(--syn-const); }
#doc pre code .tok-function { color:var(--syn-function); }
#doc pre code .tok-type { color:var(--syn-type); }
#doc pre code .tok-variable { color:var(--syn-variable); }
#doc pre code .tok-tag { color:var(--syn-tag); }
#doc pre code .tok-attr { color:var(--syn-attr); }
#doc blockquote { margin:1em 0; padding:.2em 1em; border-left:4px solid var(--quote-border);
  color:var(--quote-text); background:var(--panel); }
#doc table { border-collapse:collapse; margin:1em 0; width:100%; }
#doc th,#doc td { border:1px solid var(--table-border); padding:6px 12px; text-align:left; }
#doc th { background:var(--panel); }
#doc img { max-width:100%; }
.mermaid-block { margin:1em 0; padding:12px; background:var(--mermaid-bg);
  border:1px solid var(--border); border-radius:8px; text-align:center; }
.mermaid-block svg { max-width:100%; }
</style>
</head>
<body>
<div id="bar"><span id="title">Ruakdown 预览</span><span id="status">加载中…</span></div>
<div id="doc"></div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.min.js"></script>
<script>
async function load() {
  var status = document.getElementById("status");
  try {
    var res = await fetch("/api/doc");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    document.title = data.title + " - Ruakdown 预览";
    document.getElementById("title").textContent = data.title;
    document.getElementById("doc").innerHTML = data.html;
    status.textContent = "更新于 " + new Date().toLocaleTimeString();
    if (window.mermaid) {
      document.querySelectorAll("pre > code.language-mermaid").forEach(function (code, i) {
        var pre = code.parentElement;
        var div = document.createElement("div");
        div.className = "mermaid-block";
        pre.after(div);
        window.mermaid.render("m" + i + "-" + Date.now(), code.textContent).then(function (r) {
          div.innerHTML = r.svg;
          pre.hidden = true;
        }).catch(function () {});
      });
    }
  } catch (e) {
    status.textContent = "暂无打开的文档或服务异常";
  }
}
load();
setInterval(load, 3000);
</script>
</body>
</html>
"#;
