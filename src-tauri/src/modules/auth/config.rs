// src-tauri/src/modules/auth/config.rs
//
// 授权状态的持久化（`<app_data_dir>/auth.json`）。
//
// 为什么单独一个文件：hive_atelier 把 verification_hash / crypto_salt / 自动登录
// 令牌全都塞在「模块偏好」config.json 里，与模块排序、隐藏列表混在一起，
// 既容易被前端整体覆盖，也让「重置模块偏好」有顺手清掉密钥的风险。
// 这里独立成 auth.json，并且只由本模块读写。
//
// 读写逻辑都接受 `&Path`，方便单元测试直接落到临时目录，不需要构造 AppHandle。

use super::types::{KnownDevice, LoginLogEntry};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

/// 授权状态文件名（位于 `app_data_dir()` 下）
pub const AUTH_FILE_NAME: &str = "auth.json";
/// 登录日志最多保留条数
pub const MAX_LOGIN_LOGS: usize = 100;
/// 已知设备最多保留台数
pub const MAX_KNOWN_DEVICES: usize = 32;
/// 会话有效期（小时）
pub const SESSION_TTL_HOURS: i64 = 24;
/// 会话有效期（秒）
pub const SESSION_TTL_SECS: i64 = SESSION_TTL_HOURS * 3600;

/// 授权状态
///
/// `#[serde(default)]` 让部分字段缺失（老版本文件、手工编辑）时自动回落到默认值，
/// 而不是整个文件解析失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthConfig {
    /// 访问密钥的 Argon2id 哈希（PHC 字符串）。`None` 表示还没设置过密钥
    pub verification_hash: Option<String>,
    /// HKDF 盐值（用于派生硬件绑定密钥）
    pub crypto_salt: Option<String>,
    /// 「记住我」令牌的密文（AES-256-GCM，硬件绑定）
    pub remember_token: Option<String>,
    /// 「记住我」令牌的 SHA-256 摘要，用于校验解密结果
    pub remember_token_hash: Option<String>,
    /// 是否启用「记住我」
    pub auto_login: bool,
    /// 是否需要访问密钥才能进入应用
    pub require_auth: bool,
    /// 已知设备列表
    pub known_devices: Vec<KnownDevice>,
    /// 登录日志（最新的在末尾）
    pub login_logs: Vec<LoginLogEntry>,
    /// 最近一次修改访问密钥的时间（ISO 8601）
    pub key_updated_at: Option<String>,
    /// 恢复码的 Argon2id 哈希（PHC 字符串）列表。
    ///
    /// 与访问密钥同等对待：只存哈希，且每次重新生成都用新的随机盐。
    /// 空列表表示「尚未生成恢复码」——此时忘记访问密钥就只能靠重置
    /// auth.json 恢复（等于丢掉所有授权状态）。
    ///
    /// 为什么是列表而不是单个哈希（这是一处真实的设计修正）：
    /// 最初只发一枚 32 字符的长恢复码，界面上按 4 字符分组显示。
    /// 结果用户把它读成"八个恢复码"，只输入其中一组，自然报错 ——
    /// **歧义的根源是「一整串按组分隔的字符」这个形态本身**：它既像一个码，
    /// 也像八个码，用户无法判断。
    ///
    /// 改成"多枚互不相干的短恢复码，每枚各用一次"之后：
    ///   * 每行都是一个完整、可独立使用的恢复码，不存在"要不要全输"的疑问；
    ///   * 丢了几枚还有其余可用，不必因为抄漏而作废全部；
    ///   * 与 GitHub / Google 的备份码形态一致，用户已有心智模型。
    ///
    /// **刻意不加 `#[serde(default)]`**：老版本的 `authHash` 是单个字符串，
    /// 反序列化到 `Vec<String>` 会失败，从而让整份 `auth.json` 回落到
    /// 「已锁定、未初始化」默认值 —— 那会**连访问密钥一起丢掉**，是不可接受的。
    /// 因此这里接受失败，由 `lib` 层用 `load_from_with_reason` 检出并只清理
    /// 恢复码字段（见该函数说明）。
    pub recovery_hash: Vec<String>,
    /// 恢复码生成时间（ISO 8601），仅用于界面展示。
    ///
    /// 与 `recovery_hash` 同样刻意不加 `#[serde(default)]`，保持两者同生共死：
    /// 要么一起解析成功，要么一起让文件被判定为需要迁移。
    pub recovery_created_at: Option<String>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            verification_hash: None,
            crypto_salt: None,
            remember_token: None,
            remember_token_hash: None,
            auto_login: false,
            // 默认开启访问密钥：既然是授权系统，默认必须是「锁着的」
            require_auth: true,
            known_devices: Vec::new(),
            login_logs: Vec::new(),
            key_updated_at: None,
            recovery_hash: Vec::new(),
            recovery_created_at: None,
        }
    }
}

