// src-tauri/src/modules/auth/types.rs
//
// 授权系统对前端暴露的数据结构。
//
// 命名约定：与 Modulith 其他模块保持一致，序列化统一使用 camelCase，
// 因此前端直接用同名驼峰字段即可（hive_atelier 用的是 snake_case，
// 迁移时统一改掉了，避免前端出现两种风格）。

use serde::{Deserialize, Serialize};

/// 前端上报的设备指纹（WebView 侧的纯软件特征）
///
/// 这些值都能被伪造，因此它只用于「区分设备 / 限流 / 日志」，
/// 真正的硬件绑定靠 `crypto::HardwareFingerprint`（Rust 侧采集）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFingerprint {
    pub user_agent: String,
    pub screen_resolution: String,
    pub timezone: String,
    pub language: String,
    pub platform: String,
}

impl Default for DeviceFingerprint {
    fn default() -> Self {
        Self {
            user_agent: String::new(),
            screen_resolution: String::new(),
            timezone: String::new(),
            language: String::new(),
            platform: std::env::consts::OS.to_string(),
        }
    }
}

/// 会话信息（只存在于内存，进程退出即失效）
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub token: String,
    pub device_id: String,
    /// Unix 秒
    pub created_at: i64,
    /// Unix 秒，每次校验通过都会刷新
    pub last_seen: i64,
}

impl SessionInfo {
    /// 会话是否仍然有效（24 小时 TTL）
    pub fn is_valid(&self, ttl_secs: i64, now: i64) -> bool {
        now.saturating_sub(self.created_at) < ttl_secs
    }

    /// 剩余有效时间（小时）
    pub fn remaining_hours(&self, ttl_secs: i64, now: i64) -> f64 {
        let elapsed = now.saturating_sub(self.created_at);
        if elapsed >= ttl_secs {
            0.0
        } else {
            (ttl_secs - elapsed) as f64 / 3600.0
        }
    }
}

/// 已知设备（持久化到 auth.json，重启后依然保留）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownDevice {
    pub device_id: String,
    pub label: String,
    /// ISO 8601
    pub first_seen: String,
    /// ISO 8601
    pub last_seen: String,
    /// 是否为当前设备（由命令按需填充，不落盘）
    #[serde(default)]
    pub is_current: bool,
}

/// 登录日志条目（持久化，最多保留 `config::MAX_LOGIN_LOGS` 条）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginLogEntry {
    /// ISO 8601
    pub timestamp: String,
    pub success: bool,
    pub device_id: String,
    pub device_label: String,
    /// 结果说明：`ok` / `bad-key` / `blocked` / `rate-limited` / `auto-login` ...
    pub outcome: String,
}

/// 验证结果附带的安全信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityInfo {
    /// 剩余可尝试次数
    pub remaining_attempts: u32,
    /// 本次是否为新设备
    pub is_new_device: bool,
    /// 若被封锁，给出解封时间（ISO 8601）
    pub blocked_until: Option<String>,
    /// 失败原因（可直接展示给用户）。
    ///
    /// 区分「密钥错误」「被限流」「被封锁」比笼统报错更有用，
    /// hive_atelier 的返回体里没有这个字段，前端只能猜。
    #[serde(default)]
    pub message: Option<String>,
}

impl Default for SecurityInfo {
    fn default() -> Self {
        Self {
            remaining_attempts: 0,
            is_new_device: false,
            blocked_until: None,
            message: None,
        }
    }
}

/// 设置密钥 / 验证密钥 / 自动登录的统一返回体
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub success: bool,
    pub token: Option<String>,
    /// 当前设备 ID（前端可用来展示「本机」）
    pub device_id: String,
    pub security_info: SecurityInfo,
}

impl AuthResponse {
    pub fn failure(device_id: String, security_info: SecurityInfo) -> Self {
        Self {
            success: false,
            token: None,
            device_id,
            security_info,
        }
    }

    pub fn success(token: String, device_id: String, security_info: SecurityInfo) -> Self {
        Self {
            success: true,
            token: Some(token),
            device_id,
            security_info,
        }
    }
}

