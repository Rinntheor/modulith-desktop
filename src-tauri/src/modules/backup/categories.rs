// src-tauri/src/modules/backup/categories.rs
//
// 备份的**白名单**。这是整个备份功能的安全核心，因此它是一份数据而不是若干处 if。
//
// ---------------------------------------------------------------------------
// 为什么是白名单，而且必须是唯一的一份
//
// 备份有两条路能出事，方向相反：
//
//   * **导出**时按黑名单排除危险文件，等于假设"还没想到的那个文件是安全的"。
//     应用数据目录里将来会多出什么，今天没人知道；`auth.json` 就是最清楚的一例 ——
//     它装着访问密钥哈希与恢复码哈希，泄露备份等于把离线爆破的原料送出去。
//   * **导入**时按名字拼接目标路径，等于把"压缩包里的字符串"直接当成写盘位置。
//     一个 `../../` 或绝对路径就是一个任意写入原语。
//
// 白名单同时解决两边，而且解决方式是同一个：**只承认这张表里列出的路径**。
//
//   * 导出只可能产出这些路径；
//   * 导入只接受这些路径 —— 换句话说，**能被接受的名字，恰好是导出能够产生的名字**。
//
// 这条不变量比"做了路径校验"强得多：它不依赖任何规范化技巧的正确性，
// 因为可以构造出的名字集合本来就只有一个有限集。
//
// ---------------------------------------------------------------------------
// 根目录有两个
//
// 日志写在 `app_log_dir()`，其余数据在 `app_data_dir()`，而这两个目录在
// Windows 上根本不是同一棵树（`%APPDATA%` 对 `%LOCALAPPDATA%`）。因此每个条目
// 记录自己属于哪个根，压缩包里的路径带上根的名字（`data/appdata/...`、
// `data/logdir/...`），恢复时按同一个根还原。

use serde::Serialize;
use std::path::PathBuf;

/// 压缩包内所有数据条目的公共前缀
pub const DATA_PREFIX: &str = "data/";

/// 清单文件名（位于压缩包根，与 data/ 平级）
pub const MANIFEST_FILE_NAME: &str = "manifest.json";

/// 备份格式版本。将来结构变化时据此判断"这个包还能不能恢复"
pub const BACKUP_FORMAT: u32 = 1;

/// 数据所在的根目录
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupRoot {
    /// `app_data_dir()`：settings.json、auth.json、插件与插件数据…
    AppData,
    /// `app_log_dir()`：运行日志与崩溃记录
    LogDir,
}

impl BackupRoot {
    /// 压缩包里代表这个根的路径段
    pub fn token(self) -> &'static str {
        match self {
            BackupRoot::AppData => "appdata",
            BackupRoot::LogDir => "logdir",
        }
    }

    fn from_token(token: &str) -> Option<Self> {
        match token {
            "appdata" => Some(BackupRoot::AppData),
            "logdir" => Some(BackupRoot::LogDir),
            _ => None,
        }
    }
}

/// 一个可备份的类别
#[derive(Debug)]
pub struct CategorySpec {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// `(根, 相对路径)` 列表。相对路径以 `/` 结尾表示"整个目录"
    pub paths: &'static [(BackupRoot, &'static str)],
    /// 是否属于「授权与安全数据」。
    ///
    /// 这类类别**默认既不被导出也不被恢复**，必须由用户显式打开高级开关。
    /// 两道门是分开的：一个含有 `auth.json` 的备份，在另一台机器上恢复时
    /// 仍然要再确认一次 —— 因为"我当时导出时愿意"与"我现在愿意覆盖本机凭据"
    /// 是两个不同的决定。
    pub sensitive: bool,
    /// 是否允许被**恢复**。
    ///
    /// `logs` 是唯一为 `false` 的类别，理由是技术性的而不是设计取向：日志目录里
    /// 的文件由日志器**持有着打开的句柄**，Windows 上删除一个打开中的文件会直接
    /// 失败。与其做一套"先关日志器、恢复完再开"的编排（那会在恢复失败时把日志
    /// 系统留在一个不确定的状态），不如让日志只导出不恢复 —— 它的用途本来就是
    /// 拿到另一台机器上排查，而不是往回写。
    pub restorable: bool,
}

