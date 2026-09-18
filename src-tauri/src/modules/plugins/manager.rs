// src-tauri/src/modules/plugins/manager.rs
// 运行时插件管理器：安装 / 启用 / 卸载 / 导出 / 存储 / HTTP 代理

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

use super::icon;
use super::types::{
    ExportOutcome, HttpResponse, InstalledPlugin, PluginError, PluginManifest, PluginPermission,
    PluginResult, PluginStatus, RegistryEntry, RegistryFile,
};
use super::validator;

/// 单个插件包解压后的最大体积（64 MB）
const MAX_PLUGIN_BYTES: u64 = 64 * 1024 * 1024;
/// 单个插件包最多包含的条目数
const MAX_ZIP_ENTRIES: usize = 5000;
/// `read_plugin_asset` 允许读取的最大文件（8 MB）
const MAX_ASSET_BYTES: u64 = 8 * 1024 * 1024;
/// README 最大读取量（64 KB）
const MAX_README_BYTES: u64 = 64 * 1024;
/// HTTP 代理允许的最大响应体（2 MB）
const MAX_HTTP_BODY_BYTES: u64 = 2 * 1024 * 1024;
/// 启动外部程序允许的最大参数个数
const MAX_LAUNCH_ARGS: usize = 64;
/// 单个启动参数的最大字符数
const MAX_LAUNCH_ARG_LEN: usize = 4096;

/// 校验来自前端的插件 ID。
///
/// 与清单校验共用同一套字符集规则（字母数字开头，只含字母数字与 `.` `_` `-`），
/// 因为插件 ID 就是清单的 `name`，同时被当作目录名与存储命名空间使用。
pub fn validate_plugin_id(id: &str, what: &str) -> PluginResult<()> {
    if !validator::is_valid_plugin_name(id) {
        return Err(PluginError::SandboxViolation(format!(
            "非法的{}（只允许字母数字、. _ -，字母数字开头，最长 64 字符）: {}",
            what, id
        )));
    }
    Ok(())
}

/// 权限判定的**纯函数**部分：只看清单内容，不做任何 IO。
///
/// 单独抽出来是为了可测 —— `PluginManager` 持有 `AppHandle`，单测里造不出来。
/// 判定规则（"必须在清单里显式声明"）因此能被测试锁定，管理器一侧只负责
/// 把清单读出来再交给这里。
///
/// 规则本身值得写清楚：**没声明就是拒绝**，不做"默认放行"或"按沙箱级别推断"。
/// 默认放行会让清单的权限列表失去意义，而沙箱级别目前没有任何逻辑读取它
/// （见文档「声明但未强制的部分」）。
fn ensure_permission(
    manifest: &PluginManifest,
    id: &str,
    permission: PluginPermission,
) -> PluginResult<()> {
    if manifest.permissions.contains(&permission) {
        return Ok(());
    }
    Err(PluginError::PermissionDenied(format!(
        "插件 {} 未声明 {} 权限",
        id,
        permission.as_str()
    )))
}

/// 校验并解析「宿主代表插件访问的本机路径」。
///
/// 三条规则，都是刻意的：
///
/// 1. **必须绝对路径。** 这挡掉的是「借助 PATH 解析的程序名」（`cmd`、
///    `powershell`…）。插件若想执行一段命令，就得先写出一条真实存在的路径 ——
///    这让行为在插件清单与代码里都看得见，而不是藏在一个短名字后面。
///    注意它**不能**阻止插件启动 `cmd.exe`：该文件同样是绝对路径。
///    插件本就被视为本机程序，这里做的是「让意图显式」，不是沙箱。
/// 2. **必须已存在。** 否则错误会推迟到真正使用路径时才出现，报错更含糊。
/// 3. 经 `canonicalize` 归一化，避免 `..` 与符号链接造成的歧义。
///
/// 这里**不要求是文件**：「在文件管理器中定位」既可以指向文件也可以指向目录。
/// 需要文件的调用方自行再加一道检查。
fn resolve_existing_path(raw: &str) -> PluginResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(PluginError::SandboxViolation("路径为空".to_string()));
    }
    if trimmed.contains('\0') {
        return Err(PluginError::SandboxViolation(
            "路径含 NUL 字符".to_string(),
        ));
    }

    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(PluginError::SandboxViolation(format!(
            "必须使用绝对路径，不接受借助 PATH 解析的程序名: {}",
            trimmed
        )));
    }

    path.canonicalize().map_err(|e| {
        PluginError::NotFound(format!("路径不存在或无法访问: {}（{}）", trimmed, e))
    })
}

/// 在 `resolve_existing_path` 之上再要求目标确实是一个文件。
///
/// 要启动的程序、要取图标的文件都属于这一类。
fn resolve_file_argument(raw: &str) -> PluginResult<PathBuf> {
    let canonical = resolve_existing_path(raw)?;
    if !canonical.is_file() {
        return Err(PluginError::NotFound(format!(
            "目标不是文件: {}",
            raw.trim()
        )));
    }
    Ok(canonical)
}

/// 校验启动参数。
///
/// 参数**不经过 shell**：它们作为独立的 argv 项传给 `Command::args`，
/// 因此不存在引号、`&&`、`|` 这类注入问题。这里限制的只是规模，防止
/// 一次调用塞进异常多的参数。
fn validate_launch_args(args: &[String]) -> PluginResult<()> {
    if args.len() > MAX_LAUNCH_ARGS {
        return Err(PluginError::SandboxViolation(format!(
            "参数过多: {}（上限 {}）",
            args.len(),
            MAX_LAUNCH_ARGS
        )));
    }
    for arg in args {
        if arg.contains('\0') {
            return Err(PluginError::SandboxViolation(
                "参数含 NUL 字符".to_string(),
            ));
        }
        if arg.chars().count() > MAX_LAUNCH_ARG_LEN {
            return Err(PluginError::SandboxViolation(format!(
                "单个参数过长（上限 {} 字符）",
                MAX_LAUNCH_ARG_LEN
            )));
        }
    }
    Ok(())
}

/// 运行时插件管理器
pub struct PluginManager {
    app: AppHandle,
    plugins_dir: PathBuf,
    data_dir: PathBuf,
    registry: HashMap<String, RegistryEntry>,
    client: reqwest::Client,
}

// ============================================================
// 构造 / 目录 / 注册表
// ============================================================

