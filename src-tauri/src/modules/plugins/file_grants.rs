// src-tauri/src/modules/plugins/file_grants.rs
//
// 用户授权的文件访问（`ctx.files`）。
//
// ============================================================
// 它为什么不是 `filesystem-write`
// ============================================================
//
// 规划里 `filesystem-write`（任意写）被判为"没有边界，补它等于制造一个假的管控点"，
// 而 `filesystem-scoped` 被推迟，理由写得很清楚：**核心工作量在授权模型与界面，
// 而不在便宜的路径判定**，而且"授权模型一旦发布就难以更改"。
//
// 那两句话都是对的，因此这里**没有**去做它们：这个模块一笔都不碰"持久化的目录授权"
// 那一摊（授权 UI、持久化、撤销、撤销后的行为、跨版本迁移）。它换了一条更窄的路：
//
//   * **路径从来不由插件给出。** 唯一能产生一条授权的动作是用户在一个**宿主弹出的
//     原生对话框**里选中了某个文件或某个目录。插件能提供的只有"对话框的标题"与
//     "扩展名过滤器" —— 两者都只影响用户看到什么，不影响用户能选什么。
//   * **授权是会话级的。** 它绑在 `(插件, 界面)` 上，界面一关、插件一停用、
//     应用一退出就消失。因此不存在"用户三年前授权过一个目录"这种状态，
//     也就不需要撤销界面与迁移逻辑 —— 推迟那件事的那个理由在这里不成立。
//   * **一次授权就是一个根。** 单文件授权只有一个文件、目录授权只有一个目录；
//     相对路径被 `data_dir::resolve_labeled` 按 chroot 语义锁在这个根之内，
//     与 `ctx.dataDir` 用的是**同一份**路径校验实现（第 111 行的调用）。
//
// 于是它买到的能力是"用户当下让我处理这个文件/这个目录"，而不是"这个插件能读写
// 这台机器"。`filesystem-write` 仍然是不实现的。
//
// ============================================================
// 读写是两个不同的权限
// ============================================================
//
// `filesystem-read` 管"能读"，`filesystem-scoped` 管"能写到用户选定的目录"。
// 前者本来就有（icons / shell / audio / fileDrop 都用它），后者此前**没有任何
// 强制点** —— 这个模块给了它第一个，而且是在"有界"这个前提下给的。
//
// 只读授权不要求 `filesystem-scoped`：一个"打开图片看一眼元数据"的插件不该为了
// 这件事去申请写权限。反过来，一个只声明了 `filesystem-read` 的插件**拿不到**
// 可写授权 —— 判定在 `manager.rs` 里，不在这里（这里只认传进来的模式）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use super::data_dir;

/// 单文件上限，与 `ctx.dataDir` 取同一个数字。
///
/// 这是**单次写入**的上限，不是"这个目录能用多少"。**整个授权目录没有总量上限**，
/// 这一点与插件私有目录刻意不同：那一边的边界是"插件在花用户的磁盘"，而这一边
/// 用户自己选定了目标目录、并且能看到文件一个个出现 —— 再套一个我们自己发明的
/// 配额只会在"用户就是想导 200 张图"时拦住他。
pub const MAX_GRANT_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// 一块界面最多同时持有多少条授权。
///
/// 存在的理由与配额无关：每一条授权都要用户点一次对话框，因此正常路径下达不到这个
/// 数字。它挡的是"插件在一个循环里反复弹框"——那种情况下真正先出问题的是用户，
/// 而一个上限让插件拿到一条明确的错误，而不是让宿主的内存慢慢涨上去。
pub const MAX_GRANTS_PER_SURFACE: usize = 4096;

/// 一次对话框最多返回多少个文件。
///
/// "选一个装了两万张图的目录"是真实场景，但那是**目录授权**该干的事；这一条走的是
/// 多选文件对话框，两万个文件会让返回的那份 JSON 本身变成负担。
pub const MAX_PICKED_FILES: usize = 2048;

/// 授权的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GrantKind {
    /// 单文件：用户在文件对话框里选中的一个文件。相对路径必须为空。
    File,
    /// 目录：用户在目录对话框里选中的一个目录。相对路径锁在它之内。
    Directory,
}

