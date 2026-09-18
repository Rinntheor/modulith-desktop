// src-tauri/src/module_config/commands.rs
// 模块配置命令

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 模块偏好设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModulePreferences {
    pub module_order: Vec<String>,
    pub hidden_modules: Vec<String>,
    pub pinned_modules: Vec<String>,
    pub favorite_modules: Vec<String>,
    pub recent_modules: Vec<String>,
    pub auto_login_enabled: bool,
    pub verification_hash: Option<String>,
    pub crypto_salt: Option<String>,
}

impl Default for ModulePreferences {
    fn default() -> Self {
        Self {
            module_order: vec![],
            hidden_modules: vec![],
            pinned_modules: vec![],
            favorite_modules: vec![],
            recent_modules: vec![],
            auto_login_enabled: false,
            verification_hash: None,
            crypto_salt: None,
        }
    }
}

/// 模块配置状态
pub struct ModuleConfigState(pub Mutex<ModulePreferences>);

impl ModuleConfigState {
    pub fn new(config: ModulePreferences) -> Self {
        Self(Mutex::new(config))
    }
}

/// 获取模块偏好
#[tauri::command]
pub fn get_module_preferences(
    state: State<ModuleConfigState>,
) -> Result<ModulePreferences, String> {
    let config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(config.clone())
}

/// 重置模块偏好
#[tauri::command]
pub fn reset_module_preferences(
    app: AppHandle,
    state: State<ModuleConfigState>,
) -> Result<ModulePreferences, String> {
    let default = ModulePreferences::default();
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    *config = default.clone();
    save_config(&app, &config)?;
    Ok(default)
}

/// 记录模块打开
#[tauri::command]
pub fn record_module_open(
    app: AppHandle,
    state: State<ModuleConfigState>,
    module_id: String,
) -> Result<(), String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    // 添加到最近使用
    config.recent_modules.retain(|id| id != &module_id);
    config.recent_modules.insert(0, module_id);

    // 限制最近使用数量为 10
    if config.recent_modules.len() > 10 {
        config.recent_modules = config.recent_modules.drain(..10).collect();
    }

    save_config(&app, &config)?;
    Ok(())
}

/// 切换收藏模块
#[tauri::command]
pub fn toggle_favorite_module(
    app: AppHandle,
    state: State<ModuleConfigState>,
    module_id: String,
) -> Result<(), String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    let pos = config.favorite_modules.iter().position(|id| id == &module_id);

    match pos {
        Some(_) => {
            config.favorite_modules.retain(|id| id != &module_id);
        }
        None => {
            config.favorite_modules.push(module_id);
        }
    }

    save_config(&app, &config)?;
    Ok(())
}

/// 获取收藏模块
#[tauri::command]
pub fn get_favorite_modules(
    state: State<ModuleConfigState>,
) -> Result<Vec<String>, String> {
    let config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(config.favorite_modules.clone())
}

/// 获取最近使用模块
#[tauri::command]
pub fn get_recent_modules(
    state: State<ModuleConfigState>,
) -> Result<Vec<String>, String> {
    let config = state.inner().0.lock().map_err(|e|| format!("Lock error: {}", e))?;
    Ok(config.recent_modules.clone())
}

/// 保存配置
fn save_config(app: &AppHandle, config: &ModulePreferences) -> Result<(), String> {
    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Get app data dir failed: {}", e))?
        .join("module_config.json");
    
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Serialize failed: {}", e))?;
    
    std::fs::write(&config_path, content)
        .map_err(|e| format!("Write file failed: {}", e))?;
    
    Ok(())
}

/// 加载配置
pub fn load_config(app: &AppHandle) -> ModulePreferences {
    let config_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("module_config.json"));
    
    if let Some(path) = config_path {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str(&content) {
                    return config;
                }
            }
        }
    }
    
    ModulePreferences::default()
}
