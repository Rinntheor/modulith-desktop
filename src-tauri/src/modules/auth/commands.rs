// src-tauri/src/modules/auth/commands.rs
//
// 授权模块的 Tauri 命令。
//
// 安全要点（迁移时补上的）：
//   1. 所有敏感命令都要求携带会话令牌并通过校验。hive_atelier 的
//      get_login_logs / get_known_devices / toggle_auto_login 等命令完全没有
//      鉴权，任何能调用 invoke 的代码都能调用。
//      这在 Modulith 里尤其重要：插件 bundle 与宿主运行在**同一个 WebView**，
//      插件代码可以直接 invoke 任意后端命令，因此后端必须自己把门。
//      （残余风险：同源 JS 仍可读取 sessionStorage 里的令牌，见 README/汇报说明。）
//   2. 没有内置默认密钥：未初始化时 verify 直接报错，由前端引导「创建访问密钥」。
//   3. Argon2id 校验放在阻塞线程池执行，不占用异步运行时。
//   4. 「记住我」令牌会被真正校验（解密 + 摘要比对），不是一个可手改的布尔开关。

use super::config::{self, AuthConfig};
use super::crypto;
use super::types::{
    AuthResponse, AuthStatus, DeviceFingerprint, KeySetupResponse, KnownDevice, LoginLogEntry,
    RecoveryVerification, SecurityInfo, SecurityOverview,
};
use super::state::AuthState;
use tauri::{AppHandle, State};
use zeroize::Zeroize;

/// 会话失效时统一返回的错误
const UNAUTHORIZED: &str = "未授权的操作：会话无效或已过期，请重新解锁";

// ============================================================
// 内部辅助
// ============================================================

/// 在锁内修改配置并立即落盘。
///
/// 保存失败只记日志，不打断认证流程（内存状态已经更新，
/// 下次成功落盘会一并写入）。闭包是同步的，绝不会跨 await 持锁。
fn mutate_config<F>(app: &AppHandle, state: &AuthState, f: F)
where
    F: FnOnce(&mut AuthConfig),
{
    let mut cfg = state.config.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut cfg);
    if let Err(e) = config::save(app, &cfg) {
        log::error!("保存授权状态失败: {e}");
    }
}

/// 校验会话；`require_auth` 关闭时视为已解锁（否则设置页会不可用）
fn ensure_unlocked(state: &AuthState, token: &str) -> Result<(), String> {
    if !state.config_snapshot().require_auth {
        return Ok(());
    }
    if state.validate_session(token) {
        Ok(())
    } else {
        Err(UNAUTHORIZED.to_string())
    }
}

fn log_entry(device_id: &str, label: &str, success: bool, outcome: &str) -> LoginLogEntry {
    LoginLogEntry {
        timestamp: AuthState::now_iso(),
        success,
        device_id: device_id.to_string(),
        device_label: label.to_string(),
        outcome: outcome.to_string(),
    }
}

/// 把「还有多久解封」转成 ISO 8601 时间点
fn iso_in(duration: std::time::Duration) -> String {
    let secs = duration.as_secs().min(i64::MAX as u64) as i64;
    (chrono::Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339()
}

fn failure_with(
    device_id: String,
    state: &AuthState,
    blocked: Option<std::time::Duration>,
    message: Option<String>,
) -> AuthResponse {
    AuthResponse::failure(
        device_id.clone(),
        SecurityInfo {
            remaining_attempts: state.attempts.remaining(&device_id),
            is_new_device: false,
            blocked_until: blocked.map(iso_in),
            message,
        },
    )
}

async fn hash_in_background(key: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let result = crypto::hash_access_key(&key);
        let mut buf = key;
        buf.zeroize();
        result
    })
    .await
    .map_err(|e| format!("哈希任务失败: {e}"))?
}

async fn verify_in_background(key: String, hash: String) -> bool {
    match tokio::task::spawn_blocking(move || {
        let result = crypto::verify_access_key(&key, &hash);
        let mut buf = key;
        buf.zeroize();
        result
    })
    .await
    {
        Ok(Ok(valid)) => valid,
        Ok(Err(e)) => {
            log::error!("校验访问密钥时出错: {e}");
            false
        }
        Err(e) => {
            log::error!("校验任务执行失败: {e}");
            false
        }
    }
}

/// 批量哈希恢复码（阻塞线程池，一次任务算完整批）
///
/// 刻意整批放在同一个 `spawn_blocking` 里，而不是每枚各起一个任务：
/// Argon2 每次约 30ms，三枚串行约 100ms；分成多个任务只是徒增调度开销，
/// 且在阻塞线程池繁忙时更容易排队。
async fn hash_recovery_codes_in_background(codes: Vec<String>) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut hashes = Vec::with_capacity(codes.len());
        for code in &codes {
            hashes.push(crypto::hash_recovery_code(code)?);
        }
        // 擦除明文副本
        let mut owned = codes;
        for code in owned.iter_mut() {
            code.zeroize();
        }
        Ok::<Vec<String>, String>(hashes)
    })
    .await
    .map_err(|e| format!("恢复码哈希任务失败: {e}"))?
}