impl PluginManager {
    /// 创建管理器：准备目录并加载 registry.json
    pub fn new(app: AppHandle) -> PluginResult<Self> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| PluginError::IoError(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("无法获取应用数据目录: {}", e),
            )))?;

        let plugins_dir = app_data.join("plugins");
        let data_dir = app_data.join("plugin_data");

        std::fs::create_dir_all(&plugins_dir)?;
        std::fs::create_dir_all(&data_dir)?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| PluginError::NetworkError(e.to_string()))?;

        let mut manager = Self {
            app,
            plugins_dir,
            data_dir,
            registry: HashMap::new(),
            client,
        };

        // 注册表损坏不应阻止应用启动，退化为空注册表并告警
        if let Err(e) = manager.load_registry() {
            log::warn!("加载插件注册表失败，将从空注册表开始: {}", e);
            manager.registry = HashMap::new();
        }

        Ok(manager)
    }

    pub fn plugins_dir(&self) -> &Path {
        &self.plugins_dir
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn registry_path(&self) -> PathBuf {
        self.plugins_dir.join("registry.json")
    }

    fn staging_dir(&self) -> PathBuf {
        self.plugins_dir.join(".staging")
    }

    /// 插件数据目录：`<app_data>/plugin_data/<id>`
    ///
    /// **这里是 ID 的关键防线。** 数据目录与插件目录都靠 `join` 拼出，而所有
    /// 命令的 `id` 参数都来自前端（插件自己可以直接 `invoke`），因此 ID 必须先
    /// 过 `is_valid_plugin_name`。没有这道校验时，`id = ".."` 会让路径解析成
    /// `<app_data>/plugin_data/..`，即应用数据目录本身 —— `storage_clear` 会
    /// 据此 `remove_dir_all`，把 settings.json / auth.json / notifications.json
    /// 一起删掉。
    ///
    /// 校验放在这里而不是各调用点，是因为漏掉任意一个调用点就等于没有防护。
    fn plugin_data_dir(&self, id: &str) -> PluginResult<PathBuf> {
        validate_plugin_id(id, "插件 ID")?;
        Ok(self.data_dir.join(id))
    }

    /// 从 registry.json 读取已安装列表
    pub fn load_registry(&mut self) -> PluginResult<()> {
        let path = self.registry_path();
        if !path.exists() {
            self.registry = HashMap::new();
            return Ok(());
        }

        let content = std::fs::read_to_string(&path)?;
        if content.trim().is_empty() {
            self.registry = HashMap::new();
            return Ok(());
        }

        let file: RegistryFile = serde_json::from_str(&content)?;
        self.registry = file.plugins;
        Ok(())
    }

    /// 写回 registry.json
    pub fn save_registry(&self) -> PluginResult<()> {
        std::fs::create_dir_all(&self.plugins_dir)?;
        let file = RegistryFile {
            plugins: self.registry.clone(),
        };
        let content = serde_json::to_string_pretty(&file)?;
        std::fs::write(self.registry_path(), content)?;
        Ok(())
    }

    /// 已安装插件对应的目录（<plugins_dir>/<id>/<version>）
    fn version_dir(&self, entry: &RegistryEntry) -> PathBuf {
        self.plugins_dir.join(&entry.id).join(&entry.version)
    }
}

// ============================================================
// 查询
// ============================================================

impl PluginManager {
    /// 列出所有已安装插件，按 displayName 排序
    pub fn list(&self) -> Vec<InstalledPlugin> {
        let mut items: Vec<InstalledPlugin> = self
            .registry
            .values()
            .filter_map(|entry| self.to_installed(entry).ok())
            .collect();

        items.sort_by(|a, b| {
            a.manifest
                .display_name
                .to_lowercase()
                .cmp(&b.manifest.display_name.to_lowercase())
        });
        items
    }

    /// 获取单个插件
    pub fn get(&self, id: &str) -> Option<InstalledPlugin> {
        self.registry
            .get(id)
            .and_then(|entry| self.to_installed(entry).ok())
    }

    /// 从注册表条目 + 磁盘上的 manifest.json 重建 InstalledPlugin
    fn to_installed(&self, entry: &RegistryEntry) -> PluginResult<InstalledPlugin> {
        let dir = self.version_dir(entry);

        let (manifest, loaded) = match read_manifest(&dir) {
            Ok(m) => (m, true),
            Err(e) => {
                log::warn!(
                    "插件 {} 的 manifest.json 无法读取（{}），使用兜底清单",
                    entry.id,
                    e
                );
                (PluginManifest::fallback(&entry.id, &entry.version), false)
            }
        };

        let status = if !loaded {
            PluginStatus::Error
        } else if entry.enabled {
            PluginStatus::Enabled
        } else {
            PluginStatus::Disabled
        };

        // 引擎范围每次都按**当前宿主版本**重新评估，而不是安装时算一次就落盘。
        // 这样应用升级后提示会自动更新，也不需要在 registry.json 里加字段
        // （那会引出旧注册表的兼容问题）。
        // 评估失败（范围语法非法）不阻断列表：这里只把提示置空，安装期已经报过。
        let engine_advisory = match validator::evaluate_engine(&manifest) {
            Ok(advisory) => advisory,
            Err(e) => {
                log::warn!("插件 {} 的引擎范围无法解析：{}", entry.id, e);
                None
            }
        };

        Ok(InstalledPlugin {
            id: entry.id.clone(),
            version: entry.version.clone(),
            path: dir.to_string_lossy().to_string(),
            has_style: has_style(&dir, &manifest),
            readme: read_readme(&dir),
            size_bytes: dir_size(&dir),
            manifest,
            enabled: entry.enabled,
            status,
            installed_at: entry.installed_at.clone(),
            source: entry.source.clone(),
            engine_advisory,
        })
    }

    /// 读取已安装插件的清单（权限检查用）
    fn manifest_of(&self, id: &str) -> PluginResult<PluginManifest> {
        let entry = self
            .registry
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
        read_manifest(&self.version_dir(entry))
    }

    /// 强制插件已声明某权限，未声明则拒绝。
    ///
    /// **这是权限检查的唯一入口。** 与 `plugin_data_dir` 的 ID 校验同理：
    /// 检查若散落在各个命令里，漏掉任何一处就等于没有防护 —— 而且漏掉的那处
    /// 不会有任何症状，直到有人真的去用它。
    ///
    /// `manifest_of` 对未安装的 ID 返回 `NotFound`，因此"未安装"与"未声明权限"
    /// 是两种可区分的错误，插件作者能据此判断到底缺了什么。
    pub fn require_permission(
        &self,
        id: &str,
        permission: PluginPermission,
    ) -> PluginResult<()> {
        let manifest = self.manifest_of(id)?;
        ensure_permission(&manifest, id, permission)
    }
}

// ============================================================
// 安装
// ============================================================

