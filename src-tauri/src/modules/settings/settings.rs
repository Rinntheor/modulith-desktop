// src-tauri/src/modules/settings/settings.rs
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

use super::network;

/// 应用设置的文件名（位于 `app_data_dir()` 下）
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// 模块 ID 的最大长度
pub const MAX_MODULE_ID_LEN: usize = 128;

/// 应用全局设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// 启动后默认打开的模块 ID（None = 使用内置默认值 "dashboard"）
    #[serde(default)]
    pub default_module: Option<String>,
    /// 启动时侧边栏是否折叠
    #[serde(default)]
    pub sidebar_collapsed: bool,
    /// 卸载插件前是否二次确认
    ///
    /// 该字段的默认值为 `true`，因此使用 `#[serde(default = "...")]`
    /// 而不是裸 `#[serde(default)]`（后者会得到 `false`）。
    #[serde(default = "default_confirm_before_uninstall")]
    pub confirm_before_uninstall: bool,
    /// 启动时是否恢复上次的**窗口状态**（标签页、当前标签、分屏布局，以及上次
    /// 停留的模块，优先级高于 `default_module`）
    ///
    /// 默认 `true`。理由见前端 `appSettings.ts` 的说明：恢复现场是这个应用的主要
    /// 卖点，替用户关掉它没有道理。
    #[serde(default = "default_restore_last_module")]
    pub restore_last_module: bool,
    /// 上次打开的模块，由前端写入
    #[serde(default)]
    pub last_module: Option<String>,
    /// 界面主题：`light` / `dark` / `system`
    ///
    /// 默认 `system`：跟随操作系统的深色偏好，这是对用户打扰最小的默认值。
    /// 前端会在首帧前用 localStorage 缓存渲染一次，随后以这里的值为权威覆盖。
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 是否关闭界面动画（无障碍 / 低性能设备）
    ///
    /// 关闭后 CSS 动画与 framer-motion 动画都会被停用，
    /// 见前端 src/services/theme.ts。
    #[serde(default)]
    pub reduce_motion: bool,
    /// 插件是否在后台加载（不阻塞进入应用）
    ///
    /// 默认 `true`。插件 bundle 是第三方代码，即便单个插件很快，
    /// 装到几十个之后串行执行也会明显拖长启动时间；而插件对核心功能
    /// 并非必需，因此默认放到应用可用之后再加载。
    /// 关闭后插件会在启动过程中同步加载完（启动更慢，但界面首次出现时
    /// 侧边栏就是完整的）。
    #[serde(default = "default_defer_plugin_loading")]
    pub defer_plugin_loading: bool,
    /// 单个插件加载的超时时间（毫秒）
    ///
    /// 插件在 IIFE 顶层同步执行，一旦里面有死循环或长时间同步计算，
    /// 主线程会被卡住。这个超时无法中断已经在跑的同步代码（JS 单线程
    /// 没有抢占），但能保证**后续插件不再被它拖累**：超时后判定为失败、
    /// 继续加载其余插件。取值需大于正常插件的加载耗时。
    #[serde(default = "default_plugin_load_timeout_ms")]
    pub plugin_load_timeout_ms: u32,
    /// 主题配色 id（强调色）
    ///
    /// 与 `theme`（深/浅）正交：`theme` 决定明暗，本字段决定品牌色相。
    ///
    /// 取值是前端 `src/config/accentTheme.ts` 中注册的 id。**这里不校验
    /// 是否属于已知集合** —— 配色表在前端，后端不该复制一份会漂移的清单。
    /// 未知 id 由前端 `getAccentTheme()` 回退到默认值，因此这里只做基本
    /// 的格式校验（非空、长度上限、字符集），防止写入任意字符串。
    #[serde(default = "default_accent")]
    pub accent: String,
    /// 打开的模块标签页（按显示顺序，由前端写入）
    ///
    /// 与 `last_module` 同属「界面状态」，因此放在同一份文件里而不是另开一个
    /// 存储：它们共同描述「下次启动恢复到什么样子」，分开持久化会出现两处
    /// 状态互不一致的窗口期。
    ///
    /// 这里**不校验模块是否真实存在**。模块清单一部分来自构建期生成的内建
    /// 注册表、一部分来自运行期注册的插件，后端复制一份必然漂移；失效的
    /// 标签由前端在目录同步时对账剔除（插件被卸载后标签必须消失）。
    #[serde(default)]
    pub open_tabs: Vec<String>,
    /// 当前激活的标签页，应为 `open_tabs` 中的一项
    ///
    /// 不强制要求「必须属于 open_tabs」：读取时若不一致则由前端丢弃该值，
    /// 这是安全的降级，而在这里报错只会让一次无害的状态错位变成保存失败。
    #[serde(default)]
    pub active_tab: Option<String>,
    /// 是否显示二级标题栏（标签栏）
    ///
    /// 关掉它是为了「沉浸」：标签栏属于应用外壳，某些场景下（例如全屏看一个模块）
    /// 它就是多余的。默认 `true` —— 隐藏入口应当是用户主动选择的结果，而不该是
    /// 新用户的默认体验。
    ///
    /// **只隐藏标签栏，不隐藏标题栏。** 窗口是无边框的（`decorations: false`），
    /// 标题栏承载最小化 / 最大化 / 关闭按钮，隐藏它会让用户没法关掉窗口 ——
    /// 而「关不掉窗口」不是一个可以用设置项换取的体验。
    #[serde(default = "default_tab_bar_visible")]
    pub tab_bar_visible: bool,
    /// 启动时是否自动检查应用更新
    ///
    /// 默认 `true`：这是让「有新版本」能被发现的唯一途径 —— 不主动检查的话，
    /// 用户除非自己去「关于」页点一次，否则永远不会知道。检查本身只是向
    /// GitHub 的 release 地址发一次 GET，不携带任何本机信息。
    ///
    /// 用户可以关掉它。关掉后仍然可以手动检查，且**不会**在启动时发任何请求。
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    /// 上次**得到确定结论**的自动检查时间（RFC3339，由前端写入）
    ///
    /// 存在的理由是节流：启动时检查一次是对 GitHub 的请求，一天开十次应用
    /// 不该发十次。前端据此判断 24 小时内是否已经查过。
    ///
    /// 只记录「拿到结论」的时刻，不记录「尝试过」：检查因断网失败时留空，
    /// 下次启动会重试 —— 否则一次离线启动就会让自动检查静默失效一整天。
    #[serde(default)]
    pub last_update_check_at: Option<String>,
    /// 网络访问方式：`direct`（直连 GitHub）/ `proxy`（经由下载源）
    ///
    /// 默认 `direct`：不改动用户的网络路径是最安全的默认值 —— 一个默认打开的
    /// 第三方加速源会把「装什么插件」这条路交给一个我们无法控制的中间人。
    ///
    /// 取值由 `network.rs` 校验。**直连与代理的差别只是地址前缀**，内容完整性
    /// 仍由既有的哈希（`.lcp`）与签名（索引、更新包）保证，不由这个开关保证。
    #[serde(default = "default_network_mode")]
    pub network_mode: String,
    /// 代理根地址（例如 `https://gh-proxy.org`）
    ///
    /// 空串表示「还没填」。**是否生效由 `network_mode` 单独决定**：只有
    /// `network_mode == "proxy"` 且本字段非空时才走代理，两者缺一即直连。
    /// 这样「切回直连」不会丢掉已填的地址，用户可以反复切换比较速度。
    ///
    /// 格式校验（https / 无空白 / 无查询串 / 无凭据）见 `network.rs`。
    #[serde(default = "default_github_proxy")]
    pub github_proxy: String,
    /// 出站策略：`allow`（默认）/ `ask`（**尚未实现，界面禁用**）/ `deny`
    ///
    /// 默认是**放行并记录** —— 出站管控的第一版是"先看得见"，不是"先拦得住"。
    /// 判定逻辑在 `modules/net/policy.rs`（纯函数、有真值表测试），这里只存取值：
    /// 权限与策略的检查点都必须落在**动作真正发生**的那一侧（Rust），前端不重复判断。
    #[serde(default = "default_network_policy")]
    pub network_policy: String,
    /// 离线模式：开启后**一切对外请求被拒**，本地回环不受影响。
    ///
    /// 它与 `network_policy` **互不覆盖**：离线是"现在别联网"，策略是"默认怎么办"。
    /// 把离线做成策略的第四档，会让用户改回默认档时顺手把离线一起解除 ——
    /// 那不是他按这个开关时想要的事。
    #[serde(default)]
    pub offline_mode: bool,
    /// 是否把运行日志实时写入文件
    ///
    /// 默认 `true`。日志是「出问题时唯一的证据」，而用户不会为了排查问题
    /// 提前把它打开 —— 默认关闭等于默认没有证据。写入量受大小上限与轮转约束
    /// （见 `logging` 模块），不会无限增长。
    ///
    /// 关掉之后仍然记录崩溃（由 `crash_logging_enabled` 单独控制）：崩溃是
    /// 低频、高价值的事件，与高频的运行日志不该共用一个开关。
    #[serde(default = "default_file_logging_enabled")]
    pub file_logging_enabled: bool,
    /// 是否把崩溃写入单独的崩溃日志文件
    ///
    /// 默认 `true`。崩溃日志与运行日志分成两个文件，因为它们的读取场景不同：
    /// 用户报障时需要的往往是「崩在哪」，而不是「崩之前刷了多少行」。
    ///
    /// **它不受 `file_logging_enabled` 影响**：关掉实时记录正是为了少写磁盘，
    /// 而崩溃记录是低频的；这也让「关了日志但仍然能拿到崩溃现场」成为可能。
    #[serde(default = "default_crash_logging_enabled")]
    pub crash_logging_enabled: bool,
    /// 是否启用性能模式
    ///
    /// 默认 `false`。它比 `reduce_motion` 更彻底：除了停用动画，还会去掉毛玻璃
    /// （`backdrop-filter`）、装饰性渐变与持续动画的背景效果 —— 这些是「关了动画
    /// 仍然卡」的常见来源，因为它们不表现为"动画"，而是让每一帧都要重新合成
    /// 整个图层。
    ///
    /// **性能模式包含 `reduce_motion` 的效果**（见前端 `services/theme.ts`）：
    /// 让用户必须同时打开两个开关才能得到完整效果，等于把这个功能藏起来。
    ///
    /// 后端只存这个布尔量，具体停用什么由前端 CSS 决定（`index.css` 的
    /// `.lc-performance`）—— 与 `accent` 同理，视觉细节不该在后端复制一份。
    #[serde(default = "default_performance_mode")]
    pub performance_mode: bool,
    /// 是否启用**浮层**毛玻璃（对话框、菜单、抽屉、下拉面板）
    ///
    /// 窗口亚层（标题栏、标签栏、侧边栏）**不受它控制**：那三处背后永远是应用的
    /// 纯色底，`backdrop-filter` 没有视觉效果却要让合成器每帧重新合成，因此已在
    /// 前端永久关闭（见 `src/styles/global/index.css` 与 `utils/glassPreference.ts`）。
    ///
    /// 默认 `true`。它确实有视觉收益，而代价只发生在浮层打开的那几秒 ——
    /// 这与 `performance_mode` 默认关闭不矛盾，差别是「临时开销」对「常驻开销」。
    ///
    /// 性能模式**包含**关闭毛玻璃（见前端 `services/theme.ts` 的合并逻辑）：
    /// 让用户为了去掉模糊再去打开一个代价更大的开关，等于把这件事藏起来。
    ///
    /// 后端只存这个布尔量，具体停用什么由前端决定 —— 与 `performance_mode`、
    /// `accent` 同理，视觉细节不该在后端复制一份（复制一份必然漂移）。
    #[serde(default = "default_glass_effect")]
    pub glass_effect: bool,
    /// 仪表盘是否显示统计面板
    ///
    /// 默认 `true`：那几个数字（模块总数 / 可见 / 收藏 / 隐藏 / 禁用）回答的是
    /// "我现在装了多少东西、整理到哪一步了"，新用户第一次打开仪表盘时正需要它。
    /// 但它是**可关的** —— 用久之后那几个数字不再提供任何新信息，而它们占着首屏
    /// 最上面的一整行。判断该由用户做，不该由默认值替他做。
    #[serde(default = "default_dashboard_stats_visible")]
    pub dashboard_stats_visible: bool,
    /// 是否播放通知提示音
    ///
    /// 默认 `true`。通知在这个应用里是**低频且有意义**的事件（插件加载失败、
    /// 有可用更新），不是每次操作的反馈；一条没被注意到的通知等于一条失败的通知。
    /// 用户随时可以在「设置 → 通知」里关掉。
    #[serde(default = "default_notification_sound_enabled")]
    pub notification_sound_enabled: bool,
    /// 提示音 id
    ///
    /// 内置取值由前端 `src/utils/notificationSounds.ts` 的 `BUILTIN_SOUNDS` 定义
    /// （`chime` / `drop` / `pulse` / `alert` / `soft`），另有保留值 `custom`。
    /// **这里不校验是否属于已知集合** —— 音色表在前端，后端复制一份清单必然漂移，
    /// 后果是「前端新增了音色，后端拒绝保存」。未知 id 由前端回退到默认音色，
    /// 因此这里只校验格式（非空、长度、字符集）。与 `accent` 同一取向。
    #[serde(default = "default_notification_sound_id")]
    pub notification_sound_id: String,
    /// 自定义提示音的文件名（位于 `<app_data>/sounds/` 下）
    ///
    /// **只存文件名，不存路径。** 存绝对路径会让「读取任意用户文件」成为一条
    /// 常驻能力，而它只需要在用户主动选择的那一刻发生一次；文件名 + 把字节复制进
    /// 应用数据，换来三件事：原文件移动/删除后提示音仍可用、不存在任意路径读取面、
    /// 备份迁移只需要带上应用数据目录。取值由 `sound.rs` 严格校验
    /// （只认 `custom.<白名单扩展名>` 这一个形状）。
    #[serde(default)]
    pub notification_sound_custom_file: Option<String>,
    /// 提示音音量（`0.0..=1.0`）
    ///
    /// 提供音量而不是只给一个开关，是因为系统音量与应用音量是两件事：用户可能把
    /// 系统音量调得很低用于其它程序，却仍希望这个应用的提示音听得见（或者相反）。
    #[serde(default = "default_notification_sound_volume")]
    pub notification_sound_volume: f32,
    /// 自启动时是否「静默」启动（不把窗口推到前台）
    ///
    /// **只在由系统自启动拉起时生效**（命令行带 `--autostart`）。用户自己双击图标
    /// 启动不受影响 —— 否则用户点了图标却发现界面不出来，那是纯粹的故障。
    ///
    /// 实现为**最小化启动**而不是隐藏窗口：本应用没有托盘图标，把窗口隐藏之后
    /// 用户只能通过任务管理器找到它。因此设置界面里也如实写作「最小化启动」，
    /// 不写成「后台静默运行」。
    #[serde(default)]
    pub auto_start_silent: bool,
    /// 自启动时是否直接进入全屏
    ///
    /// 与 `auto_start_silent` 同时开启时**静默优先**：窗口没到前台，全屏无从谈起。
    #[serde(default)]
    pub auto_start_fullscreen: bool,
    /// 自启动时是否最大化窗口
    ///
    /// 与 `auto_start_fullscreen` 同时开启时**全屏优先**：两者都想「尽可能大」，
    /// 而全屏更大，明确一个优先级比让用户猜哪个生效要好。与 `auto_start_silent`
    /// 的关系同上 —— 静默优先。
    #[serde(default)]
    pub auto_start_maximized: bool,
    /// 分屏组（第二组）的标签。空数组 = 未分屏
    ///
    /// 与 `open_tabs` 同属界面状态，由前端写入。同样**不校验模块是否存在**
    /// （理由见 `open_tabs`），失效值由前端在目录对账时丢弃。
    ///
    /// 后端只保证每一项的格式合法与两组的总数不超上限；**「同一个标签不能同时在
    /// 两组」这条互斥由前端保证** —— 那需要知道「标签在哪一组」的完整语义，
    /// 在这里复制一份判断只会漂移。
    ///
    /// 注意「是否开启自启动」**不在这里** —— 那是注册表里的系统状态，注册表是
    /// 它的唯一真相（用户可以在任务管理器的「启动」页里直接改）。在设置文件里
    /// 再存一份必然会与事实不符。见 `autostart.rs`。
    #[serde(default)]
    pub split_tabs: Vec<String>,
    /// 分屏组当前激活的标签
    #[serde(default)]
    pub split_active: Option<String>,
    /// 分屏比例：左半占内容区的比例
    ///
    /// 与 `split_tabs` 一样属于界面状态。后端只校验区间 —— 具体怎么用（谁占左边、
    /// 最小宽度是多少）是渲染层的事，在这里复制一份布局判断只会漂移。
    #[serde(default = "default_split_ratio")]
    pub split_ratio: f32,
}

