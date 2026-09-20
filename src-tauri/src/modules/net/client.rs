// src-tauri/src/modules/net/client.rs
//
// 出站请求的**唯一门面**。
//
// ---------------------------------------------------------------------------
// 为什么要包一层，而不是在每个请求点调一次 `policy::decide`：
//
// 上一版就是那么做的。结果是：`plugin_http_request` 接了策略，而
// **插件市场拉索引 / README / 插件包的 `fetch_once` 没接**。用户把设置改成
// 「禁止出站」、打开离线模式，刷新后市场照样能加载 —— 因为那条路根本没问过策略。
//
// 更糟的是文档里已经如实写了「尚不存在单一收口」，而界面上的开关看起来是生效的：
// **把已知缺口写进文档，并不会阻止它被读成一个已完成的功能。**
//
// 所以这里不是"再补两处调用"，而是让漏掉这件事在编译期就不可能：
// `reqwest::Client` 被私有字段持有，**没有任何方法把它交出去**。要发请求就必须
// 拿到 `NetClient`，而它的每一个出口都先经过判定与记录。
//
// 仍然覆盖不到的（如实写在这里，不靠读者自己发现）：
//   * `tauri-plugin-updater` 自带传输 —— 它的请求不经过本类型。我们在
//     `updater::commands` 的**命令入口**做了判定，那是入口拦截，不是传输层拦截。
//   * WebView 里插件自己发的 `fetch` —— 那根本不经过 Rust。它只能由 CSP 的
//     `connect-src` 约束，属于另一批工作。
// ---------------------------------------------------------------------------

use std::time::Duration;

use tauri::AppHandle;

use crate::modules::settings::settings as settings_store;

use super::log::{self, NetLogEntry};
use super::policy::{self, Decision};
use super::is_loopback_host;

/// 一次出站的来源与用途。
///
/// `source` 回答"是谁发的"，`purpose` 回答"为什么发"。只有 source 时，用户看到
/// `module:plugins` 连了 jsdelivr，仍然分不清那是在取索引、取 README，还是在下载插件包。
#[derive(Debug, Clone)]
pub struct NetOrigin {
    pub source: String,
    pub purpose: &'static str,
}

impl NetOrigin {
    pub fn host(purpose: &'static str) -> Self {
        Self {
            source: super::SOURCE_HOST.to_string(),
            purpose,
        }
    }

    pub fn plugin(plugin_id: &str, purpose: &'static str) -> Self {
        Self {
            source: super::plugin_source(plugin_id),
            purpose,
        }
    }

    pub fn module(module_id: &str, purpose: &'static str) -> Self {
        Self {
            source: super::module_source(module_id),
            purpose,
        }
    }
}

/// 门面返回的错误
#[derive(Debug)]
pub enum NetError {
    /// 被出站策略拒绝。**这是一个正常结果，不是故障** —— 调用方应当把它的文案
    /// 原样带给用户（"离线模式已开启"），而不是折成一句笼统的"网络请求失败"。
    Denied(String),
    /// 请求没能组装出来（URL 非法等）
    Build(String),
    /// 真的发出去了但失败了（TLS、超时、DNS……）
    Transport(reqwest::Error),
}

impl NetError {
    pub fn is_denied(&self) -> bool {
        matches!(self, NetError::Denied(_))
    }

    pub fn message(&self) -> String {
        match self {
            NetError::Denied(reason) => reason.clone(),
            NetError::Build(message) => message.clone(),
            NetError::Transport(error) => crate::modules::settings::network::describe_error_chain(error),
        }
    }
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for NetError {}

impl From<reqwest::Error> for NetError {
    fn from(error: reqwest::Error) -> Self {
        NetError::Transport(error)
    }
}

/// 出站门面
///
/// **`client` 是私有的，且本类型不提供任何取回它的方法。**
/// 这不是封装偏好，而是这一层存在的全部理由：一旦能拿到裸 `reqwest::Client`，
/// 就又回到了"每个调用点各自记得调 decide"的局面。
///
/// `Clone` 是给并发调用方用的（网络诊断会把同一个门面分给多条并发探测）。
/// 克隆出去共享的仍是同一个连接池，`client` 字段依旧不对外。
#[derive(Clone)]
pub struct NetClient {
    client: reqwest::Client,
    app: AppHandle,
}

impl NetClient {
    /// `timeout` 由调用方给：诊断（`probe`）刻意用短超时，而下载用它反而不合适 ——
    /// 那是"慢"与"坏"的区别，两者不该共用同一个数字。
    pub fn new(app: AppHandle, timeout: Duration) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| format!("无法创建 HTTP 客户端：{}", e))?;

