// src/services/theme.ts
//
// 主题（深色 / 浅色 / 跟随系统）与动效开关。
//
// 权威来源是后端 `settings.json`（`theme` / `reduceMotion`），但**首帧**
// 不能等后端：WebView 会在 JS bundle 求值前就绘制一次，若那时才决定配色，
// 用户会看到「一帧深色 → 跳成浅色」。因此采用两级来源：
//
//   * 首帧：index.html 里的内联脚本读 localStorage 缓存（同步，零延迟）；
//   * 随后：设置加载完成时用后端权威值覆盖，并回写 localStorage 缓存。
//
// localStorage 只当缓存用，不作为真相来源 —— 后端文件才是用户真正设置的
// 地方，缓存丢失（清空 WebView 数据）只会让首帧闪一下，不会丢设置。

import { isMotionReduced } from '../utils/motionPreference';

export type ThemeMode = 'light' | 'dark' | 'system';

/** 解析后的实际主题（system 会被解析成 light 或 dark） */
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'modulith.theme';

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** 校验任意输入是否为合法主题值（后端 JSON 可能被手工改坏） */
export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/** 系统当前是否偏好深色 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/** 把主题模式解析成实际生效的主题 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

function readCachedTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function writeCachedTheme(mode: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 隐私模式 / 存储配额问题：缓存写不进去不影响功能
  }
}

function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  if (typeof document === 'undefined') return resolved;

  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.resolvedTheme = resolved;
  root.classList.toggle('dark', resolved === 'dark');
  // 供 index.html 骨架与窗口底色复用；窗口自身没有其他方式知道该用哪种底色
  root.style.backgroundColor = resolved === 'dark' ? '#0f1117' : '#f7f8fa';
  return resolved;
}

// ============================================================
// 对外状态
// ============================================================

let currentMode: ThemeMode = 'system';
let currentResolved: ResolvedTheme = 'dark';
/**
 * **有效**的动效开关 —— 不是用户在设置里存的那个值。
 *
 * 它等于「用户关了动画」或「开了性能模式」的并集（见 `applyMotionPreference`）。
 * 对外只暴露这一个有效值，`MotionConfig` 与 CSS 都读它，因此不可能出现
 * 「两个开关各关一半」的状态。
 */
let reduceMotion = false;
/** 用户在设置里存的那个值 */
let reduceMotionSetting = false;
/** 性能模式（用户在设置里存的那个值） */
let performanceMode = false;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[theme] 订阅者执行出错:', error);
    }
  });
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getThemeMode(): ThemeMode {
  return currentMode;
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}

export function getReduceMotion(): boolean {
  return reduceMotion;
}

/** 性能模式是否开启（用户在设置里选的那个值） */
export function getPerformanceMode(): boolean {
  return performanceMode;
}

// ============================================================
// 设置主题
// ============================================================

/**
 * 设置主题模式。
 *
 * 只负责**应用**，不负责持久化 —— 持久化由 appSettings.saveAppSettings 完成，
 * 那边的订阅回调会再调回这里。这样「主题」与其它设置走同一条链路，
 * 不会出现「设置文件没写成功但界面已经变了」的不一致。
 */
export function setThemeMode(mode: ThemeMode): void {
  if (!isThemeMode(mode)) {
    console.warn(`[theme] 忽略非法主题值: ${String(mode)}`);
    return;
  }
  const nextResolved = resolveTheme(mode);
  if (mode === currentMode && nextResolved === currentResolved) return;

  currentMode = mode;
  currentResolved = applyTheme(mode);
  writeCachedTheme(mode);
  notify();
}

/**
 * 动效开关。
 *
 * 关闭时做两件事，缺一不可：
 *   * 给根元素加 `.lc-reduce-motion` —— 关掉 CSS 动画与过渡（见 index.css）；
 *   * 让 MotionConfig 使用 reducedMotion="always" —— 关掉 framer-motion
 *     的动画（含 spring、layout 动画）。
 * 只做其中一件都会留下明显还在动的部分。
 *
 * 这里存的是**用户设置值**；真正生效的是它与性能模式的并集，见
 * `applyMotionPreference`。
 */
export function setReduceMotion(enabled: boolean): void {
  if (enabled === reduceMotionSetting) return;

  reduceMotionSetting = enabled;
  applyMotionPreference();
}

/**
 * 性能模式开关。
 *
 * 与 `setReduceMotion` 的关系是**包含**：打开性能模式会连带把有效动效开关
 * 置为「已关闭」。理由：性能模式要解决的问题正是「关了动画还是卡」，而它的
 * 代价（界面变朴素）已经由用户付过一次了 —— 此时再要求他把两个开关都拨到位，
 * 只会让一半用户得到一半效果，然后断定这个功能没用。
 *
 * 反过来不成立：关闭动画不会打开性能模式（去毛玻璃是有明显视觉代价的取舍，
 * 不该被一个作用域更窄的开关顺手做掉）。
 */
export function setPerformanceMode(enabled: boolean): void {
  if (enabled === performanceMode) return;

  performanceMode = enabled;
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('lc-performance', enabled);
  }
  applyMotionPreference();
}

/**
 * 把两个开关合并成**有效**的动效状态，并同步到 document 与订阅者
 *
 * 收敛到一处是为了让「有效状态」只有一个定义。此前 CSS 类与 MotionConfig
 * 各自从设置读同一个布尔量，看起来等价；一旦引入第二个开关，两处各写一遍的
 * 判断就会漂移。
 */
function applyMotionPreference(): void {
  const effective = isMotionReduced(reduceMotionSetting, performanceMode);
  if (effective === reduceMotion) return;

  reduceMotion = effective;
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('lc-reduce-motion', effective);
  }
  notify();
}

// ============================================================
// 初始化
// ============================================================

/**
 * 在应用启动最早期同步可用：
 * 把 index.html 已经写好的 `data-theme` / class 读回内存状态，
 * 保证 React 首次渲染拿到的就是正确值，而不是先渲染成默认再纠正。
 */
export function primeThemeFromDocument(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const declared = root.dataset.theme;
  currentMode = isThemeMode(declared) ? declared : readCachedTheme();
  currentResolved = resolveTheme(currentMode);
  applyTheme(currentMode);
}

/**
 * 跟随系统时，仅在系统主题变化时才需要重绘。
 * 返回取消订阅函数。
 */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  let query: MediaQueryList;
  try {
    query = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return () => {};
  }

  const onChange = () => {
    // 只有「跟随系统」模式需要响应；显式指定深/浅色时系统变化无关
    if (currentMode !== 'system') return;
    const next = resolveTheme('system');
    if (next === currentResolved) return;
    currentResolved = applyTheme('system');
    notify();
  };

  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
