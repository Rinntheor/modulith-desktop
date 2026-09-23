// scripts/check-quota.ts
//
// 插件存储的配额与分页游标的接线验证脚本
//
//   node scripts/check-quota.ts
//
// 这个脚本**不**重复 Rust 侧已经覆盖的东西。配额判定（三档、优先级、边界包含性、
// 溢出饱和）与分页切分（游标指向的键被删除、页内顺序、恰好整除、页大小 0）
// 全部由 `src-tauri/src/modules/plugins/quota.rs` 的 33 条单元测试守着 ——
// 在哪里可以直接构造出那些边界，比在这里读文本强得多。
//
// 这里查的是**只有跨文件才看得出来**的那一类问题：
//
//   * 命令名在前后端对不上（前端 `invoke` 一个不存在的命令，类型检查与编译
//     都不会报错，只有运行到那一步才知道）；
//   * **配额判定真的接在写盘路径上** —— 规则写好了却没人调用，是这个项目里
//     最反复出现的一类缺陷（"看起来接通了、实际从未通电"）。Rust 侧的单元测试
//     跑的是规则本身，因此"规则没被调用"它查不出来；
//   * 判定必须发生在**写盘之前**：写在后面的话那个大文件已经在那里了，
//     报错只是一句安慰的话，而内存与磁盘都已经付出代价；
//   * 前后端的页大小上限必须一致，否则后端会静默地少给几条 ——
//     而"少给几条"看起来与"已经到底"一模一样。

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

const libRs = read('src-tauri/src/lib.rs');
const quotaRs = read('src-tauri/src/modules/plugins/quota.rs');
const managerRs = read('src-tauri/src/modules/plugins/manager.rs');
const pluginsCommandsRs = read('src-tauri/src/modules/plugins/commands.rs');
const runtimeTs = read('src/services/pluginRuntime.ts');
const typesTs = read('src/types/plugin.ts');

/**
 * 取一个 Rust 整型常量的值。
 *
 * **必须支持乘法表达式**：`1024 * 1024` 这类写法在这份代码里到处都是，
 * 而只匹配数字的正则会把它截成第一个 `1024` —— 于是"单值上限 1 MB"被读成
 * "1024 字节"，后面每一条关于大小关系的断言都会得出错误的结论。
 * 这个 bug 在本脚本的第一版里真实发生过，它还顺带让三条断言假通过。
 */
function rustInt(source: string, name: string): number | null {
  const match = new RegExp(`pub const ${name}: (?:u64|usize) = ([0-9_*\\s]+);`).exec(source);
  if (!match) return null;

  const expression = match[1].trim();
  // 只接受"数字与乘号"构成的表达式，其余一律不认 —— 宁可让断言失败，
  // 也不要在这里对一段意外复杂的代码猜出一个数字。
  if (!/^[0-9_*\s]+$/.test(expression)) return null;

  const value = expression
    .split('*')
    .map((part) => Number(part.replace(/_/g, '').trim()))
    .reduce((acc, part) => (Number.isFinite(part) ? acc * part : NaN), 1);

  return Number.isFinite(value) ? value : null;
}

const rustNumber = rustInt;
const rustUsize = rustInt;

// ============================================================
// 1. 命令名前后端一致
// ============================================================
console.log('命令接线：');

for (const command of ['plugin_storage_list', 'plugin_storage_usage']) {
  check(libRs.includes(`${command},`), `${command} 已注册进 lib.rs`);
  check(
    runtimeTs.includes(`invoke<`) && runtimeTs.includes(`'${command}'`),
    `前端 pluginRuntime.ts 里的 ${command} 与后端同名`
  );
}

check(
  // 链式调用会跨行（`manager\n        .storage_list_paged(`），
  // 因此这里容忍中间的空白 —— 不容忍的话这条断言会因为格式而不是因为行为失败。
  /manager\s*\.\s*storage_list_paged/.test(pluginsCommandsRs),
  'plugin_storage_list 真的调到了分页实现（而不是退回全量列举）'
);
check(
  /manager\s*\.\s*storage_usage/.test(pluginsCommandsRs),
  'plugin_storage_usage 真的调到了用量统计'
);

// ============================================================
// 2. 配额判定必须接在写盘路径上，且在写盘之前
// ============================================================
//
// 这一段是整个脚本最重要的部分。`quota.rs` 的单元测试能证明规则是对的，
// 但证明不了它被调用过 —— 而这个项目里已经有过好几例"规则存在、路径未接"。
console.log('\n配额接在写入路径上：');

const setBody = (() => {
  const start = managerRs.indexOf('pub fn storage_set');
  if (start === -1) return null;
  const open = managerRs.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < managerRs.length; i += 1) {
    if (managerRs[i] === '{') depth += 1;
    else if (managerRs[i] === '}') {
      depth -= 1;
      if (depth === 0) return managerRs.slice(open, i + 1);
    }
  }
  return null;
})();

check(setBody !== null, '能找到 storage_set 的实现');
check(
  setBody !== null && setBody.includes('quota::check_write'),
  'storage_set 里调用了 quota::check_write（规则真的接在写入路径上）'
);
check(
  setBody !== null && /check_write[\s\S]{0,200}?\?\s*;|check_write[\s\S]*?return Err/.test(setBody),
  '被拒绝时直接返回错误（而不是记一条日志后继续写）'
);

