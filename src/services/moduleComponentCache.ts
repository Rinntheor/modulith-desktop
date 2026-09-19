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
//
// 缓存的**逐条**失效走另一条路：模块离开 `mountedTabs` 时由 `tabStore` 释放
// （见 `releaseCachedModuleComponent`）。两条路的分工是清楚的 —— 前者是「内容
// 变了」，后者是「不再需要了」。

import type { ModuleDescriptor } from '../types/module';

/** 缓存里存放的组件类型（与模块描述符的 component 字段一致） */
type CachedComponent = ModuleDescriptor['component'];

/** 模块 ID → 懒加载组件 */
const cache = new Map<string, CachedComponent>();

/** 读取已缓存的组件；没有则返回 null */
export function getCachedModuleComponent(moduleId: string): CachedComponent | null {
  return cache.get(moduleId) ?? null;
}

/**
 * 记录模块的懒加载组件（**会覆盖**已有条目）
 *
 * 「保持首次解析的实例稳定」这条保证不在这个函数里，而在两处：
 *
 * 1. 调用方（`ModuleRenderer`）写入前会先 `if (!getCachedModuleComponent(id))` 判一次；
 * 2. 条目只在两种情况消失 —— `clearModuleComponentCache()`（插件运行时重载，
 *    内容真的变了）与 `releaseCachedModuleComponent()`（不再挂载，不需要稳定了）。
 *
 * 这里**不**把「已存在就忽略」做进函数体：一个名叫 `set` 却静默不写的函数，
 * 在需要主动刷新某个条目的场合会成为一个查不出原因的坑。
 */
export function setCachedModuleComponent(moduleId: string, component: CachedComponent): void {
  cache.set(moduleId, component);
}

/**
 * 释放某个模块的缓存条目。
 *
 * **由 `tabStore` 在模块离开 `mountedTabs` 时调用，业务代码不应各自调用。**
 *
 * 缓存存在的意义是「目录刷新时保持**正在显示**的那个组件的实例稳定」——
 * 一旦某个模块不再挂载，这个保证就没有对象了：重新打开时描述符里的组件
 * 就是当前那一个（`ModuleRenderer` 的 `|| descriptor.component` 兜底）。
 *
 * 不释放的后果是缓存随「曾经打开过的模块」一直长大。它不会无限增长
 * （上限是目录里的模块数），但那条不变量的正确表述应当是「缓存条目数 =
 * 当前挂载的模块数」，而不是「= 曾经打开过的模块数」—— 后者在多开模块时
 * 会让每个插件模块的闭包（连带它整个 bundle 的顶层作用域）多留一份。
 *
 * 放在 `state` 更新处而不是组件卸载的 effect 里，是因为那才是「不再挂载」的
 * 唯一事实来源：组件生命周期在开发模式下会被 StrictMode 执行两遍，而挂载集合
 * 的变化只会发生一次。
 */
export function releaseCachedModuleComponent(moduleId: string): void {
  cache.delete(moduleId);
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

/** 当前缓存了多少个模块（诊断用：正常情况下应当等于已挂载的标签数） */
export function cachedModuleCount(): number {
  return cache.size;
}
