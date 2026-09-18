// src/services/auth.ts
//
// 授权系统的前端封装（迁移自 hive_atelier 的 src/utils/security.ts + Auth.tsx 中的调用）
//
// 与后端模块 src-tauri/src/modules/auth 一一对应。
// 会话令牌保存在 sessionStorage：应用重启（WebView 重载）后即失效，
// 这也是「关闭应用即锁定」的默认行为；想免输入请用「记住我」。

import { invoke } from '@tauri-apps/api/core';

/** 访问密钥最短长度（与后端 crypto::MIN_KEY_LEN 保持一致） */
export const MIN_KEY_LENGTH = 8;

// ============================================================
// 类型（与后端 types.rs 对齐，全部 camelCase）
// ============================================================

export interface SecurityInfo {
  remainingAttempts: number;
  isNewDevice: boolean;
  blockedUntil: string | null;
  message: string | null;
}

export interface AuthResponse {
  success: boolean;
  token: string | null;
  deviceId: string;
  securityInfo: SecurityInfo;
}

/**
 * 新建 / 重置访问密钥的结果。
 *
 * `recoveryCodes` **只在首次创建密钥时非空**。重置访问密钥（用恢复码）
 * 不再换发新码 —— 它只作废被用掉的那一枚，其余保留（这是一个安全性质：
 * 换发会把整套交给重置者，若重置者是攻击者，合法用户就被永久锁在门外）。
 */
export interface KeySetupResponse {
  success: boolean;
  token: string | null;
  deviceId: string;
  securityInfo: SecurityInfo;
  /** 本次新生成的恢复码明文；重置场景下为空数组 */
  recoveryCodes: string[];
  /** 操作完成后还剩几枚可用恢复码 */
  remainingRecoveryCodes: number;
}

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  requireAuth: boolean;
  autoLogin: boolean;
  blocked: boolean;
  remainingAttempts: number;
  blockedUntil: string | null;
  sessionRemainingHours: number;
  deviceId: string;
  /** 是否还有可用的恢复码；为 false 时「忘记密钥」无法自救 */
  hasRecoveryCode: boolean;
  /** 剩余可用的恢复码数量 */
  remainingRecoveryCodes: number;
  /**
   * 当前进程是否处于「用户主动锁定」状态。
   *
   * 为 true 时**自动登录被禁用**，必须输入访问密钥。这个标记活在 Rust
   * 进程里，因此跨 Ctrl+R 重载保持、关掉应用再开即重置（那是冷启动，
   * 应当允许自动登录）。
   */
  lockedByUser: boolean;
}

export interface KnownDevice {
  deviceId: string;
  label: string;
  firstSeen: string;
  lastSeen: string;
  isCurrent: boolean;
}

export interface LoginLogEntry {
  timestamp: string;
  success: boolean;
  deviceId: string;
  deviceLabel: string;
  outcome: string;
}

export interface SecurityOverview {
  initialized: boolean;
  authenticated: boolean;
  requireAuth: boolean;
  autoLogin: boolean;
  sessionRemainingHours: number;
  remainingAttempts: number;
  blocked: boolean;
  blockedUntil: string | null;
  knownDeviceCount: number;
  loginLogCount: number;
  keyUpdatedAt: string | null;
  hasRecoveryCode: boolean;
  remainingRecoveryCodes: number;
  recoveryCreatedAt: string | null;
}

export interface HardwareFingerprint {
  macAddress: string | null;
  hostname: string;
  osId: string;
  cpuBrand: string;
  cpuCores: number;
}

/** 设备指纹的采集结果（字段名与后端 DeviceFingerprint 一致） */
export interface DeviceFingerprint {
  userAgent: string;
  screenResolution: string;
  timezone: string;
  language: string;
  platform: string;
}

// ============================================================
// 设备指纹
// ============================================================

