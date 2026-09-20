// src/components/Tabs/TabBar.tsx
//
// 模块标签页栏。**按组渲染**：未分屏时只有 primary 一条，分屏后 primary 与 split
// 各一条，各自管理自己那组的标签。
//
// 它解决的是一笔具体的账：在多个功能之间切换时，真正的成本不是「点一下侧边栏」，
// 而是**重建现场** —— 切走再切回，滚动位置、未提交的表单、正在编辑的草稿全没了，
// 于是得重新回忆「我刚才做到哪了」。标签页保活（见 tabStore）消除了这笔成本，
// 标签栏则是它的可见入口。
//
// 分屏之后，右边那半**必须有自己的标签栏**：否则它只是一个钉死的预览 ——
// 用户既不能在右边切标签，也不能关掉它，那不像分屏，像一个装饰。
//
// **拖拽是用指针事件自己实现的，不是 HTML5 拖放。** Tauri 的 `dragDropEnabled`
// 默认 `true` 会拦截系统拖放，此时 WebView 内的 `dragstart` / `dragover` / `drop`
// 整体不可用 —— 表现为"一按就出现禁止光标、什么都拖不动"。见 `services/tabDrag.ts`
// 的说明，以及已知问题 §7.16。
//
// 几个刻意决定：
//   * **不做「新标签页」按钮**。这里没有空白页概念，新标签只能来自一个具体模块，
//     因此入口在侧边栏与命令面板，放一个 + 号会让人以为点了能开空白页。
//   * **关闭按钮只在悬停或激活时出现**，避免一排 × 把标题挤没。
//   * **中键关闭**，与浏览器一致。
//   * 达到标签上限时由 tabStore 拒绝并提示，这里不重复处理。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Circle,
  ChevronsRight,
  Columns2,
  Trash2,
  PanelLeft,
  PanelRightClose,
} from 'lucide-react';
import ModuleIcon from '../ModuleIcon';
import { useSidebar } from '../../contexts/SidebarContext';
import { useCatalog } from '../../hooks/useCatalog';
import { useTabs } from '../../hooks/useTabs';
import {
  activateInGroup,
  closeAllTabs,
  closeOtherTabs,
  closeSplit,
  closeTab,
  closeTabsToTheRight,
  moveTabToGroup,
  type TabGroupId,
} from '../../services/tabStore';
import {
  getDraggingTab,
  getDropTarget,
  setDragPointer,
  setDraggingTab,
  setDropTargetTarget,
  subscribeTabDrag,
} from '../../services/tabDrag';
import { useUnreadCount } from '../../hooks/useUnreadCount';

/** 单个标签的宽度上限；超出用省略号，保证一排能放下多个 */
const TAB_MAX_WIDTH = 200;

/**
 * 指针移动超过这个距离才算"在拖拽"。
 *
 * 没有它的话，手一抖就会把点击变成拖拽 —— 标签会跳到别的位置而不是被激活。
 */
const DRAG_THRESHOLD_PX = 5;

interface TabContextMenuState {
  moduleId: string;
  x: number;
  y: number;
}

