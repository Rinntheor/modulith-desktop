// src-tauri/src/modules/plugins/rpc.rs
//
// 插件 ctx 的**唯一**实现。
//
// ============================================================
// 为什么它必须只有一份
// ============================================================
//
// 同一个 ctx 有两个调用方：
//
//   · **沙箱界面插件** —— 走自定义协议（\`POST /<id>/rpc/<方法>\`），
//     由 \`sandbox.rs\` 把 HTTP 请求翻译进来；
//   · **Node 后台插件** —— 走 stdio 上的行分隔 JSON，由
//     \`desktop/background/plugins.rs\` 把协议消息翻译进来。
//
// 两者的**传输**完全不同，而**语义**必须完全一致：同一个插件在两种运行位置之间
// 迁移时，\`ctx.storage.set\` 的配额判定、\`ctx.dataDir\` 的路径净化、
// 权限检查的时机都不该有任何差别。
//
// 因此这里只做一件事：**方法名 + 参数 → 结果**。翻译由调用方各自负责，
// 而"能做什么"只有一处定义。复制一份到 Node 那条路径上，等于给自己造了
// 第二个真源 —— 而本项目已经因为"两套清单"栽过一次（技术债 §7.40）。
//
// ============================================================
// 权限判定不在这里重写
// ============================================================
//
// \`PluginManager\` 的每个方法自己会走 \`require_permission\`，配额也仍在同一条
// 路径上。这一层只负责"这是哪个插件在调、调的是哪一个方法"，不负责"他能不能"。
//
// 唯一的例外是 \`notify\`：通知属于宿主的通知中心而不是插件的数据，
// 因此那一条自己判 \`Notification\` 权限。

use std::collections::HashMap;

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use super::PluginState;

/// \`ctx.storage.all()\` 一次能读的键数上限。
///
/// 与前端 \`MAX_STORAGE_ALL_KEYS\` 保持一致。它是"把所有数据拉进内存"的接口，
/// 而插件的存储上限是 2000 个键 —— 无条件全读等于把那个上限直接搬到内存里。
const MAX_STORAGE_ALL_KEYS: usize = 500;

/// 插件设置的存储键前缀。**必须与 \`pluginContributions.ts::settingStorageKey\` 一致。**
///
/// 两处不一致的表现是：用户在设置界面改了值，插件读到的还是旧值（或反过来），
/// 而两边各自的代码看起来都是对的。
pub const SETTING_KEY_PREFIX: &str = "__host__.setting.";

/// 取参数里的一个字段。
///
/// **\`null\` 与"没给"在这里是同一件事**：两个调用方都用 \`JSON.stringify\` /
/// \`serde_json\` 发送，\`undefined\` 会被丢掉、\`null\` 会留下，而两者对调用方
/// 表达的都是"没给"。不合并的话，\`rel: null\` 会以一次 \`as_str()\` 失败的形式
/// 报出一句与事实不符的"缺少 rel"。
fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|value| !value.is_null())
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    arg(args, key).and_then(|value| value.as_str())
}

/// 插件系统状态里的管理器。没有它说明插件模块还没起来。
fn plugin_manager<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<std::sync::Arc<tokio::sync::RwLock<super::manager::PluginManager>>> {
    app.try_state::<PluginState>().map(|s| s.0.clone())
}

/// 取管理器并加读锁；拿不到就直接返回"插件系统尚未就绪"。
///
/// 宏而不是函数：每一条 RPC 都要在**持有读锁期间**调用一个方法，而其中几条本身
/// 是 async（网络、文件对话框）。写成函数就得把整个调用塞进闭包，那些 \`await\`
/// 会落到闭包外 —— 类型上过不去，读起来也更绕。
///
/// \`read_owned\` 而不是 \`read\`：普通的读锁守卫**借用**那把锁，而这里 \`Arc\` 是宏
/// 内部的一个临时值 —— 它会在宏块结束时被丢掉，于是守卫活不过那一刻
/// （E0597）。\`read_owned\` 拿的是拥有所有权的守卫，因此没有这个生命周期问题。
macro_rules! locked {
    ($app:expr) => {
        match plugin_manager($app) {
            None => return rpc_error("插件系统尚未就绪"),
            Some(handle) => handle.read_owned().await,
        }
    };
}

/// 一次调用失败。
///
/// 消息**原样透出**给插件：配额拒绝那句里带着"哪一档、上限多少、已用多少、
/// 本次多少"四个数字，插件需要它们才能自救，包一层自己的话只会把数字弄丢。
fn rpc_error(message: impl std::fmt::Display) -> Result<Value, String> {
    Err(message.to_string())
}

/// 成功，但没有内容。
///
/// 用 \`null\` 而不是省略：调用方要能区分"做完了"与"通道没有回话"。
fn json_ok() -> Result<Value, String> {
    Ok(Value::Null)
}

/// 成功，并带一个值。
fn json_value(value: Value) -> Result<Value, String> {
    Ok(value)
}

/// \`storage.all()\` 的返回形状：\`{键: 已解析的值}\`。
///
/// 解析失败的键**跳过**（与前端 \`ctx.storage.get\` 在解析失败时回落到 \`undefined\`
/// 的效果一致）。把它原样塞成字符串会让插件拿到一个它自己写进去时并不是那个形状的值。
fn parse_stored(raw: &str) -> Option<Value> {
    serde_json::from_str(raw).ok()
}

