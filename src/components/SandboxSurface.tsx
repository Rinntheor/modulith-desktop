// src/components/SandboxSurface.tsx
//
// 沙箱插件界面的**占位与定位**。
//
// ============================================================
// 它在做一件不太常见的事
// ============================================================
//
// 插件界面不是这个 DOM 树里的一部分 —— 它是宿主在**这个窗口里另开的一个 webview**，
// 浮在所有 DOM 之上。这个组件因此只做三件事：
//
//   1. 占住内容区（一块位置正确的空地）；
//   2. 把这个空地的矩形量出来交给 Rust；
//   3. **在它不该被看见时让它消失** —— 原生 webview 不看 CSS，宿主的
//      `display: none` / `visibility: hidden` 对它一点作用都没有。
//
// 第 3 条是最容易漏的一条：标签切走只是让 React 不再渲染这一块，而那块 webview
// 仍然悬在界面上。所以"可见性"必须被显式处理。
//
// ============================================================
// 什么时候该消失：三种，而且是三个不同的信号
// ============================================================
//
//   * **标签切走 / 窗口收起** —— `useModuleActive()`。
//     它已经把"窗口最小化或隐藏到托盘"算进去了（`document.visibilityState`）。
//   * **宿主自己的浮层盖上来** —— 设置面板、通知、右键菜单落在内容区之上时，
//     原生 webview 会**盖住它们**（它是绘制在 DOM 之上的）。这时必须让位。
//   * **模块被卸载** —— 那时不再隐藏，而是销毁。隐藏留着是有上限的，
//     否则切过的每个插件都会留下一个渲染进程。
//
// 前两种走"隐藏"，最后一种走"销毁"。区别是刻意的：隐藏几乎瞬时，而重新创建
// 要重走一遍 WebView2 控制器创建（几百毫秒），插件自己的界面状态也会丢掉。
//
// ============================================================
// 第二类信号为什么用几何判断，而不是去订阅每个浮层
// ============================================================
//
// 宿主的浮层分散在很多地方（设置面板、通知、各模块自己的对话框、将来的命令面板），
// 而且以后还会有新的。逐个接线意味着**每加一个浮层都要记得回来改这里一次**，
// 而漏掉的那一次不会有任何报错 —— 只是插件界面盖在那个浮层上面，看起来像"浮层
// 坏了"。这种"要求未来的人记得做一件看不出后果的事"的设计，早晚会失效。
//
// 所以这里反过来问一个几何问题：**这个占位块的中心点，现在最上面是谁？**
//
//   * 返回占位块自己 → 没人盖着它 → 可以让插件界面露出来；
//   * 返回别的东西 → 有东西盖在它上面 → 收起来。
//
// 它对"将来新增的浮层"自动生效，不需要任何人记得回来改。代价写在下面的
// "已知的限制"里。
//
// ============================================================
// 已知的限制（不要在文档里把这几条说成已解决）
// ============================================================
//
//   * **只看中心点。** 浮层只盖住一角时不会被发现。要看整块矩形需要在若干个点上
//     采样，而那会把每帧的判据变复杂 —— 现在的取舍是"宁可晚一点让位，
//     也不要因为一个边角上的提示条把整个插件界面闪掉"。
//   * **`pointer-events: none` 的浮层看不见。** 几何判断用的是命中测试，
//     而命中测试看不见不接收指针的元素。这类浮层很罕见，且加一个
//     `pointer-events: auto` 的包裹层即可被发现。
//   * **它不随内容滚动，而是钉在内容视口上。** 它占的是标签面板的**可见区域**，
//     不是可滚动内容的高度 —— 宿主内容往下滚，它不动。写长页面的插件应当把
//     滚动放在自己的 WebView 里（它有自己的滚动条）。
//     这是刻意的，不是没做完：一个跟着内容滚的原生层会与 DOM 的合成时机打架，
//     而"视口内一块固定区域"是一个能被准确表达、也能被准确测出来的东西。

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useModuleActive } from '../hooks/useModuleActive';
import {
  closeSandboxSurface,
  hideSandboxSurface,
  openSandboxSurface,
  setSandboxSurfaceBounds,
  type SurfaceBounds,
} from '../services/sandboxSurface';
import {
  beginHostSplash,
  getPluginSplash,
  subscribePluginUi,
} from '../services/pluginUiState';

