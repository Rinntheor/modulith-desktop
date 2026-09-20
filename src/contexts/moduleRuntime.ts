// src/contexts/moduleRuntime.ts
//
// 模块运行时上下文的**非 JSX 部分**：类型、context 本身、以及读取它的 Hook。
//
// 为什么与 `ModuleRuntimeContext.tsx`（Provider）分开：
//
//   1. **让插件运行时可以在没有构建步骤的环境里被加载。** `pluginRuntime` 经
//      `useModuleActive` 依赖到这里的 `useModuleRuntime`；而 Provider 是三行 JSX。
//      两者放在同一个 `.tsx` 里，就意味着"想在 Node 里跑一下插件运行时"必须先有
//      JSX 转换 —— 那正好挡住了稳定性夹具（见 `scripts/check-plugin-runtime.ts`）。
//   2. 职责本来就不同：这里只回答"我正在渲染的是谁、它可见吗"，Provider 负责
//      把这两个值放进 React 树。
//
// `ModuleRuntimeContext.tsx` 仍然导出同样的一组名字，因此既有 import 不需要改动。

import { createContext, useContext } from 'react';

export interface ModuleRuntime {
  /** 当前正在渲染的模块 ID */
  moduleId: string;
  /**
   * 该模块当前是否**可见**（位于某个可见的标签组里，且是那组的激活标签）。
   *
   * 名字是历史遗留：分屏之前「可见」与「被选中」是同一件事，因此那时叫
   * `isActiveTab` 是准确的。引入分屏后两者分开了 —— 宿主支持左右两个标签组，
   * 右组可见但没有键盘焦点。
   *
   * **宿主传进来的是「可见」，不是「有焦点」。** 模块用这个值决定要不要继续跑后台
   * 工作，而分屏时两组的激活标签都该正常活着；按焦点判定会让右组那个自作主张地
   * 停掉后台轮询，用户看到一个不会更新的面板，而且不会有任何报错。
   *
   * 注意它仍不代表「窗口是否可见」—— 窗口最小化时所有组都不可见。需要判断
   * 「是否真的没人在看」时用 `useModuleActive()`，它把两者合在一起。
   */
  isActiveTab: boolean;
}

/** 上下文本体。Provider 在 `ModuleRuntimeContext.tsx` 里 */
export const ModuleRuntimeContext = createContext<ModuleRuntime | null>(null);

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
