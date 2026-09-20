// src-tauri/src/modules/backup/archive.rs
//
// 备份包的读写：导出、检查、恢复。
//
// ---------------------------------------------------------------------------
// 恢复端的三条防线，缺一不可
//
// 1. **白名单。** 每个条目名都要先过 `categories::resolve_entry`。不在白名单里的
//    条目**拒绝整个包**，而不是跳过它 —— 一个包里有非白名单条目，只可能是它被
//    构造过或来自未来版本，两种情况下"当作没看见"都不是安全的默认。
// 2. **规范化包含性检查。** 与 `plugins/manager.rs::extract_zip` 同一做法：
//    父目录建好之后，把父目录 `canonicalize()` 再与同样规范化过的根比较。
//    注意不能拿 `canonicalize()` 的结果去和未规范化的 `join()` 结果比较 ——
//    Windows 上 `canonicalize()` 会加上 `\\?\`（verbatim）前缀，前缀组件不同会
//    让 `starts_with()` 永远为 false，从而把正常条目误判成越界。
// 3. **体积与条目数上限，按实际写出的字节数判定。** 压缩包里每个条目都"声明"了
//    自己的大小，那是可以被伪造成"声明很小、实际很大"的（解压炸弹）。声明值只用于
//    廉价的预检，真正的判据是写入循环里累计的真实字节。
//
// 还有一条顺序上的要求：**先删后写**，且只删白名单里列出的那些目标。
// 恢复的语义是"替换"，不是"合并" —— 把旧插件与新插件混在一起，得到的是一个
// 谁也没要过的集合。
//
// ---------------------------------------------------------------------------
// 关于确定性
//
// 导出时条目按 zip 内路径排序、且使用 `zip` crate 的默认时间戳，因此同一个数据
// 目录导两次得到的是**内容相同**的包（清单里的 `createdAt` 除外）。这一点不是
// 为了可复现构建，而是为了"同样的事做两遍结果一样"这类问题容易发现。

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::categories::{
    self, BackupRoot, CategoryInfo, CategorySpec, Roots, BACKUP_FORMAT, DATA_PREFIX,
    MANIFEST_FILE_NAME,
};

/// 条目数上限。备份是"整个应用的数据"，给得比插件包宽松得多
pub const MAX_BACKUP_ENTRIES: usize = 20_000;
/// 解压后总体积上限
pub const MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;
/// 单个条目的体积上限
pub const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
/// 清单文件的读取上限（它是 JSON，会被整个读进内存）
pub const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntryInfo {
    pub path: String,
    pub bytes: u64,
}

/// 备份清单。它让"这个包里有什么"可以在**不解压**的情况下读出来，
/// 因此界面能先展示内容、再由用户决定恢复哪些。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    /// 备份格式版本
    pub format: u32,
    /// 生成这个备份的应用版本
    pub app_version: String,
    /// 创建时间（RFC3339）
    pub created_at: String,
    /// 平台（`windows` / `macos` / `linux`）
    pub platform: String,
    /// 包含的类别 id
    pub categories: Vec<String>,
    /// 每个条目的包内路径与字节数
    pub entries: Vec<BackupEntryInfo>,
}

/// 导出结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub bytes: u64,
    pub entries: u64,
    pub categories: Vec<String>,
    /// 被跳过的不存在类别（例如从未用过插件时的 `plugin_data`）
    pub skipped: Vec<String>,
}

/// 某个类别在包里的规模
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryStats {
    pub id: String,
    pub bytes: u64,
    pub entries: u64,
    /// 本机是否能恢复它（日志只导出）
    pub restorable: bool,
    /// 是否需要高级开关才能恢复
    pub sensitive: bool,
}

/// 打开一个备份文件后的检查结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub manifest: BackupManifest,
    pub bytes: u64,
    pub entries: u64,
    pub stats: Vec<EntryStats>,
    /// 值得提醒但不阻断的问题（例如清单里出现了未知类别）
    pub warnings: Vec<String>,
}

/// 恢复结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub categories: Vec<String>,
    pub entries: u64,
    pub bytes: u64,
    /// 被替换掉的目标路径（供界面如实告诉用户动了什么）
    pub replaced: Vec<String>,
    /// 恢复了设置，调用方需要让后端与前端重新读取 `settings.json`
    pub settings_changed: bool,
    /// 恢复了插件，调用方需要重载插件运行时
    pub plugins_changed: bool,
}

