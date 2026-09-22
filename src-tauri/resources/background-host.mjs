// background-host.mjs
//
// 后台宿主：与界面无关的插件运行环境。
//
// ============================================================
// 为什么是独立的 Node 进程
// ============================================================
//
// 应用要有"在窗口之外继续工作"的能力（定时提醒、使用情况监测）。这些能力要求
// **进程不随窗口关闭而结束**，而界面插件跑在主窗口的 WebView 里 —— 那个环境会被
// 降级（内存目标等级设为 Low）、会被隐藏、脚本会被浏览器冻结。
// 把"凌晨三点准时提醒"托付给它，等于托付给一个随时可能被挂起的执行环境。
//
// 选 Node 而不是"再开一个隐藏 WebView"：隐藏 WebView 依然是一整套浏览器进程
// （实测 6~8 个、几百 MB），而这是一个进程、且能在不需要时被完全关掉。
//
// ============================================================
// 协议（与 src-tauri/src/modules/desktop/background/protocol.rs 一一对应）
// ============================================================
//
//   · stdin/stdout 上**每行一个 JSON**；stderr 留给日志（不做协议用）。
//   · 启动后第一件事是打印一行**问候**：`{"v":2,"runtime":"node/…"}`。
//     宿主会先读它再投入使用，因此协议版本错配在启动那一刻就暴露，
//     而不是在某个具体调用上以一个奇怪的字段缺失暴露。
//   · 每条请求 `{v,id,method,params?}`，每条响应 `{v,id,result?|error?}`。
//   · 响应**恰好**有 result 或 error 之一：两者都缺或都有都会被宿主拒绝。
//   · 子进程可以**主动**发事件：`{v,event,subject?,data?}`。
//     判据是**有没有 `id`** —— 有 id 的是回答，没有的是事件。定时提醒到点
//     就是走这条路进到宿主的，不需要宿主轮询。
//
// ============================================================
// 这个版本实现了什么、没实现什么
// ============================================================
//
// 已实现：握手、存活探测、状态上报、定时任务（同步/查询/立即触发）、优雅停止。
// 也就是**通道**加上**第一种真正在后台做事的能力**。
//
// 尚未实现：插件代码的加载与执行。那需要先定"后台插件能用哪些能力"——
// 界面插件的 `ctx` 里有 DOM 相关的东西（fileDrop、通知浮层），后台环境里没有。
// 定时任务这一步刻意先不经过插件：它让"后台 → 宿主 → 通知"这条链路可以先被
// 单独验证（真的会响、真的会到界面），而不必同时承担插件沙箱的风险。
//
// ============================================================
// 关于定时任务的归属：**定义在宿主，计时在这里**
// ============================================================
//
// 定时任务的**定义**存在应用侧（`background/schedules.rs`），这里只负责**计时**。
// 这不是随便分的：
//
//   · 定义需要持久化与校验，而"什么算合法的提醒"是一个产品决定，属于应用；
//   · 计时需要在一个**不随窗口关闭而结束**的进程里，属于这里。
//
// 代价是"子进程重启后要重新同步一次"，那由宿主在每次拉起之后调一次
// `scheduleSync` 完成。好处是这里的实现可以**完全无状态**：
// 没有落盘、没有迁移、没有"文件和内存不一致时听谁的"。
//
// ============================================================
// 为什么用"一个定时器指向最早的下一次"，而不是每个任务一个 setInterval
// ============================================================
//
// `setInterval` 有两个问题：
//   · **会漂移**：间隔是"上次回调之后 60 秒"，误差会累积，于是"每天 9:00"
//     那种任务用 interval 根本表达不了；
//   · **看不见下一次**：要回答"它下次什么时候响"只能自己再算一遍。
//
// 这里每个任务只保存 `nextAt`（绝对时间戳），一个定时器指向其中最早的那个。
// 触发后重算该任务的 `nextAt` 并重建定时器。这样"下一次什么时候响"是**存下来的
// 事实**而不是算出来的猜测，界面可以直接显示它。

/** 协议版本。必须与 Rust 侧的 PROTOCOL_VERSION 一致。 */
const PROTOCOL_VERSION = 2;

/** 日志前缀。子进程的 stderr 会进应用日志，前缀便于过滤。 */
const LOG_PREFIX = '[background]';

