// src-tauri/src/modules/plugins/surface.rs
//
// 沙箱界面的**生命周期与几何**：建、摆、显示、隐藏、销毁。
//
// ============================================================
// 这个文件存在的唯一理由：创建 webview 不能从主线程做
// ============================================================
//
// 这不是"性能优化"，而是一次已经发生过的**整机假死**。现象是：
//
//   * 点开一个沙箱插件之后，**其余插件全部失效**；
//   * 主窗口的关闭 / 最大化 / 最小化按钮全部没反应；
//   * 托盘菜单同样没反应；
//   * 进程还活着，日志在这一刻**戛然而止**。
//
// 日志停在那一刻是有决定性的：`open_surface` 里 `add_child` 之后就是一条
// `已创建 webview` 的 info —— 那条没出现，说明 `add_child` **从来没有返回**。
//
// ============================================================
// 为什么它会卡住
// ============================================================
//
// 三条事实叠在一起：
//
//   1. `Window::add_child` 的实现是
//      `run_on_main_thread(闭包)` 再 `rx.recv().unwrap()`
//      —— **它阻塞调用它的那个线程，直到主线程把闭包跑完**
//      （tauri-2.11.5/src/window/mod.rs:1129）。
//   2. `run_on_main_thread` 在**已经身处主线程**时会短路成直接调用
//      （tauri-runtime-wry-2.11.4/src/lib.rs 的 `send_user_message`：
//      `if current_thread().id() == context.main_thread_id`）。
//   3. `#[tauri::command]` 默认是 `ExecutionContext::Blocking`
//      （tauri-macros-2.6.3/src/command/wrapper.rs:404 `body_blocking`），
//      **函数体就地执行**；而 IPC 是在 webview 的协议/消息回调里被调的，
//      那个回调跑在主线程上。
//
// 于是：主线程 → IPC 回调 → 同步命令 → `add_child` → 短路成"就地"
// → 在 **WebView2 自己的事件回调里**去同步创建另一个 WebView2 控制器
// （wry 的 `create_controller` 用 `webview2_com::wait_with_pump` 等
// `ControllerCompleted`，wry-0.55.1/src/webview2/mod.rs:414）。
// 在被回调占据的调用栈里再等一个"要靠消息泵送达"的完成通知，
// 而那个泵正是我们此刻占住的这一层 —— 主线程从此再不出来。
//
// ============================================================
// 这件事**在日志里已经被证明过一次**，只是当时没人把它当实验看
// ============================================================
//
// 同一份 `open_surface`，两条调用路径：
//
//   * 自检界面由 `spawn_debug_harness` 在**一个 spawn 出来的线程**上创建
//     —— 日志里连续三个会话都成功（`已创建 webview plugin-selftest`）；
//   * 插件界面由前端命令创建 —— 命中主线程，日志直接断在那里。
//
// 换句话说：**唯一变量就是调用线程**。这不是猜测，是已经跑出来的对照。
//
// ============================================================
// 做法：把改动窗口的那些操作全部收进一条线程
// ============================================================
//
// 本模块起一条**专属线程**（`modulith-surface`），它是全宿主唯一能动沙箱
// webview 的地方。命令不再自己动手，只把活交给它并等待回话：
//
//   * 命令成了 `async`，跑在 tokio 线程上，因此**碰不到主线程**；
//   * `add_child` 的阻塞发生在所有者线程上，主线程照常泵消息，
//     `ControllerCompleted` 能送达 —— 这正是自检界面一直能成功的那个条件；
//   * 所有界面操作**按到达顺序串行**，不会出现"关闭与摆放交错"；
//   * 阻塞 `add_child` 不落在 tokio 的工作线程上（那会让整个异步运行时变慢）。
//
// `pnpm check:sandbox` 有一条断言把这件事钉死：**`add_child` 与 webview 的
// `close` / `set_position` / `set_size` / `show` / `hide` 只允许出现在本文件里。**
// 下一个人想从别处直接建界面时，门禁会先挡住他。
//
// ============================================================
// 它不是 OS 级沙箱的一部分
// ============================================================
//
// 这里只管"界面放在哪、在不在"。身份、权限、协议在 `sandbox.rs`。

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Manager, Runtime};

use super::sandbox::ORIGIN;

// ============================================================
// 几何
// ============================================================

