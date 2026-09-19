// src/services/appSettings.ts
//
// 应用全局设置的前端封装。
// 后端：src-tauri/src/modules/settings（get_app_settings / update_app_settings /
// reset_app_settings / get_app_data_dir）。

import { invoke } from '@tauri-apps/api/core';
import { isNetworkMode, normalizeProxyBase, type NetworkMode } from '../utils/networkSettings';
import { isThemeMode, type ThemeMode } from './theme';

export interface AppSettings {
  /** 启动后默认打开的模块 ID（null = 内置默认 dashboard） */
  defaultModule: string | null;
  /** 启动时侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 卸载插件前是否二次确认 */
  confirmBeforeUninstall: boolean;
  /** 启动时恢复上次打开的模块（优先于 defaultModule） */
  restoreLastModule: boolean;
  /** 上次打开的模块，由应用自动写入 */
  lastModule: string | null;
  /** 界面主题：light / dark / system */
  theme: ThemeMode;
  /** 关闭界面动画（无障碍 / 低性能设备） */
  reduceMotion: boolean;
  /** 插件是否在后台加载（不阻塞进入应用） */
  deferPluginLoading: boolean;
  /** 单个插件加载的超时时间（毫秒） */
  pluginLoadTimeoutMs: number;
  /**
   * 主题配色 id（强调色），与 `theme`（深/浅）正交。
   *
   * 取值由 `src/config/accentTheme.ts` 注册。后端只校验格式、不校验是否为
   * 已知配色，因此这里也不做强约束 —— 未知值由 `getAccentTheme()` 回退。
   */
  accent: string;
  /**
   * 打开的模块标签页（按显示顺序）。
   *
   * 与 `lastModule` 同属界面状态：它们一起描述「下次启动恢复到什么样子」。
   * 后端只校验数量上限与 ID 格式，**不校验模块是否存在** —— 模块清单一部分
   * 来自构建期生成的内建注册表、一部分来自运行期注册的插件，后端复制一份
   * 必然漂移。失效的标签由 `tabStore` 在目录同步时对账剔除。
   */
  openTabs: string[];
  /** 当前激活的标签页；不在 `openTabs` 中时由 `tabStore` 丢弃该值 */
  activeTab: string | null;
  /**
   * 是否显示二级标题栏（标签栏）。关掉之后应用只剩标题栏 + 模块内容，
   * 用于「沉浸」体验。默认 `true`。
   */
  tabBarVisible: boolean;
  /**
   * 启动时是否自动检查应用更新。
   *
   * 默认 `true`：这是「有新版本」能被用户发现的唯一途径。检查只是向 GitHub 的
   * release 地址发一次 GET，不携带任何本机信息；用户可以关掉。
   */
  autoCheckUpdates: boolean;
  /**
   * 上次**得到确定结论**的自动检查时间（RFC3339），由应用自动写入。
   *
   * 只记录拿到结论的时刻，不记录「尝试过」—— 检查因断网失败时留空，下次启动
   * 会重试。节流窗口见 `src/utils/updateCheck.ts`。
   */
  lastUpdateCheckAt: string | null;
  /**
   * 网络访问方式：`direct`（直连 GitHub）/ `proxy`（经由下载源）。
   *
   * 与 `githubProxy` 是一对：**两者同时满足**才真的走代理。因此切回直连不会
   * 丢掉已经填好的地址，用户可以来回切换比较速度。
   *
   * 生效范围是插件市场（索引、签名、README、图标、`.lcp` 包）与应用更新
   * （清单地址、安装包地址）两条链路。
   */
  networkMode: NetworkMode;
  /**
   * 下载源根地址（例如 `https://gh-proxy.org`）。
   *
   * 语义是**前缀**：原始地址会被整条接在它后面
   * （`<你的地址>/https://github.com/...`）。空串表示还没填。
   *
   * 校验规则见 `src/utils/networkSettings.ts`（与后端 `settings/network.rs` 一致）。
   */
  githubProxy: string;
  /**
   * 是否把运行日志实时写入文件。
   *
   * 关闭后 release 版不再写任何运行日志（调试构建仍然输出到 stderr）。
   * **不影响崩溃记录** —— 那是另一个开关。
   */
  fileLoggingEnabled: boolean;
  /**
   * 是否把崩溃写入单独的崩溃日志文件。
   *
   * 与 `fileLoggingEnabled` 相互独立：关掉实时记录正是为了少写磁盘，
   * 而崩溃是低频事件，两者的取舍不同。
   */
  crashLoggingEnabled: boolean;
}

