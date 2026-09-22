// scripts/check-settings-layout.ts
//
// 设置弹窗的**几何**检查：面板会不会超出窗口。
//
//   node scripts/check-settings-layout.ts
//
// ============================================================
// 为什么需要一个纯几何的脚本
// ============================================================
//
// 这个缺陷被用户报告过一次：「打开设置，弹窗的窗口自适应有些问题，默认尺寸下
// 超出了，只有全屏才能很好地查看」。
//
// 它属于**布局**类问题，而布局有一件麻烦事：在这套门禁里无法渲染界面来测量。
// 夹具刻意不带 JSX 转换（见 `scripts/harness/loader.mjs` 的说明），因此
// "渲染出来量一量"这条路走不通。
//
// 但"面板会不会超出窗口"实际上是一道**算术题**，不需要渲染：
//
//     面板宽度 ≤ 遮罩内容盒宽度 = 视口宽度 − 2 × 遮罩内边距
//     面板高度 ≤ 遮罩内容盒高度 = 视口高度 − 2 × 遮罩内边距
//
// 因此这个脚本解析出那两段类名，把它们还原成约束，再对几个真实窗口尺寸求解。
// 它查的是**类名与窗口尺寸的乘积**，而不是"代码里有没有某个字符串" ——
// 后者会在有人换个写法时假通过。
//
// 这与 `check:tray` / `check:quota` 是同一取向：能算的就算，不能算的
// 老实说"这里只能靠评审"。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let total = 0;

function check(condition: boolean, label: string, detail?: string): void {
  total += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${label}`);
    if (detail) console.error(`      ${detail}`);
  }
}

function read(relative: string): string {
  return readFileSync(join(PROJECT_ROOT, relative), 'utf-8');
}

const dialogTsx = read('src/components/Settings/SettingsDialog.tsx');
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'));

// ============================================================
// 从源码里取出那两段类名常量
// ============================================================
//
// 常量而不是内联字符串：这一点本身就是被检查的一项（见最后一节）。

function extractConstant(source: string, name: string): string | null {
  const match = new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*'([^']*)'`).exec(source);
  return match ? match[1] : null;
}

const panelClass = extractConstant(dialogTsx, 'SETTINGS_PANEL_CLASS');
const navClass = extractConstant(dialogTsx, 'SETTINGS_NAV_CLASS');

console.log('类名常量：');
check(panelClass !== null, '面板类名是一个可被检查的具名常量（而不是内联字符串）');
check(navClass !== null, '导航栏类名是一个可被检查的具名常量（而不是内联字符串）');

if (panelClass === null || navClass === null) {
  console.error('\n无法取出类名常量，后续几何检查无法进行');
  process.exit(1);
}

// ============================================================
// 遮罩的内边距（`p-6` = 24px 四边）
// ============================================================
//
// 从源码读出来而不是写死：它是面板几何计算的输入之一，写死的话
// 改了遮罩而忘了改这里，这个脚本就会算出一个不存在的世界。
const overlayMatch = /className="fixed inset-0 z-60[^"]*\bp-(\d+(?:\.\d+)?)\b/.exec(dialogTsx);
check(overlayMatch !== null, '能读到遮罩上声明的内边距');
const overlayPadding = overlayMatch ? Number(overlayMatch[1]) * 4 : 24;
check(overlayPadding > 0, `遮罩内边距解析为 ${overlayPadding}px`);

// ============================================================
// 把类名还原成"面板尺寸"的约束
// ============================================================
//
// 只认我们真的在用的那几种写法。认不出来就**失败**而不是跳过 ——
// 一个"因为看不懂所以放行"的检查比没有检查更糟。

/** `w-full`：面板宽度取内容盒宽度 */
const hasFullWidth = /\bw-full\b/.test(panelClass);

/** `max-w-[...]`：宽度上限。`rem` 按 16px 折算 */
function parseMaxWidth(cls: string): { kind: 'rem' | 'viewport'; value: number } | null {
  const arbitrary = /max-w-\[([^\]]+)\]/.exec(cls);
  if (arbitrary) {
    const expr = arbitrary[1];
    // 形态一：min(64rem, calc(100vw - 2rem))
    const min = /min\(\s*([\d.]+)rem\s*,\s*calc\(100vw\s*-\s*([\d.]+)rem\)\s*\)/.exec(expr);
    if (min) {
      return { kind: 'viewport', value: Number(min[1]) * 16, viewportSlack: Number(min[2]) * 16 } as never;
    }
    // 形态二：单值 rem
    const plain = /^([\d.]+)rem$/.exec(expr);
    if (plain) return { kind: 'rem', value: Number(plain[1]) * 16 };
  }

  const named = /max-w-(5xl|4xl|3xl|2xl|xl|lg|md|sm)\b/.exec(cls);
  if (named) {
    const scale: Record<string, number> = {
      sm: 384, md: 448, lg: 512, xl: 576, '2xl': 672, '3xl': 768, '4xl': 896, '5xl': 1024,
    };
    return { kind: 'rem', value: scale[named[1]] };
  }

  return null;
}

