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
} from 'lucide-react';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import ModuleEmbed from '../ModuleEmbed';
import LoggingSettings from './LoggingSettings';
import NetworkSettings from './NetworkSettings';
import SecuritySettings from './SecuritySettings';
import Toggle from './Toggle';
import UpdateChecker from './UpdateChecker';
import { getCatalogModules } from '../../services/moduleCatalog';
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
import { resyncTabsFromSettings } from '../../services/tabStore';

export type SettingsSectionId =
  | 'general'
  | 'network'
  | 'logs'
  | 'security'
  | 'plugins'
  | 'market'
  | 'about';

interface SectionDef {
  id: SettingsSectionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SECTIONS: SectionDef[] = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'network', label: '网络', icon: Globe },
  { id: 'logs', label: '日志', icon: FileText },
  { id: 'security', label: '安全', icon: ShieldCheck },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'market', label: '市场', icon: Store },
  { id: 'about', label: '关于', icon: Info },
];

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
              （= 视口宽 − 32px）计算，所以永远不会等于整窗宽度。
              原来面板是 `w-full max-w-5xl`，max-w-5xl = 1024px 大于默认窗口宽度
              1000px（见 tauri.conf.json），于是 w-full 生效、面板被撑满整窗——
              非全屏时贴着两边，看起来就是横向拉伸；最大化后 1024px 上限才生效，
              所以全屏反而正常。
              面板必须留在 AnimatePresence 的「直接子节点」位置上，否则退出动画会失效，
              因此不要在这里再套一层普通 div 做居中。 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-[2px]"
          >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 36 }}
            className="w-full max-w-5xl max-h-full h-[82vh] bg-gray-50 rounded-2xl shadow-2xl flex overflow-hidden"
          >
            {/* 左侧导航 */}
            <aside className="w-52 shrink-0 bg-white border-r border-gray-200 flex flex-col">
              <div className="px-5 py-4 border-b border-gray-100">
                <h2 className="font-semibold text-gray-900">设置</h2>
                <p className="text-[11px] text-gray-500 mt-0.5">Modulith Desktop v{getHostVersion()}</p>
              </div>

              <nav className="flex-1 p-2 space-y-0.5">
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSection(s.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors ${
                      section === s.id
                        ? 'bg-indigo-50 text-indigo-700 font-medium'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <s.icon className="w-4 h-4 shrink-0" />
                    {s.label}
                  </button>
                ))}
              </nav>

              <div className="p-3 border-t border-gray-100">
                <button
                  onClick={handleReset}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs text-gray-500 rounded-lg hover:bg-gray-50 hover:text-gray-700 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  恢复默认设置
                </button>
              </div>
            </aside>

            {/* 右侧内容 */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-white">
                <h3 className="font-semibold text-gray-900">
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
                    className={`shrink-0 mx-6 mt-4 px-3 py-2 rounded-lg flex items-center gap-2 text-xs border ${
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

              <div className="flex-1 overflow-y-auto custom-scrollbar">
                {section === 'general' && (
                  <div className="px-6 py-5">
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
                        description="在关闭动画的基础上，再停用毛玻璃（标题栏、标签栏、侧边栏各有一层常驻模糊）、装饰性大半径模糊与持续循环的粒子背景。它们不表现为动画，而是让每一帧都要重新合成，因此「关了动画还是卡」通常出在这里"
                      >
                        <Toggle
                          checked={settings.performanceMode}
                          onChange={(next) => update({ performanceMode: next })}
                        />
                      </SettingRow>

                      {settings.performanceMode && (
                        <p className="pb-4 -mt-1 text-[11px] text-gray-500 leading-relaxed">
                          性能模式已包含「关闭界面动画」的效果，两者不需要同时打开。
                          代价是界面不再有毛玻璃层次与粒子背景 —— 看起来会更朴素。
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
                        title="恢复上次打开的模块"
                        description="开启后忽略「默认启动模块」，直接回到上次停留的位置"
                      >
                        <Toggle
                          checked={settings.restoreLastModule}
                          onChange={(next) => update({ restoreLastModule: next })}
                        />
                      </SettingRow>
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

                {section === 'logs' && <LoggingSettings settings={settings} onUpdate={update} />}

                {section === 'security' && <SecuritySettings />}

                {section === 'plugins' && (
                  <div className="pb-4">
                    {/* 经 ModuleEmbed 动态导入：外壳不静态依赖业务模块，
                        因此删除 src/modules/plugins/ 不会让外壳编译失败。 */}
                    <ModuleEmbed moduleId="plugins" />
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
                  <div className="px-6 py-5">
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
