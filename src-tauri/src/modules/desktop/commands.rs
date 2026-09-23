// src-tauri/src/modules/desktop/commands.rs
//
// 桌面外壳的命令。
//
// 只有两条，都是"回报事实"而不是"改变行为"：
//   · 托盘在当前环境是否装上了（装不上时界面要如实说明，而不是显示一个假的开关）；
//   · 关闭窗口当前会怎样（托盘菜单里也能改这一项，因此界面需要能重新读到它）。
//
// **读取当前值**这条命令不是多余的：关闭行为有两个入口（设置页与托盘右键菜单），
// 用户在托盘菜单里改过之后，设置页上那个开关必须显示新的值 —— 否则界面会
// 与真实行为相反，而那是用户最难察觉的一类错误。

use crate::modules::desktop::background::{
    self, BackgroundHost, BackgroundStatus, CallOutcome,
};
use crate::modules::desktop::tray;
use crate::modules::desktop::tray_menu;
use crate::modules::settings::settings;
use crate::prelude::*;
use tauri::State;

/// 后台宿主的托管状态。
///
/// 它自己不需要持久状态（子进程的生命周期由它内部管理），托管它只是为了让命令
/// 能拿到同一个实例 —— 每次调用各建一个的话，"按需拉起"会变成"每次调用都拉起
/// 一个新进程"。
pub struct BackgroundState(pub BackgroundHost);

impl BackgroundState {
    pub fn new() -> Self {
        Self(BackgroundHost::new())
    }
}

impl Default for BackgroundState {
    fn default() -> Self {
        Self::new()
    }
}

/// 后台宿主的可用状态（设置 → 性能）
///
/// **不启动子进程**：状态查询不该有副作用 —— 用户只是打开设置页看一眼，
/// 不该因此拉起一个 Node 进程。要真的启动它，用下面那条探测命令。
///
/// 找不到 Node 运行时时返回 `available: false` 与**具体原因**，而不是让界面
/// 每次调用都收到一个 invoke 失败。后台能力不可用是一件事，报错是另一件事。
#[tauri::command]
pub fn background_host_status(state: State<'_, BackgroundState>) -> BackgroundStatus {
    state.inner().0.describe()
}

/// 自动查找 Node 运行时，返回找到的路径与**查找过程**。
///
/// 存在的理由是用户的实际困难：在 cmd 里敲 `node --version` 有版本，应用里却
/// 说找不到。那条路径上真正需要的是"你到底找了哪些地方"，而不是一句"未找到"。
///
/// 它**不写设置** —— 查出结果由用户决定要不要采用。一个"点一下就悄悄改掉配置"
/// 的按钮会让用户不知道自己的设置被动过。
#[tauri::command]
pub fn detect_node_runtime(app: AppHandle, state: State<'_, BackgroundState>) -> NodeDetection {
    use crate::modules::settings::settings;

    let configured = settings::load(&app).node_runtime_path;
    let host = &state.inner().0;

    // 让宿主按**当前设置**重新解析一次（而不是用上一次的缓存）：
    // 用户可能刚手工改过 settings.json，而缓存里还是旧结果。
    host.set_configured_node(&configured);

    let configured_path = if configured.trim().is_empty() {
        None
    } else {
        Some(configured)
    };

    match host.probe_node() {
        Ok(path) => NodeDetection {
            found: true,
            path: Some(path.display().to_string()),
            reason: None,
            configured_path,
        },
        Err(reason) => NodeDetection {
            found: false,
            path: None,
            reason: Some(reason),
            configured_path,
        },
    }
}

