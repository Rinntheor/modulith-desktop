// scripts/check-acl.ts
//
// 应用级 ACL（capability / permission）的**门禁**。
//
//   node scripts/check-acl.ts
//
// ============================================================
// 它守的是什么
// ============================================================
//
// 在 `src-tauri/build.rs` 声明应用级 ACL 清单之前，Tauri 对**应用自己注册的命令
// 完全不设门禁**。判定条件在 `tauri/src/webview/mod.rs` 的 `on_message()`：
//
//     if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
//        && invoke.acl.is_none() { 拒绝 }
//
// 本机来源的 webview 调非插件命令时，`has_app_acl_manifest` 为 false 就走不到
// 拒绝分支 —— 于是**任何一个 webview 都能调全部 120 条命令**，包括托盘菜单那个
// 一条 capability 都没有的窗口。这不是"配置写宽了"，是"根本没查"。
//
// 声明清单之后语义反转成默认拒绝：每条命令必须被某个 capability 明确授权。
// 于是这个脚本要守的就不是"配置对不对"，而是**三份列表必须一致**：
//
//   lib.rs 的 generate_handler!  ←→  build.rs 的 AppManifest::commands
//                                 ←→  capabilities/ 里的授权集合
//
// 不一致的两种方向，后果完全不同，但都只在运行期暴露：
//
//   · build.rs 少一条 → 那条命令**没有任何 capability 能授权它** → 对所有人不可用；
//   · capability 多一条 → 授权给了一个不存在的命令 → 构建期就报错（这条较轻）。
//
// ============================================================
// 为什么必须盯住 `windows` 这个键
// ============================================================
//
// capability 的 `windows` 与 `webviews` 语义不同（Tauri 官方文档原文）：
//
//   · `webviews` —— 只发给标签匹配的那些 webview；
//   · `windows`  —— **发给该窗口下的所有 webview**，与 `webviews` 怎么写无关。
//
// 插件沙箱（v2.0）会把插件 webview 放进主窗口。那一刻，任何一处写成
// `"windows": ["main"]` 都会把整份宿主授权——包括全部 120 条应用命令——送给插件，
// 而**构建、类型检查、其余门禁全都不会变红**。所以这里有一条断言：任何 capability
// 都不许使用 `windows` 键。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const readSource = (relative: string): string => readFileSync(resolve(here, relative), 'utf8');

const libRs = readSource('../src-tauri/src/lib.rs');
const buildRs = readSource('../src-tauri/build.rs');
const tauriConf = JSON.parse(readSource('../src-tauri/tauri.conf.json')) as {
  app: { windows: Array<{ label: string }> };
};

const capabilitiesDir = resolve(here, '../src-tauri/capabilities');

// ============================================================
// 解析：块内每一行都必须匹配预期形状，否则直接失败
// ============================================================
//
// 这里刻意不"尽量多读一点"。手写解析器此前连续被真实代码打穿（见
// check-plugin-boundary.ts 的说明）：它读不全时不会报错，只会给出一个偏小的集合，
// 而那正好会让"少了一条"这条断言**静默通过**。所以块内出现任何不认识的行走法，
// 都当成解析失败处理。

/** 从 `open` 标记之后到 `close` 标记之前，逐行抽取。任何一行不匹配 `linePattern` 就抛错。 */
function extractBlock(
  source: string,
  file: string,
  openMarker: string,
  closePattern: RegExp,
  linePattern: RegExp,
  describe: string
): string[] {
  const openIndex = source.indexOf(openMarker);
  if (openIndex < 0) {
    throw new Error(`${file}：找不到 ${openMarker}`);
  }

  const afterOpen = source.slice(openIndex + openMarker.length);
  const closeMatch = closePattern.exec(afterOpen);
  if (!closeMatch) {
    throw new Error(`${file}：${openMarker} 之后找不到结束标记`);
  }

  const body = afterOpen.slice(0, closeMatch.index);
  const values: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    const match = linePattern.exec(line);
    if (!match) {
      throw new Error(`${file}：${describe} 里出现无法解析的一行：${JSON.stringify(line)}`);
    }
    values.push(match[1]);
  }

  return values;
}

