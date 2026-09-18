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
// 这里改用 Vite 的 `import.meta.glob`：它由构建器在**编译期**展开成真实的
// import 语句，因此既不在类型图里留下静态边，又能拿到正确的产物 URL。
//
// ---------------------------------------------------------------------------
// 为什么不用 `import(/* @vite-ignore */ 变量)`（曾用过，已废弃）
// ---------------------------------------------------------------------------
// 那是本文件的第一版实现，它以「首次打开设置页时按需加载」为代价换取了
// 架构不变式。这个判断是错的，代价也远比当时写下的严重：
//
//   `@vite-ignore` 的字面含义是「不要解析这个动态说明符」。于是构建器既不
//   解析它、也不生成对应的 chunk 引用，而是把字符串**原样**留在运行时。
//   `'../modules/plugins/Plugins'` 会被浏览器当作相对当前页面的 URL 解析，
//   实际请求 `http://tauri.localhost/modules/plugins/Plugins` —— 产物里
//   根本没有这个路径（真实文件是 `assets/Plugins-<hash>.js`），必然 404。
//
// 之所以开发期看不出来：`pnpm tauri dev` 背后是 Vite dev server，它拿源码
// 目录直接响应请求，`/modules/plugins/Plugins` 恰好能被解析到源文件，于是
// 「看起来正常」。一旦构建成静态产物，源码目录不复存在，问题才暴露。
//
// 教训：**用构建期指令抑制构建器行为时，必须在构建产物上验证，而不是在
// dev server 上验证**。dev 环境能兜住的错误路径，正是构建后必然失败之处。
//
// `import.meta.glob` 没有这个问题：说明符是 glob 字面量，Vite 会扫描匹配
// 文件并为每个匹配生成 chunk，返回的加载函数直接引用正确的产物 URL。
// ---------------------------------------------------------------------------

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
 * 内嵌模块的加载函数表。
 *
 * `import.meta.glob` 返回 `{ 路径: () => Promise<模块> }`，路径以本文件为基准。
 * Vite 在构建时把每个匹配替成真实的动态 import，因此产物里是正确 chunk URL。
 *
 * 用 `eager: false`（默认）保持懒加载：这个分页不打开就不会下载对应 chunk。
 * 模块被删除时，glob 匹配不到，映射里就没有对应键 —— 见 resolveEmbedLoader。
 */
const embedLoaders = import.meta.glob<{
  default: React.ComponentType<{ embedded?: boolean }>;
}>('../modules/*/Plugins.tsx');

/**
 * 把模块 ID 映射到它的加载函数。
 *
 * 模块 ID 与目录同名（见 module.toml 的 `id` 与目录约定），因此
 * `plugins` -> `../modules/plugins/Plugins.tsx`。
 *
 * 找不到时返回 null，由调用方降级为「模块不可用」提示 —— 这与「模块被删除
 * 后框架仍能编译运行」的约定一致：编译期不报错，运行期给可读提示。
 */
function resolveEmbedLoader(moduleId: string): (() => Promise<{
  default: React.ComponentType<{ embedded?: boolean }>;
}>) | null {
  const key = `../modules/${moduleId}/Plugins.tsx`;
  return embedLoaders[key] ?? null;
}

/** 单个内嵌模块的懒加载组件缓存，避免每次渲染重建 React.lazy 实例 */
const lazyCache = new Map<
  string,
  React.LazyExoticComponent<React.ComponentType<{ embedded?: boolean }>>
>();

function getLazyEmbed(
  moduleId: string
): React.LazyExoticComponent<React.ComponentType<{ embedded?: boolean }>> | null {
  const cached = lazyCache.get(moduleId);
  if (cached) return cached;

  const loader = resolveEmbedLoader(moduleId);
  if (!loader) return null;

  const component = createLazyComponent<React.ComponentType<{ embedded?: boolean }>>(loader);
  lazyCache.set(moduleId, component);
  return component;
}

/**
 * 该模块当前是否可用。
 *
 * 依据 glob 的匹配结果判断（构建期即确定），而不是「是否加载失败过」——
 * 后者会把一次网络抖动误判为永久不可用。
 */
let pluginsAvailable: boolean | undefined = undefined;

export function isPluginModuleAvailable(): boolean | undefined {
  if (pluginsAvailable === undefined) {
    pluginsAvailable = resolveEmbedLoader('plugins') !== null;
  }
  return pluginsAvailable;
}

interface ModuleEmbedProps {
  /** 要内嵌的模块 ID，目前仅支持 `'plugins'` */
  moduleId: 'plugins';
}

/**
 * 把一个内建模块内嵌到外壳中。
 *
 * 说明：这里用一个极小的错误边界兜住加载失败。React 的 `lazy` 在 import
 * 失败时会向最近的错误边界抛出，没有边界就会冒到顶层的 AppErrorBoundary
 * 并表现为整窗错误页 —— 对一个「设置里的一个分页」来说太重了。
 *
 * 注意：模块被删除属于「构建期已确定」的情况，由 resolveEmbedLoader 返回
 * null 直接处理，不经过错误边界。错误边界只负责真正的加载失败（例如读文件
 * 出错），两者分开，提示才准确。
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
  const element = useMemo(() => {
    // 目前只有插件页一个内嵌点；用 switch 保持「新增一个内嵌模块只需加一个分支」
    switch (moduleId) {
      case 'plugins': {
        const LazyPlugins = getLazyEmbed('plugins');
        if (!LazyPlugins) {
          return (
            <EmbedMissing
              moduleId={moduleId}
              error="未找到 src/modules/plugins/Plugins.tsx，该模块可能已被移除"
            />
          );
        }
        return <LazyPlugins embedded />;
      }
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
