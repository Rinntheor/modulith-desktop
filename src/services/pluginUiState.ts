// src/services/pluginUiState.ts
//
// 插件说的"我现在是这个状态"在**宿主界面**这一侧的全部接线：
// 徽标、进度、启动占位。
//
// ============================================================
// 为什么这三样必须由宿主渲染
// ============================================================
//
//   * **徽标** 画在侧边栏与标签栏上。沙箱插件的文档在它自己的 webview 里，
//     碰不到宿主的标签栏 —— 而让它自己画一个"像宿主的徽标"等于让它冒充宿主界面。
//   * **进度** 同一条理由。
//   * **启动占位** 要覆盖插件那一块**位置**。原生 webview 盖在宿主 DOM 之上，
//     所以宿主想在那里画东西，就必须先让 webview 让开 —— 而"让开"这件事
//     对插件是不可见的（它只是一个 `hide`）。
//
// ============================================================
// 为什么"停在初始占位"这个状态是宿主自己的
// ============================================================
//
// 打开一块界面到它画出第一帧之间有一段空白（WebView2 控制器创建 + 文档加载，
// 几百毫秒）。那一段里如果不放东西，用户看到的是上一次的内容或者一块白 ——
// 而"我点了一下，什么都没发生"是最容易让人再点一次的状态。
//
// 因此宿主**自己**先占住那块位置，插件的 webview 先收起来；插件文档加载完之后
// 桥接层会自动把占位撤掉（除非插件自己接管了，见 `sandbox-bridge.js` 的说明）。
//
// ============================================================
// 除了自动占位，还有一条超时
// ============================================================
//
// 插件文档如果**根本没加载起来**（入口脚本 404、文档被 CSP 拦掉），`load` 就不会
// 触发，占位会一直挂着。超时是给这种情况兜底的：到点之后撤掉占位并让 webview
// 露出来 —— 那时用户至少能看到插件的报错信息或者一块空白，而不是一块永远停在
// "正在启动"的面板。超时**只对自动占位生效**：插件明确说"我还在忙"时，
// 宿主不该替它决定已经忙完了。

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import {
  getCatalogFlatMap,
  getPluginModuleIds,
  setModuleBadge,
  setModuleProgress,
} from './moduleCatalog';
import { surfaceModuleId } from './pluginSurfaces';

/** 插件请求更新状态指示（由 `rpc.rs::PLUGIN_UI` 发出） */
export const PLUGIN_UI = 'modulith://plugin-ui';

/** 徽标的语气。与 `rpc.rs::badge_tone` 的白名单逐字对应。 */
export type BadgeTone = 'info' | 'success' | 'warning' | 'error';

export interface PluginBadge {
  text: string;
  tone: BadgeTone;
}

export interface PluginProgress {
  /** 0..1；`null` = 不定量 */
  value: number | null;
  label?: string;
}

export interface PluginSplash {
  text: string;
  tone: 'info' | 'warning' | 'error';
  /** 0..1；`null` = 不定量 */
  progress: number | null;
  /** 宿主自己的初始占位（插件没接管过）。只有它能被自动清除与超时清掉。 */
  auto: boolean;
}

interface PluginUiEvent {
  pluginId: string;
  surface: string;
  kind: 'badge' | 'progress' | 'splash';
  value: unknown;
  auto?: boolean;
}

/**
 * 自动占位的兜底时限。
 *
 * 8 秒：正常的一块界面在几百毫秒内就会 `load`，8 秒意味着**真的出事了**
 * （入口 404、文档被拦、插件同步跑了一个死循环）。而那时把 webview 露出来，
 * 用户至少能看到一行报错，而不是一块永远停在"正在启动"的面板。
 */
export const SPLASH_TIMEOUT_MS = 8000;

// ============================================================
// 状态
// ============================================================

/** 插件级徽标：`插件 id → 徽标`。徽标不按界面分 —— 它画在标签栏上，而标签栏是插件的。 */
const badges = new Map<string, PluginBadge>();

/** 进度：`插件 id#界面 → 进度` */
const progresses = new Map<string, PluginProgress>();

/** 启动占位：`插件 id#界面 → 占位` */
const splashes = new Map<string, PluginSplash>();

/** 自动占位的超时定时器 */
const splashTimers = new Map<string, number>();

const listeners = new Set<() => void>();

