// src-tauri/src/modules/backup/commands.rs
//
// 备份模块的 Tauri 命令。
//
// 四条命令，构成"看清单 → 导出"与"打开 → 检查 → 恢复"两条闭环：
//
//   list_backup_categories   本机能备份什么、各占多大
//   export_backup            选保存位置并写出备份
//   open_backup              选一个备份文件并检查它的内容
//   restore_backup           把刚打开的那个备份按类别恢复
//
// ---------------------------------------------------------------------------
// 两个刻意的设计
//
// 1. **前端从不传路径给后端去读。** 导出用系统保存对话框，恢复用系统打开对话框；
//    恢复只能作用于"用户刚刚选中的那个文件"。若允许前端指定路径，就等于给了它
//    一个"把任意 zip 解压进应用目录"的原语 —— 而白名单只能约束包内的路径，
//    约束不了包本身从哪来。
//
// 2. **敏感类别要两道门。** 导出时要点开高级开关，恢复时**还要再点一次**。
//    "我当时导出时愿意"与"我现在愿意覆盖本机凭据"是两个不同的决定，
//    一个含有 auth.json 的备份在另一台机器上恢复时尤其如此。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use super::archive::{self, ExportReport, Inspection, RestoreReport};
use super::categories::{self, CategoryInfo, CategorySpec, Roots};

/// 最近一次打开的备份文件
///
/// 存在的理由见文件头第 1 条：恢复只能针对用户刚选中的那个文件，
/// 因此路径必须由后端自己记住，而不是由前端在第二次调用时传进来。
pub struct BackupState(pub Mutex<Option<PathBuf>>);

impl BackupState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for BackupState {
    fn default() -> Self {
        Self::new()
    }
}

/// `open_backup` 的返回：文件位置 + 检查结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedBackup {
    pub path: String,
    pub inspection: Inspection,
}

fn file_path_to_path(path: FilePath) -> Result<PathBuf, String> {
    match path {
        FilePath::Path(buf) => Ok(buf),
        FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "对话框返回了非文件地址".to_string()),
    }
}

/// 把用户勾选的类别 id 解析成白名单条目。
///
/// 这是敏感类别的**第一道门**：只要选中的集合里有敏感类别而高级开关没开，
/// 就直接拒绝。导出与恢复共用它，因此两道门用的是同一条规则。
fn resolve_selection(
    ids: &[String],
    include_sensitive: bool,
) -> Result<Vec<&'static CategorySpec>, String> {
    if ids.is_empty() {
        return Err("没有选择任何类别".to_string());
    }

    let mut selected: Vec<&'static CategorySpec> = Vec::new();
    for id in ids {
        let category = categories::find_category(id)
            .ok_or_else(|| format!("不认识的类别：{id}"))?;

        if category.sensitive && !include_sensitive {
            return Err(format!(
                "「{}」属于授权与安全数据，需要先打开高级选项",
                category.label
            ));
        }

        if !selected.iter().any(|c| c.id == category.id) {
            selected.push(category);
        }
    }

    Ok(selected)
}

/// 保存对话框里的默认文件名
fn default_backup_file_name() -> String {
    format!(
        "modulith-backup-{}.zip",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    )
}

/// 补上 `.zip` 扩展名。
///
/// 用户在保存对话框里把文件名改成没有扩展名的形式是很常见的，而一个没有扩展名的
/// 备份文件在文件管理器里既没有图标也无法双击打开 —— 它仍然能被本应用打开，
/// 但对用户来说它看起来不像一个文件。
fn ensure_zip_extension(path: PathBuf) -> PathBuf {
    let has_zip = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);

    if has_zip {
        path
    } else {
        let mut with_ext = path.clone();
        with_ext.set_extension("zip");
        with_ext
    }
}

/// 列出可备份的类别与本机当前的规模
#[tauri::command]
pub fn list_backup_categories(app: AppHandle) -> Result<Vec<CategoryInfo>, String> {
    let roots = Roots::from_app(&app)?;
    let mut out = Vec::new();
    for category in categories::CATEGORIES {
        out.push(archive::measure(&roots, category)?);
    }
    Ok(out)
}