impl PluginManager {
    /// 从 .lcp（ZIP）包安装
    pub fn install_from_lcp(&mut self, path: &Path) -> PluginResult<InstalledPlugin> {
        if !path.is_file() {
            return Err(PluginError::NotFound(format!(
                "插件包不存在: {}",
                path.display()
            )));
        }

        std::fs::create_dir_all(self.staging_dir())?;
        let staging = self.staging_dir().join(uuid::Uuid::new_v4().to_string());

        let result = (|| -> PluginResult<InstalledPlugin> {
            std::fs::create_dir_all(&staging)?;
            extract_zip(path, &staging)?;
            self.install_from_root(&staging, "file")
        })();

        // 无论如何都清理暂存目录
        if staging.exists() {
            if let Err(e) = std::fs::remove_dir_all(&staging) {
                log::warn!("清理插件暂存目录失败 {}: {}", staging.display(), e);
            }
        }

        result
    }

    /// 从本地文件夹安装（递归复制，跳过符号链接）
    pub fn install_from_folder(&mut self, path: &Path) -> PluginResult<InstalledPlugin> {
        if !path.is_dir() {
            return Err(PluginError::NotFound(format!(
                "插件目录不存在: {}",
                path.display()
            )));
        }

        std::fs::create_dir_all(self.staging_dir())?;
        let staging = self.staging_dir().join(uuid::Uuid::new_v4().to_string());

        let result = (|| -> PluginResult<InstalledPlugin> {
            copy_tree(path, &staging)?;
            // 兜底补一份规范化清单，避免源目录清单缺少默认字段
            let manifest = read_manifest(&staging)?;
            let serialized = serde_json::to_string_pretty(&manifest)?;
            std::fs::write(staging.join("manifest.json"), serialized)?;
            self.install_from_root(&staging, "folder")
        })();

        if staging.exists() {
            if let Err(e) = std::fs::remove_dir_all(&staging) {
                log::warn!("清理插件暂存目录失败 {}: {}", staging.display(), e);
            }
        }

        result
    }

    /// 从 URL 下载 .lcp 后安装
    pub async fn install_from_url(&mut self, url: &str) -> PluginResult<InstalledPlugin> {
        if !is_http_url(url) {
            return Err(PluginError::InvalidPackage(format!(
                "只支持 http/https 协议: {}",
                url
            )));
        }

        let response = self.client.get(url).send().await?;
        if !response.status().is_success() {
            return Err(PluginError::DownloadFailed(format!(
                "HTTP {}",
                response.status()
            )));
        }

        let bytes = response.bytes().await?;
        if bytes.len() as u64 > MAX_PLUGIN_BYTES {
            return Err(PluginError::InvalidPackage(format!(
                "插件包体积 {} 字节超过上限 {} 字节",
                bytes.len(),
                MAX_PLUGIN_BYTES
            )));
        }

        std::fs::create_dir_all(self.staging_dir())?;
        let tmp = self
            .staging_dir()
            .join(format!("{}.lcp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, &bytes)?;

        let result = self.install_from_lcp(&tmp);
        let _ = std::fs::remove_file(&tmp);
        result
    }

    /// 校验暂存目录中的插件，然后移动到 <plugins_dir>/<id>/<version>/
    fn install_from_root(&mut self, root: &Path, source: &str) -> PluginResult<InstalledPlugin> {
        let manifest = read_manifest(root)?;
        validator::validate_manifest(&manifest, root)?;

        // validate_manifest 已经确保 main 是安全相对路径
        let main_path = root.join(&manifest.main);
        if !validator::is_within(root, &main_path) {
            return Err(PluginError::SandboxViolation(format!(
                "main 越出插件目录: {}",
                manifest.main
            )));
        }

        let size = dir_size(root);
        if size > MAX_PLUGIN_BYTES {
            return Err(PluginError::InvalidPackage(format!(
                "插件体积 {} 字节超过上限 {} 字节",
                size, MAX_PLUGIN_BYTES
            )));
        }

        let id = manifest.name.clone();
        let version = manifest.version.clone();
        let target = self.plugins_dir.join(&id).join(&version);

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // 同版本重装：先移除旧目录
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        // 同盘移动；失败（跨盘）时退化为复制
        if std::fs::rename(root, &target).is_err() {
            copy_tree(root, &target)?;
        }

        // 重新读一遍落盘后的清单，保证返回内容与磁盘一致
        let landed_manifest = read_manifest(&target)?;
        log::debug!(
            "插件 {} v{} 落盘清单入口: {}",
            id,
            version,
            landed_manifest.main
        );

        let entry = RegistryEntry {
            id: id.clone(),
            version: version.clone(),
            enabled: true,
            installed_at: chrono::Utc::now().to_rfc3339(),
            source: source.to_string(),
        };
        self.registry.insert(id.clone(), entry.clone());
        self.save_registry()?;

        log::info!("插件 {} v{} 安装完成（来源 {}）", id, version, source);
        self.to_installed(&entry)
    }
}

// ============================================================
// 启用 / 卸载
// ============================================================

impl PluginManager {
    /// 启用或禁用插件
    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> PluginResult<InstalledPlugin> {
        let entry = self
            .registry
            .get_mut(id)
            .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
        entry.enabled = enabled;
        let entry = entry.clone();
        self.save_registry()?;
        self.to_installed(&entry)
    }

    /// 卸载插件：删除插件目录、插件数据目录与注册表条目
    pub fn uninstall(&mut self, id: &str) -> PluginResult<()> {
        validate_plugin_id(id, "插件 ID")?;

        let plugin_dir = self.plugins_dir.join(id);
        if plugin_dir.exists() {
            // 双重防护：ID 已保证不含 `..`，这里再确认目标严格位于 plugins_dir
            // 之下（`is_within` 对 `candidate == root` 返回 false，因此
            // 指向 plugins_dir 自身的路径同样会被拒绝）。
            if !validator::is_within(&self.plugins_dir, &plugin_dir) {
                return Err(PluginError::SandboxViolation(format!(
                    "拒绝删除越界目录: {}",
                    id
                )));
            }
            std::fs::remove_dir_all(&plugin_dir)?;
        }

        let data_dir = self.plugin_data_dir(id)?;
        if data_dir.exists() {
            std::fs::remove_dir_all(&data_dir)?;
        }

        self.registry.remove(id);
        self.save_registry()?;

        log::info!("插件 {} 已卸载", id);
        Ok(())
    }
}

// ============================================================
// 读取资源 / 导出
// ============================================================

impl PluginManager {
    /// 读取插件目录内的文本资源
    pub fn read_asset(&self, id: &str, rel: &str) -> PluginResult<String> {
        let plugin = self
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
        let root = PathBuf::from(&plugin.path);

        let target = validator::resolve_within(&root, rel)?;

        if !target.is_file() {
            return Err(PluginError::NotFound(format!("资源不是文件: {}", rel)));
        }

        let metadata = std::fs::metadata(&target)?;
        if metadata.len() > MAX_ASSET_BYTES {
            return Err(PluginError::SandboxViolation(format!(
                "资源过大（{} 字节，上限 {} 字节）: {}",
                metadata.len(),
                MAX_ASSET_BYTES,
                rel
            )));
        }

        let bytes = std::fs::read(&target)?;
        String::from_utf8(bytes).map_err(|_| {
            PluginError::InvalidPackage(format!("资源不是合法的 UTF-8 文本: {}", rel))
        })
    }

    /// 导出插件为 .lcp（ZIP）包
    pub async fn export(
        &self,
        id: &str,
        dest: Option<PathBuf>,
    ) -> PluginResult<ExportOutcome> {
        let plugin = self
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
        let root = PathBuf::from(&plugin.path);
        if !root.is_dir() {
            return Err(PluginError::NotFound(format!(
                "插件目录不存在: {}",
                plugin.path
            )));
        }

        let target = match dest {
            Some(path) => normalize_export_path(path),
            None => {
                let suggested = format!("{}-{}.lcp", plugin.id, plugin.version);
                let app = self.app.clone();
                let picked = tauri::async_runtime::spawn_blocking(move || {
                    app.dialog()
                        .file()
                        .set_file_name(suggested)
                        .add_filter("Modulith Plugin", &["lcp"])
                        .blocking_save_file()
                })
                .await
                .map_err(|e| PluginError::DialogUnavailable(e.to_string()))?;

                match picked.map(file_path_to_path).transpose()? {
                    Some(path) => path,
                    // 用户取消：不是错误
                    None => return Ok(ExportOutcome::cancelled()),
                }
            }
        };

        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }

        let bytes = write_plugin_zip(&root, &target)?;
        Ok(ExportOutcome::exported(
            target.to_string_lossy().to_string(),
            bytes,
        ))
    }

    /// 弹出原生文件选择框选取 .lcp / .zip 包
    pub async fn pick_package(&self) -> PluginResult<Option<String>> {
        let app = self.app.clone();
        let picked = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .add_filter("Modulith Plugin", &["lcp", "zip"])
                .blocking_pick_file()
        })
        .await
        .map_err(|e| PluginError::DialogUnavailable(e.to_string()))?;

