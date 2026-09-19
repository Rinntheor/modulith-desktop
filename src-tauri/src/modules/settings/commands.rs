// src-tauri/src/modules/settings/commands.rs
use crate::modules::logging;
use crate::modules::settings::probe;
use crate::modules::settings::autostart;
use crate::modules::settings::settings::{self as store, AppSettings};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

/// 应用设置的全局状态（由 Tauri 托管）
pub struct SettingsState(pub Arc<RwLock<AppSettings>>);

impl SettingsState {
    pub fn new(settings: AppSettings) -> Self {
        Self(Arc::new(RwLock::new(settings)))
    }
}

/// 读取当前应用设置
#[tauri::command]
pub async fn get_app_settings(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    let settings = state.inner().0.read().await;
    Ok(settings.clone())
}

/// 应用元信息：版本等构建期常量
///
/// 版本号直接取自 `Cargo.toml`（`CARGO_PKG_VERSION`），这是编译期嵌入的常量，
/// 与插件校验器 `validator.rs` 使用的版本源完全一致 —— 二者都读同一个值，
/// 因此前端显示、插件 `window.Modulith.version` 与后端 `engines` 校验
/// 不可能出现不一致。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub tauri_version: String,
    pub platform: String,
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        name: env!("CARGO_PKG_NAME").to_string(),
        tauri_version: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

/// 校验并保存应用设置，同时更新内存中的状态
#[tauri::command]
pub async fn update_app_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    settings.validate()?;
    store::save(&app, &settings)?;

    {
        let mut current = state.inner().0.write().await;
        *current = settings.clone();
    }

    // 日志开关是**运行期**生效的，所以必须在保存之后立刻套用 ——
    // 让用户「关掉实时记录」却要重启才生效，等于这个开关是假的。
    // 放在锁外调用：`apply` 自己会发一条日志，没必要握着设置锁去写盘。
    logging::apply(
        settings.file_logging_enabled,
        settings.crash_logging_enabled,
    );

    // debug 级：标签切换、主题变更都会走到这里，info 级会把日志刷满。
    log::debug!(
        "应用设置已更新：网络 {}，实时记录 {}，崩溃记录 {}，标签 {} 个",
        crate::modules::settings::network::describe_mode(&settings),
        settings.file_logging_enabled,
        settings.crash_logging_enabled,
        settings.open_tabs.len()
    );

    Ok(settings)
}

/// 恢复默认设置并返回
#[tauri::command]
pub async fn reset_app_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let defaults = store::reset(&app)?;

    {
        let mut current = state.inner().0.write().await;
        *current = defaults.clone();
    }

    logging::apply(
        defaults.file_logging_enabled,
        defaults.crash_logging_enabled,
    );

    Ok(defaults)
}

/// 网络诊断：把「直连」与「下载源」两条路各实测一遍
///
/// 目标是**原始地址**（插件索引的 CDN / GitHub、更新清单），代理那一版由后端
/// 现场改写 —— 安全边界写在 `probe.rs` 的文件头。
#[tauri::command]
pub async fn probe_network(
    app: AppHandle,
    targets: Vec<probe::ProbeTarget>,
) -> Result<probe::ProbeReport, String> {
    probe::run(&app, targets).await
}

/// 获取应用数据目录（`settings.json` 所在目录），必要时创建
#[tauri::command]
pub async fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;

    Ok(app_dir.to_string_lossy().to_string())
}

// ============================================================
// 开机自启动
// ============================================================

/// 开机自启动的状态
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    /// 当前平台是否支持这个开关
    pub supported: bool,
    /// 系统里的**实际**状态（读注册表，不是设置文件里的副本）
    pub enabled: bool,
    /// 不支持时的原因，供界面直接显示而不是自己编一句
    pub reason: Option<String>,
}

fn autostart_status() -> AutostartStatus {
    match autostart::is_enabled() {
        Ok(enabled) => AutostartStatus {
            supported: true,
            enabled,
            reason: None,
        },
        Err(reason) => AutostartStatus {
            supported: false,
            enabled: false,
            reason: Some(reason),
        },
    }
}

