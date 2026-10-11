// src-tauri/src/modules/plugins/safe_mode.rs
//
// 安全模式：插件把宿主弄到"起不来"时的逃生舱。
//
// ============================================================
// 它解决的问题：一条已知的、无法救回的通路
// ============================================================
//
// `pluginRuntime.ts::loadPlugin` 的注释把这件事写得很清楚：
//
//   > JS 是单线程的，插件 bundle 顶层的同步死循环**无法被中断** —— 一旦发生，
//   > 界面会一起卡住。超时能做到的只是不再把后续插件的时间也算在这个插件头上。
//
// 于是一个 in-process 插件只要在 bundle 顶层写 `while(true){}`：
//
//   1. 它命中 eager（`activationEvents` 缺省，或写了 `onStartup`）→ 启动时执行；
//   2. 渲染进程被占满 → 启动门禁永远停在进度条；
//   3. 设置 → 插件页打不开 → **用户无法禁用它**；
//   4. 唯一的出路是手工去 `%APPDATA%` 删目录 —— 普通用户做不到。
//
// 沙箱化削减了这条通路（沙箱插件的 bundle 不再进宿主 realm），但没有消除它：
// `runtime: "in-process"` 的插件仍然可以，而沙箱 iframe 里的死循环在 WebView2 下
// 同样可能卡死整个渲染进程。
//
// ============================================================
// 机制：一对标记 + 一次自动回避
// ============================================================
//
// 两个标记文件，各自记录一件**不同**的事实：
//
//   * `boot_incomplete` —— "这一次启动正在进行"。启动时写，干净退出时删。
//   * `boot_ok`         —— "这一次启动确实成功过"。启动成功之后写，干净退出时删。
//
// 于是"上一次是怎么结束的"可以**只看这两个标记的组合**读出来（见 `decide`）：
//
//   两个都不在            → 上一次走完了退出流程（或者从来没启动过）→ 正常启动；
//   incomplete 在、ok 不在 → 上一次**死在启动阶段**，插件嫌疑最大 → 进安全模式；
//   incomplete 在、ok 也在 → 上一次**跑起来过**，只是没走完退出流程
//                            （任务管理器结束进程 / 关机 / 收尾阶段崩溃）
//                            → **不进安全模式**，清掉残留标记。
//
//   ============================================================
//   为什么必须要有 `boot_ok`（这条修复的全部理由）
//   ============================================================
//
//   只有 `boot_incomplete` 一个标记时，"上一次没有正常退出"与"上一次死在启动
//   阶段"是**同一件事** —— 因为标记在每次启动时都被写下，而只有走完正常退出
//   才会被删掉。于是**任何**非正常结束（任务管理器结束进程、崩溃、关机、
//   开发时反复 kill、应用运行时被重新构建覆盖）都会让下一次启动进安全模式，
//   并把原因归咎于插件 —— 而那是一次**误报**：用户当时并没有任何插件把应用
//   弄到起不来。
//
//   误报的代价被这个机制的设计放大了：安全模式的退出动作是"干净地关闭应用"
//   （见下），所以一次误报之后用户会**连续**看到它，直到他真的正常关一次应用。
//
//   有了 `boot_ok`，两种情况就分开了：只有"连启动都没走完"才值得假定是插件干的。
//
// 安全模式只做一件事：**不让前端自动加载插件**（插件仍然列在设置 → 插件里，
// 用户可以禁用/卸载它们）。这样应用一定能起来，用户也一定能拿到那个页面。
//
// 为什么标记必须由 **Rust** 写，而不是前端：插件卡住的正是渲染进程 ——
// 那时前端已经没有机会执行任何一行代码。Rust 在 `PluginsModule::setup` 里写它，
// 那一步发生在事件循环启动之前，插件根本没有代码在跑。
//
// ============================================================
// `boot_ok` 是什么时候写的：判据必须与插件无关
// ============================================================
//
// 由 `mark_boot_ok` 命令写，调用点在前端的**插件那一步刚开始、任何插件 bundle
// 执行之前**（`src/services/boot.ts` 的 `plugins` 步骤）。也就是说，这个标记的
// 语义是：
//
//   "窗口起来了、后端就绪了、渲染进程跑完了自己前面的全部启动步骤，
//     现在轮到插件了。"
//
// 这正是"上一次启动成功了没有"这个问题唯一诚实的答案 —— 因为插件能造成的
// 最坏结果恰好是"从这里开始就没有下一步了"。
//
//   ============================================================
//   为什么不用"延时 N 秒"或"主窗口显示"当判据
//   ============================================================
//
//   两者都与"插件有没有把渲染进程卡死"**不等价**，而且是往**危险**的方向不等价：
//
//     * 延时几十秒的判据跑在 Rust 侧（不是渲染进程）。插件把渲染进程卡死时，
//       事件循环照样转、定时器照样到点 —— 那个判据会在应用已经卡死的情况下
//       写下 `boot_ok`，于是**下一次启动不进安全模式**。安全模式恰好失效在
//       它唯一要处理的那种情形上；
//     * "主窗口显示"同理：窗口在插件执行**之前**就已经显示了。
//
//   因此判据只能来自渲染进程**自己**走到某一步这一事实。而它还必须与插件无关：
//   安全模式下插件本来就不执行，任何依赖插件的判据（"插件加载完了吗"）
//   在安全模式里永远不成立 —— 那会让安全模式**永远出不来**。
//
// ============================================================
// 为什么不需要"退出安全模式"这个按钮
// ============================================================
//
// 两个标记都在**干净退出**时被删掉。用户在安全模式里禁用了那个坏插件，然后
// 正常关闭应用，标记就都没了 —— 下一次启动照常加载插件。也就是说"退出安全模式"
// 这个动作就是**关闭并重开应用**，不需要额外的界面与状态。
//
// 代价是：如果用户什么都不做就关掉应用，下一次仍会卡住、再下一次仍进安全模式。
// 这是有意的 —— 一个会自动"恢复正常"然后立刻再卡一次的安全模式，等于没有；
// 而通知里会明确写出"请到设置 → 插件里禁用可疑的插件"。
//
// ============================================================
// 环境变量逃生舱
// ============================================================
//
// `MODULITH_SAFE_MODE=1` 强制进入安全模式。它不依赖上面那套推断，
// 因此适用于"标记文件被删了 / 判断错了 / 开发时要复现一个插件问题"这些情况。
// 一个只能靠"上一次崩过"才能进入的安全模式，在真的需要它时会不够用。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 环境变量逃生舱的名字。
pub const ENV_VAR: &str = "MODULITH_SAFE_MODE";

