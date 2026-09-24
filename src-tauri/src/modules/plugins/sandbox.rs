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
//   * 真正的身份是 `SandboxRegistry` 里那条 `标签 → 插件 id` 的记录；
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

/// 内置演示插件的 id。它只用一次：证明"真插件走这条链路"是通的。
pub const DEMO_ID: &str = "com.modulith.sandbox-demo";

// ============================================================
// 注册表
// ============================================================

// ============================================================
// 注册表：**目前有两个真源，这是一个已知的问题**
// ============================================================
//
// 已经有过两套"什么插件存在、它能做什么"：
//
//   * `PluginManager` —— 已安装插件的真源，存储权限与配额判定都在它那里；
//   * `SandboxRegistry`（本模块）—— 沙箱界面要用的那份同步缓存。
//
// 对**已安装的插件**，这两者描述同一个东西，因此不冲突。但内置演示插件只在后者里
// 出现，于是它调存储时被 `PluginManager` 拒绝（"插件不存在"）—— 那是**正确行为**
// （未知身份必须 fail-closed），但它也说明：真做一个真插件迁移时，
// **`SandboxRegistry` 必须由 `PluginManager` 派生**，而不是各记一份。
// 两套清单一定会漂，而漂开的方向是"沙箱以为这个插件存在、存储那边不认"。
//
// 这一点记在 docs/06-项目/已知问题与技术债.md §7.40，属于增量 C 的工作。

/// 沙箱里一个插件的运行时信息。
///
/// 这些字段都来自清单，在**注册时**读一次。协议处理器因此不必去碰
/// `PluginManager`（它在一把异步锁后面），每条资源请求也不会多一次加锁。
#[derive(Clone)]
struct SandboxPlugin {
    /// 真插件 id（身份）
    id: String,
    /// 界面标题
    name: String,
    /// 版本，交给桥接层展示
    version: String,
    /// 资源根目录（插件版本目录）
    root: PathBuf,
    /// 入口脚本（相对 `root`）
    main: String,
    /// 样式（相对 `root`）
    style: Option<String>,
    /// 清单里声明的权限，供桥接层做特性探测
    permissions: Vec<String>,
}

/// 标签 → 插件 的注册表。由 Tauri 托管。
///
/// 用 `std::sync::RwLock` 而不是 tokio 的：协议处理器要同步读它，而临界区里只做
/// 一次哈希查找 —— 短到不会成为一个需要异步的理由。
#[derive(Default)]
pub struct SandboxRegistry(RwLock<HashMap<String, SandboxPlugin>>);

impl SandboxRegistry {
    /// 注册一个沙箱插件，返回它的 webview 标签。
    ///
    /// 标签冲突**必须**是显式错误：两个插件抢同一个 webview 名字时，静默让后来者
    /// 覆盖先来者会造成"其中一个插件的界面永远打不开"，而那看起来像插件本身坏了。
    fn register(&self, plugin: SandboxPlugin) -> Result<String, String> {
        let label = label_for(&plugin.id);
        let mut map = self.0.write().unwrap_or_else(|e| e.into_inner());

        if let Some(existing) = map.get(&label) {
            if existing.id != plugin.id {
                return Err(format!(
                    "webview 标签冲突：{label} 已经属于 {}，不能给 {}",
                    existing.id, plugin.id
                ));
            }
        }

        map.insert(label.clone(), plugin);
        Ok(label)
    }

    fn get(&self, label: &str) -> Option<SandboxPlugin> {
        self.0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .cloned()
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
        return handle_selftest(request).await;
    }

    let Some(state) = app.try_state::<SandboxRegistry>() else {
        log::warn!("[sandbox] 注册表尚未就绪，拒绝 {label} 的请求");
        return text(503, "沙箱尚未就绪");
    };

    let Some(plugin) = state.get(label) else {
        log::warn!("[sandbox] 拒绝来自未注册 webview 的协议请求：{label}");
        return text(403, "这个来源不是已注册的插件 webview");
    };

    let path = request.uri().path().to_string();
    let method = request.method().as_str().to_string();
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();

    let claimed = segments.first().copied().unwrap_or("");
    if claimed != plugin.id {
        log::warn!(
            "[sandbox] 拒绝跨插件的协议请求：webview={label}（属于 {}）声明了 {claimed}",
            plugin.id
        );
        return text(403, "请求的路径与所在 webview 不匹配");
    }

    match (method.as_str(), segments.get(1).copied()) {
        // 入口文档。**由宿主合成** —— 插件包因此不必自带 HTML。
        ("GET", None) | ("GET", Some("")) | ("GET", Some("index.html")) => {
            entry_document(&plugin)
        }

        // 桥接层。它是宿主的一部分，不来自插件目录：插件拿不到它，也就改不了它。
        //
        // 每次响应都**按身份重新渲染一遍**（`bridge_script`），因此插件在顶层就能
        // 同步读到自己的 id / 名称 / 权限，不必先 await 一次握手。
        ("GET", Some("bridge.js")) => bridge_script(&plugin),

        ("GET", Some("asset")) => {
            let rel = segments[2..].join("/");
            serve_asset(&plugin, &rel)
        }

        ("POST", Some("rpc")) => {
            let Some(method) = segments.get(2).copied() else {
                return text(404, "缺少 RPC 方法");
            };
            dispatch_rpc(app, &plugin, method, request.body()).await
        }

        _ => text(404, "没有这条路径"),
    }
}

