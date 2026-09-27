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
import { subscribePluginEvents } from './services/backgroundPlugins';
import { installPluginThemeSync } from './services/pluginThemeSync';
import { installPluginShortcutSync } from './services/pluginShortcutSync';
import { installPluginSurfaceRequests } from './services/pluginSurfaces';
import { installPluginUiState } from './services/pluginUiState';
import { installPluginCommandDispatch, installPluginDownloadProgress } from './services/pluginRuntime';
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

/*
 * 订阅宿主的"跨插件事件"广播。
 *
 * 后台插件（它们跑在各自的 Node 进程里）发出的 `ctx.events.emit` 会由宿主同时
 * 送往后台侧与**界面侧**。界面侧这一半必须有人接进事件总线 —— 否则 in-process
 * 与沙箱界面插件收不到后台插件发出的事件，而那看起来像"某个插件的订阅没生效"。
 *
 * 与通知订阅同样的理由装在最外层：插件界面可能还没挂载。
 *
 * 拉起后台插件**不在这里**：那要等插件列表读完（BootGate 之后），
 * 见 `BootGate` 里对 `syncBackgroundPlugins` 的调用。
 */
void subscribePluginEvents();

/*
 * 把宿主的主题推给插件系统，并在每次主题变化时再推一次。
 *
 * 装在最外层并且**立刻推一次**：插件可能在主题变化之前就被打开，而它的入口
 * 文档依赖宿主已经收到过快照 —— 晚一步的表现在深色主题下是一次白闪。
 *
 * 主题的真源在宿主文档里（CSS 自定义属性），Rust 那一侧读不到，因此方向只能是
 * 前端推上去。见 `pluginThemeSync` 的文件头。
 */
installPluginThemeSync();

/*
 * 让宿主的快捷键在插件界面里也生效。
 *
 * 焦点落进插件的 webview 之后，keydown 只在**插件自己的文档**里派发 ——
 * 宿主窗口上的监听器收不到，于是 Ctrl+K / Ctrl+W / Ctrl+Tab 在插件里全都
 * 没有反应，而在宿主里是好的。插件那一侧的桥接层接住并转发回来，这里负责执行。
 */
installPluginShortcutSync();

/*
 * 接住插件请求打开 / 关闭**界面**的广播（`ctx.ui.openSurface` / `closeSurface`）。
 *
 * 方向是反的：这两条由插件发起、由前端执行。原因只有一个 —— **只有前端知道
 * 界面该放在哪**（标签栏多高、侧边栏是否展开、分屏开没开）。宿主那一侧建 webview
 * 就只能自己猜一个矩形，而猜出来的界面会漂在某个不对的地方。
 *
 * 因此插件调 `ui.openSurface('detail')` 之后发生的是：宿主广播 → 这里开一个标签
 * → 标签里的占位量出矩形 → 宿主把 webview 摆过去。**位置由宿主决定，插件只说
 * 要哪一个界面。** 见 `pluginSurfaces.ts` 的文件头。
 */
installPluginSurfaceRequests();

/*
 * 接住插件说的"我现在是这个状态"：徽标、进度、启动占位。
 *
 * 这三样**只能由宿主画**。徽标与进度在宿主的侧边栏 / 标签栏上，插件文档碰不到；
 * 启动占位要盖在插件那块 iframe 上面 —— 两者都是普通 DOM，一个 `z-10` 就够，
 * 由 `SandboxSurface` 渲染。
 *
 * 装在最外层：插件可能在界面挂载之前就报出状态（`onStartup` 里跑索引），
 * 而那时丢掉的那一条会让徽标永远停在旧值。
 */
installPluginUiState();

/*
 * 接住宿主请求执行某条**插件命令**的广播。
 *
 * 触发点在 Rust 那边：`ctx.ui.contextMenu` 里选中一条清单声明的条目时，浮层是
 * 宿主显示并等待回答的，因此"有人选了哪一条"只有 Rust 知道。而 in-process 插件的
 * 命令处理器是宿主这个 realm 里的函数 —— Rust 碰不到，只能广播回来。
 *
 * 沙箱插件不走这条路：它的命令由宿主直接推进它的界面（`sandbox::deliver_command`）。
 */
installPluginCommandDispatch();

/*
 * 接住 in-process 插件的**下载进度**。
 *
 * 沙箱插件的进度由宿主直接推进它的界面（回调在另一个 realm 里）；in-process
 * 插件的回调就在宿主这个 realm —— 而"这次下载是谁发起的"只有前端知道
 * （`ctx.http.download` 是前端发起的）。因此那张表也由这里持有。
 */
installPluginDownloadProgress();

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