/// 交给插件的一份授权描述。
///
/// **里面没有路径。** 插件拿到的是 `grant` 这个不透明 id，读写的地址形如
/// `/<令牌>/file/<grant>/<相对路径>`。这样"这个插件知道用户的目录结构"这件事
/// 就不再是接口的一部分 —— 它只知道用户允许它碰的那一个根。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantSummary {
    pub grant: String,
    pub kind: GrantKind,
    /// 给人看的名字（文件名或目录名）。**只用于显示**，不参与任何路径解析。
    pub label: String,
    pub readable: bool,
    pub writable: bool,
    /// 文件授权是文件大小；目录授权恒为 0（不递归统计，见 `data_dir::list` 的同一条理由）。
    pub bytes: u64,
}

/// 注册表里的一条授权。**不实现 `Serialize`** —— 它含有绝对路径，而绝对路径是
/// 这个模块唯一刻意不让插件看到的东西。想把它交给插件，先过 `GrantSummary`。
#[derive(Debug, Clone)]
pub struct Grant {
    pub id: String,
    pub plugin_id: String,
    pub surface: String,
    pub kind: GrantKind,
    pub root: PathBuf,
    pub label: String,
    pub readable: bool,
    pub writable: bool,
    pub bytes: u64,
}

impl Grant {
    fn summary(&self) -> GrantSummary {
        GrantSummary {
            grant: self.id.clone(),
            kind: self.kind,
            label: self.label.clone(),
            readable: self.readable,
            writable: self.writable,
            bytes: self.bytes,
        }
    }

    /// 把插件给的相对路径解析成**这个授权之内**的绝对路径。
    ///
    /// 两种授权在这里分叉，而分叉的理由是"根是什么"：
    ///   * 文件授权 —— 根就是一个文件，因此相对路径**必须为空**。允许它非空就等于
    ///     允许"从这个文件出发往旁边走"，那不是用户授权的东西；
    ///   * 目录授权 —— 根是一个目录，交给 `data_dir::resolve_labeled` 按 chroot
    ///     语义解析（`..`、盘符、UNC、保留设备名、符号链接全部在那一处处理）。
    fn target(&self, rel: &str) -> Result<PathBuf, String> {
        match self.kind {
            GrantKind::File => {
                if !rel.is_empty() {
                    return Err("这是一条单文件授权，它的路径必须为空".to_string());
                }
                Ok(self.root.clone())
            }
            GrantKind::Directory => {
                data_dir::resolve_labeled(&self.root, rel, "用户授权的目录")
            }
        }
    }
}

/// 会话级的授权表。由 Tauri 托管（`app.manage`），因此生命周期就是进程的生命周期。
#[derive(Default)]
pub struct FileGrants {
    inner: RwLock<HashMap<String, Grant>>,
}

impl FileGrants {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, grant: Grant, surface: &str) -> Result<GrantSummary, String> {
        let mut table = self.inner.write().unwrap_or_else(|e| e.into_inner());

        // 数一遍这块界面已有的条数。用 `filter` 而不是维护一个计数：计数字段与
        // 表内容会在某一次"忘了减一"之后静默漂开，而这个表本身就不可能很大。
        let held = table
            .values()
            .filter(|item| item.surface == surface && item.plugin_id == grant.plugin_id)
            .count();
        if held >= MAX_GRANTS_PER_SURFACE {
            return Err(format!(
                "这块界面已经持有 {held} 条文件授权（上限 {MAX_GRANTS_PER_SURFACE}）"
            ));
        }