/// "这一次启动正在进行"的标记文件名。
///
/// 放在应用数据目录（`app_data_dir`）而不是插件数据根：插件数据根是**用户可换**
/// 的，而"上一次有没有走干净"是应用自身的事实，不该随数据盘一起搬家 ——
/// 换了盘就丢掉这个状态，正好会漏掉"换盘那一次崩了"。
const MARKER_INCOMPLETE: &str = "boot_incomplete";

/// "这一次启动确实成功过"的标记文件名。
///
/// 与 `MARKER_INCOMPLETE` 成对使用，理由见文件头。"成功"的定义见 `mark_boot_ok`。
const MARKER_OK: &str = "boot_ok";

/// 暴露给前端的形态。
///
/// `reason` 是给**人**读的一句解释，不是枚举：界面把它原样显示出来即可，
/// 多一个枚举就多一处要维护的映射，而这里只有三种来源。
///
/// `PartialEq` / `Eq` 只服务于单元测试：`decide` 的"纯函数"那条断言要能直接比
/// 两次判定的结果是否相等。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeModeState {
    pub active: bool,
    pub reason: Option<String>,
}

/// 一次启动判定的结果，除了给前端看的状态以外还带一个**只看日志**的口径。
///
/// `previous_boot_was_clean` 进不了 `reason`（而且按定义不进安全模式），但它值得
/// 记一条 `log::info!`：用户报"我上次明明是被任务管理器结束的，怎么没进安全模式"
/// 时，这条日志就是答案。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Decision {
    state: SafeModeState,
    previous_boot_was_clean: bool,
}

