// src-tauri/src/modules/desktop/mod.rs
// 桌面外壳模块：系统托盘与「关闭时怎么行为」。
//
// 为什么需要一个独立模块（而不是塞进 settings）：托盘是**窗口生命周期的拥有者**，
// 它决定一个窗口的"关闭"到底意味着什么。把这件事放进设置模块会让"设置"变成
// 一个既能读写配置、又能隐藏窗口的东西 —— 职责一混，后面加"隐藏到托盘后的后台
// 插件继续运行"时就找不到该在哪一层判断。
//
// 这个模块**不拥有持久状态**：它读设置、操作窗口，两者都不需要自己的缓存。
// 因此它没有 `app.manage(...)`，命令全部是纯函数式的接线。

pub mod background;
pub mod close_behavior;
pub mod commands;
pub mod events;
pub mod tray;

use crate::prelude::*;

/// 桌面外壳模块
pub struct DesktopModule;

impl Module for DesktopModule {
    fn id(&self) -> &'static str {
        "desktop"
    }

    fn name(&self) -> &'static str {
        "桌面外壳"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "系统托盘图标、托盘菜单，以及窗口关闭时的行为"
    }

    /// 依赖 `settings`、`logging` 与 `notifications`
    ///
    /// · `settings`：托盘与关闭行为都要读写设置（`close_to_tray`）；
    /// · `logging`：托盘安装失败是一条**必须在日志里留下痕迹**的警告 ——
    ///   "托盘不可用"这条路径出问题时，日志是唯一的线索；
    /// · `notifications`：后台提醒到点时要往通知中心里放一条。这条依赖是**硬的**：
    ///   后台事件处理函数会直接取通知模块的托管状态，而模块的启动顺序由
    ///   `registry` 按依赖拓扑排序 —— 没有这条声明，处理函数可能在一个还没
    ///   初始化的通知模块上运行，表现是"提醒触发了但通知中心里什么都没有"。
    ///
    /// 声明它同时还有实际效果：这条依赖让 `desktop` 在其它模块之后启动，
    /// 而 `logging` 自己的 `stop` 会因为逆序停止而**晚于** `desktop` 停止 ——
    /// 也就是"写日志的那个模块最后收尾"。这正是日志类模块该有的位置。
    fn dependencies(&self) -> Vec<&'static str> {
        vec!["settings", "logging", "notifications"]
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        // 后台宿主的托管状态。
        //
        // **这里不拉起子进程** —— 托管一个 `BackgroundHost` 只创建一个空壳。
        // 真正的启动发生在第一次调用它的时候（"按需拉起"）。
        // 若在这里就启动，每一个从不使用后台功能的用户都要多付一个 Node 进程，
        // 而我们正在做的整件事就是降低内存占用。
        app.manage(commands::BackgroundState::new());

        // 出站事件的去向要在任何子进程被拉起**之前**装好。
        // 顺序反了的话，第一条事件会因为"没有处理函数"而被丢掉 ——
        // 而它恰好是最容易先到的那条（定时任务在同步之后马上到点）。
        if let Some(state) = app.try_state::<commands::BackgroundState>() {
            let handle = app.clone();
            state.0.set_event_handler(std::sync::Arc::new(move |event| {
                events::handle(&handle, &event);
            }));
        }

        // 定时提醒的定义存在应用侧，启动时读进内存。
        // 读失败（文件损坏）不阻止启动 —— 退化为空列表并告警。
        background::schedules::load(app);

        // 把**已有的**提醒推给后台宿主。
        //
        // 这里刻意**不**同步等待：`set_schedules` 在没有子进程时只记下定义，
        // 真正推送发生在子进程第一次被拉起的时候（`ensure_started` 里）。
        // 因此启动阶段不会有任何进程被拉起来，也不会阻塞启动。
        if app.try_state::<commands::BackgroundState>().is_some() {
            let specs = background::schedules::specs_for_host();
            if !specs.is_empty() {
                // 刻意**不**把 `State` 搬进那个任务：`State<'_, _>` 借用的是
                // `setup` 的参数，活不到 `'static`。任务里用 `AppHandle` 重新取一次
                // 托管状态 —— 那也是托管状态存在的意义。
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    use tauri::Manager;
                    let Some(state) = handle.try_state::<commands::BackgroundState>() else {
                        return;
                    };
                    // 返回值在"子进程未运行"时是 `None`，那是正常情况而不是错误 ——
                    // 定义已经记在 `BackgroundHost` 里，子进程起来时会自动收到。
                    let _ = state.0.set_schedules(specs).await;
                });
            }
        }

        // 关闭行为的判定先装：它决定窗口关闭时是退出还是隐藏。
        // 顺序上它不依赖托盘，但**必须先于托盘**的语义定下来 ——
        // 没有托盘时"隐藏到托盘"会让窗口消失且无法找回，因此下面会兜底。
        close_behavior::install(app);

        // 托盘装不上不能拖垮启动：它在部分环境里会失败（例如没有桌面会话、
        // 或被系统策略禁用）。失败只记警告，应用照常可用 ——
        // "因为画不出托盘图标所以打不开软件"是不可接受的交换。
        match tray::install(app) {
            Ok(()) => log::info!("系统托盘已就绪"),
            Err(error) => {
                log::warn!("系统托盘安装失败，应用照常运行：{error}");

                // 托盘不可用而关闭行为又是"隐藏到托盘"，用户点关闭之后窗口会消失
                // 且再也找不回来。这比"关闭按钮不管用"严重得多，因此这里**强制**
                // 回落成"直接退出"，并把回落后的值写回设置 ——
                // 界面读到的也必须是回落后的那个值，否则它显示的仍然是一个
                // 会导致窗口永久消失的选项。
                let mut current = crate::modules::settings::settings::load(app);
                if current.close_to_tray {
                    log::warn!("托盘不可用，关闭行为回落为「直接退出」");
                    current.close_to_tray = false;
                    if let Err(error) = crate::modules::settings::settings::save(app, &current) {
                        log::warn!("回落「直接退出」写回失败，关闭窗口仍会隐藏：{error}");
                    }
                }
            }
        }

        Ok(())
    }

    /// 退出前收掉后台宿主
    ///
    /// 子进程用 `kill_on_drop(true)` 创建，因此句柄被丢弃时它也会死 ——
    /// 但那是**强杀**。这里做的是优雅停止（发一条 `shutdown` 让脚本自己收尾），
    /// 而它对"后台插件需要落盘"这件事是必需的：强杀会让插件来不及保存状态。
    ///
    /// `stop` 是同步签名而 `shutdown` 是 async，这里用阻塞等待桥接。
    /// 之所以能这么做：这是**退出路径**，此时没有别的工作在等我们，
    /// 而它保证子进程真的收干净了 —— 用"发一条消息就走"的话，
    /// 应用可能在脚本还没读到那条消息时就结束了。
    fn stop(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        use tauri::Manager;

        let Some(state) = app.try_state::<commands::BackgroundState>() else {
            return Ok(());
        };

        let host = &state.0;
        if !host.status().running {
            // 从没被拉起过：什么都不用做。这是绝大多数用户的情况。
            return Ok(());
        }

        log::info!("正在停止后台宿主");

        // 在这里新建一个运行时是安全的：退出路径上原生运行时（Tauri 的 tokio）
        // 可能已经随事件循环一起收尾，而复用它会让停止动作被丢掉。
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime.block_on(host.shutdown()),
            Err(error) => {
                log::warn!("无法为后台宿主收尾建立运行时（{error}），它会被随进程一起结束");
            }
        }

        Ok(())
    }
}