/// 在已存储的恢复码哈希中查找匹配项，返回命中下标（阻塞线程池）
async fn match_recovery_in_background(code: String, hashes: Vec<String>) -> Option<usize> {
    match tokio::task::spawn_blocking(move || {
        let result = crypto::match_recovery_code(&code, &hashes);
        let mut buf = code;
        buf.zeroize();
        result
    })
    .await
    {
        Ok(found) => found,
        Err(e) => {
            log::error!("恢复码校验任务执行失败: {e}");
            None
        }
    }
}

// ============================================================
// 状态查询
// ============================================================

/// 一次性读取启动所需的授权状态
#[tauri::command]
pub async fn get_auth_status(
    state: State<'_, AuthState>,
    device_fingerprint: DeviceFingerprint,
    token: Option<String>,
) -> Result<AuthStatus, String> {
    let snapshot = state.config_snapshot();
    let device_id = device_fingerprint.device_id();

    // 「已认证」由会话推导，不存在独立的布尔标志位
    let authenticated = if !snapshot.require_auth {
        true
    } else {
        token
            .as_deref()
            .map(|t| state.validate_session(t))
            .unwrap_or(false)
    };

    let blocked_for = state.attempts.blocked_for(&device_id);

    Ok(AuthStatus {
        initialized: snapshot.is_initialized(),
        authenticated,
        require_auth: snapshot.require_auth,
        // 只有真的存有可用令牌时才报告「记住我」已开启
        auto_login: snapshot.auto_login && snapshot.has_remember_token(),
        blocked: blocked_for.is_some(),
        remaining_attempts: state.attempts.remaining(&device_id),
        blocked_until: blocked_for.map(iso_in),
        session_remaining_hours: if authenticated {
            state.session_remaining_hours()
        } else {
            0.0
        },
        device_id,
        has_recovery_code: snapshot.has_recovery_code(),
        remaining_recovery_codes: snapshot.remaining_recovery_codes(),
        locked_by_user: state.is_locked(),
    })
}

/// 校验会话令牌（前端每次启动/reload 后用它确认会话仍然有效）
#[tauri::command]
pub async fn verify_session(state: State<'_, AuthState>, token: String) -> Result<bool, String> {
    Ok(state.validate_session(&token))
}

/// 当前机器的硬件指纹（界面展示用）
#[tauri::command]
pub async fn get_hardware_fingerprint() -> Result<crypto::HardwareFingerprint, String> {
    Ok(crypto::cached_fingerprint().clone())
}

// ============================================================
// 初始化 / 验证
// ============================================================

/// 首次设置访问密钥（只允许在尚未初始化时调用）。
///
/// 同时生成一枚恢复码并**在返回值里明文返回一次** —— 这是用户唯一一次
/// 能看到它的机会（之后只剩 Argon2 哈希）。前端必须展示并要求用户保存。
#[tauri::command]
pub async fn setup_access_key(
    app: AppHandle,
    state: State<'_, AuthState>,
    key: String,
    device_fingerprint: DeviceFingerprint,
) -> Result<KeySetupResponse, String> {
    if state.config_snapshot().is_initialized() {
        return Err("访问密钥已设置；如需更换请使用「修改访问密钥」".to_string());
    }

    crypto::validate_access_key(&key)?;

    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();
    let hash = hash_in_background(key).await?;

    // 恢复码与访问密钥一起建立：不留「以后有空再生成」的窗口，
    // 否则用户很可能在还没有恢复码时就忘记密钥。
    let recovery_codes = crypto::generate_recovery_codes();
    let recovery_hashes = hash_recovery_codes_in_background(recovery_codes.clone()).await?;

    let token = state.create_session(&device_id);
    // 首次创建密钥即视为已解锁
    state.clear_lock();
    let now = AuthState::now_iso();
    let salt = crypto::generate_salt();
    let remaining = state.attempts.remaining(&device_id);
    // 整套刚生成，剩余枚数就是整套数量。先取出来，后面 recovery_codes 会被移动。
    let recovery_codes_len = recovery_codes.len();

    mutate_config(&app, &state, |cfg| {
        cfg.verification_hash = Some(hash);
        cfg.crypto_salt = Some(salt);
        cfg.require_auth = true;
        cfg.key_updated_at = Some(now.clone());
        cfg.recovery_hash = recovery_hashes;
        cfg.recovery_created_at = Some(now.clone());
        cfg.upsert_device(&device_id, &label, &now);
        cfg.push_log(log_entry(&device_id, &label, true, "setup"));
    });

    Ok(KeySetupResponse {
        success: true,
        token: Some(token),
        device_id,
        security_info: SecurityInfo {
            remaining_attempts: remaining,
            is_new_device: true,
            ..Default::default()
        },
        recovery_codes,
        remaining_recovery_codes: recovery_codes_len,
    })
}

