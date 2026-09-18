// src/services/authStore.ts
//
// 授权状态的共享缓存 + 订阅。
// 后端的单一事实来源是 `<app_data>/auth.json`，这里是它的前端镜像：
// 组件通过订阅拿状态，而不是各自去 invoke。

import {
  getAuthStatus as invokeAuthStatus,
  type AuthStatus,
} from './auth';

export type { AuthStatus };

const listeners = new Set<() => void>();

let cache: AuthStatus | null = null;

/** 订阅授权状态变化 */
export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[authStore] 订阅者执行出错:', error);
    }
  });
}

/** 同步读取缓存（可能为 null，表示还没读过） */
export function getCachedAuth(): AuthStatus | null {
  return cache;
}

/** 从后端读取最新授权状态并广播 */
export async function getAuthStatus(): Promise<AuthStatus> {
  const next = await invokeAuthStatus();
  cache = next;
  notify();
  return cache;
}

/** 手动刷新（登录 / 登出 / 改密钥后调用） */
export async function refreshAuth(): Promise<AuthStatus> {
  return getAuthStatus();
}
