// src/services/reminders.ts
//
// 定时提醒的前端门面。
//
// ============================================================
// 这一层的职责边界
// ============================================================
//
// 它**不做校验、不做时刻计算、不做状态推断**。三件事都刻意留给后端：
//
//   · 校验：间隔下限、标题长度、一次性提醒必须在将来 —— 这些规则要与后台宿主
//     接受的形态一致。在前端再写一份，两边迟早分叉，而分叉的表现是
//     "界面说保存成功了，后台却没有这条任务"。
//
//   · 时刻计算：**"下一次什么时候响"只从后台宿主读回来**。前端自己算一份看起来
//     很方便，但那份计算要考虑本地时区、夏令时、错过很久之后怎么补 ——
//     任何一处与后台不一致，界面就会显示一个与真实执行不同的时刻。
//
//   · 状态推断："后台没在跑"这件事由后端如实回报（`ReminderRuntimeReport.ok`），
//     而不是前端看 pid 是不是 null 去猜。
//
// 因此这里的函数几乎都是"转发 + 起个名字"，那是刻意的。

import { invoke } from '@tauri-apps/api/core';

/** 提醒的重复方式。字符串与后端 `ReminderKind` 的 camelCase 序列化一致。 */
export type ReminderKind = 'interval' | 'daily' | 'once';

/** 一条提醒的定义 */
export interface Reminder {
  id: string;
  title: string;
  body: string;
  kind: ReminderKind;
  /** 停用的提醒**不会被推送给后台**，因此它一定不会响 */
  enabled: boolean;
  /** `interval` 的间隔秒数 */
  intervalSeconds?: number | null;
  /** `daily` 的当日分钟数（0..1439，本地时间） */
  minuteOfDay?: number | null;
  /** `once` 的绝对时刻（毫秒时间戳） */
  at?: number | null;
  createdAt: number;
}

/** 新增/修改一条提醒的入参 */
export interface ReminderInput {
  id: string;
  title: string;
  body: string;
  kind: ReminderKind;
  enabled?: boolean;
  intervalSeconds?: number | null;
  minuteOfDay?: number | null;
  at?: number | null;
  createdAt?: number | null;
}

/** 后台宿主侧逐条提醒的运行状态 */
export interface ReminderRuntime {
  id: string;
  kind: string;
  name: string;
  /** 下一次触发的绝对时刻。`null` 表示不再等待触发（`once` 已经响过） */
  nextAt: number | null;
  fireCount: number;
  lastFiredAt: number | null;
}

/** 后台宿主侧的整体运行报告 */
export interface ReminderRuntimeReport {
  /** 后台宿主是否回答了这次查询 */
  ok: boolean;
  /** 没回答时的原因（最常见的是"后台未运行"） */
  error: string | null;
  /** 应用侧启用的提醒条数 */
  enabledDefinitions: number;
  /** 子进程当前是否活着 */
  hostRunning: boolean;
  runtime: ReminderRuntime[];
}

/** 列出全部提醒（定义，不含运行状态） */
export async function listReminders(): Promise<Reminder[]> {
  return invoke<Reminder[]>('list_reminders');
}

/** 新增或修改一条提醒。返回**改动后的完整列表**，前端直接整个替换缓存即可。 */
export async function saveReminder(input: ReminderInput): Promise<Reminder[]> {
  return invoke<Reminder[]>('save_reminder', { input });
}

/** 删除一条提醒，返回改动后的完整列表 */
export async function deleteReminder(id: string): Promise<Reminder[]> {
  return invoke<Reminder[]>('delete_reminder', { id });
}

/** 启用/停用一条提醒，返回改动后的完整列表 */
export async function setReminderEnabled(id: string, enabled: boolean): Promise<Reminder[]> {
  return invoke<Reminder[]>('set_reminder_enabled', { id, enabled });
}

/**
 * 读回后台宿主侧的运行状态。
 *
 * **这个调用不会拉起子进程**：后台没在跑时返回一个 `ok: false` 的报告，
 * 界面据此显示"后台未运行，当前没有在计时"。
 *
 * 它同时会报告"定义里有几条启用的、子进程只认几条"，那个差值就是同步是否跟上了
 * 的直接证据。
 */
export async function getReminderRuntime(): Promise<ReminderRuntimeReport> {
  try {
    return await invoke<ReminderRuntimeReport>('reminder_runtime');
  } catch (error) {
    // 命令本身失败（例如模块没装上）不能变成界面上一个未捕获的异常 ——
    // 这一页的职责是"如实报告后台状态"，而"报告不出来"本身就是一种状态。
    //
    // `String(error)` 而不是 `error.message`：Tauri 的 `Err` 是一个**裸字符串**，
    // 取 `.message` 会得到 `undefined`，于是界面上显示"失败：undefined"。
    return {
      ok: false,
      error: typeof error === 'string' ? error : String(error),
      enabledDefinitions: 0,
      hostRunning: false,
      runtime: [],
    };
  }
}

/**
 * 立刻触发一次某条提醒（"现在试一下"）。
 *
 * 走的是与定时器**完全相同**的链路：后台宿主发出事件 → 应用侧处理 → 通知中心里
 * 出现一条提醒。因此它是唯一能在一个动作里验证整条链路的方式。
 *
 * 失败时返回原因而不是抛错：界面要显示的是"为什么没响"。
 */
export async function runReminderNow(id: string): Promise<{ ok: boolean; error: string | null }> {
  const outcome = await invoke<{ ok: boolean; error: string | null }>('run_reminder_now', { id });
  return outcome;
}

// ============================================================
// 纯展示用的换算（**不参与判断**）
// ============================================================

/** 把当日分钟数写成 `HH:MM` */
export function formatMinuteOfDay(minute: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.floor(minute)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** 把 `HH:MM` 解析成当日分钟数；解析不出来时返回 `null`（由调用方报错） */
export function parseMinuteOfDay(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/** 把间隔秒数写成可读中文 */
export function formatInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `每 ${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
}

/** 用一句话描述一条提醒的重复方式 */
export function describeKind(reminder: Reminder): string {
  switch (reminder.kind) {
    case 'interval':
      return reminder.intervalSeconds ? formatInterval(reminder.intervalSeconds) : '每隔一段时间';
    case 'daily':
      return reminder.minuteOfDay === null || reminder.minuteOfDay === undefined
        ? '每天'
        : `每天 ${formatMinuteOfDay(reminder.minuteOfDay)}`;
    case 'once':
      return reminder.at ? `仅一次 · ${formatAbsoluteTime(reminder.at)}` : '仅一次';
    default:
      return '未知';
  }
}

/** 把绝对时刻写成 `M月D日 HH:MM` */
export function formatAbsoluteTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(
    2,
    '0'
  )}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * "还有多久"的相对描述。
 *
 * 负数（已经过去）**如实说"已过期"**，而不是显示一个负数 —— 后者在界面上
 * 会变成一个没有意义的字符组合。
 */
export function formatRelative(ms: number, now: number): string {
  const delta = ms - now;
  if (delta <= 0) return '已过期';

  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds} 秒后`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}