fn zip_options() -> zip::write::FileOptions {
    // 默认时间戳是固定的 1980-01-01（`zip::DateTime::default()`），因此同一个
    // 数据目录导两次不会因为"打包时刻不同"而产生字节差异。
    zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

/// 目录类别在压缩包里的路径前缀（结尾带 `/`）
fn dir_prefix(root: BackupRoot, relative: &str) -> String {
    let trimmed = relative.trim_end_matches('/');
    if trimmed.is_empty() {
        format!("{}{}/", DATA_PREFIX, root.token())
    } else {
        format!("{}{}/{}/", DATA_PREFIX, root.token(), trimmed)
    }
}

/// 文件类别在压缩包里的路径
fn file_entry(root: BackupRoot, relative: &str) -> String {
    format!("{}{}/{}", DATA_PREFIX, root.token(), relative)
}

struct CollectedEntry {
    zip_name: String,
    abs_path: PathBuf,
    bytes: u64,
}

/// 递归收集目录下的文件。
///
/// **跳过符号链接**：`file_type().is_symlink()` 判断的是链接自身而不是它指向的
/// 东西，因此这一步不会跟随链接走出类别目录。（插件仓库的打包脚本也因为这个
/// 原因对符号链接直接报错。）
fn walk_dir(dir: &Path, prefix: &str, out: &mut Vec<CollectedEntry>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}：{e}", dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("无法读取目录项：{e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("无法判断文件类型：{e}"))?;

        if file_type.is_symlink() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let zip_name = format!("{prefix}{name}");

        if file_type.is_dir() {
            walk_dir(&entry.path(), &format!("{zip_name}/"), out)?;
        } else if file_type.is_file() {
            // 导出端也走一次白名单：这样"能被接受的名字集合 == 能被产出的名字集合"
            // 这条不变量是**被代码保证**的，而不是靠人记得同步两张表。
            if categories::resolve_entry(&zip_name).is_none() {
                log::warn!("跳过白名单之外的路径，它不会被写进备份：{zip_name}");
                continue;
            }

            let bytes = entry
                .metadata()
                .map_err(|e| format!("无法读取文件大小：{e}"))?
                .len();
            out.push(CollectedEntry {
                zip_name,
                abs_path: entry.path(),
                bytes,
            });
        }
    }

    Ok(())
}

/// 收集要写进备份的全部文件（已按包内路径排序）
pub fn collect_entries(
    roots: &Roots,
    selected: &[&CategorySpec],
) -> Result<Vec<CollectedEntry>, String> {
    let mut out: Vec<CollectedEntry> = Vec::new();

    for category in selected {
        for (target, root, relative) in categories::category_targets(roots, category) {
            let is_dir = relative.is_empty() || relative.ends_with('/');

            if is_dir {
                if !target.is_dir() {
                    continue;
                }
                walk_dir(&target, &dir_prefix(root, &relative), &mut out)?;
            } else if target.is_file() {
                let zip_name = file_entry(root, &relative);
                if categories::resolve_entry(&zip_name).is_none() {
                    log::warn!("跳过白名单之外的路径，它不会被写进备份：{zip_name}");
                    continue;
                }
                let bytes = std::fs::metadata(&target)
                    .map_err(|e| format!("无法读取文件大小：{e}"))?
                    .len();
                out.push(CollectedEntry {
                    zip_name,
                    abs_path: target,
                    bytes,
                });
            }
        }
    }

    out.sort_by(|a, b| a.zip_name.cmp(&b.zip_name));
    Ok(out)
}

/// 统计一个类别在当前数据目录里的规模，供界面展示
///
/// 复用导出端的收集逻辑，因此界面显示的体积与真正导出的大小是**同一套算法算出来的**
/// —— 分开实现必然出现"写着 2 MB、导出 40 MB"这种不一致。
pub fn measure(roots: &Roots, category: &'static CategorySpec) -> Result<CategoryInfo, String> {
    let entries = collect_entries(roots, &[category])?;
    Ok(CategoryInfo {
        id: category.id,
        label: category.label,
        description: category.description,
        sensitive: category.sensitive,
        restorable: category.restorable,
        available: !entries.is_empty(),
        bytes: entries.iter().map(|e| e.bytes).sum(),
        entries: entries.len() as u64,
    })
}

