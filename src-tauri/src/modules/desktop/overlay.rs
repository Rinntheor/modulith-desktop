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
//
// ============================================================
// 第三种：结果卡片（`ctx.ui.popover`）
// ============================================================
//
// 它复用同一个窗口、同一套 id 配对，但与对话框有三处**刻意不同**：
//
//   1. **不聚焦。** 聚焦是"点别处关闭"那条路径的前提（见 `show`），而卡片不要
//      那个前提。插件一次调用就把用户正在输入的光标抢走，那是比"打断一下"
//      更强的一类能力，而卡片刻意停在 `notification` 那一档风险上。
//   2. **到点自己消失。** 超时在这里**不是**错误兜底，而是产品行为：卡片等
//      `timeoutMs` 之后自动收起，调用方拿到的是"用户没回答"。
//   3. **同一时刻只有一张。**
//
// 三条合起来是同一句话：插件能让一张卡片出现，但不能把用户的光标抢走、
// 也不能让它赖在屏幕上。

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
    /// 由宿主渲染的**结果卡片**（`rename_all` 的理由同上）
    ///
    /// 这里的每一个字段都是**内容**（一段文本、一组按钮文案），没有一处能让
    /// 插件影响它长什么样。理由见文件头第二条 —— 让插件决定外观等于让它可以
    /// 冒充宿主界面。
    #[serde(rename = "popover", rename_all = "camelCase")]
    Popover {
        id: u64,
        /// `info` / `success` / `warning` / `error`，由 Rust 侧白名单过
        tone: String,
        /// 可选的短标题
        title: Option<String>,
        /// 正文。**到达这里之前已经被宿主截断过** —— 它可能是用户选中的原文，
        /// 什么内容都可能有，而长短完全由用户决定。
        body: String,
        actions: Vec<PopoverAction>,
        /// 到点自动收起的毫秒数。带着它只是为了让"这一次浮层是什么"自明；
        /// **计时由宿主做**，前端不设第二个定时器 —— 两个来源必然漂开。
        timeout_ms: u64,
        at: PopoverAnchor,
    },
}

/// 结果卡片上的一个按钮。
///
/// 只有 id 与文案：**没有图标、没有样式、没有颜色**。卡片外观全部由宿主决定，
/// 因此插件能决定的只有"让用户选什么"，不是"它看起来像什么"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopoverAction {
    /// 回给调用方的标识（返回值的 `action` 就是它）
    pub id: String,
    pub label: String,
}

/// 卡片贴在哪儿。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PopoverAnchor {
    /// 光标附近（默认）
    Cursor,
    /// 光标所在显示器的正中
    Center,
}

impl Default for PopoverAnchor {
    fn default() -> Self {
        Self::Cursor
    }
}

impl OverlayRequest {
    /// 这一次浮层的配对 id（由 `Overlay` 分配）。
    pub fn id(&self) -> u64 {
        match self {
            Self::Dialog { id, .. } | Self::Menu { id, .. } | Self::Popover { id, .. } => *id,
        }
    }
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
    /// 结果卡片上被点中的那个动作的 id。`None` = 没回答（超时 / Esc / 点别处）。
    ///
    /// 与 `selected` **刻意分开**：那一个是菜单项，取值空间来自清单与插件临时给的
    /// 条目；这一个只来自结果卡片。共用字段的话，一次迟到的菜单回答会被读成
    /// "用户点了卡片上的某个动作"。
    #[serde(default)]
    pub action: Option<String>,
    /// 用户直接关掉了浮层（点了别处 / Esc）。与"选了取消"不同：
    /// 取消是一个明确的回答，而这个是"没回答"。
    #[serde(default)]
    pub dismissed: bool,
}

/// 等待中的浮层：id → 回收回答的通道
type PendingMap = Mutex<HashMap<u64, tokio::sync::oneshot::Sender<OverlayResponse>>>;