/// 应用启动时一次性读取的授权状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// 是否已经设置过访问密钥
    pub initialized: bool,
    /// 当前会话是否已通过验证
    pub authenticated: bool,
    /// 是否要求访问密钥（关闭后启动直接进入）
    pub require_auth: bool,
    /// 是否开启了「记住我」
    pub auto_login: bool,
    pub blocked: bool,
    pub remaining_attempts: u32,
    pub blocked_until: Option<String>,
    /// 当前会话剩余有效时间（小时）
    pub session_remaining_hours: f64,
    pub device_id: String,
    /// 是否还有可用的恢复码。
    ///
    /// 全部用完后前端必须提示用户「忘记访问密钥将无法恢复」，
    /// 因为此时唯一的出路是删除 auth.json（等于丢掉全部授权状态）。
    pub has_recovery_code: bool,
    /// 剩余可用的恢复码数量
    pub remaining_recovery_codes: usize,
    /// 当前进程是否处于「用户主动锁定」状态。
    ///
    /// 为 true 时自动登录被禁用，必须输入访问密钥。该标记活在 Rust 进程里，
    /// 因此跨 WebView 重载保持、应用重启即重置（冷启动应允许自动登录）。
    /// 前端用它来避免"为什么记住了却没自动登录"的困惑。
    pub locked_by_user: bool,
}

/// 安全中心概览
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityOverview {
    pub initialized: bool,
    pub authenticated: bool,
    pub require_auth: bool,
    pub auto_login: bool,
    pub session_remaining_hours: f64,
    pub remaining_attempts: u32,
    pub blocked: bool,
    pub blocked_until: Option<String>,
    pub known_device_count: usize,
    pub login_log_count: usize,
    /// 最近一次修改访问密钥的时间（ISO 8601）
    pub key_updated_at: Option<String>,
    /// 是否还有可用的恢复码
    pub has_recovery_code: bool,
    /// 剩余可用的恢复码数量
    pub remaining_recovery_codes: usize,
    /// 恢复码生成时间（ISO 8601）
    pub recovery_created_at: Option<String>,
}

/// 恢复码核验结果（两步恢复流程的第一步）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryVerification {
    /// 恢复码是否正确
    pub verified: bool,
    /// 核验通过时签发的**一次性**令牌，用于第二步设置新密钥。
    /// 未通过时为 `None`。
    pub token: Option<String>,
    /// 失败原因（可直接展示），成功时为 `None`
    pub message: Option<String>,
    /// 若因尝试过多被锁定，给出解封时间（ISO 8601）
    pub blocked_until: Option<String>,
}

impl RecoveryVerification {
    /// 构造失败结果；`blocked` 为 `Some` 时附带解封时间。
    pub fn failure(blocked: Option<std::time::Duration>, message: &str) -> Self {
        let blocked_until = blocked.map(|d| {
            let secs = d.as_secs().min(i64::MAX as u64) as i64;
            (chrono::Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339()
        });

        Self {
            verified: false,
            token: None,
            message: Some(message.to_string()),
            blocked_until,
        }
    }
}

/// 新建 / 重置访问密钥的结果。
///
/// 与 `AuthResponse` 分开，是因为它可能多带一组**一次性**的恢复码明文：
/// 后端只在生成的那一刻返回它们，之后只剩 Argon2 哈希，再也拿不回来。
/// 前端必须在这一步把恢复码展示给用户并明确提示「只显示这一次」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySetupResponse {
    /// 与 `AuthResponse` 相同：新会话令牌
    pub success: bool,
    pub token: Option<String>,
    pub device_id: String,
    pub security_info: SecurityInfo,
    /// 本次新生成的恢复码明文列表。
    ///
    /// **仅在两个场景下非空**：
    ///   * `setup_access_key` —— 首次创建密钥，同时生成整套；
    ///   * 未来任何"重新生成"入口。
    ///
    /// `reset_access_key_with_recovery_code` 返回**空数组**：重置只消费掉
    /// 用掉的那一枚，不换发（见该方法上的说明）。
    pub recovery_codes: Vec<String>,
    /// 重置之后还剩几枚可用恢复码（非重置场景为整套数量）。
    ///
    /// 单独给出这个数字，是为了让界面能如实显示"剩余 N 枚"，
    /// 而不必为了知道数量再去查一次授权状态。
    #[serde(default)]
    pub remaining_recovery_codes: usize,
}
