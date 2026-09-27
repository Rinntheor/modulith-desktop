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
// **枚举是可用的，这一条实测过**（`staging/theme-token-probe.html`，headless
// Chrome）：在 `documentElement` 上内联写 10 个 `--accent-*`、样式表里再声明 4 个
// 设计令牌，遍历 `getComputedStyle(documentElement)` 拿到全部 14 个。
//
// ⚠️ 这里曾经被误改过一次：排查"插件主色永远是默认色"时，我一度判定
// "`CSSStyleDeclaration` 根本不枚举自定义属性"，于是把候选名字改成三个来源取并集。
// **那个判定是错的** —— 上面那次实测把它推翻了。真正的原因在文件末尾那段
// （少订阅了一个事件源）。教训与这个仓库反复记录过的一样：
// **"读源码得出的结论"要用一次实测去确认，否则会拿一个错的根因去改代码。**

import { invoke } from '@tauri-apps/api/core';
import {
  getGlassEnabled,
  getReduceMotion,
  getResolvedTheme,
  subscribeTheme,
} from './theme';
import { subscribeAccent } from './accent';

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
 * 一次**错误的根因判断**，与把它纠正过来的那次实测
 * ============================================================
 *
 * 用户报"插件主色永远是靛蓝，切主题也不变"。插件的 CSS 写的是
 * `var(--accent-600, #4f46e5)`（**带兜底值**），所以那个现象可以读成
 * "`--accent-*` 根本没送过去"。
 *
 * 我据此判定"遍历 `CSSStyleDeclaration` 不枚举自定义属性"，并把候选名字改成
 * 三个来源取并集（生产者的名单 + 样式表 + 枚举）。**那个判定是错的。**
 *
 * `staging/theme-token-probe.html` 在真实的 headless Chrome 里跑了对照：
 * 在 `documentElement` 上内联写 10 个 `--accent-*`、样式表里再声明 4 个设计令牌，
 * **旧写法（只靠枚举）拿到全部 14 个**，含 `--accent-500`。枚举是可用的。
 *
 * 于是那个三段式被撤掉了 —— 它守的是一个不存在的故障，而多出来的每一行都要有人
 * 维护。**真正的原因在文件末尾那段**（`installPluginThemeSync` 少订阅了一个事件源）。
 *
 * 留在这里的教训与这个仓库反复记录过的一样：**"读源码得出的结论"必须用一次实测
 * 确认，否则会拿一个错的根因去改代码 —— 而那样改出来的东西看起来同样合理。**
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
        '（表现为"主题配色不跟着变"）。'
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
 * 装上主题同步：**立刻推一次**，之后每次主题或配色变化再推。
 *
 * 立刻推那一次是必须的：插件可能在主题变化之前就被打开，而它拿到的入口文档
 * 依赖宿主已经收到过快照。晚一步的表现在深色主题下是一次白闪。
 *
 * ============================================================
 * ★ 为什么必须**同时**订阅主题与配色（这是一次真实故障的根因）
 * ============================================================
 *
 * 用户报："插件主色永远是靛蓝，设置里选的玫红毫无作用，切主题也不变。"
 *
 * 宿主里有**两套互不相干的通知**：
 *
 *   · `theme.ts` 的 `subscribeTheme` —— 深/浅、减少动效、毛玻璃、性能模式；
 *   · `accent.ts` 的 `subscribeAccent` —— **主色**，它有自己的 `listeners` 与
 *     自己的 `notify()`（`setAccentId` 里调）。
 *
 * 这里从前**只订阅了前者**。于是：
 *   1. 开机时推一次快照（`push()`），那一刻文档上的主色还是首帧脚本给的缓存值；
 *   2. 设置加载完 → `applySettingsToTheme()` → `setAccentId(用户选的主色)` →
 *      文档上的主色**变了**，`notify()` 也调了 —— **但这里没在听**；
 *   3. 插件于是永远停在第 1 步那一份快照上，主色永远是那个缓存值/默认值。
 *
 * 而"改深色/浅色会不会顺带把它救回来"取决于 `setThemeMode` 是否会 `notify()`：
 * 解析后的主题**没变**时它提前返回、不通知，因此大多数情况下不会。
 * 这正是"无论我主题如何变，始终靛蓝"。
 *
 * 顺带一提：`subscribeAccent` 在此之前**全仓库零个订阅者** —— 一个导出了却没人
 * 用的订阅接口，正是"某个事件源没人听"这种缺陷最容易长出来的地方。
 * 门禁因此把这两个订阅都钉住。
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
  // ★ 主色有**自己**的一套通知，主题那一路收不到它。
  subscribeAccent(push);
}