        match picked.map(file_path_to_path).transpose()? {
            Some(path) => Ok(Some(path.to_string_lossy().to_string())),
            None => Ok(None),
        }
    }

    /// 弹出原生目录选择框
    pub async fn pick_folder(&self) -> PluginResult<Option<String>> {
        let app = self.app.clone();
        let picked = tauri::async_runtime::spawn_blocking(move || {
            app.dialog().file().blocking_pick_folder()
        })
        .await
        .map_err(|e| PluginError::DialogUnavailable(e.to_string()))?;

        match picked.map(file_path_to_path).transpose()? {
            Some(path) => Ok(Some(path.to_string_lossy().to_string())),
            None => Ok(None),
        }
    }

    /// 默认导出目录：下载目录优先，否则回退到应用数据目录
    pub fn default_export_dir(&self) -> PluginResult<String> {
        if let Ok(dir) = self.app.path().download_dir() {
            if dir.is_dir() || std::fs::create_dir_all(&dir).is_ok() {
                return Ok(dir.to_string_lossy().to_string());
            }
        }

        let fallback = self
            .app
            .path()
            .app_data_dir()
            .map_err(|e| PluginError::NotFound(format!("无法解析应用数据目录: {}", e)))?;
        Ok(fallback.to_string_lossy().to_string())
    }
}

// ============================================================
// 键值存储
// ============================================================

impl PluginManager {
    /// 取该插件的存储目录，并强制 `storage` 权限。
    ///
    /// 五个存储方法（`storage_get` / `set` / `delete` / `keys` / `clear`）全都
    /// 经由这里取目录 —— 前三个走 `storage_path`，后两个直接调用本方法 ——
    /// 因此 `storage` 权限检查只有这一个执行点。
    ///
    /// 与 `plugin_data_dir` 的分工：那个只保证「ID 合法」，这个额外要求
    /// 「清单已声明 storage」。卸载等内部流程仍直接使用 `plugin_data_dir`，
    /// 它们不该受插件的权限声明约束。
    fn checked_storage_dir(&self, id: &str) -> PluginResult<PathBuf> {
        self.require_permission(id, PluginPermission::Storage)?;
        self.plugin_data_dir(id)
    }

    /// 校验存储 key
    fn storage_path(&self, id: &str, key: &str) -> PluginResult<PathBuf> {
        if !is_valid_storage_key(key) {
            return Err(PluginError::SandboxViolation(format!(
                "非法的存储键（只允许字母数字 . _ -，最长 128 字符）: {}",
                key
            )));
        }
        Ok(self.checked_storage_dir(id)?.join(format!("{}.json", key)))
    }

    pub fn storage_get(&self, id: &str, key: &str) -> PluginResult<Option<String>> {
        let path = self.storage_path(id, key)?;
        if !path.is_file() {
            return Ok(None);
        }
        Ok(Some(std::fs::read_to_string(path)?))
    }

    pub fn storage_set(&self, id: &str, key: &str, value: &str) -> PluginResult<()> {
        let path = self.storage_path(id, key)?;
        // 必须先是合法 JSON
        let parsed: serde_json::Value = serde_json::from_str(value)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(&parsed)?)?;
        Ok(())
    }

    pub fn storage_delete(&self, id: &str, key: &str) -> PluginResult<()> {
        let path = self.storage_path(id, key)?;
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        Ok(())
    }

    pub fn storage_keys(&self, id: &str) -> PluginResult<Vec<String>> {
        let dir = self.checked_storage_dir(id)?;
        if !dir.is_dir() {
            return Ok(Vec::new());
        }

        let mut keys: Vec<String> = std::fs::read_dir(&dir)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_file())
            .filter_map(|entry| {
                entry
                    .path()
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().to_string())
            })
            .collect();
        keys.sort();
        Ok(keys)
    }

    /// 清空插件数据目录。
    ///
    /// **这里曾经完全缺少 ID 守卫**（`data_dir.join(id)` 直接用未校验的 `id`），
    /// `id = ".."` 会让目标解析为应用数据目录本身而被整个删除 —— 连
    /// settings.json / auth.json / notifications.json 一起消失。现在 ID 校验
    /// 收在 `plugin_data_dir` 里，本方法只需保证「只删该插件自己的数据目录」。
    pub fn storage_clear(&self, id: &str) -> PluginResult<()> {
        let dir = self.checked_storage_dir(id)?;
        if !dir.is_dir() {
            return Ok(());
        }
        // 不变量：目标必须是 data_dir 之下的一个条目，且不能是 data_dir 本身
        if !validator::is_within(&self.data_dir, &dir) {
            return Err(PluginError::SandboxViolation(format!(
                "拒绝清空越界目录: {}",
                id
            )));
        }
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }
}