/// 验证访问密钥
#[tauri::command]
pub async fn verify_access_key(
    app: AppHandle,
    state: State<'_, AuthState>,
    key: String,
    device_fingerprint: DeviceFingerprint,
    remember_me: bool,
) -> Result<AuthResponse, String> {
    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();

    // 1) 频率限制
    if let Err(limited) = state.limiter.check(&device_id) {
        mutate_config(&app, &state, |cfg| {
            cfg.push_log(log_entry(&device_id, &label, false, "rate-limited"))
        });
        return Ok(failure_with(device_id, &state, None, Some(limited.to_string())));
    }

    // 2) 是否处于封锁期
    if let Some(blocked) = state.attempts.blocked_for(&device_id) {
        mutate_config(&app, &state, |cfg| {
            cfg.push_log(log_entry(&device_id, &label, false, "blocked"))
        });
        return Ok(failure_with(
            device_id,
            &state,
            Some(blocked),
            Some("该设备尝试次数过多，已被临时锁定".to_string()),
        ));
    }

    // 3) 是否已经初始化
    let snapshot = state.config_snapshot();
    let Some(stored_hash) = snapshot.verification_hash else {
        return Err("尚未设置访问密钥，请先完成初始化".to_string());
    };

    // 4) Argon2id 校验（阻塞线程池）
    if verify_in_background(key, stored_hash).await {
        state.attempts.clear(&device_id);
        state.limiter.clear(&device_id);
        // 用户亲手输入了密钥：解除「主动锁定」标记，恢复自动登录能力
        state.clear_lock();

        let token = state.create_session(&device_id);
        let now = AuthState::now_iso();
        let mut is_new_device = false;

        mutate_config(&app, &state, |cfg| {
            is_new_device = cfg.upsert_device(&device_id, &label, &now);
            cfg.push_log(log_entry(&device_id, &label, true, "ok"));

            // remember_me：生成一把随机密钥，用硬件绑定密钥加密后落盘，
            // 同时保存它的摘要——下次自动登录会真的比对，而不是只看开关。
            if remember_me {
                let salt = cfg
                    .crypto_salt
                    .clone()
                    .unwrap_or_else(|| {
                        let salt = crypto::generate_salt();
                        cfg.crypto_salt = Some(salt.clone());
                        salt
                    });

                let secret = crypto::generate_token();
                match crypto::encrypt_bound(&secret, crypto::binding_key(), &salt) {
                    Ok(cipher) => {
                        cfg.remember_token = Some(cipher);
                        cfg.remember_token_hash = Some(crypto::sha256_hex(secret.as_bytes()));
                        cfg.auto_login = true;
                    }
                    Err(e) => log::error!("生成「记住我」令牌失败，本次不启用自动登录: {e}"),
                }
            }
        });

        return Ok(AuthResponse::success(
            token,
            device_id.clone(),
            SecurityInfo {
                remaining_attempts: state.attempts.remaining(&device_id),
                is_new_device,
                ..Default::default()
            },
        ));
    }

    // 5) 失败：计入封锁并写审计日志
    state.attempts.record_failure(&device_id);
    let blocked = state.attempts.blocked_for(&device_id);
    let outcome = if blocked.is_some() { "blocked" } else { "bad-key" };

    mutate_config(&app, &state, |cfg| {
        cfg.push_log(log_entry(&device_id, &label, false, outcome))
    });

    Ok(failure_with(device_id, &state, blocked, None))
}

