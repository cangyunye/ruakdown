use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};

mod commands;
mod core;

pub struct AppState {
    pub current_file: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    pub serve: std::sync::Mutex<Option<core::serve::ServeHandle>>,
    /// File path requested by the launching process (double-clicked .md),
    /// consumed by the frontend once the session restore has finished.
    pub pending_open: std::sync::Mutex<Option<String>>,
}

/// First argument that points to an existing markdown file — the file the
/// user double-clicked. Program name and flags (there are none) can never
/// match because they are not .md files on disk, so scanning all args is
/// safe whether or not argv[0] is included by the caller.
pub fn pick_file_arg(args: &[String]) -> Option<String> {
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

#[derive(Default)]
pub struct LargeDocStore {
    pub docs: std::sync::Mutex<std::collections::HashMap<u32, core::large_doc::CachedDoc>>,
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
            serve: std::sync::Mutex::new(None),
            pending_open: std::sync::Mutex::new(pick_file_arg(
                &std::env::args().collect::<Vec<_>>(),
            )),
        })
        .manage(LargeDocStore::default())
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
            let mi_mode_read =
                MenuItem::with_id(handle, "mode-read", "阅读视图", true, None::<&str>)?;
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
                .item(&mi_search)
                .separator()
                .item(&mi_mode_read)
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

            let mi_serve_local = MenuItem::with_id(
                handle,
                "serve-local",
                "启动预览服务 (本机)",
                true,
                None::<&str>,
            )?;
            let mi_serve_lan = MenuItem::with_id(
                handle,
                "serve-lan",
                "启动预览服务 (局域网, 需防火墙授权)",
                true,
                None::<&str>,
            )?;
            let mi_serve_stop =
                MenuItem::with_id(handle, "serve-stop", "停止预览服务", true, None::<&str>)?;
            let mi_serve_open = MenuItem::with_id(
                handle,
                "serve-open",
                "在浏览器打开预览",
                true,
                None::<&str>,
            )?;
            let serve_menu = SubmenuBuilder::new(handle, "服务")
                .item(&mi_serve_local)
                .item(&mi_serve_lan)
                .item(&mi_serve_stop)
                .separator()
                .item(&mi_serve_open)
                .build()?;

            let about_item =
                PredefinedMenuItem::about(handle, Some("关于 Ruakdown"), None)?;
            let help_menu = SubmenuBuilder::new(handle, "帮助")
                .item(&about_item)
                .build()?;

            let menu = MenuBuilder::new(handle)
                .items(&[&file_menu, &view_menu, &theme_menu, &serve_menu, &help_menu])
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_folder,
            commands::pick_file,
            commands::pick_image,
            commands::load_tree,
            commands::search_docs,
            commands::open_doc,
            commands::render_chunks,
            commands::save_file,
            commands::watch_folder,
            commands::stop_watch,
            commands::resolve_link,
            commands::take_pending_open,
            commands::get_config,
            commands::save_config,
            commands::list_themes,
            commands::apply_theme,
            commands::pick_export_path,
            commands::export_html,
            commands::set_current_file,
            commands::set_fullscreen,
            commands::serve_status,
            commands::serve_start,
            commands::serve_stop,
        ])
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
}
