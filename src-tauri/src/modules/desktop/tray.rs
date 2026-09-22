// src-tauri/src/modules/desktop/tray.rs
//
// 系统托盘：图标、菜单，以及「点关闭按钮之后发生什么」。
//
// ============================================================
// 为什么托盘是"后台保活"的前提，而不是一个装饰
// ============================================================
//
// 应用接下来要有**在窗口之外继续工作**的能力（后台插件、桌面通知）。一旦有了
// 那种能力，"关掉窗口"就再也不能等于"退出程序"：用户点了关闭，后台任务被一起
// 杀掉，那些功能就全是假的。
//
// 因此托盘承担两件缺一不可的事：
//   1. 关掉窗口之后**仍然有一个入口**能把界面叫回来。没有它，"隐藏到托盘"
//      就等于"程序消失了，而且再也打不开"。
//   2. **退出**必须是一个显式的、用户主动的动作。这是后台进程唯一的正经出口。
//
// ============================================================
// 关于线程的一点说明（这里与 memory_level.rs 的约束不同）
// ============================================================
//
// `memory_level.rs` 里 `with_webview` 必须避开事件循环线程，否则死锁。托盘菜单
// 回调**也**跑在事件循环线程上，但这里调用 `window.show()` / `window.hide()` /
// `app.exit()` 是**安全的**：它们只是把请求发给事件循环，不等待执行结果。
// 区别在于"发完就走"与"发完等回复"—— 只有后者会互等。
//
// 这条区别很容易被记成"事件回调里什么都不能调"，那样会把托盘写得很别扭。
// 真正的判据是：**这个调用会不会等事件循环**。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::modules::settings::settings;
use crate::prelude::*;

/// 托盘图标 ID。`sync_menu_check` 要靠它把托盘找回来，
/// `commands::is_tray_available` 也用它判断托盘是否装上了。
pub const TRAY_ID: &str = "modulith-main";

/// 托盘菜单项 ID。集中在这里，避免"菜单里写一个字符串、回调里比对另一个"。
const MENU_SHOW: &str = "tray.show";
const MENU_CLOSE_TO_TRAY: &str = "tray.close_to_tray";
const MENU_EXIT: &str = "tray.exit";

/// 主窗口标签（与 `tauri.conf.json` 的窗口配置一致）
const MAIN_WINDOW: &str = "main";

/// 托管起来的那一个"关闭时最小化到托盘"菜单项。
///
/// **为什么要托管句柄，而不是去菜单树里查：** `TrayIcon` 没有读取菜单的接口
/// （只有 `set_menu`），因此"找到那一项再改它的勾选状态"这条路走不通。
/// 反过来，创建时拿到句柄并保存下来，只需要一次 `.manage()`，
/// 而且顺带消掉了"按 ID 查菜单项"这一步可能查不到的分支。
pub struct TrayMenuState(pub CheckMenuItem<tauri::Wry>);

/// 桌面环境不可用时，托盘相关的动作全部原样报告，不吞掉
fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// 把窗口显示出来并聚焦。
///
/// 三步一个都不能少：隐藏的窗口 `set_focus` 无效，而最小化的窗口需要先
/// `unminimize`。少任何一步的表现都是"点了菜单里的显示，但没有反应"。
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("托盘：找不到主窗口，无法显示");
        return;
    };

    if let Err(error) = window.show() {
        log::warn!("托盘：显示窗口失败：{error}");
        return;
    }
    // `unminimize` 在未最小化时是空操作，因此不需要先判断状态
    // （判断反而要多一次跨线程往返）。
    let _ = window.unminimize();
    if let Err(error) = window.set_focus() {
        log::warn!("托盘：聚焦窗口失败：{error}");
    }
}

/// 隐藏窗口到托盘
pub fn hide_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Err(error) = window.hide() {
        log::warn!("托盘：隐藏窗口失败：{error}");
    }
}