/// 「记住我」自动登录。
///
/// 与 hive_atelier 最大的区别：原实现只要 `autoLogin` 为真就直接建会话，
/// 加密令牌根本没被用过——把 auth.json 里 autoLogin 改成 true 即可永久绕过。
/// 这里必须同时满足：开关为真 + 密文能用本机硬件密钥解开 + 摘要比对一致。
///
/// **另外还必须「本进程未被主动锁定」。** 否则用户点「锁定」后按 F5 重载
/// WebView，就会因为凭据仍然有效而被自动放了进去 —— 那是个真实的安全漏洞。
/// 冷启动与主动锁定的区别见 `AuthState::locked` 的说明。
#[tauri::command]
pub async fn try_auto_login(
    app: AppHandle,
    state: State<'_, AuthState>,
    device_fingerprint: DeviceFingerprint,
) -> Result<AuthResponse, String> {
    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();
    let snapshot = state.config_snapshot();

    // 用户已主动锁定：必须输入访问密钥，不走自动登录。
    //
    // 这里的返回值**不带 message**：对前端来说这只是一次"没自动登录成功"，
    // 不是错误。带上提示语会在解锁界面上多出一条无意义的告警。
    if state.is_locked() {
        return Ok(failure_with(device_id, &state, None, None));
    }

    if !snapshot.auto_login || !snapshot.has_remember_token() {
        return Ok(failure_with(device_id, &state, None, None));
    }

    if let Some(blocked) = state.attempts.blocked_for(&device_id) {
        return Ok(failure_with(
            device_id,
            &state,
            Some(blocked),
            Some("该设备尝试次数过多，已被临时锁定".to_string()),
        ));
    }

    let (Some(cipher), Some(expected), Some(salt)) = (
        snapshot.remember_token.as_deref(),
        snapshot.remember_token_hash.as_deref(),
        snapshot.crypto_salt.as_deref(),
    ) else {
        return Ok(failure_with(device_id, &state, None, None));
    };

    // 解密失败 = 换机器 / 改硬件 / 密文被篡改，凭据已不可用，直接作废
    let secret = match crypto::decrypt_bound(cipher, crypto::binding_key(), salt) {
        Ok(secret) => secret,
        Err(e) => {
            log::warn!("自动登录凭据无法解密，已作废: {e}");
            mutate_config(&app, &state, |cfg| {
                cfg.clear_remember_token();
                cfg.push_log(log_entry(&device_id, &label, false, "auto-login-invalid"));
            });
            return Ok(failure_with(device_id, &state, None, Some(
                "自动登录凭据已失效（硬件环境已变化），请使用访问密钥解锁".to_string(),
            )));
        }
    };

    // 摘要比对：即使密文可解，也要确认它确实是当初保存的那把
    if !crypto::ct_eq(
        crypto::sha256_hex(secret.as_bytes()).as_bytes(),
        expected.as_bytes(),
    ) {
        log::warn!("自动登录凭据摘要不匹配，已作废");
        mutate_config(&app, &state, |cfg| {
            cfg.clear_remember_token();
            cfg.push_log(log_entry(&device_id, &label, false, "auto-login-invalid"));
        });
        return Ok(failure_with(device_id, &state, None, Some(
            "自动登录凭据校验失败，请使用访问密钥解锁".to_string(),
        )));
    }

    // 通过：建立会话，并轮换「记住我」密钥（用掉一次就换一把）
    //
    // 注意这里**不需要** clear_lock：走到这一步的前提就是未被锁定
    // （见方法开头的 is_locked 检查），标记本来就是 false。
    let token = state.create_session(&device_id);
    let now = AuthState::now_iso();
    let rotated = crypto::generate_token();
    let rotated_hash = crypto::sha256_hex(rotated.as_bytes());
    let encrypt_key = crypto::binding_key();
    let salt_owned = salt.to_string();

    mutate_config(&app, &state, |cfg| {
        match crypto::encrypt_bound(&rotated, encrypt_key, &salt_owned) {
            Ok(cipher) => {
                cfg.remember_token = Some(cipher);
                cfg.remember_token_hash = Some(rotated_hash);
            }
            Err(e) => {
                log::error!("轮换「记住我」令牌失败，已关闭自动登录: {e}");
                cfg.clear_remember_token();
            }
        }
        cfg.upsert_device(&device_id, &label, &now);
        cfg.push_log(log_entry(&device_id, &label, true, "auto-login"));
    });

    Ok(AuthResponse::success(
        token,
        device_id.clone(),
        SecurityInfo {
            remaining_attempts: state.attempts.remaining(&device_id),
            is_new_device: false,
            ..Default::default()
        },
    ))
}

/// 锁定应用：结束全部会话，并禁止本次进程内再次自动登录。
///
/// **保留**「记住我」凭据 —— 不作废它，否则下次冷启动的自动登录也会失效，
/// 「记住我」就退化成「只在同一次运行内有效」。
///
/// 必须同时置上「已锁定」标记：只删会话是不够的。WebView 重载会清空
/// `sessionStorage`，启动流程重新跑一遍时会再次尝试自动登录，而凭据仍然
/// 有效 —— 结果就是「点锁定 → 按 F5 → 直接进去」，锁定形同虚设。
/// 详见 `AuthState::locked` 的说明。
#[tauri::command]
pub async fn logout(
    app: AppHandle,
    state: State<'_, AuthState>,
    // 保留该参数以兼容既有调用方与 Tauri 的命令签名，但**刻意不使用**：
    // 锁定语义是"结束全部会话"，而不是"只结束这一个"，因此不看令牌内容。
    _token: String,
    device_fingerprint: DeviceFingerprint,
) -> Result<(), String> {
    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();

    // 先审计再锁：日志本身与锁定状态无关
    mutate_config(&app, &state, |cfg| {
        cfg.push_log(log_entry(&device_id, &label, true, "locked"))
    });

    // 无论传入的令牌是否有效，都执行「结束全部会话 + 置锁定标记」：
    // 这是"用户要求锁上"的语义，不该因为令牌过期而变成空操作。
    state.lock();
    Ok(())
}

