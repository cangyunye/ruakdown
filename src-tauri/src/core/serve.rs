use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, State as AxumState};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, watch};

const TOKEN_COOKIE: &str = "rdk_t";

/// How the server forwards remote-viewer messages into the local app.
/// A trait (rather than a concrete `AppHandle`) keeps the router testable.
pub trait RemoteEventSink: Send + Sync {
    fn emit_scroll(&self, value: serde_json::Value);
    fn emit_edit(&self, value: serde_json::Value);
}

/// Everything the share server and the app commands share.
pub struct Shared {
    pub current_file: Arc<Mutex<Option<String>>>,
    /// Per-start random token; every request must present it (`?t=` or cookie).
    pub token: String,
    /// Remote viewers may participate in two-way scroll sync.
    pub can_follow: bool,
    /// Remote viewers may edit the document (applied + saved locally).
    pub can_edit: bool,
    /// Bundled mermaid.js served at /vendor/mermaid.min.js (offline sharing).
    pub mermaid_js: Option<PathBuf>,
    /// Fan-out channel to every connected viewer.
    pub tx: broadcast::Sender<String>,
    /// Local dirty flag mirrored from the frontend via `serve_set_dirty`.
    pub dirty: AtomicBool,
    /// Sink for remote viewer events.
    pub sink: Arc<dyn RemoteEventSink>,
    /// Single-slot render cache keyed by (path, mtime+size signature).
    pub cache: Mutex<Option<CacheEntry>>,
}

pub struct CacheEntry {
    pub path: String,
    pub sig: String,
    pub doc: Arc<ApiDoc>,
}

pub struct ServeHandle {
    pub url: String,
    pub shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
}

impl ServeHandle {
    pub fn new(url: String, shared: Arc<Shared>, shutdown: watch::Sender<bool>) -> Self {
        Self {
            url,
            shared,
            shutdown,
        }
    }
}

pub fn stop(handle: Option<ServeHandle>) {
    if let Some(h) = handle {
        let _ = h.shutdown.send(true);
    }
}

/// 128-bit token from time + pid + ASLR entropy. Not cryptographic, but
/// unguessable for LAN peers who don't know the process start time.
pub fn gen_token() -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut h);
    std::process::id().hash(&mut h);
    let probe = 0u8;
    (&probe as *const u8 as usize).hash(&mut h);
    let a = h.finish();
    let mut h2 = std::collections::hash_map::DefaultHasher::new();
    a.hash(&mut h2);
    std::time::SystemTime::now().hash(&mut h2);
    let b = h2.finish();
    format!("{a:016x}{b:016x}")
}

/// Best-effort primary LAN IPv4 via the routing table (UDP connect does not
/// send a packet, it just resolves the outbound interface).
fn lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("223.5.5.5:80").ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}

/// Shareable URL: LAN mode advertises the machine's LAN address, and the
/// token rides in the query (the page promotes it to a cookie on load).
pub fn display_url(lan: bool, port: u16, token: &str) -> String {
    let host = if lan {
        lan_ip().unwrap_or_else(|| "127.0.0.1".to_string())
    } else {
        "127.0.0.1".to_string()
    };
    format!("http://{host}:{port}/?t={token}")
}

