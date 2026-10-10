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
//
// 判据是"**经由一次调用到达真正的目录枚举**"，而不是"它的函数体里直接出现
// `read_dir`"：枚举被抽进了 `storage_entries` —— 键值存储现在有**两个**落点
// （见 `manager.rs::storage_dirs` 的「为什么旧键留在原地不搬」），两处都要统计，
// 把 `read_dir` 强行写回 `storage_usage` 只会让那段逻辑重复一遍。
// 真正要拦的是**缓存**，而那一条不受这次重构影响。
function fnBody(signature: string): string | null {
  const start = managerRs.indexOf(signature);
  if (start === -1) return null;
  const open = managerRs.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < managerRs.length; i += 1) {
    if (managerRs[i] === '{') depth += 1;
    else if (managerRs[i] === '}') {
      depth -= 1;
      if (depth === 0) return managerRs.slice(open, i + 1);
    }
  }
  return null;
}

const usageBody = fnBody('pub fn storage_usage');
const entriesBody = fnBody('fn storage_entries');
check(
  usageBody !== null &&
    (usageBody.includes('read_dir') ||
      (usageBody.includes('storage_entries') &&
        entriesBody !== null &&
        entriesBody.includes('read_dir'))),
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

// ============================================================
// 卸载不许删数据
// ============================================================
//
// 这里原来是 `remove_dir_all(&plugin_dir)` 紧接着
// `remove_dir_all(&plugin_data_dir)` —— 而且「卸载前二次确认」关掉时整条路径
// **连一个对话框都没有**。也就是说：点一下卸载，插件攒了几个月的数据就没了，
// 没有提示、不进回收站。那是这个插件系统里唯一一处**静默且不可逆地销毁用户数据**
// 的地方。
//
// 它一直没被当成缺陷，是因为在"每个插件只有几 KB 配置"的时代损失小到没人注意；
// 一旦插件开始存文档、图片、数据库，同一个行为就从"无所谓"变成"灾难"。
//
// 现在的语义是：**卸载只删代码，数据默认留下**，删数据是单独一步、要确认。
// Rust 侧测不了它（`uninstall` 需要 AppHandle），因此由这条断言守着。

{
  const managerRs = readFileSync(
    join(PROJECT_ROOT, 'src-tauri/src/modules/plugins/manager.rs'),
    'utf8'
  );

  /** 取出一个函数的函数体（到第一个顶格 `}` 为止）。 */
  const fnBody = (name: string): string => {
    const match = new RegExp(`pub fn ${name}\\([\\s\\S]*?\\n    \\}`).exec(managerRs);
    return match ? match[0] : '';
  };

  const uninstall = fnBody('uninstall');
  check(uninstall.length > 0, 'manager.rs 里有 uninstall()');

  // `uninstall` 里出现 `remove_dir_all` 只允许一次，而且目标是插件目录。
  // 判据写成"数一数有几处"而不是"找找有没有" —— 因为保留数据的那段注释里
  // 本来就写着 `remove_dir_all(&data_dir)`（它在解释"以前是这样、现在不是"），
  // 只匹配字符串会被自己的注释骗过去。
  const removals = (uninstall.match(/remove_dir_all\(/g) ?? []).length;
  check(
    removals === 1 && /remove_dir_all\(&plugin_dir\)/.test(uninstall),
    `卸载只删插件目录这一处（实际有 ${removals} 处 remove_dir_all）`
  );

  // 保留数据之后，必须存在一条**够得着它**的删除路径 —— 否则"数据不会丢"
  // 只是换成"空间删不掉"。`storage_clear` 走 `checked_storage_dir`，它要求插件
  // 仍然安装且声明了 `storage`，因此**卸载之后够不着**。
  check(/pub fn clear_data\(/.test(managerRs), '存在一条不要求插件仍安装的删除路径（clear_data）');
  check(
    /pub fn data_usage\(/.test(managerRs),
    '能问出数据目录占了多少（卸载确认框要用它把选择说清楚）'
  );
  check(
    /pub fn orphan_data\(/.test(managerRs) && /fn scan_orphan_dirs\(/.test(managerRs),
    '残留数据可被发现（否则保留数据等于静默的空间泄漏）'
  );

  // 前后端都要真的接上：判断"接通了没有"正是这个脚本最该查的一类问题。
  //
  // 判据要允许 `invoke<T>('…')` 这种带类型参数的写法 —— 第一版只匹配
  // `invoke('plugin_data_usage'`，而它实际写的是 `invoke<number>('plugin_data_usage'`，
  // 于是断言把一段**完全正确**的代码判成了没接上。
  const runtimeTs = readFileSync(join(PROJECT_ROOT, 'src/services/pluginRuntime.ts'), 'utf8');
  const invokes = (command: string): boolean =>
    new RegExp(`invoke(?:<[^>]*>)?\\('${command}'`).test(runtimeTs);
  check(
    invokes('plugin_data_clear') &&
      invokes('plugin_data_usage') &&
      invokes('plugin_data_orphans'),
    '前端三个命令都接了'
  );

  // 卸载确认框必须把"数据会留下"写出来，并提供当场删除的选项。
  const pluginsTsx = readFileSync(
    join(PROJECT_ROOT, 'src/modules/plugins/Plugins.tsx'),
    'utf8'
  );
  check(pluginsTsx.includes('它的数据会<strong>保留</strong>'), '卸载确认框说明了数据会保留');
  check(
    /deleteDataOnUninstall/.test(pluginsTsx) &&
      /setDeleteDataOnUninstall\(false\)/.test(pluginsTsx),
    '有"连数据一起删"的显式选项，且每次打开都重置为不删'
  );
  check(
    /handleUninstall\(plugin\)/.test(pluginsTsx),
    '关闭二次确认时的直接卸载路径也走同一个函数（即同样保留数据）'
  );
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