impl AuthConfig {
    /// 是否已经设置过访问密钥
    pub fn is_initialized(&self) -> bool {
        self.verification_hash.is_some()
    }

    /// 是否还有可用的恢复码
    pub fn has_recovery_code(&self) -> bool {
        !self.recovery_hash.is_empty()
    }

    /// 剩余可用的恢复码数量
    pub fn remaining_recovery_codes(&self) -> usize {
        self.recovery_hash.len()
    }

    /// 是否具备可用的「记住我」凭据
    pub fn has_remember_token(&self) -> bool {
        self.remember_token.is_some()
            && self.remember_token_hash.is_some()
            && self.crypto_salt.is_some()
    }

    /// 记录/更新一台设备，返回它是否为新设备
    pub fn upsert_device(&mut self, device_id: &str, label: &str, now_iso: &str) -> bool {
        if let Some(existing) = self
            .known_devices
            .iter_mut()
            .find(|d| d.device_id == device_id)
        {
            existing.label = label.to_string();
            existing.last_seen = now_iso.to_string();
            return false;
        }

        self.known_devices.push(KnownDevice {
            device_id: device_id.to_string(),
            label: label.to_string(),
            first_seen: now_iso.to_string(),
            last_seen: now_iso.to_string(),
            is_current: false,
        });

        // 只保留最近使用的若干台（ISO 8601 字符串可直接按字典序比较）
        if self.known_devices.len() > MAX_KNOWN_DEVICES {
            self.known_devices
                .sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
            self.known_devices.truncate(MAX_KNOWN_DEVICES);
        }

        true
    }

    /// 追加一条登录日志并裁剪到上限
    pub fn push_log(&mut self, entry: LoginLogEntry) {
        self.login_logs.push(entry);
        if self.login_logs.len() > MAX_LOGIN_LOGS {
            let excess = self.login_logs.len() - MAX_LOGIN_LOGS;
            self.login_logs.drain(0..excess);
        }
    }

    /// 清除「记住我」凭据（关闭自动登录 / 改密钥时调用）
    pub fn clear_remember_token(&mut self) {
        self.remember_token = None;
        self.remember_token_hash = None;
        self.auto_login = false;
    }

    /// 清除恢复码（重新生成时 / 全部用完时调用）
    pub fn clear_recovery_code(&mut self) {
        self.recovery_hash.clear();
        self.recovery_created_at = None;
    }

    /// 消费（删除）指定下标的恢复码，返回是否成功。
    ///
    /// **只删除被用掉的那一枚，其余保留。** 这是刻意的语义，理由值得写清楚：
    ///
    /// 曾经的设计是"恢复成功 → 整套换发新的"。它有致命缺陷：如果攻击者
    /// 先用一枚恢复码重置了访问密钥，整套就会换成**攻击者手里**的新码，
    /// 而用户手中的纸全部作废 —— 攻击者不仅拿到了访问权，还把合法用户
    /// 永久锁在门外。
    ///
    /// 改成只作废被用掉的那一枚之后：
    ///   * 每枚仍然是一次性的（"纸被抄走也不怕"这个根本性质不变）；
    ///   * 攻击者重置密钥**不会**动到用户手里的其余几枚；
    ///   * 用户因此**始终保留夺回控制权的能力** —— 这是比"自动清空旧纸"
    ///     重要得多的性质。
    ///
    /// 代价：不再有"一次重置就清空所有旧纸"的自动行为。要作废旧纸必须
    /// 主动点「重新生成」，因此界面上那个按钮是唯一入口（见 SecuritySettings）。
    pub fn consume_recovery_code(&mut self, index: usize) -> bool {
        if index >= self.recovery_hash.len() {
            return false;
        }
        self.recovery_hash.remove(index);

        // 全部用完后把生成时间一并清掉：否则界面会显示"生成于 X"却没有任何
        // 可用恢复码，属于自相矛盾的状态。
        if self.recovery_hash.is_empty() {
            self.recovery_created_at = None;
        }

        true
    }

