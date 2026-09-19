// src-tauri/src/modules/plugins/types.rs
// Modulith 运行时插件系统 - 类型定义
//
// 这里定义的是「冻结的 JSON 契约」：字段序列化后必须与前端
// `src/services/pluginRuntime.ts` 中的 TS 接口逐字段一致（camelCase）。

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

// ============================================================
// 语义化版本
// ============================================================

/// 版本解析 / 版本要求错误
#[derive(Debug, thiserror::Error)]
pub enum VersionError {
    #[error("版本格式非法: {0}")]
    InvalidFormat(String),
    #[error("版本号非法: {0}")]
    InvalidNumber(String),
    #[error("版本要求非法: {0}")]
    InvalidRequirement(String),
}

/// 语义化版本（major.minor.patch[-prerelease][+build]）
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Option<String>,
    pub build: Option<String>,
    /// 原始字符串（比较时不参与）
    pub raw: String,
}

impl SemVer {
    /// 解析 `1.2.3` / `1.2.3-beta.1` / `1.2.3+build.5`
    pub fn parse(version: &str) -> Result<Self, VersionError> {
        let raw = version.trim().to_string();
        let without_build = raw.split('+').next().unwrap_or(&raw);
        let (core, prerelease) = match without_build.split_once('-') {
            Some((v, p)) => (v, Some(p.to_string())),
            None => (without_build, None),
        };

        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 {
            return Err(VersionError::InvalidFormat(raw));
        }

        let parse_num = |s: &str| -> Result<u64, VersionError> {
            if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
                return Err(VersionError::InvalidNumber(s.to_string()));
            }
            s.parse::<u64>()
                .map_err(|_| VersionError::InvalidNumber(s.to_string()))
        };

        let major = parse_num(parts[0])?;
        let minor = parse_num(parts[1])?;
        let patch = parse_num(parts[2])?;

        Ok(Self {
            major,
            minor,
            patch,
            prerelease,
            build: None,
            raw,
        })
    }

    /// 是否满足某个版本要求（如 `^1.2.0`）
    pub fn satisfies(&self, requirement: &str) -> Result<bool, VersionError> {
        Ok(VersionRequirement::parse(requirement)?.matches(self))
    }

    /// 比较两个版本（预发布版本优先级低于正式版本）
    pub fn compare(&self, other: &Self) -> Ordering {
        match self.major.cmp(&other.major) {
            Ordering::Equal => {}
            ord => return ord,
        }
        match self.minor.cmp(&other.minor) {
            Ordering::Equal => {}
            ord => return ord,
        }
        match self.patch.cmp(&other.patch) {
            Ordering::Equal => {}
            ord => return ord,
        }
        match (&self.prerelease, &other.prerelease) {
            (None, None) => Ordering::Equal,
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some(a), Some(b)) => compare_prerelease(a, b),
        }
    }
}

/// 逐段比较预发布标识（数字段按数值比较，其余按字典序，数字 < 字母）
fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let a_parts: Vec<&str> = a.split('.').collect();
    let b_parts: Vec<&str> = b.split('.').collect();

    for i in 0..a_parts.len().max(b_parts.len()) {
        match (a_parts.get(i), b_parts.get(i)) {
            (Some(x), Some(y)) => {
                let x_num = x.parse::<u64>().ok();
                let y_num = y.parse::<u64>().ok();
                let ord = match (x_num, y_num) {
                    (Some(nx), Some(ny)) => nx.cmp(&ny),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => break,
        }
    }

    Ordering::Equal
}

impl std::fmt::Display for SemVer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.prerelease {
            write!(f, "-{}", pre)?;
        }
        if let Some(build) = &self.build {
            write!(f, "+{}", build)?;
        }
        Ok(())
    }
}

// ============================================================
// 版本要求
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comparator {
    Exact,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    Caret,
    Tilde,
    Wildcard,
}

#[derive(Debug, Clone)]
pub struct VersionRequirement {
    pub comparator: Comparator,
    pub version: SemVer,
}

impl VersionRequirement {
    /// 解析 `*` / `1.2.3` / `^1.2.3` / `~1.2.3` / `>=1.0.0` ...
    pub fn parse(req: &str) -> Result<Self, VersionError> {
        let req = req.trim();

        if req.is_empty() || req == "*" {
            return Ok(Self {
                comparator: Comparator::Wildcard,
                version: SemVer {
                    major: 0,
                    minor: 0,
                    patch: 0,
                    prerelease: None,
                    build: None,
                    raw: "*".to_string(),
                },
            });
        }

        let (comparator, version_str) = if let Some(v) = req.strip_prefix("^") {
            (Comparator::Caret, v)
        } else if let Some(v) = req.strip_prefix("~") {
            (Comparator::Tilde, v)
        } else if let Some(v) = req.strip_prefix(">=") {
            (Comparator::GreaterThanOrEqual, v)
        } else if let Some(v) = req.strip_prefix("<=") {
            (Comparator::LessThanOrEqual, v)
        } else if let Some(v) = req.strip_prefix(">") {
            (Comparator::GreaterThan, v)
        } else if let Some(v) = req.strip_prefix("<") {
            (Comparator::LessThan, v)
        } else if let Some(v) = req.strip_prefix('=') {
            (Comparator::Exact, v)
        } else {
            (Comparator::Exact, req)
        };

        let version = SemVer::parse(version_str)?;
        Ok(Self {
            comparator,
            version,
        })
    }

