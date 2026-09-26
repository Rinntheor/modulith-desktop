// scripts/check-tray.ts
//
// 系统托盘与「关闭窗口时怎么行为」的接线验证脚本
//
//   node scripts/check-tray.ts
//
// 这个脚本**不**重复 Rust 侧已经覆盖的东西（默认值、设置校验由
// `src-tauri/src/modules/settings/settings.rs` 的单元测试守着，在那里能直接跑
// `AppSettings::default()`，比在这里读文本强得多）。
//
// 这里查的是**只有跨文件才看得出来**的那一类问题：
//
//   * 命令名在前后端对不上（前端 `invoke` 一个不存在的命令，类型检查与编译都不会
//     报错，只有运行到那一步才知道）；
//   * **托盘装不上时的回落**必须存在 —— 少了它，用户点关闭之后窗口会消失到一个
//     不存在的托盘里，**再也叫不回来**。这是本次改动里唯一可能造成"应用打不开"
//     的路径，值得单独一条断言；
//   * 两个入口（设置页与托盘右键菜单）改的必须是**同一个字段**，否则会出现
//     "菜单里勾了、设置页没勾"，而界面与真实行为相反是最难察觉的一类错误；
//   * 托盘图标用的是应用自己的图标，而不是另建一份资源文件（多一份资源就多一处
//     会忘记更新的地方）。

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
const cargoToml = read('src-tauri/Cargo.toml');
const trayRs = read('src-tauri/src/modules/desktop/tray.rs');
const closeRs = read('src-tauri/src/modules/desktop/close_behavior.rs');
const desktopModRs = read('src-tauri/src/modules/desktop/mod.rs');
const desktopCommandsRs = read('src-tauri/src/modules/desktop/commands.rs');
const settingsRs = read('src-tauri/src/modules/settings/settings.rs');
const shellTs = read('src/services/desktopShell.ts');
const appSettingsTs = read('src/services/appSettings.ts');

// ============================================================
// 1. 命令名前后端一致
// ============================================================
//
// 前端 `invoke('xxx')` 与后端的命令名不一致时，类型检查与编译**都不会报错**，
// 只有运行到那一步才知道。这条检查就是为了把那个失败提前到构建前。
console.log('命令接线：');

const commands = ['is_tray_available', 'get_close_to_tray', 'set_close_to_tray'];

for (const command of commands) {
  check(libRs.includes(`${command},`), `${command} 已注册进 lib.rs`);
  check(
    shellTs.includes(`invoke<boolean>('${command}'`),
    `前端 desktopShell.ts 里的 ${command} 与后端同名`
  );
}

check(
  /tauri = \{[^}]*features = \[[^\]]*"tray-icon"/.test(cargoToml),
  'tauri 开了 tray-icon 特性（不开的情况下托盘代码根本编译不出东西）'
);

// ============================================================
// 2. 托盘装不上时必须回落（唯一可能让窗口"再也叫不回来"的路径）
// ============================================================
//
// 托盘安装失败而关闭行为仍是"隐藏到托盘"时，用户点关闭会让窗口消失到一个不存在
// 的托盘里 —— 没有入口能把它叫回来，只能去任务管理器结束进程。
// 因此 `DesktopModule::setup` 必须在失败分支里把设置回落成 `false` 并写回。
console.log('\n托盘不可用时的回落：');

check(
  desktopModRs.includes('tray::install'),
  'DesktopModule::setup 里尝试安装托盘'
);
check(
  /Err\(error\)[\s\S]{0,600}?current\.close_to_tray = false/.test(desktopModRs),
  '托盘安装失败时把关闭行为回落为「直接退出」'
);
check(
  /current\.close_to_tray = false[\s\S]{0,400}?settings::save\(app, &current\)/.test(desktopModRs),
  '回落后的值**写回设置**（界面读到的也必须是回落后的那个值，否则它仍显示会导致窗口消失的选项）'
);
check(
  /托盘不可用[\s\S]*?回落/.test(desktopModRs) || desktopModRs.includes('回落'),
  '回落路径有一条日志（否则这条路径出问题时没有任何痕迹）'
);

