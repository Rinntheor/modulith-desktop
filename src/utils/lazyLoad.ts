// src/utils/lazyLoad.ts

import React, { lazy } from 'react';

/**
 * 创建支持预加载的懒加载组件
 * 使用 React.lazy 确保兼容性
 */
export function createLazyComponent<T extends React.ComponentType<any>>(
  importFn: () => Promise<{ default: T }>
): React.LazyExoticComponent<T> & { preload: () => Promise<{ default: T }> } {
  let loadPromise: Promise<{ default: T }> | null = null;

  // 使用 React.lazy 确保兼容性
  const LazyComponent = lazy(() => {
    const promise = importFn().catch((error) => {
      console.error('Failed to load component:', error);
      throw error;
    });
    return promise;
  });

  (LazyComponent as any).preload = () => {
    if (!loadPromise) {
      loadPromise = importFn();
    }
    return loadPromise;
  };

  return LazyComponent as React.LazyExoticComponent<T> & { preload: () => Promise<{ default: T }> };
}