/// 判定是否进入安全模式。
///
/// **纯函数**：只看三个布尔量，不碰文件系统、不读环境变量。文件系统的读写留在
/// `install` 与 `mark_*` 里，这个函数只负责"这四个输入组合各自意味着什么"——
/// 而那正是这套机制里唯一容易写错、也唯一能被证伪的部分。
///
/// 判定顺序即优先级：**环境变量最高**（它是逃生舱，不能被推断覆盖）；其余三种
/// 组合见文件头那张表。
fn decide(forced: bool, incomplete: bool, ok: bool) -> Decision {
    if forced {
        return Decision {
            state: SafeModeState {
                active: true,
                reason: Some(format!("环境变量 {ENV_VAR} 已设置，强制进入安全模式")),
            },
            previous_boot_was_clean: false,
        };
    }

    match (incomplete, ok) {
        // 上一次死在启动阶段：插件嫌疑最大 → 维持保护强度。
        (true, false) => Decision {
            state: SafeModeState {
                active: true,
                reason: Some(
                    "上一次启动没有正常退出（很可能是某个插件让它卡住或崩掉了）。\
                     插件本次没有被加载 —— 请到「设置 → 插件」里禁用可疑的插件，再关闭并重开应用。"
                        .to_string(),
                ),
            },
            previous_boot_was_clean: false,
        },
        // 上一次跑起来过，只是没走完退出流程（被杀 / 关机 / 收尾阶段崩溃）。
        // **这不是插件问题，不该进安全模式** —— 这正是本次修复要修掉的误报。
        (true, true) => Decision {
            state: SafeModeState {
                active: false,
                reason: None,
            },
            previous_boot_was_clean: false,
        },
        // 正常启动（含"干净退出过"与"第一次启动"两种情形）。
        (false, _) => Decision {
            state: SafeModeState {
                active: false,
                reason: None,
            },
            previous_boot_was_clean: true,
        },
    }
}

/// 安全模式状态（由 Tauri 托管）。
pub struct SafeMode {
    state: SafeModeState,
    /// `boot_incomplete` 的完整路径。两个 `None` 表示拿不到应用数据目录，
    /// 此时安全模式退化为"只用环境变量"。
    incomplete: Option<PathBuf>,
    /// `boot_ok` 的完整路径。见 `MARKER_OK`。
    ok: Option<PathBuf>,
}

impl SafeMode {
    pub fn state(&self) -> SafeModeState {
        self.state.clone()
    }

    /// 标记"这一次启动走干净了"：**两个**标记都要删掉。
    ///
    /// 由 `RunEvent::Exit` 调用 —— 那**不是**一个"正在退出"的通知，
    /// 而是事件循环结束之后、`cleanup_before_exit` 之前的那一步。
    ///
    /// 失败只记警告：删不掉一个标记文件不该让退出流程出错（退出路径上抛错
    /// 只会让用户看到一个更糟的结束方式）。留着它的后果也只是"下次又进安全模式"，
    /// 而那是一个安全的方向。
    ///
    /// 两个都要删的理由：`boot_ok` 单独留下来虽然是"安全"的方向（下次不会误进
    /// 安全模式），但它会让`incomplete 在、ok 也在`这个组合永久为真 —— 那意味着
    /// **死在启动阶段的下一次也不再进安全模式**，保护就这样静默地没了。
    pub fn mark_clean_exit(&self) {
        clear_marker(self.incomplete.as_deref());
        clear_marker(self.ok.as_deref());
    }

    /// 标记"这一次启动确实成功过"。
    ///
    /// 调用点见文件头：前端在**插件那一步、任何插件 bundle 执行之前**调用它。
    /// 它必须是幂等的（前端的 `retry()` 会整体重跑启动流程）。
    ///
    /// 失败只记警告，理由与 `mark_clean_exit` 相同：写不下去只该让保护变弱
    /// （下次可能误进安全模式），不该把任何东西拦下来。
    pub fn mark_boot_ok(&self) {
        let Some(path) = self.ok.as_deref() else {
            // 没有应用数据目录时 `install` 已经警告过一次了，这里不重复刷屏。
            return;
        };
        if path.exists() {
            return;
        }
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                log::warn!("无法创建启动标记目录 {}：{error}", parent.display());
            }
        }
        match std::fs::write(path, b"") {
            Ok(()) => log::debug!("已写下启动成功标记 {}", path.display()),
            Err(error) => log::warn!("无法写入启动成功标记 {}：{error}", path.display()),
        }
    }
}

/// 删掉一个标记文件（不存在就什么也不做）。
fn clear_marker(path: Option<&std::path::Path>) {
    let Some(path) = path else {
        return;
    };
    if !path.exists() {
        return;
    }
    match std::fs::remove_file(path) {
        Ok(()) => log::debug!("已清除启动标记 {}", path.display()),
        Err(error) => log::warn!("无法清除启动标记 {}：{error}", path.display()),
    }
}

/// 两个标记文件的位置。拿不到应用数据目录时为 `None`（安全模式退化为只用环境变量）。
fn marker_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| (dir.join(MARKER_INCOMPLETE), dir.join(MARKER_OK)))
}

