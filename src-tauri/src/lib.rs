// src-tauri/src/lib.rs
// 此文件由 scripts/generate-backend-module.ts 自动生成
// 请勿手动编辑 - DO NOT EDIT MANUALLY
//
// 同 modules/mod.rs：不写生成时间，保证生成可重复（理由见该文件的注释）。

pub mod prelude;
pub mod core;
pub mod modules;

use core::registry::ModuleRegistry;
use tauri::{Emitter, Manager};

use modules::auth::commands::*;
use modules::backup::commands::*;
use modules::desktop::commands::*;
use modules::logging::commands::*;
use modules::net::commands::*;
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

    // 插件沙箱的注册表与自定义协议。
    //
    // 协议承载插件界面与宿主之间的**全部**通信（见 modules/plugins/sandbox.rs）。
    // 插件 webview 一条 IPC 权限都没有，因此没有 event / command 可用 ——
    // 身份由协议处理器拿到的 webview 标签、经注册表查出来，插件伪造不了。
    //
    // 注册表挂在 builder 上而不是 setup 里：协议处理器要同步读它，而请求可能在
    // setup 完成之前就到。
    //
    // 协议注册在 builder 上而不是某个窗口上：运行时会给**每一个** webview 各注册
    // 一遍，因此子 webview 用的是同一条协议。
    builder = builder.manage(modules::plugins::sandbox::SandboxSurfaces::default());
    builder = modules::plugins::sandbox::register(builder);

    // 后端就绪信号。
    //
    // **它必须在 setup 之前就托管**，理由与 SandboxSurfaces 完全相同：它不是给
    // 已经跑起来的模块用的，而是给"模块还没跑起来"的那段时间用的。
    //
    // 它修的是一个只在发行版出现、且每次冷启动必现的缺陷：主窗口由 Tauri 在创建
    // 阶段就建好并开始加载前端资源，而各模块的状态是在下面的 setup 钩子里注入的
    // —— 两者之间没有任何同步。打包产物的实测日志显示，webview 已经在取嵌入资源
    // 时，`SettingsState` / `AuthState` 的注入还分别晚 25ms / 39ms。于是启动流程
    // 第二步（`get_auth_status`）必然以 "state not managed" 失败并把用户挡在
    // 「重试初始化」界面上；重试时 setup 早已跑完，所以一点就过，下次冷启动照旧。
    //
    // 同一次竞速里还有几个被 `catch` 吞掉的失败（读设置回落默认值、通知订阅没装上、
    // WebView 内存等级没生效、插件主题快照没推上去）。它们不报错，只是让启动结果
    // 静默变差 —— 因此正确的修法不是给某几条命令加保护，而是给出一个**显式就绪
    // 信号**，让前端在第一个 invoke 之前先等它。判据见 `core::registry::ReadyState`。
    builder = builder.manage(core::registry::ReadyState::new());

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
            if let Some(window) = crate::core::window::main(app.handle()) {
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

        // 启动所有模块。
        //
        // **按拓扑序**（start_all 内部推出执行计划），而不是遍历 registry.all()
        // —— 后者是 HashMap::values()，也就是哈希顺序。此前 setup_all 按拓扑序
        // 而 start 不按，两者不一致会让一个模块的 start 早于它依赖的模块的
        // start，于是它在启动阶段读到对方半初始化的状态。
        //
        // 单个模块启动失败**不中止其余模块**：一个模块起不来不该让整个应用打不开。
        // 失败记进日志并把第一个失败者报到 stderr（release 版没有控制台，
        // 因此日志文件才是主要出口）。
        if let Some((id, reason)) = registry.start_all(&handle) {
            eprintln!("[WARN] Module start failed: {} - {}", id, reason);
        }

        app.manage(registry);

        // 就绪信号置位并广播 —— 这是**唯一**一处。
        //
        // 顺序是刻意的：先 `app.manage(registry)`，再置位。反过来的话，前端可能
        // 收到信号后立刻调用依赖 `ModuleRegistry` 的命令，而它还没被托管 ——
        // 那正是这个信号要消灭的那类竞态，不能自己再制造一次。
        //
        // 事件与命令两条路都走（命令见文件末尾的 `backend_ready`）：事件可能在前端
        // 挂上监听之前就发出去（那时前端还没有任何监听器），命令则要过 ACL 与
        // 一次 IPC 往返。两条都留，任何一条到达都足以放行启动。
        if let Some(state) = app.try_state::<core::registry::ReadyState>() {
            state.mark_ready();
        }
        if let Err(error) = app.emit(core::registry::BACKEND_READY_EVENT, ()) {
            log::warn!("广播后端就绪事件失败：{error}");
        }
        log::info!("后端初始化完成，已广播就绪信号");

        // 沙箱界面**不再有所有者线程**。
        //
        // v1.6.0 之前这里 manage 了一个 SurfaceActor：全宿主只有它能在主线程之外
        // 创建 / 摆放 / 显示 / 销毁插件子 webview，因为从 IPC 线程（主线程）创建
        // webview 会让整个应用假死 —— 窗口按钮、托盘、其余插件一起失去响应，
        // 而且**一处错误都不报**。
        //
        // 插件界面改成跨源 iframe 之后，宿主这一侧不再碰窗口系统：它只签发一个
        // 令牌（一次内存写入），窗口与几何全部交给浏览器的 DOM。那条线程连同它
        // 服务的 surface.rs 一起删掉了。
        //
        // ⚠️ 那条约束本身**没有消失**：它适用于任何"从命令里创建 webview"的地方。
        // 仓库里现在只剩沙箱自检会建窗口，因此 sandbox_self_test 必须保持
        // async。完整推导留在 git 历史里 surface.rs 的文件头。

        // 插件主题快照。
        //
        // 主题的**真源在宿主文档里**（那一堆 CSS 自定义属性），而 Rust 这一侧
        // 没有 document 可读。因此它由前端推上来（命令 set_plugin_theme），
        // 宿主负责注入插件入口文档并推给已经打开的界面。见 modules/plugins/theme.rs。
        app.manage(modules::plugins::theme::PluginTheme::new());

        // 宿主快捷键表。
        //
        // 键盘焦点落进插件 webview 之后，keydown 只在**插件自己的文档**里派发 ——
        // 宿主窗口上的监听器收不到。桥接层据此表判断某个组合该不该转发回来，
        // 而那个判断不能靠 IPC 往返（那是每敲一个键一次）。见 modules/plugins/shortcuts.rs。
        app.manage(modules::plugins::shortcuts::PluginShortcuts::new());

        // 沙箱自检**不在启动路径上**。
        //
        // 它曾经在这里起一个 4 秒后的异步任务，无条件弹出一块 560×420 的诊断面板。
        // 每次启动都多一块挡在界面上的面板，去验一件绝大多数时候都成立的事 ——
        // 用户的原话是"它很打扰"。现在它由「插件」页上的一个按钮显式触发，
        // 走命令 sandbox_self_test。
        //
        // 能力本身**刻意保留**：它验的是边界本身（ACL 拒绝、身份来自引擎、通道可用、
        // CSP 生效），而自检页是仓库里唯一会去故意违规的地方。见
        // modules/plugins/sandbox.rs 的 open_selftest。

        // 主线程停滞看门狗。同样只在 debug 构建里 —— 它对用户没有价值，
        // 却会在每一次正常的长任务上往日志里写 ERROR。见 core/watchdog.rs。
        #[cfg(debug_assertions)]
        crate::core::watchdog::spawn_main_thread_watchdog(handle.clone());

        Ok(())
    });

    // 集中注册所有命令
    builder = builder.invoke_handler(tauri::generate_handler![
        backend_ready,
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
        list_backup_categories,
        export_backup,
        open_backup,
        restore_backup,
        background_host_status,
        detect_node_runtime,
        set_node_runtime_path,
        background_host_probe,
        background_host_shutdown,
        background_plugins_sync,
        background_plugins_status,
        background_plugin_start,
        background_plugin_stop,
        overlay_respond,
        overlay_resize,
        overlay_hide,
        plugin_background_contribution,
        get_close_to_tray,
        set_close_to_tray,
        is_tray_available,
        tray_menu_state,
        tray_menu_action,
        get_log_dir,
        read_log_tail,
        clear_logs,
        log_frontend,
        report_frontend_crash,
        net_policy_modes,
        net_log_list,
        net_log_clear,
        net_log_len,
        net_answer_prompt,
        net_list_session_grants,
        net_clear_session_grants,
        net_note_frontend_outbound,
        list_notifications,
        push_notification,
        mark_notification_read,
        mark_all_notifications_read,
        dismiss_notification,
        clear_notifications,
        get_notification_summary,
        sandbox_surface_open,
        sandbox_surface_close,
        sandbox_self_test,
        plugin_surfaces,
        set_plugin_theme,
        get_plugin_theme,
        set_plugin_shortcuts,
        get_plugin_shortcuts,
        list_plugins,
        get_plugin,
        list_plugin_permissions,
        dev_plugin_fingerprints,
        install_plugin_package,
        install_plugin_folder,
        install_plugin_url,
        install_plugin_url_verified,
        fetch_registry_text,
        verify_plugin_index,
        set_plugin_enabled,
        uninstall_plugin,
        read_plugin_asset,
        read_plugin_readme,
        export_plugin,
        pick_plugin_package,
        pick_plugin_folder,
        default_export_dir,
        plugin_storage_get,
        plugin_storage_set,
        plugin_storage_delete,
        plugin_storage_keys,
        plugin_db_query,
        plugin_db_exec,
        plugin_http_download,
        plugin_db_transaction,
        plugin_data_clear,
        plugin_data_usage,
        plugin_data_list,
        plugin_data_stat,
        plugin_data_read,
        plugin_data_write,
        plugin_data_mkdir,
        plugin_data_remove,
        plugin_data_used,
        plugin_data_orphans,
        plugin_storage_list,
        plugin_storage_usage,
        plugin_storage_clear,
        plugin_http_request,
        plugin_launch_program,
        plugin_extract_icon,
        plugin_reveal_in_folder,
        plugin_pick_audio,
        get_app_settings,
        get_app_info,
        update_app_settings,
        reload_app_settings,
        memory_snapshot,
        apply_memory_level_for_visibility,
        set_webview_memory_level,
        webview_memory_level_supported,
        reset_app_settings,
        probe_network,
        get_app_data_dir,
        pick_notification_sound,
        load_notification_sound,
        get_autostart_status,
        set_autostart_enabled,
        was_started_by_autostart,
        trim_memory_now,
        trim_memory_supported,
        get_sidebar_preferences,
        get_module_preferences,
        update_module_order,
        toggle_module_visibility,
        toggle_module_pin,
        move_module_position,
        get_module_categories,
        create_module_category,
        rename_module_category,
        delete_module_category,
        reorder_module_categories,
        set_module_category,
        reset_sidebar_preferences,
        reset_module_preferences,
        record_module_open,
        get_recent_modules,
        toggle_favorite_module,
        get_favorite_modules,
        check_app_update,
        install_app_update,
    ]);

    // 用 run_return 而不是 run，唯一的理由是**拿到退出事件**。
    //
    // 此前应用退出时没有任何收尾动作：模块的 stop 从来没有被调用过
    // （registry.stop_all 甚至不存在）。而 logging 模块确实有需要落盘的东西，
    // 于是"关掉应用之后最后几条日志不见了"成了一个没人解释得清的现象。
    //
    // 代价是必须**自己把 Tauri 内部那个回调补全**：run_return 会替换掉默认实现，
    // 而默认实现除了跑事件循环还做了 cleanup_before_exit。漏掉它不会立刻报错，
    // 但托盘图标、窗口资源表都不会被清理 —— 因此下面显式调用它，
    // 并把退出码原样传出去。
    let app = builder.build(tauri::generate_context!())?;
    let exit_code = app.run_return(|app, event| {
        if let tauri::RunEvent::Exit = event {
            // 停止模块：**逆序**（依赖方先停），见 ModuleRegistry::stop_all。
            // 放在 cleanup_before_exit **之前** —— 后者会清掉窗口与资源表，
            // 之后模块再想用 Tauri 的 API 收尾就拿不到东西了。
            let registry = app.state::<ModuleRegistry>();
            registry.stop_all(app);

            log::info!("应用即将退出，模块收尾已完成");
            app.cleanup_before_exit();
        }
    });

    std::process::exit(exit_code);
}