/// 手工指定 Node 可执行文件的路径（设置 → 性能）
///
/// ============================================================
/// 为什么要有它（而不是只提供环境变量）
/// ============================================================
///
/// 环境变量对普通用户不友好：要打开系统设置、找到"环境变量"、新建一条、再重启
/// 应用。而"把文件放进安装目录"要求用户先知道安装目录在哪。
///
/// 结果是后台功能明明可用（用户的 PATH 上就有 node），界面上却只说"未找到"。
/// 因此提供一条**在界面里选一次就记住**的路径。
///
/// ============================================================
/// 会校验，不是照单全收
/// ============================================================
///
/// 传进来的路径必须真的**能跑起来**：存在、是文件、而且能应答一次握手。
/// 只检查 `is_file()` 不够 —— 用户完全可能选到别的同名文件，或者一个缺 DLL 的
/// 残包。那种情况下"保存成功"是谎话，而失败要等到几个小时后的定时提醒才被发现。
#[tauri::command]
pub async fn set_node_runtime_path(
    app: AppHandle,
    state: State<'_, BackgroundState>,
    path: String,
) -> Result<CallOutcome, String> {
    use crate::modules::settings::settings;

    let trimmed = path.trim().to_string();

    // 空字符串 = 清掉手工指定，恢复自动探测。这是一条正当操作，不是错误。
    if trimmed.is_empty() {
        let mut current = settings::load(&app);
        current.node_runtime_path = String::new();
        settings::save(&app, &current)?;
        state.inner().0.set_configured_node("");
        log::info!("Node 运行时路径已清空，恢复自动探测");
        return Ok(CallOutcome {
            ok: true,
            result: None,
            error: None,
        });
    }

    if !std::path::Path::new(&trimmed).is_file() {
        return Err(format!("这个路径不是一个文件：{trimmed}"));
    }

    // 先落盘再验证：验证要拉起子进程，而它读的是**设置里的值**。
    // 顺序反了的话验证用的是旧配置，于是"验证通过"可能验证的是另一个 Node。
    let mut current = settings::load(&app);
    let previous = current.node_runtime_path.clone();
    current.node_runtime_path = trimmed.clone();
    settings::save(&app, &current)?;
    state.inner().0.set_configured_node(&trimmed);

    // 真的拉起一次。它走完整的启动握手，因此验证的是"这个 Node 能跑我们的脚本"。
    let outcome = state.inner().0.ping().await;

    if !outcome.ok {
        // **验证失败就回滚**：留下一个跑不起来的路径，表现是"设置里看着配好了、
        // 后台功能却不可用" —— 那比一次明确的失败糟得多。
        let mut rolled = settings::load(&app);
        rolled.node_runtime_path = previous.clone();
        if let Err(error) = settings::save(&app, &rolled) {
            log::warn!("回滚 Node 路径失败，设置里可能留下一个不可用的路径：{error}");
        }
        state.inner().0.set_configured_node(&previous);

        return Err(format!(
            "这个 Node 运行时无法启动后台宿主：{}",
            outcome.error.unwrap_or_else(|| "原因未知".to_string())
        ));
    }

    log::info!("Node 运行时路径已设为 {trimmed}，并验证通过");
    Ok(outcome)
}

/// Node 运行时的探测结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetection {
    /// 是否找到了一个可用的 Node
    pub found: bool,
    /// 找到时的可执行文件路径
    pub path: Option<String>,
    /// 没找到时的**具体原因**
    pub reason: Option<String>,
    /// 当前设置里手工指定的路径（没有则为 `null`）
    pub configured_path: Option<String>,
}

/// 探测后台宿主：真的拉起子进程跑一次握手与存活探测。
///
/// 这是唯一一个会启动子进程的命令，也是"设置里点一下试试"的入口。
/// 失败时把原因原样返回（不是抛错）—— 界面要显示的是"为什么不可用"，
/// 而不是一个异常对象。
#[tauri::command]
pub async fn background_host_probe(state: State<'_, BackgroundState>) -> Result<CallOutcome, String> {
    Ok(state.inner().0.ping().await)
}

/// 主动回收后台宿主（设置 → 性能）
///
/// 给用户一个"现在就关掉它"的入口。"按需拉起 + 空闲回收"里的回收目前是手动的
/// —— 自动回收要等后台插件真的能跑起来之后才有意义（现在它拉起后什么都不做，
/// 自动回收只会让"它到底在不在跑"更难观察）。
#[tauri::command]
pub async fn background_host_shutdown(
    state: State<'_, BackgroundState>,
) -> Result<BackgroundStatus, String> {
    state.inner().0.shutdown().await;
    Ok(state.inner().0.describe())
}

/// 读取当前「关闭窗口时最小化到托盘」的设置
///
/// 托盘菜单可以改这一项，因此界面不能只依赖自己那份设置缓存 ——
/// 它会在用户从托盘改过之后变成陈旧副本。
#[tauri::command]
pub fn get_close_to_tray(app: AppHandle) -> bool {
    settings::load(&app).close_to_tray
}

