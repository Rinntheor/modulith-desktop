// src/services/pluginSurfaces.ts
//
// 多界面（`api: 3`）在**前端**这一侧的全部接线。
//
// ============================================================
// 为什么需要一个前端模块，而不是宿主自己把界面开出来
// ============================================================
//
// 沙箱插件的界面是一块**原生子 webview**，而它的位置与尺寸只有前端知道：
// 只有前端知道标签栏多高、侧边栏是否展开、分屏开没开。宿主那一侧建 webview
// 就只能自己猜一个矩形，而猜出来的界面会漂在某个不对的地方（或者在窗口外）。
//
// 因此 `ctx.ui.openSurface('detail')` 走的是这样一圈：
//
//   插件 → RPC → 宿主广播 `modulith://open-surface`
//        → **这里**开一个标签 → 标签里的占位量出矩形
//        → `sandbox_surface_open(插件, 界面, 矩形)` → 宿主建 webview
//
// 也就是方案 §5 那一行注释说的：**位置由宿主决定，插件只说要哪一个界面。**
//
// ============================================================
// 为什么要给界面凭空造一个"模块"
// ============================================================
//
// 标签、保活、驻留淘汰、分屏全都建立在"模块 id"之上（见 `tabStore`）。
// 一个次级界面如果能开成标签，它就必须有一个模块 id —— 否则上面那一整套
// 都要为它开第二条路径，而两条路径一定会漂。
//
// 因此次级界面被登记成一个 **`hidden` 的模块**：能按 id 打开、能进标签、
// 能被淘汰，但**不出现在侧边栏 / 仪表盘 / 命令面板里**（见 `moduleCatalog`
// 的 `getCatalogModules`）。用户没有从那些地方打开它的入口，列出来只会让人
// 以为那是一堆独立模块。
//
// ============================================================
// 界面列表从哪来
// ============================================================
//
// 从**宿主**（`plugin_surfaces` 命令），不是前端自己解析 `contributes.surfaces`。
// 那份解析在 Rust 侧还要挡"入口路径越界""缺主界面""id 冲突"，前端再实现一遍
// 只会多出一套会漂的规则 —— 而漂开的方向是"宿主认为有两个界面、前端只登记了
// 一个"，症状是某个界面点了没反应。这条分工与 `plugin_background_contribution`
// 完全一致。

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import React from 'react';

import { registerDynamicModule, unregisterDynamicModule } from './moduleCatalog';
import { closeTab, openTab } from './tabStore';
import type { ModuleDescriptor } from '../types/module';

/** 插件请求打开一个界面（由 `rpc.rs::OPEN_SURFACE` 发出） */
export const OPEN_SURFACE = 'modulith://open-surface';

/** 插件请求关闭一个界面（由 `rpc.rs::CLOSE_SURFACE` 发出） */
export const CLOSE_SURFACE = 'modulith://close-surface';

/** 宿主侧读出来的界面声明（`plugin_surfaces` 命令的返回） */
export interface DeclaredSurface {
  id: string;
  name: string;
  /** 是不是主界面（不带 `#` 的那条 webview 标签） */
  primary: boolean;
}

/** `open-surface` / `close-surface` 事件的载荷 */
interface SurfaceRequest {
  pluginId: string;
  surface: string;
  /** 发起请求时插件自己所在的界面，`null` / 缺省 = 后台插件（它没有界面） */
  source?: string | null;
}

/**
 * 次级界面对应的**模块 id**。
 *
 * 形状是 `plugin:<插件 id>#<界面 id>`。前面加 `plugin:` 是为了与清单里声明的
 * 模块 id 不可能撞上 —— 那个形状由 `MODULE_ID_RE` 限制在字母数字与 `._-`，
 * 而冒号与 `#` 都在它之外。这一条是真的重要：撞上的表现是两个界面互相覆盖。
 */
export function surfaceModuleId(pluginId: string, surface: string): string {
  return `plugin:${pluginId}#${surface}`;
}

