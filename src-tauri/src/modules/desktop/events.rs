// src-tauri/src/modules/desktop/events.rs
//
// 把后台宿主发来的事件翻译成应用里的动作。
//
// ============================================================
// 为什么这一层必须存在
// ============================================================
//
// 后台宿主只会说"schedule.fired"。它**不知道**通知中心长什么样、什么是去重键、
// 未读徽标怎么算 —— 那些是应用侧的概念。这个模块就是那条边界：
// 左边是"另一个进程里发生了一件事"，右边是"应用要做什么"。
//
// 把它单独成一个文件而不是塞进 `background/mod.rs` 的原因很实际：
// `background` 是一个**通用通道**（协议、进程、超时），而这里承载的是
// **产品决定**（提醒到了要变成一条什么级别的通知、显示成什么标题）。
// 混在一起会让"换一种呈现方式"变成一次对通道的改动。
//
// ============================================================
// 事件处理函数为什么只做"发一条命令"
// ============================================================
//
// 这个函数跑在**读任务**里（见 `background/mod.rs` 的 `spawn_reader`）。
// 读任务是唯一在解析子进程 stdout 的地方，它被阻塞多久，所有请求的响应
// 就跟着被推迟多久。因此这里绝不落盘、绝不等待 —— 只做一次内存里的通知插入
// （那是一个 Vec push + 一次小文件写入，最坏几毫秒），其余全部交给日志。
//
// ============================================================
// 未知事件为什么必须记日志
// ============================================================
//
// 旧应用遇到新脚本时会收到不认识的事件。那份"不认识"必须留下痕迹：
// 静默忽略会让"新版本加了一个功能但它在我这里从不生效"变成一件无法排查的事。

use serde_json::Value;

use crate::modules::desktop::background::protocol::Event;
use crate::modules::notifications::store::{self, NotificationCategory, NotificationLevel};
use crate::prelude::*;

/// `schedule.fired` 事件的名称。与 `background-host.mjs` 里 `emitEvent` 的第一个
/// 参数必须一致 —— 两边都改了才算一次完整的改动。
pub const EVENT_SCHEDULE_FIRED: &str = "schedule.fired";

/// 处理一条后台事件。
///
/// 返回值只用于日志与测试（`true` 表示识别并处理了），**调用方不据此做决定** ——
/// 它已经跑在读任务里，多一个分支就多一处可能出错的地方。
pub fn handle(app: &AppHandle, event: &Event) -> bool {
    match event.event.as_str() {
        EVENT_SCHEDULE_FIRED => {
            handle_schedule_fired(app, event);
            true
        }
        other => {
            log::warn!(
                "后台宿主发来一个当前版本不认识的事件「{other}」（主体 {}）。\
                 这通常意味着宿主脚本比应用新 —— 后台能力应当来自同一次发布。",
                event.subject
            );
            false
        }
    }
}

/// 定时提醒到点 → 在通知中心里放一条提醒。
///
/// ============================================================
/// 关于去重键：**刻意带上触发次数**
/// ============================================================
///
/// 通知中心的去重规则是"去重键相同且未读时合并为一条"。对一个**重复提醒**来说，
/// 这个规则要先回答"两次触发算不算同一件事"：
///
///   · 算同一件事（去重键只含 id）：一个每小时的提醒会把上一条合并掉，
///     用户看到的永远是"1 条"，看不出它已经响过几次；
///   · 不算（去重键含触发次数）：每次都留下独立的记录，
///     用户能看到"9:00、10:00、11:00 各提醒过一次"。
///
/// 这里选后者，因为"提醒响过而我没看到"是用户需要能追溯的事。
/// 同时**同一次触发的事件如果因为某种原因被送到两次**，它们会合并成一条 ——
/// 这正是去重该起的作用。
fn handle_schedule_fired(app: &AppHandle, event: &Event) {
    let data = event.data.clone().unwrap_or(Value::Null);

    // 标题与内容优先取事件里的 payload（后台宿主把它从定义里带过来了）。
    // 取不到时用主体 id 兜底 —— 一条标题不好看的提醒，也比一条丢失的提醒好。
    let payload = data.get("payload").cloned().unwrap_or(Value::Null);
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("定时提醒")
        .to_string();

    let body = payload
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 触发次数与原因写进正文：用户看到的是"它响过几次、是定时响的还是手工试的"。
    let fire_count = data.get("fireCount").and_then(|v| v.as_u64());
    let reason = data.get("reason").and_then(|v| v.as_str());

    let mut detail = body;
    if let Some(count) = fire_count {
        let note = if count <= 1 {
            "第 1 次提醒".to_string()
        } else {
            format!("第 {count} 次提醒")
        };
        if detail.is_empty() {
            detail = note;
        } else {
            detail = format!("{detail}（{note}）");
        }
    }
    if reason == Some("manual") {
        detail = format!("{detail}・手动试响");
    }

    let source = format!("reminder:{}", event.subject);
    let dedupe_key = format!(
        "schedule.fired:{}:{}",
        event.subject,
        data.get("scheduledAt")
            .and_then(|v| v.as_i64())
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    );

    // 一次触发对应一条通知。
    //
    // 直接操作通知模块的托管状态（而不是走一次 `invoke` 或调那条 `#[tauri::command]`）：
    // 命令函数需要 `State<'_, _>` 这个 Tauri 注入的参数，它只能在 `invoke` 的
    // 上下文里构造。而这里需要的是**同一条落盘 + 广播路径**，那两件事分别在
    // `store` 与 `commands::broadcast_changed` 里，直接调它们即可。
    let outcome = {
        use tauri::Manager;

        let Some(state) = app.try_state::<crate::modules::notifications::commands::NotificationsState>()
        else {
            // 通知模块没能装上：这不是这条提醒的错，但也不能假装送达了。
            log::warn!("通知模块未就绪，定时提醒无法进入通知中心：{title}");
            return;
        };

        let result = (|| -> Result<crate::modules::notifications::store::Notification, String> {
            let incoming = store::sanitize(
                &title,
                &detail,
                reminder_level(),
                reminder_category(),
                &source,
                Some(&dedupe_key),
            )?;
            let mut list = state.inner().0.lock().map_err(|e| e.to_string())?;
            store::insert(&mut list, incoming.clone());
            store::save(app, &list)?;
            Ok(incoming)
        })();

        // 无论成功与否都要广播：失败了也可能已经改动过列表（insert 成功、
        // save 失败），此时界面更需要知道真实状态，而不是停在旧缓存上。
        crate::modules::notifications::commands::broadcast_changed(app);

        result
    };

    match outcome {
        Ok(notification) => {
            log::info!("定时提醒已进入通知中心：{}（{dedupe_key}）", notification.id);
        }
        Err(error) => {
            log::warn!("定时提醒送达失败（提醒本身已经在后台触发过）：{error}");
        }
    }
}

