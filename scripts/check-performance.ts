// scripts/check-performance.ts
// 性能模式、毛玻璃与「关闭动画」的验证脚本
//
//   node scripts/check-performance.ts
//
// 这个脚本查三类东西：
//
// 1. **三组开关的合并语义**（可以直接跑真实实现 —— `utils/motionPreference.ts`
//    与 `utils/glassPreference.ts` 都是零依赖纯函数）。这里要守住的是
//    「性能模式包含关闭动画」「性能模式包含关闭毛玻璃」以及两个反向都不成立。
// 2. **两个真实缺陷的修复点**（只能文本核对，因为它们在组件与 CSS 里）：
//    · `Home.tsx` 里按标签套的那层 MotionConfig 会**覆盖**外层的全局设置
//      （framer-motion 的子层取胜），所以它必须把全局的动效状态取进来；
//    · `.lc-reduce-motion` 的规则必须覆盖 delay / play-state 与根元素自身，
//      否则「关了动画」会留下会响的延迟帧与根元素的渐变。
// 3. **毛玻璃的归属**：三个窗口亚层永久不使用 `backdrop-filter`，其余浮层由
//    单一开关控制。这一节的断言针对的是一类具体事故 —— 亚层的深色映射过去
//    用「哪组工具类」当判据，改一次类名就会静默失效。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMotionReduced } from '../src/utils/motionPreference.ts';
import { isGlassEnabled, NO_GLASS_CLASS } from '../src/utils/glassPreference.ts';

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
 * 去掉 CSS 注释后再做文本核对。
 *
 * 必要而不是洁癖：这些断言查的是**选择器与声明**存不存在，而注释里会合法地
 * 引用它们（例如解释「这里不再用 backdrop-blur-xl 当判据」时就会写到那个
 * 选择器）。不剥注释的话，注释写得越清楚、断言越容易误报 —— 于是人们会把
 * 解释删掉来让检查通过，那正好把这份文件的价值抹平了。
 */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

// ============================================================
// 1. 两个开关的合并语义
// ============================================================

console.log('开关语义（isMotionReduced 的真值表）：');

check(!isMotionReduced(false, false), '两个都关 → 动效照常');
check(isMotionReduced(true, false), '只关动画 → 动效停用');
check(isMotionReduced(false, true), '只开性能模式 → 动效也停用（性能模式包含关闭动画）');
check(isMotionReduced(true, true), '两个都开 → 动效停用');

// 这条锁的是「方向不对称」：性能模式包含关闭动画，反过来说不成立。
// 真值表本身是对称的，方向由 theme.ts 的调用方式决定，因此下面还要查接线。
check(
  isMotionReduced(false, true) === true,
  '关闭动画不成立时，性能模式单独就能停用动效'
);

console.log('\n毛玻璃语义（isGlassEnabled 的真值表）：');

// 三个输入的组合里，玻璃关闭当且仅当「用户关了它」或「性能模式开着」。
check(isGlassEnabled(true, false) === true, '默认状态：毛玻璃开启');
check(isGlassEnabled(false, false) === false, '用户关掉 → 毛玻璃关闭');
check(isGlassEnabled(true, true) === false, '开了性能模式 → 毛玻璃也关闭（性能模式包含它）');
check(isGlassEnabled(false, true) === false, '两个都关 → 毛玻璃关闭');

// 方向不对称：关毛玻璃**不能**反过来打开性能模式。
// 它决定的是「用户只用一个小开关能不能拿到这一项收益」，因此必须钉住。
check(
  isGlassEnabled(false, false) === false && isGlassEnabled(true, false) === true,
  '关闭毛玻璃不改变性能模式的状态（方向不对称）'
);
check(NO_GLASS_CLASS === 'lc-no-glass', '根元素类名与 CSS 里的一致');

// ============================================================
// 2. 代码里的接线
// ============================================================

console.log('\n设置与界面接线：');

const appSettings = read('src/services/appSettings.ts');
check(/\bperformanceMode: boolean;/.test(appSettings), 'appSettings 的接口里有 performanceMode');
check(/performanceMode: false,/.test(appSettings), '默认值为 false');
check(
  /performanceMode: raw\?\.performanceMode === true/.test(appSettings),
  'normalize 只在显式为 true 时开启（缺字段必须落到默认的「关」）'
);

const settingsDialog = read('src/components/Settings/SettingsDialog.tsx');
check(settingsDialog.includes('settings.performanceMode'), '设置界面引用了 performanceMode');
check(
  /update\(\{ performanceMode: next \}\)/.test(settingsDialog),
  '设置界面能把它写回设置'
);