/// 同时打开的标签页数量上限
///
/// 每个打开的标签都会被挂载（保活），因此这个上限实际约束的是**常驻内存的
/// 模块实例数**。取 12 的理由：正常使用下很少超过，而 12 个模块实例的内存
/// 占用仍在桌面应用的合理范围内。达到上限后前端拒绝再开新标签并给出提示，
/// 而不是悄悄淘汰已打开的标签 —— 静默关掉用户打开的标签是更糟的行为。
pub const MAX_OPEN_TABS: usize = 12;

fn default_confirm_before_uninstall() -> bool {
    true
}

/// 恢复上次的窗口状态默认开启。理由见 `restore_last_module` 字段上的说明。
///
/// 用显式函数而不是裸 `#[serde(default)]`：后者的 `bool` 默认是 `false`，
/// 而这里要的是 `true` —— 两者差一个字符，行为差一个默认值。
fn default_restore_last_module() -> bool {
    true
}

fn default_theme() -> String {
    THEME_SYSTEM.to_string()
}

fn default_defer_plugin_loading() -> bool {
    true
}

/// 标签栏默认可见。理由见 `tab_bar_visible` 字段上的说明。
fn default_tab_bar_visible() -> bool {
    true
}

/// 自动检查更新默认开启。理由见 `auto_check_updates` 字段上的说明。
fn default_auto_check_updates() -> bool {
    true
}

