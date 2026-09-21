// src/services/moduleManager.ts

import { invoke } from '@tauri-apps/api/core';
import { getCatalogModules, subscribeCatalog } from './moduleCatalog';
import type { ModuleDescriptor } from '../types/module';
import {
  isValidModuleId,
  isValidIndex,
  isValidDirection,
  validateCategoryName,
  assertValid,
} from '../utils/validators';

/**
 * 用户模块偏好（与 Rust 的 SidebarPreferences 对应）
 */
export interface ModulePreferences {
  module_order: string[];
  hidden_modules: string[];
  pinned_modules: string[];
  favorite_modules: string[];
  recent_modules: string[];
  /** 用户自定义的模块分类（顺序即显示顺序） */
  categories: ModuleCategory[];
}

/**
 * 用户自定义的模块分类（后端 `sidebar/config.rs` 的 `ModuleCategory`）。
 *
 * 两条契约写在这里，因为它们是这个类型被使用时的前提：
 *
 *   · **一个模块最多属于一个分类**（划分，不是标签）。后端 `sanitize_categories`
 *     在读盘时强制它，`set_module_category` 在写入时保证它。因此界面不需要处理
 *     "同一个模块出现在两个分区里"这种状态 —— 它不存在。
 *   · **分类成员里可能有当前不存在的模块 ID**（插件被卸载了）。那是有意的：
 *     重装之后它会回到原来的分类，而清掉成员等于把用户的整理结果扔掉。
 *     界面只渲染目录里存在的那些，不做清理。见 `sanitize_categories` 的说明。
 */
export interface ModuleCategory {
  id: string;
  name: string;
  /** 属于该分类的模块 ID，顺序即显示顺序 */
  modules: string[];
}

/** 最近使用列表的最大长度（与后端 MAX_RECENT_MODULES 保持一致） */
const MAX_RECENT_MODULES = 10;

// 事件回调类型
type Listener = () => void;

/**
 * 运行时模块管理器
 * 合并统一的模块目录（内置模块 + 运行时插件模块）与用户偏好（运行时持久化）
 */
class RuntimeModuleManager {
  private staticModules: ModuleDescriptor[];
  private preferences: ModulePreferences | null = null;
  private initialized = false;
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.staticModules = getCatalogModules();

