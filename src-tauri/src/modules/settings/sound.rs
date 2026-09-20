// src-tauri/src/modules/settings/sound.rs
//
// 通知提示音：自定义音效的导入与读取。
//
// ---------------------------------------------------------------------------
// 两条命令，安全边界都收在宿主这一侧
//
//   * `pick_notification_sound` —— 打开原生选择框，按**扩展名白名单**校验格式、
//     按体积上限校验大小，然后把字节**复制**到 `<app_data>/sounds/` 下，返回
//     文件名与一个可直接播放的 data URL。
//   * `load_notification_sound` —— 读取设置里记着的那个文件，返回 data URL。
//
// 为什么存文件名而不是绝对路径，而且文件名被限死成 `custom.<扩展名>`：
//
//   设置文件是用户可以手工编辑的。若里面存的是路径，那么"读任意文件并把它编码成
//   data URL 交给前端"就成了一条**常驻**能力 —— 用户手工写一个
//   `C:\Windows\...` 进去，前端就会拿到它。而这件事本来只需要在用户**主动点选
//   文件的那一瞬间**发生一次。
//
//   把文件名限死之后，宿主愿意打开的文件只有 `<app_data>/sounds/custom.mp3`
//   这一类（8 个白名单扩展名之一），路径穿越在结构上不可能发生 ——
//   不是"校验挡住了"，而是"根本没有可以拼出别的路径的输入"。
//
// 复制的另一个好处：用户把原文件删掉或移动之后，提示音仍然可用。
//
// 与 `plugins/manager.rs` 的 `pick_audio` 是同一套思路（宿主给成品，不给原料），
// 但那边是给插件的、受 `filesystem-read` 权限约束，因此没有复用：两者的信任
// 前提不同，共用一份实现会让将来收紧其中一边时误伤另一边。

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// 自定义音效所在的子目录（位于 `app_data_dir()` 下）
pub const SOUND_DIR_NAME: &str = "sounds";

/// 自定义音效的文件主名。扩展名由用户选的文件决定
pub const CUSTOM_SOUND_STEM: &str = "custom";

/// 单个音效文件的体积上限（字节）
///
/// 提示音通常只有几百 KB，2 MB 已经远超"一段提示音"的合理范围。上限的作用是
/// 防止用户误选一个几百 MB 的音频，让它被整个读进内存并编码成 data URL。
pub const MAX_SOUND_BYTES: u64 = 2 * 1024 * 1024;

/// 允许的音频扩展名。**必须与 `audio_mime_for` 的分支一一对应** ——
/// 两处不一致会出现"选择框允许、导入被拒"这种自相矛盾的行为。
pub const SOUND_EXTENSIONS: [&str; 8] =
    ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "webm"];

/// 导入成功后返回给前端的信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSound {
    /// 原始文件名，界面上显示「当前提示音：xxx.mp3」用
    pub name: String,
    /// 存入 `<app_data>/sounds/` 后的文件名，前端需要把它写回设置
    pub file_name: String,
    /// 形如 `data:audio/mpeg;base64,...`，可直接交给 `new Audio(...)`
    pub data_url: String,
    /// 字节数，供界面显示体积
    pub bytes: u64,
}

/// 按扩展名取 MIME。返回 `None` 即拒绝 —— **必须按扩展名白名单校验**，
/// 不能只依赖对话框的过滤器：过滤器只是给用户的建议，选择框里仍然可以切到
/// 「所有文件」。
pub fn sound_mime_for_extension(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
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

/// 从文件名取 MIME（`custom.mp3` → `audio/mpeg`）
pub fn sound_mime_for_file_name(file_name: &str) -> Option<&'static str> {
    let ext = Path::new(file_name).extension()?.to_str()?;
    sound_mime_for_extension(ext)
}

/// 导入后的固定文件名（`mp3` → `custom.mp3`）
pub fn custom_sound_file_name(extension: &str) -> String {
    format!("{CUSTOM_SOUND_STEM}.{}", extension.to_ascii_lowercase())
}

/// 严格校验一个"自定义音效文件名"。
///
/// 只接受 `custom.<白名单扩展名>` 这一个形状：主名必须完全等于
/// `CUSTOM_SOUND_STEM`，扩展名必须命中白名单。因此 `../settings.json`、
/// `custom.mp3/../../auth.json`、绝对路径、大小写变体、带空格的名称
/// **全部在第一步就被拒绝**，不需要任何路径规范化技巧。
///
/// 这是"设置文件被手工改坏"时唯一的防线，所以它必须严格到"只有一种合法输入"。
pub fn is_valid_custom_sound_file_name(file_name: &str) -> bool {
    let path = Path::new(file_name);

    // 路径分隔符一律拒绝：合法取值里不可能出现它们
    if file_name.contains('/') || file_name.contains('\\') {
        return false;
    }

    // 主名必须完全等于 custom（不接受 `custom.extra.mp3` 这类多余的点）
    if path.file_stem().and_then(|s| s.to_str()) != Some(CUSTOM_SOUND_STEM) {
        return false;
    }

    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };

    sound_mime_for_extension(ext).is_some()
}

