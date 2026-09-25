// src/services/backgroundPlugins.ts
//
// 后台（无界面）插件的前端门面。
//
// ============================================================
// 后台插件为什么需要一个"前端门面"
// ============================================================
//
// 后台插件跑在**自己的 Node 进程**里，与界面无关。但有两件事必须由界面这一侧
// 发起或接收：
//
//   1. **拉起时机** —— "装了哪些插件、谁声明了 `onStartup`"只有读完插件列表
//      才知道，而那个时机在界面这一侧。让宿主在启动时自己扫会猜一个时机，
//      而猜错的表现是"该起的没起"这种随机失败。
//   2. **跨插件事件** —— 宿主把一条事件同时送往界面侧与后台侧（见 `rpc.rs` 的
//      `events.emit`）。界面侧那一半需要有人把它接进事件总线，否则 in-process
//      与沙箱界面插件收不到后台插件发出的事件。
//
// ============================================================
// 这一层**不做**什么
// ============================================================
//
// 它不判断"哪个插件该跑"：那由 Rust 侧的 `contributes.background` 解析决定
// （它还要挡入口路径越界）。在前端再实现一遍判断只会多出一套会漂的规则 ——
// 而漂开的表现是"界面显示它会跑，实际它没跑"。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { publish } from './eventBus';

/** 一个后台插件的运行状态 */
export interface BackgroundPluginStatus {
  id: string;
  running: boolean;
  pid: number | null;
  /**
   * 是否跑在**引擎级权限**之下（Node 的 `--permission`）。
   *
   * `false` 且 `running` = 降级运行：那一层不存在，只剩 `vm` 那一层，
   * 而 `vm` 不是安全边界。界面必须把这件事说出来，而不是显示一个绿色的"运行中"。
   */
  isolated: boolean;
  uptimeMs: number;
  reason: string | null;
}

/** 清单里 `contributes.background` 的形状（与 Rust 侧的解析一一对应） */
export interface BackgroundContribution {
  entry: string;
  onStartup: boolean;
  intervalSecs: number | null;
  events: string[];
}

/** 宿主广播跨插件事件时用的 Tauri 事件名。必须与 `rpc.rs` 的 `PLUGIN_EVENT` 一致。 */
export const PLUGIN_EVENT = 'modulith://plugin-event';

/** 让"该跑的后台插件"跑起来。幂等。 */
export function syncBackgroundPlugins(): Promise<BackgroundPluginStatus[]> {
  return invoke<BackgroundPluginStatus[]>('background_plugins_sync');
}

/** 当前有哪些后台插件在跑。**不启动任何东西。** */
export function backgroundPluginStatus(): Promise<BackgroundPluginStatus[]> {
  return invoke<BackgroundPluginStatus[]>('background_plugins_status');
}

/** 手动拉起一个后台插件。 */
export function startBackgroundPlugin(id: string): Promise<void> {
  return invoke<void>('background_plugin_start', { id });
}

/** 手动停掉一个后台插件。 */
export function stopBackgroundPlugin(id: string): Promise<void> {
  return invoke<void>('background_plugin_stop', { id });
}

/**
 * 一个插件的后台声明（没有则为 `null`）。
 *
 * 走宿主的解析而不是在前端读清单：入口路径的合法性（不能跳出插件目录）
 * 由 Rust 侧判定，而那是**放行目录**的依据，不能有两份判断。
 */
export function pluginBackgroundContribution(
  id: string
): Promise<BackgroundContribution | null> {
  return invoke<BackgroundContribution | null>('plugin_background_contribution', { id });
}

let unlisten: (() => void) | null = null;

/**
 * 把宿主广播的跨插件事件接进事件总线。
 *
 * ============================================================
 * 为什么"装不上"只记警告
 * ============================================================
 *
 * 与通知中心那一处同样的取向：订阅失败不该让人打不开应用。纯前端预览
 * （`vite dev` 里没有 Tauri）下它必然失败，而那时应用照常要能跑起来。
 *
 * 返回的取消函数是幂等的 —— 重复调用它不会抛错。
 */
export async function subscribePluginEvents(): Promise<() => void> {
  if (unlisten) return unlisten;

  try {
    const stop = await listen<{ source: string; name: string; payload: unknown }>(
      PLUGIN_EVENT,
      (event) => {
        const { source, name, payload } = event.payload ?? {};

        // 名字与来源都必须存在：一条缺了来源的事件会让订阅者无法判断
        // "这是谁发的"，而事件总线的 `source` 正是用来做那个判断的。
        if (typeof name !== 'string' || typeof source !== 'string') return;

        publish(name, payload, `plugin:${source}`);
      }
    );

    unlisten = () => {
      stop();
      unlisten = null;
    };
    return unlisten;
  } catch (error) {
    console.warn(
      '[backgroundPlugins] 订阅跨插件事件失败（纯前端预览下这是正常的）：',
      error
    );
    return () => {};
  }
}
