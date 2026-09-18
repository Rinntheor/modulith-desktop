// src/hooks/useGlobalShortcuts.ts
//
// 安装全局快捷键监听。
//
// 这个 Hook 现在只做一件事：把键盘事件交给快捷键注册表。具体有哪些组合、谁注册的、
// 优先级如何，全部在 `services/shortcutRegistry.ts` 里 —— 之前这里是写死的一串
// if-else，插件无法贡献快捷键，也无从查询某个组合是否已被占用。
//
// 宿主内置组合在 `registerHostShortcuts()` 中注册：
//
//   Ctrl+K         聚焦全局搜索        在任何地方都生效（含输入框内）
//   Ctrl+W         关闭当前标签
//   Ctrl+B         显示 / 隐藏侧边栏
//   Ctrl+Tab       下一个标签
//   Ctrl+Shift+Tab 上一个标签
//   Ctrl+1..9      跳到第 n 个标签
//
// 不注册 Ctrl+T（新建标签）：这里没有「空白页」概念，标签只能来自具体模块。
// 也不注册 Ctrl+N 之类由窗口或系统管理的组合。
//
// 为什么必须拦下这些组合而不是留给 WebView：WebView2 里 Ctrl+W 不会被绑定到
// 关窗口（否则用户会误关应用），Ctrl+Tab 也不会切换任何东西 —— 不拦就完全没有反应。

import { useEffect } from 'react';
import { handleShortcutEvent } from '../services/shortcutRegistry';

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      handleShortcutEvent(event);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
