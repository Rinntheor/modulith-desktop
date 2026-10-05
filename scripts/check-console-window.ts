// scripts/check-console-window.ts
//
// 门禁：**任何创建子进程的地方都必须显式关掉控制台窗口。**
//
//   pnpm check:console-window
//
// ============================================================
// 它修的是什么：发行版每次启动闪三个黑窗
// ============================================================
//
// 用户报："发行版的软件，每次启动时会弹出三个 cmd 窗口然后立马消失。"
// 并且 **Ctrl+R 刷新界面也会重现** —— 后半句指出问题不在"应用启动"，
// 而在每次同步后台插件时创建的那几个子进程。
//
// 机制是 Windows 的一条规则：**GUI 子系统的进程创建控制台子进程时，若没有指定
// 创建标志，系统会为它分配一个新的控制台**。本应用是 GUI 子系统，而 `node.exe`
// 是控制台程序 —— 于是每个 `Command::new(node)` 都闪一个窗口。
//
// 两个容易误判的点，决定了这条门禁的形状：
//
//   1. **重定向 stdio 挡不住它。** `.output()` / `Stdio::piped()` / `Stdio::null()`
//      只影响管道，不影响控制台的创建。因此"这个调用已经设了 stdio"**不能**作为
//      它安全的理由 —— 这正是当初漏掉两处的原因。
//   2. **`creation_flags` 在两个类型上接法不同。** `std::process::Command` 需要
//      引入 `CommandExt` trait；`tokio::process::Command` 有一个 inherent 方法，
//      引入 trait 反而会选不中它（编译器给的是"unused import / unnecessary unsafe"
//      两条警告，而**代码照样编译过、标志没生效**）。因此这里不检查"有没有写
//      `creation_flags`"，而是检查"有没有调用那个统一的辅助函数" —— 接法只写在
//      `core/process.rs` 一处。
//
// ============================================================
// 为什么这类门禁是必要的
// ============================================================
//
// 这个缺陷只在**发行版**、且只在**机器上有 Node 时**才有症状 ——
// `cargo test`、`pnpm dev`、以及所有既有门禁都看不见它。与上一轮那个"只在发行版
// 出现的启动竞态"完全同类：源码级断言是唯一能在 CI 里拦住它的手段。
//
// 因此下面把两件事都钉住：**每一处创建点都接了辅助函数**，以及**辅助函数本身真的
// 设置了那个标志**（否则"所有调用点都接了它"就只是一句空话）。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src-tauri', 'src');

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

function read(path: string): string {
  if (!existsSync(path)) throw new Error(`找不到文件：${path}`);
  return readFileSync(path, 'utf-8');
}

/** 递归列出所有 .rs */
function rustFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...rustFiles(full));
    else if (entry.name.endsWith('.rs')) found.push(full);
  }
  return found;
}

/**
 * 从某个位置起，取后面 N 行的文本 —— 用来判断"这个创建点附近有没有接辅助函数"。
 *
 * 用行窗口而不是"整段函数"：解析 Rust 的块结构需要语法感知，而这里只需要一个
 * 稳定的近似。窗口内没找到就报错，让人去补 —— 补的方式永远是在 `Command::new`
 * 之后紧跟着写一行，因此 12 行足够宽。
 */
function windowAfter(lines: string[], index: number, size: number): string {
  return lines.slice(index, index + size).join('\n');
}

/**
 * 测试模块的字符区间，`null` 表示这个文件里没有 `#[cfg(test)]`。
 *
 * 为什么要把它排除：测试代码里的 `Command::new` **进不了发行版**（要 `cargo test`
 * 才会编译与执行），而在那里弹窗甚至是有意义的 —— 测试的输出本来就在控制台上。
 * 把它们算成"漏了消窗"会制造假红，而假红的下场是有人把整条门禁注释掉。
 *
 * 判据取"从 `#[cfg(test)]` 到文件末尾"：本仓库的测试模块一律是文件里的最后一个
 * 顶层项（`mod tests { … }`），中间不会再出现别的顶层项。这个近似是刻意的 ——
 * 精确解析需要语法树，而它换来的收益只是"允许在 test 模块之后再写点别的东西"，
 * 那不是这个仓库的写法。
 */
function testModuleRange(text: string): { start: number; end: number } | null {
  const start = text.indexOf('#[cfg(test)]');
  if (start < 0) return null;
  return { start, end: text.length };
}

const HELPERS = ['no_console_window(', 'no_console_window_tokio('];

console.log(`\n${BOLD}每一处创建子进程的地方都关掉了控制台窗口${RESET}`);

const files = rustFiles(SRC);
const spawnSites: Array<{
  file: string;
  line: number;
  text: string;
  guarded: boolean;
  testOnly: boolean;
}> = [];

