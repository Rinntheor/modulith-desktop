// src-tauri/src/modules/desktop/overlay.rs
//
// 宿主浮层窗口：**由宿主渲染**的对话框与右键菜单。
//
// ============================================================
// 为什么必须有这个窗口，而不能是一个 DOM 组件
// ============================================================
//
// 沙箱插件的界面是一个**原生子 webview**。它在窗口里的层级高于宿主文档的
// 任何 DOM 元素 —— 于是宿主页面里画出来的浮层（对话框、菜单）会被它整个盖住，
// 无论 `z-index` 写多大都没用。那不是样式问题，是两套渲染层的顺序问题。
//
// 因此浮层必须是一个**独立的窗口**：原生窗口天然在所有 webview 之上。
// 这与托盘菜单遇到的是同一个问题，用的是同一个解法（自绘、无边框、透明、
// 置顶），因此这里复用 `tray_menu::position_for` 那份定位逻辑 ——
// 它是纯函数，已经被测试覆盖过。
//
// ============================================================
// 第二条理由：外观
// ============================================================
//
// 沙箱插件画不出宿主的对话框。它就算画得再像，也只是"像一个别的应用的对话框"——
// 而让插件自己画等于让它可以**冒充宿主界面**（一个长得和系统确认框一模一样的
// 提示框，用来骗用户点"允许"）。
//
// 由宿主渲染之后，插件能决定的只有「问什么」，不能决定「长什么样」。
//
// ============================================================
// 请求与回答怎么配对
// ============================================================
//
// 插件调 `ctx.ui.dialog(...)` 是一次**会阻塞到用户做出选择**的调用。它走的是
// 一条 RPC，而 RPC 的语义是"发出去、拿到结果"—— 因此宿主必须把这一次调用
// 挂住，直到浮层窗口回了话。
//
// 配对靠一个自增 id 与一张 `id → oneshot 发送端` 的表：
//
//   插件 → ui.dialog → [登记 id，显示浮层] → await
//   浮层 → overlay_respond(id, 值) → [取出发送端，send] → 插件拿到结果
//
// **必须有超时**：浮层窗口如果因为任何原因没显示出来（窗口被系统策略拦住、
// 配置里漏了 label），那条 await 会永远挂着 —— 而插件作者看到的是"我的代码
// 没问题，就是没反应"。超时把它变成一句能定位的错误。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime};

/// 浮层窗口的标签。与 `tauri.conf.json` 里的 `label` 必须一致。
pub const OVERLAY_LABEL: &str = "overlay";

/// 浮层要显示什么。前端那一侧据此选组件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OverlayRequest {
    /// 由宿主渲染的对话框
    ///
    /// **变体里的 `rename_all` 不能省。** 枚举上的 `rename_all` 只作用于
    /// **变体名**，不作用于变体里的字段 —— 少了它，`confirm_label` 会原样发出去，
    /// 而前端读的是 `confirmLabel`，于是对话框的按钮文案显示成 `undefined`。
    ///
    /// 这条是被 `overlay_requests_round_trip_through_json` 抓出来的：
    /// 那条测试会把编码后的字符串一起打出来，于是"实际发出去的是什么"一眼可见。
    #[serde(rename = "dialog", rename_all = "camelCase")]
    Dialog {
        id: u64,
        /// `info` / `warning` / `error` / `question`
        tone: String,
        title: String,
        message: String,
        /// 「确定」按钮的文案
        confirm_label: String,
        /// 有取消按钮时给取消按钮的文案，`None` = 只有确定
        cancel_label: Option<String>,
    },
    /// 由宿主渲染的右键菜单（`rename_all` 的理由同上）
    #[serde(rename = "menu", rename_all = "camelCase")]
    Menu {
        id: u64,
        title: Option<String>,
        items: Vec<MenuItem>,
    },
}

/// 菜单里的一项。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItem {
    /// 回给调用方的标识
    pub id: String,
    pub label: String,
    /// 可选的快捷键提示（只展示，不绑定）
    #[serde(default)]
    pub accelerator: Option<String>,
    /// 分隔线。为 `true` 时其余字段被忽略。
    #[serde(default)]
    pub separator: bool,
    #[serde(default)]
    pub disabled: bool,
}

/// 用户对一次浮层的回答。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayResponse {
    pub id: u64,
    /// 对话框：`true` = 确定。菜单：被选中项的 id。
    #[serde(default)]
    pub confirmed: bool,
    #[serde(default)]
    pub selected: Option<String>,
    /// 用户直接关掉了浮层（点了别处 / Esc）。与"选了取消"不同：
    /// 取消是一个明确的回答，而这个是"没回答"。
    #[serde(default)]
    pub dismissed: bool,
}

/// 等待中的浮层：id → 回收回答的通道
type PendingMap = Mutex<HashMap<u64, tokio::sync::oneshot::Sender<OverlayResponse>>>;

