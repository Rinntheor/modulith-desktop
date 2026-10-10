// src-tauri/src/modules/plugins/safe_mode.rs
//
// 安全模式：插件把宿主弄到"起不来"时的逃生舱。
//
// ============================================================
// 它解决的问题：一条已知的、无法救回的通路
// ============================================================
//
// `pluginRuntime.ts::loadPlugin` 的注释把这件事写得很清楚：
//
//   > JS 是单线程的，插件 bundle 顶层的同步死循环**无法被中断** —— 一旦发生，
//   > 界面会一起卡住。超时能做到的只是不再把后续插件的时间也算在这个插件头上。
//
// 于是一个 in-process 插件只要在 bundle 顶层写 `while(true){}`：
//
//   1. 它命中 eager（`activationEvents` 缺省，或写了 `onStartup`）→ 启动时执行；
//   2. 渲染进程被占满 → 启动门禁永远停在进度条；
//   3. 设置 → 插件页打不开 → **用户无法禁用它**；
//   4. 唯一的出路是手工去 `%APPDATA%` 删目录 —— 普通用户做不到。
//
// 沙箱化削减了这条通路（沙箱插件的 bundle 不再进宿主 realm），但没有消除它：
// `runtime: "in-process"` 的插件仍然可以，而沙箱 iframe 里的死循环在 WebView2 下
// 同样可能卡死整个渲染进程。
//
// ============================================================
// 机制：一个"没走干净"标记 + 一次自动回避
// ============================================================
//
//   * 启动时（**在窗口创建之前**）写下一个标记文件；
//   * **干净退出**时删掉它；
//   * 下次启动发现标记还在 → 上一次没有走干净 → 进安全模式。
//
// 安全模式只做一件事：**不让前端自动加载插件**（插件仍然列在设置 → 插件里，
// 用户可以禁用/卸载它们）。这样应用一定能起来，用户也一定能拿到那个页面。
//
// 为什么标记必须由 **Rust** 写，而不是前端：插件卡住的正是渲染进程 ——
// 那时前端已经没有机会执行任何一行代码。Rust 在 `PluginsModule::setup` 里写它，
// 那一步发生在事件循环启动之前，插件根本没有代码在跑。
//
// ============================================================
// 为什么不需要"退出安全模式"这个按钮
// ============================================================
//
// 标记在**干净退出**时被删掉。用户在安全模式里禁用了那个坏插件，然后正常关闭
// 应用，标记就没了 —— 下一次启动照常加载插件。也就是说"退出安全模式"这个动作
// 就是**关闭并重开应用**，不需要额外的界面与状态。
//
// 代价是：如果用户什么都不做就关掉应用，下一次仍会卡住、再下一次仍进安全模式。
// 这是有意的 —— 一个会自动"恢复正常"然后立刻再卡一次的安全模式，等于没有；
// 而通知里会明确写出"请到设置 → 插件里禁用可疑的插件"。
//
// ============================================================
// 环境变量逃生舱
// ============================================================
//
// `MODULITH_SAFE_MODE=1` 强制进入安全模式。它不依赖上面那套推断，
// 因此适用于"标记文件被删了 / 判断错了 / 开发时要复现一个插件问题"这些情况。
// 一个只能靠"上一次崩过"才能进入的安全模式，在真的需要它时会不够用。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 环境变量逃生舱的名字。
pub const ENV_VAR: &str = "MODULITH_SAFE_MODE";

/// 标记文件名。
///
/// 放在应用数据目录（`app_data_dir`）而不是插件数据根：插件数据根是**用户可换**
/// 的，而"上一次有没有走干净"是应用自身的事实，不该随数据盘一起搬家 ——
/// 换了盘就丢掉这个状态，正好会漏掉"换盘那一次崩了"。
const MARKER_FILE: &str = "boot_incomplete";

/// 暴露给前端的形态。
///
/// `reason` 是给**人**读的一句解释，不是枚举：界面把它原样显示出来即可，
/// 多一个枚举就多一处要维护的映射，而这里只有三种来源。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeModeState {
    pub active: bool,
    pub reason: Option<String>,
}

