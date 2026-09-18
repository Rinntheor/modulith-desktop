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
