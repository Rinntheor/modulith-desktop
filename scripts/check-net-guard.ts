// scripts/check-net-guard.ts
//
// WebView 侧出站门面（`src/services/netGuard.ts`）的验证脚本。
//
//   node --import ./scripts/harness/loader.mjs scripts/check-net-guard.ts
//
// ============================================================
// 为什么需要它
// ============================================================
//
// 门面是"插件不能直接联网"这条规则的**执行点**。它坏掉时的表现是"某个插件不好
// 用了"或"某个插件偷偷联网了"—— 前者的排查方向会指向插件本身，后者根本没人会
// 注意到。也就是说，它**没有一处症状会指向自己**。
//
// 而没有断言的话，它唯一的保护就是"下次改动能想起来"。这正是出站管控上一版
// 栽的地方（判定手写在调用点上，插件市场那条路漏了，见 `已知问题 7.32`）。
//
// ============================================================
// 覆盖什么、不覆盖什么
// ============================================================
//
// 覆盖：谁被拦、谁被放行、理由是什么、**原始实现有没有被真的调用**（"拦住了"
// 与"调用了再丢弃"是两件事，后者仍然把数据发出去了）。
//
// 不覆盖：日志上报的成功路径。它是 fire-and-forget，夹具的桩后端对未知命令会
// 抛错 —— 这一点顺带验证了"上报失败不影响拦截"，但也就无法断言后端真的记下了。

import { createPluginHost } from './harness/plugin-host.ts';
import { loadAppSettings, saveAppSettings } from '../src/services/appSettings.ts';
import {
  guardDecide,
  installNetGuard,
  resetNetGuardForTests,
  setGuardSource,
} from '../src/services/netGuard.ts';

let failed = 0;
let total = 0;

function check(condition: boolean, label: string): void {
  total += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const host = await createPluginHost();
const window = host.shim.window as Record<string, any>;

// 门面的同步判定读的就是前端缓存，所以先把设置灌进去
await loadAppSettings();

// ------------------------------------------------------------
// 网络桩
//
// `dom-shim` **刻意不提供** fetch / XHR / WebSocket：宿主自己一行网络代码都没有
// （`check:network` 的收口断言守着这一点），因此一个真实的浏览器环境里这些函数
// 只可能被插件用到。这里由夹具补上，好让门面有东西可包。
// ------------------------------------------------------------

const fetchCalls: string[] = [];
const originalFetch = async (input: unknown) => {
  fetchCalls.push(String(input));
  return { ok: true, status: 200 } as unknown as Response;
};

const xhrSent: string[] = [];
class FakeXhr extends EventTarget {
  open(_method: string, _url: string | URL): void {}
  send(_body?: unknown): void {
    xhrSent.push('sent');
  }
}

const wsOpened: string[] = [];
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  url: string;
  constructor(url: string) {
    this.url = url;
    wsOpened.push(url);
  }
}

resetNetGuardForTests();
window.fetch = originalFetch;
window.XMLHttpRequest = FakeXhr;
window.WebSocket = FakeWebSocket;

// ------------------------------------------------------------
// 1. 同步判定
// ------------------------------------------------------------

console.log('同步判定：');

check(!guardDecide('https://example.com/x').allowed, '外部地址被拒');
check(
  guardDecide('https://example.com/x').reason.includes('ctx.http'),
  '理由指向 ctx.http —— 插件作者需要知道"该走哪条路"，而不是只看到"网络错误"'
);
check(guardDecide('http://127.0.0.1:8080/x').allowed, '回环放行（本地开发是正当场景）');
check(guardDecide('http://localhost:3000/x').allowed, 'localhost 放行');
check(guardDecide('http://[::1]:3000/x').allowed, 'IPv6 回环放行');
check(!guardDecide('不是地址').allowed, '解析不了的地址一律拒绝（不猜）');
check(
  guardDecide('https://localhost.evil.tld/x').allowed === false,
  'localhost.evil.tld 不被当成回环 —— 这是这条规则最容易被骗过的地方'
);

