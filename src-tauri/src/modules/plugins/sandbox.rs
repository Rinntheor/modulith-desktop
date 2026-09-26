// src-tauri/src/modules/plugins/sandbox.rs
//
// 插件沙箱：宿主与插件界面之间的那条线。
//
// ============================================================
// 插件界面是一个**跨源 iframe**，不再是自己的 webview
// ============================================================
//
// v1.6.0 之前这里建的是宿主窗口里的**子 webview**（Tauri 的 `unstable` 特性）。
// 它给得起隔离，却给不起界面：子 webview 是引擎合成在父窗口客户区**之上**的一层
// 原生画布，`z-index` / `position: fixed` / `backdrop-filter` 对它一律无效。于是
// 宿主自己每一块"浮起来"的东西 —— 标题栏搜索展开、右键菜单、通知中心、设置
// 对话框、启动轻提示 —— 都会被插件界面盖住。那不是实现缺陷，是合成模型。
//
// 现在插件界面是宿主页面上一个 `<iframe>`，来源是自定义协议。它回到了 DOM 里，
// 层级因此由 CSS 决定；而隔离一条都没有变松。
//
// ============================================================
// 三条边界，以及它们各自依赖什么
// ============================================================
//
//   1. **子框架拿不到 IPC。** Tauri 注入的每一个内部初始化脚本
//      （`__TAURI_INTERNALS__`、invoke 脚本、metadata、IPC 脚本）都经过
//      `main_frame_script()` 包装，而它设的是 `for_main_frame_only: true` ——
//      iframe 里没有这些全局。见 tauri-2.11.5/src/manager/webview.rs。
//   2. **手工拼一条 IPC 也不行。** IPC 处理器第一件事是比对 `invoke_key`
//      （每次运行随机、只注入主框架），不匹配就**静默丢弃**。
//      见 tauri-2.11.5/src/webview/mod.rs 的 `on_message`。
//   3. **同源策略。** 插件来源是 `http://modulith-plugin.localhost`，与宿主
//      不同源，因此插件文档够不到 `parent` —— 也就枚举不出兄弟界面。
//
// ⚠️ **第 2 条是承重的，而且它会静默失效。** `webview/mod.rs::is_local_url` 把
// 自定义协议的 `.localhost` 也算 `Local`，于是主窗口的 capability 在**形式上**
// 适用于插件来源；真正拦住它的只有 `invoke_key` 那一次比对。Tauri 哪天不再要求
// 它，沙箱会**无声地**变成假的 —— 没有报错、没有症状。因此桥接层里有一条守卫会
// 主动检查 `__TAURI_INTERNALS__` / `invoke` / `window.ipc` 在不在，在就大声报出来
// —— 见 `resources/sandbox-bridge.js` 的 `assertNoHostIpc`。
//
// 顺带一提，**引擎那一侧是支持 iframe 的**：wry 注册自定义协议时会优先用
// `AddWebResourceRequestedFilterWithRequestSourceKinds(..., SOURCE_KINDS_ALL)`，
// 那个重载的注释就是为了让 **Shared Worker 与 iframe** 能走自定义协议
// （wry-0.55.1/src/webview2/mod.rs:936，对应 WebView2Feedback#1114）。
// 只有一个来源可用：那个过滤器匹配的是 `http://modulith-plugin.*`，因此所有界面
// 共享同一个来源，做不到"一个插件一个来源"。
//
// ============================================================
// 为什么走自定义协议，而不是 Tauri 的事件通道
// ============================================================
//
// 事件通道（`emit` / `listen`）要求给插件文档一条 `core:event:*` 权限 —— 那会让
// 插件能监听与伪造**任意**事件名，包括宿主内部那些。
//
// 自定义协议不同：它**完全不受 capability 管辖**（capability 只管 IPC），因此
// 插件文档可以一条权限都不给。代价是我们必须自己做认证 —— 这就是令牌的用处。
//
// 反过来，从宿主**推**进插件界面也只能走 `postMessage`（见文末）。
//
// ============================================================
// 令牌是身份，路径是凭据
// ============================================================
//
// 从前身份来自 `UriSchemeContext::webview_label()`：一个界面一个 webview，
// 标签就是身份证。iframe 没有这回事 —— 所有界面的 webview 标签都是 `main`。
//
// 继续用标签会退化得比"松一点"严重得多：**全部插件会塌成同一个身份**，插件 A
// 读得到插件 B 的数据。所以身份换成了**每个界面一个不可猜的令牌**
// （`uuid` v4，122 位随机），由宿主在建界面时签发，出现在该界面每一条请求的
// **路径第一段**：
//
//     http://modulith-plugin.localhost/<token>/            入口文档
//     http://modulith-plugin.localhost/<token>/bridge.js   桥接层
//     http://modulith-plugin.localhost/<token>/react.js    宿主那份 React
//     http://modulith-plugin.localhost/<token>/asset/...   插件资源
//     http://modulith-plugin.localhost/<token>/data/...    插件数据（原始字节）
//     http://modulith-plugin.localhost/<token>/rpc/<方法>   ctx.*
//
// 令牌只发给一个界面，而每个界面只拿得到**自己**那一个。插件控制得了自己发的
// 路径，控制不了别人那个令牌 —— 于是"插件 A 去读插件 B 的数据"在拿到令牌这一
// 步就已经不可能，而不是靠后面某条判断去发现。
//
// **名字可以猜，令牌不行。** 这是它与"标签"最本质的区别，也是它必须由宿主签发、
// 而不能由插件自己报的原因。
//
// ============================================================
// 同一个来源带来的两件事（都已封掉）
// ============================================================
//
// 所有界面共享 `http://modulith-plugin.localhost` 这一个来源，因此：
//
//   * **DOM 存储是共享的。** 插件 A 写进 `localStorage` 的东西插件 B 读得到。
//     桥接层在插件代码之前把 `localStorage` / `sessionStorage` / `indexedDB` /
//     `caches` / `document.cookie` 封成**不可重定义的**抛错访问器
//     （`freezeOriginStorage`）。"不可重定义"是关键：插件跑在同一个 realm 里，
//     可配置的属性它能自己删掉，那样封了等于没封。
//   * **`parent.frames` 够不着。** 父文档是宿主来源，与插件不同源，因此插件读
//     不到 `parent` 的任何属性 —— 也就枚举不出兄弟界面。
//
// ============================================================
// 网络第一次成为真的边界（但**不是**主屏障）
// ============================================================
//
// 插件文档由**我们**生成并附上 CSP。因为文档跑在自己的来源上，而宿主掌控着那份
// CSP，`connect-src` 得以只留插件自己的来源：插件无法直接 `fetch('https://…')`。
//
// ⚠️ **但 CSP 挡不住 Tauri IPC。** Tauri 的 IPC 有两条传输
// （`tauri/scripts/ipc-protocol.js`）：`fetch('http://ipc.localhost/<命令>')` 受
// `connect-src` 管辖，而它失败之后会回退到 `window.ipc.postMessage` —— 一条原生
// 桥，不受 CSP 管辖。**真正承重的是上面第 1、2 条。** 因此 `check:acl` 里对
// "build.rs 必须声明 AppManifest::commands" 有一条会真的失败的断言。
//
// ============================================================
// 宿主 → 插件界面：只能走 postMessage
// ============================================================
//
// 主题变更、快捷键表、命令投递、下载进度这四条从前是 `Webview::eval` 一段脚本进
// 插件 webview 的。跨源 iframe 没有 `eval` 这回事（父文档拿不到它的文档对象），
// 因此它们走**两跳**：Rust 把一条事件发给主窗口，主窗口前端按令牌找到那个 iframe，
// 再 `postMessage` 进去。
//
// 多一跳的代价是"前端必须活着"。它一直是活着的 —— 界面本来就是它渲染的，它不活着
// 就没有 iframe 可推。真正的约束是**顺序**：令牌与 iframe 的绑定发生在前端，因此
// Rust 推送时不能假设对面已经挂好了。桥接层对未识别的消息一律忽略，"推早了"因此
// 退化成一次静默丢弃，而不是一条错误。
//
// ============================================================
// 不是 OS 级沙箱
// ============================================================
//
// 插件仍在同一个操作系统进程里、同一个用户下，而且**可能**在同一个渲染进程里
// （跨源 iframe 会不会被引擎的站点隔离分到独立进程，是引擎的策略，不是我们能
// 依赖的东西）。它挡住的是"插件在应用内的权限"，不是"插件对这台机器的权限" ——
// 后者要靠 job object / AppContainer 一类手段。任何把它读成"装了插件就安全"的
// 说法都是错的。

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use tauri::{http, AppHandle, Manager, Runtime};

use super::manager::SandboxView;

/// 承载插件界面的自定义协议名。
///
/// 不能与 Tauri 自己注册的取同名（`tauri`、`ipc`、`asset`），否则会把它们顶掉。
pub const SCHEME: &str = "modulith-plugin";

/// 宿主推给前端的通道名。前端据此把它转成一条 `postMessage` 送进对应的 iframe。
///
/// 中间这一跳是 iframe 模型**独有**的：从前宿主能直接 `eval` 进插件 webview，
/// 现在它连那个文档都拿不到（跨源）。见文件头"只能走 postMessage"。
pub const PUSH_EVENT: &str = "modulith://sandbox-push";

/// 自检窗口的标签。**它是全宿主唯一还存在的"插件侧" webview 标签。**
///
/// 真插件界面不再有标签 —— 它们是 iframe，webview 标签全是 `main`。自检页之所以
/// 仍是一个独立窗口，是因为它要回答的那个问题（"我能不能 invoke"）只有在**一个
/// 真的 webview** 里才问得出来，而它必须在没有 IPC 的环境里问。
///
/// `capabilities/` 里没有任何文件把 `plugin-*` 纳入作用域，因此它一条 IPC 权限
/// 都没有 —— `pnpm check:acl` 断言这一点。
pub const LABEL_PREFIX: &str = "plugin-";

/// 自检窗口的标签。
///
/// 它必须带 `LABEL_PREFIX`：`capabilities/` 靠那个前缀把这类窗口排除在外，而
/// 自检页要在**没有 IPC** 的环境里跑（那正是它要验的第一件事）。
pub const SELFTEST_LABEL: &str = "plugin-selftest";

/// 插件文档在**浏览器里看到的**来源。
///
/// Windows 与 Android 上 WebView2 只支持标准协议，wry 会把
/// `modulith-plugin://localhost/...` 改写成 `http://modulith-plugin.localhost/...`
/// 再拦截回来（见 wry 的 `custom_protocol_workaround`）。协议处理器**收到的**
/// 是改写回去的形式，但页面里的 CSP 与 `fetch` 必须写改写后的形式。
#[cfg(any(windows, target_os = "android"))]
pub const ORIGIN: &str = "http://modulith-plugin.localhost";
#[cfg(not(any(windows, target_os = "android")))]
pub const ORIGIN: &str = "modulith-plugin://localhost";

/// 自检用的伪插件 id。它**不是**真插件，只是让这条链路有一个可运行的实例。
pub const SELFTEST_ID: &str = "selftest";