/// Bind and spawn the share server. `port` may be bumped (up to +10) when
/// occupied; the actually bound port is returned.
pub async fn start(
    shared: Arc<Shared>,
    host: String,
    port: u16,
    shutdown_rx: watch::Receiver<bool>,
) -> Result<u16, String> {
    let mut listener = None;
    let mut bound = port;
    let mut last_err = String::new();
    for p in port..=port.saturating_add(10) {
        match tokio::net::TcpListener::bind((host.as_str(), p)).await {
            Ok(l) => {
                listener = Some(l);
                bound = p;
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    let Some(listener) = listener else {
        return Err(format!("绑定 {host}:{port} 失败: {last_err}"));
    };
    // The OS may have reassigned the port (port 0, or an ephemeral bump).
    let bound = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(bound);

    let app = build_router(shared);

    // Spawn on the caller's runtime: the listener fd is registered with this
    // runtime's I/O driver, so the accept loop must live on the same one
    // (in the app this is tauri's runtime, which runs the commands).
    tokio::spawn(async move {
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
    Ok(bound)
}

/// All routes, wrapped in token auth. Split out of [`start`] so tests can
/// drive the router directly.
fn build_router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/api/doc", get(api_doc))
        .route("/static/{*path}", get(static_file))
        .route("/vendor/mermaid.min.js", get(vendor_mermaid))
        .route("/ws", get(ws_upgrade))
        .layer(middleware::from_fn_with_state(shared.clone(), auth))
        .with_state(shared)
}

/// Every route requires the token (query `t=` promotes to a cookie so img/WS
/// subrequests authenticate transparently). No CORS headers: the share page
/// is same-origin, and browsers on other origins must not be able to read.
async fn auth(
    AxumState(shared): AxumState<Arc<Shared>>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let (ok, promote_cookie) = check_token(&shared.token, req.uri(), req.headers());
    if !ok {
        return (
            StatusCode::UNAUTHORIZED,
            "缺少或错误的访问令牌,请使用完整分享链接 (?t=...) 打开",
        )
            .into_response();
    }
    let mut res = next.run(req).await;
    if promote_cookie {
        if let Ok(v) = header::HeaderValue::from_str(&format!(
            "{TOKEN_COOKIE}={}; Path=/; SameSite=Lax",
            shared.token
        )) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res
}

/// Returns (authorized, should_set_cookie).
fn check_token(token: &str, uri: &axum::http::Uri, headers: &HeaderMap) -> (bool, bool) {
    let query_token = uri.query().and_then(|q| {
        q.split('&').find_map(|pair| {
            let mut it = pair.splitn(2, '=');
            if it.next()? == "t" {
                it.next().map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
            } else {
                None
            }
        })
    });
    let cookie_token = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).and_then(
        |c| {
            c.split(';').find_map(|pair| {
                let mut it = pair.trim().splitn(2, '=');
                if it.next()? == TOKEN_COOKIE {
                    it.next().map(|s| s.trim().to_string())
                } else {
                    None
                }
            })
        },
    );
    let query_ok = query_token.as_deref() == Some(token);
    let cookie_ok = cookie_token.as_deref() == Some(token);
    (query_ok || cookie_ok, query_ok && !cookie_ok)
}

fn etag_matches(headers: &HeaderMap, sig: &str) -> bool {
    headers.get_all(header::IF_NONE_MATCH).iter().any(|v| {
        v.to_str()
            .map(|s| s.split(',').any(|c| c.trim() == sig || c.trim() == "*"))
            .unwrap_or(false)
    })
}

fn file_sig(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("\"{mtime:x}-{}\"", meta.len())
}

async fn root() -> Html<&'static str> {
    Html(SERVE_PAGE)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareOutline {
    level: u8,
    text: String,
    id: String,
}

/// Viewer-facing block entry: source line + owning heading, the coordinates
/// used for cross-pipeline scroll sync (block indices are pipeline-local and
/// deliberately not shared with the app's preview builds).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockBrief {
    line: u32,
    heading: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiDoc {
    title: String,
    html: String,
    file: Option<String>,
    /// Raw markdown so enabled viewers can edit.
    text: String,
    outline: Vec<ShareOutline>,
    blocks: Vec<BlockBrief>,
    can_edit: bool,
    dirty: bool,
}

fn doc_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

async fn api_doc(AxumState(shared): AxumState<Arc<Shared>>, headers: HeaderMap) -> Response {
    let current = shared.current_file.lock().unwrap().clone();
    let Some(path) = current else {
        return doc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "当前没有打开的文档",
        );
    };
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) => m,
        Err(_) => return doc_error(StatusCode::NOT_FOUND, "文档读取失败或已被移动"),
    };
    let sig = file_sig(&meta);
    if etag_matches(&headers, &sig) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, sig)]).into_response();
    }
    if let Some(hit) = shared.cache.lock().unwrap().as_ref() {
        if hit.path == path && hit.sig == sig {
            return (([(header::ETAG, sig)], Json(hit.doc.clone()))).into_response();
        }
    }
    let can_edit = shared.can_edit;
    let dirty = shared.dirty.load(Ordering::Relaxed);
    let p = path.clone();
    let task = tauri::async_runtime::spawn_blocking(move || build_api_doc(Path::new(&p), can_edit, dirty))
        .await;
    match task {
        Ok(Ok(doc)) => {
            let doc = Arc::new(doc);
            *shared.cache.lock().unwrap() = Some(CacheEntry {
                path,
                sig: sig.clone(),
                doc: doc.clone(),
            });
            (([(header::ETAG, sig)], Json(doc))).into_response()
        }
        Ok(Err(_)) | Err(_) => doc_error(StatusCode::NOT_FOUND, "文档读取失败或已被移动"),
    }
}

