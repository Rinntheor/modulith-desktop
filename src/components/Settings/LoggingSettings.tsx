// src/components/Settings/LoggingSettings.tsx
//
// 「日志」分页：开关、位置、内容。
//
// ============================================================
// 为什么要有这一页
// ============================================================
//
// 「更新失败」这类问题以前没有任何证据：release 版是 GUI 子系统，`eprintln!`
// 没有出口；前端的错误只进 devtools 控制台，而用户打不开 devtools。于是能拿到的
// 只有一句「不行」。
//
// 这一页把三件事交给用户：**记不记**（两个开关）、**记在哪**（路径 + 打开文件夹）、
// **记了什么**（看最近一段，不必离开应用去找文件）。
//
// ============================================================
// 两个开关为什么是分开的
// ============================================================
//
// 「实时记录」与「崩溃记录」的取舍不同：前者是高频、持续写盘，关掉它是为了
// 减少磁盘活动；后者是低频、只在出事时写一次，几乎不占资源，但它恰恰是排查
// 崩溃时最需要的东西。合成一个开关就等于逼用户在「少写盘」和「能排查」之间二选一。

import React, { useCallback, useEffect, useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import { AlertCircle, Eraser, FolderOpen, RefreshCw } from 'lucide-react';

import type { AppSettings } from '../../services/appSettings';
import { clearLogs, getLogDir, readLogTail, type LogTail } from '../../services/logger';
import { formatBytes } from '../../utils/format';
import Toggle from './Toggle';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
}

const LoggingSettings: React.FC<Props> = ({ settings, onUpdate }) => {
  const [dir, setDir] = useState('');
  const [tail, setTail] = useState<LogTail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [logDir, content] = await Promise.all([getLogDir(), readLogTail()]);
      setDir(logDir);
      setTail(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // 进这一页就刷新一次：用户点进来多半就是想看「刚才那次失败记下什么了」，
  // 让他再点一下「刷新」是多余的一步。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpenDir = useCallback(async () => {
    if (!dir) return;
    try {
      await openPath(dir);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [dir]);

  const handleClear = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await clearLogs();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="px-4 lg:px-6 py-5">
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider pt-3">
          记录内容
        </h3>

        <div className="flex items-start justify-between gap-6 py-3.5 border-b border-gray-100">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800">实时记录</p>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              把运行过程中的信息写进日志文件：启动步骤、插件加载、联网请求与失败原因。
              单个文件上限 1 MB，最多保留 3 个，因此不会无限增长。
              <br />
              关闭后不再写运行日志（崩溃记录仍然有效）。
            </p>
          </div>
          <div className="shrink-0 pt-0.5">
            <Toggle
              checked={settings.fileLoggingEnabled}
              onChange={(next) => void onUpdate({ fileLoggingEnabled: next })}
            />
          </div>
        </div>

        <div className="flex items-start justify-between gap-6 py-3.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800">崩溃记录</p>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              界面或后端崩溃时，把错误与所在位置写进单独的崩溃日志。它与「实时记录」
              相互独立：崩溃是低频事件，即使关掉了实时记录也建议保留它 ——
              那是崩溃后唯一能拿到的线索。
            </p>
          </div>
          <div className="shrink-0 pt-0.5">
            <Toggle
              checked={settings.crashLoggingEnabled}
              onChange={(next) => void onUpdate({ crashLoggingEnabled: next })}
            />
          </div>
        </div>
      </section>

      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <div className="flex items-center justify-between gap-4 pt-3">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            日志文件
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              刷新
            </button>
            <button
              type="button"
              onClick={() => void handleOpenDir()}
              disabled={!dir}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              打开文件夹
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <Eraser className="w-3.5 h-3.5" />
              清空
            </button>
          </div>
        </div>

        <div className="pt-2 pb-3">
          <p className="text-[11px] text-gray-500">日志目录</p>
          <code className="mt-1 block text-[11px] font-mono text-gray-600 break-all">
            {dir || '（读取中…）'}
          </code>
        </div>

        {error && (
          <p className="pb-3 flex items-start gap-1.5 text-[11px] text-red-600 break-words">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {error}
          </p>
        )}

        <div className="border-t border-gray-100 pt-3 pb-4">
          {tail ? (
            tail.exists ? (
              <>
                <p className="text-[11px] text-gray-500 pb-2">
                  {tail.path.split(/[\\/]/).pop()} · {formatBytes(tail.size)}
                  {tail.truncated && '（只显示最近一段）'}
                </p>
                <pre className="text-[10px] leading-relaxed text-gray-700 bg-gray-50 border border-gray-100 rounded-xl p-3 whitespace-pre-wrap break-all max-h-64 overflow-y-auto custom-scrollbar font-mono">
                  {tail.text || '（文件为空）'}
                </pre>
              </>
            ) : (
              <p className="text-[11px] text-gray-500">
                还没有日志文件。
                {tail.fileLoggingEnabled
                  ? '应用正在运行，写第一条记录后就会出现在这里。'
                  : '「实时记录」当前是关闭的，打开它之后才会写文件。'}
              </p>
            )
          ) : (
            <p className="text-[11px] text-gray-400">（读取中…）</p>
          )}
        </div>
      </section>

      <p className="text-[11px] text-gray-400 leading-relaxed">
        日志只写在本机，不会自动上传。需要反馈问题时，可以把日志目录里的
        <code className="mx-1 font-mono">modulith.log</code>
        与
        <code className="mx-1 font-mono">crash.log</code>
        一并附上。
        <br />
        日志里可能包含插件 ID、文件路径与联网地址，分享前请自行确认。
      </p>
    </div>
  );
};

export default LoggingSettings;
