// src-tauri/src/modules/plugins/background_manifest.rs
//
// 无界面（后台）插件在清单里声明的部分。
//
// ============================================================
// 为什么它是一个**独立**的解析器，而不是塞进 manager
// ============================================================
//
// 清单是**外部输入**：字段可能缺失、可能是别的类型、可能带空白。这类解析的
// 测试价值极高而依赖极少 —— 把它抽成纯函数（不碰文件系统、不认识插件管理器）
// 意味着那十几条"缺字段 / 类型错 / 路径越界"的测试可以一个个直接写出来，
// 而不必先造一个已安装的插件目录。
//
// ============================================================
// entry 为什么必须在这里校验
// ============================================================
//
// `entry` 是一条**由清单指定的相对路径**，而它会被拼到插件根目录后面，再作为
// `--allow-fs-read` 的放行目标交给 Node。也就是说：它决定了子进程能读哪个
// 目录。一个写着 `../../` 的 entry 会把插件目录**之外**的地方放进放行名单。
//
// 因此这里拒绝（而不是"规范化一下继续用"）：
//   · 绝对路径与盘符（`C:\…`、`/etc/…`）—— 它绕开了"相对插件根目录"这个前提；
//   · 任何 `..` 片段 —— 同上；
//   · 空片段以外的怪东西由调用方在拼接后再验一次（见 `PluginManager::background_launch`）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 一个后台插件的声明
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundContribution {
    /// 后台入口，相对插件根目录（例如 `background.js`）
    pub entry: String,
    /// 应用启动后是否立刻拉起
    pub on_startup: bool,
    /// 定时投递的间隔（秒）。`None` = 不定时
    ///
    /// 有下限（见 `MIN_INTERVAL_SECS`）：一个写着 `1` 的插件会每秒问宿主一次
    /// `ctx.*`，而每一次都是一趟 JSON 往返。下限是**宿主替插件挡住一个它自己
    /// 意识不到的代价**，而不是替用户省电。
    pub interval_secs: Option<u64>,
    /// 要订阅的事件名（`onCommand:<本地 id>` / `onPluginEvent:<名字>`）
    pub events: Vec<String>,
}

/// 定时投递的最小间隔。
pub const MIN_INTERVAL_SECS: u64 = 10;

/// 定时投递的最大间隔（一天）。超过它大概率是把毫秒当秒写了。
pub const MAX_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// 从 `contributes` 里读后台声明。
///
/// 没有 `background` 键、或者它的形状不对时返回 `None` —— 也就是说这个插件
/// **不会**被拉起。这与"声明了但解析失败"在结果上一样，但后者会由
/// `ContributionIssue` 在界面上说出来（前端那一侧负责），而不是静默。
pub fn parse(contributes: Option<&Value>) -> Option<BackgroundContribution> {
    let background = contributes?.get("background")?;
    if !background.is_object() {
        return None;
    }

    let entry = background.get("entry")?.as_str()?.trim();
    if !is_safe_relative(entry) {
        return None;
    }

    let interval_secs = background
        .get("interval")
        .and_then(|value| value.as_u64())
        .map(|seconds| seconds.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS));

    let events = background
        .get("events")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    Some(BackgroundContribution {
        entry: entry.to_string(),
        // 缺省是 `true`：写了一个后台入口却要求它不随应用启动，是少数派。
        // 让多数派少写一个字段，而少数派显式写 `false`。
        on_startup: background
            .get("onStartup")
            .and_then(|value| value.as_bool())
            .unwrap_or(true),
        interval_secs,
        events,
    })
}