/// 性能模式默认关闭。
///
/// 它是有代价的取舍（去掉毛玻璃与装饰效果会让界面变朴素），因此只能是用户
/// 主动选择的结果 —— 默认打开等于替所有用户做了这个取舍。
fn default_performance_mode() -> bool {
    false
}

/// 浮层毛玻璃默认开启。
///
/// 与 `default_performance_mode` 的方向相反，因为两者的取舍不同：性能模式
/// 换来的是**常驻**的朴素界面（三个亚层、装饰模糊、合成层提升一直在），
/// 而毛玻璃的代价只发生在浮层打开的那几秒。默认关掉一件只在打开浮层时才
/// 有代价、却有实际视觉收益的效果，没有道理。
fn default_glass_effect() -> bool {
    true
}

/// 仪表盘统计面板默认显示。理由见 `dashboard_stats_visible` 字段上的说明。
fn default_dashboard_stats_visible() -> bool {
    true
}

/// 提示音默认开启。理由见 `notification_sound_enabled` 字段上的说明。
fn default_notification_sound_enabled() -> bool {
    true
}

/// 默认音色 id（与前端 `BUILTIN_SOUNDS[0].id` 必须一致）
fn default_notification_sound_id() -> String {
    DEFAULT_NOTIFICATION_SOUND_ID.to_string()
}

/// 默认音色。取 `BUILTIN_SOUNDS` 的第一项，也就是随应用发布的那个音效文件
/// （`src/assets/notification.mp3`）—— 前端在遇到未知 id 时回退到的也是它。
///
/// **它的声音不在这里，也不在前端常量里**：后端只存 id，播放由前端负责。因此
/// 这个常量的唯一职责是"与前后端的默认值保持一致"，两侧不一致会出现"后端认为
/// 默认是 A、前端回退到 B"这种只在缺字段时才暴露的分叉。
///
/// 1.3.2 之前它是 `"chime"`（一个现场合成的音色）。**老设置文件里已经存下的
/// `"chime"` 仍然合法**，因此升级不会改变老用户听到的声音 —— 只改默认值，
/// 不改用户已经做出的选择。
pub const DEFAULT_NOTIFICATION_SOUND_ID: &str = "default";

/// 音效 id 的最大长度（与前端 `utils/notificationSounds.ts` 的校验一致）
pub const MAX_SOUND_ID_LEN: usize = 32;

/// 音量区间与默认值（与前端 `MIN/MAX/DEFAULT_SOUND_VOLUME` 必须一致）
pub const MIN_NOTIFICATION_SOUND_VOLUME: f32 = 0.0;
pub const MAX_NOTIFICATION_SOUND_VOLUME: f32 = 1.0;
pub const DEFAULT_NOTIFICATION_SOUND_VOLUME: f32 = 0.8;

fn default_notification_sound_volume() -> f32 {
    DEFAULT_NOTIFICATION_SOUND_VOLUME
}

/// 校验音效 id 的**格式**（不校验是否为已知音色，理由见 `notification_sound_id`）
pub fn is_valid_sound_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SOUND_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// 默认直连。理由见 `network_mode` 字段上的说明。
fn default_network_mode() -> String {
    network::NETWORK_MODE_DIRECT.to_string()
}

/// 分屏比例默认对半分。
///
/// 与前端 `DEFAULT_SPLIT_RATIO` 必须一致 —— 两处不一致会让"第一次拖动前的宽度"
/// 取决于读的是哪一份。
fn default_split_ratio() -> f32 {
    DEFAULT_SPLIT_RATIO
}

