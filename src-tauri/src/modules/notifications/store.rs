// src-tauri/src/modules/notifications/store.rs
//
// 通知的持久化存储。
//
// 为什么单独一个文件，而不是塞进 settings.json：
//   1. 生命周期不同。settings.json 承载的是**用户配置**，损坏时的正确降级是
//      「回到默认值」；通知是**事件记录**，损坏时的正确降级是「没有通知」，
//      而不是凭空生成一条默认通知。
//   2. 写入频率不同。每条通知都会落盘，而设置只在用户改动时写入。混在一起
//      会让每次通知都重写用户的配置文件。
//   3. 数量级不同。设置是几十个字段，通知上限 200 条。
//
// 所以这里复制了 settings 的原子写入写法，而不是复用它的 save/load ——
// 两者共用的是「怎么写文件」，不共用「文件里是什么」。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;
use tauri::Manager;

/// 通知存储的文件名（位于 `app_data_dir()` 下）
pub const NOTIFICATIONS_FILE_NAME: &str = "notifications.json";

/// 保留的通知条数上限
///
/// 达到上限后优先丢弃**已读且最旧**的记录；如果全部未读，则丢弃最旧的未读
/// 记录。后者是真实的信息损失，因此只在超限时发生 —— 一条也不丢会让文件无界
/// 增长，而通知中心本身不是审计日志（审计日志是 auth 模块的登录记录）。
pub const MAX_STORED_NOTIFICATIONS: usize = 200;

/// 各字段的长度上限。超限时**截断而不是拒绝** ——
/// 通知是「顺带告诉你一件事」，因为标题长了 5 个字就让整条通知消失是错的。
pub const MAX_ID_LEN: usize = 64;
pub const MAX_TITLE_LEN: usize = 120;
pub const MAX_BODY_LEN: usize = 1000;
pub const MAX_SOURCE_LEN: usize = 128;
pub const MAX_DEDUPE_KEY_LEN: usize = 128;

/// 通知级别
///
/// 序列化为小写字符串（`info` / `success` / `warning` / `error`），
/// 与前端 `NotificationLevel` 联合类型一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationLevel {
    Info,
    Success,
    Warning,
    Error,
}

/// 一条通知
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// 唯一 ID，进程内生成，格式 `<毫秒时间戳>-<序号>`
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub level: NotificationLevel,
    /// 来源模块 ID，宿主自身的通知固定为 `host`
    ///
    /// 用于在侧边栏与标签页上按模块显示未读徽标，因此必须能直接当模块 ID 用。
    pub source: String,
    /// 创建时间（RFC3339，本地时区无关，统一 UTC）
    pub created_at: String,
    #[serde(default)]
    pub read: bool,
    /// 合并键：同键的未读通知不会新增，而是合并进已存在的那一条
    ///
    /// 存在的理由很具体：模块很容易在循环或重试里连续产生同一件事的通知
    /// （例如「网络不可用」反复触发）。没有合并键时通知中心会被同一条信息刷满，
    /// 用户反而看不到真正重要的那一条。
    #[serde(default)]
    pub dedupe_key: Option<String>,
    /// 被合并的次数，首条为 1
    #[serde(default = "default_count")]
    pub count: u32,
}

fn default_count() -> u32 {
    1
}

/// 通知文件的根结构
///
/// 用对象而不是裸数组包裹：将来要加字段（例如「上次全部已读的时间」）时
/// 不必改变文件的最外层类型，旧文件仍然能解析。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NotificationsFile {
    #[serde(default)]
    pub notifications: Vec<Notification>,
}

/// 进程内自增序号，保证同一毫秒内生成的多条通知 ID 不同
static ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// 生成一个通知 ID
///
/// 刻意不引第三方 uuid crate：ID 只需要在这个存储内唯一，而
/// 「毫秒时间戳 + 进程内自增序号」已经满足 —— 跨进程重启后毫秒值必然推进。
pub fn next_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{millis}-{seq}")
}

/// 当前时间的 RFC3339 表示
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 按字符（而不是字节）截断到上限，避免切断多字节字符
fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

