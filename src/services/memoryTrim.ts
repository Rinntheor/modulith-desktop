// src/services/memoryTrim.ts
//
// 回收工作集的前端门面。
//
// ============================================================
// 这个功能降下来的是**哪一个**数字（必须先说清楚）
// ============================================================
//
// 进程内存有两个口径，含义完全不同：
//
//   · 私有内存（Private Bytes）：进程**提交**了多少虚拟内存。任务管理器默认的
//     "内存"列就是它。**回收工作集完全不会降低它。**
//   · 工作集（Working Set）：其中当前**驻留在物理内存里**的那部分。这才是
//     "回收"能真正降下来的数字。
//
// 因此这个模块的结果里两个口径都有，界面上也必须两个都显示。只显示私有内存会
// 让这个功能看起来完全无效；只显示工作集又会与用户打开任务管理器看到的数字对不上。
//
// 这不是推测，是本机实测的：对一个真实的 Windows 图形进程调用同一条系统调用，
// 工作集 17.0 MB → 0.0 MB，而私有内存 3.2 MB 一点没变。

import { invoke } from '@tauri-apps/api/core';

import { shouldAutoTrim } from '../utils/memoryTrimPolicy';

export { shouldAutoTrim };

/** 一次回收的结果（两个口径都是"回收前 → 回收后"） */
export interface TrimOutcome {
  supported: boolean;
  /** 尝试回收的进程数（本应用进程树） */
  attempted: number;
  /** 实际回收成功的进程数 */
  trimmed: number;
  /** 打不开或调用失败的数量。> 0 时界面要说明数字不完整 */
  failed: number;
  beforeWorkingSet: number;
  afterWorkingSet: number;
  beforePrivateBytes: number;
  afterPrivateBytes: number;
}

/**
 * 回收本应用进程树的工作集。
 *
 * 这是一次会真的改变系统状态的操作（被换出的页要在下次访问时读回来），
 * 因此**只在用户主动点击或窗口真正不可见时**调用，不要放进轮询。
 */
export async function trimMemoryNow(): Promise<TrimOutcome> {
  return invoke<TrimOutcome>('trim_memory_now');
}

/** 当前平台是否支持回收工作集 */
export async function isTrimSupported(): Promise<boolean> {
  try {
    return await invoke<boolean>('trim_memory_supported');
  } catch {
    // 命令不存在（旧后端）时如实返回"不支持"，而不是抛一个未捕获的异常
    return false;
  }
}

/**
 * 工作集实际降下来的字节数。
 *
 * **负数如实返回**：不降反升是可能的（回收期间别的进程刚好在分配），
 * 而把它钳到 0 会让"这次回收没有效果"看起来像"效果为零但确实是好的"。
 */
export function workingSetFreed(outcome: TrimOutcome): number {
  return outcome.beforeWorkingSet - outcome.afterWorkingSet;
}
