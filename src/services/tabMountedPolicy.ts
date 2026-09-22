// src/services/tabMountedPolicy.ts
//
// 标签「已挂载集合」的收缩规则。
//
// 为什么单独成文件：这是本项目里**唯一一处会真正释放模块内存**的判定，
// 而它此前写错了 —— 挂载集合只增不减，于是关闭标签不会卸载面板，
// 连带让 `moduleComponentCache` 的逐条释放变成死代码（判据恒为 false）。
//
// 那处缺陷之所以能长期存在，是因为验证它的脚本只能做**文本核对**：
// `tabStore.ts` 会 import Tauri 的 IPC，进不了 `tsconfig.node.json` 这个纯脚本
// project，所以脚本只能检查"`setState` 里出现了 `releaseCachedModuleComponent`"
// —— 而缺陷代码三项全过。把规则抽到这里之后，脚本可以**直接调用它**断言行为。
//
// 因此这个文件有一条硬约束：**不得 import 任何 Tauri / React / 浏览器 API**，
// 只允许纯数据进出。否则它就又变回了"不能被验证"的那种代码。

/**
 * 由「上一轮的挂载集合」与「这一轮真正打开着的标签」推出新的挂载集合。
 *
 * 规则：
 *   1. **只有仍然打开着的标签才保留挂载**。标签一关，面板就该卸载 —— 否则
 *      `Home` 会继续渲染它，DOM 子树、React 树、模块内部的定时器与订阅全都活着。
 *   2. 去重。原实现是靠"补齐前先 `includes` 判一次"隐式保证的，那种保护在
 *      重构时会被无声丢掉，所以这里显式做。
 *   3. 保留原有的相对顺序（它决定 `Home` 里面板的渲染顺序，跨组拖动时顺序不能抖）。
 *   4. 两组的激活标签**必定在结果里** —— `Home` 只渲染 `mountedTabs` 里的面板，
 *      「激活了但没挂载」表现为标签栏高亮着、内容区却空白。
 *
 * 注意 `setState` 里的顺序是**先裁剪、再用激活标签补齐**：反过来的话，
 * 已经被关闭的标签会因为"它是上一个激活项"而被自己救回来。
 *
 * 【保活语义的边界】本函数只裁掉**已经从标签栏消失**的模块。仍然打开、
 * 只是**当前未被激活**的标签不会被裁 —— 那部分保活（滚动位置、未提交表单）
 * 是本项目的核心体验承诺，由另一个机制负责：
 * 内存压力下的 **LRU 淘汰**（见 `TAB_EVICTION`）。两者是不同的东西：
 *   · 这里 = 「关闭即释放」（语义正确性，必须永远成立）
 *   · 淘汰 = 「打开着但太久没看就回收」（内存策略，可配置、可关闭）
 */
export function pruneMountedTabs(
  mounted: readonly string[],
  openTabs: readonly string[],
  splitTabs: readonly string[],
  activeTab: string | null,
  splitActive: string | null
): string[] {
  const live = new Set<string>([...openTabs, ...splitTabs]);
  const next: string[] = [];
  const seen = new Set<string>();

  for (const id of mounted) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }

  for (const id of [activeTab, splitActive]) {
    if (id && live.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }

  return next;
}
