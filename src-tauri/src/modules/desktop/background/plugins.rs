// src-tauri/src/modules/desktop/background/plugins.rs
//
// 后台（无界面）插件的进程管理。
//
// ============================================================
// 一个插件一个进程
// ============================================================
//
// 不是"一个宿主进程里跑所有后台插件"，而是**每个后台插件各自一个 Node 子进程**。
//
// 理由与 webview 沙箱是同一条：**崩溃隔离**。一个后台插件写出死循环或吃掉几百
// 兆内存时，它只该弄死自己 —— 而共享一个进程意味着任何一个后台插件的失控都会
// 拖走其余全部后台插件，连带让宿主报出"后台功能不可用"。
//
// 代价是每个后台插件一个 Node 进程（数十 MB）。这与"空闲回收"是同一件事的
// 两个方向：**资源要么被隔离，要么被限制**。因此这里没有"多个插件共用一个
// 进程省内存"的选项 —— 那省下来的内存是用隔离换的。
//
// ============================================================
// 隔离到底由什么保证：**不是 vm**
// ============================================================
//
// 子进程里，插件代码跑在一个 `node:vm` 上下文里。那一层**不是安全边界** ——
// 一行 `globalThis.constructor.constructor('return process')()` 就能出去。
// 这是实测过的，不是推测（见 docs/06-项目/已知问题与技术债.md）。
//
// 真正兜住的是 **Node 自己的权限模型**：子进程用 `--permission` 启动，只放开
// **这个插件自己的代码目录**的读权限。实测在逃出 vm、拿到 `process` 与
// `node:fs` 之后：
//
//   · 读插件目录之外的文件     → ERR_ACCESS_DENIED
//   · 写任何地方               → ERR_ACCESS_DENIED
//   · `child_process`          → ERR_ACCESS_DENIED
//   · `worker_threads`         → ERR_ACCESS_DENIED
//   · 原生 addon               → ERR_ACCESS_DENIED
//   · **网络**                 → ERR_ACCESS_DENIED
//
// 也就是说：即便插件在 vm 那一层完全逃出去，它能做的也只有"读自己的代码"。
// 数据要经过宿主的 `ctx.*`，而那是权限模型管的。
//
// 有两个洞必须点出来，而不是留给读者去发现：
//
//   1. **`process.env` 在权限模型之下仍然可读**，因此子进程用 `env_clear`
//      启动（见 `HostSpec::clear_env`）。不这样做的话，一个逃出去的插件能把
//      宿主的环境变量整个读走。
//   2. `--permission` 需要较新的 Node（23+）。更老的运行时会**降级**成
//      没有这一层，而 `status` 会把 `isolated: false` 如实报出来 ——
//      界面据此提示用户升级运行时，而不是假装一切正常。
//
// ============================================================
// 还需要什么才能真正说"安全"
// ============================================================
//
// 这一层挡的是"插件碰它不该碰的东西"。它**不挡**的是：
//   · 这个进程自身被写坏（死循环、吃满内存）—— 那由进程边界与用户的杀进程解决；
//   · 蓄意逃逸之后在**自己那个进程内**为所欲为（改内存、改自己的行为）。
// 后者不需要被挡：那个进程里除了插件自己没有别人。
//
// OS 级隔离（Job Object / AppContainer）是另一层，本方案不做（见方案 §9）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{BackgroundHost, BackgroundMethod, HostSpec, Inbound};
use crate::modules::plugins::{rpc, PluginState};

/// Node 从哪个大版本开始有可用的权限模型。
///
/// 23 而不是 20：20~22 需要额外的 `--experimental-permission`，而一个只在
/// 特定小版本上生效的开关不值得写进这里 —— 版本不够就如实降级并报出来。
const PERMISSION_MODEL_MIN_MAJOR: u64 = 23;

/// 一个正在跑的后台插件。
struct Running {
    host: Arc<BackgroundHost>,
    started_at: Instant,
    /// 是否跑在引擎级权限之下。`false` = 这个 Node 太老，只降级到 vm 那一层。
    isolated: bool,
    /// 清单里声明订阅的事件名（`onPluginEvent:<名字>` 或裸名字）。
    ///
    /// 存在这里是**必须**的：宿主没法问子进程"你订阅了什么" ——
    /// `ctx.events.on` 是运行期行为，而宿主需要在不打扰插件的前提下决定
    /// 一条事件该送给谁。清单里的声明就是那个前提。
    subscribed_events: Vec<String>,
    /// 定时投递的任务。取消它 = 停止定时。
    ticker: Option<tokio::task::JoinHandle<()>>,
    /// 处理插件 `ctx.*` 调用的任务。
    inbound: tokio::task::JoinHandle<()>,
}

