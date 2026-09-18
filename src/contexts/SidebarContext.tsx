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
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { useTabs } from '../hooks/useTabs';
import { openTab } from '../services/tabStore';
import { registerSidebarToggle } from '../services/sidebarBridge';

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

  /**
   * 记录导航历史。
   *
   * **这里观察 `activeTab` 的变化，而不是在各个入口分别记录。** 此前只有
   * `setActiveModule` 会记录历史，而它是侧边栏与仪表盘专用的入口；标签栏切换走的
   * 是 `tabStore.activate`，命令面板是另一条路 —— 结果就是「从标签栏切过去的模块
   * 不进历史」，后退按钮到底会退到哪里变得不可预期。
   *
   * 标签是「当前显示哪个模块」的唯一事实来源（见文件头），因此只要盯着它，
   * 所有入口都会自动留下历史 —— 将来新增入口也不必记得再补一行。
   */
  useEffect(() => {
    if (!activeTab) return;

    // 后退 / 前进落到的位置正是当前指针所指 —— 那不是新的访问，不记录。
    //
    // 用「指针指向的条目」判断，而不是一个「正在导航」的布尔标记：后者在目标与
    // 当前恰好相同时（例如历史里的标签已被关闭又重开）不会复位，会把下一次真实
    // 访问吞掉。这里只是一个比较，没有需要复位的东西。
    if (historyRef.current[indexRef.current] === activeTab) return;

    const stack = historyRef.current.slice(0, indexRef.current + 1);
    if (stack[stack.length - 1] !== activeTab) stack.push(activeTab);
    historyRef.current = stack;
    indexRef.current = stack.length - 1;
    syncHistoryFlags();
  }, [activeTab, syncHistoryFlags]);

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

  /**
   * 把开关函数登记给快捷键（Ctrl+B）。
   *
   * 快捷键在 React 之外派发，读不到 Context，因此由这里主动把函数交出去 ——
   * 侧边栏状态的唯一事实来源仍然是本组件，桥那边存的只是函数。详见 sidebarBridge。
   */
  useEffect(() => registerSidebarToggle(toggleSidebar), [toggleSidebar]);

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
   * 打开模块：写入标签（tabStore 负责开标签与激活）。
   *
   * 传 `null` 表示「不关心」——标签栏不允许出现无激活标签的中间态，
   * 因此这里直接忽略，而不是把 activeTab 清空。
   */
  const setActiveModule = useCallback((moduleId: string | null) => {
    if (!moduleId) return;

    openTab(moduleId);

    // 导航历史**不在这里记录**：统一由上面那个观察 activeTab 的 effect 负责。
    // 若在这里再记一次，同一个模块会入栈两次（点击时一次、activeTab 变化时一次）。

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
  }, []);

  /**
   * 后退 / 前进只移动历史指针并激活对应标签，**不再往历史里追加**。
   *
   * 走到一个已经被关闭的标签上时（历史里有、标签栏里没有），`openTab` 会把它
   * 重新打开 —— 这是期望行为：历史记录的是「去过哪里」，而不是「现在开着什么」。
   *
   * **只有真的切过去了才移动指针。** `openTab` 可能因为标签数达到上限而拒绝
   * （返回 `ok: false`）且不改变当前标签；若先移动指针再调用它，指针就会停在一个
   * 用户其实没到过的位置 —— 表现为「按了后退没反应，但前进/后退的可用状态变了」，
   * 再点一次还会跳过一个条目。
   */
  const goBack = useCallback(() => {
    if (indexRef.current <= 0) return;
    const target = historyRef.current[indexRef.current - 1];
    if (!openTab(target).ok) return;
    indexRef.current -= 1;
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const goForward = useCallback(() => {
    if (indexRef.current >= historyRef.current.length - 1) return;
    const target = historyRef.current[indexRef.current + 1];
    if (!openTab(target).ok) return;
    indexRef.current += 1;
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
