// src/services/tabStore.ts
//
// 模块标签页的唯一状态来源。
//
// 为什么需要它：在加入标签页之前，「当前显示哪个模块」由 SidebarContext 里的
// 一个字符串表示，切换即卸载 —— 切走再切回，滚动位置、未提交的表单、正在编辑
// 的草稿全部丢失。对「集中注意力、不要在多个软件之间来回切」这个目标来说，
// 这恰恰是最伤的一环：重建现场比切窗口更贵，因为重建需要主动回忆「我刚才做到
// 哪了」。标签页 + 保活就是为了消除这笔开销。
//
// 设计要点：
//   1. **唯一事实来源**。SidebarContext 不再自己持有 activeModule，而是读这里。
//      两处各存一份必然漂移（历史栈、标签高亮、关闭标签后的落点会互相矛盾）。
//   2. **惰性挂载 + 保活**。标签只有被激活过才会真正挂载（`mountedTabs`），
//      挂载后**不再卸载**，直到标签被关闭。这样重启时恢复 10 个标签不会一次
//      挂载 10 个模块，而切走的标签状态会保留。
//   3. **目录对账**。插件被卸载后它的标签必须消失。但对账**不能在插件加载
//      期间进行** —— 那会把还没注册完的插件标签全部误删（启动时插件是后台
//      加载的，这个竞态是真实存在的，`isPluginCatalogLoading` 就是为此存在的）。
//   4. 允许出现「零标签」并渲染空态，而不是强行回落到某个模块：强行回落会
//      让「关掉最后一个标签」看起来毫无反应。

import {
  getCatalogFlatMap,
  isPluginCatalogLoading,
  subscribeCatalog,
} from './moduleCatalog';
import {
  MAX_OPEN_TABS,
  getCachedSettings,
  saveAppSettings,
} from './appSettings';
import { releaseCachedModuleComponent } from './moduleComponentCache';
import { showToast } from './toast';

export interface TabState {
  /** 已打开的标签，按显示顺序 */
  openTabs: string[];
  /** 当前激活的标签；零标签时为 null */
  activeTab: string | null;
  /** 已经挂载过的标签（惰性挂载 + 保活）。运行时状态，不持久化 */
  mountedTabs: string[];
}

export type OpenTabResult = { ok: true } | { ok: false; reason: 'limit' | 'missing' };

const EMPTY_STATE: TabState = { openTabs: [], activeTab: null, mountedTabs: [] };

/** 持久化防抖：拖拽排序会连续触发多次，没必要每次都写盘 */
const PERSIST_DEBOUNCE_MS = 400;

let state: TabState = EMPTY_STATE;
let initialized = false;

/** 启动时用于兜底的模块（默认模块 / 首个可见模块），标签全部关掉后再次打开它 */
let fallbackModule = '';

/** 最近一次由我们写入后端的值，用于区分「我们自己写的」与「外部改动」 */
let lastPersistedTabs: string[] = [];
let lastPersistedActive: string | null = null;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[tabStore] 订阅者执行出错:', error);
    }
  });
}

/**
 * 写入新状态。
 *
 * **这里强制维护一条不变量：激活的标签必须同时在 `mountedTabs` 里。**
 *
 * 为什么必须在这一层做：`Home` 只渲染 `mountedTabs` 里的面板（惰性挂载），
 * 因此「activeTab 指向一个没挂载的标签」在界面上表现为 —— 标签栏高亮着某个
 * 标签，内容区却完全是空的（白屏）。这不是假设出来的情况：
 * `reconcile()` 在插件目录变化后会把 `activeTab` 改指到 `openTabs[0]`，却只对
 * `mountedTabs` 做过滤、从不追加，于是那个新激活的标签根本没有面板可渲染。
 * 实测表现正是「去设置里管理插件，回来后发现来到了白屏的仪表盘」，
 * 而手动点一下该标签就能恢复 —— 因为 `activate()` 会补上挂载。
 *
 * 与其在每个转移函数里各写一遍（`reconcile` / `closeTab` /
 * `closeTabsToTheRight` 三处都漏了，以后新增的入口还会继续漏），不如在唯一的
 * 写入点兜住：任何调用方都不可能再写出违反不变量的状态。
 */
