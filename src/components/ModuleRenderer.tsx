// src/components/ModuleRenderer.tsx
import React, { memo, Suspense, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  getCatalogFlatMap,
  getCatalogVersion,
  isPluginCatalogLoading,
  subscribeCatalog,
} from '../services/moduleCatalog';

interface ModuleRendererProps {
  moduleId: string;
  /**
   * 是否播放该模块的入场动画。
   *
   * 由宿主按「标签是否激活」传入：非激活标签传 `false`，让包裹层
   * **跳过初始态、直接以终态渲染**。
   *
   * 存在的理由：标签保活让切走的模块仍在运行，而模块的入场动画常带延迟
   * （仪表盘统计卡片为 `delay: 0.15 + i*0.06`）。切走时这些动画刚播到前几帧，
   * 继续推进的中间帧会被合成器画到屏幕上，表现为「切换后还有几张卡片停留
   * 一下才消失」。
   *
   * 用 `initial={false}` 而不是只依赖 `MotionConfig reducedMotion`：
   * framer-motion 12 的 reduced motion 只对位置类属性（transform 等）生效，
   * `opacity` 不在其中，而残留的可见表现正是 opacity 淡入。
   */
  initial?: boolean;
}

// 极简加载：一行小字 + 细线脉冲，几乎无感
const ModuleLoading: React.FC = memo(() => (
  <div className="flex items-center justify-center min-h-[60vh]">
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.15, duration: 0.15 }}
      className="flex items-center space-x-2"
    >
      <div className="w-1 h-4 bg-indigo-500/50 rounded-full animate-pulse" />
      <span className="text-xs text-gray-400">loading</span>
    </motion.div>
  </div>
));

ModuleLoading.displayName = 'ModuleLoading';

/**
 * 插件模块尚未注册完成时的占位。
 *
 * 与「模块不存在」必须区分开：插件改为后台加载后，用户完全可能在插件
 * 注册模块之前就打开了它（例如「恢复上次打开的模块」指向某个插件模块）。
 * 那时显示「模块不存在」是错的 —— 它一秒钟后就会出现。
 */
const PluginModulePending: React.FC = memo(() => (
  <div className="flex flex-col items-center justify-center min-h-[60vh]">
    <div className="flex items-center space-x-2">
      <div className="w-1 h-4 bg-indigo-500/50 rounded-full animate-pulse" />
      <span className="text-xs text-gray-400">插件正在后台加载…</span>
    </div>
    <p className="mt-3 text-[11px] text-gray-400 text-center max-w-xs leading-relaxed">
      该模块由插件提供。插件在应用可用之后加载，完成后会自动出现在这里。
    </p>
  </div>
));

PluginModulePending.displayName = 'PluginModulePending';

// 模块未找到组件
const ModuleNotFound: React.FC<{ moduleId: string }> = memo(({ moduleId }) => {
  const availableModules = Array.from(getCatalogFlatMap().keys());

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center justify-center min-h-[60vh]"
    >
      <motion.div
        animate={{ rotate: [0, -5, 5, -5, 0], scale: [1, 1.05, 1] }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="w-20 h-20 bg-gray-100 rounded-2xl flex items-center justify-center mb-6"
      >
        <span className="text-3xl text-gray-400">?</span>
      </motion.div>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Module Not Found</h2>
      <p className="text-gray-500 text-center max-w-sm">
        The module "{moduleId}" doesn't exist in the registry.
      </p>
      <div className="mt-4 flex flex-col items-center space-y-2">
        <span className="text-xs text-gray-400 uppercase tracking-wider">Available modules</span>
        <code className="px-3 py-2 bg-gray-50 border border-gray-100 rounded-lg text-xs max-w-md overflow-auto text-gray-600">
          {availableModules.join(', ')}
        </code>
      </div>
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => window.history.back()}
        className="mt-6 px-5 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20"
      >
        Go Back
      </motion.button>
    </motion.div>
  );
});

ModuleNotFound.displayName = 'ModuleNotFound';