/// 同一时刻只允许一张结果卡片。
///
/// ============================================================
/// 为什么"新的顶掉旧的"值得单独一个类型
/// ============================================================
///
/// 这条规则本身是**纯的** —— 它只是一对数字的先后关系。嵌在异步等待里的话，
/// 想测它就必须造一个真窗口；抽出来之后，"第二个来的时候第一个会怎么样"
/// 是一句话就能验的事。
///
/// 两张重叠的卡片比一张糟得多：它们会盖在同一个光标位置上，而**先收起哪一张、
/// 点空白处收起的是哪一张都没有说法**。因此这里不堆叠 —— 新的来，旧的当场
/// 以"用户没回答"结束。
#[derive(Debug, Default)]
struct PopoverSlot {
    current: Option<u64>,
}

impl PopoverSlot {
    /// 登记一张新卡片，返回被它顶掉的那一张（没有则 `None`）。
    fn begin(&mut self, id: u64) -> Option<u64> {
        let superseded = self.current.filter(|previous| *previous != id);
        self.current = Some(id);
        superseded
    }

    /// 收尾。**只有当收尾的正是当前那一个时才清空** —— 被顶掉的那一张收尾时
    /// 不能把新那一张的占位一起清掉，否则"还有一张卡片在屏幕上"这件事就丢了，
    /// 而下一次 `begin` 会以为自己是第一个。
    fn end(&mut self, id: u64) -> bool {
        if self.current == Some(id) {
            self.current = None;
            true
        } else {
            false
        }
    }
}

/// 浮层的托管状态
#[derive(Default)]
pub struct Overlay {
    pending: PendingMap,
    next_id: AtomicU64,
    popover: Mutex<PopoverSlot>,
    /// 浮层窗口此刻显示的是**哪一个请求**的内容。
    ///
    /// 窗口只有一个，而卡片会**自己消失**：一次超时的卡片若无条件 `hide()`，
    /// 会把此后显示在同一窗口上的对话框一起收掉 —— 用户看到的是"对话框自己
    /// 关了"，而两侧的代码读起来都是对的。陈旧的取值无害（它只会让一次本该
    /// 发生的隐藏不发生，而下一次 `show` 一定会覆盖它）。
    showing: Mutex<Option<u64>>,
}

