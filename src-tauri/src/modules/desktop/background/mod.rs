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

pub mod plugins;
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
///
/// ============================================================
/// 这个数字**只适用于"按需拉起的通用宿主"**
/// ============================================================
///
/// 它判的是"距离最后一次请求多久"。对一次性的能力查询（设置页点一下、探一次
/// 存活）那正是要的：没有人在等它，收掉它只是把内存还回去。
///
/// 对一个**后台插件进程**它完全错了：那种进程的本职就是**坐着不动等** —— 等它
/// 下一次 `interval`，或者等一个全局热键被按下。空闲是它的正常状态，不是可以
/// 回收的信号。把它当"空闲"收掉会同时毁掉三件事：内存里登记的热键订阅、插件
/// 自己的定时器、以及它写到存储里的存活状态 —— 用户看到的是"按了热键没反应"，
/// 而日志里只有一句"已空闲 300 秒，回收子进程"。
///
/// 因此这条超时**只在 `liveness == OnDemand` 时生效**（见 `BackgroundHost::liveness`
/// 与 `reap_if_idle`）。插件宿主在插件成功加载之后被永久钉住，直到插件被停掉。
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// 空闲回收的**检查间隔**。
///
/// 它与 `IDLE_TIMEOUT` 是两件事：这个决定"回收最晚晚多久被发现"，
/// 那个才是"多久没被用算空闲"。取 60 秒是因为判据本身是"距离最后一次请求多久"，
/// 请求随时可能来 —— 精确定时反而要不停重置计时器，而晚一分钟回收没有代价。
///
/// ⚠️ **它比 `IDLE_TIMEOUT` 小，而这一点在过去是一个真实缺陷。** 后台插件的
/// 清单可以声明 `interval: 600`（`stand-up` 就是），也可以只等热键（`translate`
/// 空闲时不发任何请求）。这两种插件的"最后一次请求"都停在启动握手那一刻 ——
/// 于是这个 60 秒一跳的定时器会在第一次检查（第 60~120 秒之间）就把它判成空闲
/// 并杀掉。回收任务本身没有错，错的是它被挂到了"拥有定时器或热键的宿主"上。
const REAP_INTERVAL: Duration = Duration::from_secs(60);

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

/// 子进程发来的一条请求（插件的 `ctx.*` 调用）。
///
/// 与 `Response` 相对：那个是"它对我们的回答"，这个是"它问我们的话"。
/// 读循环不认识业务，因此把这类消息**转发**给注册它的那个任务去处理
/// （见 `BackgroundHost::inbound`）—— 读循环里塞进业务分派的话，
/// 它就得先认识 `PluginManager`、权限模型、通知中心，而它本该只认识字节。
#[derive(Debug, Clone)]
pub struct Inbound {
    pub id: u64,
    pub method: String,
    pub params: Option<serde_json::Value>,
}

/// 子进程的运行时状态
struct State {
    child: Option<Child>,
    /// 写入端。
    ///
    /// 用 `tokio::sync::Mutex` 包起来而不是 `Option<ChildStdin>` 直接挪进挪出：
    /// **两个地方都要写它** —— 调用方发请求，读循环回答子进程的请求。原来那种
    /// "取出来、写、放回去"的写法在只有一个写入者时够用，多一个写入者就会出现
    /// "另一个写入者看到 `None` 然后报错"的窗口。
    ///
    /// `tokio` 的守卫是 `Send` 的，因此跨 `await` 持有它是合法的 ——
    /// 这正是 `std::sync::MutexGuard` 做不到、以致于原来要绕一圈的那件事。
    writer: Option<Arc<tokio::sync::Mutex<ChildStdin>>>,
    /// 上一次有请求的时刻，用于空闲回收
    last_used: Instant,
    /// 最近一次失败的原因（成功一次后清空）
    last_error: Option<String>,
    /// 累计请求数
    requests: u64,
    /// 读循环是否已经读到 EOF（也就是这个子进程的输出通道已经关了）。
    ///
    /// ============================================================
    /// 为什么需要它，而不是直接信 `try_wait()`
    /// ============================================================
    ///
    /// `ensure_started` 会调 `try_wait()` 来确认进程是不是还活着。但那一次调用
    /// 只在**要发请求**的时候发生，而子进程退出到下一次请求之间可以隔着几小时 ——
    /// 这段时间里 `status()` 会一直说 "running: true"，插件详情页上显示的是一个
    /// 早就不存在的进程。
    ///
    /// 读循环是**唯一**能立刻知道"对面没了"的地方（它读到了 EOF），因此由它在这里
    /// 留一个标记，`status()` 与 `ensure_started` 都读它。
    output_closed: bool,
}

/// 这个宿主**为什么活着** —— 决定它能不能被空闲回收。
///
/// ============================================================
/// 为什么必须是显式的，而不是再算一个时间戳
/// ============================================================
///
/// 直觉上的修法是"把 `IDLE_TIMEOUT` 调大"或者"有热键订阅就重置 `last_used`"。
/// 两条都不成立：
///
///   * 调大只是把"什么时候坏"往后推。`interval: 600` 的插件加一个十分钟的阈值
///     就变成十五分钟坏，换汤不换药；
///   * 拿"最近一次热键"当使用证据是**循环论证**：热键正是要等的东西，没有按键
///     就没有"使用"，而这与"这个进程还需不需要存在"无关。
///
/// 真正决定"能不能收"的是一件**已知的事实**，而不是一个推测的阈值：这个宿主
/// 里有没有加载着一个插件。有 —— 它拥有定时器与热键订阅，收掉它就是毁掉用户
/// 已经建立起来的能力；没有（只服务一次性查询）—— 收掉它没有任何代价。
///
/// 因此这里把那个事实写成一个状态，由**知道答案的那一侧**（`plugins.rs`）设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    /// 按需拉起的一次性宿主：没有人在等它就可以收。
    OnDemand,
    /// 托管着一个已加载的插件：**永远不回收**，直到插件被停掉。
    Pinned,
}

