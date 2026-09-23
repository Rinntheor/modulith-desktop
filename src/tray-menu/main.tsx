// src/tray-menu/main.tsx
//
// 托盘菜单窗口的入口。
//
// ============================================================
// 这是一个**独立窗口**，不是一个浮层
// ============================================================
//
// 它有自己的 HTML 入口（`tray-menu.html`）与自己的 React 根。理由：
//
//   · 主窗口可能已被隐藏到托盘，那时它根本不在屏幕上，无法承载这个菜单；
//   · 它需要无边框、透明、始终置顶 —— 这些是**窗口**属性，不是 CSS 能表达的。
//
// 因此这里是第二个 Vite 入口。漏掉 `vite.config.ts` 里的多入口配置时，
// 开发模式一切正常（Vite 按 URL 提供任意 HTML），而**发布版里这个窗口是空白的**。
//
// ============================================================
// 它只做两件事
// ============================================================
//
//   1. 画菜单（本文件 + TrayMenu.tsx）；
//   2. 把点击转成一次 `invoke('tray_menu_action', ...)`。
//
// 它**不自己执行任何动作**：隐藏窗口、打开设置、检查更新、回收内存、退出 ——
// 全部由后端分派。理由很实际：这些动作里有几条要操作主窗口，而那是后端才知道
// 怎么做的事（窗口可能不存在、可能被隐藏、可能在另一个显示器上）。
// 让这个只有 200 多像素宽的小窗口去协调那些，是把状态放到了错误的地方。
//
// 用户可见的后果是好的：这个窗口没有任何"业务状态"，它甚至不需要知道主窗口
// 现在是什么样子。

import React from 'react';
import ReactDOM from 'react-dom/client';

import TrayMenu from './TrayMenu';
import '@styles/global/index.css';

const container = document.getElementById('tray-menu-root');
if (!container) {
  // 入口 HTML 被改坏时如实抛错，而不是静默什么都不做 ——
  // 后者表现为"点了托盘图标，菜单窗口弹出来了，但是全白"，很难归因。
  throw new Error('tray-menu.html 缺少 #tray-menu-root 容器');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <TrayMenu />
  </React.StrictMode>
);