export function collectDeviceFingerprint(): DeviceFingerprint {
  return {
    userAgent: navigator.userAgent ?? '',
    screenResolution: `${window.screen.width}x${window.screen.height}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    language: navigator.language ?? '',
    // navigator.platform 在新标准里已废弃，但 Tauri WebView 里仍然可用，
    // 且后端只用它做展示标签，取不到时退回空串即可。
    platform: navigator.platform || 'unknown',
  };
}

// ============================================================
// 会话令牌存储
// ============================================================

const TOKEN_KEY = 'modulith.auth.token';

export const tokenStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch (error) {
      console.warn('[auth] 无法保存会话令牌:', error);
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* 忽略 */
    }
  },
};

// ============================================================
// 命令封装
// ============================================================

/** 启动时一次性读取授权状态 */
export function getAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>('get_auth_status', {
    deviceFingerprint: collectDeviceFingerprint(),
    token: tokenStore.get(),
  });
}

/** 校验当前会话令牌 */
export async function verifySession(token: string): Promise<boolean> {
  try {
    return await invoke<boolean>('verify_session', { token });
  } catch {
    return false;
  }
}

export function getHardwareFingerprint(): Promise<HardwareFingerprint> {
  return invoke<HardwareFingerprint>('get_hardware_fingerprint');
}

/** 首次设置访问密钥（同时返回一次性恢复码） */
export async function setupAccessKey(key: string): Promise<KeySetupResponse> {
  const response = await invoke<KeySetupResponse>('setup_access_key', {
    key,
    deviceFingerprint: collectDeviceFingerprint(),
  });
  if (response.success && response.token) tokenStore.set(response.token);
  return response;
}

/** 用访问密钥解锁 */
export async function unlock(key: string, rememberMe = false): Promise<AuthResponse> {
  const response = await invoke<AuthResponse>('verify_access_key', {
    key,
    deviceFingerprint: collectDeviceFingerprint(),
    rememberMe,
  });
  if (response.success && response.token) tokenStore.set(response.token);
  return response;
}

/** 「记住我」自动登录 */
export async function tryAutoLogin(): Promise<AuthResponse> {
  const response = await invoke<AuthResponse>('try_auto_login', {
    deviceFingerprint: collectDeviceFingerprint(),
  });
  if (response.success && response.token) tokenStore.set(response.token);
  return response;
}

/**
 * 锁定应用。
 *
 * 后端会结束**全部**会话并置上「本进程已锁定」标记，但**保留**「记住我」
 * 凭据 —— 因此下次冷启动仍可自动登录，而本次运行期间（包括按 Ctrl+R
 * 重载 WebView）必须重新输入访问密钥。参见 `AuthStatus.lockedByUser`。
 */
export async function logout(): Promise<void> {
  const token = tokenStore.get();
  try {
    await invoke('logout', {
      token: token ?? '',
      deviceFingerprint: collectDeviceFingerprint(),
    });
  } finally {
    // 无论后端调用成败都要清掉本地令牌：这是"我要锁上"的语义
    tokenStore.clear();
  }
}

/** 修改访问密钥 */
export function changeAccessKey(oldKey: string, newKey: string): Promise<string> {
  return invoke<string>('change_access_key', {
    token: tokenStore.get() ?? '',
    oldKey,
    newKey,
    deviceFingerprint: collectDeviceFingerprint(),
  });
}

// ============================================================
// 恢复码
// ============================================================

/**
 * 重新生成整套恢复码（需要已解锁）。
 *
 * 旧恢复码**全部立即失效**：只保留最新一批，避免「多年前抄下的那张纸
 * 仍然有效」。返回全部明文，调用方须一次性展示。
 */
export function generateRecoveryCode(): Promise<string[]> {
  return invoke<string[]>('generate_recovery_code', {
    token: tokenStore.get() ?? '',
    deviceFingerprint: collectDeviceFingerprint(),
  });
}

/** 恢复码核验结果（两步恢复流程的第一步） */
export interface RecoveryVerification {
  verified: boolean;
  /** 核验通过时签发的**一次性**令牌，用于第二步设置新密钥 */
  token: string | null;
  /** 失败原因（可直接展示） */
  message: string | null;
  /** 因尝试过多被锁定时，给出解封时间 */
  blockedUntil: string | null;
}

/**
 * 用恢复码重置访问密钥 —— 第一步：核验恢复码。
 *
 * **不修改任何状态**，只回答「这串恢复码对不对」。这样界面可以做成两步：
 * 先让用户确认恢复码正确，再设置新密钥，而不是把三个输入框堆在一起 ——
 * 后者在出错时用户分不清是哪一步的问题。
 */
export function verifyRecoveryCode(recoveryCode: string): Promise<RecoveryVerification> {
  return invoke<RecoveryVerification>('verify_recovery_code', {
    recoveryCode,
    deviceFingerprint: collectDeviceFingerprint(),
  });
}

/**
 * 用恢复码重置访问密钥 —— 第二步：用核验令牌设置新密钥。
 *
 * 不需要会话（此时用户根本进不来），安全性由恢复码与一次性令牌共同承担：
 * 100 bit 熵 + Argon2id 存储 + 令牌单次使用且 10 分钟过期 + 限流。
 *
 * **不再换发恢复码**：只作废被用掉的那一枚，其余保留。返回值的
 * `recoveryCodes` 因此是空数组，`remainingRecoveryCodes` 给出剩余枚数。
 * 成功后后端会作废所有旧会话。
 */
export async function resetAccessKeyWithRecoveryCode(
  recoveryToken: string,
  newKey: string
): Promise<KeySetupResponse> {
  const response = await invoke<KeySetupResponse>('reset_access_key_with_recovery_code', {
    recoveryToken,
    newKey,
    deviceFingerprint: collectDeviceFingerprint(),
  });
  if (response.success && response.token) tokenStore.set(response.token);
  return response;
}

export function setRequireAuth(enabled: boolean): Promise<boolean> {
  return invoke<boolean>('set_require_auth', {
    token: tokenStore.get() ?? '',
    enabled,
    deviceFingerprint: collectDeviceFingerprint(),
  });
}

export function setAutoLogin(enabled: boolean): Promise<boolean> {
  return invoke<boolean>('set_auto_login', {
    token: tokenStore.get() ?? '',
    enabled,
    deviceFingerprint: collectDeviceFingerprint(),
  });
}

export function getSecurityOverview(): Promise<SecurityOverview> {
  return invoke<SecurityOverview>('get_security_overview', {
    token: tokenStore.get() ?? '',
    deviceFingerprint: collectDeviceFingerprint(),
  });
}

/** 已知设备列表（始终把当前设备排在第一位） */
export async function getKnownDevices(): Promise<KnownDevice[]> {
  const devices = await invoke<KnownDevice[]>('get_known_devices', {
    token: tokenStore.get() ?? '',
    deviceFingerprint: collectDeviceFingerprint(),
  });
  return [...devices].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
}

export function removeKnownDevice(deviceId: string): Promise<void> {
  return invoke('remove_known_device', {
    token: tokenStore.get() ?? '',
    deviceId,
  });
}

export function getLoginLogs(): Promise<LoginLogEntry[]> {
  return invoke<LoginLogEntry[]>('get_login_logs', {
    token: tokenStore.get() ?? '',
  });
}

export function clearLoginLogs(): Promise<void> {
  return invoke('clear_login_logs', {
    token: tokenStore.get() ?? '',
  });
}

// ============================================================
// 展示辅助
// ============================================================

/** 登录结果的可读文案 */
export function describeOutcome(outcome: string): string {
  const map: Record<string, string> = {
    ok: '解锁成功',
    setup: '初始化访问密钥',
    'auto-login': '记住我自动登录',
    'auto-login-invalid': '自动登录凭据失效',
    'auto-login-on': '开启记住我',
    'auto-login-off': '关闭记住我',
    'bad-key': '密钥错误',
    blocked: '触发设备锁定',
    'rate-limited': '请求过于频繁',
    'bad-old-key': '原密钥错误',
    'key-changed': '修改访问密钥',
    'require-auth-on': '开启访问密钥',
    'require-auth-off': '关闭访问密钥',
    locked: '主动锁定应用',
    'recovery-generated': '生成恢复码',
    'recovery-verified': '核验恢复码通过',
    'recovery-reset': '用恢复码重置访问密钥',
    'recovery-token-invalid': '恢复凭据已失效',
    'recovery-unavailable': '恢复码不存在',
    'recovery-rate-limited': '恢复码尝试过于频繁',
    'bad-recovery-code': '恢复码错误',
  };
  return map[outcome] ?? outcome;
}

/** ISO 8601 -> 本地可读时间 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** 把「还有多久解封」格式化成中文 */
export function formatBlockedUntil(iso: string | null | undefined): string {
  if (!iso) return '';
  const until = new Date(iso).getTime();
  if (Number.isNaN(until)) return '';
  const seconds = Math.max(0, Math.round((until - Date.now()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} 分钟`;
}
