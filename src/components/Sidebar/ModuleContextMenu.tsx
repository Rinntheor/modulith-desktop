// src/components/Sidebar/ModuleContextMenu.tsx

import React, { useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  EyeOff,
  Pin,
  PinOff,
  ArrowUp,
  ArrowDown,
  Star,
  StarOff,
//   Eye,
} from 'lucide-react';
import type { ModuleDescriptor } from '../../types/module';
import { moduleManager } from '../../services/moduleManager';

interface ContextMenuState {
  x: number;
  y: number;
  module: ModuleDescriptor;
}

interface ModuleContextMenuProps {
  menuState: ContextMenuState | null;
  onClose: () => void;
  onAction: () => void; // 操作后刷新列表
}

const ModuleContextMenu: React.FC<ModuleContextMenuProps> = ({
  menuState,
  onClose,
  onAction,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    if (menuState) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [menuState, onClose]);

  // ESC 关闭
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (menuState) {
      document.addEventListener('keydown', handleEsc);
      return () => document.removeEventListener('keydown', handleEsc);
    }
  }, [menuState, onClose]);

  const handleAction = useCallback(async (action: () => Promise<void>) => {
    await action();
    onAction();
    onClose();
  }, [onAction, onClose]);

  if (!menuState) return null;

  const { x, y, module } = menuState;
  const isPinned = moduleManager.getPinnedModules?.()?.includes(module.id) ?? false;
  const isFavorite = moduleManager.getFavoriteIds?.()?.includes(module.id) ?? false;
//   const isHidden = false;

  const menuItems = [
    {
      label: isFavorite ? '取消收藏' : '收藏',
      icon: isFavorite ? StarOff : Star,
      action: () => moduleManager.toggleFavoriteModule(module.id),
    },
    {
      label: isPinned ? '取消置顶' : '置顶',
      icon: isPinned ? PinOff : Pin,
      action: () => moduleManager.togglePinModule(module.id),
    },
    {
      label: '上移',
      icon: ArrowUp,
      action: () => moduleManager.moveModule(module.id, 'up'),
    },
    {
      label: '下移',
      icon: ArrowDown,
      action: () => moduleManager.moveModule(module.id, 'down'),
    },
    { type: 'divider' as const },
    {
      label: '隐藏',
      icon: EyeOff,
      action: () => moduleManager.hideModule(module.id),
      danger: true,
    },
  ];

  return (
    <AnimatePresence>
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.1 }}
        className="fixed z-50 min-w-45 bg-white/95 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-200/50 py-1.5 overflow-hidden"
        style={{ left: x, top: y }}
      >
        {menuItems.map((item, index) => {
          if ('type' in item && item.type === 'divider') {
            return <div key={index} className="my-1 border-t border-gray-100" />;
          }

          const menuItem = item as {
            label: string;
            icon: React.ComponentType<any>;
            action: () => Promise<void>;
            danger?: boolean;
          };

          return (
            <button
              key={menuItem.label}
              onClick={() => handleAction(menuItem.action)}
              className={`w-full flex items-center space-x-3 px-3.5 py-2 text-sm transition-colors ${
                menuItem.danger
                  ? 'text-red-600 hover:bg-red-50'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <menuItem.icon className="w-4 h-4 shrink-0" />
              <span>{menuItem.label}</span>
            </button>
          );
        })}
      </motion.div>
    </AnimatePresence>
  );
};

export default ModuleContextMenu;
export type { ContextMenuState };