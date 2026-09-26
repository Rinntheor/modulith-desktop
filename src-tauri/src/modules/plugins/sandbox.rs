// src-tauri/src/modules/plugins/sandbox.rs
//
// 插件沙箱：宿主与插件界面之间的那条线。
//
// ============================================================
// 它解决的是什么
// ============================================================
//
// v1.5 如实写下了当时唯一的结论：插件与宿主共享同一个 JS realm，因此宿主**无法
// 区分"谁在调用"** —— 权限列表只是一份自述（见 docs/02-开发指南/插件开发/
// 插件系统架构.md 第 6 节）。
//
// 这个模块把插件界面挪进**它自己的 webview**，并把两边之间的一切收进一条由宿主
// 完全掌控的通道。三件事因此同时成立：
//
//   1. **独立 realm。** 插件读不到宿主的 React 状态、内存里的凭据、模块作用域，
//      也拖不动宿主的主线程（它有自己的渲染进程）。
//   2. **没有 IPC。** 插件 webview 的标签**不匹配任何 capability** —— 由
//      `pnpm check:acl` 断言这一点 —— 于是 Tauri 在 IPC 入口拒绝它的每一次
//      invoke，包括全部 120 条应用命令。这一步的前提是 `build.rs` 里那份应用级
//      ACL 清单：没有它，本机来源的 webview 调这些命令根本不过检查。
//      见 docs/04-安全/应用命令的访问控制.md。
//   3. **身份不可伪造。** 插件与宿主之间的通信走自定义协议，而协议处理器能拿到
//      **发起请求的那个 webview 的标签**（`UriSchemeContext::webview_label()`）。
//      身份因此来自浏览器引擎，而不是插件自己报的 id。
//
// ============================================================
// 为什么走自定义协议，而不是 Tauri 的事件通道
// ============================================================
//
// 事件通道（`emit` / `listen`）能用，但它要求给插件 webview 一条 `core:event:*`
// 权限 —— 那会让插件能监听与伪造**任意**事件名，包括宿主内部那些。
//
// 自定义协议不同：它**完全不受 capability 管辖**（capability 只管 IPC），因此
// 插件 webview 可以一条权限都不给。代价是我们必须自己做认证，而
// `webview_label()` 恰好提供了它。
//
// ============================================================
// 网络第一次成为真的边界（但**不是**主屏障）
// ============================================================
//
// 插件文档由**我们**生成并附上 CSP。因为文档跑在自己的来源上，而宿主掌控着那份
// CSP，`connect-src` 得以只留插件自己的来源：插件无法直接 `fetch('https://…')`。
//
// ⚠️ **但 CSP 挡不住 Tauri IPC。** 实测发现 Tauri 的 IPC 有两条传输
// （`tauri/scripts/ipc-protocol.js`）：`fetch('http://ipc.localhost/<命令>')` 受
// `connect-src` 管辖，而它失败之后会回退到 `window.ipc.postMessage` —— 一条原生桥，
// 不受 CSP 管辖。**真正承重的是 ACL。** 因此 `check:acl` 里对
// "build.rs 必须声明 AppManifest::commands" 有一条会真的失败的断言。
//
// ============================================================
// 标签不是身份，注册表才是
// ============================================================
//
// 插件 id 允许含 `.` `_` `-`（见 `validator.rs`），而 webview 标签的字符集更窄，
// 且把 id 直接拼进标签会在 `a.b` 与 `a-b` 之间产生歧义。因此：
//
//   * 标签只是**去重用的名字**（`plugin-<净化后的 id>`），由 `label_for` 产出；
//   * 真正的身份是 `SandboxSurfaces` 里那条 `标签 → 插件 id` 的记录；
//   * 注册时检测标签冲突并拒绝 —— 冲突意味着两个插件抢同一个 webview 名字，
//     那必须是一个显式错误，而不是让其中一个静默失效。
//
// 路径的第一段仍然要与注册表给出的插件 id 相符。插件控制得了自己发的 URL，
// 控制不了自己被挂在哪个 webview 上 —— 于是 `plugin-A` 里发出的 `/B/...` 请求
// 既读不到 B 的数据，也借不到 B 的权限。
//
// ============================================================
// 不是 OS 级沙箱
// ============================================================
//
// 插件仍在同一个操作系统进程树里、同一个用户下。它挡住的是"插件在应用内的权限"，
// 不是"插件对这台机器的权限" —— 后者要靠 job object / AppContainer 一类手段。
// 任何把它读成"装了插件就安全"的说法都是错的。

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use tauri::{http, AppHandle, Manager, Runtime};

use super::manager::SandboxView;
use super::surface::SurfaceBounds;