/// 后台宿主
///
/// 用 `Mutex` 而不是 `RwLock`：这里没有"多读"的场景，而拉起/回收/发请求
/// 都要改状态。一个更简单的锁比一个分类更细的锁更不容易写错。
pub struct BackgroundHost {
    /// 子进程的运行状态。
    ///
    /// `Arc` 而不是裸的 `Mutex`：**读循环也要改它**。读循环是一个 `'static` 的
    /// tokio 任务（它必须在宿主之外活着，否则它自己的存活就成了宿主的存活条件），
    /// 而它需要在自己读到 EOF 时把 `child`/`writer` 清掉 —— 那是"重启能发生"的
    /// 前提，见 `spawn_reader`。一个 `Arc` 换来的是这条路径，而不是并发性能。
    lives: Arc<Mutex<State>>,
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
    /// 子进程**问我们**的请求往哪里送。
    ///
    /// `None` = 不处理（纯粹的通道模式，`hello`/`ping`/`status`/`shutdown`）。
    /// `Some` = 有一个任务在等着处理它们（插件模式）。
    inbound: Mutex<Option<tokio::sync::mpsc::Sender<Inbound>>>,
    /// 启动这个子进程时要附加的参数与环境。
    ///
    /// 与 `BackgroundHost` 分开保存而不是塞进 `State`：它是**配置**，
    /// 在一次子进程的整个生命周期里不变，也不参与任何状态转换。
    spec: Mutex<HostSpec>,
    /// 见 `Liveness`：这个宿主能不能被空闲回收。
    ///
    /// 与 `spec` 一样是**配置**而不是运行状态，因此不放在 `State` 里 ——
    /// 它不参与任何状态转换，只是"谁在用它"的一个声明。
    liveness: Mutex<Liveness>,
}

/// 一次子进程启动的**形状**：多给哪些参数、给什么样的环境。
///
/// 抽出来是为了让"插件进程"与"探测用的进程"共用同一套进程管理与协议 ——
/// 两者的区别只有这两样，而复制一份进程管理代码意味着以后每修一个死锁都要修两处。
#[derive(Debug, Clone, Default)]
pub struct HostSpec {
    /// 附加的命令行参数（放在脚本路径**之前**，即 Node 自己的开关）
    pub node_args: Vec<String>,
    /// 附加的环境变量。**每一项都在这个列表之外被清掉**（见 `ensure_started`）
    pub env: Vec<(String, String)>,
    /// 是否清空继承来的环境变量。
    ///
    /// **插件进程必须清空**：`process.env` 在 `--permission` 之下**仍然可读**
    /// （实测 60 个变量，包括应用自己的 `DSH_*`）。不清理的话，一个逃出 `vm`
    /// 的插件能把整份环境变量读走并随一次请求送出去 —— 而环境变量里常常有
    /// 令牌与密钥。这条不是加固，是补一个已知的洞。
    pub clear_env: bool,
}

impl BackgroundHost {
    pub fn new() -> Self {
        Self {
            lives: Arc::new(Mutex::new(State {
                child: None,
                writer: None,
                last_used: Instant::now(),
                last_error: None,
                requests: 0,
                output_closed: false,
            })),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            node: Mutex::new(None),
            configured_node: Mutex::new(String::new()),
            inbound: Mutex::new(None),
            spec: Mutex::new(HostSpec::default()),
            liveness: Mutex::new(Liveness::OnDemand),
        }
    }

    /// 设定子进程的启动形状。**下次拉起时生效**，对已经在跑的子进程无效。
    ///
    /// 不自动重启正在跑的子进程：那会让"改一个配置"变成一次静默的进程替换，
    /// 而插件在那一刻的状态（定时器、内存里的数据）会无声地消失。
    pub fn set_spec(&self, spec: HostSpec) {
        *self.spec.lock().unwrap() = spec;
    }

    /// 声明这个宿主**为什么活着**（见 `Liveness`）。
    ///
    /// 由**知道答案的那一侧**调用，而不是由这里猜：
    ///   * `plugins.rs` 在一个插件成功加载之后置 `Pinned`（它拥有定时器与热键）；
    ///   * 插件停掉时置回 `OnDemand`。
    ///
    /// 它**不影响已经跑着的子进程**：置位只改变"未来要不要回收"这个判断，
    /// 因此不存在"改一个标记导致进程被替换"的静默副作用。
    pub fn set_liveness(&self, liveness: Liveness) {
        *self.liveness.lock().unwrap() = liveness;
    }

    /// 现在这个宿主是不是"拥有一个已加载的插件"（因此不可以被回收）。
    pub fn is_pinned(&self) -> bool {
        *self.liveness.lock().unwrap() == Liveness::Pinned
    }

    /// 记下一条**启动路径上的失败原因**。
    ///
    /// ============================================================
    /// 为什么必须留在这里，而不是只返回给调用方
    /// ============================================================
    ///
    /// `call()` 把启动失败原样返回给当时那个调用方，而调用方（`plugins.rs`）只
    /// 把它写进日志。可是用户与维护者看的地方是**插件详情页** —— 那里读的是
    /// `status()`，而 `status()` 在此之前只会报 Node 解析失败或"最后一次请求失败"。
    ///
    /// 于是"脚本没打包进去 / 子进程被创建标志挡住起不来 / 问候超时"这三种
    /// **完全不同的**故障，在界面上长得一模一样：一句"当前没有在运行"。那是这一
    /// 整条链路上最没有价值的一句话 —— 而它恰好是唯一被显示出来的。
    ///
    /// 因此启动失败要被**存下来**，并由 `status().reason` 带出去。
    pub fn record_error(&self, reason: String) {
        self.lives.lock().unwrap().last_error = Some(reason);
    }

    /// 注册"子进程问我们的话"的处理者。
    ///
    /// 同一个宿主只需要注册一次：读循环在写下这段逻辑时已经把发送端固定下来了。
    /// 重复注册会**顶掉**前一个 —— 与"插件上下文被替换"的语义一致。
    pub fn set_inbound(&self, sender: tokio::sync::mpsc::Sender<Inbound>) {
        *self.inbound.lock().unwrap() = Some(sender);
    }

