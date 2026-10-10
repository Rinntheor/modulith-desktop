// src-tauri/src/modules/plugins/data_root.rs
//
// 插件数据放在哪里，以及**它现在能不能用**。
//
// ============================================================
// 为什么数据根目录要单独成一个概念
// ============================================================
//
// 在它出现之前，插件数据写死在 `app_data_dir()/plugin_data`。那个位置有两个问题：
//
//   1. 它在 **Roaming**（`%APPDATA%`）。漫游配置目录在域账号/企业环境里会在注销时
//      被同步到服务器 —— 把 GB 级的文档放进去不只是占 C 盘，是每次登录注销都要在
//      网络上搬一遍。小配置属于那里，大数据不属于。
//   2. 它不可换。用户的 C 盘满了、或者他想把大文件放到另一块盘上，没有出口。
//
// ============================================================
// 默认值：%LOCALAPPDATA%
// ============================================================
//
// 默认根放在 `app_local_data_dir()` 下。`ctx.storage` **原地不动**（它小、它就该跟着
// 用户走），因此**不需要任何迁移** —— 没有迁移就没有迁移失败。
//
// ============================================================
// "不可用"必须是一个状态，不是一个空目录
// ============================================================
//
// 这是整个数据层里最危险的一条。移动硬盘没插、网络盘断开、路径被删掉时，如果宿主
// 只是"没找到就建一个空的"，插件读到的就是一个**空数据目录** —— 而它看起来与
// "这个插件还没有数据"一模一样。用户会以为数据没了，然后开始重建。
//
// 因此这里的规则是**不对称的**，而这个不对称是刻意的：
//
//   * **默认根**由我们创建。它是我们名下的目录，不存在就是还没用过。
//   * **用户配置的根必须已经存在。** 我们**绝不**为它 `create_dir_all` ——
//     一个指向 `E:\` 的配置在 E: 没挂载时，"帮你建一个"只会造出一个空目录，
//     而那正是上面那个最危险的场景。
//
// 另外，判定可用性不能只看"目录在不在"：只读挂载、权限被改都会让 `is_dir()` 为真
// 而写入失败。因此真的**写一个探针文件再删掉**。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// 数据根目录下的插件子目录名。默认根本身叫这个名字，用户配置的根之下也用它。
const DIR_NAME: &str = "plugin_data";

/// 指向数据根的配置文件（放在**配置**目录，只有几百字节）。
///
/// 指针在 Roaming、数据在别处 —— 这个分离正是"可搬家"的前提：搬家时改这个小文件，
/// 而不是搬一个我们不知道在哪的东西。
const CONFIG_FILE: &str = "plugin_data_root.json";

/// 写入探针的文件名。用点开头，与插件自己的文件区分开。
const PROBE_FILE: &str = ".modulith-write-probe";

/// 数据根现在能不能用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRootStatus {
    /// 能不能读写。为假时**所有**插件数据操作都必须拒绝，而不是返回空数据。
    pub available: bool,
    /// 这个根是默认的还是用户配置的。界面据此决定"要去哪改"。
    pub configured: bool,
    /// 绝对路径。**只给宿主界面看，绝不过边界交给插件** ——
    /// 路径一旦跨过去，插件就获得了关于这台机器的一条信息，而它并不需要。
    pub path: String,
    /// 不可用时的原因，写给用户看。
    pub reason: Option<String>,
}

impl DataRootStatus {
    fn unavailable(path: &Path, configured: bool, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            configured,
            path: path.display().to_string(),
            reason: Some(reason.into()),
        }
    }

    fn ready(path: &Path, configured: bool) -> Self {
        Self {
            available: true,
            configured,
            path: path.display().to_string(),
            reason: None,
        }
    }
}

/// 配置文件的内容。字段少是刻意的：这里只该有"数据在哪"。
#[derive(Debug, Default, Serialize, Deserialize)]
struct RootConfig {
    /// 用户配置的数据根。为空表示用默认根。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root: Option<String>,
}

/// 解析配置目录里的那个指针文件。
fn config_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(CONFIG_FILE))
}

/// 读出用户配置的根。读不到、解析不了、字段为空都返回 `None`（= 用默认根）。
///
/// 配置文件损坏时**回落到默认根而不是报错**：这份文件是我们自己写的几百字节，
/// 它坏掉的原因几乎一定是"被人手工改过"。那时让整个插件系统起不来，代价远大于
/// 暂时用默认根 —— 而"用户配置没生效"这件事会由界面上的路径显示出来。
pub fn configured_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let path = config_path(app)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let config: RootConfig = serde_json::from_str(&text).ok()?;
    let root = config.root?;
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