/// 承载插件界面的自定义协议名。
///
/// 不能与 Tauri 自己注册的取同名（`tauri`、`ipc`、`asset`），否则会把它们顶掉。
pub const SCHEME: &str = "modulith-plugin";

/// 插件 webview 标签的前缀。**这是安全边界的一部分**：`capabilities/` 里没有任何
/// 文件把 `plugin-*` 纳入作用域，因此带这个前缀的 webview 一条 IPC 权限都没有。
pub const LABEL_PREFIX: &str = "plugin-";

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
/// 这是"标签不是身份，注册表才是"那句话里**注册表里存的东西**。标签是名字，
/// 这个才是身份 —— 协议处理器拿到标签之后查出来的就是它。
///
/// 它同时是 `rpc::dispatch` 的第三个参数：同一个 `ctx` 有两个调用方（沙箱界面与
/// Node 后台），而**只有界面有"我在哪个界面里"这一说**。后台插件传 `None`，
/// 于是"这个调用从哪个界面发出来"在类型上就是可选的，而不是一个空字符串约定。
#[derive(Debug, Clone, PartialEq, Eq)]
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

    /// webview 标签。**这是名字，不是身份** —— 身份是 `SurfaceKey` 自身。
    pub fn label(&self) -> String {
        label_for_surface(&self.plugin_id, &self.surface)
    }
}

/// Tauri 托管的沙箱界面表：`webview 标签 → 界面身份`。
///
/// 用 `std::sync::RwLock` 而不是 tokio 的：协议处理器要同步读它，而临界区里只做
/// 一次哈希查找 —— 短到不会成为一个需要异步的理由。
///
/// **键是标签，值是 `SurfaceKey`。** 这里曾经只存插件 id（多界面之前），
/// 而那时"一个插件一个 webview"是成立的；现在同一个插件可以有好几个界面，
/// 只存插件 id 会让协议处理器无法分辨"这个请求来自主界面还是详情界面"——
/// 于是两个界面会拿到同一份入口文档，而症状是"详情界面显示的是列表"。
#[derive(Default)]
pub struct SandboxSurfaces(RwLock<HashMap<String, SurfaceKey>>);

impl SandboxSurfaces {
    /// 记下"我给这个界面建了 webview"，返回它的标签。
    ///
    /// 标签冲突**必须**是显式错误：两个界面抢同一个 webview 名字时，静默让后来者
    /// 覆盖先来者会造成"其中一个界面永远打不开"，而那看起来像插件本身坏了。
    ///
    /// 冲突有两个来源，都真实存在：
    ///   * 两个插件的 id 净化后同名（`a.b` 与 `a-b`）；
    ///   * 同一插件里两个界面 id 净化后同名 —— 这一条在 `surfaces.rs` 解析时
    ///     就被拒了，这里再兜一次是因为 `claim` 也服务自检这类不走清单的调用方。
    fn claim(&self, key: SurfaceKey) -> Result<String, String> {
        let label = key.label();
        let mut map = self.0.write().unwrap_or_else(|e| e.into_inner());

        if let Some(existing) = map.get(&label) {
            if existing != &key {
                return Err(format!(
                    "webview 标签冲突：{label} 已经属于 {}#{}，不能再给 {}#{}",
                    existing.plugin_id, existing.surface, key.plugin_id, key.surface
                ));
            }
        }

        map.insert(label.clone(), key);
        Ok(label)
    }

    /// 这个标签是哪个插件的哪个界面。没建过就返回 `None` —— 调用方必须把它当成
    /// "这个请求不是来自插件 webview"，而不是"插件 id 是空串"。
    pub(super) fn key_of(&self, label: &str) -> Option<SurfaceKey> {
        self.0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .cloned()
    }

    /// 忘掉一条占位。界面被关掉、被驻留淘汰、或建失败回滚时调用。
    ///
    /// 它与"销毁 webview"必须**成对**发生：只关 webview 而留着占位，下一次建界面时
    /// 会以为"已经建过了"，而 webview 其实已经不在了。
    ///
    /// `pub(super)` 而不是私有：驻留淘汰发生在 `surface.rs` 的所有者线程上，
    /// 那里同样要撤占位。
    pub(super) fn forget(&self, label: &str) {
        self.0
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }

