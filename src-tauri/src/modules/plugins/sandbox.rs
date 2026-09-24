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
//   2. **没有 IPC。** 插件 webview 的标签（`plugin-<id>`）**不匹配任何 capability**
//      —— 由 `pnpm check:acl` 断言这一点 —— 于是 Tauri 在 IPC 入口拒绝它的每一次
//      invoke，包括全部 120 条应用命令。这一步的前提是 `build.rs` 里那份应用级
//      ACL 清单：没有它，本机来源的 webview 调这些命令根本不过检查。
//      见 docs/04-安全/应用命令的访问控制.md。
//   3. **身份不可伪造。** 插件与宿主之间的通信走自定义协议，而协议处理器能拿到
//      **发起请求的那个 webview 的标签**（`UriSchemeContext::webview_label()`）。
//      身份因此来自浏览器引擎，而不是插件自己报的 id —— 这正是 v1.5 §1 里
//      "无法回答谁在调用"那个根因的答案。
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
// 网络第一次成为真的边界
// ============================================================
//
// 插件文档由**我们**生成并附上 CSP。因为文档跑在自己的来源上，而宿主掌控着
// 那份 CSP，`connect-src` 得以只留插件自己的来源：
//
//   * 插件**无法**直接 `fetch('https://…')` —— 由浏览器引擎执行，JS 改不掉；
//   * 要联网只能走 `ctx.http`，而那一路由宿主做权限判定与流量记录。
//
// 这与宿主界面今天的情况有本质区别：那里 `netGuard.ts` 自己承认"不是安全边界"
// （见 已知问题与技术债 §7.35）。这里的 `connect-src` 是。
//
// ============================================================
// 不是 OS 级沙箱
// ============================================================
//
// 插件仍在同一个操作系统进程树里、同一个用户下。它挡住的是"插件在应用内的权限"，
// 不是"插件对这台机器的权限" —— 后者要靠 job object / AppContainer 一类手段，
// 不在本模块范围内。任何把它读成"装了插件就安全"的说法都是错的。

use std::borrow::Cow;

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

/// 从插件 id 得到 webview 标签
pub fn label_for(plugin_id: &str) -> String {
    format!("{LABEL_PREFIX}{plugin_id}")
}

/// 从 webview 标签反推插件 id。不带前缀的标签返回 `None` —— 调用方必须把它当成
/// "这个请求不是来自插件 webview"，而不是"插件 id 是空串"。
pub fn plugin_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX)
}

// ============================================================
// 注册
// ============================================================

/// 把协议处理器挂到 builder 上。
///
/// 处理器是**每个 webview 各自注册**的（见 tauri-runtime-wry 的 `create_webview`），
/// 因此子 webview 与主窗口都能用同一条协议 —— 这也是本方案能成立的技术前提之一。
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_uri_scheme_protocol(SCHEME, |ctx, request| {
        let label = ctx.webview_label().to_string();
        let app = ctx.app_handle().clone();
        handle(&app, &label, request)
    })
}

// ============================================================
// 路由
// ============================================================
//
// 路径的第一段**必须**等于发起请求那个 webview 的插件 id。两者不一致时**拒绝并
// 记录**，而不是相信路径：
//
//   插件控制得了自己发的 URL，控制不了自己被挂在哪个 webview 上。
//   于是 `plugin-kanban` 这个 webview 里发出的 `/notes/...` 请求会在这里被挡下 ——
//   它既不能读别的插件的数据，也不能借别的插件的权限办事。
//
// 这条判断是"身份不可伪造"的落地点，删掉它整个模型就退回成"插件自报 id"。

fn handle<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    let Some(plugin_id) = plugin_id_from_label(label) else {
        // 主窗口或将来别的 webview 也能请求这条协议。拒绝，但要说清是谁。
        log::warn!("[sandbox] 拒绝来自非插件 webview 的协议请求：webview={label}");
        return text(403, "这个来源不是插件 webview");
    };

    let path = request.uri().path().to_string();
    let method = request.method().as_str().to_string();
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();

    // `/` 或空路径：没有任何可服务的东西。
    if segments.first().is_none_or(|s| s.is_empty()) {
        return text(404, "缺少插件 id");
    }

    let claimed = segments[0];
    if claimed != plugin_id {
        log::warn!(
            "[sandbox] 拒绝跨插件的协议请求：webview={label} 声明的插件={claimed}"
        );
        return text(403, "请求的路径与所在 webview 不匹配");
    }

    match (method.as_str(), segments.get(1).copied()) {
        // 插件界面的入口文档。自检之外的真插件由宿主**合成**这份文档
        // （插件包不必自带 HTML），增量 B 再落。
        ("GET", Some("")) | ("GET", None) => match plugin_id {
            SELFTEST_ID => html(SELFTEST_HTML),
            _ => text(501, "插件入口文档的合成尚未实现"),
        },

        ("GET", Some("selftest.html")) if plugin_id == SELFTEST_ID => html(SELFTEST_HTML),

        // 自检的 RPC。**这里是"能通信"的正面证据**：请求到达了宿主，
        // 且宿主知道是哪个 webview 发来的。
        ("GET", Some("rpc")) if plugin_id == SELFTEST_ID => match segments.get(2).copied() {
            Some("ping") => json(&format!(
                r#"{{"ok":true,"webview":"{label}","plugin":"{plugin_id}"}}"#
            )),
            _ => text(404, "未知的 RPC 方法"),
        },

        // 自检页把每一项检查的结果逐条投回来。宿主把它写进日志 ——
        // 于是"沙箱到底成没成立"这个问题由日志回答，而不是由人复述。
        ("POST", Some("rpc")) if plugin_id == SELFTEST_ID => {
            let body = String::from_utf8_lossy(request.body()).to_string();

            if segments.get(2).copied() == Some("close") {
                close_off_main_thread(app, label);
                return json(r#"{"ok":true}"#);
            }

            log_selftest_report(&body);
            json(r#"{"ok":true}"#)
        }

        _ => text(404, "没有这条路径"),
    }
}

/// 关掉一个插件 webview。
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
                Ok(()) => log::info!("[sandbox自检] 已关闭 {label}"),
                Err(e) => log::warn!("[sandbox自检] 关闭 {label} 失败：{e}"),
            }
        }
    });
}

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

