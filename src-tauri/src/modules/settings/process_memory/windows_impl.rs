// src-tauri/src/modules/settings/process_memory/windows_impl.rs
//
// Windows 侧的进程树枚举与内存读取。
//
// 全部用 `windows-sys` 的裸声明，理由与 `plugins/icon.rs` 相同：只需要几个
// Win32 函数，不需要 COM 包装与 Result 化，编译时间与体积都小得多。
//
// 这里刻意**不用 WMI**：那需要额外依赖，而且返回的是一串变体数据，
// 为了六个数字把一整套 COM 拖进来不划算。
//
// 每一个 `OpenProcess` 都可能因权限不足失败（受保护进程、跨用户边界）。
// 这种情况下我们**跳过该进程并计数**，而不是让整个快照失败 ——
// 少一个进程的数字远好过什么都看不到。

use std::collections::HashMap;

use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::{classify_command_line, descendants_of, now_millis, MemorySnapshot, ProcessKind, ProcessMemory};

/// 一次快照最多接受多少个进程条目。
///
/// 这不是"预期值"，而是一道**上限**：进程树来自系统快照，理论上不该超过几十个；
/// 但一旦出现异常的父子关系（例如某种进程链），不设上限就会把内存快照本身
/// 变成一个吃内存的操作 —— 排查内存问题的工具不该自己制造内存问题。
const MAX_PROCESSES: usize = 512;

/// 枚举系统进程时最多遍历多少条。
///
/// 与 `MAX_PROCESSES` 不同：那个限的是**我们自己的**进程数，
/// 这个限的是**系统全部**进程数（Windows 正常在 100~400 条之间）。
/// 超限只说明环境异常，此时提前收手即可 —— 我们要找的子树在遍历早期就已完整。
const MAX_SYSTEM_PROCESSES: usize = 4096;

/// 读取命令行时第一次尝试的缓冲区大小（`UNICODE_STRING` 是 16 字节，
/// 加上实际文本）。给一个偏小的初值，遇到 `STATUS_INFO_LENGTH_MISMATCH`
/// 再按系统回报的长度重试。
const COMMAND_LINE_INITIAL_BYTES: u32 = 2048;

/// 读取命令行时允许的最大缓冲区，防止异常的 `return_length` 让我们去分配一大块。
const COMMAND_LINE_MAX_BYTES: u32 = 64 * 1024;

pub(super) fn collect() -> MemorySnapshot {
    let root_pid = std::process::id();

    let Some((parent_of, names)) = snapshot_processes() else {
        // 连快照都拿不到：给出诚实的空结果 + 标记不支持，而不是假装成功。
        let mut empty = MemorySnapshot::unsupported();
        empty.root_pid = root_pid;
        return empty;
    };

    let (pids, entries) = descendants_of(root_pid, &parent_of, &names);

    let mut processes: Vec<ProcessMemory> = Vec::new();
    let mut unreadable = 0u32;

    // 宿主进程自己也列出来：它通常是全场最小的一个（实测 4 MB），
    // 而"我们的 Rust 侧几乎不占内存"这件事本身就是一条有用的结论。
    if let Some((private, working)) = memory_of(root_pid) {
        processes.push(ProcessMemory::new(
            root_pid,
            names.get(&root_pid).cloned().unwrap_or_else(|| "modulith-desktop".into()),
            ProcessKind::Host,
            private,
            working,
        ));
    } else {
        unreadable += 1;
    }

    for pid in pids.into_iter().take(MAX_PROCESSES) {
        let Some(entry) = entries.get(&pid) else {
            continue;
        };
        let Some((private, working)) = memory_of(pid) else {
            unreadable += 1;
            continue;
        };

        // 命令行取不到时 `classify_command_line` 会给出 `Unknown` ——
        // 那是如实标记，不是猜成 `Utility`。
        let command_line = command_line_of(pid);
        let kind = classify_command_line(command_line.as_deref(), false);

        processes.push(ProcessMemory::new(pid, entry.name.clone(), kind, private, working));
    }

    processes.sort_by(|a, b| b.private_bytes.cmp(&a.private_bytes));

    let total_private_bytes = processes.iter().map(|p| p.private_bytes).sum();
    let total_working_set = processes.iter().map(|p| p.working_set).sum();

    MemorySnapshot {
        sampled_at: now_millis(),
        root_pid,
        processes,
        total_private_bytes,
        total_working_set,
        unreadable,
        supported: true,
    }
}

/// 本应用进程树里的全部 pid，**含宿主进程自己**。
///
/// 与 `collect` 共用同一份枚举与子树回溯逻辑：回收工作集与内存快照必须看到
/// **同一棵树**，各写一份必然在某个边界上分叉 —— 而分叉的表现是
/// "回收到了一半进程"，那是很难被发现的。
pub(super) fn self_tree_pids() -> Option<Vec<u32>> {
    let root_pid = std::process::id();
    let (parent_of, names) = snapshot_processes()?;

    // 宿主进程排在最前：它是我们一定有权回收的那一个，
    // 因此即使子树枚举出了什么意外，至少这个回收会成功。
    let (pids, _entries) = descendants_of(root_pid, &parent_of, &names);

    let mut all = Vec::with_capacity(pids.len() + 1);
    all.push(root_pid);
    all.extend(pids);
    Some(all)
}

