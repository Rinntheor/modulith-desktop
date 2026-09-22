// src/services/backgroundHost.ts
//
// 后台宿主（Node sidecar）的前端门面。
//
// ============================================================
// 它是什么，以及它现在能做什么
// ============================================================
//
// 后台宿主是一个**与界面无关的 JavaScript 运行环境**：应用要有"在窗口之外继续
// 工作"的能力（定时提醒、使用情况监测），而那些能力不能托付给主窗口的 WebView
// —— 那个环境会被降级、被隐藏、脚本会被浏览器冻结。
//
// **当前它只实现了通道**：握手、存活探测、状态上报、定时任务的定义同步、
// 以及优雅停止。定时提醒已经端到端可用（定义在应用侧、计时在后台侧的 Node 进程里）。
// 插件代码的加载与执行**仍未实现** —— 那需要先定"后台插件能用哪些能力"。
// 界面插件的 `ctx` 里有 DOM 相关的东西（fileDrop、通知浮层），后台环境里没有；
// 在把这条边界定清楚之前照搬 `ctx`，只会让插件在后台静默地半可用。
//
// 因此这里的接口同样不假装有插件执行能力。
// ============================================================
// 关于"不可用"的呈现
// ============================================================
//
// Node 运行时是随包分发的文件，而它可能缺失（打包遗漏、用户手工删掉、
// 杀毒软件隔离）。这时后台能力**明确不可用**，而界面要显示的是**具体原因**
// —— 而不是让每次调用都抛一个异常，把插件代码拖进一堆无意义的错误处理。
//
// 因此 `getBackgroundStatus()` 不抛错：它返回一个带 `reason` 的状态对象。

import { invoke } from '@tauri-apps/api/core';

export interface BackgroundStatus {
  /** 当前是否可用（Node 找得到、且子进程在运行） */
  available: boolean;
  /** 子进程当前是否活着 */
  running: boolean;
  /** 不可用或上次失败的原因。可用且没出错时为 null */
  reason: string | null;
  /** 找到的 Node 可执行文件路径 */
  nodePath: string | null;
  /** 子进程 pid（未运行时为 null） */
  pid: number | null;
  /** 本次运行累计发送的请求数 */
  requests: number;
}

export interface BackgroundCallOutcome {
  ok: boolean;
  result: unknown;
  error: string | null;
}

/**
 * 读取状态。**不启动子进程** —— 用户打开设置页看一眼，不该因此拉起一个 Node 进程。
 */
export async function getBackgroundStatus(): Promise<BackgroundStatus> {
  return invoke<BackgroundStatus>('background_host_status');
}

/**
 * 真的拉起子进程跑一次握手与存活探测。
 *
 * 这是唯一会启动子进程的入口，也是"设置里点一下试试"。
 * 失败时返回的是**原因**（`CallOutcome.error`），而不是抛错 ——
 * 界面要显示的是"为什么不可用"。
 */
export async function probeBackgroundHost(): Promise<BackgroundCallOutcome> {
  return invoke<BackgroundCallOutcome>('background_host_probe');
}

/** 主动回收后台宿主，返回回收之后的状态 */
export async function shutdownBackgroundHost(): Promise<BackgroundStatus> {
  return invoke<BackgroundStatus>('background_host_shutdown');
}
