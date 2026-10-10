// src-tauri/src/modules/plugins/secrets.rs
//
// 插件的密钥存储（`ctx.secrets`）：一个**加密落盘**的键值表，专门放访问令牌、
// API key 一类凭据。
//
// ============================================================
// 它为什么不是 `ctx.storage` 的一个选项
// ============================================================
//
// `ctx.storage` 是明文 JSON，而且**插件读得到自己的文件**：键文件与 `ctx.dataDir`
// 的根在同一个目录里，插件 `ctx.dataDir.readText('api_key.json')` 就能把凭据原样
// 拿走。这不是"插件不老实"的问题 —— 一个只是想把令牌回显在设置页上的插件，会
// 理所当然地认为自己读自己的数据没问题。加密落盘要解决的是**凭据平平整整地躺在
// 磁盘上、进了备份、被别的程序读到**，而不是"防住插件自己"。
//
// ============================================================
// 为什么文件在插件数据目录**之外**
// ============================================================
//
// `<app_data_dir>/plugin_secrets/<插件 id>.json`
//
// 三条理由，任意一条单独成立都足以否掉"放进插件数据目录"：
//
//   1. 插件的 `ctx.dataDir` 是 chroot 到它自己那个目录的，放进去等于顺手给了它
//      一条读取路径（见上）；
//   2. `ctx.storage.clear` 会删掉数据目录根部**形状合法的键文件**（见
//      `manager::storage_clear`）。密钥文件正是一个 `<id>.json`，一次 clear 就把它
//      删了 —— 而插件以为那只是清了自己的键值存储；
//   3. 数据根的位置由用户配置（`data_root.rs`），可以被搬走。密钥跟着搬没有意义：
//      它们是用**这台机器**的硬件指纹加密的，搬到别的机器上本来也解不开。
//
// 放在这里之后，插件 JS **寻址不到**它：沙箱插件连 IPC 都没有，能碰到它的只有
// `rpc.rs` 的五个分支与命令层的五条命令。这就是"只有 RPC 够得着"的实际含义。
//
// ============================================================
// 加密保护什么、不保护什么（这段话会进权限描述，必须诚实）
// ============================================================
//
// 密钥由**本机硬件指纹**派生（`auth::crypto::binding_key`），因此：
//
//   * 换机器、换网卡/CPU/主机名之后这些密文**解不开**。解不开时 `get` 必须
//     如实报错，而不是返回 `null` —— 后者看起来就是"这个键从来没存过"，
//     用户会在什么都不知道的情况下把数据丢掉；
//   * 它**不是系统钥匙串**。能读这台机器上这个账户的文件的人，同样能跑一次
//     派生。它挡的是"文件被复制到别处"与"凭据明文躺在磁盘/备份里"。
//
// 盐取**插件 id**：这是域分隔，让两个插件的密钥即使明文相同也得到不同密文，
// 并且一个插件的密文换到另一个插件名下解不开。盐不是秘密 —— HKDF 的盐不要求
// 随机，它只需要"两个用途的盐不同"。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::types::PluginPermission;
use crate::modules::auth::crypto::{binding_key, decrypt_bound, encrypt_bound};

/// 应用数据目录下的子目录名。
const SECRETS_DIR: &str = "plugin_secrets";

/// 文件格式版本。
///
/// 解密失败的密文**没有**版本可依赖（GCM 不带版本号），因此版本落在文件外层：
/// 将来算法或字段变化时，据此判断"这个文件还能不能读"，而不是把一份读不懂的
/// 文件当成空文件覆盖掉。
const FORMAT_VERSION: u32 = 1;

/// 一个插件最多几个键。
const MAX_KEYS: usize = 64;

/// 密钥名的最大字符数。
///
/// 字符集是 ASCII，因此字符数等于字节数。
const MAX_KEY_CHARS: usize = 128;

/// 单个值最多多少字节（**UTF-8 字节**，不是字符数）。
///
/// 4096 是按"一个 API 令牌、一段私钥、一条连接串"定的。它同时也是文件上限的
/// 计算依据：见 `MAX_FILE_BYTES`。
const MAX_VALUE_BYTES: usize = 4096;