    /// 落盘前的自检，避免把明显损坏的状态写进去
    pub fn validate(&self) -> Result<(), String> {
        if let Some(hash) = &self.verification_hash {
            if !hash.starts_with("$argon2") {
                return Err("verification_hash 不是合法的 Argon2 PHC 字符串".to_string());
            }
        }

        // 恢复码与访问密钥同样的存储约束：绝不允许明文落盘。
        // 这条检查能拦住「误把恢复码原文写进 recoveryHash」这类事故。
        for hash in &self.recovery_hash {
            if !hash.starts_with("$argon2") {
                return Err("recoveryHash 中存在非法的 Argon2 PHC 字符串".to_string());
            }
        }

        if self.auto_login && self.remember_token.is_some() && self.crypto_salt.is_none() {
            return Err("存在「记住我」令牌但缺少 crypto_salt，无法解密".to_string());
        }

        Ok(())
    }
}

// ============================================================
// 读写
// ============================================================

/// 授权文件在指定目录下的路径
pub fn auth_path_in(dir: &Path) -> PathBuf {
    dir.join(AUTH_FILE_NAME)
}

/// 授权文件的完整路径（必要时创建应用数据目录）
pub fn auth_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;

    Ok(auth_path_in(&app_dir))
}

/// 从指定路径读取；文件缺失或损坏时返回默认值并记录日志
pub fn load_from(path: &Path) -> AuthConfig {
    load_from_with_reason(path).0
}

/// 读取结果：配置 + 是否发生了「仅恢复码不可迁移」的降级
///
/// 第二个返回值为 `true` 表示：文件本身是合法的 JSON，只有恢复码字段因为
/// 格式变迁（单枚长码 → 多枚短码）而无法解析，于是**只清空了恢复码**，
/// 访问密钥、已知设备、登录日志全部保留。
///
/// 这个区分很重要：如果直接让整个文件解析失败，`serde` 会回落到默认值，
/// 而那意味着访问密钥一起丢失 —— 用户会被要求重新设置密钥，等同于数据
/// 灾难。恢复码是可再生的，密钥不是。
pub fn load_from_with_reason(path: &Path) -> (AuthConfig, bool) {
    if !path.exists() {
        return (AuthConfig::default(), false);
    }

    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) => {
            log::warn!("读取授权文件失败，使用默认授权状态: {e}");
            return (AuthConfig::default(), false);
        }
    };

    match serde_json::from_str::<AuthConfig>(&content) {
        Ok(config) => (config, false),
        Err(first_error) => {
            // 先判断是否只是恢复码字段的问题：清掉它再试一次。
            if let Some(recovered) = try_recover_by_dropping_recovery_code(&content) {
                log::warn!(
                    "授权文件中的恢复码字段为旧格式，已仅清除恢复码并保留访问密钥: {first_error}"
                );
                return (recovered, true);
            }

            // 这里绝不「失败即放行」：解析失败会得到 require_auth = true 的默认值，
            // 也就是把门锁上，而不是把门打开。
            log::warn!("解析授权文件失败，使用默认授权状态（需要重新设置密钥）: {first_error}");
            (AuthConfig::default(), false)
        }
    }
}

