//./src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import Router from './router/Router';
import BootGate from './components/boot/BootGate';
import ThemeProvider from './components/ThemeProvider';
import AppErrorBoundary from './components/AppErrorBoundary';
import { installGlobalErrorHandlers } from './services/globalErrorHandlers';
import "@styles/global/index.css";

/*
 * 关于「启动首帧」：
 *
 * index.html 里只做了底色预置（把 WebView 默认的白底刷成正确的主题色），
 * 不渲染任何界面元素。启动加载界面由 BootGate 在运行期渲染的 BootScreen
 * 唯一提供 —— 这样一次启动只出现一套加载指示器。
 *
 * 这里以前还有一段 MutationObserver 逻辑，用来在 React 提交首帧后摘掉
 * index.html 中的静态启动骨架。骨架已经删除，那段逻辑随之移除：
 * 留着它只会让读者以为还存在两套加载界面。
 *
 * 全局错误兜底要尽早装：它负责捕获错误边界管不到的那类错误
 * （事件处理器、定时器、未处理的 Promise 拒绝）。见该模块的说明。
 */
installGlobalErrorHandlers();

const rootElement = document.getElementById("root") as HTMLElement;

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* 根级错误边界：最外层，任何未被下层接住的渲染错误都在这里兜底 */}
    <AppErrorBoundary>
      {/* 主题与动效开关：必须在 BootGate 外层，启动/授权界面也要受它约束 */}
      <ThemeProvider>
        {/* 启动门禁：完成真实初始化（设置 → 授权 → 模块 → 插件 → 预热）后才挂载应用 */}
        <BootGate>
          <Router />
        </BootGate>
      </ThemeProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
