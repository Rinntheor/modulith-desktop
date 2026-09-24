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

import { existsSync, readFileSync } from 'node:fs';
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
const demoTsx = read('../src-tauri/resources/sandbox-demo/plugin.js');

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
// 5. 演示插件的资源必须真的在
// ============================================================
//
// 它是 debug 构建里验证整条链路的那个实例。清单里指向的文件不存在的话，
// 症状是面板空白 + 日志里一行 404，而门禁全绿。

section('演示插件');

{
  const manifestPath = '../src-tauri/resources/sandbox-demo/manifest.json';
  check(exists(manifestPath), '演示插件的清单存在');

  if (exists(manifestPath)) {
    let manifest: { name?: string; main?: string; style?: string; permissions?: string[] } | null = null;
    try {
      manifest = JSON.parse(read(manifestPath));
    } catch (error) {
      check(false, `演示插件清单不是合法 JSON：${(error as Error).message}`);
    }

    if (manifest) {
      check(typeof manifest.main === 'string' && manifest.main.length > 0, '清单声明了 main');

      if (manifest.main) {
        check(
          exists(`../src-tauri/resources/sandbox-demo/${manifest.main}`),
          `清单指向的入口文件存在（${manifest.main}）`
        );
      }
      if (manifest.style) {
        check(
          exists(`../src-tauri/resources/sandbox-demo/${manifest.style}`),
          `清单指向的样式文件存在（${manifest.style}）`
        );
      }

      // 演示插件只该声明它真的会用到的那一项。
      check(
        Array.isArray(manifest.permissions) && manifest.permissions.length === 1,
        '演示插件只声明一项权限（它是验证工具，多声明等于把权限列表教坏）'
      );

      // `DEMO_ID` 与清单里的 `name` 必须一致。
      //
      // 不一致时**不会**有任何症状看起来像"id 写错了"：演示插件的 id 取自清单，
      // 而 debug 自检用它去算 webview 标签 —— 算出来的标签查不到注册表，
      // 于是表现为一次 403，日志里只有一句"请求的路径与所在 webview 不匹配"。
      const demoId = /pub const DEMO_ID:\s*&str\s*=\s*"([^"]+)"/.exec(sandboxRs)?.[1];
      check(demoId !== undefined, 'sandbox.rs 里能找到 DEMO_ID');
      check(
        demoId === manifest.name,
        `DEMO_ID 与清单的 name 一致（sandbox.rs=${JSON.stringify(demoId)}，清单=${JSON.stringify(manifest.name)}）`
      );
    }
  }
}

// ============================================================
// 6. 身份来自注册表，不是从标签反推
// ============================================================
//
// 插件 id 允许含 `.` `_` `-`，而标签的字符集更窄 —— 把 id 直接拼进标签会在
// `a.b` 与 `a-b` 之间产生歧义。真正的身份必须是注册表里那条记录。

section('身份来源');

{
  check(
    /state\.get\(label\)/.test(sandboxRs),
    'handle() 从注册表取插件（而不是解析标签前缀）'
  );
  check(
    /claimed != plugin\.id/.test(sandboxRs),
    '路径第一段必须与注册表给出的插件 id 相符'
  );
  check(
    /fn label_for/.test(sandboxRs) && /LABEL_PREFIX/.test(sandboxRs),
    '标签由 label_for 统一产出'
  );
  check(
    /冲突/.test(sandboxRs),
    '标签冲突被显式检测（否则两个插件里有一个会静默失效）'
  );
}

// ============================================================
// 7. 演示插件不依赖任何构建步骤
// ============================================================
//
// 它刻意用最朴素的写法：如果它跑不起来，问题一定在沙箱这一侧，而不是在打包工具链里。

section('演示插件的可诊断性');

{
  check(!/\bimport\s/.test(demoTsx), '演示插件没有 import（它是经典脚本，不是模块）');
  check(
    !/\brequire\(/.test(demoTsx),
    '演示插件没有 require（沙箱里没有 CommonJS）'
  );
  check(
    /window\.Modulith/.test(demoTsx),
    '演示插件通过 window.Modulith 与宿主通信'
  );
  check(
    /桥接层没有加载/.test(demoTsx),
    '演示插件在桥接层缺失时给出一句人话，而不是抛 undefined 的错'
  );
}

// ============================================================
// 收尾
// ============================================================

console.log(`\n共 ${total} 项断言，失败 ${failed} 项。`);
if (failed > 0) {
  process.exitCode = 1;
}