/// 尝试「仅移除恢复码字段」后重新解析
///
/// 返回 `Some` 表示移除后可以正常解析（说明问题确实出在恢复码格式上）；
/// 返回 `None` 表示还有别的问题，调用方应走完整的失败处理。
fn try_recover_by_dropping_recovery_code(content: &str) -> Option<AuthConfig> {
    let mut value: serde_json::Value = serde_json::from_str(content).ok()?;
    let object = value.as_object_mut()?;

    // 两个字段一起移除：recoveryCreatedAt 若留下会与实际状态不一致
    object.remove("recoveryHash");
    object.remove("recoveryCreatedAt");

    serde_json::from_value::<AuthConfig>(value).ok()
}

/// 原子写入：先写临时文件再 rename，避免崩溃留下半截 JSON
pub fn save_to(path: &Path, config: &AuthConfig) -> Result<(), String> {
    config.validate()?;

    let content =
        serde_json::to_string_pretty(config).map_err(|e| format!("Failed to serialize: {e}"))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create auth dir: {e}"))?;
    }

    let tmp_path = path.with_file_name(format!("{AUTH_FILE_NAME}.tmp"));
    fs::write(&tmp_path, content).map_err(|e| format!("Failed to write auth file: {e}"))?;

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to replace auth file: {e}"));
    }

    Ok(())
}

/// 读取授权状态
pub fn load(app: &AppHandle) -> AuthConfig {
    load_with_reason(app).0
}

/// 读取授权状态，并告知是否发生过「仅恢复码被清除」的迁移
pub fn load_with_reason(app: &AppHandle) -> (AuthConfig, bool) {
    match auth_path(app) {
        Ok(path) => {
            let (config, migrated) = load_from_with_reason(&path);

            // 迁移发生时立刻回写：否则每次启动都会重复走一遍"解析失败→修复"，
            // 日志也会重复刷。回写失败不影响本次运行（内存中的状态已经可用）。
            if migrated {
                match save_to(&path, &config) {
                    Ok(()) => log::info!("已清除旧格式的恢复码并回写授权文件"),
                    Err(e) => log::warn!("回写清理后的授权文件失败: {e}"),
                }
            }

            (config, migrated)
        }
        Err(e) => {
            log::warn!("无法定位授权文件，使用默认授权状态: {e}");
            (AuthConfig::default(), false)
        }
    }
}

/// 保存授权状态
pub fn save(app: &AppHandle, config: &AuthConfig) -> Result<(), String> {
    let path = auth_path(app)?;
    save_to(&path, config)
}

