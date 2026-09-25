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

// ============================================================
// 沙箱界面：前端量矩形，宿主建/摆/关 webview
// ============================================================
//
// 为什么由**前端**给位置：只有它知道标签栏、分屏、侧边栏当前各占多少。
// 宿主自己算就要把整套布局再实现一遍，而那两份一定会漂。
//
// 为什么不是"前端画一个 iframe"：插件界面必须是**独立 webview**，`iframe` 拿不到
// 真正的隔离（见 docs/08-规划/插件沙箱与数据-v2.0范围.md §2.3）。
// 代价是它盖在 DOM 之上，位置只能由宿主摆 —— 于是有了这三条命令。

/// 显示一个沙箱插件的一个界面（不存在就建），并摆到给定矩形。
///
/// 只对清单里写了 `runtime: "sandboxed"` 的**已安装**插件、且清单里**声明过**的
/// 界面 id 有效；其余一律拒绝（理由见 `sandbox::open_surface_at`）。
///
/// `surface` 缺省是主界面（`"main"`）。缺省值的意义在于：单界面插件的调用方
/// （包括已发布的那 9 个）**一个字都不用改** —— 它们的形态与多界面之前逐字节相同。
///
/// **这四条命令必须是 `async`。** 同步命令的函数体在 IPC 线程（也就是主线程）
/// 上就地执行，而它们最终会创建 / 摆弄 / 销毁真实 webview —— 那正是不能在主线程
/// 上做的事。把它写回同步的，就是那次整机假死。完整推导见 `surface.rs` 文件头。
#[tauri::command]
pub async fn sandbox_surface_open(
    app: AppHandle,
    plugin_id: String,
    surface: Option<String>,
    bounds: super::surface::SurfaceBounds,
) -> Result<(), String> {
    let surface = surface.unwrap_or_else(super::surfaces::primary_surface);
    super::sandbox::open_surface_at(&app, &plugin_id, &surface, bounds).await
}

/// 隐藏界面但**不销毁**。切标签、宿主浮层盖上来、窗口被收起时走它。
///
/// 与 `close` 分开是有意的：下一节要付的代价差一个数量级 —— 隐藏是即时的，
/// 而重新创建要重走一遍 WebView2 控制器创建（几百毫秒），插件自己的界面状态
/// 也会一起丢掉。
#[tauri::command]
pub async fn sandbox_surface_hide(
    app: AppHandle,
    plugin_id: String,
    surface: Option<String>,
) -> Result<(), String> {
    let surface = surface.unwrap_or_else(super::surfaces::primary_surface);
    super::sandbox::hide_surface(&app, &plugin_id, &surface).await
}

/// 关闭并销毁一个沙箱插件的界面。没开着时是**静默成功** ——
/// 前端在卸载时无条件调用它，把"本来就没开"当成错误只会在日志里堆噪声。
///
/// 不传 `surface` 时关掉这个插件的**全部**界面。这不是顺手加的：插件被停用或
/// 卸载时，它开着的每一个界面都必须消失 —— 而那时调用方（前端）只知道插件 id。
#[tauri::command]
pub async fn sandbox_surface_close(
    app: AppHandle,
    plugin_id: String,
    surface: Option<String>,
) -> Result<(), String> {
    match surface {
        Some(surface) => super::sandbox::close_surface(&app, &plugin_id, &surface).await,
        None => super::sandbox::close_all_surfaces(&app, &plugin_id).await,
    }
}

/// 重新摆放一个沙箱插件的界面。
///
/// 窗口缩放、侧边栏折叠、分屏比例变化、以及**宿主内容滚动**都走它 ——
/// 原生 webview 不跟着 DOM 走，位置只能由前端量出来再告诉我们。
#[tauri::command]
pub async fn sandbox_surface_bounds(
    app: AppHandle,
    plugin_id: String,
    surface: Option<String>,
    bounds: super::surface::SurfaceBounds,
) -> Result<(), String> {
    let surface = surface.unwrap_or_else(super::surfaces::primary_surface);
    super::sandbox::set_surface_bounds(&app, &plugin_id, &surface, bounds).await
}

