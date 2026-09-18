// src-tauri/src/sidebar/config.rs

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

/// 侧边栏模块偏好配置（仅包含侧边栏需要的字段）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarPreferences {
    /// 模块显示顺序（ID 列表），越靠前越在上方
    /// 不在列表中的模块按默认 priority 排在最后
    #[serde(default)]
    pub module_order: Vec<String>,

    /// 用户隐藏的模块 ID 列表
    #[serde(default)]
    pub hidden_modules: Vec<String>,

    /// 用户置顶的模块 ID 列表
    #[serde(default)]
    pub pinned_modules: Vec<String>,
}

impl Default for SidebarPreferences {
    fn default() -> Self {
        Self {
            module_order: Vec::new(),
            hidden_modules: Vec::new(),
            pinned_modules: Vec::new(),
        }
    }
}

impl SidebarPreferences {
    /// 获取配置文件路径
    fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?;

        fs::create_dir_all(&app_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;

        Ok(app_dir.join("sidebar_config.json"))
    }

    /// 从磁盘加载配置
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

    /// 保存配置到磁盘
    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = Self::config_path(app)?;

        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        fs::write(&path, content)
            .map_err(|e| format!("Failed to write config file: {}", e))?;

        Ok(())
    }

    /// 重置为默认值
    pub fn reset(app: &AppHandle) -> Result<Self, String> {
        let default_config = Self::default();
        default_config.save(app)?;
        Ok(default_config)
    }
}