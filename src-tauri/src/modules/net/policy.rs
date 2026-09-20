// src-tauri/src/modules/net/policy.rs
//
// 出站策略：什么情况下允许一次网络请求出去。
//
// 这一层是**唯一的判定点**，与权限检查同源：请求由 Rust 发起，前端再判一次只会
// 多出一套可能与后端分叉的规则。
//
// ---------------------------------------------------------------------------
// 三个决定的来源，写在这里以免将来被"优化"掉：
//
//   1. **默认放行并记录**。出站管控的第一版是**可观测性**，不是拦截 —— 用户要先能
//      看到"这软件在连什么"，才有依据去决定要不要收紧。
//   2. **离线模式是独立的开关，且优先于策略。** 它不是"策略的第四档"：用户想要的是
//      "现在别联网"，而不是"把默认策略改成拒绝"（后者会连同他的选择一起被覆盖）。
//   3. **未知取值退回默认档（放行），而不是拒绝。** 一个损坏的设置不该让应用失去
//      联网能力 —— 策略的失效方向应当由用户显式选择，不该由解析失败决定。
//   4. **回环地址一律放行，离线模式下也是。** 见 `decide` 里的展开。这条最初只写在
//      "禁止出站"的档位说明里，而当时的 `decide` 根本没看过地址 —— 文案说的是行为，
//      实现里没有。现在两处一致了。
// ---------------------------------------------------------------------------

use serde::Serialize;

pub const MODE_ALLOW: &str = "allow";
pub const MODE_ASK: &str = "ask";
pub const MODE_DENY: &str = "deny";

/// 一次请求的判定结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 放行
    Allow,
    /// 放行，但记成「本应询问」。**询问流程尚未实现**，见 `POLICY_MODES` 里 ask 的说明
    AllowPendingPrompt,
    /// 拒绝，附带给用户看的原因
    Deny(&'static str),
}

pub fn is_valid_mode(value: &str) -> bool {
    matches!(value, MODE_ALLOW | MODE_ASK | MODE_DENY)
}

/// 判定。纯函数 —— 这是本模块唯一需要被断言的东西。
///
/// `loopback` 由调用方从 URL 里算出来（[`super::is_loopback_host`]），而不是在这里
/// 解析地址：这一层只做判定，解析属于调用方。
///
/// **回环先于一切。**"禁止出站"与"离线模式"要挡住的是**数据离开这台机器**；
/// 连 `localhost` 不构成离开，它既不消耗流量也不把数据交给第三方。把它一起挡掉的
/// 代价是两个正当场景同时失效：插件连本地开发服务器、以及网络诊断的自检 ——
/// 而这两个场景恰恰是用户最需要"网络别被自己挡住"的时候。
pub fn decide(mode: &str, offline: bool, loopback: bool) -> Decision {
    if loopback {
        return Decision::Allow;
    }
    if offline {
        return Decision::Deny("离线模式已开启");
    }
    match mode {
        MODE_DENY => Decision::Deny("出站策略为「禁止出站」"),
        MODE_ASK => Decision::AllowPendingPrompt,
        // 含未知取值：见文件头第 3 条
        _ => Decision::Allow,
    }
}

/// 判定结果在日志里的标记
pub fn outcome_of(decision: Decision) -> &'static str {
    match decision {
        Decision::Allow => "allowed",
        Decision::AllowPendingPrompt => "allowed-pending-prompt",
        Decision::Deny(_) => "denied",
    }
}

/// 给用户看的策略档位。
///
/// **由后端提供、前端渲染**，而不是前端手写一份 —— 与权限注册表同一个理由：
/// 同一份名单的第二份副本必然漂移。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyMode {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    /// 本档是否已经真正生效。false 的档位在界面上必须**禁用并给出原因**
    pub available: bool,
    /// 不可用的原因（available 为 true 时为空）
    pub unavailable_reason: &'static str,
}

