// src-tauri/src/modules/plugins/validator.rs
// 插件清单校验 + 路径安全校验

use std::path::{Component, Path, PathBuf};

use super::types::{EngineAdvisory, PluginError, PluginManifest, PluginResult, SemVer, VersionRequirement};

/// 插件 ID 允许的字符集：字母数字开头，最长 64 字符。
///
/// 这里同时是**路径安全**的第一道防线：ID 会被直接 `join` 到插件目录与插件数据
/// 目录之下（见 `manager.rs` 的 `plugin_data_dir`），因此 `..`、`/`、`\`、盘符
/// 这类字符必须在此处就被挡掉，而不能依赖调用点各自的守卫 —— 只要有一个调用点
/// 忘了守卫，`..` 就能让 `join` 的结果指到应用数据目录本身。
pub fn is_valid_plugin_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first = bytes[0] as char;
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..].iter().all(|b| {
        let c = *b as char;
        c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
    })
}

/// 判断 `candidate` 是否位于 `root` **之内**（规范化后的前缀比较）
///
/// 任一侧无法规范化时返回 `false`（保守拒绝）。
///
/// **`candidate == root` 返回 `false`。** 本函数的调用点都是「删除」语义
/// （卸载插件要 `remove_dir_all` 目标目录），而 `root` 自身作为删除目标一定是
/// 误用：`plugins_dir.join(".")` 与 `plugins_dir.join("plugin_data/..")` 这类
/// 路径规范化后恰好等于 `root`，只比较前缀会放行，结果是整个 plugins 目录
/// （含 `registry.json`）被删掉。调用方要的是「root 里的某个条目」，
/// 因此这里要求候选路径严格位于 root 之下。
pub fn is_within(root: &Path, candidate: &Path) -> bool {
    match (root.canonicalize(), candidate.canonicalize()) {
        (Ok(root_canon), Ok(candidate_canon)) => {
            candidate_canon != root_canon && candidate_canon.starts_with(&root_canon)
        }
        _ => false,
    }
}

/// 相对路径安全检查：不得为绝对路径，不得含 `..` / 盘符前缀
fn is_safe_relative(rel: &str) -> bool {
    let path = Path::new(rel);
    if path.is_absolute() {
        return false;
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return false,
        }
    }
    !rel.trim().is_empty()
}

/// 在插件目录内安全地解析一个相对路径（用于 read_asset）
pub fn resolve_within(root: &Path, rel: &str) -> PluginResult<PathBuf> {
    if !is_safe_relative(rel) {
        return Err(PluginError::SandboxViolation(format!(
            "非法的相对路径: {}",
            rel
        )));
    }

    let joined = root.join(rel);
    if !joined.exists() {
        return Err(PluginError::NotFound(format!("资源不存在: {}", rel)));
    }

    if !is_within(root, &joined) {
        return Err(PluginError::SandboxViolation(format!(
            "路径越界: {}",
            rel
        )));
    }

    Ok(joined)
}

/// 评估插件声明的引擎范围与当前宿主版本的关系。
///
/// 三种结果，区分得很清楚：
///
/// | 情况 | 返回值 | 处理 |
/// | --- | --- | --- |
/// | 未声明 / `*` | `Ok(None)` | 不做任何提示 |
/// | 范围语法非法 | `Err(...)` | **硬错误**：连解析都做不到，说明清单确实写错了 |
/// | 语法正确但不匹配 | `Ok(Some(advisory))` | **仅提示**，安装与加载照常 |
///
/// 第三种情况刻意不阻止安装。`engines.loopcore` 在 0.x 阶段极其脆弱：
/// `^0.2.0` 等价于 `>=0.2.0 <0.3.0`，宿主升一个小版本就会让所有
/// 写 `^0.2.x` 的插件"声明不匹配"，而这并不代表插件真的不能运行。
/// 早先的实现把它当硬错误，直接导致用户升级应用后无法再安装任何旧插件。
///
/// 因此这里的判断标准是：**语法错误是错误，兼容性猜测不是**。
pub fn evaluate_engine(manifest: &PluginManifest) -> PluginResult<Option<EngineAdvisory>> {
    let range = manifest.engines.loopcore.trim();
    if range.is_empty() || range == "*" {
        return Ok(None);
    }

    let host_version = env!("CARGO_PKG_VERSION");
    let host = SemVer::parse(host_version)
        .map_err(|e| PluginError::InvalidManifest(format!("本程序版本号非法: {}", e)))?;

    let requirement = VersionRequirement::parse(range)
        .map_err(|e| PluginError::InvalidManifest(format!("engines.loopcore 非法: {}", e)))?;

    if requirement.matches(&host) {
        return Ok(None);
    }

    Ok(Some(EngineAdvisory {
        required: range.to_string(),
        host: host_version.to_string(),
        message: format!(
            "插件声明需要 Modulith {range}，当前为 {host_version}。已按可安装处理，但该插件可能使用了当前版本不支持的能力；若加载失败会在插件列表中标记为异常。"
        ),
    }))
}

