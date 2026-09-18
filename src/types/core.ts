// src/types/core.ts
/**
 * Modulith 核心类型定义
 * 包含最常用的类型，简化导入
 */

// 本文件内部使用（re-export 不会把名字带入本地作用域）
import type { PluginPermission } from './plugin';

// 重新导出模块类型
export type {
  ModuleDescriptor,
  SubModuleDescriptor,
  ModuleToml,
  ModuleTomlChild,
} from './module';

// 重新导出插件核心类型（仅常用部分）
export type {
  PluginManifest,
  PluginInstance,
  PluginStatus,
  PluginPermission,
  PluginContext,
  PluginAPI,
  PluginStorage,
} from './plugin';

// 重新导出验证器类型
export type {
  ValidationResult,
} from '../utils/validators';

// 重新导出路由类型
export type {
  RouteConfig,
} from '../router/dynamicRouter';

// 重新导出模块管理器类型
export type {
  ModulePreferences,
} from '../services/moduleManager';

/**
 * 简化的插件配置接口
 * 用于快速创建插件
 */
export interface SimplePluginConfig {
  id: string;
  name: string;
  version: string;
  permissions?: PluginPermission[];
}

/**
 * 简化的模块配置接口
 * 用于快速创建模块
 */
export interface SimpleModuleConfig {
  id: string;
  name: string;
  path: string;
  icon?: string;
  priority?: number;
}

/**
 * 应用配置接口
 */
export interface AppConfig {
  appName: string;
  version: string;
  debug: boolean;
  defaultModules: string[];
  hiddenModules: string[];
}

/**
 * 用户偏好接口
 */
export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  language: string;
  moduleOrder: string[];
  pinnedModules: string[];
  hiddenModules: string[];
}

/**
 * 事件类型
 */
export type EventType =
  | 'module:loaded'
  | 'module:unloaded'
  | 'module:activated'
  | 'plugin:installed'
  | 'plugin:uninstalled'
  | 'plugin:enabled'
  | 'plugin:disabled'
  | 'config:changed'
  | 'theme:changed';

/**
 * 事件处理器
 */
export type EventHandler = (payload: any) => void;

/**
 * 事件订阅取消函数
 */
export type UnsubscribeFn = () => void;
