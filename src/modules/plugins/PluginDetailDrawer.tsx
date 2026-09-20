// src/modules/plugins/PluginDetailDrawer.tsx
// 插件详情抽屉：完整清单信息、权限说明、提供的模块、README

import React, { memo, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Download,
  Trash2,
  FolderOpen,
  ExternalLink,
  ShieldCheck,
  Layers,
  AlertTriangle,
  FileText,
  Info,
  Power,
} from 'lucide-react';
import { openPath } from '@tauri-apps/plugin-opener';
import PluginIcon from './PluginIcon';
import {
  STATUS_INFO,
  formatAuthor,
  formatBytes,
  formatDate,
  formatRelativeTime,
} from './pluginMeta';
import { getPermissionDescriptor } from '../../services/permissionRegistry';
import { DRAWER_ENTER, DRAWER_EXIT } from '../../utils/motionCurves';
import Markdown from '../../components/Markdown';
import type { InstalledPlugin, PluginLoadState } from '../../services/pluginRuntime';
import { readPluginReadme } from '../../services/pluginRuntime';

interface PluginDetailDrawerProps {
  plugin: InstalledPlugin | null;
  loadState?: PluginLoadState;
  moduleIds: string[];
  busy: boolean;
  onClose: () => void;
  onToggleEnabled: (plugin: InstalledPlugin, enabled: boolean) => void;
  onExport: (plugin: InstalledPlugin) => void;
  onUninstall: (plugin: InstalledPlugin) => void;
}

// 这里曾有 `SANDBOX_LABELS` 与一行「沙箱级别」的展示。**已删除**：
// 插件与宿主运行在同一个 JS 上下文里，`sandboxLevel` 是一个宿主无法核实的自述字段，
// 把它显示给用户等于给出一句空话 —— 用户会以为宿主能对插件分级管控。
// 权限列表（下面那一块）才是真正说明"这个插件能做什么"的地方。

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
    <span className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{label}</span>
    <span className="flex-1 text-xs text-gray-700 break-all">{children}</span>
  </div>
);

