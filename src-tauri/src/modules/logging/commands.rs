// src-tauri/src/modules/logging/commands.rs
//
// 日志相关的命令：给前端用的「在哪、有什么、清空」三个动作，加上
// 前端把错误送到后端日志的那条通道。
//
// 前两个命令（`log_frontend` / `report_frontend_crash`）刻意**不返回 Result**：
// 它们唯一的失败方式是把日志写不进去，而让「写日志失败」变成一个 JS 侧的
// 未处理 Promise 拒绝，会把一次无害的日志故障升级成用户可见的错误 ——
// 甚至可能自己触发全局错误处理器再次调用它们，形成回环。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use crate::prelude::*;
use tauri::AppHandle;

use super::logger::{
    self, rotated_name, CRASH_FILE_NAME, LOG_FILE_NAME, MAX_CRASH_FILES, MAX_LOG_FILES,
};

/// 默认读取的日志尾部字节数
pub const DEFAULT_TAIL_BYTES: u32 = 32 * 1024;

/// 允许读取的日志尾部字节数上限
pub const MAX_TAIL_BYTES: u32 = 128 * 1024;

/// 日志目录（必要时创建）
pub fn log_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve log dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log dir: {}", e))?;
    Ok(dir)
}

/// 当前运行日志文件的路径
fn current_log_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(path) = logger::global().and_then(|logger| logger.current_log_path()) {
        return Ok(path);
    }
    Ok(log_dir(app)?.join(LOG_FILE_NAME))
}

/// 日志文件的内容片段
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    /// 日志文件的完整路径（即使文件还不存在也会给出，用户才知道该去哪找）
    pub path: String,
    /// 文件是否存在
    pub exists: bool,
    /// 文件总字节数
    pub size: u64,
    /// 尾部文本
    pub text: String,
    /// 是否只返回了尾部（前面还有内容没读）
    pub truncated: bool,
    /// 实时记录是否开着。关着的时候「没有日志文件」是正常的，
    /// 前端要能区分「没开」与「开了但真的没有内容」。
    pub file_logging_enabled: bool,
    /// 崩溃记录是否开着
    pub crash_logging_enabled: bool,
}

/// 日志目录的完整路径
#[tauri::command]
pub fn get_log_dir(app: AppHandle) -> Result<String, String> {
    Ok(log_dir(&app)?.to_string_lossy().to_string())
}

/// 读取运行日志的尾部
///
/// 只读尾部而不是整个文件：日志上限是 3 MB，全量传给 WebView 再渲染进
/// `<pre>` 会让设置页卡住，而用户真正要看的是最新的一段。
#[tauri::command]
pub fn read_log_tail(app: AppHandle, max_bytes: Option<u32>) -> Result<LogTail, String> {
    let logger = logger::global();
    let path = current_log_path(&app)?;
    let limit = max_bytes
        .unwrap_or(DEFAULT_TAIL_BYTES)
        .clamp(1, MAX_TAIL_BYTES) as u64;

    let (exists, size, text, truncated) = match std::fs::metadata(&path) {
        Err(_) => (false, 0, String::new(), false),
        Ok(meta) => {
            let size = meta.len();
            match read_tail(&path, limit) {
                Ok((text, truncated)) => (true, size, text, truncated),
                Err(e) => {
                    return Err(format!("读取日志失败（{}）：{}", path.display(), e));
                }
            }
        }
    };

    let (file_logging, crash_logging) = match &logger {
        Some(logger) => logger.switches(),
        // 日志器没装（只可能出现在测试或异常启动路径上）：如实报告都用默认值
        None => (true, true),
    };

    Ok(LogTail {
        path: path.to_string_lossy().to_string(),
        exists,
        size,
        text,
        truncated,
        file_logging_enabled: file_logging,
        crash_logging_enabled: crash_logging,
    })
}

/// 读取文件尾部，并从第一个换行之后开始
///
/// 从换行处切开是为了不把一条被截断的记录（半行、半个 UTF-8 字符）当成
/// 第一行显示 —— 那看起来像是日志本身坏了。
fn read_tail(path: &std::path::Path, limit: u64) -> std::io::Result<(String, bool)> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(limit);
    let truncated = start > 0;

    if truncated {
        file.seek(SeekFrom::Start(start))?;
    }

    let mut buffer = Vec::new();
    file.take(limit).read_to_end(&mut buffer)?;

    let text = if truncated {
        match buffer.iter().position(|byte| *byte == b'\n') {
            Some(index) => String::from_utf8_lossy(&buffer[index + 1..]).to_string(),
            None => String::from_utf8_lossy(&buffer).to_string(),
        }
    } else {
        String::from_utf8_lossy(&buffer).to_string()
    };

    Ok((text, truncated))
}

