// src/components/Sidebar/Sidebar.tsx
import React, { useEffect, useRef, memo, useState, useCallback } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { PanelLeftClose } from 'lucide-react';
import { useSidebar } from '@/contexts/SidebarContext';
import DraggableModuleItem from './DraggableModuleItem';
import { useModuleList } from '../../hooks/useModuleList';
import { sidebarVariants, itemVariants } from './animations';
import ModuleContextMenu, { type ContextMenuState } from './ModuleContextMenu';
import HiddenModulesPanel from './HiddenModulesPanel';
import ThemeToggle from './ThemeToggle';
import AppLogo from '../icons/AppLogo';
import { moduleManager } from '../../services/moduleManager';
import { getHostVersion } from '../../services/pluginRuntime';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { ModuleDescriptor } from '../../types/module';

const Sidebar: React.FC<{
  /**
   * 沉浸模式（全屏）。
   *
   * 侧边栏的定位里写死了 `top-10`（标题栏高度 40px）。全屏时标题栏被隐藏、内容区
   * 上沿归零，如果这里不跟着变，侧边栏就会在顶部留出一条 40px 的空隙、同时底部
   * 溢出 40px —— 也就是「全屏后侧边栏错位」。
   *
   * 选择**贴合而不是隐藏**：全屏时仍然可以导航，而且不改变用户的展开/折叠状态
   * （退出全屏后与进入前一致）。想更沉浸可以按 Ctrl+B 自己收起来。
   */
  immersive?: boolean;
}> = ({ immersive = false }) => {
  const { isOpen, isCollapsed, toggleSidebar, activeModule } = useSidebar();
  const navRef = useRef<HTMLElement>(null);
  const activeItemRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showHiddenPanel, setShowHiddenPanel] = useState(false);
  const [isDragging, setIsDragging] = useState(false);  // 拖拽状态


  const { modules, hiddenModules, refresh } = useModuleList();

  // 拖拽传感器：使用指针传感器，长按或拖动触发
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 300, // 长按 300ms 后触发拖拽
        tolerance: 5, // 移动 5px 才触发拖拽，避免误触
      },
    })
  );

  // 拖拽结束处理
  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = modules.findIndex((m) => m.id === active.id);
      const newIndex = modules.findIndex((m) => m.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        // 调用 moveModule 更新排序
        // const targetModule = modules[newIndex];
        await moduleManager.moveModuleToIndex(
          active.id as string,
          newIndex
        );
        refresh();
      }
    }
  }, [modules, refresh]);

  // 自动滚动到活跃项
  useEffect(() => {
    if (activeModule && activeItemRef.current && navRef.current) {
      requestAnimationFrame(() => {
        const navRect = navRef.current?.getBoundingClientRect();
        const itemRect = activeItemRef.current?.getBoundingClientRect();
        
        if (navRect && itemRect) {
          const isAboveView = itemRect.top < navRect.top + 20;
          const isBelowView = itemRect.bottom > navRect.bottom - 20;
          
          if (isAboveView || isBelowView) {
            activeItemRef.current?.scrollIntoView({
              block: 'nearest',
              behavior: 'smooth',
            });
          }
        }
      });
    }
  }, [activeModule]);

  /*
   * 折叠状态下本组件不渲染任何东西。
   *
   * 这里原本有一个浮动的「展开」按钮（`fixed left-4 top-14 z-50`），
   * 它压住了二级标题栏（标签栏占据 40~76px，而 top-14 = 56px，
   * 按钮横跨 56~92px，z-50 又高于标签栏的 z-40，于是盖住了第一个标签）。
   *
   * 现在「展开」入口并入标签栏左端（见 Tabs/TabBar.tsx）：与标签栏同层同高，
   * 不遮挡标签，也不必引入常驻的窄侧边栏 —— 后者会永久吃掉内容区宽度，
   * 影响模块的全屏与沉浸式体验。
   *
   * 保留这个提前 return 是有意的：折叠时侧边栏确实不该参与布局，
   * 只是「展开入口」不再由它提供。
   */
  if (isCollapsed && !isOpen) {
    return null;
  }

  return (
    <AnimatePresence>
      {!isCollapsed && (
        <motion.aside
          variants={sidebarVariants}
          initial="hidden"
          animate="visible"
          exit="hidden"
          className={`fixed left-0 z-40 flex ${
            immersive ? 'top-0 h-full' : 'top-10 h-[calc(100%-2.5rem)]'
          }`}
        >
          <div className="h-full w-64 bg-white/90 backdrop-blur-xl border-r border-gray-200/50 shadow-2xl flex flex-col">
            {/* 侧边栏头部 */}
            <div className="shrink-0">
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: 0.1 }}
                className="flex items-center justify-between p-4 border-b border-gray-100"
              >
                <div className="flex items-center space-x-3">
                  {/*
                    裸标记，方块颜色跟随主题：
                    深色模式下 text-gray-900 会被全局映射翻成亮色，
                    浅色模式下就是深灰 —— 无需两套资源。
                  */}
                  <AppLogo className="w-7 h-7 shrink-0 text-gray-900" />
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2, delay: 0.15 }}
                    className="font-semibold text-gray-900"
                  >
                    Modulith
                  </motion.span>
                </div>
                <motion.button
                  whileHover={{ scale: 1.1, rotate: 180 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={toggleSidebar}
                  className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                  transition={{ duration: 0.2 }}
                >
                  <PanelLeftClose className="w-4 h-4 text-gray-500" />
                </motion.button>
              </motion.div>
            </div>

            {/* 导航菜单 - 使用 DndContext 包裹 */}
            <nav 
              ref={navRef}
              className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 space-y-1 custom-scrollbar"
            >
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={() => setIsDragging(true)}
                  onDragEnd={(event) => {
                    setIsDragging(false);
                    handleDragEnd(event);
                  }}
                  onDragCancel={() => setIsDragging(false)}
                >
                <SortableContext
                  items={modules.map(m => m.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <LayoutGroup>
                    {modules.map((module: ModuleDescriptor, index: number) => {
                      const isParentActive = activeModule === module.id || 
                        activeModule?.startsWith(`${module.id}/`);

                      return (
                        <motion.div
                          key={module.id}
                          ref={isParentActive ? activeItemRef : undefined}
                          variants={itemVariants}
                          custom={index}
                          layout="position"
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setContextMenu({ x: e.clientX, y: e.clientY, module });
                          }}
                        >
                          <DraggableModuleItem module={module} isDragging={isDragging} />
                        </motion.div>
                      );
                    })}
                  </LayoutGroup>
                </SortableContext>
              </DndContext>
            </nav>

            {/* 隐藏模块管理 */}
            {hiddenModules.length > 0 && (
              <div className="shrink-0 border-t border-gray-100">
                <button
                  onClick={() => setShowHiddenPanel(true)}
                  className="w-full px-4 py-2 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors flex items-center space-x-2"
                >
                  <span className="w-1.5 h-1.5 bg-gray-300 rounded-full" />
                  <span>
                    {hiddenModules.length} hidden module{hiddenModules.length > 1 ? 's' : ''}
                  </span>
                  <span className="ml-auto text-gray-300 text-[10px]">Click to manage</span>
                </button>
              </div>
            )}

            {/* 底部信息 */}
            <div className="shrink-0">
              {/*
                深/浅色快捷切换。
                放在版本信息**上方**：它需要在右下角可见，而版本行是纯展示、
                更低的信息层级。顺序上"可操作的东西"在"只读信息"之上。
              */}
              <div className="border-t border-gray-100 pt-1">
                <ThemeToggle />
              </div>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3, duration: 0.2 }}
                className="px-4 pb-4 pt-1"
              >
                <div className="flex items-center space-x-3">
                  <div className="flex-1">
                    {/* 侧边栏只有 256px 宽，用简称避免换行 */}
                    <p className="text-sm font-medium text-gray-900">Modulith</p>
                    <p className="text-xs text-gray-500">v{getHostVersion()}</p>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </motion.aside>
      )}

      {/* 右键菜单 */}
      <ModuleContextMenu
        menuState={contextMenu}
        onClose={() => setContextMenu(null)}
        onAction={refresh}
      />

      {/* 隐藏模块管理面板 */}
      {showHiddenPanel && (
        <HiddenModulesPanel
          hiddenModules={hiddenModules}
          onShowModule={async (moduleId) => {
            await moduleManager.showModule(moduleId);
            refresh();
          }}
          onClose={() => setShowHiddenPanel(false)}
        />
      )}
    </AnimatePresence>
  );
};

export default memo(Sidebar);