/// 导出备份到 `dest`
pub fn export(
    roots: &Roots,
    selected: &[&CategorySpec],
    dest: &Path,
) -> Result<ExportReport, String> {
    let entries = collect_entries(roots, selected)?;

    if entries.len() > MAX_BACKUP_ENTRIES {
        return Err(format!(
            "条目数 {} 超过上限 {}，请少选几个类别",
            entries.len(),
            MAX_BACKUP_ENTRIES
        ));
    }

    let total: u64 = entries.iter().map(|e| e.bytes).sum();
    if total > MAX_BACKUP_BYTES {
        return Err(format!(
            "备份体积约 {:.1} MB，超过上限 {} MB",
            total as f64 / 1024.0 / 1024.0,
            MAX_BACKUP_BYTES / 1024 / 1024
        ));
    }

    // 先写临时文件再改名：中途失败不会在用户选的位置留下一个半截的备份，
    // 而"半截的备份"比"没有备份"更危险 —— 它看起来是成功的。
    let temp = dest.with_extension("zip.part");
    let file = File::create(&temp).map_err(|e| format!("无法创建备份文件：{e}"))?;
    let mut zip = zip::ZipWriter::new(file);

    for entry in &entries {
        zip.start_file(entry.zip_name.clone(), zip_options())
            .map_err(|e| format!("无法写入备份：{e}"))?;
        let mut input =
            File::open(&entry.abs_path).map_err(|e| format!("无法读取 {}：{e}", entry.abs_path.display()))?;
        std::io::copy(&mut input, &mut zip).map_err(|e| format!("无法写入备份：{e}"))?;
    }

    let manifest = BackupManifest {
        format: BACKUP_FORMAT,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        platform: std::env::consts::OS.to_string(),
        categories: selected.iter().map(|c| c.id.to_string()).collect(),
        entries: entries
            .iter()
            .map(|e| BackupEntryInfo {
                path: e.zip_name.clone(),
                bytes: e.bytes,
            })
            .collect(),
    };

    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| format!("无法生成备份清单：{e}"))?;
    zip.start_file(MANIFEST_FILE_NAME, zip_options())
        .map_err(|e| format!("无法写入备份清单：{e}"))?;
    zip.write_all(&manifest_json)
        .map_err(|e| format!("无法写入备份清单：{e}"))?;

    zip.finish().map_err(|e| format!("无法完成备份：{e}"))?;

    // 覆盖已存在的同名文件时，Windows 上 rename 不会自动覆盖，因此先删。
    // 走到这里说明新包已经完整写好，删掉旧的不会造成数据丢失。
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|e| format!("无法覆盖已有文件：{e}"))?;
    }
    std::fs::rename(&temp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("无法保存备份：{e}")
    })?;

    let bytes = std::fs::metadata(dest)
        .map_err(|e| format!("无法读取备份大小：{e}"))?
        .len();

    // 记下"实际被跳过的类别"：某个类别从没产生过数据时（例如没装过插件），
    // 界面需要如实说明"这一类是空的"，而不是让用户以为备份失败了。
    let mut non_empty: Vec<String> = Vec::new();
    for category in selected {
        let has_data = entries
            .iter()
            .any(|e| match categories::resolve_entry(&e.zip_name) {
                Some((root, relative)) => categories::category_of(root, &relative) == Some(category.id),
                None => false,
            });
        if has_data {
            non_empty.push(category.id.to_string());
        }
    }
    let skipped: Vec<String> = selected
        .iter()
        .map(|c| c.id.to_string())
        .filter(|id| !non_empty.contains(id))
        .collect();

    log::info!(
        "备份已导出：{}（{} 个条目，{:.1} MB，类别 {:?}）",
        dest.display(),
        entries.len(),
        bytes as f64 / 1024.0 / 1024.0,
        manifest.categories
    );

    Ok(ExportReport {
        path: dest.to_string_lossy().to_string(),
        bytes,
        entries: entries.len() as u64,
        categories: manifest.categories,
        skipped,
    })
}

