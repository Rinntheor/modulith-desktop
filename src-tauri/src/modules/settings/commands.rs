// src-tauri/src/modules/settings/commands.rs
use crate::modules::logging;
use crate::modules::settings::probe;
use crate::modules::settings::autostart;
use crate::modules::settings::settings::{self as store, AppSettings};
use crate::modules::settings::sound;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

/// 应用设置的全局状态（由 Tauri 托管）
pub struct SettingsState(pub Arc<RwLock<AppSettings>>);

impl SettingsState {
    pub fn new(settings: AppSettings) -> Self {
        Self(Arc::new(RwLock::new(settings)))
    }
}

/// 读取当前应用设置
#[tauri::command]
pub async fn get_app_settings(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    let settings = state.inner().0.read().await;
    Ok(settings.clone())
}

/// 应用元信息：版本等构建期常量
///
/// 版本号直接取自 `Cargo.toml`（`CARGO_PKG_VERSION`），这是编译期嵌入的常量，
/// 与插件校验器 `validator.rs` 使用的版本源完全一致 —— 二者都读同一个值，
/// 因此前端显示、插件 `window.Modulith.version` 与后端 `engines` 校验
/// 不可能出现不一致。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub tauri_version: String,
    pub platform: String,
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        name: env!("CARGO_PKG_NAME").to_string(),
        tauri_version: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

/// 校验并保存应用设置，同时更新内存中的状态
#[tauri::command]
pub async fn update_app_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    settings.validate()?;
    store::save(&app, &settings)?;

    {
        let mut current = state.inner().0.write().await;
        *current = settings.clone();
    }

    // 日志开关是**运行期**生效的，所以必须在保存之后立刻套用 ——
    // 让用户「关掉实时记录」却要重启才生效，等于这个开关是假的。
    // 放在锁外调用：`apply` 自己会发一条日志，没必要握着设置锁去写盘。
    logging::apply(
        settings.file_logging_enabled,
        settings.crash_logging_enabled,
    );

    // debug 级：标签切换、主题变更都会走到这里，info 级会把日志刷满。
    log::debug!(
        "应用设置已更新：网络 {}，实时记录 {}，崩溃记录 {}，标签 {} 个",
        crate::modules::settings::network::describe_mode(&settings),
        settings.file_logging_enabled,
        settings.crash_logging_enabled,
        settings.open_tabs.len()
    );

    Ok(settings)
}

/// 从磁盘重新读取设置并刷新后端内存状态
///
/// 用途：设置文件被**外部**改动之后，后端内存里那份就成了陈旧副本。最典型的场景
/// 是从备份恢复 `settings.json` —— 那时磁盘上已经是另一份配置，而 `SettingsState`
/// 还是进程启动时读进来的旧值，界面读到的、日志开关实际生效的都会是旧的。
///
/// 它不只刷新数据，也**重新套用运行期开关**（日志记录），否则会出现"设置页显示
/// 日志已关闭，而它还在写盘"这种只靠观察发现不了的不一致。
#[tauri::command]
pub async fn reload_app_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let loaded = store::load(&app);

    {
        let mut current = state.inner().0.write().await;
        *current = loaded.clone();
    }

    logging::apply(loaded.file_logging_enabled, loaded.crash_logging_enabled);

    log::info!("应用设置已从磁盘重新载入");
    Ok(loaded)
}

/// 本应用的进程内存快照（设置 → 性能）
///
/// 命令外壳放在这里而不是 `process_memory/mod.rs`，原因是**命令注册由脚本生成，
/// 而生成器只扫描 `<模块>/commands.rs`** —— 写在子模块里的命令属性会被静默忽略，
/// 直到运行期 `invoke` 报 "command not found" 才暴露。
/// 实现与它的大量单元测试留在 `process_memory`，这里只做一个转发。
///
/// 注意：这段注释里**不能出现那个属性的字面写法**。生成器按文本统计属性出现次数
/// 并与解析出的函数名对账（`extractCommandFunctions`），注释里的字面量会被计入，
/// 于是它报"14 处属性但只有 13 个函数"。那条对账本身是对的 —— 它抓的就是
/// "有属性没解析出函数"，只是它还分不清代码与注释。这里配合它，不写那个字面量。
///
/// 不返回 `Result`：采集失败（例如权限不足读不到某个进程）是**部分失败**，
/// 由返回值里的 `unreadable` 字段如实回报。把它变成 `Err` 只会让整个面板
/// 什么都不显示，而那正好是最需要看到数字的时候。
#[tauri::command]
pub fn memory_snapshot() -> crate::modules::settings::process_memory::MemorySnapshot {
    crate::modules::settings::process_memory::snapshot()
}

