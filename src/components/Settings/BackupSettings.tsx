// src/components/Settings/BackupSettings.tsx
//
// 「备份」分页：按类别导出应用数据，或从备份恢复选定的类别。
//
// ============================================================
// 这一页的两个取向
// ============================================================
//
// 1. **先把话讲清楚，再让人点。** 导出与恢复都按**类别**而不是"整个目录"来做，
//    因此界面必须回答"这一类里到底是什么"。恢复尤其如此：它是**替换**语义，
//    会先删掉选中类别的现有数据。所以恢复是两步——先看清包里的内容，再确认。
//
// 2. **敏感数据的开关是两道，不是一道。** 「授权与安全数据」在导出与恢复时各需要
//    打开一次高级开关。这不是重复：导出时愿意交出凭据，与恢复时愿意用备份里的
//    凭据覆盖本机，是两个不同的决定。后端也按同一个规则拒绝（见
//    `src-tauri/src/modules/backup/commands.rs` 的 `resolve_selection`），
//    因此这里即使写错也只是"多提示一次"，不会真的绕过。
//
// 白名单、路径安全与体积上限全部在 Rust 侧，这一页不做任何校验 ——
// 前端复制一份判断只会漂移成两份，而漂移的那一份恰好是决定能否写到应用目录
// 之外的那份。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileArchive,
  FolderOpen,
  Loader2,
  ShieldAlert,
  Upload,
} from 'lucide-react';

import {
  applyRestoreEffects,
  exportBackup,
  listBackupCategories,
  openBackup,
  restoreBackup,
  type BackupCategoryInfo,
  type ExportReport,
  type OpenedBackup,
  type RestoreReport,
} from '../../services/backup';
import { formatBytes } from '../../utils/format';
import { showToast } from '../../services/toast';
import Toggle from './Toggle';

const Row: React.FC<{
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  title: string;
  description: string;
  meta: string;
  tone?: 'default' | 'sensitive';
}> = ({ checked, disabled, onToggle, title, description, meta, tone = 'default' }) => (
  <label
    className={`flex items-start gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
      disabled
        ? 'border-gray-200 bg-gray-50 opacity-60'
        : tone === 'sensitive'
          ? 'border-amber-200 bg-amber-50/40'
          : checked
            ? 'border-indigo-300 bg-indigo-50/40'
            : 'border-gray-200 bg-white hover:bg-gray-50'
    }`}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
      className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
    />
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        <span className="text-sm text-gray-800">{title}</span>
        {tone === 'sensitive' && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-amber-300 bg-amber-100 text-amber-800">
            <ShieldAlert className="w-3 h-3" />
            敏感
          </span>
        )}
      </span>
      <span className="block text-[11px] text-gray-500 mt-0.5 leading-relaxed">{description}</span>
      <span className="block text-[11px] text-gray-400 mt-1">{meta}</span>
    </span>
  </label>
);

/** 恢复前的二次确认面板 */
const ConfirmPanel: React.FC<{
  categories: string[];
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}> = ({ categories, onCancel, onConfirm, busy }) => (
  <div className="mt-3 rounded-xl border border-red-200 bg-red-50/60 px-4 py-3">
    <p className="flex items-center gap-1.5 text-xs font-medium text-red-700">
      <AlertTriangle className="w-3.5 h-3.5" />
      恢复会先删除本机在这些类别下的现有数据
    </p>
    <ul className="mt-1.5 ml-5 list-disc text-[11px] text-red-700/90 leading-relaxed">
      {categories.map((label) => (
        <li key={label}>{label}</li>
      ))}
    </ul>
    <p className="mt-1.5 text-[11px] text-red-700/80 leading-relaxed">
      这一步不可撤销。如果还不确定，先导出一次当前数据作为退路。
    </p>
    <div className="mt-2.5 flex items-center gap-2">
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
        确认恢复
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
      >
        取消
      </button>
    </div>
  </div>
);

