// src/components/Settings/UpdateChecker.tsx
//
// 「关于」分页里的软件更新卡片。
//
// 三处刻意的呈现选择：
//
// 1. **「检查失败」与「已是最新」必须分开。** 断网时若显示"已是最新"，用户会以为
//    自己拿到了一个结论，而实际什么都没验证。
// 2. **安装前明确告知应用会自动关闭。** Windows 上 `downloadAndInstall` 会在启动
//    安装程序后结束本进程 —— 不预告的话，用户看到窗口突然消失会以为是崩溃。
// 3. **当前版本号只在相关时才出现。** 身份卡里已经写了版本号，这里再固定显示一遍
//    是重复；但"已是最新（1.0.3）"里的那个版本号是有信息量的。

import React, { useCallback, useState } from 'react';
import { AlertCircle, CheckCircle, Download, RefreshCw } from 'lucide-react';

import {
  checkForAppUpdate,
  installPendingAppUpdate,
  type AvailableUpdate,
  type DownloadProgress,
} from '../../services/appUpdater';
import { formatBytes } from '../../utils/format';

type Status = 'idle' | 'checking' | 'latest' | 'available' | 'installing' | 'error';

const STATUS_TONE: Record<'ok' | 'warn' | 'err', string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  err: 'border-red-200 bg-red-50 text-red-800',
};

const UpdateChecker: React.FC = () => {
  const [status, setStatus] = useState<Status>('idle');
  const [currentVersion, setCurrentVersion] = useState('');
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState('');

  const runCheck = useCallback(async () => {
    setStatus('checking');
    setError('');
    setAvailable(null);
    setProgress(null);
    try {
      const result = await checkForAppUpdate();
      setCurrentVersion(result.currentVersion);
      if (result.available) {
        setAvailable(result.available);
        setStatus('available');
      } else {
        setStatus('latest');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  const runInstall = useCallback(async () => {
    setStatus('installing');
    setError('');
    setProgress({ downloaded: 0, total: null });
    try {
      await installPendingAppUpdate(setProgress);
      // 正常情况下到不了这里：Windows 上安装程序启动后本进程会被结束。
      // 能走到说明平台没有结束进程（或安装被跳过），回到可用状态让用户重试。
      setStatus('available');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  const busy = status === 'checking' || status === 'installing';

  return (
    <section className="bg-white rounded-xl border border-gray-200 px-5 py-5 mb-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            软件更新
          </h3>
          <p className="mt-2 text-xs leading-relaxed text-gray-600">
            {status === 'idle' && '检查是否有新版本。更新包经过签名校验后才会安装。'}
            {status === 'checking' && '正在检查…'}
            {status === 'latest' && `已是最新版本（${currentVersion}）。`}
            {status === 'available' &&
              available &&
              `有新版本 ${available.version}${available.date ? `（发布于 ${available.date.slice(0, 10)}）` : ''}。`}
            {status === 'installing' && '正在下载更新…'}
            {status === 'error' && '检查或安装未能完成，详见下方说明。'}
          </p>
        </div>

        <div className="shrink-0">
          {status === 'available' || (status === 'installing' && progress) ? (
            <button
              type="button"
              onClick={() => void runInstall()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              {status === 'installing' ? '安装中…' : '下载并安装'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runCheck()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${status === 'checking' ? 'animate-spin' : ''}`} />
              检查更新
            </button>
          )}
        </div>
      </div>

      {/* 发布说明 */}
      {status === 'available' && available?.notes && (
        <pre className="mt-3 text-[11px] leading-relaxed text-gray-700 bg-gray-50 border border-gray-100 rounded-xl p-3 whitespace-pre-wrap break-words max-h-40 overflow-y-auto custom-scrollbar">
          {available.notes}
        </pre>
      )}

      {/* 安装前必须说清会发生什么 */}
      {status === 'available' && (
        <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
          安装过程中应用会<strong className="font-medium text-gray-700">自动关闭</strong>
          ，安装完成后会自动重新打开。请先保存正在做的事。
        </p>
      )}

      {/* 下载进度 */}
      {status === 'installing' && (
        <div className="mt-3">
          <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-gray-900 transition-[width] duration-200"
              style={{ width: percent === null ? '15%' : `${percent}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-gray-500">
            {progress?.total
              ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}（${percent}%）`
              : progress && progress.downloaded > 0
                ? `已下载 ${formatBytes(progress.downloaded)}`
                : '正在连接…'}
          </p>
        </div>
      )}

      {/* 结果与失败 */}
      {status === 'latest' && (
        <div className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 ${STATUS_TONE.ok}`}>
          <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-[11px] leading-relaxed">没有可用更新。</p>
        </div>
      )}

      {status === 'error' && (
        <div className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 ${STATUS_TONE.err}`}>
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-[11px] leading-relaxed whitespace-pre-wrap">{error}</p>
        </div>
      )}
    </section>
  );
};

export default UpdateChecker;
