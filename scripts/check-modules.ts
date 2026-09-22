// scripts/check-modules.ts
//
// 后端模块的生命周期接线验证脚本
//
//   node scripts/check-modules.ts
//
// ============================================================
// 为什么需要它（以及它为什么是**脚本**而不是 Rust 测试）
// ============================================================
//
// `src-tauri/src/core/registry.rs` 里有一组关于"真实模块表"的测试，但那组测试
// 只能手抄一份依赖表 —— 因为调用真实的 `modules::register_all` 会把 `desktop`
// （托盘）与 `plugins`（WebView2）的代码链进**测试二进制**，而它们拉进的导入里
// 有当前系统解析不了的符号，于是 `cargo test --lib` 直接以
// `STATUS_ENTRYPOINT_NOT_FOUND` 中止（不是测试失败，是进程起不来）。
//
// 那份手抄表会漂移。这个脚本读**源码**而不是跑链接，因此没有那个限制，
// 可以覆盖完整的真实形状：
//
//   1. 磁盘上每个模块目录都必须被 `modules/mod.rs` 注册（新增模块最容易漏的一步）；
//   2. 模块声明的依赖必须指向真实存在的模块（写错模块名会让启动报"依赖不存在"）；
//   3. 依赖图必须无环（环会让应用**打不开**，而错误信息只有一句）；
//   4. 生命周期三个入口必须真的接在生成的 `lib.rs` 上：
//      `setup_all` / `start_all` / `stop_all`。
//      第 4 条尤其重要 —— "规则写好了、路径没接"是这个项目最反复出现的缺陷，
//      而 `stop_all` 此前**根本不存在**：应用退出时模块的 `stop` 从来没被调用过。

import { readFileSync, readdirSync, statSync } from 'node:fs';
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

const MODULES_DIR = join(PROJECT_ROOT, 'src-tauri/src/modules');
const modulesModRs = read('src-tauri/src/modules/mod.rs');
const libRs = read('src-tauri/src/lib.rs');
const registryRs = read('src-tauri/src/core/registry.rs');
const lifecycleRs = read('src-tauri/src/core/lifecycle.rs');
const generateTs = read('scripts/generate-backend-module.ts');

/** 磁盘上有 `mod.rs` 的模块目录 */
function moduleDirsOnDisk(): string[] {
  return readdirSync(MODULES_DIR)
    .filter((entry) => {
      const path = join(MODULES_DIR, entry);
      return statSync(path).isDirectory() && statSync(join(path, 'mod.rs')).isFile();
    })
    .sort();
}

