// src/services/appSettings.ts
//
// 应用全局设置的前端封装。
// 后端：src-tauri/src/modules/settings（get_app_settings / update_app_settings /
// reset_app_settings / get_app_data_dir）。

import { invoke } from '@tauri-apps/api/core';
import { isNetworkMode, normalizeProxyBase, type NetworkMode } from '../utils/networkSettings';
import { isThemeMode, type ThemeMode } from './theme';
import {
  clampSoundVolume,
  DEFAULT_SOUND_VOLUME,
  DEFAULT_NOTIFICATION_SOUND_ID,
} from '../utils/notificationSounds';

export interface AppSettings {
  /** 启动后默认打开的模块 ID（null = 内置默认 dashboard） */
  defaultModule: string | null;
  /** 启动时侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 卸载插件前是否二次确认 */
  confirmBeforeUninstall: boolean;
  /**
   * 是否在启动时恢复上次的**窗口状态**：打开的标签页、当前标签、分屏布局，
   * 以及上次停留的模块（替代 `defaultModule`）。
   *
   * 默认 `true`：恢复现场正是这个应用的主要卖点，替用户关掉它没有道理 ——
   * 想每次从干净状态开始的用户可以自己关。
   *
   * **它同时管"存"与"取"**：关闭时前端既不把标签变化写进设置，启动时也不读取
   * 已存的那些值。只做一半（只不读、或者只不写）都会留下一个"关掉了却还是在恢复"
   * 或者"重新打开后恢复出一个更早的陈旧布局"的错觉。
   */
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
   * 出站策略：`allow`（默认，放行并记录）/ `ask`（**尚未实现，界面禁用**）/ `deny`。
   *
   * **判定点不在前端。** 判定在 Rust（`modules/net/policy.rs`，纯函数、有真值表测试），
   * 因为请求由 Rust 发起；这里只存值。前端再判一次只会多出一套可能与后端分叉的规则。
   */
  networkPolicy: 'allow' | 'ask' | 'deny';
  /**
   * 离线模式：开启后**一切对外请求被拒**，本地回环不受影响。
   *
   * 它与 `networkPolicy` **互不覆盖**：离线是"现在别联网"，策略是"默认怎么办"。
   * 把离线做成策略的第四档，会让用户改回默认档时顺手把离线一起解除。
   */
  offlineMode: boolean;
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
  /**
   * 是否启用性能模式。
   *
   * 比 `reduceMotion` 更彻底：在停用动画的基础上，还去掉毛玻璃
   * （`backdrop-filter`，三个常驻全屏表面各 24px 模糊）、大半径装饰性模糊、
   * 合成层提升提示（`will-change`）与持续循环的装饰背景。
   *
   * **它包含 `reduceMotion` 的效果**（见 `services/theme.ts` 的有效值计算）：
   * 让用户必须同时打开两个开关才能得到完整效果，等于把这个功能藏起来。
   */
  performanceMode: boolean;
  /**
   * 是否启用**浮层**毛玻璃（对话框、菜单、抽屉、下拉面板）。
   *
   * 窗口亚层（标题栏、标签栏、侧边栏）**不受它控制**：那三处背后永远是应用的
   * 纯色底，`backdrop-filter` 既没有视觉效果、又要让合成器每帧把下层读回来
   * 做一次模糊，因此已永久关闭。本开关管的是剩下那些真正「浮在内容之上」的
   * 表面 —— 它们背后有会变化的内容，模糊在那里才有意义。
   *
   * 默认**开启**。它确实有视觉收益（浮层与背后内容之间多一层景深），而代价
   * 只发生在浮层打开的那几秒；这与 `performanceMode` 默认关闭并不矛盾 ——
   * 两者的差别是「临时开销」对「常驻开销」。
   *
   * 性能模式**包含**关闭毛玻璃（见 `services/theme.ts` 的有效值计算）：
   * 让用户为了去掉模糊再去打开一个代价更大的开关，等于把这件事藏起来。
   */
  glassEffect: boolean;
  /**
   * 仪表盘是否显示统计面板（模块总数 / 可见 / 收藏 / 隐藏 / 禁用）。
   *
   * 默认**开启**：新用户第一次打开仪表盘时，那几个数字回答的是"我装了多少东西、
   * 整理到哪一步了"。但它可以被关掉 —— 用久之后数字不再提供新信息，而它们占着
   * 首屏最上面一整行。开关就在仪表盘上，不在设置页里：要收起的是眼前这一块。
   */
  dashboardStatsVisible: boolean;
  /**
   * 是否播放通知提示音。
   *
   * 默认**开启**。通知在这个应用里是低频且有意义的事件（插件加载失败、有可用
   * 更新），不是每次操作的反馈；一条没被注意到的通知等于一条失败的通知。
   */
  notificationSoundEnabled: boolean;
  /**
   * 提示音 id。
   *
   * 内置取值见 `utils/notificationSounds.ts` 的 `BUILTIN_SOUNDS`，另有保留值
   * `custom`（使用 `notificationSoundCustomFile` 指向的音效）。
   * 未知取值由 `resolveSoundId` 回退到第一个内置音色，**不在这里纠正** ——
   * 与 `accent` 同一取向：保留原值可以避免「用户手工改了 settings.json，被静默改回」。
   */
  notificationSoundId: string;
  /**
   * 自定义提示音的文件名（位于 `<app_data>/sounds/` 下），没有则为 `null`。
   *
   * **存的是文件名而不是路径**：设置文件可被手工编辑，存路径等于把「读取任意
   * 文件」变成一条常驻能力。后端 `sound.rs` 只认 `custom.<白名单扩展名>`
   * 这一个形状，因此这里不需要（也无法）做路径处理。
   */
  notificationSoundCustomFile: string | null;
  /** 提示音音量，取值 `[0, 1]` */
  notificationSoundVolume: number;
  /**
   * 由系统自启动拉起时，是否静默启动（最小化而不是推到前台）。
   *
   * **只在自启动时生效**（命令行带 `--autostart`）：用户双击图标启动不该受它影响，
   * 否则「点了图标界面不出来」就是纯粹的故障。
   *
   * 注意「是否开启自启动」**不在这里** —— 它是注册表里的系统状态，由
   * `get_autostart_status` 命令读取。用户能在任务管理器的「启动」页里直接改它，
   * 在设置文件里再存一份副本必然与实际不符。
   *
   * 实现为**最小化**而不是隐藏窗口：本应用没有托盘图标，隐藏之后用户只能通过
   * 任务管理器找回它。因此界面上也如实写作「最小化启动」。
   */
  autoStartSilent: boolean;
  /**
   * 由系统自启动拉起时，是否直接进入全屏。
   *
   * 与 `autoStartSilent` 同时开启时**静默优先**：窗口没到前台，全屏无从谈起。
   */
  autoStartFullscreen: boolean;
  /**
   * 由系统自启动拉起时，是否最大化窗口。
   *
   * 与 `autoStartFullscreen` 同时开启时**全屏优先**：两者都想「尽可能大」，而全屏
   * 更大 —— 明确一个优先级，比让用户面对「到底哪个生效」的不确定性要好。
   */
  autoStartMaximized: boolean;
  /**
   * 分屏组（第二组）的标签。空数组 = 未分屏。
   *
   * 与 `openTabs` / `activeTab` 同属界面状态，它们一起描述「下次启动恢复到什么
   * 样子」。两组**必须互斥**（同一个标签不能同时在两组），这一点由 `tabStore`
   * 在初始化时去重保证 —— 设置文件可能被手工改坏。
   */
  splitTabs: string[];
  /** 分屏组当前激活的标签 */
  splitActive: string | null;
  /**
   * 分屏比例：左半占内容区的比例，取值 `[0.2, 0.8]`。
   *
   * 持久化它是因为「拖成 7:3」是一个明确的偏好，下次启动回到 5:5 会让人以为设置
   * 没保存。区间限制在两端：太窄的一半等于不可用。
   */
  splitRatio: number;
  /**
   * 点击窗口关闭按钮时的行为。
   *
   * `true` = 隐藏到托盘，应用继续在后台运行；`false` = 直接退出。
   *
   * **默认 `true`，与"关闭即退出"的朴素预期相反。** 理由是应用接下来要有在窗口
   * 之外继续工作的能力（后台插件、桌面通知）：若关闭等于退出，那些能力会在用户
   * 点一下关闭时被静默取消，而用户不会意识到自己关掉了什么。
   *
   * 托盘**右键菜单里也能改**这一项（改的是同一个字段），因此界面不能只依赖自己
   * 这份缓存 —— 从托盘改过之后要重新读回来，否则开关显示的值与真实行为相反。
   */
  closeToTray: boolean;
}