/// 自检页的路由。它只有四条路径，且不涉及任何插件目录。
async fn handle_selftest(request: http::Request<Vec<u8>>) -> http::Response<Cow<'static, [u8]>> {
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
fn entry_document(plugin: &SandboxPlugin) -> http::Response<Cow<'static, [u8]>> {
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
fn bridge_script(plugin: &SandboxPlugin) -> http::Response<Cow<'static, [u8]>> {
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
fn serve_asset(plugin: &SandboxPlugin, rel: &str) -> http::Response<Cow<'static, [u8]>> {
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
    plugin: &SandboxPlugin,
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

/// 内置演示插件的资源目录。
///
/// 用 `CARGO_MANIFEST_DIR` 而不是 `resource_dir()`：只有 debug 构建会用到它，
/// 而 cargo 运行的产物目录里没有 `resources/`。它**不随发布包分发**，这是有意的 ——
/// 演示插件是验证工具，不是功能。
#[cfg(debug_assertions)]
const DEMO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/resources/sandbox-demo");

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

        // 自检 webview 不走注册表（它没有插件目录），因此这里不必注册它。
        open_surface(&app, &label_for(SELFTEST_ID), SELFTEST_ID, 24.0);

        match demo_plugin() {
            Ok(plugin) => {
                let plugin_id = plugin.id.clone();
                let Some(state) = app.try_state::<SandboxRegistry>() else {
                    log::warn!("[sandbox自检] 沙箱注册表尚未就绪，跳过演示插件");
                    return;
                };
                // 演示插件**只**登记在沙箱注册表里，不在 `PluginManager` 里 ——
                // 它不是一个已安装的插件。因此它的存储调用会被正确拒绝，
                // 而页面把那条拒绝本身当成一项检查（fail-closed）。
                // 见文件头"目前有两个真源"。
                match state.register(plugin) {
                    // 标签用**注册返回的那个**，不用 `label_for(DEMO_ID)` 重算：
                    // 演示插件的 id 来自清单，清单与 DEMO_ID 一旦不一致，重算出来的
                    // 标签就查不到注册表，症状是 403 而不是"id 写错了"。
                    Ok(label) => open_surface(&app, &label, &plugin_id, 24.0 + 300.0),
                    Err(e) => log::warn!("[sandbox自检] 演示插件注册失败：{e}"),
                }
            }
            Err(e) => log::warn!("[sandbox自检] 演示插件不可用：{e}"),
        }
    });
}

/// 装配内置演示插件。
///
/// **走的是真清单类型**（`PluginManifest`）而不是自己发明一份小格式：多一份格式就
/// 多一处会与真清单漂开的地方，而漂开的方向恰好是"演示能跑、真插件不能"。
///
/// 资源目录用 `CARGO_MANIFEST_DIR` 而不是 `resource_dir()`：只有 debug 构建会用到它，
/// 而 cargo 运行的产物目录里没有 `resources/`。它**不随发布包分发**，这是有意的。
#[cfg(debug_assertions)]
fn demo_plugin() -> Result<SandboxPlugin, String> {
    let root = PathBuf::from(DEMO_ROOT);
    let text = std::fs::read_to_string(root.join("manifest.json"))
        .map_err(|e| format!("读不到清单：{e}"))?;
    let manifest: super::types::PluginManifest =
        serde_json::from_str(&text).map_err(|e| format!("清单不合法：{e}"))?;

    Ok(SandboxPlugin {
        id: manifest.name.clone(),
        name: if manifest.display_name.trim().is_empty() {
            manifest.name.clone()
        } else {
            manifest.display_name.clone()
        },
        version: manifest.version.clone(),
        root,
        main: manifest.main.clone(),
        style: manifest.style.clone(),
        permissions: manifest
            .permissions
            .iter()
            .map(|permission| permission.as_str().to_string())
            .collect(),
    })
}

/// 在指定位置开一个沙箱 webview。目前只有 debug 自检用它。
///
/// `label` 与 `plugin_id` 分开传：标签是注册表给的**名字**，插件 id 是**身份**，
/// 两者不保证能互相推出（见文件头"标签不是身份"）。
#[cfg(debug_assertions)]
fn open_surface<R: Runtime>(app: &AppHandle<R>, label: &str, plugin_id: &str, y: f64) {
    if app.get_webview(label).is_some() {
        log::info!("[sandbox自检] {label} 已存在，跳过");
        return;
    }

    // 注意这里用 `get_window` 而不是 `get_webview_window`：后者内部的
    // `is_webview_window()` 会在一个窗口拥有多个 webview 之后变成 false，
    // 于是"窗口明明在，却拿不到" —— 这是多 webview 模式下的第一个坑。
    let Some(window) = app.get_window("main") else {
        log::warn!("[sandbox自检] 找不到主窗口，跳过 {label}");
        return;
    };

    let url = match tauri::Url::parse(&format!("{ORIGIN}/{plugin_id}/")) {
        Ok(url) => url,
        Err(e) => {
            log::warn!("[sandbox自检] {plugin_id} 的地址不合法：{e}");
            return;
        }
    };

    let builder = tauri::webview::WebviewBuilder::new(label, tauri::WebviewUrl::External(url));

    // 位置与尺寸写死：这是一次性验证面板，不参与布局。真插件的界面要跟着标签栏与
    // 侧边栏走，那是增量 C 的事（`set_bounds` + 前端量矩形）。
    match window.add_child(
        builder,
        tauri::LogicalPosition::new(24.0, y),
        tauri::LogicalSize::new(560.0, 280.0),
    ) {
        Ok(_) => log::info!("[sandbox自检] 已创建 webview {label}"),
        Err(e) => log::warn!("[sandbox自检] 创建 webview {label} 失败：{e}"),
    }
}