/// 安装托盘图标与菜单
pub fn install(app: &AppHandle) -> Result<(), String> {
    let close_to_tray = settings::load(app).close_to_tray;

    let show_item =
        MenuItem::with_id(app, MENU_SHOW, "显示主窗口", true, None::<&str>).map_err(error_text)?;
    let close_item = CheckMenuItem::with_id(
        app,
        MENU_CLOSE_TO_TRAY,
        "关闭窗口时最小化到托盘",
        true,
        close_to_tray,
        None::<&str>,
    )
    .map_err(error_text)?;
    let separator = PredefinedMenuItem::separator(app).map_err(error_text)?;
    let exit_item = MenuItem::with_id(app, MENU_EXIT, "退出", true, None::<&str>).map_err(error_text)?;

    let menu = Menu::with_items(app, &[&show_item, &close_item, &separator, &exit_item])
        .map_err(error_text)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // 左键点击**不**弹菜单，而是直接显示窗口 —— 这是托盘图标最常见的心智模型：
        // 点一下把窗口叫回来。菜单留给右键。
        .show_menu_on_left_click(false)
        .tooltip(app.package_info().name.clone())
        .on_menu_event(move |app, event| match event.id().as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_CLOSE_TO_TRAY => {
                // 菜单里改的就是**持久设置**，与「通用」页里那个开关是同一项。
                // 两处各存一份必然漂移，而漂移的表现是"菜单里勾了、设置页没勾"。
                toggle_close_to_tray(app);
            }
            MENU_EXIT => {
                log::info!("用户从托盘菜单退出应用");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击（按下并抬起）→ 显示窗口。
            // 只认 `Up` 是因为 `Down` 在按下瞬间就会触发，用户按住拖动图标时
            // 也会命中 —— 那会让"按住图标"意外地把窗口弹出来。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // 用应用自己的窗口图标作托盘图标：它与 `tauri.conf.json` 的 bundle 图标
    // 是同一份，不需要额外维护一个资源文件（多一份资源就多一处会忘记更新）。
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        log::warn!("托盘：应用没有默认窗口图标，托盘图标会是系统默认样式");
    }

    builder.build(app).map_err(error_text)?;

    // 句柄要留下来给 `sync_menu_check` 用（TrayIcon 没有读取菜单的接口）。
    // `.manage()` 对同一类型只能调用一次 —— 托盘也只装一次，因此成立。
    app.manage(TrayMenuState(close_item));

    Ok(())
}

/// 切换「关闭窗口时最小化到托盘」并同步所有呈现处
///
/// 同步三处：持久设置、托盘菜单的勾选状态、以及前端的设置缓存。
/// 前端的部分由前端在保存设置后自己回读，这里只负责前两者。
fn toggle_close_to_tray(app: &AppHandle) {
    let mut current = settings::load(app);
    current.close_to_tray = !current.close_to_tray;

    if let Err(error) = settings::save(app, &current) {
        log::warn!("托盘：保存关闭行为失败：{error}");
        return;
    }

    log::info!("关闭窗口的行为已改为：{}", describe_close_action(current.close_to_tray));
    sync_menu_check(app, current.close_to_tray);
}

/// 把托盘菜单里的勾选状态刷新成设置里的值
///
/// 需要它的场合不止一处：托盘菜单自己改过之后、以及前端改过设置之后。
/// 少了"前端改过之后"这一半，用户会在设置页关掉它、再右键托盘看到它还是勾着的。
pub fn sync_menu_check(app: &AppHandle, close_to_tray: bool) {
    // 托盘没装成功时没有这份 state，取不到就跳过 —— 那不是错误，
    // 因为"托盘不可用"这条路径已经在 `DesktopModule::setup` 里被处理过了。
    let Some(state) = app.try_state::<TrayMenuState>() else {
        return;
    };

    if let Err(error) = state.0.set_checked(close_to_tray) {
        log::warn!("托盘：同步菜单勾选状态失败：{error}");
    }
}

fn describe_close_action(close_to_tray: bool) -> &'static str {
    if close_to_tray {
        "隐藏到托盘（后台继续运行）"
    } else {
        "直接退出应用"
    }
}
