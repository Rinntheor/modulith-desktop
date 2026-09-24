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
  const quoted = ['__PLUGIN_ID__', '__PLUGIN_NAME__', '__PLUGIN_VERSION__'];
  for (const token of quoted) {
    const occurrences = bridgeJs.split(`'${token}'`).length - 1;
    check(occurrences === 1, `${token} 恰好出现一次（带引号的形式）`);
  }

  const permissionsOccurrences = bridgeJs.split('__PLUGIN_PERMISSIONS__').length - 1;
  check(permissionsOccurrences === 1, '__PLUGIN_PERMISSIONS__ 恰好出现一次');

  // 模拟 `bridge_script` 的替换（Rust 侧用的是"替换全部"），确认一个记号都不剩。
  const rendered = bridgeJs
    .replaceAll("'__PLUGIN_ID__'", '"com.modulith.sandbox-demo"')
    .replaceAll("'__PLUGIN_NAME__'", '"沙箱演示插件"')
    .replaceAll("'__PLUGIN_VERSION__'", '"1.0.0"')
    .replaceAll('__PLUGIN_PERMISSIONS__', '["storage"]');

  const leftover = ['__PLUGIN_ID__', '__PLUGIN_NAME__', '__PLUGIN_VERSION__', '__PLUGIN_PERMISSIONS__']
    .filter((token) => rendered.includes(token));

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
  const entryFn = /fn entry_document\([\s\S]*?\n}/.exec(sandboxRs);
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
  const entryFn = /fn entry_document\([\s\S]*?\n}/.exec(sandboxRs);
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
  const openFn = /pub fn open_surface_at[\s\S]*?\n}/.exec(sandboxRs);
  check(openFn !== null, 'sandbox.rs 里能找到 open_surface_at()');

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
      body.indexOf('claim(') < body.indexOf('open_surface('),
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
  }

  // 关界面时**必须**同时撤销占位。只关 webview 而留着记录，下一次建界面会以为
  // "已经建过了"，而 webview 其实已经不在了。
  const closeFn = /pub fn close_surface[\s\S]*?\n}/.exec(sandboxRs);
  check(closeFn !== null, 'sandbox.rs 里能找到 close_surface()');
  check(
    closeFn !== null && /forget\(/.test(closeFn[0]),
    'close_surface 同时撤销占位（两处状态必须一起动）'
  );

  // ============================================================
  // 5b. debug 自检**不许**自己给插件建界面
  // ============================================================
  //
  // 这里曾经无条件地给"第一个声明了 sandboxed 的已安装插件"开一块面板，
  // 用来验证真插件那一半。第一次真机运行的反馈是：用户没打开任何插件，
  // 界面上却多出一块挡在那里的面板，而且**没有任何方式关掉它**。
  //
  // 真插件那一半现在走真实路径（前端量矩形 → `sandbox_surface_open`）。
  // 这条断言盯的就是"别再把它加回启动路径里"。
  const harnessFn = /pub fn spawn_debug_harness[\s\S]*?\n}\n/.exec(sandboxRs);
  check(harnessFn !== null, 'sandbox.rs 里能找到 spawn_debug_harness()');
  check(
    harnessFn !== null && !/open_surface_at/.test(harnessFn[0]),
    'debug 自检不给插件建界面（它只建自检页，而自检页会自己关掉）'
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
  const rustFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.rs')) rustFiles.push(full);
    }
  };
  walk(resolve(here, '../src-tauri/src'));

  // 注释里会出现这个词（`core/window.rs` 就在解释它为什么不能用），
  // 因此先把行注释与块注释剥掉再找。
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const offenders = rustFiles
    .filter((file) => stripComments(readFileSync(file, 'utf8')).includes('get_webview_window'))
    .map((file) => file.replace(resolve(here, '../src-tauri/src'), 'src').replace(/\\/g, '/'));

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
// 收尾
// ============================================================

console.log(`\n共 ${total} 项断言，失败 ${failed} 项。`);
if (failed > 0) {
  process.exitCode = 1;
}