// ============================================================
// 密钥管理
// ============================================================

/// 修改访问密钥
#[tauri::command]
pub async fn change_access_key(
    app: AppHandle,
    state: State<'_, AuthState>,
    token: String,
    old_key: String,
    new_key: String,
    device_fingerprint: DeviceFingerprint,
) -> Result<String, String> {
    ensure_unlocked(&state, &token)?;

    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();

    // 限流 + 封锁同样适用于「改密钥」这条猜密钥的路径
    if let Err(limited) = state.limiter.check(&device_id) {
        return Err(limited.to_string());
    }
    if state.attempts.is_blocked(&device_id) {
        return Err("尝试次数过多，该设备已被临时锁定".to_string());
    }

    crypto::validate_access_key(&new_key)?;

    let snapshot = state.config_snapshot();
    let Some(stored_hash) = snapshot.verification_hash.clone() else {
        return Err("尚未设置访问密钥".to_string());
    };

    if !verify_in_background(old_key, stored_hash.clone()).await {
        let remaining = state.attempts.record_failure(&device_id);
        mutate_config(&app, &state, |cfg| {
            cfg.push_log(log_entry(&device_id, &label, false, "bad-old-key"))
        });
        return Err(format!("原访问密钥不正确（剩余 {remaining} 次尝试机会）"));
    }

    // 新密钥不能和旧的一样
    if verify_in_background(new_key.clone(), stored_hash).await {
        return Err("新访问密钥不能与原密钥相同".to_string());
    }

    let new_hash = hash_in_background(new_key).await?;
    let new_salt = crypto::generate_salt();
    let now = AuthState::now_iso();
    let binding_key = crypto::binding_key();

    mutate_config(&app, &state, |cfg| {
        // 换密钥会轮换盐值，已加密的「记住我」凭据必须重新加密，
        // 否则会变成永远解不开的垃圾数据。
        if let (Some(cipher), Some(old_salt)) =
            (cfg.remember_token.clone(), cfg.crypto_salt.clone())
        {
            match crypto::decrypt_bound(&cipher, binding_key, &old_salt)
                .and_then(|secret| crypto::encrypt_bound(&secret, binding_key, &new_salt))
            {
                Ok(re_encrypted) => cfg.remember_token = Some(re_encrypted),
                Err(e) => {
                    log::warn!("重新加密「记住我」凭据失败，已关闭自动登录: {e}");
                    cfg.clear_remember_token();
                }
            }
        }

        cfg.verification_hash = Some(new_hash);
        cfg.crypto_salt = Some(new_salt);
        cfg.key_updated_at = Some(now.clone());
        cfg.push_log(log_entry(&device_id, &label, true, "key-changed"));
    });

    // **其他会话必须失效。** 密钥一换，任何用旧密钥换来的会话都不该再有效 ——
    // 这条路径此前完全没有撤销动作，于是改完密钥之后其他设备的会话仍能继续用到
    // TTL（24 小时）结束。与 `reset_access_key_with_recovery_code` 的处理对齐，
    // 唯一区别是**保留发起本次操作的那个会话**，否则用户刚改完就被自己登出。
    state.drop_other_sessions(&token);

    state.attempts.clear(&device_id);
    state.limiter.clear(&device_id);

    Ok("访问密钥已更新".to_string())
}

/// 是否要求访问密钥（关闭后启动直接进入应用）
#[tauri::command]
pub async fn set_require_auth(
    app: AppHandle,
    state: State<'_, AuthState>,
    token: String,
    enabled: bool,
    device_fingerprint: DeviceFingerprint,
) -> Result<bool, String> {
    ensure_unlocked(&state, &token)?;

    // 没有密钥就不允许「要求授权」，否则会把自己永久锁在门外
    if enabled && !state.config_snapshot().is_initialized() {
        return Err("请先设置访问密钥，再开启「需要访问密钥」".to_string());
    }

    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();

    mutate_config(&app, &state, |cfg| {
        cfg.require_auth = enabled;
        cfg.push_log(log_entry(
            &device_id,
            &label,
            true,
            if enabled {
                "require-auth-on"
            } else {
                "require-auth-off"
            },
        ));
    });

    Ok(enabled)
}

