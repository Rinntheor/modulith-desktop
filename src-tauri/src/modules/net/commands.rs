// src-tauri/src/modules/net/commands.rs
//
// 网络模块对前端暴露的命令。
//
// 约定：每个后端模块一个 `commands.rs`，`scripts/generate-backend-module.ts` 会扫描
// 本文件里带 tauri 命令属性的函数，并把它们登记进 `lib.rs` 的 `generate_handler!` ——
// 因此**不要手工改 lib.rs**。
//
// 注意措辞：上面那句不能写出那个属性的字面量。生成器是**按出现次数计数**的
// （它不区分注释与代码），在注释里写一次就会让它以为多出一个未解析的命令而直接报错。
// 这个报错本身是好的 —— 它拦住的正是"漏注册、只有运行期调用时才暴露"那类问题。

use tauri::AppHandle;

use crate::modules::net::{is_loopback_host, log, policy};
use crate::modules::settings::settings as settings_store;

/// 给界面用的档位描述。
///
/// **由后端提供、前端渲染** —— 与权限注册表同一个理由：同一份名单的第二份副本
/// 必然漂移，而"某一档还没实现"这种事尤其容易被前端漏掉。
#[tauri::command]
pub fn net_policy_modes() -> Vec<policy::PolicyMode> {
    policy::POLICY_MODES.to_vec()
}

/// 最近的流量日志，**最新的在前**
#[tauri::command]
pub fn net_log_list(limit: Option<usize>) -> Vec<log::NetLogEntry> {
    log::list(limit.unwrap_or(200))
}

#[tauri::command]
pub fn net_log_clear() {
    log::clear()
}

/// 条数。界面上的角标只需要一个数字，不必把整表取回来
#[tauri::command]
pub fn net_log_len() -> usize {
    log::len()
}

/// 一次前端门面拦下的出站尝试：**记一条日志，并返回权威判定**。
///
/// 判定权在后端。前端传来的只是"发生过这件事"（地址、方法、声称的来源），
/// **不是结果** —— 让调用方决定日志写什么，等于让日志变成它自己的说法。
///
/// 前端为什么还要自己判一次：`XMLHttpRequest.send()` 与 `new WebSocket()` 都是
/// 同步的，等不了这次 IPC 往返。两份规则的一致性由 `pnpm check:network` 钉住。
///
/// 返回值只用于调试与将来的界面提示，前端不依赖它做拦截决定。
#[tauri::command]
pub fn net_note_frontend_outbound(
    app: AppHandle,
    url: String,
    method: String,
    source: String,
) -> bool {
    let settings = settings_store::load(&app);

    // 地址解析失败时 host 为空 —— 它不会被判成回环，因此仍然会被拒绝
    let host = reqwest::Url::parse(&url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default();

    let decision = policy::decide_frontend_direct(
        &settings.network_policy,
        settings.offline_mode,
        is_loopback_host(&host),
    );

    // 来源由前端给出，因此**它不能当作审计依据** —— 日志是诊断用的。
    // 截断是为了不让一个恶意/出错的来源字段把日志表撑坏。
    let source: String = source.chars().take(120).collect();
    let method = method.to_uppercase();
    let entry = log::NetLogEntry::outbound(&source, "插件前端请求", &method, &url, &host);

    match decision {
        policy::Decision::Deny(reason) => {
            log::record(entry.with_outcome("denied", Some(reason.to_string())));
            false
        }
        other => {
            log::record(entry.with_outcome(policy::outcome_of(other), None));
            true
        }
    }
}
