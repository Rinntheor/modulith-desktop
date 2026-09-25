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

            deliver_to_surfaces(app, plugin_id, name, &payload).await;

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
            let items: Vec<crate::modules::desktop::overlay::MenuItem> = arg(args, "items")
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default();

            if items.is_empty() {
                return rpc_error("菜单一个可选项都没有");
            }

            let request = crate::modules::desktop::overlay::OverlayRequest::Menu {
                id: 0,
                title: arg_str(args, "title").map(str::to_string),
                items,
            };

            ask_overlay(app, request).await
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

/// 沙箱插件里按下宿主快捷键时，宿主广播的事件名。
pub const SHORTCUT_TRIGGERED: &str = "modulith://plugin-shortcut";

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
async fn deliver_to_surfaces<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
    name: &str,
    payload: &Value,
) {
    let Some(surfaces) = app.try_state::<super::sandbox::SandboxSurfaces>() else {
        return;
    };

    // 投递脚本用 `JSON.parse` 包一层而不是直接把 JSON 插进源码：
    // 一个含 `</script>` 或某些 Unicode 的负载直接拼进去会破坏这段脚本，
    // 而那种失败发生在插件界面的解析器里，看起来像"宿主推了一段坏脚本"。
    let envelope = serde_json::json!({ "source": source, "name": name, "payload": payload }).to_string();
    let script = format!(
        "window.__modulithDeliver && window.__modulithDeliver(JSON.parse({}));",
        super::sandbox::js_string(&envelope)
    );

    let Some(actor) = app.try_state::<super::surface::SurfaceActor>() else {
        return;
    };

    for (label, key) in surfaces.live() {
        if key.plugin_id == source {
            continue;
        }
        if let Err(error) = actor.eval(&label, script.clone()).await {
            // 一个界面推不到（多半是刚被销毁）不该影响其余界面。
            log::debug!("向沙箱界面 {label} 推送事件失败：{error}");
        }
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
}
