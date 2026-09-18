// src/components/GlobalContextMenu.tsx
//
// 应用外壳的全局右键菜单。
//
// 与 `Sidebar/ModuleContextMenu` 的分工：那个是**某个模块**的专属菜单（收藏、置顶、
// 隐藏…），只在侧边栏的条目上弹出；这个是**外壳**的菜单，在界面的任意空白处右键
// 都会出现，承载那些「不属于任何模块」的动作 —— 前进后退、刷新、开关设置，以及
// 隐藏二级标题栏。
//
// 两者不会打架：模块自己的处理器会先调用 `preventDefault()`，冒泡到外壳时
// `event.defaultPrevented` 为真，外壳菜单直接让位（见 Home 里的处理）。
// 这也是「加一个全局右键」不至于把各模块既有右键挤掉的关键。

import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type GlobalMenuEntry =
  | { type: 'divider' }
  | {
      label: string;
      icon?: React.ComponentType<{ className?: string }>;
      /** 右侧显示的快捷键提示，纯展示 */
      shortcut?: string;
      /** 勾选态（例如「显示二级标题栏」） */
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      action: () => void;
    };

interface GlobalContextMenuProps {
  x: number;
  y: number;
  entries: GlobalMenuEntry[];
  onClose: () => void;
}

const MARGIN = 8;

const GlobalContextMenu: React.FC<GlobalContextMenuProps> = ({
  x,
  y,
  entries,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 贴边钳制：在右下角右键时，菜单不该跑到窗口外
  useEffect(() => {
    const node = menuRef.current;
    if (!node) return;

    const rect = node.getBoundingClientRect();
    let nextX = x;
    let nextY = y;
    if (nextX + rect.width + MARGIN > window.innerWidth) {
      nextX = window.innerWidth - rect.width - MARGIN;
    }
    if (nextY + rect.height + MARGIN > window.innerHeight) {
      nextY = window.innerHeight - rect.height - MARGIN;
    }
    setPos({ x: Math.max(MARGIN, nextX), y: Math.max(MARGIN, nextY) });
  }, [x, y]);

  useEffect(() => {
    const handleDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    // 捕获阶段监听：任何其它处理之前就关掉，避免「菜单还开着但下面的界面已经响应了」
    document.addEventListener('mousedown', handleDown, true);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', handleDown, true);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <AnimatePresence>
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.1 }}
        className="fixed z-50 min-w-52 bg-white/95 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-200/50 py-1.5 overflow-hidden"
        style={{ left: pos.x, top: pos.y }}
        // 在外壳菜单上再右键不应叠加出第二个菜单
        onContextMenu={(event) => event.preventDefault()}
      >
        {entries.map((entry, index) => {
          if ('type' in entry && entry.type === 'divider') {
            return <div key={`divider-${index}`} className="my-1 border-t border-gray-100" />;
          }

          const item = entry as Exclude<GlobalMenuEntry, { type: 'divider' }>;
          const Icon = item.icon;

          return (
            <button
              key={`${item.label}-${index}`}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.action();
              }}
              className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left transition-colors ${
                item.disabled
                  ? 'text-gray-300 cursor-default'
                  : item.danger
                    ? 'text-red-600 hover:bg-red-50'
                    : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {/* 图标槽位固定宽度：没有图标的条目也不会让文字错位 */}
              <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                {Icon ? <Icon className="w-4 h-4" /> : null}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut ? (
                <span className="shrink-0 text-[11px] text-gray-400">{item.shortcut}</span>
              ) : null}
              {item.checked ? (
                <span className="shrink-0 text-[11px] text-indigo-600">✓</span>
              ) : null}
            </button>
          );
        })}
      </motion.div>
    </AnimatePresence>
  );
};

export default GlobalContextMenu;
