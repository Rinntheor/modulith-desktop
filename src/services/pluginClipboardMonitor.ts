// src/services/pluginClipboardMonitor.ts
//
// in-process 插件的剪贴板**变化**在本 realm 这一侧的接线：一张
// `插件 id → 处理函数` 表、一个 Tauri 事件监听、以及"谁在订阅"这笔账。
//
// ============================================================
// 它为什么是一个独立模块（与 `pluginUiState.ts` 同一个理由）
// ============================================================
//
// 观察剪贴板变化的是 **Rust 那一侧的 Win32 轮询**（见
// `src-tauri/src/modules/plugins/clipboard.rs`）：`navigator.clipboard` 只回答
// "现在是什么"，不回答"变过没有"。因此方向只能是宿主 → 前端，而前端接住之后要
// 派发给"这个插件注册的那些处理函数"。
//
// 由此产生两条只有这里知道的账：
//
//   1. **谁订阅了。** 宿主那张表按插件 id 记账（它决定轮询线程起不起），而这一张
//      记的是回调。少了它，宿主会一直轮询，而收到的事件没有人接。
//   2. **什么时候该告诉宿主"我不订了"。** 处理函数是逐个 `subscribe()` 加进来的，
//      而宿主那边是**按插件**记的 —— 因此只有最后一个处理函数被撤掉时才该通知宿主。
//      每撤一个就通知一次会让"同一插件还留着一个处理函数"的界面再也收不到变化。
//
// 与 `pluginUiState.ts` 一样，这里也是那个必须在 `main.tsx` 里被安装的模块：
// 事件可能在插件界面挂载之前就到（`onStartup` 里跑索引），丢掉的那一条会让一份
// 剪贴板历史永远缺一段。

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** 宿主观察到一次剪贴板变化时广播的事件名。与 `rpc.rs::CLIPBOARD_CHANGE` 逐字相同。 */
export const CLIPBOARD_CHANGE = 'modulith://plugin-clipboard-change';

/**
 * 一次剪贴板变化。**形状是冻结的**（见宿主侧 `clipboard::Change`）。
 *
 * `text` 为 `null` 表示剪贴板上**没有文本**（例如只复制了一张图），而不是空串 ——
 * 空串是一个合法取值（用户复制了一段空内容），两者必须分得开。
 *
 * ⚠️ `text` 最多 64 KiB（UTF-8 字节），超出部分被截断，而且**没有标志位**。
 * 需要判断时按上限自检：长度接近上限就当成可能不完整。
 */
export interface ClipboardChange {
  text: string | null;
  formats: string[];
  at: number;
}

type ClipboardHandler = (change: ClipboardChange) => void;

// ============================================================
// 平台能力
// ============================================================

/**
 * 这个平台支不支持剪贴板监测。
 *
 * **同步回答，因此必须先探测一次。** 契约里的 `canMonitor()` 是同步方法（插件用它
 * 做特性探测，不必为了问一句话去 await），而"平台支持不支持"只有宿主知道。
 * 探测发生在 `reloadPluginRuntime()` 里（与权限元数据一起，早于任何插件 bundle
 * 执行），因此插件在顶层读到的一定是已经就绪的那一份。
 *
 * 默认 `false`：**没探测过就当作不支持**。反过来（默认 true）会让插件在一台
 * 非 Windows 机器上按"能监测"写代码，然后在运行期收到一串失败。
 */
let platformSupported = false;

export function clipboardMonitorSupported(): boolean {
  return platformSupported;
}

/** 问一次宿主"这个平台支不支持"。失败按不支持处理，并留下一条警告。 */
export async function refreshClipboardMonitorSupport(): Promise<boolean> {
  try {
    platformSupported = await invoke<boolean>('plugin_clipboard_can_monitor');
  } catch (error) {
    platformSupported = false;
    console.warn(
      '[pluginClipboardMonitor] 无法确认当前平台是否支持剪贴板监测，按不支持处理：',
      error
    );
  }
  return platformSupported;
}

// ============================================================
// 订阅表
// ============================================================

/** `插件 id → 处理函数集合`。见文件头第 1 条。 */
const handlers = new Map<string, Set<ClipboardHandler>>();

/**
 * 登记一个处理函数，并（在这是第一个时）告诉宿主要开始监测了。
 *
 * 返回取消订阅函数。**幂等**：插件把它存进 `disposables` 之后又自己调一次是常见
 * 写法，多撤一次不该让别的处理函数跟着失效。
 */
export function subscribeClipboardChanges(
  pluginId: string,
  handler: ClipboardHandler
): () => void {
  let set = handlers.get(pluginId);
  const isFirst = !set || set.size === 0;
  if (!set) {
    set = new Set<ClipboardHandler>();
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
    // 提前撤会让同一插件还留着的处理函数再也收不到变化。
    if (current.size === 0) {
      handlers.delete(pluginId);
      void askHostToUnsubscribe(pluginId);
    }
  };
}

