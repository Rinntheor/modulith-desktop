// scripts/check-background.ts
//
// 后台宿主（Node sidecar）链路的验证脚本
//
//   node scripts/check-background.ts
//
// ============================================================
// 它查什么、不查什么
// ============================================================
//
// 协议本身（编码、校验、畸形响应拒绝、超长行、未知字段）由
// `src-tauri/src/modules/desktop/background/protocol.rs` 的单元测试守着 ——
// 那里可以直接构造输入，比在这里读文本强得多。
//
// 「真的拉起一个 Node 进程走完一次请求-响应」由
// `live_tests::a_real_node_host_answers_a_ping` 守着（它会在环境里找不到 Node 时
// 跳过而不是失败）。
//
// 这里查的是**只有跨文件才看得出来**的那一类问题：
//
//   · 命令名在前后端对不上（前端 `invoke` 一个不存在的命令，类型检查与编译
//     都不会报错，只有运行到那一步才知道）；
//   · **宿主脚本的协议版本与 Rust 侧一致** —— 两者分别是 JS 与 Rust 里的一个字面量，
//     没有任何编译器把她们联系在一起，而错配的后果是后台功能完全不可用；
//   · 宿主脚本被当作打包资源分发（漏掉它 = 用户机器上永远找不到脚本）；
//   · 前端**只暴露通道层的能力**，不假装插件已经在后台跑起来了。

import { readFileSync, existsSync } from 'node:fs';
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

const libRs = read('src-tauri/src/lib.rs');
const protocolRs = read('src-tauri/src/modules/desktop/background/protocol.rs');
const desktopModRs = read('src-tauri/src/modules/desktop/mod.rs');
const serviceTs = read('src/services/backgroundHost.ts');
const tauriConf = read('src-tauri/tauri.conf.json');
const backgroundModRs = read('src-tauri/src/modules/desktop/background/mod.rs');
const desktopCommandsRs = read('src-tauri/src/modules/desktop/commands.rs');
const schedulesRs = read('src-tauri/src/modules/desktop/background/schedules.rs');
const eventsRs = read('src-tauri/src/modules/desktop/events.rs');
const remindersTs = read('src/services/reminders.ts');

const SCRIPT_PATH = 'src-tauri/resources/background-host.mjs';
const script = read(SCRIPT_PATH);

// ============================================================
// 1. 命令名前后端一致
// ============================================================
console.log('命令接线：');

const commands = [
  'background_host_status',
  'background_host_probe',
  'background_host_shutdown',
];

for (const command of commands) {
  check(libRs.includes(`${command},`), `${command} 已注册进 lib.rs`);
  check(
    serviceTs.includes(`invoke<`) && serviceTs.includes(`'${command}'`),
    `前端 backgroundHost.ts 里的 ${command} 与后端同名`
  );
}

check(
  desktopModRs.includes('app.manage(commands::BackgroundState::new())'),
  '后台宿主的托管状态在模块 setup 里建立'
);
check(
  /按需拉起/.test(desktopModRs),
  'setup 的注释说明了「这里不拉起子进程」（否则每个用户都要多付一个进程）'
);
check(
  desktopModRs.includes('fn stop(') && desktopModRs.includes('host.shutdown()'),
  '模块 stop 时优雅停止后台宿主（强杀会让插件来不及保存状态）'
);

// ============================================================
// 2. 协议版本两侧一致（没有任何编译器会帮我们检查这个）
// ============================================================
console.log('\n协议版本：');

const rustVersion = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(protocolRs)?.[1];
const jsVersion = /const PROTOCOL_VERSION = (\d+);/.exec(script)?.[1];

check(rustVersion !== undefined, `Rust 侧声明了协议版本（${rustVersion}）`);
check(jsVersion !== undefined, `宿主脚本声明了协议版本（${jsVersion}）`);
check(
  rustVersion !== undefined && rustVersion === jsVersion,
  `两侧协议版本一致（Rust ${rustVersion} / JS ${jsVersion}）—— 错配会让后台功能完全不可用`
);

