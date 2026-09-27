// src/components/Sidebar/SidebarItem.tsx
import React, { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { useSidebar } from '@/contexts/SidebarContext';
import ModuleIcon from '../ModuleIcon';
import { useUnreadCountFor } from '../../hooks/useUnreadCount';
import type { ModuleDescriptor } from '../../types/module';
import { invoke } from '@tauri-apps/api/core';

interface SidebarItemProps {
  module: ModuleDescriptor;
}

/**
 * 插件徽标的语气 → 一组类名。
 *
 * 与 `TabBar` 里那一份**刻意重复**：它只有四行，而抽成公共模块会把这个组件与
 * 标签栏绑在一起 —— 它们之间本来没有别的关系。真正需要保持一致的**是形状**
 * （圆角/字号/内边距），而那两处都写在各自的 className 里，`check:theme` 与
 * 逐条抄过来的类名已经让它们看起来一样了。
 *
 * 语气是 Rust 侧白名单过的；这里不认识的取值一律落到 `info`。
 */
function badgeToneClasses(tone: string | undefined): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-100 text-emerald-700';
    case 'warning':
      return 'bg-amber-100 text-amber-700';
    case 'error':
      return 'bg-rose-100 text-rose-700';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

const SidebarItem: React.FC<SidebarItemProps> = memo(({ module }) => {
  const { activeModule, setActiveModule, expandedModules, toggleExpandModule, ensureExpanded } = useSidebar();
  const hasChildren = module.children && module.children.length > 0;
  const hasRoute = !!module.component;

  // 该模块及其子模块的未读通知总数。把子模块算进来是必要的：
  // 否则「待办出现在 finance/overview 里」这种事在父项上毫无提示。
  const trackedIds = useMemo(
    () => [module.id, ...(module.children ?? []).map((child) => child.id)],
    [module.id, module.children]
  );
  const unread = useUnreadCountFor(trackedIds);

  const isActive = activeModule === module.id || 
    (hasChildren && (activeModule?.startsWith(`${module.id}/`) ?? false));

  const isExpanded = expandedModules.has(module.id) || 
    (hasChildren && (activeModule?.startsWith(`${module.id}/`) ?? false));

  const handleClick = () => {
    if (module.disabled) return;
    
    if (hasChildren) {
      if (!isExpanded) {
        // 未展开 → 展开并激活
        ensureExpanded(module.id);
        if (hasRoute) {
          setActiveModule(module.id);
        }
      } else if (activeModule === module.id) {
        // 已展开且主模块已激活 → 收起子项。
        //
        // 这里**不再**清空当前模块：加入标签页之后「收起子项」不该关掉标签 ——
        // 用户只是想收起列表，没说要离开这个模块。清空标签是关闭按钮的职责。
        toggleExpandModule(module.id);
      } else {
        // 已展开但主模块未激活 → 只激活，不收起
        setActiveModule(module.id);
      }
    } else if (hasRoute) {
      // 没有子模块，直接激活，并记录到最近使用
      setActiveModule(module.id);
      invoke('record_module_open', { moduleId: module.id }).catch(console.warn);
    }
  };

  // 点击箭头：只切换展开/收起
  const handleArrowClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      toggleExpandModule(module.id);
    }
  };

  const indicatorPosition = useMemo(() => {
    if (!isActive || hasChildren) return null;
    if (unread > 0) return 'right-[4.5rem]';
    if (module.badge) return 'right-16';
    if (hasChildren) return 'right-8';
    return 'right-2';
  }, [isActive, hasChildren, module.badge, unread]);

  const hasRightElement = !!module.badge || hasChildren || unread > 0;

  return (
    <motion.button
      onClick={handleClick}
      disabled={module.disabled}
      className={`relative w-full flex items-center px-3 py-2.5 rounded-xl transition-colors duration-200 group ${
        isActive
          ? 'bg-linear-to-r from-indigo-500/10 to-purple-500/10 text-indigo-600 shadow-sm'
          : 'hover:bg-gray-100 text-gray-600 hover:text-gray-900'
      } ${module.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      whileHover={!module.disabled ? { 
        scale: 1.02, 
        x: 4,
        transition: { duration: 0.15 }
      } : {}}
      whileTap={!module.disabled ? { 
        scale: 0.98,
        transition: { duration: 0.1 }
      } : {}}
      style={{
        transformOrigin: 'left center',
        willChange: 'transform',
      }}
    >
      <div className="relative flex items-center flex-1 min-w-0">
        <ModuleIcon
          icon={module.icon}
          iconSvg={module.iconSvg}
          name={module.name}
          className={`w-5 h-5 mr-3 transition-colors duration-200 shrink-0 ${
            isActive ? 'text-indigo-600' : 'text-gray-500 group-hover:text-gray-900'
          }`}
        />

        <span className="flex-1 text-left text-sm font-medium truncate">
          {module.name}
        </span>
        
        {(unread > 0 || module.badge || hasChildren) && (
          <div className="flex items-center space-x-2 ml-2 shrink-0">
            {/*
              未读通知徽标。用数字而不是圆点：「有 3 件事」与「有 1 件事」
              对「要不要现在去处理」的判断影响很大。
              上限 99+ 是为了不让三位数把模块名挤没。
            */}
            {unread > 0 && (
              <span
                className="rounded-full bg-indigo-500 px-1.5 text-[10px] font-semibold leading-4 text-white"
                title={`${unread} 条未读通知`}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}

            {module.badge && (
              <motion.span
                className={`px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${
                  isActive
                    ? 'bg-indigo-100 text-indigo-600'
                    : badgeToneClasses(module.badgeTone)
                }`}
                animate={{ scale: isActive ? 1.05 : 1 }}
                transition={{ duration: 0.2 }}
                title={`来自插件：${module.badge}`}
              >
                {module.badge}
              </motion.span>
            )}
            
            {hasChildren && (
              <motion.div
                animate={{ rotate: isExpanded ? 180 : 0 }}
                transition={{ duration: 0.2, ease: 'easeInOut' }}
                className="shrink-0 cursor-pointer"
                onClick={handleArrowClick}
              >
                <ChevronDown className="w-4 h-4" />
              </motion.div>
            )}
          </div>
        )}
      </div>
      
      {/* 插件进度（`ctx.ui.progress`）。铺在这一行的**底边**上 ——
          它说的是"这个模块正在忙"，而模块在侧边栏里就是这一行。

          `value === null` 是**不定量**：一条来回跑的短条。它与定量条的区别是
          "还要多久"这件事插件自己也不知道。 */}
      {module.progress && (
        <span
          className="pointer-events-none absolute inset-x-2 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-indigo-100"
          title={module.progress.label ?? '插件正在处理'}
        >
          <span
            className={`block h-full rounded-full bg-indigo-500 ${
              module.progress.value === null
                ? 'w-1/3 animate-pulse'
                : 'transition-[width] duration-200'
            }`}
            style={
              module.progress.value === null
                ? undefined
                : { width: `${Math.round(module.progress.value * 100)}%` }
            }
          />
        </span>
      )}

      {/* 活跃指示器小球 - 无子模块时 */}
      {isActive && !hasChildren && (
        <motion.div
          layoutId="activeIndicator"
          className={`absolute w-1.5 h-1.5 bg-indigo-600 rounded-full top-1/2 -translate-y-1/2 ${indicatorPosition}`}
          initial={false}
          transition={{
            type: "spring",
            stiffness: 500,
            damping: 35,
            mass: 0.5,
          }}  
        />
      )}
      
      {/* 活跃指示器小球 - 有子模块时 */}
      {isActive && hasChildren && (
        <motion.div
          layoutId="activeIndicator"
          className={`absolute w-1.5 h-1.5 bg-indigo-600 rounded-full top-1/2 -translate-y-1/2 ${
            hasRightElement ? 'right-8' : 'right-3'
          }`}
          initial={false}
          transition={{
            type: "spring",
            stiffness: 500,
            damping: 35,
            mass: 0.5,
          }}
        />
      )}
    </motion.button>
  );
});

SidebarItem.displayName = 'SidebarItem';

export default SidebarItem;