/// 打开并检查一个备份文件
///
/// 只读取清单与中央目录，**不解压任何数据**。界面因此可以先展示"包里有什么、
/// 多大、来自哪个版本"，再由用户决定是否恢复。
pub fn inspect(path: &Path) -> Result<Inspection, String> {
    let file = File::open(path).map_err(|e| format!("无法打开备份文件：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("这不是一个有效的备份文件：{e}"))?;

    if archive.len() > MAX_BACKUP_ENTRIES {
        return Err(format!(
            "压缩包条目数 {} 超过上限 {}",
            archive.len(),
            MAX_BACKUP_ENTRIES
        ));
    }

    let manifest = read_manifest(&mut archive)?;
    if manifest.format != BACKUP_FORMAT {
        return Err(format!(
            "备份格式版本 {} 不受支持（当前支持 {}）",
            manifest.format, BACKUP_FORMAT
        ));
    }

    let mut warnings: Vec<String> = Vec::new();

    // 清单里声明的类别必须在白名单里。未知类别只警告不阻断：来自更新版本的
    // 备份应该能恢复它认识的部分，而不是整个被拒。
    for id in &manifest.categories {
        if categories::find_category(id).is_none() {
            warnings.push(format!("备份包含本版本不认识的类别「{id}」，将跳过"));
        }
    }

    // 逐条目核对白名单。**这里就拒绝整个包**，与恢复端同一判据 ——
    // 让用户在"打开文件"这一步就知道包有问题，而不是点了恢复才失败。
    let mut per_category: Vec<EntryStats> = Vec::new();
    let mut bytes: u64 = 0;
    let mut data_entries: u64 = 0;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("无法读取备份条目：{e}"))?;
        let name = entry.name().to_string();

        if name == MANIFEST_FILE_NAME || entry.is_dir() {
            continue;
        }

        let (root, relative) = categories::resolve_entry(&name).ok_or_else(|| {
            format!("备份包含白名单之外的条目，已拒绝：{name}")
        })?;

        // 与某个目录同名的**文件**条目：名字层面在白名单内，但它是畸形的 ——
        // 写下去会在应用数据目录里造出一个名为 `plugins` 的文件，
        // 随后 `plugins/xxx` 的条目会建目录失败。理由见 `is_directory_root`。
        if categories::is_directory_root(root, &relative) {
            return Err(format!("备份包含与目录同名的文件条目，已拒绝：{name}"));
        }

        bytes = bytes.saturating_add(entry.size());
        data_entries += 1;

        if let Some(id) = categories::category_of(root, &relative) {
            match per_category.iter_mut().find(|s| s.id == id) {
                Some(stats) => {
                    stats.bytes = stats.bytes.saturating_add(entry.size());
                    stats.entries += 1;
                }
                None => {
                    let category = categories::find_category(id);
                    per_category.push(EntryStats {
                        id: id.to_string(),
                        bytes: entry.size(),
                        entries: 1,
                        restorable: category.map(|c| c.restorable).unwrap_or(false),
                        sensitive: category.map(|c| c.sensitive).unwrap_or(false),
                    });
                }
            }
        } else {
            // `every_whitelisted_entry_belongs_to_a_category` 测试保证了这条
            // 分支不可达；留着是为了将来白名单被改动时能立刻发现而不是静默漏掉。
            warnings.push(format!("条目 {name} 通过白名单却归类不到任何类别"));
        }
    }

    // 清单声明的条目数与实际不符时如实说明：这类不一致通常意味着包被改动过
    if manifest.entries.len() as u64 != data_entries {
        warnings.push(format!(
            "清单声明 {} 个条目，实际有 {} 个",
            manifest.entries.len(),
            data_entries
        ));
    }

    check_declared_sizes(&mut archive, path, &mut warnings)?;

    Ok(Inspection {
        manifest,
        bytes,
        entries: data_entries,
        stats: per_category,
        warnings,
    })
}

/// 读清单
fn read_manifest(archive: &mut zip::ZipArchive<File>) -> Result<BackupManifest, String> {
    let mut entry = archive
        .by_name(MANIFEST_FILE_NAME)
        .map_err(|_| "备份缺少清单文件 manifest.json，无法判断内容".to_string())?;

    if entry.size() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "备份清单过大：{} 字节（上限 {}）",
            entry.size(),
            MAX_MANIFEST_BYTES
        ));
    }

    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| format!("无法读取备份清单：{e}"))?;

    serde_json::from_str(&text).map_err(|e| format!("备份清单格式不正确：{e}"))
}

/// 用**清单里声明的**大小做一次平价检查，明显超限时在打开阶段就拦住。
///
/// 真正的判据在恢复端的写入循环里（按实际字节累计）—— 这里的数字可以被伪造成
/// "声明很小、实际很大"，所以它只是第一道廉价防线。
fn check_declared_sizes(
    archive: &mut zip::ZipArchive<File>,
    _path: &Path,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let mut declared: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("无法读取备份条目：{e}"))?;
        if entry.name() == MANIFEST_FILE_NAME || entry.is_dir() {
            continue;
        }
        declared = declared.saturating_add(entry.size());
        if declared > MAX_BACKUP_BYTES {
            return Err(format!(
                "备份解压后体积超过上限 {} MB",
                MAX_BACKUP_BYTES / 1024 / 1024
            ));
        }
    }
    if declared > MAX_BACKUP_BYTES / 2 {
        warnings.push(format!(
            "备份解压后约 {:.0} MB，恢复会占用较多磁盘空间",
            declared as f64 / 1024.0 / 1024.0
        ));
    }
    Ok(())
}

