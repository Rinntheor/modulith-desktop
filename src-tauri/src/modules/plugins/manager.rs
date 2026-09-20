// src-tauri/src/modules/plugins/manager.rs
// 运行时插件管理器：安装 / 启用 / 卸载 / 导出 / 存储 / HTTP 代理

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

use super::icon;
use super::types::{
    ExportOutcome, HttpResponse, InstalledPlugin, PickedAudio, PluginError, PluginManifest,
    PluginPermission, PluginResult, PluginStatus, RegistryEntry, RegistryFile,
};
use super::validator;
use crate::modules::net::client::{NetClient, NetError, NetOrigin};
use crate::modules::net::is_loopback_host;
use crate::modules::settings::{network, settings as settings_store};

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
/// 从插件仓库拉取的单个文本文件允许的最大体积（1 MB）
///
/// 索引正常只有几 KB，README 通常几十 KB。上限的意义是**不把一个来路不明的巨大响应
/// 读进内存**，并让"地址填错指向了一个大文件"这种情况立刻失败而不是先卡住。
const MAX_REGISTRY_TEXT_BYTES: u64 = 1024 * 1024;

/// 允许从中拉取插件仓库内容的宿主。
///
/// **这是一个安全白名单，不是便利性检查。** 它守护的命令能"取回任意文本"，而插件与宿主
/// 运行在同一个 JavaScript 上下文里，能够触达 IPC 桥 —— 这正是「声明式权限拦不住恶意
/// 插件」那条已知限制的体现（见 docs/02-开发指南/插件开发/插件系统架构.md 第 6.3 节）。
/// 若这里不限制宿主，一个**没有声明 `network-external`** 的插件就能借这条命令发出任意
/// 外部请求，把权限模型整个绕过去。
///
/// 限定之后，可触达的范围只剩公开的插件仓库内容。
///
/// 与 `src/config/pluginRegistry.ts` 里的 CDN 模板是一对：那边决定"去哪里取"，这边决定
/// "允许去哪里取"。两者都必须改，因此这里显式记下对方的位置。前端不能把宿主当参数传进来
/// —— 那等于让被约束的一方自己划定边界。
///
/// **用户配置的下载源不出现在这张表里，而且不需要出现。** 代理是在校验**之后**
/// 由 `network::rewrite_url` 拼到原始地址前面的（见 [`PluginManager::fetch_via_sources`]），
/// 因此这里校验的始终是我们自己写死的原始宿主。反过来说：一个被改坏的代理字段
/// 也不能让这条命令去访问一个原本不被允许的宿主。
pub(crate) const ALLOWED_REGISTRY_HOSTS: [&str; 2] = ["cdn.jsdelivr.net", "raw.githubusercontent.com"];
/// 启动外部程序允许的最大参数个数
const MAX_LAUNCH_ARGS: usize = 64;
/// 单个启动参数的最大字符数
const MAX_LAUNCH_ARG_LEN: usize = 4096;
/// 允许插件导入的音频扩展名（对话框过滤器与校验共用同一份，避免两者漂移）
const AUDIO_EXTENSIONS: [&str; 8] = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "webm"];
/// 单个音频文件的大小上限（2 MB）
///
/// 提示音通常只有几十 KB，2 MB 留了足够余量；上限的意义在于**不把一个几百 MB
/// 的文件读进内存再编码成 base64 塞进插件存储** —— 那会一次性吃掉几十 MB。
const MAX_AUDIO_BYTES: u64 = 2 * 1024 * 1024;

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

/// 计算内容的 SHA-256，返回小写十六进制。
fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

/// 校验下载内容与索引记录的 SHA-256 是否一致。
///
/// 抽成纯函数是为了可测 —— `PluginManager` 持有 `AppHandle`，单测里造不出来。
///
/// 三点是刻意的：
///
/// 1. **先校验格式，再比对内容。** 索引里写一个残缺的哈希（比如少几位）时，直接比对
///    只会得到"不符"，而那与"内容被篡改"共用一条错误信息 —— 排查方向会完全跑偏。
/// 2. **大小写不敏感。** 十六进制有大小写两种写法：`Get-FileHash` 给大写、`shasum`
///    给小写。为这个拒绝安装是纯粹的折磨。
/// 3. **失败即拒绝，不提供"仍然安装"。** 哈希不符意味着下载链路或索引有问题，此时
///    唯一安全的动作是不装。
fn verify_sha256(bytes: &[u8], expected: &str) -> PluginResult<()> {
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(PluginError::InvalidPackage(format!(
            "索引里的 sha256 格式非法（需要 64 位十六进制）：{}",
            expected
        )));
    }

    let actual = hex_sha256(bytes);
    if actual != expected {
        return Err(PluginError::DownloadFailed(format!(
            "下载内容与索引记录的哈希不符（索引 {}，实际 {}）：文件可能下载不完整或已被篡改，已拒绝安装",
            expected, actual
        )));
    }
    Ok(())
}

/// 插件仓库内容的地址策略：必须是白名单宿主 + https；本机回环地址可用 http。
///
/// 两条规则各自的理由：
///
/// - **宿主白名单**见 `ALLOWED_REGISTRY_HOSTS` —— 防止这条命令变成绕过 `network-external`
///   权限的任意 GET。
/// - **https** 是硬性要求。索引**自 1.1.0 起有 minisign 签名**（见
///   docs/08-规划/插件生态设计.md 第 9.5 节，公钥与应用更新共用），因此中间人改不了
///   索引内容 —— 但签名挡不住两件事：把**整份旧索引原样重放**给你（回滚，客户端目前
///   没有防回滚检测），以及看到你请求了什么。传输层加密是这两件事的基本防护。
///   这里不因为「反正有签名」而放行明文 http。
/// - **回环例外**只为本地调试：在那台服务器就是用户自己机器、插件代码也运行在同一台机器上
///   的前提下，它不削弱真实威胁模型。
fn ensure_registry_url_allowed(url: &str) -> PluginResult<()> {
    let host = ensure_https_or_loopback(url)?;

    // 回环地址只服务于本地调试：那台服务器就是用户自己的机器，插件代码也运行在同一台
    // 机器上，因此不施加宿主白名单。
    if is_loopback_host(&host) {
        return Ok(());
    }

    if !ALLOWED_REGISTRY_HOSTS.contains(&host.as_str()) {
        return Err(PluginError::SandboxViolation(format!(
            "只允许从插件仓库的地址获取内容（{}），实际为: {}",
            ALLOWED_REGISTRY_HOSTS.join(" 或 "),
            host
        )));
    }

    Ok(())
}

