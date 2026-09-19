// src/hooks/usePerformanceMode.ts
//
// 订阅「性能模式」与「有效动效开关」的 Hook。
//
// 为什么需要它：这两个开关要让**渲染**跟着变（例如性能模式下不再挂载那个
// 持续循环的装饰背景），而不只是让 CSS 规则生效。`services/theme.ts` 是它们的
// 权威来源，这里只负责在变化时触发重渲染。
//
// 两个 Hook 的区别：
//   * `usePerformanceMode()` —— 用户在设置里选的那个值；
//   * `useReduceMotion()` —— **有效**值（「关闭动画」或「性能模式」任一开启）。
//     需要判断「现在该不该放动画」时用它，而不是自己去读设置里的
//     `reduceMotion` —— 那会漏掉性能模式。

import { useEffect, useState } from 'react';

import { getPerformanceMode, getReduceMotion, subscribeTheme } from '../services/theme';

/** 性能模式是否开启 */
export function usePerformanceMode(): boolean {
  const [enabled, setEnabled] = useState(() => getPerformanceMode());

  useEffect(() => subscribeTheme(() => setEnabled(getPerformanceMode())), []);

  return enabled;
}

/** 动效是否应当停用（「关闭动画」与「性能模式」的并集） */
export function useReduceMotion(): boolean {
  const [enabled, setEnabled] = useState(() => getReduceMotion());

  useEffect(() => subscribeTheme(() => setEnabled(getReduceMotion())), []);

  return enabled;
}
