// scripts/check-boot-order.ts
//
// 启动顺序门禁：**前端在第一个 invoke 之前必须等后端就绪**。
//
// ============================================================
// 它为什么存在
// ============================================================
//
// v1.6.0 的发行版有一个每次冷启动必现的缺陷：
//
//   读取应用设置    1/1  60ms  使用内置默认模块
//   检查访问授权    0/2  10ms  正在读取授权状态
//   state not managed for field `state` on command `get_auth_status`.
//   You must call `.manage()` before using this command
//
// 点「重试初始化」就能进，而下次冷启动照旧。根因是**进程之间的竞速**：主窗口由
// Tauri 在创建阶段就建好并开始加载前端资源，而各模块的状态是在 Rust `setup` 钩子
// 里注入的（`setup_all` → `app.manage(...)`），两者之间没有任何同步。打包产物的
// 日志给出了窗口大小：webview 已经在取嵌入资源时，`SettingsState` / `AuthState`
// 的注入还分别晚 25ms / 39ms。
//
// 开发模式永远看不到它 —— `devUrl` 那一跳（连 Vite、按需 transform 上百个 ESM
// 模块）比 `setup_all` 的磁盘 IO 慢一个数量级，恰好把竞速盖住。
//
// ============================================================
// 为什么必须是这个形状的门禁
// ============================================================
//
// 这是一个**只在发行版、且依赖时序**的缺陷：源码级断言是唯一能在 CI 里拦住它的
// 手段（跑一次真机冷启动不在门禁的能力范围内）。而这个缺陷最危险的地方在于它的
// 修法很容易被后续改动悄悄推翻：
//
//   · 把闸门那一句删掉、或者挪到某个 invoke 之后 —— 表现又回到"每次冷启动都要
//     点一次重试"；
//   · 给 `boot.ts` 加一个会在闸门之前 invoke 的新步骤 —— 同一个缺陷换一条命令重现；
//   · 把 `backend_ready` 从 `generate_handler!` 里漏掉（它是宿主命令，由
//     `generate-backend-module.ts` 的 `HOST_ONLY_COMMANDS` 维护）—— 闸门会白等到
//     超时，功能"能用"但每次启动慢 3 秒；
//   · 把 `ReadyState` 的 `manage` 从 builder 链挪进 setup —— 那恰好把它变回
//     它要修的那个竞态。
//
// 因此下面把这条链路的**每一环**都钉住，并且两侧都查（Rust 侧的状态与信号、
// 前端侧的闸门位置）。
//
// 用法：`pnpm check:boot-order`

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
const failures: string[] = [];

