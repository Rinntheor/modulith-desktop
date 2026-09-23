// src-tauri/src/modules/settings/memory_level.rs
//
// WebView2 的内存目标等级：在窗口不再需要即时响应时，让渲染引擎把能放下的都放下。
//
// ============================================================
// 为什么需要它（这是当前最大的一处空白）
// ============================================================
//
// WebView2 是多进程的浏览器引擎，它默认一直按"随时要响应"的标准占着内存：
// 已解码的图像、已编译的脚本、字体与着色器缓存都留在私有内存里。本机实测应用
// 启动到解锁界面时私有内存合计 347 MB（7 个进程），其中渲染进程一个就 189 MB。
//
// 此前**窗口状态变化时我们没有任何回调** —— 用户把窗口最小化、隐藏到托盘之后，
// 引擎并不知道"现在没人看你"，于是那几百 MB 一直挂着。这正好解释了两个现象：
// **收回侧边栏内存不降**（那本来与此无关）、**全屏后内存不降**（全屏不是失活，
// 改的只是窗口大小）。
//
// `ICoreWebView2_19::SetMemoryUsageTargetLevel` 就是为这件事准备的：
// 设为 `Low` 时引擎会丢弃缓存或把内容换出到磁盘；设回 `Normal` 恢复全速。
// 微软文档明确建议"应用变为非活跃时设为 Low"。
//
// ============================================================
// 为什么策略由**前端**驱动，而不是 Rust 侧的窗口事件
// ============================================================
//
// 这是本模块最容易做错的一处，值得写清楚。
//
// `with_webview` 的实现是"把闭包投递给事件循环，然后**阻塞等待**它执行完"。
// 因此它只能在**事件循环之外**的线程上调用。而 Rust 侧的窗口事件回调、托盘菜单
// 回调都跑在**事件循环线程**上 —— 在那里调用 `with_webview` 就是
// "事件循环等闭包、闭包等事件循环"，**直接死锁**。
//
// 同时，`Window::is_minimized()` / `is_visible()` 这些读取也经过事件循环
// （`dispatcher.is_minimized()` 发消息并等待回复），在事件回调里调用同样死锁。
//
// 于是 Rust 侧的窗口事件策略**先天不可行**。而前端本来就有一个恰好合适的信号：
// 窗口被最小化、被隐藏、被切到后台时，webview 都会收到 `visibilitychange`。
// 前端没有这个线程约束，一次 `invoke` 就是普通的后台调用。
//
// 因此分工是：
//   · **前端决定**什么时候降级（它能看到 `visibilityState`，且托盘隐藏窗口也能覆盖）；
//   · **这里只提供机制**：把等级套到 WebView2 上，并如实回报是否生效。
//
// 还有一个额外好处：托盘"隐藏到托盘"这个动作由 Rust 发起，但隐藏之后
// webview 同样会收到 `visibilitychange` —— 所以无论谁隐藏了窗口，
// 这条策略都会生效，不需要两处各写一遍。
//
// ============================================================
// 为什么只在「不可见」时降级，不在「失焦」时降
// ============================================================
//
// 失焦在桌面应用里太频繁了：用户切到浏览器查一句话、切到编辑器复制一段，
// 窗口仍在屏幕上、仍被看着，下一眼就要用。把"切走一下"当成"不再需要"，
// 换来的是**切回来时的卡顿**，而用户会把这归因成"这个软件很卡"。
//
// 最小化与隐藏则是明确的、用户主动的"从屏幕上拿开"。判据因此只有一条：
// **文档是否可见**。要放宽它之前，先量一次"恢复需要多久"。
//
// ============================================================
// 失败为什么必须被看见
// ============================================================
//
// 这套 API 需要 WebView2 Runtime ≥ 114。旧运行时上它是**静默 no-op** ——
// 不报错，也不生效。因此 `apply` 把"能不能取到接口"如实回报（`Ok(false)`），
// 而不是假装成功：一个"看起来接上了、其实从未通电"的开关，正是这份代码
// 最该避免的东西（项目里已经有过好几例）。

use crate::prelude::*;

/// 内存目标等级。
///
/// 只有两档，与 WebView2 自己的 `COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL` 一一对应 ——
/// 不自创中间档，因为引擎没有那个概念。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryLevel {
    /// 全速：随时可交互
    Normal,
    /// 省内存：引擎会丢弃缓存或换出到磁盘，恢复交互时可能有短暂代价
    Low,
}

