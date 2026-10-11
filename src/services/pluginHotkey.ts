// src/services/pluginHotkey.ts
//
// `ctx.hotkey` 与 `ctx.selection` 在 **in-process** 这一侧的接线：
// 一张 `插件 id → 处理函数` 表、一个 Tauri 事件监听、两个平台能力探测，
// 以及"谁在订阅"这笔账。
//
// ============================================================
// 它为什么是一个独立模块（与 `pluginClipboardMonitor.ts` 同一个理由）
// ============================================================
//
// 观察按键的是 **Rust 那一侧的消息窗口**（见
// `src-tauri/src/modules/plugins/hotkey.rs`）：浏览器里没有任何 API 能让一个页面
// 在**别的程序**聚焦时收到按键。因此方向只能是宿主 → 前端，而前端接住之后要派发
// 给"这个插件注册的那些处理函数"。
//
// 由此产生两条只有这里知道的账：
//
//   1. **谁订阅了。** 宿主那张表按插件 id 记账（它决定触发时往哪几处投），而这一张
//      记的是回调。少了它，宿主会一直投递，而收到的事件没有人接。
//   2. **什么时候该告诉宿主"我不订了"。** 处理函数是逐个 `subscribe()` 加进来的，
//      而宿主那边是**按插件**记的 —— 因此只有最后一个处理函数被撤掉时才该通知宿主。
//      每撤一个就通知一次会让"同一插件还留着一个处理函数"的界面再也收不到触发。
//
// 与 `pluginClipboardMonitor.ts` 一样，这里也是那个必须在 `main.tsx` 里被安装的
// 模块：热键触发可能在插件界面挂载之前就到（`onStartup` 里注册热键并订阅），
// 丢掉的那一条会让用户按了键却没有反应。

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * 一条全局热键被按下时宿主广播的事件名。与 `rpc.rs::HOTKEY_FIRED` 逐字相同。
 *
 * 两个字符串约定漂开的表现是"插件注册成功了、宿主也投了，而处理函数一次都没被
 * 调到" —— 没有任何报错。
 */
export const HOTKEY_FIRED = 'modulith://plugin-hotkey';

/**
 * 一次热键触发的负载。
 *
 * `combo` 是**规范化之后**的组合键（`mod+q`），与 `ctx.hotkey.list()` 给出的是
 * 同一批字符串 —— 插件据此分辨是哪一条触发了（一个插件最多能注册 4 条）。
 */
export interface HotkeyFired {
  combo: string;
}

type HotkeyHandler = (fired: HotkeyFired) => void;

// ============================================================
// 平台能力
// ============================================================

/**
 * 这个平台支不支持全局热键。
 *
 * **同步回答，因此必须先探测一次。** 契约里的 `isAvailable()` 是同步方法（插件在
 * bundle 顶层用它决定要不要注册热键），而"平台支持不支持"只有宿主知道。探测发生
 * 在 `reloadPluginRuntime()` 里（与权限元数据一起，早于任何插件 bundle 执行），
 * 因此插件在顶层读到的一定是已经就绪的那一份。
 *
 * 默认 `false`：**没探测过就当作不支持**。反过来会让插件在一台非 Windows 机器上
 * 按"能注册"写代码，然后在运行期收到一串失败。
 */
let hotkeyPlatformSupported = false;

export function hotkeySupported(): boolean {
  return hotkeyPlatformSupported;
}

/** 问一次宿主"这台机器能不能注册全局热键"。失败按不支持处理，并留下一条警告。 */
export async function refreshHotkeySupport(): Promise<boolean> {
  try {
    hotkeyPlatformSupported = await invoke<boolean>('plugin_hotkey_can_register');
  } catch (error) {
    hotkeyPlatformSupported = false;
    console.warn('[pluginHotkey] 无法确认当前平台是否支持全局热键，按不支持处理：', error);
  }
  return hotkeyPlatformSupported;
}

/**
 * 这个平台支不支持读取选中文本。
 *
 * 与上面那一条**分开探测**：两者都是 Windows-only，但底层接口不同
 * （`RegisterHotKey` 与 `SendInput`），把它们合成一个布尔会让"某一个平台只有其中
 * 一个"这种将来可能出现的情况无声地判错。
 */
let selectionPlatformSupported = false;

export function selectionSupported(): boolean {
  return selectionPlatformSupported;
}

export async function refreshSelectionSupport(): Promise<boolean> {
  try {
    selectionPlatformSupported = await invoke<boolean>('plugin_selection_can_read');
  } catch (error) {
    selectionPlatformSupported = false;
    console.warn('[pluginHotkey] 无法确认当前平台是否支持读取选中文本，按不支持处理：', error);
  }
  return selectionPlatformSupported;
}

// ============================================================
// 订阅表
// ============================================================

/** `插件 id → 处理函数集合`。见文件头第 1 条。 */
const handlers = new Map<string, Set<HotkeyHandler>>();

/**
 * 登记一个处理函数，并（在这是第一个时）告诉宿主"这个插件想收触发"。
 *
 * 返回取消订阅函数。**幂等**：插件把它存进 `disposables` 之后又自己调一次是常见
 * 写法，多撤一次不该让别的处理函数跟着失效。
 */
