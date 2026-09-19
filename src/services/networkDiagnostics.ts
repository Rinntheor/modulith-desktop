// src/services/networkDiagnostics.ts
//
// 网络诊断：把「直连」与「下载源」两条路各实测一遍。
//
// 只负责组织待探测的**插件仓库**地址；更新清单那几条由后端从 `tauri.conf.json`
// 追加（那份地址的真源在配置文件里，前端再抄一遍就会漂移）。

import { invoke } from '@tauri-apps/api/core';

import {
  PLUGIN_INDEX_PATH,
  PLUGIN_INDEX_REF,
  jsdelivrUrl,
  rawGithubUrl,
} from '../config/pluginRegistry';

/** 一个待探测的目标（原始地址，未按下载源改写） */
export interface ProbeTarget {
  label: string;
  url: string;
}

/** 一条探测结果 */
export interface ProbeRow {
  label: string;
  /** `direct`（直连）或 `proxy`（经下载源） */
  via: 'direct' | 'proxy';
  url: string;
  ok: boolean;
  status: number | null;
  bytes: number | null;
  elapsedMs: number;
  error: string | null;
}

export interface ProbeReport {
  mode: string;
  proxy: string;
  rows: ProbeRow[];
}

/**
 * 插件仓库那两条探测目标
 *
 * 与市场实际取索引用的是同一套地址模板（`config/pluginRegistry.ts`），
 * 因此诊断结果能代表市场的真实情况。
 *
 * `?t=` 与市场取索引时一致：jsDelivr 对分支引用的缓存是若干小时，
 * 不带它就可能在诊断里拿到一份旧索引，从而低估 CDN 是否可用。
 */
export function registryProbeTargets(now: number = Date.now()): ProbeTarget[] {
  return [
    {
      label: '插件索引 · CDN',
      url: `${jsdelivrUrl(PLUGIN_INDEX_REF, PLUGIN_INDEX_PATH)}?t=${now}`,
    },
    {
      label: '插件索引 · GitHub',
      url: rawGithubUrl(PLUGIN_INDEX_REF, PLUGIN_INDEX_PATH),
    },
  ];
}

/**
 * 执行一次诊断
 *
 * 后端会为每条目标补上「经下载源」那一版（仅当配置了下载源），
 * 因此返回的行数通常多于传入的目标数。
 */
export async function probeNetwork(
  targets: ProbeTarget[] = registryProbeTargets()
): Promise<ProbeReport> {
  return invoke<ProbeReport>('probe_network', { targets });
}