/// 运行沙箱自检（诊断用）。**由人显式触发。**
///
/// 它打开一块面板，在一个**真实**的插件 webview 里把四条边界各跑一次：ACL 是否
/// 真的拒绝、身份是否真的来自浏览器引擎、自定义协议是否可用、CSP 是否真的生效。
/// 结果同时画在面板上并写进日志。
///
/// 它**不再随应用启动自动运行** —— 每次启动都弹一块面板去验一件大多数时候都成立的
/// 事，代价是一个每天都会遇到的打扰。为什么保留它、以及不再自动跑的理由，
/// 见 `sandbox::open_selftest`。
#[tauri::command]
pub async fn sandbox_self_test(app: AppHandle) -> Result<(), String> {
    super::sandbox::open_selftest(&app).await
}

/// 一个插件声明了哪些界面（`contributes.surfaces`）。
///
/// ============================================================
/// 为什么做成命令，而不是让前端自己解析清单
/// ============================================================
//
// `contributes.surfaces` 的合法形状由 Rust 侧的 `surfaces::SurfaceSet::parse`
// 定义：它要挡入口路径越界、缺主界面、id 冲突、数量超限。前端再实现一遍判断
// 只会多出一套会漂的规则 —— 而漂开的方向是**"宿主认为有两个界面、前端只登记了
// 一个"**，症状是某个界面点了没反应。这与 `plugin_background_contribution`
// 是同一条分工。
///
/// 单界面插件（包括全部已发布插件）会拿到一个长度为 1、`primary: true` 的数组
/// —— 这正是"隐式主界面"在界面这一侧的可见形式。
#[tauri::command]
pub async fn plugin_surfaces(
    state: tauri::State<'_, super::PluginState>,
    id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let manager = state.inner().0.read().await;
    let view = manager.sandbox_view(&id).map_err(to_msg)?;

    Ok(view
        .surfaces
        .all()
        .iter()
        .map(|surface| {
            serde_json::json!({
                "id": surface.id,
                "name": surface.name,
                "primary": surface.is_primary(),
            })
        })
        .collect())
}

/// 把宿主的主题快照交给插件系统。由前端在主题变化时调用。
///
/// ============================================================
/// 为什么是"前端推上来"而不是宿主自己去读
/// ============================================================
///
/// 主题的**真源在宿主文档里**（那一堆 CSS 自定义属性），而宿主文档跑在主窗口的
/// webview 里。Rust 这一侧没有 `document` 可读，也不该去读一个它看不见的东西。
///
/// 因此前端是唯一知道"现在的令牌是什么"的一方，它把整份快照推上来，宿主只负责
/// 把它注入插件文档并推给已经打开的界面。
///
/// **返回是否真的变了**：前端会因为它自己的理由重推同一份快照（窗口重新获得
/// 焦点、设置页重渲染），而每一次"真的变了"都会触发一圈 `eval` ——
/// 不判等会让那些无关的动作触发所有插件界面重绘。
#[tauri::command]
pub async fn set_plugin_theme(
    app: AppHandle,
    theme: super::theme::ThemeSnapshot,
) -> Result<bool, String> {
    let Some(state) = app.try_state::<super::theme::PluginTheme>() else {
        return Err("主题尚未就绪".to_string());
    };

    if !state.set(theme) {
        return Ok(false);
    }

    // 只推给**已经打开的**界面。没打开的会在它下一次加载时从入口文档里拿到
    // 最新的那一份，不需要任何额外动作。
    super::sandbox::apply_theme(&app).await;
    Ok(true)
}

/// 当前的主题快照（诊断与自检用）。
#[tauri::command]
pub fn get_plugin_theme(app: AppHandle) -> serde_json::Value {
    app.try_state::<super::theme::PluginTheme>()
        .map(|state| state.describe())
        .unwrap_or(serde_json::Value::Null)
}

