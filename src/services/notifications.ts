// src/services/notifications.ts
//
// 应用内通知的前端封装。
// 后端：src-tauri/src/modules/notifications（list / push / mark_read /
// mark_all_read / dismiss / clear / summary）。
//
// 这一层解决的具体问题：在此之前 Modulith 的所有信息流都是「用户去点模块」。
// 后台模块需要用户注意时（插件加载失败、任务完成、网络不可用）没有任何通道
// 把信息送到眼前 —— 插件加载失败只写进开发者工具控制台，用户完全看不到。
//
// 两条互相独立的呈现通道：
//   * 通知中心（持久化、有未读状态、重启后仍在）—— 由本文件维护缓存；
//   * 右下角浮层提示（3 秒左右消失）—— 委托给 `toast.ts`。
// 推送时会同时走两条，除非显式传 `silent: true`。
//
// 「合并键命中的重复通知不弹浮层」是一条刻意的规则，理由：模块很容易在重试
// 循环里反复产生同一条通知（例如「网络不可用」），每次都弹会让浮层盖满屏幕，
// 用户反而错过真正的新信息。合并只影响浮层，通知中心里那条的计数仍会增长。

import { invoke } from '@tauri-apps/api/core';
import { showToast, type ToastLevel } from './toast';

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** 宿主自身（而非某个模块）发出的通知，`source` 固定为这个值 */
export const HOST_SOURCE = 'host';

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
  /** 来源模块 ID，或 `host` */
  source: string;
  /** RFC3339（UTC） */
  createdAt: string;
  read: boolean;
  /** 合并键；同键未读会被后端合并为一条 */
  dedupeKey: string | null;
  /** 被合并的次数，首条为 1 */
  count: number;
}

export interface NotificationSummary {
  total: number;
  unread: number;
}

export interface PushNotificationInput {
  title: string;
  body?: string;
  level?: NotificationLevel;
  /** 来源模块 ID，缺省为 `host` */
  source?: string;
  dedupeKey?: string;
  /** 只写入通知中心，不弹浮层提示 */
  silent?: boolean;
}

let notifications: AppNotification[] = [];
let loaded = false;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[notifications] 订阅者执行出错:', error);
    }
  });
}

function setList(next: AppNotification[]): void {
  notifications = next;
  notify();
}

/** 订阅通知列表变化（浮层与未读徽标都基于它） */
export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前通知列表（新的在前，不可变快照） */
export function getNotifications(): AppNotification[] {
  return notifications;
}

/** 是否已经从后端取过一次 */
export function isNotificationsLoaded(): boolean {
  return loaded;
}

/** 从后端读取通知列表 */
export async function loadNotifications(): Promise<AppNotification[]> {
  try {
    const list = await invoke<AppNotification[]>('list_notifications');
    loaded = true;
    setList(list);
    return list;
  } catch (error) {
    // 后端不可用（纯前端预览）不该让界面报错，按「没有通知」处理
    console.warn('[notifications] 读取通知失败:', error);
    loaded = true;
    setList([]);
    return [];
  }
}

/** 未读总数 */
export function getUnreadCount(): number {
  return notifications.reduce((sum, item) => (item.read ? sum : sum + 1), 0);
}

/** 某个来源（模块）的未读数，用于侧边栏与标签页徽标 */
export function getUnreadCountForSource(source: string): number {
  if (!source) return 0;
  return notifications.reduce(
    (sum, item) => (!item.read && item.source === source ? sum + 1 : sum),
    0
  );
}

export function getNotificationSummary(): NotificationSummary {
  return { total: notifications.length, unread: getUnreadCount() };
}

/**
 * 推送一条通知。
 *
 * 浮层提示的展示规则：`silent` 为真时完全不弹；合并键命中已有未读时不弹
 * （见文件头说明）。其他情况都会弹一次，时长由级别决定。
 */
export async function pushNotification(input: PushNotificationInput): Promise<void> {
  const level = input.level ?? 'info';

  // 先判断这次推送是否会被后端合并进已有条目 —— 必须在调用之前判断，
  // 因为调用之后缓存里已经是合并后的状态了
  const willMerge = input.dedupeKey
    ? notifications.some((item) => !item.read && item.dedupeKey === input.dedupeKey)
    : false;

  let list: AppNotification[];
  try {
    list = await invoke<AppNotification[]>('push_notification', {
      input: {
        title: input.title,
        body: input.body ?? '',
        level,
        source: input.source ?? HOST_SOURCE,
        dedupeKey: input.dedupeKey ?? null,
      },
    });
  } catch (error) {
    console.error('[notifications] 推送通知失败:', error);
    // 落盘失败时仍然弹一次浮层：用户至少该知道刚才发生了什么，
    // 只是这条不会出现在通知中心里
    if (!input.silent) {
      showToast({ title: input.title, body: input.body, level, source: input.source });
    }
    return;
  }

  setList(list);

  if (input.silent || willMerge) return;

  showToast({
    title: input.title,
    body: input.body,
    level: level as ToastLevel,
    source: input.source ?? HOST_SOURCE,
  });
}

/** 标记单条已读 */
export async function markNotificationRead(id: string): Promise<void> {
  try {
    setList(await invoke<AppNotification[]>('mark_notification_read', { id }));
  } catch (error) {
    console.error('[notifications] 标记已读失败:', error);
  }
}

/** 标记全部已读 */
export async function markAllNotificationsRead(): Promise<void> {
  try {
    setList(await invoke<AppNotification[]>('mark_all_notifications_read'));
  } catch (error) {
    console.error('[notifications] 全部标记已读失败:', error);
  }
}

/** 移除一条 */
export async function dismissNotification(id: string): Promise<void> {
  try {
    setList(await invoke<AppNotification[]>('dismiss_notification', { id }));
  } catch (error) {
    console.error('[notifications] 移除通知失败:', error);
  }
}

/** 清空全部 */
export async function clearNotifications(): Promise<void> {
  try {
    setList(await invoke<AppNotification[]>('clear_notifications'));
  } catch (error) {
    console.error('[notifications] 清空通知失败:', error);
  }
}

/**
 * 宿主自己产生通知时的便捷封装。
 *
 * 与 `pushNotification` 的唯一区别是默认 `source` 为 `host`，
 * 保留独立函数是为了让调用点的意图一眼可辨。
 */
export function notifyHost(
  title: string,
  options: Omit<PushNotificationInput, 'title' | 'source'> = {}
): Promise<void> {
  return pushNotification({ ...options, title, source: HOST_SOURCE });
}
