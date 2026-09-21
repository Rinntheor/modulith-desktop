// scripts/check-theme.ts
//
// 深色模式映射与浮层外观的验证脚本
//
//   node scripts/check-theme.ts
//
// 为什么需要这个脚本：`dark-theme.css` 是一张**按工具类名精确匹配**的覆盖表，
// 它的失败方式非常安静 —— 某个档位漏了映射，那个元素就退回浅色，界面不报错、
// 类型检查也不报错，只在深色模式的屏幕上表现为「一块灰白」。这个坑在项目里
// 已经发生过至少四次（标签栏 `bg-white/85`、搜索框 `bg-gray-50/80`、
// `bg-gray-900/40` 被映射成实心、`bg-gray-200/70` 分隔线与
// `group-hover:bg-gray-900/10` 漏映射），第五次是设置 → 备份的选中行：
// `bg-indigo-50/40` 漏映射，而初版脚本的颜色族只覆盖白/黑/灰，因此**扫不到它**。
//
// 因此这里做的是**覆盖率**检查：把 src/ 里实际用到的半透明背景 token 全部
// 扫出来，逐个核对深色表里有没有对应条目。新增一个档位而忘了补映射，这个脚本
// 直接失败，而不是等到某天有人在深色模式下看见它。
//
// 文本核对而不是渲染核对：这个脚本跑在 Node 里，没有浏览器。它守的是
// 「表是完整的」这个不变量，像素级的观感仍由人看。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
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

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), 'utf-8');
}