/// 把宿主的快捷键表交给插件系统。由前端在快捷键注册表变化时调用。
///
/// ============================================================
/// 这张表要解决的事
/// ============================================================
///
/// 键盘焦点落进插件的 webview 之后，keydown 就只在**插件自己的文档**里派发 ——
/// 宿主窗口上的监听器什么都收不到。因此用户在插件界面里按 Ctrl+K（全局搜索）、
/// Ctrl+W（关闭标签）会一点反应都没有，而在宿主界面里是好的。
///
/// 桥接层据此表判断某个组合该不该转发回来。它必须是**整张表**而不是一个
/// "是不是宿主快捷键"的布尔 —— 桥接层没法每次按键都问宿主一趟。
///
/// **返回是否真的变了**：注册表会因为它自己的理由重推同一张表，而每一次
/// "真的变了"都会触发一圈 `eval`。
#[tauri::command]
pub async fn set_plugin_shortcuts(
    app: AppHandle,
    table: super::shortcuts::ShortcutTable,
) -> Result<bool, String> {
    let Some(state) = app.try_state::<super::shortcuts::PluginShortcuts>() else {
        return Err("快捷键表尚未就绪".to_string());
    };

    if !state.set(table) {
        return Ok(false);
    }

    super::sandbox::apply_shortcuts(&app).await;
    Ok(true)
}

/// 当前的快捷键表（诊断与自检用）。
#[tauri::command]
pub fn get_plugin_shortcuts(app: AppHandle) -> serde_json::Value {
    app.try_state::<super::shortcuts::PluginShortcuts>()
        .map(|state| state.describe())
        .unwrap_or(serde_json::Value::Null)
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

/// 「开发链接」插件当前**磁盘指纹**，供开发模式的自动重载判断"要不要刷新"。
///
/// 返回 `插件 ID → 指纹`，只含开发链接（`devSource` 非空）的插件。没有开发链接的
/// 插件不在结果里 —— 它们的代码来自安装目录的副本，改源目录对它们没有意义。
///
/// ============================================================
/// 为什么由后端算指纹，而不是前端读文件比内容
/// ============================================================
///
/// 前端要判断"变了没有"，最直接的写法是定时把 `index.js` 读回来比内容。但一个
/// 多文件构建出来的插件产物是**几百 KB**（kanban 现在是 367 KB），读回来越过一次
/// IPC 就是一次完整反序列化。按秒轮询时这是纯粹的浪费。
///
/// 指纹用 `(长度, 修改时间)`，一次读 `metadata` 就够 —— 不读文件内容。
/// 它挡得住"重新构建了产物"这一种变化，而那正是开发模式唯一关心的变化。
///
/// **指纹不参与任何信任决策。** 它不是校验和，不用于判断内容是否被篡改 ——
/// 那件事由安装时的签名与哈希负责，与这里无关。
#[tauri::command]
pub async fn dev_plugin_fingerprints(
    state: State<'_, PluginState>,
) -> Result<HashMap<String, String>, String> {
    let manager = state.inner().0.read().await;

    let mut fingerprints = HashMap::new();
    for plugin in manager.list() {
        let Some(source) = plugin.dev_source.as_deref() else {
            continue;
        };

        // 入口文件名与 `resolve_asset_root` / 前端加载路径保持一致：
        // 清单里没写 `main` 时默认 `dist/index.js`。
        let entry = {
            let declared = plugin.manifest.main.trim();
            if declared.is_empty() {
                "dist/index.js".to_string()
            } else {
                declared.to_string()
            }
        };

        let path = PathBuf::from(source).join(&entry);
        let Ok(metadata) = std::fs::metadata(&path) else {
            // 文件暂时不在（构建中、或刚被删）—— 报一个可区分标记，让前端把它当成
            // "有变化"，从而触发一次重载并把错误显示出来。静默跳过会让作者对着
            // 一个不再更新的界面等下去。
            fingerprints.insert(plugin.id.clone(), "missing".to_string());
            continue;
        };

        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);

        fingerprints.insert(plugin.id.clone(), format!("{}:{}", metadata.len(), modified));
    }

    Ok(fingerprints)
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
    app: AppHandle,
    state: State<'_, PluginState>,
    id: String,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    let outcome = {
        let mut manager = state.inner().0.write().await;
        manager.set_enabled(&id, enabled).map_err(to_msg)?
    };

    // 停用一个插件时，它**已经开着的界面必须一起消失**。
    //
    // 不关的话，那些 webview 会继续活着并停在屏幕上 —— 它们属于一个"已经不存在
    // 的插件"，下一次协议请求会被判成"这个插件当前不可用"，于是用户看到几块再也
    // 刷不出来的空白面板，而唯一的补救方式是重启应用。
    //
    // 放在**命令这一层**而不是让前端记得调：停用插件有三条路径（界面上的开关、
    // 卸载、将来的命令行），让每一条都记得做同一件事，迟早会漏掉一条 ——
    // 而漏掉的表现是一个还需要重启才能恢复的状态。
    if !enabled {
        if let Err(error) = super::sandbox::close_all_surfaces(&app, &id).await {
            log::warn!("停用 {id} 时关闭它的界面失败：{error}");
        }
    }

    Ok(outcome)
}

