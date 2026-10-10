// src-tauri/src/modules/plugins/clipboard.rs
//
// 剪贴板变化监测（`ctx.clipboard.canMonitor` / `subscribe` / `readFormats` /
// `readImage`）：让插件能观察剪贴板的变化，从而做一个剪贴板历史。
//
// ============================================================
// 这是全仓库里最该把"最小化"放在第一位的一项能力
// ============================================================
//
// 剪贴板里出现的东西包括密码、两步验证码、私钥、助记词。与"读一个文件"不同，
// 这里没有"用户当场选中"这个动作可以当授权 —— 用户复制的**任何**东西都会经过
// 这条路径。因此这个模块的每一条限制都不是顺手加的：
//
//   1. **只有轮询，没有钩子。** `AddClipboardFormatListener` 会让宿主收到
//      每一次变化，但它要求一个窗口、一条消息循环，而且它把"变化发生了"和
//      "变化是什么"绑在一起。`GetClipboardSequenceNumber()` 是一个**整数读**，
//      它不打开剪贴板、不取内容，因此可以在"没变化"的绝大多数时候完全不碰用户
//      的数据（见下方"轮询"一节）。
//   2. **隐私标记优先于一切。** 读任何内容之前先看三个 Windows 约定格式，命中
//      就**一个字节都不读**（见下方"隐私守卫"一节）。
//   3. **文本有上限**，而且超长时**只给前 64 KiB**，不给整份。
//   4. **永不记录内容。** 这个文件里没有任何一条日志带 `text` —— 一份落进
//      `modulith.log` 的剪贴板历史比没有剪贴板历史糟得多（见下方"日志"一节）。
//   5. **没有订阅者时轮询线程必须停掉**，而不是空转（见下方"生命周期"一节）。
//
// ============================================================
// 为什么是轮询，而不是剪贴板钩子
// ============================================================
//
// `GetClipboardSequenceNumber()` 每次剪贴板内容变化就自增。它**不需要打开剪贴板**
// —— 也就是说，在没有变化的一轮里，宿主只付出一次整数读取的代价，用户剪贴板里的
// 内容一个字节都不会被碰。
//
// 替代方案与它们被否掉的理由：
//
//   * `AddClipboardFormatListener` + `WM_CLIPBOARDUPDATE`：需要把主窗口的
//     `hwnd` 与消息循环接进来，而宿主没有"某个窗口的 wndproc"这种可插入的地方
//     （窗口是 Tauri 建的）。更重要的是它并不比轮询更省：它同样是"先知道变了、
//     再去读"，而它多出来的是一条跨越 UI 线程的消息路径。
//   * **反复读全文再比较**：这是唯一被明确否掉的方案。它会**持续占用剪贴板**
//     （`OpenClipboard` 会挡住别人的复制），并且每一次比较都要把用户的全部
//     剪贴板内容搬进宿主内存 —— 包括那些本来被隐私标记保护着的内容。它看起来
//     "不引入新 API"，实际上是把这项能力最危险的那一面放大了。
//
// 间隔取 800 ms：底线是"用户复制完切回应用时历史已经在了"，上限是"不能成为一个
// 每秒上百次系统调用的后台负担"。它必须在 700..=1000 ms 之间（既有约定）。
//
// ============================================================
// 隐私守卫：Windows 上"不要监视我"的三个约定
// ============================================================
//
// 密码管理器（KeePass、1Password、Bitwarden…）会在剪贴板上放几个**注册格式**，
// 声明"这份内容不要进剪贴板历史、不要上传云剪贴板、不要被监视程序看到"：
//
//   * `ExcludeClipboardContentFromMonitorProcessing` —— 只要**出现**就表示
//     "任何监视程序都不该读它"；
//   * `CanIncludeInClipboardHistory` —— 值为 `0` 表示"不要进剪贴板历史"；
//   * `CanUploadToCloudClipboard` —— 值为 `0` 表示"不要上传到云剪贴板"。
//
// 命中任意一条，本模块**不打开内容、不交付事件**（`readFormats` / `readImage`
// 还会明确报错，而不是返回一个看起来正常的空结果）。
//
// **它是约定，不是强制。** 这一点必须说清楚，因为它决定了这项能力的真实强度：
// 只有"复制这份内容的那个程序"主动挂上这些格式时，用户才被保护。一个不合作的
// 程序（或一段直接调用 `SetClipboardData` 的脚本）放上去的任何东西，宿主都
// 没有技术手段分辨。文档里对用户说的也是这句话，不是"敏感内容会被自动跳过"。
//
// 判定本身是一个**纯函数**（`is_excluded`），因此它可以在没有真实剪贴板的情况下
// 被单测 —— 这是这个模块里最要紧、也最难在真机上复现的一条行为。
//
// ============================================================
// 日志：一个字都不许写
// ============================================================
//
// 本文件里的日志只记**格式个数与插件 id**，永远不记 `text` 与 `formats` 的内容。
// 理由不是"日志会变大"：`modulith.log` 是一个明文文件，会被用户发给我们排查问题，
// 而一次复制密码之后就把它写进去，等于我们在用户不知情的情况下收集了他的凭据。
// 需要追问"为什么没有事件"时，看的是格式个数与序列号，不是内容。
//
// ============================================================
// 生命周期：没有订阅者就没有线程
// ============================================================
//
// 订阅表**按插件 id** 一个键（一个插件是沙箱还是 in-process 在安装时就固定了，
// 因此一个键足够；值的集合里 `IN_PROCESS` 这个空串占位表示 in-process 订阅，
// 其余成员是发起订阅的沙箱界面名）。第一个订阅者到来时拉起轮询线程，最后一个
// 离开时把发送端丢掉 —— 线程因此**退出**，而不是留在那里空转。
//
// 线程与宿主之间只用一条 `mpsc` 通道：`recv_timeout` 既是"睡 800 ms"，
// 也是"被叫醒的入口"。发送端被丢弃时它立刻返回 `Disconnected`，所以退出不需要
// `join`、也不会卡在最长 800 ms 的睡眠里，更不存在"向已关闭通道发送"的 panic。

use std::collections::{BTreeSet, HashMap};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use super::types::PluginPermission;

// ============================================================
// 上限（三个数字都写在这里，因为文档要引用它们）
// ============================================================

/// 一次变化事件里携带的文本上限：**64 KiB（UTF-8 字节）**。
///
/// 理由是最直白的那一个：用户可能复制了一整份 200 MB 的日志文件，而每一个订阅了
/// 剪贴板的插件都会收到一份 —— 那是把宿主的 IPC 与插件的堆内存一起透支。
///
/// 超过上限时**只交付前 64 KiB**，并且在 UTF-8 字符边界上截断（切坏一个多字节
/// 字符会在 JSON 里变成乱码）。`truncate_text` 是那条规则唯一的实现。
///
/// **截断没有任何标志位**：`change` 的形状是冻结的三字段。这是刻意的 ——
/// 加一个 `truncated: true` 会让"文本恰好 64 KiB"与"文本被截断"两种情况看起来
/// 不一样，于是插件会写出依赖那个标志的分支，而它只在这一条通道上被保证。
/// 插件该做的是**按上限自检**：`text.length` 接近上限时就把它当成可能不完整。
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

/// 交付给插件的编码后 PNG 上限：**8 MiB**。
///
/// 之所以按"编码后"算而不是按像素算：插件拿到的是 data URL 字符串，占内存的是
/// 那一份。8 MiB 的 PNG 在 base64 之后约 11 MiB，再经一次 IPC 已经不少了。
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// 图片尺寸上限（宽与高各自）：**4096**。
///
/// 与 8 MiB 是两条独立的判据，不能只留一条：
///   * 尺寸上限挡的是"一个谎报了几十万像素的 DIB 头"——`biWidth` 是外部输入，
///     不先挡住它，解码路径会先按它分配内存；
///   * 体积上限挡的是"合法尺寸但内容太大"。
///
/// 4096 是按"4K 屏幕的一张截图"定的。
pub const MAX_IMAGE_DIMENSION: u32 = 4096;

/// 轮询间隔（毫秒）。契约要求落在 700..=1000 之间。
///
/// 800 是"复制完切回应用时历史已经在了"与"不成为一个后台负担"之间的取值。
pub const POLL_INTERVAL_MS: u64 = 800;

/// 从剪贴板一次读取的最大字节数（**资源保护**，不是交付上限）。
///
/// 交付上限是 8 MiB，这里留了很大余量：先看 `GlobalSize` 再决定要不要拷进内存，
/// 一个被手工塞进去的几百 MB 的格式不会让宿主先分配再判断。超过它的情况会得到
/// 一句说清体积的错误，而不是被当成"剪贴板里没有图片"。
const MAX_READ_BYTES: usize = 64 * 1024 * 1024;