export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
export const DEFAULT_SPLIT_RATIO = 0.5;

/** 把分屏比例夹到合法区间（与后端 settings.rs 的校验区间一致） */
export function clampSplitRatio(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, raw));
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
  restoreLastModule: true,
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
  // 与后端 default_network_policy() 一致：默认放行并记录。
  // 出站管控的第一版是"先看得见"，不是"先拦得住" —— 用户要先能看到这软件在连什么，
  // 才有依据决定要不要收紧。
  networkPolicy: 'allow',
  offlineMode: false,
  // 与后端 default_file_logging_enabled() 一致：日志默认开着。
  // 用户不会为了排查问题提前打开它，默认关闭等于默认没有证据。
  fileLoggingEnabled: true,
  // 与后端 default_crash_logging_enabled() 一致
  crashLoggingEnabled: true,
  // 与后端 default_performance_mode() 一致：默认关闭。
  // 它是有代价的取舍（去掉毛玻璃与装饰效果会让界面变朴素），只能是用户主动选择。
  performanceMode: false,
  // 与后端 default_glass_effect() 一致：默认开启。
  // 浮层毛玻璃是临时开销（只在浮层打开时），与三个常驻亚层的取舍不同。
  glassEffect: true,
  // 与后端 default_dashboard_stats_visible() 一致：默认开启。
  dashboardStatsVisible: true,
  // 与后端 default_notification_sound_* 保持一致：默认开启、默认音色、默认音量。
  // 音量默认 0.8 而不是 1：合成音本身已经按峰值归一化过，留一点余量给多个通知
  // 叠加的情形，避免同时响几声时被压缩器压扁。
  notificationSoundEnabled: true,
  notificationSoundId: DEFAULT_NOTIFICATION_SOUND_ID,
  notificationSoundCustomFile: null,
  notificationSoundVolume: DEFAULT_SOUND_VOLUME,
  // 这两个默认也是「关」：它们只在自启动时才有意义，而自启动本身默认不开。
  // 方向与 tabBarVisible 那类「默认为开」的字段相反，理由见 normalize() 里的说明。
  autoStartSilent: false,
  autoStartFullscreen: false,
  autoStartMaximized: false,
  // 首次启动不该是分屏状态
  splitTabs: [],
  splitActive: null,
  // 与后端 default_split_ratio() 一致：对半分
  splitRatio: DEFAULT_SPLIT_RATIO,
  // 与后端 default_close_to_tray() 一致：默认隐藏到托盘（它是由
  // 「后台保活需要窗口之外的存活能力」推出的默认值，理由见类型上的说明）。
  closeToTray: true,
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
    // 未知取值退回默认档（放行），而不是拒绝 —— 与 Rust 侧 decide() 的选择一致：
    // 一个损坏的设置不该让应用失去联网能力
    networkPolicy:
      raw?.networkPolicy === 'allow' || raw?.networkPolicy === 'ask' || raw?.networkPolicy === 'deny'
        ? raw.networkPolicy
        : DEFAULT_APP_SETTINGS.networkPolicy,
    offlineMode: raw?.offlineMode === true,
    // 只有显式写成 false 才关闭，与 tabBarVisible / autoCheckUpdates 同一约定
    fileLoggingEnabled: raw?.fileLoggingEnabled !== false,
    crashLoggingEnabled: raw?.crashLoggingEnabled !== false,
    // 与上面两个相反：这里只有**显式写成 true** 才开启。
    //
    // 方向不同是因为默认值不同，而两者的目标是同一个：**老设置文件缺字段时，
    // 落到默认行为上**。日志的默认是「开」，所以缺字段要按开；性能模式的默认是
    // 「关」，所以缺字段必须按关 —— 用 `!== false` 的写法会让一份缺字段的
    // settings.json 把性能模式打开，那是一个用户从未选择过的界面。
    performanceMode: raw?.performanceMode === true,
    // 与上面几个相反，这里默认是「开」，因此只有显式写成 false 才关闭。
    // 用 `=== true` 会让一份缺该字段的老 settings.json 静默关掉毛玻璃 ——
    // 那是一次用户从未做过的选择。判据与 tabBarVisible / fileLoggingEnabled 一致。
    glassEffect: raw?.glassEffect !== false,
    // 同上：默认「开」，只有显式 false 才收起
    dashboardStatsVisible: raw?.dashboardStatsVisible !== false,
    // 与 glassEffect 同一约定：默认「开」，只有显式 false 才关闭
    notificationSoundEnabled: raw?.notificationSoundEnabled !== false,
    // 音色 id 只做类型清洗，未知取值交给 resolveSoundId 回退（理由见接口注释）
    notificationSoundId:
      typeof raw?.notificationSoundId === 'string' && raw.notificationSoundId
        ? raw.notificationSoundId
        : DEFAULT_APP_SETTINGS.notificationSoundId,
    // 文件名只接受非空字符串；**合法性由后端判定**（它才知道白名单扩展名与
    // `custom.` 前缀的规则）—— 前端复制一份判断只会漂移成两份。
    notificationSoundCustomFile:
      typeof raw?.notificationSoundCustomFile === 'string' && raw.notificationSoundCustomFile
        ? raw.notificationSoundCustomFile
        : null,
    // 夹取而不是拒绝：一个被手工改歪的音量不值得让整份设置回落到默认
    notificationSoundVolume: clampSoundVolume(raw?.notificationSoundVolume),
    // 与 performanceMode 同一写法：这两个默认也是「关」，因此只有显式 true 才开。
    // 用 `!== false` 会让一份缺字段的老 settings.json 把它们打开。
    autoStartSilent: raw?.autoStartSilent === true,
    autoStartFullscreen: raw?.autoStartFullscreen === true,
    autoStartMaximized: raw?.autoStartMaximized === true,
    // 分屏组：与 openTabs 同一套清洗规则（过滤非法项、去重、截断到上限）。
    // 两组之间的互斥不在这里做 —— 那是 tabStore 初始化时的事，它才知道
    // 「哪个标签在哪一组」的完整语义。
    splitTabs: normalizeOpenTabs(raw?.splitTabs),
    splitActive:
      typeof raw?.splitActive === 'string' && raw.splitActive ? raw.splitActive : null,
    // 夹取而不是拒绝：一个被手工改歪的比例不值得让整份设置回落到默认
    splitRatio: clampSplitRatio(raw?.splitRatio),
    // 与 autoStartSilent 那几项同理，用 `!== false`：缺字段时取后端默认的
    // 「隐藏到托盘」，而不是因为 `undefined` 落到 `false`。
    // 用裸 `raw?.closeToTray` 会让一份缺字段的老 settings.json 变成"关闭即退出"，
    // 而那正是这一项的默认值想避免的行为。
    closeToTray: raw?.closeToTray !== false,
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
 * 让后端**从磁盘重新读取**设置，并把结果同步到前端缓存。
 *
 * 与 `loadAppSettings` 的区别是它调用的是 `reload_app_settings`：后端的
 * `SettingsState` 是进程启动时读进来的一份内存副本，只在 `update_app_settings`
 * 时被更新。因此设置文件被**外部**改动之后（最典型的是从备份恢复
 * `settings.json`），只调 `get_app_settings` 拿到的仍是旧值 —— 后端自己就不知道
 * 磁盘变了。
 *
 * 那条命令同时会重新套用运行期开关（日志记录），所以它修的不只是"读到的值"。
 */
export async function reloadAppSettings(): Promise<AppSettings> {
  const fresh = await invoke<AppSettings>('reload_app_settings');
  cache = normalize(fresh);
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