/// 开关「记住我」
#[tauri::command]
pub async fn set_auto_login(
    app: AppHandle,
    state: State<'_, AuthState>,
    token: String,
    enabled: bool,
    device_fingerprint: DeviceFingerprint,
) -> Result<bool, String> {
    ensure_unlocked(&state, &token)?;

    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();

    if !enabled {
        mutate_config(&app, &state, |cfg| {
            cfg.clear_remember_token();
            cfg.push_log(log_entry(&device_id, &label, true, "auto-login-off"));
        });
        return Ok(false);
    }

    let binding_key = crypto::binding_key();
    let secret = crypto::generate_token();
    let secret_hash = crypto::sha256_hex(secret.as_bytes());
    let mut succeeded = false;

    mutate_config(&app, &state, |cfg| {
        let salt = cfg.crypto_salt.clone().unwrap_or_else(|| {
            let salt = crypto::generate_salt();
            cfg.crypto_salt = Some(salt.clone());
            salt
        });

        match crypto::encrypt_bound(&secret, binding_key, &salt) {
            Ok(cipher) => {
                cfg.remember_token = Some(cipher);
                cfg.remember_token_hash = Some(secret_hash.clone());
                cfg.auto_login = true;
                cfg.push_log(log_entry(&device_id, &label, true, "auto-login-on"));
                succeeded = true;
            }
            Err(e) => log::error!("生成「记住我」令牌失败: {e}"),
        }
    });

    if !succeeded {
        return Err("生成「记住我」凭据失败，请查看日志".to_string());
    }

    Ok(true)
}

// ============================================================
// 恢复码
// ============================================================

/// 重新生成恢复码（需要已解锁会话）。
///
/// **整套旧恢复码立即作废**，换发一组新的 —— 只保留最新一批，避免
/// 「多年前那张纸仍然有效」。返回全部明文，前端须一次性展示。
///
/// 注意这是**唯一**能作废旧恢复码的入口：重置访问密钥时只作废被用掉的
/// 那一枚（见 `reset_access_key_with_recovery_code`），不会自动整套换发。
/// 因此「设置 → 安全 → 密钥恢复 → 重新生成」是用户主动清理旧纸的手段。
#[tauri::command]
pub async fn generate_recovery_code(
    app: AppHandle,
    state: State<'_, AuthState>,
    token: String,
    device_fingerprint: DeviceFingerprint,
) -> Result<Vec<String>, String> {
    ensure_unlocked(&state, &token)?;

    if !state.config_snapshot().is_initialized() {
        return Err("请先设置访问密钥，再生成恢复码".to_string());
    }

    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();

    let codes = crypto::generate_recovery_codes();
    let hashes = hash_recovery_codes_in_background(codes.clone()).await?;
    let now = AuthState::now_iso();

    mutate_config(&app, &state, |cfg| {
        cfg.recovery_hash = hashes;
        cfg.recovery_created_at = Some(now.clone());
        cfg.push_log(log_entry(&device_id, &label, true, "recovery-generated"));
    });

    Ok(codes)
}

/// 第一步：核验恢复码，通过后签发一个短时效的一次性令牌。
///
/// **本命令不修改任何状态**（除审计日志外），只回答"这串恢复码对不对"。
/// 这样界面可以做成两步：先让用户确认恢复码正确，再让他设置新密钥 ——
/// 而不是把三个输入框堆在一起，出错时用户分不清是哪一步的问题。
///
/// 安全约束与真正的重置一致：限流 + 失败计数 + 审计。
/// 凭证本身只存归一化恢复码的 SHA-256 摘要，不存原文。
#[tauri::command]
pub async fn verify_recovery_code(
    app: AppHandle,
    state: State<'_, AuthState>,
    recovery_code: String,
    device_fingerprint: DeviceFingerprint,
) -> Result<RecoveryVerification, String> {
    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();

    if let Err(limited) = state.limiter.check(&device_id) {
        mutate_config(&app, &state, |cfg| {
            cfg.push_log(log_entry(&device_id, &label, false, "recovery-rate-limited"))
        });
        return Err(limited.to_string());
    }

    if let Some(blocked) = state.attempts.blocked_for(&device_id) {
        mutate_config(&app, &state, |cfg| {
            cfg.push_log(log_entry(&device_id, &label, false, "blocked"))
        });
        return Ok(RecoveryVerification::failure(
            Some(blocked),
            "该设备尝试次数过多，已被临时锁定",
        ));
    }

    let snapshot = state.config_snapshot();
    let stored_hashes = snapshot.recovery_hash.clone();
    if stored_hashes.is_empty() {
        mutate_config(&app, &state, |cfg| {
            cfg.push_log(log_entry(&device_id, &label, false, "recovery-unavailable"))
        });
        return Err(
            "本机没有可用的恢复码。请删除应用数据目录下的 auth.json 后重新设置访问密钥（这会清除设备白名单与登录记录）"
                .to_string(),
        );
    }

    // 返回命中下标：它要随令牌一起保存，因为「用掉的是哪一枚」在第二步
    // 必须知道 —— 多枚恢复码各自独立失效。
    let Some(matched_index) =
        match_recovery_in_background(recovery_code.clone(), stored_hashes).await
    else {
        state.attempts.record_failure(&device_id);
        let remaining = state.attempts.remaining(&device_id);
        mutate_config(&app, &state, |cfg| {
            cfg.push_log(log_entry(&device_id, &label, false, "bad-recovery-code"))
        });
        return Ok(RecoveryVerification::failure(
            None,
            &format!("恢复码不正确（剩余 {remaining} 次尝试机会）"),
        ));
    };

    // 核验通过：清掉失败计数（与验证访问密钥成功时的处理一致），
    // 否则用户输错几次后即使这次对了也会很快被锁。
    state.attempts.clear(&device_id);

    let token = state.issue_recovery_grant(matched_index);
    mutate_config(&app, &state, |cfg| {
        cfg.push_log(log_entry(&device_id, &label, true, "recovery-verified"))
    });

    Ok(RecoveryVerification {
        verified: true,
        token: Some(token),
        message: None,
        blocked_until: None,
    })
}