/// 传输层约束：必须 https，本机回环可用 http。返回小写化的宿主名。
///
/// 这是**比白名单弱、比"任意 URL"强**的一档，服务于「用户自己粘贴一个地址安装插件」
/// 那条路径（`install_from_url`）。它**不做宿主白名单**，因为用户可能从自建服务器或
/// 内网地址安装；但明文 http 一律拒绝 —— 下载的是将要执行的代码，不加密的传输通道
/// 等于把"装什么"交给链路上的任何人。
///
/// 与 `ensure_registry_url_allowed` 的关系是"同一条规则的前半段"：白名单版本在此之上
/// 再加宿主限制。两者共用这一段，避免两处对"什么算合法地址"给出不同答案。
fn ensure_https_or_loopback(url: &str) -> PluginResult<String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| PluginError::DownloadFailed(format!("地址非法: {}", e)))?;

    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let scheme = parsed.scheme();

    if is_loopback_host(&host) && (scheme == "http" || scheme == "https") {
        return Ok(host);
    }

    if scheme != "https" {
        return Err(PluginError::SandboxViolation(format!(
            "插件内容必须通过 https 获取（本机回环地址可用 http 以便调试）: {}",
            url.trim()
        )));
    }

    Ok(host)
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

/// 音频扩展名 → data URL 使用的 MIME 类型。
///
/// **必须按扩展名白名单校验**，不能只依赖对话框的过滤器：过滤器只是给用户的
/// 建议，选择框里仍然可以切到「所有文件」。返回 `None` 即拒绝。
fn audio_mime_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "opus" => "audio/opus",
        "webm" => "audio/webm",
        _ => return None,
    })
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
    /// 出站门面。**没有裸 `reqwest::Client` 字段** —— 理由见 `net/client.rs`：
    /// 上一版正是靠"每个调用点各自记得判定"，结果市场索引那条路漏掉了。
    net: NetClient,
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

        // 30 秒是**下载整包**用的超时，不是诊断用的短超时 —— 门面按调用方给的值构造，
        // 因为"慢"与"坏"在这里是两件不同的事。
        let net = NetClient::new(app.clone(), std::time::Duration::from_secs(30))
            .map_err(PluginError::NetworkError)?;

        let mut manager = Self {
            app,
            plugins_dir,
            data_dir,
            registry: HashMap::new(),
            net,
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

    /// 该插件当前实际生效的根目录：开发链接优先，否则是安装目录。
    ///
    /// **所有读取插件文件的地方都必须走这里**（清单、bundle、样式、图标、
    /// README、导出、权限判定），否则就会出现「一部分内容来自源目录、另一部分
    /// 来自旧副本」的割裂状态 —— 那比全部用旧的更难排查。
    fn asset_root(&self, entry: &RegistryEntry) -> PathBuf {
        resolve_asset_root(
            &self.version_dir(entry),
            entry.source_path.as_deref(),
            &entry.id,
        )
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
        // 开发链接优先：清单、样式、README、体积都跟着源目录走，
        // 界面上看到的版本/权限与运行时实际执行的内容才是一致的。
        let dir = self.asset_root(entry);

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
            // 只有开发目录**实际生效**时才报告它：源目录被删掉后这里必须是 None，
            // 否则界面会显示一个名不副实的「开发模式」标记。
            dev_source: if dir != self.version_dir(entry) {
                Some(dir.to_string_lossy().to_string())
            } else {
                None
            },
            engine_advisory,
        })
    }

    /// 读取已安装插件的清单（权限检查用）
    fn manifest_of(&self, id: &str) -> PluginResult<PluginManifest> {
        let entry = self
            .registry
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
        // 权限判定必须与运行时读到的清单是同一份 —— 否则开发目录里新加/去掉的
        // 权限声明不会影响判定，插件就会按旧清单被放行或拒绝。
        read_manifest(&self.asset_root(entry))
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
            self.install_from_root(&staging, "file", None)
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
    ///
    /// 复制之外还会**记录源目录**（`source_path`），使该插件成为「开发链接」：
    /// 之后读取清单与资源都直接走源目录，开发者在源目录里改完代码点刷新即生效。
    /// 复制这一步仍然保留 —— 源目录被删除或改名时，插件还能靠副本继续工作。
    pub fn install_from_folder(&mut self, path: &Path) -> PluginResult<InstalledPlugin> {
        if !path.is_dir() {
            return Err(PluginError::NotFound(format!(
                "插件目录不存在: {}",
                path.display()
            )));
        }

        // 先归一化源路径：注册表里存的必须是绝对路径，否则应用换个工作目录启动
        // 就再也找不到它了。canonicalize 同时消掉 `..` 与符号链接的歧义。
        let source_dir = path.canonicalize().map_err(|e| {
            PluginError::NotFound(format!("无法解析插件目录 {}（{}）", path.display(), e))
        })?;

        std::fs::create_dir_all(self.staging_dir())?;
        let staging = self.staging_dir().join(uuid::Uuid::new_v4().to_string());

        let result = (|| -> PluginResult<InstalledPlugin> {
            copy_tree(&source_dir, &staging)?;
            // 兜底补一份规范化清单，避免源目录清单缺少默认字段
            let manifest = read_manifest(&staging)?;
            let serialized = serde_json::to_string_pretty(&manifest)?;
            std::fs::write(staging.join("manifest.json"), serialized)?;
            self.install_from_root(&staging, "folder", Some(source_dir))
        })();

        if staging.exists() {
            if let Err(e) = std::fs::remove_dir_all(&staging) {
                log::warn!("清理插件暂存目录失败 {}: {}", staging.display(), e);
            }
        }

        result
    }

    /// 从 URL 下载 .lcp 后安装（**不校验哈希**）。
    ///
    /// 这是"用户自己粘贴一个地址"的路径：没有可对照的期望值，因此无从校验。
    /// 插件市场的路径走 [`Self::install_from_url_verified`]。
    ///
    /// **地址约束只到传输层为止**（https，回环例外），**不做宿主白名单** ——
    /// 用户可能从自建服务器或内网地址安装。推论是这条命令**不受 `network` /
    /// `network-external` 权限约束**：一个已安装插件可以直接 `invoke` 它去下载任意
    /// 地址的内容。之所以无法在这里加权限检查，是因为命令签名里没有插件 id，而在
    /// 「插件与宿主共享同一个 JS 上下文」的模型下后端无法知道调用者是谁（见
    /// `docs/06-项目/已知问题与技术债.md` 第 4 节）。市场路径反过来是受限的：它只
    /// 接受插件仓库自己的地址，因此能施加宿主白名单。
    pub async fn install_from_url(&mut self, url: &str) -> PluginResult<InstalledPlugin> {
        ensure_https_or_loopback(url)?;
        self.download_and_install(url, None).await
    }

    /// 从 URL 下载 .lcp，可校验哈希后安装。**插件市场唯一的入口。**
    ///
    /// `expected_sha256` 给定时，校验发生在**写盘与解压之前**：下载来源（CDN）与索引
    /// 本身都可能出问题，而一旦解压安装就晚了 —— 那时错误只能靠"卸载"来纠正。
    ///
    /// **地址受 [`ensure_registry_url_allowed`] 约束**：市场的地址由
    /// `src/config/pluginRegistry.ts` 的 `registrySources` 生成，只可能是插件仓库的
    /// 两个宿主，所以这里可以收紧到白名单。用户配置的下载源（前缀式加速）由后端在
    /// `fetch_via_sources` 内部拼接，不在本函数的校验范围内 —— 它改的是"经由哪里取"，
    /// 不是"取什么"。
    ///
    /// 注意它**仍然无法识别调用者**：一个插件可以直接 invoke 本命令去下载白名单上的
    /// 任意 `.lcp`（例如把某个插件装回旧版本）。约束它的是宿主白名单与调用方传入的
    /// `sha256`，而不是调用者身份。
    pub async fn install_from_url_verified(
        &mut self,
        url: &str,
        expected_sha256: Option<&str>,
    ) -> PluginResult<InstalledPlugin> {
        ensure_registry_url_allowed(url)?;
        self.download_and_install(url, expected_sha256).await
    }

    /// 下载并安装的实际实现。地址校验由两个入口各自完成，这里假定传入地址已通过校验。
    async fn download_and_install(
        &mut self,
        url: &str,
        expected_sha256: Option<&str>,
    ) -> PluginResult<InstalledPlugin> {
        let (bytes, used) = self.fetch_via_sources(url.trim(), "插件包下载").await?;

        if bytes.len() as u64 > MAX_PLUGIN_BYTES {
            return Err(PluginError::InvalidPackage(format!(
                "插件包体积 {} 字节超过上限 {} 字节",
                bytes.len(),
                MAX_PLUGIN_BYTES
            )));
        }

        // 校验发生在**写盘与解压之前**：下载来源（CDN / 下载源）与索引本身都可能出问题，
        // 而一旦解压安装就晚了 —— 那时错误只能靠"卸载"来纠正。
        if let Some(expected) = expected_sha256 {
            verify_sha256(&bytes, expected)?;
        }

        log::info!("插件包已取回（{} 字节，来源 {}）", bytes.len(), used);

        std::fs::create_dir_all(self.staging_dir())?;
        let tmp = self
            .staging_dir()
            .join(format!("{}.lcp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, &bytes)?;

        let result = self.install_from_lcp(&tmp);
        let _ = std::fs::remove_file(&tmp);
        result
    }

    /// 当前设置下生效的下载源根地址（`None` = 直连）
    ///
    /// **每次调用都重新读设置**，不缓存：网络请求本身就是低频动作（一次市场加载
    /// 只发几次），而缓存会引入「改了设置要重启才生效」这种最难解释的现象。
    /// `settings.json` 只有几 KB，读一次的代价远小于一次 HTTP 请求。
    fn proxy_base(&self) -> Option<String> {
        let settings = settings_store::load(&self.app);
        network::proxy_base(&settings).map(|base| base.to_string())
    }

    /// 按当前网络设置取回一个地址的正文，返回（正文，实际使用的地址）
    ///
    /// 开了下载源时**先走下载源，失败再直连**。顺序与回退都是刻意的：
    ///
    /// * 先走下载源：用户配它就是为了优先用它，把直连放前面等于这个设置不起作用。
    /// * 回退到直连：一个填错或临时挂掉的加速源不该把插件市场永久变成不可用 ——
    ///   那会让一个「加速」选项变成破坏性的。反过来的顺序（直连优先）在受限网络里
    ///   每次都要先等一个超时，体验更差。
    ///
    /// 两条路都失败时，返回**最后一次**的错误：用户看到的应当是「两个地址都不行」，
    /// 而 `PluginError` 是单个错误类型，因此把两次尝试都写进日志（那才是排查入口）。
    async fn fetch_via_sources(
        &self,
        url: &str,
        purpose: &'static str,
    ) -> PluginResult<(Vec<u8>, String)> {
        let proxy = self.proxy_base();
        let candidate = network::rewrite_url(url, proxy.as_deref());

        if candidate != url {
            log::info!("经下载源取回插件仓库内容：{}", candidate);
            match self.fetch_once(&candidate, purpose).await {
                Ok(bytes) => return Ok((bytes, candidate)),
                Err(e) => {
                    log::warn!(
                        "经下载源取回失败（{}）：{}；回退直连 {}",
                        candidate,
                        e,
                        url
                    );
                }
            }
        }

        match self.fetch_once(url, purpose).await {
            Ok(bytes) => Ok((bytes, url.to_string())),
            Err(e) => {
                log::warn!("直连取回失败（{}）：{}", url, e);
                Err(e)
            }
        }
    }

    /// 发一次 GET 并读回全部正文
    ///
    /// 体积上限由调用方检查：这里不知道调用方要的是几 KB 的索引还是几十 MB 的包。
    ///
    /// 请求经 [`NetClient`] 发出 —— 出站策略与流量日志在那一层，不在本函数里。
    /// `purpose` 只用于日志：它回答"为什么发"，与 `source` 一起才让一条记录能被读懂。
    async fn fetch_once(&self, url: &str, purpose: &'static str) -> PluginResult<Vec<u8>> {
        let response = self
            .net
            .get_and_send(url, NetOrigin::module("plugins", purpose))
            .await
            .map_err(net_error_to_plugin)?;

        if !response.status().is_success() {
            return Err(PluginError::DownloadFailed(format!(
                "HTTP {}（{}）",
                response.status(),
                url
            )));
        }

        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|e| PluginError::NetworkError(network::describe_error_chain(&e)))
    }

    /// 从插件仓库拉取一个文本文件（索引或 README）。
    ///
    /// **只在后端做，不经过 WebView 的 `fetch`。** 后端已经有 reqwest 客户端、超时与
    /// 体积上限，而且不依赖 WebView 的 CORS 与安全上下文行为 —— 那两者在本项目里没有
    /// 任何自动化覆盖，出问题时的表现是"市场页一片空白"，排查方向会指向插件系统，
    /// 而真实原因在网络层。
    ///
    /// 地址策略见 [`ensure_registry_url_allowed`]：宿主必须在白名单里且走 https。
    ///
    /// **下载源（代理）在校验之后才拼上。** 校验的是原始地址，代理只是把它整条
    /// 接到另一个域名后面（见 [`PluginManager::fetch_via_sources`]）。这样白名单
    /// 始终约束我们自己写死的宿主，用户填的代理地址不可能成为新的可访问目标。
    pub async fn fetch_registry_text(&self, url: &str) -> PluginResult<String> {
        ensure_registry_url_allowed(url)?;

        let (bytes, used) = self
            .fetch_via_sources(url.trim(), registry_text_purpose(url))
            .await?;

        if bytes.len() as u64 > MAX_REGISTRY_TEXT_BYTES {
            return Err(PluginError::InvalidPackage(format!(
                "内容体积 {} 字节超过上限 {} 字节（{}）",
                bytes.len(),
                MAX_REGISTRY_TEXT_BYTES,
                used
            )));
        }

        String::from_utf8(bytes)
            .map_err(|_| PluginError::InvalidPackage("内容不是合法的 UTF-8".to_string()))
    }

    /// 校验暂存目录中的插件，然后移动到 <plugins_dir>/<id>/<version>/
    ///
    /// `dev_source` 只在「从本地目录安装」时给出，会被记进注册表，
    /// 使该插件在之后读取内容时优先使用源目录（见 `resolve_asset_root`）。
    fn install_from_root(
        &mut self,
        root: &Path,
        source: &str,
        dev_source: Option<PathBuf>,
    ) -> PluginResult<InstalledPlugin> {
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
            // 存「可读」形式：canonicalize 的 `\\?\` 前缀不该进注册表与界面
            source_path: dev_source.map(|p| normalize_source_path(&p)),
        };
        self.registry.insert(id.clone(), entry.clone());
        self.save_registry()?;

        log::info!(
            "插件 {} v{} 安装完成（来源 {}{}）",
            id,
            version,
            source,
            entry
                .source_path
                .as_deref()
                .map(|p| format!("，开发目录 {}", p))
                .unwrap_or_default()
        );
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
        let entry = self
            .registry
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
        // 开发链接优先：这就是「在源目录改代码 → 点刷新即生效」成立的地方。
        let root = self.asset_root(entry);

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
        // 导出的是**当前生效**的那份内容：开发链接下就是源目录，
        // 因此「改完直接导出成包」拿到的是最新代码，而不是第一次安装时的副本。
        let root = self.asset_root(
            self.registry
                .get(id)
                .ok_or_else(|| PluginError::NotFound(id.to_string()))?,
        );
        if !root.is_dir() {
            return Err(PluginError::NotFound(format!(
                "插件目录不存在: {}",
                root.display()
            )));
        }

        let target = match dest {
            Some(path) => {
                // **为什么 `dest` 只能是文件名，且不允许覆盖。**
                //
                // 本命令没有权限检查，也没有调用者身份 —— 插件可以直接 invoke 它。
                // 若放任 `dest` 是任意路径，它就是一个"任意文件截断覆盖"原语（语义上
                // 等同于 `filesystem-write`，而那条权限当前没有别的强制点）。收口之后
                // 它最多只能在默认导出目录（通常是用户的下载目录）里创建一个**新**文件。
                //
                // 默认导出目录是下载目录，不是应用专有目录，所以"只允许新文件"这一条
                // 不能省：否则插件仍可静默覆盖用户下载目录里的同名文件。
                let file_name = export_file_name(&path)?;

                let base = PathBuf::from(self.default_export_dir()?);
                std::fs::create_dir_all(&base)?;
                let target = base.join(file_name);

                // 存在性检查与写入之间存在一个很短的竞态窗口（TOCTOU）。它无法在不改
                // 写入路径的前提下彻底消除，但在这个位置代价可接受：能利用它的只有本机
                // 同用户进程，而那样的进程本来就拥有更大的能力。这里挡的是"静默覆盖
                // 用户已有文件"，不是提供原子性保证。
                if target.exists() {
                    return Err(PluginError::SandboxViolation(format!(
                        "导出目标已存在，拒绝覆盖: {}",
                        target.display()
                    )));
                }

                target
            }
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

    /// 让用户挑一个音频文件，读进来并编码成 data URL。
    ///
    /// 需要 `filesystem-read` 权限。
    ///
    /// 为什么把「选择 + 读取 + 编码」合成一步，而不是先给插件一个路径让它自己读：
    /// 这样**扩展名校验与体积上限只有一个执行点**，插件拿不到原始字节，也就不存在
    /// 绕过限制的路径。与图标提取同一思路 —— 宿主给成品，而不是给原料。
    ///
    /// 返回 `Ok(None)` 表示用户取消了选择。这与「选了但格式不对」是两回事：
    /// 前者是正常操作，不该报错。
    pub async fn pick_audio(&self, id: &str) -> PluginResult<Option<PickedAudio>> {
        self.require_permission(id, PluginPermission::FilesystemRead)?;

        let app = self.app.clone();
        let picked = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .add_filter("音频文件", &AUDIO_EXTENSIONS)
                .blocking_pick_file()
        })
        .await
        .map_err(|e| PluginError::DialogUnavailable(e.to_string()))?;

        let Some(choice) = picked else {
            return Ok(None);
        };
        let path = file_path_to_path(choice)?;

        let mime = audio_mime_for(&path).ok_or_else(|| {
            PluginError::SandboxViolation(format!(
                "不支持的音频格式（支持 {}）: {}",
                AUDIO_EXTENSIONS.join(" / "),
                path.display()
            ))
        })?;

        let size = std::fs::metadata(&path)?.len();
        if size > MAX_AUDIO_BYTES {
            return Err(PluginError::SandboxViolation(format!(
                "音频文件过大: {:.1} MB（上限 {} MB）",
                size as f64 / 1024.0 / 1024.0,
                MAX_AUDIO_BYTES / 1024 / 1024
            )));
        }

        let bytes = std::fs::read(&path)?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "audio".to_string());

        Ok(Some(PickedAudio {
            name,
            data_url: format!("data:{};base64,{}", mime, BASE64.encode(&bytes)),
            bytes: bytes.len() as u64,
        }))
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

        // ---- 出站策略与流量日志 ----
        //
        // **不在这里判定，也不在这里记日志。** 两件事都在 `NetClient::execute` 里，
        // 与市场索引、诊断走同一条出口。
        //
        // 上一版把这段逻辑手写在这里，结果是同一个文件里的 `fetch_once` 没写 ——
        // 用户设了「禁止出站」后市场照样能加载。一个必须靠"记得写"才生效的纪律，
        // 迟早会在某个新加的调用点上漏掉；收口到门面之后，漏掉是编译不过的。
        let mut request = self
            .net
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

        let response = self
            .net
            .execute(request, NetOrigin::plugin(id, "插件网络请求"))
            .await
            .map_err(|error| match error {
                // 被策略拒绝时给出带插件名的说明：用户需要知道是哪一支插件在撞策略，
                // 而不是只看到"离线模式已开启"却不知道谁在试
                NetError::Denied(reason) => PluginError::PermissionDenied(format!(
                    "插件 {} 的请求被出站策略拒绝：{}",
                    id, reason
                )),
                other => PluginError::NetworkError(other.message()),
            })?;
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

/// 去掉 Windows `canonicalize` 加上的 `\\?\` verbatim 前缀。
///
/// 为什么需要：`canonicalize()` 在 Windows 上返回 `\\?\C:\...`（UNC 则是
/// `\\?\UNC\server\share\...`）。这个前缀对文件操作是好事（绕过路径长度限制与
/// 多余的规范化），但它会被写进注册表、并经由 `devSource` 显示在界面上 ——
/// 用户看到 `\\?\C:\...` 只会当成乱码。
///
/// 纯字符串变换，单独抽出来是为了能在任何平台上测试（CI 未必跑 Windows）。
fn strip_verbatim_prefix(raw: &str) -> Option<String> {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{}", rest));
    }
    raw.strip_prefix(r"\\?\").map(|rest| rest.to_string())
}

/// 把路径规范成「可持久化、可展示」的字符串形式
fn normalize_source_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    strip_verbatim_prefix(&raw).unwrap_or_else(|| raw.to_string())
}

