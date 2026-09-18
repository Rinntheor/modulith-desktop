// src/contexts/ModuleRuntimeContext.tsx
//
// 模块运行时上下文：告诉「正在被渲染的这个模块」它是谁、现在是不是在前台。
//
// 存在的理由：标签页保活之后，模块被切走后**不会卸载**，它的定时器、轮询与
// 订阅会照常运行。这对「切回来时状态还在」是必要的，但会造成后台模块持续
// 消耗资源、甚至在用户看不见的时候弹提示。
//
// 因此需要一个让模块自己判断「我现在是不是用户看得见的那个」的通道，
// 由模块决定要不要暂停自己的后台工作。宿主不强制停止模块的定时器 ——
// JS 里也没法可靠地做到这一点（拿不到模块创建的 timer 句柄），
// 所以这里提供的是**感知能力**，而不是**强制暂停**。这一点在文档中如实标注。

import React, { createContext, useContext } from 'react';

export interface ModuleRuntime {
  /** 当前正在渲染的模块 ID */
  moduleId: string;
  /**
   * 该模块是否位于激活的标签页中。
   *
   * 注意这只代表「标签是否被选中」，不代表「窗口是否可见」——
   * 窗口最小化时所有标签都不可见。需要判断「是否真的没人在看」时，
   * 用 `useModuleActive()`，它把两者合在一起。
   */
  isActiveTab: boolean;
}

const ModuleRuntimeContext = createContext<ModuleRuntime | null>(null);

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

/**
 * 读取当前模块的运行时信息。
 *
 * 不在 Provider 内时返回一个**宽松的默认值**（`isActiveTab: true`）而不是抛错。
 * 理由：模块的组件也可能被渲染在标签页之外（例如插件在某个对话框里复用自己
 * 的组件）。那种场景下「假装自己在后台」会让模块错误地停掉工作，而「当作在
 * 前台」最多是浪费一点资源 —— 两种错误里后者安全得多。
 */
export function useModuleRuntime(): ModuleRuntime {
  const context = useContext(ModuleRuntimeContext);
  if (context) return context;
  return { moduleId: '', isActiveTab: true };
}