const SELFTEST_HTML: &str = include_str!("../../../resources/sandbox-selftest.html");
const SELFTEST_PROBE_HTML: &str = include_str!("../../../resources/sandbox-selftest-probe.html");
const BRIDGE_JS: &str = include_str!("../../../resources/sandbox-bridge.js");

/// 送给沙箱插件的 React + ReactDOM + JSX 运行时。
///
/// **它是宿主的，不是插件的。** 由 `scripts/build-plugin-react.ts` 从宿主自己那份
/// `react` / `react-dom` 生成，因此插件页面里跑的与宿主页面里跑的是**同一个版本** ——
/// 而不是"每个插件各钉一个"。
///
/// 为什么必须由宿主送：插件仓库的构建把 `react` 与 `react/jsx-runtime` 标成
/// external，并接到 `globalThis.Modulith.React` 上；那条约定的前提是
/// **同一个文档里只有一个 React 实例**（两个实例互相不认识，context 取不到、
/// hook 调用错乱）。in-process 插件拿的是宿主页面那个实例，沙箱插件是独立文档 ——
/// 不送过去，它就只能自己打一份，那正是这条约定要防的事。
const PLUGIN_REACT_JS: &str = include_str!("../../../resources/react-runtime.js");

// ============================================================
// 沙箱这边**不记插件的事实**，只记"我建过哪些界面"
// ============================================================
//
// 曾经的做法是本模块记一份 `标签 → {根目录, 入口, 样式, 权限}`。那是错的：
// 宿主里于是有了两套"什么插件存在、它能做什么"（另一套是 `PluginManager`，
// 存储的权限与配额判定都在它那里）。两套清单一定会漂，而漂开的方向是
// **"沙箱以为这个插件存在、存储那边不认"** —— 实测撞到过一次，
// 见 docs/06-项目/已知问题与技术债.md §7.40。
//
// 现在的事实只有一个来源：`PluginManager::sandbox_view`。本模块只保留
// **标签 → 界面身份**这一条映射，而它不可能与真源漂开 —— 因为每一次界面创建
// 都必须先通过 `sandbox_view` 拿到那个插件与那个界面，拿不到就建不出来。
//
// 也就是说：**没安装的插件、没声明的界面，都拿不到界面，这是构造上就成立的**，
// 不是靠一道检查。

/// 一条界面的身份：**哪个插件的哪一个界面**。
///
/// 它同时是 `rpc::dispatch` 的第三个参数：同一个 `ctx` 有两个调用方（沙箱界面与
/// Node 后台），而**只有界面有"我在哪个界面里"这一说**。后台插件传 `None`，
/// 于是"这个调用从哪个界面发出来"在类型上就是可选的，而不是一个空字符串约定。
///
/// `Hash` 是给注册表的反向表用的（身份 → 令牌）。少了它就只能线性找，而
/// `open` 是会被反复调用的（React 的重复渲染、StrictMode 双调用都会走到）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SurfaceKey {
    /// 插件 id（原始值，不是净化过的那个）
    pub plugin_id: String,
    /// 界面 id
    pub surface: String,
}

impl SurfaceKey {
    pub fn new(plugin_id: impl Into<String>, surface: impl Into<String>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            surface: surface.into(),
        }
    }

    /// 是不是主界面。与 `SurfaceDecl::is_primary` 同一条判据。
    pub fn is_primary(&self) -> bool {
        self.surface == super::surfaces::PRIMARY_SURFACE
    }
}

/// 令牌注册表：**令牌 → 界面身份**，以及反向的**界面身份 → 令牌**。
///
/// 用 `std::sync::RwLock` 而不是 tokio 的：协议处理器要同步读它，而临界区里只做
/// 一次哈希查找 —— 短到不会成为一个需要异步的理由。
///
/// 两张表被关在**同一把锁**里。分开锁会出现"正向表说这个令牌属于 A、反向表说 A
/// 的令牌是另一个"的瞬间，而那个瞬间的表现是同一个界面被签发两个令牌 ——
/// 多出来的那个永远不会被回收，也就永远有效。
///
/// 反向表的存在是为了**幂等**：`open` 会被反复调用（React 重复渲染、宿主布局
/// 变化后的重挂载、StrictMode 的双调用）。每次都签发新令牌的话，旧令牌会一直
/// 留在正向表里，而它对应的 iframe 早已不存在 —— 那是一条**没人再看得见、
/// 却仍然能读这个插件数据**的凭据。同一个界面因此永远只有一个令牌。
///
/// 从前这张表的键是 webview 标签，值是 `SurfaceKey`。换掉的理由写在文件头：
/// iframe 没有"自己的 webview 标签"，继续用标签会让全部插件塌成同一个身份。
#[derive(Default)]
struct Registry {
    by_token: HashMap<String, SurfaceKey>,
    by_key: HashMap<SurfaceKey, String>,
}

#[derive(Default)]
pub struct SandboxSurfaces(RwLock<Registry>);

impl SandboxSurfaces {
    /// 签发（或取回）这个界面的令牌。
    ///
    /// 令牌是 `uuid` v4 的简单形式 —— 32 个十六进制字符、122 位随机。它**必须**
    /// 不可猜：它是访问这个界面数据的唯一凭据，猜中一个就等于拿到了那个插件的
    /// 全部数据面（`data` 通道能读写的每一个字节）。
    pub(super) fn issue(&self, key: SurfaceKey) -> String {
        let mut registry = self.0.write().unwrap_or_else(|e| e.into_inner());

        if let Some(token) = registry.by_key.get(&key) {
            return token.clone();
        }

        // 32 个十六进制字符的空间大到不会碰撞，但"不会"不是"不必检查" ——
        // 一次碰撞的后果是两个插件共享一份数据，而检查的代价是一次哈希查找。
        let mut token = new_token();
        while registry.by_token.contains_key(&token) {
            token = new_token();
        }

        registry.by_token.insert(token.clone(), key.clone());
        registry.by_key.insert(key, token.clone());
        token
    }

    /// 这个令牌是哪个插件的哪个界面。没签发过就返回 `None` —— 调用方必须把它
    /// 当成"这个请求不是来自插件界面"，而不是"插件 id 是空串"。
    pub(super) fn key_of(&self, token: &str) -> Option<SurfaceKey> {
        self.0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .by_token
            .get(token)
            .cloned()
    }

    /// 忘掉一个令牌。界面被卸载、插件被停用、自检窗口被关掉时调用。
    ///
    /// **两张表必须一起删。** 只删一张的话，正向表里会留下一条指向已不存在界面的
    /// 记录 —— 于是那个令牌**继续有效**，一个已经关掉的界面还能读写这个插件的数据。
    pub(super) fn forget(&self, token: &str) {
        let mut registry = self.0.write().unwrap_or_else(|e| e.into_inner());
        if let Some(key) = registry.by_token.remove(token) {
            registry.by_key.remove(&key);
        }
    }

    /// 撤销一个插件的**全部**令牌，返回撤销掉的那些（顺序不定）。
    ///
    /// 返回令牌而不是只返回数量，是因为调用方还要拿它们去告诉前端"把这几块界面
    /// 卸掉" —— 插件被停用时，它的 iframe 不该继续留在屏幕上。
    pub(super) fn forget_plugin(&self, plugin_id: &str) -> Vec<String> {
        let mut registry = self.0.write().unwrap_or_else(|e| e.into_inner());

        let tokens: Vec<String> = registry
            .by_token
            .iter()
            .filter(|(_, key)| key.plugin_id == plugin_id)
            .map(|(token, _)| token.clone())
            .collect();

        for token in &tokens {
            if let Some(key) = registry.by_token.remove(token) {
                registry.by_key.remove(&key);
            }
        }

        tokens
    }

    /// 当前全部界面：`(令牌, 身份)`。
    ///
    /// 给**跨插件事件**与**主题/快捷键/命令/下载进度推送**用：一条事件要送到每一个
    /// 还活着的界面，由各自的桥接层决定有没有人订阅它。
    ///
    /// 为什么是"推给所有界面"而不是"宿主先问谁订阅了"：后者需要多一套订阅登记的
    /// 协议与状态（注册 / 注销 / 界面销毁时清理），而界面数量是有界的。**用一个
    /// 有界的代价换掉一整套会漂的状态**，在这里是划算的。
    pub(super) fn live(&self) -> Vec<(String, SurfaceKey)> {
        self.0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .by_token
            .iter()
            .map(|(token, key)| (token.clone(), key.clone()))
            .collect()
    }

    /// 某个插件当前开着的界面 id 列表（去重、已排序）。
    ///
    /// 给 `ui.listSurfaces` 用。**从这张表读而不是问前端**：这张表就是"开没开"的
    /// 真源，而前端那一侧还要经过标签状态、渲染时机、React 提交才能回答同一个
    /// 问题 —— 两个来源一定会漂，而漂开的方向是"插件以为界面开着，其实早关了"。
    pub(super) fn surfaces_of(&self, plugin_id: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .by_token
            .values()
            .filter(|key| key.plugin_id == plugin_id)
            .map(|key| key.surface.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }
}

/// 一个新令牌。
fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 令牌的**形状**校验。
///
/// 形状不对的令牌进不了注册表，查出来一样是 `None` —— 那为什么还要单独判一次？
/// 因为这条路径的第一段完全来自外部（插件自己发的 URL，长度随意）。不判的话每个
/// 请求都会拿一段任意长的字符串去哈希一次；闸门放在最前面，代价只是一次长度比较。
pub(super) fn is_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

// ============================================================
// 注册协议

// ============================================================

/// 把协议处理器挂到 builder 上。
///
/// 处理器对应用里的**每一个** webview 都注册（见 tauri-runtime-wry 的
/// `create_webview`），因此主窗口与自检窗口都能用同一条协议。iframe 发出的请求
/// 也由宿主 webview 的处理器接住 —— wry 注册过滤器时优先用的是
/// `AddWebResourceRequestedFilterWithRequestSourceKinds(..., SOURCE_KINDS_ALL)`，
/// 那个重载存在的理由正是让 **iframe 与 Shared Worker** 也能走自定义协议
/// （wry-0.55.1/src/webview2/mod.rs:936，对应 WebView2Feedback#1114）。
///
/// 用**异步**变体：存储类 RPC 要读 `PluginManager`（在一把 tokio 锁后面），
/// 而同步变体的处理器跑在主线程上，在那里做异步等待会卡住界面。
///
/// **身份取自 URL 的第一段，不取自 `ctx.webview_label()`。** 后者对全部插件界面
/// 都返回 `main` —— 那是 iframe 模型下最危险的一条误用，见文件头"令牌是身份"。
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| {
        let app = ctx.app_handle().clone();

        tauri::async_runtime::spawn(async move {
            responder.respond(handle(&app, request).await);
        });
    })
}

// ============================================================
// 路由
// ============================================================
//
// 路径的第一段是**令牌**：它本身就是凭据，查出来就是身份。插件控制得了自己发的
// 路径，控制不了别人那个令牌 —— 因此这里不需要再拿"路径里声称的插件 id"去和
// 身份对一遍（那种判断在旧的标签方案里是必需的，因为标签里带着插件 id，
// 而现在 URL 里根本没有插件 id 可以撒谎）。