/// 一个密钥文件最多多少字节。
///
/// **必须与 `MAX_KEYS` / `MAX_VALUE_BYTES` 对得上**，否则会出现"写得进去、
/// 读不出来"这种没人解释得清的现象：
///
///   64 个键 × 4096 字节明文 → 每个值加密后是 12(nonce) + 4096 + 16(tag) 字节，
///   base64 后约 5.4 KB → 64 个约 344 KB；键名最多 128 字符，64 个约 8 KB；
///   再加上 JSON 结构。
///
/// 因此 512 KB 是"这个 API 写得出"的天花板的两倍上下，留出的余量是给键名与
/// JSON 结构的。它**不是**安全边界（文件可能在两次调用之间变大），而是一道资源
/// 保护：先看元数据再读，一个被手工塞进几百 MB 的文件不会被读进内存。
const MAX_FILE_BYTES: u64 = 512 * 1024;

/// 磁盘上的形状：`{"v":1,"secrets":{"<键>":"<base64(nonce||密文)>"}}`。
///
/// `BTreeMap` 而不是 `HashMap`：键的顺序因此是稳定的，写出的文件不会因为哈希
/// 随机化而在两次保存之间整份重排（那种 diff 会让"到底改了什么"看不出来）。
#[derive(Debug, Serialize, Deserialize)]
struct SecretsFile {
    v: u32,
    secrets: BTreeMap<String, String>,
}

impl SecretsFile {
    fn empty() -> Self {
        Self {
            v: FORMAT_VERSION,
            secrets: BTreeMap::new(),
        }
    }
}

// ============================================================
// 路径
// ============================================================

/// 密钥目录：`<app_data_dir>/plugin_secrets`。
///
/// **刻意不用 `plugin_data`**，理由见文件头。抽成函数是为了让"它在哪"只有一处
/// 定义 —— 命令层与 RPC 层都从这里取，任何一处自己拼路径都会在两处之间埋一个
/// 静默的分叉。
pub fn dir_for<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法确定应用数据目录：{e}"))?;
    Ok(app_data.join(SECRETS_DIR))
}

/// 一个插件的密钥文件路径。
///
/// **插件 id 必须先过 `manager::validate_plugin_id`。** 它来自前端（插件自己就能
/// `invoke`），而这里直接拿它当文件名：`id = ".."` 会让路径解析成
/// `<应用数据目录>/plugin_secrets/..`，也就是应用数据目录本身。与
/// `manager::plugin_data_dir` 用**同一个**函数，是为了不让两处的字符集规则漂开 ——
/// 一处放宽就等于另一处也没了。
fn file_for(dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    super::manager::validate_plugin_id(plugin_id, "插件 ID").map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{plugin_id}.json")))
}

// ============================================================
// 校验
// ============================================================

/// 校验密钥名：1..=128 字符，只允许 `A-Za-z0-9._-`。
///
/// 规则与 `ctx.storage` 的键**刻意一致**（`manager::is_valid_storage_key`），
/// 但这里必须再写一份：那一份是私有的，而且它的上限与错误信息是围着存储写的。
/// 两者只要有一处放宽，就会出现"同一个字符串在 storage 能用、在 secrets 不能用"
/// 这类只有作者会遇到、且说不清原因的分歧。
///
/// 为什么字符集这么窄：键名会出现在错误信息、日志、以及界面上给用户看的列表里。
/// 一个带控制字符或换行的名字，会让这些地方显示出来的东西与实际不符 ——
/// 而那是排查时的唯一线索。
fn validate_key(key: &str) -> Result<(), String> {
    let chars = key.chars().count();
    if chars == 0 {
        return Err("密钥名不能为空".to_string());
    }
    if chars > MAX_KEY_CHARS {
        return Err(format!(
            "密钥名过长：{chars} 字符，上限 {MAX_KEY_CHARS} 字符"
        ));
    }
    if let Some(bad) = key
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    {
        // 逐字指出是哪一个：作者手里可能有一串从别处粘来的名字，光说"非法字符"
        // 让他自己去猜是哪个位置，是最费时间的一种报错。
        return Err(format!(
            "密钥名里有不允许的字符 `{bad}`（只允许字母、数字与 . _ -）"
        ));
    }
    Ok(())
}