export function subscribeHotkeyFired(pluginId: string, handler: HotkeyHandler): () => void {
  let set = handlers.get(pluginId);
  const isFirst = !set || set.size === 0;
  if (!set) {
    set = new Set<HotkeyHandler>();
    handlers.set(pluginId, set);
  }
  set.add(handler);

  if (isFirst) void askHostToSubscribe(pluginId);

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const current = handlers.get(pluginId);
    if (!current) return;
    current.delete(handler);

    // **只有最后一个处理函数离开时才通知宿主。** 宿主的订阅表按插件 id 记，
    // 提前撤会让同一插件还留着的处理函数再也收不到触发。
    if (current.size === 0) {
      handlers.delete(pluginId);
      void askHostToUnsubscribe(pluginId);
    }
  };
}

/**
 * 丢掉一个插件的全部处理函数，并让宿主一起撤掉它的订阅。
 *
 * 由 `cleanupPluginResources()` 在插件停用 / 卸载 / 重新加载时调用 —— 那些处理函数
 * 是插件 bundle 里的闭包，留着它们等于留着对已经作废代码的引用。
 *
 * ⚠️ **它不撤热键的注册。** 那件事必须由宿主按插件做（`hotkey::forget_plugin`），
 * 因为停用一个插件时它的代码一行都不会执行 —— 包括这个函数。这里只是在前端这一侧
 * 把回调摘掉，而"把那个组合键还给用户"由 `close_all_surfaces` 那条路径完成。
 */
export function clearHotkeySubscriptions(pluginId: string): number {
  const set = handlers.get(pluginId);
  if (!set) return 0;

  handlers.delete(pluginId);
  void askHostToUnsubscribe(pluginId);
  return set.size;
}

function askHostToSubscribe(pluginId: string): void {
  invoke('plugin_hotkey_subscribe', { id: pluginId }).catch((error) => {
    // 失败**必须说出来**：插件会以为自己订阅成功了（它的 `subscribe()` 没有抛），
    // 而宿主那边一次触发都不会来。这是这一层唯一能察觉这件事的地方。
    console.warn(
      `[pluginHotkey] 插件 "${pluginId}" 的热键订阅没有登记成功，它将收不到触发事件：`,
      error
    );
  });
}

function askHostToUnsubscribe(pluginId: string): void {
  invoke('plugin_hotkey_unsubscribe', { id: pluginId }).catch((error) => {
    // 这一条失败只在日志里留痕：它的后果是宿主多投一会儿，不是数据错误。
    console.warn(`[pluginHotkey] 无法撤销插件 "${pluginId}" 的热键订阅：`, error);
  });
}

// ============================================================
// 事件接线
// ============================================================

/**
 * 校验宿主广播过来的负载。**前端是最后一道** —— 但它只校验形状，不改变内容。
 *
 * `combo` 空串一律拒绝：它对应不上任何一条注册过的组合（宿主给的一定是规范化之后
 * 的非空字符串），而把空串交给插件会让它的 `switch (combo)` 走进一个谁也想不到的
 * 分支。
 */
function parsePayload(payload: unknown): { pluginId: string; fired: HotkeyFired } | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.pluginId !== 'string' || raw.pluginId.length === 0) return null;
  if (typeof raw.combo !== 'string' || raw.combo.length === 0) return null;

  return { pluginId: raw.pluginId, fired: { combo: raw.combo } };
}

/**
 * 派发一条广播。**导出是为了让门禁能直接调它**（与 `handleClipboardChange` 同理）。
 *
 * 快照之后再遍历：处理函数里退订是合法用法，边遍历边删会让 `Set` 的迭代行为变得
 * 难以推理。单个处理函数抛错**必须被隔离** —— 一个插件把整条热键通道带走，会让它
 * 自己与用户都看不到原因。
 */
export function handleHotkeyFired(payload: unknown): void {
  const parsed = parsePayload(payload);
  if (!parsed) return;

  const set = handlers.get(parsed.pluginId);
  if (!set || set.size === 0) return;

  for (const handler of [...set]) {
    try {
      handler(parsed.fired);
    } catch (error) {
      console.error(
        `[pluginHotkey] 插件 "${parsed.pluginId}" 的热键处理函数抛出异常，已隔离：`,
        error
      );
    }
  }
}

/** 装上热键触发事件的监听。返回退订函数。 */
export function installPluginHotkey(): () => void {
  const unlisteners: UnlistenFn[] = [];
  let disposed = false;

  // 宿主那一侧的窗口线程在第一次注册/订阅时自己拉起，因此这里**不需要**任何启动
  // 调用 —— 没有插件注册热键时，这条通道上一句话都不会有。
  void (async () => {
    try {
      const stop = await listen<unknown>(HOTKEY_FIRED, (event) => {
        handleHotkeyFired(event.payload);
      });
      if (disposed) {
        stop();
        return;
      }
      unlisteners.push(stop);
    } catch (error) {
      console.warn('[pluginHotkey] 无法订阅全局热键触发（热键插件将收不到触发）:', error);
    }
  })();

  return () => {
    disposed = true;
    for (const stop of unlisteners) stop();
  };
}
