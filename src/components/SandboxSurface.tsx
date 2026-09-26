// src/components/SandboxSurface.tsx
//
// 沙箱插件界面：一块**跨源 iframe**，加上它上面那层宿主的启动占位。
//
// ============================================================
// 它曾经做的是完全不同的另一件事
// ============================================================
//
// v1.6.0 之前插件界面是宿主窗口里另开的一个 webview：引擎把它合成在父窗口客户区
// **之上**，CSS 碰不到它。于是这个组件当时的主要工作是三件很别扭的事 ——
//
//   1. 占一块位置正确的空地，把矩形量出来交给 Rust 去摆那个原生控件；
//   2. 每 150ms 做一次命中测试，判断"有没有宿主浮层盖在它上面"，盖住了就把它
//      收起来（原生层不看 z-index，不收起来它就会盖住宿主自己的对话框）；
//   3. 组件被卸载时显式销毁那个 webview。
//
// 三件都不再需要：iframe 就在这个文档里，**层级由 CSS 决定**，位置由布局决定，
// 卸载由 React 决定。这一层因此只剩下两件事：向宿主换一个令牌，以及把宿主推来的
// 消息转成 `postMessage` 送进去。
//
// 这也是用户报的两个缺陷的根因所在：标题栏的搜索框展开时压不住插件界面、
// 侧边栏边缘的模糊被它盖住 —— 那不是"判据不够准"，是原生层本来就不参与 CSS 层叠。
//
// ============================================================
// 唯一的布局契约
// ============================================================
//
// 这块 iframe 必须填满**内容视口**（`.lc-tab-panel`），而不是填满它的父元素。
//
// 父元素是 `<div class="p-8">`，高度由内容决定 —— 而这里渲染的内容是绝对定位的，
// 于是父元素的高度是 **0**。实测撞到过一次：`h-full` 解析成 0，建出来的界面是
// 2240×1。`absolute inset-0` 量的是最近的那个**定位**祖先，而 `.lc-tab-panel`
// 正是 `absolute inset-y-0`，因此它给出的是内容视口本身 —— 也正是这里想要的。
//
// 同一个选择器在 `AllModulesPanel` 里已经用过一次，因此它是一条既有的契约。

import React, { useEffect, useRef, useState } from 'react';

import { useModuleActive } from '../hooks/useModuleActive';
import { subscribeFileDrop } from '../services/fileDrop';
import {
  closeSandboxSurface,
  openSandboxSurface,
  postToSurface,
  subscribeSandboxPush,
  type SandboxSurfaceHandle,
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
   * 缺省是主界面。**它必须一路传到宿主**：`sandbox_surface_open` 按
   * `(插件 id, 界面 id)` 签发令牌，少了它，同一插件的两个界面会去要同一个
   * 主界面 —— 于是"详情"页显示的是列表。
   */
  surface?: string;
}

/** 内容视口的选择器。见文件头"唯一的布局契约"。 */
const PANEL_SELECTOR = '.lc-tab-panel';

/**
 * 等多久还算"正在加载"。
 *
 * 判据不是 `onload` —— 一个**加载失败**的文档照样会触发它，只是里面是引擎画的
 * 错误页。真正的就绪信号是桥接层挂好之后主动发回来的那条 `ready`（见
 * `resources/sandbox-bridge.js`）。这条超时只是"连那条信号都没等到"时的兜底。
 */
const READY_TIMEOUT_MS = 10_000;

/**
 * 启动占位的语气 → 文字颜色。
 *
 * 只改文字颜色，不改底色：占位那块底色必须与内容区一致 —— 换一个底色会让它
 * 看起来像一块**弹窗**，而它其实只是"这块位置还没准备好"。
 */
const SPLASH_TONES: Record<string, string> = {
  info: 'text-gray-400',
  warning: 'text-amber-600',
  error: 'text-rose-600',
};

