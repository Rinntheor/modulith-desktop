// src/pages/Home.tsx
//
// 应用主界面。
//
// 初始化工作已经全部搬到 src/services/boot.ts（由 BootGate 驱动），
// 这里只消费启动结果，不再自己跑一遍 bootstrap——
// 之前 Home 里的初始化一旦抛错就会永远停在 spinner 上，而且与 AuthGate 出现两次加载。
//
// 布局自加入标签栏后分三层（自顶向下）：
//
//   Titlebar   fixed top-0    h-10   z-50   全宽（含窗口按钮）
//   TabBar     fixed top-10   h-9    z-40   内容区宽度（随侧边栏让位）
//   main       fixed top-[76px]      —     内容区宽度，内部是各标签的独立滚动区
//
// 内容区不再是「一个滚动容器」，而是「一层视口 + 每个标签一个滚动容器」。
// 这是保活的必要条件：只有每个标签自己持有滚动位置，切走再切回才能回到原处。
// 隐藏方式见 index.css 的 `.lc-tab-panel[data-active='false']`：用
// `visibility: hidden` 加上「暂停 CSS 动画 / 取消合成层提升」，而**不是**
// `display:none`（那会让元素失去盒子、丢掉 scrollTop，让「滚动位置保留」落空）。
//
// 这里**没有**用 `content-visibility: hidden` —— 本注释曾经这样写过，但代码
// 从来没用过它。它的收益是让非激活子树彻底不参与布局与绘制，看着更彻底；
// 不用的原因是它同样会让子树内部的滚动容器失去布局，从而威胁「切回原处」这个
// 保活的核心目标 —— 那个目标比省下几个非激活标签的布局开销重要得多。
//
// `visibility: hidden` 只停 CSS 动画，**不停 JS**：非激活模块里的定时器、订阅
// 与渲染都照旧。因此模块必须自己判断可见性 —— 用 `useModuleActive()`。宿主
// 拿不到模块创建的定时器句柄，代替不了它（见 ModuleRuntimeContext 的说明）。
//
// 为什么还要给每个标签单独套一层 MotionConfig（见下方渲染处）：
// 保活意味着切走的模块仍在运行。framer-motion 的入场动画带延迟时，那几帧会
// 落在「用户已经切到别的模块之后」——把非激活标签的 framer-motion 一并停住，
// 既省掉这份空转，也让模块在后台保持「入场已完成」的稳定状态，切回来不必重播。
//
// **那一层的 reducedMotion 必须与全局设置取并集**：MotionConfig 是子层覆盖
// 父层（framer-motion 的合并规则），因此原先写死的 `isActive ? 'never' : 'always'`
// 会把 ThemeProvider 上的全局开关在激活标签上重新打开 —— 一个「关了动画却只对
// 没在看的标签生效」的开关，而这正是「关了动画还是卡」的直接来源。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Eye,
  LayoutGrid,
  Maximize,
  RefreshCw,
  Settings,
  TriangleAlert,
  X,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SidebarProvider, useSidebar } from '@/contexts/SidebarContext';
import { ModuleRuntimeProvider } from '@/contexts/ModuleRuntimeContext';
import Sidebar from '../components/Sidebar/Sidebar';
import ModuleRenderer, { clearModuleComponentCache } from '../components/ModuleRenderer';
import Titlebar from '../components/Titlebar/Titlebar';
import TabBar from '../components/Tabs/TabBar';
import ToastLayer from '../components/Notifications/ToastLayer';
import NotificationCenter from '../components/Notifications/NotificationCenter';
import SettingsDialog, { type SettingsSectionId } from '../components/Settings/SettingsDialog';
import GlobalContextMenu, { type GlobalMenuEntry } from '../components/GlobalContextMenu';
import { moduleManager } from '../services/moduleManager';
import { reloadPluginRuntime } from '../services/pluginRuntime';
import {
  clampSplitRatio,
  getCachedSettings,
  saveAppSettings,
  subscribeSettings,
} from '../services/appSettings';
import { getReduceMotion, subscribeTheme } from '../services/theme';
import { getBootResult } from '../services/boot';
import { useTabs } from '../hooks/useTabs';
import { useCatalog } from '../hooks/useCatalog';
import {
  getFallbackModule,
  getTabGroup,
  getTabState,
  initializeTabs,
  moveTabInGroup,
  moveTabToGroup,
  openFallbackTab,
  setFocusedGroup,
  toggleSplit,
  type TabGroupId,
} from '../services/tabStore';
import {
  clearTabDrag,
  getDragPointer,
  getDraggingTab,
  getDropTarget,
  setDropTargetTarget,
  subscribeTabDrag,
} from '../services/tabDrag';
import { loadNotifications } from '../services/notifications';
import { autoCheckForAppUpdate } from '../services/appUpdater';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { registerHostCommands } from '../services/commandRegistry';
import { registerHostShortcuts } from '../services/hostShortcuts';
import { registerFullscreenToggle } from '../services/fullscreenBridge';

