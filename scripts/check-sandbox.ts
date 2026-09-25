// scripts/check-sandbox.ts
//
// 插件沙箱的**门禁**。
//
//   node scripts/check-sandbox.ts
//
// ============================================================
// 它守的是什么
// ============================================================
//
// 沙箱的安全性质由 `check:acl` 断言（没有任何 capability 把插件 webview 纳入作用域、
// build.rs 必须有应用级 ACL 清单）。这个脚本守的是**另一类**会静默失效的东西：
// 那条通道本身。
//
// 这几处的共同点是"改错了不会有任何症状，直到有人在真实运行里撞上"：
//
//   · 桥接层的占位符没被替换干净 → 插件读到的 id 是字面量 `__PLUGIN_ID__`；
//   · 真插件的 CSP 被改成 `'unsafe-inline'` → 内联脚本重新可用，边界静默变弱；
//   · 组件文档里的 script 顺序被调换 → 插件脚本先于桥接层执行，`window.Modulith`
//     是 undefined；
//   · 资源路径少了规范化之后的前缀判断 → 一次 `../` 就能读到插件目录之外。
//
// 前三条在本地跑一次就会暴露，但它们不该靠"记得跑一次"。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function section(title: string): void {
  console.log(`\n${title}：`);
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(resolve(here, relative), 'utf8');
const exists = (relative: string): boolean => existsSync(resolve(here, relative));

const sandboxRs = read('../src-tauri/src/modules/plugins/sandbox.rs');
const bridgeJs = read('../src-tauri/resources/sandbox-bridge.js');

// ============================================================
// 1. 桥接层的占位符必须被替换干净
// ============================================================
//
// 这条断言在 Rust 侧也有一份（`bridge_script` 里的 `debug_assert!`），但那个只在
// debug 构建生效。这里补上 release 也管用的那一份。
//
// 它抓到过一个真实的错误：`sandbox-bridge.js` 的注释里原样写了一遍 `__PLUGIN_ID__`，
// 而替换只针对带引号的形式 —— 于是 debug 构建里那条断言**直接 panic**，
// 桥接层整个发不出去。注释里也不能出现这些记号。

section('桥接层的占位符');

{
  const quoted = ['__PLUGIN_ID__', '__PLUGIN_NAME__', '__PLUGIN_VERSION__', '__PLUGIN_RUNTIME__', '__PLUGIN_ACTIVATION__'];
  for (const token of quoted) {
    const occurrences = bridgeJs.split(`'${token}'`).length - 1;
    check(occurrences === 1, `${token} 恰好出现一次（带引号的形式）`);
  }

  for (const token of ['__PLUGIN_PERMISSIONS__', '__PLUGIN_DATA_AVAILABLE__', '__PLUGIN_THEME__']) {
    const occurrences = bridgeJs.split(token).length - 1;
    check(occurrences === 1, `${token} 恰好出现一次`);
  }

  // 模拟 `bridge_script` 的替换（Rust 侧用的是"替换全部"），确认一个记号都不剩。
  const rendered = bridgeJs
    .replaceAll("'__PLUGIN_ID__'", '"com.modulith.sandbox-demo"')
    .replaceAll("'__PLUGIN_NAME__'", '"沙箱演示插件"')
    .replaceAll("'__PLUGIN_VERSION__'", '"1.0.0"')
    .replaceAll("'__PLUGIN_RUNTIME__'", '"sandboxed"')
    .replaceAll("'__PLUGIN_ACTIVATION__'", '"open"')
    .replaceAll('__PLUGIN_PERMISSIONS__', '["storage"]')
    .replaceAll('__PLUGIN_DATA_AVAILABLE__', 'true')
    .replaceAll(
      '__PLUGIN_THEME__',
      '{"resolved":"dark","reduceMotion":false,"glass":true,"tokens":{"--accent-500":"hsl(243 80% 55%)"}}'
    );

  const leftover = [
    '__PLUGIN_ID__',
    '__PLUGIN_NAME__',
    '__PLUGIN_VERSION__',
    '__PLUGIN_RUNTIME__',
    '__PLUGIN_ACTIVATION__',
    '__PLUGIN_PERMISSIONS__',
    '__PLUGIN_DATA_AVAILABLE__',
    '__PLUGIN_THEME__',
  ].filter((token) => rendered.includes(token));

  check(
    leftover.length === 0,
    leftover.length === 0
      ? '替换之后没有残留的占位符（注释里也没有）'
      : `替换之后仍有残留：${leftover.join('、')} —— 插件会读到字面量而不是自己的 id`
  );

  // 替换后的脚本必须是能解析的 JS。`new Function` 只解析不执行。
  let parses = true;
  try {
    // eslint-disable-next-line no-new-func
    new Function(rendered);
  } catch {
    parses = false;
  }
  check(parses, '替换之后的桥接脚本仍然是合法的 JavaScript');
}

// ============================================================
// 2. 两类文档的 CSP 必须不同，且真插件那一侧更严
// ============================================================
//
// 自检页是宿主内置的、脚本内联，所以它用 `'unsafe-inline'`。
// **真插件必须用 `'self'`** —— 把两者统一起来是一个很自然的"整理"，
// 而它会让插件重新获得内联脚本能力，边界静默变弱。

section('文档的 CSP');