/// 浮层的托管状态
#[derive(Default)]
pub struct Overlay {
    pending: PendingMap,
    next_id: AtomicU64,
}

/// 一次浮层的等待上限。
///
/// 5 分钟：长到用户可以从容读完一段说明再决定，短到不会让一条挂住的 await
/// 永远留在那里。超时之后那次调用以错误返回，插件据此可以让用户重试。
const RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

impl Overlay {
    pub fn new() -> Self {
        Self::default()
    }

    /// 显示一次浮层并等用户的回答。
    ///
    /// 由 `rpc::dispatch` 的 `ui.dialog` / `ui.contextMenu` 调用。
    pub async fn ask<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        mut request: OverlayRequest,
    ) -> Result<OverlayResponse, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        // id 由这里分配而不是让调用方传：它是**配对用的**，两个调用方各自生成
        // 就有可能撞上，而撞上的表现是"回答给了另一次请求"—— 那比没有回答更糟。
        match &mut request {
            OverlayRequest::Dialog { id: slot, .. } => *slot = id,
            OverlayRequest::Menu { id: slot, .. } => *slot = id,
        }

        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, sender);

        if let Err(error) = show(app, &request) {
            // 显示失败必须**把登记撤掉**：留着的话那条等待会一直挂到超时，
            // 而真正的原因（窗口不存在）只在这一次错误里。
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(error);
        }

        match tokio::time::timeout(RESPONSE_TIMEOUT, receiver).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("浮层窗口在回答之前关闭了".to_string()),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                hide(app);
                Err(format!(
                    "浮层在 {} 秒内没有收到回答",
                    RESPONSE_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// 收下浮层窗口的回答。返回是否命中了某次等待。
    pub fn respond(&self, response: OverlayResponse) -> bool {
        let waiter = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&response.id);

        match waiter {
            Some(sender) => {
                // 接收方可能已经因为超时走掉了；那不是错误。
                let _ = sender.send(response);
                true
            }
            None => false,
        }
    }

    /// 当前有多少次浮层在等回答（诊断用）
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// 丢弃全部等待（浮层窗口关掉了 / 应用退出）。
    ///
    /// 不丢的话那些 await 会各自挂到超时 —— 而它们已经不可能有回答了。
    pub fn cancel_all(&self) -> usize {
        let drained: Vec<_> = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .collect();
        drained.len()
    }
}

/// 找到浮层窗口（不存在时返回 `None`）
fn overlay_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Window<R>> {
    crate::core::window::get(app, OVERLAY_LABEL)
}

/// 显示浮层并把内容交给它。
///
/// 位置：**屏幕中心**，而不是光标处。菜单与会话框的区别在这里 ——
/// 一个对话框出现在光标旁边是错的（那个位置属于右键菜单）。
fn show<R: Runtime>(app: &AppHandle<R>, request: &OverlayRequest) -> Result<(), String> {
    let window = overlay_window(app).ok_or_else(|| {
        format!("浮层窗口不存在（检查 tauri.conf.json 里 label 为 {OVERLAY_LABEL} 的窗口）")
    })?;

    // 先把内容推过去**再**显示。
    //
    // 反过来的话，用户会看到上一次的内容闪一下再变成这一次的 —— 而"浮层刚出现
    // 时显示的是上一个插件的问题"正是那种会被当成安全问题的现象。
    app.emit(OVERLAY_SHOW, request)
        .map_err(|e| format!("无法把内容交给浮层窗口：{e}"))?;

    center_on_cursor_monitor(app, &window)?;

    window
        .show()
        .map_err(|e| format!("无法显示浮层窗口：{e}"))?;

    // 聚焦是必需的：没有焦点，`WindowEvent::Focused(false)` 就不会触发，
    // 于是"点别处关闭"这条路径失效，浮层会一直挂在屏幕上挡住别的东西。
    window
        .set_focus()
        .map_err(|e| format!("无法聚焦浮层窗口：{e}"))?;

    Ok(())
}

/// 把浮层摆到**光标所在显示器**的正中。
///
/// 用光标所在的显示器而不是主显示器：多显示器下用户在副屏上操作插件，
/// 对话框出现在主屏正中等于"它没出现"。
fn center_on_cursor_monitor<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::Window<R>,
) -> Result<(), String> {
    let size = window
        .outer_size()
        .map_err(|e| format!("无法取得浮层尺寸：{e}"))?;

    let monitor = match app.cursor_position() {
        Ok(cursor) => window
            .monitor_from_point(cursor.x, cursor.y)
            .ok()
            .flatten()
            .or_else(|| window.current_monitor().ok().flatten()),
        Err(_) => window.current_monitor().ok().flatten(),
    };

    let Some(monitor) = monitor else {
        // 拿不到显示器信息：**保持原位**而不是猜一个。一个跑到屏幕外去的对话框
        // 比一个位置不完美的对话框糟得多。
        return Ok(());
    };

    let area = monitor.work_area();
    let x = area.position.x + ((area.size.width as i32 - size.width as i32) / 2).max(0);
    let y = area.position.y + ((area.size.height as i32 - size.height as i32) / 2).max(0);

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| format!("无法移动浮层窗口：{e}"))
}

