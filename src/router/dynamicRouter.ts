// src/router/dynamicRouter.ts
import { getCatalogModules } from '../services/moduleCatalog';

/**
 * 路由配置接口
 */
export interface RouteConfig {
  path: string;
  element: React.ComponentType<any>;
  meta?: {
    moduleId: string;
    title?: string;
    icon?: string;
    requiresAuth?: boolean;
    permissions?: string[];
    /** 子模块所在的一级模块 ID */
    parentId?: string;
  };
}

/**
 * 动态路由生成器
 * 根据模块注册表自动生成路由配置
 */
export class DynamicRouter {
  private static routes: RouteConfig[] = [];

  /**
   * 初始化路由系统
   */
  static initialize() {
    this.routes = this.generateRoutes();
  }

  /**
   * 从模块注册表生成路由配置
   */
  private static generateRoutes(): RouteConfig[] {
    // 使用统一目录，插件安装的模块同样会生成路由
    const registry = getCatalogModules();
    const routes: RouteConfig[] = [];

    registry.forEach((module) => {
      // 只为可见且未禁用的模块生成路由
      if (!module.visible || module.disabled) {
        return;
      }

      // 为每个模块创建路由
      routes.push({
        path: module.path,
        element: module.component,
        meta: {
          moduleId: module.id,
          title: module.displayName || module.name,
          icon: module.icon,
          requiresAuth: false,
        },
      });

      // 如果模块有子模块，为每个子模块创建路由
      if (module.children && module.children.length > 0) {
        module.children.forEach((child) => {
          if (!child.disabled) {
            routes.push({
              path: child.path,
              element: child.component,
              meta: {
                moduleId: `${module.id}/${child.id}`,
                title: child.name,
                icon: child.icon,
                requiresAuth: false,
                parentId: module.id,
              },
            });
          }
        });
      }
    });

    return routes;
  }

  /**
   * 获取所有路由配置
   */
  static getRoutes(): RouteConfig[] {
    return this.routes;
  }

  /**
   * 获取特定模块的路由
   */
  static getRouteByModuleId(moduleId: string): RouteConfig | undefined {
    return this.routes.find((route) => route.meta?.moduleId === moduleId);
  }

  /**
   * 获取路由树（用于嵌套路由）
   */
  static getRouteTree(): RouteConfig[] {
    return this.routes.filter((route) => route.meta?.parentId);
  }

  /**
   * 验证路由路径是否有效
   */
  static isValidRoute(path: string): boolean {
    return this.routes.some((route) => route.path === path);
  }

  /**
   * 添加自定义路由
   */
  static addRoute(route: RouteConfig): void {
    this.routes.push(route);
  }

  /**
   * 移除路由
   */
  static removeRoute(path: string): void {
    this.routes = this.routes.filter((route) => route.path !== path);
  }

  /**
   * 清空所有路由
   */
  static clearRoutes(): void {
    this.routes = [];
  }
}

// 初始化路由系统
DynamicRouter.initialize();

export default DynamicRouter;
