// src-tauri/src/modules/sidebar/commands.rs
use crate::modules::settings::settings::{is_valid_module_id, MAX_MODULE_ID_LEN};
use crate::modules::sidebar::config::{SidebarPreferences, MAX_RECENT_MODULES};
use tauri::{AppHandle, State};
use std::sync::Mutex;

/// 侧边栏偏好中各个列表的长度上限（顺序、隐藏、置顶、收藏各自独立计算）。
///
/// 这些列表全部由前端提交、后端直接落盘，而**此前完全不校验** —— 插件可以直接
/// invoke 这些命令塞进任意长度、任意内容的字符串。上限取 256：真实模块总数不可能
/// 接近它，而它把「反复调用把配置文件与内存撑大」这条路径截断掉。
const MAX_SIDEBAR_ENTRIES: usize = 256;

/// 校验调用方提交的模块 ID 列表：每项合法、无重复、条目数受限。
///
/// 抽成纯函数是为了可测 —— 命令层需要 `AppHandle`，单测里造不出来。
fn validate_module_ids(label: &str, ids: &[String]) -> Result<(), String> {
    if ids.len() > MAX_SIDEBAR_ENTRIES {
        return Err(format!(
            "{} 的条目数 {} 超过上限 {}",
            label,
            ids.len(),
            MAX_SIDEBAR_ENTRIES
        ));
    }

    let mut seen = std::collections::HashSet::new();
    for id in ids {
        ensure_module_id(label, id)?;
        if !seen.insert(id.as_str()) {
            return Err(format!("{} 含重复的模块 ID \"{}\"", label, id));
        }
    }

    Ok(())
}

/// 校验单个模块 ID 的格式（命令参数直接来自调用方，必须当成不可信输入）。
fn ensure_module_id(label: &str, id: &str) -> Result<(), String> {
    if !is_valid_module_id(id) {
        return Err(format!(
            "{} 含非法的模块 ID \"{}\"：只允许字母、数字与 . _ / -，最长 {} 字符，且必须由字母或数字开头",
            label, id, MAX_MODULE_ID_LEN
        ));
    }
    Ok(())
}

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
    validate_module_ids("moduleOrder", &order)?;

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
    ensure_module_id("hiddenModules", &module_id)?;

    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if hidden {
        if !config.hidden_modules.contains(&module_id) {
            if config.hidden_modules.len() >= MAX_SIDEBAR_ENTRIES {
                return Err(format!("隐藏模块数量已达上限 {}", MAX_SIDEBAR_ENTRIES));
            }
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
    ensure_module_id("pinnedModules", &module_id)?;

    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if pinned {
        if !config.pinned_modules.contains(&module_id) {
            if config.pinned_modules.len() >= MAX_SIDEBAR_ENTRIES {
                return Err(format!("置顶模块数量已达上限 {}", MAX_SIDEBAR_ENTRIES));
            }
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
    ensure_module_id("moduleOrder", &module_id)?;

    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if !config.module_order.contains(&module_id) {
        if config.module_order.len() >= MAX_SIDEBAR_ENTRIES {
            return Err(format!("模块顺序条目数已达上限 {}", MAX_SIDEBAR_ENTRIES));
        }
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
    ensure_module_id("recentModules", &module_id)?;

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
    ensure_module_id("favoriteModules", &module_id)?;

    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    let currently_favorite = config.favorite_modules.iter().any(|id| id == &module_id);
    let should_favorite = favorite.unwrap_or(!currently_favorite);

    if should_favorite {
        if !currently_favorite {
            if config.favorite_modules.len() >= MAX_SIDEBAR_ENTRIES {
                return Err(format!("收藏模块数量已达上限 {}", MAX_SIDEBAR_ENTRIES));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 单个模块 ID 的格式校验：命令参数直接来自调用方（包括插件），必须当成不可信输入。
    #[test]
    fn module_ids_are_validated() {
        assert!(ensure_module_id("x", "dashboard").is_ok());
        assert!(ensure_module_id("x", "finance/dashboard").is_ok());
        assert!(ensure_module_id("x", "Dashboard-2.x_y").is_ok());

        let too_long = "a".repeat(MAX_MODULE_ID_LEN + 1);
        for bad in [
            "",
            "..",
            "/dashboard",
            "with space",
            "模块",
            ".hidden",
            too_long.as_str(),
        ] {
            assert!(ensure_module_id("x", bad).is_err(), "应当拒绝: {}", bad);
        }
    }

    /// 列表校验：重复与超限都必须被拒绝，且"正好等于上限"要放行。
    #[test]
    fn module_id_lists_reject_duplicates_and_oversize() {
        assert!(validate_module_ids("x", &["dashboard".into(), "plugins".into()]).is_ok());

        assert!(validate_module_ids("x", &["dashboard".into(), "dashboard".into()]).is_err());

        // 任一项非法即整表拒绝
        assert!(validate_module_ids("x", &["dashboard".into(), "with space".into()]).is_err());

        let at_limit: Vec<String> = (0..MAX_SIDEBAR_ENTRIES).map(|i| format!("m{i}")).collect();
        assert!(validate_module_ids("x", &at_limit).is_ok());

        let too_many: Vec<String> = (0..MAX_SIDEBAR_ENTRIES + 1)
            .map(|i| format!("m{i}"))
            .collect();
        assert!(validate_module_ids("x", &too_many).is_err());
    }
}
