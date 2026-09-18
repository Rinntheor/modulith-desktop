// src/components/Tabs/TabBar.tsx
//
// 模块标签页栏。
//
// 它解决的是一笔具体的账：在多个功能之间切换时，真正的成本不是「点一下侧边栏」，
// 而是**重建现场** —— 切走再切回，滚动位置、未提交的表单、正在编辑的草稿全没了，
// 于是得重新回忆「我刚才做到哪了」。标签页保活（见 tabStore）消除了这笔成本，
// 标签栏则是它的可见入口。
//
// 几个刻意决定：
//   * **不做「新标签页」按钮**。这里没有空白页概念，新标签只能来自一个具体模块，
//     因此入口在侧边栏与命令面板，放一个 + 号会让人以为点了能开空白页。
//   * **关闭按钮只在悬停或激活时出现**，避免一排 × 把标题挤没。
//   * **中键关闭**，与浏览器一致。
//   * 达到标签上限时由 tabStore 拒绝并提示，这里不重复处理。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Circle, ChevronsRight, Trash2, PanelLeft } from 'lucide-react';
import ModuleIcon from '../ModuleIcon';
import { useSidebar } from '../../contexts/SidebarContext';
import { useCatalog } from '../../hooks/useCatalog';
import { useTabs } from '../../hooks/useTabs';
import {
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsToTheRight,
  moveTab,
  openTab,
} from '../../services/tabStore';
import { useUnreadCount } from '../../hooks/useUnreadCount';

/** 单个标签的宽度上限；超出用省略号，保证一排能放下多个 */
const TAB_MAX_WIDTH = 200;

interface TabContextMenuState {
  moduleId: string;
  x: number;
  y: number;
}

const TabItem: React.FC<{
  moduleId: string;
  index: number;
  isActive: boolean;
  onContextMenu: (moduleId: string, event: React.MouseEvent) => void;
  onDragStart: (index: number) => void;
  onDragOver: (index: number, event: React.DragEvent) => void;
  onDrop: (index: number) => void;
  isDropTarget: boolean;
}> = ({
  moduleId,
  index,
  isActive,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  isDropTarget,
}) => {
  const catalog = useCatalog();
  const descriptor = catalog.get(moduleId);
  const unread = useUnreadCount(moduleId);

  const label = descriptor?.name ?? moduleId;

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

  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      draggable
      onDragStart={() => onDragStart(index)}
      onDragOver={(event) => onDragOver(index, event)}
      onDrop={() => onDrop(index)}
      onMouseDown={handleMouseDown}
      onClick={() => openTab(moduleId)}
      onContextMenu={(event) => onContextMenu(moduleId, event)}
      title={descriptor ? `${label} — ${moduleId}` : moduleId}
      style={{ maxWidth: TAB_MAX_WIDTH }}
      className={`group relative flex h-full shrink-0 cursor-pointer select-none items-center gap-2 border-r border-gray-200/70 px-3 text-xs transition-colors ${
        isActive
          ? 'bg-white text-gray-900'
          : 'bg-gray-50/60 text-gray-600 hover:bg-gray-100'
      } ${isDropTarget ? 'ring-1 ring-inset ring-indigo-400' : ''}`}
    >
      {/* 激活标签的强调条：用底部内阴影而不是 border，避免高度抖动 */}
      {isActive && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-indigo-500" />
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
          isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100'
        }`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
};

const TabBar: React.FC = () => {
  const { openTabs, activeTab } = useTabs();
  // 左侧留白与内容区同步：标签栏属于内容区的一部分（在侧边栏右侧），
  // 而不是横跨整个窗口的浏览器式标签栏。
  // `toggleSidebar` 用于折叠状态下标签栏左端的「展开」按钮。
  const { isOpen, toggleSidebar } = useSidebar();
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragFromRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [menu, setMenu] = useState<TabContextMenuState | null>(null);

  // 激活的标签滚动到可见区域：否则用快捷键切到屏幕外的标签时，用户看不到高亮变化
  useEffect(() => {
    if (!activeTab || !scrollRef.current) return;
    const container = scrollRef.current;
    const target = container.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTab)}"]`);
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab, openTabs.length]);

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

  const handleDrop = useCallback((toIndex: number) => {
    const from = dragFromRef.current;
    dragFromRef.current = null;
    setDropTarget(null);
    if (from === null) return;
    moveTab(from, toIndex);
  }, []);

  const menuIndex = useMemo(
    () => (menu ? openTabs.indexOf(menu.moduleId) : -1),
    [menu, openTabs]
  );

  /** 菜单项的动作表 */
  const menuActions = useMemo(() => {
    if (!menu) return [];
    const id = menu.moduleId;

    return [
      {
        key: 'close',
        label: '关闭',
        icon: X,
        run: () => closeTab(id),
      },
      {
        key: 'others',
        label: '关闭其他标签',
        icon: Circle,
        disabled: openTabs.length <= 1,
        run: () => closeOtherTabs(id),
      },
      {
        key: 'right',
        label: '关闭右侧标签',
        icon: ChevronsRight,
        disabled: menuIndex < 0 || menuIndex >= openTabs.length - 1,
        run: () => closeTabsToTheRight(id),
      },
      {
        key: 'all',
        label: '关闭全部标签',
        icon: Trash2,
        run: () => closeAllTabs(),
      },
    ];
  }, [menu, openTabs.length, menuIndex]);

  return (
    <div
      className={`fixed left-0 right-0 top-10 z-40 flex h-9 items-stretch border-b border-gray-200/70 bg-white/85 backdrop-blur-xl transition-[margin] duration-200 ${
        isOpen ? 'ml-64' : 'ml-0'
      }`}
      role="tablist"
      aria-label="模块标签页"
    >
      {/*
        侧边栏折叠后的「展开」按钮：**并入标签栏左端**，而不是浮在它上面。

        原设计是 `fixed left-4 top-14 z-50` —— top-14 = 56px，而标签栏占据
        40~76px，按钮（约 36px 高）横跨 56~92px，既压住标签栏左端、又探进内容区，
        且 z-50 高于标签栏的 z-40，于是直接盖住了第一个标签。

        这里改成标签栏内的一个固定槽位：
          · 与标签栏同层同高，不再遮挡任何标签 —— 标签从它右侧开始排；
          · 不引入常驻的窄侧边栏，因此不影响模块的全屏与沉浸式体验
            （常驻窄条会永久吃掉内容区宽度，这正是要避免的代价）；
          · 只在折叠状态出现。侧边栏展开时，折叠入口在侧边栏头部
            （Sidebar.tsx 里的 PanelLeftClose 按钮），两处不会同时出现。
      */}
      {!isOpen && (
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
        className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
      >
        {openTabs.map((moduleId, index) => (
          <div key={moduleId} data-tab-id={moduleId} className="flex items-stretch">
            <TabItem
              moduleId={moduleId}
              index={index}
              isActive={moduleId === activeTab}
              onContextMenu={handleContextMenu}
              onDragStart={(from) => {
                dragFromRef.current = from;
              }}
              onDragOver={(target, event) => {
                event.preventDefault();
                setDropTarget(target);
              }}
              onDrop={handleDrop}
              isDropTarget={dropTarget === index && dragFromRef.current !== index}
            />
          </div>
        ))}
      </div>

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