// 错误边界组件
class ModuleErrorBoundary extends React.Component<
  { children: React.ReactNode; moduleId: string },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode; moduleId: string }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`Module ${this.props.moduleId} failed to load:`, error, errorInfo);
  }

  handleRetry = () => {
    // 重试时清理缓存，防止错误传播
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center min-h-[60vh]"
        >
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Module Error</h2>
          <p className="text-gray-500 mb-4 text-center max-w-sm">
            Failed to load module "{this.props.moduleId}"
          </p>
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 max-w-md mb-6">
            <p className="text-sm text-red-600 font-mono break-all">
              {this.state.error?.message || 'Unknown error'}
            </p>
          </div>
          <div className="flex space-x-3">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={this.handleRetry}
              className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20"
            >
              Try Again
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors border border-gray-200"
            >
              Reload App
            </motion.button>
          </div>
        </motion.div>
      );
    }
    return this.props.children;
  }
}

/**
 * 组件缓存管理器
 * 使用模块级缓存替代全局缓存，防止内存泄漏
 */
const ComponentCacheManager = {
  cache: new Map<string, React.LazyExoticComponent<React.ComponentType<any>>>(),

  /**
   * 获取缓存的组件
   */
  get(moduleId: string): React.LazyExoticComponent<React.ComponentType<any>> | null {
    return this.cache.get(moduleId) || null;
  },

  /**
   * 设置缓存的组件
   */
  set(moduleId: string, component: React.LazyExoticComponent<React.ComponentType<any>>): void {
    this.cache.set(moduleId, component);
  },

  /**
   * 清理指定模块的缓存
   */
  clear(moduleId: string): void {
    this.cache.delete(moduleId);
  },

  /**
   * 清理所有缓存
   */
  clearAll(): void {
    this.cache.clear();
  },

  /**
   * 清理过期缓存
   *
   * 说明：缓存条目目前不记录时间戳，无法按时间淘汰，因此直接清空。
   * 如果之后需要按时间淘汰，需要在 set() 时记录 Date.now()。
   */
  clearExpired(): void {
    this.cache.clear();
  },
};

/**
 * 清空模块组件缓存。
 * 插件重载/刷新后必须调用，否则会继续复用旧插件注册的组件实例。
 */
export function clearModuleComponentCache(): void {
  ComponentCacheManager.clearAll();
}

const ModuleRenderer: React.FC<ModuleRendererProps> = memo(({ moduleId, initial = true }) => {
  // 订阅模块目录：插件在后台注册模块时必须让这里重新求值。
  // 用目录版本号（而不是动态模块数量）做信号 —— 插件替换同名模块时
  // 数量不变但内容已变，只靠数量会漏掉更新。
  const [catalogVersion, setCatalogVersion] = useState(() => getCatalogVersion());
  useEffect(() => subscribeCatalog(() => setCatalogVersion(getCatalogVersion())), []);

  const catalogLoading = isPluginCatalogLoading();

  const moduleDescriptor = useMemo(() => {
    const descriptor = getCatalogFlatMap().get(moduleId);
    if (descriptor) {
      // 检查是否已缓存
      const cachedComponent = ComponentCacheManager.get(moduleId);
      if (!cachedComponent) {
        // 如果没有缓存，则添加到缓存
        ComponentCacheManager.set(moduleId, descriptor.component);
      }
    }
    return descriptor;
  }, [moduleId, catalogVersion]);

  if (!moduleDescriptor) {
    // 插件仍在后台加载：这个模块可能属于某个还没注册完的插件，
    // 此时说「不存在」是误导 —— 见 isPluginCatalogLoading 的说明。
    if (catalogLoading) {
      return <PluginModulePending />;
    }
    return <ModuleNotFound moduleId={moduleId} />;
  }

  // 使用缓存的组件
  const CachedComponent = ComponentCacheManager.get(moduleId) || moduleDescriptor.component;

  return (
    <ModuleErrorBoundary moduleId={moduleId}>
      <Suspense fallback={<ModuleLoading />}>
        <motion.div
          // initial={false}：非激活标签直接以终态渲染，不产生入场动画，
          // 因此不会有「进行中的动画帧」在切换后残留到屏幕上。
          initial={initial ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{ duration: initial ? 0.1 : 0 }}
        >
          <CachedComponent />
        </motion.div>
      </Suspense>
    </ModuleErrorBoundary>
  );
});

ModuleRenderer.displayName = 'ModuleRenderer';

export default ModuleRenderer;
