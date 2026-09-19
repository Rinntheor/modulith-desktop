// src-tauri/src/modules/updater/mod.rs
// 应用更新模块：按当前网络设置检查与安装新版本
//
// 历史上这一步由前端直接调用 `@tauri-apps/plugin-updater` 完成。之所以搬到这里，
// 理由写在 `commands.rs` 的文件头：清单地址与安装包地址都必须能在**每次调用时**
// 按用户选择的下载源改写，而官方前端插件两处都做不到。

pub mod commands;

use crate::prelude::*;

/// 应用更新模块
pub struct UpdaterModule;

impl Module for UpdaterModule {
    fn id(&self) -> &'static str {
        "updater"
    }

    fn name(&self) -> &'static str {
        "应用更新"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "检查与安装应用更新，地址按网络设置改写"
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        app.manage(commands::UpdateState::new());
        Ok(())
    }
}