// ------------------------------------------------------------
// 2. 用户的开关优先于"该走 ctx.http"
// ------------------------------------------------------------

console.log('用户的开关：');

await saveAppSettings({ offlineMode: true });
check(
  guardDecide('https://example.com/x').reason.includes('离线'),
  '离线模式下的理由是"离线"，不是"该走 ctx.http" —— 前者是用户自己的决定'
);
check(guardDecide('http://127.0.0.1:8080/x').allowed, '离线模式下回环仍然放行');
await saveAppSettings({ offlineMode: false });

await saveAppSettings({ networkPolicy: 'deny' });
check(
  guardDecide('https://example.com/x').reason.includes('禁止出站'),
  '禁止出站档下给出策略原因'
);
check(
  !guardDecide('https://example.com/x').allowed,
  '禁止出站档下外部地址被拒'
);
await saveAppSettings({ networkPolicy: 'allow' });

// 放行档下**依然**拒绝直接出站：这不是通道的开关问题，而是通道本身错了
check(
  !guardDecide('https://example.com/x').allowed,
  '放行档下直接出站仍然被拒（直接出站缺的不只是策略，还有权限检查与归属）'
);

// ------------------------------------------------------------
// 3. 包装
// ------------------------------------------------------------

console.log('包装：');

installNetGuard();
check(window.fetch !== originalFetch, 'window.fetch 已被替换');

const rejectedFetch = await rejects(() => window.fetch('https://example.com/x'));
check(rejectedFetch, '外部 fetch 抛错（调用方拿到的是异常，不是一个永远 pending 的 Promise）');
check(fetchCalls.length === 0, '原始 fetch **根本没被调用** —— 拦住与"调用了再丢弃"是两件事');

await window.fetch('http://127.0.0.1:8080/x');
check(fetchCalls.length === 1, '回环 fetch 走到了原始实现');

check(
  throws(() => new window.WebSocket('wss://example.com/socket')),
  '外部 WebSocket 构造抛错（它没有异步的错误通道，只能同步拒绝）'
);
check(wsOpened.length === 0, '外部 WebSocket 没有真的连出去');

new window.WebSocket('ws://127.0.0.1:9000/socket');
check(wsOpened.length === 1, '回环 WebSocket 走到了原始实现');

// XHR：`send()` 是同步返回的，调用方通常把 send 放在 try 之外，
// 所以拦截只能表现为一个 error 事件
const xhr = new window.XMLHttpRequest() as InstanceType<typeof FakeXhr> & {
  open: (method: string, url: string) => void;
  send: (body?: unknown) => void;
  addEventListener: (type: string, listener: () => void) => void;
};
let xhrErrored = false;
xhr.addEventListener('error', () => {
  xhrErrored = true;
});
xhr.open('GET', 'https://example.com/x');
xhr.send();
await new Promise((resolve) => setTimeout(resolve, 0));
check(xhrErrored, '外部 XHR 派发 error 事件');
check(xhrSent.length === 0, '外部 XHR 没有真的发出');

const okXhr = new window.XMLHttpRequest();
okXhr.open('GET', 'http://127.0.0.1:8080/x');
okXhr.send();
await new Promise((resolve) => setTimeout(resolve, 0));
check(xhrSent.length === 1, '回环 XHR 走到了原始实现');

// ------------------------------------------------------------
// 4. 上报与幂等
// ------------------------------------------------------------

console.log('上报与幂等：');

await new Promise((resolve) => setTimeout(resolve, 0));
check(
  host.backendCalls.includes('net_note_frontend_outbound'),
  '拒绝时向后端上报了一条（后端会用自己的规则重判，前端传的只是"发生过这件事"）'
);

setGuardSource('com.example.fixture');
check(
  !guardDecide('https://example.com/x').allowed,
  '换了来源标记不影响判定（来源只影响日志里"是谁发的"）'
);
setGuardSource(null);

const afterFirstInstall = window.fetch;
installNetGuard();
check(window.fetch === afterFirstInstall, '重复安装是幂等的（不会套上第二层包装）');

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
