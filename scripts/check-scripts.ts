// scripts/check-scripts.ts
//
// 脚本 project 的两条不变量
//
//   node scripts/check-scripts.ts
//
// ---------------------------------------------------------------------------
// 为什么需要这个脚本
//
// `tsc -p tsconfig.node.json` 曾经**整整三个版本没有生效过**：109 个错误、
// 横跨 15 个文件，而真实错误全被埋在下面。根因不是一个笔误，而是**用"编译失败"
// 去表达一条意图** —— 只要有人 import 一个带 DOM 用法的模块，整次检查就整体失效，
// 而失效的样子是"报一大堆积压的无关错误"，没有人会去读。
//
// 那条意图是："脚本只依赖能在 Node 里求值的纯逻辑模块。" 它是真的、也是必需的：
// `check-sounds.ts` 用桩音频上下文真的跑一遍合成，`check-markdown.ts` 真的跑解析器
// —— 这些模块一旦开始引用浏览器全局对象，脚本会在运行期炸掉。
//
// 所以这里把那条意图拆成两条**能单独失败、并且能说清自己是哪一条**的断言。
// `tsc` 那边则显式声明 DOM 与 jsx，让它回到"报告真实类型错误"这个本职上。
// ---------------------------------------------------------------------------

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

/**
 * 去掉 JS/TS 注释。
 *
 * 必须做：这些模块的文档注释里**大量引用**浏览器 API 的名字（`notificationSounds.ts`
 * 的头部就在解释"为什么不用 DOM 的 `AudioContext`"），不剥注释就会把解释当成违规。
 * 这与 `check-theme.ts` / `check-markdown.ts` 处理注释是同一个原因。
 *
 * 它不处理字符串里的 `//`，但那只会让人**多**报一处可见的位置，不会漏报。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 读取带注释的 JSON（两个 tsconfig 都写了注释，`JSON.parse` 吃不下）。
 *
 * **只剥离"整行就是注释"的形式**，这一条约束是必需的而不是保守：这两个文件里
 * 合法地含有 `"@/*"` 这样的取值，而它内部就带着注释起始符。一个"看到注释起始符
 * 就当注释开始"的正则会把那一行从中间剪断，报出来的错是
 * "Bad control character in string literal" —— 与真正的原因毫无关系。
 * （这个坑在写这个脚本时当场踩到过一次。）
 *
 * 代价是"写在代码行尾的块注释"剥不掉，那种写法会让 `JSON.parse` 抛错。
 * 抛错是可见的失败，方向是安全的。
 */
