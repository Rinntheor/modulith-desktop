// src/services/fullscreenBridge.ts
//
// 全屏开关的「桥」。
//
// 为什么需要它：全屏状态活在 `Home` 的 React state 里（窗口是否全屏、要不要隐藏
// 标题栏），而 `F11` 的注册与派发发生在 React 树之外 —— `useGlobalShortcuts` 是
// 一个挂在 `window` 上的监听器，读不到 Context 也读不到组件的 state。
//
// **为什么不直接让快捷键去调 Tauri 的 `setFullscreen`：** 进入 / 退出全屏必须
// *同时*更新界面（隐藏标题栏与二级标题栏、内容区上沿归零）。如果让快捷键自己操作
// 窗口，界面那一半就没人管了，结果是「窗口全屏了、标题栏还在」。真值只有 `Home`
// 的 state 知道，因此这里转发一个函数而不是一个值 —— 与 `sidebarBridge` 同一取舍。

type ToggleFn = () => void;

let handler: ToggleFn | null = null;

/**
 * 由 `Home` 在挂载时登记全屏切换函数。
 *
 * 返回注销函数：卸载（例如一次刷新导致重挂载）时必须摘掉，否则这里会留着指向已
 * 卸载组件的闭包 —— 它操作的是旧的 state。
 */
export function registerFullscreenToggle(fn: ToggleFn): () => void {
  handler = fn;

  return () => {
    // 只在仍指向自己时才清空：重挂载期间新的登记可能已经覆盖了 handler
    if (handler === fn) handler = null;
  };
}

/**
 * 切换全屏。
 *
 * 尚未登记（首次渲染之前）时静默忽略 —— 与 `sidebarBridge.toggleSidebar` 同一
 * 取舍：用户按了没反应，比因为一个还不存在的界面状态抛错好。
 */
export function toggleFullscreen(): void {
  handler?.();
}
