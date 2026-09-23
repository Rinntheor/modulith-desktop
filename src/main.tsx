//./src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import Router from './router/Router';
import BootGate from './components/boot/BootGate';
import NetPromptLayer from './components/NetPromptLayer';
import ThemeProvider from './components/ThemeProvider';
import AppErrorBoundary from './components/AppErrorBoundary';
import { installGlobalErrorHandlers } from './services/globalErrorHandlers';
import { installMemoryLevelPolicy } from './services/memoryLevel';
import { subscribeBackendNotificationEvents } from './services/notifications';
import { primeSound } from './services/sound';
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

/*
 * 提示音的解锁监听也要尽早装。
 *
 * WebView 的自动播放策略要求音频上下文在有用户交互之后才能出声。这个监听只是
 * 在 `document` 上挂一次 pointerdown / keydown，代价接近零；装得越早，解锁
 * 机会越多 —— 解锁界面上的那次输入按键就能把它解开。
 * 音频上下文本身仍然是**第一次真的要响时才创建**：启动过程中建一个 AudioContext
 * 会让它一直占着音频设备，而绝大多数启动根本不会产生通知。
 */
primeSound();

/*
 * 内存目标等级的策略要尽早装。
 *
 * 窗口被最小化、隐藏到托盘、切到后台时，WebView2 并不知道"现在没人看你"，
 * 于是那几百 MB 一直挂着。这个监听把这些时刻翻译成"请降到 Low"。
 *
 * 挂在**这里**而不是某个组件里，有两个理由：
 *   1. 它不是界面的行为，而是整个应用生命周期的一部分 —— 解锁界面上就该生效；
 *   2. 它必须早于窗口第一次显示，否则启动期那一次隐藏会被漏掉。
 *
 * 策略本身（为什么只认可见性、为什么不认失焦）见该模块的文件头。
 */
installMemoryLevelPolicy();

/*
 * 订阅后端的"通知列表变了"事件。
 *
 * 在它之前，**后端产生一条通知时前端完全不知道** —— 前端只在自己调用通知命令
 * 之后才刷新缓存。于是任何不是由界面发起的通知（后台宿主的定时提醒、启动阶段
 * 的插件加载失败）都不会出现在通知中心里：它已经落盘、未读数也算上了，
 * 但铃铛徽标不变、列表里也看不到。
 *
 * 装在最外层而不是某个组件里：通知中心可能还没挂载（启动阶段、解锁界面），
 * 而徽标与浮层都要能看到新通知。
 *
 * 它是异步的，因此这里不 await —— 订阅失败只记一条警告，不该挡住启动。
 */
void subscribeBackendNotificationEvents();

const rootElement = document.getElementById("root") as HTMLElement;

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* 根级错误边界：最外层，任何未被下层接住的渲染错误都在这里兜底 */}
    <AppErrorBoundary>
      {/* 主题与动效开关：必须在 BootGate 外层，启动/授权界面也要受它约束 */}
      <ThemeProvider>
        {/*
          出站询问（「默认询问」档）。
          
          刻意放在 BootGate **外面**：出站请求可能发生在启动阶段（自动检查更新）
          与解锁界面上，那时 Home 还没挂载 —— 挂在里面会让那些请求无人可问，
          只能在超时后按拒绝处理。它自己会订阅后端的事件，没有询问时不渲染任何东西。
        */}
        <NetPromptLayer />
        {/* 启动门禁：完成真实初始化（设置 → 授权 → 模块 → 插件 → 预热）后才挂载应用 */}
        <BootGate>
          <Router />
        </BootGate>
      </ThemeProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
