// src-tauri/src/modules/plugins/mod.rs
// 运行时插件系统模块

pub mod commands;
pub mod background_manifest;
pub mod data_dir;
pub mod data_root;
pub mod db;
pub mod file_grants;
pub mod icon;
pub mod manager;
pub mod permissions;
pub mod quota;
pub mod rpc;
pub mod sandbox;
pub mod signature;
pub mod shortcuts;
pub mod surfaces;
pub mod theme;
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
        // 插件数据库的连接表由**插件模块**托管（而不是 desktop 那一边）：
        // 它服务的是 `ctx.db`，而 `ctx` 的语义全部在 `plugins/` 里。
        app.manage(db::PluginDatabases::new());
        // 用户授权的文件访问（`ctx.files`）。**会话级**：它只在内存里，
        // 进程一退就没了。这不是省事，而是这个能力能被接受的前提 ——
        // 见 `file_grants.rs` 的文件头。
        app.manage(file_grants::FileGrants::new());
        Ok(())
    }
}