/// 全部可备份的类别。
///
/// 顺序就是界面上的顺序：先是最常用的（设置、侧边栏、通知），再是体积大的
/// （插件、插件数据），最后是诊断用的日志与需要额外确认的授权数据。
pub const CATEGORIES: &[CategorySpec] = &[
    CategorySpec {
        id: "settings",
        label: "软件设置",
        description:
            "主题与配色、动效与毛玻璃开关、启动行为、网络与下载源、日志开关、标签页与分屏布局，以及自定义提示音文件",
        paths: &[(BackupRoot::AppData, "settings.json"), (BackupRoot::AppData, "sounds/")],
        sensitive: false,
        restorable: true,
    },
    CategorySpec {
        id: "sidebar",
        label: "侧边栏与模块偏好",
        description: "模块的显示顺序、隐藏、置顶、收藏与最近使用记录",
        paths: &[(BackupRoot::AppData, "sidebar_config.json")],
        sensitive: false,
        restorable: true,
    },
    CategorySpec {
        id: "notifications",
        label: "通知记录",
        description: "通知中心的全部条目与未读状态",
        paths: &[(BackupRoot::AppData, "notifications.json")],
        sensitive: false,
        restorable: true,
    },
    CategorySpec {
        id: "plugins",
        label: "已安装插件",
        description:
            "插件的本体代码与安装注册表。体积可能较大；恢复时会**替换**本机当前的插件集合",
        paths: &[(BackupRoot::AppData, "plugins/")],
        sensitive: false,
        restorable: true,
    },
    CategorySpec {
        id: "pluginData",
        label: "插件数据",
        description: "插件通过存储接口写入的键值数据。与「已安装插件」相互独立",
        paths: &[(BackupRoot::AppData, "plugin_data/")],
        sensitive: false,
        restorable: true,
    },
    CategorySpec {
        id: "logs",
        label: "运行日志",
        description: "运行日志与崩溃记录，便于在另一台机器上复查问题。只读参考，恢复意义不大",
        paths: &[(BackupRoot::LogDir, "")],
        sensitive: false,
        // 日志**只导出不恢复**：日志文件由日志器持有着打开的句柄，
        // Windows 上删不掉打开中的文件。理由见字段上的说明。
        restorable: false,
    },
    CategorySpec {
        id: "auth",
        label: "授权与安全数据",
        description:
            "访问密钥的派生哈希、恢复码哈希、已知设备与登录记录。备份文件可用于对访问密钥做离线爆破，恢复它会直接覆盖本机凭据",
        paths: &[(BackupRoot::AppData, "auth.json")],
        sensitive: true,
        restorable: true,
    },
];

pub fn find_category(id: &str) -> Option<&'static CategorySpec> {
    CATEGORIES.iter().find(|c| c.id == id)
}

/// 一个已经通过 `resolve_entry` 的相对路径属于哪个类别。
///
/// 供恢复时按用户勾选的类别过滤条目。与 `is_whitelisted` 用同一张表，
/// 因此不存在"能通过白名单却归类不到任何类别"的条目。
pub fn category_of(root: BackupRoot, relative: &str) -> Option<&'static str> {
    CATEGORIES
        .iter()
        .find(|category| {
            category.paths.iter().any(|(spec_root, spec_path)| {
                if *spec_root != root {
                    return false;
                }
                match dir_spec(spec_path) {
                    Some(dir) => {
                        dir.is_empty()
                            || relative == dir
                            || relative.starts_with(&format!("{dir}/"))
                    }
                    None => relative == *spec_path,
                }
            })
        })
        .map(|category| category.id)
}

/// 解析一个压缩包条目名，判断它是否落在白名单内。
///
/// 返回条目所属的根与相对路径（`/` 分隔）。返回 `None` 表示**拒绝**。
///
/// 顺序很重要：先做一次纯粹的**名字合法性**检查（分隔符统一、拒绝绝对路径、
/// 拒绝 `.` 与 `..`、拒绝盘符），再判断它是否命中白名单。两道都过才算通过 ——
/// 只判断"命中白名单"是不够的，因为 `plugins/../../auth.json` 在字符串上
/// 并不以白名单路径结尾，但 `plugins/` 目录类别的 `starts_with` 会把它放进来。
pub fn resolve_entry(entry_name: &str) -> Option<(BackupRoot, String)> {
    let normalized = normalize_entry_name(entry_name)?;
    if !normalized.starts_with(DATA_PREFIX) {
        return None;
    }

    let rest = &normalized[DATA_PREFIX.len()..];
    // 根目录自身（`data/logdir`）没有第二个 `/`，此时相对路径是空串。
    // 它是 `logs` 这个"整个根目录"类别的合法写法，因此不能因为缺少分隔符就丢掉。
    let (token, relative) = match rest.split_once('/') {
        Some(pair) => pair,
        None => (rest, ""),
    };
    let root = BackupRoot::from_token(token)?;

    if !is_whitelisted(root, relative) {
        return None;
    }

    Some((root, relative.to_string()))
}

