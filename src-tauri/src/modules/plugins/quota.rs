// src-tauri/src/modules/plugins/quota.rs
//
// 每插件的资源配额与分页游标。
//
// ============================================================
// 为什么需要配额
// ============================================================
//
// 插件存储此前**一条上限都没有**：`storage_set` 只看"是不是合法 JSON"，
// 于是单个插件可以写进任意大的值、任意多的键。而 `storage_keys` 一次返回全部键、
// `ctx.storage.all()` 再把每个键的值逐个读出来拼成一个对象 —— 也就是说
// **插件的存储量直接决定它能让我们一次吃进多少内存**。
//
// 对一个把"内存占用"当作目标的项目来说，这条路径不能只靠"插件作者会自律"。
// 配额不是不信任谁，而是让"写爆"这件事有一个**确定的边界**，而不是一个
// 直到用户机器变慢才被发现的开放量。
//
// 三档限制分别对应三种不同的失控方式：
//   · 单个值：一次写进 100 MB 的 base64 -> 内存与磁盘各翻一倍；
//   · 键数量：每次练习存一条记录，两年后是几万个文件 -> 枚举一次就卡住；
//   · 总量：每项都不大但一直在加 -> 缓慢增长，最难察觉。
//
// ============================================================
// 为什么错误消息要带具体数字
// ============================================================
//
// "超出配额"这句话对插件作者没有用 —— 他需要知道**是哪一档、上限多少、
// 现在已经用了多少、这次想写多少**，才可能自己去修。
// 因此 `QuotaError::message()` 把这四个数字都写进消息里，
// 而不是让调用方去猜。
//
// ============================================================
// 分页游标为什么是不透明的
// ============================================================
//
// 游标编码了"上次读到哪个键"与"当时的过滤条件"。把它做成不透明字符串
// （而不是让调用方自己拼 `page=3`）的理由是：**页码在下标会变的列表上是错的**。
// 插件在翻页过程中删掉一个键，第二页就会漏掉一条。而"从某个键之后继续"
// 对增删都稳。让它不透明还顺带保住了将来改编码的自由。

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::types::PluginError;

// ============================================================
// 配额上限
// ============================================================

/// 单个键的值上限：1 MB。
///
/// 取得比"正常数据"宽很多（一个插件的普通配置是几 KB），但比"能伤到应用"小很多。
/// 目前插件里最大的单个值是看板插件里的图标 data URL（几十 KB 级），
/// 因此 1 MB 不会拦下任何正常用法。
pub const MAX_VALUE_BYTES: u64 = 1024 * 1024;

/// 单个插件的存储总量上限：8 MB。
///
/// 定在单值上限的 8 倍：既允许"存几十个大对象"，又让上限本身是一个
/// 用户能理解的数量级（比应用自己的日志上限 1 MB × 3 大，但仍然很小）。
pub const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;

/// 单个插件的键数量上限：2000。
///
/// 这一档的分子不是磁盘而是**枚举成本**：`storage_keys` 要在一次调用里
/// 列完目录，键越多越慢；而插件的典型模式（"一条记录一个键"）会让键数
/// 随使用时间线性增长。2000 条记录对一个本地优先的插件足够用很久，
/// 而它枚举一次的开销仍在毫秒级。
pub const MAX_KEYS: usize = 2000;

/// 一页最多返回多少个键。
///
/// 上限而不是默认值：即使调用方请求 100000，也只给这么多 ——
/// 分页的意义就是"不让一次调用把内存吃满"，能被调用方用一个参数绕过的分页
/// 等于没有分页。
pub const MAX_PAGE_SIZE: usize = 500;

/// 默认页大小。
pub const DEFAULT_PAGE_SIZE: usize = 200;

/// 把请求的页大小夹到合法区间。
///
/// `None` 取默认值，`0` 也取默认值（0 条一页没有意义，而报错会让一个无害的
/// 边界值变成插件加载失败）。越界则夹取而不是拒绝 —— 与项目里其它夹取同理。
pub fn clamp_page_size(requested: Option<usize>) -> usize {
    match requested {
        None => DEFAULT_PAGE_SIZE,
        Some(0) => DEFAULT_PAGE_SIZE,
        Some(size) => size.min(MAX_PAGE_SIZE),
    }
}

/// 哪一档配额被触发了
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuotaKind {
    /// 单个键的值太大
    ValueBytes,
    /// 键总数太多
    KeyCount,
    /// 存储总量太大
    TotalBytes,
}