    /// 当前全部界面：`(标签, 身份)`。
    ///
    /// 给**跨插件事件**与**主题/快捷键推送**用：一条事件要送到每一个还活着的界面，
    /// 由各自的桥接层决定有没有人订阅它。
    ///
    /// 为什么是"推给所有界面"而不是"宿主先问谁订阅了"：后者需要多一套
    /// 订阅登记的协议与状态（注册 / 注销 / 界面销毁时清理），而活着的界面
    /// 受驻留上限约束，推一圈的代价是有界的。**用一个有界的代价换掉一整套会漂
    /// 的状态**，在这里是划算的。
    pub(super) fn live(&self) -> Vec<(String, SurfaceKey)> {
        self.0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(label, key)| (label.clone(), key.clone()))
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
            .values()
            .filter(|key| key.plugin_id == plugin_id)
            .map(|key| key.surface.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }
}

/// 从插件 id 得到**主界面**的 webview 标签。
///
/// **这不是身份**，只是名字（见文件头"标签不是身份"）。净化规则只保留字母数字与
/// `-` `_`，其余一律换成 `-`。
pub fn label_for(plugin_id: &str) -> String {
    label_for_surface(plugin_id, super::surfaces::PRIMARY_SURFACE)
}

/// 从插件 id 与界面 id 得到 webview 标签。
///
/// 两条形态，与方案 §2 画的那张图逐字对应：
///
///   * 主界面 → `plugin-<净化后的 id>`（**不带** `#`）
///   * 次级界面 → `plugin-<净化后的 id>#<界面 id>`
///
/// 主界面不带后缀是刻意的：已发布的单界面插件因此拿到与多界面之前**逐字节相同**
/// 的标签，它们的日志、断言与"我建过哪些界面"都不会因为这一步而变化。
///
/// 界面 id **不再净化**，因为它进标签之前已经被 `surfaces::is_safe_surface_id`
/// 白名单校验过。这里再净化一次反而有害：`a.b` 与 `a-b` 会变成同一条标签，
/// 而那种冲突在解析期就该被拒。
pub fn label_for_surface(plugin_id: &str, surface: &str) -> String {
    let sanitized: String = plugin_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();

    if surface == super::surfaces::PRIMARY_SURFACE {
        format!("{LABEL_PREFIX}{sanitized}")
    } else {
        format!("{LABEL_PREFIX}{sanitized}#{surface}")
    }
}

// ============================================================
// 注册协议
// ============================================================

/// 把协议处理器挂到 builder 上。
///
/// 处理器是**每个 webview 各自注册**的（见 tauri-runtime-wry 的 `create_webview`），
/// 因此子 webview 与主窗口都能用同一条协议 —— 这也是本方案能成立的技术前提之一。
///
/// 用**异步**变体：存储类 RPC 要读 `PluginManager`（在一把 tokio 锁后面），
/// 而同步变体的处理器跑在主线程上，在那里做异步等待会卡住界面。
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| {
        let label = ctx.webview_label().to_string();
        let app = ctx.app_handle().clone();

        tauri::async_runtime::spawn(async move {
            responder.respond(handle(&app, &label, request).await);
        });
    })
}

// ============================================================
// 路由
// ============================================================
//
// 路径的第一段**必须**等于注册表里这个标签对应的插件 id。两者不一致时**拒绝并
// 记录**，而不是相信路径 —— 理由见文件头。