/// `<app_data>/sounds/`，必要时创建
pub fn sounds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法确定应用数据目录：{e}"))?
        .join(SOUND_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建提示音目录：{e}"))?;
    Ok(dir)
}

/// 删除目录里已有的全部 `custom.*`。
///
/// 必须在写入新文件之前调用，而**不是**只删除"新扩展名对应的那个"：用户从
/// `custom.mp3` 换成 `custom.wav` 时，若不清理就会留下一个孤儿文件，它不再被
/// 任何设置引用，却在备份与磁盘占用里长期存在。
fn remove_existing_custom_sounds(dir: &Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => return Err(format!("无法读取提示音目录：{error}")),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // 主名匹配即删除：`custom.mp3`、`custom.mp3.tmp` 都算
        if name.starts_with(&format!("{CUSTOM_SOUND_STEM}.")) || name == CUSTOM_SOUND_STEM {
            std::fs::remove_file(&path).map_err(|e| format!("无法删除旧的提示音 {name}：{e}"))?;
        }
    }

    Ok(())
}

/// 把选中的文件复制进应用数据目录，返回写入后的文件名
fn install_custom_sound(dir: &Path, source: &Path, extension: &str) -> Result<(String, u64), String> {
    let bytes = std::fs::read(source).map_err(|e| format!("无法读取所选文件：{e}"))?;
    let file_name = custom_sound_file_name(extension);
    let target = dir.join(&file_name);
    // 临时文件与目标同目录：跨卷 rename 不是原子操作，同目录才能保证
    let temp = dir.join(format!("{file_name}.tmp"));

    remove_existing_custom_sounds(dir)?;

    std::fs::write(&temp, &bytes).map_err(|e| format!("无法写入提示音：{e}"))?;
    std::fs::rename(&temp, &target).map_err(|e| {
        // 失败时把临时文件清掉，避免留下一个半成品污染下次的选择
        let _ = std::fs::remove_file(&temp);
        format!("无法保存提示音：{e}")
    })?;

    Ok((file_name, bytes.len() as u64))
}

fn data_url_for(dir: &Path, file_name: &str) -> Result<Option<String>, String> {
    let mime = sound_mime_for_file_name(file_name)
        .ok_or_else(|| format!("提示音文件名的扩展名不受支持：{file_name}"))?;
    let path = dir.join(file_name);

    if !path.is_file() {
        // 文件不在了（用户手工删了应用数据目录里的文件）：这不是错误，
        // 前端会回退到内置音色。记一条警告，否则"提示音为什么没响"无处可查。
        log::warn!("自定义提示音文件不存在，已回退到内置音色：{}", path.display());
        return Ok(None);
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("无法读取提示音：{e}"))?;
    Ok(Some(format!(
        "data:{};base64,{}",
        mime,
        BASE64.encode(&bytes)
    )))
}

/// 打开选择框并导入一个自定义提示音
///
/// 返回 `Ok(None)` 表示用户取消了选择。这与「选了但格式不对」是两回事：
/// 前者是正常操作，不该报错。
pub async fn pick(app: &AppHandle) -> Result<Option<CustomSound>, String> {
    let dir = sounds_dir(app)?;
    let app_for_dialog = app.clone();

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .add_filter("音频文件", &SOUND_EXTENSIONS)
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("无法打开文件选择框：{e}"))?;

    let Some(choice) = picked else {
        return Ok(None);
    };

    let source = match choice {
        FilePath::Path(path) => path,
        FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "文件选择框返回了非文件地址".to_string())?,
    };

    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "所选文件没有扩展名，无法判断格式".to_string())?;

    if sound_mime_for_extension(&extension).is_none() {
        return Err(format!(
            "不支持的音频格式（支持 {}）：{}",
            SOUND_EXTENSIONS.join(" / "),
            extension
        ));
    }

    let size = std::fs::metadata(&source)
        .map_err(|e| format!("无法读取所选文件：{e}"))?
        .len();
    if size > MAX_SOUND_BYTES {
        return Err(format!(
            "音频文件过大：{:.1} MB（上限 {} MB）",
            size as f64 / 1024.0 / 1024.0,
            MAX_SOUND_BYTES / 1024 / 1024
        ));
    }

    let display_name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "提示音".to_string());

    let (file_name, bytes) = install_custom_sound(&dir, &source, &extension)?;
    let data_url = data_url_for(&dir, &file_name)?
        .ok_or_else(|| "提示音保存后无法读回".to_string())?;

    log::info!("已导入自定义提示音：{display_name} → {file_name}（{bytes} 字节）");

    Ok(Some(CustomSound {
        name: display_name,
        file_name,
        data_url,
        bytes,
    }))
}

