// src/services/netGuard.ts
//
// WebView 侧的出站门面。
//
// ============================================================
// 它守的是什么
// ============================================================
//
// 插件联网的**唯一合法通道是宿主给的 `ctx.http`**（`pluginRuntime.ts` 的
// `pluginHttp`）。那条路走后端 `plugin_http_request`，因此带三样东西：
//
//   * 权限检查（哪个插件、有没有声明 `network` / `network-external`）；
//   * 出站策略与离线模式；
//   * 流量日志（谁、去哪、结果）。
//
// 而 WebView 里一次直接的 `fetch('https://…')` 把这三样一起绕过去了 —— 它甚至
// 连"是谁发的"都无从知道。所以这里的目标不是"给直接请求加上策略"，而是
// **让直接请求发不出去**，并让这件事在日志里留下一条可读的记录。
//
// ============================================================
// 它不是安全边界（这一点必须写在最前面）
// ============================================================
//
// 插件与宿主共享同一个 JavaScript 上下文。这个门面只是把几个全局函数换成了
// 包装版，而同一个 realm 里的代码能碰到的东西远不止这几个：
//
//   * `<img src>`、`<script src>`、`<link rel=preload>` 发的请求不经过任何 JS；
//   * `import('https://…')`、`EventSource` 不在包装范围内；
//   * 被包装的函数本身也挡不住刻意绕行（拿内建原型、开新 realm 等）。
//
// **真正的边界是 CSP 的 `connect-src`**（见 `src-tauri/tauri.conf.json`）：
// 它由浏览器引擎执行，JS 改不掉。这个门面的价值是**可读性与可观测性** ——
// CSP 挡下来的是一个静默的 `TypeError: Failed to fetch`，而这里给的是
// "插件 X 试图直连 Y，原因 Z"，并且落进流量日志。
//
// 两层是互补的，不是重复的：CSP 负责"一定发不出去"，门面负责"发不出去时你知道
// 是谁、去哪里、为什么"。

import { isLoopbackHost } from '../utils/networkSettings';
import { getCachedSettings } from './appSettings';
import {
  NET_DENY_DIRECT,
  NET_DENY_OFFLINE,
  NET_DENY_POLICY,
  NET_MODE_DENY,
  netNoteFrontendOutbound,
} from './netControl';

export interface FrontendVerdict {
  allowed: boolean;
  /** 被拒时给用户看的原因；允许时为空串 */
  reason: string;
}

/**
 * 当前的来源标记。
 *
 * 初值是 `host`：宿主自己一行网络代码都没有（`check-network.ts` 断言这一点），
 * 因此门面拦到的几乎总是插件 —— 但"几乎总是"不等于"总是"，把默认值写成某个
 * 插件是在编造事实。
 */
let currentSource = 'host';
let installed = false;

/** 插件运行时会**在插件脚本执行前后**调用它（见 `pluginRuntime.ts` 的 `loadingPluginId`） */
export function setGuardSource(pluginId: string | null): void {
  currentSource = pluginId && pluginId.trim() ? `plugin:${pluginId}` : 'host';
}

/**
 * 一次直接出站的判定。**同步** —— 这是它必须存在于前端的唯一理由。
 *
 * 顺序与后端 `policy::decide_frontend_direct` 一致：
 *   1. 回环放行（不出本机，且本地开发是正当场景）；
 *   2. 离线 / 禁止出站 → 给出**用户自己的**原因；
 *   3. 其余 → 拒绝，理由是"该走 ctx.http"。
 *
 * 第 3 条是关键：即使策略是"放行"，直接出站也不行。它走的不是通道问题，而是
 * 通道本身错了。
 */
export function guardDecide(url: string): FrontendVerdict {
  let host = '';
  try {
    // **不传 base。** 传了 `window.location.href` 之后，`new URL('不是地址', base)`
    // 会把任何相对路径或拼错的地址解析成同源地址，而应用的宿主正是 `localhost`
    // —— 于是它们全部落进"回环放行"那一支。拼错不该等于放行。
    //
    // 只认绝对地址的另一个理由：插件联网该走 `ctx.http`，它要的是完整地址；
    // 一个相对路径在这里没有任何合法用途。
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: '地址无法解析，已拒绝' };
  }

  if (isLoopbackHost(host)) return { allowed: true, reason: '' };

  const settings = getCachedSettings();
  if (settings.offlineMode) return { allowed: false, reason: NET_DENY_OFFLINE };
  if (settings.networkPolicy === NET_MODE_DENY) {
    return { allowed: false, reason: NET_DENY_POLICY };
  }
  return { allowed: false, reason: NET_DENY_DIRECT };
}

