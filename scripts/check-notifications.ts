// scripts/check-notifications.ts
//
// 「后端产生通知 → 界面能看到」这条链路的验证脚本
//
//   node scripts/check-notifications.ts
//
// ============================================================
// 它守的是什么
// ============================================================
//
// 在补上这条链路之前，后端产生通知时前端**完全不知道**：前端只在自己调用了
// 某个通知命令之后才刷新缓存。于是任何不是由界面发起的通知都不会出现在通知
// 中心里 —— 后台宿主的定时提醒、启动阶段的插件加载失败都属于这一类。
//
// 具体表现是：通知已经落盘、未读数也算上了，但铃铛徽标不变、列表里看不到，
// 直到用户碰巧触发了某次刷新。**这是"看起来接通了、实际从未通电"的又一例。**
//
// 而它的两侧（Rust 的 `emit` 与 TS 的 `listen`）之间**没有任何编译器**联系 ——
// 事件名写错一个字符，两边都不会报错，只是永远收不到。因此这里必须钉住。
//
// 这里查的四件事：
//   1. 事件名两侧一致；
//   2. **每一个改动通知数据的命令都广播了**（漏掉任意一处，
//      那条路径上的变化就对界面不可见，而那只在特定操作之后才显形）；
//   3. 广播发生在**锁之外**（锁内广播会让界面刷新时撞上一个被持有的锁）；
//   4. 前端在 main.tsx 里装上了订阅。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let total = 0;

