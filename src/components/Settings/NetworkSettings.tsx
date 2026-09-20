// src/components/Settings/NetworkSettings.tsx
//
// 「网络」分页：决定应用怎么连 GitHub，以及实测每条路通不通。
//
// ============================================================
// 为什么这一页值得单独存在
// ============================================================
//
// 这个应用有两件事必须联网：拉插件市场的索引/包，以及检查自己的更新。两者都走
// GitHub 的地址，而 GitHub 在部分网络下不可直连 —— 此时应用的表现是「市场打不开」
// 「更新失败」，用户能提供的信息只有「不行」。
//
// 这一页把两件事交回用户手里：**走哪条路**（直连 / 你填的下载源），以及
// **每条路现在到底通不通**（诊断表）。后者是关键：把「失败」拆成
// 「直连 404 / 下载源 200」之后，用户自己就能得出结论，不需要来回问我们。
//
// ============================================================
// 三个必须说清楚的事（都写在界面上）
// ============================================================
//
// 1. **下载源是第三方。** 它能看到你请求了什么，因此不可能是默认值。
// 2. **内容完整性不由下载源保证。** 插件包有索引里的 sha256，索引与更新包有
//    发布签名，换一个加速源不会改变装到的东西 —— 这是可以放心试的原因。
// 3. **失败会回退直连。** 填错地址不会把市场变成永久打不开，只是白等一次超时。

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

import NetPolicySection from './NetPolicySection';

import {
  NETWORK_MODE_DIRECT,
  NETWORK_MODE_LABELS,
  NETWORK_MODE_PROXY,
  PROXY_PRESETS,
  isProxyEffective,
  validateProxyBase,
  proxyPreviewOrNull,
  type NetworkMode,
} from '../../utils/networkSettings';
import type { AppSettings } from '../../services/appSettings';
import {
  probeNetwork,
  registryProbeTargets,
  type ProbeReport,
  type ProbeRow,
} from '../../services/networkDiagnostics';
import { logMessage } from '../../services/logger';
import { formatBytes } from '../../utils/format';

interface Props {
  settings: AppSettings;
  /** 由 SettingsDialog 提供：乐观更新 + 失败回滚 + 顶部提示 */
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
}

