// src/services/tabDrag.ts
//
// 标签拖拽的状态：谁在被拖、指针在哪、当前会落到哪。
//
// **为什么是"自己实现"而不是 HTML5 拖放：** Tauri 的 `dragDropEnabled` 默认为
// `true`，它会拦截系统拖放，此时 **WebView 内的 HTML5 拖放整体不可用** ——
// `dragstart` / `dragover` / `drop` 这套 API 在这里根本不会正常工作
// （见 `docs/02-开发指南/插件开发/宿主API参考.md` 关于拖放的说明，以及
// 已知问题 §7.16：它正是"卡片不能拖进分组"的原因）。
//
// 症状很具体：标签一按下拖动，光标立刻变成"禁止"，而且什么都拖不动。
// 这不是"拖放配置写错了"，是那条通道在应用里不存在。
//
// 因此这里用**指针事件**实现：自己跟踪 pointermove、自己算落点、自己画一个跟随的
// 幽灵标签。`@dnd-kit`（侧边栏模块排序在用）也是同一路子，只是它的抽象对"两个标签栏
// 加两个内容区落点"这种跨容器场景偏重，这里几十行手写更直接。
//
// 状态放模块级而不是 React state：拖拽的发起方（标签）与落点（内容区）是两个互不
// 相干的组件，而 pointermove 每帧都变，放进 React state 会让整棵树每帧重渲染。

import type { TabGroupId } from './tabStore';

/**
 * 当前指针下的落点。
 *
 * * `group`：落在某条标签栏上。`index` 为具体下标，`null` 表示追加到末尾。
 * * `splitzone`：落在内容区的左半或右半 —— 这是"拖动创建分屏"的入口，
 *   未分屏时右半还没有标签栏可以放，只能靠它。
 */
export type TabDropTarget =
  | { kind: 'group'; group: TabGroupId; index: number | null }
  | { kind: 'splitzone'; zone: TabGroupId };

let dragging: string | null = null;
let pointer: { x: number; y: number } | null = null;
let dropTarget: TabDropTarget | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[tabDrag] 订阅者执行出错:', error);
    }
  });
}

export function subscribeTabDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDraggingTab(): string | null {
  return dragging;
}

export function getDragPointer(): { x: number; y: number } | null {
  return pointer;
}

export function getDropTarget(): TabDropTarget | null {
  return dropTarget;
}

export function setDraggingTab(moduleId: string | null): void {
  if (dragging === moduleId) return;
  dragging = moduleId;
  // 拖拽开始时清掉落点：否则上一次的落点会在新一次拖拽的头几帧里亮着
  if (moduleId === null) {
    pointer = null;
    dropTarget = null;
  }
  notify();
}

export function setDragPointer(next: { x: number; y: number } | null): void {
  pointer = next;
  notify();
}

export function setDropTargetTarget(next: TabDropTarget | null): void {
  // 同一个落点重复设置时不必通知：pointermove 一秒能触发上百次，
  // 每次通知都让整棵树重渲染的话，拖拽会卡。
  const same =
    (dropTarget === null && next === null) ||
    (dropTarget !== null &&
      next !== null &&
      dropTarget.kind === next.kind &&
      (dropTarget.kind === 'group' && next.kind === 'group'
        ? dropTarget.group === next.group && dropTarget.index === next.index
        : dropTarget.kind === 'splitzone' && next.kind === 'splitzone'
          ? dropTarget.zone === next.zone
          : false));

  if (same) return;
  dropTarget = next;
  notify();
}

/** 一次拖拽结束时的清理（无论成功与否都要调） */
export function clearTabDrag(): void {
  dragging = null;
  pointer = null;
  dropTarget = null;
  notify();
}