interface SandboxSurfaceProps {
  pluginId: string;
  /**
   * 要挂哪一块界面（清单里 `contributes.surfaces[].id`）。
   *
   * 缺省是主界面。**它必须一路传到 Rust**：`sandbox_surface_*` 四条命令都按
   * `(插件 id, 界面 id)` 定位 webview。少了它，同一插件的两个界面会去抢同一条
   * `plugin-<id>` 标签，而宿主侧会把它判成一次显式的标签冲突。
   */
  surface?: string;
}

/**
 * 内容视口的选择器。**这是与宿主布局的契约。**
 *
 * 走 `closest` 而不是量自己的矩形，理由是一次实测：
 *
 *   `Home` 里的结构是
 *     `<section class="lc-tab-panel absolute inset-y-0 overflow-y-auto">`
 *       `<div class="p-8">`                      ← 高度由内容决定
 *         模块
 *
 *   `p-8` 的高度是 `auto`，而沙箱界面在这里渲染的是一个**空** div ——
 *   于是 `h-full`（父元素高度的 100%）解析成 `auto`，高度是 **0**。
 *   实测那次建出来的 webview 是 `2240×1`：宽度对，高度 1 像素。
 *
 * 换成量 `.lc-tab-panel` 就对了：它是 `absolute inset-y-0`，高度确定，
 * 而且它正是"内容视口" —— 也正是这个文件一开始就想量的那个东西。
 *
 * 同一个选择器在 `AllModulesPanel` 里已经用过一次（`closest('.lc-tab-panel')`），
 * 因此它是一条既有的契约，不是这里新发明的。`check:sandbox` 有一条断言盯着
 * 它与 `Home.tsx` 里的类名一致。
 */
const PANEL_SELECTOR = '.lc-tab-panel';

/**
 * 算出插件界面该占的矩形：**内容视口的整块**。
 *
 * **不内缩。** 这里原来会减掉父级 `p-8` 的 2rem 内边距，为的是"与同屏的其它模块
 * 看起来一致"。那个意图是错的：其它模块是一张卡片，四周留白是设计；而插件界面是
 * **一个应用**，它该占满自己那一块，留白由插件自己决定。
 *
 * 实测正是如此：用户报的"存在留白、未全屏"里，40px 来自两个地方 ——
 * 这里的 2rem，加上宿主合成文档里 `<body>` 的默认 8px（那一处已修）。
 *
 * 量不到视口时返回 `null`：**宁可什么都不建，也不要建一个尺寸错误的界面。**
 */