/**
 * 触发时间的容差（毫秒）。
 *
 * 定时器几乎不可能在恰好那一刻被唤醒（事件循环正忙、系统睡眠唤醒都会推迟它）。
 * 因此"到点了吗"的判据是 `now >= nextAt`，而不是 `now === nextAt` ——
 * 后者会让一个晚了 1 毫秒的唤醒永远不触发。
 *
 * 这个常量用于**迟到多久还值得响**：如果进程睡过了很久（笔记本合盖一整天），
 * 一个 60 秒的间隔任务会积累成几百次补发。补发一次是有意义的（"你错过了"），
 * 补发几百次就是灾难。因此超过 `MISSED_GRACE_MS` 的迟到只响一次并跳到未来。
 */
const MISSED_GRACE_MS = 60 * 1000;

/** 允许的最小间隔（毫秒）。防止一个写错的任务把 CPU 占满。 */
const MIN_INTERVAL_MS = 1000;

const startedAt = Date.now();

/** 已处理过的请求数 */
let handled = 0;

/**
 * 定时任务表：id -> { id, kind, at, intervalMs, name, payload, nextAt, fired }
 *
 * `nextAt` 是**绝对时间戳**（毫秒），不是"还有多久"。存绝对时间戳的好处是
 * 系统时钟被调整时行为可预期：要么按新时钟重新生效，要么如实迟到，
 * 而不是把"剩余时长"与时钟变化叠加成一个说不清的结果。
 */
const schedules = new Map();

/** 当前挂着的那个定时器（整个进程最多一个） */
let timer = null;

/** 累计触发次数，用于 status 与排查 */
let firedCount = 0;

/**
 * 写出**一条**响应。
 *
 * 用一次 `process.stdout.write` 而不是 `console.log(line)` 之外的东西：
 * 一条消息必须**一次**写出去，否则两条响应可能交错，宿主会把它们当成同一行。
 * Node 的 stdout 在管道上是异步的，但单次 write 的字节不会被别的 write 插进来。
 */