/// 后台插件的当前状态（给界面看的）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundPluginStatus {
    pub id: String,
    pub running: bool,
    pub pid: Option<u32>,
    /// 是否跑在引擎级权限之下。`false` 且 `running` = 降级运行。
    pub isolated: bool,
    pub uptime_ms: u64,
    /// 最近一次失败的原因
    pub reason: Option<String>,
}

/// 后台插件的托管状态。
///
/// `Mutex` 而不是 `RwLock`：这里的操作都是"拉起 / 停止 / 枚举"，没有一个场景
/// 是"多个读者并发持有很久"。而且拉起与停止本身要 await，临界区必须短 ——
/// 用它的人自然会去注意这一点。
#[derive(Default)]
pub struct BackgroundPlugins {
    running: Mutex<HashMap<String, Running>>,
    /// Node 是否支持权限模型。缓存 —— 它是"启动一次子进程问版本"，不该每次拉起都问。
    permission_model: Mutex<Option<bool>>,
}

impl BackgroundPlugins {
    pub fn new() -> Self {
        Self::default()
    }

    /// 拉一个后台插件起来。已经在跑时是**幂等**的。
    pub async fn start(&self, app: &AppHandle, plugin_id: &str) -> Result<(), String> {
        if self.running.lock().unwrap().contains_key(plugin_id) {
            return Ok(());
        }

        let launch = {
            let Some(state) = app.try_state::<PluginState>() else {
                return Err("插件系统尚未就绪".to_string());
            };
            let manager = state.0.read().await;
            manager
                .background_launch(plugin_id)
                .map_err(|error| error.to_string())?
        };

        let Some(launch) = launch else {
            return Err(format!("插件 {plugin_id} 没有声明后台入口"));
        };

        // 复用共享那个宿主解析出来的 Node 路径（它带着用户的设置与缓存）。
        // 另起一套查找会得到第二个真源，而两者的表现差异是"设置里指定了路径，
        // 界面插件能用、后台插件说找不到"。
        let (node, configured) = {
            let Some(shared) = app.try_state::<crate::modules::desktop::commands::BackgroundState>()
            else {
                return Err("后台宿主状态尚未就绪".to_string());
            };
            (
                shared.0.probe_node()?,
                shared.0.configured_node(),
            )
        };

        let isolated = self.permission_model_supported(&node).await;

        // ============================================================
        // 子进程的权限：只放开**这个插件自己的代码目录**
        // ============================================================
        //
        // 注意这里**没有**放开数据目录：插件的 `ctx.dataDir.*` 全部经过宿主的
        // `rpc::dispatch`，子进程根本不需要碰那些文件。少放开一个目录，
        // 逃出 vm 的插件就少一个能碰的地方。
        let mut node_args = Vec::new();
        if isolated {
            node_args.push("--permission".to_string());
            node_args.push(format!("--allow-fs-read={}", launch.root.display()));
        } else {
            log::warn!(
                "Node 版本低于 {PERMISSION_MODEL_MIN_MAJOR}，后台插件 {} 将在**没有引擎级\
                 文件系统权限**的情况下运行（只在 vm 那一层隔离）",
                launch.id
            );
        }

        let spec = HostSpec {
            node_args,
            env: vec![("MODULITH_BACKGROUND_PLUGIN".to_string(), launch.id.clone())],
            // 见文件头第 1 条洞：`process.env` 在权限模型之下仍然可读。
            clear_env: true,
        };

        let host = Arc::new(BackgroundHost::new());
        host.set_configured_node(&configured);
        host.set_spec(spec);

        let (sender, receiver) = tokio::sync::mpsc::channel::<Inbound>(64);
        host.set_inbound(sender);

        let inbound = tokio::spawn(handle_inbound(
            app.clone(),
            Arc::clone(&host),
            launch.id.clone(),
            receiver,
        ));

        let params = serde_json::json!({
            "id": launch.id,
            "entry": launch.entry,
            "name": launch.name,
            "version": launch.version,
            "permissions": launch.permissions,
            "manifest": launch.manifest,
            "activation": if launch.contribution.on_startup { "startup" } else { "event" },
        });

        let outcome = host
            .call(BackgroundMethod::PluginLoad, Some(params))
            .await;

        if !outcome.ok {
            let reason = outcome
                .error
                .unwrap_or_else(|| "后台插件加载失败".to_string());

            // 加载失败必须**把进程收掉**：留下一个跑着但什么都没加载的 Node
            // 进程，会让下一次 start 因为"已经在跑"而直接返回成功 ——
            // 而那个插件其实永远不会工作。这条路径实测踩到过。
            host.shutdown().await;
            inbound.abort();

            return Err(reason);
        }

        let ticker = launch.contribution.interval_secs.map(|secs| {
            let host = Arc::clone(&host);
            let id = launch.id.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(secs));
                // 第一次 tick 立刻返回 —— 跳过它，否则"每秒一次"的错觉会让
                // 刚启动的插件立刻收到一次 interval，而它多半还没准备好。
                tick.tick().await;
                loop {
                    tick.tick().await;
                    let outcome = host
                        .call(
                            BackgroundMethod::PluginDispatch,
                            Some(serde_json::json!({ "id": id, "type": "interval" })),
                        )
                        .await;
                    if !outcome.ok {
                        // 一次投递失败**不停止定时**：那可能只是这次请求超时。
                        // 真的死了的话，下一次会同样失败，而宿主那边的读循环
                        // 会在 stdout 关闭时察觉。
                        log::warn!(
                            "向后台插件 {id} 投递定时事件失败：{}",
                            outcome.error.unwrap_or_default()
                        );
                    }
                }
            })
        });

        let pid = host.status().pid;

        self.running.lock().unwrap().insert(
            launch.id.clone(),
            Running {
                host: Arc::clone(&host),
                started_at: Instant::now(),
                isolated,
                subscribed_events: launch.contribution.events.clone(),
                ticker,
                inbound,
            },
        );

        log::info!(
            "后台插件 {} 已启动：pid={:?} 隔离={} 定时={:?}秒",
            launch.id,
            pid,
            isolated,
            launch.contribution.interval_secs
        );

        // 启动即投递一次 `start`。放在登记**之后**：处理器里如果立刻调用
        // `ctx.*`，那条路径要能看到这个插件已经在跑。
        if launch.contribution.on_startup {
            let outcome = host
                .call(
                    BackgroundMethod::PluginDispatch,
                    Some(serde_json::json!({ "id": launch.id, "type": "start" })),
                )
                .await;
            if !outcome.ok {
                log::warn!(
                    "后台插件 {} 的 start 事件投递失败：{}",
                    launch.id,
                    outcome.error.unwrap_or_default()
                );
            }
        }

        Ok(())
    }

    /// 停一个后台插件。没在跑时是**幂等**的。
    pub async fn stop(&self, plugin_id: &str) -> Result<(), String> {
        let Some(mut running) = self.running.lock().unwrap().remove(plugin_id) else {
            return Ok(());
        };

        if let Some(ticker) = running.ticker.take() {
            ticker.abort();
        }

        // 先请它自己收尾（跑插件的清理函数、清掉定时器），再关进程。
        // 只强杀会让插件来不及保存状态 —— 而"关掉应用之后数据丢了"
        // 是用户最难联想到"是宿主没等它"的一类问题。
        let outcome = running
            .host
            .call(
                BackgroundMethod::PluginUnload,
                Some(serde_json::json!({ "id": plugin_id })),
            )
            .await;

        if !outcome.ok {
            log::warn!(
                "后台插件 {plugin_id} 的卸载没有正常完成：{}",
                outcome.error.unwrap_or_default()
            );
        }

        running.host.shutdown().await;
        running.inbound.abort();

        log::info!("后台插件 {plugin_id} 已停止");
        Ok(())
    }

    /// 停掉全部（应用退出时）。
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self
            .running
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();

        for id in ids {
            if let Err(error) = self.stop(&id).await {
                log::warn!("停止后台插件 {id} 失败：{error}");
            }
        }
    }

    /// 让"该跑的后台插件"跑起来：清单里写了 `onStartup` 的那些。
    ///
    /// 由前端在插件列表就绪之后调用一次。**不做成"启动时自动扫"**：那个时机上
    /// 插件注册表可能还没读完，于是"该起的没起"会变成一次随机失败。
    pub async fn sync_startup(&self, app: &AppHandle) -> Vec<BackgroundPluginStatus> {
        let candidates: Vec<String> = {
            let Some(state) = app.try_state::<PluginState>() else {
                return self.status(app);
            };
            let manager = state.0.read().await;
            manager
                .list()
                .into_iter()
                .map(|plugin| plugin.id)
                .collect()
        };

        for id in candidates {
            let should_start = {
                let Some(state) = app.try_state::<PluginState>() else {
                    break;
                };
                let manager = state.0.read().await;
                matches!(manager.background_launch(&id), Ok(Some(launch)) if launch.contribution.on_startup)
            };

            if !should_start {
                continue;
            }

            if let Err(error) = self.start(app, &id).await {
                // 一个后台插件起不来不该影响别的 —— 逐个独立，失败只记。
                log::warn!("后台插件 {id} 未能启动：{error}");
            }
        }

        self.status(app)
    }

    /// 当前状态。**不启动任何东西。**
    pub fn status(&self, _app: &AppHandle) -> Vec<BackgroundPluginStatus> {
        let running = self.running.lock().unwrap();

        let mut items: Vec<BackgroundPluginStatus> = running
            .iter()
            .map(|(id, entry)| {
                let status = entry.host.status();
                BackgroundPluginStatus {
                    id: id.clone(),
                    running: status.running,
                    pid: status.pid,
                    isolated: entry.isolated,
                    uptime_ms: entry.started_at.elapsed().as_millis() as u64,
                    reason: status.reason,
                }
            })
            .collect();

        items.sort_by(|a, b| a.id.cmp(&b.id));
        items
    }

    /// 某个后台插件在不在跑。
    pub fn is_running(&self, plugin_id: &str) -> bool {
        self.running.lock().unwrap().contains_key(plugin_id)
    }

    /// 把一条跨插件事件投递给**订阅了它**的后台插件。
    ///
    /// 由 `rpc::dispatch` 的 `events.emit` 分支调用 —— 也就是说宿主的一条事件
    /// 同时流向界面侧与后台侧，两边看到的 `{source, name, payload}` 完全一致。
    ///
    /// **不投给发起者自己**：与 DOM 事件一致。一个插件给自己发事件时如果又收到
    /// 自己那条，最直接的后果是"一个处理函数里再 emit 同一个名字"变成无限递归，
    /// 而那种栈溢出发生在一个子进程里，宿主只会看到"它突然不见了"。
    pub async fn dispatch_event(&self, source: &str, name: &str, payload: Value) {
        // 先把"该送给谁"算出来，然后**放掉锁**再 await —— 临界区里 await
        // 会让一个插件的投递卡住另一个插件的启动。
        let targets: Vec<(String, Arc<BackgroundHost>)> = {
            let running = self.running.lock().unwrap();
            running
                .iter()
                .filter(|(id, entry)| {
                    id.as_str() != source && subscribes_to(&entry.subscribed_events, name)
                })
                .map(|(id, entry)| (id.clone(), Arc::clone(&entry.host)))
                .collect()
        };

        for (id, host) in targets {
            let outcome = host
                .call(
                    BackgroundMethod::PluginDispatch,
                    Some(serde_json::json!({
                        "id": id,
                        "type": "event",
                        "name": name,
                        "payload": { "source": source, "payload": payload },
                    })),
                )
                .await;

            if !outcome.ok {
                log::debug!(
                    "向后台插件 {id} 投递事件 {name} 失败：{}",
                    outcome.error.unwrap_or_default()
                );
            }
        }
    }

    /// 这个 Node 支不支持引擎级权限模型。
    ///
    /// 结果被缓存：它要启动一次子进程问版本，而版本在一次运行里不会变。
    async fn permission_model_supported(&self, node: &Path) -> bool {
        if let Some(cached) = *self.permission_model.lock().unwrap() {
            return cached;
        }

        let supported = match tokio::process::Command::new(node)
            .arg("--version")
            .output()
            .await
        {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout);
                parse_major_version(&text).is_some_and(|major| major >= PERMISSION_MODEL_MIN_MAJOR)
            }
            Err(error) => {
                log::warn!("无法读取 Node 版本（{}）：{error}", node.display());
                false
            }
        };

        *self.permission_model.lock().unwrap() = Some(supported);
        supported
    }
}

