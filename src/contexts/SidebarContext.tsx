// src/contexts/SidebarContext.tsx
//
// 侧边栏状态 + 模块导航历史。
//
// 「当前显示哪个模块」**不在这里**：它由 `tabStore` 持有（见该文件），这里通过
// `useTabs()` 读出来。原因是一个模块可能同时被三种途径激活 —— 侧边栏点击、
// 标签栏点击、命令面板 —— 如果各自维护一份「当前模块」，它们必然漂移，
// 表现为「点了侧边栏但标签栏高亮没变」这类问题。让标签成为唯一事实来源之后，
// 所有入口都只是往同一个地方写。
//
// 这里保留的导航历史（前进 / 后退）是**访问顺序**，与标签的显示顺序是两回事：
// 标签顺序是用户拖出来的排列，历史顺序是他实际去过的地方。混在一起会让
// 「后退」跳到标签栏上的相邻位置，那不是用户期望的语义。

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { useTabs } from '../hooks/useTabs';
import { openTab } from '../services/tabStore';

interface SidebarContextType {
  isOpen: boolean;
  isCollapsed: boolean;
  /** 当前激活的模块（来自 tabStore；零标签时为 null） */
  activeModule: string | null;
  expandedModules: Set<string>;
  /** 是否可以后退（导航历史） */
  canGoBack: boolean;
  /** 是否可以前进（导航历史） */
  canGoForward: boolean;
  toggleSidebar: () => void;
  setActiveModule: (moduleId: string | null) => void;
  goBack: () => void;
  goForward: () => void;
  toggleExpandModule: (moduleId: string) => void;
  ensureExpanded: (parentId: string) => void;
  openSidebar: () => void;
  closeSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

export interface SidebarProviderProps {
  children: React.ReactNode;
  /** 启动时是否折叠侧边栏（来自应用设置） */
  defaultCollapsed?: boolean;
}

export const SidebarProvider: React.FC<SidebarProviderProps> = ({
  children,
  defaultCollapsed = false,
}) => {
  const [isOpen, setIsOpen] = useState(!defaultCollapsed);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());

  // 唯一的模块来源：标签栏
  const { activeTab } = useTabs();

  // 导航历史：用 ref 存栈，用 state 暴露「能否前进/后退」
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef(-1);
  const [historyFlags, setHistoryFlags] = useState({ canBack: false, canForward: false });

  const syncHistoryFlags = useCallback(() => {
    setHistoryFlags({
      canBack: indexRef.current > 0,
      canForward: indexRef.current < historyRef.current.length - 1,
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    if (isOpen) {
      setIsOpen(false);
      setIsCollapsed(true);
    } else {
      setIsCollapsed(false);
      requestAnimationFrame(() => {
        setIsOpen(true);
      });
    }
  }, [isOpen]);

  const openSidebar = useCallback(() => {
    setIsCollapsed(false);
    requestAnimationFrame(() => {
      setIsOpen(true);
    });
  }, []);

  const closeSidebar = useCallback(() => {
    setIsOpen(false);
    setIsCollapsed(true);
  }, []);

  const toggleExpandModule = useCallback((moduleId: string) => {
    setExpandedModules(prev => {
      const next = new Set(prev);
      if (next.has(moduleId)) {
        next.delete(moduleId);
      } else {
        next.add(moduleId);
      }
      return next;
    });
  }, []);

  // 确保父模块展开（但不收起其他模块）
  const ensureExpanded = useCallback((parentId: string) => {
    setExpandedModules(prev => {
      if (prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.add(parentId);
      return next;
    });
  }, []);

  /**
   * 打开模块：写入标签（tabStore 负责开标签与激活），并记录访问历史。
   *
   * 传 `null` 表示「不关心」——标签栏不允许出现无激活标签的中间态，
   * 因此这里直接忽略，而不是把 activeTab 清空。
   */
  const setActiveModule = useCallback((moduleId: string | null) => {
    if (!moduleId) return;

    openTab(moduleId);

    // 记录导航历史（截断「前进」分支，相邻重复不入栈）
    const stack = historyRef.current.slice(0, indexRef.current + 1);
    if (stack[stack.length - 1] !== moduleId) {
      stack.push(moduleId);
    }
    historyRef.current = stack;
    indexRef.current = stack.length - 1;
    syncHistoryFlags();

    // 如果是子模块，确保父模块展开
    if (moduleId.includes('/')) {
      const parentId = moduleId.split('/')[0];
      setExpandedModules(prev => {
        if (prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.add(parentId);
        return next;
      });
    }
  }, [syncHistoryFlags]);

  /**
   * 后退 / 前进只移动历史指针并激活对应标签，**不再往历史里追加**。
   *
   * 走到一个已经被关闭的标签上时（历史里有、标签栏里没有），`openTab` 会把它
   * 重新打开 —— 这是期望行为：历史记录的是「去过哪里」，而不是「现在开着什么」。
   */
  const goBack = useCallback(() => {
    if (indexRef.current <= 0) return;
    indexRef.current -= 1;
    openTab(historyRef.current[indexRef.current]);
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const goForward = useCallback(() => {
    if (indexRef.current >= historyRef.current.length - 1) return;
    indexRef.current += 1;
    openTab(historyRef.current[indexRef.current]);
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const value = useMemo(() => ({
    isOpen,
    isCollapsed,
    activeModule: activeTab,
    expandedModules,
    canGoBack: historyFlags.canBack,
    canGoForward: historyFlags.canForward,
    toggleSidebar,
    setActiveModule,
    goBack,
    goForward,
    toggleExpandModule,
    ensureExpanded,
    openSidebar,
    closeSidebar,
  }), [
    isOpen,
    isCollapsed,
    activeTab,
    expandedModules,
    historyFlags,
    toggleSidebar,
    setActiveModule,
    goBack,
    goForward,
    toggleExpandModule,
    ensureExpanded,
    openSidebar,
    closeSidebar
  ]);

  return (
    <SidebarContext.Provider value={value}>
      {children}
    </SidebarContext.Provider>
  );
};

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within SidebarProvider');
  }
  return context;
};