/**
 * 同时打开的标签页数量上限（与后端 `settings.rs` 的 `MAX_OPEN_TABS` 必须一致）。
 *
 * 每个打开的标签都会被挂载保活，因此这个上限实际约束的是常驻的模块实例数。
 * 达到上限后**拒绝再开新标签并提示**，而不是悄悄淘汰已打开的标签 ——
 * 静默关掉用户自己打开的标签是更糟的行为。
 */
export const MAX_OPEN_TABS = 12;

/**
 * 插件加载超时的允许区间。
 *
 * **必须与后端 `settings.rs` 的校验区间一致。** 后端负责拒绝非法写入，这里的
 * 常量负责不让非法值进入运行时 —— 手工改坏的 `settings.json` 会绕过前端校验
 * 直接被读取，只靠后端校验挡不住它。
 */
export const MIN_PLUGIN_LOAD_TIMEOUT_MS = 500;
export const MAX_PLUGIN_LOAD_TIMEOUT_MS = 60000;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultModule: null,
  sidebarCollapsed: false,
  confirmBeforeUninstall: true,
  restoreLastModule: false,
  lastModule: null,
  // 与后端 settings.rs 的 default_theme() 保持一致；测试会锁定这一致性
  theme: 'system',
  reduceMotion: false,
  // 与后端 default_defer_plugin_loading() / default_plugin_load_timeout_ms() 一致
  deferPluginLoading: true,
  pluginLoadTimeoutMs: 5000,
  // 与后端 default_accent() 及 config/accentTheme.ts 的 DEFAULT_ACCENT_ID 一致
  accent: 'indigo',
  // 首次启动不该凭空打开任何标签
  openTabs: [],
  activeTab: null,
  // 与后端 default_tab_bar_visible() 一致：隐藏是用户主动选择，不是默认体验
  tabBarVisible: true,
  // 与后端 default_auto_check_updates() 一致
  autoCheckUpdates: true,
  // 首次启动必然要查一次：没有时间戳意味着"从没查过"
  lastUpdateCheckAt: null,
  // 与后端 default_network_mode() / network.rs 的 NETWORK_MODE_DIRECT 一致。
  // 默认直连：一个默认打开的第三方加速源会把"装什么插件"交给我们无法控制的中间人。
  networkMode: 'direct',
  // 与后端 default_github_proxy() 一致：还没填
  githubProxy: '',
  // 与后端 default_file_logging_enabled() 一致：日志默认开着。
  // 用户不会为了排查问题提前打开它，默认关闭等于默认没有证据。
  fileLoggingEnabled: true,
  // 与后端 default_crash_logging_enabled() 一致
  crashLoggingEnabled: true,
};

let cache: AppSettings = { ...DEFAULT_APP_SETTINGS };
let loaded = false;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[appSettings] 订阅者执行出错:', error);
    }
  });
}

