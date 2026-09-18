// src/modules/plugins/pluginMeta.ts
// 插件管理页用的展示元数据与格式化工具

import type { PluginStatus } from '../../services/pluginRuntime';

export type PermissionRisk = 'low' | 'medium' | 'high';

export interface PermissionInfo {
  label: string;
  description: string;
  risk: PermissionRisk;
}

/**
 * 权限说明表。键名与 Rust `PluginPermission` 的 kebab-case 序列化一致。
 */
export const PERMISSION_INFO: Record<string, PermissionInfo> = {
  storage: {
    label: '本地存储',
    description: '在应用数据目录中读写本插件自己的键值数据',
    risk: 'low',
  },
  network: {
    label: '本机网络',
    description: '请求本机地址（127.0.0.1 / localhost）上的服务',
    risk: 'low',
  },
  'network-external': {
    label: '外部网络',
    description: '请求任意外部域名，数据会离开本机',
    risk: 'medium',
  },
  notification: {
    label: '系统通知',
    description: '弹出系统级通知',
    risk: 'low',
  },
  clipboard: {
    label: '剪贴板',
    description: '读取与写入系统剪贴板',
    risk: 'medium',
  },
  'filesystem-read': {
    label: '读取文件',
    description: '读取本机文件信息（图标、所在位置）、导入音频文件，并可接收拖入的文件路径',
    risk: 'medium',
  },
  'filesystem-write': {
    label: '写入文件',
    description: '修改或删除本机文件',
    risk: 'high',
  },
  'filesystem-scoped': {
    label: '限定目录访问',
    description: '仅在用户授权的目录内读写文件',
    risk: 'medium',
  },
  'plugin-communicate': {
    label: '插件间通信',
    description: '与其他插件交换数据、调用其命令',
    risk: 'medium',
  },
  'native-module': {
    label: '原生模块',
    description: '调用原生代码，可绕过沙箱限制',
    risk: 'high',
  },
  'dev-tools': {
    label: '开发者工具',
    description: '访问开发者工具与调试接口',
    risk: 'high',
  },
  'process-spawn': {
    label: '启动外部程序',
    description: '运行本机上的任意程序，权限等同于你自己的用户账户',
    risk: 'high',
  },
};

export function getPermissionInfo(permission: string): PermissionInfo {
  return (
    PERMISSION_INFO[permission] ?? {
      label: permission,
      description: '未声明的权限',
      risk: 'medium',
    }
  );
}

export interface StatusInfo {
  label: string;
  className: string;
  dotClassName: string;
}

export const STATUS_INFO: Record<PluginStatus, StatusInfo> = {
  enabled: {
    label: '已启用',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotClassName: 'bg-emerald-500',
  },
  disabled: {
    label: '已禁用',
    className: 'bg-gray-100 text-gray-600 border-gray-200',
    dotClassName: 'bg-gray-400',
  },
  error: {
    label: '异常',
    className: 'bg-red-50 text-red-700 border-red-200',
    dotClassName: 'bg-red-500',
  },
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '未知';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '未知';

  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(then).toLocaleDateString();
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知';
  return date.toLocaleString();
}

/** 插件卡片/详情里的作者展示 */
export function formatAuthor(author?: { name?: string; email?: string; url?: string }): string {
  if (!author || !author.name) return '未知作者';
  return author.name;
}
