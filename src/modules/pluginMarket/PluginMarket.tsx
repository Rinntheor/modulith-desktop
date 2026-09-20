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

import { PLUGIN_INDEX_REF, PLUGIN_REPO_URL } from '../../config/pluginRegistry';
import { DRAWER_ENTER, DRAWER_EXIT } from '../../utils/motionCurves';
import Markdown from '../../components/Markdown';
import { getPermissionDescriptor, type PermissionRisk } from '../../services/permissionRegistry';
import {
  installMarketVersion,
  latestVersionOf,
  loadIndex,
  loadMarketIcon,
  loadReadme,
  marketPluginShape,
  planUpdate,
  updateStateFor,
  type MarketIconResult,
  type MarketIndex,
  type MarketPlugin,
  type UpdatePlan,
  type UpdateState,
} from '../../services/pluginMarket';
import { reloadPluginRuntime, subscribePlugins, getPluginContract } from '../../services/pluginRuntime';
import { getPluginModuleIds } from '../../services/moduleCatalog';
import {
  SHAPE_HINTS,
  SHAPE_LABELS,
  shapeBadgeLabels,
  shapeFromInstalled,
  type PluginShape,
  type PluginShapeInfo,
} from '../../services/pluginShape';
import { formatBytes } from '../../utils/format';

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
 * 三个阶段：取回中（空框）→ 取到（图标）→ 取不到（通用图标，并把原因挂在 title 上）。
 *
 * 图标文本由 `loadMarketIcon` 从后端通道取回（与索引、README、安装包同一条），
 * 再以 `data:` URL 交给 `<img>` —— 为什么不用 `<img src="https://cdn...">`、
 * 为什么不用 `dangerouslySetInnerHTML`，见 `services/pluginMarket.ts` 里那段说明。
 *
 * 失败的兜底仍然存在（图标缺失不该让整张卡片看起来像坏的），但它不再吞掉原因：
 * 先前这里是一个 `onError` 直接置位，唯一的现象是一个灰方块，无法区分
 * "作者没写图标"和"图标取不到"。
 */
const MarketIcon: React.FC<{ plugin: MarketPlugin }> = ({ plugin }) => {
  const icon = plugin.icon;
  const [state, setState] = useState<MarketIconResult | null>(null);

  useEffect(() => {
    if (!icon) return;
    let alive = true;
    setState(null);
    void loadMarketIcon(icon).then((result) => {
      // 组件可能已经在请求返回前卸载（列表重排、切换到详情页）
      if (alive) setState(result);
    });
    return () => {
      alive = false;
    };
  }, [icon]);

  if (!icon) {
    return (
      <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
        <Package className="w-5 h-5 text-gray-400" />
      </div>
    );
  }

  // 取回中：留出同样大小的空框，图标到达时不会让整行跳动
  if (!state) {
    return <div className="w-10 h-10 rounded-lg bg-gray-100 shrink-0" />;
  }

  if (!state.ok) {
    return (
      <div
        title={`图标取不到：${state.reason}`}
        className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0"
      >
        <Package className="w-5 h-5 text-gray-400" />
      </div>
    );
  }

  return <img src={state.dataUrl} alt="" className="w-10 h-10 rounded-lg shrink-0 object-contain" />;
};