/** 某个模块声明的依赖（从它的 `mod.rs` 里读 `fn dependencies`） */
function declaredDependencies(moduleId: string): string[] {
  const source = read(`src-tauri/src/modules/${moduleId}/mod.rs`);
  const match = /fn dependencies\(&self\) -> Vec<&'static str> \{\s*vec!\[([^\]]*)\]/.exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// ============================================================
// 1. 磁盘上的模块都被注册
// ============================================================
console.log('模块注册：');

const dirs = moduleDirsOnDisk();
check(dirs.length > 0, `磁盘上有模块目录（${dirs.length} 个）`);

for (const id of dirs) {
  check(
    modulesModRs.includes(`pub mod ${id};`),
    `modules/mod.rs 声明了 pub mod ${id}`
  );
  check(
    new RegExp(`registry\\.register\\(Box::new\\(${id}::`).test(modulesModRs),
    `modules/mod.rs 注册了 ${id}`
  );
}

// ============================================================
// 2. 依赖指向真实存在的模块
// ============================================================
console.log('\n依赖声明：');

const graph = new Map<string, string[]>();
for (const id of dirs) {
  graph.set(id, declaredDependencies(id));
}

let missingReported = 0;
for (const [id, deps] of graph) {
  for (const dep of deps) {
    check(
      graph.has(dep),
      `${id} 声明的依赖 "${dep}" 是真实存在的模块`
    );
    missingReported += 1;
  }
}
if (missingReported === 0) {
  // 一个都没声明也要说清楚：那意味着拓扑排序拿到的是空图，
  // 顺序完全由注册顺序决定 —— 而那正是这条检查存在的理由。
  console.log('  · 当前没有任何模块声明依赖，顺序完全由注册顺序决定');
}

// ============================================================
// 3. 依赖图无环
// ============================================================
//
// 环会让应用**打不开**（`setup_all` 报 "Circular dependency detected" 然后
// 整个启动中止），而错误信息只有一句话，没有指出环在哪。
// 在构建前把它变成一条能定位到具体模块的失败。
console.log('\n依赖图无环：');

function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') {
      // 环：从栈里截出环的那一段
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }

    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  }

  for (const id of graph.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

const cycle = findCycle(graph);
check(
  cycle === null,
  cycle ? `依赖图里有环：${cycle.join(' -> ')}` : '依赖图无环'
);

// 拓扑序在生成文件里也要能算出来（顺序确定，不受哈希影响）
check(
  /pub fn plan_lifecycle/.test(lifecycleRs),
  'core/lifecycle.rs 提供纯函数的执行计划（顺序不再取自 HashMap 迭代）'
);

// ============================================================
// 4. 生命周期三个入口都接在生成的 lib.rs 上
// ============================================================
console.log('\n生命周期接线：');

check(registryRs.includes('pub fn setup_all'), 'ModuleRegistry 有 setup_all');
check(registryRs.includes('pub fn start_all'), 'ModuleRegistry 有 start_all');
check(registryRs.includes('pub fn stop_all'), 'ModuleRegistry 有 stop_all');

check(libRs.includes('registry.setup_all('), '生成的 lib.rs 调用了 setup_all');
check(
  libRs.includes('registry.start_all('),
  '生成的 lib.rs 调用了 start_all（此前是遍历 registry.all()，即哈希顺序）'
);
check(
  !/for module in registry\.all\(\)/.test(libRs),
  '生成的 lib.rs 里没有残留的"遍历 all() 启动"写法'
);
check(
  libRs.includes('registry.stop_all('),
  '生成的 lib.rs 在退出时调用了 stop_all（此前应用退出时模块的 stop 从未被调用）'
);
check(
  /RunEvent::Exit/.test(libRs),
  '退出收尾挂在 RunEvent::Exit 上'
);
check(
  /stop_all\(app\)[\s\S]{0,200}?cleanup_before_exit\(\)/.test(libRs),
  'stop_all 在 cleanup_before_exit **之前**调用（后者会清掉窗口与资源表）'
);
check(
  /cleanup_before_exit\(\)/.test(libRs),
  '用 run_return 时补上了 cleanup_before_exit（漏掉它托盘与窗口资源不会被清理）'
);

// 生成器模板必须与生成结果一致，否则下次 `gen:backend` 会把这些改回去。
check(
  generateTs.includes('registry.start_all('),
  '生成器模板里有 start_all（改生成文件而不改模板等于下次生成就被覆盖）'
);
check(
  generateTs.includes('registry.stop_all('),
  '生成器模板里有 stop_all'
);
check(
  generateTs.includes('run_return'),
  '生成器模板用的是 run_return（拿到退出事件的唯一途径）'
);

// ============================================================
// 5. 停止是逆序且幂等
// ============================================================
console.log('\n停止语义：');

check(
  /let stop_order = ordered\.iter\(\)\.rev\(\)/.test(lifecycleRs),
  '停止顺序是启动顺序的严格逆序（依赖方先停）'
);
check(
  /stopped\.swap\(true, Ordering::SeqCst\)/.test(registryRs),
  'stop_all 用原子交换做幂等（退出路径可能被触发两次）'
);
check(
  /let started: HashSet<&str> = self\.start_order/.test(registryRs),
  '只停止**成功启动过**的模块（让没初始化过的模块执行 stop 只会制造错误）'
);
check(
  /module\.stop\(app\)[\s\S]{0,200}?log::warn/.test(registryRs),
  '单个模块停止失败**不中止**其余模块（否则一个无关错误会让别人的数据留在内存里）'
);

// 日志模块必须真的用上 stop —— 否则 stop_all 只是"接上了但没人实现"。
const loggingModRs = read('src-tauri/src/modules/logging/mod.rs');
check(
  loggingModRs.includes('fn stop('),
  'logging 模块实现了 stop（它是唯一有落盘收尾动作的模块）'
);
check(
  /fn stop\([\s\S]{0,300}?logger\.flush\(\)/.test(loggingModRs),
  'logging 的 stop 真的调用了 flush（此前 FileLogger::flush 从未被调用）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
