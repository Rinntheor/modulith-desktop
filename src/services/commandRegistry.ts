// src/services/commandRegistry.ts
//
// 命令注册表：全局搜索（标题栏正中那个框）的数据来源。
//
// 为什么要有「命令」这一层，而不是让搜索框直接搜模块名：
// 用户想做的事常常不是「打开某个模块」，而是「把界面切成深色」「刷新插件」
// 「锁定应用」。这些动作没有对应的模块，如果搜索框只认模块，用户就得先想起
// 它在设置里的哪一页 —— 那又回到了「在一堆入口里找」的老问题。
//
// 模块类条目**不在这里注册**，而是在 `searchCommands` 里按需从目录派生。
// 理由：模块目录是动态的（插件随时注册/注销），把它镜像成命令列表就需要一套
// 同步逻辑，而同步逻辑正是本项目反复踩坑的地方（见 useModuleList 的注释）。
// 派生是纯函数，永远与目录一致。
//
// 这个注册表同时也是插件命令的接入点：插件通过宿主 API 调用 `registerCommand()`
// 就能把自己的动作放进搜索框，不需要改动搜索界面。
//
// **刻意不 import pluginRuntime**：插件运行时要反过来 import 本文件（为了暴露
// 注册命令的宿主 API），若这里也 import 它就会形成循环依赖。因此与插件运行时
// 有关的动作（刷新插件）由调用方通过 `HostCommandHooks` 注入。

import { getCatalogFlatMap } from './moduleCatalog';
import { closeTab, getTabState, openTab } from './tabStore';
import { getResolvedTheme } from './theme';
import { saveAppSettings } from './appSettings';
import { logout } from './auth';
import { refreshAuth } from './authStore';
import { showToast } from './toast';
import type { ModuleDescriptor } from '../types/module';

export type CommandGroup = 'modules' | 'actions' | 'settings';

export interface Command {
  /** 唯一 ID。插件命令建议用 `plugin:<插件id>:<动作>`，便于按前缀批量注销 */
  id: string;
  title: string;
  /** 显示在标题右侧的补充说明，例如模块 ID 或动作所在位置 */
  subtitle?: string;
  /** 参与匹配但不显示的额外关键词 */
  keywords?: string[];
  group: CommandGroup;
  /** lucide 图标名（可选） */
  icon?: string;
  /** 内联 SVG 源码（模块图标可能来自插件包） */
  iconSvg?: string;
  run: () => void | Promise<void>;
}

export interface CommandSearchResult {
  command: Command;
  score: number;
}

/** 最近执行过的命令 ID 上限 */
const MAX_RECENT_COMMANDS = 12;
const RECENT_STORAGE_KEY = 'modulith.recentCommands';

/** 空查询时展示的条目数（最近使用 + 模块） */
const DEFAULT_RESULT_LIMIT = 12;

// ============================================================
// 注册表
// ============================================================

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[commandRegistry] 订阅者执行出错:', error);
    }
  });
}

/** 订阅注册表变化 */
export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 注册（或覆盖）一条命令 */
export function registerCommand(command: Command): void {
  registry.set(command.id, command);
  notify();
}

/** 批量注册 */
export function registerCommands(commands: Command[]): void {
  commands.forEach((command) => registry.set(command.id, command));
  notify();
}

/**
 * 按 ID 前缀注销命令。
 *
 * 前缀注销是插件卸载时的必需品：插件注册的命令必须随插件一起消失，
 * 否则搜索框里会留下指向已经不存在的模块的条目。
 */
export function unregisterCommandsByPrefix(prefix: string): number {
  let removed = 0;
  for (const id of [...registry.keys()]) {
    if (id.startsWith(prefix)) {
      registry.delete(id);
      removed += 1;
    }
  }
  if (removed > 0) notify();
  return removed;
}

/** 当前已注册的宿主命令（不含模块派生项） */
export function getRegisteredCommands(): Command[] {
  return [...registry.values()];
}

// ============================================================
// 最近使用
// ============================================================

let recentIds: string[] = readRecent();

function readRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    // 缓存坏了不影响功能，重新开始积累即可
    return [];
  }
}

function rememberCommand(id: string): void {
  recentIds = [id, ...recentIds.filter((item) => item !== id)].slice(0, MAX_RECENT_COMMANDS);
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recentIds));
  } catch {
    // 写不进去只影响「最近使用」的排序，不影响命令本身
  }
}

/** 最近使用的命令（按最近程度排序，仅返回仍然存在的那些） */
export function getRecentCommands(): Command[] {
  return recentIds
    .filter((id) => registry.has(id))
    .map((id) => registry.get(id)!)
    .slice(0, 5);
}