/**
 * 留痕。**fire-and-forget**：判定已经同步做完了，一次 IPC 往返不该拖住调用方。
 *
 * 这里**不传结果**给后端：后端收到地址后会用自己的规则重判一次并记录。
 * 让调用方决定日志写什么，等于让日志变成它自己的说法。
 */
function note(url: string, method: string, verdict: FrontendVerdict): void {
  if (verdict.allowed) return; // 放行的只有回环，不值得每次记一条
  void netNoteFrontendOutbound(url, method, currentSource).catch(() => {
    // 后端不可用时不上报：这次拦截本身已经生效了，日志缺失不该再引发一次错误
  });
}

/** 一次请求的地址与方法（`fetch` 的两种入参形态都要覆盖） */
function describeRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): { url: string; method: string } {
  let url = '';
  let method = 'GET';

  if (typeof input === 'string') {
    url = input;
  } else if (typeof URL !== 'undefined' && input instanceof URL) {
    url = input.toString();
  } else {
    const request = input as Request;
    url = request.url;
    method = request.method || 'GET';
  }

  if (init?.method) method = init.method;
  return { url, method: method.toUpperCase() };
}

function wrapFetch(): void {
  const original = window.fetch;
  if (typeof original !== 'function') return;

  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { url, method } = describeRequest(input, init);
    const verdict = guardDecide(url);
    note(url, method, verdict);
    if (!verdict.allowed) {
      throw new TypeError(`出站请求被拒绝：${verdict.reason}`);
    }
    return original.call(window, input, init);
  };

  window.fetch = guarded as typeof window.fetch;
}

function wrapXhr(): void {
  const Original = window.XMLHttpRequest;
  if (typeof Original !== 'function') return;

  class GuardedXhr extends Original {
    private guardUrl = '';
    private guardMethod = 'GET';

    open(method: string, url: string | URL, ...rest: unknown[]): void {
      this.guardUrl = String(url);
      this.guardMethod = String(method).toUpperCase();
      // `open` 的签名里后两个参数是可选的（async / user / password），原样透传
      (super.open as (...args: unknown[]) => void)(method, url, ...rest);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null): void {
      const verdict = guardDecide(this.guardUrl);
      note(this.guardUrl, this.guardMethod, verdict);

      if (!verdict.allowed) {
        // `send()` 是同步返回的，调用方通常也把 `send()` 放在 try 之外，
        // 所以这里不能抛 —— 按 XHR 自己的约定派发一个 error 事件。
        Promise.resolve().then(() => {
          this.dispatchEvent(new Event('error'));
          this.dispatchEvent(new Event('loadend'));
        });
        return;
      }

      super.send(body);
    }
  }

  window.XMLHttpRequest = GuardedXhr as unknown as typeof XMLHttpRequest;
}

function wrapWebSocket(): void {
  const Original = window.WebSocket;
  if (typeof Original !== 'function') return;

  // 用函数而不是 class：`new` 一个返回对象的构造函数会采用那个对象，
  // 因此 `instanceof WebSocket` 与原型链都保持成立。
  const Guarded = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const target = String(url);
    const verdict = guardDecide(target);
    note(target, 'WS', verdict);
    if (!verdict.allowed) {
      throw new Error(`出站连接被拒绝：${verdict.reason}`);
    }
    return new Original(target, protocols);
  } as unknown as typeof WebSocket;

  Guarded.prototype = Original.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
    Object.defineProperty(Guarded, key, { value: Original[key], enumerable: true });
  }

  window.WebSocket = Guarded;
}

function wrapSendBeacon(): void {
  const target = typeof navigator === 'undefined' ? null : navigator;
  if (!target || typeof target.sendBeacon !== 'function') return;

  const original = target.sendBeacon.bind(target);
  target.sendBeacon = ((url: string | URL, data?: BodyInit | null) => {
    const address = String(url);
    const verdict = guardDecide(address);
    note(address, 'BEACON', verdict);
    if (!verdict.allowed) return false;
    return original(address, data);
  }) as typeof target.sendBeacon;
}

/**
 * 装上门面。**幂等** —— 插件运行时可能在多轮加载里各调一次。
 *
 * 不放在模块顶层：import 就产生全局副作用会让这个文件难以被测试引用，
 * 而它恰恰需要一个"没装"的初始状态。
 */
export function installNetGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  wrapFetch();
  wrapXhr();
  wrapWebSocket();
  wrapSendBeacon();
}

/** 只给测试用：允许夹具重复安装 */
export function resetNetGuardForTests(): void {
  installed = false;
  currentSource = 'host';
}
