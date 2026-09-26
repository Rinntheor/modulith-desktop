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
import { buildAccentVariables, getAccentId } from './accent';

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
 *
 * ============================================================
 * 这个函数曾经只做一件事：遍历 `getComputedStyle(documentElement)`
 * ============================================================
 *
 * 旧写法假设"`CSSStyleDeclaration` 会把自定义属性也枚举出来，因此遍历一次就能拿到
 * 全部令牌"。**那个假设是错的**，而它被写成了注释里的事实 —— 于是没有任何东西
 * 去验证它。
 *
 * 用户实测的表现：插件里的主色**永远是靛蓝**，切主题也不变。原因是插件 CSS 写的
 * 是 `var(--accent-600, #4f46e5)`（带兜底值），而 `--accent-*` **根本没有被送过去** ——
 * 兜底值生效了。真正的令牌表始终是空的。
 *
 * 而"深色/浅色能跟着变"这件事当时是好的，它掩盖了这个缺陷：明暗走的是**类名**，
 * 类名由同一份快照的 `resolved` 算出来，**不看 `tokens`**。所以只测类名的那几条
 * 断言全绿，而令牌那半一直是空的。
 *
 * 现在的判据是**三个来源取并集**，任何一个能工作就够：
 *
 *   1. **生产者的名单**：`buildAccentVariables(getAccentId())` 给出的键就是主色那
 *      一套（`--accent-50` … `--accent-900`）。这不是"又维护了一份清单"——它问的
 *      是**同一个函数**它刚产出了什么，因此不可能漂。
 *   2. **样式表里声明过的**：遍历 `document.styleSheets` 收集 `:root` 规则里出现的
 *      自定义属性名。宿主的设计令牌（`--surface-*`、`--text-*` 等）都声明在那里。
 *   3. **枚举**：保留原来的遍历。在会枚举的引擎上它是上面两条之外的补充。
 *
 * 最后每一个候选名字都从 `documentElement` 上取**计算值**（`getPropertyValue`），
 * 空的一律丢掉 —— 取得到才算数，这条没有变。
 */
export function readHostTheme(): PluginThemeSnapshot {
  const tokens: Record<string, string> = {};

  if (typeof document !== 'undefined') {
    const computed = getComputedStyle(document.documentElement);

    const take = (name: string | undefined): void => {
      if (!name || !name.startsWith('--')) return;

      // Tailwind 的内部变量（`--tw-*`）是**构建产物**，不是设计令牌。
      // 传过去只会让快照里多出几十条插件永远不该引用的东西。
      if (name.startsWith('--tw-')) return;

      if (tokens[name] !== undefined) return;

      const value = computed.getPropertyValue(name).trim();
      if (value) tokens[name] = value;
    };

    // 来源 1：主色那一套。**这一条是修好那个故障的关键** ——
    // 它不依赖任何枚举行为。
    for (const name of Object.keys(buildAccentVariables(getAccentId()))) {
      take(name);
    }

    // 来源 2：样式表里声明过的自定义属性。
    //
    // 跨源样式表读 `cssRules` 会抛（CORS），因此整段包在 try 里 ——
    // 读不到不代表出错，来源 1 与 3 仍然在。
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | null = null;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        if (!rules) continue;

        for (const rule of Array.from(rules)) {
          const style = (rule as CSSStyleRule).style;
          if (!style) continue;
          for (let index = 0; index < style.length; index += 1) {
            take(style[index]);
          }
        }
      }
    } catch {
      // 样式表不可读（跨源、或引擎不给）时静默跳过：另外两个来源还在。
    }

    // 来源 3：枚举（原来的写法）。
    for (let index = 0; index < computed.length; index += 1) {
      take(computed[index]);
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
  const theme = readHostTheme();

  // 令牌表为空时**必须说出来**。
  //
  // 这是那次故障之所以活了这么久的原因：注入进插件文档的样式块**照常存在**，
  // 只是里面一条令牌都没有。于是插件的 `var(--accent-600, #4f46e5)` 全部落到
  // 兜底值上 —— 表现是"插件永远是主题的默认配色"，而**没有任何一处报错**。
  // 一句话留在这里，DevTools 里就能看见，而不是要靠"盯着插件的颜色猜"。
  if (Object.keys(theme.tokens).length === 0) {
    console.warn(
      '[pluginThemeSync] 这次读到 0 个设计令牌 —— 插件会全部落到自己 CSS 里的兜底值上' +
        '（表现为"主题配色不跟着变"）。请检查 readHostTheme 的三个来源。'
    );
  }

  return invoke<boolean>('set_plugin_theme', { theme });
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
