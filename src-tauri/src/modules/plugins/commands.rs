// src-tauri/src/modules/plugins/commands.rs
// 插件系统暴露给前端的 Tauri 命令
//
// 命令名与签名是冻结契约，前端 src/services/pluginRuntime.ts 已按此调用。
// 所有命令返回 Result<T, String>，错误统一转成可读文本。

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use super::types::{ExportOutcome, HttpResponse, InstalledPlugin};
use super::PluginState;

/// 把管理器方法的结果映射为前端可读的错误字符串
fn to_msg<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

#[tauri::command]
pub async fn list_plugins(
    state: State<'_, PluginState>,
) -> Result<Vec<InstalledPlugin>, String> {
    let manager = state.0.read().await;
    Ok(manager.list())
}

#[tauri::command]
pub async fn get_plugin(
    state: State<'_, PluginState>,
    id: String,
) -> Result<Option<InstalledPlugin>, String> {
    let manager = state.0.read().await;
    Ok(manager.get(&id))
}

#[tauri::command]
pub async fn install_plugin_package(
    state: State<'_, PluginState>,
    path: String,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.0.write().await;
    manager
        .install_from_lcp(&PathBuf::from(path))
        .map_err(to_msg)
}

#[tauri::command]
pub async fn install_plugin_folder(
    state: State<'_, PluginState>,
    path: String,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.0.write().await;
    manager
        .install_from_folder(&PathBuf::from(path))
        .map_err(to_msg)
}

#[tauri::command]
pub async fn install_plugin_url(
    state: State<'_, PluginState>,
    url: String,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.0.write().await;
    manager.install_from_url(&url).await.map_err(to_msg)
}

#[tauri::command]
pub async fn set_plugin_enabled(
    state: State<'_, PluginState>,
    id: String,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.0.write().await;
    manager.set_enabled(&id, enabled).map_err(to_msg)
}

#[tauri::command]
pub async fn uninstall_plugin(state: State<'_, PluginState>, id: String) -> Result<(), String> {
    let mut manager = state.0.write().await;
    manager.uninstall(&id).map_err(to_msg)
}

#[tauri::command]
pub async fn read_plugin_asset(
    state: State<'_, PluginState>,
    id: String,
    rel: String,
) -> Result<String, String> {
    let manager = state.0.read().await;
    manager.read_asset(&id, &rel).map_err(to_msg)
}

#[tauri::command]
pub async fn export_plugin(
    state: State<'_, PluginState>,
    id: String,
    dest: Option<String>,
) -> Result<ExportOutcome, String> {
    let manager = state.0.read().await;
    manager
        .export(&id, dest.map(PathBuf::from))
        .await
        .map_err(to_msg)
}

#[tauri::command]
pub async fn pick_plugin_package(app: AppHandle) -> Result<Option<String>, String> {
    // 复用 setup 阶段建立的管理器（内含 AppHandle，可用于原生对话框）
    let state = app.state::<PluginState>().inner().0.clone();
    let manager = state.read().await;
    manager.pick_package().await.map_err(to_msg)
}

#[tauri::command]
pub async fn pick_plugin_folder(app: AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<PluginState>().inner().0.clone();
    let manager = state.read().await;
    manager.pick_folder().await.map_err(to_msg)
}

#[tauri::command]
pub async fn default_export_dir(app: AppHandle) -> Result<String, String> {
    let state = app.state::<PluginState>().inner().0.clone();
    let manager = state.read().await;
    manager.default_export_dir().map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_get(
    state: State<'_, PluginState>,
    id: String,
    key: String,
) -> Result<Option<String>, String> {
    let manager = state.0.read().await;
    manager.storage_get(&id, &key).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_set(
    state: State<'_, PluginState>,
    id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let manager = state.0.read().await;
    manager.storage_set(&id, &key, &value).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_delete(
    state: State<'_, PluginState>,
    id: String,
    key: String,
) -> Result<(), String> {
    let manager = state.0.read().await;
    manager.storage_delete(&id, &key).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_keys(
    state: State<'_, PluginState>,
    id: String,
) -> Result<Vec<String>, String> {
    let manager = state.0.read().await;
    manager.storage_keys(&id).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_clear(
    state: State<'_, PluginState>,
    id: String,
) -> Result<(), String> {
    let manager = state.0.read().await;
    manager.storage_clear(&id).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_http_request(
    state: State<'_, PluginState>,
    id: String,
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let manager = state.0.read().await;
    manager
        .http_request(&id, &method, &url, headers, body)
        .await
        .map_err(to_msg)
}
