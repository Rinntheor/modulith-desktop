// src-tauri/src/modules/plugins/selection.rs
//
// 读取**前台应用程序里当前选中的文本**（`ctx.selection`）：翻译插件需要它 ——
// 用户选中一段外文之后按下热键，插件要拿到那段文字。
//
// ============================================================
// 这里没有第二种做法（v1 之内）
// ============================================================
//
// 想拿到"别的程序里选中的文本"，系统只有两条路：
//
//   1. **UI Automation**（`TextPattern` / `IUIAutomation`）：不碰剪贴板、能读到
//      选区，也读得到"选了多少字"。代价是它要一整套 COM，且**只在实现了
//      `TextPattern` 的程序里有效** —— 浏览器、Electron 应用、游戏、终端大面积
//      不实现它，而它们恰好是这类插件最常被用到的场景。它的失败方式还是静默的
//      （接口存在但返回空）。
//   2. **合成 Ctrl+C，再读剪贴板**：对所有支持复制的程序都有效，代价是它
//      **真的改了用户的剪贴板**。
//
// v1 取第二条，并且把这个代价写清楚（见下）。
//
// ============================================================
// 代价一：我们在改用户的剪贴板
// ============================================================
//
// 这不是"实现细节"，而是这项能力的**真实成本**，因此它出现在三处：这份注释、
// 权限描述（`permissions.rs`）、以及用户文档。
//
//   * **文本会被还原**：捕获前后的文本快照会被写回（`clipboard_restore`）。
//     这一步是**强制**的，不是优化 —— 不还原的话，用户下一次粘贴得到的是他刚才
//     选中的那段字，而不是他之前复制的东西。
//   * **非文本格式无法还原。** 图片、富文本、文件列表在 `Ctrl+C` 的那一刻就没了，
//     而本模块的快照只取 `CF_UNICODETEXT`。这是本设计**真实的、无法绕过的缺陷**：
//     用户复制了一张截图，然后在某个程序里按了翻译热键 —— 截图回不来了。
//     要修它必须把整份剪贴板（所有格式）先序列化再写回，而 `CF_BITMAP` 一类句柄
//     不能跨进程直接搬。这是"要么接受，要么改用 UI Automation"的取舍，不是遗漏。
//   * **不记录任何内容。** 本文件里没有任何一条日志带用户选中的文字。它的价值与
//     `clipboard.rs` 里那条规矩完全相同：`modulith.log` 是一个会被用户发给我们
//     排查问题的明文文件，而用户选中的可能是他正在编辑的合同。
//
// ============================================================
// 代价二：合成的那次复制**绝不能**被剪贴板监测看到
// ============================================================
//
// `clipboard.rs` 会把每一次剪贴板变化交付给订阅了 `clipboard-monitor` 的插件。
// 如果这里合成的 `Ctrl+C` 不加以抑制，那么**每一次翻译触发**都会往用户的剪贴板
// 历史里注入一条幻影记录 —— 而且是一条"用户没有复制过"的内容，通常还是一段
// 外文。历史插件本身没有问题，是这一条路径在污染它。
//
// 因此耦合是**显式**的、写在一处：捕获期间把 `ClipboardMonitor` 置为抑制态
// （`suppress()` 返回的 RAII guard），期间观察到的变化既不交付也不留待下一轮。
// 这条耦合必须在代码里能一眼看见 —— 它没有别的地方可以放。
//
// ============================================================
// 代价三：串行化
// ============================================================
//
// 两次并发捕获会**交错**：A 合成 Ctrl+C、B 合成 Ctrl+C、A 读到 B 的内容、B 读到
// A 还原之后的内容 —— 两次都拿到垃圾，而且没有任何报错。
//
// 处理方式选的是**拒绝**而不是排队：捕获最长 400 ms，排队会让第二个调用方的
// promise 无理由地晚 400 ms 才 reject（而它所处的场景是用户按了热键，他期待的是
// 立刻有反应）。第二次并发调用拿到一句说清原因的拒绝。
//
// ============================================================
// 代价四：不对**我们自己**合成按键
// ============================================================
//
// 前台窗口属于本应用时直接拒绝。理由是具体的：合成 Ctrl+C 会落进宿主的 webview，
// 于是宿主自己的界面收到一次"复制"，而那次复制又会触发一次变化 —— 而那条路径上
// 没有任何东西能保证它不再引发一次读取。这是一个能被构造成回路的形状，因此从
// 入口就把它切断。

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

use super::types::PluginPermission;

