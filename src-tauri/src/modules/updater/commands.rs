// src-tauri/src/modules/updater/commands.rs
//
// 应用更新：检查与安装。
//
// ============================================================
// 为什么不用官方的前端插件（`@tauri-apps/plugin-updater`）
// ============================================================
//
// 官方流程是「前端 `check()` → 前端 `downloadAndInstall()`」，而这两步的地址都
// 不是运行期可配的：
//
// 1. **清单地址**来自 `tauri.conf.json` 的 `plugins.updater.endpoints`，在插件
//    初始化时就固定了。用户在设置里改了下载源，下一次检查仍然会去直连 GitHub。
// 2. **安装包地址**根本不在插件配置里 —— 它是**清单文件自己写的**
//    （`platforms.<target>.url`，指向 `github.com/.../releases/download/...`）。
//    也就是说：即使把清单地址换成了加速源，取回清单之后，安装包仍然会去直连
//    GitHub。这正是「能检查到新版本、下载却卡住/失败」这种最难归因的现象。
//
// 把这两步搬到 Rust 里，就能在**每次调用时**按当前设置改写这两个地址：
// 清单地址经 `endpoints()` 传入，安装包地址在 `check()` 之后改 `download_url`
// 字段。改写的规则只有一处（`settings/network.rs`），与插件市场共用。
//
// **这不是「绕开官方实现」。** 下载、签名校验、调起安装程序仍然全部由
// `tauri-plugin-updater` 完成，公钥也仍然取自 `tauri.conf.json`
// （同一个 `plugins.updater` 块同时被插件索引签名校验复用）。我们只负责
// 「地址从哪来」，而且改的依旧是 https 地址 —— 内容完整性由签名保证。

use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::State;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::modules::net::log::NetLogEntry;
use crate::modules::net::policy::{self, Decision};
use crate::modules::settings::{network, settings as settings_store};
use crate::prelude::*;

/// 出站策略判定 —— **在命令入口，不在传输层**
///
/// ---------------------------------------------------------------------------
/// 为什么只能到这一步，说清楚：
///
/// 应用更新走 `tauri-plugin-updater` 自带的 HTTP 传输，那段代码不经过我们的
/// `NetClient`，我们无法在传输层拦它，也无法把它的连接记进流量日志。
///
/// 这里能保证的是：**我们不会主动发起这次检查或下载**。用户开了离线模式后点
/// "检查更新"，会直接得到"离线模式已开启"，而不是等一次真实的网络往返。
///
/// 这条边界必须写在能被读到的地方 —— 一个未被覆盖的传输，不该因为界面上有个
/// 开关就被读成已覆盖。流量日志的说明里也写了同一条。
/// ---------------------------------------------------------------------------
fn ensure_outbound_allowed(
    app: &AppHandle,
    purpose: &'static str,
    url: &str,
) -> Result<(), String> {
    let settings = settings_store::load(app);
    let decision = policy::decide(&settings.network_policy, settings.offline_mode, false);

    let Decision::Deny(reason) = decision else {
        return Ok(());
    };

    // 记一条。被拒绝的尝试也要留痕：否则用户点了"检查更新"、看到被拒、打开流量日志
    // 却发现空无一物 —— 那会让他以为日志本身坏了。
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default();
    crate::modules::net::log::record(
        NetLogEntry::outbound("host", purpose, "GET", url, &host)
            .with_outcome("denied", Some(reason.to_string())),
    );

    log::info!("{}被出站策略拒绝：{}", purpose, reason);
    Err(format!(
        "{}已被出站策略拒绝：{}。可在「设置 → 网络」中调整。",
        purpose, reason
    ))
}

const P_UPDATER_CHECK: &str = "应用更新检查";
const P_UPDATER_INSTALL: &str = "应用更新下载";

/// 已检查到、还没安装的更新
///
/// 保存在 Rust 侧而不是像官方插件那样作为资源句柄交给前端，是因为「改写后的
/// 安装包地址」必须与这个句柄待在一起 —— 让它跨过 IPC 再传回来，中间就多了一次
/// 可以不一致的机会。
pub struct UpdateState(pub Mutex<Option<Update>>);

impl UpdateState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for UpdateState {
    fn default() -> Self {
        Self::new()
    }
}