/// 从备份恢复指定的类别
///
/// `selected` 必须已经过调用方的两道门（格式与高级开关），这里只管"替换这些
/// 类别的目标"。语义是**替换而非合并**：先移除选中类别的现有数据，再解压。
pub fn restore(
    roots: &Roots,
    path: &Path,
    selected: &[&CategorySpec],
) -> Result<RestoreReport, String> {
    if selected.is_empty() {
        return Err("没有选择要恢复的类别".to_string());
    }
    if let Some(bad) = selected.iter().find(|c| !c.restorable) {
        return Err(format!("类别「{}」不支持恢复", bad.label));
    }

    let selected_ids: Vec<&str> = selected.iter().map(|c| c.id).collect();

    let file = File::open(path).map_err(|e| format!("无法打开备份文件：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("这不是一个有效的备份文件：{e}"))?;

    if archive.len() > MAX_BACKUP_ENTRIES {
        return Err(format!(
            "压缩包条目数 {} 超过上限 {}",
            archive.len(),
            MAX_BACKUP_ENTRIES
        ));
    }

    let manifest = read_manifest(&mut archive)?;
    if manifest.format != BACKUP_FORMAT {
        return Err(format!(
            "备份格式版本 {} 不受支持（当前支持 {}）",
            manifest.format, BACKUP_FORMAT
        ));
    }

    // ---- 第一遍：只校验，不落盘 ----
    //
    // 校验通过之后才开始删除现有数据，因此"包有问题"永远不会以
    // "用户的数据被删了但没恢复回来"收场。这个顺序是刻意的。
    let mut planned: Vec<(usize, BackupRoot, String)> = Vec::new();
    let mut declared_total: u64 = 0;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("无法读取备份条目：{e}"))?;
        let name = entry.name().to_string();

        if name == MANIFEST_FILE_NAME || entry.is_dir() {
            continue;
        }

        let (root, relative) = categories::resolve_entry(&name)
            .ok_or_else(|| format!("备份包含白名单之外的条目，已拒绝：{name}"))?;

        if categories::is_directory_root(root, &relative) {
            return Err(format!("备份包含与目录同名的文件条目，已拒绝：{name}"));
        }

        let Some(category_id) = categories::category_of(root, &relative) else {
            return Err(format!("无法判断条目属于哪个类别，已拒绝：{name}"));
        };
        if !selected_ids.contains(&category_id) {
            continue;
        }

        // 声明值预检（廉价），真正的判据在下面的写入循环里
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_BACKUP_BYTES {
            return Err(format!(
                "备份解压后体积超过上限 {} MB",
                MAX_BACKUP_BYTES / 1024 / 1024
            ));
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(format!(
                "条目 {name} 声明的大小 {} 字节超过单文件上限 {}",
                entry.size(),
                MAX_ENTRY_BYTES
            ));
        }

        planned.push((index, root, relative));
    }

    if planned.is_empty() {
        return Err("备份里没有所选类别的任何数据".to_string());
    }

    // ---- 移除选中类别的现有数据 ----
    let mut replaced: Vec<String> = Vec::new();
    for category in selected {
        for (target, _root, _relative) in categories::category_targets(roots, category) {
            if target.is_dir() {
                std::fs::remove_dir_all(&target)
                    .map_err(|e| format!("无法替换 {}：{e}", target.display()))?;
            } else if target.is_file() {
                std::fs::remove_file(&target)
                    .map_err(|e| format!("无法替换 {}：{e}", target.display()))?;
            }
            replaced.push(target.to_string_lossy().to_string());
        }
    }

    // ---- 第二遍：解压 ----
    let mut written_total: u64 = 0;
    let mut written_entries: u64 = 0;

    for (index, root, relative) in planned {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("无法读取备份条目：{e}"))?;

        let base = roots.dir(root);
        let out_path = base.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));

        let parent = out_path
            .parent()
            .ok_or_else(|| format!("非法的备份条目路径：{}", entry.name()))?;
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;

        // 父目录此刻已存在，因此可以规范化后做包含性检查。
        // 根在两侧都规范化之后才可比 —— 理由见文件头第 2 条。
        let base_canon = base
            .canonicalize()
            .map_err(|e| format!("无法确定目标目录：{e}"))?;
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("无法确定目标目录：{e}"))?;
        if !parent_canon.starts_with(&base_canon) {
            return Err(format!(
                "备份条目试图写到目标目录之外，已拒绝：{}",
                entry.name()
            ));
        }

        let mut out_file = File::create(&out_path).map_err(|e| format!("无法写入 {}：{e}", out_path.display()))?;
        let mut buffer = [0u8; 32 * 1024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|e| format!("无法读取备份条目：{e}"))?;
            if read == 0 {
                break;
            }
            // 按**实际**字节累计：条目声明的大小是可以造假的
            written_total = written_total.saturating_add(read as u64);
            if written_total > MAX_BACKUP_BYTES {
                return Err(format!(
                    "备份解压后体积超过上限 {} MB，已中止",
                    MAX_BACKUP_BYTES / 1024 / 1024
                ));
            }
            out_file
                .write_all(&buffer[..read])
                .map_err(|e| format!("无法写入 {}：{e}", out_path.display()))?;
        }

        written_entries += 1;
    }

    let settings_changed = selected_ids.contains(&"settings");
    let plugins_changed = selected_ids.contains(&"plugins");

    log::info!(
        "备份已恢复：{}（{} 个条目，{:.1} MB，类别 {:?}）",
        path.display(),
        written_entries,
        written_total as f64 / 1024.0 / 1024.0,
        selected_ids
    );

    Ok(RestoreReport {
        categories: selected_ids.iter().map(|s| s.to_string()).collect(),
        entries: written_entries,
        bytes: written_total,
        replaced,
        settings_changed,
        plugins_changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个临时目录。测试结束由调用方删掉
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "modulith-backup-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// 造一份"看起来像真实应用数据"的目录结构
    fn seed(roots: &Roots) {
        std::fs::create_dir_all(roots.appdata.join("plugins/hello")).unwrap();
        std::fs::create_dir_all(roots.appdata.join("plugin_data/hello")).unwrap();
        std::fs::create_dir_all(&roots.logdir).unwrap();

        std::fs::write(roots.appdata.join("settings.json"), br#"{"theme":"dark"}"#).unwrap();
        std::fs::write(roots.appdata.join("sidebar_config.json"), br#"{"order":[]}"#).unwrap();
        std::fs::write(roots.appdata.join("auth.json"), br#"{"secret":"do-not-leak"}"#).unwrap();
        std::fs::write(roots.appdata.join("plugins/registry.json"), b"[]").unwrap();
        std::fs::write(roots.appdata.join("plugins/hello/index.js"), b"// hello").unwrap();
        std::fs::write(roots.appdata.join("plugin_data/hello/k.json"), b"{}").unwrap();
        std::fs::write(roots.logdir.join("modulith.log"), b"log line\n").unwrap();
    }

    fn roots_of(temp: &Path) -> Roots {
        Roots {
            appdata: temp.join("appdata"),
            logdir: temp.join("logs"),
        }
    }

    fn cat(id: &str) -> &'static CategorySpec {
        categories::find_category(id).unwrap_or_else(|| panic!("类别 {id} 不存在"))
    }

    // ============================================================
    // 端到端：导出 → 检查 → 恢复
    // ============================================================

    /// 完整往返：导出后改动数据，恢复应当把它变回来，且**不碰未选中的类别**。
    ///
    /// 这一条是这个功能最重要的测试。单元测试能证明"白名单算得对"，
    /// 但只有真的对临时目录跑一遍，才能证明"导出写了什么、恢复就还能读回什么"。
    #[test]
    fn export_inspect_restore_round_trip() {
        let temp = temp_dir("roundtrip");
        let roots = roots_of(&temp);
        seed(&roots);

        let dest = temp.join("backup.zip");
        let selected = vec![cat("settings"), cat("plugins")];
        let report = export(&roots, &selected, &dest).expect("导出应当成功");

        assert!(report.entries >= 3, "至少应有 settings.json 与两个插件文件");
        assert_eq!(report.categories, vec!["settings", "plugins"]);
        assert!(
            !report.categories.iter().any(|c| c == "auth"),
            "未选中 auth 时它不能出现在备份里"
        );
        assert!(dest.is_file());

        // 检查阶段：只读清单，不落盘
        let inspection = inspect(&dest).expect("检查应当成功");
        assert_eq!(inspection.manifest.format, BACKUP_FORMAT);
        assert!(inspection.manifest.app_version == env!("CARGO_PKG_VERSION"));
        assert!(
            !inspection.warnings.iter().any(|w| w.contains("条目")),
            "正常的包不该有条目层面的警告：{:?}",
            inspection.warnings
        );
        let ids: Vec<&str> = inspection.stats.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"settings") && ids.contains(&"plugins"));

        // 改动数据：设置被写坏、插件文件被删
        std::fs::write(roots.appdata.join("settings.json"), b"{}").unwrap();
        std::fs::remove_file(roots.appdata.join("plugins/hello/index.js")).unwrap();

        let restored = restore(&roots, &dest, &selected).expect("恢复应当成功");
        assert_eq!(restored.entries, report.entries);
        assert!(restored.settings_changed && restored.plugins_changed);

        // 恢复后的值与导出时一致
        assert_eq!(
            std::fs::read_to_string(roots.appdata.join("settings.json")).unwrap(),
            r#"{"theme":"dark"}"#
        );
        assert_eq!(
            std::fs::read_to_string(roots.appdata.join("plugins/hello/index.js")).unwrap(),
            "// hello"
        );

        // 未选中的类别必须原封不动
        assert_eq!(
            std::fs::read_to_string(roots.appdata.join("auth.json")).unwrap(),
            r#"{"secret":"do-not-leak"}"#
        );
        assert_eq!(
            std::fs::read_to_string(roots.appdata.join("sidebar_config.json")).unwrap(),
            r#"{"order":[]}"#
        );
        assert_eq!(
            std::fs::read_to_string(roots.appdata.join("plugin_data/hello/k.json")).unwrap(),
            "{}"
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 恢复是**替换**而不是合并：没在备份里的旧文件必须消失。
    ///
    /// 合并会留下一个"旧插件 + 新插件"的混合集合 —— 那是谁也没有要求过的状态，
    /// 而它的症状（某个已卸载的插件还在）极难归因。
    #[test]
    fn restore_replaces_rather_than_merges() {
        let temp = temp_dir("replace");
        let roots = roots_of(&temp);
        seed(&roots);

        let dest = temp.join("backup.zip");
        let selected = vec![cat("plugins")];
        export(&roots, &selected, &dest).expect("导出");

        // 备份之后新装了一个插件
        std::fs::create_dir_all(roots.appdata.join("plugins/late")).unwrap();
        std::fs::write(roots.appdata.join("plugins/late/index.js"), b"// late").unwrap();

        restore(&roots, &dest, &selected).expect("恢复");

        assert!(
            !roots.appdata.join("plugins/late").exists(),
            "恢复之后，备份里没有的插件必须消失（替换语义）"
        );
        assert!(roots.appdata.join("plugins/hello/index.js").is_file());

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 导出时跳过符号链接，避免把应用数据目录之外的字节带进备份。
    #[test]
    fn export_skips_symlinks() {
        let temp = temp_dir("symlink");
        let roots = roots_of(&temp);
        seed(&roots);

        // 在插件目录里放一个指向 auth.json 的链接（尽力而为：创建失败时跳过断言）
        let link = roots.appdata.join("plugins/leak.json");
        let target = roots.appdata.join("auth.json");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&target, &link).is_ok();

        let dest = temp.join("backup.zip");
        export(&roots, &[cat("plugins")], &dest).expect("导出");

        let inspection = inspect(&dest).expect("检查");
        let leaked = inspection
            .manifest
            .entries
            .iter()
            .any(|e| e.path.contains("leak.json"));

        if created {
            assert!(!leaked, "符号链接不能被写进备份");
        } else {
            // 造不出符号链接（权限不足）时不假装验证过
            eprintln!("跳过符号链接断言：当前环境无法创建符号链接");
        }

        let _ = std::fs::remove_dir_all(&temp);
    }

    // ============================================================
    // 恶意包
    // ============================================================

    /// 手工构造一个含越界条目的包
    fn craft_zip(dest: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(dest).expect("create zip");
        let mut zip = zip::ZipWriter::new(file);

        let manifest = BackupManifest {
            format: BACKUP_FORMAT,
            app_version: "0.0.0".to_string(),
            created_at: "2026-01-01T00:00:00+00:00".to_string(),
            platform: "test".to_string(),
            categories: vec!["settings".to_string()],
            entries: Vec::new(),
        };
        zip.start_file(MANIFEST_FILE_NAME, zip_options()).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();

        for (name, bytes) in entries {
            zip.start_file(*name, zip_options()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().expect("finish zip");
    }

    /// 越界条目必须在**打开阶段**就被拒绝。
    #[test]
    fn inspect_rejects_a_crafted_traversal_entry() {
        let temp = temp_dir("traversal");
        let dest = temp.join("evil.zip");
        craft_zip(
            &dest,
            &[
                ("data/appdata/settings.json", b"{}"),
                ("data/appdata/../../auth.json", b"pwned"),
            ],
        );

        let err = inspect(&dest).expect_err("越界条目必须被拒绝");
        assert!(err.contains("白名单"), "错误信息应当说明原因: {err}");

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// **先校验、后删除。** 一个不合格的包不能以"数据被删了但没恢复回来"收场。
    ///
    /// 这一条锁的是 `restore` 里两遍循环的顺序。若把校验与写入合成一遍，
    /// 那么"第一条合法、第二条越界"的包会在删掉用户数据之后才失败。
    #[test]
    fn restore_validates_before_deleting_anything() {
        let temp = temp_dir("validate-first");
        let roots = roots_of(&temp);
        seed(&roots);

        let dest = temp.join("evil.zip");
        craft_zip(
            &dest,
            &[
                // 第一条合法（属于选中的类别）
                ("data/appdata/settings.json", b"{}"),
                // 第二条越界 —— 它出现在合法条目之后，正好落在"先删后写"会踩坑的位置
                ("data/appdata/plugins/../../../outside.txt", b"pwned"),
            ],
        );

        let err = restore(&roots, &dest, &[cat("settings")]).expect_err("必须被拒绝");
        assert!(err.contains("白名单"), "错误信息应当说明原因: {err}");

        // 用户的数据必须原样还在
        assert_eq!(
            std::fs::read_to_string(roots.appdata.join("settings.json")).unwrap(),
            r#"{"theme":"dark"}"#,
            "校验失败时不能先删掉用户的数据"
        );
        assert!(roots.appdata.join("plugins/hello/index.js").is_file());

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 与目录同名的**文件**条目要被拒绝（它会造出一个名为 plugins 的文件）
    #[test]
    fn restore_rejects_a_file_entry_named_like_a_directory() {
        let temp = temp_dir("dir-collision");
        let roots = roots_of(&temp);
        seed(&roots);

        let dest = temp.join("evil.zip");
        craft_zip(
            &dest,
            &[
                ("data/appdata/settings.json", b"{}"),
                ("data/appdata/plugins", b"not a directory"),
            ],
        );

        let err = restore(&roots, &dest, &[cat("plugins")]).expect_err("必须被拒绝");
        assert!(err.contains("与目录同名"), "错误信息应当说明原因: {err}");

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 格式版本不匹配的包要拒绝，而不是"尽力恢复一部分"
    #[test]
    fn rejects_an_unsupported_format_version() {
        let temp = temp_dir("format");
        let dest = temp.join("future.zip");

        let file = File::create(&dest).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let manifest = BackupManifest {
            format: BACKUP_FORMAT + 1,
            app_version: "9.9.9".to_string(),
            created_at: "2026-01-01T00:00:00+00:00".to_string(),
            platform: "test".to_string(),
            categories: vec!["settings".to_string()],
            entries: Vec::new(),
        };
        zip.start_file(MANIFEST_FILE_NAME, zip_options()).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        zip.finish().unwrap();

        let err = inspect(&dest).expect_err("未来格式必须被拒绝");
        assert!(err.contains("格式版本"), "错误信息应当说明原因: {err}");

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 没有清单的包要拒绝，并且要说清是缺了什么
    #[test]
    fn rejects_a_package_without_a_manifest() {
        let temp = temp_dir("no-manifest");
        let dest = temp.join("nomanifest.zip");
        {
            let file = File::create(&dest).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("data/appdata/settings.json", zip_options())
                .unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }

        let err = inspect(&dest).expect_err("缺清单必须被拒绝");
        assert!(err.contains("manifest.json"), "错误信息应当点明缺什么: {err}");

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 不可恢复的类别（日志）在恢复端直接被拒
    #[test]
    fn logs_cannot_be_restored() {
        let temp = temp_dir("logs-restore");
        let roots = roots_of(&temp);
        seed(&roots);

        let dest = temp.join("backup.zip");
        export(&roots, &[cat("logs")], &dest).expect("日志可以导出");

        let err = restore(&roots, &dest, &[cat("logs")]).expect_err("日志不能恢复");
        assert!(err.contains("不支持恢复"), "错误信息应当说明原因: {err}");

        let _ = std::fs::remove_dir_all(&temp);
    }

    // ============================================================
    // 打包细节
    // ============================================================

    /// 目录前缀的拼法只有一种，且必须落在白名单里。
    ///
    /// `logs` 类别的相对路径是空串（整个日志目录），它最容易被拼成
    /// `data/logdir//x` 这种多一个分隔符的形式 —— 那会通不过白名单。
    #[test]
    fn directory_prefixes_stay_inside_the_whitelist() {
        assert_eq!(
            dir_prefix(BackupRoot::AppData, "plugins/"),
            "data/appdata/plugins/"
        );
        assert_eq!(dir_prefix(BackupRoot::LogDir, ""), "data/logdir/");
        assert_eq!(
            dir_prefix(BackupRoot::AppData, "sounds/"),
            "data/appdata/sounds/"
        );

        for (root, relative) in [
            (BackupRoot::AppData, "plugins/"),
            (BackupRoot::LogDir, ""),
            (BackupRoot::AppData, "sounds/"),
        ] {
            let sample = format!("{}inner.txt", dir_prefix(root, relative));
            assert!(
                categories::resolve_entry(&sample).is_some(),
                "{sample} 应当通过白名单"
            );
        }
    }

    #[test]
    fn file_entries_match_the_whitelist() {
        for (root, relative) in [
            (BackupRoot::AppData, "settings.json"),
            (BackupRoot::AppData, "sidebar_config.json"),
            (BackupRoot::AppData, "notifications.json"),
            (BackupRoot::AppData, "auth.json"),
        ] {
            let name = file_entry(root, relative);
            assert!(
                categories::resolve_entry(&name).is_some(),
                "{name} 应当通过白名单"
            );
        }
    }

    /// 同一个数据目录导两次必须得到**内容相同**的包。
    ///
    /// 用实际打包两次再比字节来验证，而不是断言 `FileOptions` 的字段 ——
    /// 那些字段是私有的，而且这条不变量的真正含义是"结果可复现"，
    /// 直接比结果才是在验证它想验证的东西。
    /// 清单里的 `createdAt` 是唯一例外，因此这里比的是数据条目部分。
    #[test]
    fn archive_bytes_are_deterministic() {
        fn build() -> Vec<u8> {
            let mut buffer = std::io::Cursor::new(Vec::new());
            {
                let mut zip = zip::ZipWriter::new(&mut buffer);
                zip.start_file("data/appdata/settings.json", zip_options())
                    .expect("start_file");
                zip.write_all(br#"{"theme":"dark"}"#).expect("write");
                zip.start_file("data/appdata/plugins/hello/index.js", zip_options())
                    .expect("start_file");
                zip.write_all(b"module.exports = 1;").expect("write");
                zip.finish().expect("finish");
            }
            buffer.into_inner()
        }

        assert_eq!(
            build(),
            build(),
            "同一份数据打包两次的字节必须一致（时间戳不能来自打包时刻）"
        );
    }
}