impl QuotaKind {
    fn label(self) -> &'static str {
        match self {
            QuotaKind::ValueBytes => "单个值的大小",
            QuotaKind::KeyCount => "键的数量",
            QuotaKind::TotalBytes => "存储总量",
        }
    }

    fn unit(self) -> &'static str {
        match self {
            QuotaKind::KeyCount => "个",
            _ => "字节",
        }
    }
}

/// 一次配额判定的结果。
///
/// 全部数字都是"字节"或"个"，由 `message()` 统一格式化成人类可读的提示 ——
/// 格式化只在一个地方做，避免每个调用点各写一遍而某处漏掉单位。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaError {
    pub kind: QuotaKind,
    /// 该档的上限
    pub limit: u64,
    /// 判定时的当前用量（不含本次要写的内容）
    pub current: u64,
    /// 本次操作想要增加的量
    pub attempted: u64,
}

impl QuotaError {
    /// 生成给插件作者看的消息。
    ///
    /// 四个数字缺一不可：只有"超出上限"作者无从下手；有了当前值与本次增量，
    /// 他才知道该清理多少、或者该把哪个键拆开。
    pub fn message(&self) -> String {
        format!(
            "插件存储超出配额（{}）：上限 {} {}，当前已用 {} {}，本次要增加 {} {}。\
             请清理不再需要的数据，或把它拆成更小的条目。",
            self.kind.label(),
            format_amount(self.limit, self.kind),
            self.kind.unit(),
            format_amount(self.current, self.kind),
            self.kind.unit(),
            format_amount(self.attempted, self.kind),
            self.kind.unit(),
        )
    }

    /// 转成统一的插件错误类型
    pub fn into_error(self) -> PluginError {
        PluginError::QuotaExceeded(self.message())
    }
}

/// 按档位把数字格式化成人能读的形式。
///
/// 字节用 KB/MB，计数用原值 —— 把 2000 个键显示成 "1.9 KB" 是荒谬的。
fn format_amount(value: u64, kind: QuotaKind) -> String {
    match kind {
        QuotaKind::KeyCount => value.to_string(),
        _ => {
            if value >= 1024 * 1024 {
                format!("{:.1} MB", value as f64 / (1024.0 * 1024.0))
            } else if value >= 1024 {
                format!("{:.1} KB", value as f64 / 1024.0)
            } else {
                format!("{} B", value)
            }
        }
    }
}

/// 判定一次写入是否超配额。返回 `None` 表示放行。
///
/// 分工是刻意的：**判定是纯函数**（输入是四个数字），文件系统的事情留在调用方。
/// 这样这条规则可以被单元测试穷举覆盖，而不必构造真实的目录 ——
/// 项目里已经有过"规则只存在于散文里、没有人能直接跑它"的教训。
///
/// * `current_total_bytes` / `current_key_count`：写入**之前**该插件的用量
/// * `existing_value_bytes`：该键**原来**占用的字节（不存在时为 0）
/// * `new_value_bytes`：这次要写入的字节
/// * `is_new_key`：该键此前是否存在（用于判断键数会不会 +1）
pub fn check_write(
    current_total_bytes: u64,
    current_key_count: usize,
    existing_value_bytes: u64,
    new_value_bytes: u64,
    is_new_key: bool,
) -> Option<QuotaError> {
    // 第一档：单个值。它与另外两档正交 —— 一个 100 MB 的值哪怕插件总共只有这一个键、
    // 也仍然要拦，因为它一次就能让内存翻倍。
    if new_value_bytes > MAX_VALUE_BYTES {
        return Some(QuotaError {
            kind: QuotaKind::ValueBytes,
            limit: MAX_VALUE_BYTES,
            current: existing_value_bytes,
            attempted: new_value_bytes,
        });
    }

    // 第二档：键数量。覆盖写不增加键数，因此只有新键才判。
    if is_new_key && current_key_count >= MAX_KEYS {
        return Some(QuotaError {
            kind: QuotaKind::KeyCount,
            limit: MAX_KEYS as u64,
            current: current_key_count as u64,
            attempted: 1,
        });
    }

    // 第三档：总量。判的是**增量**而不是"新值本身"：覆盖一个已有键时，
    // 原来那部分字节会被释放，用 `new > limit` 判会误拦一次正常的缩小写入。
    let projected = current_total_bytes
        .saturating_sub(existing_value_bytes)
        .saturating_add(new_value_bytes);
    if projected > MAX_TOTAL_BYTES {
        return Some(QuotaError {
            kind: QuotaKind::TotalBytes,
            limit: MAX_TOTAL_BYTES,
            current: current_total_bytes,
            attempted: new_value_bytes,
        });
    }

    None
}

// ============================================================
// 分页游标
// ============================================================