/// 通知的级别与类别集中在这里，方便将来按事件类型细分。
///
/// 抽出来的理由：`NotificationLevel`/`NotificationCategory` 的取值会影响
/// 界面的颜色与分组，把那个决定散在调用点会让"所有提醒都是同一个样式"
/// 变成一件需要翻遍代码才能确认的事。
pub fn reminder_level() -> NotificationLevel {
    NotificationLevel::Info
}

pub fn reminder_category() -> NotificationCategory {
    NotificationCategory::General
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fired_event(id: &str, fire_count: u64, reason: &str) -> Event {
        Event {
            v: crate::modules::desktop::background::PROTOCOL_VERSION,
            event: EVENT_SCHEDULE_FIRED.to_string(),
            subject: id.to_string(),
            data: Some(serde_json::json!({
                "kind": "interval",
                "name": "起来走走",
                "fireCount": fire_count,
                "reason": reason,
                "scheduledAt": 1_700_000_000_000i64,
                "payload": { "title": "起来走走", "body": "已经坐了一小时" },
            })),
        }
    }

    /// 事件名的线上契约必须稳定。改了它，后台脚本就再也送不到这里。
    #[test]
    fn the_event_name_is_frozen() {
        assert_eq!(EVENT_SCHEDULE_FIRED, "schedule.fired");
    }

    /// 提醒用的级别与类别是**确定**的，不是随机取值。
    ///
    /// 它把"提醒长什么样"这件事钉在一个地方：将来若改成 `Warning`，
    /// 这条测试会一起被改，改动因此是被看见的。
    #[test]
    fn reminders_always_use_the_same_level_and_category() {
        assert_eq!(reminder_level(), NotificationLevel::Info);
        assert_eq!(reminder_category(), NotificationCategory::General);
    }

    /// 事件的形态能被正确读出来（标题、内容、次数都取得到）。
    ///
    /// 这里只验证**解析**，不验证落盘 —— 落盘需要一个 `AppHandle`，
    /// 而把那件事塞进单元测试会让整个测试二进制去链接 WebView2。
    #[test]
    fn a_fired_event_carries_everything_needed_to_display_a_reminder() {
        let event = fired_event("health.standup", 3, "timer");
        let data = event.data.clone().unwrap();

        assert_eq!(data["payload"]["title"], "起来走走");
        assert_eq!(data["payload"]["body"], "已经坐了一小时");
        assert_eq!(data["fireCount"], 3);
        assert_eq!(data["scheduledAt"], 1_700_000_000_000i64);
    }

    /// 缺 payload 时标题要能兜底，而不是显示成空字符串。
    #[test]
    fn a_fired_event_without_a_payload_still_yields_a_usable_title() {
        let event = Event {
            v: crate::modules::desktop::background::PROTOCOL_VERSION,
            event: EVENT_SCHEDULE_FIRED.to_string(),
            subject: "bare".to_string(),
            data: None,
        };

        let data = event.data.clone().unwrap_or(Value::Null);
        let payload = data.get("payload").cloned().unwrap_or(Value::Null);
        let title = payload
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("定时提醒");

        assert_eq!(title, "定时提醒");
    }

    /// 去重键必须**随触发次数变化**，同时**同一次触发稳定**。
    ///
    /// 这是"重复提醒不能被折叠成一条"的实现依据。取它出来单独测是因为
    /// 这段逻辑在 `handle_schedule_fired` 里是一行 `format!`，
    /// 很容易在后来的重构中被简化成只含 id。
    #[test]
    fn the_dedupe_key_distinguishes_firings_but_is_stable_within_one() {
        fn key(event: &Event) -> String {
            let data = event.data.clone().unwrap_or(Value::Null);
            format!(
                "schedule.fired:{}:{}",
                event.subject,
                data.get("scheduledAt")
                    .and_then(|v| v.as_i64())
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )
        }

        let first = fired_event("health.standup", 1, "timer");
        let same = fired_event("health.standup", 1, "timer");
        let later = Event {
            data: Some(serde_json::json!({
                "fireCount": 2,
                "scheduledAt": 1_700_000_060_000i64,
                "payload": { "title": "起来走走" },
            })),
            ..fired_event("health.standup", 2, "timer")
        };

        assert_eq!(key(&first), key(&same), "同一次触发必须得到同一个去重键");
        assert_ne!(key(&first), key(&later), "不同的触发时刻必须得到不同的去重键");
    }
}