/// 名字的合法性检查（与白名单无关的纯粹部分）
fn normalize_entry_name(entry_name: &str) -> Option<String> {
    // ZIP 规范要求 `/`，但构造出来的包可以带 `\`。统一之后才谈得上判断。
    let unified = entry_name.replace('\\', "/");

    if unified.is_empty() || unified.starts_with('/') {
        return None;
    }
    // 盘符（`C:`）与 NTFS 数据流（`file:stream`）都以冒号出现
    if unified.contains(':') {
        return None;
    }

    // 目录条目会以一个 `/` 结尾，这是唯一允许出现的空段。
    // 中间的空段（`data/appdata//settings.json`）一律拒绝：它只可能来自畸形或
    // 刻意构造的包，而"接受它然后把多个分隔符折叠掉"会让可接受的名单比导出能
    // 产生的名单更大 —— 那正是这份白名单要避免的事。
    let trimmed = unified.strip_suffix('/').unwrap_or(&unified);
    if trimmed.is_empty() {
        return None;
    }

    let mut parts: Vec<&str> = Vec::new();
    for part in trimmed.split('/') {
        match part {
            "" | "." | ".." => return None,
            other => parts.push(other),
        }
    }

    if parts.is_empty() {
        return None;
    }

    Some(parts.join("/"))
}

/// 判断一个白名单条目是**目录**还是文件。
///
/// 返回 `Some(目录部分)` 表示目录条目（空串表示"这个根目录自身"，`logs` 就是）；
/// 返回 `None` 表示文件条目。
///
/// 收敛成一个函数是必要的，不是风格问题：这条规则原先在三处各写了一遍
/// （`is_whitelisted` / `is_directory_root` / `category_of`），其中两处用
/// `strip_suffix('/')` 判断目录 —— 而空串没有 `/` 后缀，于是 `logs` 类别
/// 时而被当成文件、时而被当成目录。**一条规则写三遍，就有三份漂移的机会。**
fn dir_spec(spec_path: &str) -> Option<&str> {
    if spec_path.is_empty() {
        Some("")
    } else {
        spec_path.strip_suffix('/')
    }
}

/// 相对路径是否命中白名单：要么精确等于某个文件条目，要么位于某个目录条目之下
fn is_whitelisted(root: BackupRoot, relative: &str) -> bool {
    CATEGORIES.iter().any(|category| {
        category.paths.iter().any(|(spec_root, spec_path)| {
            if *spec_root != root {
                return false;
            }
            match dir_spec(spec_path) {
                Some(dir) => {
                    dir.is_empty() || relative == dir || relative.starts_with(&format!("{dir}/"))
                }
                None => relative == *spec_path,
            }
        })
    })
}

/// 这个相对路径是否**恰好是某个目录条目的根**（而不是它下面的文件）。
///
/// 用途：ZIP 里可以出现一个"文件"条目，名字正好是 `data/appdata/plugins`。
/// 它在名字层面落在白名单内，但把它当成文件写到应用数据目录，就会在那里创建一个
/// **名为 plugins 的文件**，随后 `plugins/xxx` 的条目会创建目录失败。
/// 那会以报错收场（不会静默损坏），但与其让用户看到一条难懂的错误，不如在
/// 判定阶段就把它当成畸形条目拒绝掉。
pub fn is_directory_root(root: BackupRoot, relative: &str) -> bool {
    CATEGORIES.iter().any(|category| {
        category.paths.iter().any(|(spec_root, spec_path)| {
            if *spec_root != root {
                return false;
            }
            matches!(dir_spec(spec_path), Some(dir) if !dir.is_empty() && relative == dir)
        })
    })
}

/// 两个根目录的实际位置。
///
/// 抽成结构体而不是到处传 `AppHandle`，是为了让 `archive.rs` 的逻辑可以**被测试**：
/// `AppHandle` 在单元测试里造不出来（`plugins/manager.rs` 也遇到过同一个问题），
/// 而备份的读写恰恰是最需要测试的部分 —— 它要对着真实目录跑一遍导出与恢复，
/// 还要对着一个手工构造的恶意包验证"先校验、后删除"。
#[derive(Debug, Clone)]
pub struct Roots {
    pub appdata: PathBuf,
    pub logdir: PathBuf,
}

