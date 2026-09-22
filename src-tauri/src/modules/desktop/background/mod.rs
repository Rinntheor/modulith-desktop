// src-tauri/src/modules/desktop/background/mod.rs
//
// 后台宿主的进程管理：拉起、通信、收尾。
//
// ============================================================
// 为什么是"按需拉起 + 空闲回收"而不是常驻
// ============================================================
//
// 这个模块存在的理由是"让能力脱离窗口存活"，而它自己要付的代价是**一个额外的
// 进程**。如果它无条件常驻，那这笔开销会加到每一个用户身上 —— 包括那些从不用
// 后台功能的用户。而我们正在做的整件事就是降低内存占用，不能一边省一边加。
//
// 因此：
//   · **按需拉起**：第一次真的要用后台能力时才启动子进程；
//   · **空闲回收**：连续一段时间没有请求就把它关掉。
//
// 回收的判据是"有没有在飞的请求 + 距离最后一次请求多久"，而不是"界面是否可见" ——
// 后台能力恰恰要在界面不可见时工作，拿可见性当判据会把功能关掉。
//
// ============================================================
// 启动失败为什么必须是一个可读的状态，而不是错误
// ============================================================
//
// Node 运行时是**随包分发的文件**，而它可能缺失（打包遗漏、用户手工删掉、
// 杀毒软件隔离）。这种情况下后台能力应当**明确不可用**并说清原因，
// 而不是每次调用都抛一个异常、把插件代码拖进一堆无意义的错误处理。
//
// 因此这里有一个 `BackgroundStatus`：可用 / 不可用 + 原因。
// 界面据此显示"后台功能需要 Node 运行时，当前未找到"，
// 而不是让用户看到一串 invoke 失败。

pub mod protocol;
pub mod schedules;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::oneshot;

use crate::prelude::*;

pub use protocol::{BackgroundMethod, ProtocolError, PROTOCOL_VERSION};

/// 连续多久没有请求就回收子进程。
///
/// 5 分钟：比任何合理的"用户离开一会儿"都长，又短到不会让一个忘了关的后台进程
/// 挂一整晚。它只在"已经拉起过"之后才有意义 —— 没拉起来的话这个数字没有作用。
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// 单次启动握手（读取问候行）的超时。
///
/// 比普通请求短：这一行是脚本第一件事就会打印的，而启动阶段卡住通常意味着
/// Node 根本没能跑起来（例如被杀毒软件隔离）。让用户等 10 秒才看到"启动失败"
/// 没有意义。
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);

/// 后台宿主的可用状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    /// 当前是否可用（Node 运行时找得到、且上次启动没失败）
    pub available: bool,
    /// 子进程当前是否活着
    pub running: bool,
    /// 不可用或上次失败的原因。可用且没出错时为 `None`
    pub reason: Option<String>,
    /// 找到的 Node 可执行文件路径（可能为空）
    pub node_path: Option<String>,
    /// 子进程 pid（未运行时为空）
    pub pid: Option<u32>,
    /// 已发送过的请求数（本次运行累计，用于排查"到底有没有被用过"）
    pub requests: u64,
}

/// 一次调用的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallOutcome {
    /// 方法是否成功（通道正常且子进程没报错）
    pub ok: bool,
    /// 成功时的结果
    pub result: Option<serde_json::Value>,
    /// 失败原因（通道故障或业务失败都在这里）
    pub error: Option<String>,
}

/// 等待响应的请求：id -> 回收结果的通道。
///
/// **刻意不放在 `State` 里**，而是独立成一个 `Arc<Mutex<..>>` 被宿主与读任务共享：
/// 读任务是独立的 async 任务，它需要在调用方持有 `State` 锁的时候也能把响应
/// 递给等待者。两者共用一个锁的话，读任务必须等调用方的锁 ——
/// 而调用方正在等读任务递来的响应，直接死锁。
type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<protocol::Response>>>>;

/// 出站事件的处理函数。
///
/// 读任务在解析到一条事件时调用它。**它跑在读任务里**，因此必须是"发完就走"的
/// 性质：阻塞读循环会让所有请求的响应都跟着被推迟。
type EventHandler = Arc<dyn Fn(protocol::Event) + Send + Sync>;

/// 子进程的运行时状态
struct State {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// 上一次有请求的时刻，用于空闲回收
    last_used: Instant,
    /// 最近一次失败的原因（成功一次后清空）
    last_error: Option<String>,
    /// 累计请求数
    requests: u64,
}