function setState(next: TabState): void {
  const needsMount = next.activeTab !== null && !next.mountedTabs.includes(next.activeTab);

  const resolved = needsMount
    ? { ...next, mountedTabs: [...next.mountedTabs, next.activeTab!] }
    : next;

  // 不再挂载的模块，把它的组件缓存条目一并释放。
  //
  // 放在这个唯一写入点，理由与上面那条不变量完全相同：`closeTab` /
  // `closeOtherTabs` / `closeTabsToTheRight` / `closeAllTabs` / `reconcile` /
  // `resyncTabsFromSettings` 六条路径都会走到这里，逐条去调必然漏。
  //
  // 缓存的意义是「目录刷新时保持正在显示的组件实例稳定」，不再挂载就没有对象了；
  // 不释放则缓存会随「曾经打开过的模块」一直长大（虽然上限是目录里的模块数）。
  // 这里同步释放是安全的：释放之后 `resolved.mountedTabs` 已经不含它，
  // React 随后那次渲染不会再渲染它的面板。
  for (const moduleId of state.mountedTabs) {
    if (!resolved.mountedTabs.includes(moduleId)) {
      releaseCachedModuleComponent(moduleId);
    }
  }

  state = resolved;
  notify();
}

/** 订阅标签变化 */
export function subscribeTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前标签状态（不可变快照，可直接用于渲染） */
export function getTabState(): TabState {
  return state;
}

/**
 * 用启动结果初始化标签。
 *
 * 幂等：React StrictMode 在开发模式下会执行两次 effect，重复调用不应重置状态。
 */
export function initializeTabs(initialModule: string): void {
  if (initialized) return;
  initialized = true;

  fallbackModule = initialModule;

  const settings = getCachedSettings();

  // 恢复持久化的标签。
  //
  // 这里**只做格式过滤，不做目录对账**：插件模块此刻通常还没注册（插件是
  // 后台加载的），拿目录去对账会把所有插件标签当成「不存在」删掉。
  // 真正的对账交给 reconcile()，它会跳过插件加载中的时段。
  const restored = settings.openTabs.filter((id) => typeof id === 'string' && id.length > 0);

  // 恢复不出来时用启动模块兜底。若连启动模块都没有（目录里没有任何可见模块，
  // 例如内建模块被全部删除且没有插件），就保持零标签 —— 内容区会渲染空态，
  // 而不是硬塞一个并不存在的模块 ID 进去（那会显示「模块不存在」）。
  const openTabs = restored.length > 0 ? restored : initialModule ? [initialModule] : [];

  const activeTab =
    settings.activeTab && openTabs.includes(settings.activeTab)
      ? settings.activeTab
      : openTabs.includes(initialModule)
        ? initialModule
        : (openTabs[0] ?? null);

  lastPersistedTabs = settings.openTabs;
  lastPersistedActive = settings.activeTab;

  setState({ openTabs, activeTab, mountedTabs: activeTab ? [activeTab] : [] });

  subscribeCatalog(reconcile);
  reconcile();
}

/** 是否已初始化（未初始化时不应读写标签） */
export function isTabsInitialized(): boolean {
  return initialized;
}

