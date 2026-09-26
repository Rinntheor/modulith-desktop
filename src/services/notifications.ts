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
import { showToast, type ToastLevel, type ToastVariant } from './toast';
import { playNotificationSound } from './sound';

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * 通知类别。与 `level`（重要程度）正交：类别决定这条通知**是不是一类特殊的东西**，
 * 需要有别于普通通知的呈现与动作。取值必须与后端
 * `modules/notifications/store.rs` 的 `NotificationCategory` 一致（kebab-case）。
 */
export type NotificationCategory = 'general' | 'app-update';

/** 宿主自身（而非某个模块）发出的通知，`source` 固定为这个值 */
export const HOST_SOURCE = 'host';

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
  category: NotificationCategory;
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
  category?: NotificationCategory;
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

/**
 * 后端通知列表变化时广播的事件名。
 *
 * 必须与 `src-tauri/src/modules/notifications/commands.rs` 的
 * `NOTIFICATIONS_CHANGED_EVENT` 一致 —— 两者是**同一份契约的两侧**，
 * 而没有任何编译器把它们联系在一起。`pnpm check:notifications` 把它钉住。
 */
export const NOTIFICATIONS_CHANGED_EVENT = 'modulith://notifications-changed';

/**
 * 订阅后端的"通知列表变了"事件。
 *
 * ============================================================
 * 为什么需要它（这是"通知存在但界面不知道"的缺口）
 * ============================================================
 *
 * 在它之前，**后端产生一条通知时前端完全不知道**：前端只在"自己调用了某个
 * 通知命令"之后才刷新缓存。于是任何**不是由界面发起**的通知都不会出现在
 * 通知中心里 —— 后台宿主的定时提醒、启动阶段的插件加载失败都属于这一类。
 *
 * 具体表现：一条通知已经落盘、`get_notification_summary` 也会把它算进未读数，
 * 但铃铛徽标不变、列表里也看不到，直到用户碰巧触发了某次刷新。
 *
 * 之所以用事件而不是轮询：轮询要为一件大多数时候什么都不发生的事情持续付出
 * 代价（IPC + 序列化整份列表），而事件只在真的变化时发一次。
 */