/**
 * 丢掉一个插件的全部处理函数，并让宿主一起停掉它的订阅。
 *
 * 由 `cleanupPluginResources()` 在插件停用 / 卸载 / 重新加载时调用 —— 那些处理函数
 * 是插件 bundle 里的闭包，留着它们等于留着对已经作废代码的引用，而宿主那一侧的
 * 轮询线程也就永远退不出去。
 */
export function clearClipboardSubscriptions(pluginId: string): number {
  const set = handlers.get(pluginId);
  if (!set) return 0;

  handlers.delete(pluginId);
  void askHostToUnsubscribe(pluginId);
  return set.size;
}

function askHostToSubscribe(pluginId: string): void {
  invoke('plugin_clipboard_subscribe', { id: pluginId }).catch((error) => {
    // 失败**必须说出来**：插件会以为自己订阅成功了（它的 `subscribe()` 没有抛），
    // 而宿主那边一条变化都不会来。这是这一层唯一能察觉这件事的地方。
    console.warn(
      `[pluginClipboardMonitor] 插件 "${pluginId}" 的剪贴板订阅没有登记成功，` +
        `它将收不到变化事件：`,
      error
    );
  });
}

function askHostToUnsubscribe(pluginId: string): void {
  invoke('plugin_clipboard_unsubscribe', { id: pluginId }).catch((error) => {
    // 这一条失败只在日志里留痕：它的后果是宿主多轮询一会儿，不是数据错误。
    console.warn(`[pluginClipboardMonitor] 无法撤销插件 "${pluginId}" 的剪贴板订阅：`, error);
  });
}

// ============================================================
// 事件接线
// ============================================================

/** 校验宿主广播过来的负载。**前端是最后一道** —— 但它只校验形状，不改变内容。 */
function parsePayload(payload: unknown): { pluginId: string; change: ClipboardChange } | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.pluginId !== 'string' || raw.pluginId.length === 0) return null;

  const change = raw.change;
  if (!change || typeof change !== 'object') return null;
  const fields = change as Record<string, unknown>;

  // `null` 与字符串都合法（`null` = 剪贴板上没有文本），其余一律拒绝 ——
  // 把一个 `undefined` 交给插件会让它读到 `change.text === undefined`，而它对
  // "没有文本"的判断通常是 `=== null`，于是走进错误的那个分支。
  const text = fields.text === null || typeof fields.text === 'string' ? fields.text : null;
  const formats = Array.isArray(fields.formats)
    ? fields.formats.filter((item): item is string => typeof item === 'string')
    : [];
  const at = typeof fields.at === 'number' && Number.isFinite(fields.at) ? fields.at : Date.now();

  return { pluginId: raw.pluginId, change: { text, formats, at } };
}

/**
 * 派发一条广播。**导出是为了让门禁能直接调它**（与 `handlePluginUiEvent` 同理）。
 *
 * 快照之后再遍历：处理函数里退订是合法用法，边遍历边删会让 `Set` 的迭代行为变得
 * 难以推理。单个处理函数抛错**必须被隔离** —— 一个插件把整条剪贴板通道带走，
 * 会让它自己与用户都看不到原因。
 */
export function handleClipboardChange(payload: unknown): void {
  const parsed = parsePayload(payload);
  if (!parsed) return;

  const set = handlers.get(parsed.pluginId);
  if (!set || set.size === 0) return;

  for (const handler of [...set]) {
    try {
      handler(parsed.change);
    } catch (error) {
      console.error(
        `[pluginClipboardMonitor] 插件 "${parsed.pluginId}" 的剪贴板处理函数抛出异常，已隔离：`,
        error
      );
    }
  }
}

/** 装上剪贴板变化事件的监听。返回退订函数。 */
export function installPluginClipboardMonitor(): () => void {
  const unlisteners: UnlistenFn[] = [];
  let disposed = false;

  // 宿主那边在第一次订阅时会自己拉起轮询线程，因此这里**不需要**任何启动调用 ——
  // 没有插件订阅时，这条通道上一句话都不会有。
  void (async () => {
    try {
      const stop = await listen<unknown>(CLIPBOARD_CHANGE, (event) => {
        handleClipboardChange(event.payload);
      });
      if (disposed) {
        stop();
        return;
      }
      unlisteners.push(stop);
    } catch (error) {
      console.warn('[pluginClipboardMonitor] 无法订阅剪贴板变化（剪贴板历史将不可用）:', error);
    }
  })();

  return () => {
    disposed = true;
    for (const stop of unlisteners) stop();
  };
}
