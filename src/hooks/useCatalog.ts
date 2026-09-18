// src/hooks/useCatalog.ts
//
// 订阅模块目录（内建 + 插件注册的动态模块），并派生常用的查询。
//
// 为什么要有它：`getCatalogFlatMap()` 是普通函数，直接调用不会让组件在目录
// 变化时重新渲染。插件模块是启动后异步注册的，任何在启动时读过一次目录的
// 组件都必须能被通知到 —— 否则会一直显示旧的模块列表（这正是「插件装好了但
// 侧边栏看不到」的根因，见 useModuleList 的说明）。
//
// 用目录版本号做失效信号，而不是动态模块数量：插件替换同名模块时数量不变，
// 只有版本号能反映内容已变。

import { useEffect, useMemo, useState } from 'react';
import {
  getCatalogFlatMap,
  getCatalogVersion,
  subscribeCatalog,
} from '../services/moduleCatalog';
import type { ModuleDescriptor } from '../types/module';

/** 订阅整个目录的扁平映射（含子模块） */
export function useCatalog(): Map<string, ModuleDescriptor> {
  const [version, setVersion] = useState(() => getCatalogVersion());

  useEffect(() => subscribeCatalog(() => setVersion(getCatalogVersion())), []);

  return useMemo(() => getCatalogFlatMap(), [version]);
}

/** 解析单个模块的描述符；不存在时返回 undefined */
export function useModuleDescriptor(moduleId: string | null): ModuleDescriptor | undefined {
  const catalog = useCatalog();
  return moduleId ? catalog.get(moduleId) : undefined;
}
