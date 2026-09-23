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
//   5. **分屏是两个标签组**，不是一个标签栏加右边多显示一个模块。每组有自己的
//      标签栏、自己的激活标签、自己的关闭语义 —— 这是分屏能被真正用起来的前提：
//      右边那半必须能自己切标签、自己关标签，否则它只是一个钉死的预览。

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
import { moduleManager } from './moduleManager';
import { selectEvictions } from './tabEvictionPolicy';
import { pruneMountedTabs } from './tabMountedPolicy';
import { showToast } from './toast';

/**
 * 标签所属的组。
 *
 * `primary` 是第一组（左），`split` 是分屏出来的第二组（右）。两组地位对等 ——
 * 「左」只是初始位置，用户可以把标签在两组之间来回拖。
 */
export type TabGroupId = 'primary' | 'split';

export interface TabState {
  /** 第一组的标签，按显示顺序 */
  openTabs: string[];
  /** 第一组当前激活的标签；该组为空时为 null */
  activeTab: string | null;
  /**
   * 第二组的标签。**空数组表示未分屏** —— 用「有没有标签」而不是一个额外的布尔量
   * 来表达分屏状态，两者就不会出现「标记为分屏但右边是空的」这种自相矛盾的状态。
   */
  splitTabs: string[];
  /** 第二组当前激活的标签 */
  splitActive: string | null;
  /**
   * 焦点在哪个组。
   *
   * 分屏之后「用户现在在操作哪一半」变成一个必须回答的问题：侧边栏高亮、
   * `Ctrl+W` 关哪个标签、`Ctrl+Tab` 在哪个组内轮转，都要看它。不记录的话这些
   * 都会固定作用在第一组，而用户可能正在右半工作 —— 表现为「按 Ctrl+W 关掉了
   * 左边那个」。
   *
   * 运行时状态，**不持久化**：它是"当下在看哪边"，重启后回到左组是合理的。
   */
  focusedGroup: TabGroupId;
  /** 已经挂载过的标签（惰性挂载 + 保活）。运行时状态，不持久化 */
  mountedTabs: string[];
}

export type OpenTabResult = {
  ok: true;
} | {
  ok: false;
  reason: 'limit' | 'missing' | 'last-in-primary';
};

const EMPTY_STATE: TabState = {
  openTabs: [],
  activeTab: null,
  splitTabs: [],
  splitActive: null,
  focusedGroup: 'primary',
  mountedTabs: [],
};

/** 持久化防抖：拖拽排序会连续触发多次，没必要每次都写盘 */
const PERSIST_DEBOUNCE_MS = 400;

let state: TabState = EMPTY_STATE;
let initialized = false;

/** 启动时用于兜底的模块（默认模块 / 首个可见模块），标签全部关掉后再次打开它 */
let fallbackModule = '';

/** 最近一次由我们写入后端的值，用于区分「我们自己写的」与「外部改动」 */
let lastPersistedTabs: string[] = [];
let lastPersistedActive: string | null = null;
let lastPersistedSplitTabs: string[] = [];
let lastPersistedSplitActive: string | null = null;

/**
 * 每个标签**最后一次被显示**的时刻。
 *
 * 用一个单调递增的计数而不是数组位置，理由见 `tabEvictionPolicy.ts`：
 * "没有记录"必须是一个**显式的最低优先级**，而不是靠排序稳定性碰巧得到的结果。
 *
 * 只在内存里，不持久化 —— 它是"这次运行里用户看过什么"，重启后重新观察即可。
 * 持久化反而有害：一份几天前的使用顺序会让下一次启动的淘汰选中错误的标签。
 *
 * 由 `setState` 在激活项变化时维护（见那里的说明），因此不需要每个切换路径
 * 各自记得更新它。
 */
let lastSeen: Record<string, number> = {};

/** `lastSeen` 的单调计数（每次有标签被显示就 +1） */
let lastSeenClock = 0;

/**
 * 已经淘汰过多少次（本次运行内）。
 *
 * 存在的理由是**可观测性**：淘汰是静默的（用户只会发现某个标签不见了），
 * 因此需要有一个数字能回答"到底淘不淘汰、淘了几次"。
 * 设置 → 性能那一页会读它。
 */
let evictionCount = 0;

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

// ============================================================
// 组的读取 / 写入辅助
// ============================================================

function groupTabs(target: TabState, group: TabGroupId): string[] {
  return group === 'primary' ? target.openTabs : target.splitTabs;
}

function groupActive(target: TabState, group: TabGroupId): string | null {
  return group === 'primary' ? target.activeTab : target.splitActive;
}

/** 把某一组的标签与激活项写回去，其它组原样保留 */
function withGroup(
  target: TabState,
  group: TabGroupId,
  tabs: string[],
  active: string | null
): TabState {
  return group === 'primary'
    ? { ...target, openTabs: tabs, activeTab: active }
    : { ...target, splitTabs: tabs, splitActive: active };
}

