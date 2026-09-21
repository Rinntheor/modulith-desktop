// src-tauri/src/modules/sidebar/config.rs
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

/// 用户自定义的模块分类。
///
/// **一个模块最多属于一个分类** —— 这是划分，不是标签。选择划分的理由在界面上：
/// 分类是仪表盘上一个个分区，而一个模块同时出现在两个分区里时，"把它挪走"这件事
/// 立刻变得含糊（挪哪一个？另一个要不要跟着去掉？）。拖动的语义必须只有一个答案。
///
/// 顺序即显示顺序：`SidebarPreferences::categories` 这个 Vec 的次序就是分区次序，
/// 因此重排就是重排这个数组，不需要额外的 `order` 字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleCategory {
    pub id: String,
    pub name: String,
    /// 属于该分类的模块 ID，顺序即显示顺序
    #[serde(default)]
    pub modules: Vec<String>,
}

/// 分类数量上限。
///
/// 与 `MAX_SIDEBAR_ENTRIES` 同一个用途：这些列表由前端提交、后端直接落盘，
/// 没有上限就等于"反复调用可以把配置文件撑到任意大"。20 个分区在一屏里已经
/// 需要滚动才看得完，够用。
pub const MAX_CATEGORIES: usize = 20;

/// 分类 id 的长度上限
pub const MAX_CATEGORY_ID_LEN: usize = 32;

/// 分类名的长度上限，**按字符计**。
///
/// 按字符而不是字节：一个中文名按字节算是三倍，用字节限制会让中文用户得到的
/// 可用长度只有英文的三分之一，而界面上看起来是同一个输入框。
pub const MAX_CATEGORY_NAME_CHARS: usize = 24;

/// 规范化并校验一个分类名。
///
/// 前后空白直接去掉（用户不该因为多打一个空格而得到一个看起来一样的重名），
/// 但不做其他改写 —— 分类名是用户自己写的东西，替他去大小写或标点是不礼貌的。
pub fn normalize_category_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Err("分类名不能为空".to_string());
    }

    let count = trimmed.chars().count();
    if count > MAX_CATEGORY_NAME_CHARS {
        return Err(format!(
            "分类名最长 {} 个字符（当前 {}）",
            MAX_CATEGORY_NAME_CHARS, count
        ));
    }

    // 控制字符（含换行、制表符与零宽字符）会让界面上的名称与磁盘上的内容看起来
    // 不一样，而排查这类问题时最先被怀疑的偏偏是别处
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("分类名不能包含控制字符".to_string());
    }

    Ok(trimmed.to_string())
}

/// 分类 id 的格式校验。
///
/// 与插件、音效 id 同一套字符集：**id 只由后端生成**，这个函数守的是"一份被手工
/// 改坏的配置文件"。因此它不要求 id 可读，只要求它不可能被拿去拼路径或在界面上
/// 造成歧义。
pub fn is_valid_category_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CATEGORY_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// 生成一个未被占用的分类 id（`cat-1`、`cat-2`…）。
///
/// 用可读的序号而不是随机 id：它只出现在设置文件与日志里，而排查"这个 `cat-7`
/// 是什么"时，能一眼看出它大概是什么时候建的，比一串 uuid 有用。重命名不会改 id。
pub fn next_category_id(existing: &[ModuleCategory]) -> String {
    for n in 1..=(MAX_CATEGORIES + 1) {
        let candidate = format!("cat-{n}");
        if !existing.iter().any(|category| category.id == candidate) {
            return candidate;
        }
    }
    // 逻辑上不可达：调用方先检查了数量上限。给一个仍然合法的兜底值，
    // 而不是 panic —— 分类是附加功能，不该让应用崩掉。
    format!("cat-{}", existing.len() + 1)
}