/// 枚举系统里全部进程，返回 (pid→父pid, pid→可执行文件名)。
///
/// 返回 `None` 表示连进程列表都拿不到 —— 那才是整体失败；
/// 单个进程取不到内存不算失败（见 `collect`）。
fn snapshot_processes() -> Option<(HashMap<u32, u32>, HashMap<u32, String>)> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
        return None;
    }

    let mut parent_of = HashMap::new();
    let mut names = HashMap::new();
    let mut count = 0usize;

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        count += 1;
        if count > MAX_SYSTEM_PROCESSES {
            // 系统进程数异常多时不继续：这份数据只是用来找我们自己的子树，
            // 取到足够多之后收益为零，而继续遍历的成本随进程数线性增长。
            break;
        }

        let pid = entry.th32ProcessID;
        if pid != 0 {
            parent_of.insert(pid, entry.th32ParentProcessID);

            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            names.insert(pid, String::from_utf16_lossy(&entry.szExeFile[..len]));
        }

        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }

    unsafe { CloseHandle(snapshot) };
    Some((parent_of, names))
}

/// 读取某个进程的 (私有内存, 工作集)。
///
/// 用 `PagefileUsage` 作为"私有内存"：它就是任务管理器"内存"列的口径，
/// 我们给出的数字必须能和用户看到的那个对上，否则这个面板会被当成在狡辩。
fn memory_of(pid: u32) -> Option<(u64, u64)> {
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

    Some((counters.PagefileUsage as u64, counters.WorkingSetSize as u64))
}

/// 读取某个进程的完整命令行。
///
/// 用 `NtQueryInformationProcess(ProcessCommandLineInformation)` 而不是
/// `Win32_Process` 的 WMI：前者是一次系统调用，后者要拉起一整套 COM。
///
/// 取不到时返回 `None` —— 调用方据此把进程标成 `Unknown` 而不是猜一个分类。
/// **权限不足是正常情况**（受保护的进程读不到命令行），因此这里不记日志，
/// 否则每采样一次就会往日志里写一行噪音。
fn command_line_of(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let result = query_command_line(handle);
    unsafe { CloseHandle(handle) };
    result
}

