// src-tauri/src/modules/logging/logger.rs
//
// 日志落盘：把 `log` 门面收到的记录写进文件，外加一个独立的崩溃记录。
//
// ============================================================
// 为什么需要它（现状）
// ============================================================
//
// `Cargo.toml` 里一直有 `log = "0.4"`，代码里也一直有几十处 `log::info!` /
// `log::warn!` / `log::error!` —— 但**从来没有安装过任何 logger 后端**。
// `log` 只是一个门面：没有后端时它把每条记录直接丢掉。于是：
//
//   * `log::warn!("读取应用设置文件失败…")` 这样的句子写了很多年，一次也没出现过；
//   * release 版是 `windows_subsystem = "windows"`，连 `eprintln!` 也没有出口；
//   * 用户报「更新失败」时，我们手上没有任何证据，只能猜。
//
// 所以这里的首要目标不是「加日志」，而是**让已经写好的日志真的存在**。
//
// ============================================================
// 为什么自己写，而不是用现成的日志插件
// ============================================================
//
// 需求里有两件事是通用插件给不了的：
//
// 1. **运行期开关。** 用户要能随时关闭「实时记录」。`tauri-plugin-log` 的目标在
//    启动时就固定了，运行期改不了；要改就得重装插件。
// 2. **崩溃记录单独成一个开关与一个文件。** 崩溃是低频高价值事件，与高频的运行
//    日志不该共用开关，也不该混在同一个文件里 —— 用户报障时我们要的是「崩在哪」，
//    而不是「崩之前刷了多少行」。
//
// 自己写还顺带省掉一个依赖，并且能精确控制**启动早期**的记录（见下）。
//
// ============================================================
// 启动早期的记录：先排队，后落盘
// ============================================================
//
// 日志目录要通过 `AppHandle` 解析，而 `AppHandle` 只有在 Tauri 的 setup 阶段才有。
// 偏偏最早的那几条记录（授权模块就绪、插件目录在哪）最有用。
//
// 因此安装 logger 与配置落盘目录分成两步：`install_early()` 在 `main()` 里先装好，
// 此时还没有目录，记录进内存队列；`configure()` 在模块 setup 里补上目录，队列里的
// 记录按原顺序落盘。队列有上限，满了就丢弃并记下丢了多少条 —— 宁可丢掉最早的几行，
// 也不能让启动阶段的日志把内存吃掉。
//
// ============================================================
// 写盘是同步的，而且**一定不 panic**
// ============================================================
//
// 写入在 `Mutex` 后面同步进行。不另开写线程，是因为量很小（每条几十字节、低频），
// 而多一个线程就多一处「日志线程自己挂了没人知道」的可能。更重要的：日志系统
// 在任何情况下都不该让应用崩掉 —— 拿不到锁（说明别的线程持有它并 panic 了）时
// 用 `into_inner()` 继续走，写盘失败就静默放弃。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// 运行日志的文件名
pub const LOG_FILE_NAME: &str = "modulith.log";

/// 崩溃日志的文件名
pub const CRASH_FILE_NAME: &str = "crash.log";

/// 运行日志保留的文件个数（含当前文件）：`modulith.log` + `.1` + `.2`
pub const MAX_LOG_FILES: usize = 3;

/// 单个运行日志文件的大小上限
///
/// 1 MB × 3 个文件 —— 上限是 3 MB。轮转而不是无限追加：日志的价值随时间迅速衰减，
/// 而一个几百 MB 的日志文件本身就是新的问题（用户没法把它发出来）。
pub const MAX_LOG_BYTES: u64 = 1024 * 1024;

/// 崩溃日志保留的文件个数（含当前文件）
pub const MAX_CRASH_FILES: usize = 2;

/// 单个崩溃日志文件的大小上限
pub const MAX_CRASH_BYTES: u64 = 256 * 1024;

/// 启动早期（还没有日志目录）最多在内存里排队的记录条数
pub const MAX_PENDING_RECORDS: usize = 512;