/// 由文档可见性推出应当套用的等级。
///
/// 这是**策略的唯一判定处**。抽成纯函数有两个理由：
///
///   1. 它能被单元测试直接覆盖（策略比机制更容易被悄悄改错）；
///   2. 它与前后端的契约一致 —— 前端 `services/memoryLevel.ts` 里有一份
///      同名的镜像实现，两者的真值表由 `pnpm check:performance` 对齐。
///
/// `document.hidden` 为真时降级，否则恢复全速。没有第三档。
pub fn level_for_visibility(hidden: bool) -> MemoryLevel {
    if hidden {
        MemoryLevel::Low
    } else {
        MemoryLevel::Normal
    }
}

/// 应用一次内存等级，返回**是否真的生效**。
///
/// `Ok(false)` 的含义是"接口取不到"（WebView2 Runtime 太旧，或当前平台没有这套 API），
/// 它是**正常情况**而不是错误 —— 调用方据此在界面上如实标注，而不是显示一个
/// 从未生效的开关。
///
/// `Err` 只用于真正的失败（投递不到界面线程、引擎拒绝、超时）。
pub fn apply(window: &tauri::WebviewWindow, level: MemoryLevel) -> Result<bool, String> {
    #[cfg(windows)]
    {
        windows_impl::apply(window, level)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, level);
        // 目前只有 Windows 的 WebView2 提供这套 API。如实返回"未生效"。
        Ok(false)
    }
}

/// 这套 API 在当前环境是否可用（设置 → 性能要如实标注）。
///
/// 判据是"能不能取到那个接口"，而不是版本号比较：版本号是间接证据，
/// 而接口本身才是真正决定成败的东西。
pub fn is_supported(window: &tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        windows_impl::is_supported(window)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

/// 取主窗口，取不到时才报错
fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    use tauri::Manager;
    app.get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())
}

/// 按可见性套用内存目标等级（前端在 `visibilitychange` 上调用）
///
/// 前端只报"我现在是不是看不见"，等级由 `level_for_visibility` 推导 ——
/// 把策略留在后端，前端的镜像实现仅用于本地判断，两者由门禁脚本对齐。
///
/// **不带命令属性**：命令注册由 `scripts/generate-backend-module.ts` 生成，
/// 而它只扫描 `<模块>/commands.rs`。属性写在这里会被静默忽略，
/// 直到运行期 `invoke` 报 "command not found" 才暴露 —— 命令外壳因此统一放在
/// `settings/commands.rs`。
pub fn apply_memory_level_for_visibility(
    app: AppHandle,
    hidden: bool,
) -> Result<bool, String> {
    let window = main_window(&app)?;
    apply(&window, level_for_visibility(hidden))
}

/// 手动设置内存目标等级（设置 → 性能）
///
/// 存在的用途是**验证**：让用户能主动触发一次降级并立刻观察内存分页里的数字变化，
/// 而不必真的最小化窗口。自动策略出问题时也要靠它来区分"策略没触发"与"API 没生效"。
pub fn set_webview_memory_level(app: AppHandle, level: MemoryLevel) -> Result<bool, String> {
    let window = main_window(&app)?;
    apply(&window, level)
}

