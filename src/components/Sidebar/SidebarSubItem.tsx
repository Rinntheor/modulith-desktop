// src/components/Sidebar/SidebarSubItem.tsx
import React, { memo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useSidebar } from '@/contexts/SidebarContext';
import ModuleIcon from '../ModuleIcon';
import type { SubModuleDescriptor } from '../../types/module';
import { invoke } from '@tauri-apps/api/core';

interface SidebarSubItemProps {
  subModule: SubModuleDescriptor;
}

const SidebarSubItem: React.FC<SidebarSubItemProps> = memo(({ subModule }) => {
  const { activeModule, setActiveModule } = useSidebar();

  // subModule.id 已经是 "finance/dashboard" 这样的完整 ID
  const isActive = activeModule === subModule.id;
  
  const handleClick = useCallback(() => {
    if (!subModule.disabled) {
      setActiveModule(subModule.id);
      invoke('record_module_open', { moduleId: subModule.id }).catch(console.warn);
    }
  }, [subModule.disabled, subModule.id, setActiveModule]);

  return (
    <motion.button
      onClick={handleClick}
      disabled={subModule.disabled}
      className={`relative w-full flex items-center px-3 py-2 rounded-lg text-sm transition-all duration-200 ${
        isActive
          ? 'bg-indigo-50 text-indigo-600 font-medium'
          : subModule.disabled
          ? 'opacity-50 cursor-not-allowed text-gray-400'
          : 'hover:bg-gray-100 text-gray-500 hover:text-gray-900 cursor-pointer'
      }`}
      style={{ paddingLeft: '2.5rem' }}
      whileHover={!subModule.disabled ? { x: 4 } : {}}
      whileTap={!subModule.disabled ? { scale: 0.98 } : {}}
    >
      <div className="flex items-center flex-1 min-w-0 overflow-hidden">
        {subModule.icon && (
          <ModuleIcon
            icon={subModule.icon}
            iconSvg={subModule.iconSvg}
            name={subModule.name}
            className={`w-4 h-4 mr-2 shrink-0 ${isActive ? 'text-indigo-500' : ''}`}
          />
        )}
        <span className="flex-1 text-left truncate">
          {subModule.name}
        </span>
        {subModule.badge && (
          <span className={`ml-2 px-1.5 py-0.5 text-xs rounded-full whitespace-nowrap shrink-0 font-medium ${
            isActive 
              ? 'bg-indigo-100 text-indigo-600' 
              : 'bg-gray-200 text-gray-600'
          }`}>
            {subModule.badge}
          </span>
        )}
      </div>
      
      {/* 子模块活跃指示器 - 左侧竖条 */}
      {isActive && (
        <motion.div
          layoutId={`subIndicator-${subModule.id.split('/')[0]}`}
          className="absolute left-2 top-1/2 -translate-y-1/2 w-1 h-5 bg-indigo-500 rounded-full"
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

SidebarSubItem.displayName = 'SidebarSubItem';

export default SidebarSubItem;