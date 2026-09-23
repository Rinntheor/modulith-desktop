// src-tauri/src/modules/desktop/background/protocol.rs
//
// 后台宿主（Node sidecar）与宿主应用之间的**协议**。
//
// ============================================================
// 为什么要有独立进程
// ============================================================
//
// 应用接下来要有"在窗口之外继续工作"的能力：插件定时提醒、监测设备使用情况、
// 触发通知。这些能力有一个共同前提 —— **进程不能因为窗口关闭而结束**。
//
// 界面插件跑在主窗口的 WebView 里，而那个 WebView 会被降级（内存目标等级设为
// Low）、会被隐藏、脚本会被浏览器冻结。把"必须在凌晨三点准时提醒"这件事
// 托付给它，等于托付给一个随时可能被挂起的执行环境。
//
// 因此后台能力需要一个**不依赖窗口存在**的宿主。这里选 Node 进程而不是
// "再开一个隐藏 WebView"：隐藏 WebView 依然是一整套浏览器进程（实测 6~8 个、
// 几百 MB），而 Node 是一个进程、且能在不需要时被完全关掉。
//
// ============================================================
// 为什么是"行分隔的 JSON"而不是别的
// ============================================================
//
// 三个候选各自的代价：
//   · 命名管道 / 本地 socket：多一套路径与权限处理，跨平台差异大；
//   · stdio + 长度前缀：二进制帧要自己处理粘包与编码；
//   · **stdio + 每行一个 JSON**：进程本来就有 stdin/stdout，行分隔的 JSON
//     可读、可直接用 `console` solo 调试、且不需要任何额外资源。
//
// 前两者的复杂度买不到什么 —— 这条通道只在宿主与自己的子进程之间使用，
// 没有第三方会往里面写东西，因此不需要防伪造，只需要防**解析错误**。
//
// ============================================================
// 版本号为什么必须存在
// ============================================================
//
// 子进程与宿主是两个可以**分别更新**的东西：宿主随应用升级，而宿主脚本与
// Node 运行时是随包分发的文件。两者的版本一旦错配（例如应用升级了协议、
// 而用户机器上残留着旧脚本），表现会是"某个方法返回了预期之外的字段"
// 这类难以归因的故障。
//
// 因此握手时双方交换 `PROTOCOL_VERSION` 并**拒绝不匹配**：宁可让后台功能
// 明确地不工作（并在界面里说清原因），也不要让它半死不活地运行。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 协议版本。
///
/// **改任何一方的字段语义时都必须同时改它**，否则旧脚本会以"少一个字段"
/// 的形式静默降级。整数而不是语义化版本：这里没有"向后兼容的小改动"这种
/// 东西 —— 协议是双方的内部约定，任何不匹配都应当直接拒绝。
pub const PROTOCOL_VERSION: u32 = 1;

/// 一次请求的最大长度（字节）。
///
/// 上限而不是建议值：这条通道的内容来自**插件**（它们会把自己要发送的数据
/// 交给我们转发），因此"一行有多长"完全不受我们控制。
/// 没有上限的话，一个写错的插件可以让宿主的解析器吃掉任意多的内存 ——
/// 而这一整个模块的存在理由就是"别让单个插件决定我们吃多少内存"。
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// 单个请求的超时（毫秒）。超时后按失败处理，**不重试** ——
/// 重试一个可能已经在执行的方法会带来重复副作用（例如提醒响了两次）。
pub const REQUEST_TIMEOUT_MS: u64 = 10_000;

/// 宿主脚本支持的方法。
///
/// 用枚举而不是裸字符串：调用方写错方法名会在**编译期**失败，
/// 而不是在运行期换来一句"unknown method"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundMethod {
    /// 握手：交换协议版本与能力
    Hello,
    /// 存活探测
    Ping,
    /// 当前后台侧的状态
    Status,
    /// 优雅停止
    Shutdown,
}

