// src-tauri/src/modules/plugins/data_dir.rs
//
// 插件私有数据目录（`ctx.dataDir`）的**有界**文件操作。
//
// ============================================================
// 它与 `filesystem-write` 的区别，就是它能存在的原因
// ============================================================
//
// `filesystem-write` 被明确拒绝了（见规划 §8）："任意写"没有边界，补它等于制造一个
// 假的管控点。而这个不同 —— **它的边界就是"这个插件自己的目录"**：
//
//   * 路径严格锁在该插件的数据目录之内，`..`、盘符、UNC、符号链接都出不去；
//   * 单个文件与整个目录都有上限；
//   * 它是"插件管自己的东西"，不是"插件碰这台机器"。
//
// 因此它需要的是一条自己的权限（`plugin-data`），而不是把 `filesystem-write`
// 悄悄放宽。
//
// ============================================================
// 为什么不用"检查字符串里有没有 `..`"那种做法
// ============================================================
//
// 它在 Windows 上会被 `\`、短名（`PROGRA~1`）、UNC、以及符号链接绕过，而这类判据
// 的失效方式恰好是"看起来正常、实际读到了别的文件"。这里用的是：
//
//   1. **逐段校验**名字（拒绝盘符与保留字符、拒绝 `.` 与 `..`、限制段长与深度）；
//   2. 拼好之后，从目标往上找**最近的已存在祖先**，对它 `canonicalize`
//      （解开符号链接）并确认仍在数据根之下。目标还不存在时这一步照样成立。
//
// 第 2 条是关键：`canonicalize` 一个不存在的路径会失败，而写入的目标必然还不存在。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// 路径最多几层。防的是"用一万层目录把路径长度撑爆"。
const MAX_DEPTH: usize = 16;

/// 单个名字最长的字符数。
const MAX_COMPONENT: usize = 128;

/// 单个文件上限。
///
/// 比 `ctx.storage` 的单值上限（1 MB）宽得多：这个目录存在的理由之一就是放
/// 装不进 JSON 的东西。仍然有上限，是因为"没有上限"意味着一个插件能占满用户的盘。
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// 整个数据目录的上限。
///
/// **这是一个占位值。** 真实的合适数字取决于"笔记/文档插件实际会长到多大"，
/// 而那要等它们存在。先给一个足够宽的、但确实存在的上限 ——
/// 一个没有上限的目录会在某一天变成一个没人能解释的磁盘占用。
pub const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

/// 目录里的一个条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix 毫秒。取不到时为 0 —— 一个读不到时间的文件仍然应该被列出来。
    pub modified: u64,
}

/// 一个路径的元信息。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStat {
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

fn modified_millis(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 把插件给的相对路径解析成数据根之下的绝对路径。
///
/// 空串表示数据根自身（`list("")` 就是列根目录）。
///
/// 语义是 **chroot**：路径一概相对数据根，前导分隔符没有特殊含义 ——
/// `/etc/passwd` 指的是 `<数据根>/etc/passwd`。这既安全，也是最好理解的一种解释。
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    resolve_labeled(root, rel, "插件的数据目录")
}

/// 与 `resolve` 逐字相同，只多一个"这是哪种根"的说法。
///
/// 抽出来的理由只有一条，但它是必须的：**越界时的错误消息会被插件显示给用户**。
/// `ctx.dataDir` 与 `ctx.files` 的根是两种不同的东西（插件自己的目录 / 用户选定的
/// 目录），而"路径越出插件的数据目录"用在后者身上是一句会让用户找错方向的话。
///
/// 校验逻辑**只有这一份**：多一个说法不等于多一套规则，把标签订成参数而不是
/// 复制一遍函数，正是为了让"改了一处、另一处漂开"这件事不可能发生。
pub fn resolve_labeled(root: &Path, rel: &str, what: &str) -> Result<PathBuf, String> {
    // Windows 与 POSIX 的分隔符都认：插件在任一侧写出来的路径都该被一致地理解，
    // 而"只认 `/`"会让 `a\..\..\b` 这种在 Windows 上被文件系统当成合法路径的东西
    // 绕过逐段校验。
    let normalized = rel.replace('\\', "/");

    let mut depth = 0usize;
    let mut out = root.to_path_buf();

    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        depth += 1;
        if depth > MAX_DEPTH {
            return Err(format!("路径层数超过上限（{MAX_DEPTH}）"));
        }
        validate_component(segment)?;
        out.push(segment);
    }

    assert_within(root, &out, what)?;
    Ok(out)
}