/// 后端是否已经初始化完成（前端启动闸门的第一道判据）。
///
/// 为什么是"查一个已经托管好的原子布尔量"而不是 `try_state::<ModuleRegistry>()`
/// 然后调 `is_ready()`：`setup` 期间 `ModuleRegistry` 还被局部变量 `registry`
/// 持有，`app.manage(registry)` 要到 setup 末尾才发生 —— 而那段时间恰好就是
/// 前端最想问"好了没有"的那段。`ReadyState` 挂在 builder 链上，因此它在这段
/// 窗口里一定拿得到。
///
/// 它的两条路径都不做任何有副作用的事：查一次原子量、或者读一次已托管的状态。
/// 因此前端可以放心地高频轮询它（实际上只会轮询几次，见
/// `src/services/backendReady.ts`）。
///
/// **ACL**：这条命令注册在应用级清单里，因此必须同时出现在三处 ——
/// `build.rs` 的 `AppManifest::commands`、这里的 `generate_handler!`、
/// `capabilities/app-commands.json` 的 `allow-backend-ready`。
/// 少一处的结果是"命令对所有人不可用"，且只会在运行期显形（`pnpm check:acl` 会拦）。
#[tauri::command]
pub async fn backend_ready(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::Manager;

    if let Some(state) = app.try_state::<core::registry::ReadyState>() {
        return Ok(state.is_ready());
    }

    // 理论上到不了这里（`ReadyState` 注册在 builder 链上）。真到了，就退回真源：
    // 已经托管了注册表时以它的结论为准，否则如实回答"还没好"——
    // 这个方向是安全的：前端继续等，而不会拿一个未初始化的后端去跑启动流程。
    match app.try_state::<ModuleRegistry>() {
        Some(registry) => Ok(registry.is_ready()),
        None => Ok(false),
    }
}