async fn handle<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    // 自检页是内置的，不在注册表里（它没有插件目录）。
    if label == label_for(SELFTEST_ID) {
        return handle_selftest(app, request).await;
    }

    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        log::warn!("[sandbox] 界面表尚未就绪，拒绝 {label} 的请求");
        return text(503, "沙箱尚未就绪");
    };

    // 身份来自这张表，而表里的每一条都是**建界面时经 `PluginManager` 核实过**的。
    // 也就是说：一个没安装的插件、或者一个没声明的界面，都不可能出现在这里。
    let Some(key) = surfaces.key_of(label) else {
        log::warn!("[sandbox] 拒绝来自未建界面的 webview 的协议请求：{label}");
        return text(403, "这个来源不是插件界面");
    };

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

    let path = request.uri().path().to_string();
    let method = request.method().as_str().to_string();
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();

    let claimed = segments.first().copied().unwrap_or("");
    if claimed != view.id {
        log::warn!(
            "[sandbox] 拒绝跨插件的协议请求：webview={label}（属于 {}）声明了 {claimed}",
            view.id
        );
        return text(403, "请求的路径与所在 webview 不匹配");
    }

    match (method.as_str(), segments.get(1).copied()) {
        // 入口文档。**由宿主合成** —— 插件包因此不必自带 HTML。
        ("GET", None) | ("GET", Some("")) | ("GET", Some("index.html")) => {
            entry_document(app, &view, surface)
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
/// `close` 是一条**独立的**方法，不能落进下面的"结果上报"分支 —— 它发的是
/// 无 body 的 POST，被当成上报解析会得到一条 `EOF while parsing a value`
/// 的告警，而面板**关不掉**。这里踩过一次。
async fn handle_selftest<R: Runtime>(
    app: &AppHandle<R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    let path = request.uri().path().to_string();
    let method = request.method().as_str().to_string();
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();

    // 第一段是 `selftest`，由调用方保证。
    match (method.as_str(), segments.get(1).copied()) {
        ("GET", None) | ("GET", Some("")) => selftest_html(SELFTEST_HTML),
        ("GET", Some("selftest.html")) => selftest_html(SELFTEST_HTML),
        ("GET", Some("rpc")) => match segments.get(2).copied() {
            Some("ping") => json(&format!(
                r#"{{"ok":true,"webview":"{}","plugin":"{SELFTEST_ID}"}}"#,
                label_for(SELFTEST_ID)
            )),
            _ => text(404, "未知的 RPC 方法"),
        },
        ("POST", Some("rpc")) => {
            if segments.get(2).copied() == Some("close") {
                // 走所有者线程销毁，而不是就地从协议处理器里关 —— 这里正跑在
                // 引擎的请求路径上（主线程）。理由见 surface.rs 的文件头。
                if let Err(e) = close_surface(app, SELFTEST_ID, super::surfaces::PRIMARY_SURFACE).await {
                    log::warn!("[sandbox自检] 关闭界面失败：{e}");
                }
                return json(r#"{"ok":true}"#);
            }

            let body = String::from_utf8_lossy(request.body()).to_string();
            log_selftest_report(&body);
            json(r#"{"ok":true}"#)
        }
        _ => text(404, "没有这条路径"),
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
/// `script-src 'self'`（不是 `'unsafe-inline'`）：桥接与插件脚本都是同源外部文件，
/// 插件因此不能靠内联脚本绕过 —— 它的入口只有一个。
fn entry_document<R: Runtime>(
    app: &AppHandle<R>,
    plugin: &SandboxView,
    surface: &super::surfaces::SurfaceDecl,
) -> http::Response<Cow<'static, [u8]>> {
    let style = match &surface.style {
        Some(rel) => format!(
            r#"  <link rel="stylesheet" href="/{id}/asset/{rel}">"#,
            id = plugin.id,
            rel = escape_attr(rel)
        ),
        None => String::new(),
    };

    // 主题在**入口文档里**就注入，而不是等桥接层起来之后再改。
    //
    // 顺序很重要：先注入后渲染，插件的第一帧就是对的。反过来（先渲染再改）
    // 在深色主题下会白闪一帧，而那一下很显眼。理由详见 `theme.rs` 的文件头。
    let theme = app
        .try_state::<super::theme::PluginTheme>()
        .map(|state| state.get().to_css())
        .unwrap_or_default();

    let body = format!(
        r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>{name}</title>
    <!--
      空图标。
      没有这一行，浏览器会自动去请求文档根路径的 /favicon.ico，而那个路径的第一段
      不是任何插件 id —— 于是它会撞上"路径必须与 webview 所属插件相符"这条判断，
      在日志里留下一条**看起来像攻击的告警**，实际上只是浏览器的固定行为。
      实测撞到过。这里用一个空 data URL 把那一次请求彻底消掉，
      而不是去放宽那条判断。
    -->
    <link rel="icon" href="data:,">
{style}
    <!--
      文档外壳的重置。**这是宿主的事，不是插件的事。**

      没有这一段时，浏览器给 `<body>` 的默认 `margin: 8px` 会原样生效 ——
      插件界面的四周因此多出一圈 8px 的背景色缝隙，看起来像"没铺满"。
      实测就是这样：用户报的"存在留白"里有 8px 是这一行没写。

      `height: 100%` 同理：插件拿到的是一块固定尺寸的原生区域，它的文档必须
      默认就填满这块区域；否则每个插件都要自己写一遍 html/body 高度 100%，
      而漏写的那个看起来就像"界面只有一半高"。
    -->
    <style>
      html, body {{ margin: 0; padding: 0; height: 100%; }}
      #modulith-root {{ min-height: 100%; }}
    </style>
    <!--
      宿主的主题令牌。**这一段由 `theme.rs` 生成**，插件的 CSS 可以直接用
      与宿主同名的变量（`var(--accent-500)`），不需要任何前缀或改名。
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

      它同时受 `script-src 'self'` 约束 —— 三者都是同源外部文件，
      没有一条是内联。
    -->
    <script src="/{id}/react.js"></script>
    <script src="/{id}/bridge.js"></script>
    <script src="/{id}/asset/{main}"></script>
  </body>
</html>
"#,
        name = escape_html(&surface.name),
        id = plugin.id,
        style = style,
        main = escape_attr(&surface.entry),
        theme = theme,
    );

    page(body, "script-src 'self'; style-src 'self' 'unsafe-inline'")
}

/// 自检页：它是宿主内置的，脚本是内联的，所以那一份用 `'unsafe-inline'`。
///
/// 这个差别是有意的，**不要统一**：真插件必须是 `'self'`。
fn selftest_html(body: &str) -> http::Response<Cow<'static, [u8]>> {
    page(body.to_string(), "script-src 'unsafe-inline'; style-src 'unsafe-inline'")
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
    let csp = format!(
        "default-src 'none'; {script_and_style}; connect-src {ORIGIN}; \
         img-src 'self' data: blob:; font-src 'self' data:; frame-src 'none'; \
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
            && !source.contains("__PLUGIN_SHORTCUTS__"),
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

/// 把当前主题推给每一个还活着的沙箱界面。
///
/// ============================================================
/// 为什么是"换一段样式表"而不是"重新加载界面"
/// ============================================================
///
/// 重新加载插件界面会**丢掉它全部运行期状态** —— 用户正在填的表单、滚动位置、
/// 展开的树。用户只是切了一下浅色/深色，不该因此丢掉正在做的事。
///
/// 因此这里只替换 `<style id="modulith-theme">` 的**文本**。插件的 CSS 里
/// 那些 `var(--accent-500)` 会自动重新求值，因为变量是在 `:root` 上重新声明的。
///
/// 顺带调一次 `__modulithThemeChanged`，让订阅了 `ctx.theme.onChange` 的插件
/// 能在需要用 JS 拿颜色（canvas、SVG）时重新取一次。
pub async fn apply_theme<R: Runtime>(app: &AppHandle<R>) {
    let Some(theme) = app.try_state::<super::theme::PluginTheme>() else {
        return;
    };
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return;
    };
    let Some(actor) = app.try_state::<super::surface::SurfaceActor>() else {
        return;
    };

    let snapshot = theme.get();
    let css = snapshot.to_css();
    let described = theme.describe().to_string();

    let script = format!(
        "(function () {{\n\
         \x20 var style = document.getElementById('modulith-theme');\n\
         \x20 if (style) style.textContent = JSON.parse({css});\n\
         \x20 if (window.__modulithThemeChanged) window.__modulithThemeChanged(JSON.parse({described}));\n\
         }})();",
        css = js_string(&css),
        described = js_string(&described),
    );

    for (label, _key) in surfaces.live() {
        if let Err(error) = actor.eval(&label, script.clone()).await {
            // 一个界面推不到（多半是刚被销毁）不该影响其余界面。
            log::debug!("向沙箱界面 {label} 推送主题失败：{error}");
        }
    }
}

/// 把当前的快捷键表推给每一个还活着的沙箱界面。
///
/// 与主题推送同一条路子（换数据、不重载），但**驱动方不同**：主题由用户改设置
/// 触发，快捷键表由插件注册表变化触发（插件可以贡献快捷键，而那会让整张表变）。
pub async fn apply_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    let Some(table) = app.try_state::<super::shortcuts::PluginShortcuts>() else {
        return;
    };
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return;
    };
    let Some(actor) = app.try_state::<super::surface::SurfaceActor>() else {
        return;
    };

    let script = format!(
        "window.__modulithShortcutsChanged && window.__modulithShortcutsChanged(JSON.parse({}));",
        js_string(&table.describe().to_string())
    );

    for (label, _key) in surfaces.live() {
        if let Err(error) = actor.eval(&label, script.clone()).await {
            log::debug!("向沙箱界面 {label} 推送快捷键表失败：{error}");
        }
    }
}

/// 把一个字符串变成合法的 JS 字符串字面量。
/// 用 `serde_json` 而不是手写转义：它已经处理了引号、反斜杠与控制字符，
/// 而手写的那份总会在某个不常见字符上出错 —— 而出错的方向是"注入"。
///
/// `pub(super)`：`rpc.rs` 拼推送脚本时也要用它。两处各写一份转义，等于把
/// "注入"这件事的风险翻倍。
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


/// 打开沙箱自检面板。**由人显式触发，不再随应用启动自动运行。**
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
// 它验的是**边界本身**：ACL 真的拒绝、身份真的来自浏览器引擎而不是插件自报、
// 自定义协议通道真的可用、CSP 真的由引擎执行。这四件事没有别的触发点 ——
// 自检页是仓库里唯一会去**故意违规**的地方。
//
// 删掉它，这条边界就再也没有任何东西会去验一次了。所以改的是**什么时候跑**，
// 不是**跑不跑**：现在由「插件」页上的一个按钮触发。
///
/// 位置与尺寸写死：它是一次性的诊断面板，不参与布局。
/// 四项跑完之后面板会显示一个关闭按钮；全部通过时也会留着，由人来关。
pub async fn open_selftest<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let bounds = SurfaceBounds {
        x: 24.0,
        y: 24.0,
        width: 560.0,
        height: 420.0,
    };

    actor(app)?
        .show(&label_for(SELFTEST_ID), SELFTEST_ID, bounds, true)
        .await
}

/// 给一个**已安装**的插件显示沙箱界面。这是真插件唯一的入口。
///
/// ============================================================
/// 三个界面参数是怎么来的
/// ============================================================
///
/// `surface` 是**要开哪一个界面**（清单里声明的 id）。它由调用方给出：
///   * 前端打开一个标签时，取的是那个模块描述符上记的界面（见 `moduleCatalog`）；
///   * 插件自己调 `ctx.ui.openSurface('detail')` 时，由宿主先把它变成一个标签，
///     再回到这里 —— 也就是说**位置永远由宿主决定**，插件只说要哪一个界面。
///
/// 传一个清单里没有的界面 id 会在这里被拒（`view.surface()` 返回 `None`），
/// 而不是建出一个服务 404 的空 webview。
///
/// ============================================================
/// 三步的顺序
/// ============================================================
///
/// 每一步都在为一个失效方式兜底：
///
///   1. 先经 `PluginManager` 核实它存在、已启用、声明了 `runtime: sandboxed`、
///      且清单里有这个界面 —— 拿不到就**什么都不建**；
///   2. 再在界面表里占位。**先占位再建 webview**：反过来的话，webview 起来了而
///      协议请求先到，那一刻表里还没有这条记录，请求会被判成"不是插件界面"；
///   3. 最后交给所有者线程去建。建失败就撤销占位，免得留下一条指向不存在界面的记录。
///
/// **它是 `async` 的，这一点是承重的。** 同步命令的函数体在 IPC 线程（也就是主
/// 线程）上就地执行，而创建 webview 恰好不能在那里做 —— 完整推导见 `surface.rs`
/// 的文件头。把这三条命令写成同步的，就是那次整机假死。
pub async fn open_surface_at<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: &str,
    bounds: SurfaceBounds,
    visible: bool,
) -> Result<(), String> {
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
    let key = SurfaceKey::new(view.id.clone(), surface);
    let label = surfaces.claim(key)?;

    match actor(app)?.show(&label, &view.id, bounds, visible).await {
        Ok(()) => Ok(()),
        Err(e) => {
            // 建失败就把占位撤掉：留一条指向不存在界面的记录，会让下一次
            // `claim` 认为"已经建过了"，于是**永远建不出来**。
            surfaces.forget(&label);
            Err(e)
        }
    }
}

/// 隐藏一个插件的某个界面。**不销毁。**
///
/// 切标签、宿主浮层盖上来、窗口被收起时走这条。留着 webview 是有意的：下一次
/// 显示时不必再付一次控制器创建（那是几百毫秒），插件自己的界面状态也还在。
/// 真正不再需要的界面由 `close_surface` 销毁。
pub async fn hide_surface<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: &str,
) -> Result<(), String> {
    actor(app)?
        .set_visible(&label_for_surface(plugin_id, surface), false)
        .await
}

