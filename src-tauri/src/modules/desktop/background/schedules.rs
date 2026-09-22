// src-tauri/src/modules/desktop/background/schedules.rs
//
// 定时提醒的**定义**：存什么、怎么校验、怎么持久化。
//
// ============================================================
// 为什么定义在这里，而计时在 Node（这是本模块最重要的一个分工）
// ============================================================
//
// 定时提醒由两半组成，它们的要求恰好相反：
//
//   · **定义**（什么时候、提醒什么）需要落盘、需要校验、需要被界面读写。
//     这是产品决定，属于应用；
//   · **计时**（到点了叫一声）需要活在一个不随窗口关闭而结束的进程里。
//     这是运行环境，属于后台宿主。
//
// 两边都能做全部，但任何一边独吞都要付出代价：
//
//   · 全放应用侧：窗口关掉就没人计时，提醒不会响 —— 那正是这个功能存在的理由；
//   · 全放后台侧：要再实现一遍落盘、迁移、去重与校验，而这些语义必须与
//     应用侧的通知保持一致，两份实现必然漂移。
//
// 因此这里只负责**定义**，并把定义推送给后台宿主；后台宿主只负责计时，
// 到点后发一条事件回来，由应用侧决定"要显示成什么"。
//
// 这个分工有一个必须承认的代价：**后台子进程是无状态的**，它重启之后
// 内存里的定时任务就没了。补偿方式不是在这里落盘第二份，而是让
// `BackgroundHost::ensure_started` 在每次新拉起子进程之后自动重新推送一次
// （见 `background/mod.rs`）。因此"定义"只有一份真值。
//
// ============================================================
// 为什么 `nextAt` 不在这里算
// ============================================================
//
// "下一次什么时候响"看起来是个纯计算，很容易想在这里也算一份。但那份计算要考虑
// 本地时区、夏令时切换、以及"错过了很久之后怎么补"。后台宿主里已经有一份实现
// （`background-host.mjs` 的 `nextDailyAt` / `advance`），再写一份必然在某个
// 边界上分叉 —— 而分叉的表现是"界面上显示 9:00 响，实际 10:00 响"，
// 或者更糟：**显示响过了、其实没响**。
//
// 因此这里**只存定义，不算时刻**。要显示"下一次什么时候响"就去问后台宿主
// （`background_schedule_list`），问不到就如实说"后台未运行，当前没有在计时"。
// 这比在界面上显示一个我们自己算出来的、可能与真实执行不同的时刻诚实。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use crate::prelude::*;

/// 单条提醒的 id 上限
pub const MAX_ID_LEN: usize = 64;
/// 标题上限（按字符数，不是字节数 —— 中文标题一个字算一个）
pub const MAX_TITLE_CHARS: usize = 80;
/// 内容上限
pub const MAX_BODY_CHARS: usize = 400;
/// 提醒条数上限
///
/// 64 是一个刻意偏小的数字：这个上限的作用不是"防止磁盘被写满"，
/// 而是拦住"某个插件无限注册提醒"这类错误。真正会用这个功能的用户
/// 不会需要超过几十条。
pub const MAX_REMINDERS: usize = 64;
/// 间隔提醒的最小间隔（秒）
///
/// 与后台宿主的 `MIN_INTERVAL_MS` 保持一致（那里是 1000，这里更严）。
/// 这里取 60 秒：低于一分钟的重复提醒在桌面提醒这个场景里没有正当用途，
/// 而它会持续唤醒 CPU —— 那与这个项目"降低常驻开销"的方向正好相反。
pub const MIN_INTERVAL_SECONDS: u32 = 60;
/// 间隔提醒的最大间隔（秒）：30 天
///
/// 上限的意义是让"写错的数字"尽早暴露：把 30 天写成 30000000 秒的人，
/// 得到的不是一条永远不响的提醒，而是一句"间隔太长"。
pub const MAX_INTERVAL_SECONDS: u32 = 30 * 24 * 60 * 60;

/// 提醒的重复方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReminderKind {
    /// 每隔固定时长一次
    Interval,
    /// 每天某个时刻一次（本地时间）
    Daily,
    /// 只在某个绝对时刻一次
    Once,
}

