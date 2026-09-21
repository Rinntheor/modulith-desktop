// src-tauri/src/modules/net/mod.rs
//
// 网络模块：**出站策略**与**流量日志**的家。
//
// 为什么独立成模块，而不是塞进 `settings`（那里已经有 proxy 与网络诊断）：
// 这里装的是"网络"这件事本身 —— 出站判定、流量日志、出站门面，
// 以及后面要落的 `net.listListening`（端口占用查询插件需要它）。
// `settings` 的定位是"设置项的存取与校验"，不是"所有碰网络的东西"。

pub mod client;
pub mod commands;
pub mod log;
pub mod policy;
pub mod prompt;

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

    /// 托管询问状态。
    ///
    /// 状态必须在 `setup` 里交出去，命令与门面都通过 `app.state::<PromptState>()`
    /// 取它 —— 换成进程级单例（像 `log` 那样）也能跑，但那样就没法在测试里拿到
    /// 一个干净的实例，而这个模块里"本会话已放行的主机"恰恰是最需要能独立验证的
    /// 东西。
    fn setup(&self, app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        use tauri::Manager;
        app.manage(prompt::PromptState::new());
        Ok(())
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

// ============================================================
// 回环判定
//
// 放在这里由策略、门面与插件权限检查**共用**。原先它只是 `manager.rs` 里的一个
// 私有函数，服务于"外部主机才需要 network-external 权限"那一条；策略也需要它
// （回环不出本机），而两份实现迟早会在某个边界值上分叉。
// ============================================================

/// 是否是本机回环地址
///
/// 覆盖主机名形式（`localhost`）与 IP 形式。`[::1]` 要单独判：从 URL 里取出的
/// IPv6 主机名带方括号，`parse::<IpAddr>` 吃不下它。
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_loopback_in_both_notations() {
        for host in ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"] {
            assert!(is_loopback_host(host), "{host} 应当被判为回环");
        }
    }

    #[test]
    fn does_not_mistake_lookalikes_for_loopback() {
        // 这几条是安全相关的反例：把它们判成回环就等于放宽了出站判定，
        // 而 `localhost.evil.tld` 正是那种一眼扫过去像本地地址的域名
        for host in [
            "localhost.evil.tld",
            "notlocalhost",
            "128.0.0.1",
            "example.com",
            "0.0.0.0",
            "",
        ] {
            assert!(!is_loopback_host(host), "{host} 不该被判为回环");
        }
    }
}