function measureSurface(element: HTMLElement): SurfaceBounds | null {
  const panel = element.closest(PANEL_SELECTOR) as HTMLElement | null;
  if (!panel) return null;

  const rect = panel.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;

  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * 插件界面该占的那块矩形，现在被谁盖着。
 *
 * 判据是"最上面的元素不在内容视口之内"。量不出矩形时返回 `false` ——
 * 那时连界面都建不出来，说"被盖住了"只会给出一个错误的解释。
 */
function isCovered(element: HTMLElement, bounds: SurfaceBounds): boolean {
  const panel = element.closest(PANEL_SELECTOR) as HTMLElement | null;
  if (!panel) return false;

  const top = document.elementFromPoint(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  );
  if (!top) return false;

  // 命中在内容视口之内（占位块、内边距、面板自身）都算没被盖住。
  return !panel.contains(top);
}


/**
 * 两次确认才改判。
 *
 * 一次命中测试可能因为过渡动画中的中间帧而偶然落在别处。改判的代价不是一次
 * 样式变化，而是**隐藏再显示一个原生 webview**，那是一次肉眼可见的闪烁。
 */
const CONFIRMATIONS = 2;

/** 轮询间隔。150ms 是"浮层出现后察觉不到延迟"与"每秒 6 次命中测试"之间的取舍。 */
const POLL_MS = 150;

/**
 * 启动占位的语气 → 文字颜色。
 *
 * 只改文字颜色，不改底色：占位那块底色必须与内容区一致（`bg-white`，深色模式下
 * 由 `dark-theme.css` 覆盖）—— 换一个底色会让它看起来像一块**弹窗**，
 * 而它其实只是"这块位置还没准备好"。
 */
const SPLASH_TONES: Record<string, string> = {
  info: 'text-gray-400',
  warning: 'text-amber-600',
  error: 'text-rose-600',
};

/**
 * 同一条警告只说一次。
 *
 * 遮挡轮询每 150ms 跑一次，量不到视口时若每次都写一行，日志会被同一句话淹掉 ——
 * 而这一条恰恰是**最需要被看见**的那类信号（它意味着宿主布局变了）。
 */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[sandboxSurface] ${message}`);
}

const SandboxSurface: React.FC<SandboxSurfaceProps> = ({ pluginId, surface }) => {
  const holder = useRef<HTMLDivElement>(null);

  // 「标签是否被选中」+「窗口是否可见」。插件界面必须据此出现或消失 ——
  // 原生 webview 不看 CSS，只认我们显式发的指令。
  const active = useModuleActive();

  // 「宿主浮层是否盖在它上面」。判据见 isCovered。
  const [covered, setCovered] = useState(false);

  // 界面 id 的缺省值。**只有这一处**允许把缺省写出来。
  //
  // `SandboxSurface` 是被 `ModuleRenderer` 按描述符渲染的，而描述符来自插件清单 ——
  // 单界面插件根本不写 `surface`。缺省在**四条命令**里也各有一份（Rust 侧），
  // 而这里这一份决定了组件"认为自己在哪一块界面"，两边不一致的话
  // `hide` 会作用在另一块上。
  const surfaceId = surface ?? 'main';

  // 「这块界面是不是还在启动」。为真时宿主自己画一块占位，并把插件的 webview
  // 先收起来（原生 webview 盖在 DOM 之上，不让开的话占位根本看不见）。
  const [splash, setSplash] = useState(() => getPluginSplash(pluginId, surfaceId));
  useEffect(() => subscribePluginUi(() => setSplash(getPluginSplash(pluginId, surfaceId))), [
    pluginId,
    surfaceId,
  ]);

  const visible = active && !covered;

  /**
   * 这块界面**曾经被建出来过**吗。
   *
   * 只用来决定"切标签回来时要不要再立一次启动占位" —— webview 还活着的时候
   * 再闪一次"正在启动"是错的：插件自己的界面状态都还在，它并没有在启动。
   */
  const everOpened = useRef(false);

  /**
   * 把矩形交给宿主。
   *
   * `open` 与 `bounds` 分开：`open` 会走一遍 `PluginManager` 核实插件（读清单），
   * 而 `bounds` 只是摆一下位置。窗口缩放与滚动会高频触发后者，不该每次都去读盘。
   *
   * **这里刻意不做遮挡判断。** 曾经加过一次"被盖住就不打开"，为的是省掉
   * "先闪出来再收回去"的那一帧。那个取舍是错的：遮挡判断是一个**启发式**
   * （只看中心点的命中测试，见 `isCovered`），它一旦误判，代价是
   * **插件界面永远出不来** —— 而省下的只是一帧。
   *
   * 所以这一层永远往"能用"那一侧倒：先打开；如果确实被盖着，轮询会在两次确认
   * 之后（约 300ms）把它收起来。宁可闪一下，不可打不开。
   *
   * `withSplash` 是**启动占位**那条路径：webview 照样要建出来（它的文档要开始
   * 加载，加载完才会把占位撤掉），但先不显示 —— 那块位置这一帧属于宿主画的占位。
   */
  const apply = useCallback(
    (mode: 'open' | 'bounds', withSplash = false) => {
      const element = holder.current;
      if (!element) return;

      const bounds = measureSurface(element);
      if (!bounds) {
        // 量不出来就**什么都不做**。曾经让 0 高度一路走到 `sanitized()`
        // 被夹成 1，结果是建出一个 2240×1 的面板，而症状看起来像"插件坏了"。
        // 一句能指路的警告，比一个尺寸错误的界面有用得多。
        warnOnce(
          `${pluginId}:量不到内容视口（${PANEL_SELECTOR}），先不建界面。` +
            '如果一直这样，说明宿主的内容区布局变了 —— 见 SandboxSurface 的 measureSurface。'
        );
        return;
      }

      const call = mode === 'open' ? openSandboxSurface : setSandboxSurfaceBounds;

      // 失败只记一条日志：界面没建出来不该把整个模块渲染炸掉，
      // 那样用户看到的是一个空白页而不是一条能读的原因。
      call(pluginId, bounds, surfaceId, withSplash ? false : undefined).catch((error) => {
        console.warn(
          `[sandboxSurface] ${pluginId} 的界面${mode === 'open' ? '打开' : '摆放'}失败`,
          error
        );
      });
    },
    [pluginId, surfaceId]
  );

  // ---- 可见性：显示或隐藏（不销毁），以及启动占位 ----
  //
  // ============================================================
  // 一条规则，两个状态
  // ============================================================
  //
  //   * 有占位 → webview **收起来**（那块位置这一帧属于宿主画的占位；
  //     原生 webview 盖在 DOM 之上，不让开的话占位根本看不见）；
  //   * 没占位 → webview **显示出来**并摆正。
  //
  // 只有一条规则是有意的。曾经想过"占位只在第一次打开时出现"，然后给"插件后来
  // 自己立了一块占位"单开一条分支 —— 那条分支的后果是：插件说"我在忙"，而屏幕上
  // 什么都没有（它的占位被自己的 webview 盖住了）。一条规则让那种状态不可能出现。
  //
  // ============================================================
  // `everOpened` 解决的是什么
  // ============================================================
  //
  // 切标签回来**不该再闪一次"正在启动"**：webview 还活着，插件自己的界面状态
  // 也还在。因此宿主占位只在**这块界面从来没被建过**时才立。
  //
  // 它是 `useRef` 而不是 state：它不影响渲染结果，只影响"下一次该不该立占位"，
  // 而放进 state 会让这个 effect 因为自己写的东西而再跑一遍。
  useEffect(() => {
    if (!visible) {
      // 不可见：收起来。留着它会让原生 webview 盖在别的标签或宿主浮层上。
      void hideSandboxSurface(pluginId, surfaceId).catch(() => {});
      return;
    }

    if (!everOpened.current) {
      everOpened.current = true;
      // 先立占位，再建 webview —— 而且建出来就**不显示**。
      //
      // 反过来（先建再收）会有一帧 webview 已经显示出来的闪烁，而这一条路径
      // 每次打开插件都会走到。`beginHostSplash` 是幂等的：布局变化重复调用
      // 不会把超时重置掉（否则一个真的卡住的插件永远等不到兜底）。
      beginHostSplash(pluginId, surfaceId);
      apply('open', true);
      return;
    }

    apply('open', splash !== null);
  }, [visible, splash, apply, pluginId, surfaceId]);

  // ---- 几何：尺寸与位置变化，以及宿主滚动 ----
  useEffect(() => {
    if (!visible) return;

    const element = holder.current;
    if (!element) return;

    // 用 rAF 合并同一帧内的多次回调 —— ResizeObserver 在一次拖动里会触发很多次，
    // 滚动同理，每次都发一条 IPC 是没必要的。
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        apply('bounds');
      });
    };

    const observer = new ResizeObserver(schedule);
    // 观察**内容视口**而不是占位块：占位块现在是零尺寸的锚点（矩形由
    // `measureSurface` 从视口算出来），观察它等于什么都没观察。
    // 侧边栏折叠、分屏拖动、窗口缩放改变的都是视口的尺寸。
    const panel = (element.closest(PANEL_SELECTOR) as HTMLElement | null) ?? element;
    observer.observe(panel);
    window.addEventListener('resize', schedule);

    // 捕获阶段监听滚动。滚动事件**不冒泡**，而滚动发生在某个祖先容器上而不是
    // window 上 —— 只在 window 上监听冒泡阶段什么也收不到。
    //
    // 界面本身钉在内容视口上，因此滚动**不该**让它移动（这正是"内容视口"的
    // 含义）。留着这个监听是为了另一件事：滚动会改变宿主内容的位置，而
    // 遮挡判断依赖的就是位置 —— 浮层多半是随内容一起滚的。
    document.addEventListener('scroll', schedule, true);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
    };
  }, [visible, apply]);

  // ---- 遮挡：宿主浮层出现时让位 ----
  useEffect(() => {
    if (!active) {
      // 不在前台就不必轮询，也不该留着一个"被盖住"的旧判断。
      setCovered(false);
      return;
    }

    let candidate = false;
    let agreed = 0;

    const interval = window.setInterval(() => {
      const element = holder.current;
      if (!element) return;

      const bounds = measureSurface(element);
      if (!bounds) return;

      const now = isCovered(element, bounds);
      if (now === candidate) {
        agreed = 0;
        return;
      }

      agreed += 1;
      if (agreed < CONFIRMATIONS) return;

      candidate = now;
      agreed = 0;
      setCovered(now);
    }, POLL_MS);

    return () => window.clearInterval(interval);
  }, [active]);

  // ---- 卸载：销毁 ----
  //
  // 与"隐藏"分开：切标签只是看不见，而卸载意味着这块内容不会再回来了。
  // 不销毁的话，切过的每一个沙箱插件都会留下一个渲染进程。
  useEffect(() => {
    return () => {
      void closeSandboxSurface(pluginId, surfaceId).catch(() => {});
    };
  }, [pluginId, surface]);

  return (
    <>
      <div
        ref={holder}
        // **零尺寸的锚点，刻意不是"占满父容器"。**
        //
        // 这里曾经写的是 `h-full w-full`，本意是"占住内容区"。但 `h-full` 是
        // 父元素高度的 100%，而父级 `div.p-8` 的高度由内容决定 —— 内容是空的，
        // 于是高度是 0。矩形现在由 `measureSurface` 从内容视口算出来，这个 div
        // 只负责两件事：把插件界面挂进正确的标签面板（`closest`），
        // 以及让读屏软件知道这里没有内容。
        //
        // **它必须保持"不定位于"（不带 `relative`）**：下面那块占位用的是
        // `absolute inset-0`，它要相对 `.lc-tab-panel` 铺满 —— 而那正是
        // `measureSurface` 量出来的同一块矩形。给锚点加上 `relative` 会让占位
        // 缩成一个 0×0 的点，症状是"点了插件之后什么都没有"。
        className="h-0 w-0"
        aria-hidden="true"
      />

      {/*
        启动占位。**由宿主渲染** —— 理由与浮层那三样一样，而且这里还多一条硬的：
        插件的 webview 已经建出来了（它的文档要开始加载），宿主想在那块位置上画
        任何东西，就必须先把 webview 收起来。收起来这件事由上面的 effect 做。

        内容刻意极简：一句话 +（有进度时）一条细线。它是**等待**，不是界面 ——
        长得越像界面，用户越会去点它。
      */}
      {visible && splash && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2">
            <div className="h-4 w-1 animate-pulse rounded-full bg-indigo-500/50" />
            <span className={`text-xs ${SPLASH_TONES[splash.tone]}`}>{splash.text}</span>
          </div>

          {splash.progress !== null && (
            <div className="h-0.5 w-32 overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-indigo-500 transition-[width] duration-200"
                style={{ width: `${Math.round(splash.progress * 100)}%` }}
              />
            </div>
          )}

          {/* 不定量进度：来回跑的一条细线。它与上面那条的区别是"多久"这件事
              插件自己也不知道 —— 而画一条永远停在 0% 的定量条会让人以为卡住了。 */}
          {splash.progress === null && splash.auto === false && (
            <div className="h-0.5 w-32 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-500" />
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default SandboxSurface;
