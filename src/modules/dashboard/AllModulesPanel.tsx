// src/modules/dashboard/AllModulesPanel.tsx
//
// 「全部模块」—— 仪表盘上的二级面板。
//
// ============================================================
// 它与仪表盘的分区是什么关系
// ============================================================
//
// 仪表盘的主视图按**用户自己的分类**分区，未归类的模块落在「未分类」里。那是
// "我整理过的东西"的视图。而这个面板回答的是另一个问题：**一共有什么**。
// 两个问题的答案不一样，所以需要两个界面：
//
//   · 主视图里，一个模块可能因为被分到别的分类而不在那个分区里；
//   · 面板里，**每一个模块都在**，包括被隐藏在侧边栏里的那些。
//
// ============================================================
// 三个交互决定
// ============================================================
//
// 1. **它盖住整个窗口，而不是一个下拉或抽屉。** 内容量是"全部模块"，而一个
//    下拉装不下；抽屉（右侧滑出）会把每一行压窄到描述只剩几个字。它是**浏览**
//    界面，应该拿到完整的宽度。
// 2. **打开一个模块时先关掉自己。** 否则模块在后台标签里打开了，而这一层还盖在
//    上面 —— 用户会以为"点了没反应"。
// 3. **点背景与 Esc 都关闭。** 与出站询问对话框相反：那一个是在等一个答案，
//    关掉它会让用户以为自己答过了；这一个只是浏览，随时可以退出。
//
// ============================================================
// 它为什么不是操作系统的第二个窗口
// ============================================================
//
// "独立的窗口"听起来更彻底，但当前架构下它不是一个小改动：第二个 webview 有
// **自己的 JS 上下文**，而 tabStore / moduleCatalog / 插件运行时 / 会话令牌都是
// 单窗口单例（令牌在 `sessionStorage` 里，不跨窗口共享）。要让它真实地显示
// **插件**模块，就得在两个窗口之间建一条数据通道，或者把单例改成多实例 ——
// 那正是[已知问题与技术债](../../../docs/06-项目/已知问题与技术债.md)里
// 记为"架构级工作"的那一项。这个面板是同一件事在应用内的形态。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock,
  Eye,
  EyeOff,
  Hash,
  LayoutGrid,
  List,
  Search,
  Star,
  X,
} from 'lucide-react';

import ModuleIcon from '../../components/ModuleIcon';
import { moduleManager, type ModuleCategory } from '../../services/moduleManager';
import { showToast } from '../../services/toast';

type Filter = 'all' | 'favorite' | 'recent' | 'hidden' | 'disabled';
type ViewMode = 'grid' | 'list';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'favorite', label: '收藏' },
  { id: 'recent', label: '最近使用' },
  { id: 'hidden', label: '已隐藏' },
  { id: 'disabled', label: '已禁用' },
];

interface Props {
  onClose: () => void;
  /** 打开一个模块。**调用方负责先关闭这个面板** */
  onOpen: (moduleId: string) => void;
}

/** 内容区（模块标签面板）在视口里的矩形 */
interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
}