/** 订阅状态变化（`SandboxSurface` 用它重渲染）。 */
export function subscribePluginUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[pluginUiState] 订阅者执行出错:', error);
    }
  });
}

function key(pluginId: string, surface: string): string {
  return `${pluginId}#${surface}`;
}

// ============================================================
// 读
// ============================================================

export function getPluginBadge(pluginId: string): PluginBadge | null {
  return badges.get(pluginId) ?? null;
}

export function getPluginProgress(pluginId: string, surface: string): PluginProgress | null {
  return progresses.get(key(pluginId, surface)) ?? null;
}

export function getPluginSplash(pluginId: string, surface: string): PluginSplash | null {
  return splashes.get(key(pluginId, surface)) ?? null;
}

// ============================================================
// 写
// ============================================================

/**
 * 记下宿主自己的初始占位。
 *
 * 由 `SandboxSurface` 在**开始打开一块界面时**调用。它同时做了两件事：
 * 装上超时兜底，以及把 `auto` 标上 —— 前端据此判断"这条占位的清除请求是不是
 * 该被接受"（插件接管过的占位只认插件自己的清除）。
 *
 * **重复调用是幂等的**：`SandboxSurface` 会因为布局变化多次走到"打开"那条路径，
 * 而每次都重置一次超时会让一个真的卡住的插件永远不被兜底。
 */
export function beginHostSplash(pluginId: string, surface: string): void {
  const id = key(pluginId, surface);
  const current = splashes.get(id);
  if (current && !current.auto) return; // 插件已经接管，不覆盖它

  splashes.set(id, {
    text: '正在启动…',
    tone: 'info',
    progress: null,
    auto: true,
  });

  if (!splashTimers.has(id)) {
    const timer = window.setTimeout(() => {
      splashTimers.delete(id);
      const alive = splashes.get(id);
      // 只有还停在自动占位上才撤。插件在这段时间里接管过的话，它那块提示
      // 说的是"我还在忙"，宿主不该替它决定忙完了。
      if (alive?.auto) endSplash(pluginId, surface);
    }, SPLASH_TIMEOUT_MS);
    splashTimers.set(id, timer);
  }

  notify();
}

/** 撤掉一块界面的启动占位（插件清除、自动清除、超时兜底三条路径共用）。 */
export function endSplash(pluginId: string, surface: string): void {
  const id = key(pluginId, surface);
  const timer = splashTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    splashTimers.delete(id);
  }
  if (splashes.delete(id)) notify();
}

/** 插件消失了（卸载/停用）时把它留下的一切状态清掉。 */
export function clearPluginUiState(pluginId: string): void {
  let changed = badges.delete(pluginId);

  for (const id of [...progresses.keys()]) {
    if (id.startsWith(`${pluginId}#`)) {
      progresses.delete(id);
      changed = true;
    }
  }

  for (const id of [...splashes.keys()]) {
    if (id.startsWith(`${pluginId}#`)) {
      splashes.delete(id);
      const timer = splashTimers.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      splashTimers.delete(id);
      changed = true;
    }
  }

  if (changed) notify();
}

// ============================================================
// 落到目录描述符上
// ============================================================
//
// 徽标与进度都写进 `moduleCatalog` 的**描述符**里，而不是让渲染端各自订阅一份
// 状态。理由与 `setModuleIconSvg` 完全一样：侧边栏与标签栏的渲染是**同步**路径，
// 而插件的调用是一次异步广播。把值固化到描述符里，渲染端保持纯同步，
// 也不会出现"侧边栏更新了、标签栏没更新"这种半截状态。

/** 把徽标写进这个插件的每一条模块（含次级界面的隐藏模块 —— 它们也是标签）。 */
function applyBadge(pluginId: string): void {
  const badge = badges.get(pluginId) ?? null;
  for (const moduleId of getPluginModuleIds(pluginId)) {
    setModuleBadge(moduleId, badge);
  }
}

/** 把进度写进**这个界面**对应的模块。 */
function applyProgress(pluginId: string, surface: string): void {
  const progress = progresses.get(key(pluginId, surface)) ?? null;
  for (const moduleId of moduleIdsForSurface(pluginId, surface)) {
    setModuleProgress(moduleId, progress);
  }
}

