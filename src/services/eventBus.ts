// src/services/eventBus.ts
//
// 模块之间的进程内事件总线。
//
// 为什么需要它：通知解决的是「模块 → 用户」，而模块之间是另一个方向的需求 ——
// 任务模块产生的待办应当能出现在仪表盘上，播放器切歌应当能通知其它模块。
// 在这之前唯一的跨模块通道是「都去读写同一个后端命令」，那既绕又难维护。
//
// 三条设计约束：
//
//   1. **同步投递。** 发布后立刻按注册顺序调用处理函数。异步投递（微任务/宏任务）
//      会让「发布」与「处理」之间插入任意其它代码，调试时很难把因果对上。
//      单个处理函数抛错会被捕获并记录，不会中断其余处理函数，也不会让发布方失败。
//   2. **主题名白名单字符。** 主题由插件的字符串直接决定，因此必须限制字符集，
//      否则任意字符串都会成为总线上的键（包括空串与超长串）。
//   3. **可按来源批量注销。** 插件被禁用/卸载时必须摘掉它注册的全部处理函数，
//      否则会在下一次事件发布时调用到已经被替换或失效的插件代码。
//
// 与 Tauri 的事件系统（`@tauri-apps/api/event`）的区别：那是前端与后端之间的
// 通道，本总线只在前端进程内，不走 IPC，因此没有序列化开销，也不需要权限声明。

export type EventHandler<T = unknown> = (payload: T) => void;

export interface BusEvent<T = unknown> {
  topic: string;
  payload: T;
  /** 发布方标识：模块 ID、插件 ID 或 `host` */
  source: string;
  /** 发布时间戳（毫秒） */
  at: number;
}

/** 主题名最大长度 */
export const MAX_TOPIC_LENGTH = 64;

/** 订阅回调，用于取消注册 */
export type Unsubscribe = () => void;

interface Subscription {
  handler: EventHandler<never>;
  /** 注册者标识，用于按来源批量注销 */
  source: string;
  /** 订阅者是否希望收到自己发出的事件 */
  receiveOwn: boolean;
}

/** topic → 订阅列表 */
const subscriptions = new Map<string, Subscription[]>();

/** 主题名是否合法：小写字母、数字、点、连字符、下划线 */
export function isValidTopic(topic: string): boolean {
  if (!topic || topic.length > MAX_TOPIC_LENGTH) return false;
  return /^[a-z0-9][a-z0-9._-]*$/.test(topic);
}

/**
 * 发布一个事件。
 *
 * 主题名非法时**直接丢弃并记录警告**，而不是抛错：发布方通常是插件的
 * 异步回调，在那里抛错会把错误抛进一个没人捕获的地方。而非法主题是明确的
 * 编程错误，日志里看得见就够了。
 */
export function publish<T>(topic: string, payload: T, source = 'host'): void {
  if (!isValidTopic(topic)) {
    console.warn(`[eventBus] 忽略非法主题名: "${topic}"`);
    return;
  }

  const list = subscriptions.get(topic);
  if (!list || list.length === 0) return;

  const event: BusEvent<T> = { topic, payload, source, at: Date.now() };

  // 复制一份再遍历：处理函数里可能会订阅/取消订阅同一个主题，
  // 直接遍历原数组会遇到「边遍历边修改」
  for (const subscription of [...list]) {
    if (!subscription.receiveOwn && subscription.source === source) continue;

    try {
      (subscription.handler as EventHandler<BusEvent<T>>)(event);
    } catch (error) {
      console.error(`[eventBus] 处理主题 "${topic}" 时出错（来源 ${subscription.source}）:`, error);
    }
  }
}

export interface SubscribeOptions {
  /**
   * 注册者标识，用于后续按来源批量注销。
   * 插件与模块应当传自己的 ID，否则卸载时无法清理。
   */
  source?: string;
  /**
   * 是否接收自己发布的事件。默认 `false`。
   *
   * 默认关闭的理由：模块最常见的写法是「发布后由自己订阅来更新界面」，
   * 那样会绕一圈回到自己，还容易形成回环（处理函数里再发布同一主题）。
   * 需要自己处理自己时显式打开。
   */
  receiveOwn?: boolean;
}

/** 订阅一个主题。返回取消订阅的函数。 */
export function subscribe<T = unknown>(
  topic: string,
  handler: EventHandler<T>,
  options: SubscribeOptions = {}
): Unsubscribe {
  if (!isValidTopic(topic)) {
    console.warn(`[eventBus] 忽略非法主题名的订阅: "${topic}"`);
    return () => {};
  }

  const subscription: Subscription = {
    handler: handler as EventHandler<never>,
    source: options.source ?? 'anonymous',
    receiveOwn: options.receiveOwn ?? false,
  };

  const list = subscriptions.get(topic);
  if (list) {
    list.push(subscription);
  } else {
    subscriptions.set(topic, [subscription]);
  }

  return () => {
    const current = subscriptions.get(topic);
    if (!current) return;

    const index = current.indexOf(subscription);
    if (index === -1) return;

    current.splice(index, 1);
    if (current.length === 0) subscriptions.delete(topic);
  };
}

/**
 * 注销某个来源注册的全部订阅。
 *
 * 插件禁用/卸载、模块卸载时必须调用，否则总线里会留下指向失效代码的处理函数。
 * 返回被移除的数量，便于在卸载流程里做断言。
 */
export function unsubscribeBySource(source: string): number {
  if (!source) return 0;

  let removed = 0;

  for (const [topic, list] of [...subscriptions.entries()]) {
    const kept = list.filter((subscription) => subscription.source !== source);
    removed += list.length - kept.length;

    if (kept.length === 0) {
      subscriptions.delete(topic);
    } else {
      subscriptions.set(topic, kept);
    }
  }

  return removed;
}

/** 当前订阅总数（自检与调试用） */
export function getSubscriptionCount(): number {
  let total = 0;
  for (const list of subscriptions.values()) total += list.length;
  return total;
}

/** 当前所有被订阅的主题（自检与调试用） */
export function getSubscribedTopics(): string[] {
  return [...subscriptions.keys()].sort();
}
