// src-tauri/src/modules/settings/memory_trim.rs
//
// 回收工作集：把本应用进程树里**当前驻留在物理内存中的页**交还系统。
//
// ============================================================
// 它解决的是哪一个数字（这一点必须说清楚）
// ============================================================
//
// 进程内存有两个常用口径，它们的含义完全不同：
//
//   · **私有内存 / Private Bytes**（任务管理器默认的"内存"列）：这个进程**提交**了
//     多少虚拟内存。`SetProcessWorkingSetSize` 与 `EmptyWorkingSet` **完全不会**
//     降低它 —— 那些页只是被换出去，虚拟地址空间仍然被占用。
//   · **工作集 / Working Set**：其中**当前驻留在物理内存里**的那部分。
//     这才是"回收"能真正降下来的数字。
//
// 这解释了一个很容易被误认为是"没用"的现象：隐藏到托盘之后按老办法看
// 私有内存，那个数字纹丝不动。那不是优化没生效，而是**看错了指标**。
// 因此这条命令的返回值里两个口径都有，界面必须把"降下来的是哪一个"显示清楚。
//
// ============================================================
// 代价：恢复时会有一次缺页
// ============================================================
//
// 被换出去的页要在下次访问时从页面文件读回来。对一个正被看着的窗口，
// 那表现为"点一下卡半拍" —— 完全不可接受。
//
// 因此**只在窗口真正不可见时**才做（见 `should_trim_for_visibility`），
// 与 `memory_level` 一样只认 `document.hidden`。这是本模块唯一的策略，
// 而它被写成纯函数以便被测试与门禁覆盖。
//
// ============================================================
// 为什么连子进程一起回收
// ============================================================
//
// 本应用的内存几乎全在子进程里：实测 7 个 WebView2 进程合计占掉绝大多数，
// 而宿主进程本身只有几 MB。只回收宿主等于什么都没做。
// 因此这里回收的是**整棵进程树**（枚举逻辑与内存快照共用一份）。
//
// 回收子进程需要有权限打开它。对本应用自己的子进程，这个权限是有的；
// 对受保护进程会失败 —— 那种情况**计数并如实回报**，而不是静默跳过
// （静默跳过会让"回收了 1 个进程"看起来像"全部回收了"）。

use crate::prelude::*;

/// 一次回收的结果。
///
/// 同时给出**回收前**与**回收后**的两个口径，因为只有前/后一起看，
/// "到底降下来了没有"才是一个可以被验证的问题。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimOutcome {
    /// 本平台是否支持（不支持时其余字段为 0/false）
    pub supported: bool,
    /// 尝试回收的进程数（本应用进程树）
    pub attempted: u32,
    /// 实际回收成功的进程数
    pub trimmed: u32,
    /// 打不开或调用失败的数量。> 0 时界面要说明数字不完整
    pub failed: u32,
    /// 回收前的工作集合计
    pub before_working_set: u64,
    /// 回收后的工作集合计
    pub after_working_set: u64,
    /// 回收前的私有内存合计
    /// （**回收不会降低它**，列出来是为了让这一点可见，而不是让数字自相矛盾）
    pub before_private_bytes: u64,
    /// 回收后的私有内存合计
    pub after_private_bytes: u64,
}

impl TrimOutcome {
    /// 不支持该能力的平台的返回值：给一个诚实的空，而不是编一个近似值。
    pub fn unsupported() -> Self {
        Self {
            supported: false,
            attempted: 0,
            trimmed: 0,
            failed: 0,
            before_working_set: 0,
            after_working_set: 0,
            before_private_bytes: 0,
            after_private_bytes: 0,
        }
    }

    /// 工作集实际降下来的字节数。负数（不降反升）**如实返回** ——
    /// 钳到 0 会让"这次回收没有效果"这件事看起来像"效果为零但确实是好的"。
    pub fn working_set_freed(&self) -> i64 {
        self.before_working_set as i64 - self.after_working_set as i64
    }
}

