// src-tauri/src/modules/auth/crypto.rs
//
// 授权系统用到的全部密码学原语：
//   * Argon2id    —— 访问密钥只存哈希，绝不存明文
//   * HKDF-SHA256 —— 从硬件指纹派生 AES 密钥（RFC 5869，用 hmac + sha2 实现）
//   * AES-256-GCM —— 加密「记住我」令牌：换台机器就解不开
//
// 与 hive_atelier 的差异（迁移时修掉的问题）：
//   1. 不存在任何内置默认密钥。原实现里密钥哈希缺失时会回退去比较明文 "MetaZero"，
//      等于给所有用户留了同一把后门钥匙，这里彻底删掉了这条分支。
//   2. 「记住我」不再只是一个布尔开关：令牌会被真正校验（解密 + 哈希比对），
//      因此手动把 auth.json 里的 autoLogin 改成 true 并不能绕过验证。
//   3. 硬件指纹采集（sysinfo）比较贵，这里用 OnceLock 缓存，避免每次调用都重新枚举。

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hmac::{Hmac, Mac};
use rand::Rng;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use sysinfo::{CpuExt, NetworkExt, NetworksExt, System, SystemExt};

/// 硬件绑定密钥的域分隔标签。
///
/// 它只用于防止同一份派生密钥被跨用途复用，本身不含任何信息，
/// 改它的唯一后果是让此前加密的「记住我」令牌无法解密（会以
/// 「自动登录凭据已失效」的形式正常降级，不是错误）。
///
/// 在 Modulith Desktop 1.0.0 的产品改名中一并更新：此前已重置过
/// 应用标识符，旧绑定本就不再可用，因此这里改名是零额外代价。
const BINDING_DOMAIN: &[u8] = b"modulith_hardware_binding_v1";
/// HKDF info：把派生密钥限定用途，避免同一份密钥被用在别处
const HKDF_INFO: &[u8] = b"modulith_remember_token_key_v1";

/// 访问密钥的最小长度
pub const MIN_KEY_LEN: usize = 8;
/// 访问密钥的最大长度（防止超长输入拖慢 Argon2）
pub const MAX_KEY_LEN: usize = 256;
/// AES-GCM 的 nonce 长度
const NONCE_LEN: usize = 12;

// ============================================================
// 硬件指纹
// ============================================================

/// 硬件指纹（Rust 侧采集，前端拿不到也改不了）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareFingerprint {
    /// 网卡 MAC（虚拟网卡的全零地址会被忽略）
    pub mac_address: Option<String>,
    pub hostname: String,
    pub os_id: String,
    pub cpu_brand: String,
    pub cpu_cores: usize,
}

impl HardwareFingerprint {
    /// 采集当前机器的硬件指纹
    pub fn collect() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();

        // 优先挑选物理网卡；全零 MAC（虚拟网卡 / 未连接）没有区分度，直接忽略
        let mac_address = sys
            .networks()
            .iter()
            .filter(|(name, _)| {
                name.contains("eth") || name.contains("en") || name.contains("wlan")
            })
            .map(|(_, data)| data.mac_address().to_string())
            .find(|mac| !mac.is_empty() && !is_zero_mac(mac));

        let hostname = sys.host_name().unwrap_or_else(|| "unknown".to_string());
        let os_id = std::env::consts::OS.to_string();
        let cpu_brand = sys
            .cpus()
            .first()
            .map(|cpu| cpu.brand().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let cpu_cores = sys.physical_core_count().unwrap_or(1);

        Self {
            mac_address,
            hostname,
            os_id,
            cpu_brand,
            cpu_cores,
        }
    }

    /// 生成 32 字节硬件绑定密钥
    pub fn derive_binding_key(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(BINDING_DOMAIN);
        hasher.update(self.mac_address.as_deref().unwrap_or("unknown").as_bytes());
        hasher.update(self.hostname.as_bytes());
        hasher.update(self.os_id.as_bytes());
        hasher.update(self.cpu_brand.as_bytes());
        hasher.update(self.cpu_cores.to_le_bytes());
        hasher.finalize().into()
    }

    /// 人类可读的指纹摘要（仅用于界面展示，不参与派生）
    pub fn summary(&self) -> String {
        format!(
            "{} · {} 核 · {}",
            self.hostname,
            self.cpu_cores,
            self.mac_address.as_deref().unwrap_or("无 MAC")
        )
    }
}