/// 一次 `log` 记录格式化后的一行文本（不含换行）
fn format_line(level: log::Level, target: &str, message: &str) -> String {
    // 本地时间而不是 UTC：日志是给人看的，用户报障时会说「就是刚才」，
    // 而让他自己把 UTC 换算成本地时间是没必要的折磨。
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    if target.is_empty() {
        format!("{now} {:<5} {message}", level.as_str().to_uppercase())
    } else {
        format!(
            "{now} {:<5} [{target}] {message}",
            level.as_str().to_uppercase()
        )
    }
}

/// `modulith.log` → `modulith.1.log`
///
/// 公开是为了让「清空日志」能枚举出全部文件而不再手写一遍命名规则 ——
/// 两处各写一遍，迟早会出现「清空之后还剩一个旧文件」。
pub fn rotated_name(name: &str, index: usize) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem}.{index}.{ext}"),
        None => format!("{name}.{index}"),
    }
}

/// 轮转：删掉最旧的一个，其余依次后移，当前文件变成 `.1`
///
/// `keep` 是**含当前文件**的保留个数。所有失败都忽略：轮转失败最多让当前文件继续
/// 变大，这不该让任何一条日志写不进去。
fn rotate(dir: &Path, name: &str, keep: usize) {
    if keep < 2 {
        let _ = std::fs::remove_file(dir.join(name));
        return;
    }

    let _ = std::fs::remove_file(dir.join(rotated_name(name, keep - 1)));

    for index in (1..keep - 1).rev() {
        let from = dir.join(rotated_name(name, index));
        if !from.exists() {
            continue;
        }
        let _ = std::fs::rename(&from, dir.join(rotated_name(name, index + 1)));
    }

    let current = dir.join(name);
    if current.exists() {
        let _ = std::fs::rename(&current, dir.join(rotated_name(name, 1)));
    }
}

/// 追加模式打开一个日志文件，必要时先轮转
fn open_log_file(
    dir: &Path,
    name: &str,
    keep: usize,
    max_bytes: u64,
) -> std::io::Result<(File, PathBuf, u64)> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);

    // 上一次运行留下的文件可能已经超限（例如上次是崩溃退出的），先轮转再打开，
    // 否则它会把新一次运行的记录也吞进一个已经过大的文件里。
    let existing = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if existing >= max_bytes {
        rotate(dir, name, keep);
    }

    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((file, path, size))
}

/// 当前打开着的运行日志文件
struct Sink {
    file: File,
    size: u64,
}

struct Inner {
    /// `None` = 还没配置落盘目录（启动早期），记录先排队
    dir: Option<PathBuf>,
    file_logging: bool,
    crash_logging: bool,
    sink: Option<Sink>,
    pending: Vec<String>,
    /// 队列满时丢掉的条数，配置目录后补记一条汇总
    dropped: usize,
}

/// 文件日志器
pub struct FileLogger {
    inner: Mutex<Inner>,
    /// 是否同时写 stderr。
    ///
    /// **只在调试构建里开。** release 版是 GUI 子系统，没有 stderr 可写；
    /// 而 `tauri dev` 的终端里能看到日志对开发是刚需 —— 那正是以前
    /// 「全是 console 没有落盘」时唯一能用的东西，不该因为加了文件日志就失去。
    ///
    /// 测试里关掉：测日志本身就是往日志里灌数据，镜像到 stderr 会把
    /// `cargo test` 的输出冲得看不见失败原因。
    mirror_to_stderr: bool,
}