const handlerCommands = (() => {
  try {
    return extractBlock(
      libRs,
      'src-tauri/src/lib.rs',
      'generate_handler![',
      /^\s*\]\);/m,
      /^([a-z][a-z0-9_]*),$/,
      'generate_handler!'
    );
  } catch (error) {
    // 解析失败**不能**退化成"集合偏小"的正常结果 —— 那正好会让下面每一条
    // "没有漏掉"的断言全部通过。宁可整体失败。
    console.error(`\n解析 lib.rs 的 generate_handler! 失败：${(error as Error).message}\n`);
    process.exit(1);
  }
})();

const manifestCommands = (() => {
  try {
    return extractBlock(
      buildRs,
      'src-tauri/build.rs',
      'AppManifest::new().commands(&[',
      /^\s*\]\),?/m,
      /^"([a-z][a-z0-9_]*)",$/,
      'AppManifest::commands'
    );
  } catch (error) {
    // 这一条是**插件沙箱的主屏障**，而它不成立时的症状是"一切都正常"。
    //
    // 实测过一次，插件 webview 调宿主命令时日志里有**两条**独立记录：
    //   1. `connect-src 拦下了 http://ipc.localhost/get_app_info`（CSP，引擎执行）
    //   2. `get_app_info not allowed on window "main", webview "plugin-selftest"`
    //      （ACL，Rust 的 IPC 入口）
    //
    // 第 1 条**不承重**：Tauri 的 IPC 在 fetch 失败后会回退到
    // `window.ipc.postMessage`（见 tauri 的 `scripts/ipc-protocol.js`），
    // 那是一条原生桥，不受 CSP 管辖。真正挡住它的是 ACL —— 而 ACL 只在应用
    // 声明过 app manifest 时才对**应用自己的**命令生效。
    //
    // 也就是说：删掉 build.rs 里这一句，插件会重新拿到全部 120 条命令，
    // 而构建、类型检查与其余门禁都不会变红。所以这里不是"报个错"，
    // 是把那句话写出来。
    console.error(
      `\n在 build.rs 里找不到 AppManifest::commands：${(error as Error).message}\n\n` +
        '这是插件沙箱的主屏障。没有它，插件 webview 能调全部应用命令 ——\n' +
        'CSP 挡不住它（Tauri 的 IPC 有 postMessage 回退路径），其余门禁也不会报错。\n'
    );
    process.exit(1);
  }
})();

const slug = (command: string): string => command.replace(/_/g, '-');

// ============================================================
// capability 文件
// ============================================================

interface CapabilityFile {
  name: string;
  identifier: string;
  windows?: string[];
  webviews?: string[];
  permissions: Array<string | { identifier: string; allow?: unknown }>;
}

const capabilityFiles: CapabilityFile[] = readdirSync(capabilitiesDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => {
    const parsed = JSON.parse(readFileSync(join(capabilitiesDir, name), 'utf8')) as CapabilityFile;
    return { ...parsed, name };
  });

const permissionId = (entry: string | { identifier: string }): string =>
  typeof entry === 'string' ? entry : entry.identifier;

/** 一个 capability 里所有不带 `plugin:` 前缀的权限 = 应用自己的命令授权 */
function appPermissions(capability: CapabilityFile): string[] {
  return capability.permissions
    .map(permissionId)
    .filter((id) => !id.includes(':'));
}

// ============================================================
// 1. 三份列表逐条一致
// ============================================================
section('命令列表的一致性');

check(handlerCommands.length > 0, `generate_handler! 解析出 ${handlerCommands.length} 条命令`);
check(manifestCommands.length > 0, `AppManifest::commands 解析出 ${manifestCommands.length} 条命令`);
check(
  handlerCommands.length === manifestCommands.length,
  `两处命令数量一致（generate_handler! ${handlerCommands.length} 条，build.rs ${manifestCommands.length} 条）`
);