const BackupSettings: React.FC = () => {
  const [categories, setCategories] = useState<BackupCategoryInfo[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 导出
  const [exportSelected, setExportSelected] = useState<Set<string>>(new Set());
  const [exportSensitive, setExportSensitive] = useState(false);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);

  // 恢复
  const [opened, setOpened] = useState<OpenedBackup | null>(null);
  const [restoreSelected, setRestoreSelected] = useState<Set<string>>(new Set());
  const [restoreSensitive, setRestoreSensitive] = useState(false);
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const list = await listBackupCategories();
      setCategories(list);
      // 默认勾选"有数据、不敏感"的类别。默认全选会让用户在没看清的情况下
      // 连带把几 MB 的插件一起打包；默认全不选又会让人以为没有可备份的东西。
      setExportSelected(
        new Set(list.filter((c) => c.available && !c.sensitive).map((c) => c.id))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const empty = useMemo(() => categories.filter((c) => !c.available), [categories]);

  const toggle = (
    set: Set<string>,
    apply: (next: Set<string>) => void,
    id: string
  ): void => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const handleExport = useCallback(async () => {
    setBusy(true);
    setError('');
    setExportReport(null);
    try {
      const report = await exportBackup([...exportSelected], exportSensitive);
      // null = 用户取消了保存，是正常操作
      if (!report) return;
      setExportReport(report);
      showToast({
        title: '备份已导出',
        body: `${report.entries} 个文件，${formatBytes(report.bytes)}`,
        level: 'success',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [exportSelected, exportSensitive]);

  const handleOpen = useCallback(async () => {
    setBusy(true);
    setError('');
    setRestoreReport(null);
    setConfirming(false);
    try {
      const result = await openBackup();
      if (!result) return;
      setOpened(result);

      // 默认勾选包里"有数据、可恢复、不敏感"的类别。
      // 不默认勾选敏感类别：那正是"恢复"比"导出"更需要谨慎的一侧。
      const inBackup = new Set(result.inspection.stats.map((s) => s.id));
      setRestoreSelected(
        new Set(
          result.inspection.stats
            .filter((s) => s.restorable && !s.sensitive && inBackup.has(s.id))
            .map((s) => s.id)
        )
      );
      setRestoreSensitive(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRestore = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const report = await restoreBackup([...restoreSelected], restoreSensitive, true);
      setRestoreReport(report);
      setConfirming(false);

      // 让应用重新读取被替换掉的数据（设置与插件）。见 services/backup.ts。
      await applyRestoreEffects(report);

      showToast({
        title: '恢复完成',
        body: `${report.entries} 个文件，${formatBytes(report.bytes)}`,
        level: 'success',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [restoreSelected, restoreSensitive]);

  const labelOf = useCallback(
    (id: string) => categories.find((c) => c.id === id)?.label ?? id,
    [categories]
  );

  const restoreLabels = useMemo(
    () => [...restoreSelected].map(labelOf),
    [restoreSelected, labelOf]
  );

  return (
    <div className="px-6 py-5">
      {/* ---------------- 导出 ---------------- */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
              导出备份
            </h3>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              勾选要带走的类别，导出一个标准的 zip 文件 —— 用任何解压工具都能查看里面的内容。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            重新统计
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {categories
            .filter((c) => !c.sensitive)
            .map((c) => (
              <Row
                key={c.id}
                checked={exportSelected.has(c.id)}
                disabled={!c.available}
                onToggle={() => toggle(exportSelected, setExportSelected, c.id)}
                title={c.label}
                description={c.description}
                meta={
                  c.available
                    ? `${c.entries} 个文件 · ${formatBytes(c.bytes)}`
                    : '本机还没有这类数据'
                }
              />
            ))}
        </div>

        {/* 敏感类别：单独一块，并带一个必须自己打开的开关 */}
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/40 px-3 py-2.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm text-gray-800">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
                包含授权与安全数据
              </p>
              <p className="text-[11px] text-amber-800/90 mt-0.5 leading-relaxed">
                {categories.find((c) => c.id === 'auth')?.description ??
                  '访问密钥与恢复码的派生哈希、已知设备与登录记录'}
              </p>
              <p className="text-[11px] text-amber-700/80 mt-1 leading-relaxed">
                默认不包含。勾上之后，备份文件本身就成了一份可以对访问密钥做离线爆破的材料 ——
                请只把它放在你信得过的地方。
              </p>
            </div>
            <div className="shrink-0 pt-0.5">
              <Toggle
                checked={exportSensitive}
                onChange={(next) => {
                  setExportSensitive(next);
                  // 开关与勾选联动：打开开关就顺手选中它，关掉就取消勾选。
                  // 让两者各自独立会得到一个"开了开关却没选中"的迷惑状态。
                  toggle(exportSelected, setExportSelected, 'auth');
                }}
              />
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={busy || exportSelected.size === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            导出备份
          </button>
          <span className="text-[11px] text-gray-400">
            已选 {exportSelected.size} 个类别
          </span>
        </div>

        {exportReport && (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/50 px-4 py-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-800">
              <CheckCircle2 className="w-3.5 h-3.5" />
              已导出 {exportReport.entries} 个文件，{formatBytes(exportReport.bytes)}
            </p>
            <p className="mt-1 text-[11px] text-emerald-800/80 break-all">{exportReport.path}</p>
            {exportReport.skipped.length > 0 && (
              <p className="mt-1 text-[11px] text-amber-700 leading-relaxed">
                这些类别本机还没有数据，因此包里没有它们：
                {exportReport.skipped.map(labelOf).join('、')}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ---------------- 恢复 ---------------- */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
              从备份恢复
            </h3>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              先打开一个备份文件看清它的内容，再选择要恢复哪些类别。
              <strong className="font-medium text-gray-600">恢复是替换，不是合并。</strong>
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleOpen()}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            打开备份文件
          </button>
        </div>

        {opened && (
          <div className="mt-3">
            <div className="rounded-xl border border-gray-200 bg-gray-50/60 px-4 py-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
                <FileArchive className="w-3.5 h-3.5" />
                {opened.inspection.entries} 个文件 · {formatBytes(opened.inspection.bytes)} ·
                格式 v{opened.inspection.manifest.format}
              </p>
              <p className="mt-1 text-[11px] text-gray-500 break-all">{opened.path}</p>
              <p className="mt-0.5 text-[11px] text-gray-500">
                创建于 {opened.inspection.manifest.createdAt}，来自 {opened.inspection.manifest.platform}
                ，应用版本 {opened.inspection.manifest.appVersion}
              </p>
              {opened.inspection.warnings.length > 0 && (
                <ul className="mt-1.5 ml-4 list-disc text-[11px] text-amber-700 leading-relaxed">
                  {opened.inspection.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-3 space-y-2">
              {opened.inspection.stats.map((stat) => (
                <Row
                  key={stat.id}
                  checked={restoreSelected.has(stat.id)}
                  disabled={!stat.restorable}
                  onToggle={() => toggle(restoreSelected, setRestoreSelected, stat.id)}
                  title={labelOf(stat.id)}
                  description={
                    categories.find((c) => c.id === stat.id)?.description ?? '备份中包含的数据'
                  }
                  meta={
                    stat.restorable
                      ? `${stat.entries} 个文件 · ${formatBytes(stat.bytes)}`
                      : '这一类只导出、不恢复（日志文件由日志器占用，无法安全替换）'
                  }
                  tone={stat.sensitive ? 'sensitive' : 'default'}
                />
              ))}
            </div>

            {opened.inspection.stats.some((s) => s.sensitive) && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/40 px-3 py-2.5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm text-gray-800">
                      <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
                      同时恢复授权与安全数据
                    </p>
                    <p className="text-[11px] text-amber-700/80 mt-0.5 leading-relaxed">
                      备份里含有访问密钥与恢复码的哈希。恢复会用它们
                      <span className="font-medium">覆盖本机当前的凭据</span>
                      —— 如果那份备份的访问密钥你已经不记得了，恢复之后就会打不开这台机器。
                      导出时的那次确认不算数，这里需要再确认一次。
                    </p>
                  </div>
                  <div className="shrink-0 pt-0.5">
                    <Toggle
                      checked={restoreSensitive}
                      onChange={(next) => {
                        setRestoreSensitive(next);
                        toggle(restoreSelected, setRestoreSelected, 'auth');
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {confirming ? (
              <ConfirmPanel
                categories={restoreLabels}
                busy={busy}
                onCancel={() => setConfirming(false)}
                onConfirm={() => void handleRestore()}
              />
            ) : (
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={busy || restoreSelected.size === 0}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50 transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" />
                  恢复选中的类别
                </button>
                <span className="text-[11px] text-gray-400">
                  已选 {restoreSelected.size} 个类别
                </span>
              </div>
            )}
          </div>
        )}

        {restoreReport && (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/50 px-4 py-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-800">
              <CheckCircle2 className="w-3.5 h-3.5" />
              已恢复 {restoreReport.entries} 个文件，{formatBytes(restoreReport.bytes)}
            </p>
            <p className="mt-1 text-[11px] text-emerald-800/80 leading-relaxed">
              类别：{restoreReport.categories.map(labelOf).join('、')}
            </p>
            {(restoreReport.settingsChanged || restoreReport.pluginsChanged) && (
              <p className="mt-1 text-[11px] text-emerald-800/80 leading-relaxed">
                设置与插件运行时已重新加载。若侧边栏与标签页与预期不符，用标题栏的刷新再看一次。
              </p>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50/60 px-4 py-3">
          <p className="flex items-start gap-1.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="break-all">{error}</span>
          </p>
        </div>
      )}

      {empty.length > 0 && (
        <p className="text-[11px] text-gray-400 leading-relaxed">
          还有 {empty.length} 个类别本机没有数据（
          {empty.map((c) => c.label).join('、')}），因此它们不会出现在备份里。
        </p>
      )}
    </div>
  );
};

export default BackupSettings;
