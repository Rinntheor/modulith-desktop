// src/modules/pluginMarket/PluginMarket.tsx
//
// 插件市场：从插件仓库的索引里发现插件，查看权限后安装。
//
// 四条设计约束：
//
// 1. **权限的标签与风险等级来自宿主**（`services/permissionRegistry`），索引只提供
//    权限标识符。若等级来自索引，一个被篡改的索引就能把 `process-spawn` 标成低风险。
// 2. **安装前必须让用户看到权限。** 插件是能执行任意代码的东西，而确认安装这一刻是
//    用户唯一能做判断的时机。中高风险单独高亮，不埋在列表里。
// 3. **不做评分、排行、下载量。** 它们需要服务端与活跃用户，两者都不存在；摆一个空壳
//    只会让人以为数据坏了。
// 4. **失败必须说清是哪一步失败。** 索引取不到、包下载失败、哈希不符是三件不同的事，
//    合并成一句"安装失败"会让用户和排查者都无从下手。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  FileText,
  Info,
  Package,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';

import { jsdelivrUrl, PLUGIN_INDEX_REF, PLUGIN_REPO_URL } from '../../config/pluginRegistry';
import { getPermissionDescriptor, type PermissionRisk } from '../../services/permissionRegistry';
import {
  installMarketVersion,
  installedVersionOf,
  latestVersionOf,
  loadIndex,
  loadReadme,
  type MarketIndex,
  type MarketPlugin,
} from '../../services/pluginMarket';
import { reloadPluginRuntime, subscribePlugins } from '../../services/pluginRuntime';

const RISK_TONE: Record<PermissionRisk, string> = {
  low: 'bg-gray-50 text-gray-600 border-gray-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  high: 'bg-red-50 text-red-700 border-red-200',
};

const RISK_LABEL: Record<PermissionRisk, string> = { low: '低', medium: '中', high: '高' };