async fn handle<R: Runtime>(
    app: &AppHandle<R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    // 路径先取成**自己拥有的**字符串，再切分。
    //
    // 直接从 `request.uri().path()` 切出一堆 `&str` 的话，`segments` 就借住了
    // `request` —— 而下面要把 `request` 整个移交给 `handle_selftest` 与
    // `dispatch_rpc`。借住与移交不能共存，这是编译器拦下的第一件事。
    let path = request.uri().path().to_string();
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    let token = segments.first().copied().unwrap_or("");

    // 形状先判。这一段的长度完全由外部决定，而注册表的每一次查找都要哈希它一次 ——
    // 闸门放在最前面，代价只是一次长度比较。
    if !is_token(token) {
        log::warn!("[sandbox] 拒绝令牌形状不合法的协议请求");
        return text(403, "这个来源不是插件界面");
    }

    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        log::warn!("[sandbox] 界面表尚未就绪，拒绝一条协议请求");
        return text(503, "沙箱尚未就绪");
    };

    // 身份来自这张表，而表里的每一条都是**建界面时经 `PluginManager` 核实过**的。
    // 也就是说：一个没安装的插件、或者一个没声明的界面，都不可能出现在这里。
    let Some(key) = surfaces.key_of(token) else {
        log::warn!("[sandbox] 拒绝来自未签发令牌的协议请求");
        return text(403, "这个来源不是插件界面");
    };

    // 自检页没有插件目录，因此它不走下面的 `sandbox_view`。放在令牌校验**之后**：
    // 它虽然是宿主内置的，但把它公开给任何请求都读得到的地址没有好处。
    if key.plugin_id == SELFTEST_ID {
        return handle_selftest(app, token, request, &segments).await;
    }

    // 插件的事实（根目录、入口、样式、权限、界面表）从 `PluginManager` 读 —— 单一真源。
    // 锁在文件 IO 之前放掉（下面的入口文档与资源读取都要碰磁盘）。
    let view = {
        let Some(state) = app.try_state::<super::PluginState>() else {
            return text(503, "插件系统尚未就绪");
        };
        let manager = state.0.read().await;
        match manager.sandbox_view(&key.plugin_id) {
            Ok(view) => view,
            Err(e) => {
                log::warn!("[sandbox] 取不到 {} 的沙箱视图：{e}", key.plugin_id);
                return text(404, "这个插件当前不可用");
            }
        }
    };

    // 界面必须在**当前**清单里仍然存在。开发链接（`devLink`）下清单是可变的，
    // 因此"建界面时它存在"不等于"现在还存在" —— 一个被作者删掉的界面如果继续
    // 服务旧文档，症状是"改了清单但界面还是旧的"。
    let Some(surface) = view.surface(&key.surface) else {
        log::warn!(
            "[sandbox] {} 的清单里已经没有界面 {} 了（它可能刚被改掉）",
            view.id,
            key.surface
        );
        return text(404, "这个界面已经不存在了");
    };

    let method = request.method().as_str().to_string();

    match (method.as_str(), segments.get(1).copied()) {
        // 入口文档。**由宿主合成** —— 插件包因此不必自带 HTML。
        ("GET", None) | ("GET", Some("")) | ("GET", Some("index.html")) => {
            entry_document(app, surface, token)
        }

        // 桥接层。它是宿主的一部分，不来自插件目录：插件拿不到它，也就改不了它。
        //
        // 每次响应都**按身份重新渲染一遍**（`bridge_script`），因此插件在顶层就能
        // 同步读到自己的 id / 名称 / 权限 / 界面名，不必先 await 一次握手。
        ("GET", Some("bridge.js")) => bridge_script(app, &view, &key.surface),

        // 宿主那一份 React。**在桥接层之前加载** —— 桥接层要在定义
        // `Modulith.React` 时就能读到它，而插件脚本又必须在桥接层之后。
        // 顺序由入口文档写死，插件无法插队（见 `entry_document`）。
        ("GET", Some("react.js")) => script(PLUGIN_REACT_JS),

        ("GET", Some("asset")) => {
            let rel = segments[2..].join("/");
            serve_asset(&view, &rel)
        }

        // 原始字节通道。**不走 base64** —— 这是几百 MB 的文件唯一能进出的路径。
        //
        // 为什么放在协议层而不是 RPC 里：RPC 的请求体是 JSON，二进制进去必须
        // base64（+33% 体积，外加一次完整的字符串拷贝与一次解码）。而这些
        // HTTP 消息的请求体/响应体本来就是字节，直接用它们。
        //
        // 路径里的 `..` 与前导斜杠由 `data_dir::resolve` 拒绝（chroot 语义），
        // 因此这里不必再净化一遍 —— 净化规则只有一处，才不会两处漂开。
        ("GET", Some("data")) => {
            let rel = segments[2..].join("/");
            serve_data(app, &view, &rel).await
        }

        ("PUT", Some("data")) | ("POST", Some("data")) => {
            let rel = segments[2..].join("/");
            store_data(app, &view, &rel, request.body()).await
        }

        ("POST", Some("rpc")) => {
            let Some(method) = segments.get(2).copied() else {
                return text(404, "缺少 RPC 方法");
            };
            dispatch_rpc(app, &key, method, request.body()).await
        }

        _ => text(404, "没有这条路径"),
    }
}

/// 自检页的路由。它只涉及宿主内置的那一份文档。
///
/// 它**没有插件目录**，因此上面的 `sandbox_view` 那一段它不适用；令牌校验照旧
/// 走同一条路 —— 自检页与真插件界面用同一套身份机制，不给它开小门。
///
/// `close` 是一条**独立的**方法，不能落进下面的"结果上报"分支 —— 它发的是
/// 无 body 的 POST，被当成上报解析会得到一条 `EOF while parsing a value`
/// 的告警，而面板**关不掉**。这里踩过一次。
async fn handle_selftest<R: Runtime>(
    app: &AppHandle<R>,
    token: &str,
    request: http::Request<Vec<u8>>,
    segments: &[&str],
) -> http::Response<Cow<'static, [u8]>> {
    let method = request.method().as_str().to_string();

    match (method.as_str(), segments.get(1).copied()) {
        ("GET", None) | ("GET", Some("")) => selftest_html(SELFTEST_HTML),
        ("GET", Some("selftest.html")) => selftest_html(SELFTEST_HTML),
        // 探针：它只在自检页里的一个 iframe 中跑，用来回答"真插件界面那个模型里
        // 到底有没有宿主 IPC"。见 `sandbox-selftest-probe.html`。
        ("GET", Some("probe")) => selftest_html(SELFTEST_PROBE_HTML),
        ("GET", Some("rpc")) => match segments.get(2).copied() {
            Some("ping") => json(&format!(
                r#"{{"ok":true,"token":"{token}","plugin":"{SELFTEST_ID}"}}"#
            )),
            _ => text(404, "未知的 RPC 方法"),
        },
        ("POST", Some("rpc")) => {
            if segments.get(2).copied() == Some("close") {
                request_selftest_close(app, token);
                return json(r#"{"ok":true}"#);
            }

            let body = String::from_utf8_lossy(request.body()).to_string();
            log_selftest_report(&body);
            json(r#"{"ok":true}"#)
        }
        _ => text(404, "没有这条路径"),
    }
}

/// 请求关掉自检窗口，并把它的令牌一起收回。
///
/// **不能就地在协议处理器里关。** 那一刻我们正跑在一条尚未回复的请求路径上，
/// 把承载它的窗口拆掉会让这条回复无处可去。因此关的动作放到一个**独立的异步
/// 任务**里 —— 当前任务会先跑完并把回复交出去。
///
/// 令牌必须跟着窗口一起消失：少了这一步，一个已经关掉的窗口留下的令牌仍然有效。
fn request_selftest_close<R: Runtime>(app: &AppHandle<R>, token: &str) {
    let app = app.clone();
    let token = token.to_string();

    tauri::async_runtime::spawn(async move {
        tokio::task::yield_now().await;

        if let Some(surfaces) = app.try_state::<SandboxSurfaces>() {
            surfaces.forget(&token);
        }

        // 走 `core::window::get` 而不是 `Manager::get_webview_window`：后者会再判一次
        // `is_webview_window()`，而那条判据在"一个窗口拥有多个 webview"时会变成假。
        // 自检窗口现在只有一个 webview，但它没有理由成为那条规则的一个例外 ——
        // 例外正是下一次踩坑的地方。见 `core/window.rs`。
        if let Some(window) = crate::core::window::get(&app, SELFTEST_LABEL) {
            if let Err(error) = window.close() {
                log::warn!("[sandbox自检] 关闭自检窗口失败：{error}");
            }
        }
    });
}

/// 自检窗口被**用户直接关掉**时，把它的令牌收回来。
///
/// 页面里那个"关闭"按钮走的是 `request_selftest_close`，而窗口右上角那个 X 走的是
/// 这里。两条路径都必须收 —— 只挂在按钮上的话，用 X 关掉就会留下一个仍然有效的
/// 令牌，而它指向的窗口早已不存在。
pub fn forget_selftest<R: Runtime>(app: &AppHandle<R>) {
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return;
    };

    for token in surfaces.forget_plugin(SELFTEST_ID) {
        log::debug!("[sandbox自检] 自检窗口已关闭，收回令牌 {token}");
    }
}

// ============================================================
// 入口文档
// ============================================================


/// 合成插件的入口文档。
///
/// **由宿主合成而不是要求插件自带 HTML**，有三个理由：
///
///   1. CSP 必须由宿主写死 —— 让插件自带 HTML 等于让它自己声明自己的边界；
///   2. 插件包的格式不必变，已有的 `main` / `style` 清单字段直接可用；
///   3. 桥接脚本的加载顺序由宿主控制，插件无法插到它前面。
///
/// 三个 `<script>` 与那份样式表的地址里都带着**本界面的令牌**。这不是装饰：
/// 协议处理器只认令牌，把令牌从地址里去掉，这三个子资源一个都加载不到。
///
/// `script-src 'self'`（不是 `'unsafe-inline'`）：桥接与插件脚本都是同源外部文件，
/// 插件因此不能靠内联脚本绕过 —— 它的入口只有一个。
fn entry_document<R: Runtime>(
    app: &AppHandle<R>,
    surface: &super::surfaces::SurfaceDecl,
    token: &str,
) -> http::Response<Cow<'static, [u8]>> {
    // **取一次快照，CSS 与类名都从它算。** 各取一次的话，两次读取之间可以插进
    // 一次主题变更 —— 那样渲染出的文档会同时带着新令牌和旧类名，一个自相矛盾的
    // 页面，而且只在"用户刚好在打开插件的同时切主题"时才出现。
    let snapshot = app
        .try_state::<super::theme::PluginTheme>()
        .map(|state| state.get());

    let theme_css = snapshot
        .as_ref()
        .map(|theme| theme.to_css())
        .unwrap_or_default();
    let root_class = snapshot
        .as_ref()
        .map(|theme| theme.root_class_attr())
        .unwrap_or_default();

    let body = entry_document_html(
        &surface.name,
        surface.style.as_deref(),
        &theme_css,
        &root_class,
        &surface.entry,
        token,
    );

    page(body, "script-src 'self'; style-src 'self' 'unsafe-inline'")
}