/// 清空所有日志文件，返回删除的文件个数
#[tauri::command]
pub fn clear_logs(app: AppHandle) -> Result<u32, String> {
    if let Some(logger) = logger::global() {
        let removed = logger.clear()?;
        // 清空之后立刻写一行：否则用户看到的是一个空文件，
        // 分不清「清空了」还是「日志坏了」。
        log::info!(
            "日志已清空（删除 {} 个文件），目录 {}",
            removed,
            logger
                .dir()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_default()
        );
        return Ok(removed as u32);
    }

    // 没有全局日志器时的兜底：直接删文件
    let dir = log_dir(&app)?;
    let mut targets = vec![dir.join(LOG_FILE_NAME), dir.join(CRASH_FILE_NAME)];
    for index in 1..MAX_LOG_FILES {
        targets.push(dir.join(rotated_name(LOG_FILE_NAME, index)));
    }
    for index in 1..MAX_CRASH_FILES {
        targets.push(dir.join(rotated_name(CRASH_FILE_NAME, index)));
    }

    let mut removed = 0u32;
    for path in targets {
        if path.exists() && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 前端把一条日志写到后端日志文件
///
/// 存在的理由：前端的所有错误（未捕获异常、未处理的 Promise 拒绝、React 渲染
/// 崩溃、插件的 `console`）此前只有 devtools 一个出口 —— 而 release 版的用户
/// 根本打不开 devtools。走这条通道之后，「界面崩了」和「后端崩了」在同一个
/// 文件里按时间排好，排查时不用再让用户去截图控制台。
#[tauri::command]
pub fn log_frontend(level: String, message: String, context: Option<String>) {
    let level = match level.trim().to_ascii_lowercase().as_str() {
        "trace" => log::Level::Trace,
        "debug" => log::Level::Debug,
        "warn" | "warning" => log::Level::Warn,
        "error" => log::Level::Error,
        // 未知级别按 info 处理：前端传错一个字符串不该让这条记录消失
        _ => log::Level::Info,
    };

    let target = match context.as_deref().map(str::trim) {
        Some(ctx) if !ctx.is_empty() => format!("frontend/{ctx}"),
        _ => "frontend".to_string(),
    };

    log::log!(target: &target, level, "{}", message);
}

/// 前端报告一次崩溃（未捕获错误 / 未处理的 Promise 拒绝 / 渲染崩溃）
///
/// 写进崩溃日志文件而不是运行日志：它与 Rust 侧的 panic 属于同一类事件，
/// 用户报障时要看的是同一个地方。
#[tauri::command]
pub fn report_frontend_crash(message: String, detail: Option<String>) {
    let Some(logger) = logger::global() else { return };

    let mut text = format!("[前端] {message}");
    if let Some(detail) = detail.as_deref().map(str::trim) {
        if !detail.is_empty() {
            text.push('\n');
            text.push_str(detail);
        }
    }

    logger.write_crash(&text);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn read_tail_drops_the_first_partial_line() {
        let dir = std::env::temp_dir().join(format!("modulith-tail-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("tail.log");

        {
            let mut file = File::create(&path).expect("create");
            for i in 0..100 {
                writeln!(file, "行 {i} 内容").expect("write");
            }
        }

        // 只读很小的尾部：第一条一定是被截断的半行
        let (text, truncated) = read_tail(&path, 40).expect("read tail");
        assert!(truncated, "字节数小于文件时应当标记为截断");
        // 被截断的半个字符不能变成替换符 —— 那看起来像日志本身损坏了
        assert!(
            !text.contains('\u{FFFD}'),
            "不该留下半个 UTF-8 字符：{text:?}"
        );
        // 第一行必须是**完整**的一行，而不是从中间切开的残句
        let first_line = text.lines().next().unwrap_or_default();
        assert!(
            first_line.starts_with("行 ") && first_line.ends_with(" 内容"),
            "首行应当是一整行：{first_line:?}"
        );
        assert!(text.contains("行 99"), "最后一行必须在：{text:?}");

        // 完整读取时不截断，也不丢首行
        let (text, truncated) = read_tail(&path, 1024 * 1024).expect("read all");
        assert!(!truncated);
        assert!(text.starts_with("行 0 内容"), "{text:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