    // 插件模块是启动之后才异步注册的，目录一变就刷新本地快照并通知订阅者。
    // 没有这条链路，首次启动时侧边栏会一直停留在「只有内置模块」的旧列表上
    //（表现为：插件必须去设置里打开插件页才出现）。
    subscribeCatalog(() => {
      this.staticModules = getCatalogModules();
      this.notify();
    });
  }

  /**
   * 重新读取模块目录（插件安装/启用/禁用/卸载后调用）
   * 读取完成后通知所有订阅者刷新
   */
  reloadCatalog(): void {
    this.staticModules = getCatalogModules();
    this.notify();
  }

  /**
   * 初始化：从 Rust 后端加载用户偏好
   * 必须在 Tauri 环境就绪后调用
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.preferences = await invoke<ModulePreferences>('get_module_preferences');
      console.log('[moduleManager] 模块偏好已加载:', this.preferences);
    } catch (error) {
      console.warn('[moduleManager] 读取模块偏好失败，使用默认值:', error);
      this.preferences = {
        module_order: [],
        hidden_modules: [],
        pinned_modules: [],
        favorite_modules: [],
        recent_modules: [],
        categories: [],
      };
    }

    this.initialized = true;
  }

  // ========== 事件系统 ==========

  /** 订阅模块变更事件（Sidebar 用来刷新） */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 触发所有订阅者 */
  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  // ========== 数据获取 ==========

  /**
   * 获取置顶模块ID列表
   */
  getPinnedModules(): string[] {
    return this.preferences?.pinned_modules ?? [];
  }

  /**
   * 获取最终模块列表（已过滤不可见/隐藏模块、已排序、已置顶）
   * 这是 Sidebar 应该使用的数据源。
   *
   * `visible === false` 的模块（例如插件管理页，入口在标题栏「设置」中）
   * 不进入导航列表，但仍可通过 getCatalogFlatMap() 按需渲染。
   */
  getActiveModules(): ModuleDescriptor[] {
    if (!this.initialized) {
      return this.staticModules.filter(m => m.visible !== false);
    }

    const prefs = this.preferences!;
    const hiddenSet = new Set(prefs.hidden_modules);
    const pinnedSet = new Set(prefs.pinned_modules);

    // 过滤掉不在导航中展示的模块，以及用户隐藏的模块
    const filtered = this.staticModules.filter(
      m => m.visible !== false && !hiddenSet.has(m.id)
    );

    // 分离置顶模块和非置顶模块
    const pinned: ModuleDescriptor[] = [];
    const unpinned: ModuleDescriptor[] = [];

    for (const mod of filtered) {
      if (pinnedSet.has(mod.id)) {
        pinned.push(mod);
      } else {
        unpinned.push(mod);
      }
    }

    // 置顶模块按 pinned 数组顺序排列
    const orderedPinned = prefs.pinned_modules
      .filter(id => pinnedSet.has(id) && !hiddenSet.has(id))
      .map(id => pinned.find(m => m.id === id)!)
      .filter(Boolean);

    // 非置顶模块按 user module_order 排列
    const orderSet = new Set(prefs.module_order);
    const ordered: ModuleDescriptor[] = [];
    const remainder: ModuleDescriptor[] = [];

    for (const mod of unpinned) {
      if (orderSet.has(mod.id)) {
        ordered.push(mod);
      } else {
        remainder.push(mod);
      }
    }

    // 按 module_order 排序
    ordered.sort((a, b) => {
      const ia = prefs.module_order.indexOf(a.id);
      const ib = prefs.module_order.indexOf(b.id);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    // 剩余模块按默认 priority 排序
    remainder.sort((a, b) => a.priority - b.priority);

    // 最终列表：置顶模块中不在orderedPinned的 + orderedPinned + ordered + remainder
    const pinnedSetFromOrdered = new Set(orderedPinned.map(m => m.id));
    const pinnedNotInOrdered = pinned.filter(m => !pinnedSetFromOrdered.has(m.id));

    return [...pinnedNotInOrdered, ...orderedPinned, ...ordered, ...remainder];
  }

  /**
   * 获取被隐藏的模块列表
   */
  getHiddenModules(): ModuleDescriptor[] {
    if (!this.initialized) return [];
    const hiddenSet = new Set(this.preferences!.hidden_modules);
    return this.staticModules.filter(m => hiddenSet.has(m.id));
  }

  /**
   * 获取收藏的模块 ID 列表
   */
  getFavoriteIds(): string[] {
    return this.preferences?.favorite_modules ?? [];
  }

  /**
   * 获取最近使用的模块 ID 列表
   */
  getRecentIds(): string[] {
    return this.preferences?.recent_modules ?? [];
  }

  /**
   * 获取收藏的模块描述符列表（已过滤被隐藏的模块）
   */
  getFavoriteModules(): ModuleDescriptor[] {
    if (!this.initialized) return [];
    const hiddenSet = new Set(this.preferences!.hidden_modules);
    return this.getFavoriteIds()
      .filter(id => !hiddenSet.has(id))
      .map(id => this.staticModules.find(m => m.id === id))
      .filter((m): m is ModuleDescriptor => Boolean(m));
  }

  /**
   * 获取最近使用的模块描述符列表（已过滤被隐藏的模块）
   */
  getRecentModules(): ModuleDescriptor[] {
    if (!this.initialized) return [];
    const hiddenSet = new Set(this.preferences!.hidden_modules);
    return this.getRecentIds()
      .filter(id => !hiddenSet.has(id))
      .map(id => this.staticModules.find(m => m.id === id))
      .filter((m): m is ModuleDescriptor => Boolean(m));
  }

  // ========== 操作（含 notify） ==========

  /**
   * 隐藏模块
   */
  async hideModule(moduleId: string): Promise<void> {
    // 验证模块 ID
    const moduleIdResult = isValidModuleId(moduleId);
    assertValid(moduleIdResult, 'hideModule: moduleId');

    // 检查模块是否存在
    if (!this.moduleExists(moduleId)) {
      throw new Error(`Module not found: ${moduleId}`);
    }

    // **先落盘、再改本地。**
    //
    // 此前是先改本地 `hidden_modules`、再 `invoke`：后端一旦失败，本地数组已经被污染，
    // 而随后任何一次 `notify()`（目录变化、插件加载完成…）都会把这份不一致当成事实渲染
    // 出去 —— 用户看到模块已隐藏，重启后又回来。这里反过来做，失败时本地保持原样。
    await invoke('toggle_module_visibility', { moduleId, hidden: true });
    await this.updatePreference('hidden_modules', (hidden) => {
      if (!hidden.includes(moduleId)) {
        hidden.push(moduleId);
      }
    });
    this.notify();
  }

  /**
   * 显示模块
   */
  async showModule(moduleId: string): Promise<void> {
    // 验证模块 ID
    const moduleIdResult = isValidModuleId(moduleId);
    assertValid(moduleIdResult, 'showModule: moduleId');

    // 检查模块是否存在
    if (!this.moduleExists(moduleId)) {
      throw new Error(`Module not found: ${moduleId}`);
    }

    // 先落盘、再改本地（理由同 hideModule）
    await invoke('toggle_module_visibility', { moduleId, hidden: false });
    await this.updatePreference('hidden_modules', (hidden) => {
      const index = hidden.indexOf(moduleId);
      if (index !== -1) hidden.splice(index, 1);
    });
    this.notify();
  }

  /**
   * 置顶模块（或取消置顶）
   */
  async togglePinModule(moduleId: string): Promise<void> {
    // 验证模块 ID
    const moduleIdResult = isValidModuleId(moduleId);
    assertValid(moduleIdResult, 'togglePinModule: moduleId');

    // 检查模块是否存在
    if (!this.moduleExists(moduleId)) {
      throw new Error(`Module not found: ${moduleId}`);
    }

    const isPinned = this.preferences!.pinned_modules.includes(moduleId);

    // 先落盘、再改本地（理由同 hideModule）
    await invoke('toggle_module_pin', { moduleId, pinned: !isPinned });
    await this.updatePreference('pinned_modules', (pinned) => {
      if (isPinned) {
        const index = pinned.indexOf(moduleId);
        if (index !== -1) pinned.splice(index, 1);
      } else {
        pinned.unshift(moduleId);
      }
    });
    this.notify();
  }

  /**
   * 将模块移动到指定索引位置
   */
  async moveModuleToIndex(moduleId: string, newIndex: number): Promise<void> {
    // 验证模块 ID
    const moduleIdResult = isValidModuleId(moduleId);
    assertValid(moduleIdResult, 'moveModuleToIndex: moduleId');

    // 验证索引
    const activeModules = this.getActiveModules();
    const indexResult = isValidIndex(newIndex, activeModules.length, 'newIndex');
    assertValid(indexResult, 'moveModuleToIndex: newIndex');

    // 检查模块是否存在
    if (!this.moduleExists(moduleId)) {
      throw new Error(`Module not found: ${moduleId}`);
    }

    const currentOrder = this.preferences!.module_order.length > 0
      ? this.preferences!.module_order
      : this.getActiveModules().map(m => m.id);

    const cleanOrder = currentOrder.filter(id => id !== moduleId);
    const insertIndex = Math.min(newIndex, cleanOrder.length);
    cleanOrder.splice(insertIndex, 0, moduleId);

    await invoke('update_module_order', { order: cleanOrder });
    this.preferences!.module_order = cleanOrder;
    this.notify();
  }

  /**
   * 移动模块位置（上移/下移）
   */
  async moveModule(moduleId: string, direction: 'up' | 'down'): Promise<void> {
    // 验证模块 ID
    const moduleIdResult = isValidModuleId(moduleId);
    assertValid(moduleIdResult, 'moveModule: moduleId');

    // 验证方向
    const directionResult = isValidDirection(direction);
    assertValid(directionResult, 'moveModule: direction');

    const activeModules = this.getActiveModules();
    const currentIndex = activeModules.findIndex(m => m.id === moduleId);
    if (currentIndex === -1) {
      throw new Error(`Module not found: ${moduleId}`);
    }

    const newIndex = direction === 'up'
      ? Math.max(0, currentIndex - 1)
      : Math.min(activeModules.length - 1, currentIndex + 1);

    const targetId = activeModules[newIndex].id;
    await this.swapModules(moduleId, targetId);
  }

  /**
   * 交换两个模块的位置
   */
  private async swapModules(moduleId1: string, moduleId2: string): Promise<void> {
    const order = [...(this.preferences!.module_order.length > 0
      ? this.preferences!.module_order
      : this.getActiveModules().map(m => m.id))];

    const idx1 = order.indexOf(moduleId1);
    const idx2 = order.indexOf(moduleId2);

    if (idx1 === -1 && idx2 === -1) {
      order.push(moduleId1, moduleId2);
    } else if (idx1 === -1) {
      order.splice(idx2, 0, moduleId1);
    } else if (idx2 === -1) {
      order.splice(idx1 + 1, 0, moduleId2);
    } else {
      [order[idx1], order[idx2]] = [order[idx2], order[idx1]];
    }

    await invoke('update_module_order', { order });
    this.preferences!.module_order = order;
    this.notify();
  }

  /**
   * 重置所有偏好。
   *
   * **分类不会被清掉** —— 后端 `SidebarPreferences::reset` 刻意保留它们（理由写在
   * 那里：分类是用户创建的内容，不是显示偏好）。这里不需要做任何特殊处理，
   * 因为返回的就是后端保留之后的那一份。
   */
  async resetAll(): Promise<void> {
    const defaults = await invoke<ModulePreferences>('reset_module_preferences');
    this.preferences = defaults;
    this.notify();
  }

  // ========== 用户自定义的模块分类 ==========

  /**
   * 取分类表（同步读缓存）。
   *
   * 分类随 `get_module_preferences` 一起返回，因此没有独立的加载步骤 ——
   * 少一次 IPC，也少一个"这份数据加载了吗"的状态。
   */
  getCategories(): ModuleCategory[] {
    return this.preferences?.categories ?? [];
  }

  /** 某个模块所属的分类；未分类时返回 undefined */
  getCategoryOf(moduleId: string): ModuleCategory | undefined {
    return this.getCategories().find((category) => category.modules.includes(moduleId));
  }

  /**
   * 六个写操作共用的收尾：**用后端返回的整张表覆盖本地**。
   *
   * 刻意不做乐观更新。`appSettings` 那一套（先改本地、失败再回滚）是为开关准备的，
   * 那里等待一次 IPC 往返会有可感知的延迟；而分类操作是**低频、用户明确发起**的，
   * 一次往返的几十毫秒看不出来，换来的是"本地那份永远等于磁盘那份"。
   */
  private async applyCategories(command: string, args: Record<string, unknown>): Promise<void> {
    const categories = await invoke<ModuleCategory[]>(command, args);
    if (this.preferences) {
      this.preferences.categories = categories;
    }
    this.notify();
  }

  async createCategory(name: string): Promise<void> {
    assertValid(validateCategoryName(name), 'createCategory: name');
    await this.applyCategories('create_module_category', { name });
  }
  async renameCategory(id: string, name: string): Promise<void> {
    assertValid(validateCategoryName(name), 'renameCategory: name');
    await this.applyCategories('rename_module_category', { id, name });
  }

  /**
   * 删除分类。**成员回到「未分类」，一个模块都不会被删** —— 后端只移除这一条
   * 分类记录，因此这里不需要任何"先搬走成员"的编排。
   */
  async deleteCategory(id: string): Promise<void> {
    await this.applyCategories('delete_module_category', { id });
  }

  /** 重排分类。必须提交**全部** id 的一个排列 —— 少一个后端会拒绝 */
  async reorderCategories(ids: string[]): Promise<void> {
    await this.applyCategories('reorder_module_categories', { ids });
  }

  /**
   * 把一个模块放进某个分类；`categoryId` 为 `null` 表示移出所有分类。
   *
   * `index` 是**目标分类内的位置**（省略即追加到末尾），用来支持分类内的拖动重排。
   * 位置由调用方给出而不是由后端推算：拖动表达的是"放在这两张卡片之间"，
   * 后端若要去理解"上移一位"就得先知道前端的当前顺序，而那个顺序可能已经过期。
   *
   * 后端会先把它从原分类摘掉再放进目标，"一个模块只属于一个分类"因此由后端
   * 保证，**这里不重复一遍** —— 前端再判一次只会多出一份可能与后端不一致的规则。
   */
  async setModuleCategory(
    moduleId: string,
    categoryId: string | null,
    index?: number
  ): Promise<void> {
    const moduleIdResult = isValidModuleId(moduleId);
    assertValid(moduleIdResult, 'setModuleCategory: moduleId');

    await this.applyCategories('set_module_category', {
      moduleId,
      categoryId,
      // 显式传 null 而不是省略：Tauri 的可选参数在两端各有一次"缺省"的语义，
      // 传 null 只有一个含义
      index: index ?? null,
    });
  }

  /**
   * 切换（或显式设置）模块收藏状态
   * 后端会返回最新的收藏 ID 列表，本地同步后通知所有订阅者
   */
  async toggleFavoriteModule(moduleId: string, favorite?: boolean): Promise<void> {
    // 验证模块 ID
    const moduleIdResult = isValidModuleId(moduleId);
    assertValid(moduleIdResult, 'toggleFavoriteModule: moduleId');

    // 检查模块是否存在
    if (!this.moduleExists(moduleId)) {
      throw new Error(`Module not found: ${moduleId}`);
    }

    // 始终显式传入目标状态，避免依赖命令参数的“可选”语义
    const shouldFavorite = favorite ?? !this.getFavoriteIds().includes(moduleId);

    const favorites = await invoke<string[]>('toggle_favorite_module', {
      moduleId,
      favorite: shouldFavorite,
    });

    if (this.preferences) {
      this.preferences.favorite_modules = favorites;
    }
    this.notify();
  }

  /**
   * 记录一次模块打开，更新最近使用列表
   *
   * 支持顶层模块（如 `dashboard`）和子模块（如 `finance/dashboard`）。
   * 子模块不在静态注册表的顶层列表中，只做格式校验。
   */
  async recordModuleOpen(moduleId: string): Promise<void> {
    const segments = typeof moduleId === 'string' ? moduleId.split('/') : [];

    if (
      segments.length === 0 ||
      segments.length > 2 ||
      !segments.every(seg => isValidModuleId(seg).valid)
    ) {
      throw new Error(`recordModuleOpen: invalid module id "${moduleId}"`);
    }

    // 顶层模块必须真实存在；子模块仅校验格式
    if (segments.length === 1 && !this.moduleExists(moduleId)) {
      throw new Error(`Module not found: ${moduleId}`);
    }

    const recents = await invoke<string[]>('record_module_open', { moduleId });

    if (this.preferences) {
      this.preferences.recent_modules = Array.isArray(recents) && recents.length > 0
        ? recents
        : [moduleId, ...this.preferences.recent_modules.filter(id => id !== moduleId)]
            .slice(0, MAX_RECENT_MODULES);
    }
    this.notify();
  }

  /**
   * 辅助方法：更新本地偏好
   */
  private async updatePreference<K extends keyof ModulePreferences>(
    key: K,
    updater: (arr: ModulePreferences[K]) => void
  ): Promise<void> {
    if (!this.preferences) return;
    updater(this.preferences[key]);
  }

  /**
   * 辅助方法：检查模块是否存在
   */
  private moduleExists(moduleId: string): boolean {
    return this.staticModules.some(m => m.id === moduleId);
  }
}

// 导出单例
export const moduleManager = new RuntimeModuleManager();