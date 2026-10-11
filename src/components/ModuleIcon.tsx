// src/components/ModuleIcon.tsx
//
// 模块图标的**唯一**渲染入口。
//
// 背景（这是一处真实缺陷的修复）：
//   侧边栏与仪表盘原先都是这么取图标的 ——
//
//     import * as Icons from '../../generated/iconMap';
//     const Icon = (Icons as any)[module.icon] || null;
//
//   `iconMap.ts` 由 scripts/generate-modules.ts 在**构建期**根据
//   src/modules/*/module.toml 生成，因此它只包含内置模块用到的图标。
//   插件模块是运行时注册的，它们的 `icon` 值根本不在这个映射里，于是：
//
//     * 插件写 lucide 图标名（`icon: 'StickyNote'`）→ 查不到 → 图标区域空白；
//     * 插件写图标文件路径（`icon: 'icon.svg'`，样例插件就是这么写的）
//       → 更查不到 → 依然空白。
//
//   而插件管理页里的插件卡片走的是 PluginIcon，那条路径支持 .svg 与内联 SVG，
//   所以「插件列表里图标正常、侧边栏与仪表盘里是空的」——正是用户观察到的现象。
//
// 现在的解析顺序（判定本身在 `moduleIconResolver.ts`，那里有逐条说明）：
//   1. 内联 SVG（描述符携带的 `iconSvg`，插件加载时已读取，见 pluginRuntime）；
//   2. 构建期映射表 `generated/iconMap`（内置模块，静态导入，零运行时成本）；
//   3. lucide 图标名 → 按需动态加载（覆盖插件注册的任意 lucide 图标）；
//   4. 兜底：lucide 的 Box 图标（保证永远不出现空白占位）。
//
// 为什么判定要抽到 `.ts` 里：本文件是 `.tsx`，而仓库的 check 脚本用 Node 跑 TS，
// Node 的类型擦除不转换 JSX —— 留在 `.tsx` 里的逻辑没法被任何脚本断言。
//
// **路径型 `icon`（`icon.svg`）不会走第 3 步去查 lucide**：它是插件包内的一个
// 文件，不是图标名；那张图只可能来自第 1 步的 `iconSvg`（宿主在目录建立后读好，
// 见 pluginRuntime 的 `prefetchDeclaredIcons`）。渲染路径是同步的，因此宿主没补上
// 时这里落 `Box` 兜底，绝不留空白。

import React, { Suspense, memo } from 'react';
import { Box } from 'lucide-react';
import { dynamicIconImports } from 'lucide-react/dynamic';
import * as BuiltinIcons from '../generated/iconMap';
import {
  isSvgMarkup,
  looksLikeAssetPath,
  resolveModuleIconSource,
  toKebabCase,
} from './moduleIconResolver';

/** lucide 图标组件的最小形状（只需要 className） */
type IconComponent = React.ComponentType<{ className?: string }>;

interface ModuleIconProps {
  /** 模块的 `icon` 字段：lucide 图标名、或插件包内的相对路径（`icon.svg`） */
  icon?: string;
  /**
   * 已解析的内联 SVG 源码（`<svg …>` 字符串）。
   *
   * 这是**路径型 `icon` 的唯一来源**，也是"插件模块显示插件自己的图标"的落点：
   * 宿主在目录建立后把插件包里的图标读进来写在这个字段上（`setModuleIconSvg`）。
   * 渲染路径是同步的，本组件因此不会自己发 IPC / 读文件。
   */
  iconSvg?: string;
  /** 模块显示名，仅用于无障碍标签 */
  name?: string;
  /** Tailwind 尺寸类，例如 `w-5 h-5` */
  className?: string;
}

// ============================================================
// 构建期映射表（内置模块）
// ============================================================

function getBuiltinIcon(name: string): IconComponent | undefined {
  const candidate = (BuiltinIcons as unknown as Record<string, IconComponent>)[name];
  return typeof candidate === 'function' || (candidate && typeof candidate === 'object')
    ? candidate
    : undefined;
}

// ============================================================
// lucide 动态解析
// ============================================================

/**
 * lucide-react 的按需图标入口。
 *
 * 为什么需要它：`generated/iconMap.ts` 是构建期产物，收不到运行时才注册的
 * 插件图标名。`dynamicIconImports` 是 lucide 官方为「图标名在运行时才知道」
 * 提供的入口，把每个图标做成独立的动态 import（各自成 chunk，本地加载）。
 *
 * 代价：每个未在内置映射表中的图标会多一个 chunk 文件。对一个桌面应用来说
 * 这是可接受的（本地磁盘读取），换来的是插件可以自由使用任意 lucide 图标，
 * 而不必重新生成宿主代码。
 *
 * 仍然保留构建期映射表作为第一优先级，因为内置模块每帧都在渲染，
 * 静态导入没有任何异步开销。
 */
/** 已解析的图标组件缓存（含「解析失败」的负缓存，避免反复重试） */
const lucideCache = new Map<string, Promise<IconComponent | null>>();
/** 已就绪的图标组件：命中时渲染是同步的，不触发 Suspense */
const lucideResolved = new Map<string, IconComponent | null>();

/**
 * 解析一个 lucide 图标名，返回可渲染的组件。
 *
 * 返回 null 表示「这个名字不是 lucide 图标」，调用方应走兜底。
 */
