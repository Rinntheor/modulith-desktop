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