/// 游标里携带的内容。
///
/// `prefix` 与 `page_size` 一并在内，是为了让"换一个过滤条件却沿用旧游标"
/// 这件事可以被**检测出来**而不是无声地给错结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CursorPayload {
    /// 上次返回的最后一个键；下一页从它**之后**开始
    after: String,
    /// 上次的过滤前缀
    prefix: String,
    /// 上次的页大小
    page_size: usize,
}

/// 编码一个游标
pub fn encode_cursor(after: &str, prefix: &str, page_size: usize) -> String {
    let payload = CursorPayload {
        after: after.to_string(),
        prefix: prefix.to_string(),
        page_size,
    };
    // 游标是我们自己产出的结构化数据，序列化失败在类型上不可能；
    // 真失败时给一个空串，调用方按"没有游标"处理（从头开始），
    // 而不是让一次翻页把整个调用变成错误。
    let json = serde_json::to_vec(&payload).unwrap_or_default();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

/// 解码一个游标。返回 `None` 表示游标非法（调用方应当从头发起）。
///
/// **非法游标不报错、而是从头开始**，理由是这里的失败没有安全含义：
/// 最坏结果是重复返回第一页，而报错会让插件的一次列表操作彻底失败。
/// 与之相对，`prefix` 不匹配**必须报错**（见 `resolve_cursor`）——
/// 那说明调用方自己弄混了，静默给错数据比失败更糟。
pub fn decode_cursor(cursor: &str) -> Option<(String, String, usize)> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()?;
    let payload: CursorPayload = serde_json::from_slice(&bytes).ok()?;
    Some((payload.after, payload.prefix, payload.page_size))
}

/// 解析调用方给的游标与本次的过滤条件，得到"从哪个键之后开始"。
///
/// 返回 `Err` 的唯一情况是**游标与当前的过滤条件不一致**。
/// 那不是一个可以忽略的小问题：它意味着调用方把 A 条件的游标用在了 B 条件上，
/// 继续下去会得到一份"看起来正常但缺了很多条"的列表 —— 而缺数据是最难发现的一类错误。
pub fn resolve_cursor(
    cursor: Option<&str>,
    prefix: &str,
) -> Result<Option<String>, PluginError> {
    let Some(cursor) = cursor.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let Some((after, cursor_prefix, _)) = decode_cursor(cursor) else {
        // 非法游标：从头开始。见 `decode_cursor` 的理由。
        return Ok(None);
    };

    if cursor_prefix != prefix {
        return Err(PluginError::SandboxViolation(format!(
            "分页游标与当前的过滤条件不一致：游标是按前缀 \"{}\" 生成的，\
             本次请求的前缀是 \"{}\"。请用同一个前缀重新开始分页。",
            cursor_prefix, prefix
        )));
    }

    Ok(Some(after))
}

/// 存储目录里一个条目的形状。
///
/// 存在的理由是让**用量统计**成为纯函数：真实实现要读元数据，而元数据来自文件
/// 系统、无法穷举。把"这个条目算不算、算多少"抽成数据之后，
/// 目录里混进子目录、非 `.json` 文件、读不到元数据的条目这些情况都能直接构造出来测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorageEntry {
    /// 是不是普通文件（子目录不算存储）
    pub is_file: bool,
    /// 扩展名是不是 `.json`（与"能被列出来的键"同一个判据）
    pub is_json: bool,
    /// 文件字节数
    pub len: u64,
}

/// 统计一组条目的用量。
///
/// 判据必须与 `plugins::manager::StoragePage` 的列举判据**逐字一致**（见
/// `StorageEntry` 上的说明）。两处不一致的后果很具体：用量说"你超了"，
/// 而列举里看不到任何能删的东西 —— 用户会觉得这个功能在胡说。
pub fn sum_storage(entries: &[StorageEntry]) -> (u64, usize) {
    let mut total_bytes: u64 = 0;
    let mut key_count: usize = 0;

    for entry in entries {
        if !entry.is_file || !entry.is_json {
            continue;
        }
        key_count += 1;
        // 饱和而不是回绕：用量被算成一个巨大的数字会导致**误拦**，
        // 而回绕成一个很小的数字会导致**放行**。两者之间选前者。
        total_bytes = total_bytes.saturating_add(entry.len);
    }

    (total_bytes, key_count)
}

/// 一页的切分结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSlice {
    pub keys: Vec<String>,
    /// 为空表示已经到底
    pub next_cursor: Option<String>,
}