/// 一次浮层的等待上限。
///
/// 5 分钟：长到用户可以从容读完一段说明再决定，短到不会让一条挂住的 await
/// 永远留在那里。超时之后那次调用以错误返回，插件据此可以让用户重试。
///
/// **只适用于 `ask`（对话框与菜单）。** 结果卡片用的是调用方给的、比它短三个
/// 数量级的那个上限，而且到了那个上限**不是错误**（见 `popover`）。
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
            OverlayRequest::Popover { id: slot, .. } => *slot = id,
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
                // 只收掉**自己**那一张：这条等待结束时，窗口上可能已经是别人的
                // 内容了（一次超时的对话框不该顺手关掉此后弹上来的东西）。
                self.dismiss_window_of(app, id);
                Err(format!(
                    "浮层在 {} 秒内没有收到回答",
                    RESPONSE_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// 显示一张结果卡片，等用户点一个动作。
    ///
    /// ============================================================
    /// 它与 `ask` 的区别，以及为什么不能合成一个
    /// ============================================================
    ///
    /// `ask` 的超时**是错误**（"浮层没有回答"意味着插件该让用户重试），而卡片的
    /// 超时**是答案**（"用户没回答"，契约里的 `null`）。合成一个方法就得让调用方
    /// 去分辨"这个 Err 是故障还是正常收尾"，而那种判断一定会有人写错。
    ///
    /// 因此这里返回 `Ok(None)` 而不是 `Err`：**只有"窗口没能显示出来"才是错误**。
    pub async fn popover<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        mut request: OverlayRequest,
        timeout: std::time::Duration,
    ) -> Result<Option<String>, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        match &mut request {
            OverlayRequest::Popover { id: slot, .. } => *slot = id,
            // 上层（`rpc::dispatch`）只会用 `Popover` 调这里。真收到别的说明
            // 有人接错了线 —— 当卡片显示的话，它的字段会全部读不出来。
            _ => return Err("结果卡片收到了别种浮层请求".to_string()),
        }

        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, sender);

        // 同一时刻只允许一张卡片：新的来，旧的当场以"用户没回答"结束。
        if let Some(previous) = self.supersede_previous(id) {
            log::debug!("结果卡片 {previous} 被新的一张顶掉");
        }

        if let Err(error) = show_popover(app, &request) {
            // 与 `ask` 同一条纪律：显示失败必须把登记撤掉，否则那条等待会一直
            // 挂到超时，而真正的原因（窗口不存在）只在这一次错误里。
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            self.popover
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .end(id);
            // 内容可能已经推给窗口了（失败发生在摆位置那一步），因此这里也要
            // 把窗口收掉并清掉"正在显示"的标记 —— 否则它会留在窗口里，等下一次
            // 有别的浮层上来时才被覆盖。
            self.dismiss_window_of(app, id);
            return Err(error);
        }

        let outcome = tokio::time::timeout(timeout, receiver).await;
        self.popover
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .end(id);

        match outcome {
            Ok(Ok(response)) => {
                self.dismiss_window_of(app, id);
                Ok(response.action)
            }
            // 通道被关掉 = 窗口在我们回答之前先走了（失焦收起、应用退出、
            // 或 `cancel_all`）。对卡片来说这就是"用户没回答" —— 契约里 `null`
            // 的三种来源之一，不是故障。
            Ok(Err(_)) => {
                self.dismiss_window_of(app, id);
                Ok(None)
            }
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                // **到点必须真的把窗口收起来。** 只解决那条 await 是不够的：
                // 留在屏幕上的透明卡片会挡住别的东西，而用户没有任何办法把它
                // 关掉（他没点过它，它也没有关闭按钮）。
                self.dismiss_window_of(app, id);
                log::debug!("结果卡片 {id} 到点自动收起");
                Ok(None)
            }
        }
    }

    /// 记下"窗口现在显示的是这一个请求"。
    fn mark_showing(&self, id: u64) {
        *self.showing.lock().unwrap_or_else(|e| e.into_inner()) = Some(id);
    }

    /// 顶掉上一张卡片，并把它那一次等待**当场以"用户没回答"结束**。
    ///
    /// 与窗口无关，因此单测可以直接调它 —— 而"顶掉之后旧那一次到底拿到了什么"
    /// 正是这条规则里最容易写错的一半：把通道丢掉的实现在界面上完全一样，
    /// 只是旧那一次会以"窗口不见了"这个错误的理由结束。
    fn supersede_previous(&self, id: u64) -> Option<u64> {
        let previous = self
            .popover
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .begin(id)?;

        let waiter = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&previous);

        if let Some(sender) = waiter {
            // 回一条 `action: None` 的回答，而不是把通道丢掉。
            let _ = sender.send(OverlayResponse {
                id: previous,
                confirmed: false,
                selected: None,
                action: None,
                dismissed: true,
            });
        }

        Some(previous)
    }

    /// 清掉"窗口显示的是这个请求"这条记录，返回**该不该由这一次来收起窗口**。
    fn take_showing(&self, id: u64) -> bool {
        let mut showing = self.showing.lock().unwrap_or_else(|e| e.into_inner());
        if *showing == Some(id) {
            *showing = None;
            true
        } else {
            false
        }
    }

    /// 收起窗口 —— **但只有当它显示的还是 `id` 那一个请求时**。
    ///
    /// 由 `ask` / `popover` 在收尾时调用，也由 `overlay_respond` 那条命令调用：
    /// 一次迟到的回答不该顺手关掉此后显示在同一个窗口上的东西。
    pub fn dismiss_window_of<R: Runtime>(&self, app: &AppHandle<R>, id: u64) {
        if self.take_showing(id) {
            hide(app);
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

    // 记下"这一眼看到的是谁的内容"。`show` 与 `show_popover` 各写一次，
    // 后写的赢 —— 那正是"窗口只有一个、后到的顶掉先到的"这件事的记录。
    if let Some(overlay) = app.try_state::<Overlay>() {
        overlay.mark_showing(request.id());
    }

    center_on_cursor_monitor(app, &window)?;

    window
        .show()
        .map_err(|e| format!("无法显示浮层窗口：{e}"))?;

    // 聚焦是必需的：没有焦点，`WindowEvent::Focused(false)` 就不会触发，
    // 于是"点别处关闭"这条路径失效，浮层会一直挂在屏幕上挡住别的东西。
    //
    // **结果卡片不走这一步**（见 `show_popover`）：它没有"点别处关闭"这条路径
    // 要成立，而抢焦点是另一类能力。
    window
        .set_focus()
        .map_err(|e| format!("无法聚焦浮层窗口：{e}"))?;

    Ok(())
}

/// 显示一张**结果卡片**。
///
/// 与 `show` 共用"先推内容、再显示"的顺序与同一条理由；差别只有两处，
/// 两处都是刻意的：
///
///   * **不调 `set_focus`。** 聚焦是对话框"点别处关闭"那条路径的前提，而卡片靠
///     超时收起，不需要它。反过来说，聚焦意味着插件可以让一张卡片把用户正在
///     输入的光标抢走 —— 那是比"打断一下"更强的一类能力。
///   * 位置按 `at` 选：光标处（默认）或屏幕正中。
fn show_popover<R: Runtime>(app: &AppHandle<R>, request: &OverlayRequest) -> Result<(), String> {
    let OverlayRequest::Popover { at, .. } = request else {
        return Err("show_popover 收到了别种浮层请求".to_string());
    };

    let window = overlay_window(app).ok_or_else(|| {
        format!("浮层窗口不存在（检查 tauri.conf.json 里 label 为 {OVERLAY_LABEL} 的窗口）")
    })?;

    app.emit(OVERLAY_SHOW, request)
        .map_err(|e| format!("无法把内容交给浮层窗口：{e}"))?;

    if let Some(overlay) = app.try_state::<Overlay>() {
        overlay.mark_showing(request.id());
    }

    place_popover(app, &window, *at)?;

    window
        .show()
        .map_err(|e| format!("无法显示浮层窗口：{e}"))?;

    Ok(())
}

/// 把卡片摆到光标处（或光标所在显示器的正中）。
fn place_popover<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::Window<R>,
    at: PopoverAnchor,
) -> Result<(), String> {
    let size = window
        .outer_size()
        .map_err(|e| format!("无法取得浮层尺寸：{e}"))?;

    let cursor = app.cursor_position().ok();
    let monitor = match cursor {
        Some(cursor) => window
            .monitor_from_point(cursor.x, cursor.y)
            .ok()
            .flatten()
            .or_else(|| window.current_monitor().ok().flatten()),
        None => window.current_monitor().ok().flatten(),
    };

    let Some(monitor) = monitor else {
        // 拿不到显示器信息：**保持原位**而不是猜一个（与 `center_on_cursor_monitor`
        // 同一条取舍）。一个跑到屏幕外去的卡片比一个位置不完美的卡片糟得多。
        return Ok(());
    };

    let area = monitor.work_area();
    let (x, y) = place(
        WorkArea {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width as i32,
            height: area.size.height as i32,
        },
        (size.width as i32, size.height as i32),
        // `cursor_position()` 给的是**浮点**坐标，而摆放用的是整数物理像素。
        // 取整（而不是截断）：截断会把 -0.6 变成 0，于是副屏上贴着左边缘的
        // 卡片会往右偏一个像素，而"偏一个像素"在调试时看不出是这里。
        cursor.map(|cursor| (cursor.x.round() as i32, cursor.y.round() as i32)),
        at,
    );

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| format!("无法移动浮层窗口：{e}"))
}

