// src/utils/memoryLevelPolicy.ts
//
// 内存目标等级的**策略**（不含任何 IPC）。
//
// 为什么与 `services/memoryLevel.ts` 分开：那份服务要 import Tauri 的 IPC，
// 因此进不了 `tsconfig.node.json` 这个纯脚本 project，而门禁脚本只能核对它的
// **文本**。策略是这条链路里最容易被悄悄改错的部分（「失焦也要降级」听起来
// 总是更省内存），所以它必须能被**直接运行** —— 那正是这个文件存在的理由。
//
// 这个文件有一条硬约束：**不得 import 任何 Tauri / React / 浏览器 API**。
//
// ============================================================
// 为什么只认「是否可见」，不认失焦
// ============================================================
//
// 失焦在桌面应用里太频繁了：用户切到浏览器查一句话、切到编辑器复制一段，
// 窗口仍在屏幕上、仍被看着，下一眼就要用。把"切走一下"当成"不再需要"，
// 换来的是**切回来时的卡顿**，而用户会把这归因成"这个软件很卡"。
//
// 最小化与隐藏则是明确的、用户主动的"从屏幕上拿开"。而这两件事在 webview 里
// 都表现为 `document.hidden` —— 因此判据只需要一个布尔量。
// 要放宽这条界限之前，先量一次"恢复需要多久"。

/**
 * 内存目标等级。与后端 `MemoryLevel` 的序列化形式一一对应。
 *
 * 只有两档，与 WebView2 自己的 `COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL` 一一对应 ——
 * 不自创中间档，因为引擎没有那个概念。
 */
export type MemoryLevel = 'low' | 'normal';

/**
 * 由文档可见性推出应当套用的等级。
 *
 * **这是后端 `level_for_visibility` 的镜像实现**，两份真值表由
 * `pnpm check:performance` 对齐（它直接跑这个函数，并核对后端的分支）。
 */
export function levelForVisibility(hidden: boolean): MemoryLevel {
  return hidden ? 'low' : 'normal';
}
