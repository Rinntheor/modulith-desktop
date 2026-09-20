// src-tauri/src/modules/net/log.rs
//
// 流量日志：每一条出站请求的去向与结果。
//
// 第一版只记出站。**进站也记**（用户的决定是"进站只记录、不拦截"）会落在同一张表里，
// 用 `direction` 区分 —— 之所以现在就把这个字段放上，是因为日志一旦开始写，后面再补
// 一个维度就意味着"早期记录读不出来源"，而那正是日志最没用的形态。
//
// 存储是**进程内的环形缓冲**：上限固定，先丢最旧的。
// 不落盘的理由：这一版的目标是"用户能当场看见这软件在连什么"，而落盘需要回答
// 轮转、体积上限、隐私（URL 里可能带令牌）三个问题 —— 那属于独立的一批。
// 代价如实写在这里：**应用重启后日志清空**。

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// 环形缓冲上限。500 条足够回答"刚才发生了什么"，又不至于让日志本身就是一份数据资产
pub const MAX_ENTRIES: usize = 500;

/// 出站 / 进站
pub const DIRECTION_OUTBOUND: &str = "outbound";
pub const DIRECTION_INBOUND: &str = "inbound";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetLogEntry {
    /// rfc3339
    pub at: String,
    pub direction: &'static str,
    /// `host` / `plugin:<id>` / `module:<id>` —— 没有它，日志回答不了"是谁发的"
    pub source: String,
    /// 这次请求是**干什么用的**（"插件市场索引"/"网络诊断"/"插件网络请求"…）。
    /// 仅有 source 时，用户看到 `module:plugins` 连了 jsdelivr，仍然分不清
    /// 那是在取索引、取 README 还是在下载插件包。
    ///
    /// 是 `&'static str`：这些文案在编译期就定下来了，日志里出现运行时拼出来的
    /// 用途字符串，意味着那串文案本身成了一份没人维护的第二来源。
    pub purpose: &'static str,
    pub method: String,
    pub host: String,
    /// 完整地址。**可能含查询串里的敏感参数**，界面上应当允许折叠
    pub url: String,
    /// `allowed` / `allowed-pending-prompt` / `denied` / `failed`
    pub outcome: &'static str,
    pub status: Option<u16>,
    pub bytes: Option<u64>,
    /// 拒绝原因或失败原因
    pub detail: Option<String>,
}

impl NetLogEntry {
    pub fn outbound(
        source: &str,
        purpose: &'static str,
        method: &str,
        url: &str,
        host: &str,
    ) -> Self {
        Self {
            at: chrono::Utc::now().to_rfc3339(),
            direction: DIRECTION_OUTBOUND,
            source: source.to_string(),
            purpose,
            method: method.to_string(),
            host: host.to_string(),
            url: url.to_string(),
            outcome: "allowed",
            status: None,
            bytes: None,
            detail: None,
        }
    }

    pub fn with_outcome(mut self, outcome: &'static str, detail: Option<String>) -> Self {
        self.outcome = outcome;
        self.detail = detail;
        self
    }

    pub fn with_response(mut self, status: u16, bytes: Option<u64>) -> Self {
        self.status = Some(status);
        self.bytes = bytes;
        self
    }
}

static LOG: OnceLock<Mutex<VecDeque<NetLogEntry>>> = OnceLock::new();

fn store() -> &'static Mutex<VecDeque<NetLogEntry>> {
    LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_ENTRIES)))
}

/// 记一条。满了先丢最旧的 —— 环形而不是无限增长，理由见文件头
pub fn record(entry: NetLogEntry) {
    // 中毒的锁不该让网络请求失败：日志是**观测**，不是关键路径
    let Ok(mut queue) = store().lock() else {
        return;
    };
    if queue.len() >= MAX_ENTRIES {
        queue.pop_front();
    }
    queue.push_back(entry);
}

/// 最近 `limit` 条，**最新的在前**（界面上一眼看到刚发生的）
pub fn list(limit: usize) -> Vec<NetLogEntry> {
    let Ok(queue) = store().lock() else {
        return Vec::new();
    };
    queue.iter().rev().take(limit).cloned().collect()
}

pub fn clear() {
    if let Ok(mut queue) = store().lock() {
        queue.clear();
    }
}

pub fn len() -> usize {
    store().lock().map(|queue| queue.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 这些测试必须**串行**跑。
    ///
    /// 日志是进程级单例，而 Rust 默认并行执行测试 —— 两个测试同时 clear/push，
    /// 断言会互相踩（第一次跑就撞上了：期望 500 条，实到 253 条）。
    ///
    /// 更好的形态是把环形缓冲做成一个可注入的结构体（`NetLog`），全局只是它的一层
    /// 薄包装 —— 那样测试根本不需要共享状态。这一步留到需要第二个实例时再做：
    /// 现在只有一个调用方，为它引入一层间接是过度设计。
    static SERIAL: Mutex<()> = Mutex::new(());

    fn entry(n: usize) -> NetLogEntry {
        NetLogEntry::outbound(
            &format!("plugin:p{n}"),
            "测试",
            "GET",
            "https://example.com/x",
            "example.com",
        )
    }

    #[test]
    fn newest_first() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        for i in 0..3 {
            record(entry(i));
        }
        let listed = list(10);
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].source, "plugin:p2", "最新的必须排在最前");
        clear();
    }

    #[test]
    fn ring_drops_oldest() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        for i in 0..(MAX_ENTRIES + 10) {
            record(entry(i));
        }
        assert_eq!(len(), MAX_ENTRIES, "上限是硬的");
        // 最旧的那 10 条应当已经被丢掉
        let listed = list(MAX_ENTRIES + 100);
        assert_eq!(listed[0].source, format!("plugin:p{}", MAX_ENTRIES + 9));
        assert_eq!(
            listed[listed.len() - 1].source,
            format!("plugin:p{}", 10),
            "p0..p9 应当已被挤出去"
        );
        clear();
    }

    #[test]
    fn limit_is_respected() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        for i in 0..5 {
            record(entry(i));
        }
        assert_eq!(list(2).len(), 2);
        clear();
    }

    #[test]
    fn source_distinguishes_who_sent_it() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        // 这条是整套日志的前提：没有来源，日志回答不了"是谁发的"
        clear();
        record(entry(0));
        let listed = list(1);
        assert!(listed[0].source.starts_with("plugin:"));
        assert_eq!(listed[0].direction, DIRECTION_OUTBOUND);
        clear();
    }

    #[test]
    fn purpose_survives_the_round_trip() {
        // 用途是"为什么发"：只有来源时，用户看到 module:plugins 连了 jsdelivr，
        // 仍然分不清那是在取索引还是在下载插件包
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        record(NetLogEntry::outbound(
            "module:plugins",
            "插件市场索引",
            "GET",
            "https://cdn.jsdelivr.net/gh/a/b@main/index.json",
            "cdn.jsdelivr.net",
        ));
        assert_eq!(list(1)[0].purpose, "插件市场索引");
        clear();
    }
}
