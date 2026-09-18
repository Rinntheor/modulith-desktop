// src/services/searchFocus.ts
//
// 「把焦点交给搜索框」的请求通道。
//
// 为什么用 DOM 事件而不是状态或 Context：触发方是全局快捷键（一个挂在 window 上的
// 监听器，不在 React 树内），接收方是标题栏里的搜索框组件。让快捷键去持有搜索框的
// ref 会引入跨组件的命令式耦合，而用一个导出的事件名最省事，也最容易被读懂。
//
// 只有一个事件名，没有载荷 —— 请求的内容永远是「聚焦搜索框并全选已有内容」。

export const FOCUS_SEARCH_EVENT = 'modulith:focus-search';

/** 请求把焦点交给全局搜索框（由 Ctrl+K 触发） */
export function requestSearchFocus(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT));
}
