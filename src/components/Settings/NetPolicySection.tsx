// src/components/Settings/NetPolicySection.tsx
//
// 「网络」分页里的**出站管控**与**流量日志**。
//
// 三件必须说清楚的事：
//
//   1. **档位描述来自后端**（`net_policy_modes`），前端不手写。某一档还没实现时，
//      界面上它是**禁用**的并给出原因 —— 一个能点但什么都不做的开关比没有更糟。
//   2. **离线模式与策略互不覆盖。** 离线是"现在别联网"，策略是"默认怎么办"。
//   3. **日志是诊断用的，不是审计。** 它在内存里、有上限、重启即清空 ——
//      这一点写在界面上，免得有人把它当证据。
//
// 日志里的 URL **默认折叠查询串**：它经常带令牌，而日志会被截图、被贴进 issue。

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Eraser, Loader2, RefreshCw, WifiOff } from 'lucide-react';

import Toggle from './Toggle';
import {
  OUTCOME_LABELS,
  clearNetLog,
  describeSource,
  loadNetLog,
  loadPolicyModes,
  splitUrl,
  type NetLogEntry,
  type NetPolicyMode,
} from '../../services/netControl';
import type { AppSettings } from '../../services/appSettings';
import { formatBytes } from '../../utils/format';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

const OUTCOME_STYLES: Record<NetLogEntry['outcome'], string> = {
  allowed: 'text-gray-500',
  'allowed-pending-prompt': 'text-amber-600',
  denied: 'text-red-600',
  failed: 'text-red-600',
};

const NetPolicySection: React.FC<Props> = ({ settings, onUpdate }) => {
  const [modes, setModes] = useState<NetPolicyMode[]>([]);
  const [entries, setEntries] = useState<NetLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // 档位描述取一次即可：它由后端常量给出，不随设置变化
  useEffect(() => {
    let alive = true;
    void loadPolicyModes()
      .then((list) => {
        if (alive) setModes(list);
      })
      .catch(() => {
        // 后端不可用（例如纯前端预览）：不编造档位，界面会显示成"读不到"
      });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await loadNetLog(200));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开这一页时拉一次。**不做轮询**：出站请求不是高频事件，而一个常驻定时器
  // 会在用户看不见这一页的时候继续跑。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleClear = useCallback(async () => {
    try {
      await clearNetLog();
    } finally {
      await refresh();
    }
  }, [refresh]);

  return (
    <section className="space-y-4">
      {/* ---- 离线模式：最显眼的位置 ---- */}
      {settings.offlineMode && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
          <WifiOff className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-900">离线模式已开启</p>
            <p className="mt-0.5 text-[11px] text-amber-800 leading-relaxed">
              应用不会发出任何对外请求：市场、更新检查、插件的联网能力现在都会失败。
              这不是故障 —— 关掉这个开关即可恢复。
            </p>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">离线模式</p>
            <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
              开启后一切对外请求被拒。
              <span className="font-medium text-gray-700">本地回环地址不受影响</span>
              —— 拒绝 localhost 会让本地开发与诊断一起失效。
            </p>
          </div>
          <Toggle
            checked={settings.offlineMode}
            onChange={(next) => onUpdate({ offlineMode: next })}
          />
        </div>
      </div>

      {/* ---- 出站策略 ---- */}
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-4">
        <p className="text-sm font-medium text-gray-900">出站策略</p>
        <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
          默认档决定"没特别说明时怎么办"。判定在后端做出（请求由它发起），界面只负责显示。
        </p>

        {modes.length === 0 ? (
          <p className="mt-3 flex items-center gap-2 text-[11px] text-gray-400">
            <AlertCircle className="w-3.5 h-3.5" />
            读不到档位说明 —— 后端不可用时会这样，界面不会替你编一个
          </p>
        ) : (
          <div className="mt-3 space-y-1.5">
            {modes.map((mode) => {
              const selected = settings.networkPolicy === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  disabled={!mode.available}
                  onClick={() => onUpdate({ networkPolicy: mode.id as AppSettings['networkPolicy'] })}
                  className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                    !mode.available
                      ? 'border-gray-100 bg-gray-50 cursor-default'
                      : selected
                        ? 'border-indigo-300 bg-indigo-50/60'
                        : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-3.5 h-3.5 shrink-0 rounded-full border ${
                        selected && mode.available
                          ? 'border-indigo-600 bg-indigo-600'
                          : 'border-gray-300'
                      }`}
                    />
                    <span
                      className={`text-sm ${mode.available ? 'text-gray-900' : 'text-gray-400'}`}
                    >
                      {mode.label}
                    </span>
                    {!mode.available && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-gray-200 text-gray-500">
                        尚未实现
                      </span>
                    )}
                  </div>
                  <p className="mt-1 pl-5.5 text-[11px] leading-relaxed text-gray-500">
                    {mode.hint}
                  </p>
                  {!mode.available && mode.unavailableReason && (
                    <p className="mt-1 pl-5.5 text-[11px] leading-relaxed text-gray-400">
                      {mode.unavailableReason}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- 流量日志 ---- */}
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">流量日志</p>
            <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
              最近 {entries.length} 条出站记录。
              <span className="font-medium text-gray-700">它是诊断用的，不是审计</span>
              ：存在内存里、有上限、应用重启即清空。
            </p>
            <p className="mt-1 text-[11px] text-gray-400 leading-relaxed">
              应用更新（检查与下载）走更新器自带的传输，
              <span className="font-medium text-gray-500">不在这张表里</span>
              —— 它只在发起前受策略拦截。
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              刷新
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
            >
              <Eraser className="w-3 h-3" />
              清空
            </button>
          </div>
        </div>

        {entries.length === 0 ? (
          <p className="mt-3 text-[11px] text-gray-400">
            还没有记录。打开一次市场或让某个插件发一次请求，这里就会出现条目。
          </p>
        ) : (
          <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-gray-100">
            <table className="w-full text-[11px]">
              <tbody className="divide-y divide-gray-50">
                {entries.map((entry, index) => {
                  const { host, path, hasQuery } = splitUrl(entry.url);
                  return (
                    <tr key={`${entry.at}-${index}`} className="align-top">
                      <td className="px-3 py-2 whitespace-nowrap text-gray-400">
                        {entry.at.slice(11, 19)}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <div className="text-gray-600">{describeSource(entry.source)}</div>
                        <div className="text-[10px] text-gray-400">{entry.purpose}</div>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap text-gray-500">
                        {entry.method}
                      </td>
                      <td className="px-2 py-2 break-all text-gray-700">
                        {host}
                        {path}
                        {hasQuery && <span className="text-gray-300">?…</span>}
                      </td>
                      <td className={`px-2 py-2 whitespace-nowrap ${OUTCOME_STYLES[entry.outcome]}`}>
                        {OUTCOME_LABELS[entry.outcome]}
                        {entry.status !== null && ` ${entry.status}`}
                        {entry.bytes !== null && ` · ${formatBytes(entry.bytes)}`}
                      </td>
                      <td className="px-3 py-2 text-gray-400">
                        {entry.detail ?? ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};

export default NetPolicySection;
