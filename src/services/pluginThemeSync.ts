// src/services/pluginThemeSync.ts
//
// 把宿主的主题推给插件系统。
//
// ============================================================
// 为什么要有这个文件
// ============================================================
//
// 沙箱插件的界面跑在**另一个 webview** 里，与宿主文档没有任何继承关系：它拿不到
// 宿主的 CSS 变量，也拿不到"用户在这个应用里选的是浅色还是深色"（`prefers-color-scheme`
// 反映的是**操作系统**的设置，而用户可以在这里单独覆盖）。
//
// 不把主题送过去的结果是插件只能自己猜，猜错的表现是**插件比宿主亮一档或暗一档** ——
// 用户看到的是"这个插件与整个应用不是一套的"，而插件作者那边什么都看不出来。
//
// 主题的**真源在宿主文档里**（那一堆 CSS 自定义属性），而 Rust 那一侧没有
// `document` 可读。因此方向只能是：前端读出来 → 推给宿主 → 宿主注入插件文档。
//
// ============================================================
// 为什么是"遍历 getComputedStyle"而不是维护一张令牌表
// ============================================================
//
// 在 JS 里再列一份令牌清单意味着每加一个 CSS 变量都要记得往那份清单里补一条，
// 而漏补**不会报错** —— 插件那边只是拿不到那个变量，表现为某一处颜色退回
// 浏览器默认值，而那是最难被归因的一类缺陷。
//
// Chromium 的 `CSSStyleDeclaration` 会把自定义属性也枚举出来，因此遍历一次
// 就能拿到"样式表里实际生效的全部令牌"。宿主改设计系统时，这个文件一行都不用改。

import { invoke } from '@tauri-apps/api/core';
import {
  getGlassEnabled,
  getReduceMotion,
  getResolvedTheme,
  subscribeTheme,
} from './theme';

/** 与 Rust 侧 `theme::ThemeSnapshot` 一一对应 */
export interface PluginThemeSnapshot {
  resolved: string;
  reduceMotion: boolean;
  glass: boolean;
  tokens: Record<string, string>;
}

/**
 * 读出宿主文档当前的真实主题。
 *
 * 导出是为了让它可被单独测试 —— 它是这个文件里唯一有判断的部分。
 */
export function readHostTheme(): PluginThemeSnapshot {
  const tokens: Record<string, string> = {};

  if (typeof document !== 'undefined') {
    const computed = getComputedStyle(document.documentElement);

    for (let index = 0; index < computed.length; index += 1) {
      const name = computed[index];

      // 只收自定义属性。标准属性有几百条，而且它们描述的是宿主自己的布局 ——
      // 与插件无关，只会把快照撑成几十 KB。
      if (!name.startsWith('--')) continue;

      // Tailwind 的内部变量（`--tw-*`）是**构建产物**，不是设计令牌。
      // 传过去只会让快照里多出几十条插件永远不该引用的东西。
      if (name.startsWith('--tw-')) continue;

      const value = computed.getPropertyValue(name).trim();
      if (value) tokens[name] = value;
    }
  }

  return {
    resolved: getResolvedTheme(),
    reduceMotion: getReduceMotion(),
    glass: getGlassEnabled(),
    tokens,
  };
}

/**
 * 推一次当前主题。
 *
 * **返回是否真的变了** —— 去重在 Rust 侧（`PluginTheme::set`），因为"真的变了
 * 没有"的判据属于那份快照本身，而不是属于调用方。每一次"真的变了"都会触发
 * 一圈 `eval` 推给所有已打开的插件界面。
 */
export function syncPluginTheme(): Promise<boolean> {
  return invoke<boolean>('set_plugin_theme', { theme: readHostTheme() });
}

/** 当前的主题快照（诊断与自检用）。 */
export function getPluginTheme(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('get_plugin_theme');
}

let installed = false;

/**
 * 装上主题同步：**立刻推一次**，之后每次主题变化再推。
 *
 * 立刻推那一次是必须的：插件可能在主题变化之前就被打开，而它拿到的入口文档
 * 依赖宿主已经收到过快照。晚一步的表现在深色主题下是一次白闪。
 *
 * **失败只记警告**：没有后端时（纯前端预览）它必然失败，而那时应用照常要能跑。
 */
export function installPluginThemeSync(): void {
  if (installed) return;
  installed = true;

  const push = () => {
    void syncPluginTheme().catch((error: unknown) => {
      console.warn('[pluginThemeSync] 推送主题失败（纯前端预览下这是正常的）：', error);
    });
  };

  push();
  subscribeTheme(push);
}
