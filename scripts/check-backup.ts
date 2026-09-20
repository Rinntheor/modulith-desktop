// scripts/check-backup.ts
//
// 备份功能的接线验证脚本
//
//   node scripts/check-backup.ts
//
// 这个脚本**不**重复 Rust 侧已经覆盖的东西。白名单的核心不变量
// （"导入只接受导出能够产生的名字"、路径穿越与畸形名字一律拒绝、目录前缀匹配
// 要求分隔符、敏感类别唯一）由 `src-tauri/src/modules/backup/` 里的单元测试守着，
// 在那里可以直接构造条目名来跑，比在这里读文本强得多。
//
// 这里查的是**只有跨文件才看得出来**的那一类问题：
//
//   * 命令名在前端与 `lib.rs` 里对不上（前端 `invoke` 一个不存在的命令，
//     类型检查与编译都不会报错，只有运行到那一步才知道）；
//   * 恢复必须在**后端**要求显式确认，而前端确实传了它 —— 这是"替换语义"的
//     唯一硬性门槛，写错了不会有人发现，直到某个用户的数据被静默替换；
//   * 敏感类别的两道门在界面上都接上了；
//   * 恢复之后的重新加载确实存在（少了它，界面会显示新设置、实际用旧设置）。

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
const service = read('src/services/backup.ts');
const appSettings = read('src/services/appSettings.ts');
const categoriesRs = read('src-tauri/src/modules/backup/categories.rs');
const commandsRs = read('src-tauri/src/modules/backup/commands.rs');
const ui = read('src/components/Settings/BackupSettings.tsx');
/** 前端侧可能调用备份相关命令的两个文件 */
const frontend = `${service}\n${appSettings}`;

// ============================================================
// 1. 命令的注册与调用对得上
// ============================================================

console.log('命令接线：');

const COMMANDS = [
  'list_backup_categories',
  'export_backup',
  'open_backup',
  'restore_backup',
  'reload_app_settings',
];

for (const name of COMMANDS) {
  check(libRs.includes(name), `lib.rs 注册了 ${name}`);
  check(frontend.includes(`'${name}'`), `前端调用 ${name}`);
}

// 前端 invoke 的每一个名字都必须在 lib.rs 里注册过。
// 反过来的方向（注册了但没人调）不是问题，因此不检查。
const invokeCalls = [...service.matchAll(/invoke<[^>]*>\('([a-z_]+)'((?:,\s*\{[^}]*\})?)\)/g)];
check(invokeCalls.length > 0, `从服务层解析出 ${invokeCalls.length} 个 invoke 调用`);
for (const match of invokeCalls) {
  check(libRs.includes(match[1]), `invoke('${match[1]}') 在后端有对应实现`);
}

// ============================================================
// 2. 恢复的硬性门槛
// ============================================================

console.log('\n恢复的门槛：');

