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

/// 两条拒绝原因的原文。
///
/// 提成常量而不是内联在 `decide` 里，是因为前端 `netGuard.ts` 需要**逐字相同**
/// 的镜像（同步上下文里等不了 IPC），而 `pnpm check:network` 要能按名字把两侧
/// 对上 —— 内联字符串没法被那句断言找到。
pub const DENY_OFFLINE: &str = "离线模式已开启";
pub const DENY_POLICY: &str = "出站策略为「禁止出站」";
/// 「默认询问」档下用户按了拒绝
pub const DENY_PROMPT_REFUSED: &str = "你在询问里拒绝了这次出站";
/// 「默认询问」档下用户没有在时限内回答
///
/// 超时的方向是**拒绝**，与本项目其他不可判定处的取向一致（认证配置损坏时也
/// 是"需要授权"而不是放行）。这里的代价很具体：用户离开电脑时那批请求会失败，
/// 而失败是可见、可重试的；反过来放行则是一次没有发生的同意。
pub const DENY_PROMPT_TIMEOUT: &str = "等待出站确认超时，已按拒绝处理";

/// 一次请求的判定结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 放行
    Allow,
    /// 放行到「询问」这一步为止 —— 真正的结果由 `prompt::ask` 决定。
    ///
    /// 它刻意**不**表达成 `Deny` 也不表达成 `Allow`：前者会让选了「默认询问」的
    /// 用户发现所有网络都坏了，后者等于替他点了"允许"。
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
        return Decision::Deny(DENY_OFFLINE);
    }
    match mode {
        MODE_DENY => Decision::Deny(DENY_POLICY),
        MODE_ASK => Decision::AllowPendingPrompt,
        // 含未知取值：见文件头第 3 条
        _ => Decision::Allow,
    }
}

/// 判定结果在日志里的标记
pub fn outcome_of(decision: Decision) -> &'static str {
    match decision {
        Decision::Allow => "allowed",
        // 走完询问流程之后由 `client.rs` 换成下面两个具体取值之一；
        // 这个中间态本身不写进日志（写进去就等于把"问过了"说成"放行了"）。
        Decision::AllowPendingPrompt => "allowed-pending-prompt",
        Decision::Deny(_) => "denied",
    }
}

/// 日志里「询问」相关的三个取值。
///
/// 拆成三个而不是一个 `allowed`，是为了让流量日志能回答"这一条是用户点头放行的、
/// 还是本会话里早就放行过这个主机"。把两者混在一起，用户就再也看不出自己到底
/// 同意过什么 —— 而"我到底同意过什么"正是这个档位存在的全部意义。
pub const OUTCOME_BY_PROMPT: &str = "allowed-by-prompt";
pub const OUTCOME_BY_SESSION: &str = "allowed-session";

/// WebView 里"直接联网"被拒的原因。
///
/// 前端 `netGuard.ts` 有一份**逐字相同**的镜像（同步上下文里等不了 IPC），
/// 由 `pnpm check:network` 断言两侧一致。
pub const DENY_DIRECT: &str =
    "插件不能直接联网，请改用 ctx.http（它带权限检查、出站策略与流量日志）";