/// 第二步：用第一步签发的令牌设置新访问密钥。
///
/// 令牌单次使用：用掉即删除，且重置成功后作废所有待用令牌。
/// 新密钥通过长度校验，流程与 `change_access_key` 一致
/// （轮换盐值、重新加密「记住我」凭据、清空全部会话）。
#[tauri::command]
pub async fn reset_access_key_with_recovery_code(
    app: AppHandle,
    state: State<'_, AuthState>,
    recovery_token: String,
    new_key: String,
    device_fingerprint: DeviceFingerprint,
) -> Result<KeySetupResponse, String> {
    let device_id = device_fingerprint.device_id();
    let label = device_fingerprint.label();

    // 令牌必须是第一步核验通过后签发的那一个；它携带"命中过哪一枚恢复码"
    let Some(matched_index) = state.consume_recovery_grant(&recovery_token) else {
        mutate_config(&app, &state, |cfg| {
            cfg.push_log(log_entry(&device_id, &label, false, "recovery-token-invalid"))
        });
        return Err("恢复凭据已失效，请重新输入恢复码".to_string());
    };

    if !state.config_snapshot().is_initialized() {
        return Err("尚未设置访问密钥，无需恢复".to_string());
    }

    crypto::validate_access_key(&new_key)?;

    let new_hash = hash_in_background(new_key).await?;
    let new_salt = crypto::generate_salt();
    let now = AuthState::now_iso();
    let new_token = state.create_session(&device_id);
    // 用恢复码完成重置也属于"用户亲手证明了自己"，解除主动锁定标记
    state.clear_lock();

    // 消费掉被用掉的那一枚之后，还剩几枚可用（供返回值与界面提示）
    let mut remaining_recovery_codes = 0usize;

    mutate_config(&app, &state, |cfg| {
        // 换密钥 → 轮换盐值 → 已加密的「记住我」凭据必须重新加密，
        // 否则会变成永远解不开的垃圾数据（与 change_access_key 同处理）。
        if let (Some(cipher), Some(old_salt)) =
            (cfg.remember_token.clone(), cfg.crypto_salt.clone())
        {
            match crypto::decrypt_bound(&cipher, crypto::binding_key(), &old_salt)
                .and_then(|secret| crypto::encrypt_bound(&secret, crypto::binding_key(), &new_salt))
            {
                Ok(re_encrypted) => cfg.remember_token = Some(re_encrypted),
                Err(e) => {
                    log::warn!("恢复后重新加密「记住我」凭据失败，已关闭自动登录: {e}");
                    cfg.clear_remember_token();
                }
            }
        }

        cfg.verification_hash = Some(new_hash);
        cfg.crypto_salt = Some(new_salt);
        cfg.key_updated_at = Some(now.clone());

        // **只作废被用掉的那一枚，其余保留。**
        //
        // 这里曾经是"整套换发新的"，那是一个有致命缺陷的设计：如果攻击者
        // 先用一枚恢复码重置了密钥，整套就会换成攻击者手里拿到的码，而用户
        // 手中的纸全部作废 —— 攻击者不但拿到了访问权，还把合法用户永久锁在
        // 门外。只作废用掉的那一枚之后，用户始终保留夺回控制权的能力。
        //
        // 代价：不再有"一次重置就清空所有旧纸"的自动行为。要主动作废旧纸，
        // 必须去「设置 → 安全 → 密钥恢复」点「重新生成」。
        cfg.consume_recovery_code(matched_index);
        remaining_recovery_codes = cfg.remaining_recovery_codes();

        cfg.upsert_device(&device_id, &label, &now);
        // 审计里记下用的是第几枚，便于排查"是不是同一张纸被反复使用"
        cfg.push_log(log_entry(
            &device_id,
            &label,
            true,
            &format!("recovery-reset#{}", matched_index + 1),
        ));
    });

    // 密钥已更换：所有既有会话都必须失效；待用的恢复令牌一并作废
    state.drop_all_sessions();
    state.drop_all_recovery_grants();
    state.attempts.clear(&device_id);
    state.limiter.clear(&device_id);

    // 先算完再移动 device_id：结构体字面量里 device_id 会被按值移动，
    // 之后再借用它作为参数会编译失败。
    let remaining_attempts = state.attempts.remaining(&device_id);

    Ok(KeySetupResponse {
        success: true,
        token: Some(new_token),
        device_id,
        security_info: SecurityInfo {
            remaining_attempts,
            is_new_device: false,
            ..Default::default()
        },
        // 不再换发：把剩余可用枚数告诉前端，让界面如实显示
        recovery_codes: Vec::new(),
        remaining_recovery_codes,
    })
}