/// 执行一次 ctx 调用。
///
/// 参数与返回都是 `serde_json::Value` —— 这一层不认识 HTTP，也不认识 stdio。
///
/// ============================================================
/// `surface` 为什么是 `Option`
/// ============================================================
///
/// 同一个 `ctx` 有两个调用方，而**只有界面有"我在哪一个界面里"这一说**：
///
///   · 沙箱界面插件 —— 标签里带着界面名，因此传 `Some("detail")` 这样的值；
///   · Node 后台插件 —— 它**没有界面**，传 `None`。
///
/// 用 `Option` 而不是"空串表示没有"：后者会让"后台插件调 `ui.closeSurface`
/// 却传了一个空界面名"与"界面插件调它"变成同一条路径，而它们该有完全不同的
/// 反应（前者是一个错误，后者是一次正常调用）。
pub async fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: Option<&str>,
    method: &str,
    args: &Value,
) -> Result<Value, String> {
    match method {
        "log" => {
            let level = args.get("level").and_then(|v| v.as_str()).unwrap_or("info");
            let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
            match level {
                "debug" => log::debug!("[plugin:{}] {message}", plugin_id),
                "warn" => log::warn!("[plugin:{}] {message}", plugin_id),
                "error" => log::error!("[plugin:{}] {message}", plugin_id),
                _ => log::info!("[plugin:{}] {message}", plugin_id),
            }
            json_ok()
        }

        // ---- 存储 ----------------------------------------------------------
        //
        // 值一律以**字符串**进出：插件在那里存的是 `JSON.stringify(值)`，
        // 而"谁来解析"这件事必须只有一处。放在桥接层（而不是这里）是因为
        // Rust 侧原样返回一串字符串是**无损**的，而在这里解析会把
        // "存进去的不是合法 JSON"变成一条静默的 `null`。

        "storage.get" => {
            let Some(key) = arg_str(&args, "key") else {
                return rpc_error("缺少 key");
            };
            let manager = locked!(app);
            match manager.storage_get(plugin_id, key) {
                Ok(value) => json_value(serde_json::json!(value)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "storage.set" => {
            let (Some(key), Some(value)) = (arg_str(&args, "key"), arg_str(&args, "value")) else {
                return rpc_error("缺少 key 或 value");
            };
            let manager = locked!(app);
            match manager.storage_set(plugin_id, key, value) {
                Ok(()) => json_ok(),
                // 配额拒绝的消息里带着"哪一档、上限多少、已用多少、本次多少"
                // 四个数字，原样回给插件 —— 它需要那些数字才能自救。
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "storage.delete" => {
            let Some(key) = arg_str(&args, "key") else {
                return rpc_error("缺少 key");
            };
            let manager = locked!(app);
            match manager.storage_delete(plugin_id, key) {
                Ok(()) => json_ok(),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "storage.keys" => {
            let manager = locked!(app);
            match manager.storage_keys(plugin_id) {
                Ok(keys) => json_value(serde_json::json!(keys)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "storage.list" => {
            let prefix = arg_str(&args, "prefix").unwrap_or("");
            let cursor = arg_str(&args, "cursor");
            let page_size = arg(&args, "pageSize")
                .and_then(|value| value.as_u64())
                .map(|value| value as usize);
            let manager = locked!(app);
            match manager.storage_list_paged(plugin_id, prefix, cursor, page_size) {
                Ok(page) => json_value(serde_json::json!(page)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "storage.usage" => {
            let manager = locked!(app);
            match manager.storage_usage(plugin_id) {
                Ok(usage) => json_value(serde_json::json!(usage)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "storage.clear" => {
            let manager = locked!(app);
            match manager.storage_clear(plugin_id) {
                Ok(()) => json_ok(),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "storage.all" => {
            let manager = locked!(app);
            let keys = match manager.storage_keys(plugin_id) {
                Ok(keys) => keys,
                Err(e) => return rpc_error(&e.to_string()),
            };

            // 超限时**抛错而不是静默截断**：截断会让插件拿到一份"看起来正常但
            // 缺了很多条"的数据，而缺数据是最难被发现的一类错误。
            if keys.len() > MAX_STORAGE_ALL_KEYS {
                return rpc_error(&format!(
                    "ctx.storage.all() 最多支持 {MAX_STORAGE_ALL_KEYS} 个键，当前有 {} 个。\
                     请改用 ctx.storage.list() 分页读取，或先清理不再需要的数据。",
                    keys.len()
                ));
            }

            let mut result = serde_json::Map::new();
            for key in keys {
                if let Ok(Some(raw)) = manager.storage_get(plugin_id, &key) {
                    if let Some(value) = parse_stored(&raw) {
                        result.insert(key, value);
                    }
                }
            }
            json_value(serde_json::json!(result))
        }

        // ---- 插件数据目录（ctx.dataDir）-------------------------------------
        //
        // 与存储的分工：存储是"一条记录一个键、单值 1 MB"，这里是**文件目录**，
        // 单文件 256 MB、总量 1 GiB。大内容必须走这里。

        "data.available" => {
            let manager = locked!(app);
            let status = manager.data_root_status();
            json_value(serde_json::json!({
                    "available": status.available,
                    "configured": status.configured,
                    "path": status.path,
                    "reason": status.reason,
                }))
        }

        "data.list" => {
            let rel = arg_str(&args, "rel").unwrap_or("");
            let manager = locked!(app);
            match manager.data_list(plugin_id, rel) {
                Ok(entries) => json_value(serde_json::json!(entries)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "data.stat" => {
            let rel = arg_str(&args, "rel").unwrap_or("");
            let manager = locked!(app);
            match manager.data_stat(plugin_id, rel) {
                Ok(info) => json_value(serde_json::json!(info)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        // `data.read` 仍然给 base64 版本：它是"小内容走一次 RPC"的便捷路径，
        // 也是**唯一能在只有 JSON 的地方**用的一条（比如把图片塞进 CSS）。
        //
        // 大内容走 `/<id>/data/<rel>` 那条原始字节通道 —— 见 `handle` 里的路由。
        // 那里没有 base64，代价是它只能从文档里 fetch，而不是一次普通 RPC。
        "data.read" => {
            use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

            let rel = arg_str(&args, "rel").unwrap_or("");
            let manager = locked!(app);
            match manager.data_read(plugin_id, rel) {
                Ok(bytes) => json_value(serde_json::json!(BASE64.encode(bytes))),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "data.write" => {
            use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

            let rel = arg_str(&args, "rel").unwrap_or("");
            let Some(content) = arg_str(&args, "content") else {
                return rpc_error("缺少 content");
            };
            let bytes = match BASE64.decode(content) {
                Ok(bytes) => bytes,
                Err(e) => return rpc_error(&format!("内容不是合法的 base64：{e}")),
            };
            let manager = locked!(app);
            match manager.data_write(plugin_id, rel, &bytes) {
                Ok(()) => json_ok(),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "data.mkdir" => {
            let rel = arg_str(&args, "rel").unwrap_or("");
            let manager = locked!(app);
            match manager.data_mkdir(plugin_id, rel) {
                Ok(()) => json_ok(),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "data.remove" => {
            let rel = arg_str(&args, "rel").unwrap_or("");
            let manager = locked!(app);
            match manager.data_remove(plugin_id, rel) {
                Ok(()) => json_ok(),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "data.used" => {
            let manager = locked!(app);
            match manager.data_used(plugin_id) {
                Ok(bytes) => json_value(serde_json::json!(bytes)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        // ---- 网络 ----------------------------------------------------------

        "http.fetch" => {
            let Some(url) = arg_str(&args, "url") else {
                return rpc_error("缺少 url");
            };
            let method = arg_str(&args, "method").unwrap_or("GET");

            // 表头必须是"字符串 → 字符串"。用 `serde_json` 直接反序列化到
            // `HashMap<String, String>`：一个非字符串的值会让整条请求失败并说清
            // 是哪一处，而手工逐个 `as_str()` 会把它们静默丢掉。
            let headers: Option<HashMap<String, String>> = match arg(&args, "headers") {
                None => None,
                Some(value) => match serde_json::from_value(value.clone()) {
                    Ok(headers) => Some(headers),
                    Err(e) => return rpc_error(&format!("headers 必须是字符串到字符串的表：{e}")),
                },
            };
            let body = arg_str(&args, "body").map(str::to_string);

            let manager = locked!(app);
            match manager
                .http_request(plugin_id, method, url, headers, body)
                .await
            {
                Ok(response) => json_value(serde_json::json!(response)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        // ---- 通知 ----------------------------------------------------------
        //
        // 通知**不走 `PluginManager`**（它是宿主的通知中心，不是插件的数据），
        // 因此这一条是这里唯一自己判权限的地方。
        //
        // 在 Rust 侧判而不是在桥接层判：`Notification` 在权限表里标的是
        // `host` 强制（与 `clipboard` 的 `frontend` 强制相反），因为通知的
        // 唯一出口就是这个函数 —— 插件没有别的办法往通知中心写东西。

        "notify" => {
            let Some(title) = arg_str(&args, "title") else {
                return rpc_error("缺少 title");
            };

            {
                let manager = locked!(app);
                if let Err(e) = manager
                    .require_permission(plugin_id, super::types::PluginPermission::Notification)
                {
                    return rpc_error(&e.to_string());
                }
            }

            let Some(state) = app.try_state::<crate::modules::notifications::commands::NotificationsState>()
            else {
                return rpc_error("通知中心尚未就绪");
            };

            let input = crate::modules::notifications::commands::PushNotificationInput {
                title: title.to_string(),
                body: arg_str(&args, "body").unwrap_or("").to_string(),
                level: match arg_str(&args, "level") {
                    Some("success") => crate::modules::notifications::store::NotificationLevel::Success,
                    Some("warning") => crate::modules::notifications::store::NotificationLevel::Warning,
                    Some("error") => crate::modules::notifications::store::NotificationLevel::Error,
                    _ => crate::modules::notifications::store::NotificationLevel::Info,
                },
                category: crate::modules::notifications::store::NotificationCategory::General,
                // 来源写成插件 id：通知中心据此把它归到那个插件名下，
                // 而不是笼统的 `host`。插件**不能**自报来源。
                source: format!("plugin:{}", plugin_id),
                dedupe_key: arg_str(&args, "dedupeKey").map(str::to_string),
            };

            match crate::modules::notifications::commands::push(app, state.inner(), input) {
                Ok(_) => json_ok(),
                Err(e) => rpc_error(&e),
            }
        }

        // 把一个大文件**直接下到数据目录**，不经过 JS 内存。
        //
        // ============================================================
        // 它为什么不是 `http.fetch` 的一个选项
        // ============================================================
        //
        // `http.fetch` 的响应体是**一个字符串**。一个 200 MB 的文件走那条路意味着
        // 整段字节在 Rust 里驻留一次、编码成 JSON、过一遍 IPC、在插件的 JS 堆里
        // 再驻留一次、再 base64 一次写回去 —— 峰值内存是文件大小的好几倍，而换来
        // 的只是"文件从网上下到了磁盘"。
        //
        // 这一条从网络流直接写进磁盘，全程只有一个固定大小的缓冲区。
        //
        // ============================================================
        // 进度是怎么回去的
        // ============================================================
        //
        // RPC 是"发出去、拿到结果"，因此进度不可能走返回值。它走的是宿主 →
        // 插件的推送通道（`sandbox::push_to`，经前端转成一条 `postMessage`），
        // 与主题、快捷键、命令同一条。
        //
        // 推给**发起调用的那块界面**：一次下载是它发起的，进度条也画在它那里。
        "http.download" => {
            let Some(url) = arg_str(args, "url") else {
                return rpc_error("缺少 url");
            };
            let Some(rel) = arg_str(args, "rel") else {
                return rpc_error("缺少 rel（下载目标，相对数据目录）");
            };

            let headers: Option<HashMap<String, String>> = match arg(args, "headers") {
                None => None,
                Some(value) => match serde_json::from_value(value.clone()) {
                    Ok(headers) => Some(headers),
                    Err(e) => return rpc_error(&format!("headers 必须是字符串到字符串的表：{e}")),
                },
            };

            // 进度回调必须能跨 `await` 传到管理器里去，而它还要在每次回调时
            // 推一条脚本给插件界面 —— 那是一件异步的事。因此这里把它做成
            // "派生一个任务"，而不是阻塞流式循环等 eval 完成。
            //
            // 节流在管理器那一侧（见 `PROGRESS_STEP_BYTES`）：它决定**调不调**，
            // 这里只负责把调到的那一次送出去。
            let progress_app = app.clone();
            let progress_plugin = plugin_id.to_string();
            let progress_surface = surface.map(str::to_string);
            let progress_rel = rel.to_string();

            let manager = match plugin_manager(app) {
                None => return rpc_error("插件系统尚未就绪"),
                Some(handle) => handle,
            };

            // 锁**不能跨整个下载**：那会把整个插件系统的读路径一起按住 ——
            // 包括别的插件的界面。先取一份管理器句柄的克隆，放掉读锁，
            // 再用它跑下载。
            let result = {
                let guard = manager.read().await;
                guard
                    .http_download(plugin_id, url, rel, headers, move |received, total| {
                        let app = progress_app.clone();
                        let plugin = progress_plugin.clone();
                        let surface = progress_surface.clone();
                        let rel = progress_rel.clone();

                        // 派生而不是等待：`eval` 要落到界面线程，而流式循环在
                        // 一个阻塞线程上。等它会让"下载速度"跟着"界面响应速度"走。
                        tauri::async_runtime::spawn(async move {
                            super::sandbox::deliver_download_progress(
                                &app, &plugin, &rel, received, total, surface.as_deref(),
                            )
                            .await;
                        });
                    })
                    .await
            };

            match result {
                Ok(outcome) => json_value(serde_json::json!(outcome)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        // ---- 系统能力 ------------------------------------------------------

        "system.launch" => {
            let Some(program) = arg_str(&args, "program") else {
                return rpc_error("缺少 program");
            };
            let argv: Vec<String> = arg(&args, "args")
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default();

            let manager = locked!(app);
            match manager.launch_program(plugin_id, program, &argv) {
                Ok(()) => json_ok(),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "system.reveal" => {
            let Some(path) = arg_str(&args, "path") else {
                return rpc_error("缺少 path");
            };
            let manager = locked!(app);
            match manager.reveal_in_folder(plugin_id, path) {
                Ok(()) => json_ok(),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "system.icon" => {
            let Some(path) = arg_str(&args, "path") else {
                return rpc_error("缺少 path");
            };
            let manager = locked!(app);
            match manager.extract_icon(plugin_id, path) {
                Ok(data_url) => json_value(serde_json::json!(data_url)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        "system.pickAudio" => {
            // 文件对话框会阻塞到用户做出选择，因此**不能**在持有管理器读锁时
            // 等它 —— 那会把整个插件系统的读路径一起卡住（包括别的插件的界面）。
            // 先判权限（读锁，很短），放掉锁，再弹框。
            {
                let manager = locked!(app);
                if let Err(e) = manager
                    .require_permission(plugin_id, super::types::PluginPermission::FilesystemRead)
                {
                    return rpc_error(&e.to_string());
                }
            }

            let manager = match plugin_manager(app) {
                None => return rpc_error("插件系统尚未就绪"),
                Some(handle) => handle,
            };
            let picked = {
                let guard = manager.read().await;
                guard.pick_audio(plugin_id).await
            };
            match picked {
                Ok(picked) => json_value(serde_json::json!(picked)),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        // ---- 设置 ----------------------------------------------------------
        //
        // 插件设置**存在插件自己的存储里**（键前缀 `__host__.setting.`，与
        // 前端 `pluginSettings.ts` 完全一致）。因此这里不需要新的后端存储，
        // 也不需要新的权限 —— `storage_set` 自己会要求 `storage` 权限。
        //
        // 前缀里的 `__host__.` 是刻意的：它让"宿主写的键"与"插件自己写的键"
        // 不可能撞上，而撞上的表现是"用户的设置被插件的一条记录覆盖了"。

        "settings.all" => {
            let manager = locked!(app);
            let keys = match manager.storage_keys(plugin_id) {
                Ok(keys) => keys,
                Err(e) => return rpc_error(&e.to_string()),
            };

            let mut result = serde_json::Map::new();
            for key in keys {
                let Some(id) = key.strip_prefix(SETTING_KEY_PREFIX) else {
                    continue;
                };
                if let Ok(Some(raw)) = manager.storage_get(plugin_id, &key) {
                    if let Some(value) = parse_stored(&raw) {
                        result.insert(id.to_string(), value);
                    }
                }
            }
            json_value(serde_json::json!(result))
        }

        "settings.set" => {
            let (Some(id), Some(value)) = (arg_str(&args, "id"), arg(&args, "value")) else {
                return rpc_error("缺少 id 或 value");
            };
            let key = format!("{SETTING_KEY_PREFIX}{id}");
            let encoded = value.to_string();

            let manager = locked!(app);
            match manager.storage_set(plugin_id, &key, &encoded) {
                Ok(()) => json_ok(),
                Err(e) => rpc_error(&e.to_string()),
            }
        }

        // ---- 跨插件事件 ------------------------------------------------------
        //
        // 需要 `plugin-communicate` 权限：它是"让别的插件执行代码"的一条路径，
        // 而插件之间默认互不信任（一个插件不该能靠发事件驱动另一个插件做事）。
        //
        // 事件有**两个**消费方，因此这里要同时送给它们：
        //
        //   1. **界面侧** —— 宿主主 webview 通过一次 Tauri 事件收到它，再交给
        //      前端的事件总线，由总线分发给 in-process 与沙箱界面插件；
        //   2. **后台侧** —— 每个跑着的后台插件各自一个进程，宿主直接向
        //      声明了订阅的那些投递。
        //
        // 只做一半的表现是"界面插件收得到、后台插件收不到"（或反过来），
        // 而那看起来像某个插件的 bug。
        "events.emit" => {
            let Some(name) = arg_str(args, "name") else {
                return rpc_error("缺少 name");
            };
            let payload = arg(args, "payload").cloned().unwrap_or(Value::Null);

            {
                let manager = locked!(app);
                if let Err(error) = manager.require_permission(
                    plugin_id,
                    super::types::PluginPermission::PluginCommunicate,
                ) {
                    return rpc_error(error.to_string());
                }
            }

            use tauri::Emitter;
            if let Err(error) = app.emit(
                PLUGIN_EVENT,
                serde_json::json!({
                    "source": plugin_id,
                    "name": name,
                    "payload": payload,
                }),
            ) {
                // 界面侧送不到不该让这次调用失败：后台那一侧可能照常送达，
                // 而"发出去了一半"比"整个没发出去"更该留下痕迹。
                log::warn!("广播插件事件失败（不影响后台插件）：{error}");
            }

            if let Some(background) =
                app.try_state::<crate::modules::desktop::background::plugins::BackgroundPlugins>()
            {
                background
                    .dispatch_event(plugin_id, name, payload.clone())
                    .await;
            }

            deliver_to_surfaces(app, plugin_id, name, &payload);

            json_ok()
        }

        // ---- 主题 ----------------------------------------------------------
        //
        // 主题令牌在**入口文档**里就已经注入了（见 `theme.rs`），因此插件在
        // 样式表里直接 `var(--accent-500)` 就行，不必先取一次。
        //
        // 这一条是给"需要用 JS 拿颜色"的场景准备的：画到 canvas 上、算对比度、
        // 生成 SVG。没有它的话那些插件只能去读 `getComputedStyle` ——
        // 而读到之后还得自己订阅主题变化再读一次，也就是每个插件都要实现一遍。
        "theme.tokens" => {
            let Some(state) = app.try_state::<super::theme::PluginTheme>() else {
                return rpc_error("主题尚未就绪");
            };
            json_value(state.describe())
        }

        // ---- 快捷键 --------------------------------------------------------
        //
        // 表已经在**入口文档**里注入了（桥接层要拿它判断某个组合该不该转发，
        // 而那个判断不能靠 IPC 往返 —— 那是每敲一个键一次）。这一条只是给插件
        // 一个"再取一次"的入口。
        "shortcuts.list" => {
            let Some(state) = app.try_state::<super::shortcuts::PluginShortcuts>() else {
                return rpc_error("快捷键表尚未就绪");
            };
            json_value(state.describe())
        }

        // 桥接层认定"用户按了宿主的某个快捷键"之后走它。
        //
        // `normalized` 由宿主**复核**一遍：桥接层跑在插件文档里，而插件能改
        // 自己文档里的任何东西。只信它等于让插件可以触发任意一个"看起来像
        // 快捷键"的动作。
        //
        // 复核通过之后发给界面那一侧执行 —— 动作的真正实现（打开搜索、切标签）
        // 在宿主前端，不在 Rust 里。
        "shortcut.trigger" => {
            let Some(normalized) = arg_str(args, "normalized") else {
                return rpc_error("缺少 normalized");
            };

            let Some(state) = app.try_state::<super::shortcuts::PluginShortcuts>() else {
                return rpc_error("快捷键表尚未就绪");
            };
            if !state.is_host_combo(normalized) {
                return rpc_error(&format!("{normalized} 不是宿主的快捷键"));
            }

            use tauri::Emitter;
            if let Err(error) = app.emit(
                SHORTCUT_TRIGGERED,
                serde_json::json!({ "normalized": normalized, "source": plugin_id }),
            ) {
                log::warn!("转发快捷键失败：{error}");
                return rpc_error("无法把快捷键交给宿主");
            }

            json_ok()
        }

        // ---- 宿主渲染的浮层 --------------------------------------------------
        //
        // 这两条**会阻塞到用户做出选择**，等待上限是 `overlay.rs` 里那个 5 分钟。
        // 插件那边就是一次普通的 await。
        //
        // 为什么必须由宿主渲染而不是插件自己画：见 `overlay.rs` 的文件头。
        // 一句话 —— 沙箱插件的界面是原生子 webview，它盖得住宿主的 DOM；
        // 而让插件自己画对话框等于让它冒充宿主界面。

        "ui.dialog" => {
            let Some(title) = arg_str(args, "title") else {
                return rpc_error("缺少 title");
            };

            let request = crate::modules::desktop::overlay::OverlayRequest::Dialog {
                // 由 overlay 分配：配对用的 id 只能有一个来源，两个调用方各自
                // 生成就有可能撞上，而撞上的表现是"回答给了另一次请求"。
                id: 0,
                tone: arg_str(args, "tone").unwrap_or("info").to_string(),
                title: title.to_string(),
                message: arg_str(args, "message").unwrap_or("").to_string(),
                confirm_label: arg_str(args, "confirmLabel").unwrap_or("确定").to_string(),
                cancel_label: arg_str(args, "cancelLabel").map(str::to_string),
            };

            ask_overlay(app, request).await
        }

        "ui.contextMenu" => {
            let mut items: Vec<crate::modules::desktop::overlay::MenuItem> = arg(args, "items")
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default();

            // ============================================================
            // 清单声明的菜单项
            // ============================================================
            //
            // 缺省**合并**（`includeDeclared` 缺省是 true）：插件在清单里写下的
            // 右键菜单条目，与它这一次临时给出的条目，本来就该出现在同一个菜单里 ——
            // 让作者每次都得把清单里那些再手写一遍，等于让清单那一块永远用不上。
            //
            // 它们被冠上 `DECLARED_PREFIX` 的 id 前缀，因为执行方式完全不同：
            // 临时条目是**这一次调用**的结果，而声明条目要经由插件的命令机制。
            // 不加前缀的话两者会撞 id —— 而撞上的表现是"点了这一条，执行的是
            // 插件自己那条"。
            let include_declared = args
                .get("includeDeclared")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);

            if include_declared {
                let declared = {
                    let manager = locked!(app);
                    manager.context_menus(plugin_id).unwrap_or_default()
                };

                if !declared.is_empty() && !items.is_empty() {
                    // 分隔线：临时条目在上、清单条目在下。没有它的话两组按钮会
                    // 连成一片，而用户看不出"上面那几条是这一次的、下面那几条是常驻的"。
                    items.push(crate::modules::desktop::overlay::MenuItem {
                        id: String::new(),
                        label: String::new(),
                        accelerator: None,
                        separator: true,
                        disabled: false,
                    });
                }

                for menu in declared {
                    items.push(crate::modules::desktop::overlay::MenuItem {
                        id: format!("{DECLARED_PREFIX}{}", menu.id),
                        label: menu.label,
                        accelerator: None,
                        separator: false,
                        disabled: false,
                    });
                }
            }

            if items.iter().all(|item| item.separator) {
                return rpc_error("菜单一个可选项都没有");
            }

            let request = crate::modules::desktop::overlay::OverlayRequest::Menu {
                id: 0,
                title: arg_str(args, "title").map(str::to_string),
                items,
            };

            let response = ask_overlay(app, request).await?;

            // 选中了清单声明的那一条 → 交给插件的命令机制去执行。
            //
            // 这一步**在浮层回答之后**：菜单已经关掉了，用户看到的就是"点了它、
            // 菜单消失、事情开始做"。等命令执行完再关菜单会让一次慢的初始化把
            // 菜单挂在屏幕上。
            if let Some(selected) = response.get("selected").and_then(|value| value.as_str()) {
                if let Some(menu_id) = selected.strip_prefix(DECLARED_PREFIX) {
                    run_declared_menu(app, plugin_id, surface, menu_id).await?;
                }
            }

            json_value(response)
        }

        // ---- 宿主渲染的状态指示（徽标 / 进度 / 启动占位）-----------------------
        //
        // 这三条的共同点是：**它们要画的地方宿主才画得出**。
        //
        //   * `badge` —— 侧边栏与标签栏上的徽标。沙箱插件的文档在它自己的
        //     webview 里，碰不到宿主的标签栏；
        //   * `progress` —— 同一条理由；
        //   * `splash` —— 覆盖插件那一块**位置**的启动占位。原生 webview 盖在
        //     宿主 DOM 之上，所以要让宿主画出来，必须先把 webview 收起来。
        //
        // 三条都只**广播给前端**，不在这里碰任何窗口：徽标与进度是 DOM，
        // 而占位的显示/隐藏牵动 webview 的可见性 —— 那件事归 `surface.rs`
        // 的所有者线程，前端会通过 `sandbox_surface_open(visible: false)` 表达。
        //
        // 同一个 `ctx` 有两个调用方，而这三条**只在界面插件上有意义**：后台插件
        // 没有标签栏、也没有可覆盖的一块位置。因此 `surface` 为 `None` 时直接
        // 拒绝，而不是静默地什么都不做 —— 后者会让后台插件作者以为它生效了。

        "ui.badge" => {
            let text = arg_str(args, "text")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| truncate(value, MAX_BADGE_CHARS));

            let value = match text {
                // `null` = 清掉。它必须是**一个明确的取值**，而不是"没给"：
                // 插件在任务跑完之后要能说"把徽标去掉"。
                None => Value::Null,
                Some(text) => serde_json::json!({ "text": text, "tone": badge_tone(args) }),
            };

            emit_ui(app, plugin_id, surface, "badge", value)
        }

        "ui.progress" => {
            // `value` 为 `null` **且**没有 `label` 时是"清掉"；给了 `label` 而没有
            // `value` 是"不定量进度"（转圈）。这两件事必须分得开：插件说"我在忙"
            // 与插件说"我不忙了"是两条不同的指令。
            let label = arg_str(args, "label")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| truncate(value, MAX_BADGE_CHARS));

            let value = match (arg(args, "value"), label) {
                (None, None) => Value::Null,
                (value, label) => {
                    let fraction = value.and_then(|value| value.as_f64());
                    if let Some(fraction) = fraction {
                        if !(0.0..=1.0).contains(&fraction) {
                            return rpc_error(&format!(
                                "ui.progress 的 value 必须落在 0..1，收到 {fraction}"
                            ));
                        }
                    }
                    serde_json::json!({ "value": fraction, "label": label })
                }
            };

            emit_ui(app, plugin_id, surface, "progress", value)
        }

        "ui.splash" => {
            // `auto: true` 是**自动清除**：插件的文档加载完了，如果它没有自己
            // 接管过占位，就把宿主那块"正在启动"的占位撤掉。
            //
            // 没有这条的话默认行为是错的：一个从没调过 `ui.splash` 的插件会让
            // 那块占位**永远留在屏幕上**，而用户看到的是"这个插件打不开"。
            // 有它之后默认行为是对的，插件想自己控制再显式调一次。
            let text = arg_str(args, "text")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| truncate(value, MAX_SPLASH_CHARS));

            let auto = args
                .get("auto")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);

            let value = match text {
                None => Value::Null,
                Some(text) => serde_json::json!({
                    "text": text,
                    "tone": splash_tone(args),
                    "progress": arg(args, "progress").and_then(|value| value.as_f64()),
                }),
            };

            emit_ui_with(app, plugin_id, surface, "splash", value, auto)
        }

        // ---- 结构化数据（ctx.db）---------------------------------------------
        //
        // ============================================================
        // 为什么这一层看不到"能不能做"的判定
        // ============================================================
        //
        // 权限（`plugin-data`）与"数据根可用"由 `PluginManager::database_path`
        // 判，而它是打开连接的那一步。这里的三条只是**取连接、跑 SQL、回结果**。
        //
        // ============================================================
        // 边界在 `db.rs` 里，不在这些参数上
        // ============================================================
        //
        // `ATTACH`、危险的 PRAGMA、`load_extension` 全部由 SQLite 自己的
        // authorizer 拒绝（见 `db.rs` 的文件头）。这一层因此**不做**任何
        // SQL 文本检查 —— 做的话就是第二套会漂的规则，而它的失效方式是
        // "看起来拦住了，实际没拦住"。

        "db.query" | "db.exec" | "db.transaction" => {
            let Some(sql) = arg_str(args, "sql") else {
                // `transaction` 没有 `sql`，它带的是 `statements`。
                if method == "db.transaction" {
                    let statements: Vec<super::db::Statement> = match arg(args, "statements") {
                        Some(value) => match serde_json::from_value(value.clone()) {
                            Ok(statements) => statements,
                            Err(e) => {
                                return rpc_error(&format!(
                                    "statements 必须是 [{{sql, params?}}] 形状：{e}"
                                ))
                            }
                        },
                        None => return rpc_error("缺少 statements"),
                    };

                    let Some(databases) = app.try_state::<super::db::PluginDatabases>() else {
                        return rpc_error("插件数据库尚未就绪");
                    };
                    return match databases.transaction(app, plugin_id, statements).await {
                        Ok(results) => json_value(serde_json::json!(results)),
                        Err(e) => rpc_error(&e),
                    };
                }

                return rpc_error("缺少 sql");
            };

            // 参数缺省是空数组。`null` 与"没给"在这里是同一件事（见 `arg` 的说明）。
            let params: Vec<Value> = arg(args, "params")
                .map(|value| {
                    if value.is_array() {
                        value.as_array().cloned().unwrap_or_default()
                    } else {
                        vec![value.clone()]
                    }
                })
                .unwrap_or_default();

            let Some(databases) = app.try_state::<super::db::PluginDatabases>() else {
                return rpc_error("插件数据库尚未就绪");
            };

            let outcome = if method == "db.query" {
                databases
                    .query(app, plugin_id, sql, &params)
                    .await
                    .map(|result| serde_json::json!(result))
            } else {
                databases
                    .exec(app, plugin_id, sql, &params)
                    .await
                    .map(|result| serde_json::json!(result))
            };

            match outcome {
                Ok(value) => json_value(value),
                Err(e) => rpc_error(&e),
            }
        }

        // ---- 多界面（api: 3）-------------------------------------------------
        //
        // ============================================================
        // 为什么 `openSurface` 不是"宿主直接建一个 webview"
        // ============================================================
        //
        // 沙箱界面的**位置与尺寸只有前端知道** —— 只有它知道标签栏多高、侧边栏
        // 是否展开、分屏是不是开着。宿主在这一侧建 webview 就只能自己猜一个矩形，
        // 而猜出来的界面会漂在某个不对的地方（或者干脆在窗口外）。
        //
        // 因此这一条走的是：
        //
        //   插件 → ui.openSurface → 宿主广播一个请求 → 前端开一个标签
        //        → 前端量出矩形 → sandbox_surface_open(插件, 界面, 矩形)
        //
        // 也就是**位置由宿主决定，插件只说要哪一个界面**。这与方案 §5 那一行
        // 注释（`// 宿主决定位置`）是同一条。
        //
        // `openSurface` 因此**不等界面建好**：它是一次"我请求了"，不是"它已经在了"。
        // 想确认的话调 `listSurfaces()` —— 那一条读的是宿主这一侧的真源。
        "ui.openSurface" => {
            let Some(id) = arg_str(args, "id") else {
                return rpc_error("缺少 id");
            };

            // 界面必须在**当前**清单里。不判的话插件可以要求打开一个不存在的界面，
            // 而宿主编出来的会是一块服务 404 的空面板 —— 那看起来像宿主坏了。
            let view = {
                let manager = locked!(app);
                match manager.sandbox_view(plugin_id) {
                    Ok(view) => view,
                    Err(e) => return rpc_error(&e.to_string()),
                }
            };

            if view.surface(id).is_none() {
                return rpc_error(&format!(
                    "清单里没有界面 {id}（它声明的是：{}）",
                    view.surfaces.ids().join("、")
                ));
            }

            // 位置信息（如果插件给了）原样带上：前端把它当成"建议矩形"，
            // 量得出来的话还是以自己的测量为准。它存在的意义是让插件能说
            // "开一个 480 宽的详情"，而不是决定像素。
            use tauri::Emitter;
            if let Err(error) = app.emit(
                OPEN_SURFACE,
                serde_json::json!({
                    "pluginId": plugin_id,
                    "surface": id,
                    "source": surface,
                }),
            ) {
                return rpc_error(&format!("无法请求宿主打开界面：{error}"));
            }

            json_ok()
        }

        "ui.closeSurface" => {
            let Some(id) = arg_str(args, "id") else {
                return rpc_error("缺少 id");
            };

            use tauri::Emitter;
            if let Err(error) = app.emit(
                CLOSE_SURFACE,
                serde_json::json!({ "pluginId": plugin_id, "surface": id }),
            ) {
                return rpc_error(&format!("无法请求宿主关闭界面：{error}"));
            }

            json_ok()
        }

        // 读的是**宿主这一侧**的真源（`SandboxSurfaces`），而不是问前端。
        // 前端那一侧要经过标签状态、渲染时机、React 提交才能回答同一个问题 ——
        // 两个来源一定会漂，而漂开的方向是"插件以为界面开着，其实早关了"。
        "ui.listSurfaces" => {
            let declared = {
                let manager = locked!(app);
                match manager.sandbox_view(plugin_id) {
                    Ok(view) => view,
                    Err(e) => return rpc_error(&e.to_string()),
                }
            };

            let open = super::sandbox::live_surfaces(app, plugin_id);

            // 发起这次调用的界面。清单里已经找不到它时是 `None` —— 那说明界面
            // 刚被作者从清单里删掉，于是"current"这一项全都是 `false`，
            // 这正是事实。
            let current = surface.and_then(|id| declared.surfaces.get(id));

            let list: Vec<Value> = declared
                .surfaces
                .all()
                .iter()
                .map(|surface| {
                    serde_json::json!({
                        "id": surface.id,
                        "name": surface.name,
                        "primary": surface.is_primary(),
                        "open": open.iter().any(|id| id == &surface.id),
                        // "我这条调用是从哪个界面发出来的"。后台插件（`surface: None`）
                        // 拿到的全是 `false` —— 它没有界面，这是事实而不是缺省。
                        "current": current == Some(surface),
                    })
                })
                .collect();

            json_value(serde_json::json!(list))
        }

        _ => rpc_error(&format!("未知的 RPC 方法：{method}")),
    }
}

/// 显示一次浮层并把它转成 RPC 的结果。
///
/// 两个成员共用它：**配对、超时、错误翻译**这三件事只该有一份实现，
/// 而它们的差别只有请求里的 `kind`。
async fn ask_overlay<R: Runtime>(
    app: &AppHandle<R>,
    request: crate::modules::desktop::overlay::OverlayRequest,
) -> Result<Value, String> {
    let Some(state) = app.try_state::<crate::modules::desktop::overlay::Overlay>() else {
        return rpc_error("浮层尚未就绪");
    };

    // 浮层窗口是**具体运行时**上声明的那个（`tauri.conf.json`），
    // 而 `Overlay` 的方法本身是泛型的 —— 因此这里不需要任何转换。
    match state.ask(app, request).await {
        Ok(response) => json_value(serde_json::json!({
            "confirmed": response.confirmed,
            "selected": response.selected,
            "dismissed": response.dismissed,
        })),
        Err(message) => rpc_error(&message),
    }
}

/// 清单声明的右键菜单项在浮层里的 id 前缀。
///
/// 加前缀是因为它们的**执行方式**与临时条目完全不同：临时条目是这一次调用的
/// 结果（插件自己知道该怎么办），而声明条目要经由插件的命令机制。
/// 不加前缀的话两者会撞 id —— 撞上的表现是"点了这一条，执行的是插件自己那条"。
const DECLARED_PREFIX: &str = "declared:";

/// 宿主渲染的菜单里选中了一条**清单声明**的条目 → 执行它的命令。
///
/// ============================================================
/// 两条路径，因为插件有两种运行位置
/// ============================================================
///
/// * **sandboxed** —— 插件的代码在自己的文档里，宿主**不能**直接调它的函数。
///   因此只能把"有人点了这条命令"送进它的界面（走 `sandbox::deliver_command`
///   那条推送通道 —— 宿主 → 前端 → iframe，也是宿主 → 插件的唯一推送通道），
///   由桥接层交给 `Modulith.commands.on(id, handler)` 注册的处理器。
///
///   顺带解决了一件事：沙箱桥接层**没有** `registerCommand` 那种"交出函数"
///   的接口 —— 它是跨 realm 的，函数交不过去。命令在沙箱里因此必然是
///   **事件驱动**的，这与 `api: 3` 的整体形态一致。
///
/// * **in-process** —— 插件的代码就在宿主这个 realm 里，`runPluginCommand`
///   直接就能调。走一条 Tauri 事件交给前端（动作的真正实现在前端，
///   与 `shortcut.trigger` 同一条路子）。
async fn run_declared_menu<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: Option<&str>,
    menu_id: &str,
) -> Result<Value, String> {
    let (sandboxed, command) = {
        let manager = locked!(app);
        let menus = manager.context_menus(plugin_id).map_err(|e| e.to_string())?;
        let Some(menu) = menus.into_iter().find(|menu| menu.id == menu_id) else {
            return rpc_error(&format!("清单里没有右键菜单项 {menu_id}"));
        };
        let sandboxed = manager
            .sandbox_view(plugin_id)
            .map(|view| view.runtime.needs_own_webview())
            .unwrap_or(false);
        (sandboxed, menu.command)
    };

    if sandboxed {
        super::sandbox::deliver_command(app, plugin_id, &command, surface).await;
        return json_ok();
    }

    use tauri::Emitter;
    if let Err(error) = app.emit(
        PLUGIN_COMMAND,
        serde_json::json!({ "pluginId": plugin_id, "command": command }),
    ) {
        return rpc_error(&format!("无法把命令交给宿主界面：{error}"));
    }

    json_ok()
}

/// 宿主把一条**插件命令**交给 in-process 插件执行时广播的事件名。
///
/// 只服务 in-process 插件：沙箱插件的命令直接送进它的界面（见 `run_declared_menu`）。
pub const PLUGIN_COMMAND: &str = "modulith://plugin-command";

/// 沙箱插件里按下宿主快捷键时，宿主广播的事件名。
pub const SHORTCUT_TRIGGERED: &str = "modulith://plugin-shortcut";

// ============================================================
// 宿主渲染的状态指示：徽标 / 进度 / 启动占位
// ============================================================
//
// 三条走**同一条**广播与同一个事件名，只用一个 `kind` 字段区分。
// 为它们各开一个事件名的话，前端就要装三个监听、各写一遍校验 —— 而它们携带的
// 是同一类东西（一个插件想说的"我现在是这个状态"）。

/// 插件请求宿主更新它的状态指示（徽标 / 进度 / 启动占位）。
pub const PLUGIN_UI: &str = "modulith://plugin-ui";

/// 下载进度广播给**前端**时的事件名。
///
/// 沙箱插件那一条走"推脚本进它的 webview"（`sandbox::deliver_download_progress`），
/// 因为它的回调在另一个 realm 里。in-process 插件的回调就在宿主这个 realm ——
/// 前端接住这条事件，把它交给插件注册的处理函数。
pub const DOWNLOAD_PROGRESS: &str = "modulith://plugin-download-progress";

/// 徽标文本的长度上限。
///
/// 28 是侧边栏那一行的剩余宽度：再长它会把模块名挤掉，而"徽标把名字挤没了"
/// 比"徽标被截断"糟得多（前者让用户认不出那是哪个模块）。超长直接截断而不是
/// 报错 —— 徽标是一句提示，为它失败一次调用不合理。
const MAX_BADGE_CHARS: usize = 28;

/// 启动占位那句话的长度上限。比徽标宽：它是一整行说明，而不是一个角标。
const MAX_SPLASH_CHARS: usize = 120;

/// 徽标的语气。白名单而不是原样透出：它会被前端拼进 `className`。
fn badge_tone(args: &Value) -> &'static str {
    match arg_str(args, "tone") {
        Some("success") => "success",
        Some("warning") => "warning",
        Some("error") => "error",
        _ => "info",
    }
}

/// 启动占位的语气。没有 `success`：占位说的是"还没好"，而"好了"是用清除表达的。
fn splash_tone(args: &Value) -> &'static str {
    match arg_str(args, "tone") {
        Some("warning") => "warning",
        Some("error") => "error",
        _ => "info",
    }
}

/// 按字符（不是字节）截断。按字节截断会把一个多字节字符切成两半，而那个
/// 半截字符在 JSON 里就是一个乱码 —— 中文徽标会中招。
fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 广播一条界面状态。
fn emit_ui<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: Option<&str>,
    kind: &str,
    value: Value,
) -> Result<Value, String> {
    emit_ui_with(app, plugin_id, surface, kind, value, false)
}

/// 广播一条界面状态（带 `auto` 标记）。
///
/// `auto` 只对 `splash` 有意义：它说的是"这是桥接层在文档加载完之后自动发的，
/// 前端**只在占位还是自动那一条时**才该撤掉它"。
fn emit_ui_with<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    surface: Option<&str>,
    kind: &str,
    value: Value,
    auto: bool,
) -> Result<Value, String> {
    let Some(surface) = surface else {
        return rpc_error(&format!(
            "ui.{kind} 需要界面上下文 —— 后台插件没有标签栏，也没有可覆盖的一块位置。\
             请改用 ctx.notifications.notify 或宿主事件。"
        ));
    };

    use tauri::Emitter;
    if let Err(error) = app.emit(
        PLUGIN_UI,
        serde_json::json!({
            "pluginId": plugin_id,
            "surface": surface,
            "kind": kind,
            "value": value,
            "auto": auto,
        }),
    ) {
        return rpc_error(&format!("无法把 {kind} 交给宿主界面：{error}"));
    }

    json_ok()
}

/// 插件请求宿主打开一个界面（`ctx.ui.openSurface`）。
///
/// **方向是反的**：这条事件由插件发起、由前端消费。前端据此开一个标签，
/// 再由标签里的占位组件量出矩形并调 `sandbox_surface_open`。
/// 为什么必须绕这一圈：只有前端知道界面该放在哪（见 `dispatch` 里那一节）。
pub const OPEN_SURFACE: &str = "modulith://open-surface";

/// 插件请求宿主关闭一个界面（`ctx.ui.closeSurface`）。
pub const CLOSE_SURFACE: &str = "modulith://close-surface";

/// 把一条跨插件事件推给每一个还活着的**沙箱界面**。
///
/// 由各自的桥接层过滤"我订阅了没有" —— 见 `SandboxSurfaces::live` 上关于
/// 为什么不做订阅登记的说明。
///
/// 推给发起者自己吗？**不推。** 与 DOM 事件一致，而且更实际：一个插件给自己
/// 发事件时如果又收到自己那条，最直接的后果是"处理函数里再 emit 同一个名字"
/// 变成无限递归 —— 而递归发生在插件自己的界面里，宿主只会看到一片卡顿。
///
/// 排除的粒度是**插件**而不是界面：一个插件开了主列表与详情两块界面，它们属于
/// 同一次对话，互相收到自己刚发出去的事件同样会递归。
fn deliver_to_surfaces<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
    name: &str,
    payload: &Value,
) {
    let Some(surfaces) = app.try_state::<super::sandbox::SandboxSurfaces>() else {
        return;
    };

    // 直接把结构化数据交出去。从前这里要拼一段 `window.__modulithDeliver(JSON.parse(…))`
    // 的脚本，因而必须考虑"负载里含 `</script>` 或某些 Unicode 会不会拼坏源码"。
    // 走 `postMessage` 之后没有"拼"这一步 —— 传的是对象，不是代码。
    let envelope = serde_json::json!({ "source": source, "name": name, "payload": payload });

    for (token, key) in surfaces.live() {
        if key.plugin_id == source {
            continue;
        }
        super::sandbox::push_to(app, &token, "event", envelope.clone());
    }
}

/// 跨插件事件在 Tauri 那一层的事件名。
///
/// 与 `notifications` 的事件名同一个风格。前端 `pluginRuntime` 订阅它，
/// 再交给自己的事件总线 —— 总线的订阅者包括 in-process 插件与沙箱界面插件。
pub const PLUGIN_EVENT: &str = "modulith://plugin-event";

#[cfg(test)]
mod tests {
    use super::*;

    /// 参数里显式给了 \`null\` 与完全没给是**同一件事**。
    ///
    /// 这条测试的理由是一个几乎必然发生的手滑：前端 \`JSON.stringify({cursor: null})\`
    /// 会真的送出 \`null\`，而如果不把它折成"没给"，\`cursor\` 这条路径会以
    /// "缺少 cursor" 失败 —— 而调用方明明给了。
    #[test]
    fn an_explicit_null_is_the_same_as_absent() {
        let args = serde_json::json!({ "cursor": null, "rel": "", "prefix": "a" });

        assert_eq!(arg(&args, "cursor"), None);
        assert_eq!(arg_str(&args, "cursor"), None);
        // 空串**不是** null：它是"数据根"这个有意义的取值
        assert_eq!(arg_str(&args, "rel"), Some(""));
        assert_eq!(arg_str(&args, "prefix"), Some("a"));
    }

    /// 设置键前缀与前端那一份必须逐字一致。
    ///
    /// 不一致的表现是"用户在设置里改了值，插件读到的还是旧值" —— 两边各自的
    /// 代码看起来都是对的，因此这只能靠一条跨文件的断言来守。
    #[test]
    fn the_setting_key_prefix_matches_the_frontend() {
        assert_eq!(SETTING_KEY_PREFIX, "__host__.setting.");
        assert!(SETTING_KEY_PREFIX.ends_with('.'));
    }

    #[test]
    fn rpc_error_carries_the_message_verbatim() {
        let quota = "超出配额：档位 storage，上限 8388608，已用 8388000，本次 1024";
        assert_eq!(rpc_error(quota), Err(quota.to_string()));
    }

    #[test]
    fn parse_stored_skips_values_that_are_not_json() {
        assert_eq!(parse_stored("{\"a\":1}"), Some(serde_json::json!({ "a": 1 })));
        assert_eq!(parse_stored("不是 JSON"), None);
    }

    /// 截断必须**按字符**，不能按字节。
    ///
    /// 这是一个真的会发生的失败：一个中文徽标按字节截到第 28 个字节，正好切在
    /// 某个三字节字符的中间 —— 那个半截字符在 JSON 里就是乱码，而症状是
    /// "徽标末尾有几个方块"，离原因很远。
    #[test]
    fn truncation_counts_characters_not_bytes() {
        // 每个汉字 3 字节：按字节截 10 会切坏第 4 个字
        let long = "这是一段相当长的中文徽标文本内容用于测试截断";
        let cut = truncate(long, 10);

        assert_eq!(cut.chars().count(), 10, "截断之后应当是 10 个字符：{cut:?}");
        assert!(cut.ends_with('…'));
        // 没有出现替换字符（按字节切会产出它）
        assert!(!cut.contains('\u{FFFD}'), "截断切坏了一个字符：{cut:?}");

        // 短的**原样返回**，不加省略号
        assert_eq!(truncate("短", 10), "短");
        // 正好等长时也不加
        assert_eq!(truncate("12345", 5), "12345");
    }

    /// 语气是白名单：不认识的取值落到 `info`，而不是原样透出。
    ///
    /// 它会被前端拼进 `className`，因此"原样透出"等于把一段外部输入放进样式。
    #[test]
    fn tones_are_whitelisted() {
        for (input, expected) in [
            ("info", "info"),
            ("success", "success"),
            ("warning", "warning"),
            ("error", "error"),
            ("危险", "info"),
            ("", "info"),
        ] {
            let args = serde_json::json!({ "tone": input });
            assert_eq!(badge_tone(&args), expected, "badge_tone({input:?})");

            // 占位**没有** `success`：它说的是"还没好"，而"好了"是用清除表达的。
            let expected_splash = if input == "success" { "info" } else { expected };
            assert_eq!(splash_tone(&args), expected_splash, "splash_tone({input:?})");
        }

        // 缺字段时是 info
        assert_eq!(badge_tone(&serde_json::json!({})), "info");
        assert_eq!(splash_tone(&serde_json::json!({ "tone": null })), "info");
    }

    /// 长度上限必须**容得下**一句中文说明。
    ///
    /// 一个 8 个字符的上限会把这几种用法全部截成一句废话，而那种失败看起来像
    /// "宿主把插件的提示吃掉了"。
    #[test]
    fn the_length_limits_are_usable_for_chinese() {
        assert!(MAX_BADGE_CHARS >= 8, "徽标至少要放得下「12 条新消息」");
        assert!(MAX_SPLASH_CHARS > MAX_BADGE_CHARS, "占位是一整行说明，比徽标宽");
        assert_eq!(truncate("正在建立索引…", MAX_SPLASH_CHARS), "正在建立索引…");
    }
}