/// 非 Windows 平台上 `read()` 的统一说法。
pub const UNSUPPORTED_PLATFORM: &str =
    "读取选中文本只在 Windows 上可用：它需要合成 Ctrl+C（SendInput）并读剪贴板，\
     这里没有对应实现";

/// 合成 Ctrl+C 之后等剪贴板变化的**总**时限。
///
/// 400 ms 是"用户按了热键之后能接受的等待"与"慢一点的程序也复制得完"之间的取值。
/// 上限的另一层意义是它**必须存在**：没有上限的话，在一个不响应 Ctrl+C 的程序里
/// 按热键会让那次调用的 promise 永远挂着。
pub const CAPTURE_TIMEOUT: Duration = Duration::from_millis(400);

/// 轮询剪贴板序列号的间隔。
///
/// 20 ms 意味着最坏情况下多等 20 ms，而代价是 20 次整数读取 —— `GetClipboardSequenceNumber`
/// 不打开剪贴板，因此这 20 次读取碰不到用户剪贴板里的内容（与 `clipboard.rs` 里
/// 轮询同一个理由）。
pub const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// 拿不到选中文本时的统一说法。
///
/// 三件事必须都在里面：**发生了什么**、**最可能的原因**、**用户能做什么**。
/// 只说"读取失败"会让作者以为是权限或平台问题，而真实原因通常是"那个程序不支持
/// Ctrl+C 复制"（例如终端里的纯查看模式、或一张图片）。
pub const NO_SELECTION: &str =
    "没有取到选中的文本：宿主向前台程序合成了一次 Ctrl+C，但剪贴板在这 400 ms 内\
     没有变化。最可能的原因是那个程序不支持用 Ctrl+C 复制（例如终端、某些阅读器、\
     或者用户选中的其实不是文本）。这不是权限问题";

/// 前台窗口属于本应用时的拒绝理由。
pub const FOREGROUND_IS_OURS: &str =
    "当前的前台窗口属于本应用，宿主拒绝在这里合成 Ctrl+C：那会把按键送进宿主自己的\
     界面，而那次复制又会触发一次剪贴板变化 —— 这是一个能绕成回路的形状，因此从入口\
     就切断。请在别的应用程序里选中文本之后再触发";

/// 没有前台窗口时的拒绝理由。
pub const NO_FOREGROUND_WINDOW: &str =
    "当前没有前台窗口（焦点在桌面或任务栏上），宿主无法合成 Ctrl+C —— 请先在某个\
     应用程序里选中文本";

/// 两次捕获重叠时的拒绝理由。
pub const BUSY: &str =
    "上一次读取选中文本还没结束。宿主同一时刻只允许一次捕获：两次并发会交错，\
     两次都会拿到错的文本（而不会有任何报错）。稍等片刻再试";

/// 串行化那一把锁。
///
/// `Mutex::new` 是 `const` 的，因此它不需要 `OnceLock` 一类的包装 —— 少一层间接
/// 就少一处可以写错的地方。
static CAPTURE_LOCK: Mutex<()> = Mutex::new(());

/// 需要 `read-selection` 权限。**与其它能力同一条判据**：没声明就是拒绝。
///
/// 单独摘出来，是因为两个调用方（RPC 与命令层）都要做这件事，而漏掉任意一处的
/// 后果是"没声明也能读走用户在任何一个程序里选中的东西"。
pub fn require_permission(
    manager: &super::manager::PluginManager,
    plugin_id: &str,
) -> Result<(), String> {
    manager
        .require_permission(plugin_id, PluginPermission::ReadSelection)
        .map_err(|e| e.to_string())
}

/// 这个平台支不支持读取选中文本。
pub fn is_supported() -> bool {
    win::SUPPORTED
}

// ============================================================
// 纯判定（这一节是全部可测的部分）
// ============================================================

/// 前台窗口是不是**我们自己**的。
///
/// 判据用**进程 id** 而不是窗口句柄的白名单，这一点是刻意的：
///   * 宿主的窗口不止一个（主窗口、浮层、托盘菜单、自检窗口），而且它们会随功能
///     增删而变化 —— 一份句柄白名单会随着"有人加了一个窗口"而静默失效，症状是
///     合成按键落进了宿主自己的界面；
///   * 进程 id 判的是"这个窗口属于谁"，而问题的本质正是"这个窗口是不是我们的"。
///     本进程的每一个窗口都在我们的进程里，因此它不会漏。
///
/// 取不到 pid（返回 0）时按"不是我们的"处理 —— 那意味着 `GetWindowThreadProcessId`
/// 没能识别这个窗口，而**放行一次捕获的代价**（用户剪贴板里的别的东西被换掉一次、
/// 之后再还原）远小于**拒绝所有捕获**的代价（这项能力完全不可用）。两个方向不对等，
/// 因此选伤害小的那一个。
pub fn foreground_is_ours(foreground: isize, foreground_pid: u32, own_pid: u32) -> bool {
    if foreground == 0 {
        return false;
    }
    foreground_pid != 0 && foreground_pid == own_pid
}

