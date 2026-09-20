// src-tauri/src/modules/settings/probe.rs
//
// 网络诊断：把「直连」与「下载源」两条路各走一遍，把结果并排摆出来。
//
// ============================================================
// 为什么需要它
// ============================================================
//
// 「插件市场打不开」「检查更新失败」这两句话对排查几乎没有帮助：可能是 DNS、
// 可能是 TLS、可能是 CDN 回了 404、可能是加速源本身挂了，也可能是根本没配代理。
// 用户能提供的信息只有「不行」。
//
// 这个命令把每条候选路径**实测一遍**，逐条给出状态码、耗时与失败原因。于是
// 「直连不通、走下载源 200」这种结论用户自己就能读出来，不需要我们远程猜。
//
// ============================================================
// 安全边界：目标地址由前端提供，但可探测的宿主由后端决定
// ============================================================
//
// 让前端传地址来探测，看起来像是开了一个「任意 GET」的口子 —— 那正是
// `fetch_registry_text` 一直用白名单挡着的东西。这里的处理方式是：
//
//   * 前端只能传**我们本来就会访问**的那几个原始地址（插件仓库的 CDN / GitHub、
//     更新清单）。它们的宿主必须属于「插件仓库白名单」或「更新清单的宿主」，
//     而这两个集合都**来自后端自己的常量与配置文件**，前端无法扩大。
//   * 探测用的「经下载源」那一版由后端用 `network::rewrite_url` 现场拼出来，
//     不接受前端传入任何已改写的地址。
//
// 因此它能探测的宿主集合与「应用正常运行时会访问的宿主集合」完全相同 ——
// 一个被篡改的前端最多让它去试几个我们本来就会去试的地址。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::modules::net::client::{NetClient, NetOrigin};
use crate::modules::plugins::manager::ALLOWED_REGISTRY_HOSTS;
use crate::modules::updater::commands::configured_endpoints;
use crate::prelude::*;

use super::{network, settings as settings_store};

/// 单条探测的超时
///
/// 比正常请求的 30 秒短得多：诊断要的是「快」，一次挂住 30 秒会让整张表
/// 等上几分钟，用户只会以为界面卡死了。
const PROBE_TIMEOUT_SECS: u64 = 8;

/// 一次最多探测多少个目标
///
/// 上限存在是为了让这个命令不可能被当成批量请求器使用。
pub const MAX_PROBE_TARGETS: usize = 6;

/// 前端给出的一个待探测目标
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeTarget {
    /// 界面上显示的名字（例如「插件索引 · CDN」）
    pub label: String,
    /// **原始**地址，未经下载源改写
    pub url: String,
}

/// 一条探测结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRow {
    pub label: String,
    /// `direct`（直连）或 `proxy`（经下载源）
    pub via: String,
    /// 实际请求的地址
    pub url: String,
    pub ok: bool,
    /// HTTP 状态码；连都没连上时为 `None`
    pub status: Option<u16>,
    /// 响应体字节数
    pub bytes: Option<u64>,
    pub elapsed_ms: u64,
    /// 失败原因（已经展开成因链）
    pub error: Option<String>,
}

/// 一次诊断的完整结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// 当前网络方式（`direct` / `proxy`）
    pub mode: String,
    /// 当前生效的下载源地址（直连时为空串）
    pub proxy: String,
    pub rows: Vec<ProbeRow>,
}