// 顺序：判定必须在 fs::write 之前。
// 写在后面的话那个大文件已经落盘了，报错只是一句安慰的话。
if (setBody) {
  const checkIndex = setBody.indexOf('check_write');
  const writeIndex = setBody.indexOf('std::fs::write');
  check(
    checkIndex !== -1 && writeIndex !== -1 && checkIndex < writeIndex,
    '判定发生在写盘之前（写在后面的话文件已经在那里了）'
  );
  check(
    setBody.includes('storage_usage'),
    '判定用的是真实的存储用量（而不是某个可能过期的缓存）'
  );
  check(
    /existing[\s\S]{0,80}?metadata/.test(setBody),
    '覆盖写会先取该键原来的字节数，按增量判定（否则"缩小写入"会被误拦，插件无法自救）'
  );
}

// 用量统计不缓存：缓存一份用量意味着它与磁盘之间有一个窗口，
// 而插件正好可以在那个窗口里写满磁盘。
const usageBody = (() => {
  const start = managerRs.indexOf('pub fn storage_usage');
  if (start === -1) return null;
  const open = managerRs.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < managerRs.length; i += 1) {
    if (managerRs[i] === '{') depth += 1;
    else if (managerRs[i] === '}') {
      depth -= 1;
      if (depth === 0) return managerRs.slice(open, i + 1);
    }
  }
  return null;
})();
check(
  usageBody !== null && usageBody.includes('read_dir'),
  '用量统计每次都从文件系统现算（不缓存 —— 缓存会留下一个能写爆的窗口）'
);

// ============================================================
// 3. 配额的三档都在
// ============================================================
console.log('\n三档配额：');

const maxValue = rustNumber(quotaRs, 'MAX_VALUE_BYTES');
const maxTotal = rustNumber(quotaRs, 'MAX_TOTAL_BYTES');
const maxKeys = rustUsize(quotaRs, 'MAX_KEYS');

check(maxValue !== null && maxValue > 0, `单值上限存在（${maxValue} 字节）`);
check(maxTotal !== null && maxTotal > 0, `总量上限存在（${maxTotal} 字节）`);
check(maxKeys !== null && maxKeys > 0, `键数上限存在（${maxKeys} 个）`);
check(
  maxValue !== null && maxTotal !== null && maxValue < maxTotal,
  '单值上限必须小于总量上限（否则单值档永远不会单独命中，那一档就是死的）'
);
check(
  maxTotal !== null && maxValue !== null && maxTotal / maxValue >= 2,
  '总量上限至少是单值上限的 2 倍（否则"存几个大对象"就被拦，而那是正常用法）'
);

// ============================================================
// 4. 页大小上下限前后端一致
// ============================================================
//
// 后端夹取、前端不夹取看起来"也没事"（后端会给对的结果），但**上限不一致**
// 就不同了：前端请求 1000 条、后端只给 500 条，而那 500 条看起来与
// "已经到底"一模一样 —— 插件会静默地少读一半数据。
console.log('\n页大小：');

const maxPage = rustUsize(quotaRs, 'MAX_PAGE_SIZE');
check(maxPage !== null && maxPage > 0, `后端有页大小上限（${maxPage}）`);
check(
  // 只断言"分页实现经过 clamp_page_size"，不断言参数在什么位置 ——
  // 第一版把 `requested_page_size` 与调用写在同一个正则里，结果因为函数里
  // 参数解构的顺序不同而假失败。断言应当盯行为，不盯书写顺序。
  /pub fn storage_list_paged[\s\S]{0,1200}?clamp_page_size/.test(managerRs),
  '分页实现走的是 clamp_page_size（调用方请求一个极大的页也会被夹住）'
);
check(
  /pub fn clamp_page_size[\s\S]{0,400}?min\(MAX_PAGE_SIZE\)/.test(quotaRs),
  '夹取用的是 min(MAX_PAGE_SIZE) —— 能被一个参数绕过的分页等于没有分页'
);
// 切页函数自己也要兜住 0：0 条一页且仍给出游标会让调用方永远前进不了。
check(
  /pub fn slice_page[\s\S]{0,600}?page_size\.max\(1\)/.test(quotaRs),
  '切页函数把页大小 0 夹成 1（否则"0 条一页 + 游标"会让翻页永远停滞）'
);

// 前端的 all() 上限：它是唯一一条"一次拉全部值"的接口，必须有界。
const allCapMatch = /const MAX_STORAGE_ALL_KEYS = (\d+);/.exec(runtimeTs);
check(allCapMatch !== null, '前端声明了 all() 的键数上限');
if (allCapMatch) {
  const cap = Number(allCapMatch[1]);
  check(cap > 0 && cap <= (maxKeys ?? 0), `all() 上限不高于后端键数上限（${cap} ≤ ${maxKeys}）`);
}
check(
  /keys\.length > MAX_STORAGE_ALL_KEYS[\s\S]{0,200}?throw new Error/.test(runtimeTs),
  'all() 超限时**抛错**而不是静默截断（静默截断会让插件拿到一份缺数据的副本）'
);

// ============================================================
// 5. 游标不透明、且不匹配时报错
// ============================================================
console.log('\n游标：');

check(
  /base64::engine::general_purpose::URL_SAFE_NO_PAD/.test(quotaRs),
  '游标是 URL 安全的 base64（它会被放进 IPC 参数与日志）'
);
check(
  /cursor_prefix != prefix[\s\S]{0,300}?SandboxViolation/.test(quotaRs),
  '游标与过滤前缀不一致时**报错**（静默给一份缺数据的结果比失败更糟）'
);
check(
  runtimeTs.includes('nextCursor'),
  '前端把 nextCursor 如实透出（插件据它判断是否到底）'
);
check(
  typesTs.includes('nextCursor: string | null'),
  '插件面向的类型里也有 nextCursor'
);
check(
  runtimeTs.includes('async list(') && typesTs.includes('list(options?'),
  '服务实现与插件面向的类型都加了 list()'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
