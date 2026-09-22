// src-tauri/src/modules/logging/mod.rs
// 日志模块：运行日志与崩溃记录的落盘、开关与查看
//
// 这个模块的「主体」是 `logger.rs` 里的全局日志器（`log` 门面的后端），
// 它必须在 `main()` 里就被安装 —— 因此 `install_early()` 从本模块再导出一层，
// 让 `main.rs` 只需要 `modulith_desktop_lib::modules::logging::install_early()`
// 一行，不必知道日志器具体是什么类型。

pub mod commands;
pub mod logger;

use crate::prelude::*;

pub use logger::{install_early, FileLogger};

/// 应用日志模块
pub struct LoggingModule;

impl Module for LoggingModule {
    fn id(&self) -> &'static str {
        "logging"
    }

    fn name(&self) -> &'static str {
        "日志"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "运行日志与崩溃记录：写文件、可开关、可查看"
    }

    /// 依赖 `settings`
    ///
    /// **这条依赖一直存在于代码里，只是一直没有声明。** `setup` 直接调用
    /// `settings::settings::load(app)`，而 `dependencies()` 返回空 ——
    /// 于是拓扑排序无从得知这件事，顺序靠"注册表恰好按字母序注册"碰巧正确
    /// （`logging` 在 `settings` 之后）。碰巧正确的顺序不是顺序，是运气。
    fn dependencies(&self) -> Vec<&'static str> {
        vec!["settings"]
    }

    /// 把启动早期排队的记录落盘，并按用户设置决定两个开关
    ///
    /// 这个模块在字母序上排在 `auth` 之后，因此 `auth` setup 里的那几行
    /// `log::info!` 会先进入内存队列 —— 它们不会被丢掉，`configure` 会把队列
    /// 按原顺序补写到文件开头。这正是「安装」与「配置」分成两步的理由。
    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let settings = crate::modules::settings::settings::load(app);
        let logger = logger::install_early();

        match commands::log_dir(app) {
            Ok(dir) => {
                logger.configure(
                    dir,
                    settings.file_logging_enabled,
                    settings.crash_logging_enabled,
                );
                log::info!(
                    "日志系统已就绪：实时记录 {}，崩溃记录 {}",
                    on_off(settings.file_logging_enabled),
                    on_off(settings.crash_logging_enabled)
                );
            }
            Err(e) => {
                // 定位不到日志目录不是致命错误：应用照常运行，只是没有文件日志。
                log::warn!("无法定位日志目录，本次运行不写日志文件: {}", e);
            }
        }

        Ok(())
    }

    /// 退出前把日志冲到磁盘
    ///
    /// **这是 `FileLogger::flush()` 此前唯一合理的调用点，而它一直没有被调用过**
    /// —— 因为应用退出时根本没有任何收尾动作（模块的 `stop` 从未被调用）。
    ///
    /// 平时每次写入都会 flush，因此这里针对的不是"平时丢日志"，而是退出那一刻：
    /// 进程结束之前最后几条记录可能还在缓冲区里，而"关掉应用之后最后几条不见了"
    /// 恰恰是最需要有日志的那一段。
    fn stop(&self, _app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(logger) = logger::global() {
            logger.flush();
        }
        Ok(())
    }
}

/// 用户改了日志开关之后套用（由 `update_app_settings` / `reset_app_settings` 调用）
pub fn apply(file_logging: bool, crash_logging: bool) {
    let Some(logger) = logger::global() else {
        return;
    };

    if logger.set_switches(file_logging, crash_logging) {
        // 这一行必须在 `set_switches` 之后发：它自己在锁里，拿锁时发日志会死锁。
        // 也因此「关掉实时记录」这条记录本身会随设置一起消失 —— 这是可接受的，
        // 用户刚刚亲手做的动作不需要日志来确认。
        log::info!(
            "日志设置已更新：实时记录 {}，崩溃记录 {}",
            on_off(file_logging),
            on_off(crash_logging)
        );
    }
}

fn on_off(value: bool) -> &'static str {
    if value {
        "开启"
    } else {
        "关闭"
    }
}
