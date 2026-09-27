// src-tauri/src/core/window.rs
//
// 取主窗口。**宿主自己的代码一律走这里。**
//
// ============================================================
// 为什么不能直接用 `Manager::get_webview_window`
// ============================================================
//
// `get_webview_window(label)` 在返回之前会再判一次 `is_webview_window()`，而那个判据是
// "这个窗口下的**所有** webview 的标签都等于窗口标签"。只要窗口里多出一个 webview
// —— 沙箱插件的界面就是 —— 它就变成 false，于是 `get_webview_window` 返回 `None`。
//
// 它的症状完全不像"取不到窗口"：
//
//   * 关闭按钮点了没反应（关闭行为那条路径找不到窗口）；
//   * 隐藏到托盘之后，托盘再也叫不回窗口；
//   * 内存等级设不上。
//
// 而日志里只有孤零零的一句"找不到主窗口"。实测撞到过一次 —— 装上第一个沙箱插件
// 之后，点关闭就再也回不来了。
//
// ============================================================
// 为什么放在 core 而不是沙箱模块里
// ============================================================
//
// 因为它与沙箱无关：**任何**让主窗口拥有第二个 webview 的改动都会踩到它。
// 放在沙箱旁边会让下一个人以为"这是插件的事"。
//
// `pnpm check:sandbox` 有一条断言：宿主源码里不许再出现 `get_webview_window`。

use tauri::{AppHandle, Manager, Runtime, Webview, Window};

/// 主窗口标签
pub const MAIN_WINDOW: &str = "main";

/// 按标签取窗口 —— 只需要窗口能力（显示、隐藏、聚焦、居中、监听窗口事件）时用这个。
pub fn get<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<Window<R>> {
    app.get_window(label)
}

/// 主窗口。等价于 `get(app, MAIN_WINDOW)`。
pub fn main<R: Runtime>(app: &AppHandle<R>) -> Option<Window<R>> {
    get(app, MAIN_WINDOW)
}

/// 按标签取 webview —— 需要 webview 专有能力（`with_webview`）时用这个。
pub fn webview<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<Webview<R>> {
    app.get_webview(label)
}

/// 主窗口的 webview。等价于 `webview(app, MAIN_WINDOW)`。
pub fn main_webview<R: Runtime>(app: &AppHandle<R>) -> Option<Webview<R>> {
    webview(app, MAIN_WINDOW)
}