/** 某个标签在哪个组里；不在任何组时返回 null */
export function getTabGroup(moduleId: string): TabGroupId | null {
  if (state.openTabs.includes(moduleId)) return 'primary';
  if (state.splitTabs.includes(moduleId)) return 'split';
  return null;
}

/** 打开着的标签总数（两组之和） */
function totalTabs(target: TabState): number {
  return target.openTabs.length + target.splitTabs.length;
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

// ============================================================
// 唯一写入点
// ============================================================

/**
 * 写入新状态。
 *
 * **所有不变量都收在这一层**，因为它同时是六条以上转移路径的必经之处
 * （`closeTab` / `closeOtherTabs` / `closeTabsToTheRight` / `closeAllTabs` /
 * `reconcile` / `resyncTabsFromSettings` / 以及分屏的移动）。逐条去维护必然漏，
 * 而漏掉的表现都是"界面与状态不一致"这类不报错的故障。
 *
 * 这里强制五件事：
 *   1. 两组的标签各自去重；
 *   2. **同一个标签不能同时在两组**（分屏组优先，它代表用户更近的一次意图）；
 *   3. 每组的激活标签必须属于该组，否则回落到该组第一个（或 null）；
 *   4. 两组的激活标签都必须已挂载 —— `Home` 只渲染 `mountedTabs` 里的面板，
 *      「激活了但没挂载」表现为标签栏高亮着、内容区却空白（白屏）。
 *   5. **挂载集合必须随关闭收缩** —— 关闭标签要真的卸载面板并释放它的组件缓存。
 *      这一条曾经缺失，表现是"关掉的标签还在占内存"，而四类不变量看上去都成立。
 */
function setState(next: TabState): void {
  let splitTabs = dedupe(next.splitTabs);
  let openTabs = dedupe(next.openTabs).filter((id) => !splitTabs.includes(id));

  // 第一组不能空着而第二组还有标签：左边一片空白、右边有内容，那不像分屏，
  // 像界面坏了。关掉第一组最后一个标签时把第二组的激活标签补过来。
  //
  // 这条与 `openInSplit` 里的"不允许把第一组搬空"是同一件事的两端：那个挡住入口，
  // 这个兜住出口（关闭标签、目录对账都可能让第一组变空）。
  if (openTabs.length === 0 && splitTabs.length > 0) {
    const moved = next.splitActive && splitTabs.includes(next.splitActive)
      ? next.splitActive
      : splitTabs[0];
    openTabs = [moved];
    splitTabs = splitTabs.filter((id) => id !== moved);
  }

  let activeTab = next.activeTab;
  if (!activeTab || !openTabs.includes(activeTab)) {
    activeTab = openTabs[0] ?? null;
  }

  let splitActive = next.splitActive;
  if (!splitActive || !splitTabs.includes(splitActive)) {
    splitActive = splitTabs[0] ?? null;
  }

  // 挂载集合先**收缩**再用激活标签补齐。
  //
  // 这里曾经只有「补齐」的一半：集合只增不减，于是**关闭标签不会卸载面板**
  // （`Home` 继续渲染它，DOM 子树、React 树、模块内部的定时器与订阅全都活着），
  // 而且下面那段缓存释放循环的判据 `!resolved.mountedTabs.includes(id)` 恒为 false，
  // 让 `releaseCachedModuleComponent` 变成死代码。规则与它的完整论证见
  // `tabMountedPolicy.ts` —— 抽出去是为了它能被脚本直接跑（这里进不了纯脚本 project）。
  const mountedTabs = pruneMountedTabs(
    next.mountedTabs,
    openTabs,
    splitTabs,
    activeTab,
    splitActive
  );

  // 焦点组必须是一个**有内容的**组：指向空组会让"当前模块"变成 null，
  // 侧边栏高亮随之消失，而用户看到的是右边明明有内容。
  let focusedGroup = next.focusedGroup;
  if (focusedGroup === 'split' && splitTabs.length === 0) focusedGroup = 'primary';
  if (focusedGroup === 'primary' && openTabs.length === 0 && splitTabs.length > 0) {
    focusedGroup = 'split';
  }

  const resolved: TabState = {
    openTabs,
    activeTab,
    splitTabs,
    splitActive,
    focusedGroup,
    mountedTabs,
  };

  // 不再挂载的模块，把它的组件缓存条目一并释放。
  //
  // 放在这个唯一写入点，理由与上面那些不变量相同：六条以上路径都会走到这里，
  // 逐条去调必然漏。缓存的意义是「目录刷新时保持正在显示的组件实例稳定」，
  // 不再挂载就没有对象了；不释放则缓存会随「曾经打开过的模块」一直长大。
  // 这里同步释放是安全的：释放之后 `resolved.mountedTabs` 已不含它，
  // React 随后那次渲染不会再渲染它的面板。
  //
  // 【这段曾经是死代码】判据成立的前提是 `mountedTabs` 会收缩，而它当时不会
  // （见上面第 5 条不变量）。现在收缩规则在 `tabMountedPolicy.ts`，并由
  // `pnpm check:memory` 直接跑它断言 —— 光看这里"有没有调用"是查不出问题的，
  // 这正是它当初藏住的原因。
  for (const moduleId of state.mountedTabs) {
    if (!resolved.mountedTabs.includes(moduleId)) {
      releaseCachedModuleComponent(moduleId);
    }
  }

  // 最近使用记录：把这一轮的激活项打上"现在"的时刻，并清掉已经关掉的标签。
  //
  // 同样收在唯一写入点：激活项变化的路径有六七条（点标签、快捷键、分屏切组、
  // 目录对账……），逐条维护必然漏，而漏掉的表现是"某个刚看过的标签被优先淘汰"。
  lastSeen = updateRecency(lastSeen, resolved);

  state = resolved;
  notify();
}

/**
 * 更新"最后一次被显示"的记录。
 *
 * 语义是"最近一次被**显示**"，不是"最近一次被打开"：用户开着 A 打字、切到 B
 * 查资料、再切回 A 继续打 —— A 才是用户更在意的那一个，而它按"打开时间"会被
 * 当成最旧的。只有"最近被显示"能表达"用户现在在看什么"。
 *
 * 已关闭的标签一并清掉：留着它们会让这份记录随"曾经打开过的标签"一直长大，
 * 而它只在淘汰判定里用得到 —— 一个已关闭的标签永远不会是淘汰对象。
 */
function updateRecency(previous: Record<string, number>, resolved: TabState): Record<string, number> {
  const live = new Set<string>([...resolved.openTabs, ...resolved.splitTabs]);

  const next: Record<string, number> = {};
  for (const [id, stamp] of Object.entries(previous)) {
    if (live.has(id)) next[id] = stamp;
  }

  for (const id of [resolved.activeTab, resolved.splitActive]) {
    if (!id || !live.has(id)) continue;
    lastSeenClock += 1;
    next[id] = lastSeenClock;
  }

  return next;
}

/** 本次运行内已经淘汰过多少个标签（供设置 → 性能展示） */
export function getEvictionCount(): number {
  return evictionCount;
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

/** 是否处于分屏状态 */
export function isSplit(): boolean {
  return state.splitTabs.length > 0;
}

// ============================================================
// 初始化与持久化
// ============================================================

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

  /**
   * 是否恢复窗口状态。
   *
   * **关闭时一概不恢复** —— 不只是"默认打开哪个模块"，而是标签集合、当前标签与
   * 分屏布局全部忽略，从默认模块重新开始。
   *
   * 这里曾经只让 `resolveInitialModule()` 读这个开关，而标签集合仍然被无条件恢复，
   * 于是关掉开关后重启依然回到关闭前的那一刻：开关看起来毫无作用。
   */
  const restore = settings.restoreLastModule;

  // 恢复持久化的标签。
  //
  // 这里**只做格式过滤，不做目录对账**：插件模块此刻通常还没注册（插件是
  // 后台加载的），拿目录去对账会把所有插件标签当成「不存在」删掉。
  // 真正的对账交给 reconcile()，它会跳过插件加载中的时段。
  const restored = restore ? dedupe(settings.openTabs.filter(Boolean)) : [];

  // 恢复不出来时用启动模块兜底。若连启动模块都没有（目录里没有任何可见模块，
  // 例如内建模块被全部删除且没有插件），就保持零标签 —— 内容区会渲染空态，
  // 而不是硬塞一个并不存在的模块 ID 进去（那会显示「模块不存在」）。
  const openTabs = restored.length > 0 ? restored : initialModule ? [initialModule] : [];

  // 分屏组的恢复：**必须与第一组去重**（同一个标签不能同时出现在两组）。
  // 否则一份被手工改坏的设置会让同一个模块渲染两遍 —— 两份组件、两套定时器。
  const splitTabs = restore
    ? dedupe(settings.splitTabs.filter(Boolean)).filter((id) => !openTabs.includes(id))
    : [];

  const activeTab =
    settings.activeTab && openTabs.includes(settings.activeTab)
      ? settings.activeTab
      : openTabs.includes(initialModule)
        ? initialModule
        : (openTabs[0] ?? null);

  const splitActive =
    settings.splitActive && splitTabs.includes(settings.splitActive)
      ? settings.splitActive
      : (splitTabs[0] ?? null);

  lastPersistedTabs = settings.openTabs;
  lastPersistedActive = settings.activeTab;
  lastPersistedSplitTabs = settings.splitTabs;
  lastPersistedSplitActive = settings.splitActive;

  // mountedTabs 只放第一组的激活标签：其余由 setState 补齐（见那里的不变量）
  setState({
    openTabs,
    activeTab,
    splitTabs,
    splitActive,
    // 启动时焦点总在第一组：右组恢复出来了，但"用户在看哪边"重启后无从得知
    focusedGroup: 'primary',
    mountedTabs: activeTab ? [activeTab] : [],
  });

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

    // 开关关闭时不写窗口状态。
    //
    // 写了也不会被读（`initializeTabs` 会忽略），但留一份越来越旧的数据会让
    // "以后重新打开开关"恢复出一个陈旧布局 —— 而那正是这条设置最容易被误解的地方。
    // 重新打开的那一刻由 `persistWindowStateNow()` 把**当前**状态写进去，因此
    // 不需要在关闭时清空：数据只会在开关打开期间被更新。
    if (!getCachedSettings().restoreLastModule) return;

    const tabs = state.openTabs;
    const active = state.activeTab;
    const splitTabs = state.splitTabs;
    const splitActive = state.splitActive;

    if (
      arraysEqual(tabs, lastPersistedTabs) &&
      active === lastPersistedActive &&
      arraysEqual(splitTabs, lastPersistedSplitTabs) &&
      splitActive === lastPersistedSplitActive
    ) {
      return;
    }

    // 先记录再写：`saveAppSettings` 是乐观更新，会同步通知订阅者，
    // 提前记录可以让「这是我们自己写的」这一判断成立
    lastPersistedTabs = [...tabs];
    lastPersistedActive = active;
    lastPersistedSplitTabs = [...splitTabs];
    lastPersistedSplitActive = splitActive;

    saveAppSettings({
      openTabs: [...tabs],
      activeTab: active,
      splitTabs: [...splitTabs],
      splitActive,
    }).catch((error) => {
      console.warn('[tabStore] 保存标签状态失败:', error);
    });
  }, PERSIST_DEBOUNCE_MS);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