/// 关掉一个插件的某个界面，并撤销它的占位。
///
/// 关掉之后同一个界面可以再建一次（用户切走标签再切回来）。因此这一步必须
/// **同时**清掉界面表里的那条记录 —— 只关 webview 而留着记录，下一次建的时候
/// `claim` 会成功返回旧标签，而 webview 其实已经不在了。两处状态必须一起动。
pub async fn close_surface<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: &str,
) -> Result<(), String> {
    let label = label_for_surface(plugin_id, surface);

    if let Some(surfaces) = app.try_state::<SandboxSurfaces>() {
        surfaces.forget(&label);
    }

    actor(app)?.close(&label).await
}

/// 重新摆放一个插件的某个界面。界面不存在时**什么都不做**（返回 `Ok`）——
/// 前端在布局变化时无条件调用它，把"还没打开"当成错误会让每次缩放都报一次。
pub async fn set_surface_bounds<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: &str,
    bounds: SurfaceBounds,
) -> Result<(), String> {
    actor(app)?
        .place(&label_for_surface(plugin_id, surface), bounds)
        .await
}

/// 关掉一个插件的**全部**界面。
///
/// 插件被停用/卸载时走这条。少了它，一个被停用的插件留在屏幕上的那些界面会
/// 继续活着 —— 而它们属于一个"已经不存在"的插件，下一次协议请求会被 404 拒掉，
/// 用户看到的是一块再也刷不出来的空白。
pub async fn close_all_surfaces<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
) -> Result<(), String> {
    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return Ok(());
    };

    // 先把标签收集出来：`live()` 拿的是快照，因此循环里 `forget` 不会与它打架。
    let labels: Vec<String> = surfaces
        .live()
        .into_iter()
        .filter(|(_, key)| key.plugin_id == plugin_id)
        .map(|(label, _)| label)
        .collect();

    let mut first_error = None;
    for label in labels {
        surfaces.forget(&label);
        if let Err(error) = actor(app)?.close(&label).await {
            log::warn!("关闭 {plugin_id} 的界面 {label} 失败：{error}");
            first_error.get_or_insert(error);
        }
    }

    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
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
/// 与 `deliver_command` 同一条通道（`SurfaceActor::eval`），但多一个 `rel`：
/// 一个插件可以同时下好几个文件，而进度条要能分辨是哪一个。
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
    let Some(actor) = app.try_state::<super::surface::SurfaceActor>() else {
        return;
    };

    let payload = serde_json::json!({
        "rel": rel,
        "received": received,
        "total": total,
    })
    .to_string();

    let script = format!(
        "window.__modulithDownloadProgress && window.__modulithDownloadProgress(JSON.parse({}));",
        js_string(&payload)
    );

    for (label, key) in surfaces.live() {
        if key.plugin_id != plugin_id {
            continue;
        }
        if let Some(only) = only {
            if key.surface != only {
                continue;
            }
        }

        if let Err(error) = actor.eval(&label, script.clone()).await {
            log::debug!("向沙箱界面 {label} 推送下载进度失败：{error}");
        }
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
/// 沙箱插件的代码在它自己的 webview 里，宿主**拿不到它的任何函数** ——
/// 函数的引用过一次 realm 边界就消失了。因此"执行插件的某条命令"在这里只能是
/// "告诉它有人点了这条命令"，由它自己在文档里决定做什么。
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
    let Some(actor) = app.try_state::<super::surface::SurfaceActor>() else {
        return;
    };

    // 用 `JSON.parse` 包一层而不是把命令名直接拼进源码：命令名来自清单，而清单是
    // 外部输入 —— 一个含引号的 id 会把这段脚本拼坏，而那种失败看起来像"宿主推了
    // 一段坏脚本"，离真正的原因很远。
    let payload = serde_json::json!({ "command": command }).to_string();
    let script = format!(
        "window.__modulithCommand && window.__modulithCommand(JSON.parse({}));",
        js_string(&payload)
    );

    for (label, key) in surfaces.live() {
        if key.plugin_id != plugin_id {
            continue;
        }
        if let Some(only) = only {
            if key.surface != only {
                continue;
            }
        }

        if let Err(error) = actor.eval(&label, script.clone()).await {
            log::debug!("向沙箱界面 {label} 推送命令 {command} 失败：{error}");
        }
    }
}