/** 高度：`h-full` + `max-h-[82vh]` 这种组合 */
function parseHeightConstraint(cls: string): { full: boolean; maxVh: number | null; hardVh: number | null } | null {
  const full = /\bh-full\b/.test(cls);
  const maxVhMatch = /max-h-\[([\d.]+)vh\]/.exec(cls);
  const hardVhMatch = /(?<!max-)\bh-\[([\d.]+)vh\]/.exec(cls);

  if (!full && !maxVhMatch && !hardVhMatch) return null;
  return {
    full,
    maxVh: maxVhMatch ? Number(maxVhMatch[1]) : null,
    hardVh: hardVhMatch ? Number(hardVhMatch[1]) : null,
  };
}

const maxWidth = parseMaxWidth(panelClass);
const height = parseHeightConstraint(panelClass);

check(hasFullWidth, '面板声明了 w-full（否则它不会跟随窗口宽度）');
check(maxWidth !== null, '能解析出面板的宽度上限', `类名：${panelClass}`);
check(height !== null, '能解析出面板的高度约束', `类名：${panelClass}`);

// ============================================================
// 对真实窗口尺寸求解
// ============================================================
//
// 这些尺寸来自 `tauri.conf.json`（默认与最小值）以及两个常见的最大化档位。
// 用户报告的正是"默认尺寸下超出、全屏才正常"，因此默认那一档必须被算到。

const windowConfig = tauriConf?.app?.windows?.[0] ?? {};
const defaultWidth = Number(windowConfig.width ?? 1100);
const defaultHeight = Number(windowConfig.height ?? 650);
const minWidth = Number(windowConfig.minWidth ?? 960);
const minHeight = Number(windowConfig.minHeight ?? 560);

/**
 * 面板宽度上限的生效值。
 *
 * `min(A, B)` 那种写法在低分辨率下由视口那一项决定 —— 这正是本次修正的要点，
 * 因此这里要如实取小，而不是只看 rem 那一项。
 */
function effectiveMaxWidth(viewportWidth: number): number {
  if (!maxWidth) return Infinity;
  if (maxWidth.kind === 'rem') return maxWidth.value;
  const slack = (maxWidth as { viewportSlack?: number }).viewportSlack ?? 32;
  return Math.min(maxWidth.value, viewportWidth - slack);
}

function effectiveMaxHeight(viewportHeight: number): number {
  if (!height) return Infinity;
  const byVh = height.maxVh !== null ? (viewportHeight * height.maxVh) / 100 : Infinity;
  // `h-[82vh]` 那种写法是**视口**高度，而不是内容盒高度 —— 它正是缺陷的来源，
  // 因此这里如实把它当成视口比例（不减去内边距）。
  const byHard = height.hardVh !== null ? (viewportHeight * height.hardVh) / 100 : Infinity;
  return Math.min(byVh, byHard);
}

console.log('\n窗口尺寸下的面板几何：');

const viewports: Array<{ label: string; width: number; height: number }> = [
  { label: `默认 ${defaultWidth}×${defaultHeight}`, width: defaultWidth, height: defaultHeight },
  { label: `最小 ${minWidth}×${minHeight}`, width: minWidth, height: minHeight },
  { label: '小屏 1024×640', width: 1024, height: 640 },
  { label: '最大化 1920×1080', width: 1920, height: 1080 },
];