/// 从 `CF_UNICODETEXT` 里最多取多少个 UTF-16 单元。
///
/// 它约束的是"转换前要搬多少"：一个 200 MB 的文本不该先被完整转成 UTF-8 再截断。
/// 取 `MAX_TEXT_BYTES`（65536 个单元 = 128 KiB 源数据）已经足以产出超过 64 KiB
/// 的 UTF-8（1 字节字符每个单元 1 字节），转换之后再按字节截断。
const MAX_TEXT_UNITS: usize = MAX_TEXT_BYTES;

/// 非 Windows 平台上所有读写接口的统一说法。
///
/// 单独抽出来是因为它要在三个地方出现（RPC、命令层、前端降级文案），而三处各写
/// 一句就会有三份措辞不同的"不支持"，排查时看起来像三个不同的问题。
pub const UNSUPPORTED_PLATFORM: &str =
    "剪贴板监测只在 Windows 上可用：它依赖 Win32 的剪贴板序列号与注册格式\
     （GetClipboardSequenceNumber / RegisterClipboardFormatW），这里没有对应实现";

/// 隐私守卫命中时的统一说法。
///
/// **不是"剪贴板是空的"。** 空结果会让插件与用户都以为复制没成功，而真实原因是
/// 复制这份内容的程序要求任何监视程序都不要看它 —— 用户需要知道的是后者。
pub const EXCLUDED_BY_MARKER: &str =
    "剪贴板内容被复制它的程序标记为「不要监视」（ExcludeClipboardContentFromMonitorProcessing \
     或 CanIncludeInClipboardHistory=0 / CanUploadToCloudClipboard=0），宿主不读取它。\
     这是 Windows 上密码管理器一类程序的约定，不是本应用的判断";

// ============================================================
// 格式：原始名 → 友好名
// ============================================================

/// 一个剪贴板格式的**原始**观测量。
///
/// `dword` 只在两个云剪贴板标记上有值：它们的语义在**值**里（0 = 不要），
/// 因此"格式出现了没有"不够，还要看它是什么。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatProbe {
    /// 原始名字：标准格式是 `CF_*`，注册格式是注册时给的字符串。
    pub name: String,
    /// 该格式的 DWORD 值（读不到时为 `None`）。
    pub dword: Option<u32>,
}

/// 三个隐私标记格式的名字。**必须逐字**是这三个字符串 —— 它们是 Windows 与
/// 各密码管理器之间的约定，拼错一个字母就等于这个守卫不存在，而且没有任何症状。
const EXCLUDE_FROM_MONITORING: &str = "ExcludeClipboardContentFromMonitorProcessing";
const CAN_INCLUDE_IN_HISTORY: &str = "CanIncludeInClipboardHistory";
const CAN_UPLOAD_TO_CLOUD: &str = "CanUploadToCloudClipboard";

/// 隐私判定：**纯函数**，只看格式列表。
///
/// 抽成纯函数不是为了好看 —— 它是这个模块里唯一一条在真机上**没法可靠复现**的
/// 行为（要造一份带标记的剪贴板内容，而标记本身正是用来阻止我们读取的）。把它
/// 变成"一个格式列表进来、一个布尔出去"，它就能被单测逐条钉住。
///
/// 两个"失败方向"都是刻意的：
///   * 两个云剪贴板标记**只有明确读到 1 才放行**。读不到值（句柄为空、内存锁不住、
///     内容不足 4 字节）一律按"不允许"处理。判错的代价是不交付一次变化，
///     而另一个方向是可能把不该读的东西读出来 —— 两者不对等。
///   * `ExcludeClipboardContentFromMonitorProcessing` 只要**出现**就拒绝，
///     不看值：它的语义就是"存在即排除"。
pub fn is_excluded(probes: &[FormatProbe]) -> bool {
    probes.iter().any(|probe| {
        if probe.name == EXCLUDE_FROM_MONITORING {
            return true;
        }
        if probe.name == CAN_INCLUDE_IN_HISTORY || probe.name == CAN_UPLOAD_TO_CLOUD {
            return probe.dword != Some(1);
        }
        false
    })
}

/// 原始格式名 → 交给插件的友好名。
///
/// **这张表是刻意的短名单。** 剪贴板上的格式有几十种（本机私有格式、OLE 内部格式、
/// 各种应用自定义的服务格式），把它们全须全尾地交给插件，等于把一份"这台机器上
/// 装了什么软件"的指纹送出去 —— 而插件真正能用上的只有下面这几类内容。
/// 认不出的格式因此**不出现**在 `formats` 里，而不是带着一串原始名字出现。
///
/// 返回值不是 `String` 而是 `&'static str`：调用方拿去比较、去重，没有理由为它
/// 每次分配一次。
pub fn friendly_format(raw: &str) -> Option<&'static str> {
    Some(match raw {
        // 三行文本格式。`CF_OEMTEXT` 出现在老程序里，内容与 `CF_TEXT` 同类。
        "CF_UNICODETEXT" | "CF_TEXT" | "CF_OEMTEXT" => "text/plain",
        // 浏览器与办公软件复制的富文本。剪贴板上的正式注册名就是 "HTML Format"。
        "HTML Format" => "text/html",
        // `CF_DIB` / `CF_DIBV5` 是宿主自己编码成 PNG 的两条来源；注册格式 "PNG"
        // 是浏览器与截图工具直接放上来的**已编码** PNG（那条路径更省，也更大）。
        "CF_DIB" | "CF_DIBV5" | "PNG" => "image/png",
        // 资源管理器里复制的文件。插件拿不到路径（那需要另一项权限），但"这是一批
        // 文件"这件事本身是有用的。
        "CF_HDROP" | "FileNameW" => "files",
        "Rich Text Format" | "CF_RTF" => "text/rtf",
        // 设备相关位图。**我们无法把它编码出去**（那要经 GDI 取像素），但插件值得
        // 知道剪贴板上有一张图。
        "CF_BITMAP" => "image/bmp",
        _ => return None,
    })
}

/// 把一次枚举的结果映射成友好格式名（去重，保持枚举顺序）。
///
/// 保留枚举顺序而不是排序：同一份剪贴板内容每次枚举的顺序是稳定的，因此插件看到
/// 的数组顺序也是稳定的 —— 排序会引入一个"看起来变了、其实没变"的 diff。
pub fn friendly_formats(probes: &[FormatProbe]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for probe in probes {
        if let Some(name) = friendly_format(&probe.name) {
            if !out.iter().any(|seen| seen == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

// ============================================================
// 交付形状
// ============================================================

/// 一次剪贴板变化。**这就是给插件的 `change` 对象，字段一一对应。**
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// 剪贴板上的文本；**没有文本时为 `None`，不是空串**。
    ///
    /// 空串是一个合法取值（用户复制了一段空内容），因此"没有文本"必须用 `None`
    /// 表达 —— 否则插件分不清"复制了空内容"与"只复制了一张图"。
    pub text: Option<String>,
    /// 友好格式名。隐私守卫没有挡住时，这里面至少有一样东西。
    pub formats: Vec<String>,
    /// **宿主观察到这次变化的时刻**（毫秒时间戳）。
    ///
    /// 是宿主的时刻，不是"用户按 Ctrl+C 的时刻"：轮询最多晚 800 ms，而那个延迟
    /// 无法被观测到。用它做排序是可靠的，用它做"精确到毫秒的剪贴板时间线"不是。
    pub at: i64,
}

impl Change {
    /// 序列化成线路上的形状。**只有这一处** —— 事件与沙箱推送共用它，两处各写
    /// 一份字段名，漂开的表现是"一个运行位置收得到、另一个收到 null"。
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "text": self.text,
            "formats": self.formats,
            "at": self.at,
        })
    }
}

// ============================================================
// 纯函数：截断、PNG 体积、PNG 尺寸、DIB → RGBA
// ============================================================