/// 入口文档的 HTML。
///
/// ============================================================
/// 为什么把它抽成一个**纯函数**
/// ============================================================
///
/// 主题根类名那一环出的是一次**静默到极点**的错误：模板里有 `{root_class}`，
/// 看起来什么都对，而 8 个插件的 `:root.dark …` 规则一条都不生效。
///
/// 文本级门禁能回答"模板里有没有那个占位符"，回答不了"拼出来到底长什么样"。
/// 抽成不碰 `app`、不碰状态的纯函数之后，渲染结果可以被逐条断言 —— 这是这次
/// 唯一能把"我以为它渲染对了"变成"它确实渲染成了这样"的办法。
///
/// 转义留在**函数内部**：调用方只负责把原始值交进来。放在调用方会让"某个调用点
/// 忘了转义"变成一种可能，而那种缺陷的方向是注入。
fn entry_document_html(
    name: &str,
    style: Option<&str>,
    theme_css: &str,
    root_class: &str,
    entry: &str,
    token: &str,
) -> String {
    let style_tag = match style {
        Some(rel) => format!(
            r#"  <link rel="stylesheet" href="/{token}/asset/{rel}">"#,
            token = token,
            rel = escape_attr(rel)
        ),
        None => String::new(),
    };

    format!(
        r#"<!doctype html>
<html lang="zh-CN"{root_class}>
  <head>
    <meta charset="utf-8">
    <title>{name}</title>
    <!--
      空图标。
      没有这一行，浏览器会自动去请求文档根路径的 /favicon.ico，而那个路径的第一段
      是一个形状不合法的令牌 —— 于是它会撞上"令牌必须合法"这条判断，在日志里留下
      一条**看起来像攻击的告警**，实际上只是浏览器的固定行为。实测撞到过。
      这里用一个空 data URL 把那一次请求彻底消掉，而不是去放宽那条判断。
    -->
    <link rel="icon" href="data:,">
{style}
    <!--
      文档外壳的重置。**这是宿主的事，不是插件的事。**

      没有这一段时，浏览器给 `<body>` 的默认 `margin: 8px` 会原样生效 ——
      插件界面的四周因此多出一圈 8px 的背景色缝隙，看起来像"没铺满"。
      实测就是这样：用户报的"存在留白"里有 8px 是这一行没写。

      `height: 100%` 同理：插件界面现在是一块被 CSS 撑满的 iframe，它的文档
      必须默认就填满这块区域；否则每个插件都要自己写一遍 html/body 高度 100%，
      而漏写的那个看起来就像"界面只有一半高"。
    -->
    <style>
      html, body {{ margin: 0; padding: 0; height: 100%; }}
      #modulith-root {{ min-height: 100%; }}
    </style>
    <!--
      宿主的主题令牌。**这一段由 `theme.rs` 生成**，插件的 CSS 可以直接用
      与宿主同名的变量（`var(--accent-500)`），不需要任何前缀或改名。

      ⚠️ 令牌**不是**主题的全部。令牌靠"重新声明"生效，而插件 CSS 里那些
      `:root.dark …` 规则靠**属性匹配**生效 —— 明暗类名挂在上面那个 `<html>`
      标签上（`{root_class}`），少了它这些规则一条都不匹配。两者必须一起给。
    -->
    <style id="modulith-theme">
{theme}    </style>
  </head>
  <body>
    <div id="modulith-root"></div>
    <!-- 桥接层先于插件脚本加载：插件的入口只有这一个，它拿不到更早的位置 -->
    <!--
      宿主那一份 React 排在桥接层**之前**：桥接层在定义 `Modulith.React` 时就要
      读到它。三者的顺序（React → 桥接层 → 插件）由宿主写死，插件无法插队。

      它同时受 `script-src 'self'` 约束 —— 三者都是同源外部文件，没有一条是内联。
    -->
    <script src="/{token}/react.js"></script>
    <script src="/{token}/bridge.js"></script>
    <script src="/{token}/asset/{main}"></script>
  </body>
</html>
"#,
        name = escape_html(name),
        style = style_tag,
        main = escape_attr(entry),
        theme = theme_css,
        root_class = root_class,
        token = token,
    )
}


/// 自检页：它是宿主内置的，脚本是内联的，所以那一份用 `'unsafe-inline'`。
///
/// 这个差别是有意的，**不要统一**：真插件必须是 `'self'`。
///
/// 自检页额外放开 `frame-src <ORIGIN>`：它要把**探针**嵌进一个同源 iframe 里，
/// 而"插件界面拿不到 IPC"这件事只有在 iframe 里才问得出来（见
/// `sandbox-selftest.html` 第 5 项）。真插件文档仍然必须是 `frame-src 'none'`。
fn selftest_html(body: &str) -> http::Response<Cow<'static, [u8]>> {
    page_with_frame(
        body.to_string(),
        "script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        ORIGIN,
    )
}

/// 所有插件文档共用的 CSP 外壳。
///
/// `default-src 'none'` 打底，只放开确定需要的：
///
///   * `connect-src <ORIGIN>` —— 只能跟宿主说话。挡住了插件直接 `fetch` 外网，
///     也挡住了它去够 `http://ipc.localhost`（Tauri 的 fetch 版 IPC 通道）；
///   * `frame-src 'none'` —— 不能嵌别的文档，否则可以借别人的来源发请求；
///   * `form-action 'none'` —— 表单提交是另一条不经过 `fetch` 的出站路径；
///   * `base-uri 'none'` —— 防止把相对地址改指到别处；
///   * `img-src` / `font-src` 放开到 `'self' data:` —— 界面要用。
fn page(body: String, script_and_style: &str) -> http::Response<Cow<'static, [u8]>> {
    page_with_frame(body, script_and_style, "'none'")
}

/// `page` 的完整形态，`frame-src` 由调用方给。
///
/// 只有自检页会传一个真来源进去，理由写在 `selftest_html` 上。把它做成参数而不是
/// 让自检页自己拼一条 CSP：**边界只有一处实现，才不会两处漂开** —— 而这里漂开的
/// 方向是"某一份文档少了某一条限制"。
fn page_with_frame(
    body: String,
    script_and_style: &str,
    frame_src: &str,
) -> http::Response<Cow<'static, [u8]>> {
    let csp = format!(
        "default-src 'none'; {script_and_style}; connect-src {ORIGIN}; \
         img-src 'self' data: blob:; font-src 'self' data:; frame-src {frame_src}; \
         object-src 'none'; base-uri 'none'; form-action 'none'"
    );

    http::Response::builder()
        .status(200)
        .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("Content-Security-Policy", csp)
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(body.into_bytes()))
        .unwrap_or_else(|_| http::Response::new(Cow::Borrowed(&b"internal error"[..])))
}

// ============================================================
// 桥接层
// ============================================================

/// 按插件身份渲染桥接脚本。
///
/// 静态文件 + 占位符替换，而不是让桥接层自己去问"我是谁"：
///
///   * 插件在**顶层同步**就能读到自己的身份与权限，不必先 await 一次握手 ——
///     而"顶层同步可用"正是 v1.5 花一整轮保住的性质；
///   * 少一条往返。身份校验照旧在协议处理器里做，这条替换不是安全依据。
fn bridge_script<R: Runtime>(
    app: &AppHandle<R>,
    plugin: &SandboxView,
    surface_id: &str,
) -> http::Response<Cow<'static, [u8]>> {
    let permissions = serde_json::to_string(&plugin.permissions)
        .unwrap_or_else(|_| "[]".to_string());

    // 数据根目录当前可用与否，**在渲染桥接层时**问一次而不是每一次调用都问：
    // 插件在顶层就能读到 `Modulith.dataDir.available`，于是它可以决定
    // "先建目录还是先提示用户配置"。调用本身仍然会各自判一次（那才是强制点）。
    let data_available = plugin_manager(app)
        .map(|handle| {
            handle
                .try_read()
                .map(|manager| manager.data_root_status().available)
                .unwrap_or(false)
        })
        .unwrap_or(false);

    // 声明的界面表注入成字面量：插件在顶层就能写出 `if (Modulith.surfaces.length > 1)`
    // 这样的特性探测，不必先 await 一次。它是**清单的投影**，不是运行期状态 ——
    // "哪些界面开着"要去问 `ui.listSurfaces()`。
    let declared: Vec<serde_json::Value> = plugin
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
        .collect();

    // `Modulith.run()` 的引导快照里那份 `settings`。
    //
    // in-process 的 `bootstrap.settings` 是**同步**快照（`createBootstrap` 在
    // bundle 执行前从已加载的设置值里拷一份），而沙箱里唯一能在插件 bundle
    // 执行之前拿到它的位置就是**这里** —— 桥接层先于插件脚本加载，而 RPC 是异步的，
    // 等它回来时插件的顶层早就跑完了。
    //
    // 读的是与 `settings.all` 同一个函数（见 `rpc::setting_values`），因此
    // "哪些键算设置项"只有一处定义。
    let settings = plugin_manager(app)
        .and_then(|handle| {
            handle
                .try_read()
                .ok()
                .map(|manager| super::rpc::setting_values(&manager, &plugin.id))
        })
        .unwrap_or_default();

    let source = BRIDGE_JS
        .replace("'__PLUGIN_ID__'", &js_string(&plugin.id))
        .replace("'__PLUGIN_NAME__'", &js_string(&plugin.name))
        .replace("'__PLUGIN_VERSION__'", &js_string(&plugin.version))
        // **宿主**版本（不是插件版本）。in-process 的 `ctx.version` 与
        // `Modulith.version` 都是它，而插件用它做特性探测很常见 ——
        // 少了这一条，`Modulith.version` 在沙箱里是 `undefined`。
        .replace("'__PLUGIN_HOST_VERSION__'", &js_string(env!("CARGO_PKG_VERSION")))
        .replace("'__PLUGIN_SURFACE__'", &js_string(surface_id))
        .replace("'__PLUGIN_RUNTIME__'", &js_string(runtime_wire(&plugin.runtime)))
        .replace("__PLUGIN_PERMISSIONS__", &permissions)
        .replace("__PLUGIN_DATA_AVAILABLE__", if data_available { "true" } else { "false" })
        .replace("__PLUGIN_SURFACES__", &serde_json::Value::from(declared).to_string())
        .replace("'__PLUGIN_ACTIVATION__'", &js_string("open"))
        // 主题快照注入成**字面量**而不是让桥接层先 RPC 一次：插件在顶层同步
        // 就能读到自己的令牌（与身份、权限同一个理由）。
        //
        // 用 `serde_json::to_string` 并**不**包引号：它是一个 JSON 对象字面量，
        // 直接放进 JS 里就是对象字面量 —— 包成字符串再 parse 是多一次解析。
        .replace(
            "__PLUGIN_THEME__",
            &app.try_state::<super::theme::PluginTheme>()
                .map(|state| state.describe().to_string())
                .unwrap_or_else(|| "null".to_string()),
        )
        // 快捷键表同样注入成字面量：桥接层要**同步**判断某个组合该不该转发，
        // 而那个判断不能靠 IPC 往返 —— 那是每敲一个键一次。
        .replace(
            "__PLUGIN_SHORTCUTS__",
            &app.try_state::<super::shortcuts::PluginShortcuts>()
                .map(|state| state.describe().to_string())
                .unwrap_or_else(|| r#"{"entries":[]}"#.to_string()),
        )
        // 整份清单。`ctx.manifest` 要它，`Modulith.run()` 的引导快照也要它。
        //
        // 桥接层读不到清单文件（它在插件目录之外，而且读文件是异步的），因此
        // 只能是宿主把**已经解析好的那一份**送进来。送 `Value` 而不是重新拼一个
        // 对象：插件读 `manifest.contributes` 时应当看到作者写的原样。
        .replace("__PLUGIN_MANIFEST__", &plugin.manifest.to_string())
        // 设置项快照。同样必须在 bundle 执行前就绪。
        .replace(
            "__PLUGIN_SETTINGS__",
            &serde_json::Value::Object(settings).to_string(),
        );

    // 占位符没被替换掉 = 桥接层与这里的约定漂了。那时交给插件的会是一段
    // 字面量 `'__PLUGIN_ID__'`，症状是"插件的 id 变成了这个怪字符串" ——
    // 与其让它那样发生，不如在这里就说清楚。
    debug_assert!(
        !source.contains("__PLUGIN_ID__")
            && !source.contains("__PLUGIN_NAME__")
            && !source.contains("__PLUGIN_VERSION__")
            && !source.contains("__PLUGIN_HOST_VERSION__")
            && !source.contains("__PLUGIN_SURFACE__")
            && !source.contains("__PLUGIN_PERMISSIONS__")
            && !source.contains("__PLUGIN_DATA_AVAILABLE__")
            && !source.contains("__PLUGIN_SURFACES__")
            && !source.contains("__PLUGIN_RUNTIME__")
            && !source.contains("__PLUGIN_ACTIVATION__")
            && !source.contains("__PLUGIN_THEME__")
            && !source.contains("__PLUGIN_SHORTCUTS__")
            && !source.contains("__PLUGIN_MANIFEST__")
            && !source.contains("__PLUGIN_SETTINGS__"),
        "桥接脚本里的占位符没有被全部替换 —— sandbox-bridge.js 与 bridge_script 的约定漂了"
    );

    script(&source)
}