interface HomeContentProps {
  /** 初始化期间的非致命告警 */
  warnings: string[];
}

/**
 * 侧边栏展开时的宽度（`w-64` = 16rem = 256px）。
 *
 * 内容区与标签栏行都用它作为左内边距来给侧边栏让位 —— 侧边栏是 `fixed` 定位、
 * 不参与父级布局，所以这里只能自己留出这个数。写成常量而不是散落的 `ml-64`，
 * 是为了让"让位"这件事只有一个数字来源。
 */
const SIDEBAR_WIDTH = 256;

/**
 * 零标签时的空态。
 *
 * 刻意允许「一个标签都没有」而不是强行打开某个模块：强行回落会让「关闭最后一个
 * 标签」看起来毫无反应。这里给出明确的下一步，而不是留一片空白。
 */
const EmptyTabs: React.FC = () => {
  const catalog = useCatalog();
  const fallback = getFallbackModule();
  const canOpenFallback = Boolean(fallback && catalog.has(fallback));

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-8 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100">
        <LayoutGrid className="h-7 w-7 text-gray-400" />
      </div>
      <h2 className="text-base font-semibold text-gray-900">没有打开的标签页</h2>
      <p className="mt-2 max-w-sm text-xs leading-relaxed text-gray-500">
        从左侧边栏选择模块，或在标题栏的搜索框中输入模块名。
        每个标签都会保留它的界面状态，切走再切回时还在原处。
      </p>
      {/* 目录里没有任何可见模块时（内建模块被删且无插件）不显示按钮，
          避免出现一个点了没反应的入口 */}
      {canOpenFallback && (
        <button
          type="button"
          onClick={() => openFallbackTab()}
          className="mt-5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
        >
          打开默认模块
        </button>
      )}
    </div>
  );
};