/// 下载进度事件
///
/// 形状**刻意与官方插件一致**（`Started { contentLength }` / `Progress { chunkLength }`
/// / `Finished`）：前端的累加逻辑与文案都是照着它写的，换一套字段只会制造无谓的
/// 改动面。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

/// 可用的更新
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    /// 发布于（形如 `2026-09-18 15:55:04.0 +00:00:00`，前端只取前 10 位当日期）
    pub date: Option<String>,
    pub notes: Option<String>,
    /// 实际会去下载的地址（已经过下载源改写，便于用户对照日志）
    pub download_url: String,
    /// 本次检查实际使用的联网方式描述
    pub source: String,
}

/// 一次检查的结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheck {
    pub current_version: String,
    /// 没有可用更新时为 `None`
    pub available: Option<AvailableUpdate>,
    /// 本次检查真正请求的清单地址（按顺序尝试），已按下载源改写
    pub endpoints: Vec<String>,
    pub source: String,
}

/// 读取 `tauri.conf.json` 里配置的更新清单地址
///
/// **只从配置读，不接受前端传参。** 更新清单是「装什么」的信任起点之一：
/// 允许调用方指定清单地址，等于让调用方决定去哪里取更新包，而公钥只能证明
/// 「这是同一个签发者」，不能证明「这是官方发布的那个版本」。
///
/// `pub(crate)`：网络诊断（`settings/probe.rs`）要用它算出「允许探测的宿主」，
/// 而那个集合必须来自配置而不是来自前端。
pub(crate) fn configured_endpoints(app: &AppHandle) -> Result<Vec<String>, String> {
    let config = app.config();
    let updater = config
        .plugins
        .0
        .get("updater")
        .ok_or_else(|| "tauri.conf.json 缺少 plugins.updater 配置".to_string())?;

    let list = updater
        .get("endpoints")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "tauri.conf.json 的 plugins.updater 缺少 endpoints".to_string())?;

    let mut endpoints = Vec::new();
    for entry in list {
        if let Some(url) = entry.as_str() {
            let url = url.trim();
            if !url.is_empty() {
                endpoints.push(url.to_string());
            }
        }
    }

    if endpoints.is_empty() {
        return Err("tauri.conf.json 的 plugins.updater.endpoints 为空".to_string());
    }

    Ok(endpoints)
}

/// 按当前设置改写并解析出清单地址
pub fn resolved_endpoints(
    app: &AppHandle,
    proxy: Option<&str>,
) -> Result<Vec<reqwest::Url>, String> {
    configured_endpoints(app)?
        .iter()
        .map(|raw| {
            let rewritten = network::rewrite_url(raw, proxy);
            rewritten.parse::<reqwest::Url>().map_err(|e| {
                format!("更新清单地址非法（{}）: {}", rewritten, e)
            })
        })
        .collect()
}

