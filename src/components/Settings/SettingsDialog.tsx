// src/components/Settings/SettingsDialog.tsx
//
// 应用设置：通用 / 安全 / 插件 / 市场 / 关于。
// 「插件」分页直接复用插件管理页，「市场」分页复用插件市场页，
// 因此两者都不占用侧边栏格子；
// 「安全」分页承载访问授权（访问密钥、设备白名单、登录审计）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  SlidersHorizontal,
  ShieldCheck,
  Puzzle,
  Store,
  Info,
  AlertCircle,
  CheckCircle,
  FolderOpen,
  RotateCcw,
  ExternalLink,
  Sun,
  Moon,
  Monitor,
  Check,
  Heart,
  Globe,
  FileText,
  Bell,
  Archive,
  Settings2,
  Activity,
  AlarmClock,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import ModuleEmbed from '../ModuleEmbed';
import LoggingSettings from './LoggingSettings';
import NetworkSettings from './NetworkSettings';
import NotificationSettings from './NotificationSettings';
import PerformanceSettings from './PerformanceSettings';
import BackupSettings from './BackupSettings';
import SecuritySettings from './SecuritySettings';
import PluginSettingsSection from './PluginSettingsSection';
import ReminderSettings from './ReminderSettings';
import Toggle from './Toggle';
import UpdateChecker from './UpdateChecker';
import { getCatalogModules } from '../../services/moduleCatalog';
import { isTrayAvailable, setCloseToTray } from '../../services/desktopShell';
import { getHostVersion, getInstalledPlugins } from '../../services/pluginRuntime';
import { APP_INFO, APP_LINKS } from '../../config/appInfo';
import { ACCENT_THEMES, getAccentTheme } from '../../config/accentTheme';
import { BRAND_ICONS } from '../icons/BrandIcon';
import AppLogo from '../icons/AppLogo';
import type { ThemeMode } from '../../services/theme';
import {
  DEFAULT_APP_SETTINGS,
  getAppDataDir,
  getCachedSettings,
  resetAppSettings,
  saveAppSettings,
  subscribeSettings,
  type AppSettings,
} from '../../services/appSettings';
import { persistWindowStateNow, resyncTabsFromSettings } from '../../services/tabStore';

/**
 * 设置面板容器的类名。
 *
 * **抽成常量是为了它能被门禁检查**：这段类名决定了"面板是否会超出窗口"，
 * 而那是一个真实发生过的问题。写成内联字符串时，检查脚本只能靠正则去猜
 * 那一行长什么样；写成常量后，`check:settings-layout` 可以直接对它做几何断言。
 *
 * 约束（三条缺一不可）：
 *   1. `w-full` —— 占满遮罩内容盒（= 视口宽 − 48px，见遮罩上的 `p-6`）；
 *   2. 宽度上限是 `min(64rem, 100vw - 6rem)`。**两项都是必需的**：
 *      · `64rem` 给出"大屏上不要无限宽"的舒适上限；
 *      · `100vw - 6rem` 保证在任何窗口宽度下，面板两侧**至少各有 24px 空隙**
 *        （遮罩内边距 24px + 上限再收 24px）。
 *      只写 `max-w-5xl` 时，1024~1056 宽的窗口下那个上限不生效、`w-full` 顶满
 *      内容盒，两侧只剩遮罩内边距 —— 用户看到的正是那个"贴边"。
 *   3. `h-full max-h-[82vh]` —— 高度相对内容盒，且不超过视口的 82%。
 *      此前写的是 `h-[82vh]`，那是**视口**高度而不是内容盒高度，
 *      再叠加遮罩内边距就会顶到边界。
 */
export const SETTINGS_PANEL_CLASS =
  'w-full max-w-[min(64rem,calc(100vw-6rem))] h-full max-h-[82vh] bg-gray-50 rounded-2xl shadow-2xl flex overflow-hidden';

/**
 * 左侧导航栏的类名。同样抽成常量，供门禁断言"它在窄窗口下会收窄"。
 *
 * 侧栏此前是固定的 `w-52`（208px）。窗口一窄，它就把内容区挤到放不下表单，
 * 而侧栏自己并不需要那么宽。
 */
export const SETTINGS_NAV_CLASS =
  'w-14 md:w-44 xl:w-52 shrink-0 bg-white border-r border-gray-200 flex flex-col';

export type SettingsSectionId =
  | 'general'
  | 'notifications'
  | 'reminders'
  | 'network'
  | 'logs'
  | 'performance'
  | 'backup'
  | 'security'
  | 'plugins'
  | 'plugin-settings'
  | 'market'
  | 'about';

