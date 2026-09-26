use tauri::{Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

mod commands;
mod core;

pub struct AppState {
    pub current_file: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// Share server handle; only present in `--features share` builds (the
    /// lightweight build has no server and no share entries in the UI).
    #[cfg(feature = "share")]
    pub serve: std::sync::Mutex<Option<core::serve::ServeHandle>>,
    /// File path requested by the launching process (double-clicked .md),
    /// consumed by the frontend once the session restore has finished.
    pub pending_open: std::sync::Mutex<Option<String>>,
}

/// First argument that points to an existing markdown file — the file the
/// user double-clicked. Program name and flags (there are none) can never
/// match because they are not .md files on disk, so scanning all args is
/// safe whether or not argv[0] is included by the caller.
fn pick_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .find(|arg| {
            let p = std::path::Path::new(arg);
            matches!(
                p.extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .as_deref(),
                Some("md" | "markdown")
            ) && p.is_file()
        })
        .cloned()
}

/// Store the launch-file path and notify the frontend; keeps the window
/// focus/unminimize behaviour in one place.
fn deliver_open_file(app: &tauri::AppHandle, path: Option<String>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(p) = path {
            *app.state::<AppState>().pending_open.lock().unwrap() = Some(p.clone());
            let _ = window.emit("open-file-arg", p);
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// In-memory chunk cache for open large documents. Entries are keyed by the
/// path hash; insertion order is tracked so opening more than [`CAP`]
/// documents evicts the oldest instead of growing until process exit.
#[derive(Default)]
pub struct LargeDocStore {
    pub docs: std::sync::Mutex<std::collections::HashMap<u32, core::large_doc::CachedDoc>>,
    order: std::sync::Mutex<std::collections::VecDeque<u32>>,
}

impl LargeDocStore {
    /// Documents kept rendered at once. One is plenty for reading; a small
    /// cap absorbs quick back-and-forth switches without re-parsing.
    const CAP: usize = 3;

    /// Insert (or replace) a cached document, evicting the oldest entry when
    /// over capacity.
    pub fn insert_doc(&self, token: u32, doc: core::large_doc::CachedDoc) {
        let mut docs = self.docs.lock().unwrap();
        let mut order = self.order.lock().unwrap();
        let fresh = !docs.contains_key(&token);
        docs.insert(token, doc);
        if fresh {
            order.push_back(token);
            while docs.len() > Self::CAP {
                match order.pop_front() {
                    // `token` sits at the back of a non-empty queue, so the
                    // front can never be it; the guard just makes the bound
                    // obvious.
                    Some(oldest) if oldest != token => {
                        docs.remove(&oldest);
                    }
                    _ => break,
                }
            }
        }
        // Prune stale tokens so the queue cannot drift from the map.
        order.retain(|t| docs.contains_key(t));
    }
}

/// Single-slot preview cache behind the split editor+preview view. The
/// store sits in an Arc so commands can move it into spawn_blocking.
#[derive(Default)]
pub struct PreviewState {
    pub store: std::sync::Arc<std::sync::Mutex<core::preview::PreviewStore>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Second launch (e.g. double-clicking an .md in Explorer): focus the
            // existing window instead of starting a new process, and forward the
            // requested file so it actually opens.
            let file = pick_file_arg(&args);
            deliver_open_file(app, file);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // DECORATIONS must stay out of the saved/restored state: the window is
        // undecorated by config (the webview draws the single custom titlebar),
        // and a state file written by an older decorated build would otherwise
        // put the native frame back on top of it on every launch.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::DECORATIONS)
                .build(),
        )
        .manage(core::watch::WatchState::default())
        .manage(AppState {
            current_file: std::sync::Arc::new(std::sync::Mutex::new(None)),
            #[cfg(feature = "share")]
            serve: std::sync::Mutex::new(None),
            pending_open: std::sync::Mutex::new(pick_file_arg(
                &std::env::args().collect::<Vec<_>>(),
            )),
        })
        .manage(std::sync::Arc::new(LargeDocStore::default()))
        .manage(PreviewState::default())
        // The window is undecorated (tauri.conf.json `decorations: false`):
        // the webview draws a single custom titlebar with its own window
        // controls, replacing the native frame + native menu. All former
        // menu accelerators keep working through the webview capture-phase
        // shortcut handler (src/shortcuts.ts); tao keeps edge resizing and
        // native caption dragging (with snap/dblclick-maximize) working for
        // undecorated windows.
        .invoke_handler({
            #[cfg(feature = "share")]
            {
                tauri::generate_handler![
                    commands::pick_folder,
                    commands::pick_file,
                    commands::pick_image,
                    commands::load_tree,
                    commands::search_docs,
                    commands::open_doc,
                    commands::render_chunks,
                    commands::preview_update,
                    commands::preview_chunks,
                    commands::save_file,
                    commands::watch_folder,
                    commands::resolve_link,
                    commands::take_pending_open,
                    commands::get_config,
                    commands::save_config,
                    commands::apply_theme,
                    commands::mermaid_asset_path,
                    commands::pick_export_path,
                    commands::export_html,
                    commands::set_current_file,
                    commands::set_fullscreen,
                    commands::share_available,
                    commands::serve_start,
                    commands::serve_stop,
                    commands::serve_notify_change,
                    commands::serve_broadcast_scroll,
                    commands::serve_notice,
                    commands::serve_set_dirty,
                ]
            }
            #[cfg(not(feature = "share"))]
            {
                tauri::generate_handler![
                    commands::pick_folder,
                    commands::pick_file,
                    commands::pick_image,
                    commands::load_tree,
                    commands::search_docs,
                    commands::open_doc,
                    commands::render_chunks,
                    commands::preview_update,
                    commands::preview_chunks,
                    commands::save_file,
                    commands::watch_folder,
                    commands::resolve_link,
                    commands::take_pending_open,
                    commands::get_config,
                    commands::save_config,
                    commands::apply_theme,
                    commands::mermaid_asset_path,
                    commands::pick_export_path,
                    commands::export_html,
                    commands::set_current_file,
                    commands::set_fullscreen,
                    commands::share_available,
                ]
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS only: launched via Finder "Open With" / drag onto the dock
            // icon; the file arrives through this event instead of argv.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls, .. } = event {
                let file = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p: std::path::PathBuf| p.to_string_lossy().into_owned())
                    .find(|p| pick_file_arg(std::slice::from_ref(p)).is_some());
                deliver_open_file(app, file);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(dir: &str, name: &str) -> String {
        let path = std::env::temp_dir().join(format!("ruakdown-arg-{dir}-{name}"));
        std::fs::write(&path, b"# t").unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn pick_file_arg_ignores_empty_and_non_md_args() {
        assert_eq!(pick_file_arg(&[]), None);
        assert_eq!(pick_file_arg(&["/usr/bin/ruakdown".to_string()]), None);
        assert_eq!(
            pick_file_arg(&["/usr/bin/ruakdown".to_string(), "--flag".to_string()]),
            None
        );
        assert_eq!(
            pick_file_arg(&["/usr/bin/ruakdown".to_string(), "notes.txt".to_string()]),
            None
        );
    }

    #[test]
    fn pick_file_arg_requires_existing_file() {
        assert_eq!(
            pick_file_arg(&["ghost.md".to_string()]),
            None,
            "non-existent md must be rejected"
        );
    }

    #[test]
    fn pick_file_arg_finds_md_files() {
        let md = temp_file("md", "doc.md");
        let markdown = temp_file("md", "doc2.MARKDOWN");
        assert_eq!(pick_file_arg(&["exe".to_string(), md.clone()]), Some(md));
        // Program name itself is never a match; uppercase extensions count.
        assert_eq!(
            pick_file_arg(&[markdown.clone()]),
            Some(markdown),
            "argv[0]-less arg list still resolves"
        );
    }

    #[test]
    fn pick_file_arg_takes_first_match() {
        let first = temp_file("first", "a.md");
        let second = temp_file("first", "b.md");
        assert_eq!(
            pick_file_arg(&["exe".to_string(), first.clone(), second]),
            Some(first)
        );
    }

    #[test]
    fn large_doc_store_evicts_oldest_beyond_cap() {
        let store = LargeDocStore::default();
        for token in 1..=(LargeDocStore::CAP as u32 + 2) {
            store.insert_doc(
                token,
                core::large_doc::CachedDoc {
                    chunks: Vec::new(),
                    outline: Vec::new(),
                    blocks: Vec::new(),
                    reuse: None,
                },
            );
        }
        let docs = store.docs.lock().unwrap();
        assert_eq!(docs.len(), LargeDocStore::CAP);
        // Oldest tokens (1, 2) were evicted; the newest CAP survive.
        assert!(!docs.contains_key(&1));
        assert!(!docs.contains_key(&2));
        for token in 3..=(LargeDocStore::CAP as u32 + 2) {
            assert!(docs.contains_key(&token));
        }
    }

    #[test]
    fn large_doc_store_replace_does_not_evict_current() {
        let store = LargeDocStore::default();
        store.insert_doc(
            1,
            core::large_doc::CachedDoc {
                chunks: Vec::new(),
                outline: Vec::new(),
                blocks: Vec::new(),
                reuse: None,
            },
        );
        // Re-opening the same document replaces the entry, never evicts it.
        store.insert_doc(
            1,
            core::large_doc::CachedDoc {
                chunks: Vec::new(),
                outline: Vec::new(),
                blocks: Vec::new(),
                reuse: None,
            },
        );
        assert!(store.docs.lock().unwrap().contains_key(&1));
    }
}
