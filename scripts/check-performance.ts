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
import { levelForVisibility } from '../src/utils/memoryLevelPolicy.ts';
import { shouldAutoTrim } from '../src/utils/memoryTrimPolicy.ts';

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

// ============================================================
// 4. 内存目标等级的降级策略（前后端真值表必须一致）
// ============================================================
//
// 这条策略有一条**刻意的镜像实现**：前端 `services/memoryLevel.ts` 与后端
// `settings/memory_level.rs` 各有一份。允许重复的理由是前端需要在本地就知道
// "目标等级是不是已经设过了"（避免每次 visible 事件都发一次 IPC），
// 而那件事没法靠每次问后端来做。
//
// 但两份实现必须给出**同一个真值表**，否则会出现"前端以为设成 Low 了、
// 后端按另一条规则设成 Normal"这类只表现为"省内存没生效"的分叉。
// 这里把规则本身钉住，而不是钉住某一行代码的写法。
console.log('\n内存目标等级的降级策略：');

const memoryLevelTs = read('src/utils/memoryLevelPolicy.ts');
const memoryLevelServiceTs = read('src/services/memoryLevel.ts');
const memoryLevelRs = read('src-tauri/src/modules/settings/memory_level.rs');

// 前端：直接跑那份镜像实现。
check(
  levelForVisibility(true) === 'low',
  '前端：不可见 → low'
);
check(
  levelForVisibility(false) === 'normal',
  '前端：可见 → normal'
);

// 策略必须真的被服务用上：放进了纯模块却没人调用，等于没写。
check(
  /from '\.\.\/utils\/memoryLevelPolicy'/.test(memoryLevelServiceTs),
  '前端服务用的是纯策略模块（而不是自己另写一份判断）'
);

