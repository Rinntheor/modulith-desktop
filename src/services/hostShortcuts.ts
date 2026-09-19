// src/services/hostShortcuts.ts
//
// 宿主内置快捷键的注册。
//
// **这个文件此前不存在，而这就是问题所在。** `shortcutRegistry.ts` 把整套机制
// 写好了（解析、规范化、冲突检测、按来源注销），`useGlobalShortcuts` 也早就把
// 键盘事件交给它处理 —— 但**从来没有人往里注册任何东西**。注册表恒为空，
// `handleShortcutEvent` 遍历零个条目后返回 false，于是 Ctrl+K / Ctrl+W /
// Ctrl+Tab / Ctrl+1..9 全部没有反应。
//
// 更能说明问题的是：`useGlobalShortcuts` 的注释里逐条列出了这些组合，
// `tabStore` 的 `activateRelativeTab` / `activateTabAt` 也明确写着「供 Ctrl+Tab /
// Ctrl+数字 使用」—— 也就是说**意图在各处都写清楚了，只有那一步接线没做**。
// 注释描述了一个不存在的实现，比没有注释更糟。
//
// 组合的选择与浏览器一致（理由见 useGlobalShortcuts 的说明）：WebView2 里这些
// 组合不会绑到窗口行为，不拦就完全没有反应。

import { registerShortcuts } from './shortcutRegistry';
import { requestSearchFocus } from './searchFocus';
import { activateRelativeTab, activateTabAt, closeActiveTab, toggleSplit } from './tabStore';
import { toggleSidebar } from './sidebarBridge';
import { toggleFullscreen } from './fullscreenBridge';

/**
 * 注册宿主内置快捷键。
 *
 * 幂等：同 ID 重复注册视为更新（`registerShortcut` 会先摘掉旧条目），
 * 因此 StrictMode 下的双次执行不会留下重复项。
 */
export function registerHostShortcuts(): void {
  const definitions = [
    {
      id: 'host:focus-search',
      combo: 'mod+k',
      description: '聚焦全局搜索',
      allowInInput: true,
      run: () => requestSearchFocus(),
    },
    {
      id: 'host:close-tab',
      combo: 'mod+w',
      description: '关闭当前标签',
      allowInInput: true,
      // 关的是**焦点组**里的激活标签：分屏后用户可能正在右半工作，
      // 固定关左边那个会让他以为关错了。
      run: () => closeActiveTab(),
    },
    {
      id: 'host:toggle-sidebar',
      combo: 'mod+b',
      description: '显示 / 隐藏侧边栏',
      allowInInput: true,
      // 侧边栏的开关状态在 SidebarContext 里，而快捷键注册发生在 React 树之外
      // （见本文件头）。两者之间由 sidebarBridge 搭桥，而不是把 Context 也搬进来 ——
      // 一个挂在 window 上的监听器不该持有 React 状态。
      run: () => toggleSidebar(),
    },
    {
      id: 'host:next-tab',
      combo: 'mod+tab',
      description: '下一个标签',
      allowInInput: true,
      run: () => activateRelativeTab(1),
    },
    {
      id: 'host:prev-tab',
      combo: 'mod+shift+tab',
      description: '上一个标签',
      allowInInput: true,
      // 注意是 -1：`activateRelativeTab` 对负数做了取模回绕
      run: () => activateRelativeTab(-1),
    },
    {
      id: 'host:toggle-split',
      // 反斜杠在这里是**普通字符**（`parseCombo` 按 `+` 切分），与编辑器里的
      // 分屏习惯一致。
      combo: 'mod+\\',
      description: '把当前标签搬去分屏（再按一次收回）',
      allowInInput: true,
      // 未分屏时**搬走焦点组的当前标签**，而不是替他挑一个别的：用户按这个键时
      // 想的是"把我在看的这个挪到旁边"。搬走后左边落到它的邻居上，那是搬走的
      // 必然结果，不是副作用。
      run: () => toggleSplit(),
    },
    {
      id: 'host:toggle-fullscreen',
      // F11 与浏览器一致。`matchesCombo` 比较的是 `event.key`，它的取值是 "F11"，
      // 小写化之后正好是 `f11`。
      combo: 'f11',
      description: '切换全屏',
      allowInInput: true,
      // 全屏状态活在前端（进全屏要同时隐藏标题栏），因此经 fullscreenBridge 转发，
      // 而不是在这里直接调 Tauri —— 否则会出现「窗口全屏了、标题栏还在」。
      run: () => toggleFullscreen(),
    },
  ];

  // Ctrl+1..9 → 第 n 个标签。`activateTabAt` 从 0 开始，序号不足时返回 false
  // （静默忽略比报错合适：用户按 Ctrl+9 而只开着两个标签是常态）
  for (let n = 1; n <= 9; n += 1) {
    definitions.push({
      id: `host:tab-${n}`,
      combo: `mod+${n}`,
      description: `跳到第 ${n} 个标签`,
      allowInInput: true,
      run: () => activateTabAt(n - 1),
    });
  }

  registerShortcuts(definitions);
}