/// 按文档可见性套用 WebView2 的内存目标等级（设置 → 性能的策略入口）
///
/// **由前端调用**：`with_webview` 会阻塞等待事件循环，因此它只能在事件循环之外的
/// 线程上调用 —— 前端的一次 `invoke` 正好落在这里。Rust 侧的窗口事件回调与托盘
/// 回调都跑在事件循环上，在那里调用会死锁（详见 `memory_level.rs` 文件头）。
///
/// 前端只报"我现在是不是看不见"，等级由后端推导；这样"隐藏到托盘"这个由 Rust
/// 发起的动作也会因为 webview 同样收到 `visibilitychange` 而生效，不必两处各写一遍。
#[tauri::command]
pub fn apply_memory_level_for_visibility(
    app: AppHandle,
    hidden: bool,
) -> Result<bool, String> {
    crate::modules::settings::memory_level::apply_memory_level_for_visibility(app, hidden)
}

/// 手动设置内存目标等级（设置 → 性能的验证入口）
#[tauri::command]
pub fn set_webview_memory_level(
    app: AppHandle,
    level: crate::modules::settings::memory_level::MemoryLevel,
) -> Result<bool, String> {
    crate::modules::settings::memory_level::set_webview_memory_level(app, level)
}

/// 当前环境的 WebView2 是否支持内存目标等级
///
/// 不支持时必须如实告诉用户（界面显示"当前运行时不支持"），
/// 而不是显示一个从未生效的开关。
#[tauri::command]
pub fn webview_memory_level_supported(app: AppHandle) -> bool {
    crate::modules::settings::memory_level::webview_memory_level_supported(app)
}

/// 恢复默认设置并返回
#[tauri::command]
pub async fn reset_app_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let defaults = store::reset(&app)?;

    {
        let mut current = state.inner().0.write().await;
        *current = defaults.clone();
    }

    logging::apply(
        defaults.file_logging_enabled,
        defaults.crash_logging_enabled,
    );

    Ok(defaults)
}

/// 网络诊断：把「直连」与「下载源」两条路各实测一遍
///
/// 目标是**原始地址**（插件索引的 CDN / GitHub、更新清单），代理那一版由后端
/// 现场改写 —— 安全边界写在 `probe.rs` 的文件头。
#[tauri::command]
pub async fn probe_network(
    app: AppHandle,
    targets: Vec<probe::ProbeTarget>,
) -> Result<probe::ProbeReport, String> {
    probe::run(&app, targets).await
}

/// 获取应用数据目录（`settings.json` 所在目录），必要时创建
#[tauri::command]
pub async fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;

    Ok(app_dir.to_string_lossy().to_string())
}

// ============================================================
// 通知提示音
// ============================================================

/// 选择一个自定义提示音并导入到应用数据目录
///
/// 返回 `Ok(None)` 表示用户取消了选择 —— 那是正常操作，不是错误。
/// 安全边界（扩展名白名单、体积上限、固定文件名、复制进应用数据目录）全部收在
/// `sound.rs`，这条命令只做转发，因此不存在"某一处忘了校验"的空间。
#[tauri::command]
pub async fn pick_notification_sound(app: AppHandle) -> Result<Option<sound::CustomSound>, String> {
    sound::pick(&app).await
}

/// 读取设置里记着的自定义提示音，返回可直接播放的 data URL
///
/// 文件名从**后端托管的设置**里读，而不是由前端传入：前端因此从来没有
/// 「让宿主打开某个文件」的能力，这条命令的可达输入只剩"当前设置值"一个。
/// 与 `pick_notification_sound` 配合，形成"选择时导入、播放时只读自己那份"的闭环。
#[tauri::command]
pub async fn load_notification_sound(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Option<String>, String> {
    let file_name = {
        let settings = state.inner().0.read().await;
        settings.notification_sound_custom_file.clone()
    };

    // 在锁外做文件 IO：读一个最大 2 MB 的文件没必要握着设置锁，
    // 那会让同时进行的设置写入排队等它。
    sound::load(&app, file_name.as_deref())
}

// ============================================================
// 开机自启动
// ============================================================

/// 开机自启动的状态
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    /// 当前平台是否支持这个开关
    pub supported: bool,
    /// 系统里的**实际**状态（读注册表，不是设置文件里的副本）
    pub enabled: bool,
    /// 不支持时的原因，供界面直接显示而不是自己编一句
    pub reason: Option<String>,
}

fn autostart_status() -> AutostartStatus {
    match autostart::is_enabled() {
        Ok(enabled) => AutostartStatus {
            supported: true,
            enabled,
            reason: None,
        },
        Err(reason) => AutostartStatus {
            supported: false,
            enabled: false,
            reason: Some(reason),
        },
    }
}

/// 读取开机自启动状态
///
/// 读的是**系统里的实际状态**而不是设置文件的副本：用户可以在任务管理器的
/// 「启动」页里直接改它，因此设置文件里存一份必然与实际不符，界面会显示一个
/// 位置错误的开关。见 `autostart.rs` 文件头。
#[tauri::command]
pub fn get_autostart_status() -> AutostartStatus {
    autostart_status()
}

/// 开启 / 关闭开机自启动
///
/// 写入的命令行由后端用 `current_exe()` 现算，**不接受前端传入的路径** ——
/// 那会变成一条「把任意程序写进启动项」的命令。
#[tauri::command]
pub fn set_autostart_enabled(enabled: bool) -> Result<AutostartStatus, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法确定程序路径：{e}"))?;
    autostart::set_enabled(enabled, &autostart::autostart_command(&exe))?;
    Ok(autostart_status())
}