{
  const handlerSet = new Set(handlerCommands);
  const manifestSet = new Set(manifestCommands);

  const missingInManifest = handlerCommands.filter((c) => !manifestSet.has(c));
  const missingInHandler = manifestCommands.filter((c) => !handlerSet.has(c));

  check(
    missingInManifest.length === 0,
    missingInManifest.length === 0
      ? 'build.rs 没有漏掉任何一条已注册命令'
      : `build.rs 漏了这些命令（它们将对所有人不可用）：${missingInManifest.join(', ')}`
  );
  check(
    missingInHandler.length === 0,
    missingInHandler.length === 0
      ? 'build.rs 没有多出任何一条未注册命令'
      : `build.rs 多出了这些命令：${missingInHandler.join(', ')}`
  );
}

// ============================================================
// 2. 授权集合与命令列表一致
// ============================================================
section('授权集合');

const appCommandCapability = capabilityFiles.find((c) => c.identifier === 'app-commands');
check(appCommandCapability !== undefined, '存在 app-commands capability');

if (appCommandCapability) {
  const granted = appPermissions(appCommandCapability);
  const expected = manifestCommands.map((c) => `allow-${slug(c)}`);

  check(
    granted.length === expected.length,
    `授权条数与命令数一致（授权 ${granted.length} 条，命令 ${expected.length} 条）`
  );

  const grantedSet = new Set(granted);
  const expectedSet = new Set(expected);

  const underGranted = expected.filter((id) => !grantedSet.has(id));
  const overGranted = granted.filter((id) => !expectedSet.has(id));

  check(
    underGranted.length === 0,
    underGranted.length === 0
      ? '每条命令都被授权了（没有"谁都调不动"的命令）'
      : `这些命令没有被授权：${underGranted.join(', ')}`
  );
  check(
    overGranted.length === 0,
    overGranted.length === 0
      ? '没有授权不存在的命令'
      : `授权了不存在的命令：${overGranted.join(', ')}`
  );

  // 幂等：slug 规则必须与 tauri-build 的 `identifier = "allow-{command.replace('_','-')}"` 一致。
  // 这条断言存在的理由是它**不是**显然的：一个写成下划线的 `allow_get_auth_status`
  // 在构建期会被 Tauri 拒绝（未知权限），但只有真的构建才会发现。
  check(
    granted.every((id) => id === id.toLowerCase() && !id.includes('_')),
    '授权标识符都是 kebab-case（与 tauri-build 的自动生成规则一致）'
  );

  check(
    appCommandCapability.permissions.every((entry) => !permissionId(entry).includes(':')),
    'app-commands 只包含应用自己的命令授权，不混入 core:/插件权限'
  );
}

// ============================================================
// 3. 绝不许使用 `windows` 键
// ============================================================
section('capability 的作用域键');

for (const capability of capabilityFiles) {
  check(
    capability.windows === undefined,
    capability.windows === undefined
      ? `${capability.name} 未使用 windows 键`
      : `${capability.name} 使用了 windows 键 —— 它会把授权发给该窗口下的所有 webview（包括将来的插件 webview）`
  );
}

// ============================================================
// 3b. 插件 webview 必须一条权限都没有
// ============================================================
//
// 这是插件的**全部安全依据**：`plugin-<id>` 这些 webview 不匹配任何 capability，
// 于是 Tauri 在 IPC 入口拒绝它们的每一次 invoke —— 包括全部 120 条应用命令。
//
// 插件与宿主之间的通信不走 IPC，而走自定义协议（见 plugins/sandbox.rs）：
// 协议不受 capability 管辖，且处理器能拿到发起请求的 webview 标签，
// 因此插件**不需要**任何 IPC 权限就能干活。这条断言守的正是那个"不需要"。
//
// 一旦有人给插件 webview 加了一条哪怕最小的 capability（比如为了图省事发个事件），
// 它就重新获得了 IPC 通道，整套模型退回成"插件自报身份"。构建、类型检查、
// 其余门禁都不会因此变红 —— 所以必须有这一条。

section('插件 webview 的授权（必须为零）');