/** 去掉 CSS 注释（断言查的是选择器与声明，注释里可以合法地引用它们） */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 去掉 JS/TS 注释。
 *
 * 必须做：文档注释里会引用工具类名（例如解释「这里曾经用 bg-white/15」），
 * 不去掉就会被当成真实用法，报出一个不存在的问题。
 *
 * 这不是一个完整的 TS 词法分析器 —— 它不处理字符串里的 `//`（例如 URL）。
 * 那类情况最多让**少**扫到一些 token，不会产生假报错：本脚本的职责是
 * 「用到的档位必须有映射」，漏扫的结果是漏报而不是误报，方向是安全的。
 */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // generated 是构建产物且不入库，它的类名来自生成器而不是人手写的
      if (entry === 'generated' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

// ============================================================
// 1. 导入顺序：这张表靠「后加载」取胜
// ============================================================

console.log('样式加载顺序：');

const indexCss = stripCssComments(read('src/styles/global/index.css'));
const positionOf = (needle: string) => indexCss.indexOf(needle);
const tailwindAt = positionOf("@import 'tailwindcss'");
const darkAt = positionOf("@import './dark-theme.css'");
const accentAt = positionOf("@import './accent.css'");

check(tailwindAt >= 0, "index.css 导入了 tailwindcss");
check(darkAt >= 0, "index.css 导入了 dark-theme.css");
check(accentAt >= 0, "index.css 导入了 accent.css");
check(
  tailwindAt < darkAt && darkAt < accentAt,
  '加载顺序是 tailwindcss → dark-theme → accent（调换任何一处，深色或配色覆盖会整体失效）'
);

// ============================================================
// 2. 半透明背景 token 的深色映射覆盖率
// ============================================================

console.log('\n深色映射覆盖率：');

const darkTheme = stripCssComments(read('src/styles/global/dark-theme.css'));

/**
 * 有意不映射的 token，必须写明理由。
 *
 * 只允许两类，其他一律要补映射：
 *
 *   1. **这个元素本来就只出现在常驻深色界面里** —— 那种界面不受深浅模式影响
 *      （`dark-theme.css` 第 8 节专门保护它们），给它补一条映射反而会把原本
 *      正确的深色配色改坏。
 *   2. **颜色本身是中间明度或更深的强调色**（`-400` 及以下档位、`-600/10`
 *      这类淡染）。这张表要防的失败模式是"浅色底在深色下退化成一块发白的
 *      板子"，而这些颜色在深色底上本来就是可读的，反相它反而是错的。
 *
 * 反面例子（曾经真的漏过，见下）：`bg-indigo-50/40` —— 它属于第 1 类以外的
 * 浅色底，漏映射时正是设置 → 备份里那块突兀的白底。
 */
const MAPPING_EXEMPTIONS: Record<string, string> = {
  // ---- 常驻深色界面（不受主题切换影响） ----
  'bg-gray-700/30': 'AuthScreen 是常驻深色界面，配色不随主题变化（见 dark-theme.css 第 8 节）',
  'bg-indigo-500/10': 'AuthScreen 与 BootScreen 的装饰光斑，两处界面都是常驻深色（第 8 节）',
  'bg-indigo-500/20': 'ParticleBackground 只在授权界面出现，而那是常驻深色界面',
  'bg-violet-500/10': 'AuthScreen 与 BootScreen 的装饰光斑，同 bg-indigo-500/10',
  'bg-emerald-500/10': 'AuthScreen 的状态条，常驻深色界面',
  'bg-emerald-500/20': 'BootScreen 的进度圆点，常驻深色界面',

  // ---- 强调色本身是中间明度，不是"浅色底" ----
  'bg-indigo-400/60': '分屏分隔条的拖动态；-400 是中间明度，深色下不退化成浅色块',
  'hover:bg-indigo-300/60': '分屏分隔条的悬停态，同上（-300 只是略亮，仍是可读的强调色）',
  'bg-indigo-500/50': '模块加载指示条；-500 是中间明度，深色下可读',
  'bg-indigo-600/10': '插件页遮罩的强调色淡染；-600 比深色底更深，不构成"发白的板子"',
};

// 扫「半透明背景」：实心色（bg-gray-100）不需要档位区分，也不是这张表的
// 失败模式。`bg-[#fb7299]/15` 这类任意值是品牌色，不参与主题映射。
//
// **颜色族必须全扫，不能只扫灰白黑。** 初版只匹配 `white|black|gray-\d+`，
// 于是所有彩色浅底（`bg-indigo-50/40`、`bg-amber-50/40`、`bg-red-50/60`…）
// 都在覆盖范围之外 —— 而它们恰恰是最容易漏的一类：界面里有十几处，
// 深色下全部退回浅色，且不报错。
const TOKEN_PATTERN = /(?:[a-z-]+:)?bg-(?:white|black|[a-z]+-\d+)\/\d+/g;

const used = new Map<string, string>(); // token → 首个使用它的文件
for (const file of walk(join(PROJECT_ROOT, 'src'))) {
  const source = stripTsComments(readFileSync(file, 'utf-8'));
  for (const match of source.match(TOKEN_PATTERN) ?? []) {
    if (!used.has(match)) used.set(match, relative(PROJECT_ROOT, file).replace(/\\/g, '/'));
  }
}

const unmapped: string[] = [];
for (const [token, file] of [...used].sort()) {
  if (MAPPING_EXEMPTIONS[token]) continue;
  if (darkTheme.includes(`[class~='${token}']`)) continue;
  unmapped.push(`${token}（${file}）`);
}

check(used.size > 0, `扫到 ${used.size} 个半透明背景 token`);
check(
  unmapped.length === 0,
  unmapped.length === 0
    ? '每一个半透明背景 token 都有深色映射'
    : `有 token 缺少深色映射（深色下会退回浅色）：\n      ${unmapped.join('\n      ')}`
);

// 豁免项必须是**真的还在用**的：一个过期豁免会掩盖将来新出现的漏映射。
for (const token of Object.keys(MAPPING_EXEMPTIONS)) {
  check(used.has(token), `豁免项 ${token} 仍在使用中（过期豁免会掩盖新的漏映射）`);
}

// 豁免名单不许用来"放过"浅色底。
//
// 上面那条豁免规则本身是对的（常驻深色界面、中间明度强调色），但它也可以被
// 滥用成"这个漏映射我懒得补"。而浅色底（Tailwind 的 -50 / -100）在深色界面上
// 必然退化成一块发白的板子 —— 那正是这张表存在的理由，因此这一类**没有豁免
// 空间**。判据只看类名，不需要解析颜色值，因此在没有浏览器的这里也成立。
const paleExemptions = Object.keys(MAPPING_EXEMPTIONS).filter((token) =>
  /bg-[a-z]+-(?:50|100)\//.test(token)
);
check(
  paleExemptions.length === 0,
  paleExemptions.length === 0
    ? '没有把浅色底（-50 / -100）放进豁免名单'
    : `这些浅色底被豁免了，但它们在深色下必然发白，应当补映射而不是豁免：${paleExemptions.join('、')}`
);

// ============================================================
// 3. 遮罩必须保持半透明
// ============================================================

console.log('\n遮罩（scrim）：');

const opaqueScrim = /:root\.dark \[class~='bg-gray-900'\]\s*\{\s*background-color:\s*([^;]+);/.exec(
  darkTheme
);
check(opaqueScrim !== null, 'bg-gray-900（实心深色表面）有对应规则');
check(
  opaqueScrim !== null && /^#[0-9a-f]{6}$/i.test(opaqueScrim[1].trim()),
  'bg-gray-900 映射到实心色（它是按钮与进度条的底，不是遮罩）'
);

// 两族遮罩都要逐档检查。判据是「必须半透明」，而不是「必须有映射」——
// 后者挡不住把 40% 的遮罩映射成实心色这种写法，而那正是真实发生过的缺陷。
let translucencyOk = true;
let scrimCount = 0;
const scrimReport: string[] = [];

for (const family of ['bg-gray-900', 'bg-black']) {
  const rules = [
    ...darkTheme.matchAll(
      new RegExp(
        `:root\\.dark \\[class~='${family}/(\\d+)'\\]\\s*\\{\\s*background-color:\\s*([^;]+);`,
        'g'
      )
    ),
  ];
  check(rules.length >= 3, `${family} 的半透明档位至少覆盖 3 档（实得 ${rules.length}）`);

  for (const [, level, value] of rules) {
    scrimCount += 1;
    const alpha = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(value.trim());
    const parsed = alpha ? Number(alpha[1]) : NaN;
    const ok = Number.isFinite(parsed) && parsed > 0 && parsed < 1;
    if (!ok) translucencyOk = false;
    scrimReport.push(`${family}/${level}=${value.trim()}${ok ? '' : ' ←不是半透明'}`);
  }
}
check(
  translucencyOk,
  `每一档遮罩都是半透明（遮罩的职责是压暗，不是把背后擦掉）：共 ${scrimCount} 档`
);

// ============================================================
// 4. 亚层判据用语义类，不用工具类组合
// ============================================================

console.log('\n窗口亚层判据：');

check(
  /:root\.dark \[class~='lc-chrome'\]\s*\{\s*background-color:\s*#[0-9a-f]{6};/i.test(darkTheme),
  '亚层底色由 lc-chrome 判定'
);
check(
  !/\[class~='bg-white\/\d+'\]\[class~='backdrop-blur-xl'\]/.test(darkTheme),
  '不再用「工具类组合」判定亚层（那套判据会随类名改动静默失效，且浮层也在用同样的组合）'
);

// ============================================================
// 5. 抽屉转场曲线只有一处定义
// ============================================================

console.log('\n浮层转场：');

const curves = read('src/utils/motionCurves.ts');
check(curves.includes('DRAWER_ENTER'), 'motionCurves 导出 DRAWER_ENTER');
check(curves.includes('DRAWER_EXIT'), 'motionCurves 导出 DRAWER_EXIT');
check(
  /ease:\s*\[0\.32,\s*0\.72,\s*0,\s*1\]/.test(curves),
  '进场用显式贝塞尔（弹簧从静止起步，初速度为零，观感就是「先慢再快」）'
);

for (const drawer of [
  'src/modules/plugins/PluginDetailDrawer.tsx',
  'src/modules/pluginMarket/PluginMarket.tsx',
]) {
  const source = read(drawer);
  check(source.includes('DRAWER_ENTER') && source.includes('DRAWER_EXIT'), `${drawer} 使用共享曲线`);
  check(
    !/stiffness:\s*380/.test(source),
    `${drawer} 不再内联旧的弹簧参数（两个抽屉各写一份必然漂移）`
  );
}

// ============================================================
// 6. 外壳布局的命中区域
// ============================================================

console.log('\n外壳布局与命中区域：');

const home = read('src/pages/Home.tsx');
// 这一层用 `paddingLeft` 给侧边栏让位，而 padding 不会缩小元素盒子 ——
// 盒子仍是全宽的。不声明 pointer-events-none，它就会以透明的身份盖住
// 侧边栏头部（折叠按钮只底下 8px 可点）。断言这一对写法必须同时存在。
check(
  /className="pointer-events-none fixed left-0 right-0 z-40 flex h-9"/.test(home),
  '标签栏行容器不接收指针事件（全宽布局壳会挡住侧边栏头部）'
);
check(
  /style=\{\{ top: showTitlebar \? 40 : 0, paddingLeft: sidebarPx \}\}/.test(home),
  '标签栏行仍然用 paddingLeft 让位（所以上面那条 pointer-events-none 是必需的）'
);

const tabBarRow = read('src/components/Tabs/TabBar.tsx');
check(
  tabBarRow.includes('pointer-events-auto'),
  'TabBar 自己声明 pointer-events-auto，交互不受外层容器影响'
);

// ============================================================
// 7. 构建产物：只在打包之后才成立的断言
// ============================================================
//
// 为什么必须查产物，而不是只查源码 —— v1.1.7 出过一次**只在发行版复现**的缺陷：
//
// `index.css` 里那一对声明原本写作
//     backdrop-filter: none !important;
//     -webkit-backdrop-filter: none !important;
// 压缩器把后者当成前者的等价替代并去重，**删掉了标准的那一份**，产物里只剩
// `-webkit-backdrop-filter`。开发服务器不做这层压缩，两份都在，所以开发时一切
// 正常；打包后毛玻璃开关就"直接失效"了。
//
// 教训是：「源码里写了」不等于「产物里有」。压缩、tree-shaking、按目标浏览器
// 降级都会改写产物，而它们失败时是静默的。这一节的断言因此直接读 `dist/`。

console.log('\n构建产物（需要先 pnpm build）：');

const distAssets = join(PROJECT_ROOT, 'dist', 'assets');
let builtCss: string | null = null;
if (existsSync(distAssets)) {
  const candidate = readdirSync(distAssets).find((name) => name.endsWith('.css'));
  if (candidate) builtCss = readFileSync(join(distAssets, candidate), 'utf-8');
}

if (builtCss === null) {
  console.log('  • 跳过：dist/assets 下没有 CSS。改动样式后请先 pnpm build 再看本节。');
} else {
  check(
    /:root\.lc-no-glass[^{]*\{[^}]*backdrop-filter:none!important/.test(builtCss),
    '产物里 lc-no-glass 规则保留了**标准**的 backdrop-filter: none'
  );
  check(
    /:root\.lc-no-glass[^{]*\{[^}]*-webkit-backdrop-filter:none!important/.test(builtCss),
    '产物里同时有 -webkit- 前缀版（旧 WebKit 内核需要它）'
  );
}

// 源码侧：**不许手写前缀**。
//
// 手写 `-webkit-backdrop-filter` 正是让压缩器去重、进而删掉标准声明的**原因**：
// 工具本来就会按目标浏览器自己补前缀（产物里 Tailwind 的工具类两份都在，就是
// 它补的）。手写等于替工具做决定，而工具会因此删掉另一份。
const glassRule = /:root\.lc-no-glass[\s\S]*?\}/.exec(indexCss)?.[0] ?? '';
check(
  glassRule.includes('backdrop-filter: none !important'),
  'lc-no-glass 规则含标准 backdrop-filter 声明'
);
check(
  !glassRule.includes('-webkit-backdrop-filter'),
  'lc-no-glass 规则里不手写 -webkit- 前缀（手写会让压缩器删掉标准声明）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