// ============================================================
// 启动外部程序
// ============================================================

impl PluginManager {
    /// 启动一个外部程序（受 `process-spawn` 权限约束）。
    ///
    /// **这是整个插件系统里最强的一项能力**：它让插件能运行任意本机程序，
    /// 因此也是清单里最该被用户看见的一条。权限检查不可省，且必须落在本函数 ——
    /// 前端 `ctx.launcher` 只是入口，真正的门在这里。
    ///
    /// 采用「启动后不等待」：快捷启动的语义就是「把它叫起来」，宿主没有理由
    /// 陪着子进程一起活着。`Child` 丢弃后子进程继续运行（Windows 上不会产生
    /// 僵尸进程）。
    pub fn launch_program(&self, id: &str, program: &str, args: &[String]) -> PluginResult<()> {
        self.require_permission(id, PluginPermission::ProcessSpawn)?;

        let target = resolve_file_argument(program)?;
        validate_launch_args(args)?;

        let mut command = std::process::Command::new(&target);
        command.args(args);

        let child = command.spawn().map_err(|e| {
            PluginError::IoError(std::io::Error::new(
                e.kind(),
                format!("启动失败 {}: {}", target.display(), e),
            ))
        })?;

        log::info!(
            "插件 {} 启动了 {}（PID {}）",
            id,
            target.display(),
            child.id()
        );
        Ok(())
    }
}

// ============================================================
// 图标提取 / 在文件管理器中定位
// ============================================================

impl PluginManager {
    /// 提取一个文件的图标，返回 `data:image/png;base64,...`。
    ///
    /// 需要 `filesystem-read` 权限 —— 它按路径读取本机文件，与「读文件内容」
    /// 同属一类：插件据此可以判断某个路径上存不存在、是什么类型的文件。
    ///
    /// 提取本身在 `icon` 模块里完成（Windows 上走 Shell + GDI）。
    pub fn extract_icon(&self, id: &str, path: &str) -> PluginResult<String> {
        self.require_permission(id, PluginPermission::FilesystemRead)?;
        // 图标只对文件有意义，目录与不存在的路径都在这里被挡掉
        let target = resolve_file_argument(path)?;
        icon::extract_icon_data_url(&target)
    }

    /// 在系统文件管理器中定位一个文件或目录（Windows 上是「在资源管理器中显示」）。
    ///
    /// 同样需要 `filesystem-read`。注意它**不打开文件本身**，只是把文件管理器
    /// 打开到该路径并选中它 —— 因此没有「借插件之手执行文件」的风险。
    pub fn reveal_in_folder(&self, id: &str, path: &str) -> PluginResult<()> {
        self.require_permission(id, PluginPermission::FilesystemRead)?;
        // 与图标不同，这里允许目录
        let target = resolve_existing_path(path)?;

        tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| {
            PluginError::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("无法在文件管理器中定位 {}: {}", target.display(), e),
            ))
        })
    }
}

// ============================================================
// HTTP 代理
// ============================================================

impl PluginManager {
    /// 代插件发起 HTTP 请求（受权限约束）
    pub async fn http_request(
        &self,
        id: &str,
        method: &str,
        url: &str,
        headers: Option<HashMap<String, String>>,
        body: Option<String>,
    ) -> PluginResult<HttpResponse> {
        let method = method.trim().to_ascii_uppercase();
        if !matches!(
            method.as_str(),
            "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD"
        ) {
            return Err(PluginError::PermissionDenied(format!(
                "不支持的 HTTP 方法: {}",
                method
            )));
        }

        if !is_http_url(url) {
            return Err(PluginError::PermissionDenied(format!(
                "只允许 http/https 请求: {}",
                url
            )));
        }

        let parsed = reqwest::Url::parse(url)
            .map_err(|e| PluginError::NetworkError(format!("URL 非法: {}", e)))?;

        let manifest = self.manifest_of(id)?;
        if !manifest.permissions.contains(&PluginPermission::Network) {
            return Err(PluginError::PermissionDenied(format!(
                "插件 {} 缺少 network 权限",
                id
            )));
        }

        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        let loopback = is_loopback_host(&host);
        if !loopback && !manifest.permissions.contains(&PluginPermission::NetworkExternal) {
            return Err(PluginError::PermissionDenied(format!(
                "访问外部主机 {} 需要 network-external 权限",
                host
            )));
        }

        let mut request = self
            .client
            .request(
                reqwest::Method::from_bytes(method.as_bytes())
                    .map_err(|e| PluginError::NetworkError(e.to_string()))?,
                parsed,
            )
            .timeout(std::time::Duration::from_secs(30));

        if let Some(headers) = headers {
            for (name, value) in headers {
                let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|e| PluginError::NetworkError(format!("非法请求头 {}: {}", name, e)))?;
                let header_value = reqwest::header::HeaderValue::from_str(&value).map_err(|e| {
                    PluginError::NetworkError(format!("非法请求头取值 {}: {}", name, e))
                })?;
                request = request.header(header_name, header_value);
            }
        }

        if let Some(body) = body {
            request = request.body(body);
        }

        let response = request.send().await?;
        let status = response.status().as_u16();

        let mut response_headers: HashMap<String, String> = HashMap::new();
        for (name, value) in response.headers().iter() {
            let value = value
                .to_str()
                .map(|v| v.to_string())
                .unwrap_or_else(|_| String::from_utf8_lossy(value.as_bytes()).to_string());
            response_headers.insert(name.as_str().to_string(), value);
        }

        if let Some(len) = response.content_length() {
            if len > MAX_HTTP_BODY_BYTES {
                return Err(PluginError::SandboxViolation(format!(
                    "响应体过大（Content-Length {} 字节，上限 {} 字节）",
                    len, MAX_HTTP_BODY_BYTES
                )));
            }
        }

        let bytes = response.bytes().await?;
        if bytes.len() as u64 > MAX_HTTP_BODY_BYTES {
            return Err(PluginError::SandboxViolation(format!(
                "响应体过大（{} 字节，上限 {} 字节）",
                bytes.len(),
                MAX_HTTP_BODY_BYTES
            )));
        }

