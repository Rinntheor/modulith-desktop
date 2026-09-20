// src-tauri/src/modules/plugins/commands.rs
// 插件系统暴露给前端的 Tauri 命令
//
// 命令名与签名是冻结契约，前端 src/services/pluginRuntime.ts 已按此调用。
// 所有命令返回 Result<T, String>，错误统一转成可读文本。

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use super::permissions::PermissionDescriptor;
use super::signature::{pubkey_from_plugin_config, verify_index_signature};
use super::types::{
    ExportOutcome, HttpResponse, InstalledPlugin, PickedAudio, PluginPermission,
};
use super::PluginState;

/// 把管理器方法的结果映射为前端可读的错误字符串
fn to_msg<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

#[tauri::command]
pub async fn list_plugins(
    state: State<'_, PluginState>,
) -> Result<Vec<InstalledPlugin>, String> {
    let manager = state.inner().0.read().await;
    Ok(manager.list())
}

#[tauri::command]
pub async fn get_plugin(
    state: State<'_, PluginState>,
    id: String,
) -> Result<Option<InstalledPlugin>, String> {
    let manager = state.inner().0.read().await;
    Ok(manager.get(&id))
}

/// 全部插件权限的元数据（标签、描述、效果、作用域、风险等级、强制程度）。
///
/// 不接收参数、不读状态，因为它描述的是宿主**自己**的权限注册表，与装了哪些
/// 插件无关。前端因此只在启动时取一次即可。
///
/// 之所以让前端来取而不是自己维护一份表：风险等级必须由宿主推导，且同一权限
/// 在"已安装插件"与"市场里待安装的插件"两处必须显示一致。详见
/// `super::permissions` 的模块注释。
#[tauri::command]
pub fn list_plugin_permissions() -> Vec<PermissionDescriptor> {
    PluginPermission::all_descriptors()
}

#[tauri::command]
pub async fn install_plugin_package(
    state: State<'_, PluginState>,
    path: String,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.inner().0.write().await;
    manager
        .install_from_lcp(&PathBuf::from(path))
        .map_err(to_msg)
}

#[tauri::command]
pub async fn install_plugin_folder(
    state: State<'_, PluginState>,
    path: String,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.inner().0.write().await;
    manager
        .install_from_folder(&PathBuf::from(path))
        .map_err(to_msg)
}

#[tauri::command]
pub async fn install_plugin_url(
    state: State<'_, PluginState>,
    url: String,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.inner().0.write().await;
    manager.install_from_url(&url).await.map_err(to_msg)
}

/// 从 URL 下载并按预期哈希校验后安装。**插件市场唯一的安装入口。**
///
/// `sha256` 是必需参数而不是可选项：一个"忘了传就静默跳过校验"的接口，早晚会在某条
/// 调用路径上被漏传，而失败方式是安静的 —— 插件装上了，校验没发生。强制传入让漏传
/// 变成一个必须写出来的显式选择。
#[tauri::command]
pub async fn install_plugin_url_verified(
    state: State<'_, PluginState>,
    url: String,
    sha256: String,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.inner().0.write().await;
    manager
        .install_from_url_verified(&url, Some(&sha256))
        .await
        .map_err(to_msg)
}

/// 从插件仓库拉取一个文本文件（索引或某个插件的 README）。
///
/// 只负责"取回一段文本"：解析、缓存、渲染都在前端。后端不该知道索引里有几个字段，
/// 也不该知道详情页要显示什么。
///
/// 地址受白名单约束（见 `manager.rs` 的 `ALLOWED_REGISTRY_HOSTS`）：它**不是**一个
/// 通用的"取任意网址"能力。插件与宿主同处一个 JS 上下文、能触达 IPC 桥，若这里放开
/// 宿主限制，一个没有声明 `network-external` 的插件就能借它发出任意外部请求。
#[tauri::command]
pub async fn fetch_registry_text(
    state: State<'_, PluginState>,
    url: String,
) -> Result<String, String> {
    let manager = state.inner().0.read().await;
    manager.fetch_registry_text(&url).await.map_err(to_msg)
}

/// 校验插件索引的签名。
///
/// **调用方必须在解析索引之前调用它。** 索引是插件分发的信任根 —— 它同时给出「装什么」
/// 与「校验哪个哈希」，因此一个被替换的索引可以连同包和哈希一起换掉。先解析再看结果等于
/// 让不可信的内容先进入解析器。
///
/// 公钥取自 `tauri.conf.json` 的 `plugins.updater.pubkey`：与应用更新共用同一对密钥，
/// 因此不在代码里再保存一份。缺公钥会**报错而不是放行**（见 `signature.rs`）。
#[tauri::command]
pub fn verify_plugin_index(
    app: AppHandle,
    index: String,
    signature: String,
) -> Result<(), String> {
    let config = app.config();
    let updater = config.plugins.0.get("updater");
    let pubkey = pubkey_from_plugin_config(updater).map_err(to_msg)?;
    verify_index_signature(&index, &signature, &pubkey).map_err(to_msg)
}