/** 从模块 id 反解出 `(插件 id, 界面 id)`；不是次级界面时返回 `null` */
export function parseSurfaceModuleId(
  moduleId: string
): { pluginId: string; surface: string } | null {
  if (!moduleId.startsWith('plugin:')) return null;
  const at = moduleId.indexOf('#');
  if (at < 0) return null;
  return {
    pluginId: moduleId.slice('plugin:'.length, at),
    surface: moduleId.slice(at + 1),
  };
}

/**
 * 占位组件。
 *
 * **它永远不会被渲染。** `ModuleRenderer` 看见 `sandboxed` 就换成一块空地，
 * 由 `SandboxSurface` 去建真正的 webview。给一个真组件反而危险 —— 将来某处
 * 少判了 `sandboxed`，一个假界面会安静地画出来，而所有人都会以为沙箱生效了。
 */
const NeverRendered: React.FC = () => null;

/**
 * 已登记的次级界面模块：`模块 id → 插件 id`。
 *
 * 单独记一份的理由：`ui.openSurface` 必须能分辨"这个界面有一个可打开的模块"
 * 与"这个界面没有"。没有的话它要么静默什么都不做，要么去开一个不存在的模块
 * 而 `openTab` 会弹一句"模块不存在"—— 那是给用户看的提示，而这里只是一次
 * 指向主界面的、完全正常的请求。
 */
const surfaceModules = new Map<string, string>();

/** 某个插件当前登记了哪些次级界面模块 */
export function registeredSurfaceModuleIds(pluginId: string): string[] {
  const ids: string[] = [];
  for (const [moduleId, owner] of surfaceModules) {
    if (owner === pluginId) ids.push(moduleId);
  }
  return ids;
}

/**
 * 把一个插件声明的**次级**界面登记成 `hidden` 模块。
 *
 * 主界面**不登记**：它已经由清单里 `contributes.modules` 里的某一条代表了
 * （那条会出现在侧边栏）。再登记一个隐藏的同界面模块的话，
 * `ui.openSurface('main')` 会打开那一个，于是同一个界面在两个标签里各开一个
 * webview —— 而 WebView2 的标签是唯一的，第二个会被宿主判成标签冲突，
 * 用户看到的是"点了没反应"。
 *
 * `claimed` 是被声明模块占用的界面 id 集合。之所以也要排掉它们：一个次级界面
 * 完全可以同时有一个侧边栏入口（"详情"既能从列表里点开，也能从侧边栏直接进），
 * 那时该打开的是那个可见的模块，而不是再开一个同界面的隐藏标签。
 */
export function registerSurfaceModules(
  pluginId: string,
  surfaces: DeclaredSurface[],
  claimed: Set<string>
): void {
  for (const surface of surfaces) {
    if (surface.primary) continue;
    if (claimed.has(surface.id)) continue;

    const moduleId = surfaceModuleId(pluginId, surface.id);

    const descriptor: ModuleDescriptor = {
      id: moduleId,
      name: surface.name,
      displayName: surface.name,
      description: '',
      icon: 'Package',
      path: `/plugins/${moduleId}`,
      priority: 1000,
      category: 'plugin',
      visible: false,
      disabled: false,
      component: React.lazy(async () => ({ default: NeverRendered })),
      pluginId,
      sandboxed: true,
      surface: surface.id,
      hidden: true,
    };

    // 登记失败**也要记账**吗？不要 —— 记了会让 `ui.openSurface` 去开一个
    // 目录里根本没有的模块，而那次 `openTab` 会弹一条"模块不存在"。
    // 失败的原因只有 id 冲突，而那是清单问题，上面会有日志。
    if (registerDynamicModule(descriptor, pluginId)) {
      surfaceModules.set(moduleId, pluginId);
    }
  }
}

/** 卸载某个插件的次级界面模块（插件被禁用 / 卸载 / 重载时） */
export function unregisterSurfaceModules(pluginId: string): void {
  for (const moduleId of registeredSurfaceModuleIds(pluginId)) {
    surfaceModules.delete(moduleId);
    // **逐个移除，而不是 `unregisterDynamicModules(插件)`。**
    // 后者会顺手把清单里声明的模块也清掉，而那些在声明式插件重新加载时必须
    // 留着（它们是"未激活时侧边栏也应该是完整的"这条保证的全部依据）。
    // 这个区别是被 `check:plugin-runtime` 的"模块 ID 冲突"一节抓出来的。
    unregisterDynamicModule(moduleId);
  }
}