/// 等剪贴板序列号变化的那一步。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapturePoll {
    /// 序列号变了：这次复制成功了。
    Changed,
    /// 还没变，但还没到时限。
    KeepWaiting,
    /// 到时限了 —— 那个程序没有响应这次 Ctrl+C。
    TimedOut,
}

/// 一次轮询之后该做什么。**纯函数**，因此"400 ms 到了没有"这件事可以在没有
/// 剪贴板、没有前台窗口的情况下被单测逐条钉住。
///
/// `changed` 优先于时限：恰好在上限那一刻发生变化时应当**成功**，而不是被当成
/// 超时 —— 那会丢掉一次本来拿得到的文本，而且用户会看到一个说不通的失败。
pub fn classify(changed: bool, elapsed: Duration) -> CapturePoll {
    if changed {
        return CapturePoll::Changed;
    }
    if elapsed >= CAPTURE_TIMEOUT {
        return CapturePoll::TimedOut;
    }
    CapturePoll::KeepWaiting
}

/// 捕获结束之后要写回剪贴板的文本。
///
/// **`None` 也要写回**（写回一个空串），而不是"什么都不做"。理由是具体的：
/// 合成 Ctrl+C 已经把剪贴板上原来的东西（包括图片、富文本、文件列表）整份换掉了，
/// 而在捕获之前剪贴板上没有文本时，"什么都不做"的后果是把**用户选中并复制出来的
/// 那段字**留在剪贴板里 —— 用户下一次粘贴得到的是它。写回一个空串至少让
/// "我复制的东西没了"与"我复制的东西被换成了别的东西"分开。
///
/// 纯函数：它只回答"该写回什么"，而"能不能写"由平台层决定。
pub fn clipboard_restore(snapshot: Option<&str>) -> String {
    snapshot.unwrap_or("").to_string()
}

/// 读一次前台应用程序里选中的文本。
///
/// `None` 表示捕获到了，但剪贴板上最终没有文本（例如用户选中的是一段空白，
/// 或者那个程序放了一份没有文本的东西）。`Ok(None)` 与 `Err` **必须分得开**：
/// 前者是"确实没有文本"，后者是"这次捕获根本没成功"。
pub fn read<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    if !win::SUPPORTED {
        return Err(UNSUPPORTED_PLATFORM.to_string());
    }

    // ---- 串行化 ----
    let _serial = CAPTURE_LOCK
        .try_lock()
        .map_err(|_| BUSY.to_string())?;

    // ---- 抑制剪贴板监测（见文件头"代价二"）----
    //
    // guard 活到 `read` 返回为止，因此它覆盖了合成复制与还原**两次**变化的全部
    // 时间。离开作用域时它会要求轮询线程重新对齐序列号 —— 只把标志位放掉是不够的：
    // 轮询线程可能一次都还没醒来，那条幻影变化还排在它下一轮的队里。
    let monitor = app.try_state::<super::clipboard::ClipboardMonitor>();
    let _suppression = monitor.as_ref().map(|state| state.suppress());

    win::capture()
}

// ============================================================
// Windows 实现
// ============================================================

#[cfg(windows)]
mod win {
    use std::time::Instant;

    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    use super::*;

    pub const SUPPORTED: bool = true;

    /// `C` 键的虚拟键码。
    ///
    /// 单独写出来而不是从 windows-sys 引 `VK_C`：那个常量在 0.61 里确实存在，但
    /// 本模块只用到这一个字母键，而一个具名的局部常量把"我们合成的是 Ctrl+C"
    /// 这件事写在了一处。
    const VK_C: u16 = 0x43;

    pub fn capture() -> Result<Option<String>, String> {
        let foreground = unsafe { GetForegroundWindow() } as isize;
        if foreground == 0 {
            return Err(NO_FOREGROUND_WINDOW.to_string());
        }

        let mut foreground_pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(foreground as HWND, &mut foreground_pid);
        }
        let own_pid = unsafe { GetCurrentProcessId() };

        if foreground_is_ours(foreground, foreground_pid, own_pid) {
            return Err(FOREGROUND_IS_OURS.to_string());
        }

        // ---- 快照 ----
        let snapshot = super::super::clipboard::current_text();
        let before = super::super::clipboard::sequence_number();

        send_ctrl_c()?;