function normalize(raw: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    defaultModule: raw?.defaultModule ?? DEFAULT_APP_SETTINGS.defaultModule,
    sidebarCollapsed: raw?.sidebarCollapsed ?? DEFAULT_APP_SETTINGS.sidebarCollapsed,
    confirmBeforeUninstall:
      raw?.confirmBeforeUninstall ?? DEFAULT_APP_SETTINGS.confirmBeforeUninstall,
    restoreLastModule: raw?.restoreLastModule ?? DEFAULT_APP_SETTINGS.restoreLastModule,
    lastModule: raw?.lastModule ?? DEFAULT_APP_SETTINGS.lastModule,
    // 后端字段可能被手工改成非法值；非法时回落到 system 而不是把坏值透传给界面
    theme: isThemeMode(raw?.theme) ? raw.theme : DEFAULT_APP_SETTINGS.theme,
    reduceMotion: raw?.reduceMotion ?? DEFAULT_APP_SETTINGS.reduceMotion,
    deferPluginLoading:
      raw?.deferPluginLoading ?? DEFAULT_APP_SETTINGS.deferPluginLoading,
    // 后端会做区间校验；这里再兜一层，避免手工改坏文件导致超时为 0（= 立即超时）
    // 或过大（会让一个坏插件把整个加载流程卡住很久）。
    //
    // 上下界必须与后端 settings.rs 的校验区间 [500, 60000] 一致：
    // 此前这里只有下界，手工改坏的 settings.json 可以把超大值透传给 setTimeout。
    pluginLoadTimeoutMs: clampPluginTimeout(raw?.pluginLoadTimeoutMs),
    // 未知配色 id 不在这里纠正：accentTheme 的 getAccentTheme() 会回退到默认值，
    // 且保留原值可以避免「用户手工改了 settings.json，被静默改回」
    accent: typeof raw?.accent === 'string' && raw.accent ? raw.accent : DEFAULT_APP_SETTINGS.accent,
    // 标签页：只保留字符串项并去重，同时夹到上限之内。
    //
    // 去重是必要的：重复的标签 ID 会让 React 的 key 冲突，表现为其中一个标签
    // 永远无法激活。截断而不是丢弃全部，是为了在一份被手工改坏的设置里尽量
    // 保住用户已经打开的东西。
    openTabs: normalizeOpenTabs(raw?.openTabs),
    activeTab: typeof raw?.activeTab === 'string' && raw.activeTab ? raw.activeTab : null,
    // 只有显式写成 false 才隐藏；缺失或非法值都回到「显示」
    tabBarVisible: raw?.tabBarVisible !== false,
    // 同理：只有显式写成 false 才关闭自动检查
    autoCheckUpdates: raw?.autoCheckUpdates !== false,
    // 非法（非字符串或解析不出时间）时一律当作「没检查过」，由 updateCheck.ts
    // 的 isUpdateCheckDue 统一处理；这里只保证类型干净
    lastUpdateCheckAt:
      typeof raw?.lastUpdateCheckAt === 'string' && raw.lastUpdateCheckAt
        ? raw.lastUpdateCheckAt
        : null,
    // 未知模式回落到直连，而不是把坏值透传给界面 ——
    // 后端的 network.rs 只认两个取值，透传只会得到一个渲染不出文案的选项
    networkMode: isNetworkMode(raw?.networkMode)
      ? raw.networkMode
      : DEFAULT_APP_SETTINGS.networkMode,
    // 去首尾空白：后端在保存时会拒绝带空白的地址，但一份被手工改过的
    // settings.json 会绕过那次校验；而拼接时代理根里多一个空格会拼出两个地址。
    // 与后端 proxy_base() 的处理保持一致（那里也是先 trim 再拼）。
    githubProxy: normalizeProxyBase(raw?.githubProxy),
    // 只有显式写成 false 才关闭，与 tabBarVisible / autoCheckUpdates 同一约定
    fileLoggingEnabled: raw?.fileLoggingEnabled !== false,
    crashLoggingEnabled: raw?.crashLoggingEnabled !== false,
  };
}

/**
 * 把插件加载超时夹到合法区间。
 *
 * 非数字或缺失时回落到默认值；数字则夹到 [MIN, MAX] —— 夹取而不是拒绝，
 * 因为一个越界的超时不值得让整份设置回落到默认。
 */
function clampPluginTimeout(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_APP_SETTINGS.pluginLoadTimeoutMs;
  }
  return Math.min(
    MAX_PLUGIN_LOAD_TIMEOUT_MS,
    Math.max(MIN_PLUGIN_LOAD_TIMEOUT_MS, Math.round(raw))
  );
}

/** 清洗标签数组：过滤非字符串、去重、截断到上限 */function normalizeOpenTabs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string' || !item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= MAX_OPEN_TABS) break;
  }

  return result;
}

/** 订阅设置变化 */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 同步读取已缓存的设置（应用启动早期也能用） */
export function getCachedSettings(): AppSettings {
  return cache;
}

export function isSettingsLoaded(): boolean {
  return loaded;
}

/** 从后端加载设置；失败时回退到默认值，不阻塞启动 */
export async function loadAppSettings(): Promise<AppSettings> {
  try {
    const stored = await invoke<AppSettings>('get_app_settings');
    cache = normalize(stored);
  } catch (error) {
    console.warn('[appSettings] 读取设置失败，使用默认值:', error);
    cache = { ...DEFAULT_APP_SETTINGS };
  }
  loaded = true;
  notify();
  return cache;
}

/**
 * 保存部分设置（乐观更新 + 失败回滚）
 */
export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const previous = cache;
  const optimistic = { ...cache, ...patch };

  cache = optimistic;
  notify();

  try {
    const stored = await invoke<AppSettings>('update_app_settings', { settings: optimistic });
    cache = normalize(stored);
    notify();
    return cache;
  } catch (error) {
    cache = previous;
    notify();
    throw error;
  }
}

/** 恢复默认设置 */
export async function resetAppSettings(): Promise<AppSettings> {
  const stored = await invoke<AppSettings>('reset_app_settings');
  cache = normalize(stored);
  notify();
  return cache;
}

/** 应用数据目录（用于「关于」页展示与打开） */
export async function getAppDataDir(): Promise<string> {
  return invoke<string>('get_app_data_dir');
}