/// 运行位置在桥接层里的写法。
///
/// 沙箱文档**只可能**由 `Sandboxed` 的插件产生（`handle` 只服务沙箱界面），
/// 因此这一条实际上是常量。写成一个函数是为了让"插件读到的值来自清单"这件事
/// 有唯一一处实现 —— 直接写死 `'sandboxed'` 会在将来加第三种运行位置时
/// 变成一句谎话。
fn runtime_wire(runtime: &super::types::PluginRuntime) -> &'static str {
    match runtime {
        super::types::PluginRuntime::Sandboxed => "sandboxed",
        super::types::PluginRuntime::InProcess => "in-process",
    }
}

// ============================================================
// 宿主 → 插件界面：两跳，而且中间那一跳只能是前端
// ============================================================
//
// 从前这四条推送是 `Webview::eval` 一段脚本进插件 webview。iframe 没有这条路 ——
// 跨源拿不到它的文档对象，"推一段代码进去"在浏览器模型里就不存在。
//
// 能做的是 `postMessage`，而 `postMessage` 的**发送方必须是持有那个 iframe 的
// 文档** —— 也就是前端。于是 Rust 这一侧只发一条事件，前端按令牌找到 iframe
// 再转发（见 `src/services/sandboxSurface.ts` 与 `resources/sandbox-bridge.js`）。

/// 把一个令牌 + 一条消息交给前端。
///
/// 只发给**主窗口**：令牌与 iframe 的绑定在前端那一个文档里，别的窗口（托盘菜单、
/// 自检窗口）收到也做不了任何事。
///
/// 一条推不到（界面刚被卸掉）不该影响其余界面，因此调用方逐个发、这里逐个吞掉错误。
pub(super) fn push_to<R: Runtime>(
    app: &AppHandle<R>,
    token: &str,
    channel: &str,
    payload: serde_json::Value,
) {
    use tauri::Emitter;

    if let Err(error) = app.emit_to(
        crate::core::window::MAIN_WINDOW,
        PUSH_EVENT,
        serde_json::json!({ "token": token, "channel": channel, "payload": payload }),
    ) {
        log::debug!("向沙箱界面推 {channel} 失败：{error}");
    }
}

/// 把当前主题推给每一个还活着的沙箱界面。
///
/// ============================================================
/// 为什么是"换一段样式表"而不是"重新加载界面"
/// ============================================================
///
/// 重新加载插件界面会**丢掉它全部运行期状态** —— 用户正在填的表单、滚动位置、
/// 展开的树。用户只是切了一下浅色/深色，不该因此丢掉正在做的事。
///
/// 因此桥接层只替换 `<style id="modulith-theme">` 的**文本**。插件的 CSS 里
/// 那些 `var(--accent-500)` 会自动重新求值，因为变量是在 `:root` 上重新声明的。
///
/// **但它还要换一次根类名。** 这是两件不同的事，少做一半的症状很隐蔽：
/// `var(--x)` 靠变量重新声明就生效，而 `.dark` 那种类选择器靠**属性匹配** ——
/// 属性不变，规则就永远不匹配。实测 9 个插件里有 8 个用 `:root.dark …` 写深色，
/// 只换样式文本时它们全部静默失效（令牌是对的，深色规则一条不生效）。
///
/// 顺带调一次 `__modulithThemeChanged`，让订阅了 `ctx.theme.onChange` 的插件
/// 能在需要用 JS 拿颜色（canvas、SVG）时重新取一次。
pub fn apply_theme<R: Runtime>(app: &AppHandle<R>) {
    let Some(theme) = app.try_state::<super::theme::PluginTheme>() else {
        return;
    };
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return;
    };

    // **取一次快照，三条字段都从它算**，而不是各调一次 `theme.get()`。
    //
    // `get()` 返回的是一个 `Arc` 克隆，三次调用之间理论上可以插进一次 `set` ——
    // 那样推出去的 CSS 与类名会来自**两个不同的主题**，而表现是"改了主题之后
    // 颜色是新的、明暗类名还是旧的"，一种看起来完全随机的错位。
    let snapshot = theme.get();

    let payload = serde_json::json!({
        "css": snapshot.to_css(),
        "described": {
            "resolved": snapshot.resolved,
            "reduceMotion": snapshot.reduce_motion,
            "glass": snapshot.glass,
            "tokens": snapshot.tokens,
        },
        // 根类名与 CSS 一起推，**不能只推 CSS**。
        //
        // 只换 `<style>` 的文本能让 `var(--x)` 重新求值，但 `.dark` 那种
        // 类选择器是靠属性匹配的 —— 属性不变，规则就永远不生效。这里漏掉的
        // 表现是"改了主题，令牌都对了，插件的深色规则一条都没生效"。
        "rootClasses": snapshot.root_classes(),
    });

    for (token, _key) in surfaces.live() {
        push_to(app, &token, "theme", payload.clone());
    }
}

/// 把当前的快捷键表推给每一个还活着的沙箱界面。
///
/// 与主题推送同一条路子（换数据、不重载），但**驱动方不同**：主题由用户改设置
/// 触发，快捷键表由插件注册表变化触发（插件可以贡献快捷键，而那会让整张表变）。
pub fn apply_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    let Some(table) = app.try_state::<super::shortcuts::PluginShortcuts>() else {
        return;
    };
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return;
    };

    let payload = serde_json::json!({ "table": table.describe() });

    for (token, _key) in surfaces.live() {
        push_to(app, &token, "shortcuts", payload.clone());
    }
}

/// 把一个字符串变成合法的 JS 字符串字面量。
///
/// 用 `serde_json` 而不是手写转义：它已经处理了引号、反斜杠与控制字符，
/// 而手写的那份总会在某个不常见字符上出错 —— 而出错的方向是"注入"。
///
/// 现在只剩 `bridge_script` 用它（拼占位符的值）。推送那几条**不再**拼脚本 ——
/// 它们走 `postMessage`，数据直接过结构化克隆，没有"拼"这一步。这正好是那次
/// 迁移顺手消掉的一类风险：能注入的地方少了一处。
pub(super) fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

// ============================================================
// 资源服务
// ============================================================

/// 从插件目录读一个资源。
///
/// **路径约束是这里唯一重要的事。** 相对路径来自 URL，也就是来自插件自己，因此
/// 它可以写 `../../`、可以写绝对路径、可以写盘符。判据有两条，缺一不可：
///
///   1. 规范化**之后**必须仍在插件目录之下 —— `canonicalize` 会解开符号链接，
///      因此指向目录之外的软链也会被挡下；
///   2. 只读普通文件 —— 目录、设备、管道都不该由这条路径吐出去。
///
/// 不用"检查字符串里有没有 `..`"那种做法：它在 Windows 上会被 `\`、短名、UNC
/// 路径绕过，而这类判据的失效方式恰好是"看起来正常但读到了别的文件"。
fn serve_asset(plugin: &SandboxView, rel: &str) -> http::Response<Cow<'static, [u8]>> {
    let Some(decoded) = urlencoding::decode(rel).ok() else {
        return text(400, "资源路径无法解码");
    };

    let Some(path) = resolve_within(&plugin.root, &decoded) else {
        log::warn!(
            "[sandbox] 拒绝越界的资源请求：{} 请求 {rel}",
            plugin.id
        );
        return text(403, "资源路径越界");
    };

    match std::fs::read(&path) {
        Ok(bytes) => binary(content_type_of(&path), bytes),
        Err(e) => {
            log::debug!("[sandbox] 读不到资源 {}：{e}", path.display());
            text(404, "找不到这个资源")
        }
    }
}

/// 把一个相对路径解析到 `root` 之下；越界、非文件、读不到元数据一律返回 `None`。
fn resolve_within(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }

    let canonical_root = root.canonicalize().ok()?;
    let candidate = canonical_root.join(rel);
    let canonical = candidate.canonicalize().ok()?;

    if !canonical.starts_with(&canonical_root) {
        return None;
    }
    if !canonical.is_file() {
        return None;
    }

    Some(canonical)
}

/// 按扩展名给 Content-Type。
///
/// 只列插件界面真正会用到的那些。不认识的扩展名给 `application/octet-stream`
/// 而不是猜 —— 猜错的方向是"把一段文本当脚本执行"，代价远大于"下载了一个文件"。
fn content_type_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ============================================================
// 原始字节通道（插件数据目录）
// ============================================================
//
// 为什么单独一条通道：RPC 的消息体是 JSON，二进制进去必须 base64。对一个
// 几十 KB 的缩略图那无所谓，对文档/图库插件里几百 MB 的文件则是：体积 +33%、
// 一次完整字符串拷贝、一次解码，而且**全程驻留在 JS 堆里**。
//
// 这两条走 HTTP 的原始字节：请求体就是文件内容，响应体就是文件内容。
// 浏览器侧的 `fetch(...).then(r => r.arrayBuffer())` 直接拿到 `ArrayBuffer`。

