// src/utils/motionPreference.ts
//
// 「动效是否应当停用」的**唯一**定义。
//
// 抽成独立文件的理由与 `semver.ts` / `updateCheck.ts` 相同：它是纯逻辑，
// 因此可以被 `scripts/check-performance.ts` 直接断言真值表。放在
// `services/theme.ts` 里则不行 —— 那个模块要操作 `document`，而脚本所在的
// project 刻意不带 DOM 类型（见 tsconfig.node.json 的说明）。
//
// 为什么这个判断值得单独成一个函数：应用里有两个开关（「关闭界面动画」与
// 「性能模式」），而**性能模式包含关闭动画**。合并散在 CSS 类切换、MotionConfig
// 与组件里的可见性判断三处时，任何一处都会迟早漂移，而漂移的表现恰恰是
// 「开了某个开关却没生效」—— 那正是这个功能最初要修的问题。

/**
 * 有效动效状态。
 *
 * 两个开关是**或**的关系，而且方向不对称（由调用方 `services/theme.ts` 保证）：
 * 打开性能模式会连带停用动画，而单独打开「关闭动画」不会打开性能模式 ——
 * 去毛玻璃是有明显视觉代价的取舍，不该被一个作用域更窄的开关顺手做掉。
 */
export function isMotionReduced(reduceMotion: boolean, performanceMode: boolean): boolean {
  return reduceMotion || performanceMode;
}
