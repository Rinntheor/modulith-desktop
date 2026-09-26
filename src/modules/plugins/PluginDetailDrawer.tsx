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
import {
  backgroundPluginStatus,
  pluginBackgroundContribution,
  type BackgroundContribution,
  type BackgroundPluginStatus,
} from '../../services/backgroundPlugins';

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

    /**
     * 后台（无界面）插件在不在跑、以及它跑在哪一层边界里。
     *
     * ============================================================
     * 为什么这件事必须显示出来
     * ============================================================
     *
     * `isolated` 与 `netRestricted` 是**两件不同的事**，而它们很容易被读成一件：
     *
     *   * `isolated` —— Node 的 `--permission` 那一层在不在；
     *   * `netRestricted` —— 那一层**管不管得住网络**。宿主从不传 `--allow-net`，
     *     但"不授予"只有在那个 scope 存在时才等于拒绝，而它是**版本相关的**
     *     （实测 Node 24.15.0 就没有，网络完全不受管）。
     *
     * 合成一个绿色"已隔离"的结果是：用户以为插件连不上网，而它可以直接
     * `fetch` 出去。**让用户以为某项受管控、实际不受管控，比不告诉他更危险** ——
     * 他会基于一个错误的前提做决定。
     *
     * 取后台声明走**宿主**（`plugin_background_contribution`）而不是在前端读
     * `manifest.contributes`：入口路径的合法性由 Rust 判定（它是放行目录的依据），
     * 前端再判一遍就是第二份会漂的规则。没有声明就不取状态，因此这条调用
     * 不会出现在绝大多数插件上。
     */
    const [backend, setBackend] = useState<{
      contribution: BackgroundContribution;
      status: BackgroundPluginStatus | null;
    } | null>(null);

    useEffect(() => {
      if (!plugin) {
        setBackend(null);
        return;
      }

      let alive = true;
      setBackend(null);

      void (async () => {
        try {
          const contribution = await pluginBackgroundContribution(plugin.id);
          if (!alive || !contribution) return;

          const items = await backgroundPluginStatus();
          if (!alive) return;

          // 只认 id 完全相等的那个：这一层不做任何规范化，否则"界面显示了谁"
          // 与"实际跑的是谁"就有了两个答案。
          setBackend({
            contribution,
            status: items.find((item) => item.id === plugin.id) ?? null,
          });
        } catch {
          // 取不到不该让整份详情页报错：它是补充信息。
          if (alive) setBackend(null);
        }
      })();

      return () => {
        alive = false;
      };
      // `plugin` 是对象且每次列表刷新都会换引用，这里按 id 依赖。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [plugin?.id]);

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

                  {/*
                    执行模式必须与权限**并列**出现，而且必须排在列表之前。

                    理由是这份列表的效力完全取决于它：插件跑在宿主的 webview 里时，
                    列表只是它自己的声明 —— 宿主没有任何手段核实，也拦不住越界的调用；
                    跑在独立 webview 里时，越出列表的调用会在 IPC 层被拒。
                    同样一份列表，两种情况下含义完全不同。

                    以前这里只有列表，于是它对每一个 in-process 插件都在说一句
                    **不成立的话**：用户读到"未申请权限 = 无法访问网络/文件/存储"，
                    而那个插件其实能用到宿主的一切能力。这一条属于"列表要说真话"，
                    不是措辞问题。
                  */}
                  {plugin.manifest.runtime === 'sandboxed' ? (
                    <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                      <p className="text-[11px] text-emerald-800 leading-relaxed">
                        <span className="font-medium">已隔离。</span>
                        这个插件跑在一个与宿主<span className="font-medium">不同来源</span>的文档里
                        （跨源 iframe），而那一边
                        <span className="font-medium">拿不到任何宿主 IPC</span>
                        —— 因此下面这份列表是<b>有执行者的</b>：越出列表的调用会在
                        宿主那一层被拒绝。
                      </p>
                    </div>
                  ) : (
                    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                      <p className="text-[11px] text-amber-800 leading-relaxed">
                        <span className="font-medium">未隔离。</span>
                        这个插件与宿主跑在同一个上下文里，因此下面这份列表
                        <span className="font-medium">是它的声明，不是对它的约束</span>
                        —— 它实际能触达宿主的一切能力，而宿主无法核实它是否如实申报。
                      </p>
                    </div>
                  )}

                  {/*
                    后台（无界面）插件：把"跑在哪一层边界里"与"网络管不管得住"
                    **分开说**。合成一句会影响用户的判断，而那是安全信息。
                  */}
                  {backend && (
                    <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                      <p className="text-[11px] text-gray-700 leading-relaxed">
                        <span className="font-medium">它还有一份后台代码。</span>
                        那部分跑在一个<span className="font-medium">独立的 Node 进程</span>里
                        （不是 webview，也不占渲染进程）：文件读只放开它自己的目录、
                        <code className="px-0.5">process.env</code> 已清空。
                      </p>
                      {backend.status?.running ? (
                        <p className="mt-1.5 text-[11px] leading-relaxed">
                          {backend.status.netRestricted ? (
                            <span className="text-emerald-800">
                              当前正在运行，且网络也被引擎拦住了。
                            </span>
                          ) : (
                            <span className="text-amber-800">
                              当前正在运行。
                              <b>但它的网络不受管</b>：这台机器上的 Node 版本没有"网络"那一项
                              权限（<code className="px-0.5">--allow-net</code>），因此"不授予"
                              等于什么也没做。它的 <code className="px-0.5">ctx.http</code> 仍然
                              每次都判 <code className="px-0.5">network</code> 权限，但它可以直接
                              <code className="px-0.5">fetch</code> 外连 —— 别按权限列表去理解它。
                            </span>
                          )}
                        </p>
                      ) : (
                        <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
                          当前没有在运行{backend.status?.reason ? `：${backend.status.reason}` : ''}。
                        </p>
                      )}
                    </div>
                  )}

                  {(plugin.manifest.permissions ?? []).length === 0 ? (
                    <p className="text-xs text-gray-500">
                      {plugin.manifest.runtime === 'sandboxed'
                        ? '该插件未申请任何权限，因此它在宿主这一侧什么也调不动。'
                        : '该插件未申请任何权限。注意这只表示它没有申报 —— 在没有隔离的情况下，它并不因此被限制。'}
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
                    {plugin.manifest.engines?.modulith && (
                      <Row label="引擎要求">Modulith {plugin.manifest.engines.modulith}</Row>
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
