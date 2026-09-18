// src/services/sidebarBridge.ts
//
// 侧边栏开关的「桥」。
//
// 为什么需要它：侧边栏的开关状态（`isOpen` / `isCollapsed`）活在 `SidebarContext`
// 里，而快捷键的注册与派发发生在 React 树之外 —— `useGlobalShortcuts` 是一个挂在
// `window` 上的监听器，它在 React 组件生命周期之外运行，读不到 Context。
//
// 两条路可选：
//
//   1. 把整个 Context 搬进这个模块，让 React 组件也读这里；
//   2. 让 Provider 注册一个「执行函数」，快捷键调用它。
//
// 这里选 2。理由与 `searchFocus.ts` 用 DOM 事件而不是持有 ref 是同一个：
// **一个挂在 window 上的监听器不该持有 React 状态**，否则「谁是事实来源」就变得
// 模糊 —— Context 仍然是唯一的事实来源，这里只是一个转发口。
//
// 注意这不是第二份状态：它存的是函数，不存值。真值始终在 Provider 里。

type ToggleFn = () => void;

let handler: ToggleFn | null = null;

/**
 * 由 `SidebarProvider` 在挂载时登记开关函数。
 *
 * 返回注销函数：Provider 卸载（例如一次刷新导致重挂载）时必须摘掉，
 * 否则这里会留着一个指向已卸载组件的闭包 —— 它操作的是旧的 state。
 */
export function registerSidebarToggle(fn: ToggleFn): () => void {
  handler = fn;

  return () => {
    // 只在仍指向自己时才清空：重挂载期间新的登记可能已经覆盖了 handler，
    // 此时旧的注销函数不该把新的那个抹掉。
    if (handler === fn) handler = null;
  };
}

/**
 * 切换侧边栏显示状态。
 *
 * 尚未登记（例如首次渲染之前）时静默忽略 —— 与 `tabStore` 里「序号不足时返回
 * false」同样的取舍：用户按了没有反应，比因为一个尚不存在的界面状态而抛错好。
 */
export function toggleSidebar(): void {
  handler?.();
}
