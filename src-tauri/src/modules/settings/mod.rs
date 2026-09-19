// src-tauri/src/modules/settings/mod.rs
// 应用全局设置模块

pub mod autostart;
pub mod commands;
pub mod network;
pub mod probe;
pub mod settings;

use crate::prelude::*;
use tauri::Manager;

/// 应用设置模块
pub struct SettingsModule;

impl Module for SettingsModule {
    fn id(&self) -> &'static str {
        "settings"
    }

    fn name(&self) -> &'static str {
        "应用设置"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "应用的全局设置：默认启动模块、侧边栏状态等"
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let current = settings::load(app);
        log::info!(
            "应用设置已就绪：默认模块 {:?}，侧边栏折叠 {}，恢复上次模块 {}",
            current.default_module,
            current.sidebar_collapsed,
            current.restore_last_module
        );
        app.manage(commands::SettingsState::new(current));
        Ok(())
    }
}
