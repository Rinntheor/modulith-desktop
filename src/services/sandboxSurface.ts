// src/services/sandboxSurface.ts
//
// 沙箱插件界面的前端门面：**签发令牌、渲染 iframe、转发推送**。
//
// ============================================================
// 这一层在 iframe 模型里的职责变了
// ============================================================
//
// 从前它是"量矩形 + 显示/隐藏一个原生 webview"，因为那个 webview 盖在 DOM 之上、
// 不随 CSS 走。现在插件界面就是这个文档里的一个 `<iframe>`：位置由 CSS 决定，
// 显隐由 CSS 决定，销毁由 React 卸载决定 —— **这一层不再碰几何**。
//
// 剩下的两件事是宿主无法替代的：
//
//   1. **向宿主换一个令牌。** 令牌是访问那个插件数据的唯一凭据，而它只能由宿主
//      签发（插件自己发等于自己给自己发通行证）。见 `sandbox.rs` 文件头。
//   2. **把宿主的推送转成 `postMessage`。** Rust 那一边够不到 iframe 的文档，
//      只能发一条 Tauri 事件；持有 iframe 的是这个文档，因此转发只能在这里做。
//
// ============================================================
// 为什么令牌与地址都由宿主给
// ============================================================
//
// 地址的形状（来源、路径分段、结尾那个斜杠）是协议处理器定的。让前端自己拼，
// 两份规则一定会漂 —— 而漂开的表现是"插件界面一片白，所有资源 404"。
//
// ============================================================
// 为什么 `close` 认令牌而不是认 `(插件 id, 界面 id)`
// ============================================================
//
// 一个界面在"关掉又打开"之间会拿到**不同的**令牌。按名字关的话，React 一次迟到的
// 卸载（StrictMode 的双调用、快速切标签）会把**新开的那一块**关掉 —— 而表现是
// 界面开着却什么都读不到。令牌是那个 iframe 自己的身份，只有它能精确地指认。

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

/** 宿主签发给一块界面的凭据。 */
export interface SandboxSurfaceHandle {
  /** 不可猜的令牌。它出现在这个界面每一条请求的路径第一段。 */
  token: string;
  /** 这个 iframe 该加载的地址（由宿主拼好，前端不自己拼）。 */
  url: string;
  /**
   * 这块界面能不能收到文件拖放。
   *
   * **由宿主算出来**（清单里有没有 `filesystem-read`），前端不自己查。
   * 拖放带来的是本机路径，"这个插件能不能收"必须由宿主判定 —— 让前端再实现
   * 一遍"哪个权限管哪个能力"，就是又一处会漂的东西。
   */
  fileDrop: boolean;
}

/**
 * 宿主推进来的一条消息。
 *
 * `channel` 是**固定的几个之一**（主题、快捷键、命令、下载进度、跨插件事件、
 * 关闭），`payload` 的形状随 `channel` 而定。桥接层按 `channel` 分派，
 * 认不出的 channel 一律忽略 —— 宿主加一条新的推送时，旧版插件不该因此报错。
 */
export interface SandboxPush {
  token: string;
  channel: string;
  payload: unknown;
}

/** 宿主 → 前端的推送通道名。必须与 Rust 侧 `sandbox::PUSH_EVENT` 逐字相同。 */
const PUSH_EVENT = 'modulith://sandbox-push';

/**
 * 换一块界面的令牌。
 *
 * **幂等**：同一个界面重复调用拿到同一个令牌（宿主侧保证）。切标签回来、
 * React 重复渲染、布局变化后的重挂载都会走到这里，因此幂等不是优化而是前提。
 *
 * `surface` 省略时是**主界面**（`"main"`）。省略是有意义的：单界面插件的调用点
 * 因此一个字都不用改。
 */
export function openSandboxSurface(
  pluginId: string,
  surface?: string
): Promise<SandboxSurfaceHandle> {
  return invoke<SandboxSurfaceHandle>('sandbox_surface_open', {
    pluginId,
    surface: surface ?? null,
  });
}

