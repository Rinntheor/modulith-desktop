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

use crate::modules::net::{log, policy};

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