const TabItem: React.FC<{
  group: TabGroupId;
  moduleId: string;
  index: number;
  isActive: boolean;
  /** 所在组是否有焦点（决定激活指示条的深浅，见 TabBarProps.focused） */
  focused: boolean;
  isDropTarget: boolean;
  onContextMenu: (moduleId: string, event: React.MouseEvent) => void;
}> = ({ group, moduleId, index, isActive, focused, isDropTarget, onContextMenu }) => {
  const catalog = useCatalog();
  const descriptor = catalog.get(moduleId);
  const unread = useUnreadCount(moduleId);

  const label = descriptor?.name ?? moduleId;

  /** 本次指针交互是否已经变成拖拽（用来吞掉随后的 click） */
  const draggedRef = useRef(false);

  // 中键关闭，与浏览器一致
  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(moduleId);
      }
    },
    [moduleId]
  );

  const handleClose = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      closeTab(moduleId);
    },
    [moduleId]
  );

  /**
   * 拖拽的起点。
   *
   * 监听挂在 `window` 上而不是元素上：指针很快会离开这个 36px 高的标签，
   * 挂在元素上会在移出的那一刻丢掉后续事件，拖拽等于走到一半就断了。
   * 这里**不做指针捕获** —— 捕获之后所有指针事件都只发给这个元素，
   * 而落点判定依赖"指针进入别的元素"（各落点用 `onPointerEnter` 上报），
   * 捕获会把那条链路切断。
   */
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // 关闭按钮上的按下不启动拖拽，它有自己的点击语义
      if ((event.target as HTMLElement).closest('button')) return;

      const startX = event.clientX;
      const startY = event.clientY;
      draggedRef.current = false;

      const onMove = (moveEvent: PointerEvent) => {
        if (!draggedRef.current) {
          const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
          if (moved < DRAG_THRESHOLD_PX) return;
          draggedRef.current = true;
          setDraggingTab(moduleId);
        }
        setDragPointer({ x: moveEvent.clientX, y: moveEvent.clientY });
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
      };

      window.addEventListener('pointermove', onMove);
      // 落点的**提交**由 Home 的全局 pointerup 负责（那里同时知道内容区的两半），
      // 这里只负责停止跟踪
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
    },
    [moduleId]
  );

  const handleClick = useCallback(() => {
    // 刚拖过就不要当成点击 —— 否则"拖完"会顺手切换一次激活标签
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    activateInGroup(group, moduleId);
  }, [group, moduleId]);

  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onPointerDown={handlePointerDown}
      // 拖拽经过本标签 → 落点为"插到它前面"。用 pointerenter 而不是判断坐标：
      // 指针事件在拖拽期间照常派发（这正是自己实现拖拽的好处）。
      onPointerEnter={() => {
        if (!getDraggingTab()) return;
        setDropTargetTarget({ kind: 'group', group, index });
      }}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onContextMenu={(event) => onContextMenu(moduleId, event)}
      title={descriptor ? `${label} — ${moduleId}` : moduleId}
      style={{ maxWidth: TAB_MAX_WIDTH }}
      className={`group relative flex h-full shrink-0 cursor-pointer select-none items-center gap-2 border-r border-gray-200/70 px-3 text-xs transition-colors ${
        isActive
          ? 'bg-white text-gray-900'
          : 'bg-gray-50/60 text-gray-600 hover:bg-gray-100'
      } ${isDropTarget ? 'ring-1 ring-inset ring-indigo-400' : ''}`}
    >
      {/* 激活标签的强调条：用底部内阴影而不是 border，避免高度抖动。
          没有焦点的那一组调浅一档 —— 两组各有一个高亮标签时，这是唯一能看出
          "键盘与新建标签会落在哪一半"的线索。 */}
      {isActive && (
        <span
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-0.5 ${
            focused ? 'bg-indigo-500' : 'bg-indigo-300'
          }`}
        />
      )}

      <ModuleIcon
        icon={descriptor?.icon}
        iconSvg={descriptor?.iconSvg}
        name={label}
        className="h-3.5 w-3.5 shrink-0"
      />

      <span className="min-w-0 flex-1 truncate">{label}</span>

      {/* 未读徽标：模块自己产生的通知数，点击标签即代表去看它 */}
      {unread > 0 && (
        <span
          className="shrink-0 rounded-full bg-indigo-500 px-1.5 text-[10px] font-medium leading-4 text-white"
          title={`${unread} 条未读通知`}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}

      <button
        type="button"
        onClick={handleClose}
        aria-label={`关闭 ${label}`}
        title="关闭标签页（中键同样可关闭）"
        className={`shrink-0 rounded p-0.5 transition-opacity hover:bg-gray-200 ${
          isActive
            ? 'opacity-60 hover:opacity-100'
            : 'opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100'
        }`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
};

interface TabBarProps {
  group: TabGroupId;
  /**
   * 是否是当前有焦点的那个组。
   *
   * 用来把**没有焦点**那一组的激活指示条调浅一档：分屏之后两组各有一个高亮标签，
   * 如果它们一模一样，用户无法判断新开的模块、`Ctrl+W`、`Ctrl+Tab` 会落在哪一半。
   */
  focused?: boolean;
}

const TabBar: React.FC<TabBarProps> = ({ group, focused = true }) => {
  const { openTabs, activeTab, splitTabs, splitActive } = useTabs();
  const tabs = group === 'primary' ? openTabs : splitTabs;
  const active = group === 'primary' ? activeTab : splitActive;

  const { isOpen, toggleSidebar } = useSidebar();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabContextMenuState | null>(null);

  // 订阅拖拽状态以渲染落点指示（自己订阅，避免把整棵树的拖拽状态提到 Home）
  const [dropTarget, setLocalDropTarget] = useState(() => getDropTarget());
  useEffect(() => subscribeTabDrag(() => setLocalDropTarget(getDropTarget())), []);

  // 激活的标签滚动到可见区域：否则用快捷键切到屏幕外的标签时，用户看不到高亮变化
  useEffect(() => {
    if (!active || !scrollRef.current) return;
    const container = scrollRef.current;
    const target = container.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`);
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  // 关闭右键菜单：点击别处或按 Esc
  useEffect(() => {
    if (!menu) return;

    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };

    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  // 纵向滚轮转成横向滚动：标签栏没有纵向滚动条，用默认行为会完全没反应
  const handleWheel = useCallback((event: React.WheelEvent) => {
    const container = scrollRef.current;
    if (!container) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    container.scrollLeft += event.deltaY;
  }, []);

  const handleContextMenu = useCallback((moduleId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ moduleId, x: event.clientX, y: event.clientY });
  }, []);

  /** 拖拽经过标签栏的空白处 → 追加到本组末尾 */
  const handleBarPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!getDraggingTab()) return;
      if ((event.target as HTMLElement).closest('[role="tab"]')) return;
      setDropTargetTarget({ kind: 'group', group, index: null });
    },
    [group]
  );

  const menuIndex = useMemo(
    () => (menu ? tabs.indexOf(menu.moduleId) : -1),
    [menu, tabs]
  );

  /** 菜单项的动作表 */
  const menuActions = useMemo(() => {
    if (!menu) return [];
    const id = menu.moduleId;

    return [
      { key: 'close', label: '关闭', icon: X, run: () => closeTab(id) },
      {
        key: 'others',
        label: '关闭其他标签',
        icon: Circle,
        disabled: tabs.length <= 1,
        run: () => closeOtherTabs(id),
      },
      {
        key: 'right',
        label: '关闭右侧标签',
        icon: ChevronsRight,
        disabled: menuIndex < 0 || menuIndex >= tabs.length - 1,
        run: () => closeTabsToTheRight(id),
      },
      {
        key: 'move',
        // 两组之间的搬运入口。拖拽也能做同样的事，但不是所有人都会想到去拖。
        label: group === 'primary' ? '在右侧分屏打开' : '移回左侧',
        icon: group === 'primary' ? Columns2 : PanelLeft,
        run: () => moveTabToGroup(id, group === 'primary' ? 'split' : 'primary'),
      },
      { key: 'all', label: '关闭全部标签', icon: Trash2, run: () => closeAllTabs() },
    ];
  }, [menu, tabs, menuIndex, group]);

  // 「展开侧边栏」按钮只属于最左边那一条标签栏
  const showExpandButton = group === 'primary' && !isOpen;

  const appendHighlighted =
    dropTarget?.kind === 'group' && dropTarget.group === group && dropTarget.index === null;

  return (
    <div
      // `pointer-events-auto`：外层标签栏行是 pointer-events-none（它是纯布局壳，
      // 全宽盒子会挡住侧边栏头部 —— 见 Home.tsx 的说明）。这里把它显式恢复，
      // 标签本身、滚轮横向滚动与拖拽落点判定都需要指针事件。
      className="pointer-events-auto lc-chrome relative flex h-9 min-w-0 flex-1 items-stretch overflow-hidden border-b border-gray-200/70 bg-white/95"
      role="tablist"
      aria-label={group === 'primary' ? '模块标签页' : '分屏标签页'}
      onPointerMove={handleBarPointerMove}
    >
      {showExpandButton && (
        <div className="flex shrink-0 items-center border-r border-gray-200/70 pl-2 pr-1">
          <button
            type="button"
            onClick={toggleSidebar}
            className="rounded-md p-1.5 text-gray-600 transition-colors duration-150 hover:bg-gray-200/70"
            aria-label="展开侧边栏"
            title="展开侧边栏"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        onWheel={handleWheel}
        className={`no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden ${
          appendHighlighted ? 'ring-1 ring-inset ring-indigo-400' : ''
        }`}
      >
        {tabs.map((moduleId, index) => (
          <div key={moduleId} data-tab-id={moduleId} className="flex items-stretch">
            <TabItem
              group={group}
              moduleId={moduleId}
              index={index}
              isActive={moduleId === active}
              focused={focused}
              isDropTarget={
                dropTarget?.kind === 'group' &&
                dropTarget.group === group &&
                dropTarget.index === index
              }
              onContextMenu={handleContextMenu}
            />
          </div>
        ))}
      </div>

      {/* 分屏组自己的「关闭分屏」入口。放在这一条标签栏的右端，而不是全局某处 ——
          它关掉的是**这一半**，放在这一半上最直观。 */}
      {group === 'split' && (
        <button
          type="button"
          onClick={closeSplit}
          title="关闭分屏（标签会并回左侧，不会丢失）"
          aria-label="关闭分屏"
          className="flex shrink-0 items-center gap-1 border-l border-gray-200/70 px-2.5 text-[11px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
          关闭分屏
        </button>
      )}

      {menu && (
        <div
          className="fixed z-[60] min-w-[168px] overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          // 菜单自身也要挡住外层的关闭处理
          onMouseDown={(event) => event.stopPropagation()}
        >
          {menuActions.map((action) => (
            <button
              key={action.key}
              type="button"
              disabled={action.disabled}
              onClick={() => {
                action.run();
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <action.icon className="h-3.5 w-3.5 text-gray-500" />
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default TabBar;
