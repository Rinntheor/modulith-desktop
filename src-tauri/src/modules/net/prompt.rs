// src-tauri/src/modules/net/prompt.rs
//
// 「默认询问」档的请求级往返。
//
// ---------------------------------------------------------------------------
// 这一层要解决的问题
//
// `policy::decide` 是纯函数，它能在一次调用里回答"放行 / 拒绝"，但"询问"这个
// 结果**不可能是一次纯调用**：它要求把已经组装好的请求暂停住，去问一个此刻
// 不知道答案的人，再带着答案回来。因此这里有三个必须自己负责的东西：
//
//   1. **暂停与恢复。** 请求在 `client::execute` 里被挂起，等 `oneshot` 带回答案。
//   2. **串行化。** 市场一次操作会连发索引、签名、说明、图标与包下载。若每条都
//      各弹一个，用户面对的是五个几乎相同的对话框，而它们会互相盖住 —— 因此
//      一次只弹一个，其余排队。
//   3. **超时兜底。** 人可能不在。没有兜底的"暂停"会让请求永久挂着，而那比拒绝
//      更糟：它既没有结果，也不会有错误，插件只会一直等。
//
// ---------------------------------------------------------------------------
// 两个决定，写在这里以免将来被"优化"掉
//
//   * **超时的方向是拒绝。** 与本项目其他不可判定处的取向一致（认证配置损坏时
//     也是"需要授权"而不是放行）。放行是一次**没有发生过的同意**，而拒绝是可见、
//     可重试的。
//   * **「本会话内总是允许」是内存态，不落盘。** 用户选的就是"每次问我"，
//     给一个永久放行等于静默削弱他自己选的策略；而落盘还要动 settings.json 的
//     契约，那是 MINOR 级别的改动。重启即失效，语义干净。
// ---------------------------------------------------------------------------

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use super::log::{self, NetLogEntry};

/// 询问事件：后端 → 前端。前端用 `listen` 订阅它。
pub const PROMPT_EVENT: &str = "net://prompt";
/// 「这一条询问已经结束了」：超时、或已经被别人答过。前端据此撤掉对话框。
///
/// 有它才能让界面与后端一致：用户不在时那条对话框会在前端的倒计时结束后自行
/// 消失，但只要时钟稍有偏差（或前端刚挂载、错过了一次超时），界面就会停在一个
/// 后端已经放弃的询问上。
pub const PROMPT_CLOSED_EVENT: &str = "net://prompt-closed";

/// 用户等待上限。
///
/// 30 秒是"他可能正在看别处，但还没走开"的量级。取更短会让正常的一次切换窗口
/// 就被判超时，取更长会把请求挂得太久（插件那边只看到一个迟迟不返回的调用）。
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(30);

/// 一次询问的展示数据。
///
/// `source` 与 `purpose` 直接来自日志条目：对话框要回答的正是"是谁、要干什么、
/// 去哪里"，而这三个字段就是为了回答这件事而存在的。**不复用地址里的查询串**
/// （它经常带令牌），给用户看的那份折掉查询串。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetPrompt {
    pub id: u64,
    pub source: String,
    pub purpose: &'static str,
    pub method: String,
    pub host: String,
    pub url: String,
    /// 前端据此显示倒计时。由后端给出而不是前端写死，避免两处数字漂移
    pub timeout_ms: u64,
    /// 此刻队列里还有多少条在等（含这一条）。大于 1 时界面要说明"还有 N 条"
    pub queued: usize,
}

/// 一条询问的最终结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOutcome {
    /// 用户同意（或本会话内已经同意过这个主机）
    Allowed,
    /// 用户按了拒绝
    Refused,
    /// 用户在时限内没有回答，或这条询问根本送不到界面
    TimedOut,
}

struct Pending {
    host: String,
    answer: oneshot::Sender<bool>,
}

/// 托管给 Tauri 的询问状态（`net::mod` 的 `setup` 里 `app.manage`）
pub struct PromptState {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    /// 本会话内被"总是允许"的主机。小写主机名，重启即清空
    grants: Mutex<HashSet<String>>,
    /// 一次只弹一个：拿不到这把锁的请求排队等
    gate: AsyncMutex<()>,
}

