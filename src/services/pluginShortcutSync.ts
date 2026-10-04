// src/services/pluginShortcutSync.ts
//
// 让宿主的快捷键在插件界面里也生效。
//
// ============================================================
// 问题
// ============================================================
//
// 键盘焦点一旦落进沙箱插件的 webview，keydown 就只在**插件自己的文档**里派发 ——
// 宿主窗口上的监听器什么都收不到。
//
// 于是用户在插件界面里按 Ctrl+K（全局搜索）、Ctrl+W（关闭标签）、Ctrl+Tab
// （切标签）会**一点反应都没有**，而同样的按键在宿主界面里是好的。
//
// ============================================================
// 这条链路的两半
// ============================================================
//
//  1. **下去**：把当前整张快捷键表推给宿主，由宿主注入插件文档。桥接层据此
//     同步判断"这个组合该不该转发" —— 那个判断不能靠 IPC 往返，那是每敲一个
//     键一次。
//  2. **上来**：桥接层转发回来的组合键，由这里查注册表并执行。
//
// 注意第 2 步**不重新判定 `allowInInput`**：桥接层已经按表里的标记判过了，
// 而这里再判一次需要知道焦点在不在输入框里 —— 而那个输入框在**另一个文档**里，
// 这边根本看不到。重复判定只会得到默认值，反而把刻意允许在输入框里生效的
// Control+K 挡掉。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getShortcuts, runShortcutByCombo, subscribeShortcuts } from './shortcutRegistry';
import { whenBackendReady } from './backendReady';

/** 与 Rust 侧 `shortcuts::ShortcutTable` 一一对应 */
interface PluginShortcutTable {
  entries: Array<{
    id: string;
    combo: string;
    normalized: string;
    description: string;
    allowInInput: boolean;
  }>;
}

/** 宿主转发插件界面里的按键时用的事件名。必须与 `rpc.rs` 的 `SHORTCUT_TRIGGERED` 一致。 */
export const SHORTCUT_TRIGGERED = 'modulith://plugin-shortcut';

/**
 * 把当前快捷键表推给宿主。**返回宿主是否认为它变了。**
 *
 * 表在插件注册表变化时会变（插件可以贡献快捷键），因此它不能只在启动时推一次。
 */
export function syncPluginShortcuts(): Promise<boolean> {
  const table: PluginShortcutTable = {
    entries: getShortcuts().map((shortcut) => ({
      id: shortcut.id,
      combo: shortcut.combo,
      // **必须用宿主自己规范化出来的那一个**：桥接层拿它做匹配，而两份
      // 规范化规则一定会漂 —— 漂开的表现是"某些组合在插件里按了没反应"。
      normalized: shortcut.normalized,
      description: shortcut.description,
      allowInInput: shortcut.allowInInput,
    })),
  };

  return invoke<boolean>('set_plugin_shortcuts', { table });
}

/** 当前的表（诊断与自检用）。 */
export function getPluginShortcuts(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('get_plugin_shortcuts');
}

let unlisten: (() => void) | null = null;
let installed = false;

/**
 * 装上快捷键同步：推一次表，并在注册表变化时重推；同时接住宿主转发回来的按键。
 *
 * **失败只记警告**：没有后端时（纯前端预览）它必然失败，而那时应用照常要能跑。
 */
export function installPluginShortcutSync(): void {
  if (installed) return;
  installed = true;

  const push = () => {
    void syncPluginShortcuts().catch((error: unknown) => {
      console.warn('[pluginShortcutSync] 推送快捷键表失败（纯前端预览下这是正常的）：', error);
    });
  };

  // 推第一次表**必须等后端就绪**（`set_plugin_shortcuts` 写宿主侧托管的表；
  // 发行版冷启动时前端跑在后端 setup 前面，见 `backendReady.ts`）。
  // 订阅**不等**：第一次真正的推送由上面那一句负责。
  void whenBackendReady().then(push);
  subscribeShortcuts(push);

  void listen<{ normalized: string; source: string }>(SHORTCUT_TRIGGERED, (event) => {
    const normalized = event.payload?.normalized;
    if (typeof normalized !== 'string') return;

    // 查不到就什么都不做：桥接层与注册表之间有一个很短的窗口（表刚变过），
    // 而在那个窗口里按下的键本来就不该触发任何动作。
    runShortcutByCombo(normalized);
  })
    .then((stop) => {
      unlisten = stop;
    })
    .catch((error: unknown) => {
      console.warn(
        '[pluginShortcutSync] 订阅快捷键转发失败（纯前端预览下这是正常的）：',
        error
      );
    });
}

/** 卸载（目前只有测试会用到；应用生命周期内一直装着）。 */
export function uninstallPluginShortcutSync(): void {
  if (!unlisten) return;
  unlisten();
  unlisten = null;
  installed = false;
}
