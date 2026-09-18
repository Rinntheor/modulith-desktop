// src/services/toast.ts
//
// 短暂的界面提示队列。
//
// 与 `notifications.ts` 的分工（两者都会在右下角弹出，但语义不同）：
//
//   本文件：**不持久化**的一次性反馈。例如「标签页已达上限」「已复制」。
//           它表达的是「你刚做的这个动作的结果」，刷新页面后不存在也无所谓。
//   notifications.ts：**持久化**的事件记录，会进通知中心、有未读状态、
//           重启后仍在。它表达的是「发生过一件事，你可能需要处理」。
//
// 把两者分开而不是合并成一个「消息系统」，是因为它们该有不同的生命周期：
// 把「已复制」写进磁盘并在通知中心留一条记录是明显的噪音；而把「插件加载失败」
// 做成 3 秒就消失的提示则会让用户错过它。
//
// 定时器不在这里，而在渲染层（ToastLayer）。理由：自动消失需要支持「鼠标悬停
// 时暂停」，那是纯粹的界面行为；服务层只负责维护「当前该显示哪些」。

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * 呈现变体。
 *
 * `'update'` 用于「应用有新版本」这类提示。它与 level 无关：level 说的是
 * **这条信息有多严重**，变体说的是**它是不是一件需要用户做决定的事**。
 * 区别体现在两处，都在渲染层与时长上：
 *
 *   * 不自动消失（用户必须先看到它，而不是等它自己走掉再看历史）；
 *   * 强调色描边 + 一个直接的后续动作入口。
 *
 * 之所以用变体而不是新增一个 level：level 在后端是枚举（`NotificationLevel`），
 * 加一个值会让旧的通知文件解析失败 —— 一个纯呈现层的需求不值得付出那个代价。
 */
export type ToastVariant = 'default' | 'update';

export interface Toast {
  id: string;
  title: string;
  body?: string;
  level: ToastLevel;
  variant: ToastVariant;
  /** 来源模块 ID（可选）。有值时点击提示会跳到该模块 */
  source?: string;
  /** 自动消失的毫秒数；0 表示只能手动关闭 */
  durationMs: number;
  createdAt: number;
}

export interface ToastInput {
  title: string;
  body?: string;
  level?: ToastLevel;
  variant?: ToastVariant;
  source?: string;
  durationMs?: number;
}

/**
 * 同时显示的提示数量上限。
 *
 * 超出后丢弃**最旧**的一条：新提示通常对应刚发生的动作，更可能是用户正在等的
 * 反馈；而堆积会让右下角盖住界面内容。
 */
export const MAX_VISIBLE_TOASTS = 5;

/** 各级别的默认停留时长（毫秒） */
const DEFAULT_DURATION: Record<ToastLevel, number> = {
  info: 4000,
  success: 3500,
  warning: 6000,
  // 错误不自动消失：出错时用户往往需要读完再决定怎么办，
  // 3 秒后自己跑掉会让人怀疑「刚才是不是弹了什么」
  error: 0,
};

/** 变体对停留时长的影响：更新提示不自动消失，理由见 `ToastVariant` */
const VARIANT_DURATION: Record<ToastVariant, number | null> = {
  default: null,
  update: 0,
};

let toasts: Toast[] = [];
let seq = 0;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[toast] 订阅者执行出错:', error);
    }
  });
}

function nextId(): string {
  seq += 1;
  return `toast-${Date.now()}-${seq}`;
}

/** 订阅提示队列变化 */
export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前队列（不可变快照，可直接用于渲染） */
export function getToasts(): Toast[] {
  return toasts;
}

/** 显示一条提示 */
export function showToast(input: ToastInput): Toast {
  const level = input.level ?? 'info';
  const variant = input.variant ?? 'default';

  const toast: Toast = {
    id: nextId(),
    title: input.title,
    body: input.body,
    level,
    variant,
    source: input.source,
    // 变体的规则先于级别的默认值：更新提示这类"要用户做决定"的提示不该
    // 因为被标成 info 就 4 秒后消失。显式传入的 durationMs 仍然优先。
    durationMs:
      input.durationMs ?? VARIANT_DURATION[variant] ?? DEFAULT_DURATION[level],
    createdAt: Date.now(),
  };

  toasts = [...toasts, toast];

  if (toasts.length > MAX_VISIBLE_TOASTS) {
    toasts = toasts.slice(toasts.length - MAX_VISIBLE_TOASTS);
  }

  notify();
  return toast;
}

/** 关闭一条提示 */
export function dismissToast(id: string): void {
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  notify();
}

/** 清空全部提示 */
export function clearToasts(): void {
  if (toasts.length === 0) return;
  toasts = [];
  notify();
}