/// 校验值的字节数。
///
/// 按 **UTF-8 字节**而不是字符数：上限存在的理由是"一个键值文件不该长到把内存
/// 吃掉"，而那件事由字节数决定。一个 4096 个汉字的令牌是 12 KB，不该被当成合规。
fn validate_value(value: &str) -> Result<(), String> {
    let bytes = value.len();
    if bytes > MAX_VALUE_BYTES {
        return Err(format!(
            "密钥值过大：{bytes} 字节，上限 {MAX_VALUE_BYTES} 字节（UTF-8 字节数，\
             不是字符数）"
        ));
    }
    Ok(())
}

// ============================================================
// 读写
// ============================================================

/// 读取并解析一个插件的密钥文件。文件不存在时返回 `None`（**不是**错误）。
fn load(path: &Path) -> Result<Option<SecretsFile>, String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取密钥文件失败：{}（{error}）", path.display())),
    };

    // 先看元数据再读，超限的文件因此不会进内存 —— 与 `data_dir::read` 同一条判据。
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "密钥文件过大：{} 字节，上限 {MAX_FILE_BYTES} 字节。本 API 写不出这么大的\
             文件（上限 {MAX_KEYS} 个键 × {MAX_VALUE_BYTES} 字节），因此它只可能来自\
             手工改动。确认里面的内容不再需要之后删掉 {} 再重新保存密钥。",
            meta.len(),
            path.display()
        ));
    }

    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读取密钥文件失败：{}（{e}）", path.display()))?;

    let parsed: SecretsFile = serde_json::from_str(&text).map_err(|e| {
        format!(
            "密钥文件不是合法 JSON：{}（{e}）。**文件没有被改动** —— 里面的密文可能\
             还是好的，所以这里既不覆盖也不删除它。要丢弃请在确认之后手工删除该文件。",
            path.display()
        )
    })?;

    if parsed.v != FORMAT_VERSION {
        return Err(format!(
            "密钥文件的格式版本是 {}，本版本只认 {FORMAT_VERSION}：{}。它多半来自更新\
             的宿主版本；请升级宿主后再读，**不要**手改这一行。",
            parsed.v,
            path.display()
        ));
    }

    Ok(Some(parsed))
}

/// 原子写入：先写同目录的临时文件再改名。
///
/// 与 `auth/config.rs::save_to` 同一手法，理由也一样：直接 `write` 一个被截断的
/// 文件是**看起来完全正常**的一种损坏 —— 等到 JSON 解析失败时，用户手里那份密钥
/// 已经没了。同卷改名则是"要么旧内容、要么新内容"，不存在中间态。
///
/// 目录**懒创建**：没有密钥的插件一个字节都不落盘，也就不该在磁盘上留下一个空
/// 目录。
fn save(path: &Path, file: &SecretsFile) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err(format!("密钥文件路径没有父目录：{}", path.display()));
    };
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("创建密钥目录失败：{}（{e}）", parent.display()))?;

    let text = serde_json::to_string_pretty(file).map_err(|e| format!("序列化密钥失败：{e}"))?;

    // 临时文件与目标**同一个目录**：跨卷改名会退化成"复制一遍"，于是上面那句
    // "要么旧内容、要么新内容"就不成立了。
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("secrets.json");
    let temp = parent.join(format!("{name}.tmp"));

    std::fs::write(&temp, text)
        .map_err(|e| format!("写入密钥临时文件失败：{}（{e}）", temp.display()))?;

    if let Err(error) = std::fs::rename(&temp, path) {
        // 改名失败时清掉临时文件。留着它没有任何用处，而磁盘上一个没人认识的
        // `.tmp` 会让下一个人以为密钥文件有两份。
        let _ = std::fs::remove_file(&temp);
        return Err(format!("替换密钥文件失败：{}（{error}）", path.display()));
    }

    Ok(())
}

// ============================================================
// 五个操作
// ============================================================