/// 安全模式状态（由 Tauri 托管）。
pub struct SafeMode {
    state: SafeModeState,
    marker: Option<PathBuf>,
}

impl SafeMode {
    pub fn state(&self) -> SafeModeState {
        self.state.clone()
    }

    /// 标记"这一次启动走干净了"。
    ///
    /// 由 `RunEvent::Exit` 调用 —— 那**不是**一个"正在退出"的通知，
    /// 而是事件循环结束之后、`cleanup_before_exit` 之前的那一步。
    ///
    /// 失败只记警告：删不掉一个标记文件不该让退出流程出错（退出路径上抛错
    /// 只会让用户看到一个更糟的结束方式）。留着它的后果也只是"下次又进安全模式"，
    /// 而那是一个安全的方向。
    pub fn mark_clean_exit(&self) {
        let Some(marker) = &self.marker else {
            return;
        };
        if !marker.exists() {
            return;
        }
        match std::fs::remove_file(marker) {
            Ok(()) => log::debug!("已清除启动标记 {}", marker.display()),
            Err(error) => log::warn!("无法清除启动标记 {}：{error}", marker.display()),
        }
    }
}

/// 标记文件的位置。拿不到应用数据目录时为 `None`（安全模式退化为只用环境变量）。
fn marker_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(MARKER_FILE))
}

/// 环境变量是否要求进入安全模式。
///
/// 接受 `1` / `true` / `yes` / `on`（大小写与首尾空白都不敏感），
/// 与仓库里其它布尔环境变量的读法保持一致；其余值一律当"没设"。
fn env_requests_safe_mode() -> bool {
    match std::env::var(ENV_VAR) {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

/// 判定是否进入安全模式，并写下本次启动的标记。
///
/// **必须在窗口创建之前调用**（`PluginsModule::setup` 满足这一点）：
/// 前端的第一次 `invoke` 会读这个状态，而标记要在这之前落到盘上。
pub fn install(app: &AppHandle) -> SafeMode {
    let marker = marker_path(app);
    // 先读后写：读了才知道"上一次有没有走干净"，而写下去代表"这一次正在进行"。
    let previous_boot_incomplete = marker
        .as_deref()
        .map(|path| path.exists())
        .unwrap_or(false);
    let forced = env_requests_safe_mode();

    let reason = if forced {
        Some(format!("环境变量 {ENV_VAR} 已设置，强制进入安全模式"))
    } else if previous_boot_incomplete {
        Some(
            "上一次启动没有正常退出（很可能是某个插件让它卡住或崩掉了）。\
             插件本次没有被加载 —— 请到「设置 → 插件」里禁用可疑的插件，再关闭并重开应用。"
                .to_string(),
        )
    } else {
        None
    };

    let state = SafeModeState {
        active: reason.is_some(),
        reason,
    };

    if let Some(path) = &marker {
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                log::warn!("无法创建启动标记目录 {}：{error}", parent.display());
            }
        }
        if let Err(error) = std::fs::write(path, b"") {
            // 写不下去就退化成"只用环境变量"：功能变弱，但不该让应用起不来。
            log::warn!("无法写入启动标记 {}：{error}", path.display());
        }
    } else {
        log::warn!("拿不到应用数据目录，安全模式的自动判定本次不可用");
    }

    match &state.reason {
        Some(reason) => log::warn!("已进入安全模式：{reason}"),
        None => log::debug!("安全模式未启用，已写下本次启动标记"),
    }

    SafeMode { state, marker }
}

/// 前端读它决定要不要自动加载插件。
///
/// 是**只读**的：没有"退出安全模式"这条命令，理由见文件头 ——
/// 退出动作就是"干净地关闭应用"，由 `SafeMode::mark_clean_exit` 在退出路径上完成。
#[tauri::command]
pub fn safe_mode_state(state: tauri::State<'_, SafeMode>) -> SafeModeState {
    state.state()
}