/// 读取设置里记着的自定义提示音，返回可直接播放的 data URL
///
/// 文件不存在或名字非法时返回 `Ok(None)`：提示音失效不该让通知本身出问题，
/// 前端会回退到内置音色。
pub fn load(app: &AppHandle, file_name: Option<&str>) -> Result<Option<String>, String> {
    let Some(file_name) = file_name.filter(|name| !name.is_empty()) else {
        return Ok(None);
    };

    if !is_valid_custom_sound_file_name(file_name) {
        // 走到这里说明设置文件被手工改过。**不按这个值去读任何文件**，
        // 只记一条警告 —— 这正是把文件名限死成 custom.<ext> 的意义所在。
        log::warn!("忽略非法的自定义提示音文件名：{file_name}");
        return Ok(None);
    }

    data_url_for(&sounds_dir(app)?, file_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合法形状只有一个：`custom.<白名单扩展名>`
    #[test]
    fn accepts_only_the_fixed_custom_shape() {
        for ext in SOUND_EXTENSIONS {
            let name = custom_sound_file_name(ext);
            assert!(
                is_valid_custom_sound_file_name(&name),
                "custom.{ext} 应当被接受"
            );
        }

        // 大小写变体：扩展名走小写归一化后仍要接受（用户手工改过设置文件）
        assert!(is_valid_custom_sound_file_name("custom.MP3"));
    }

    /// 一份被手工改坏的设置文件不能变成"读取任意文件"的能力。
    ///
    /// 这一组断言是 `sound.rs` 存在的核心理由：只要它们成立，就不需要依赖任何
    /// 路径规范化技巧去防穿越。
    #[test]
    fn rejects_everything_that_is_not_that_shape() {
        let rejected = [
            // 路径穿越
            "../settings.json",
            "..\\settings.json",
            "sounds/../../auth.json",
            "custom.mp3/../../auth.json",
            // 绝对路径
            r"C:\Windows\win.ini",
            "/etc/passwd",
            // 非白名单扩展名
            "custom.json",
            "custom.exe",
            "custom",
            "custom.",
            // 主名不同或带多余的点
            "other.mp3",
            "custom.extra.mp3",
            "customx.mp3",
            // 空与空白
            "",
            " ",
            // 目录部分
            "sub/custom.mp3",
            "sub\\custom.mp3",
            // 结尾点与空格（Windows 会静默去掉，容易造成"写进去读不出来"）
            "custom.mp3.",
            "custom.mp3 ",
        ];

        for name in rejected {
            assert!(
                !is_valid_custom_sound_file_name(name),
                "必须拒绝 {name:?}"
            );
        }
    }

    /// 扩展名白名单与 MIME 表必须一一对应，否则会出现
    /// 「选择框允许选、导入却被拒」这种自相矛盾的行为。
    #[test]
    fn every_allowed_extension_has_a_mime() {
        for ext in SOUND_EXTENSIONS {
            assert!(
                sound_mime_for_extension(ext).is_some(),
                "{ext} 在白名单里却没有对应的 MIME"
            );
            assert!(
                sound_mime_for_extension(&ext.to_ascii_uppercase()).is_some(),
                "{ext} 的大写形式也应当被接受（扩展名比较不区分大小写）"
            );
        }
        assert!(sound_mime_for_extension("exe").is_none());
    }

    /// 从文件名取 MIME 走的是同一条白名单
    #[test]
    fn mime_lookup_from_file_name_reuses_the_whitelist() {
        assert_eq!(sound_mime_for_file_name("custom.mp3"), Some("audio/mpeg"));
        assert_eq!(sound_mime_for_file_name("custom.wav"), Some("audio/wav"));
        assert_eq!(sound_mime_for_file_name("custom.json"), None);
        assert_eq!(sound_mime_for_file_name("custom"), None);
    }

    /// 音效 id 的格式校验（与前端 `isValidSoundId` 同一规则）
    #[test]
    fn sound_id_format_matches_the_frontend_rule() {
        assert!(crate::modules::settings::settings::is_valid_sound_id("chime"));
        assert!(crate::modules::settings::settings::is_valid_sound_id("custom"));
        assert!(crate::modules::settings::settings::is_valid_sound_id("a-b-c"));
        assert!(!crate::modules::settings::settings::is_valid_sound_id(""));
        assert!(!crate::modules::settings::settings::is_valid_sound_id("Chime"));
        assert!(!crate::modules::settings::settings::is_valid_sound_id("铃声"));
        assert!(!crate::modules::settings::settings::is_valid_sound_id("a.b"));
        assert!(!crate::modules::settings::settings::is_valid_sound_id(&"x".repeat(33)));
    }
}
