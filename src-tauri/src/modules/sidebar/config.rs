// src-tauri/src/modules/sidebar/config.rs
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

/// 侧边栏模块偏好配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarPreferences {
    #[serde(default)]
    pub module_order: Vec<String>,
    #[serde(default)]
    pub hidden_modules: Vec<String>,
    #[serde(default)]
    pub pinned_modules: Vec<String>,
    /// 用户收藏的模块 ID 列表
    #[serde(default)]
    pub favorite_modules: Vec<String>,
    /// 最近打开的模块 ID 列表（最新在前，最多 10 个）
    #[serde(default)]
    pub recent_modules: Vec<String>,
}

/// 最近使用列表的最大长度
pub const MAX_RECENT_MODULES: usize = 10;

impl Default for SidebarPreferences {
    fn default() -> Self {
        Self {
            module_order: Vec::new(),
            hidden_modules: Vec::new(),
            pinned_modules: Vec::new(),
            favorite_modules: Vec::new(),
            recent_modules: Vec::new(),
        }
    }
}

impl SidebarPreferences {
    fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?;

        fs::create_dir_all(&app_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;

        Ok(app_dir.join("sidebar_config.json"))
    }

    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let path = Self::config_path(app)?;

        if !path.exists() {
            let default_config = Self::default();
            default_config.save(app)?;
            return Ok(default_config);
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read config file: {}", e))?;

        let config: Self = serde_json::from_str(&content)
            .unwrap_or_else(|_| Self::default());

        Ok(config)
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = Self::config_path(app)?;

        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        fs::write(&path, content)
            .map_err(|e| format!("Failed to write config file: {}", e))?;

        Ok(())
    }

    pub fn reset(app: &AppHandle) -> Result<Self, String> {
        let default_config = Self::default();
        default_config.save(app)?;
        Ok(default_config)
    }
}