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
    /// 用户在设置里指定的 Node 路径（空 = 自动探测）
    ///
    /// 它与 `node`（解析结果）分开：那个是**缓存**，改了配置必须清掉重算，
    /// 否则用户在设置里换了一个路径之后，我们仍然拿旧路径去启动子进程 ——
    /// 表现为"改完设置没生效，重启才好"。
    configured_node: Mutex<String>,
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
            configured_node: Mutex::new(String::new()),
        }
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

        let configured = self.configured_node.lock().unwrap().clone();
        let result = resolve_node(Some(configured.as_str()));
        *cached = Some(result.clone());
        result
    }

    /// 记下用户在设置里指定的 Node 路径，并**清掉解析缓存**。
    ///
    /// 清缓存这一步是必须的：否则用户在设置里换一个路径之后，我们仍然按上一次
    /// 的解析结果去启动子进程 —— 表现为"改完设置没生效，非要重启应用"。
    ///
    /// 传空字符串表示恢复自动探测。
    pub fn set_configured_node(&self, path: &str) {
        let mut configured = self.configured_node.lock().unwrap();
        if *configured == path {
            return;
        }
        *configured = path.to_string();
        *self.node.lock().unwrap() = None;
    }

    /// 当前记下的 Node 路径（空 = 自动探测）
    pub fn configured_node(&self) -> String {
        self.configured_node.lock().unwrap().clone()
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

        if let Err(error) = self.ensure_started(&node).await {
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
    /// 与 `call` 分开是因为分层：启动流程不该重入"启动 + 发送"那条路径。
    /// 子进程没在跑时这里立刻失败，而不是再启动一次 —— 那正是 `call` 的职责。
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

    /// 确保子进程在运行（已运行则直接返回）
    async fn ensure_started(&self, node: &PathBuf) -> Result<(), String> {
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
        Ok(())
    }

    /// 起一个读任务，把子进程的每一行分派给对应的等待者
    ///
    /// 这是一个 **async 任务**而不是"读线程"：它只做 `read_line` 与一次查表，
    /// 全程没有阻塞式系统调用，因此不需要独占一个线程。
    fn spawn_reader(&self, mut reader: BufReader<ChildStdout>) {
        let pending = Arc::clone(&self.pending);

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

                let response = match protocol::decode_response(&line) {
                    Ok(response) => response,
                    Err(error) => {
                        // 一行解析不了**不终止**读循环：对面可能只是写了一条垃圾，
                        // 而它之后的消息仍然是好的。终止会让一次格式错误变成
                        // "整个后台功能永久失效"。
                        //
                        // 但要把待处理的请求放掉 —— 否则调用方会一直等到超时。
                        log::warn!("后台宿主返回了无法解析的一行：{error}");
                        continue;
                    }
                };

                let waiter = pending.lock().unwrap().remove(&response.id);
                match waiter {
                    Some(sender) => {
                        // 接收方可能已经因为超时走掉了；那不是错误。
                        let _ = sender.send(response);
                    }
                    None => {
                        // 没有等待者：要么是超时之后的迟到响应，要么是对面自己
                        // 发了一条我们没有请求过的消息。如实记下来 ——
                        // 后者说明协议实现有问题。
                        log::debug!("收到没有等待者的后台响应（id {}）", response.id);
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
/// ============================================================
/// 查找顺序：**用户显式指的 > 随包分发的 > 系统里的**
/// ============================================================
///
///   1. 设置里的 `nodeRuntimePath`（**界面上选一次就记住**，不需要改环境变量）；
///   2. 环境变量 `MODULITH_NODE`（开发与排障用）；
///   3. 可执行文件旁边的 `runtime/node.exe`（打包分发时随包带上）；
///   4. 几个常见的安装位置（`C:\Program Files\nodejs\node.exe` 等）；
///   5. 系统 PATH。
///
/// **第 4、5 条是后补的，而它们的缺失是一个真实的缺陷。** 原来的实现只有 2、3
/// 两条，于是出现了一个很难自查的现象：用户在 cmd 里敲 `node --version` 有版本，
/// 应用里却说"未找到 Node 运行时" —— 因为 cmd 会走 PATH，而我们**没有查 PATH**。
/// 用户会以为是自己环境变量没配好，而我们其实少找了一个地方。
///
/// 把"系统里的 node"放在最后一条，是因为它的版本不受我们控制，而协议是按我们
/// 分发的那份定的 —— 能用它跑起来是意外之喜，不该当成设计。但它比"直接失败"
/// 好：绝大多数用户的机器上就装着 Node。
///
/// 排序逻辑抽在 `plan_node_search` 里（纯函数，可单测），这里只负责按顺序找文件。
fn resolve_node(configured: Option<&str>) -> Result<PathBuf, String> {
    let env_value = std::env::var("MODULITH_NODE").ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()));
    let path_env = std::env::var("PATH").ok();

    let plan = plan_node_search(
        configured,
        env_value.as_deref(),
        exe_dir.as_deref(),
        path_env.as_deref(),
        platform_base_dirs(),
    );

    // 1~4 类是候选文件路径：存在即用。
    for candidate in &plan.files {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    // 5 类是要在 PATH 目录里拼的**文件名**。这里逐目录检查存在性，
    // 而不是把裸 "node" 交给 `Command::new` 让它自己去 PATH 里找 ——
    // 两个理由：
    //   · 我们要在**报错时给出具体路径**，而交给系统去找就无从知道；
    //   · Windows 上 PATH 里的 `node` 可能是一个 `.cmd` 包装脚本，
    //     而 `Command::new` 不能直接执行 `.cmd`（它需要一个真实的可执行文件）。
    for dir in &plan.path_dirs {
        let candidate = dir.join(plan.executable_name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    // 显式指过路径、但它不存在时，**要把那件事说出来**。
    //
    // 两个来源都要报：设置里的路径（界面选的）与环境变量（手工设的）。
    // 笼统的"未找到 Node"会让用户以为是自己没配，而其实是配错了路径 ——
    // 尤其环境变量那条：用户改了环境变量、应用里还是说找不到，他会去反复
    // 检查自己改对没有，而真正的原因（那个文件不在那里）从没被说出来。
    let explicit: Vec<&str> = [configured, env_value.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();

    if !explicit.is_empty() {
        return Err(format!(
            "指定的 Node 路径不存在：{}。请在设置 → 性能 里重新指定，或把它清空以恢复自动探测。",
            explicit.join("、")
        ));
    }

    Err(format!(
        "未找到 Node 运行时。{}后台功能需要它 —— 请在设置 → 性能 里指定 {} 的位置，\
         或把 Node 放在应用目录的 runtime/ 下。",
        if path_env.is_none() {
            "（当前进程读不到 PATH 环境变量，因此无法自动查找）"
        } else {
            ""
        },
        node_file_name()
    ))
}

/// 一次 Node 查找的**计划**（纯数据，不含任何文件系统访问）。
///
/// 抽成纯函数是为了让"查找顺序"这件事可以被单元测试直接覆盖 —— 顺序错了
/// 表现得就像"没找到"（前面的候选不存在时会顺延到下一个，因此顺序错往往
/// 无声无息），而它恰好不需要真实文件就能验证。
#[derive(Debug, Clone, PartialEq, Eq)]
struct NodeSearchPlan {
    /// 按优先级排列的**候选文件路径**（存在即用）
    files: Vec<PathBuf>,
    /// 要逐个进去找 `executable_name` 的目录
    path_dirs: Vec<PathBuf>,
    /// 可执行文件名（Windows 上是 `node.exe`）
    executable_name: &'static str,
}

fn plan_node_search(
    configured: Option<&str>,
    env_value: Option<&str>,
    exe_dir: Option<&std::path::Path>,
    path_env: Option<&str>,
    platform_bases: Vec<PathBuf>,
) -> NodeSearchPlan {
    let name = node_file_name();
    let mut files = Vec::new();

    // 1. 用户在界面里指定的路径（最高优先级：显式指过的不该被覆盖）
    if let Some(value) = configured {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            files.push(PathBuf::from(trimmed));
        }
    }

    // 2. 环境变量
    if let Some(value) = env_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            files.push(PathBuf::from(trimmed));
        }
    }

    // 3. 随包分发的那一份：exe 旁边的 runtime/
    //
    // 同时试两种相对位置：打包后资源会被放到 exe 同级的 `runtime/`，
    // 而 Tauri 的资源解析在开发/安装两种布局下并不一致。
    if let Some(dir) = exe_dir {
        files.push(dir.join("runtime").join(name));
        files.push(dir.join("resources").join("runtime").join(name));
    }

    // 4. 常见安装位置（Windows）。
    //
    // 这些目录是**参数传进来的**，不是在这里读环境变量 —— 见 `plan_node_search`
    // 上的说明：在函数里偷偷读环境变量，测试就无法造出"哪里都没有"这个前提，
    // 而那种失败会伪装成"实现坏了"。
    for base in &platform_bases {
        files.push(base.join("nodejs").join(name));
        files.push(base.join("Programs").join("nodejs").join(name));
    }

    // 5. PATH 上的每一个目录
    let path_dirs = path_env
        .map(|value| std::env::split_paths(value).collect::<Vec<_>>())
        .unwrap_or_default();

    NodeSearchPlan {
        files,
        path_dirs,
        executable_name: name,
    }
}

/// Windows 上 Node 的常见安装位置所基于的目录。
///
/// 单独抽出来是为了让 `plan_node_search` 完全纯粹：环境变量在 `resolve_node`
/// 里读一次，然后作为参数传进去。在纯函数内部读环境变量会让它无法被确定地
/// 测试 —— 而那种失败会伪装成"实现坏了"（本项目刚踩过一次：`a_missing_runtime`
/// 因为 `ProgramFiles` 里真有 node 而失败）。
///
/// `MODULITH_NODE_SEARCH_BASES` 可以**替换**这份列表（用 `;` 分隔）。两种情况
/// 都真实存在：
///
///   · **测试**：要造出"哪里都没有 Node"这个前提，就不能让这台机器上真实存在的
///     安装位置参与查找；
///   · **排障**：用户把 Node 装在非常规前缀下（企业环境、便携部署），自动查找
///     注定找不到，而给一个"这些目录也找一遍"的入口比让他手工选文件省事。
///
/// 它**替换**而不是追加：追加会让测试无法把列表清空，而那正是这里最需要的语义。
fn platform_base_dirs() -> Vec<PathBuf> {
    if let Ok(override_value) = std::env::var("MODULITH_NODE_SEARCH_BASES") {
        return std::env::split_paths(&override_value).collect();
    }

    #[cfg(windows)]
    {
        return ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA"]
            .iter()
            .filter_map(|key| std::env::var(key).ok())
            .map(PathBuf::from)
            .collect();
    }

    #[cfg(not(windows))]
    {
        Vec::new()
    }
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

    /// 改动进程级环境变量（`MODULITH_NODE` / `MODULITH_BACKGROUND_HOST` / `PATH`）
    /// 会与其它测试互相影响，因此这一组测试串行执行。
    ///
    /// 用一把测试专用的锁而不是假设 `--test-threads=1`：那个参数是**调用方**的
    /// 选择，而一条依赖调用方参数的测试会在别人机器上随机失败。
    ///
    /// 取锁用 `unwrap_or_else(PoisonError::into_inner)` 而不是 `unwrap()`：
    /// 一个测试 panic 之后这把锁会被标记为"中毒"，而 `unwrap()` 会让**所有**
    /// 后续测试都以 `PoisonError` 失败 —— 那会把一次真实的失败放大成一片虚假的
    /// 失败，真正的原因被埋起来。本项目刚经历过一次：一条断言失败导致另外四条
    /// 报 `PoisonError`，看起来像四处都坏了。
    ///
    /// 中毒对这里的测试是安全的：它们之间没有靠这把锁保护的**数据**，
    /// 只是需要互斥。
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

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

    /// 环境变量的**原值快照**，用于测试结束后还原。
    ///
    /// 这批测试会改动 `MODULITH_NODE` 与 `PATH`，而它们对同进程里的其它测试是
    /// 可见的。用一个守卫而不是在每个测试末尾手写还原：漏掉一次就会污染后面
    /// 任意一条测试，而那种失败与被测代码毫无关系。
    struct EnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn capture(keys: &[&'static str]) -> Self {
            Self {
                saved: keys
                    .iter()
                    .map(|key| (*key, std::env::var(key).ok()))
                    .collect(),
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    // ============================================================
    // 查找计划（纯函数，不需要真实文件）
    // ============================================================

    /// **用户在设置里指的路径优先级最高。**
    ///
    /// 这条最重要：用户显式指过的东西不该被任何自动探测覆盖。若顺序反了，
    /// 用户会在设置里选好一个 Node、保存、然后发现我们仍然在用另一个 ——
    /// 而那看起来就是"设置没生效"。
    #[test]
    fn a_user_configured_path_outranks_everything() {
        let plan = plan_node_search(
            Some(r"C:\my\node.exe"),
            Some(r"C:\env\node.exe"),
            Some(std::path::Path::new(r"C:\app")),
            Some(r"C:\path\dir"),
            // 空的平台目录列表：测试要能**确定**候选里没有别的来源，
            // 否则一条"优先级"断言会被机器上真实存在的 node 干扰。
            Vec::new(),
        );

        assert_eq!(plan.files[0], PathBuf::from(r"C:\my\node.exe"));
        assert_eq!(plan.files[1], PathBuf::from(r"C:\env\node.exe"));
    }

    /// 空白配置等于"没有配置"，不能变成一条指向空路径的候选。
    ///
    /// 一个 `PathBuf::from("")` 会让 `is_file()` 去查当前目录，而那是**当前
    /// 工作目录** —— 取决于用户从哪里启动应用。这种依赖是不可接受的。
    #[test]
    fn blank_configuration_is_treated_as_absent() {
        let plan = plan_node_search(
            Some("   "),
            Some(""),
            Some(std::path::Path::new(r"C:\app")),
            None,
            Vec::new(),
        );

        assert!(
            !plan.files.iter().any(|path| path.as_os_str().is_empty()),
            "空配置不该产生一条空路径候选：{:?}",
            plan.files
        );
        assert_eq!(
            plan.files[0],
            PathBuf::from(r"C:\app").join("runtime").join(node_file_name()),
            "去掉空配置之后，第一条应当是随包分发的那一份"
        );
    }

    /// 随包分发的那一份要在"常见安装位置"之前。
    ///
    /// 理由不只是优先级：我们分发的那份版本与协议是自己定的，而用户机器上那份
    /// 不受我们控制。能用随包的那份，就不该用系统的。
    #[test]
    fn the_bundled_runtime_outranks_a_system_install() {
        let plan = plan_node_search(
            None,
            None,
            Some(std::path::Path::new(r"C:\app")),
            Some(r"C:\somewhere"),
            Vec::new(),
        );

        let bundled = PathBuf::from(r"C:\app").join("runtime").join(node_file_name());
        let bundled_index = plan
            .files
            .iter()
            .position(|path| *path == bundled)
            .expect("随包分发的那一份应当在候选里");

        // 后面那些是常见安装位置。它们都该排在 bundled 之后。
        for later in &plan.files[bundled_index + 1..] {
            assert_ne!(*later, bundled);
        }
        assert_eq!(bundled_index, 0, "没有其它配置时它应当排第一");
    }

    /// PATH 目录被单独收集，而不是混进候选文件列表。
    ///
    /// 分开的理由是两者的判据不同：前者是"某个目录下有没有这个文件"，
    /// 后者是"这个文件存不存在"。混在一起会让 PATH 的每一项都被当成一个文件路径。
    #[test]
    fn path_directories_are_collected_separately() {
        let plan = plan_node_search(
            None,
            None,
            None,
            Some(r"C:\a;C:\b"),
            Vec::new(),
        );

        assert_eq!(plan.path_dirs.len(), 2);
        assert_eq!(plan.executable_name, node_file_name());
        assert!(
            !plan.files.iter().any(|path| path.parent() == Some(std::path::Path::new(r"C:\a"))),
            "PATH 目录不该出现在候选文件列表里"
        );
    }

    /// 没有任何输入时计划仍然是一个合法的空计划，而不是 panic。
    #[test]
    fn an_empty_environment_yields_an_empty_plan() {
        let plan = plan_node_search(None, None, None, None, Vec::new());
        assert!(plan.path_dirs.is_empty());
        assert_eq!(plan.executable_name, node_file_name());
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
        let _guard = lock_env();

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
    ///
    /// **这条测试必须显式清掉 PATH。** 加了"PATH 自动查找"之后，一个只是
    /// `MODULITH_NODE` 指向坏路径的环境仍然会在 PATH 上找到真的 node ——
    /// 于是这条测试会以"居然成功了"失败。那不是实现坏了，是测试没有把
    /// "什么都不存在"这个前提造出来。**环境类测试要显式造出它的前提**，
    /// 不能依赖跑测试的那台机器恰好没有 Node。
    #[test]
    fn a_missing_runtime_yields_a_readable_reason() {
        let _guard = lock_env();
        let _env = EnvGuard::capture(&[
            "MODULITH_NODE",
            "MODULITH_BACKGROUND_HOST",
            "PATH",
            "MODULITH_NODE_SEARCH_BASES",
        ]);

        // 把"哪里都没有"这件事造出来：一个坏路径 + 没有 PATH + 没有常见安装位置。
        std::env::set_var("MODULITH_NODE", r"C:\definitely\not\here\node.exe");
        std::env::remove_var("PATH");
        // 空值会让 `split_paths` 得到一个空列表 —— 也就是"这几个常见位置也不查"。
        std::env::set_var("MODULITH_NODE_SEARCH_BASES", "");

        let host = BackgroundHost::new();
        let reason = host.probe_node().expect_err("不存在的路径必须失败");
        let status = host.describe();

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

    /// 设置里指定的路径**优先级最高**，即使环境变量指向别处。
    ///
    /// 这条防的是"用户设了路径、但环境变量把它的效果盖掉" —— 那看起来就是
    /// 设置没生效，而用户已经明确指过他要哪一个。
    #[test]
    fn a_configured_path_wins_over_the_environment_variable() {
        let _guard = lock_env();
        let _env = EnvGuard::capture(&["MODULITH_NODE"]);

        let Some(node) = find_node() else {
            eprintln!("跳过：环境里没有可用的 Node 运行时");
            return;
        };

        // 环境变量指向一个坏路径，设置指向真的那个
        std::env::set_var("MODULITH_NODE", r"C:\definitely\not\here\node.exe");

        let host = BackgroundHost::new();
        host.set_configured_node(&node.display().to_string());

        let resolved = host.probe_node().expect("设置里的路径应当被采用");
        assert_eq!(
            resolved, node,
            "设置里指定的路径必须优先于环境变量"
        );
    }

    /// **`PATH` 也确实会被查找**（这是用户报告的那个缺陷的直接回归测试）。
    ///
    /// 现象：在 cmd 里 `node --version` 有版本，应用里却说"未找到 Node 运行时"。
    /// 原因是 cmd 会走 PATH 而当时的实现没有查 PATH。
    ///
    /// 造前提的方式：把 `MODULITH_NODE` 指向坏路径、**没有**随包分发的 runtime、
    /// 然后把 PATH 设成"只含真实 Node 所在的那个目录"。若实现不查 PATH，
    /// 这条会以"找不到"失败。
    #[test]
    fn a_node_on_the_path_is_found() {
        let _guard = lock_env();
        let _env = EnvGuard::capture(&[
            "MODULITH_NODE",
            "PATH",
            "MODULITH_NODE_SEARCH_BASES",
        ]);

        let Some(node) = find_node() else {
            eprintln!("跳过：环境里没有可用的 Node 运行时");
            return;
        };

        let dir = node.parent().expect("Node 应当在一个目录里");

        std::env::set_var("MODULITH_NODE", r"C:\definitely\not\here\node.exe");
        // **把"常见安装位置"清空**，这样"找到"只可能来自 PATH 查找。
        //
        // 少了这一步，这台机器上 `C:\Program Files\nodejs\node.exe` 会先被
        // 第 4 类命中，于是这条测试**即使 PATH 查找整个被删掉也照样通过** ——
        // 那就成了一条对着坏代码也通过的测试（本项目已经有过两例）。
        std::env::set_var("MODULITH_NODE_SEARCH_BASES", "");
        // PATH 里只有那一个目录。
        std::env::set_var("PATH", dir.to_string_lossy().to_string());

        let host = BackgroundHost::new();
        let resolved = host
            .probe_node()
            .expect("PATH 上的 Node 应当被找到（这正是用户报告的那个缺陷）");

        assert_eq!(
            resolved, node,
            "解析结果应当就是 PATH 上那一个 —— 若它落在了别处，说明查找没有真的走 PATH"
        );
    }

    /// 没启动子进程时，状态查询不能有副作用。
    ///
    /// 用户打开设置页看一眼，不该因此拉起一个 Node 进程。
    #[test]
    fn describing_status_does_not_start_the_process() {
        let _guard = lock_env();
        let _env = EnvGuard::capture(&["MODULITH_NODE", "PATH"]);

        std::env::set_var("MODULITH_NODE", r"C:\definitely\not\here\node.exe");
        std::env::remove_var("PATH");

        let host = BackgroundHost::new();
        let status = host.describe();

        assert!(!status.running, "状态查询不该启动子进程");
        assert_eq!(status.requests, 0, "没有发过请求就不该有请求计数");
    }

}