// ============================================================
// 3. 两个入口改的是同一个字段
// ============================================================
//
// 设置页与托盘右键菜单都能改「关闭时最小化到托盘」。两处若各存一份状态，
// 必然漂移，而漂移的表现是"菜单里勾了、设置页没勾"。
console.log('\n关闭行为的两个入口：');

check(
  trayRs.includes('settings::load') && trayRs.includes('settings::save'),
  '托盘菜单直接读写设置（而不是自己存一份）'
);
check(
  /fn toggle_close_to_tray[\s\S]{0,400}?current\.close_to_tray = !current\.close_to_tray/.test(
    trayRs
  ),
  '托盘菜单改的是设置里的 close_to_tray 字段'
);
check(
  desktopCommandsRs.includes('current.close_to_tray = enabled') &&
    desktopCommandsRs.includes('settings::save'),
  '设置页那条命令改的也是同一个字段'
);
check(
  desktopCommandsRs.includes('tray::sync_menu_check'),
  '设置页改过之后会同步托盘菜单的勾选状态（否则菜单里的勾会与实际行为相反）'
);
check(
  shellTs.includes("invoke<boolean>('get_close_to_tray'") &&
    /getCloseToTray/.test(shellTs),
  '前端能读回后端的真实值（托盘菜单改过之后界面不能只信自己的缓存）'
);

// ============================================================
// 4. 关闭拦截的接线与顺序
// ============================================================
//
// `prevent_close()` 必须在做任何善后之前调用 —— 它是唯一能撤销"正在关闭"
// 这个决定的地方。写在隐藏之后等于先关掉再试图藏起来。
console.log('\n关闭拦截：');

check(
  closeRs.includes('WindowEvent::CloseRequested'),
  '监听的是 CloseRequested'
);
check(
  /api\.prevent_close\(\)[\s\S]{0,300}?window\.hide\(\)/.test(closeRs),
  '先 prevent_close 再 hide（顺序反了等于"关掉之后再试图藏起来"）'
);
check(
  /hide\(\)[\s\S]{0,400}?app\.exit\(0\)/.test(closeRs),
  '隐藏失败时改为真的退出（否则窗口会停在"没关也没藏"的半死状态）'
);
// ============================================================
// 对 `close_behavior.rs` 做文本断言之前，**必须先把注释去掉**
// ============================================================
//
// 这一条是踩了三次之后才写下来的（`validator.rs` 的报错文案、插件文档里的一句说明、
// 以及这里）：对源码做"某段代码里有没有这句话"的断言时，**注释会把断言喂饱**。
//
// 具体到这里：`「直接退出」` 那一档的注释里正当地写着
// "理由是 `app.exit(0)` 会跳过 Tauri 的正常关闭流程" —— 于是把那一行真正的
// `app.exit(0);` 删掉，判据照样通过（变异 T1 抓出来的）。
//
// 去掉 `//` 到行尾即可：Rust 的块注释在本文件里没有，写一个简单的状态机
// 不值得 —— 但**行注释必须去掉**，否则这一节守的是一段散文。
function stripRustLineComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      const index = line.indexOf('//');
      return index >= 0 ? line.slice(0, index) : line;
    })
    .join('\n');
}

const closeCode = stripRustLineComments(closeRs);