/// 更新清单配置里出现过的宿主
fn configured_endpoint_hosts(app: &AppHandle) -> Vec<String> {
    configured_endpoints(app)
        .unwrap_or_default()
        .iter()
        .filter_map(|raw| reqwest::Url::parse(raw).ok())
        .filter_map(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
        .collect()
}

/// 校验一个地址是否属于「我们本来就会访问的宿主」
fn ensure_allowed(url: &str, endpoint_hosts: &[String]) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| format!("地址非法（{}）：{}", url, e))?;

    let host = parsed
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();

    if host.is_empty() {
        return Err(format!("地址缺少宿主：{}", url));
    }

    // 本机回环地址：本地调试用，与 `ensure_registry_url_allowed` 同一条例外
    let loopback = host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);

    if loopback && matches!(parsed.scheme(), "http" | "https") {
        return Ok(());
    }

    if parsed.scheme() != "https" {
        return Err(format!("只探测 https 地址：{}", url));
    }

    if ALLOWED_REGISTRY_HOSTS.contains(&host.as_str()) {
        return Ok(());
    }

    if endpoint_hosts.iter().any(|allowed| allowed == &host) {
        return Ok(());
    }

    Err(format!(
        "不允许探测该宿主（{}）：只允许插件仓库地址（{}）与更新清单的宿主",
        host,
        ALLOWED_REGISTRY_HOSTS.join(" / ")
    ))
}

/// 探测一条路径
///
/// 请求经 [`NetClient`] 发出：**诊断自己也要受出站策略约束**。用户刚把出站关了，
/// 然后点"网络诊断" —— 每一行都会明确写成"离线模式已开启"，而不是笼统的连接失败。
/// 后者会让他去查网线、改 DNS，而真实原因就在他三秒前按下的那个开关上。
async fn probe_one(
    net: NetClient,
    label: String,
    via: &'static str,
    url: String,
) -> ProbeRow {
    let started = Instant::now();

    let mut row = ProbeRow {
        label,
        via: via.to_string(),
        url: url.clone(),
        ok: false,
        status: None,
        bytes: None,
        elapsed_ms: 0,
        error: None,
    };

    match net
        .get_and_send(&url, NetOrigin::module("settings", "网络诊断"))
        .await
    {
        Err(error) => {
            row.elapsed_ms = started.elapsed().as_millis() as u64;
            // `NetError::message()` 已经区分了"被策略拒绝"与"传输失败" ——
            // 前者返回策略原因原文，后者返回错误链
            row.error = Some(error.message());
        }
        Ok(response) => {
            let status = response.status();
            row.status = Some(status.as_u16());

            match response.bytes().await {
                Ok(bytes) => {
                    row.bytes = Some(bytes.len() as u64);
                    row.ok = status.is_success();
                    if !row.ok {
                        row.error = Some(format!("HTTP {}", status.as_u16()));
                    }
                }
                Err(error) => {
                    row.error = Some(network::describe_error_chain(&error));
                }
            }

            row.elapsed_ms = started.elapsed().as_millis() as u64;
        }
    }

    row
}