/// 一块可用区域（显示器工作区），单位是物理像素。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// 卡片相对光标的偏移。
///
/// 稍微往右下让开一点：压在光标正下方会盖住用户刚选中的那个词，而"我想看翻译、
/// 结果原文被盖住了"是这张卡片唯一不能接受的摆放。
const CURSOR_OFFSET_X: i32 = 12;
const CURSOR_OFFSET_Y: i32 = 16;

/// 算出卡片左上角的物理坐标。
///
/// ============================================================
/// 为什么它是纯函数
/// ============================================================
///
/// "贴在光标旁边"真正难的不是加法，而是**贴边的时候怎么办**：屏幕右下角的光标
/// 加上一张 420×220 的卡片，会有一大半在屏幕外。而这一条在真机上很难碰巧复现，
/// 因此判据必须是可以直接喂进去的。
///
/// 贴边时的做法是**拉回工作区内**，不是翻转到光标另一侧：翻转会让卡片在用户
/// 眼底从一处跳到另一处，而那种位移看起来像一次 bug。
fn place(
    area: WorkArea,
    size: (i32, i32),
    cursor: Option<(i32, i32)>,
    at: PopoverAnchor,
) -> (i32, i32) {
    let centered = (
        area.x + ((area.width - size.0) / 2).max(0),
        area.y + ((area.height - size.1) / 2).max(0),
    );

    let (x, y) = match (at, cursor) {
        (PopoverAnchor::Cursor, Some((cx, cy))) => (cx + CURSOR_OFFSET_X, cy + CURSOR_OFFSET_Y),
        // 「正中」以及"光标位置拿不到"都落到这里。后者**回退到正中**而不是原点：
        // 拿不到光标时把卡片摆到屏幕左上角，看起来像它自己跑出来的。
        _ => centered,
    };

    // 卡片比工作区还大时上界会小于下界；`max` 把那种情况下界钉在工作区原点，
    // 于是卡片至少从可见区域的一角开始，而不是以负坐标跑出去。
    let max_x = (area.x + area.width - size.0).max(area.x);
    let max_y = (area.y + area.height - size.1).max(area.y);

    (x.clamp(area.x, max_x), y.clamp(area.y, max_y))
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
            action: None,
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
            action: None,
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

    /// 结果的形状同样要能原样过一遍 JSON —— 卡片的按钮就是靠这里的字段名。
    #[test]
    fn popover_requests_round_trip_through_json() {
        let request = OverlayRequest::Popover {
            id: 5,
            tone: "success".to_string(),
            title: Some("翻译".to_string()),
            body: "原文 → 译文".to_string(),
            actions: vec![PopoverAction {
                id: "copy".to_string(),
                label: "复制译文".to_string(),
            }],
            timeout_ms: 8000,
            at: PopoverAnchor::Cursor,
        };

        let encoded = serde_json::to_string(&request).unwrap();
        assert!(encoded.contains(r#""kind":"popover""#), "实际：{encoded}");
        assert!(encoded.contains(r#""timeoutMs":8000"#), "实际：{encoded}");
        assert!(encoded.contains(r#""at":"cursor""#), "实际：{encoded}");
        // 按钮只有 id 与文案：多出来的字段意味着插件能影响外观了
        assert!(
            encoded.contains(r#""actions":[{"id":"copy","label":"复制译文"}]"#),
            "实际：{encoded}"
        );

        let decoded: OverlayRequest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), encoded);
    }

    /// 卡片回答里的 `action` 与菜单的 `selected` 是**两个字段**。
    ///
    /// 合成一个的话，一次迟到的菜单回答会被读成"用户点了卡片上的某个动作" ——
    /// 而那个动作 id 是插件自己起的，它会照着一个没发生过的选择往下做。
    #[test]
    fn a_popover_answer_does_not_look_like_a_menu_selection() {
        let answer = OverlayResponse {
            id: 1,
            confirmed: false,
            selected: None,
            action: Some("copy".to_string()),
            dismissed: false,
        };
        let encoded = serde_json::to_string(&answer).unwrap();
        assert!(encoded.contains(r#""action":"copy""#), "实际：{encoded}");
        // 缺字段的旧回答（浮层前端还没来得及更新）要能被解析
        let legacy: OverlayResponse =
            serde_json::from_str(r#"{"id":1,"confirmed":false,"selected":null,"dismissed":true}"#)
                .unwrap();
        assert_eq!(legacy.action, None);
    }

    /// **同一时刻只允许一张卡片**，且旧那一次要当场拿到"用户没回答"。
    #[test]
    fn a_second_popover_supersedes_the_first() {
        let mut slot = PopoverSlot::default();

        assert_eq!(slot.begin(1), None, "第一张没有人可顶");
        assert_eq!(slot.current, Some(1));

        assert_eq!(slot.begin(2), Some(1), "第二张应当把第一张顶掉");
        assert_eq!(slot.current, Some(2));

        // 被顶掉那张随后收尾时**不能**把新那张的占位清掉 ——
        // 清了的话"屏幕上还有一张卡片"这件事就丢了。
        assert!(!slot.end(1), "被顶掉的那一张收尾不该动当前占位");
        assert_eq!(slot.current, Some(2));

        assert!(slot.end(2), "当前那一张收尾才清空");
        assert_eq!(slot.current, None);
    }

    /// 顶掉只管**卡片**，而且旧那一次拿到的必须是 `action: None` 的回答。
    ///
    /// 把通道丢掉的实现在界面上完全一样，只是旧那一次会以"窗口不见了"这个
    /// 不成立的理由结束 —— 而那是插件作者会去查日志的那条路。
    #[test]
    fn superseding_answers_the_previous_waiter_instead_of_dropping_it() {
        let overlay = Overlay::new();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        overlay.pending.lock().unwrap().insert(1, sender);

        assert_eq!(overlay.supersede_previous(1), None, "第一次没有上一张");
        assert_eq!(overlay.supersede_previous(2), Some(1));

        let answer = receiver.try_recv().expect("旧那一次应当收到回答");
        assert_eq!(answer.id, 1);
        assert_eq!(answer.action, None);
        assert!(answer.dismissed, "它是被新的一张顶掉的，不是用户回答的");
        assert_eq!(overlay.pending_count(), 0, "顶掉之后不该留下那条等待");

        // 被顶掉之后它就不再是"正在显示的那一张"了
        assert_eq!(overlay.popover.lock().unwrap().current, Some(2));
    }

    /// 光标处的卡片要让开光标，且**不许跑出工作区**。
    #[test]
    fn a_card_at_the_cursor_stays_inside_the_work_area() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };

        // 屏幕正中：贴在光标右下（让开光标压着的那个词）
        assert_eq!(
            place(area, (420, 220), Some((900, 500)), PopoverAnchor::Cursor),
            (912, 516)
        );

        // 右下角：拉回工作区内，而不是跑到屏幕外
        let (x, y) = place(area, (420, 220), Some((1910, 1030)), PopoverAnchor::Cursor);
        assert_eq!((x, y), (1500, 820));

        // 左上角：光标在原点附近时也不许出现负坐标
        let (x, y) = place(area, (420, 220), Some((0, 0)), PopoverAnchor::Cursor);
        assert!(x >= 0 && y >= 0, "实际：({x}, {y})");

        // 副屏：工作区整个带偏移，钳制必须按那一块算
        let second = WorkArea {
            x: -1920,
            y: -200,
            width: 1920,
            height: 1080,
        };
        let (x, y) = place(second, (420, 220), Some((-1910, -190)), PopoverAnchor::Cursor);
        assert!(x >= -1920 && y >= -200, "实际：({x}, {y})");
    }

    /// 「正中」与"光标拿不到"都落到正中。
    #[test]
    fn a_centered_card_is_centered_and_a_missing_cursor_falls_back_to_it() {
        let area = WorkArea {
            x: 100,
            y: 50,
            width: 1000,
            height: 800,
        };

        let centered = place(area, (400, 200), Some((0, 0)), PopoverAnchor::Center);
        assert_eq!(centered, (100 + 300, 50 + 300));

        // 光标拿不到时回退到正中，而不是原点
        assert_eq!(place(area, (400, 200), None, PopoverAnchor::Cursor), centered);
    }

    /// 卡片比工作区还大时，坐标钉在工作区原点，不许出现负值。
    #[test]
    fn a_card_larger_than_the_screen_pins_to_the_origin() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 300,
            height: 200,
        };
        assert_eq!(
            place(area, (420, 220), Some((0, 0)), PopoverAnchor::Cursor),
            (0, 0)
        );
        assert_eq!(place(area, (420, 220), None, PopoverAnchor::Center), (0, 0));
    }

    /// 只有"窗口正在显示的那一个请求"才有资格收起窗口。
    ///
    /// 没有这条判据，一次迟到的卡片回答会把此后显示在同一窗口上的对话框一起
    /// 关掉 —— 而对话框那一侧看起来完全正常。
    #[test]
    fn only_the_request_that_is_showing_may_dismiss_the_window() {
        let overlay = Overlay::new();
        assert!(!overlay.take_showing(5), "什么都没显示时不该有人能收起窗口");

        overlay.mark_showing(5);
        assert!(!overlay.take_showing(6), "别的请求不许收起窗口");
        assert!(overlay.take_showing(5), "正在显示的那一个可以");
        assert!(!overlay.take_showing(5), "清掉之后就不能再收一次");
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
