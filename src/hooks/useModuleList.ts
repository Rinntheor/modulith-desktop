// src/hooks/useModuleList.ts

import { useState, useEffect, useCallback } from 'react';
import { moduleManager } from '../services/moduleManager';
import type { ModuleDescriptor } from '../types/module';

/**
 * 订阅模块列表变化的 Hook
 *
 * 数据源是 moduleManager，它已订阅 moduleCatalog：
 * 插件模块在启动后异步注册时，目录会通知 moduleManager，moduleManager 再通知这里。
 *
 * 之前这里用 `useState([])` + 挂载后 refresh，问题是「订阅完成」与「首次拉取」
 * 之间存在竞态：如果插件恰好在那个间隙里注册完成，通知会被丢掉，
 * 侧边栏就会一直停在旧列表上（表现为必须去设置里打开插件页才看得到插件）。
 * 现在初始值在首次渲染时同步取值，并且订阅建立后会立刻补一次同步，
 * 不再依赖某个时刻恰好存在的订阅。
 */

export function useModuleList() {
  const [modules, setModules] = useState<ModuleDescriptor[]>(() =>
    moduleManager.getActiveModules()
  );
  const [hiddenModules, setHiddenModules] = useState<ModuleDescriptor[]>(() =>
    moduleManager.getHiddenModules()
  );
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => {
    setModules(moduleManager.getActiveModules());
    setHiddenModules(moduleManager.getHiddenModules());
  }, []);

  // 订阅 moduleManager 的变更通知（含插件模块注册 / 注销的转发）
  useEffect(() => {
    // 订阅建立前可能已经发生过变化，先补一次同步，确保不漏事件
    setModules(moduleManager.getActiveModules());
    setHiddenModules(moduleManager.getHiddenModules());

    const unsubscribe = moduleManager.subscribe(() => {
      setVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  // 有变更时才重新拉取（只在 version 变化时执行）
  useEffect(() => {
    if (version === 0) return;
    refresh();
  }, [refresh, version]);

  return {
    modules,
    hiddenModules,
    refresh: refresh,
  };
}