/// 沙箱界面在窗口里的位置与尺寸（**逻辑像素**，相对窗口客户区左上角）。
///
/// 由**前端**量出来传进来，宿主不自己算：只有前端知道标签栏、分屏、侧边栏当前
/// 各占多少。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl SurfaceBounds {
    /// 夹到至少 1×1。WebView2 不接受 0 尺寸的控件，而"内容区被折叠到 0 宽"
    /// 是一个真实会出现的状态（侧边栏展开动画的第一帧）。
    fn sanitized(self) -> Self {
        Self {
            x: self.x,
            y: self.y,
            width: self.width.max(1.0),
            height: self.height.max(1.0),
        }
    }
}

// ============================================================
// 作业
// ============================================================

/// 一次界面操作的**结果**。走 oneshot 回给等待中的命令。
type Reply = tokio::sync::oneshot::Sender<Result<(), String>>;
type Outcome = Result<(), String>;

/// 交给所有者线程的活。**每一种都会改动真实窗口**，因此只能在那里执行。
enum Job {
    /// 建（或复用）并摆到给定矩形，然后按 `visible` 显示或隐藏。
    ///
    /// `visible: false` 是**启动占位**那条路径（`ctx.ui.splash`）：宿主自己要
    /// 在那一块位置上画一块 DOM 占位，而原生 webview 盖在 DOM 之上 ——
    /// 于是只能把 webview 先建出来但**不显示**。先建出来是必须的：插件文档要
    /// 开始加载，它加载完才会把自动占位撤掉。
    ///
    /// 没有"先 show 再 hide"那种写法：那是一帧肉眼可见的闪烁，而这一条路径
    /// 每次打开插件都会走到。
    Show {
        label: String,
        plugin_id: String,
        bounds: SurfaceBounds,
        visible: bool,
        reply: Reply,
    },
    /// 重新摆放。界面不存在时静默成功 —— 布局变化时前端会无条件调用它。
    Place {
        label: String,
        bounds: SurfaceBounds,
        reply: Reply,
    },
    /// 显示或隐藏。**不销毁** —— 切标签回来时能秒回，也省下一次控制器创建。
    Visible {
        label: String,
        visible: bool,
        reply: Reply,
    },
    /// 销毁。界面不存在时静默成功。
    Close { label: String, reply: Reply },

    /// 在界面里执行一段脚本。
    ///
    /// 这是**宿主 → 插件的唯一推送通道**：事件总线、主题变化、设置变化、
    /// 通知点击回执都走它。没有它的话，插件要拿到任何"事后发生的事"都只能轮询。
    ///
    /// 为什么不直接调 `webview.eval`：`eval` 同样要落到主线程，而"所有界面操作
    /// 只在所有者线程上做"这条铁律没有例外 —— 理由见文件头，假死那一次就是从
    /// 一个"看起来无害、其实要回主线程"的调用开始的。
    Eval {
        label: String,
        script: String,
        reply: Reply,
    },
}

// ============================================================
// 所有者
// ============================================================

/// 沙箱界面的所有者线程句柄。由 Tauri 托管（见 `lib.rs`）。
pub struct SurfaceActor {
    /// `std::sync::mpsc::Sender` 是 `Send` 但**不是** `Sync`，而 Tauri 的托管
    /// 状态要求 `Send + Sync`。锁的临界区只有一次 `send`，不会成为竞争点。
    jobs: Mutex<Sender<Job>>,
}

impl SurfaceActor {
    /// 起线程并把句柄交出去。
    ///
    /// 线程自己 `recv` 到所有发送端被丢弃为止，因此应用退出时它会自然结束，
    /// 不需要额外的停机协议。
    pub fn spawn(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();

        std::thread::Builder::new()
            .name("modulith-surface".to_string())
            .spawn(move || run(app, rx))
            .expect("拿不到线程就说明进程已经到了无法继续的地步");

        Self {
            jobs: Mutex::new(tx),
        }
    }

    /// 建（或复用）并摆正，按 `visible` 显示或隐藏。
    pub async fn show(
        &self,
        label: &str,
        plugin_id: &str,
        bounds: SurfaceBounds,
        visible: bool,
    ) -> Outcome {
        let label = label.to_string();
        let plugin_id = plugin_id.to_string();
        self.submit(move |reply| Job::Show {
            label,
            plugin_id,
            bounds,
            visible,
            reply,
        })
        .await
    }

    /// 重新摆放。界面不存在时成功。
    pub async fn place(&self, label: &str, bounds: SurfaceBounds) -> Outcome {
        let label = label.to_string();
        self.submit(move |reply| Job::Place {
            label,
            bounds,
            reply,
        })
        .await
    }