/// 读一个数据文件，原样返回字节。
async fn serve_data<R: Runtime>(
    app: &AppHandle<R>,
    plugin: &SandboxView,
    rel: &str,
) -> http::Response<Cow<'static, [u8]>> {
    let manager = match plugin_manager(app) {
        None => return text(503, "插件系统尚未就绪"),
        Some(handle) => handle,
    };
    let guard = manager.read().await;

    match guard.data_read(&plugin.id, rel) {
        Ok(bytes) => {
            // Content-Type 按扩展名给。猜错的方向是"把内容当成别的东西解析"，
            // 因此不认识的一律 octet-stream（与资源服务同一条规则）。
            let content_type = content_type_of(Path::new(rel));
            binary(content_type, bytes)
        }
        Err(e) => {
            // 404 而不是 500：**不存在是最常见的一种结果**（插件问"这个文件在不在"），
            // 把它当成服务端错误会让调用方以为是宿主坏了。
            log::debug!("[sandbox] 读不到数据文件 {rel}：{e}");
            text(404, "找不到这个文件")
        }
    }
}

/// 写入一个数据文件，覆盖。请求体就是文件内容。
async fn store_data<R: Runtime>(
    app: &AppHandle<R>,
    plugin: &SandboxView,
    rel: &str,
    body: &[u8],
) -> http::Response<Cow<'static, [u8]>> {
    if rel.is_empty() {
        return text(400, "缺少文件路径");
    }

    let manager = match plugin_manager(app) {
        None => return text(503, "插件系统尚未就绪"),
        Some(handle) => handle,
    };
    let guard = manager.read().await;

    match guard.data_write(&plugin.id, rel, body) {
        // 响应体回写入了多少字节：这是唯一能让调用方确认"整份都到了"的信号。
        Ok(()) => json(&format!(r#"{{"ok":true,"bytes":{}}}"#, body.len())),
        Err(e) => {
            log::warn!("[sandbox] 写数据文件 {rel} 失败：{e}");
            text(400, &e.to_string())
        }
    }
}

// ============================================================
// RPC
// ============================================================
//
// 插件调 `ctx.*` 就是往这里发一条请求。**传输与语义是分开的**：
//
//   · 这一层只做**传输** —— 把 HTTP 请求体交给 `super::rpc`，再把它的结果
//     包回一个 JSON 响应；
//   · **语义**（这个方法该做什么、权限谁判、配额怎么算）在 `super::rpc` 里，
//     与 Node 后台插件那条路径**共用同一份实现**。
//
// 拆开而不是各写一份的理由见 `rpc.rs` 的文件头：同一个 `ctx` 有两个调用方，
// 而两套实现一定会漂 —— 漂开的方向是"某个成员在一种运行位置下能用、
// 在另一种下静默不生效"，那是最难被发现的一类缺陷。

/// 插件系统状态里的管理器。没有它说明插件模块还没起来。
fn plugin_manager<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<std::sync::Arc<tokio::sync::RwLock<super::manager::PluginManager>>> {
    app.try_state::<super::PluginState>().map(|s| s.0.clone())
}

async fn dispatch_rpc<R: Runtime>(
    app: &AppHandle<R>,
    key: &SurfaceKey,
    method: &str,
    body: &[u8],
) -> http::Response<Cow<'static, [u8]>> {
    let args: serde_json::Value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice(body) {
            Ok(value) => value,
            Err(e) => return rpc_error(&format!("参数不是合法 JSON：{e}")),
        }
    };

    // 语义在 `super::rpc` 里，这里只做**传输**上的翻译（HTTP ↔ Result）。
    // 沙箱与 Node 后台两条路径共用同一份 ctx 实现 —— 见 rpc.rs 的文件头。
    //
    // 界面身份**只在沙箱这条路径上存在**，因此它作为第三个参数传进去，
    // 而 Node 那条路径传 `None`。理由见 `SurfaceKey`。
    match super::rpc::dispatch(app, &key.plugin_id, Some(&key.surface), method, &args).await {
        Ok(value) => json_value(&serde_json::json!({ "ok": true, "value": value })),
        Err(message) => rpc_error(&message),
    }
}

/// 插件设置的存储键前缀。**必须与 `pluginContributions.ts::settingStorageKey` 一致。**
///
/// 两处不一致的表现是：用户在设置界面改了值，插件读到的还是旧值（或反过来），

// ============================================================
// 响应构造
// ============================================================

fn plain(
    status: u16,
    content_type: &str,
    body: impl Into<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, content_type)
        // 不要让引擎去猜类型：按扩展名给出的类型就是定论，
        // 猜出来的类型会让一段文本被当成脚本执行。
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(body.into()))
        .unwrap_or_else(|_| http::Response::new(Cow::Borrowed(&b"internal error"[..])))
}

fn text(status: u16, message: &str) -> http::Response<Cow<'static, [u8]>> {
    plain(status, "text/plain; charset=utf-8", message.as_bytes().to_vec())
}

fn json(body: &str) -> http::Response<Cow<'static, [u8]>> {
    plain(200, "application/json; charset=utf-8", body.as_bytes().to_vec())
}

fn json_value(value: &serde_json::Value) -> http::Response<Cow<'static, [u8]>> {
    json(&value.to_string())
}

fn script(body: &str) -> http::Response<Cow<'static, [u8]>> {
    plain(200, "text/javascript; charset=utf-8", body.as_bytes().to_vec())
}

fn binary(content_type: &str, bytes: Vec<u8>) -> http::Response<Cow<'static, [u8]>> {
    plain(200, content_type, bytes)
}

/// RPC 失败。**HTTP 状态仍是 200**：这条通道承载的是应用层的成败，而不是 HTTP 的。
/// 用 4xx/5xx 会让桥接层不得不去分辨"网络没通"与"插件被拒绝"，而那是两件事。
fn rpc_error(message: &str) -> http::Response<Cow<'static, [u8]>> {
    json_value(&serde_json::json!({ "ok": false, "error": message }))
}

/// 最小的属性/文本转义。
///
/// 清单里的 `name` / `main` / `style` 都来自插件作者，而它们要被拼进宿主的 HTML。
/// 不转义的话，一个叫 `"><script>…` 的插件名就能往宿主合成的文档里塞脚本 ——
/// 而那份文档的 CSP 是 `'self'`，内联脚本会被挡下，但"挡下了"不等于"没注入"。
fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// 属性值转义：比文本转义更严，因为它落在引号里。
fn escape_attr(input: &str) -> String {
    escape_html(input)
}

// ============================================================
// 自检
// ============================================================
//
// 沙箱这件事**不能只靠"代码写完了"**。四件事必须在一个真实的 webview 里各跑一次：
//
//   1. `__TAURI_INTERNALS__` **存在** —— 否则下面那条"被拒绝"没有意义，
//      可能只是入口都没注入；
//   2. 调一条应用命令**被拒绝**，且拒绝理由是 ACL —— 这是边界真的生效的正面证据；
//   3. 走自定义协议发一条 RPC **成功** —— 证明通道可用，且宿主知道是谁发的；
//   4. CSP **生效** —— 证明网络与资源边界是引擎在执行。
//
// **第 2 条与第 4 条各写错过一次，两次都是"判据"错而不是沙箱错**：
//
//   * 第 2 条最初只认 release 的 `not allowed by ACL`，而 debug 构建给的是
//     `not allowed on window "…", webview "…" … referenced by: capability: …`
//     —— 一次完全正确的拒绝被判成失败。现在两种都认。
//   * 第 4 条最初测"fetch example.com 是否被挡下"，而断网时它同样被挡下。
//     现在改用 `data:` 探针，它在没有 CSP 时**必定成功**。
//
// 增量 B 又加了两项，验证"真插件走这条链路"：
//
//   5. 插件资源能从目录里读出来（`asset/plugin.js` 真的加载并执行了）；
//   6. `ctx.storage` 真的能读写 —— 走的是 `PluginManager` 那条既有路径，
//      因此权限与配额都还在。

/// 把自检页投回来的结果写进日志。
///
/// 解析失败**不报错、照原样记录**：这一段的价值在于把结果留在日志里，
/// 一次解析失败不该让它连记录都留不下。
fn log_selftest_report(body: &str) {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(value) => {
            let check = value.get("check").and_then(|v| v.as_str()).unwrap_or("?");
            let ok = value.get("ok").and_then(|v| v.as_bool());
            let detail = value.get("detail").and_then(|v| v.as_str()).unwrap_or("");

            match ok {
                Some(true) => log::info!("[sandbox自检] 通过  {check}：{detail}"),
                Some(false) => log::warn!("[sandbox自检] 失败  {check}：{detail}"),
                None => log::info!("[sandbox自检] 记录  {check}：{detail}"),
            }
        }
        Err(e) => log::warn!("[sandbox自检] 报告无法解析（{e}）：{body}"),
    }
}


/// 打开沙箱自检窗口。**由人显式触发，不再随应用启动自动运行。**
///
/// ============================================================
/// 为什么不再自动跑
/// ============================================================
//
// 它原先在 setup 阶段起一个 4 秒后的异步任务，无条件弹出一块 560×420 的面板。
// 那样做的理由是"给自检一个不需要人配合的触发点"，但代价是**每一次启动**都多出
// 一块挡在界面上的面板，去验一件绝大多数时候都成立的事。用户的原话是"它很打扰"。
//
// ============================================================
// 为什么**保留**这个能力，而不是删掉
// ============================================================
//
// 它验的是**边界本身**：插件文档里真的没有 IPC、自定义协议通道真的可用、CSP 真的
// 由引擎执行。这几件事没有别的触发点 —— 自检页是仓库里唯一会去**故意违规**的地方。
//
// 删掉它，这条边界就再也没有任何东西会去验一次了。所以改的是**什么时候跑**，
// 不是**跑不跑**：现在由「插件」页上的一个按钮触发。
//
// ============================================================
// 它为什么仍然是一个**独立窗口**，而不是一块 iframe
// ============================================================
//
// "插件文档里有没有 `__TAURI_INTERNALS__`"这个问题，只有在**一个真的 webview**
// 里才问得出来 —— iframe 里那两个全局本来就按设计不存在，在那里问等于自问自答。
// 因此自检页仍然开一个独立窗口（它同样零 capability），而真插件界面走 iframe。
//
// 窗口不重复开：已经开着就把它提到前面，而不是再建一个。
pub fn open_selftest<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return Err("沙箱界面表尚未就绪".to_string());
    };

    // 令牌先签发。窗口建失败时它会留在表里 —— 而一个指向不存在窗口的令牌读不到
    // 任何东西（那份文档只能从那个窗口里发出请求），因此留着不是一条安全口子，
    // 它还会在下一次打开时被 `issue` 复用。
    let key = SurfaceKey::new(SELFTEST_ID, super::surfaces::PRIMARY_SURFACE);
    let token = surfaces.issue(key);
    let url = tauri::Url::parse(&format!("{ORIGIN}/{token}/"))
        .map_err(|e| format!("自检页地址不合法：{e}"))?;

    if let Some(existing) = crate::core::window::get(app, SELFTEST_LABEL) {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(app, SELFTEST_LABEL, tauri::WebviewUrl::External(url))
        .title("Modulith Desktop 沙箱自检")
        .inner_size(620.0, 560.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("打开自检窗口失败：{e}"))?;

    // 用户用窗口右上角的 X 关掉它时，令牌要跟着消失。
    //
    // 这条**必须**挂在窗口事件上，不能只靠页面里那个"关闭"按钮：X 是用户随时会按
    // 的东西，而一个已经关掉的窗口留下的令牌仍然读得到宿主那份文档。
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            forget_selftest(&handle);
        }
    });

    Ok(())
}