for (const viewport of viewports) {
  // 遮罩内容盒：视口减去 p-4 的上下左右
  const boxWidth = viewport.width - overlayPadding * 2;
  const boxHeight = viewport.height - overlayPadding * 2;

  const panelWidth = Math.min(boxWidth, effectiveMaxWidth(viewport.width));
  const panelHeight = Math.min(
    height?.full ? boxHeight : Infinity,
    effectiveMaxHeight(viewport.height)
  );

  check(
    panelWidth <= boxWidth + 0.5,
    `${viewport.label}：面板宽度 ${Math.round(panelWidth)}px 不超过可用宽度 ${boxWidth}px`
  );
  check(
    panelHeight <= boxHeight + 0.5,
    `${viewport.label}：面板高度 ${Math.round(panelHeight)}px 不超过可用高度 ${boxHeight}px`
  );
  check(
    panelWidth > 0 && panelHeight > 0,
    `${viewport.label}：面板尺寸算出为正数（${Math.round(panelWidth)}×${Math.round(panelHeight)}）`
  );

  // ============================================================
  // 边距必须**明显大于**遮罩内边距，而不是刚好贴边
  // ============================================================
  //
  // 这一条是本脚本真正的价值所在，也是它第一版漏掉的东西。
  //
  // 第一版只断言「面板 ≤ 内容盒」，而**旧实现的宽高都恰好等于**内容盒宽度
  // （`max-w-5xl` = 1024px 在 1024~1056 宽的窗口下不生效，`w-full` 于是顶满）——
  // 那条断言对旧实现照样通过，因为"恰好相等"在数学上确实不算超出。
  // 而用户看到的正是那个"恰好相等"：面板左右各只留遮罩内边距，看起来就是贴边。
  //
  // 因此判据改成"面板两侧的空隙要显著大于遮罩内边距"。换句话说：
  // **面板的宽度上限必须是真正生效的**，而不是碰巧没被触发。
  const horizontalGap = (viewport.width - panelWidth) / 2;
  const verticalGap = (viewport.height - panelHeight) / 2;

  check(
    horizontalGap > overlayPadding,
    `${viewport.label}：左右边距 ${Math.round(horizontalGap)}px 大于遮罩内边距 ${overlayPadding}px`,
    '面板的宽度上限没有真正生效 —— 它顶满了内容盒（这正是用户报告的"贴边"）'
  );
  // 高度不要求额外的空隙：`max-h-[82vh]` 本身已经比内容盒矮一截，
  // 再要求"再多留一圈"就是自创规则了。这里只要求它不顶到内容盒边界。
  check(
    verticalGap >= 0,
    `${viewport.label}：上下边距 ${Math.round(verticalGap)}px 非负`
  );
}

// ============================================================
// 导航栏在窄窗口下必须收窄
// ============================================================
//
// 侧栏此前是固定 208px。窗口一窄，它把内容区挤到放不下表单。
console.log('\n导航栏的宽度：');

const navWidths = /w-(\d+)/.exec(navClass);
const navHasResponsive = /(md|lg|xl|2xl):w-/.test(navClass);

check(navHasResponsive, '导航栏宽度是响应式的（窄窗口下会收窄）');
check(
  !/className="w-52 shrink-0/.test(dialogTsx),
  '源码里没有残留固定 208px 的侧栏'
);

if (navWidths) {
  const baseWidth = Number(navWidths[1]) * 4;
  check(
    baseWidth <= 64,
    `最窄档的侧栏宽度是 ${baseWidth}px（图标栏，不超过 64px）`
  );
}

// 12 个分页里最长的一行文字放不下时，侧栏的滚动必须存在
check(
  /overflow-y-auto/.test(dialogTsx),
  '导航栏与内容区都可纵向滚动（分页有 12 个，矮窗口下放不下）'
);
check(
  /overflow-x-hidden/.test(dialogTsx),
  '内容区禁用横向滚动（宽了应当换行或收起，而不是让用户去拖一个看不见的滚动条）'
);

// ============================================================
// 内边距的响应式
// ============================================================
console.log('\n内边距：');

const sectionFiles = [
  'NetworkSettings.tsx',
  'LoggingSettings.tsx',
  'BackupSettings.tsx',
  'PerformanceSettings.tsx',
  'NotificationSettings.tsx',
  'ReminderSettings.tsx',
  'SecuritySettings.tsx',
];

let fixedPadding = 0;
for (const file of sectionFiles) {
  const source = read(`src/components/Settings/${file}`);
  // 每个分页的最外层容器此前都是固定的 px-6（48px 两边的合计）。
  // 在窄内容区里那 48px 是从表单宽度里扣掉的。
  if (/className="px-6 py-5"/.test(source)) {
    fixedPadding += 1;
    console.error(`      ${file} 仍是固定 px-6`);
  }
}
check(
  fixedPadding === 0,
  `全部分页的外层内边距都是响应式的（${sectionFiles.length} 个文件）`
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
