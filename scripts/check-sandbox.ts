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
// 沙箱的安全性质由 `check:acl` 断言（没有任何 capability 把插件侧的窗口
// —— 现在只剩自检窗口那一个 `plugin-*` 标签 —— 纳入作用域、build.rs 必须有
// 应用级 ACL 清单）。这个脚本守的是**另一类**会静默失效的东西：那条通道本身。
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

/**
 * 剥掉行注释与块注释。
 *
 * **这一步不是可选的。** 门禁要找的每个词（`get_webview_window`、`add_child`、
 * `webview_label`、`SurfaceActor`）都恰好是本仓库里被**长篇解释过为什么不能用**的
 * 词。不剥注释的话，一份说明"不许这么写"的注释会把门禁判成违规，而修它的唯一
 * 办法是删掉注释 —— 于是最该留下的那份知识第一个消失。
 *
 * 定义放在最前面：从第 6 节起就要用它，而 `const` 有暂时性死区。
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const strip = stripComments;

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
  const quoted = ['__PLUGIN_ID__', '__PLUGIN_NAME__', '__PLUGIN_VERSION__', '__PLUGIN_HOST_VERSION__', '__PLUGIN_RUNTIME__', '__PLUGIN_ACTIVATION__'];
  for (const token of quoted) {
    const occurrences = bridgeJs.split(`'${token}'`).length - 1;
    check(occurrences === 1, `${token} 恰好出现一次（带引号的形式）`);
  }

  for (const token of ['__PLUGIN_PERMISSIONS__', '__PLUGIN_DATA_AVAILABLE__', '__PLUGIN_THEME__', '__PLUGIN_SHORTCUTS__']) {
    const occurrences = bridgeJs.split(token).length - 1;
    check(occurrences === 1, `${token} 恰好出现一次`);
  }

  // 模拟 `bridge_script` 的替换（Rust 侧用的是"替换全部"），确认一个记号都不剩。
  const rendered = bridgeJs
    .replaceAll("'__PLUGIN_ID__'", '"com.modulith.sandbox-demo"')
    .replaceAll("'__PLUGIN_NAME__'", '"沙箱演示插件"')
    .replaceAll("'__PLUGIN_VERSION__'", '"1.0.0"')
    .replaceAll("'__PLUGIN_HOST_VERSION__'", '"1.6.0"')
    .replaceAll("'__PLUGIN_RUNTIME__'", '"sandboxed"')
    .replaceAll("'__PLUGIN_ACTIVATION__'", '"open"')
    .replaceAll('__PLUGIN_PERMISSIONS__', '["storage"]')
    .replaceAll('__PLUGIN_DATA_AVAILABLE__', 'true')
    .replaceAll(
      '__PLUGIN_THEME__',
      '{"resolved":"dark","reduceMotion":false,"glass":true,"tokens":{"--accent-500":"hsl(243 80% 55%)"}}'
    )
    .replaceAll(
      '__PLUGIN_SHORTCUTS__',
      '{"entries":[{"id":"host.search","combo":"mod+k","normalized":"mod+k","description":"搜索","allowInInput":true}]}'
    );

  const leftover = [
    '__PLUGIN_ID__',
    '__PLUGIN_NAME__',
    '__PLUGIN_VERSION__',
    '__PLUGIN_HOST_VERSION__',
    '__PLUGIN_RUNTIME__',
    '__PLUGIN_ACTIVATION__',
    '__PLUGIN_PERMISSIONS__',
    '__PLUGIN_DATA_AVAILABLE__',
    '__PLUGIN_THEME__',
    '__PLUGIN_SHORTCUTS__',
  ].filter((token) => rendered.includes(token));

  check(
    leftover.length === 0,
    leftover.length === 0
      ? '替换之后没有残留的占位符（注释里也没有）'      : `替换之后仍有残留：${leftover.join('、')} —— 插件会读到字面量而不是自己的 id`
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

  // ---- 上面那几条是**在门禁里自己模拟替换**的，因此查不到"Rust 忘了替换" ----
  //
  // 变异 M18 就是这么漏过去的：把 `bridge_script` 里那一行 `.replace(...)` 删掉，
  // 上面每一条照样绿 —— 因为替换是门禁自己做的。而真实后果是那段脚本会把
  // 字面量 `'__PLUGIN_HOST_VERSION__'` 原样发给插件（debug 构建里 `debug_assert!`
  // 会 panic，release 构建里**静默**）。
  //
  // 判据因此改成"从桥接层**推导**出占位符全集，再要求 `bridge_script` 逐个替换"：
  // 将来加一个新占位符却忘了在 Rust 侧接线时，这条会直接点名。
  const declaredTokens = new Set(
    [...bridgeJs.matchAll(/__PLUGIN_[A-Z_]+__/g)].map((match) => match[0])
  );
  check(declaredTokens.size >= 11, `桥接层里声明了 ${declaredTokens.size} 个占位符`);

  const sandboxRsForTokens = read('../src-tauri/src/modules/plugins/sandbox.rs');
  const bridgeScriptFn =
    /fn bridge_script<R: Runtime>\([\s\S]*?\n\}/.exec(sandboxRsForTokens)?.[0] ?? '';
  check(bridgeScriptFn.length > 0, '能定位到 bridge_script 的函数体');

  // 判据必须锚在**真正的 `.replace(` 调用**上，而不是"这个函数体里出现过这个记号"。
  //
  // 变异 M18 教的一次：`bridge_script` 尾部那条 `debug_assert!` 里也写着
  // `!source.contains("__PLUGIN_HOST_VERSION__")` —— 于是把 `.replace(...)` 整行删掉
  // 之后，函数体里**仍然**有那个记号，宽松的判据照样绿。
  // 一个占位符被"提到"不等于被"替换"。
  const substituted = new Set(
    [...bridgeScriptFn.matchAll(/\.replace\(\s*["']?['"]?(__PLUGIN_[A-Z_]+__)/g)].map(
      (match) => match[1]
    )
  );

  const notSubstituted = [...declaredTokens].filter((token) => !substituted.has(token));
  check(
    notSubstituted.length === 0,
    notSubstituted.length === 0
      ? `bridge_script 逐个替换了全部 ${declaredTokens.size} 个占位符`
      : `★ bridge_script 没有替换这些占位符：${notSubstituted.join('、')} —— release 构建下它们会被原样发给插件`
  );
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
  // `page` 现在只是共用外壳的一个薄入口：真正的指令在 `page_with_frame` 里。
  //
  // 判据**必须锚在 `page_with_frame` 的函数体上**。从前它锚在 `page` 上，而
  // iframe 模型把 `page` 变成了两行转发 —— 于是整节 CSP 断言一起变绿（它们查的
  // 字符串一个字都不在 `page` 里了）。那正是"门禁静默变弱"的形状。
  const pageFn = /fn page_with_frame\([\s\S]*?\n}/.exec(sandboxRs);
  check(pageFn !== null, 'sandbox.rs 里能找到 page_with_frame()');

  if (pageFn) {
    const body = pageFn[0];
    for (const directive of [
      "default-src 'none'",
      'connect-src',
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      check(body.includes(directive), `CSP 里有 ${directive}`);
    }
    // `frame-src` 的值**必须来自参数**，不能写死。
    //
    // 两张文档要给出不同的值：插件文档是 `'none'`，自检页是 `ORIGIN`（它要把探针
    // 嵌进一个同源 iframe）。把 `page_with_frame` 里的参数写成字面量 `'none'`
    // 会让自检页的探针 iframe 加载不出来 —— 而症状是自检**永远报"探针没有回话"**，
    // 看起来像协议坏了。反过来写死成 `ORIGIN` 则会让插件文档也能嵌别的文档。
    check(
      /frame-src \{frame_src\}/.test(body),
      'frame-src 的值来自参数（两张文档的差别只有这一处实现）'
    );
  }

  // 插件文档**必须**是 `frame-src 'none'`：`page()` 把 `'none'` 写死传下去，
  // 插件因此不能嵌别的文档借它的来源发请求。
  const pageEntryFn = /fn page\(body: String[\s\S]*?\n}/.exec(sandboxRs)?.[0] ?? '';
  check(
    /page_with_frame\(body, script_and_style, "'none'"\)/.test(pageEntryFn),
    "插件文档经 page() 把 frame-src 定成 'none'（插件不能借别人的来源发请求）"
  );

  // 自检页是唯一的例外：它传 `ORIGIN`，因为探针必须是一个**同源 iframe**
  // 才能回答"真插件界面那个模型里到底有没有宿主 IPC"。
  const selftestFrame = /fn selftest_html\([\s\S]*?\n}/.exec(sandboxRs)?.[0] ?? '';
  check(
    /page_with_frame\(/.test(selftestFrame) && /\bORIGIN\b/.test(selftestFrame),
    '自检页把 frame-src 放开到 ORIGIN（它要嵌探针 iframe 才能回答"有没有宿主 IPC"）'
  );

  // `/<token>/probe` 必须真的有一条路由，否则自检页那个 iframe 只会拿到 404 ——
  // 而"探针没有回话"与"探针说没有 IPC"在自检结果里长得几乎一样。
  check(
    /\(\"GET\", Some\(\"probe\"\)\)\s*=>\s*selftest_html\(SELFTEST_PROBE_HTML\)/.test(sandboxRs),
    '自检页的探针有自己的一条路由（GET /<token>/probe）'
  );
  check(
    /const SELFTEST_PROBE_HTML: &str = include_str!\([\s\S]{0,80}?sandbox-selftest-probe\.html\"\)/.test(
      sandboxRs
    ) && exists('../src-tauri/resources/sandbox-selftest-probe.html'),
    '探针文档被编进二进制，且文件真的在仓库里'
  );

  // 宿主文档自己的 CSP 也必须允许这个来源。
  //
  // 漏掉这一条的表现是**全部插件界面一起空白**：插件 iframe 被**宿主**那份 CSP
  // 拦下，于是连文档都到不了协议处理器 —— 而协议那一侧的日志一条都不会有。
  // 这是"改一个地方、坏在另一个文件"的典型，因此单独钉一条。
  const tauriConf = JSON.parse(read('../src-tauri/tauri.conf.json')) as {
    app?: { security?: { csp?: { 'frame-src'?: string } } };
  };
  const hostFrameSrc = tauriConf.app?.security?.csp?.['frame-src'] ?? '';
  check(
    hostFrameSrc.includes('http://modulith-plugin.localhost'),
    `宿主 CSP 的 frame-src 允许插件来源（实际是 ${JSON.stringify(hostFrameSrc)}）—— 少了它每个插件界面都会被宿主自己的 CSP 拦成空白`
  );

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
    const body = entryFn[0];
    const bridge = body.indexOf('bridge.js');
    const main = body.indexOf('asset/{main}');
    check(bridge !== -1, '入口文档里加载了 bridge.js');
    check(main !== -1, '入口文档里加载了插件入口脚本');
    check(
      bridge !== -1 && main !== -1 && bridge < main,
      'bridge.js 排在插件入口脚本之前'
    );

    // 三个子资源（react.js / bridge.js / 插件入口）与样式表的地址里都必须带
    // **本界面的令牌**。地址是协议处理器唯一的身份来源：把令牌从地址里去掉，
    // 这三个子资源一个都加载不到，而症状是白面板 + 三条 403。
    const tokenUrls = [
      ...body.matchAll(/<script src="\/\{token\}\/(react\.js|bridge\.js|asset\/\{main\})">/g),
    ].map((match) => match[1]);
    check(
      tokenUrls.length === 3,
      tokenUrls.length === 3
        ? '三个脚本标签的地址第一段都是令牌'
        : `入口文档里带令牌的脚本标签只有 ${tokenUrls.length} 个（应当 3 个）—— 少了令牌的子资源会被协议处理器 403`
    );
    check(
      /<link rel="stylesheet" href="\/\{token\}\/asset\/\{rel\}">/.test(body),
      '样式表的地址同样带令牌（它是同一个协议处理器上的请求）'
    );
    // 反面：**不许**再按插件 id 拼地址。协议处理器只认令牌，按 id 拼出来的地址
    // 会被它拒掉，而资源与 RPC 会**一起**404。
    check(
      !/\/\{id\}\//.test(body),
      '入口文档不再按插件 id 拼地址（协议只认令牌，按 id 拼会全部 403）'
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
// **令牌 → 界面身份**一条映射，而它不可能与真源漂开：每次签发令牌都必须先通过
// `sandbox_view`，拿不到就签不出来 —— **没安装的插件构造上就拿不到界面**。

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
  //
  // **键从"webview 标签"变成了"令牌"，值仍然是 `SurfaceKey`（插件 + 界面）。**
  // 这是 iframe 模型带来的：iframe 没有自己的 webview 标签（`ctx.webview_label()`
  // 对全部插件界面都返回 `main`），继续拿标签当键会让全部插件塌成同一个身份。
  // 判据仍然只针对**形状**：它必须是一张字符串到身份的映射，不能长出字段来。
  check(
    /pub struct SandboxSurfaces\(RwLock<Registry>\)/.test(sandboxRs),
    'SandboxSurfaces 只映射「令牌 → 界面身份」，不存放插件的事实'
  );
  // 两张表必须关在**同一把锁**里。分开锁会出现"正向表说这个令牌属于 A、反向表说
  // A 的令牌是另一个"的瞬间 —— 而那个瞬间的表现是同一个界面被签发两个令牌，
  // 多出来的那个永远不会被回收，也就永远有效。
  const registryStruct = /struct Registry \{[\s\S]*?\n}/.exec(sandboxRs)?.[0] ?? '';
  check(
    /by_token: HashMap<String, SurfaceKey>/.test(registryStruct) &&
      /by_key: HashMap<SurfaceKey, String>/.test(registryStruct),
    '注册表同时有「令牌 → 身份」与「身份 → 令牌」两张表（后者是幂等的依据）'
  );
  // 反向：它不许长出任何"插件的事实"字段。这两条一起才排得掉"把整份清单塞进去"。
  const surfacesStruct = /pub struct SandboxSurfaces[\s\S]*?\n}/.exec(sandboxRs);
  check(
    surfacesStruct !== null && !/root|entry|permissions|manifest/.test(surfacesStruct[0]),
    'SandboxSurfaces 里没有根目录/入口/权限这类事实字段'
  );
  check(
    /pub struct SurfaceKey \{\s*\n\s*\/\/\/[^\n]*\n\s*pub plugin_id: String,\s*\n\s*\/\/\/[^\n]*\n\s*pub surface: String,/.test(
      sandboxRs
    ),
    'SurfaceKey 只有「插件 id + 界面 id」两个字段'
  );

  // 建界面的第一步必须是核实插件存在。
  //
  // 它**只签发一个令牌，不碰窗口系统**：从前的版本要创建一个子 webview，因此必须
  // 绕开主线程（那是一次整机假死）。现在这条路径上只有两次纯内存操作，而
  // "不能再创建 webview"这一条仍然要钉住 —— 把窗口创建加回来会让假死重新出现，
  // 而它的症状是"点开一个插件，整个应用不响应且一条错误都不报"。
  const openFn = /pub async fn open_surface<[\s\S]*?\n}/.exec(sandboxRs);
  check(openFn !== null, 'sandbox.rs 里有 open_surface()，且是 async');

  if (openFn) {
    const body = openFn[0];
    check(
      /sandbox_view\(/.test(body),
      'open_surface 先经 PluginManager 核实插件（这一步拿不到就什么都不建）'
    );
    check(
      body.indexOf('sandbox_view(') < body.indexOf('issue('),
      '核实排在签发令牌之前 —— 反过来的话，未安装的插件也能先拿到一块界面的凭据'
    );
    check(
      /needs_own_webview\(\)/.test(body),
      'open_surface 检查清单声明的是 sandboxed（否则 in-process 插件也能拿到界面）'
    );
    // 清单里没有的界面 id 必须在这里被拒，而不是签出一个服务 404 的令牌 ——
    // 后者在前端看起来是"插件界面一直白着"。
    check(
      /if view\.surface\(surface\)\.is_none\(\) \{[\s\S]{0,240}?return Err\(/.test(body),
      'open_surface 只签发清单里声明过的界面，否则直接报错'
    );
    // **这条是新的边界**：签发令牌这条路径上不许再出现窗口创建。
    check(
      !/WebviewWindowBuilder|add_child|\.show\(/.test(body),
      'open_surface 不创建任何窗口/webview（只签发令牌）—— 把它加回来就是那条整机假死的路'
    );
  }

  // 关界面时**必须**同时撤销两张表。只关文档而留着记录，下一次建界面会以为
  // "已经签过了"，于是一个已经不存在的 iframe 持有的令牌继续有效 ——
  // 那条令牌还读得到这个插件的数据。
  const closeFn = /pub fn close_surface<[\s\S]*?\n}/.exec(sandboxRs);
  check(closeFn !== null, 'sandbox.rs 里有 close_surface()');
  check(
    closeFn !== null && /forget\(/.test(closeFn[0]),
    'close_surface 撤销令牌（两处状态必须一起动）'
  );
  check(
    closeFn !== null && !/\.close\(/.test(closeFn[0]),
    'close_surface 不自己关窗口（iframe 的销毁是前端的事，宿主这一侧没有 DOM 可拆）'
  );
  // `forget` 本身必须**两张表一起删**：只删正向表的话，反向表里会留下一条
  // "这个身份已经有令牌"的记录 —— 下一次 `issue` 会把那个已经失效的令牌原样
  // 还回去，而它读不到任何东西（界面从此永远打不开）。
  const forgetFn = /pub\(super\) fn forget\([\s\S]*?\n    \}/.exec(sandboxRs)?.[0] ?? '';
  check(
    /by_token\.remove\(token\)/.test(forgetFn) && /by_key\.remove\(&key\)/.test(forgetFn),
    'forget 同时删掉两张表（只删一张会让失效的令牌被原样还回去）'
  );
  // 停用/卸载一个插件时，它的**全部**令牌都要收回，并且要拿到那些令牌去通知前端
  // 卸掉 iframe —— 所以返回的是令牌列表，不是一个计数。
  check(
    /pub\(super\) fn forget_plugin\(&self, plugin_id: &str\) -> Vec<String>/.test(sandboxRs),
    'forget_plugin 返回被撤销的令牌列表（调用方要靠它们让前端卸掉 iframe）'
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
  //
  // 它仍然是一个**真窗口**（`WebviewWindowBuilder`）："这个文档里有没有
  // `__TAURI_INTERNALS__`"只有在真 webview 里才问得出来 —— iframe 里那两个全局
  // 本来就按设计不存在，在那里问等于自问自答。
  const openSelftestFn = /pub fn open_selftest<[\s\S]*?\n}\n/.exec(sandboxRs);
  check(openSelftestFn !== null, 'sandbox.rs 里有 open_selftest()');
  check(
    openSelftestFn !== null && !/open_surface\(/.test(openSelftestFn[0]),
    '自检不给插件建界面（它只建自检页）'
  );
  // 自检窗口的令牌必须跟着窗口一起消失，而且**两条关闭路径都要挂**：
  // 页面里那个"关闭"按钮走 `request_selftest_close`，窗口右上角的 X 走窗口事件。
  // 只挂一条的话，另一条会留下一个仍然有效的令牌。
  check(
    /pub fn forget_selftest<[\s\S]*?forget_plugin\(SELFTEST_ID\)/.test(sandboxRs),
    'forget_selftest 收回自检令牌（按 SELFTEST_ID 收，不误伤真插件）'
  );
  check(
    /WindowEvent::Destroyed[\s\S]{0,200}?forget_selftest\(&handle\)/.test(sandboxRs),
    '自检窗口被 X 关掉时令牌也跟着收回（只挂页面里那个按钮的话，X 会留下一条仍有效的令牌）'
  );
  check(
    /surfaces\.issue\(key\)/.test(sandboxRs) && /SurfaceKey::new\(SELFTEST_ID/.test(sandboxRs),
    '自检页与真插件界面走**同一套**身份机制（不给它开小门）'
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

// ============================================================
// 6. 身份是**令牌**，不是标签，也不是路径里声称的插件 id
// ============================================================
//
// iframe 模型把身份的来源整个换掉了，这一节因此是全新的：
//
//   * iframe 没有自己的 webview 标签 —— `ctx.webview_label()` 对**全部**插件界面
//     都返回 `main`。拿它当身份会让所有插件塌成同一个插件，症状是"装上第二个
//     插件之后，它读到了第一个插件的数据"；
//   * URL 里也没有插件 id 可以撒谎（地址是 `/<令牌>/…`）。因此从前那条
//     "路径第一段必须与插件 id 相符"不再需要 —— 而且**不该**回来：它检查的是
//     一个攻击者本来就能写对的东西；
//   * 令牌是 `uuid` v4 的简单形式（32 个十六进制字符、122 位随机），**不能**由
//     插件 id 派生。派生出来的令牌是可猜的，而猜中一个就等于拿到了那个插件的
//     全部数据面（`data` 通道能读写的每一个字节）。

section('身份来源');

{
  // 令牌的形状：32 个十六进制字符。这条形状校验是**第一道闸门**（路径第一段完全
  // 来自外部），也是 `handle` 能安全地拿它去哈希之前唯一的代价。
  check(
    /pub\(super\) fn is_token\(token: &str\) -> bool \{\s*\n\s*token\.len\(\) == 32 && token\.bytes\(\)\.all\(\|b\| b\.is_ascii_hexdigit\(\)\)/.test(
      sandboxRs
    ),
    'is_token 先按形状挡一道（长度 32 + 全是十六进制字符）'
  );
  // 令牌必须来自密码学随机源，而不是由插件 id 拼出来。
  check(
    /uuid::Uuid::new_v4\(\)\.simple\(\)\.to_string\(\)/.test(sandboxRs),
    '令牌用 uuid v4 生成（122 位随机；由插件 id 派生的令牌是可猜的）'
  );
  const issueFn = /pub\(super\) fn issue\(&self, key: SurfaceKey\) -> String \{[\s\S]*?\n    \}/.exec(
    sandboxRs
  )?.[0] ?? '';
  check(
    /fn new_token\(\)/.test(sandboxRs) && /new_token\(\)/.test(issueFn),
    'issue 经 new_token() 生成（令牌的产生只有一处实现）'
  );
  // 幂等：同一个界面永远只拿到一个令牌。少了它，React 的重复渲染与 StrictMode
  // 的双调用会每次签发一个新令牌 —— 旧的那些永远不会被回收，也就永远有效，
  // 而它们对应的 iframe 早已不存在。
  check(
    /registry\.by_key\.get\(&key\)[\s\S]{0,120}?return token\.clone\(\)/.test(issueFn),
    'issue 是幂等的（同一界面复用同一个令牌，否则会攒下一堆没人看得见却仍然有效的凭据）'
  );
  // 碰撞检查：32 个十六进制字符的空间大到不会碰撞，但"不会"不是"不必检查"。
  check(
    /while registry\.by_token\.contains_key\(&token\)/.test(issueFn),
    'issue 对令牌碰撞做检查（一次碰撞的后果是两个插件共享一份数据）'
  );

  // `handle()`：令牌取自**路径第一段**，身份取自界面表。
  const handleFn = /async fn handle<R: Runtime>\([\s\S]*?\n}\n/.exec(sandboxRs)?.[0] ?? '';
  check(handleFn.length > 0, '能定位到 handle() 的函数体');
  check(
    /let token = segments\.first\(\)\.copied\(\)\.unwrap_or\(""\)/.test(handleFn),
    'handle() 从请求路径的第一段取令牌'
  );
  check(
    /if !is_token\(token\)/.test(handleFn) && /surfaces\.key_of\(token\)/.test(handleFn),
    'handle() 先判令牌形状，再用界面表把令牌换成身份（表里没有就是"不是插件界面"）'
  );
  // **identity 绝不来自 webview 标签。** 这一条是本文件里最值得单钉的一条：
  // iframe 模型下 `webview_label()` 恒为 `main`，用它当身份等于把所有插件
  // 合成一个。注释里提到它是允许的（那是说明为什么不能用），判据因此先剥注释。
  check(
    !/webview_label/.test(strip(handleFn)),
    'handle() 不看 webview_label（iframe 模型下它对全部插件界面都返回 main）'
  );
  // 旧设计那条"路径第一段必须等于插件 id"的检查**不许回来**：URL 里已经没有
  // 插件 id 可撒谎，而重新引入它只会给出一条"看起来在防护"的假判断。
  check(
    !/claimed != view\.id/.test(sandboxRs),
    '不再检查"路径第一段与插件 id 相符"（URL 里没有 id 可撒谎，那条检查是假的）'
  );
  // 界面名仍然要经清单核实，而不是从令牌那一侧信一个值过来。
  // 直接信会把"清单里已经删掉的界面"继续服务起来 —— 症状是"改了清单但界面还是旧的"。
  check(
    /let Some\(surface\) = view\.surface\(&key\.surface\) else \{[\s\S]{0,300}?return text\(404/.test(
      sandboxRs
    ),
    'handle() 用清单核实界面名，找不到就 404'
  );
  // 自检页那一条**也必须排在令牌校验之后**：它是宿主内置的，但把它公开给任何
  // 请求都读得到的地址没有好处。
  check(
    handleFn.indexOf('key_of(token)') < handleFn.indexOf('SELFTEST_ID'),
    '自检分支排在令牌校验之后（内置文档也不该有一条谁都能读到的地址）'
  );

  // ---- 标签一整套东西应当**消失** ----
  //
  // 从前标签是身份（`label_for` 产出、`claim` 检测冲突）。iframe 没有标签，
  // 于是那套机制整体删掉了。判据是它们**不在了** —— 留下来会让人以为身份
  // 还有一条按标签的路径，而下一个人照着它写就会重新踩那个"全部塌成一个"的坑。
  check(
    !/fn label_for\b/.test(sandboxRs) && !/fn label_for_surface/.test(sandboxRs),
    'label_for / label_for_surface 已删除（iframe 没有标签，身份不再从标签来）'
  );
  check(
    !/fn claim\b/.test(sandboxRs) && !/标签冲突/.test(sandboxRs),
    '标签冲突检测已删除（它检查的是一套不再存在的机制）'
  );
  // 真插件界面不再有窗口标签 —— 唯一还带 `plugin-` 前缀的标签是自检窗口，
  // 而它必须带着那个前缀：`capabilities/` 靠它把这类窗口排除在全部 IPC 之外。
  check(
    /pub const SELFTEST_LABEL: &str = "plugin-selftest";/.test(sandboxRs) &&
      !/format!\("\{LABEL_PREFIX\}/.test(sandboxRs),
    'SELFTEST_LABEL 是唯一还在拼出来的 plugin-* 窗口标签（真插件界面是 iframe，没有标签）'
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
 * 在一个文件里，剥掉注释之后含某个词的所有文件。
 *
 * `stripComments` / `strip` 定义在文件开头（第 6 节起就要用）。
 */
