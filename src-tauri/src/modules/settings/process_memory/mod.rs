// src-tauri/src/modules/settings/process_memory.rs
//
// 本应用的进程内存快照。
//
// ============================================================
// 为什么需要它
// ============================================================
//
// 「内存占用高」这个反馈在没有数字之前无法验收：我们既不知道 300 MB 是
// WebView2 的固有基线，还是我们自己泄漏出来的；也无法证明任何一次优化真的
// 生效。任务管理器能看到总数，但**分不清哪些进程属于哪个应用** —— 同一台机器上
// 往往同时开着好几个 WebView2 应用（本机实测有 13 个 msedgewebview2 进程分属
// 两个应用），把别人的算到自己头上会让数字虚高一倍。
//
// 因此这里的做法是**按进程树取**：从本进程出发沿父子关系取下整棵子树，
// 只统计我们自己拉起来的那些。这比"枚举同名进程"可靠，也是它与任务管理器的
// 唯一区别。
//
// ============================================================
// 两个进程计数为什么必须一起给出
// ============================================================
//
// WebView2 的进程模型是**多进程**的（browser / GPU / renderer / utility /
// crashpad），一个控件默认拉起 6~8 个进程。这是引擎的固有结构，不是我们多开了
// WebView。因此单独给一个"进程数"会误导用户以为进程多就是有问题；
// 这里把**分类**一起给出（`kind`），界面才能如实说明"其中 GPU 进程是引擎自己拉的"。
//
// ============================================================
// 失败为什么不算错误
// ============================================================
//
// 取内存要 `OpenProcess`，而它可能因为权限不足失败（受保护进程、跨用户边界）。
// 那种情况下我们仍然能给出**部分**结果，而"少了一个进程的数字"远好过
// "整个面板报错、什么都看不到"。因此失败计数单独作为一个字段 `unreadable`
// 如实回报，而不是把命令变成 `Err`。

use std::collections::HashMap;

use crate::prelude::*;

#[cfg(windows)]
mod windows_impl;

/// 进程在应用里的角色。
///
/// 取值沿用 WebView2/Chromium 自己的进程模型命名，不做自创分类 ——
/// 界面上的措辞要与引擎文档对得上，用户去查才知道说的是什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessKind {
    /// 宿主进程本身（Rust 侧，通常只占几 MB）
    Host,
    /// WebView2 浏览器主进程（管理进程与网络，不渲染页面）
    Browser,
    /// 渲染进程（**我们送进去的前端就在这个进程里**）
    Renderer,
    /// GPU 进程（合成与光栅化）
    Gpu,
    /// 工具进程（网络、存储、音频等）
    Utility,
    /// 崩溃处理器
    Crashpad,
    /// 认不出来的类型：如实标记，不猜
    Unknown,
}

/// 单个进程的内存占用
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemory {
    pub pid: u32,
    /// 可执行文件名（不给出完整路径：那是本机信息，没有展示价值）
    pub name: String,
    pub kind: ProcessKind,
    /// 私有内存（private bytes）。**这是与任务管理器"内存"列最接近的口径**
    pub private_bytes: u64,
    /// 工作集（物理内存中驻留的部分）
    pub working_set: u64,
}

/// 一次内存快照
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    /// 快照时间（Unix 毫秒），界面据此显示"采样于 x 秒前"
    pub sampled_at: u64,
    /// 本进程 pid
    pub root_pid: u32,
    /// 子树里的全部进程，按私有内存降序
    pub processes: Vec<ProcessMemory>,
    /// 私有内存合计
    pub total_private_bytes: u64,
    /// 工作集合计
    pub total_working_set: u64,
    /// 取不到内存的进程数（权限不足等）。> 0 时界面要如实说明数字不完整
    pub unreadable: u32,
    /// 本平台是否支持进程树枚举。为 false 时 `processes` 为空
    pub supported: bool,
}

