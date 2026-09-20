// src/utils/glassPreference.ts
//
// 「毛玻璃是否应当启用」的**唯一**定义。
//
// 抽成独立文件的理由与 `motionPreference.ts` / `semver.ts` / `updateCheck.ts` 相同：
// 它是纯逻辑，因此可以被 `scripts/check-performance.ts` 直接断言真值表。放进
// `services/theme.ts` 则不行 —— 那个模块要操作 `document`，而脚本所在的 project
// 刻意不带 DOM 类型（见 tsconfig.node.json 的说明）。
//
// ---------------------------------------------------------------------------
// 两个概念，不要混为一谈
//
// 本开关管的是**浮层的毛玻璃**（对话框、菜单、抽屉、下拉面板）。窗口亚层
// —— 标题栏、标签栏、侧边栏 —— **不受它控制**，那三处已经永久不使用
// `backdrop-filter`（见 index.css 顶部与 dark-theme.css 的 `lc-chrome` 说明）。
// 原因是亚层背后永远是应用的纯色底，模糊既没有视觉效果又要每帧重新合成：
// 让一个开关去控制一件「开着也没有收益」的事，只会让用户以为自己选错了。
//
// 因此本函数返回的是「浮层毛玻璃是否启用」，而不是「界面上有没有模糊」。
// ---------------------------------------------------------------------------

/**
 * 有效毛玻璃状态。
 *
 * 与 `isMotionReduced` 同构：两个输入是**与**的关系（关闭任一即关闭），
 * 方向不对称同样由调用方 `services/theme.ts` 保证 —— 打开性能模式会连带
 * 关闭毛玻璃，而单独关闭毛玻璃不会打开性能模式。
 *
 * 方向之所以是「性能模式包含毛玻璃」而不是反过来：性能模式要解决的是
 * 「关了动画还是卡」，而毛玻璃正是那类不表现为动画、却让每帧都要重新合成
 * 的开销。要求用户为了去掉模糊再去打开一个代价更大的开关，等于把这件事藏起来。
 */
export function isGlassEnabled(glassEffect: boolean, performanceMode: boolean): boolean {
  return glassEffect && !performanceMode;
}

/** 关闭毛玻璃时挂在根元素上的类名（由 `services/theme.ts` 切换，`index.css` 消费） */
export const NO_GLASS_CLASS = 'lc-no-glass';
