// src/modules/dashboard/Dashboard.tsx
//
// 仪表盘：模块的入口与整理处。
//
// ============================================================
// 这一版改了什么，以及为什么
// ============================================================
//
// 上一版是一个"模块浏览器"：五张统计卡加一片模块网格。它够用，但有两处结构性问题：
//
//   1. 用户无法整理。模块一多，"我知道有这个功能，但它藏在哪一片网格里"就变成
//      一种反复的视觉搜索。收藏与"最近使用"是宿主给的两种排序，而用户想要的
//      分类维度（工作 / 工具 / 娱乐…）只能由他自己定。
//   2. **文案是英文** —— 全应用都是中文，只有这一页是英文，那是模板残留。
//
// 统计面板在 1.3.2 的第二轮里被去掉了，随后按需求加了回来，并**由用户决定是否
// 显示**（`dashboardStatsVisible`，默认显示）。去掉它是我判断错了：那几个数字
// 对新用户回答的是"我装了多少东西、整理到哪一步了"，而判断"它还有没有用"
// 该由用户做，不该由默认值替他做。
//
// ============================================================
// 分类的模型（与后端一致，这里只是消费方）
// ============================================================
//
//   · **一个模块最多属于一个分类**（划分，不是标签）。因此不存在"同一张卡片
//     出现在两个分区里、拖它该拖哪一个"这种没有答案的状态。
//   · **分类成员里可能有当前不存在的模块**（插件被卸载了）。界面只渲染目录里
//     存在的那些，**不做清理** —— 重装之后它会回到原来的位置，而清掉成员等于
//     把用户的整理结果扔掉。
//   · **删除分类不会删模块**，成员回到「未分类」。
//
// ============================================================
// 归类为什么是"指针事件自己实现"，而不是 HTML5 拖放
// ============================================================
//
// 本应用里 HTML5 拖放**整体不可用**：Tauri 的 `dragDropEnabled` 默认拦截系统
// 拖放，而插件的 `ctx.fileDrop` 正依赖它，不能关。标签拖拽与分屏拖拽因此都用
// 指针事件自己实现（见 `services/tabDrag.ts`）—— 这是第三处，规则相同：
// `pointerdown` 记起点 → 超过阈值才算拖动（否则会吃掉点击）→ 自己算落点 →
// 自己画一个跟随指针的幽灵。
//
// **拖动之外还保留"移动到分类"菜单**：键盘用户拖不了。两条路都通向同一个
// `setModuleCategory`，因此不存在"两条路行为不一致"的问题。
//
// ============================================================
// 性能
// ============================================================
//
// `useModuleActive()` 在这里只有一个用途：**标签不可见时不播入场动画**。
// 上一版的长延迟 stagger（`0.15 + i*0.06` 秒）正是"切走仪表盘后卡片还残留一会"
// 的成因（见已知问题 7.27 节）。这一页没有轮询、也没有定时器，因此没有别的需要
// 暂停的东西 —— 不假装有。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart3,
  Bookmark,
  Check,
  Clock,
  Eye,
  EyeOff,
  FolderPlus,
  FolderTree,
  Hash,
  LayoutGrid,
  List,
  Pencil,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useSidebar } from '@/contexts/SidebarContext';
import ModuleIcon from '../../components/ModuleIcon';
import { moduleManager, type ModuleCategory } from '../../services/moduleManager';
import { getCachedSettings, saveAppSettings, subscribeSettings } from '../../services/appSettings';
import { showToast } from '../../services/toast';
import { useModuleActive } from '../../hooks/useModuleActive';
import type { ModuleDescriptor } from '../../types/module';
import AllModulesPanel from './AllModulesPanel';
import { resolveDropIndex as resolveDropIndexPure, type DropTarget } from './dropIndex';

type ViewMode = 'grid' | 'list';

/** 未分类分区的保留标识。它不是一个真分类 —— 后端里没有它对应的记录 */
const UNCATEGORIZED = '__uncategorized__';

/**
 * 拖动与点击的分界（像素）。
 *
 * 没有这个阈值，任何一次点击都会先被当成拖动的起点，而"抬起时位移 0"会让
 * 点击与拖动无法区分。6px 是常见取值：小于它，手抖不至于把点击吃掉；
 * 大于它，用户不必刻意"按住再拖"。
 */
const DRAG_THRESHOLD_PX = 6;

/**
 * 当前的落点：**去哪个分类、插在第几位**。
 *
 * `categoryId` 为 `null` 表示「未分类」。位置由拖动方自己算出来交给后端 ——
 * 拖动表达的是"放在这两张卡片之间"，把它换算成"上移一位"需要知道前端的当前
 * 顺序，而那个顺序可能已经过期（一次失败的写盘、或另一个入口刚改过）。
 *
 * 换算本身（同一个分类内向下拖要减一）在 `dropIndex.ts` 里，并配了断言。
 */
type DropTargetState = DropTarget;

// ==================== 动画 ====================

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.02 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.18 } },
};

// ==================== 小组件 ====================

/**
 * 分区标题行。
 *
 * `tone` 决定图标底色：**收藏那一段保持黄色**。它曾经被统一成强调色，理由是
 * "整页用一套色更干净"—— 但那让收藏在视觉上与普通分区没有区别，而收藏恰恰是
 * 用户自己标出来的一类东西，值得在扫视时被认出来。
 */
const SectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  count: number;
  hint?: string;
  tone?: 'accent' | 'amber';
  onRename?: (name: string) => void;
  onDelete?: () => void;
}> = ({ icon, title, count, hint, tone = 'accent', onRename, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, title]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== title) onRename?.(next);
  };

  const plate = tone === 'amber' ? 'bg-amber-100 text-amber-600' : 'bg-indigo-100 text-indigo-600';

  return (
    <div className="mb-3 flex items-center gap-2">
      <div className={`flex h-6 w-6 items-center justify-center rounded-lg ${plate}`}>{icon}</div>

      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') setEditing(false);
            }}
            maxLength={24}
            className="w-40 rounded-lg border border-indigo-300 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-100"
          />
          <button
            type="button"
            onClick={commit}
            className="rounded-lg p-1 text-emerald-600 hover:bg-emerald-50"
            aria-label="确定"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100"
            aria-label="取消"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
          <span className="text-xs text-gray-400">· {count} 个模块</span>
        </>
      )}

      {hint && !editing && <span className="text-xs text-gray-400">{hint}</span>}

      <div className="ml-auto flex items-center gap-0.5">
        {confirming ? (
          <>
            <span className="mr-1 text-[11px] text-red-700">删除分类？模块会回到未分类</span>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                onDelete?.();
              }}
              className="rounded-lg px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50"
            >
              删除
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100"
            >
              取消
            </button>
          </>
        ) : (
          <>
            {onRename && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                title="重命名"
                aria-label={`重命名分类 ${title}`}
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {onDelete && !editing && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                title="删除分类"
                aria-label={`删除分类 ${title}`}
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

/** 统计卡 */
const StatCard: React.FC<{
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  plate: string;
}> = ({ label, value, icon: Icon, plate }) => (
  <div className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3">
    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${plate}`}>
      <Icon className="h-4 w-4" />
    </div>
    <div className="min-w-0">
      <p className="text-xl font-bold tabular-nums text-gray-900">{value}</p>
      <p className="truncate text-[11px] text-gray-500">{label}</p>
    </div>
  </div>
);

/** 卡片/列表项上的操作按钮 */
const ActionButton: React.FC<{
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, active, children }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    className={`rounded-lg p-1.5 transition-colors ${
      active ? 'bg-amber-100 text-amber-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
    }`}
  >
    {children}
  </button>
);

/**
 * 模块图标。
 *
 * **不带底色。** 模块图标自带形状与颜色（内建模块用 lucide 图标，插件用它们自己的
 * SVG），再套一层彩色底板，等于在每个图标后面放一个与它无关的色块 —— 同一片网格
 * 里十几块同色方块，看起来像没加载完的占位。图标本身就是识别物，不需要被框起来。
 */
const ModuleGlyph: React.FC<{ module: ModuleDescriptor; className?: string }> = ({
  module,
  className = 'h-6 w-6 text-indigo-600',
}) => (
  <ModuleIcon icon={module.icon} iconSvg={module.iconSvg} name={module.name} className={className} />
);

/** 模块卡片（网格）。拖动由外层的指针事件驱动，这里只负责把"正在拖"画出来 */
const ModuleCard: React.FC<{
  module: ModuleDescriptor;
  favorited: boolean;
  recent: boolean;
  categoryName?: string;
  dragging: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onToggleHidden: () => void;
  onMove: () => void;
  onPointerDown: (event: React.PointerEvent) => void;
}> = ({
  module,
  favorited,
  recent,
  categoryName,
  dragging,
  onOpen,
  onToggleFavorite,
  onToggleHidden,
  onMove,
  onPointerDown,
}) => (
  <motion.div
    variants={cardVariants}
    whileHover={dragging ? undefined : { y: -2 }}
    onPointerDown={onPointerDown}
    onClick={module.disabled ? undefined : onOpen}
    className={`group relative flex cursor-pointer flex-col rounded-2xl border border-gray-100 bg-white p-4 transition-all hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-100/50 ${
      module.disabled ? 'cursor-not-allowed opacity-50' : ''
    } ${dragging ? 'opacity-40' : ''}`}
  >
    <div className="flex items-start justify-between">
      <ModuleGlyph module={module} className="h-7 w-7 text-indigo-600" />
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <ActionButton
          title={favorited ? '取消收藏' : '加入收藏'}
          active={favorited}
          onClick={onToggleFavorite}
        >
          <Star className={`h-3.5 w-3.5 ${favorited ? 'fill-current' : ''}`} />
        </ActionButton>
        <ActionButton title="从侧边栏隐藏" onClick={onToggleHidden}>
          <EyeOff className="h-3.5 w-3.5" />
        </ActionButton>
        <ActionButton title="移动到分类" onClick={onMove}>
          <FolderTree className="h-3.5 w-3.5" />
        </ActionButton>
      </div>
    </div>

    <h3 className="mt-3 text-sm font-semibold text-gray-900 transition-colors group-hover:text-indigo-600">
      {module.name}
    </h3>
    <p className="mt-1 line-clamp-2 flex-1 text-xs leading-relaxed text-gray-500">
      {module.description}
    </p>

    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {recent && (
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-600">
          <Clock className="h-2.5 w-2.5" />
          最近
        </span>
      )}
      {module.badge && (
        <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-600">
          {module.badge}
        </span>
      )}
      {categoryName && (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
          {categoryName}
        </span>
      )}
      {module.disabled && (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">已禁用</span>
      )}
      {(module.children?.length ?? 0) > 0 && (
        <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-gray-400">
          <Hash className="h-3 w-3" />
          {module.children?.length}
        </span>
      )}
    </div>
  </motion.div>
);

/** 模块行（列表） */
const ModuleRow: React.FC<{
  module: ModuleDescriptor;
  favorited: boolean;
  recent: boolean;
  categoryName?: string;
  dragging: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onToggleHidden: () => void;
  onMove: () => void;
  onPointerDown: (event: React.PointerEvent) => void;
}> = ({
  module,
  favorited,
  recent,
  categoryName,
  dragging,
  onOpen,
  onToggleFavorite,
  onToggleHidden,
  onMove,
  onPointerDown,
}) => (
  <div
    onPointerDown={onPointerDown}
    onClick={module.disabled ? undefined : onOpen}
    className={`group flex cursor-pointer items-center rounded-xl border border-gray-100 bg-white px-3 py-2.5 transition-colors hover:border-gray-200 hover:bg-gray-50/60 ${
      module.disabled ? 'cursor-not-allowed opacity-50' : ''
    } ${dragging ? 'opacity-40' : ''}`}
  >
    <ModuleGlyph module={module} className="h-5 w-5 shrink-0 text-indigo-600" />
    <div className="ml-3 min-w-0 flex-1">
      <p className="flex items-center gap-1.5 truncate text-sm font-medium text-gray-900">
        {module.name}
        {favorited && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
      </p>
      <p className="truncate text-xs text-gray-500">{module.description}</p>
    </div>
    <div className="ml-3 flex shrink-0 items-center gap-1.5">
      {categoryName && (
        <span className="hidden rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 sm:inline">
          {categoryName}
        </span>
      )}
      {recent && (
        <span className="hidden rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-600 sm:inline">
          最近
        </span>
      )}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <ActionButton
          title={favorited ? '取消收藏' : '加入收藏'}
          active={favorited}
          onClick={onToggleFavorite}
        >
          <Star className={`h-3.5 w-3.5 ${favorited ? 'fill-current' : ''}`} />
        </ActionButton>
        <ActionButton title="从侧边栏隐藏" onClick={onToggleHidden}>
          <EyeOff className="h-3.5 w-3.5" />
        </ActionButton>
        <ActionButton title="移动到分类" onClick={onMove}>
          <FolderTree className="h-3.5 w-3.5" />
        </ActionButton>
      </div>
    </div>
  </div>
);

/**
 * 「移动到分类」菜单。
 *
 * **点空白关闭靠容器 ref + document 监听，不用一层 `fixed inset-0` 的透明遮罩。**
 * 后者在这里是坏的：卡片外面套着 `motion.div`，而 framer-motion 的入场动画会写
 * `transform`，于是在卡片内 `position: fixed` 的元素**以卡片为包含块**而不是
 * 视口 —— 那层遮罩会缩成卡片那么大，点空白处根本关不掉。
 */
const MoveMenu: React.FC<{
  module: ModuleDescriptor;
  categories: ModuleCategory[];
  currentId: string | undefined;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onPick: (categoryId: string | null) => void;
}> = ({ module, categories, currentId, containerRef, onPick }) => (
  <div
    ref={containerRef}
    className="absolute right-0 top-full z-60 mt-1 w-52 overflow-hidden rounded-xl border border-gray-200 bg-white py-1.5 shadow-2xl"
  >
    <p className="truncate px-3 py-1 text-[11px] text-gray-400">{module.name}</p>
    {categories.map((category) => (
      <button
        key={category.id}
        type="button"
        onClick={() => onPick(category.id)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
      >
        <span className="w-3.5 shrink-0">
          {currentId === category.id && <Check className="h-3.5 w-3.5 text-indigo-600" />}
        </span>
        <span className="truncate">{category.name}</span>
      </button>
    ))}
    {categories.length === 0 && (
      <p className="px-3 py-1.5 text-[11px] text-gray-400">还没有分类，先新建一个</p>
    )}
    <div className="my-1 border-t border-gray-100" />
    <button
      type="button"
      onClick={() => onPick(null)}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
    >
      <span className="w-3.5 shrink-0">
        {!currentId && <Check className="h-3.5 w-3.5 text-indigo-600" />}
      </span>
      未分类
    </button>
  </div>
);

/**
 * 「有 N 个模块被隐藏在侧边栏」。
 *
 * 这一条是必要的：隐藏是一个**只影响侧边栏**的动作，而仪表盘此前会把它们一起
 * 藏掉 —— 用户点一下"隐藏"，模块就从这个页面上消失了，既不记得做过什么，
 * 也没有一条回到它的路。这里只提示数量与去处，不在仪表盘上重复实现那个面板。
 */
const HiddenHint: React.FC<{ count: number }> = ({ count }) => {
  if (count === 0) return null;
  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-gray-400">
      <Eye className="h-3.5 w-3.5" />
      另有 {count} 个模块被隐藏在侧边栏里 —— 在侧边栏底部的「隐藏的模块」里可以恢复。
    </p>
  );
};

// ==================== 主组件 ====================

const Dashboard: React.FC = () => {
  const { setActiveModule } = useSidebar();
  const isActive = useModuleActive();

  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  /** 「全部模块」二级面板是否打开 */
  const [showAll, setShowAll] = useState(false);
  /** 拖到哪个分区的第几位上（`undefined` = 当前没有落点） */
  const [dropTarget, setDropTarget] = useState<DropTarget | undefined>(undefined);
  const [dragModuleId, setDragModuleId] = useState<string | null>(null);
  const [dragPointer, setDragPointer] = useState<{ x: number; y: number } | null>(null);

  /** 指针按下时的起点。**不是一个 state** —— 它每次 pointermove 都要读，放进 state 会引发无谓的重渲染 */
  const pressRef = useRef<{ moduleId: string; x: number; y: number } | null>(null);
  /**
   * 最新的分区表。
   *
   * 拖动结束时要按它把"落点下标"换算成"移除之后的下标"（见 `resolveDropIndex`），
   * 而那个换算发生在 window 的 pointerup 监听里 —— 把 `sections` 放进那个 effect
   * 的依赖，会让每次数据变化都重建一遍监听。用一个 ref 读最新值，监听只需要建一次。
   */
  const sectionsRef = useRef<Array<{ id: string; modules: ModuleDescriptor[] }>>([]);

  /** 统计面板是否显示（用户可关，默认显示） */
  const [statsVisible, setStatsVisible] = useState(
    () => getCachedSettings().dashboardStatsVisible
  );

  // ==================== 数据 ====================

  useEffect(() => {
    const unsubscribe = moduleManager.subscribe(() => setVersion((v) => v + 1));
    return unsubscribe;
  }, []);

  useEffect(() => {
    return subscribeSettings(() => setStatsVisible(getCachedSettings().dashboardStatsVisible));
  }, []);

  // 同步初值：与 useModuleList 同样的理由（订阅建立前可能已经发生过变化）
  const modules = useMemo(
    () => moduleManager.getActiveModules(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );
  const hiddenModules = useMemo(
    () => moduleManager.getHiddenModules(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );
  const categories = useMemo(
    () => moduleManager.getCategories(),
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

  const byId = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);
  const categoryOf = useMemo(() => {
    const map = new Map<string, ModuleCategory>();
    for (const category of categories) {
      for (const moduleId of category.modules) map.set(moduleId, category);
    }
    return map;
  }, [categories]);

  const recentModules = useMemo(
    () => recentIds.map((id) => byId.get(id)).filter(Boolean).slice(0, 6) as ModuleDescriptor[],
    [byId, recentIds]
  );
  const favoriteModules = useMemo(
    () => modules.filter((m) => favoriteIds.has(m.id)),
    [favoriteIds, modules]
  );

  const stats = useMemo(() => {
    const all = [...modules, ...hiddenModules];
    const disabled = all.filter((m) => m.disabled).length;
    const hidden = hiddenModules.length;
    const total = all.length;
    return {
      total,
      enabled: total - hidden - disabled,
      favorites: favoriteIds.size,
      hidden,
      disabled,
    };
  }, [favoriteIds, hiddenModules, modules]);

  /**
   * 分区。
   *
   * 「未分类」**只在真的有内容时出现** —— 一个空分区占着一行标题，除了让人以为
   * 丢了东西之外没有作用。而全部分类都空着时，这一页会显示引导。
   */
  const sections = useMemo(() => {
    const list: Array<{
      id: string;
      name: string;
      modules: ModuleDescriptor[];
      category?: ModuleCategory;
    }> = [];

    for (const category of categories) {
      // 只渲染目录里存在的模块：被卸载的插件留下的 ID 在这里被跳过，但**不清理**
      const members = category.modules
        .map((id) => byId.get(id))
        .filter((m): m is ModuleDescriptor => Boolean(m));
      list.push({ id: category.id, name: category.name, modules: members, category });
    }

    const assigned = new Set(categories.flatMap((category) => category.modules));
    const rest = modules.filter((m) => !assigned.has(m.id));
    if (rest.length > 0) {
      list.push({ id: UNCATEGORIZED, name: '未分类', modules: rest });
    }

    return list;
  }, [byId, categories, modules]);

  // 让 pointerup 的监听能读到最新的分区表（见 sectionsRef 的说明）
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  /**
   * 把"落点下标"换算成**移除之后**的下标。
   *
   * 拖动时算出的下标是按"模块还在原处"的列表数的，而后端是**先摘掉再插入**。
   * 因此同一个分类里向下拖时下标要减一：`[a,b,c]` 把 `a` 拖到 b 与 c 之间，
   * 落点下标是 2，但摘掉 a 之后的目标位置是 1 —— 不减这一下，结果是 `[b,c,a]`
   * 而不是 `[b,a,c]`，而且只在"向下拖"时错，向上拖是对的。
   *
   * 跨分类时不需要换算：源列表与目标列表是两个数组。
   */
  const resolveDropIndex = useCallback(
    (moduleId: string, drop: DropTargetState): number => {
      const from = sectionsRef.current.find((section) =>
        section.modules.some((module) => module.id === moduleId)
      );
      if (!from) return resolveDropIndexPure(undefined, drop);

      return resolveDropIndexPure(
        {
          categoryId: from.id === UNCATEGORIZED ? null : from.id,
          index: from.modules.findIndex((module) => module.id === moduleId),
        },
        drop
      );
    },
    []
  );

  /** 搜索结果：有搜索词时拍平，不再按分类分组 —— 用户此刻找的是"那一个" */
  const searchResults = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return null;
    return modules.filter(
      (m) =>
        m.name.toLowerCase().includes(keyword) ||
        m.description.toLowerCase().includes(keyword) ||
        m.id.toLowerCase().includes(keyword)
    );
  }, [modules, query]);

  // ==================== 操作 ====================

  const reportError = useCallback((action: string, error: unknown) => {
    showToast({
      title: `${action}失败`,
      body: error instanceof Error ? error.message : String(error),
      level: 'error',
    });
  }, []);

  const handleOpen = useCallback(
    (moduleId: string) => {
      setActiveModule(moduleId);
      void moduleManager.recordModuleOpen(moduleId).catch((error) => {
        // 记录失败只影响"最近使用"的排序，不影响打开本身
        console.warn('[dashboard] 记录模块打开失败:', error);
      });
    },
    [setActiveModule]
  );

  const handleToggleFavorite = useCallback(
    (moduleId: string) => {
      void moduleManager.toggleFavoriteModule(moduleId).catch((error) => {
        reportError('切换收藏', error);
      });
    },
    [reportError]
  );

  const handleToggleHidden = useCallback(
    (moduleId: string) => {
      void moduleManager.hideModule(moduleId).catch((error) => {
        reportError('隐藏模块', error);
      });
    },
    [reportError]
  );

  const handleMove = useCallback(
    (moduleId: string, categoryId: string | null, index?: number) => {
      setMenuFor(null);
      void moduleManager.setModuleCategory(moduleId, categoryId, index).catch((error) => {
        reportError('移动分类', error);
      });
    },
    [reportError]
  );

  const handleCreate = useCallback(() => {
    const name = draftName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    void moduleManager
      .createCategory(name)
      .then(() => {
        setDraftName('');
        setCreating(false);
      })
      .catch((error) => {
        // **不关闭输入框**：名字重名或超长时，用户改一下就能继续，
        // 关掉它等于让他把刚打的字重打一遍
        reportError('新建分类', error);
      });
  }, [draftName, reportError]);

  // ==================== 拖动归类 ====================

  /**
   * 落点判定：从指针位置往下取元素，找最近的 `data-category-drop`，再在它内部
   * 算出插入到第几位。
   *
   * 用 `elementFromPoint` 而不是给每个分区挂 `pointerenter`：后者要求指针真的
   * 进入那个元素才触发，而拖动中指针下面永远是我们自己画的幽灵 —— 幽灵带了
   * `pointer-events-none`，所以能穿透到下面，但"穿过一堆积木"的层级判断交给
   * 浏览器做一次，比我们自己维护一套要可靠。
   *
   * 位置取"最近的卡片 + 指针在它中线的哪一侧"：网格里横向排列，因此看 x；
   * 列表里是一列，因此看 y。这也解释了为什么要按 viewMode 分支 —— 用同一个轴
   * 去判两种布局，总有一种会算反。
   */
  const hitTest = useCallback(
    (x: number, y: number): DropTarget | undefined => {
      const element = document.elementFromPoint(x, y);
      const section = element?.closest('[data-category-drop]') as HTMLElement | null;
      if (!section) return undefined;

      const raw = section.dataset.categoryDrop ?? '';
      const categoryId = raw === '' ? null : raw;

      const cards = Array.from(section.querySelectorAll<HTMLElement>('[data-module-slot]'));
      let index = cards.length;
      let nearest = Number.POSITIVE_INFINITY;

      for (let i = 0; i < cards.length; i += 1) {
        const rect = cards[i].getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.hypot(x - centerX, y - centerY);
        if (distance < nearest) {
          nearest = distance;
          const before = viewMode === 'grid' ? x < centerX : y < centerY;
          index = before ? i : i + 1;
        }
      }

      return { categoryId, index };
    },
    [viewMode]
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;

      if (!dragModuleId) {
        const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
        if (distance < DRAG_THRESHOLD_PX) return;
        setDragModuleId(press.moduleId);
      }

      setDragPointer({ x: event.clientX, y: event.clientY });
      setDropTarget(hitTest(event.clientX, event.clientY));
    };

    const onPointerUp = () => {
      const press = pressRef.current;
      const moduleId = dragModuleId;
      pressRef.current = null;

      if (press && moduleId && dropTarget !== undefined) {
        handleMove(moduleId, dropTarget.categoryId, resolveDropIndex(moduleId, dropTarget));

        /*
         * 吃掉紧随其后的那一次 click —— 否则"拖着模块放到另一个分类"会在放手时
         * 顺手把那个模块打开。
         *
         * 为什么不是"一个布尔标记 + 在 handleOpen 里读"：那个标记在**这次拖动
         * 没有产生 click** 时（例如在空白处放手）不会被清掉，于是它会静默地吃掉
         * 用户的下一次点击。这里用一次性的捕获监听，并且**在下一次 pointerdown
         * 时把它摘掉** —— 那一定发生在任何可能出现的 click 之后，因此既不会漏掉
         * 要吃掉的那一次，也不会多活。
         */
        const swallow = (event: MouseEvent) => {
          event.stopPropagation();
          event.preventDefault();
        };
        const drop = () => {
          window.removeEventListener('click', swallow, true);
          window.removeEventListener('pointerdown', drop, true);
        };
        window.addEventListener('click', swallow, true);
        window.addEventListener('pointerdown', drop, true);
      }

      setDragModuleId(null);
      setDragPointer(null);
      setDropTarget(undefined);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [dragModuleId, dropTarget, handleMove, hitTest, resolveDropIndex]);

  // 点菜单之外的地方关闭它。判定用容器 ref 而不是"点任何地方都关"：
  // 后者会让菜单项自己的点击在 pointerdown 阶段就把菜单摘掉，React 随后
  // 可能根本收不到那个 onClick（节点已经不在了）。
  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuFor(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuFor]);

  const onCardPointerDown = useCallback((moduleId: string, event: React.PointerEvent) => {
    // 只认主键、只认鼠标与触控笔：触摸上的横向拖动会与滚动打架，
    // 而这一页在桌面端主要是鼠标操作（触摸用户仍然可以用"移动到分类"菜单）
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') return;

    /*
     * 阻止 pointerdown 的默认行为。
     *
     * 它的默认行为里包括**开始文本选择**与聚焦，而这两件都不是我们要的：
     * 拖动时指针会扫过卡片上的名字与描述，不阻止就会拖出一大片高亮（用户的原话
     * 是"拖动时会有很多文字被选择"）。阻止它不影响 click —— click 不是 pointerdown
     * 的默认动作，因此"点一下打开模块"照常。
     *
     * 与容器上的 `select-none` 是**两层**：这一层管住"从卡片上开始"的那次选择，
     * `select-none` 管住指针扫过其它文字时的选择。少了任何一层都会漏。
     */
    event.preventDefault();
    pressRef.current = { moduleId, x: event.clientX, y: event.clientY };
  }, []);

  // ==================== 渲染 ====================

  const renderModule = (
    module: ModuleDescriptor,
    slot?: { sectionId: string; index: number }
  ) => {
    const category = categoryOf.get(module.id);
    const dragging = dragModuleId === module.id;
    const common = {
      module,
      favorited: favoriteIds.has(module.id),
      recent: recentIds.includes(module.id),
      categoryName: category?.name,
      dragging,
      onOpen: () => handleOpen(module.id),
      onToggleFavorite: () => handleToggleFavorite(module.id),
      onToggleHidden: () => handleToggleHidden(module.id),
      onMove: () => setMenuFor((current) => (current === module.id ? null : module.id)),
      onPointerDown: (event: React.PointerEvent) => onCardPointerDown(module.id, event),
    };

    const menu = menuFor === module.id && (
      <MoveMenu
        module={module}
        categories={categories}
        currentId={category?.id}
        containerRef={menuRef}
        onPick={(categoryId) => handleMove(module.id, categoryId)}
      />
    );

    // 插入指示线：落点在第 index 位就是"插在这张卡片之前"。
    // 它**必须是可见的**：拖动在这一页只改变两件事（分区与位置），
    // 没有这条线，用户只能靠抬起后的结果判断自己放对了没有。
    const slotId = slot && (slot.sectionId === UNCATEGORIZED ? null : slot.sectionId);
    const showIndicator =
      dropTarget !== undefined && slot !== undefined && dropTarget.categoryId === slotId &&
      dropTarget.index === slot.index;

    const indicator = showIndicator ? (
      <span
        aria-hidden
        className="pointer-events-none absolute -left-1.5 inset-y-1 w-0.5 rounded-full bg-indigo-500"
      />
    ) : null;

    return viewMode === 'grid' ? (
      <div key={module.id} data-module-slot className="relative">
        {indicator}
        <ModuleCard {...common} />
        {menu}
      </div>
    ) : (
      <div key={module.id} data-module-slot className="relative">
        {indicator}
        <ModuleRow {...common} />
        {menu}
      </div>
    );
  };

  const gridClass =
    viewMode === 'grid'
      ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
      : 'space-y-2';

  const sectionHighlighted = (id: string): boolean => {
    const dropId = id === UNCATEGORIZED ? null : id;
    return dropTarget !== undefined && dropTarget.categoryId === dropId;
  };

  const dropHint = (id: string): string =>
    sectionHighlighted(id) ? 'bg-indigo-50/40 ring-2 ring-indigo-200' : '';

  return (
    /*
     * `select-none` 放在这一层，理由只有一个：**拖动时不该选中文字**。指针在拖动
     * 过程中会扫过卡片上的名字、描述与分区标题，不禁止就会拖出一大片高亮 ——
     * 用户的原话是"拖动时会有很多文字被选择"。这一页没有任何值得复制的文本，
     * 因此整页禁止选择的代价是零。
     *
     * **但输入框必须放行**：`select-none` 会继承下去，而分类重命名框、新建分类框
     * 与二级面板里的搜索框都在这一层内部 —— 继承到它们身上会让里面的文字选不中，
     * 那是比原问题更糟的缺陷。`[&_input]:select-auto` 就是为这件事写的。
     *
     * 与卡片上的 `preventDefault()` 是两层：那一层管住"从卡片上开始"的那次选择，
     * 这一层管住指针扫过其它文字时的选择。少了任何一层都会漏。
     */
    <motion.div
      initial={isActive ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      className="mx-auto max-w-7xl select-none px-4 pb-12 [&_input]:select-auto [&_textarea]:select-auto"
    >
      {/* 头部 */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">仪表盘</h1>
          <p className="mt-1 text-sm text-gray-500">
            打开模块，或者把它们拖到自己建的分类里。
          </p>
        </div>

        {creating ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleCreate();
                if (event.key === 'Escape') {
                  setCreating(false);
                  setDraftName('');
                }
              }}
              maxLength={24}
              placeholder="分类名，例如「工作」"
              className="w-52 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
            <button
              type="button"
              onClick={handleCreate}
              className="rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
            >
              创建
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setDraftName('');
              }}
              className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-50"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {/*
              「全部模块」是一个**二级面板**而不是第三个按钮堆里的一个开关：
              它回答的是与主视图不同的问题（"一共有什么"对"我整理过的分区"），
              因此需要自己的空间、搜索与筛选。见 AllModulesPanel 的文件头。
            */}
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50"
            >
              <LayoutGrid className="h-4 w-4" />
              全部模块
              <span className="text-xs text-gray-400">· {stats.total}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const next = !statsVisible;
                setStatsVisible(next);
                void saveAppSettings({ dashboardStatsVisible: next }).catch((error) => {
                  // 失败时 saveAppSettings 已经回滚了缓存，订阅会把状态改回去
                  reportError('切换统计面板', error);
                });
              }}
              title={statsVisible ? '收起统计' : '显示统计'}
              aria-pressed={statsVisible}
              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-50"
            >
              <BarChart3 className="h-4 w-4" />
              {statsVisible ? '收起统计' : '显示统计'}
            </button>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50"
            >
              <FolderPlus className="h-4 w-4" />
              新建分类
            </button>
          </div>
        )}
      </div>

      {/* 统计面板（可收起） */}
      {statsVisible && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard
            label="模块总数"
            value={stats.total}
            icon={LayoutGrid}
            plate="bg-indigo-50 text-indigo-600"
          />
          <StatCard
            label="已启用"
            value={stats.enabled}
            icon={Eye}
            plate="bg-emerald-50 text-emerald-600"
          />
          <StatCard
            label="收藏"
            value={stats.favorites}
            icon={Star}
            plate="bg-amber-50 text-amber-600"
          />
          <StatCard
            label="已隐藏"
            value={stats.hidden}
            icon={EyeOff}
            plate="bg-orange-50 text-orange-600"
          />
          <StatCard
            label="已禁用"
            value={stats.disabled}
            icon={BarChart3}
            plate="bg-gray-100 text-gray-600"
          />
        </div>
      )}

      {/* 工具栏 */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模块…"
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm outline-none transition-all focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        <div className="ml-auto flex items-center rounded-xl bg-gray-100 p-1">
          <button
            type="button"
            onClick={() => setViewMode('grid')}
            title="网格视图"
            aria-label="网格视图"
            className={`rounded-lg p-2 transition-colors ${
              viewMode === 'grid'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode('list')}
            title="列表视图"
            aria-label="列表视图"
            className={`rounded-lg p-2 transition-colors ${
              viewMode === 'list'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 搜索结果：有搜索词时只显示结果，不再按分类分块 */}
      {searchResults ? (
        <section>
          <SectionHeader
            icon={<Search className="h-3.5 w-3.5" />}
            title="搜索结果"
            count={searchResults.length}
            hint={searchResults.length === 0 ? '换个词试试' : undefined}
          />
          {searchResults.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
              没有匹配「{query.trim()}」的模块
            </p>
          ) : (
            <motion.div
              variants={containerVariants}
              initial={isActive ? 'hidden' : false}
              animate="visible"
              className={gridClass}
            >
              {/* 搜索结果不参与拖动归类：它不是分区，没有"第几位"的语义 */}
              {searchResults.map((module) => renderModule(module))}
            </motion.div>
          )}
        </section>
      ) : (
        <>
          {/* 快速进入：收藏与最近。只是把已有的两个入口提到首屏，不重复实现 */}
          {(favoriteModules.length > 0 || recentModules.length > 0) && (
            <section className="mb-7">
              {favoriteModules.length > 0 && (
                <div className="mb-3">
                  <SectionHeader
                    icon={<Bookmark className="h-3.5 w-3.5" />}
                    title="收藏"
                    count={favoriteModules.length}
                    tone="amber"
                  />
                  <div className="flex flex-wrap gap-2">
                    {favoriteModules.map((module) => (
                      <button
                        key={module.id}
                        type="button"
                        onClick={() => handleOpen(module.id)}
                        className="inline-flex items-center gap-2 rounded-xl border border-amber-200/70 bg-white px-3 py-2 text-sm text-gray-700 transition-colors hover:border-amber-300 hover:bg-amber-50/40"
                      >
                        <ModuleGlyph module={module} className="h-4 w-4 text-amber-600" />
                        {module.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {recentModules.length > 0 && (
                <div>
                  <SectionHeader
                    icon={<Clock className="h-3.5 w-3.5" />}
                    title="最近使用"
                    count={recentModules.length}
                  />
                  <div className="flex flex-wrap gap-2">
                    {recentModules.map((module) => (
                      <button
                        key={module.id}
                        type="button"
                        onClick={() => handleOpen(module.id)}
                        className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition-colors hover:border-indigo-200 hover:bg-indigo-50/40"
                      >
                        <ModuleGlyph module={module} className="h-4 w-4 text-indigo-600" />
                        {module.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 分类分区。每个分区都是拖动落点（`data-category-drop`） */}
          {sections.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 py-16 text-center">
              <p className="text-sm text-gray-500">暂时没有可显示的模块</p>
              <p className="mt-1 text-xs text-gray-400">
                模块可以在「设置 → 插件」里启用，或把隐藏在侧边栏里的模块恢复出来。
              </p>
            </div>
          ) : (
            sections.map((section) => (
              <section
                key={section.id}
                data-category-drop={section.id === UNCATEGORIZED ? '' : section.id}
                /*
                 * 高亮框（拖动落点）要比内容**大一圈**，否则那条 2px 的描边会正好
                 * 压在分类标题的图标上 —— 用户的原话是"出现的时候就与分类列表的
                 * 图标重叠"。
                 *
                 * 做法是 `p-3` 加负外边距：盒子向四周各扩 12px，而内容的位置一点
                 * 不变。负边距同时在竖直方向吃掉了 12px，因此下边距从 `mb-7`(28)
                 * 改成 `mb-4`(16)，让**内容之间**的间距仍是 28px —— 扩出来的那一圈
                 * 是纯视觉的，不改变任何排布。
                 *
                 * 横向扩出去的那 12px 需要外层有足够的内边距接住，因此仪表盘根容器
                 * 的内边距是 `px-4`(16) 而不是 `px-2`(8)：后者会让描边被标签面板的
                 * `overflow-x-hidden` 裁掉。
                 */
                className={`-mx-3 -mt-3 mb-4 rounded-2xl p-3 transition-shadow ${dropHint(section.id)}`}
              >
                <SectionHeader
                  icon={<FolderTree className="h-3.5 w-3.5" />}
                  title={section.name}
                  count={section.modules.length}
                  hint={
                    section.id === UNCATEGORIZED && categories.length === 0
                      ? '新建一个分类，把模块拖进去'
                      : undefined
                  }
                  onRename={
                    section.category
                      ? (name) => {
                          void moduleManager.renameCategory(section.id, name).catch((error) => {
                            reportError('重命名分类', error);
                          });
                        }
                      : undefined
                  }
                  onDelete={
                    section.category
                      ? () => {
                          void moduleManager.deleteCategory(section.id).catch((error) => {
                            reportError('删除分类', error);
                          });
                        }
                      : undefined
                  }
                />

                {section.modules.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
                    这个分类还是空的 —— 把模块拖到这里，或用卡片上的
                    <FolderTree className="mx-1 inline h-3 w-3 align-text-bottom" />
                    移动进来
                  </p>
                ) : (
                  <motion.div
                    variants={containerVariants}
                    initial={isActive ? 'hidden' : false}
                    animate="visible"
                    className={gridClass}
                  >
                    {section.modules.map((module, index) =>
                      renderModule(module, { sectionId: section.id, index })
                    )}
                  </motion.div>
                )}
              </section>
            ))
          )}

          <HiddenHint count={stats.hidden} />
        </>
      )}

      {/* 「全部模块」二级面板。打开模块时**先关掉自己** —— 否则模块在后台标签里
          打开了，而这一层还盖在上面，用户会以为"点了没反应" */}
      {showAll && (
        <AllModulesPanel
          onClose={() => setShowAll(false)}
          onOpen={(moduleId) => {
            setShowAll(false);
            handleOpen(moduleId);
          }}
        />
      )}

      {/* 拖动中的幽灵。`pointer-events-none` 是必需的：它跟着指针，不放行的话
          `elementFromPoint` 永远只会取到它自己，落点判定就失效了 */}
      {dragModuleId && dragPointer && (
        <div
          className="pointer-events-none fixed z-90 select-none rounded-xl border border-indigo-300 bg-white/95 px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-lg"
          style={{ left: dragPointer.x + 14, top: dragPointer.y + 14 }}
        >
          {byId.get(dragModuleId)?.name ?? dragModuleId}
          {dropTarget !== undefined && (
            <span className="ml-2 text-[11px] text-indigo-600">
              →{' '}
              {dropTarget.categoryId === null
                ? '未分类'
                : (categories.find((c) => c.id === dropTarget.categoryId)?.name ??
                  dropTarget.categoryId)}
              {` 第 ${dropTarget.index + 1} 位`}
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
};

export default Dashboard;