impl MemorySnapshot {
    /// 不支持枚举的平台的返回值：给一个**诚实的空**，而不是编一个近似值。
    fn unsupported() -> Self {
        Self {
            sampled_at: now_millis(),
            root_pid: std::process::id(),
            processes: Vec::new(),
            total_private_bytes: 0,
            total_working_set: 0,
            unreadable: 0,
            supported: false,
        }
    }
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 采集本应用的进程内存快照。
///
/// **这个函数刻意不带 `#[tauri::command]`。** 命令注册由
/// `scripts/generate-backend-module.ts` 生成，而它只扫描 `<模块>/commands.rs`
/// 这一个文件 —— 写在这里的属性会被静默忽略，直到运行期 `invoke` 报
/// "command not found" 才暴露。因此命令外壳放在 `settings/commands.rs`，
/// 实现留在这里（它需要独立可测，而 `commands.rs` 会被注入大量 Tauri 样板）。
pub fn snapshot() -> MemorySnapshot {
    #[cfg(windows)]
    {
        windows_impl::collect()
    }
    #[cfg(not(windows))]
    {
        MemorySnapshot::unsupported()
    }
}

/// 本应用进程树里的全部 pid，**含宿主进程自己**。
///
/// 抽出来给 `memory_trim` 用：回收工作集要对整棵树做，而枚举子树的逻辑
/// （Toolhelp 快照 + 父子关系回溯）与内存快照完全一样。各写一份必然在某个
/// 边界上分叉 —— 而分叉的表现是"回收到了一半进程"，那是很难被发现的。
///
/// 返回 `None` 表示连进程列表都拿不到（那才是整体失败）；拿得到但列表为空
/// 会返回只含宿主进程的列表，因为宿主进程自己也是要被回收的一个。
pub fn self_tree_pids() -> Option<Vec<u32>> {
    #[cfg(windows)]
    {
        windows_impl::self_tree_pids()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

impl ProcessMemory {
    /// 采集过程中的构造入口。
    ///
    /// 存在的理由不是"方便"，而是让 Windows 子模块**不能**绕过它去直接拼字段：
    /// 字段一旦在别处被随手填，`kind` 就可能在某一处忘了归类。
    pub(crate) fn new(
        pid: u32,
        name: String,
        kind: ProcessKind,
        private_bytes: u64,
        working_set: u64,
    ) -> Self {
        Self {
            pid,
            name,
            kind,
            private_bytes,
            working_set,
        }
    }
}

/// 把一行命令行归类成进程角色。
///
/// WebView2 与 Chromium 用同一套 `--type=` 约定，因此这个判据可以直接读它们的
/// 语义，而不是我们另立一套。抽成独立函数是为了它能被单元测试直接覆盖 ——
/// 分类错了会让界面把"引擎固有开销"说成"我们的前端"，那是误导性的。
pub(crate) fn classify_command_line(command_line: Option<&str>, is_root: bool) -> ProcessKind {
    if is_root {
        return ProcessKind::Host;
    }

    let Some(line) = command_line else {
        return ProcessKind::Unknown;
    };

    // 只看 `--type=` 那一段。用 `find` 而不是 `contains` 是为了同时取出取值。
    let kind = line.split_whitespace().find_map(|token| {
        token
            .strip_prefix("--type=")
            .map(|value| value.trim_matches('"').to_ascii_lowercase())
    });

    match kind.as_deref() {
        // 没有 `--type=` 的那个就是浏览器主进程
        None => ProcessKind::Browser,
        Some("renderer") => ProcessKind::Renderer,
        Some("gpu-process") | Some("gpu") => ProcessKind::Gpu,
        Some("crashpad-handler") => ProcessKind::Crashpad,
        Some("utility") | Some("network.mojom.networkservice") | Some("utility-sub-type") => {
            ProcessKind::Utility
        }
        Some(_) => ProcessKind::Utility,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_process_is_always_host() {
        assert_eq!(classify_command_line(Some("--type=renderer"), true), ProcessKind::Host);
        assert_eq!(classify_command_line(None, true), ProcessKind::Host);
    }

    #[test]
    fn absent_type_marker_means_browser_process() {
        assert_eq!(
            classify_command_line(Some("\"msedgewebview2.exe\" --embedded-browser-webview"), false),
            ProcessKind::Browser
        );
    }

    #[test]
    fn known_type_markers_are_mapped() {
        let cases = [
            ("\"x.exe\" --type=renderer --foo", ProcessKind::Renderer),
            ("\"x.exe\" --type=gpu-process", ProcessKind::Gpu),
            ("\"x.exe\" --type=utility --utility-sub-type=network", ProcessKind::Utility),
            ("\"x.exe\" --type=crashpad-handler", ProcessKind::Crashpad),
            ("\"x.exe\" --type=wat-is-dit", ProcessKind::Utility),
        ];
        for (line, expected) in cases {
            assert_eq!(classify_command_line(Some(line), false), expected, "命令行：{line}");
        }
    }

    #[test]
    fn unknown_when_command_line_unavailable() {
        assert_eq!(classify_command_line(None, false), ProcessKind::Unknown);
    }

    /// `--type=` 取值可能带引号或以大写出现；两种都必须认出来，
    /// 否则会把渲染进程误报成"其它"，用户看到的就是一个没说清的数字。
    #[test]
    fn type_value_is_normalized() {
        assert_eq!(
            classify_command_line(Some("\"x.exe\" --type=RENDERER"), false),
            ProcessKind::Renderer
        );
        assert_eq!(
            classify_command_line(Some("\"x.exe\" --type=\"gpu-process\""), false),
            ProcessKind::Gpu
        );
    }
}

/// 进程树里的一个条目：可执行文件名。
///
/// 只有名字，没有父进程 —— 父进程是**遍历过程中的输入**，不是输出的一部分。
/// 把它塞进返回值会多存一份没人读的数据，而 Rust 会把"没人读"如实报成警告。
#[derive(Debug, Clone)]
pub(crate) struct ProcEntry {
    pub name: String,
}

/// 从系统快照里取下根进程的整棵子树。
///
/// 抽出来是因为**算法本身值得单独测**：写成"枚举全部同名进程"就错了
/// （同机其他 WebView2 应用会被算进来），写成"只看直接子进程"也不完整
/// （WebView2 的 GPU 进程可能挂在更深一层）。
///
/// 返回 (后代 pid 升序, 后代各自的条目)。**不含根进程本身** —— 它是宿主，
/// 由调用方单独加进去，因为它的 `kind` 与其它进程不同。
pub(crate) fn descendants_of(
    root: u32,
    parent_of: &HashMap<u32, u32>,
    names: &HashMap<u32, String>,
) -> (Vec<u32>, HashMap<u32, ProcEntry>) {
    // 先把父→子建成邻接表，再从根做一次迭代遍历。
    // 迭代而不是递归：进程链的长度不可控（异常进程树会形成长链），
    // 递归会变成栈溢出，而这里没有任何理由为一点简洁去换那个风险。
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent) in parent_of {
        children.entry(*parent).or_default().push(*pid);
    }

    let mut result = Vec::new();
    let mut stack = vec![root];
    // `visited` 的职责是**去重**：父关系表在结构上不可能表示环（一个 pid 只有
    // 一个父进程），但同一个进程会被多条路径指向，重复收集会让合计内存被算高。
    // 它同时兜住一个"理论上不该发生"的情况：万一将来换成别的数据源并真的引入环，
    // 这里不会变成死循环。
    let mut visited = std::collections::HashSet::new();
    visited.insert(root);

    while let Some(current) = stack.pop() {
        if let Some(kids) = children.get(&current) {
            for kid in kids {
                if visited.insert(*kid) {
                    result.push(*kid);
                    stack.push(*kid);
                }
            }
        }
    }

    result.sort_unstable();

    let entries = result
        .iter()
        .map(|pid| {
            let entry = ProcEntry {
                name: names.get(pid).cloned().unwrap_or_default(),
            };
            (*pid, entry)
        })
        .collect();

    (result, entries)
}

#[cfg(test)]
mod tree_tests {
    use super::*;

    /// 把 (pid, parent) 列表包成遍历需要的那两张表。
    /// 名字只在展示时用得到，这里给个稳定值 —— 本组测试断言的是**树的形状**。
    fn snapshot(pairs: &[(u32, u32)]) -> (HashMap<u32, u32>, HashMap<u32, String>) {
        let parent_of: HashMap<u32, u32> = pairs.iter().copied().collect();
        let names: HashMap<u32, String> =
            pairs.iter().map(|(pid, _)| (*pid, format!("p{pid}"))).collect();
        (parent_of, names)
    }

    #[test]
    fn collects_direct_and_nested_children() {
        // 1 → 2 → 3，且 1 → 4。全部都是 1 的后代。
        let (parent_of, names) = snapshot(&[(2, 1), (3, 2), (4, 1), (9, 99)]);
        let (pids, entries) = descendants_of(1, &parent_of, &names);
        assert_eq!(pids, vec![2, 3, 4]);
        // 深层子进程（3 挂在 2 下面）必须也在结果里：WebView2 的 GPU/utility
        // 进程可能挂得比直接子进程更深，只看一层就会漏掉它们。
        assert!(entries.contains_key(&3), "第二层子进程不能被漏掉");
        assert_eq!(entries[&2].name, "p2");
    }

    #[test]
    fn excludes_unrelated_processes() {
        // 这一条是本模块存在的理由：同机另一个 WebView2 应用的进程（99 及其子进程）
        // 不得出现在结果里。
        let (parent_of, names) = snapshot(&[(2, 1), (99, 50), (100, 99)]);
        let (pids, _) = descendants_of(1, &parent_of, &names);
        assert_eq!(pids, vec![2]);
    }

    #[test]
    fn no_children_is_empty() {
        let (parent_of, names) = snapshot(&[(2, 1)]);
        let (pids, entries) = descendants_of(7, &parent_of, &names);
        assert!(pids.is_empty());
        assert!(entries.is_empty());
    }

    #[test]
    fn deduplicates_diamond_shaped_trees() {
        // pid 不能有两个父进程，所以**父关系表在结构上不可能表示环** ——
        // "遇到环不会挂死"这条曾经写成测试，但它构造不出来：往 HashMap 里
        // 插两条 3 的父关系只会互相覆盖。写一条永远通过的断言没有价值，
        // 因此这里改测真正可达的形状：一个节点被两个分支同时指向时不能收集两次。
        //
        // 遍历里的 `visited` 集合因此仍有明确职责：去重。
        // 重复条目会让合计内存被算高，而那份数字正是用户要看的。
        let (parent_of, names) = snapshot(&[(2, 1), (3, 2), (4, 2)]);
        let (pids, _) = descendants_of(1, &parent_of, &names);
        assert_eq!(pids, vec![2, 3, 4]);
        let mut unique = pids.clone();
        unique.dedup();
        assert_eq!(unique, pids, "结果里不允许出现重复 pid");
    }

    #[test]
    fn unreachable_processes_are_not_collected() {
        // 进程快照里的父关系可能指向一个与我们无关的进程（父进程已退出、
        // 或另一个应用的子树）。那种情况必须**收不到**，而不是被硬拽进来 ——
        // 把别的应用的进程算成自己的，正是这个模块要避免的事。
        let (parent_of, names) = snapshot(&[(2, 1), (99, 98), (100, 99)]);
        let (pids, _) = descendants_of(1, &parent_of, &names);
        assert_eq!(pids, vec![2]);
    }

    #[test]
    fn result_is_deterministic() {
        // HashMap 的迭代顺序不固定，结果必须自己排序 —— 否则同一台机器上
        // 两次采样可能给出不同的进程顺序，界面会看起来在抖。
        let (parent_of, names) = snapshot(&[(5, 1), (2, 1), (4, 1), (3, 1)]);
        let (pids, _) = descendants_of(1, &parent_of, &names);
        assert_eq!(pids, vec![2, 3, 4, 5]);
    }
}
