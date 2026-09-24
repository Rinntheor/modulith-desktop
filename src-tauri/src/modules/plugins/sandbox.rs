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
// **标签 → 插件 id** 这一条映射，而它不可能与真源漂开 —— 因为每一次界面创建
// 都必须先通过 `sandbox_view` 拿到那个插件，拿不到就建不出来。
//
// 也就是说：**没安装的插件拿不到界面，这是构造上就成立的**，不是靠一道检查。

/// Tauri 托管的沙箱界面表：`webview 标签 → 插件 id`。
///
/// 用 `std::sync::RwLock` 而不是 tokio 的：协议处理器要同步读它，而临界区里只做
/// 一次哈希查找 —— 短到不会成为一个需要异步的理由。
#[derive(Default)]
pub struct SandboxSurfaces(RwLock<HashMap<String, String>>);

impl SandboxSurfaces {
    /// 记下"我给这个插件建了界面"，返回它的 webview 标签。
    ///
    /// 标签冲突**必须**是显式错误：两个插件抢同一个 webview 名字时，静默让后来者
    /// 覆盖先来者会造成"其中一个插件的界面永远打不开"，而那看起来像插件本身坏了。
    fn claim(&self, plugin_id: &str) -> Result<String, String> {
        let label = label_for(plugin_id);
        let mut map = self.0.write().unwrap_or_else(|e| e.into_inner());

        if let Some(existing) = map.get(&label) {
            if existing != plugin_id {
                return Err(format!(
                    "webview 标签冲突：{label} 已经属于 {existing}，不能再给 {plugin_id}（两者的 id 净化后同名）"
                ));
            }
        }

        map.insert(label.clone(), plugin_id.to_string());
        Ok(label)
    }

    /// 这个标签是哪个插件的界面。没建过就返回 `None` —— 调用方必须把它当成
    /// "这个请求不是来自插件 webview"，而不是"插件 id 是空串"。
    fn plugin_of(&self, label: &str) -> Option<String> {
        self.0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .cloned()
    }

    /// 忘掉一条占位。界面被关掉、或建失败回滚时调用。
    ///
    /// 它与"关掉 webview"必须**成对**发生：只关 webview 而留着占位，下一次建界面时
    /// 会以为"已经建过了"，而 webview 其实已经不在了。
    fn forget(&self, label: &str) {
        self.0
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }
}

/// 从插件 id 得到 webview 标签。
///
/// **这不是身份**，只是名字（见文件头"标签不是身份"）。净化规则只保留字母数字与
/// `-` `_`，其余一律换成 `-`。
pub fn label_for(plugin_id: &str) -> String {
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
    format!("{LABEL_PREFIX}{sanitized}")
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
    // 也就是说：一个没安装的插件不可能出现在这里。
    let Some(plugin_id) = surfaces.plugin_of(label) else {
        log::warn!("[sandbox] 拒绝来自未建界面的 webview 的协议请求：{label}");
        return text(403, "这个来源不是插件界面");
    };

    // 插件的事实（根目录、入口、样式、权限）从 `PluginManager` 读 —— 单一真源。
    // 锁在文件 IO 之前放掉（下面的入口文档与资源读取都要碰磁盘）。
    let view = {
        let Some(state) = app.try_state::<super::PluginState>() else {
            return text(503, "插件系统尚未就绪");
        };
        let manager = state.0.read().await;
        match manager.sandbox_view(&plugin_id) {
            Ok(view) => view,
            Err(e) => {
                log::warn!("[sandbox] 取不到 {plugin_id} 的沙箱视图：{e}");
                return text(404, "这个插件当前不可用");
            }
        }
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
            entry_document(&view)
        }

        // 桥接层。它是宿主的一部分，不来自插件目录：插件拿不到它，也就改不了它。
        //
        // 每次响应都**按身份重新渲染一遍**（`bridge_script`），因此插件在顶层就能
        // 同步读到自己的 id / 名称 / 权限，不必先 await 一次握手。
        ("GET", Some("bridge.js")) => bridge_script(&view),

        ("GET", Some("asset")) => {
            let rel = segments[2..].join("/");
            serve_asset(&view, &rel)
        }

        ("POST", Some("rpc")) => {
            let Some(method) = segments.get(2).copied() else {
                return text(404, "缺少 RPC 方法");
            };
            dispatch_rpc(app, &view, method, request.body()).await
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
                close_off_main_thread(app, &label_for(SELFTEST_ID));
                return json(r#"{"ok":true}"#);
            }

            let body = String::from_utf8_lossy(request.body()).to_string();
            log_selftest_report(&body);
            json(r#"{"ok":true}"#)
        }
        _ => text(404, "没有这条路径"),
    }
}