/// 逐段校验一个名字。
fn validate_component(segment: &str) -> Result<(), String> {
    if segment == ".." {
        return Err("路径里不允许出现 `..`".to_string());
    }
    if segment.chars().count() > MAX_COMPONENT {
        return Err(format!("名字过长（上限 {MAX_COMPONENT} 字符）"));
    }
    // 盘符（`C:`）、NTFS 数据流（`file:stream`）、以及 UNC —— 冒号是它们的共同入口。
    if segment.contains(':') {
        return Err("名字里不允许出现 `:`".to_string());
    }
    // Windows 上不允许出现在文件名里的字符。逐条拒绝而不是"过滤掉"：
    // 一个被悄悄改名的文件比一次明确的失败更难排查。
    if let Some(bad) = segment.chars().find(|c| "*?\"<>|".contains(*c)) {
        return Err(format!("名字里不允许出现 `{bad}`"));
    }
    if segment.chars().any(|c| c.is_control()) {
        return Err("名字里不允许出现控制字符".to_string());
    }
    // Windows 会**悄悄**把结尾的 `.` 与空格去掉，于是 `a.` 与 `a` 是同一个文件。
    // 两个不同的请求映射到同一个文件，正是那种"看起来正常"的错误。
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Err("名字不能以 `.` 或空格结尾（Windows 会把它去掉）".to_string());
    }
    // 保留设备名。这些名字在 Windows 上会打开设备而不是文件。
    let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Err(format!("`{segment}` 是 Windows 的保留设备名"));
    }
    Ok(())
}

/// 确认目标仍在数据根之下 —— 对**最近的已存在祖先**做 `canonicalize`。
///
/// 对目标本身 `canonicalize` 是不行的：写入的目标必然还不存在，而
/// `canonicalize` 一个不存在的路径会直接失败。
fn assert_within(root: &Path, candidate: &Path, what: &str) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("{what}不可访问：{e}"))?;

    let mut probe = candidate;
    loop {
        if probe.exists() {
            let real = probe
                .canonicalize()
                .map_err(|e| format!("路径无法解析：{e}"))?;
            if !real.starts_with(&canonical_root) {
                return Err(format!("路径越出{what}"));
            }
            return Ok(());
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Err(format!("路径越出{what}")),
        }
    }
}

/// 列一个目录。文件与子目录都列，按名字排序。
pub fn list(root: &Path, rel: &str) -> Result<Vec<DataEntry>, String> {
    let dir = resolve(root, rel)?;
    if !dir.is_dir() {
        return Err("不是一个目录".to_string());
    }

    let mut entries: Vec<DataEntry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("无法读取目录：{e}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            // 符号链接一律不列出：它可能是通向外面的出口，而"列出来再读"比
            // "读的时候再判断"多一处可能漏掉的地方。
            let file_type = entry.file_type().ok()?;
            if file_type.is_symlink() {
                return None;
            }
            let meta = entry.metadata().ok()?;
            Some(DataEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_dir: meta.is_dir(),
                // 目录的大小不递归算：`list` 会被频繁调用，而递归统计要遍历整棵树。
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified: modified_millis(&meta),
            })
        })
        .collect();

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// 取一个路径的元信息。不存在时返回 `None`（不是错误）。
pub fn stat(root: &Path, rel: &str) -> Result<Option<DataStat>, String> {
    let path = resolve(root, rel)?;
    let Ok(meta) = std::fs::metadata(&path) else {
        return Ok(None);
    };
    Ok(Some(DataStat {
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified: modified_millis(&meta),
    }))
}