// ============================================================
// 匹配打分
// ============================================================

/**
 * 对单个候选串打分。返回 null 表示不匹配。
 *
 * 打分规则（分数越大越好）：
 *   * 完全相同           1000
 *   * 以查询串开头        800 − 长度差惩罚
 *   * 包含查询串          500 − 起始位置惩罚
 *   * 子序列匹配          200 起，按连续程度与起始位置加/减分
 *
 * 子序列匹配是「模糊搜索」的核心：输入 `dsh` 能命中 `dashboard`。
 * 但它必须排在精确匹配之后，否则输入完整模块名时会被一堆松散匹配挤下去。
 *
 * 导出它是为了让这套规则可以被独立验证 —— 它是不依赖 React 与 Tauri 的纯函数。
 */
export function scoreMatch(query: string, candidate: string): number | null {
  if (!query) return 0;
  if (!candidate) return null;

  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  if (c === q) return 1000;

  if (c.startsWith(q)) return 800 - Math.min(200, c.length - q.length) * 2;

  const index = c.indexOf(q);
  if (index >= 0) return 500 - Math.min(200, index * 4) - Math.min(100, c.length - q.length);

  // 子序列匹配
  let score = 200;
  let cursor = 0;
  let consecutive = 0;
  let firstHit = -1;

  for (const char of q) {
    const found = c.indexOf(char, cursor);
    if (found === -1) return null;

    if (firstHit === -1) firstHit = found;

    if (found === cursor) {
      consecutive += 1;
      score += 6 * consecutive;
    } else {
      consecutive = 0;
      // 间隔越大越不像用户想找的东西
      score -= Math.min(20, found - cursor);
    }

    cursor = found + 1;
  }

  // 命中位置越靠前越好
  score -= Math.min(60, firstHit * 3);

  return score;
}

/** 对一条命令打分：标题权重最高，其次是关键词与副标题 */
function scoreCommand(query: string, command: Command): number | null {
  const scores: number[] = [];

  const titleScore = scoreMatch(query, command.title);
  if (titleScore !== null) scores.push(titleScore + 100);

  const subtitleScore = scoreMatch(query, command.subtitle ?? '');
  if (subtitleScore !== null) scores.push(subtitleScore);

  for (const keyword of command.keywords ?? []) {
    const keywordScore = scoreMatch(query, keyword);
    if (keywordScore !== null) scores.push(keywordScore);
  }

  if (scores.length === 0) return null;

  let best = Math.max(...scores);

  // 最近用过的排前面：用户重复打开同一个模块时不必重新输完整名字
  const recentIndex = recentIds.indexOf(command.id);
  if (recentIndex >= 0) best += 120 - recentIndex * 10;

  return best;
}

// ============================================================
// 模块派生条目
// ============================================================

/**
 * 从目录派生可打开的模块条目。
 *
 * 用 `getCatalogFlatMap()` 而不是 `getCatalogModules()`：后者只有顶层模块，
 * 搜不到子模块。可见性与禁用状态沿用与侧边栏相同的判据
 * （`visible !== false` 且未禁用），否则会出现「搜索框能打开侧边栏里看不到的模块」。
 *
 * 每次搜索都重新派生（而不是缓存）：模块数量在几十的量级，重建成本可以忽略，
 * 而缓存就必须处理「插件注册/注销时失效」—— 那是本项目已经踩过的那类竞态。
 */
function deriveModuleCommands(): Command[] {
  const flat = getCatalogFlatMap();

  const commands: Command[] = [];

  for (const [id, descriptor] of flat) {
    if (!isSearchable(descriptor)) continue;

    const segments = id.split('/');
    const isChild = segments.length > 1;

    commands.push({
      id: `module:${id}`,
      title: descriptor.name,
      // 子模块标注它的归属，避免不同父模块下的同名子模块难以区分
      subtitle: isChild ? `${segments[0]} › ${segments.slice(1).join('/')}` : id,
      keywords: [id, descriptor.category ?? ''],
      group: 'modules',
      icon: descriptor.icon,
      iconSvg: descriptor.iconSvg,
      run: () => {
        openTab(id);
      },
    });
  }

  return commands;
}

function isSearchable(descriptor: ModuleDescriptor): boolean {
  return descriptor.visible !== false && !descriptor.disabled;
}

// ============================================================
// 搜索
// ============================================================

/**
 * 搜索命令。
 *
 * 空查询返回「最近使用 + 按名称排序的模块」，这样一打开搜索框就有东西可点，
 * 而不是一片空白。这正是「防止注意力中断」想要的：常用入口触手可及，
 * 不必先去侧边栏里找。
 */