/**
 * 同一条警告只说一次。
 *
 * 这块布局契约一旦断了，症状是"插件界面盖住整个窗口" —— 而它每渲染一次就会
 * 说一遍同样的话，把日志淹掉。这一条恰恰是最需要被看见的那类信号。
 */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[sandboxSurface] ${message}`);
}

const SandboxSurface: React.FC<SandboxSurfaceProps> = ({ pluginId, surface }) => {
  const holder = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  /**
   * 这一块界面的桥接层有没有报过到。
   *
   * 它是 `useRef` 而不是 state：它只影响"超时该不该判失败"，不影响渲染结果 ——
   * 放进 state 会让那个每秒都在跑的判断把组件重渲染一遍。
   */
  const readyRef = useRef(false);

  /**
   * 指针底下的这一块界面现在算不算"正在被拖着文件"。
   *
   * 只用来处理 `leave`：那一条**不带指针位置**（拖放已经离开窗口了），因此没法
   * 命中测试。持有它的应该是"上一次真的进来了的那一块"，靠这个标记认出来。
   */
  const dragInsideRef = useRef(false);

  // 「标签是否被选中」+「窗口是否可见」。
  //
  // 它**不再用来显示/隐藏任何原生东西** —— 非激活的标签面板由 CSS 的
  // `visibility: hidden` 藏起来（见 styles/global/index.css），而 iframe 是普通
  // DOM，跟着一起藏。它现在只决定一件事：**要不要现在就去换令牌**。
  // 后台标签页里的插件界面不该占着一份文档。
  const active = useModuleActive();

  // 界面 id 的缺省值。**只有这一处**允许把缺省写出来。
  // 宿主那一侧也有一份（两条命令里），两边不一致的话，"详情"界面会去要主界面。
  const surfaceId = surface ?? 'main';

  // 宿主签发的凭据。`null` 表示还没换到（或换失败了）—— 那时不渲染 iframe。
  const [handle, setHandle] = useState<SandboxSurfaceHandle | null>(null);
  const handleRef = useRef<SandboxSurfaceHandle | null>(null);

  // 加载失败的原因。为 `null` 表示没有已知的失败。
  const [failure, setFailure] = useState<string | null>(null);

  // 布局契约是否成立。`null` 表示还没量过（首帧）。
  const [panelOk, setPanelOk] = useState<boolean | null>(null);

  // 换令牌的重试计数。宿主撤销一块界面（插件被停用/卸载，或自检窗口关掉）时会
  // 推一条 `close` —— 那时必须**重新**走一遍换令牌，而不是停在没有 iframe 的状态。
  const [generation, setGeneration] = useState(0);

  // 「这块界面是不是还在启动」。为真时宿主自己在它上面画一块占位。
  const [splash, setSplash] = useState(() => getPluginSplash(pluginId, surfaceId));
  useEffect(() => subscribePluginUi(() => setSplash(getPluginSplash(pluginId, surfaceId))), [
    pluginId,
    surfaceId,
  ]);

  // ---- 布局契约的检查 ----
  useEffect(() => {
    const element = holder.current;
    const ok = element !== null && element.closest(PANEL_SELECTOR) !== null;
    setPanelOk(ok);

    if (!ok) {
      const detail =
        `这块界面不在 ${PANEL_SELECTOR} 里，因此没有地方放它。` +
        '如果一直这样，说明宿主的内容区布局变了 —— 见 SandboxSurface 的文件头。';
      warnOnce(`${pluginId}:${detail}`);
      // **不能只写日志。** 日志在用户那里看不到，而他面对的是一个空白面板 ——
      // 那与"插件坏了"长得一模一样。把原因画出来。
      setFailure(detail);
    }
  }, [pluginId]);

  // ---- 打开：只换令牌，不碰任何窗口系统 ----
  //
  // 三个条件缺一不可：
  //   * 这块标签**正被选中** —— 后台标签页不该占一份文档；
  //   * 布局契约成立 —— 否则 iframe 会铺满整个窗口；
  //   * 还没有凭据 —— 宿主那一侧是幂等的，但每一轮都是一条 IPC。
  //
  // **拿到令牌不等于界面能跑。** 令牌只是"这个来源被允许读这个插件的数据"，
  // 文档能不能加载出来由 `ready` 那条消息回答（见下面的就绪检查）。
  useEffect(() => {
    if (!active || panelOk !== true) return;
    if (handleRef.current !== null) return;

    // 先立占位，再取令牌。占位是幂等的：布局变化重复调用不会把超时重置掉
    // （否则一个真的卡住的插件永远等不到兜底）。
    beginHostSplash(pluginId, surfaceId);

    let cancelled = false;

    void openSandboxSurface(pluginId, surfaceId)
      .then((next) => {
        if (cancelled) {
          // 这一次请求已经作废（组件卸载或参数变了），把刚换到的凭据还回去。
          // 不还的话，宿主那一侧会留下一条指向**不存在 iframe** 的记录，而它仍然
          // 读得到这个插件的数据。
          void closeSandboxSurface(next.token).catch(() => {});
          return;
        }
        // 换到新凭据 = 换了一块文档，上一块的"我起来了"不再作数。
        readyRef.current = false;
        handleRef.current = next;
        setHandle(next);
        setFailure(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setFailure(`插件界面打不开：${String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [active, panelOk, pluginId, surfaceId, generation]);

  // ---- 收回令牌 ----
  //
  // 组件卸载、或者 `pluginId` / `surface` 变了时走这条。**认令牌而不是认名字**：
  // 一个界面在"关掉又打开"之间会拿到不同的令牌，按名字关会让一次迟到的卸载把
  // 新开的那一块关掉。理由见 `services/sandboxSurface.ts`。
  useEffect(() => {
    return () => {
      const current = handleRef.current;
      handleRef.current = null;
      if (current) void closeSandboxSurface(current.token).catch(() => {});
    };
  }, [pluginId, surfaceId]);

  // ---- 窗口级的文件拖放 → 转给**指针底下那一块界面** ----
  //
  // ============================================================
  // 为什么要按位置筛，而不是广播
  // ============================================================
  //
  // 拖放是**窗口级**事件：文件被拖进窗口就会触发，与指针落在哪一块界面上无关。
  // 而 `Home.tsx` 里各个标签面板是 `absolute inset-y-0` **叠在一起**、靠
  // `visibility: hidden` 藏起来的 —— 非激活的那几块矩形与激活的那一块**重合**。
  // 只按矩形命中过滤的话，一次拖放会同时转给屏幕上看得见的那一块和所有藏在
  // 它下面的那一摞，于是插件 A 会收到本该属于插件 B 的文件路径。
  //
  // 所以这里有两个条件：`active`（这一块正被看着）**且**指针落在它的矩形里。
  //
  // ============================================================
  // 为什么权限不在这里判
  // ============================================================
  //
  // `handle.fileDrop` 是宿主在签发令牌时算好的（清单里有没有
  // `filesystem-read`）。前端不自己查清单 —— 拖放带来的是**本机路径**，
  // "这个插件能不能收"必须由宿主判定，而不是由一个还能被插件影响的层判定。
  useEffect(() => {
    if (!active) return;

    return subscribeFileDrop((event) => {
      const current = handleRef.current;
      const element = holder.current;
      if (!current || !current.fileDrop || !element) return;

      const send = (payload: unknown) =>
        postToSurface(frame.current, current.url, {
          token: current.token,
          channel: 'file-drop',
          payload,
        });

      // `leave` 不带位置，只能靠"上一次真的进来了"这个标记认领。
      if (event.type === 'leave') {
        if (!dragInsideRef.current) return;
        dragInsideRef.current = false;
        send({ type: 'leave', paths: [] });
        return;
      }

      if (!event.position) return;

      // Tauri 给的是**物理像素**，而 DOM 的矩形是 CSS 像素。不换算的话，
      // 在缩放不是 100% 的屏幕上命中的是另一块区域（而且看起来毫无规律）。
      const scale = window.devicePixelRatio || 1;
      const x = event.position.x / scale;
      const y = event.position.y / scale;

      const rect = element.getBoundingClientRect();
      const inside = x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
      if (!inside) return;

      dragInsideRef.current = true;
      // 指针位置**不再往下传**：那是宿主用来筛"该转给谁"的，对插件没有意义
      // （它只可能收到落在自己身上那些）。传下去只会变成第二个会漂的约定。
      send({ type: event.type, paths: event.paths });
    });
  }, [active]);

  // ---- 宿主推来的消息 → postMessage ----
  //
  // Rust 那一边够不到这个 iframe 的文档（跨源），它只能发一条 Tauri 事件。
  // 持有 iframe 的是**这个文档**，因此转发只能在这里做。
  useEffect(() => {
    return subscribeSandboxPush((push) => {
      const current = handleRef.current;
      if (!current || push.token !== current.token) return;

      if (push.channel === 'close') {
        // 宿主撤销了这块界面（插件被停用/卸载）。**它没法替我们拆 DOM** ——
        // 这条消息存在的意义就是"请你把它卸掉"。清掉凭据会让 iframe 从渲染树上
        // 消失，而 `generation` 让打开那条 effect 再跑一遍（插件还在的话会拿到
        // 一个新令牌；不在的话会显示原因）。
        handleRef.current = null;
        setHandle(null);
        setGeneration((value) => value + 1);
        return;
      }

      postToSurface(frame.current, current.url, push);
    });
  }, []);

  // ---- 就绪检查 ----
  //
  // ============================================================
  // 为什么判据是桥接层发回来的 `ready`，而不是 iframe 的 `load`
  // ============================================================
  //
  // `load` 在一个**加载失败**的文档上照样会触发 —— 引擎会拿它自己画的一张错误页
  // 来触发它。那意味着"用 load 判断成功"会把最需要被发现的那种失败（协议没接上、
  // 令牌被拒、CSP 拦了自己）判成成功，而症状是一块永远白着的面板。
  //
  // 桥接层是那份文档里**我们自己的**代码，它跑到发 `ready` 就说明：文档加载了、
  // 脚本加载了、协议通了。那是唯一一个不容易骗过自己的信号。
  //
  // ============================================================
  // 监听器为什么与"等超时"分成两个 effect
  // ============================================================
  //
  // 监听器挂在**组件装载时**，而不是拿到凭据之后：iframe 一开始加载，那份文档就
  // 可能已经跑完桥接层并把 `ready` 发出来了 —— 而 React 的 effect 在提交之后才跑。
  // 把监听器和 `handle` 绑在一起，会让"恰好在这一瞬之间到达的 `ready`"丢掉，
  // 于是界面明明好着，十秒后却跳出一句"没有就绪"。
  //
  // `readyRef` 与它配套：拿到**新**凭据时先清掉（见下面的打开那一条 effect），
  // 超时那一边才不会被上一块界面留下的旧结论救活。

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // **身份判据是 `event.source`，不是 `event.origin`。** 来源字符串是发送方
      // 自己声明的（一个 `data:` 文档的来源就是字符串 `"null"`），而窗口引用不能
      // 伪造 —— 只有那块 iframe 的 `contentWindow` 能等于它。
      if (event.source !== frame.current?.contentWindow) return;

      const data = event.data as
        | { __modulith?: unknown; channel?: unknown; payload?: { message?: unknown } }
        | null;
      if (!data || data.__modulith !== true) return;

      if (data.channel === 'ready') {
        readyRef.current = true;
        setFailure(null);
        return;
      }

      // 插件脚本在**它自己的文档里**抛了错（桥接层的 error / unhandledrejection
      // 监听器转过来的）。这条必须画出来：用户看到的是一块白板，而原因在另一个
      // 进程里 —— 只写宿主日志的话，他仍然只能看到白板。
      //
      // 这一次是真的踩过：8 个插件白屏，而屏幕上没有一句话解释。
      if (data.channel === 'plugin-error') {
        const message =
          typeof data.payload?.message === 'string' && data.payload.message.length > 0
            ? data.payload.message
            : '插件脚本报错（宿主日志里有完整堆栈）';
        setFailure(message);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!handle) return;

    const timer = window.setTimeout(() => {
      if (readyRef.current) return;
      setFailure(
        `插件界面在 ${READY_TIMEOUT_MS / 1000} 秒内没有就绪。` +
          '这通常意味着那份文档没有被加载 —— 见应用日志里的 [sandbox] 记录。'
      );
    }, READY_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [handle]);

  return (
    <div ref={holder} className="absolute inset-0">
      {panelOk === true && handle && (
        <iframe
          ref={frame}
          src={handle.url}
          // 读屏软件与调试都要能认出这是哪一块界面。
          title={`插件界面：${pluginId}${surfaceId === 'main' ? '' : `（${surfaceId}）`}`}
          className="h-full w-full border-0 bg-white"
          // ============================================================
          // `sandbox` 属性：默认拒绝，逐条放开
          // ============================================================
          //
          // 没写出来的那些**默认全部拒绝**：表单提交、弹窗、模态框（alert /
          // confirm）、顶层跳转、下载、指针锁定、自动播放。每少放开一条，就少一条
          // 插件能绕开宿主的出站路径 —— 而这些能力对插件界面没有一条是必需的。
          //
          // 两条必须放开：
          //   * `allow-scripts` —— 那就是插件代码本身；
          //   * `allow-same-origin` —— 不放开的话文档会退化成一个**不透明来源**，
          //     于是它连自己那份 `fetch`（到 `modulith-plugin.localhost`）都算跨源，
          //     而宿主没有为它准备 CORS 头。
          //
          // "allow-scripts + allow-same-origin" 那条经典警告在这里**不适用**：
          // 它说的是"被嵌的文档与父文档同源"，而插件来源与宿主**不同源**，
          // 因此插件够不到 `parent`，也就删不掉这个属性。
          sandbox="allow-scripts allow-same-origin allow-modals allow-forms"
          /*
           * ============================================================
           * `allow-forms` —— 少了它，React 的 `onSubmit` **一次都不会触发**
           * ============================================================
           *
           * 这是换 iframe 之后第四个"宿主少给了东西"的例子，也是最隐蔽的一个：
           * 没有 `allow-forms` 时，`<form>` 的提交被 sandbox 直接掐掉 —— 而
           * **`submit` 事件根本不派发**。于是 `onSubmit={...}` 里的处理器永远
           * 不跑，点击按钮**毫无反应**，控制台里连一条错误都没有。
           *
           * 实测（`staging/form-sandbox-probe.html`，headless Chrome，同一份文档
           * 跑三组对照）：
           *
           *   无 allow-forms  →  submit 处理器触发 **0 次**
           *   有 allow-forms  →  触发 1 次
           *   不带 sandbox    →  触发 1 次
           *
           * 受影响的是真实插件：`kanban` 用了 6 处 `onSubmit`/`<form>`
           * （"添加卡片"/"添加列表"就是表单提交），`quick-launch` 用了 2 处。
           * 用户报的"点那个按钮毫无反应"就是这一条。
           *
           * ============================================================
           * 为什么会放它进来：它与 CSP 里的 `form-action 'none'` 是**配对**的
           * ============================================================
           *
           * 单独放开 `allow-forms` 会让表单成为一条出站通路（POST 到外部）——
           * 而且一个忘了 `preventDefault` 的插件会把**自己的 iframe 导航走**，
           * 界面整个消失。这两件事都实测到了
           * （`staging/form-action-probe.html`）：
           *
           *   allow-forms + form-action 'none'，插件 preventDefault  → 正常
           *   allow-forms + form-action 'none'，插件**没** preventDefault → 正常
           *      （导航被 CSP 挡住，界面还在 —— 这一条是配对里承重的那一半）
           *   allow-forms、**没有** form-action                          → iframe 被导航走
           *
           * 插件的 CSP 早就有 `form-action 'none'`（`sandbox.rs` 的
           * `page_with_frame`），因此这里放开是**安全的那一半**。
           * 门禁同时钉住这两件事：`allow-forms` 必须在，`form-action 'none'` 也必须在 ——
           * 只钉其中一条都会让另一个方向的错误溜过去。
           */
          /*
           * ============================================================
           * 剪贴板必须由**父文档显式委派**，否则插件那一侧根本拿不到它
           * ============================================================
           *
           * 这是一次真实的故障：`encode-lab` 的"复制结果"点了没反应，它自己报
           * "复制没有成功，可以手动选中内容复制"。原因是它调
           * `navigator.clipboard.writeText`（桥接层的 `ctx.clipboard` 也是同一
           * 个东西），而**跨源 iframe 里 `navigator.clipboard` 是 undefined** ——
           * Permissions Policy 的 `clipboard-write` 默认白名单是 `self`，跨源
           * 子框架必须由父文档用 `allow=` 显式放开。
           *
           * 也就是说：这不是插件写错了，是**换成 iframe 之后宿主少给了一样东西**。
           * 子 WebView 时代每个插件有自己的文档，那一层天然可用，所以以前没暴露。
           *
           * `clipboard-read` 一并放开：`ctx.clipboard.readText()` 是文档里写明的
           * 能力，只放开写会让"读"变成一条永远失败的接口。读那一侧浏览器自己还会
           * 再要一次用户手势与授权，不是这里放开就等于能随便读。
           *
           * ⚠️ 代价要说清：放开之后，插件**绕过** `ctx.clipboard` 直接调
           * `navigator.clipboard` 也能写剪贴板，因此 `clipboard` 权限在沙箱里
           * 仍然只是 `ctx.clipboard` 那道门（与 `permissions.rs` 里把它标成
           * "前端强制"是一致的，那里已经写明"页面脚本本来就能直接调它"）。
           * 反过来（不放开）的代价是：所有复制功能**全都不能用**，而那不是更安全，
           * 那是坏掉。
           */
          allow="clipboard-read; clipboard-write"
          /*
           * ============================================================
           * `allow-modals` —— 少了它，alert / confirm / prompt 会被**静默**挡掉
           * ============================================================
           *
           * `sandbox` 里没有 `allow-modals` 时，这三个函数不会抛错、也不会弹窗：
           * `confirm` 直接返回 `false`、`prompt` 直接返回 `null`。调用方看到的是
           * "用户取消了"。
           *
           * 于是一个 `if (!confirm('确定删除？')) return;` 的按钮**点了毫无反应**，
           * 而控制台里一个错都没有 —— 这类"看起来像按钮坏了"的现象，根因在宿主
           * 少给了一个 sandbox 权限。
           *
           * 实测：本仓库的 `notes` / `pomodoro` / `quick-launch` 三个插件都用了
           * `prompt` / `confirm`，因此它们各自的某个按钮在沙箱里都是死的。
           *
           * ⚠️ 这是**让功能恢复**，不是最佳形态。原生弹窗不跟随主题、还会阻塞整个
           * 应用；宿主有更好的接口（`ctx.ui.dialog` —— 由宿主渲染、走浮层窗口）。
           * 长期做法是那三个插件改用 `ctx.ui.dialog`，那时这个 sandbox 权限就可以
           * 收回去。收不收得等它们先改完 —— 先放开再改，而不是先禁着让按钮坏着。
           */
        />
      )}

      {/*
        启动占位。**由宿主渲染**，而且它现在真的在 iframe 上面 —— 两者都是普通
        DOM，`z-10` 就够了。曾经为了让它可见，必须先把原生 webview 显式收起来。

        内容刻意极简：一句话 +（有进度时）一条细线。它是**等待**，不是界面 ——
        长得越像界面，用户越会去点它。
      */}
      {splash && (
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

      {/*
        失败。**必须说出来** —— iframe 模型的失效方式是一块白面板，而白面板不
        告诉任何人它为什么白：协议没接上、令牌被拒、CSP 拦了自己，三者在这里
        长得一模一样。这句话把用户从"插件是不是坏了"引到日志里的那一条。
      */}
      {failure && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-white p-6">
          <p className="max-w-md text-center text-xs leading-relaxed text-rose-600">{failure}</p>
        </div>
      )}
    </div>
  );
};

export default SandboxSurface;