/// 决定一块界面能不能收文件拖放的权限。
///
/// 现在只有一处用它，但**它必须是一个有名字的常量**：这个字符串在清单、权限表、
/// 前端 `ctx.fileDrop` 与文档里各出现一次，写成字面量就有了四处会漂的地方，
/// 而漂开的那一处不会报错 —— 只会让某个插件"拖进去没反应"。
pub const FILE_DROP_PERMISSION: &str = "filesystem-read";

/// 签发出去的一块界面：前端拿它去渲染 iframe。
///
/// `url` 由宿主拼好、而不是让前端自己拼：地址的形状（来源、路径分段、结尾那个
/// 斜杠）是协议处理器定的，前端再实现一遍必然漂 —— 而漂开的表现是"所有资源 404"。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceHandle {
    pub token: String,
    pub url: String,
    /// 这块界面能不能收到文件拖放。
    ///
    /// **为什么由宿主给，而不是前端自己查权限**：拖放带来的是**本机路径**，与
    /// `filesystem-read` 属于同一类信息。前端要自己判断就得再拿一份清单、再实现
    /// 一遍"哪个权限管哪个能力"—— 而那正是这套设计反复强调不算边界的东西。
    /// 宿主在读 `sandbox_view` 时顺手把结论算出来，前端只负责按位置转交。
    ///
    /// 它为假时前端**一条拖放都不转**，因此插件那边 `fileDrop.isAvailable()`
    /// 为假时是真的收不到东西，而不是"收得到但要自己忽略"。
    pub file_drop: bool,
}

/// 给一个**已安装**的插件签发一块沙箱界面。这是真插件界面唯一的入口。
///
/// ============================================================
/// 为什么这里**不**建任何东西
/// ============================================================
//
// 从前这条路径要建一个真的子 webview，因此必须绕开主线程 —— 那是一次整机假死，
// 完整推导留在 git 历史里 `surface.rs` 的文件头（那个文件已经删掉）。现在它只做
// 两件事：核实插件与界面存在，然后签发一个令牌。两件都是纯内存操作，
// **没有一条会碰到窗口系统**，因此"创建 webview 不能从主线程做"在这里不再适用。
//
// 它仍然是 `async` 的，因为要读 `PluginManager`（在一把 tokio 锁后面）。
///
/// `surface` 是**要开哪一个界面**（清单里声明的 id）。
///
/// 传一个清单里没有的界面 id 会在这里被拒（`view.surface()` 返回 `None`），
/// 而不是签出一个服务 404 的令牌 —— 后者在前端看起来是"插件界面一直白着"。
///
/// **幂等**：同一个界面重复调用拿到同一个令牌（见 `SandboxSurfaces::issue`）。
/// 前端会重复调用它（React 重复渲染、宿主布局变化后的重挂载），因此这一条是
/// 必需的，不是优化。
pub async fn open_surface<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: &str,
) -> Result<SurfaceHandle, String> {
    let view = {
        let Some(state) = app.try_state::<super::PluginState>() else {
            return Err("插件系统尚未就绪".to_string());
        };
        // `.await` 而不是 `block_on`：后者会把调用线程钉在这里，而调用线程不该
        // 被钉住 —— 它可能是主线程。锁在读完之后立刻放掉，不跨到下面去。
        let manager = state.0.read().await;
        manager.sandbox_view(plugin_id).map_err(|e| e.to_string())?
    };

    if !view.runtime.needs_own_webview() {
        return Err(format!(
            "{} 的清单写的是 runtime={}，不该给它建独立界面",
            view.id,
            view.runtime.as_str()
        ));
    }

    if view.surface(surface).is_none() {
        return Err(format!(
            "{} 的清单里没有界面 {surface}（它声明的是：{}）",
            view.id,
            view.surfaces.ids().join("、")
        ));
    }

    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return Err("沙箱界面表尚未就绪".to_string());
    };

    let token = surfaces.issue(SurfaceKey::new(view.id, surface));

    Ok(SurfaceHandle {
        url: format!("{ORIGIN}/{token}/"),
        token,
        file_drop: view.permissions.iter().any(|p| p == FILE_DROP_PERMISSION),
    })
}

/// 关掉一块界面，收回它的令牌。**没开着时静默成功** ——
/// 前端在卸载时无条件调用它，把"本来就没开"当成错误只会在日志里堆噪声。
///
/// 这里**只做"忘记"**。iframe 的销毁是前端的事：它才是那个 iframe 的宿主，
/// 宿主这一侧没有 DOM 可以拆。前端不拆而只调用这一条的话，绑定就断了 ——
/// 令牌被收回，那个 iframe 之后的每一条请求都会是 403。
pub fn close_surface<R: Runtime>(app: &AppHandle<R>, token: &str) {
    if let Some(surfaces) = app.try_state::<SandboxSurfaces>() {
        surfaces.forget(token);
    }
}

/// 关掉一个插件的**全部**界面：收回令牌，并让前端把那些 iframe 卸掉。
///
/// 插件被停用/卸载时走这条。少了它，一个被停用的插件留在屏幕上的那些 iframe 会
/// 继续活着 —— 而它们属于一个"已经不存在"的插件，下一次协议请求会被 404 拒掉，
/// 用户看到的是一块再也刷不出来的空白。
pub fn close_all_surfaces<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) {
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return;
    };

    for token in surfaces.forget_plugin(plugin_id) {
        // 通知前端把这块界面卸掉。前端是 iframe 的宿主，只有它能拆 DOM。
        //
        // 推不到不算错：前端可能正好在重挂载，而它重挂载时会重新问一遍"这个插件
        // 还在不在" —— 那时清单已经不认它了。
        push_to(app, &token, "close", serde_json::Value::Null);
    }
}

/// 某个插件当前开着的界面 id（去重排序）。
///
/// 给 `ctx.ui.listSurfaces()` 用。**这是"开着"的唯一真源** —— 见
/// `SandboxSurfaces::surfaces_of`。
pub fn live_surfaces<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) -> Vec<String> {
    app.try_state::<SandboxSurfaces>()
        .map(|surfaces| surfaces.surfaces_of(plugin_id))
        .unwrap_or_default()
}

/// 把一条**下载进度**推给插件的界面。
///
/// 与 `deliver_command` 同一条通道（`push_to`），但多一个 `rel`：一个插件可以同时
/// 下好几个文件，而进度条要能分辨是哪一个。
///
/// `only` 给了一个界面名时只推那一块 —— 下载是**某一块界面**发起的，进度条也画在
/// 它那里。别的界面没必要收到一条它没法处理的进度。
///
/// 回调由桥接层持有（`Modulith.http.download(url, rel, onProgress)` 里的那个
/// 函数），宿主只负责把数字送到。
pub async fn deliver_download_progress<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    rel: &str,
    received: u64,
    total: Option<u64>,
    only: Option<&str>,
) {
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return;
    };

    let payload = serde_json::json!({
        "rel": rel,
        "received": received,
        "total": total,
    });

    for (token, key) in surfaces.live() {
        if key.plugin_id != plugin_id {
            continue;
        }
        if let Some(only) = only {
            if key.surface != only {
                continue;
            }
        }

        push_to(app, &token, "download-progress", payload.clone());
    }

    // 界面这一侧推完，还要给**前端**留一条：in-process 插件的下载进度没有别的
    // 办法回到它的回调里（它与宿主在同一个 realm，但那条通道是"宿主推脚本进
    // 插件 webview"）。前端据此把数字交给它注册的处理函数。
    //
    // 两条都用，而不是二选一：一个插件可能同时被 in-process 与沙箱两种形态加载
    // （取决于清单），而宿主在推的时候并不知道该走哪一条 —— 也不知道这次下载
    // 是哪一个形态发起的。多推一条的代价是一条本地事件。
    use tauri::Emitter;
    if let Err(error) = app.emit(
        super::rpc::DOWNLOAD_PROGRESS,
        serde_json::json!({
            "pluginId": plugin_id,
            "rel": rel,
            "received": received,
            "total": total,
        }),
    ) {
        log::debug!("广播下载进度失败：{error}");
    }
}