/// 把模块放进某个分类的指定位置。`category_id` 为 `None` 表示移出所有分类。
///
/// **这是"一个模块最多属于一个分类"这条不变量的唯一执行点**：先把它从所有分类里
/// 摘掉，再放进目标。调用方不需要记得先删再加 —— 而那正是最容易漏、且漏了不报错
/// 的一步（漏掉的结果是同一个模块出现在两个分区里，而界面上看不出这是错的）。
///
/// `index` 是**目标分类内的位置**，超出范围会被夹到末尾。之所以收一个位置而不是
/// "上移一位 / 下移一位"：拖动给出来的本来就是"放在这两张卡片之间"，把它换算成
/// 位移需要后端理解"当前顺序" —— 而前端的当前顺序可能已经过期（一次失败的写盘、
/// 或者刚被另一个入口改过）。收绝对位置，就没有可以算错的地方。
///
/// 抽成纯函数是为了可测：命令层需要 `AppHandle`，单测里造不出来。
pub fn place_module(
    categories: &mut Vec<ModuleCategory>,
    module_id: &str,
    category_id: Option<&str>,
    index: Option<usize>,
) -> Result<(), String> {
    if let Some(id) = category_id {
        if !categories.iter().any(|category| category.id == id) {
            return Err(format!("没有这个分类「{}」", id));
        }
    }

    for category in categories.iter_mut() {
        category.modules.retain(|existing| existing != module_id);
    }

    let Some(id) = category_id else {
        return Ok(());
    };

    if let Some(category) = categories.iter_mut().find(|category| category.id == id) {
        let at = index.unwrap_or(category.modules.len()).min(category.modules.len());
        category.modules.insert(at, module_id.to_string());
    }

    Ok(())
}

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
    /// 用户自定义的模块分类（顺序即显示顺序）
    #[serde(default)]
    pub categories: Vec<ModuleCategory>,
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
            categories: Vec::new(),
        }
    }
}