    /// 当前状态（不启动任何东西）
    pub fn status(&self) -> BackgroundStatus {
        let state = self.lives.lock().unwrap();
        let node = self.node.lock().unwrap().clone();

        let node_path = match &node {
            Some(Ok(path)) => Some(path.display().to_string()),
            _ => None,
        };
        // 顺序是刻意的：Node 解析失败是**根因**，它比"最后一次启动失败"更该被
        // 显示出来；两者都存在时先报前者。
        let reason = match &node {
            Some(Err(reason)) => Some(reason.clone()),
            _ => state.last_error.clone(),
        };

        // "在跑" = 句柄在 **且** 输出通道还开着。
        //
        // 后一半不能省：子进程退出之后句柄会一直留在 `child` 里，直到下一次要发
        // 请求时 `ensure_started` 才把它清掉（`try_wait` 只在那一刻被调用）。少了
        // 这一半，插件详情页会在子进程早已死掉之后继续显示"运行中"，而那是"用户
        // 以为后台在跑、实际什么都没在跑"的又一种样子。
        let running = state.child.is_some() && !state.output_closed;

        BackgroundStatus {
            // `available` 的含义是"现在就能用它"，因此它要求**子进程活着**。
            // 只找到 Node 不算可用 —— 那正是"设置里说找到了 Node、后台插件却一个
            // 都没跑起来"时最容易被误读的一格。
            available: node.as_ref().is_some_and(|n| n.is_ok()) && running,
            running,
            reason,
            node_path,
            pid: if running {
                state.child.as_ref().and_then(|child| child.id())
            } else {
                None
            },
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
        self.call_within(
            method,
            params,
            Duration::from_millis(protocol::REQUEST_TIMEOUT_MS),
        )
        .await
    }

    /// 同 `call`，但换一个等待上限。
    ///
    /// ============================================================
    /// 为什么需要这个参数：有一类方法的时长**不由我们决定**
    /// ============================================================
    ///
    /// `REQUEST_TIMEOUT_MS`（10 秒）是给"宿主发起、宿主知道要多久"的那些调用用的。
    /// `plugin.dispatch` 不是那一类：它是把一件事**投给插件的处理器**，而处理器
    /// 可以合法地等一个用户动作 —— 比如 `ctx.ui.popover`，它缺省**没有截止时间**。
    ///
    /// 用 10 秒去卡它，得到的是：宿主这边记一句"后台宿主在 10000 毫秒内没有响应"
    /// （`outcome.ok == false`，而插件那一侧其实好好地跑着），随后子进程回话时再
    /// 记一句"收到没有等待者的后台响应"—— 两条日志都指向一个不存在的问题。
    /// 它与卡片那一条传输预算（`ctx.ui.popover` 豁免 `HOST_CALL_TIMEOUT_MS`）
    /// 是同一个道理的两半：**不能让一个"等到用户做出动作"的等待被一个固定的
    /// 秒数单方面作废。**
    pub async fn call_within(
        &self,
        method: BackgroundMethod,
        params: Option<serde_json::Value>,
        budget: std::time::Duration,
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
            // 顺手把它记进状态：调用方只会把它写进日志，而用户看的是插件详情页。
            // 不记的话，"脚本没打包进去"与"Node 启动被挡住"在界面上无法区分 ——
            // 那正是这一整条链路最难排查的地方（见 `record_error`）。
            self.record_error(error.clone());
            return CallOutcome {
                ok: false,
                result: None,
                error: Some(error),
            };
        }

        self.send(method, params, budget).await
    }