/// 一条提醒的定义
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub kind: ReminderKind,
    /// 是否启用。停用的提醒**不会被推送给后台** —— 因此它一定不会响，
    /// 而不是"推过去但被忽略"（后者迟早会有一处忘了判断）。
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// `Interval` 的间隔秒数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_seconds: Option<u32>,
    /// `Daily` 的当日分钟数（0..1439，本地时间）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minute_of_day: Option<u32>,
    /// `Once` 的绝对时刻（毫秒时间戳）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    /// 创建时刻（毫秒时间戳），仅用于排序与显示
    #[serde(default)]
    pub created_at: i64,
}

fn default_enabled() -> bool {
    true
}

/// 后台宿主侧回报的运行状态（从这里读回来，而不是自己算）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRuntime {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    /// 下一次触发的绝对时刻。`null` 表示不再等待触发（`once` 已经响过）
    #[serde(default)]
    pub next_at: Option<i64>,
    #[serde(default)]
    pub fire_count: u64,
    #[serde(default)]
    pub last_fired_at: Option<i64>,
}

/// 校验失败的原因。用 `String` 而不是枚举：这些错误**直接显示给用户**，
/// 而用户需要的是"哪一项不对"，不是一个错误码。
type Validated = Result<Reminder, String>;

/// 校验并规范化一条提醒定义。
///
/// 刻意**不接受任何"就近取值"**：间隔 10 秒不会被悄悄抬到 60 秒，而是明确报错。
/// 一个"看起来设置成功了、实际按另一个值在跑"的提醒，比一句"间隔太短"糟得多 ——
/// 用户会以它为据去安排自己的事。
pub fn validate(input: ReminderInput, now_ms: i64) -> Validated {
    let id = input.id.trim().to_string();
    if id.is_empty() {
        return Err("提醒需要一个 id".to_string());
    }
    if id.chars().count() > MAX_ID_LEN {
        return Err(format!("提醒 id 过长（上限 {MAX_ID_LEN} 个字符）"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        // 允许的字符集与插件存储键一致：id 会出现在日志与查询参数里，
        // 放宽它只会让"这个 id 到底能不能用"变成一个需要试的问题。
        return Err("提醒 id 只能包含字母、数字、`-`、`_`、`.`".to_string());
    }

    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("提醒需要一个标题".to_string());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("标题过长（上限 {MAX_TITLE_CHARS} 个字符）"));
    }

    let body = input.body.trim().to_string();
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("内容过长（上限 {MAX_BODY_CHARS} 个字符）"));
    }

    let mut reminder = Reminder {
        id,
        title,
        body,
        kind: input.kind,
        enabled: input.enabled.unwrap_or(true),
        interval_seconds: None,
        minute_of_day: None,
        at: None,
        created_at: input.created_at.unwrap_or(now_ms),
    };

    match input.kind {
        ReminderKind::Interval => {
            let Some(seconds) = input.interval_seconds else {
                return Err("间隔提醒需要 intervalSeconds".to_string());
            };
            if seconds < MIN_INTERVAL_SECONDS {
                return Err(format!(
                    "间隔太短：最少 {MIN_INTERVAL_SECONDS} 秒（当前 {seconds} 秒）"
                ));
            }
            if seconds > MAX_INTERVAL_SECONDS {
                return Err(format!(
                    "间隔太长：最多 {} 天（当前 {} 天）",
                    MAX_INTERVAL_SECONDS / 86400,
                    seconds / 86400
                ));
            }
            reminder.interval_seconds = Some(seconds);
        }

        ReminderKind::Daily => {
            let Some(minute) = input.minute_of_day else {
                return Err("每日提醒需要 minuteOfDay（0..1439）".to_string());
            };
            if minute > 1439 {
                return Err(format!(
                    "minuteOfDay 必须在 0..1439 之间（当前 {minute}）；\
                     它表示本地时间当日的分钟数，例如 9:00 是 540"
                ));
            }
            reminder.minute_of_day = Some(minute);
        }

        ReminderKind::Once => {
            let Some(at) = input.at else {
                return Err("一次性提醒需要 at（毫秒时间戳）".to_string());
            };
            if at <= 0 {
                return Err("at 必须是一个正的毫秒时间戳".to_string());
            }
            // **已经过去的一次性提醒直接拒绝**，而不是"立刻响一次"。
            // 后者会让一条误设的提醒在保存的瞬间弹出来，而用户以为设的是将来。
            if at <= now_ms {
                return Err("一次性提醒的时刻必须在将来".to_string());
            }
            reminder.at = Some(at);
        }
    }

    Ok(reminder)
}