/// 按 **UTF-8 字节**截断，并且**落在字符边界上**。
///
/// 按字节硬切会把一个多字节字符切成两半：那半截字节序列不是合法 UTF-8，在 JSON
/// 里会变成替换字符 —— 中文剪贴板会中招，而症状是"最后一个字变成了乱码"，看起来
/// 像插件自己的编码问题。
pub fn truncate_text(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// `icon.rs::encode_png_rgba` 对给定尺寸会产出多少字节。
///
/// **它不是估算，是精确值**：那个编码器用的是 zlib 的非压缩存储块，输出长度由
/// 尺寸完全决定（每块 5 字节头 + 每行 1 字节滤波 + 固定开销）。
///
/// 有这个函数才能在**分配像素缓冲之前**判断"这张图交付不了"，而不是先花 64 MiB
/// 分配再报错。它与编码器之间的同步由一条测试保证（`png_size_matches_the_encoder`
/// 真的去编码几种尺寸再比长度），因此公式漂开时会红，而不是安静地少算几百字节。
pub fn png_size_for_rgba(width: u32, height: u32) -> usize {
    let raw = (width as usize * 4 + 1) * height as usize;
    let blocks = (raw + 0xFFFF) / 0x1_0000;
    // 8(签名) + 25(IHDR) + 12(IDAT 头尾) + 12(IEND) + 2(zlib 头) + 4(Adler-32)
    // + raw + 每块 5 字节
    63 + raw + 5 * blocks
}

/// 从一份 PNG 的 IHDR 里读宽高。**不是解码** —— 只需要前 24 字节。
///
/// 用它而不是信任 `biWidth` 一类的外部声明：注册格式 "PNG" 在剪贴板上是**任意
/// 程序**放上去的一段字节，尺寸上限必须先在这一段上核实，否则"尺寸上限"就只是
/// 一个我们愿意相信的声明。
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

/// 把 `CF_DIB` / `CF_DIBV5` 的字节转成 RGBA8 像素。
///
/// 只支持 **BI_RGB 的 24/32 位**，其余（调色板、BITFIELDS、RLE、JPEG/PNG 压缩的
/// DIB）返回一句说清原因的错误。这个范围不是随意划的：浏览器、截图工具、Office
/// 复制图片时给的就是这两种；而支持调色板要写一套 GDI 调用（`CF_PALETTE` 是另一个
/// 格式，句柄不能跨进程直接用），为那些来源写几百行不可测的代码不划算。
///
/// 纯函数：输入字节、输出像素，因此它能在没有剪贴板的情况下被单测覆盖 ——
/// 包括"自下而上"这个最容易写错、写错了只看得出"图倒了"的地方。
pub fn dib_to_rgba(dib: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    const HEADER_BYTES: usize = 40;

    if dib.len() < HEADER_BYTES {
        return Err("剪贴板里的位图数据不完整（连 40 字节的 BITMAPINFOHEADER 都不够）".to_string());
    }

    let header_size = u32::from_le_bytes(dib[0..4].try_into().unwrap_or([0; 4])) as usize;
    let width_raw = i32::from_le_bytes(dib[4..8].try_into().unwrap_or([0; 4]));
    let height_raw = i32::from_le_bytes(dib[8..12].try_into().unwrap_or([0; 4]));
    let bit_count = u16::from_le_bytes(dib[14..16].try_into().unwrap_or([0; 2]));
    let compression = u32::from_le_bytes(dib[16..20].try_into().unwrap_or([0; 4]));

    if header_size < HEADER_BYTES || header_size > dib.len() {
        return Err(format!(
            "剪贴板里的位图头长度不可信（{header_size} 字节），无法确定像素从哪里开始"
        ));
    }
    if width_raw <= 0 || height_raw == 0 {
        return Err(format!(
            "剪贴板里的位图尺寸非法（{width_raw}×{height_raw}）"
        ));
    }

    // 负高度表示**自上而下**。先取绝对值再决定行序，别在循环里判符号。
    let top_down = height_raw < 0;
    let width = width_raw as u32;
    let height = height_raw.unsigned_abs();

    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(format!(
            "剪贴板里的图片太大：{width}×{height} 像素，上限是每边 {MAX_IMAGE_DIMENSION} 像素"
        ));
    }
    if bit_count != 24 && bit_count != 32 {
        return Err(format!(
            "剪贴板里的图片是 {bit_count} 位色，本 API 只支持 24 位与 32 位（不支持的还有\
             调色板、BITFIELDS 与压缩 DIB）"
        ));
    }
    if compression != 0 {
        return Err(format!(
            "剪贴板里的图片用了压缩方式 {compression}，本 API 只支持未压缩（BI_RGB）的位图"
        ));
    }

    let bytes_per_pixel = (bit_count / 8) as usize;
    // DIB 的每一行按 4 字节对齐 —— 这一条漏掉的表现是"图整体斜着错位"。
    let stride = ((width as usize * bytes_per_pixel + 3) / 4) * 4;
    let pixels_offset = header_size;
    let needed = pixels_offset
        .checked_add(stride.checked_mul(height as usize).ok_or("位图尺寸溢出")?)
        .ok_or("位图尺寸溢出")?;
    if dib.len() < needed {
        return Err(format!(
            "剪贴板里的位图数据不完整：按头部算需要 {needed} 字节，实际只有 {} 字节",
            dib.len()
        ));
    }

    let mut rgba = vec![0u8; width as usize * height as usize * 4];

    for row in 0..height as usize {
        // 自下而上的 DIB 把**最后一行像素**放在最前面，因此第 row 行来自
        // `height - 1 - row`。写反了图是上下颠倒的，而颠倒的截图仍然"看起来
        // 像一张图"，很容易被当成插件的问题。
        let source_row = if top_down { row } else { height as usize - 1 - row };
        let source = &dib[pixels_offset + source_row * stride..];
        let target = &mut rgba[row * width as usize * 4..(row + 1) * width as usize * 4];

        for column in 0..width as usize {
            let s = column * bytes_per_pixel;
            let t = column * 4;
            // DIB 的字节序是 BGR(A)。
            target[t] = source[s + 2];
            target[t + 1] = source[s + 1];
            target[t + 2] = source[s];
            // 32 位 BI_RGB 的第 4 个字节按文档是**保留位**，实际内容未定义，而
            // 大多数程序写 0。原样透出去会得到一张全透明的 PNG（"图没了"），
            // 因此这里强制不透明 —— 剪贴板上的图片本来就极少带 alpha。
            target[t + 3] = 0xFF;
        }
    }

    Ok((width, height, rgba))
}

// ============================================================
// 变化检测：只看序列号的状态机
// ============================================================

/// "剪贴板变了没有"的判定，与剪贴板内容完全无关。
///
/// 单独抽出来是因为它承载着一条**容易被当成 bug 的行为**：订阅的那一刻不会把
/// 剪贴板里**已经存在**的内容当成一次变化交付。否则每装一个剪贴板历史插件，
/// 用户当时剪贴板里的东西（可能正是一个密码）就会被立刻送进那个插件 —— 而那
/// 与"插件在我复制之后才看到我复制的东西"是两件完全不同的事。
struct ChangeDetector {
    /// 已经**处理完**的那个序列号。
    last: u32,
    /// 看到的、但还没处理完的那个序列号。
    ///
    /// 它存在的唯一理由是"读失败"：别的程序占着剪贴板时这次变化必须留到下一轮，
    /// 而如果 `poll` 直接推进 `last`，那次复制就永久丢了（而且没有任何症状 ——
    /// 用户只会觉得"这个插件偶尔漏记一条"）。
    pending: Option<u32>,
}

impl ChangeDetector {
    fn new(sequence: u32) -> Self {
        Self {
            last: sequence,
            pending: None,
        }
    }

    /// 返回 `Some(序列号)` 当且仅当相对上一次**已处理**的序列号发生了变化。
    ///
    /// 调用方读完之后必须选一个：`commit()`（这次算处理过了）或 `discard()`
    /// （没读成，下一轮再来）。没有默认值 —— 默认值会让"忘了选"变成静默漏记录。
    fn poll(&mut self, sequence: u32) -> Option<u32> {
        if sequence == self.last {
            return None;
        }
        self.pending = Some(sequence);
        Some(sequence)
    }

    /// 这次处理完了，推进序列号。
    fn commit(&mut self) {
        if let Some(sequence) = self.pending.take() {
            self.last = sequence;
        }
    }

    /// 这次没读成，把序列号留在原处，下一轮重来。
    fn discard(&mut self) {
        self.pending = None;
    }
}

// ============================================================
// 一次读取的结果
// ============================================================

/// 一次"读剪贴板"的三种结果。
///
/// 三者必须分开，因为**序列号要不要推进**不同：读失败（别的程序占着剪贴板）如果
/// 推进了序列号，这次变化就永久丢了；而隐私命中与"没有任何可读内容"必须推进，
/// 否则每一轮都会重新去读同一份被保护的内容。
enum ReadOutcome {
    /// 读到了一次可以交付的变化
    Change(Change),
    /// 读到了，但内容被隐私标记挡住、或没有任何我们能交付的东西 → 推进序列号
    Skip,
    /// 连剪贴板都打不开 → **不推进**序列号，下一轮再试
    Retry,
}

// ============================================================
// 订阅表 + 轮询线程
// ============================================================

/// 值集合里代表 in-process 订阅的成员。
///
/// 空串永远不会是一个界面名（`surfaces` 解析会拒绝空 id），因此它不会与沙箱界面
/// 撞车。用一个字面量而不是 `Option`，是为了让"这张表同时服务两条路径"在类型上
/// 就是一件平常事，而不是让读的人以为某个插件只能属于其中一边。
const IN_PROCESS: &str = "";

/// 推送通道名（沙箱一条）。与 `sandbox-bridge.js` 的 `PUSH_HANDLERS` 逐字相同。
pub const PUSH_CHANNEL: &str = "clipboard";

