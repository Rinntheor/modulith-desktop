// src/hooks/useModuleActive.ts
//
// 「这个模块现在真的对用户可见吗」
//
// 与 `useModuleRuntime().isActiveTab` 的区别：那个只回答「标签是否被选中」。
// 窗口最小化、切到别的应用时，选中的标签依然「被选中」，但没人在看它。
// 需要决定「要不要暂停轮询 / 停止动画 / 推迟耗时更新」时，问的应该是这个。
//
// 为什么由模块主动询问，而不是宿主统一暂停：
// JS 里宿主拿不到模块创建的 `setTimeout` / `setInterval` / `fetch` 句柄，
// 无法可靠地暂停它们（重写全局定时器会影响所有代码，包括宿主自己与 React）。
// 所以宿主提供的是**感知能力**，由模块决定怎么用。对插件而言，这是它能否
// 「在后台乖乖待着」的唯一依据。

import { useEffect, useState } from 'react';
import { useModuleRuntime } from '../contexts/ModuleRuntimeContext';

/**
 * 当前文档是否可见（窗口是否没被最小化 / 隐藏）。
 *
 * 用 `document.visibilityState` 而不是窗口的 focus 状态：失去焦点（例如用户
 * 点开了别的窗口）时界面仍然可见，把它当成「不可见」会让模块停掉用户其实看
 * 得到的更新。
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleChange = () => setVisible(document.visibilityState !== 'hidden');
    // 订阅时先同步一次：订阅建立之前状态可能已经变了
    handleChange();

    document.addEventListener('visibilitychange', handleChange);
    return () => document.removeEventListener('visibilitychange', handleChange);
  }, []);

  return visible;
}

/**
 * 该模块当前是否真的对用户可见。
 *
 * 用法（模块内部）：
 * ```ts
 * const active = useModuleActive();
 * useEffect(() => {
 *   if (!active) return;          // 在后台就不起轮询
 *   const timer = setInterval(refresh, 30_000);
 *   return () => clearInterval(timer);
 * }, [active]);
 * ```
 */
export function useModuleActive(): boolean {
  const { isActiveTab } = useModuleRuntime();
  const documentVisible = useDocumentVisible();
  return isActiveTab && documentVisible;
}