/// 清洗一条传入的通知：截断超长字段、补齐必需字段
///
/// 返回 `Err` 只用于**无法补救**的情况：标题为空。一条没有标题的通知在界面上
/// 只能显示成一个空行，那不如明确拒绝。
pub fn sanitize(
    title: &str,
    body: &str,
    level: NotificationLevel,
    source: &str,
    dedupe_key: Option<&str>,
) -> Result<Notification, String> {
    let title = truncate_chars(title.trim(), MAX_TITLE_LEN);
    if title.is_empty() {
        return Err("通知标题不能为空".to_string());
    }

    let source = {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            "host".to_string()
        } else {
            truncate_chars(trimmed, MAX_SOURCE_LEN)
        }
    };

    let dedupe_key = dedupe_key
        .map(|key| truncate_chars(key.trim(), MAX_DEDUPE_KEY_LEN))
        .filter(|key| !key.is_empty());

    Ok(Notification {
        id: truncate_chars(&next_id(), MAX_ID_LEN),
        title,
        body: truncate_chars(body.trim(), MAX_BODY_LEN),
        level,
        source,
        created_at: now_rfc3339(),
        read: false,
        dedupe_key,
        count: 1,
    })
}

/// 插入或合并一条通知，并执行容量裁剪
///
/// 合并规则：存在**未读**且 `dedupe_key` 相同的记录时，就地更新它
/// （标题/正文/级别用新的，`count` 加一，`created_at` 刷新为当前时间）。
/// 已读的同键记录不参与合并 —— 用户已经看过那件事了，再发生一次应当是新的一条。
pub fn insert(list: &mut Vec<Notification>, incoming: Notification) {
    if let Some(key) = incoming.dedupe_key.as_deref() {
        if let Some(existing) = list
            .iter_mut()
            .find(|item| !item.read && item.dedupe_key.as_deref() == Some(key))
        {
            existing.title = incoming.title;
            existing.body = incoming.body;
            existing.level = incoming.level;
            existing.created_at = incoming.created_at;
            existing.count = existing.count.saturating_add(1);
            return;
        }
    }

    list.push(incoming);
    prune(list, MAX_STORED_NOTIFICATIONS);
}

/// 裁剪到 `max` 条：优先丢弃「已读且最旧」的，不够再丢最旧的未读
///
/// 顺序上先看已读，是因为已读记录的剩余价值最低；只有在全部未读时才动未读记录。
pub fn prune(list: &mut Vec<Notification>, max: usize) {
    if list.len() <= max {
        return;
    }

    // 时间戳是 RFC3339 且统一 UTC，因此字典序即时间序，不必解析
    list.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let overflow = list.len() - max;

    // 第一轮：从头开始丢已读的
    let mut dropped = 0;
    let mut index = 0;
    while dropped < overflow && index < list.len() {
        if list[index].read {
            list.remove(index);
            dropped += 1;
        } else {
            index += 1;
        }
    }

    // 第二轮：仍然超限说明未读太多，从最旧的开始丢
    while list.len() > max {
        list.remove(0);
    }

    // 统一为「新的在前」，界面与命令都按这个顺序消费
    list.reverse();
}

/// 通知文件的完整路径（必要时创建应用数据目录）
pub fn notifications_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;

    Ok(app_dir.join(NOTIFICATIONS_FILE_NAME))
}

/// 从指定路径读取
///
/// 文件不存在或内容损坏都返回空列表。这里与设置模块的容错取向一致：
/// **通知读不出来不该有任何阻断效果**，最多是用户看不到历史通知。
pub fn load_from(path: &Path) -> Vec<Notification> {
    if !path.exists() {
        return Vec::new();
    }

    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) => {
            log::warn!("读取通知文件失败，按无通知处理: {e}");
            return Vec::new();
        }
    };

    match serde_json::from_str::<NotificationsFile>(&content) {
        Ok(file) => file.notifications,
        Err(e) => {
            log::warn!("解析通知文件失败，按无通知处理: {e}");
            Vec::new()
        }
    }
}

