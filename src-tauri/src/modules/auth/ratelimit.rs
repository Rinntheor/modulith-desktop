// src-tauri/src/modules/auth/ratelimit.rs
//
// 滑动窗口速率限制：即使密钥泄露，也不允许无限次暴力尝试。
// 与失败封锁（security.rs）互补——封锁看「累计失败」，限流看「请求频率」。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 被限流时告诉调用方还要等多久
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimited {
    pub retry_after_secs: u64,
}

impl std::fmt::Display for RateLimited {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "请求过于频繁，请在 {} 秒后重试", self.retry_after_secs)
    }
}

/// 跟踪的标识数量上限
const MAX_TRACKED_IDENTIFIERS: usize = 256;

/// 滑动窗口速率限制器
pub struct RateLimiter {
    requests: Mutex<HashMap<String, Vec<Instant>>>,
    max_requests: usize,
    window: Duration,
}

impl RateLimiter {
    pub fn new(max_requests: usize, window_seconds: u64) -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            max_requests,
            window: Duration::from_secs(window_seconds),
        }
    }

    pub fn max_requests(&self) -> usize {
        self.max_requests
    }

    pub fn window_seconds(&self) -> u64 {
        self.window.as_secs()
    }

    /// 记录一次请求；超出配额时返回需要等待的秒数
    pub fn check(&self, identifier: &str) -> Result<(), RateLimited> {
        let now = Instant::now();
        let window = self.window;
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());

        if requests.len() > MAX_TRACKED_IDENTIFIERS {
            requests.retain(|_, times| {
                times.retain(|t| now.saturating_duration_since(*t) < window);
                !times.is_empty()
            });
        }

        let entry = requests.entry(identifier.to_string()).or_default();
        entry.retain(|t| now.saturating_duration_since(*t) < window);

        if entry.len() >= self.max_requests {
            // 最早一次请求滑出窗口后就能再次尝试
            let oldest = entry[0];
            let elapsed = now.saturating_duration_since(oldest);
            let wait = window.saturating_sub(elapsed).as_secs().max(1);
            return Err(RateLimited {
                retry_after_secs: wait,
            });
        }

        entry.push(now);
        Ok(())
    }

    /// 验证成功后清空该标识的记录
    pub fn clear(&self, identifier: &str) {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(identifier);
    }

    /// 清空全部记录
    pub fn clear_all(&self) {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_quota_then_rejects() {
        let limiter = RateLimiter::new(3, 60);
        assert_eq!(limiter.max_requests(), 3);
        assert_eq!(limiter.window_seconds(), 60);

        assert!(limiter.check("device-a").is_ok());
        assert!(limiter.check("device-a").is_ok());
        assert!(limiter.check("device-a").is_ok());

        let err = limiter.check("device-a").expect_err("should be limited");
        assert!(err.retry_after_secs >= 1 && err.retry_after_secs <= 60);
        assert!(err.to_string().contains("秒"));
    }

    #[test]
    fn identifiers_have_separate_buckets() {
        let limiter = RateLimiter::new(1, 60);
        assert!(limiter.check("device-a").is_ok());
        assert!(limiter.check("device-a").is_err());
        // 另一个设备不受影响
        assert!(limiter.check("device-b").is_ok());
    }

    #[test]
    fn clear_resets_the_bucket() {
        let limiter = RateLimiter::new(1, 60);
        assert!(limiter.check("device-a").is_ok());
        assert!(limiter.check("device-a").is_err());

        limiter.clear("device-a");
        assert!(limiter.check("device-a").is_ok());
    }

    #[test]
    fn zero_window_never_accumulates() {
        // 窗口为 0 时，旧记录立即过期，不应永久限流
        let limiter = RateLimiter::new(1, 0);
        for _ in 0..5 {
            assert!(limiter.check("device-a").is_ok());
        }
    }

    #[test]
    fn clear_all_resets_every_bucket() {
        let limiter = RateLimiter::new(1, 60);
        assert!(limiter.check("a").is_ok());
        assert!(limiter.check("b").is_ok());
        limiter.clear_all();
        assert!(limiter.check("a").is_ok());
        assert!(limiter.check("b").is_ok());
    }
}
