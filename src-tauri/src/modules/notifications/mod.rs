// src-tauri/src/modules/notifications/mod.rs
// 应用内通知模块
//
// 定位：给「事情来找你」提供一条通道。
//
// 之前的 Modulith 所有信息流都是「用户去点模块」，后台发生的事情没有任何
// 途径浮到眼前 —— 插件加载失败只能写进开发者工具控制台，一个需要用户注意的
// 状态也只能等用户恰好打开那个模块才看得到。本模块把通知变成一等数据：
// 落盘、有未读状态、可按来源聚合。
//
// 关于「为什么不做系统级通知」：那需要新增 tauri-plugin-notification 依赖并
// 改动 Cargo.toml。当前版本刻意不引入新依赖，因此这里只做**应用内**通知，
// 用户在应用打开时能看到。这一点在文档里如实标注，不假装已经覆盖了应用关闭
// 时的提醒场景。

pub mod commands;
pub mod store;

use crate::prelude::*;
use tauri::Manager;

/// 应用内通知模块
pub struct NotificationsModule;

impl Module for NotificationsModule {
    fn id(&self) -> &'static str {
        "notifications"
    }

    fn name(&self) -> &'static str {
        "通知"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "应用内通知：持久化、未读状态与按来源聚合"
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let mut list = store::load(app);
        commands::normalize_loaded(&mut list);

        let summary = commands::summarize(&list);
        log::info!(
            "通知已就绪：共 {} 条，其中未读 {} 条",
            summary.total,
            summary.unread
        );

        app.manage(commands::NotificationsState::new(list));
        Ok(())
    }
}
