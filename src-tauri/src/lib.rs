use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};

mod commands;
mod core;

pub struct AppState {
    pub current_file: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// Share server handle; only present in `--features share` builds (the
    /// lightweight build has no server and no share menu).
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
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
        .setup(|app| {
            let handle = app.handle();

            let mi_open_folder =
                MenuItem::with_id(handle, "open-folder", "打开文件夹", true, Some("CmdOrCtrl+Shift+O"))?;
            let mi_open_file =
                MenuItem::with_id(handle, "open-file", "打开文件", true, Some("CmdOrCtrl+O"))?;
            let mi_save =
                MenuItem::with_id(handle, "save", "保存", true, Some("CmdOrCtrl+S"))?;
            let mi_export =
                MenuItem::with_id(handle, "export-html", "导出 HTML...", true, Some("CmdOrCtrl+E"))?;
            let file_menu = SubmenuBuilder::new(handle, "文件")
                .item(&mi_open_folder)
                .item(&mi_open_file)
                .separator()
                .item(&mi_save)
                .separator()
                .item(&mi_export)
                .separator()
                .quit()
                .build()?;

            let mi_search = MenuItem::with_id(
                handle,
                "search-dir",
                "目录内搜索...",
                true,
                Some("CmdOrCtrl+Shift+F"),
            )?;
            let mi_find = MenuItem::with_id(
                handle,
                "find",
                "查找...",
                true,
                Some("CmdOrCtrl+F"),
            )?;
            let mi_replace = MenuItem::with_id(
                handle,
                "replace",
                "替换...",
                true,
                Some("CmdOrCtrl+R"),
            )?;
            let mi_mode_read =
                MenuItem::with_id(handle, "mode-read", "阅读视图", true, None::<&str>)?;
            let mi_mode_split =
                MenuItem::with_id(handle, "mode-split", "分屏模式", true, None::<&str>)?;
            let mi_mode_edit =
                MenuItem::with_id(handle, "mode-edit", "源码模式", true, None::<&str>)?;
            let mi_sidebar = MenuItem::with_id(
                handle,
                "toggle-sidebar",
                "显示/隐藏侧边栏",
                true,
                None::<&str>,
            )?;
            let mi_zen = MenuItem::with_id(
                handle,
                "toggle-zen",
                "专注模式",
                true,
                Some("CmdOrCtrl+Shift+Z"),
            )?;
            // F11 everywhere; on macOS F11 belongs to the system (Show
            // Desktop) and fullscreen follows the Ctrl+Cmd+F convention.
            #[cfg(target_os = "macos")]
            let fullscreen_accel: Option<&str> = Some("Ctrl+Cmd+F");
            #[cfg(not(target_os = "macos"))]
            let fullscreen_accel: Option<&str> = Some("F11");
            let mi_fullscreen = MenuItem::with_id(
                handle,
                "toggle-fullscreen",
                "全屏模式",
                true,
                fullscreen_accel,
            )?;
            let view_menu = SubmenuBuilder::new(handle, "视图")
                .item(&mi_find)
                .item(&mi_replace)
                .item(&mi_search)
                .separator()
                .item(&mi_mode_read)
                .item(&mi_mode_split)
                .item(&mi_mode_edit)
                .separator()
                .item(&mi_zen)
                .item(&mi_fullscreen)
                .separator()
                .item(&mi_sidebar)
                .build()?;

            let mi_theme_light =
                MenuItem::with_id(handle, "theme-light", "浅色", true, None::<&str>)?;
            let mi_theme_dark =
                MenuItem::with_id(handle, "theme-dark", "暗色", true, None::<&str>)?;
            let mi_theme_graphite =
                MenuItem::with_id(handle, "theme-graphite", "石墨", true, None::<&str>)?;
            let mi_theme_sunset_coast = MenuItem::with_id(
                handle,
                "theme-sunset-coast",
                "夕阳海岸",
                true,
                None::<&str>,
            )?;
            let mi_theme_verdant =
                MenuItem::with_id(handle, "theme-verdant", "无边绿意", true, None::<&str>)?;
            let mi_theme_sky =
                MenuItem::with_id(handle, "theme-sky", "蓝天白云", true, None::<&str>)?;
            let mi_theme_newsprint =
                MenuItem::with_id(handle, "theme-newsprint", "陈旧报纸", true, None::<&str>)?;
            let mi_theme_plum_wine =
                MenuItem::with_id(handle, "theme-plum-wine", "青梅煮酒", true, None::<&str>)?;
            let mi_theme_mountain_stream = MenuItem::with_id(
                handle,
                "theme-mountain-stream",
                "高山流水",
                true,
                None::<&str>,
            )?;
            let mi_theme_wudang =
                MenuItem::with_id(handle, "theme-wudang", "论道武当", true, None::<&str>)?;
            let theme_menu = SubmenuBuilder::new(handle, "主题")
                .item(&mi_theme_light)
                .item(&mi_theme_dark)
                .item(&mi_theme_graphite)
                .separator()
                .item(&mi_theme_sunset_coast)
                .item(&mi_theme_verdant)
                .item(&mi_theme_sky)
                .item(&mi_theme_newsprint)
                .separator()
                .item(&mi_theme_plum_wine)
                .item(&mi_theme_mountain_stream)
                .item(&mi_theme_wudang)
                .build()?;

            // The share menu (and the whole axum server behind it) only
            // exists in `--features share` builds.
            #[cfg(feature = "share")]
            let serve_menu = {
                let mi_serve_local = MenuItem::with_id(
                    handle,
                    "serve-local",
                    "本机预览服务",
                    true,
                    None::<&str>,
                )?;
                let mi_serve_lan = MenuItem::with_id(
                    handle,
                    "serve-lan",
                    "局域网分享 (只读, 需防火墙授权)",
                    true,
                    None::<&str>,
                )?;
                let mi_serve_lan_follow = MenuItem::with_id(
                    handle,
                    "serve-lan-follow",
                    "局域网分享 (同步浏览)",
                    true,
                    None::<&str>,
                )?;
                let mi_serve_lan_edit = MenuItem::with_id(
                    handle,
                    "serve-lan-edit",
                    "局域网分享 (协作编辑)",
                    true,
                    None::<&str>,
                )?;
                let mi_serve_stop =
                    MenuItem::with_id(handle, "serve-stop", "停止分享服务", true, None::<&str>)?;
                let mi_serve_open = MenuItem::with_id(
                    handle,
                    "serve-open",
                    "在浏览器打开分享页",
                    true,
                    None::<&str>,
                )?;
                SubmenuBuilder::new(handle, "服务")
                    .item(&mi_serve_local)
                    .separator()
                    .item(&mi_serve_lan)
                    .item(&mi_serve_lan_follow)
                    .item(&mi_serve_lan_edit)
                    .separator()
                    .item(&mi_serve_stop)
                    .item(&mi_serve_open)
                    .build()?
            };

            let about_item = PredefinedMenuItem::about(
                handle,
                Some("关于 Ruakdown"),
                Some(AboutMetadata {
                    name: Some("Ruakdown".into()),
                    // From the app package info, so it always matches the
                    // released version (tauri.conf.json `version`).
                    version: Some(handle.package_info().version.to_string()),
                    ..Default::default()
                }),
            )?;
            let mi_repo = MenuItem::with_id(
                handle,
                "open-repo",
                "GitHub 仓库",
                true,
                None::<&str>,
            )?;
            let mi_releases = MenuItem::with_id(
                handle,
                "open-releases",
                "检查更新 (Releases)...",
                true,
                None::<&str>,
            )?;
            let help_menu = SubmenuBuilder::new(handle, "帮助")
                .item(&about_item)
                .separator()
                .item(&mi_repo)
                .item(&mi_releases)
                .build()?;

            let mut menus: Vec<&dyn tauri::menu::IsMenuItem<_>> =
                vec![&file_menu, &view_menu, &theme_menu];
            #[cfg(feature = "share")]
            menus.push(&serve_menu);
            menus.push(&help_menu);
            let menu = MenuBuilder::new(handle).items(&menus).build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
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
