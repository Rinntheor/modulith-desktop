// src-tauri/src/modules/notifications/commands.rs
//
// 通知模块的 Tauri 命令。
//
// 同步原语的选择：**刻意使用 `std::sync::Mutex` 且命令都是同步 `fn`**。
//
// 本模块的临界区是「改一个内存 Vec + 写一个小 JSON 文件」，全程没有 `await`，
// 因此不存在 `MutexGuard`（`!Send`）跨 `await` 的问题；同步命令在同一个线程上
// 跑到结束，也不存在两次调用交错导致落盘顺序错乱的情况。
// 若改成 `async fn`，就必须换成 `tokio::sync::Mutex`，因为同步 Mutex 的守卫
// 一旦跨越 `await` 点，编译都过不去。
//
// 返回值约定：**所有会改动数据的命令都返回「当前完整列表」**。
//
// 这是个刻意的取舍。只返回被改动的那一条会让前端必须自己维护「新条目该插到
// 哪、合并键命中时该改哪一条、裁剪时该删哪些」—— 三处逻辑都要与后端保持一致，
// 一旦漂移就是界面与磁盘不一致。列表上限 200 条、实际通常只有个位数，
// 每次多传几十 KB 换取「前端只需整个替换缓存」是划算的。

use super::store::{
    self, Notification, NotificationLevel, MAX_STORED_NOTIFICATIONS,
};
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// 通知的全局状态（由 Tauri 托管）
pub struct NotificationsState(pub Mutex<Vec<Notification>>);

impl NotificationsState {
    pub fn new(list: Vec<Notification>) -> Self {
        Self(Mutex::new(list))
    }
}

/// 推送通知的入参
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNotificationInput {
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub level: NotificationLevel,
    /// 来源模块 ID，缺省为 `host`
    #[serde(default)]
    pub source: String,
    /// 合并键，见 `store::Notification::dedupe_key`
    #[serde(default)]
    pub dedupe_key: Option<String>,
}

/// 未读概览
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSummary {
    pub total: usize,
    pub unread: usize,
}

// ============================================================
// 纯函数部分（不依赖文件系统，因此可以被单元测试直接覆盖）
// ============================================================

/// 读取时的规范化：裁到上限，并保证顺序为「新的在前」
///
/// 放在这里而不是只在写入时做，是因为文件可能被手工改动或来自旧版本。
pub fn normalize_loaded(list: &mut Vec<Notification>) {
    if list.len() > MAX_STORED_NOTIFICATIONS {
        store::prune(list, MAX_STORED_NOTIFICATIONS);
    } else {
        // prune 会顺带排序，但只有超限时才调用它；这里单独保证顺序
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    }
}

/// 标记单条为已读，返回是否命中
pub fn mark_read(list: &mut [Notification], id: &str) -> bool {
    match list.iter_mut().find(|item| item.id == id) {
        Some(item) => {
            item.read = true;
            true
        }
        None => false,
    }
}

/// 标记全部为已读，返回被改动（从「未读」变为「已读」）的条数
pub fn mark_all_read(list: &mut [Notification]) -> usize {
    let mut changed = 0;
    for item in list.iter_mut() {
        if !item.read {
            item.read = true;
            changed += 1;
        }
    }
    changed
}

/// 移除一条通知，返回是否命中
pub fn dismiss(list: &mut Vec<Notification>, id: &str) -> bool {
    let before = list.len();
    list.retain(|item| item.id != id);
    list.len() != before
}

/// 统计总数与未读数
pub fn summarize(list: &[Notification]) -> NotificationSummary {
    NotificationSummary {
        total: list.len(),
        unread: list.iter().filter(|item| !item.read).count(),
    }
}

// ============================================================
// 命令
// ============================================================

/// 列出全部通知（新的在前）
#[tauri::command]
pub fn list_notifications(state: State<'_, NotificationsState>) -> Result<Vec<Notification>, String> {
    let list = state.0.lock().map_err(|e| e.to_string())?;
    Ok(list.clone())
}

/// 推送一条通知
///
/// `source` 用于按模块显示未读徽标；`dedupeKey` 相同且未读时合并为一条。
#[tauri::command]
pub fn push_notification(
    app: AppHandle,
    state: State<'_, NotificationsState>,
    input: PushNotificationInput,
) -> Result<Vec<Notification>, String> {
    let incoming = store::sanitize(
        &input.title,
        &input.body,
        input.level,
        &input.source,
        input.dedupe_key.as_deref(),
    )?;

    let mut list = state.0.lock().map_err(|e| e.to_string())?;
    store::insert(&mut list, incoming);
    store::save(&app, &list)?;
    Ok(list.clone())
}