export function searchCommands(query: string, limit = DEFAULT_RESULT_LIMIT): CommandSearchResult[] {
  const trimmed = query.trim();

  if (!trimmed) {
    const recent = getRecentCommands();
    const seen = new Set(recent.map((command) => command.id));

    const modules = deriveModuleCommands()
      .filter((command) => !seen.has(command.id))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));

    return [...recent, ...modules]
      .slice(0, limit)
      .map((command) => ({ command, score: 0 }));
  }

  const candidates = [...deriveModuleCommands(), ...registry.values()];

  const results: CommandSearchResult[] = [];
  for (const command of candidates) {
    const score = scoreCommand(trimmed, command);
    if (score !== null) results.push({ command, score });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 同分时让动作类排在模块类之前：用户输入一个恰好同名的词时，
    //「执行动作」通常比「打开模块」更接近意图
    const groupRank = (group: CommandGroup) =>
      group === 'actions' ? 0 : group === 'settings' ? 1 : 2;
    return groupRank(a.command.group) - groupRank(b.command.group);
  });

  return results.slice(0, limit);
}

/** 执行一条命令并记录到「最近使用」 */
export async function runCommand(command: Command): Promise<void> {
  rememberCommand(command.id);
  try {
    await command.run();
  } catch (error) {
    console.error(`[commandRegistry] 执行命令 ${command.id} 失败:`, error);
    showToast({
      title: '命令执行失败',
      body: error instanceof Error ? error.message : String(error),
      level: 'error',
    });
  }
  notify();
}

// ============================================================
// 宿主内置命令
// ============================================================

export interface HostCommandHooks {
  onOpenSettings: () => void;
  onOpenNotifications: () => void;
  /**
   * 刷新插件运行时与模块目录。
   *
   * 由 Home 注入而不是这里直接实现：本文件不能 import pluginRuntime
   * （会形成循环依赖，见文件头说明）。
   */
  onRefreshPlugins: () => void | Promise<void>;
}

/**
 * 注册宿主自带的命令。
 *
 * 幂等：StrictMode 下 effect 会执行两次，重复注册只是覆盖同样的 ID。
 * 主题命令的标题带当前状态，因此每次注册都重新计算。
 */
export function registerHostCommands(hooks: HostCommandHooks): void {
  const isDark = getResolvedTheme() === 'dark';

  registerCommands([
    {
      id: 'host:open-settings',
      title: '打开设置',
      subtitle: '外观、插件、安全',
      keywords: ['settings', 'shezhi', '偏好', '配置'],
      group: 'settings',
      icon: 'Settings',
      run: () => hooks.onOpenSettings(),
    },
    {
      id: 'host:open-notifications',
      title: '打开通知中心',
      subtitle: '查看模块发来的通知',
      keywords: ['notification', 'tongzhi', '消息'],
      group: 'actions',
      icon: 'Bell',
      run: () => hooks.onOpenNotifications(),
    },
    {
      id: 'host:toggle-theme',
      title: isDark ? '切换到浅色模式' : '切换到深色模式',
      keywords: ['theme', 'dark', 'light', 'zhuti', '深色', '浅色'],
      group: 'settings',
      icon: isDark ? 'Sun' : 'Moon',
      run: async () => {
        const next = getResolvedTheme() === 'dark' ? 'light' : 'dark';
        await saveAppSettings({ theme: next });
        // 标题随当前主题变化，重新注册一次让搜索框里的文案保持准确
        registerHostCommands(hooks);
      },
    },
    {
      id: 'host:refresh-plugins',
      title: '刷新插件与模块',
      subtitle: '重新加载插件运行时与模块目录',
      keywords: ['refresh', 'reload', 'shuaxin', '重载'],
      group: 'actions',
      icon: 'RefreshCw',
      run: () => hooks.onRefreshPlugins(),
    },
    {
      id: 'host:lock',
      title: '锁定应用',
      subtitle: '结束会话并返回解锁界面',
      keywords: ['lock', 'logout', 'suoding', '注销'],
      group: 'actions',
      icon: 'Lock',
      run: async () => {
        await logout();
        await refreshAuth();
      },
    },
    {
      id: 'host:close-tab',
      title: '关闭当前标签页',
      keywords: ['close', 'tab', 'guanbi'],
      group: 'actions',
      icon: 'X',
      run: () => {
        const { activeTab } = getTabState();
        if (!activeTab) {
          showToast({ title: '没有可关闭的标签页', level: 'info' });
          return;
        }
        closeTab(activeTab);
      },
    },
  ]);
}
