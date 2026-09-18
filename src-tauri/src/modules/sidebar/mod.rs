pub mod commands;
pub mod config;

use crate::prelude::*;
use tauri::Manager;

/// Sidebar 模块结构体
pub struct SidebarModule;

impl Module for SidebarModule {
    fn id(&self) -> &'static str {
        "sidebar"
    }

    fn name(&self) -> &'static str {
        "侧边栏管理"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "管理侧边栏模块的显示、排序和隐藏"
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let config = config::SidebarPreferences::load(app)?;
        app.manage(commands::SidebarState::new(config));
        Ok(())
    }
}