// ============================================================
// 响应构造
// ============================================================

fn plain(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> http::Response<Cow<'static, [u8]>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, content_type)
        // 不要让引擎去猜类型：插件资源按扩展名给出的类型就是定论，
        // 猜出来的类型会让一段文本被当成脚本执行。
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(body.into()))
        .unwrap_or_else(|_| {
            // 上面的 header 全是静态合法值，构造失败在类型上不可能。
            // 真失败时给一个最小响应，而不是让线程 panic。
            http::Response::new(Cow::Borrowed(&b"internal error"[..]))
        })
}

fn text(status: u16, message: &str) -> http::Response<Cow<'static, [u8]>> {
    plain(status, "text/plain; charset=utf-8", message.as_bytes().to_vec())
}

fn json(body: &str) -> http::Response<Cow<'static, [u8]>> {
    plain(200, "application/json; charset=utf-8", body.as_bytes().to_vec())
}

/// 插件文档，带 CSP。
///
/// **CSP 是这一整套里唯一由浏览器引擎执行、JS 改不掉的东西**，所以它是边界本身：
///
///   * `default-src 'none'` —— 没写的东西一律不给；
///   * `connect-src <ORIGIN>` —— 只能跟宿主说话。这挡住了直接 `fetch` 外网；
///   * `frame-src 'none'` —— 不能嵌别的文档（否则可以借别人的来源发请求）；
///   * `form-action 'none'` —— 表单提交是另一条不经过 `fetch` 的出站路径；
///   * `base-uri 'none'` —— 防止把相对地址改指到别处。
///
/// `script-src` 由调用方给：自检页用 `'unsafe-inline'`（它就是一段内联脚本），
/// 真插件用 `'self'`。这个差别是有意的，不要统一。
fn html(body: &str) -> http::Response<Cow<'static, [u8]>> {
    let csp = format!(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
         connect-src {ORIGIN}; img-src 'none'; font-src 'none'; frame-src 'none'; \
         object-src 'none'; base-uri 'none'; form-action 'none'"
    );
    http::Response::builder()
        .status(200)
        .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("Content-Security-Policy", csp)
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(body.as_bytes().to_vec()))
        .unwrap_or_else(|_| http::Response::new(Cow::Borrowed(&b"internal error"[..])))
}

// ============================================================
// 自检：造一个真的插件 webview，让它自己证明边界成立
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
// 四条结果由页面逐条投回宿主并写进日志，因此结论可以从日志直接读出来。
//
// **第 2 条与第 4 条各写错过一次，两次都是"判据"错而不是沙箱错**，值得留在代码里：
//
//   * 第 2 条最初只认 release 的 `not allowed by ACL`，而 debug 构建给的是
//     `not allowed on window "…", webview "…" … referenced by: capability: …`
//     —— 一次完全正确的拒绝被判成失败。现在两种都认。
//   * 第 4 条最初测"fetch example.com 是否被挡下"，而断网时它同样被挡下，
//     于是"CSP 生效"与"这台机器没有直连外网"分不开。现在改用 `data:` 探针，
//     它在没有 CSP 时**必定成功**，因此判据只有一个解释。

/// 创建自检 webview。**只在 debug 构建里调用**，见 `lib.rs`。
///
/// 为什么在一个独立线程里、还要先 sleep：`add_child` 在 Windows 上从同步命令或
/// 事件处理器里调用会死锁（Tauri 官方记录的已知问题）。这里既不在主线程、
/// 又让主窗口先把自身建完，代价是自检比启动晚几秒出现。
pub fn spawn_self_test<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));

        let label = label_for(SELFTEST_ID);

        // 重复调用是安全的：已经有了就不再建。它同时挡住"热重载导致建两个"。
        if app.get_webview(&label).is_some() {
            log::info!("[sandbox自检] {label} 已存在，跳过");
            return;
        }

        // 注意这里用 `get_window` 而不是 `get_webview_window`：后者内部的
        // `is_webview_window()` 会在一个窗口拥有多个 webview 之后变成 false，
        // 于是"窗口明明在，却拿不到" —— 这正是多 webview 模式下的第一个坑。
        let Some(window) = app.get_window("main") else {
            log::warn!("[sandbox自检] 找不到主窗口，跳过");
            return;
        };

        let url = match tauri::Url::parse(&format!("{ORIGIN}/{SELFTEST_ID}/")) {
            Ok(url) => url,
            Err(e) => {
                log::warn!("[sandbox自检] 自检地址不合法：{e}");
                return;
            }
        };

        let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(url));

        // 位置与尺寸写死：这是一次性自检面板，不参与布局。真插件的界面要跟着
        // 标签栏与侧边栏走，那是增量 C 的事（`set_bounds` + 前端量矩形）。
        match window.add_child(
            builder,
            tauri::LogicalPosition::new(24.0, 120.0),
            tauri::LogicalSize::new(560.0, 420.0),
        ) {
            Ok(_) => log::info!("[sandbox自检] 已创建 webview {label}，等待它投回四项结果"),
            Err(e) => log::warn!("[sandbox自检] 创建 webview 失败：{e}"),
        }
    });
}
