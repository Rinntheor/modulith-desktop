// src/services/pluginRuntime.ts
//
// 插件运行时：把已启用的插件真正加载进应用。
//
// 插件包格式（.lcp = zip）：
//   manifest.json     清单（见 PluginManifest）
//   dist/index.js     预构建的 IIFE bundle，执行时调用 window.Modulith.registerModule(...)
//   dist/index.css    可选样式
//   icon.svg          可选图标
//
// 宿主在加载插件前会注入 window.Modulith：
//   { version, React, jsx, jsxs, Fragment, registerModule, createContext }
//
// 插件 bundle 必须把 react 与 react/jsx-runtime 标记为 external，并映射到
// window.Modulith 的对应成员（react → Modulith.React，react/jsx-runtime → Modulith），
// 这样插件与宿主共用同一份 React（hooks/context 才能工作）。
// **react-dom 不在其列**：宿主不提供 ReactDOM，插件通过 registerModule 交出组件即可。

import React from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { invoke } from '@tauri-apps/api/core';
import { createLazyComponent } from '../utils/lazyLoad';
import {
  clearDynamicModules,
  registerDynamicModule,
  setModuleIconSvg,
  setPluginCatalogLoading,
  unregisterDynamicModules,
  getPluginModuleIds,
} from './moduleCatalog';
import type { ModuleDescriptor } from '../types/module';
import type {
  ActivationEvent,
  CommandContribution,
  ModulithCapabilities,
  ModuleContribution,
  PickedAudio,
  PluginSettingsAPI,
} from '../types/plugin';
import { pushNotification, type NotificationLevel } from './notifications';
import { publish, subscribe, unsubscribeBySource, type EventHandler } from './eventBus';
import { registerCommand, unregisterCommandsByPrefix } from './commandRegistry';
import { useModuleActive } from '../hooks/useModuleActive';
import { isFileDropAvailable, subscribeFileDrop } from './fileDrop';
import { clearModuleComponentCache } from './moduleComponentCache';
import { loadPermissionRegistry } from './permissionRegistry';
import { logMessage } from './logger';
import {
  HOST_CAPABILITIES,
  activationEventForCommand,
  activationEventForContextMenu,
  activationEventForModule,
  commandFullId,
  commandPrefix,
  resolveLoadContract,
  type PluginLoadContract,
} from './pluginContributions';
import {
  clearPluginSettings,
  getAllPluginSettings,
  getPluginSetting,
  getPluginSettingContributions,
  loadPluginSettingValues,
  registerPluginSettings,
  setPluginSetting,
  subscribePluginSettings,
  unregisterPluginSettings,
} from './pluginSettings';

/**
 * 宿主版本号的**占位初值**。
 *
 * 注意：这不是版本源，不要把它当作真实版本使用。
 * 真实版本由后端 `get_app_info`（即 `env!("CARGO_PKG_VERSION")`）提供，
 * 在插件运行时加载前由 `refreshHostVersion()` 写入 `resolvedVersion`。
 *
 * 之所以保留这个常量：`window.Modulith.version` 是同步字段，
 * 插件在 IIFE 顶层就会读取，不能是 `undefined`。仅在后端不可用时
 * （例如纯前端 `vite` 预览、单元测试环境）才会读到这个值。
 *
 * 因此它不参与 `pnpm ver sync` 的标记替换 —— 维护一份会漂移的副本
 * 只会制造「前端 0.2.0、后端 0.3.0」这类不一致。
 */
export const MODULITH_VERSION = '0.0.0-unknown';

/**
 * 已被后端确认的版本号。
 * 未初始化时回退到 `MODULITH_VERSION`，保证任何时刻读取都有有效字符串。
 */
let resolvedVersion = MODULITH_VERSION;

/**
 * 从后端读取权威版本号并更新宿主信息。
 *
 * 后端返回的是 `env!("CARGO_PKG_VERSION")`，与插件校验器
 * `validator.rs` 使用的版本源完全相同，因此前端显示、插件读取到的
 * `window.Modulith.version`、以及 `engines.loopcore` 的校验基准
 * 三者不可能出现不一致。
 *
 * 失败时静默保留兜底值 —— 版本号显示不该让应用启动失败。
 */
export async function refreshHostVersion(): Promise<string> {
  try {
    const info = await invoke<{ version: string }>('get_app_info');
    if (info?.version && info.version !== resolvedVersion) {
      resolvedVersion = info.version;
      if (hostInstalled) {
        (window as unknown as { Modulith: ModulithHost }).Modulith.version = resolvedVersion;
      }
    }
  } catch {
    // 后端不可用（例如纯前端预览）：沿用编译期兜底值
  }
  return resolvedVersion;
}

/** 读取当前已解析的宿主版本号（同步） */
export function getHostVersion(): string {
  return resolvedVersion;
}

// ============================================================
// 与 Rust 后端一致的类型
// ============================================================

export type PluginStatus = 'enabled' | 'disabled' | 'error';

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PluginRepository {
  type: string;
  url: string;
}

export interface PluginEngines {
  loopcore: string;
}

export interface PluginManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author?: PluginAuthor;
  license?: string;
  homepage?: string;
  repository?: PluginRepository;
  keywords?: string[];
  categories?: string[];
  engines?: PluginEngines;
  main: string;
  style?: string;
  icon?: string;
  iconSvg?: string;
  permissions?: string[];
  activationEvents?: string[];
  contributes?: unknown;
  preview?: boolean;
  deprecated?: boolean;
  replacedBy?: string;
}

export interface InstalledPlugin {
  id: string;
  version: string;
  path: string;
  manifest: PluginManifest;
  enabled: boolean;
  status: PluginStatus;
  installedAt: string;
  source: string;
  sizeBytes: number;
  hasStyle: boolean;
  readme: string | null;
  /**
   * 开发链接：该插件当前正从哪个源目录实时读取（只有「从目录安装」且该目录
   * 仍然有效时才有值）。
   *
   * 后端会把清单与资源都从该目录读，因此改完代码点刷新即生效；`path` 此时
   * 也等于这个目录。源目录被删掉后后端不再报告它（退回安装目录的副本）。
   */
  devSource?: string;
  /**
   * 引擎范围不匹配时的提示。
   *
   * 注意它**不表示插件不可用**：`engines.loopcore` 在 0.x 阶段很脆弱
   * （`^0.2.0` 等价于 `>=0.2.0 <0.3.0`，宿主升一个小版本就会不匹配）；
   * 1.0 之后 caret 语义恢复正常，但提示机制保留 ——
   * 因此后端只把它当提示，不阻止安装与加载。界面应当照此表述，
   * 不要写成「不兼容」或「无法使用」。
   */
  engineAdvisory?: {
    required: string;
    host: string;
    message: string;
  };
}

// ============================================================
// 加载状态
// ============================================================

export interface PluginLoadState {
  pluginId: string;
  status: 'loaded' | 'error';
  error?: string;
  moduleIds: string[];
  loadedAt: string;
}

// ============================================================
// 内部状态
// ============================================================

let installed: InstalledPlugin[] = [];
const loadStates = new Map<string, PluginLoadState>();
const listeners = new Set<() => void>();

/**
 * 是否已经完整地拉取过一次插件列表。
 *
 * 用途：插件是**后台加载**的，`installed` 在加载完成前一直是空数组。
 * 界面不能把「还没加载」当成「一个插件都没装」—— 那会让用户在打开插件页的
 * 瞬间看到「还没有安装任何插件」的空状态，然后插件突然冒出来。
 * 单靠 `isPluginCatalogLoading()` 不够：它只在加载**进行中**为真，而用户完全
 * 可能在后台加载开始之前就打开了插件页。
 */
let runtimeLoadedOnce = false;

/** 正在被加载的插件 ID（脚本同步执行期间有效） */
let loadingPluginId: string | null = null;

/** 已注入到 DOM 的资源，便于卸载时清理 */
const injectedAssets = new Map<string, { scripts: HTMLScriptElement[]; styles: HTMLStyleElement[] }>();

/**
 * 插件图标的已解析 SVG 源码（插件 ID → `<svg …>` 字符串）。
 *
 * 与 `injectedAssets` 一样属于「插件资源」，卸载/禁用时必须一起清理，
 * 否则重新启用同名插件会拿到上一次的旧图标。
 */
const pluginIcons = new Map<string, string>();

// ============================================================
// 贡献与激活（1.2.0）
//
// 这一节引入了「插件不必是一个模块」这件事。核心是两组状态：
//
//   * **贡献目录**（contracts）—— 从清单算出来的、宿主**不执行任何插件代码**
//     就能拥有的界面形状：侧边栏条目、命令面板条目、设置项、右键菜单项。
//   * **激活状态**（activationStates）—— 插件代码到底跑没跑过，以及为什么跑。
//
// 于是「插件存在」与「插件提供的东西可见」被解耦了：一个只加三条命令的插件，
// 在它一行代码都没执行过的时候，那三条命令就已经在面板里了。
// ============================================================

/** 插件激活状态 */
export type PluginActivationStatus = 'inactive' | 'activating' | 'active' | 'failed';

export interface PluginActivationState {
  pluginId: string;
  status: PluginActivationStatus;
  /** 触发它的激活事件；旧式插件在后台加载期激活时为 `'legacy'` */
  reason: ActivationEvent | 'legacy';
  activatedAt?: string;
  error?: string;
}

