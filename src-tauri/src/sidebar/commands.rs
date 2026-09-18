// src-tauri/src/sidebar/commands.rs

use crate::sidebar::config::SidebarPreferences;
use tauri::{AppHandle, State};
use std::sync::Mutex;

/// 侧边栏配置的全局状态
pub struct SidebarState(pub Mutex<SidebarPreferences>);

impl SidebarState {
    pub fn new(config: SidebarPreferences) -> Self {
        Self(Mutex::new(config))
    }
}

/// 获取当前侧边栏配置
#[tauri::command]
pub fn get_sidebar_preferences(
    state: State<'_, SidebarState>,
) -> Result<SidebarPreferences, String> {
    let config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(config.clone())
}

/// 更新模块排序
#[tauri::command]
pub fn update_module_order(
    app: AppHandle,
    state: State<'_, SidebarState>,
    order: Vec<String>,
) -> Result<(), String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    config.module_order = order;
    config.save(&app)?;
    Ok(())
}

/// 切换模块隐藏状态
#[tauri::command]
pub fn toggle_module_visibility(
    app: AppHandle,
    state: State<'_, SidebarState>,
    module_id: String,
    hidden: bool,
) -> Result<(), String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if hidden {
        if !config.hidden_modules.contains(&module_id) {
            config.hidden_modules.push(module_id);
        }
    } else {
        config.hidden_modules.retain(|id| id != &module_id);
    }

    config.save(&app)?;
    Ok(())
}

/// 切换模块置顶状态
#[tauri::command]
pub fn toggle_module_pin(
    app: AppHandle,
    state: State<'_, SidebarState>,
    module_id: String,
    pinned: bool,
) -> Result<(), String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if pinned {
        if !config.pinned_modules.contains(&module_id) {
            config.pinned_modules.insert(0, module_id);
        }
    } else {
        config.pinned_modules.retain(|id| id != &module_id);
    }

    config.save(&app)?;
    Ok(())
}

/// 将模块移动到指定位置
#[tauri::command]
pub fn move_module_position(
    app: AppHandle,
    state: State<'_, SidebarState>,
    module_id: String,
    new_index: usize,
) -> Result<(), String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if !config.module_order.contains(&module_id) {
        config.module_order.push(module_id.clone());
    }

    config.module_order.retain(|id| id != &module_id);

    let insert_index = new_index.min(config.module_order.len());
    config.module_order.insert(insert_index, module_id);

    config.save(&app)?;
    Ok(())
}

/// 重置侧边栏配置
#[tauri::command]
pub fn reset_sidebar_preferences(
    app: AppHandle,
    state: State<'_, SidebarState>,
) -> Result<SidebarPreferences, String> {
    let default_config = SidebarPreferences::reset(&app)?;
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    *config = default_config.clone();
    Ok(default_config)
}