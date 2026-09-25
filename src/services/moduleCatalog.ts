// src/services/moduleCatalog.ts
//
// 统一模块目录：合并「构建期内置模块」与「运行时插件模块」。
//
// - 内置模块来自 scripts/generate-modules.ts 生成的静态注册表
// - 插件模块由 pluginRuntime 在加载已启用插件时动态注册进来
//
// 所有需要「完整模块列表」的地方（moduleManager / ModuleRenderer / 仪表盘 /
// 插件管理页）都应该读这里，而不是直接读 generated/moduleRegistry。

import { getModuleRegistry, getFlatModuleMap } from '../generated/moduleRegistry';
import type { ModuleDescriptor, SubModuleDescriptor } from '../types/module';

/** 动态注册的模块（插件提供） */
const dynamicModules = new Map<string, ModuleDescriptor>();

/** 模块 ID -> 提供它的插件 ID（内置模块不在其中） */
const moduleOwner = new Map<string, string>();

/**
 * 插件是否仍在加载中。
 *
 * 为什么需要这个标志：插件改为「后台加载」之后，用户可能在插件尚未注册
 * 模块时就打开它（例如「恢复上次打开的模块」正好是某个插件模块）。
 * 此时 ModuleRenderer 查不到描述符 —— 若不区分「还没加载完」与
 * 「真的不存在」，界面会先闪一下「Module Not Found」，体验很糟。
 */
let pluginsLoading = false;

/** 是否有插件模块正在后台加载 */
export function isPluginCatalogLoading(): boolean {
  return pluginsLoading;
}

/**
 * 标记插件目录进入 / 退出「加载中」。
 *
 * 由 pluginRuntime 在后台加载前后调用，触发一次目录变更通知，
 * 让正在显示「等待插件」状态的组件重新求值。
 */
export function setPluginCatalogLoading(loading: boolean): void {
  if (pluginsLoading === loading) return;
  pluginsLoading = loading;
  notifyCatalog();
}

/**
 * 目录变更订阅者。
 *
 * 插件是在应用启动「之后」才异步注册模块的，所以任何在启动时读过一次目录的
 * 组件（侧边栏、仪表盘）都必须能被通知到，否则会一直显示旧的模块列表——
 * 这正是「首次启动插件不出现在侧边栏」的根因。
 * moduleManager 会订阅这里并转发给自己的订阅者。
 */
const catalogListeners = new Set<() => void>();

/** 订阅目录变更（插件模块注册 / 注销时触发） */
export function subscribeCatalog(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => {
    catalogListeners.delete(listener);
  };
}

/**
 * 目录版本号：每次目录发生变化时 +1。
 *
 * 用途：给 `useMemo` / `useEffect` 提供一个内容无关的失效信号。
 * 直接依赖 `getDynamicModuleCount()` 是不可靠的（模块被替换时数量不变），
 * 而每次渲染都重新求值又会丢掉缓存，因此用版本号最直接。
 */
let catalogVersion = 0;

/** 当前目录版本号（变化即代表目录内容有更新） */
export function getCatalogVersion(): number {
  return catalogVersion;
}

function notifyCatalog(): void {
  catalogVersion += 1;
  catalogListeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[moduleCatalog] 订阅者执行出错:', err);
    }
  });
}

/** 内置模块 ID 集合，用于防止插件覆盖内置模块 */
function builtinIds(): Set<string> {
  const ids = new Set<string>();
  for (const mod of getModuleRegistry()) {
    ids.add(mod.id);
    if (mod.children) {
      for (const child of mod.children) ids.add(child.id);
    }
  }
  return ids;
}

/**
 * 注册一个插件提供的模块。
 *
 * @returns 注册成功返回 true；ID 非法、与内置模块或已注册模块冲突时返回 false
 */
export function registerDynamicModule(
  module: ModuleDescriptor,
  pluginId: string
): boolean {
  if (!module || typeof module.id !== 'string' || module.id.length === 0) {
    console.error('[moduleCatalog] 插件模块缺少合法的 id，已忽略');
    return false;
  }

  if (builtinIds().has(module.id)) {
    console.error(
      `[moduleCatalog] 插件 "${pluginId}" 试图注册模块 "${module.id}"，与内置模块冲突，已拒绝`
    );
    return false;
  }

  const existing = moduleOwner.get(module.id);
  if (existing && existing !== pluginId) {
    console.error(
      `[moduleCatalog] 模块 "${module.id}" 已被插件 "${existing}" 注册，拒绝插件 "${pluginId}" 的重复注册`
    );
    return false;
  }

  dynamicModules.set(module.id, module);
  moduleOwner.set(module.id, pluginId);
  notifyCatalog();
  return true;
}