const PluginDetailDrawer: React.FC<PluginDetailDrawerProps> = memo(
  ({
    plugin,
    loadState,
    moduleIds,
    busy,
    onClose,
    onToggleEnabled,
    onExport,
    onUninstall,
  }) => {
    const [openError, setOpenError] = useState<string | null>(null);

    /**
     * README 现在**按需取**，不再是 `InstalledPlugin` 上的一个字段。
     *
     * 为什么：列表每列一次都会把每个插件的 README 读出来再跨 IPC 传过来，500 个
     * 插件是十几 MB 文本 —— 而只有这一处用得到。抽屉打开时才取，关掉就丢弃。
     *
     * `null` 有两种含义（"还没取到"与"这个插件确实没有"），这里用 `undefined`
     * 表示前者，因此区块在取回之前不渲染 —— 与它"没有 README 时不渲染"是同一个
     * 视觉结果，也就不会闪一个空标题出来。
     */
    const [readme, setReadme] = useState<string | null | undefined>(undefined);

    useEffect(() => {
      if (!plugin) return;
      let alive = true;
      setReadme(undefined);
      void readPluginReadme(plugin.id)
        .then((text) => {
          if (alive) setReadme(text);
        })
        .catch(() => {
          // 取不到就当作没有 README：详情页不该因为一个补充性的区块而报错
          if (alive) setReadme(null);
        });
      return () => {
        alive = false;
      };
    }, [plugin]);

    useEffect(() => {
      if (!plugin) return;
      const onEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      };
      document.addEventListener('keydown', onEsc);
      return () => document.removeEventListener('keydown', onEsc);
    }, [plugin, onClose]);

    const handleOpenFolder = async (path: string) => {
      try {
        await openPath(path);
        setOpenError(null);
      } catch (err) {
        setOpenError(err instanceof Error ? err.message : String(err));
      }
    };

    return (
      <AnimatePresence>
        {plugin && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={onClose}
              className="fixed inset-0 bg-gray-900/30 backdrop-blur-[2px] z-50"
            />

            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0, transition: DRAWER_ENTER }}
              exit={{ x: '100%', transition: DRAWER_EXIT }}
              className="fixed right-0 top-0 h-full w-full max-w-[560px] bg-white z-50 flex flex-col shadow-2xl"
            >
              {/* 头部 */}
              <div className="shrink-0 px-6 py-5 border-b border-gray-100">
                <div className="flex items-start gap-4">
                  <PluginIcon pluginId={plugin.id} manifest={plugin.manifest} size="lg" />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-semibold text-gray-900">
                        {plugin.manifest.displayName || plugin.id}
                      </h2>
                      <span className="px-1.5 py-0.5 text-[11px] font-mono rounded bg-gray-100 text-gray-600">
                        v{plugin.version}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 font-mono truncate">{plugin.id}</p>
                    <div className="flex items-center gap-2 mt-2">
                      {(() => {
                        const status = STATUS_INFO[plugin.status] ?? STATUS_INFO.disabled;
                        return (
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border ${status.className}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${status.dotClassName}`} />
                            {status.label}
                          </span>
                        );
                      })()}
                      <span className="text-[11px] text-gray-400">
                        {formatAuthor(plugin.manifest.author)}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={onClose}
                    className="p-2 -mr-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* 操作区 */}
                <div className="mt-4 flex items-center gap-2">
                  <button
                    onClick={() => onToggleEnabled(plugin, !plugin.enabled)}
                    disabled={busy}
                    className={`flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg transition-colors disabled:opacity-50 ${
                      plugin.enabled
                        ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                  >
                    <Power className="w-3.5 h-3.5" />
                    {plugin.enabled ? '禁用' : '启用'}
                  </button>

                  <button
                    onClick={() => onExport(plugin)}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    导出
                  </button>

                  <button
                    onClick={() => handleOpenFolder(plugin.path)}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    {plugin.devSource ? '源目录' : '安装目录'}
                  </button>

                  <button
                    onClick={() => onUninstall(plugin)}
                    disabled={busy}
                    className="ml-auto flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    卸载
                  </button>
                </div>

                {openError && (
                  <p className="mt-2 text-[11px] text-red-600">无法打开目录：{openError}</p>
                )}
              </div>

              {/* 主体 */}
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 custom-scrollbar">
                {loadState?.status === 'error' && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-50 border border-red-200">
                    <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-medium text-red-700">加载失败</p>
                      <p className="text-[11px] text-red-600 mt-0.5 break-all">{loadState.error}</p>
                    </div>
                  </div>
                )}

                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                    描述
                  </h3>
                  <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                    {plugin.manifest.description || '该插件没有提供描述'}
                  </p>
                </section>

                {(plugin.manifest.keywords?.length || plugin.manifest.categories?.length) && (
                  <section>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      分类与标签
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {(plugin.manifest.categories ?? []).map((cat) => (
                        <span
                          key={`cat-${cat}`}
                          className="px-2 py-0.5 text-[11px] rounded bg-indigo-50 text-indigo-600"
                        >
                          {cat}
                        </span>
                      ))}
                      {(plugin.manifest.keywords ?? []).map((kw) => (
                        <span
                          key={`kw-${kw}`}
                          className="px-2 py-0.5 text-[11px] rounded bg-gray-100 text-gray-600"
                        >
                          #{kw}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    权限
                  </h3>
                  {(plugin.manifest.permissions ?? []).length === 0 ? (
                    <p className="text-xs text-gray-500">
                      该插件未申请任何权限，无法访问网络、文件或存储。
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {(plugin.manifest.permissions ?? []).map((perm) => {
                        const info = getPermissionDescriptor(perm);
                        const tone =
                          info.risk === 'high'
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : info.risk === 'medium'
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : 'bg-gray-50 text-gray-600 border-gray-200';
                        return (
                          <div
                            key={perm}
                            className="flex items-start gap-3 px-3 py-2 rounded-lg border border-gray-100 bg-gray-50/50"
                          >
                            <span
                              className={`px-1.5 py-0.5 text-[10px] font-medium rounded border shrink-0 ${tone}`}
                            >
                              {info.risk === 'high'
                                ? '高风险'
                                : info.risk === 'medium'
                                  ? '中风险'
                                  : '低风险'}
                            </span>
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-gray-800">{info.label}</p>
                              <p className="text-[11px] text-gray-500 mt-0.5">{info.description}</p>
                            </div>
                            <code className="ml-auto text-[10px] text-gray-400 shrink-0">{perm}</code>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" />
                    提供的模块
                  </h3>
                  {moduleIds.length === 0 ? (
                    <p className="text-xs text-gray-500">
                      当前没有已加载的模块{plugin.enabled ? '' : '（插件未启用）'}。
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {moduleIds.map((id) => (
                        <span
                          key={id}
                          className="px-2 py-0.5 text-[11px] font-mono rounded bg-emerald-50 text-emerald-700"
                        >
                          {id}
                        </span>
                      ))}
                    </div>
                  )}
                </section>

                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" />
                    详细信息
                  </h3>
                  <div className="rounded-xl border border-gray-100 px-3 py-1">
                    <Row label="版本">{plugin.version}</Row>
                    <Row label="作者">
                      {formatAuthor(plugin.manifest.author)}
                      {plugin.manifest.author?.email ? ` · ${plugin.manifest.author.email}` : ''}
                    </Row>
                    {plugin.manifest.license && <Row label="许可证">{plugin.manifest.license}</Row>}
                    {plugin.manifest.homepage && (
                      <Row label="主页">
                        <a
                          href={plugin.manifest.homepage}
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-600 hover:underline inline-flex items-center gap-1"
                        >
                          {plugin.manifest.homepage}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </Row>
                    )}
                    {plugin.manifest.repository?.url && (
                      <Row label="仓库">
                        <a
                          href={plugin.manifest.repository.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-600 hover:underline inline-flex items-center gap-1"
                        >
                          {plugin.manifest.repository.url}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </Row>
                    )}
                    {plugin.manifest.engines?.loopcore && (
                      <Row label="引擎要求">Modulith {plugin.manifest.engines.loopcore}</Row>
                    )}
                    <Row label="入口文件">
                      <code className="font-mono">{plugin.manifest.main}</code>
                    </Row>
                    {plugin.manifest.style && (
                      <Row label="样式文件">
                        <code className="font-mono">{plugin.manifest.style}</code>
                      </Row>
                    )}
                    <Row label="来源">
                      {plugin.source === 'file'
                        ? '插件包文件'
                        : plugin.source === 'folder'
                          ? plugin.devSource
                            ? '本地目录（开发链接）'
                            : '本地目录'
                          : '网络下载'}
                    </Row>
                    <Row label="安装时间">
                      {formatDate(plugin.installedAt)}（{formatRelativeTime(plugin.installedAt)}）
                    </Row>
                    <Row label="磁盘占用">{formatBytes(plugin.sizeBytes)}</Row>
                    {/*
                      开发链接下 `plugin.path` 就是源目录，与「安装路径」是同一个值。
                      与其并排列出两行相同的内容，不如把语义说清楚：这一行是
                      **当前实际被读取的目录**，并说明为什么改完就生效。
                    */}
                    {plugin.devSource ? (
                      <Row label="源目录（开发链接）">
                        <code className="font-mono">{plugin.devSource}</code>
                        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                          该插件按「从目录安装」安装，清单与代码都直接读取此目录：
                          改完代码点插件页右上角的刷新即生效，无需卸载重装；
                          卸载插件也不会删除此目录。
                        </p>
                      </Row>
                    ) : (
                      <Row label="安装路径">
                        <code className="font-mono">{plugin.path}</code>
                      </Row>
                    )}
                  </div>
                </section>

                {readme && (
                  <section>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      README
                    </h3>
                    <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 max-h-80 overflow-y-auto custom-scrollbar">
                      {/* 与市场详情走同一个渲染器：同一份 README 在两处不该长得不一样 */}
                      <Markdown source={readme} />
                    </div>
                  </section>
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    );
  }
);

PluginDetailDrawer.displayName = 'PluginDetailDrawer';

export default PluginDetailDrawer;