check(
  // 判据**必须夹在那条分支之内**，而且要看**代码**不是注释。
  // 写成 `!close_to_tray[\s\S]{0,600}?app.exit\(0\)` 有两重错：
  // `[\s\S]` 会越过分支结尾命中下面那句兜底；而注释里那行说明本身也算命中。
  closeCode
    .slice(closeCode.indexOf('if !settings::load'), closeCode.indexOf('api.prevent_close()'))
    .includes('app.exit(0)'),
  '「直接退出」这一档**显式**结束进程，而不是只"不拦截关闭"'
);
// ============================================================
// 为什么这一条曾经写反了
// ============================================================
//
// 上面那条断言原先写的是"「直接退出」这一档不拦截关闭，走 Tauri 的正常关闭流程"，
// 下面还有一条**明确禁止**这一档调用 `app.exit`，理由是"那会跳过窗口销毁事件
// 与将来的收尾钩子"。
//
// 那个理由本身是错的（`lib.rs` 用 `run_return`，`RunEvent::Exit` 照常触发，
// 模块收尾与 `cleanup_before_exit` 都在那里），而且它把一个真实缺陷**钉成了规范**：
// 用户选了"直接退出"，主窗口确实关了，但**进程还活着、托盘图标还在** ——
// 从用户的角度看就是"还是最小化到托盘"。用户实际报上来了这一条。
//
// 根因是本应用不只有主窗口。因此这里补一条断言盯住那个前提：一旦
// `tauri.conf.json` 里不再有额外的隐藏窗口，"窗口全关就退出"才会重新成立，
// 这一档才可以退回成不显式 exit。
const declaredWindows = [
  ...read('src-tauri/tauri.conf.json').matchAll(/"label":\s*"([^"]+)"/g),
].map((m) => m[1]);
check(
  declaredWindows.length >= 2,
  `tauri.conf.json 声明了 ${declaredWindows.length} 个窗口（${declaredWindows.join('、')}）—— ` +
    '多于一个时"关掉主窗口"不等于"进程结束"，这正是「直接退出」必须显式 exit 的原因'
);
check(
  declaredWindows.includes('tray-menu') && declaredWindows.includes('overlay'),
  '两个隐藏的辅助窗口仍然存在（它们让事件循环在主窗口关闭后继续转）'
);