#[derive(Default)]
struct MonitorState {
    /// `插件 id → 订阅者`。见本文件文件头"生命周期"一节。
    subscribers: HashMap<String, BTreeSet<String>>,
    /// 轮询线程的"活着"凭据。**`None` 就代表线程没在跑** —— 因此"没有订阅者时
    /// 停掉线程"这件事只有一个判据，不需要另一个布尔量去跟它同步。
    stop: Option<Sender<()>>,
}

/// 剪贴板监测的宿主状态。由 `lib.rs` 在 `setup` 里托管。
///
/// 它**不是**泛型：它自己不认识 `AppHandle`，轮询线程在启动时拿到一份克隆。
/// 这样 `app.manage(...)` 就不需要为每个 `R` 各来一次。
#[derive(Default)]
pub struct ClipboardMonitor {
    state: Mutex<MonitorState>,
}

impl ClipboardMonitor {
    fn lock(&self) -> MutexGuard<'_, MonitorState> {
        // 中毒的锁照样用：这张表里只有 `HashMap` 与一个发送端，没有"被写坏一半"
        // 的中间态。`unwrap` 会让一次无关的 panic 把剪贴板监测永久变成不可用，
        // 而"不可用"在这里是静默的（插件只是收不到变化）。
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn has_subscribers(&self) -> bool {
        !self.lock().subscribers.is_empty()
    }

    /// 记一次订阅，并在需要时**拉起轮询线程**。
    ///
    /// `surface` 为 `Some` 表示这是沙箱界面的订阅（`rpc.rs` 知道它在哪个界面里），
    /// `None` 表示 in-process（Tauri 命令那条路径没有界面身份）。
    pub fn subscribe<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        plugin_id: &str,
        surface: Option<&str>,
    ) -> Result<(), String> {
        if !is_supported() {
            return Err(UNSUPPORTED_PLATFORM.to_string());
        }

        let mut state = self.lock();

        let entry = state.subscribers.entry(plugin_id.to_string()).or_default();
        entry.insert(surface.unwrap_or(IN_PROCESS).to_string());

        if state.stop.is_none() {
            let (sender, receiver) = channel::<()>();
            state.stop = Some(sender);
            // 线程拿到的是 `AppHandle` 的克隆。它在退出时不需要被回收：进程退出
            // 会带走它，而这里的 `Arc` 本来就是宿主的运行时句柄。
            let handle = app.clone();
            // **不记线程句柄**：没有一条路径需要 `join` 它。加入 `JoinHandle` 只会
            // 诱使有人在退出时去 join —— 而那正是"卡在一个最长 800 ms 的睡眠上"的
            // 来源。停止靠的是丢发送端，见 `stop`。
            std::thread::spawn(move || pump(handle, receiver));
        }

        Ok(())
    }

    /// 撤一次订阅（`unsubscribe()`、界面关闭都走它）。
    ///
    /// **没有权限检查**：一条撤不掉的订阅就是一个泄漏的资源，而"因为权限变了所以
    /// 拒绝你退订"在这里没有任何好处。
    pub fn unsubscribe(&self, plugin_id: &str, surface: Option<&str>) {
        let mut state = self.lock();
        let member = surface.unwrap_or(IN_PROCESS);

        if let Some(entry) = state.subscribers.get_mut(plugin_id) {
            entry.remove(member);
            if entry.is_empty() {
                state.subscribers.remove(plugin_id);
            }
        }

        self.stop_if_idle(&mut state);
    }

    /// 忘掉一个插件的**全部**订阅（停用 / 卸载）。
    ///
    /// 与 `unsubscribe` 分开：那里是"我这一块界面不收了"，这里是"这个插件不在了"。
    /// 混成一个会让一次界面关闭把同一插件**另一个界面**的订阅一起撤掉。
    pub fn forget_plugin(&self, plugin_id: &str) {
        let mut state = self.lock();
        state.subscribers.remove(plugin_id);
        self.stop_if_idle(&mut state);
    }

    /// 停掉轮询线程（应用退出时显式调用）。
    pub fn stop(&self) {
        let mut state = self.lock();
        state.subscribers.clear();
        state.stop = None;
    }

    /// 没有订阅者时把发送端丢掉 —— 线程在 `recv_timeout` 上立刻收到
    /// `Disconnected` 并退出。**这就是"停止"，不是"空转"**。
    fn stop_if_idle(&self, state: &mut MonitorState) {
        if state.subscribers.is_empty() {
            state.stop = None;
        }
    }
}

/// 轮询线程。
fn pump<R: Runtime>(app: AppHandle<R>, receiver: std::sync::mpsc::Receiver<()>) {
    let mut detector = ChangeDetector::new(win::sequence_number());

    loop {
        match receiver.recv_timeout(std::time::Duration::from_millis(POLL_INTERVAL_MS)) {
            // 有人显式发了停止信号
            Ok(()) => return,
            // 发送端被丢弃 = 没人再订阅了。**没有 panic 的分支**：通道关闭在这里
            // 是完全正常的退出路径。
            Err(RecvTimeoutError::Disconnected) => return,
            // 到点，去看一眼序列号
            Err(RecvTimeoutError::Timeout) => {}
        }

        // 先看序列号：没变就一个字节都不碰。**绝大多数轮次走的是这一条。**
        if detector.poll(win::sequence_number()).is_none() {
            continue;
        }

        match win::read_change() {
            // 打不开剪贴板（别的程序占着）时不推进序列号 —— 下一轮再试。
            ReadOutcome::Retry => detector.discard(),
            ReadOutcome::Skip => detector.commit(),
            ReadOutcome::Change(change) => {
                detector.commit();
                deliver(&app, &change);
            }
        }
    }
}

/// 把一次变化交给全部订阅者。
///
/// **两条路径各自只推给需要它的那一侧**：in-process 插件只有 Tauri 事件那一条
/// 出口，沙箱插件只有 `push_to` 那一条。两边都推是"简单"，代价是沙箱插件订阅的
/// 每一次变化都会把用户的剪贴板内容再送进宿主前端 realm 一份 —— 那份内容在那里
/// 没有任何消费者，而它是一次纯粹的多余暴露。
fn deliver<R: Runtime>(app: &AppHandle<R>, change: &Change) {
    let Some(monitor) = app.try_state::<ClipboardMonitor>() else {
        return;
    };

    // 先取一份快照再推。持着锁去 emit / postMessage 会让一次推送失败（或一次慢的
    // 前端）把订阅表的读写一起堵住。
    let targets: Vec<(String, BTreeSet<String>)> = {
        let state = monitor.lock();
        state
            .subscribers
            .iter()
            .map(|(plugin_id, surfaces)| (plugin_id.clone(), surfaces.clone()))
            .collect()
    };
    if targets.is_empty() {
        return;
    }

    let payload = change.to_json();

    use tauri::Emitter;

    for (plugin_id, surfaces) in targets {
        if surfaces.contains(IN_PROCESS) {
            if let Err(error) = app.emit(
                super::rpc::CLIPBOARD_CHANGE,
                serde_json::json!({
                    "pluginId": plugin_id,
                    "change": payload.clone(),
                }),
            ) {
                // 只记"推不出去"，**绝不记推的是什么**（见文件头"日志"一节）。
                // `error` 也照记：Tauri 这条错误只可能来自通道本身（序列化失败或
                // 接收端不在），它不会把负载带回来。
                log::debug!("广播剪贴板变化给 {} 失败：{error}", plugin_id);
            }
        }

        let sandbox_surfaces: Vec<&String> =
            surfaces.iter().filter(|surface| !surface.is_empty()).collect();
        if sandbox_surfaces.is_empty() {
            continue;
        }

        let Some(registry) = app.try_state::<super::sandbox::SandboxSurfaces>() else {
            continue;
        };

        // 按 `(插件, 界面)` 找令牌：订阅表里存的是界面名，而推送需要令牌。
        // 界面数量是有界的，因此线性扫一遍比维护第二张反向表更不容易漂。
        for (token, key) in registry.live() {
            if key.plugin_id != plugin_id {
                continue;
            }
            if !sandbox_surfaces.iter().any(|surface| **surface == key.surface) {
                continue;
            }
            super::sandbox::push_to(app, &token, PUSH_CHANNEL, payload.clone());
        }
    }
}

/// 需要 `ClipboardMonitor` 权限。**与其它能力同一条判据**：没声明就是拒绝。
///
/// 单独摘出来，是因为两个调用方（RPC 与命令层）都要做这件事，而漏掉任意一处的
/// 后果是"没声明也能监测剪贴板"—— 那种缺陷在代码里看不出来，每一处单独读都像
/// 是对的。
pub fn require_permission(
    manager: &super::manager::PluginManager,
    plugin_id: &str,
) -> Result<(), String> {
    manager
        .require_permission(plugin_id, PluginPermission::ClipboardMonitor)
        .map_err(|e| e.to_string())
}

// ============================================================
// 平台层
// ============================================================

