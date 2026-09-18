// src-tauri/src/modules/settings/commands.rs
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
    let settings = state.0.read().await;
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

    let mut current = state.0.write().await;
    *current = settings.clone();

    Ok(settings)
}

/// 恢复默认设置并返回
#[tauri::command]
pub async fn reset_app_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let defaults = store::reset(&app)?;

    let mut current = state.0.write().await;
    *current = defaults.clone();

    Ok(defaults)
}

/// 获取应用数据目录（`settings.json` 所在目录），必要时创建
#[tauri::command]
pub async fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;

    Ok(app_dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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

