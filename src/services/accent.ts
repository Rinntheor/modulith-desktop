// src/services/accent.ts
//
// 主题配色（强调色）的运行时。
//
// 职责：把一个品牌主色**推导**成整套 CSS 变量，写入 `document`。
// 变量由 `src/styles/global/accent.css` 消费 —— 那层 CSS 把 Tailwind 的
// 品牌色工具类（`bg-indigo-600`、`text-indigo-400` …）重定向到这些变量，
// 因此换配色**不需要修改任何组件**。
//
// ---------------------------------------------------------------------------
// 为什么在 JS 里做颜色推导，而不是写死十几档色值
//
// 界面里用到的品牌色档位有 10 档以上（浅底、浅底加深、主色、悬停、深色文字、
// 深色底上的提亮文字…）。若每个主题都手写这些值：
//   · 配色表会膨胀到数百行，且极易出现某个档位不一致；
//   · 新增配色要重新调一套色，实际不会有人认真做。
// 只给主色、其余按 HSL 明度推导，则新增一行即可，且各档必然协调。
//
// 推导策略（关键在「色相与饱和度保持不变，只调明度」）：
//   · 浅色模式 50/100/200 是往白里混，300/400/500/600/700 依次加深；
//   · 深色模式 200/300/400 往亮里走（深底上的文字），500/600 是主色，
//     800/900 往暗里走（深底）。
// 这与 Tailwind 官方调色板的构造方式一致，因此视觉上不会有违和感。
//
// 无彩色主题（灰色）单独处理：它的浅底若按混白推导会与界面自身的灰阶
// 撞色，因此强制给一组中性灰，而不是从主色推。

import {
  ACCENT_THEMES,
  DEFAULT_ACCENT_ID,
  getAccentTheme,
  isAccentId,
} from '../config/accentTheme';

/** 本地缓存的键。仅供**首帧**使用，权威来源是后端 settings.json。 */
export const ACCENT_STORAGE_KEY = 'modulith.accent';

// ============================================================
// 颜色工具
// ============================================================

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** `#RRGGBB` → HSL */
function hexToHsl(hex: string): Hsl {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return { h: h * 360, s, l };
}

/** 保留小数位，避免生成的 CSS 出现冗长浮点数 */
function n(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 按 Tailwind 的档位明度取色。
 *
 * `l` 为 HSL 明度（0-1），`s` 为饱和度；无彩色主题把饱和度压到 0。
 */
function hsl(h: number, s: number, l: number): string {
  return `hsl(${n(h)} ${n(s * 100)}% ${n(l * 100)}%)`;
}

/**
 * 各档位的明度表。
 *
 * 数值参考 Tailwind 官方调色板：`-500` 约 50-60% 明度，`-600` 约 40-45%，
 * `-700` 约 33%，浅底 `-50` 约 96%、`-100` 约 93%、`-200` 约 88%。
 *
 * 深色模式的档位是独立的一套 —— 深底上的文字需要更高明度，
 * 不能直接复用浅色模式的值。
 */
const LIGHT_LEVELS: Record<string, number> = {
  '50': 0.97,
  '100': 0.93,
  '200': 0.86,
  '300': 0.76,
  '400': 0.64,
  '500': 0.55,
  '600': 0.45,
  '700': 0.37,
};

const DARK_LEVELS: Record<string, number> = {
  '200': 0.9,
  '300': 0.82,
  '400': 0.72,
  '500': 0.62,
  '600': 0.52,
  '700': 0.44,
  '800': 0.27,
  '900': 0.2,
};

/**
 * 把基色展开成一套 CSS 变量。
 *
 * 变量命名刻意与档位一一对应（`--accent-600` 等），使 accent.css 的映射
 * 保持机械、可读、不易出错。
 */
export function buildAccentVariables(themeId: string): Record<string, string> {
  const theme = getAccentTheme(themeId);
  const { h, s } = hexToHsl(theme.base);

  // 无彩色主题：饱和度归零，浅底改为中性灰，避免与界面灰阶撞色
  const sat = theme.neutral ? 0 : s;
  const vars: Record<string, string> = {};

  for (const [level, lightness] of Object.entries(LIGHT_LEVELS)) {
    // 浅底（50/100）在无彩色主题下用极浅的灰，而不是混白后偏纯白
    vars[`--accent-${level}`] =
      theme.neutral && (level === '50' || level === '100')
        ? hsl(h, 0, level === '50' ? 0.975 : 0.94)
        : hsl(h, sat, lightness);
  }

  for (const [level, lightness] of Object.entries(DARK_LEVELS)) {
    // 深色底（800/900）在无彩色主题下压低明度但保持中性
    vars[`--accent-${level}`] =
      theme.neutral && (level === '800' || level === '900')
        ? hsl(h, 0, lightness)
        : hsl(h, Math.min(1, sat * 1.02), lightness);
  }

  return vars;
}

// ============================================================
// 应用与状态
// ============================================================

let currentId: string = DEFAULT_ACCENT_ID;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[accent] 订阅者执行出错:', error);
    }
  });
}

/** 订阅配色变化 */
export function subscribeAccent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前配色 id */
export function getAccentId(): string {
  return currentId;
}

function readCachedAccent(): string {
  if (typeof window === 'undefined') return DEFAULT_ACCENT_ID;
  try {
    const raw = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return isAccentId(raw) ? raw : DEFAULT_ACCENT_ID;
  } catch {
    return DEFAULT_ACCENT_ID;
  }
}

function writeCachedAccent(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, id);
  } catch {
    // 存储不可用不影响功能，只是下次首帧会回退到默认配色
  }
}

function applyToDocument(id: string): void {
  if (typeof document === 'undefined') return;
  const vars = buildAccentVariables(id);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
  root.dataset.accent = id;
}

/**
 * 设置配色。
 *
 * 与主题（深/浅）一致：只负责**应用**，不负责持久化 ——
 * 持久化由 `appSettings.saveAppSettings` 完成，避免「设置没写成功但界面变了」。
 */
export function setAccentId(id: string): void {
  if (!isAccentId(id)) {
    console.warn(`[accent] 忽略未知配色: ${String(id)}`);
    return;
  }
  if (id === currentId) return;

  currentId = id;
  applyToDocument(id);
  writeCachedAccent(id);
  notify();
}

/**
 * 在 React 渲染前同步可用：把首帧脚本已写入的配色读回内存。
 *
 * 与 `primeThemeFromDocument` 同样的理由 —— 首帧不能等后端返回。
 */
export function primeAccentFromDocument(): void {
  if (typeof document === 'undefined') return;
  const declared = document.documentElement.dataset.accent;
  currentId = isAccentId(declared) ? declared : readCachedAccent();
  applyToDocument(currentId);
}

/** 供 index.html 首帧脚本使用：生成变量并直接写到根元素（不依赖模块系统） */
export function accentVariablesFor(id: string): Record<string, string> {
  return buildAccentVariables(id);
}

export { ACCENT_THEMES };
