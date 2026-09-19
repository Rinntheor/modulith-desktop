// src-tauri/src/modules/settings/network.rs
//
// 网络访问方式：直连 GitHub，还是经由用户自己填的「下载源」（前缀式加速代理）。
//
// ============================================================
// 为什么代理只用「前缀拼接」这一种形式
// ============================================================
//
// 这类加速源（gh-proxy 系）的用法是把原始地址**整条接在自己的域名后面**：
//
//     https://gh-proxy.org/https://github.com/o/r/releases/download/v1/x.exe
//     └──── 代理根 ────┘└────────────── 原始地址 ──────────────────┘
//
// 因此不需要任何协议适配：只要知道「代理根」和「原始地址」，拼起来就是目标地址。
// 这也意味着代理**无法**改变我们要访问的内容 —— 它只能替我们去取同一份东西，
// 而「取到的是不是同一份」由既有的哈希校验（`.lcp`）与签名校验（索引、更新包）
// 保证，不由代理保证。
//
// ============================================================
// 为什么改写放在后端做，而不是前端拼好地址
// ============================================================
//
// 1. **白名单仍然只作用于原始地址。** `ensure_registry_url_allowed` 校验的是
//    `cdn.jsdelivr.net` / `raw.githubusercontent.com` 这些**我们自己写死的**宿主，
//    代理宿主从来不作为参数进入校验。若让前端拼好再传进来，就等于让被约束的一方
//    自己划定边界 —— 那正是 `manager.rs` 里那条注释在防的事。
// 2. **只有一处需要改。** 插件仓库内容、`.lcp` 下载、应用更新清单都经过这里，
//    将来再加一条网络通路也不会漏掉代理。
// 3. **代理不会成为新的信任输入。** `rewrite_url` 只做字符串前缀拼接：它既不解析
//    传入地址的语义，也不会把请求导向一个不在 `GITHUB_HOSTS` 里的目标。一个被
//    篡改的代理字段最多让请求失败，不能让它指向任意宿主。
//
// ============================================================
// 失败的姿态
// ============================================================
//
// 代理不可用时**回落到直连**（见调用方 `manager.rs` / `updater` 的两步重试）：
// 用户配代理是为了「更快/能通」，不是为了「只准走代理」。一个填错的代理如果直接把
// 插件市场与应用更新变成永久不可用，那这个设置项就成了破坏性的。

use super::settings::AppSettings;

/// 直连 GitHub（默认）
pub const NETWORK_MODE_DIRECT: &str = "direct";

/// 经由下载源 / 代理
pub const NETWORK_MODE_PROXY: &str = "proxy";

/// 代理根的字符数上限
///
/// 与 `MAX_MODULE_ID_LEN` 同类的「防手工改坏」上界：它会被写进设置文件、拼进日志。
/// 200 个字符足够容纳自建加速源的任意子路径，又不至于让日志被一行地址刷满。
pub const MAX_GITHUB_PROXY_LEN: usize = 200;

/// 走代理时会被改写的宿主。
///
/// **刻意用精确匹配（外加 `githubusercontent.com` 的子域后缀），不做通配。**
/// 这张表回答的是「哪些地址属于 GitHub 的下载链路」，而不是「哪些地址看起来像
/// GitHub」：`objects.githubusercontent.com` 是 release 资产真正的落点，
/// `codeload.github.com` 是源码打包，`api.github.com` 是 API。把它们列全，
/// 是为了让「开了代理却还是直连了 GitHub」这种事不发生。
const GITHUB_HOSTS: [&str; 8] = [
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "gist.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

/// 是否是「走代理时应当改写」的宿主
pub fn is_github_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    if GITHUB_HOSTS.contains(&host.as_str()) {
        return true;
    }
    // 子域（`gist.githubusercontent.com` 已经列了，这里覆盖将来新增的
    // `*.githubusercontent.com` 资产宿主）。用 `ends_with(".githubusercontent.com")`
    // 而不是 `contains`：后者会把 `githubusercontent.com.evil.tld` 也算进来。
    host.ends_with(".githubusercontent.com")
}