/** 诊断结果里一条路径的呈现 */
const ResultRow: React.FC<{ row: ProbeRow }> = ({ row }) => {
  const via = row.via === 'proxy' ? '下载源' : '直连';

  return (
    <div className="flex items-start gap-2 py-2 border-b border-gray-100 last:border-0">
      <span className="shrink-0 pt-0.5">
        {row.ok ? (
          <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
        ) : (
          <AlertCircle className="w-3.5 h-3.5 text-red-500" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-xs text-gray-800">
          {row.label}
          <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600">
            {via}
          </span>
        </p>
        {row.ok ? (
          <p className="mt-0.5 text-[11px] text-gray-500">
            HTTP {row.status} · {formatBytes(row.bytes ?? 0)} · {row.elapsedMs} ms
          </p>
        ) : (
          <p className="mt-0.5 text-[11px] text-red-600 break-words leading-relaxed">
            {row.error ?? '失败'}
            {row.status !== null && ` （HTTP ${row.status}）`}
          </p>
        )}
        <p className="mt-0.5 text-[10px] text-gray-400 font-mono break-all">{row.url}</p>
      </div>
    </div>
  );
};

const NetworkSettings: React.FC<Props> = ({ settings, onUpdate }) => {
  /** 输入框里的草稿：提交前的每一击键都不该触发一次后端保存 */
  const [draft, setDraft] = useState(settings.githubProxy);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [report, setReport] = useState<ProbeReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');

  // 设置是唯一事实来源：别处改了它（或保存失败被回滚），草稿跟着回到已保存的值
  useEffect(() => {
    setDraft(settings.githubProxy);
    setDraftError(null);
  }, [settings.githubProxy]);

  const commitDraft = useCallback(async () => {
    const next = draft.trim();
    const reason = validateProxyBase(next);
    setDraftError(reason);
    if (reason) return;
    if (next === settings.githubProxy) return;
    await onUpdate({ githubProxy: next });
  }, [draft, onUpdate, settings.githubProxy]);

  const selectMode = useCallback(
    async (mode: NetworkMode) => {
      if (mode === settings.networkMode) return;
      await onUpdate({ networkMode: mode });
    },
    [onUpdate, settings.networkMode]
  );

  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeError('');
    setReport(null);
    try {
      const result = await probeNetwork(registryProbeTargets());
      setReport(result);
      logMessage(
        'info',
        `手动网络诊断完成：${result.rows.filter((row) => row.ok).length}/${result.rows.length} 条路径可用`,
        'networkSettings'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProbeError(message);
      logMessage('warn', `网络诊断失败：${message}`, 'networkSettings');
    } finally {
      setProbing(false);
    }
  }, []);

  const preview = proxyPreviewOrNull(draft);
  const proxyUsable = isProxyEffective(NETWORK_MODE_PROXY, draft);

  return (
    <div className="px-6 py-5">
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider pt-3">
          联网方式
        </h3>

        <div className="grid grid-cols-2 gap-2 pb-3 pt-1" role="radiogroup" aria-label="联网方式">
          {([NETWORK_MODE_DIRECT, NETWORK_MODE_PROXY] as const).map((mode) => {
            const copy = NETWORK_MODE_LABELS[mode];
            const active = settings.networkMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                title={copy.hint}
                onClick={() => void selectMode(mode)}
                className={`flex flex-col items-start gap-1 rounded-xl border px-3 py-3 text-left transition-colors ${
                  active
                    ? 'border-indigo-300 bg-indigo-50'
                    : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}
              >
                <span
                  className={`text-sm font-medium ${active ? 'text-indigo-700' : 'text-gray-700'}`}
                >
                  {copy.label}
                </span>
                <span className="text-[11px] text-gray-500 leading-relaxed">{copy.hint}</span>
              </button>
            );
          })}
        </div>

        <p className="pb-4 text-[11px] text-gray-500 leading-relaxed">
          作用于<strong className="font-medium text-gray-700">插件市场</strong>
          （索引、说明、图标、安装包）与
          <strong className="font-medium text-gray-700">软件更新</strong>
          （版本清单、安装包）两条链路。已安装的插件与本地功能不受影响。
        </p>

        <div className="border-t border-gray-100 pt-3 pb-4">
          <p className="text-sm font-medium text-gray-800">下载源地址</p>
          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
            原始 GitHub 地址会被整条接到这个地址后面。留空表示还没填 ——
            此时即使选「下载源」也仍然直连。
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {PROXY_PRESETS.map((preset) => (
              <button
                key={preset.base}
                type="button"
                onClick={() => {
                  setDraft(preset.base);
                  setDraftError(null);
                  void onUpdate({ githubProxy: preset.base });
                }}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
                title={preset.base}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={draft}
            spellCheck={false}
            placeholder="https://gh-proxy.org"
            onChange={(event) => {
              setDraft(event.target.value);
              // 边打字边提示，但不提交：中间态几乎必然是非法的，
              // 每敲一个字符都提交一次会让后端反复拒绝、界面反复回滚。
              setDraftError(
                event.target.value.trim() === '' ? null : validateProxyBase(event.target.value.trim())
              );
            }}
            onBlur={() => void commitDraft()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitDraft();
            }}
            className={`mt-2 w-full px-3 py-2 bg-gray-50 border rounded-lg text-sm text-gray-700 font-mono focus:outline-none focus:ring-2 ${
              draftError
                ? 'border-red-300 focus:border-red-300 focus:ring-red-100'
                : 'border-gray-200 focus:border-indigo-300 focus:ring-indigo-100'
            }`}
          />

          {draftError && (
            <p className="mt-1.5 text-[11px] text-red-600">地址无法保存：{draftError}</p>
          )}

          {!draftError && preview && (
            <p className="mt-1.5 text-[11px] text-gray-500 break-all leading-relaxed">
              一个请求会变成：
              <code className="ml-1 font-mono text-[10px] text-gray-600">{preview}</code>
            </p>
          )}

          {!draftError && !proxyUsable && settings.networkMode === NETWORK_MODE_PROXY && (
            <p className="mt-1.5 text-[11px] text-amber-600">
              已选择「下载源」但地址为空，目前仍然直连。
            </p>
          )}

          {!draftError && proxyUsable && (
            <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
              已生效：插件市场与软件更新会优先走这个下载源，取不到时自动回退直连。
            </p>
          )}
        </div>

        <div className="border-t border-gray-100 py-3">
          <p className="flex items-start gap-1.5 text-[11px] text-gray-500 leading-relaxed">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-gray-400" />
            <span>
              下载源是第三方服务，它能看到你请求了哪些地址。但它改不了你装到的东西：
              插件包与更新包都经过发布方签名或索引里的哈希校验，换一个加速源不会改变内容。
              加速源不可用时应用会自动回退直连。
            </span>
          </p>
        </div>
      </section>

      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <div className="flex items-center justify-between gap-4 pt-3">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            网络诊断
          </h3>
          <button
            type="button"
            onClick={() => void runProbe()}
            disabled={probing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {probing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {probing ? '正在测试…' : '测试连通性'}
          </button>
        </div>

        <p className="pt-2 pb-3 text-xs text-gray-500 leading-relaxed">
          把「直连」与「下载源」两条路各实测一遍。每条约 8 秒超时。
          「检查更新失败」这类问题，在这里通常一眼就能看出是哪一段不通。
        </p>

        {report && (
          <div className="pb-3">
            {report.rows.map((row) => (
              <ResultRow key={`${row.label}-${row.via}`} row={row} />
            ))}
            {report.mode === NETWORK_MODE_PROXY && !report.proxy && (
              <p className="mt-2 text-[11px] text-amber-600">
                当前选了「下载源」但地址为空，因此只测了直连。
              </p>
            )}
          </div>
        )}

        {probeError && (
          <p className="pb-3 text-[11px] text-red-600 break-words">诊断失败：{probeError}</p>
        )}

        {!report && !probeError && (
          <p className="pb-4 text-[11px] text-gray-400">
            点击右上角「测试连通性」开始
          </p>
        )}
      </section>

      {/* 出站管控与流量日志。放在连通性诊断**之后**：
          诊断回答"这条路通不通"，管控回答"允不允许走、以及刚才走了什么"——
          先解释眼前的问题，再给长期的控制。 */}
      <NetPolicySection settings={settings} onUpdate={onUpdate} />
    </div>
  );
};

export default NetworkSettings;