    /// 显示 / 隐藏。界面不存在时成功。
    pub async fn set_visible(&self, label: &str, visible: bool) -> Outcome {
        let label = label.to_string();
        self.submit(move |reply| Job::Visible {
            label,
            visible,
            reply,
        })
        .await
    }

    /// 往界面里推一段脚本。界面不存在时**成功**（它可能已经被回收了，
    /// 而推送方不该因为"订阅者不在了"而看到一个错误）。
    pub async fn eval(&self, label: &str, script: String) -> Outcome {
        let label = label.to_string();
        self.submit(move |reply| Job::Eval {
            label,
            script,
            reply,
        })
        .await
    }

    /// 销毁。界面不存在时成功。
    pub async fn close(&self, label: &str) -> Outcome {
        let label = label.to_string();
        self.submit(move |reply| Job::Close { label, reply }).await
    }

    /// 把一条作业投出去并等回话。
    ///
    /// **这是命令与窗口之间唯一的通道。** 命令在这里 `await`，而它的未来跑在
    /// tokio 线程上 —— 主线程不参与，也就不会被 `add_child` 堵住。
    async fn submit(&self, make: impl FnOnce(Reply) -> Job) -> Outcome {
        let (reply, answer) = tokio::sync::oneshot::channel();

        {
            let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            if jobs.send(make(reply)).is_err() {
                return Err("沙箱界面线程已经停止".to_string());
            }
        }

        match answer.await {
            Ok(outcome) => outcome,
            // 发送端被丢掉 = 那条线程在处理中途没了。说清楚，而不是让调用方
            // 等一个永远不来的回话。
            Err(_) => Err("沙箱界面线程没有回话（它可能已经停止）".to_string()),
        }
    }
}

/// 所有者线程的主循环。
fn run(app: AppHandle, jobs: Receiver<Job>) {
    log::info!("[sandbox] 界面线程已就绪（沙箱 webview 只在这条线程上创建）");

    // 驻留表。**只有这条线程碰它**，因此不需要锁 —— 这正是"把所有界面操作收进
    // 一条线程"顺手买到的第二件东西。
    let mut residents: HashMap<String, Resident> = HashMap::new();

    while let Ok(job) = jobs.recv() {
        match job {
            Job::Show {
                label,
                plugin_id,
                bounds,
                visible,
                reply,
            } => {
                let outcome = show(&app, &label, &plugin_id, bounds, visible);
                if outcome.is_ok() {
                    residents.insert(
                        label.clone(),
                        Resident {
                            plugin_id,
                            last_used: Instant::now(),
                            visible,
                        },
                    );
                    enforce_cap(&app, &mut residents);
                }
                let _ = reply.send(report("显示", &label, outcome));
            }
            Job::Place {
                label,
                bounds,
                reply,
            } => {
                let outcome = place(&app, &label, bounds);
                if outcome.is_ok() {
                    touch(&mut residents, &label);
                }
                let _ = reply.send(report("摆放", &label, outcome));
            }
            Job::Visible {
                label,
                visible,
                reply,
            } => {
                let outcome = set_visible(&app, &label, visible);
                if outcome.is_ok() {
                    set_visible_flag(&mut residents, &label, visible);
                    enforce_cap(&app, &mut residents);
                }
                let _ = reply.send(report(
                    if visible { "显示" } else { "隐藏" },
                    &label,
                    outcome,
                ));
            }
            Job::Close { label, reply } => {
                let outcome = destroy(&app, &label);
                residents.remove(&label);
                forget_claim(&app, &label);
                let _ = reply.send(report("关闭", &label, outcome));
            }
            Job::Eval {
                label,
                script,
                reply,
            } => {
                let outcome = eval(&app, &label, &script);
                if outcome.is_ok() {
                    touch(&mut residents, &label);
                }
                // 推送**刻意不记 info**：它可能是每秒一次的事件，把日志刷满
                // 反而让"停在哪"这个最有用的信号失效。失败才记。
                let _ = reply.send(outcome);
            }
        }
    }

    log::info!("[sandbox] 界面线程退出");
}

// ============================================================
// 驻留上限
// ============================================================
//
// `hide` 而不 `close` 是有代价的：**用户切过的每一个沙箱插件都会留下一个渲染进程。**
// 没有上限的话，那是设计出来的内存泄漏 —— 而这个项目的目标之一恰好是内存。
//
// 因此这里必须有一道淘汰。规则只有两条：
//
//   * 超过上限时，淘汰**最久没有被用到的隐藏界面**；
//   * **正在被看着的界面永远不淘汰。** 宁可暂时多驻留一个，也不能因为用户在别处
//     打开了一个插件，就把他眼前这个销毁掉。
//
// 上限这个数字是一个**占位值**：单插件 webview 的真实内存增量还没有量过
// （[规划](../../../../docs/08-规划/插件沙箱与数据-v2.0范围.md) 第 4 步）。
// 量出来之前不把它写进设置项 —— 一个没有实测支撑的旋钮只会让人以为它有用。