/// 全零 MAC（00:00:00:00:00:00）判定
fn is_zero_mac(mac: &str) -> bool {
    mac.chars().all(|c| c == '0' || c == ':' || c == '-')
}

/// 进程内缓存硬件绑定密钥：sysinfo 采集一次要几十毫秒，没必要反复做
pub fn binding_key() -> &'static [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(|| HardwareFingerprint::collect().derive_binding_key())
}

/// 进程内缓存的硬件指纹（供界面展示）
pub fn cached_fingerprint() -> &'static HardwareFingerprint {
    static FP: OnceLock<HardwareFingerprint> = OnceLock::new();
    FP.get_or_init(HardwareFingerprint::collect)
}

// ============================================================
// 通用工具
// ============================================================

/// 随机盐值（32 位字母数字）
pub fn generate_salt() -> String {
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// 生成会话令牌 / 「记住我」密钥（64 位字母数字）
pub fn generate_token() -> String {
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

// ============================================================
// 恢复码
// ============================================================
//
// 目标：用户忘记访问密钥时，用一张「离线保存的纸」把账户救回来。
//
// 形态：**多枚互不相干的短恢复码，每枚各用一次**（见 `RECOVERY_CODE_COUNT`）。
// 这个形态是修正后的结果，前因值得记下来：
//
//   最初只发一枚 32 字符的长码，界面上按 4 字符分组显示。结果用户把它读成
//   "八个恢复码"，只输入其中一组，于是每次都报错 —— 而且他无法自行判断
//   到底该输整串还是输一组。**歧义的根源是形态本身**：一整串按组分隔的字符
//   既像一个码，也像八个码。
//
//   改成多枚短码之后：
//     * 每个恢复码是独立的一行、独立的一份凭据，不存在"要不要全输"的疑问；
//     * 丢了几枚还有其余可用，不必因为抄漏一枚就作废全部；
//     * 与 GitHub / Google 的备份码形态一致，用户已有心智模型。
//
// 设计约束（按重要性排序）：
//   1. **可离线保存**：必须是纯文本、可抄写、可粘贴进密码管理器。
//      因此用 Crockford 风格的大写字母数字分组，而不是长 base64 串。
//   2. **不可混淆**：字母表排除 I / L / O / U，避免抄写时把 1 和 l、0 和 O
//      写错；归一化时把这几组字符折叠到同一等价类，从根上消除歧义。
//   3. **熵足够**：每枚 20 字符 × 32 种取值 = 100 bit。
//      多枚合计并不等于 100×N bit（攻击者只需要猜中任意一枚），
//      但 100 bit 已经远超暴力搜索能力，配合"每枚用掉即失效"与限流足够。
//   4. **只存哈希**：与访问密钥共用 Argon2id 路径，绝不明文落盘。

/// 恢复码字母表：Crockford Base32 去掉容易混淆的字符。
///
/// 排除：I、L（像 1）、O（像 0）、U（Crockford 为降低意外拼出脏词的概率而排除）。
const RECOVERY_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// 单枚恢复码的字符数（不含分组连字符）
pub const RECOVERY_CODE_LEN: usize = 20;
/// 一次生成的恢复码数量
///
/// 取 3 是一个刻意的平衡：
///   * 数量越多，单张纸上"丢一部分仍然可用"的容错越强；
///   * 但恢复码的实际用途是"万一忘记访问密钥时还能进来一次"，
///     3 枚足以覆盖"抄漏一枚"与"分两处存放"这两件真实会发生的事；
///   * 再多只会让用户在「设置 → 安全」里看到更长的列表，收益递减。
pub const RECOVERY_CODE_COUNT: usize = 3;
/// 每组的字符数，仅影响展示形式
const RECOVERY_GROUP_LEN: usize = 5;
/// 归一化后的最小可接受长度。
///
/// 单枚恢复码归一化后是 20 字符。这里只排除明显不可能是恢复码的短输入
/// （例如误把访问密钥填进来），避免用极短输入消耗 Argon2 算力。
/// 故意不要求精确等于 20：抄漏一个字符时应当以「恢复码不正确」拒绝，
/// 而不是报「格式不对」——后者会让用户以为恢复码本身有问题。
const RECOVERY_MIN_INPUT_LEN: usize = 12;

/// 生成一组新的恢复码（返回带分组连字符的展示形式）。
///
/// 单枚形式：`XXXXX-XXXXX-XXXXX-XXXXX`（20 字符，分 4 组）
pub fn generate_recovery_codes() -> Vec<String> {
    (0..RECOVERY_CODE_COUNT)
        .map(|_| generate_recovery_code())
        .collect()
}

/// 生成一枚恢复码
pub fn generate_recovery_code() -> String {
    let mut rng = rand::thread_rng();
    let chars: String = (0..RECOVERY_CODE_LEN)
        .map(|_| {
            let index = rng.gen_range(0..RECOVERY_ALPHABET.len());
            RECOVERY_ALPHABET[index] as char
        })
        .collect();

    chars
        .as_bytes()
        .chunks(RECOVERY_GROUP_LEN)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .collect::<Vec<_>>()
        .join("-")
}

/// 归一化用户输入的恢复码。
///
/// 容忍一切常见的抄写差异：大小写、空格、连字符、以及
/// I/L→1、O→0 这类形近字符误写。归一化后长度不足返回 None。
pub fn normalize_recovery_code(input: &str) -> Option<String> {
    let normalized: String = input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .filter_map(|c| {
            let upper = c.to_ascii_uppercase();
            // 形近字符折叠：把用户可能写错的字符映射回字母表中真正在用的那一个。
            // 只折叠这四组 —— 字母表里本来就没有 I/L/O/U，
            // 因此不存在「把合法字符错误折叠掉」的风险。
            let mapped = match upper {
                'I' | 'L' => '1',
                'O' => '0',
                'U' => 'V',
                other => other,
            };
            RECOVERY_ALPHABET.contains(&(mapped as u8)).then_some(mapped)
        })
        .collect();

    if normalized.len() < RECOVERY_MIN_INPUT_LEN {
        return None;
    }

    Some(normalized)
}

/// 计算恢复码哈希（与访问密钥同一套 Argon2id 参数）
pub fn hash_recovery_code(code: &str) -> Result<String, String> {
    let Some(normalized) = normalize_recovery_code(code) else {
        return Err("恢复码格式不正确".to_string());
    };
    hash_access_key(&normalized)
}

/// 归一化后的恢复码（供调用方保存，避免重复归一化）。
///
/// 用 Argon2 逐字节比较原文是不现实的（每次哈希都不同），
/// 因此「两步恢复流程」的第二步需要这个版本作为凭据。
pub fn normalized_recovery_code(code: &str) -> Option<String> {
    normalize_recovery_code(code)
}

/// 校验恢复码，返回**匹配到的哈希在列表中的下标**。
///
/// 返回下标而不是布尔值，是为了让调用方能够「用掉这一枚」——
/// 多枚恢复码各自独立失效，必须知道命中的是哪一枚。
///
/// 遍历顺序与存储顺序一致，命中即返回（不继续算剩余的哈希）。
/// 全部不匹配时才付出 `hashes.len()` 次 Argon2 的代价 —— 这也顺带让
/// 失败尝试天然更慢，对暴力枚举不利。
pub fn match_recovery_code(code: &str, stored_hashes: &[String]) -> Option<usize> {
    let normalized = normalize_recovery_code(code)?;

    for (index, hash) in stored_hashes.iter().enumerate() {
        // verify_access_key 在哈希格式非法时返回 Err，这里视为不匹配继续尝试，
        // 而不是整个失败 —— 单条损坏不该让其余恢复码一起失效。
        if matches!(verify_access_key(&normalized, hash), Ok(true)) {
            return Some(index);
        }
    }

    None
}

/// SHA-256 十六进制摘要
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// 常数时间比较，避免通过比较耗时泄露信息。
///
/// 只在长度相等时逐字节累积差异，因此不会提前返回。
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ============================================================
// Argon2id：访问密钥哈希
// ============================================================

/// 用 Argon2id 计算访问密钥哈希（返回 PHC 字符串，自带随机盐与参数）
pub fn hash_access_key(key: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(key.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| format!("Hashing failed: {e}"))
}

/// 校验访问密钥
pub fn verify_access_key(key: &str, stored_hash: &str) -> Result<bool, String> {
    let parsed = PasswordHash::new(stored_hash).map_err(|e| format!("Invalid hash format: {e}"))?;
    Ok(Argon2::default()
        .verify_password(key.as_bytes(), &parsed)
        .is_ok())
}

/// 访问密钥的长度/内容校验，返回可直接展示给用户的错误
pub fn validate_access_key(key: &str) -> Result<(), String> {
    if key.chars().count() < MIN_KEY_LEN {
        return Err(format!("访问密钥至少需要 {MIN_KEY_LEN} 个字符"));
    }
    if key.chars().count() > MAX_KEY_LEN {
        return Err(format!("访问密钥不能超过 {MAX_KEY_LEN} 个字符"));
    }
    if key.trim().is_empty() {
        return Err("访问密钥不能只有空白字符".to_string());
    }
    Ok(())
}

// ============================================================
// HKDF-SHA256：硬件绑定密钥 -> AES 密钥
// ============================================================

/// RFC 5869 HKDF-SHA256（只需要 32 字节输出，因此 expand 阶段一个块就够）
fn hkdf_sha256(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    // Extract
    let mut extract = <Hmac<Sha256> as Mac>::new_from_slice(salt)
        .expect("HMAC 接受任意长度的密钥");
    extract.update(ikm);
    let prk = extract.finalize().into_bytes();

    // Expand（L = 32 <= HashLen，单块）
    let mut expand = <Hmac<Sha256> as Mac>::new_from_slice(&prk)
        .expect("HMAC 接受任意长度的密钥");
    expand.update(HKDF_INFO);
    expand.update(&[0x01]);
    let okm = expand.finalize().into_bytes();

    let mut key = [0u8; 32];
    key.copy_from_slice(&okm[..32]);
    key
}

/// 由硬件绑定密钥 + 盐派生 AES-256 密钥
fn derive_aes_key(binding_key: &[u8; 32], salt: &str) -> [u8; 32] {
    hkdf_sha256(salt.as_bytes(), binding_key)
}

// ============================================================
// AES-256-GCM：加密「记住我」令牌
// ============================================================

/// 用硬件绑定密钥加密（输出 base64(nonce || ciphertext)）
pub fn encrypt_bound(plaintext: &str, binding_key: &[u8; 32], salt: &str) -> Result<String, String> {
    let key = derive_aes_key(binding_key, salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Cipher init failed: {e}"))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {e}"))?;

    let mut combined = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    Ok(BASE64.encode(combined))
}

/// 用硬件绑定密钥解密（换设备 / 改硬件后必然失败）
pub fn decrypt_bound(encoded: &str, binding_key: &[u8; 32], salt: &str) -> Result<String, String> {
    let combined = BASE64
        .decode(encoded)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    if combined.len() <= NONCE_LEN {
        return Err("Invalid encrypted payload".to_string());
    }

    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
    let key = derive_aes_key(binding_key, salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Cipher init failed: {e}"))?;

    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "Decryption failed (hardware binding mismatch?)".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_key_roundtrip() {
        let hash = hash_access_key("correct horse battery").expect("hash");
        // PHC 字符串不应该包含明文
        assert!(!hash.contains("correct horse battery"));
        assert!(hash.starts_with("$argon2"));

        assert!(verify_access_key("correct horse battery", &hash).unwrap());
        assert!(!verify_access_key("wrong key entirely", &hash).unwrap());
    }

    #[test]
    fn each_hash_uses_a_fresh_salt() {
        let a = hash_access_key("same-key-twice").expect("hash");
        let b = hash_access_key("same-key-twice").expect("hash");
        assert_ne!(a, b, "相同密钥两次哈希必须不同（随机盐）");
        assert!(verify_access_key("same-key-twice", &a).unwrap());
        assert!(verify_access_key("same-key-twice", &b).unwrap());
    }

    #[test]
    fn rejects_malformed_hash() {
        assert!(verify_access_key("whatever", "not-a-phc-string").is_err());
    }

    #[test]
    fn validates_key_length_and_whitespace() {
        assert!(validate_access_key(&"a".repeat(MIN_KEY_LEN)).is_ok());
        assert!(validate_access_key(&"a".repeat(MIN_KEY_LEN - 1)).is_err());
        assert!(validate_access_key(&"a".repeat(MAX_KEY_LEN + 1)).is_err());
        assert!(validate_access_key("        ").is_err());
        // 中文等多字节字符按字符计数
        assert!(validate_access_key("正确的马电池订书钉").is_ok());
    }

    #[test]
    fn bound_encryption_roundtrip() {
        let key = [7u8; 32];
        let salt = generate_salt();
        let secret = generate_token();

        let encrypted = encrypt_bound(&secret, &key, &salt).expect("encrypt");
        assert!(!encrypted.contains(&secret));
        assert_eq!(decrypt_bound(&encrypted, &key, &salt).unwrap(), secret);
    }

    #[test]
    fn bound_encryption_fails_on_other_hardware_or_salt() {
        let salt = generate_salt();
        let encrypted = encrypt_bound("secret", &[1u8; 32], &salt).expect("encrypt");

        // 换一台机器（不同绑定密钥）
        assert!(decrypt_bound(&encrypted, &[2u8; 32], &salt).is_err());
        // 换了盐值
        assert!(decrypt_bound(&encrypted, &[1u8; 32], &generate_salt()).is_err());
        // 密文损坏
        assert!(decrypt_bound("!!!not-base64!!!", &[1u8; 32], &salt).is_err());
        assert!(decrypt_bound("c2hvcnQ=", &[1u8; 32], &salt).is_err());
    }

    #[test]
    fn hkdf_is_deterministic_and_salt_sensitive() {
        let a = hkdf_sha256(b"salt-a", b"ikm");
        let b = hkdf_sha256(b"salt-a", b"ikm");
        let c = hkdf_sha256(b"salt-b", b"ikm");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, [0u8; 32]);
    }

    #[test]
    fn ct_eq_matches_normal_equality() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn tokens_are_unique_and_long_enough() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    // ---------- 恢复码 ----------

    #[test]
    fn recovery_code_has_expected_shape() {
        let code = generate_recovery_code();
        // 20 个字符 + 3 个分组连字符（4 组 × 5 字符）
        assert_eq!(
            code.len(),
            RECOVERY_CODE_LEN + RECOVERY_CODE_LEN / RECOVERY_GROUP_LEN - 1
        );
        assert_eq!(code.matches('-').count(), RECOVERY_CODE_LEN / RECOVERY_GROUP_LEN - 1);

        // 只使用字母表中的字符 —— 特别是绝不含 I / L / O / U
        for ch in code.chars().filter(|c| *c != '-') {
            assert!(
                RECOVERY_ALPHABET.contains(&(ch as u8)),
                "恢复码含非法字符: {ch}"
            );
            assert!(!"ILOU".contains(ch), "恢复码不应含形近字符: {ch}");
        }
    }

    /// 一次生成的是一组**互不相同**的恢复码。
    ///
    /// 这条测试锁定的是「多枚独立短码」这个形态本身 —— 它是修正
    /// 「用户把一整串分组长码读成多个码」那个歧义的核心。
    #[test]
    fn generates_a_full_set_of_distinct_codes() {
        let codes = generate_recovery_codes();
        assert_eq!(codes.len(), RECOVERY_CODE_COUNT);

        let unique: std::collections::HashSet<&String> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len(), "同一批恢复码之间不得重复");

        for code in &codes {
            // 每枚都必须是完整、可独立使用的短码
            let bare = code.replace('-', "");
            assert_eq!(bare.len(), RECOVERY_CODE_LEN);
            assert!(normalize_recovery_code(code).is_some());
        }
    }

    #[test]
    fn recovery_codes_are_unique_across_batches() {
        let a = generate_recovery_codes();
        let b = generate_recovery_codes();
        assert_ne!(a, b, "两批恢复码必须不同");
    }

    /// 归一化必须容忍用户在抄写/粘贴时的各种写法。
    #[test]
    fn normalization_accepts_written_variants() {
        let canonical = "ABCDE-23456-FGHJK-6789M";
        let expected: String = canonical.chars().filter(|c| *c != '-').collect();

        for variant in [
            canonical.to_string(),
            canonical.to_lowercase(),
            canonical.replace('-', ""),
            canonical.replace('-', " "),
            format!("  {canonical}  "),
            // 形近字符误写：把 1 写成 I 或 l，把 0 写成 O
            expected.replace('1', "I").replace('0', "O"),
            expected.replace('1', "l").replace('0', "o"),
        ] {
            assert_eq!(
                normalize_recovery_code(&variant).as_deref(),
                Some(expected.as_str()),
                "变体归一化失败: {variant}"
            );
        }
    }

    #[test]
    fn normalization_rejects_too_short_input() {
        assert!(normalize_recovery_code("").is_none());
        assert!(normalize_recovery_code("ABC").is_none());
        // 刚好低于下限
        assert!(normalize_recovery_code(&"A".repeat(RECOVERY_MIN_INPUT_LEN - 1)).is_none());
        // 达到下限即接受（长度只用于排除明显不是恢复码的输入，
        // 是否真的正确由 Argon2 校验决定）
        assert!(normalize_recovery_code(&"A".repeat(RECOVERY_MIN_INPUT_LEN)).is_some());
    }

    /// 匹配返回**下标**，调用方才能知道命中哪一枚。
    #[test]
    fn match_returns_the_matched_index() {
        let codes = generate_recovery_codes();
        let hashes: Vec<String> = codes
            .iter()
            .map(|c| hash_recovery_code(c).expect("hash"))
            .collect();

        // 每一枚都必须命中它自己的位置（而不是"随便匹配上一个"）
        for (index, code) in codes.iter().enumerate() {
            assert_eq!(
                match_recovery_code(code, &hashes),
                Some(index),
                "第 {index} 枚恢复码应命中下标 {index}"
            );
        }
    }

    #[test]
    fn match_accepts_written_variants_and_rejects_strangers() {
        let codes = generate_recovery_codes();
        let hashes: Vec<String> = codes
            .iter()
            .map(|c| hash_recovery_code(c).expect("hash"))
            .collect();

        // 取最后一枚，避免依赖具体的 RECOVERY_CODE_COUNT 取值
        let last = codes.len() - 1;
        let target = &codes[last];

        // 用户原样抄写（带连字符）、小写、带空格都应通过
        assert_eq!(match_recovery_code(target, &hashes), Some(last));
        assert_eq!(match_recovery_code(&target.to_lowercase(), &hashes), Some(last));
        assert_eq!(match_recovery_code(&format!("  {target} "), &hashes), Some(last));

        // 不属于这一批的码不匹配
        assert_eq!(
            match_recovery_code("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", &hashes),
            None
        );
        // 长度不足直接判否，不进入 Argon2（避免被用作算力放大器）
        assert_eq!(match_recovery_code("short", &hashes), None);
        // 空列表不匹配任何输入
        assert_eq!(match_recovery_code(target, &[]), None);
    }

    /// 单条哈希损坏时，其余恢复码仍然可用。
    ///
    /// 这是「不要因为一个坏字段就整批失效」的具体落实：
    /// 手工改坏 auth.json 里的一条不应导致其余几枚一起作废。
    #[test]
    fn match_tolerates_one_corrupted_hash() {
        let codes = generate_recovery_codes();
        let mut hashes: Vec<String> = codes
            .iter()
            .map(|c| hash_recovery_code(c).expect("hash"))
            .collect();

        hashes[0] = "not-a-phc-string".to_string();

        // 损坏的那一枚自然无法匹配……
        assert_eq!(match_recovery_code(&codes[0], &hashes), None);
        // ……但其余各枚必须照常工作（取最后一枚，不依赖具体数量）
        let last = codes.len() - 1;
        assert_eq!(match_recovery_code(&codes[last], &hashes), Some(last));
    }

    #[test]
    fn recovery_hash_uses_a_fresh_salt() {
        let code = "ABCDE-23456-FGHJK-6789M";
        let a = hash_recovery_code(code).expect("hash a");
        let b = hash_recovery_code(code).expect("hash b");
        assert_ne!(a, b, "相同恢复码两次哈希必须不同（随机盐）");
        assert_eq!(match_recovery_code(code, &[a]), Some(0));
        assert_eq!(match_recovery_code(code, &[b]), Some(0));
    }

    #[test]
    fn zero_mac_detection() {
        assert!(is_zero_mac("00:00:00:00:00:00"));
        assert!(is_zero_mac("00-00-00-00-00-00"));
        assert!(!is_zero_mac("a4:5e:60:11:22:33"));
    }

    #[test]
    fn hardware_fingerprint_is_stable_and_labels_itself() {
        let fp = cached_fingerprint();
        // 同一进程内缓存，必须完全一致
        assert_eq!(fp.derive_binding_key(), *binding_key());
        assert!(!fp.hostname.is_empty());
        assert!(fp.cpu_cores >= 1);
        assert!(!fp.summary().is_empty());
    }
}