/// 写回「关闭窗口时最小化到托盘」，并同步托盘菜单的勾选状态
///
/// **保持菜单勾选与设置一致是这条命令的一部分**，不是额外工作：
/// 少了它，用户会在设置页关掉这个开关、再右键托盘发现它还勾着，
/// 而那个勾是错的（行为已经跟着设置变了）。
#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let mut current = settings::load(&app);
    current.close_to_tray = enabled;
    settings::save(&app, &current)?;

    // 托盘可能没装成功（无桌面会话等），此时同步是空操作而不是错误。
    tray::sync_menu_check(&app, enabled);

    log::info!(
        "关闭窗口的行为已改为：{}",
        if enabled { "隐藏到托盘" } else { "直接退出" }
    );

    Ok(enabled)
}

/// 系统托盘在当前环境是否可用
///
/// 装不上时界面必须如实说明。一个"显示为已开启、实际什么都没做"的开关
/// 比"这个环境不支持"糟得多：用户会以为自己在窗口关掉之后仍能收到通知。
#[tauri::command]
pub fn is_tray_available(app: AppHandle) -> bool {
    app.tray_by_id(tray::TRAY_ID).is_some()
}

// ============================================================
// 自绘托盘菜单
// ============================================================

/// 托盘菜单里那一项的**当前值**。
///
/// 每次弹出菜单都重新读一遍，而不是缓存：它与设置页里的开关是同一项设置，
/// 用户完全可能在两次右键之间从设置页改掉它。缓存的表现是"设置里改了、
/// 菜单里还显示旧值"，而那看起来就像设置没生效。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuState {
    /// 「关闭窗口时最小化到托盘」的当前值
    pub close_to_tray: bool,
    /// 托盘本身是否可用。为 false 时菜单**不显示**那个开关 ——
    /// 后端在托盘不可用时已经把关闭行为回落成"直接退出"，
    /// 显示一个勾着的开关会与真实行为相反。
    pub tray_available: bool,
}

#[tauri::command]
pub fn tray_menu_state(app: AppHandle) -> TrayMenuState {
    TrayMenuState {
        close_to_tray: settings::load(&app).close_to_tray,
        tray_available: app.tray_by_id(tray::TRAY_ID).is_some(),
    }
}

/// 主窗口收到「托盘菜单请求了一个动作」的事件名。
///
/// 事件里带的是动作名（`settings` / `update`），由主窗口的前端决定"要打开哪个界面"。
/// 后端不做这件事，因为它不知道界面长什么样 —— 它只知道"用户要设置"。
pub const TRAY_ACTION_EVENT: &str = "modulith://tray-action";