/// 同时驻留的沙箱界面上限。
const MAX_RESIDENT: usize = 3;

/// 一条驻留记录。
struct Resident {
    /// 插件 id。淘汰时要靠它把界面表里的占位一起撤掉。
    #[allow(dead_code)]
    plugin_id: String,
    last_used: Instant,
    /// 当前是否可见。`: false` 的才允许被淘汰。
    visible: bool,
}

/// 刷新一条记录的"最后使用时间"。界面不存在时什么都不做。
fn touch(residents: &mut HashMap<String, Resident>, label: &str) {
    if let Some(resident) = residents.get_mut(label) {
        resident.last_used = Instant::now();
    }
}

/// 改可见标志。顺带刷一次"最后使用时间" —— 刚刚被隐藏的那个是最新的，
/// 不该立刻成为第一个淘汰对象。
fn set_visible_flag(residents: &mut HashMap<String, Resident>, label: &str, visible: bool) {
    if let Some(resident) = residents.get_mut(label) {
        resident.visible = visible;
        resident.last_used = Instant::now();
    }
}

/// 把驻留数压回上限之内。
///
/// 循环而不是 `if`：一次回收可能还不够（上限被调小、或一次投进来好几条）。
/// 但每一轮都**必须**真的销毁掉一个，否则就会转圈 —— 因此销毁失败时直接放弃，
/// 下一轮再说。
fn enforce_cap(app: &AppHandle, residents: &mut HashMap<String, Resident>) {
    while residents.len() > MAX_RESIDENT {
        let victim = residents
            .iter()
            .filter(|(_, resident)| !resident.visible)
            .min_by_key(|(_, resident)| resident.last_used)
            .map(|(label, _)| label.clone());

        let Some(label) = victim else {
            // 全都可见。这不是错误，只是一个"这一轮不回收"的状态。
            log::debug!(
                "[sandbox] 驻留 {} 个全部可见，超过上限 {MAX_RESIDENT} 但这一轮不回收",
                residents.len()
            );
            return;
        };

        let plugin_id = residents
            .get(&label)
            .map(|resident| resident.plugin_id.clone())
            .unwrap_or_default();

        match destroy(app, &label) {
            Ok(()) => {
                residents.remove(&label);
                forget_claim(app, &label);
                log::info!(
                    "[sandbox] 驻留已达上限（{MAX_RESIDENT}），回收最久未用的隐藏界面 {label}（{plugin_id}）"
                );
            }
            Err(e) => {
                log::warn!("[sandbox] 回收 {label} 失败，这一轮停止淘汰：{e}");
                return;
            }
        }
    }
}

/// 撤掉界面表里的占位。
///
/// **淘汰与关闭都必须做这一步。** 留着一条指向已被销毁界面的记录，下一次
/// `claim` 会以为"已经建过了"，于是那个插件**再也打不开**。
fn forget_claim<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(surfaces) = app.try_state::<super::sandbox::SandboxSurfaces>() {
        surfaces.forget(label);
    }
}

/// 记一条结果日志并原样返回。
///
/// **成功也记。** 假死那一次的教训正是"没有日志" —— 一个正常路径上什么都不写的
/// 模块，出问题时留下的唯一线索就是"日志停在哪"。这里的每一步都留下痕迹，
/// 于是"停在哪"就是答案。
fn report(action: &str, label: &str, outcome: Outcome) -> Outcome {
    match &outcome {
        Ok(()) => log::info!("[sandbox] {action}成功 {label}"),
        Err(e) => log::warn!("[sandbox] {action}失败 {label}：{e}"),
    }
    outcome
}

// ============================================================
// 真正动窗口的四个函数
// ============================================================
//
// 全部**只在所有者线程上**被调用。它们是本仓库里唯一还引用
// `add_child` / `close` / `set_position` / `set_size` / `show` / `hide` 的地方。