export async function subscribeBackendNotificationEvents(): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen(NOTIFICATIONS_CHANGED_EVENT, () => {
      // 事件不带负载：**列表本身仍然从后端读**。
      // 把列表放进事件负载会让"哪一份是权威"变成两个可能不一致的来源，
      // 而通知列表本来就有一条明确的读取路径。
      void loadNotifications();
    });
    return unlisten;
  } catch (error) {
    // 取不到事件 API（纯前端预览 / 旧版运行时）不该让界面报错。
    // 退化成"只有自己调用时才会看到新通知"，与这个订阅存在之前的行为一致。
    console.warn('[notifications] 无法订阅后端通知事件:', error);
    return () => {};
  }
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
  // 变化之前就已经在列表里的 id。用它把"这次新出现的"挑出来 —— 后端只发一条
  // "列表变了"的事件，不带负载，因此**新在哪几条**只能这样算出来。
  const knownIds = new Set(notifications.map((item) => item.id));
  const hadLoadedOnce = loaded;

  try {
    const list = await invoke<AppNotification[]>('list_notifications');
    loaded = true;
    setList(list);

    // ============================================================
    // 后端产生的通知也要**弹浮层 + 响提示音**
    // ============================================================
    //
    // 从前这里只有 `setList`，于是任何**不是由前端发起**的通知都是静默的：
    // 它进了通知中心、未读数也变了，但用户当时什么都感觉不到 —— 直到自己
    // 碰巧去打开通知列表。用户实测报的就是这一条（"通知信息是发在通知里面了，
    // 但是我们发现没有提醒，没有铃声提醒，也没有弹窗提醒"）。
    //
    // 判据是"**新出现的**且未读"：
    //   · 按 id 比对，而不是看 `count` —— 后端合并同键通知时 id 不变，
    //     于是"重试循环里反复产生的同一条"不会每次都响（那会从提醒变成骚扰）；
    //   · 首次加载时 `hadLoadedOnce` 为假，**不弹**：否则启动那一刻会把
    //     历史上所有未读通知一起弹一遍。
    if (hadLoadedOnce) {
      for (const item of list) {
        if (knownIds.has(item.id) || item.read) continue;

        presentNotification(
          {
            title: item.title,
            body: item.body,
            level: item.level as ToastLevel,
            variant: toastVariantFor(item.category),
            source: item.source,
          },
          item.id
        );
      }
    }

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
 * 呈现一条**新通知**：弹浮层 + 响提示音。
 *
 * 两者收在同一个函数里是有意的：它们是同一条规则的两种呈现，都表示「出现了一条
 * 你还没看到的信息」。分开判断迟早会出现「弹了浮层但没响」或「响了一声却找不到
 * 是什么」—— 而这类不一致正是本项目反复记录过的那种缺陷。
 *
 * 调用点只有下面两处，且都在 `silent` / `willMerge` 的早退之后：声音与浮层
 * 共享同一组例外。其中「合并键命中不响」尤其重要 —— 模块在重试循环里反复产生
 * 同一条通知时，每次都响一声会从提醒变成骚扰。
 */
function presentNotification(
  input: {
    title: string;
    body?: string;
    level: ToastLevel;
    variant: ToastVariant;
    source: string;
  },
  /**
   * 这条通知的 id（知道就给）。给出来就能保证**一条通知只弹一次**。
   *
   * ============================================================
   * 为什么需要它
   * ============================================================
   *
   * 现在有**两条**路会把一条通知呈现在用户面前：
   *
   *   1. 前端自己调的 `pushNotification`（宿主模块产生的通知走这条）；
   *   2. **后端**产生的通知 —— 插件通过 `ctx.notifications.show(...)`、后台插件
   *      的定时提醒都属于这一类。它们落盘之后只发一条"列表变了"的事件，前端
   *      以前**只刷新列表、不弹浮层也不响**。
   *
   * 第 2 条是用户实测报上来的：通知进了通知中心，但没有提醒、没有声音、也没有
   * 弹窗。而第 1 条本来就会弹 —— 因此修好第 2 条之后，同一条通知可能被两条路
   * 各弹一次（两声、两个浮层）。按 id 去重是唯一可靠的办法：两条路看到的是
   * **同一个** id，而"是不是同一条通知"正是它定义的东西。
   */
  id?: string
): void {
  if (id !== undefined) {
    if (presentedIds.has(id)) return;
    presentedIds.add(id);
  }

  showToast(input);
  playNotificationSound();
}

/**
 * 已经呈现过的通知 id。
 *
 * 只增不减：一份通知 id 在这条进程的生命周期里唯一，而"释放"它的唯一时机是
 * 通知被删掉 —— 那时它也不会再被呈现一次。做成有界缓存只会多出一处"什么时候
 * 该淘汰"的判断，而这个集合的大小上界就是本次运行收到的通知条数。
 */
const presentedIds = new Set<string>();

/**
 * 推送一条通知。
 *
 * 浮层提示的展示规则：`silent` 为真时完全不弹；合并键命中已有未读时不弹
 * （见文件头说明）。其他情况都会弹一次，时长由级别与变体决定。
 */
export async function pushNotification(input: PushNotificationInput): Promise<void> {
  const level = input.level ?? 'info';
  const category = input.category ?? 'general';

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
        category,
        source: input.source ?? HOST_SOURCE,
        dedupeKey: input.dedupeKey ?? null,
      },
    });
  } catch (error) {
    console.error('[notifications] 推送通知失败:', error);
    // 落盘失败时仍然弹一次浮层：用户至少该知道刚才发生了什么，
    // 只是这条不会出现在通知中心里
    if (!input.silent) {
      presentNotification({
        title: input.title,
        body: input.body,
        level,
        variant: toastVariantFor(category),
        source: input.source ?? HOST_SOURCE,
      });
    }
    return;
  }

  setList(list);

  // 记下这一次推送落成了哪一条。**必须在呈现之前算出来**：`loadNotifications`
  // 那条路（后端变化事件）会按 id 判断"是不是新的"，而它和这一条说的是同一条
  // 通知 —— 不告诉它的话，同一条会被弹两次、响两声。
  //
  // 有合并键时认键，否则认最新的一条（列表是最新在前）。
  const justPushed = input.dedupeKey
    ? list.find((item) => item.dedupeKey === input.dedupeKey)
    : list[0];

  if (input.silent || willMerge) return;

  presentNotification(
    {
      title: input.title,
      body: input.body,
      level: level as ToastLevel,
      variant: toastVariantFor(category),
      source: input.source ?? HOST_SOURCE,
    },
    justPushed?.id
  );
}

/**
 * 类别 → 浮层变体。
 *
 * 映射写在这里而不是让调用方自己传变体：类别是持久化在通知里的信息，
 * 变体是它的呈现结果，两者分开传迟早会出现「存的是更新、弹的是普通」。
 * 之所以不让 `toast.ts` 直接认识 `NotificationCategory`，是因为
 * `notifications.ts` 已经 import 了 `toast.ts` —— 反向依赖会成环。
 */
function toastVariantFor(category: NotificationCategory): ToastVariant {
  return category === 'app-update' ? 'update' : 'default';
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
