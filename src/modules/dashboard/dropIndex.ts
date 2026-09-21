// src/modules/dashboard/dropIndex.ts
//
// 拖动落点的下标换算。**纯函数** —— 因此可以被 `pnpm check:memory` 直接断言。
//
// ---------------------------------------------------------------------------
// 它解决的是一个只在"向下拖"时出现的错位
//
// 拖动过程中算出的落点下标，是按**模块还在原处**的那个列表数出来的；而后端
// (`config::place_module`) 是**先摘掉再插入**。两者在同一个分类内向下拖时会差一位：
//
//   [a, b, c]   把 a 拖到 b 与 c 之间
//     落点下标 = 2（"插在 c 之前"）
//     摘掉 a 之后 → [b, c]，插入到 2 → [b, c, a]     ← 错的
//     正确的位置是 1 → [b, a, c]
//
// 向上拖不需要换算（`[a,b,c]` 把 c 拖到 a 之前，落点 0，摘掉后插到 0 仍是对的），
// 跨分类也不需要（源列表与目标列表是两个数组）。
//
// 这就是它值得单独抽出来的理由：**只在半数方向上错**的缺陷，手工试两下很容易
// 恰好试到对的那一半。
// ---------------------------------------------------------------------------

/** 一次拖动落点：去哪个分类（`null` = 未分类）、插在第几位 */
export interface DropTarget {
  categoryId: string | null;
  index: number;
}

/** 模块当前所在的位置 */
export interface SlotLocation {
  categoryId: string | null;
  index: number;
}

/**
 * 把拖动时算出的落点下标换算成"移除之后"的下标。
 *
 * `source` 为空表示这个模块当前不在任何分区里可见（例如它刚刚被隐藏）——
 * 那时不需要换算，直接把落点交给后端即可。
 */
export function resolveDropIndex(source: SlotLocation | undefined, target: DropTarget): number {
  if (!source) return target.index;
  if (source.categoryId !== target.categoryId) return target.index;
  if (source.index < target.index) return target.index - 1;
  return target.index;
}