/// 解析某个已安装插件当前应当从哪里读取资源与清单。
///
/// 正常情况是安装目录 `<plugins_dir>/<id>/<version>`；「从本地目录安装」的插件
/// 则优先用注册表里记下的**源目录**，这样开发者在源目录里改完代码，应用刷新后
/// 立刻读到新内容，不必卸载重装。
///
/// 三道回退，任何一道不成立就退回安装目录 —— 宁可读到旧副本，也不能让插件
/// 因为一个陈旧或非法的路径而彻底打不开：
///
/// 1. **必须是绝对路径且确实存在一个目录。** 源目录可能被删掉、被移走，或者
///    注册表被手工改成了相对路径。
/// 2. **清单必须能读出来，且 `name` 与注册表里的插件 ID 一致。** 这一条防的是
///    「身份漂移」：源目录被改成了另一个插件、或者路径被指向了别的插件目录时，
///    若照读不误，A 插件的 ID 就会被 B 插件的代码与权限清单顶替 ——
///    权限检查读的也是这份清单，那等于绕过了权限声明。
/// 3. 其余情况（无 `source_path`）自然走安装目录。
///
/// 纯函数：不接触 `PluginManager`（它持有 `AppHandle`，单测里造不出来），
/// 因此上面的回退规则可以被测试直接锁定。
fn resolve_asset_root(installed: &Path, dev_source: Option<&str>, expected_id: &str) -> PathBuf {
    let Some(raw) = dev_source.map(str::trim).filter(|s| !s.is_empty()) else {
        return installed.to_path_buf();
    };

    let candidate = Path::new(raw);
    if !candidate.is_absolute() || !candidate.is_dir() {
        return installed.to_path_buf();
    }

    match read_manifest(candidate) {
        Ok(manifest) if manifest.name == expected_id => candidate.to_path_buf(),
        Ok(manifest) => {
            log::warn!(
                "插件 {} 的开发目录清单声明的是 {}，与插件 ID 不一致，已退回安装目录",
                expected_id,
                manifest.name
            );
            installed.to_path_buf()
        }
        Err(e) => {
            log::warn!(
                "插件 {} 的开发目录无法读取清单（{}），已退回安装目录",
                expected_id,
                e
            );
            installed.to_path_buf()
        }
    }
}

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