/// 读一个文件。
///
/// ============================================================
/// 读**也**有尺寸上限（此前只有写有）
/// ============================================================
///
/// `MAX_FILE_BYTES` 此前只在 `write` 上判，于是同一个上限对"写"成立、对"读"
/// 不成立 —— 而读的代价比写更大：一次 `ctx.dataDir.read()` 要把整个文件读进内存、
/// 再经 RPC 送出去。一个 256 MB 的文件足以让界面卡住。
///
/// 上限取与写侧**同一个常量**：一个能被写进来的文件就该能被读出去，两侧用不同的
/// 数字只会让"我写得进去却读不回来"变成一个没人解释得清的现象。
///
/// 先看元数据再读，因此超限的文件**不会**被读进内存。这不是一项安全边界
/// （文件可能在两次调用之间变大），而是一道资源保护 —— 与写入侧同一性质。
pub fn read(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    let path = resolve(root, rel)?;

    let meta = std::fs::metadata(&path).map_err(|e| format!("读取失败：{e}"))?;
    if !meta.is_file() {
        return Err("不是一个文件".to_string());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大：{} 字节，上限 {MAX_FILE_BYTES} 字节",
            meta.len()
        ));
    }

    std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))
}

/// 写一个文件（覆盖）。父目录必须已经存在 —— 见 `write` 的说明。
pub fn write(root: &Path, rel: &str, bytes: &[u8], used_bytes: u64) -> Result<(), String> {
    let path = resolve(root, rel)?;

    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大：{} 字节，上限 {MAX_FILE_BYTES} 字节",
            bytes.len()
        ));
    }

    // 覆盖时先减掉旧文件占的字节，否则"把一个大文件改小"会被自己的旧体积挡住。
    let existing = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let projected = used_bytes.saturating_sub(existing) + bytes.len() as u64;
    if projected > MAX_TOTAL_BYTES {
        return Err(format!(
            "插件数据目录超出上限：现有 {used_bytes} 字节 + 本次 {} 字节（替换掉 {existing} 字节）\
             = {projected} 字节，上限 {MAX_TOTAL_BYTES} 字节",
            bytes.len()
        ));
    }

    // **不自动建父目录。** 写入路径里悄悄创建目录，会让一个拼错的路径变成
    // "它明明成功了、东西在别处" —— 而插件没有任何办法发现这一点。
    let Some(parent) = path.parent() else {
        return Err("路径没有父目录".to_string());
    };
    if !parent.is_dir() {
        return Err("上级目录不存在（先用 mkdir 建它）".to_string());
    }

    std::fs::write(&path, bytes).map_err(|e| format!("写入失败：{e}"))
}

/// 建一个目录（含中间层）。已存在时成功。
pub fn mkdir(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    if path == root {
        return Ok(());
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败：{e}"))
}

// ============================================================
// 流式写入（`ctx.http.download`）
// ============================================================
//
// ============================================================
// 为什么它不是"先下一份字节再调 write"
// ============================================================
//
// `write` 拿的是**一整块字节**。用它来接几百 MB 的下载等于要求调用方先把整份
// 内容放进内存 —— 而那正是这个接口存在的理由。
//
// 因此这里给出的是**三段式**：`begin_stream` 拿一个目标与这次能写多少，
// 调用方自己分块写进 `temp`，最后 `finish_stream` 改名。
//
// 路径校验与配额判定仍然只有这一处：`begin_stream` 内部走的还是 `resolve`，
// 与 `read` / `write` / `remove` 完全同一条规则。

/// 一次流式写入的目标。
#[derive(Debug, Clone)]
pub struct StreamTarget {
    /// 最终路径。**只要全部字节都到齐了才会出现**。
    pub path: PathBuf,
    /// 临时路径。写的就是它。
    pub temp: PathBuf,
    /// 这次写入**最多**能占多少字节（配额里剩下的部分，且不超过单文件上限）。
    pub headroom: u64,
}

/// 开始一次流式写入。
///
/// `used_bytes` 是数据目录**当前**的占用（`used_bytes(root)`）。覆盖已有文件时
/// 会先把旧文件占的字节从占用里减掉 —— 与 `write` 同一条判据：不这么做的话，
/// "把一个大文件换成一个小一点的"会被自己的旧体积挡住。
pub fn begin_stream(root: &Path, rel: &str, used_bytes: u64) -> Result<StreamTarget, String> {
    let path = resolve(root, rel)?;

    if path == root {
        return Err("目标不能是数据根目录自身".to_string());
    }

    // **不自动建父目录。** 与 `write` 同一条理由：写入路径里悄悄创建目录，会让
    // 一个拼错的路径变成"它明明成功了、东西在别处"。
    let Some(parent) = path.parent() else {
        return Err("路径没有父目录".to_string());
    };
    if !parent.is_dir() {
        return Err("上级目录不存在（先用 mkdir 建它）".to_string());
    }

    let existing = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let headroom = MAX_TOTAL_BYTES
        .saturating_sub(used_bytes.saturating_sub(existing))
        .min(MAX_FILE_BYTES);

    // 临时文件的扩展名是追加的，因此它仍然在同一个目录里 —— 最后的 `rename`
    // 因此是**同卷**改名，也就是原子操作。跨卷改名会退化成"复制一遍"，
    // 那样就又不原子了。
    let temp = path.with_extension(match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{ext}.part"),
        None => "part".to_string(),
    });

    Ok(StreamTarget {
        path,
        temp,
        headroom,
    })
}