        let body = String::from_utf8(bytes.to_vec()).map_err(|_| {
            PluginError::InvalidPackage("响应体不是合法的 UTF-8 文本".to_string())
        })?;

        Ok(HttpResponse {
            status,
            headers: response_headers,
            body,
        })
    }
}

// ============================================================
// 辅助函数
// ============================================================

/// 读取并规范化插件根目录下的 manifest.json
fn read_manifest(root: &Path) -> PluginResult<PluginManifest> {
    let path = root.join("manifest.json");
    if !path.is_file() {
        return Err(PluginError::InvalidManifest(format!(
            "缺少 manifest.json: {}",
            root.display()
        )));
    }

    let content = std::fs::read_to_string(&path)?;
    let mut manifest: PluginManifest = serde_json::from_str(&content)
        .map_err(|e| PluginError::InvalidManifest(format!("manifest.json 解析失败: {}", e)))?;
    manifest.normalize();
    Ok(manifest)
}

fn is_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

fn is_valid_storage_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    bytes.iter().all(|b| {
        let c = *b as char;
        c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
    })
}

/// 目录递归大小，出错时按 0 计
fn dir_size(path: &Path) -> u64 {
    let mut total: u64 = 0;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total = total.saturating_add(dir_size(&entry.path()));
        } else if let Ok(metadata) = entry.metadata() {
            total = total.saturating_add(metadata.len());
        }
    }

    total
}

/// README.md（大小写不敏感）内容，最多 64 KB
fn read_readme(root: &Path) -> Option<String> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.path().is_file() {
            continue;
        }
        if entry.file_name().to_string_lossy().to_lowercase() == "readme.md" {
            let mut file = std::fs::File::open(entry.path()).ok()?;
            let mut buffer = Vec::new();
            let mut limited = (&mut file).take(MAX_README_BYTES);
            limited.read_to_end(&mut buffer).ok()?;
            return Some(String::from_utf8_lossy(&buffer).to_string());
        }
    }
    None
}

/// manifest.style 已声明且文件存在
fn has_style(root: &Path, manifest: &PluginManifest) -> bool {
    match manifest.style.as_deref() {
        Some(style) if !style.is_empty() => root.join(style).is_file(),
        _ => false,
    }
}

/// 递归复制目录树（跳过符号链接）
fn copy_tree(src: &Path, dest: &Path) -> PluginResult<()> {
    std::fs::create_dir_all(dest)?;

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            log::warn!("跳过符号链接: {}", entry.path().display());
            continue;
        }

        let target = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }

    Ok(())
}

/// 解压 .lcp（ZIP）：强制 zip-slip 防护、体积与条目数上限
fn extract_zip(zip_path: &Path, dest: &Path) -> PluginResult<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(PluginError::InvalidPackage(format!(
            "压缩包条目数 {} 超过上限 {}",
            archive.len(),
            MAX_ZIP_ENTRIES
        )));
    }

    let dest_root = dest
        .canonicalize()
        .map_err(|e| PluginError::ExtractionFailed(e.to_string()))?;

    let mut total: u64 = 0;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let raw_name = entry.name().to_string();

        // 1) 拒绝绝对路径与任何 `..` 组件
        if raw_name.starts_with('/')
            || raw_name.starts_with('\\')
            || raw_name.contains(':')
            || Path::new(&raw_name).is_absolute()
        {
            return Err(PluginError::SandboxViolation(format!(
                "压缩包包含绝对路径: {}",
                raw_name
            )));
        }
        if Path::new(&raw_name)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
            || raw_name.split(['/', '\\']).any(|part| part == "..")
        {
            return Err(PluginError::SandboxViolation(format!(
                "压缩包包含越界路径: {}",
                raw_name
            )));
        }

        // 2) 体积上限（条目声明值）
        total = total.saturating_add(entry.size());
        if total > MAX_PLUGIN_BYTES {
            return Err(PluginError::InvalidPackage(format!(
                "压缩包解压后体积超过上限 {} 字节",
                MAX_PLUGIN_BYTES
            )));
        }

        // 3) 计算目标路径；父目录创建后用「双方都已规范化」的路径做包含性检查。
        //    注意：不能拿 canonicalize() 的结果去和未规范化的 join() 结果比较 ——
        //    Windows 上 canonicalize() 会加上 `\\?\`（verbatim）前缀，前缀组件不同
        //    会让 starts_with() 永远为 false，从而把正常条目误判成越界。
        let out_path = dest.join(&raw_name);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            ensure_within(&dest_root, &out_path)?;
            continue;
        }

        let parent = out_path.parent().ok_or_else(|| {
            PluginError::SandboxViolation(format!("非法的压缩包条目路径: {}", raw_name))
        })?;
        std::fs::create_dir_all(parent)?;
        // 待写入的文件此刻还不存在，无法 canonicalize，因此校验其父目录
        ensure_within(&dest_root, parent)?;

        // 逐块写入并二次累计真实字节数，避免条目声明值与实际不符
        let mut out_file = std::fs::File::create(&out_path)?;
        let mut buffer = [0u8; 32 * 1024];
        let mut written: u64 = 0;
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            written = written.saturating_add(read as u64);
            if written > MAX_PLUGIN_BYTES {
                return Err(PluginError::InvalidPackage(format!(
                    "压缩包条目过大: {}",
                    raw_name
                )));
            }
            out_file.write_all(&buffer[..read])?;
        }
    }

    Ok(())
}

/// 把插件目录打包为 .lcp（manifest.json 位于压缩包根）
fn write_plugin_zip(root: &Path, dest: &Path) -> PluginResult<u64> {
    let file = std::fs::File::create(dest)?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];

    while let Some((dir, prefix)) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let archive_name = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", prefix, name)
            };

            if file_type.is_dir() {
                stack.push((entry.path(), archive_name));
            } else {
                zip.start_file(archive_name, options)?;
                let mut input = std::fs::File::open(entry.path())?;
                std::io::copy(&mut input, &mut zip)?;
            }
        }
    }

    zip.finish()?;
    Ok(std::fs::metadata(dest)?.len())
}

/// 规范化导出目标路径
fn normalize_export_path(path: PathBuf) -> PathBuf {
    if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
        if let Ok(canonical_parent) = parent.canonicalize() {
            return canonical_parent.join(file_name);
        }
    }
    path
}

/// 把对话框返回的 FilePath 统一成 PathBuf
fn file_path_to_path(path: FilePath) -> PluginResult<PathBuf> {
    match path {
        FilePath::Path(buf) => Ok(buf),
        FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| PluginError::NotFound("对话框返回了非文件 URL".to_string())),
    }
}