impl PromptState {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            grants: Mutex::new(HashSet::new()),
            gate: AsyncMutex::new(()),
        }
    }

    fn take(&self, id: u64) -> Option<Pending> {
        self.pending.lock().ok()?.remove(&id)
    }

    fn grant(&self, host: &str) {
        if let Ok(mut grants) = self.grants.lock() {
            grants.insert(host.to_ascii_lowercase());
        }
    }

    fn has_grant(&self, host: &str) -> bool {
        self.grants
            .lock()
            .map(|grants| grants.contains(&host.to_ascii_lowercase()))
            .unwrap_or(false)
    }
}

impl Default for PromptState {
    fn default() -> Self {
        Self::new()
    }
}

/// 本会话内是否已经放行过这个主机。
///
/// **要在拿到询问锁之后、以及每条请求进入询问之前各查一次**：
///   * 进入之前查，是为了让"用户刚点了总是允许"立刻对后续请求生效（不然会多弹
///     一次完全没有必要的询问）；
///   * 拿到锁之后再查，是因为排队期间用户可能已经为同一个主机放行了 ——
///     少了这一条，排队的那几条会挨个再问一遍。
pub fn has_session_grant(app: &AppHandle, host: &str) -> bool {
    app.state::<PromptState>().has_grant(host)
}

/// 询问一次。调用方拿到结果后自行决定放行还是拒绝。
pub async fn ask(
    app: &AppHandle,
    entry: &NetLogEntry,
    method: &str,
    url: &str,
    host: &str,
) -> PromptOutcome {
    let state = app.state::<PromptState>();

    // 排队：一次只弹一个。`_gate` 活到函数结束，因此同一时刻只有一条询问在被展示。
    let _gate = state.gate.lock().await;

    // 排队期间用户可能已经为这个主机放过行
    if state.has_grant(host) {
        return PromptOutcome::Allowed;
    }

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (answer, waiting) = oneshot::channel::<bool>();

    let queued = {
        let Ok(mut pending) = state.pending.lock() else {
            // 锁中毒意味着另一个线程 panic 过。询问是可选能力，降级为拒绝而不是
            // 让请求挂死 —— 而"降级为放行"在这里是不可接受的。
            log::record(
                entry
                    .clone()
                    .with_outcome("denied", Some(super::policy::DENY_PROMPT_TIMEOUT.to_string())),
            );
            return PromptOutcome::TimedOut;
        };
        pending.insert(
            id,
            Pending {
                host: host.to_string(),
                answer,
            },
        );
        pending.len()
    };

    let prompt = NetPrompt {
        id,
        source: entry.source.clone(),
        purpose: entry.purpose,
        method: method.to_string(),
        host: host.to_string(),
        url: strip_query(url),
        timeout_ms: PROMPT_TIMEOUT.as_millis() as u64,
        queued,
    };

    if let Err(error) = app.emit(PROMPT_EVENT, &prompt) {
        // 送不到界面就没有人能回答它。**不要干等满 30 秒** —— 那只会让插件
        // 白白挂住，而结果早在发不出去的那一刻就定了。
        state.take(id);
        // `log` 这个名字在本文件里被上面的 `use super::log` 占用了（它指的是
        // 流量日志模块），因此这里要用绝对路径指向 `log` 门面 —— 后端日志文件
        // 而不是内存里的流量日志。
        ::log::warn!("出站询问无法送达前端（{error}），按拒绝处理");
        return PromptOutcome::TimedOut;
    }

    match tokio::time::timeout(PROMPT_TIMEOUT, waiting).await {
        Ok(Ok(true)) => PromptOutcome::Allowed,
        Ok(Ok(false)) => PromptOutcome::Refused,
        // 发送端被丢弃：只可能是别处把它移除了（例如界面重载）
        Ok(Err(_)) => PromptOutcome::TimedOut,
        Err(_) => {
            // 超时：必须自己把条目摘掉，否则它会一直留在表里
            state.take(id);
            let _ = app.emit(PROMPT_CLOSED_EVENT, id);
            PromptOutcome::TimedOut
        }
    }
}