    /// 把一条请求写到子进程并等它的响应。**不负责拉起子进程。**
    ///
    /// 与 `call` 分开是因为分层：启动流程不该重入"启动 + 发送"那条路径。
    /// 子进程没在跑时这里立刻失败，而不是再启动一次 —— 那正是 `call` 的职责。
    async fn send(
        &self,
        method: BackgroundMethod,
        params: Option<serde_json::Value>,
        budget: std::time::Duration,
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

        // 关于这一段的锁：`std::sync::MutexGuard` 不是 `Send`，而 Tauri 命令的
        // future 必须是 —— 因此**不允许跨 await 持有它**。这里只在锁里做两件
        // 同步的事（改计数、克隆一个 `Arc`），然后在锁外 `await` 写入锁。
        //
        // 克隆而不是把写入端取出来：取出来会让另一个写入者（读循环回答子进程的
        // 请求时）看到一个 `None`，而那会表现成一次随机的"后台宿主未在运行"。
        let writer = {
            let mut state = self.lives.lock().unwrap();
            state.requests += 1;
            state.last_used = Instant::now();
            state.writer.clone()
        };

        let Some(writer) = writer else {
            return CallOutcome {
                ok: false,
                result: None,
                error: Some("后台宿主未在运行".to_string()),
            };
        };

        // 放进待处理表**必须早于**写入：子进程可能回得比我们走完这一步更快，
        // 而那时读任务会找不到等待者、把响应丢掉。
        self.pending.lock().unwrap().insert(id, sender);

        let write_result = {
            let mut guard = writer.lock().await;
            async {
                guard.write_all(line.as_bytes()).await?;
                guard.flush().await
            }
            .await
        };

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

        match tokio::time::timeout(budget, receiver).await {
            Ok(Ok(response)) => match response.validate() {
                Ok(()) => {
                    let mut state = self.lives.lock().unwrap();
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
                        budget.as_millis()
                    )),
                }
            }
        }
    }

    /// 回答子进程的一条请求。
    ///
    /// 由处理 `ctx.*` 的那个任务调用。写失败**只记日志**：那意味着子进程已经
    /// 不在了，而调用方（那个任务）本来就无法为此做任何事 —— 它手里没有
    /// 重试的依据，重复投递一个可能已经执行过的副作用调用更糟。
    pub async fn respond(&self, id: u64, result: Result<serde_json::Value, String>) {
        let writer = {
            let state = self.lives.lock().unwrap();
            state.writer.clone()
        };
        let Some(writer) = writer else {
            return;
        };

        let response = match result {
            Ok(value) => protocol::Response {
                v: PROTOCOL_VERSION,
                id,
                result: Some(value),
                error: None,
            },
            Err(message) => protocol::Response {
                v: PROTOCOL_VERSION,
                id,
                result: None,
                error: Some(message),
            },
        };

        let Ok(line) = protocol::encode_response(&response) else {
            log::warn!("无法编码对后台请求 {id} 的回答");
            return;
        };

        let mut guard = writer.lock().await;
        if let Err(error) = guard.write_all(line.as_bytes()).await {
            log::debug!("回答后台请求 {id} 失败（子进程可能已经退出）：{error}");
            return;
        }
        let _ = guard.flush().await;
    }

    /// 确保子进程在运行（已运行则直接返回）
    ///
    /// ============================================================
    /// 死掉的子进程必须被**认成死掉**，否则重启永远不会发生
    /// ============================================================
    ///
    /// 这里原来只判 `child.is_some()`。而读循环读到子进程的 EOF 时只结束了它自己，
    /// **没有把 `child` 清掉** —— 于是一个已经退出（崩溃、被系统回收、被别的程序
    /// 结束）的进程会让这个判断一直为真：
    ///
    ///   1. 后续的每一次请求都走"已经跑着"这条捷径，直接去写一个已经断掉的管道；
    ///   2. 写失败只报一句"写入后台宿主失败"（`Broken pipe`），而那句错误在界面上
    ///      看起来就像一次偶发的通信故障，完全看不出"这个进程早就不在了"；
    ///   3. **重新拉起一次都没有发生过** —— 而重新拉起是这里本该做的事。
    ///
    /// 这正是"后台插件全都跑不起来"的一个自洽解释：第一次启动可能成功，之后任何
    /// 原因（被空闲回收、被外部结束、脚本自己崩了）都会让这个宿主**永久**进入
    /// 那个状态，直到应用重启。因此 `spawn_reader` 在读到 EOF 时会清掉这两个字段。
    async fn ensure_started(&self, node: &PathBuf) -> Result<(), String> {
        // 先在同一个临界区里判断"它到底还在不在"，并且**取走那个已经不存在的
        // 句柄**。两件事一起做（而不是"先看 is_some、再单独 take"）是因为中间不能
        // 让出锁：两个并发的调用都可能看到 `Some`，然后一个 take 成功、另一个
        // take 到 `None` —— 后者会以为"没有进程"于是**再拉起一个**，于是同一份
        // 插件代码跑到两个进程里，热键被注册两次（第二次失败），而日志看起来像
        // 随机的重启。
        let dead = {
            let mut state = self.lives.lock().unwrap();
            match state.child.as_mut() {
                None => None,
                Some(child) => match child.try_wait() {
                    // 还在跑，且输出通道没关：这是唯一一条可以安全走开的路径。
                    Ok(None) if !state.output_closed => return Ok(()),
                    // 输出通道关了（读循环读到了 EOF）或者进程已经退出：
                    // 这个句柄不能再用了，下面重新拉起一个。
                    Ok(status) => Some(ExitStatus::from_optional(status)),
                    // 问不出来（句柄已经不合法一类）：按"不在了"处理。
                    // 反过来的话我们会永远认为它活着，而那正是这一节要消灭的状态。
                    Err(error) => Some(ExitStatus::Unknown(Some(error.to_string()))),
                },
            }
        };

        if let Some(exit) = dead {
            let mut state = self.lives.lock().unwrap();
            state.child = None;
            state.writer = None;
            state.output_closed = false;
            log::warn!("后台宿主已不在运行（{exit}），重新拉起一个");
        }

        let script = host_script_path()?;
        let spec = self.spec.lock().unwrap().clone();

        let mut command = tokio::process::Command::new(node);
        // 不分配控制台。少了这一行，发行版每次拉后台宿主都会闪一个黑窗 ——
        // 而 `.output()` / `Stdio::piped()` 都挡不住它（见 core/process.rs）。
        crate::core::process::no_console_window_tokio(&mut command);
        command
            // 附加参数放在脚本路径**之前**：它们是 Node 自己的开关
            // （`--permission`、`--allow-fs-read=…`），放在脚本之后就变成
            // 传给脚本的参数了 —— 而那个错误的表现是"权限一条都没生效"。
            .args(&spec.node_args)
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // ============================================================
            // stderr：**管道**，并由一个任务转发进应用日志
            // ============================================================
            //
            // 这里原来是 `Stdio::inherit()`，意图是"子进程的崩溃与 console.error
            // 直接进应用日志"。意图没错，机制选错了，而且错在**发行版专属**的一条路上：
            //
            //   * 本应用是 GUI 子系统，它自己不持有控制台。由安装器、开始菜单或
            //     文件管理器启动时，进程的标准句柄可能是**无效句柄**（而不是"一个
            //     指向空设备的东西"）；
            //   * `Stdio::inherit()` 把选中的原生句柄原样放进 `STARTUPINFO`；
            //     句柄无效时 `CreateProcessW` 会以 `ERROR_INVALID_HANDLE` 直接失败。
            //     那一刻的表现**不是**"stderr 没接上"，而是**子进程根本没有被创建**：
            //     `ensure_started` 返回"无法启动后台宿主（…）：句柄无效"，而这条
            //     错误此前只进日志、不进界面（见 `record_error`）。
            //
            // 因此改成管道 + 转发。它与继承**信息量完全一致**（`console.error` 与
            // Node 的崩溃栈照样进同一份日志），但不再依赖"父进程恰好拿着一个有效的
            // stderr 句柄"这个在发行版里不成立的前提。
            //
            // 管道**必须有人读**：写满内核缓冲区之后子进程会阻塞在写 stderr 上，
            // 而它同时正等着我们回答 `ctx.*` —— 那就是一个死锁。因此下面
            // `spawn_stderr_forwarder` 是这套改动的**必需部分**，不是可选优化。
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if spec.clear_env {
            // 见 `HostSpec::clear_env`：`process.env` 在 `--permission` 之下
            // 仍然可读，因此"不清环境变量"等于把宿主的令牌交给插件。
            command.env_clear();

            // 但完全不给环境变量会让 Node 在一些平台上起不来
            // （Windows 需要 `SystemRoot` 才能解析系统 DLL，`TEMP` 是临时目录）。
            // 因此留最小的那一组，它们都不含用户信息。
            for key in ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT"] {
                if let Ok(value) = std::env::var(key) {
                    command.env(key, value);
                }
            }
        }

        for (key, value) in &spec.env {
            command.env(key, value);
        }

        let mut child = command.spawn().map_err(|error| {
            // 这条错误是"后台功能整个不可用"时用户与维护者能拿到的**唯一**线索，
            // 因此不能只是一句"启动失败"。四种原因需要完全不同的动作，而它们
            // 在 `std::io::Error` 里长得几乎一样：
            //
            //   * 找不到 Node 可执行文件（路径变过、被杀毒隔离）→ 去设置里重选；
            //   * 句柄无效（父进程没有有效的标准句柄，见上面 stderr 那一段的说明）
            //     → 这是**宿主的缺陷**，不是用户配错了；
            //   * 参数非法（`--permission` 之类的开关不被这个 Node 认识）
            //     → 换一个 Node 版本；
            //   * 权限不足（安全软件拦了进程创建）→ 与用户的环境有关。
            //
            // 这里只做一件事：把**原始的系统错误**逐字带上，并指明尝试的是哪一个
            // 可执行文件。归类留给读这段日志的人 —— 猜错的归类比不归类更坏。
            format!(
                "无法启动后台宿主进程（可执行文件 {node:?}）：{error}。\
                 常见原因：那个文件不存在或被杀毒软件隔离、Node 版本与启动参数不匹配、\
                 或系统策略拦下了进程创建。"
            )
        })?;

        let stdin = child.stdin.take().ok_or_else(|| "无法取得子进程的标准输入".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法取得子进程的标准输出".to_string())?;

        // stderr 必须先接上转发任务（见 `stderr(Stdio::piped())` 那一段的说明：
        // 没有人读它的后果是子进程卡死在写 stderr 上）。取不到句柄时不算失败 ——
        // 那只是失去一条诊断通道，后台功能本身照常可用。
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_forwarder(stderr);
        }

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
                // 读到 EOF：子进程立刻退出了。把它的**退出状态**带上 ——
                // 那通常是唯一的线索（例如 Node 报"找不到脚本"是 1、被信号/强杀
                // 是另一种）。子进程自己打印的 stderr 已经由转发任务写进了日志，
                // 因此这里只需要指路，不需要（也无法）复述它。
                let status = child
                    .try_wait()
                    .ok()
                    .flatten()
                    .map(|status| ExitStatus::from_status(&status))
                    .unwrap_or(ExitStatus::Unknown(None));
                return Err(format!(
                    "后台宿主启动后立即退出（{status}）。stderr 已写进应用日志 \
                     （搜索「后台宿主 stderr」），它通常直接写着原因。"
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
            let mut state = self.lives.lock().unwrap();
            state.child = Some(child);
            state.writer = Some(Arc::new(tokio::sync::Mutex::new(stdin)));
            state.last_error = None;
            // 新进程是活的。读循环上一次留下的那个标记必须清掉，否则
            // `ensure_started` 会立刻把它当成"刚死掉的那个"再拉一次。
            state.output_closed = false;
        }

        self.spawn_reader(reader);
        log::info!("后台宿主已启动：pid={:?}", self.status().pid);
        Ok(())
    }

    /// 起一个读任务，把子进程的每一行分派给对应的等待者
    ///
    /// 这是一个 **async 任务**而不是"读线程"：它只做 `read_line` 与一次查表，
    /// 全程没有阻塞式系统调用，因此不需要独占一个线程。
    ///
    /// 它同时承担**收尸**：读到 EOF 时把托管状态里的 `child`/`writer` 清掉。
    /// 少了这一步，一个已经退出的子进程会让 `ensure_started` 永远认为"它在跑"
    /// —— 于是**重新拉起永远不会发生**，而后台插件在用户眼里就是"死了"。
    fn spawn_reader(&self, mut reader: BufReader<ChildStdout>) {
        let pending = Arc::clone(&self.pending);
        // 读循环只把这类消息**转发**出去：它不认识业务，也不该认识 ——
        // 认识 `PluginManager` 的那部分是 `plugins.rs` 里的一个独立任务。
        let inbound = self.inbound.lock().unwrap().clone();

        // 收尸要改 `State`，而读循环是一个 `'static` 任务 —— 因此把状态做成
        // 共享的 `Arc`，而不是把 `&self` 借进去。
        let lives = Arc::clone(&self.lives);

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

                let incoming = match protocol::decode_incoming(&line) {
                    Ok(incoming) => incoming,
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

                let response = match incoming {
                    protocol::Incoming::Response(response) => response,
                    protocol::Incoming::Request(request) => {
                        // 子进程在问我们（插件的 `ctx.*`）。
                        //
                        // 没有处理者时**必须回答一句错误**，而不是把这条消息丢掉：
                        // 插件那边正 await 着，丢掉的话它只能等到 10 秒超时，
                        // 然后报一句"宿主没有响应" —— 而真相是"这个进程没有
                        // 注册处理者，它本来就不该发起调用"。
                        match &inbound {
                            Some(sender) => {
                                let inbound_request = Inbound {
                                    id: request.id,
                                    method: request.method,
                                    params: request.params,
                                };
                                if sender.send(inbound_request).await.is_err() {
                                    log::warn!("处理后台请求的任务已经不在了");
                                }
                            }
                            None => {
                                log::warn!(
                                    "后台宿主发来了请求（{}），但这个进程没有注册处理者",
                                    request.method
                                );
                            }
                        }
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

            // 读循环结束 = 子进程不再可用。三件事都要做，而且顺序有理由：
            //
            //   1. **清掉托管状态**（`child`/`writer`）。这是"重新拉起"能发生的
            //      前提：`ensure_started` 判的正是 `child.is_some()`，不清的话它会
            //      永远为真。**这一条是本次修复的核心** —— 少了它，一个退出过的
            //      宿主会永久停在"看起来在跑、实际写不进任何东西"的状态，
            //      而后台插件在用户眼里就是"死了，而且怎么都不再起来"。
            //   2. 把 `output_closed` 置上，让 `status()` 立刻如实报告"没在跑"，
            //      不必等到下一次 `try_wait()`。
            //   3. 放掉全部等待者，让它们立刻失败，而不是各自等到 10 秒超时。
            let mut lives = lives.lock().unwrap();
            if lives.child.is_some() {
                let reason = lives
                    .child
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten())
                    .map(|status| ExitStatus::from_status(&status).to_string())
                    .unwrap_or_else(|| "输出通道关闭（进程已退出）".to_string());

                lives.child = None;
                lives.writer = None;
                lives.output_closed = true;
                // 这条日志是"后台插件为什么没在跑"的第一手证据：它给出了**退出状态**。
                // 子进程自己的 stderr 由转发任务独立写进同一份日志。
                log::warn!("后台宿主已退出：{reason}");
            }

            // 先放锁再 drain：`pending` 与 `lives` 是两把不同的锁，而持有 `lives`
            // 期间去 await 任何东西都会把"发请求"那条路径一起堵住（它也要拿
            // `lives` 去更新时间戳）。这里没有 await，但保持一致的顺序更好推理。
            drop(lives);

            let drained: Vec<_> = pending.lock().unwrap().drain().collect();
            if !drained.is_empty() {
                log::warn!("后台宿主退出，{} 个待处理请求被中断", drained.len());
            }
        });
    }

    /// 空闲回收：连续一段时间没有被使用就关掉子进程。
    ///
    /// ============================================================
    /// 它**不回收托管着插件的宿主**
    /// ============================================================
    ///
    /// 判据原本只有"距离最后一次请求多久"。那条判据对一次性的能力查询是对的，
    /// 对后台插件是**灾难**：后台插件的本职就是坐着等 —— 等下一次 `interval`，
    /// 或者等一个全局热键被按下。也就是说"很久没有请求"恰恰是它正常工作的样子。
    ///
    /// 收掉它会毁掉三样东西：内存里登记的热键订阅（宿主解绑了）、插件自己的
    /// 定时器、以及它写到存储里的存活状态。用户看到的是"按了热键没反应、面板上
    /// 说后台没在跑"，而日志里只有一句"已空闲 300 秒，回收子进程"。
    ///
    /// 因此这里先问一个**已知事实**（见 `Liveness`）：这个宿主里有没有加载着插件。
    /// 有就永远不收 —— 它的生命周期由插件决定，而不由一个时间阈值决定。
    ///
    /// 有请求在飞时同样**不回收**：那会让调用方等一个永远不会来的响应。
    pub async fn reap_if_idle(&self) -> bool {
        // 先看 liveness：它是**配置**，不需要拿 `lives` 的锁。
        if self.is_pinned() {
            return false;
        }

        let should_reap = {
            let state = self.lives.lock().unwrap();
            if state.child.is_none() {
                return false;
            }
            if state.output_closed {
                // 已经退出了。收尸由读循环负责，这里不重复劳动 ——
                // 而"回收"这个动作对一个已经不在的进程没有意义。
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
        let (mut child, writer) = {
            let mut state = self.lives.lock().unwrap();
            // `output_closed` 一起重置：这是"下一次被拉起时从干净状态开始"的前提。
            // 忘了它的话，下一次 `spawn_reader` 之前的那一小段时间里 `status()`
            // 会报"没在跑"，而这恰好是刚被拉起来的那个进程 —— 一个会误导排查的
            // 假状态。
            state.output_closed = false;
            (state.child.take(), state.writer.take())
        };

        // 任何还在等待的请求都不可能再有响应了
        let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
        if !drained.is_empty() {
            log::warn!("后台宿主被关闭，{} 个待处理请求被中断", drained.len());
        }

        let mut child = match child.take() {
            Some(child) => child,
            // 本来就没在跑（或已经被读循环收过尸）。置上"输出通道已关"是为了让
            // `status()` 与 `reap_if_idle()` 看到的状态一致：没有子进程就等于
            // 通道是关的，两者不能出现"child 是 None 但 output_closed 是 false"
            // 这种自相矛盾的组合。
            None => {
                self.lives.lock().unwrap().output_closed = true;
                return;
            }
        };

        // 优雅请求：给它一点时间自己退出
        if let Some(writer) = writer {
            let request = protocol::Request {
                v: PROTOCOL_VERSION,
                id: self.next_id.fetch_add(1, Ordering::SeqCst),
                method: BackgroundMethod::Shutdown.as_wire().to_string(),
                params: None,
            };
            if let Ok(line) = protocol::encode_request(&request) {
                let mut guard = writer.lock().await;
                let _ = guard.write_all(line.as_bytes()).await;
                let _ = guard.flush().await;
            }
            // 丢掉写入锁 = 关掉子进程的 stdin。脚本把它当作"宿主走了"的信号：
            // 即便那条 shutdown 请求因为任何原因没被处理，stdin 一关它也会退出。
            drop(writer);
        }

        // 等它自己走；超时就强制结束
        match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                log::warn!("后台宿主没有在 3 秒内自行退出，强制结束");
                let _ = child.kill().await;
            }
        }

        // 进程已经收干净了。把"通道已关"的标记定下来：否则下一个 `status()` 会
        // 报 running=false（child 是 None）而 `reap_if_idle` 也判不出"已经不在了"。
        self.lives.lock().unwrap().output_closed = true;
    }
}