// 宿主脚本必须逐条校验版本，而不是只在启动时检查一次：
// 应用可能在使用中被升级，而继续用旧语义解释新字段会得出错误的结论。
check(
  /request\.v !== PROTOCOL_VERSION/.test(script),
  '宿主脚本**逐条**校验请求的协议版本（不只是启动时检查一次）'
);

// ============================================================
// 3. 宿主脚本的健壮性要求
// ============================================================
console.log('\n宿主脚本：');

check(existsSync(join(PROJECT_ROOT, SCRIPT_PATH)), '宿主脚本文件存在');

check(
  /process\.stdout\.write\(\s*`\$\{JSON\.stringify\(/.test(script) ||
    script.includes('JSON.stringify({') ,
  '脚本启动时先打印一行问候（宿主的第一行读取在等它）'
);
check(
  script.indexOf('v: PROTOCOL_VERSION') < script.indexOf('process.stdin.on('),
  '问候在订阅 stdin **之前**发出（顺序反了会让宿主读到的第一行不是问候）'
);

// 未知方法必须报错，而不是静默成功 —— 静默成功是最难发现的一类错误
check(
  /未知方法/.test(script),
  '未知方法返回错误（静默成功会让调用方以为"做完了"）'
);

// 一行解析不了不能让进程退出：那会把一次格式错误升级成"后台功能永久失效"
check(
  /catch[\s\S]{0,200}?无法解析的一行[\s\S]{0,200}?return;/.test(script),
  '解析失败的一行只记日志并跳过，不终止进程'
);

// 响应必须恰好有 result 或 error 之一（与 Rust 侧的 validate 对应）
check(
  script.includes('payload.error = String(error)'),
  '脚本把业务失败放进 error 字段（通道正常、方法失败）'
);
check(
  !/payload\.result\s*=[\s\S]{0,120}?payload\.error\s*=/.test(script),
  '同一条响应里不会同时写 result 与 error（会被宿主判为歧义并拒绝）'
);

// stdin 关闭 = 宿主走了，脚本要跟着退，不要变成孤儿进程
check(
  /process\.stdin\.on\('end'/.test(script),
  'stdin 关闭时脚本自行退出（否则会留下孤儿进程）'
);

// 停止请求要先回响应再退出：立刻 process.exit 会把响应留在管道缓冲区里
check(
  /shutdown\(\)[\s\S]{0,600}?setImmediate/.test(script),
  '停止时先回响应、再在下一个事件循环退出（立刻退出会让宿主只能等超时）'
);

// 未捕获异常要记日志：否则宿主只会看到"没有响应"，而真正的原因消失了
check(
  script.includes('uncaughtException') && script.includes('unhandledRejection'),
  '未捕获异常与未处理的 Promise 拒绝都记进日志'
);

// 缓冲区上限两侧一致：不一致会让"对面为什么突然不说话了"变成一个没有线索的问题
const rustMaxLine = /pub const MAX_LINE_BYTES: usize = (\d+) \* (\d+);/.exec(protocolRs);
const jsMaxBuffer = /buffer\.length > (\d+) \* (\d+)/.exec(script);
check(rustMaxLine !== null, 'Rust 侧声明了单行长度上限');
check(jsMaxBuffer !== null, '脚本声明了输入缓冲区上限');
check(
  rustMaxLine !== null &&
    jsMaxBuffer !== null &&
    rustMaxLine[1] === jsMaxBuffer[1] &&
    rustMaxLine[2] === jsMaxBuffer[2],
  '两侧的单行/缓冲区上限一致'
);

// ============================================================
// 4. 宿主脚本随包分发
// ============================================================
//
// 漏掉这一步的后果很具体：开发机上一切正常（脚本在仓库里），而用户机器上
// 永远找不到它 —— 后台功能在**发布版**里不可用，且只在发布版里不可用。
console.log('\n打包：');

check(
  /"resources"\s*:/.test(tauriConf),
  'tauri.conf.json 声明了 bundle.resources（否则脚本不会随包分发）'
);
check(
  /background-host\.mjs/.test(tauriConf),
  'background-host.mjs 在打包资源列表里（漏掉它 = 只有发布版不可用）'
);

// ============================================================
// 5. 前端不夸大能力
// ============================================================
console.log('\n前端的诚实性：');

check(
  /插件代码的加载与执行\*\*仍未实现\*\*|插件执行尚未实现/.test(serviceTs),
  '服务模块的注释如实说明"插件执行尚未实现"'
);
check(
  !/loadBackgroundPlugin|runBackgroundPlugin|ctx\.background/.test(serviceTs),
  '前端没有暴露不存在的插件执行接口（假装有会让插件作者白写代码）'
);
check(
  /getBackgroundStatus[\s\S]{0,400}?不启动子进程/.test(serviceTs) ||
    /不启动子进程/.test(serviceTs),
  '状态查询注明不启动子进程（打开设置页不该拉起一个 Node）'
);

// ============================================================
// 6. Node 运行时的发现路径
// ============================================================
//
// 这一段守的是**用户报告过的一个真实缺陷**：在 cmd 里 `node --version` 有版本，
// 应用里却说"未找到 Node 运行时"。原因是 cmd 会走 PATH，而当时的实现没有查 PATH。
//
// 这里守住的是"查找顺序被写下来了、PATH 与常见安装位置真的在计划里"。
// "真的能从 PATH 找到"由 `live_tests::a_node_on_the_path_is_found` 守着 ——
// 它把常见安装位置清空，因此找到只可能来自 PATH。
console.log('\nNode 运行时的发现路径：');

check(
  /fn resolve_node\(configured: Option<&str>\)/.test(backgroundModRs),
  'resolve_node 接受"用户在设置里指定的路径"（界面里能选，不必改环境变量）'
);
check(
  /fn plan_node_search\(/.test(backgroundModRs) && /NodeSearchPlan/.test(backgroundModRs),
  '查找顺序被抽成纯函数计划（顺序错了会像"没找到"一样无声，因此必须可单测）'
);
check(
  /path_dirs: Vec<PathBuf>/.test(backgroundModRs) && /split_paths/.test(backgroundModRs),
  '**系统 PATH 会被查找** —— 这正是"cmd 里有、软件里没有"那个缺陷的修复'
);
check(
  /ProgramFiles/.test(backgroundModRs) && /nodejs/.test(backgroundModRs),
  '常见安装位置也在查找范围内（多数机器不必手工指定）'
);
check(
  /MODULITH_NODE_SEARCH_BASES/.test(backgroundModRs),
  '常见安装位置可以用环境变量替换（测试要能造出"哪里都没有"的前提）'
);
check(
  /fn platform_base_dirs\(\)/.test(backgroundModRs),
  '平台目录是**参数传进**纯函数的，不是在它内部偷偷读环境变量'
);
check(
  /指定的 Node 路径不存在/.test(backgroundModRs),
  '显式指定过路径但不存在时，错误里要指出那个路径（而不是笼统的"未找到"）'
);
check(
  /逐目录检查存在性|Command::new` 不能直接执行/.test(backgroundModRs) ||
    /candidate\.is_file\(\)/.test(backgroundModRs),
  'PATH 查找逐目录确认是真实文件（Windows 上 PATH 里的 `node` 可能是 .cmd 包装）'
);

// 命令接线：设置页要能查、能设
for (const command of ['detect_node_runtime', 'set_node_runtime_path']) {
  check(libRs.includes(`${command},`), `命令 ${command} 已注册进 lib.rs`);
  check(serviceTs.includes(`'${command}'`), `前端 backgroundHost.ts 调用了 ${command}`);
}

// 保存路径时必须**真的验证**：只检查文件存在不够（用户可能选到别的同名文件，
// 或一个缺 DLL 的残包）。验证失败还要回滚，否则留下的是"看着配好了、实际跑不起来"。
check(
  /set_node_runtime_path[\s\S]{0,2500}?ping\(\)\.await/.test(desktopCommandsRs),
  '保存 Node 路径时会真的拉起一次后台宿主来验证'
);
check(
  /set_node_runtime_path[\s\S]{0,3000}?rolled\.node_runtime_path = previous/.test(
    desktopCommandsRs
  ),
  '验证失败会**回滚**设置（留下跑不起来的路径比明确失败更糟）'
);
check(
  /\*self\.node\.lock\(\)\.unwrap\(\) = None/.test(backgroundModRs),
  '改路径时会清掉解析缓存（否则"改完设置没生效，非要重启"）'
);

// 随包分发：资源声明必须容得下"没有放 Node"
check(
  /"runtime\/\*"/.test(tauriConf),
  'bundle.resources 里有 runtime/* —— 通配让"目录为空"时构建照常成功'
);
check(
  /resources\/runtime\//.test(tauriConf),
  '它被放进安装目录的 resources/runtime/'
);
check(
  /dir\.join\("resources"\)\.join\("runtime"\)/.test(backgroundModRs),
  '解析器同时试 resources/runtime/（开发与安装两种布局的资源位置不同）'
);

// 用户不该被迫改环境变量：界面里必须有一条手工指定的路
const perfSettingsTsx = read('src/components/Settings/PerformanceSettings.tsx');
check(
  /setNodeRuntimePath/.test(perfSettingsTsx),
  '设置 → 性能 里有手工指定 Node 路径的入口'
);
check(
  /detectNodeRuntime/.test(perfSettingsTsx),
  '那一节会把探测结果显示出来（找到没有、用的是哪个路径、失败原因）'
);

// ============================================================
// 6. 出站事件：子进程主动说话的那一半
// ============================================================
//
// 这一步补上的是协议里最容易漏掉的一半。此前的通道只能"你问我答"，
// 而后台能力恰恰要在**没有人问的时候**做事（定时提醒到点）。
//
// 这里要守住的关键点是：事件与响应共用一条 stdout，必须靠**有没有 id** 区分。
// 判定写错的表现极其难查 —— 一条事件会被当成"id 对不上的响应"丢掉，
// 于是"提醒到点了但什么都没发生"，而日志里只有一行 debug。
console.log('\n出站事件：');

check(
  /pub struct Event\b/.test(protocolRs) &&
    /pub event: String/.test(protocolRs) &&
    /pub subject: String/.test(protocolRs),
  'Rust 侧有事件的类型定义（名 + 主体 + 数据）'
);
check(
  /pub enum Frame\b/.test(protocolRs) &&
    /Frame::Response\(/.test(protocolRs) &&
    /Frame::Event\(/.test(protocolRs),
  '解析结果用枚举把响应与事件在**类型上**分开（而不是看 id 是不是 0）'
);
check(
  /fn decode_frame/.test(protocolRs),
  '有统一的 decode_frame 作为唯一解析入口'
);
check(
  /Event:\s*serde_json::from_str/.test(protocolRs) ||
    /from_str::<Event>/.test(protocolRs) ||
    /let event: Event = serde_json::from_str/.test(protocolRs),
  '事件解析在响应解析失败之后作为第二分支（响应有必填 id，因此不会两者都成功）'
);
check(
  /UnexpectedEvent/.test(protocolRs),
  'decode_response 遇到事件时会报一个有名字的错误（不静默丢弃）'
);
check(
  /protocol::Frame::Event\(event\)[\s\S]{0,600}?handler/.test(backgroundModRs),
  '读循环把事件交给处理函数，而不是丢掉'
);
check(
  /fn spawn_reader[\s\S]*?event_handler\.lock\(\)\.unwrap\(\)\.clone\(\)/.test(backgroundModRs) ||
    /let handler = self\.event_handler\.lock\(\)\.unwrap\(\)\.clone\(\)/.test(backgroundModRs),
  '事件处理函数在起读任务时就被取出来（读任务里不能再取锁）'
);
check(
  /event\.validate\(\)/.test(backgroundModRs),
  '读循环对事件也逐条校验版本（字段语义可能已经变了）'
);
check(
  /收到后台事件「\{\}」但没有任何处理函数/.test(backgroundModRs),
  '没有处理函数时事件会被记录，而不是静默消失'
);

// ============================================================
// 7. 定时提醒：定义在应用侧、计时在后台侧
// ============================================================
//
// 这个分工是这一步最重要的设计决定，因此它值得被门禁钉住：
// 定义（落盘、校验、界面）属于应用；计时（到点叫一声）属于后台。
// 两边都做全部会让"两份实现迟早分叉"，而分叉的表现是
// "界面显示 9:00 响，实际 10:00 响"。
console.log('\n定时提醒的分工：');

check(
  /const MISSED_GRACE_MS/.test(script) && /nextDailyAt/.test(script),
  '宿主脚本自己算每次的绝对触发时刻（而不是用会漂移的 setInterval）'
);
check(
  /function rearm\(\)/.test(script),
  '宿主脚本每次全量重建唯一的定时器（指向最早的下一次）'
);
check(
  /scheduleSync/.test(script) && /scheduleList/.test(script) && /scheduleRunNow/.test(script),
  '宿主脚本实现了同步 / 查询 / 立即触发三种定时任务方法'
);
check(
  /scheduleSync/.test(protocolRs) && /ScheduleSync/.test(protocolRs),
  'Rust 侧的方法枚举里有 ScheduleSync（否则调用会以"未知方法"失败）'
);
check(
  /fn specs_for_host/.test(schedulesRs) && /filter\(\|item\| item\.enabled\)/.test(schedulesRs),
  '停用的提醒**不会被推送**给后台（而不是推过去再忽略）'
);
check(
  !/nextDailyAt[\s\S]{0,200}/.test(schedulesRs) || !/fn next_at/.test(schedulesRs),
  'Rust 侧**不算**触发时刻（时刻只从后台读回来，避免两份实现分叉）'
);
check(
  /MIN_INTERVAL_SECONDS/.test(schedulesRs) && /间隔太短/.test(schedulesRs),
  '间隔过短会被**明确拒绝**，而不是被悄悄抬到下限'
);
check(
  /一次性提醒的时刻必须在将来/.test(schedulesRs),
  '一次性提醒拒绝过去时刻（否则保存动作本身就会把它弹出来）'
);
check(
  /set_schedules/.test(backgroundModRs) && /push_schedules/.test(backgroundModRs),
  '子进程每次被拉起后自动重新推送定时任务（它自己无状态）'
);
check(
  /if push_schedules/.test(backgroundModRs),
  '推送只在**这次真的启动**时发生（否则同步会无限递归）'
);

// ============================================================
// 8. 提醒到点 → 通知中心
// ============================================================
//
// 这一段是"后台事件"与"用户看见"之间的唯一连接。它同时守着一条很容易
// 被"顺手优化掉"的规则：去重键必须**随触发次数变化** ——
// 否则一个每小时的提醒会把上一条合并掉，用户永远只看到 1 条。
console.log('\n提醒 → 通知：');

check(
  /EVENT_SCHEDULE_FIRED: &str = "schedule\.fired"/.test(eventsRs),
  '事件名是 schedule.fired（与宿主脚本 emitEvent 的第一个参数一致）'
);
check(
  /emitEvent\('schedule\.fired'/.test(script),
  '宿主脚本确实发出名为 schedule.fired 的事件'
);
check(
  /broadcast_changed/.test(eventsRs),
  '提醒进入通知中心后会广播变化（否则铃铛徽标不会更新）'
);
check(
  /schedule\.fired:\{\}:\{\}/.test(eventsRs),
  '去重键包含触发时刻（重复提醒不能互相合并）'
);
check(
  /notifications/.test(desktopModRs) && /vec!\["settings", "logging", "notifications"\]/.test(desktopModRs),
  'desktop 模块声明依赖 notifications（否则提醒可能在通知模块初始化之前到达）'
);

// ============================================================
// 9. 前端只转发、不重复实现后端规则
// ============================================================
console.log('\n前端提醒：');

check(
  /export async function saveReminder/.test(remindersTs) &&
    /export async function listReminders/.test(remindersTs),
  '前端有提醒的读写门面'
);
check(
  /只从后台宿主读回来|不参与判断/.test(remindersTs),
  '前端注明"下一次什么时候响"只从后台读（自己不参与判断）'
);
check(
  !/function nextDaily|function computeNextAt/.test(remindersTs),
  '前端没有自己实现一遍触发时刻计算（那必然与后台分叉）'
);
check(
  /getReminderRuntime[\s\S]{0,900}?typeof error === 'string'/.test(remindersTs),
  '运行态查询失败时返回状态而不是抛错（Tauri 的 Err 是裸字符串）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