/**
 * 清空**全部**次级界面模块的记账。
 *
 * `pluginRuntime` 在重载全部插件之前会 `clearDynamicModules()`，那一下把目录
 * 清空，而这张表如果留着重载前的条目，`ui.openSurface` 就会认为"这个界面有
 * 可打开的模块"，于是去开一个目录里已经不存在的 id —— `openTab` 会为它弹一句
 * "模块不存在"，而用户完全不知道那句话是从哪来的。
 */
export function clearSurfaceModules(): void {
  surfaceModules.clear();
}

/**
 * 某个插件声明的界面。**从宿主读**（见文件头）。
 *
 * 失败一律退化成空数组并记一条日志：拿不到界面表不该让整个插件加载失败 ——
 * 它的模块、命令、设置都还能用，只是多界面那部分不可用。
 */
export async function fetchDeclaredSurfaces(pluginId: string): Promise<DeclaredSurface[]> {
  try {
    const surfaces = await invoke<DeclaredSurface[]>('plugin_surfaces', { id: pluginId });
    return Array.isArray(surfaces) ? surfaces : [];
  } catch (error) {
    console.warn(`[pluginSurfaces] 读不到 ${pluginId} 的界面表:`, error);
    return [];
  }
}

// ============================================================
// 事件接线
// ============================================================

/** 打开一个界面（把一个隐藏模块开成标签）。 */
function openSurface(pluginId: string, surface: string): void {
  const moduleId = surfaceModuleId(pluginId, surface);

  if (!surfaceModules.has(moduleId)) {
    // 没有对应的隐藏模块 = 这个界面由 `contributes.modules` 里的某一条代表
    // （主界面通常是这样）。它不是错误，但宿主**无法**替插件决定"打开哪一个
    // 模块"，因此这里只能记一条，由插件自己用命令或深链去开。
    console.warn(
      `[pluginSurfaces] ${pluginId} 的界面 ${surface} 没有可打开的次级模块；` +
        '它多半是已经由 contributes.modules 声明过的主界面，请从侧边栏打开。'
    );
    return;
  }

  const result = openTab(moduleId);
  if (!result.ok) {
    console.warn(`[pluginSurfaces] 打开 ${pluginId} 的界面 ${surface} 失败：${result.reason}`);
  }
}

/** 关闭一个界面。没开着时 `closeTab` 本身就是静默的。 */
function closeSurface(pluginId: string, surface: string): void {
  closeTab(surfaceModuleId(pluginId, surface));
}

/**
 * 装上"插件请求打开 / 关闭界面"的监听。
 *
 * 返回退订函数。订阅失败时返回一个空的退订函数 —— 多界面不可用不该让整个启动
 * 路径抛异常（那会连带影响别的启动步骤）。
 */
export function installPluginSurfaceRequests(): () => void {
  const unlisteners: UnlistenFn[] = [];
  let disposed = false;

  void (async () => {
    try {
      const stopOpen = await listen<SurfaceRequest>(OPEN_SURFACE, (event) => {
        const payload = event.payload;
        if (!payload?.pluginId || !payload.surface) return;
        openSurface(payload.pluginId, payload.surface);
      });
      const stopClose = await listen<SurfaceRequest>(CLOSE_SURFACE, (event) => {
        const payload = event.payload;
        if (!payload?.pluginId || !payload.surface) return;
        closeSurface(payload.pluginId, payload.surface);
      });

      if (disposed) {
        stopOpen();
        stopClose();
        return;
      }
      unlisteners.push(stopOpen, stopClose);
    } catch (error) {
      console.warn('[pluginSurfaces] 无法订阅界面请求（多界面将不可用）:', error);
    }
  })();

  return () => {
    disposed = true;
    for (const stop of unlisteners) stop();
  };
}