/// 环境变量是否要求进入安全模式。
///
/// 接受 `1` / `true` / `yes` / `on`（大小写与首尾空白都不敏感），
/// 与仓库里其它布尔环境变量的读法保持一致；其余值一律当"没设"。
fn env_requests_safe_mode() -> bool {
    match std::env::var(ENV_VAR) {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

/// 判定是否进入安全模式，并写下本次启动的标记。
///
/// **必须在窗口创建之前调用**（`PluginsModule::setup` 满足这一点）：
/// 前端的第一次 `invoke` 会读这个状态，而标记要在这之前落到盘上。
pub fn install(app: &AppHandle) -> SafeMode {
    let paths = marker_paths(app);
    let incomplete = paths.as_ref().map(|(marker, _)| marker.clone());
    let ok = paths.as_ref().map(|(_, marker)| marker.clone());

    // ============================================================
    // 先读：读了才知道"上一次是怎么结束的"
    // ============================================================
    let previous_incomplete = incomplete
        .as_deref()
        .map(|path| path.exists())
        .unwrap_or(false);
    let previous_ok = ok.as_deref().map(|path| path.exists()).unwrap_or(false);
    let decision = decide(env_requests_safe_mode(), previous_incomplete, previous_ok);

    // ============================================================
    // 再清：**顺序是这次修复里最容易写错的一步**
    // ============================================================
    //
    // 必须**先删 `boot_ok`、再写 `boot_incomplete`**，而且顺序不能反。
    //
    // 理由：写下的 `boot_incomplete` 与**残留的** `boot_ok` 一起，会被下一次
    // 启动读成"上一次跑起来过"—— 而那一轮的真相是"启动刚开始就死了"。
    // 于是本该进安全模式的那一次**不进**，保护静默失效（这正是这个机制存在的
    // 全部意义）。
    //
    // 反过来先删 `boot_ok` 是安全的：删掉一个标记只会让下一次的判定更保守
    // （更倾向进安全模式），而"保守"在这里恰是安全的方向。
    //
    // 也就是说：这两步之间**没有一个可观测的坏状态**，只要顺序是对的。
    //
    // 这里**无条件**清掉 `boot_ok`（而不是"只在需要时才清"）：两个标记的语义是
    // 一对，任何一次启动开始时 `boot_ok` 都必须不在 —— 包括上一次走得很干净、
    // 只留下一个孤儿 `boot_ok` 的情形。带着旧 `boot_ok` 进入本次启动，会让
    // "这一次启动刚开始就死了"在下一次被读成"跑起来过"。
    clear_marker(ok.as_deref());

    if let Some(path) = &incomplete {
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                log::warn!("无法创建启动标记目录 {}：{error}", parent.display());
            }
        }
        if let Err(error) = std::fs::write(path, b"") {
            // 写不下去就退化成"只用环境变量"：功能变弱，但不该让应用起不来。
            log::warn!("无法写入启动标记 {}：{error}", path.display());
        }
    } else {
        log::warn!("拿不到应用数据目录，安全模式的自动判定本次不可用");
    }

    match &decision.state.reason {
        Some(reason) => log::warn!("已进入安全模式：{reason}"),
        None => log::debug!("安全模式未启用，已写下本次启动标记"),
    }
    if !decision.previous_boot_was_clean && decision.state.reason.is_none() {
        // 上一次是被杀 / 关机 / 收尾崩溃 —— 不进安全模式，但值得留一条日志：
        // 用户问"上次明明没正常退出"时，答案在这里。
        log::info!("上一次启动成功过但没有走完退出流程（很可能是被杀掉或关机），本次不进入安全模式");
    }

    SafeMode {
        state: decision.state,
        incomplete,
        ok,
    }
}

/// 前端读它决定要不要自动加载插件。
///
/// 是**只读**的：没有"退出安全模式"这条命令，理由见文件头 ——
/// 退出动作就是"干净地关闭应用"，由 `SafeMode::mark_clean_exit` 在退出路径上完成。
#[tauri::command]
pub fn safe_mode_state(state: tauri::State<'_, SafeMode>) -> SafeModeState {
    state.state()
}