impl FileLogger {
    /// 创建一个尚未配置目录的日志器
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                dir: None,
                // 还没读到用户设置之前的姿态：都开着。
                // 反过来的话，一次「读设置时崩溃」就没有任何记录 —— 而那恰恰是最需要记录的。
                file_logging: true,
                crash_logging: true,
                sink: None,
                pending: Vec::new(),
                dropped: 0,
            }),
            mirror_to_stderr: cfg!(all(debug_assertions, not(test))),
        }
    }

    /// 拿锁；锁中毒（持锁线程 panic 了）时继续用里面的数据
    ///
    /// 日志系统在「上一条日志写崩了」之后必须仍然能工作 —— 那正是最需要它的时候。
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 配置落盘目录与两个开关（模块 setup 时调用一次）
    pub fn configure(&self, dir: PathBuf, file_logging: bool, crash_logging: bool) {
        let mut inner = self.lock();

        inner.dir = Some(dir.clone());
        inner.file_logging = file_logging;
        inner.crash_logging = crash_logging;
        inner.sink = None;

        if !file_logging {
            // 关着也要把队列丢掉：它们是上一次会话开头的内容，
            // 一直留着只会在用户后来打开开关时凭空出现在日志里。
            inner.pending.clear();
            inner.dropped = 0;
            return;
        }

        if let Err(e) = std::fs::create_dir_all(&dir) {
            // 连目录都建不出来：此时还没有日志可写，只能记在内存里等下一次 configure
            inner.pending.push(format!(
                "无法创建日志目录 {}：{}",
                dir.display(),
                e
            ));
            return;
        }

        let (file, path, size) = match open_log_file(&dir, LOG_FILE_NAME, MAX_LOG_FILES, MAX_LOG_BYTES)
        {
            Ok(opened) => opened,
            Err(e) => {
                inner.pending.push(format!(
                    "无法打开日志文件 {}：{}",
                    dir.join(LOG_FILE_NAME).display(),
                    e
                ));
                return;
            }
        };

        inner.sink = Some(Sink { file, size });

        let banner = format!(
            "===== 新会话 {} | Modulith Desktop {} | {} {} | {} =====",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            path.display()
        );
        inner.write_line(&banner);

        let pending = std::mem::take(&mut inner.pending);
        let dropped = inner.dropped;
        inner.dropped = 0;
        if dropped > 0 {
            inner.write_line(&format!(
                "启动早期有 {dropped} 条日志因缓冲区已满被丢弃（上限 {MAX_PENDING_RECORDS} 条）"
            ));
        }
        for line in pending {
            inner.write_line(&line);
        }
    }

    /// 运行期改两个开关（用户改设置时调用）
    ///
    /// 返回是否有实际变化，供调用方决定要不要记一条「已开启/已关闭」。
    ///
    /// **注意这里不发日志。** 它持有日志器的锁，而 `log::*` 会再次去拿同一把锁 ——
    /// 在 `Mutex` 上那是死锁，不是性能问题。
    pub fn set_switches(&self, file_logging: bool, crash_logging: bool) -> bool {
        let mut inner = self.lock();
        let changed = inner.file_logging != file_logging || inner.crash_logging != crash_logging;

        inner.crash_logging = crash_logging;

        if inner.file_logging == file_logging {
            return changed;
        }
        inner.file_logging = file_logging;

        if file_logging {
            // 打开：接着写现有文件（必要时轮转），并把之前的丢弃计数补上
            if let Some(dir) = inner.dir.clone() {
                if let Ok((file, _, size)) =
                    open_log_file(&dir, LOG_FILE_NAME, MAX_LOG_FILES, MAX_LOG_BYTES)
                {
                    inner.sink = Some(Sink { file, size });
                }
            }
        } else {
            // 关闭：先 flush 再丢掉句柄，别让最后几行留在缓冲区里
            if let Some(mut sink) = inner.sink.take() {
                let _ = sink.file.flush();
            }
            inner.pending.clear();
            inner.dropped = 0;
        }

        changed
    }

    /// 写一条记录（`log` 门面与崩溃记录都走这里）
    pub fn emit(&self, level: log::Level, target: &str, message: &str) {
        let line = format_line(level, target, message);

        if self.mirror_to_stderr {
            eprintln!("{line}");
        }

        let mut inner = self.lock();

        if !inner.file_logging {
            return;
        }

        if inner.dir.is_none() {
            if inner.pending.len() < MAX_PENDING_RECORDS {
                inner.pending.push(line);
            } else {
                // 满了就丢掉**最早**的一条（环形），而不是拒绝新的。
                //
                // 队列存在的意义只是覆盖「logger 已安装、日志目录还没拿到」那一小段
                // 窗口（正常只有几毫秒、十来条记录），因此它几乎不可能真的满。
                // 真满了说明启动阶段出了别的问题，而那时**离问题最近**的记录
                // 比最开头那几条更有用。
                inner.pending.remove(0);
                inner.pending.push(line);
                inner.dropped += 1;
            }
            return;
        }

        inner.write_line(&line);

        if inner.dropped > 0 {
            let dropped = inner.dropped;
            inner.dropped = 0;
            inner.write_line(&format!(
                "启动早期有 {dropped} 条日志因缓冲区已满被丢弃（上限 {MAX_PENDING_RECORDS} 条）"
            ));
        }
    }

    /// 写一条崩溃记录
    ///
    /// 不受「实时记录」开关影响，只受「崩溃记录」开关影响 —— 理由见 `settings.rs`
    /// 的 `crash_logging_enabled` 字段说明。
    pub fn write_crash(&self, message: &str) {
        if self.mirror_to_stderr {
            eprintln!("[崩溃] {message}");
        }

        let inner = self.lock();
        if !inner.crash_logging {
            return;
        }
        let Some(dir) = inner.dir.clone() else {
            // 目录还没配置就崩了。没有落盘位置可用，只能放弃。
            return;
        };

        // 崩溃是低频事件，每次都重新打开文件即可 —— 不保留句柄就不会出现
        // 「崩溃时句柄状态本身有问题」这种二阶故障。
        let Ok((mut file, _, _)) =
            open_log_file(&dir, CRASH_FILE_NAME, MAX_CRASH_FILES, MAX_CRASH_BYTES)
        else {
            return;
        };

        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(file, "{stamp} {message}");
        let _ = file.flush();
    }

    /// flush（`log` 门面的 `flush` 走这里）
    pub fn flush(&self) {
        let mut inner = self.lock();
        if let Some(sink) = inner.sink.as_mut() {
            let _ = sink.file.flush();
        }
    }

    /// 已配置的日志目录
    pub fn dir(&self) -> Option<PathBuf> {
        self.lock().dir.clone()
    }

    /// 两个开关的当前状态（实时记录, 崩溃记录）
    pub fn switches(&self) -> (bool, bool) {
        let inner = self.lock();
        (inner.file_logging, inner.crash_logging)
    }

    /// 当前运行日志文件的完整路径（只要配置过目录就返回，不保证文件存在）
    pub fn current_log_path(&self) -> Option<PathBuf> {
        self.lock().dir.as_ref().map(|dir| dir.join(LOG_FILE_NAME))
    }

    /// 清空所有日志文件，返回删除的文件个数
    ///
    /// **必须先关掉句柄再删文件。** Windows 上删除一个仍被打开的文件会失败
    /// （共享冲突），表现为「点了清空，文件还在」。这也意味着清空要由日志器
    /// 自己完成，而不是让调用方去 `fs::remove_file`。
    pub fn clear(&self) -> Result<usize, String> {
        let mut inner = self.lock();

        if let Some(mut sink) = inner.sink.take() {
            let _ = sink.file.flush();
        }

        let Some(dir) = inner.dir.clone() else {
            return Err("日志目录尚未配置".to_string());
        };

        let mut removed = 0usize;
        let mut first_error: Option<String> = None;

        let mut targets = vec![dir.join(LOG_FILE_NAME), dir.join(CRASH_FILE_NAME)];
        for index in 1..MAX_LOG_FILES {
            targets.push(dir.join(rotated_name(LOG_FILE_NAME, index)));
        }
        for index in 1..MAX_CRASH_FILES {
            targets.push(dir.join(rotated_name(CRASH_FILE_NAME, index)));
        }

        for path in targets {
            if !path.exists() {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) => {
                    if first_error.is_none() {
                        first_error = Some(format!("{}：{}", path.display(), e));
                    }
                }
            }
        }

        // 重新打开，让「清空之后又有新记录」能立刻写进去 ——
        // 否则用户点完清空会发现日志再也不更新了。
        if inner.file_logging {
            if let Ok((file, _, size)) =
                open_log_file(&dir, LOG_FILE_NAME, MAX_LOG_FILES, MAX_LOG_BYTES)
            {
                inner.sink = Some(Sink { file, size });
            }
        }

        match first_error {
            // 一个都没删掉才算失败；部分失败仍然算成功，但要说明
            Some(e) if removed == 0 => Err(format!("清空日志失败：{e}")),
            _ => Ok(removed),
        }
    }
}

