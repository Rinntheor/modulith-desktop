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

/**
 * 剥掉行注释与块注释。
 *
 * **反面判据（"不许出现某个词"）必须对着剥干净的代码做。** 这一条在本仓库里
 * 反复踩到：被禁用的写法（`--allow-net`、`process.permission.has`、`add_child`）
 * 恰好都是被**长篇解释过为什么不能用**的词，于是注释里写着它、断言就红了 ——
 * 而修它的唯一办法是删掉注释，也就是最该留下的那份知识第一个消失。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const libRs = read('src-tauri/src/lib.rs');
const protocolRs = read('src-tauri/src/modules/desktop/background/protocol.rs');
const desktopModRs = read('src-tauri/src/modules/desktop/mod.rs');
const serviceTs = read('src/services/backgroundHost.ts');
const tauriConf = read('src-tauri/tauri.conf.json');
const backgroundModRs = read('src-tauri/src/modules/desktop/background/mod.rs');
const desktopCommandsRs = read('src-tauri/src/modules/desktop/commands.rs');
const backgroundPluginsRs = read('src-tauri/src/modules/desktop/background/plugins.rs');
const backgroundPluginsTs = read('src/services/backgroundPlugins.ts');
const bootTs = read('src/services/boot.ts');
const pluginDrawerTsx = read('src/modules/plugins/PluginDetailDrawer.tsx');

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
  desktopModRs.includes('fn stop(') && /\.shutdown\(\)/.test(desktopModRs),
  '模块 stop 时优雅停止后台宿主（强杀会让插件来不及保存状态）'
);

// 后台插件是**各自独立的进程**，而它们同样必须在退出前被优雅收掉。
//
// 这条断言是这次改动**顺带补上**的：原来的检查只看通用宿主的 `shutdown()`，
// 于是"插件进程被随进程一起强杀"这件事不会被任何一条断言拦住 ——
// 而强杀的后台插件来不及落盘，表现出来是"关掉应用之后数据丢了"。
check(
  /stop_all\(\)/.test(desktopModRs),
  '模块 stop 时也收掉全部后台插件进程（否则它们被随进程强杀，来不及落盘）'
);

// 后台插件必须先于通用宿主停止：顺序反过来的话，通用宿主已经走了，
// 而插件进程还在跑着写数据。
check(
  desktopModRs.indexOf('stop_all()') < desktopModRs.indexOf('.0.shutdown()'),
  '后台插件先于通用后台宿主停止'
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
//
// 变量名是 `message` 而不是 `request`：协议从 2 起是**双向**的（子进程也会
// 发起请求），因此读循环里那个东西已经不再一定是"一条请求"了。
check(
  /message\.v !== PROTOCOL_VERSION/.test(script),
  '宿主脚本**逐条**校验消息的协议版本（不只是启动时检查一次）'
);

// 反向消息的分类只能依赖"有没有 method"这一个判据。
//
// 这条断言守的是一次具体的手滑：把子进程发来的 `ctx.*` 请求当成响应，
// 于是它在待处理表里查不到 id、被记成一句"收到没有等待者的响应"然后丢掉 ——
// 而插件那边只是永远等不到回答。
check(
  /message\.method === undefined/.test(script) && /deliverResponse\(message\)/.test(script),
  '宿主脚本把「不带 method 的消息」识别为响应并交给等待者'
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
// N. 后台插件的 ctx 与共用实现必须逐条对上
// ============================================================
//
// 同一个 `ctx` 现在有**三个**参与方：
//
//   1. `resources/sandbox-bridge.js`  —— 沙箱界面插件读到的形状
//   2. `resources/background-host.mjs` —— 后台插件读到的形状
//   3. `src/modules/plugins/rpc.rs`   —— 两者的**共同**实现
//
// `check:sandbox` 守着 (1) ↔ (3)。这里守 (2) ↔ (3)：后台那条路径的每一个
// `ctx.*` 调用都必须在共用方法表里有对应分支。
//
// 写错一个字的表现是：后台插件在某个成员上收到一句"未知的 RPC 方法"，
// 而那句话在日志里看起来像插件自己乱调 —— 两边的代码又都"看起来是对的"。
console.log('\n后台插件的 ctx 表面：');

{
  const rpcRs = read('src-tauri/src/modules/plugins/rpc.rs');

  const called = new Set(
    [...script.matchAll(/callHost\(\s*'ctx\.([a-zA-Z.]+)'/g)].map((match) => match[1])
  );

  check(called.size > 0, `后台宿主脚本调用了 ${called.size} 个 ctx 成员`);

  const dispatchStart = rpcRs.indexOf('pub async fn dispatch');
  const dispatchEnd = rpcRs.indexOf('#[cfg(test)]');
  check(
    dispatchStart > 0 && dispatchEnd > dispatchStart,
    '能在 rpc.rs 里定位到 ctx 的方法表'
  );

  const dispatch = dispatchStart > 0 && dispatchEnd > dispatchStart
    ? rpcRs.slice(dispatchStart, dispatchEnd)
    : '';
  const handled = new Set(
    [...dispatch.matchAll(/^ {8}"([a-zA-Z]+(?:\.[a-zA-Z]+)?)"\s*=>/gm)].map((match) => match[1])
  );

  const orphans = [...called].filter((name) => !handled.has(name));
  check(
    orphans.length === 0,
    orphans.length === 0
      ? `后台插件调用的 ${called.size} 个 ctx 成员在共用实现里都有分支`
      : `共用实现里没有这些成员：${orphans.join('、')}`
  );

  // ============================================================
  // 隔离的两条硬要求
  // ============================================================

  // 1. 子进程必须清空环境变量。
  //
  // `process.env` 在 `--permission` 之下**仍然可读**（实测），而环境变量里
  // 常常有令牌。不清的话，一个逃出 vm 的插件能把整份环境整个读走。
  check(
    /clear_env:\s*true/.test(read('src-tauri/src/modules/desktop/background/plugins.rs')),
    '后台插件进程以 clear_env 启动（process.env 在权限模型下仍然可读）'
  );

  // 2. 权限模型的门槛必须是"不够就降级"，而不是"未知即支持"。
  check(
    /PERMISSION_MODEL_MIN_MAJOR:\s*u64\s*=\s*(\d+)/.test(
      read('src-tauri/src/modules/desktop/background/plugins.rs')
    ),
    '后台插件有一个明确的 Node 版本门槛'
  );

  // 3. 放行目录只能是插件自己的代码目录 —— 数据目录**不**放开，
  //    因为 `ctx.dataDir.*` 全部经过宿主，子进程根本不需要碰那些文件。
  const pluginHostRs = read('src-tauri/src/modules/desktop/background/plugins.rs');
  check(
    /--allow-fs-read=/.test(pluginHostRs) && !/--allow-fs-write=/.test(pluginHostRs),
    '子进程只被放开读权限，且没有任何写权限'
  );

  // **判据必须落在"构造 node_args 那一段"上，不能是"整个文件里没有这个词"。**
  //
  // 这一条原本写的是 `!/--allow-net/.test(plugins.rs)` —— 它守的是"宿主不传
  // `--allow-net`"，而实现成"这个词不许出现在文件里"。后来加了网络能力探测
  // （`NET_SCOPE_FLAG`，它**必须**写出这个词才能去 `--help` 里找），那条断言
  // 就红了。被拦下的不是缺陷，是这条断言自己太钝。
  //
  // 现在的判据是：只放开读、且**额外**放开的旗标一个都没有（白名单之外全禁）。
  const extraGrants = pluginHostRs
    .split('\n')
    .filter((line) => line.trimStart().startsWith('node_args.push('))
    .join('\n');
  check(
    extraGrants.length > 0 && !/--allow-(child-process|worker|addons|net|wasi|inspector)/.test(extraGrants),
    'node_args 里除了 --permission / --allow-fs-read 之外没有放开任何一项'
  );

  // ============================================================
  // 网络那一项：宿主不放开它，而"不放开"到底等不等于"拒绝"是**版本相关的**
  // ============================================================
  //
  // 这一节存在的理由是一次实测（`staging/probe-node-net.cjs`）：在
  // `--permission --allow-fs-read=<dir>` 之下，Node 24.15.0 的
  // `dns.lookup('example.com')` **成功**、`net.connect` / `fetch` 得到的都不是
  // `ERR_ACCESS_DENIED` —— 也就是说那台机器上"权限模型一项网络操作都没拦"。
  // 因此 `isolated: true` **不等于**网络被管住，界面必须分开说。
  check(
    /NET_SCOPE_FLAG: &str = "--allow-net"/.test(pluginHostRs),
    '网络那一项的旗标名是一个常量（拼错方向很坏：会给出一个"更安全"的假警报）'
  );

  // 判据必须是 `--help`，**不能**是 `process.permission.has('net')`。
  //
  // 后者实测对不存在的 scope 同样返回 `false`（连 `'fs.read'` 都返回 `false`），
  // 分不出"拒绝了"与"这个 scope 不存在" —— 用它做探测会得到一个永远为假的答案，
  // 而那个答案看起来是"安全"。
  check(
    /async fn net_scope_supported\(&self, node: &Path\) -> bool/.test(pluginHostRs) &&
      /\.arg\("--help"\)/.test(pluginHostRs),
    '网络能力靠 <node> --help 探测（不是 process.permission.has，那个分不出"不存在"）'
  );
  // 反面判据对着**剥掉注释**的代码做：上面那段 doc 注释里就写着
  // `process.permission.has('net')`（为了说明为什么不能用它），
  // 不剥注释的话这条断言会被自己的解释文字打红。
  const pluginHostCode = stripComments(pluginHostRs);
  check(
    !/process\.permission\.has/.test(pluginHostCode),
    '没有用 process.permission.has 判网络（它对不存在的 scope 也返回 false）'
  );
  check(
    /net_restricted:\s*entry\.isolated\s*&&\s*net_scope\.unwrap_or\(false\)/.test(pluginHostRs),
    'net_restricted = 权限模型开着 **且** 那个 scope 真的存在（两者缺一，网络就不受管）'
  );
  // 缓存没填上时报 `false`（"没被管住"）：在拿到证据之前不该宣称网络已被限制。
  check(
    /net_scope\.unwrap_or\(false\)/.test(pluginHostRs),
    '没探测到就按"没被管住"报（在拿到证据之前不宣称安全）'
  );
  // 拉起子进程时顺便探测，因为 `status()` 是同步的、只能读缓存。
  check(
    /let net_scope = self\.net_scope_supported\(&node\)\.await;/.test(pluginHostRs),
    '启动子进程时顺手填上缓存（status() 是同步的，只能读缓存）'
  );
  check(
    /if isolated && !net_scope \{[\s\S]{0,700}?log::warn!/.test(pluginHostRs),
    '权限模型开着但管不住网络时留下一条警告日志'
  );

  // 前端两侧都要接上：类型字段 + 界面说出来。少了任何一半，用户都读不到这件事。
  check(
    /netRestricted: boolean;/.test(backgroundPluginsTs),
    '前端类型里有 netRestricted（它必须与 isolated 分开）'
  );
  check(
    /const netOpen = started\.filter\(\(item\) => item\.running && !item\.netRestricted\);/.test(
      bootTs
    ),
    '启动时把"网络不受管"单独报出来（合成一句"已隔离"会让用户以为插件连不上网）'
  );
  check(
    /backend\.status\.netRestricted/.test(pluginDrawerTsx) &&
      /但它的网络不受管/.test(pluginDrawerTsx),
    '插件详情里分别说隔离与网络两件事'
  );
}


if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);