/// Full share render: the same block assembler the app uses (so the HTML
/// carries `data-bi` anchors), then relative images rewritten to /static/.
fn build_api_doc(path: &Path, can_edit: bool, dirty: bool) -> Result<ApiDoc, String> {
    let ft = crate::core::file::read_text(path).map_err(|e| e.to_string())?;
    let doc = crate::core::large_doc::build_reader(&ft.text, None);
    let mut joined = String::new();
    for c in &doc.chunks {
        joined.push_str(&c.html);
    }
    let html = crate::core::markdown::rewrite_img_srcs_http(&joined, path.parent());
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "文档".to_string());
    Ok(ApiDoc {
        title,
        html,
        file: Some(path.to_string_lossy().into_owned()),
        text: ft.text,
        outline: doc
            .outline
            .iter()
            .map(|o| ShareOutline {
                level: o.level,
                text: o.text.clone(),
                id: o.id.clone(),
            })
            .collect(),
        blocks: doc
            .blocks
            .iter()
            .map(|b| BlockBrief {
                line: b.start_line,
                heading: b.heading_id.clone(),
            })
            .collect(),
        can_edit,
        dirty,
    })
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
/// rejected; responses are sandboxed (no script execution when navigated to
/// directly) and carry an ETag so viewers revalidate instead of re-downloading.
async fn static_file(
    AxumState(shared): AxumState<Arc<Shared>>,
    headers: HeaderMap,
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
    let meta = match tokio::fs::metadata(&canon).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let sig = file_sig(&meta);
    if etag_matches(&headers, &sig) {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, sig),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
        )
            .into_response();
    }
    match tokio::fs::read(&canon).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, ct),
                (header::ETAG, sig.as_str()),
                (header::CACHE_CONTROL, "no-cache"),
                (header::CONTENT_SECURITY_POLICY, "sandbox"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// Bundled mermaid.js so diagram rendering works without internet access.
async fn vendor_mermaid(AxumState(shared): AxumState<Arc<Shared>>) -> Response {
    let Some(path) = shared.mermaid_js.clone() else {
        return (StatusCode::NOT_FOUND, "not bundled").into_response();
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
                (header::CACHE_CONTROL, "public, max-age=86400"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn ws_upgrade(AxumState(shared): AxumState<Arc<Shared>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| ws_loop(shared, socket))
}

async fn ws_loop(shared: Arc<Shared>, mut socket: WebSocket) {
    let mut rx = shared.tx.subscribe();
    loop {
        tokio::select! {
            out = rx.recv() => {
                match out {
                    Ok(msg) => {
                        if socket.send(Message::text(msg)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => handle_client_msg(&shared, &txt),
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
        }
    }
}

/// Viewer → app messages. Viewer scroll only ever reaches the local app
/// (never other viewers) — the local app is the hub of the star topology.
fn handle_client_msg(shared: &Shared, txt: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(txt) else {
        return;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("scroll") if shared.can_follow => shared.sink.emit_scroll(v),
        Some("edit") if shared.can_edit => shared.sink.emit_edit(v),
        _ => {}
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
<title>Ruakdown 分享</title>
<style>
:root { --bg:#ffffff; --panel:#f6f8fa; --border:#d1d9e0; --text:#1f2328; --muted:#59636e;
  --heading:#1f2328; --link:#0969da; --accent:#0969da; --accent-soft:rgba(9,105,218,.12);
  --code-bg:#f0f2f5; --code-text:#1f2328; --pre-bg:#f6f8fa; --pre-border:#e4e8ec;
  --quote-border:#d1d9e0; --quote-text:#59636e; --table-border:#d1d9e0; --mermaid-bg:#ffffff;
  --mask:rgba(31,35,40,.45);
  --syn-keyword:#cf222e; --syn-string:#0a3069; --syn-comment:#6e7781; --syn-number:#0550ae;
  --syn-const:#0550ae; --syn-function:#8250df; --syn-type:#953800; --syn-variable:#0550ae;
  --syn-tag:#116329; --syn-attr:#0550ae; }
@media (prefers-color-scheme: dark) {
:root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e;
  --heading:#e6edf3; --link:#4493f8; --accent:#4493f8; --accent-soft:rgba(68,147,248,.18);
  --code-bg:#1c2129; --code-text:#e6edf3; --pre-bg:#161b22; --pre-border:#30363d;
  --quote-border:#30363d; --quote-text:#8b949e; --table-border:#30363d; --mermaid-bg:#161b22;
  --mask:rgba(0,0,0,.55);
  --syn-keyword:#ff7b72; --syn-string:#a5d6ff; --syn-comment:#8b949e; --syn-number:#79c0ff;
  --syn-const:#79c0ff; --syn-function:#d2a8ff; --syn-type:#ffa657; --syn-variable:#79c0ff;
  --syn-tag:#7ee787; --syn-attr:#79c0ff; }
}
* { box-sizing: border-box; }
body { margin:0; font-family:"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
  font-size:15px; background:var(--bg); color:var(--text); }
#bar { position:sticky; top:0; z-index:10; padding:8px 16px; background:var(--panel);
  border-bottom:1px solid var(--border); color:var(--muted); font-size:13px;
  display:flex; gap:8px; align-items:center; }
#bar .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#bar button { border:1px solid var(--border); background:var(--bg); color:var(--text);
  border-radius:6px; padding:3px 10px; font-size:12px; cursor:pointer; flex:none; }
#bar button:hover { border-color:var(--accent); color:var(--accent); }
#bar button.on { background:var(--accent-soft); border-color:var(--accent); color:var(--accent); }
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
#doc img { max-width:100%; height:auto; max-height:60vh; object-fit:contain; }
.mermaid-block { margin:1em 0; padding:12px; background:var(--mermaid-bg);
  border:1px solid var(--border); border-radius:8px; text-align:center; }
.mermaid-block svg { max-width:100%; }
#toc { position:fixed; top:48px; right:12px; width:280px; max-height:72vh; overflow:auto;
  background:var(--panel); border:1px solid var(--border); border-radius:10px;
  padding:10px 12px; display:none; z-index:20; font-size:13px; }
#toc.open { display:block; }
#toc a { display:block; color:var(--text); text-decoration:none; padding:4px 0;
  cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#toc a:hover { color:var(--accent); }
#toc a.lv2 { padding-left:14px; }
#toc a.lv3 { padding-left:28px; font-size:12px; }
#toc a.lv4 { padding-left:42px; font-size:12px; color:var(--muted); }
#editwrap { position:fixed; inset:0; background:var(--mask); display:none; z-index:30;
  padding:4vh 4vw; }
#editwrap.open { display:flex; }
#editbox { display:flex; flex-direction:column; width:100%; background:var(--bg);
  border:1px solid var(--border); border-radius:10px; overflow:hidden;
  box-shadow:0 12px 40px rgba(0,0,0,.25); }
#editbox header { padding:8px 14px; border-bottom:1px solid var(--border); display:flex;
  gap:8px; align-items:center; color:var(--muted); font-size:13px; }
#editbox header .grow { flex:1; }
#editbox header button { border:1px solid var(--border); background:var(--bg);
  color:var(--text); border-radius:6px; padding:4px 12px; font-size:12px; cursor:pointer; }
#editbox header button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
#editbox textarea { flex:1; resize:none; border:0; outline:0; padding:14px;
  font:13px/1.6 Consolas,monospace; color:var(--text); background:transparent; }
#toast { position:fixed; left:50%; bottom:32px; transform:translateX(-50%);
  background:var(--text); color:var(--bg); padding:8px 16px; border-radius:8px;
  font-size:13px; opacity:0; transition:opacity .25s; pointer-events:none; z-index:40;
  max-width:80vw; }
#toast.show { opacity:.92; }
</style>
</head>
<body>
<div id="bar">
  <span id="title">Ruakdown 分享</span>
  <span id="status" class="grow">连接中…</span>
  <button id="tocbtn" type="button">目录</button>
  <button id="editbtn" type="button" style="display:none">编辑</button>
</div>
<div id="doc"></div>
<div id="toc"></div>
<div id="editwrap"><div id="editbox">
  <header><span>编辑文档(提交后由本机确认写入)</span><span class="grow"></span>
    <button id="editcancel" type="button">取消</button>
    <button id="editsave" type="button" class="primary">提交修改</button>
  </header>
  <textarea id="editarea" spellcheck="false"></textarea>
</div></div>
<div id="toast"></div>
<script src="/vendor/mermaid.min.js" onerror="var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.min.js';document.head.appendChild(s);"></script>
<script>
(function () {
  var docEl = document.getElementById('doc');
  var statusEl = document.getElementById('status');
  var titleEl = document.getElementById('title');
  var tocEl = document.getElementById('toc');
  var toastEl = document.getElementById('toast');
  var editBtn = document.getElementById('editbtn');
  var editWrap = document.getElementById('editwrap');
  var editArea = document.getElementById('editarea');

  var m = document.cookie.match(/(?:^|;\s*)rdk_t=([^;]+)/);
  var TOKEN = m ? m[1] : '';
  var st = { etag: null, blocks: [], headings: [], text: '', editing: false,
    followPause: 0, reportPause: 0, ws: null, wsUp: false, dirty: false };

  function toast(t) {
    toastEl.textContent = t;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  function setStatus(base) {
    statusEl.textContent = base + (st.dirty ? ' · 本机有未保存修改' : '');
  }

  function buildHeadings(blocks) {
    var cur = null, out = [];
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].heading) cur = blocks[i].heading;
      out[i] = cur;
    }
    return out;
  }

  function renderMermaid() {
    if (!window.mermaid) return;
    try {
      var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
    } catch (e) {}
    docEl.querySelectorAll('pre > code.language-mermaid').forEach(function (code, i) {
      var pre = code.parentElement;
      if (pre.dataset.mm === '1') return;
      pre.dataset.mm = '1';
      var div = document.createElement('div');
      div.className = 'mermaid-block';
      pre.after(div);
      window.mermaid.render('m' + i + '-' + Date.now(), code.textContent).then(function (r) {
        div.innerHTML = r.svg;
        pre.hidden = true;
      }).catch(function () {});
    });
  }

  function render(data) {
    document.title = data.title + ' - Ruakdown 分享';
    titleEl.textContent = data.title;
    docEl.innerHTML = data.html;
    st.blocks = data.blocks || [];
    st.headings = buildHeadings(st.blocks);
    st.text = data.text || '';
    st.dirty = !!data.dirty;
    editBtn.style.display = data.canEdit ? '' : 'none';
    buildToc(data.outline || []);
    setStatus('更新于 ' + new Date().toLocaleTimeString());
    renderMermaid();
  }

  function buildToc(outline) {
    tocEl.innerHTML = '';
    outline.forEach(function (o) {
      var a = document.createElement('a');
      a.textContent = o.text;
      a.className = o.level >= 4 ? 'lv4' : o.level === 3 ? 'lv3' : o.level === 2 ? 'lv2' : '';
      a.onclick = function () { jumpToHeading(o.id); tocEl.classList.remove('open'); };
      tocEl.appendChild(a);
    });
  }

  function jumpToHeading(id) {
    var el = document.getElementById(id);
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60);
  }

  function fetchDoc() {
    var opt = st.etag ? { headers: { 'If-None-Match': st.etag } } : {};
    return fetch('/api/doc', opt).then(function (res) {
      if (res.status === 304) return null;
      if (res.status === 401) { setStatus('访问令牌无效,请用分享链接重新打开'); return null; }
      if (!res.ok) { setStatus('暂无打开的文档或服务异常'); return null; }
      st.etag = res.headers.get('ETag');
      return res.json().then(render);
    }).catch(function () { setStatus('服务连接失败'); });
  }

  function connectWs() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try {
      st.ws = new WebSocket(proto + location.host + '/ws?t=' + encodeURIComponent(TOKEN));
    } catch (e) { setTimeout(connectWs, 2500); return; }
    st.ws.onopen = function () {
      st.wsUp = true;
      setStatus('已连接 · 更新于 ' + new Date().toLocaleTimeString());
    };
    st.ws.onclose = function () {
      st.wsUp = false;
      setStatus('已断开,重连中…');
      setTimeout(connectWs, 2500);
    };
    st.ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'changed') {
        if (!st.editing) fetchDoc();
      } else if (msg.type === 'scroll') {
        if (!st.editing && Date.now() > st.followPause) followRemote(msg);
      } else if (msg.type === 'dirty') {
        st.dirty = !!msg.value;
        setStatus(st.wsUp ? '已连接 · 更新于 ' + new Date().toLocaleTimeString() : '更新中…');
      } else if (msg.type === 'notice') {
        toast(msg.text || '');
      }
    };
  }

  function followRemote(msg) {
    st.reportPause = Date.now() + 900;
    if (msg.heading) {
      var el = document.getElementById(msg.heading);
      if (el) { window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60); return; }
    }
    if (msg.line != null) {
      var bi = 0;
      for (var i = 0; i < st.blocks.length; i++) {
        if (st.blocks[i].line <= msg.line) bi = i; else break;
      }
      var t = docEl.querySelector('[data-bi="' + bi + '"]');
      if (t) { window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 60); return; }
    }
    if (msg.frac != null) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, msg.frac * max);
    }
  }

  function topBi() {
    var els = docEl.querySelectorAll('[data-bi]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].getBoundingClientRect().bottom > 70) {
        return parseInt(els[i].getAttribute('data-bi'), 10);
      }
    }
    return els.length ? parseInt(els[els.length - 1].getAttribute('data-bi'), 10) : 0;
  }

  function report() {
    if (st.editing || !st.ws || st.ws.readyState !== 1) return;
    if (Date.now() < st.reportPause) return;
    var bi = topBi();
    var max = document.documentElement.scrollHeight - window.innerHeight;
    st.ws.send(JSON.stringify({
      type: 'scroll',
      line: st.blocks[bi] ? st.blocks[bi].line : null,
      heading: st.headings[bi] || null,
      frac: max > 0 ? document.documentElement.scrollTop / max : 0
    }));
  }

  var rptTimer = 0;
  window.addEventListener('scroll', function () {
    if (rptTimer) return;
    rptTimer = setTimeout(function () { rptTimer = 0; report(); }, 220);
  }, { passive: true });
  ['wheel', 'touchstart', 'keydown'].forEach(function (name) {
    window.addEventListener(name, function () { st.followPause = Date.now() + 4000; }, { passive: true });
  });

  document.getElementById('tocbtn').onclick = function () { tocEl.classList.toggle('open'); };
  editBtn.onclick = function () {
    if (!st.text) return;
    st.editing = true;
    editArea.value = st.text;
    editWrap.classList.add('open');
  };
  document.getElementById('editcancel').onclick = function () {
    st.editing = false;
    editWrap.classList.remove('open');
    fetchDoc();
  };
  document.getElementById('editsave').onclick = function () {
    if (!st.ws || st.ws.readyState !== 1) { toast('连接已断开,无法提交'); return; }
    st.ws.send(JSON.stringify({ type: 'edit', text: editArea.value }));
    st.editing = false;
    editWrap.classList.remove('open');
    toast('已提交,等待本机确认写入');
    fetchDoc();
  };

  if (TOKEN && !/(?:^|;\s*)rdk_t=/.test(document.cookie)) {
    document.cookie = 'rdk_t=' + TOKEN + '; path=/; SameSite=Lax';
  }
  fetchDoc();
  connectWs();
})();
</script>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_TOKEN: &str = "abcd1234";

    fn parts(uri: &str, cookie: Option<&str>) -> (axum::http::Uri, HeaderMap) {
        let mut headers = HeaderMap::new();
        if let Some(c) = cookie {
            headers.insert(header::COOKIE, header::HeaderValue::from_str(c).unwrap());
        }
        (uri.parse().unwrap(), headers)
    }

    #[test]
    fn token_via_query_cookie_or_missing() {
        let (uri, headers) = parts(&format!("/?t={TEST_TOKEN}"), None);
        let (ok, promote) = check_token(TEST_TOKEN, &uri, &headers);
        assert!(ok && promote, "query token authorizes and promotes to cookie");

        let (uri, headers) = parts("/", Some(&format!("{TOKEN_COOKIE}={TEST_TOKEN}")));
        let (ok, promote) = check_token(TEST_TOKEN, &uri, &headers);
        assert!(ok && !promote, "cookie token authorizes without re-promoting");

        let (uri, headers) = parts("/", None);
        assert!(!check_token(TEST_TOKEN, &uri, &headers).0, "missing token rejected");

        let (uri, headers) = parts("/?t=wrong", None);
        assert!(!check_token(TEST_TOKEN, &uri, &headers).0, "wrong token rejected");
    }

    #[test]
    fn etag_compare_handles_lists_and_star() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            header::HeaderValue::from_str("\"a\", \"b\"").unwrap(),
        );
        assert!(etag_matches(&headers, "\"b\""));
        assert!(!etag_matches(&headers, "\"c\""));
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, header::HeaderValue::from_static("*"));
        assert!(etag_matches(&headers, "\"anything\""));
    }

    #[test]
    fn content_type_lookup() {
        assert_eq!(content_type_for("a.PNG"), Some("image/png"));
        assert_eq!(content_type_for("x.webp"), Some("image/webp"));
        assert_eq!(content_type_for("noext"), None);
    }

    #[test]
    fn gen_token_is_long_and_unstable() {
        let a = gen_token();
        let b = gen_token();
        assert_eq!(a.len(), 32, "{a}");
        assert_ne!(a, b, "successive tokens must differ");
    }

    #[test]
    fn display_url_carries_lan_ip_or_fallback() {
        let url = display_url(false, 17630, "tok");
        assert!(url.starts_with("http://127.0.0.1:17630/?t=tok"), "{url}");
        let url = display_url(true, 17630, "tok");
        assert!(url.starts_with("http://"), "{url}");
        assert!(!url.contains("0.0.0.0"), "LAN URL must not advertise 0.0.0.0: {url}");
    }

    // ---- router integration ----

    use axum::body::Body;
    use axum::extract::Request;
    use tower::ServiceExt;

    fn test_shared(dir: &Path) -> Arc<Shared> {
        let (tx, _) = broadcast::channel(8);
        let doc = dir.join("doc.md");
        Arc::new(Shared {
            current_file: Arc::new(Mutex::new(Some(doc.to_string_lossy().into_owned()))),
            token: TEST_TOKEN.to_string(),
            can_follow: true,
            can_edit: true,
            mermaid_js: None,
            tx,
            dirty: AtomicBool::new(false),
            sink: Arc::new(RecordingSink::default()),
            cache: Mutex::new(None),
        })
    }

    #[derive(Default)]
    struct RecordingSink(std::sync::Mutex<Vec<String>>);

    impl RemoteEventSink for RecordingSink {
        fn emit_scroll(&self, value: serde_json::Value) {
            self.0.lock().unwrap().push(format!("scroll:{value}"));
        }
        fn emit_edit(&self, value: serde_json::Value) {
            self.0.lock().unwrap().push(format!("edit:{value}"));
        }
    }

    async fn serve(shared: Arc<Shared>, req: Request) -> axum::response::Response {
        build_router(shared).oneshot(req).await.unwrap()
    }

    fn get_req(path: &str, cookie: Option<&str>) -> Request {
        let mut builder = axum::http::Request::builder().uri(path);
        if let Some(c) = cookie {
            builder = builder.header(header::COOKIE, c);
        }
        builder.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn unauthorized_without_token() {
        let dir = std::env::temp_dir().join(format!("ruakdown-serve-t{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shared = test_shared(&dir);
        let res = serve(shared.clone(), get_req("/", None)).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let res = serve(shared.clone(), get_req("/api/doc?t=wrong", None)).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let res = serve(
            shared,
            get_req("/", Some(&format!("{TOKEN_COOKIE}={TEST_TOKEN}"))),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn doc_serves_rewritten_images_and_static_sandboxed() {
        let dir = std::env::temp_dir().join(format!("ruakdown-serve-d{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("doc.md"), "# 标题\n\n![图](./pic.png)\n\n正文\n").unwrap();
        std::fs::write(dir.join("pic.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        let shared = test_shared(&dir);
        let cookie = format!("{TOKEN_COOKIE}={TEST_TOKEN}");

        let res = serve(shared.clone(), get_req("/api/doc", Some(&cookie))).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::ETAG).map(|v| v.to_str().unwrap().len() > 2),
            Some(true)
        );
        let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let text = String::from_utf8_lossy(&body);
        // The html is embedded as a JSON string, so quotes arrive escaped.
        assert!(text.contains(r#"src=\"/static/pic.png\""#), "{text}");
        assert!(
            text.contains(r#"data-bi=\"0\""#),
            "block anchors must survive: {text}"
        );
        assert!(text.contains("\"canEdit\":true"), "{text}");

        let res = serve(
            shared.clone(),
            get_req("/static/pic.png", Some(&cookie)),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
        assert_eq!(
            res.headers().get(header::CONTENT_SECURITY_POLICY).unwrap(),
            "sandbox"
        );

        let res = serve(
            shared.clone(),
            get_req("/static/../secret.txt", Some(&cookie)),
        )
        .await;
        assert!(
            res.status() == StatusCode::FORBIDDEN || res.status() == StatusCode::NOT_FOUND,
            "traversal must be rejected"
        );

        // Conditional request revalidates to 304.
        let etag = {
            let cache = shared.cache.lock().unwrap();
            cache.as_ref().map(|c| c.sig.clone()).unwrap()
        };
        let mut req = get_req("/api/doc", Some(&cookie));
        req.headers_mut().insert(
            header::IF_NONE_MATCH,
            header::HeaderValue::from_str(&etag).unwrap(),
        );
        let res = serve(shared, req).await;
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
    }

    /// Live smoke over a real TCP listener (port 0 = random free port),
    /// speaking raw HTTP/1.1 against the production serve path.
    #[tokio::test]
    async fn live_server_smoke() {
        let dir = std::env::temp_dir().join(format!("ruakdown-serve-live{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("doc.md"),
            "# 冒烟\n\n![图](<./pic 一.png>)\n\n正文\n",
        )
        .unwrap();
        std::fs::write(dir.join("pic 一.png"), b"\x89PNG\r\n\x1a\n").unwrap();

        let (tx, _) = broadcast::channel(8);
        let doc = dir.join("doc.md");
        let shared = Arc::new(Shared {
            current_file: Arc::new(Mutex::new(Some(doc.to_string_lossy().into_owned()))),
            token: TEST_TOKEN.to_string(),
            can_follow: true,
            can_edit: true,
            mermaid_js: None,
            tx,
            dirty: AtomicBool::new(false),
            sink: Arc::new(RecordingSink::default()),
            cache: Mutex::new(None),
        });
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        let port = super::start(shared, "127.0.0.1".to_string(), 0, shutdown_rx)
            .await
            .unwrap();
        let cookie = format!("Cookie: {TOKEN_COOKIE}={TEST_TOKEN}");

        async fn raw(port: u16, req: &str) -> String {
            let mut s =
                tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            s.write_all(req.as_bytes()).await.unwrap();
            let mut buf = Vec::new();
            s.read_to_end(&mut buf).await.unwrap();
            String::from_utf8_lossy(&buf).into_owned()
        }

        // Share page with token → 200; without → 401.
        let res = raw(port, &format!("GET /?t={TEST_TOKEN} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")).await;
        assert!(res.starts_with("HTTP/1.1 200"), "{}", &res[..60.min(res.len())]);
        let res =
            raw(port, "GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n").await;
        assert!(res.starts_with("HTTP/1.1 401"));

        // Doc API: rewritten image URL + block anchors.
        let res = raw(
            port,
            &format!(
                "GET /api/doc HTTP/1.1\r\nHost: t\r\n{cookie}\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(res.starts_with("HTTP/1.1 200"));
        assert!(res.to_ascii_lowercase().contains("etag:"));
        assert!(res.contains(r#"src=\"/static/pic%20%E4%B8%80.png\""#), "{res}");

        // Static image: encoded space resolves, sandboxed, typed.
        let res = raw(
            port,
            &format!(
                "GET /static/pic%20%E4%B8%80.png HTTP/1.1\r\nHost: t\r\n{cookie}\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(res.starts_with("HTTP/1.1 200"));
        let lower = res.to_ascii_lowercase();
        assert!(lower.contains("content-type: image/png"));
        assert!(lower.contains("content-security-policy: sandbox"));

        // WS route without token → 401 before any upgrade (Connection: close
        // so the client can read to EOF).
        let res = raw(
            port,
            "GET /ws HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(res.starts_with("HTTP/1.1 401"), "{}", &res[..60.min(res.len())]);
    }
}
