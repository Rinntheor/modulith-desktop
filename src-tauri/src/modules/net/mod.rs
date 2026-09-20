// src-tauri/src/modules/net/mod.rs
//
// 网络模块：**出站策略**与**流量日志**的家。
//
// 为什么独立成模块，而不是塞进 `settings`（那里已经有 proxy 与网络诊断）：
// 这一批后面还有两件事落在这里 ——
//   * `net.listListening`（端口占用查询插件需要它，见开发计划）；
//   * 把两处各自 new 出来的 `reqwest::Client` 合并成一个门面
//     （`plugins/manager.rs` 一个、`settings/probe.rs` 一个；更新器那条更麻烦，
//     它走 `tauri-plugin-updater` 自带的传输，我们的门面看不见它）。
// 那两件事都属于"网络"，而 `settings` 现在的定位是"设置项的存取与校验"。

pub mod commands;
pub mod log;
pub mod policy;

use crate::core::module::Module;

pub struct NetModule;

impl Module for NetModule {
    fn id(&self) -> &'static str {
        "net"
    }

    fn name(&self) -> &'static str {
        "网络"
    }

    fn description(&self) -> &'static str {
        "出站策略与流量日志（记录为主，拦截逐步接入）"
    }
}

// ============================================================
// 来源标记
//
// 与 `pluginRuntime` 里 `plugin:<插件ID>` 的命令前缀是同一套记法：出了问题要归因时，
// 日志里那串字符必须能直接对上代码里的那一处。
//
// **没有来源的日志回答不了"是谁发的"**，而那正是它存在的唯一理由。
// ============================================================

pub const SOURCE_HOST: &str = "host";

pub fn plugin_source(plugin_id: &str) -> String {
    format!("plugin:{}", plugin_id)
}

pub fn module_source(module_id: &str) -> String {
    format!("module:{}", module_id)
}