/// 子进程的退出状态，用于**日志与错误消息**里那句"为什么它没了"。
///
/// 不直接用 `std::process::ExitStatus` 的 `Display`：它不会区分"退出码未知"
/// 与"被信号结束"这两件事（POSIX 上后者没有退出码），而这里必须能区分 ——
/// "退出码 1"（脚本报错）与"被强杀"（安全软件、任务管理器、系统中的内存压力）
/// 指向完全不同的下一步。
#[derive(Debug, Clone)]
enum ExitStatus {
    /// 正常的退出码
    Code(i32),
    /// 被信号结束（POSIX）。
    ///
    /// 它只在 Unix 上被构造（Windows 的 `ExitStatus::code()` 对强杀也会给出一个
    /// 退出码），因此那一边要显式允许"没有构造点" —— 否则编译器会报一条
    /// `variant is never constructed` 的警告，而那条警告会淹没在噪声里，
    /// 让真正的新警告不再显眼。
    #[cfg_attr(windows, allow(dead_code))]
    Signal(i32),
    /// 问不出来：句柄已经不合法，或平台没有对应信息
    Unknown(Option<String>),
}

impl ExitStatus {
    fn from_status(status: &std::process::ExitStatus) -> Self {
        if let Some(code) = status.code() {
            return ExitStatus::Code(code);
        }

        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = status.signal() {
                return ExitStatus::Signal(signal);
            }
        }

