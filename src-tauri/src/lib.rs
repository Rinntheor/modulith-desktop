// src-tauri/src/lib.rs
// 此文件由 scripts/generate-backend-module.ts 自动生成
// 请勿手动编辑 - DO NOT EDIT MANUALLY
//
// 同 modules/mod.rs：不写生成时间，保证生成可重复（理由见该文件的注释）。

pub mod prelude;
pub mod core;
pub mod modules;

use core::registry::ModuleRegistry;
use tauri::Manager;

use modules::auth::commands::*;
use modules::logging::commands::*;
use modules::notifications::commands::*;
use modules::plugins::commands::*;
use modules::settings::commands::*;
use modules::sidebar::commands::*;
use modules::updater::commands::*;



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), tauri::Error> {
    let mut registry = ModuleRegistry::new();

    // 注册所有模块
    if let Err(e) = modules::register_all(&mut registry) {
        eprintln!("[ERROR] Failed to register modules: {:?}", e);
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 应用更新器。
        //
        // endpoints 与 pubkey 不在代码里，而在 tauri.conf.json 的 plugins.updater ——
        // 公钥必须随应用一起发布（它是"这个更新包确实由我们签发"的唯一依据），
        // 放进配置文件才能跟着版本走。
        .plugin(tauri_plugin_updater::Builder::new().build());

    // setup 中初始化模块
    builder = builder.setup(move |app| {
        // 窗口居中兜底。
        //
        // tauri.conf.json 里已经写了 "center": true，正常路径由 Tauri 在创建窗口时完成。
        // 但那条路径对「多显示器 / 缩放比例不一致」的组合并不总是可靠 ——
        // 实际观察到过窗口落在主显示器画面中央偏左的位置。
        // 这里再显式居中一次作为兜底：失败只记警告，绝不影响启动。
        #[cfg(desktop)]
        {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.center() {
                    eprintln!("[WARN] Failed to center main window: {e}");
                }
            }
        }

        let handle = app.handle().clone();

        // 设置所有模块
        if let Err(e) = registry.setup_all(&handle) {
            eprintln!("[ERROR] Module setup failed: {:?}", e);
            return Err(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Module setup failed: {:?}", e),
            )));
        }

        // 启动所有模块
        for module in registry.all() {
            if let Err(e) = module.start(&handle) {
                eprintln!("[WARN] Module {} start failed: {}", module.id(), e);
            }
        }

        app.manage(registry);
        Ok(())
    });

    // 集中注册所有命令
    builder = builder.invoke_handler(tauri::generate_handler![
        get_auth_status,
        verify_session,
        get_hardware_fingerprint,
        setup_access_key,
        verify_access_key,
        try_auto_login,
        logout,
        change_access_key,
        set_require_auth,
        set_auto_login,
        generate_recovery_code,
        verify_recovery_code,
        reset_access_key_with_recovery_code,
        get_security_overview,
        get_known_devices,
        remove_known_device,
        get_login_logs,
        clear_login_logs,
        get_log_dir,
        read_log_tail,
        clear_logs,
        log_frontend,
        report_frontend_crash,
        list_notifications,
        push_notification,
        mark_notification_read,
        mark_all_notifications_read,
        dismiss_notification,
        clear_notifications,
        get_notification_summary,
        list_plugins,
        get_plugin,
        list_plugin_permissions,
        install_plugin_package,
        install_plugin_folder,
        install_plugin_url,
        install_plugin_url_verified,
        fetch_registry_text,
        verify_plugin_index,
        set_plugin_enabled,
        uninstall_plugin,
        read_plugin_asset,
        export_plugin,
        pick_plugin_package,
        pick_plugin_folder,
        default_export_dir,
        plugin_storage_get,
        plugin_storage_set,
        plugin_storage_delete,
        plugin_storage_keys,
        plugin_storage_clear,
        plugin_http_request,
        plugin_launch_program,
        plugin_extract_icon,
        plugin_reveal_in_folder,
        plugin_pick_audio,
        get_app_settings,
        get_app_info,
        update_app_settings,
        reset_app_settings,
        probe_network,
        get_app_data_dir,
        get_autostart_status,
        set_autostart_enabled,
        was_started_by_autostart,
        get_sidebar_preferences,
        get_module_preferences,
        update_module_order,
        toggle_module_visibility,
        toggle_module_pin,
        move_module_position,
        reset_sidebar_preferences,
        reset_module_preferences,
        record_module_open,
        get_recent_modules,
        toggle_favorite_module,
        get_favorite_modules,
        check_app_update,
        install_app_update,
    ]);

    builder.run(tauri::generate_context!())
}