function check(condition: boolean, description: string, why?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ${GREEN}✔${RESET} ${description}`);
    return;
  }
  failures.push(why ? `${description}\n      ${DIM}${why}${RESET}` : description);
  console.log(`  ${RED}✘${RESET} ${description}`);
}

function read(rel: string): string {
  const path = join(ROOT, rel);
  if (!existsSync(path)) throw new Error(`找不到文件：${rel}`);
  return readFileSync(path, 'utf-8');
}

const registryRs = read('src-tauri/src/core/registry.rs');
const libRs = read('src-tauri/src/lib.rs');
const bootTs = read('src/services/boot.ts');
const mainTsx = read('src/main.tsx');
const readyTs = read('src/services/backendReady.ts');
const generatorTs = read('scripts/generate-backend-module.ts');
const buildRs = read('src-tauri/build.rs');
const capabilityJson = read('src-tauri/capabilities/app-commands.json');

console.log(`\n${BOLD}后端侧：就绪信号的真源${RESET}`);

check(
  /pub fn is_ready\(&self\) -> bool/.test(registryRs),
  'ModuleRegistry 有 is_ready',
  '前端闸门的判据必须来自模块生命周期本身，而不是另记一个可能漂的布尔量'
);

check(
  /self\.ready\.store\(true, Ordering::SeqCst\);/.test(registryRs),
  'start_all 结束时把就绪置位',
  '就绪必须等于"全部模块已启动"；提前置位等于闸门形同虚设'
);

check(
  /ready: AtomicBool/.test(registryRs) && /pub struct ReadyState/.test(registryRs),
  '存在可从命令侧查询的 ReadyState',
  'setup 期间 ModuleRegistry 还被局部变量持有，前端拿不到它，因此需要一个更早可用的信号'
);

// 就绪置位必须发生在 start_all 的循环**之后**：若它在循环之前或之中，
// 前端可能在模块还没启动完时就放行。
const startAllAt = registryRs.indexOf('pub fn start_all');
const storeAt = registryRs.indexOf('self.ready.store(true, Ordering::SeqCst);');
const firstStartCallAt = registryRs.indexOf('module.start(app)', startAllAt);
check(
  startAllAt >= 0 && storeAt > startAllAt && firstStartCallAt > startAllAt && storeAt > firstStartCallAt,
  '就绪置位在 start_all 的启动循环之后',
  '置位早于"所有模块都 start 过"会让前端拿到一个半初始化的后端'
);

console.log(`\n${BOLD}后端侧：托管时机与广播${RESET}`);

// ReadyState 必须挂在 builder 链上（setup 之前）。判据是它的 manage 出现在
// `.setup(` 之前。
const readyManage = 'builder.manage(core::registry::ReadyState::new());';
check(libRs.includes(readyManage), 'lib.rs 托管了 ReadyState');
check(
  libRs.indexOf(readyManage) < libRs.indexOf('builder.setup('),
  'ReadyState 的 manage 在 setup **之前**',
  '挪进 setup 就把它变回它要修的那个竞态：setup 期间前端已经在 invoke 了'
);

// 广播与置位必须在 app.manage(registry) 之后：否则前端收到信号后立刻调用依赖
// ModuleRegistry 的命令，会撞上"还没托管"。
const manageRegistryAt = libRs.indexOf('app.manage(registry);');
check(manageRegistryAt >= 0, 'lib.rs 托管了 ModuleRegistry');
check(
  manageRegistryAt >= 0 && libRs.indexOf('state.mark_ready();') > manageRegistryAt,
  '就绪置位在 app.manage(registry) **之后**',
  '顺序反了，闸门自己就会制造一次同类竞态'
);
check(
  libRs.includes('app.emit(core::registry::BACKEND_READY_EVENT, ())'),
  'setup 末尾广播了 modulith://backend-ready 事件'
);
check(
  /BACKEND_READY_EVENT: &str = "modulith:\/\/backend-ready"/.test(registryRs),
  '事件名沿用 modulith:// 前缀',
  '仓库里既有的广播都是这个前缀；另起一套会让人以为这是另一种机制'
);

console.log(`\n${BOLD}后端侧：backend_ready 命令的三处清单${RESET}`);

// 应用级 ACL 清单一经声明，未授权的命令对所有人不可用 —— 而且只在运行期显形。
check(
  libRs.includes('pub async fn backend_ready('),
  'lib.rs 定义了 backend_ready',
  '它是宿主命令，不属于任何模块'
);
check(libRs.includes('        backend_ready,'), 'backend_ready 进了 generate_handler!');
check(buildRs.includes('"backend_ready",'), 'backend_ready 进了 build.rs 的 AppManifest');
check(
  capabilityJson.includes('"allow-backend-ready"'),
  'backend_ready 在 app-commands.json 里被授权'
);
check(
  /HOST_ONLY_COMMANDS = \['backend_ready'\]/.test(generatorTs),
  '生成器把 backend_ready 记在 HOST_ONLY_COMMANDS 里',
  '不记的话下一次 pnpm gen:backend 会把它从 generate_handler! 里删掉 —— ' +
    '那时闸门白等到超时，功能"能用"但每次启动慢 3 秒'
);
check(
  generatorTs.includes('builder.manage(core::registry::ReadyState::new());'),
  '生成器模板里也有 ReadyState 的 manage',
  '改生成文件而不改模板等于下次生成就被覆盖'
);
check(
  generatorTs.includes('app.emit(core::registry::BACKEND_READY_EVENT, ())'),
  '生成器模板里也有就绪广播'
);

console.log(`\n${BOLD}前端侧：闸门的位置${RESET}`);

check(
  /export function installBackendReadyGate\(\): Promise<void>/.test(readyTs),
  'backendReady.ts 提供 installBackendReadyGate',
  '闸门必须是一个显式装置，而不是散落在各处的重试'
);
check(
  readyTs.includes(`BACKEND_READY_EVENT = 'modulith://backend-ready'`) &&
    readyTs.includes(`BACKEND_READY_COMMAND = 'backend_ready'`),
  '闸门引用的命令名与事件名与 Rust 一致'
);
check(
  /whenBackendReady\(\)/.test(bootTs),
  'boot.ts 在启动流程里等闸门'
);

// 闸门必须是 run() 里**第一件**会 await 的事，且在所有 STEPS 之前。
const runAt = bootTs.indexOf('private async run(): Promise<BootState>');
check(runAt >= 0, 'boot.ts 有 run()');
const gateAt = bootTs.indexOf('await whenBackendReady();', runAt);
const stepsLoopAt = bootTs.indexOf('for (let index = 0; index < STEPS.length', runAt);
check(
  runAt >= 0 && gateAt > runAt && stepsLoopAt > gateAt,
  'boot.ts 的闸门在步骤循环**之前**',
  '闸门排在任何一个步骤之后，那个步骤里的 invoke 就仍然落在竞速窗口里'
);

// main.tsx：闸门要排在其它的 install* 之前 —— 那几个都会立刻 invoke。
const gateInstallAt = mainTsx.indexOf('installBackendReadyGate()');
const firstInvokingInstall = Math.min(
  ...['installMemoryLevelPolicy()', 'installPluginThemeSync()', 'installPluginShortcutSync()']
    .map((needle) => mainTsx.indexOf(needle))
    .filter((at) => at >= 0)
);
check(
  gateInstallAt >= 0 && firstInvokingInstall > gateInstallAt,
  'main.tsx 里闸门排在所有会 invoke 的 install* 之前',
  '这几个 install 都会在模块求值时立刻发起 invoke，它们正是被竞速吞掉的那一批'
);

// 会立刻 invoke 的服务自身也要过闸门：只靠 main.tsx 的顺序挡不住
// "有人把 install 挪到前面"。
for (const [file, label] of [
  ['src/services/memoryLevel.ts', 'memoryLevel'],
  ['src/services/pluginThemeSync.ts', 'pluginThemeSync'],
  ['src/services/pluginShortcutSync.ts', 'pluginShortcutSync'],
]) {
  const text = read(file);
  check(
    text.includes('whenBackendReady'),
    `${label} 的启动期 invoke 过了闸门`,
    '这些调用落在竞速窗口里时会静默失败（结果被 catch 吞掉），表现为"设置没生效"而不是报错'
  );
}

// 闸门本身不允许 reject：调用方 await 它时不该被迫 try/catch，
// 否则迟早有人用 `.catch(() => {})` 把它连真正的失败一起吞掉。
//
// 判据是代码而不是注释里的字样：Promise 的执行体里只允许出现 `resolve`，
// 一旦有人加了 `reject`，调用方就多了一条必须处理的失败路径。
const gateOpenAt = readyTs.indexOf('readyPromise = new Promise<void>((resolve) => {');
// Promise 执行体的结束：`probe();` 之后那一行 `  });`
const gateCloseAt = readyTs.indexOf('  });', readyTs.indexOf('    probe();', gateOpenAt));
const gateBody =
  gateOpenAt >= 0 && gateCloseAt > gateOpenAt ? readyTs.slice(gateOpenAt, gateCloseAt) : '';
check(
  gateBody.length > 0 && /\bresolve\b/.test(gateBody) && !/\breject\b/.test(gateBody),
  '闸门的 Promise 只 resolve，从不 reject（超时也放行）',
  '一个永远转圈的启动界面比现在更难诊断；超时放行后第一步会如实报错，' +
    '而调用方也不会被迫写一个会把真失败一起吞掉的 catch'
);

// 启动顺序门禁挂在 package.json 上，否则没人会跑它。
const packageJson = JSON.parse(read('package.json')) as {
  scripts?: Record<string, string>;
};
check(
  Boolean(packageJson.scripts?.['check:boot-order']),
  'package.json 注册了 check:boot-order'
);

console.log('');
if (failures.length === 0) {
  console.log(`${GREEN}${BOLD}全部 ${passed} 项通过${RESET}\n`);
  process.exit(0);
}

console.log(`${RED}${BOLD}${failures.length} 项失败，${passed} 项通过${RESET}\n`);
for (const failure of failures) console.log(`  ${RED}✘${RESET} ${failure}\n`);
process.exit(1);
