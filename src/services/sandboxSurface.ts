// src/services/sandboxSurface.ts
//
// 沙箱插件界面的前端门面。
//
// ============================================================
// 为什么需要这一层，而不是让插件自己在页面里画
// ============================================================
//
// 沙箱插件的界面是一个**独立的 webview**，不是 DOM 节点。因此它：
//
//   * **盖在 DOM 之上** —— 宿主自己的浮层（命令面板、通知、右键菜单）会被它挡住；
//   * **位置由宿主摆** —— 前端量出内容区矩形，交给 Rust 调 `set_position/set_size`。
//
// 前端的职责因此只有一件：**在正确的时候量出正确的矩形，并告诉宿主**。
// 矩形由前端给而不是宿主自己算，是因为只有前端知道标签栏、分屏、侧边栏当前各占多少；
// 宿主再实现一遍布局，两份一定会漂。

import { invoke } from '@tauri-apps/api/core';

/** 内容区在窗口客户区里的位置与尺寸（逻辑像素） */
export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 打开一个沙箱插件的界面。
 *
 * **已经开着时是"重新摆放"，不是错误** —— 切换标签再切回来会走到这条路径。
 * 宿主那一侧按这个语义实现（见 `sandbox::open_surface`）。
 */
export function openSandboxSurface(pluginId: string, bounds: SurfaceBounds): Promise<void> {
  return invoke('sandbox_surface_open', { pluginId, bounds });
}

/** 重新摆放。没打开时静默成功 —— 布局变化时会被无条件调用。 */
export function setSandboxSurfaceBounds(
  pluginId: string,
  bounds: SurfaceBounds
): Promise<void> {
  return invoke('sandbox_surface_bounds', { pluginId, bounds });
}

/**
 * 关掉。**没开着时也静默成功。**
 *
 * 这一条很重要：前端在卸载、隐藏、切换标签时都会调用它，把"本来就没开"当成错误
 * 会在日志里堆出一片没有信息量的噪声 —— 而噪声会让人连真的错误一起忽略。
 */
export function closeSandboxSurface(pluginId: string): Promise<void> {
  return invoke('sandbox_surface_close', { pluginId });
}