function schedulePersist(): void {
  if (persistTimer !== null) clearTimeout(persistTimer);

  persistTimer = setTimeout(() => {
    persistTimer = null;

    const tabs = state.openTabs;
    const active = state.activeTab;

    if (arraysEqual(tabs, lastPersistedTabs) && active === lastPersistedActive) return;

    // 先记录再写：`saveAppSettings` 是乐观更新，会同步通知订阅者，
    // 提前记录可以让「这是我们自己写的」这一判断成立
    lastPersistedTabs = [...tabs];
    lastPersistedActive = active;

    saveAppSettings({ openTabs: [...tabs], activeTab: active }).catch((error) => {
      console.warn('[tabStore] 保存标签状态失败:', error);
    });
  }, PERSIST_DEBOUNCE_MS);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

/**
 * 该模块现在能否被打开。
 *
 * 插件加载期间一律放行：模块可能属于一个还没注册完的插件，此时拒绝用户打开
 * 它是错的（`ModuleRenderer` 会显示「插件正在后台加载」而不是「不存在」）。
 */
function canOpen(moduleId: string): boolean {
  if (isPluginCatalogLoading()) return true;
  return getCatalogFlatMap().has(moduleId);
}

/** 激活已打开的标签（不改变标签集合） */
function activate(moduleId: string): void {
  const mountedTabs = state.mountedTabs.includes(moduleId)
    ? state.mountedTabs
    : [...state.mountedTabs, moduleId];

  if (state.activeTab === moduleId && mountedTabs === state.mountedTabs) return;

  setState({ ...state, activeTab: moduleId, mountedTabs });
}

/**
 * 打开并激活一个模块标签。
 *
 * 已打开时只做激活。达到上限时**拒绝并提示**，而不是淘汰某个已打开的标签 ——
 * 静默关掉用户自己打开的标签是更糟的行为。
 */
export function openTab(moduleId: string): OpenTabResult {
  if (!moduleId) return { ok: false, reason: 'missing' };

  if (state.openTabs.includes(moduleId)) {
    activate(moduleId);
    schedulePersist();
    return { ok: true };
  }

  if (!canOpen(moduleId)) {
    showToast({
      title: '模块不存在',
      body: `找不到模块「${moduleId}」，它可能已被卸载。`,
      level: 'warning',
    });
    return { ok: false, reason: 'missing' };
  }

  if (state.openTabs.length >= MAX_OPEN_TABS) {
    showToast({
      title: '标签页已达上限',
      body: `最多同时打开 ${MAX_OPEN_TABS} 个标签。请先关闭一个再继续 —— 每个标签都会保留它的界面状态，因此不会自动帮你关掉。`,
      level: 'warning',
      durationMs: 6000,
    });
    return { ok: false, reason: 'limit' };
  }

  setState({ ...state, openTabs: [...state.openTabs, moduleId] });
  activate(moduleId);
  schedulePersist();
  return { ok: true };
}

/**
 * 关闭一个标签。激活的标签被关闭时激活右邻，没有右邻则激活左邻。
 *
 * 允许关到零标签（内容区渲染空态）。刻意**不**在关掉最后一个标签时自动打开
 * 别的模块：那会让「关闭」这个动作看起来没有生效。
 */
export function closeTab(moduleId: string): void {
  const index = state.openTabs.indexOf(moduleId);
  if (index === -1) return;

  const openTabs = state.openTabs.filter((id) => id !== moduleId);
  const mountedTabs = state.mountedTabs.filter((id) => id !== moduleId);

  let activeTab = state.activeTab;
  if (activeTab === moduleId) {
    activeTab = openTabs[index] ?? openTabs[index - 1] ?? null;
  }

  setState({ openTabs, activeTab, mountedTabs });
  schedulePersist();
}

/** 关闭除指定标签外的全部标签 */
export function closeOtherTabs(moduleId: string): void {
  if (!state.openTabs.includes(moduleId)) return;

  setState({
    openTabs: [moduleId],
    activeTab: moduleId,
    mountedTabs: [moduleId],
  });
  schedulePersist();
}

/** 关闭指定标签右侧的全部标签 */
export function closeTabsToTheRight(moduleId: string): void {
  const index = state.openTabs.indexOf(moduleId);
  if (index === -1) return;

  const openTabs = state.openTabs.slice(0, index + 1);
  const mountedTabs = state.mountedTabs.filter((id) => openTabs.includes(id));
  const activeTab =
    state.activeTab && openTabs.includes(state.activeTab) ? state.activeTab : moduleId;

  setState({ openTabs, activeTab, mountedTabs });
  schedulePersist();
}

/** 关闭全部标签 */
export function closeAllTabs(): void {
  if (state.openTabs.length === 0) return;
  setState({ openTabs: [], activeTab: null, mountedTabs: [] });
  schedulePersist();
}

/** 重新打开兜底模块（空态里的入口） */
export function openFallbackTab(): void {
  if (!fallbackModule) return;
  openTab(fallbackModule);
}

/** 兜底模块 ID（空态展示用） */
export function getFallbackModule(): string {
  return fallbackModule;
}

/** 把标签从 `from` 移动到 `to`（拖拽排序） */
export function moveTab(from: number, to: number): void {
  const { openTabs } = state;
  if (from === to) return;
  if (from < 0 || from >= openTabs.length) return;
  if (to < 0 || to >= openTabs.length) return;

  const next = [...openTabs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);

  setState({ ...state, openTabs: next });
  schedulePersist();
}

/** 激活第 n 个标签（从 0 开始），供 Ctrl+数字 使用 */
export function activateTabAt(index: number): boolean {
  const target = state.openTabs[index];
  if (!target) return false;
  activate(target);
  schedulePersist();
  return true;
}

/** 相对当前位置切换标签，供 Ctrl+Tab / Ctrl+Shift+Tab 使用 */
export function activateRelativeTab(offset: number): void {
  const { openTabs, activeTab } = state;
  if (openTabs.length === 0) return;

  const current = activeTab ? openTabs.indexOf(activeTab) : -1;
  const next = (current + offset + openTabs.length) % openTabs.length;
  activateTabAt(next);
}

/**
 * 与模块目录对账：丢掉已经不存在的模块的标签。
 *
 * **插件加载期间直接返回。** 这是本文件里最容易写错的地方：启动时插件模块尚未
 * 注册，若此时对账，所有属于插件的标签都会被判定为「不存在」而被删除，表现为
 * 「重启后插件标签全没了」。`setPluginCatalogLoading(false)` 会触发一次目录
 * 通知，因此加载结束后这里仍会被调用一次，那时才是正确的对账时机。
 */
function reconcile(): void {
  if (!initialized) return;
  if (isPluginCatalogLoading()) return;

  const catalog = getCatalogFlatMap();

  const openTabs = state.openTabs.filter((id) => catalog.has(id));
  if (openTabs.length === state.openTabs.length) return;

  const dropped = state.openTabs.length - openTabs.length;
  console.info(`[tabStore] 对账移除了 ${dropped} 个已失效的标签`);

  const mountedTabs = state.mountedTabs.filter((id) => openTabs.includes(id));

  let activeTab = state.activeTab;
  if (activeTab && !openTabs.includes(activeTab)) {
    activeTab = openTabs[0] ?? null;
  }

  setState({ openTabs, activeTab, mountedTabs });
  schedulePersist();
}

/**
 * 从设置重新同步标签（供「恢复默认设置」调用）。
 *
 * 刻意**不**订阅 `subscribeSettings` 自动接管：`saveAppSettings` 是乐观更新，
 * 会同步通知订阅者，自动接管会形成「自己写 → 自己收到通知 → 再接管」的回路，
 * 也让「谁改了标签」变得难以追踪。改为由明确的外部改动点显式调用。
 */
export function resyncTabsFromSettings(): void {
  if (!initialized) return;

  const settings = getCachedSettings();

  lastPersistedTabs = settings.openTabs;
  lastPersistedActive = settings.activeTab;

  const restored = settings.openTabs.filter(Boolean);
  const openTabs = restored.length > 0 ? restored : fallbackModule ? [fallbackModule] : [];

  const activeTab =
    settings.activeTab && openTabs.includes(settings.activeTab)
      ? settings.activeTab
      : (openTabs[0] ?? null);

  const mountedTabs = activeTab
    ? Array.from(new Set([...state.mountedTabs.filter((id) => openTabs.includes(id)), activeTab]))
    : [];

  setState({ openTabs, activeTab, mountedTabs });
  reconcile();
}