/// 后台宿主
///
/// 用 `Mutex` 而不是 `RwLock`：这里没有"多读"的场景，而拉起/回收/发请求
/// 都要改状态。一个更简单的锁比一个分类更细的锁更不容易写错。
pub struct BackgroundHost {
    state: Mutex<State>,
    pending: PendingMap,
    next_id: AtomicU64,
    /// Node 可执行文件的解析结果。`None` 表示"还没找过"，`Some(Err)` 表示找过但失败
    node: Mutex<Option<Result<PathBuf, String>>>,
    /// 出站事件的去向。由应用侧用 `set_event_handler` 装上。
    ///
    /// 装之前收到的事件只记日志 —— 不静默丢弃，但也不假装处理过。
    event_handler: Mutex<Option<EventHandler>>,
    /// 每次**新**拉起子进程之后要推送的定时任务定义。
    ///
    /// 放在这里而不是"启动后由调用方记得推送"：后者要求每一个会拉起子进程的
    /// 调用点都记得这件事，而漏掉任意一处的表现都是"定时提醒在子进程重启之后
    /// 再也不响了"—— 一个既难复现、又难联想到根因的故障。
    schedules: Mutex<Vec<serde_json::Value>>,
}

impl BackgroundHost {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                child: None,
                stdin: None,
                last_used: Instant::now(),
                last_error: None,
                requests: 0,
            }),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            node: Mutex::new(None),
            event_handler: Mutex::new(None),
            schedules: Mutex::new(Vec::new()),
        }
    }

    /// 装上出站事件的处理函数（通常由模块的 setup 调用一次）。
    ///
    /// 覆盖式安装：重复调用以后一次为准。测试与将来的"换一个分发目标"都需要它。
    pub fn set_event_handler(&self, handler: EventHandler) {
        *self.event_handler.lock().unwrap() = Some(handler);
    }

    /// 记下定时任务定义，并在子进程正在运行时立刻推送过去。
    ///
    /// 返回推送结果：`None` 表示"当前没有子进程，等它下次被拉起时自动推送"。
    /// 这不是失败 —— 定时任务在进程重启后由 `ensure_started` 自动补上。
    pub async fn set_schedules(&self, schedules: Vec<serde_json::Value>) -> Option<CallOutcome> {
        *self.schedules.lock().unwrap() = schedules.clone();

        let running = self.state.lock().unwrap().child.is_some();
        if !running {
            return None;
        }

        Some(
            self.call(
                BackgroundMethod::ScheduleSync,
                Some(serde_json::json!({ "schedules": schedules })),
            )
            .await,
        )
    }

    /// 当前记下的定时任务定义条数（不含子进程侧的运行状态）
    pub fn schedule_count(&self) -> usize {
        self.schedules.lock().unwrap().len()
    }

    /// 读回子进程侧当前的定时任务运行状态（下一次什么时候响、响过几次）。
    ///
    /// **不启动子进程**：查一眼列表不该拉起一个 Node 进程。没在跑就返回
    /// 一个带 `reason` 的结果，由界面如实显示"后台未运行"。
    pub async fn list_schedules(&self) -> CallOutcome {
        if !self.status().running {
            return CallOutcome {
                ok: false,
                result: None,
                error: Some("后台宿主当前未运行，没有正在计时的定时任务".to_string()),
            };
        }
        self.call(BackgroundMethod::ScheduleList, None).await
    }

    /// 立刻触发一次某个定时任务（"现在试一下"）
    pub async fn run_schedule_now(&self, id: &str) -> CallOutcome {
        self.call(
            BackgroundMethod::ScheduleRunNow,
            Some(serde_json::json!({ "id": id })),
        )
        .await
    }


    /// 当前状态（不启动任何东西）
    pub fn status(&self) -> BackgroundStatus {
        let state = self.state.lock().unwrap();
        let node = self.node.lock().unwrap().clone();

        let node_path = match &node {
            Some(Ok(path)) => Some(path.display().to_string()),
            _ => None,
        };
        let reason = match &node {
            Some(Err(reason)) => Some(reason.clone()),
            _ => state.last_error.clone(),
        };

        BackgroundStatus {
            available: node.as_ref().is_some_and(|n| n.is_ok()) && state.child.is_some(),
            running: state.child.is_some(),
            reason,
            node_path,
            pid: state.child.as_ref().and_then(|child| child.id()),
            requests: state.requests,
        }
    }

    /// 探测 Node 运行时是否可用（幂等，结果被记住）
    ///
    /// 结果被记住是必要的：这个探测要访问文件系统，而它会被状态查询反复调用。
    pub fn probe_node(&self) -> Result<PathBuf, String> {
        let mut cached = self.node.lock().unwrap();
        if let Some(result) = cached.as_ref() {
            return result.clone();
        }

        let result = resolve_node();
        *cached = Some(result.clone());
        result
    }

    /// 让状态查询也能填上 Node 路径（不启动子进程）
    pub fn describe(&self) -> BackgroundStatus {
        let _ = self.probe_node();
        self.status()
    }

    /// 调用后台侧的一个方法。
    ///
    /// 会按需拉起子进程。失败**不重试** —— 重试一个可能已经在执行的方法会带来
    /// 重复副作用（例如提醒响了两次），而"没响"与"响两次"之间，后者更难解释。
    pub async fn call(
        &self,
        method: BackgroundMethod,
        params: Option<serde_json::Value>,
    ) -> CallOutcome {
        let node = match self.probe_node() {
            Ok(path) => path,
            Err(reason) => {
                return CallOutcome {
                    ok: false,
                    result: None,
                    error: Some(reason),
                }
            }
        };

        // 先记下"这次调用之前子进程是否已经在跑"，因为 `ensure_started` 会改变它，
        // 而"是不是这一次启动的"决定了要不要推送定时任务。
        let was_running = self.state.lock().unwrap().child.is_some();

        if let Err(error) = self.ensure_started(&node, !was_running).await {
            return CallOutcome {
                ok: false,
                result: None,
                error: Some(error),
            };
        }

        self.send(method, params).await
    }

    /// 把一条请求写到子进程并等它的响应。**不负责拉起子进程。**
    ///
    /// 与 `call` 分开的理由是**再入**：`ensure_started` 在新拉起子进程之后要同步
    /// 定时任务，而同步本身就是一次请求。若它调 `call`，`call` 又会走到
    /// `ensure_started` —— 编译器看到的是一条无限递归的 async 函数，
    /// 而它即使被削掉，语义上也仍然是错的分层：启动流程不该重入启动流程。
    ///
    /// 子进程没在跑时立刻失败，而不是这里再启动一次 —— 那正是 `call` 的职责。
    async fn send(
        &self,
        method: BackgroundMethod,
        params: Option<serde_json::Value>,
    ) -> CallOutcome {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = protocol::Request {
            v: PROTOCOL_VERSION,
            id,
            method: method.as_wire().to_string(),
            params,
        };

        let line = match protocol::encode_request(&request) {
            Ok(line) => line,
            Err(error) => {
                return CallOutcome {
                    ok: false,
                    result: None,
                    error: Some(error.to_string()),
                }
            }
        };

        let (sender, receiver) = oneshot::channel();

        // ============================================================
        // 关于这一段的锁：**不允许跨 await 持有 `MutexGuard`**
        // ============================================================
        //
        // `std::sync::MutexGuard` 不是 `Send`，而 Tauri 命令的 future 必须是。
        // 因此这里把写入端**从状态里取出来**（`Option::take`），在锁之外完成
        // 异步写入，再放回去。
        //
        // 这与"只能有一个在飞的请求"是兼容的：取出期间其它调用会看到 `None`
        // 并立刻返回"后台宿主未在运行" —— 而实际上更早的那次调用会把它放回去。
        // 为了不给这个窗口留下真实的错误，取出失败时**不放请求进待处理表**：
        // 一条永远等不到响应的请求比一次立刻失败更糟。
        let mut stdin = {
            let mut state = self.state.lock().unwrap();
            state.requests += 1;
            state.last_used = Instant::now();
            state.stdin.take()
        };

        let Some(stdin_ref) = stdin.as_mut() else {
            return CallOutcome {
                ok: false,
                result: None,
                error: Some("后台宿主未在运行".to_string()),
            };
        };

        // 放进待处理表**必须早于**写入：子进程可能回得比我们走完这一步更快，
        // 而那时读任务会找不到等待者、把响应丢掉。
        self.pending.lock().unwrap().insert(id, sender);

        let write_result = async {
            stdin_ref.write_all(line.as_bytes()).await?;
            stdin_ref.flush().await
        }
        .await;

        // 把写入端放回去（无论写入成功与否 —— 它仍然是我们唯一的写入端）
        self.state.lock().unwrap().stdin = stdin;

        if let Err(error) = write_result {
            // 写失败意味着管道断了（子进程死了）。把请求清掉，
            // 避免它一直挂在那里等一个永远不会来的响应。
            self.pending.lock().unwrap().remove(&id);
            return CallOutcome {
                ok: false,
                result: None,
                error: Some(format!("写入后台宿主失败：{error}")),
            };
        }

        match tokio::time::timeout(Duration::from_millis(protocol::REQUEST_TIMEOUT_MS), receiver).await {
            Ok(Ok(response)) => match response.validate() {
                Ok(()) => {
                    let mut state = self.state.lock().unwrap();
                    state.last_error = None;
                    CallOutcome {
                        ok: response.error.is_none(),
                        result: response.result,
                        error: response.error,
                    }
                }
                Err(error) => CallOutcome {
                    ok: false,
                    result: None,
                    error: Some(error.to_string()),
                },
            },
            Ok(Err(_)) => CallOutcome {
                ok: false,
                result: None,
                error: Some("后台宿主在响应之前消失了".to_string()),
            },
            Err(_) => {
                // 超时：把待处理项清掉。**不重试**，理由见方法上的说明。
                self.pending.lock().unwrap().remove(&id);
                CallOutcome {
                    ok: false,
                    result: None,
                    error: Some(format!(
                        "后台宿主在 {} 毫秒内没有响应",
                        protocol::REQUEST_TIMEOUT_MS
                    )),
                }
            }
        }
    }

    /// 确保子进程在运行。
    ///
    /// `push_schedules` 只在**这一次真的启动了子进程**时为真。这个参数存在的
    /// 理由是一个再入问题：同步定时任务本身就是一次 `call`，而 `call` 又会走到
    /// 这里；若这里无条件同步，就会变成"同步 → 同步 → …"的无限递归。
    /// 由调用方判断"是不是我启动的"，比在这里再取一次锁要清楚得多。
    async fn ensure_started(&self, node: &PathBuf, push_schedules: bool) -> Result<(), String> {
        {
            let state = self.state.lock().unwrap();
            if state.child.is_some() {
                return Ok(());
            }
        }

        let script = host_script_path()?;

        let mut command = tokio::process::Command::new(node);
        command
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr 继承：子进程的崩溃与 `console.error` 会直接进应用日志，
            // 而不是被吞掉。这条通道只有 stdout 是协议专用的。
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动后台宿主（{node:?}）：{error}"))?;

        let stdin = child.stdin.take().ok_or_else(|| "无法取得子进程的标准输入".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法取得子进程的标准输出".to_string())?;

        let mut reader = BufReader::new(stdout);

        // 第一条消息必须是问候。**先读它再投入使用**，这样协议版本错配会在
        // 启动的那一刻暴露，而不是在某个具体调用上以一个奇怪的字段缺失暴露。
        let mut greeting = String::new();
        match tokio::time::timeout(
            STARTUP_TIMEOUT,
            reader.read_line(&mut greeting),
        )
        .await
        {
            Ok(Ok(0)) => {
                // 读到 EOF：子进程立刻退出了。把它的退出码带上，
                // 那通常是唯一的线索（例如 Node 报"找不到脚本"）。
                let code = child.try_wait().ok().flatten().and_then(|s| s.code());
                return Err(format!(
                    "后台宿主启动后立即退出（退出码 {}）。请检查 Node 运行时与宿主脚本是否完整。",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "未知".to_string())
                ));
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return Err(format!("读取后台宿主问候失败：{error}")),
            Err(_) => {
                let _ = child.kill().await;
                return Err(format!(
                    "后台宿主在 {} 秒内没有发来问候",
                    STARTUP_TIMEOUT.as_secs()
                ));
            }
        }

        let greeting = greeting.trim().to_string();
        let parsed: serde_json::Value = serde_json::from_str(&greeting)
            .map_err(|error| format!("后台宿主的问候不是合法 JSON（{error}）：{greeting}"))?;

        let version = parsed.get("v").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        if version != PROTOCOL_VERSION {
            let _ = child.kill().await;
            return Err(format!(
                "后台宿主协议版本不匹配：期望 {PROTOCOL_VERSION}，实际 {version}。\
                 后台功能已停用（宿主脚本与应用的版本必须一致）。"
            ));
        }

        {
            let mut state = self.state.lock().unwrap();
            state.child = Some(child);
            state.stdin = Some(stdin);
            state.last_error = None;
        }

        self.spawn_reader(reader);
        log::info!("后台宿主已启动：pid={:?}", self.status().pid);

        // 子进程是**无状态**的：定时任务的定义存在应用侧，每次新拉起之后都要
        // 重新推送一遍。放在 `ensure_started` 内部（唯一会拉起子进程的地方）
        // 而不是让调用方记得做：漏掉的表现是"子进程重启之后提醒再也不响了"。
        //
        // 失败只记警告：定时任务推不过去不该让"拉起子进程"这件事被判定为失败，
        // 否则一次同步故障会连带把其它后台能力一起关掉。
        if push_schedules {
            let schedules = self.schedules.lock().unwrap().clone();
            if !schedules.is_empty() {
                // 用 `send` 而不是 `call`：见 `send` 上的说明（再入）。
                let outcome = self
                    .send(
                        BackgroundMethod::ScheduleSync,
                        Some(serde_json::json!({ "schedules": schedules })),
                    )
                    .await;
                if !outcome.ok {
                    log::warn!(
                        "向后台宿主推送定时任务失败（子进程照常可用）：{:?}",
                        outcome.error
                    );
                }
            }
        }

        Ok(())
    }

    /// 起一个读任务，把子进程的每一行分派给对应的等待者或事件处理器
    ///
    /// 这是一个 **async 任务**而不是"读线程"：它只做 `read_line` 与一次查表，
    /// 全程没有阻塞式系统调用，因此不需要独占一个线程。
    fn spawn_reader(&self, mut reader: BufReader<ChildStdout>) {
        let pending = Arc::clone(&self.pending);
        let handler = self.event_handler.lock().unwrap().clone();

        tokio::spawn(async move {
            let mut line = String::new();

            loop {
                line.clear();

                match reader.read_line(&mut line).await {
                    // EOF：子进程结束了。它可能在崩溃，也可能是被回收了。
                    Ok(0) => {
                        log::debug!("后台宿主的标准输出已关闭");
                        break;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        log::warn!("读取后台宿主输出失败：{error}");
                        break;
                    }
                }

                let frame = match protocol::decode_frame(&line) {
                    Ok(frame) => frame,
                    Err(error) => {
                        // 一行解析不了**不终止**读循环：对面可能只是写了一条垃圾，
                        // 而它之后的消息仍然是好的。终止会让一次格式错误变成
                        // "整个后台功能永久失效"。
                        log::warn!("后台宿主返回了无法解析的一行：{error}");
                        continue;
                    }
                };

                match frame {
                    protocol::Frame::Response(response) => {
                        let waiter = pending.lock().unwrap().remove(&response.id);
                        match waiter {
                            Some(sender) => {
                                // 接收方可能已经因为超时走掉了；那不是错误。
                                let _ = sender.send(response);
                            }
                            None => {
                                // 没有等待者：要么是超时之后的迟到响应，要么是对面
                                // 自己发了一条我们没有请求过的响应。如实记下来。
                                log::debug!("收到没有等待者的后台响应（id {}）", response.id);
                            }
                        }
                    }

                    protocol::Frame::Event(event) => {
                        // 版本错配的事件**不处理**：字段语义可能已经变了，
                        // 按旧语义解释它可能得出错误结论（例如把"已取消"读成"已触发"）。
                        if let Err(error) = event.validate() {
                            log::warn!("后台宿主发来一条不可用的事件：{error}");
                            continue;
                        }

                        match handler.as_ref() {
                            Some(handler) => {
                                let name = event.event.clone();
                                // 记一行日志再交给处理函数：事件处理函数自己出错时，
                                // 这行日志是唯一能证明"事件确实到过这里"的证据。
                                log::debug!("后台事件：{name}（主体 {}）", event.subject);
                                handler(event);
                            }
                            None => {
                                // 没装处理器时只记日志。**不静默丢弃** ——
                                // "事件发了但没人接"是需要被发现的一件事。
                                log::warn!(
                                    "收到后台事件「{}」但没有任何处理函数，已忽略",
                                    event.event
                                );
                            }
                        }
                    }
                }
            }

            // 读循环结束 = 子进程不再可用。把全部等待者放掉，
            // 让它们立刻失败，而不是各自等到 10 秒超时。
            let drained: Vec<_> = pending.lock().unwrap().drain().collect();
            if !drained.is_empty() {
                log::warn!("后台宿主退出，{} 个待处理请求被中断", drained.len());
            }
        });
    }

    /// 空闲回收：连续一段时间没有被使用就关掉子进程。
    ///
    /// 由模块的 `start` 起一个低频定时器调用。判据是"距离最后一次请求多久"，
    /// 而**不是**"界面是否可见" —— 后台能力恰恰要在界面不可见时工作，
    /// 拿可见性当判据会把功能关掉。
    ///
    /// 有请求在飞时**不回收**：那会让调用方等一个永远不会来的响应。
    /// 这种情况下把计时重置，下一轮再说。
    pub async fn reap_if_idle(&self) -> bool {
        let should_reap = {
            let state = self.state.lock().unwrap();
            if state.child.is_none() {
                return false;
            }
            if !self.pending.lock().unwrap().is_empty() {
                return false;
            }
            state.last_used.elapsed() >= IDLE_TIMEOUT
        };

        if !should_reap {
            return false;
        }

        log::info!(
            "后台宿主已空闲 {} 秒，回收子进程",
            IDLE_TIMEOUT.as_secs()
        );
        self.shutdown().await;
        true
    }

    /// 调一次存活探测。给"设置里点一下试试"用，也是唯一一个**不会**因为
    /// 缺 Node 而无声失败的入口 —— 它把原因原样返回给界面。
    pub async fn ping(&self) -> CallOutcome {
        self.call(BackgroundMethod::Ping, None).await
    }

    /// 关掉子进程（幂等）
    ///
    /// 先发一条 `shutdown` 让它自己收尾，再强制结束。**两步都要**：
    /// 只强制结束会让子进程来不及落盘与清理定时器，而只等待它自己退出
    /// 则可能永远等下去（脚本里有死循环时）。
    pub async fn shutdown(&self) {
        let (mut child, stdin) = {
            let mut state = self.state.lock().unwrap();
            (state.child.take(), state.stdin.take())
        };

        // 任何还在等待的请求都不可能再有响应了
        let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
        if !drained.is_empty() {
            log::warn!("后台宿主被关闭，{} 个待处理请求被中断", drained.len());
        }

        let Some(mut child) = child.take() else {
            return;
        };

        // 优雅请求：给它一点时间自己退出
        if let Some(mut stdin) = stdin {
            let request = protocol::Request {
                v: PROTOCOL_VERSION,
                id: self.next_id.fetch_add(1, Ordering::SeqCst),
                method: BackgroundMethod::Shutdown.as_wire().to_string(),
                params: None,
            };
            if let Ok(line) = protocol::encode_request(&request) {
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.flush().await;
            }
            drop(stdin);
        }

        // 等它自己走；超时就强制结束
        match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                log::warn!("后台宿主没有在 3 秒内自行退出，强制结束");
                let _ = child.kill().await;
            }
        }
    }
}