/// 校验插件清单
///
/// - `name` 合法
/// - `version` 可解析
/// - `engines.loopcore` 语法合法（**不匹配不阻止安装**，见 `evaluate_engine`）
/// - `main` 为安全的相对路径且真实存在于 `plugin_root` 下
/// - `style` / `icon` 缺失只警告，不失败
pub fn validate_manifest(manifest: &PluginManifest, plugin_root: &Path) -> PluginResult<()> {
    if !is_valid_plugin_name(&manifest.name) {
        return Err(PluginError::InvalidManifest(format!(
            "插件名非法（只允许字母数字 . _ -，最长 64 字符）: {}",
            manifest.name
        )));
    }

    SemVer::parse(&manifest.version)
        .map_err(|e| PluginError::InvalidManifest(format!("version 非法: {}", e)))?;

    // 语法非法 → 拒绝；版本不匹配 → 只记一条警告，放行
    if let Some(advisory) = evaluate_engine(manifest)? {
        log::warn!("插件 {} 的引擎范围不匹配：{}", manifest.name, advisory.message);
    }

    if !is_safe_relative(&manifest.main) {
        return Err(PluginError::InvalidManifest(format!(
            "main 必须是插件目录内的相对路径: {}",
            manifest.main
        )));
    }
    if !plugin_root.join(&manifest.main).is_file() {
        return Err(PluginError::InvalidManifest(format!(
            "main 入口文件不存在: {}",
            manifest.main
        )));
    }

    if let Some(style) = manifest.style.as_deref() {
        if !plugin_root.join(style).is_file() {
            log::warn!("插件 {} 声明的样式文件不存在: {}", manifest.name, style);
        }
    }
    if let Some(icon) = manifest.icon.as_deref() {
        if !plugin_root.join(icon).is_file() {
            log::warn!("插件 {} 声明的图标不存在: {}", manifest.name, icon);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_name_rules() {
        assert!(is_valid_plugin_name("hello"));
        assert!(is_valid_plugin_name("hello-world_1.0"));
        assert!(!is_valid_plugin_name(""));
        assert!(!is_valid_plugin_name("-hello"));
        assert!(!is_valid_plugin_name("hello world"));
        assert!(!is_valid_plugin_name(&"a".repeat(65)));
    }

    /// 插件 ID 会被直接 `join` 到插件目录与插件数据目录之下，因此这些取值
    /// 必须被拒绝 —— 否则 `storage_clear("..")` 之类的调用会把 `join` 的结果
    /// 指向应用数据目录本身。
    ///
    /// 注意 `".."` 之所以在这里就被挡住，靠的是「首字符必须是字母数字」，
    /// 而不是某处专门识别了 `..`；`.` 与 `-` 虽然允许出现在**后续**位置，
    /// 但首字符限制已经排除了 `..`、`./x`、`../x` 这类以点开头的取值。
    #[test]
    fn plugin_name_rejects_path_traversal_inputs() {
        for evil in [
            "..", "../..", ".", "./x", "../x", "a/../..", "a/../../b", "a/b", "/abs", "\\abs",
            "C:\\Windows", "a/..", "..\\x", "x\\..\\y",
        ] {
            assert!(
                !is_valid_plugin_name(evil),
                "路径穿越取值必须被拒绝: {evil:?}"
            );
        }
    }

    /// `is_within` 必须拒绝候选路径等于 root 本身。
    ///
    /// 修复前它是纯前缀比较，`candidate == root` 会返回 true；而调用点都是
    /// 「删除」语义，`plugins_dir.join(".")`、`plugins_dir.join("plugin_data/..")`
    /// 规范化后恰好等于 root，于是守卫放行、整个 plugins 目录（含 registry.json）
    /// 被 `remove_dir_all` 删掉。
    #[test]
    fn is_within_rejects_root_itself() {
        let root = std::env::temp_dir().join(format!(
            "modulith-is-within-{}",
            std::process::id()
        ));
        let inner = root.join("inner");
        let sibling = std::env::temp_dir().join(format!(
            "modulith-is-within-sibling-{}",
            std::process::id()
        ));

        std::fs::create_dir_all(&inner).expect("create temp dirs");
        std::fs::create_dir_all(&sibling).expect("create sibling");

        // 正常目标：root 之下的条目
        assert!(is_within(&root, &inner), "root 的子目录应当在范围内");
        // 核心回归：root 自身必须被拒绝，否则 remove_dir_all 会删掉 root
        assert!(!is_within(&root, &root), "root 自身不得被视为「范围内」");
        // 经 `..` 绕回 root 也必须被拒绝
        assert!(
            !is_within(&root, &inner.join("..")),
            "inner/.. 规范化后等于 root，必须被拒绝"
        );
        // 范围之外
        assert!(!is_within(&root, &sibling), "root 之外的目录不得放行");
        // 不存在的路径无法规范化 → 保守拒绝
        assert!(
            !is_within(&root, &root.join("does-not-exist")),
            "无法规范化的候选路径必须被保守拒绝"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&sibling);
    }

    #[test]
    fn relative_path_rules() {
        assert!(is_safe_relative("dist/index.js"));
        assert!(!is_safe_relative("../evil.js"));
        assert!(!is_safe_relative("a/../../evil.js"));
        assert!(!is_safe_relative("C:/Windows/system32"));
        assert!(!is_safe_relative(""));
    }

    // ---------- 引擎范围 ----------

    fn manifest_with_engine(range: &str) -> PluginManifest {
        let mut manifest = PluginManifest::fallback("com.example.test", "1.0.0");
        manifest.engines.loopcore = range.to_string();
        manifest
    }

    #[test]
    fn engine_absent_or_wildcard_produces_no_advisory() {
        assert!(evaluate_engine(&manifest_with_engine("")).unwrap().is_none());
        assert!(evaluate_engine(&manifest_with_engine("*")).unwrap().is_none());
        assert!(evaluate_engine(&manifest_with_engine("   ")).unwrap().is_none());
    }

    /// 宿主自身版本必须总是匹配带宽松下界的范围 —— 否则说明版本解析出了问题。
    #[test]
    fn engine_current_host_satisfies_open_lower_bounds() {
        let host = env!("CARGO_PKG_VERSION");
        for range in [format!(">={host}"), format!("^{host}"), format!("<={host}")] {
            assert!(
                evaluate_engine(&manifest_with_engine(&range)).unwrap().is_none(),
                "范围 {range} 应匹配当前宿主 {host}"
            );
        }
    }

    /// 核心回归：**不匹配的范围不再产生错误**，只产生提示。
    ///
    /// 这条测试锁定的是「升级应用后旧插件无法再安装」这个缺陷不会回来。
    #[test]
    fn engine_mismatch_is_advisory_not_error() {
        // 一个不可能匹配的范围
        let manifest = manifest_with_engine(">=99.0.0");

        let advisory = evaluate_engine(&manifest)
            .expect("不匹配必须是 Ok(Some(_)) 而不是 Err —— 否则会阻止安装")
            .expect("应当产生提示");

        assert_eq!(advisory.required, ">=99.0.0");
        assert_eq!(advisory.host, env!("CARGO_PKG_VERSION"));
        // 提示必须同时给出插件的要求与本机版本，否则用户无法判断
        assert!(advisory.message.contains(">=99.0.0"));
        assert!(advisory.message.contains(env!("CARGO_PKG_VERSION")));
    }

    /// 0.x 阶段的 caret 语义：`^0.2.0` 等价于 `>=0.2.0 <0.3.0`。
    /// 这条测试固定住这个事实 —— 它是「升一个小版本就全部不匹配」的根源，
    /// 也解释了为什么引擎范围不能用来阻止安装。
    #[test]
    fn caret_on_zero_major_locks_the_minor() {
        let req = VersionRequirement::parse("^0.2.0").expect("parse");
        let in_range = SemVer::parse("0.2.9").expect("parse");
        let out_of_range = SemVer::parse("0.3.0").expect("parse");

        assert!(req.matches(&in_range), "^0.2.0 应匹配 0.2.9");
        assert!(!req.matches(&out_of_range), "^0.2.0 不应匹配 0.3.0（minor 已变）");
    }

    /// 语法非法仍然是硬错误：连解析都做不到说明清单确实写错了。
    #[test]
    fn malformed_engine_range_is_still_an_error() {
        assert!(evaluate_engine(&manifest_with_engine("not-a-version")).is_err());
    }

    /// 完整校验流程：范围不匹配不得导致 `validate_manifest` 失败。
    #[test]
    fn validate_manifest_tolerates_engine_mismatch() {
        let dir = std::env::temp_dir().join(format!("modulith-validator-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("dist")).expect("create temp dir");
        std::fs::write(dir.join("dist/index.js"), "// stub").expect("write entry");

        let mut manifest = manifest_with_engine(">=99.0.0");
        manifest.main = "dist/index.js".to_string();

        let outcome = validate_manifest(&manifest, &dir);
        assert!(
            outcome.is_ok(),
            "引擎范围不匹配不应阻止安装，实际: {outcome:?}"
        );

        // 但入口缺失仍然是硬错误
        manifest.main = "dist/missing.js".to_string();
        assert!(validate_manifest(&manifest, &dir).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
