use crate::core::{config as config_store, export, file, large_doc, markdown, search, serve, theme, watch};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    Ok(dir.join("config.json"))
}

// Native dialog callbacks are dispatched on the main thread, while sync
// commands *run* on the main thread — awaiting them there deadlocks (frozen
// window on macOS). So every dialog command is async and blocks a worker
// thread on the reply channel instead.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .pick_folder(move |fp| {
            let _ = tx.send(fp.map(|f| f.into_path()).transpose());
        });
    let picked: Option<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|_| "dialog closed".to_string())?
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(picked.map(|p| dunce::simplified(&p).to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn pick_file(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("所有文件", &["*"])
        .pick_file(move |fp| {
            let _ = tx.send(fp.map(|f| f.into_path()).transpose());
        });
    let picked: Option<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|_| "dialog closed".to_string())?
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(picked.map(|p| dunce::simplified(&p).to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn pick_image(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter(
            "图片",
            &["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif"],
        )
        .pick_file(move |fp| {
            let _ = tx.send(fp.map(|f| f.into_path()).transpose());
        });
    let picked: Option<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|_| "dialog closed".to_string())?
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(picked.map(|p| dunce::simplified(&p).to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn load_tree(root: String) -> Result<Vec<file::TreeNode>, String> {
    // Directory scan can take a while on big folders; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&root);
        if !path.is_dir() {
            return Err(format!("not a directory: {root}"));
        }
        Ok(file::build_tree(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_docs(
    root: String,
    query: String,
    case_sensitive: bool,
) -> Result<search::SearchOutcome, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(search::SearchOutcome::default());
    }
    let path = PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    tauri::async_runtime::spawn_blocking(move || Ok(search::search(&path, &query, case_sensitive)))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPayload {
    pub html: Option<String>,
    pub outline: Vec<markdown::OutlineItem>,
    pub text: String,
    pub encoding: String,
    pub eol: String,
    pub chunked: Option<large_doc::ChunkedDoc>,
}

/// Files above this size (bytes) use chunked rendering.
const CHUNKED_THRESHOLD: usize = 1_000_000;

#[tauri::command]
pub async fn open_doc(
    store: State<'_, crate::LargeDocStore>,
    path: String,
) -> Result<DocPayload, String> {
    let p = PathBuf::from(&path);
    let file_text = tauri::async_runtime::spawn_blocking(move || file::read_text(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let base_dir = Path::new(&path).parent().map(Path::to_path_buf);
    let text = file_text.text;

    if text.len() > CHUNKED_THRESHOLD {
        let token = hash_path(&path);
        let built = {
            let src = text.clone();
            tauri::async_runtime::spawn_blocking(move || large_doc::build(&src))
                .await
                .map_err(|e| e.to_string())?
        };
        let meta = built.meta(token);
        let mut chunks = built.chunks;
        for chunk in &mut chunks {
            chunk.html = markdown::rewrite_img_srcs(&chunk.html, base_dir.as_deref());
        }
        let mut docs = store.docs.lock().unwrap();
        docs.insert(
            token,
            large_doc::CachedDoc {
                path,
                source: text.clone(),
                chunks,
                outline: built.outline,
            },
        );
        Ok(DocPayload {
            html: None,
            outline: Vec::new(),
            text,
            encoding: file_text.encoding,
            eol: file_text.eol,
            chunked: Some(meta),
        })
    } else {
        let rendered = markdown::render_markdown(&text);
        let html = markdown::rewrite_img_srcs(&rendered.html, base_dir.as_deref());
        Ok(DocPayload {
            html: Some(html),
            outline: rendered.outline,
            text,
            encoding: file_text.encoding,
            eol: file_text.eol,
            chunked: None,
        })
    }
}

fn hash_path(path: &str) -> u32 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    (h.finish() & 0x7fff_ffff) as u32
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkOut {
    pub index: u32,
    pub html: String,
}

#[tauri::command]
pub fn render_chunks(
    store: State<'_, crate::LargeDocStore>,
    token: u32,
    start: u32,
    count: u32,
) -> Result<Vec<ChunkOut>, String> {
    let docs = store.docs.lock().unwrap();
    let doc = docs.get(&token).ok_or("文档未加载或已失效")?;
    let end = (start as usize + count as usize).min(doc.chunks.len());
    let begin = (start as usize).min(doc.chunks.len());
    Ok(doc.chunks[begin..end]
        .iter()
        .enumerate()
        .map(|(i, c)| ChunkOut {
            index: (begin + i) as u32,
            html: c.html.clone(),
        })
        .collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub bytes: usize,
    pub backup: Option<String>,
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    Ok(dir.join("backups"))
}

#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    path: String,
    text: String,
    encoding: String,
    eol: String,
) -> Result<SaveResult, String> {
    // Backup + encode + write can be slow for large docs; keep off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = PathBuf::from(&path);
        let backup =
            file::backup_file(&file_path, &backups_dir(&app)?, 10).map_err(|e| e.to_string())?;
        let bytes =
            file::write_text(&file_path, &text, &encoding, &eol).map_err(|e| e.to_string())?;
        Ok(SaveResult {
            bytes,
            backup: backup.map(|b| b.to_string_lossy().into_owned()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn watch_folder(
    app: AppHandle,
    state: State<'_, watch::WatchState>,
    root: String,
) -> Result<(), String> {
    watch::watch_folder(app, &state, Path::new(&root))
}

#[tauri::command]
pub fn stop_watch(state: State<'_, watch::WatchState>) {
    watch::stop_watch(&state);
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> Result<config_store::Config, String> {
    let path = config_path(&app)?;
    Ok(config_store::load(&path))
}

#[tauri::command]
pub fn save_config(
    app: AppHandle,
    config: config_store::Config,
) -> Result<(), String> {
    let path = config_path(&app)?;
    config_store::save(&path, &config)
}

#[tauri::command]
pub fn list_themes() -> Vec<theme::ThemeInfo> {
    theme::list()
}

#[tauri::command]
pub fn apply_theme(app: AppHandle, name: String) -> Result<theme::Theme, String> {
    let t = theme::get(&name).ok_or_else(|| format!("unknown theme: {name}"))?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_theme(Some(if t.dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }));
    }
    Ok(t)
}

// ---------- export ----------

#[tauri::command]
pub async fn pick_export_path(
    app: AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("HTML", &["html"])
        .set_file_name(&default_name)
        .save_file(move |fp| {
            let _ = tx.send(fp.map(|f| f.into_path()).transpose());
        });
    let picked: Option<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|_| "dialog closed".to_string())?
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(picked.map(|p| dunce::simplified(&p).to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn export_html(
    app: AppHandle,
    source_path: String,
    out_path: String,
    theme_id: String,
    inline_mermaid: bool,
) -> Result<usize, String> {
    // Rendering + writing a full offline HTML is heavy; keep off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let source = file::read_text(Path::new(&source_path))
            .map_err(|e| e.to_string())?
            .text;
        let mermaid_js: Option<String> = if inline_mermaid {
            app.path()
                .resource_dir()
                .ok()
                .and_then(|dir| std::fs::read_to_string(dir.join("resources/mermaid.min.js")).ok())
        } else {
            None
        };
        let title = Path::new(&source_path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "文档".to_string());
        let html = export::export_html(
            &source,
            mermaid_js.as_deref(),
            &export::ExportOptions { theme_id, title },
        );
        let bytes = html.len();
        std::fs::write(&out_path, html).map_err(|e| format!("写入失败: {e}"))?;
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- preview server ----------

#[tauri::command]
pub fn set_current_file(state: State<'_, crate::AppState>, path: Option<String>) {
    *state.current_file.lock().unwrap() = path;
}

/// Enter/leave OS fullscreen. On Windows/Linux the native menu bar belongs
/// to the window frame, so it is hidden while fullscreen; on macOS the menu
/// bar auto-hides in fullscreen and hide/show_menu are no-ops.
#[tauri::command]
pub async fn set_fullscreen(
    window: tauri::WebviewWindow,
    fullscreen: bool,
) -> Result<(), String> {
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
    if fullscreen {
        let _ = window.hide_menu();
    } else {
        let _ = window.show_menu();
    }
    Ok(())
}

#[tauri::command]
pub fn serve_status(state: State<'_, crate::AppState>) -> Option<String> {
    state.serve.lock().unwrap().as_ref().map(|h| h.url.clone())
}

#[tauri::command]
pub async fn serve_start(
    state: State<'_, crate::AppState>,
    port: u16,
    lan: bool,
) -> Result<String, String> {
    {
        let guard = state.serve.lock().unwrap();
        if let Some(h) = guard.as_ref() {
            return Ok(h.url.clone());
        }
    }
    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let shared = Arc::new(serve::Shared {
        current_file: state.current_file.clone(),
    });
    let url = serve::start(shared, host.to_string(), port, shutdown_rx).await?;
    *state.serve.lock().unwrap() = Some(serve::ServeHandle::new(url.clone(), shutdown_tx));
    Ok(url)
}

#[tauri::command]
pub fn serve_stop(state: State<'_, crate::AppState>) {
    serve::stop(state.serve.lock().unwrap().take());
}