/// 导出备份（弹出保存对话框）
///
/// 返回 `Ok(None)` 表示用户取消了保存 —— 那是正常操作，不是错误。
#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    categories: Vec<String>,
    include_sensitive: bool,
) -> Result<Option<ExportReport>, String> {
    let selected = resolve_selection(&categories, include_sensitive)?;
    let default_name = default_backup_file_name();
    let roots = Roots::from_app(&app)?;

    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .add_filter("Modulith 备份", &["zip"])
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("无法打开保存对话框：{e}"))?;

    let Some(choice) = picked else {
        return Ok(None);
    };
    let dest = ensure_zip_extension(file_path_to_path(choice)?);

    // 打包是重活，放到阻塞线程池：`async fn` 命令跑在异步运行时上，
    // 在这里同步读几百 MB 会把其它命令一起卡住。
    let report =
        tauri::async_runtime::spawn_blocking(move || archive::export(&roots, &selected, &dest))
            .await
            .map_err(|e| format!("导出失败：{e}"))??;

    Ok(Some(report))
}

/// 打开一个备份文件并检查它的内容（弹出打开对话框）
///
/// 检查只读清单与中央目录，不解压数据。**白名单校验在这里也做一遍** ——
/// 让用户在"选完文件"这一步就知道包有问题，而不是点了恢复才失败。
#[tauri::command]
pub async fn open_backup(
    app: AppHandle,
    state: State<'_, BackupState>,
) -> Result<Option<OpenedBackup>, String> {
    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .add_filter("Modulith 备份", &["zip"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("无法打开文件对话框：{e}"))?;

    let Some(choice) = picked else {
        return Ok(None);
    };
    let path = file_path_to_path(choice)?;

    let inspect_path = path.clone();
    let inspection = tauri::async_runtime::spawn_blocking(move || archive::inspect(&inspect_path))
        .await
        .map_err(|e| format!("读取备份失败：{e}"))??;

    // 检查通过才记住它：一个不合格的包不该留在状态里等下一次恢复去踩
    {
        let mut slot = state
            .0
            .lock()
            .map_err(|_| "备份状态不可用".to_string())?;
        *slot = Some(path.clone());
    }

    Ok(Some(OpenedBackup {
        path: path.to_string_lossy().to_string(),
        inspection,
    }))
}

/// 从最近打开的那个备份恢复指定类别
///
/// `confirm` 必须为 `true`：恢复是**替换**语义，会先删除选中类别的现有数据。
/// 用一个显式参数而不是"界面上有个按钮"来把关，是为了让任何代码路径都无法
/// 在没有经过确认的情况下触发它。
#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    state: State<'_, BackupState>,
    categories: Vec<String>,
    include_sensitive: bool,
    confirm: bool,
) -> Result<RestoreReport, String> {
    if !confirm {
        return Err("恢复会替换本机数据，需要显式确认".to_string());
    }

    let selected = resolve_selection(&categories, include_sensitive)?;

    let path = {
        let slot = state
            .0
            .lock()
            .map_err(|_| "备份状态不可用".to_string())?;
        slot.clone()
    };
    let path = path.ok_or_else(|| "请先打开一个备份文件".to_string())?;
    let roots = Roots::from_app(&app)?;

    let report =
        tauri::async_runtime::spawn_blocking(move || archive::restore(&roots, &path, &selected))
            .await
            .map_err(|e| format!("恢复失败：{e}"))??;

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 敏感类别的两道门：不开高级开关就选不了它。
    #[test]
    fn sensitive_categories_require_the_explicit_switch() {
        let err = resolve_selection(&["auth".to_string()], false)
            .expect_err("未开高级开关时选 auth 必须被拒绝");
        assert!(err.contains("高级选项"), "错误信息应当说明缺什么: {err}");

        let ok = resolve_selection(&["auth".to_string()], true);
        assert!(ok.is_ok(), "开了高级开关就应当允许");
        assert_eq!(ok.unwrap()[0].id, "auth");
    }

    /// 未知类别与空选集都拒绝，且去重
    #[test]
    fn selection_is_validated_and_deduplicated() {
        assert!(resolve_selection(&[], true).is_err());
        assert!(resolve_selection(&["nope".to_string()], true).is_err());

        let selected =
            resolve_selection(&["settings".to_string(), "settings".to_string()], false).unwrap();
        assert_eq!(selected.len(), 1, "重复的类别应当只算一次");
    }

    /// 保存对话框里被删掉扩展名时要补回来
    #[test]
    fn zip_extension_is_restored_when_missing_or_wrong() {
        assert_eq!(
            ensure_zip_extension(PathBuf::from("/tmp/backup")),
            PathBuf::from("/tmp/backup.zip")
        );
        assert_eq!(
            ensure_zip_extension(PathBuf::from("/tmp/backup.ZIP")),
            PathBuf::from("/tmp/backup.ZIP"),
            "已经是大写 .ZIP 的不要动它"
        );
        assert_eq!(
            ensure_zip_extension(PathBuf::from("/tmp/backup.txt")),
            PathBuf::from("/tmp/backup.zip")
        );
    }
}