interface SectionDef {
  id: SettingsSectionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SECTIONS: SectionDef[] = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'notifications', label: '通知', icon: Bell },
  // 「提醒」与「通知」分开：通知页管"长什么样"，提醒页管"什么时候产生一条"，
  // 而后者的技术前提完全不同（它由后台进程计时，窗口关掉照样响）。
  { id: 'reminders', label: '提醒', icon: AlarmClock },
  { id: 'network', label: '网络', icon: Globe },
  { id: 'logs', label: '日志', icon: FileText },
  { id: 'performance', label: '性能', icon: Activity },
  { id: 'backup', label: '备份', icon: Archive },
  { id: 'security', label: '安全', icon: ShieldCheck },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'plugin-settings', label: '插件设置', icon: Settings2 },
  { id: 'market', label: '市场', icon: Store },
  { id: 'about', label: '关于', icon: Info },
];

/**
 * 开机自启动的状态。
 *
 * `supported` 为 false 时（非 Windows 平台）界面显示 `reason` 而不是自己编一句话；
 * 一个「显示为已关闭、实际什么都没做」的开关比不支持更糟。
 */
interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  reason: string | null;
}

// ============================================================
// 基础控件
// ============================================================

// Toggle 已抽到 ./Toggle.tsx：更新卡片也要用它，而它 import 这个文件
// 会形成循环依赖。见该文件头部说明。
const SettingRow: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ title, description, children }) => (
  <div className="flex items-start justify-between gap-6 py-3.5 border-b border-gray-100 last:border-0">
    <div className="min-w-0">
      <p className="text-sm font-medium text-gray-800">{title}</p>
      {description && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{description}</p>}
    </div>
    <div className="shrink-0 pt-0.5">{children}</div>
  </div>
);

const Card: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
    <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider pt-3">
      {title}
    </h3>
    {children}
  </section>
);

/** 主题三选一：浅色 / 深色 / 跟随系统 */
/** 主题三选一：浅色 / 深色 / 跟随系统 */
const THEME_OPTIONS: Array<{
  value: ThemeMode;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: 'light', label: '浅色', hint: '始终使用浅色界面', icon: Sun },
  { value: 'dark', label: '深色', hint: '始终使用深色界面', icon: Moon },
  { value: 'system', label: '跟随系统', hint: '随操作系统外观自动切换', icon: Monitor },
];