impl Roots {
    pub fn from_app(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;

        Ok(Self {
            appdata: app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法确定应用数据目录：{e}"))?,
            logdir: app
                .path()
                .app_log_dir()
                .map_err(|e| format!("无法确定日志目录：{e}"))?,
        })
    }

    pub fn dir(&self, root: BackupRoot) -> PathBuf {
        match root {
            BackupRoot::AppData => self.appdata.clone(),
            BackupRoot::LogDir => self.logdir.clone(),
        }
    }
}

/// 类别里每个路径的绝对位置（供导出与恢复使用）
pub fn category_targets(
    roots: &Roots,
    category: &CategorySpec,
) -> Vec<(PathBuf, BackupRoot, String)> {
    category
        .paths
        .iter()
        .map(|(root, relative)| {
            let base = roots.dir(*root);
            // `relative` 为空串时表示"根目录自身"（日志类别）
            let target = if relative.is_empty() {
                base
            } else {
                base.join(relative.trim_end_matches('/'))
            };
            (target, *root, (*relative).to_string())
        })
        .collect()
}

/// 供界面展示的类别信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// 需要高级开关才能导出或恢复
    pub sensitive: bool,
    /// 是否可以被恢复（日志只导出）
    pub restorable: bool,
    /// 本机当前是否存在这个类别的数据
    pub available: bool,
    /// 当前占用字节数（用于让用户对体积有预期）
    pub bytes: u64,
    /// 当前条目数
    pub entries: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单必须覆盖"导出能产出的每一个路径"。这一组断言与导出端共用同一张表，
    /// 因此它是"导入只接受导出能产生的名字"这条不变量的直接体现。
    #[test]
    fn every_exported_path_is_acceptable_on_import() {
        for category in CATEGORIES {
            for (root, relative) in category.paths {
                if relative.is_empty() {
                    // 空相对路径是"根目录自身"，只出现在目录类别里，
                    // 实际条目会是 `data/logdir/modulith.log` 这种形式
                    let sample = format!("{}{}/modulith.log", DATA_PREFIX, root.token());
                    assert!(
                        resolve_entry(&sample).is_some(),
                        "{sample} 应当被接受"
                    );
                    continue;
                }

                let sample = format!("{}{}/{}", DATA_PREFIX, root.token(), relative);
                assert!(
                    resolve_entry(&sample).is_some(),
                    "{sample} 应当被接受（类别 {}）",
                    category.id
                );

                if relative.ends_with('/') {
                    let child = format!(
                        "{}{}/{}inner.txt",
                        DATA_PREFIX,
                        root.token(),
                        relative
                    );
                    assert!(resolve_entry(&child).is_some(), "{child} 应当被接受");
                }
            }
        }
    }

    /// 越界与畸形名字必须全部被拒绝。
    ///
    /// 这一组是整个模块存在的理由：只要它们成立，导入端就不需要依赖任何路径
    /// 规范化技巧 —— 因为可以构造出的合法名字本来就只有一个有限集。
    #[test]
    fn rejects_everything_outside_the_whitelist() {
        let rejected = [
            // 不在 data/ 下
            "manifest.json",
            "auth.json",
            // 未知根
            "data/localappdata/auth.json",
            "data//settings.json",
            // 路径穿越（各种写法）
            "data/appdata/../auth.json",
            "data/appdata/../../auth.json",
            "data/appdata/plugins/../../auth.json",
            "data/appdata/..\\auth.json",
            // 绝对路径与盘符
            "/data/appdata/settings.json",
            "C:/data/appdata/settings.json",
            "data/appdata/C:/settings.json",
            "data/appdata/settings.json:stream",
            // 白名单之外的真实文件
            "data/appdata/sidebar_preferences.json",
            "data/appdata/registry.json",
            "data/appdata/pluginsx/webview.db",
            // 畸形的空段
            "data/appdata//settings.json",
            "data/",
            "",
            ".",
            "..",
        ];

        for name in rejected {
            assert!(
                resolve_entry(name).is_none(),
                "{name:?} 必须被拒绝，但被接受了"
            );
        }
    }

    /// 目录类别的匹配不能把前缀相同但实际不同的目录放进来。
    ///
    /// `plugins/` 必须命中 `plugins/a/b.js`，但**不能**命中 `plugins-other/x`
    /// —— 后者在字符串上以 `plugins` 开头，只有加上分隔符比较才挡得住。
    #[test]
    fn directory_prefix_match_requires_a_separator() {
        assert!(resolve_entry("data/appdata/plugins/hello/index.js").is_some());
        assert!(resolve_entry("data/appdata/plugin_data/x/k.json").is_some());
        assert!(resolve_entry("data/appdata/plugins-other/x.js").is_none());
        assert!(resolve_entry("data/appdata/plugin_datax/k.json").is_none());
    }

    /// 目录前缀匹配不能把名字相同但其实是「目录自身」的条目当成文件。
    ///
    /// `data/appdata/plugins` 在名字层面是白名单内的（它就是这个目录的根），
    /// 但它的身份必须由 `is_directory_root` 判出来，好让打包层拒绝把它当成
    /// 一个**文件**去写 —— 否则会在应用数据目录里造出一个名为 `plugins` 的文件。
    #[test]
    fn directory_roots_are_classified_separately() {
        for (entry, root, relative) in [
            ("data/appdata/plugins", BackupRoot::AppData, "plugins"),
            ("data/appdata/plugin_data", BackupRoot::AppData, "plugin_data"),
            ("data/appdata/sounds", BackupRoot::AppData, "sounds"),
        ] {
            let parsed = resolve_entry(entry).expect("目录自身应当通过名字层面的白名单");
            assert_eq!(parsed, (root, relative.to_string()));
            assert!(
                is_directory_root(parsed.0, &parsed.1),
                "{entry} 应当被识别为目录根"
            );
        }

        // 目录下面的文件不是"目录根"
        let parsed = resolve_entry("data/appdata/plugins/hello/index.js").unwrap();
        assert!(!is_directory_root(parsed.0, &parsed.1));
        // 文件条目也不是
        let parsed = resolve_entry("data/appdata/settings.json").unwrap();
        assert!(!is_directory_root(parsed.0, &parsed.1));
    }

    /// 敏感类别必须被标出来 —— 界面据此默认不勾选它
    #[test]
    fn auth_is_the_only_sensitive_category() {
        let sensitive: Vec<&str> = CATEGORIES
            .iter()
            .filter(|c| c.sensitive)
            .map(|c| c.id)
            .collect();
        assert_eq!(sensitive, vec!["auth"]);
    }

    /// 类别 id 不重复，且都能被查到
    #[test]
    fn category_ids_are_unique_and_resolvable() {
        let mut ids: Vec<&str> = CATEGORIES.iter().map(|c| c.id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "类别 id 不能重复");

        for id in ids {
            assert!(find_category(id).is_some(), "{id} 应当能被查到");
        }
        assert!(find_category("nope").is_none());
    }

    /// 规范化把 `\` 统一成 `/`，但不会因此放过越界名字
    #[test]
    fn normalizes_backslashes_without_loosening_the_rules() {
        assert_eq!(
            normalize_entry_name(r"data\appdata\settings.json"),
            Some("data/appdata/settings.json".to_string())
        );
        assert_eq!(normalize_entry_name(r"data\appdata\..\auth.json"), None);
    }

    /// 每个能通过白名单的条目都必须能归类到一个类别。
    ///
    /// 否则恢复时会静默跳过它 —— 白名单说"可以"，而恢复逻辑说"不认识"，
    /// 两者不一致的后果是用户以为恢复成功了。
    #[test]
    fn every_whitelisted_entry_belongs_to_a_category() {
        for category in CATEGORIES {
            for (root, relative) in category.paths {
                let sample = if relative.is_empty() {
                    "modulith.log".to_string()
                } else if relative.ends_with('/') {
                    format!("{relative}hello/index.js")
                } else {
                    (*relative).to_string()
                };

                let entry = format!("{}{}/{}", DATA_PREFIX, root.token(), sample);
                let (parsed_root, parsed_relative) =
                    resolve_entry(&entry).unwrap_or_else(|| panic!("{entry} 应当通过白名单"));

                assert_eq!(
                    category_of(parsed_root, &parsed_relative),
                    Some(category.id),
                    "{entry} 应当归类到 {}",
                    category.id
                );
            }
        }
    }

    /// `logs` 是唯一不可恢复的类别。这条断言的用途不是"记录现状"，而是：
    /// 将来有人把某个类别改成不可恢复时，必须同时想清楚界面要不要跟着变。
    #[test]
    fn logs_is_export_only() {
        let not_restorable: Vec<&str> = CATEGORIES
            .iter()
            .filter(|c| !c.restorable)
            .map(|c| c.id)
            .collect();
        assert_eq!(not_restorable, vec!["logs"]);
    }
}