function resolveLucideIcon(name: string): Promise<IconComponent | null> {
  const cachedPromise = lucideCache.get(name);
  if (cachedPromise) return cachedPromise;

  const promise = (async (): Promise<IconComponent | null> => {
    // 1) 构建期映射表：内置模块走这里，同步可得
    const builtin = getBuiltinIcon(name);
    if (builtin) return builtin;

    // 2) lucide 按需入口。
    //    映射表本身是**静态**导入（`lucide-react/dynamic`，官方入口）：
    //    它只是一张「图标名 → 动态 import 函数」的表，体积很小；真正的图标
    //    代码在调用 loader 时才被拉取，因此不会把 1900 多个图标打进主包。
    //    之所以不用 `dist/...` 内部路径：那是包私有布局，升级随时会失效。
    const key = toKebabCase(name);
    const loader = dynamicIconImports[name as keyof typeof dynamicIconImports]
      ?? dynamicIconImports[key as keyof typeof dynamicIconImports];
    if (typeof loader !== 'function') return null;

    try {
      const loaded = (await loader()) as { default?: IconComponent } | IconComponent;
      const component =
        (loaded as { default?: IconComponent }).default ?? (loaded as IconComponent);
      return typeof component === 'function' || (component && typeof component === 'object')
        ? component
        : null;
    } catch (error) {
      console.warn(`[ModuleIcon] 加载 lucide 图标 "${name}" 失败:`, error);
      return null;
    }
  })();

  lucideCache.set(name, promise);
  return promise;
}

/**
 * 读取已经解析完成的图标组件（同步路径）。
 *
 * 未完成时把待决 Promise 抛给 React（Suspense 约定），由最近的边界挂起。
 * Promise settle 后 `lucideResolved` 会命中，之后的每一帧都是同步返回，
 * 不会再进入挂起分支 —— 因此这只影响图标第一次出现的那个瞬间。
 */
function readLucideIcon(name: string): IconComponent | null | undefined {
  if (lucideResolved.has(name)) return lucideResolved.get(name);

  const promise = resolveLucideIcon(name);
  // 结果写回同步缓存；注意这里不能替换 lucideCache 中的条目，
  // 否则下次调用会拿到一个新 Promise，导致同一个图标反复挂起。
  void promise.then((component) => {
    lucideResolved.set(name, component);
  });

  throw promise;
}

/** 包裹 Suspense 约定的组件，必须在 Suspense 边界内渲染 */
const AsyncLucideIcon: React.FC<{ name: string; className?: string }> = ({ name, className }) => {
  const Icon = readLucideIcon(name);

  // 名字不是 lucide 图标（插件写错一个名字就是这种情况）时落到 `Box`。
  //
  // 这里必须显式判空：`readLucideIcon` 的负缓存命中时返回 `null`，直接把它当组件
  // 渲染会让 React 抛 `Element type is invalid` —— 那是整条侧边栏条目的渲染错误，
  // 比"图标不好看"严重得多，也与"兜底永远是一个图标、绝不空白"这条契约相悖。
  if (!Icon) return <Box className={className} />;
  return <Icon className={className} />;
};

// ============================================================
// 主组件
// ============================================================

const ModuleIcon: React.FC<ModuleIconProps> = memo(({ icon, iconSvg, name, className }) => {
  const source = resolveModuleIconSource({ icon, iconSvg, hasBuiltinIcon: (n) => !!getBuiltinIcon(n) });

  switch (source.kind) {
    // 1) 内联 SVG：插件自己的图标（路径型 `icon` 的唯一来源），同步可得
    case 'inline-svg':
      return (
        <span
          aria-label={name}
          role="img"
          className={`inline-flex items-center justify-center [&>svg]:h-full [&>svg]:w-full ${className ?? ''}`}
          // 只接受以 <svg 开头的字符串，见 moduleIconResolver 的 isSvgMarkup
          dangerouslySetInnerHTML={{ __html: source.svg }}
        />
      );

    // 2) 构建期映射表：内置模块的常见路径，零异步开销
    case 'builtin': {
      const BuiltinIcon = getBuiltinIcon(source.name) ?? Box;
      return <BuiltinIcon className={className} />;
    }

    // 3) 按需加载 lucide 图标
    case 'lucide':
      return (
        <Suspense fallback={<Box className={className} />}>
          <AsyncLucideIcon name={source.name} className={className} />
        </Suspense>
      );

    // 4) 兜底：内置映射表里没有、也不是可加载的 lucide 名的图标。
    //    路径型 `icon` 走到这里，说明宿主没能把插件包里那张图补进 `iconSvg`。
    default:
      if (import.meta.env?.DEV && icon && looksLikeAssetPath(icon)) {
        warnMissingPathIcon(icon);
      }
      return <Box className={className} />;
  }
});

/**
 * 「路径型 `icon` 却没有 `iconSvg`」—— 这是**宿主**没能补上图标，不是插件写错了。
 *
 * 开发模式下每个路径只提示一次：这条通路原先只会安静地画一个 `Box`，
 * 于是"插件图标没出现"在界面上看不出是"宿主没读回来"还是"插件没带图标"。
 * 生产构建里不打印 —— 它是宿主侧的排查线索，不该出现在用户机器的日志里。
 */
const warnedPathIcons = new Set<string>();
function warnMissingPathIcon(icon: string): void {
  if (warnedPathIcons.has(icon)) return;
  warnedPathIcons.add(icon);
  console.warn(
    `[ModuleIcon] 模块的 icon 是插件包内的路径 "${icon}"，但描述符里没有 iconSvg。` +
      `插件图标应由 pluginRuntime 的 prefetchDeclaredIcons() 补上 —— 这一条说明它没读到那张图。`
  );
}

ModuleIcon.displayName = 'ModuleIcon';

export default ModuleIcon;
// 兼容既有出口：判定逻辑的实现在 `moduleIconResolver.ts`，这里只是转发。
export { isSvgMarkup, looksLikeAssetPath, toKebabCase };