/// 回环判定已移到 `net::is_loopback_host`（策略、门面与权限检查要用同一份）。
/// 这里原先有一份私有实现 —— 两份实现迟早会在某个边界值上分叉。

/// 出站门面的错误 → 插件错误
///
/// **被策略拒绝与请求失败必须分开。** 前者是用户自己关掉的结果（"离线模式已开启"），
/// 后者才是故障。把它们折成同一句"网络请求失败"，会让离线模式看起来像坏了。
fn net_error_to_plugin(error: NetError) -> PluginError {
    match error {
        NetError::Denied(reason) => PluginError::PermissionDenied(reason),
        other => PluginError::NetworkError(other.message()),
    }
}

/// 这条文本请求取的是索引还是说明文件
///
/// 只影响日志里的"用途"一列。判断刻意保守：**认不出来就说"仓库文本"**，
/// 不去猜一个可能错的用途 —— 日志里出现错误的用途比出现笼统的用途更糟。
fn registry_text_purpose(url: &str) -> &'static str {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    if path.ends_with(".json") {
        "插件索引"
    } else if path.ends_with(".md") {
        "插件说明"
    } else {
        "插件仓库文本"
    }
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

    // 两个累计器：`declared_total` 用压缩包**声明**的大小做廉价预检，`written_total`
    // 累加**实际**写出的字节数。真正的判据是后者。
    let mut declared_total: u64 = 0;
    let mut written_total: u64 = 0;

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

        // 2) 体积上限的**声明值预检**：明显超限时不必解压就能拒绝，是第一道廉价防线。
        //
        //    它不能作为唯一判据 —— `entry.size()` 是压缩包中央目录里**自己声明**的值，
        //    可以被构造成"声明很小、实际很大"，也就是典型的解压炸弹。真正的判据是下面
        //    写入循环里按实际字节累计的 `written_total`。
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_PLUGIN_BYTES {
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

            // 整包体积按**实际**字节累计。这一条不信任压缩包的声明值，因此解压炸弹会在
            // 写满上限的那一刻立即中止，而不是先把磁盘写满 —— 上面的 `declared_total`
            // 只是廉价预检，撒谎的中央目录骗不过这里。
            written_total = written_total.saturating_add(read as u64);
            if written_total > MAX_PLUGIN_BYTES {
                return Err(PluginError::InvalidPackage(format!(
                    "压缩包解压后总体积超过上限 {} 字节",
                    MAX_PLUGIN_BYTES
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

/// 从调用方给出的导出目标里取出**文件名**，拒绝任何带目录的写法。
///
/// 抽成纯函数是为了可测：`PluginManager` 持有 `AppHandle`，单测里造不出来。而这条
/// 规则正是「`export_plugin` 不是任意文件覆盖原语」的唯一依据，必须被测试锁住。
fn export_file_name(path: &Path) -> PluginResult<std::ffi::OsString> {
    match path.file_name() {
        Some(name) if path.parent().map_or(true, |p| p.as_os_str().is_empty()) => {
            Ok(name.to_os_string())
        }
        _ => Err(PluginError::SandboxViolation(format!(
            "导出目标必须是文件名（不能包含目录），导出始终落在默认导出目录内: {}",
            path.display()
        ))),
    }
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

    /// **导出目标必须是裸文件名。**
    ///
    /// 这条规则是「`export_plugin` 不是任意文件截断覆盖原语」的唯一依据：`dest` 一旦
    /// 允许目录成分，插件就能直接 invoke 它去覆盖 `auth.json` 或用户任意文件。
    #[test]
    fn export_target_must_be_a_bare_file_name() {
        for rejected in [
            "sub/x.lcp",
            "sub\\x.lcp",
            "/tmp/x.lcp",
            "C:\\tmp\\x.lcp",
            "../x.lcp",
            "..",
            ".",
        ] {
            assert!(
                export_file_name(Path::new(rejected)).is_err(),
                "带目录或非文件名的导出目标应当被拒绝: {}",
                rejected
            );
        }

        for accepted in ["x.lcp", "my-plugin-1.0.0.lcp", "导出.lcp"] {
            assert_eq!(
                export_file_name(Path::new(accepted))
                    .unwrap()
                    .to_string_lossy(),
                accepted,
                "纯文件名应当通过: {}",
                accepted
            );
        }
    }

    /// **市场路径的地址只能是插件仓库本身。**
    ///
    /// `install_from_url_verified` 是市场唯一入口，而市场地址由
    /// `src/config/pluginRegistry.ts` 生成，只可能是这两个宿主。收紧到白名单之后，
    /// 一个插件即使直接 invoke 它，也下载不到白名单之外的内容。
    #[test]
    fn registry_url_requires_allowlisted_host() {
        for allowed in [
            "https://cdn.jsdelivr.net/gh/Rinntheor/modulith-plugins@main/index.json",
            "https://raw.githubusercontent.com/Rinntheor/modulith-plugins/main/index.json",
        ] {
            assert!(
                ensure_registry_url_allowed(allowed).is_ok(),
                "白名单地址应当放行: {}",
                allowed
            );
        }

        // 其他宿主：即使走 https 也拒绝
        for rejected in [
            "https://attacker.example/x.lcp",
            "https://evil.jsdelivr.net.attacker.example/x.lcp",
        ] {
            assert!(
                ensure_registry_url_allowed(rejected).is_err(),
                "非白名单宿主应当被拒绝: {}",
                rejected
            );
        }

        // 明文 http：非回环一律拒绝
        assert!(ensure_registry_url_allowed("http://cdn.jsdelivr.net/x").is_err());
        // 非 http(s) 协议：拒绝
        assert!(ensure_registry_url_allowed("file:///C:/x.lcp").is_err());
        assert!(ensure_registry_url_allowed("ftp://cdn.jsdelivr.net/x").is_err());
        // 回环允许 http（本地调试）
        assert!(ensure_registry_url_allowed("http://127.0.0.1:8080/index.json").is_ok());
        assert!(ensure_registry_url_allowed("http://localhost:8080/index.json").is_ok());
    }

    /// **用户粘贴路径只约束传输层，不限制宿主。**
    ///
    /// 这条路径服务于「从 URL 安装」这个真实功能，因此不能施加白名单；但它同样必须
    /// 拒绝明文 http —— 下载的是将要执行的代码。
    #[test]
    fn user_pasted_url_allows_any_https_host_but_not_plain_http() {
        assert!(ensure_https_or_loopback("https://example.com/plugin.lcp").is_ok());
        assert!(ensure_https_or_loopback("https://self-hosted.internal/plugin.lcp").is_ok());
        assert!(ensure_https_or_loopback("http://example.com/plugin.lcp").is_err());
        assert!(ensure_https_or_loopback("file:///C:/plugin.lcp").is_err());
        // 回环是唯一允许 http 的情形
        assert!(ensure_https_or_loopback("http://127.0.0.1/x.lcp").is_ok());
    }

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

    /// 写一份最小可用的 manifest.json（`read_manifest` 会补默认值）
    fn write_manifest(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let json = format!(
            r#"{{
  "name": "{name}",
  "displayName": "测试插件",
  "version": "1.0.0",
  "main": "index.js"
}}"#
        );
        std::fs::write(dir.join("manifest.json"), json).unwrap();
    }

    // ============================================================
    // 开发链接（从本地目录安装）的根目录解析
    // ============================================================

    /// 源目录有效且清单同名时，必须读源目录 —— 这是「改完点刷新即生效」的前提。
    #[test]
    fn dev_link_prefers_source_directory() {
        let root = temp_dir("devlink-ok");
        let installed = root.join("installed");
        let source = root.join("source");
        write_manifest(&installed, "com.test.dev");
        write_manifest(&source, "com.test.dev");

        let resolved = resolve_asset_root(
            &installed,
            Some(source.to_string_lossy().as_ref()),
            "com.test.dev",
        );

        assert_eq!(resolved, source);
    }

    /// 没有 `source_path`（.lcp / URL 安装）时必须用安装目录。
    #[test]
    fn dev_link_absent_uses_installed_directory() {
        let root = temp_dir("devlink-none");
        let installed = root.join("installed");
        write_manifest(&installed, "com.test.dev");

        assert_eq!(
            resolve_asset_root(&installed, None, "com.test.dev"),
            installed
        );
        // 空串等同于「没有」，不能把安装目录解析成一个空路径
        assert_eq!(
            resolve_asset_root(&installed, Some("   "), "com.test.dev"),
            installed
        );
    }

    /// 源目录被删除 / 改名后必须退回安装目录，而不是让插件直接打不开。
    #[test]
    fn dev_link_missing_source_falls_back() {
        let root = temp_dir("devlink-gone");
        let installed = root.join("installed");
        write_manifest(&installed, "com.test.dev");
        let missing = root.join("no-such-dir");

        assert_eq!(
            resolve_asset_root(
                &installed,
                Some(missing.to_string_lossy().as_ref()),
                "com.test.dev"
            ),
            installed
        );
    }

    /// **安全约束**：源目录里的清单声明的是别的插件 ID 时必须拒绝。
    ///
    /// 否则 A 插件的身份会被 B 插件的代码与权限清单顶替 —— 权限判定读的正是
    /// 这份清单，等于绕过了权限声明。
    #[test]
    fn dev_link_rejects_identity_mismatch() {
        let root = temp_dir("devlink-mismatch");
        let installed = root.join("installed");
        let source = root.join("source");
        write_manifest(&installed, "com.test.dev");
        write_manifest(&source, "com.test.other");

        assert_eq!(
            resolve_asset_root(
                &installed,
                Some(source.to_string_lossy().as_ref()),
                "com.test.dev"
            ),
            installed
        );
    }

    /// 源目录存在但没有可读清单时必须退回安装目录（而不是失败）。
    #[test]
    fn dev_link_unreadable_manifest_falls_back() {
        let root = temp_dir("devlink-nomanifest");
        let installed = root.join("installed");
        let source = root.join("source");
        write_manifest(&installed, "com.test.dev");
        std::fs::create_dir_all(&source).unwrap();

        assert_eq!(
            resolve_asset_root(
                &installed,
                Some(source.to_string_lossy().as_ref()),
                "com.test.dev"
            ),
            installed
        );
    }

    /// 注册表里的相对路径必须被拒绝：它依赖进程当前工作目录，
    /// 换个启动方式就会指向完全不同的地方。
    #[test]
    fn dev_link_rejects_relative_path() {
        let root = temp_dir("devlink-relative");
        let installed = root.join("installed");
        write_manifest(&installed, "com.test.dev");

        assert_eq!(
            resolve_asset_root(&installed, Some("some/relative/dir"), "com.test.dev"),
            installed
        );
    }

    /// Windows 的 `canonicalize` 会加 `\\?\` 前缀，它不该被写进注册表或界面。
    #[test]
    fn verbatim_prefix_is_stripped_for_storage() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\dev\my-plugin").as_deref(),
            Some(r"C:\dev\my-plugin")
        );
        // UNC 路径要还原成 `\\server\share\...`，而不是 `\server\share\...`
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\plugin").as_deref(),
            Some(r"\\server\share\plugin")
        );
        // 普通路径不该被改动
        assert_eq!(strip_verbatim_prefix(r"C:\dev\my-plugin"), None);
        // 前缀只去一次，剩余部分原样保留
        assert_eq!(
            normalize_source_path(Path::new(r"\\?\C:\a\b")),
            r"C:\a\b".to_string()
        );
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

    /// 用仓库里真实的示例插件包做一次完整解压 + 校验。
    ///
    /// 这是对「导入 .lcp 报条目逃出目标目录」那个 bug 最直接的回归测试。
    ///
    /// 它同时是**对已打包产物**的检查：解压出来的目录要能通过 `validate_manifest`，
    /// 也就是仓库里那个 `.lcp` 真的可安装，而不只是源码看起来对。
    ///
    /// 仓库里只有一个示例插件（`samples/reference`）。另外三个完整示例
    /// （`com.modulith.sample.notes` / `pomodoro` / `quick-launch`）已经迁到插件仓库
    /// `modulith-plugins`，那边由 `scripts/build.ts` 负责打包，同样会在构建时复核
    /// 每个包与索引记录一致。
    #[test]
    fn extracts_and_validates_real_sample_lcps() {
        let samples = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../samples");
        let packages = ["reference.lcp"];

        let mut checked = 0;
        for name in packages {
            let package = samples.join(name);
            if !package.exists() {
                eprintln!("跳过：示例包不存在: {}", package.display());
                continue;
            }

            let dest = temp_dir(name);
            extract_zip(&package, &dest).expect("示例 .lcp 应当可以正常解压");

            for required in ["manifest.json", "index.js", "index.css", "icon.svg"] {
                assert!(
                    dest.join(required).is_file(),
                    "{} 缺少 {}（打包时应当包含插件目录下的全部文件）",
                    name,
                    required
                );
            }

            let text = std::fs::read_to_string(dest.join("manifest.json")).unwrap();
            let manifest: PluginManifest = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{} 的清单无法解析: {}", name, e));

            let stem = name.trim_end_matches(".lcp");
            assert_eq!(
                manifest.name,
                format!("com.modulith.sample.{}", stem),
                "{} 的插件 ID 与文件名不符",
                name
            );

            // 解压后仍要通过完整校验，才算「这个包真的能装」
            validator::validate_manifest(&manifest, &dest)
                .unwrap_or_else(|e| panic!("{} 解压后未通过清单校验: {}", name, e));

            // **包必须与源码目录逐字节一致。**
            // 否则仓库里那个 .lcp 是陈旧的，用户装到的不是当前代码 ——
            // 这个错误我已经犯过两次（改完插件忘记重新打包），因此用测试钉死：
            // 只要改动源码后没重新打包，这里就会红。
            let source = samples.join(stem);
            if source.is_dir() {
                for entry in std::fs::read_dir(&source).expect("应能读取示例目录") {
                    let entry = entry.expect("目录项应可读");
                    if !entry.path().is_file() {
                        continue;
                    }
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    let from_source = std::fs::read(entry.path()).expect("应能读取源文件");
                    let from_package = std::fs::read(dest.join(&file_name)).unwrap_or_else(|_| {
                        panic!("{} 里缺少 {}，需要重新打包", name, file_name)
                    });
                    assert_eq!(
                        from_source, from_package,
                        "{}/{} 与包内内容不一致 —— 改完插件后忘记重新打包了",
                        stem, file_name
                    );
                }
            }

            let _ = std::fs::remove_dir_all(&dest);
            checked += 1;
        }

        assert!(checked > 0, "一个示例包都没找到，这条测试实际上什么也没检查");
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

    /// 校验一个示例插件目录：清单能解析、能通过 `validate_manifest`，
    /// 且声明了它实际用到的那几项权限。
    ///
    /// 抽成公共函数是因为这类校验对**每个**示例插件都成立 —— 而且它挡住的是一类
    /// **运行时才暴露**的错误：权限现在真的会被强制，「代码用了某能力、清单忘了
    /// 声明」原本要等用户点下去才发现，现在构建期就红。
    fn assert_sample_manifest_valid(folder: &str, required: &[PluginPermission]) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../samples")
            .join(folder);
        if !root.exists() {
            eprintln!("跳过：示例插件目录不存在: {}", root.display());
            return;
        }

        let text = std::fs::read_to_string(root.join("manifest.json")).expect("应能读取清单");
        let manifest: PluginManifest = serde_json::from_str(&text).expect("清单应当能解析");

        // 入口与图标都真实存在 —— validate_manifest 会检查 main
        validator::validate_manifest(&manifest, &root)
            .unwrap_or_else(|e| panic!("示例插件 {} 的清单未通过校验: {}", folder, e));

        for permission in required {
            assert!(
                manifest.permissions.contains(permission),
                "示例插件 {} 用到了 {}，清单必须声明它",
                folder,
                permission.as_str()
            );
        }
    }

    #[test]
    fn reference_sample_manifest_is_valid() {
        assert_sample_manifest_valid(
            "reference",
            &[
                PluginPermission::Storage,
                PluginPermission::Notification,
                // 插件之间通信（事件总线）
                PluginPermission::PluginCommunicate,
            ],
        );
    }

    // ============================================================
    // 音频导入
    // ============================================================

    /// 扩展名白名单必须**大小写不敏感**，并且拒绝非音频格式。
    #[test]
    fn audio_mime_only_accepts_known_extensions() {
        assert_eq!(audio_mime_for(Path::new("/x/sound.mp3")), Some("audio/mpeg"));
        assert_eq!(audio_mime_for(Path::new("/x/SOUND.MP3")), Some("audio/mpeg"));
        assert_eq!(audio_mime_for(Path::new("C:\\x\\a.WAV")), Some("audio/wav"));

        for bad in ["exe", "dll", "png", "txt", "mp4", "zip", "js"] {
            assert_eq!(
                audio_mime_for(Path::new(&format!("/x/file.{}", bad))),
                None,
                "{} 不应被当成音频接受",
                bad
            );
        }

        // 没有扩展名
        assert_eq!(audio_mime_for(Path::new("/x/sound")), None);
    }

    /// `AUDIO_EXTENSIONS`（对话框过滤器）与实际校验必须一致。
    ///
    /// 这是一处真实的漂移风险：过滤器里列了某扩展名、校验却不认，用户就会遇到
    /// 「在对话框里明明能选中，选完却报格式不支持」。把两者钉在一起，
    /// 以后只改一边就会红。
    #[test]
    fn audio_filter_list_matches_validator() {
        for ext in AUDIO_EXTENSIONS {
            assert!(
                audio_mime_for(Path::new(&format!("/x/file.{}", ext))).is_some(),
                "对话框过滤器里列了 {}，但校验不认它",
                ext
            );
        }
    }

    // ============================================================
    // 插件市场：哈希校验与索引地址策略
    // ============================================================

    /// 空内容的 SHA-256。
    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    /// 用**公开的已知向量**校验实现，而不是拿实现去校验实现 ——
    /// 后者在哈希算错时会一起错，测试照样全绿。
    #[test]
    fn sha256_matches_published_vectors() {
        assert_eq!(hex_sha256(b""), EMPTY_SHA256);
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_sha256_accepts_matching_content() {
        assert!(verify_sha256(b"", EMPTY_SHA256).is_ok());
    }

    /// 十六进制有大小写两种写法：`Get-FileHash` 给大写、`shasum` 给小写，
    /// 发布说明里还可能带首尾空白。这些都不该导致拒绝安装。
    #[test]
    fn verify_sha256_tolerates_case_and_whitespace() {
        assert!(verify_sha256(b"", &EMPTY_SHA256.to_ascii_uppercase()).is_ok());
        assert!(verify_sha256(b"", &format!("  {}  ", EMPTY_SHA256)).is_ok());
    }

    #[test]
    fn verify_sha256_rejects_mismatch() {
        let err = verify_sha256(b"tampered", EMPTY_SHA256).unwrap_err();
        assert!(
            matches!(err, PluginError::DownloadFailed(_)),
            "哈希不符应当报下载失败，实际: {:?}",
            err
        );
    }

    /// 残缺的哈希与「内容不符」必须给出**不同**的错误。
    ///
    /// 两者都拒绝安装，但原因完全不同：前者是索引写错了，后者才可能意味着下载链路
    /// 有问题。共用一条信息会让排查方向跑偏 —— 用户会去怀疑 CDN，而实际只是索引里
    /// 少复制了几位。
    #[test]
    fn verify_sha256_distinguishes_malformed_from_mismatch() {
        for malformed in [
            "abc123",                    // 太短
            &"z".repeat(64),             // 长度对但不是十六进制
            "",                          // 空
            &"a".repeat(63),             // 差一位
        ] {
            let err = verify_sha256(b"", malformed).unwrap_err();
            assert!(
                matches!(err, PluginError::InvalidPackage(_)),
                "格式非法应当报包非法（{}），实际: {:?}",
                malformed,
                err
            );
        }

        let err = verify_sha256(b"x", EMPTY_SHA256).unwrap_err();
        assert!(matches!(err, PluginError::DownloadFailed(_)));
    }

    // ---- 仓库内容的地址策略 ----

    #[test]
    fn registry_url_allows_known_hosts_over_https() {
        for url in [
            "https://cdn.jsdelivr.net/gh/Rinntheor/modulith-plugins@main/index.json",
            "https://raw.githubusercontent.com/Rinntheor/modulith-plugins/main/index.json",
        ] {
            assert!(ensure_registry_url_allowed(url).is_ok(), "应当允许: {}", url);
        }
    }

    /// 这条是**安全边界**，不是便利性检查。
    ///
    /// 该命令能取回任意文本，而插件与宿主同处一个 JavaScript 上下文、能够触达 IPC 桥。
    /// 若宿主不设白名单，一个**没有声明 `network-external`** 的插件就能借它发出任意外部
    /// 请求，把权限模型整个绕过去。
    ///
    /// 注意最后两条是「域名后缀伪装」：`cdn.jsdelivr.net.evil.com` 以白名单域名**开头**，
    /// 因此必须按完整宿主比较，不能按前缀匹配。
    #[test]
    fn registry_url_rejects_other_hosts_even_over_https() {
        for url in [
            "https://evil.example.com/index.json",
            "https://cdn.jsdelivr.net.evil.com/index.json",
            "https://raw.githubusercontent.com.evil.com/index.json",
        ] {
            let err = ensure_registry_url_allowed(url).unwrap_err();
            assert!(
                matches!(err, PluginError::SandboxViolation(_)),
                "不在白名单里的宿主必须被拒绝（{}），实际: {:?}",
                url,
                err
            );
        }
    }

    #[test]
    fn registry_url_requires_https_even_for_known_hosts() {
        let err = ensure_registry_url_allowed("http://cdn.jsdelivr.net/gh/x/y@main/index.json")
            .unwrap_err();
        assert!(
            matches!(err, PluginError::SandboxViolation(_)),
            "白名单宿主上的明文 http 也必须被拒绝，实际: {:?}",
            err
        );
    }

    #[test]
    fn registry_url_allows_loopback_for_local_debugging() {
        for url in [
            "http://127.0.0.1:8000/index.json",
            "http://localhost:8000/index.json",
            "http://[::1]:8000/index.json",
        ] {
            assert!(
                ensure_registry_url_allowed(url).is_ok(),
                "回环地址应当允许 http（便于本机调试）: {}",
                url
            );
        }
    }

    /// 「看起来像回环但不是」的地址必须被拒绝。
    ///
    /// 少了这条，`http://127.0.0.1.evil.com/` 这类域名就能绕过 https 与白名单 ——
    /// 它确实以 `127.0.0.1` 开头。
    #[test]
    fn registry_url_rejects_loopback_lookalikes() {
        for url in [
            "http://127.0.0.1.evil.com/index.json",
            "http://localhost.evil.com/index.json",
            "http://192.168.1.10/index.json",
        ] {
            assert!(ensure_registry_url_allowed(url).is_err(), "不该允许: {}", url);
        }
    }

    #[test]
    fn registry_url_rejects_non_http_schemes() {
        for url in ["file:///etc/passwd", "ftp://example.com/index.json", "not a url"] {
            assert!(ensure_registry_url_allowed(url).is_err(), "不该允许: {}", url);
        }
    }
}
