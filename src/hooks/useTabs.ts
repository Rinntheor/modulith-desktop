// src/hooks/useTabs.ts
//
// 把 tabStore 接到 React 上。
//
// 没有为标签页单独建 Context：订阅是每个消费者各自建立的一次 `useState` +
// `useEffect`，实现更短，也不需要在组件树里再加一层 Provider。消费者只有
// 标签栏、侧边栏上下文、快捷键与命令注册表几处，彼此之间也不共享派生计算，
// 因此 Context 带来的收益不足以抵消它的样板代码。

import { useEffect, useState } from 'react';
import { getTabState, subscribeTabs, type TabState } from '../services/tabStore';

/** 订阅标签状态 */
export function useTabs(): TabState {
  const [state, setState] = useState<TabState>(getTabState);

  useEffect(() => subscribeTabs(() => setState(getTabState())), []);

  return state;
}