        let summary = grant.summary();
        table.insert(grant.id.clone(), grant);
        Ok(summary)
    }

    /// 为**一个用户选中的文件**签发一条只读授权。
    ///
    /// 一次一个文件（而不是"一次对话返回一批、共用一个 id"）：共用一个 id 就需要
    /// 在相对路径里编码"是哪一个"，那等于把"从根往旁边走"重新引进来 —— 而这个
    /// 设计的要点恰恰是每一份授权只有一个根。
    pub fn issue_file(
        &self,
        plugin_id: &str,
        surface: &str,
        path: &Path,
        writable: bool,
    ) -> Result<GrantSummary, String> {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("这个文件无法解析：{e}"))?;
        if !canonical.is_file() {
            return Err("选中的不是一个文件".to_string());
        }
        let bytes = std::fs::metadata(&canonical).map(|m| m.len()).unwrap_or(0);
        let label = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "文件".to_string());

        self.insert(
            Grant {
                id: super::sandbox::new_token(),
                plugin_id: plugin_id.to_string(),
                surface: surface.to_string(),
                kind: GrantKind::File,
                root: canonical,
                label,
                // 文件授权的读永远是允许的：用户选中一个文件这个动作本身就是"给它看"。
                // 写则由调用方决定（`manager.rs` 会先要 `filesystem-scoped`）。
                readable: true,
                writable,
                bytes,
            },
            surface,
        )
    }

    /// 为**一个用户选中的目录**签发一条授权。`writable` 决定它能不能被写。
    pub fn issue_directory(
        &self,
        plugin_id: &str,
        surface: &str,
        path: &Path,
        writable: bool,
    ) -> Result<GrantSummary, String> {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("这个目录无法解析：{e}"))?;
        if !canonical.is_dir() {
            return Err("选中的不是一个目录".to_string());
        }
        let label = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| canonical.to_string_lossy().to_string());

        self.insert(
            Grant {
                id: super::sandbox::new_token(),
                plugin_id: plugin_id.to_string(),
                surface: surface.to_string(),
                kind: GrantKind::Directory,
                root: canonical,
                label,
                readable: true,
                writable,
                bytes: 0,
            },
            surface,
        )
    }

    /// 取一条授权，**并核对它确实属于这个 (插件, 界面)**。
    ///
    /// 归属判定只有这一处。少了它，一个插件只要猜到（或从别处读到）另一个插件的
    /// 授权 id 就能用它 —— 而 id 是 32 位随机十六进制，猜不到，但"猜不到"从来
    /// 不是一条边界。协议处理器拿到的身份来自令牌，这里比的就是那份身份。
    pub fn get(&self, plugin_id: &str, surface: &str, id: &str) -> Option<Grant> {
        if !super::sandbox::is_token(id) {
            return None;
        }
        let table = self.inner.read().unwrap_or_else(|e| e.into_inner());
        table
            .get(id)
            .filter(|grant| grant.plugin_id == plugin_id && grant.surface == surface)
            .cloned()
    }

    /// 这块界面当前持有哪些授权。
    pub fn list(&self, plugin_id: &str, surface: &str) -> Vec<GrantSummary> {
        let table = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let mut items: Vec<GrantSummary> = table
            .values()
            .filter(|grant| grant.plugin_id == plugin_id && grant.surface == surface)
            .map(Grant::summary)
            .collect();
        // 顺序稳定：`HashMap` 的迭代顺序随机，而这份列表会被画进界面 ——
        // 每次刷新都换一个顺序会让人以为"多了几个"。
        items.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.grant.cmp(&b.grant)));
        items
    }

    /// 主动释放一条授权（插件自己不再需要它了）。返回是否真的删掉了东西。
    pub fn release(&self, plugin_id: &str, surface: &str, id: &str) -> bool {
        let mut table = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let owned = table
            .get(id)
            .is_some_and(|grant| grant.plugin_id == plugin_id && grant.surface == surface);
        if owned {
            table.remove(id);
        }
        owned
    }

    /// 收回一块界面的全部授权。界面关闭时走这条。
    pub fn revoke_surface(&self, plugin_id: &str, surface: &str) -> usize {
        let mut table = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let doomed: Vec<String> = table
            .values()
            .filter(|grant| grant.plugin_id == plugin_id && grant.surface == surface)
            .map(|grant| grant.id.clone())
            .collect();
        for id in &doomed {
            table.remove(id);
        }
        doomed.len()
    }

    /// 收回一个插件的全部授权。插件被停用/卸载/重载时走这条。
    pub fn revoke_plugin(&self, plugin_id: &str) -> usize {
        let mut table = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let doomed: Vec<String> = table
            .values()
            .filter(|grant| grant.plugin_id == plugin_id)
            .map(|grant| grant.id.clone())
            .collect();
        for id in &doomed {
            table.remove(id);
        }
        doomed.len()
    }

    /// 当前一共签出了多少条（诊断与测试用）。
    pub fn len(&self) -> usize {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ============================================================
// 授权之内的文件操作
// ============================================================
//
// 每一个函数拿的都是**已经核对过归属的 `Grant`**，而不是 id —— 让"这个 id 属于谁"
// 这个问题只有 `get` 一个答案。传 id 进来会诱使每个调用点各自再判一次，
// 而漏掉任意一处就是一条越权路径。

/// 目标现在是否存在。
///
/// 单独一条而不是让调用方自己 `read().is_err()`：协议层要区分"这条路不存在"（404，
/// 插件应当据此去建它）与"它在那儿但我读不了"（越界、超上限、只读授权 —— 都是 4xx
/// 加一句原因）。把两者揉成同一个错误，插件就只能猜。
pub fn exists(grant: &Grant, rel: &str) -> bool {
    grant.target(rel).map(|path| path.exists()).unwrap_or(false)
}

/// 读一个文件。
pub fn read(grant: &Grant, rel: &str) -> Result<Vec<u8>, String> {
    if !grant.readable {
        return Err("这条授权不允许读".to_string());
    }
    let path = grant.target(rel)?;
    if !path.is_file() {
        return Err("不是一个文件".to_string());
    }
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_GRANT_FILE_BYTES {
        return Err(format!(
            "文件过大：{size} 字节，上限 {MAX_GRANT_FILE_BYTES} 字节"
        ));
    }
    std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))
}