/// 一个相对路径是否安全到可以拼在插件根目录后面。
///
/// 判据是**白名单**而不是黑名单：只允许普通的路径片段。黑名单（"不含 `..`"）
/// 总会漏掉某个平台特有的写法，而白名单漏掉的东西最多只会让一个合法路径
/// 被拒绝 —— 那个方向的错误是可见的，另一个方向的不是。
pub fn is_safe_relative(path: &str) -> bool {
    if path.is_empty() || path.len() > 256 {
        return false;
    }

    // 绝对路径与盘符：`C:\x`、`\\server\share`、`/etc/passwd`
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    if path.chars().nth(1) == Some(':') {
        return false;
    }

    // 控制字符与 Windows 上的非法字符。`:` 已经在上面被拦掉一个位置，
    // 这里再拦一次是因为 `a:b.js` 里的冒号在 NTFS 上是备用数据流语法。
    if path
        .chars()
        .any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return false;
    }

    path.split(['/', '\\']).all(|segment| {
        // 空片段（`a//b`）与 `.` / `..` 都不允许：它们不影响解析结果却让
        // "这个路径长什么样"与"它指向哪里"之间多出一层需要推理的东西。
        if segment.is_empty() || segment == "." || segment == ".." {
            return false;
        }

        // 片段两端不允许空白。
        //
        // **这条是被一条测试逼出来的**：原来只判 `segment.is_empty()`，于是
        // `"   "`（全是空格）被当成一个合法片段 —— 而它经 `join` 之后要么
        // 变成一个奇怪的文件名，要么在 Windows 上被规范化掉。
        //
        // 拒绝的方式是"两端不同即拒绝"而不是"trim 之后非空"：后者会放行
        // `" a.js "`，而那个名字在 Windows 上打开的实际是 `a.js` ——
        // 判断用的路径与真正打开的路径不是同一个，这是最不该在这里出现的东西。
        segment.trim() == segment
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contributes(value: Value) -> Option<BackgroundContribution> {
        parse(Some(&value))
    }

    #[test]
    fn a_plain_background_block_is_parsed() {
        let parsed = contributes(serde_json::json!({
            "background": { "entry": "background.js", "interval": 60, "events": ["onCommand:sync"] }
        }))
        .expect("应当解析出来");

        assert_eq!(parsed.entry, "background.js");
        assert!(parsed.on_startup, "没有写 onStartup 时缺省是启动即拉起");
        assert_eq!(parsed.interval_secs, Some(60));
        assert_eq!(parsed.events, vec!["onCommand:sync".to_string()]);
    }

    #[test]
    fn on_startup_can_be_turned_off_explicitly() {
        let parsed = contributes(serde_json::json!({
            "background": { "entry": "b.js", "onStartup": false }
        }))
        .unwrap();
        assert!(!parsed.on_startup);
        assert_eq!(parsed.interval_secs, None);
        assert!(parsed.events.is_empty());
    }

    /// 没有 `background` 的插件**不会被拉起**。
    #[test]
    fn a_plugin_without_a_background_block_yields_nothing() {
        assert!(parse(None).is_none());
        assert!(contributes(serde_json::json!({ "modules": [] })).is_none());
        // 形状不对也算没有：`background: "yes"` 不是一个声明
        assert!(contributes(serde_json::json!({ "background": "yes" })).is_none());
        // 缺 entry 同理 —— 没有入口就无从拉起
        assert!(contributes(serde_json::json!({ "background": { "interval": 60 } })).is_none());
        assert!(contributes(serde_json::json!({ "background": { "entry": "   " } })).is_none());
    }

    /// 间隔被夹在上下限之间，而不是照抄清单。
    ///
    /// 两个方向都真实存在：`1` 是被毫秒/秒搞混（每秒一趟往返），
    /// `999999` 则是把一天写成了别的单位。
    #[test]
    fn the_interval_is_clamped_into_a_sane_range() {
        let fast = contributes(serde_json::json!({ "background": { "entry": "b.js", "interval": 1 } })).unwrap();
        assert_eq!(fast.interval_secs, Some(MIN_INTERVAL_SECS));

        let slow = contributes(serde_json::json!({ "background": { "entry": "b.js", "interval": 999_999 } })).unwrap();
        assert_eq!(slow.interval_secs, Some(MAX_INTERVAL_SECS));

        let fine = contributes(serde_json::json!({ "background": { "entry": "b.js", "interval": 300 } })).unwrap();
        assert_eq!(fine.interval_secs, Some(300));
    }

    /// 事件名里的空白与空串被过滤掉，而不是原样带进去。
    #[test]
    fn blank_event_names_are_dropped() {
        let parsed = contributes(serde_json::json!({
            "background": { "entry": "b.js", "events": ["a", "", "  ", "b", 7, null] }
        }))
        .unwrap();
        assert_eq!(parsed.events, vec!["a".to_string(), "b".to_string()]);
    }

    /// **这是本题最重要的一组断言。**
    ///
    /// `entry` 会变成 `--allow-fs-read` 的放行目标，因此一条能跳出插件目录的
    /// 路径等于把子进程的读权限扩到别处。
    #[test]
    fn entry_paths_that_leave_the_plugin_directory_are_rejected() {
        for hostile in [
            "../outside.js",
            "a/../../outside.js",
            "..\\outside.js",
            "/etc/passwd",
            "\\server\\share\\x.js",
            "C:\\Windows\\x.js",
            "c:/windows/x.js",
            "a//b.js",
            "./a.js",
            "a/./b.js",
            "a:b.js",
            "",
            "   ",
        ] {
            assert!(
                !is_safe_relative(hostile),
                "这个路径不该被接受：{hostile:?}"
            );
            assert!(
                contributes(serde_json::json!({ "background": { "entry": hostile } })).is_none(),
                "含 {hostile:?} 的声明不该产出后台入口"
            );
        }
    }

    /// 合法路径必须真的被接受 —— 否则上面那条测试可以靠"全部拒绝"通过。
    ///
    /// 这正是假阳性最常见的样子：一条只会说"不"的断言看起来永远是对的。
    #[test]
    fn ordinary_relative_entries_are_accepted() {
        for good in ["background.js", "src/background.js", "src\\background.js", "a/b/c.js"] {
            assert!(is_safe_relative(good), "这个路径应当被接受：{good:?}");
            assert!(
                contributes(serde_json::json!({ "background": { "entry": good } })).is_some(),
                "含 {good:?} 的声明应当产出后台入口"
            );
        }
    }

    #[test]
    fn an_overlong_path_is_rejected() {
        let long = format!("{}.js", "a".repeat(300));
        assert!(!is_safe_relative(&long));
    }
}