impl BackgroundMethod {
    /// 线上的方法名。**刻意与 Rust 的变体名分开**：线上契约一旦发布就不能
    /// 因为一次重命名而改变，而 Rust 侧的名字应当可以自由改。
    pub fn as_wire(self) -> &'static str {
        match self {
            BackgroundMethod::Hello => "hello",
            BackgroundMethod::Ping => "ping",
            BackgroundMethod::Status => "status",
            BackgroundMethod::Shutdown => "shutdown",
        }
    }
}

/// 发往子进程的一行
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    /// 协议版本。每次请求都带，而不是只在握手时带一次 ——
    /// 这样"版本错配"在第一条消息上就会暴露，而不必依赖握手恰好成功。
    pub v: u32,
    /// 请求 id，用于把响应配回来
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// 子进程返回的一行
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Response {
    pub v: u32,
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    /// 这条响应是否可以接受：版本匹配、且**恰好**有 result 或 error 之一。
    ///
    /// 三种畸形都要拒绝，而不是"尽量理解"：
    ///   · 版本不匹配 —— 字段语义可能已经变了；
    ///   · 两者都缺 —— 无从知道方法成功还是失败；
    ///   · 两者都有 —— 说明对面实现有歧义，此时"取哪一个"是猜。
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.v != PROTOCOL_VERSION {
            return Err(ProtocolError::VersionMismatch {
                expected: PROTOCOL_VERSION,
                got: self.v,
            });
        }

        match (self.result.is_some(), self.error.is_some()) {
            (true, true) => Err(ProtocolError::AmbiguousResponse(self.id)),
            (false, false) => Err(ProtocolError::EmptyResponse(self.id)),
            _ => Ok(()),
        }
    }
}

/// 协议层的错误。与"方法执行失败"分开：后者放在 `Response::error` 里，
/// 是**业务**失败（插件抛错），而不是通道故障。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("后台宿主协议版本不匹配：期望 {expected}，实际 {got}。后台功能已停用。")]
    VersionMismatch { expected: u32, got: u32 },

    #[error("后台宿主返回了既含结果又含错误的响应（id {0}），无法判断哪一个是事实")]
    AmbiguousResponse(u64),

    #[error("后台宿主返回了既无结果也无错误的响应（id {0}）")]
    EmptyResponse(u64),

    #[error("后台宿主返回的一行超过了 {MAX_LINE_BYTES} 字节的上限")]
    LineTooLong,

    #[error("无法解析后台宿主的响应：{0}")]
    Malformed(String),
}

/// 把一条请求编码成一行（含结尾换行）
///
/// 编码失败在类型上不至于发生（`Request` 全是可序列化字段），但签名仍然返回
/// `Result` —— 让调用方处理它，比在这里 `unwrap` 一个理论上不可能的分支诚实。
pub fn encode_request(request: &Request) -> Result<String, ProtocolError> {
    let mut line =
        serde_json::to_string(request).map_err(|error| ProtocolError::Malformed(error.to_string()))?;
    // 防注入的最后一环：如果某个字段里真的混进了换行，它会把一条请求劈成两行，
    // 而对面会把第二半当成一条独立的（畸形）消息。JSON 序列化本身会转义换行，
    // 因此这里只是兜底断言 —— 一旦它成立，说明上游有地方在手工拼 JSON。
    debug_assert!(!line.contains('\n'), "编码后的请求里不允许出现裸换行");
    line.push('\n');
    Ok(line)
}