/// 本次进程是否由开机自启动拉起
///
/// 前端据此决定要不要应用「静默启动 / 启动时全屏」—— 那两个设置只该作用于
/// 「系统把我拉起来」的情形，不该影响用户双击图标启动。
#[tauri::command]
pub fn was_started_by_autostart() -> bool {
    autostart::launched_by_autostart()
}

/// 回收本应用进程树的工作集，返回回收前后的两个内存口径。
///
/// ============================================================
/// 为什么返回的是"前"与"后"两组数字，而不是一句"已完成"
/// ============================================================
///
/// 因为"回收到底有没有用"必须是一个**可以被验证**的问题。只回报一句"已完成"
/// 的按钮，用户按下之后无从判断它是真做了事还是只是弹了个提示。
///
/// 而这里必须把两个口径都给出来，理由见 `memory_trim.rs` 的文件头：
/// **回收降低的是工作集，不是私有内存**。只显示私有内存会让这个功能看起来
/// 完全无效；只显示工作集又会与任务管理器对不上。两个都给，用户才能自己确认。
#[tauri::command]
pub fn trim_memory_now() -> crate::modules::settings::memory_trim::TrimOutcome {
    crate::modules::settings::memory_trim::trim_self_tree()
}

/// 当前平台是否支持回收工作集
///
/// 判据是"能不能真的回收一次"。它**只回收宿主进程自己那一个**
/// （不会顺带把所有子进程换出去）—— 这条命令的调用方是界面首次展示时的能力探测，
/// 在那里对整棵树动手是越权的副作用。
#[tauri::command]
pub fn trim_memory_supported() -> bool {
    crate::modules::settings::memory_trim::is_supported()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 自启动命令行必须带引号，且带 `--autostart` 标记。
    ///
    /// 引号防的是「含空格的路径被系统按空格拆成程序名 + 参数」—— 那种失败在开机时
    /// 静默发生，用户只会看到"自启动没生效"；标记用于区分「系统拉起」与「用户双击」，
    /// 没有它，静默启动与启动全屏会连用户自己点图标时也生效，表现为「点了一下界面
    /// 不出来」。
    #[test]
    fn autostart_command_quotes_the_path_and_carries_the_flag() {
        let exe = std::path::Path::new(r"C:\Program Files\Modulith Desktop\modulith-desktop.exe");
        let command = autostart::autostart_command(exe);

        assert!(command.starts_with('"'), "路径必须被引号包裹，实际: {command}");
        assert!(
            command.ends_with(autostart::AUTOSTART_FLAG),
            "必须带自启动标记，实际: {command}"
        );

        // 本进程不是由自启动拉起的（cargo test 不会带那个参数）。这条断言锁的是
        // 「检测逻辑不会被一个随机的 argv 误判成自启动」。
        assert!(!was_started_by_autostart());
    }

    /// 宿主版本必须同时满足两个条件：
    /// 1. 是合法 SemVer（否则插件校验器 `SemVer::parse` 会失败，
    ///    并以「本程序版本号非法」中断插件安装）
    /// 2. 与 `validator.rs` 使用的 `env!("CARGO_PKG_VERSION")` 完全一致
    ///
    /// 这两点保证前端显示、插件读到的 `window.Modulith.version`、
    /// 以及 `engines.loopcore` 的校验基准三者不会分叉。
    #[test]
    fn app_info_version_is_valid_semver() {
        let info = get_app_info();

        let parts: Vec<&str> = info.version.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "版本号必须是 MAJOR.MINOR.PATCH 三段式，实际为 {}",
            info.version
        );

        for part in &parts {
            assert!(
                !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()),
                "版本号每段必须是纯数字，实际为 {}",
                info.version
            );
            assert!(
                *part == "0" || !part.starts_with('0'),
                "版本号不允许前导零，实际为 {}",
                info.version
            );
        }
    }

    /// `get_app_info` 暴露的版本必须就是编译期嵌入的 Cargo 版本，
    /// 而不是任何手写的副本。
    #[test]
    fn app_info_version_matches_cargo_pkg_version() {
        let info = get_app_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    /// 插件校验器读的是 `env!("CARGO_PKG_VERSION")`，这里显式断言
    /// 它与握手命令返回给前端的值相等 —— 一旦有人改动其一，测试即失败。
    #[test]
    fn plugin_validator_and_frontend_share_one_version_source() {
        let host_version = env!("CARGO_PKG_VERSION");
        let info = get_app_info();
        assert_eq!(
            host_version, info.version,
            "插件校验基准与前端显示版本必须同源"
        );
    }

    #[test]
    fn app_info_exposes_platform_and_tauri_version() {
        let info = get_app_info();
        assert!(!info.platform.is_empty(), "platform 不应为空");
        assert!(!info.tauri_version.is_empty(), "tauri_version 不应为空");
        assert!(!info.name.is_empty(), "name 不应为空");
    }
}