/// 写一个文件（覆盖）。
///
/// **先写同目录的临时文件、再改名。** 直接 `fs::write` 到一个用户目录，在中途失败
/// （盘满、被占用、进程被杀）时会留下一个**半截的文件** —— 而半截的 PNG 与一张
/// 正常的图片在文件管理器里长得一模一样，用户要到打开它的时候才发现。改名在同目录内
/// 是原子的，因此"看见它"与"它是完整的"是同一件事。
pub fn write(grant: &Grant, rel: &str, bytes: &[u8]) -> Result<(), String> {
    if !grant.writable {
        return Err("这条授权不允许写".to_string());
    }
    if bytes.len() as u64 > MAX_GRANT_FILE_BYTES {
        return Err(format!(
            "内容过大：{} 字节，上限 {MAX_GRANT_FILE_BYTES} 字节",
            bytes.len()
        ));
    }

    let path = grant.target(rel)?;
    if path == grant.root {
        return Err("缺少文件路径".to_string());
    }
    if path.is_dir() {
        return Err("目标是目录".to_string());
    }

    let Some(parent) = path.parent() else {
        return Err("路径没有上级目录".to_string());
    };
    // **不自动建父目录**，与 `data_dir::write` 同一条规则：悄悄创建目录会让一个
    // 拼错的路径变成"它明明成功了、东西在别处"，而插件没有任何办法发现。
    if !parent.is_dir() {
        return Err("上级目录不存在（先用 files.mkdir 建它）".to_string());
    }

    let temp = parent.join(format!(
        ".{}.modulith-{}",
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "out".to_string()),
        uuid::Uuid::new_v4().simple()
    ));

    if let Err(e) = std::fs::write(&temp, bytes) {
        // 失败时把临时文件收掉。留在用户目录里的一个隐藏临时文件，是这个功能
        // 唯一会"看得见地弄脏别人的目录"的地方。
        let _ = std::fs::remove_file(&temp);
        return Err(format!("写入失败：{e}"));
    }

    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("写入失败（改名阶段）：{e}")
    })
}

/// 列一个目录。只对目录授权有意义。
pub fn list(grant: &Grant, rel: &str) -> Result<Vec<data_dir::DataEntry>, String> {
    if !grant.readable {
        return Err("这条授权不允许读".to_string());
    }
    if grant.kind != GrantKind::Directory {
        return Err("这是一条单文件授权，不能列目录".to_string());
    }
    data_dir::list(&grant.root, rel)
}

/// 取一个路径的元信息。不存在时 `None`。
pub fn stat(grant: &Grant, rel: &str) -> Result<Option<data_dir::DataStat>, String> {
    if !grant.readable {
        return Err("这条授权不允许读".to_string());
    }
    if grant.kind != GrantKind::Directory {
        return Err("这是一条单文件授权，没有可列的目录".to_string());
    }
    data_dir::stat(&grant.root, rel)
}

/// 建一个目录（含中间层）。需要可写。
pub fn mkdir(grant: &Grant, rel: &str) -> Result<(), String> {
    if !grant.writable {
        return Err("这条授权不允许写".to_string());
    }
    if grant.kind != GrantKind::Directory {
        return Err("这是一条单文件授权，不能在它旁边建目录".to_string());
    }
    data_dir::mkdir(&grant.root, rel)
}

