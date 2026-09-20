// src/services/pluginSettings.ts
//
// 插件贡献的设置项（`contributes.settings`）的存储与查询。
//
// 为什么设置是**纯数据贡献**而不是「插件提供一个 React 设置组件」：
// 设置界面必须在**不执行插件代码**的前提下就能画出来。否则「读清单即可建立完整
// 界面」这个前提就被破坏了，而那个前提正是按需激活与将来沙箱化的基础 ——
// 一个为「打开设置」而被迫执行的插件，等于每次打开设置都要跑一遍所有插件的代码。
//
// 值的落盘复用插件自己的存储命名空间（`plugin_storage_*`），因此：
//   * 不需要新增后端命令；
//   * 需要插件声明 `storage` 权限 —— 没声明时读取会失败，这一点如实告诉用户，
//     而不是渲染一堆改了不生效的控件。
//
// 与 pluginRuntime 的分工：本文件不认识插件运行时，只认识「插件 ID + 设置声明」。
// 这样它可以被 check 脚本单独加载，也不会为了一点点存储逻辑形成循环依赖。

import { invoke } from '@tauri-apps/api/core';
import { settingStorageKey } from './pluginContributions';
import type { SettingContribution } from '../types/plugin';

/** pluginId → 设置项声明 */
const contributionsByPlugin = new Map<string, SettingContribution[]>();

/** pluginId → 已落盘的值（未改过的项不在其中，读取时回落到声明里的 default） */
const valuesByPlugin = new Map<string, Record<string, unknown>>();

/**
 * 读不到值的插件（通常是没声明 `storage` 权限）。
 *
 * 这让设置界面可以说「这些设置改不了，因为插件没有申请存储权限」——
 * 一个能点但改了不生效的开关比一个禁用的开关更糟。
 */
const unavailablePlugins = new Set<string>();

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[pluginSettings] 订阅者执行出错:', error);
    }
  });
}

/** 订阅设置变化（宿主设置界面写入时也会触发） */
export function subscribePluginSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 登记某个插件的设置项声明（插件列表刷新时调用；传空数组即清除） */
export function registerPluginSettings(
  pluginId: string,
  contributions: SettingContribution[]
): void {
  if (contributions.length === 0) {
    contributionsByPlugin.delete(pluginId);
    valuesByPlugin.delete(pluginId);
    unavailablePlugins.delete(pluginId);
    return;
  }
  contributionsByPlugin.set(pluginId, contributions);
}

/** 清空全部（重载插件运行时前调用） */
export function clearPluginSettings(): void {
  contributionsByPlugin.clear();
  valuesByPlugin.clear();
  unavailablePlugins.clear();
}

/** 有设置项声明的插件 ID 列表（供设置界面枚举） */
export function listPluginsWithSettings(): string[] {
  return [...contributionsByPlugin.keys()];
}

/** 某个插件的设置项声明 */
export function getPluginSettingContributions(pluginId: string): SettingContribution[] {
  return contributionsByPlugin.get(pluginId) ?? [];
}

/** 该插件的设置是否可读可写（false 通常因为没声明 storage 权限） */
export function isPluginSettingsAvailable(pluginId: string): boolean {
  return !unavailablePlugins.has(pluginId);
}

/**
 * 从插件存储里读回全部设置值。
 *
 * 逐项读而不是整体读：设置项数量是个位数，而整体读需要插件自己维护一个副本来
 * 保持一致 —— 那正是本项目反复记录过的「复制一份必然漂移」。
 *
 * 失败（未声明 storage 权限、后端不可用）时不抛错，只把该插件标记为不可用：
 * 一个可选能力不该让整个插件页加载失败。
 */
export async function loadPluginSettingValues(
  pluginId: string,
  contributions: SettingContribution[]
): Promise<void> {
  if (contributions.length === 0) return;

  const read: Record<string, unknown> = {};
  try {
    for (const contribution of contributions) {
      const raw = await invoke<string | null>('plugin_storage_get', {
        id: pluginId,
        key: settingStorageKey(contribution.id),
      });
      if (raw === null || raw === undefined) continue;
      try {
        read[contribution.id] = JSON.parse(raw) as unknown;
      } catch {
        // 存进去的不是合法 JSON（手工改过存储文件）：当作没改过，用缺省值
        console.warn(
          `[pluginSettings] 插件 "${pluginId}" 的设置 "${contribution.id}" 存值不是合法 JSON，已忽略`
        );
      }
    }
    valuesByPlugin.set(pluginId, read);
    unavailablePlugins.delete(pluginId);
  } catch (error) {
    valuesByPlugin.delete(pluginId);
    unavailablePlugins.add(pluginId);
    console.warn(
      `[pluginSettings] 插件 "${pluginId}" 的设置无法读取（很可能是清单里没有声明 "storage" 权限）:`,
      error
    );
  }
}

/** 单项：已落盘的值优先，否则用声明里的 `default` */
export function getPluginSetting(pluginId: string, settingId: string): unknown {
  const stored = valuesByPlugin.get(pluginId);
  if (stored && Object.prototype.hasOwnProperty.call(stored, settingId)) {
    return stored[settingId];
  }
  const declaration = (contributionsByPlugin.get(pluginId) ?? []).find(
    (item) => item.id === settingId
  );
  return declaration?.default;
}

/** 全部设置项的值（同样带回落到缺省值） */
export function getAllPluginSettings(pluginId: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const declaration of contributionsByPlugin.get(pluginId) ?? []) {
    result[declaration.id] = getPluginSetting(pluginId, declaration.id);
  }
  return result;
}

/**
 * 写入一项设置。
 *
 * 与读取不同，写入**会抛错**：用户点了一个开关却没生效，必须有可见的后果，
 * 而不是静默失败后在下一次渲染里悄悄弹回去。
 */
export async function setPluginSetting(
  pluginId: string,
  settingId: string,
  value: unknown
): Promise<void> {
  await invoke('plugin_storage_set', {
    id: pluginId,
    key: settingStorageKey(settingId),
    value: JSON.stringify(value),
  });

  const stored = valuesByPlugin.get(pluginId) ?? {};
  valuesByPlugin.set(pluginId, { ...stored, [settingId]: value });
  unavailablePlugins.delete(pluginId);
  notify();
}
