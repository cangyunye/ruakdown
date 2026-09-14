use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};

mod commands;
mod core;

pub struct AppState {
    pub current_file: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    pub serve: std::sync::Mutex<Option<core::serve::ServeHandle>>,
}

#[derive(Default)]
pub struct LargeDocStore {
    pub docs: std::sync::Mutex<std::collections::HashMap<u32, core::large_doc::CachedDoc>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch (e.g. double-clicking an .md in Explorer): focus the
            // existing window instead of starting a new process.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(core::watch::WatchState::default())
        .manage(AppState {
            current_file: std::sync::Arc::new(std::sync::Mutex::new(None)),
            serve: std::sync::Mutex::new(None),
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
            let view_menu = SubmenuBuilder::new(handle, "视图")
                .item(&mi_search)
                .separator()
                .item(&mi_mode_read)
                .item(&mi_mode_edit)
                .separator()
                .item(&mi_zen)
                .separator()
                .item(&mi_sidebar)
                .build()?;

            let mi_theme_light =
                MenuItem::with_id(handle, "theme-light", "浅色", true, None::<&str>)?;
            let mi_theme_dark =
                MenuItem::with_id(handle, "theme-dark", "暗色", true, None::<&str>)?;
            let mi_theme_graphite =
                MenuItem::with_id(handle, "theme-graphite", "石墨", true, None::<&str>)?;
            let theme_menu = SubmenuBuilder::new(handle, "主题")
                .item(&mi_theme_light)
                .item(&mi_theme_dark)
                .item(&mi_theme_graphite)
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
            commands::get_config,
            commands::save_config,
            commands::list_themes,
            commands::apply_theme,
            commands::pick_export_path,
            commands::export_html,
            commands::set_current_file,
            commands::serve_status,
            commands::serve_start,
            commands::serve_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