/** 移除某个插件注册的所有模块（插件被禁用/卸载时调用） */
export function unregisterDynamicModules(pluginId: string): void {
  let changed = false;
  for (const [moduleId, owner] of [...moduleOwner.entries()]) {
    if (owner === pluginId) {
      dynamicModules.delete(moduleId);
      moduleOwner.delete(moduleId);
      changed = true;
    }
  }
  if (changed) notifyCatalog();
}

/**
 * 移除**一个**动态模块。
 *
 * 存在的理由是多界面：次级界面模块是按插件登记的，但它们的生命周期与
 * "清单里声明的模块"**不是同一件事** —— 后者在一个声明式插件被重新加载时
 * 必须留着（见 `loadPlugin` 里那段"声明式插件的条目来自清单，清掉就再也回不来"），
 * 而前者是宿主自己造的、随时可以去掉。
 *
 * 用 `unregisterDynamicModules(插件)` 来表达"去掉次级界面模块"就会顺手把清单
 * 里的模块也清掉 —— 而那正是 `check:plugin-runtime` 的"模块 ID 冲突"一节
 * 抓到的那个回归（`shadow-panel` 从目录里消失了）。
 *
 * 返回是否真的移除了。
 */
export function unregisterDynamicModule(moduleId: string): boolean {
  if (!dynamicModules.has(moduleId)) return false;
  dynamicModules.delete(moduleId);
  // 归属表也要一起清 —— 留着一条指向不存在模块的归属，会让下一次注册同一个
  // id 时被判成"已被别的插件占用"而遭到拒绝。
  const owner = moduleOwner.get(moduleId);
  if (owner !== undefined) moduleOwner.delete(moduleId);
  notifyCatalog();
  return true;
}

/**
 * 补上某个模块的内联 SVG 图标。
 *
 * 为什么需要「后补」这条路：声明式插件的模块条目在**读清单**时就建立了，
 * 那一刻只拿得到图标**路径**；而 SVG 的内容要通过 `read_plugin_asset` 异步读
 * （模块图标的渲染路径是同步的，见 `prefetchPluginIcon` 的说明）。
 *
 * 于是图标分两步：先建立条目（侧边栏立刻出现，用回退图标），随后在错峰的
 * 后台 pass 里逐个读回来补上。**这样启动时不产生「插件数 × 一次 IPC」的尖峰** ——
 * 而那正是「读清单即可建立完整界面」要保住的东西。
 *
 * 返回是否命中了一个已存在的模块：没命中（模块已被卸载）时调用方不必报错。
 */
export function setModuleIconSvg(moduleId: string, iconSvg: string): boolean {
  const module = dynamicModules.get(moduleId);
  if (!module || !iconSvg) return false;
  if (module.iconSvg === iconSvg) return false;

  dynamicModules.set(moduleId, { ...module, iconSvg });
  notifyCatalog();
  return true;
}

/** 清空全部动态模块（重新加载插件前调用） */
export function clearDynamicModules(): void {
  const changed = dynamicModules.size > 0;
  dynamicModules.clear();
  moduleOwner.clear();
  if (changed) notifyCatalog();
}

/** 某个插件当前注册了哪些模块 */
export function getPluginModuleIds(pluginId: string): string[] {
  const ids: string[] = [];
  for (const [moduleId, owner] of moduleOwner.entries()) {
    if (owner === pluginId) ids.push(moduleId);
  }
  return ids;
}

/** 是否为动态（插件提供）模块 */
export function isDynamicModule(moduleId: string): boolean {
  return dynamicModules.has(moduleId);
}

/** 提供该模块的插件 ID（内置模块返回 null） */
export function getModuleOwner(moduleId: string): string | null {
  return moduleOwner.get(moduleId) ?? null;
}

/**
 * 把「一个模块」解析为它在通知系统里可能对应的**全部**来源标识。
 *
 * 为什么需要这个映射：通知的 `source` 有两个来源 —— 宿主与内建模块用**模块 ID**，
 * 插件用**插件 ID**（`ctx.notifications` 只能知道自己是哪个插件，它注册的模块 ID
 * 是它自己起的，两者不同）。而侧边栏与标签栏的徽标是按**模块**查未读数的。
 *
 * 不做这层映射的后果很具体：插件推来的通知在通知中心里能看到，但它所属模块的
 * 标签与侧边栏项上**永远不显示未读徽标** —— 而徽标正是「事情来找你」的入口。
 *
 * 返回数组而非单个值，是因为一个模块可能同时按「模块 ID」和「插件 ID」两种
 * 来源收到通知（宿主也可以直接以模块 ID 为 source 推给它）。
 */
export function getNotificationSourcesFor(moduleId: string): string[] {
  const owner = getModuleOwner(moduleId);
  return owner && owner !== moduleId ? [moduleId, owner] : [moduleId];
}