/// 检查是否有新版本
///
/// 失败时**抛错而不是返回「已是最新」**：这两件事在界面上完全不同 ——
/// 把它们合并会让一次断网看起来像「你用的是最新版」。
#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<AppUpdateCheck, String> {
    let settings = settings_store::load(&app);
    let proxy = network::proxy_base(&settings);
    let source = network::describe_mode(&settings);
    let endpoints = resolved_endpoints(&app, proxy)?;

    // 入口拦截：离线/禁止出站时**不发起检查**。判断放在解析地址之后，是为了让被拒的
    // 那一条日志能带上真实的目标地址而不是空串。
    ensure_outbound_allowed(
        &app,
        P_UPDATER_CHECK,
        &endpoints
            .first()
            .map(|url| url.to_string())
            .unwrap_or_default(),
    )?;

    log::info!(
        "检查应用更新：当前版本 {}，{}，清单地址 {}",
        env!("CARGO_PKG_VERSION"),
        source,
        endpoints
            .iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>()
            .join(" , ")
    );

    let updater = app
        .updater_builder()
        .endpoints(endpoints.clone())
        .map_err(|e| {
            // 清单地址必须是 https：官方更新器在 release 版会直接拒绝明文 http，
            // 而用户自定义的加速源有可能就是本机 http 地址（插件市场允许，
            // 更新器不允许）。这条不一致必须说清楚，否则报错看起来像清单坏了。
            format!(
                "更新清单地址不可用：{}。注意：应用更新要求 https，本机 http 加速源只对插件市场有效。",
                e
            )
        })?
        .build()
        .map_err(|e| format!("无法初始化更新器：{}", e))?;

    let current_version = app.package_info().version.to_string();

    let found = updater.check().await.map_err(|e| {
        log::warn!("检查应用更新失败：{}", e);
        e.to_string()
    })?;

    let endpoint_strings = endpoints.iter().map(|url| url.to_string()).collect();

    // 每次检查都先清掉上一次的句柄：用户连点两次「检查更新」不该留下一个
    // 谁也不再引用的 Update。
    {
        let mut slot = state.0.lock().map_err(|e| format!("状态锁不可用：{}", e))?;
        *slot = None;
    }

    let Some(mut update) = found else {
        log::info!("检查应用更新完成：已是最新版本（{}）", current_version);
        return Ok(AppUpdateCheck {
            current_version,
            available: None,
            endpoints: endpoint_strings,
            source,
        });
    };

    // 清单里的安装包地址同样要走下载源 —— 这是官方插件做不到的那一半。
    let original_download = update.download_url.to_string();
    let rewritten_download = network::rewrite_url(&original_download, proxy);
    if rewritten_download != original_download {
        update.download_url = rewritten_download.parse::<reqwest::Url>().map_err(|e| {
            format!("改写后的安装包地址非法（{}）: {}", rewritten_download, e)
        })?;
        log::info!(
            "安装包地址已经下载源改写：{} → {}",
            original_download,
            update.download_url
        );
    }

    log::info!(
        "发现新版本 {}（发布于 {}）",
        update.version,
        update.date.map(|d| d.to_string()).unwrap_or_else(|| "未知".to_string())
    );

    let available = AvailableUpdate {
        version: update.version.clone(),
        date: update.date.map(|date| date.to_string()),
        notes: update.body.clone(),
        download_url: update.download_url.to_string(),
        source: source.clone(),
    };

    {
        let mut slot = state.0.lock().map_err(|e| format!("状态锁不可用：{}", e))?;
        *slot = Some(update);
    }

    Ok(AppUpdateCheck {
        current_version,
        available: Some(available),
        endpoints: endpoint_strings,
        source,
    })
}

/// 下载并安装已检查到的更新
///
/// **Windows 上这个命令会在启动安装程序后结束本进程**（安装器以 passive 模式运行，
/// 默认安装完成后重新拉起应用）。界面必须提前把这件事告诉用户。
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    // 把句柄克隆出来再 await：`MutexGuard` 不是 `Send`，跨 await 持有它会让
    // 整个命令的 future 无法被 Tauri 的异步运行时接受。
    let update = {
        let slot = state.0.lock().map_err(|e| format!("状态锁不可用：{}", e))?;
        slot.clone()
    };

    let Some(update) = update else {
        return Err("没有待安装的更新，请先检查更新。".to_string());
    };

    // 入口拦截。**检查通过之后到下载之间，用户可能已经把离线打开了** ——
    // 所以这一处不是重复判定，它覆盖的正是那个时间窗。
    ensure_outbound_allowed(&app, P_UPDATER_INSTALL, update.download_url.as_str())?;

    log::info!(
        "开始下载更新 {}：{}",
        update.version,
        update.download_url
    );

    let mut first_chunk = true;
    let result = update
        .download_and_install(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = false;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await;

    {
        let mut slot = state.0.lock().map_err(|e| format!("状态锁不可用：{}", e))?;
        *slot = None;
    }

    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            // 失败要留下证据：更新链路的错误（TLS、代理 404、签名不符）
            // 恰恰是用户最难描述、我们最难复现的一类。
            log::error!("下载或安装更新失败：{}", e);
            Err(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_event_serializes_like_the_official_plugin() {
        let started = serde_json::to_value(DownloadEvent::Started {
            content_length: Some(1024),
        })
        .expect("serialize");
        assert_eq!(started["event"], "Started");
        assert_eq!(started["data"]["contentLength"], 1024);

        let progress = serde_json::to_value(DownloadEvent::Progress { chunk_length: 64 })
            .expect("serialize");
        assert_eq!(progress["event"], "Progress");
        assert_eq!(progress["data"]["chunkLength"], 64);

        let finished = serde_json::to_value(DownloadEvent::Finished).expect("serialize");
        assert_eq!(finished["event"], "Finished");
    }

    #[test]
    fn update_state_starts_empty_and_can_be_reset() {
        let state = UpdateState::new();
        assert!(state.0.lock().expect("lock").is_none());
    }
}