/// 重置为默认授权状态（会清掉访问密钥，恢复「未初始化」）
pub fn reset(app: &AppHandle) -> Result<AuthConfig, String> {
    let defaults = AuthConfig::default();
    save(app, &defaults)?;
    Ok(defaults)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("modulith-auth-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        auth_path_in(&dir)
    }

    fn log_entry(device: &str, outcome: &str) -> LoginLogEntry {
        LoginLogEntry {
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            success: outcome == "ok",
            device_id: device.to_string(),
            device_label: device.to_string(),
            outcome: outcome.to_string(),
        }
    }

    #[test]
    fn defaults_lock_the_app() {
        let config = AuthConfig::default();
        assert!(config.require_auth, "默认必须要求访问密钥");
        assert!(!config.auto_login);
        assert!(!config.is_initialized());
        assert!(!config.has_remember_token());
        assert!(config.known_devices.is_empty());
        assert!(config.login_logs.is_empty());
        assert_eq!(SESSION_TTL_HOURS, 24);
        assert_eq!(SESSION_TTL_SECS, 86400);
    }

    #[test]
    fn partial_json_falls_back_to_locked_defaults() {
        // 缺失字段时必须回落到 require_auth = true，而不是放行
        let config: AuthConfig = serde_json::from_str("{}").expect("empty object should load");
        assert!(config.require_auth);
        assert!(!config.is_initialized());

        let config: AuthConfig = serde_json::from_str(r#"{"autoLogin":true}"#)
            .expect("partial object should load");
        assert!(config.auto_login);
        assert!(config.require_auth);
    }

    #[test]
    fn serializes_with_camel_case_keys() {
        let json = serde_json::to_string(&AuthConfig::default()).expect("serialize");
        assert!(json.contains("\"verificationHash\""));
        assert!(json.contains("\"rememberToken\""));
        assert!(json.contains("\"autoLogin\""));
        assert!(json.contains("\"requireAuth\""));
        assert!(json.contains("\"knownDevices\""));
        assert!(json.contains("\"loginLogs\""));
        assert!(json.contains("\"keyUpdatedAt\""));
    }

    #[test]
    fn device_upsert_tracks_first_and_last_seen() {
        let mut config = AuthConfig::default();

        assert!(config.upsert_device("dev-1", "Win32 · 11111111", "2026-01-01T00:00:00Z"));
        assert_eq!(config.known_devices.len(), 1);
        assert_eq!(config.known_devices[0].first_seen, "2026-01-01T00:00:00Z");

        // 同一台设备再次出现：不算新设备，只刷新 last_seen / label
        assert!(!config.upsert_device("dev-1", "Win32 · aaaaaaaa", "2026-02-02T00:00:00Z"));
        assert_eq!(config.known_devices.len(), 1);
        assert_eq!(config.known_devices[0].first_seen, "2026-01-01T00:00:00Z");
        assert_eq!(config.known_devices[0].last_seen, "2026-02-02T00:00:00Z");
        assert_eq!(config.known_devices[0].label, "Win32 · aaaaaaaa");

        assert!(config.upsert_device("dev-2", "Win32 · 22222222", "2026-03-03T00:00:00Z"));
        assert_eq!(config.known_devices.len(), 2);
    }

    #[test]
    fn device_list_is_capped_keeping_most_recent() {
        let mut config = AuthConfig::default();
        for i in 0..(MAX_KNOWN_DEVICES + 5) {
            let ts = format!("2026-01-{:02}T00:00:00Z", (i % 28) + 1);
            config.upsert_device(&format!("dev-{i}"), "label", &ts);
        }
        assert_eq!(config.known_devices.len(), MAX_KNOWN_DEVICES);
    }

    #[test]
    fn login_logs_are_capped_and_keep_newest() {
        let mut config = AuthConfig::default();
        for i in 0..(MAX_LOGIN_LOGS + 10) {
            config.push_log(log_entry(&format!("dev-{i}"), "ok"));
        }
        assert_eq!(config.login_logs.len(), MAX_LOGIN_LOGS);
        // 最早的被丢掉，最新的还在
        assert_eq!(
            config.login_logs.last().unwrap().device_id,
            format!("dev-{}", MAX_LOGIN_LOGS + 9)
        );
        assert_eq!(config.login_logs.first().unwrap().device_id, "dev-10");
    }

    #[test]
    fn clear_remember_token_resets_both_fields() {
        let mut config = AuthConfig {
            remember_token: Some("cipher".to_string()),
            remember_token_hash: Some("hash".to_string()),
            crypto_salt: Some("salt".to_string()),
            auto_login: true,
            require_auth: true,
            ..AuthConfig::default()
        };
        assert!(config.has_remember_token());

        config.clear_remember_token();
        assert!(!config.has_remember_token());
        assert!(!config.auto_login);
        assert!(config.remember_token.is_none());
        assert!(config.remember_token_hash.is_none());
    }

    // ---------- 恢复码 ----------

    fn config_with_recovery(n: usize) -> AuthConfig {
        AuthConfig {
            recovery_hash: (0..n)
                .map(|i| format!("$argon2id$v=19$m=19456,t=2,p=1$salt{i}$hash{i}"))
                .collect(),
            recovery_created_at: Some("2026-01-01T00:00:00Z".to_string()),
            ..AuthConfig::default()
        }
    }

    /// **核心回归：只作废被用掉的那一枚，其余必须保留。**
    ///
    /// 这条测试锁定的是一个安全性质，不是实现细节：
    /// 若攻击者先用一枚恢复码重置了密钥，而实现"整套换发"，那么用户
    /// 手里的纸会全部作废，攻击者同时拿到访问权并把合法用户永久锁在门外。
    /// 只删除用掉的那一枚，用户才始终保有夺回控制权的能力。
    #[test]
    fn consuming_one_code_keeps_the_rest() {
        let mut config = config_with_recovery(3);
        assert_eq!(config.remaining_recovery_codes(), 3);

        // 用掉中间那一枚
        assert!(config.consume_recovery_code(1));

        assert_eq!(
            config.remaining_recovery_codes(),
            2,
            "只应删除被用掉的那一枚，其余必须保留"
        );
        // 保留的应当是原来的第 0、2 枚（顺序不变）
        assert!(config.recovery_hash[0].contains("salt0"));
        assert!(config.recovery_hash[1].contains("salt2"));
        assert!(config.has_recovery_code());
        // 还有剩余时生成时间应保留（界面要显示"生成于 X"）
        assert!(config.recovery_created_at.is_some());
    }

    #[test]
    fn consuming_last_code_clears_created_at() {
        let mut config = config_with_recovery(1);

        assert!(config.consume_recovery_code(0));

        assert!(!config.has_recovery_code());
        assert_eq!(config.remaining_recovery_codes(), 0);
        // 全部用完后必须清掉生成时间：否则界面会显示"生成于 X"却没有任何
        // 可用恢复码，属于自相矛盾的状态
        assert!(
            config.recovery_created_at.is_none(),
            "全部用完后生成时间必须一并清空"
        );
    }

    #[test]
    fn consuming_out_of_range_index_is_a_noop() {
        let mut config = config_with_recovery(2);

        assert!(!config.consume_recovery_code(5), "越界下标应返回 false");
        assert_eq!(config.remaining_recovery_codes(), 2, "越界不得改动任何数据");

        // 空列表同样安全
        let mut empty = AuthConfig::default();
        assert!(!empty.consume_recovery_code(0));
    }

    #[test]
    fn recovery_hashes_must_be_phc_strings() {
        let mut config = config_with_recovery(2);
        assert!(config.validate().is_ok());

        // 明文落盘必须被拦住
        config.recovery_hash.push("PLAINTEXT-CODE".to_string());
        assert!(
            config.validate().is_err(),
            "恢复码只允许存 Argon2 PHC 字符串，明文必须被拒绝"
        );
    }

    #[test]
    fn save_and_load_round_trip() {
        let path = temp_path();

        let mut config = AuthConfig::default();
        config.verification_hash = Some("$argon2id$v=19$m=19456,t=2,p=1$abc$def".to_string());
        config.crypto_salt = Some("salt-value".to_string());
        config.upsert_device("dev-1", "label", "2026-01-01T00:00:00Z");
        config.push_log(log_entry("dev-1", "ok"));

        save_to(&path, &config).expect("save");

        let loaded = load_from(&path);
        assert!(loaded.is_initialized());
        assert_eq!(loaded.crypto_salt.as_deref(), Some("salt-value"));
        assert_eq!(loaded.known_devices.len(), 1);
        assert_eq!(loaded.login_logs.len(), 1);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_file_loads_locked_defaults() {
        let path = temp_path();
        let config = load_from(&path);
        assert!(!config.is_initialized());
        assert!(config.require_auth);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupted_file_loads_locked_defaults() {
        let path = temp_path();
        fs::write(&path, "{ this is not json").expect("write broken file");

        let config = load_from(&path);
        // 关键：损坏时是「锁上」而不是「放行」
        assert!(config.require_auth);
        assert!(!config.is_initialized());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn save_rejects_invalid_state() {
        let path = temp_path();

        let mut config = AuthConfig::default();
        config.verification_hash = Some("plaintext-not-a-hash".to_string());
        assert!(save_to(&path, &config).is_err());

        // 有令牌却没有盐
        let config = AuthConfig {
            remember_token: Some("cipher".to_string()),
            auto_login: true,
            ..AuthConfig::default()
        };
        assert!(save_to(&path, &config).is_err());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let path = temp_path();
        let config = AuthConfig::default();
        save_to(&path, &config).expect("save");

        assert!(path.exists());
        assert!(!path.with_file_name(format!("{AUTH_FILE_NAME}.tmp")).exists());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