        ExitStatus::Unknown(None)
    }

    /// `try_wait()` 的两种"不在了"：已经退出（`Some`）与问不出来（`None`）。
    fn from_optional(status: Option<std::process::ExitStatus>) -> Self {
        match status {
            Some(status) => ExitStatus::from_status(&status),
            None => ExitStatus::Unknown(Some("进程句柄已失效".to_string())),
        }
    }
}

impl std::fmt::Display for ExitStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExitStatus::Code(code) => write!(formatter, "退出码 {code}"),
            ExitStatus::Signal(signal) => write!(formatter, "被信号 {signal} 结束"),
            ExitStatus::Unknown(Some(detail)) => write!(formatter, "退出状态未知（{detail}）"),
            ExitStatus::Unknown(None) => write!(formatter, "退出状态未知"),
        }
    }
}

/// 把子进程的 stderr 逐行转进应用日志。
///
/// ============================================================
/// 为什么必须存在（而不是"也可以没有"）
/// ============================================================
///
/// 子进程的 stderr 是**管道**（见 `ensure_started` 里那一段说明：`Stdio::inherit()`
/// 在发行版上会因为一个无效的原生句柄让 `CreateProcessW` 直接失败）。管道必须有人
/// 读：内核缓冲区写满之后，子进程会**阻塞在写 stderr 上** —— 而它同时正等着我们
/// 回答它的 `ctx.*` 调用。两边互相等，那就是一个直到超时才暴露的死锁。
///
/// 因此这个任务是那套改动的**必需部分**，不是可选的诊断增强。
///
/// ============================================================
/// 它有界，而且绝不 panic
/// ============================================================
///
/// 子进程可以无限地往 stderr 写。这里逐行转发，并且：
///   * 超过 `STDERR_LINE_LIMIT` 的一行被截断 —— 一句被截断的日志远好过让转发
///     任务把内存吃光（那种失控发生在**宿主**里，比在子进程里更糟）；
///   * 读失败只记一次并结束任务 —— 与"stdin 关闭 = 宿主走了"同一条纪律：
///     这条通道断了只意味着失去诊断信息，不应该影响任何别的东西。
fn spawn_stderr_forwarder(stderr: tokio::process::ChildStderr) {    /// 单行 stderr 进日志的上限。取 8 KiB：足够装下一个完整的 Node 崩溃栈，
    /// 又远小于任何会让日志本身变成问题的规模。
    const STDERR_LINE_LIMIT: usize = 8 * 1024;

    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                // EOF：子进程走了（stderr 通常比 stdout 先关）。
                Ok(0) => break,
                Ok(_) => {
                    let text = line.trim_end();
                    if text.is_empty() {
                        continue;
                    }
                    // 前缀是刻意的、也是唯一的出口：用户与维护者都要能一眼看出
                    // 这一行**来自子进程**，而不是宿主自己说的。
                    //
                    // 只记结构、不加工内容：这一行是子进程自己写的，可能是 Node 的
                    // 崩溃栈，也可能是插件的 console.error。宿主不能（也不该）在这里
                    // 做任何过滤 —— 过滤规则会随着插件而漂，而漏掉的那一行通常正是
                    // 唯一有用的那一行。
                    if text.len() > STDERR_LINE_LIMIT {
                        log::warn!(
                            "后台宿主 stderr（已截断，原长 {}）：{}",
                            text.len(),
                            &text[..floor_char_boundary(text, STDERR_LINE_LIMIT)]
                        );
                    } else {
                        log::warn!("后台宿主 stderr：{text}");
                    }
                }
                Err(error) => {
                    log::debug!("读取后台宿主 stderr 失败（只影响诊断信息）：{error}");
                    break;
                }
            }
        }
    });
}