        Ok(Self { client, app })
    }

    /// 组装一个 GET（不发送 —— 发送必须经过 [`NetClient::execute`]）
    pub fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.client.get(url)
    }

    /// 组装任意方法（不发送）
    pub fn request(&self, method: reqwest::Method, url: reqwest::Url) -> reqwest::RequestBuilder {
        self.client.request(method, url)
    }

    /// GET 并发送
    pub async fn get_and_send(
        &self,
        url: &str,
        origin: NetOrigin,
    ) -> Result<reqwest::Response, NetError> {
        self.execute(self.get(url), origin).await
    }

    /// **唯一的发送出口。** 判定、记录、发送都在这里发生。
    pub async fn execute(
        &self,
        builder: reqwest::RequestBuilder,
        origin: NetOrigin,
    ) -> Result<reqwest::Response, NetError> {
        let request = builder
            .build()
            .map_err(|e| NetError::Build(format!("请求无法组装：{}", e)))?;

        let method = request.method().as_str().to_string();
        let url = request.url().to_string();
        let host = request
            .url()
            .host_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let loopback = is_loopback_host(&host);

        // 每次请求读一次设置，而不是把策略缓存在内存里：缓存需要回答"设置什么时候变了"，
        // 而那是一条必然会漏一处的同步路径。代价是每请求一次文件读 —— 网络本身比它贵
        // 几个数量级，这笔账划得来。这条决定在收口之后更重要了：现在**所有**出站都走这里。
        let settings = settings_store::load(&self.app);
        let decision = policy::decide(&settings.network_policy, settings.offline_mode, loopback);

        let entry = NetLogEntry::outbound(&origin.source, origin.purpose, &method, &url, &host);

        if let Decision::Deny(reason) = decision {
            log::record(entry.with_outcome("denied", Some(reason.to_string())));
            return Err(NetError::Denied(reason.to_string()));
        }

        // 失败也要留痕：一条"没发出去"的日志，比一条缺失的日志有用得多 ——
        // 后者会让用户以为这个插件根本没尝试过联网
        match self.client.execute(request).await {
            Ok(response) => {
                let status = response.status().as_u16();
                let length = response.content_length();
                log::record(
                    entry
                        .with_outcome(policy::outcome_of(decision), None)
                        .with_response(status, length),
                );
                Ok(response)
            }
            Err(error) => {
                let described = crate::modules::settings::network::describe_error_chain(&error);
                log::record(entry.with_outcome("failed", Some(described)));
                Err(NetError::Transport(error))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_prefixes_match_the_shared_notation() {
        // 来源标记必须与 `pluginRuntime` 的 `plugin:<id>` 命令前缀是同一种记法：
        // 归因时日志里那串字符要能直接对上代码里的那一处
        assert_eq!(NetOrigin::plugin("x", "p").source, "plugin:x");
        assert_eq!(NetOrigin::module("x", "p").source, "module:x");
        assert_eq!(NetOrigin::host("p").source, "host");
    }

    #[test]
    fn denied_is_distinguishable_from_transport_failure() {
        // 这两个必须能分开：一个是正常结果（用户自己关的），一个是故障。
        // 折叠成一句"网络请求失败"会让离线模式看起来像 bug。
        let denied = NetError::Denied("离线模式已开启".to_string());
        assert!(denied.is_denied());
        assert_eq!(denied.message(), "离线模式已开启");

        let build = NetError::Build("URL 非法".to_string());
        assert!(!build.is_denied());
    }
}