/// 关掉一个沙箱 webview。
///
/// **不在协议处理器里直接 `close()`。** 处理器跑在引擎的请求路径上，而销毁一个
/// webview 会走 `DestroyWindow` 一类的窗口操作 —— 在 Windows 上从窗口消息的
/// 处理链里做这件事有明确的死锁面。丢给一个独立线程，代价是一次线程创建。
fn close_off_main_thread<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        if let Some(webview) = app.get_webview(&label) {
            match webview.close() {
                Ok(()) => log::info!("[sandbox] 已关闭 {label}"),
                Err(e) => log::warn!("[sandbox] 关闭 {label} 失败：{e}"),
            }
        }
    });
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
fn entry_document(plugin: &SandboxView) -> http::Response<Cow<'static, [u8]>> {
    let style = match &plugin.style {
        Some(rel) => format!(
            r#"  <link rel="stylesheet" href="/{id}/asset/{rel}">"#,
            id = plugin.id,
            rel = escape_attr(rel)
        ),
        None => String::new(),
    };

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
  </head>
  <body>
    <div id="modulith-root"></div>
    <!-- 桥接层先于插件脚本加载：插件的入口只有这一个，它拿不到更早的位置 -->
    <script src="/{id}/bridge.js"></script>
    <script src="/{id}/asset/{main}"></script>
  </body>
</html>
"#,
        name = escape_html(&plugin.name),
        id = plugin.id,
        style = style,
        main = escape_attr(&plugin.main),
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
fn bridge_script(plugin: &SandboxView) -> http::Response<Cow<'static, [u8]>> {
    let permissions = serde_json::to_string(&plugin.permissions)
        .unwrap_or_else(|_| "[]".to_string());

    let source = BRIDGE_JS
        .replace("'__PLUGIN_ID__'", &js_string(&plugin.id))
        .replace("'__PLUGIN_NAME__'", &js_string(&plugin.name))
        .replace("'__PLUGIN_VERSION__'", &js_string(&plugin.version))
        .replace("__PLUGIN_PERMISSIONS__", &permissions);

    // 占位符没被替换掉 = 桥接层与这里的约定漂了。那时交给插件的会是一段
    // 字面量 `'__PLUGIN_ID__'`，症状是"插件的 id 变成了这个怪字符串" ——
    // 与其让它那样发生，不如在这里就说清楚。
    debug_assert!(
        !source.contains("__PLUGIN_ID__")
            && !source.contains("__PLUGIN_NAME__")
            && !source.contains("__PLUGIN_VERSION__")
            && !source.contains("__PLUGIN_PERMISSIONS__"),
        "桥接脚本里的占位符没有被全部替换 —— sandbox-bridge.js 与 bridge_script 的约定漂了"
    );

    script(&source)
}