/**
 * 收回一块界面的令牌。**没开着时静默成功** ——
 * 前端在卸载时无条件调用它，把"本来就没开"当成错误只会在日志里堆噪声。
 */
export function closeSandboxSurface(token: string): Promise<void> {
  return invoke('sandbox_surface_close', { token });
}

/**
 * 运行沙箱自检（诊断用，与具体插件无关）。
 *
 * 它打开一个**独立窗口**，在一个真实 webview 里把几条边界各跑一次：那个文档里
 * 有没有宿主 IPC、自定义协议是否可用、CSP 是否真的生效。结果画在窗口上，同时
 * 写进日志。
 *
 * 它**不随应用启动自动运行** —— 由「插件」页上的按钮触发。理由见
 * `src-tauri/src/modules/plugins/sandbox.rs` 的 `open_selftest`。
 */
export function runSandboxSelfTest(): Promise<void> {
  return invoke('sandbox_self_test');
}

// ============================================================
// 推送的分发
// ============================================================
//
// 一个**模块级**的监听器，而不是每块界面各装一个：这块界面可能有十几块，
// 而 Tauri 的事件监听是 IPC 级别的（每多一个就多一条消息要过一遍路由）。
// 分发在这里只做一件事：按令牌挑出订阅者。

type PushListener = (push: SandboxPush) => void;

const listeners = new Set<PushListener>();

let unlisten: UnlistenFn | null = null;
let installing: Promise<void> | null = null;

function isPush(value: unknown): value is SandboxPush {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SandboxPush>;
  return typeof candidate.token === 'string' && typeof candidate.channel === 'string';
}

function ensureInstalled(): void {
  if (unlisten || installing) return;

  installing = listen<unknown>(PUSH_EVENT, (event) => {
    // 形状不对的一律丢掉，而不是让它在下面某个 `payload.token` 上炸掉。
    // 这条通道是宿主自己发的，但"宿主自己发的"不是"一定合形状"。
    if (!isPush(event.payload)) return;

    for (const listener of [...listeners]) {
      listener(event.payload);
    }
  })
    .then((stop) => {
      unlisten = stop;
    })
    .catch((error) => {
      // 装不上不代表界面不能用 —— 只是收不到宿主推来的主题/命令/事件。
      // 那仍然要说出来：少了这一条，现象是"改了主题但插件界面没变"。
      console.warn('[sandboxSurface] 订阅宿主推送失败，插件界面将收不到主题与命令', error);
    })
    .finally(() => {
      installing = null;
    });
}

/** 订阅宿主推给插件界面的消息。返回值用于退订。 */
export function subscribeSandboxPush(listener: PushListener): () => void {
  ensureInstalled();
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * 把一条推送转交给某一块界面。
 *
 * ============================================================
 * 为什么 `targetOrigin` 是算出来的，而不是 `'*'`
 * ============================================================
 *
 * `'*'` 意味着"任何来源都收得到这条消息"。虽然这条消息本来就是发给那个 iframe 的，
 * 但 `'*'` 让**任何被嵌进来的文档**在换过来源之后还能收到它 —— 而那正是
 * `postMessage` 最常见的一类事故。这里从宿主给的地址里取出来源，指哪打哪。
 *
 * 地址解析失败时**不发**：那说明宿主给的地址本身不对，而对着一个解析不出来的
 * 地址猜一个来源，比什么都不做更糟。
 */
export function postToSurface(frame: HTMLIFrameElement | null, url: string, push: SandboxPush): void {
  const target = frame?.contentWindow;
  if (!target) return;

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    console.warn(`[sandboxSurface] 界面地址无法解析，这条 ${push.channel} 推送被丢弃：${url}`);
    return;
  }

  // 形状是桥接层认的：`__modulith` 这个标记让插件页面里**别人的** postMessage
  // （浏览器扩展、将来嵌进去的第三方内容）不会被误当成宿主消息。
  target.postMessage({ __modulith: true, channel: push.channel, payload: push.payload }, origin);
}