{
  // `page` 是共用的 CSP 外壳，`script_and_style` 由调用方给。
  const pageFn = /fn page\([\s\S]*?\n}/.exec(sandboxRs);
  check(pageFn !== null, 'sandbox.rs 里能找到 page()');

  if (pageFn) {
    const body = pageFn[0];
    for (const directive of [
      "default-src 'none'",
      'connect-src',
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      check(body.includes(directive), `CSP 里有 ${directive}`);
    }
  }

  // 调用点：入口文档必须走 `page(..., "script-src 'self' …")`。
  const entryFn = /fn entry_document(?:<[^>]*>)?\([\s\S]*?\n}/.exec(sandboxRs);
  check(entryFn !== null, 'sandbox.rs 里能找到 entry_document()');

  // **只看 `script-src` 这一条指令的内容**，不是"整段里有没有出现过某个字符串"。
  //
  // 这里第一版写的是 `!/script-src 'unsafe-inline'/`，于是它**永远为真**：
  // 退化后的写法是 `script-src 'self' 'unsafe-inline'`，两个记号并不相邻。
  // 实测过 —— 把那行真的改坏，门禁照样全绿。这类"不会失败的断言"比没有断言更糟。
  const entryScriptSrc =
    entryFn !== null ? /script-src([^;"]*)/.exec(entryFn[0])?.[1] ?? null : null;

  check(entryScriptSrc !== null, '入口文档里能找到 script-src 指令');
  check(
    entryScriptSrc !== null && entryScriptSrc.includes("'self'"),
    `真插件的 script-src 允许 'self'（实际是 ${JSON.stringify(entryScriptSrc)}）`
  );
  check(
    entryScriptSrc !== null && !entryScriptSrc.includes("'unsafe-inline'"),
    `真插件的 script-src **不含** 'unsafe-inline'（实际是 ${JSON.stringify(entryScriptSrc)}）`
  );

  // 自检页保留 `'unsafe-inline'`：它就是一段内联脚本，这是有意的差别。
  const selftestFn = /fn selftest_html\([\s\S]*?\n}/.exec(sandboxRs);
  const selftestScriptSrc =
    selftestFn !== null ? /script-src([^;"]*)/.exec(selftestFn[0])?.[1] ?? null : null;
  check(
    selftestScriptSrc !== null && selftestScriptSrc.includes("'unsafe-inline'"),
    '自检页仍然用 \'unsafe-inline\'（两类文档的差别是有意的，不是漏改）'
  );
}

// ============================================================
// 3. 入口文档里的脚本顺序
// ============================================================
//
// 桥接层必须在插件入口**之前**。反过来的话 `window.Modulith` 是 undefined，
// 而插件的报错会是"Cannot read properties of undefined" —— 看起来像插件自己的 bug。

section('入口文档的脚本顺序');

{
  const entryFn = /fn entry_document(?:<[^>]*>)?\([\s\S]*?\n}/.exec(sandboxRs);
  if (entryFn) {
    const bridge = entryFn[0].indexOf('bridge.js');
    const main = entryFn[0].indexOf('asset/{main}');
    check(bridge !== -1, '入口文档里加载了 bridge.js');
    check(main !== -1, '入口文档里加载了插件入口脚本');
    check(
      bridge !== -1 && main !== -1 && bridge < main,
      'bridge.js 排在插件入口脚本之前'
    );
  }
}

// ============================================================
// 4. 资源路径必须做规范化之后的越界判断
// ============================================================
//
// 不用"字符串里有没有 `..`"那种判据：它在 Windows 上会被 `\`、短名、UNC 绕过。
// 判据必须是"规范化之后仍在插件目录之下"，并且只吐普通文件。

section('资源路径的越界判断');

{
  const resolveFn = /fn resolve_within\([\s\S]*?\n}/.exec(sandboxRs);
  check(resolveFn !== null, 'sandbox.rs 里能找到 resolve_within()');

  if (resolveFn) {
    const body = resolveFn[0];
    check(body.includes('canonicalize'), '用 canonicalize 规范化（它会解开符号链接）');
    check(body.includes('starts_with'), '规范化之后判断仍在插件目录之下');
    check(body.includes('is_file'), '只吐普通文件');
  }

  check(
    /fn serve_asset\([\s\S]*?\n}/.test(sandboxRs) &&
      /resolve_within\(/.test(/fn serve_asset\([\s\S]*?\n}/.exec(sandboxRs)![0]),
    'serve_asset 走的是 resolve_within，没有自己拼路径'
  );

  check(
    /urlencoding::decode/.test(sandboxRs),
    '资源路径先做百分号解码（否则 %2e%2e 会绕过字符串判断）'
  );
}

// ============================================================
// 5. 单一真源：沙箱这边**不记插件的事实**
// ============================================================
//
// 曾经的做法是本模块记一份 `标签 → {根目录, 入口, 样式, 权限}`。那让宿主里出现了
// 两套"什么插件存在、它能做什么"，而两套清单一定会漂 —— 漂开的方向是
// **"沙箱以为这个插件存在、存储那边不认"**。实测撞到过一次（§7.40）。
//
// 现在的事实只有一个来源：`PluginManager::sandbox_view`。本模块只保留
// **标签 → 插件 id** 一条映射，而它不可能与真源漂开：每次建界面都必须先通过
// `sandbox_view`，拿不到就建不出来 —— **没安装的插件构造上就拿不到界面**。

section('单一真源');

{
  // 沙箱**不得**自己读清单。它一旦读，就又多了一份迟早会与 PluginManager 漂开的事实。
  check(
    !/manifest\.json/.test(sandboxRs),
    'sandbox.rs 不自己读 manifest.json（事实全部来自 PluginManager）'
  );
  check(
    !/PluginManifest/.test(sandboxRs),
    'sandbox.rs 不反序列化清单（那是 PluginManager 的活）'
  );

  // 界面表只记身份，不记事实。
  check(
    /pub struct SandboxSurfaces\(RwLock<HashMap<String, String>>\)/.test(sandboxRs),
    'SandboxSurfaces 只映射「标签 → 插件 id」，不存放插件的事实'
  );

  // 建界面的第一步必须是核实插件存在。
  //
  // `async` 是**承重的**，不是风格：同步函数的函数体在 IPC 线程（主线程）上就地
  // 执行，而这条函数最终要创建 webview —— 那是主线程不能做的事。见第 9 节。
  const openFn = /pub async fn open_surface_at[\s\S]*?\n}/.exec(sandboxRs);
  check(openFn !== null, 'sandbox.rs 里有 open_surface_at()，且是 async');

  if (openFn) {
    const body = openFn[0];
    check(
      /sandbox_view\(/.test(body),
      'open_surface_at 先经 PluginManager 核实插件（这一步拿不到就什么都不建）'
    );
    check(
      body.indexOf('sandbox_view(') < body.indexOf('claim('),
      '核实排在占位之前 —— 反过来的话，未安装的插件也能先占住标签'
    );
    check(
      body.indexOf('claim(') < body.indexOf('.show('),
      '占位排在建 webview 之前 —— 反过来的话，首条协议请求会先到而表里还没有记录'
    );
    check(
      /needs_own_webview\(\)/.test(body),
      'open_surface_at 检查清单声明的是 sandboxed（否则 in-process 插件也能拿到界面）'
    );
    check(
      /forget\(/.test(body),
      '建 webview 失败时撤销占位 —— 留一条指向不存在界面的记录会让这个插件**永远建不出来**'
    );
    // 读锁必须在把活交给界面线程之前放掉：接口本身是 `let view = { ... };`
    // 这个块，而判据是"从取锁到 .show( 之间确实出现了块的收尾 `};`"。
    // 若有人把 `.show()` 挪进那个块里，读锁就会跨过 await —— 于是"等待这把锁的
    // 写操作"与"界面线程创建 webview"会互等。
    const between = body.slice(body.indexOf('read().await'), body.indexOf('.show('));
    check(
      between.includes('};'),
      'open_surface_at 在把活交给界面线程之前已经放掉了注册表的读锁'
    );
  }

  // 关界面时**必须**同时撤销占位。只关 webview 而留着记录，下一次建界面会以为
  // "已经建过了"，而 webview 其实已经不在了。
  const closeFn = /pub async fn close_surface[\s\S]*?\n}/.exec(sandboxRs);
  check(closeFn !== null, 'sandbox.rs 里有 close_surface()，且是 async');
  check(
    closeFn !== null && /forget\(/.test(closeFn[0]),
    'close_surface 同时撤销占位（两处状态必须一起动）'
  );
  check(
    closeFn !== null && closeFn[0].indexOf('forget(') < closeFn[0].indexOf('.close('),
    'close_surface 先撤销占位再关 webview —— 顺序反了的话，协议处理器会在窗口已经消失之后还能查到一条记录'
  );

  // ============================================================
  // 5b. 自检**不许**回到启动路径上，也不许给插件建界面
  // ============================================================
  //
  // 这里发生过两次同一类错误，方向相反，值得连起来看：
  //
  //   1. 最初它无条件地给"第一个声明了 sandboxed 的已安装插件"开一块面板。
  //      第一次真机运行的反馈是：用户没打开任何插件，界面上却多出一块挡在那里的
  //      面板，而且**没有任何方式关掉它**。
  //   2. 后来改成只建自检页，但仍然**随每次启动自动弹出**。用户的反馈是
  //      "它很打扰"。
  //
  // 两次的共性：**启动路径上不该出现任何"用户没要求的东西"**。自检是诊断工具，
  // 诊断工具要由人叫才动。现在它由「插件」页上的按钮触发（`sandbox_self_test`）。
  //
  // 而能力本身要留着：它验的是边界本身，自检页是仓库里唯一会去故意违规的地方。
  const openSelftestFn = /pub async fn open_selftest[\s\S]*?\n}\n/.exec(sandboxRs);
  check(openSelftestFn !== null, 'sandbox.rs 里有 open_selftest()，且是 async');
  check(
    openSelftestFn !== null && !/open_surface_at/.test(openSelftestFn[0]),
    '自检不给插件建界面（它只建自检页）'
  );

  // 启动路径（生成模板）里不许出现自检调用。这条盯的是"别再把它加回去"。
  const generatorForSelftest = read('../scripts/generate-backend-module.ts');
  check(
    !/spawn_debug_harness/.test(generatorForSelftest),
    '启动路径里没有自检调用（它由「插件」页的按钮显式触发）'
  );
  check(
    !/spawn_debug_harness/.test(read('../src-tauri/src/lib.rs')),
    'lib.rs 的启动路径里也没有自检调用'
  );

  // 那个入口必须真的存在，否则"改成显式触发"就等于把能力删掉了 ——
  // 而删掉之后不会有任何报错，只是这条边界再也没人验过。
  check(
    /pub async fn sandbox_self_test\(/.test(read('../src-tauri/src/modules/plugins/commands.rs')),
    'sandbox_self_test 命令存在且是 async（否则"显式触发"是句空话）'
  );
  check(
    /runSandboxSelfTest/.test(read('../src/modules/plugins/Plugins.tsx')),
    '「插件」页上真的有触发它的按钮'
  );

  // 不再有内置演示插件：它曾经是"沙箱这边有一个 PluginManager 不认识的插件"，
  // 也就是两个真源的来源。
  check(
    !exists('../src-tauri/resources/sandbox-demo'),
    '内置演示插件目录已删除（它正是两个真源的来源）'
  );
  check(
    !/DEMO_ID|DEMO_ROOT|demo_plugin/.test(sandboxRs),
    'sandbox.rs 里没有演示插件的残留'
  );
}

// ============================================================
// 6. 身份来自界面表，不是从标签反推
// ============================================================
//
// 插件 id 允许含 `.` `_` `-`，而标签的字符集更窄 —— 把 id 直接拼进标签会在
// `a.b` 与 `a-b` 之间产生歧义。

section('身份来源');

{
  check(
    /surfaces\.plugin_of\(label\)/.test(sandboxRs),
    'handle() 从界面表取插件 id（而不是解析标签前缀）'
  );
  check(
    /claimed != view\.id/.test(sandboxRs),
    '路径第一段必须与插件 id 相符'
  );
  check(
    /fn label_for/.test(sandboxRs) && /LABEL_PREFIX/.test(sandboxRs),
    '标签由 label_for 统一产出'
  );
  check(
    /标签冲突/.test(sandboxRs),
    '标签冲突被显式检测（否则两个插件里有一个会静默失效）'
  );
}

// ============================================================
// 7. 运行位置字段不许静默降级
// ============================================================
//
// 一个写了 `sandboxed`、却被旧宿主当成 `in-process` 跑起来的插件，是一次
// **静默的安全降级** —— 它声明了隔离，实际没有。因此这个枚举**不能**有
// `#[serde(other)]` 那种"未知值折算到某一档"的写法：未知值必须让整份清单不合法，
// 安装直接失败。
//
// 这一条盯的是一个很自然的"顺手加个兜底"的改动。

section('运行位置字段');

{
  const typesRs = read('../src-tauri/src/modules/plugins/types.rs');

  // 属性行在 `pub enum` **之前**，因此匹配要把它们一起圈进来 ——
  // 只从 `pub enum` 开始的话，`rename_all` 永远不在块里，这条断言就恒为真。
  const enumBlock = /(?:#\[[^\]]*\]\s*)*pub enum PluginRuntime \{[\s\S]*?\n}/.exec(typesRs);
  check(enumBlock !== null, 'types.rs 里有 PluginRuntime 枚举');

  if (enumBlock) {
    check(
      !/#\[serde\(other\)\]/.test(enumBlock[0]),
      'PluginRuntime 没有 #[serde(other)]（未知值必须让清单不合法，不能折算）'
    );
    check(
      /rename_all = "kebab-case"/.test(enumBlock[0]),
      'PluginRuntime 用 kebab-case（清单里写的是 "in-process" / "sandboxed"）'
    );
  }

  check(
    /pub runtime: PluginRuntime/.test(typesRs),
    'PluginManifest 上有 runtime 字段'
  );
  check(
    /runtime: PluginRuntime::InProcess/.test(typesRs),
    '兜底清单（清单损坏时）用 in-process —— 读不出来的插件不该被当成沙箱插件'
  );
  check(
    /pub fn needs_own_webview/.test(typesRs),
    'PluginRuntime::needs_own_webview() 存在，供建界面那一侧判断'
  );

  // 文档必须说清"未知值不让装"，否则下一个人会把它读成"写错了会自动兜底"。
  const manifestDoc = read('../docs/02-开发指南/插件开发/清单文件参考.md');
  check(
    /runtime/.test(manifestDoc),
    '清单文件参考里写了 runtime 字段'
  );
}

/** `src-tauri/src` 下的全部 `.rs` 文件（绝对路径）。 */
function rustSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.rs')) files.push(full);
    }
  };
  walk(resolve(here, '../src-tauri/src'));
  return files;
}

/** `src-tauri/src` 下的绝对路径 → 便于阅读的 `src/...` 形式。 */
const shortPath = (file: string): string =>
  file.replace(resolve(here, '../src-tauri/src'), 'src').replace(/\\/g, '/');

/**
 * 剥掉行注释与块注释。
 *
 * **这一步不是可选的。** 这一节要找的每个词（`get_webview_window`、`add_child`、
 * `block_on`）都恰好是本仓库里被**长篇解释过为什么不能用**的词。不剥注释的话，
 * 一份说明"不许这么写"的注释会把门禁判成违规，而修它的唯一办法是删掉注释 ——
 * 于是最该留下的那份知识第一个消失。
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 在一个文件里，剥掉注释之后含某个词的所有文件。 */
function filesContaining(needle: string, files: string[]): string[] {
  return files
    .filter((file) => stripComments(readFileSync(file, 'utf8')).includes(needle))
    .map(shortPath);
}

const strip = stripComments;

// ============================================================
// 8. 窗口查找不许走 `get_webview_window`
// ============================================================
//
// `get_webview_window(label)` 在返回前会再判一次 `is_webview_window()`，而那个判据是
// "这个窗口下的**所有** webview 的标签都等于窗口标签"。**只要窗口里多出一个 webview**
// —— 沙箱插件的界面就是 —— 它就变成 false，于是返回 `None`。
//
// 症状完全不像"取不到窗口"：关闭按钮点了没反应（关闭行为那条路径找不到窗口）、
// 隐藏到托盘之后托盘再也叫不回窗口、内存等级设不上，而日志里只有一句
// "找不到主窗口"。第一次真人使用正是这样：装上第一个沙箱插件之后，点关闭就再也
// 回不来了。
//
// 因此宿主代码一律走 `core::window`。这条断言盯的就是"别再有人图省事写回去"。

section('窗口查找');

{
  const offenders = filesContaining('get_webview_window', rustSources());

  check(
    offenders.length === 0,
    offenders.length === 0
      ? '宿主源码里没有 get_webview_window（都走 core::window）'
      : `这些文件仍在用 get_webview_window —— 窗口里多一个 webview 就会失效：${offenders.join('、')}`
  );

  check(
    /pub fn main<R: Runtime>/.test(read('../src-tauri/src/core/window.rs')),
    'core::window 提供了 main()'
  );
  check(
    /pub fn main_webview<R: Runtime>/.test(read('../src-tauri/src/core/window.rs')),
    'core::window 提供了 main_webview()'
  );
}

// ============================================================
// 9. 创建 webview 只能是所有者线程的事
// ============================================================
//
// 这一节守的是本仓库发生过的**最严重**的一次缺陷：整机假死。
//
// 现象：点开一个沙箱插件之后，其余插件全部失效，主窗口的关闭/最大化/最小化全部
// 没反应，托盘菜单同样没反应，而进程还活着、日志**戛然而止**、一条 ERROR 都没有。
//
// 真因是三条事实叠在一起（推导见 plugins/surface.rs 的文件头）：
//
//   1. `Window::add_child` = `run_on_main_thread(闭包)` + `rx.recv()` ——
//      它**阻塞调用它的线程**；
//   2. `run_on_main_thread` 在已经身处主线程时短路成**直接调用**；
//   3. `#[tauri::command]` 默认是 `ExecutionContext::Blocking`，函数体就地执行，
//      而 IPC 回调跑在主线程上。
//
// 于是"同步命令里建 webview" = 在 WebView2 自己的事件回调里同步创建另一个
// WebView2 控制器，主线程从此不再回到事件循环。
//
// 日志里其实已经跑过一次对照实验：自检界面由**另一个线程**创建，连续三个会话都
// 成功；插件界面由前端命令创建，直接断在那里。唯一变量就是调用线程。
//
// 下面每一条都指向同一句话：**动窗口的代码只允许在 surface.rs 的所有者线程上。**

section('界面线程');

{
  const surfaceFile = '../src-tauri/src/modules/plugins/surface.rs';
  const surfaceRs = read(surfaceFile);
  const commandsRs = read('../src-tauri/src/modules/plugins/commands.rs');

  // ① `add_child` 全仓只能出现在 surface.rs。
  //    它出现在别处 = 有人在某个没被约束的线程上建 webview。
  const addChild = filesContaining('add_child', rustSources());
  check(
    addChild.length === 1 && addChild[0].endsWith('plugins/surface.rs'),
    addChild.length === 1 && addChild[0].endsWith('plugins/surface.rs')
      ? 'add_child 只出现在 plugins/surface.rs（所有者线程）'
      : `add_child 出现在这些文件里 —— 它们不在被约束的线程上：${addChild.join('、') || '（一处都没有，那也不对）'}`
  );

  // ② 在 surface.rs 自身也只能有一处调用点。
  //    多出来的那一份几乎一定是被复制到了 create() 之外的地方，而那里可能正跑在
  //    主线程上 —— 这正是假死的形状。
  const addChildCalls = (strip(surfaceRs).match(/\.add_child\s*\(/g) ?? []).length;
  check(
    addChildCalls === 1,
    addChildCalls === 1
      ? 'surface.rs 里 add_child 只有一个调用点'
      : `surface.rs 里有 ${addChildCalls} 个 add_child 调用点，应当只有 1 个`
  );

  // ③ 所有者线程真的存在。字符串里找不到就说明有人把线程换成了"就地执行"。
  check(
    /mpsc::channel::<Job>\(\)/.test(surfaceRs) &&
      /\.spawn\(move \|\| run\(app, rx\)\)/.test(surfaceRs),
    'surface.rs 起了一条专属线程来执行界面操作'
  );

  // ④ 宿主侧不许把线程钉住。`block_on` 会把调用它的线程钉在那里，
  //    而那个线程可能是主线程 —— 上一次就是它（在 open_surface_at 里读注册表）。
  const blockOn = filesContaining('block_on', rustSources().filter((f) => shortPath(f).includes('/plugins/')));
  check(
    blockOn.length === 0,
    blockOn.length === 0
      ? 'plugins 模块里没有 block_on（锁一律用 .await）'
      : `这些插件文件仍在 block_on —— 它会把调用线程钉住：${blockOn.join('、')}`
  );

  // ⑤ 也不许自己去投主线程消息。这条与 block_on 是同一类错误的两张面孔。
  const mainThread = filesContaining('run_on_main_thread', rustSources().filter((f) => shortPath(f).includes('/plugins/')));
  check(
    mainThread.length === 0,
    mainThread.length === 0
      ? 'plugins 模块里没有 run_on_main_thread'
      : `这些插件文件在直接投主线程消息：${mainThread.join('、')}`
  );

  // ⑥ 四条界面命令必须是 async。
  //    同步命令的函数体在主线程上就地执行 —— 这不是风格问题，是假死的成因。
  for (const name of [
    'sandbox_surface_open',
    'sandbox_surface_hide',
    'sandbox_surface_close',
    'sandbox_surface_bounds',
  ]) {
    check(
      new RegExp(`pub async fn ${name}\\b`).test(commandsRs),
      `${name} 是 async（写成同步就会在主线程上创建 webview）`
    );
  }

  // ⑦ 所有者线程必须真的被托管。忘了 manage 的话，每条命令都会回
  //    "界面线程尚未就绪" —— 一个看起来像初始化顺序问题的错误。
  const generatorTs = read('../scripts/generate-backend-module.ts');
  check(
    /SurfaceActor::spawn\(handle\.clone\(\)\)/.test(generatorTs) &&
      /SurfaceActor::spawn\(handle\.clone\(\)\)/.test(read('../src-tauri/src/lib.rs')),
    'lib.rs（及其模板）托管了 SurfaceActor'
  );

  // ⑧ 自检界面也必须走所有者线程。它曾经自己 spawn 一条线程 —— 那条路径能工作，
  //    但它是"绕过约束"的先例：下一个人照着它写就会在别处照抄出一个主线程调用。
  check(
    !/std::thread::spawn/.test(strip(sandboxRs)),
    'sandbox.rs 不再自己起线程（自检也走所有者线程）'
  );

  // ⑨ 驻留上限。`hide` 而不 `close` 是有代价的：切过的每个沙箱插件都会留下一个
  //    渲染进程。没有上限，那是**设计出来的内存泄漏**。
  const code = strip(surfaceRs);
  check(
    /const MAX_RESIDENT: usize = \d+/.test(code),
    'surface.rs 有驻留上限常量'
  );
  check(
    /fn enforce_cap\(/.test(code) && /MAX_RESIDENT/.test(code),
    '超过上限时真的会执行淘汰'
  );
  // ⑩ 淘汰必须**只**看隐藏的那些。少了这个过滤，用户正在看的界面会被别处打开的
  //    插件销毁掉 —— 一个"我点了一下别的插件，眼前这个就白了"的故障。
  check(
    /filter\(\|\(_, resident\)\| !resident\.visible\)/.test(code),
    '淘汰只挑隐藏的界面（正在被看着的永远不动）'
  );
  // ⑪ 回收与关闭都必须撤掉界面表里的占位。留着的话，那个插件**再也打不开**。
  check(
    /fn forget_claim</.test(code) && /forget_claim\(app, &label\)/.test(code),
    '淘汰与关闭都撤销界面表里的占位（否则那个插件再也打不开）'
  );
}

// ============================================================
// 10. 前端这一侧：隐藏与跟随
// ============================================================
//
// 这两条守的是"界面看起来对不对"，而它们失效时同样不会有任何报错：
//
//   * 少掉 `hide` → 切走标签之后插件界面**仍然浮在别的标签上面**；
//   * 少掉滚动监听 → 宿主内容一滚，插件界面就停在原地，看起来像错位。
//
// 两者的共同点是"只有肉眼能发现"，而那正是门禁该管的东西。

section('前端界面协作');

{
  const serviceTs = read('../src/services/sandboxSurface.ts');
  const componentTsx = read('../src/components/SandboxSurface.tsx');

  check(
    /invoke\('sandbox_surface_hide'/.test(serviceTs),
    '前端门面暴露了 hide（隐藏而不销毁）'
  );
  check(
    /hideSandboxSurface\(pluginId\)/.test(componentTsx),
    '不可见时调用 hide，而不是 close'
  );
  check(
    /closeSandboxSurface\(pluginId\)/.test(componentTsx),
    '卸载时才调用 close'
  );

  // 滚动事件**不冒泡**，且滚动发生在祖先容器而不是 window 上。
  // 只在 window 上监听冒泡阶段等于什么都没听 —— 这条断言盯的就是那个写法。
  check(
    /addEventListener\('scroll',\s*schedule,\s*true\)/.test(componentTsx),
    "滚动监听带捕获标志（滚动不冒泡，冒泡阶段收不到）"
  );

  // 宿主浮层盖上来时必须让位。判据是命中最上面的元素是不是占位块自己。
  check(
    /elementFromPoint/.test(componentTsx),
    '宿主浮层遮挡时会让位（而不是盖在浮层上面）'
  );

  // ---- 矩形从哪里来 ----
  //
  // 这里曾经量的是"占位块自己的矩形"，而占位块是 `h-full w-full` ——
  // `h-full` 是父元素高度的 100%，父级 `div.p-8` 的高度由内容决定，内容为空，
  // 于是高度是 **0**。实测那次建出来的 webview 是 `2240×1`：宽度对，高 1 像素。
  // 症状看起来像"插件坏了"，根因是量错了东西。
  //
  // 现在量的是内容视口（`.lc-tab-panel`，`absolute inset-y-0`，高度确定）。
  const homeTsx = read('../src/pages/Home.tsx');

  const selector = /const PANEL_SELECTOR = '([^']+)'/.exec(componentTsx);
  check(selector !== null, 'SandboxSurface 声明了内容视口选择器');
  check(
    selector !== null && homeTsx.includes(selector[1]),
    selector !== null && homeTsx.includes(selector[1])
      ? `内容视口选择器 ${selector?.[1]} 在 Home.tsx 里真的存在（跨文件契约没漂）`
      : `SandboxSurface 量的是 ${selector?.[1]}，而 Home.tsx 里已经没有这个类名了 —— 矩形会量成 0`
  );

  // 那个具体的错误写法不许回来。
  check(
    !/className="h-full w-full"/.test(componentTsx),
    '占位块不再是 h-full（父级高度由内容决定时它会塌成 0）'
  );

  // 判据必须**具体到那几行**。第一版写的是 `/return null;/`，而文件里还有别的
  // `return null;` —— 把守卫删掉它照样通过。用"删掉守卫"验证时它没有变红，
  // 也就等于什么都没守。下面两条是照着实际那两行写的。
  check(
    /if \(rect\.width < 1 \|\| rect\.height < 1\) return null;/.test(componentTsx),
    '视口本身是退化尺寸（宽或高为 0）时返回 null'
  );
  // 插件界面**不该内缩**。这里原来会减掉父级 2rem 内边距，为的是"与其它模块
  // 看起来一致" —— 那个意图是错的：其它模块是一张卡片，留白是设计；插件界面是
  // 一个应用，它该占满自己那一块。实测这就是用户报的"留白、未全屏"的一半来源。
  check(
    !/getComputedStyle/.test(componentTsx),
    '插件界面不按父级内边距内缩（它是应用，不是卡片）'
  );
  check(
    /x: rect\.left,\s*\n\s*y: rect\.top,/.test(componentTsx),
    '矩形直接就是内容视口本身'
  );

  // 而调用方必须真的**因此返回**。只让 measureSurface 返回 null、调用方继续往下走，
  // 退化尺寸还是会到达宿主 —— 那正是 2240×1 那次的形状。
  const applyBody = /const apply = useCallback\([\s\S]*?\n  \);/.exec(componentTsx);
  check(
    applyBody !== null && /if \(!bounds\) \{[\s\S]*?return;/.test(applyBody[0]),
    '量不到视口时直接返回，不让退化尺寸走到宿主那边去'
  );
}

// ============================================================
// 11. 完整 API 表面：桥接层 ↔ 宿主
// ============================================================
//
// 这一节守的是整个方案里最容易悄悄腐坏的一件事：**同一个 `ctx`，两处实现。**
// 宿主侧是 `pluginRuntime.ts`（in-process 插件用），沙箱侧是 `sandbox-bridge.js`
// （sandboxed 插件用）。一个插件可以在两者之间切换，它的代码不该因此改一行 ——
// 因此两边的成员必须一一对应。
//
// ============================================================
// 为什么是"真的跑一遍"而不是文本匹配
// ============================================================
//
// 文本匹配能查到"这行代码还在"，但查不到"这个成员真的挂在对象上"。两者差别很大：
// 把 `dataDir` 从 `Modulith` 字面量里删掉、只留下它的定义，文本断言照样通过，
// 而插件拿到的是 `undefined`。因此这里把渲染后的桥接脚本**执行一遍**，
// 再遍历得到的 `Modulith` 对象。
//
// 执行它需要三个假东西：`window`（对象会被挂上去）、`fetch`（这条检查不发网络）、
// `navigator.clipboard`。除此之外它只用到语言内置的东西。

section('完整 API 表面');

{
    const rendered = bridgeJs
      .replaceAll("'__PLUGIN_ID__'", '"com.modulith.sandbox-demo"')
      .replaceAll("'__PLUGIN_NAME__'", '"沙箱演示插件"')
      .replaceAll("'__PLUGIN_VERSION__'", '"1.2.3"')
      .replaceAll("'__PLUGIN_RUNTIME__'", '"sandboxed"')
      .replaceAll("'__PLUGIN_ACTIVATION__'", '"open"')
      .replaceAll('__PLUGIN_PERMISSIONS__', '["storage","plugin-data","clipboard"]')
      .replaceAll('__PLUGIN_DATA_AVAILABLE__', 'true')
      .replaceAll(
        '__PLUGIN_THEME__',
        '{"resolved":"light","reduceMotion":true,"glass":false,"tokens":{"--accent-500":"hsl(243 80% 55%)"}}'
      );

  const fakeWindow: Record<string, unknown> = {
    // 桥接层在文档消失时要跑清理函数；这条检查里没有真实的页面生命周期。
    addEventListener: () => {},
  };

  let api: Record<string, any> | null = null;
  let failure = '';
  try {
    const factory = new Function(
      'window',
      'fetch',
      'navigator',
      `${rendered}\nreturn window.Modulith;`
    );
    api = factory(
      fakeWindow,
      () => Promise.reject(new Error('这条检查不发网络请求')),
      { clipboard: { readText: async () => '', writeText: async () => {} } }
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  check(api !== null, api !== null ? '桥接脚本可以被实例化' : `桥接脚本执行失败：${failure}`);

  if (api) {
    // 身份必须是**宿主给的那一份**（占位符替换的结果），不是插件自报的。
    check(api.plugin?.id === 'com.modulith.sandbox-demo', 'plugin.id 来自宿主注入的身份');
    check(api.plugin?.version === '1.2.3', 'plugin.version 来自宿主注入的版本');
    check(api.plugin?.runtime === 'sandboxed', 'plugin.runtime 如实报告运行位置');
    check(
      Array.isArray(api.plugin?.permissions) && api.plugin.permissions.length === 3,
      'plugin.permissions 来自清单'
    );
    check(api.activationEvent === 'open', 'activationEvent 由宿主注入');
    check(api.has('storage') === true && api.has('native-module') === false, 'has() 按清单判定');

    // §3 的成员表。**它是一份显式的清单而不是遍历对象**：遍历只能证明"有东西"，
    // 而这份清单能证明"就是这些，一个不少"。
    const members: Array<[string, (value: unknown) => boolean]> = [
      // 3.1 身份与元信息
      ['log.debug', isFunction],
      ['log.info', isFunction],
      ['log.warn', isFunction],
      ['log.error', isFunction],

      // 3.2 数据 · 键值存储
      ['storage.get', isFunction],
      ['storage.set', isFunction],
      ['storage.delete', isFunction],
      ['storage.keys', isFunction],
      ['storage.list', isFunction],
      ['storage.usage', isFunction],
      ['storage.all', isFunction],
      ['storage.clear', isFunction],

      // 3.2 数据 · 文件目录
      ['dataDir.available', (value) => typeof value === 'boolean'],
      ['dataDir.status', isFunction],
      ['dataDir.list', isFunction],
      ['dataDir.stat', isFunction],
      ['dataDir.read', isFunction],
      ['dataDir.readText', isFunction],
      ['dataDir.write', isFunction],
      ['dataDir.writeText', isFunction],
      ['dataDir.readBase64', isFunction],
      ['dataDir.writeBase64', isFunction],
      ['dataDir.mkdir', isFunction],
      ['dataDir.remove', isFunction],
      ['dataDir.used', isFunction],

      // 3.3 网络
      ['http.fetch', isFunction],

      // 3.4 界面（沙箱里没有 registerModule —— 沙箱插件自己就是界面）
      ['notifications.notify', isFunction],

      // 3.5 输入
      ['clipboard.read', isFunction],
      ['clipboard.write', isFunction],

      // 3.6 系统与集成
      ['events.emit', isFunction],
      ['events.on', isFunction],

      // 3.4 界面 · 主题
      ['theme.current', isFunction],
      ['theme.tokens', isFunction],
      ['theme.onChange', isFunction],
      ['launcher.launch', isFunction],
      ['icons.extract', isFunction],
      ['shell.revealInFolder', isFunction],
      ['audio.pick', isFunction],
      ['settings.get', isFunction],
      ['settings.all', isFunction],
      ['settings.set', isFunction],
      ['disposables.add', isFunction],
      ['disposables.size', isFunction],
    ];

    const missing = members
      .filter(([path, predicate]) => {
        const value = path.split('.').reduce<any>((node, key) => node?.[key], api);
        return !predicate(value);
      })
      .map(([path]) => path);

    check(
      missing.length === 0,
      missing.length === 0
        ? `§3 的 ${members.length} 个成员在桥接层里都有实现`
        : `桥接层缺少这些成员：${missing.join('、')}`
    );

    // ============================================================
    // 桥接层调用的每一条 RPC 都必须有宿主侧的处理分支
    // ============================================================
    //
    // 两份文件、两种语言，中间只靠字符串约定。写错一个字的表现是插件在某个成员上
    // 拿到一句"未知的 RPC 方法"，而那句话在日志里看起来像插件自己乱调。

    const called = new Set(
      [...bridgeJs.matchAll(/\brpc\(\s*'([a-zA-Z.]+)'/g)].map((match) => match[1])
    );

    // 方法表现在在**共用**的 `rpc.rs` 里（沙箱与 Node 后台两条路径共用同一份
    // ctx 实现）。因此这里查的是那个文件，同时要求 `sandbox.rs` 自己**不再**
    // 有一套方法表 —— 否则这条断言查的就不是沙箱真正走的那条路径了。
    const rpcRs = read('../src-tauri/src/modules/plugins/rpc.rs');
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
      // 只认**外层** match 的分支：它们的缩进是 8 个空格。不锚定缩进的话，
      // `"log"` 处理分支内部的日志级别分支（`"debug" =>` 等，缩进 16）会被
      // 当成三个不存在的 RPC 方法，于是这条断言自己制造三个假缺陷。
      //
      // 方法名带着点号（`storage.get`），但有几个是单词（`log`、`notify`），
      // 因此点号那段是可选的。
      [...dispatch.matchAll(/^ {8}"([a-zA-Z]+(?:\.[a-zA-Z]+)?)"\s*=>/gm)].map(
        (match) => match[1]
      )
    );

    // 沙箱必须**转发**给共用实现，而不是自己再实现一遍。
    check(
      /super::rpc::dispatch\(/.test(sandboxRs),
      'sandbox.rs 把 ctx 调用转发给共用的 rpc.rs（而不是自己再实现一套）'
    );
    check(
      !/^ {8}"storage\.get"\s*=>/m.test(sandboxRs),
      'sandbox.rs 里没有第二套 RPC 方法表'
    );

    const orphans = [...called].filter((name) => !handled.has(name));
    check(
      orphans.length === 0,
      orphans.length === 0
        ? `桥接层调用的 ${called.size} 条 RPC 在宿主侧都有处理分支`
        : `宿主侧没有这些 RPC 的处理分支：${orphans.join('、')}`
    );

    // 反方向：留着一个永远调不到的分支同样是缺陷 —— 它看起来"已经实现了"，
    // 而实际上没有任何代码路径能到达它。
    const dead = [...handled].filter((name) => !called.has(name));
    check(
      dead.length === 0,
      dead.length === 0
        ? '宿主侧的每一条 RPC 分支都真的被桥接层调用'
        : `宿主侧有调不到的分支（要么桥接层漏了，要么分支名写错了）：${dead.join('、')}`
    );

    // ============================================================
    // 大文件走的必须是原始字节通道，不是 base64
    // ============================================================
    //
    // 这是本方案对"文档 / 图库类插件"的硬要求：几百 MB 的文件过一遍 base64
    // 意味着 +33% 体积、一次完整字符串拷贝，而且全程驻留在 JS 堆里。
    // 断言"read 走 fetch 的 arrayBuffer"而不是"存在 data.readBase64"——
    // 后者只是一个便捷入口，前者才是大文件的路径。

    check(
      /read: function \(rel\) \{[\s\S]*?dataRequest\(rel, \{ method: 'GET' \}\)[\s\S]*?\.arrayBuffer\(\)/.test(bridgeJs),
      'dataDir.read 走原始字节通道并返回 ArrayBuffer'
    );
    check(
      /write: function \(rel, data\) \{[\s\S]*?method: 'PUT'/.test(bridgeJs),
      'dataDir.write 用 PUT 把字节放进请求体（不经过 base64）'
    );

    // 宿主侧那条路由必须真的存在，且两种方法都有。
    check(
      /\(\"GET\", Some\(\"data\"\)\)/.test(sandboxRs) && /\(\"PUT\", Some\(\"data\"\)\)/.test(sandboxRs),
      '宿主侧注册了原始字节通道的 GET / PUT 路由'
    );
    check(
      /async fn serve_data/.test(sandboxRs) && /async fn store_data/.test(sandboxRs),
      '原始字节通道的两端都有实现'
    );

    // 路径净化**只有一处实现**：协议层不再自己过滤一遍，两套规则一定会漂开。
    check(
      !/fn serve_data[\s\S]{0,600}?\.\./.test(sandboxRs.split('async fn serve_data')[1]?.slice(0, 600) ?? ''),
      '原始字节通道不自己重复一遍路径净化（净化只在 data_dir::resolve 里）'
    );
  }
}

function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

// ============================================================
// 12. 主题：从宿主文档到插件文档的这条链必须完整
// ============================================================
//
// 主题要跨过四个地方：宿主 CSS → 前端读出来 → 命令送上来 → 入口文档注入
// 以及推给已打开的界面。**任何一环断掉都是静默的** —— 插件那边只是颜色不对，
// 而四个地方各自的代码看起来都是对的。
//
// 逐环断言，因为断在哪一环给出的排查方向完全不同。

section('主题链路');

{
  const commandsRs = read('../src-tauri/src/modules/plugins/commands.rs');
  const themeRs = read('../src-tauri/src/modules/plugins/theme.rs');
  const themeSyncTs = read('../src/services/pluginThemeSync.ts');
  const mainTsx = read('../src/main.tsx');

  // 环 1：宿主文档 → 前端。必须**遍历 computed style**，而不是维护一张令牌表。
  //
  // 维护令牌表意味着每加一个 CSS 变量都要记得补一条，而漏补不会报错 ——
  // 插件那边只是少一个变量，表现为某一处颜色退回浏览器默认值。
  check(
    /getComputedStyle\(document\.documentElement\)/.test(themeSyncTs),
    '前端从宿主文档的 computed style 里读令牌（而不是维护一张会漂的清单）'
  );
  check(
    /startsWith\('--tw-'\)/.test(themeSyncTs),
    'Tailwind 的内部变量（--tw-*）被排除（它们是构建产物，不是设计令牌）'
  );

  // 环 2：前端 → 后端。必须**装到启动路径上**，否则主题永远送不到。
  check(
    /installPluginThemeSync\(\)/.test(mainTsx) && /subscribeTheme\(/.test(themeSyncTs),
    '主题同步装在启动路径上，且订阅了主题变化（否则只有首帧是对的）'
  );

  // 环 3：后端 → 入口文档。
  check(
    /try_state::<super::theme::PluginTheme>/.test(sandboxRs) &&
      /modulith-theme/.test(sandboxRs),
    '入口文档里注入了 theme.rs 生成的令牌块'
  );

  // 环 4：后端 → **已经打开的**界面。
  //
  // 少了这一环的表现很具体：用户切主题，已打开的插件界面**不动** ——
  // 必须关掉再打开才对。而那看起来像"这个插件不支持主题"。
  check(
    /set_plugin_theme[\s\S]{0,1200}?apply_theme\(&app\)\.await/.test(commandsRs),
    '主题变了会推给已经打开的插件界面（否则要关掉重开才生效）'
  );
  check(
    /for \(label, _plugin_id\) in surfaces\.live\(\)/.test(sandboxRs),
    '主题推送遍历全部活着的界面'
  );

  // 推送方式是**换样式表文本**，不是重新加载界面。
  //
  // 重新加载会丢掉插件全部运行期状态（正在填的表单、滚动位置、展开的树）——
  // 用户只是切了一下明暗，不该因此丢掉正在做的事。
  check(
    /style\.textContent = JSON\.parse/.test(sandboxRs),
    '推送主题是替换样式表文本，而不是重新加载界面'
  );

  // 注入防线：样式表是由字符串拼出来的，因此名字与值都必须过滤。
  check(
    /fn is_safe_custom_property/.test(themeRs) && /fn sanitize_value/.test(themeRs),
    'token 名与值在拼进样式表之前都经过过滤（否则是 CSS 注入）'
  );
  check(
    /color-scheme: \{\}/.test(themeRs),
    '注入里带了 color-scheme（否则深色主题下插件的滚动条是白的）'
  );
}

// ============================================================
// 收尾
// ============================================================

console.log(`\n共 ${total} 项断言，失败 ${failed} 项。`);
if (failed > 0) {
  process.exitCode = 1;
}