/// 收尾：把 `.part` 改名成目标。
///
/// 同卷改名是原子的，因此目标文件**要么不存在、要么是完整的** ——
/// 而"写到一半被截断的文件"看起来完全正常（图片能打开一半），调用方分辨不了。
pub fn finish_stream(target: &StreamTarget) -> Result<(), String> {
    std::fs::rename(&target.temp, &target.path).map_err(|e| {
        format!(
            "把 {} 改名成 {} 失败：{e}",
            target.temp.display(),
            target.path.display()
        )
    })
}

/// 放弃一次流式写入：删掉那个 `.part`。
///
/// **调用方必须先关掉文件句柄**：Windows 上"还开着的文件"删不掉，于是失败的
/// 下载会留下一个 `.part`，而它看起来像一份没写完但可能还有用的数据。
/// 删不掉时也不报错 —— 一个残留的临时文件比一条让原始错误被覆盖的报错好。
pub fn abort_stream(target: &StreamTarget) {
    if let Err(error) = std::fs::remove_file(&target.temp) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::debug!(
                "清掉未完成的下载文件 {} 失败：{error}",
                target.temp.display()
            );
        }
    }
}

/// 删除一个文件或一个目录（递归）。
///
/// **递归删除是有意的**，也是这里最需要想清楚的一步：不递归的话，插件想清掉自己
/// 一棵旧的目录树就只能自己一层层删，而它更容易写错。边界由 `resolve` 保证 ——
/// 目标必然在插件自己的数据目录里。
pub fn remove(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;

    // 不允许删数据根自身。递归删根等于"清空插件全部数据"，那应该是一个
    // **单独命名**的操作，而不是 `remove("")` 这个容易写错的调用。
    if path == root {
        return Err("不能删除数据根目录自身".to_string());
    }
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("删除目录失败：{e}"))
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("删除文件失败：{e}"))
    }
}

