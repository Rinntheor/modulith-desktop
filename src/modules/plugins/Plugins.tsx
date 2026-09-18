// src/modules/plugins/Plugins.tsx
// 插件管理：市场式卡片布局，完整的安装 / 启用 / 禁用 / 卸载 / 导出生命周期

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Package,
  Search,
  Upload,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  XCircle,
  Grid3X3,
  List,
  ChevronDown,
  FileArchive,
  FolderOpen,
  Link2,
  BookOpen,
  Power,
  PowerOff,
  AlertTriangle,
  Puzzle,
  Box,
  Trash2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { moduleManager } from '../../services/moduleManager';
import { getCachedSettings } from '../../services/appSettings';
import { getPluginModuleIds, isPluginCatalogLoading, subscribeCatalog } from '../../services/moduleCatalog';
import {
  getInstalledPlugins,
  getLoadStates,
  hasPluginRuntimeLoaded,
  reloadPluginRuntime,
  installPluginFromPackage,
  installPluginFromFolder,
  installPluginFromUrl,
  setPluginEnabled,
  uninstallPlugin,
  subscribePlugins,
  type InstalledPlugin,
  type PluginLoadState,
} from '../../services/pluginRuntime';
import PluginCard from './PluginCard';
import PluginDetailDrawer from './PluginDetailDrawer';
import DevGuide from './DevGuide';
import IconPlate from '../../components/icons/IconPlate';
import { subscribeFileDrop, isFileDropAvailable } from '../../services/fileDrop';
import { useModuleActive } from '../../hooks/useModuleActive';

type FilterTab = 'all' | 'enabled' | 'disabled' | 'error';
type SortMode = 'name' | 'version' | 'installed' | 'status';
type ViewMode = 'grid' | 'list';

interface Feedback {
  kind: 'success' | 'error';
  message: string;
}

// ============================================================
// 统计卡片
// ============================================================