/// 执行托盘菜单里的一个动作。
///
/// ============================================================
/// 为什么动作由后端分派，而不是菜单窗口自己做
/// ============================================================
///
/// 这个菜单窗口只有 268×316 像素、生命周期以百毫秒计，它不该知道主窗口的
/// 任何状态（可见性、当前分页、是否已解锁）。那三件事后端才知道怎么做 ——
/// 窗口可能不存在、可能被隐藏、可能在另一块显示器上。
///
/// 因此菜单只把"用户点了哪个"传过来，剩下的在这里决定。
///
/// ============================================================
/// 返回值是"失败原因"而不是 Result
/// ============================================================
///
/// 返回 `Result` 会让前端把成功/失败分成两条路径，而这里几乎所有动作都会成功；
/// 真正需要显示的是**那一条失败的原因**（例如"托盘不可用，无法切换"）。
/// 因此成功返回 `None`，失败返回一句可以直接显示给用户的话。
///
/// 失败时**不隐藏菜单**：隐藏了用户就看不到出了什么事，只会觉得"点了没用"。
#[tauri::command]
pub async fn tray_menu_action(
    app: AppHandle,
    state: State<'_, BackgroundState>,
    action: String,
) -> Result<Option<String>, String> {
    match action.as_str() {
        // 显示主窗口并把它收到托盘菜单后面
        "show" => {
            tray::show_main_window(&app);
            tray_menu::hide(&app);
            Ok(None)
        }

        // 打开设置。**先把窗口显示出来再发事件** —— 事件是发给前端监听器的，
        // 而一个隐藏窗口的前端监听器照样收得到；但用户看不见窗口就不知道发生了
        // 什么，因此顺序上先显示更符合预期。
        "settings" => {
            tray::show_main_window(&app);
            tray_menu::hide(&app);
            emit_action(&app, "settings");
            Ok(None)
        }

        // 检查更新。打开「关于」分页并由前端发起一次检查。
        "update" => {
            tray::show_main_window(&app);
            tray_menu::hide(&app);
            emit_action(&app, "update");
            Ok(None)
        }

        // 释放资源：回收工作集 + 关掉空闲的后台宿主。
        //
        // 这一条**刻意不显示主窗口**：它的语义是"现在别占资源了"，
        // 而把一个大窗口弹到屏幕上是反着来的。
        //
        // 也**不清掉记下的定时任务定义**：那些定义来自磁盘上的用户设置，
        // 下次有后台调用时会被重新推给新拉起的子进程。清掉它们等于"重置"，
        // 而一个点一下就改变后台行为、却不改设置的菜单项太危险了。
        "free" => {
            let trim = crate::modules::settings::memory_trim::trim_self_tree();
            let host_was_running = state.inner().0.status().running;
            state.inner().0.shutdown().await;

            log::info!(
                "托盘菜单：释放资源 —— 回收了 {}/{} 个进程的工作集{}",
                trim.trimmed,
                trim.attempted,
                if host_was_running { "，后台宿主已停止" } else { "" }
            );

            if !trim.supported {
                return Ok(Some("当前平台不支持回收工作集".to_string()));
            }
            if trim.trimmed == 0 && trim.attempted > 0 {
                return Ok(Some(format!("{} 个进程都打不开，未能回收", trim.attempted)));
            }
            Ok(None)
        }

        // 切换「关闭窗口时最小化到托盘」
        "toggle_close_to_tray" => {
            if app.tray_by_id(tray::TRAY_ID).is_none() {
                // 托盘不可用时不切换：切了会让窗口消失且再也叫不回来。
                // 这条路径后端在启动时已经处理过，这里是同一判据的第二道闸。
                return Ok(Some("托盘不可用，关闭行为已回落为直接退出".to_string()));
            }
            let next = set_close_to_tray(app.clone(), !settings::load(&app).close_to_tray)?;
            log::info!(
                "托盘菜单：关闭窗口的行为已改为 {}",
                if next { "隐藏到托盘" } else { "直接退出" }
            );
            Ok(None)
        }

        "exit" => {
            log::info!("用户从自绘托盘菜单退出应用");
            // 这里**不**隐藏菜单：退出是一个异步过程，菜单在窗口销毁前还会
            // 显示一小会儿。提前隐藏会露出下面的桌面，看起来像闪了一下。
            app.exit(0);
            Ok(None)
        }

        other => {
            // 未知动作**明确报错**，而不是静默成功。静默成功会让"菜单项接错了"
            // 变成一件没有线索的事（用户点了，界面没反应，也没有报错）。
            log::warn!("自绘托盘菜单请求了未知动作：{other}");
            Ok(Some(format!("未知动作：{other}")))
        }
    }
}

/// 把动作名发给主窗口的前端
fn emit_action(app: &AppHandle, action: &str) {
    use tauri::Emitter;
    if let Err(error) = app.emit(TRAY_ACTION_EVENT, action) {
        // 广播失败只记日志：窗口已经显示出来了，用户至少能看到主界面。
        log::warn!("广播托盘动作「{action}」失败：{error}");
    }
}

// ============================================================
// 定时提醒
// ============================================================
//
// 命令外壳统一放在这里，而不是放在 `background/schedules.rs` 里 ——
// `scripts/generate-backend-module.ts` **只扫描 `<模块>/commands.rs`**，
// 写在别处的命令属性会被静默忽略，直到运行期 `invoke` 报
// "command not found" 才暴露。
//
// 上面那句刻意不写成带井号的属性字面量：生成器是按**出现次数**与解析出的函数名
// 做对账的，而它不认注释 —— 注释里写一次属性，就会让它报"13 处属性、12 个函数"。

/// 列出全部定时提醒（定义，不含运行状态）
#[tauri::command]
pub fn list_reminders() -> Vec<background::schedules::Reminder> {
    background::schedules::list()
}

/// 新增或修改一条提醒，返回改动后的完整列表
///
/// 返回整份列表（而不是那一条）的理由与通知模块相同：前端只需整个替换缓存，
/// 不需要自己重演"该插到哪、命中时改哪条、超限时丢哪些"。
#[tauri::command]
pub async fn save_reminder(
    app: AppHandle,
    state: State<'_, BackgroundState>,
    input: background::schedules::ReminderInput,
) -> Result<Vec<background::schedules::Reminder>, String> {
    let snapshot = background::schedules::upsert(&app, input)?;
    sync_reminders(&state).await;
    Ok(snapshot)
}

