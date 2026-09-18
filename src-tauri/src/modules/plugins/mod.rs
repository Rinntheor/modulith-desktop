// src-tauri/src/modules/plugins/mod.rs
// 运行时插件系统模块

pub mod commands;
pub mod icon;
pub mod manager;
pub mod permissions;
pub mod signature;
pub mod types;
pub mod validator;

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::prelude::*;

/// 插件系统的全局状态（由 Tauri 托管）
pub struct PluginState(pub Arc<RwLock<manager::PluginManager>>);

/// 插件系统模块
pub struct PluginsModule;

impl Module for PluginsModule {
    fn id(&self) -> &'static str {
        "plugins"
    }

    fn name(&self) -> &'static str {
        "插件系统"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "运行时插件系统：安装、启用/禁用、卸载、导出"
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let manager = manager::PluginManager::new(app.clone())?;
        log::info!(
            "插件系统已就绪：插件目录 {}，数据目录 {}",
            manager.plugins_dir().display(),
            manager.data_dir().display()
        );
        app.manage(PluginState(Arc::new(RwLock::new(manager))));
        Ok(())
    }
}