/**
 * 把通知的 `source` 解析为「点击这条通知应该打开哪个模块」。
 *
 * 三种情况：
 *   * source 本身就是一个模块 ID（宿主与内建模块）→ 直接用它；
 *   * source 是插件 ID → 取该插件注册的**第一个**模块（插件可能注册多个，
 *     通知本身不携带「属于哪个模块」的信息，取第一个是当前能做到的最合理猜测）；
 *   * 两者都不是（插件已卸载、模块已隐藏）→ 返回 null，界面据此不显示跳转入口。
 *
 * 返回 null 时**不要**退回图标或 id 当作目标：那会打开一个不存在的标签。
 */
export function resolveNotificationTarget(source: string): string | null {
  if (!source) return null;

  const flat = getCatalogFlatMap();
  if (flat.has(source)) return source;

  const owned = getPluginModuleIds(source).filter((id) => flat.has(id));
  if (owned.length > 0) {
    // 按 priority 取最靠前的那个，与侧边栏顺序一致
    owned.sort((a, b) => (flat.get(a)?.priority ?? 0) - (flat.get(b)?.priority ?? 0));
    return owned[0];
  }

  return null;
}

/** 动态模块数量 */
export function getDynamicModuleCount(): number {
  return dynamicModules.size;
}

/**
 * 完整模块列表（内置 + 插件），按 priority 升序
 *
 * **`hidden` 的模块不在其中。** 它们是插件用 `ctx.ui.openSurface` 打开的次级
 * 界面：必须能按 id 开成标签，但不该出现在侧边栏、仪表盘或命令面板里 ——
 * 用户没有从那些地方打开它们的入口，列出来只会让人以为那是一堆独立模块。
 *
 * 需要"按 id 找得到"的地方走 `getCatalogFlatMap()`，那一份**不过滤**。
 */
export function getCatalogModules(): ModuleDescriptor[] {
  const merged = [
    ...getModuleRegistry(),
    ...[...dynamicModules.values()].filter((mod) => !mod.hidden),
  ];
  return merged.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
}

/**
 * 补上某个模块的徽标（`ctx.ui.badge` 走它）。
 *
 * 与 `setModuleIconSvg` 同一套路，理由也一样：侧边栏与标签栏渲染徽标是**同步**
 * 路径，而插件调用是一次异步广播。把值固化到描述符里，渲染端保持纯同步。
 *
 * 传 `null` 清掉。**返回是否真的变了** —— 调用方据此决定要不要通知订阅者；
 * 插件在每次轮询里都设同一个值是常见的，每次都 `notify` 会让整棵目录树重渲染。
 *
 * 语气只用来选一组颜色类名，**不参与任何判定** —— 它是插件的一句自我描述，
 * 而不是宿主需要理解的语义。白名单在 Rust 那一侧（`rpc.rs::badge_tone`）；
 * 这一层认不出来的语气一律落到 `info`。
 */
export function setModuleBadge(
  moduleId: string,
  badge: { text: string; tone: string } | null
): boolean {
  const module = dynamicModules.get(moduleId);
  if (!module) return false;

  const text = badge === null || badge.text === '' ? undefined : badge.text;
  const tone = text === undefined ? undefined : badge?.tone ?? 'info';

  if (module.badge === text && module.badgeTone === tone) return false;

  dynamicModules.set(moduleId, { ...module, badge: text, badgeTone: tone });
  notifyCatalog();
  return true;
}

/**
 * 补上某个模块的进度（`ctx.ui.progress` 走它）。
 *
 * 与徽标同一个理由：标签栏与侧边栏的渲染是**同步**路径。
 *
 * `value` 为 `null` 是**不定量**（转圈）；整个参数为 `null` 是"清掉"。
 * 这两种状态必须分得开 —— 它们在界面上的表现完全不同（一条来回跑的条 vs
 * 什么都没有），折成同一个值会让"我在忙"要么一直显示、要么从来不显示。
 */
export function setModuleProgress(
  moduleId: string,
  progress: { value: number | null; label?: string } | null
): boolean {
  const module = dynamicModules.get(moduleId);
  if (!module) return false;

  if (progress === null) {
    if (module.progress === undefined) return false;
    dynamicModules.set(moduleId, { ...module, progress: undefined });
    notifyCatalog();
    return true;
  }

  const current = module.progress;
  if (current && current.value === progress.value && current.label === progress.label) {
    return false;
  }

  dynamicModules.set(moduleId, {
    ...module,
    progress: { value: progress.value, label: progress.label },
  });
  notifyCatalog();
  return true;
}

/**
 * 完整扁平映射（含子模块），供 ModuleRenderer 路由解析使用
 */
export function getCatalogFlatMap(): Map<string, ModuleDescriptor> {
  const map = new Map<string, ModuleDescriptor>(getFlatModuleMap());

  for (const mod of dynamicModules.values()) {
    map.set(mod.id, mod);
    if (mod.children) {
      for (const child of mod.children) {
        if (!map.has(child.id)) {
          map.set(child.id, { ...child, children: undefined } as ModuleDescriptor);
        }
      }
    }
  }

  return map;
}

export type { SubModuleDescriptor };