/**
 * 立刻把**当前**窗口状态写进设置。
 *
 * 只有一个调用点：用户把「恢复上次的窗口状态」**从关切到开**的那一刻。
 *
 * 为什么必须有它：开关关闭期间不再写盘，设置里留着的是更早的一次布局。若不在
 * 重新打开时刷新，用户开关一开、重启，回到的是那个陈旧布局 —— 而他记得的明明是
 * "我刚刚开着这几个标签"。写一次当前状态，就把"你现在看到的"变成"下次恢复的"。
 */
export function persistWindowStateNow(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  lastPersistedTabs = [...state.openTabs];
  lastPersistedActive = state.activeTab;
  lastPersistedSplitTabs = [...state.splitTabs];
  lastPersistedSplitActive = state.splitActive;

  saveAppSettings({
    openTabs: [...state.openTabs],
    activeTab: state.activeTab,
    splitTabs: [...state.splitTabs],
    splitActive: state.splitActive,
    // `lastModule` 一并刷新：否则「恢复上次停留的模块」会指向一个更早的位置，
    // 与刚写进去的 activeTab 对不上
    lastModule: getFocusedActiveTab(),
  }).catch((error) => {
    console.warn('[tabStore] 写入窗口状态失败:', error);
  });
}

// ============================================================
// 打开与激活
// ============================================================

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