/// 分屏比例的默认值与允许区间（与前端 `appSettings.ts` 的三个常量必须一致）
pub const DEFAULT_SPLIT_RATIO: f32 = 0.5;
pub const MIN_SPLIT_RATIO: f32 = 0.2;
pub const MAX_SPLIT_RATIO: f32 = 0.8;

/// 代理地址默认为空（= 还没填）。
///
/// 用显式的默认值函数而不是裸 `#[serde(default)]`，是为了让四个新字段的默认值
/// 都出现在同一个位置 —— 混用两种写法时，「这个字段缺省是什么」要靠人记住
/// `String` 的 `Default` 是空串，而那不是一眼能看出来的。
/// 默认放行。见 `network_policy` 字段上的说明：第一版的目标是可观测性
fn default_network_policy() -> String {
    "allow".to_string()
}

fn default_github_proxy() -> String {
    String::new()
}

/// 运行日志默认写入文件。理由见 `file_logging_enabled` 字段上的说明。
fn default_file_logging_enabled() -> bool {
    true
}

/// 崩溃记录默认开启。理由见 `crash_logging_enabled` 字段上的说明。
fn default_crash_logging_enabled() -> bool {
    true
}

fn default_accent() -> String {
    DEFAULT_ACCENT.to_string()
}

/// 默认主题配色 id（与前端 `DEFAULT_ACCENT_ID` 必须一致）
pub const DEFAULT_ACCENT: &str = "indigo";
/// 配色 id 的最大长度
pub const MAX_ACCENT_ID_LEN: usize = 32;

/// 校验配色 id 的**格式**（不校验是否为已知配色，理由见 `accent` 字段注释）
pub fn is_valid_accent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ACCENT_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn default_plugin_load_timeout_ms() -> u32 {
    DEFAULT_PLUGIN_LOAD_TIMEOUT_MS
}

/// 插件加载超时的默认值（毫秒）
pub const DEFAULT_PLUGIN_LOAD_TIMEOUT_MS: u32 = 5000;

/// 插件加载超时的允许区间（毫秒）
pub const MIN_PLUGIN_LOAD_TIMEOUT_MS: u32 = 500;
pub const MAX_PLUGIN_LOAD_TIMEOUT_MS: u32 = 60_000;

/// 允许的主题值
pub const THEME_LIGHT: &str = "light";
pub const THEME_DARK: &str = "dark";
pub const THEME_SYSTEM: &str = "system";

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_module: None,
            sidebar_collapsed: false,
            confirm_before_uninstall: true,
            // **必须与 `default_restore_last_module()` 的返回值一致。**
            //
            // 这里以前写的是 `false`，而 serde 的缺省值是 `true` —— 两者不一致的
            // 后果很具体：`load()` 在设置文件缺失或损坏时回落到 `AppSettings::default()`，
            // 因此「全新安装」与「字段缺失的老文件」会得到**相反**的默认行为。
            // 用户看到的现象是「恢复上次打开的模块与标签页」这个开关在全新安装时
            // 默认是关的，而文档与界面上的默认值都写着开。
            //
            // 同一个错误的第二种表现更难发现：手工改坏 settings.json 会让这个开关
            // 静默地变成关闭，而用户什么也没做。
            // `impl_default_matches_serde_defaults` 测试把两处钉在一起。
            restore_last_module: default_restore_last_module(),
            last_module: None,
            theme: default_theme(),
            reduce_motion: false,
            defer_plugin_loading: default_defer_plugin_loading(),
            plugin_load_timeout_ms: default_plugin_load_timeout_ms(),
            accent: default_accent(),
            open_tabs: Vec::new(),
            active_tab: None,
            tab_bar_visible: default_tab_bar_visible(),
            auto_check_updates: default_auto_check_updates(),
            last_update_check_at: None,
            network_mode: default_network_mode(),
            github_proxy: default_github_proxy(),
            network_policy: default_network_policy(),
            offline_mode: false,
            file_logging_enabled: default_file_logging_enabled(),
            crash_logging_enabled: default_crash_logging_enabled(),
            performance_mode: default_performance_mode(),
            glass_effect: default_glass_effect(),
            dashboard_stats_visible: default_dashboard_stats_visible(),
            notification_sound_enabled: default_notification_sound_enabled(),
            notification_sound_id: default_notification_sound_id(),
            notification_sound_custom_file: None,
            notification_sound_volume: default_notification_sound_volume(),
            auto_start_silent: false,
            auto_start_fullscreen: false,
            auto_start_maximized: false,
            split_tabs: Vec::new(),
            split_active: None,
            split_ratio: default_split_ratio(),
        }
    }
}