/// 把一个字符串变成合法的 JS 字符串字面量。
///
/// 用 `serde_json` 而不是手写转义：它已经处理了引号、反斜杠与控制字符，
/// 而手写的那份总会在某个不常见字符上出错 —— 而出错的方向是"注入"。
fn js_string(value: &str) -> String {
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
// RPC
// ============================================================
//
// 插件调 `ctx.*` 就是往这里发一条请求。**权限判定不在这里重写** ——
// `PluginManager` 的存储方法自己会走 `require_permission`，配额也仍在同一条路径上。
// 沙箱这一层只负责"这是谁发的"，不负责"他能不能"。

async fn dispatch_rpc<R: Runtime>(
    app: &AppHandle<R>,
    plugin: &SandboxView,
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

    match method {
        "log" => {
            let level = args.get("level").and_then(|v| v.as_str()).unwrap_or("info");
            let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
            match level {
                "debug" => log::debug!("[plugin:{}] {message}", plugin.id),
                "warn" => log::warn!("[plugin:{}] {message}", plugin.id),
                "error" => log::error!("[plugin:{}] {message}", plugin.id),
                _ => log::info!("[plugin:{}] {message}", plugin.id),
            }
            json(r#"{"ok":true}"#)
        }

        "storage.get" => {
            let Some(key) = args.get("key").and_then(|v| v.as_str()) else {
                return rpc_error("缺少 key");
            };
            match storage_manager(app) {
                None => rpc_error("插件系统尚未就绪"),
                Some(manager) => {
                    let manager = manager.read().await;
                    match manager.storage_get(&plugin.id, key) {
                        Ok(value) => json_value(&serde_json::json!({ "ok": true, "value": value })),
                        Err(e) => rpc_error(&e.to_string()),
                    }
                }
            }
        }

        "storage.set" => {
            let (Some(key), Some(value)) = (
                args.get("key").and_then(|v| v.as_str()),
                args.get("value").and_then(|v| v.as_str()),
            ) else {
                return rpc_error("缺少 key 或 value");
            };
            match storage_manager(app) {
                None => rpc_error("插件系统尚未就绪"),
                Some(manager) => {
                    let manager = manager.read().await;
                    match manager.storage_set(&plugin.id, key, value) {
                        Ok(()) => json(r#"{"ok":true}"#),
                        // 配额拒绝的消息里带着"哪一档、上限多少、已用多少、本次多少"
                        // 四个数字，原样回给插件 —— 它需要那些数字才能自救。
                        Err(e) => rpc_error(&e.to_string()),
                    }
                }
            }
        }

        "storage.delete" => {
            let Some(key) = args.get("key").and_then(|v| v.as_str()) else {
                return rpc_error("缺少 key");
            };
            match storage_manager(app) {
                None => rpc_error("插件系统尚未就绪"),
                Some(manager) => {
                    let manager = manager.read().await;
                    match manager.storage_delete(&plugin.id, key) {
                        Ok(()) => json(r#"{"ok":true}"#),
                        Err(e) => rpc_error(&e.to_string()),
                    }
                }
            }
        }

        "storage.keys" => match storage_manager(app) {
            None => rpc_error("插件系统尚未就绪"),
            Some(manager) => {
                let manager = manager.read().await;
                match manager.storage_keys(&plugin.id) {
                    Ok(keys) => json_value(&serde_json::json!({ "ok": true, "value": keys })),
                    Err(e) => rpc_error(&e.to_string()),
                }
            }
        },

        _ => rpc_error(&format!("未知的 RPC 方法：{method}")),
    }
}

fn storage_manager<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<std::sync::Arc<tokio::sync::RwLock<super::manager::PluginManager>>> {
    app.try_state::<super::PluginState>().map(|s| s.0.clone())
}

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


/// 注册自检与演示插件，并建它们的 webview。**只在 debug 构建里存在**。
///
/// 为什么在一个独立线程里、还要先 sleep：`add_child` 在 Windows 上从同步命令或
/// 事件处理器里调用会死锁（Tauri 官方记录的已知问题）。这里既不在主线程、
/// 又让主窗口先把自身建完。
///
/// 整个函数带 `cfg(debug_assertions)`：它建的两个 webview 是验证工具，不是功能，
/// 装进 release 会让每个用户平白多两个渲染进程。
#[cfg(debug_assertions)]
pub fn spawn_debug_harness<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));

        // 自检 webview 不走界面表（它没有插件目录），因此这里不必登记它。
        // 位置尺寸写死：这是一次性的验证面板，不参与布局，而且四项全过之后会自己关掉。
        let bounds = SurfaceBounds {
            x: 24.0,
            y: 24.0,
            width: 560.0,
            height: 420.0,
        };
        if let Err(e) = open_surface(&app, &label_for(SELFTEST_ID), SELFTEST_ID, bounds) {
            log::warn!("[sandbox自检] 自检界面建不出来：{e}");
            return;
        }

        // **刻意不再自动给插件建界面。**
        //
        // 这里曾经无条件地给"第一个声明了 sandboxed 的已安装插件"开一块面板，
        // 用来验证真插件那一半。第一次真机运行证明那样做是错的：用户没打开任何插件，
        // 界面上却多出一块挡在那里的面板，而且**没有任何方式关掉它**。
        //
        // 真插件那一半现在走**真实路径**：用户在侧边栏打开模块时，前端量出内容区
        // 矩形并调用 `sandbox_surface_open`。自检页留着，因为它验的是**边界本身**，
        // 而那件事没有别的触发点；它还会在四项全过之后自己关掉。
    });
}

/// 沙箱界面在窗口里的位置与尺寸（**逻辑像素**，相对窗口客户区左上角）。
///
/// 由**前端**量出来传进来，宿主不自己算：只有前端知道标签栏、分屏、侧边栏当前
/// 各占多少。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl SurfaceBounds {
    /// 夹到至少 1×1。WebView2 不接受 0 尺寸的控件，而"内容区被折叠到 0 宽"
    /// 是一个真实会出现的状态（侧边栏展开动画的第一帧）。
    fn sanitized(self) -> Self {
        Self {
            x: self.x,
            y: self.y,
            width: self.width.max(1.0),
            height: self.height.max(1.0),
        }
    }
}

