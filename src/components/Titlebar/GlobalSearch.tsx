// src/components/Titlebar/GlobalSearch.tsx
//
// 标题栏正中的全局搜索框。
//
// 它要解决的问题是「入口太多」：功能一多，「我知道有这个功能，但它在哪个模块里」
// 会变成一种新的切换成本 —— 而且是那种最烦的、来回点的那种。搜索框把「打开模块」
// 与「执行动作」放在同一个入口里，用户不必先想起某个东西在哪。
//
// 数据来源见 services/commandRegistry.ts（模块条目从目录派生，动作条目由命令
// 注册表提供）。这里只负责交互：
//
//   空查询      → 最近使用 + 按名称排序的模块（一打开就有东西可点，而不是空白）
//   ↑ / ↓      → 移动高亮
//   Enter      → 执行高亮项
//   Esc        → 关闭并失焦
//   Ctrl+K     → 从任何位置聚焦（见 services/searchFocus.ts）
//
// 结果按组显示（模块 / 动作 / 设置），因为「同名的一个模块与一个动作」需要能分辨。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CornerDownLeft, Search } from 'lucide-react';
import ModuleIcon from '../ModuleIcon';
import { useCatalog } from '../../hooks/useCatalog';
import { runCommand, searchCommands, type Command, type CommandGroup } from '../../services/commandRegistry';
import { FOCUS_SEARCH_EVENT } from '../../services/searchFocus';

const GROUP_LABEL: Record<CommandGroup, string> = {
  modules: '模块',
  actions: '动作',
  settings: '设置',
};

interface GroupedResults {
  group: CommandGroup;
  items: { command: Command; flatIndex: number }[];
}

/** 把扁平结果按组切开，并保留每项在扁平列表里的序号（键盘导航要用） */
function groupResults(results: { command: Command }[]): GroupedResults[] {
  const groups: GroupedResults[] = [];

  results.forEach((result, flatIndex) => {
    const group = result.command.group;
    const existing = groups.find((item) => item.group === group);

    if (existing) {
      existing.items.push({ command: result.command, flatIndex });
    } else {
      groups.push({ group, items: [{ command: result.command, flatIndex }] });
    }
  });

  return groups;
}

const GlobalSearch: React.FC = () => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 依赖目录：插件在后台注册模块后结果必须跟着变（理由见 useCatalog）
  const catalog = useCatalog();

  const results = useMemo(() => searchCommands(query), [query, catalog]);
  const grouped = useMemo(() => groupResults(results), [results]);

  // Ctrl+K：聚焦并全选已有内容（继续输入即替换，按 End 可继续追加）
  useEffect(() => {
    const handleFocusRequest = () => {
      setOpen(true);
      setActiveIndex(0);
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener(FOCUS_SEARCH_EVENT, handleFocusRequest);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, handleFocusRequest);
  }, []);

  // 结果集变化时把高亮拉回第一项，否则会停在一个已经不存在的位置上
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };

    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    inputRef.current?.blur();
  }, []);

  const execute = useCallback(
    (command: Command) => {
      void runCommand(command);
      // 执行后清空查询并收起结果：留着一个已经执行过的命令列表只会挡住下一次使用
      setQuery('');
      close();
    },
    [close]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (query) {
          // 有内容时 Esc 先清空，再按一次才收起 —— 避免误清已输入的长查询
          setQuery('');
        } else {
          close();
        }
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
        setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) =>
          results.length === 0 ? 0 : (index - 1 + results.length) % results.length
        );
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const target = results[activeIndex]?.command;
        if (target) execute(target);
      }
    },
    [activeIndex, close, execute, query, results]
  );

  const showPanel = open && results.length > 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="搜索模块或动作…"
          aria-label="全局搜索"
          // 不用 data-tauri-drag-region：输入框必须能获得焦点而不是拖动窗口
          //
          // 配色说明（深色模式相关，改动前请读完）：
          //   原来写的是 `bg-gray-50/80` + `focus:bg-white`，两者在深色下都有问题：
          //   `bg-gray-50/80` 当时不在 dark-theme.css 的映射表里，于是整条输入框
          //   渲染成浅灰；而 `focus:bg-white` 是**变体**，属性选择器
          //   `[class~='bg-white']` 命中的是整个类名 token，不会命中 `focus:bg-white`，
          //   因此聚焦时还会闪出一块白底。
          //   现在改为「下沉输入区」语义：底色交给 dark-theme.css 的专用规则
          //   （`bg-gray-50/80` + `rounded-lg` 的组合选择器），聚焦只改描边与光环，
          //   **不再改底色** —— 聚焦时底色跳变本身也是一种突兀。
          className="h-7 w-full rounded-lg border border-gray-200 bg-gray-50/80 pl-8 pr-14 text-xs text-gray-900 placeholder:text-gray-400 transition-colors focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/15"
        />
        {/* 快捷键提示：这是让用户发现 Ctrl+K 的唯一途径 */}
        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
          Ctrl K
        </kbd>
      </div>

      <AnimatePresence>
        {showPanel && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            className="absolute left-0 right-0 top-9 z-66 max-h-[60vh] overflow-y-auto custom-scrollbar rounded-xl border border-gray-200 bg-white py-1 shadow-2xl"
            role="listbox"
            aria-label="搜索结果"
          >
            {grouped.map((section) => (
              <div key={section.group}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                  {GROUP_LABEL[section.group]}
                </div>

                {section.items.map(({ command, flatIndex }) => {
                  const isActive = flatIndex === activeIndex;

                  return (
                    <button
                      key={command.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      // 用 mousedown 而不是 click：click 之前输入框会先失焦，
                      // 某些情况下会导致面板先被卸载、点击落空
                      onMouseDown={(event) => {
                        event.preventDefault();
                        execute(command);
                      }}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                        isActive ? 'bg-indigo-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <ModuleIcon
                        icon={command.icon}
                        iconSvg={command.iconSvg}
                        name={command.title}
                        className="h-3.5 w-3.5 shrink-0 text-gray-500"
                      />

                      <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                        {command.title}
                      </span>

                      {command.subtitle && (
                        <span className="shrink-0 truncate text-[10px] text-gray-400" style={{ maxWidth: 140 }}>
                          {command.subtitle}
                        </span>
                      )}

                      {isActive && (
                        <CornerDownLeft className="h-3 w-3 shrink-0 text-gray-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}

            <div className="mt-1 border-t border-gray-100 px-3 py-1.5 text-[10px] text-gray-400">
              ↑↓ 选择 · Enter 执行 · Esc 清空/收起
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default GlobalSearch;