#[tauri::command]
pub async fn set_plugin_enabled(
    state: State<'_, PluginState>,
    id: String,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    let mut manager = state.inner().0.write().await;
    manager.set_enabled(&id, enabled).map_err(to_msg)
}

#[tauri::command]
pub async fn uninstall_plugin(state: State<'_, PluginState>, id: String) -> Result<(), String> {
    let mut manager = state.inner().0.write().await;
    manager.uninstall(&id).map_err(to_msg)
}

#[tauri::command]
pub async fn read_plugin_asset(
    state: State<'_, PluginState>,
    id: String,
    rel: String,
) -> Result<String, String> {
    let manager = state.inner().0.read().await;
    manager.read_asset(&id, &rel).map_err(to_msg)
}

/// 按需读取某个插件的 README（详情页用）。
///
/// **与 `list_plugins` 分开是刻意的。** README 只在用户真的打开插件详情时才有价值，
/// 而列表在每次启停插件、每次进插件页时都会重新拉一遍。500 个插件一起列出时，
/// 那些文本会被逐个读出来再跨 IPC 传过去 —— 十几 MB，而列表页一个字节都用不到。
///
/// 返回 `None` 表示这个插件没有 README（不是错误）。走 `asset_root`，因此开发链接
/// 的插件读到的是源目录里那一份。
#[tauri::command]
pub async fn read_plugin_readme(
    state: State<'_, PluginState>,
    id: String,
) -> Result<Option<String>, String> {
    let manager = state.inner().0.read().await;
    manager.readme(&id).map_err(to_msg)
}

#[tauri::command]
pub async fn export_plugin(
    state: State<'_, PluginState>,
    id: String,
    dest: Option<String>,
) -> Result<ExportOutcome, String> {
    let manager = state.inner().0.read().await;
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
    let manager = state.inner().0.read().await;
    manager.storage_get(&id, &key).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_set(
    state: State<'_, PluginState>,
    id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let manager = state.inner().0.read().await;
    manager.storage_set(&id, &key, &value).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_delete(
    state: State<'_, PluginState>,
    id: String,
    key: String,
) -> Result<(), String> {
    let manager = state.inner().0.read().await;
    manager.storage_delete(&id, &key).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_keys(
    state: State<'_, PluginState>,
    id: String,
) -> Result<Vec<String>, String> {
    let manager = state.inner().0.read().await;
    manager.storage_keys(&id).map_err(to_msg)
}

#[tauri::command]
pub async fn plugin_storage_clear(
    state: State<'_, PluginState>,
    id: String,
) -> Result<(), String> {
    let manager = state.inner().0.read().await;
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
    let manager = state.inner().0.read().await;
    manager
        .http_request(&id, &method, &url, headers, body)
        .await
        .map_err(to_msg)
}

/// 启动外部程序。需要清单声明 `process-spawn` 权限。
///
/// `args` 用 `Option` 而非 `Vec`：省略参数是常见调用，没必要强迫前端每次都传
/// 一个空数组（同 `plugin_http_request` 的 `headers` / `body`）。
#[tauri::command]
pub async fn plugin_launch_program(
    state: State<'_, PluginState>,
    id: String,
    program: String,
    args: Option<Vec<String>>,
) -> Result<(), String> {
    let manager = state.inner().0.read().await;
    manager
        .launch_program(&id, &program, &args.unwrap_or_default())
        .map_err(to_msg)
}

/// 提取一个文件的图标，返回 PNG data URL。需要 `filesystem-read` 权限。
#[tauri::command]
pub async fn plugin_extract_icon(
    state: State<'_, PluginState>,
    id: String,
    path: String,
) -> Result<String, String> {
    let manager = state.inner().0.read().await;
    manager.extract_icon(&id, &path).map_err(to_msg)
}

/// 在系统文件管理器中定位文件或目录。需要 `filesystem-read` 权限。
#[tauri::command]
pub async fn plugin_reveal_in_folder(
    state: State<'_, PluginState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let manager = state.inner().0.read().await;
    manager.reveal_in_folder(&id, &path).map_err(to_msg)
}

/// 让用户选择音频文件并读入，返回可直接播放的 data URL。需要 `filesystem-read` 权限。
///
/// 返回 `null` 表示用户取消了选择。
#[tauri::command]
pub async fn plugin_pick_audio(
    state: State<'_, PluginState>,
    id: String,
) -> Result<Option<PickedAudio>, String> {
    let manager = state.inner().0.read().await;
    manager.pick_audio(&id).await.map_err(to_msg)
}