/// 标记单条已读
#[tauri::command]
pub fn mark_notification_read(
    app: AppHandle,
    state: State<'_, NotificationsState>,
    id: String,
) -> Result<Vec<Notification>, String> {
    let mut list = state.0.lock().map_err(|e| e.to_string())?;
    mark_read(&mut list, &id);
    // 未命中不报错：通知可能刚被「清空全部」删掉，这属于正常的竞态，
    // 界面拿到最新列表即可。
    store::save(&app, &list)?;
    Ok(list.clone())
}

/// 标记全部已读
#[tauri::command]
pub fn mark_all_notifications_read(
    app: AppHandle,
    state: State<'_, NotificationsState>,
) -> Result<Vec<Notification>, String> {
    let mut list = state.0.lock().map_err(|e| e.to_string())?;
    mark_all_read(&mut list);
    store::save(&app, &list)?;
    Ok(list.clone())
}

/// 移除一条通知
#[tauri::command]
pub fn dismiss_notification(
    app: AppHandle,
    state: State<'_, NotificationsState>,
    id: String,
) -> Result<Vec<Notification>, String> {
    let mut list = state.0.lock().map_err(|e| e.to_string())?;
    dismiss(&mut list, &id);
    store::save(&app, &list)?;
    Ok(list.clone())
}

/// 清空全部通知
#[tauri::command]
pub fn clear_notifications(
    app: AppHandle,
    state: State<'_, NotificationsState>,
) -> Result<Vec<Notification>, String> {
    let mut list = state.0.lock().map_err(|e| e.to_string())?;
    list.clear();
    store::save(&app, &list)?;
    Ok(Vec::new())
}

/// 未读概览（供标题栏徽标轮询之外的主动查询使用）
#[tauri::command]
pub fn get_notification_summary(
    state: State<'_, NotificationsState>,
) -> Result<NotificationSummary, String> {
    let list = state.0.lock().map_err(|e| e.to_string())?;
    Ok(summarize(&list))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, read: bool, created_at: &str) -> Notification {
        Notification {
            id: id.to_string(),
            title: format!("通知 {id}"),
            body: String::new(),
            level: NotificationLevel::Info,
            source: "host".to_string(),
            created_at: created_at.to_string(),
            read,
            dedupe_key: None,
            count: 1,
        }
    }

    fn three() -> Vec<Notification> {
        vec![
            sample("a", false, "2026-01-01T00:00:03+00:00"),
            sample("b", false, "2026-01-01T00:00:02+00:00"),
            sample("c", true, "2026-01-01T00:00:01+00:00"),
        ]
    }

    #[test]
    fn mark_read_hits_only_the_target() {
        let mut list = three();
        assert!(mark_read(&mut list, "a"));
        assert!(list[0].read);
        assert!(!list[1].read, "其他条目不应被改动");
    }

    #[test]
    fn mark_read_reports_miss_instead_of_panicking() {
        let mut list = three();
        assert!(!mark_read(&mut list, "does-not-exist"));
    }

    #[test]
    fn mark_all_read_counts_only_changed_entries() {
        let mut list = three();
        // 已经有一条是已读的，因此改动的应当是 2 条而不是 3 条
        assert_eq!(mark_all_read(&mut list), 2);
        assert!(list.iter().all(|item| item.read));
        // 幂等：再来一次没有可改动的
        assert_eq!(mark_all_read(&mut list), 0);
    }

    #[test]
    fn dismiss_removes_exactly_one() {
        let mut list = three();
        assert!(dismiss(&mut list, "b"));
        assert_eq!(list.len(), 2);
        assert!(!list.iter().any(|item| item.id == "b"));
        assert!(!dismiss(&mut list, "b"), "重复移除应当报告未命中");
    }

    #[test]
    fn summarize_counts_total_and_unread() {
        let summary = summarize(&three());
        assert_eq!(summary.total, 3);
        assert_eq!(summary.unread, 2);

        let empty = summarize(&[]);
        assert_eq!(empty.total, 0);
        assert_eq!(empty.unread, 0);
    }

    #[test]
    fn normalize_sorts_newest_first() {
        let mut list = vec![
            sample("old", false, "2026-01-01T00:00:01+00:00"),
            sample("new", false, "2026-01-01T00:00:09+00:00"),
            sample("mid", false, "2026-01-01T00:00:05+00:00"),
        ];

        normalize_loaded(&mut list);

        let ids: Vec<&str> = list.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn normalize_trims_oversized_files() {
        let mut list: Vec<Notification> = (0..MAX_STORED_NOTIFICATIONS + 20)
            .map(|i| {
                sample(
                    &format!("id{i}"),
                    false,
                    // 时间戳递增，保证裁剪掉的是最旧的那批
                    &format!("2026-01-01T00:{:02}:{:02}+00:00", i / 60, i % 60),
                )
            })
            .collect();

        normalize_loaded(&mut list);

        assert_eq!(list.len(), MAX_STORED_NOTIFICATIONS);
        assert_eq!(list[0].id, format!("id{}", MAX_STORED_NOTIFICATIONS + 19));
    }
}
