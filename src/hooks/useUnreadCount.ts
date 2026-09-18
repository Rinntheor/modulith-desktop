// src/hooks/useUnreadCount.ts
//
// 订阅「某个模块的未读通知数」。
//
// 有两个容易写错的地方，这里都处理了：
//
//   1. **必须把插件 ID 也算进来。** 通知的 `source` 有两个来源：宿主与内建模块
//      用模块 ID，插件用插件 ID（`ctx.notifications` 只知道自己是哪个插件）。
//      而徽标是按模块显示的。不做这层映射，插件推来的通知在通知中心里看得到，
//      但它所属模块的标签与侧边栏项上**永远不显示徽标** —— 而徽标正是
//      「事情来找你」的入口。映射见 moduleCatalog 的 getNotificationSourcesFor。
//
//   2. **必须在订阅建立之前先同步一次。** 通知可能在「组件首次渲染」与
//      「effect 里的订阅」之间到达（插件的通知就是在应用可用之后异步推来的），
//      不补这一次同步就会漏掉它，徽标一直不出现 —— 与本项目在 useModuleList
//      上踩过的竞态同类。
//
// 只返回数字而不是整个通知列表：列表变化会让所有调用方重新渲染，
// 而它们只关心自己那个数字。

import { useEffect, useMemo, useState } from 'react';
import { getUnreadCountForSource, subscribeNotifications } from '../services/notifications';
import { useCatalog } from './useCatalog';
import { getNotificationSourcesFor } from '../services/moduleCatalog';

/** 把模块 ID 展开为它在通知系统里可能对应的全部来源 */
function expandSources(moduleIds: string[]): string[] {
  const result: string[] = [];
  for (const id of moduleIds) {
    if (!id) continue;
    for (const source of getNotificationSourcesFor(id)) {
      if (!result.includes(source)) result.push(source);
    }
  }
  return result;
}

function sumUnread(sources: string[]): number {
  return sources.reduce((sum, source) => sum + getUnreadCountForSource(source), 0);
}

export function useUnreadCount(moduleId: string): number {
  return useUnreadCountFor(moduleId ? [moduleId] : []);
}

/**
 * 订阅一组模块的未读总数（用于「父模块 + 它的子模块」这种聚合）。
 *
 * 依赖目录：插件的模块归属只有在插件注册之后才成立（`getModuleOwner` 依赖
 * `moduleOwner` 表）。如果不在目录变化时重新解析，一个在启动后异步注册的插件
 * 会永久丢失它的徽标 —— 因为 effect 的依赖（模块 ID）并没有变。
 */
export function useUnreadCountFor(moduleIds: string[]): number {
  const catalog = useCatalog();

  // 目录变化时重新展开来源；用 catalog 作为依赖是刻意的
  const sources = useMemo(
    () => expandSources(moduleIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [moduleIds.join('|'), catalog]
  );

  // 用 join 生成稳定键：调用方通常内联构造数组，直接依赖数组引用会让 effect 每帧重建
  const key = sources.join('|');

  const [count, setCount] = useState(() => sumUnread(sources));

  useEffect(() => {
    const targets = key ? key.split('|') : [];
    if (targets.length === 0) {
      setCount(0);
      return;
    }

    const sync = () => setCount(sumUnread(targets));
    sync();
    return subscribeNotifications(sync);
  }, [key]);

  return count;
}