function respond(id, { result, error }) {
  const payload = { v: PROTOCOL_VERSION, id };
  // 恰好给一个：两者都给或都不给都会被宿主拒绝（见 protocol.rs 的 validate）。
  if (error !== undefined) {
    payload.error = String(error);
  } else {
    payload.result = result === undefined ? null : result;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * 主动发一条事件给宿主。
 *
 * 与 `respond` 共用同一条 stdout，但**没有 `id`** —— 宿主据此把它与响应区分开。
 * 一次 write 发一整行，理由与 `respond` 相同：两条消息交错会让双方都解析失败。
 */
function emitEvent(event, subject, data) {
  const payload = { v: PROTOCOL_VERSION, event };
  if (subject !== undefined && subject !== '') payload.subject = String(subject);
  if (data !== undefined) payload.data = data;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// ============================================================
// 定时任务
// ============================================================

/**
 * 规范化一个任务定义。**不合法就抛错**，而不是补一个默认值。
 *
 * 一个"看起来生效了、其实按默认值在跑"的任务比一个明确被拒绝的任务糟得多：
 * 用户设了"每天 9:00"，界面显示成功，而它在每 60 秒响一次。
 */
function normalizeSchedule(input) {
  if (input === null || typeof input !== 'object') {
    throw new Error('定时任务必须是一个对象');
  }

  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (id === '') throw new Error('定时任务缺少 id');
  if (id.length > 128) throw new Error('定时任务 id 过长（上限 128 字符）');

  const kind = input.kind;
  if (kind !== 'interval' && kind !== 'daily' && kind !== 'once') {
    throw new Error(`未知的定时类型：${String(kind)}（只支持 interval / daily / once）`);
  }

  const name = typeof input.name === 'string' ? input.name : '';
  const payload = input.payload === undefined ? null : input.payload;

  const result = { id, kind, name, payload, fired: 0 };

  if (kind === 'interval') {
    const raw = Number(input.intervalMs);
    if (!Number.isFinite(raw)) throw new Error('interval 任务需要 intervalMs');
    const intervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(raw));
    result.intervalMs = intervalMs;
    // 间隔任务从"现在 + 一个间隔"开始，而不是立刻响一次：
    // 立刻响会让"每次启动应用都收到一条提醒"，而用户设的是"每隔 N 分钟"。
    result.nextAt = Date.now() + intervalMs;
    return result;
  }

  if (kind === 'daily') {
    const minuteOfDay = Number(input.minuteOfDay);
    if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1439) {
      throw new Error('daily 任务需要 minuteOfDay（0..1439，本地时间的当日分钟数）');
    }
    result.minuteOfDay = minuteOfDay;
    result.nextAt = nextDailyAt(minuteOfDay, Date.now());
    return result;
  }

  // once：一个绝对时间戳。已经过去的**不改成立刻响** —— 那会让"我错过的那次"
  // 在每次重启后重复弹出来。正相反：它立刻就是"已完成"状态。
  const at = Number(input.at);
  if (!Number.isFinite(at)) throw new Error('once 任务需要 at（毫秒时间戳）');
  result.at = Math.floor(at);
  result.nextAt = result.at;
  return result;
}

/** 从 `from` 之后（严格大于）的本地时间下一次 `minuteOfDay` 的绝对时间戳 */
function nextDailyAt(minuteOfDay, from) {
  const candidate = new Date(from);
  candidate.setHours(0, 0, 0, 0);
  candidate.setMinutes(minuteOfDay);

  // 用 setMinutes 而不是手工加毫秒：夏令时切换当天"9:00"的绝对时刻会变，
  // 而 `setMinutes` 是按本地日历算的，正是用户说"9:00"时的意思。
  if (candidate.getTime() <= from) {
    // 今天这个点已经过了（或就是现在）：挪到明天。
    // `setDate(getDate() + 1)` 同样按本地日历走，跨月跨年由 Date 自己处理。
    const tomorrow = new Date(from);
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setMinutes(minuteOfDay);
    return tomorrow.getTime();
  }

  return candidate.getTime();
}

/** 重算某个任务的 `nextAt`（触发之后调用） */
function advance(schedule, now) {
  if (schedule.kind === 'interval') {
    // 从上一次的**计划时刻**往前推，而不是从"现在"往前推：
    // 从 now 推会把每次的唤醒延迟都累加进间隔里，几分钟后就会明显偏晚。
    let next = schedule.nextAt + schedule.intervalMs;
    // 迟到太多时不要补发一串：直接跳到未来最近的那一次。
    while (next <= now - MISSED_GRACE_MS) {
      next += schedule.intervalMs;
    }
    // 仍然落在过去（刚迟到一点点）：立刻补一次，然后再跳到未来。
    if (next <= now) next += schedule.intervalMs;
    schedule.nextAt = next;
    return;
  }

  if (schedule.kind === 'daily') {
    schedule.nextAt = nextDailyAt(schedule.minuteOfDay, now);
    return;
  }

  // once：没有下一次了。置为 null，`scheduleList` 会如实报告它不再等待触发。
  schedule.nextAt = null;
}

/**
 * 重建那个唯一的定时器，指向所有任务里最早的 `nextAt`。
 *
 * **每次都全量重建**而不是"插入新任务时再比较"：后者要在四处（新增、删除、
 * 触发、同步）各维护一次"最早的还是不是它"，而任何一处漏掉的表现都是
 * "任务明明在列表里却永远不响"。
 */
function rearm() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }

  let earliest = null;
  for (const schedule of schedules.values()) {
    if (schedule.nextAt === null) continue;
    if (earliest === null || schedule.nextAt < earliest) earliest = schedule.nextAt;
  }

  if (earliest === null) return;

  // `setTimeout` 的延迟上限是 2^31-1 毫秒（约 24.8 天），超过会**立刻**触发并
  // 变成一个忙循环。钳制到上限，然后靠"醒来发现还没到"重新挂一次。
  const delay = Math.max(0, Math.min(earliest - Date.now(), 2 ** 31 - 1));
  timer = setTimeout(onTimer, delay);
  // 这个定时器不该阻止进程在 stdin 关闭后退出
  if (typeof timer.unref === 'function') timer.unref();
}

/** 定时器到点：把到期的任务全部触发，然后重排 */
function onTimer() {
  timer = null;

  const now = Date.now();
  const due = [];
  for (const schedule of schedules.values()) {
    if (schedule.nextAt !== null && schedule.nextAt <= now) {
      // 计划时刻要**先取出来**：`advance` 会把它改写成下一次的时间。
      due.push({ schedule, scheduledAt: schedule.nextAt });
    }
  }

  // 先全部重排再触发：触发会发事件，而事件是异步写出去的。
  // 万一某个触发路径抛错，已经排好的下一次不该因此丢掉。
  for (const item of due) {
    advance(item.schedule, now);
  }
  rearm();

  for (const item of due) {
    fire(item.schedule, item.scheduledAt, 'timer');
  }
}

/**
 * 触发一个任务：计数并发一条事件。
 *
 * 这里**只发事件**，不直接产生通知。理由：通知的落盘、去重、广播都由应用侧负责，
 * 后台侧再实现一遍就有两套语义；而且"到时候了"与"要显示什么"是两件事，
 * 前者属于这里，后者属于应用。
 */