/// `networkMode` 是否是已知取值
pub fn is_valid_network_mode(mode: &str) -> bool {
    matches!(mode, NETWORK_MODE_DIRECT | NETWORK_MODE_PROXY)
}

/// 校验「代理根」的格式。
///
/// 空串是**合法**的：它表示「还没填」。是否真的走代理由 `networkMode` 决定，
/// 因此把「选了代理但没填地址」交给前端在界面上拦（那里能给出「请填写地址」这种
/// 有上下文的提示），而不是在这里报一个字段级的英文错误。
///
/// 与 `theme` 一样，这里**拒绝**而不是悄悄纠正：静默把 `gh-proxy.org` 补成
/// `https://gh-proxy.org/` 会让前端显示的值和实际存的值不一致。
pub fn validate_github_proxy(raw: &str) -> Result<(), String> {
    let invalid = |reason: &str| {
        Err(format!(
            "Invalid githubProxy \"{}\": {}",
            raw, reason
        ))
    };

    if raw.is_empty() {
        return Ok(());
    }

    if raw.chars().count() > MAX_GITHUB_PROXY_LEN {
        return invalid(&format!(
            "expected at most {} characters, got {}",
            MAX_GITHUB_PROXY_LEN,
            raw.chars().count()
        ));
    }

    // 空白字符在任何位置都是错的，而它造成的现象（地址被截断或拼出两个 URL）
    // 很难从报错里看出来，因此在入口就拒绝。
    if raw.chars().any(char::is_whitespace) {
        return invalid("whitespace is not allowed");
    }

    let parsed = match reqwest::Url::parse(raw) {
        Ok(parsed) => parsed,
        Err(e) => return invalid(&format!("not a valid URL ({})", e)),
    };

    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();

    // 与 `manager.rs` 的 `ensure_registry_url_allowed` 同一条规则：https，
    // 只有本机回环地址允许 http（本地自建加速源调试）。
    let loopback = host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);

    match parsed.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return invalid("must use https (http is only allowed for loopback hosts)"),
    }

    if host.is_empty() {
        return invalid("missing host");
    }

    if parsed.query().is_some() || parsed.fragment().is_some() {
        return invalid("must not contain a query string or fragment");
    }

    // 带凭据的地址会被拼进日志与错误信息里 —— 一条会漏密码的日志比没有日志更糟。
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return invalid("must not contain credentials");
    }

    Ok(())
}

/// 当前设置下实际生效的代理根（`None` = 直连）
///
/// 两个条件缺一不可：模式是 `proxy`，且地址非空。只判模式会让「选了代理但地址
/// 是空的」退化成把原始地址拼到一个空串上 —— 那会得到一个相对地址，最终表现为
/// 一个与网络无关的解析错误。
pub fn proxy_base(settings: &AppSettings) -> Option<&str> {
    if settings.network_mode != NETWORK_MODE_PROXY {
        return None;
    }
    let base = settings.github_proxy.trim();
    if base.is_empty() {
        return None;
    }
    Some(base)
}

/// 把原始地址拼到代理根后面
///
/// 尾部的 `/` 可有可无：用户会同时写出 `https://gh-proxy.org` 和
/// `https://gh-proxy.org/` 两种形式，而它们应当得到同一个结果。
pub fn join_proxy(base: &str, url: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), url)
}

/// 按当前设置改写一个地址（不需要改写时原样返回）
///
/// 只有 `GITHUB_HOSTS` 里的地址会被改写。jsDelivr 不在其中 —— 它是一个独立的
/// CDN 而不是 GitHub 的镜像，把它也拼到 GitHub 加速源上只会换来 404。
pub fn rewrite_url(url: &str, proxy: Option<&str>) -> String {
    let Some(base) = proxy else {
        return url.to_string();
    };

    match reqwest::Url::parse(url) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
            if is_github_host(&host) {
                join_proxy(base, url)
            } else {
                url.to_string()
            }
        }
        // 解析不了就原样返回：真正的报错留给实际发起请求的那一步，
        // 它能给出比这里更具体的信息（HTTP 状态、TLS 错误等）。
        Err(_) => url.to_string(),
    }
}