{
  const sandboxRs = readSource('../src-tauri/src/modules/plugins/sandbox.rs');
  const prefixMatch = /pub const LABEL_PREFIX:\s*&str\s*=\s*"([^"]+)"/.exec(sandboxRs);
  check(prefixMatch !== null, 'sandbox.rs 里能找到 LABEL_PREFIX');

  const prefix = prefixMatch ? prefixMatch[1] : 'plugin-';
  check(
    prefix === 'plugin-',
    `webview 标签前缀是 ${JSON.stringify(prefix)}（改了它就要同步这条门禁与文档）`
  );

  // Tauri 的匹配是 glob。这里不实现完整 glob，只判定"这个模式会不会命中
  // 一个以插件前缀开头的标签" —— 对真实会写出来的两种形式（`*` 与 `plugin-*`）
  // 都覆盖到了。
  const matchesPluginLabel = (pattern: string): boolean =>
    pattern === '*' || pattern.startsWith(prefix);

  const offenders: string[] = [];
  for (const capability of capabilityFiles) {
    for (const pattern of capability.webviews ?? []) {
      if (matchesPluginLabel(pattern)) {
        offenders.push(`${capability.name} → ${pattern}`);
      }
    }
  }

  check(
    offenders.length === 0,
    offenders.length === 0
      ? '没有任何 capability 把插件 webview 纳入作用域（它们因此没有 IPC 权限）'
      : `这些 capability 会把 IPC 权限发给插件 webview，整套沙箱模型因此失效：${offenders.join(', ')}`
  );

  // 协议名不能与 Tauri 自己注册的取同名 —— 那会把它顶掉，而且症状是
  // "某个内置能力莫名失效"，很难归因到这一行。Tauri 注册的是这三个。
  const schemeMatch = /pub const SCHEME:\s*&str\s*=\s*"([^"]+)"/.exec(sandboxRs);
  check(schemeMatch !== null, 'sandbox.rs 里能找到 SCHEME');

  const scheme = schemeMatch ? schemeMatch[1] : '';
  check(
    !['tauri', 'ipc', 'asset'].includes(scheme),
    `协议名 ${JSON.stringify(scheme)} 没有与 Tauri 内置的三个（tauri / ipc / asset）冲突`
  );

  // ORIGIN 必须与 SCHEME 对得上。这两个字符串分开写是因为平台不同（Windows 上
  // 是 `http://<scheme>.localhost`，别处是 `<scheme>://localhost`），
  // 但改了一个忘了另一个的症状是"页面加载不出来"，也不会让别的检查变红。
  const originMatch = /pub const ORIGIN:\s*&str\s*=\s*"([^"]+)"/.exec(sandboxRs);
  check(originMatch !== null, 'sandbox.rs 里能找到 ORIGIN');
  check(
    originMatch !== null && originMatch[1].includes(scheme),
    `ORIGIN 与 SCHEME 一致（ORIGIN=${JSON.stringify(originMatch ? originMatch[1] : '')}，SCHEME=${JSON.stringify(scheme)}）`
  );
}

// ============================================================
// 4. 授权对象必须是真的窗口，且每个窗口都被覆盖
// ============================================================
section('窗口标签的覆盖');

const declaredLabels = tauriConf.app.windows.map((w) => w.label).sort();

// 插件 webview 的标签在 v2.0 才会出现，这里先放行这个前缀，但**只放行前缀**：
// 一个写成 `plugin-*` 通配的 capability 将来才可能是对的，而写成别的标签
// （例如某个不存在的窗口）应当立刻失败。
const KNOWN_LABEL_PATTERNS: RegExp[] = [/^main$/, /^tray-menu$/, /^plugin-\*$/];

{
  const unknownTargets: string[] = [];
  for (const capability of capabilityFiles) {
    for (const label of capability.webviews ?? []) {
      if (!KNOWN_LABEL_PATTERNS.some((pattern) => pattern.test(label))) {
        unknownTargets.push(`${capability.name} → ${label}`);
      }
    }
  }
  check(
    unknownTargets.length === 0,
    unknownTargets.length === 0
      ? '所有 capability 都指向真实存在的窗口标签'
      : `指向了不存在的窗口标签：${unknownTargets.join(', ')}`
  );
}