function readJsonc(relative: string): Record<string, unknown> {
  const source = read(relative)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  try {
    return JSON.parse(source) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${relative} 无法解析：${error instanceof Error ? error.message : String(error)}。` +
        '最常见的原因是出现了"写在代码行尾"的注释 —— 本函数只剥离整行注释。'
    );
  }
}

// ============================================================
// 1. 脚本直接依赖的模块必须能在 Node 里求值
// ============================================================

console.log('纯逻辑边界：');

/**
 * 被 `scripts/**` 直接 import、并在**没有浏览器**的 Node 进程里真的被执行的模块。
 *
 * 这份名单不是"凡是纯的都要写进来"，而是"**它不纯就会让某个脚本在运行期炸掉**"。
 * 因此名单只覆盖脚本的直接依赖：`src/types/module.ts` 之类不在这里 —— 它依赖
 * React 的**类型**（不是运行期值），脚本引它不会出问题。
 */
const PURE_MODULES = [
  'src/utils/motionPreference.ts',
  'src/utils/glassPreference.ts',
  'src/utils/notificationSounds.ts',
  'src/utils/markdown.ts',
  'src/utils/semver.ts',
  'src/utils/updateCheck.ts',
  'src/utils/networkSettings.ts',
  'src/config/pluginRegistry.ts',
  'src/services/moduleComponentCache.ts',
  'src/services/pluginContributions.ts',
  'src/services/pluginShape.ts',
  // 仪表盘拖动落点的换算。它是纯函数，被 `check-memory.ts` 直接 import 并执行 ——
  // 一旦它开始引用浏览器全局对象，那条断言就会在 Node 里炸掉。
  'src/modules/dashboard/dropIndex.ts',
];

/**
 * 违规判据。
 *
 * `AudioContext` 那条**带一个否定前瞻**：`notificationSounds.ts` 刻意声明了自己的
 * `AudioContextLike` 结构类型，而不是用 DOM 的 `AudioContext` —— 那正是它能在 Node 里
 * 被检查的原因（见该文件头部）。因此禁止的是"真正的那个全局构造器"，不是这个名字
 * 出现在类型名里。要新增自己的结构类型时，照 `…Like` 命名即可。
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bdocument\s*[.(]/, 'document'],
  [/\bwindow\s*[.(]/, 'window'],
  [/\bnavigator\s*\./, 'navigator'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\brequestAnimationFrame\b/, 'requestAnimationFrame'],
  [/\bHTMLElement\b/, 'HTMLElement'],
  [/\bAudioContext(?!Like)\b/, 'AudioContext（要用结构类型请命名成 …Like）'],
  [/\bnew\s+Audio\s*\(/, 'new Audio()'],
  [/\bnew\s+Worker\s*\(/, 'new Worker()'],
  [/\bfrom\s+['"]react['"]/, "import 'react'"],
];

for (const relative of PURE_MODULES) {
  let source: string;
  try {
    source = stripComments(read(relative));
  } catch {
    check(false, `${relative} 存在（名单里的文件被删掉时这里会红）`);
    continue;
  }

  const hits = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, name]) => name);
  check(
    hits.length === 0,
    hits.length === 0
      ? `${relative} 不含浏览器全局对象与 React`
      : `${relative} 引用了 ${hits.join('、')} —— 它被脚本直接 import 并在 Node 里执行，这会让脚本在运行期炸掉`
  );
}

// ============================================================
// 2. 两个 tsconfig 的路径别名必须一致
// ============================================================
//
// `tsconfig.node.json` 会沿 import 走进 `src/modules/**`（脚本加载整条
// `pluginRuntime` 依赖图，而它经生成的注册表指到 `Dashboard.tsx`），那些文件用的是
// `@/...` 别名。别名清单必须在两个 project 里重复一次，而漂移的表现是一条
// **看起来与别名无关**的 TS2307「找不到模块」。

console.log('\ntsconfig 一致性：');

const srcConfig = readJsonc('tsconfig.json') as {
  compilerOptions?: Record<string, unknown>;
};
const nodeConfig = readJsonc('tsconfig.node.json') as {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
};

const normalize = (paths: unknown): string => {
  if (!paths || typeof paths !== 'object') return '<缺失>';
  const entries = Object.entries(paths as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return JSON.stringify(entries);
};

check(
  normalize(srcConfig.compilerOptions?.paths) !== '<缺失>',
  'tsconfig.json 声明了 paths'
);
check(
  normalize(srcConfig.compilerOptions?.paths) === normalize(nodeConfig.compilerOptions?.paths),
  '两个 project 的 paths 逐条一致（少一条就是一条 TS2307，而且看不出与别名有关）'
);

check(
  (nodeConfig.include ?? []).includes('scripts/**/*.ts'),
  'tsconfig.node.json 的 include 覆盖 scripts/**/*.ts'
);
// `composite` 要求 program 里的每个文件都出现在 include 里（TS6307）。脚本会
// 通过 import 拉进一长串 src 模块，手工维护那张清单实测漏了 24 个文件，因此
// 这里用 `incremental` 代替 —— 增量编译并不依赖 composite。
check(
  !('composite' in (nodeConfig.compilerOptions ?? {})) ||
    nodeConfig.compilerOptions?.composite !== true,
  'tsconfig.node.json 不用 composite（它要求 include 完备，而那必然漏）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
