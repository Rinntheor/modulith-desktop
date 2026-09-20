// src/services/backup.ts
//
// 备份与恢复的前端封装。
// 后端：src-tauri/src/modules/backup（list / export / open / restore）。
//
// ---------------------------------------------------------------------------
// 这一层几乎不含逻辑，是刻意的
//
// 备份的每一处判断都在 Rust 侧：白名单、路径安全、体积上限、敏感数据的两道门。
// 前端只做三件事：把用户的勾选传下去、把结果展示出来、在恢复成功后让应用重新
// 读取被替换掉的数据。
//
// **尤其不要在这里"顺便"做校验或拼接路径。** 前端复制一份白名单只会漂移成两份，
// 而漂移的那一份恰好是决定"能不能写到应用目录之外"的那份。
//
// ---------------------------------------------------------------------------
// 前端从不向后端传路径
//
// `exportBackup` 与 `openBackup` 都会弹出系统对话框，路径由后端自己处理；
// `restoreBackup` 恢复的是"后端记住的那个刚打开的文件"。因此前端没有
// 「让宿主读写任意路径」的能力 —— 这类能力一旦存在，白名单就只能约束包内的
// 路径，约束不了包从哪来。

import { invoke } from '@tauri-apps/api/core';
import { getCachedSettings, reloadAppSettings } from './appSettings';
import { reloadPluginRuntime } from './pluginRuntime';
import { moduleManager } from './moduleManager';
import { clearModuleComponentCache } from './moduleComponentCache';

/** 一个可备份类别的信息（后端 `categories::CategoryInfo`） */
export interface BackupCategoryInfo {
  id: string;
  label: string;
  description: string;
  /** 属于授权与安全数据，需要打开高级选项 */
  sensitive: boolean;
  /** 是否可以被恢复（日志只导出） */
  restorable: boolean;
  /** 本机当前是否存在这一类数据 */
  available: boolean;
  bytes: number;
  entries: number;
}

/** 备份清单（后端 `archive::BackupManifest`） */
export interface BackupManifest {
  format: number;
  appVersion: string;
  createdAt: string;
  platform: string;
  categories: string[];
  entries: Array<{ path: string; bytes: number }>;
}

/** 打开备份后的检查结果 */
export interface BackupInspection {
  manifest: BackupManifest;
  bytes: number;
  entries: number;
  stats: Array<{
    id: string;
    bytes: number;
    entries: number;
    restorable: boolean;
    sensitive: boolean;
  }>;
  warnings: string[];
}

export interface OpenedBackup {
  path: string;
  inspection: BackupInspection;
}

export interface ExportReport {
  path: string;
  bytes: number;
  entries: number;
  categories: string[];
  /** 选中但当前没有数据的类别（界面要如实说明"这一类是空的"） */
  skipped: string[];
}

export interface RestoreReport {
  categories: string[];
  entries: number;
  bytes: number;
  replaced: string[];
  /** 恢复了设置：调用方需要重新读取设置并重载插件运行时 */
  settingsChanged: boolean;
  /** 恢复了插件：调用方需要重载插件运行时 */
  pluginsChanged: boolean;
}

/** 列出可备份的类别与本机规模 */
export function listBackupCategories(): Promise<BackupCategoryInfo[]> {
  return invoke<BackupCategoryInfo[]>('list_backup_categories');
}

/**
 * 导出备份（会弹出系统保存对话框）
 *
 * 返回 `null` 表示用户取消了保存。
 */
export function exportBackup(
  categories: string[],
  includeSensitive: boolean
): Promise<ExportReport | null> {
  return invoke<ExportReport | null>('export_backup', { categories, includeSensitive });
}

/**
 * 打开并检查一个备份文件（会弹出系统打开对话框）
 *
 * 返回 `null` 表示用户取消了选择。后端会记住这个文件，供随后的
 * `restoreBackup` 使用。
 */
export function openBackup(): Promise<OpenedBackup | null> {
  return invoke<OpenedBackup | null>('open_backup');
}

/**
 * 从最近打开的那个备份恢复指定类别
 *
 * `confirm` 是后端的硬性要求，不是形式：恢复是**替换**语义，会先删除选中类别的
 * 现有数据。任何调用点都必须显式传 `true`。
 */
export function restoreBackup(
  categories: string[],
  includeSensitive: boolean,
  confirm: boolean
): Promise<RestoreReport> {
  return invoke<RestoreReport>('restore_backup', {
    categories,
    includeSensitive,
    confirm,
  });
}

/**
 * 恢复之后让应用重新读取被替换掉的数据。
 *
 * 必须做的两件事，各自对应一类"看起来恢复了、其实还是旧的"的故障：
 *
 * 1. **设置。** 后端的 `SettingsState` 与前端缓存都是内存副本，恢复只是换了磁盘
 *    上的文件。不重新读取的话，主题、外观开关、标签页布局、日志开关全部还是旧的
 *    —— 而设置页显示的却是新的（它读的是文件？不，它也读缓存，所以是一致地错）。
 * 2. **插件。** 插件目录被整体替换过，插件运行时里还挂着旧插件的模块、样式与
 *    命令注册，编目里也还是旧的模块列表。
 *
 * 只在报告确实说了"这几类被恢复了"时才做，避免无谓的重载（重载插件会重新执行
 * 一遍全部插件代码）。
 */
export async function applyRestoreEffects(report: RestoreReport): Promise<void> {
  if (report.settingsChanged) {
    await reloadAppSettings();
  }

  if (report.settingsChanged || report.pluginsChanged) {
    // 与标题栏的「刷新」走同一条链路，因此恢复之后的界面状态与手动刷新一致。
    await reloadPluginRuntime(undefined, {
      timeoutMs: getCachedSettings().pluginLoadTimeoutMs,
    });
    moduleManager.reloadCatalog();
    clearModuleComponentCache();
  }
}