impl AppSettings {
    /// 校验设置内容，非法时返回可直接展示给用户的错误信息
    pub fn validate(&self) -> Result<(), String> {
        if let Some(id) = &self.default_module {
            if !is_valid_module_id(id) {
                return Err(format!(
                    "Invalid defaultModule \"{}\": only letters, digits, '.', '_', '/', '-' are allowed (max {} characters, must start with a letter or digit)",
                    id, MAX_MODULE_ID_LEN
                ));
            }
        }

        if let Some(id) = &self.last_module {
            if !is_valid_module_id(id) {
                return Err(format!(
                    "Invalid lastModule \"{}\": only letters, digits, '.', '_', '/', '-' are allowed (max {} characters, must start with a letter or digit)",
                    id, MAX_MODULE_ID_LEN
                ));
            }
        }

        // 主题必须是三个枚举值之一。这里刻意「拒绝写入」而不是悄悄回退：
        // 静默纠正会让前端收到的值与它提交的值不一致，反而更难排查。
        if !matches!(self.theme.as_str(), THEME_LIGHT | THEME_DARK | THEME_SYSTEM) {
            return Err(format!(
                "Invalid theme \"{}\": expected one of \"light\", \"dark\", \"system\"",
                self.theme
            ));
        }

        // 超时过小会让正常插件被误判失败，过大则失去保护意义，因此限定区间。
        if self.plugin_load_timeout_ms < MIN_PLUGIN_LOAD_TIMEOUT_MS
            || self.plugin_load_timeout_ms > MAX_PLUGIN_LOAD_TIMEOUT_MS
        {
            return Err(format!(
                "Invalid pluginLoadTimeoutMs {}: expected {}..={}",
                self.plugin_load_timeout_ms, MIN_PLUGIN_LOAD_TIMEOUT_MS, MAX_PLUGIN_LOAD_TIMEOUT_MS
            ));
        }

        // 配色 id 只校验格式。
        //
        // 与 theme 不同，这里**不**校验"是否属于已知配色"——配色表定义在
        // 前端（src/config/accentTheme.ts），后端复制一份清单必然漂移，
        // 而漂移的后果是「前端加了新配色，后端拒绝保存」。
        // 未知 id 由前端回退到默认值，是安全的降级。
        if !is_valid_accent_id(&self.accent) {
            return Err(format!(
                "Invalid accent \"{}\": expected 1..={} chars of [a-z0-9-]",
                self.accent, MAX_ACCENT_ID_LEN
            ));
        }

        // 提示音 id：与 accent 同一取向，只校验格式。
        // 未知音色由前端回退到默认值，是安全的降级；在这里拒绝一份只是带了新音色的
        // 设置，会让「前端加了音色、后端拒绝保存」这种跨版本问题出现。
        if !is_valid_sound_id(&self.notification_sound_id) {
            return Err(format!(
                "Invalid notificationSoundId \"{}\": expected 1..={} chars of [a-z0-9-]",
                self.notification_sound_id, MAX_SOUND_ID_LEN
            ));
        }

        // 音量越界拒绝而不是夹取：这个值由界面上的滑块产生，任何合法交互都不会
        // 越界，因此越界只可能来自被手工改坏的文件或前端的错误。静默纠正会让前端的
        // 值与存下来的值不一致，反而更难排查（与 theme 同一理由）。
        if !(MIN_NOTIFICATION_SOUND_VOLUME..=MAX_NOTIFICATION_SOUND_VOLUME)
            .contains(&self.notification_sound_volume)
            || !self.notification_sound_volume.is_finite()
        {
            return Err(format!(
                "Invalid notificationSoundVolume {}: expected {}..={}",
                self.notification_sound_volume,
                MIN_NOTIFICATION_SOUND_VOLUME,
                MAX_NOTIFICATION_SOUND_VOLUME
            ));
        }

        // 自定义提示音的文件名：**必须在这里就拒绝非法取值**。
        // 读取端（`sound.rs::load`）也有一道同样的校验，但两道的意义不同 ——
        // 这里防的是"把非法名字写进设置文件"，那里防的是"文件已经被手工改坏"。
        // 只在读取端校验会让一份坏设置一直躺在磁盘上。
        if let Some(file_name) = &self.notification_sound_custom_file {
            if !file_name.is_empty() && !super::sound::is_valid_custom_sound_file_name(file_name) {
                return Err(format!(
                    "Invalid notificationSoundCustomFile \"{file_name}\": expected \"custom.<{}>\"",
                    super::sound::SOUND_EXTENSIONS.join("|")
                ));
            }
        }

        // 标签页：校验数量上限与每个 ID 的格式。
        //
        // 数量上限是必须校验的：它约束的是保活机制下常驻的模块实例数，
        // 如果这里放行任意长度，一份被手工改坏的 settings.json 就能让前端
        // 在启动时尝试挂载上千个模块。
        //
        // **上限按两组之和算**：分屏不会让"同时存在的模块实例"变少，
        // 每个标签仍然是一个常驻的挂载实例。只查 open_tabs 会让分屏成为绕过上限的
        // 一个口子。
        let stored_total = self.open_tabs.len() + self.split_tabs.len();
        if stored_total > MAX_OPEN_TABS {
            return Err(format!(
                "Invalid openTabs + splitTabs: expected at most {} entries in total, got {}",
                MAX_OPEN_TABS, stored_total
            ));
        }

        for id in &self.open_tabs {
            if !is_valid_module_id(id) {
                return Err(format!(
                    "Invalid openTabs entry \"{}\": only letters, digits, '.', '_', '/', '-' are allowed (max {} characters, must start with a letter or digit)",
                    id, MAX_MODULE_ID_LEN
                ));
            }
        }

        if let Some(id) = &self.active_tab {
            if !is_valid_module_id(id) {
                return Err(format!(
                    "Invalid activeTab \"{}\": only letters, digits, '.', '_', '/', '-' are allowed (max {} characters, must start with a letter or digit)",
                    id, MAX_MODULE_ID_LEN
                ));
            }
        }

        // 分屏组与第一组同源（都来自模块 ID），因此校验同一套格式
        for id in &self.split_tabs {
            if !is_valid_module_id(id) {
                return Err(format!(
                    "Invalid splitTabs entry \"{}\": only letters, digits, '.', '_', '/', '-' are allowed (max {} characters, must start with a letter or digit)",
                    id, MAX_MODULE_ID_LEN
                ));
            }
        }

        if let Some(id) = &self.split_active {
            if !is_valid_module_id(id) {
                return Err(format!(
                    "Invalid splitActive \"{}\": only letters, digits, '.', '_', '/', '-' are allowed (max {} characters, must start with a letter or digit)",
                    id, MAX_MODULE_ID_LEN
                ));
            }
        }

        // 分屏比例：两端都拒绝而不是悄悄夹取。
        //
        // 这里与 `plugin_load_timeout_ms` 的处理不同 —— 那个是"夹取"（越界的超时
        // 不值得让整份设置回落），而比例越界意味着前端记错了值，明确报错能让问题
        // 在写入时就暴露，而不是变成一个"界面宽度看起来怪怪的"的现象。
        if !(MIN_SPLIT_RATIO..=MAX_SPLIT_RATIO).contains(&self.split_ratio) {
            return Err(format!(
                "Invalid splitRatio {}: expected {}..={}",
                self.split_ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO
            ));
        }

        // 自动检查的时间戳只校验格式。
        //
        // 不做「不能是未来」这类语义校验：那由前端在判断节流时处理（未来的时间戳
        // 会被当作「没检查过」而不是「刚检查过」）。放在这里拒绝反而是错的 ——
        // 系统时钟被往回调一下就会让设置无法保存。
        if let Some(raw) = &self.last_update_check_at {
            if chrono::DateTime::parse_from_rfc3339(raw).is_err() {
                return Err(format!(
                    "Invalid lastUpdateCheckAt \"{}\": expected an RFC3339 timestamp",
                    raw
                ));
            }
        }

        // 网络方式必须是两个枚举值之一。与 theme 同理：拒绝而不是悄悄回退，
        // 否则前端收到的值与它提交的值不一致，反而更难排查。
        if !network::is_valid_network_mode(&self.network_mode) {
            return Err(format!(
                "Invalid networkMode \"{}\": expected one of \"{}\", \"{}\"",
                self.network_mode,
                network::NETWORK_MODE_DIRECT,
                network::NETWORK_MODE_PROXY
            ));
        }

        // 代理地址**始终**校验格式，即使当前是直连模式。
        //
        // 理由是「切换模式」这个动作不该有额外的失败点：如果只在代理模式下校验，
        // 用户可以先存下一个坏地址、切到直连（保存成功），再切回代理时才发现存不进去 ——
        // 那时报错指向的是一个他刚刚没碰过的输入框。
        network::validate_github_proxy(&self.github_proxy)?;

        Ok(())
    }
}

/// 校验模块 ID：等价于 `^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$`
///
/// 允许子模块 ID（例如 `finance/dashboard`），拒绝空串、以 `/` 开头、
/// 含空格、`..`、超过 128 个字符等非法值。
pub fn is_valid_module_id(id: &str) -> bool {
    let bytes = id.as_bytes();

    if bytes.is_empty() || bytes.len() > MAX_MODULE_ID_LEN {
        return false;
    }

    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }

    bytes[1..].iter().all(|b| {
        b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-')
    })
}

/// 设置文件的完整路径（必要时创建应用数据目录）
pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_dir.join(SETTINGS_FILE_NAME))
}

/// 读取应用设置
///
/// 文件不存在或解析失败时返回默认值，永远不会失败；
/// 解析失败会通过 `log::warn!` 记录一条警告。
pub fn load(app: &AppHandle) -> AppSettings {
    let path = match settings_path(app) {
        Ok(path) => path,
        Err(e) => {
            log::warn!("读取应用设置路径失败，使用默认设置: {}", e);
            return AppSettings::default();
        }
    };

    if !path.exists() {
        return AppSettings::default();
    }

    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) => {
            log::warn!("读取应用设置文件失败，使用默认设置: {}", e);
            return AppSettings::default();
        }
    };

    match serde_json::from_str::<AppSettings>(&content) {
        Ok(settings) => settings,
        Err(e) => {
            log::warn!("解析应用设置文件失败，使用默认设置: {}", e);
            AppSettings::default()
        }
    }
}

