// src-tauri/src/modules/backup/mod.rs
//
// 备份与恢复模块。
//
// 它提供的是"把应用数据整体带走"的能力：换机器、重装、或者只是想在某次大改动
// 之前留一份可回退的现场。
//
// 三份文件的分工：
//   * `categories.rs` —— 白名单。**能备份什么、能恢复到哪，只有这一处说了算。**
//   * `archive.rs`    —— 备份包的读写（导出、检查、恢复）。
//   * `commands.rs`   —— 命令、系统对话框、以及敏感数据的两道门。
//
// 安全模型的完整说明见 `categories.rs` 的文件头；恢复端的三条防线见
// `archive.rs` 的文件头。

pub mod archive;
pub mod categories;
pub mod commands;

use crate::prelude::*;
use tauri::Manager;

/// 备份模块
pub struct BackupModule;

impl Module for BackupModule {
    fn id(&self) -> &'static str {
        "backup"
    }

    fn name(&self) -> &'static str {
        "备份与恢复"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "把应用数据导出为备份文件，或从备份恢复选定的数据类别"
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        // 只托管"最近打开的备份文件"这一个状态。备份本身不做任何后台工作，
        // 因此没有 `start` 实现，也没有需要 `dependencies` 声明的前置模块。
        app.manage(commands::BackupState::new());

        log::debug!(
            "备份模块已就绪：{} 个可备份类别",
            categories::CATEGORIES.len()
        );
        Ok(())
    }
}