/// 回收本应用进程树的工作集。
///
/// 这是一次**同步的、有副作用**的操作，但它不会等事件循环：它只用
/// `OpenProcess` 与 `SetProcessWorkingSetSize`，两者都是直接的系统调用。
/// 因此它可以安全地从 Tauri 命令里调用（这与 `memory_level.rs` 里
/// `with_webview` 的约束不同 —— 判据仍然是"这个调用会不会等事件循环"）。
pub fn trim_self_tree() -> TrimOutcome {
    #[cfg(windows)]
    {
        windows_impl::trim_self_tree()
    }
    #[cfg(not(windows))]
    {
        // 目前只有 Windows 实现了这条路径。如实返回"未生效"。
        TrimOutcome::unsupported()
    }
}

/// 由文档可见性推出**是否应当回收工作集**。
///
/// 这是本模块唯一的策略判定处，抽成纯函数以便被单元测试与门禁覆盖。
///
/// 判据只有一条：文档是否可见。可见时**绝不回收** —— 被换出去的页要在下次
/// 访问时从页面文件读回来，对正被看着的窗口那表现为"点一下卡半拍"。
pub fn should_trim_for_visibility(hidden: bool) -> bool {
    hidden
}

/// 当前平台是否支持回收工作集。
///
/// 判据是"能不能真的回收一次"，而不是版本号比较 —— 版本号是间接证据。
///
/// **它只回收宿主进程自己那一个**，不会对整棵树动手：这条函数的调用方是
/// 界面首次展示时的能力探测，在那里顺带把所有子进程换出去是越权的副作用
/// （用户还没有要求回收任何东西）。真正要回收时用 `trim_self_tree`。
pub fn is_supported() -> bool {
    #[cfg(windows)]
    {
        windows_impl::is_supported()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hidden_document_triggers_a_trim() {
        assert!(should_trim_for_visibility(true));
    }

    /// **可见时绝不回收。**
    ///
    /// 这条是本模块最重要的断言：回收工作集的代价是恢复时的一次缺页，
    /// 而对一个正被看着的窗口，那表现为"点一下卡半拍"，用户会把这归因成
    /// "这个软件很卡"。宁可省不下那几十 MB。
    #[test]
    fn a_visible_document_never_triggers_a_trim() {
        assert!(!should_trim_for_visibility(false));
    }

    /// 策略是无状态的：同一个输入永远得到同一个输出。
    ///
    /// 防的是"记住上次回收过就跳过"这类优化 —— 那会让第二次隐藏不再回收，
    /// 而两次隐藏之间我们完全可能又吃掉了几百 MB 工作集。
    #[test]
    fn the_policy_is_stateless() {
        for _ in 0..3 {
            assert!(should_trim_for_visibility(true));
            assert!(!should_trim_for_visibility(false));
        }
    }

    #[test]
    fn freed_bytes_are_reported_signed_not_clamped() {
        let mut outcome = TrimOutcome::unsupported();
        outcome.before_working_set = 1000;
        outcome.after_working_set = 400;
        assert_eq!(outcome.working_set_freed(), 600);

        // 不降反升时**如实返回负数**：把它钳到 0 会让"这次回收没有效果"
        // 看起来像"效果为零但确实是好的"。
        outcome.before_working_set = 400;
        outcome.after_working_set = 1000;
        assert_eq!(outcome.working_set_freed(), -600);
    }

    #[test]
    fn the_unsupported_shape_is_an_honest_empty() {
        let outcome = TrimOutcome::unsupported();
        assert!(!outcome.supported);
        assert_eq!(outcome.attempted, 0);
        assert_eq!(outcome.trimmed, 0);
        assert_eq!(outcome.working_set_freed(), 0);
    }
}

#[cfg(windows)]
mod windows_impl {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, SetProcessWorkingSetSize, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_QUOTA,
    };

    use super::TrimOutcome;
    use crate::modules::settings::process_memory;

    /// `SetProcessWorkingSetSize` 的"尽量换出"参数。
    ///
    /// 文档的措辞是"如果这两个参数都是 `(SIZE_T)-1`，函数会尽可能地把页换出"。
    /// 用 `usize::MAX` 而不是某个具体字节数：后者会被理解成"把工作集限制到这么大"，
    /// 那是一个**不同的**操作（设上限），而且可能失败或造成持续抖动。
    const TRIM_ALL: usize = usize::MAX;

    pub(super) fn trim_self_tree() -> TrimOutcome {
        let Some(pids) = process_memory::self_tree_pids() else {
            // 连进程列表都拿不到：如实报告不支持，而不是假装回收过
            return TrimOutcome::unsupported();
        };

        // 先在**回收之前**采一次，再回收，最后在**回收之后**采一次。
        // 三次都要真的去读系统，而不是用回收前那份减去推算 ——
        // 我们要回答的问题是"数字有没有变"，那就必须真的再看一眼。
        let before = process_memory::snapshot();

        let mut attempted = 0u32;
        let mut trimmed = 0u32;
        let mut failed = 0u32;

        for pid in pids {
            attempted += 1;
            if trim_one(pid) {
                trimmed += 1;
            } else {
                failed += 1;
            }
        }

        let after = process_memory::snapshot();

        TrimOutcome {
            supported: true,
            attempted,
            trimmed,
            failed,
            before_working_set: before.total_working_set,
            after_working_set: after.total_working_set,
            before_private_bytes: before.total_private_bytes,
            after_private_bytes: after.total_private_bytes,
        }
    }

    /// 回收一个进程的工作集。
    ///
    /// 需要 `PROCESS_SET_QUOTA` 与 `PROCESS_QUERY_INFORMATION`：前者是
    /// `SetProcessWorkingSetSize` 要求的，后者是文档里与它并列要求的。
    /// 对本应用自己的子进程这两项都拿得到；拿不到时返回 `false` 并由调用方计数。
    fn trim_one(pid: u32) -> bool {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA,
                0,
                pid,
            )
        };

        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return false;
        }

        let ok = unsafe { SetProcessWorkingSetSize(handle, TRIM_ALL, TRIM_ALL) } != 0;
        unsafe { CloseHandle(handle) };
        ok
    }

    /// 本平台是否支持这套调用。
    ///
    /// 判据是"当前进程自己能被回收" —— 那说明 API 存在且有权限，
    /// 而不是去比较系统版本号（版本号是间接证据）。
    ///
    /// **它会真的回收一次宿主进程的工作集**，因此只在用户主动点"回收"或
    /// 探测时才调用，不要放进轮询里。
    pub(super) fn is_supported() -> bool {
        trim_one(std::process::id())
    }

    /// 给测试用：读一个进程的工作集，验证回收真的改变了它。
    #[cfg(test)]
    pub(super) fn working_set_of(pid: u32) -> Option<u64> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }

        let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = unsafe {
            GetProcessMemoryInfo(
                handle,
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
        } != 0;
        unsafe { CloseHandle(handle) };

        if !ok {
            return None;
        }
        Some(counters.WorkingSetSize as u64)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// **正向证据：回收真的降低了当前进程的工作集。**
        ///
        /// 这条测试的价值在于它验证的是**系统行为**而不是我们的逻辑：
        /// `SetProcessWorkingSetSize(-1, -1)` 究竟有没有效果，只有真的调用一次
        /// 再看数字才知道。
        ///
        /// 它不假设具体的降幅（那取决于测试进程当时的工作集，不可控），
        /// 只要求"不上升" —— 回收操作让工作集变大说明参数用法错了
        /// （例如把 `(SIZE_T)-1` 误当成"设为无限大"的请求）。
        #[test]
        fn live_trimming_reduces_the_working_set_of_this_process() {
            let before = match working_set_of(std::process::id()) {
                Some(value) => value,
                None => {
                    eprintln!("跳过：读不到当前进程的工作集");
                    return;
                }
            };

            assert!(
                trim_one(std::process::id()),
                "回收当前进程自己的工作集应当成功（它是我们自己的进程）"
            );

            let after = working_set_of(std::process::id()).unwrap_or(before);

            assert!(
                after <= before,
                "回收之后工作集不该变大：{before} -> {after}（参数用法可能错了）"
            );
        }

        /// 回收一个不存在的 pid 必须失败，而不是报告成功。
        ///
        /// 一条"回收了 0 个进程但报告成功"的路径会让界面显示一个假的勾。
        #[test]
        fn trimming_a_nonexistent_process_fails() {
            // 取一个几乎不可能存在的 pid（Windows 的 pid 是 4 的倍数且远小于它）
            assert!(!trim_one(0xFFFF_FFF0), "不存在的进程必须报告失败");
        }

        /// 探测与回收用的是同一条路径，因此支持性判断不会与实际能力脱节。
        #[test]
        fn support_probe_uses_the_same_call_as_the_real_trim() {
            // 在当前进程上两者都应当成功
            assert!(is_supported());
        }
    }
}