/// 隐藏浮层（幂等）
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = overlay_window(app) else {
        return;
    };
    if let Err(error) = window.hide() {
        log::warn!("浮层：隐藏失败：{error}");
    }
}

/// 让浮层窗口按内容调整自己的尺寸。
///
/// 由浮层前端在量完内容之后调用 —— 尺寸**只有它知道**（一段说明文字折行之后
/// 有多高取决于字号与字体，宿主猜不出来）。
pub fn resize<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = overlay_window(app) else {
        return Err("浮层窗口不存在".to_string());
    };

    // 钳制到合理范围：一个量错的尺寸（0 或者几万）会让窗口变得不可用，
    // 而那是浮层前端的一个 bug，不该让用户看到一个消失或铺满全屏的对话框。
    let width = width.clamp(MIN_WIDTH, MAX_WIDTH);
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);

    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("无法调整浮层尺寸：{e}"))
}

/// 浮层窗口显示内容时广播的事件名。
pub const OVERLAY_SHOW: &str = "modulith://overlay-show";

// ============================================================
// 浮层窗口调用的三条命令在 `commands.rs` 里
// ============================================================
//
// 放在那里不是因为分层，而是因为**代码生成器只扫每个模块的 `commands.rs`**
// （见 `scripts/generate-backend-module.ts`）。命令写在这个文件里会被
// `AppManifest::commands` 收进去、却不会被 `generate_handler!` 注册 ——
// 于是它在运行期表现为"调用了不存在的命令"。门禁能抓到那个不一致，
// 但更省事的是从一开始就把它放在生成器认识的位置。

pub const MIN_WIDTH: f64 = 220.0;
pub const MAX_WIDTH: f64 = 720.0;
pub const MIN_HEIGHT: f64 = 120.0;
pub const MAX_HEIGHT: f64 = 720.0;

