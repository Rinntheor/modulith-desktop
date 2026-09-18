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
// 隐藏方式见 index.css 的 `.lc-tab-panel`：用 `content-visibility: hidden`
// 把非激活标签移出渲染与合成，而**不是** `display:none`（那会丢掉 scrollTop，
// 让「滚动位置保留」落空）。
//
// 为什么还要给每个标签单独套一层 MotionConfig（见下方渲染处）：
// 保活意味着切走的模块仍在运行。framer-motion 的入场动画带延迟时，那几帧会
// 落在「用户已经切到别的模块之后」——`content-visibility` 让它不再可见，
// 但动画本身仍会空转。把非激活标签的 framer-motion 一并停住，既省掉这份空转，
// 也让模块在后台保持「入场已完成」的稳定状态，切回来不必重播。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Eye,
  LayoutGrid,
  RefreshCw,
  Settings,
  TriangleAlert,
  X,
} from 'lucide-react';
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
import { getCachedSettings, saveAppSettings, subscribeSettings } from '../services/appSettings';
import { getBootResult } from '../services/boot';
import { useTabs } from '../hooks/useTabs';
import { useCatalog } from '../hooks/useCatalog';
import { getFallbackModule, initializeTabs, openFallbackTab } from '../services/tabStore';
import { loadNotifications } from '../services/notifications';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { registerHostCommands } from '../services/commandRegistry';
import { registerHostShortcuts } from '../services/hostShortcuts';

interface HomeContentProps {
  /** 初始化期间的非致命告警 */
  warnings: string[];
}

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
  const { openTabs, activeTab, mountedTabs } = useTabs();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 全局右键菜单的位置；null 表示未打开
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 二级标题栏是否显示（持久化在设置里，因此重启后保持）
  const [showTabBar, setShowTabBar] = useState(() => getCachedSettings().tabBarVisible);
  // 设置对话框固定从「通用」页打开。此前这里是一个丢弃了 setter 的 state
  // （`const [settingsSection] = useState(...)`），即一个恒定值冒充 state ——
  // 没有任何路径能改它，因此不需要 state。
  const settingsSection: SettingsSectionId = 'general';
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [showWarnings, setShowWarnings] = useState(warnings.length > 0);
  const bootstrappedRef = useRef(false);

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

  // 一次性初始化：通知、宿主命令
  // （标签状态在 Home 里、首次渲染之前就已初始化，见那里的说明）
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    void loadNotifications();
    registerHostCommands({
      onOpenSettings: () => setSettingsOpen(true),
      onOpenNotifications: () => setNotificationsOpen(true),
      onRefreshPlugins: handleRefresh,
    });
    // 宿主快捷键也必须注册一次。此前只注册了「命令」（供搜索框使用）而漏了
    // 「快捷键」，于是 Ctrl+K / Ctrl+W / Ctrl+Tab / Ctrl+1..9 全都没有反应
    // （注册表写好了，却从来没有人往里注册）。
    registerHostShortcuts();
  }, [handleRefresh]);

  useGlobalShortcuts();

  // 记录上次打开的模块，供「恢复上次打开的模块」使用（防抖，避免频繁写盘）
  useEffect(() => {
    if (!activeTab) return;
    const timer = setTimeout(() => {
      saveAppSettings({ lastModule: activeTab }).catch((error) => {
        console.warn('[Home] 记录上次打开的模块失败:', error);
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [activeTab]);

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
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
  ];

  return (
    <div className="min-h-screen bg-gray-50" onContextMenu={handleGlobalContextMenu}>
      <Titlebar
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onOpenSettings={handleOpenSettings}
        onOpenNotifications={handleOpenNotifications}
        notificationsOpen={notificationsOpen}
      />
      <Sidebar />
      {/* 二级标题栏可以整体隐藏（全局右键 →「显示二级标题栏」），用于沉浸浏览。
          注意只隐藏它，不隐藏标题栏：窗口是无边框的，标题栏承载窗口按钮。 */}
      {showTabBar && <TabBar />}

      {/*
        内容区结构说明见文件头。要点：
          * 内容区上沿 = 标题栏 h-10(40px) + 二级标题栏 h-9(36px)；隐藏二级标题栏
            时只剩 40px，因此这里必须是 `top-19` / `top-10` 二选一，写死会让内容
            区上沿留出一条空白；
          * 外层是 `overflow-hidden` 的**视口**，本身不滚动；
          * 每个已挂载的标签是一个 `absolute inset-0 overflow-y-auto` 的独立滚动区，
            非激活的用 `invisible + pointer-events-none` 隐藏 —— 保留盒子，
            因此 scrollTop 不会丢。
      */}
      <main
        className={`fixed inset-x-0 bottom-0 flex flex-col overflow-hidden transition-[margin] duration-200 ${
          showTabBar ? 'top-19' : 'top-10'
        } ${isOpen ? 'ml-64' : 'ml-0'}`}
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

        <div className="relative min-h-0 flex-1">
          {openTabs.length === 0 && <EmptyTabs />}

          {/*
            只渲染「挂载过的」标签（惰性挂载）。重启后恢复 10 个标签时不会
            一次挂载 10 个模块，只有被激活过的才会进入这里。
            `mountedTabs` 里的标签**不会**因为切走而卸载，这就是保活。
          */}
          {mountedTabs.map((moduleId) => {
            const isActive = moduleId === activeTab;

            return (
              <section
                key={`${moduleId}#${refreshToken}`}
                // 非激活标签：内容仍在 DOM 中、状态与滚动位置都在（保活），
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
                data-active={isActive}
                aria-hidden={!isActive}
                className={`lc-tab-panel absolute inset-0 overflow-y-auto overflow-x-hidden custom-scrollbar ${
                  isActive ? '' : 'invisible pointer-events-none'
                }`}
              >
                <div className="p-8">
                  <ModuleRuntimeProvider moduleId={moduleId} isActiveTab={isActive}>
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

                      激活标签保持原有动画，切换体验不变。
                    */}
                    <MotionConfig
                      reducedMotion={isActive ? 'never' : 'always'}
                      transition={isActive ? undefined : { duration: 0 }}
                    >
                      <ModuleRenderer moduleId={moduleId} initial={isActive} />
                    </MotionConfig>
                  </ModuleRuntimeProvider>
                </div>
              </section>
            );
          })}
        </div>
      </main>

      <NotificationCenter
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />

      <ToastLayer onOpenCenter={handleOpenNotifications} />

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