{
  const covered = new Set<string>();
  for (const capability of capabilityFiles) {
    for (const label of capability.webviews ?? []) covered.add(label);
  }

  const uncovered = declaredLabels.filter((label) => !covered.has(label));
  check(
    uncovered.length === 0,
    uncovered.length === 0
      ? `tauri.conf.json 里声明的 ${declaredLabels.length} 个窗口都被 capability 覆盖`
      : `这些窗口没有任何 capability，因此清单声明后它们连 IPC 都用不了：${uncovered.join(', ')}`
  );
}

// ============================================================
// 5. 托盘菜单窗口：授权必须恰好等于它真正调用的命令
// ============================================================
//
// 这条断言的形状是"恰好"，而不是"包含"。两个方向都有真实后果：
//   · 少给 → 托盘菜单那个开关点了没反应，而且只在运行期暴露；
//   · 多给 → 一个只负责显示菜单的窗口拿到了本不需要的能力，没有任何依据。
//
// 它同时是这一轮改动里**唯一一处能自动化验证的部分**：应用在本机跑不起来
// （见 docs/06-项目/已知问题与技术债.md 里那条先于应用代码的启动阻塞），
// 所以"托盘菜单还能用吗"这个问题只能靠静态比对回答。

section('托盘菜单窗口的授权');

{
  const trayMenuDir = resolve(here, '../src/tray-menu');
  const invoked = new Set<string>();

  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;

      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z][a-z0-9_]*)'/g)) {
        invoked.add(match[1]);
      }
    }
  };

  // 目录不存在时**必须失败**，不能静默给出空集合 —— 那会让下面两条断言都变成
  // "0 == 0" 的假通过。
  if (!existsSync(trayMenuDir)) {
    check(false, 'src/tray-menu 目录存在');
  } else {
    scan(trayMenuDir);

    const trayCapability = capabilityFiles.find((c) => c.identifier === 'tray-menu');
    check(trayCapability !== undefined, '存在 tray-menu capability');

    if (trayCapability) {
      check(
        invoked.size > 0,
        `从 src/tray-menu 解析出 ${invoked.size} 条 invoke 调用`
      );

      const granted = new Set(appPermissions(trayCapability).map((id) => id.replace(/^allow-/, '')));
      const wanted = new Set([...invoked].map(slug));

      const notGranted = [...wanted].filter((c) => !granted.has(c));
      const notUsed = [...granted].filter((c) => !wanted.has(c));

      check(
        notGranted.length === 0,
        notGranted.length === 0
          ? '托盘菜单用到的命令都被授权了'
          : `托盘菜单调用了但没被授权的命令：${notGranted.join(', ')}`
      );
      check(
        notUsed.length === 0,
        notUsed.length === 0
          ? '托盘菜单没有多拿任何授权'
          : `托盘菜单拿了用不到的授权：${notUsed.join(', ')}`
      );
    }
  }
}

// ============================================================
// 6. 自动生成的权限文件不进仓库
// ============================================================
//
// `permissions/autogenerated/` 是 tauri-build 每次构建**重新生成**的派生物，
// 一份命令一个文件（当前是 120 个）。把它提交进仓库等于给每一处命令改动
// 附上 120 个文件的 diff，而其中任何一个都不会有人真的看。
//
// 判据是 `.gitignore` 里有没有那条规则 —— 不是"当前有没有被提交"，因为
// 后者要跑 git 才能知道，而这个脚本刻意不依赖 git（它在无 .git 的环境里也要能跑）。

section('派生物不进仓库');

{
  const gitignore = readSource('../src-tauri/.gitignore');
  check(
    /^\s*\/permissions\/autogenerated\/?\s*$/m.test(gitignore),
    'src-tauri/.gitignore 忽略了 permissions/autogenerated（构建期重新生成的派生物）'
  );
}

// ============================================================
// 收尾
// ============================================================

console.log(`\n共 ${total} 项断言，失败 ${failed} 项。`);
if (failed > 0) {
  process.exitCode = 1;
}
