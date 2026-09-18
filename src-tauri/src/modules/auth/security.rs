// src-tauri/src/modules/auth/security.rs
//
// 失败尝试与账号封锁。
//
// 用 `std::sync::Mutex` 而不是 tokio 锁：这里的临界区只有几次哈希表操作、
// 绝不跨 await，且比异步锁更省事。注意所有方法都不持有锁去调用外部代码。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 单个标识的失败记录
#[derive(Debug, Clone)]
struct LoginAttempt {
    count: u32,
    first_attempt: Instant,
    blocked_until: Option<Instant>,
}

impl LoginAttempt {
    fn fresh(now: Instant) -> Self {
        Self {
            count: 0,
            first_attempt: now,
            blocked_until: None,
        }
    }
}

/// 安全策略
#[derive(Debug, Clone, Copy)]
pub struct SecurityConfig {
    /// 触发封锁的失败次数
    pub max_attempts: u32,
    /// 封锁时长（分钟）
    pub block_minutes: u64,
    /// 失败计数窗口（分钟）
    pub reset_minutes: u64,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            block_minutes: 15,
            reset_minutes: 30,
        }
    }
}

/// 跟踪的标识数量上限，超过后清理已过期的条目，避免内存无限增长
const MAX_TRACKED_IDENTIFIERS: usize = 256;

/// 失败尝试跟踪器
pub struct AttemptTracker {
    attempts: Mutex<HashMap<String, LoginAttempt>>,
    config: SecurityConfig,
}

impl AttemptTracker {
    pub fn new() -> Self {
        Self::with_config(SecurityConfig::default())
    }

    pub fn with_config(config: SecurityConfig) -> Self {
        Self {
            attempts: Mutex::new(HashMap::new()),
            config,
        }
    }

    pub fn config(&self) -> SecurityConfig {
        self.config
    }

    /// 刷新一个条目的过期状态，返回它**当前**是否仍处于封锁中
    fn refresh(entry: &mut LoginAttempt, config: &SecurityConfig, now: Instant) -> bool {
        if let Some(until) = entry.blocked_until {
            if now >= until {
                *entry = LoginAttempt::fresh(now);
                return false;
            }
            return true;
        }

        if now.saturating_duration_since(entry.first_attempt)
            > Duration::from_secs(config.reset_minutes * 60)
        {
            *entry = LoginAttempt::fresh(now);
        }

        false
    }

    /// 剩余可尝试次数
    pub fn remaining(&self, identifier: &str) -> u32 {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().unwrap_or_else(|e| e.into_inner());

        match attempts.get_mut(identifier) {
            Some(entry) => {
                if Self::refresh(entry, &self.config, now) {
                    0
                } else {
                    self.config.max_attempts.saturating_sub(entry.count)
                }
            }
            None => self.config.max_attempts,
        }
    }

    /// 距离解封还有多久
    pub fn blocked_for(&self, identifier: &str) -> Option<Duration> {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().unwrap_or_else(|e| e.into_inner());
        let entry = attempts.get_mut(identifier)?;

        if Self::refresh(entry, &self.config, now) {
            entry
                .blocked_until
                .map(|until| until.saturating_duration_since(now))
        } else {
            None
        }
    }

    pub fn is_blocked(&self, identifier: &str) -> bool {
        self.blocked_for(identifier).is_some()
    }

    /// 记录一次失败，返回剩余可尝试次数（被封返回 0）
    pub fn record_failure(&self, identifier: &str) -> u32 {
        let now = Instant::now();
        let config = self.config;
        let mut attempts = self.attempts.lock().unwrap_or_else(|e| e.into_inner());

        if attempts.len() > MAX_TRACKED_IDENTIFIERS {
            let reset = Duration::from_secs(config.reset_minutes * 60);
            attempts.retain(|_, entry| {
                entry.blocked_until.is_some()
                    || now.saturating_duration_since(entry.first_attempt) < reset
            });
        }

        let entry = attempts
            .entry(identifier.to_string())
            .or_insert_with(|| LoginAttempt::fresh(now));

        // 已经在封锁中就不要再累加了
        if Self::refresh(entry, &config, now) {
            return 0;
        }

        entry.count += 1;

        if entry.count >= config.max_attempts {
            entry.blocked_until = Some(now + Duration::from_secs(config.block_minutes * 60));
            0
        } else {
            config.max_attempts - entry.count
        }
    }

    /// 验证成功 / 手动解锁时清除记录
    pub fn clear(&self, identifier: &str) {
        self.attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(identifier);
    }

    /// 清空全部记录（重置授权时使用）
    pub fn clear_all(&self) {
        self.attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

impl Default for AttemptTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_documented_policy() {
        let config = SecurityConfig::default();
        assert_eq!(config.max_attempts, 5);
        assert_eq!(config.block_minutes, 15);
        assert_eq!(config.reset_minutes, 30);
    }

    #[test]
    fn remaining_counts_down_then_blocks() {
        let tracker = AttemptTracker::new();
        let id = "device-a";

        assert_eq!(tracker.remaining(id), 5);
        assert!(!tracker.is_blocked(id));

        assert_eq!(tracker.record_failure(id), 4);
        assert_eq!(tracker.record_failure(id), 3);
        assert_eq!(tracker.record_failure(id), 2);
        assert_eq!(tracker.record_failure(id), 1);

        // 第 5 次失败触发封锁
        assert_eq!(tracker.record_failure(id), 0);
        assert!(tracker.is_blocked(id));
        assert_eq!(tracker.remaining(id), 0);

        // 封锁期间继续失败不会把封锁时间无限延长，也不会 panic
        assert_eq!(tracker.record_failure(id), 0);
        let blocked = tracker.blocked_for(id).expect("should be blocked");
        assert!(blocked.as_secs() <= 15 * 60);
        assert!(blocked.as_secs() > 14 * 60);
    }

    #[test]
    fn identifiers_are_independent() {
        let tracker = AttemptTracker::new();
        tracker.record_failure("device-a");
        tracker.record_failure("device-a");

        assert_eq!(tracker.remaining("device-a"), 3);
        assert_eq!(tracker.remaining("device-b"), 5);
        assert!(!tracker.is_blocked("device-b"));
    }

    #[test]
    fn success_clears_the_record() {
        let tracker = AttemptTracker::new();
        for _ in 0..4 {
            tracker.record_failure("device-a");
        }
        assert_eq!(tracker.remaining("device-a"), 1);

        tracker.clear("device-a");
        assert_eq!(tracker.remaining("device-a"), 5);
        assert!(!tracker.is_blocked("device-a"));
    }

    #[test]
    fn expired_block_releases_automatically() {
        // block_minutes = 0 -> 解封时间就是当下，下一次访问即视为已解封
        let tracker = AttemptTracker::with_config(SecurityConfig {
            max_attempts: 1,
            block_minutes: 0,
            reset_minutes: 30,
        });

        assert_eq!(tracker.record_failure("device-a"), 0);
        assert!(
            !tracker.is_blocked("device-a"),
            "零时长封锁应当立刻失效而不是永久锁定"
        );
        assert_eq!(tracker.remaining("device-a"), 1);
    }

    #[test]
    fn clear_all_removes_everything() {
        let tracker = AttemptTracker::new();
        tracker.record_failure("a");
        tracker.record_failure("b");
        tracker.clear_all();
        assert_eq!(tracker.remaining("a"), 5);
        assert_eq!(tracker.remaining("b"), 5);
    }
}
