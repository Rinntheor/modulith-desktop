// src-tauri/src/modules/plugins/signature.rs
// 插件索引的签名校验
//
// 索引是插件分发的**信任根**：它同时给出「装什么」与「校验哪个哈希」。一个被替换的索引
// 可以连同包和哈希一起换掉，因此 sha256 只挡得住传输损坏，挡不住有意的替换 ——
// 索引本身必须能验证来源。
//
// 签名用与应用更新**同一对密钥**：私钥在维护者手里，公钥随应用发布。因此这里不在代码里
// 再保存一份公钥，而是从运行时配置（`tauri.conf.json` 的 `plugins.updater.pubkey`）读 ——
// 两处保存必然漂移，而漂移的表现是「应用更新能用、插件市场打不开」这种极难归因的组合。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;

use super::types::{PluginError, PluginResult};

/// base64 解码并转成文本。
///
/// 公钥与签名在 tauri 的体系里都是「minisign 文本的 base64」—— 也就是 `.pub` / `.sig`
/// 文件的**内容本身**。这与「把 `.pub` 文件内容粘进 tauri.conf.json」是同一套约定，
/// 因此这里不做任何灵活性处理：多一种接受的格式，就多一种两边不一致的可能。
fn base64_to_text(value: &str, what: &str) -> PluginResult<String> {
    let decoded = BASE64
        .decode(value.trim())
        .map_err(|e| PluginError::InvalidPackage(format!("{}不是合法的 base64：{}", what, e)))?;

    String::from_utf8(decoded)
        .map_err(|_| PluginError::InvalidPackage(format!("{}解码后不是合法的 UTF-8", what)))
}

/// 从 `plugins.updater` 的配置值里取出公钥。
///
/// 抽成纯函数是为了可测：命令一侧需要 `AppHandle`，单测里造不出来。
///
/// 缺公钥时**必须报错而不是放行**。少一个字段就让校验静默跳过，等于把整套签名机制变成
/// 可选项 —— 而它恰恰是不可选的那一类：它守的是"装什么代码"。
pub fn pubkey_from_plugin_config(updater: Option<&Value>) -> PluginResult<String> {
    updater
        .and_then(|value| value.get("pubkey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            PluginError::InvalidManifest(
                "tauri.conf.json 里缺少 plugins.updater.pubkey，无法校验插件索引".to_string(),
            )
        })
}

/// 校验索引文本的签名。
///
/// `allow_legacy` 传 `true`，与 updater 插件校验更新包时**完全一致**。两者接受的是同一个
/// `tauri signer` 的产物，一处严格一处宽松就会出现「更新包能验、索引验不了」这种只在一半
/// 路径上失败的现象，而那正是最难排查的一类不一致。
///
/// 两类失败给出**不同**的错误：格式问题报「包非法」（文件没取对），验签失败报「下载失败」
/// （来源不可信）。两者的排查方向完全不同 —— 前者查网络与路径，后者查密钥与发布流程。
pub fn verify_index_signature(
    index_text: &str,
    signature_base64: &str,
    pubkey_base64: &str,
) -> PluginResult<()> {
    let pubkey_text = base64_to_text(pubkey_base64, "公钥")?;
    let public_key = PublicKey::decode(&pubkey_text)
        .map_err(|e| PluginError::InvalidPackage(format!("公钥无法解析：{}", e)))?;

    let signature_text = base64_to_text(signature_base64, "签名")?;
    let signature = Signature::decode(&signature_text)
        .map_err(|e| PluginError::InvalidPackage(format!("签名无法解析：{}", e)))?;

    public_key
        .verify(index_text.as_bytes(), &signature, true)
        .map_err(|e| {
            PluginError::DownloadFailed(format!(
                "插件索引验签失败（{}）：它可能已被替换，或索引更新后没有重新签名。已拒绝使用该索引。",
                e
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 本项目真实的公钥（`tauri.conf.json` 里那一份）。公钥是公开信息，写进测试没有问题。
    const REAL_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFBMUEwMDdDMjZGQjUzNgpSV1EydFcvQ0I2Q2hDcnR2S2I1VCtrTDlkdXpwb2pvcXdOOWNNTFRvakRpWVJQNEh1T21FVXVJbAo=";

    #[test]
    fn pubkey_is_read_and_trimmed() {
        let config = json!({ "pubkey": "  abc  ", "endpoints": [] });
        assert_eq!(pubkey_from_plugin_config(Some(&config)).unwrap(), "abc");
    }

    /// 缺失、空串、纯空白、类型不对 —— 都必须报错。
    ///
    /// 这一条守的是「签名机制不能变成可选项」：只要有一种情况静默通过，那么构造那种情况
    /// 就是绕过校验的方法。
    #[test]
    fn missing_pubkey_is_an_error_never_a_skip() {
        for config in [
            json!({}),
            json!({ "pubkey": "" }),
            json!({ "pubkey": "   " }),
            json!({ "pubkey": 42 }),
            json!({ "pubkey": null }),
        ] {
            let err = pubkey_from_plugin_config(Some(&config)).unwrap_err();
            assert!(
                matches!(err, PluginError::InvalidManifest(_)),
                "配置 {} 应当报缺失，实际: {:?}",
                config,
                err
            );
        }

        assert!(pubkey_from_plugin_config(None).is_err());
    }

    #[test]
    fn malformed_base64_is_rejected_before_any_crypto() {
        let err = verify_index_signature("{}", "not base64!!", REAL_PUBKEY).unwrap_err();
        assert!(
            matches!(err, PluginError::InvalidPackage(_)),
            "签名 base64 非法应当报包非法，实际: {:?}",
            err
        );

        let err = verify_index_signature("{}", "AAAA", "not base64!!").unwrap_err();
        assert!(
            matches!(err, PluginError::InvalidPackage(_)),
            "公钥 base64 非法应当报包非法，实际: {:?}",
            err
        );
    }

    /// base64 合法但内容不是 minisign 文本 —— 例如把别的文件当成了签名。
    #[test]
    fn valid_base64_that_is_not_minisign_is_rejected() {
        // "hello world"
        let err = verify_index_signature("{}", "aGVsbG8gd29ybGQ=", REAL_PUBKEY).unwrap_err();
        assert!(
            matches!(err, PluginError::InvalidPackage(_)),
            "非 minisign 签名应当报包非法，实际: {:?}",
            err
        );
    }

    /// 公钥本身是真实的那一份，但签名是另一把密钥的产物。
    ///
    /// 这里只能断言"失败"而不能断言具体变体：签名文本不完整时 `Signature::decode` 就会
    /// 先失败（包非法），只有格式完整、key_id 也对不上的签名才会走到验签那一步（下载失败）。
    /// 后者需要一把真实私钥才能构造，因此**这一条留给实机验证**：索引签名之后，应用必须
    /// 接受它；把签名换成另一把密钥的产物，应用必须拒绝。
    #[test]
    fn unusable_signature_is_rejected() {
        let err = verify_index_signature("{}", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpBQUFB", REAL_PUBKEY)
            .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("包非法") || message.contains("下载失败"),
            "应当是可读的失败，实际: {}",
            message
        );
    }
}