/// 仅供本文件测试使用
#[cfg(test)]
impl FileLogger {
    fn pending_len_for_test(&self) -> usize {
        self.lock().pending.len()
    }
}

impl Inner {
    /// 追加一行；必要时轮转。任何失败都静默放弃。
    fn write_line(&mut self, line: &str) {
        if self.sink.is_none() {
            let Some(dir) = self.dir.clone() else { return };
            if let Ok((file, _, size)) =
                open_log_file(&dir, LOG_FILE_NAME, MAX_LOG_FILES, MAX_LOG_BYTES)
            {
                self.sink = Some(Sink { file, size });
            }
        }

        let needed = line.len() as u64 + 1;

        if let Some(sink) = self.sink.as_ref() {
            if sink.size + needed > MAX_LOG_BYTES {
                // 先 flush 旧的，再轮转，最后重开
                if let Some(mut old) = self.sink.take() {
                    let _ = old.file.flush();
                }
                if let Some(dir) = self.dir.clone() {
                    rotate(&dir, LOG_FILE_NAME, MAX_LOG_FILES);
                    if let Ok((file, _, size)) =
                        open_log_file(&dir, LOG_FILE_NAME, MAX_LOG_FILES, MAX_LOG_BYTES)
                    {
                        self.sink = Some(Sink { file, size });
                    }
                }
            }
        }

        let Some(sink) = self.sink.as_mut() else { return };
        if sink.file.write_all(line.as_bytes()).is_ok() && sink.file.write_all(b"\n").is_ok() {
            sink.size += needed;
        }
    }
}

