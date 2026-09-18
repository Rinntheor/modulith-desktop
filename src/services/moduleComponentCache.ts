// src/services/moduleComponentCache.ts
//
// 模块组件缓存：模块 ID → 已解析的懒加载组件。
//
// 为什么单独成文件（而不是留在 ModuleRenderer 里）：
//
//   `ModuleRenderer` 每次渲染都会用 `getCachedModuleComponent(moduleId) || descriptor.component`
//   取组件 —— 缓存一旦命中，就**永远**不会再去看描述符里那个新的组件。而插件
//   重新加载时 `registerModule()` 会为同一个模块 ID 造一个全新的懒加载组件
//   （它闭包引用的是新 bundle 里的组件函数），描述符也换成了新的。
//
//   于是「缓存没被清掉」的后果是：插件改了、刷新了、甚至卸载重装，界面仍然
//   渲染旧 bundle 里的组件 —— 看起来就是「刷新无效，必须删掉插件重装」。
//
//   原先 `clearModuleComponentCache()` 只有 `Home` 的手动刷新路径会调用，
//   插件页自己的刷新与安装/启用/禁用/卸载路径都没调。把缓存抽成独立模块后，
//   `pluginRuntime` 在**每次重载运行时**统一作废它（见 reloadPluginRuntime），
//   任何调用方都不需要记得这件事 —— 漏调用的那一个正是缺陷的来源。

import type { ModuleDescriptor } from '../types/module';

/** 缓存里存放的组件类型（与模块描述符的 component 字段一致） */
type CachedComponent = ModuleDescriptor['component'];

/** 模块 ID → 懒加载组件 */
const cache = new Map<string, CachedComponent>();

/** 读取已缓存的组件；没有则返回 null */
export function getCachedModuleComponent(moduleId: string): CachedComponent | null {
  return cache.get(moduleId) ?? null;
}

/** 记录模块的懒加载组件（已存在时不覆盖，保持首次解析的实例稳定） */
export function setCachedModuleComponent(moduleId: string, component: CachedComponent): void {
  cache.set(moduleId, component);
}

/**
 * 作废全部模块组件缓存。
 *
 * 插件运行时重载后必须调用 —— 否则会继续复用旧插件注册的组件实例。
 * 由 `reloadPluginRuntime()` 统一负责，业务代码不应各自调用。
 */
export function clearModuleComponentCache(): void {
  cache.clear();
}