impl Default for BackgroundHost {
    fn default() -> Self {
        Self::new()
    }
}

/// 解析 Node 可执行文件。
///
/// 查找顺序刻意是"**明确的配置优先，猜测最后**"：
///   1. 环境变量 `MODULITH_NODE`（开发与排障用，也能让用户手工指定）；
///   2. 可执行文件旁边的 `runtime/node.exe`（打包分发时随包带上）；
///   3. 系统 PATH 上的 `node`。
///
/// 第 3 条放最后：系统上的 Node 版本不受我们控制，而协议版本是按我们分发的那份
/// 定的。能用它跑起来是运气，不能当成设计。
fn resolve_node() -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("MODULITH_NODE") {
        let path = PathBuf::from(&explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "环境变量 MODULITH_NODE 指向的文件不存在：{explicit}"
        ));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("runtime").join(node_file_name());
            if bundled.is_file() {
                return Ok(bundled);
            }
        }
    }

    Err(
        "未找到 Node 运行时。后台功能需要它：请把 Node 放在应用目录的 runtime/ 下，\
         或设置环境变量 MODULITH_NODE 指向它。"
            .to_string(),
    )
}

fn node_file_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// 宿主脚本（`background-host.mjs`）的位置。
///
/// 与 Node 一样走"配置优先、其次随包分发"的查找策略，理由相同：
/// 开发期不可能每次都重新打包资源。
fn host_script_path() -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("MODULITH_BACKGROUND_HOST") {
        let path = PathBuf::from(&explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "环境变量 MODULITH_BACKGROUND_HOST 指向的文件不存在：{explicit}"
        ));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in ["background-host.mjs", "resources/background-host.mjs"] {
                let path = dir.join(candidate);
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
    }

    Err(
        "未找到后台宿主脚本 background-host.mjs。它应当随应用一起分发。".to_string(),
    )
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// 改动进程级环境变量（`MODULITH_NODE` / `MODULITH_BACKGROUND_HOST`）会与
    /// 其它测试互相影响，因此这一组测试串行执行。
    ///
    /// 用一把测试专用的锁而不是假设 `--test-threads=1`：那个参数是**调用方**的
    /// 选择，而一条依赖调用方参数的测试会在别人机器上随机失败。
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// 找一个可用的 Node。找不到就跳过整组测试。
    ///
    /// **不判失败**：这个仓库不应当假设开发机装了 Node（后台功能是可选能力，
    /// 缺它时应用照常可用）。但找到时必须真的跑 —— 那才是有价值的证据。
    fn find_node() -> Option<PathBuf> {
        if let Ok(explicit) = std::env::var("MODULITH_NODE") {
            let path = PathBuf::from(explicit);
            if path.is_file() {
                return Some(path);
            }
        }

        // 测试进程的 PATH 上找一遍。这不是运行时该走的路（运行时优先用随包分发的
        // 那份），但测试环境里它是最省事的一条。
        if let Ok(paths) = std::env::var("PATH") {
            for dir in std::env::split_paths(&paths) {
                let candidate = dir.join(node_file_name());
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        // PATH 上可能只有一个 `.cmd` 包装（Node 版本管理器、Electron 的
        // `ELECTRON_RUN_AS_NODE` 就都是这样），而 `Command::new` 能跑它、
        // 只是我们这里需要一个真实文件路径。这几条是常见的落点。
        let mut candidates: Vec<PathBuf> = Vec::new();
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA"] {
            if let Ok(base) = std::env::var(key) {
                candidates.push(PathBuf::from(&base).join("nodejs").join(node_file_name()));
                candidates.push(
                    PathBuf::from(&base)
                        .join("Programs")
                        .join("nodejs")
                        .join(node_file_name()),
                );
            }
        }
        candidates.into_iter().find(|path| path.is_file())
    }

    fn host_script() -> PathBuf {
        // 相对 `CARGO_MANIFEST_DIR`，与 `src-tauri/resources/background-host.mjs` 对应
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("background-host.mjs")
    }

    /// **正向证据：真的拉起 Node、真的走完一次请求-响应。**
    ///
    /// 协议本身（编码、校验、畸形响应拒绝）由 `protocol` 的单元测试守着，
    /// 而 Node 脚本本身可以用管道单独跑。这条测试查的是它们**接在一起**能不能用 ——
    /// 也就是这一整个模块最核心的断言：`BackgroundHost` 能把一条请求送到
    /// 另一个进程、拿回一条合法的响应。
    ///
    /// 它同时覆盖了启动握手的超时逻辑与读任务的分派路径，而那两条路径
    /// 只有真的有一个子进程在对面时才会被执行。
    #[test]
    fn a_real_node_host_answers_a_ping() {
        let _guard = ENV_LOCK.lock().unwrap();

        let Some(node) = find_node() else {
            // 环境里没有 Node：跳过而不是失败。理由见 `find_node` 的说明。
            eprintln!("跳过：环境里没有可用的 Node 运行时");
            return;
        };

        let script = host_script();
        assert!(
            script.is_file(),
            "宿主脚本不存在：{}（打包资源时漏了它，后台功能会完全不可用）",
            script.display()
        );

        std::env::set_var("MODULITH_NODE", &node);
        std::env::set_var("MODULITH_BACKGROUND_HOST", &script);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("测试用的运行时应当能建立");

        let result = runtime.block_on(async {
            let host = BackgroundHost::new();

            let ping = host.ping().await;
            let status = host.describe();

            host.shutdown().await;
            (ping, status)
        });

        std::env::remove_var("MODULITH_NODE");
        std::env::remove_var("MODULITH_BACKGROUND_HOST");

        let (ping, status) = result;

        assert!(
            ping.ok,
            "存活探测应当成功，实际失败：{:?}。状态：{:?}",
            ping.error, status
        );
        let payload = ping.result.expect("成功的探测必须有结果");
        assert_eq!(
            payload.get("pong").and_then(|v| v.as_bool()),
            Some(true),
            "探测结果里应当有 pong：{payload}"
        );
    }

    /// 缺 Node 时必须给出**可读的原因**，而不是"操作失败"。
    ///
    /// 这条路径在真实用户机器上会发生（打包遗漏、杀毒软件隔离）。
    /// 界面上要显示的是"为什么不可用"，而不是一个异常。
    #[test]
    fn a_missing_runtime_yields_a_readable_reason() {
        let _guard = ENV_LOCK.lock().unwrap();

        let saved_node = std::env::var("MODULITH_NODE").ok();
        let saved_host = std::env::var("MODULITH_BACKGROUND_HOST").ok();

        // 指向一个不存在的文件：这条路径必须给出具体路径，
        // 而不是一句笼统的"找不到运行时"。
        std::env::set_var("MODULITH_NODE", r"C:\definitely\not\here\node.exe");

        let host = BackgroundHost::new();
        let reason = host.probe_node().expect_err("不存在的路径必须失败");
        let status = host.describe();

        // 还原环境，别影响其它测试
        match saved_node {
            Some(value) => std::env::set_var("MODULITH_NODE", value),
            None => std::env::remove_var("MODULITH_NODE"),
        }
        match saved_host {
            Some(value) => std::env::set_var("MODULITH_BACKGROUND_HOST", value),
            None => std::env::remove_var("MODULITH_BACKGROUND_HOST"),
        }

        assert!(
            reason.contains(r"C:\definitely\not\here\node.exe"),
            "原因里要带上那个路径，否则用户不知道该改哪里：{reason}"
        );
        assert!(!status.available, "不可用时不能报告为可用");
        assert!(status.pid.is_none(), "没启动就不该有 pid");
        assert!(
            status.reason.is_some(),
            "不可用时必须给出原因，否则界面只能显示一个沉默的开关"
        );
    }

    /// 没启动子进程时，状态查询不能有副作用。
    ///
    /// 用户打开设置页看一眼，不该因此拉起一个 Node 进程。
    #[test]
    fn describing_status_does_not_start_the_process() {
        let _guard = ENV_LOCK.lock().unwrap();

        let saved = std::env::var("MODULITH_NODE").ok();
        std::env::set_var("MODULITH_NODE", r"C:\definitely\not\here\node.exe");

        let host = BackgroundHost::new();
        let status = host.describe();

        match saved {
            Some(value) => std::env::set_var("MODULITH_NODE", value),
            None => std::env::remove_var("MODULITH_NODE"),
        }

        assert!(!status.running, "状态查询不该启动子进程");
        assert_eq!(status.requests, 0, "没有发过请求就不该有请求计数");
    }

    /// **端到端：定时任务真的会在到点后把事件送回宿主。**
    ///
    /// 这是第 6b-2 步唯一有说服力的证据。它一次串起了全部四段：
    ///
    ///   1. Rust 侧把一条定时任务推给子进程（`set_schedules`）；
    ///   2. Node 侧真的计时，1 秒后到点；
    ///   3. Node 主动发出一条 `schedule.fired`（**没有任何请求在等它**）；
    ///   4. Rust 侧的读任务把它认成事件（而不是一条 id 对不上的响应），
    ///      并交给装上的处理函数。
    ///
    /// 少了任何一段，表现都是"提醒永远不响"，而日志里没有任何线索。
    /// 只用 `check-background-scheduler.mjs` 验证第 2、3 段是不够的 ——
    /// 那一段完全不经过 Rust 的读循环，而读循环正是最容易把事件丢掉的地方。
    #[test]
    fn a_scheduled_reminder_really_fires_back_into_the_host() {
        let _guard = ENV_LOCK.lock().unwrap();

        let Some(node) = find_node() else {
            eprintln!("跳过：环境里没有可用的 Node 运行时");
            return;
        };

        let script = host_script();
        assert!(script.is_file(), "宿主脚本不存在：{}", script.display());

        std::env::set_var("MODULITH_NODE", &node);
        std::env::set_var("MODULITH_BACKGROUND_HOST", &script);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("测试用的运行时应当能建立");

        let received = std::sync::Arc::new(Mutex::new(Vec::<protocol::Event>::new()));

        let result = runtime.block_on(async {
            let host = BackgroundHost::new();

            let sink = std::sync::Arc::clone(&received);
            host.set_event_handler(std::sync::Arc::new(move |event| {
                sink.lock().unwrap().push(event);
            }));

            // 1 秒是宿主脚本允许的最小间隔，因此这条测试至少要跑 1 秒。
            let outcome = host
                .set_schedules(vec![serde_json::json!({
                    "id": "live.test",
                    "kind": "interval",
                    "name": "端到端验证",
                    "intervalMs": 1000,
                    "payload": { "title": "端到端验证", "body": "来自后台宿主" },
                })])
                .await;

            // 同步的那一刻子进程还不存在，因此 `None` 是**预期**结果：
            // 定义被记下来了，真正的推送发生在下面这次 `call` 拉起子进程之后。
            let synced_lazily = outcome.is_none();

            // 这一句会真的拉起子进程，并在启动之后自动把定义推过去。
            let ping = host.ping().await;

            // 等事件回来。上限 5 秒：1 秒的间隔加上进程启动时间，余量充足；
            // 真出问题时我们等的是"它永远不来"，因此这个上限不能太长。
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                if !received.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            let events = received.lock().unwrap().clone();
            let status = host.describe();
            host.shutdown().await;

            (synced_lazily, ping, events, status)
        });

        std::env::remove_var("MODULITH_NODE");
        std::env::remove_var("MODULITH_BACKGROUND_HOST");

        let (synced_lazily, ping, events, status) = result;

        assert!(
            synced_lazily,
            "子进程未运行时同步应当只记下定义（`None`），而不是报一个假失败"
        );
        assert!(
            ping.ok,
            "存活探测应当成功，实际失败：{:?}。状态：{:?}",
            ping.error,
            status
        );

        assert!(
            !events.is_empty(),
            "定时任务到点后应当有一条事件回到宿主。状态：{:?}",
            status
        );

        let fired = events
            .iter()
            .find(|event| event.event == "schedule.fired")
            .expect("事件名必须是 schedule.fired");

        assert_eq!(fired.subject, "live.test", "事件主体应当是那条任务的 id");
        assert_eq!(fired.validate(), Ok(()), "回到宿主的事件必须是合法的");
        assert_eq!(
            fired.data.as_ref().and_then(|d| d.get("fireCount")).and_then(|v| v.as_u64()),
            Some(1),
            "第一次触发应当报告 fireCount=1：{:?}",
            fired.data
        );
        assert_eq!(
            fired
                .data
                .as_ref()
                .and_then(|d| d.get("payload"))
                .and_then(|p| p.get("title"))
                .and_then(|v| v.as_str()),
            Some("端到端验证"),
            "定义里的标题应当随事件一起回来（应用侧显示时不必回查）：{:?}",
            fired.data
        );
    }
}
