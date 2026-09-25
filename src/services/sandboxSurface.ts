// src/services/sandboxSurface.ts
//
// 沙箱插件界面的前端门面。
//
// ============================================================
// 为什么需要这一层，而不是让插件自己在页面里画
// ============================================================
//
// 沙箱插件的界面是一个**独立的 webview**，不是 DOM 节点。因此它：
//
//   * **盖在 DOM 之上** —— 宿主自己的浮层（设置、通知、右键菜单）会被它挡住，
//     除非我们在浮层出现时把它收起来；
//   * **不随 DOM 走** —— 宿主滚动内容、折叠侧边栏、拖动分屏时它都停在原地，
//     位置只能由前端量出来再告诉宿主。
//
// 前端的职责因此是两件：**在正确的时候量出正确的矩形**，以及**在正确的时候
// 让它可见或不可见**。矩形由前端给而不是宿主自己算，是因为只有前端知道标签栏、
// 分屏、侧边栏当前各占多少；宿主再实现一遍布局，两份一定会漂。
//
// ============================================================
// 四条命令的分工
// ============================================================
//
//   `open`    建（不存在就建）+ 显示 + 摆正。**幂等**：切标签回来走的就是它。
//   `hide`    **只隐藏，不销毁。** 切标签、宿主浮层盖上来时走它。
//   `bounds`  只摆放。滚动、缩放、折叠走它，调用频率最高，因此不做任何别的事。
//   `close`   销毁。只在模块真的卸载时走它。
//
// `hide` 与 `close` 分开是刻意的：重新显示几乎是瞬时的，而重新创建要重走一遍
// WebView2 控制器创建（几百毫秒），插件自己的界面状态也会一起丢掉。切标签是
// 高频操作，让它付"重建"的代价是不可接受的。
//
// ============================================================
// 为什么这些命令在后端必须是 async
// ============================================================
//
// 因为它们最终会创建 / 摆弄 / 销毁真实 webview，而那件事**不能在主线程上做**
// —— 在 IPC 回调里同步创建 webview 会让整个应用假死（窗口按钮、托盘、其余插件
// 一起失去响应，且一处错误都不报）。完整推导见 src-tauri/src/modules/plugins/
// surface.rs 的文件头。前端这一侧看不出区别，但顺序与返回时机都建立在它之上。

import { invoke } from '@tauri-apps/api/core';

/** 内容区在窗口客户区里的位置与尺寸（逻辑像素） */
export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 建（不存在就建）+ 显示 + 摆到给定矩形。
 *
 * **已经开着时是"重新显示并摆放"，不是错误** —— 切换标签再切回来会走到这条路径。
 * 宿主那一侧按这个语义实现（见 `sandbox::open_surface_at` 与 `surface.rs`）。
 */
export function openSandboxSurface(pluginId: string, bounds: SurfaceBounds): Promise<void> {
  return invoke('sandbox_surface_open', { pluginId, bounds });
}

/**
 * 隐藏但**不销毁**。没开着时静默成功。
 *
 * 这条是本轮新增的：在这之前，"不可见"只能靠 `close` 表达 —— 于是每切一次标签
 * 就销毁再重建一个 webview。
 */
export function hideSandboxSurface(pluginId: string): Promise<void> {
  return invoke('sandbox_surface_hide', { pluginId });
}

/** 重新摆放。没打开时静默成功 —— 布局变化时会被无条件调用。 */
export function setSandboxSurfaceBounds(
  pluginId: string,
  bounds: SurfaceBounds
): Promise<void> {
  return invoke('sandbox_surface_bounds', { pluginId, bounds });
}

/**
 * 销毁。**没开着时也静默成功。**
 *
 * 这一条很重要：前端在卸载、隐藏、切换标签时都会调用它，把"本来就没开"当成错误
 * 会在日志里堆出一片没有信息量的噪声 —— 而噪声会让人连真的错误一起忽略。
 */
export function closeSandboxSurface(pluginId: string): Promise<void> {
  return invoke('sandbox_surface_close', { pluginId });
}

/**
 * 运行沙箱自检（诊断用，与具体插件无关）。
 *
 * 它在一个**真实**的插件 webview 里把四条边界各跑一次：ACL 是否真的拒绝、身份是否
 * 真的来自浏览器引擎、自定义协议是否可用、CSP 是否真的生效。结果画在面板上，
 * 同时写进日志。
 *
 * 它**不随应用启动自动运行** —— 由「插件」页上的按钮触发。理由见
 * `src-tauri/src/modules/plugins/sandbox.rs` 的 `open_selftest`。
 */
export function runSandboxSelfTest(): Promise<void> {
  return invoke('sandbox_self_test');
}