const themeProvider = read('src/components/ThemeProvider.tsx');
check(themeProvider.includes('setPerformanceMode(settings.performanceMode)'), 'ThemeProvider 会套用它');

const theme = read('src/services/theme.ts');
check(
  /document\.documentElement\.classList\.toggle\('lc-performance'/.test(theme),
  'theme.ts 切换 lc-performance 类'
);
check(
  /const effective = isMotionReduced\(reduceMotionSetting, performanceMode\)/.test(theme),
  '有效动效由 isMotionReduced 合并（合并只在一处发生）'
);
check(
  /reduceMotionSetting = enabled;[\s\S]{0,80}applyMotionPreference\(\);/.test(theme),
  '「关闭动画」只写自己的设置值，不碰性能模式（方向不对称）'
);
check(
  /performanceMode = enabled;[\s\S]{0,200}applyMotionPreference\(\);/.test(theme),
  '打开性能模式会连带重新求值有效动效'
);

// ---------- 毛玻璃的接线 ----------

check(
  /\bglassEffect: boolean;/.test(appSettings),
  'appSettings 的接口里有 glassEffect'
);
check(/glassEffect: true,/.test(appSettings), '默认值为 true（代价只发生在浮层打开时）');
check(
  /glassEffect: raw\?\.glassEffect !== false/.test(appSettings),
  'normalize 只在显式为 false 时关闭（缺字段必须落到默认的「开」）'
);

check(settingsDialog.includes('settings.glassEffect'), '设置界面引用了 glassEffect');
check(
  /update\(\{ glassEffect: next \}\)/.test(settingsDialog),
  '设置界面能把它写回设置'
);

check(
  themeProvider.includes('setGlassEffect(settings.glassEffect)'),
  'ThemeProvider 会套用它'
);

check(
  /document\.documentElement\.classList\.toggle\(NO_GLASS_CLASS, !effective\)/.test(theme),
  'theme.ts 切换 lc-no-glass 类'
);
check(
  /const effective = isGlassEnabled\(glassSetting, performanceMode\)/.test(theme),
  '有效毛玻璃由 isGlassEnabled 合并（合并只在一处发生）'
);
check(
  /glassSetting = enabled;[\s\S]{0,80}applyGlassPreference\(\);/.test(theme),
  '「毛玻璃效果」只写自己的设置值，不碰性能模式（方向不对称）'
);
check(
  /performanceMode = enabled;[\s\S]{0,400}applyGlassPreference\(\);/.test(theme),
  '打开性能模式会连带关闭毛玻璃'
);

// ============================================================
// 3. 两个真实缺陷的修复点
// ============================================================

console.log('\n缺陷修复点：');

const home = read('src/pages/Home.tsx');
// `isVisible` 而不是 `isActive`：分屏之后「可见」与「被选中」不再等价 ——
// 两组各有一个可见标签。这个断言此前停留在 `isActive`，因此从引入分屏那一版
// 起就一直失败（断言与实现只对了一半，而没有人跑它）。
check(
  /reducedMotion=\{isVisible && !reduceMotion \? 'never' : 'always'\}/.test(home),
  '标签层的 MotionConfig 与全局动效状态取并集（子层会覆盖父层，写死可见性就等于只在没看的标签上生效）'
);
check(
  home.includes('subscribeTheme(') && /getReduceMotion\(\)/.test(home),
  'Home 订阅动效状态，设置变化后立即生效'
);
check(
  /没有[\s\S]{0,24}content-visibility/.test(home),
  'Home 的注释明确说明「没有用 content-visibility」并给出理由'
);
check(
  home.includes('useModuleActive'),
  '注释里仍然指明「非激活模块要用 useModuleActive 自己判断」'
);

const css = stripCssComments(read('src/styles/global/index.css'));
check(css.includes(':root.lc-performance'), 'CSS 里有性能模式规则');
check(
  /:root\.lc-performance[\s\S]*?will-change: auto !important;/.test(css),
  '性能模式收回 will-change 的合成层提升'
);
check(
  /:root\.lc-no-glass[\s\S]*?backdrop-filter: none !important;/.test(css),
  '毛玻璃开关有一条统一的 backdrop-filter 关闭规则'
);
// 逐行匹配而不是全文计数：`-webkit-backdrop-filter: ...` 里含有
// `backdrop-filter: ...` 这个子串，全文计数会把它也数进去（= 2 而不是 1）。
check(
  (css.match(/^\s*backdrop-filter: none !important;$/gm) ?? []).length === 1,
  '「去掉毛玻璃」只有一处定义 —— 写两遍迟早会漏改一处'
);
/*
 * **不要手写 `-webkit-` 前缀。**
 *
 * 这条断言在 v1.1.7 时是反的（那时要求"前缀版同样只有一处"），而那个要求本身
 * 造成了 v1.1.7 最麻烦的一个缺陷：手写的
 *     backdrop-filter: none !important;
 *     -webkit-backdrop-filter: none !important;
 * 被 CSS 压缩器判定为同一件事、去重时删掉了**标准**的那一份，于是发行版里
 * 毛玻璃开关完全失效（开发服务器不压缩，所以只在打包后复现）。
 *
 * 压缩器本来就会按目标浏览器自己补前缀（产物里 Tailwind 的工具类两份都在，
 * 就是它补的）。手写等于替工具做决定，而工具会因此删掉另一份。
 * 构建产物侧的断言在 `check-theme.ts` 的第 7 节。
 */
check(
  (css.match(/^\s*-webkit-backdrop-filter:/gm) ?? []).length === 0,
  '源码里不手写 -webkit- 前缀（手写会让压缩器删掉标准声明，只在发行版暴露）'
);
// 性能模式块本身不再重复那条规则：它通过 isGlassEnabled 连带关闭毛玻璃。
const performanceBlock = css.slice(
  css.indexOf(':root.lc-performance'),
  css.indexOf('@layer components')
);
check(
  performanceBlock.length > 0 && !performanceBlock.includes('backdrop-filter'),
  '性能模式块里不再重复一条 backdrop-filter（改由 lc-no-glass 统一负责）'
);

// ---------- 窗口亚层永久不使用毛玻璃 ----------

console.log('\n窗口亚层与浮层的分工：');

const chromeFiles = [
  'src/components/Titlebar/Titlebar.tsx',
  'src/components/Tabs/TabBar.tsx',
  'src/components/Sidebar/Sidebar.tsx',
];
for (const file of chromeFiles) {
  const source = read(file);
  check(source.includes('lc-chrome'), `${file} 标了 lc-chrome 语义类`);
  check(
    !source.includes('backdrop-blur'),
    `${file} 不再使用 backdrop-blur（亚层背后永远是纯色底，模糊只有代价）`
  );
}

const darkTheme = stripCssComments(read('src/styles/global/dark-theme.css'));
check(
  /:root\.dark \[class~='lc-chrome'\]\s*\{\s*background-color: #151823;/.test(darkTheme),
  '深色映射用 lc-chrome 当亚层判据（用工具类组合会随类名改动静默失效）'
);
// 亚层判据一旦回退成「哪组工具类」，浮层会被当成亚层拿到更暗的底色与近黑描边。
check(
  !/\[class~='backdrop-blur-xl'\]/.test(darkTheme),
  '深色映射里不再用 backdrop-blur-xl 判断亚层（它并非亚层独有，浮层也在用）'
);

const rustSettings = read('src-tauri/src/modules/settings/settings.rs');
check(/pub glass_effect: bool,/.test(rustSettings), 'settings.rs 有 glass_effect 字段');
check(
  /fn default_glass_effect\(\) -> bool \{\s*\n\s*true\s*\n\}/.test(rustSettings),
  '后端默认值为 true（代价只发生在浮层打开时）'
);
check(rustSettings.includes('\\"glassEffect\\"'), '后端序列化用的键名是 camelCase');
check(
  /:root\.lc-reduce-motion,\s*\n\s*:root\.lc-reduce-motion \*/.test(css),
  '动画总开关包含根元素自身（只写 * 匹配不到它）'
);
check(css.includes('animation-delay: 0ms !important;'), '动画总开关把延迟也归零');
check(css.includes('transition-delay: 0ms !important;'), '过渡延迟同样归零');

const authScreen = read('src/features/auth/AuthScreen.tsx');
check(
  /!reduceMotion && <ParticleBackground \/>/.test(authScreen),
  '粒子背景在关闭动画/性能模式下不再挂载（它的透明度循环不受 reducedMotion 约束）'
);
check(
  authScreen.includes('useReduceMotion()'),
  '授权界面用有效动效开关，而不是直接读设置里的 reduceMotion'
);

// 后端字段必须与前端同名（camelCase）—— 上面的
// `const rustSettings` 读的就是这个文件，性能模式的两条断言放在这里与它并列。
check(/pub performance_mode: bool,/.test(rustSettings), 'settings.rs 有 performance_mode 字段');
check(
  /fn default_performance_mode\(\) -> bool \{\s*\n\s*false\s*\n\}/.test(rustSettings),
  '后端默认值为 false（默认打开等于替所有用户做了这个取舍）'
);
check(rustSettings.includes('\\"performanceMode\\"'), '后端序列化用的键名是 camelCase');

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
