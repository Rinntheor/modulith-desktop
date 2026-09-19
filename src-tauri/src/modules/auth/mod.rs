// src-tauri/src/modules/auth/mod.rs
//
// 访问授权模块：访问密钥（Argon2id）+ 会话 + 设备记录 + 登录审计。
//
// 注意「设备记录」**不是白名单**：`known_devices` 只用于界面展示、限流与审计，
// 代码中没有任何一处据此拒绝登录。此前把它称作"设备白名单"是名实不符。
//
// 迁移自 hive_atelier 的 src/auth + src/module_config（认证相关部分），
// 但按 Modulith 的模块规范重组：所有状态由 `Module::setup` 注入，
// 命令集中在 commands.rs，配置独立落盘到 auth.json。

pub mod commands;
pub mod config;
pub mod crypto;
pub mod device;
pub mod ratelimit;
pub mod security;
pub mod state;
pub mod types;

use crate::prelude::*;

/// 访问授权模块
pub struct AuthModule;

impl Module for AuthModule {
    fn id(&self) -> &'static str {
        "auth"
    }

    fn name(&self) -> &'static str {
        "访问授权"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "访问密钥、会话管理、设备记录与登录审计"
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let current = config::load(app);

        log::info!(
            "授权模块就绪：已设置密钥 {}，要求授权 {}，记住我 {}，已知设备 {} 台",
            current.is_initialized(),
            current.require_auth,
            current.auto_login,
            current.known_devices.len()
        );

        // 配置损坏时 load() 会回落到「需要授权 + 未初始化」，
        // 也就是把门锁上并要求重新设置密钥，绝不会静默放行。
        if !current.is_initialized() && current.require_auth {
            log::warn!("尚未设置访问密钥，应用将引导用户完成初始化");
        }

        app.manage(state::AuthState::new(current));
        Ok(())
    }
}
