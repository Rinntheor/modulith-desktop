// src/modules/plugins/PluginCard.tsx
// 插件卡片（网格视图）与紧凑行（列表视图）

import React, { memo, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download,
  Info,
  MoreVertical,
  Trash2,
  AlertTriangle,
  Layers,
  Copy,
  Check,
} from 'lucide-react';
import PluginIcon from './PluginIcon';
import {
  STATUS_INFO,
  formatAuthor,
  formatBytes,
  formatRelativeTime,
  getPermissionInfo,
} from './pluginMeta';
import type { InstalledPlugin, PluginLoadState } from '../../services/pluginRuntime';

export interface PluginCardProps {
  plugin: InstalledPlugin;
  viewMode: 'grid' | 'list';
  loadState?: PluginLoadState;
  moduleIds: string[];
  busy: boolean;
  onToggleEnabled: (plugin: InstalledPlugin, enabled: boolean) => void;
  onOpenDetail: (plugin: InstalledPlugin) => void;
  onExport: (plugin: InstalledPlugin) => void;
  onUninstall: (plugin: InstalledPlugin) => void;
}

/** 下拉菜单，点击外部或 ESC 关闭 */
const MoreMenu: React.FC<{
  plugin: InstalledPlugin;
  busy: boolean;
  onOpenDetail: () => void;
  onExport: () => void;
  onUninstall: () => void;
}> = ({ plugin, busy, onOpenDetail, onExport, onUninstall }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const items = [
    {
      label: '详情',
      icon: Info,
      onClick: () => {
        setOpen(false);
        onOpenDetail();
      },
    },
    {
      label: '导出为插件包…',
      icon: Download,
      onClick: () => {
        setOpen(false);
        onExport();
      },
    },
    {
      label: copied ? '已复制' : '复制插件 ID',
      icon: copied ? Check : Copy,
      onClick: () => {
        navigator.clipboard?.writeText(plugin.id).then(
          () => setCopied(true),
          () => setCopied(false)
        );
        setTimeout(() => setCopied(false), 1500);
      },
    },
    { type: 'divider' as const },
    {
      label: '卸载插件',
      icon: Trash2,
      danger: true,
      onClick: () => {
        setOpen(false);
        onUninstall();
      },
    },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title="更多操作"
        className="p-2 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors disabled:opacity-40"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 mt-1 z-30 w-52 bg-white/95 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-200/70 py-1.5 overflow-hidden"
          >
            {items.map((item, index) => {
              if ('type' in item && item.type === 'divider') {
                return <div key={`d-${index}`} className="my-1 border-t border-gray-100" />;
              }
              const entry = item as {
                label: string;
                icon: React.ComponentType<{ className?: string }>;
                danger?: boolean;
                onClick: () => void;
              };
              return (
                <button
                  key={entry.label}
                  onClick={entry.onClick}
                  className={`w-full flex items-center space-x-3 px-3.5 py-2 text-sm text-left transition-colors ${
                    entry.danger
                      ? 'text-red-600 hover:bg-red-50'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <entry.icon className="w-4 h-4 shrink-0" />
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/** 启用开关 */
const EnableSwitch: React.FC<{
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}> = ({ checked, disabled, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    title={checked ? '点击禁用' : '点击启用'}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${
      checked ? 'bg-indigo-600' : 'bg-gray-300'
    }`}
  >
    <motion.span
      initial={false}
      animate={{ x: checked ? 16 : 2 }}
      transition={{ type: 'spring', stiffness: 600, damping: 35 }}
      className="inline-block h-4 w-4 rounded-full bg-white shadow"
    />
  </button>
);

const PermissionChips: React.FC<{ permissions: string[]; max?: number }> = ({
  permissions,
  max = 3,
}) => {
  if (permissions.length === 0) {
    return <span className="text-xs text-gray-400">未申请任何权限</span>;
  }
  const shown = permissions.slice(0, max);
  const rest = permissions.length - shown.length;

  return (
    <div className="flex items-center flex-wrap gap-1">
      {shown.map((perm) => {
        const info = getPermissionInfo(perm);
        const tone =
          info.risk === 'high'
            ? 'bg-red-50 text-red-700 border-red-200'
            : info.risk === 'medium'
              ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-gray-50 text-gray-600 border-gray-200';
        return (
          <span
            key={perm}
            title={info.description}
            className={`px-1.5 py-0.5 text-[11px] font-medium rounded border ${tone}`}
          >
            {info.label}
          </span>
        );
      })}
      {rest > 0 && (
        <span className="px-1.5 py-0.5 text-[11px] rounded border border-gray-200 text-gray-500">
          +{rest}
        </span>
      )}
    </div>
  );
};

const LoadErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-start space-x-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200">
    <AlertTriangle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
    <p className="text-[11px] text-red-700 leading-relaxed break-all">{message}</p>
  </div>
);

/**
 * 引擎范围提示。
 *
 * 用琥珀色而**不是红色**，措辞也说「可能」而不是「无法使用」：
 * 后端只把它当提示，不阻止安装与加载。`engines.loopcore` 在 0.x 阶段很脆弱
 * （`^0.2.0` 等价于 `>=0.2.0 <0.3.0`，宿主升一个小版本就会不匹配），
 * 把这种声明层面的差异渲染成「不兼容」会让用户误以为插件已损坏。
 * 插件真的跑不起来时，会以加载失败（红色）的形式单独呈现。
 */
const EngineAdvisoryBanner: React.FC<{ required: string; host: string }> = ({
  required,
  host,
}) => (
  <div className="flex items-start space-x-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
    <Info className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
    <p className="text-[11px] text-amber-800 leading-relaxed">
      该插件声明需要 Modulith <span className="font-mono">{required}</span>，
      当前为 <span className="font-mono">{host}</span>。仍会正常加载；
      若运行出错会在上方以加载失败的形式提示。
    </p>
  </div>
);

const PluginCard: React.FC<PluginCardProps> = memo(
  ({
    plugin,
    viewMode,
    loadState,
    moduleIds,
    busy,
    onToggleEnabled,
    onOpenDetail,
    onExport,
    onUninstall,
  }) => {
    const status = STATUS_INFO[plugin.status] ?? STATUS_INFO.disabled;
    const permissions = plugin.manifest.permissions ?? [];
    const categories = plugin.manifest.categories ?? [];
    const hasLoadError = loadState?.status === 'error';

    if (viewMode === 'list') {
      return (
        <div className="group bg-white rounded-xl border border-gray-200 hover:border-indigo-200 hover:shadow-sm transition-all px-4 py-3">
          <div className="flex items-center gap-4">
            <PluginIcon pluginId={plugin.id} manifest={plugin.manifest} size="sm" />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900 truncate">
                  {plugin.manifest.displayName || plugin.id}
                </h3>
                <span className="px-1.5 py-0.5 text-[11px] font-mono rounded bg-gray-100 text-gray-600 shrink-0">
                  v{plugin.version}
                </span>
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded-full border shrink-0 ${status.className}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${status.dotClassName}`} />
                  {status.label}
                </span>
              </div>
              <p className="text-sm text-gray-500 truncate mt-0.5">{plugin.manifest.description}</p>
            </div>

            <div className="hidden @3xl:flex flex-col items-end gap-1 shrink-0 w-44">
              <span className="text-xs text-gray-400 truncate max-w-full">
                {formatAuthor(plugin.manifest.author)}
              </span>
              <PermissionChips permissions={permissions} max={2} />
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <EnableSwitch
                checked={plugin.enabled}
                disabled={busy}
                onChange={(next) => onToggleEnabled(plugin, next)}
              />
              <button
                onClick={() => onOpenDetail(plugin)}
                title="详情"
                className="p-2 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
              >
                <Info className="w-4 h-4" />
              </button>
              <MoreMenu
                plugin={plugin}
                busy={busy}
                onOpenDetail={() => onOpenDetail(plugin)}
                onExport={() => onExport(plugin)}
                onUninstall={() => onUninstall(plugin)}
              />
            </div>
          </div>

          {plugin.engineAdvisory && (
            <div className="mt-2">
              <EngineAdvisoryBanner
                required={plugin.engineAdvisory.required}
                host={plugin.engineAdvisory.host}
              />
            </div>
          )}

          {hasLoadError && (
            <div className="mt-2">
              <LoadErrorBanner message={loadState!.error ?? '未知错误'} />
            </div>
          )}
        </div>
      );
    }

    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="group relative flex flex-col bg-white rounded-2xl border border-gray-200 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-100/40 transition-all duration-200 p-4"
      >
        <div className="flex items-start gap-3">
          <PluginIcon pluginId={plugin.id} manifest={plugin.manifest} size="md" />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="font-semibold text-gray-900 truncate max-w-full">
                {plugin.manifest.displayName || plugin.id}
              </h3>
              {plugin.manifest.preview && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-violet-100 text-violet-700">
                  预览版
                </span>
              )}
              {plugin.manifest.deprecated && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-100 text-amber-700">
                  已废弃
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px] font-mono text-gray-500">v{plugin.version}</span>
              <span className="text-[11px] text-gray-400">·</span>
              <span className="text-[11px] text-gray-500 truncate">
                {formatAuthor(plugin.manifest.author)}
              </span>
            </div>
          </div>

          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border shrink-0 ${status.className}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${status.dotClassName}`} />
            {status.label}
          </span>
        </div>

        <p className="mt-3 text-sm text-gray-600 leading-relaxed line-clamp-2 min-h-10">
          {plugin.manifest.description || '该插件没有提供描述'}
        </p>

        {plugin.engineAdvisory && (
          <div className="mt-3">
            <EngineAdvisoryBanner
              required={plugin.engineAdvisory.required}
              host={plugin.engineAdvisory.host}
            />
          </div>
        )}

        {hasLoadError && (
          <div className="mt-3">
            <LoadErrorBanner message={loadState!.error ?? '未知错误'} />
          </div>
        )}

        {categories.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {categories.slice(0, 4).map((cat) => (
              <span
                key={cat}
                className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-50 text-indigo-600"
              >
                {cat}
              </span>
            ))}
          </div>
        )}

        <div className="mt-3">
          <PermissionChips permissions={permissions} />
        </div>

        <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3 text-[11px] text-gray-400 min-w-0">
            <span className="inline-flex items-center gap-1 shrink-0" title="提供者注册的模块数">
              <Layers className="w-3 h-3" />
              {moduleIds.length}
            </span>
            <span className="shrink-0" title="占用磁盘空间">
              {formatBytes(plugin.sizeBytes)}
            </span>
            <span className="truncate" title={`安装于 ${plugin.installedAt}`}>
              {formatRelativeTime(plugin.installedAt)}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <EnableSwitch
              checked={plugin.enabled}
              disabled={busy}
              onChange={(next) => onToggleEnabled(plugin, next)}
            />
            <MoreMenu
              plugin={plugin}
              busy={busy}
              onOpenDetail={() => onOpenDetail(plugin)}
              onExport={() => onExport(plugin)}
              onUninstall={() => onUninstall(plugin)}
            />
          </div>
        </div>
      </motion.div>
    );
  }
);

PluginCard.displayName = 'PluginCard';

export { MoreMenu, EnableSwitch, PermissionChips };
export default PluginCard;