    /// 判断版本是否满足本要求
    pub fn matches(&self, version: &SemVer) -> bool {
        match self.comparator {
            Comparator::Wildcard => true,
            Comparator::Exact => version.compare(&self.version) == Ordering::Equal,
            Comparator::GreaterThan => version.compare(&self.version) == Ordering::Greater,
            Comparator::GreaterThanOrEqual => version.compare(&self.version) != Ordering::Less,
            Comparator::LessThan => version.compare(&self.version) == Ordering::Less,
            Comparator::LessThanOrEqual => version.compare(&self.version) != Ordering::Greater,
            // ^1.2.3 => >=1.2.3 <2.0.0（0.x 时锁定到 0.minor）
            Comparator::Caret => {
                if self.version.major > 0 {
                    version.major == self.version.major
                        && version.compare(&self.version) != Ordering::Less
                } else {
                    version.major == 0
                        && version.minor == self.version.minor
                        && version.compare(&self.version) != Ordering::Less
                }
            }
            // ~1.2.3 => >=1.2.3 <1.3.0
            Comparator::Tilde => {
                version.major == self.version.major
                    && version.minor == self.version.minor
                    && version.compare(&self.version) != Ordering::Less
            }
        }
    }
}

// ============================================================
// 权限 / 沙箱
// ============================================================

/// 插件权限（kebab-case 序列化）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum PluginPermission {
    Storage,
    Network,
    NetworkExternal,
    Notification,
    Clipboard,
    FilesystemRead,
    FilesystemWrite,
    FilesystemScoped,
    PluginCommunicate,
    NativeModule,
    DevTools,
    ProcessSpawn,
}

impl PluginPermission {
    /// 权限的 kebab-case 名称，用于错误信息与日志。
    ///
    /// 必须与上面的 `#[serde(rename_all = "kebab-case")]` 逐字一致：清单里写的
    /// 就是这个字面量，用户看到的错误信息若与之对不上就无法排查。
    /// `permission_name_matches_serde` 测试遍历 `ALL` 锁定两者一致，因此新增
    /// 枚举值后忘记同步会让测试失败，而不是悄悄产生一条拼错的错误信息。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Storage => "storage",
            Self::Network => "network",
            Self::NetworkExternal => "network-external",
            Self::Notification => "notification",
            Self::Clipboard => "clipboard",
            Self::FilesystemRead => "filesystem-read",
            Self::FilesystemWrite => "filesystem-write",
            Self::FilesystemScoped => "filesystem-scoped",
            Self::PluginCommunicate => "plugin-communicate",
            Self::NativeModule => "native-module",
            Self::DevTools => "dev-tools",
            Self::ProcessSpawn => "process-spawn",
        }
    }

    /// 全部取值，供测试遍历。
    ///
    /// 新增枚举值时必须一并加入 —— 否则上面那个一致性测试覆盖不到新值，
    /// 而"测试通过"会给人已经覆盖了的错觉。
    pub const ALL: [PluginPermission; 12] = [
        Self::Storage,
        Self::Network,
        Self::NetworkExternal,
        Self::Notification,
        Self::Clipboard,
        Self::FilesystemRead,
        Self::FilesystemWrite,
        Self::FilesystemScoped,
        Self::PluginCommunicate,
        Self::NativeModule,
        Self::DevTools,
        Self::ProcessSpawn,
    ];
}

/// 沙箱级别（序列化为数字 0-3）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(from = "u8", into = "u8")]
#[repr(u8)]
pub enum SandboxLevel {
    /// 无网络、无文件系统、仅 UI
    #[default]
    L0 = 0,
    /// 有限网络、localStorage
    L1 = 1,
    /// 完全网络、受限文件系统
    L2 = 2,
    /// 完全访问（需用户确认）
    L3 = 3,
}

impl From<SandboxLevel> for u8 {
    fn from(level: SandboxLevel) -> Self {
        level as u8
    }
}

impl From<u8> for SandboxLevel {
    fn from(value: u8) -> Self {
        match value {
            0 => SandboxLevel::L0,
            1 => SandboxLevel::L1,
            2 => SandboxLevel::L2,
            3 => SandboxLevel::L3,
            // 未知级别按最保守（L1）处理，而不是让整份清单解析失败
            _ => SandboxLevel::L1,
        }
    }
}