/** pluginId → 装载契约（由清单算出） */
const contracts = new Map<string, PluginLoadContract>();

/** pluginId → 激活状态 */
const activationStates = new Map<string, PluginActivationState>();

/**
 * `插件ID::模块ID` → 插件在激活期交出来的组件。
 *
 * 用复合键而不是裸模块 ID：声明式插件注册一个**未声明**的模块时，组件会先落进
 * 这里、再走目录的重复校验 —— 那时模块 ID 还没有被目录接受，用它当键会让
 * 两个插件抢同一个 ID 时互相覆盖。
 */
const providedModules = new Map<string, React.ComponentType<Record<string, never>>>();

/** 全局面板命令 ID → 插件绑定上来的处理函数 */
const commandHandlers = new Map<string, () => void | Promise<void>>();

/** pluginId → 待执行的清理函数（`ctx.disposables` / `Modulith.onDeactivate`） */
const disposableRegistry = new Map<string, Array<() => void>>();

/** 正在进行的激活（去重：多个模块同时打开时只跑一次 bundle） */
const activating = new Map<string, Promise<PluginActivationState>>();

/** 本次激活由什么触发（`ctx.activationEvent` 的来源） */
const activationReasons = new Map<string, ActivationEvent | 'legacy'>();

/** 单个插件的加载超时，由 `reloadPluginRuntime` 从设置里带进来 */
let configuredTimeoutMs = 5000;

function providedModuleKey(pluginId: string, moduleId: string): string {
  return `${pluginId}::${moduleId}`;
}

/** 某个插件的装载契约（没有则 undefined，例如插件已被卸载） */
export function getPluginContract(pluginId: string): PluginLoadContract | undefined {
  return contracts.get(pluginId);
}

/** 全部装载契约（供设置界面、诊断页枚举） */
export function getPluginContracts(): Array<{ pluginId: string; contract: PluginLoadContract }> {
  return [...contracts.entries()].map(([pluginId, contract]) => ({ pluginId, contract }));
}

/** 某个插件的激活状态 */
export function getActivationState(pluginId: string): PluginActivationState | undefined {
  return activationStates.get(pluginId);
}

/** 全部激活状态 */
export function getActivationStates(): Map<string, PluginActivationState> {
  return activationStates;
}

/** 某个插件是否已经跑过代码 */
export function isPluginActive(pluginId: string): boolean {
  return activationStates.get(pluginId)?.status === 'active';
}

/**
 * 记录一个清理函数。返回「立刻执行并摘掉它」的函数。
 *
 * 只执行一次是硬要求：`ctx.disposables` 的典型用法是
 * `disposables.add(() => clearInterval(t))`，而插件也常常会自己提前调用它 ——
 * 若宿主的卸载路径再执行一遍，就会对同一个定时器 clear 两次（无害），或者对
 * 一个已经关闭的连接再关一次（有害）。
 */
function addDisposable(pluginId: string, dispose: () => void): () => void {
  if (typeof dispose !== 'function') return () => {};

  let done = false;
  const wrapped = () => {
    if (done) return;
    done = true;
    const list = disposableRegistry.get(pluginId);
    if (list) {
      const index = list.indexOf(wrapped);
      if (index !== -1) list.splice(index, 1);
    }
    dispose();
  };

  const list = disposableRegistry.get(pluginId) ?? [];
  list.push(wrapped);
  disposableRegistry.set(pluginId, list);
  return wrapped;
}

/**
 * 逆序执行某个插件的全部清理函数。
 *
 * 三条保证，与 `PluginDisposablesAPI` 的文档一一对应：逆序、单个抛错不牵连其余、
 * 每个只执行一次。返回真正执行掉的个数。
 */
function runDisposables(pluginId: string): number {
  const list = disposableRegistry.get(pluginId);
  if (!list || list.length === 0) {
    disposableRegistry.delete(pluginId);
    return 0;
  }
  // 先摘掉整份表再执行：清理函数自己也可能 add() 新的清理函数，
  // 那些应当留到下一次卸载，而不是在这一次的循环里被顺手跑掉。
  disposableRegistry.delete(pluginId);

  let ran = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    try {
      list[index]();
      ran += 1;
    } catch (error) {
      console.error(
        `[pluginRuntime] 插件 "${pluginId}" 的第 ${index + 1} 个清理函数抛出错误（其余仍会执行）:`,
        error
      );
    }
  }
  return ran;
}

/**
 * 执行一条插件命令。
 *
 * 「先激活、再执行」是这个函数的全部意义：命令在面板里的**条目**来自清单，
 * 因此用户在插件一行代码都没跑过时就能看到它；点下去的那一刻才付执行的代价。
 */
export async function runPluginCommand(pluginId: string, localId: string): Promise<void> {
  await activatePlugin(pluginId, activationEventForCommand(localId));

  const fullId = commandFullId(pluginId, localId);
  const handler = commandHandlers.get(fullId);
  if (!handler) {
    throw new Error(
      `命令 "${localId}" 已在清单里声明，但插件激活后没有绑定处理函数。` +
        `请确认 bundle 在顶层调用了 Modulith.registerCommand({ id: "${localId}", run })`
    );
  }
  await handler();
}

/**
 * 把清单里声明的命令登记进全局命令面板。
 *
 * 条目的 `run` 是一个**包装**：它先激活插件，再调用插件绑定的处理函数。
 * 这个包装在插件未激活时也一直存在 —— 那正是「命令可见但不执行」的形态。
 */