// ============================================================
// 为什么**没有**"设置数据根"的函数
// ============================================================
//
// 这里曾经有一个 `set_configured_root(app, root)`：写指针文件，写之前先
// `probe_writable` 验证。它写得很完整，但**从来没有过调用方** —— 没有命令、
// 没有界面，因此它没有一行被执行过。
//
// 处置是**删掉它**，而不是"留着等以后接"：一个有实现、无调用方的函数在代码里
// 与"已实现的能力"无法区分，读者会以为换根是产品提供的功能。本仓库对这类中间态
// 的立场是明确的（见 `现行问题` 里 `dependencies` 那四个字段的记录）。
//
// 换根因此**只剩手改** —— 而 `plugin_data_root.json` 本来就是给别人改的，
// 那是 `CONFIG_FILE` 上面那条注释的原意（"搬家时改这个小文件"）。这条路是完整的，
// 不是残缺的：
//
//   * `configured_root()` 照常读它；
//   * `resolve()` 会**验证**它（`probe_writable`），不可用就进 `DataRootStatus`
//     的"不可用"状态，而不是被当成"这个插件还没有数据"；
//   * 界面上显示的是解析出来的真实路径，因此"我改了但没生效"看得见。
//
// 加一个设置界面是**独立的工作**：它要先定"目录授权"的交互，而那与 v1.5 里
// `filesystem-scoped` 被推迟是同一类问题 —— 让用户选一个目录，就要定义
// "这份授权属于谁、什么时候失效"。在那之前，把死代码留着并不会让它更接近可用。

/// 真的写一个文件再删掉，判定"能不能用"。
///
/// 不用 `is_dir()` 就下结论：只读挂载、ACL 改过、目录被别的进程占着，这些情况下
/// `is_dir()` 都为真而写入会失败 —— 而失败发生在**插件已经开始写数据之后**。
fn probe_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(PROBE_FILE);

    std::fs::write(&probe, b"ok").map_err(|e| format!("目录不可写：{e}"))?;
    // 删不掉不算失败：探针文件留着不影响正确性，而"能写不能删"的目录仍然可用。
    let _ = std::fs::remove_file(&probe);

    Ok(())
}

/// 解析数据根并判定它的状态。
pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> (PathBuf, DataRootStatus) {
    // 用户配置优先。**它必须已经存在** —— 理由见文件头"不可用必须是一个状态"。
    if let Some(configured) = configured_root(app) {
        let dir = configured.join(DIR_NAME);

        if !configured.is_dir() {
            return (
                dir.clone(),
                DataRootStatus::unavailable(
                    &dir,
                    true,
                    format!("配置的数据位置不存在或不可访问：{}", configured.display()),
                ),
            );
        }
        if !dir.is_dir() {
            // 根在、但我们的子目录还没有。这是我们自己的目录，可以建；
            // 建不出来才叫不可用。
            if let Err(e) = std::fs::create_dir_all(&dir) {
                return (
                    dir.clone(),
                    DataRootStatus::unavailable(&dir, true, format!("无法创建数据目录：{e}")),
                );
            }
        }
        return match probe_writable(&dir) {
            Ok(()) => (dir.clone(), DataRootStatus::ready(&dir, true)),
            Err(reason) => (dir.clone(), DataRootStatus::unavailable(&dir, true, reason)),
        };
    }

    // 默认根：我们自己的目录，不存在就是还没用过，建它。
    let Ok(base) = app.path().app_local_data_dir() else {
        let fallback = PathBuf::from(DIR_NAME);
        return (
            fallback.clone(),
            DataRootStatus::unavailable(&fallback, false, "拿不到本机应用数据目录"),
        );
    };
    let dir = base.join(DIR_NAME);

    if let Err(e) = std::fs::create_dir_all(&dir) {
        return (
            dir.clone(),
            DataRootStatus::unavailable(&dir, false, format!("无法创建数据目录：{e}")),
        );
    }

    match probe_writable(&dir) {
        Ok(()) => (dir.clone(), DataRootStatus::ready(&dir, false)),
        Err(reason) => (dir.clone(), DataRootStatus::unavailable(&dir, false, reason)),
    }
}