const HomeContent: React.FC<HomeContentProps> = ({ warnings }) => {
  const { isOpen, canGoBack, canGoForward, goBack, goForward } = useSidebar();
  const { openTabs, activeTab, splitTabs, splitActive, focusedGroup, mountedTabs } = useTabs();
  const catalog = useCatalog();
  // 设置对话框当前显示的分页，以及它是否打开。
  //
  // settingsSection 现在确实是 state：更新通知里的「查看更新」必须把设置切到
  // 「关于」才能看到下载按钮。此前它是一个恒定值冒充 state（`const [...] =
  // useState(...)`，setter 被丢弃、没有任何路径能改它），那时"不需要 state"
  // 是对的，现在不是了。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general');
  // 全局右键菜单的位置；null 表示未打开
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 二级标题栏是否显示（持久化在设置里，因此重启后保持）
  const [showTabBar, setShowTabBar] = useState(() => getCachedSettings().tabBarVisible);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [showWarnings, setShowWarnings] = useState(warnings.length > 0);
  /**
   * **有效**的动效开关（「关闭动画」或「性能模式」任一开启即为 true）
   *
   * 必须在这里读一次：下面给每个标签套的 MotionConfig 会**覆盖**外层的全局
   * 设置（framer-motion 的合并规则是子层取胜），因此这一层不读，全局的
   * reducedMotion="always" 在激活标签上就失效了 —— 而那恰好是用户唯一在看的
   * 那个标签，表现就是「关了动画还是卡」。
   */
  const [reduceMotion, setReduceMotionState] = useState(() => getReduceMotion());

  // 设置变化 → 重新求值（「关闭动画」与「性能模式」都会改变这个有效值）
  useEffect(() => subscribeTheme(() => setReduceMotionState(getReduceMotion())), []);
  const bootstrappedRef = useRef(false);

  /**
   * 是否处于全屏（F11）。
   *
   * 这个状态必须由**前端**持有：全屏不只是窗口属性，它还要改变界面（隐藏标题栏与
   * 二级标题栏、把内容区上沿归零）。让快捷键直接去调 Tauri 的 `setFullscreen` 而
   * 不更新这里，就会得到「窗口全屏了、标题栏还在」。
   *
   * `ref` 与 `state` 并存：快捷键回调注册在 React 树之外，它的闭包捕获的是首次
   * 渲染的值，因此切换时读 ref 才是最新状态。
   */
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);

  const applyFullscreen = useCallback(async (next: boolean) => {
    fullscreenRef.current = next;
    setFullscreen(next);

    try {
      await getCurrentWindow().setFullscreen(next);
    } catch (error) {
      // 窗口操作失败时把界面状态回滚 —— 否则界面显示「已全屏」（标题栏消失），
      // 而窗口并没有全屏，用户看到的是一个没有标题栏、也没全屏的普通窗口。
      fullscreenRef.current = !next;
      setFullscreen(!next);
      console.error('[Home] 切换全屏失败:', error);
    }
  }, []);

  useEffect(
    () =>
      registerFullscreenToggle(() => {
        void applyFullscreen(!fullscreenRef.current);
      }),
    [applyFullscreen]
  );

  /**
   * 自启动时的窗口行为（静默 / 全屏）。
   *
   * **只在由系统自启动拉起时生效**（命令行带 `--autostart`）。用户双击图标启动
   * 不该受这两个设置影响 —— 否则「点了一下界面不出来」就是纯粹的故障。
   *
   * 静默实现为**最小化**而不是隐藏窗口：本应用没有托盘图标，隐藏之后用户只能靠
   * 任务管理器找回它。设置界面里也照此如实描述，不写成「后台静默运行」。
   *
   * 静默优先于全屏：窗口没到前台，全屏没有意义。
   */
  const startupBehaviorRef = useRef(false);

  useEffect(() => {
    if (startupBehaviorRef.current) return;
    startupBehaviorRef.current = true;

    void (async () => {
      try {
        const byAutostart = await invoke<boolean>('was_started_by_autostart');
        if (!byAutostart) return;

        const settings = getCachedSettings();
        // 优先级：静默 > 全屏 > 最大化。三者都想决定「窗口一出来是什么样」，
        // 同时开两个必须有确定答案，否则用户面对的是「到底哪个生效」的不确定性。
        if (settings.autoStartSilent) {
          await getCurrentWindow().minimize();
        } else if (settings.autoStartFullscreen) {
          await applyFullscreen(true);
        } else if (settings.autoStartMaximized) {
          await getCurrentWindow().maximize();
        }
      } catch (error) {
        // 启动行为失败不该影响使用：窗口就在那里，用户正常操作即可
        console.warn('[Home] 应用自启动行为失败:', error);
      }
    })();
  }, [applyFullscreen]);

  // 标题栏刷新：重新加载插件运行时与模块目录，并重挂载全部标签
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // 手动刷新是「用户要求立刻完成」的场景，因此不带 listOnly，
      // 但同样遵守插件加载超时设置。
      await reloadPluginRuntime(undefined, {
        timeoutMs: getCachedSettings().pluginLoadTimeoutMs,
      });
      moduleManager.reloadCatalog();
      clearModuleComponentCache();
      // 刷新是显式动作，语义就是「把一切都重来」：因此**所有**标签一起重挂载，
      // 包括非激活的那些。这会丢掉它们的界面状态，但那正是用户点刷新时想要的。
      setRefreshToken((token) => token + 1);
    } catch (error) {
      console.error('[Home] 刷新失败:', error);
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  }, []);

  /**
   * 打开设置对话框。
   *
   * 缺省落回「通用」：标题栏齿轮、快捷键、全局菜单这些入口都不关心分页，
   * 上一次被更新通知带到「关于」的状态不该被它们继承 —— 那会让人以为设置
   * 默认就开在「关于」。
   */
  const openSettings = useCallback((section: SettingsSectionId = 'general') => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const handleOpenSettings = useCallback(() => openSettings('general'), [openSettings]);

  /**
   * 更新通知的去处。
   *
   * 只把用户送到「关于」的更新卡片，**不替他点下载安装** —— 安装会关闭并重启
   * 应用，那不该由一次通知点击触发。选择权与时机留给用户。
   */
  const handleOpenUpdate = useCallback(() => openSettings('about'), [openSettings]);

  // 一次性初始化：通知、宿主命令
  // （标签状态在 Home 里、首次渲染之前就已初始化，见那里的说明）
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    registerHostCommands({
      onOpenSettings: handleOpenSettings,
      onOpenNotifications: () => setNotificationsOpen(true),
      onRefreshPlugins: handleRefresh,
    });
    // 宿主快捷键也必须注册一次。此前只注册了「命令」（供搜索框使用）而漏了
    // 「快捷键」，于是 Ctrl+K / Ctrl+W / Ctrl+Tab / Ctrl+1..9 全都没有反应
    // （注册表写好了，却从来没有人往里注册）。
    registerHostShortcuts();

    /*
     * 启动时自动检查更新。
     *
     * **放在界面就绪之后，而不是放进启动步骤表**：这一步要联网，放进
     * boot 会让启动界面多等一次网络超时，而"有没有新版本"不该拖慢进入应用。
     *
     * 不 await、也不处理返回值：检查结果通过通知送达（见 appUpdater.ts），
     * 失败只写日志 —— 用户没有发起这个动作，不该被它打扰。
     *
     * 串在 `loadNotifications` 之后：反过来（并发）的话，检查到的新版本可能
     * 先写进缓存，再被 `list_notifications` 的旧快照覆盖掉。概率极低
     * （一次网络往返对一次本地 IPC），但把顺序写对是免费的。
     */
    void loadNotifications().then(() => autoCheckForAppUpdate());
  }, [handleRefresh, handleOpenSettings]);

  useGlobalShortcuts();

  // 记录上次停留的模块，供「恢复上次的窗口状态」使用（防抖，避免频繁写盘）。
  //
  // 开关关闭时**不记**：`lastModule` 只在恢复窗口状态时才被读，而"关了开关却还在写"
  // 会让以后重新打开开关时恢复出一个更早的位置。窗口状态本身同理，见 tabStore。
  useEffect(() => {
    if (!activeTab) return;
    if (!getCachedSettings().restoreLastModule) return;
    const timer = setTimeout(() => {
      saveAppSettings({ lastModule: activeTab }).catch((error) => {
        console.warn('[Home] 记录上次打开的模块失败:', error);
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [activeTab]);

  const handleOpenNotifications = useCallback(() => setNotificationsOpen(true), []);

  // 设置里的 tabBarVisible 是唯一事实来源：别的入口（设置页、快捷键）改了它，
  // 这里跟着更新，避免「设置里改了但界面没变」。
  useEffect(
    () => subscribeSettings(() => setShowTabBar(getCachedSettings().tabBarVisible)),
    []
  );

  const toggleTabBar = useCallback(() => {
    void saveAppSettings({ tabBarVisible: !getCachedSettings().tabBarVisible });
  }, []);

  /**
   * 全局右键。
   *
   * 两条让位规则，缺一个都会出问题：
   *   1. **模块自己的右键优先。** 子元素的处理器（例如快捷启动的卡片菜单）先跑并
   *      调用 `preventDefault()`，冒泡到这里时 `defaultPrevented` 为真 —— 直接返回，
   *      否则会出现「模块菜单和全局菜单同时弹出」。
   *   2. **输入框里不接管。** 浏览器原生菜单在文本框里是有用的（复制 / 粘贴 /
   *      拼写检查），把它们换成一个只有应用动作的菜单是倒退。
   */
  const handleGlobalContextMenu = useCallback((event: React.MouseEvent) => {
    if (event.defaultPrevented) return;

    const target = event.target as HTMLElement | null;
    if (target && target.closest('input, textarea, [contenteditable="true"]')) return;

    event.preventDefault();
    setMenuPos({ x: event.clientX, y: event.clientY });
  }, []);

  // 全屏时两级标题栏都不占位，内容区上沿归零。
  const showTitlebar = !fullscreen;
  const showTabBarInLayout = showTabBar && !fullscreen;

  // 上沿用**像素**而不是 Tailwind 的 `top-19` / `top-10`：标签栏行与内容区必须落在
  // 同一个计算上，两处各写一次很容易在某个组合（全屏 + 手动隐藏标签栏）下错开。
  const contentTopPx = showTabBarInLayout ? 76 : showTitlebar ? 40 : 0;
  const sidebarPx = isOpen ? SIDEBAR_WIDTH : 0;

  const splitOn = splitTabs.length > 0;

  /**
   * 拖拽状态的镜像（画幽灵标签与落点用）。
   *
   * 真值在 `tabDrag` 的模块级状态里，这里只是它在 React 里的投影：拖拽的发起方是
   * 标签栏，而落点判定有一半在内容区，两边都要读它；而 pointermove 每帧都变，
   * 放进某一边的 React state 会让另一边读不到。
   */
  const [dragState, setDragState] = useState(() => ({
    tab: getDraggingTab(),
    pointer: getDragPointer(),
    target: getDropTarget(),
  }));
  useEffect(
    () =>
      subscribeTabDrag(() =>
        setDragState({
          tab: getDraggingTab(),
          pointer: getDragPointer(),
          target: getDropTarget(),
        })
      ),
    []
  );

  /**
   * 拖拽结束的**提交**点。
   *
   * 放在 `Home` 而不是标签栏：只有这里同时知道"拖的是谁"和"落在内容区的哪一半"。
   * 监听挂在 `window` 上 —— 用户可能在窗口外松开指针，挂在元素上会漏掉那次 pointerup，
   * 标签就会一直粘在指针上。
   */
  useEffect(() => {
    const commit = () => {
      const tab = getDraggingTab();
      if (!tab) return;

      const target = getDropTarget();
      // 先清拖拽状态再执行：搬运会让标签换组，留着旧落点会闪一下
      clearTabDrag();
      if (!target) return;

      if (target.kind === 'splitzone') {
        // 落到内容区的某一半：搬到那一组（落在自己那一组时是无操作）
        moveTabToGroup(tab, target.zone);
        return;
      }

      const current = getTabGroup(tab);
      if (current === target.group) {
        if (target.index === null) return; // 落在空白处 = 追加到末尾 = 原地不动
        const { openTabs, splitTabs } = getTabState();
        const tabs = target.group === 'primary' ? openTabs : splitTabs;
        const from = tabs.indexOf(tab);
        if (from !== -1 && from !== target.index) moveTabInGroup(target.group, from, target.index);
        return;
      }

      moveTabToGroup(tab, target.group, target.index ?? undefined);
    };

    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', commit);
    return () => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', commit);
    };
  }, []);

  /** 拖拽落点区的样式：当前悬停的那一半高亮，其余淡出 */
  const zoneClass = (zone: TabGroupId): string => {
    const hovered =
      dragState.target?.kind === 'splitzone' && dragState.target.zone === zone;
    if (hovered) return 'border-indigo-400 bg-indigo-100/40';
    // 未分屏时左半只是"留在原处"的无操作区，不画出来免得像是可放的目标
    if (zone === 'primary' && !splitOn) return 'border-transparent';
    return 'border-indigo-200 bg-indigo-50/20';
  };

  /**
   * 分屏比例（左半占内容区的比例）。
   *
   * 放在前端 state 里、并持久化到设置：用户把它拖成 7:3 就是一个明确的偏好，
   * 下次启动再回到 5:5 会让人以为设置没保存。
   */
  const [splitRatio, setSplitRatio] = useState(() => clampSplitRatio(getCachedSettings().splitRatio));
  const splitRatioRef = useRef(splitRatio);
  const contentRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  splitRatioRef.current = splitRatio;

  /**
   * 拖动分隔条。
   *
   * 用指针事件而不是 HTML5 拖放：分隔条是"连续跟随"的交互，而 HTML5 拖放只有
   * 离散的 dragover，做出来的手感是跳的。`setPointerCapture` 保证指针移出分隔条
   * 甚至移出窗口后仍然收到事件 —— 不捕获的话快速拖动会在中途断掉。
   */
  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }, []);

  const handleResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;

    setSplitRatio(clampSplitRatio((event.clientX - rect.left) / rect.width));
  }, [resizing]);

  const handleResizeEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizing) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      setResizing(false);

      // 只在拖动结束时写一次盘，而不是每一帧都写
      void saveAppSettings({ splitRatio: splitRatioRef.current });
    },
    [resizing]
  );

  /**
   * 点进哪一半就把焦点交给哪一半。
   *
   * 用坐标判断，而不是给两半各挂一个处理器：所有面板都在**同一个容器**里绝对定位
   * （保活要求，见渲染处的说明），根本没有"两半"这两个 DOM 节点可以挂。
   *
   * 这一步决定「从侧边栏新开的模块落在哪一组」以及 `Ctrl+W` / `Ctrl+Tab` 作用于
   * 哪一组 —— 用户点进右半，就是声明了"我现在在这边工作"。
   */
  const handleContentMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (!splitOn) return;
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      setFocusedGroup(ratio < splitRatio ? 'primary' : 'split');
    },
    [splitOn, splitRatio]
  );

  const menuEntries: GlobalMenuEntry[] = [
    {
      label: '后退',
      icon: ChevronLeft,
      shortcut: 'Alt+←',
      disabled: !canGoBack,
      action: goBack,
    },
    {
      label: '前进',
      icon: ChevronRight,
      shortcut: 'Alt+→',
      disabled: !canGoForward,
      action: goForward,
    },
    { type: 'divider' },
    { label: '刷新插件与模块', icon: RefreshCw, action: () => void handleRefresh() },
    { label: '打开设置', icon: Settings, action: handleOpenSettings },
    { label: '打开通知中心', icon: Bell, action: handleOpenNotifications },
    { type: 'divider' },
    {
      label: '显示二级标题栏',
      icon: Eye,
      checked: showTabBar,
      action: toggleTabBar,
    },
    {
      // 分屏的入口之一（另外两个是标签右键菜单与拖动标签）。
      // 只做**窗口内**分屏：独立窗口需要跨窗口状态同步，是另一件事。
      label: splitOn ? '关闭分屏' : '把当前标签分屏',
      icon: Columns2,
      shortcut: 'Ctrl+\\',
      disabled: !activeTab,
      action: () => toggleSplit(),
    },
    {
      label: fullscreen ? '退出全屏' : '全屏',
      icon: Maximize,
      shortcut: 'F11',
      action: () => void applyFullscreen(!fullscreenRef.current),
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50" onContextMenu={handleGlobalContextMenu}>
      {/*
        全屏时连标题栏一起隐藏：全屏的意义就是「只看内容」，留着一条 40px 的标题栏
        等于没全屏。窗口按钮（最小化 / 关闭）此时确实不可见，退出方式是再按一次
        F11 —— 这是「全屏只由 F11 进入」的配套代价。

        非全屏时标题栏必须保留：窗口是无边框的（`decorations: false`），隐藏它会让
        用户没有关窗口的办法。
      */}
      {showTitlebar && (
        <Titlebar
          onRefresh={handleRefresh}
          refreshing={refreshing}
          onOpenSettings={handleOpenSettings}
          onOpenNotifications={handleOpenNotifications}
          notificationsOpen={notificationsOpen}
        />
      )}
      {/* 全屏时侧边栏上移贴合：它的定位写死了标题栏高度（40px），不跟着变会在顶部
          留出空隙、底部溢出。见 Sidebar 的 immersive prop 说明。 */}
      <Sidebar immersive={fullscreen} />
      {/*
        标签栏行：**按组分列**。分屏后两条标签栏各占内容区的一半，分隔位置与下面
        内容区的分隔条一致 —— 两边都用同一个 `splitRatio` 换算，所以拖分隔条时
        标签栏与内容会一起动，不会出现"标题栏的分界和内容的分界对不上"。
      */}
      {showTabBarInLayout && (
        <div
          className="fixed left-0 right-0 z-40 flex h-9"
          style={{ top: showTitlebar ? 40 : 0, paddingLeft: sidebarPx }}
        >
          <div className="flex min-w-0" style={{ flex: `${splitOn ? splitRatio : 1} 1 0%` }}>
            <TabBar group="primary" focused={focusedGroup === 'primary'} />
          </div>
          {splitOn && (
            <>
              <div className="w-px shrink-0 bg-gray-200/70" />
              <div className="flex min-w-0" style={{ flex: `${1 - splitRatio} 1 0%` }}>
                <TabBar group="split" focused={focusedGroup === 'split'} />
              </div>
            </>
          )}
        </div>
      )}

      {/*
        内容区。要点：
          * 上沿与左内边距都用**像素**算（`contentTopPx` / `sidebarPx`），与上面
            标签栏行同源 —— 侧边栏是 fixed 定位、不参与父级布局，这里只能自己让位；
          * 外层 `overflow-hidden` 的视口本身不滚动；
          * 每个已挂载的标签是一个绝对定位的独立滚动区，横向上按所属组铺到左半或
            右半。不可见的用 `invisible + pointer-events-none` 隐藏 —— 保留盒子，
            因此 scrollTop 不会丢。
      */}
      <main
        className="fixed inset-x-0 bottom-0 flex flex-col overflow-hidden"
        style={{ top: contentTopPx, paddingLeft: sidebarPx }}
      >
        {/* 初始化期间的非致命告警（例如某个插件加载失败）：提示一次，可关闭 */}
        <AnimatePresence>
          {showWarnings && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="shrink-0 overflow-hidden"
            >
              <div className="mx-8 mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-amber-800">
                    初始化有 {warnings.length} 项未完成，不影响正常使用
                  </p>
                  {warnings.map((warning, index) => (
                    <p key={index} className="mt-0.5 text-[11px] text-amber-700/80 break-all">
                      {warning}
                    </p>
                  ))}
                </div>
                <button
                  onClick={() => setShowWarnings(false)}
                  aria-label="关闭提示"
                  className="shrink-0 rounded p-1 text-amber-600/70 transition-colors hover:bg-amber-100 hover:text-amber-800"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          className="relative min-h-0 flex-1"
          ref={contentRef}
          onMouseDownCapture={handleContentMouseDown}
        >
          {openTabs.length === 0 && splitTabs.length === 0 && <EmptyTabs />}

          {/*
            只渲染「挂载过的」标签（惰性挂载）。重启后恢复 10 个标签时不会
            一次挂载 10 个模块，只有被激活过的才会进入这里。
            `mountedTabs` 里的标签**不会**因为切走而卸载，这就是保活。

            **所有面板都待在同一个父容器里**，横向上按所属组铺到左半或右半。
            这一点是刻意的：把标签从一组拖到另一组时，只有它的 `left/width` 变了，
            React 仍然复用同一个元素（key 与父节点都没动），滚动位置与未提交的表单
            因此不会丢。若按组分两个容器渲染，跨组移动就会重新挂载 —— 而那正是这个
            应用最不该丢的东西。
          */}
          {mountedTabs.map((moduleId) => {
            // **可见 = 它所在那一组正在显示它。** 分屏之后「激活」与「可见」不再
            // 一一对应：两组各有一个激活标签，而两组都看得见。
            //
            // 传给模块的 `isActiveTab` 用的是可见性而不是焦点 —— 模块问的是
            // 「我现在要不要继续跑后台工作」（`useModuleActive` 的语义），分屏时
            // 两半都该正常活着；按焦点判定会让另一半自作主张地停掉后台轮询。
            const isVisible =
              moduleId === activeTab || (splitOn && moduleId === splitActive);

            const inSplitGroup = getTabGroup(moduleId) === 'split';

            return (
              <section
                key={`${moduleId}#${refreshToken}`}
                // 不可见的标签：内容仍在 DOM 中、状态与滚动位置都在（保活），
                // 但既不显示、也不接收交互、辅助技术也读不到。
                //
                // 隐藏用 `visibility: hidden` 而**不是** `display:none`：
                // 后者会让元素失去盒子，多数浏览器随之丢掉 scrollTop，
                // 「切回来还在原处」这个保活的核心目标就落空了。
                //
                // `data-active` 供 index.css 的 `.lc-tab-panel` 追加两条规则：
                // 暂停该子树内的 CSS 动画/过渡，并取消其合成层提升。
                // 这是「切走时还有几个卡片停留一下」的修复点 ——
                // 详见 index.css 里那段注释（根因是**动画没停**，不是没隐藏）。
                data-active={isVisible}
                aria-hidden={!isVisible}
                // 横向位置按「属于哪一组」算：左半从 0 起，右半从 ratio 起；
                // 未分屏时左半就是全宽。用内联样式而不是 Tailwind 的 w-1/2 ——
                // 比例是运行期可变的值，类名表达不了。
                style={{
                  left: inSplitGroup ? `${splitRatio * 100}%` : 0,
                  width: splitOn
                    ? inSplitGroup
                      ? `${(1 - splitRatio) * 100}%`
                      : `${splitRatio * 100}%`
                    : '100%',
                }}
                className={`lc-tab-panel absolute inset-y-0 overflow-y-auto overflow-x-hidden custom-scrollbar ${
                  isVisible ? '' : 'invisible pointer-events-none'
                }`}
              >
                <div className="p-8">
                  <ModuleRuntimeProvider moduleId={moduleId} isActiveTab={isVisible}>
                    {/*
                      非激活标签：把入场动画「立即跳到终态」而不是继续播放。

                      为什么需要这一层（这是本问题真正的修复点之一）：
                      保活让切走的模块仍在运行，而模块的入场动画往往**带延迟**
                      （仪表盘统计卡片是 `delay: 0.15 + i*0.06`，即 index 2/3/4
                      分别延迟 0.27/0.33/0.39s）。用户切走时这几张刚播到前几帧，
                      动画继续推进，中间帧就可能被合成器画到屏幕上 ——
                      表现为「新页面上停留了几个卡片才消失」，而「三个」正是
                      延迟最长的那三张。

                      这里用 `initial={false}`：告诉 framer-motion **跳过初始态**，
                      直接以 `animate` 的目标值（终态）渲染。于是非激活标签里
                      不存在「进行中的入场动画」，也就没有中间帧可残留。

                      注意为什么不是只靠 reducedMotion="always"：
                      实测 framer-motion 12 的实现里，reduced motion 只对
                      `positionalKeys`（width/height/top/left/right/bottom +
                      transform 系列）短路，**opacity 不在其中**
                      （见 motion-dom 的 visual-element-target.mjs：
                      `shouldReduceMotion && positionalKeys.has(key) ? {type:false} : transition`）。
                      而卡片残留的可见表现恰恰是 opacity 淡入，所以
                      reducedMotion 单用不足以解决这个问题。

                      激活标签保持原有动画，切换体验不变 —— 除非用户开了「关闭动画」
                      或「性能模式」，那时这一层也必须跟着停（见上面关于子层覆盖父层
                      的说明）。
                    */}
                    <MotionConfig
                      reducedMotion={isVisible && !reduceMotion ? 'never' : 'always'}
                      transition={isVisible && !reduceMotion ? undefined : { duration: 0 }}
                    >
                      <ModuleRenderer moduleId={moduleId} initial={isVisible} />
                    </MotionConfig>
                  </ModuleRuntimeProvider>
                </div>
              </section>
            );
          })}

          {/*
            分隔条。只在分屏时存在，位置与标签栏行的分界同源（都用 `splitRatio`），
            所以拖动时上下两条分界始终对齐。

            用指针捕获：拖动过程中指针移出这条 4px 的窄条（甚至移出窗口）仍然能收到
            事件，不会「拖到一半断掉」。
            双击回到对半分 —— 拖歪之后有个确定的归位方式，不必靠手感找回来。
          */}
          {splitOn && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整分屏比例"
              onPointerDown={handleResizeStart}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeEnd}
              onPointerCancel={handleResizeEnd}
              onDoubleClick={() => {
                setSplitRatio(0.5);
                void saveAppSettings({ splitRatio: 0.5 });
              }}
              className={`absolute inset-y-0 z-30 w-1 cursor-col-resize transition-colors ${
                resizing ? 'bg-indigo-400/60' : 'bg-gray-200 hover:bg-indigo-300/60'
              }`}
              style={{ left: `calc(${splitRatio * 100}% - 2px)` }}
            />
          )}

          {/*
            拖拽落点：内容区的左右两半。

            **两个区在拖拽期间都在**，因此"在哪松手"总有明确含义；只画目标那一半
            会让另一半的松手变成"什么也没发生"，而用户看不出区别。

            未分屏时左半那个区不可见但仍捕获指针：落在它上面等于"留在左组"，
            是个无操作，不需要提示。
          */}
          {dragState.tab && (
            <>
              <div
                onPointerMove={() => setDropTargetTarget({ kind: 'splitzone', zone: 'primary' })}
                className={`absolute inset-y-0 left-0 z-20 flex items-center justify-center border-2 border-dashed ${zoneClass('primary')}`}
                style={{ width: `${splitRatio * 100}%` }}
              >
                {splitOn && (
                  <span className="pointer-events-none rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-indigo-600 shadow-sm">
                    移回左侧
                  </span>
                )}
              </div>

              <div
                onPointerMove={() => setDropTargetTarget({ kind: 'splitzone', zone: 'split' })}
                className={`absolute inset-y-0 right-0 z-20 flex items-center justify-center border-2 border-dashed ${zoneClass('split')}`}
                style={{ width: `${(1 - splitRatio) * 100}%` }}
              >
                <span className="pointer-events-none rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-indigo-600 shadow-sm">
                  {splitOn ? '放到右半' : '放到这里分屏'}
                </span>
              </div>
            </>
          )}
        </div>
      </main>

      <NotificationCenter
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        onOpenUpdate={handleOpenUpdate}
      />

      <ToastLayer onOpenCenter={handleOpenNotifications} onOpenUpdate={handleOpenUpdate} />

      <SettingsDialog
        open={settingsOpen}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
      />

      {/* 全局右键菜单：位置由最后一次右键决定，条目见上面的 menuEntries */}
      {menuPos && (
        <GlobalContextMenu
          x={menuPos.x}
          y={menuPos.y}
          entries={menuEntries}
          onClose={() => setMenuPos(null)}
        />
      )}

      {/*
        跟随指针的「幽灵标签」。
        拖拽是用指针事件自己实现的（HTML5 拖放这个应用里不可用，见 tabDrag 的说明），
        因此没有浏览器自带的拖动影像 —— 不给点反馈的话，用户看不出自己正在拖东西。
        `pointer-events-none` 是必须的：它会跟着指针走，能接收指针事件就会把
        `pointermove` 从下面的落点区抢走，落点判定随即失效。
      */}
      {dragState.tab && dragState.pointer && (
        <div
          className="pointer-events-none fixed z-[80] rounded-md border border-indigo-200 bg-white/95 px-2 py-1 text-[11px] font-medium text-gray-700 shadow-lg"
          style={{ left: dragState.pointer.x + 12, top: dragState.pointer.y + 12 }}
        >
          {catalog.get(dragState.tab)?.name ?? dragState.tab}
        </div>
      )}
    </div>
  );
};

const Home: React.FC = () => {
  const boot = getBootResult();

  // BootGate 保证只有「就绪」后才会渲染 Home，这里是类型收窄兜底。
  if (!boot) return null;

  /*
   * 标签状态必须**在首次渲染之前**就绪，因此在这里同步初始化，而不是放进
   * HomeContent 的 effect。放进 effect 会让第一帧读到空的 openTabs，
   * 界面先闪一下「没有打开的标签页」再跳到真正的模块 —— 一次可见的闪烁。
   *
   * 在渲染期间调用外部 store 的初始化是一个副作用，这里可以接受，因为
   * `initializeTabs` 是幂等的（有 `initialized` 守卫）：StrictMode 的双次渲染、
   * 以及将来可能出现的重复挂载都不会重置用户已经打开的标签。
   */
  initializeTabs(boot.initialModule);

  return (
    <SidebarProvider defaultCollapsed={boot.collapsed}>
      <HomeContent warnings={boot.warnings} />
    </SidebarProvider>
  );
};

export default Home;