/// WebView 里**直接**出站的判定。
///
/// 与 [`decide`] 的差别只有一处：**即使策略是"放行"，WebView 里的直接请求也不行。**
///
/// 原因不是洁癖，而是三项能力的归属：权限检查（哪个插件、有没有声明 `network`）、
/// 出站策略、流量日志，全部落在 Rust 侧的 `plugin_http_request` 上。一个直达网络的
/// `fetch` 把它们一起绕过去了 —— 而且连"是谁发的"都无从知道。
///
/// 所以插件联网的唯一合法通道是宿主给的 `ctx.http`。
///
/// **回环仍然放行**：它不出本机，而且"插件连本地开发服务器"是正当场景。
pub fn decide_frontend_direct(mode: &str, offline: bool, loopback: bool) -> Decision {
    match decide(mode, offline, loopback) {
        // 用户自己关掉了网络时，他的原因比"该走 ctx.http"更相关
        Decision::Deny(reason) => Decision::Deny(reason),
        _ if loopback => Decision::Allow,
        _ => Decision::Deny(DENY_DIRECT),
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
        hint: "每次出站前先问一次。本会话内已放行过的主机会被记住，不再重复询问 —— 市场一次操作会连发索引、签名、说明与包下载，只给「允许一次」会让这一档没法用",
        available: true,
        unavailable_reason: "",
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
        // ask 在 `decide` 这一层的责任**只是把请求放行到「询问」这一步**。
        // 真正的放行或拒绝由 `prompt::ask` 决定，结果由 `client.rs` 写回日志。
        //
        // 这里不能返回 Deny：那会让选了「默认询问」的用户发现所有网络都坏了，
        // 而他选的不是"禁止"。也不能返回 Allow：那等于替他点了"允许"。
        assert_eq!(decide(MODE_ASK, false, false), Decision::AllowPendingPrompt);
    }

    #[test]
    fn unknown_mode_falls_back_to_allow() {
        // 见文件头第 3 条：损坏的设置不该让应用失去联网能力
        assert_eq!(decide("", false, false), Decision::Allow);
        assert_eq!(decide("nonsense", false, false), Decision::Allow);
    }

    #[test]
    fn every_advertised_mode_is_implemented() {
        // 这条断言的方向在 1.3.2 反了过来。
        //
        // 它原本锁的是"只有 allow 与 deny 的 available 为 true"（因为 ask 尚未
        // 实现），作用是防止有人把 ask 标成可用却忘了实现。现在 ask 落地了，
        // 于是它改成锁**每一档都必须有事发生** —— 一个对外宣称可用的档位如果
        // 什么都不做，界面就在说谎，而那比"标着尚未实现"更糟。
        for mode in POLICY_MODES {
            assert!(mode.available, "{} 宣称可用，但没有人验证过它真的生效", mode.id);
            assert!(
                mode.unavailable_reason.is_empty(),
                "{} 可用时不该带不可用原因",
                mode.id
            );
            assert!(is_valid_mode(mode.id), "{} 不是合法取值", mode.id);
        }

        // 档位表与判定函数的取值集合必须一一对应：少一档意味着界面上有选项却
        // 落进 `_ =>` 那条默认分支（静默变成"放行"）。
        let ids: Vec<&str> = POLICY_MODES.iter().map(|mode| mode.id).collect();
        assert_eq!(ids, vec![MODE_ALLOW, MODE_ASK, MODE_DENY]);
    }

    #[test]
    fn prompt_outcomes_are_distinguishable_in_the_log() {
        // 三个取值必须互不相同：把它们混成 `allowed` 之后，用户就再也看不出
        // "这一条是我点头放行的"还是"本会话里早就放行过这个主机"。
        let values = [
            outcome_of(Decision::Allow),
            OUTCOME_BY_PROMPT,
            OUTCOME_BY_SESSION,
            outcome_of(Decision::Deny(DENY_POLICY)),
        ];
        let unique: std::collections::HashSet<&&str> = values.iter().collect();
        assert_eq!(unique.len(), values.len(), "日志里的结果标记必须互不相同");
    }

    #[test]
    fn frontend_direct_is_denied_even_when_the_policy_allows() {
        // 这一条是"CSP + 门面"两条路能自洽的关键：WebView 里的直接 fetch 不是
        // "被策略允许的请求"，而是"走错了通道的请求"。放行档下它也发不出去，
        // 因为权限检查、策略与日志都在后端那条通道上。
        for mode in [MODE_ALLOW, MODE_ASK, "垃圾值"] {
            assert!(
                matches!(decide_frontend_direct(mode, false, false), Decision::Deny(_)),
                "{mode} 档下前端直接出站应当被拒"
            );
        }
    }

    #[test]
    fn frontend_direct_reports_the_users_reason_first() {
        // 离线/禁止出站时，用户按下那个开关的原因比"该走 ctx.http"更相关：
        // 前者是他自己的决定，后者是插件作者的实现建议
        assert_eq!(
            decide_frontend_direct(MODE_ALLOW, true, false),
            Decision::Deny("离线模式已开启")
        );
        assert_eq!(
            decide_frontend_direct(MODE_DENY, false, false),
            Decision::Deny("出站策略为「禁止出站」")
        );
    }

    #[test]
    fn frontend_direct_still_allows_loopback() {
        // 本地开发（插件连本机服务）是正当场景，且回环不出本机
        for mode in [MODE_ALLOW, MODE_ASK, MODE_DENY] {
            for offline in [false, true] {
                assert_eq!(
                    decide_frontend_direct(mode, offline, true),
                    Decision::Allow,
                    "{mode} / offline={offline}"
                );
            }
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