const AllModulesPanel: React.FC<Props> = ({ onClose, onOpen }) => {
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [frame, setFrame] = useState<Frame | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  /**
   * 把自己对齐到**内容区**，而不是整个窗口。
   *
   * 为什么不能直接 `inset-0`：那样会盖住标题栏与侧边栏 —— 而那两样东西必须一直
   * 可用（侧边栏是导航，标题栏上有窗口按钮）。这一层是"仪表盘里的一个二级界面"，
   * 不是"整个应用的一个模态"，它的地盘就是内容区。
   *
   * 为什么要**量**而不是写死像素：内容区的边界由三件事决定 —— 侧边栏展开还是
   * 折叠、标题栏与标签栏是否显示（全屏时会隐藏）、以及缩放比例。写死任何一组
   * 数字都会在另外两种情形下错位。量的是最近的 `.lc-tab-panel`（它就是那个会
   * 滚动的模块容器），因此这三个因素自动都被算进去了。
   *
   * 跟随：窗口缩放、侧边栏折叠、进出全屏都会改变那个矩形，因此同时挂
   * `resize` 与对它的 `ResizeObserver`。
   *
   * 不需要 portal：模块弹窗（`modules/plugins/Plugins.tsx`）已经在标签面板内部
   * 用 `fixed` 正常工作，说明这条链上没有 `transform`/`will-change` 造成的
   * 包含块 —— 也就是说 `fixed` 的坐标就是视口坐标。而标签未激活时，
   * `visibility: hidden` 会连带把这一层藏起来（与那个弹窗同一个机制）。
   */
  useEffect(() => {
    const host = overlayRef.current?.closest('.lc-tab-panel') as HTMLElement | null;
    if (!host) return;

    const measure = () => {
      const rect = host.getBoundingClientRect();
      setFrame({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };

    measure();
    window.addEventListener('resize', measure);

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(host);

    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = moduleManager.subscribe(() => setVersion((v) => v + 1));
    return unsubscribe;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const active = useMemo(
    () => moduleManager.getActiveModules(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );
  const hidden = useMemo(
    () => moduleManager.getHiddenModules(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );
  const favoriteIds = useMemo(
    () => new Set(moduleManager.getFavoriteIds()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );
  const recentIds = useMemo(
    () => moduleManager.getRecentIds(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );
  const categories = useMemo(
    () => moduleManager.getCategories(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const hiddenIds = useMemo(() => new Set(hidden.map((m) => m.id)), [hidden]);
  const categoryOf = useMemo(() => {
    const map = new Map<string, ModuleCategory>();
    for (const category of categories) {
      for (const moduleId of category.modules) map.set(moduleId, category);
    }
    return map;
  }, [categories]);

  /** 全部模块：可用的与隐藏的都在这里，这正是这个面板存在的意义 */
  const all = useMemo(() => [...active, ...hidden], [active, hidden]);

  const counts = useMemo(
    () => ({
      all: all.length,
      favorite: all.filter((m) => favoriteIds.has(m.id)).length,
      recent: all.filter((m) => recentIds.includes(m.id)).length,
      hidden: hidden.length,
      disabled: all.filter((m) => m.disabled).length,
    }),
    [all, favoriteIds, hidden.length, recentIds]
  );

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return all.filter((module) => {
      const matchesKeyword =
        !keyword ||
        module.name.toLowerCase().includes(keyword) ||
        module.description.toLowerCase().includes(keyword) ||
        module.id.toLowerCase().includes(keyword);
      if (!matchesKeyword) return false;

      switch (filter) {
        case 'favorite':
          return favoriteIds.has(module.id);
        case 'recent':
          return recentIds.includes(module.id);
        case 'hidden':
          return hiddenIds.has(module.id);
        case 'disabled':
          return Boolean(module.disabled);
        default:
          return true;
      }
    });
  }, [all, favoriteIds, filter, hiddenIds, query, recentIds]);

  const reportError = (action: string, error: unknown) => {
    showToast({
      title: `${action}失败`,
      body: error instanceof Error ? error.message : String(error),
      level: 'error',
    });
  };

  const rows = visible.map((module) => {
    const isHidden = hiddenIds.has(module.id);
    const favorited = favoriteIds.has(module.id);
    const category = categoryOf.get(module.id);
    const recent = recentIds.includes(module.id);

    const actions = (
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          title={favorited ? '取消收藏' : '加入收藏'}
          aria-label={favorited ? '取消收藏' : '加入收藏'}
          onClick={(event) => {
            event.stopPropagation();
            void moduleManager.toggleFavoriteModule(module.id).catch((error) => {
              reportError('切换收藏', error);
            });
          }}
          className={`rounded-lg p-1.5 transition-colors ${
            favorited
              ? 'bg-amber-100 text-amber-600'
              : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
          }`}
        >
          <Star className={`h-3.5 w-3.5 ${favorited ? 'fill-current' : ''}`} />
        </button>
        <button
          type="button"
          title={isHidden ? '恢复到侧边栏' : '从侧边栏隐藏'}
          aria-label={isHidden ? '恢复到侧边栏' : '从侧边栏隐藏'}
          onClick={(event) => {
            event.stopPropagation();
            const action = isHidden
              ? moduleManager.showModule(module.id)
              : moduleManager.hideModule(module.id);
            void action.catch((error) => {
              reportError(isHidden ? '恢复模块' : '隐藏模块', error);
            });
          }}
          className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          {isHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
      </div>
    );

    const badges = (
      <>
        {category && (
          <span className="hidden rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 sm:inline">
            {category.name}
          </span>
        )}
        {recent && (
          <span className="hidden items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-600 sm:inline-flex">
            <Clock className="h-2.5 w-2.5" />
            最近
          </span>
        )}
        {isHidden && (
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-600">
            已隐藏
          </span>
        )}
        {module.disabled && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
            已禁用
          </span>
        )}
      </>
    );

    if (viewMode === 'grid') {
      return (
        <button
          key={module.id}
          type="button"
          onClick={() => onOpen(module.id)}
          disabled={module.disabled}
          className="group flex flex-col rounded-2xl border border-gray-100 bg-white p-4 text-left transition-all hover:border-indigo-200 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="flex items-start justify-between">
            <ModuleIcon
              icon={module.icon}
              iconSvg={module.iconSvg}
              name={module.name}
              className="h-7 w-7 text-indigo-600"
            />
            {actions}
          </div>
          <p className="mt-3 text-sm font-semibold text-gray-900 group-hover:text-indigo-600">
            {module.name}
          </p>
          <p className="mt-1 line-clamp-2 flex-1 text-xs leading-relaxed text-gray-500">
            {module.description}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">{badges}</div>
        </button>
      );
    }

    return (
      <button
        key={module.id}
        type="button"
        onClick={() => onOpen(module.id)}
        disabled={module.disabled}
        className="group flex w-full items-center rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-left transition-colors hover:border-gray-200 hover:bg-gray-50/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ModuleIcon
          icon={module.icon}
          iconSvg={module.iconSvg}
          name={module.name}
          className="h-5 w-5 shrink-0 text-indigo-600"
        />
        <div className="ml-3 min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900 group-hover:text-indigo-600">
            {module.name}
          </p>
          <p className="truncate text-xs text-gray-500">{module.description}</p>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-1.5">
          {badges}
          {(module.children?.length ?? 0) > 0 && (
            <span className="hidden items-center gap-0.5 text-[10px] text-gray-400 sm:inline-flex">
              <Hash className="h-3 w-3" />
              {module.children?.length}
            </span>
          )}
          {actions}
        </div>
      </button>
    );
  });

  return (
    <div
      ref={overlayRef}
      // 位置与尺寸由上面的测量给出；量不到时退回整窗（宁可盖住一切，也不要跑出屏幕外）
      className="fixed z-75 flex items-center justify-center bg-gray-900/40 p-4 backdrop-blur-[1px]"
      style={
        frame
          ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height }
          : { inset: 0 }
      }
      role="dialog"
      aria-modal="true"
      aria-labelledby="all-modules-title"
      onClick={onClose}
    >
      <div
        // 点面板内部不该关闭，因此这里拦一下冒泡
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-5 py-3.5">
          <div className="min-w-0">
            <h2 id="all-modules-title" className="text-base font-semibold text-gray-900">
              全部模块
            </h2>
            <p className="mt-0.5 text-[11px] text-gray-500">
              共 {counts.all} 个，含被隐藏在侧边栏里的 {counts.hidden} 个。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            className="ml-auto rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-5 py-2.5">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、描述或 ID"
              className="w-full rounded-lg border border-gray-200 py-1.5 pl-9 pr-3 text-xs outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setFilter(entry.id)}
                className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                  filter === entry.id
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {entry.label} · {counts[entry.id]}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center rounded-lg bg-gray-100 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              title="列表视图"
              aria-label="列表视图"
              className={`rounded-md p-1.5 transition-colors ${
                viewMode === 'list' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500'
              }`}
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              title="网格视图"
              aria-label="网格视图"
              className={`rounded-md p-1.5 transition-colors ${
                viewMode === 'grid' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {visible.length === 0 ? (
            <p className="py-16 text-center text-sm text-gray-400">
              {query.trim() ? `没有匹配「${query.trim()}」的模块` : '这个筛选下没有模块'}
            </p>
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows}
            </div>
          ) : (
            <div className="space-y-2">{rows}</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AllModulesPanel;
