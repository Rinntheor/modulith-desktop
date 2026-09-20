// src/contexts/ModuleRuntimeContext.tsx
//
// 模块运行时上下文的 **Provider**（唯一需要 JSX 的那一部分）。
//
// 存在的理由：标签页保活之后，模块被切走后**不会卸载**，它的定时器、轮询与
// 订阅会照常运行。这对「切回来时状态还在」是必要的，但会造成后台模块持续
// 消耗资源、甚至在用户看不见的时候弹提示。
//
// 因此需要一个让模块自己判断「我现在是不是用户看得见的那个」的通道，
// 由模块决定要不要暂停自己的后台工作。宿主不强制停止模块的定时器 ——
// JS 里也没法可靠地做到这一点（拿不到模块创建的 timer 句柄），
// 所以这里提供的是**感知能力**，而不是**强制暂停**。这一点在文档中如实标注。
//
// 类型、context 与 `useModuleRuntime()` 在 `./moduleRuntime`（无 JSX）里 ——
// 那个文件是插件运行时依赖到的那一个，拆开的理由见它的文件头。

import React from 'react';
import { ModuleRuntimeContext } from './moduleRuntime';

export interface ModuleRuntimeProviderProps {
  moduleId: string;
  isActiveTab: boolean;
  children: React.ReactNode;
}

export const ModuleRuntimeProvider: React.FC<ModuleRuntimeProviderProps> = ({
  moduleId,
  isActiveTab,
  children,
}) => (
  <ModuleRuntimeContext.Provider value={{ moduleId, isActiveTab }}>
    {children}
  </ModuleRuntimeContext.Provider>
);

// 兼容再导出：既有调用方一直是从这个路径取 `useModuleRuntime` / `ModuleRuntime` 的，
// 拆分不应该让它们全部改 import。
export { ModuleRuntimeContext, useModuleRuntime } from './moduleRuntime';
export type { ModuleRuntime } from './moduleRuntime';
