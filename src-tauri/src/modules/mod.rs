// src-tauri/src/modules/mod.rs
// 此文件由 scripts/generate-backend-module.ts 自动生成
// 请勿手动编辑 - DO NOT EDIT MANUALLY
//
// 这里**刻意不写生成时间**：本文件已入库，若写入时间戳，每次生成都会产生
// 差异 —— 表现为「构建一次就把工作区弄脏」，且会让「生成器一致性」的 CI
// 检查（生成后 git diff --exit-code）永远失败。生成是可重复的，
// 需要追溯时间时查 git 历史即可。

pub mod auth;
pub mod backup;
pub mod logging;
pub mod net;
pub mod notifications;
pub mod plugins;
pub mod settings;
pub mod sidebar;
pub mod updater;

use crate::core::registry::ModuleRegistry;
use crate::core::module::Module;

/// 注册所有后端模块
pub fn register_all(registry: &mut ModuleRegistry) -> Result<(), crate::core::registry::RegistryError> {
    registry.register(Box::new(auth::AuthModule))?;
    registry.register(Box::new(backup::BackupModule))?;
    registry.register(Box::new(logging::LoggingModule))?;
    registry.register(Box::new(net::NetModule))?;
    registry.register(Box::new(notifications::NotificationsModule))?;
    registry.register(Box::new(plugins::PluginsModule))?;
    registry.register(Box::new(settings::SettingsModule))?;
    registry.register(Box::new(sidebar::SidebarModule))?;
    registry.register(Box::new(updater::UpdaterModule))?;
    Ok(())
}

/// 获取所有模块 ID 列表
pub fn list_all_module_ids() -> Vec<String> {
    vec![
        auth::AuthModule.id().to_string(),
        backup::BackupModule.id().to_string(),
        logging::LoggingModule.id().to_string(),
        net::NetModule.id().to_string(),
        notifications::NotificationsModule.id().to_string(),
        plugins::PluginsModule.id().to_string(),
        settings::SettingsModule.id().to_string(),
        sidebar::SidebarModule.id().to_string(),
        updater::UpdaterModule.id().to_string(),
    ]
}
