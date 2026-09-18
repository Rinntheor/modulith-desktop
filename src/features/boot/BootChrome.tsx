// src/features/boot/BootChrome.tsx
//
// 启动阶段（加载 / 解锁）的窗口边框。
//
// 为什么需要它：应用窗口设置了 `decorations: false`，也就是说**没有系统标题栏**，
// 移动窗口的唯一途径是元素上的 `data-tauri-drag-region`。而 BootGate 会在这两个
// 阶段把整个应用（连同带拖拽区域的 Titlebar）替换掉，于是用户没法拖动窗口，
// 也点不到最小化 / 最大化 / 关闭。
//
// 这里提供一套与 Titlebar 尺寸一致（高 10 = 2.5rem）的极简窗口控制，
// 并且**不使用 backdrop-blur**：模糊会让 Chromium 对 DOM 做栅格化，
// 可能干扰 Tauri 注入的拖拽监听；配合不透明的启动背景，视觉效果一致但更可靠。

import React, { useCallback, useEffect, useState } from 'react';
import { Minus, Square, Minimize2, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** 与 Titlebar 保持一致的按钮样式（深色底版本） */
const buttonClass =
  'p-1.5 rounded-md text-gray-400 hover:bg-white/10 hover:text-white transition-colors duration-150';

const WindowControls: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    let disposed = false;

    const sync = () => {
      appWindow.isMaximized().then(
        (value) => {
          if (!disposed) setIsMaximized(value);
        },
        () => {
          /* 权限或环境问题，忽略 */
        }
      );
    };

    sync();
    const unlisten = appWindow.onResized(sync);

    return () => {
      disposed = true;
      unlisten.then((fn) => fn());
    };
  }, [appWindow]);

  const handleToggleMaximize = useCallback(() => {
    // toggleMaximize 是官方支持的做法（isMaximized + maximize/unmaximize 手写
    // 在连点或拖动边缘时容易与实际状态不同步）
    appWindow.toggleMaximize().catch((error) => {
      console.error('[BootChrome] 切换最大化失败:', error);
    });
  }, [appWindow]);

  return (
    <div className="flex items-center space-x-1">
      <button
        onClick={() => void appWindow.minimize()}
        className={buttonClass}
        aria-label="最小化"
        title="最小化"
      >
        <Minus className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={handleToggleMaximize}
        className={buttonClass}
        aria-label={isMaximized ? '还原' : '最大化'}
        title={isMaximized ? '还原' : '最大化'}
      >
        {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
      </button>
      <button
        onClick={() => void appWindow.close()}
        className="p-1.5 rounded-md text-gray-400 hover:bg-red-500 hover:text-white transition-colors duration-150"
        aria-label="关闭"
        title="关闭"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

const BootChrome: React.FC = () => {
  const appWindow = getCurrentWindow();

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[60] flex h-10 items-center px-3 select-none"
      // Tauri 的拖拽区域：在这个元素上按住即可移动窗口
      data-tauri-drag-region
      // 双击标题栏最大化 / 还原是 Windows 的默认习惯
      onDoubleClick={() => {
        appWindow.toggleMaximize().catch(() => {
          /* 忽略 */
        });
      }}
    >
      <span className="text-xs font-semibold tracking-wide text-gray-500" data-tauri-drag-region>
        Modulith Desktop
      </span>

      {/* 中间整段只用于拖动，不放置任何可交互元素 */}
      <div className="flex-1 self-stretch" data-tauri-drag-region />

      <WindowControls />
    </div>
  );
};

export default BootChrome;