/// 从**已排序**的键列表里切出一页。
///
/// 与文件系统无关，因此边界情况（恰好一页、删除后翻页、游标指向已删除的键、
/// 最后一页、空列表）都能直接构造出来跑。真实实现只负责枚举目录并调用它。
pub fn slice_page(
    sorted_keys: &[String],
    prefix: &str,
    after: Option<&str>,
    page_size: usize,
) -> PageSlice {
    // 0 会被夹成 1。
    //
    // 真实路径上 `clamp_page_size` 已经把 0 换成了默认值，所以这一行在运行时
    // 用不到。留着它是因为**"0 条一页"会让翻页永远不前进**：调用方拿到空页、
    // 拿到一个游标、再请求同一个位置，无限循环。一个不会卡住的兜底比一条
    // "必须记得夹取"的约定可靠。
    let page_size = page_size.max(1);

    // 从游标位置之后开始。用**排序后的下标**而不是"跳过等于 after 的那一项"：
    // 后者在 `after` 已经被删除时会退化成"从头开始"，
    // 而用户看到的是"翻到第二页却回到了第一页"。
    let start = match after {
        Some(after_key) => match sorted_keys.binary_search(&after_key.to_string()) {
            Ok(index) => index + 1,
            // 游标指向的键已经不在了：`Err(index)` 正是它**本该在**的位置，
            // 也就是"严格大于它的第一个键"，那恰好就是该继续的地方。
            Err(index) => index,
        },
        None => 0,
    };

    let start = start.min(sorted_keys.len());
    let end = (start + page_size).min(sorted_keys.len());
    let keys = sorted_keys[start..end].to_vec();

    // 只有真的还有下一页时才给游标 —— 给一个"下一页是空的"的游标会让调用方
    // 多走一次没有结果的请求，而那看起来像卡住了。
    let next_cursor = if end < sorted_keys.len() {
        keys.last()
            .map(|last| encode_cursor(last, prefix, page_size))
    } else {
        None
    };

    PageSlice { keys, next_cursor }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============================================================
    // 配额判定
    // ============================================================

    #[test]
    fn a_normal_write_is_allowed() {
        assert_eq!(check_write(0, 0, 0, 1024, true), None);
        assert_eq!(check_write(1024 * 1024, 50, 4096, 8192, false), None);
    }

    /// 单个值超限必须拦住 —— 而且**即使插件总共只有这一个键**也要拦。
    /// 这一档与另外两档正交，容易在重构时被合并进总量判断而失去作用。
    #[test]
    fn a_single_huge_value_is_rejected_even_when_it_is_the_only_key() {
        let error = check_write(0, 0, 0, MAX_VALUE_BYTES + 1, true).expect("必须拒绝");
        assert_eq!(error.kind, QuotaKind::ValueBytes);
        assert_eq!(error.limit, MAX_VALUE_BYTES);
    }

    /// 恰好等于上限必须放行。
    ///
    /// 边界取"大于"而不是"大于等于"：把上限写成不可达的数字会让文档里的
    /// "上限 1 MB"变成"实际上限 1 MB - 1 字节"，而那种偏差没人会去核对。
    #[test]
    fn exactly_at_the_value_limit_is_allowed() {
        assert_eq!(check_write(0, 0, 0, MAX_VALUE_BYTES, true), None);
    }

    #[test]
    fn key_count_limit_only_applies_to_new_keys() {
        // 覆盖已有键：允许，哪怕键数已经在上限
        assert_eq!(check_write(0, MAX_KEYS, 10, 10, false), None);
        // 新增键：拒绝
        let error = check_write(0, MAX_KEYS, 0, 10, true).expect("必须拒绝");
        assert_eq!(error.kind, QuotaKind::KeyCount);
    }

    /// 总量判的是**增量**，不是新值本身。
    ///
    /// 这一条是这一档里唯一容易写错的地方：用 `new_value_bytes > MAX_TOTAL_BYTES`
    /// 会把"把一个 5 MB 的键覆盖成 1 MB"这种**缩小**写入误拦下来，
    /// 于是插件连自救都做不到。
    #[test]
    fn shrinking_a_value_is_allowed_even_when_total_is_near_the_limit() {
        // 总量 7 MB（上限 8 MB），把一个 4 MB 的键改成 1 MB
        let current = 7 * 1024 * 1024;
        let existing = 4 * 1024 * 1024;
        let new_value = 1024 * 1024;
        assert_eq!(
            check_write(current, 10, existing, new_value, false),
            None,
            "缩小写入必须被放行，否则插件无法自救"
        );
    }

    #[test]
    fn growing_past_the_total_limit_is_rejected() {
        // 注意**每个值都远小于单值上限**（900 KB < 1 MB），因此命中的只可能是总量档。
        // 若这里写一个 2 MB 的值，先触发的会是单值档 —— 两者可以同时越界，
        // 而单值档优先（见 `check_write` 里的说明）。
        //
        // 用量取 7.5 MB 而不是 7 MB：7 MB + 900 KB = 7.88 MB 其实**没超** 8 MB，
        // 那样这条测试会因为数据算错而变成一条永远失败的断言。
        let current = (7 * 1024 + 512) * 1024; // 7.5 MB
        let error = check_write(current, 10, 0, 900 * 1024, true).expect("必须拒绝");

        assert_eq!(error.kind, QuotaKind::TotalBytes);
        assert_eq!(error.limit, MAX_TOTAL_BYTES);
        assert_eq!(error.current, current);
    }

    /// 恰好在上限时，再写一个字节就被拒；恰好等于上限则放行。
    ///
    /// 边界的方向必须与"上限"这个说法一致：若写成 `>=`，文档里的
    /// "上限 8 MB"就变成了"实际上限 8 MB - 1 字节"，而那种偏差没人会去核对。
    #[test]
    fn the_total_limit_boundary_is_inclusive() {
        // 恰好等于上限：放行
        assert_eq!(check_write(MAX_TOTAL_BYTES, 10, 0, 0, true), None);

        // 差 1 字节到上限，再写 1 字节 -> 恰好等于上限：放行
        assert_eq!(check_write(MAX_TOTAL_BYTES - 1, 10, 0, 1, true), None);

        // 已经在写满的状态下再写 1 字节 -> 超出：拒绝
        let error = check_write(MAX_TOTAL_BYTES, 10, 0, 1, true).expect("必须拒绝");
        assert_eq!(error.kind, QuotaKind::TotalBytes);
    }

    /// 单值档优先于总量档。
    ///
    /// 两者可能同时越界。优先级必须显式：若总量档先判，错误消息会指向"清理数据"，
    /// 而真正的问题是"这一个值太大了"——两条修复路径完全不同，
    /// 报错指向错的那一条会让作者白忙一场。
    #[test]
    fn value_size_takes_priority_over_total_size() {
        // 总量已经超、且本次写入的值也超单值上限
        let error = check_write(MAX_TOTAL_BYTES + 1, 10, 0, MAX_VALUE_BYTES + 1, true)
            .expect("必须拒绝");
        assert_eq!(
            error.kind,
            QuotaKind::ValueBytes,
            "两条都越界时应当先报单值档（更具体、更可行动）"
        );
    }

    /// 溢出不能绕过判定。
    ///
    /// 用量与增量都来自外部（文件系统统计 + 插件提交的内容），
    /// 用 `saturating_*` 是为了让"极大值"这一侧倒在**拒绝**上，
    /// 而不是回绕成一个小数字后放行。
    #[test]
    fn saturates_to_rejection_instead_of_wrapping() {
        let error = check_write(u64::MAX, 10, 0, 1024, true);
        assert!(error.is_some(), "极大用量必须落在拒绝一侧，不能回绕成放行");

        let error = check_write(0, 10, 0, u64::MAX, true).expect("必须拒绝");
        // u64::MAX 同时触发单值上限，那一档优先级更高
        assert_eq!(error.kind, QuotaKind::ValueBytes);
    }

    /// 错误消息必须把四个数字都写出来。
    ///
    /// 只有"超出配额"四个字，插件作者无从下手；这条测试防的是
    /// "消息被简化成一句话"的那种改动。
    #[test]
    fn the_message_carries_every_number() {
        let error = check_write(0, 0, 0, MAX_VALUE_BYTES + 1, true).unwrap();
        let message = error.message();

        assert!(message.contains("1.0 MB"), "要给出上限：{message}");
        assert!(message.contains("0 B"), "要给出当前用量：{message}");
        assert!(message.contains("本次要增加"), "要给出本次增量：{message}");
        assert!(message.contains("单个值"), "要说明是哪一档：{message}");
    }

    /// 计数类的档位不能用字节单位显示。
    #[test]
    fn key_count_is_reported_as_a_count_not_bytes() {
        let error = check_write(0, MAX_KEYS, 0, 1, true).unwrap();
        let message = error.message();
        assert!(message.contains("2000 个"), "键数要按个数显示：{message}");
        assert!(!message.contains("KB"), "键数不该出现字节单位：{message}");
    }

    // ============================================================
    // 页大小
    // ============================================================

    #[test]
    fn page_size_is_clamped_and_defaulted() {
        assert_eq!(clamp_page_size(None), DEFAULT_PAGE_SIZE);
        assert_eq!(clamp_page_size(Some(0)), DEFAULT_PAGE_SIZE);
        assert_eq!(clamp_page_size(Some(10)), 10);
        assert_eq!(clamp_page_size(Some(MAX_PAGE_SIZE)), MAX_PAGE_SIZE);
        // 关键：调用方请求一个极大的页也必须被夹住 ——
        // 能被一个参数绕过的分页等于没有分页。
        assert_eq!(clamp_page_size(Some(100_000)), MAX_PAGE_SIZE);
    }

    // ============================================================
    // 游标
    // ============================================================

    #[test]
    fn cursor_round_trips() {
        let encoded = encode_cursor("record.2026", "record.", 50);
        let (after, prefix, size) = decode_cursor(&encoded).expect("应当能解出");
        assert_eq!(after, "record.2026");
        assert_eq!(prefix, "record.");
        assert_eq!(size, 50);
    }

    /// 游标是 URL 安全的、并且不含填充符 ——
    /// 它会被放进 IPC 参数与日志里，标准 base64 的 `+` `/` `=` 在那些地方要转义。
    #[test]
    fn cursor_is_url_safe() {
        // 用一段会产生 `+` `/` 的输入多试几次，确保编码表选对了
        for value in ["a?b/c+d", "键", "x".repeat(60).as_str()] {
            let encoded = encode_cursor(value, "", 10);
            assert!(
                !encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='),
                "游标里出现了需要转义的字符：{encoded}"
            );
        }
    }

    #[test]
    fn garbage_cursor_resolves_to_start() {
        // 非法游标不报错，从头开始 —— 最坏是重复第一页，而报错会让列表操作彻底失败。
        assert_eq!(resolve_cursor(Some("not-a-cursor"), "").unwrap(), None);
        assert_eq!(resolve_cursor(Some(""), "").unwrap(), None);
        assert_eq!(resolve_cursor(None, "").unwrap(), None);
    }

    /// 游标与过滤条件不一致必须**报错**，而不是静默给一份缺数据的结果。
    #[test]
    fn cursor_with_a_different_prefix_is_rejected() {
        let encoded = encode_cursor("record.5", "record.", 20);
        let error = resolve_cursor(Some(&encoded), "custom.").expect_err("必须拒绝");
        let message = error.to_string();
        assert!(message.contains("record."), "要指出游标的前缀：{message}");
        assert!(message.contains("custom."), "要指出本次的前缀：{message}");
    }

    #[test]
    fn cursor_with_the_same_prefix_resolves_to_the_key_after() {
        let encoded = encode_cursor("record.5", "record.", 20);
        assert_eq!(
            resolve_cursor(Some(&encoded), "record.").unwrap(),
            Some("record.5".to_string())
        );
    }

    // ============================================================
    // 用量统计
    // ============================================================

    #[test]
    fn usage_counts_only_files() {
        let entries = [
            StorageEntry { is_file: true, is_json: true, len: 100 },
            StorageEntry { is_file: true, is_json: true, len: 200 },
            // 子目录不算存储：它是插件自建的目录，不是"一个键"
            StorageEntry { is_file: false, is_json: true, len: 4096 },
            // 非 .json 文件不算：列举里也看不到它，两处判据必须一致
            StorageEntry { is_file: true, is_json: false, len: 8192 },
        ];
        assert_eq!(sum_storage(&entries), (300, 2));
    }

    #[test]
    fn empty_storage_reports_zero() {
        assert_eq!(sum_storage(&[]), (0, 0));
    }

    /// 用量统计要饱和而不是回绕。
    ///
    /// 回绕成一个小数字会**放行**一次本该被拒的写入 —— 那是这一档配额唯一
    /// 真正危险的失效方式。饱和则只会误拦，而误拦是安全的（用户删点东西即可）。
    #[test]
    fn usage_saturates_instead_of_wrapping() {
        let entries = [
            StorageEntry { is_file: true, is_json: true, len: u64::MAX },
            StorageEntry { is_file: true, is_json: true, len: u64::MAX },
        ];
        let (total, count) = sum_storage(&entries);
        assert_eq!(total, u64::MAX);
        assert_eq!(count, 2);

        // 饱和之后仍然超上限 -> 仍然被拒
        assert!(check_write(total, count, 0, 1, true).is_some());
    }

    // ============================================================
    // 分页切分
    // ============================================================

    fn keys(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn first_page_has_no_cursor_when_it_covers_everything() {
        let all = keys(&["a", "b"]);
        let page = slice_page(&all, "", None, 10);
        assert_eq!(page.keys, all);
        assert_eq!(page.next_cursor, None, "只有一页时不该给游标");
    }

    #[test]
    fn walking_pages_covers_every_key_exactly_once() {
        let all = keys(&["a", "b", "c", "d", "e", "f", "g"]);
        let mut seen: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut rounds = 0;

        loop {
            rounds += 1;
            assert!(rounds < 20, "翻页没有终止 —— 游标可能没有前进");

            let after = cursor
                .as_deref()
                .and_then(decode_cursor)
                .map(|(after, _, _)| after);

            let page = slice_page(&all, "", after.as_deref(), 3);
            seen.extend(page.keys.clone());
            cursor = page.next_cursor;

            if cursor.is_none() {
                break;
            }
        }

        assert_eq!(seen, all, "翻完所有页应当恰好覆盖每个键一次且顺序不变");
    }

    /// 游标指向的键**已经被删除**时，翻页不能退化成"回到第一页"。
    ///
    /// 这是这一档里最容易写错的地方：把"跳过等于 after 的那一项"当成实现，
    /// 在那一项不存在时就会从下标 0 重新开始，而用户看到的是
    /// "点下一页却回到了第一页"——并且永远不会结束。
    #[test]
    fn paging_survives_the_cursor_key_being_deleted() {
        let all = keys(&["a", "b", "d", "e"]);
        // 游标指向 "c"，而 "c" 已经被删掉了
        let page = slice_page(&all, "", Some("c"), 10);

        assert_eq!(page.keys, keys(&["d", "e"]), "应当从「本该在 c 之后」的位置继续");
        assert_ne!(page.keys, all, "绝不能从头发起");
    }

    /// 游标指向的键还在时，从**它之后**继续（而不是把它再返一次）。
    ///
    /// 把 after 自己也算进去会让每一页多出一条重复记录，而重复在"累积历史"
    /// 这类用法里会变成静默的数据错误。
    #[test]
    fn paging_excludes_the_cursor_key_itself() {
        let all = keys(&["a", "b", "c", "d"]);
        let page = slice_page(&all, "", Some("b"), 10);
        assert_eq!(page.keys, keys(&["c", "d"]));
    }

    #[test]
    fn last_page_reports_no_cursor() {
        let all = keys(&["a", "b", "c"]);
        let page = slice_page(&all, "", Some("b"), 10);
        assert_eq!(page.keys, keys(&["c"]));
        assert_eq!(page.next_cursor, None);
    }

    /// 恰好整除时，最后一页也不能给出"下一页是空的"那种游标。
    #[test]
    fn exact_multiple_does_not_emit_a_trailing_empty_cursor() {
        let all = keys(&["a", "b", "c", "d"]);
        let page = slice_page(&all, "", None, 4);
        assert_eq!(page.keys, all);
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn cursor_past_the_end_is_empty_not_an_error() {
        let all = keys(&["a", "b"]);
        let page = slice_page(&all, "", Some("z"), 10);
        assert!(page.keys.is_empty());
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn empty_storage_yields_an_empty_first_page() {
        let page = slice_page(&[], "", None, 10);
        assert!(page.keys.is_empty());
        assert_eq!(page.next_cursor, None);
    }

    /// 页大小 0 **不能**让翻页停滞。
    ///
    /// 这条断言守的是一个会表现为"界面卡死"的写法：若 0 条一页且仍然给出游标，
    /// 调用方会拿到空页、拿到游标、再请求同一位置，永远前进不了。
    /// 因此切页函数自己把 0 夹成 1 —— 上层的 `clamp_page_size` 已经处理了 0，
    /// 但一个不会卡住的兜底比一条"必须记得夹取"的约定可靠。
    #[test]
    fn zero_page_size_still_makes_progress() {
        let all = keys(&["a", "b", "c"]);
        let page = slice_page(&all, "", None, 0);
        assert_eq!(page.keys, keys(&["a"]), "0 条一页被夹成 1 条，必须能前进");

        let next = page.next_cursor.as_deref().and_then(decode_cursor).map(|(a, _, _)| a);
        assert_eq!(next.as_deref(), Some("a"), "游标必须前移");
    }

    // ============================================================
    // 真实目录上的端到端验证
    // ============================================================
    //
    // 上面全部是纯函数测试。它们能证明规则本身是对的，但证明不了**规则真的接在
    // 写盘路径上** —— 而"规则写好了却没人调用"正是这个项目里最反复出现的一类缺陷。
    //
    // 下面这一段用真实的临时目录跑同一个流程：**先按规则判定，再落盘**，
    // 与 `PluginManager::storage_set` 的顺序一致。
    // 它不复制那三行代码的全部细节（那需要 AppHandle），但它验证的是同一件事：
    // 被拒绝的写入**没有产生文件**，而放行的写入**真的在那里**。

    use std::path::Path;

    /// 复刻 `storage_set` 的落盘顺序：先算用量、再判定、最后写。
    /// 返回 `Err` 表示被配额拒绝。
    fn write_like_the_manager(dir: &Path, key: &str, value_bytes: usize) -> Result<(), QuotaError> {
        let path = dir.join(format!("{key}.json"));
        let existing = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);

        // 统计用量（与 `PluginManager::storage_usage` 同一套判据）
        let entries: Vec<StorageEntry> = std::fs::read_dir(dir)
            .map(|iter| {
                iter.filter_map(|entry| entry.ok())
                    .filter_map(|entry| {
                        let meta = entry.metadata().ok()?;
                        Some(StorageEntry {
                            is_file: meta.is_file(),
                            is_json: entry.path().extension().is_some_and(|ext| ext == "json"),
                            len: meta.len(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let (total, count) = sum_storage(&entries);

        if let Some(error) =
            check_write(total, count, existing, value_bytes as u64, existing == 0)
        {
            return Err(error);
        }

        std::fs::write(&path, vec![b'x'; value_bytes]).expect("测试写入不应失败");
        Ok(())
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("modulith-quota-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建临时目录不应失败");
        dir
    }

    /// 被拒的写入**不得**在磁盘上留下任何东西。
    ///
    /// 这是配额唯一真正重要的性质：如果判定发生在写盘之后，那个大文件已经在那里了，
    /// 报错只是一句安慰的话，而内存与磁盘都已经付出代价。
    #[test]
    fn a_rejected_write_leaves_nothing_behind() {
        let dir = temp_dir("reject");

        let error = write_like_the_manager(&dir, "huge", (MAX_VALUE_BYTES + 1) as usize)
            .expect_err("超限写入必须被拒");
        assert_eq!(error.kind, QuotaKind::ValueBytes);

        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert!(left.is_empty(), "被拒的写入不能留下文件：{left:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 放行的写入真的落盘，且用量统计能看见它。
    #[test]
    fn an_allowed_write_is_visible_to_usage_and_listing() {
        let dir = temp_dir("allow");

        write_like_the_manager(&dir, "a", 100).expect("应当放行");
        write_like_the_manager(&dir, "b", 200).expect("应当放行");

        let entries: Vec<StorageEntry> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some(StorageEntry {
                    is_file: meta.is_file(),
                    is_json: e.path().extension().is_some_and(|ext| ext == "json"),
                    len: meta.len(),
                })
            })
            .collect();

        let (total, count) = sum_storage(&entries);
        assert_eq!(count, 2);
        assert_eq!(total, 300);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 覆盖写一个已有的大值**不会**因为"新的用量超过单值上限"而卡住 ——
    /// 判的是这一档的上限，而不是历史。
    #[test]
    fn overwriting_an_existing_key_is_judged_by_the_delta() {
        let dir = temp_dir("overwrite");

        // 先写一个接近单值上限的值
        write_like_the_manager(&dir, "k", MAX_VALUE_BYTES as usize).expect("应当放行");
        // 再把它改小：总量应当下降
        write_like_the_manager(&dir, "k", 10).expect("缩小写入必须放行");

        let len = std::fs::metadata(dir.join("k.json")).unwrap().len();
        assert_eq!(len, 10, "覆盖写应当把文件改小");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 一大组键能被游标翻完，且不重不漏 —— 用真实目录验证组合后的行为。
    #[test]
    fn paging_over_a_real_directory_covers_everything_once() {
        let dir = temp_dir("paging");

        let expected: Vec<String> = (0..37).map(|index| format!("record.{index:03}")).collect();
        for key in &expected {
            write_like_the_manager(&dir, key, 16).expect("应当放行");
        }

        // 枚举 + 排序（与 `storage_list_paged` 的中间步骤一致）
        let mut listed: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
            .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .collect();
        listed.sort();
        assert_eq!(listed, expected, "列举结果应当与写入的键一致");

        // 按 5 条一页翻完
        let mut seen: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut rounds = 0;
        loop {
            rounds += 1;
            assert!(rounds < 50, "翻页没有终止");

            let after = cursor
                .as_deref()
                .and_then(decode_cursor)
                .map(|(after, _, _)| after);
            let page = slice_page(&listed, "", after.as_deref(), 5);

            // 每页内部也必须是升序的（调用方可能直接展示）
            let mut sorted = page.keys.clone();
            sorted.sort();
            assert_eq!(page.keys, sorted, "页内顺序应当保持升序");

            seen.extend(page.keys.clone());
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }

        assert_eq!(seen, expected, "翻完所有页应当恰好覆盖每个键一次");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