/** 安装 / 更新确认：把权限摊开，新增项与中高风险置顶 */
const InstallConfirm: React.FC<{
  plugin: MarketPlugin;
  /** 更新时提供；首次安装为 null */
  plan: UpdatePlan | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ plugin, plan, busy, onCancel, onConfirm }) => {
  const version = plan?.version ?? latestVersionOf(plugin);

  // 更新时只关心**新增**的权限：既有的那些用户已经同意过了，把它们一并算进"需要注意"
  // 只会稀释真正新增的那几项 —— 而那个判断正是这次确认要用户做的。
  const noteworthy = plan ? plan.added : version.permissions;
  const highest = noteworthy.reduce<PermissionRisk>((worst, perm) => {
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
            {plan
              ? `${plan.downgrade ? '回退' : '更新'} ${plugin.displayName} ${plan.from} → ${version.version}`
              : `安装 ${plugin.displayName} ${version.version}`}
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            {plan?.downgrade
              ? '这是退回到更旧的版本 —— 本机当前版本比仓库里的更新。'
              : '插件代码会以本应用的权限运行，能访问这台机器上的东西。'}
          </p>
        </div>

        <div className="px-5 py-4 max-h-80 overflow-y-auto">
          {plan && plan.added.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-xs font-medium text-amber-900">
                本次新增 {plan.added.length} 项权限
              </div>
              <ul className="mt-1.5 space-y-1">
                {plan.added.map((perm) => {
                  const info = getPermissionDescriptor(perm);
                  return (
                    <li key={perm} className="text-[11px] leading-relaxed text-amber-800">
                      <span className="font-medium">{info.label}</span>
                      <span className="mx-1 text-amber-600">（{RISK_LABEL[info.risk]}风险）</span>
                      {info.description}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {plan && plan.removed.length > 0 && (
            <p className="mb-3 text-[11px] leading-relaxed text-gray-500">
              新版本不再申请：
              {plan.removed.map((perm) => getPermissionDescriptor(perm).label).join('、')}
            </p>
          )}

          <div className="text-xs font-medium text-gray-700 mb-2">
            {plan ? '该版本的完整权限列表' : '该插件申请的权限'}
          </div>
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
 * 状态徽章的文案与配色。
 *
 * 卡片与详情抽屉共用同一份定义 —— 同一个状态在两处出现不同说法，用户会以为是两件事。
 */
function stateBadge(state: UpdateState): { text: string; className: string } | null {
  switch (state.kind) {
    case 'not-installed':
      return null;
    case 'up-to-date':
      return {
        text: `已安装 ${state.version}`,
        className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      };
    case 'update-available':
      return {
        text: `可更新 ${state.from} → ${state.to}`,
        className: 'border-amber-200 bg-amber-50 text-amber-700',
      };
    case 'local-newer':
      // 用户可能从 .lcp 装了比索引更新的版本。这时必须说清楚，
      // 否则"重新安装"会被误当成升级，实际是降级。
      return {
        text: `已安装 ${state.version}（比仓库里的新）`,
        className: 'border-gray-200 bg-gray-50 text-gray-600',
      };
    case 'dev-linked':
      return {
        text: `开发链接 ${state.version}`,
        className: 'border-indigo-200 bg-indigo-50 text-indigo-700',
      };
  }
}

const StateBadge: React.FC<{ state: UpdateState }> = ({ state }) => {
  const badge = stateBadge(state);
  if (!badge) return null;
  return (
    <span
      className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${badge.className}`}
    >
      {badge.text}
    </span>
  );
};

function actionLabel(state: UpdateState): string {
  if (state.kind === 'update-available') return '更新';
  if (state.kind === 'not-installed') return '安装';
  return '重新安装';
}

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
  state: UpdateState;
  onClose: () => void;
  onAction: () => void;
}> = ({ plugin, state, onClose, onAction }) => {
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
        animate={{ x: 0, transition: DRAWER_ENTER }}
        exit={{ x: '100%', transition: DRAWER_EXIT }}
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
                <StateBadge state={state} />
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
            {state.kind === 'dev-linked' ? (
              <p className="text-[11px] leading-relaxed text-indigo-700">
                该插件从源码目录实时读取，改完代码点标题栏的刷新即生效，因此不需要从市场
                更新。这里也不提供更新：那会把它换成安装目录里的副本，丢掉开发链接。
              </p>
            ) : (
              <button
                type="button"
                onClick={onAction}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800"
              >
                <Download className="w-3.5 h-3.5" />
                {actionLabel(state)}
              </button>
            )}
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
              /*
                README 按 Markdown 渲染。**用 <Markdown> 而不是直接写 HTML** ——
                它是远程内容，而宿主与插件共享同一个 JS 上下文。渲染成 React
                元素意味着源码里的 HTML 只能作为文本显示。
                `max-h-80 overflow-y-auto` 保留原来的滚动约束。
              */
              <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 max-h-80 overflow-y-auto custom-scrollbar">
                <Markdown source={readme} />
              </div>
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
  /**
   * 形态筛选。
   *
   * 与 `category` 是两个**性质不同**的维度，界面上也刻意分开摆：
   *   * `category` 是作者自填的**浏览分类**（"效率"、"开发"），回答"我想找哪一类工具"；
   *   * `shape` 是从 `contributes` **派生**的**形态**，回答"它会不会占我的侧边栏"。
   *
   * 把两者混成一行按钮，用户就无从分辨哪些标签可信、哪些只是作者的措辞。
   */
  const [shape, setShape] = useState<PluginShape | 'all'>('all');
  const [pending, setPending] = useState<{ plugin: MarketPlugin; plan: UpdatePlan | null } | null>(
    null
  );
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

  /**
   * 先按「搜索 + 分类」筛一遍，**形态不参与**。
   *
   * 分出这一层是为了让形态按钮上的数字有意义：那些数字数的是"在当前搜索与分类下，
   * 每种形态各有多少"。若把形态也塞进这一层，点一下"界面型"之后"功能型"会立刻变成 0，
   * 用户就没法用它做判断了（那是筛选器的经典错误）。
   */
  /**
   * 形态：**已安装**的插件用宿主派生的（权威），未安装的才回退到索引。
   *
   * 为什么值得分这两种来源：已安装插件的清单就在本机，宿主能从 `contributes`
   * 直接算出形态 —— 那比索引（打包时算的、可能过期）更准。让已安装的那部分
   * 立刻正确，也让"索引还没带上形态"这段时间里市场不是一片「形态未知」。
   *
   * 旧式插件（清单里没有 `contributes`）在加载之前宿主确实不知道，此时
   * `shapeFromInstalled` 会如实返回「形态未知」—— 不猜。
   */
  const shapeOf = (plugin: MarketPlugin): PluginShapeInfo => {
    if (updateStateFor(plugin).kind !== 'not-installed') {
      return shapeFromInstalled(getPluginContract(plugin.id), getPluginModuleIds(plugin.id).length);
    }
    return marketPluginShape(plugin);
  };

  const baseFiltered = useMemo(() => {
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

  const shapeCounts = useMemo(() => {
    const counts: Record<PluginShape, number> = { ui: 0, headless: 0, unknown: 0 };
    for (const plugin of baseFiltered) counts[shapeOf(plugin).shape] += 1;
    return counts;
    // installedTick 是重算的触发器：已安装状态活在 pluginRuntime 的模块级状态里，
    // 形态随之变化（装完之后就从「索引推断」变成「宿主派生」）
  }, [baseFiltered, installedTick]);

  const visible = useMemo(
    () => (shape === 'all' ? baseFiltered : baseFiltered.filter((plugin) => shapeOf(plugin).shape === shape)),
    [baseFiltered, shape, installedTick]
  );

  /**
   * 列表分组：同类相邻，并带一行小标题。
   *
   * 这正是"功能性插件和界面型插件堆在一起，难以分类"要解决的东西 ——
   * 只加徽章不够，用户仍然要在一堆卡片里自己找。顺序固定为
   * 界面型 → 功能型 → 形态未知：前两类是用户能直接感知到的差别，
   * 最后一类是需要被看见（并推动作者补声明）的欠账。
   */
  const sections = useMemo(() => {
    const order: PluginShape[] = ['ui', 'headless', 'unknown'];
    const buckets = new Map<PluginShape, MarketPlugin[]>();
    for (const plugin of visible) {
      const key = shapeOf(plugin).shape;
      const list = buckets.get(key);
      if (list) list.push(plugin);
      else buckets.set(key, [plugin]);
    }
    return order
      .filter((key) => (buckets.get(key)?.length ?? 0) > 0)
      .map((key) => ({ shape: key, plugins: buckets.get(key) as MarketPlugin[] }));
    // installedTick 同上：装完之后分组应当立刻从「形态未知」挪到正确的那一组
  }, [visible, installedTick]);

  /**
   * 把分组摊平成一串「行」，交给**一次** map 渲染。
   *
   * 为什么摊平而不是嵌套两层 map：嵌套要重排整张卡片的缩进，而卡片有近百行 ——
   * 那样一次纯展示改动会变成一大片 diff，评审时看不出真正变了什么。
   *
   * 只有一组时**不打小标题**：那时它不是分类信息，只是噪音。
   */
  const rows = useMemo<
    Array<{ kind: 'header'; shape: PluginShape; count: number } | { kind: 'plugin'; plugin: MarketPlugin }>
  >(() => {
    const out: Array<
      { kind: 'header'; shape: PluginShape; count: number } | { kind: 'plugin'; plugin: MarketPlugin }
    > = [];
    for (const section of sections) {
      if (sections.length > 1) {
        out.push({ kind: 'header', shape: section.shape, count: section.plugins.length });
      }
      for (const plugin of section.plugins) out.push({ kind: 'plugin', plugin });
    }
    return out;
  }, [sections]);

  const states = useMemo(() => {
    const map = new Map<string, UpdateState>();
    for (const plugin of visible) map.set(plugin.id, updateStateFor(plugin));
    return map;
    // installedTick 只是重算的触发器：已安装列表活在 pluginRuntime 的模块级状态里
  }, [visible, installedTick]);

  /**
   * 真正的安装 / 更新动作。
   *
   * 更新完成后的提示会**列出新增的低风险权限**：设计文档 3.8 要求这类权限静默通过，
   * 但"静默"指的是不打断用户，不是不告诉他 —— 权限集合变了而用户完全不知情，
   * 下次他看到权限列表时会以为一直是那样。
   */
  const performInstall = useCallback(async (plugin: MarketPlugin, plan: UpdatePlan | null) => {
    setBusyId(plugin.id);
    setNotice(null);
    try {
      const version = plan?.version ?? latestVersionOf(plugin);
      await installMarketVersion(plugin, version);
      await reloadPluginRuntime();
      setPending(null);

      if (plan) {
        const addedNote =
          plan.added.length > 0
            ? `新增 ${plan.added.length} 项低风险权限：${plan.added
                .map((p) => getPermissionDescriptor(p).label)
                .join('、')}。`
            : plan.removed.length > 0
              ? `不再申请 ${plan.removed.length} 项权限。`
              : '';
        setNotice({
          kind: 'ok',
          text: `${plugin.displayName} 已从 ${plan.from} 更新到 ${version.version}。${addedNote}`,
        });
      } else {
        setNotice({
          kind: 'ok',
          text: `${plugin.displayName} ${version.version} 已安装。可在「设置 → 插件」里启用、禁用或卸载。`,
        });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId(null);
    }
  }, []);

  /**
   * 统一的入口：需要确认时打开对话框，否则直接执行。
   *
   * 只有**首次安装**和**新增了中/高风险权限的更新**需要确认。权限变少、不变、或只新增
   * 低风险权限时直接装，结果写进提示里（见 performInstall）。
   */
  const requestAction = useCallback(
    (plugin: MarketPlugin) => {
      const plan = planUpdate(plugin);
      if (plan && !plan.needsConfirmation) {
        void performInstall(plugin, plan);
        return;
      }
      setNotice(null);
      setPending({ plugin, plan });
    },
    [performInstall]
  );

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
          {/*
            形态：**由清单派生**，因此它是可信的。
            与下面那行的「分类」刻意分成两块 —— 后者是作者自填的浏览分类，
            两者混成一行，用户就无从分辨哪些标签能当作判断依据。
          */}
          <div className="mt-5 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-gray-400 shrink-0">形态</span>
            <button
              type="button"
              onClick={() => setShape('all')}
              className={`px-2 py-1 text-[11px] rounded-md border ${
                shape === 'all'
                  ? 'border-gray-900 bg-gray-900 text-white'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              全部 · {baseFiltered.length}
            </button>
            {(['ui', 'headless', 'unknown'] as PluginShape[])
              .filter((key) => shapeCounts[key] > 0)
              .map((key) => (
                <button
                  key={key}
                  type="button"
                  title={SHAPE_HINTS[key]}
                  onClick={() => setShape(key)}
                  className={`px-2 py-1 text-[11px] rounded-md border ${
                    shape === key
                      ? 'border-gray-900 bg-gray-900 text-white'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {SHAPE_LABELS[key]} · {shapeCounts[key]}
                </button>
              ))}
            <span className="text-[11px] text-gray-300">由清单派生，不是作者填写</span>
          </div>

          <div className="mt-3 flex items-center gap-3">
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
                <span className="text-[11px] text-gray-400 shrink-0">分类</span>
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
              {rows.map((row) => {
                if (row.kind === 'header') {
                  return (
                    <div
                      key={`header-${row.shape}`}
                      className="flex items-baseline gap-2 pt-3 first:pt-0"
                    >
                      <span className="text-[11px] font-medium text-gray-600">
                        {SHAPE_LABELS[row.shape]}
                      </span>
                      <span className="text-[11px] text-gray-400">{row.count}</span>
                      <span className="text-[11px] text-gray-300">{SHAPE_HINTS[row.shape]}</span>
                    </div>
                  );
                }

                const plugin = row.plugin;
                const version = latestVersionOf(plugin);
                const state = states.get(plugin.id) ?? { kind: 'not-installed' as const };
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
                        <StateBadge state={state} />
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

                      {/* 贡献种类徽章：分级只分两档，种类靠徽章表达 ——
                          一旦分级超过两档，用户就要先学一套分类法，那和"不好分类"是同一个病。 */}
                      {(() => {
                        const labels = shapeBadgeLabels(shapeOf(plugin));
                        if (labels.length === 0) return null;
                        return (
                          <div className="mt-1 flex items-center gap-1 flex-wrap">
                            {labels.map((label) => (
                              <span
                                key={label}
                                className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-500"
                              >
                                {label}
                              </span>
                            ))}
                          </div>
                        );
                      })()}

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
                        disabled={busy || busyId !== null || state.kind === 'dev-linked'}
                        onClick={() => requestAction(plugin)}
                        title={
                          state.kind === 'dev-linked'
                            ? '该插件是开发链接，改完源码点刷新即生效，不需要从市场更新'
                            : undefined
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {busy ? '处理中…' : actionLabel(state)}
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
            // 直接算而不是查 states：详情打开期间用户可能改了筛选，那时 states 里
            // 就没有这个插件了，回退值会把状态显示错。
            state={updateStateFor(detail)}
            onClose={() => setDetail(null)}
            onAction={() => requestAction(detail)}
          />
        )}
      </AnimatePresence>

      {pending && (
        <InstallConfirm
          plugin={pending.plugin}
          plan={pending.plan}
          busy={busyId === pending.plugin.id}
          onCancel={() => setPending(null)}
          onConfirm={() => void performInstall(pending.plugin, pending.plan)}
        />
      )}
    </div>
  );
};

export default PluginMarket;
