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
pub mod overlay;
pub mod tray;
pub mod tray_menu;

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

    /// 依赖 `settings` 与 `logging`
    ///
    /// · `settings`：托盘与关闭行为都要读写设置（`close_to_tray`），
    ///   后台宿主还要读用户指定的 Node 路径（`node_runtime_path`）；
    /// · `logging`：托盘安装失败是一条**必须在日志里留下痕迹**的警告 ——
    ///   "托盘不可用"这条路径出问题时，日志是唯一的线索。
    ///
    /// 这里曾经还依赖 `notifications` —— 那是"定时提醒到点要往通知中心里放一条"
    /// 带来的。定时提醒整条移除之后这条依赖也随之消失，而这是好的：
    /// `desktop` 现在不再需要知道通知模块长什么样。
    ///
    /// 声明依赖还有实际效果：这条依赖让 `desktop` 在 settings 之后启动，
    /// 而 `logging` 自己的 `stop` 会因为逆序停止而**晚于** `desktop` 停止 ——
    /// 也就是"写日志的那个模块最后收尾"。这正是日志类模块该有的位置。
    fn dependencies(&self) -> Vec<&'static str> {
        vec!["settings", "logging"]
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        // 后台宿主的托管状态。
        //
        // **这里不拉起子进程** —— 托管一个 `BackgroundHost` 只创建一个空壳。
        // 真正的启动发生在第一次调用它的时候（"按需拉起"）。
        // 若在这里就启动，每一个从不使用后台功能的用户都要多付一个 Node 进程，
        // 而我们正在做的整件事就是降低内存占用。
        app.manage(commands::BackgroundState::new());

        // 后台（无界面）插件的托管状态。
        //
        // 与上面那个宿主壳一样，**这里不拉起任何进程**：装了哪些后台插件要等
        // 插件注册表读完才知道，而那个时机比这里晚。真正的拉起由前端在插件列表
        // 就绪之后调一次 `background_plugins_sync` —— 在这里猜一个时机的结果是
        // "该起的没起"，而那种失败表现为随机。
        app.manage(background::plugins::BackgroundPlugins::new());

        // 宿主浮层（对话框与右键菜单）的托管状态。
        //
        // 与沙箱界面一样，**这里不显示任何东西** —— 托管一个空壳不创建窗口。
        // 真正的显示发生在插件调用 `ctx.ui.dialog` / `ctx.ui.contextMenu` 时。
        app.manage(overlay::Overlay::new());

        if let Some(state) = app.try_state::<commands::BackgroundState>() {
            // 把用户在设置里指定的 Node 路径交给后台宿主。
            //
            // 必须在**第一次拉起子进程之前**做（也就是这里），否则首次探测会用
            // 自动查找的结果 —— 而用户明明已经指过一个路径。表现是"我设了路径，
            // 第一次还是说找不到，重启之后才好"。
            let configured = crate::modules::settings::settings::load(app).node_runtime_path;
            state.0.set_configured_node(&configured);
        }

        // 关闭行为的判定先装：它决定窗口关闭时是退出还是隐藏。
        // 顺序上它不依赖托盘，但**必须先于托盘**的语义定下来 ——
        // 没有托盘时"隐藏到托盘"会让窗口消失且无法找回，因此下面会兜底。
        close_behavior::install(app);

        // 自绘托盘菜单窗口的"失去焦点就收起来"行为。
        //
        // 必须**早于**托盘安装：托盘一装好，用户就可能右键，而那时如果这个
        // 行为还没装上，菜单弹出来之后就再也不会自己关闭 —— 它会一直挂在屏幕上
        // 挡住别的东西，用户唯一的办法是再点一次托盘图标（而那时它又会重新
        // 显示在同一个地方，看起来像是"点了没反应"）。
        tray_menu::install(app);

        // 宿主浮层"失去焦点就收起来"的行为。
        //
        // 与托盘菜单同一套理由：没有它，用户点了别处之后浮层还挂在屏幕上挡着
        // 东西，而它看起来像"卡住了"。顺带把还在等的插件调用撤掉 ——
        // 它们已经不可能有回答了。
        overlay::install(app);

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

        // 后台插件先停：它们各自是一个 Node 进程，而其中任何一个都可能正在
        // 写数据。顺序反过来的话，通用的后台宿主会先走，而插件进程还在跑着。
        let plugins = app.try_state::<background::plugins::BackgroundPlugins>();
        let generic = app.try_state::<commands::BackgroundState>();

        let needs_runtime = plugins
            .as_ref()
            .map(|state| !state.inner().status(app).is_empty())
            .unwrap_or(false)
            || generic
                .as_ref()
                .map(|state| state.inner().0.status().running)
                .unwrap_or(false);

        if !needs_runtime {
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
            Ok(runtime) => {
                if let Some(state) = &plugins {
                    runtime.block_on(state.inner().stop_all());
                }
                if let Some(state) = &generic {
                    runtime.block_on(state.inner().0.shutdown());
                }
            }
            Err(error) => {
                log::warn!("无法为后台宿主收尾建立运行时（{error}），它会被随进程一起结束");
            }
        }

        Ok(())
    }
}