/// 前端在**插件那一步、任何插件 bundle 执行之前**调用它，写下 `boot_ok`。
///
/// 为什么是它而不是宿主侧的一个延时：见文件头（判据必须落在渲染进程自己身上，
/// 否则插件卡死渲染进程时判据照样成立）。为什么必须与插件无关：安全模式下插件
/// 不执行，依赖插件的判据会让安全模式永远出不来。
#[tauri::command]
pub fn mark_boot_ok(state: tauri::State<'_, SafeMode>) {
    state.mark_boot_ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把 `Decision` 压成一句好读的话，失败时才看得懂断言在说什么。
    fn show(decision: &Decision) -> String {
        format!(
            "active={} reason={:?}",
            decision.state.active, decision.state.reason
        )
    }

    fn assert_active(decision: &Decision) {
        assert!(
            decision.state.active,
            "这一步必须进安全模式，实际 {}",
            show(decision)
        );
        assert!(
            decision.state.reason.is_some(),
            "进了安全模式就必须给出原因，实际 {}",
            show(decision)
        );
    }

    fn assert_inactive(decision: &Decision) {
        assert!(
            !decision.state.active,
            "这一步**不该**进安全模式，实际 {}",
            show(decision)
        );
        assert!(
            decision.state.reason.is_none(),
            "没进安全模式就不该带原因（界面会照着 reason 弹通知），实际 {}",
            show(decision)
        );
    }

    /// 组合一：两个标记都不在 —— 正常启动（干净退出过，或第一次启动）。
    #[test]
    fn no_marker_at_all_is_a_normal_boot() {
        let decision = decide(false, false, false);
        assert_inactive(&decision);
        assert!(
            decision.previous_boot_was_clean,
            "两个标记都不在等价于「上一次走干净了」，不该被记成异常"
        );
    }

    /// 组合二：`boot_incomplete` 在、`boot_ok` 不在 —— 上一次**死在启动阶段**。
    /// 插件嫌疑最大，维持保护强度：进安全模式，且文案指向插件。
    #[test]
    fn incomplete_without_ok_means_it_died_during_startup() {
        let decision = decide(false, true, false);
        assert_active(&decision);
        let reason = decision.state.reason.clone().unwrap_or_default();
        assert!(
            reason.contains("上一次启动没有正常退出"),
            "死在启动阶段的文案应当保留，实际 {reason:?}"
        );
        assert!(
            reason.contains("插件"),
            "这条路径上应当把用户指向「设置 → 插件」，实际 {reason:?}"
        );
    }

    /// 组合三：两个标记都在 —— 上一次**跑起来过**，只是没走完退出流程
    /// （任务管理器结束进程 / 关机 / 收尾阶段崩溃）。
    ///
    /// **这是本次修复的核心断言**：以前它会被误判成"插件把它弄崩了"。
    #[test]
    fn incomplete_with_ok_means_it_ran_and_was_killed() {
        let decision = decide(false, true, true);
        assert_inactive(&decision);
        assert!(
            !decision.previous_boot_was_clean,
            "它是「没走完退出流程」，不是「走干净了」—— 日志口径要分得开"
        );
    }

    /// 组合四：`boot_ok` 在、`boot_incomplete` 不在。
    ///
    /// 正常流程造不出这个组合（写 `boot_ok` 时 `boot_incomplete` 一定在），
    /// 但手工删过标记、或者某次写 `boot_incomplete` 失败之后就可能出现。
    /// 判定只看 `boot_incomplete`：它的含义是"启动**正在进行**"，不在就说明
    /// 没有一次未收尾的启动，不该进安全模式。
    #[test]
    fn orphan_ok_marker_alone_does_not_trigger_safe_mode() {
        let decision = decide(false, false, true);
        assert_inactive(&decision);
        assert!(
            decision.previous_boot_was_clean,
            "`boot_incomplete` 不在就等价于「上一次走干净了」"
        );
    }

    /// 环境变量优先：它压过一切推断，包括"两个标记都在"这个明确的不进安全模式。
    #[test]
    fn forced_wins_over_every_marker_combination() {
        for (incomplete, ok) in [(false, false), (true, false), (true, true), (false, true)] {
            let decision = decide(true, incomplete, ok);
            assert_active(&decision);
            let reason = decision.state.reason.clone().unwrap_or_default();
            assert!(
                reason.contains(ENV_VAR),
                "强制进入时文案必须点出环境变量名（用户要能据此关掉它），实际 {reason:?}"
            );
        }
    }

    /// 判定是**纯函数**：同一个输入永远得到同一个输出，且不依赖环境。
    /// 这条断言的存在是为了挡住"以后有人在 `decide` 里偷偷读一次环境变量或文件"。
    #[test]
    fn deciding_is_deterministic_and_side_effect_free() {
        for forced in [false, true] {
            for incomplete in [false, true] {
                for ok in [false, true] {
                    assert_eq!(
                        decide(forced, incomplete, ok),
                        decide(forced, incomplete, ok),
                        "同样的输入必须得到同样的判定"
                    );
                }
            }
        }
    }
}