        let started = Instant::now();
        loop {
            std::thread::sleep(POLL_INTERVAL);
            let changed = super::super::clipboard::sequence_number() != before;

            match classify(changed, started.elapsed()) {
                CapturePoll::Changed => break,
                CapturePoll::KeepWaiting => continue,
                CapturePoll::TimedOut => {
                    // 超时也**必须还原**：那个程序可能在 400 ms 之后的某一刻才
                    // 完成复制，而那一刻我们的快照仍然是唯一能还回去的东西。
                    restore(snapshot);
                    return Err(NO_SELECTION.to_string());
                }
            }
        }

        let captured = super::super::clipboard::current_text();
        restore(snapshot);
        Ok(captured)
    }

    /// 把快照写回剪贴板。
    ///
    /// 失败**只记一条 debug 日志**：那意味着用户的剪贴板里留着的是他刚才选中的
    /// 那段字。这不是可以补救的事情（再试一次未必更好），而把它升级成一次调用失败
    /// 会让插件在"文本已经拿到了"的情况下报错 —— 那是更坏的结果。
    fn restore(snapshot: Option<String>) {
        let text = clipboard_restore(snapshot.as_deref());
        if let Err(error) = super::super::clipboard::replace_text(&text) {
            log::debug!("还原剪贴板失败（用户剪贴板里留着的是刚捕获的那段文本）：{error}");
        }
    }

    /// 合成一次 Ctrl+C。
    ///
    /// 四个事件**一次** `SendInput` 送出去。分成四次调用会让中间插进用户自己的
    /// 按键，而那会产生一段谁也没想到的组合（例如 Ctrl 已经被我们按下、用户按了
    /// 别的键）。
    ///
    /// ============================================================
    /// 一条真实的限制
    /// ============================================================
    ///
    /// 用户**物理按住** Ctrl 时触发热键的话，我们送出的 `Ctrl up` 会把他那一次
    /// 按住判成松开。要避免它得先问 `GetAsyncKeyState(VK_CONTROL)` 再决定抬不抬 ——
    /// 但那个函数读的是**调用线程**的键盘状态，而我们的按键来自别的线程/别的窗口，
    /// 它给出的答案并不可靠。与其做一个看起来对、实际会偶发误判的探测，不如把
    /// 这条限制写在这里。
    fn send_ctrl_c() -> Result<(), String> {
        let key = |virtual_key: u16, flags: u32| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: virtual_key,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    // `dwExtraInfo` 留 0：它本来可以用来标记"这一次输入是我们合成的"，
                    // 而本模块没有任何地方需要把注入的按键与真实按键分开 ——
                    // 抑制那件事靠的是剪贴板侧的标志位，不是靠按键的来源。
                    dwExtraInfo: 0,
                },
            },
        };

        let inputs = [
            key(VK_CONTROL, 0),
            key(VK_C, 0),
            key(VK_C, KEYEVENTF_KEYUP),
            key(VK_CONTROL, KEYEVENTF_KEYUP),
        ];

        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };

        if sent as usize != inputs.len() {
            return Err(
                "无法合成 Ctrl+C（SendInput 被系统拒绝）。最常见的原因是前台窗口以\
                 更高权限运行（例如以管理员身份启动的程序），而 UIPI 不允许低权限进程\
                 向它注入输入。这不是权限声明的问题"
                    .to_string(),
            );
        }

        Ok(())
    }
}

// ============================================================
// 非 Windows 实现
// ============================================================
//
// 保留同一个签名集合，因此上层的 `is_supported` / `read` 不需要任何 `cfg`。
// **它必须"诚实地失败"**：返回一句说清原因的错误，而不是 `Ok(None)` ——
// 后者会被插件读成"用户没有选中任何东西"。
#[cfg(not(windows))]
mod win {
    use super::*;

    pub const SUPPORTED: bool = false;