impl Default for FileLogger {
    fn default() -> Self {
        Self::new()
    }
}

/// 挂到 `log` 门面上的薄包装
struct GlobalLogger(Arc<FileLogger>);

impl log::Log for GlobalLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        // 级别过滤交给 `log::set_max_level`；这里不做二次判断，
        // 否则会出现「设了 Debug 却什么都收不到」这种两处配置打架的现象。
        true
    }

    fn log(&self, record: &log::Record) {
        self.0
            .emit(record.level(), record.target(), &record.args().to_string());
    }

    fn flush(&self) {
        self.0.flush();
    }
}

/// 全局日志器（进程内唯一）
static LOGGER: OnceLock<Arc<FileLogger>> = OnceLock::new();

/// 取全局日志器（未安装时为 `None`）
pub fn global() -> Option<Arc<FileLogger>> {
    LOGGER.get().cloned()
}

/// 安装 logger 与崩溃钩子；重复调用是安全的
///
/// **必须在 `main()` 最早期调用。** 这时还没有日志目录，记录先进入内存队列，
/// 等 `configure()` 拿到目录后按原顺序落盘。
pub fn install_early() -> Arc<FileLogger> {
    if let Some(existing) = LOGGER.get() {
        return existing.clone();
    }

    let logger = Arc::new(FileLogger::new());

    // Debug 级：`tauri-plugin-updater` 自己会在 debug 级别打出
    // `checking for updates {url}` —— 正是「更新连不上」时最需要的那一行，
    // 而它不在我们的代码里，没法把它提到 info。文件有轮转上限，量是可控的。
    log::set_max_level(log::LevelFilter::Debug);

    match log::set_boxed_logger(Box::new(GlobalLogger(logger.clone()))) {
        Ok(()) => {
            let _ = LOGGER.set(logger.clone());
            install_panic_hook(logger.clone());
        }
        Err(e) => {
            // 已经有人装过了（例如测试或二次调用）：沿用现状，不要覆盖
            eprintln!("[WARN] 日志器安装失败，沿用已有的日志器: {e}");
        }
    }

    LOGGER.get().cloned().unwrap_or(logger)
}