/// 这个平台支不支持剪贴板监测。前端用 `canMonitor()` 读它。
pub fn is_supported() -> bool {
    win::SUPPORTED
}

/// 读一次剪贴板上的**友好格式名**（一次性读，不要求先订阅）。
pub fn read_formats() -> Result<Vec<String>, String> {
    win::read_formats()
}

/// 读剪贴板上的图片，返回 **PNG data URL**。
///
/// 三条返回路径，必须分得开：
///   * `Ok(Some(url))` —— 有一张图，而且它在上限之内；
///   * `Ok(None)` —— 剪贴板上**没有**图片；
///   * `Err(...)` —— 有一张图，但它超限了（尺寸或体积）。此时事件里的 `formats`
///     仍然会列出 `image/png`，插件据此知道"那里有东西，只是宿主不给"。
///
/// 把后两者混成 `None` 是最糟的一种处理：作者会写"没有图片就提示用户复制一张"，
/// 而用户明明复制了一张 4K 截图 —— 那个分支永远不会走到，也没有任何线索。
pub fn read_image() -> Result<Option<String>, String> {
    win::read_image()
}

/// data URL 前缀。抽出来是为了让"返回的是 PNG"只有一处定义。
const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";

fn data_url(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    format!("{PNG_DATA_URL_PREFIX}{}", BASE64.encode(bytes))
}

/// 图片超限时的统一说法。
///
/// 三件事必须都在里面：**实际多大**、**上限多少**、**怎么知道那里有东西**。
/// 只说"图片太大"，作者只会去调小尺寸试；而最后那一句告诉他
/// `formats` 里仍然有 `image/png`，他可以据此给用户一个准确的提示。
fn oversize_message(actual_bytes: usize, width: u32, height: u32) -> String {
    format!(
        "剪贴板里的图片超过本 API 的体积上限：{width}×{height} 像素编码后是 {actual_bytes} 字节，\
         上限是 {MAX_IMAGE_BYTES} 字节（8 MiB）。PNG 由宿主的非压缩编码器产出，因此体积接近\
         像素数的 4 倍 —— 想拿到它就请用户先缩小图片。变化事件里的 formats 仍然会列出 \
         image/png，可以据此告诉用户「剪贴板里有一张过大的图片」"
    )
}

// ============================================================
// Windows 实现
// ============================================================

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardFormatNameW,
        GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    use super::*;

    pub const SUPPORTED: bool = true;

    // ============================================================
    // 标准剪贴板格式的数值
    // ============================================================
    //
    // **必须自己写这几个整数。** `CF_*` 常量在 windows-sys 的
    // `Win32::System::Ole` 模块里，而本仓库只为剪贴板这件事打开了
    // `Win32_System_DataExchange` 与 `Win32_System_Memory` 两个特性
    // （见 Cargo.toml）。为了九个整数去打开整个 Ole 模块不划算 —— 而那几个值
    // 是 Win32 的 ABI 常量，永远不会变。
    //
    // 每一个都对着 `Ole/mod.rs` 的 `pub const CF_*: CLIPBOARD_FORMAT` 抄下来，
    // 并在 `standard_format_ids_are_the_documented_ones` 里逐条钉住。
    const CF_TEXT: u32 = 1;
    const CF_BITMAP: u32 = 2;
    const CF_OEMTEXT: u32 = 7;
    const CF_DIB: u32 = 8;
    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;
    const CF_LOCALE: u32 = 16;
    const CF_DIBV5: u32 = 17;

    /// 一次读剪贴板的 RAII 打开。
    ///
    /// `OpenClipboard` 与 `CloseClipboard` 必须成对，而中间有**五条** early return
    /// 路径（没有文本、格式枚举失败、隐私命中……）。手写 `CloseClipboard` 的话，
    /// 漏掉任意一条都会让剪贴板被这个进程一直占着 —— 表现是"复制粘贴全都不灵了"，
    /// 而且是别的程序在受害。
    struct Opened;

    impl Opened {
        fn try_open() -> Option<Self> {
            // 传 NULL：让当前任务成为所有者。失败（别的程序占着）时返回 `None`，
            // 由调用方决定是重试还是跳过 —— 这里不该自己重试，那会把一次轮询
            // 变成一段不可预期长度的占用。
            let ok = unsafe { OpenClipboard(std::ptr::null_mut::<c_void>() as HWND) };
            if ok == 0 {
                None
            } else {
                Some(Self)
            }
        }
    }

    impl Drop for Opened {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    /// 三个隐私标记格式的 id。注册是幂等的（同名永远得到同一个 id），因此缓存。
    fn marker_ids() -> &'static [u32; 3] {
        static IDS: OnceLock<[u32; 3]> = OnceLock::new();
        IDS.get_or_init(|| {
            [
                register_format(EXCLUDE_FROM_MONITORING),
                register_format(CAN_INCLUDE_IN_HISTORY),
                register_format(CAN_UPLOAD_TO_CLOUD),
            ]
        })
    }

    /// 已编码 PNG 的注册格式 id（浏览器与截图工具会放上来的那一条）。
    fn png_format_id() -> u32 {
        static ID: OnceLock<u32> = OnceLock::new();
        *ID.get_or_init(|| register_format("PNG"))
    }

    fn register_format(name: &str) -> u32 {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
    }

    /// 注册一个格式名并取回 id。`0` 表示注册失败。
    ///
    /// 测试里用它验证三个标记名与 Windows 的约定逐字一致 —— 拼错一个字母时
    /// `RegisterClipboardFormatW` **照样成功**（它只是新建了一个没人用的格式），
    /// 也就是说拼错不会有任何症状。唯一能钉住名字的办法是把字符串本身写进测试。
    #[cfg(test)]
    pub fn register_format_for_test(name: &str) -> u32 {
        register_format(name)
    }

    pub fn sequence_number() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    /// 一个格式 id 的原始名字。
    fn format_name(id: u32) -> String {
        let standard = match id {
            CF_TEXT => Some("CF_TEXT"),
            CF_BITMAP => Some("CF_BITMAP"),
            CF_OEMTEXT => Some("CF_OEMTEXT"),
            CF_DIB => Some("CF_DIB"),
            CF_UNICODETEXT => Some("CF_UNICODETEXT"),
            CF_HDROP => Some("CF_HDROP"),
            CF_LOCALE => Some("CF_LOCALE"),
            CF_DIBV5 => Some("CF_DIBV5"),
            _ => None,
        };
        if let Some(name) = standard {
            return name.to_string();
        }

        // 注册格式：128 个 UTF-16 单元足够任何真实的名字，而 `GetClipboardFormatNameW`
        // 在缓冲区不够时会把名字**截断**（返回值仍是截断后的长度），因此不会溢出。
        let mut buffer = [0u16; 128];
        let length = unsafe { GetClipboardFormatNameW(id, buffer.as_mut_ptr(), buffer.len() as i32) };
        if length > 0 {
            return String::from_utf16_lossy(&buffer[..length as usize]);
        }

        // 既不是标准格式、又取不到名字（`CF_OWNERDISPLAY` 一类）。保留一个稳定的
        // 记号而不是空串：空串会让"两个不同的无名格式"看起来是同一种东西。
        format!("CF_?{id}")
    }

    /// 枚举当前剪贴板上的全部格式，并读出隐私标记需要的 DWORD 值。
    fn collect_probes() -> Vec<FormatProbe> {
        let markers = marker_ids();

        let mut probes = Vec::new();
        // `EnumClipboardFormats(0)` 返回第一个格式；之后每次传上一个返回值。
        // 返回 0 表示枚举结束 —— 也因此**不能用 0 当格式 id**。
        let mut current = unsafe { EnumClipboardFormats(0) };
        // 上界存在的理由：这一层调用的前提是剪贴板已经被我们打开，但一个畸形的
        // 剪贴板实现（或一个正在被写的剪贴板）理论上能让这个循环不收敛。4000 远
        // 高于任何真实剪贴板的格式数。
        let mut guard = 0;
        while current != 0 && guard < 4000 {
            guard += 1;
            let name = format_name(current);
            let dword = if markers.contains(&current) {
                read_dword(current)
            } else {
                None
            };
            probes.push(FormatProbe { name, dword });
            current = unsafe { EnumClipboardFormats(current) };
        }
        probes
    }

    /// 读一个格式的 DWORD 值。**不读内容**：只拷 4 个字节。
    fn read_dword(id: u32) -> Option<u32> {
        unsafe {
            let handle = GetClipboardData(id);
            if handle.is_null() {
                return None;
            }
            let pointer = GlobalLock(handle) as *const u8;
            if pointer.is_null() {
                return None;
            }
            let size = GlobalSize(handle);
            let value = if size >= 4 {
                let mut buffer = [0u8; 4];
                std::ptr::copy_nonoverlapping(pointer, buffer.as_mut_ptr(), 4);
                Some(u32::from_le_bytes(buffer))
            } else {
                None
            };
            // 解锁是必须的：`GlobalLock` 的计数不平掉会让这块内存在剪贴板里
            // 一直处于锁定状态。
            GlobalUnlock(handle);
            value
        }
    }

    /// 读一个格式的全部字节。
    ///
    /// **先看 `GlobalSize` 再决定要不要拷。** 交付上限是 8 MiB，但这里的上限是
    /// 64 MiB —— 它挡的是"先拷几百 MB 进内存，再发现超限"。超限时返回的错误里
    /// 带着真实体积，调用方据此给出可照做的说法。
    fn read_format_bytes(id: u32) -> Result<Option<Vec<u8>>, String> {
        unsafe {
            let handle = GetClipboardData(id);
            if handle.is_null() {
                return Ok(None);
            }
            let pointer = GlobalLock(handle) as *const u8;
            if pointer.is_null() {
                return Ok(None);
            }

            let size = GlobalSize(handle);
            if size > MAX_READ_BYTES {
                GlobalUnlock(handle);
                return Err(format!(
                    "剪贴板里这个格式有 {size} 字节，超过宿主一次能读取的上限 \
                     {MAX_READ_BYTES} 字节，因此没有把它读进内存"
                ));
            }

            let bytes = std::slice::from_raw_parts(pointer, size).to_vec();
            GlobalUnlock(handle);
            Ok(Some(bytes))
        }
    }

    /// 读 `CF_UNICODETEXT`，**按单元数封顶**（见 `MAX_TEXT_UNITS`）。
    fn read_text() -> Option<String> {
        unsafe {
            let handle = GetClipboardData(CF_UNICODETEXT);
            if handle.is_null() {
                return None;
            }
            let pointer = GlobalLock(handle) as *const u16;
            if pointer.is_null() {
                return None;
            }

            let size = GlobalSize(handle);
            let units = (size / 2).min(MAX_TEXT_UNITS);
            let slice = std::slice::from_raw_parts(pointer, units);
            // 文本自带结尾的 NUL。`GlobalSize` 常常比实际内容大（分配器的对齐），
            // 因此必须找到那个 NUL，否则会把一段未初始化的字节读成文本。
            let end = slice.iter().position(|unit| *unit == 0).unwrap_or(units);
            let text = String::from_utf16_lossy(&slice[..end]);

            GlobalUnlock(handle);
            Some(text)
        }
    }

    fn now_ms() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    /// 轮询线程用的那一次读取。
    pub fn read_change() -> ReadOutcome {
        let Some(_opened) = Opened::try_open() else {
            return ReadOutcome::Retry;
        };

        let probes = collect_probes();
        // **隐私守卫在一切读取之前。** 命中之后这里不再取任何内容 —— 包括文本。
        if is_excluded(&probes) {
            return ReadOutcome::Skip;
        }

        let formats = friendly_formats(&probes);
        let text = read_text().map(|value| truncate_text(&value, MAX_TEXT_BYTES));

        // 既没有文本、也没有认识的格式（例如剪贴板上只有一份应用私有数据）：
        // 没有可交付的东西，但**序列号要推进**，否则每一轮都会重读它。
        if text.is_none() && formats.is_empty() {
            return ReadOutcome::Skip;
        }

        ReadOutcome::Change(Change {
            text,
            formats,
            at: now_ms(),
        })
    }

    pub fn read_formats() -> Result<Vec<String>, String> {
        let Some(_opened) = Opened::try_open() else {
            return Err(
                "暂时打不开剪贴板（另一个程序正占用它）。请稍后再试 —— 这不是权限问题".to_string(),
            );
        };

        let probes = collect_probes();
        if is_excluded(&probes) {
            return Err(EXCLUDED_BY_MARKER.to_string());
        }
        Ok(friendly_formats(&probes))
    }

    pub fn read_image() -> Result<Option<String>, String> {
        let Some(_opened) = Opened::try_open() else {
            return Err(
                "暂时打不开剪贴板（另一个程序正占用它）。请稍后再试 —— 这不是权限问题".to_string(),
            );
        };

        let probes = collect_probes();
        if is_excluded(&probes) {
            return Err(EXCLUDED_BY_MARKER.to_string());
        }

        // ---- 优先取已经编码好的 PNG ----
        //
        // 浏览器、截图工具、Office 复制图片时都会放这一条。它有两个好处：宿主
        // **不需要编解码**，而且宿主那个非压缩编码器的输出比真实 PNG 大得多
        // （见 `png_size_for_rgba`），因此这条路径能交付更大的图。
        if let Some(bytes) = read_format_bytes(png_format_id())? {
            let Some((width, height)) = png_dimensions(&bytes) else {
                return Err(
                    "剪贴板里的 PNG 数据不完整或不是合法 PNG（读不到 IHDR 里的尺寸），\
                     宿主拒绝把它交给插件"
                        .to_string(),
                );
            };
            if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
                return Err(format!(
                    "剪贴板里的图片太大：{width}×{height} 像素，上限是每边 \
                     {MAX_IMAGE_DIMENSION} 像素。变化事件里的 formats 仍然会列出 image/png"
                ));
            }
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(oversize_message(bytes.len(), width, height));
            }
            return Ok(Some(data_url(&bytes)));
        }

        // ---- 退回到 DIB ----
        let dib = match read_format_bytes(CF_DIB)? {
            Some(bytes) => Some(bytes),
            None => read_format_bytes(CF_DIBV5)?,
        };
        let Some(dib) = dib else {
            // 既没有 PNG 也没有 DIB：剪贴板上没有图片。**这才是 `None`。**
            return Ok(None);
        };

        let (width, height, rgba) = dib_to_rgba(&dib)?;

        // 在**分配像素之前**就能算出编码后的体积（编码器是确定性的），因此超限的
        // 大图不会先花 64 MiB 分配再被拒。见 `png_size_for_rgba`。
        let encoded_size = png_size_for_rgba(width, height);
        if encoded_size > MAX_IMAGE_BYTES {
            return Err(oversize_message(encoded_size, width, height));
        }

        Ok(Some(data_url(&super::super::icon::encode_png_rgba(
            width, height, &rgba,
        ))))
    }
}