/**
 * 达到上限、且**没有可淘汰对象**时的提示。
 *
 * 这条提示的措辞在加入淘汰之后必须改：它此前写"不会自动帮你关掉"，
 * 而那句话现在只在下述这一种情况下才成立 —— 其余情况下我们**会**淘汰。
 * 让提示与真实行为相反，比没有提示更糟：用户会照着它去推断。
 */
function warnLimit(): void {
  showToast({
    title: '标签页已达上限',
    body:
      `最多同时打开 ${MAX_OPEN_TABS} 个标签（含分屏那一组）。` +
      `当前打开的全部标签都受保护（正在显示、置顶或收藏），因此没有可以回收的。` +
      `请先关闭一个，或取消某个标签的置顶/收藏。`,
    level: 'warning',
    durationMs: 6000,
  });
}

/** 激活某一组里已打开的标签（不改变标签集合） */
export function activateInGroup(group: TabGroupId, moduleId: string): void {
  const tabs = groupTabs(state, group);
  if (!tabs.includes(moduleId)) return;
  if (groupActive(state, group) === moduleId && state.focusedGroup === group) return;

  // 激活某个组里的标签 = 用户把注意力放到了这个组，焦点随之转移
  setState({ ...withGroup(state, group, tabs, moduleId), focusedGroup: group });
  schedulePersist();
}

/**
 * 把一个**尚未打开**的模块加入指定组，并激活它、把焦点给这一组。
 *
 * 调用方负责先做「模块是否存在」与「是否已达上限」的检查。
 */