/// 删除一个文件或一棵目录树。需要可写。
///
/// **它比 `ctx.dataDir.remove` 危险得多**：那一边删错了只毁自己的数据，这一边删的是
/// 用户的真实文件。因此这里多一道判定 —— 相对路径不能为空。空路径在目录授权下解析
/// 出来就是那个根目录本身，也就是"把用户刚授权给我的整个目录删掉"，而这不是任何
/// 插件该有的能力。`ctx.files` 只删它自己写进去的那些东西。
pub fn remove(grant: &Grant, rel: &str) -> Result<(), String> {
    if !grant.writable {
        return Err("这条授权不允许写".to_string());
    }
    if rel.trim().is_empty() || rel.trim_matches(['/', '\\']).is_empty() {
        return Err("拒绝删除授权目录本身".to_string());
    }
    if grant.kind != GrantKind::Directory {
        return Err("这是一条单文件授权，不能在它旁边删东西".to_string());
    }
    data_dir::remove(&grant.root, rel)
}

// ============================================================
// 测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "modulith-grants-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_grant_hides_the_path_and_refuses_a_relative_one() {
        let root = temp_root("file");
        let file = root.join("a.png");
        std::fs::write(&file, b"png").unwrap();

        let grants = FileGrants::new();
        let summary = grants.issue_file("com.example.p", "main", &file, false).unwrap();

        assert_eq!(summary.kind, GrantKind::File);
        assert_eq!(summary.label, "a.png");
        assert_eq!(summary.bytes, 3);
        assert!(summary.readable);
        assert!(!summary.writable);

        let grant = grants.get("com.example.p", "main", &summary.grant).unwrap();
        assert_eq!(read(&grant, "").unwrap(), b"png");
        // 文件授权**没有**"旁边"这个概念。
        assert!(read(&grant, "b.png").is_err());
        assert!(write(&grant, "b.png", b"x").is_err(), "只读授权不该能写");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_grant_is_chrooted_to_that_directory() {
        let root = temp_root("dir");
        let outside = root.parent().unwrap().join(format!(
            "modulith-outside-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();

        let grants = FileGrants::new();
        let summary = grants
            .issue_directory("com.example.p", "main", &root, true)
            .unwrap();
        let grant = grants.get("com.example.p", "main", &summary.grant).unwrap();

        write(&grant, "out.png", b"image").unwrap();
        assert_eq!(read(&grant, "out.png").unwrap(), b"image");

        // 三种典型的越界写法，全部要被挡在根之内。
        assert!(read(&grant, "../secret.txt").is_err());
        assert!(write(&grant, "../../evil.png", b"x").is_err());
        assert!(write(&grant, "..\\evil.png", b"x").is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_empty_relative_path_never_deletes_the_granted_directory() {
        let root = temp_root("nodel");
        std::fs::write(root.join("keep.txt"), b"keep").unwrap();

        let grants = FileGrants::new();
        let summary = grants
            .issue_directory("com.example.p", "main", &root, true)
            .unwrap();
        let grant = grants.get("com.example.p", "main", &summary.grant).unwrap();

        assert!(remove(&grant, "").is_err());
        assert!(remove(&grant, "/").is_err());
        assert!(remove(&grant, "\\").is_err());
        assert!(root.join("keep.txt").is_file(), "目录本身必须还在");

        // 但**它自己写进去的东西**要能删掉。
        write(&grant, "mine.png", b"x").unwrap();
        remove(&grant, "mine.png").unwrap();
        assert!(!root.join("mine.png").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_grant_is_invisible_to_another_plugin_or_surface() {
        let root = temp_root("owner");
        let grants = FileGrants::new();
        let summary = grants
            .issue_directory("com.example.p", "main", &root, true)
            .unwrap();

        assert!(grants.get("com.example.other", "main", &summary.grant).is_none());
        assert!(grants.get("com.example.p", "detail", &summary.grant).is_none());
        assert!(grants.get("com.example.p", "main", &summary.grant).is_some());

        // 别人也删不掉它。
        assert!(!grants.release("com.example.other", "main", &summary.grant));
        assert!(!grants.release("com.example.p", "detail", &summary.grant));
        assert_eq!(grants.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_malformed_grant_id_never_reaches_the_table() {
        let root = temp_root("shape");
        let grants = FileGrants::new();
        grants
            .issue_directory("com.example.p", "main", &root, true)
            .unwrap();

        // 形状不对的 id 连查都不查 —— 与令牌同一条规则（`sandbox::is_token`）。
        assert!(grants.get("com.example.p", "main", "").is_none());
        assert!(grants.get("com.example.p", "main", "short").is_none());
        assert!(grants
            .get("com.example.p", "main", &"z".repeat(32))
            .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn revoking_a_surface_leaves_other_surfaces_alone() {
        let root = temp_root("revoke");
        let grants = FileGrants::new();
        grants.issue_directory("com.example.p", "main", &root, true).unwrap();
        grants.issue_directory("com.example.p", "detail", &root, true).unwrap();
        grants.issue_directory("com.example.q", "main", &root, true).unwrap();
        assert_eq!(grants.len(), 3);

        assert_eq!(grants.revoke_surface("com.example.p", "main"), 1);
        assert_eq!(grants.len(), 2);
        assert_eq!(grants.revoke_plugin("com.example.p"), 1);
        assert_eq!(grants.len(), 1);
        assert_eq!(grants.revoke_plugin("com.example.q"), 1);
        assert!(grants.is_empty());

        // 再收一次不是错误，只是什么都不发生。
        assert_eq!(grants.revoke_plugin("com.example.q"), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_grant_takes_a_cap_on_how_many_one_surface_may_hold() {
        let root = temp_root("cap");
        let grants = FileGrants::new();
        for index in 0..MAX_GRANTS_PER_SURFACE {
            // 反复授权同一个目录：这里查的是**条数**上限，不是路径。
            grants
                .issue_directory("com.example.p", "main", &root, true)
                .unwrap_or_else(|e| panic!("第 {index} 条就失败了：{e}"));
        }
        let overflow = grants.issue_directory("com.example.p", "main", &root, true);
        assert!(overflow.is_err(), "超过上限之后必须失败");
        // 换一块界面不受影响 —— 上限是"每块界面"，不是"每插件"。
        assert!(grants
            .issue_directory("com.example.p", "detail", &root, true)
            .is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_read_only_directory_grant_cannot_be_written_to() {
        let root = temp_root("readonly");
        let grants = FileGrants::new();
        let summary = grants
            .issue_directory("com.example.p", "main", &root, false)
            .unwrap();
        let grant = grants.get("com.example.p", "main", &summary.grant).unwrap();

        assert!(write(&grant, "x.png", b"x").is_err());
        assert!(mkdir(&grant, "sub").is_err());
        assert!(remove(&grant, "x.png").is_err());
        // 读仍然可以 —— 只读授权就是"只能看"。
        assert!(list(&grant, "").is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn writing_replaces_atomically_and_leaves_no_temp_file_behind() {
        let root = temp_root("atomic");
        let grants = FileGrants::new();
        let summary = grants
            .issue_directory("com.example.p", "main", &root, true)
            .unwrap();
        let grant = grants.get("com.example.p", "main", &summary.grant).unwrap();

        write(&grant, "a.png", b"first").unwrap();
        write(&grant, "a.png", b"second").unwrap();
        assert_eq!(read(&grant, "a.png").unwrap(), b"second");

        let leftovers: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("modulith-"))
            .collect();
        assert!(leftovers.is_empty(), "不该留下临时文件：{leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn writing_does_not_silently_create_missing_parent_directories() {
        let root = temp_root("parent");
        let grants = FileGrants::new();
        let summary = grants
            .issue_directory("com.example.p", "main", &root, true)
            .unwrap();
        let grant = grants.get("com.example.p", "main", &summary.grant).unwrap();

        assert!(write(&grant, "sub/deep/a.png", b"x").is_err());
        assert!(!root.join("sub").exists(), "失败不该留下建到一半的目录树");

        mkdir(&grant, "sub/deep").unwrap();
        write(&grant, "sub/deep/a.png", b"x").unwrap();
        assert_eq!(read(&grant, "sub/deep/a.png").unwrap(), b"x");
        let _ = std::fs::remove_dir_all(&root);
    }
}