const ThemePicker: React.FC<{ value: ThemeMode; onChange: (next: ThemeMode) => void }> = ({
  value,
  onChange,
}) => (
  <div className="grid grid-cols-3 gap-2 pb-4 pt-1" role="radiogroup" aria-label="界面主题">
    {THEME_OPTIONS.map((option) => {
      const Icon = option.icon;
      const active = value === option.value;
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={active}
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={`flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-xs transition-colors ${
            active
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium'
              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          <Icon className="w-4 h-4" />
          {option.label}
        </button>
      );
    })}
  </div>
);

/**
 * 主题配色选择器。
 *
 * 色块直接用 `accentTheme.base`（品牌主色）绘制，因此新增配色无需在此改动。
 * 选中态用同色描边 + 勾号，而不是统一的品牌色描边 —— 后者在选中「红色」
 * 时会用一个完全不同的色相去描边，看起来像是选中了别的项。
 *
 * 关于「语义色与主题色可能撞色」的提示：红色主题下，红色既表示品牌又表示
 * 危险，会削弱语义色的警示作用。这是配色功能的固有取舍，在下方以说明文字
 * 告知用户，而不是悄悄限制可选配色。
 */
const AccentPicker: React.FC<{ value: string; onChange: (next: string) => void }> = ({
  value,
  onChange,
}) => {
  const current = getAccentTheme(value);
  return (
    <div className="pb-4 pt-1">
      <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="主题配色">
        {ACCENT_THEMES.map((theme) => {
          const active = theme.id === current.id;
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={theme.label}
              title={theme.label}
              onClick={() => onChange(theme.id)}
              className={`flex flex-col items-center gap-1.5 rounded-xl border px-1 py-2.5 text-[11px] transition-colors ${
                active
                  ? 'border-gray-300 bg-gray-50 text-gray-900 font-medium'
                  : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
              }`}
            >
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center shadow-sm"
                style={{ backgroundColor: theme.base }}
              >
                {active && <Check className="w-3.5 h-3.5 text-white" />}
              </span>
              {theme.label}
            </button>
          );
        })}
      </div>

      <p className="mt-2.5 text-[11px] text-gray-500 leading-relaxed">
        强调色会应用到按钮、选中态、链接与图标底色。
        <br />
        红、琥珀、绿属于语义色（错误 / 警告 / 成功），不随配色改变；
        因此选择相近色相（如红色）时，品牌色与警示色的区分会变弱。
      </p>
    </div>
  );
};

// ============================================================
// 对话框
// ============================================================

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** 打开时直接定位到某个分页（例如从授权界面跳「安全」） */
  initialSection?: SettingsSectionId;
  /** 通用设置变化后通知外部（例如需要重建 Provider 才能生效的项） */
  onSettingsChanged?: (settings: AppSettings) => void;
}

const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onClose,
  initialSection,
  onSettingsChanged,
}) => {
  const [section, setSection] = useState<SettingsSectionId>(initialSection ?? 'general');

  /**
   * 开机自启动的状态。
   *
   * **刻意不放进 `settings`**：它是注册表里的系统状态，用户可以在任务管理器的
   * 「启动」页里直接关掉它。把 `settings.json` 里的副本当成事实，界面就会显示一个
   * 位置错误的开关。因此这里单独向后端查询，且每次切换后都以返回值刷新。
   */
  const [autostart, setAutostart] = useState<AutostartStatus | null>(null);

  /**
   * 自启动是否已开启。
   *
   * 下面三项启动行为（静默 / 全屏 / 最大化）只在开启时可用：它们描述的是"被系统
   * 拉起时窗口怎么出现"，没有那次启动就无从谈起。
   */
  const autostartEnabled = autostart?.enabled ?? false;

  /**
   * 系统托盘是否可用。
   *
   * 与 `autostart` 同理，**刻意不放进 `settings`**：它描述的是"这个环境有没有
   * 托盘"，而那不是一份可以被保存的偏好。托盘装不上时后端会把「隐藏到托盘」
   * 强制回落成「直接退出」，因此界面必须知道这件事 ——
   * 否则它会显示一个"已开启"、但实际永远不会隐藏到任何地方的开关。
   */
  const [trayAvailable, setTrayAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    void isTrayAvailable().then(setTrayAvailable);
  }, []);

  const refreshAutostart = useCallback(async () => {
    try {
      setAutostart(await invoke<AutostartStatus>('get_autostart_status'));
    } catch (error) {
      console.warn('[Settings] 读取自启动状态失败:', error);
      setAutostart({ supported: false, enabled: false, reason: '读取自启动状态失败' });
    }
  }, []);

  useEffect(() => {
    void refreshAutostart();
  }, [refreshAutostart]);

  const toggleAutostart = useCallback(
    async (next: boolean) => {
      try {
        setAutostart(
          await invoke<AutostartStatus>('set_autostart_enabled', { enabled: next })
        );
      } catch (error) {
        console.error('[Settings] 设置自启动失败:', error);
        // 回读一次：让界面回到真实状态，而不是停在用户点过的位置
        await refreshAutostart();
      }
    },
    [refreshAutostart]
  );
  const [settings, setSettings] = useState<AppSettings>(getCachedSettings());
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [dataDir, setDataDir] = useState<string>('');
  const [openDirError, setOpenDirError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  /** 正在交给系统浏览器打开的链接 URL，用于给出即时反馈动画 */
  const [openingUrl, setOpeningUrl] = useState<string | null>(null);

  useEffect(() => subscribeSettings(() => setSettings(getCachedSettings())), []);

  // 每次打开时尊重调用方指定的分页（关闭后重新打开也能生效）
  useEffect(() => {
    if (open && initialSection) setSection(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    getAppDataDir()
      .then(setDataDir)
      .catch(() => setDataDir(''));
  }, [open]);

  const flash = useCallback((kind: 'ok' | 'error', text: string, ms = 3000) => {
    setFeedback({ kind, text });
    setTimeout(() => setFeedback(null), ms);
  }, []);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const next = await saveAppSettings(patch);
        onSettingsChanged?.(next);
      } catch (error) {
        flash('error', `保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [flash, onSettingsChanged]
  );

  const handleReset = useCallback(async () => {
    try {
      const next = await resetAppSettings();
      onSettingsChanged?.(next);
      // 标签状态也在这份设置里，重置后必须同步回来。
      // 让 tabStore 订阅 settings 自动接管是行不通的（乐观更新会形成回路），
      // 因此由这个明确的「外部改动点」显式通知它。
      resyncTabsFromSettings();
      flash('ok', '已恢复默认设置');
    } catch (error) {
      flash('error', `重置失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [flash, onSettingsChanged]);

  const handleOpenDataDir = useCallback(async () => {
    if (!dataDir) return;
    try {
      await openPath(dataDir);
      setOpenDirError(null);
    } catch (error) {
      setOpenDirError(error instanceof Error ? error.message : String(error));
    }
  }, [dataDir]);

  /**
   * 切换「关闭窗口时最小化到托盘」。
   *
   * 走两处是必要的，不是重复：
   *   1. `update()` 把设置写进 settings.json —— 那是唯一的持久化路径；
   *   2. `setCloseToTray()` 让**后端同步托盘右键菜单的勾选状态**。
   *
   * 少了第 2 步，用户会在设置页关掉它、再右键托盘发现它还勾着，而那个勾是错的
   * （行为已经跟着设置变了）。两处改的是同一个字段，因此不存在"两份状态"。
   *
   * 必须定义在 `update` 之后：`const` 声明有暂时性死区，提前引用会在运行期抛错。
   */
  const toggleCloseToTray = useCallback(
    async (next: boolean) => {
      await update({ closeToTray: next });
      try {
        await setCloseToTray(next);
      } catch (error) {
        // 设置已经存下去了，失败的只是菜单勾选同步。
        // 记一条警告即可 —— 真实行为已经跟着设置变了，用户看到的现象是
        // "托盘菜单里的勾没跟上"，而不是"这个开关没用"。
        console.warn('[Settings] 同步托盘菜单勾选状态失败:', error);
      }
    },
    [update]
  );

  /**
   * 打开外部链接。
   *
   * 用系统浏览器而不是在 WebView 内导航：WebView 内导航会直接把应用本体
   * 替换成网页，用户就回不来了。失败时如实显示原因，不做静默吞掉。
   *
   * `openingUrl` 在调用期间保持置位，让按钮显示「正在打开浏览器…」并播放
   * 掠过高光 —— 系统浏览器启动需要几百毫秒，没有反馈会让人以为点击没生效。
   * 无论成功还是失败都会清掉，不会留下一个永远转动的按钮。
   */
  const handleOpenLink = useCallback(async (url: string) => {
    setOpeningUrl(url);
    try {
      await openUrl(url);
      setLinkError(null);
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningUrl(null);
    }
  }, []);

  // 可选作默认启动项的模块（排除不在导航中展示的模块）
  const selectableModules = useMemo(
    () => getCatalogModules().filter((m) => m.visible !== false && !m.disabled),
    // 对话框每次打开时重算即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open]
  );

  const pluginCount = getInstalledPlugins().length;
  const enabledCount = getInstalledPlugins().filter((p) => p.enabled).length;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 遮罩同时充当居中容器：面板用 flex 居中，宽高都相对遮罩「内容盒」
              （= 视口宽 − 32px）计算。

              尺寸的写法经过一次修正，值得说明：

              · 宽度：`w-full`（占满遮罩内容盒 = 视口宽 − 32px），上限取
                `min(64rem, 100vw - 2rem)`。只写 `max-w-5xl`（1024px）时，
                默认窗口宽度（1100px）下上限不生效，面板会占满 1068px ——
                那不是「超出窗口」，但确实几乎贴满整窗。上限同时受视口约束，
                两侧才会始终留出边距。
              · 高度：`h-full max-h-[82vh]`。此前是 `h-[82vh]`，而 `82vh` 是
                **视口高度**、不是遮罩内容盒的高度，再加上 `p-4` 的 32px，
                矮窗口下面板会顶到遮罩边界。`h-full` 让高度相对内容盒、
                `max-h-[82vh]` 给出舒适上限，两者取小 —— 面板永远不会超出。

              面板必须留在 AnimatePresence 的「直接子节点」位置上，否则退出动画会失效，
              因此不要在这里再套一层普通 div 做居中。 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-60 flex items-center justify-center p-6 bg-gray-900/40 backdrop-blur-[2px]"
          >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 36 }}
            className={SETTINGS_PANEL_CLASS}
          >
            {/* 左侧导航。

                宽度在小窗口下收窄（`w-44 xl:w-52`），而在更窄时进一步压到 3.5rem
                并只留图标 —— 侧栏是**固定的 208px**，窗口一窄它就把内容区挤到
                放不下表单（12 个分页里最长的一行是「已挂载标签」那一组说明文字），
                而侧栏自己并不需要那么宽。

                导航本身可滚动（`overflow-y-auto`）：分页有 12 个，矮窗口下
                它比内容区更早放不下。 */}
            <aside className={SETTINGS_NAV_CLASS}>
              <div className="px-3 md:px-5 py-4 border-b border-gray-100">
                <h2 className="font-semibold text-gray-900 hidden md:block">设置</h2>
                <p className="text-[11px] text-gray-500 mt-0.5 hidden md:block">
                  Modulith Desktop v{getHostVersion()}
                </p>
                {/* 窄侧栏时用图标占位，避免那一栏空成一条竖线 */}
                <Settings2 className="w-4 h-4 mx-auto text-gray-400 md:hidden" />
              </div>

              <nav className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-0.5">
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSection(s.id)}
                    title={s.label}
                    aria-label={s.label}
                    className={`w-full flex items-center justify-center md:justify-start gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors ${
                      section === s.id
                        ? 'bg-indigo-50 text-indigo-700 font-medium'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <s.icon className="w-4 h-4 shrink-0" />
                    <span className="hidden md:inline truncate">{s.label}</span>
                  </button>
                ))}
              </nav>

              <div className="p-3 border-t border-gray-100">
                <button
                  onClick={handleReset}
                  title="恢复默认设置"
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs text-gray-500 rounded-lg hover:bg-gray-50 hover:text-gray-700 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden md:inline">恢复默认设置</span>
                </button>
              </div>
            </aside>

            {/* 右侧内容 */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="shrink-0 flex items-center justify-between gap-3 px-4 lg:px-6 py-4 border-b border-gray-200 bg-white">
                <h3 className="font-semibold text-gray-900 truncate">
                  {SECTIONS.find((s) => s.id === section)?.label}
                </h3>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                  aria-label="关闭"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <AnimatePresence>
                {feedback && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className={`shrink-0 mx-4 lg:mx-6 mt-4 px-3 py-2 rounded-lg flex items-center gap-2 text-xs border ${
                      feedback.kind === 'error'
                        ? 'bg-red-50 border-red-200 text-red-700'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    }`}
                  >
                    {feedback.kind === 'error' ? (
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="break-all">{feedback.text}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* `overflow-x-hidden` 是刻意的：内容宽了应当**换行或收起**，
                  而不是横向滚动条。设置页里横向滚动几乎不可用 ——
                  用户看不到右边那一半，也不会想到去拖它。 */}
              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                {section === 'general' && (
                  <div className="px-4 lg:px-6 py-5">
                    <Card title="外观">
                      <ThemePicker
                        value={settings.theme}
                        onChange={(next) => update({ theme: next })}
                      />

                      <div className="border-t border-gray-100 pt-3">
                        <p className="text-sm font-medium text-gray-800">主题配色</p>
                        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                          自定义界面的强调色，与深浅模式相互独立
                        </p>
                        <AccentPicker
                          value={settings.accent}
                          onChange={(next) => update({ accent: next })}
                        />
                      </div>

                      <SettingRow
                        title="关闭界面动画"
                        description="停用全部过渡与动效。低性能设备上更流畅，也可用于减少视觉干扰"
                      >
                        <Toggle
                          checked={settings.reduceMotion}
                          onChange={(next) => update({ reduceMotion: next })}
                        />
                      </SettingRow>

                      <SettingRow
                        title="性能模式"
                        description="在关闭动画的基础上，再停用装饰性大半径模糊、合成层提升提示与持续循环的粒子背景，并关闭毛玻璃。它们不表现为动画，而是让每一帧都要重新合成，因此「关了动画还是卡」通常出在这里"
                      >
                        <Toggle
                          checked={settings.performanceMode}
                          onChange={(next) => update({ performanceMode: next })}
                        />
                      </SettingRow>

                      <SettingRow
                        title="毛玻璃效果"
                        description="对话框、菜单、抽屉这些浮层用背景模糊做出景深。窗口亚层（标题栏、标签栏、侧边栏）不使用它 —— 它们背后永远是应用的纯色底，模糊没有视觉效果却要每帧重新合成，因此已永久关闭，不需要在这里开关"
                      >
                        <Toggle
                          checked={settings.glassEffect}
                          onChange={(next) => update({ glassEffect: next })}
                        />
                      </SettingRow>

                      {settings.performanceMode && (
                        <p className="pb-4 -mt-1 text-[11px] text-gray-500 leading-relaxed">
                          性能模式已包含「关闭界面动画」与「毛玻璃效果」的效果，三者不需要同时打开。
                          代价是界面不再有毛玻璃层次与粒子背景 —— 看起来会更朴素。
                        </p>
                      )}
                    </Card>

                    <Card title="窗口与托盘">
                      {/*
                        托盘不可用时这一段必须**如实说明**，而不是显示一个假开关。
                        后端在那条路径上已经把「隐藏到托盘」回落成「直接退出」，
                        因此界面读到的值本来就是回落后的 —— 这里只负责解释原因。
                      */}
                      {trayAvailable === false ? (
                        <p className="py-3 text-xs text-gray-500 leading-relaxed">
                          当前环境没有可用的系统托盘，因此关闭窗口会直接退出应用。
                          托盘在部分环境下装不上（例如没有桌面会话，或被系统策略禁用）——
                          隐藏到一个不存在的托盘会让窗口再也叫不回来，所以这里不做那个选择。
                        </p>
                      ) : (
                        <SettingRow
                          title="关闭窗口时最小化到托盘"
                          description="关闭后应用继续在后台运行，托盘图标可以随时把窗口叫回来。关掉它则关闭窗口即退出应用。托盘图标的右键菜单里也能改这一项"
                        >
                          <Toggle
                            checked={settings.closeToTray}
                            onChange={(next) => void toggleCloseToTray(next)}
                          />
                        </SettingRow>
                      )}

                      {trayAvailable !== false && (
                        <p className="pb-4 text-[11px] text-gray-500 leading-relaxed">
                          隐藏到托盘之后，退出应用要从托盘图标的右键菜单里选「退出」——
                          单击托盘图标只是把窗口叫回来。
                        </p>
                      )}
                    </Card>

                    <Card title="启动行为">
                      <SettingRow
                        title="默认启动模块"
                        description="应用启动后自动打开哪个模块"
                      >
                        <select
                          value={settings.defaultModule ?? ''}
                          onChange={(e) => update({ defaultModule: e.target.value || null })}
                          disabled={settings.restoreLastModule}
                          className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:opacity-50 min-w-40"
                        >
                          <option value="">
                            内置默认（{DEFAULT_APP_SETTINGS.defaultModule ?? '仪表盘'}）
                          </option>
                          {selectableModules.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </SettingRow>

                      <SettingRow
                        title="恢复上次打开的模块与标签页"
                        description="启动时恢复上次打开的标签页、当前标签与分屏布局，并回到上次停留的模块。关闭后每次启动都从「默认启动模块」开始，运行期间的标签变化也不再写入设置"
                      >
                        <Toggle
                          checked={settings.restoreLastModule}
                          onChange={(next) => {
                            update({ restoreLastModule: next });
                            // 刚打开时立刻把**当前**窗口状态记下来。否则下次启动恢复的
                            // 是关闭开关之前的那次布局 —— 用户记得的却是"我刚刚开着
                            // 这几个标签"。见 tabStore 的 persistWindowStateNow。
                            if (next) persistWindowStateNow();
                          }}
                        />
                      </SettingRow>

                      <SettingRow
                        title="开机自启动"
                        description={
                          autostart && !autostart.supported
                            ? autostart.reason ?? '当前平台不支持这个开关'
                            : '随系统启动自动运行。默认关闭 —— 应用不会在你没有选择的情况下把自己加进开机项'
                        }
                      >
                        <Toggle
                          checked={autostart?.enabled ?? false}
                          disabled={!autostart?.supported}
                          onChange={(next) => void toggleAutostart(next)}
                        />
                      </SettingRow>

                      {/* 这三项只有在**自启动开启**时才有意义：它们描述的是"被系统
                          拉起时窗口怎么出现"，关掉自启动就没有那次启动。因此自启动
                          关闭时它们显示为关且不可选 —— 而不是让用户先把它们打开、
                          再发现什么也没发生。 */}
                      {autostart?.supported && (
                        <>
                          <SettingRow
                            title="静默启动"
                            description="开机自启动拉起时：窗口最小化，不抢占前台。本应用没有托盘图标，因此它仍会出现在任务栏里 —— 这一点没有更好的做法，所以如实说明"
                          >
                            <Toggle
                              checked={autostartEnabled && settings.autoStartSilent}
                              disabled={!autostartEnabled}
                              onChange={(next) => update({ autoStartSilent: next })}
                            />
                          </SettingRow>

                          <SettingRow
                            title="启动时全屏"
                            description="开机自启动拉起时直接进入全屏。与「静默启动」同时开启时以静默为准 —— 窗口没到前台，全屏没有意义"
                          >
                            <Toggle
                              checked={autostartEnabled && settings.autoStartFullscreen}
                              disabled={!autostartEnabled}
                              onChange={(next) => update({ autoStartFullscreen: next })}
                            />
                          </SettingRow>

                          <SettingRow
                            title="启动时最大化"
                            description="开机自启动拉起时最大化窗口。与「启动时全屏」同时开启时以全屏为准 —— 两者都想尽可能大，而全屏更大"
                          >
                            <Toggle
                              checked={autostartEnabled && settings.autoStartMaximized}
                              disabled={!autostartEnabled}
                              onChange={(next) => update({ autoStartMaximized: next })}
                            />
                          </SettingRow>
                        </>
                      )}
                    </Card>

                    <Card title="侧边栏">
                      <SettingRow
                        title="启动时折叠侧边栏"
                        description="下次启动时侧边栏默认收起（重新打开设置不会立即改变当前状态）"
                      >
                        <Toggle
                          checked={settings.sidebarCollapsed}
                          onChange={(next) => update({ sidebarCollapsed: next })}
                        />
                      </SettingRow>
                    </Card>

                    <Card title="插件">
                      <SettingRow
                        title="在后台加载插件"
                        description="插件不再阻塞启动：先让应用可用，再在后台加载。加载完成的插件会实时出现在侧边栏"
                      >
                        <Toggle
                          checked={settings.deferPluginLoading}
                          onChange={(next) => update({ deferPluginLoading: next })}
                        />
                      </SettingRow>

                      <SettingRow
                        title="单个插件加载超时"
                        description="超过该时长仍未加载完的插件会被标记为失败并跳过，避免拖累其余插件。JS 无法中断插件内的同步死循环，此项只用于隔离影响范围"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={500}
                            max={60000}
                            step={500}
                            value={settings.pluginLoadTimeoutMs}
                            onChange={(e) => {
                              const next = Number(e.target.value);
                              // 只在合法区间内提交，避免把一个会被后端拒绝的
                              // 中间值（例如清空输入框产生的 0）写进设置
                              if (Number.isFinite(next) && next >= 500 && next <= 60000) {
                                void update({ pluginLoadTimeoutMs: next });
                              }
                            }}
                            className="w-24 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 text-right font-mono focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                          />
                          <span className="text-xs text-gray-500">毫秒</span>
                        </div>
                      </SettingRow>

                      <SettingRow
                        title="卸载插件前二次确认"
                        description="关闭后点击卸载会直接删除插件文件与数据"
                      >
                        <Toggle
                          checked={settings.confirmBeforeUninstall}
                          onChange={(next) => update({ confirmBeforeUninstall: next })}
                        />
                      </SettingRow>
                    </Card>
                  </div>
                )}

                {section === 'network' && (
                  <NetworkSettings settings={settings} onUpdate={update} />
                )}

                {section === 'notifications' && (
                  <NotificationSettings settings={settings} onUpdate={update} />
                )}
                {section === 'reminders' && <ReminderSettings />}
                {section === 'logs' && <LoggingSettings settings={settings} onUpdate={update} />}
                {section === 'performance' && <PerformanceSettings />}
                {section === 'backup' && <BackupSettings />}

                {section === 'security' && <SecuritySettings />}

                {section === 'plugins' && (
                  <div className="pb-4">
                    {/* 经 ModuleEmbed 动态导入：外壳不静态依赖业务模块，
                        因此删除 src/modules/plugins/ 不会让外壳编译失败。 */}
                    <ModuleEmbed moduleId="plugins" />
                  </div>
                )}

                {section === 'plugin-settings' && (
                  <div className="px-4 lg:px-6 py-5">
                    {/* 内容是**清单声明**驱动渲染的，不执行任何插件代码 ——
                        这与上面那一格（插件管理页要读运行时状态）是两回事，
                        因此它是普通组件而不是 ModuleEmbed。 */}
                    <PluginSettingsSection onOpenPlugins={() => setSection('plugins')} />
                  </div>
                )}

                {section === 'market' && (
                  <div className="pb-4">
                    {/* 同上：市场页也走动态导入，删掉 src/modules/pluginMarket/
                        只会让这一格空白，不会让外壳编译失败。 */}
                    <ModuleEmbed moduleId="pluginMarket" />
                  </div>
                )}

                {section === 'about' && (
                  <div className="px-4 lg:px-6 py-5">
                    {/* 软件更新。放在身份卡之前：它是这一页唯一"可以操作"的东西，
                        其余部分都是只读信息。 */}
                    <UpdateChecker onOpenNetwork={() => setSection('network')} onOpenLogs={() => setSection('logs')} />

                    {/* 身份卡：应用名 + 作者 + 外链 */}
                    <section className="bg-white rounded-xl border border-gray-200 px-5 py-5 mb-5">
                      <div className="flex items-start gap-4">
                        {/*
                          这里原先是一个渐变方块 + Sparkles 图标 —— 那是随手
                          占位的东西，不是应用标识。现在用真正的 AppLogo，
                          并且不带底板：卡片本身已经是浅色背景，再叠一层渐变
                          只会显得像贴上去的按钮。方块颜色跟随主题。
                        */}
                        <AppLogo className="w-11 h-11 shrink-0 text-gray-900" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-base font-semibold text-gray-900">
                              {APP_INFO.name}
                            </h2>
                            <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-gray-100 text-gray-600">
                              v{getHostVersion()}
                            </span>
                            <span className="px-1.5 py-0.5 text-[10px] rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">
                              {APP_INFO.license}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
                            {APP_INFO.tagline}
                          </p>
                          <p className="mt-2 text-xs text-gray-600 flex items-center gap-1.5">
                            <Heart className="w-3 h-3 text-rose-500" />
                            作者
                            <span className="font-medium text-gray-800">{APP_INFO.author}</span>
                          </p>
                        </div>
                      </div>

                      {/* 外链：交给系统浏览器打开，不在 WebView 内导航 */}
                      <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {APP_LINKS.map((link, index) => {
                          const Icon = BRAND_ICONS[link.icon] ?? BRAND_ICONS.github;
                          const opening = openingUrl === link.url;
                          return (
                            <motion.button
                              key={link.url}
                              type="button"
                              onClick={() => handleOpenLink(link.url)}
                              title={link.url}
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: index * 0.06, duration: 0.2 }}
                              whileHover={{ y: -2, scale: 1.015 }}
                              whileTap={{ scale: 0.98 }}
                              className={`group relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-gray-200 bg-white transition-colors text-left overflow-hidden ${link.accent.borderHover}`}
                            >
                              {/* 悬停/点击时从左侧掠过的高光，给"正在打开"一个反馈 */}
                              <motion.span
                                aria-hidden="true"
                                initial={false}
                                animate={
                                  opening
                                    ? { x: ['-120%', '220%'], opacity: [0, 0.55, 0] }
                                    : { x: '-120%', opacity: 0 }
                                }
                                transition={
                                  opening
                                    ? { duration: 0.7, ease: 'easeInOut', repeat: Infinity }
                                    : { duration: 0.25 }
                                }
                                className="pointer-events-none absolute inset-y-0 w-1/3 bg-linear-to-r from-transparent via-white/70 to-transparent"
                              />

                              <span
                                className={`relative w-8 h-8 shrink-0 rounded-lg bg-gray-100 flex items-center justify-center transition-colors ${link.accent.chipHover}`}
                              >
                                <motion.span
                                  animate={opening ? { rotate: [0, -8, 8, 0] } : { rotate: 0 }}
                                  transition={
                                    opening
                                      ? { duration: 0.6, repeat: Infinity, ease: 'easeInOut' }
                                      : { duration: 0.2 }
                                  }
                                  className={`flex items-center justify-center text-gray-600 transition-colors ${link.accent.iconHover}`}
                                >
                                  <Icon className="w-[18px] h-[18px]" />
                                </motion.span>
                              </span>

                              <span className="relative min-w-0 flex-1">
                                <span className="block text-xs font-medium text-gray-800">
                                  {link.label}
                                </span>
                                <span className="block text-[10px] text-gray-400 font-mono truncate">
                                  {opening ? '正在打开浏览器…' : link.handle}
                                </span>
                              </span>

                              <motion.span
                                animate={opening ? { x: 3, y: -3, opacity: 1 } : { x: 0, y: 0 }}
                                transition={{ duration: 0.2 }}
                                className="relative shrink-0 text-gray-300 group-hover:text-indigo-400 transition-colors"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </motion.span>
                            </motion.button>
                          );
                        })}
                      </div>
                      {linkError && (
                        <p className="mt-2 text-[11px] text-red-600">
                          无法打开链接：{linkError}
                        </p>
                      )}
                    </section>

                    <Card title="技术栈">
                      <SettingRow title="前端" description="React + TypeScript + Vite + Tailwind">
                        <span className="text-xs text-gray-500">React 19 / TS 5.8</span>
                      </SettingRow>
                      <SettingRow title="后端" description="Tauri 2 + Rust">
                        <span className="text-xs text-gray-500">Tauri 2</span>
                      </SettingRow>
                    </Card>

                    <Card title="插件">
                      <SettingRow title="已安装插件" description="包含已禁用但未卸载的插件">
                        <span className="text-sm text-gray-600">
                          {enabledCount} 启用 / {pluginCount} 已安装
                        </span>
                      </SettingRow>
                      <SettingRow
                        title="插件与数据目录"
                        description="插件的安装文件、注册表与独立存储都在这里"
                      >
                        <div className="flex items-center gap-2">
                          <code className="text-[11px] font-mono text-gray-500 max-w-56 truncate">
                            {dataDir || '（读取中…）'}
                          </code>
                          <button
                            onClick={handleOpenDataDir}
                            disabled={!dataDir}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                            打开
                          </button>
                        </div>
                      </SettingRow>
                      {openDirError && (
                        <p className="text-[11px] text-red-600 pb-3">无法打开目录：{openDirError}</p>
                      )}
                    </Card>

                    <p className="text-[11px] text-gray-400 leading-relaxed">
                      {APP_INFO.name} 采用模块化架构：安装第三方插件即可扩展功能，无需重新构建应用。
                      <br />© {APP_INFO.copyrightFrom}–{new Date().getFullYear()} {APP_INFO.author} ·
                      以 {APP_INFO.license} 许可发布。
                    </p>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default SettingsDialog;