/// 前端回答一次询问。
///
/// 返回 `Ok(())` 的情况包括"这一条已经不存在了"（超时、或用户点了两次）。
/// 那不是错误：用户点第二次时看到的对话框本来就已经失效，把它变成一条红色报错
/// 只会让人以为哪里坏了。
///
/// **命令本体在 `commands.rs`** —— 生成器只扫那一个文件里的命令属性，并按出现
/// 次数对账，因此这里只放实现。（这条约定写在 `commands.rs` 的文件头。）
pub fn answer(app: &AppHandle, id: u64, allow: bool, remember_host: bool) -> Result<(), String> {
    let state = app.state::<PromptState>();

    let Some(pending) = state.take(id) else {
        return Ok(());
    };

    if allow && remember_host {
        state.grant(&pending.host);
    }

    // 发送失败说明等待方已经超时走了。结果已经定下，这里不再纠正。
    let _ = pending.answer.send(allow);
    let _ = app.emit(PROMPT_CLOSED_EVENT, id);
    Ok(())
}

/// 本会话已放行的主机表（设置页展示用），已排序
pub fn session_grants(app: &AppHandle) -> Vec<String> {
    let state = app.state::<PromptState>();
    // 不能写成 `.lock().map(|g| g.iter().cloned().collect()).unwrap_or_default()`：
    // 那个 `Result` 是**临时值**，它持有的 `MutexGuard` 会在语句结束时析构，
    // 而收集出来的 `Vec<String>` 在 `clone` 之后已不借用它 —— 但编译器看到的
    // 借用区间仍然延伸到这里，于是报 "state does not live long enough"。
    // 用 `match` 把守卫的作用域写明确，是更清楚的写法，也顺带避开那个坑。
    let mut list: Vec<String> = match state.grants.lock() {
        Ok(grants) => grants.iter().cloned().collect(),
        Err(_) => Vec::new(),
    };
    list.sort();
    list
}

/// 清空本会话的放行表，让「默认询问」立刻回到每次都问的状态。返回清掉的条数
pub fn clear_session_grants(app: &AppHandle) -> usize {
    let state = app.state::<PromptState>();
    // 同 `session_grants`：`match ... { }` 直接作为尾表达式时，那个持有守卫的
    // 临时值会在块结束时才析构，而块内的 `state` 已经先被丢弃 —— 编译器因此报
    // "does not live long enough"。先绑到一个局部量，析构顺序就明确了。
    let removed = match state.grants.lock() {
        Ok(mut grants) => {
            let count = grants.len();
            grants.clear();
            count
        }
        Err(_) => 0,
    };
    removed
}

/// 给用户看的地址：**折掉查询串**。
///
/// 查询串里经常带令牌（`?token=…`、`?sig=…`），而这个对话框会被截图、会被贴进
/// issue。日志里保留全文（诊断需要），这里不给。
fn strip_query(url: &str) -> String {
    match url.split_once('?') {
        Some((head, _)) => format!("{head}?…"),
        None => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_query_keeps_the_address_but_drops_the_secrets() {
        assert_eq!(
            strip_query("https://cdn.example.com/a/index.json?token=abc"),
            "https://cdn.example.com/a/index.json?…"
        );
        assert_eq!(
            strip_query("https://cdn.example.com/a/index.json"),
            "https://cdn.example.com/a/index.json"
        );
    }

    #[test]
    fn state_starts_empty_and_grants_are_case_insensitive() {
        let state = PromptState::new();
        // 直接读字段而不是加一个 `pending_count()` 方法：那个方法只有这个测试会用，
        // 于是它在非测试构建里是 dead_code（rust-analyzer 会如实报出来）。
        // 测试与被测类型在同一个模块里，本来就能碰到私有字段。
        assert_eq!(
            state.pending.lock().map(|p| p.len()).unwrap_or(1),
            0,
            "新状态里不该有任何待答的询问"
        );
        assert!(!state.has_grant("Example.COM"));

        state.grant("Example.COM");
        assert!(state.has_grant("example.com"), "主机名比较不区分大小写");
        assert!(state.has_grant("EXAMPLE.com"));

        // 只记住被放行的那一个，不是"放行过任何东西"
        assert!(!state.has_grant("other.example.com"));
    }

    #[test]
    fn default_timeout_is_long_enough_to_switch_windows_and_short_enough_to_not_hang() {
        // 这条断言锁的是"数字不能被人随手调"。它不精确，但两侧都有的理由写在
        // PROMPT_TIMEOUT 的文档注释里：太短会把正常的切换窗口判成超时，
        // 太长会让插件挂在一个迟迟不返回的调用上。
        let seconds = PROMPT_TIMEOUT.as_secs();
        assert!((10..=120).contains(&seconds), "询问超时 {seconds}s 不在合理区间");
    }
}