/// 把一条**命令**送进插件的界面。
///
/// ============================================================
/// 这是跨 realm 的唯一办法，不是绕路
/// ============================================================
///
/// 沙箱插件的代码在它自己的文档里，宿主**拿不到它的任何函数** —— 函数的引用过
/// 一次 realm 边界就消失了。因此"执行插件的某条命令"在这里只能是"告诉它有人点了
/// 这条命令"，由它自己决定做什么。
///
/// 桥接层据此挂了 `Modulith.commands.on(id, handler)`；没有注册处理器的命令会被
/// 静默忽略。这与 in-process 插件不同（那边缺处理器会在命令面板里报错），
/// 而差别是刻意的：沙箱插件的命令**可以**在它还没加载完时就被点，那时没有处理器
/// 是正常状态，不是缺陷。
///
/// ============================================================
/// 推给哪几块界面
/// ============================================================
///
/// 默认推给这个插件**全部活着的界面**：命令是插件级的（清单里 `commands[].id`
/// 不带界面），在哪块界面里响应由插件自己决定。
///
/// `only` 给了一个界面名时只推那一块 —— 用在"这次调用是从哪块界面发起的"有意义
/// 的地方（目前是 `ui.contextMenu`：右键菜单出现在某一块界面上，用户点的那一条
/// 理应回到那块界面）。
pub async fn deliver_command<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    command: &str,
    only: Option<&str>,
) {
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return;
    };

    // 命令名来自清单，而清单是外部输入 —— 包成 JSON 再送，而不是拼进源码。
    // 拼源码那条路在 `eval` 时代是必需的（也因此必须做转义）；现在数据直接过
    // `postMessage`，没有"拼"这一步，也就没有可拼坏的东西。
    let payload = serde_json::json!({ "command": command });

    for (token, key) in surfaces.live() {
        if key.plugin_id != plugin_id {
            continue;
        }
        if let Some(only) = only {
            if key.surface != only {
                continue;
            }
        }

        push_to(app, &token, "command", payload.clone());
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::plugins::surfaces::PRIMARY_SURFACE;

    /// 入口文档在深色主题下必须把 `class="dark"` 挂到 `<html>` 上。
    ///
    /// ============================================================
    /// 这是那个真实故障的回归测试
    /// ============================================================
    ///
    /// 插件的 CSS 与宿主一样用 `:root.dark .foo` 写深色规则（实测 9 个插件里
    /// 8 个这样写），而宿主挂在自己 `documentElement` 上的 `.dark` **不会继承到
    /// 插件文档**。令牌注入得再对，这些规则也一条都不匹配。
    ///
    /// 这一条之所以要在 Rust 里测（而不是只写一条文本门禁）：故障的形态是
    /// **模板里有占位符、拼出来却是空的**，只有真的把字符串拼出来才看得见。
    #[test]
    fn the_entry_document_carries_the_dark_class_when_the_theme_is_dark() {
        let mut theme = crate::modules::plugins::theme::ThemeSnapshot::default();
        theme.resolved = "dark".to_string();

        let html = entry_document_html(
            "笔记",
            None,
            &theme.to_css(),
            &theme.root_class_attr(),
            "index.js",
            &"a".repeat(32),
        );

        assert!(
            html.contains(r#"<html lang="zh-CN" class="dark">"#),
            "深色主题下入口文档的 <html> 上没有 .dark —— 插件的深色规则会全部失效"
        );
        // 令牌块与类名**在同一个文档里**：只给其中一个都是半成品。
        assert!(html.contains("color-scheme: dark;"));
        assert!(html.contains(r#"id="modulith-theme""#));
    }

    /// 没有任何类名可说时，文档里不该留下 `class` 属性。
    ///
    /// **必须走快照，而不是直接塞一个空串进来。** 直接塞空串只测到"渲染器怎么
    /// 处理空串"，测不到"快照真的会给出空串" —— 而变异打回的恰好是后者：
    /// 去掉 `root_class_attr` 里那个空判据之后，渲染出来的是
    /// `<html lang="zh-CN" class="">`，一个空的 `class` 属性。
    ///
    /// 它与"没有这个属性"在 CSS 上等价，但在**对账**时不等价：将来有人检查
    /// "类名对不对"时，一个空属性会让判据看起来通过了。
    #[test]
    fn the_entry_document_omits_the_class_attribute_when_there_is_nothing_to_say() {
        // 浅色 + 不减少动效 + 毛玻璃开着 —— 三个类名一个都不成立。
        let mut theme = crate::modules::plugins::theme::ThemeSnapshot::default();
        theme.resolved = "light".to_string();

        let html = entry_document_html(
            "笔记",
            None,
            &theme.to_css(),
            &theme.root_class_attr(),
            "index.js",
            &"a".repeat(32),
        );

        assert!(
            theme.root_classes().is_empty(),
            "这个快照本就不该有类名；前提不成立的话下面两条断言没有意义"
        );
        assert!(html.contains(r#"<html lang="zh-CN">"#));
        assert!(
            !html.contains(" class="),
            "没有类名时不该留下 class 属性 —— 空的 class 属性会让对账看起来通过了"
        );
    }

    /// 浅色主题下**不能**有 `.dark` —— 否则深色规则会在亮色主题里生效。
    #[test]
    fn a_light_theme_leaves_no_dark_class_behind() {
        let mut theme = crate::modules::plugins::theme::ThemeSnapshot::default();
        theme.resolved = "light".to_string();

        let html = entry_document_html(
            "笔记",
            None,
            &theme.to_css(),
            &theme.root_class_attr(),
            "index.js",
            &"a".repeat(32),
        );

        assert!(!html.contains("class=\"dark"));
        assert!(html.contains("color-scheme: light;"));
    }

    /// 抽成纯函数之后，转义仍然在**函数内部**。
    ///
    /// 把转义挪到调用方会让"某个调用点忘了转义"变成一种可能，而那个缺陷的方向
    /// 是注入。这条测试是抽取重构的护栏：它保证这次拆分没有顺手丢掉转义。
    #[test]
    fn the_entry_document_still_escapes_its_inputs() {
        let html = entry_document_html(
            "<script>alert(1)</script>",
            Some("a\".js"),
            "",
            "",
            "x\" onload=\"alert(1)",
            &"a".repeat(32),
        );

        assert!(
            !html.contains("<script>alert(1)</script>"),
            "插件名里的标签被原样写进了文档"
        );
        assert!(
            !html.contains(r#"onload="alert(1)""#),
            "入口路径里的引号没被转义 —— 那是一个属性注入"
        );
        assert!(html.contains("&quot;"), "转义后的引号应当以实体形式出现");
    }

    /// 令牌的形状判据。它挡的是"路径第一段是一段任意字符串"这件事。
    ///
    /// 判形状不是为了安全（不合法的一样查不到身份），而是为了**代价**：这条路径的
    /// 第一段完全来自外部，不判的话每个请求都会拿一段任意长的字符串去哈希一次。
    #[test]
    fn a_token_must_be_32_hex_characters() {
        assert!(is_token(&new_token()));
        assert!(!is_token(""));
        assert!(!is_token("plugin-p"));
        assert!(!is_token(&"a".repeat(31)));
        assert!(!is_token(&"a".repeat(33)));
        // 大写十六进制也接受：`simple()` 出的是小写，但形状判据不该因为大小写
        // 把一个合法令牌拦下来。
        assert!(is_token(&"A".repeat(32)));
        assert!(!is_token(&"g".repeat(32)));
    }

    /// 令牌不可猜，也不是从插件 id 推出来的。
    ///
    /// 这一条是**安全**性质的，不是风格：从前身份是 webview 标签
    /// （`plugin-<净化后的 id>`），那个名字任何人都算得出来；而现在是拿到令牌的
    /// 那一块界面才读得到这个插件的数据。可算出来的令牌等于没有令牌。
    #[test]
    fn tokens_are_random_and_unrelated_to_the_plugin_id() {
        let table = SandboxSurfaces::default();
        let token = table.issue(SurfaceKey::new("com.example.notes", PRIMARY_SURFACE));

        assert!(is_token(&token));
        assert!(!token.contains("notes"), "令牌里不该看得出插件 id");
        assert_ne!(token, new_token());

        let other =
            SandboxSurfaces::default().issue(SurfaceKey::new("com.example.notes", PRIMARY_SURFACE));
        assert_ne!(token, other, "同一个界面在两个进程里也不该撞上同一个令牌");
    }

    /// 同一个界面永远只有一个令牌。
    ///
    /// 前端会重复调用 `open`（React 重复渲染、宿主布局变化后的重挂载）。每次签发
    /// 新令牌的话，旧令牌会留在表里，而它对应的 iframe 早已不存在 —— 那是一条
    /// **没人再看得见、却仍然能读这个插件数据**的凭据。
    #[test]
    fn issuing_the_same_surface_twice_returns_the_same_token() {
        let table = SandboxSurfaces::default();
        let key = SurfaceKey::new("p", "detail");

        let first = table.issue(key.clone());
        let second = table.issue(key);

        assert_eq!(first, second);
        assert_eq!(table.live().len(), 1, "重复签发不该在表里留下第二条");
    }

    /// 同一个插件的两个界面各自占一条，互不冲突；同一个界面名给不同插件也是两条。
    #[test]
    fn the_registry_keeps_two_surfaces_of_one_plugin_apart() {
        let table = SandboxSurfaces::default();

        let main = table.issue(SurfaceKey::new("p", "main"));
        let detail = table.issue(SurfaceKey::new("p", "detail"));
        assert_ne!(main, detail);

        assert_eq!(table.key_of(&main).unwrap().surface, "main");
        assert_eq!(table.key_of(&detail).unwrap().surface, "detail");

        let other = table.issue(SurfaceKey::new("q", "main"));
        assert_ne!(other, main);
        assert_eq!(table.key_of(&other).unwrap().plugin_id, "q");
    }

    /// 未签发的令牌查不到身份 —— 这正是"拒绝一个伪造来源"的判据。
    ///
    /// 旧方案里这一步是"路径里声称的插件 id 与 webview 所属插件是否相符"；现在
    /// URL 里根本没有插件 id，伪造来源能做的只有猜令牌。
    #[test]
    fn an_unissued_token_has_no_identity() {
        let table = SandboxSurfaces::default();
        table.issue(SurfaceKey::new("p", "main"));

        assert!(table.key_of("00000000000000000000000000000000").is_none());
        assert!(table.key_of("").is_none());
        assert!(table.key_of("plugin-p").is_none());
    }

    /// `forget` 之后令牌立即失效 —— 这正是"关掉界面"的路径。
    ///
    /// **两张表都要清干净**：只清一张的话，那个令牌仍然查得到身份，于是一个已经
    /// 关掉的界面还能继续读写这个插件的数据。
    #[test]
    fn forgetting_a_token_revokes_it_and_lets_the_surface_be_issued_again() {
        let table = SandboxSurfaces::default();
        let key = SurfaceKey::new("p", "detail");
        let token = table.issue(key.clone());

        table.forget(&token);
        assert!(table.key_of(&token).is_none());
        assert!(table.live().is_empty());

        let again = table.issue(key);
        assert_ne!(again, token, "撤销之后应当签发一个新的，而不是把旧的还回来");
        assert!(table.key_of(&again).is_some());
    }

    /// `forget_plugin` 撤销一个插件的全部令牌，且不动别人的。
    #[test]
    fn forgetting_a_plugin_revokes_every_surface_of_it() {
        let table = SandboxSurfaces::default();
        let p_main = table.issue(SurfaceKey::new("p", "main"));
        let p_detail = table.issue(SurfaceKey::new("p", "detail"));
        let q_main = table.issue(SurfaceKey::new("q", "main"));

        let revoked = table.forget_plugin("p");
        assert_eq!(revoked.len(), 2);
        assert!(table.key_of(&p_main).is_none());
        assert!(table.key_of(&p_detail).is_none());
        assert!(table.key_of(&q_main).is_some(), "别的插件不该被牵连");
    }

    /// `live()` 与 `surfaces_of()` 是"哪些界面开着"的真源。
    #[test]
    fn live_and_surfaces_of_agree_with_what_was_issued() {
        let table = SandboxSurfaces::default();
        table.issue(SurfaceKey::new("p", "main"));
        table.issue(SurfaceKey::new("p", "detail"));
        table.issue(SurfaceKey::new("q", "main"));

        assert_eq!(table.live().len(), 3);
        assert_eq!(table.surfaces_of("p"), vec!["detail".to_string(), "main".to_string()]);
        assert_eq!(table.surfaces_of("q"), vec!["main".to_string()]);
        assert!(table.surfaces_of("nope").is_empty());
    }

    /// `forget` 不存在的令牌是静默的 —— 关一个没开着的界面是正常路径。
    #[test]
    fn forgetting_something_that_was_never_issued_is_not_an_error() {
        let table = SandboxSurfaces::default();
        table.forget("00000000000000000000000000000000");
        assert!(table.live().is_empty());
    }

    /// `SurfaceKey` 仍然是"哪个插件的哪个界面"这一件事的载体，而**不再是**一个
    /// 能推出 webview 名字的东西 —— 标签随 `surface.rs` 一起没了。
    #[test]
    fn a_surface_key_knows_whether_it_is_the_primary_one() {
        let primary = SurfaceKey::new("p", PRIMARY_SURFACE);
        let detail = SurfaceKey::new("p", "detail");

        assert!(primary.is_primary());
        assert!(!detail.is_primary());
        assert_ne!(primary, detail);
    }
}
