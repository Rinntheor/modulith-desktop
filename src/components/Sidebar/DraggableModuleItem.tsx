// src/components/Sidebar/DraggableModuleItem.tsx
import React, { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import SidebarItem from './SidebarItem';
import SidebarSubItem from './SidebarSubItem';
import { motion, AnimatePresence } from 'framer-motion';
import { useSidebar } from '@/contexts/SidebarContext';
import type { ModuleDescriptor, SubModuleDescriptor } from '../../../src/types/module';
import { subMenuVariants, subItemVariants } from './animations';

interface DraggableModuleItemProps {
  module: ModuleDescriptor;
  isDragging: boolean;
}

const SubModuleList = memo(({ 
  module, 
  isExpanded 
}: { 
  module: ModuleDescriptor; 
  isExpanded: boolean;
}) => {
  if (!module.children || !isExpanded) return null;

  return (
    <AnimatePresence>
      <motion.div
        variants={subMenuVariants}
        initial="hidden"
        animate="visible"
        exit="hidden"
        className="w-full overflow-hidden"
      >
        {module.children.map((subModule: SubModuleDescriptor, subIndex: number) => (
          <motion.div
            key={subModule.id}
            variants={subItemVariants}
            custom={subIndex}
          >
            <SidebarSubItem subModule={subModule} />
          </motion.div>
        ))}
      </motion.div>
    </AnimatePresence>
  );
});

SubModuleList.displayName = 'SubModuleList';

const DraggableModuleItem: React.FC<DraggableModuleItemProps> = memo(({ module }) => {
  const { activeModule, expandedModules } = useSidebar();
  
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: module.id,
    disabled: module.disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const isExpanded = isDragging 
    ? false  // 拖拽中强制收起
    : expandedModules.has(module.id) || 
      (!!module.children && (activeModule?.startsWith(`${module.id}/`) ?? false));

  return (
    <div className="relative">
      {/* 
        transform 只作用于 SidebarItem 的包裹层，
        子模块列表在外层，不受拖拽影响
      */}
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className="relative cursor-default"
      >
        <SidebarItem module={module} />
      </div>

      {/* 子模块列表在 setNodeRef 外部 */}
      <SubModuleList module={module} isExpanded={isExpanded} />
    </div>
  );
});

DraggableModuleItem.displayName = 'DraggableModuleItem';

export default DraggableModuleItem;