/// 原子写入设置文件：先写同目录下的临时文件，再 rename 覆盖目标文件，
/// 避免进程崩溃留下被截断的 JSON。
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp_path = path.with_file_name(format!("{}.tmp", SETTINGS_FILE_NAME));

    fs::write(&tmp_path, content).map_err(|e| format!("Failed to write settings file: {}", e))?;

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to replace settings file: {}", e));
    }

    Ok(())
}

/// 校验并持久化应用设置
pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    settings.validate()?;

    let path = settings_path(app)?;

    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    write_atomic(&path, &content)
}

/// 写入默认设置并返回
pub fn reset(app: &AppHandle) -> Result<AppSettings, String> {
    let defaults = AppSettings::default();
    save(app, &defaults)?;
    Ok(defaults)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_simple_and_sub_module_ids() {
        assert!(is_valid_module_id("dashboard"));
        assert!(is_valid_module_id("finance/dashboard"));
        assert!(is_valid_module_id("a"));
        assert!(is_valid_module_id("Dashboard-2.x_y/z"));
        assert!(is_valid_module_id("a1/b2/c3"));
        assert!(is_valid_module_id(&"a".repeat(MAX_MODULE_ID_LEN)));
    }

    #[test]
    fn rejects_invalid_module_ids() {
        // 空串
        assert!(!is_valid_module_id(""));
        // 以 / 开头
        assert!(!is_valid_module_id("/dashboard"));
        assert!(!is_valid_module_id("/finance/dashboard"));
        // 父目录跳转
        assert!(!is_valid_module_id(".."));
        // 空格
        assert!(!is_valid_module_id("with space"));
        assert!(!is_valid_module_id("dashboard x"));
        assert!(!is_valid_module_id(" lead"));
        // 超过 128 个字符
        assert!(!is_valid_module_id(&"a".repeat(MAX_MODULE_ID_LEN + 1)));
        // 其他非法字符
        assert!(!is_valid_module_id("-leading"));
        assert!(!is_valid_module_id(".hidden"));
        assert!(!is_valid_module_id("模块"));
        assert!(!is_valid_module_id("mod$"));
        assert!(!is_valid_module_id("a\\b"));
    }

    #[test]
    fn defaults_match_spec() {
        let defaults = AppSettings::default();
        assert_eq!(defaults.default_module, None);
        assert!(!defaults.sidebar_collapsed);
        assert!(defaults.confirm_before_uninstall);
        assert!(defaults.restore_last_module);
        assert_eq!(defaults.last_module, None);
        // 主题默认跟随系统；动效默认开启（不打扰用户的既有体验）
        assert_eq!(defaults.theme, THEME_SYSTEM);
        assert!(!defaults.reduce_motion);
        // 插件默认后台加载；超时为默认值
        assert!(defaults.defer_plugin_loading);
        assert_eq!(defaults.plugin_load_timeout_ms, DEFAULT_PLUGIN_LOAD_TIMEOUT_MS);
        // 标签页默认为空：首次启动不该凭空打开任何标签
        assert!(defaults.open_tabs.is_empty());
        assert_eq!(defaults.active_tab, None);
        // 自动检查更新默认开启；还没有检查过
        assert!(defaults.auto_check_updates);
        assert_eq!(defaults.last_update_check_at, None);
        // 网络默认直连、地址为空：一个默认打开的第三方加速源会把「装什么插件」
        // 交给一个我们无法控制的中间人
        assert_eq!(defaults.network_mode, network::NETWORK_MODE_DIRECT);
        assert_eq!(defaults.github_proxy, "");
        // 日志默认都开：用户不会为了排查问题提前打开它，默认关闭等于默认没有证据
        assert!(defaults.file_logging_enabled);
        assert!(defaults.crash_logging_enabled);
        // 性能模式默认关闭：它是有代价的取舍，只能是用户主动选择的结果
        assert!(!defaults.performance_mode);
        // 毛玻璃默认开启：它的代价只发生在浮层打开的那几秒，
        // 与性能模式那种「常驻换来朴素界面」的取舍方向相反
        assert!(defaults.glass_effect);
        // 提示音默认开启、默认音色、默认音量，且没有自定义文件
        assert!(defaults.notification_sound_enabled);
        assert_eq!(defaults.notification_sound_id, DEFAULT_NOTIFICATION_SOUND_ID);
        assert_eq!(
            defaults.notification_sound_volume,
            DEFAULT_NOTIFICATION_SOUND_VOLUME
        );
        assert_eq!(defaults.notification_sound_custom_file, None);
    }

    /// `impl Default` 与 serde 的缺省值必须逐字段一致。
    ///
    /// 这两处表达的是同一件事（"用户没有做过这个选择"），却有两条独立的代码路径：
    /// 字段缺失时走 `#[serde(default = "...")]`，文件缺失或损坏时走
    /// `AppSettings::default()`。任何一处漏改，都会让「全新安装」与「老设置文件」
    /// 得到不同的默认行为 —— 而这类分叉不会有任何报错，只会让某个开关在两个本该
    /// 相同的情形下一个开一个关。
    ///
    /// 逐字段比对而不是只比一个：这样将来新增字段时，只补了一处就会被立刻发现。
    #[test]
    fn impl_default_matches_serde_defaults() {
        let from_impl = AppSettings::default();
        let from_json: AppSettings =
            serde_json::from_str("{}").expect("空对象应当能反序列化出全部默认值");

        assert_eq!(
            serde_json::to_value(&from_impl).unwrap(),
            serde_json::to_value(&from_json).unwrap(),
            "AppSettings::default() 与「全字段缺失」必须得到完全相同的设置"
        );
    }

    /// 引入网络与日志设置之前写下的 settings.json 没有这五个字段，
    /// 必须回落到各自的默认值（尤其是两个 `true`，不能因为缺失变成关闭）。
    #[test]
    fn network_and_logging_fields_default_on_old_settings_files() {
        let settings: AppSettings = serde_json::from_str("{}").expect("empty object should load");

        assert_eq!(settings.network_mode, network::NETWORK_MODE_DIRECT);
        assert_eq!(settings.github_proxy, "");
        assert!(settings.file_logging_enabled, "缺失时应当按开启处理");
        assert!(settings.crash_logging_enabled, "缺失时应当按开启处理");
        assert!(!settings.performance_mode, "缺失时应当按关闭处理");
        assert!(
            settings.glass_effect,
            "缺失时应当按开启处理 —— 用 `=== true` 那类判据会让老设置文件静默关掉毛玻璃"
        );
        assert!(
            settings.notification_sound_enabled,
            "缺失时应当按开启处理"
        );
        assert_eq!(
            settings.notification_sound_id, DEFAULT_NOTIFICATION_SOUND_ID,
            "缺失时落到默认音色"
        );
        assert_eq!(
            settings.notification_sound_volume, DEFAULT_NOTIFICATION_SOUND_VOLUME,
            "缺失时落到默认音量（不是 0 —— 那会让提示音静音）"
        );

        // 回落到默认值的一份设置本身必须是合法的，否则老用户的第一次保存就会失败
        assert!(settings.validate().is_ok());
    }

    /// 引入更新检查之前写下的 settings.json 没有这两个字段：
    /// 自动检查默认**开启**，而不是因为字段缺失变成关闭。
    #[test]
    fn update_fields_default_to_enabled_on_old_settings_files() {
        let settings: AppSettings = serde_json::from_str("{}").expect("empty object should load");
        assert!(
            settings.auto_check_updates,
            "缺失 autoCheckUpdates 时应当按默认开启处理"
        );
        assert_eq!(settings.last_update_check_at, None);
    }

    /// 网络字段的两条校验规则。
    ///
    /// 这里不重复 `network.rs` 里那套格式用例，只锁定两件**在设置层**才成立的事：
    /// 未知模式被拒绝，以及代理地址在直连模式下也照样校验。
    #[test]
    fn validate_covers_network_fields() {
        let mut settings = AppSettings::default();
        settings.network_mode = network::NETWORK_MODE_PROXY.to_string();
        settings.github_proxy = "https://gh-proxy.org".to_string();
        assert!(settings.validate().is_ok(), "合法的代理配置应当通过");

        settings.network_mode = "off".to_string();
        let err = settings.validate().expect_err("未知的网络模式必须被拒绝");
        assert!(err.contains("networkMode"), "错误信息应当点明字段: {err}");

        // 切回直连之后，那个坏地址仍然要拦下来：否则用户可以「先存坏地址、切到
        // 直连（保存成功）、再切回代理时才发现存不进去」，而报错指向的是一个
        // 他刚刚没碰过的输入框。
        settings.network_mode = network::NETWORK_MODE_DIRECT.to_string();
        settings.github_proxy = "gh-proxy.org".to_string();
        let err = settings
            .validate()
            .expect_err("直连模式下也必须校验代理地址的格式");
        assert!(err.contains("githubProxy"), "错误信息应当点明字段: {err}");
    }

    /// 只接受 RFC3339，拒绝随便一个字符串 —— 它会被拿去算时间差。
    #[test]
    fn rejects_malformed_last_update_check_at() {
        let mut settings = AppSettings::default();

        settings.last_update_check_at = Some("2026-09-18T22:00:00.000Z".to_string());
        assert!(settings.validate().is_ok(), "合法的时间戳应当通过");

        settings.last_update_check_at = Some("昨天".to_string());
        assert!(settings.validate().is_err(), "非 RFC3339 应当被拒绝");

        settings.last_update_check_at = Some("2026-09-18".to_string());
        assert!(settings.validate().is_err(), "只有日期没有时间也应当被拒绝");

        // 未来时间不在后端拒绝：时钟回拨不该让设置无法保存，
        // 「未来时间戳按未检查处理」是前端的判断（见 updateCheck.ts）
        settings.last_update_check_at = Some("2099-01-01T00:00:00Z".to_string());
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn tab_defaults_survive_old_settings_files() {
        // 引入标签页之前写下的 settings.json 没有这两个字段
        let settings: AppSettings = serde_json::from_str("{}").expect("empty object should load");
        assert!(settings.open_tabs.is_empty());
        assert_eq!(settings.active_tab, None);
    }

    #[test]
    fn tab_count_is_capped() {
        let mut settings = AppSettings::default();
        settings.open_tabs = (0..MAX_OPEN_TABS).map(|i| format!("mod{i}")).collect();
        assert!(settings.validate().is_ok(), "上限之内应当通过");

        settings.open_tabs = (0..MAX_OPEN_TABS + 1)
            .map(|i| format!("mod{i}"))
            .collect();
        let err = settings
            .validate()
            .expect_err("超过上限必须被拒绝，否则被改坏的设置会让前端挂载上千个模块");
        assert!(err.contains("openTabs"), "错误信息应当点明是哪个字段: {err}");
    }

    #[test]
    fn tab_ids_are_format_checked() {
        let mut settings = AppSettings::default();

        // 合法的子模块 ID 要放行
        settings.open_tabs = vec!["dashboard".into(), "finance/dashboard".into()];
        settings.active_tab = Some("finance/dashboard".into());
        assert!(settings.validate().is_ok());

        // 非法 ID 必须拒绝
        settings.open_tabs = vec!["dashboard".into(), "../escape".into()];
        assert!(settings.validate().is_err());

        settings.open_tabs = vec!["dashboard".into()];
        settings.active_tab = Some("with space".into());
        assert!(settings.validate().is_err());
    }

    /// `activeTab` 不在 `openTabs` 中时**不报错**。
    ///
    /// 这是刻意的：这种不一致由前端在读取时丢弃 `activeTab` 并回退到第一个
    /// 标签来处理。若在这里拒绝，一次无害的状态错位会变成整个设置保存失败，
    /// 而用户看到的是「改主题没保存」这种毫不相关的现象。
    #[test]
    fn active_tab_outside_open_tabs_is_tolerated() {
        let mut settings = AppSettings::default();
        settings.open_tabs = vec!["dashboard".into()];
        settings.active_tab = Some("plugins".into());
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn plugin_loading_defaults_survive_old_settings_files() {
        // 老版本 settings.json 没有这两个字段，必须回落到「后台加载 + 5s」
        let settings: AppSettings = serde_json::from_str("{}").expect("empty object should load");
        assert!(settings.defer_plugin_loading);
        assert_eq!(settings.plugin_load_timeout_ms, DEFAULT_PLUGIN_LOAD_TIMEOUT_MS);
    }

    #[test]
    fn plugin_timeout_is_bounds_checked() {
        let mut settings = AppSettings::default();
        settings.plugin_load_timeout_ms = MIN_PLUGIN_LOAD_TIMEOUT_MS;
        assert!(settings.validate().is_ok());
        settings.plugin_load_timeout_ms = MAX_PLUGIN_LOAD_TIMEOUT_MS;
        assert!(settings.validate().is_ok());

        settings.plugin_load_timeout_ms = MIN_PLUGIN_LOAD_TIMEOUT_MS - 1;
        assert!(settings.validate().is_err());
        settings.plugin_load_timeout_ms = MAX_PLUGIN_LOAD_TIMEOUT_MS + 1;
        assert!(settings.validate().is_err());
        // 0 是典型的「忘了赋值」，必须被拒绝而不是当成「永不超时」
        settings.plugin_load_timeout_ms = 0;
        assert!(settings.validate().is_err());
    }

    #[test]
    fn partial_json_falls_back_to_defaults() {
        let settings: AppSettings = serde_json::from_str("{}").expect("empty object should load");
        assert!(settings.confirm_before_uninstall);
        assert!(!settings.sidebar_collapsed);
        assert_eq!(settings.default_module, None);
        assert_eq!(settings.theme, THEME_SYSTEM);
        assert!(!settings.reduce_motion);

        let settings: AppSettings =
            serde_json::from_str(r#"{"sidebarCollapsed": true, "lastModule": "finance/dashboard"}"#)
                .expect("partial object should load");
        assert!(settings.sidebar_collapsed);
        assert_eq!(settings.last_module.as_deref(), Some("finance/dashboard"));
        assert!(settings.confirm_before_uninstall);
        // 「恢复上次的窗口状态」的默认值本轮从 false 改为 true，因此**缺字段**
        // （老版本的 settings.json 就是这样）必须落到"开"。
        assert!(settings.restore_last_module);
        // 缺少 theme 字段（老版本 settings.json）必须回落到 system，而不是空串
        assert_eq!(settings.theme, THEME_SYSTEM);

        // 但**显式写着 false 必须被尊重**：默认值可以改，"用户关掉它"不能失效。
        let settings: AppSettings =
            serde_json::from_str(r#"{"restoreLastModule": false}"#).expect("explicit false loads");
        assert!(!settings.restore_last_module);
    }

    #[test]
    fn serializes_with_camel_case_keys() {
        let json = serde_json::to_string(&AppSettings::default()).expect("serialize defaults");
        assert!(json.contains("\"defaultModule\""));
        assert!(json.contains("\"sidebarCollapsed\""));
        assert!(json.contains("\"confirmBeforeUninstall\""));
        assert!(json.contains("\"restoreLastModule\""));
        assert!(json.contains("\"lastModule\""));
        assert!(json.contains("\"theme\""));
        assert!(json.contains("\"reduceMotion\""));
        assert!(json.contains("\"deferPluginLoading\""));
        assert!(json.contains("\"pluginLoadTimeoutMs\""));
        // 网络与日志的字段名同样必须是 camelCase —— 前端按这些键读
        assert!(json.contains("\"networkMode\""));
        assert!(json.contains("\"githubProxy\""));
        assert!(json.contains("\"fileLoggingEnabled\""));
        assert!(json.contains("\"crashLoggingEnabled\""));
        assert!(json.contains("\"performanceMode\""));
        assert!(json.contains("\"glassEffect\""));
        assert!(json.contains("\"notificationSoundEnabled\""));
        assert!(json.contains("\"notificationSoundId\""));
        assert!(json.contains("\"notificationSoundVolume\""));
        assert!(json.contains("\"notificationSoundCustomFile\""));
    }

    #[test]
    fn theme_round_trips_and_rejects_unknown_values() {
        let mut settings = AppSettings::default();
        for mode in [THEME_LIGHT, THEME_DARK, THEME_SYSTEM] {
            settings.theme = mode.to_string();
            assert!(settings.validate().is_ok(), "theme {mode} should be accepted");

            let json = serde_json::to_string(&settings).expect("serialize");
            let back: AppSettings = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back.theme, mode);
        }

        settings.theme = "midnight".to_string();
        assert!(settings.validate().is_err());
        // 空串（例如被手工改坏）同样必须被拒绝
        settings.theme = String::new();
        assert!(settings.validate().is_err());
    }

    // ---------- 主题配色 ----------

    /// 提示音字段的三条校验规则。
    ///
    /// 重点是最后一条：**非法文件名必须在写入时就被拒绝**。只在读取端
    /// （`sound.rs::load`）校验的话，一份坏设置会一直躺在磁盘上 ——
    /// 每次启动都记一条警告，但用户看不到任何异常。
    #[test]
    fn validate_covers_notification_sound_fields() {
        let mut settings = AppSettings::default();
        assert!(settings.validate().is_ok(), "默认值必须合法");

        // 音色 id 只校验格式：未知但格式合法的取值要放行（音色表在前端，
        // 后端复制一份清单必然漂移）
        settings.notification_sound_id = "some-future-sound".to_string();
        assert!(settings.validate().is_ok());
        settings.notification_sound_id = "Bad Id".to_string();
        let err = settings.validate().expect_err("非法音色 id 必须被拒绝");
        assert!(err.contains("notificationSoundId"), "错误信息应点明字段: {err}");
        settings.notification_sound_id = default_notification_sound_id();

        // 音量越界拒绝而不是夹取：合法交互不会产生越界值
        settings.notification_sound_volume = 1.5;
        let err = settings.validate().expect_err("音量越界必须被拒绝");
        assert!(err.contains("notificationSoundVolume"), "错误信息应点明字段: {err}");
        settings.notification_sound_volume = DEFAULT_NOTIFICATION_SOUND_VOLUME;
        assert!(settings.validate().is_ok());

        // 合法文件名
        settings.notification_sound_custom_file = Some("custom.mp3".to_string());
        assert!(settings.validate().is_ok());
        // 空串按「没有自定义音效」处理（前端清空选择时写的就是它）
        settings.notification_sound_custom_file = Some(String::new());
        assert!(settings.validate().is_ok());

        // 非法文件名：路径穿越与非白名单扩展名都必须被拒绝
        for bad in ["../settings.json", "custom.exe", "other.mp3", r"C:\x\y.mp3"] {
            settings.notification_sound_custom_file = Some(bad.to_string());
            let err = settings
                .validate()
                .expect_err(&format!("非法文件名 {bad} 必须被拒绝"));
            assert!(
                err.contains("notificationSoundCustomFile"),
                "错误信息应点明字段: {err}"
            );
        }
    }

    #[test]
    fn accent_defaults_to_indigo_and_survives_old_settings_files() {
        assert_eq!(AppSettings::default().accent, DEFAULT_ACCENT);
        assert_eq!(DEFAULT_ACCENT, "indigo");

        // 老版本 settings.json 没有 accent 字段，必须回落到默认而不是空串
        let settings: AppSettings = serde_json::from_str("{}").expect("empty object should load");
        assert_eq!(settings.accent, DEFAULT_ACCENT);
    }

    #[test]
    fn accent_round_trips() {
        let mut settings = AppSettings::default();
        settings.accent = "emerald".to_string();

        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("\"accent\""));
        let back: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.accent, "emerald");
    }

    /// 配色 id 只校验**格式**，不校验是否为已知配色。
    ///
    /// 这条测试锁定那个刻意的设计决定：配色表在前端，后端复制一份必然漂移，
    /// 而漂移的后果是「前端加了新配色、后端拒绝保存」。未知 id 由前端回退，
    /// 是安全的降级。
    #[test]
    fn accent_format_is_checked_but_unknown_ids_are_accepted() {
        let mut settings = AppSettings::default();

        // 未在前端注册、但格式合法的 id 必须被接受（否则新增配色要改两处）
        settings.accent = "some-future-color".to_string();
        assert!(
            settings.validate().is_ok(),
            "格式合法的未知配色 id 不应被后端拒绝"
        );

        // 合法格式：小写字母、数字、连字符
        for ok in ["a", "blue", "sky-blue", "c1", &"x".repeat(MAX_ACCENT_ID_LEN)] {
            settings.accent = ok.to_string();
            assert!(settings.validate().is_ok(), "应接受: {ok}");
        }

        // 非法格式：空、超长、大写、下划线、空格、点
        for bad in [
            "",
            &"x".repeat(MAX_ACCENT_ID_LEN + 1),
            "Blue",
            "sky_blue",
            "sky blue",
            "sky.blue",
            "#4f46e5",
        ] {
            settings.accent = bad.to_string();
            assert!(settings.validate().is_err(), "应拒绝: {bad:?}");
        }
    }

    #[test]
    fn validate_rejects_bad_module_ids() {
        let mut settings = AppSettings::default();
        assert!(settings.validate().is_ok());

        settings.last_module = Some("finance/dashboard".to_string());
        assert!(settings.validate().is_ok());

        settings.last_module = Some("../escape".to_string());
        assert!(settings.validate().is_err());

        settings.last_module = None;
        settings.default_module = Some("/bad".to_string());
        assert!(settings.default_module.as_deref().is_some());
        assert!(settings.validate().is_err());

        settings.default_module = Some("dashboard".to_string());
        assert!(settings.validate().is_ok());
    }
}