/// 取界面所有者线程的句柄。
///
/// 它在 setup 阶段被托管。拿不到只有一个解释：应用还没走到那一步，
/// 而那是一个应该被说出来的状态，不是一个可以忽略的 `None`。
pub(crate) fn actor<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::State<'_, super::surface::SurfaceActor>, String> {
    app.try_state::<super::surface::SurfaceActor>()
        .ok_or_else(|| "沙箱界面线程尚未就绪".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::plugins::surfaces::PRIMARY_SURFACE;

    /// 主界面的标签**不带** `#` 后缀。
    ///
    /// 这一条是整个多界面改动的兼容性保证：已发布的单界面插件因此拿到与之前
    /// 逐字节相同的标签，它们的日志、断言与"我建过哪些界面"都不会变化。
    #[test]
    fn the_primary_surface_keeps_the_plain_label() {
        assert_eq!(label_for("com.example.notes"), "plugin-com-example-notes");
        assert_eq!(
            label_for_surface("com.example.notes", PRIMARY_SURFACE),
            "plugin-com-example-notes"
        );
        assert_eq!(label_for("com.example.notes"), label_for_surface("com.example.notes", PRIMARY_SURFACE));
    }

    /// 次级界面的标签带上界面名。
    ///
    /// 少了后缀的话，同一插件的两个界面会抢同一条标签，而 `claim` 会把第二个
    /// 判成冲突 —— 症状是"详情界面永远打不开"，而那看起来像插件自己坏了。
    #[test]
    fn a_secondary_surface_carries_its_name_in_the_label() {
        assert_eq!(
            label_for_surface("com.example.notes", "detail"),
            "plugin-com-example-notes#detail"
        );
        assert_ne!(
            label_for_surface("com.example.notes", "detail"),
            label_for_surface("com.example.notes", "main")
        );
    }

    /// 插件 id 仍然要被净化，而界面名**已经**被 `surfaces.rs` 白名单挡过，
    /// 因此不净化 —— 净化反而有害（`a.b` 与 `a-b` 会变成同一条标签）。
    #[test]
    fn the_plugin_id_is_sanitized_but_the_surface_name_is_not() {
        assert_eq!(label_for("a.b"), "plugin-a-b");
        // 两个不同的插件 id 净化后同名 → 后面那个会在 claim 时被判成冲突
        assert_eq!(label_for("a.b"), label_for("a-b"));

        // 界面名不被净化：一个带点的名字经 `label_for_surface` 出来仍然是带点的
        // （它根本不该走到这里 —— `is_safe_surface_id` 会先拒掉它）。
        assert!(label_for_surface("p", "a.b").ends_with("#a.b"));
    }

    /// `SurfaceKey` 的构造与判定。
    #[test]
    fn a_surface_key_knows_whether_it_is_the_primary_one() {
        let primary = SurfaceKey::new("p", PRIMARY_SURFACE);
        let detail = SurfaceKey::new("p", "detail");

        assert!(primary.is_primary());
        assert!(!detail.is_primary());
        assert_eq!(primary.label(), "plugin-p");
        assert_eq!(detail.label(), "plugin-p#detail");
        assert_ne!(primary, detail);
    }

    /// 界面表：同一个插件的两个界面各自占一条，互不冲突；换个插件抢同一条标签
    /// 才是冲突。
    #[test]
    fn the_surface_table_keeps_two_surfaces_of_one_plugin_apart() {
        let table = SandboxSurfaces::default();

        let main = table.claim(SurfaceKey::new("p", "main")).expect("主界面");
        let detail = table.claim(SurfaceKey::new("p", "detail")).expect("详情界面");
        assert_ne!(main, detail);

        assert_eq!(table.key_of(&main).unwrap().surface, "main");
        assert_eq!(table.key_of(&detail).unwrap().surface, "detail");

        // 重复 claim 同一条是幂等的（前端会重复调用 open）
        assert_eq!(table.claim(SurfaceKey::new("p", "main")).unwrap(), main);

        // 同一个界面名给不同的插件：标签不同，因此不冲突
        assert_ne!(table.claim(SurfaceKey::new("q", "main")).unwrap(), main);

        // 插件 id 净化后同名（`p-x` 与 `p.x` 都变成 `p-x`）→ **必须**是一个
        // 显式错误，而不是静默让后来者覆盖先来者。
        table.claim(SurfaceKey::new("p-x", "main")).unwrap();
        let clash = table.claim(SurfaceKey::new("p.x", "main"));
        assert!(clash.is_err(), "净化后同名的两个插件必须被判成标签冲突");
        assert!(clash.unwrap_err().contains("标签冲突"));
    }

    /// `forget` 之后同一条标签可以再次 claim —— 这正是"关掉再打开"的路径。
    #[test]
    fn forgetting_a_label_frees_it_for_the_next_open() {
        let table = SandboxSurfaces::default();
        let label = table.claim(SurfaceKey::new("p", "detail")).unwrap();

        table.forget(&label);
        assert!(table.key_of(&label).is_none());

        assert_eq!(table.claim(SurfaceKey::new("p", "detail")).unwrap(), label);
    }

    /// `live()` 与 `surfaces_of()` 是"哪些界面开着"的真源。
    #[test]
    fn live_and_surfaces_of_agree_with_what_was_claimed() {
        let table = SandboxSurfaces::default();
        table.claim(SurfaceKey::new("p", "main")).unwrap();
        table.claim(SurfaceKey::new("p", "detail")).unwrap();
        table.claim(SurfaceKey::new("q", "main")).unwrap();

        assert_eq!(table.live().len(), 3);
        assert_eq!(table.surfaces_of("p"), vec!["detail".to_string(), "main".to_string()]);
        assert_eq!(table.surfaces_of("q"), vec!["main".to_string()]);
        assert!(table.surfaces_of("nope").is_empty());
    }

    /// `forget` 不存在的标签是静默的 —— 关一个没开着的界面是正常路径。
    #[test]
    fn forgetting_something_that_was_never_claimed_is_not_an_error() {
        let table = SandboxSurfaces::default();
        table.forget("plugin-nobody");
        assert!(table.live().is_empty());
    }
}