/** 权限徽章。标签与等级都来自宿主，不来自索引。 */
const PermissionChips: React.FC<{ permissions: string[]; max?: number }> = ({
  permissions,
  max,
}) => {
  if (permissions.length === 0) {
    return <span className="text-xs text-gray-400">未申请任何权限</span>;
  }
  const shown = max === undefined ? permissions : permissions.slice(0, max);
  const rest = permissions.length - shown.length;

  return (
    <div className="flex items-center flex-wrap gap-1">
      {shown.map((perm) => {
        const info = getPermissionDescriptor(perm);
        return (
          <span
            key={perm}
            title={info.description}
            className={`px-1.5 py-0.5 text-[11px] font-medium rounded border ${RISK_TONE[info.risk]}`}
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

/**
 * 市场里的插件图标。
 *
 * 通过 CDN 直接引用（插件尚未安装，读不到本地资源）。加载失败时退回一个通用图标 ——
 * 图标缺失不该让整张卡片看起来像坏的。
 */
const MarketIcon: React.FC<{ plugin: MarketPlugin }> = ({ plugin }) => {
  const [failed, setFailed] = useState(false);

  if (!plugin.icon || failed) {
    return (
      <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
        <Package className="w-5 h-5 text-gray-400" />
      </div>
    );
  }

  return (
    <img
      src={jsdelivrUrl(PLUGIN_INDEX_REF, plugin.icon)}
      alt=""
      onError={() => setFailed(true)}
      className="w-10 h-10 rounded-lg shrink-0 object-contain"
    />
  );
};

/** 安装确认：把权限摊开，中高风险置顶提示 */
const InstallConfirm: React.FC<{
  plugin: MarketPlugin;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ plugin, busy, onCancel, onConfirm }) => {
  const version = latestVersionOf(plugin);
  const highest = version.permissions.reduce<PermissionRisk>((worst, perm) => {
    const { risk } = getPermissionDescriptor(perm);
    if (risk === 'high' || worst === 'high') return 'high';
    if (risk === 'medium' || worst === 'medium') return 'medium';
    return worst;
  }, 'low');

  return (
    <div className="fixed inset-0 z-70 flex items-center justify-center bg-black/30 px-4">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">
            安装 {plugin.displayName} {version.version}
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            插件代码会以本应用的权限运行，能访问这台机器上的东西。
          </p>
        </div>

        <div className="px-5 py-4 max-h-80 overflow-y-auto">
          <div className="text-xs font-medium text-gray-700 mb-2">该插件申请的权限</div>
          {version.permissions.length === 0 ? (
            <p className="text-xs text-gray-500">
              未申请任何权限 —— 它无法访问网络、文件或存储。
            </p>
          ) : (
            <ul className="space-y-2">
              {version.permissions.map((perm) => {
                const info = getPermissionDescriptor(perm);
                return (
                  <li
                    key={perm}
                    className="flex items-start gap-3 px-3 py-2 rounded-lg border border-gray-100 bg-gray-50/50"
                  >
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-medium rounded border shrink-0 ${RISK_TONE[info.risk]}`}
                    >
                      {RISK_LABEL[info.risk]}风险
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-gray-800">{info.label}</div>
                      <div className="text-[11px] leading-relaxed text-gray-500">
                        {info.description}
                      </div>
                      {info.enforcement === 'none' && (
                        <div className="mt-0.5 text-[11px] text-amber-600">
                          宿主尚未强制这一项：声明它不会带来额外限制
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {highest !== 'low' && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-[11px] leading-relaxed text-amber-800">
                该插件申请了{RISK_LABEL[highest]}风险权限。权限只能由插件代码自行遵守 ——
                宿主目前无法阻止一个声明了低风险权限的插件去调用它申请过的接口。
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {busy ? '正在安装…' : '安装'}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * 字节数格式化。
 *
 * 刻意**不**从 `modules/plugins/pluginMeta` 引入：那会让市场模块依赖插件模块，删掉
 * 插件模块就会连带编译失败 —— 而「删除任意模块都不影响其它部分」是这个项目的一条
 * 架构约定。几个纯格式化函数各留一份，代价远小于模块之间的编译期耦合。
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知';
  const units = ['B', 'KB', 'MB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

const DetailRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div className="flex items-start gap-3 px-3 py-2">
    <span className="w-20 shrink-0 text-[11px] text-gray-400">{label}</span>
    <span
      className={`min-w-0 flex-1 text-[11px] break-all text-gray-700 ${mono ? 'font-mono' : ''}`}
    >
      {value}
    </span>
  </div>
);

/**
 * 详情抽屉：完整权限说明、版本与来源、以及**发布者写的 README**。
 *
 * 说明内容取自仓库里的 `README.md`（按该版本的不可变 tag），不是索引里的字段 ——
 * 描述性内容只有一个来源，发布者改文件就等于改这里。理由见 `pluginMarket.ts` 的
 * `loadReadme`。
 *
 * 视觉与动效对齐已安装插件的详情抽屉（`modules/plugins/PluginDetailDrawer.tsx`）：
 * 同一个东西在两处长得不一样会让人以为它们是两回事。
 */
const MarketDetailDrawer: React.FC<{
  plugin: MarketPlugin;
  installedVersion: string | null;
  onClose: () => void;
  onInstall: () => void;
}> = ({ plugin, installedVersion, onClose, onInstall }) => {
  const version = useMemo(() => latestVersionOf(plugin), [plugin]);
  const [readme, setReadme] = useState<'loading' | string | null>('loading');

  useEffect(() => {
    let alive = true;
    setReadme('loading');
    void loadReadme(plugin, version).then((text) => {
      if (alive) setReadme(text);
    });
    return () => {
      alive = false;
    };
  }, [plugin, version]);

  return (
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
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 380, damping: 38 }}
        className="fixed right-0 top-0 h-full w-full max-w-[560px] bg-white z-50 flex flex-col shadow-2xl"
      >
        <div className="shrink-0 px-6 py-5 border-b border-gray-100">
          <div className="flex items-start gap-4">
            <MarketIcon plugin={plugin} />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-semibold text-gray-900">{plugin.displayName}</h2>
                <span className="px-1.5 py-0.5 text-[11px] font-mono rounded bg-gray-100 text-gray-600">
                  v{version.version}
                </span>
                {installedVersion && (
                  <span className="px-1.5 py-0.5 text-[11px] rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
                    已安装 {installedVersion}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5 font-mono truncate">{plugin.id}</p>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2 mt-4">
            <button
              type="button"
              onClick={onInstall}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800"
            >
              <Download className="w-3.5 h-3.5" />
              {installedVersion ? '重新安装' : '安装'}
            </button>
            {plugin.source && (
              <button
                type="button"
                onClick={() =>
                  void openUrl(`${PLUGIN_REPO_URL}/tree/${PLUGIN_INDEX_REF}/${plugin.source}`)
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                查看源码
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5 space-y-5">
          {plugin.summary && (
            <p className="text-xs leading-relaxed text-gray-600">{plugin.summary}</p>
          )}

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5" />
              权限
            </h3>
            {version.permissions.length === 0 ? (
              <p className="text-xs text-gray-500">
                未申请任何权限 —— 它无法访问网络、文件或存储。
              </p>
            ) : (
              <ul className="space-y-2">
                {version.permissions.map((perm) => {
                  const info = getPermissionDescriptor(perm);
                  return (
                    <li
                      key={perm}
                      className="flex items-start gap-3 px-3 py-2 rounded-lg border border-gray-100 bg-gray-50/50"
                    >
                      <span
                        className={`px-1.5 py-0.5 text-[10px] font-medium rounded border shrink-0 ${RISK_TONE[info.risk]}`}
                      >
                        {RISK_LABEL[info.risk]}风险
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-gray-800">{info.label}</div>
                        <div className="text-[11px] leading-relaxed text-gray-500">
                          {info.description}
                        </div>
                        {info.enforcement === 'none' && (
                          <div className="mt-0.5 text-[11px] text-amber-600">
                            宿主尚未强制这一项：声明它不会带来额外限制
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5" />
              版本与来源
            </h3>
            <div className="rounded-xl border border-gray-100 divide-y divide-gray-100">
              <DetailRow label="版本" value={version.version} mono />
              <DetailRow label="仓库 tag" value={version.tag} mono />
              <DetailRow label="需要宿主" value={version.engines.loopcore} mono />
              <DetailRow label="包体积" value={formatBytes(version.package.size)} />
              <DetailRow label="SHA-256" value={version.package.sha256} mono />
              <DetailRow label="作者" value={plugin.author.name || '未知作者'} />
              {plugin.license && <DetailRow label="许可证" value={plugin.license} />}
              {plugin.source && <DetailRow label="源码目录" value={plugin.source} mono />}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              说明
            </h3>
            {readme === 'loading' ? (
              <p className="text-xs text-gray-400">正在读取说明…</p>
            ) : readme ? (
              <pre className="text-[11px] leading-relaxed text-gray-700 bg-gray-50 border border-gray-100 rounded-xl p-3 whitespace-pre-wrap break-words max-h-80 overflow-y-auto custom-scrollbar">
                {readme}
              </pre>
            ) : (
              <p className="text-xs leading-relaxed text-gray-500">
                {plugin.source
                  ? '该版本的仓库里没有 README.md，或当前网络取不到它。'
                  : '该插件只分发安装包、未公开源码，因此没有说明可读。'}
              </p>
            )}
          </section>
        </div>
      </motion.aside>
    </>
  );
};

const PluginMarket: React.FC = () => {
  const [index, setIndex] = useState<MarketIndex | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [pending, setPending] = useState<MarketPlugin | null>(null);
  const [detail, setDetail] = useState<MarketPlugin | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // 已安装状态存在 pluginRuntime 的模块级数组里，因此靠它的通知驱动重渲染
  const [installedTick, setInstalledTick] = useState(0);

  useEffect(() => subscribePlugins(() => setInstalledTick((n) => n + 1)), []);

  const refresh = useCallback(async (force: boolean) => {
    setStatus('loading');
    setError('');
    try {
      setIndex(await loadIndex({ force }));
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const categories = useMemo(() => {
    const found = new Set<string>();
    for (const plugin of index?.plugins ?? []) {
      for (const name of plugin.categories ?? []) found.add(name);
    }
    return [...found].sort();
  }, [index]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (index?.plugins ?? []).filter((plugin) => {
      if (category && !(plugin.categories ?? []).includes(category)) return false;
      if (!q) return true;
      return [plugin.id, plugin.displayName, plugin.summary, ...(plugin.keywords ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [index, query, category]);

  const installed = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const plugin of visible) map.set(plugin.id, installedVersionOf(plugin.id));
    return map;
    // installedTick 只是重算的触发器：已安装列表活在 pluginRuntime 的模块级状态里
  }, [visible, installedTick]);

  const doInstall = useCallback(async (plugin: MarketPlugin) => {
    setBusyId(plugin.id);
    setNotice(null);
    try {
      const version = latestVersionOf(plugin);
      await installMarketVersion(plugin, version);
      await reloadPluginRuntime();
      setPending(null);
      setNotice({
        kind: 'ok',
        text: `${plugin.displayName} ${version.version} 已安装。可在「设置 → 插件」里启用、禁用或卸载。`,
      });
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div className="px-6 py-5">
      {/* 头部 */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">插件市场</h2>
          <p className="mt-1 text-xs text-gray-500">
            插件来自
            <button
              type="button"
              onClick={() => void openUrl(PLUGIN_REPO_URL)}
              className="mx-1 inline-flex items-center gap-0.5 text-gray-700 underline decoration-dotted hover:text-gray-900"
            >
              官方插件仓库
              <ExternalLink className="w-3 h-3" />
            </button>
            。安装前请先看一眼它申请的权限。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={status === 'loading'}
          className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${status === 'loading' ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {/* 结果提示 */}
      {notice && (
        <div
          className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 ${
            notice.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50'
              : 'border-red-200 bg-red-50'
          }`}
        >
          {notice.kind === 'ok' ? (
            <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          )}
          <p
            className={`text-[11px] leading-relaxed whitespace-pre-wrap ${
              notice.kind === 'ok' ? 'text-emerald-800' : 'text-red-800'
            }`}
          >
            {notice.text}
          </p>
        </div>
      )}

      {/* 加载 / 失败 */}
      {status === 'loading' && !index && (
        <div className="mt-6 text-xs text-gray-500">正在获取插件列表…</div>
      )}

      {status === 'error' && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span className="text-xs font-medium text-red-800">无法获取插件列表</span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-red-700 whitespace-pre-wrap">
            {error}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-red-600">
            已安装的插件不受影响，可以在「设置 → 插件」里继续管理。若刚发布过新版本，
            稍等片刻再重试 —— CDN 缓存刷新需要一点时间。
          </p>
          <button
            type="button"
            onClick={() => void refresh(true)}
            className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-red-300 text-red-700 hover:bg-red-100"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重试
          </button>
        </div>
      )}

      {/* 筛选 */}
      {status === 'ready' && index && (
        <>
          <div className="mt-5 flex items-center gap-3">
            <div className="relative flex-1 max-w-xs">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索名称、关键词"
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-gray-200 focus:border-gray-400 focus:outline-none"
              />
            </div>
            {categories.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => setCategory(null)}
                  className={`px-2 py-1 text-[11px] rounded-md border ${
                    category === null
                      ? 'border-gray-900 bg-gray-900 text-white'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  全部
                </button>
                {categories.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setCategory(name)}
                    className={`px-2 py-1 text-[11px] rounded-md border ${
                      category === name
                        ? 'border-gray-900 bg-gray-900 text-white'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 列表 */}
          {visible.length === 0 ? (
            <p className="mt-6 text-xs text-gray-500">
              {index.plugins.length === 0
                ? '仓库里还没有插件。'
                : '没有符合条件的插件。'}
            </p>
          ) : (
            <div className="mt-4 space-y-2">
              {visible.map((plugin) => {
                const version = latestVersionOf(plugin);
                const local = installed.get(plugin.id) ?? null;
                const busy = busyId === plugin.id;

                return (
                  <div
                    key={plugin.id}
                    className="flex items-start gap-4 rounded-xl border border-gray-200 bg-white px-4 py-3"
                  >
                    <MarketIcon plugin={plugin} />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => setDetail(plugin)}
                          className="text-sm font-medium text-gray-900 hover:underline decoration-dotted"
                        >
                          {plugin.displayName}
                        </button>
                        <span className="text-[11px] text-gray-400">{version.version}</span>
                        {local && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium rounded border border-emerald-200 bg-emerald-50 text-emerald-700">
                            已安装 {local}
                          </span>
                        )}
                        {plugin.source && (
                          <span
                            className="px-1.5 py-0.5 text-[10px] rounded border border-gray-200 text-gray-500"
                            title={`源码目录：${plugin.source}`}
                          >
                            源码可见
                          </span>
                        )}
                      </div>

                      <p className="mt-1 text-xs leading-relaxed text-gray-600">
                        {plugin.summary}
                      </p>

                      <div className="mt-2 flex items-center gap-3 flex-wrap">
                        <PermissionChips permissions={version.permissions} max={5} />
                        <span className="text-[11px] text-gray-400">
                          需要宿主 {version.engines.loopcore}
                        </span>
                      </div>

                      <div className="mt-1.5 text-[11px] text-gray-400">
                        {plugin.author.name || '未知作者'}
                        {plugin.license && ` · ${plugin.license}`}
                      </div>
                    </div>

                    <div className="shrink-0 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setDetail(plugin)}
                        className="px-2 py-1.5 text-[11px] rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                      >
                        详情
                      </button>
                      {plugin.source && (
                        <button
                          type="button"
                          onClick={() =>
                            void openUrl(`${PLUGIN_REPO_URL}/tree/${PLUGIN_INDEX_REF}/${plugin.source}`)
                          }
                          className="px-2 py-1.5 text-[11px] rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                        >
                          源码
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy || busyId !== null}
                        onClick={() => setPending(plugin)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {busy ? '安装中…' : local ? '重新安装' : '安装'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {detail && (
          <MarketDetailDrawer
            plugin={detail}
            installedVersion={installedVersionOf(detail.id)}
            onClose={() => setDetail(null)}
            onInstall={() => setPending(detail)}
          />
        )}
      </AnimatePresence>

      {pending && (
        <InstallConfirm
          plugin={pending}
          busy={busyId === pending.id}
          onCancel={() => setPending(null)}
          onConfirm={() => void doInstall(pending)}
        />
      )}
    </div>
  );
};

export default PluginMarket;