// ============================================================
// 切换开关之后必须自己回读状态
// ============================================================
//
// 这是用户报出来的另一条：在托盘里点「关闭窗口时最小化到托盘」，**没有任何反馈**
// —— 圆点与副标题都不变，用户不知道它是开了还是关了。
//
// 原因是那条动作成功之后既不刷新、也不关菜单（后者是刻意的：要让用户看到结果），
// 于是窗口始终没有失去过焦点，而刷新只挂在 `focus` 上。
const trayMenuSource = read('src/tray-menu/TrayMenu.tsx');
const runFn = /const run = useCallback\([\s\S]*?\n  \);/.exec(trayMenuSource)?.[0] ?? '';
check(runFn.length > 0, '能定位到托盘菜单的 run 函数体');
check(
  /action === 'toggle_close_to_tray'[\s\S]{0,120}?await refresh\(\)/.test(runFn),
  '切换开关成功后**自己回读状态**（只靠 focus 刷新会漏掉"菜单没关过"的情形）'
);
check(
  /if \(error\) \{[\s\S]{0,220}?return;/.test(runFn),
  '动作失败时提前返回 —— 否则失败也会去刷新，把失败原因冲掉'
);
// 「直接退出」那一档**先退出、且不 prevent_close**：撤销关闭只该发生在
// "隐藏到托盘"那一档 —— 先 prevent 再 exit 会让窗口先被拦下来一次，
// 那条路径下用户会看到窗口闪一下。
//
// 判据取"从 `if !settings::load` 到第一处 `prevent_close`"这一段：
// 它就是"直接退出"分支的全部代码。用整个文件做匹配会让下面那条
// "隐藏失败时改为退出"的兜底把断言喂饱（这里踩过一次）。
const beforeFirstPrevent = closeCode.slice(
  closeCode.indexOf('if !settings::load'),
  closeCode.indexOf('api.prevent_close()')
);
// 判据写成 `api.prevent_close()`（带接收者的**调用**形式），不是裸的 `prevent_close`：
// 上面那段解释里正当地写着"不调 `prevent_close`"，裸词匹配会被那句话本身判成违规。
// 对源码做文本断言时，模式必须比"出现过的词"更精确 —— 这个坑在本仓库踩过不止一次。
check(
  beforeFirstPrevent.includes('app.exit(0)') &&
    !beforeFirstPrevent.includes('api.prevent_close()'),
  '「直接退出」那一档先结束进程、且不撤销关闭请求'
);
check(
  closeRs.includes('on_window_event'),
  '关闭拦截在模块 setup 里注册（lib.rs 是生成文件，不能往里塞业务逻辑）'
);

// ============================================================
// 5. 图标与设置字段
// ============================================================
console.log('\n图标与设置字段：');

check(
  trayRs.includes('default_window_icon'),
  '托盘图标复用应用自己的窗口图标（不额外维护一份资源文件）'
);
check(
  !/include_bytes!/.test(trayRs),
  '没有把图标字节硬编进托盘代码（那会多一份需要同步的资源）'
);
check(
  /pub close_to_tray: bool,/.test(settingsRs),
  '后端有 close_to_tray 字段'
);
check(
  /fn default_close_to_tray\(\) -> bool \{\s*true\s*\}/.test(settingsRs),
  '后端默认为 true（隐藏到托盘）'
);
check(
  /close_to_tray: default_close_to_tray\(\)/.test(settingsRs),
  'impl Default 与 serde 缺省值一致（否则全新安装与老设置文件会得到相反的默认行为）'
);
check(
  appSettingsTs.includes('closeToTray: boolean;'),
  '前端类型上有 closeToTray'
);
check(
  /closeToTray: raw\?\.closeToTray !== false/.test(appSettingsTs),
  '前端清洗用 `!== false`（用裸值会让缺字段的老文件变成"关闭即退出"，那正是默认值想避免的）'
);

// ============================================================
// 6. 托盘不可用时界面必须如实说明
// ============================================================
console.log('\n界面如实说明：');

const settingsDialog = read('src/components/Settings/SettingsDialog.tsx');

check(
  settingsDialog.includes('isTrayAvailable'),
  '设置页会查询托盘是否可用'
);
check(
  /trayAvailable === false[\s\S]{0,600}?没有可用的系统托盘/.test(settingsDialog),
  '托盘不可用时给出明确说明，而不是显示一个永远不生效的开关'
);
check(
  settingsDialog.includes('toggleCloseToTray'),
  '设置页那个开关走的是「保存设置 + 同步菜单勾选」两处'
);

// ============================================================
// 7. 自绘托盘菜单
// ============================================================
//
// 自绘菜单是一个**独立的 WebView 窗口**，而这一点带来了三类"只有跨文件才看得出"
// 的问题，全部没有编译期保护：
//
//   1. 窗口标签（`tauri.conf.json` 的 label）与 Rust 里的常量对不上 ——
//      表现是右键托盘没有任何反应；
//   2. **Vite 的多入口漏了它** —— 开发模式完全正常（Vite 按 URL 提供任意 HTML），
//      而发布版里那个窗口是空白的。这正是"只在发布版里坏掉"的典型；
//   3. 后端与前端对同一个事件名的字符串对不上 —— 表现是"点了设置，界面没反应"。
console.log('\n自绘托盘菜单：');

const tauriConf = read('src-tauri/tauri.conf.json');
const trayMenuRs = read('src-tauri/src/modules/desktop/tray_menu.rs');
const trayMenuTsx = read('src/tray-menu/TrayMenu.tsx');
const trayMenuMainTsx = read('src/tray-menu/main.tsx');
const viteConfig = read('vite.config.ts');
const homeTsx = read('src/pages/Home.tsx');

check(
  /"label":\s*"tray-menu"/.test(tauriConf),
  'tauri.conf.json 里有 tray-menu 窗口（label 是 Rust 侧按名字找它的依据）'
);
check(
  /url":\s*"tray-menu\.html"/.test(tauriConf),
  'tray-menu 窗口指向 tray-menu.html'
);
check(
  /"visible":\s*false/.test(tauriConf),
  'tray-menu 窗口启动时不可见（否则应用一开就有一个浮层挂在屏幕上）'
);
check(
  /"transparent":\s*true/.test(tauriConf),
  'tray-menu 窗口是透明的（不透明窗口会在圆角外带出一圈底色）'
);
check(
  /"skipTaskbar":\s*true/.test(tauriConf),
  'tray-menu 窗口不在任务栏出现（它不是一个"窗口"）'
);

check(
  /input:\s*\{[\s\S]{0,300}?tray-menu[\s\S]{0,200}?tray-menu\.html/.test(viteConfig),
  'vite.config.ts 声明了 tray-menu 入口 —— **漏掉它时开发模式正常、发布版空白**'
);
check(
  !/index\.html[\s\S]{0,80}tray-menu/.test(viteConfig) ||
    /main:\s*path\.resolve/.test(viteConfig),
  '主入口也仍在多入口列表里（改成多入口时漏掉主入口会让整个应用打不开）'
);

check(
  /TRAY_MENU_LABEL:\s*&str\s*=\s*"tray-menu"/.test(trayMenuRs),
  'Rust 侧的窗口标签常量与配置一致'
);
check(
  /tauri\.conf\.json[\s\S]{0,200}label/.test(trayMenuRs) ||
    /include_str!\("\.\.\/\.\.\/\.\.\/tauri\.conf\.json"\)/.test(trayMenuRs),
  'Rust 侧有一条测试把窗口标签钉在配置上（改名时会被拦住）'
);

check(
  /TRAY_ACTION_EVENT:\s*&str\s*=\s*"modulith:\/\/tray-action"/.test(desktopCommandsRs),
  '后端声明了托盘动作的事件名'
);
check(
  homeTsx.includes(`'modulith://tray-action'`),
  '前端监听的是**同一个**事件名（字符串不一致时不会有任何编译错误）'
);

// 「关闭时最小化到托盘」这个开关在两个入口（设置页 / 自绘菜单）必须都经过
// 同一条命令 —— 各写一份必然漂移，而漂移的表现是"菜单里勾了、设置页没勾"。
check(
  /tray_menu_state[\s\S]{0,400}?settings::load/.test(desktopCommandsRs),
  '自绘菜单的开关状态从**持久设置**读回来（而不是自己存一份）'
);
check(
  /toggle_close_to_tray[\s\S]{0,600}?set_close_to_tray/.test(desktopCommandsRs),
  '自绘菜单切换开关时走的是与设置页同一条命令'
);

// 未知动作必须报错而不是静默成功：静默成功会让"菜单项接错了"变成
// 一件没有线索的事（用户点了，界面没反应，也没有报错）。
check(
  /未知动作/.test(desktopCommandsRs),
  '未知的托盘动作会明确报错，而不是静默成功'
);

// 菜单窗口必须能自己关掉。少了这条行为，菜单会一直挂在屏幕上。
check(
  /WindowEvent::Focused\(false\)[\s\S]{0,120}?hide\(/.test(trayMenuRs),
  '菜单失去焦点会自己收起来（少了它菜单会一直挡在屏幕上）'
);
check(
  /tray_menu::install\(app\)/.test(desktopModRs),
  '这个行为在模块 setup 里被装上'
);

// 右键必须被接管：原生菜单仍然挂着（作为退路），若不接管右键，
// 用户会看到一个系统菜单盖在自绘菜单上面。
check(
  /MouseButton::Right[\s\S]{0,200}?tray_menu::show/.test(trayRs),
  '右键事件转给了自绘菜单（不接管的话系统菜单会同时弹出来）'
);

// 前端菜单不做业务：它只 invoke 一个动作，由后端分派。
check(
  /invoke<string \| null>\('tray_menu_action'/.test(trayMenuTsx),
  '菜单把点击转成一次 tray_menu_action 调用'
);
check(
  !/getCurrentWindow\(\)[\s\S]{0,200}?hide\(\)/.test(trayMenuTsx),
  '菜单**不自己隐藏窗口**（由后端在处理动作时决定，否则"点了没反应"会无法区分）'
);
check(
  trayMenuMainTsx.includes('#tray-menu-root'),
  '独立入口挂载到 tray-menu.html 里的容器上'
);

// ============================================================
// 8. 释放资源：菜单里的那一项必须真的做事
// ============================================================
//
// 「释放资源」是个很容易变成安慰剂的功能 —— 它必须同时回收工作集与停掉后台宿主，
// 而且**不显示主窗口**（把一个大窗口弹到屏幕上是反着的）。
console.log('\n释放资源：');

check(
  /"free"[\s\S]{0,400}?trim_self_tree\(\)/.test(desktopCommandsRs),
  '「释放资源」会回收工作集'
);
check(
  /"free"[\s\S]{0,500}?shutdown\(\)\.await/.test(desktopCommandsRs),
  '「释放资源」会停掉后台宿主'
);
check(
  !/"free"[\s\S]{0,300}?show_main_window/.test(desktopCommandsRs),
  '「释放资源」不会显示主窗口（那与这个动作的语义相反）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