/// 读一个键。**不存在的键返回 `None`**，与"存了但解不开"是两件不同的事。
///
/// 解不开时返回的是 `Err`，而且消息里必须说清三件事：密文还在、为什么可能解不开、
/// 以及用户可以做什么。返回 `None` 会让调用方（与用户）以为这个键从来没存过 ——
/// 数据明明还在磁盘上，却被当成不存在，那是最没有出路的一种失败。
pub fn get(dir: &Path, plugin_id: &str, key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;
    let path = file_for(dir, plugin_id)?;

    let Some(file) = load(&path)? else {
        return Ok(None);
    };
    let Some(encrypted) = file.secrets.get(key) else {
        return Ok(None);
    };

    match decrypt_bound(encrypted, binding_key(), plugin_id) {
        Ok(value) => Ok(Some(value)),
        Err(error) => Err(format!(
            "密钥 \"{key}\" 的密文已经无法解密（{error}）。密文**仍然在 {} 里，没有被\
             删除**：它通常是用另一台机器（或另一份硬件指纹）加密的，换回去可以再试。\
             确认它不再有用的话，用 ctx.secrets.delete(\"{key}\") 删掉它。",
            path.display()
        )),
    }
}

/// 写一个键（覆盖）。首次写入时才创建目录。
///
/// 已有文件**必须能读通**才会被覆盖：读不出来（JSON 坏了、版本不认识）时宁可
/// 报错，也不能拿一份空表把其余密钥静默地盖掉 —— 那等于一次 `set` 删掉了
/// 六十几个别的凭据。
pub fn set(dir: &Path, plugin_id: &str, key: &str, value: &str) -> Result<(), String> {
    validate_key(key)?;
    validate_value(value)?;

    let path = file_for(dir, plugin_id)?;
    let mut file = load(&path)?.unwrap_or_else(SecretsFile::empty);

    // 数量上限只在**新增**键时判：覆盖已有键不增加条目，不该被自己撑满的表挡住。
    if !file.secrets.contains_key(key) && file.secrets.len() >= MAX_KEYS {
        return Err(format!(
            "密钥数量已达上限（{MAX_KEYS} 个）。先删掉不再需要的键，或把多个值合并成\
             一个键再存。"
        ));
    }

    let encrypted =
        encrypt_bound(value, binding_key(), plugin_id).map_err(|e| format!("加密失败：{e}"))?;
    file.secrets.insert(key.to_string(), encrypted);

    save(&path, &file)
}

/// 删一个键。**删除不存在的键是成功** —— 这个接口是幂等的，插件不必先查再删。
pub fn delete(dir: &Path, plugin_id: &str, key: &str) -> Result<(), String> {
    validate_key(key)?;
    let path = file_for(dir, plugin_id)?;

    let Some(mut file) = load(&path)? else {
        return Ok(());
    };
    if file.secrets.remove(key).is_none() {
        return Ok(());
    }

    save(&path, &file)
}

/// 列出全部**键名**。
///
/// 返回的只有名字，**值一个都不在里面** —— 列出值的密钥表没有任何合理用途，而它
/// 会让一次普通的界面刷新把所有凭据搬进内存与日志。解不开的密文**照样列出来**：
/// 它确实存在，只是现在读不出来（见 `get`）。
pub fn keys(dir: &Path, plugin_id: &str) -> Result<Vec<String>, String> {
    let path = file_for(dir, plugin_id)?;
    let Some(file) = load(&path)? else {
        return Ok(Vec::new());
    };
    Ok(file.secrets.keys().cloned().collect())
}

/// 清空**这个插件**的密钥。
///
/// 写回一份空表而不是删掉文件：两者对调用方等价，而写回是原子的（`save` 的同卷
/// 改名），删文件则会在"删掉"与"下一条命令又建了它"之间留一个中间态。别的插件的
/// 文件一个字节都不碰 —— 路径是按插件 id 分开的。
pub fn clear(dir: &Path, plugin_id: &str) -> Result<(), String> {
    let path = file_for(dir, plugin_id)?;
    if load(&path)?.is_none() {
        return Ok(());
    }
    save(&path, &SecretsFile::empty())
}

/// 删掉一个插件的整个密钥文件。**供宿主侧的「清除插件数据」使用。**
///
/// 与 `clear` 分开，因为两者的语义不同：`clear` 是插件在运行期清自己的凭据，
/// 而这一条是**用户**在删机器上的东西（卸载之后也要能用）。宿主那条路径同时删
/// 数据目录与密钥 —— 只删掉一半会留下一个用户看不见、也删不掉的残留文件。
pub fn remove_for_plugin(dir: &Path, plugin_id: &str) -> Result<(), String> {
    let path = file_for(dir, plugin_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除密钥文件失败：{}（{error}）", path.display())),
    }
}

