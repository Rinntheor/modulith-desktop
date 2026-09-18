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
// 插件 bundle 必须把 react / react-dom / react/jsx-runtime 标记为 external，
// 并映射到 window.Modulith.*，这样插件与宿主共用同一份 React（hooks/context 才能工作）。

import React from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { invoke } from '@tauri-apps/api/core';
import { createLazyComponent } from '../utils/lazyLoad';
import {
  clearDynamicModules,
  registerDynamicModule,
  setPluginCatalogLoading,
  unregisterDynamicModules,
  getPluginModuleIds,
} from './moduleCatalog';
import type { ModuleDescriptor } from '../types/module';
import type { PickedAudio } from '../types/plugin';
import { pushNotification, type NotificationLevel } from './notifications';
import { publish, subscribe, unsubscribeBySource, type EventHandler } from './eventBus';
import { registerCommand, unregisterCommandsByPrefix } from './commandRegistry';
import { useModuleActive } from '../hooks/useModuleActive';
import { isFileDropAvailable, subscribeFileDrop } from './fileDrop';
import { clearModuleComponentCache } from './moduleComponentCache';

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
  sandboxLevel?: number;
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

function pluginLogger(pluginId: string) {
  const prefix = `[plugin:${pluginId}]`;

  return {
    debug: (msg: string, ...args: unknown[]) => console.debug(prefix, msg, ...args),
    info: (msg: string, ...args: unknown[]) => console.info(prefix, msg, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn(prefix, msg, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(prefix, msg, ...args),
    trace: (label: string) => {
      const start = performance.now();
      return () => console.debug(`${prefix} ${label}: ${(performance.now() - start).toFixed(1)}ms`);
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

  const descriptor: ModuleDescriptor = {
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

  registerCommand({
    id: `plugin:${pluginId}:${command.id}`,
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
 * 三样东西必须一起摘掉，否则插件被禁用/卸载后会留下指向失效代码的引用：
 *   * 图标 SVG 缓存；
 *   * 事件总线上的全部订阅（`unsubscribeBySource`）；
 *   * 它注册到命令注册表的命令（`unregisterCommandsByPrefix`）——
 *     留着的话搜索框里会出现指向已经不存在的能力的条目。
 */
function cleanupPluginResources(pluginId: string): void {
  pluginIcons.delete(pluginId);

  const removedSubscriptions = unsubscribeBySource(pluginId);
  const removedCommands = unregisterCommandsByPrefix(`plugin:${pluginId}:`);

  if (removedSubscriptions > 0 || removedCommands > 0) {
    console.info(
      `[pluginRuntime] 已清理插件 "${pluginId}" 的资源：事件订阅 ${removedSubscriptions} 个，命令 ${removedCommands} 条`
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

/** 插件的实际加载过程（不含超时控制） */
async function loadPluginInner(plugin: InstalledPlugin): Promise<PluginLoadState> {
  const pluginId = plugin.id;
  const manifest = plugin.manifest;

  // 允许重复加载：先清理旧资源与旧模块
  cleanupInjected(pluginId);
  cleanupPluginResources(pluginId);
  unregisterDynamicModules(pluginId);

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
    if (moduleIds.length === 0) {
      throw new Error(
        '插件已加载，但没有注册任何模块。请确认 bundle 调用了 Modulith.registerModule(...)'
      );
    }

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
    unregisterDynamicModules(pluginId);

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

  installed = await invoke<InstalledPlugin[]>('list_plugins');
  runtimeLoadedOnce = true;

  // 清空全部动态模块，避免残留已卸载插件注册的模块
  clearDynamicModules();

  // 作废已缓存的模块组件。**必须在这里做，而不是让调用方各自记得**：
  // 下面每个插件的 registerModule() 都会为同一模块 ID 造一个全新的懒加载
  // 组件（闭包指向新 bundle 里的函数），而 ModuleRenderer 命中缓存后就不会再
  // 看描述符里的新组件。漏掉这一步的表现是「插件改了、刷新了、界面没变」——
  // 也就是必须删掉插件重装才生效。统一放在重载入口，所有路径都被覆盖。
  clearModuleComponentCache();

  // 移除列表中已不存在或已禁用的插件资源
  const activeIds = new Set(
    installed.filter((p) => p.enabled && p.status !== 'error').map((p) => p.id)
  );
  for (const pluginId of [...injectedAssets.keys()]) {
    if (!activeIds.has(pluginId)) {
      cleanupInjected(pluginId);
      cleanupPluginResources(pluginId);
      loadStates.delete(pluginId);
    }
  }

  const pending = installed.filter((plugin) => plugin.enabled && plugin.status !== 'error');
  const total = pending.length;

  onProgress?.(0, total, total === 0 ? '没有已启用的插件' : `发现 ${total} 个已启用插件`);

  // 只取清单：不执行任何插件 bundle。
  // 供「插件延后加载」使用 —— 启动阶段先知道有哪些插件，
  // 真正的执行推迟到应用可用之后（见 loadPluginsInBackground）。
  if (options.listOnly) {
    notify();
    return installed;
  }

  let done = 0;
  for (const plugin of pending) {
    await loadPlugin(plugin, options.timeoutMs);
    done += 1;
    const name = plugin.manifest.displayName || plugin.id;
    const failed = loadStates.get(plugin.id)?.status === 'error';
    onProgress?.(done, total, failed ? `${name}（加载失败）` : name);
  }

  notify();
  return installed;
}

/** 插件运行时加载结果（供后台加载汇报） */
export interface PluginLoadSummary {
  /** 尝试加载的插件数 */
  total: number;
  /** 成功加载的插件数 */
  loaded: number;
  /** 失败的插件 ID 与原因 */
  failures: Array<{ pluginId: string; name: string; error: string }>;
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
    const summary: PluginLoadSummary = { total: 0, loaded: 0, failures: [] };
    // 让目录进入「加载中」：此时打不开的插件模块应显示「等待插件」
    // 而不是「模块不存在」。
    setPluginCatalogLoading(true);
    try {
      await reloadPluginRuntime(undefined, options);
      const states = getLoadStates();
      const enabled = installed.filter((p) => p.enabled);
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
        }
      }
      console.info(
        `[pluginRuntime] 后台插件加载完成：${summary.loaded}/${summary.total} 成功` +
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