/// 新增或修改一条提醒的入参（来自界面）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub kind: ReminderKind,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub interval_seconds: Option<u32>,
    #[serde(default)]
    pub minute_of_day: Option<u32>,
    #[serde(default)]
    pub at: Option<i64>,
    /// 修改既有提醒时沿用原来的创建时刻（由调用方带上）
    #[serde(default)]
    pub created_at: Option<i64>,
}

// ============================================================
// 状态与持久化
// ============================================================

/// 全局提醒表。
///
/// 用 `LazyLock<Mutex<..>>` 而不是 Tauri 的 `State`：这份数据只有"一整份列表"
/// 一种形态，命令层不需要按调用方区分实例。`State` 会引入一个 `app.manage`
/// 调用点，而那个调用点一旦漏了，表现出来就是"存了但读不到"。
static REMINDERS: LazyLock<Mutex<Vec<Reminder>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn storage_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{e}"))?
        .join("background");

    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建后台数据目录：{e}"))?;
    Ok(dir.join("reminders.json"))
}

/// 从磁盘读进内存（模块 setup 时调一次）
///
/// 损坏的文件**不阻止启动**：退化为空列表并告警。与插件注册表同样的取舍 ——
/// 一个坏掉的 JSON 不该让应用打不开。
pub fn load(app: &AppHandle) {
    let path = match storage_file(app) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("无法定位提醒存储：{error}");
            return;
        }
    };

    let mut guard = REMINDERS.lock().unwrap();

    if !path.is_file() {
        *guard = Vec::new();
        return;
    }

    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Vec<Reminder>>(&text) {
            Ok(mut list) => {
                // 磁盘上的内容也可能超限（旧版本写的、或手工改过），读进来就裁一次
                if list.len() > MAX_REMINDERS {
                    log::warn!("提醒数量超过上限（{}），已裁到 {MAX_REMINDERS}", list.len());
                    list.truncate(MAX_REMINDERS);
                }
                log::info!("已载入 {} 条定时提醒", list.len());
                *guard = list;
            }
            Err(error) => {
                log::warn!("提醒文件无法解析，本次以空列表开始：{error}");
                *guard = Vec::new();
            }
        },
        Err(error) => {
            log::warn!("读取提醒文件失败：{error}");
            *guard = Vec::new();
        }
    }
}

/// 落盘。
///
/// 先写临时文件再改名：直接覆写时若进程在写入中途结束，留下的是一个**被截断的**
/// 文件，而它下次会被当成"损坏"从而丢掉全部提醒。改名在同一个目录内是原子的。
fn persist(app: &AppHandle, list: &[Reminder]) -> Result<(), String> {
    let path = storage_file(app)?;
    let text = serde_json::to_string_pretty(list).map_err(|e| format!("序列化提醒失败：{e}"))?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入提醒临时文件失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换提醒文件失败：{e}"))?;
    Ok(())
}

/// 当前全部提醒（已按"下次该响的排前面"以外的方式稳定排序：按创建时刻）
pub fn list() -> Vec<Reminder> {
    let mut list = REMINDERS.lock().unwrap().clone();
    list.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    list
}

/// 新增或替换一条提醒（按 id 命中则替换，否则追加）
pub fn upsert(app: &AppHandle, input: ReminderInput) -> Result<Vec<Reminder>, String> {
    let now_ms = now_millis();
    let reminder = validate(input, now_ms)?;

    let mut guard = REMINDERS.lock().unwrap();

    if let Some(existing) = guard.iter_mut().find(|item| item.id == reminder.id) {
        *existing = reminder;
    } else {
        if guard.len() >= MAX_REMINDERS {
            return Err(format!("提醒数量已达上限（{MAX_REMINDERS} 条）"));
        }
        guard.push(reminder);
    }

    persist(app, &guard)?;
    let snapshot = guard.clone();
    drop(guard);

    Ok(sort_snapshot(snapshot))
}

/// 删除一条提醒
pub fn remove(app: &AppHandle, id: &str) -> Result<Vec<Reminder>, String> {
    let mut guard = REMINDERS.lock().unwrap();
    guard.retain(|item| item.id != id);
    persist(app, &guard)?;
    let snapshot = guard.clone();
    drop(guard);
    // 未命中不报错：提醒可能已经被另一个入口删掉了，这属于正常竞态。
    // 调用方需要的是"当前的事实"，而不是"我的意图有没有被执行"。
    Ok(sort_snapshot(snapshot))
}