const StatCard: React.FC<{
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  index: number;
}> = ({ label, value, icon: Icon, tone, index }) => (
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: index * 0.04 }}
    className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 px-4 py-3"
  >
    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tone}`}>
      <Icon className="w-4 h-4" />
    </div>
    <div>
      <p className="text-lg font-semibold text-gray-900 leading-none">{value}</p>
      <p className="text-[11px] text-gray-500 mt-1">{label}</p>
    </div>
  </motion.div>
);

// ============================================================
// 安装菜单
// ============================================================

const InstallMenu: React.FC<{
  busy: boolean;
  onFromFile: () => void;
  onFromFolder: () => void;
  onFromUrl: () => void;
}> = ({ busy, onFromFile, onFromFolder, onFromUrl }) => {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const items = [
    { label: '从插件包安装…', hint: '.lcp / .zip', icon: FileArchive, onClick: onFromFile },
    { label: '从本地目录安装…', hint: '开发调试', icon: FolderOpen, onClick: onFromFolder },
    { label: '从 URL 安装…', hint: 'https://', icon: Link2, onClick: onFromUrl },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50"
      >
        <Upload className="w-4 h-4" />
        <span>安装插件</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 mt-2 z-30 w-64 bg-white/95 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-200/70 py-1.5 overflow-hidden"
          >
            {items.map((item) => (
              <button
                key={item.label}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className="w-full flex items-center gap-3 px-3.5 py-2.5 text-sm text-left text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <item.icon className="w-4 h-4 text-gray-400 shrink-0" />
                <span className="flex-1">{item.label}</span>
                <span className="text-[10px] text-gray-400 font-mono shrink-0">{item.hint}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ============================================================
// 确认弹窗
// ============================================================

const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ open, title, message, confirmLabel, busy, onConfirm, onCancel }) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onCancel}
          className="fixed inset-0 bg-gray-900/40 backdrop-blur-[2px] z-60"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-60 w-full max-w-md bg-white rounded-2xl shadow-2xl p-5"
        >
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
              <Trash2 className="w-4 h-4 text-red-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-gray-900">{title}</h3>
              <div className="text-sm text-gray-600 mt-1.5 leading-relaxed">{message}</div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <button
              onClick={onCancel}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={onConfirm}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {busy ? '处理中…' : confirmLabel}
            </button>
          </div>
        </motion.div>
      </>
    )}
  </AnimatePresence>
);

// ============================================================
// URL 安装弹窗
// ============================================================

const UrlDialog: React.FC<{
  open: boolean;
  busy: boolean;
  onSubmit: (url: string) => void;
  onCancel: () => void;
}> = ({ open, busy, onSubmit, onCancel }) => {
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (open) setUrl('');
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
            className="fixed inset-0 bg-gray-900/40 backdrop-blur-[2px] z-60"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-60 w-full max-w-md bg-white rounded-2xl shadow-2xl p-5"
          >
            <h3 className="font-semibold text-gray-900">从 URL 安装插件</h3>
            <p className="text-xs text-gray-500 mt-1">
              输入插件包（.lcp / .zip）的直链地址，应用会下载并校验后再安装。
            </p>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url.trim()) onSubmit(url.trim());
              }}
              placeholder="https://example.com/my-plugin.lcp"
              className="mt-3 w-full px-3 py-2.5 text-sm font-mono bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={onCancel}
                disabled={busy}
                className="px-4 py-2 text-sm rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => url.trim() && onSubmit(url.trim())}
                disabled={busy || !url.trim()}
                className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
              >
                {busy ? '下载中…' : '安装'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

// ============================================================
// 拖放安装
// ============================================================

/**
 * 判定拖入的路径应当按「插件包」还是「本地目录」安装。
 *
 * 前端拿到的只有字符串路径，无法 stat，因此只能按扩展名判断：
 * `.lcp` / `.zip` 视作包，其余一律交给「从目录安装」（后端会明确报错
 * 「插件目录不存在」，比猜错方向的错误信息更准确）。
 */
function looksLikePackage(path: string): boolean {
  return /\.(lcp|zip)$/i.test(path);
}

/**
 * 同一次拖放事件的去重标记。
 *
 * 为什么需要：`Plugins` 可能**同时挂载两份** —— 一份是插件标签页里的模块，
 * 一份是设置对话框「插件」分页里内嵌的那个。两者都认为自己是可见的，
 * 于是同一次拖放会被两个订阅者各处理一遍：装两遍、重载两次运行时。
 *
 * `subscribeFileDrop` 把**同一个**事件对象扇出给所有订阅者，因此用引用相等
 * 去重是可靠的（见 fileDrop.ts 的 normalize + 循环分发）。
 */
let lastHandledDrop: object | null = null;

// ============================================================
// 主页面
// ============================================================

const Plugins: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  /** 该模块所在的标签页当前是否真的对用户可见（供拖放等窗口级事件判断） */
  const moduleActive = useModuleActive();
  const [plugins, setPlugins] = useState<InstalledPlugin[]>(getInstalledPlugins());
  const [loadStates, setLoadStates] = useState<Map<string, PluginLoadState>>(getLoadStates());
  const [loading, setLoading] = useState(false);
  /** 插件目录是否正在后台加载（`runtimeLoadedOnce` 为假时也算「还没就绪」） */
  const [catalogLoading, setCatalogLoading] = useState(() => isPluginCatalogLoading());
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<FilterTab>('all');
  const [category, setCategory] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [detail, setDetail] = useState<InstalledPlugin | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledPlugin | null>(null);
  const [devGuideOpen, setDevGuideOpen] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  /** 有文件正被拖到窗口上方（控制拖放提示层的显隐） */
  const [dropActive, setDropActive] = useState(false);

  const flash = useCallback((kind: Feedback['kind'], message: string, ms = 5000) => {
    setFeedback({ kind, message });
    setTimeout(() => setFeedback(null), ms);
  }, []);

  const sync = useCallback(() => {
    setPlugins([...getInstalledPlugins()]);
    setLoadStates(new Map(getLoadStates()));
  }, []);

  // 订阅运行时状态变化
  useEffect(() => {
    const unsubscribe = subscribePlugins(sync);
    return unsubscribe;
  }, [sync]);

  // 订阅模块目录：插件后台加载开始/结束都要让「是否还在加载」重新求值
  useEffect(
    () => subscribeCatalog(() => setCatalogLoading(isPluginCatalogLoading())),
    []
  );

  /**
   * 重新加载插件运行时（重新读列表 + 重新执行每个启用的插件）。
   *
   * 只应由**显式动作**触发：用户点刷新按钮、或安装/启用/禁用/卸载之后。
   */
  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        await reloadPluginRuntime();
        moduleManager.reloadCatalog();
        sync();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setFeedback({ kind: 'error', message: `读取插件列表失败：${message}` });
      } finally {
        setLoading(false);
      }
    },
    [sync]
  );

  /**
   * 挂载时**只同步已有状态，绝不重载插件运行时**。
   *
   * 这里曾经是 `useEffect(() => { refresh(); }, [])`。那意味着每次打开
   * 「设置 → 插件」都会把整个插件运行时拆掉重建：`reloadPluginRuntime()`
   * 第一步就 `clearDynamicModules()`，于是侧边栏里的插件模块全部消失、随后
   * 又被逐个重新注册并重新排序 —— 用户看到的是「一进插件设置，侧边栏就刷新
   * 重排」。顺带还会触发 tabStore 的目录对账，把插件的标签页判为失效。
   *
   * 插件运行时在启动阶段就已经加载好了（见 boot 的 plugins 步骤），
   * 这个页面只需要读它当前的状态；`subscribePlugins` 会把后续变化推过来。
   */
  useEffect(() => {
    sync();
  }, [sync]);

  const afterMutation = useCallback(() => {
    sync();
    moduleManager.reloadCatalog();
  }, [sync]);

  // ---------- 操作 ----------

  const handleInstallFromFile = useCallback(async () => {
    try {
      const path = await invoke<string | null>('pick_plugin_package');
      if (!path) return;
      setInstallBusy(true);
      const plugin = await installPluginFromPackage(path);
      afterMutation();
      flash('success', `已安装插件「${plugin.manifest.displayName || plugin.id}」v${plugin.version}`);
    } catch (err) {
      flash('error', `安装失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstallBusy(false);
    }
  }, [afterMutation, flash]);

  const handleInstallFromFolder = useCallback(async () => {
    try {
      const path = await invoke<string | null>('pick_plugin_folder');
      if (!path) return;
      setInstallBusy(true);
      const plugin = await installPluginFromFolder(path);
      afterMutation();
      flash('success', `已从目录安装「${plugin.manifest.displayName || plugin.id}」`);
    } catch (err) {
      flash('error', `安装失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstallBusy(false);
    }
  }, [afterMutation, flash]);

  const handleInstallFromUrl = useCallback(
    async (url: string) => {
      try {
        setInstallBusy(true);
        const plugin = await installPluginFromUrl(url);
        setUrlDialogOpen(false);
        afterMutation();
        flash('success', `已安装插件「${plugin.manifest.displayName || plugin.id}」`);
      } catch (err) {
        flash('error', `安装失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setInstallBusy(false);
      }
    },
    [afterMutation, flash]
  );

  /**
   * 拖放安装：一次拖入的每一个路径都尝试安装，逐个汇报结果。
   *
   * 为什么不「有一个失败就整体放弃」：多选拖入时，其中一个是无关文件（例如
   * 顺手把 README 拖了进来）很常见，因为一个无关文件把已经成功的安装回滚掉
   * 既做不到（后端已经落盘）也没有意义。逐个安装并如实列出失败原因更诚实。
   */
  const installDroppedPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;

      setInstallBusy(true);
      // `installBusy` 控制着「安装插件」按钮的禁用状态，也决定后续拖放要不要受理。
      // **必须放在 finally 里复位**：漏掉它的话，拖放安装一次之后这个标志就永远
      // 停在 true —— 安装按钮再也点不动、再拖也没反应，只有重开设置（组件重新
      // 挂载、state 归零）才能恢复。（这里原先就是漏了，正是用户遇到的现象。）
      try {
        const installed: string[] = [];
        const failed: string[] = [];

        for (const path of paths) {
          try {
            const plugin = looksLikePackage(path)
              ? await installPluginFromPackage(path)
              : await installPluginFromFolder(path);
            installed.push(`「${plugin.manifest.displayName || plugin.id}」`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // 只报文件名：完整路径通常很长，而反馈条本身空间有限
            const label = path.split(/[\\/]/).pop() || path;
            failed.push(`${label}（${message}）`);
          }
        }

        afterMutation();

        if (failed.length === 0) {
          flash(
            'success',
            installed.length === 1
              ? `已安装插件${installed[0]}`
              : `已安装 ${installed.length} 个插件：${installed.join('、')}`
          );
        } else if (installed.length === 0) {
          flash('error', `安装失败：${failed.join('；')}`, 9000);
        } else {
          flash(
            'error',
            `已安装 ${installed.length} 个（${installed.join('、')}），但有 ${failed.length} 个失败：${failed.join('；')}`,
            9000
          );
        }
      } finally {
        setInstallBusy(false);
      }
    },
    [afterMutation, flash]
  );

  /**
   * 本页面是否应当接受拖放。
   *
   * 两种「可见」的情形必须区分开：
   *   · 作为插件标签页显示时，用 `useModuleActive()` —— 它同时考虑「标签是否
   *     激活」与「窗口是否可见」。后台标签不能抢走本该属于别人的拖放。
   *   · 作为设置对话框的分页内嵌时（`embedded`），标签页的激活状态与它无关：
   *     对话框是模态的、开着就说明它就在用户眼前，因此直接放行。
   */
  const acceptDrop = embedded || moduleActive;

  useEffect(() => {
    if (!acceptDrop || !isFileDropAvailable()) return;

    const unsubscribe = subscribeFileDrop((event) => {
      if (event.type === 'enter' || event.type === 'over') {
        setDropActive(true);
        return;
      }
      if (event.type === 'leave') {
        setDropActive(false);
        return;
      }

      // drop
      setDropActive(false);

      // 同一次拖放只处理一遍（可能同时挂载了标签页与设置页两份实例）
      if (lastHandledDrop === event) return;
      lastHandledDrop = event;

      if (installBusy) return;
      void installDroppedPaths(event.paths);
    });

    return unsubscribe;
  }, [acceptDrop, installBusy, installDroppedPaths]);

  const handleToggleEnabled = useCallback(
    async (plugin: InstalledPlugin, enabled: boolean) => {
      setBusyId(plugin.id);
      try {
        await setPluginEnabled(plugin.id, enabled);
        afterMutation();
        flash('success', `${enabled ? '已启用' : '已禁用'}插件「${plugin.manifest.displayName || plugin.id}」`);
      } catch (err) {
        flash('error', `操作失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [afterMutation, flash]
  );

  const handleUninstall = useCallback(
    async (target: InstalledPlugin) => {
      setBusyId(target.id);
      try {
        await uninstallPlugin(target.id);
        setPendingUninstall(null);
        setDetail(null);
        afterMutation();
        flash('success', `已卸载插件「${target.manifest.displayName || target.id}」`);
      } catch (err) {
        flash('error', `卸载失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [afterMutation, flash]
  );

  /** 依据设置里的「卸载前二次确认」决定弹确认框还是直接卸载 */
  const requestUninstall = useCallback(
    (plugin: InstalledPlugin) => {
      if (getCachedSettings().confirmBeforeUninstall) {
        setPendingUninstall(plugin);
      } else {
        void handleUninstall(plugin);
      }
    },
    [handleUninstall]
  );

  const handleExport = useCallback(
    async (plugin: InstalledPlugin) => {
      setBusyId(plugin.id);
      try {
        const outcome = await invoke<{ cancelled: boolean; path: string | null; bytes: number }>(
          'export_plugin',
          { id: plugin.id, dest: null }
        );
        if (outcome.cancelled) {
          flash('success', '已取消导出');
        } else {
          flash('success', `已导出到 ${outcome.path}`);
        }
      } catch (err) {
        flash('error', `导出失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [flash]
  );

  // ---------- 派生数据 ----------

  const categories = useMemo(() => {
    const set = new Set<string>();
    plugins.forEach((p) => (p.manifest.categories ?? []).forEach((c) => set.add(c)));
    return [...set].sort();
  }, [plugins]);

  const counts = useMemo(
    () => ({
      all: plugins.length,
      enabled: plugins.filter((p) => p.enabled).length,
      disabled: plugins.filter((p) => !p.enabled).length,
      error: plugins.filter((p) => loadStates.get(p.id)?.status === 'error').length,
    }),
    [plugins, loadStates]
  );

  const visible = useMemo(() => {
    let list = [...plugins];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (p) =>
          p.id.toLowerCase().includes(q) ||
          (p.manifest.displayName ?? '').toLowerCase().includes(q) ||
          (p.manifest.description ?? '').toLowerCase().includes(q) ||
          (p.manifest.keywords ?? []).some((k) => k.toLowerCase().includes(q))
      );
    }

    if (tab === 'enabled') list = list.filter((p) => p.enabled);
    else if (tab === 'disabled') list = list.filter((p) => !p.enabled);
    else if (tab === 'error') list = list.filter((p) => loadStates.get(p.id)?.status === 'error');

    if (category) list = list.filter((p) => (p.manifest.categories ?? []).includes(category));

    list.sort((a, b) => {
      let cmp = 0;
      if (sortMode === 'name') {
        cmp = (a.manifest.displayName || a.id).localeCompare(b.manifest.displayName || b.id);
      } else if (sortMode === 'version') {
        cmp = a.version.localeCompare(b.version, undefined, { numeric: true });
      } else if (sortMode === 'installed') {
        cmp = new Date(a.installedAt).getTime() - new Date(b.installedAt).getTime();
      } else {
        cmp = Number(a.enabled) - Number(b.enabled);
      }
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [plugins, search, tab, category, sortMode, sortAsc, loadStates]);

  const tabs: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: '全部', count: counts.all },
    { id: 'enabled', label: '已启用', count: counts.enabled },
    { id: 'disabled', label: '已禁用', count: counts.disabled },
    { id: 'error', label: '异常', count: counts.error },
  ];

  /**
   * 是否应当显示「加载中」而不是「还没有安装任何插件」。
   *
   * 两种情况都算未就绪：目录正在后台加载，或者一次都还没加载完
   * （用户可能在后台加载开始之前就打开了这个页面）。
   * 没装任何插件时的空状态是**结论性**的提示，不能在还没读完列表时显示。
   */
  const notReady = catalogLoading || !hasPluginRuntimeLoaded();
  const showSpinner = plugins.length === 0 && (loading || notReady);

  return (
    <div className={embedded ? 'px-6 py-4' : 'max-w-7xl mx-auto px-4 py-6'}>
      {/* 响应式区域：改用容器查询，按「插件区实际可用宽度」排版而不是按窗口宽度。
          设置弹窗内的插件页只有 ~700px 宽，但窗口可能是 1920px，用 lg:/xl: 这类
          视口断点会让卡片被挤成一团（全屏反而比非全屏更糟）。
          注意：container-type 会让该元素成为 fixed 后代的包含块，
          所以下面的抽屉 / 确认框等弹窗必须留在这个 div 之外。 */}
      <div className="@container">
      {/* 头部：嵌入设置时只保留操作按钮，标题由外层提供 */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          {!embedded && (
            <div className="flex items-center space-x-3">
              <IconPlate icon={Puzzle} size="lg" />
              <div>
                <h1 className="text-2xl font-bold text-gray-900">插件</h1>
                <p className="text-sm text-gray-500">
                  按需扩展 Modulith：安装、启用、禁用与卸载插件，禁用后不影响启动
                </p>
              </div>
            </div>
          )}

          <div className={`flex items-center gap-2 ${embedded ? 'ml-auto' : ''}`}>
            <button
              onClick={() => setDevGuideOpen(true)}
              className="flex items-center gap-2 px-3.5 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-colors"
            >
              <BookOpen className="w-4 h-4" />
              <span>开发指南</span>
            </button>
            <button
              onClick={() => refresh()}
              disabled={loading}
              title="重新读取插件列表"
              className="p-2.5 bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <InstallMenu
              busy={installBusy}
              onFromFile={handleInstallFromFile}
              onFromFolder={handleInstallFromFolder}
              onFromUrl={() => setUrlDialogOpen(true)}
            />
          </div>
        </div>
      </motion.div>

      {/* 反馈 */}
      <AnimatePresence>
        {feedback && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className={`mb-5 p-3.5 rounded-xl flex items-start gap-3 border ${
              feedback.kind === 'error'
                ? 'bg-red-50 border-red-200'
                : 'bg-emerald-50 border-emerald-200'
            }`}
          >
            {feedback.kind === 'error' ? (
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
            )}
            <span
              className={`flex-1 text-sm break-all ${
                feedback.kind === 'error' ? 'text-red-700' : 'text-emerald-700'
              }`}
            >
              {feedback.message}
            </span>
            <button onClick={() => setFeedback(null)} className="shrink-0">
              <XCircle className="w-4 h-4 text-gray-400 hover:text-gray-600" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 统计 */}
      <div className="grid grid-cols-2 @3xl:grid-cols-4 gap-3 mb-6">
        <StatCard label="已安装" value={counts.all} icon={Package} tone="bg-indigo-50 text-indigo-600" index={0} />
        <StatCard label="已启用" value={counts.enabled} icon={Power} tone="bg-emerald-50 text-emerald-600" index={1} />
        <StatCard label="已禁用" value={counts.disabled} icon={PowerOff} tone="bg-gray-100 text-gray-500" index={2} />
        <StatCard label="加载异常" value={counts.error} icon={AlertTriangle} tone="bg-red-50 text-red-600" index={3} />
      </div>

      {showSpinner ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : plugins.length === 0 ? (
        /* 空状态 */
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl border border-dashed border-gray-300 py-16 px-6 text-center"
        >
          <IconPlate icon={Box} size="xl" className="mx-auto" />
          <h2 className="mt-4 text-lg font-semibold text-gray-900">还没有安装任何插件</h2>
          <p className="mt-1.5 text-sm text-gray-500 max-w-lg mx-auto leading-relaxed">
            Modulith 是一个高自由度的框架：你需要什么功能，就装什么插件。
            插件包是 <code className="font-mono text-indigo-600">.lcp</code>（一个 zip），
            安装后会立刻出现在侧边栏与仪表盘中。
          </p>
          <div className="mt-6 flex items-center justify-center gap-2 flex-wrap">
            <button
              onClick={handleInstallFromFile}
              disabled={installBusy}
              className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50"
            >
              <FileArchive className="w-4 h-4" />
              从插件包安装
            </button>
            <button
              onClick={handleInstallFromFolder}
              disabled={installBusy}
              className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <FolderOpen className="w-4 h-4" />
              从目录安装
            </button>
            <button
              onClick={() => setDevGuideOpen(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-colors"
            >
              <BookOpen className="w-4 h-4" />
              学习如何开发插件
            </button>
          </div>
        </motion.div>
      ) : (
        <div className="flex gap-6 items-start">
          {/* 左侧筛选栏 */}
          {categories.length > 0 && (
            <aside className="hidden @4xl:block w-48 shrink-0">
              <div className="bg-white rounded-xl border border-gray-200 p-2 sticky top-4">
                <p className="px-2.5 py-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                  分类
                </p>
                <button
                  onClick={() => setCategory(null)}
                  className={`w-full text-left px-2.5 py-1.5 text-sm rounded-lg transition-colors ${
                    category === null
                      ? 'bg-indigo-50 text-indigo-700 font-medium'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  全部分类
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setCategory(cat === category ? null : cat)}
                    className={`w-full text-left px-2.5 py-1.5 text-sm rounded-lg transition-colors truncate ${
                      category === cat
                        ? 'bg-indigo-50 text-indigo-700 font-medium'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </aside>
          )}

          {/* 主区 */}
          <div className="flex-1 min-w-0">
            {/* 工具栏 */}
            <div className="bg-white rounded-xl border border-gray-200 p-3 mb-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center space-x-1 bg-gray-100 rounded-xl p-1">
                  {tabs.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      className={`px-3.5 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                        tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      {t.label}
                      <span className="ml-1.5 text-xs text-gray-400">{t.count}</span>
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="搜索插件…"
                      className="w-40 @2xl:w-56 pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>

                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-600 focus:outline-none cursor-pointer"
                  >
                    <option value="name">按名称</option>
                    <option value="version">按版本</option>
                    <option value="installed">按安装时间</option>
                    <option value="status">按启用状态</option>
                  </select>

                  <button
                    onClick={() => setSortAsc((v) => !v)}
                    title={sortAsc ? '升序' : '降序'}
                    className="p-2 bg-gray-50 border border-gray-200 rounded-xl hover:bg-gray-100 transition-colors"
                  >
                    <ChevronDown
                      className={`w-4 h-4 text-gray-600 transition-transform ${sortAsc ? 'rotate-180' : ''}`}
                    />
                  </button>

                  <div className="flex bg-gray-100 rounded-xl p-1">
                    <button
                      onClick={() => setViewMode('grid')}
                      className={`p-1.5 rounded-lg transition-colors ${
                        viewMode === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-gray-500'
                      }`}
                    >
                      <Grid3X3 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setViewMode('list')}
                      className={`p-1.5 rounded-lg transition-colors ${
                        viewMode === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'text-gray-500'
                      }`}
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 列表 */}
            {visible.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 py-14 text-center">
                <Search className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500">
                  {search ? `没有匹配「${search}」的插件` : '当前筛选条件下没有插件'}
                </p>
              </div>
            ) : (
              <div
                className={
                  viewMode === 'grid'
                    ? 'grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4'
                    : 'space-y-2'
                }
              >
                {visible.map((plugin) => (
                  <PluginCard
                    key={plugin.id}
                    plugin={plugin}
                    viewMode={viewMode}
                    loadState={loadStates.get(plugin.id)}
                    moduleIds={getPluginModuleIds(plugin.id)}
                    busy={busyId === plugin.id}
                    onToggleEnabled={handleToggleEnabled}
                    onOpenDetail={setDetail}
                    onExport={handleExport}
                    onUninstall={requestUninstall}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      </div>

      {/*
        拖放提示层。
        **必须留在这个 `@container` 之外**：container-type 会让该元素成为
        fixed 后代的包含块，放在里面就会以插件区（而不是窗口）为定位基准 ——
        与上面那条「抽屉 / 确认框必须留在这个 div 之外」是同一个原因。
      */}
      <AnimatePresence>
        {dropActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            data-testid="plugin-drop-overlay"
            className="pointer-events-none fixed inset-0 z-70 flex items-center justify-center bg-indigo-600/10 backdrop-blur-[1px]"
          >
            <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-indigo-400 bg-white/95 px-10 py-8 shadow-2xl">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50">
                <Upload className="h-5 w-5 text-indigo-600" />
              </div>
              <p className="text-sm font-medium text-gray-900">松开即可安装插件</p>
              <p className="text-xs text-gray-500 leading-relaxed text-center max-w-xs">
                支持 <code className="font-mono text-indigo-600">.lcp</code> /{' '}
                <code className="font-mono text-indigo-600">.zip</code> 插件包；
                <br />
                拖入一个插件目录会按「从目录安装」处理，并自动启用开发链接。
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 详情抽屉 */}
      <PluginDetailDrawer
        plugin={detail}
        loadState={detail ? loadStates.get(detail.id) : undefined}
        moduleIds={detail ? getPluginModuleIds(detail.id) : []}
        busy={detail ? busyId === detail.id : false}
        onClose={() => setDetail(null)}
        onToggleEnabled={handleToggleEnabled}
        onExport={handleExport}
        onUninstall={requestUninstall}
      />

      {/* 卸载确认 */}
      <ConfirmDialog
        open={pendingUninstall !== null}
        title="卸载插件"
        message={
          pendingUninstall && (
            <>
              确定要卸载「
              <strong>{pendingUninstall.manifest.displayName || pendingUninstall.id}</strong>
              」吗？插件的文件与存储数据都会被删除，此操作不可撤销。
            </>
          )
        }
        confirmLabel="卸载"
        busy={pendingUninstall ? busyId === pendingUninstall.id : false}
        onConfirm={() => {
          if (pendingUninstall) void handleUninstall(pendingUninstall);
        }}
        onCancel={() => setPendingUninstall(null)}
      />

      {/* URL 安装 */}
      <UrlDialog
        open={urlDialogOpen}
        busy={installBusy}
        onSubmit={handleInstallFromUrl}
        onCancel={() => setUrlDialogOpen(false)}
      />

      {/* 开发指南 */}
      <DevGuide open={devGuideOpen} onClose={() => setDevGuideOpen(false)} />
    </div>
  );
};

export default Plugins;
