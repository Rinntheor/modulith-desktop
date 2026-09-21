// src-tauri/src/modules/sidebar/commands.rs
use crate::modules::settings::settings::{is_valid_module_id, MAX_MODULE_ID_LEN};
use crate::modules::sidebar::config::{
    is_valid_category_id, next_category_id, normalize_category_name, place_module, ModuleCategory,
    SidebarPreferences, MAX_CATEGORIES, MAX_RECENT_MODULES,
};
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

// ============================================================
// 用户自定义的模块分类
// ============================================================
//
// 六个命令的返回值统一是**整张分类表**，而不是"成功 / 失败"或"改完的那一条"。
// 理由：前端拿到权威结果就不必自己维护一份乐观副本，而"乐观副本 + 后端真值"
// 这两份东西迟早会分叉 —— `appSettings` 的乐观更新要显式回滚，正是那个代价。
// 分类表很小（上限 20 条），每次整体返回的开销可以忽略。
//
// 三个共同的不变量，散落在下面几条命令里但只有一份定义：
//   · 一个模块最多属于一个分类（划分，不是标签）；
//   · 分类名非空、不超长、**不区分大小写地不重名**；
//   · 数量不超过 `MAX_CATEGORIES`。

/// 取分类表（只读）
#[tauri::command]
pub fn get_module_categories(
    state: State<'_, SidebarState>,
) -> Result<Vec<ModuleCategory>, String> {
    let config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(config.categories.clone())
}

/// 名称是否已被占用（比较前去掉前后空白并转小写）
///
/// 大小写不敏感是刻意的：`工作` 与 `工作` 之间的差别用户看不见，而"我明明建了
/// 一个却提示已存在"比"多了两个看起来一样的分类"更容易解释。
fn name_taken(categories: &[ModuleCategory], name: &str, except_id: Option<&str>) -> bool {
    let needle = name.to_lowercase();
    categories.iter().any(|category| {
        Some(category.id.as_str()) != except_id && category.name.to_lowercase() == needle
    })
}

/// 新建一个分类（返回整张表）。id 由后端生成，调用方不提交 id
#[tauri::command]
pub fn create_module_category(
    app: AppHandle,
    state: State<'_, SidebarState>,
    name: String,
) -> Result<Vec<ModuleCategory>, String> {
    let name = normalize_category_name(&name)?;

    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if config.categories.len() >= MAX_CATEGORIES {
        return Err(format!("分类数量已达上限 {}", MAX_CATEGORIES));
    }
    if name_taken(&config.categories, &name, None) {
        return Err(format!("已经有一个叫「{}」的分类了", name));
    }

    let id = next_category_id(&config.categories);
    config.categories.push(ModuleCategory {
        id,
        name,
        modules: Vec::new(),
    });

    config.save(&app)?;
    Ok(config.categories.clone())
}

#[tauri::command]
pub fn rename_module_category(
    app: AppHandle,
    state: State<'_, SidebarState>,
    id: String,
    name: String,
) -> Result<Vec<ModuleCategory>, String> {
    let name = normalize_category_name(&name)?;
    if !is_valid_category_id(&id) {
        return Err(format!("非法的分类 ID「{}」", id));
    }

    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if name_taken(&config.categories, &name, Some(&id)) {
        return Err(format!("已经有一个叫「{}」的分类了", name));
    }

    let Some(category) = config.categories.iter_mut().find(|c| c.id == id) else {
        return Err(format!("没有这个分类「{}」", id));
    };
    category.name = name;

    config.save(&app)?;
    Ok(config.categories.clone())
}

/// 删除一个分类。**成员模块回到「未分类」，一个都不删** —— 删掉分类不等于让
/// 那些模块从界面上消失，那会是"点了一下，东西不见了"。
#[tauri::command]
pub fn delete_module_category(
    app: AppHandle,
    state: State<'_, SidebarState>,
    id: String,
) -> Result<Vec<ModuleCategory>, String> {
    if !is_valid_category_id(&id) {
        return Err(format!("非法的分类 ID「{}」", id));
    }

    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;
    config.categories.retain(|category| category.id != id);

    config.save(&app)?;
    Ok(config.categories.clone())
}

/// 重排分类。提交的必须是**当前全部 id 的一个排列** —— 少一个或多一个都拒绝。
///
/// 为什么要求完整排列而不是"把 X 移到第 n 位"：后者需要后端理解"当前顺序"，
/// 而前端的当前顺序可能已经过期（两个窗口、或一次失败的写盘）。收一份完整排列，
/// 后端就只做一次"这确实是同一批 id"的校验，没有可以算错的地方。
#[tauri::command]
pub fn reorder_module_categories(
    app: AppHandle,
    state: State<'_, SidebarState>,
    ids: Vec<String>,
) -> Result<Vec<ModuleCategory>, String> {
    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    if ids.len() != config.categories.len() {
        return Err(format!(
            "重排需要提交全部 {} 个分类的 id（收到 {} 个）",
            config.categories.len(),
            ids.len()
        ));
    }
    {
        let mut seen = std::collections::HashSet::new();
        for id in &ids {
            if !is_valid_category_id(id) {
                return Err(format!("非法的分类 ID「{}」", id));
            }
            if !seen.insert(id.as_str()) {
                return Err(format!("重排列表含重复的分类 ID「{}」", id));
            }
            if !config.categories.iter().any(|category| &category.id == id) {
                return Err(format!("没有这个分类「{}」", id));
            }
        }
    }

    let mut reordered = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Some(category) = config.categories.iter().find(|c| &c.id == id) {
            reordered.push(category.clone());
        }
    }
    config.categories = reordered;

    config.save(&app)?;
    Ok(config.categories.clone())
}

/// 把一个模块放进某个分类；`category_id` 为 `None` 时把它移出所有分类。
///
/// `index` 是目标分类内的位置（`None` = 追加到末尾），**用来支持分类内的拖动重排**。
/// 位置由拖动方给出而不是由后端推算：拖动表达的是"放在这两张卡片之间"，
/// 后端若要去理解"上移一位"就得先知道前端的当前顺序，而那个顺序可能已经过期。
#[tauri::command]
pub fn set_module_category(
    app: AppHandle,
    state: State<'_, SidebarState>,
    module_id: String,
    category_id: Option<String>,
    index: Option<usize>,
) -> Result<Vec<ModuleCategory>, String> {
    ensure_module_id("categories", &module_id)?;
    if let Some(id) = &category_id {
        if !is_valid_category_id(id) {
            return Err(format!("非法的分类 ID「{}」", id));
        }
    }

    let mut config = state.inner().0.lock().map_err(|e| format!("Lock error: {}", e))?;

    // 先取出再放回：`place_module` 需要可变借用整个表，而 `config.categories`
    // 是它的字段 —— 直接借用会与 `config.save(&app)` 的不可变借用在同一作用域里
    // 打架（save 需要 `&self`）。
    let mut categories = std::mem::take(&mut config.categories);
    let result = place_module(&mut categories, &module_id, category_id.as_deref(), index);
    config.categories = categories;
    result?;

    config.save(&app)?;
    Ok(config.categories.clone())
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