    pub fn capture() -> Result<Option<String>, String> {
        Err(UNSUPPORTED_PLATFORM.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============================================================
    // 前台窗口是不是我们的
    // ============================================================

    /// **我们自己**的前台窗口一律拒绝。
    ///
    /// 这是文件头"代价四"的可判定形式：放行它的后果是合成按键落进宿主自己的界面，
    /// 而那次复制又会触发一次剪贴板变化 —— 一个能绕成回路的形状。
    #[test]
    fn our_own_foreground_window_is_refused() {
        assert!(foreground_is_ours(0x1234, 4321, 4321));
        // 别的进程一律放行
        assert!(!foreground_is_ours(0x1234, 4321, 9999));
    }

    /// 没有前台窗口时不算"是我们的"。
    ///
    /// 这一条是刻意的：`foreground == 0` 由调用方用一句更准确的话拒绝
    /// （`NO_FOREGROUND_WINDOW`），而不是借"这是我们自己的窗口"那句话 ——
    /// 用户看到后者会去找自己哪个窗口挡住了，而真实原因是焦点在桌面上。
    #[test]
    fn a_missing_foreground_window_is_not_ours() {
        assert!(!foreground_is_ours(0, 0, 4321));
    }

    /// 取不到 pid 时放行，而不是拒绝。
    ///
    /// 两个方向的代价不对等：放行最多让用户的剪贴板被换掉一次（之后会还原），
    /// 而拒绝会让这项能力在那些窗口上**完全不可用**且没有线索。
    #[test]
    fn an_unknown_pid_does_not_block_the_capture() {
        assert!(!foreground_is_ours(0x1234, 0, 4321));
    }

    // ============================================================
    // 超时判定
    // ============================================================

    #[test]
    fn a_changed_sequence_wins_over_the_deadline() {
        // 恰好在上限那一刻发生变化：必须算成功。判成超时会丢掉一次本来拿得到的
        // 文本，而用户看到的只是一个说不通的失败。
        assert_eq!(
            classify(true, CAPTURE_TIMEOUT),
            CapturePoll::Changed,
            "变化优先于时限"
        );
        assert_eq!(classify(true, CAPTURE_TIMEOUT * 2), CapturePoll::Changed);
    }

    #[test]
    fn the_deadline_is_bounded() {
        assert_eq!(classify(false, Duration::from_millis(0)), CapturePoll::KeepWaiting);
        assert_eq!(
            classify(false, CAPTURE_TIMEOUT - Duration::from_millis(1)),
            CapturePoll::KeepWaiting
        );
        // 上限就是上限：到了就停，而不是继续等下去。
        assert_eq!(classify(false, CAPTURE_TIMEOUT), CapturePoll::TimedOut);
        assert_eq!(classify(false, CAPTURE_TIMEOUT * 3), CapturePoll::TimedOut);
    }

    /// 轮询间隔与总时限的关系必须是"能轮询若干次"。
    ///
    /// 间隔大于时限的话，这个循环一次都跑不到上限就已经超时了 —— 而它表现为
    /// "所有捕获都失败"，看不出是参数问题。
    #[test]
    fn the_polling_interval_fits_inside_the_deadline() {
        assert!(
            POLL_INTERVAL < CAPTURE_TIMEOUT,
            "轮询间隔必须小于总时限，否则一次都轮不到"
        );
        assert!(
            CAPTURE_TIMEOUT.as_millis() / POLL_INTERVAL.as_millis() >= 10,
            "400 ms / 20 ms 应当有 20 次机会，而不是三四次"
        );
    }

    // ============================================================
    // 还原判定
    // ============================================================

    #[test]
    fn the_snapshot_is_written_back_verbatim() {
        assert_eq!(clipboard_restore(Some("用户原来复制的东西")), "用户原来复制的东西");
        // 快照是空串也是一个合法取值（用户复制了一段空内容），必须原样写回
        assert_eq!(clipboard_restore(Some("")), "");
    }

    /// 没有快照时写回**空串**，而不是"什么都不做"。
    ///
    /// "什么都不做"的后果是把刚捕获的那段文本留在剪贴板里 —— 用户下一次粘贴得到的
    /// 是它，而不是他以为自己在剪贴板里的东西。
    #[test]
    fn a_missing_snapshot_still_clears_the_text() {
        assert_eq!(clipboard_restore(None), "");
    }

    /// 三个上限/时限就是文档里写的那些数字。
    ///
    /// 它们被权限描述与用户文档同时引用，而改一个数字不会有任何编译错误。
    #[test]
    fn the_documented_timings_are_these_numbers() {
        assert_eq!(CAPTURE_TIMEOUT, Duration::from_millis(400));
        assert_eq!(POLL_INTERVAL, Duration::from_millis(20));
    }

    /// 几条面向用户的说法里，三件事必须都在：发生了什么、为什么、能做什么。
    #[test]
    fn the_user_facing_messages_are_actionable() {
        assert!(NO_SELECTION.contains("Ctrl+C"), "{NO_SELECTION}");
        assert!(NO_SELECTION.contains("400"), "{NO_SELECTION}");
        assert!(NO_SELECTION.contains("不是权限问题"), "{NO_SELECTION}");

        assert!(FOREGROUND_IS_OURS.contains("前台窗口属于本应用"), "{FOREGROUND_IS_OURS}");

        assert!(BUSY.contains("只允许一次捕获"), "{BUSY}");
    }
}
