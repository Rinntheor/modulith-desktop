// src/types/module.ts

import type { ComponentType, LazyExoticComponent } from 'react';

export interface SubModuleDescriptor {
  id: string;
  name: string;
  description: string;
  icon?: string;
  path: string;
  badge?: string;
  disabled: boolean;
  component: LazyExoticComponent<ComponentType<any>>;
  /** 见 `ModuleDescriptor.pluginId` */
  pluginId?: string;
  /** 见 `ModuleDescriptor.iconSvg` */
  iconSvg?: string;
}

export interface ModuleDescriptor {
  id: string;
  name: string;
  displayName?: string;
  description: string;
  icon: string;
  path: string;
  priority: number;
  category?: string;
  visible: boolean;
  disabled: boolean;
  badge?: string;
  component: LazyExoticComponent<ComponentType<any>>;
  children?: SubModuleDescriptor[];
  /**
   * 提供该模块的插件 ID（内置模块为 undefined）。
   *
   * 用途有两个，都只有插件模块才需要：
   *   1. 图标是相对插件目录的路径时（例如 `icon.svg`），要据此去插件包内读取；
   *   2. 注册时的错误/日志可以标注来源。
   */
  pluginId?: string;
  /**
   * 已解析的内联 SVG 源码（`<svg …>` 字符串）。
   *
   * 为什么在注册时就把 SVG 读出来存进描述符，而不是渲染时再 invoke：
   * 侧边栏与仪表盘渲染图标是**同步**路径，而 invoke 是异步的 ——
   * 若在渲染时拉取，就必须给每个图标套 Suspense，且首帧必然是空框。
   * 插件是应用启动时一次性加载的，此刻读取成本可以忽略，
   * 因此把结果固化到描述符里，渲染端保持纯同步。
   */
  iconSvg?: string;
  /**
   * 这个模块的界面跑在一个**独立 webview** 里（插件清单写了 `runtime: "sandboxed"`）。
   *
   * 有它时 `component` 不再被渲染 —— `ModuleRenderer` 改为渲染一块占位，
   * 由 `SandboxSurface` 把它量出来交给 Rust，让宿主把 webview 摆在那个位置。
   *
   * 为什么不干脆不给 `component`：描述符的形状保持统一，调用方少一堆分支；
   * 而且旧式插件仍走 `component` 那条路，两者要能共存。
   */
  sandboxed?: boolean;
  /**
   * 这个沙箱模块对应插件清单里的**哪一个界面**（`contributes.surfaces[].id`）。
   *
   * 缺省是主界面。`SandboxSurface` 靠它决定要向宿主请求 `plugin-<id>#<界面>`
   * 里的哪一个 —— 少了它，同一插件的两个界面会去抢同一条标签。
   */
  surface?: string;
  /**
   * **不进任何模块列表**，但可以被按 id 打开。
   *
   * 用途只有一个：插件用 `ctx.ui.openSurface('detail')` 打开的次级界面。
   * 它们必须能开成标签（那正是"宿主决定位置"的实现），但**不该**出现在侧边栏、
   * 仪表盘或命令面板里 —— 用户没有从那里打开它们的入口，而列出来会让人以为
   * 那是一堆独立的模块。
   *
   * 与 `visible: false` 的区别是刻意的：`visible: false` 仍然收进「隐藏模块」
   * 面板（用户能找到并固定出来），而 `hidden` 连那里都不进。
   */
  hidden?: boolean;
}

export interface ModuleTomlChild {
  id: string;
  name: string;
  description: string;
  icon?: string;
  path: string;
  badge?: string;
  disabled?: boolean;
  component: string;
}

export interface ModuleToml {
  module: {
    id: string;
    name: string;
    description: string;
    icon: string;
    path: string;
    priority?: number;
    category?: string;
    visible?: boolean;
    disabled?: boolean;
    badge?: string;
    component: string;
  };
  children?: ModuleTomlChild[];
}