/// 装上"失去焦点就收起来"的行为。
///
/// 与托盘菜单同一套：没有它，用户点了别处之后浮层还挂在屏幕上挡着东西，
/// 而它看起来像"卡住了"。
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = overlay_window(app) else {
        log::warn!("浮层窗口不存在，宿主渲染的对话框与菜单不可用（检查 tauri.conf.json 的 label）");
        return;
    };

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            // 失焦 = 用户去别处了。这一次就当"没回答"—— 与点别处关闭菜单一致。
            //
            // 用 `dismissed` 而不是"当作取消"：两者对插件的含义不同。
            // 取消是一个明确的回答（"我不要"），而这个是"没回答"。
            if let Some(state) = handle.try_state::<Overlay>() {
                let dismissed = state.cancel_all();
                if dismissed > 0 {
                    log::debug!("浮层失焦，{dismissed} 次等待被放弃");
                }
            }
            hide(&handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回答必须**只**能被交给一次等待。
    ///
    /// 交两次的话，第二次会命中另一次请求 —— 而"回答给了别人"比没有回答更糟：
    /// 插件会拿到一个它没有问过的结果，并据此做出错的决定。
    #[test]
    fn a_response_is_delivered_exactly_once() {
        let overlay = Overlay::new();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        overlay
            .pending
            .lock()
            .unwrap()
            .insert(7, sender);

        assert_eq!(overlay.pending_count(), 1);

        let first = OverlayResponse {
            id: 7,
            confirmed: true,
            selected: None,
            dismissed: false,
        };
        assert!(overlay.respond(first.clone()), "第一次应当命中");
        assert_eq!(overlay.pending_count(), 0);
        assert!(!overlay.respond(first), "第二次不该再命中");

        let delivered = receiver.try_recv().expect("应当收到回答");
        assert!(delivered.confirmed);
    }

    /// 回答一个**没有登记过**的 id 不是错误，只是没有命中。
    ///
    /// 它真的会发生：用户先按 Esc 关掉浮层（等待被撤），随后窗口又发了一条
    /// 迟到的回答。把那种情况当错误会在日志里堆出一片"浮层回答失败"，
    /// 而它们全都是正常的收尾。
    #[test]
    fn a_response_for_an_unknown_id_is_not_an_error() {
        let overlay = Overlay::new();
        let orphan = OverlayResponse {
            id: 999,
            confirmed: false,
            selected: None,
            dismissed: true,
        };
        assert!(!overlay.respond(orphan));
        assert_eq!(overlay.pending_count(), 0);
    }

    /// 取消全部会把等待清空 —— 没有它，浮层窗口关掉之后那些 await 只能各自超时。
    #[test]
    fn cancel_all_drains_every_waiter() {
        let overlay = Overlay::new();
        for id in 0..3 {
            let (sender, _receiver) = tokio::sync::oneshot::channel();
            overlay.pending.lock().unwrap().insert(id, sender);
        }
        assert_eq!(overlay.pending_count(), 3);
        assert_eq!(overlay.cancel_all(), 3);
        assert_eq!(overlay.pending_count(), 0);
        assert_eq!(overlay.cancel_all(), 0, "再取消一次不该报错");
    }

    /// 请求的形状要能**原样过一遍 JSON**。
    ///
    /// 它由 Rust 生成、由前端消费，中间没有编译器帮我们检查 ——
    /// 字段名漂了的表现是浮层里少一个按钮或者什么都不显示。
    #[test]
    fn overlay_requests_round_trip_through_json() {
        let dialog = OverlayRequest::Dialog {
            id: 3,
            tone: "warning".to_string(),
            title: "删除".to_string(),
            message: "确定吗？".to_string(),
            confirm_label: "删除".to_string(),
            cancel_label: Some("取消".to_string()),
        };

        let encoded = serde_json::to_string(&dialog).unwrap();
        // 判别式是 `kind`，而它的取值是**线上契约**（前端按它选组件）
        assert!(encoded.contains(r#""kind":"dialog""#), "实际：{encoded}");
        assert!(encoded.contains(r#""cancelLabel":"取消""#), "实际：{encoded}");

        let decoded: OverlayRequest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), encoded);
    }

    /// 菜单的判别式同样是 `kind`，而分隔线项要能过。
    #[test]
    fn menu_requests_round_trip_through_json() {
        let items = vec![
            MenuItem {
                id: "a".to_string(),
                label: "第一项".to_string(),
                accelerator: Some("mod+1".to_string()),
                separator: false,
                disabled: false,
            },
            MenuItem {
                id: String::new(),
                label: String::new(),
                accelerator: None,
                separator: true,
                disabled: false,
            },
        ];
        let request = OverlayRequest::Menu {
            id: 1,
            title: Some("操作".to_string()),
            items,
        };

        let encoded = serde_json::to_string(&request).unwrap();
        assert!(encoded.contains(r#""kind":"menu""#), "实际：{encoded}");
        assert!(encoded.contains(r#""separator":true"#), "实际：{encoded}");
        assert!(encoded.contains(r#""accelerator":"mod+1""#), "实际：{encoded}");
    }

    /// 尺寸有上下限 —— 一个量错的尺寸会让窗口不可用。
    #[test]
    fn the_size_clamp_is_sane() {
        assert!(MIN_WIDTH < MAX_WIDTH);
        assert!(MIN_HEIGHT < MAX_HEIGHT);
        // 一个正常的对话框必须落在范围内，否则上面的钳制会把每一个浮层都改坏
        assert!(MIN_WIDTH <= 420.0 && 420.0 <= MAX_WIDTH);
        assert!(MIN_HEIGHT <= 220.0 && 220.0 <= MAX_HEIGHT);
    }

    #[test]
    fn a_fresh_overlay_has_nothing_pending() {
        let overlay = Overlay::new();
        assert_eq!(overlay.pending_count(), 0);
        assert_eq!(overlay.cancel_all(), 0);
    }

    #[test]
    fn the_window_label_matches_the_configuration() {
        let conf = include_str!("../../../tauri.conf.json");
        assert!(
            conf.contains(&format!("\"label\": \"{OVERLAY_LABEL}\"")),
            "tauri.conf.json 里没有 label 为 {OVERLAY_LABEL} 的窗口"
        );
    }

    /// 浮层窗口必须**默认隐藏**，且置顶。
    ///
    /// 忘了 `visible: false` 的表现是：应用一启动就有一个空的浮层挂在屏幕中央，
    /// 而它是透明的、什么都没有 —— 用户完全不知道那是什么。
    #[test]
    fn the_window_starts_hidden_and_on_top() {
        let conf = include_str!("../../../tauri.conf.json");
        let start = conf.find(&format!("\"label\": \"{OVERLAY_LABEL}\""));
        let block = start
            .map(|at| &conf[at..(at + 700).min(conf.len())])
            .unwrap_or_default();

        assert!(block.contains("\"visible\": false"), "浮层窗口必须默认隐藏");
        assert!(block.contains("\"alwaysOnTop\": true"), "浮层窗口必须置顶");
        assert!(block.contains("\"transparent\": true"), "浮层窗口必须透明（圆角靠它）");
        assert!(
            block.contains(&format!("\"url\": \"{OVERLAY_LABEL}.html\"")),
            "浮层窗口的 url 必须指向 overlay.html"
        );
    }
}
