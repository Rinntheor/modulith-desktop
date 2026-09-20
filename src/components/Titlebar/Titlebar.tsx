// src/components/Titlebar/Titlebar.tsx
import React, { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { getCachedSettings, subscribeSettings } from '../../services/appSettings';

/**
 * 离线模式的常驻指示。
 *
 * 为什么必须在标题栏，而不是只在设置页里：开了忘了关的用户，症状是"市场打不开、
 * 更新失败、插件联网全坏" —— 那看起来像应用坏了。一个只存在于设置页里的开关，
 * 对这些人等于不存在。
 *
 * 做成独立组件而不是在主组件里加一个 hook 调用：这样"订阅"与"显示"在同一个地方，
 * 插进 JSX 时不必碰 Titlebar 的函数体。
 */
const OfflineBadge: React.FC = () => {
  const [offline, setOffline] = useState(() => getCachedSettings().offlineMode);

  useEffect(
    () => subscribeSettings(() => setOffline(getCachedSettings().offlineMode)),
    []
  );

  if (!offline) return null;
  return (
    <span
      className="flex items-center gap-1 px-2 py-1 rounded-md bg-amber-100 text-amber-800 text-[11px] font-medium"
      title="离线模式已开启：应用不会发出任何对外请求。在「设置 → 网络」里关闭。"
    >
      <WifiOff className="w-3.5 h-3.5" />
      离线
    </span>
  );
};
import {
  Minus,
  Square,
  X,
  Minimize2,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Settings,
  Lock,
  Bell,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import GlobalSearch from './GlobalSearch';
import {
  getUnreadCount,
  subscribeNotifications,
} from '../../services/notifications';

import { useSidebar } from '@/contexts/SidebarContext';
import { logout } from '../../services/auth';
import { refreshAuth } from '../../services/authStore';

// 窗口控制按钮组件
const WindowControls: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });
    appWindow.isMaximized().then(setIsMaximized);
    return () => {
      unlisten.then(fn => fn());
    };
  }, [appWindow]);

  const handleMinimize = () => appWindow.minimize();
  const handleMaximize = () => {
    if (isMaximized) {
      appWindow.unmaximize();
    } else {
      appWindow.maximize();
    }
  };
  const handleClose = () => appWindow.close();

  return (
    <div className="flex items-center space-x-1 ml-auto">
      <button
        onClick={handleMinimize}
        className="p-1.5 rounded-md hover:bg-gray-200/80 transition-colors duration-150"
        aria-label="Minimize"
      >
        <Minus className="w-3.5 h-3.5 text-gray-600" />
      </button>
      <button
        onClick={handleMaximize}
        className="p-1.5 rounded-md hover:bg-gray-200/80 transition-colors duration-150"
        aria-label="Maximize"
      >
        {isMaximized ? (
          <Minimize2 className="w-3.5 h-3.5 text-gray-600" />
        ) : (
          <Square className="w-3.5 h-3.5 text-gray-600" />
        )}
      </button>
      <button
        onClick={handleClose}
        className="p-1.5 rounded-md hover:bg-red-500 hover:text-white transition-colors duration-150 group"
        aria-label="Close"
      >
        <X className="w-3.5 h-3.5 text-gray-600 group-hover:text-white" />
      </button>
    </div>
  );
};

/**
 * 导航按钮：前进 / 后退走 SidebarContext 里的导航历史，
 * 刷新会重新加载插件运行时与模块目录，并重挂载当前模块。
 */
const NavigationButtons: React.FC<{
  refreshing?: boolean;
  onRefresh?: () => void;
}> = ({ refreshing = false, onRefresh }) => {
  const { canGoBack, canGoForward, goBack, goForward } = useSidebar();

  return (
    <div className="flex items-center space-x-1">
      <button
        onClick={goBack}
        disabled={!canGoBack}
        className="p-1.5 rounded-md hover:bg-gray-200/80 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label="后退"
        title={canGoBack ? '后退' : '没有可后退的历史'}
      >
        <ChevronLeft className="w-4 h-4 text-gray-600" />
      </button>
      <button
        onClick={goForward}
        disabled={!canGoForward}
        className="p-1.5 rounded-md hover:bg-gray-200/80 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label="前进"
        title={canGoForward ? '前进' : '没有可前进的历史'}
      >
        <ChevronRight className="w-4 h-4 text-gray-600" />
      </button>
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="p-1.5 rounded-md hover:bg-gray-200/80 transition-colors duration-150 disabled:opacity-60"
        aria-label="刷新"
        title="刷新模块目录与插件"
      >
        <RefreshCw className={`w-4 h-4 text-gray-600 ${refreshing ? 'animate-spin' : ''}`} />
      </button>
    </div>
  );
};