for (const file of files) {
  const text = read(file);
  const lines = text.split(/\r?\n/);
  const testRange = testModuleRange(text);

  // 每行起始处的字符偏移，用来判断某个创建点是否落在测试模块里
  let offset = 0;
  const lineOffsets = lines.map((line) => {
    const current = offset;
    offset += line.length + 1; // +1 为换行
    return current;
  });

  lines.forEach((line, index) => {
    // 只认真正的创建点：`Command::new(`。注释行跳过 —— 文档里会引用这个写法
    // 来解释问题（本仓库多处这样写），把注释也算成创建点会制造假红。
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('///') || trimmed.startsWith('*')) return;
    if (!/Command::new\s*\(/.test(line)) return;

    const window = windowAfter(lines, index, 12);
    spawnSites.push({
      file: relative(ROOT, file).replace(/\\/g, '/'),
      line: index + 1,
      text: trimmed,
      guarded: HELPERS.some((helper) => window.includes(helper)),
      testOnly: testRange !== null && lineOffsets[index] >= testRange.start,
    });
  });
}

const production = spawnSites.filter((site) => !site.testOnly);
const testOnly = spawnSites.filter((site) => site.testOnly);

check(
  production.length > 0,
  `扫描到 ${production.length} 处发行版路径上的创建点` +
    (testOnly.length > 0 ? `（另有 ${testOnly.length} 处在 #[cfg(test)] 里，不计）` : ''),
  '一处都扫不到说明这个门禁的判据失效了（而不是"没有问题"）'
);

const unguarded = production.filter((site) => !site.guarded);
check(
  unguarded.length === 0,
  `发行版路径上全部 ${production.length} 处都调用了 core::process 的辅助函数`,
  unguarded.length > 0
    ? `这些创建点没有关控制台窗口，发行版上会闪黑窗：\n` +
      unguarded.map((s) => `      ${s.file}:${s.line}  ${s.text}`).join('\n') +
      `\n      修法：紧跟 Command::new(...) 之后加一行\n` +
      `        crate::core::process::no_console_window(&mut command);            // std\n` +
      `        crate::core::process::no_console_window_tokio(&mut command);      // tokio`
    : undefined
);

// 辅助函数本身必须真的设置那个标志。少了这一段，"所有调用点都接了它"就只是
// 一句空话 —— 窗口照闪，而门禁全绿。
console.log(`\n${BOLD}辅助函数本身确实设置了标志${RESET}`);

const helperRs = read(join(SRC, 'core', 'process.rs'));

check(
  /const CREATE_NO_WINDOW: u32 = 0x0800_0000;/.test(helperRs),
  'CREATE_NO_WINDOW 常量存在且取值正确（0x0800_0000）',
  '这个数字写错不会报错，只会"什么都不发生"——窗口照闪'
);
check(
  helperRs.includes('pub fn no_console_window(command: &mut std::process::Command)'),
  'std 版本存在'
);
check(
  helperRs.includes('pub fn no_console_window_tokio(command: &mut tokio::process::Command)'),
  'tokio 版本存在',
  'tokio::process::Command 与 std 的是不同类型；缺了它那一支会"编译过但标志没生效"'
);

// std 那一支必须引入 CommandExt —— 不引的话 `creation_flags` 找不到，
// 而编译器只会在别处报一个与"消窗"毫无关系的错。tokio 那一支相反：它是 inherent
// 方法，引入 trait 会选不中（曾因此得到两条警告而代码照样编译过）。
check(
  helperRs.includes('use std::os::windows::process::CommandExt;'),
  'std 版本引入了 CommandExt（creation_flags 来自这个扩展 trait）'
);
check(
  helperRs.includes('command.creation_flags(CREATE_NO_WINDOW);'),
  '两个版本都调用了 creation_flags'
);
check(
  !/unsafe\s*\{[^}]*creation_flags/.test(helperRs),
  '没有多余的 unsafe 块',
  'creation_flags 在两个类型上都是安全方法；包 unsafe 只会得到一条警告，' +
    '而那条警告说明这一行选的不是你以为的那个方法'
);

// 门禁必须挂在 package.json 上，否则没人会跑它。
const packageJson = JSON.parse(read(join(ROOT, 'package.json'))) as {
  scripts?: Record<string, string>;
};
check(
  Boolean(packageJson.scripts?.['check:console-window']),
  'package.json 注册了 check:console-window'
);

console.log('');
if (failures.length === 0) {
  console.log(`${GREEN}${BOLD}全部 ${passed} 项通过${RESET}`);
  for (const site of spawnSites) {
    console.log(`  ${DIM}${site.file}:${site.line}${RESET}`);
  }
  console.log('');
  process.exit(0);
}

console.log(`${RED}${BOLD}${failures.length} 项失败，${passed} 项通过${RESET}\n`);
for (const failure of failures) console.log(`  ${RED}✘${RESET} ${failure}\n`);
process.exit(1);