/// 递归统计一个目录的字节数。配额判定与界面展示都用它。
pub fn used_bytes(root: &Path) -> u64 {
    let mut total: u64 = 0;
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 符号链接不计入：跟着它统计会把外面一棵树算进来，而那不是这个目录的占用。
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total = total.saturating_add(used_bytes(&entry.path()));
        } else if let Ok(meta) = entry.metadata() {
            total = total.saturating_add(meta.len());
        }
    }

    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "modulith-data-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // `resolve` 会对根做 canonicalize，而 Windows 的临时目录
        // （`C:\Users\...\AppData\Local\Temp`）本身可能带符号链接，
        // 先规范化一次，免得下面每条断言都在跟这件事较劲。
        dir.canonicalize().unwrap()
    }

    // ============================================================
    // 路径安全：这一组是**唯一**能证明"边界存在"的东西
    // ============================================================
    //
    // 每一条都对应一种真实的绕过手法，而不是"看起来危险"的字符串。

    /// `..` 必须被拒绝 —— 两种分隔符都要。
    ///
    /// 只拒绝 `/` 那一侧是不够的：Windows 把 `\` 也当分隔符，而 `a\..\..\b`
    /// 在文件系统看来完全合法。
    #[test]
    fn resolve_rejects_parent_traversal_on_both_separators() {
        let root = temp_root("traversal");

        for rel in [
            "..",
            "../x",
            "a/../../x",
            "..\\x",
            "a\\..\\..\\x",
            "a/b/../../../x",
            "./../x",
        ] {
            assert!(
                resolve(&root, rel).is_err(),
                "`{rel}` 应当被拒绝，实际通过了"
            );
        }
    }

    /// 盘符必须被拒绝；**前导分隔符则按 chroot 语义理解**。
    ///
    /// 这条测试的第一版把 `//server/share` 也放进了"应当被拒绝"的列表 —— 它失败了，
    /// 而且**它不该通过**：`//` 被当成空段跳过之后，它只剩两个普通段，落在根之内。
    /// 也就是说它无害。把"无害但奇怪"的输入判成攻击，会让这条判据的语义变得含糊 ——
    /// 而下一个人会据此以为前导分隔符是被拦住的。
    ///
    /// 真正的语义是 **chroot**：路径一概相对数据根，`/etc/passwd` 指的是
    /// `<数据根>/etc/passwd`。这既安全，也是最好理解的一种解释。
    #[test]
    fn resolve_rejects_drive_letters_and_treats_leading_slashes_as_chroot() {
        let root = temp_root("absolute");

        for rel in ["C:/Windows/System32", "C:\\Windows", "c:file.txt"] {
            assert!(resolve(&root, rel).is_err(), "`{rel}` 应当被拒绝");
        }

        // 前导分隔符不是"被拒绝"，而是"没有意义" —— 结果仍然锁在根之内。
        for rel in ["/a", "//server/share", "\\a\\b"] {
            let ok = resolve(&root, rel).expect("前导分隔符应当被容忍");
            assert!(ok.starts_with(&root), "`{rel}` 解析到了根之外：{ok:?}");
        }
    }

    /// Windows 的保留设备名必须被拒绝：它们会打开设备而不是文件。
    ///
    /// `NUL` 尤其要紧 —— 往 `NUL` 写"成功"但什么都不会留下，
    /// 而插件会以为它存好了。
    #[test]
    fn resolve_rejects_windows_device_names() {
        let root = temp_root("devices");

        for rel in ["NUL", "nul", "CON", "com1", "LPT9", "NUL.txt"] {
            assert!(resolve(&root, rel).is_err(), "`{rel}` 应当被拒绝");
        }
    }

    /// 结尾的 `.` 与空格必须被拒绝：Windows 会**悄悄**把它们去掉，
    /// 于是两个不同的名字映射到同一个文件。
    #[test]
    fn resolve_rejects_names_windows_silently_normalizes() {
        let root = temp_root("normalize");

        for rel in ["a.", "a ", "dir/b.", "dir/ "] {
            assert!(resolve(&root, rel).is_err(), "`{rel}` 应当被拒绝");
        }
    }

    /// 非法字符与控制字符必须被拒绝。
    #[test]
    fn resolve_rejects_illegal_characters() {
        let root = temp_root("chars");

        for rel in ["a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\u{0}b", "a\nb"] {
            assert!(resolve(&root, rel).is_err(), "`{rel:?}` 应当被拒绝");
        }
    }

    /// 深度与段长必须有上限，否则一个超长路径会把下层 IO 变成一个看不懂的错误。
    #[test]
    fn resolve_bounds_depth_and_component_length() {
        let root = temp_root("bounds");

        let too_deep = (0..=MAX_DEPTH + 2)
            .map(|i| format!("d{i}"))
            .collect::<Vec<_>>()
            .join("/");
        assert!(resolve(&root, &too_deep).is_err(), "过深的路径应当被拒绝");

        let too_long = "x".repeat(MAX_COMPONENT + 1);
        assert!(resolve(&root, &too_long).is_err(), "过长的名字应当被拒绝");
    }

    /// 符号链接不得成为出口。
    ///
    /// 建不出符号链接时**跳过而不是假装通过** —— 一条永远通过的断言比没有断言更糟。
    #[test]
    fn resolve_refuses_to_follow_a_symlink_out_of_the_root() {
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();

        let link = root.join("escape");
        if create_dir_symlink(&outside, &link).is_err() {
            eprintln!("跳过：这个环境不允许创建目录符号链接");
            return;
        }

        // 经过符号链接的路径必须被拒。
        assert!(
            resolve(&root, "escape/secret.txt").is_err(),
            "穿过符号链接的路径应当被拒绝"
        );
        // 读也不能例外。
        assert!(read(&root, "escape/secret.txt").is_err());
    }

    /// 建一个**目录**符号链接。Windows 上需要开发者模式或提权，失败是正常的。
    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(not(windows))]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    // ============================================================
    // 正常路径
    // ============================================================

    /// 空路径就是根本身；嵌套路径正常解析。
    #[test]
    fn resolve_maps_empty_to_root_and_allows_nesting() {
        let root = temp_root("normal");

        assert_eq!(resolve(&root, "").unwrap(), root);
        assert_eq!(
            resolve(&root, "a/b/c.txt").unwrap(),
            root.join("a").join("b").join("c.txt")
        );
    }

    /// 写 → 读 → 列 → stat → 删 的完整回路。
    #[test]
    fn round_trip_write_read_list_stat_remove() {
        let root = temp_root("roundtrip");

        mkdir(&root, "notes").unwrap();
        write(&root, "notes/a.txt", b"hello", used_bytes(&root)).unwrap();
        assert_eq!(read(&root, "notes/a.txt").unwrap(), b"hello");

        let entries = list(&root, "notes").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a.txt");
        assert!(!entries[0].is_dir);
        assert_eq!(entries[0].size, 5);

        let info = stat(&root, "notes/a.txt").unwrap().expect("文件应当存在");
        assert_eq!(info.size, 5);
        assert!(stat(&root, "notes/nope.txt").unwrap().is_none());

        remove(&root, "notes").unwrap();
        assert!(stat(&root, "notes").unwrap().is_none());
    }

    /// **写入不自动建父目录。**
    ///
    /// 悄悄建的话，一个拼错的路径会变成"它明明成功了、东西在别处" ——
    /// 而插件没有任何办法发现这一点。
    #[test]
    fn write_does_not_create_missing_parent_directories() {
        let root = temp_root("noparent");

        let err = write(&root, "missing/a.txt", b"x", 0).expect_err("上级目录不存在时应当失败");
        assert!(err.contains("mkdir"), "错误信息应指向 mkdir，实际：{err}");
    }

    /// 目录总量上限要真的生效，而且**覆盖时按增量算**。
    ///
    /// 单文件上限（256 MB）不在这里测：要触发它得真的拿出那么多字节，
    /// 而"为了测一个判据去分配 256 MB"会让测试比被测代码更危险。
    /// 那一处的判据是一行比较，代价上不划算。
    #[test]
    fn quota_is_measured_on_the_delta_and_enforced_on_the_total() {
        let root = temp_root("quota");
        mkdir(&root, "d").unwrap();

        // 假装已经用了接近上限：这一次写入必须被拒。
        let err = write(&root, "d/another.bin", b"12345", MAX_TOTAL_BYTES - 1)
            .expect_err("总量超限时应当失败");
        assert!(err.contains("上限"), "错误信息应带上限，实际：{err}");

        // **覆盖时先减掉旧体积**：把一个大文件改小必须仍然可以成功 ——
        // 否则"存满了就只能删掉重来"。
        write(&root, "d/keep.bin", b"0123456789", 0).unwrap();
        let used = used_bytes(&root);
        assert_eq!(used, 10);
        assert!(
            write(&root, "d/keep.bin", b"0", used).is_ok(),
            "把大文件改小时不该被自己的旧体积挡住"
        );
        assert_eq!(used_bytes(&root), 1);
    }

    /// 不能删数据根自身。
    ///
    /// 递归删根等于"清空插件全部数据"，那应该是一个**单独命名**的操作，
    /// 而不是 `remove("")` 这个很容易写错的调用。
    #[test]
    fn remove_refuses_to_delete_the_root_itself() {
        let root = temp_root("rmroot");
        assert!(remove(&root, "").is_err());
        assert!(root.is_dir(), "根目录必须还在");
    }

    // ============================================================
    // 流式写入（ctx.http.download 的落盘那一半）
    // ============================================================

    /// 临时文件必须与目标**同一个目录**。
    ///
    /// 跨卷改名会退化成"复制一遍"，于是"要么不存在、要么完整"这条保证就没了 ——
    /// 而它是整个三段式写入存在的理由。
    #[test]
    fn the_temp_file_lives_next_to_the_target() {
        let root = temp_root("stream-temp");
        std::fs::create_dir_all(root.join("docs")).unwrap();

        let target = begin_stream(&root, "docs/a.bin", 0).expect("应当能开始");

        assert_eq!(target.path, root.join("docs").join("a.bin"));
        assert_eq!(target.path.parent(), target.temp.parent());
        assert_eq!(
            target.temp.file_name().and_then(|n| n.to_str()),
            Some("a.bin.part"),
            "临时文件是目标名加 .part，而不是一个随机名字"
        );
    }

    /// 没有扩展名时临时名也要能建出来。
    #[test]
    fn a_target_without_an_extension_still_gets_a_temp_name() {
        let root = temp_root("stream-noext");
        let target = begin_stream(&root, "plain", 0).expect("应当能开始");
        assert_eq!(
            target.temp.file_name().and_then(|n| n.to_str()),
            Some("plain.part")
        );
    }

    /// 路径校验仍然只有 `resolve` 那一处。
    ///
    /// 流式写入不是"另一条写入路径"，它必须继承同一套边界 —— 否则下载就成了
    /// 唯一一个能越界的写。
    #[test]
    fn streaming_inherits_the_same_path_rules() {
        let root = temp_root("stream-paths");

        for hostile in ["../escape.bin", "a/../../escape.bin", "C:/x.bin", "a:b.bin"] {
            assert!(
                begin_stream(&root, hostile, 0).is_err(),
                "这个路径必须被拒绝：{hostile}"
            );
        }

        // 数据根自身不是文件
        assert!(begin_stream(&root, "", 0).is_err());
        // 上级目录不存在时不自动创建（与 write 同一条规则）
        assert!(begin_stream(&root, "nope/a.bin", 0).is_err());
    }

    /// 覆盖已有文件时，旧文件占的字节要**先减掉**。
    ///
    /// 不这么做的话，"把一个大文件换成一个小一点的"会被自己的旧体积挡住 ——
    /// 与 `write` 里那条判据是同一条。
    #[test]
    fn the_headroom_accounts_for_replacing_an_existing_file() {
        let root = temp_root("stream-headroom");

        // 目录里已经占了 1 GiB 的账（用一个假的 used 值表达），而目标是 100 字节
        let existing = 100u64;
        std::fs::write(root.join("a.bin"), vec![0u8; existing as usize]).unwrap();

        let target = begin_stream(&root, "a.bin", MAX_TOTAL_BYTES).expect("应当能开始");

        // 余量 = 上限 - (已用 - 旧文件) —— 也就是"至少还能写回旧文件那么大"
        assert!(
            target.headroom >= existing,
            "替换旧文件时至少要把旧文件那部分让出来：{}",
            target.headroom
        );
    }

    /// 余量永远不会超过单文件上限。
    #[test]
    fn the_headroom_never_exceeds_the_per_file_limit() {
        let root = temp_root("stream-cap");
        let target = begin_stream(&root, "a.bin", 0).expect("应当能开始");
        assert_eq!(target.headroom, MAX_FILE_BYTES);
    }

    /// 收尾之后目标存在、临时文件不存在。
    #[test]
    fn finishing_moves_the_temp_onto_the_target() {
        let root = temp_root("stream-finish");
        let target = begin_stream(&root, "done.bin", 0).expect("应当能开始");

        std::fs::write(&target.temp, b"hello").unwrap();
        assert!(!target.path.exists(), "改名之前目标不该存在");

        finish_stream(&target).expect("应当能改名");

        assert_eq!(std::fs::read(&target.path).unwrap(), b"hello");
        assert!(!target.temp.exists(), "临时文件应当已经不在");
    }

    /// 放弃之后**目标不出现**，临时文件被清掉。
    ///
    /// 这是"全有或全无"的另一半：失败时留下一个被截断的目标文件是最糟的结果 ——
    /// 它看起来完全正常（图片能打开一半）。
    #[test]
    fn aborting_leaves_no_target_and_no_temp() {
        let root = temp_root("stream-abort");
        let target = begin_stream(&root, "partial.bin", 0).expect("应当能开始");

        std::fs::write(&target.temp, b"half").unwrap();
        abort_stream(&target);

        assert!(!target.path.exists(), "目标不该出现");
        assert!(!target.temp.exists(), "临时文件应当被清掉");

        // 再放弃一次不是错误（失败路径可能被走两遍）
        abort_stream(&target);
    }
}