/**
 * 通知铃铛：显示未读总数，点击打开通知中心。
 *
 * 未读徽标订阅 notifications 服务，因此插件推来的通知会立刻反映在这里 ——
 * 这正是「事情来找你」这条通道的可见端点。
 */
const NotificationBell: React.FC<{ onClick?: () => void; isOpen?: boolean }> = ({
  onClick,
  isOpen = false,
}) => {
  const [unread, setUnread] = useState(() => getUnreadCount());

  useEffect(() => {
    const sync = () => setUnread(getUnreadCount());
    // 订阅建立之前可能已经推过通知，先同步一次
    sync();
    return subscribeNotifications(sync);
  }, []);

  const label = unread > 0 ? `通知（${unread} 条未读）` : '通知';

  return (
    <button
      onClick={onClick}
      className={`relative rounded-md p-1.5 transition-colors duration-150 ${
        isOpen ? 'bg-gray-200/80' : 'hover:bg-gray-200/80'
      }`}
      aria-label={label}
      title={label}
    >
      <Bell className="w-4 h-4 text-gray-600" />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-indigo-500 px-1 text-[9px] font-semibold leading-none text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
};

// 主标题栏组件
export interface TitlebarProps {
  title?: string;
  showNavigation?: boolean;
  showSettings?: boolean;
  className?: string;
  /** 点击刷新：重新加载插件与模块目录 */
  onRefresh?: () => void;
  /** 刷新进行中 */
  refreshing?: boolean;
  /** 点击设置 */
  onOpenSettings?: () => void;
  /** 点击通知铃铛 */
  onOpenNotifications?: () => void;
  /** 通知中心当前是否打开（用于按钮的选中态） */
  notificationsOpen?: boolean;
  /** 是否显示中间的全局搜索框（启动/解锁界面不需要） */
  showSearch?: boolean;
}

const Titlebar: React.FC<TitlebarProps> = ({
  title = 'Modulith Desktop',
  showNavigation = true,
  showSettings = true,
  className = '',
  onRefresh,
  refreshing = false,
  onOpenSettings,
  onOpenNotifications,
  notificationsOpen = false,
  showSearch = true,
}) => {
  /**
   * 锁定应用：结束当前会话并回到解锁界面。
   * 只清会话，「记住我」凭据保留，所以下次启动仍可自动解锁。
   */
  const handleLock = async () => {
    try {
      await logout();
      await refreshAuth();
    } catch (error) {
      console.error('[Titlebar] 锁定失败:', error);
    }
  };

  return (
    <div
      className={`lc-chrome fixed top-0 left-0 right-0 z-50 flex items-center h-10 px-3 bg-white/95 border-b border-gray-200/50 select-none ${className}`}
      data-tauri-drag-region
    >
      {/* 左侧：应用标题 + 导航按钮 */}
      <div className="flex items-center space-x-2.5 shrink-0" data-tauri-drag-region>
        <span className="text-sm font-semibold text-gray-900">{title}</span>
        {showNavigation && (
          <NavigationButtons refreshing={refreshing} onRefresh={onRefresh} />
        )}
      </div>

      {/*
        中间：全局搜索。
        用 `flex-1` + `justify-center` 让它居于「剩余空间」的中央，
        而不是窗口的绝对中心 —— 右侧有 4 个按钮、左侧只有标题，
        绝对居中会让搜索框压到右侧按钮上。
      */}
      {showSearch && (
        <div className="mx-4 flex min-w-0 flex-1 justify-center" data-tauri-drag-region>
          <GlobalSearch />
        </div>
      )}

      {/* 右侧：通知 + 锁定 + 设置 + 窗口控制 */}
      <div className="ml-auto flex items-center space-x-1 shrink-0">
        {showSettings && (
          <NotificationBell onClick={onOpenNotifications} isOpen={notificationsOpen} />
        )}
        {showSettings && (
          <button
            onClick={handleLock}
            className="p-1.5 rounded-md hover:bg-gray-200/80 transition-colors duration-150"
            aria-label="锁定"
            title="锁定：结束当前会话并返回解锁界面"
          >
            <Lock className="w-4 h-4 text-gray-600" />
          </button>
        )}
        {showSettings && (
          <button
            onClick={onOpenSettings}
            className="p-1.5 rounded-md hover:bg-gray-200/80 transition-colors duration-150"
            aria-label="设置"
            title="设置"
          >
            <Settings className="w-4 h-4 text-gray-600" />
          </button>
        )}
        <OfflineBadge />
        <WindowControls />
      </div>
    </div>
  );
};

export default Titlebar;
