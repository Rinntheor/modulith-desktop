// src/overlay/main.tsx
//
// 宿主浮层窗口的入口。
//
// ============================================================
// 这个窗口存在的两条理由
// ============================================================
//
//   1. **层级**：沙箱插件的界面是一个原生子 webview，它在窗口里的层级高于宿主
//      文档的任何 DOM 元素。宿主页面里画出来的浮层会被它整个盖住，z-index
//      写多大都没用 —— 那不是样式问题，是两套渲染层的顺序问题。
//   2. **外观**：让插件自己画对话框等于让它**冒充宿主界面**（一个长得和系统
//      确认框一模一样的提示框，用来骗用户点"允许"）。由宿主渲染之后，插件能
//      决定的只有「问什么」，不能决定「长什么样」。
//
// ============================================================
// 它只做两件事
// ============================================================
//
//   1. 画内容（对话框或菜单）；
//   2. 把用户的选择转成一次 `invoke('overlay_respond', ...)` 并请求隐藏。
//
// 它**不执行业务动作**：插件问的那个问题、以及拿到回答之后做什么，都在插件
// 那一侧。这个窗口既不知道是哪个插件在问，也不需要知道 —— 那正是它不该知道的事。

import React from 'react';
import ReactDOM from 'react-dom/client';

import OverlayRoot from './OverlayRoot';
import { primeAccentFromDocument } from '../services/accent';
import '@styles/global/index.css';

// 配色**调用宿主自己的服务**，而不是在这里再抄一份算法。
//
// tray-menu.html 里那份内联副本已经是第二份了；再加一份，就等于每改一次配色
// 要记得改三个地方，而漏改的表现是"这个窗口的颜色与主界面不一致"。
primeAccentFromDocument();

const container = document.getElementById('overlay-root');
if (!container) {
  // 入口 HTML 被改坏时如实抛错，而不是静默什么都不做 ——
  // 后者表现为"插件弹了个对话框，窗口弹出来了，但是一片空白"，很难归因。
  throw new Error('overlay.html 缺少 #overlay-root 容器');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <OverlayRoot />
  </React.StrictMode>
);