function registerDeclaredCommands(pluginId: string, commands: CommandContribution[]): void {
  for (const command of commands) {
    const fullId = commandFullId(pluginId, command.id);
    registerCommand({
      id: fullId,
      title: command.title,
      subtitle: command.subtitle,
      keywords: command.keywords,
      // 插件命令归入「动作」组，与宿主动作并列显示
      group: 'actions',
      icon: command.icon,
      run: async () => {
        try {
          await runPluginCommand(pluginId, command.id);
        } catch (error) {
          // 命令面板不会 await 这个 Promise，因此这里必须自己把失败变成可见的东西。
          // 抛出去只会变成一条无人处理的 rejection —— 用户看到的是「点了没反应」。
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[pluginRuntime] 插件命令 "${command.id}" 执行失败:`, error);
          await pushNotification({
            title: `插件命令执行失败：${command.title}`,
            body: message,
            level: 'error',
            source: pluginId,
          }).catch(() => {});
        }
      },
    });
  }
}

/** 由清单声明建立的模块描述符：组件在**渲染时**才触发激活 */
function buildDeclaredModuleDescriptor(
  plugin: InstalledPlugin,
  contribution: ModuleContribution
): ModuleDescriptor {
  const pluginId = plugin.id;
  const moduleId = contribution.id;

  return {
    id: moduleId,
    name: contribution.name,
    displayName: contribution.displayName ?? contribution.name,
    description: contribution.description ?? '',
    icon: contribution.icon ?? plugin.manifest.icon ?? 'Package',
    path: `/plugins/${moduleId}`,
    priority: contribution.priority ?? 100,
    category: contribution.category ?? 'plugin',
    // `sidebar: false` 落到「默认收进隐藏模块面板」而不是彻底不可见：
    // 用户仍然能找到它、能把它固定出来 —— 一个连发现路径都没有的界面更糟。
    visible: contribution.sidebar !== false,
    disabled: false,
    badge: contribution.badge,
    // 这里是整块设计的落点：条目现在就有，组件要等到有人真的打开它。
    component: createLazyComponent(async () => {
      const Component = await ensureProvidedModule(pluginId, moduleId);
      return { default: Component };
    }),
    children: undefined,
    pluginId,
    iconSvg: resolveInlineIconSvg(pluginId, plugin.manifest),
  };
}

/** 旧式插件在加载期直接注册模块时用的描述符 */
function buildRuntimeModuleDescriptor(
  pluginId: string,
  manifest: PluginManifest | undefined,
  registration: PluginModuleRegistration,
  Component: React.ComponentType<Record<string, never>>
): ModuleDescriptor {
  return {
    id: registration.id,
    name: registration.name || registration.id,
    displayName: registration.displayName ?? registration.name ?? registration.id,
    description: registration.description ?? '',
    icon: registration.icon ?? manifest?.icon ?? 'Package',
    path: registration.path ?? `/plugins/${registration.id}`,
    priority: typeof registration.priority === 'number' ? registration.priority : 100,
    category: registration.category ?? 'plugin',
    visible: true,
    disabled: false,
    badge: registration.badge,
    component: createLazyComponent(async () => ({ default: Component })),
    children: undefined,
    pluginId,
    // 内联 SVG 随描述符一起传给渲染层。渲染图标是同步路径，
    // 若等到渲染时再 invoke 读取就会先出现一帧空框，因此在这里取好。
    iconSvg: resolveInlineIconSvg(pluginId, manifest),
  };
}

/**
 * 取回某个已声明模块的组件，必要时先把插件激活。
 *
 * 失败的两种情况必须分开报，因为作者的修法完全不同：
 *   * 激活失败 —— 插件的 bundle 有问题，错误在 `state.error` 里；
 *   * 激活成功但没提供这个模块 —— 清单声明了 `modules` 却没在代码里
 *     `registerModule({ id, component })`。
 */
async function ensureProvidedModule(
  pluginId: string,
  moduleId: string
): Promise<React.ComponentType<Record<string, never>>> {
  const key = providedModuleKey(pluginId, moduleId);
  const provided = providedModules.get(key);
  if (provided) return provided;

  const state = await activatePlugin(pluginId, activationEventForModule(moduleId));

  const after = providedModules.get(key);
  if (after) return after;

  throw new Error(
    state.status === 'failed'
      ? `插件 "${pluginId}" 激活失败：${state.error ?? '未知错误'}`
      : `插件 "${pluginId}" 激活后没有提供模块 "${moduleId}" 的组件。` +
        `清单声明了它，因此 bundle 顶层需要调用 ` +
        `Modulith.registerModule({ id: "${moduleId}", name: "…", component: … })`
  );
}

/**
 * 激活一个插件（执行它的 bundle）。重复调用是幂等的。
 *
 * 这是 1.2.0 之前不存在的入口：那时插件只有「在后台加载阶段全部执行」一条路，
 * 因此「有 500 个插件」与「启动后要跑 500 段第三方代码」是同一件事。
 */
export async function activatePlugin(
  pluginId: string,
  event: ActivationEvent | 'legacy'
): Promise<PluginActivationState> {
  const current = activationStates.get(pluginId);
  if (current?.status === 'active') return current;

  const inFlight = activating.get(pluginId);
  if (inFlight) return inFlight;

  const plugin = installed.find((item) => item.id === pluginId);
  if (!plugin) {
    throw new Error(`插件 "${pluginId}" 不在已安装列表中，无法激活`);
  }
  if (!plugin.enabled) {
    throw new Error(`插件 "${pluginId}" 已被禁用，无法激活`);
  }
  if (plugin.status === 'error') {
    throw new Error(`插件 "${pluginId}" 的清单无法读取，无法激活`);
  }

  activationStates.set(pluginId, { pluginId, status: 'activating', reason: event });
  activationReasons.set(pluginId, event);
  notify();

  const run = (async (): Promise<PluginActivationState> => {
    const result = await loadPlugin(plugin, configuredTimeoutMs);
    const next: PluginActivationState =
      result.status === 'loaded'
        ? {
            pluginId,
            status: 'active',
            reason: event,
            activatedAt: new Date().toISOString(),
          }
        : {
            pluginId,
            status: 'failed',
            reason: event,
            activatedAt: new Date().toISOString(),
            error: result.error,
          };
    activationStates.set(pluginId, next);
    notify();
    return next;
  })();

  activating.set(pluginId, run);
  try {
    return await run;
  } finally {
    activating.delete(pluginId);
  }
}

/** 右键菜单里的一条插件贡献 */
export interface PluginContextMenuEntry {
  pluginId: string;
  pluginDisplayName: string;
  id: string;
  label: string;
  icon?: string;
  group?: string;
  /** 该插件是否已经激活（界面上可以据此做些区分） */
  active: boolean;
}

/** 全部右键菜单贡献（宿主外壳把它们排在自己的动作之后） */
export function getPluginContextMenuEntries(): PluginContextMenuEntry[] {
  const entries: PluginContextMenuEntry[] = [];

  for (const plugin of installed) {
    if (!plugin.enabled || plugin.status === 'error') continue;
    const contract = contracts.get(plugin.id);
    if (!contract?.declarative) continue;

    for (const menu of contract.contributions.contextMenus) {
      entries.push({
        pluginId: plugin.id,
        pluginDisplayName: plugin.manifest.displayName || plugin.id,
        id: menu.id,
        label: menu.label,
        icon: menu.icon,
        group: menu.group,
        active: isPluginActive(plugin.id),
      });
    }
  }

  return entries;
}

/** 执行一条右键菜单贡献 */
export async function runPluginContextMenuEntry(entry: PluginContextMenuEntry): Promise<void> {
  const contract = contracts.get(entry.pluginId);
  const menu = contract?.contributions.contextMenus.find((item) => item.id === entry.id);
  if (!menu) {
    throw new Error(`右键菜单项 "${entry.id}" 已不存在（插件可能已被卸载）`);
  }

  await activatePlugin(entry.pluginId, activationEventForContextMenu(menu.id));
  await runPluginCommand(entry.pluginId, menu.command);
}

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[pluginRuntime] 订阅者执行出错:', err);
    }
  });
}

/** 订阅插件状态变化（安装/启用/禁用/卸载/加载失败） */
export function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前已安装插件列表 */
export function getInstalledPlugins(): InstalledPlugin[] {
  return installed;
}

/** 加载状态表 */
export function getLoadStates(): Map<string, PluginLoadState> {
  return loadStates;
}

/** 是否已经完整地拉取过一次插件列表（见 `runtimeLoadedOnce` 的说明） */
export function hasPluginRuntimeLoaded(): boolean {
  return runtimeLoadedOnce;
}

/** 某个插件的加载状态 */
export function getLoadState(pluginId: string): PluginLoadState | undefined {
  return loadStates.get(pluginId);
}

// ============================================================
// 插件上下文（暴露给插件作者的 API）
// ============================================================

function pluginStorage(pluginId: string) {
  return {
    async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
      const raw = await invoke<string | null>('plugin_storage_get', { id: pluginId, key });
      if (raw === null || raw === undefined) return defaultValue;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return defaultValue;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      await invoke('plugin_storage_set', { id: pluginId, key, value: JSON.stringify(value) });
    },
    async delete(key: string): Promise<void> {
      await invoke('plugin_storage_delete', { id: pluginId, key });
    },
    async clear(): Promise<void> {
      await invoke('plugin_storage_clear', { id: pluginId });
    },
    async keys(): Promise<string[]> {
      return invoke<string[]>('plugin_storage_keys', { id: pluginId });
    },
    async all(): Promise<Record<string, unknown>> {
      const keys = await invoke<string[]>('plugin_storage_keys', { id: pluginId });
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        result[key] = await this.get(key);
      }
      return result;
    },
  };
}

function pluginHttp(pluginId: string) {
  const request = async (
    method: string,
    url: string,
    options?: { headers?: Record<string, string>; body?: string }
  ): Promise<Response> => {
    const res = await invoke<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>('plugin_http_request', {
      id: pluginId,
      method,
      url,
      headers: options?.headers ?? null,
      body: options?.body ?? null,
    });

    return new Response(res.body, { status: res.status, headers: res.headers });
  };

  const normalize = (init?: RequestInit) => ({
    headers: (init?.headers as Record<string, string>) ?? undefined,
    body: typeof init?.body === 'string' ? init.body : undefined,
  });

  return {
    fetch: (url: string, init?: RequestInit) =>
      request((init?.method ?? 'GET').toUpperCase(), url, normalize(init)),
    get: (url: string, init?: RequestInit) => request('GET', url, normalize(init)),
    post: (url: string, data?: unknown, init?: RequestInit) =>
      request('POST', url, { ...normalize(init), body: data === undefined ? undefined : JSON.stringify(data) }),
    put: (url: string, data?: unknown, init?: RequestInit) =>
      request('PUT', url, { ...normalize(init), body: data === undefined ? undefined : JSON.stringify(data) }),
    delete: (url: string, init?: RequestInit) => request('DELETE', url, normalize(init)),
  };
}

/**
 * 插件启动外部程序（`ctx.launcher`）。
 *
 * 权限检查**刻意不放在这一层**：真正的门是 Rust 侧的 `plugin_launch_program`，
 * 它在 `spawn` 之前检查清单是否声明了 `process-spawn`。前端不重复判断，理由与
 * storage / http 相同 —— 检查应当落在「动作真正发生」的那一侧，在前端再判一次
 * 只会多出一套可能与后端分叉的规则。
 */
function pluginLauncher(pluginId: string) {
  return {
    launch: (program: string, args?: string[]) =>
      invoke<void>('plugin_launch_program', {
        id: pluginId,
        program,
        args: args ?? [],
      }),
  };
}

/**
 * 插件提取**本机文件**图标（`ctx.icons`）。
 *
 * 名字刻意与上面的 `pluginIcons`（插件自己的 SVG 图标缓存）区分开：
 * 两者是全然不同的东西 —— 那个是插件清单里的图标，这个是任意本机文件的图标。
 *
 * 与 launcher 同理，权限检查在后端（`plugin_extract_icon` → `filesystem-read`）。
 */
function pluginFileIcons(pluginId: string) {
  return {
    extract: (path: string) =>
      invoke<string>('plugin_extract_icon', { id: pluginId, path }),
  };
}

/**
 * 在系统文件管理器中定位文件（`ctx.shell`）。
 *
 * 权限检查同样在后端（`plugin_reveal_in_folder` → `filesystem-read`）。
 */
function pluginShell(pluginId: string) {
  return {
    revealInFolder: (path: string) =>
      invoke<void>('plugin_reveal_in_folder', { id: pluginId, path }),
  };
}

/**
 * 文件拖放（`ctx.fileDrop`）。
 *
 * 需要 `filesystem-read` 权限 —— 拖放事件带来的是**本机路径**，与「按路径读取
 * 文件」属于同一类信息。未声明时降级为空实现并记录警告（与 notifications 的
 * 处理一致）：拖放通常只是「再加一个条目」的便捷入口，让整个模块因为一个可选
 * 入口而不可用并不划算。
 *
 * **这是窗口级事件**：无论当前显示哪个模块，只要有文件被拖进窗口就会触发。
 * 插件必须用 `Modulith.useModuleActive()` 自行判断当前是否可见，否则会在后台
 * 抢走本该属于其它模块的拖放。
 */
function pluginFileDrop(pluginId: string, manifest: PluginManifest | undefined) {
  const allowed = pluginHasPermission(manifest, 'filesystem-read');

  let warned = false;
  const warnOnce = () => {
    if (warned) return;
    warned = true;
    console.warn(
      `[pluginRuntime] 插件 "${pluginId}" 订阅了文件拖放，但清单里没有声明 "filesystem-read" 权限，订阅被忽略（后续同类调用不再重复提示）`
    );
  };

  return {
    isAvailable: () => allowed && isFileDropAvailable(),
    subscribe: (
      handler: (event: {
        type: 'enter' | 'over' | 'drop' | 'leave';
        paths: string[];
      }) => void
    ): (() => void) => {
      if (!allowed) {
        warnOnce();
        return () => {};
      }
      return subscribeFileDrop(handler);
    },
  };
}

/**
 * 插件导入音频文件（`ctx.audio`）。
 *
 * 权限检查在后端（`plugin_pick_audio` → `filesystem-read`）。
 */
function pluginAudio(pluginId: string) {
  return {
    pick: () => invoke<PickedAudio | null>('plugin_pick_audio', { id: pluginId }),
  };
}

/**
 * 插件能用的 logger
 *
 * 除了控制台，还往宿主的日志文件里写一份。理由：插件作者的 `logger.info(...)`
 * 在 release 版里此前只进 devtools（用户打不开），于是「插件不工作」这件事
 * 既没有插件自己的证据，也没有宿主的证据。走宿主日志之后，插件排查问题
 * 至少还有 plugin 作者留下的线索。
 *
 * 带上 `plugin:<id>` 作为 target，日志里一眼能看出是谁写的。
 */
function pluginLogger(pluginId: string) {
  const prefix = `[plugin:${pluginId}]`;
  const context = `plugin:${pluginId}`;

  const argsToText = (args: unknown[]): string =>
    args.length === 0
      ? ''
      : ` ${args
          .map((arg) => {
            if (typeof arg === 'string') return arg;
            try {
              return JSON.stringify(arg) ?? String(arg);
            } catch {
              return String(arg);
            }
          })
          .join(' ')}`;

  return {
    debug: (msg: string, ...args: unknown[]) => {
      console.debug(prefix, msg, ...args);
      logMessage('debug', `${msg}${argsToText(args)}`, context);
    },
    info: (msg: string, ...args: unknown[]) => {
      console.info(prefix, msg, ...args);
      logMessage('info', `${msg}${argsToText(args)}`, context);
    },
    warn: (msg: string, ...args: unknown[]) => {
      console.warn(prefix, msg, ...args);
      logMessage('warn', `${msg}${argsToText(args)}`, context);
    },
    error: (msg: string, ...args: unknown[]) => {
      console.error(prefix, msg, ...args);
      logMessage('error', `${msg}${argsToText(args)}`, context);
    },
    trace: (label: string) => {
      const start = performance.now();
      return () => {
        const elapsed = (performance.now() - start).toFixed(1);
        console.debug(`${prefix} ${label}: ${elapsed}ms`);
        logMessage('debug', `${label}: ${elapsed}ms`, context);
      };
    },
  };
}

/**
 * 判断插件是否声明了某个权限。
 *
 * 这是**前端**侧的权限检查，与后端 `plugin_http_request` 里的网络检查是两套
 * 独立的实现，作用于不同的能力：
 *   * 网络权限在 Rust 侧检查（因为请求本身由 Rust 发起）；
 *   * 通知与跨模块通信在前端检查（因为它们不发生 IPC 之外的动作）。
 *
 * 两处都只认 kebab-case。清单用冒号写法会在反序列化阶段就被拒绝，因此这里
 * 不必再兼容错误拼写。
 */
function pluginHasPermission(manifest: PluginManifest | undefined, permission: string): boolean {
  return (manifest?.permissions ?? []).includes(permission);
}

/**
 * 插件通知 API（`ctx.notifications`）。
 *
 * 这是把 `PluginNotificationAPI` 类型从「只有声明」变成「真的能用」的地方。
 * 之前 `src/types/plugin.ts` 里定义了这个接口，但 `createContext()` 从未提供它 ——
 * 插件按类型去调用会直接抛 `undefined is not a function`。
 *
 * **需要 `notification` 权限。** 未声明时返回一个空实现并记录警告，而不是抛错：
 * 抛错会让插件在加载期就整体失败（一个可选能力不该有这样的后果），而静默忽略
 * 又会让作者困惑。空实现 + 明确日志是折中。
 *
 * 只有应用内通知，没有系统级通知。原因是不引入新的 Tauri 插件依赖，
 * 这一点在文档里如实标注。
 */
function pluginNotifications(pluginId: string, manifest: PluginManifest | undefined) {
  const allowed = pluginHasPermission(manifest, 'notification');

  // 名实相符地「只警告一次」：插件可能在高频路径（例如重试循环）里反复调用，
  // 每次都打印会把控制台刷满，反而掩盖真正的问题。此前这个函数每次调用都打印。
  let warned = false;
  const warnOnce = () => {
    if (warned) return;
    warned = true;
    console.warn(
      `[pluginRuntime] 插件 "${pluginId}" 调用了通知接口，但清单里没有声明 "notification" 权限，调用被忽略（后续同类调用不再重复提示）`
    );
  };

  const notify = (
    title: string,
    body: string,
    level: NotificationLevel,
    dedupeKey?: string
  ): Promise<void> => {
    if (!allowed) {
      warnOnce();
      return Promise.resolve();
    }
    // source 固定为插件 ID：通知中心与标签徽标都靠它把消息归属到具体模块
    return pushNotification({ title, body, level, source: pluginId, dedupeKey });
  };

  return {
    show: (title: string, body = '', dedupeKey?: string) => notify(title, body, 'info', dedupeKey),
    info: (title: string, body = '', dedupeKey?: string) => notify(title, body, 'info', dedupeKey),
    success: (title: string, body = '', dedupeKey?: string) =>
      notify(title, body, 'success', dedupeKey),
    warn: (title: string, body = '', dedupeKey?: string) => notify(title, body, 'warning', dedupeKey),
    error: (title: string, body = '', dedupeKey?: string) => notify(title, body, 'error', dedupeKey),
    /** 权限是否已声明（插件可据此自行降级，而不必看控制台） */
    isAvailable: () => allowed,
  };
}

/**
 * 插件跨模块通信 API（`ctx.events`）。
 *
 * **需要 `plugin-communicate` 权限。** 未声明时订阅返回空函数、发布被忽略。
 * 这与通知一样是「前端能力」，因此检查在前端。
 *
 * 订阅会自动带上 `source = 插件 ID`，因此插件被禁用/卸载时宿主可以一次性
 * 摘掉它注册的所有处理函数（见 `cleanupPluginResources`）。插件自己不需要
 * 记住取消订阅 —— 但仍返回取消函数，便于它在运行期主动收回。
 */
function pluginEvents(pluginId: string, manifest: PluginManifest | undefined) {
  const allowed = pluginHasPermission(manifest, 'plugin-communicate');

  // 与 pluginNotifications 同理：只提示一次，避免高频调用刷满控制台。
  let warned = false;
  const warnOnce = () => {
    if (warned) return;
    warned = true;
    console.warn(
      `[pluginRuntime] 插件 "${pluginId}" 调用了跨模块通信，但清单里没有声明 "plugin-communicate" 权限，调用被忽略（后续同类调用不再重复提示）`
    );
  };

  return {
    publish: (topic: string, payload?: unknown): void => {
      if (!allowed) {
        warnOnce();
        return;
      }
      publish(topic, payload, pluginId);
    },
    subscribe: <T = unknown>(topic: string, handler: EventHandler<T>): (() => void) => {
      if (!allowed) {
        warnOnce();
        return () => {};
      }
      return subscribe<T>(topic, handler, { source: pluginId });
    },
    isAvailable: () => allowed,
  };
}

/**
 * 插件设置 API（`ctx.settings`）。
 *
 * **需要 `storage` 权限** —— 值就存在插件自己的存储命名空间里，与 `ctx.storage`
 * 共用同一套后端命令。未声明时读取回落到缺省值、写入抛错，并且只提示一次
 * （与 notifications / events 的处理一致）。
 *
 * `get` / `getAll` 是**同步**的：设置值在插件激活前就已随贡献目录读好，
 * 因此插件可以在 IIFE 顶层直接读它来决定怎么做，不必先 `await`。
 * 这一点很重要 —— 插件的顶层是同步执行的，一个异步的设置读取根本来不及参与。
 */
function pluginSettingsAPI(
  pluginId: string,
  manifest: PluginManifest | undefined
): PluginSettingsAPI {
  const allowed = pluginHasPermission(manifest, 'storage');

  let warned = false;
  const warnOnce = () => {
    if (warned) return;
    warned = true;
    console.warn(
      `[pluginRuntime] 插件 "${pluginId}" 使用了设置接口，但清单里没有声明 "storage" 权限，读取将回落到缺省值、写入会失败（后续同类调用不再重复提示）`
    );
  };

  return {
    isAvailable: () => allowed,
    get: <T = unknown>(id: string): T | undefined => {
      if (!allowed) {
        warnOnce();
        return undefined;
      }
      return getPluginSetting(pluginId, id) as T | undefined;
    },
    getAll: () => {
      if (!allowed) {
        warnOnce();
        return {};
      }
      return getAllPluginSettings(pluginId);
    },
    set: async (id: string, value: unknown): Promise<void> => {
      if (!allowed) {
        warnOnce();
        throw new Error(
          `插件 "${pluginId}" 没有声明 "storage" 权限，设置 "${id}" 无法保存`
        );
      }
      await setPluginSetting(pluginId, id, value);
    },
    /**
     * 订阅变更。
     *
     * `pluginSettings` 的通知不带参数（它只知道「有东西变了」），因此这里比对
     * 前后两份快照把它还原成 (id, value)。用快照而不是让存储层广播具体键：
     * 后者要求每个写入点都记得带上键，而写入点不止一处（插件、宿主设置界面）。
     */
    onChange: (handler: (id: string, value: unknown) => void): (() => void) => {
      let snapshot = allowed ? getAllPluginSettings(pluginId) : {};
      return subscribePluginSettings(() => {
        if (!allowed) return;
        const next = getAllPluginSettings(pluginId);
        for (const key of Object.keys(next)) {
          if (snapshot[key] !== next[key]) handler(key, next[key]);
        }
        snapshot = next;
      });
    },
  };
}

/** 为「正在加载的插件」创建上下文；在插件代码之外调用会抛错 */
function createContext() {
  if (!loadingPluginId) {
    throw new Error(
      'Modulith.createContext() 只能在插件 bundle 加载期间调用（例如 IIFE 顶层）'
    );
  }
  const pluginId = loadingPluginId;
  const manifest = installed.find((p) => p.id === pluginId)?.manifest;
  return {
    pluginId,
    pluginVersion: manifest?.version ?? '0.0.0',
    manifest,
    version: resolvedVersion,
    /**
     * 本次激活由什么触发（`onModule:xxx` / `onCommand:xxx` / `onContextMenu:xxx`
     * / `onStartup` / 旧式插件的 `'legacy'`）。
     *
     * 存在的理由：一个声明了多条激活事件的插件，往往只需要为**被用到的那部分**
     * 做准备（例如被 `onCommand:export` 唤醒时不必先去建界面）。没有它，插件只能
     * 全部初始化一遍，那等于把按需激活省下的钱又花回去。
     */
    activationEvent: activationReasons.get(pluginId) ?? null,
    storage: pluginStorage(pluginId),
    http: pluginHttp(pluginId),
    logger: pluginLogger(pluginId),
    notifications: pluginNotifications(pluginId, manifest),
    events: pluginEvents(pluginId, manifest),
    launcher: pluginLauncher(pluginId),
    icons: pluginFileIcons(pluginId),
    shell: pluginShell(pluginId),
    fileDrop: pluginFileDrop(pluginId, manifest),
    audio: pluginAudio(pluginId),
    settings: pluginSettingsAPI(pluginId, manifest),
    /**
     * 收尾登记的入口。**这是功能型插件的前提**：一个后台服务会创建定时器、
     * 事件监听、观察者、WebSocket —— 宿主一个都不知道，禁用之后它们会一直活着。
     */
    disposables: {
      add: (dispose: () => void) => addDisposable(pluginId, dispose),
      size: () => (disposableRegistry.get(pluginId) ?? []).length,
    },
  };
}

// ============================================================
// 模块注册
// ============================================================

export interface PluginModuleRegistration {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  icon?: string;
  path?: string;
  priority?: number;
  category?: string;
  badge?: string;
  component: React.ComponentType<Record<string, never>>;
}

function registerModule(registration: PluginModuleRegistration): void {
  if (!loadingPluginId) {
    console.error(
      '[pluginRuntime] registerModule() 只能在插件 bundle 加载期间调用，已忽略:',
      registration
    );
    return;
  }
  if (!registration || typeof registration.id !== 'string' || !registration.id.trim()) {
    console.error('[pluginRuntime] registerModule() 缺少合法的 id，已忽略');
    return;
  }
  if (typeof registration.component !== 'function' && typeof registration.component !== 'object') {
    console.error(
      `[pluginRuntime] 模块 "${registration.id}" 的 component 不是有效的 React 组件，已忽略`
    );
    return;
  }

  const pluginId = loadingPluginId;
  const Component = registration.component;
  const manifest = installed.find((p) => p.id === pluginId)?.manifest;
  const contract = contracts.get(pluginId);

  if (contract?.declarative) {
    // 声明式插件：目录条目在**读清单**时就建立好了，这里只把组件交出去。
    // 组件不会立刻进目录，而是等那个懒组件被渲染时按 ID 取回 ——
    // 因此「目录在插件未激活时也是完整的」这件事不会因为这次注册而改变。
    providedModules.set(providedModuleKey(pluginId, registration.id), Component);

    if (contract.contributions.modules.some((item) => item.id === registration.id)) {
      console.info(
        `[pluginRuntime] 声明式插件 "${pluginId}" 提供了模块 "${registration.id}" 的组件`
      );
      return;
    }

    // 没声明的模块：宽容地补进目录，但记一条警告。
    // 「声明」的价值是让宿主**不必执行代码**就能画界面，而不是限制插件能注册什么；
    // 但未声明的模块不会出现在那份目录里，因此插件未激活时侧边栏上是没有它的。
    console.warn(
      `[pluginRuntime] 插件 "${pluginId}" 注册了未在 contributes.modules 里声明的模块 "${registration.id}"，` +
        `已按注册信息补进目录；声明它才能在插件未激活时也显示在侧边栏`
    );
  }

  const descriptor = buildRuntimeModuleDescriptor(pluginId, manifest, registration, Component);

  const ok = registerDynamicModule(descriptor, pluginId);
  if (ok) {
    console.info(
      `[pluginRuntime] 插件 "${pluginId}" 注册模块 "${descriptor.id}" (${descriptor.name})`
    );
  }
}

// ============================================================
// 插件图标资源
// ============================================================

/** 插件声明的图标文件是否为 SVG 路径 */
function iconIsSvgFile(icon: string | undefined): icon is string {
  return typeof icon === 'string' && /\.svg$/i.test(icon.trim());
}

function isSvgMarkup(value: string | undefined): value is string {
  return typeof value === 'string' && value.trimStart().toLowerCase().startsWith('<svg');
}

/**
 * 插件声明的图标若是 SVG 文件，就在加载期把它读出来缓存。
 *
 * 为什么必须提前读、而不是渲染时读：模块图标的渲染路径是同步的
 * （侧边栏、仪表盘），而 `read_plugin_asset` 是异步命令。
 * 渲染时读取会先出现一帧空框，正是用户报告的「图标是空的」。
 *
 * 读取失败不抛错：图标缺失不该让整个插件加载失败，
 * 渲染端会回落到通用图标。
 */
async function prefetchPluginIcon(plugin: InstalledPlugin): Promise<void> {
  const icon = plugin.manifest.icon;
  if (!iconIsSvgFile(icon)) return;

  try {
    const svg = await invoke<string>('read_plugin_asset', { id: plugin.id, rel: icon.trim() });
    if (isSvgMarkup(svg)) {
      pluginIcons.set(plugin.id, svg);
    }
  } catch (error) {
    console.warn(
      `[pluginRuntime] 读取插件 "${plugin.id}" 的图标 "${icon}" 失败，将使用通用图标:`,
      error
    );
  }
}

/** 解析注册模块时要携带的内联 SVG（可能来自加载期预取，也可能是清单内联） */
function resolveInlineIconSvg(
  pluginId: string,
  manifest: PluginManifest | undefined
): string | undefined {
  if (isSvgMarkup(manifest?.iconSvg)) return manifest?.iconSvg;
  return pluginIcons.get(pluginId);
}

// ============================================================
// 宿主全局注入
// ============================================================

/** 插件注册命令时的入参（`id` 是插件内的局部 ID，宿主会自动加前缀） */
export interface PluginCommandRegistration {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  icon?: string;
  run: () => void | Promise<void>;
}

export interface ModulithHost {
  version: string;
  platform: string;
  React: typeof React;
  jsx: typeof jsx;
  jsxs: typeof jsxs;
  Fragment: typeof Fragment;
  registerModule: (registration: PluginModuleRegistration) => void;
  createContext: () => ReturnType<typeof createContext>;
  /**
   * 把一个动作注册进全局搜索框。
   *
   * 只能在插件加载期间调用（与 `createContext` 相同的约束）：命令需要归属到
   * 具体的插件，而「当前正在加载哪个插件」只有加载期才有确定值。
   * 宿主会给 ID 加上 `plugin:<插件ID>:` 前缀，因此插件卸载时能一次性摘掉
   * 它注册的全部命令（见 `cleanupPluginResources`）。
   */
  registerCommand: (command: PluginCommandRegistration) => void;
  /**
   * 判断「本模块当前是否真的对用户可见」的 Hook。
   *
   * 标签页保活意味着模块被切走后不会卸载，定时器与轮询会照常跑。插件应当用
   * 它来决定要不要暂停后台工作：
   *
   * ```js
   * const active = Modulith.useModuleActive();
   * React.useEffect(() => {
   *   if (!active) return;
   *   const t = setInterval(refresh, 30_000);
   *   return () => clearInterval(t);
   * }, [active]);
   * ```
   *
   * 宿主提供的是**感知能力**而不是强制暂停 —— JS 里拿不到模块创建的 timer 句柄，
   * 无法可靠地代为暂停。
   */
  useModuleActive: typeof useModuleActive;
  /**
   * 宿主能力表。插件用它做**特性探测**，而不是拿 `Modulith.version` 做字符串比较：
   * `engines.loopcore` 只表达「我要求宿主至少多新」，而且它只提示、不阻断；
   * 真正决定一段代码能不能跑的，是这里列出的东西。
   */
  capabilities: ModulithCapabilities;
  /**
   * 登记一个「插件被卸载/禁用/重载时执行」的清理函数。
   *
   * 这是**功能型插件**成立的前提。一个只注册模块的插件不需要它 —— 宿主清掉
   * DOM 与目录条目就够了；但一个后台服务会创建定时器、监听器、观察者、连接，
   * 宿主一个都不知道，禁用之后它们会一直活着。
   *
   * 只在插件加载期间可调用（清理函数必须归属到具体插件，而「当前正在加载哪个插件」
   * 只有加载期才有确定值）。`ctx.disposables.add` 是它的另一个入口。
   */
  onDeactivate: (dispose: () => void) => void;
}

/** 插件注册命令的实现：加前缀、校验、写入命令注册表 */
function registerPluginCommand(command: PluginCommandRegistration): void {
  if (!loadingPluginId) {
    throw new Error(
      'Modulith.registerCommand() 只能在插件 bundle 加载期间调用（例如 IIFE 顶层）'
    );
  }

  if (!command?.id || !command.title || typeof command.run !== 'function') {
    console.warn('[pluginRuntime] registerCommand 需要 id、title 与 run，调用被忽略');
    return;
  }

  const pluginId = loadingPluginId;
  const fullId = commandFullId(pluginId, command.id);
  const contract = contracts.get(pluginId);

  if (contract?.declarative) {
    // 声明式插件：面板里的**条目**在声明期就登记好了，这里只把 handler 交出去。
    // 那个条目自己的 run 已经会「先激活、再查 handler」，因此这里**不能**覆盖它 ——
    // 覆盖掉就等于把「未激活也能看见」这件事一起丢了。
    if (contract.contributions.commands.some((item) => item.id === command.id)) {
      commandHandlers.set(fullId, command.run);
      console.info(`[pluginRuntime] 声明式插件 "${pluginId}" 绑定了命令 "${command.id}"`);
      return;
    }

    console.warn(
      `[pluginRuntime] 插件 "${pluginId}" 注册了未在 contributes.commands 里声明的命令 "${command.id}"，` +
        `已直接加进命令面板；声明它才能在插件未激活时也被搜到`
    );
  }

  registerCommand({
    id: fullId,
    title: command.title,
    subtitle: command.subtitle,
    keywords: command.keywords,
    // 插件命令归入「动作」组，与宿主动作并列显示
    group: 'actions',
    icon: command.icon,
    run: command.run,
  });
}

let hostInstalled = false;

function installHostGlobals(): void {
  if (hostInstalled) return;

  const host: ModulithHost = {
    // 使用已解析的版本号；若 refreshHostVersion() 尚未执行，
    // 这里就是编译期兜底值，插件永远不会读到 undefined。
    version: resolvedVersion,
    platform: 'tauri',
    React,
    jsx,
    jsxs,
    Fragment,
    registerModule,
    createContext,
    registerCommand: registerPluginCommand,
    useModuleActive,
    capabilities: HOST_CAPABILITIES,
    /**
     * 登记一个「插件被卸载/禁用/重载时执行」的清理函数。
     *
     * 与 `ctx.disposables.add` 是同一件事的两个入口：后者需要先 `createContext()`，
     * 而这个可以在任何地方用。两者都只在加载期可用 —— 清理函数必须归属到具体插件，
     * 而「当前正在加载哪个插件」只有加载期才有确定值。
     */
    onDeactivate: (dispose: () => void) => {
      if (!loadingPluginId) {
        throw new Error(
          'Modulith.onDeactivate() 只能在插件 bundle 加载期间调用（例如 IIFE 顶层）'
        );
      }
      addDisposable(loadingPluginId, dispose);
    },
  };

  (window as unknown as { Modulith: ModulithHost }).Modulith = host;
  hostInstalled = true;
  console.info('[pluginRuntime] 宿主 API 已注入 window.Modulith');
}

// ============================================================
// 加载 / 卸载
// ============================================================

function cleanupInjected(pluginId: string): void {
  const assets = injectedAssets.get(pluginId);
  if (!assets) return;
  assets.scripts.forEach((el) => el.remove());
  assets.styles.forEach((el) => el.remove());
  injectedAssets.delete(pluginId);
}

/**
 * 清理与插件绑定的非 DOM 资源。
 *
 * 四样东西必须一起摘掉，否则插件被禁用/卸载后会留下指向失效代码的引用：
 *   * 图标 SVG 缓存；
 *   * 事件总线上的全部订阅（`unsubscribeBySource`）；
 *   * 它注册到命令注册表的命令（`unregisterCommandsByPrefix`）——
 *     留着的话搜索框里会出现指向已经不存在的能力的条目；
 *   * 插件自己登记的清理函数（`ctx.disposables` / `Modulith.onDeactivate`）——
 *     定时器、监听器、观察者、连接，宿主没有别的途径知道它们存在。
 *
 * **声明式插件有一个例外：命令的「声明」要在清理之后贴回去。** 那些条目本来就
 * 应该在插件未激活时也存在（它们是清单的一部分，不是运行期的产物）；如果不贴回去，
 * 禁用一次再启用就会让命令面板少掉几条，直到下一次完整重载才恢复。
 */
function cleanupPluginResources(pluginId: string): void {
  pluginIcons.delete(pluginId);
  activationStates.delete(pluginId);
  activationReasons.delete(pluginId);

  const removedSubscriptions = unsubscribeBySource(pluginId);

  // 已提供但未落进目录的组件也要一并丢弃：它们闭包指向的旧 bundle 已经作废
  for (const key of [...providedModules.keys()]) {
    if (key.startsWith(`${pluginId}::`)) providedModules.delete(key);
  }

  const removedCommands = unregisterCommandsByPrefix(commandPrefix(pluginId));

  const contract = contracts.get(pluginId);
  if (contract?.declarative) {
    for (const key of [...commandHandlers.keys()]) {
      if (key.startsWith(commandPrefix(pluginId))) commandHandlers.delete(key);
    }
    registerDeclaredCommands(pluginId, contract.contributions.commands);
  }

  const removedDisposables = runDisposables(pluginId);

  if (removedSubscriptions > 0 || removedCommands > 0 || removedDisposables > 0) {
    console.info(
      `[pluginRuntime] 已清理插件 "${pluginId}" 的资源：事件订阅 ${removedSubscriptions} 个，` +
        `命令 ${removedCommands} 条，清理函数 ${removedDisposables} 个`
    );
  }
}

/**
 * 加载单个插件：读图标 → 注入样式 → 执行 bundle。bundle 内同步调用 registerModule()。
 *
 * `timeoutMs` 的作用边界（重要，不要误解）：
 *   JS 是单线程的，插件 bundle 顶层的同步死循环**无法被中断** ——
 *   一旦发生，界面会一起卡住。超时能做到的是：不再把后续插件的时间
 *   也算在这个插件头上，从而保证「一个坏插件不会连带拖死其它插件」。
 *   真正的进程级隔离需要 Web Worker / iframe，本项目当前不具备（见文档）。
 */
async function loadPlugin(plugin: InstalledPlugin, timeoutMs?: number): Promise<PluginLoadState> {
  const work = loadPluginInner(plugin);

  if (!timeoutMs || timeoutMs <= 0) return work;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PluginLoadState>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[pluginRuntime] 插件 "${plugin.id}" 在 ${timeoutMs}ms 内未完成加载，已标记为失败`
      );
      // 标记失败状态：界面能明确显示「这个插件有问题」，
      // 而不是让用户对着一个永远不出现的模块发愣。
      const state: PluginLoadState = {
        pluginId: plugin.id,
        status: 'error',
        error: `加载超时（超过 ${timeoutMs}ms 未完成）`,
        moduleIds: [],
        loadedAt: new Date().toISOString(),
      };
      loadStates.set(plugin.id, state);
      resolve(state);
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 提示「清单声明了模块，但插件激活后没有提供对应的组件」。
 *
 * 这是一类很具体的笔误：`contributes.modules[].id` 与代码里
 * `registerModule({ id })` 的 id 对不上。它不会让插件加载失败（另一个模块可能
 * 一切正常），只会让某一个模块点开时报错，因此在这里一次性把差异说清楚 ——
 * 否则作者看到的是「插件是好的，只有某一页坏了」，很难联想到是 ID 对不上。
 */
function warnAboutUnprovidedModules(
  pluginId: string,
  contract: PluginLoadContract | undefined
): void {
  if (!contract?.declarative) return;

  const missing = contract.contributions.modules
    .filter((item) => !providedModules.has(providedModuleKey(pluginId, item.id)))
    .map((item) => item.id);

  if (missing.length === 0) return;

  console.warn(
    `[pluginRuntime] 插件 "${pluginId}" 在清单里声明了模块 ${missing.join('、')}，` +
      `但激活后没有为它们提供组件；打开这些模块时会看到明确的错误提示。` +
      `请确认 registerModule({ id }) 里的 id 与 contributes.modules[].id 一致`
  );
}

/** 插件的实际加载过程（不含超时控制） */
async function loadPluginInner(plugin: InstalledPlugin): Promise<PluginLoadState> {
  const pluginId = plugin.id;
  const manifest = plugin.manifest;
  const contract = contracts.get(pluginId);

  // 允许重复加载：先清理旧资源与旧模块。
  //
  // 目录条目要不要一起清掉，取决于它从哪来：
  //   * 旧式插件的条目由它自己的 `registerModule()` 建立，因此重载前必须清掉，
  //     否则改过 ID 的旧条目会一直留在侧边栏里；
  //   * 声明式插件的条目来自**清单**，清掉就再也回不来 —— 下一次注册发生在激活期，
  //     而「未激活时侧边栏也应该是完整的」正是这次改动要保住的东西。
  cleanupInjected(pluginId);
  cleanupPluginResources(pluginId);
  if (!contract?.declarative) {
    unregisterDynamicModules(pluginId);
  }

  const assets = { scripts: [] as HTMLScriptElement[], styles: [] as HTMLStyleElement[] };
  injectedAssets.set(pluginId, assets);

  try {
    // 图标要在 bundle 执行前读好：registerModule() 是 bundle 顶层同步调用的，
    // 它需要立刻拿到 iconSvg 一起写进模块描述符。
    await prefetchPluginIcon(plugin);

    if (manifest.style) {
      const css = await invoke<string>('read_plugin_asset', { id: pluginId, rel: manifest.style });
      const styleEl = document.createElement('style');
      styleEl.dataset.pluginId = pluginId;
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
      assets.styles.push(styleEl);
    }

    const mainFile = manifest.main || 'dist/index.js';
    const code = await invoke<string>('read_plugin_asset', { id: pluginId, rel: mainFile });

    // 捕获脚本执行期抛出的错误，避免只进 devtools 而 UI 一无所知
    let runtimeError: Error | null = null;
    const onError = (event: ErrorEvent) => {
      runtimeError = event.error instanceof Error ? event.error : new Error(event.message);
    };
    window.addEventListener('error', onError);

    const scriptEl = document.createElement('script');
    scriptEl.dataset.pluginId = pluginId;
    scriptEl.textContent = code;

    loadingPluginId = pluginId;
    try {
      document.head.appendChild(scriptEl);
      assets.scripts.push(scriptEl);
    } finally {
      loadingPluginId = null;
      window.removeEventListener('error', onError);
    }

    if (runtimeError) {
      throw runtimeError;
    }

    const moduleIds = getPluginModuleIds(pluginId);

    // 「加载成功」的判据从 1.2.0 起换了一条。
    //
    // 旧判据是「至少注册了一个模块」，它把「插件是什么」与「插件往侧边栏放了什么」
    // 焊死在一起 —— 于是一个只加三条命令的插件、一个只做后台监听的插件，都会被判为
    // 加载失败。新判据是「**至少贡献了一样东西**」，而那样东西可以是清单里的声明。
    //
    // 这条检查仍然保留，是因为它抓的是另一个真实错误：bundle 不是预期的 IIFE
    // （打包配置错了、入口文件写错了）—— 那种情况下插件确实什么都没做。
    const contributed =
      moduleIds.length > 0 ||
      (contract?.declarative === true &&
        (contract.contributions.commands.length > 0 ||
          contract.contributions.settings.length > 0 ||
          contract.contributions.contextMenus.length > 0 ||
          contract.events.length > 0));

    if (!contributed) {
      throw new Error(
        '插件已加载，但既没有贡献任何东西，也没有声明激活事件。' +
          '请确认 bundle 调用了 Modulith.registerModule(...)，' +
          '或在清单里声明 contributes / activationEvents'
      );
    }

    warnAboutUnprovidedModules(pluginId, contract);

    const state: PluginLoadState = {
      pluginId,
      status: 'loaded',
      moduleIds,
      loadedAt: new Date().toISOString(),
    };
    loadStates.set(pluginId, state);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pluginRuntime] 插件 "${pluginId}" 加载失败:`, error);
    cleanupInjected(pluginId);
    cleanupPluginResources(pluginId);
    if (!contract?.declarative) {
      unregisterDynamicModules(pluginId);
    }

    const state: PluginLoadState = {
      pluginId,
      status: 'error',
      error: message,
      moduleIds: [],
      loadedAt: new Date().toISOString(),
    };
    loadStates.set(pluginId, state);
    return state;
  }
}

/** 卸载（禁用/卸载插件时移除其已注入的资源与模块） */
export function unloadPlugin(pluginId: string): void {
  cleanupInjected(pluginId);
  cleanupPluginResources(pluginId);
  unregisterDynamicModules(pluginId);
  loadStates.delete(pluginId);
}

/**
 * 重新加载整个插件运行时：重新拉取插件列表，加载所有「已启用」的插件。
 * 安装 / 启用 / 禁用 / 卸载后都应该调用它。
 *
 * `onProgress` 在每个插件加载完成后回调一次，参数是**真实**进度
 * （已完成数 / 总数 / 正在处理的插件名），供启动加载界面展示真实进度，
 * 而不是靠计时器假装。
 */
export async function reloadPluginRuntime(
  onProgress?: (done: number, total: number, detail?: string) => void,
  options: { timeoutMs?: number; listOnly?: boolean } = {}
): Promise<InstalledPlugin[]> {
  // 先取回权威版本号，再注入宿主 API ——
  // 保证插件在 IIFE 顶层读到的 window.Modulith.version 就是后端真实版本。
  await refreshHostVersion();
  installHostGlobals();

  // 权限元数据与插件列表一起取回。
  //
  // 放在这个唯一入口，而不是让插件页自己去拉：启动阶段就会走到这里（见
  // boot.ts 的 'plugins' 步骤），因此插件页渲染时数据已经在手，不会先按
  // "未知权限"（最高等级）画一遍，再跳变成正确等级。
  //
  // 失败不抛出，也不阻断下面的插件加载 —— 权限标签缺失不该升级成插件全不可用。
  await loadPermissionRegistry();

  installed = await invoke<InstalledPlugin[]>('list_plugins');
  runtimeLoadedOnce = true;

  configuredTimeoutMs = options.timeoutMs ?? configuredTimeoutMs;

  // 清空全部动态模块，避免残留已卸载插件注册的模块
  clearDynamicModules();

  // 作废已缓存的模块组件。**必须在这里做，而不是让调用方各自记得**：
  // 下面每个插件的 registerModule() 都会为同一模块 ID 造一个全新的懒加载
  // 组件（闭包指向新 bundle 里的函数），而 ModuleRenderer 命中缓存后就不会再
  // 看描述符里的新组件。漏掉这一步的表现是「插件改了、刷新了、界面没变」——
  // 也就是必须删掉插件重装才生效。统一放在重载入口，所有路径都被覆盖。
  clearModuleComponentCache();

  // ---- 贡献目录：**只读清单，不执行任何插件代码** ----
  //
  // 这一段是 1.2.0 的核心。它跑完之后，侧边栏、命令面板、设置界面、右键菜单
  // 就已经是完整的了 —— 而此刻一个插件 bundle 都还没有执行过。
  //
  // 由此得到三件事：
  //   * 功能性插件成立（只加命令、只做后台服务，都不再有"必须注册模块"的门槛）；
  //   * 按需激活成立（插件代码等到用户真的用到它才跑）；
  //   * 将来把插件挪进独立进程时，宿主仍然画得出完整界面 —— 这是沙箱的前提，
  //     因为跨 realm 之后"先执行再问它有什么"本身就是一次远程调用。
  contracts.clear();
  clearPluginSettings();

  const enabledPlugins = installed.filter((plugin) => plugin.enabled && plugin.status !== 'error');
  for (const plugin of enabledPlugins) {
    const contract = resolveLoadContract(plugin.manifest);
    contracts.set(plugin.id, contract);

    for (const item of contract.issues) {
      const where = item.index >= 0 ? `${item.kind}[${item.index}]` : item.kind;
      const text = `[pluginRuntime] 插件 "${plugin.id}" 的清单：${where} ${item.message}`;
      if (item.level === 'error') console.error(text);
      else console.warn(text);
    }

    if (!contract.declarative) continue;

    for (const contribution of contract.contributions.modules) {
      registerDynamicModule(buildDeclaredModuleDescriptor(plugin, contribution), plugin.id);
    }
    registerDeclaredCommands(plugin.id, contract.contributions.commands);
    registerPluginSettings(plugin.id, contract.contributions.settings);
  }

  // 设置值要读回来，插件的 `ctx.settings.get()` 才是同步可用的。
  // 与插件代码一样是异步的，但**必须先于激活完成** —— 因此它在这里 await，
  // 而不是丢进后台。声明了设置项的插件通常不多，代价可控。
  await Promise.all(
    enabledPlugins.map((plugin) =>
      loadPluginSettingValues(plugin.id, getPluginSettingContributions(plugin.id))
    )
  );

  // 移除列表中已不存在或已禁用的插件资源
  const activeIds = new Set(enabledPlugins.map((p) => p.id));
  for (const pluginId of [...injectedAssets.keys()]) {
    if (!activeIds.has(pluginId)) {
      cleanupInjected(pluginId);
      cleanupPluginResources(pluginId);
      loadStates.delete(pluginId);
    }
  }
  for (const pluginId of [...contracts.keys()]) {
    if (!activeIds.has(pluginId)) {
      contracts.delete(pluginId);
      unregisterPluginSettings(pluginId);
    }
  }

  // 需要**立刻**执行代码的只有两类：旧式插件，以及声明式里标了 eager 的
  // （`onStartup`，或没有可用激活事件时的降级）。其余插件的 bundle 一直等到
  // 它被真正用到 —— 这正是「500 个插件」与「500 段代码在启动后全部执行」
  // 不再是同一件事的地方。
  const eager = enabledPlugins.filter((plugin) => contracts.get(plugin.id)?.eager !== false);
  const lazyCount = enabledPlugins.length - eager.length;
  const total = eager.length;

  onProgress?.(
    0,
    total,
    enabledPlugins.length === 0
      ? '没有已启用的插件'
      : `发现 ${enabledPlugins.length} 个已启用插件` +
          (lazyCount > 0 ? `，其中 ${lazyCount} 个按需激活` : '')
  );

  // 只取清单：不执行任何插件 bundle。
  // 供「插件延后加载」使用 —— 启动阶段先知道有哪些插件，
  // 真正的执行推迟到应用可用之后（见 loadPluginsInBackground）。
  if (options.listOnly) {
    notify();
    return installed;
  }

  let done = 0;
  for (const plugin of eager) {
    await loadPlugin(plugin, options.timeoutMs);
    done += 1;
    const name = plugin.manifest.displayName || plugin.id;
    const failed = loadStates.get(plugin.id)?.status === 'error';
    onProgress?.(done, total, failed ? `${name}（加载失败）` : name);
  }

  // 执行过的插件要记成"已激活"，否则 `getActivationState()` 会显示成从未激活
  for (const plugin of eager) {
    const state = loadStates.get(plugin.id);
    if (!state) continue;
    activationStates.set(plugin.id, {
      pluginId: plugin.id,
      status: state.status === 'loaded' ? 'active' : 'failed',
      reason: contracts.get(plugin.id)?.declarative ? 'onStartup' : 'legacy',
      activatedAt: state.loadedAt,
      error: state.error,
    });
  }

  notify();
  return installed;
}

/** 插件运行时加载结果（供后台加载汇报） */
export interface PluginLoadSummary {
  /** 已启用的插件数 */
  total: number;
  /** 本次真正执行了代码的插件数 */
  loaded: number;
  /** 排队等待激活的插件数（声明式且没有 onStartup） */
  lazy: number;
  /** 失败的插件 ID 与原因 */
  failures: Array<{ pluginId: string; name: string; error: string }>;
}

/**
 * 错峰读取插件图标。
 *
 * 为什么不在建立目录时顺手读：那会产生「插件数 × 一次 IPC」的尖峰 ——
 * 500 个插件就是 500 次读盘，而它们要等到侧边栏真的画出来才有用。放在这里
 * 让出事件循环，界面先可用，图标随后逐个补上（`setModuleIconSvg` 会通知目录）。
 *
 * 只处理**声明式且尚未激活**的插件：已经激活的插件在 `prefetchPluginIcon`
 * 里读过了 —— 那条路径必须同步读好，因为 `registerModule()` 在 bundle 顶层
 * 就要把 `iconSvg` 写进描述符。
 */
async function prefetchDeclaredIcons(): Promise<void> {
  const targets = installed.filter((plugin) => {
    if (!plugin.enabled || plugin.status === 'error') return false;
    const contract = contracts.get(plugin.id);
    if (!contract?.declarative) return false;
    if (pluginIcons.has(plugin.id)) return false;
    return iconIsSvgFile(plugin.manifest.icon);
  });

  if (targets.length === 0) return;

  for (const plugin of targets) {
    await prefetchPluginIcon(plugin);
    const svg = pluginIcons.get(plugin.id);
    if (!svg) continue;
    for (const contribution of contracts.get(plugin.id)?.contributions.modules ?? []) {
      setModuleIconSvg(contribution.id, svg);
    }
    // 让出事件循环：图标不在关键路径上，不该和用户交互抢同一个任务
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 后台加载插件运行时（不阻塞启动流程）。
 *
 * 为什么需要它：插件 bundle 是第三方代码，几十个插件串行执行会明显拖长
 * 「窗口出现 → 可用」的时间，而插件对核心功能并非必需。
 * 因此默认策略是：先让应用可用（启动步骤把插件标为「已延后」），
 * 随后在空闲时加载插件；加载过程中每完成一个都会通过 moduleCatalog
 * 的通知机制实时出现在侧边栏，不需要用户做任何操作。
 *
 * 返回一个 Promise，调用方可选择 await（例如用户手动点「重新加载插件」），
 * 也可以完全不管（启动路径就是这么做的）。
 */
let backgroundLoad: Promise<PluginLoadSummary> | null = null;

export function loadPluginsInBackground(options: { timeoutMs?: number } = {}): Promise<PluginLoadSummary> {
  // 去重：重入时复用同一次加载，避免重复执行插件 bundle
  if (backgroundLoad) return backgroundLoad;

  const run = async (): Promise<PluginLoadSummary> => {
    const summary: PluginLoadSummary = { total: 0, loaded: 0, lazy: 0, failures: [] };
    // 让目录进入「加载中」：此时打不开的插件模块应显示「等待插件」
    // 而不是「模块不存在」。
    setPluginCatalogLoading(true);
    try {
      // 第一步：清单 → 贡献目录（**不执行任何插件代码**），顺带执行其中
      // 需要立刻跑的那部分（旧式插件与 onStartup）。
      await reloadPluginRuntime(undefined, options);

      // 第二步：错峰补齐图标。它不是关键路径，放在目录建立之后。
      await prefetchDeclaredIcons();

      const states = getLoadStates();
      const enabled = installed.filter((p) => p.enabled && p.status !== 'error');
      summary.total = enabled.length;
      for (const plugin of enabled) {
        const state = states.get(plugin.id);
        if (state?.status === 'loaded') {
          summary.loaded += 1;
        } else if (state?.status === 'error') {
          summary.failures.push({
            pluginId: plugin.id,
            name: plugin.manifest.displayName || plugin.id,
            error: state.error ?? '未知错误',
          });
        } else if (contracts.get(plugin.id) && !contracts.get(plugin.id)?.eager) {
          // 既没执行也没失败：它正等着被用到。这是正常状态，不是问题。
          summary.lazy += 1;
        }
      }
      console.info(
        `[pluginRuntime] 后台插件加载完成：${summary.loaded}/${summary.total} 已执行` +
          (summary.lazy > 0 ? `，${summary.lazy} 个按需激活` : '') +
          (summary.failures.length > 0 ? `，${summary.failures.length} 个失败` : '')
      );
    } catch (error) {
      // 整体失败（例如后端不可用）：记录但不抛出 —— 这是后台任务，
      // 抛出去只会变成一条无人处理的 unhandled rejection。
      console.error('[pluginRuntime] 后台加载插件失败:', error);
      summary.failures.push({
        pluginId: '*',
        name: '插件运行时',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPluginCatalogLoading(false);
      backgroundLoad = null;
    }
    return summary;
  };

  backgroundLoad = run();
  return backgroundLoad;
}

// 说明：原先这里还有一个 initPluginRuntime()，负责「首次启动注入宿主 API 并加载插件」。
// 启动流程统一收敛到 src/services/boot.ts 之后它就是重复入口了，因此删除；
// 插件加载现在是 boot 管线里的 plugins 步骤（非关键步骤，失败只记告警不阻塞启动）。

// ============================================================
// 供插件管理页使用的生命周期封装
// ============================================================

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await invoke('set_plugin_enabled', { id: pluginId, enabled });
  await reloadPluginRuntime();
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  unloadPlugin(pluginId);
  await invoke('uninstall_plugin', { id: pluginId });
  await reloadPluginRuntime();
}

export async function installPluginFromPackage(path: string): Promise<InstalledPlugin> {
  const plugin = await invoke<InstalledPlugin>('install_plugin_package', { path });
  await reloadPluginRuntime();
  return plugin;
}

export async function installPluginFromFolder(path: string): Promise<InstalledPlugin> {
  const plugin = await invoke<InstalledPlugin>('install_plugin_folder', { path });
  await reloadPluginRuntime();
  return plugin;
}

export async function installPluginFromUrl(url: string): Promise<InstalledPlugin> {
  const plugin = await invoke<InstalledPlugin>('install_plugin_url', { url });
  await reloadPluginRuntime();
  return plugin;
}