check(
  /if !confirm \{[\s\S]{0,120}return Err/.test(commandsRs),
  '后端在 confirm 为假时直接拒绝（不是"界面上有个按钮"这种软门槛）'
);
check(
  /restore_backup\([\s\S]*?confirm: bool/.test(commandsRs),
  'restore_backup 的签名里有 confirm 参数'
);
check(
  /restoreBackup\([\s\S]{0,200}confirm: boolean/.test(service),
  '前端服务同样把 confirm 作为必填参数'
);
check(
  /restoreBackup\(\[\.\.\.restoreSelected\], restoreSensitive, true\)/.test(ui),
  '界面传的是字面量 true，而不是某个可能为假的变量'
);

// 恢复是替换语义：必须先删后写，且只删白名单里的目标
check(
  /remove_dir_all[\s\S]{0,400}remove_file[\s\S]{0,2000}\/\/ ---- 第二遍：解压 ----/.test(
    read('src-tauri/src/modules/backup/archive.rs')
  ),
  '恢复先移除选中类别的现有数据，再解压（先删后写的顺序是刻意的）'
);

// ============================================================
// 3. 敏感数据的两道门
// ============================================================

console.log('\n敏感数据的两道门：');

check(
  /category\.sensitive && !include_sensitive/.test(commandsRs),
  '后端在类别敏感且未开高级开关时拒绝'
);
check(
  /resolve_selection\(&categories, include_sensitive\)/.test(commandsRs),
  '导出与恢复共用同一个 resolve_selection（两道门用同一条规则）'
);
check(
  (commandsRs.match(/resolve_selection\(/g) ?? []).length >= 3,
  '导出与恢复各自调用一次 + 一处定义'
);

// 前端硬编码的敏感类别 id 必须真的在 Rust 的白名单里
const authInRust = /id: "auth"/.test(categoriesRs);
check(authInRust, 'Rust 白名单里存在 id 为 auth 的类别');
check(
  ui.includes("'auth'"),
  '界面用 auth 这个 id 做联动（开关与勾选互相同步）'
);
check(
  (ui.match(/toggle\(exportSelected, setExportSelected, 'auth'\)/g) ?? []).length === 1 &&
    (ui.match(/toggle\(restoreSelected, setRestoreSelected, 'auth'\)/g) ?? []).length === 1,
  '导出与恢复两侧都做了开关与勾选的联动'
);

// 敏感类别必须在界面上被明确标出来，而不是只靠一个复选框
check(ui.includes('敏感'), '界面标注了敏感类别');
check(
  /默认不包含/.test(ui) && /覆盖本机当前的凭据/.test(ui),
  '界面把两类风险都写清楚了（导出时的泄露面、恢复时的覆盖后果）'
);

// ============================================================
// 4. 恢复之后的重新加载
// ============================================================

console.log('\n恢复之后：');

check(
  /settingsChanged[\s\S]{0,120}reloadAppSettings/.test(service),
  '恢复设置后重新读取设置（后端内存副本不会自己知道磁盘变了）'
);
check(
  /settingsChanged \|\| report\.pluginsChanged[\s\S]{0,200}reloadPluginRuntime/.test(service),
  '恢复设置或插件后重载插件运行时'
);
check(
  service.includes('moduleManager.reloadCatalog()') &&
    service.includes('clearModuleComponentCache()'),
  '重载时同时刷新模块编目与组件缓存（与标题栏刷新走同一条链路）'
);
check(ui.includes('applyRestoreEffects'), '界面在恢复成功后调用它');
check(
  /reload_app_settings/.test(read('src-tauri/src/modules/settings/commands.rs')),
  '后端提供 reload_app_settings'
);

// ============================================================
// 5. 前端不做本该由后端做的判断
// ============================================================

console.log('\n职责边界：');

// 前端拼路径 = 白名单只剩一半意义（它约束的是包内路径，约束不了包本身从哪来）
const pathLike = /(app_data_dir|appDataDir|std::path|PathBuf)/.test(service);
check(!pathLike, '前端服务里没有路径拼接或路径类型');

// 前端传路径给后端去读，等于给了一个"解压任意 zip 到应用目录"的原语。
// 逐个检查 invoke 的实参对象里没有 path。
const withPath = invokeCalls
  .filter(([, , args]) => /\bpath\s*:/.test(args ?? ''))
  .map(([, name]) => name);
check(
  withPath.length === 0,
  withPath.length === 0
    ? '前端的 invoke 都不传路径（导出与打开用系统对话框，恢复用后端记住的那个文件）'
    : `这些调用传了路径：${withPath.join('、')}`
);
check(
  /slot = Some\(path\.clone\(\)\)/.test(commandsRs),
  '后端记住刚打开的备份文件，恢复只能作用于它'
);
check(
  /blocking_save_file\(\)/.test(commandsRs) && /blocking_pick_file\(\)/.test(commandsRs),
  '导出与打开都经过系统对话框'
);

// 恢复的 confirm 不是前端可选的：后端的签名与检查都在
check(
  /fn restore_backup\([\s\S]{0,400}confirm: bool/.test(commandsRs),
  'restore_backup 的 confirm 是必填参数（不是 Option）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