// ============================================================
// 清单
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginAuthor {
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginRepository {
    #[serde(rename = "type")]
    pub repo_type: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginEngines {
    #[serde(default = "default_engine_range")]
    pub loopcore: String,
}

pub fn default_engine_range() -> String {
    "*".to_string()
}

impl Default for PluginEngines {
    fn default() -> Self {
        Self {
            loopcore: default_engine_range(),
        }
    }
}

fn default_main_entry() -> String {
    "dist/index.js".to_string()
}

/// 插件清单（manifest.json）
///
/// 反序列化时非常宽容：只有 `name` / `version` 是必需的，
/// 其余字段缺失都会退化为默认值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    // ---- 基本信息 ----
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,

    // ---- 作者信息 ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<PluginAuthor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<PluginRepository>,

    // ---- 分类与标签 ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,

    // ---- 引擎要求 ----
    #[serde(default)]
    pub engines: PluginEngines,

    // ---- 入口文件 ----
    #[serde(default = "default_main_entry")]
    pub main: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_svg: Option<String>,

    // ---- 权限 ----
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    #[serde(default = "default_sandbox_level")]
    pub sandbox_level: SandboxLevel,

    // ---- 激活事件 ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_events: Option<Vec<String>>,

    // ---- 贡献点 ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contributes: Option<serde_json::Value>,

    // ---- 其他 ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deprecated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_by: Option<String>,
}

fn default_sandbox_level() -> SandboxLevel {
    SandboxLevel::L1
}

impl PluginManifest {
    /// 兜底清单：仅用于 manifest.json 损坏时仍向前端展示条目
    pub fn fallback(id: &str, version: &str) -> Self {
        Self {
            name: id.to_string(),
            display_name: id.to_string(),
            version: version.to_string(),
            description: String::new(),
            author: None,
            license: None,
            homepage: None,
            repository: None,
            keywords: None,
            categories: None,
            engines: PluginEngines::default(),
            main: default_main_entry(),
            style: None,
            icon: None,
            icon_svg: None,
            permissions: Vec::new(),
            sandbox_level: default_sandbox_level(),
            activation_events: None,
            contributes: None,
            preview: None,
            deprecated: None,
            replaced_by: None,
        }
    }

    /// 补齐可推导的默认值（必须在反序列化之后调用）
    pub fn normalize(&mut self) {
        if self.display_name.trim().is_empty() {
            self.display_name = self.name.clone();
        }
        if self.main.trim().is_empty() {
            self.main = default_main_entry();
        }
        if self.engines.loopcore.trim().is_empty() {
            self.engines.loopcore = default_engine_range();
        }
    }
}

// ============================================================
// 安装/导出相关契约
// ============================================================

/// 插件状态（前端 `PluginStatus`）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginStatus {
    Enabled,
    Disabled,
    Error,
}

/// 引擎兼容性提示（不阻止安装与加载）
///
/// 背景：`engines.loopcore` 曾经是**高度脆弱**的约束。在 0.x 阶段，
/// `^0.2.0` 按 semver 的 caret 规则（见 `VersionRequirement::matches`，
/// 与 npm 一致）等价于 `>=0.2.0 <0.3.0` —— 宿主只要升一个小版本，
/// 所有写了 `^0.2.x` 的插件就都不再满足声明范围。
///
/// 1.0 之后 caret 语义恢复正常（`^1.0.0` = `>=1.0.0 <2.0.0`，跨次版本不失配），
/// 但**这个提示机制仍然保留**：只带下界的写法（`>=1.0.0`）比 caret 更宽松，
/// 而把声明层面的差异渲染成"不可用"始终是错的。
///
/// 早期实现把不匹配当作**安装失败的硬错误**，后果是：
/// 已装的插件在升级应用后依然能加载（`list()` 不做引擎校验），
/// 但用户再也无法重装或安装同一插件的新版本，界面只给一句
/// 「插件要求 Modulith ^0.2.0，当前版本为 0.3.0」，看起来就像
/// 「升级应用把插件全废了」。
///
/// 现在的策略：引擎范围只作为**提示**呈现，安装与加载照常进行。
/// 理由是这样更诚实也更可用：
///   * 插件的实际兼容性由它的代码决定，声明范围只是作者的保守估计；
///   * 真的不兼容时，插件加载会失败并在界面标为「异常」，用户看得到；
///   * 用一个事前猜测去否定事后可验证的事实，代价是用户完全无法使用插件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAdvisory {
    /// 插件声明的引擎范围（原文）
    pub required: String,
    /// 当前宿主版本
    pub host: String,
    /// 可直接展示给用户的中文说明
    pub message: String,
}