/// 原子写入指定路径：先写同目录临时文件，再 rename 覆盖
///
/// 与 settings 的做法相同，理由也相同：进程在写入中途退出时，
/// 目标文件要么是旧的完整内容，要么是新的完整内容，不会是被截断的 JSON。
pub fn save_to(path: &Path, list: &[Notification]) -> Result<(), String> {
    let file = NotificationsFile {
        notifications: list.to_vec(),
    };

    let content = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("Failed to serialize notifications: {e}"))?;

    let tmp_path = path.with_file_name(format!("{NOTIFICATIONS_FILE_NAME}.tmp"));

    fs::write(&tmp_path, content).map_err(|e| format!("Failed to write notifications: {e}"))?;

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to replace notifications file: {e}"));
    }

    Ok(())
}

/// 读取通知（面向 `AppHandle` 的封装）
pub fn load(app: &AppHandle) -> Vec<Notification> {
    match notifications_path(app) {
        Ok(path) => load_from(&path),
        Err(e) => {
            log::warn!("读取通知路径失败，按无通知处理: {e}");
            Vec::new()
        }
    }
}

/// 持久化通知
pub fn save(app: &AppHandle, list: &[Notification]) -> Result<(), String> {
    let path = notifications_path(app)?;
    save_to(&path, list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(title: &str, source: &str, dedupe: Option<&str>) -> Notification {
        sanitize(title, "", NotificationLevel::Info, source, dedupe).expect("应当构造成功")
    }

    #[test]
    fn sanitize_rejects_empty_title() {
        assert!(sanitize("", "", NotificationLevel::Info, "host", None).is_err());
        assert!(sanitize("   ", "", NotificationLevel::Info, "host", None).is_err());
    }

    #[test]
    fn sanitize_truncates_instead_of_rejecting() {
        let long_title = "标".repeat(MAX_TITLE_LEN + 50);
        let long_body = "文".repeat(MAX_BODY_LEN + 50);

        let item = sanitize(
            &long_title,
            &long_body,
            NotificationLevel::Warning,
            "dashboard",
            None,
        )
        .expect("超长应当截断而不是拒绝");

        assert_eq!(item.title.chars().count(), MAX_TITLE_LEN);
        assert_eq!(item.body.chars().count(), MAX_BODY_LEN);
        // 截断必须按字符而不是字节，否则会把多字节字符切成乱码
        assert!(item.title.chars().all(|c| c == '标'));
    }

    #[test]
    fn sanitize_defaults_empty_source_to_host() {
        let item = sanitize("标题", "", NotificationLevel::Info, "   ", None).expect("应当成功");
        assert_eq!(item.source, "host");
    }

    #[test]
    fn ids_are_unique_within_a_process() {
        let a = next_id();
        let b = next_id();
        assert_ne!(a, b, "同一毫秒内也必须不同");
    }

    #[test]
    fn insert_merges_same_unread_dedupe_key() {
        let mut list = Vec::new();
        insert(&mut list, make("网络不可用", "dashboard", Some("net-down")));
        insert(&mut list, make("网络不可用", "dashboard", Some("net-down")));
        insert(&mut list, make("网络不可用", "dashboard", Some("net-down")));

        assert_eq!(list.len(), 1, "同键未读应当合并为一条");
        assert_eq!(list[0].count, 3);
    }

    #[test]
    fn insert_does_not_merge_into_a_read_entry() {
        let mut list = Vec::new();
        insert(&mut list, make("网络不可用", "dashboard", Some("net-down")));
        list[0].read = true;

        insert(&mut list, make("网络不可用", "dashboard", Some("net-down")));

        assert_eq!(list.len(), 2, "已读的同键记录不参与合并，应当新增一条");
    }

    #[test]
    fn insert_without_dedupe_key_always_appends() {
        let mut list = Vec::new();
        insert(&mut list, make("一", "host", None));
        insert(&mut list, make("一", "host", None));
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn prune_drops_read_entries_first() {
        let mut list = Vec::new();
        for i in 0..5 {
            let mut item = make(&format!("第{i}条"), "host", None);
            // 最旧的三条标记为已读
            item.read = i < 3;
            item.created_at = format!("2026-01-01T00:00:0{i}+00:00");
            list.push(item);
        }

        // 5 条裁到 3 条，只需丢 2 条
        prune(&mut list, 3);

        assert_eq!(list.len(), 3);
        let titles: Vec<&str> = list.iter().map(|i| i.title.as_str()).collect();

        // 丢的应当是最旧的两条已读记录，且**只丢需要的数量** ——
        // 第2条虽然已读，但溢出的 2 条已经由第0、第1条满足，不该动它
        assert!(!titles.contains(&"第0条"));
        assert!(!titles.contains(&"第1条"));
        assert!(titles.contains(&"第2条"));
        // 未读的一条都不能丢
        assert!(titles.contains(&"第3条"));
        assert!(titles.contains(&"第4条"));
    }

    /// 已读记录不足以填满溢出量时，才会动未读记录，且同样从最旧的开始。
    #[test]
    fn prune_falls_back_to_oldest_unread_only_when_necessary() {
        let mut list = Vec::new();
        for i in 0..5 {
            let mut item = make(&format!("第{i}条"), "host", None);
            // 只有第0条是已读的
            item.read = i == 0;
            item.created_at = format!("2026-01-01T00:00:0{i}+00:00");
            list.push(item);
        }

        // 5 条裁到 2 条，需要丢 3 条，但只有 1 条已读
        prune(&mut list, 2);

        assert_eq!(list.len(), 2);
        let titles: Vec<&str> = list.iter().map(|i| i.title.as_str()).collect();
        // 保留的必须是最新的两条未读
        assert_eq!(titles, vec!["第4条", "第3条"]);
    }

    #[test]
    fn prune_keeps_newest_when_all_unread() {
        let mut list = Vec::new();
        for i in 0..5 {
            let mut item = make(&format!("第{i}条"), "host", None);
            item.created_at = format!("2026-01-01T00:00:0{i}+00:00");
            list.push(item);
        }

        prune(&mut list, 2);

        assert_eq!(list.len(), 2);
        // 结果按「新的在前」排序
        assert_eq!(list[0].title, "第4条");
        assert_eq!(list[1].title, "第3条");
    }

    #[test]
    fn prune_is_a_noop_below_the_cap() {
        let mut list = vec![make("一", "host", None), make("二", "host", None)];
        prune(&mut list, 10);
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("modulith-notif-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(NOTIFICATIONS_FILE_NAME);

        let mut list = vec![make("第一条", "dashboard", None)];
        list.push(make("第二条", "plugins", None));
        save_to(&path, &list).expect("save");

        let loaded = load_from(&path);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].title, "第一条");

        // 原子写入不应留下临时文件
        assert!(!path
            .with_file_name(format!("{NOTIFICATIONS_FILE_NAME}.tmp"))
            .exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_of_missing_or_corrupt_file_yields_empty() {
        let dir = std::env::temp_dir().join(format!("modulith-notif-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(NOTIFICATIONS_FILE_NAME);

        assert!(load_from(&path).is_empty(), "文件不存在时应当是空列表");

        fs::write(&path, "{ not json").expect("write");
        assert!(load_from(&path).is_empty(), "内容损坏时应当是空列表");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 老文件缺字段时仍要能解析出来 —— 例如 `count` / `read` 是后加的。
    #[test]
    fn deserializes_minimal_entry() {
        let json = r#"{"notifications":[{
            "id":"1-0",
            "title":"只有必填字段",
            "level":"info",
            "source":"host",
            "createdAt":"2026-01-01T00:00:00+00:00"
        }]}"#;

        let file: NotificationsFile = serde_json::from_str(json).expect("应当能解析");
        assert_eq!(file.notifications.len(), 1);
        assert_eq!(file.notifications[0].count, 1, "count 缺省应为 1");
        assert!(!file.notifications[0].read);
        assert_eq!(file.notifications[0].body, "");
    }

    #[test]
    fn level_serializes_lowercase() {
        let json = serde_json::to_string(&NotificationLevel::Warning).expect("serialize");
        assert_eq!(json, "\"warning\"");
    }
}