/// 一个后台插件订阅了某条事件吗。
///
/// 两种写法都认：清单里的裸名字（`notes/changed`）与带前缀的
/// `onPluginEvent:notes/changed`。认两种而不是一种，是因为插件作者会两种都写 ——
/// 而"写了却收不到"在插件那一侧表现为"我的订阅没生效"，没有任何线索指向清单。
fn subscribes_to(declared: &[String], name: &str) -> bool {
    declared.iter().any(|entry| {
        let trimmed = entry.trim();
        trimmed == name
            || trimmed
                .strip_prefix("onPluginEvent:")
                .is_some_and(|rest| rest == name)
    })
}

/// 从 `v24.15.0` 这样的输出里取大版本号。
/// 单独抽成纯函数：一条"版本字符串长什么样"的解析写死在启动路径里，
/// 就只能靠"真的装一个 Node"去验证。
fn parse_major_version(text: &str) -> Option<u64> {
    let trimmed = text.trim();
    let without_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
    without_v.split('.').next()?.parse().ok()
}

/// 把子进程发来的 `ctx.*` 调用交给**共用的** ctx 实现，再把回答写回去。
///
/// 与沙箱界面插件走的是同一个 `rpc::dispatch` —— 也就是说"能不能做这件事"
/// 只有一处定义，两条路径的区别只在传输。
async fn handle_inbound(
    app: AppHandle,
    host: Arc<BackgroundHost>,
    plugin_id: String,
    mut receiver: tokio::sync::mpsc::Receiver<Inbound>,
) {
    while let Some(request) = receiver.recv().await {
        // 子进程发的是 `ctx.storage.get`，而共用的方法表里叫 `storage.get`。
        // 前缀是 Node 那一侧为了读起来像 `ctx.x` 而加的，属于**传输**的一部分。
        let method = request
            .method
            .strip_prefix("ctx.")
            .unwrap_or(&request.method)
            .to_string();

        let args = request.params.unwrap_or(Value::Null);
        let result = rpc::dispatch(&app, &plugin_id, &method, &args).await;

        if let Err(message) = &result {
            log::debug!("后台插件 {plugin_id} 的 ctx.{method} 被拒绝：{message}");
        }

        host.respond(request.id, result).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 版本解析必须**只**认可它认识的形状。
    ///
    /// 这条测试的理由是"猜一个版本号比没有版本号更危险"：如果 `parse` 在拿不到
    /// 数字时返回 `0`，那么一个输出被本地化或加了前缀的 Node 会让 `isolated`
    /// 悄悄变成 `false`（安全降级），而没有任何一处会说出来。
    #[test]
    fn node_versions_are_parsed_strictly() {
        assert_eq!(parse_major_version("v24.15.0"), Some(24));
        assert_eq!(parse_major_version("v22.0.0\n"), Some(22));
        assert_eq!(parse_major_version("24.1.0"), Some(24));
        assert_eq!(parse_major_version("v9.11.2"), Some(9));

        assert_eq!(parse_major_version(""), None);
        assert_eq!(parse_major_version("node v24.0.0"), None);
        assert_eq!(parse_major_version("vabc.1.2"), None);
    }

    /// 版本门槛的方向：**不够就降级，而不是当成够**。
    ///
    /// 反过来写（"未知即支持"）会让一台装了 Node 18 的机器上，宿主告诉用户
    /// "隔离已开启" —— 而那一层根本不存在。
    #[test]
    fn a_version_below_the_threshold_is_not_isolated() {
        let threshold = PERMISSION_MODEL_MIN_MAJOR;
        for (version, expected) in [
            ("v24.15.0", true),
            ("v23.0.0", true),
            ("v22.9.0", false),
            ("v18.20.0", false),
            ("not-a-version", false),
        ] {
            assert_eq!(
                parse_major_version(version).is_some_and(|major| major >= threshold),
                expected,
                "{version} 的隔离判定不对"
            );
        }
    }

    /// 默认状态下什么都没在跑，而且 `status` **不会**拉起任何东西。
    #[test]
    fn a_fresh_registry_runs_nothing() {
        let plugins = BackgroundPlugins::new();
        assert!(!plugins.is_running("anything"));
        assert!(plugins.running.lock().unwrap().is_empty());
        assert!(plugins.permission_model.lock().unwrap().is_none());
    }
}
