// src/modules/plugins/pluginMeta.ts
// 插件管理页用的展示元数据与格式化工具

import type { PluginStatus } from '../../services/pluginRuntime';

// 权限的标签、描述与风险等级**不在这里**。
//
// 它们曾经在这里，是一张手写的 `PERMISSION_INFO` 表 —— 与 Rust 的
// `PluginPermission` 枚举构成两份独立维护的清单：新增权限要改两处，漏掉任何一处
// 都不会报错，界面只会安静地展示一个没有依据的风险等级。
//
// 现在它们由宿主推导，通过 `list_plugin_permissions` 提供，见
// `src/services/permissionRegistry.ts`。

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

/**
 * 字节数格式化。
 *
 * 实现已移到 `src/utils/format.ts`：市场页与设置里的软件更新卡片也要用它，而它们都不该
 * 因此依赖插件模块。这里保留转发，调用方无需改动。
 */
export { formatBytes } from '../../utils/format';

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
