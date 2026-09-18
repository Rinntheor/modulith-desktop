// src/contexts/RouteContext.tsx
import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import type { RouteConfig } from '../router/dynamicRouter';

interface RouteContextType {
  currentRoute: RouteConfig | null;
  navigateTo: (path: string) => void;
  goBack: () => void;
  canAccess: (permissions?: string[]) => boolean;
  currentPermissions: string[];
}

const RouteContext = createContext<RouteContextType | undefined>(undefined);

interface RouteProviderProps {
  children: ReactNode;
  initialRoute?: string;
}

/**
 * 路由上下文提供者
 */
export const RouteProvider: React.FC<RouteProviderProps> = ({
  children,
  initialRoute = '/',
}) => {
  const [currentRoute, setCurrentRoute] = useState<RouteConfig | null>(null);
  const [currentPermissions, setCurrentPermissions] = useState<string[]>([]);

  /**
   * 导航到指定路由
   */
  const navigateTo = async (path: string) => {
    // 验证路由是否存在
    const routes = (await import('../router/dynamicRouter')).default.getRoutes();
    const route = routes.find((r) => r.path === path);

    if (!route) {
      console.warn(`Route not found: ${path}`);
      return;
    }

    setCurrentRoute(route);
    setCurrentPermissions(route.meta?.permissions || []);
    window.history.pushState({}, '', path);
  };

  // 使用 initialRoute 作为初始路由
  useEffect(() => {
    void navigateTo(initialRoute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoute]);

  /**
   * 返回上一页
   */
  const goBack = () => {
    window.history.back();
  };

  /**
   * 检查用户是否有权限访问指定路径
   */
  const canAccess = (permissions?: string[]): boolean => {
    if (!permissions || permissions.length === 0) {
      return true;
    }

    // 检查当前路由权限是否满足要求
    return permissions.every((perm) => currentPermissions.includes(perm));
  };

  return (
    <RouteContext.Provider
      value={{
        currentRoute,
        navigateTo,
        goBack,
        canAccess,
        currentPermissions,
      }}
    >
      {children}
    </RouteContext.Provider>
  );
};

/**
 * 获取路由上下文
 */
export const useRoute = (): RouteContextType => {
  const context = useContext(RouteContext);
  if (!context) {
    throw new Error('useRoute must be used within a RouteProvider');
  }
  return context;
};