/// 建（或复用）并摆正，按 `visible` 显示或隐藏。
fn show<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    plugin_id: &str,
    bounds: SurfaceBounds,
    visible: bool,
) -> Outcome {
    if app.get_webview(label).is_none() {
        create(app, label, plugin_id, bounds)?;
    }

    let Some(webview) = app.get_webview(label) else {
        return Err(format!("{label} 建好之后仍然取不到"));
    };

    // 复用路径（切标签回来）必须显式 `show` —— 它上一次是被 `hide` 收起来的，
    // 而"摆放"不会把它重新显示出来。
    //
    // `visible: false` 那条路径（`ctx.ui.splash` 的启动占位）同样必须显式 `hide`：
    // 刚刚 `create` 出来的 webview 默认是显示的，不收起的话它会盖住宿主正要画的
    // 那块占位 —— 而"盖住了"的表现是用户看到一片空白，且不知道为什么。
    if visible {
        webview
            .show()
            .map_err(|e| format!("显示 {label} 失败：{e}"))?;
    } else {
        webview
            .hide()
            .map_err(|e| format!("隐藏 {label} 失败：{e}"))?;
    }

    apply_bounds(&webview, label, bounds)
}

/// 建一个界面。**这是全宿主唯一调用 `add_child` 的地方。**
fn create<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    plugin_id: &str,
    bounds: SurfaceBounds,
) -> Outcome {
    // 用 `core::window::main` 而不是 `get_webview_window`：后者内部的
    // `is_webview_window()` 会在一个窗口拥有多个 webview 之后变成 false。
    // 那条陷阱的完整说明在 src-tauri/src/core/window.rs。
    let Some(window) = crate::core::window::main(app) else {
        return Err("找不到主窗口".to_string());
    };

    let url = tauri::Url::parse(&format!("{ORIGIN}/{plugin_id}/"))
        .map_err(|e| format!("{plugin_id} 的地址不合法：{e}"))?;

    let builder = tauri::webview::WebviewBuilder::new(label, tauri::WebviewUrl::External(url));
    let bounds = bounds.sanitized();

    // 前后各一条。"建不出来"与"建出来了但后面某一步失败"必须能分辨 ——
    // 假死那一次两者看起来一模一样（都是没有下文）。
    log::info!(
        "[sandbox] 正在创建 webview {label}（{}×{} @ {},{})",
        bounds.width,
        bounds.height,
        bounds.x,
        bounds.y
    );

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(bounds.x, bounds.y),
            tauri::LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("创建 webview {label} 失败：{e}"))?;

    log::info!("[sandbox] 已创建 webview {label}");
    Ok(())
}

/// 重新摆放。界面不存在时成功 —— 前端在布局变化时无条件调用它。
fn place<R: Runtime>(app: &AppHandle<R>, label: &str, bounds: SurfaceBounds) -> Outcome {
    let Some(webview) = app.get_webview(label) else {
        return Ok(());
    };
    apply_bounds(&webview, label, bounds)
}

/// 显示 / 隐藏。界面不存在时成功。
fn set_visible<R: Runtime>(app: &AppHandle<R>, label: &str, visible: bool) -> Outcome {
    let Some(webview) = app.get_webview(label) else {
        return Ok(());
    };

    let result = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    result.map_err(|e| format!("切换 {label} 的可见性失败：{e}"))
}

/// 销毁。界面不存在时成功。
fn destroy<R: Runtime>(app: &AppHandle<R>, label: &str) -> Outcome {
    let Some(webview) = app.get_webview(label) else {
        return Ok(());
    };

    webview
        .close()
        .map_err(|e| format!("关闭 {label} 失败：{e}"))?;
    Ok(())
}

/// 摆位置与尺寸。两件事分开调用是 Tauri 的接口形状，不是我们的选择。
fn apply_bounds<R: Runtime>(    webview: &tauri::Webview<R>,
    label: &str,
    bounds: SurfaceBounds,
) -> Outcome {
    let bounds = bounds.sanitized();

    webview
        .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| format!("移动 {label} 失败：{e}"))?;
    webview
        .set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| format!("调整 {label} 尺寸失败：{e}"))?;

    Ok(())
}

/// 往界面里推一段脚本。界面不存在时成功。
///
/// 脚本由调用方拼好（见 `sandbox.rs` 的 `push_script`），这里只负责送达 ——
/// 在这一层再拼一次 HTML/JS 会让"谁在往插件里写东西"这条线索散成两处。
fn eval<R: Runtime>(app: &AppHandle<R>, label: &str, script: &str) -> Outcome {
    let Some(webview) = app.get_webview(label) else {
        return Ok(());
    };

    webview
        .eval(script)
        .map_err(|e| format!("向 {label} 推送脚本失败：{e}"))
}