function filesContaining(needle: string, files: string[]): string[] {
  return files
    .filter((file) => stripComments(readFileSync(file, 'utf8')).includes(needle))
    .map(shortPath);
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
// 9. 现在只剩一个地方会创建窗口，而且只为自检窗口
// ============================================================
//
// 这一节从前守的是本仓库发生过的**最严重**的一次缺陷：整机假死。
//
// 现象：点开一个沙箱插件之后，其余插件全部失效，主窗口的关闭/最大化/最小化全部
// 没反应，托盘菜单同样没反应，而进程还活着、日志**戛然而止**、一条 ERROR 都没有。
//
// 真因是三条事实叠在一起：`Window::add_child` = `run_on_main_thread(闭包)` +
// `rx.recv()`（它**阻塞调用它的线程**）；`run_on_main_thread` 在已经身处主线程时
// 短路成**直接调用**；而 `#[tauri::command]` 的函数体在主线程上就地执行。
// 于是"同步命令里建 webview" = 在 WebView2 自己的事件回调里同步创建另一个
// WebView2 控制器，主线程从此不再回到事件循环。完整推导留在 git 历史里
// `surface.rs` 的文件头（那个文件已经删掉）。
//
// iframe 模型把整条路径拿掉了：插件界面是一块由 React 渲染的 `<iframe>`，
// **没有任何 Rust 代码去创建它**。于是"所有者线程"这套机制整体成为历史。
//
// 但"创建窗口"这件事没有消失，它剩下一处：**自检窗口**。这一节因此改成守那个
// 残留 —— 全仓只有 `sandbox.rs` 会建窗口，而且只为 `SELFTEST_LABEL` 建。
// 判据是"数出来只有一个"：这条边界失效的方向正是"下一个人顺手在别处又建了一个
// 窗口"，而它的代价仍然是主线程阻塞。

section('创建窗口的位置');

{
  const commandsRs = read('../src-tauri/src/modules/plugins/commands.rs');

  // ① `surface.rs` 已经删除。它存不存在是这一整节的前提：留着它，下一个人就会
  //    照着它的所有者线程模型继续写。
  check(
    !exists('../src-tauri/src/modules/plugins/surface.rs'),
    'plugins/surface.rs 已删除（插件界面不再由 Rust 创建）'
  );

  // ② `add_child` 全仓一处都不许有。它是那条整机假死路径的入口。
  const addChild = filesContaining('add_child', rustSources());
  check(
    addChild.length === 0,
    addChild.length === 0
      ? '全仓没有 add_child（插件界面是 iframe，不由 Rust 创建）'
      : `这些文件仍在用 add_child —— 它会阻塞调用它的线程：${addChild.join('、')}`
  );

  // ③ 所有者线程这套机制整体消失。判据落在源码（剥注释）上：留着它的名字会让人
  //    以为还有一条"只能在某个线程上做"的约束，而照着写就会重新踩回假死。
  check(
    !/SurfaceActor/.test(strip(sandboxRs)),
    'sandbox.rs 里没有 SurfaceActor（所有者线程这套机制整体消失）'
  );
  check(
    !/std::thread::spawn/.test(strip(sandboxRs)),
    'sandbox.rs 不起任何线程（签发令牌与建自检窗口都不需要）'
  );
  check(
    !/mpsc::channel::<Job>\(\)/.test(sandboxRs) && !/\bJob\b/.test(strip(sandboxRs)),
    'sandbox.rs 里没有作业队列（Job 是所有者线程的配套，一起删掉了）'
  );

  // ④ **全仓唯一创建窗口的地方**是 sandbox.rs 里的自检窗口。
  //
  //    这条是这一节的核：多一处就说明有人在别的地方建窗口，而那条路径可能正跑在
  //    主线程上 —— 那正是假死的形状。
  const windowBuilders = filesContaining('WebviewWindowBuilder', rustSources());
  check(
    windowBuilders.length === 1 && windowBuilders[0].endsWith('plugins/sandbox.rs'),
    windowBuilders.length === 1 && windowBuilders[0].endsWith('plugins/sandbox.rs')
      ? '全仓只有 plugins/sandbox.rs 会创建窗口'
      : `这些文件在创建窗口：${windowBuilders.join('、') || '（一处都没有，那也不对）'} —— 多出来的那处可能正跑在主线程上`
  );
  const builderCalls = (strip(sandboxRs).match(/WebviewWindowBuilder::new\s*\(/g) ?? []).length;
  check(
    builderCalls === 1,
    builderCalls === 1
      ? 'sandbox.rs 里只有一个窗口创建点'
      : `sandbox.rs 里有 ${builderCalls} 个窗口创建点，应当只有 1 个`
  );
  //    而那个创建点**必须**用 SELFTEST_LABEL：真插件界面是 iframe，没有任何一个
  //    属于它们的窗口标签。用别的标签建出来就是一个"没有 capability 归属"的窗口。
  check(
    /WebviewWindowBuilder::new\(app, SELFTEST_LABEL,/.test(sandboxRs),
    '那个窗口创建点用的是 SELFTEST_LABEL（真插件界面没有窗口，不该有别的标签）'
  );

  // ⑤ 宿主侧不许把线程钉住。`block_on` 会把调用它的线程钉在那里，而那个线程
  //    可能是主线程 —— 上一次就是它（在 open_surface_at 里读注册表）。
  const blockOn = filesContaining('block_on', rustSources().filter((f) => shortPath(f).includes('/plugins/')));
  check(
    blockOn.length === 0,
    blockOn.length === 0
      ? 'plugins 模块里没有 block_on（锁一律用 .await）'
      : `这些插件文件仍在 block_on —— 它会把调用线程钉住：${blockOn.join('、')}`
  );

  // ⑥ 也不许自己去投主线程消息。这条与 block_on 是同一类错误的两张面孔。
  const mainThread = filesContaining('run_on_main_thread', rustSources().filter((f) => shortPath(f).includes('/plugins/')));
  check(
    mainThread.length === 0,
    mainThread.length === 0
      ? 'plugins 模块里没有 run_on_main_thread'
      : `这些插件文件在直接投主线程消息：${mainThread.join('、')}`
  );

  // ⑦ 界面命令表：`open` 与 `close` 两条，都必须是 async。
  //
  //    同步命令的函数体在主线程上就地执行 —— 这不是风格问题，是当年那条假死的
  //    成因。`open` 现在只签发令牌、`close` 只撤销令牌，两条都不碰窗口系统，但
  //    "不许退回同步"这条约定没有理由松动：它们仍然读 `PluginManager`（一把
  //    tokio 锁），而同步地去等一把异步锁会把主线程钉住。
  //
  //    `hide` / `bounds` 已经删除：原生 webview 需要显隐与摆放，iframe 由 CSS
  //    决定这两件事。它们**不许回来** —— 命令还存在就说明有人以为界面还是原生层。
  for (const name of ['sandbox_surface_open', 'sandbox_surface_close', 'sandbox_self_test']) {
    check(
      new RegExp(`pub async fn ${name}\\b`).test(commandsRs),
      `${name} 是 async（同步命令的函数体在主线程上就地执行）`
    );
  }
  for (const name of ['sandbox_surface_hide', 'sandbox_surface_bounds']) {
    check(
      !new RegExp(`pub async fn ${name}\\b`).test(commandsRs),
      `${name} 已删除（iframe 的显隐与摆放由 CSS 决定，没有可隐藏/摆放的原生层）`
    );
  }
  // 命令定义删了、`generate_handler!` 里却还留着，是一个**只在运行期**才现形的
  // 缺陷：宿主会尝试注册一个不存在的命令名，而症状是"调用了不存在的命令" ——
  // 而那句话看起来像前端写错了命令名。因此登记表也要一起断言。
  const handlerList =
    /tauri::generate_handler!\[[\s\S]*?\n    \]/.exec(read('../src-tauri/src/lib.rs'))?.[0] ?? '';
  check(handlerList.length > 0, '能从 lib.rs 里定位到 generate_handler! 的命令登记表');
  for (const name of ['sandbox_surface_open', 'sandbox_surface_close', 'sandbox_self_test']) {
    check(
      new RegExp(`\\b${name},`).test(handlerList),
      `${name} 登记进了 generate_handler!（命令定义在那里，登记表也得有）`
    );
  }
  for (const name of ['sandbox_surface_hide', 'sandbox_surface_bounds']) {
    check(
      !new RegExp(`\\b${name},`).test(handlerList),
      `${name} 从 generate_handler! 里移除了（留着就是"调用了不存在的命令"）`
    );
  }

  // ⑧ `SandboxSurfaces` 必须真的被托管，协议必须真的被注册。忘了 manage 的话，
  //    每条命令都会回"沙箱界面表尚未就绪" —— 一个看起来像初始化顺序问题的错误。
  const generatorTs = read('../scripts/generate-backend-module.ts');
  check(
    /modules::plugins::sandbox::SandboxSurfaces::default\(\)/.test(generatorTs) &&
      /modules::plugins::sandbox::SandboxSurfaces::default\(\)/.test(read('../src-tauri/src/lib.rs')),
    'lib.rs（及其模板）托管了 SandboxSurfaces'
  );
  check(
    /modules::plugins::sandbox::register\(builder\)/.test(generatorTs) &&
      /modules::plugins::sandbox::register\(builder\)/.test(read('../src-tauri/src/lib.rs')),
    'lib.rs（及其模板）注册了沙箱协议（少了它每一条插件请求都到不了）'
  );
  //    而生成模板里不许再有所有者线程的托管：模板是"新模块生成出来长什么样"的
  //    依据，留着旧的那一行会让下一个人把它当成仍然需要的初始化。
  check(
    !/SurfaceActor::spawn/.test(strip(generatorTs)),
    '生成模板里不再托管 SurfaceActor'
  );
}

// ============================================================
// 10. 前端这一侧：隐藏与跟随
// ============================================================
//
// 这一节守的是前端与宿主之间那条**唯一的**协作契约：换一个令牌、把宿主推来的
// 消息转成 `postMessage`。它失效时不会有任何报错：
//
//   * 少了令牌转发 → 插件永远收不到主题/命令/事件，表现是"改了主题它不动"；
//   * `postMessage` 用了 `'*'` → 任何被嵌进来的文档在换过来源之后还收得到这条
//     消息，而那正是 `postMessage` 最常见的一类事故；
//   * iframe 少了 `sandbox` 属性 → 插件拿回弹窗、表单提交、顶层跳转这些出站路径。
//
// 而**从前那一整套几何逻辑整个消失了**：量矩形、跟随滚动、命中最上层元素。
// 那是原生 webview 时代的产物（它盖在 DOM 之上、不随 CSS 走）。iframe 就在这个
// 文档里，层级与位置由 CSS 决定。因此这一节也从"守几何"变成"守转发与边界"。

section('前端界面协作');

{
  const serviceTs = read('../src/services/sandboxSurface.ts');
  const componentTsx = read('../src/components/SandboxSurface.tsx');

  // ---- 门面：只剩这几件事 ----
  for (const fn of [
    'openSandboxSurface',
    'closeSandboxSurface',
    'runSandboxSelfTest',
    'subscribeSandboxPush',
    'postToSurface',
  ]) {
    check(
      new RegExp(`export function ${fn}\\b`).test(serviceTs),
      `门面暴露了 ${fn}`
    );
  }
  // 而几何那一整套**不许回来**。命令已经删掉，前端留着对应函数会让下一个人
  // 以为界面还是原生层，照着它写就会去要一个不存在的 IPC。
  for (const ghost of [
    'sandbox_surface_hide',
    'sandbox_surface_bounds',
    'hideSandboxSurface',
    'setSandboxSurfaceBounds',
    'measureSurface',
  ]) {
    check(
      !new RegExp(ghost).test(strip(serviceTs)) && !new RegExp(ghost).test(strip(componentTsx)),
      `${ghost} 已删除（iframe 的显隐与摆放由 CSS 决定，没有可隐藏/摆放的原生层）`
    );
  }

  // ---- 打开：必须把**界面名**传下去 ----
  //
  // 界面名走的是组件里的局部变量 `surfaceId`（它把缺省的 `main` 收在一处）。
  // 断言因此盯的是"那个变量被传下去了"，而不是某个具体的变量名。少了它，
  // 同一插件的两个界面会去要同一个主界面 —— 症状是"详情页显示的是列表"。
  check(
    /openSandboxSurface\(pluginId, surfaceId\)/.test(componentTsx),
    '打开时把界面名传给宿主（少了它每个界面都会退化成主界面）'
  );

  // ---- 关闭：认**令牌**，不认名字 ----
  //
  // 一个界面在"关掉又打开"之间会拿到不同的令牌。按名字关会让一次迟到的卸载
  // （StrictMode 的双调用、快速切标签）把**新开的那一块**关掉 —— 表现是
  // "界面开着却什么都读不到"。
  check(
    /closeSandboxSurface\(current\.token\)|closeSandboxSurface\(next\.token\)/.test(componentTsx),
    '关闭认令牌（认名字会让一次迟到的卸载关掉新开的那一块）'
  );
  check(
    !/closeSandboxSurface\(pluginId/.test(componentTsx),
    'SandboxSurface 不按插件 id 关（那会顺手销毁这个插件的兄弟界面）'
  );
  // 请求作废（组件卸载或参数变了）时，刚换到的凭据必须**还回去**。不还的话，
  // 宿主那一侧会留下一条指向不存在 iframe 的记录，而它仍然读得到这个插件的数据。
  check(
    /if \(cancelled\) \{[\s\S]{0,400}?closeSandboxSurface\(next\.token\)/.test(componentTsx),
    '请求作废时把刚拿到的令牌还回去（否则会留下一条仍然有效的凭据）'
  );

  // ---- 转发：按令牌挑订阅者，再 postMessage ----
  check(
    /subscribeSandboxPush\(/.test(componentTsx) && /push\.token !== current\.token/.test(componentTsx),
    '推送按令牌分发给对应的那一块界面（不分发的话主题会推给别的插件）'
  );
  check(
    /postToSurface\(frame\.current, current\.url, push\)/.test(componentTsx),
    '推送最终交给 postToSurface（Rust 够不到 iframe 的文档，只有这个文档能转发）'
  );
  // `close` 是一条**宿主撤销界面**的推送：前端必须把凭据清掉（iframe 随之从渲染树
  // 上消失），而不是把它当成一条普通消息转进文档。
  check(
    /if \(push\.channel === 'close'\)/.test(componentTsx) &&
      !/postToSurface[\s\S]{0,80}?'close'/.test(componentTsx),
    '`close` 由前端自己处理（清凭据、卸 iframe），不转进文档'
  );

  // ---- postToSurface 的 targetOrigin 必须是**算出来的** ----
  //
  // `'*'` 意味着"任何来源都收得到这条消息"。虽然这条消息本来就是发给那个 iframe 的，
  // 但 `'*'` 让任何被嵌进来的文档在换过来源之后还能收到它。
  check(
    /new URL\(url\)\.origin/.test(serviceTs),
    'postToSurface 从宿主给的地址里取出来源（指哪打哪）'
  );
  const postFn = /export function postToSurface\([\s\S]*?\n\}/.exec(serviceTs)?.[0] ?? '';
  check(
    /target\.postMessage\(\{ __modulith: true, channel: push\.channel, payload: push\.payload \}, origin\)/.test(
      postFn
    ),
    'postMessage 的 targetOrigin 是算出来的 origin，不是 \'*\''
  );
  check(
    !/postMessage\([^)]*,\s*'\*'\)/.test(postFn),
    "postToSurface **不**传 '*'（那会让换过来源的文档也收到这条消息）"
  );
  // 地址解析失败时必须**不发**：对着一个解析不出来的地址猜一个来源，比什么都不做更糟。
  check(
    /catch \{[\s\S]{0,240}?return;/.test(postFn),
    '地址解析不出来时直接放弃这条推送（猜一个来源比什么都不做更糟）'
  );

  // ---- 布局契约与 iframe 边界 ----
  const homeTsx = read('../src/pages/Home.tsx');

  const selector = /const PANEL_SELECTOR = '([^']+)'/.exec(componentTsx);
  check(selector !== null, 'SandboxSurface 声明了内容视口选择器');
  check(
    selector !== null && homeTsx.includes(selector[1]),
    selector !== null && homeTsx.includes(selector[1])
      ? `内容视口选择器 ${selector?.[1]} 在 Home.tsx 里真的存在（跨文件契约没漂）`
      : `SandboxSurface 依赖 ${selector?.[1]}，而 Home.tsx 里已经没有这个类名了 —— iframe 会铺满整个窗口`
  );
  // 容器必须 `absolute inset-0`：它相对的是最近的那个**定位**祖先，而
  // `.lc-tab-panel` 正是 `absolute inset-y-0` —— 因此它给出的是内容视口本身。
  // 换成 `h-full` 的话，父级 `div.p-8` 的高度由内容决定（内容为空 → 0），
  // 于是 iframe 塌成 0 高。实测撞到过：界面是 2240×1。
  check(
    /<div ref=\{holder\} className="absolute inset-0">/.test(componentTsx),
    '容器是 absolute inset-0（`h-full` 会因父级高度为 0 而塌掉）'
  );
  // **iframe 的 `sandbox` 属性是这一层的安全边界。** 没写出来的那些默认全部拒绝：
  // 表单提交、弹窗、模态框、顶层跳转、下载、指针锁定、自动播放。两条必须放开：
  // `allow-scripts`（插件代码本身）与 `allow-same-origin`（否则文档退化成不透明
  // 来源，连它自己那份 fetch 都算跨源）。少了 `sandbox` 属性 = 全部放开。
  check(
    /sandbox="allow-scripts allow-same-origin"/.test(componentTsx),
    'iframe 带着 sandbox="allow-scripts allow-same-origin"（少了它插件拿回弹窗/表单/顶层跳转）'
  );
  // 就绪信号必须是桥接层发回来的 `ready`，不是 iframe 的 `load`。
  // `load` 在一个**加载失败**的文档上照样会触发（引擎拿自己画的错误页触发它），
  // 用它判断成功会把"协议没接上 / 令牌被拒 / CSP 拦了自己"判成成功 ——
  // 而症状是一块永远白着的面板。
  check(
    /event\.source !== frame\.current\?\.contentWindow/.test(componentTsx) &&
      /data\.channel !== 'ready'/.test(componentTsx),
    '就绪判据是那块 iframe 发回来的 ready（`load` 在加载失败的文档上也会触发）'
  );
  // 两层覆盖：启动占位在下、失败说明在上，都是普通 DOM —— `z-10` / `z-20` 就够了。
  // 从前的原生 webview 盖在 DOM 之上，为了让它可见必须先把它显式收起来。
  check(
    /absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/.test(componentTsx),
    '启动占位用 z-10 盖在 iframe 上（两者都是普通 DOM，层级由 CSS 决定）'
  );
  check(
    /absolute inset-0 z-20 flex items-center justify-center bg-white p-6/.test(componentTsx),
    '失败说明用 z-20 盖在占位与 iframe 之上（白面板必须说出它为什么白）'
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
      .replaceAll("'__PLUGIN_HOST_VERSION__'", '"1.6.0"')
      .replaceAll("'__PLUGIN_SURFACE__'", '"detail"')
      .replaceAll("'__PLUGIN_RUNTIME__'", '"sandboxed"')
      .replaceAll("'__PLUGIN_ACTIVATION__'", '"open"')
      .replaceAll('__PLUGIN_PERMISSIONS__', '["storage","plugin-data","clipboard"]')
      .replaceAll('__PLUGIN_DATA_AVAILABLE__', 'true')
      .replaceAll(
        '__PLUGIN_SURFACES__',
        '[{"id":"main","name":"列表","primary":true},{"id":"detail","name":"详情","primary":false}]'
      )
      .replaceAll(
        '__PLUGIN_THEME__',
        '{"resolved":"light","reduceMotion":true,"glass":false,"tokens":{"--accent-500":"hsl(243 80% 55%)"}}'
      )
      .replaceAll(
        '__PLUGIN_SHORTCUTS__',
        '{"entries":[{"id":"host.search","combo":"mod+k","normalized":"mod+k","description":"搜索","allowInInput":true}]}'
      );

  const fakeWindow: Record<string, unknown> = {
    // 桥接层在文档消失时要跑清理函数；这条检查里没有真实的页面生命周期。
    addEventListener: () => {},
    // **令牌来自地址**：桥接层从 `location.pathname` 的第一段读出自己的令牌，
    // 再据此拼 RPC 与数据的地址。这个假窗口因此必须给一个地址 —— 少了它，
    // 整段脚本会在顶层抛一个 TypeError，而这一节会报成"桥接脚本执行失败"。
    location: { pathname: '/0123456789abcdef0123456789abcdef/' },
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
    check(api.plugin?.surface === 'detail', 'plugin.surface 是宿主注入的界面名');
    check(
      Array.isArray(api.surfaces) && api.surfaces.length === 2 && api.surfaces[1].id === 'detail',
      'surfaces 是清单声明的界面的投影（同步可读）'
    );
    check(
      api.surfaces?.[0]?.primary === true && api.surfaces?.[1]?.primary === false,
      'surfaces 如实标出哪一个是主界面'
    );
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

      // 3.2 数据 · 结构化（ctx.db）
      ['db.query', isFunction],
      ['db.queryRaw', isFunction],
      ['db.exec', isFunction],
      ['db.transaction', isFunction],

      // 3.3 网络
      ['http.fetch', isFunction],
      ['http.download', isFunction],

      // 3.4 界面（沙箱里没有 registerModule —— 沙箱插件自己就是界面）
      ['notifications.notify', isFunction],

      // 3.5 输入
      ['clipboard.read', isFunction],
      ['clipboard.write', isFunction],

      // 3.6 系统与集成
      ['events.emit', isFunction],
      ['events.on', isFunction],

      // 3.4 界面 · 宿主渲染的浮层
      ['ui.dialog', isFunction],
      ['ui.contextMenu', isFunction],

      // 3.4 界面 · 多界面（api: 3）
      ['ui.openSurface', isFunction],
      ['ui.closeSurface', isFunction],
      ['ui.listSurfaces', isFunction],

      // 3.4 界面 · 宿主渲染的状态指示（徽标 / 进度 / 启动占位）
      ['ui.badge', isFunction],
      ['ui.progress', isFunction],
      ['ui.splash', isFunction],

      // 3.6 系统与集成 · 命令（沙箱里是事件驱动的，见桥接层的说明）
      ['commands.on', isFunction],
      ['commands.has', isFunction],

      // 3.4 界面 · 主题
      ['theme.current', isFunction],
      ['theme.tokens', isFunction],
      ['theme.onChange', isFunction],

      // 3.5 输入 · 快捷键
      ['shortcuts.current', isFunction],
      ['shortcuts.refresh', isFunction],
      ['shortcuts.isTaken', isFunction],
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
    // 分支头可能是**或模式**（`"db.query" | "db.exec" => …`），因此这里先抓整行
    // 分支头，再从里面逐个取方法名。
    //
    // 只认**外层** match 的分支：它们的缩进是 8 个空格。不锚定缩进的话，
    // `"log"` 处理分支内部的日志级别分支（`"debug" =>` 等，缩进 16）会被
    // 当成三个不存在的 RPC 方法，于是这条断言自己制造三个假缺陷。
    //
    // 只看"整行都是字符串字面量与 `|`"的分支头 —— 这一条把 `_ => …` 与
    // 带其它模式的分支排除在外，而不是靠"第一个引号里是什么"去猜。
    const handled = new Set<string>();
    for (const arm of dispatch.matchAll(/^ {8}([^\n]+?)\s*=>/gm)) {
      const head = arm[1];
      if (!/^(?:"[a-zA-Z]+(?:\.[a-zA-Z]+)?"\s*\|\s*)*"[a-zA-Z]+(?:\.[a-zA-Z]+)?"\s*$/.test(head)) {
        continue;
      }
      for (const name of head.matchAll(/"([a-zA-Z]+(?:\.[a-zA-Z]+)?)"/g)) {
        handled.add(name[1]);
      }
    }

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
  //
  // 中间那一跳是 iframe 模型**独有**的：Rust 拿不到那个文档（跨源），因此它只
  // 发一条 Tauri 事件到主窗口，由前端按令牌找到 iframe 再 `postMessage` 进去。
  // 判据因此必须覆盖**两段**：宿主推了（`push_to` 带 `"theme"` 通道），
  // 以及它是由主题变化触发的。
  check(
    /set_plugin_theme[\s\S]{0,1600}?super::sandbox::apply_theme\(&app\)/.test(commandsRs),
    '主题变了会推给已经打开的插件界面（否则要关掉重开才生效）'
  );
  check(
    /for \(token, _key\) in surfaces\.live\(\)/.test(sandboxRs) &&
      /push_to\(app, &token, "theme", payload\.clone\(\)\)/.test(sandboxRs),
    '主题推送遍历全部活着的界面，逐条走 push_to 的 theme 通道'
  );

  // 推送方式是**换样式表文本**，不是重新加载界面。
  //
  // 重新加载会丢掉插件全部运行期状态（正在填的表单、滚动位置、展开的树）——
  // 用户只是切了一下明暗，不该因此丢掉正在做的事。
  //
  // 这一段现在在**桥接层**里（`PUSH_HANDLERS.theme`）：宿主推的是 `{css}`，
  // 桥接层把它写进 `<style id="modulith-theme">` 的文本。判据因此落在桥接层
  // 的 `textContent = payload.css` 上 —— 写成 `document.write` 或 `location.reload`
  // 是同一条"重新加载"的退化，而它不会有任何报错。
  check(
    /style\.textContent = payload\.css/.test(bridgeJs),
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
// 13. 快捷键：焦点在插件里时宿主按键仍然要生效
// ============================================================
//
// 焦点落进插件那块 iframe 之后，keydown 只在**插件自己的文档**里派发 ——
// 宿主文档上的监听器收不到（事件不跨文档边界）。因此这一整条链路必须是通的，
// 否则用户在插件里按 Ctrl+K / Ctrl+W / Ctrl+Tab 全都**一点反应都没有**，
// 而在宿主里是好的。

section('快捷键链路');

{
  const commandsRs = read('../src-tauri/src/modules/plugins/commands.rs');
  const rpcRs = read('../src-tauri/src/modules/plugins/rpc.rs');
  const shortcutsRs = read('../src-tauri/src/modules/plugins/shortcuts.rs');
  const syncTs = read('../src/services/pluginShortcutSync.ts');
  const mainTsx = read('../src/main.tsx');
  const registryTs = read('../src/services/shortcutRegistry.ts');

  // 环 1：宿主注册表 → 前端推给后端。**必须用 `normalized`**，不是 `combo`。
  //
  // 这是整条链路上最容易漂的一处：规范化规则在宿主注册表里，而桥接层拿它做
  // 匹配。两份规则漂开的表现是"某些组合在插件里按了没反应" —— 而宿主里是好的。
  check(
    /normalized: shortcut\.normalized/.test(syncTs),
    '推给宿主的是注册表**规范化**出来的组合键（不是原始写法）'
  );
  check(
    /installPluginShortcutSync\(\)/.test(mainTsx) && /subscribeShortcuts\(push\)/.test(syncTs),
    '快捷键同步装在启动路径上，且订阅了注册表变化（否则插件贡献的快捷键不会生效）'
  );

  // 环 2：后端 → 入口文档 + 已经打开的界面。
  check(
    /__PLUGIN_SHORTCUTS__/.test(sandboxRs) && /PluginShortcuts/.test(sandboxRs),
    '入口文档里注入了快捷键表'
  );
  check(
    /set_plugin_shortcuts[\s\S]{0,1600}?super::sandbox::apply_shortcuts\(&app\)/.test(commandsRs),
    '快捷键表变了会推给已经打开的插件界面'
  );
  // 与主题同一条两跳通道（宿主 → 前端 → iframe），通道名是 `shortcuts`。
  // 少了这一条，插件贡献的快捷键在**别的**插件界面里不会生效 —— 而两边都不会报错。
  check(
    /push_to\(app, &token, "shortcuts", payload\.clone\(\)\)/.test(sandboxRs) &&
      /window\.__modulithShortcutsChanged/.test(bridgeJs),
    '快捷键推送走 push_to 的 shortcuts 通道，并由桥接层交给插件'
  );

  // 环 3：桥接层的优先级 —— **插件自己的处理器先跑**。
  //
  // 挂在冒泡阶段（第三参数 false）时，插件在元素上注册的处理器已经跑过了，
  // 因此它调的 `preventDefault()` 我们看得到。挂在捕获阶段的话宿主永远赢，
  // 而一个编辑类插件需要能用 Ctrl+B 加粗。
  check(
    /addEventListener\('keydown', onKeyDown, false\)/.test(bridgeJs),
    '快捷键监听挂在**冒泡**阶段（捕获阶段会让宿主永远赢过插件自己的处理器）'
  );
  check(
    /if \(event\.defaultPrevented\) return;/.test(bridgeJs),
    '插件自己处理过的按键不转发（它的处理器优先）'
  );

  // 环 4：输入框里的规则由**宿主那条记录**说了算。
  //
  // 桥接层自己判断"正在打字就不转发"是错的：宿主有几条快捷键（Ctrl+K）
  // 是刻意在输入框里也生效的。
  check(
    /shortcut\.allowInInput/.test(bridgeJs),
    '输入框里是否生效由宿主的 allowInInput 决定，而不是桥接层自己猜'
  );

  // 环 5：规范化不能自己判断平台。
  check(
    /event\.ctrlKey \|\| event\.metaKey/.test(bridgeJs) && /parts\.push\('mod'\)/.test(bridgeJs),
    '桥接层把 Ctrl / Cmd 统一成 mod（与宿主同一套写法，不自己判断平台）'
  );

  // 环 6：执行仍然在宿主那一侧。
  check(
    /runShortcutByCombo\(normalized\)/.test(syncTs) && /runShortcutByCombo/.test(registryTs),
    '转发回来的按键由宿主的注册表执行（动作实现不在插件那一侧）'
  );

  // 环 7：**Rust 复核**。桥接层跑在插件文档里，而插件能改自己文档里的任何东西 ——
  // 只信它等于让插件可以触发任意一个"看起来像快捷键"的动作。
  check(
    /is_host_combo\(normalized\)/.test(rpcRs) && /fn is_host_combo/.test(shortcutsRs),
    'Rust 复核转发的组合确实是宿主的快捷键（桥接层跑在插件文档里，不可全信）'
  );

  // 表长有上限：它会被注入**每一个**插件文档，因此长度是一份乘数。
  check(
    /MAX_ENTRIES/.test(shortcutsRs) && /entries\.truncate\(MAX_ENTRIES\)/.test(shortcutsRs),
    '快捷键表有长度上限（它会被注入每一个插件文档）'
  );
}

// ============================================================
// 14. 宿主浮层：对话框与菜单由**独立的窗口**渲染
// ============================================================
//
// **这一节的前提在 iframe 模型里变了，但结论没变。**
//
// 从前浮层必须是独立窗口，是因为沙箱界面是一个原生子 webview、层级高于宿主文档
// 的任何元素 —— 宿主页面里画出来的浮层会被它整个盖住，z-index 写多大都没用。
// 那个理由现在不成立了：插件界面是一块同文档的 iframe。
//
// 窗口仍然保留，因为另外两条理由与渲染层无关：
//
//   * 浮层要能被摆在**主窗口之外**（`tray_menu::position_for` 那份纯函数定位逻辑
//     就是为它复用的），一个 DOM 组件做不到；
//   * 插件画不出宿主的对话框 —— 让它自己画等于让它**冒充宿主界面**。
//
// 因此下面每一条断言照旧成立：它守的是"配对、超时、尺寸、失焦"这四件只有
// 独立窗口才有的麻烦事，而它们与渲染层是哪一种无关。

section('宿主浮层');

{
  const viteConf = read('../vite.config.ts');
  const rpcRs = read('../src-tauri/src/modules/plugins/rpc.rs');
  const overlayRs = read('../src-tauri/src/modules/desktop/overlay.rs');
  const commandsRs = read('../src-tauri/src/modules/desktop/commands.rs');
  const overlayRoot = read('../src/overlay/OverlayRoot.tsx');
  const overlayHtmlExists = exists('../overlay.html');

  // 独立入口必须登记进 Vite 的多入口配置。
  //
  // 漏登记时**开发模式一切正常**（Vite 按 URL 提供任意 HTML），而发布版里
  // 这个窗口是空白的 —— 那正是托盘菜单曾经踩过的坑，注释里写着。
  check(overlayHtmlExists, 'overlay.html 存在（浮层是独立入口）');
  // 那个窗口必须**置顶**。主窗口里现在住着插件 iframe，而浮层要盖在它上面：
  // 少了 `alwaysOnTop`，浮层会跑到主窗口后面，用户看到的是"点了菜单什么都没出现"。
  {
    const conf = JSON.parse(read('../src-tauri/tauri.conf.json')) as {
      app?: { windows?: Array<{ label?: string; alwaysOnTop?: boolean; focus?: boolean }> };
    };
    const overlayWindow = (conf.app?.windows ?? []).find((w) => w.label === 'overlay');
    check(
      overlayWindow?.alwaysOnTop === true,
      '浮层窗口在 tauri.conf.json 里是 alwaysOnTop（否则它会跑到主窗口后面）'
    );
  }
  check(
    /overlay: path\.resolve\(__dirname, 'overlay\.html'\)/.test(viteConf),
    'overlay.html 登记进了 vite 的多入口（漏了的话发布版里这个窗口是空白的）'
  );

  // 请求/回答的配对与超时只有一份实现。
  check(
    /async fn ask_overlay/.test(rpcRs) &&
      // 两条分支各自**在自己的分支体里**调 `ask_overlay`。用"分支起点往后找
      // N 个字符"那种写法会随着分支里的说明文字变长而失效 —— 而它失效的方向是
      // 假红（明明没坏却报错），这一条已经因此误报过一次。
      /"ui\.dialog"[\s\S]{0,1200}?ask_overlay\(app, request\)\.await/.test(rpcRs) &&
      /"ui\.contextMenu" => \{[\s\S]*?ask_overlay\(app, request\)\.await/.test(rpcRs),
    '对话框与菜单走同一条配对/超时路径（两份实现会各自漂）'
  );

  // **必须有超时**：浮层没显示出来时，那条 await 会永远挂着 ——
  // 而插件作者看到的是"我的代码没问题，就是没反应"。
  check(
    /RESPONSE_TIMEOUT/.test(overlayRs) && /tokio::time::timeout\(RESPONSE_TIMEOUT/.test(overlayRs),
    '等待回答有超时（否则插件会永远挂着）'
  );

  // 显示失败必须**把登记撤掉**，否则那条等待只能靠超时结束。
  check(
    /if let Err\(error\) = show\(app, &request\)[\s\S]{0,400}?\.remove\(&id\)/.test(overlayRs),
    '浮层显示失败时撤销登记（否则等待只能靠超时结束）'
  );

  // 配对用的 id **由 overlay 分配**，不由调用方传。
  //
  // 两个调用方各自生成就有可能撞上，而撞上的表现是"回答给了另一次请求"——
  // 那比没有回答更糟：插件会拿到一个它没问过的结果。
  check(
    /self\.next_id\.fetch_add\(1, Ordering::SeqCst\)/.test(overlayRs) &&
      /match &mut request \{[\s\S]{0,300}?\*slot = id/.test(overlayRs),
    '配对 id 由 overlay 统一分配（两个来源会撞号）'
  );

  // 前端必须**先回答、后隐藏**。
  //
  // 反过来的话，隐藏会触发 `Focused(false)`，宿主在那条路径上把这次等待当成
  // "用户没回答"（dismissed）—— 于是用户点了「确定」，插件收到的却是"被放弃"。
  const answerFn = /async function answer\([\s\S]*?\n\}/.exec(overlayRoot);
  check(answerFn !== null, 'OverlayRoot 里有统一的上报入口');
  if (answerFn) {
    const reported = answerFn[0].indexOf("invoke('overlay_respond'");
    const dismissed = answerFn[0].indexOf("invoke('overlay_hide'");
    check(
      reported !== -1 && dismissed !== -1 && reported < dismissed,
      '先回答再隐藏（顺序反了会让「确定」被当成「被放弃」）'
    );
  }

  // 尺寸由**量的那一侧**量、由宿主设，且宿主会钳制。
  check(
    /invoke\('overlay_resize'/.test(overlayRoot) &&
      /width\.clamp\(MIN_WIDTH, MAX_WIDTH\)/.test(overlayRs),
    '尺寸由内容量、由宿主钳制（一个量错的尺寸不该让窗口消失或铺满屏幕）'
  );

  // 失焦必须收起，并把等待撤掉。
  check(
    /WindowEvent::Focused\(false\)/.test(overlayRs) && /cancel_all\(\)/.test(overlayRs),
    '浮层失焦时收起并撤销等待（否则它一直挡着，而等待只能靠超时结束）'
  );

  // 那三条命令必须在 `commands.rs` 里 —— 生成器只扫那个文件。
  //
  // 写在 `overlay.rs` 里会被 `AppManifest::commands` 收进去、却不会被
  // `generate_handler!` 注册，于是它在运行期表现为"调用了不存在的命令"。
  for (const command of ['overlay_respond', 'overlay_resize', 'overlay_hide']) {
    check(
      commandsRs.includes(`pub fn ${command}(`),
      `${command} 写在 desktop/commands.rs 里（生成器只扫那个文件）`
    );
    check(
      !overlayRs.includes(`pub fn ${command}(`),
      `${command} 没有同时留在 overlay.rs 里（两份会被生成器漏掉一份）`
    );
  }
}

// ============================================================
// 15. 多界面（`api: 3`）
// ============================================================
//
// 一个插件可以声明多个界面，每个界面一块自己的 iframe（各自一份令牌）。这一节
// 守的是那件事里**最容易悄悄退化**的几处：
//
//   * 打开界面**不由宿主建任何东西**，而是广播给前端（只有前端知道把它挂在哪）；
//   * 界面表的键是 `SurfaceKey`（插件 + 界面），不是插件 id；
//   * 次级界面登记成 `hidden` 模块，且**不**出现在任何列表里；
//   * 停用/卸载一个插件时，它开着的全部界面要一起消失。
//
// 从前这里还有两条关于**窗口标签**的（主界面标签不带 `#`、次级界面必须带界面名）。
// iframe 没有标签：那个 `#` 后缀现在只活在**模块 id** 里（`plugin:<插件>#<界面>`），
// 判据因此移到了下面那一条形状断言上。

section('多界面（api: 3）');

{
  const surfacesRs = read('../src-tauri/src/modules/plugins/surfaces.rs');
  const catalogTs = read('../src/services/moduleCatalog.ts');
  const surfacesTs = read('../src/services/pluginSurfaces.ts');
  const moduleRendererTsx = read('../src/components/ModuleRenderer.tsx');
  const mainTsx = read('../src/main.tsx');
  const rpcForSurfaces = read('../src-tauri/src/modules/plugins/rpc.rs');
  const pluginCommandsRs = read('../src-tauri/src/modules/plugins/commands.rs');
  const buildRs = read('../src-tauri/build.rs');
  const typesForSurfaces = read('../src-tauri/src/modules/plugins/types.rs');
  const contributionsTs = read('../src/services/pluginContributions.ts');
  const pluginRuntimeTs = read('../src/services/pluginRuntime.ts');

  // ---- 清单侧：主界面是必需的，而不是"第一个就是主界面" ----
  //
  // 顺序定义主界面的话，调整清单顺序就会改变那个 id —— 而"单界面插件的调用方
  // 一个字都不用改"这条保证、`Modulith.plugin.surface` 的取值、以及令牌注册表
  // 里那一份 `(插件, 界面)` 身份，全都建立在"主界面这个名字是稳定的"之上。
  check(
    /pub const PRIMARY_SURFACE: &str = "main"/.test(surfacesRs),
    '主界面 id 是一个具名常量，而不是散在代码里的字面量'
  );
  // 这两条**必须锚到控制流上**，不能只查"这句代码还在不在"。
  //
  // 试过一版只查错误消息文本的写法，结果是：把 `if !…{ return Err(…) }` 改成
  // `if false && !… { return Err(…) }` 之后，那句错误消息仍然在文件里，门禁
  // 照样绿 —— 而校验已经彻底失效了。判据因此落在"这个判断真的在 if 里、且
  // 里面真的返回了错误"上。
  //
  // 行为层的覆盖在 `surfaces.rs` 自己的单元测试里
  // （`a_surface_set_without_a_primary_is_rejected` 等）—— 静态这一条只是
  // 保证"那段代码没有被绕开"。
  check(
    /if !surfaces\.iter\(\)\.any\(SurfaceDecl::is_primary\) \{[\s\S]{0,240}?return Err\(/.test(
      surfacesRs
    ),
    '缺主界面时是**报错**，不是"拿第一个当主界面"'
  );
  check(
    /pub fn is_safe_surface_id/.test(surfacesRs) &&
      /if !is_safe_surface_id\(id\) \{[\s\S]{0,240}?return Err\(/.test(surfacesRs),
    '界面 id 有白名单，且该判断真的拦下了非法值'
  );
  check(
    /MAX_SURFACES/.test(surfacesRs) &&
      /if items\.len\(\) > MAX_SURFACES \{/.test(surfacesRs),
    '界面数量有上限'
  );
  // 入口路径的越界判断**复用**同一份实现。
  check(
    /use super::background_manifest::is_safe_relative;/.test(surfacesRs),
    '界面入口的路径判断复用 background_manifest 那一份（两套一定会漂）'
  );
  check(
    !/fn is_safe_relative/.test(surfacesRs),
    'surfaces.rs 里没有第二份 is_safe_relative'
  );

  // ---- 入口文档与桥接层：界面名必须真的传下去 ----
  check(
    /fn entry_document<R: Runtime>\([\s\S]{0,120}?surface: &super::surfaces::SurfaceDecl,/.test(
      sandboxRs
    ),
    '入口文档按界面声明渲染（而不是永远用主入口）'
  );
  check(
    /surface\.entry/.test(sandboxRs) && /&plugin\.main/.test(sandboxRs) === false,
    '入口文档用的是**这个界面**的入口脚本'
  );
  check(
    /'__PLUGIN_SURFACE__'/.test(bridgeJs) &&
      /__PLUGIN_SURFACES__/.test(bridgeJs) &&
      /__PLUGIN_SURFACE__/.test(sandboxRs) &&
      /__PLUGIN_SURFACES__/.test(sandboxRs),
    '桥接层把"我在哪个界面"与"我声明了哪些界面"同步交给插件'
  );
  // 占位符必须出现在 debug_assert 的那份名单里，否则漏替换不会被发现。
  check(
    /!source\.contains\("__PLUGIN_SURFACE__"\)/.test(sandboxRs) &&
      /!source\.contains\("__PLUGIN_SURFACES__"\)/.test(sandboxRs),
    '两个新占位符也在"替换干净"的断言名单里'
  );
  check(
    /surface: PLUGIN_SURFACE/.test(bridgeJs) && /surfaces: SURFACES/.test(bridgeJs),
    '插件顶层就能读到 plugin.surface 与 surfaces（不必先 await）'
  );

  // ---- 打开界面：**不由宿主建任何东西** ----
  //
  // 只有前端知道界面该挂在哪（标签栏多高、侧边栏是否展开、分屏开没开），
  // 而那件事现在是 CSS 布局：宿主在这一侧建就只能自己猜一个矩形。
  const openBranch = /"ui\.openSurface" => \{[\s\S]*?\n        \}/.exec(rpcForSurfaces);
  check(openBranch !== null, 'rpc.rs 里有 ui.openSurface 的分支');
  if (openBranch) {
    check(
      /app\.emit\(\s*OPEN_SURFACE/.test(openBranch[0]),
      'ui.openSurface 广播给前端（位置只有前端知道）'
    );
    check(
      !/open_surface_at/.test(openBranch[0]),
      'ui.openSurface **不自己建界面**（那样摆出来的位置是猜的）'
    );
    // 界面必须先在**当前**清单里，否则插件能要求打开一个不存在的界面，
    // 而宿主编出来的会是一块服务 404 的空面板。
    //
    // 判据锚在 `if … return rpc_error` 上，而不是"这句调用还在不在"：
    // 只查文本的话，`if false && view.surface(id).is_none()` 照样能过。
    check(
      /if view\.surface\(id\)\.is_none\(\) \{[\s\S]{0,240}?return rpc_error\(/.test(openBranch[0]),
      'ui.openSurface 先核实界面的确在清单里，不在就拒绝'
    );
  }
  check(
    /pub const OPEN_SURFACE: &str = "modulith:\/\/open-surface"/.test(rpcForSurfaces) &&
      /pub const CLOSE_SURFACE: &str = "modulith:\/\/close-surface"/.test(rpcForSurfaces),
    '打开/关闭界面各有一个具名事件，而不是就地拼字符串'
  );

  // ---- 前端那一侧 ----
  check(
    /listen<SurfaceRequest>\(OPEN_SURFACE/.test(surfacesTs) &&
      /listen<SurfaceRequest>\(CLOSE_SURFACE/.test(surfacesTs),
    '前端订阅了两个界面事件'
  );
  // 启动路径上的调用必须**真的没被注释掉** —— 只查 `installPluginSurfaceRequests()`
  // 这四个字的话，`// installPluginSurfaceRequests();` 照样能过。
  check(
    /^installPluginSurfaceRequests\(\);/m.test(mainTsx),
    '界面请求的监听真的装在启动路径上（否则 ui.openSurface 永远没反应）'
  );
  check(
    /openTab\(moduleId\)/.test(surfacesTs),
    '打开界面走的是标签（"宿主决定位置"就是这么实现的）'
  );

  // ---- 次级界面的模块 id 形状 ----
  //
  // 它必须与清单里声明的模块 id **不可能撞上**：撞上的表现是两个界面互相覆盖。
  check(
    /`plugin:\$\{pluginId\}#\$\{surface\}`/.test(surfacesTs),
    '次级界面模块 id 的形状是 plugin:<插件>#<界面>'
  );
  check(
    /MODULE_ID_RE/.test(contributionsTs) &&
      /\[A-Za-z0-9\]\[A-Za-z0-9._-\]\{0,63\}/.test(contributionsTs),
    '清单模块 id 的字符集里没有冒号与 #（这正是上面那条形状撞不上的依据）'
  );

  // ---- hidden 模块：能开，但不进任何列表 ----
  check(
    /hidden: true/.test(surfacesTs),
    '次级界面登记成 hidden 模块'
  );
  check(
    /filter\(\(mod\) => !mod\.hidden\)/.test(catalogTs),
    'getCatalogModules 过滤掉 hidden（否则次级界面会进侧边栏）'
  );
  check(
    /export function getCatalogFlatMap[\s\S]*?\n}/.test(catalogTs) &&
      !/hidden/.test(/export function getCatalogFlatMap[\s\S]*?\n}/.exec(catalogTs)?.[0] ?? ''),
    'getCatalogFlatMap **不过滤** hidden —— 按 id 打开必须找得到它'
  );
  check(
    /moduleDescriptor\.surface/.test(moduleRendererTsx),
    'ModuleRenderer 把界面名传给 SandboxSurface（少了它每个界面都会退化成主界面）'
  );

  // ---- 记账与清理 ----
  //
  // 次级界面模块**只能逐个移除**，不能走 `unregisterDynamicModules(插件)`：
  // 后者会顺手把清单里声明的模块也清掉，而那些在声明式插件重新加载时**必须**
  // 留着。这个区别是被 `check:plugin-runtime` 的"模块 ID 冲突"一节抓出来的。
  check(
    /unregisterDynamicModule\(moduleId\)/.test(surfacesTs) &&
      !/unregisterDynamicModules\(pluginId\)/.test(surfacesTs),
    '次级界面模块逐个移除，而不是按插件清（按插件清会顺手清掉清单里的模块）'
  );
  check(
    /^  clearSurfaceModules\(\);/m.test(pluginRuntimeTs),
    '重载全部插件时清掉次级界面的记账（否则会去开一个目录里不存在的 id）'
  );

  // ---- 界面表从宿主读，不在前端再解析一遍清单 ----
  check(
    /pub async fn plugin_surfaces\(/.test(pluginCommandsRs),
    'plugin_surfaces 命令存在（界面列表由宿主给出）'
  );
  check(
    /invoke<DeclaredSurface\[\]>\('plugin_surfaces'/.test(surfacesTs),
    '前端从宿主读界面表，而不是自己解析 contributes.surfaces'
  );
  // 判据要宽到能抓住**任何**形式的自己解析：`contributes.surfaces`、
  // `contributes?.surfaces`、`(x.contributes as any).surfaces`。
  // 只查前两种写法的话，第三种能过 —— 而它做的事完全一样。
  check(
    !/contributes[\s\S]{0,40}?\bsurfaces\b/.test(pluginRuntimeTs),
    'pluginRuntime 不自己解析清单里的界面表（那份规则只有 Rust 一处）'
  );
  check(
    buildRs.includes('"plugin_surfaces"') &&
      read('../src-tauri/capabilities/app-commands.json').includes('"allow-plugin-surfaces"'),
    'plugin_surfaces 进了应用级 ACL 清单并被授权（否则这条命令在运行期被拒）'
  );

  // ---- 停用/卸载插件：它开着的界面必须一起消失 ----
  //
  // 不关的话，那块 iframe 会继续留在屏幕上，而它属于一个"已经不存在的插件"：
  // 令牌被收回之后它的每一条请求都 403，用户看到几块再也刷不出来的空白面板，
  // 唯一的补救是重启应用。
  for (const [command, body] of [
    ['set_plugin_enabled', /pub async fn set_plugin_enabled\([\s\S]*?\n\}/.exec(pluginCommandsRs)?.[0] ?? ''],
    ['uninstall_plugin', /pub async fn uninstall_plugin\([\s\S]*?\n\}/.exec(pluginCommandsRs)?.[0] ?? ''],
  ] as Array<[string, string]>) {
    check(
      /close_all_surfaces\(&app, &id\)/.test(body),
      `${command} 会关掉这个插件还开着的界面（否则留下再也刷不出来的空白面板）`
    );
  }

  // ---- 清单里的模块可以指向某个界面 ----
  check(
    /surface: asOptionalString\(entry\.surface\)/.test(
      contributionsTs
    ),
    'contributes.modules[].surface 被读出来（模块据此指向某个界面）'
  );
  check(
    /surface: contribution\.surface/.test(pluginRuntimeTs),
    '模块描述符带上界面名'
  );
  // 被 `contributes.modules` 声明过的界面**不再**造隐藏模块 ——
  // 造了的话 `ui.openSurface` 会打开隐藏的那个，同一个界面于是有两块 iframe
  // （两份令牌、两份文档）。前端看到的是"点了没反应"，因为目标标签已经开着。
  check(
    /claimed/.test(surfacesTs) && /if \(claimed\.has\(surface\.id\)\) continue;/.test(surfacesTs),
    '已经被模块声明过的界面不再造隐藏模块（否则同一个界面会有两块 iframe）'
  );

  // 主界面不单独造隐藏模块：它已经由清单里的某一条模块代表了。
  check(
    /if \(surface\.primary\) continue;/.test(surfacesTs),
    '主界面不登记隐藏模块（它由 contributes.modules 里的那一条代表）'
  );

  // ---- `types.rs` 不该被这次改动无谓地牵动 ----
  //
  // `contributes.surfaces` 刻意留在自由形状的 `contributes` 里，而不是变成
  // `PluginManifest` 上的一个强类型字段：清单是外部输入，一个写错形状的 surfaces
  // 不该让**整个插件**不合法（那会让它连装都装不上）。
  check(
    /pub contributes: Option<serde_json::Value>/.test(typesForSurfaces),
    'contributes 仍然是自由形状（surfaces 的形状错误不该让整个插件不可用）'
  );
}




// ============================================================
// 16. 宿主渲染的状态指示与命令：徽标 / 进度 / 启动占位 / 声明式菜单项
// ============================================================
//
// 这一节守的是**"插件说的状态真的落到宿主界面上"**这条链。它每一环都能单独
// 坏掉，而坏掉的表现都是"什么都没发生"：
//
//   * 徽标 / 进度画在宿主的侧边栏与标签栏上，插件文档碰不到它们 ——
//     少接一环的表现是插件以为设了、用户什么都没看见；
//   * 启动占位是一层**普通 DOM**（`z-10`）盖在 iframe 上 —— 少一层的话，
//     症状是"点了插件，先看见一块空白，然后什么都没发生"；
//   * 清单声明的右键菜单项要经由**命令机制**执行，而沙箱里没有"交出函数"
//     这回事 —— 少一环的表现是"菜单里看得到、点了没反应"。

section('宿主渲染的状态指示与命令');

{
  const rpcUiRs = read('../src-tauri/src/modules/plugins/rpc.rs');
  const pluginCommandsForUi = read('../src-tauri/src/modules/plugins/commands.rs');
  const managerForUi = read('../src-tauri/src/modules/plugins/manager.rs');
  const surfaceTsx = read('../src/components/SandboxSurface.tsx');
  const uiStateTs = read('../src/services/pluginUiState.ts');
  const catalogForUi = read('../src/services/moduleCatalog.ts');
  const tabBarTsx = read('../src/components/Tabs/TabBar.tsx');
  const sidebarItemTsx = read('../src/components/Sidebar/SidebarItem.tsx');
  const mainTsxForUi = read('../src/main.tsx');
  const runtimeForUi = read('../src/services/pluginRuntime.ts');

  // ---- 三条 RPC 都在，且都走同一条广播 ----
  for (const method of ['ui.badge', 'ui.progress', 'ui.splash']) {
    check(
      new RegExp(`"${method.replace('.', '\\.')}" =>`).test(rpcUiRs),
      `rpc.rs 里有 ${method} 的处理分支`
    );
  }
  check(
    /pub const PLUGIN_UI: &str = "modulith:\/\/plugin-ui"/.test(rpcUiRs) &&
      /fn emit_ui_with/.test(rpcUiRs),
    '三条走同一条广播与同一个事件名（各开一个就要各写一遍校验）'
  );

  // ---- 进度的取值范围必须在宿主侧被拦下 ----
  //
  // 一个把 40 当成百分比写进去的插件会让进度条永远停在满格，而那种错误看起来像
  // "进度算错了" —— 离真正的原因很远。
  check(
    /if !\(0\.0\.\.=1\.0\)\.contains\(&fraction\) \{[\s\S]{0,240}?return rpc_error\(/.test(rpcUiRs),
    'ui.progress 拒绝落在 0..1 之外的值'
  );
  // "清掉"与"不定量"必须分得开。
  check(
    /\(None, None\) => Value::Null/.test(rpcUiRs),
    'ui.progress 把"清掉"与"不定量"分开（前者既没给 value 也没给 label）'
  );

  // ---- 徽标 / 占位的文本必须**按字符**截断 ----
  //
  // 按字节截断会把一个多字节字符切成两半，而那个半截字符在 JSON 里就是乱码 ——
  // 中文徽标会中招。
  check(
    /fn truncate\(value: &str, max_chars: usize\) -> String \{[\s\S]{0,300}?\.chars\(\)\.take\(/.test(
      rpcUiRs
    ),
    '徽标 / 占位文本按字符截断（按字节会切坏中文）'
  );
  check(
    /const MAX_BADGE_CHARS: usize = 28;/.test(rpcUiRs) && /const MAX_SPLASH_CHARS/.test(rpcUiRs),
    '徽标与占位各有长度上限（徽标过长会把模块名挤掉）'
  );

  // ---- 语气必须走白名单 ----
  //
  // 它会被前端拼进 `className`。
  check(
    /fn badge_tone\(args: &Value\) -> &'static str/.test(rpcUiRs) &&
      /fn splash_tone\(args: &Value\) -> &'static str/.test(rpcUiRs),
    '徽标与占位的语气各有一份白名单'
  );

  // ---- 后台插件调这三条必须被拒绝，而不是静默无效 ----
  //
  // 后台插件没有标签栏，也没有可覆盖的一块位置。静默成功会让作者以为它生效了。
  check(
    /let Some\(surface\) = surface else \{[\s\S]{0,320}?return rpc_error\(/.test(rpcUiRs),
    '没有界面上下文时（后台插件）三条都报错说清原因'
  );

  // ---- 命令把界面名一路传到签发那一步 ----
  //
  // 缺省值（主界面）只在 `commands.rs` 里写出来一次。两处不一致的表现是
  // "详情界面去要了主界面" —— 而两边的代码看起来都是对的。
  check(
    /surface\.unwrap_or_else\(super::surfaces::primary_surface\)/.test(pluginCommandsForUi) &&
      /super::sandbox::open_surface\(&app, &plugin_id, &surface\)/.test(pluginCommandsForUi),
    'sandbox_surface_open 把界面名传给 open_surface，缺省取主界面（缺省值只有一处实现）'
  );

  // ---- 启动占位：一层普通 DOM，不再是"先收起原生层" ----
  // 从前这里守的是"建 webview 时必须先把它收起来，否则占位被自己盖住"。iframe
  // 模型把那个机制整个拿掉了：占位与 iframe 都是普通 DOM，`z-10` 就够了。
  //
  // 但那条**顺序**仍然有意义，只是换了个理由：占位必须在换令牌**之前**立起来。
  // 反过来的话，从"命令回到前端"到"iframe 第一帧"之间会有一小段两者都没有的
  // 空窗 —— 那一次闪烁在慢机器上每次打开都能看见。
  check(
    /beginHostSplash\(pluginId, surfaceId\);[\s\S]{0,400}?openSandboxSurface\(pluginId, surfaceId\)/.test(
      surfaceTsx
    ),
    '先立占位、再去换令牌（顺序反了会闪一小段空白）'
  );
  // 占位的**唯一**判据是"宿主这一侧有一条属于它的记录"，没有第二个分支去
  // 决定 iframe 的可见性 —— iframe 的显隐归 CSS 管。
  check(
    /const \[splash, setSplash\] = useState\(\(\) => getPluginSplash\(pluginId, surfaceId\)\)/.test(
      surfaceTsx
    ),
    '占位由宿主状态（pluginUiState）驱动，不由 iframe 的 load 事件驱动'
  );
  check(
    /absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/.test(surfaceTsx),
    '占位铺满内容视口（`absolute inset-0` 相对的是 `.lc-tab-panel`）'
  );
  // 占位里那三条分支：定量进度、不定量进度、以及"插件自己接管过"的那一条。
  // 少一条的表现分别是"永远停在 0%"和"明明在动却显示成卡住"。
  check(
    /splash\.progress !== null && \(/.test(surfaceTsx) &&
      /splash\.progress === null && splash\.auto === false && \(/.test(surfaceTsx),
    '占位区分定量与不定量进度（画一条永远停在 0% 的定量条会让人以为卡住了）'
  );

  // ---- 自动清除与超时兜底 ----
  check(
    /addEventListener\('load'/.test(bridgeJs) &&
      /auto: true/.test(bridgeJs) &&
      /if \(splashClaimed\) return;/.test(bridgeJs),
    '桥接层在文档加载完后自动撤占位，但**插件接管过就不撤**'
  );
  check(
    /if \(event\.auto\) \{[\s\S]{0,240}?if \(current\?\.auto\) endSplash/.test(uiStateTs),
    '前端只在占位仍是"自动那一条"时才接受自动清除'
  );
  check(
    /export const SPLASH_TIMEOUT_MS = 8000;/.test(uiStateTs) &&
      /if \(alive\?\.auto\) endSplash/.test(uiStateTs),
    '自动占位有超时兜底，且超时同样**只对自动那条**生效'
  );
  check(
    /if \(current && !current\.auto\) return;/.test(uiStateTs),
    'beginHostSplash 不覆盖插件已经接管的占位'
  );

  // ---- 徽标 / 进度真的落到目录描述符上 ----
  //
  // 侧边栏与标签栏的渲染是**同步**路径，而插件调用是一次异步广播。
  check(
    /export function setModuleBadge\(/.test(catalogForUi) &&
      /export function setModuleProgress\(/.test(catalogForUi),
    '目录里有徽标与进度的写入点'
  );
  check(
    /for \(const moduleId of getPluginModuleIds\(pluginId\)\)/.test(uiStateTs),
    '徽标写给这个插件的每一条模块（含次级界面的隐藏模块 —— 它们也是标签）'
  );
  check(
    /function moduleIdsForSurface\(/.test(uiStateTs) &&
      /surfaceModuleId\(pluginId, surface\)/.test(uiStateTs),
    '进度按界面查模块（一个界面可以有好几个入口）'
  );
  // 判据要落在 **JSX 条件本身**上：只查 `descriptor?.badge` 四个字的话，
  // `{false && descriptor?.badge && (` 那种"就地停用"照样能过。
  check(
    /^      \{descriptor\?\.badge && \($/m.test(tabBarTsx) &&
      /^      \{descriptor\?\.progress && \($/m.test(tabBarTsx),
    '标签栏渲染徽标与进度（少一处就等于"插件设了但看不到"）'
  );
  check(
    /^            \{module\.badge && \($/m.test(sidebarItemTsx) &&
      /^      \{module\.progress && \($/m.test(sidebarItemTsx),
    '侧边栏渲染徽标与进度'
  );
  check(
    /badgeToneClasses/.test(tabBarTsx) && /badgeToneClasses/.test(sidebarItemTsx),
    '徽标语气真的影响颜色（否则四档语气没有区别）'
  );
  check(
    /progress\.value === null\s*\? 'w-1\/3 animate-pulse'/.test(tabBarTsx) &&
      /progress\.value === null[\s\S]{0,200}'w-1\/3 animate-pulse'/.test(sidebarItemTsx),
    '不定量进度画成来回跑的短条（画一条永远停在 0% 的定量条会让人以为卡住了）'
  );
  check(
    /^installPluginUiState\(\);/m.test(mainTsxForUi),
    '状态指示的监听真的装在启动路径上'
  );
  // 锚在 `unloadPlugin` 里：另外两处（加载失败、禁用）走的是同一条清理，
  // 只查"文件里有没有"的话，把卸载那条去掉照样能过。
  check(
    /export function unloadPlugin\(pluginId: string\): void \{[\s\S]{0,600}?clearPluginUiState\(pluginId\)/.test(
      runtimeForUi
    ),
    '插件卸载时清掉徽标与进度（否则侧边栏会一直显示一个没人更新的数字）'
  );

  // ---- 清单声明的右键菜单项 ----
  check(
    /pub fn context_menus\(&self, id: &str\)/.test(managerForUi) &&
      /pub struct DeclaredMenuItem/.test(managerForUi),
    '宿主读得出清单里声明的右键菜单项'
  );
  check(
    /const DECLARED_PREFIX: &str = "declared:";/.test(rpcUiRs) &&
      /format!\("\{DECLARED_PREFIX\}\{\}", menu\.id\)/.test(rpcUiRs),
    '声明条目带上专用 id 前缀（不加会与插件临时给的条目撞 id）'
  );
  check(
    /\.unwrap_or\(true\)/.test(
      /let include_declared = args[\s\S]{0,240}?;/.exec(rpcUiRs)?.[0] ?? ''
    ),
    'includeDeclared 缺省是 **true** —— 否则清单里那一块永远用不上'
  );
  // 沙箱插件的命令跨不了 realm，只能推给它的界面。
  //
  // 从前这条推送是 `eval` 一段 `window.__modulithCommand(JSON.parse(…))` 进插件
  // webview。跨源 iframe 没有那条路 —— 现在它走 `push_to` 的 `command` 通道，
  // 由前端转成 `postMessage`，桥接层再交给 `__modulithCommand`。
  // 判据因此必须覆盖**两端**：宿主推的是哪条通道，以及桥接层接的是哪个函数。
  const deliverCommandFn =
    /pub async fn deliver_command<R: Runtime>\([\s\S]*?\n}\n/.exec(sandboxRs)?.[0] ?? '';
  check(deliverCommandFn.length > 0, '能定位到 deliver_command 的函数体');
  check(
    /push_to\(app, &token, "command", payload\.clone\(\)\)/.test(deliverCommandFn),
    '沙箱插件的命令经 push_to 的 command 通道推给它的界面'
  );
  // 命令名来自清单（外部输入），因此必须**包成 JSON** 而不是拼进源码。
  // `eval` 时代这条是注入防线；现在没有"拼"这一步，但"数据不经字符串拼接"
  // 这条约定仍然值得钉住 —— 它决定了将来加一条推送时不必再考虑转义。
  check(
    /serde_json::json!\(\{ "command": command \}\)/.test(deliverCommandFn),
    '命令名包成 JSON，不拼进源码（拼源码那条路在 eval 时代才需要转义）'
  );
  // 只推给**这个插件**的界面；给了 `only` 时再收窄到那一块。
  // 少了插件的过滤，一条命令会送进每一个打开着的插件 —— 那是一个跨插件的越权。
  check(
    /if key\.plugin_id != plugin_id \{[\s\S]{0,80}?continue;/.test(deliverCommandFn) &&
      /if key\.surface != only \{[\s\S]{0,80}?continue;/.test(deliverCommandFn),
    '命令只推给这个插件的界面（给了 only 时再收窄到那一块）'
  );
  check(
    /super::sandbox::deliver_command\(app, plugin_id, &command, surface\)/.test(rpcUiRs),
    '选中声明条目时，沙箱插件走推送、不试图直接调用'
  );
  check(
    /pub const PLUGIN_COMMAND: &str = "modulith:\/\/plugin-command"/.test(rpcUiRs) &&
      /^installPluginCommandDispatch\(\);/m.test(mainTsxForUi),
    'in-process 插件的命令走一条广播（Rust 碰不到它 realm 里的函数）'
  );
  check(
    /commands\.on: function|on: function \(id, handler\)/.test(bridgeJs) &&
      /window\.__modulithCommand = function/.test(bridgeJs),
    '桥接层给出命令的注册入口'
  );
  // 桥接层的 `command` 推送处理器必须真的把它交给那个注册入口 —— 少了这一句，
  // 推送到了但谁也不处理，症状与"宿主根本没推"完全一样。
  check(
    /command: function \(payload\) \{[\s\S]{0,200}?window\.__modulithCommand\(payload\)/.test(bridgeJs),
    '桥接层的 command 推送处理器把负载交给注册入口'
  );
  check(
    /commands: commands,/.test(bridgeJs),
    'commands 真的挂在 Modulith 上'
  );
  check(
    /includeDeclared: options0\.includeDeclared === undefined \? true : !!options0\.includeDeclared/.test(
      bridgeJs
    ),
    '桥接层把 includeDeclared 的缺省也说成 true（与宿主一致）'
  );
}




// ============================================================
// 17. `ctx.db`：每插件一个 SQLite，边界在引擎里
// ============================================================
//
// 这一节守的是**"边界没有被搬到 SQL 文本上"**。那是一个很自然的退化方向：
// 谁都想在 RPC 那一层加一句 `if sql.contains("ATTACH")` —— 而它挡不住注释、
// 大小写与字符串字面量，同时会让人以为已经拦住了。
//
// 因此这里断言的几乎全是"**引擎层那几件东西还在**"：
// authorizer 装了、`ATTACH` 被拒、危险 PRAGMA 被拒、页数上限由引擎执行、
// 一次调用只编译一条语句。行为层的另一半由 `db.rs` 自己的单元测试守
// （12 个，其中 3 个是直接向引擎发难的那种）。

section('插件数据库（ctx.db）');

{
  const dbRs = read('../src-tauri/src/modules/plugins/db.rs');
  const managerForDb = read('../src-tauri/src/modules/plugins/manager.rs');
  const rpcForDb = read('../src-tauri/src/modules/plugins/rpc.rs');
  const pluginCommandsForDb = read('../src-tauri/src/modules/plugins/commands.rs');
  const cargoToml = read('../src-tauri/Cargo.toml');
  const runtimeForDb = read('../src/services/pluginRuntime.ts');

  // ---- 依赖：bundled 与 hooks 各是为什么 ----
  check(
    /rusqlite = \{ version = "[^"]+", features = \["bundled", "hooks"\] \}/.test(cargoToml),
    'rusqlite 带 bundled（用户机器上不需要任何前置条件）与 hooks（authorizer 的前提）'
  );

  // ---- 边界：引擎级，不是文本级 ----
  check(
    /fn install_authorizer/.test(dbRs) && /\.authorizer\(Some\(/.test(dbRs),
    '连接上真的装了 authorizer'
  );
  check(
    /AuthAction::Attach \{ \.\. \} \| AuthAction::Detach \{ \.\. \} => Authorization::Deny/.test(dbRs),
    'ATTACH / DETACH 由引擎拒绝（文本过滤挡不住注释、大小写与字符串字面量）'
  );
  check(
    /fn is_reserved_pragma/.test(dbRs) && /if pragma_value\.is_some\(\) && is_reserved_pragma/.test(dbRs),
    '保留的 PRAGMA 只在**设值**时被拒（拦掉读取会让插件问一下页大小就失败）'
  );
  // 这几条**必须圈到函数体里**。全文件找的话，文件里的说明文字与单元测试里的
  // 字符串字面量都会命中 —— 而它们在被改坏之后**照样在**，于是断言恒为真。
  // 第一轮变异验证里，这一节有五条断言正是这么假绿的。
  const budgetFn = /fn budget_bytes\(\) -> u64 \{[\s\S]*?\n\}/.exec(dbRs)?.[0] ?? '';
  check(
    /const DB_BUDGET_SHARE: u64 = 2;/.test(dbRs) &&
      /super::data_dir::MAX_TOTAL_BYTES \/ DB_BUDGET_SHARE/.test(budgetFn),
    '数据库预算取数据目录配额的一份，而不是另起一个数字'
  );
  const limitsFn = /fn apply_limits\([\s\S]*?\n\}/.exec(dbRs)?.[0] ?? '';
  check(
    /PRAGMA max_page_count = \{max_pages\};/.test(limitsFn) && /div_ceil\(page_size\)/.test(limitsFn),
    '页数上限交给引擎执行（写满时 SQLITE_FULL，而不是先写满磁盘）'
  );
  // 顺序：先设限制再装规则。反过来宿主自己那句 `PRAGMA max_page_count=` 会被自己的规则拦下。
  check(
    /apply_limits\(&connection, budget_bytes\)\?;\s*\n\s*install_authorizer\(&connection\)\?;/.test(dbRs),
    '先设限制、再装规则（顺序反了数据库根本打不开）'
  );
  check(
    /execute_batch\("PRAGMA foreign_keys = ON;"\)/.test(limitsFn),
    '外键默认打开（SQLite 的历史缺省是关，而"删了父行子行还在"看起来像数据库不守规矩）'
  );
  // `writable_schema` 在保留名单里，因此那条"拒绝写 sqlite_master"的规则是多余的 ——
  // 而它**有害**：SQLite 自己的 CREATE TABLE 也以 sqlite_master 的 UPDATE 上报，
  // 按动作类型区分不了，于是它把整个数据库变成只读的。
  check(
    /"writable_schema"/.test(dbRs) && !/eq_ignore_ascii_case\("sqlite_master"\)/.test(dbRs),
    '靠保留 writable_schema 挡住改表结构，而不是"拒绝所有 sqlite_master 写入"'
  );
  const authorizerFn = /fn install_authorizer\([\s\S]*?\n\}/.exec(dbRs)?.[0] ?? '';
  check(
    /eq_ignore_ascii_case\("load_extension"\)/.test(authorizerFn),
    'load_extension 被拒绝（它在插件里再开一个没有边界的洞）'
  );

  // ---- 一次调用只编译一条语句 ----
  check(
    /prepare\(sql\)\.map_err\(\|e\| sql_error\("编译", sql, e\)\)/.test(dbRs),
    '一次调用只 prepare 一条语句（多条由 rusqlite 报 MultipleStatement）'
  );

  // ---- 阻塞调用不许落在异步线程上 ----
  const runFn = /async fn run<T, F>\([\s\S]*?\n    \}/.exec(dbRs)?.[0] ?? '';
  check(
    /tokio::task::spawn_blocking\(move \|\| \{/.test(runFn),
    'SQLite 调用走 spawn_blocking（直接在异步线程上会把整个宿主的调度钉住）'
  );
  check(
    /let mut guard = connection\.lock\(\)\.unwrap_or_else\(\|e\| e\.into_inner\(\)\);/.test(dbRs),
    '锁在阻塞线程里拿，且不因为一次 panic 让这个插件的数据库永久不可用'
  );

  // ---- 事务：边界必须在一次调用之内 ----
  const transactionFn = /fn run_transaction\([\s\S]*?\n\}/.exec(dbRs)?.[0] ?? '';
  check(
    /\.commit\(\)/.test(transactionFn) && /\.transaction\(\)/.test(transactionFn),
    'transaction 在一次调用里 commit（Drop 会回滚，因此中途失败自动全回滚）'
  );
  check(
    !/pub async fn begin\(/.test(dbRs) && !/pub async fn commit\(/.test(dbRs),
    '没有跨调用的 begin/commit —— 那是会泄漏的写事务状态'
  );

  // ---- 文件在插件自己的数据目录里 ----
  check(
    /pub fn database_path\(&self, id: &str\) -> PluginResult<PathBuf>/.test(managerForDb) &&
      /self\.checked_data_dir\(id\)\?/.test(
        /pub fn database_path\(&self, id: &str\) -> PluginResult<PathBuf> \{[\s\S]*?\n    \}/.exec(
          managerForDb
        )?.[0] ?? ''
      ),
    '数据库文件路径经 checked_data_dir（顺带强制 plugin-data 权限与数据根可用）'
  );
  // 判据落在**代码**上，不是注释上：文件里刻意写了一段"为什么不用 URI"的说明，
  // 而只查 `!/SQLITE_OPEN_URI/` 会把那句说明当成违规。
  check(
    /OpenFlags::SQLITE_OPEN_READ_WRITE \| OpenFlags::SQLITE_OPEN_CREATE/.test(dbRs) &&
      !/OpenFlags::SQLITE_OPEN_URI/.test(dbRs),
    '打开连接不带 URI 语义（路径是宿主拼的，不该有再解释一次的余地）'
  );

  // ---- 一条实现，两个调用方 ----
  check(
    /super::db::PluginDatabases/.test(rpcForDb) && /super::db::PluginDatabases/.test(pluginCommandsForDb),
    '沙箱协议与 Tauri 命令都转给同一个 PluginDatabases'
  );
  check(
    !/rusqlite/.test(rpcForDb) && !/rusqlite/.test(pluginCommandsForDb),
    'rpc.rs 与 commands.rs 里没有第二份 SQLite 用法（边界只有 db.rs 一处）'
  );
  check(
    /pub async fn plugin_db_query\(/.test(pluginCommandsForDb) &&
      /pub async fn plugin_db_exec\(/.test(pluginCommandsForDb) &&
      /pub async fn plugin_db_transaction\(/.test(pluginCommandsForDb),
    'in-process 插件那三条命令存在'
  );
  const buildForDb = read('../src-tauri/build.rs');
  const capabilityForDb = read('../src-tauri/capabilities/app-commands.json');
  check(
    buildForDb.includes('"plugin_db_query"') &&
      buildForDb.includes('"plugin_db_exec"') &&
      buildForDb.includes('"plugin_db_transaction"') &&
      capabilityForDb.includes('"allow-plugin-db-query"'),
    '三条命令进了应用级 ACL 清单并被授权'
  );

  // ---- 停用 / 卸载：放掉连接，但**不删文件** ----
  check(
    /fn close_database\(app: &AppHandle, id: &str\)/.test(pluginCommandsForDb) &&
      /databases\.close\(id\)/.test(pluginCommandsForDb),
    '停用 / 卸载时放掉数据库连接'
  );
  check(
    !/remove_dir_all/.test(
      /fn close_database\(app: &AppHandle, id: &str\)[\s\S]*?\n\}/.exec(pluginCommandsForDb)?.[0] ?? ''
    ),
    'close_database 只关连接、不删文件（§6：卸载删代码、保留数据）'
  );

  // ---- 数据库文件是**保留名**：不能穿过 ctx.dataDir 覆盖或删掉它 ----
  //
  // 那个文件是引擎掌握的：写一段普通内容进去会让整个库变成 "file is not a
  // database"，而插件自己一点数据都取不回来 —— 那是不可逆的。
  // 判据是 `db::is_reserved_data_path` 这条纯函数（它有单元测试），
  // 而 `manager` 只负责把"是保留名"翻成一句能指路的话。
  const rejectFn =
    /fn reject_reserved_data_path\([\s\S]*?\n    \}/.exec(managerForDb)?.[0] ?? '';
  check(
    /super::db::is_reserved_data_path\(rel\)/.test(rejectFn),
    '保留名判定复用 db.rs 里那一条（两份实现一定会漂）'
  );
  check(
    /fn is_reserved_data_path\(rel: &str\) -> bool \{[\s\S]{0,400}?eq_ignore_ascii_case\(DB_FILE_NAME\)/.test(
      dbRs
    ),
    '保留名判定按大小写不敏感比较（Windows 上 plugin.DB 打开的是同一个文件）'
  );
  check(
    /trim_end_matches\(\[' ', '\.'\]\)/.test(dbRs),
    '保留名判定把末尾的空格与点去掉（Windows 会静默丢掉它们）'
  );
  const writeFn = /pub fn data_write\([\s\S]*?\n    \}/.exec(managerForDb)?.[0] ?? '';
  const removeFn = /pub fn data_remove\([\s\S]*?\n    \}/.exec(managerForDb)?.[0] ?? '';
  check(
    /self\.reject_reserved_data_path\(rel\)\?;/.test(writeFn) &&
      /self\.reject_reserved_data_path\(rel\)\?;/.test(removeFn),
    'data_write 与 data_remove 都拒绝保留名'
  );
  check(
    !/self\.reject_reserved_data_path/.test(
      /pub fn data_read\([\s\S]*?\n    \}/.exec(managerForDb)?.[0] ?? ''
    ),
    'data_read 不拒绝保留名（备份数据库应当在损坏之前就能做）'
  );

  // ---- 两侧的成员名必须一致 ----
  //
  // 同一个插件应该能在 in-process 与 sandboxed 之间切换而不改一行代码。
  //
  // 判据先**把两侧的实现各自圈出来**再找方法名：全文件找 `query` 那种写法会
  // 被 `plugin_db_query`（命令名里就有 query）之类的东西命中，于是断言恒为真。
  const inProcessDb = /function pluginDatabase\([\s\S]*?\n\}/.exec(runtimeForDb)?.[0] ?? '';
  const sandboxDb = /var db = \{[\s\S]*?\n    \};/.exec(bridgeJs)?.[0] ?? '';
  check(inProcessDb.length > 0 && sandboxDb.length > 0, '两侧的 db 实现都能被定位到');
  for (const method of ['query', 'queryRaw', 'exec', 'transaction']) {
    check(
      new RegExp(`\\b${method}\\s*[<(:]`).test(inProcessDb) &&
        new RegExp(`\\b${method}: function`).test(sandboxDb),
      `db.${method} 在 in-process 与沙箱两侧都有同名成员`
    );
  }

  // ---- 行为层的覆盖在单元测试里，这一条只是确认它们还在 ----
  for (const test of [
    'attach_and_detach_are_refused_by_the_engine',
    'pragmas_that_defeat_the_budget_are_refused',
    'the_page_limit_is_enforced_by_the_engine',
    'a_second_statement_in_one_call_is_refused',
    'a_failed_transaction_leaves_nothing_behind',
    'values_round_trip_and_blobs_stay_distinguishable',
    'schema_editing_is_refused_by_sqlite_itself',
  ]) {
    check(
      dbRs.includes(`fn ${test}(`),
      `db.rs 里有行为层测试 ${test}`
    );
  }
}




// ============================================================
// 18. `ctx.http.download`：大文件直接落盘，不经过 JS 内存
// ============================================================
//
// 这一节守的是那条接口**存在的理由本身**：如果它中间任何一环把整份字节拿进内存，
// 它就退化成了 `http.fetch` + `dataDir.write`，而那两个已经存在了 ——
// 一个不再省任何东西的同名接口比没有它更糟（作者会以为它省了）。
//
// 三件事因此必须逐条盯住：**流式写**、**三段式落盘**、**边写边判配额**。

section('下载到数据目录（ctx.http.download）');

{
  const dbAndDownloadRs = read('../src-tauri/src/modules/plugins/manager.rs');
  const dataDirRs = read('../src-tauri/src/modules/plugins/data_dir.rs');
  const rpcForDownload = read('../src-tauri/src/modules/plugins/rpc.rs');
  const commandsForDownload = read('../src-tauri/src/modules/plugins/commands.rs');
  const runtimeForDownload = read('../src/services/pluginRuntime.ts');
  const cargoForDownload = read('../src-tauri/Cargo.toml');

  const downloadFn =
    /pub async fn http_download<F>\([\s\S]*?\n    \}\n\}/.exec(dbAndDownloadRs)?.[0] ?? '';
  check(downloadFn.length > 0, 'manager 里有 http_download，且能被定位到');

  // ---- 流式：真正的 `bytes_stream`，而不是 `bytes()` ----
  check(
    /response\.bytes_stream\(\)/.test(downloadFn),
    '响应体是**流式**读的（`bytes()` 会把整份拿进内存 —— 那正是这个接口要避免的）'
  );
  check(
    !/response\.bytes\(\)/.test(downloadFn),
    'http_download 里没有一次性拿全量字节'
  );
  check(
    /file\.write_all\(&chunk\)/.test(downloadFn),
    '每一块直接写进文件句柄'
  );
  check(
    /content_type/.test(downloadFn) && !/String::from_utf8/.test(downloadFn),
    '下载不解码文本（解码意味着整份内容变成字符串）'
  );

  // ---- 三段式：`.part` → 改名 ----
  const beginFn = /pub fn begin_stream\([\s\S]*?\n\}/.exec(dataDirRs)?.[0] ?? '';
  check(
    /path\.with_extension\(/.test(beginFn) && /\.part/.test(beginFn),
    '临时文件由目标名加后缀得到（同一个目录 —— 跨卷改名就不原子了）'
  );
  check(
    /pub fn finish_stream\([\s\S]{0,600}?std::fs::rename/.test(dataDirRs),
    '收尾是**同卷改名**（目标要么不存在、要么完整）'
  );
  check(
    /pub fn abort_stream\([\s\S]{0,600}?std::fs::remove_file\(&target\.temp\)/.test(dataDirRs),
    '放弃时删掉临时文件'
  );
  check(
    /data_dir::finish_stream\(&target\)/.test(downloadFn),
    'http_download 只在全部字节到齐后改名'
  );
  check(
    /if let Err\(error\) = outcome \{[\s\S]{0,200}?data_dir::abort_stream\(&target\)/.test(downloadFn),
    '中途失败时删掉临时文件（留一个被截断的目标是最糟的结果 —— 它看起来正常）'
  );
  // Windows 上"还开着的文件"删不掉，于是失败的下载会留下一个 `.part`
  check(
    /drop\(file\);[\s\S]{0,200}?data_dir::abort_stream/.test(downloadFn),
    '失败时**先关句柄再删**（Windows 上开着就删不掉）'
  );

  // ---- 配额：边写边判 ----
  check(
    /if written > target\.headroom \{/.test(downloadFn),
    '配额在写入过程中判（写完再算意味着插件可以先占满磁盘再收到"你超了"）'
  );
  check(
    /if total > target\.headroom \{[\s\S]{0,200}?return Err\(PluginError::QuotaExceeded/.test(downloadFn),
    'Content-Length 已知且已超余量时**发请求后立刻拒绝**（省掉一次白下的流量）'
  );
  check(
    /PROGRESS_STEP_BYTES/.test(dbAndDownloadRs) && /const PROGRESS_STEP_BYTES: u64 = 256 \* 1024;/.test(dbAndDownloadRs),
    '进度被节流（200 MB 会产生上万次块回调，每次都推 IPC 等于 DDOS 自己）'
  );
  check(
    /on_progress\(written, total\);[\s\S]{0,200}?data_dir::finish_stream/.test(downloadFn),
    '最后一次进度**无条件推**（否则界面永远停在 96% 那一格）'
  );

  // ---- 非 2xx 不落盘 ----
  check(
    /if !\(200\.\.300\)\.contains\(&status\) \{[\s\S]{0,400}?return Err\(PluginError::NetworkError/.test(
      downloadFn
    ),
    '非 2xx 不落盘（把一段"404 Not Found"的 HTML 存成 model.bin 会把问题推迟到读它的时候）'
  );

  // ---- 权限与策略：与 http.fetch **共用**一份判定 ----
  //
  // 两条路径各写一遍权限判定一定会漂，而漂开的方向是"某一条忘了 network-external"。
  check(
    /fn plugin_request\(/.test(dbAndDownloadRs) && /fn map_net_error\(/.test(dbAndDownloadRs),
    '权限判定与错误翻译各抽成一处'
  );
  check(
    /self\.plugin_request\(id, "GET", url, headers\)\?/.test(downloadFn),
    'http_download 走**同一个** plugin_request（不自己再判一遍权限）'
  );
  const requestFn = /pub async fn http_request\([\s\S]*?\n    \}/.exec(dbAndDownloadRs)?.[0] ?? '';
  check(
    /self\.plugin_request\(id, method, url, headers\)\?/.test(requestFn),
    'http_request 也走那一个'
  );
  check(
    !/is_loopback_host\(/.test(downloadFn) && !/network-external/.test(downloadFn),
    'http_download 里没有第二份权限判定'
  );

  // ---- 依赖：流式的前提 ----
  check(
    /features = \["json", "rustls-tls", "stream"\]/.test(cargoForDownload),
    'reqwest 打开了 `stream` 特性（`bytes_stream` 的前提）'
  );

  // ---- 两条调用路径都转给同一个实现 ----
  check(
    /"http\.download" => \{[\s\S]*?\.http_download\(/.test(rpcForDownload),
    '沙箱协议那一条转给 PluginManager::http_download'
  );
  check(
    /pub async fn plugin_http_download\(/.test(commandsForDownload) &&
      /\.http_download\(&id, &url, &rel, headers/.test(commandsForDownload),
    'in-process 那一条也转给同一个实现'
  );
  check(
    !/data_dir::begin_stream/.test(rpcForDownload) && !/data_dir::begin_stream/.test(commandsForDownload),
    '落盘的实现只有一处（两条路径都不自己写一遍）'
  );

  // ---- 进度：两条路都要到得了回调 ----
  //
  // 沙箱这一侧也是两跳（宿主 → 前端 → iframe）：从前它 `eval` 一段脚本进插件
  // webview，现在走 `push_to` 的 `download-progress` 通道。`rel` 必须在负载里
  // ——一个插件可以同时下好几个文件，进度条要能分辨是哪一个。
  const deliverProgressFn =
    /pub async fn deliver_download_progress<R: Runtime>\([\s\S]*?\n}\n/.exec(sandboxRs)?.[0] ?? '';
  check(deliverProgressFn.length > 0, '能定位到 deliver_download_progress 的函数体');
  check(
    /push_to\(app, &token, "download-progress", payload\.clone\(\)\)/.test(deliverProgressFn) &&
      /"rel": rel,/.test(deliverProgressFn),
    '沙箱插件的进度经 push_to 的 download-progress 通道推给它的界面，且带 rel'
  );
  // 进度只推给**发起它的那块界面**（给了 `only` 时）—— 别的界面收到也没法处理。
  check(
    /if key\.surface != only \{[\s\S]{0,80}?continue;/.test(deliverProgressFn),
    '进度可以只推给发起它的那一块界面（别的界面收到也没法处理）'
  );
  check(
    /pub const DOWNLOAD_PROGRESS: &str = "modulith:\/\/plugin-download-progress"/.test(rpcForDownload) &&
      /app\.emit\(\s*super::rpc::DOWNLOAD_PROGRESS/.test(sandboxRs),
    'in-process 插件的进度走一条广播（它的回调在宿主这个 realm 里）'
  );
  check(
    /downloadHandlers\[key\] = onProgress/.test(bridgeJs) &&
      /window\.__modulithDownloadProgress = function/.test(bridgeJs),
    '桥接层持有沙箱侧的进度回调'
  );
  check(
    /^installPluginDownloadProgress\(\);/m.test(read('../src/main.tsx')),
    'in-process 那一条的监听真的装在启动路径上'
  );
  // 沙箱侧**不能**在 Promise 结束时删回调：最后一次进度可能晚于返回值。
  check(
    !/\.finally\(function \(\) \{[\s\S]{0,200}?delete downloadHandlers/.test(bridgeJs),
    '桥接层不在下载结束时删回调（最后一次进度可能比返回值晚到，删早了会吞掉 100%）'
  );

  // ---- 与 ctx.dataDir 的关系：临时文件也在配额里 ----
  check(
    /pub headroom: u64/.test(dataDirRs) && /MAX_FILE_BYTES/.test(beginFn),
    '余量既受总配额约束、也不超过单文件上限'
  );
  check(
    /used_bytes\.saturating_sub\(existing\)/.test(beginFn),
    '覆盖已有文件时先减掉旧体积（与 write 同一条判据）'
  );
  // 流式写入**不是另一条写入路径**：它必须继承同一套边界，
  // 否则下载就成了唯一一个能越界的写。
  check(
    /pub fn begin_stream\(root: &Path, rel: &str, used_bytes: u64\) -> Result<StreamTarget, String> \{\s*\n\s*let path = resolve\(root, rel\)\?;/.test(
      dataDirRs
    ),
    '流式写入走**同一个** resolve（自己拼路径就等于绕过整个 chroot 语义）'
  );
  check(
    !/root\.join\(rel\)/.test(beginFn),
    'begin_stream 里没有自己拼路径'
  );
  // 三段式的行为由 `data_dir.rs` 自己的单元测试覆盖。
  for (const test of [
    'the_temp_file_lives_next_to_the_target',
    'streaming_inherits_the_same_path_rules',
    'the_headroom_accounts_for_replacing_an_existing_file',
    'finishing_moves_the_temp_onto_the_target',
    'aborting_leaves_no_target_and_no_temp',
  ]) {
    check(dataDirRs.includes(`fn ${test}(`), `数据目录里有流式写入的测试 ${test}`);
  }
}





// ============================================================
// 19. 宿主把自己的 React 送给沙箱插件
// ============================================================
//
// 这一节守的是"沙箱插件从哪来 React"这条决定。它不是为了好看：插件仓库的构建把
// `react` 与 `react/jsx-runtime` 标成 external，并接到 `globalThis.Modulith.React`
// 与 `globalThis.Modulith` 上 —— 那条约定的前提是**一个文档里只有一个 React 实例**。
// 沙箱插件是独立文档，宿主页面上的东西一个都到不了，因此必须由宿主送过去。
//
// 坏掉的症状全是静默的：
//   * 顺序反了（桥接层先于 react.js）→ `Modulith.React` 是 undefined，
//     插件报 "Cannot read properties of undefined"，看起来像插件自己写错了；
//   * 忘了发 jsx / jsxs / Fragment → 只有用 JSX 语法的插件坏，手写
//     `createElement` 的插件照样跑；
//   * 产物与宿主用的 React 版本漂开 → 只在其一里复现的 hooks 报错。
// 三条都不报错，只让一部分插件坏。

section('宿主把自己的 React 送给沙箱插件');

{
  const sandboxRsForReact = read('../src-tauri/src/modules/plugins/sandbox.rs');
  const bridgeForReact = read('../src-tauri/resources/sandbox-bridge.js');
  const reactArtifact = '../src-tauri/resources/react-runtime.js';

  // ---- 1. 宿主确实带着它 ----

  check(
    /const PLUGIN_REACT_JS: &str = include_str!\("\.\.\/\.\.\/\.\.\/resources\/react-runtime\.js"\);/.test(
      sandboxRsForReact
    ),
    '宿主把 react-runtime.js 编进二进制（include_str!）'
  );
  check(
    /\(\"GET\", Some\(\"react\.js\"\)\) => script\(PLUGIN_REACT_JS\)/.test(sandboxRsForReact),
    '插件协议上有一条 GET /<token>/react.js'
  );

  // ---- 2. 加载顺序：React → 桥接层 → 插件 ----
  //
  // 三者都是入口文档里的 `<script src>`，因此按**出现位置**比大小就够了。
  // 这一条不能只查"三个标签都在" —— 顺序反了标签也都在，而结果是
  // `Modulith.React` 为 undefined。
  //
  // 地址的第一段是**令牌**（不再是插件 id）：协议处理器只认令牌，因此这里的
  // 判据也必须按令牌的形式写 —— 否则"地址被换回 id 拼"这件事不会有任何东西发现。
  const entryDoc = /fn entry_document<R: Runtime>\([\s\S]*?\n\}/.exec(sandboxRsForReact)?.[0] ?? '';
  check(entryDoc.length > 0, '能定位到 entry_document 的函数体');
  const reactAt = entryDoc.indexOf('<script src="/{token}/react.js">');
  const bridgeAt = entryDoc.indexOf('<script src="/{token}/bridge.js">');
  // 锚在**脚本标签**上，不是裸的 `/asset/`：同一个函数体里还有一行
  // `<link rel="stylesheet" href="/{token}/asset/{rel}">`（样式表），它在 `<head>` 里、
  // 排在所有脚本之前。用裸 `/asset/` 会命中那一行，于是这条断言恒为"顺序错了"。
  const mainAt = entryDoc.indexOf('<script src="/{token}/asset/');
  check(
    reactAt >= 0 && bridgeAt >= 0 && mainAt >= 0 && reactAt < bridgeAt && bridgeAt < mainAt,
    reactAt >= 0 && bridgeAt >= 0 && mainAt >= 0 && reactAt < bridgeAt && bridgeAt < mainAt
      ? '入口文档里三者顺序是 React → 桥接层 → 插件'
      : `入口文档里的加载顺序不对（react ${reactAt} / bridge ${bridgeAt} / main ${mainAt}）—— 标签都在但顺序错了，症状是 Modulith.React 为 undefined`
  );

  // ---- 3. 桥接层把两侧的约定接上 ----

  check(
    /window\.__MODULITH_PLUGIN_REACT__/.test(bridgeForReact),
    '桥接层读的是 react.js 挂的那个全局'
  );

  // 插件仓库的 shim：`require('react')` → `Modulith.React`，
  // `require('react/jsx-runtime')` → **Modulith 本身**。后者要的就是下面这三个。
  for (const member of ['React', 'jsx', 'jsxs', 'Fragment', 'createContext']) {
    check(
      new RegExp(`^\\s{4}${member}: PLUGIN_REACT \\? PLUGIN_REACT\\.`, 'm').test(bridgeForReact),
      `桥接层把 ${member} 交给插件（来自宿主那一份 React，不是插件自带的）`
    );
  }

  // ---- 4. registerModule 必须真的挂载 ----
  //
  // 名字与 in-process 相同而行为不同，这正是最容易写成"注册了但什么都没发生"的地方：
  // 一个只 log 一句然后返回的实现能让上面每一条断言都通过。
  const registerFn = /function registerModule\(definition\) \{[\s\S]*?\n  \}/.exec(bridgeForReact)?.[0] ?? '';
  check(registerFn.length > 0, '能定位到 registerModule 的函数体');
  check(
    /ReactDomClient\.createRoot\(root\)/.test(registerFn) && /\.render\(/.test(registerFn),
    'registerModule 真的 createRoot(...).render(...) —— 不是"注册了但什么都没发生"'
  );
  check(
    /getElementById\('modulith-root'\)/.test(registerFn),
    'registerModule 挂到入口文档那个 #modulith-root 上'
  );
  check(
    /typeof component !== 'function'/.test(registerFn),
    '入参不是组件时给出明确报错，而不是抛一个看不懂的异常'
  );

  // ---- 5. useModuleActive 恒真，且理由是"前提不存在"而不是"没实现" ----
  const useActiveFn = /function useModuleActive\(\) \{[\s\S]*?\n  \}/.exec(bridgeForReact)?.[0] ?? '';
  check(
    /return true;/.test(useActiveFn),
    'useModuleActive 在沙箱里恒为 true（一个界面一个文档，"别的模块"不存在）'
  );

  // ---- 6. 产物存在，且与宿主用的是同一个 React 版本 ----
  const reactPkg = JSON.parse(
    readFileSync(resolve(here, '../node_modules/react/package.json'), 'utf8')
  ) as { version: string };

  check(exists(reactArtifact), `产物存在：${reactArtifact.replace('../', '')}`);
  if (exists(reactArtifact)) {
    const artifact = read(reactArtifact);
    // 版本号是**从产物里读出来**再与 node_modules 比，而不是断言"文件里有某个字面量"：
    // 后者在升级 React 却忘了重新生成时照样通过 —— 那正是这条断言要防的事。
    const recorded = /react (\d+\.\d+\.\d+) \/ react-dom/.exec(artifact)?.[1] ?? '';
    check(
      recorded === reactPkg.version,
      recorded === reactPkg.version
        ? `产物里的 React ${recorded} 与宿主用的那一份一致`
        : `★ 产物里的 React 是 ${recorded || '（读不到）'}，而 node_modules 里是 ${reactPkg.version} —— 跑 node scripts/build-plugin-react.ts 重新生成`
    );
    check(
      /globalThis\.__MODULITH_PLUGIN_REACT__/.test(artifact),
      '产物挂上了桥接层要读的那个全局'
    );
    // 压缩过：它同时进 git 与二进制，而没有哪个人会去读 React 自己的代码。
    // 上界给得宽松，只用来挡"忘了压缩"（那份是 ~600 KB）。
    check(
      artifact.length < 320 * 1024,
      `产物体积 ${(artifact.length / 1024).toFixed(1)} KB（压缩过；未压缩约 600 KB）`
    );
  }

  // ---- 7. 生成脚本本身在仓库里，且能用 ----
  check(
    exists('../scripts/build-plugin-react.ts'),
    '生成脚本在仓库里（产物可复现，不是"某台机器上构建出来就是什么"）'
  );
  const buildScript = read('../scripts/build-plugin-react.ts');
  check(
    // esbuild 从 vite 那里解析，而不是再声明一份 —— 两个 esbuild 会漂。
    /createRequire\(import\.meta\.resolve\('vite\/package\.json'\)\)/.test(buildScript),
    'esbuild 从 vite 的依赖里解析（避免磁盘上出现两个 esbuild）'
  );
  check(
    /legalComments: 'inline'/.test(buildScript),
    '压缩时保留版权声明（React 是 MIT，分发必须带上）'
  );
}

// ============================================================
// 20. 两侧的成员表真的对得上吗
// ============================================================
//
// 这一节是补一个**说了很久但没人守**的承诺。`sandbox-bridge.js` 开头写着
// "同一个插件可以在 in-process 与 sandboxed 之间切换，而它的代码不该因此改一行"，
// 第 11 节也确实"逐项比对两份清单"——**但它比的是 §3 那份文档表，不是宿主里
// 真正的 `ctx`**。于是两处名字对不上时没有任何东西会响。
//
// 实测（`staging/audit-plugin-surfaces.cjs` 是同一件事的独立脚本）当时的结果是：
//   * `ctx.logger` 在沙箱里叫 `log`；
//   * `ctx.pluginId` / `pluginVersion` / `version` 在沙箱里根本没有；
//   * `Modulith.version`（宿主版本）也没有 —— 而 kanban 与 typing-practice 都在读它。
// 三处都是**静默**的：插件拿到 `undefined`，报错看起来像插件自己写错了。
//
// 因此这一节的判据是"**差异清单必须恰好是这些**"：多一个少一个都打红。
// 差异本身分两类，混在一起会让人以为沙箱"少了一半能力"：
//   * 宿主侧独有 —— 宿主对象的成员（React 那一族、registerModule、useModuleActive）
//     在沙箱里被并进了同一个对象，因此不算"缺失"；
//   * 沙箱独有 —— 沙箱没有 `ctx` 这个包装，只有一个 `Modulith`。
// 真正算缺失的只有 `IN_PROCESS_ONLY` 里那几个。

section('两侧的成员表');

{
  // 沙箱侧：**真的把它实例化一次**再读挂上去的对象。文本匹配查不到
  // "这个成员真的挂在对象上" —— 删掉一行字面量它照样绿。
  const renderedForParity = bridgeJs
    .replaceAll("'__PLUGIN_ID__'", '"com.modulith.parity"')
    .replaceAll("'__PLUGIN_NAME__'", '"对齐检查"')
    .replaceAll("'__PLUGIN_VERSION__'", '"9.9.9"')
    .replaceAll("'__PLUGIN_HOST_VERSION__'", '"1.6.0"')
    .replaceAll("'__PLUGIN_SURFACE__'", '"main"')
    .replaceAll("'__PLUGIN_RUNTIME__'", '"sandboxed"')
    .replaceAll("'__PLUGIN_ACTIVATION__'", '"open"')
    .replaceAll('__PLUGIN_PERMISSIONS__', '[]')
    .replaceAll('__PLUGIN_DATA_AVAILABLE__', 'true')
    .replaceAll('__PLUGIN_SURFACES__', '[]')
    .replaceAll('__PLUGIN_THEME__', '{}')
    .replaceAll('__PLUGIN_SHORTCUTS__', '{}');

  let parityApi: Record<string, unknown> | null = null;
  try {
    const factory = new Function(
      'window',
      'fetch',
      'navigator',
      `${renderedForParity}\nreturn window.Modulith;`
    );
    parityApi = factory(
      {
        addEventListener: () => {},
        // 同 §11：令牌从地址里读，没有地址就整段脚本在顶层抛。
        location: { pathname: '/0123456789abcdef0123456789abcdef/' },
      },
      () => Promise.reject(new Error('不发网络')),
      { clipboard: { readText: async () => '', writeText: async () => {} } }
    );
  } catch {
    parityApi = null;
  }
  check(parityApi !== null, '沙箱侧可以被实例化（否则这一节无从谈起）');

  // 宿主侧：**两张表都要读**。`ctx.*` 是能力，`Modulith.*` 是运行时入口；而沙箱里
  // 它们被并进了同一个对象（沙箱没有 `ctx` 那个中间层），因此两张表里的成员都得有。
  //
  // 只读 `ctx.*` 是这一节**一个真实存在过的盲点**：`kanban` 在 bundle 顶层调用
  // `Modulith.registerCommand({ id, title, run })`，而沙箱桥接层没有这个成员 ——
  // 迁过去不是"某个功能失效"，是**整个插件加载时抛 TypeError**。一次针对
  // "这 8 个插件能不能迁到沙箱"的逐个审计才把它翻出来，而那份审计之所以要做，
  // 是因为这一节从来没比过 `Modulith.*`。
  const boundarySource = read('../src/services/pluginBoundary.ts');

  const tableOf = (name: string): string[] => {
    const start = boundarySource.indexOf(`const ${name}`);
    const end = boundarySource.indexOf('\n];', start);
    check(start >= 0 && end > start, `能从 pluginBoundary.ts 定位到 ${name}`);
    // 判据**不能**要求 `{` 与 `name:` 同行：`handle` 形态的成员是多行写的，
    // 按单行匹配只会捞到 value 那三个，于是整张表看起来像缺了一大半。
    return [...boundarySource.slice(start, end).matchAll(/\bname: '([A-Za-z_$][\w$]*)'/g)].map(
      (match) => match[1]
    );
  };

  const ctxMembers = tableOf('CONTEXT_MEMBERS');
  const hostMembers = tableOf('HOST_MEMBERS');

  check(ctxMembers.length >= 20, `宿主 ctx 表读到 ${ctxMembers.length} 个成员`);
  check(hostMembers.length >= 13, `宿主 Modulith 表读到 ${hostMembers.length} 个成员`);

  const sandboxKeys = parityApi ? Object.keys(parityApi) : [];

  // 沙箱里**必须**与宿主同名的那些（也就是真正会被插件直接读到的成员）。
  // 基准是两张表的**并集** —— 只用 `ctx.*` 当基准，「沙箱独有」会虚高一整族
  // （React 那一套本来就在 `Modulith.*` 里，不是沙箱发明的）。
  const sandboxOnly = sandboxKeys
    .filter((key) => !ctxMembers.includes(key) && !hostMembers.includes(key))
    .sort();
  const inProcessOnly = ctxMembers.filter((key) => !sandboxKeys.includes(key)).sort();
  const hostOnly = hostMembers.filter((key) => !sandboxKeys.includes(key)).sort();

  const EXPECTED_SANDBOX_ONLY = [
    // 宿主对象那一族被并进了同一个对象：in-process 的 `Modulith.React` 与
    // `ctx` 是两个东西，沙箱只有一个 `Modulith`。**因此它们不算"沙箱独有"** ——
    // 基准是两张表的并集，而它们本来就在 `Modulith.*` 那一张里。
    'jsxDEV',
    // 沙箱自己的形状
    'commands',
    'has',
    'log',
    'plugin',
    'surfaces',
    'theme',
    'shortcuts',
    'ui',
  ].sort();

  // `ctx.*` 那一侧的缺口。**只剩一条**，而且是设计选择，不是没做：
  //   * `manifest` —— 宿主没有把整份清单送进沙箱（只送了 id/name/version/permissions）。
  //
  // `fileDrop` 曾经在这张清单里，理由写的是"拖放是窗口级事件、子 webview 收不到、
  // 补不了"。那个理由**只对了一半**：wry 把拖放处理器注册在 webview 自己的 HWND
  // 及其全部子窗口上（`wry-0.55.1/src/webview2/drag_drop.rs:50`），子 webview 有
  // 自己的 HWND 且没注册处理器，路径从根上断掉。换成 iframe 之后指针底下始终是
  // 主 webview 的 HWND，事件照常触发且带指针位置 —— 于是它变成"按位置命中哪一块
  // 界面就往哪一块 postMessage"，1.6.0 补上了。
  const EXPECTED_IN_PROCESS_ONLY = ['manifest'].sort();

  // `Modulith.*` 那一侧的缺口。**两条，都是"数据/引导"这一类，不是能力**：
  //   * `capabilities` —— 那张表由**前端**从 `pluginBoundary.ts` 派生
  //     （`HOST_CAPABILITIES`），而桥接层是 Rust 渲染的：把它送进去需要
  //     前端在建界面时把它交给宿主、宿存在令牌旁边、再注入桥接层。可行，
  //     但还没有人需要它（9 个插件一个都没读 `Modulith.capabilities`）；
  //   * `run` —— 显式引导入口。它的价值在 in-process 侧是**去掉隐式全局**
  //     （v1 靠"当前正在加载哪个插件"决定归属，那个全局跨不过 realm），而沙箱里
  //     这份文档从头到尾只属于一个插件，那个全局根本不存在 —— 于是"引导"这件事
  //     在沙箱里没有对应的问题要解决。
  //
  // 两条都写进插件开发文档，因此这里把它们钉成"已知且被承认"的清单。
  const EXPECTED_HOST_ONLY = ['capabilities', 'run'].sort();

  check(
    sandboxOnly.join(',') === EXPECTED_SANDBOX_ONLY.join(','),
    sandboxOnly.join(',') === EXPECTED_SANDBOX_ONLY.join(',')
      ? `沙箱独有的 ${sandboxOnly.length} 个成员与预期一致`
      : `★ 沙箱独有的成员变了。\n      预期：${EXPECTED_SANDBOX_ONLY.join('、')}\n      实际：${sandboxOnly.join('、') || '（空）'}`
  );
  check(
    inProcessOnly.join(',') === EXPECTED_IN_PROCESS_ONLY.join(','),
    inProcessOnly.join(',') === EXPECTED_IN_PROCESS_ONLY.join(',')
      ? `ctx 里宿主独有（即沙箱缺失）的 ${inProcessOnly.length} 个成员与预期一致：${inProcessOnly.join('、')}`
      : `★ ctx.* 两侧的缺口变了 —— 这会让"同一个插件两侧都能跑"变成假话。\n      预期：${EXPECTED_IN_PROCESS_ONLY.join('、')}\n      实际：${inProcessOnly.join('、') || '（空）'}`
  );
  check(
    hostOnly.join(',') === EXPECTED_HOST_ONLY.join(','),
    hostOnly.join(',') === EXPECTED_HOST_ONLY.join(',')
      ? `Modulith 里宿主独有（即沙箱缺失）的 ${hostOnly.length} 个成员与预期一致：${hostOnly.join('、')}`
      : `★ Modulith.* 两侧的缺口变了。**这一条从前根本不存在** —— 少了它，kanban 用的 registerCommand 一直缺着也没人知道，而那个缺口的症状是插件加载时抛 TypeError。\n      预期：${EXPECTED_HOST_ONLY.join('、')}\n      实际：${hostOnly.join('、') || '（空）'}`
  );

  // 光有"差异清单对得上"还不够：两边都空成一个集合也能骗过上面三条。
  const shared = ctxMembers.filter((key) => sandboxKeys.includes(key)).sort();
  check(
    shared.length >= 18,
    `两侧同名 ${shared.length} 个：${shared.join('、')}`
  );

  // 三条**具体**的成员，它们是这一节存在的直接原因（都曾经是 undefined）。
  // 单独钉住是因为差异清单那两条只说明"集合没变"，不说明"值是对的"。
  for (const [member, expected] of [
    ['version', '1.6.0'],
    ['pluginVersion', '9.9.9'],
    ['pluginId', 'com.modulith.parity'],
  ] as const) {
    check(
      parityApi?.[member] === expected,
      `Modulith.${member} 是宿主注入的那一份（${String(parityApi?.[member])}）`
    );
  }
  check(
    typeof (parityApi?.logger as Record<string, unknown> | undefined)?.trace === 'function',
    'logger 与 log 是同一个对象，且带 trace（in-process 的 logger 有它）'
  );
}

// ============================================================
// 21. 桥接层的运行时守卫与推送通道
// ============================================================
//
// 这一节从前守的是**遮挡判断的采样**（5×5 网格 + 覆盖率阈值）。
//
// 那一整套东西连同它要解决的问题一起消失了：原生 webview 盖在宿主 DOM 之上、
// 不看 z-index，因此宿主必须自己判断"我是不是被别处的浮层盖住了"，而被盖住时
// 唯一的反应是把它收起来 —— 收早收晚都会闪。iframe 就在这个文档里，**层叠由
// CSS 决定**，标题栏的下拉与侧边栏的边缘天然压在它上面。
//
// 判据是它**不许回来**：`isCovered` / `COVERAGE_THRESHOLD` / `elementFromPoint`
// 这些名字一旦重新出现，就说明有人以为界面还是原生层，而在 iframe 上做那件事
// 只会得到"插件界面莫名其妙自己藏起来"。§10 已经断言了其中一部分，这里补上
// 采样特有的那几个常数。
//
// 省下来的位置放到这一节真正该守的东西上：iframe 模型下**新的**边界。
// 前一份守卫（ACL 把 `plugin-*` 排除、协议处理器验令牌）是宿主的；这一节守的是
// 插件文档**自己**那一侧 —— 而那三条的性质都是"坏掉时不会有任何症状"：
//
//   * 文档里出现宿主 IPC → 插件忽然能 `invoke` 全部应用命令；
//   * 同源共享存储没封 → 插件 A 写的东西插件 B 读得到；
//   * 推送入口不验发送方 → 任何能往这个窗口发消息的人都能冒充宿主。

section('桥接层的运行时守卫');

{
  // 那条采样逻辑**不许回来**。判据是几个具名的常数与函数。
  //
  // 剥注释：这一节的引言正是在解释那一套东西**为什么**被删掉，不剥的话，
  // 一份说明"这里不再做遮挡判断"的注释会把门禁判成违规。
  const surfaceTsx = read('../src/components/SandboxSurface.tsx');
  const surfaceCode = strip(surfaceTsx);
  for (const ghost of [
    'isCovered',
    'COVERAGE_THRESHOLD',
    'CONFIRMATIONS',
    'POLL_MS',
    'elementFromPoint',
  ]) {
    check(
      !new RegExp(`\\b${ghost}\\b`).test(surfaceCode),
      `${ghost} 已删除（iframe 的层叠由 CSS 决定，不需要命中测试让位）`
    );
  }

  // ---- 1. 这个文档里不该有宿主 IPC ----
  //
  // 沙箱依赖 Tauri 一侧的两件事：它不给子框架注入 IPC 初始化脚本，且 IPC 处理器
  // 要求一个只注入主框架的随机键。**两件事都会静默失效** —— 哪一天不成立了，
  // 这里不会报错、不会变慢、没有任何症状，只是插件忽然能 invoke 全部应用命令。
  const assertFn = /function assertNoHostIpc\(\) \{[\s\S]*?\n  \}/.exec(bridgeJs)?.[0] ?? '';
  check(assertFn.length > 0, '桥接层里有 assertNoHostIpc()');
  // 四个名字一个都不能少：前两个是 Tauri 的注入面，`isTauri` 是它的探测标志，
  // 而 `window.ipc` 是 Windows 上那条**不受 CSP 管辖**的原生桥 ——
  // 少查最后那一个，正是"fetch 那条被 connect-src 挡住了，却还有一条路"的形状。
  //
  // 判据锚在**剥掉注释之后**的正文上：这个函数正是在注释里解释"为什么还要查
  // `window.ipc`"，不剥的话，把那一行检查删掉它照样绿。
  const assertCode = strip(assertFn);
  for (const name of ['__TAURI_INTERNALS__', '__TAURI__', 'isTauri', 'ipc']) {
    check(
      new RegExp(`window\\.${name.replace(/\$/g, '\\$')}\\b`).test(assertCode),
      `assertNoHostIpc 检查 ${name}（四个名字缺一，边界塌了就不会被发现）`
    );
  }
  // 查到就**大声说出来**，而且不能只说给控制台听：release 版里没有控制台，
  // 而这一条恰恰是最不该只留在控制台里的。
  check(
    /found\.push\(/.test(assertCode) && /rpc\('log', \{ level: 'error'/.test(assertCode),
    '查到宿主 IPC 时既进控制台也写进宿主日志（release 版看不到控制台）'
  );
  // 而它必须**真的跑一次**：定义一个检查器却从不调用，等于什么都没查。
  check(
    /var HOST_IPC_ABSENT = assertNoHostIpc\(\)/.test(bridgeJs),
    'assertNoHostIpc 在文档加载时真的跑了一次（定义了却不调用等于没查）'
  );

  // ---- 2. 同一个来源带来的共享存储必须封掉 ----
  //
  // 全部插件界面共享 `http://modulith-plugin.localhost` 这一个来源，因此
  // `localStorage` / `sessionStorage` / `indexedDB` / `caches` 是**公用**的。
  const freezeFn = /function freezeOriginStorage\(\) \{[\s\S]*?\n  \}/.exec(bridgeJs)?.[0] ?? '';
  check(freezeFn.length > 0, '桥接层里有 freezeOriginStorage()');
  // 同样剥注释：这一段的一开头就在注释里列了那四个名字，不剥的话把数组删空
  // 这条断言照样绿。
  const freezeCode = strip(freezeFn);
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
    check(
      freezeCode.includes(`'${name}'`),
      `freezeOriginStorage 封掉 ${name}（它与其它插件共享同一个来源）`
    );
  }
  // **必须不可重定义。** 插件跑在同一个 realm 里：`configurable: true` 的覆盖
  // 它自己 `delete` 一下就没了，那样封了等于没封。
  //
  // 两处 `defineProperty`（四个存储全局走一个 `forEach`，cookie 单独一处），
  // 因此只数到 2 —— 关键是**两处都不能是 `configurable: true`**。
  const configurableCount = (freezeCode.match(/configurable: false/g) ?? []).length;
  const defineCount = (freezeCode.match(/Object\.defineProperty\(/g) ?? []).length;
  check(
    defineCount === 2 && configurableCount === defineCount,
    `每一处覆盖都用 configurable: false（${configurableCount}/${defineCount} 处）—— 可重定义的封禁 delete 一下就没了`
  );
  // `document.cookie` 单独处理：**读**返回空串而不是抛（读的人多半是某个捆绑进来
  // 的库在做特性探测，让它抛会把一个无关的插件直接打挂），**写**必须失败。
  check(
    /Object\.defineProperty\(document, 'cookie'/.test(freezeCode) &&
      /return '';/.test(freezeCode) &&
      /set: function \(\) \{[\s\S]{0,200}?throw new Error/.test(freezeCode),
    'document.cookie 读返回空串、写抛错（写才是"把数据留给下一个插件"的那条路）'
  );
  check(
    /freezeOriginStorage\(\);/.test(bridgeJs),
    'freezeOriginStorage 在文档加载时真的被调用（定义了却不调用等于没封）'
  );

  // ---- 3. 推送入口必须同时验发送方与标记 ----
  //
  // 身份判据是 `event.source`，不是 `event.origin`：来源字符串是发送方自己声明的
  // （一个 `data:` 文档的来源就是字符串 `"null"`），而窗口引用不能伪造 ——
  // 只有宿主那个窗口能等于 `window.parent`。
  const listenerFn =
    /window\.addEventListener\(\s*'message',[\s\S]*?\n    false\s*\n  \);/.exec(bridgeJs)?.[0] ?? '';
  check(listenerFn.length > 0, '能定位到 message 监听器');
  check(
    /if \(event\.source !== window\.parent\) return;/.test(listenerFn),
    '推送入口验 event.source === window.parent（origin 是发送方自己声明的，不能当身份）'
  );
  check(
    /if \(!data \|\| data\.__modulith !== true\) return;/.test(listenerFn),
    '推送入口验 data.__modulith === true（少了它，任何能往这个窗口发消息的人都能冒充宿主）'
  );
  // 所有推送处理器必须**经由那张表**分派：写在监听器外面的 `window.onmessage`
  // 会绕开上面两条校验。
  check(
    /var PUSH_HANDLERS = \{/.test(bridgeJs) &&
      /var handler = PUSH_HANDLERS\[data\.channel\]/.test(listenerFn),
    '推送按一张处理器表分派（另写一条 onmessage 会绕开上面两条校验）'
  );
  check(
    /if \(!handler\) return;/.test(listenerFn),
    '认不出的 channel 一律忽略（宿主加一条新推送时，旧插件不该因此报错）'
  );
  // 宿主推的那五条通道，桥接层每一条都要有处理器。少一条的表现是那一类推送
  // **静默丢失**（主题不动、命令没反应、跨插件事件收不到）。
  for (const channel of ['theme', 'shortcuts', 'command', 'download-progress', 'event']) {
    check(
      new RegExp(`(?:^|\\s)'?${channel.replace('-', '\\-')}'?: function \\(`).test(bridgeJs),
      `桥接层有 ${channel} 通道的处理器`
    );
  }

  // ---- 4. 就绪信号 ----
  //
  // **这是唯一的就绪信号。** iframe 的 `load` 事件在一个加载失败的文档上照样会
  // 触发（引擎拿它自己画的那张错误页触发它），因此宿主那边不能用它判断成功。
  check(
    /window\.parent\.postMessage\(\{ __modulith: true, channel: 'ready' \}, '\*'\)/.test(bridgeJs),
    "桥接层就绪后向 window.parent 发一条 ready（它是宿主唯一骗不过自己的信号）"
  );
  // 这里的 `'*'` 是**必需**的：那个文档读不到宿主自己的来源。它不构成泄露 ——
  // `postMessage` 只投递给 `window.parent` 一个窗口，而那条消息里只有这两个字段。
  // 真正不许可的是**转发宿主推送**时用 `'*'`（那时来源是已知的，见 §10）。
  check(
    !/postToSurface[\s\S]{0,200}'ready'/.test(bridgeJs),
    'ready 只有桥接层自己发（宿主不该再去转一条来源不明的 ready）'
  );

  // ---- 5. 令牌也是桥接层地址的来源 ----
  //
  // 桥接层**从地址读令牌**，不再由宿主送一个 `__PLUGIN_ID__` 给它拼 URL。
  // 少了这一段，`RPC_ROOT` 会是 `//rpc/` —— 而症状是所有 RPC 一起 404。
  check(
    /var path = String\(window\.location\.pathname \|\| ''\)/.test(bridgeJs) &&
      /split\('\/'\)\[0\]/.test(bridgeJs),
    '桥接层从 location.pathname 的第一段读令牌（不再按插件 id 拼地址）'
  );
  check(
    /var RPC_ROOT = '\/' \+ TOKEN \+ '\/rpc\/'/.test(bridgeJs) &&
      /var DATA_ROOT = '\/' \+ TOKEN \+ '\/data\/'/.test(bridgeJs),
    'RPC 与数据的地址都由令牌拼出来'
  );

  // ---- 6. 宿主侧确实把推送发到**主窗口** ----
  //
  // 令牌与 iframe 的绑定在前端那一个文档里，别的窗口（托盘菜单、自检窗口）
  // 收到也做不了任何事。少了 `emit_to` 而用 `emit`，每条推送都会多绕一圈。
  const pushFn = /pub\(super\) fn push_to<R: Runtime>\([\s\S]*?\n\}/.exec(sandboxRs)?.[0] ?? '';
  check(pushFn.length > 0, '能定位到 push_to 的函数体');
  check(
    /app\.emit_to\(\s*crate::core::window::MAIN_WINDOW,\s*PUSH_EVENT,/.test(pushFn),
    'push_to 只推给主窗口（令牌与 iframe 的绑定在那一个文档里）'
  );
  check(
    /"token": token, "channel": channel, "payload": payload/.test(pushFn),
    '推送负载带令牌、通道、负载三件（少了令牌前端分不清该转给哪一块界面）'
  );
  check(
    /pub const PUSH_EVENT: &str = "modulith:\/\/sandbox-push"/.test(sandboxRs) &&
      /const PUSH_EVENT = 'modulith:\/\/sandbox-push'/.test(
        read('../src/services/sandboxSurface.ts')
      ),
    '宿主与前端用的推送事件名逐字相同（两边的字符串约定）'
  );
  // 宿主侧的通道名必须与桥接层那张处理器表对得上。少一条的表现是那一类推送
  // 到了前端却没人处理 —— 与"宿主根本没推"完全一样。
  for (const channel of ['"theme"', '"shortcuts"', '"command"', '"download-progress"', '"close"']) {
    check(
      sandboxRs.includes(`push_to(app, &token, ${channel},`) ||
        new RegExp(`push_to\\(app, &token, ${channel.replace(/"/g, '"')}`).test(sandboxRs),
      `宿主侧真的有 ${channel} 通道的推送`
    );
  }
  check(
    /super::sandbox::push_to\(app, &token, "event", envelope\.clone\(\)\)/.test(
      read('../src-tauri/src/modules/plugins/rpc.rs')
    ),
    '跨插件事件也走 push_to 的 event 通道（它是同步的，不再拼脚本）'
  );
}

// ============================================================
// 文件拖放（ctx.fileDrop）
// ============================================================
//
// 它长期记在"沙箱里没有"那一栏，理由是"拖放是窗口级事件，子 webview 收不到"。
// 核对 wry 之后发现那个理由只对了一半：wry 把拖放处理器注册在 **webview 自己的
// HWND 及其全部子窗口**上（wry-0.55.1/src/webview2/drag_drop.rs:50 枚举子窗口
// 并按个 RegisterDragDrop）。子 webview 有自己的 HWND，而它**没有**注册处理器 ——
// 于是落在它上面的文件既不进宿主窗口的处理器，也没有东西接住。那条路径从根上是
// 断的。换成 iframe 之后指针底下始终是**主 webview 的 HWND**，事件照常触发，
// 而且带指针位置。
//
// 这一节守的是那条新链路：**宿主判定权限 → 前端按位置筛 → 桥接层扇出**。
// 三处缺一，插件就收不到拖放 —— 而三种缺法的症状一模一样："拖进去没反应"。

section('文件拖放（ctx.fileDrop）');

{
  const bare = strip(sandboxRs);

  // ---- 1. 权限由宿主判定，不由前端 ----
  check(
    /pub const FILE_DROP_PERMISSION: &str = "filesystem-read"/.test(bare),
    '拖放要的权限是一个有名字的常量（写成字面量就有了几处会漂的地方）'
  );
  check(
    /file_drop:\s*view\s*\.permissions\s*\.iter\(\)\s*\.any\(\|p\|\s*p\s*==\s*FILE_DROP_PERMISSION\)/.test(
      bare
    ),
    '签发界面时由**宿主**算出"这一界面能不能收拖放"（前端不自己查清单）'
  );
  check(
    /pub file_drop: bool/.test(bare),
    'SurfaceHandle 把这一位交给前端（少了它前端只能广播，后台插件会收到别人的拖放）'
  );

  // ---- 2. 前端按位置筛 ----
  const surfaceTsx = strip(read('../src/components/SandboxSurface.tsx'));

  check(
    /current\.fileDrop/.test(surfaceTsx),
    '前端按宿主给的那一位判断要不要转（自己查清单就是又一处会漂的权限映射）'
  );
  check(
    /devicePixelRatio/.test(surfaceTsx),
    '把拖放的**物理像素**换算成 CSS 像素（不换算的话，缩放不是 100% 时命中的是另一块区域）'
  );
  check(
    /getBoundingClientRect\(\)[\s\S]{0,240}?rect\.left/.test(surfaceTsx),
    '按矩形命中测试决定这次拖放归谁（Home 里各标签面板是叠在一起、靠 visibility 藏的，只按 active 判会让下面那一摞都收到）'
  );
  check(
    /'file-drop'/.test(surfaceTsx),
    '转交走 file-drop 通道（另写一条消息类型会绕开桥接层那张处理器表）'
  );
  check(
    /dragInsideRef/.test(surfaceTsx),
    'leave 靠"上一次真的进来了"认领 —— 那一条不带指针位置，命中测试对它无效'
  );

  // ---- 3. 坐标本身要真的被带过来 ----
  const fileDropTs = strip(read('../src/services/fileDrop.ts'));
  check(
    /position\?: \{ x: number; y: number \}/.test(fileDropTs),
    'FileDropEvent 带着指针位置（少了它前端只能广播）'
  );
  check(
    /Number\.isFinite/.test(fileDropTs),
    '位置只在两个分量都是有限数时才带上（NaN 的比较永远为假，症状是拖放静默失效）'
  );

  // ---- 4. 桥接层扇出，且形态与 in-process 一致 ----
  const bridgeBare = strip(bridgeJs);
  check(
    /'file-drop': function \(payload\)/.test(bridgeBare),
    '桥接层有 file-drop 通道的处理器'
  );
  check(
    /fileDrop: fileDrop/.test(bridgeBare),
    'Modulith.fileDrop 存在（不在的话同一份插件代码在两侧要改一行）'
  );
  check(
    /isAvailable: function \(\)/.test(bridgeBare) &&
      /subscribe: function \(handler\)/.test(bridgeBare),
    'fileDrop 的形态与 in-process 一致（isAvailable + subscribe）'
  );
  check(
    /if \(!has\('filesystem-read'\)\)/.test(bridgeBare),
    '未声明权限时降级为空订阅 + 一次告警（与宿主侧 pluginFileDrop 同一条规矩）'
  );
}

// ============================================================
// 收尾
// ============================================================

console.log(`\n共 ${total} 项断言，失败 ${failed} 项。`);
if (failed > 0) {
  process.exitCode = 1;
}