/// 删除一条提醒，返回改动后的完整列表
#[tauri::command]
pub async fn delete_reminder(
    app: AppHandle,
    state: State<'_, BackgroundState>,
    id: String,
) -> Result<Vec<background::schedules::Reminder>, String> {
    let snapshot = background::schedules::remove(&app, &id)?;
    sync_reminders(&state).await;
    Ok(snapshot)
}

/// 启用/停用一条提醒，返回改动后的完整列表
#[tauri::command]
pub async fn set_reminder_enabled(
    app: AppHandle,
    state: State<'_, BackgroundState>,
    id: String,
    enabled: bool,
) -> Result<Vec<background::schedules::Reminder>, String> {
    let snapshot = background::schedules::set_enabled(&app, &id, enabled)?;
    sync_reminders(&state).await;
    Ok(snapshot)
}

/// 后台宿主侧的定时任务运行状态（下一次什么时候响、响过几次）
///
/// **读的是后台宿主的回答，不是我们算出来的**：如果子进程没在跑，这里返回
/// 一个带 `reason` 的失败结果，界面据此显示"后台未运行，当前没有在计时"。
/// 自己算一份时刻会让界面显示一个可能与真实执行不同的值 —— 那比不显示更糟。
///
/// 另外它会**顺带报告定义与运行态是否一致**：定义里有 3 条启用的提醒、
/// 而子进程只报 2 条，说明同步没跟上。这个数字对排查"提醒不响"很关键。
#[tauri::command]
pub async fn reminder_runtime(
    state: State<'_, BackgroundState>,
) -> Result<ReminderRuntimeReport, String> {
    let host = &state.inner().0;
    let enabled = background::schedules::specs_for_host().len();
    let outcome = host.list_schedules().await;

    let runtime: Vec<background::schedules::ReminderRuntime> = outcome
        .result
        .as_ref()
        .and_then(|value| value.get("schedules"))
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();

    Ok(ReminderRuntimeReport {
        ok: outcome.ok,
        error: outcome.error,
        enabled_definitions: enabled,
        // `host_running` 与 `error` 一起看：都是 false/Some 时就是"后台没在跑"。
        host_running: host.status().running,
        runtime,
    })
}

/// 立刻触发一次某条提醒（"现在试一下"）
///
/// 走的是与定时器**完全相同**的触发路径，因此它验证的是真实的链路 ——
/// 从后台宿主发出事件，到通知中心里出现一条提醒。这是唯一能在一个动作里
/// 验证整条链路的方式，也是"设置里点一下"该有的行为。
#[tauri::command]
pub async fn run_reminder_now(
    state: State<'_, BackgroundState>,
    id: String,
) -> Result<CallOutcome, String> {
    Ok(state.inner().0.run_schedule_now(&id).await)
}

/// 提醒的运行态报告
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRuntimeReport {
    /// 后台宿主是否回答了这次查询
    pub ok: bool,
    /// 没回答时的原因（最常见的是"后台未运行"）
    pub error: Option<String>,
    /// 应用侧启用的提醒条数
    pub enabled_definitions: usize,
    /// 子进程当前是否活着
    pub host_running: bool,
    /// 子进程侧的逐条状态
    pub runtime: Vec<background::schedules::ReminderRuntime>,
}

/// 把当前启用中的提醒推给后台宿主。
///
/// 私有函数而不是命令：它是上面三条改动命令**共同的后半步**，而不是一个
/// 用户能单独触发的动作。漏掉它的表现是"改完提醒之后它还是按老时间响"。
///
/// 推送失败**不让命令失败**：定义已经落盘了，而子进程可能只是还没起来 ——
/// 那种情况下 `BackgroundHost` 会在它下次启动时自动补推。
async fn sync_reminders(state: &State<'_, BackgroundState>) {
    let specs = background::schedules::specs_for_host();
    let count = specs.len();

    if let Some(outcome) = state.inner().0.set_schedules(specs).await {
        if outcome.ok {
            log::info!("已向后台宿主同步 {count} 条定时提醒");
        } else {
            log::warn!(
                "向后台宿主同步定时提醒失败（定义已保存，子进程重启时会重试）：{:?}",
                outcome.error
            );
        }
    }
}