function fire(schedule, scheduledAt, reason) {
  schedule.fired = (schedule.fired ?? 0) + 1;
  schedule.lastFiredAt = Date.now();
  firedCount += 1;

  process.stderr.write(
    `${LOG_PREFIX} 定时任务触发：${schedule.id}（${schedule.kind}，第 ${schedule.fired} 次，${reason}）\n`
  );

  emitEvent('schedule.fired', schedule.id, {
    kind: schedule.kind,
    name: schedule.name,
    firedAt: schedule.lastFiredAt,
    scheduledAt,
    fireCount: schedule.fired,
    reason,
    payload: schedule.payload,
  });
}

/** 供 `status` 与 `scheduleList` 使用的可读描述 */
function describeSchedule(schedule) {
  return {
    id: schedule.id,
    kind: schedule.kind,
    name: schedule.name,
    intervalMs: schedule.intervalMs ?? null,
    minuteOfDay: schedule.minuteOfDay ?? null,
    at: schedule.at ?? null,
    nextAt: schedule.nextAt,
    fireCount: schedule.fired ?? 0,
    lastFiredAt: schedule.lastFiredAt ?? null,
  };
}

/** 当前状态。`status` 方法的返回值，也是排查"到底有没有被用过"的依据。 */
function currentStatus() {
  return {
    pid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeMs: Date.now() - startedAt,
    handled,
    // 后台插件的加载尚未实现，如实回报 0 而不是编一个数字
    backgroundPlugins: 0,
    // 定时任务是当前唯一真的在后台做事的能力，因此它的规模要能被看到
    schedules: schedules.size,
    scheduleFires: firedCount,
    // 最近一次触发时刻（没有则为 null）。排查"它到底响过没有"用。
    lastFireAt: lastFireAt(),
  };
}

/** 最近一次触发时刻 */
function lastFireAt() {
  let latest = null;
  for (const schedule of schedules.values()) {
    if (schedule.lastFiredAt && (latest === null || schedule.lastFiredAt > latest)) {
      latest = schedule.lastFiredAt;
    }
  }
  return latest;
}

/** 方法表。未知方法返回错误，而不是静默成功。 */
const methods = {
  hello() {
    return { protocolVersion: PROTOCOL_VERSION, runtime: `node/${process.version}` };
  },

  ping() {
    return { pong: true, at: Date.now() };
  },

  status() {
    return currentStatus();
  },

  /**
   * 用一份完整列表替换当前任务集合。
   *
   * 全量替换而不是逐条增删：应用侧持有唯一的真值，而"增量同步"要求两边对
   * "现在应该有哪些"达成一致 —— 那正好是这套设计刻意回避的东西。
   * 全量替换的代价只是一次 JSON 传输，任务数量在几十这个量级。
   *
   * **先整体校验再整体应用**：一条不合法的任务不能留下"前一半生效了"的状态。
   */
  scheduleSync(params) {
    const list = Array.isArray(params?.schedules) ? params.schedules : null;
    if (list === null) throw new Error('scheduleSync 需要 schedules 数组');

    const next = new Map();
    for (const raw of list) {
      const schedule = normalizeSchedule(raw);
      next.set(schedule.id, schedule);
    }

    // 保留已有的触发计数：全量同步不该让"响过几次"归零，
    // 否则界面上的次数会在每次同步后莫名其妙地变小。
    for (const [id, schedule] of next) {
      const previous = schedules.get(id);
      if (previous) {
        schedule.fired = previous.fired ?? 0;
        schedule.lastFiredAt = previous.lastFiredAt ?? null;
      }
    }

    schedules.clear();
    for (const [id, schedule] of next) schedules.set(id, schedule);

    rearm();
    process.stderr.write(`${LOG_PREFIX} 定时任务已同步：${schedules.size} 条\n`);

    return { count: schedules.size, schedules: listSchedules() };
  },

  scheduleList() {
    return { count: schedules.size, schedules: listSchedules() };
  },

  /**
   * 立刻触发一次某个任务（"现在试一下"）。
   *
   * 走的是与定时器**完全相同**的 `fire`，因此这条命令验证的就是真实的触发链路，
   * 而不是一条只在测试里存在的旁路。
   *
   * 不改变 `nextAt`：手工触发一次不该让"下一次什么时候响"发生变化。
   */
  scheduleRunNow(params) {
    const id = typeof params?.id === 'string' ? params.id : '';
    const schedule = schedules.get(id);
    if (!schedule) throw new Error(`没有这个定时任务：${id}`);

    fire(schedule, Date.now(), 'manual');
    return describeSchedule(schedule);
  },

  shutdown() {
    // 响应本身由 `handleLine` 统一发出，这里只描述发生了什么。
    // 退出时机见那里的 `setImmediate` —— 立刻 `process.exit` 会把响应留在
    // 管道缓冲区里，宿主于是只能等超时。
    return { stopping: true, uptimeMs: Date.now() - startedAt, schedules: schedules.size };
  },
};