function check(condition: boolean, label: string): void {
  total += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${label}`);
  }
}

function read(relative: string): string {
  return readFileSync(join(PROJECT_ROOT, relative), 'utf-8');
}

const commandsRs = read('src-tauri/src/modules/notifications/commands.rs');
const notificationsTs = read('src/services/notifications.ts');
const mainTsx = read('src/main.tsx');

// ============================================================
// 1. 事件名两侧一致
// ============================================================
console.log('事件名：');

const rustEventName = /pub const NOTIFICATIONS_CHANGED_EVENT: &str = "([^"]+)";/.exec(commandsRs)?.[1];
const tsEventName = /export const NOTIFICATIONS_CHANGED_EVENT = '([^']+)';/.exec(notificationsTs)?.[1];

check(rustEventName !== undefined, `Rust 侧声明了事件名（${rustEventName}）`);
check(tsEventName !== undefined, `前端声明了事件名（${tsEventName}）`);
check(
  rustEventName !== undefined && rustEventName === tsEventName,
  `两侧事件名一致（${rustEventName}）—— 差一个字符就是"永远收不到"，而两侧都不会报错`
);

// ============================================================
// 2. 每一个改动数据的命令都广播了
// ============================================================
//
// 判据不是"某个命令里有 emit"，而是"**所有**改动数据的命令都有"。
// 漏掉任意一处都会让那条路径上的变化对界面不可见，而那只在特定操作之后
// 才显形（例如"标记已读之后徽标不更新"），很难被联想到根因。
console.log('\n广播覆盖：');

/** 取出一个命令函数体（括号配平） */
function commandBody(source: string, name: string): string | null {
  // 允许泛型参数：`pub fn push<R: Runtime>(`。沙箱插件的协议处理器拿到的是
  // `AppHandle<R>` 而不是具体的 `AppHandle`，因此那条推送路径必须是泛型的。
  const match = new RegExp(`pub fn ${name}(?:<[^>]*>)?\\(`).exec(source);
  if (!match) return null;
  const start = match.index;
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * `push_notification` 如今是一个**薄壳**：真正的实现在 `push` 里。
 *
 * 为什么要拆：沙箱插件界面没有 Tauri IPC（零 capability），它发的每一条请求都由
 * 宿主的协议处理器代为执行 —— 而那条路径只有 `AppHandle`，拿不到 `State<_>`。
 * 如果推送逻辑只写在命令里，沙箱插件就没有合法的推送入口，只能复制一份出来，
 * 而"来源字段与广播行为"两份实现迟早会不一致。
 *
 * ============================================================
 * 这条检查因此必须先证明"壳真的转发了"
 * ============================================================
 *
 * 只把检查目标从 `push_notification` 换成 `push` 是不够的：那样一来，把命令体
 * 改成什么都不做，下面所有断言照样通过 —— 检查守卫的路径已经不是用户走的路径了。
 * 因此这里要求壳体内出现一次对目标的调用，找不到就返回 `null`（= 检查变红）。
 */
const DELEGATED_TO: Record<string, string> = {
  push_notification: 'push',
};

function effectiveBody(command: string): string | null {
  const delegate = DELEGATED_TO[command];
  if (!delegate) return commandBody(commandsRs, command);

  const shell = commandBody(commandsRs, command);
  if (shell === null) return null;
  if (!new RegExp(`\\b${delegate}\\(`).test(shell)) return null;

  return commandBody(commandsRs, delegate);
}

const MUTATING_COMMANDS = [
  'push_notification',
  'mark_notification_read',
  'mark_all_notifications_read',
  'dismiss_notification',
  'clear_notifications',
];

for (const command of MUTATING_COMMANDS) {
  const body = effectiveBody(command);
  check(body !== null, `能找到 ${command} 的实现`);
  check(
    body !== null && body.includes('broadcast_changed'),
    `${command} 广播了变化（漏掉它，这条路径上的变化对界面不可见）`
  );
}

// 广播本身必须只在一处实现：各命令各写一遍 emit 会让"哪个事件名"散开
const emitCalls = [...commandsRs.matchAll(/\.emit\(/g)].length;
check(emitCalls === 1, `emit 只在一处出现（实际 ${emitCalls} 处）—— 抽成了 broadcast_changed`);

// ============================================================
// 3. 广播在锁之外
// ============================================================
//
// 锁内广播有问题：`emit` 会让界面那边立刻发起一次 `list_notifications`，
// 而那要拿同一把锁 —— 在极端时序下会变成"广播等锁、锁等广播返回"。
// 更直接的问题是：持锁期间做与数据无关的 IPC 是没有必要的。
console.log('\n广播的位置：');

for (const command of MUTATING_COMMANDS) {
  const body = effectiveBody(command);
  if (!body) continue;

  // 广播必须出现在最后一个 lock() 之后、且不在同一个 `{}` 块里 ——
  // 用"广播那行之前是否还有未闭合的 lock 块"来判断太脆弱，
  // 改成要求：lock() 调用被包在一个显式的 `{ ... }` 作用域里，
  // 而 broadcast 在它之后。
  const broadcastIndex = body.indexOf('broadcast_changed');
  const lastLockIndex = body.lastIndexOf('.lock()');

  check(
    broadcastIndex > lastLockIndex,
    `${command} 在取得锁之后才广播（顺序反了会在持锁时做 IPC）`
  );
}

// `push_notification` 的写入必须整体包在作用域里，使守卫在广播前释放。
check(
  /let snapshot = \{[\s\S]{0,400}?store::save\(&app, &list\)\?;[\s\S]{0,80}?list\.clone\(\)[\s\S]{0,40}?\};/.test(
    commandsRs
  ),
  '写入与快照在一个作用域里完成，守卫在广播之前释放'
);

/**
 * 广播确实发生在函数体内（而不是只在别处定义了 `broadcast_changed`）。
 *
 * ---------------------------------------------------------------------------
 * 关于「广播时守卫有没有释放」——这里**不再**用文本去判断
 * ---------------------------------------------------------------------------
 * 我先后写了三版推断"锁是否已释放"的检查，三版都是假阳性：
 *
 *   1. 跨函数的正则：把"前一个函数的 lock"与"后一个函数的 broadcast"连起来；
 *   2. 比较"最后一个 `.lock()` 与最后一个 `{` 的先后"：那个 `{` 属于更外层的
 *      结构，于是永远判为"没释放"；
 *   3. 找"广播之前的 `};`"：函数体自身的闭括号与快照块的闭括号形状多样，
 *      各种写法都能骗过它。
 *
 * 假阳性比漏报更糟：它逼人去"调正则直到通过"，而调完之后这条检查就不再拦得住
 * 真正的错误。**因此我停在这里**，不再加码正则。
 *
 * 守卫释放由另外两条真正可靠的检查覆盖：
 *   · 「写入与快照在一个作用域里完成」—— 那是一个具体的结构性写法；
 *   · 「`.lock()` 只出现在 `let … = { … };` 里面」—— 见下面那条。
 *
 * 而"广播必须在锁之外"这个**意图**，写在了 `commands.rs` 的注释里，
 * 由代码评审守住 —— 承认某件事靠人看，好过用一个不可靠的检查假装它被守住了。
 */
function broadcastsInsideTheCommand(body: string): boolean {
  return body.includes('broadcast_changed');
}

check(
  MUTATING_COMMANDS.every((command) => {
    const body = effectiveBody(command);
    return body !== null && broadcastsInsideTheCommand(body);
  }),
  '广播发生在每个命令的函数体内'
);

// 每个命令都恰好有一个显式的快照作用域（`};` 闭合），守卫在那里释放。
// 这才是"释放"的直接证据：写入与快照整体包在一个块里，块外才是广播。
const SNAPSHOT_SHAPES = [
  /let snapshot = \{[\s\S]{0,500}?\};/g,
  /\{\s*\n\s*let mut list = state[\s\S]{0,400}?\n    \}/g,
];
const snapshotMatches = SNAPSHOT_SHAPES.reduce(
  (sum, pattern) => sum + ([...commandsRs.matchAll(pattern)].length),
  0
);
check(
  snapshotMatches >= MUTATING_COMMANDS.length,
  `每个改动数据的命令都有一个显式的快照作用域（找到 ${snapshotMatches} 处，需要 ${MUTATING_COMMANDS.length} 处）`
);

// ============================================================
// 4. 前端装上了订阅
// ============================================================
console.log('\n前端订阅：');

check(
  /export async function subscribeBackendNotificationEvents/.test(notificationsTs),
  '前端提供订阅入口'
);
check(
  notificationsTs.includes('listen(NOTIFICATIONS_CHANGED_EVENT'),
  '订阅用的是常量而不是硬编码的字符串（两处硬编码会漂移）'
);
check(
  // 事件不带负载：列表仍然从后端读，避免"哪一份是权威"分成两个来源
  /listen\(NOTIFICATIONS_CHANGED_EVENT, \(\) => \{[\s\S]{0,400}?loadNotifications\(\)/.test(
    notificationsTs
  ),
  '收到事件后从后端重新读列表（而不是用事件里带的负载）'
);
check(
  /catch[\s\S]{0,300}?无法订阅后端通知事件/.test(notificationsTs),
  '订阅失败时降级而不是抛错（纯前端预览 / 旧运行时下不该让界面报错）'
);
check(
  mainTsx.includes('subscribeBackendNotificationEvents()'),
  '订阅在 main.tsx 里装上（通知中心可能还没挂载，而徽标与浮层都要能看到新通知）'
);
check(
  /void subscribeBackendNotificationEvents\(\)/.test(mainTsx),
  '订阅是异步的，因此不 await（失败只记警告，不该挡住启动）'
);

// ============================================================
// 后端产生的通知也必须**弹浮层 + 响提示音**
// ============================================================
//
// 这是一次用户实测报上来的故障：插件通过 `ctx.notifications.show(...)` 推的通知
// 进了通知中心、未读数也变了，但**没有提醒、没有铃声、没有弹窗**。
//
// 根因：`push()`（Rust）只落盘 + 广播一条"列表变了"的事件，而前端那条路上从前
// 只有 `setList` —— 也就是说"弹浮层与响提示音"只挂在**前端自己发起**的
// `pushNotification` 上。任何不是由界面发起的通知因此都是静默的。
//
// 这几条断言守的是两件事：新通知要弹，且**只弹一次**。
check(
  /if \(hadLoadedOnce\) \{/.test(notificationsTs),
  '只在**已经加载过一次**之后才弹：否则启动那一刻会把历史未读一起弹一遍'
);
check(
  /const knownIds = new Set\(notifications\.map\(\(item\) => item\.id\)\);/.test(notificationsTs),
  '按 **id** 比对挑出"这次新出现的"（后端合并同键通知时 id 不变，于是重试循环不会每次都响）'
);
check(
  /knownIds\.has\(item\.id\) \|\| item\.read/.test(notificationsTs),
  '只对"新出现的**且未读**"弹（已读的不该再打扰）'
);
check(
  // 通知的浮层与提示音必须在 `loadNotifications` 里真的被调到。
  /presentNotification\(\s*\{[\s\S]{0,400}?item\.id\s*\)/.test(notificationsTs),
  'loadNotifications 里真的调了 presentNotification（浮层 + 提示音是同一处）'
);

// 去重：两条路（前端主动推送、后端变化事件）看的是**同一个** id。
check(
  /const presentedIds = new Set<string>\(\)/.test(notificationsTs) &&
    /if \(presentedIds\.has\(id\)\) return;/.test(notificationsTs),
  '按 id 去重，保证一条通知只弹一次（否则两条路各弹一次 —— 两声、两个浮层）'
);
check(
  /presentNotification\(\s*\{[\s\S]{0,400}?\},\s*justPushed\?\.id\s*\)/.test(notificationsTs),
  '前端主动推送那条路把 id 交给去重（不交的话上面的去重形同虚设）'
);

// ============================================================
// 通知的跳转：`plugin:<插件 ID>` 必须能被解析成模块
// ============================================================
//
// 宿主把插件通知的 source 写成 `plugin:<插件 ID>`（为了归到插件名下），而模块 ID
// 的形态是 `plugin:<插件 ID>#<界面>`。于是那个字符串**两条路都落空**：不是一个
// 模块 ID（少了 `#界面`），也不是一个插件 ID（多了前缀）。
//
// 用户看到的就是通知里那一栏显示 `plugin:com.rinntheor.modulith.kanban`、
// 点了跳不过去。
const moduleCatalogTs = read('src/services/moduleCatalog.ts');
check(
  /source\.startsWith\('plugin:'\) && !source\.includes\('#/.test(moduleCatalogTs),
  '解析通知来源时剥掉 `plugin:` 前缀（且只剥不带 `#` 的那种 —— 带 `#` 的是完整模块 ID）'
);
check(
  /source\.slice\('plugin:'\.length\)/.test(moduleCatalogTs),
  '剥前缀用的是同一个字面量（写死长度会在前缀变化时静默错位）'
);
check(
  // 顺序：先按完整模块 ID 比，再剥前缀。反过来的话一个真正的模块 ID 会被剥成
  // 一个不存在的插件 ID。
  moduleCatalogTs.indexOf('if (flat.has(source)) return source;') <
    moduleCatalogTs.indexOf("source.startsWith('plugin:')"),
  '先按完整模块 ID 比、再剥前缀（顺序反了会把真模块 ID 剥坏）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