#[tauri::command]
pub async fn uninstall_plugin(app: AppHandle, state: State<'_, PluginState>, id: String) -> Result<(), String> {
    {
        let mut manager = state.inner().0.write().await;
        manager.uninstall(&id).map_err(to_msg)?;
    }

    // 与停用同理：被卸载的插件不该留下任何界面。顺序是**先卸再关** ——
    // 反过来的话，`close_all_surfaces` 之后到 `uninstall` 之间那段窗口里，
    // 插件还能重新建出一个界面来。
    if let Err(error) = super::sandbox::close_all_surfaces(&app, &id).await {
        log::warn!("卸载 {id} 时关闭它的界面失败：{error}");
    }

    Ok(())
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

/// 删除一个插件的数据目录（**不要求它仍然安装**）。不可撤销。
///
/// 与 `plugin_storage_clear` 的分工：那一条要求插件仍然安装且声明了 `storage`
/// 权限（它是"插件清自己的数据"）；这一条是**用户删自己机器上的东西**，
/// 因此卸载之后也要能用 —— 否则"卸载保留数据"会把残留变成删不掉的目录。
///
/// 前端必须**先确认**再调它。它不是"顺手清一下"的接口。
#[tauri::command]
pub async fn plugin_data_clear(state: State<'_, PluginState>, id: String) -> Result<(), String> {
    let manager = state.inner().0.read().await;
    manager.clear_data(&id).map_err(to_msg)
}

/// 一个插件数据目录的占用字节数（**不要求它仍然安装**）。
///
/// 与 `plugin_storage_usage` 的分工：那一个报的是键值存储的配额用量、要过权限；
/// 这一个只是"这个目录占了多少磁盘"—— 卸载确认框要拿它把选择说清楚。
#[tauri::command]
pub async fn plugin_data_usage(state: State<'_, PluginState>, id: String) -> Result<u64, String> {
    let manager = state.inner().0.read().await;
    manager.data_usage(&id).map_err(to_msg)
}

/// 列一个目录。`rel` 为空表示插件的**数据根**。
#[tauri::command]
pub async fn plugin_data_list(
    state: State<'_, PluginState>,
    id: String,
    rel: String,
) -> Result<Vec<super::data_dir::DataEntry>, String> {
    let manager = state.inner().0.read().await;
    manager.data_list(&id, &rel).map_err(to_msg)
}

/// 取一个路径的元信息。不存在时返回 `null`（不是错误）。
#[tauri::command]
pub async fn plugin_data_stat(
    state: State<'_, PluginState>,
    id: String,
    rel: String,
) -> Result<Option<super::data_dir::DataStat>, String> {
    let manager = state.inner().0.read().await;
    manager.data_stat(&id, &rel).map_err(to_msg)
}

/// 读一个文件，返回 **base64**。
///
/// 为什么是 base64 而不是原始字节：`invoke` 的参数走 JSON，JSON 里放不下二进制。
/// 代价是 33% 的体积与一次字符串拷贝 —— 对配置、缩略图、几 MB 的文档可以接受，
/// 对几百 MB 的文件不行。**原始字节的通道是下一步**（Tauri 的 `invoke` 支持把
/// `Uint8Array` 直接作为请求体，那样没有转义开销）。
///
/// 这一条与 `ctx.storage` 的区别不在这里，而在有没有上限：
/// 存储的单值是 1 MB，这里是 256 MB。
#[tauri::command]
pub async fn plugin_data_read(
    state: State<'_, PluginState>,
    id: String,
    rel: String,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    let manager = state.inner().0.read().await;
    let bytes = manager.data_read(&id, &rel).map_err(to_msg)?;
    Ok(BASE64.encode(bytes))
}

/// 写一个文件（覆盖）。内容同样以 base64 传入。
#[tauri::command]
pub async fn plugin_data_write(
    state: State<'_, PluginState>,
    id: String,
    rel: String,
    content: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    let bytes = BASE64
        .decode(content)
        .map_err(|e| format!("内容不是合法的 base64：{e}"))?;

    let manager = state.inner().0.read().await;
    manager.data_write(&id, &rel, &bytes).map_err(to_msg)
}

/// 建一个目录（含中间层）。
#[tauri::command]
pub async fn plugin_data_mkdir(
    state: State<'_, PluginState>,
    id: String,
    rel: String,
) -> Result<(), String> {
    let manager = state.inner().0.read().await;
    manager.data_mkdir(&id, &rel).map_err(to_msg)
}

/// 删除一个文件或一棵目录树。
#[tauri::command]
pub async fn plugin_data_remove(
    state: State<'_, PluginState>,
    id: String,
    rel: String,
) -> Result<(), String> {
    let manager = state.inner().0.read().await;
    manager.data_remove(&id, &rel).map_err(to_msg)
}

/// 这个插件的数据目录当前占了多少字节。
#[tauri::command]
pub async fn plugin_data_used(
    state: State<'_, PluginState>,
    id: String,
) -> Result<u64, String> {
    let manager = state.inner().0.read().await;
    manager.data_used(&id).map_err(to_msg)
}

/// 列出已卸载插件的残留数据（id 与占用字节数，按占用从大到小）。
///
/// 卸载保留数据之后必须有这一条：没有它，那些目录既占着空间、又没有任何界面
/// 能描述它们。
#[tauri::command]
pub async fn plugin_data_orphans(
    state: State<'_, PluginState>,
) -> Result<Vec<super::manager::OrphanData>, String> {
    let manager = state.inner().0.read().await;
    Ok(manager.orphan_data())
}

/// 分页列出该插件的存储键（设置 → 插件 与插件自己的列表都走它）
///
/// 与 `plugin_storage_keys` 的区别是**规模**：那一条一次返回全部键，而插件存储
/// 的典型模式是"一条记录一个键"，键数随使用时间线性增长 —— 一个用久了的插件
/// 能拿出几万个键，前端调一次就吃掉几 MB。
///
/// `cursor` 为空表示从头开始；返回值里的 `nextCursor` 为空表示已经到底。
/// 游标是不透明的（base64），调用方只需原样回传。
#[tauri::command]
pub async fn plugin_storage_list(
    state: State<'_, PluginState>,
    id: String,
    prefix: Option<String>,
    cursor: Option<String>,
    page_size: Option<usize>,
) -> Result<super::manager::StoragePage, String> {
    let manager = state.inner().0.read().await;
    manager
        .storage_list_paged(
            &id,
            prefix.as_deref().unwrap_or(""),
            cursor.as_deref(),
            page_size,
        )
        .map_err(to_msg)
}

/// 该插件存储的当前用量（字节数与键数），用于展示与排查
///
/// 数字由后端从文件系统现算，因此界面显示的一定是磁盘上的事实，
/// 而不是某个可能过期的缓存。
#[tauri::command]
pub async fn plugin_storage_usage(
    state: State<'_, PluginState>,
    id: String,
) -> Result<super::manager::StorageUsage, String> {
    let manager = state.inner().0.read().await;
    manager.storage_usage(&id).map_err(to_msg)
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
