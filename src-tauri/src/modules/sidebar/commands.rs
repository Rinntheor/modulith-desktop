// src-tauri/src/modules/sidebar/commands.rs
use crate::modules::sidebar::config::{SidebarPreferences, MAX_RECENT_MODULES};
use tauri::{AppHandle, State};
use std::sync::Mutex;

/// 侧边栏配置的全局状态
pub struct SidebarState(pub Mutex<SidebarPreferences>);

impl SidebarState {
    pub fn new(config: SidebarPreferences) -> Self {
        Self(Mutex::new(config))
    }
}

#[tauri::command]
pub fn get_sidebar_preferences(
    state: State<'_, SidebarState>,
) -> Result<SidebarPreferences, String> {
    let config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(config.clone())
}

/// 获取模块偏好（前端 moduleManager 使用的命令名，与 get_sidebar_preferences 等价）
#[tauri::command]
pub fn get_module_preferences(
    state: State<'_, SidebarState>,
) -> Result<SidebarPreferences, String> {
    let config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(config.clone())
}

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

/// 重置模块偏好（前端 moduleManager 使用的命令名，与 reset_sidebar_preferences 等价）
#[tauri::command]
pub fn reset_module_preferences(
    app: AppHandle,
    state: State<'_, SidebarState>,
) -> Result<SidebarPreferences, String> {
    let default_config = SidebarPreferences::reset(&app)?;
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    *config = default_config.clone();
    Ok(default_config)
}

/// 记录一次模块打开，写入最近使用列表（最新在前，去重，最多 10 条）
#[tauri::command]
pub fn record_module_open(
    app: AppHandle,
    state: State<'_, SidebarState>,
    module_id: String,
) -> Result<Vec<String>, String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    config.recent_modules.retain(|id| id != &module_id);
    config.recent_modules.insert(0, module_id);

    if config.recent_modules.len() > MAX_RECENT_MODULES {
        config.recent_modules.truncate(MAX_RECENT_MODULES);
    }

    let recents = config.recent_modules.clone();
    config.save(&app)?;
    Ok(recents)
}

/// 获取最近使用的模块 ID 列表
#[tauri::command]
pub fn get_recent_modules(
    state: State<'_, SidebarState>,
) -> Result<Vec<String>, String> {
    let config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(config.recent_modules.clone())
}

/// 切换（或显式设置）模块收藏状态
///
/// `favorite` 为 `Some(true)` / `Some(false)` 时按指定值设置，
/// 为 `None` 时在收藏与取消收藏之间切换。
#[tauri::command]
pub fn toggle_favorite_module(
    app: AppHandle,
    state: State<'_, SidebarState>,
    module_id: String,
    favorite: Option<bool>,
) -> Result<Vec<String>, String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    let currently_favorite = config.favorite_modules.iter().any(|id| id == &module_id);
    let should_favorite = favorite.unwrap_or(!currently_favorite);

    if should_favorite {
        if !currently_favorite {
            config.favorite_modules.push(module_id);
        }
    } else {
        config.favorite_modules.retain(|id| id != &module_id);
    }

    let favorites = config.favorite_modules.clone();
    config.save(&app)?;
    Ok(favorites)
}

/// 获取收藏的模块 ID 列表
#[tauri::command]
pub fn get_favorite_modules(
    state: State<'_, SidebarState>,
) -> Result<Vec<String>, String> {
    let config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(config.favorite_modules.clone())
}