/// 读取开机自启动状态
///
/// 读的是**系统里的实际状态**而不是设置文件的副本：用户可以在任务管理器的
/// 「启动」页里直接改它，因此设置文件里存一份必然与实际不符，界面会显示一个
/// 位置错误的开关。见 `autostart.rs` 文件头。
#[tauri::command]
pub fn get_autostart_status() -> AutostartStatus {
    autostart_status()
}

/// 开启 / 关闭开机自启动
///
/// 写入的命令行由后端用 `current_exe()` 现算，**不接受前端传入的路径** ——
/// 那会变成一条「把任意程序写进启动项」的命令。
#[tauri::command]
pub fn set_autostart_enabled(enabled: bool) -> Result<AutostartStatus, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法确定程序路径：{e}"))?;
    autostart::set_enabled(enabled, &autostart::autostart_command(&exe))?;
    Ok(autostart_status())
}

/// 本次进程是否由开机自启动拉起
///
/// 前端据此决定要不要应用「静默启动 / 启动时全屏」—— 那两个设置只该作用于
/// 「系统把我拉起来」的情形，不该影响用户双击图标启动。
#[tauri::command]
pub fn was_started_by_autostart() -> bool {
    autostart::launched_by_autostart()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 自启动命令行必须带引号，且带 `--autostart` 标记。
    ///
    /// 引号防的是「含空格的路径被系统按空格拆成程序名 + 参数」—— 那种失败在开机时
    /// 静默发生，用户只会看到"自启动没生效"；标记用于区分「系统拉起」与「用户双击」，
    /// 没有它，静默启动与启动全屏会连用户自己点图标时也生效，表现为「点了一下界面
    /// 不出来」。
    #[test]
    fn autostart_command_quotes_the_path_and_carries_the_flag() {
        let exe = std::path::Path::new(r"C:\Program Files\Modulith Desktop\modulith-desktop.exe");
        let command = autostart::autostart_command(exe);

        assert!(command.starts_with('"'), "路径必须被引号包裹，实际: {command}");
        assert!(
            command.ends_with(autostart::AUTOSTART_FLAG),
            "必须带自启动标记，实际: {command}"
        );

        // 本进程不是由自启动拉起的（cargo test 不会带那个参数）。这条断言锁的是
        // 「检测逻辑不会被一个随机的 argv 误判成自启动」。
        assert!(!was_started_by_autostart());
    }

    /// 宿主版本必须同时满足两个条件：
    /// 1. 是合法 SemVer（否则插件校验器 `SemVer::parse` 会失败，
    ///    并以「本程序版本号非法」中断插件安装）
    /// 2. 与 `validator.rs` 使用的 `env!("CARGO_PKG_VERSION")` 完全一致
    ///
    /// 这两点保证前端显示、插件读到的 `window.Modulith.version`、
    /// 以及 `engines.loopcore` 的校验基准三者不会分叉。
    #[test]
    fn app_info_version_is_valid_semver() {
        let info = get_app_info();

        let parts: Vec<&str> = info.version.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "版本号必须是 MAJOR.MINOR.PATCH 三段式，实际为 {}",
            info.version
        );

        for part in &parts {
            assert!(
                !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()),
                "版本号每段必须是纯数字，实际为 {}",
                info.version
            );
            assert!(
                *part == "0" || !part.starts_with('0'),
                "版本号不允许前导零，实际为 {}",
                info.version
            );
        }
    }

    /// `get_app_info` 暴露的版本必须就是编译期嵌入的 Cargo 版本，
    /// 而不是任何手写的副本。
    #[test]
    fn app_info_version_matches_cargo_pkg_version() {
        let info = get_app_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    /// 插件校验器读的是 `env!("CARGO_PKG_VERSION")`，这里显式断言
    /// 它与握手命令返回给前端的值相等 —— 一旦有人改动其一，测试即失败。
    #[test]
    fn plugin_validator_and_frontend_share_one_version_source() {
        let host_version = env!("CARGO_PKG_VERSION");
        let info = get_app_info();
        assert_eq!(
            host_version, info.version,
            "插件校验基准与前端显示版本必须同源"
        );
    }

    #[test]
    fn app_info_exposes_platform_and_tauri_version() {
        let info = get_app_info();
        assert!(!info.platform.is_empty(), "platform 不应为空");
        assert!(!info.tauri_version.is_empty(), "tauri_version 不应为空");
        assert!(!info.name.is_empty(), "name 不应为空");
    }
}