function addTabToGroup(group: TabGroupId, moduleId: string): void {
  setState(
    group === 'split'
      ? {
          ...state,
          splitTabs: [...state.splitTabs, moduleId],
          splitActive: moduleId,
          focusedGroup: 'split',
        }
      : {
          ...state,
          openTabs: [...state.openTabs, moduleId],
          activeTab: moduleId,
          focusedGroup: 'primary',
        }
  );
  schedulePersist();
}

/** 把焦点移交给某一组（供"点进哪一半就聚焦哪一半"使用） */
export function setFocusedGroup(group: TabGroupId): void {
  if (state.focusedGroup === group) return;
  if (group === 'primary' && state.openTabs.length === 0) return;
  if (group === 'split' && state.splitTabs.length === 0) return;

  setState({ ...state, focusedGroup: group });
}

/**
 * 打开并激活一个模块标签。
 *
 * **落在焦点组里。** 分屏之后"从侧边栏打开一个模块"要出现在用户正在工作的那一半 ——
 * 固定落进第一组会让右半的用户每开一个模块都要再搬一次。
 *
 * 已打开时只做激活 —— **包括它当前在另一组里的情况**：那时"打开"的语义是把焦点移到
 * 它所在的组，而不是把它搬过来。搬动是显式动作（拖拽或右键菜单）。
 */