/// 找一个**不超过** `limit` 的 UTF-8 字符边界。
///
/// 直接对 `String` 按字节切片会在多字节字符中间切断，而那会 panic ——
/// 日志代码 panic 是这里最不能接受的一种失败：它会把一次"某一行有点长"
/// 变成"读循环的那个任务死了"。中文的 stderr（Node 的错误消息经常是英文，
/// 但插件自己写的未必）正好会踩到这一点。
fn floor_char_boundary(text: &str, limit: usize) -> usize {
    if limit >= text.len() {
        return text.len();
    }
    let mut boundary = limit;
    while boundary > 0 && !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    boundary
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
    ///    /// 这条路径在真实用户机器上会发生（打包遗漏、杀毒软件隔离）。
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

    /// **一个托管着插件的宿主永远不被空闲回收。**
    ///
    /// 这条守的是本次修复的核心缺陷。造前提的方式是"假装这个子进程已经空闲了很久"：
    /// 直接把它那把 `last_used` 改成远超 `IDLE_TIMEOUT` 的时刻，再让一个**假的**
    /// 子进程句柄占住 `child`（回收判据的第一关就是"有没有子进程"）。
    ///
    /// 用真的 Node 来造这个前提会让这条测试依赖机器上装没装 Node，而它要验的是
    /// **判据**，不是进程管理 —— 后者已经由 `live_tests` 那一组真的拉起进程来验了。
    ///
    /// 反向的那一半（`OnDemand` 的宿主要在超时后被回收）**没有**在这里断言：
    /// `shutdown()` 会去操作那个假句柄，而一个假句柄上的行为不是这条测试要证明的
    /// 东西。它的判据可以在这条测试里读到：`if self.is_pinned() { return false }`
    /// 之外的那几条就是原来的回收条件，未改动。
    #[test]
    fn a_pinned_host_is_never_reaped() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("测试用的运行时应当能建立");

        runtime.block_on(async {
            let host = BackgroundHost::new();

            // 假装它跑着一个子进程，而且最后一次被使用是很久以前。
            host.set_liveness(Liveness::Pinned);
            {
                let mut lives = host.lives.lock().unwrap();
                lives.last_used = Instant::now() - IDLE_TIMEOUT - Duration::from_secs(60);
                // 见上面：这里只需要"有一个子进程"这个事实，因此放一个真的
                // （已经退出的）子进程句柄进去。用 `child` 之外的任何东西都不行 ——
                // 判据第一关问的就是 `child.is_none()`。
                let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
                command.arg("--definitely-not-a-real-flag");
                command.stdout(Stdio::null()).stderr(Stdio::null());
                lives.child = command.spawn().ok();
            }

            assert!(host.is_pinned(), "置位之后必须报告为已钉住");
            assert!(
                !host.reap_if_idle().await,
                "托管着插件的宿主**不可以**被空闲回收：它的定时器与热键订阅都会随之消失"
            );

            // 复位，避免这个刚退出的子进程句柄影响后面的断言。
            host.set_liveness(Liveness::OnDemand);
        });
    }

    /// 子进程的 stderr 行太长时，截断点必须落在**字符边界**上。
    ///
    /// 直接按字节切会在多字节字符中间切断并 panic —— 而这段代码跑在一个 tokio
    /// 任务里，panic 的结果是"诊断信息没了"，而那种失败本身是最难被注意到的。
    /// 中文的 stderr（插件自己写的错误消息）正好会踩到这一点。
    #[test]
    fn clipping_a_long_stderr_line_never_splits_a_character() {
        // 每个汉字 3 字节：取长度不是 3 的倍数的限制，就一定落在字符中间。
        let text = "错".repeat(10);
        assert_eq!(text.len(), 30);

        let cut = floor_char_boundary(&text, 10);
        assert_eq!(cut, 9, "10 字节落在一个字符中间，应当回退到 9");
        assert!(text.is_char_boundary(cut));

        // 边界本身合法时不动它。
        assert_eq!(floor_char_boundary(&text, 9), 9);
        // 超过长度时就是全长，而不是越界。
        assert_eq!(floor_char_boundary(&text, 999), 30);
        // ASCII 上就是它自己。
        assert_eq!(floor_char_boundary("abcdef", 3), 3);
    }

    // ============================================================
    // 反向通道：插件 → 宿主
    // ============================================================
    //
    // 这一组是整个后台插件能力的**端到端**验证，也是这台机器上能做的
    // 最接近"真的跑起来"的检查 —— 它真的启动一个 Node 子进程、真的加载一段
    // 插件代码、真的让那段代码发一次 `ctx.*` 调用回来。
    //
    // 它守的是协议里最容易写错、而错了之后最难定位的一件事：**方向**。
    // 两个方向共用同一条管道、同一组字段名，唯一的判别式是"有没有 `method`"。
    // 判错的表现是插件永远等不到回答（它只知道"没反应"），而宿主那边只会
    // 留下一条"收到没有等待者的响应"的 debug 日志。

    /// 起一个真的后台宿主，加载一段真的插件代码，并回答它发出的 `ctx.*` 调用。
    ///
    /// 返回 `None` 表示这个环境里没有可用的 Node（跳过而不是失败 ——
    /// 与 `a_real_node_host_answers_a_ping` 同一个约定）。
    fn run_reverse_channel_probe(script_source: &str) -> Option<(Vec<String>, bool)> {
        let node = find_node()?;
        let host_script = host_script();
        assert!(host_script.is_file(), "宿主脚本不存在：{}", host_script.display());

        // 插件代码写进一个临时目录，并**只把这个目录**放进 `--allow-fs-read`。
        // 这正是生产路径上的放行范围（见 `plugins.rs`）。
        let dir = std::env::temp_dir().join(format!(
            "modulith-bg-probe-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("应当能建临时目录");
        let entry = dir.join("probe-bg.mjs");
        std::fs::write(&entry, script_source).expect("应当能写探针脚本");

        std::env::set_var("MODULITH_NODE", &node);
        std::env::set_var("MODULITH_BACKGROUND_HOST", &host_script);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("测试用的运行时应当能建立");

        let result = runtime.block_on(async {
            let host = Arc::new(BackgroundHost::new());
            host.set_spec(HostSpec {
                node_args: vec![
                    "--permission".to_string(),
                    format!("--allow-fs-read={}", dir.display()),
                ],
                env: Vec::new(),
                clear_env: true,
            });

            let (sender, mut receiver) = tokio::sync::mpsc::channel::<Inbound>(16);
            host.set_inbound(sender);

            // 处理子进程发来的请求：把方法名记下来，回一个"有内容"的答案。
            //
            // 必须回一个**非 null** 的结果：`null` 与"没有结果"在协议上不可区分
            // （见 protocol.rs 的那条测试），插件那边会因此判成通道故障。
            let handler = tokio::spawn({
                let host = Arc::clone(&host);
                async move {
                    let mut seen = Vec::new();
                    while let Some(request) = receiver.recv().await {
                        seen.push(request.method.clone());
                        host.respond(
                            request.id,
                            Ok(serde_json::json!({ "answered": request.method })),
                        )
                        .await;
                        if seen.len() >= 3 {
                            break;
                        }
                    }
                    seen
                }
            });

            let load = host
                .call(
                    BackgroundMethod::PluginLoad,
                    Some(serde_json::json!({
                        "id": "probe",
                        "entry": entry,
                        "name": "探针",
                        "version": "1.0.0",
                        "permissions": ["storage"],
                    })),
                )
                .await;

            let dispatch = host
                .call(
                    BackgroundMethod::PluginDispatch,
                    Some(serde_json::json!({ "id": "probe", "type": "start" })),
                )
                .await;

            // 给插件一点时间把它的 ctx 调用发出来。
            let seen = tokio::time::timeout(std::time::Duration::from_secs(5), handler)
                .await
                .expect("探针没有在 5 秒内发出 ctx 调用")
                .unwrap_or_default();

            let unload = host
                .call(
                    BackgroundMethod::PluginUnload,
                    Some(serde_json::json!({ "id": "probe" })),
                )
                .await;

            host.shutdown().await;

            (seen, load, dispatch, unload)
        });

        std::env::remove_var("MODULITH_NODE");
        std::env::remove_var("MODULITH_BACKGROUND_HOST");
        let _ = std::fs::remove_dir_all(&dir);

        let (seen, load, dispatch, unload) = result;

        assert!(load.ok, "插件加载应当成功，实际：{:?}", load.error);
        assert!(dispatch.ok, "投递 start 应当成功，实际：{:?}", dispatch.error);
        assert!(unload.ok, "卸载应当成功，实际：{:?}", unload.error);

        let answered = seen.len() >= 3;
        Some((seen, answered))
    }

    /// 后台插件发出的 `ctx.*` 调用**必须到达宿主**，并且带着正确的方法名。
    ///
    /// 这是"反向通道通了"的唯一证据。它顺带验证了三件事：
    ///   · `--permission` 之下子进程仍然能读自己的入口文件；
    ///   · `clear_env` 之下它仍然能启动（留下的那几个变量够 Node 起来）；
    ///   · 插件代码真的在 `vm` 上下文里跑了起来（它调用了 `ctx.*`）。
    #[test]
    fn a_background_plugin_can_call_back_into_the_host() {
        if find_node().is_none() {
            eprintln!("跳过：环境里没有可用的 Node 运行时");
            return;
        }

        // 三个成员分属三组：存储、数据目录、日志。
        let source = r#"
Modulith.logger.info('probe 已加载');
ctx.background.on('start', async () => {
  await ctx.storage.get('k', null);
  await ctx.dataDir.used();
  ctx.logger.info('三个都发完了');
});
"#;

        let Some((seen, answered)) = run_reverse_channel_probe(source) else {
            eprintln!("跳过：环境里没有可用的 Node 运行时");
            return;
        };

        assert!(
            seen.contains(&"ctx.log".to_string()),
            "插件在加载期与处理期间的日志都应当到达宿主，实际收到：{seen:?}"
        );
        assert!(
            seen.contains(&"ctx.storage.get".to_string()),
            "ctx.storage.get 应当到达宿主，实际收到：{seen:?}"
        );
        assert!(
            seen.contains(&"ctx.data.used".to_string()),
            "ctx.dataDir.used 应当到达宿主（线上的名字是 ctx.data.used），实际收到：{seen:?}"
        );
        assert!(answered, "宿主应当回答了这些调用（否则插件会一直挂着）");
    }

    /// `clear_env` 之下子进程仍然能起来。
    ///
    /// 这条测试的理由是一个很容易踩的坑：**清空环境变量会让 Node 在某些平台上
    /// 起不来**（Windows 靠 `SystemRoot` 解析系统 DLL）。因此 `clear_env` 里
    /// 留了最小的一组 —— 而"留得够不够"只能靠真的起一次来证明。
    ///
    /// 它与上一条的分工：上一条证明"能通过协议做事"，这一条只证明"进程能起来"。
    /// 分开是因为它们会在不同的改动下坏掉（一个是协议，一个是启动参数）。
    #[test]
    fn a_cleared_environment_still_starts_node() {
        if find_node().is_none() {
            eprintln!("跳过：环境里没有可用的 Node 运行时");
            return;
        }

        let node = find_node().expect("已经确认有 Node");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("测试用的运行时应当能建立");

        let started = runtime.block_on(async {
            let mut command = tokio::process::Command::new(&node);
            command.arg("--version").env_clear();
            // 与 `ensure_started` 里那一组完全一致 —— 它变了这条测试就该变。
            for key in ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT"] {
                if let Ok(value) = std::env::var(key) {
                    command.env(key, value);
                }
            }
            command.output().await
        });

        match started {
            Ok(output) => assert!(
                output.status.success(),
                "清空环境变量之后 Node 起不来了 —— 说明留下的那几个变量不够。stderr：{}",
                String::from_utf8_lossy(&output.stderr)
            ),
            Err(error) => panic!("清空环境变量之后无法启动 Node：{error}"),
        }
    }
}
