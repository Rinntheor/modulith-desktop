// src-tauri/src/core/process.rs
//
// 创建子进程时**不要弹出控制台窗口**。
//
// ============================================================
// 它修的是什么：发行版每次启动闪三个黑窗
// ============================================================
//
// 用户报："发行版的软件，每次启动时会弹出三个 cmd 窗口然后立马消失。"
// 而且 **Ctrl+R 刷新界面也会重现**。
//
// 后半句是定位的关键：刷新会重跑前端的启动流程，而那个流程里有一项是
// 「同步后台插件」（`syncBackgroundPlugins`）。于是问题不在"应用启动"，
// 而在**每一次同步后台插件都会创建的那几个子进程**。
//
// ============================================================
// 机制：Windows 给控制台子系统子进程分配一个新控制台
// ============================================================
//
// 本应用是 GUI 子系统（`main.rs` 的 `windows_subsystem = "windows"`），
// 因此它自己没有任何控制台。当它创建一个**控制台子系统**的子进程
// （`node.exe` 就是）而没有指定创建标志时，Windows 会为这个子进程**分配一个新的
// 控制台** —— 那个一闪而过的黑窗就是它。
//
// 两个容易踩的误解：
//
//   1. **重定向 stdio 挡不住它。** `.output()` / `Stdio::piped()` / `Stdio::null()`
//      只影响管道与文件句柄，不影响控制台的创建。唯一能阻止的是进程创建标志。
//      这是本次真正漏掉的那一环：四处调用点里有两处（探测 Node 能力）已经重定向了
//      stdout/stderr，却照样闪窗。
//   2. **继承 stderr 是刻意的，不能为了消窗把它改成 null。** 后台宿主的
//      `stderr` 走 `Stdio::inherit()`，为的是让子进程的崩溃与 `console.error`
//      直接进应用日志（见 `background/mod.rs` 的 `ensure_started`）。下面用的
//      `CREATE_NO_WINDOW` 不分配控制台，但**句柄继承照旧生效**（Windows 会把
//      继承来的标准句柄指过去），因此"消窗"与"保留 stderr 通道"两者同时成立。
//
// ============================================================
// 为什么是一个模块，而不是在四处各写一遍 cfg
// ============================================================
//
// 需要它的调用点有四处（三个在启动路径上），而**漏掉任何一处都会继续闪窗**。
// 写成一处之后，「哪些地方创建了子进程」这个问题才有唯一的答案，也才可能由
// `scripts/check-console-window.ts` 在构建期把它们逐个数出来。
//
// 那个门禁不是多余的谨慎：这个缺陷只在发行版、且只在机器上有 Node 时有症状，
// 开发时全量跑测试也看不到 —— 与上一轮那个"只在发行版出现的启动竞态"同类，
// 源码级断言是唯一能在 CI 里拦住它的手段。

/// Windows 的进程创建标志：不为子进程分配控制台。
///
/// 值取自 Win32 文档（`winbase.h` 的 `CREATE_NO_WINDOW`）。写成常量而不是依赖
/// 某个 crate 的 re-export，是因为它是个一旦写错就"什么都不发生"的数字 ——
/// 放在这里带着名字与文档链接，比散在四处调用点更容易核对。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 让一个 [`std::process::Command`] 不弹控制台窗口。
///
/// 非 Windows 平台上是空操作：那条"GUI 程序给控制台子进程分配控制台"的规则只在
/// Windows 上存在，POSIX 上子进程本来就没有窗口。
pub fn no_console_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// 同上，但作用于 [`tokio::process::Command`]。
///
/// **两个函数必须都存在**：`std::process::Command` 与 `tokio::process::Command`
/// 是两种不同的类型，没有公共 trait 能同时接住它们。
///
/// 两者的接法**不一样**，而后者的错误方式很隐蔽：
///
///   * `std` 走 `std::os::windows::process::CommandExt` 扩展 trait（方法本身安全，
///     但**必须**把 trait 引入作用域，否则它只是一条普通的 inherent 调用查不到）；
///   * tokio 有一个 **inherent** 的 `creation_flags`（内部转发给 std），因此
///     **不需要引入任何 trait**。
///
/// 早先这一支照抄了 std 的写法（引入 `std` 的 `CommandExt` 并包了一层 `unsafe`），
/// 编译器给出两条警告：`unused import: CommandExt` 与 `unnecessary unsafe block`。
/// 那两条警告是在说"你写的那一行没有选中 tokio 的方法" —— 而它**编译得过**，
/// 只是标志没生效。于是消窗看起来"已经做了"，实际上窗口照闪。这类"写错了但能编译"
/// 的地方，靠警告发现；因此两个分支刻意各写各的，不共用一个 helper。
pub fn no_console_window_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _ = command;
    }
}