/** 列出全部任务的当前形态，按"下一次触发最早"排序（没有下次的排最后） */
function listSchedules() {
  return [...schedules.values()]
    .map(describeSchedule)
    .sort((a, b) => {
      if (a.nextAt === null && b.nextAt === null) return a.id.localeCompare(b.id);
      if (a.nextAt === null) return 1;
      if (b.nextAt === null) return -1;
      return a.nextAt - b.nextAt;
    });
}

/** 处理一行输入 */
function handleLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    // 一行解析不了**不退出**：对面可能只是写了一条垃圾，而它之后的消息仍然有效。
    // 退出会把一次格式错误升级成"后台功能永久失效"。
    //
    // 没有 id 时无法回应 —— 只记日志。
    process.stderr.write(`${LOG_PREFIX} 无法解析的一行：${error.message}\n`);
    return;
  }

  const id = typeof request?.id === 'number' ? request.id : null;
  if (id === null) {
    process.stderr.write(`${LOG_PREFIX} 请求缺少数字 id，忽略\n`);
    return;
  }

  // 版本不匹配**逐条拒绝**，而不是只在启动时检查一次：
  // 宿主可能已经在运行中被升级，而继续用旧语义解释新字段会得出错误的结论。
  if (request.v !== PROTOCOL_VERSION) {
    respond(id, {
      error:
        `协议版本不匹配：脚本是 ${PROTOCOL_VERSION}，请求是 ${request.v}。` +
        `后台宿主脚本与应用必须来自同一次发布。`,
    });
    return;
  }

  const handler = methods[request.method];
  if (typeof handler !== 'function') {
    // 未知方法必须报错。静默成功会让调用方以为"做完了"，而那是最难发现的一类错误。
    respond(id, { error: `未知方法：${String(request.method)}` });
    return;
  }

  handled += 1;

  try {
    const result = handler(request.params);
    respond(id, { result });

    if (request.method === 'shutdown') {
      // 让它有机会把上面那条响应写出去再退出。
      // `setImmediate` 而不是立刻 `process.exit`：管道写入是异步的，
      // 立刻退出会把刚写的那一行留在缓冲区里 —— 宿主于是看不到响应，
      // 只能等到超时，然后报"后台宿主没有响应"，而它其实好好地停下来了。
      setImmediate(() => {
        process.stderr.write(`${LOG_PREFIX} 收到停止请求，正在退出\n`);
        process.exit(0);
      });
    }
  } catch (error) {
    // 方法抛错 = 业务失败，通道正常。放进 `error` 而不是让进程崩掉：
    // 一个方法的失败不该让整个后台环境消失。
    respond(id, { error: error instanceof Error ? error.message : String(error) });
  }
}

// ============================================================
// 启动
// ============================================================

// 问候必须先于任何其它输出：宿主的第一行读取在等它。
process.stdout.write(
  `${JSON.stringify({
    v: PROTOCOL_VERSION,
    runtime: `node/${process.version}`,
    pid: process.pid,
  })}\n`
);

process.stderr.write(
  `${LOG_PREFIX} 宿主已启动 pid=${process.pid} node=${process.version} 协议=${PROTOCOL_VERSION}\n`
);

let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // 逐行处理。最后一段可能是不完整的行，留在缓冲区里等下一次数据 ——
  // 直接按 chunk 边界切会在长消息上出错，而那种错误只在消息恰好跨过
  // 一次读取边界时出现，是最难复现的一类。
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    handleLine(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
  }

  // 兜底：单行过长时不让缓冲区无限增长。上限与 Rust 侧的 MAX_LINE_BYTES 一致 ——
  // 两侧不一致会让"对面为什么突然不说话了"变成一个没有线索的问题。
  if (buffer.length > 1024 * 1024) {
    process.stderr.write(`${LOG_PREFIX} 输入缓冲区超过上限，丢弃未完成的一行\n`);
    buffer = '';
  }
});

process.stdin.on('end', () => {
  // stdin 关闭 = 宿主走了。自己也退，不要留在后台变成孤儿进程。
  process.stderr.write(`${LOG_PREFIX} 标准输入已关闭，宿主退出\n`);
  process.exit(0);
});

// 未捕获异常不能让进程静默死掉：那会让宿主等一个永远不会来的响应，
// 最后报一句"没有响应"，而真正的原因（这里）在日志里。
process.on('uncaughtException', (error) => {
  process.stderr.write(`${LOG_PREFIX} 未捕获异常：${error?.stack ?? error}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${LOG_PREFIX} 未处理的 Promise 拒绝：${reason}\n`);
});