/// 执行一次网络诊断
///
/// `targets` 只包含**插件仓库**那几条（它们的地址模板在前端
/// `src/config/pluginRegistry.ts` 里）。更新清单那几条由本函数自己从
/// `tauri.conf.json` 追加 —— 那份地址的真源在配置文件里，让前端再抄一遍
/// 只会制造一个会漂移的副本。
pub async fn run(app: &AppHandle, mut targets: Vec<ProbeTarget>) -> Result<ProbeReport, String> {
    if targets.len() > MAX_PROBE_TARGETS {
        return Err(format!(
            "一次最多探测 {} 个地址，收到 {} 个",
            MAX_PROBE_TARGETS,
            targets.len()
        ));
    }

    for (index, endpoint) in configured_endpoints(app)
        .unwrap_or_default()
        .into_iter()
        .enumerate()
    {
        targets.push(ProbeTarget {
            label: if index == 0 {
                "软件更新清单".to_string()
            } else {
                format!("软件更新清单 {}", index + 1)
            },
            url: endpoint,
        });
    }

    if targets.is_empty() {
        return Err("没有需要探测的地址".to_string());
    }

    let settings = settings_store::load(app);
    let proxy = network::proxy_base(&settings).map(|base| base.to_string());
    let endpoint_hosts = configured_endpoint_hosts(app);

    // 先把要发的请求全部定下来：**校验在前，请求在后**。
    // 边校验边发会让「被拒绝的目标」与「已发出的请求」混在一起，日志也难读。
    let mut planned: Vec<(String, &'static str, String)> = Vec::new();
    for target in &targets {
        ensure_allowed(&target.url, &endpoint_hosts)?;

        planned.push((target.label.clone(), "direct", target.url.clone()));

        if let Some(base) = proxy.as_deref() {
            let rewritten = network::rewrite_url(&target.url, Some(base));
            // 只对真的被改写的地址加一条：jsDelivr 那类 CDN 地址经下载源没有意义，
            // 探测它只会让表里多一行注定失败的结果。
            if rewritten != target.url {
                planned.push((target.label.clone(), "proxy", rewritten));
            }
        }
    }

    log::info!(
        "开始网络诊断：{} 个目标 / {} 条路径，{}",
        targets.len(),
        planned.len(),
        network::describe_mode(&settings)
    );

    // 8 秒而不是 30 秒：诊断要的是「快」，一次挂住 30 秒会让整张表等上几分钟
    let net = NetClient::new(app.clone(), Duration::from_secs(PROBE_TIMEOUT_SECS))?;

    // 并发发出：串行时最坏情况是「条数 × 超时」，用户会以为界面卡住了。
    let mut handles = Vec::with_capacity(planned.len());
    for (label, via, url) in planned {
        let net = net.clone();
        handles.push(tauri::async_runtime::spawn(probe_one(net, label, via, url)));
    }

    let mut rows = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(row) => rows.push(row),
            Err(e) => {
                // 任务本身挂了（panic 或被取消）：也要出一个结果，
                // 否则界面上会少一行，而「少了一行」比「一行失败」更难解释。
                rows.push(ProbeRow {
                    label: "（探测任务失败）".to_string(),
                    via: "direct".to_string(),
                    url: String::new(),
                    ok: false,
                    status: None,
                    bytes: None,
                    elapsed_ms: 0,
                    error: Some(format!("探测任务未能完成：{}", e)),
                });
            }
        }
    }

    for row in &rows {
        match (&row.error, row.status) {
            (None, Some(status)) => log::info!(
                "诊断 {} [{}] → HTTP {} / {} 字节 / {} ms",
                row.label,
                row.via,
                status,
                row.bytes.unwrap_or(0),
                row.elapsed_ms
            ),
            (Some(error), _) => log::warn!(
                "诊断 {} [{}] → 失败（{} ms）：{}",
                row.label,
                row.via,
                row.elapsed_ms,
                error
            ),
            (None, None) => {}
        }
    }

    Ok(ProbeReport {
        mode: settings.network_mode.clone(),
        proxy: proxy.unwrap_or_default(),
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> Vec<String> {
        vec!["github.com".to_string()]
    }

    #[test]
    fn allows_the_registry_hosts_and_the_updater_host() {
        assert!(ensure_allowed("https://cdn.jsdelivr.net/gh/a/b@main/index.json", &hosts()).is_ok());
        assert!(ensure_allowed("https://raw.githubusercontent.com/a/b/main/i.json", &hosts()).is_ok());
        assert!(ensure_allowed(
            "https://github.com/Rinntheor/modulith-desktop/releases/latest/download/latest.json",
            &hosts()
        )
        .is_ok());
    }

    #[test]
    fn rejects_hosts_we_never_visit_ourselves() {
        // 关键反例：这个命令不能变成任意 GET
        assert!(ensure_allowed("https://example.com/x", &hosts()).is_err());
        assert!(ensure_allowed("https://evil.tld/index.json", &hosts()).is_err());
        // 更新清单宿主之外的 github 子域也不在白名单里，除非配置里写了
        assert!(ensure_allowed("https://api.github.com/repos/a/b", &hosts()).is_err());
    }

    #[test]
    fn rejects_plain_http_outside_loopback_and_bad_urls() {
        assert!(ensure_allowed("http://cdn.jsdelivr.net/x", &hosts()).is_err());
        assert!(ensure_allowed("http://127.0.0.1:8080/index.json", &hosts()).is_ok());
        assert!(ensure_allowed("http://localhost:1420/index.json", &hosts()).is_ok());
        assert!(ensure_allowed("not a url", &hosts()).is_err());
        assert!(ensure_allowed("https://", &hosts()).is_err());
    }
}