/// 校验 `path` 规范化之后仍位于 `root_canon` 之内。
///
/// `root_canon` 必须是一个**已经规范化过**的路径，并且 `path` 必须**已经存在**
/// （否则无法规范化）。两侧都是规范化路径时 `starts_with` 才可靠 ——
/// Windows 上 `canonicalize()` 会返回带 `\\?\` 前缀的 verbatim 路径，
/// 拿它和未规范化的路径比较会因前缀组件不同而永远为 false。
fn ensure_within(root_canon: &Path, path: &Path) -> PluginResult<()> {
    let canon = path
        .canonicalize()
        .map_err(|e| PluginError::ExtractionFailed(e.to_string()))?;

    if !canon.starts_with(root_canon) {
        return Err(PluginError::SandboxViolation(format!(
            "压缩包条目逃出目标目录: {}",
            path.display()
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "modulith-plugin-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn build_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for (name, content) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }

        zip.finish().unwrap();
    }

    /// 回归测试：带子目录的条目必须能正常解压。
    ///
    /// 修复前，`extract_zip` 拿 `dest.canonicalize()`（Windows 上带 `\\?\` 前缀）
    /// 与未规范化的 `dest.join(name)` 做 `starts_with`，恒为 false，
    /// 于是任何嵌套条目都会被误报成「逃出目标目录」。
    #[test]
    fn extracts_nested_entries() {
        let root = temp_dir("nested");
        let zip_path = root.join("pkg.lcp");
        let dest = root.join("out");
        std::fs::create_dir_all(&dest).unwrap();

        build_zip(
            &zip_path,
            &[
                ("dist/index.css", "body{}"),
                ("dist/nested/index.js", "console.log(1)"),
                ("manifest.json", "{}"),
            ],
        );

        extract_zip(&zip_path, &dest).expect("带子目录的条目应当正常解压");

        assert_eq!(
            std::fs::read_to_string(dest.join("dist/index.css")).unwrap(),
            "body{}"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("dist/nested/index.js")).unwrap(),
            "console.log(1)"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("manifest.json")).unwrap(),
            "{}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 防护未被削弱：含 `..` 的条目仍必须被拒绝，且不会落盘到目标目录之外
    #[test]
    fn rejects_parent_dir_entries() {
        let root = temp_dir("escape");
        let zip_path = root.join("evil.lcp");
        let dest = root.join("out");
        std::fs::create_dir_all(&dest).unwrap();

        build_zip(&zip_path, &[("../evil.txt", "pwned")]);

        let err = extract_zip(&zip_path, &dest).expect_err("越界条目必须被拒绝");
        assert!(
            matches!(err, PluginError::SandboxViolation(_)),
            "期望 SandboxViolation，实际: {:?}",
            err
        );
        assert!(!root.join("evil.txt").exists(), "越界文件不得被写出");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 绝对路径条目同样必须被拒绝
    #[test]
    fn rejects_absolute_entries() {
        let root = temp_dir("absolute");
        let zip_path = root.join("evil2.lcp");
        let dest = root.join("out");
        std::fs::create_dir_all(&dest).unwrap();

        build_zip(&zip_path, &[("/etc/passwd", "pwned")]);

        let err = extract_zip(&zip_path, &dest).expect_err("绝对路径条目必须被拒绝");
        assert!(
            matches!(err, PluginError::SandboxViolation(_)),
            "期望 SandboxViolation，实际: {:?}",
            err
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 用仓库里真实的示例插件包做一次完整解压校验。
    ///
    /// 这是对「导入 .lcp 报条目逃出目标目录」那个 bug 最直接的回归测试：
    /// 示例包内含有 `dist/index.css` 这样的嵌套条目，修复前必然失败。
    #[test]
    fn extracts_real_sample_lcp() {
        let sample = PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../samples/hello-plugin.lcp"
        ));
        if !sample.exists() {
            eprintln!("跳过：示例插件包不存在: {}", sample.display());
            return;
        }

        let dest = temp_dir("sample");
        extract_zip(&sample, &dest).expect("示例 .lcp 应当可以正常解压");

        assert!(
            dest.join("manifest.json").exists(),
            "manifest.json 必须位于压缩包根目录"
        );
        assert!(dest.join("dist/index.js").exists(), "缺少入口 bundle");
        assert!(dest.join("dist/index.css").exists(), "缺少样式文件");
        assert!(dest.join("icon.svg").exists(), "缺少图标文件");

        let manifest = std::fs::read_to_string(dest.join("manifest.json")).unwrap();
        assert!(
            manifest.contains("com.modulith.sample.notes"),
            "清单内容不符合预期"
        );

        let _ = std::fs::remove_dir_all(&dest);
    }

    // ============================================================
    // 权限强制
    // ============================================================

    /// 构造最小合法清单，绕过文件 IO。
    ///
    /// 之所以能用这种方式测：权限判定被抽成了纯函数 `ensure_permission`，
    /// 而 `PluginManager` 持有 `AppHandle`，单测里根本造不出来。
    fn manifest_with(permissions: &[&str]) -> PluginManifest {
        let perms = serde_json::to_string(permissions).unwrap();
        serde_json::from_str(&format!(
            r#"{{"name":"com.test.plugin","version":"1.0.0","permissions":{}}}"#,
            perms
        ))
        .expect("最小清单应当能解析")
    }

    /// 未声明 `storage` 时必须拒绝。
    ///
    /// 这是本次修复的核心行为：修复前 `plugin_storage_*` 五个命令没有任何
    /// 权限检查，无论插件声明什么都照常读写。
    #[test]
    fn storage_is_denied_without_declaration() {
        let manifest = manifest_with(&[]);
        let err = ensure_permission(&manifest, "com.test.plugin", PluginPermission::Storage)
            .expect_err("未声明 storage 时必须拒绝");

        assert!(
            matches!(err, PluginError::PermissionDenied(_)),
            "期望 PermissionDenied，实际: {:?}",
            err
        );
    }

    /// 声明了就放行 —— 否则等于把所有插件一起堵死
    #[test]
    fn storage_is_allowed_when_declared() {
        let manifest = manifest_with(&["storage"]);
        ensure_permission(&manifest, "com.test.plugin", PluginPermission::Storage)
            .expect("已声明 storage 时应当放行");
    }

    /// 权限必须逐项判定，而不是「有任意一条就全放行」。
    ///
    /// 专门用来防止把检查写成 `!permissions.is_empty()` 这类写法 ——
    /// 那种写法在单权限插件的测试里会全部通过，却让权限列表形同虚设。
    #[test]
    fn declaring_one_permission_does_not_grant_another() {
        let manifest = manifest_with(&["network"]);
        let err = ensure_permission(&manifest, "com.test.plugin", PluginPermission::Storage)
            .expect_err("只声明 network 不应放行 storage");
        assert!(matches!(err, PluginError::PermissionDenied(_)));
    }

    /// 错误信息必须写出权限的 kebab-case 名，作者才知道清单里该补什么。
    #[test]
    fn permission_error_names_the_exact_permission() {
        let manifest = manifest_with(&[]);
        let err = ensure_permission(&manifest, "com.test.plugin", PluginPermission::Storage)
            .expect_err("应当拒绝");
        assert!(
            err.to_string().contains("storage"),
            "错误信息里应出现 storage，实际: {}",
            err
        );
    }

    /// `as_str()` 与 serde 的 kebab-case 序列化必须逐字一致。
    ///
    /// 两者一旦分叉，错误信息就会指向一个清单里根本写不出来的名字。
    /// 注意 `as_str` 的 `match` 由编译器强制穷尽（新增枚举值必然要改它），
    /// 但 `ALL` 不会 —— 所以新增取值时要记得同时加进 `ALL`，否则本测试
    /// 覆盖不到新值。
    #[test]
    fn permission_name_matches_serde() {
        for permission in PluginPermission::ALL {
            let serialized = serde_json::to_string(&permission).unwrap();
            assert_eq!(
                permission.as_str(),
                serialized.trim_matches('"'),
                "as_str() 与 serde 序列化不一致: {:?}",
                permission
            );
        }
    }

    // ============================================================
    // 启动外部程序
    // ============================================================

    #[test]
    fn launching_requires_process_spawn_permission() {
        let manifest = manifest_with(&["network"]);
        let err = ensure_permission(&manifest, "com.test.plugin", PluginPermission::ProcessSpawn)
            .expect_err("未声明 process-spawn 必须拒绝");
        assert!(matches!(err, PluginError::PermissionDenied(_)));
    }

    #[test]
    fn process_spawn_is_allowed_when_declared() {
        let manifest = manifest_with(&["process-spawn"]);
        ensure_permission(&manifest, "com.test.plugin", PluginPermission::ProcessSpawn)
            .expect("已声明 process-spawn 时应当放行");
    }

    /// 相对路径与纯程序名必须被拒绝。
    ///
    /// 这是本命令最主要的一道限制：它挡掉的是「靠 PATH 解析出 cmd / powershell」
    /// 这类写法，迫使插件写出一条真实存在的绝对路径，让行为在代码里看得见。
    /// （它拦不住 `C:\Windows\System32\cmd.exe` —— 插件本就被视为本机程序，
    /// 这里追求的是显式，而非沙箱。）
    #[test]
    fn launch_rejects_relative_program_names() {
        for name in [
            "cmd",
            "cmd.exe",
            "./local.exe",
            "sub/dir/app.exe",
            "sub\\dir\\app.exe",
        ] {
            let err = match resolve_file_argument(name) {
                Ok(path) => {
                    panic!("裸程序名必须被拒绝: {}（却解析为 {}）", name, path.display())
                }
                Err(e) => e,
            };
            assert!(
                matches!(err, PluginError::SandboxViolation(_)),
                "{} 期望 SandboxViolation，实际: {:?}",
                name,
                err
            );
        }
    }

    #[test]
    fn launch_rejects_empty_and_nul() {
        assert!(resolve_file_argument("").is_err());
        assert!(resolve_file_argument("   ").is_err());
        assert!(resolve_file_argument("C:\\a\u{0}b.exe").is_err());
    }

    #[test]
    fn launch_rejects_nonexistent_path() {
        let missing = if cfg!(windows) {
            "C:\\definitely-not-here-modulith\\nope.exe"
        } else {
            "/definitely-not-here-modulith/nope"
        };
        let err = resolve_file_argument(missing).expect_err("不存在的路径必须被拒绝");
        assert!(matches!(err, PluginError::NotFound(_)), "实际: {:?}", err);
    }

    /// 目录不能当程序启动
    #[test]
    fn launch_rejects_directory() {
        let dir = std::env::temp_dir();
        let err = resolve_file_argument(&dir.to_string_lossy())
            .expect_err("目录必须被拒绝");
        assert!(matches!(err, PluginError::NotFound(_)), "实际: {:?}", err);
    }

    /// 本测试进程自身的可执行文件满足「绝对 + 存在 + 是文件」，应当通过
    #[test]
    fn launch_accepts_existing_absolute_file() {
        let exe = std::env::current_exe().expect("应能取得当前进程路径");
        let resolved =
            resolve_file_argument(&exe.to_string_lossy()).expect("真实存在的绝对路径应当通过");
        assert!(resolved.is_file());
    }

    #[test]
    fn launch_args_are_bounded() {
        let at_limit = vec!["a".to_string(); MAX_LAUNCH_ARGS];
        validate_launch_args(&at_limit).expect("刚好到上限应当通过");

        let too_many = vec!["a".to_string(); MAX_LAUNCH_ARGS + 1];
        assert!(validate_launch_args(&too_many).is_err(), "超量参数必须被拒绝");

        let too_long = vec!["x".repeat(MAX_LAUNCH_ARG_LEN + 1)];
        assert!(validate_launch_args(&too_long).is_err(), "超长参数必须被拒绝");

        assert!(
            validate_launch_args(&["a\u{0}b".to_string()]).is_err(),
            "含 NUL 的参数必须被拒绝"
        );
    }

    /// 示例插件 quick-launch 的清单必须能通过校验，且声明了它实际用到的两项权限。
    ///
    /// 这条测试的意义在于：清单里的 `permissions` 现在真的会被强制，因此
    /// 「代码用了 ctx.storage / ctx.launcher，清单却忘了声明」会变成一个
    /// **运行时才暴露**的错误。把它提前到测试里，改示例时不会漏。
    #[test]
    fn quick_launch_sample_manifest_is_valid() {
        let root = PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../samples/quick-launch"
        ));
        if !root.exists() {
            eprintln!("跳过：示例插件目录不存在: {}", root.display());
            return;
        }

        let text = std::fs::read_to_string(root.join("manifest.json")).expect("应能读取清单");
        let manifest: PluginManifest = serde_json::from_str(&text).expect("清单应当能解析");

        // 入口与图标都真实存在 —— validate_manifest 会检查 main
        validator::validate_manifest(&manifest, &root).expect("示例清单应当通过校验");

        for required in [
            PluginPermission::Storage,
            PluginPermission::ProcessSpawn,
            PluginPermission::FilesystemRead,
        ] {
            assert!(
                manifest.permissions.contains(&required),
                "示例插件用到了 {}，清单必须声明它",
                required.as_str()
            );
        }
    }
}