/// 把一份（可能被手工改坏的）分类表修成可用的形态。
///
/// 与 `load` 的宽容降级同一取向：**读进来的东西不该让应用出问题，也不该被
/// 完全丢弃**。具体做四件事，每件都对应一种"配置文件被手工编辑过"的真实后果：
///
///   1. 丢掉 id 非法、名字为空白、或名字过长的条目 —— 它们会在界面上变成一个
///      点不动的分区，或者一个 id 根本对不上的分类；
///   2. 丢掉重复的 id —— 重复 id 会让 React 的 `key` 冲突，表现为其中一个分区
///      永远无法操作（`appSettings` 的 `openTabs` 去重是同一个理由）；
///   3. **保证一个模块最多出现在一个分类里**（先出现的那一个胜出）—— 这是本
///      模型的不变量，而手工编辑完全可以破坏它；
///   4. 截到数量上限。
pub fn sanitize_categories(categories: Vec<ModuleCategory>) -> Vec<ModuleCategory> {
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_modules = std::collections::HashSet::new();
    let mut kept = Vec::new();

    for mut category in categories {
        if !is_valid_category_id(&category.id) {
            continue;
        }
        let Ok(name) = normalize_category_name(&category.name) else {
            continue;
        };
        if !seen_ids.insert(category.id.clone()) {
            continue;
        }

        category.name = name;
        category.modules.retain(|module_id| {
            seen_modules.insert(module_id.clone())
        });
        kept.push(category);

        if kept.len() >= MAX_CATEGORIES {
            break;
        }
    }

    kept
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

        // 解析成功也不代表内容可用：这个文件是用户可以手工编辑的，而分类表有
        // 一条跨条目的不变量（一个模块只能属于一个分类）是单条目解析检查不到的。
        let mut config = config;
        config.categories = sanitize_categories(std::mem::take(&mut config.categories));

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

    /// 恢复默认偏好。
    ///
    /// **分类不在重置范围内。** 这个按钮的语义是"把显示偏好恢复成默认"，而分类
    /// 是用户自己创建的内容 —— 名字与成员都是他一条条定下来的，与"顺序 / 隐藏 /
    /// 置顶 / 收藏"不是一类东西。顺手删掉用户创建的东西，正是本项目在别处一贯
    /// 避免的做法（备份恢复"先校验后删除"、卸载插件才删它的数据）。
    ///
    /// 想清空分类的用户可以逐个删除，那是明确表达出来的意图。
    pub fn reset(app: &AppHandle) -> Result<Self, String> {
        let preserved = Self::load(app)
            .map(|config| config.categories)
            .unwrap_or_default();

        let mut default_config = Self::default();
        default_config.categories = preserved;
        default_config.save(app)?;
        Ok(default_config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn category(id: &str, name: &str, modules: &[&str]) -> ModuleCategory {
        ModuleCategory {
            id: id.to_string(),
            name: name.to_string(),
            modules: modules.iter().map(|m| m.to_string()).collect(),
        }
    }

    #[test]
    fn category_names_are_trimmed_but_not_rewritten() {
        assert_eq!(normalize_category_name("  工作  ").unwrap(), "工作");
        // 不去大小写、不去标点：名字是用户自己写的东西
        assert_eq!(normalize_category_name("Work!").unwrap(), "Work!");
    }

    #[test]
    fn category_names_reject_the_three_ways_to_be_invisible() {
        assert!(normalize_category_name("").is_err());
        assert!(normalize_category_name("   ").is_err(), "全空白等于空名");
        assert!(normalize_category_name("a\nb").is_err(), "控制字符会让界面与磁盘不一致");
        assert!(
            normalize_category_name(&"字".repeat(MAX_CATEGORY_NAME_CHARS + 1)).is_err(),
            "超长要拒绝"
        );
        // **按字符而不是字节计数**：24 个汉字必须是合法的，否则中文用户得到的
        // 可用长度只有英文的三分之一，而界面上看是同一个输入框
        assert!(normalize_category_name(&"字".repeat(MAX_CATEGORY_NAME_CHARS)).is_ok());
    }

    #[test]
    fn category_ids_only_accept_the_generated_shape() {
        assert!(is_valid_category_id("cat-1"));
        assert!(!is_valid_category_id(""));
        assert!(!is_valid_category_id("Cat-1"), "大写不在生成范围内");
        assert!(!is_valid_category_id("cat_1"));
        // id 会被前端拿来当 React key，也会出现在日志里；它不该能拼出路径
        assert!(!is_valid_category_id("../x"));
        assert!(!is_valid_category_id(&"a".repeat(MAX_CATEGORY_ID_LEN + 1)));
    }

    #[test]
    fn next_id_skips_the_ones_already_taken() {
        assert_eq!(next_category_id(&[]), "cat-1");
        let existing = vec![category("cat-1", "A", &[]), category("cat-3", "B", &[])];
        assert_eq!(next_category_id(&existing), "cat-2", "要填最小的空位，而不是取最大值加一");
    }

    #[test]
    fn sanitize_drops_broken_entries_and_keeps_the_rest() {
        let raw = vec![
            category("cat-1", "  工作  ", &["notes", "plugins"]),
            category("CAT-2", "大写 id", &[]),          // id 非法 → 丢
            category("cat-3", "   ", &[]),               // 名字全空白 → 丢
            category("cat-1", "重复 id", &["kanban"]),   // 重复 id → 丢
            category("cat-4", "娱乐", &["pomodoro"]),
        ];

        let kept = sanitize_categories(raw);
        let ids: Vec<&str> = kept.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["cat-1", "cat-4"]);
        assert_eq!(kept[0].name, "工作", "名字在保留时被规范化");
    }

    /// 一个模块只能属于一个分类 —— 这是本模型的不变量，而手工编辑配置文件
    /// 完全可以破坏它。破坏之后的界面表现是两个分区里出现同一张卡片，
    /// 而"把它挪走"该挪哪一个就没有答案了。
    #[test]
    fn sanitize_enforces_one_category_per_module() {
        let raw = vec![
            category("cat-1", "工作", &["notes", "plugins"]),
            category("cat-2", "娱乐", &["notes", "pomodoro"]),
        ];

        let kept = sanitize_categories(raw);
        assert_eq!(kept[0].modules, vec!["notes", "plugins"], "先出现的那个胜出");
        assert_eq!(kept[1].modules, vec!["pomodoro"], "后面的那一份被摘掉");
    }

    #[test]
    fn sanitize_caps_the_number_of_categories() {
        let raw: Vec<ModuleCategory> = (1..=(MAX_CATEGORIES + 5))
            .map(|n| category(&format!("cat-{n}"), &format!("分类{n}"), &[]))
            .collect();
        assert_eq!(sanitize_categories(raw).len(), MAX_CATEGORIES);
    }

    // ========== place_module ==========

    #[test]
    fn placing_without_an_index_appends() {
        let mut cats = vec![category("cat-1", "工作", &["notes"])];
        place_module(&mut cats, "plugins", Some("cat-1"), None).unwrap();
        assert_eq!(cats[0].modules, vec!["notes", "plugins"]);
    }

    /// 分类内拖动重排：同一个分类、换一个位置。**不能变成"追加到末尾"** ——
    /// 那正是"先删再加"的直觉写法会得到的结果，而它会让向下拖动永远无效。
    #[test]
    fn placing_inside_the_same_category_reorders() {
        let mut cats = vec![category("cat-1", "工作", &["a", "b", "c"])];
        place_module(&mut cats, "c", Some("cat-1"), Some(0)).unwrap();
        assert_eq!(cats[0].modules, vec!["c", "a", "b"]);

        place_module(&mut cats, "c", Some("cat-1"), Some(2)).unwrap();
        assert_eq!(cats[0].modules, vec!["a", "b", "c"]);
    }

    #[test]
    fn placing_across_categories_moves_rather_than_copies() {
        let mut cats = vec![
            category("cat-1", "工作", &["notes", "plugins"]),
            category("cat-2", "娱乐", &["pomodoro"]),
        ];
        place_module(&mut cats, "notes", Some("cat-2"), Some(0)).unwrap();

        assert_eq!(cats[0].modules, vec!["plugins"], "从原分类里被摘掉");
        assert_eq!(cats[1].modules, vec!["notes", "pomodoro"]);
        // 不变量：一个模块只在一个分类里
        let appearances = cats
            .iter()
            .flat_map(|c| c.modules.iter())
            .filter(|id| id.as_str() == "notes")
            .count();
        assert_eq!(appearances, 1);
    }

    #[test]
    fn placing_without_a_category_removes_it_everywhere() {
        let mut cats = vec![category("cat-1", "工作", &["notes"]), category("cat-2", "娱乐", &["notes"])];
        // 手工构造的重复成员：placement 要先把它从所有分类里摘干净
        place_module(&mut cats, "notes", None, None).unwrap();
        assert!(cats.iter().all(|c| c.modules.is_empty()));
    }

    #[test]
    fn placing_clamps_a_too_large_index() {
        let mut cats = vec![category("cat-1", "工作", &["a"])];
        place_module(&mut cats, "b", Some("cat-1"), Some(99)).unwrap();
        assert_eq!(cats[0].modules, vec!["a", "b"], "越界的位置夹到末尾，而不是报错");
    }

    #[test]
    fn placing_into_a_missing_category_is_an_error_and_changes_nothing() {
        let mut cats = vec![category("cat-1", "工作", &["notes"])];
        assert!(place_module(&mut cats, "plugins", Some("cat-9"), None).is_err());
        assert_eq!(cats[0].modules, vec!["notes"], "校验失败时不能已经动过数据");
    }

    /// 老版本的配置文件里没有 `categories` 字段，升级后必须仍然能读出来。
    #[test]
    fn a_config_without_categories_still_parses() {
        let legacy = r#"{
            "module_order": ["plugins"],
            "hidden_modules": [],
            "pinned_modules": [],
            "favorite_modules": ["notes"],
            "recent_modules": ["notes"]
        }"#;

        let parsed: SidebarPreferences = serde_json::from_str(legacy).expect("老配置必须能解析");
        assert!(parsed.categories.is_empty());
        assert_eq!(parsed.favorite_modules, vec!["notes"], "其它字段不受影响");
    }
}