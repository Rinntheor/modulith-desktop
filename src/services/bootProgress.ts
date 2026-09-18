// src/services/bootProgress.ts
//
// 启动进度的**纯计算**：不依赖 React / Tauri / 浏览器环境，
// 因此可以被独立验证（见仓库中的进度数学校验）。
//
// 这里刻意做成零依赖模块：启动进度是整个加载界面的核心承诺
// （「显示的是真实进度」），把它隔离出来才能单独证明它没有骗人。

export type BootPhase = 'idle' | 'running' | 'awaiting-auth' | 'ready' | 'failed';

export type BootStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

/** 计算进度所需的最小步骤信息 */
export interface BootProgressStep {
  status: BootStepStatus;
  /** 已完成的工作单元数 */
  unitsDone: number;
  /** 总工作单元数（0 表示不可细分） */
  unitsTotal: number;
}

/**
 * 按权重把各步骤的真实完成量折算成总进度（0-100）。
 *
 * 规则：
 *   * done / skipped 的步骤按整步计入；
 *   * 其余步骤按 `unitsDone / unitsTotal` 计入（没有单元信息则为 0）；
 *   * 未就绪前最多返回 99，避免出现「卡在 100%」的观感；
 *   * 任何情况下都不会因为某步失败而回退已完成的部分（进度单调）。
 */
export function computeBootProgress(
  steps: BootProgressStep[],
  weights: number[],
  phase: BootPhase
): number {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return phase === 'ready' ? 100 : 0;

  let weighted = 0;

  steps.forEach((step, index) => {
    const weight = weights[index] ?? 0;
    let fraction = 0;

    if (step.status === 'done' || step.status === 'skipped') {
      fraction = 1;
    } else if (step.unitsTotal > 0) {
      fraction = Math.min(1, Math.max(0, step.unitsDone / step.unitsTotal));
    }

    weighted += weight * fraction;
  });

  const percent = (weighted / totalWeight) * 100;
  return phase === 'ready' ? 100 : Math.min(99, Math.round(percent));
}