/**
 * 一个界面在目录里对应哪些模块。
 *
 * 一个界面可以有好几个入口（"笔记"与"最近笔记"两个侧边栏模块打开同一块界面），
 * 而进度说的是**那块界面**在忙 —— 因此它们都该亮起来。
 *
 * 两种形状都要认：
 *   * 次级界面的隐藏模块 id 是 `plugin:<插件>#<界面>`（**没有** `surface` 字段
 *     以外的东西可查，因为它的 id 本身就是那个形状）；
 *   * 清单声明的模块则靠描述符上的 `surface`（缺省 `main`）。
 */
function moduleIdsForSurface(pluginId: string, surface: string): string[] {
  const flat = getCatalogFlatMap();
  const hidden = surfaceModuleId(pluginId, surface);

  return getPluginModuleIds(pluginId).filter((moduleId) => {
    if (moduleId === hidden) return true;
    return (flat.get(moduleId)?.surface ?? 'main') === surface;
  });
}

// ============================================================
// 事件接线
// ============================================================

/** 校验宿主广播过来的徽标值。**前端是最后一道** —— Rust 已经把语气进了白名单。 */
function parseBadge(value: unknown): PluginBadge | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== 'string' || raw.text.length === 0) return null;
  const tone = raw.tone;
  return {
    text: raw.text,
    tone:
      tone === 'success' || tone === 'warning' || tone === 'error' ? tone : 'info',
  };
}

function parseProgress(value: unknown): PluginProgress | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const fraction =
    typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : null;
  const label = typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : undefined;
  if (fraction === null && label === undefined) return null;
  return {
    value: fraction === null ? null : Math.min(1, Math.max(0, fraction)),
    label,
  };
}

function parseSplash(value: unknown, auto: boolean): PluginSplash | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== 'string' || raw.text.length === 0) return null;
  const tone = raw.tone;
  const progress =
    typeof raw.progress === 'number' && Number.isFinite(raw.progress) ? raw.progress : null;
  return {
    text: raw.text,
    tone: tone === 'warning' || tone === 'error' ? tone : 'info',
    progress: progress === null ? null : Math.min(1, Math.max(0, progress)),
    auto,
  };
}

/** 处理一条广播。**导出是为了让门禁能直接调它**（见 `check:sandbox`）。 */
export function handlePluginUiEvent(event: PluginUiEvent): void {
  if (!event?.pluginId || !event.surface || !event.kind) return;

  if (event.kind === 'badge') {
    const badge = parseBadge(event.value);
    if (badge) badges.set(event.pluginId, badge);
    else badges.delete(event.pluginId);
    applyBadge(event.pluginId);
    notify();
    return;
  }

  const id = key(event.pluginId, event.surface);

  if (event.kind === 'progress') {
    const progress = parseProgress(event.value);
    if (progress) progresses.set(id, progress);
    else progresses.delete(id);
    applyProgress(event.pluginId, event.surface);
    notify();
    return;
  }

  if (event.kind === 'splash') {
    // 自动清除**只在占位还是自动那一条时**才生效。
    //
    // 不判的话会出现一个很隐蔽的顺序问题：插件先调 `splash({text:'索引中'})`
    // 接管，随后文档的 `load` 事件到达（它注册得比插件代码晚一点），
    // 于是插件刚立起来的那块提示被一句"自动清除"抹掉 —— 而插件完全无从知道。
    const current = splashes.get(id);
    if (event.auto) {
      if (current?.auto) endSplash(event.pluginId, event.surface);
      return;
    }

    const splash = parseSplash(event.value, false);
    if (!splash) {
      endSplash(event.pluginId, event.surface);
      return;
    }

    const timer = splashTimers.get(id);
    if (timer !== undefined) {
      // 插件接管了：撤掉自动兜底。从现在起只有插件自己能撤。
      window.clearTimeout(timer);
      splashTimers.delete(id);
    }
    splashes.set(id, splash);
    notify();
  }
}

/** 装上状态指示的监听。返回退订函数。 */
export function installPluginUiState(): () => void {
  const unlisteners: UnlistenFn[] = [];
  let disposed = false;

  void (async () => {
    try {
      const stop = await listen<PluginUiEvent>(PLUGIN_UI, (event) => {
        handlePluginUiEvent(event.payload);
      });
      if (disposed) {
        stop();
        return;
      }
      unlisteners.push(stop);
    } catch (error) {
      console.warn('[pluginUiState] 无法订阅插件状态指示（徽标/进度/启动占位将不可用）:', error);
    }
  })();

  return () => {
    disposed = true;
    for (const stop of unlisteners) stop();
  };
}