pub const POLICY_MODES: &[PolicyMode] = &[
    PolicyMode {
        id: MODE_ALLOW,
        label: "默认放行并记录",
        hint: "请求照常发出，并在流量日志里留下一条记录。第一版出站管控是「先看得见」，不是「先拦得住」",
        available: true,
        unavailable_reason: "",
    },
    PolicyMode {
        id: MODE_ASK,
        label: "默认询问",
        hint: "每次出站前先问一次。**尚未实现** —— 它需要一条请求级的往返（暂停请求、前端弹确认、带回结果、超时兜底），属于独立的一批",
        available: false,
        unavailable_reason: "询问流程尚未实现：它需要请求级的前后端往返与超时兜底，会与「只记不拦」的第一版混在一起",
    },
    PolicyMode {
        id: MODE_DENY,
        label: "禁止出站",
        hint: "拒绝一切对外请求。本地回环地址不受影响 —— 拒绝 localhost 会让本地开发与诊断一起失效",
        available: true,
        unavailable_reason: "",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_wins_over_every_mode() {
        // 离线模式的语义是"现在别联网"，它必须压过默认档，否则用户改回默认档会
        // 顺手把离线一起解除 —— 那不是他按这个开关时想要的事
        for mode in [MODE_ALLOW, MODE_ASK, MODE_DENY, "垃圾值"] {
            assert!(
                matches!(decide(mode, true, false), Decision::Deny(_)),
                "{mode}"
            );
        }
    }

    #[test]
    fn loopback_is_never_blocked() {
        // 这一条防的是本文件头第 4 条记录的那个 bug 复发：档位说明写着"回环不受影响"，
        // 而实现里根本没看地址。用户开离线后，本地开发服务器与诊断自检会一起失效，
        // 而这两件事都不构成"数据离开这台机器"。
        for mode in [MODE_ALLOW, MODE_ASK, MODE_DENY, "垃圾值"] {
            for offline in [false, true] {
                assert_eq!(
                    decide(mode, offline, true),
                    Decision::Allow,
                    "{mode} / offline={offline} 下回环被挡住了"
                );
            }
        }
    }

    #[test]
    fn default_mode_allows() {
        assert_eq!(decide(MODE_ALLOW, false, false), Decision::Allow);
    }

    #[test]
    fn deny_mode_denies() {
        assert!(matches!(decide(MODE_DENY, false, false), Decision::Deny(_)));
    }

    #[test]
    fn ask_mode_allows_but_is_marked() {
        // ask 尚未实现：它不能假装成"已经问过并且用户同意了"，也不能直接拒绝
        // （那会让选了 ask 的用户发现所有网络都坏了）。记成待询问是当前唯一诚实的行为。
        assert_eq!(decide(MODE_ASK, false, false), Decision::AllowPendingPrompt);
    }

    #[test]
    fn unknown_mode_falls_back_to_allow() {
        // 见文件头第 3 条：损坏的设置不该让应用失去联网能力
        assert_eq!(decide("", false, false), Decision::Allow);
        assert_eq!(decide("nonsense", false, false), Decision::Allow);
    }

    #[test]
    fn only_allow_and_deny_are_available() {
        // 界面必须禁用未实现的档位。这条断言防的是"有人把 ask 的 available 改成 true
        // 而忘了实现询问流程" —— 那时开关会说谎。
        for mode in POLICY_MODES {
            assert_eq!(
                mode.available,
                mode.id == MODE_ALLOW || mode.id == MODE_DENY,
                "{} 的可用状态与实现不一致",
                mode.id
            );
            assert_eq!(mode.available, mode.unavailable_reason.is_empty());
        }
    }

    #[test]
    fn mode_ids_match_the_constants() {
        assert!(POLICY_MODES.iter().any(|m| m.id == MODE_ALLOW));
        assert!(POLICY_MODES.iter().any(|m| m.id == MODE_ASK));
        assert!(POLICY_MODES.iter().any(|m| m.id == MODE_DENY));
        assert!(is_valid_mode(MODE_ALLOW) && is_valid_mode(MODE_ASK) && is_valid_mode(MODE_DENY));
        assert!(!is_valid_mode("off"));
    }
}