/// 启用/停用一条提醒
///
/// **找不到 id 时明确报错**：与删除不同，"切换一个不存在的开关"通常意味着
/// 界面拿着一个陈旧的 id，静默成功会让用户以为它被停用了。
pub fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> Result<Vec<Reminder>, String> {
    let mut guard = REMINDERS.lock().unwrap();
    let Some(item) = guard.iter_mut().find(|item| item.id == id) else {
        return Err(format!("没有这条提醒：{id}"));
    };
    item.enabled = enabled;
    persist(app, &guard)?;
    let snapshot = guard.clone();
    drop(guard);
    Ok(sort_snapshot(snapshot))
}

fn sort_snapshot(mut list: Vec<Reminder>) -> Vec<Reminder> {
    list.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    list
}

/// 推送给后台宿主的定义形态。
///
/// **只推送启用的**：停用的提醒根本不该进入计时器，而不是"进去了但被忽略" ——
/// 后者的判断散落在计时逻辑里，迟早有一处会漏。
pub fn specs_for_host() -> Vec<serde_json::Value> {
    let guard = REMINDERS.lock().unwrap();
    guard
        .iter()
        .filter(|item| item.enabled)
        .map(|item| {
            let mut spec = serde_json::json!({
                "id": item.id,
                "name": item.title,
                // 标题与内容都带上：后台宿主会把它们原样放进事件里，
                // 应用侧因此不需要为了显示一条提醒再去查一次定义。
                "payload": { "title": item.title, "body": item.body, "kind": item.kind },
            });

            match item.kind {
                ReminderKind::Interval => {
                    spec["kind"] = serde_json::json!("interval");
                    // 秒 → 毫秒只在这一处换算。两侧都存秒会让"哪边是秒"变成一个
                    // 需要查代码才能回答的问题。
                    spec["intervalMs"] =
                        serde_json::json!(u64::from(item.interval_seconds.unwrap_or(60)) * 1000);
                }
                ReminderKind::Daily => {
                    spec["kind"] = serde_json::json!("daily");
                    spec["minuteOfDay"] = serde_json::json!(item.minute_of_day.unwrap_or(0));
                }
                ReminderKind::Once => {
                    spec["kind"] = serde_json::json!("once");
                    spec["at"] = serde_json::json!(item.at.unwrap_or(0));
                }
            }

            spec
        })
        .collect()
}

