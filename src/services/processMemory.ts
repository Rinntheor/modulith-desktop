// src/services/processMemory.ts
//
// 进程内存快照的前端门面。
//
// ============================================================
// 为什么需要它（而不是只看任务管理器）
// ============================================================
//
// 任务管理器能看到 `msedgewebview2.exe` 的总数，但**分不清哪些进程属于哪个应用**：
// 同一台机器上同时开着好几个 WebView2 应用时（本机实测有 13 个 msedgewebview2
// 进程分属两个应用），把别人的算到自己头上会让数字虚高一倍。
//
// 后端按**进程树**取（从宿主进程沿父子关系取下整棵子树），所以这里给出的数字
// 只包含本应用拉起来的进程。
//
// ============================================================
// 进程为什么不是"越少越好"
// ============================================================
//
// WebView2 是多进程架构：一个控件默认拉起 browser / GPU / renderer / utility /
// crashpad 共 6~8 个进程。**这是引擎的固有结构，不是我们多开了 WebView。**
// 因此界面必须把 `kind` 显示出来 —— 只给一个"进程数"会让用户以为进程多就是有问题，
// 而真正的问题只可能出现在 renderer（我们送进去的前端就在那个进程里）。
//
// GPU 进程同理：它占几十 MB 是正常的，且**不应该**用 `--disable-gpu` 关掉 ——
// 那会牺牲全部渲染性能（微软文档明确反对，只建议排障时用）。

import { invoke } from '@tauri-apps/api/core';

/**
 * 进程角色。取值与后端 `ProcessKind` 的序列化形式一一对应。
 *
 * 另有 `unknown`：命令行读不到时后端如实标记，而不是猜一个分类。
 */
export type ProcessKind =
  | 'host'
  | 'browser'
  | 'renderer'
  | 'gpu'
  | 'utility'
  | 'crashpad'
  | 'unknown';

export interface ProcessMemory {
  pid: number;
  name: string;
  kind: ProcessKind;
  /** 私有内存（private bytes）——与任务管理器"内存"列最接近的口径 */
  privateBytes: number;
  /** 工作集（物理内存中驻留的部分） */
  workingSet: number;
}

export interface MemorySnapshot {
  /** 采样时间（Unix 毫秒） */
  sampledAt: number;
  rootPid: number;
  /** 按私有内存降序 */
  processes: ProcessMemory[];
  totalPrivateBytes: number;
  totalWorkingSet: number;
  /** 取不到内存的进程数（权限不足等）。> 0 时界面必须说明数字不完整 */
  unreadable: number;
  /** 本平台是否支持进程树枚举 */
  supported: boolean;
}

/** 进程角色的中文名。界面上的措辞要与引擎文档对得上，用户去查才知道说的是什么。 */
export const PROCESS_KIND_LABELS: Record<ProcessKind, string> = {
  host: '宿主进程',
  browser: '浏览器主进程',
  renderer: '渲染进程',
  gpu: 'GPU 进程',
  utility: '工具进程',
  crashpad: '崩溃处理',
  unknown: '未识别',
};

/**
 * 某一类进程的一句话说明。
 *
 * 存在的理由是**避免误导**：用户看到"GPU 进程 40 MB"很自然会想"能不能关掉"，
 * 而正确答案是不能 —— 那句话必须出现在界面上，而不是只存在于注释里。
 */
export const PROCESS_KIND_HINTS: Partial<Record<ProcessKind, string>> = {
  host: '应用自己的进程，通常只占几 MB。它不负责渲染。',
  browser: '管理进程与网络，不渲染页面。',
  renderer: '界面就在这个进程里。它的占用才是我们能优化的部分。',
  gpu: '合成与光栅化。占几十 MB 属于正常，关掉它会牺牲全部渲染性能。',
  utility: '网络、存储、音频等服务进程，由引擎按需拉起。',
  crashpad: '崩溃处理器，常驻但几乎不占内存。',
};

/** 取一次内存快照 */
export async function getMemorySnapshot(): Promise<MemorySnapshot> {
  return invoke<MemorySnapshot>('memory_snapshot');
}