/// 已安装插件（每次从磁盘上的 manifest.json 重建）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub version: String,
    pub path: String,
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub status: PluginStatus,
    /// rfc3339
    pub installed_at: String,
    /// "file" | "folder" | "url"
    pub source: String,
    pub size_bytes: u64,
    pub has_style: bool,
    pub readme: Option<String>,
    /// 开发链接：该插件正在从哪个源目录实时读取（「从目录安装」才有）。
    ///
    /// 界面据此显示「开发模式」标记，让用户明白为什么改完源目录点刷新就生效、
    /// 以及为什么卸载插件不会删掉他的源目录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_source: Option<String>,
    /// 引擎范围不匹配时的提示；`None` 表示要么没声明、要么匹配
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_advisory: Option<EngineAdvisory>,
}

/// registry.json 中的一条记录（保持精简，详情走 manifest.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    pub installed_at: String,
    pub source: String,
    /// 「从本地目录安装」时记录的**源目录绝对路径**（开发链接）。
    ///
    /// 为什么必须记下来：从目录安装原先只是把文件复制进插件目录，源路径就此
    /// 丢失。于是开发者在源目录里改代码，应用读到的仍是那份旧副本 ——
    /// 「刷新无效，必须删掉插件重装」。
    ///
    /// 记下源目录后，只要它还是一片有效的、同名的插件目录，读取资源与清单就都
    /// 走源目录，改完点刷新即生效（见 `resolve_asset_root`）。
    /// 旧注册表里没有这个字段，`serde(default)` 让它们照常加载。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

/// registry.json 文件结构
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RegistryFile {
    #[serde(default)]
    pub plugins: std::collections::HashMap<String, RegistryEntry>,
}

/// 导出结果（前端 `ExportOutcome`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub cancelled: bool,
    pub path: Option<String>,
    pub bytes: u64,
}

impl ExportOutcome {
    pub fn cancelled() -> Self {
        Self {
            cancelled: true,
            path: None,
            bytes: 0,
        }
    }

    pub fn exported(path: String, bytes: u64) -> Self {
        Self {
            cancelled: false,
            path: Some(path),
            bytes,
        }
    }
}

/// 插件导入的音频文件（前端 `PickedAudio`）
///
/// `data_url` 已经是能直接交给 `new Audio(...)` 的完整 data URL，插件因此
/// **不需要**接触原始字节或路径 —— 扩展名校验与体积上限都收在宿主这一处。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedAudio {
    /// 原始文件名，界面上显示「当前提示音：xxx.mp3」用
    pub name: String,
    /// 形如 `data:audio/mpeg;base64,...`
    pub data_url: String,
    /// 原始字节数，便于界面显示体积
    pub bytes: u64,
}

/// 插件请求代理的响应（前端 `HttpResponse`）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
}

// ============================================================
// 错误
// ============================================================

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("插件不存在: {0}")]
    NotFound(String),

    #[error("插件已安装: {0}")]
    AlreadyInstalled(String),

    #[error("清单非法: {0}")]
    InvalidManifest(String),

    #[error("权限不足: {0}")]
    PermissionDenied(String),

    #[error("沙箱限制: {0}")]
    SandboxViolation(String),

    #[error("包非法: {0}")]
    InvalidPackage(String),

    #[error("下载失败: {0}")]
    DownloadFailed(String),

    #[error("解压失败: {0}")]
    ExtractionFailed(String),

    #[error("对话框不可用: {0}")]
    DialogUnavailable(String),

    #[error("IO 错误: {0}")]
    IoError(#[from] std::io::Error),

    #[error("JSON 错误: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("版本错误: {0}")]
    VersionError(#[from] VersionError),

    #[error("网络错误: {0}")]
    NetworkError(String),

    #[error("图标提取失败: {0}")]
    IconExtractionFailed(String),
}

impl From<reqwest::Error> for PluginError {
    /// 保留完整的**因果链**，而不是只取顶层那句话。
    ///
    /// `reqwest` 的顶层 Display 是 `error sending request for url (...)`，真正的原因
    /// （DNS 解析失败 / 证书不受信 / 连接被重置）在它的 `source()` 里。只取顶层会让
    /// 「被墙」「证书过期」「域名写错」在界面上长得一模一样 —— 而它们要采取的动作
    /// 完全不同。展开见 `settings/network.rs` 的 `describe_error_chain`。
    fn from(err: reqwest::Error) -> Self {
        PluginError::NetworkError(crate::modules::settings::network::describe_error_chain(&err))
    }
}

impl From<zip::result::ZipError> for PluginError {
    fn from(err: zip::result::ZipError) -> Self {
        PluginError::ExtractionFailed(err.to_string())
    }
}

pub type PluginResult<T> = Result<T, PluginError>;