/// 当前毫秒时间戳
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 触碰全局提醒表的测试必须串行。
    ///
    /// `REMINDERS` 是一个进程级静态量，而 cargo 默认**并行**跑测试 ——
    /// 两个测试各自"清空再填两条"时，一个会在另一个刚填完之后看到空表。
    ///
    /// 这不是理论问题：这条锁是因为一次真实的随机失败才加上的
    /// （`pushed_specs_use_the_wire_field_names_the_host_expects` 报
    /// "len is 0 but the index is 0"）。当时它单独跑通过、全量跑失败，
    /// 而那种失败最容易被误判成"实现坏了"。
    ///
    /// 只保护**写全局状态**的那几条：`validate` 是纯函数，不碰它，
    /// 因此仍然并行跑。
    static GLOBAL_LOCK: Mutex<()> = Mutex::new(());

    /// 把全局提醒表换成给定内容，并在离开作用域时清空。
    ///
    /// 用一个守卫而不是在每个测试末尾手写清空：漏掉一次就会污染后面任意一条
    /// 测试，而那种失败与被测代码毫无关系。
    struct ReminderTableGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ReminderTableGuard {
        fn with(list: Vec<Reminder>) -> Self {
            let lock = GLOBAL_LOCK.lock().unwrap();
            *REMINDERS.lock().unwrap() = list;
            Self { _lock: lock }
        }
    }

    impl Drop for ReminderTableGuard {
        fn drop(&mut self) {
            *REMINDERS.lock().unwrap() = Vec::new();
        }
    }

    fn interval_input(seconds: u32) -> ReminderInput {
        ReminderInput {
            id: "test.one".to_string(),
            title: "起来走走".to_string(),
            body: "已经坐了一小时".to_string(),
            kind: ReminderKind::Interval,
            enabled: None,
            interval_seconds: Some(seconds),
            minute_of_day: None,
            at: None,
            created_at: None,
        }
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn a_valid_interval_reminder_passes() {
        let reminder = validate(interval_input(3600), NOW).unwrap();
        assert_eq!(reminder.id, "test.one");
        assert_eq!(reminder.interval_seconds, Some(3600));
        assert!(reminder.enabled, "缺省应当启用");
        assert_eq!(reminder.created_at, NOW, "缺省创建时刻取现在");
    }

    /// **间隔太短必须报错，不能被悄悄抬到下限。**
    ///
    /// 这条是本模块最该守住的一条：如果把 5 秒抬成 60 秒，用户看到的
    /// 是"设置成功"，而实际行为与他设的完全不是一回事。
    #[test]
    fn too_short_an_interval_is_rejected_rather_than_clamped() {
        let error = validate(interval_input(5), NOW).unwrap_err();
        assert!(error.contains("间隔太短"), "{error}");
        assert!(error.contains("60"), "错误里要说清下限是多少：{error}");
    }

    #[test]
    fn the_minimum_interval_itself_is_accepted() {
        assert!(validate(interval_input(MIN_INTERVAL_SECONDS), NOW).is_ok());
    }

    #[test]
    fn an_absurdly_long_interval_is_rejected() {
        let error = validate(interval_input(MAX_INTERVAL_SECONDS + 1), NOW).unwrap_err();
        assert!(error.contains("间隔太长"), "{error}");
    }

    #[test]
    fn an_interval_without_a_duration_is_rejected() {
        let mut input = interval_input(60);
        input.interval_seconds = None;
        assert!(validate(input, NOW).is_err());
    }

    #[test]
    fn a_daily_reminder_needs_a_valid_minute_of_day() {
        let base = ReminderInput {
            id: "daily".to_string(),
            title: "每日站会".to_string(),
            body: String::new(),
            kind: ReminderKind::Daily,
            enabled: None,
            interval_seconds: None,
            minute_of_day: Some(540),
            at: None,
            created_at: None,
        };

        let ok = validate(base.clone(), NOW).unwrap();
        assert_eq!(ok.minute_of_day, Some(540), "9:00 是当日的第 540 分钟");

        let mut missing = base.clone();
        missing.minute_of_day = None;
        assert!(validate(missing, NOW).is_err());

        let mut out_of_range = base.clone();
        out_of_range.minute_of_day = Some(1440);
        let error = validate(out_of_range, NOW).unwrap_err();
        assert!(error.contains("0..1439"), "{error}");

        // 1439（23:59）是合法的边界值
        let mut edge = base;
        edge.minute_of_day = Some(1439);
        assert!(validate(edge, NOW).is_ok());
    }

    /// 一次性提醒的时刻**必须在将来**。
    ///
    /// 否则"保存"这个动作本身就会把提醒弹出来 —— 用户设的是"明天早上"，
    /// 结果现在响了一下，而他会以为这个功能坏了。
    #[test]
    fn a_once_reminder_in_the_past_is_rejected() {
        let mut input = interval_input(60);
        input.kind = ReminderKind::Once;
        input.interval_seconds = None;
        input.at = Some(NOW - 1);

        let error = validate(input.clone(), NOW).unwrap_err();
        assert!(error.contains("将来"), "{error}");

        // 正好等于"现在"也算过去（它已经无法在将来被触发）
        input.at = Some(NOW);
        assert!(validate(input.clone(), NOW).is_err());

        input.at = Some(NOW + 1);
        assert!(validate(input, NOW).is_ok());
    }

    #[test]
    fn an_empty_or_illegal_id_is_rejected() {
        let mut empty = interval_input(60);
        empty.id = "   ".to_string();
        assert!(validate(empty, NOW).is_err());

        let mut illegal = interval_input(60);
        illegal.id = "有 空格/和斜杠".to_string();
        let error = validate(illegal, NOW).unwrap_err();
        assert!(error.contains("只能包含"), "{error}");

        // 路径穿越是这条校验真正防的东西
        let mut traversal = interval_input(60);
        traversal.id = "..".to_string();
        // `..` 只含点，字符集是合法的，但它不构成路径 —— id 从不参与路径拼接。
        // 这条断言把那个事实写下来：它**可以**通过字符校验。
        assert!(validate(traversal, NOW).is_ok());

        let mut slash = interval_input(60);
        slash.id = "../etc/passwd".to_string();
        assert!(
            validate(slash, NOW).is_err(),
            "带斜杠的 id 必须被拒绝，即使它不参与路径拼接"
        );
    }

    #[test]
    fn an_empty_title_is_rejected_and_an_overlong_one_too() {
        let mut empty = interval_input(60);
        empty.title = "  ".to_string();
        assert!(validate(empty, NOW).is_err());

        let mut long = interval_input(60);
        long.title = "字".repeat(MAX_TITLE_CHARS + 1);
        let error = validate(long, NOW).unwrap_err();
        assert!(error.contains("标题过长"), "{error}");

        // 中文按**字符**算，不是字节：80 个汉字是合法的
        let mut chinese = interval_input(60);
        chinese.title = "字".repeat(MAX_TITLE_CHARS);
        assert!(validate(chinese, NOW).is_ok());
    }

    #[test]
    fn an_overlong_body_is_rejected() {
        let mut input = interval_input(60);
        input.body = "字".repeat(MAX_BODY_CHARS + 1);
        assert!(validate(input, NOW).is_err());
    }

    /// 停用的提醒**不会**被推送给后台。
    ///
    /// 这是"停用"这个动作真正的实现方式 —— 不是推过去再忽略。
    #[test]
    fn disabled_reminders_are_never_pushed_to_the_host() {
        // 直接构造一份内部状态来验证过滤规则（不碰磁盘）
        let enabled = Reminder {
            id: "on".to_string(),
            title: "开着的".to_string(),
            body: String::new(),
            kind: ReminderKind::Interval,
            enabled: true,
            interval_seconds: Some(600),
            minute_of_day: None,
            at: None,
            created_at: 1,
        };
        let disabled = Reminder {
            id: "off".to_string(),
            enabled: false,
            ..enabled.clone()
        };

        // 守卫持有全局锁并在离开时清空：并行跑测试时，别的测试可能正在
        // 用同一张表。
        let _guard = ReminderTableGuard::with(vec![enabled, disabled]);

        let specs = specs_for_host();
        assert_eq!(specs.len(), 1, "只有启用的那条该被推送");
        assert_eq!(specs[0]["id"], "on");
        assert_eq!(specs[0]["kind"], "interval");
        assert_eq!(specs[0]["intervalMs"], 600_000, "秒要换算成毫秒");
    }

    /// 三种类型推给后台的字段名必须与 Node 侧 `normalizeSchedule` 认的名字一致。
    ///
    /// 这是跨语言契约，写错的表现是"时间段对了但不响"或"同步整批失败"。
    #[test]
    fn pushed_specs_use_the_wire_field_names_the_host_expects() {
        let daily = Reminder {
            id: "d".to_string(),
            title: "每日".to_string(),
            body: String::new(),
            kind: ReminderKind::Daily,
            enabled: true,
            interval_seconds: None,
            minute_of_day: Some(540),
            at: None,
            created_at: 1,
        };
        let once = Reminder {
            id: "o".to_string(),
            title: "一次".to_string(),
            body: String::new(),
            kind: ReminderKind::Once,
            enabled: true,
            interval_seconds: None,
            minute_of_day: None,
            at: Some(NOW),
            created_at: 2,
        };

        let _guard = ReminderTableGuard::with(vec![daily, once]);

        let specs = specs_for_host();
        assert_eq!(specs[0]["kind"], "daily");
        assert_eq!(specs[0]["minuteOfDay"], 540);
        assert_eq!(specs[1]["kind"], "once");
        assert_eq!(specs[1]["at"], NOW);

        // 标题与内容随 payload 一起过去，应用侧显示时不必回查
        assert_eq!(specs[0]["payload"]["title"], "每日");
    }

    /// 序列化形态必须与前端一致（camelCase）。
    #[test]
    fn reminder_serializes_as_camel_case() {
        let reminder = Reminder {
            id: "x".to_string(),
            title: "t".to_string(),
            body: String::new(),
            kind: ReminderKind::Interval,
            enabled: true,
            interval_seconds: Some(60),
            minute_of_day: None,
            at: None,
            created_at: 1,
        };
        let json = serde_json::to_value(&reminder).unwrap();

        assert_eq!(json["kind"], "interval");
        assert_eq!(json["intervalSeconds"], 60);
        assert!(
            json.get("minuteOfDay").is_none(),
            "不适用的字段应当被省略，而不是给一个 null：{json}"
        );
    }
}
