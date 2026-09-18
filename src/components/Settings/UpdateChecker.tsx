// src/components/Settings/UpdateChecker.tsx
//
// 「关于」分页里的软件更新卡片。
//
// 四处刻意的呈现选择：
//
// 1. **「检查失败」与「已是最新」必须分开。** 断网时若显示"已是最新"，用户会以为
//    自己拿到了一个结论，而实际什么都没验证。
// 2. **安装前明确告知应用会自动关闭。** Windows 上 `downloadAndInstall` 会在启动
//    安装程序后结束本进程 —— 不预告的话，用户看到窗口突然消失会以为是崩溃。
// 3. **当前版本号只在相关时才出现。** 身份卡里已经写了版本号，这里再固定显示一遍
//    是重复；但"已是最新（1.0.3）"里的那个版本号是有信息量的。
// 4. **自动检查的开关放在这张卡片里**（而不是"通用"页）：它管的就是这件事，
//    放在别处会让"为什么会弹更新提示"变成一个要翻设置才能回答的问题。

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, Download, RefreshCw } from 'lucide-react';

import {
  checkForAppUpdate,
  describeUpdateError,
  installPendingAppUpdate,
  noteUpdateCheckCompleted,
  type AvailableUpdate,
  type DownloadProgress,
} from '../../services/appUpdater';
import {
  getCachedSettings,
  saveAppSettings,
  subscribeSettings,
} from '../../services/appSettings';
import { showToast } from '../../services/toast';
import { formatBytes } from '../../utils/format';
import Toggle from './Toggle';

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
  const [autoCheck, setAutoCheck] = useState(() => getCachedSettings().autoCheckUpdates);

  // 设置是唯一事实来源：别处改了它（或保存失败被回滚），这个开关跟着变
  useEffect(
    () => subscribeSettings(() => setAutoCheck(getCachedSettings().autoCheckUpdates)),
    []
  );

  const runCheck = useCallback(async () => {
    setStatus('checking');
    setError('');
    setAvailable(null);
    setProgress(null);
    try {
      const result = await checkForAppUpdate();
      setCurrentVersion(result.currentVersion);
      // 手动查过就等于查过了：不该在下次启动时立刻又自动查一次。
      // 写时间戳失败不会抛错（只影响节流），因此不会污染这里的成功路径。
      await noteUpdateCheckCompleted();
      if (result.available) {
        setAvailable(result.available);
        setStatus('available');
      } else {
        setStatus('latest');
      }
    } catch (err) {
      setError(describeUpdateError(err));
      setStatus('error');
    }
  }, []);

  const updateAutoCheck = useCallback(async (next: boolean) => {
    try {
      await saveAppSettings({ autoCheckUpdates: next });
    } catch (err) {
      // 保存失败时 saveAppSettings 已经把缓存回滚了，订阅会把开关拨回去；
      // 这里只需要说明为什么
      showToast({
        title: '保存失败',
        body: err instanceof Error ? err.message : String(err),
        level: 'error',
      });
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

      {/*
        自动检查的开关。它管的是「以后要不要自己查」，与上面这次检查的结果是
        两件事，因此放在卡片最后、用一条分隔线断开。
      */}
      <div className="mt-4 flex items-start justify-between gap-4 border-t border-gray-100 pt-3.5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-800">启动时自动检查更新</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
            每天最多检查一次，只向 GitHub 查询版本号，不发送任何本机信息。
            发现新版本会放进通知里提醒。关闭后仍然可以在这里手动检查。
          </p>
        </div>
        <Toggle checked={autoCheck} onChange={(next) => void updateAutoCheck(next)} />
      </div>
    </section>
  );
};

export default UpdateChecker;