/// 给一个**已安装**的插件建沙箱界面。这是真插件唯一的入口。
///
/// 三步的顺序是有意的，每一步都在为一个失效方式兜底：
///
///   1. 先经 `PluginManager` 核实它存在、已启用、且声明了 `runtime: sandboxed`
///      —— 拿不到就**什么都不建**。没安装的插件因此构造上就不可能拿到界面；
///   2. 再在界面表里占位。**先占位再建 webview**：反过来的话，webview 起来了而
///      协议请求先到，那一刻表里还没有这条记录，请求会被判成"不是插件界面"；
///   3. 最后建 webview。建失败就撤销占位，免得留下一条指向不存在界面的记录。
pub fn open_surface_at<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    bounds: SurfaceBounds,
) -> Result<(), String> {
    let view = {
        let Some(state) = app.try_state::<super::PluginState>() else {
            return Err("插件系统尚未就绪".to_string());
        };
        let manager = tauri::async_runtime::block_on(async { state.0.read().await });
        manager.sandbox_view(plugin_id).map_err(|e| e.to_string())?
    };

    if !view.runtime.needs_own_webview() {
        return Err(format!(
            "{} 的清单写的是 runtime={}，不该给它建独立界面",
            view.id,
            view.runtime.as_str()
        ));
    }

    let Some(surfaces) = app.try_state::<SandboxSurfaces>() else {
        return Err("沙箱界面表尚未就绪".to_string());
    };
    let label = surfaces.claim(&view.id)?;

    match open_surface(app, &label, &view.id, bounds) {
        Ok(()) => Ok(()),
        Err(e) => {
            // 建失败就把占位撤掉：留一条指向不存在界面的记录，会让下一次
            // `claim` 认为"已经建过了"，于是**永远建不出来**。
            surfaces.forget(&label);
            Err(e)
        }
    }
}

/// 关掉一个插件的沙箱界面，并撤销它的占位。
///
/// 关掉之后同一个插件可以再建一次（用户切走标签再切回来）。因此这一步必须
/// **同时**清掉界面表里的那条记录 —— 只关 webview 而留着记录，下一次建的时候
/// `claim` 会成功返回旧标签，但 `open_surface` 里"已存在就跳过"的判断会发现
/// webview 已经没了……于是建不出来。两处状态必须一起动。
pub fn close_surface<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) -> Result<(), String> {
    let label = label_for(plugin_id);

    if let Some(surfaces) = app.try_state::<SandboxSurfaces>() {
        surfaces.forget(&label);
    }

    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| format!("关闭 {label} 失败：{e}"))?;
        log::info!("[sandbox] 已关闭 {label}");
    }

    Ok(())
}

/// 重新摆放一个插件的沙箱界面。界面不存在时**什么都不做**（返回 `Ok`）——
/// 前端在布局变化时无条件调用它，把"还没打开"当成错误会让每次缩放都报一次。
pub fn set_surface_bounds<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    bounds: SurfaceBounds,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label_for(plugin_id)) else {
        return Ok(());
    };

    let bounds = bounds.sanitized();
    webview
        .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| format!("移动界面失败：{e}"))?;
    webview
        .set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| format!("调整界面失败：{e}"))?;

    Ok(())
}

/// 在指定位置开一个沙箱 webview。
///
/// `label` 与 `plugin_id` 分开传：标签是界面表给的**名字**，插件 id 是**身份**，
/// 两者不保证能互相推出（见文件头"标签不是身份"）。
fn open_surface<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    plugin_id: &str,
    bounds: SurfaceBounds,
) -> Result<(), String> {
    if app.get_webview(label).is_some() {
        // 已经开着：当成一次"重新摆放"，而不是失败。用户切标签回来时会走到这里。
        return set_surface_bounds(app, plugin_id, bounds);
    }

    // 注意这里用 `get_window` 而不是 `get_webview_window`：后者内部的
    // `is_webview_window()` 会在一个窗口拥有多个 webview 之后变成 false，
    // 于是"窗口明明在，却拿不到" —— 这是多 webview 模式下的第一个坑。
    let Some(window) = app.get_window("main") else {
        return Err("找不到主窗口".to_string());
    };

    let url = tauri::Url::parse(&format!("{ORIGIN}/{plugin_id}/"))
        .map_err(|e| format!("{plugin_id} 的地址不合法：{e}"))?;

    let builder = tauri::webview::WebviewBuilder::new(label, tauri::WebviewUrl::External(url));
    let bounds = bounds.sanitized();

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(bounds.x, bounds.y),
            tauri::LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("创建 webview {label} 失败：{e}"))?;

    log::info!(
        "[sandbox] 已创建 webview {label}（{}×{} @ {},{})",
        bounds.width,
        bounds.height,
        bounds.x,
        bounds.y
    );
    Ok(())
}