// ============================================================
// 非 Windows 实现
// ============================================================
//
// 保留同一个签名集合，因此上层的 `is_supported` / `read_formats` / `read_image`
// 不需要任何 `cfg`。**它必须"诚实地失败"**：`readImage` / `readFormats` 返回一句
// 说清原因的错误，而不是 `None` / 空数组 —— 后者会让插件把"这个平台没有这项
// 能力"读成"用户剪贴板里没有东西"。
#[cfg(not(windows))]
mod win {
    use super::*;

    pub const SUPPORTED: bool = false;

    pub fn sequence_number() -> u32 {
        0
    }

    /// 非 Windows 上不会有变化事件：线程根本不会起来（`subscribe` 直接拒绝）。
    pub fn read_change() -> ReadOutcome {
        ReadOutcome::Retry
    }

    pub fn read_formats() -> Result<Vec<String>, String> {
        Err(UNSUPPORTED_PLATFORM.to_string())
    }

    pub fn read_image() -> Result<Option<String>, String> {
        Err(UNSUPPORTED_PLATFORM.to_string())
    }
}

// ============================================================
// 测试
// ============================================================
//
// **这一组测试不碰真实剪贴板**，也不该碰：它们跑在开发机上，而开发机的剪贴板是
// 使用者的真实剪贴板 —— 一个会读它的测试会在 CI（没有剪贴板）上跳过，在没有 CI
// 的机器上读到别人的密码。被测对象因此全部是纯函数：格式映射、隐私判定、截断、
// PNG 体积公式、DIB 转换、变化检测。

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(name: &str) -> FormatProbe {
        FormatProbe {
            name: name.to_string(),
            dword: None,
        }
    }

    fn probe_with(name: &str, dword: u32) -> FormatProbe {
        FormatProbe {
            name: name.to_string(),
            dword: Some(dword),
        }
    }

    // ============================================================
    // 格式映射
    // ============================================================

    #[test]
    fn friendly_names_cover_the_documented_minimum() {
        // 契约里点名的那三个必须都在
        assert_eq!(friendly_format("CF_UNICODETEXT"), Some("text/plain"));
        assert_eq!(friendly_format("HTML Format"), Some("text/html"));
        assert_eq!(friendly_format("CF_DIB"), Some("image/png"));

        // 同一类内容的不同来源必须映射到**同一个**名字，否则插件要写两份判断
        assert_eq!(friendly_format("CF_TEXT"), Some("text/plain"));
        assert_eq!(friendly_format("CF_OEMTEXT"), Some("text/plain"));
        assert_eq!(friendly_format("PNG"), Some("image/png"));
        assert_eq!(friendly_format("CF_DIBV5"), Some("image/png"));

        // 认识但不常用的
        assert_eq!(friendly_format("CF_HDROP"), Some("files"));
        assert_eq!(friendly_format("Rich Text Format"), Some("text/rtf"));
    }

    /// 认不出的格式**不出现**，而不是带着原始名字出现。
    ///
    /// 这一条是隐私性的：剪贴板上的应用私有格式名常常带着软件名甚至文件路径，
    /// 原样交给插件等于顺手提供一份"这台机器上装了什么"的指纹。
    #[test]
    fn unknown_formats_are_dropped_not_forwarded() {
        assert_eq!(friendly_format("CF_LOCALE"), None);
        assert_eq!(friendly_format("CF_BITMAP_EXTRA_PRIVATE"), None);
        assert_eq!(friendly_format("AcmePasswordManager.SecretBlob"), None);
        assert_eq!(friendly_format("CF_?49152"), None);
    }

    #[test]
    fn friendly_formats_deduplicate_and_keep_order() {
        let probes = vec![
            probe("CF_UNICODETEXT"),
            probe("HTML Format"),
            probe("CF_TEXT"),
            probe("PNG"),
            probe("CF_DIB"),
            probe("CF_LOCALE"),
        ];
        assert_eq!(
            friendly_formats(&probes),
            vec!["text/plain", "text/html", "image/png"]
        );
        assert!(friendly_formats(&[]).is_empty());
    }

    // ============================================================
    // 隐私判定：这个模块最要紧的一组
    // ============================================================

    /// `ExcludeClipboardContentFromMonitorProcessing` **出现即排除**，不看值。
    #[test]
    fn the_exclude_marker_excludes_on_presence_alone() {
        assert!(is_excluded(&[
            probe("CF_UNICODETEXT"),
            probe(EXCLUDE_FROM_MONITORING),
            probe_with(EXCLUDE_FROM_MONITORING, 1),
        ]));
        assert!(is_excluded(&[probe(EXCLUDE_FROM_MONITORING)]));
    }

    /// 两个云剪贴板标记：**只有明确读到 1 才放行**。
    ///
    /// 判错的代价不对称：把"允许"当成"不允许"只是少交付一次变化；反过来是一次
    /// 隐私泄漏。因此 0、读不到值、以及任何其它取值都按排除处理。
    #[test]
    fn the_cloud_markers_fail_closed() {
        for marker in [CAN_INCLUDE_IN_HISTORY, CAN_UPLOAD_TO_CLOUD] {
            assert!(!is_excluded(&[probe_with(marker, 1)]), "{marker}=1 应当放行");
            assert!(is_excluded(&[probe_with(marker, 0)]), "{marker}=0 应当排除");
            assert!(
                is_excluded(&[probe(marker)]),
                "{marker} 读不到值时必须按排除处理（失败方向是隐私）"
            );
            assert!(
                is_excluded(&[probe_with(marker, 2)]),
                "{marker} 只有 1 是明确放行，其余一律排除"
            );
        }
    }

    #[test]
    fn ordinary_clipboard_content_is_not_excluded() {
        assert!(!is_excluded(&[]));
        assert!(!is_excluded(&[
            probe("CF_UNICODETEXT"),
            probe("HTML Format"),
            probe("CF_LOCALE"),
            probe_with("CF_SOMETHING", 0),
        ]));
    }

    /// 名字必须**逐字**正确。
    ///
    /// `RegisterClipboardFormatW` 对任何字符串都会成功（它只是新建一个格式），
    /// 因此拼错一个字母没有任何症状 —— 守卫会安静地失效。唯一能钉住它的办法就是
    /// 把这三个字符串本身写进断言。
    #[test]
    fn the_marker_names_match_the_windows_convention() {
        assert_eq!(
            EXCLUDE_FROM_MONITORING,
            "ExcludeClipboardContentFromMonitorProcessing"
        );
        assert_eq!(CAN_INCLUDE_IN_HISTORY, "CanIncludeInClipboardHistory");
        assert_eq!(CAN_UPLOAD_TO_CLOUD, "CanUploadToCloudClipboard");

        // 拼错的名字会注册成**另一个** id —— 在 Windows 上顺带验证一次。
        #[cfg(windows)]
        {
            let good = win::register_format_for_test(EXCLUDE_FROM_MONITORING);
            let typo = win::register_format_for_test("ExcludeClipboardContentFromMonitoring");
            assert_ne!(good, typo, "拼错的名字不该与约定的名字是同一个格式");
            assert_ne!(good, 0);
        }
    }

    // ============================================================
    // 文本截断
    // ============================================================

    #[test]
    fn short_text_is_returned_untouched() {
        assert_eq!(truncate_text("", MAX_TEXT_BYTES), "");
        assert_eq!(truncate_text("hello", MAX_TEXT_BYTES), "hello");
        // 恰好等于上限时**不截断**：这是"没有任何标志位"那条设计下唯一可判定的
        // 边界，写错一个 `>=` 会让所有等于上限的文本都少一个字。
        let exact = "a".repeat(MAX_TEXT_BYTES);
        assert_eq!(truncate_text(&exact, MAX_TEXT_BYTES), exact);
    }

    #[test]
    fn long_text_is_cut_to_the_cap() {
        let long = "a".repeat(MAX_TEXT_BYTES + 1234);
        let cut = truncate_text(&long, MAX_TEXT_BYTES);
        assert_eq!(cut.len(), MAX_TEXT_BYTES);
    }

    /// 截断必须落在**字符边界**上。
    ///
    /// 按字节硬切会把一个汉字切成两半，那半截字节在 JSON 里就成了替换字符 ——
    /// 用户看到的是"我复制的最后几个字变成了乱码"，而原因在一个他看不到的地方。
    #[test]
    fn truncation_never_splits_a_character() {
        // 一个汉字 3 字节：上限之内的最大整字数不是 3 的倍数时必然切在中间
        for cap in [1usize, 2, 4, 5, 7, 64 * 1024 - 1, 64 * 1024 - 2] {
            let text = "密".repeat(30000);
            let cut = truncate_text(&text, cap);
            assert!(cut.len() <= cap, "截断后不得超过上限");
            assert!(
                std::str::from_utf8(cut.as_bytes()).is_ok(),
                "截断结果必须是合法 UTF-8"
            );
            // 4 字节字符（emoji）同样不能被切开
            let emoji = "😀".repeat(20000);
            let cut = truncate_text(&emoji, cap);
            assert!(cut.len() <= cap);
            assert_eq!(cut.chars().count() * 4, cut.len(), "emoji 必须整字保留");
        }
    }

    // ============================================================
    // PNG 体积公式必须与编码器一致
    // ============================================================

    /// 公式算出来的就是编码器真正会产出的长度。
    ///
    /// 这条测试存在的理由是 `read_image` 靠它在**分配像素之前**判断超限：公式一旦
    /// 与 `icon.rs::encode_png_rgba` 漂开，超限判断就会算错 —— 而算小了的后果是
    /// 先分配 64 MiB 再报错，算大了的后果是把一张能交付的图拒掉。
    #[test]
    fn png_size_matches_the_encoder() {
        for (width, height) in [(1u32, 1u32), (2, 3), (17, 5), (64, 64), (255, 129)] {
            let rgba = vec![0u8; width as usize * height as usize * 4];
            let encoded = super::super::icon::encode_png_rgba(width, height, &rgba);
            assert_eq!(
                encoded.len(),
                png_size_for_rgba(width, height),
                "{width}×{height} 的公式与实际编码长度不一致"
            );
        }
    }

    #[test]
    fn png_dimensions_are_read_from_the_header() {
        let rgba = vec![0u8; 7 * 5 * 4];
        let png = super::super::icon::encode_png_rgba(7, 5, &rgba);
        assert_eq!(png_dimensions(&png), Some((7, 5)));

        // 不是 PNG 的东西一律返回 None，而不是猜一个尺寸
        assert_eq!(png_dimensions(b"not a png at all, really"), None);
        assert_eq!(png_dimensions(&[]), None);
    }

    // ============================================================
    // DIB → RGBA
    // ============================================================

    /// 造一个 `BITMAPINFOHEADER` + 像素的 DIB。
    fn make_dib(width: i32, height: i32, bit_count: u16, rows: &[Vec<u8>]) -> Vec<u8> {
        let bytes_per_pixel = (bit_count / 8) as usize;
        let stride = ((width as usize * bytes_per_pixel + 3) / 4) * 4;

        let mut out = Vec::new();
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&bit_count.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(stride as u32 * height.unsigned_abs()).to_le_bytes());
        out.extend_from_slice(&[0u8; 16]);

        for row in rows {
            let mut padded = row.clone();
            padded.resize(stride, 0);
            out.extend_from_slice(&padded);
        }
        out
    }

    /// 自下而上的 DIB：**最后一行像素排在最前面**。
    ///
    /// 写反的表现是"图是上下颠倒的"，而颠倒的截图仍然看起来像一张正常的图 ——
    /// 因此这条必须在纯函数层面钉死，不能靠"看起来对不对"。
    #[test]
    fn bottom_up_dib_is_flipped_into_reading_order() {
        // 两行 1 像素：文件里第一行是"底行"（红），第二行是"顶行"（蓝）
        let bottom = vec![0u8, 0, 255]; // BGR = red
        let top = vec![255u8, 0, 0]; // BGR = blue
        let dib = make_dib(1, 2, 24, &[bottom, top]);

        let (width, height, rgba) = dib_to_rgba(&dib).expect("应当转换成功");
        assert_eq!((width, height), (1, 2));
        // 输出的第 0 行必须是**顶行**（蓝）
        assert_eq!(&rgba[0..4], &[0, 0, 255, 255]);
        // 第 1 行是底行（红）
        assert_eq!(&rgba[4..8], &[255, 0, 0, 255]);
    }

    /// 负高度 = 自上而下，不该再翻一次。
    #[test]
    fn top_down_dib_is_kept_in_order() {
        let first = vec![0u8, 0, 255];
        let second = vec![255u8, 0, 0];
        let dib = make_dib(1, -2, 24, &[first, second]);

        let (_, _, rgba) = dib_to_rgba(&dib).expect("应当转换成功");
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[0, 0, 255, 255]);
    }

    /// 32 位的第 4 字节按文档是保留位、实际常被写成 0。
    ///
    /// 原样透出去会得到一张**全透明**的 PNG，而"图没了"看起来像插件渲染的问题。
    #[test]
    fn thirty_two_bit_dib_is_forced_opaque() {
        let pixel = vec![0u8, 0, 255, 0]; // BGRA，alpha 写的是 0
        let dib = make_dib(1, 1, 32, &[pixel]);

        let (_, _, rgba) = dib_to_rgba(&dib).expect("应当转换成功");
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
    }

    /// 行是按 4 字节对齐的：宽度不是 4 的倍数时，多出来的填充字节不能被当成像素。
    #[test]
    fn row_padding_is_respected() {
        // 3 像素 × 3 字节 = 9 字节 → 补到 12 字节
        let row = vec![0u8, 0, 255, 0, 0, 255, 0, 0, 255];
        let dib = make_dib(3, 1, 24, &[row]);
        assert_eq!(dib.len(), 40 + 12);

        let (width, _, rgba) = dib_to_rgba(&dib).expect("应当转换成功");
        assert_eq!(width, 3);
        assert_eq!(rgba.len(), 12);
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[8..12], &[255, 0, 0, 255]);
    }

    /// 不支持的形状必须**报错**，而不是产出一张看起来正常但其实错了的图。
    #[test]
    fn unsupported_dib_shapes_are_refused_with_a_reason() {
        let too_short = vec![0u8; 12];
        assert!(dib_to_rgba(&too_short).is_err());

        let palette = make_dib(1, 1, 8, &[vec![0u8; 4]]);
        let error = dib_to_rgba(&palette).expect_err("8 位色应当被拒绝");
        assert!(error.contains("24 位"), "错误里要说清支持什么：{error}");

        // 谎报了一个超出上限的宽度：必须在分配之前被拒
        let mut huge = make_dib(1, 1, 24, &[vec![0u8, 0, 0]]);
        huge[4..8].copy_from_slice(&(MAX_IMAGE_DIMENSION + 1).to_le_bytes());
        let error = dib_to_rgba(&huge).expect_err("超大尺寸应当被拒绝");
        assert!(error.contains("太大"), "{error}");

        // 头部声称的数据比实际给的多
        let truncated = make_dib(4, 4, 24, &[vec![0u8; 12]]);
        let error = dib_to_rgba(&truncated).expect_err("数据不完整应当被拒绝");
        assert!(error.contains("不完整"), "{error}");
    }

    // ============================================================
    // 变化检测
    // ============================================================

    /// **订阅的那一刻不会交付已有内容。**
    ///
    /// 否则每装一个剪贴板历史插件，用户当时剪贴板里的东西就会被立刻送进那个插件。
    /// 那是这项能力里最容易做错、也最难被发现的一处。
    #[test]
    fn subscribing_does_not_deliver_what_was_already_there() {
        let mut detector = ChangeDetector::new(7);
        assert_eq!(detector.poll(7), None, "刚订阅时不许交付已有内容");

        assert_eq!(detector.poll(8), Some(8), "之后的变化要交付");
        detector.commit();
        assert_eq!(detector.poll(8), None, "已处理过的序列号不再交付");
        assert_eq!(detector.poll(9), Some(9));
        detector.commit();
    }

    /// 读失败时序列号**不许推进**，否则那次复制永久丢失。
    ///
    /// 这是"别的程序正占着剪贴板"那条路径的可观察后果：它必须留到下一轮，
    /// 而且重试成功之后仍然只交付一次。
    #[test]
    fn a_failed_read_leaves_the_change_for_the_next_round() {
        let mut detector = ChangeDetector::new(1);

        assert_eq!(detector.poll(2), Some(2));
        detector.discard(); // 读失败（打不开剪贴板）

        assert_eq!(detector.poll(2), Some(2), "没读成的那一次必须还能被看到");
        detector.commit();
        assert_eq!(detector.poll(2), None, "读成之后不能重复交付");
    }

    // ============================================================
    // 常量与线路形状
    // ============================================================

    /// 契约里的 `change` 形状。字段名写错在 Rust 侧是**编译得过的**（`serde_json`
    /// 的 `json!` 不检查），而症状是插件的 `change.text` 永远是 `undefined`。
    #[test]
    fn change_serializes_to_the_frozen_shape() {
        let change = Change {
            text: Some("hi".to_string()),
            formats: vec!["text/plain".to_string()],
            at: 1700000000000,
        };
        assert_eq!(
            change.to_json(),
            serde_json::json!({ "text": "hi", "formats": ["text/plain"], "at": 1700000000000i64 })
        );

        // 没有文本时必须是 `null`，**不是空串**
        let image_only = Change {
            text: None,
            formats: vec!["image/png".to_string()],
            at: 1,
        };
        assert_eq!(image_only.to_json()["text"], serde_json::Value::Null);
    }

    /// 三个上限与轮询间隔就是文档里写的那些数字。
    ///
    /// 它们被文档、权限描述与这份代码同时引用，而改一个数字不会有任何编译错误。
    #[test]
    fn the_documented_limits_are_these_numbers() {
        assert_eq!(MAX_TEXT_BYTES, 64 * 1024);
        assert_eq!(MAX_IMAGE_BYTES, 8 * 1024 * 1024);
        assert_eq!(MAX_IMAGE_DIMENSION, 4096);
        assert!(
            (700..=1000).contains(&POLL_INTERVAL_MS),
            "轮询间隔必须落在 700..=1000 ms"
        );
    }

    /// 超限的错误里三件事都要在：实际体积、上限、以及"formats 里仍然有 image/png"。
    #[test]
    fn the_oversize_message_is_actionable() {
        let message = oversize_message(9 * 1024 * 1024, 1920, 1080);
        assert!(message.contains("1920×1080"), "{message}");
        assert!(message.contains("9437184"), "要说清实际体积：{message}");
        assert!(message.contains("8388608"), "要说清上限：{message}");
        assert!(message.contains("image/png"), "要给出可用的线索：{message}");
    }

    /// 订阅表按**插件 id** 分，而 in-process 与沙箱两条路径共用它。
    ///
    /// 这里不启动线程（那需要 `AppHandle`），只验证那张表的语义：加、删、以及
    /// "删到空就没了"。
    #[test]
    fn the_subscription_table_is_keyed_by_plugin() {
        let monitor = ClipboardMonitor::default();
        assert!(!monitor.has_subscribers());

        {
            let mut state = monitor.lock();
            state.subscribers.entry("a".into()).or_default().insert(IN_PROCESS.into());
            state.subscribers.entry("a".into()).or_default().insert("main".into());
            state.subscribers.entry("b".into()).or_default().insert("main".into());
        }
        assert!(monitor.has_subscribers());

        // 撤掉 b 的界面：b 消失，a 不受影响
        monitor.unsubscribe("b", Some("main"));
        assert_eq!(monitor.lock().subscribers.len(), 1);
        assert!(monitor.lock().subscribers.contains_key("a"));

        // 撤掉 a 的界面：a 还在（in-process 那一条还订阅着）
        monitor.unsubscribe("a", Some("main"));
        assert!(monitor.lock().subscribers.contains_key("a"));

        // 撤掉 a 的 in-process 订阅：整条消失
        monitor.unsubscribe("a", None);
        assert!(!monitor.has_subscribers());

        // 停用插件走 forget_plugin：一次把该插件的全部订阅清掉
        {
            let mut state = monitor.lock();
            state.subscribers.entry("c".into()).or_default().insert("main".into());
            state.subscribers.entry("c".into()).or_default().insert("detail".into());
        }
        monitor.forget_plugin("c");
        assert!(!monitor.has_subscribers());
    }
}
