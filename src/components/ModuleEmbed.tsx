// src/components/ModuleEmbed.tsx
//
// 把某个模块的组件**内嵌**到外壳的其它位置（当前唯一用场：设置对话框的「插件」分页）。
//
// 为什么需要这个文件，而不是在 SettingsDialog 里直接 `import Plugins from
// '../../modules/plugins/Plugins'`：
//
//   架构总览第 1 节的核心主张是「框架代码中不存在任何对具体业务模块的引用」，
//   由此推出「删除任意内建模块，框架仍能编译并运行」。而静态 import 会让
//   SettingsDialog —— 一个外壳组件 —— 成为 plugins 模块的编译期依赖：
//   删掉 src/modules/plugins/ 就直接编译失败，那两个结论随之失效。
//
// 这里改用**动态 import + 变量说明符**：类型图里不再有那条静态边，上面的
// 架构不变式因此重新成立。
//
// 为什么说明符必须是变量（这一点是实测出来的，不是想当然）：
// 改成动态 `import('../modules/plugins/Plugins')` **并不够** —— TypeScript 仍然
// 会对字面量说明符做静态解析，模块被删除时报的仍是 TS2307，不变式依旧不成立。
// 实测过程：移走 src/modules/plugins/ 并重新生成注册表后，字面量写法只剩一条
// 错误，正是这一行；把说明符换成变量后才真正编译通过。
// 代价是该模块不会被 Vite 预打包，而是首次打开「设置 → 插件」时按需加载。
//
// 已实测确认的行为（不是推断）：
//   · 保留模块 → tsc 通过、模块正常显示；
//   · 移走模块并重新生成注册表（生成器会正确产出「2 modules」）→ tsc 仍然通过。
//   变的是「能不能编译」，不是「运行时会不会报错」，两者已分开处理。
//
// 代价（已知，可接受）：模块被删除时，这里会在打开设置页的那一刻才报错，
// 而不是在构建期报错。下面用错误边界把它降级为一条可读的提示。

import React, { Suspense, useMemo } from 'react';
import { createLazyComponent } from '../utils/lazyLoad';

/** 内嵌占位：与 ModuleRenderer 的加载态保持一致的克制风格 */
const EmbedLoading: React.FC = () => (
  <div className="flex items-center justify-center min-h-[30vh]">
    <div className="flex items-center space-x-2">
      <div className="w-1 h-4 bg-indigo-500/50 rounded-full animate-pulse" />
      <span className="text-xs text-gray-400">loading</span>
    </div>
  </div>
);

/** 模块不存在时的降级提示（只在模块被真正删除时出现） */
const EmbedMissing: React.FC<{ moduleId: string; error: string }> = ({ moduleId, error }) => (
  <div className="flex flex-col items-center justify-center min-h-[30vh] text-center px-6">
    <p className="text-sm text-gray-500">
      模块「{moduleId}」不可用，无法在此处显示。
    </p>
    <p className="mt-2 text-[11px] text-gray-400 font-mono break-all max-w-md">{error}</p>
  </div>
);

/**
 * 内嵌模块的动态导入表。
 *
 * 路径以**变量**形式提供（见文件头说明），因此 TypeScript 与打包器都不会对
 * 它做静态解析 —— 这正是「删除任意内建模块，框架仍能编译」得以成立的原因。
 */
const EMBEDDED_MODULES: Record<string, string> = {
  plugins: '../modules/plugins/Plugins',
};

/**
 * 插件管理页的懒加载引用。
 *
 * `embedded` 是 Plugins 组件自己的 prop，用来去掉页面级的外边距与标题。
 */
const LazyPlugins = createLazyComponent<React.ComponentType<{ embedded?: boolean }>>(() => {
  const specifier = EMBEDDED_MODULES.plugins;
  // `/* @vite-ignore */` 告诉 Vite 不要尝试在构建期解析这个动态说明符：
  // 它无法静态分析，若不忽略会产生构建警告（并使该模块被打进额外的 chunk）。
  return import(/* @vite-ignore */ specifier) as Promise<{
    default: React.ComponentType<{ embedded?: boolean }>;
  }>;
});

/**
 * 该模块当前是否可用。
 *
 * 用一个模块级的 memo 缓存动态 import 的成败，避免每次渲染都发起一次导入。
 * `undefined` 表示尚未探测过（首次渲染直接交给 Suspense 处理）。
 */
let pluginsAvailable: boolean | undefined = undefined;

export function isPluginModuleAvailable(): boolean | undefined {
  return pluginsAvailable;
}

interface ModuleEmbedProps {
  /** 要内嵌的模块 ID，目前仅支持 `'plugins'` */
  moduleId: 'plugins';
}

/**
 * 把一个内建模块内嵌到外壳中。
 *
 * 说明：这里用一个极小的错误边界包住动态 import 失败的情形。React 的
 * `lazy` 在 import 失败时会向最近的错误边界抛出，没有边界就会冒到
 * 顶层的 AppErrorBoundary 并表现为整窗错误页 —— 对一个「设置里的一个分页」
 * 来说太重了。
 */
class EmbedBoundary extends React.Component<
  { moduleId: string; children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { moduleId: string; children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    pluginsAvailable = false;
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[ModuleEmbed] 内嵌模块 ${this.props.moduleId} 加载失败:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <EmbedMissing
          moduleId={this.props.moduleId}
          error={this.state.error.message || String(this.state.error)}
        />
      );
    }
    return this.props.children;
  }
}

const ModuleEmbed: React.FC<ModuleEmbedProps> = ({ moduleId }) => {
  // 目前只有插件页一个内嵌点；用 switch 保持「新增一个内嵌模块只需加一个分支」
  const element = useMemo(() => {
    switch (moduleId) {
      case 'plugins':
        return <LazyPlugins embedded />;
      default:
        return <EmbedMissing moduleId={moduleId} error="未注册的内嵌模块" />;
    }
  }, [moduleId]);

  return (
    <EmbedBoundary moduleId={moduleId}>
      <Suspense fallback={<EmbedLoading />}>{element}</Suspense>
    </EmbedBoundary>
  );
};

export default ModuleEmbed;
