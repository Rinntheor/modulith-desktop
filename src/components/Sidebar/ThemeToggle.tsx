// src/components/Sidebar/ThemeToggle.tsx
//
// 侧边栏底部的深/浅色快捷切换。
//
// ---------------------------------------------------------------------------
// 为什么切换要写回 appSettings，而不是直接调 theme 服务
//
// `services/theme.ts` 的 `setThemeMode` 只负责**应用到 document**，不管持久化
// —— 权威来源是后端 settings.json。如果这里图省事直接调它，会出现两个问题：
//
//   1. 设置没落盘：重启应用后主题回到原样；
//   2. **与设置页不同步**：设置页读的是 `appSettings` 缓存，它不知道
//      document 已经被改过，于是「设置 → 通用 → 外观」里显示的还是旧值。
//
// 因此这里统一走 `saveAppSettings({ theme })`：
//   appSettings 保存成功 → notify() → ThemeProvider 的订阅回调
//   → setThemeMode(新值) → document 更新，设置页也同时收到新值。
// 一条链路，两个消费者，不存在不同步的可能。
// ---------------------------------------------------------------------------
//
// 点击语义：在「深色 / 浅色」之间来回切。
//
// 如果当前是「跟随系统」，那么切换的对象是**当前实际呈现的那个颜色**的相反值
// （例如系统是深色、界面正显示深色，点一下就变浅色并固定下来）。这符合直觉：
// 按钮显示的是月亮（表示当前是深色），点它就变成太阳。

import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import { saveAppSettings, subscribeSettings } from '../../services/appSettings';
import { getResolvedTheme, subscribeTheme, type ResolvedTheme } from '../../services/theme';

const ThemeToggle: React.FC = () => {
  const [resolved, setResolved] = useState<ResolvedTheme>(() => getResolvedTheme());
  /** 切换进行中：避免连点导致重复写盘与视觉抖动 */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 主题变化（包括设置页改的、系统主题变化的）都要同步到这里的图标
  useEffect(() => subscribeTheme(() => setResolved(getResolvedTheme())), []);
  useEffect(() => subscribeSettings(() => setResolved(getResolvedTheme())), []);

  const isDark = resolved === 'dark';

  const handleToggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);

    // 目标是"当前呈现颜色的相反值"，而不是简单地在 dark/light 之间翻
    const next = getResolvedTheme() === 'dark' ? 'light' : 'dark';

    try {
      await saveAppSettings({ theme: next });
    } catch (err) {
      // 如实反馈：写盘失败时主题不会变，不能让按钮看起来"点了没反应"
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const label = isDark ? '切换到浅色模式' : '切换到深色模式';

  return (
    <div className="shrink-0">
      {/*
        按钮刻意不使用 `dark:` 变体。

        Tailwind v4 的 `dark:` 默认编译为 `@media (prefers-color-scheme: dark)`，
        而本项目的深色由 `:root.dark` 类驱动 —— 两者不是一回事。若这里写
        `dark:text-gray-300`，当用户在系统深色下**显式选择浅色**时，`:root` 没有
        `.dark` 类（dark-theme.css 不生效），但媒体查询仍然命中，浅色侧边栏里就会出现
        浅灰文字。深色取值由 dark-theme.css 对 `text-gray-600` / `hover:text-gray-900`
        的映射负责，这里只写浅色取值即可。
      */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={busy}
        title={label}
        aria-label={label}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
      >
        {/*
          图标交叉淡入淡出：太阳与月亮同时在场，靠 opacity/rotate 切换，
          避免两张图标各挂一个 AnimatePresence 造成高度跳动。
        */}
        <span className="relative w-4 h-4 shrink-0">
          <AnimatePresence initial={false} mode="wait">
            <motion.span
              key={isDark ? 'moon' : 'sun'}
              initial={{ opacity: 0, rotate: -60, scale: 0.7 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, rotate: 60, scale: 0.7 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="flex-1 text-left">{isDark ? '深色模式' : '浅色模式'}</span>
      </button>

      {error && (
        <p className="px-4 pb-2 text-[10px] text-red-500 leading-relaxed break-all">
          切换失败：{error}
        </p>
      )}
    </div>
  );
};

export default ThemeToggle;