fn query_command_line(handle: *mut std::ffi::c_void) -> Option<String> {
    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };
    use windows_sys::Win32::Foundation::STATUS_INFO_LENGTH_MISMATCH;

    // UNICODE_STRING 是 { u16 Length; u16 MaximumLength; *mut u16 Buffer; }。
    // 这里手工声明而不是引 `Wdk_Foundation`：多一个 feature 只为省一个 16 字节的
    // 结构体不划算，而它的布局是 Windows ABI 的稳定部分。
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    let mut size = COMMAND_LINE_INITIAL_BYTES;
    let mut buffer: Vec<u8> = Vec::new();

    for _ in 0..4 {
        buffer.resize(size as usize, 0);
        let mut returned: u32 = 0;

        let status = unsafe {
            NtQueryInformationProcess(
                handle,
                ProcessCommandLineInformation,
                buffer.as_mut_ptr() as *mut std::ffi::c_void,
                size,
                &mut returned,
            )
        };

        if status == STATUS_INFO_LENGTH_MISMATCH {
            // 系统会回报需要的长度；夹到上限之后重试，避免异常长度导致大分配。
            let needed = returned.max(COMMAND_LINE_INITIAL_BYTES);
            if needed > COMMAND_LINE_MAX_BYTES {
                return None;
            }
            size = needed;
            continue;
        }

        if status < 0 {
            return None;
        }

        // 成功：buffer 的前 16 字节是 UNICODE_STRING，它的 Buffer 指向
        // **同一个缓冲区内部**的文本（因此这里不额外分配）。
        let us = unsafe { &*(buffer.as_ptr() as *const UnicodeString) };
        if us.buffer.is_null() || us.length == 0 {
            return None;
        }

        let units = (us.length as usize) / 2;
        let text = unsafe { std::slice::from_raw_parts(us.buffer, units) };
        return Some(String::from_utf16_lossy(text));
    }

    None
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// **真实调用**一次采集。
    ///
    /// 纯逻辑测试能证明分类与遍历是对的，但证明不了"这条系统调用链真的能跑通"：
    /// `OpenProcess` 的权限位、进程快照的句柄取值、`UNICODE_STRING` 的结构布局，
    /// 任何一处写错都只在运行期暴露。这条测试让本机当前真实的进程树来验证它。
    ///
    /// 因此它**不断言"一定有几个子进程"** —— `cargo test` 往往在别的进程里跑，
    /// 那时没有 WebView2；断死进程数会变成一条时好时坏的测试。
    /// 它断言的是"结果自洽且确实读到了东西"。
    #[test]
    fn live_snapshot_is_coherent() {
        let snapshot = collect();

        assert!(snapshot.supported, "Windows 上必须报告支持进程树枚举");
        assert_eq!(snapshot.root_pid, std::process::id());
        assert!(!snapshot.processes.is_empty(), "至少要能读到本进程自己的内存");

        // 本进程必须被归类成宿主，而不是"未识别" —— 那是分类链路的第一个断言点。
        let host = snapshot
            .processes
            .iter()
            .find(|p| p.pid == snapshot.root_pid)
            .expect("宿主进程必须在结果里");
        assert_eq!(host.kind, ProcessKind::Host);
        assert!(host.private_bytes > 0, "宿主进程的私有内存不应当是 0");

        // 合计必须与逐条相加一致：两者由同一份数据算出，不一致就说明有重复或漏加。
        let sum: u64 = snapshot.processes.iter().map(|p| p.private_bytes).sum();
        assert_eq!(sum, snapshot.total_private_bytes);

        // 降序排列（界面直接按这个顺序渲染）。
        for pair in snapshot.processes.windows(2) {
            assert!(
                pair[0].private_bytes >= pair[1].private_bytes,
                "进程必须按私有内存降序"
            );
        }
    }

    /// pid 在结果里不得重复。
    ///
    /// 重复会让合计内存被算高，而那份数字正是用户要看的 —— 一个偏大的数字会
    /// 让我们去优化一个并不存在的问题。
    #[test]
    fn live_snapshot_has_no_duplicate_pids() {
        let snapshot = collect();
        let mut pids: Vec<u32> = snapshot.processes.iter().map(|p| p.pid).collect();
        let total = pids.len();
        pids.sort_unstable();
        pids.dedup();
        assert_eq!(pids.len(), total, "同一个 pid 不允许出现两次");
    }

    /// 进程列表里**不允许**出现与本进程无父子关系的进程。
    ///
    /// 这正是本模块存在的理由：同机其它 WebView2 应用的进程若被算进来，
    /// 数字会虚高一倍（本机实测有 13 个 msedgewebview2 进程分属两个应用）。
    /// 断言方式是反证：结果里除宿主外的每个 pid，都必须在父关系表里
    /// 能一路回溯到本进程。
    #[test]
    fn live_snapshot_excludes_unrelated_processes() {
        let snapshot = collect();
        let Some((parent_of, _names)) = snapshot_processes() else {
            // 连系统快照都拿不到时不算失败：这条测试是反证，前提条件不成立就直接跳过。
            return;
        };

        for process in &snapshot.processes {
            if process.pid == snapshot.root_pid {
                continue;
            }

            let mut current = process.pid;
            let mut hops = 0;
            while current != snapshot.root_pid {
                // 每一跳都必须存在，且不能无限回溯（父关系表理论上不成环）。
                let Some(parent) = parent_of.get(&current).copied() else {
                    panic!("pid {} 回溯不到本进程：父关系缺失", process.pid);
                };
                if parent == 0 || hops > 64 {
                    panic!("pid {} 与本进程没有父子关系（被误算进来了）", process.pid);
                }
                current = parent;
                hops += 1;
            }
        }
    }

    /// 结果里必须**真的**包含我们拉起的子进程。
    ///
    /// 上面那条反证只证明"没有混进无关进程"，但一个**永远返回空列表**的实现
    /// 也能通过它。所以这里真的拉起一个子进程，再确认它出现在结果里 ——
    /// 这才是"进程树遍历可用"的正向证据。
    ///
    /// 用 `cmd.exe /c ping` 而不是改造成 WebView2：WebView2 的子进程不是测试能
    /// 按需拉起的，而这个测试要验证的是**父子链路**，与子进程是什么无关。
    #[test]
    fn live_snapshot_includes_a_real_child_process() {
        use std::process::{Command, Stdio};

        let mut child = match Command::new("cmd.exe")
            .args(["/c", "ping", "-n", "6", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            // 拉不起子进程（受限环境）时跳过：这条测试是正向证据，
            // 前提条件不成立时不该判失败，否则它会变成一条环境相关的假红。
            Err(_) => return,
        };

        // 给子进程一点时间真正起来。ping -n 6 大约持续 5 秒，足够宽裕。
        // 轮询而不是固定 sleep：慢机器上固定等待会偶发失败。
        let child_pid = child.id();
        let mut found = false;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let snapshot = collect();
            if let Some(entry) = snapshot.processes.iter().find(|p| p.pid == child_pid) {
                // 真实读到了内存：0 说明内存读取那条路没走通。
                assert!(
                    entry.private_bytes > 0,
                    "子进程必须能被读到私有内存，实际为 {}",
                    entry.private_bytes
                );
                found = true;
                break;
            }
        }

        let _ = child.kill();
        let _ = child.wait();

        assert!(found, "拉起的子进程 {child_pid} 必须出现在进程树里");
    }
}
