// src/components/ThemeProvider.tsx
//
// 把「主题」与「动效开关」接进 React 树。
//
// 两件事必须在这里做，而不是各自分散：
//   1. 设置 → 界面：订阅 appSettings，把后端权威值写进 document（services/theme）；
//   2. 关闭动画：用 framer-motion 的 MotionConfig 统一停用所有 motion 动画。
//      motion 组件遍布全应用，逐个加条件判断既冗长又容易漏，
//      MotionConfig 是官方为此提供的开关。
//
// 为什么需要独立 Provider 而不是塞进 BootGate：
//   BootGate 自身就会渲染带动画的启动/授权界面，它必须也在 MotionConfig
//   之内；因此 Provider 要在 BootGate 外层。

import React, { useEffect, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { getCachedSettings, subscribeSettings } from '../services/appSettings';
import {
  getReduceMotion,
  primeThemeFromDocument,
  setPerformanceMode,
  setReduceMotion,
  setThemeMode,
  subscribeTheme,
  watchSystemTheme,
} from '../services/theme';
import { primeAccentFromDocument, setAccentId } from '../services/accent';

/*
 * 模块加载即同步一次。
 *
 * 必须在任何组件渲染之前完成：`primeThemeFromDocument()` 把 index.html 已经
 * 写好的主题读回内存，这样下面 useState 的惰性初始化拿到的就是正确值，
 * 不会出现「首帧用默认值渲染再纠正」的闪烁。
 * 它本身幂等，重复调用无副作用。
 */
primeThemeFromDocument();
// 配色与主题一样，首帧不能等后端：index.html 的内联脚本已按 localStorage
// 缓存写过一次，这里把它读回内存，保证 React 首帧就有正确的主色。
primeAccentFromDocument();

/** 把当前设置里的主题、配色、动效与性能模式应用到 document（后端 → 界面 的单向同步） */
function applySettingsToTheme(): void {
  const settings = getCachedSettings();
  setThemeMode(settings.theme);
  setAccentId(settings.accent);
  setReduceMotion(settings.reduceMotion);
  // 顺序无关：两者都由 `applyMotionPreference` 合并成同一个有效值，
  // 先设哪个都不会留下中间态。
  setPerformanceMode(settings.performanceMode);
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  // 惰性初始化：模块加载时已经 prime 过，因此这里读到的是首帧就必须生效的值。
  // reduceMotion 不能从 0/false 起步，否则「关闭动画」会先放一帧动画出去。
  const [reduceMotion, setReduceMotionState] = useState<boolean>(() => getReduceMotion());

  useEffect(() => {
    // 1) 系统主题变化（仅当模式为 system 时生效）
    const unwatchSystem = watchSystemTheme();

    // 2) 设置变化 → 应用到 document，并同步动效开关到本地状态
    applySettingsToTheme();
    setReduceMotionState(getReduceMotion());

    const unsubscribeSettings = subscribeSettings(() => {
      applySettingsToTheme();
      setReduceMotionState(getReduceMotion());
    });

    // 3) 主题自身变化（例如切到跟随系统后系统换主题）→ 同步动效状态
    const unsubscribeTheme = subscribeTheme(() => setReduceMotionState(getReduceMotion()));

    return () => {
      unwatchSystem();
      unsubscribeSettings();
      unsubscribeTheme();
    };
  }, []);

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>{children}</MotionConfig>
  );
};

export default ThemeProvider;