export function openTab(moduleId: string): OpenTabResult {
  if (!moduleId) return { ok: false, reason: 'missing' };

  const existingGroup = getTabGroup(moduleId);
  if (existingGroup) {
    activateInGroup(existingGroup, moduleId);
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

  // 达到上限时**先尝试淘汰**，而不是直接拒绝。
  //
  // 这条策略是在"保活"与"内存上限"之间的取舍：保活承诺"切走不卸载"，
  // 但一个开了很久、早已没人看的标签，它的现场值不值那份内存？
  // 用户已明确同意这个方向：**只淘汰最久未显示且非用户固定的标签**。
  //
  // 三条不可退让的界线（都收在 `tabEvictionPolicy.ts` 里）：
  //   1. 正在显示的两个标签永不淘汰 —— 那是当着用户的面关界面；
  //   2. 置顶与收藏的标签受保护 —— 它们表达的是"我常用的"；
  //   3. 没有任何可淘汰对象时**如实拒绝**并说明原因，而不是硬挤一个进去。
  if (totalTabs(state) >= MAX_OPEN_TABS) {
    const evicted = evictToMakeRoom(1);
    if (evicted === 0) {
      warnLimit();
      return { ok: false, reason: 'limit' };
    }
  }

  const target: TabGroupId =
    state.focusedGroup === 'split' && state.splitTabs.length > 0 ? 'split' : 'primary';

  addTabToGroup(target, moduleId);
  return { ok: true };
}

/**
 * 腾出 `needed` 个标签位置，返回**实际腾出的数量**。
 *
 * 返回 0 表示没有可淘汰的对象（全部受保护，或除了正在显示的之外都还没挂载过）。
 * 调用方据此决定"如实拒绝"还是"继续"。
 *
 * 为什么在这里一次性算出全部淘汰对象、再一次性关闭，而不是循环调用 `closeTab`：
 * `closeTab` 有自己的兜底逻辑（"第一组不能空着"会从第二组搬一个过来），
 * 在循环里连续触发会让淘汰的落点变得难以预测。一次性构造出最终状态则明确得多。
 */
function evictToMakeRoom(needed: number): number {
  const victims = selectEvictions({
    openTabs: state.openTabs,
    splitTabs: state.splitTabs,
    activeTab: state.activeTab,
    splitActive: state.splitActive,
    mountedTabs: state.mountedTabs,
    lastSeen,
    pinnedIds: moduleManager.getPinnedModules(),
    favoriteIds: moduleManager.getFavoriteIds(),
    needed,
  });

  if (victims.length === 0) return 0;

  const doomed = new Set(victims);
  const openTabs = state.openTabs.filter((id) => !doomed.has(id));
  const splitTabs = state.splitTabs.filter((id) => !doomed.has(id));

  // 淘汰之后的激活项一律回落到该组第一个 —— 淘汰永远不会选中激活项
  // （见 `selectEvictions`），因此这里只是把类型收窄，不会真的发生切换。
  setState({
    ...state,
    openTabs,
    splitTabs,
    activeTab: openTabs.includes(state.activeTab ?? '') ? state.activeTab : openTabs[0] ?? null,
    splitActive: splitTabs.includes(state.splitActive ?? '')
      ? state.splitActive
      : splitTabs[0] ?? null,
  });

  evictionCount += victims.length;

  // **如实告知**：淘汰是静默的，用户只会发现某个标签不见了。
  // 不提示的话，这看起来像是"标签自己消失了"——那是故障的观感，而不是策略。
  showToast({
    title: `已回收 ${victims.length} 个长时间未使用的标签`,
    body:
      `同时打开的标签上限是 ${MAX_OPEN_TABS} 个，每个都会保留它的界面状态，` +
      `因此长时间没看过的标签会被回收。置顶与收藏的模块不会被回收；` +
      `被回收的标签重新打开时会是一个新的界面。`,
    level: 'info',
    durationMs: 6000,
  });

  return victims.length;
}

// ============================================================
// 分屏：两组的划分
// ============================================================

/** 「已经分屏」的统一提示：分屏的前提是两边都还有标签 */
function warnLastInPrimary(): void {
  showToast({
    title: '不能再分屏了',
    body: '分屏需要两组各有至少一个标签。左边只剩这一个时无法再分出去 —— 可以先在左边打开另一个模块。',
    level: 'info',
    durationMs: 5000,
  });
}

/**
 * 把一个标签移到分屏组（右），并激活它。
 *
 * 语义是**移动**而不是复制：同一个模块不会在两处同时渲染。复制会带来两份组件实例、
 * 两套定时器与两套存储写入，而"我想同时看两个不同的东西"才是分屏的真实用途。
 *
 * 若第一组移出后就没有标签了，**拒绝**并提示 —— 否则左边会变成一片空态，
 * 那不像分屏，像把窗口弄坏了。
 */
export function openInSplit(moduleId: string): OpenTabResult {
  if (!moduleId) return { ok: false, reason: 'missing' };

  // 已经在分屏组里：只做激活，相当于"把这半切到它"
  if (state.splitTabs.includes(moduleId)) {
    activateInGroup('split', moduleId);
    return { ok: true };
  }

  // 尚未打开：直接放进右组（不必先落到左组再搬一次）
  if (!state.openTabs.includes(moduleId)) {
    if (!canOpen(moduleId)) {
      showToast({
        title: '模块不存在',
        body: `找不到模块「${moduleId}」，它可能已被卸载。`,
        level: 'warning',
      });
      return { ok: false, reason: 'missing' };
    }
    if (totalTabs(state) >= MAX_OPEN_TABS) {
      warnLimit();
      return { ok: false, reason: 'limit' };
    }
    // 左组为空时"分屏"无从谈起：右组要有内容，左组也得有
    if (state.openTabs.length === 0) {
      warnLastInPrimary();
      return { ok: false, reason: 'last-in-primary' };
    }

    addTabToGroup('split', moduleId);
    return { ok: true };
  }

  const openTabs = state.openTabs.filter((id) => id !== moduleId);
  if (openTabs.length === 0) {
    warnLastInPrimary();
    return { ok: false, reason: 'last-in-primary' };
  }

  setState({
    ...state,
    openTabs,
    activeTab: state.activeTab === moduleId ? (openTabs[0] ?? null) : state.activeTab,
    splitTabs: [...state.splitTabs, moduleId],
    splitActive: moduleId,
    // 刚把标签放进右组，焦点应当在它身上
    focusedGroup: 'split',
  });
  schedulePersist();
  return { ok: true };
}

/**
 * 在分屏组里打开一个模块（右半自己的标签栏用它）。
 *
 * 与 `openInSplit` 的区别只在于**不要求**这个模块原本在第一组：右侧标签栏可以
 * 直接打开一个还没出现过的模块，那是最自然的用法。
 */
export function openInSplitGroup(moduleId: string): OpenTabResult {
  if (!moduleId) return { ok: false, reason: 'missing' };

  if (state.splitTabs.includes(moduleId)) {
    activateInGroup('split', moduleId);
    return { ok: true };
  }

  if (state.openTabs.includes(moduleId)) {
    // 已在左半：这是"移到右边"的动作
    return openInSplit(moduleId);
  }

  if (!canOpen(moduleId)) {
    showToast({
      title: '模块不存在',
      body: `找不到模块「${moduleId}」，它可能已被卸载。`,
      level: 'warning',
    });
    return { ok: false, reason: 'missing' };
  }

  if (totalTabs(state) >= MAX_OPEN_TABS) {
    warnLimit();
    return { ok: false, reason: 'limit' };
  }

  addTabToGroup('split', moduleId);
  return { ok: true };
}

/**
 * 关闭分屏：把第二组的标签**并回第一组**，而不是丢弃它们。
 *
 * 「关闭分屏」是改布局，不是关标签 —— 把用户开着的东西顺手删掉是最不能接受的
 * 一类行为。要真的关掉那些标签，用它们各自的关闭按钮。
 */
export function closeSplit(): void {
  if (state.splitTabs.length === 0) return;

  setState({
    ...state,
    openTabs: [...state.openTabs, ...state.splitTabs],
    splitTabs: [],
    splitActive: null,
    focusedGroup: 'primary',
  });
  schedulePersist();
}

/**
 * 把一个标签移到另一组（供拖拽与右键菜单使用）。
 *
 * `index` 给定时插入到该位置，否则追加到末尾。移出后若源组为空：
 *   * 源组是分屏组 → 等同于「关闭分屏」（第二组自然消失）；
 *   * 源组是第一组 → 拒绝：左边不能空。
 */
export function moveTabToGroup(
  moduleId: string,
  target: TabGroupId,
  index?: number
): OpenTabResult {
  const source = getTabGroup(moduleId);
  if (!source) return { ok: false, reason: 'missing' };
  if (source === target) return { ok: true };

  const sourceTabsBefore = groupTabs(state, source);
  const sourceIndex = sourceTabsBefore.indexOf(moduleId);
  const sourceTabs = sourceTabsBefore.filter((id) => id !== moduleId);
  if (source === 'primary' && sourceTabs.length === 0) {
    warnLastInPrimary();
    return { ok: false, reason: 'last-in-primary' };
  }

  const targetTabs = [...groupTabs(state, target)];
  const insertAt = index === undefined || index < 0 || index > targetTabs.length
    ? targetTabs.length
    : index;
  targetTabs.splice(insertAt, 0, moduleId);

  // 目标组的激活标签设为刚移过去的这个 —— 用户刚把它拖过去，焦点应当在它身上
  let next = withGroup(state, target, targetTabs, moduleId);

  // 源组的激活标签被移走时，让它落到**原位置**的邻居上（与关闭标签同一规则：
  // 先取右邻，没有右邻则取左邻）。用目标下标来挑是错的 —— 那是另一组的坐标系。
  const sourceActive = groupActive(state, source) === moduleId
    ? (sourceTabs[sourceIndex] ?? sourceTabs[sourceIndex - 1] ?? null)
    : groupActive(state, source);

  next = withGroup(next, source, sourceTabs, sourceActive);

  // 焦点跟随被移动的标签：用户刚把它拖过去，接着要操作的就是它
  setState({ ...next, focusedGroup: target });
  schedulePersist();
  return { ok: true };
}

/**
 * 切换分屏状态。
 *
 * * 已分屏 → 关闭分屏（标签并回第一组）。
 * * 未分屏 → 把**焦点组的当前标签**搬到右半。
 *
 * 「搬走当前标签」而不是「挑一个别的」：用户按下这个键时，意图是"把我在看的这个
 * 挪到旁边去"，而挑一个他没选的标签正是上一版的抱怨（"分屏默认仪表盘模块"）。
 * 左边因此会落到它的邻居上 —— 这是搬走的必然结果，不是副作用。
 *
 * 第一组只剩这一个标签时 `openInSplit` 会拒绝并提示：搬走它左边就空了，
 * 那不像分屏，像把窗口弄坏。
 */
export function toggleSplit(): void {
  if (state.splitTabs.length > 0) {
    closeSplit();
    return;
  }

  const current = getFocusedActiveTab();
  if (!current) {
    showToast({
      title: '没有可分屏的标签',
      body: '先打开至少一个模块，再按一次。',
      level: 'info',
      durationMs: 4000,
    });
    return;
  }

  // 失败原因（只剩一个标签 / 已达上限）由 openInSplit 给出各自的提示
  openInSplit(current);
}

/** 第二组的标签（渲染层判断分屏与铺排右半用） */
export function getSplitTabs(): string[] {
  return state.splitTabs;
}

// ============================================================
// 关闭
// ============================================================

/**
 * 关闭一个标签（从它所在的组里）。
 *
 * 激活的标签被关闭时激活同组的右邻，没有右邻则激活左邻。若关掉的是分屏组最后
 * 一个标签，分屏自然结束（`splitTabs` 为空 = 单栏）—— 这不需要额外的清场逻辑。
 */
export function closeTab(moduleId: string): void {
  const group = getTabGroup(moduleId);
  if (!group) return;

  const tabs = groupTabs(state, group);
  const index = tabs.indexOf(moduleId);
  const remaining = tabs.filter((id) => id !== moduleId);

  let active = groupActive(state, group);
  if (active === moduleId) {
    active = remaining[index] ?? remaining[index - 1] ?? null;
  }

  setState(withGroup(state, group, remaining, active));
  schedulePersist();
}

/** 关闭**同组**内除指定标签外的全部标签（另一组不动 —— 那是另一半的布局） */
export function closeOtherTabs(moduleId: string): void {
  const group = getTabGroup(moduleId);
  if (!group) return;

  setState(withGroup(state, group, [moduleId], moduleId));
  schedulePersist();
}

/** 关闭**同组**内指定标签右侧的全部标签 */
export function closeTabsToTheRight(moduleId: string): void {
  const group = getTabGroup(moduleId);
  if (!group) return;

  const tabs = groupTabs(state, group);
  const index = tabs.indexOf(moduleId);
  if (index === -1) return;

  const remaining = tabs.slice(0, index + 1);
  const active = groupActive(state, group);
  const nextActive = active && remaining.includes(active) ? active : moduleId;

  setState(withGroup(state, group, remaining, nextActive));
  schedulePersist();
}

/**
 * 关闭全部标签（两组一起）。
 *
 * 这一项刻意**跨组**生效：菜单上它写的是「关闭全部标签」，只关一半会让用户以为
 * 没生效。想只关一半，用「关闭其他标签」。
 */
export function closeAllTabs(): void {
  if (totalTabs(state) === 0) return;
  // 全部关掉时最近使用记录也归零：留着它只会积一堆已经不存在的标签，
  // 而那些数据在淘汰判定里只会被清掉 —— 不如现在就清。
  lastSeen = {};
  setState({ ...EMPTY_STATE });
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

// ============================================================
// 排序与快捷键
// ============================================================

/** 在**某一组内**把标签从 `from` 移动到 `to`（拖拽排序） */
export function moveTabInGroup(group: TabGroupId, from: number, to: number): void {
  const tabs = groupTabs(state, group);
  if (from === to) return;
  if (from < 0 || from >= tabs.length) return;
  if (to < 0 || to >= tabs.length) return;

  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);

  setState({
    ...withGroup(state, group, next, groupActive(state, group)),
    focusedGroup: group,
  });
  schedulePersist();
}

/** 兼容旧签名：在第一组内排序 */
export function moveTab(from: number, to: number): void {
  moveTabInGroup('primary', from, to);
}

/** 当前有焦点的那个组的激活标签（侧边栏高亮、`Ctrl+W` 都以它为准） */
export function getFocusedActiveTab(): string | null {
  return groupActive(state, state.focusedGroup);
}

/** 关闭**焦点组**里的激活标签（供 Ctrl+W 使用） */
export function closeActiveTab(): void {
  const active = getFocusedActiveTab();
  if (active) closeTab(active);
}

/**
 * 激活**焦点组**的第 n 个标签（从 0 开始），供 Ctrl+数字 使用。
 *
 * 在焦点组内轮转而不是固定第一组：用户在半边工作时按 Ctrl+2，期望的是"切到这半边的
 * 第二个标签"。固定第一组会让这个键在另一半上完全无效。
 */
export function activateTabAt(index: number): boolean {
  const group = state.focusedGroup;
  const target = groupTabs(state, group)[index];
  if (!target) return false;
  activateInGroup(group, target);
  return true;
}

/** 在**焦点组**内相对切换标签，供 Ctrl+Tab / Ctrl+Shift+Tab 使用 */
export function activateRelativeTab(offset: number): void {
  const group = state.focusedGroup;
  const tabs = groupTabs(state, group);
  if (tabs.length === 0) return;

  const active = groupActive(state, group);
  const current = active ? tabs.indexOf(active) : -1;
  const next = (current + offset + tabs.length) % tabs.length;
  activateTabAt(next);
}

/** 在两组之间循环切换焦点（供 Ctrl+` 之类的"跳到另一半"使用） */
export function focusOtherGroup(): void {
  if (state.splitTabs.length === 0) return;

  const current = getTabGroup(state.activeTab ?? '');
  if (current === 'primary') {
    if (state.splitActive) activateInGroup('split', state.splitActive);
  } else if (state.activeTab) {
    activateInGroup('primary', state.activeTab);
  }
}

// ============================================================
// 对账与重置
// ============================================================

/**
 * 与模块目录对账：丢掉已经不存在的模块的标签（两组都查）。
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
  const splitTabs = state.splitTabs.filter((id) => catalog.has(id));

  const changed =
    openTabs.length !== state.openTabs.length ||
    splitTabs.length !== state.splitTabs.length;
  if (!changed) return;

  const dropped =
    state.openTabs.length - openTabs.length + (state.splitTabs.length - splitTabs.length);
  console.info(`[tabStore] 对账移除了 ${dropped} 个已失效的标签`);

  setState({ ...state, openTabs, splitTabs });
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
  lastPersistedSplitTabs = settings.splitTabs;
  lastPersistedSplitActive = settings.splitActive;

  const restored = settings.restoreLastModule ? dedupe(settings.openTabs.filter(Boolean)) : [];
  const openTabs = restored.length > 0 ? restored : fallbackModule ? [fallbackModule] : [];
  const splitTabs = settings.restoreLastModule
    ? dedupe(settings.splitTabs.filter(Boolean)).filter((id) => !openTabs.includes(id))
    : [];

  const activeTab =
    settings.activeTab && openTabs.includes(settings.activeTab)
      ? settings.activeTab
      : (openTabs[0] ?? null);

  const splitActive =
    settings.splitActive && splitTabs.includes(settings.splitActive)
      ? settings.splitActive
      : (splitTabs[0] ?? null);

  setState({
    openTabs,
    activeTab,
    splitTabs,
    splitActive,
    focusedGroup: 'primary',
    mountedTabs: state.mountedTabs,
  });
  reconcile();
}