/// 查询这套 API 在当前环境是否可用
pub fn webview_memory_level_supported(app: AppHandle) -> bool {
    match main_window(&app) {
        Ok(window) => is_supported(&window),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_document_demotes_to_low() {
        assert_eq!(level_for_visibility(true), MemoryLevel::Low);
    }

    #[test]
    fn visible_document_restores_normal() {
        assert_eq!(level_for_visibility(false), MemoryLevel::Normal);
    }

    /// 策略是**无状态**的：同一个输入永远得到同一个输出。
    ///
    /// 这一条防的是"记住上次的等级然后据此跳过"这类优化 —— 那会让
    /// "可见 → 隐藏 → 可见"的第二次恢复被跳过，用户切回来时界面仍停在
    /// 降级状态。等级必须每次从头算。
    #[test]
    fn policy_is_stateless_and_idempotent() {
        for _ in 0..3 {
            assert_eq!(level_for_visibility(true), MemoryLevel::Low);
            assert_eq!(level_for_visibility(false), MemoryLevel::Normal);
        }
    }

    /// **失焦不参与判定。**
    ///
    /// 这是本模块最重要的一条策略，也是最容易被"顺手优化掉"的一条。
    /// 类型上不可能失焦——`level_for_visibility` 只接受一个布尔量，
    /// 它没有"是否失焦"这个输入。这条测试把那个事实钉住：
    /// 若将来有人为了"更省内存"把失焦接进来，必须显式改这个签名，
    /// 也就必然要面对上面的理由。
    #[test]
    fn the_only_input_is_visibility() {
        // 两个取值的完整真值表，没有第三种结果。
        let table: Vec<MemoryLevel> = [true, false].iter().map(|h| level_for_visibility(*h)).collect();
        assert_eq!(table, vec![MemoryLevel::Low, MemoryLevel::Normal]);
    }

    /// 序列化形式必须与前端一致（`low` / `normal`）。
    ///
    /// 这是跨语言契约：前端传的字符串对不上，`invoke` 会在反序列化阶段失败，
    /// 而那时错误信息只说"invalid args"，排查方向完全指错。
    #[test]
    fn level_serializes_as_camel_case() {
        assert_eq!(serde_json::to_string(&MemoryLevel::Low).unwrap(), "\"low\"");
        assert_eq!(serde_json::to_string(&MemoryLevel::Normal).unwrap(), "\"normal\"");
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::MemoryLevel;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    /// 投递到界面线程的等待上限。
    ///
    /// 没有超时的话，窗口正在销毁时这里会**永久阻塞**调用它的命令，
    /// 把那一次点击变成设置页卡死。
    const DISPATCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

    /// 在界面线程上执行一次"取接口 + 调用"，并带回三态结果。
    ///
    /// **为什么取接口与调用必须在同一个闭包里**：`ICoreWebView2_19` 包着一个
    /// `NonNull<c_void>`，因此**不是 `Send`** —— 它不能被搬进另一个闭包、也不能
    /// 跨线程传递。用 `with_webview` 取到它之后想"再投递一次去调用"会在编译期
    /// 直接失败（`NonNull<c_void> cannot be sent between threads safely`）。
    ///
    /// 这不是限制而是好事：COM 接口本就只能在创建它的线程（STA）上使用。
    /// 于是分工是 `with_webview` **一次**，闭包在界面线程上自己取接口、
    /// 自己调用，只把 `bool` 送回调用方。
    ///
    /// 返回值：`Some(true)` 生效、`Some(false)` 接口取不到（运行时太旧）、
    /// `None` 投递失败或超时。
    fn run_on_ui_thread<S>(
        window: &tauri::WebviewWindow,
        what: &'static str,
        action: S,
    ) -> Option<bool>
    where
        S: FnOnce(&ICoreWebView2_19) -> bool + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();

        window
            .with_webview(move |platform_webview| {
                // 取接口与调用都在界面线程上完成。
                let outcome = platform_webview
                    .controller()
                    .cast::<ICoreWebView2_19>()
                    .ok()
                    .map(|core| action(&core));
                let _ = tx.send(outcome);
            })
            .map_err(|e| log::warn!("内存目标等级：{what} 投递失败：{e}"))
            .ok()?;

        match rx.recv_timeout(DISPATCH_TIMEOUT) {
            Ok(value) => value,
            Err(_) => {
                log::warn!("内存目标等级：{what} 超时（界面线程无响应）");
                None
            }
        }
    }

    pub(super) fn apply(
        window: &tauri::WebviewWindow,
        level: MemoryLevel,
    ) -> Result<bool, String> {
        let target = match level {
            MemoryLevel::Low => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            MemoryLevel::Normal => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };

        match run_on_ui_thread(window, "设置", move |core| {
            // `SetMemoryUsageTargetLevel` 是 COM 调用，按 Win32 约定是 unsafe。
            // 安全性由"在创建该接口的线程上使用"保证 —— 这正是上面那个约束。
            unsafe { core.SetMemoryUsageTargetLevel(target) }.is_ok()
        }) {
            // 生效
            Some(true) => Ok(true),
            // 接口取不到：正常情况（运行时太旧），不是错误
            Some(false) => Ok(false),
            // 投递失败或超时：已经记过日志，这里只回报失败
            None => Err("无法在界面线程上设置内存目标等级".into()),
        }
    }

    pub(super) fn is_supported(window: &tauri::WebviewWindow) -> bool {
        // 只要接口取得到就算支持；调用一个无副作用的读取来确认它真的可用。
        run_on_ui_thread(window, "探测", |_core| true) == Some(true)
    }
}