/// 安装 panic 钩子
///
/// 保留原有的钩子并继续调用它：默认钩子会打印带回溯的 panic 信息，开发时有用；
/// 而 release 版 GUI 进程没有 stderr，所以真正的价值在于写进崩溃日志文件。
pub fn install_panic_hook(logger: Arc<FileLogger>) {
    let previous = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<未命名线程>").to_string();

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<未知位置>".to_string());

        let payload = if let Some(text) = info.payload().downcast_ref::<&str>() {
            (*text).to_string()
        } else if let Some(text) = info.payload().downcast_ref::<String>() {
            text.clone()
        } else {
            "<非字符串 panic 载荷>".to_string()
        };

        logger.write_crash(&format!(
            "线程 {thread_name} 在 {location} panic: {payload}"
        ));

        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时目录：用进程 id + 序号避免并发测试互相踩
    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "modulith-log-test-{}-{}-{}",
            std::process::id(),
            tag,
            seq
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn read_all(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn format_line_has_time_level_and_target() {
        let line = format_line(log::Level::Warn, "plugins", "插件 X 已卸载");
        assert!(line.contains("WARN"), "{line}");
        assert!(line.contains("[plugins]"), "{line}");
        assert!(line.contains("插件 X 已卸载"), "{line}");
        // 时间戳形如 2026-09-19 10:00:00.123
        assert!(line.len() > 23, "{line}");
        assert_eq!(&line[4..5], "-");
        assert_eq!(&line[10..11], " ");

        // 没有 target 时不留一对空方括号
        let line = format_line(log::Level::Error, "", "炸了");
        assert!(!line.contains("[]"), "{line}");
        assert!(line.contains("ERROR"), "{line}");
    }

    #[test]
    fn configure_writes_a_session_banner() {
        let dir = temp_dir("banner");
        let logger = FileLogger::new();
        logger.configure(dir.clone(), true, true);

        let text = read_all(&dir.join(LOG_FILE_NAME));
        assert!(text.contains("新会话"), "{text}");
        assert!(text.contains(env!("CARGO_PKG_VERSION")), "{text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn early_records_are_buffered_then_flushed_in_order() {
        let dir = temp_dir("pending");
        let logger = FileLogger::new();

        // 还没有目录：应当排队而不是丢失
        logger.emit(log::Level::Info, "auth", "第一条");
        logger.emit(log::Level::Info, "plugins", "第二条");
        assert_eq!(logger.pending_len_for_test(), 2);

        logger.configure(dir.clone(), true, true);

        let text = read_all(&dir.join(LOG_FILE_NAME));
        let first = text.find("第一条").expect("第一条应当落盘");
        let second = text.find("第二条").expect("第二条应当落盘");
        assert!(first < second, "顺序必须保持：{text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disabled_file_logging_writes_nothing() {
        let dir = temp_dir("disabled");
        let logger = FileLogger::new();
        logger.configure(dir.clone(), false, true);

        logger.emit(log::Level::Info, "settings", "不该出现");
        logger.flush();

        assert!(
            !dir.join(LOG_FILE_NAME).exists(),
            "关掉实时记录后不该产生日志文件"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn toggling_file_logging_at_runtime_starts_and_stops_writing() {
        let dir = temp_dir("toggle");
        let logger = FileLogger::new();
        logger.configure(dir.clone(), false, true);

        logger.emit(log::Level::Info, "t", "关着的时候");
        assert!(logger.set_switches(true, true), "开关应当报告发生了变化");

        logger.emit(log::Level::Info, "t", "打开之后");
        let text = read_all(&dir.join(LOG_FILE_NAME));
        assert!(!text.contains("关着的时候"), "{text}");
        assert!(text.contains("打开之后"), "{text}");

        logger.set_switches(false, true);
        logger.emit(log::Level::Info, "t", "又关了");
        let text = read_all(&dir.join(LOG_FILE_NAME));
        assert!(!text.contains("又关了"), "{text}");

        // 没有变化时返回 false，避免调用方记一条假的「已切换」
        assert!(!logger.set_switches(false, true));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn crash_records_are_independent_of_file_logging() {
        let dir = temp_dir("crash");
        let logger = FileLogger::new();
        logger.configure(dir.clone(), false, true);

        logger.write_crash("线程 main 在 src/x.rs:1:1 panic: boom");

        let crash = read_all(&dir.join(CRASH_FILE_NAME));
        assert!(crash.contains("boom"), "{crash}");
        assert!(
            !dir.join(LOG_FILE_NAME).exists(),
            "崩溃记录不该顺手打开运行日志"
        );

        // 关掉崩溃记录后不再写入
        logger.set_switches(false, false);
        let before = read_all(&dir.join(CRASH_FILE_NAME));
        logger.write_crash("第二条崩溃");
        assert_eq!(read_all(&dir.join(CRASH_FILE_NAME)), before);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_when_the_size_limit_is_reached() {
        let dir = temp_dir("rotate");
        let logger = FileLogger::new();
        logger.configure(dir.clone(), true, true);

        // 直接压着上限写：每条都接近 1 KB，够触发多次轮转
        let chunk = "x".repeat(900);
        for i in 0..4000 {
            logger.emit(log::Level::Info, "rot", &format!("{i}-{chunk}"));
        }
        logger.flush();

        assert!(dir.join(LOG_FILE_NAME).exists(), "当前文件应当在");
        assert!(dir.join(rotated_name(LOG_FILE_NAME, 1)).exists(), "应当有 .1");
        assert!(dir.join(rotated_name(LOG_FILE_NAME, 2)).exists(), "应当有 .2");
        assert!(
            !dir.join(rotated_name(LOG_FILE_NAME, 3)).exists(),
            "超出保留个数的文件不该存在"
        );

        for name in [
            LOG_FILE_NAME.to_string(),
            rotated_name(LOG_FILE_NAME, 1),
            rotated_name(LOG_FILE_NAME, 2),
        ] {
            let size = std::fs::metadata(dir.join(&name)).map(|m| m.len()).unwrap_or(0);
            // 允许一条记录溢出上限，但不该出现文件远超上限的情况
            assert!(size <= MAX_LOG_BYTES + 4096, "{name} 体积 {size} 超出上限");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_buffer_is_bounded_and_reports_drops() {
        let dir = temp_dir("overflow");
        let logger = FileLogger::new();

        for i in 0..(MAX_PENDING_RECORDS + 5) {
            logger.emit(log::Level::Info, "boot", &format!("第 {i} 条"));
        }
        assert_eq!(logger.pending_len_for_test(), MAX_PENDING_RECORDS);

        logger.configure(dir.clone(), true, true);
        let text = read_all(&dir.join(LOG_FILE_NAME));
        assert!(
            text.contains("因缓冲区已满被丢弃"),
            "溢出时必须留下一条说明，否则日志看起来只是「少了开头」"
        );
        assert!(
            !text.contains("第 0 条"),
            "溢出时丢掉的是最早的那几条（保留离问题最近的）"
        );
        assert!(
            text.contains(&format!("第 {} 条", MAX_PENDING_RECORDS + 4)),
            "最后一条必须留下"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_name_keeps_the_extension() {
        assert_eq!(rotated_name("modulith.log", 1), "modulith.1.log");
        assert_eq!(rotated_name("crash.log", 2), "crash.2.log");
        assert_eq!(rotated_name("noext", 1), "noext.1");
    }
}