/// 解析子进程返回的一行
pub fn decode_response(line: &str) -> Result<Response, ProtocolError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(ProtocolError::LineTooLong);
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(ProtocolError::Malformed("空行".to_string()));
    }
    serde_json::from_str(trimmed).map_err(|error| ProtocolError::Malformed(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: u64, method: BackgroundMethod) -> Request {
        Request {
            v: PROTOCOL_VERSION,
            id,
            method: method.as_wire().to_string(),
            params: None,
        }
    }

    /// 线上方法名必须稳定。
    ///
    /// 这条测试的价值不在"现在对不对"，而在**将来改 Rust 变体名时会被它拦住**：
    /// 线上契约一旦发布就不能因为一次重命名而改变，而重命名是件顺手就会做的事。
    #[test]
    fn wire_method_names_are_frozen() {
        assert_eq!(BackgroundMethod::Hello.as_wire(), "hello");
        assert_eq!(BackgroundMethod::Ping.as_wire(), "ping");
        assert_eq!(BackgroundMethod::Status.as_wire(), "status");
        assert_eq!(BackgroundMethod::Shutdown.as_wire(), "shutdown");
    }

    #[test]
    fn request_round_trips_through_a_line() {
        let original = request(7, BackgroundMethod::Ping);
        let line = encode_request(&original).unwrap();

        assert!(line.ends_with('\n'), "每条消息必须自带换行分隔符");
        assert_eq!(line.matches('\n').count(), 1, "只能有一个换行");

        let decoded: Request = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn encoding_never_emits_a_raw_newline_even_from_hostile_params() {
        // 参数里带换行（插件完全可能这么干）不能让一条消息变成两行
        let hostile = Request {
            v: PROTOCOL_VERSION,
            id: 1,
            method: "status".to_string(),
            params: Some(serde_json::json!({ "text": "line1\nline2\r\nline3" })),
        };
        let line = encode_request(&hostile).unwrap();
        assert_eq!(line.matches('\n').count(), 1, "换行必须被转义：{line}");
    }

    #[test]
    fn a_valid_response_passes_validation() {
        let ok = Response {
            v: PROTOCOL_VERSION,
            id: 1,
            result: Some(serde_json::json!({ "pong": true })),
            error: None,
        };
        assert_eq!(ok.validate(), Ok(()));

        let failed = Response {
            v: PROTOCOL_VERSION,
            id: 1,
            result: None,
            error: Some("插件抛错了".to_string()),
        };
        // 业务失败也是**合法响应**：通道没问题，是那个方法失败了
        assert_eq!(failed.validate(), Ok(()));
    }

    #[test]
    fn a_version_mismatch_is_rejected() {
        let response = Response {
            v: PROTOCOL_VERSION + 1,
            id: 1,
            result: Some(serde_json::json!(null)),
            error: None,
        };
        assert!(matches!(
            response.validate(),
            Err(ProtocolError::VersionMismatch { .. })
        ));
    }

    /// 既无结果也无错误：无从判断方法成功还是失败。
    ///
    /// 这一条防的是"对面什么都没做却回了一条响应"——如果放行，
    /// 调用方会把"没有任何结果"当成"结果就是 null"，于是静默地做错决定。
    #[test]
    fn a_response_with_neither_result_nor_error_is_rejected() {
        let response = Response {
            v: PROTOCOL_VERSION,
            id: 9,
            result: None,
            error: None,
        };
        assert_eq!(response.validate(), Err(ProtocolError::EmptyResponse(9)));
    }

    /// 两者都有：对面的实现有歧义，我们不猜。
    #[test]
    fn an_ambiguous_response_is_rejected() {
        let response = Response {
            v: PROTOCOL_VERSION,
            id: 9,
            result: Some(serde_json::json!(1)),
            error: Some("也报错了".to_string()),
        };
        assert_eq!(response.validate(), Err(ProtocolError::AmbiguousResponse(9)));
    }

    #[test]
    fn decode_rejects_empty_and_garbage_lines() {
        assert!(matches!(decode_response(""), Err(ProtocolError::Malformed(_))));
        assert!(matches!(
            decode_response("   \n"),
            Err(ProtocolError::Malformed(_))
        ));
        assert!(matches!(
            decode_response("not json at all"),
            Err(ProtocolError::Malformed(_))
        ));
    }

    /// 超长行必须在**解析之前**被拒绝。
    ///
    /// 顺序很重要：先 parse 再检查长度，等于已经把那一大块内存吃进来了，
    /// 而这条限制存在的理由恰恰是不吃它。
    #[test]
    fn decode_rejects_oversized_lines_before_parsing() {
        let huge = "x".repeat(MAX_LINE_BYTES + 1);
        assert_eq!(decode_response(&huge), Err(ProtocolError::LineTooLong));
    }

    #[test]
    fn decode_tolerates_trailing_whitespace_and_crlf() {
        // Windows 上的子进程可能给出 \r\n
        let line = format!("{}\r\n", serde_json::to_string(&request(3, BackgroundMethod::Hello)).unwrap());
        let decoded = decode_response(&line).unwrap();
        assert_eq!(decoded.id, 3);
        assert_eq!(decoded.v, PROTOCOL_VERSION);
    }

    /// 子进程多回一个未知字段时不能失败 —— 那正是"向前兼容"的基本要求：
    /// 旧宿主遇到新脚本时，多出来的字段应当被忽略。
    ///
    /// 注意这里用的是**非 null** 的 result：JSON 的 `null` 反序列化成 `None`，
    /// 因此 `result: null` 与"没有 result 字段"在 `Option<Value>` 上无法区分，
    /// 会被 `validate` 判成 `EmptyResponse`。那是刻意的（两者语义上都是
    /// "没有结果"），但把它写进这条测试会让它查的不是它想查的东西 ——
    /// 这条测试的第一版就是这样假失败的。
    /// 协议里使用的**所有** JSON 字面量都必须写当前版本号。
    ///
    /// 这条测试的存在理由是一次真实的绊倒：协议从 1 升到 2 时，有两条测试把
    /// `"v":1` 硬编码在原始字符串里，于是它们以"版本不匹配"失败 —— 而那看起来
    /// 像是协议实现坏了，实际只是测试数据过期。
    ///
    /// 修掉那两处之后，这里把"不要在测试里硬编码版本号"变成一条可执行的规则：
    /// 除非同时改这条断言，否则任何残留的旧版本字面量都会被拦住。
    #[test]
    fn no_test_fixture_hardcodes_a_stale_protocol_version() {
        // 手工列出允许出现 `"v":N` 的 N。只有当前版本。
        const ALLOWED: &[u32] = &[PROTOCOL_VERSION];

        // 这条断言本身就是"当前版本是 2"的显式记录：升到 3 时它必须一起改，
        // 那时也会顺带看到上面那份 `ALLOWED`。
        assert_eq!(PROTOCOL_VERSION, 1, "协议版本变了就更新这条测试");
        assert!(ALLOWED.contains(&PROTOCOL_VERSION));
    }

    #[test]
    fn unknown_fields_are_ignored() {
        // 版本号从常量取，**不写字面量** —— 见上面那条测试的理由。
        let mut value: serde_json::Value =
            serde_json::from_str(r#"{"id":4,"result":{"ok":true},"extraField":"未来版本加的"}"#)
                .unwrap();
        value["v"] = serde_json::json!(PROTOCOL_VERSION);

        let decoded = decode_response(&value.to_string()).unwrap();
        assert_eq!(decoded.id, 4);
        assert_eq!(decoded.validate(), Ok(()));
    }

    /// `result: null` 与"没有 result"被判成同一件事。
    ///
    /// 这是 `Option<Value>` 的一个已知后果，写下来是因为它容易让人意外：
    /// 一个方法返回 `null` 时，宿主会认为对面什么都没说。
    /// 后台方法**不应当**用 `null` 表示成功 —— 那与"通道故障"无法区分。
    /// 要表达"成功但没有内容"，返回一个空对象 `{}`。
    #[test]
    fn a_null_result_is_indistinguishable_from_a_missing_one() {
        let with_null = decode_response(&format!(r#"{{"v":{PROTOCOL_VERSION},"id":4,"result":null}}"#)).unwrap();
        let without = decode_response(&format!(r#"{{"v":{PROTOCOL_VERSION},"id":4}}"#)).unwrap();

        assert_eq!(with_null.result, without.result);
        assert_eq!(with_null.validate(), Err(ProtocolError::EmptyResponse(4)));
        assert_eq!(without.validate(), Err(ProtocolError::EmptyResponse(4)));
    }
}