// 后端：规则是一段极小的纯函数，用正则取出它的分支 —— 比"检查某文件包含某字符串"
// 更接近"检查规则本身"，因为它同时要求两个分支都在。
check(
  /if hidden \{[\s\S]{0,80}?MemoryLevel::Low[\s\S]{0,80}?else[\s\S]{0,80}?MemoryLevel::Normal/.test(
    memoryLevelRs
  ) || /if hidden \{\s*MemoryLevel::Low\s*\} else \{\s*MemoryLevel::Normal\s*\}/.test(memoryLevelRs),
  '后端：不可见 → Low，可见 → Normal（与前端同一真值表）'
);

// 「失焦不降级」是这条策略最重要的一条，也是最容易被顺手优化掉的一条。
// 前端：策略函数的输入里不能出现焦点概念。
check(
  /export function levelForVisibility\(hidden: boolean\)/.test(memoryLevelTs),
  '前端策略只接受「是否隐藏」一个输入（失焦不参与判定）'
);
// 后端：同样只接受一个布尔量。
check(
  /pub fn level_for_visibility\(hidden: bool\)/.test(memoryLevelRs),
  '后端策略只接受「是否隐藏」一个输入（失焦不参与判定）'
);
// 事件策略里不允许出现降级：Rust 侧的窗口事件回调跑在事件循环上，
// 在那里既不能 with_webview（会死锁）也不能查窗口状态（也会死锁）。
check(
  !/WindowEvent::Focused/.test(memoryLevelRs),
  '后端没有基于窗口焦点事件做判定（那会在事件循环上死锁）'
);

// 三条命令必须都注册进生成的 lib.rs —— 生成器只扫 commands.rs，
// 属性写在子模块里会被静默忽略（这条坑本文件已经踩过一次）。
const libRs = read('src-tauri/src/lib.rs');
for (const command of [
  'memory_snapshot',
  'apply_memory_level_for_visibility',
  'set_webview_memory_level',
  'webview_memory_level_supported',
]) {
  check(libRs.includes(`${command},`), `命令 ${command} 已注册进 lib.rs`);
}

// 策略必须挂在根上而不是某个组件里：解锁界面上也要生效，
// 而且必须早于窗口第一次显示（否则启动期那次隐藏会被漏掉）。
const mainTsx = read('src/main.tsx');
check(
  mainTsx.includes('installMemoryLevelPolicy()'),
  '策略在 main.tsx 里安装（整个生命周期生效，且早于窗口首次显示）'
);

// ============================================================
// 回收工作集
// ============================================================
//
// 这一段与上面那段是**两件不同的事**，而它们最容易被混为一谈：
//
//   · 内存目标等级：让引擎自己丢缓存/换出内容，降低的是将来的分配；
//   · 回收工作集：把本进程树当前驻留的页交还系统，降低的是**工作集**这个数字。
//
// 后者**完全不会**降低私有内存（Private Bytes），而任务管理器默认那一列正是它。
// 因此这里要守住的最重要一条是：界面上必须把两个口径都显示出来 ——
// 只显示私有内存会让这个功能看起来完全无效。
console.log('\n回收工作集：');

const memoryTrimServiceTs = read('src/services/memoryTrim.ts');
const memoryTrimPolicyTs = read('src/utils/memoryTrimPolicy.ts');
const memoryTrimRs = read('src-tauri/src/modules/settings/memory_trim.rs');
const performanceSettingsTsx = read('src/components/Settings/PerformanceSettings.tsx');

// 前端：直接跑那份镜像实现。
check(shouldAutoTrim(true) === true, '前端：不可见 → 允许自动回收');
check(
  shouldAutoTrim(false) === false,
  '前端：可见 → **绝不**自动回收（代价是恢复时缺页，会表现为卡顿）'
);

// 策略必须真的被服务用上：放进了纯模块却没人调用，等于没写。
check(
  /from '\.\.\/utils\/memoryTrimPolicy'/.test(memoryTrimServiceTs),
  '前端服务用的是纯策略模块（而不是自己另写一份判断）'
);

// 后端策略：只接受一个布尔量，且两个分支都在
check(
  /pub fn should_trim_for_visibility\(hidden: bool\) -> bool/.test(memoryTrimRs) &&
    /pub fn should_trim_for_visibility\(hidden: bool\) -> bool \{\s*hidden\s*\}/.test(memoryTrimRs),
  '后端策略只接受「是否隐藏」一个输入，且可见时不回收'
);

// 策略文件里不能出现 IPC 或浏览器 API（它要能被门禁直接跑）
check(
  !/from '@tauri-apps|invoke\(|document\./.test(memoryTrimPolicyTs),
  '纯策略模块不含 IPC 与浏览器 API（否则门禁跑不起来）'
);

// 关键取舍：回收降低的是工作集，不是私有内存。这条事实必须写在代码里，
// 因为它是一个会被反复重新发现的惊讶点。
check(
  /完全不会[\s\S]{0,40}降低|不会\*\*降低/.test(memoryTrimRs) ||
    /SetProcessWorkingSetSize[\s\S]{0,400}?不会/.test(memoryTrimRs),
  '后端注明回收不影响私有内存（否则会被当成"没用"）'
);

// 返回值必须同时带前后两个口径，否则"到底降了没有"无法被验证
check(
  /before_working_set/.test(memoryTrimRs) &&
    /after_working_set/.test(memoryTrimRs) &&
    /before_private_bytes/.test(memoryTrimRs) &&
    /after_private_bytes/.test(memoryTrimRs),
  '回收结果同时给出回收前后的工作集与私有内存'
);

// 界面必须真的把两个口径都渲染出来
check(
  /trimOutcome\.beforeWorkingSet/.test(performanceSettingsTsx) &&
    /trimOutcome\.afterWorkingSet/.test(performanceSettingsTsx),
  '界面显示工作集的"回收前 → 回收后"'
);
check(
  /trimOutcome\.beforePrivateBytes/.test(performanceSettingsTsx) &&
    /trimOutcome\.afterPrivateBytes/.test(performanceSettingsTsx),
  '界面也显示私有内存（并说明它不会下降）'
);

// 降幅可为负：不降反升是可能的，不能钳到 0（那会让"没有效果"看起来像"效果为零"）
check(
  /working_set_freed\(&self\) -> i64/.test(memoryTrimRs),
  '降幅是**有符号**的（不降反升时如实返回负数，不钳到 0）'
);

// 自动回收必须是"一次状态迁移"，不是"一个状态"：
// visibilitychange 在窗口拖动时会连续触发，每次都回收会反复触发缺页。
check(
  /enteredHidden/.test(memoryLevelServiceTs),
  '自动回收只在「可见 → 不可见」的那一次做（不是每次 hidden 事件都做）'
);

// 回收必须有代价说明：没有它，用户会以为这是个没有代价的按钮
check(
  /缺页|页面文件读回来/.test(memoryTrimServiceTs) ||
    /页面文件读回来/.test(performanceSettingsTsx),
  '界面或服务说明了回收的代价（被换出的页要在下次访问时读回来）'
);

// 两条命令必须注册进生成的 lib.rs
for (const command of ['trim_memory_now', 'trim_memory_supported']) {
  check(libRs.includes(`${command},`), `命令 ${command} 已注册进 lib.rs`);
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