// ============================================================
// 安全中心
// ============================================================

#[tauri::command]
pub async fn get_security_overview(
    state: State<'_, AuthState>,
    token: String,
    device_fingerprint: DeviceFingerprint,
) -> Result<SecurityOverview, String> {
    ensure_unlocked(&state, &token)?;

    let snapshot = state.config_snapshot();
    let device_id = device_fingerprint.device_id();
    let blocked_for = state.attempts.blocked_for(&device_id);

    // 先取出需要在结构体字面量里「按值移动」的字段之外的信息：
    // snapshot 的部分字段会被 move 进返回结构，之后再借用 snapshot 会编译失败。
    let has_recovery_code = snapshot.has_recovery_code();
    let remaining_recovery_codes = snapshot.remaining_recovery_codes();
    let remaining_attempts = state.attempts.remaining(&device_id);

    Ok(SecurityOverview {
        initialized: snapshot.is_initialized(),
        authenticated: true,
        require_auth: snapshot.require_auth,
        auto_login: snapshot.auto_login && snapshot.has_remember_token(),
        session_remaining_hours: (state.session_remaining_hours() * 10.0).round() / 10.0,
        remaining_attempts,
        blocked: blocked_for.is_some(),
        blocked_until: blocked_for.map(iso_in),
        known_device_count: snapshot.known_devices.len(),
        login_log_count: snapshot.login_logs.len(),
        has_recovery_code,
        remaining_recovery_codes,
        recovery_created_at: snapshot.recovery_created_at,
        key_updated_at: snapshot.key_updated_at,
    })
}

/// 已知设备列表（`isCurrent` 标记当前设备）
#[tauri::command]
pub async fn get_known_devices(
    state: State<'_, AuthState>,
    token: String,
    device_fingerprint: DeviceFingerprint,
) -> Result<Vec<KnownDevice>, String> {
    ensure_unlocked(&state, &token)?;

    let current = device_fingerprint.device_id();
    let mut devices = state.config_snapshot().known_devices;
    for device in devices.iter_mut() {
        device.is_current = device.device_id == current;
    }

    // 最近使用过的排前面
    devices.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    Ok(devices)
}

/// 移除一台已知设备，并结束它在内存中的所有会话
#[tauri::command]
pub async fn remove_known_device(
    app: AppHandle,
    state: State<'_, AuthState>,
    token: String,
    device_id: String,
) -> Result<(), String> {
    ensure_unlocked(&state, &token)?;

    let target = device_id.clone();
    mutate_config(&app, &state, |cfg| {
        cfg.known_devices.retain(|d| d.device_id != target);
    });

    // 让「移除设备」真的有效：把该设备的会话一并踢掉
    state.drop_sessions_for_device(&device_id);

    Ok(())
}

/// 登录日志（最新的在前）
#[tauri::command]
pub async fn get_login_logs(
    state: State<'_, AuthState>,
    token: String,
) -> Result<Vec<LoginLogEntry>, String> {
    ensure_unlocked(&state, &token)?;

    let snapshot = state.config_snapshot();
    Ok(snapshot.login_logs.iter().rev().cloned().collect())
}

/// 清空登录日志
#[tauri::command]
pub async fn clear_login_logs(
    app: AppHandle,
    state: State<'_, AuthState>,
    token: String,
) -> Result<(), String> {
    ensure_unlocked(&state, &token)?;

    mutate_config(&app, &state, |cfg| cfg.login_logs.clear());
    Ok(())
}