/// 给日志用的一句话描述
pub fn describe_mode(settings: &AppSettings) -> String {
    match proxy_base(settings) {
        Some(base) => format!("经下载源 {}", base),
        None => "直连".to_string(),
    }
}

/// 把一条错误展开成完整的因果链
///
/// `reqwest` 的顶层错误信息是 `error sending request for url (...)` —— 它把真正
/// 的原因（DNS 解析失败 / 证书不受信 / 连接被重置）藏在 `source()` 里。用户报
/// 「更新失败」时，我们要的恰恰是那一层：只有它才能区分「被墙」和「服务器 404」。
///
/// 去重是必要的：有些库会让相邻两层的 `Display` 完全相同，展开后会得到
/// 「A ← A ← B」这种读起来像噪声的句子。
pub fn describe_error_chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut current = error.source();

    while let Some(source) = current {
        let text = source.to_string();
        if !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        current = source.source();
    }

    parts.join(" ← ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxied(base: &str) -> AppSettings {
        AppSettings {
            network_mode: NETWORK_MODE_PROXY.to_string(),
            github_proxy: base.to_string(),
            ..AppSettings::default()
        }
    }

    #[test]
    fn classifies_github_hosts() {
        assert!(is_github_host("github.com"));
        assert!(is_github_host("raw.githubusercontent.com"));
        assert!(is_github_host("objects.githubusercontent.com"));
        assert!(is_github_host("GitHub.com"), "大小写不应影响判断");
        assert!(
            is_github_host("release-assets.githubusercontent.com"),
            "未列出的 githubusercontent 子域也应改写"
        );

        assert!(!is_github_host("cdn.jsdelivr.net"));
        assert!(!is_github_host("gh-proxy.org"));
        assert!(!is_github_host(""));
        // 关键反例：把 githubusercontent.com 当后缀匹配会误伤这类宿主
        assert!(!is_github_host("githubusercontent.com.evil.tld"));
        assert!(!is_github_host("notgithub.com"));
    }

    #[test]
    fn rewrites_only_github_urls() {
        let base = Some("https://gh-proxy.org");

        assert_eq!(
            rewrite_url("https://github.com/o/r/releases/download/v1/a.exe", base),
            "https://gh-proxy.org/https://github.com/o/r/releases/download/v1/a.exe"
        );
        assert_eq!(
            rewrite_url("https://raw.githubusercontent.com/o/r/main/i.json", base),
            "https://gh-proxy.org/https://raw.githubusercontent.com/o/r/main/i.json"
        );

        // jsDelivr 不是 GitHub，原样放行
        let jsdelivr = "https://cdn.jsdelivr.net/gh/o/r@main/index.json?t=1";
        assert_eq!(rewrite_url(jsdelivr, base), jsdelivr);

        // 直连模式下一切原样
        assert_eq!(
            rewrite_url("https://github.com/o/r", None),
            "https://github.com/o/r"
        );
    }

    #[test]
    fn join_proxy_normalizes_the_trailing_slash() {
        let url = "https://github.com/o/r";
        assert_eq!(join_proxy("https://gh-proxy.org", url), format!("https://gh-proxy.org/{url}"));
        assert_eq!(join_proxy("https://gh-proxy.org/", url), format!("https://gh-proxy.org/{url}"));
        // 自建加速源常带子路径
        assert_eq!(
            join_proxy("https://my.host/gh//", url),
            format!("https://my.host/gh/{url}")
        );
    }

    #[test]
    fn proxy_base_requires_both_mode_and_address() {
        assert_eq!(proxy_base(&AppSettings::default()), None, "默认是直连");

        let mut direct_with_address = AppSettings::default();
        direct_with_address.github_proxy = "https://gh-proxy.org".to_string();
        assert_eq!(
            proxy_base(&direct_with_address),
            None,
            "直连模式下即使填了地址也不生效"
        );

        let mut proxy_without_address = AppSettings::default();
        proxy_without_address.network_mode = NETWORK_MODE_PROXY.to_string();
        assert_eq!(proxy_base(&proxy_without_address), None, "代理模式但地址为空");

        let mut blank = AppSettings::default();
        blank.network_mode = NETWORK_MODE_PROXY.to_string();
        blank.github_proxy = "   ".to_string();
        assert_eq!(proxy_base(&blank), None, "只有空白也等于没填");

        assert_eq!(proxy_base(&proxied("https://v4.gh-proxy.org")), Some("https://v4.gh-proxy.org"));
    }

    #[test]
    fn accepts_reasonable_proxy_addresses() {
        for ok in [
            "",
            "https://gh-proxy.org",
            "https://gh-proxy.org/",
            "https://v4.gh-proxy.org/",
            "https://my.mirror.example.com/gh",
            "https://my.mirror.example.com/gh/",
            // 本机回环：本地自建加速源调试
            "http://127.0.0.1:8080",
            "http://localhost:1420/",
        ] {
            assert!(
                validate_github_proxy(ok).is_ok(),
                "应接受 {ok:?}：{:?}",
                validate_github_proxy(ok)
            );
        }
    }

    #[test]
    fn rejects_unusable_proxy_addresses() {
        assert!(validate_github_proxy(&"x".repeat(MAX_GITHUB_PROXY_LEN + 1)).is_err());
        assert!(validate_github_proxy("gh-proxy.org").is_err(), "缺 scheme");
        assert!(validate_github_proxy("https://").is_err(), "缺宿主");
        assert!(validate_github_proxy("ftp://gh-proxy.org").is_err(), "非 http(s)");
        assert!(
            validate_github_proxy("http://gh-proxy.org").is_err(),
            "非回环地址不允许明文 http"
        );
        assert!(
            validate_github_proxy("https://gh-proxy.org/ ").is_err(),
            "尾部空白会让拼接结果多出一个空格"
        );
        assert!(validate_github_proxy("https://gh-pro xy.org").is_err());
        assert!(validate_github_proxy("https://gh-proxy.org/?a=1").is_err());
        assert!(validate_github_proxy("https://gh-proxy.org/#x").is_err());
        assert!(
            validate_github_proxy("https://user:pw@gh-proxy.org").is_err(),
            "带凭据的地址会被写进日志"
        );
    }

    #[test]
    fn network_mode_is_enum_checked() {
        assert!(is_valid_network_mode(NETWORK_MODE_DIRECT));
        assert!(is_valid_network_mode(NETWORK_MODE_PROXY));
        assert!(!is_valid_network_mode(""));
        assert!(!is_valid_network_mode("Proxy"));
        assert!(!is_valid_network_mode("off"));
    }

    #[test]
    fn describe_mode_is_readable() {
        assert_eq!(describe_mode(&AppSettings::default()), "直连");
        assert_eq!(
            describe_mode(&proxied("https://gh-proxy.org")),
            "经下载源 https://gh-proxy.org"
        );
    }

    // ---- 错误因链 ----

    #[derive(Debug)]
    struct Inner;

    impl std::fmt::Display for Inner {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "dns error: failed to lookup address")
        }
    }

    impl std::error::Error for Inner {}

    #[derive(Debug)]
    struct Outer(Inner);

    impl std::fmt::Display for Outer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "error sending request")
        }
    }

    impl std::error::Error for Outer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn error_chain_is_fully_expanded() {
        let text = describe_error_chain(&Outer(Inner));
        assert!(text.contains("error sending request"), "{text}");
        assert!(
            text.contains("dns error"),
            "真正的原因（DNS）必须出现在结果里：{text}"
        );
        assert!(text.contains(" ← "), "应当用箭头连接因链：{text}");
    }

    /// 相邻两层 `Display` 相同时只保留一条 —— 否则日志里会出现「A ← A」。
    #[test]
    fn error_chain_drops_duplicate_consecutive_messages() {
        #[derive(Debug)]
        struct Same(String);

        impl std::fmt::Display for Same {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl std::error::Error for Same {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                None
            }
        }

        let text = describe_error_chain(&Same("同一句话".to_string()));
        assert_eq!(text, "同一句话");
    }
}