/// 需要 `Secrets` 权限。**与其它能力同一条判据**：没声明就是拒绝，不推断、不放行。
///
/// 单独摘出来，是因为两个调用方（RPC 与命令层）都要做这件事，而漏掉任意一处的
/// 后果是"没声明也能用"—— 那种缺陷在代码里看不出来，每一处单独读都像是对的。
pub fn require_permission(
    manager: &super::manager::PluginManager,
    plugin_id: &str,
) -> Result<(), String> {
    manager
        .require_permission(plugin_id, PluginPermission::Secrets)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个隔离的密钥目录。
    ///
    /// 用临时目录而不是内存实现：这里的被测对象是**文件**（读取上限、原子改名、
    /// 懒创建目录），把它们换成内存里的表会让这一整组断言什么都不测。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "modulith-secrets-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        // **不预先创建**：`set` 必须自己懒创建它，那是一条要测的行为。
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 把一段密文直接写进文件，绕过 `set`（用来造"解不开的值"这种状态）。
    fn plant(dir: &Path, plugin_id: &str, key: &str, ciphertext: &str) {
        let path = dir.join(format!("{plugin_id}.json"));
        std::fs::create_dir_all(dir).unwrap();
        let file = SecretsFile {
            v: FORMAT_VERSION,
            secrets: BTreeMap::from([(key.to_string(), ciphertext.to_string())]),
        };
        std::fs::write(&path, serde_json::to_string(&file).unwrap()).unwrap();
    }

    // ============================================================
    // 密钥名与值的边界
    // ============================================================

    #[test]
    fn key_must_match_the_documented_charset() {
        for ok in ["a", "API_KEY", "openai.token-1", "A".repeat(MAX_KEY_CHARS).as_str()] {
            assert!(validate_key(ok).is_ok(), "`{ok}` 应当被接受");
        }

        for bad in [
            "",
            "has space",
            "中文键",
            "a/b",
            "a\\b",
            "a:b",
            "a\nb",
            "a\"b",
        ] {
            assert!(validate_key(bad).is_err(), "`{bad:?}` 应当被拒绝");
        }

        // 长度按字符数算，边界两侧各测一次
        assert!(validate_key(&"a".repeat(MAX_KEY_CHARS + 1)).is_err());
    }

    /// 值的上限按 **UTF-8 字节**算，不按字符数。
    ///
    /// 这条必须单独钉住：写成 `chars().count()` 时，4096 个汉字会被放行成 12 KB，
    /// 而"上限"存在的理由（不让一个文件把内存吃掉）就不再成立，且没有任何症状。
    #[test]
    fn value_limit_is_measured_in_bytes_not_characters() {
        assert!(validate_value(&"a".repeat(MAX_VALUE_BYTES)).is_ok());
        assert!(validate_value(&"a".repeat(MAX_VALUE_BYTES + 1)).is_err());

        // 一个汉字 3 字节：1366 个已经超过 4096 字节
        let chinese = "密".repeat(MAX_VALUE_BYTES / 3 + 1);
        assert!(chinese.chars().count() < MAX_VALUE_BYTES);
        assert!(validate_value(&chinese).is_err(), "多字节字符必须按字节算");
    }

    #[test]
    fn plugin_id_is_validated_before_it_becomes_a_file_name() {
        let dir = temp_dir("bad-id");
        // `..` 会让路径解析到密钥目录之外 —— 与数据目录那处是同一个攻击面。
        for bad in ["..", ".", "a/b", "a\\b", "C:x", ""] {
            assert!(
                set(&dir, bad, "k", "v").is_err(),
                "插件 id `{bad:?}` 应当被拒绝"
            );
        }
        assert!(!dir.exists(), "拒绝之后不该留下任何东西");
    }

    // ============================================================
    // 正常路径：走真实密码学
    // ============================================================

    /// 写 → 读 → 列 → 删 的完整回路，且**明文不落盘**。
    #[test]
    fn round_trip_through_the_real_crypto() {
        let dir = temp_dir("roundtrip");
        let value = "sk-live-0123456789-中文";

        set(&dir, "tok", "apiKey", value).expect("应当写成功");
        assert_eq!(get(&dir, "tok", "apiKey").unwrap().as_deref(), Some(value));
        assert_eq!(keys(&dir, "tok").unwrap(), vec!["apiKey".to_string()]);

        // 落盘的是密文：明文（以及它的一段）不得出现在文件里
        let raw = std::fs::read_to_string(dir.join("tok.json")).unwrap();
        assert!(!raw.contains(value), "明文不得落盘");
        assert!(raw.contains("\"v\": 1"), "格式版本必须写在文件里");
        assert!(raw.contains("\"secrets\""));

        delete(&dir, "tok", "apiKey").unwrap();
        assert_eq!(get(&dir, "tok", "apiKey").unwrap(), None);
        assert!(keys(&dir, "tok").unwrap().is_empty());

        cleanup(&dir);
    }

    /// 未知的键返回 `None`，**不是**错误。
    #[test]
    fn unknown_key_is_null_not_an_error() {
        let dir = temp_dir("unknown");
        set(&dir, "tok", "a", "1").unwrap();

        assert_eq!(get(&dir, "tok", "nope").unwrap(), None);
        // 文件都不存在时同样如此（插件从没存过密钥）
        assert_eq!(get(&dir, "other", "a").unwrap(), None);
        assert!(keys(&dir, "other").unwrap().is_empty());

        cleanup(&dir);
    }

    /// 目录**懒创建**：读一个从没写过密钥的插件不产生任何文件。
    #[test]
    fn the_directory_is_created_lazily_on_first_write() {
        let dir = temp_dir("lazy");

        assert_eq!(keys(&dir, "never-wrote").unwrap(), Vec::<String>::new());
        assert_eq!(get(&dir, "never-wrote", "k").unwrap(), None);
        assert!(!dir.exists(), "只读不该在磁盘上留下目录");

        set(&dir, "never-wrote", "k", "v").unwrap();
        assert!(dir.is_dir(), "首次写入才建目录");

        cleanup(&dir);
    }

    /// 覆盖已有键不增加条目，因此不会被"表已经满了"挡住。
    #[test]
    fn overwriting_an_existing_key_is_allowed_at_the_limit() {
        let dir = temp_dir("overwrite");

        for index in 0..MAX_KEYS {
            set(&dir, "full", &format!("k{index}"), "v").unwrap();
        }
        assert_eq!(keys(&dir, "full").unwrap().len(), MAX_KEYS);

        // 第 65 个**新**键必须被拒
        let err = set(&dir, "full", "one-more", "v").expect_err("超过上限应当失败");
        assert!(err.contains("上限"), "错误信息应带上限，实际：{err}");

        // 覆盖已有的那个是允许的
        set(&dir, "full", "k0", "新的值").unwrap();
        assert_eq!(get(&dir, "full", "k0").unwrap().as_deref(), Some("新的值"));
        assert_eq!(keys(&dir, "full").unwrap().len(), MAX_KEYS);

        cleanup(&dir);
    }

    /// 两个插件的密钥互相独立：`clear` 只清自己的。
    #[test]
    fn plugins_do_not_share_a_file() {
        let dir = temp_dir("isolation");
        set(&dir, "alpha", "k", "a").unwrap();
        set(&dir, "beta", "k", "b").unwrap();

        clear(&dir, "alpha").unwrap();

        assert!(keys(&dir, "alpha").unwrap().is_empty());
        assert_eq!(get(&dir, "beta", "k").unwrap().as_deref(), Some("b"));

        cleanup(&dir);
    }

    /// 盐取插件 id 的实际含义：同一段明文在两个插件名下得到**不同密文**，
    /// 而一个插件的密文换到另一个插件名下解不开。
    ///
    /// 这是域分隔唯一的可观察证据。少了它，两个插件的密钥表在密码学上就是同一张。
    #[test]
    fn the_plugin_id_is_the_domain_separation_salt() {
        let dir = temp_dir("domain");
        set(&dir, "alpha", "k", "同一个明文").unwrap();
        set(&dir, "beta", "k", "同一个明文").unwrap();

        let read = |id: &str| {
            let raw = std::fs::read_to_string(dir.join(format!("{id}.json"))).unwrap();
            let parsed: SecretsFile = serde_json::from_str(&raw).unwrap();
            parsed.secrets.get("k").cloned().unwrap()
        };

        assert_ne!(read("alpha"), read("beta"), "同样的明文必须得到不同的密文");

        // 把 alpha 的密文挂到 beta 名下：换一个插件就是换一个盐，必须解不开
        let (alpha_cipher, beta_keys) = (read("alpha"), read("beta"));
        let beta_path = dir.join("beta.json");
        let mut beta: SecretsFile = serde_json::from_str(
            &std::fs::read_to_string(&beta_path).unwrap(),
        )
        .unwrap();
        beta.secrets.insert("stolen".to_string(), alpha_cipher);
        std::fs::write(&beta_path, serde_json::to_string(&beta).unwrap()).unwrap();
        assert!(
            get(&dir, "beta", "stolen").is_err(),
            "别的插件的密文不该能解出来"
        );
        assert_eq!(get(&dir, "beta", "k").unwrap().as_deref(), Some("同一个明文"));
        assert!(!beta_keys.is_empty());

        cleanup(&dir);
    }

    // ============================================================
    // 解不开的值：这一组是这个模块最要紧的行为
    // ============================================================

    /// **解不开的密文不是"没有这个键"。**
    ///
    /// `get` 必须报错、`keys` 必须照样列出它。返回 `null` 的话，用户看到的是
    /// "这个密钥从来没存过"，而他的数据其实还好端端躺在磁盘上等着换机器 ——
    /// 那是这个模块最没有出路的一种失败。
    #[test]
    fn an_undecryptable_value_is_an_error_that_keeps_the_ciphertext() {
        let dir = temp_dir("undecryptable");
        // 用**另一个**绑定密钥加密，模拟换机器 / 文件被改过
        let foreign = encrypt_bound("secret", &[9u8; 32], "tok").unwrap();
        plant(&dir, "tok", "apiKey", &foreign);

        let err = get(&dir, "tok", "apiKey").expect_err("解不开时必须报错");

        // 错误信息要能让人照做：说清"密文还在"、说清它在哪、给出下一步
        assert!(err.contains("无法解密"), "应当说清是解密失败：{err}");
        assert!(err.contains("没有被"), "应当说清密文没有被删：{err}");
        assert!(
            err.contains("tok.json"),
            "应当给出文件位置，用户才能确认：{err}"
        );
        assert!(err.contains("delete"), "应当给出下一步：{err}");

        // 键照样列得出来 —— 它确实存在
        assert_eq!(keys(&dir, "tok").unwrap(), vec!["apiKey".to_string()]);

        // 密文还在磁盘上，没有被这次读操作顺手清掉
        assert!(dir.join("tok.json").is_file());

        cleanup(&dir);
    }

    /// 一个键解不开不影响其它键。
    ///
    /// 这条不是"顺带测一下"：一次换硬件之后，整表都会解不开，而如果实现改成
    /// "任何一条解不开就让 keys 整体失败"，用户就再也看不到自己到底存了什么。
    #[test]
    fn one_broken_entry_does_not_hide_the_others() {
        let dir = temp_dir("partial");
        set(&dir, "tok", "good", "fine").unwrap();

        let path = dir.join("tok.json");
        let mut file: SecretsFile =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        file.secrets.insert(
            "broken".to_string(),
            encrypt_bound("x", &[3u8; 32], "tok").unwrap(),
        );
        std::fs::write(&path, serde_json::to_string(&file).unwrap()).unwrap();

        assert_eq!(get(&dir, "tok", "good").unwrap().as_deref(), Some("fine"));
        assert!(get(&dir, "tok", "broken").is_err());
        assert_eq!(
            keys(&dir, "tok").unwrap(),
            vec!["broken".to_string(), "good".to_string()]
        );

        cleanup(&dir);
    }

    // ============================================================
    // 文件的边界
    // ============================================================

    /// 坏掉的 JSON 必须报错，而且**不能被当成空文件覆盖**。
    ///
    /// 覆盖是最坏的一种处理：一次 `set` 会把其余六十几个密钥一起静默删掉，而
    /// 文件里的密文当时可能还是能解回来的。
    #[test]
    fn a_corrupt_file_is_never_silently_overwritten() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tok.json");
        std::fs::write(&path, "{ 这不是 JSON").unwrap();

        assert!(get(&dir, "tok", "k").is_err());
        assert!(keys(&dir, "tok").is_err());
        let err = set(&dir, "tok", "k", "v").expect_err("坏文件不该被覆盖");
        assert!(err.contains("没有"), "应当说清文件没有被改动：{err}");

        // 文件原样还在
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ 这不是 JSON");

        cleanup(&dir);
    }

    /// 不认识的格式版本必须报错，而不是当成空表。
    #[test]
    fn an_unknown_format_version_is_refused() {
        let dir = temp_dir("version");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("tok.json"),
            r#"{"v":99,"secrets":{"a":"b"}}"#,
        )
        .unwrap();

        let err = get(&dir, "tok", "a").expect_err("不认识的版本应当失败");
        assert!(err.contains("版本"), "应当说清是版本问题：{err}");
        assert!(set(&dir, "tok", "a", "v").is_err());

        cleanup(&dir);
    }

    /// 文件读取上限：先看元数据，因此超限的文件不会被读进内存。
    ///
    /// 顺手证明上限确实**高于**这个 API 能写出的最大文件 —— 否则会出现
    /// "写得进去、读不出来"，那是一种没人解释得清的现象。
    #[test]
    fn the_read_cap_is_above_what_this_api_can_write() {
        let dir = temp_dir("cap");

        // 按上限写满：64 个键 × 4096 字节
        for index in 0..MAX_KEYS {
            set(&dir, "full", &format!("k{index}"), &"v".repeat(MAX_VALUE_BYTES)).unwrap();
        }
        let written = std::fs::metadata(dir.join("full.json")).unwrap().len();
        assert!(
            written < MAX_FILE_BYTES,
            "写满之后的文件（{written} 字节）必须仍在上限（{MAX_FILE_BYTES}）之内"
        );
        // 而且真的读得回来
        assert_eq!(keys(&dir, "full").unwrap().len(), MAX_KEYS);

        // 手工塞一个超限的文件：必须报错，而不是被读进内存
        std::fs::write(dir.join("huge.json"), vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let err = keys(&dir, "huge").expect_err("超限的文件应当被拒");
        assert!(err.contains("过大"), "应当说清是体积问题：{err}");

        cleanup(&dir);
    }

    // ============================================================
    // 原子写入
    // ============================================================

    /// 写完不留临时文件，且目标文件是完整可解析的。
    ///
    /// "要么旧内容、要么新内容"这条保证的代价就是那个 `.tmp`：它必须被改名走，
    /// 不能在磁盘上留下来。一个残留的 `.tmp` 会让下一个人以为密钥文件有两份。
    #[test]
    fn writes_are_atomic_and_leave_no_temp_file() {
        let dir = temp_dir("atomic");

        for round in 0..3 {
            set(&dir, "tok", "k", &format!("v{round}")).unwrap();

            let leftovers: Vec<String> = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|name| name.ends_with(".tmp"))
                .collect();
            assert!(leftovers.is_empty(), "不该留下临时文件：{leftovers:?}");

            // 每次写完，文件都必须是可解析的完整 JSON，而且读回来的正是这次写的值
            let raw = std::fs::read_to_string(dir.join("tok.json")).unwrap();
            let parsed: SecretsFile = serde_json::from_str(&raw).expect("文件必须可解析");
            assert_eq!(parsed.v, FORMAT_VERSION);
            assert_eq!(
                get(&dir, "tok", "k").unwrap().as_deref(),
                Some(format!("v{round}").as_str())
            );
        }

        cleanup(&dir);
    }

    /// `remove_for_plugin` 删掉整个文件，且对不存在的文件是幂等的。
    ///
    /// 宿主侧「清除插件数据」用它：那条路径同时删数据目录与密钥，而"删一半"
    /// 会留下一个用户看不见、也删不掉的残留文件。
    #[test]
    fn remove_for_plugin_deletes_the_whole_file_and_is_idempotent() {
        let dir = temp_dir("remove");
        set(&dir, "gone", "k", "v").unwrap();
        set(&dir, "kept", "k", "v").unwrap();
        assert!(dir.join("gone.json").is_file());

        remove_for_plugin(&dir, "gone").unwrap();
        assert!(!dir.join("gone.json").exists());
        // 别的插件不受影响
        assert_eq!(get(&dir, "kept", "k").unwrap().as_deref(), Some("v"));

        // 再删一次不是错误
        remove_for_plugin(&dir, "gone").unwrap();

        cleanup(&dir);
    }
}
