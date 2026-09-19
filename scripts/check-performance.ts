// scripts/check-performance.ts
// 性能模式与「关闭动画」的验证脚本
//
//   node scripts/check-performance.ts
//
// 这个脚本查两类东西：
//
// 1. **两个开关的合并语义**（可以直接跑真实实现 —— `services/theme.ts` 没有任何
//    外部依赖，`document` 的用法都有 `typeof` 守卫，因此在 Node 里也能跑）。
//    这里要守住的是「性能模式包含关闭动画」以及「反向不成立」。
// 2. **两个真实缺陷的修复点**（只能文本核对，因为它们在组件与 CSS 里）：
//    · `Home.tsx` 里按标签套的那层 MotionConfig 会**覆盖**外层的全局设置
//      （framer-motion 的子层取胜），所以它必须把全局的动效状态取进来；
//    · `.lc-reduce-motion` 的规则必须覆盖 delay / play-state 与根元素自身，
//      否则「关了动画」会留下会响的延迟帧与根元素的渐变。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMotionReduced } from '../src/utils/motionPreference.ts';

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

// ============================================================
// 3. 两个真实缺陷的修复点
// ============================================================

console.log('\n缺陷修复点：');

const home = read('src/pages/Home.tsx');
check(
  /reducedMotion=\{isActive && !reduceMotion \? 'never' : 'always'\}/.test(home),
  '标签层的 MotionConfig 与全局动效状态取并集（子层会覆盖父层，写死 isActive 就等于只在没看的标签上生效）'
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

const css = read('src/styles/global/index.css');
check(css.includes(':root.lc-performance'), 'CSS 里有性能模式规则');
check(
  /:root\.lc-performance[\s\S]*?backdrop-filter: none !important;/.test(css),
  '性能模式去掉 backdrop-filter（三个常驻全屏模糊是最大的合成开销）'
);
check(
  /:root\.lc-performance[\s\S]*?will-change: auto !important;/.test(css),
  '性能模式收回 will-change 的合成层提升'
);
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

// 后端的字段必须与前端同名（camelCase）
const rustSettings = read('src-tauri/src/modules/settings/settings.rs');
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
