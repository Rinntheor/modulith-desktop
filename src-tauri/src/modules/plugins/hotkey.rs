// src-tauri/src/modules/plugins/hotkey.rs
//
// 全局热键（`ctx.hotkey`）：让插件在**任何**程序里按下某个组合键时被唤醒。
//
// 一个翻译插件要靠它才能成立：用户选中一段外文、按 `Ctrl+Q`，插件弹出译文 ——
// 而那个按键发生时，焦点在**别的程序**里，宿主窗口一个键盘事件都收不到。
//
// ============================================================
// 这一项最要紧的性质：**注册了就必须释放**
// ============================================================
//
// `RegisterHotKey` 是**系统级**的：一次成功的注册会把这个组合键从**这台机器上
// 所有其它程序**手里拿走，而且只有注册它的那个进程能还回来。宿主崩了、线程死了、
// 插件被停用了而不解绑 —— 用户按那个键时任何程序都没反应，他唯一能做的事是
// 关掉本应用。这比"某个功能不好用"严重得多，因为它损害的是用户的整台机器。
//
// 因此本模块的每一条释放路径都不是顺手加的，它们分布在四个不同的层：
//
//   1. 插件自己 `unregister()` / 退订（`rpc.rs` / `commands.rs`）；
//   2. **插件被停用或卸载** —— `sandbox::close_all_surfaces` 里 `forget_plugin`
//      （停用不一定经过插件的任何代码，这是最容易漏的一条）；
//   3. **应用退出** —— `lib.rs` 的 `RunEvent::Exit` 里 `stop()`；
//   4. 进程结束由内核回收（最后兜底，不依赖它）。
//
// 第 2 条尤其重要：`close_surface` 那一层**刻意不撤热键** —— 热键是**插件级**的
// 资源（后台插件根本没有界面，它却正是最需要全局热键的那一种），按界面撤会让
// 一个后台插件在界面重挂载时无声地失去热键。差异写在 `sandbox.rs` 的调用点。
//
// ============================================================
// 为什么是"自己的消息窗口 + 自己的线程"，而不是给已有窗口装钩子
// ============================================================
//
// `WM_HOTKEY` 必须投给**一个窗口**。可选的窗口有三种，只有一种是对的：
//
//   * **Tauri 主窗口**：它是 winit 建的，wndproc 是 winit 的。要在那里处理热键就得
//     子类化它（`SetWindowSubclass`），而那是**往别人的消息处理里插一段代码** ——
//     winit 在升级中改动 `WM_*` 的假设时不会有任何编译错误，症状是窗口行为异常，
//     排查方向会指向 Tauri 而不是热键。
//   * **挂 `WH_KEYBOARD_LL` 低级键盘钩子**：它确实不需要窗口，但它是一个**全局
//     输入钩子** —— 每一次按键都要经过本进程一次，包括在别的程序里打的密码。
//     这与"只在用户按下某个组合时才做点事"相比，代价与风险都不成比例。
//   * **本模块自己的消息窗口**（`HWND_MESSAGE`）**在它自己的线程上**：
//     它没有界面、不进任务栏、不参与 z-order，唯一的作用是收 `WM_HOTKEY`。
//     宿主永远不碰 Tauri 的事件循环，`RegisterHotKey` 的成败也完全在本模块内可判。
//
// 取第三条。线程只在第一次真正需要时拉起，应用退出时停掉；它**没有任何轮询**，
// 空闲时就是一个阻塞在 `GetMessageW` 上的线程（零 CPU），因此没有"没有订阅者就
// 必须停线程"那条与剪贴板监测相同的约束。
//
// ============================================================
// 组合键语法：**不是**这里发明的
// ============================================================
//
// 组合键的唯一语法在 `src/services/shortcutRegistry.ts` 的 `parseCombo` /
// `normalizeCombo`（`mod+k` / `mod+shift+tab`，修饰符 `mod`|`ctrl`|`cmd`|`meta`、
// `shift`、`alt`|`option`，规范化顺序恒为 `mod+shift+alt+key`）。
//
// Rust 这一侧此前**没有**解析器 —— `shortcuts.rs` 只有 `is_host_combo()`，它比的
// 是已经规范化过的字符串。而 `ctx.hotkey.register(combo)` 需要在这里判定合法性
// （`RegisterHotKey` 拿到的是一个整数，它不知道 `mod+k` 是什么意思），因此这里
// **必须**有一份实现。它是这份语法的第二个实现，这一点必须说清楚，而不是假装
// 只有一份：
//
//   * `GRAMMAR_CASES` 是两侧共用的语料，**逐条**写在下面；
//   * `scripts/check-plugin-runtime.ts` 用真正的 `normalizeCombo()` 跑一遍这份
//     语料，再与 Rust 侧这份表逐条比对 —— 任一侧改了规则而另一侧没跟上，
//     门禁直接点名。这是"两份实现不漂"唯一能自动化的形式。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

use super::types::PluginPermission;

// ============================================================
// 上限与文案（文档要引用它们，因此都写在这里）
// ============================================================

/// 一个插件最多能同时占用多少个组合键。
///
/// 4 是"够用且失控不了"的那一档：翻译插件常见的是"翻译"+"朗读"+"替换原文"三条。
/// 上限存在的理由不是防恶意（恶意插件本来就拿得到别的能力），而是**用户能看懂**：
/// 一个插件占掉十几个组合键时，用户在系统里按什么都不灵，而没有任何一处能看到
/// 是谁拿走的。
pub const MAX_COMBOS_PER_PLUGIN: usize = 4;

/// 非 Windows 平台上所有热键接口的统一说法。
///
/// 与 `clipboard.rs::UNSUPPORTED_PLATFORM` 同一个理由：它要在三个地方出现
/// （RPC、命令层、前端降级文案），三处各写一句就会有三份措辞不同的"不支持"。
pub const UNSUPPORTED_PLATFORM: &str =
    "全局热键只在 Windows 上可用：它依赖 Win32 的 RegisterHotKey / UnregisterHotKey，\
     这里没有对应实现";

/// 推送通道名（沙箱一条）。与 `sandbox-bridge.js` 的 `PUSH_HANDLERS` 逐字相同。
pub const PUSH_CHANNEL: &str = "hotkey";

/// 窗口线程等一次 `RegisterHotKey` 结果的上限。
///
/// **必须有上限。** 窗口线程若因为任何原因消失（创建窗口失败、消息循环退出），
/// 没有超时的 `recv()` 会让调用它的那个 RPC 永远挂着 —— 而插件看到的是"注册
/// 一直没返回"，没有任何线索。2 秒远大于一次 `RegisterHotKey` 的耗时（微秒级），
/// 唯一会用到它的场合就是"对面已经不在了"。
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

/// 让窗口线程醒过来处理命令。
///
/// 线程阻塞在 `GetMessageW` 上（那是零 CPU 的空闲），因此**必须**有一条消息把它
/// 叫醒 —— 只往通道里塞东西它是看不见的。这就是这条消息存在的理由。
const WM_DRAIN: u32 = 0x8000 + 1; // WM_APP + 1

/// 组合键被**别人**占用时的统一说法。
///
/// "别人"分三种，而用户需要知道是哪一种，因为**能做的事完全不同**：
/// 被宿主占用 → 换个组合即可；被另一个插件占用 → 去停用那个插件；被系统或别的
/// 软件占用 → 与本应用无关，他改不了。
fn taken_message(normalized: &str, holder: &str) -> String {
    format!("组合键 {normalized} 已被{holder}占用，请换一个组合键再试")
}

// ============================================================
// 组合键语法（与 shortcutRegistry.ts 逐条对应）
// ============================================================

/// 两侧共用的组合键语料：`(输入, 规范化结果)`。
///
/// ============================================================
/// 为什么它是一份**公开的数据**而不是测试里的局部数组
/// ============================================================
///
/// 因为它是跨语言的一致性判据：`scripts/check-plugin-runtime.ts` 会把这份表读出来，
/// 用**前端真正的** `normalizeCombo()` 逐个跑一遍，任何一条对不上就让门禁红。
/// 藏在 `#[cfg(test)]` 里的话，它就只能证明"Rust 自己前后一致"，而那正是漂移
/// 发生时仍然成立的那件事。
///
/// `None` 表示这个组合**不合法**（`parseCombo` 返回 null）。这些反例比正例重要：
/// `mod+a+b` 与 `mod` 都是很容易被"顺手放行"的形状，而一旦放行，`RegisterHotKey`
/// 会拿到一个我们猜出来的键 —— 也就是**绑错了一个键**，而用户看到的只是"我按的
/// 组合没反应，倒是另一个键会弹窗"。
pub const GRAMMAR_CASES: &[(&str, Option<&str>)] = &[
    // ---- 正例 ----
    ("mod+k", Some("mod+k")),
    ("Ctrl+K", Some("mod+k")),
    ("cmd+k", Some("mod+k")),
    ("meta+k", Some("mod+k")),
    ("MOD+K", Some("mod+k")),
    ("mod+shift+tab", Some("mod+shift+tab")),
    ("shift+mod+tab", Some("mod+shift+tab")),
    ("mod+alt+shift+f5", Some("mod+shift+alt+f5")),
    ("option+x", Some("alt+x")),
    ("mod+1", Some("mod+1")),
    (" mod + k ", Some("mod+k")),
    ("escape", Some("escape")),
    ("f9", Some("f9")),
    // ---- 反例 ----
    ("", None),
    ("+", None),
    ("mod", None),
    ("mod+", None),
    ("shift+alt", None),
    ("mod+a+b", None),
    ("mod+shift+alt", None),
];

/// 解析后的组合键。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCombo {
    /// `mod` / `ctrl` / `cmd` / `meta` 中的任意一个。Windows 上它就是 Ctrl。
    pub mod_key: bool,
    pub shift: bool,
    pub alt: bool,
    /// 主键，**小写**。
    pub key: String,
}

/// 把组合键字符串解析成可比较的结构。不合法时返回 `None`。
///
/// 规则逐条对应 `shortcutRegistry.ts::parseCombo`：
///   * 全部小写、按 `+` 切分、逐段 trim、丢掉空段；
///   * 认得的修饰符有 `mod`/`ctrl`/`cmd`/`meta`、`shift`、`alt`/`option`；
///   * 其余段当成主键，**出现第二个主键即判非法**（`mod+a+b` 无法判定意图）；
///   * 只有修饰符、没有主键也判非法。
pub fn parse_combo(combo: &str) -> Option<ParsedCombo> {
    if combo.is_empty() {
        return None;
    }

    let mut parsed = ParsedCombo {
        mod_key: false,
        shift: false,
        alt: false,
        key: String::new(),
    };

    let mut any = false;
    for part in combo
        .to_lowercase()
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        any = true;
        match part {
            "mod" | "ctrl" | "cmd" | "meta" => parsed.mod_key = true,
            "shift" => parsed.shift = true,
            "alt" | "option" => parsed.alt = true,
            _ => {
                if !parsed.key.is_empty() {
                    return None;
                }
                parsed.key = part.to_string();
            }
        }
    }

    if !any || parsed.key.is_empty() {
        return None;
    }
    Some(parsed)
}

/// 规范化为 `[mod+][shift+][alt+]<key>` 的稳定形式。不合法时返回 `None`。
///
/// 顺序是固定的，因此 `shift+mod+tab` 与 `mod+shift+tab` 得到同一个字符串 ——
/// 这也是"冲突"这件事能有唯一表示的原因（否则同一个组合会被当成两条）。
pub fn normalize_combo(combo: &str) -> Option<String> {
    let parsed = parse_combo(combo)?;

    let mut parts: Vec<&str> = Vec::new();
    if parsed.mod_key {
        parts.push("mod");
    }
    if parsed.shift {
        parts.push("shift");
    }
    if parsed.alt {
        parts.push("alt");
    }

    let prefix = parts.join("+");
    Some(if prefix.is_empty() {
        parsed.key
    } else {
        format!("{prefix}+{}", parsed.key)
    })
}

// ============================================================
// 组合键 → Win32 的修饰符与虚拟键
// ============================================================
//
// **这几个整数自己写。** 与 `clipboard.rs` 里那组 `CF_*` 的理由不完全相同：那里的
// 常量在没打开的模块里，而这里 `Win32_UI_Input_KeyboardAndMouse` 已经打开了。
// 区别在于**这个函数必须是纯的、跨平台可编译的**（它是这一节逻辑的主体，而单测
// 要能在任何平台上跑），因此它不能引用只存在于 Windows 目标的常量。
//
// 同步由 `accel_constants_match_windows_sys` 那条测试保证：在 Windows 上逐个与
// windows-sys 的常量比对。抄错一个数字不会有任何编译错误，症状只是"某个组合绑到了
// 另一个键上"。

/// `MOD_ALT`
pub const MOD_ALT: u32 = 0x0001;
/// `MOD_CONTROL`
pub const MOD_CONTROL: u32 = 0x0002;
/// `MOD_SHIFT`
pub const MOD_SHIFT: u32 = 0x0004;
/// `MOD_WIN`
pub const MOD_WIN: u32 = 0x0008;
/// `MOD_NOREPEAT`
///
/// 没有它，用户按住组合键不放会让 `WM_HOTKEY` **连续**投递 —— 一个打开结果卡片的
/// 插件会因此在一秒里弹十几张卡片，而它自己没有做防抖的义务（"一次按下=一次触发"
/// 是宿主该给的性质）。
pub const MOD_NOREPEAT: u32 = 0x4000;

/// `RegisterHotKey` 的 `ERROR_HOTKEY_ALREADY_REGISTERED`。
///
/// 单独写出来而不是直接用 `GetLastError()` 的数字，是为了让"1409 要变成一句人话"
/// 这件事在代码里有一个名字 —— 否则它只是一行 `if error == 1409`，下一个人很容易
/// 把它当成"某个内部错误码"顺手存进日志。
pub const ERROR_HOTKEY_ALREADY_REGISTERED: u32 = 1409;

/// 一个组合键在 Win32 里的样子。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Accelerator {
    /// `MOD_*` 的按位或，已带上 `MOD_NOREPEAT`。
    pub modifiers: u32,
    /// 虚拟键码（`VK_*`）。
    pub virtual_key: u32,
}

/// 主键名 → 虚拟键码。只认**有名字的那一批**。
///
/// 刻意不猜：一个认不出的键名若被当成"某个默认键"，症状是"我按的组合没反应，
/// 倒是另一个键在弹窗" —— 那比一句"不认识这个键"难查得多。
fn named_virtual_key(key: &str) -> Option<u32> {
    Some(match key {
        "backspace" => 0x08,
        "tab" => 0x09,
        "enter" | "return" => 0x0D,
        "escape" | "esc" => 0x1B,
        "space" => 0x20,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "end" => 0x23,
        "home" => 0x24,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "insert" => 0x2D,
        "delete" | "del" => 0x2E,
        _ => return function_key(key),
    })
}

/// `F1`..`F24` → 虚拟键码。它们在 Win32 里就是 `VK_F1 + (n-1)`。
fn function_key(key: &str) -> Option<u32> {
    let digits = key.strip_prefix('f')?;
    // `strip_prefix` 之后必须全都是数字：`f` 与 `f24x` 不是功能键。
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let number: u32 = digits.parse().ok()?;
    if !(1..=24).contains(&number) {
        return None;
    }
    Some(0x70 + (number - 1))
}

/// 主键 → 虚拟键码。字母与数字用它们自己的 ASCII 值（`VK_A` 就是 0x41）。
fn virtual_key_of(key: &str) -> Result<u32, String> {
    if key.len() == 1 {
        let byte = key.as_bytes()[0];
        if byte.is_ascii_lowercase() {
            return Ok(byte.to_ascii_uppercase() as u32);
        }
        if byte.is_ascii_digit() {
            return Ok(byte as u32);
        }
    }

    named_virtual_key(key).ok_or_else(|| {
        format!(
            "组合键里的主键 `{key}` 没有对应的虚拟键码。本 API 支持：单个字母或数字、\
             F1..F24、以及 backspace / tab / enter / escape / space / pageup / pagedown / \
             end / home / left / up / right / down / insert / delete"
        )
    })
}

/// 一个主键是不是**可以单独占用**的。
///
/// ============================================================
/// 为什么这条规则必须存在
/// ============================================================
///
/// `RegisterHotKey` 允许 `modifiers == 0`，也就是说一个插件可以合法地注册 `a`。
/// 那会把**这个字母从整台机器上拿走** —— 用户在任何一个程序里都打不出 `a`，
/// 而屏幕上没有任何东西告诉他为什么。这与"某个快捷键不灵"不是同一个量级的问题。
///
/// 因此只放行两类：**功能键**（F1..F24）与**带至少一个修饰键**的任何键。
/// 这条规则是宿主在契约的语法之上单方面加的 —— 它只会让会毁掉用户键盘的组合被拒，
/// 不会让任何本就合理的组合变得不可用。
fn key_may_be_bare(key: &str) -> bool {
    function_key(key).is_some()
}

/// 规范化之后的组合键 → Win32 的 `(modifiers, virtual_key)`。
///
/// 只接受**已经规范化**的输入（`normalize_combo` 的产物）：这里是"翻译"而不是
/// "解析"，两种写法都收会让 `mod+k` 与 `Mod+K` 走到两条不同的路径上。
pub fn accelerator(normalized: &str) -> Result<Accelerator, String> {
    let parsed = parse_combo(normalized).ok_or_else(|| {
        format!(
            "组合键 `{normalized}` 不能解析：修饰符只认 mod/ctrl/cmd/meta、shift、\
             alt/option，且必须恰好有一个主键"
        )
    })?;

    let mut modifiers = 0u32;
    if parsed.mod_key {
        modifiers |= MOD_CONTROL;
    }
    if parsed.shift {
        modifiers |= MOD_SHIFT;
    }
    if parsed.alt {
        modifiers |= MOD_ALT;
    }

    let virtual_key = virtual_key_of(&parsed.key)?;

    if modifiers == 0 && !key_may_be_bare(&parsed.key) {
        return Err(format!(
            "组合键 `{normalized}` 只有一个普通键，不能注册为全局热键：那会把这个键从\
             `整台机器`上所有程序里拿走（用户在任何一个程序里都打不出它）。请加上 \
             mod / shift / alt 中的至少一个修饰键，或者改用 F1..F24"
        ));
    }

    Ok(Accelerator {
        // `MOD_NOREPEAT` 与调用方给的修饰符一起或进去：它是**宿主**对"一次按下
        // 只该触发一次"的保证，不该由插件选择要不要。
        modifiers: modifiers | MOD_NOREPEAT,
        virtual_key,
    })
}

// ============================================================
// 冲突判定
// ============================================================

/// 一个组合键当前被谁持有。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holder {
    /// 宿主自己的快捷键表里的条目（`PluginShortcuts`）。
    Host,
    /// 另一个插件。
    Plugin(String),
    /// 操作系统或别的软件 —— `RegisterHotKey` 返回 1409 才知道。
    System,
}

impl Holder {
    fn describe(&self) -> String {
        match self {
            Holder::Host => "宿主快捷键（宿主界面里的 Ctrl+K、Ctrl+W 一类）".to_string(),
            Holder::Plugin(id) => format!("插件 {id}"),
            Holder::System => {
                "这台机器上的其它程序或操作系统（RegisterHotKey 返回 1409）".to_string()
            }
        }
    }
}

/// 把一次注册失败翻译成给插件作者的话。
///
/// **`RegisterHotKey` 的原始错误码一个都不许只以数字形式透出去。** 插件作者看到
/// "1409" 只会去搜这个数字，而他知道答案之后也做不了什么 —— 真正有用的是"谁占着
/// 它"，因为那决定了他该做什么。纯函数，因此"1409 会变成哪句话"能被单测钉住。
pub fn failure_message(normalized: &str, code: u32, holder: Option<Holder>) -> String {
    if code == ERROR_HOTKEY_ALREADY_REGISTERED {
        let who = holder
            .map(|holder| holder.describe())
            .unwrap_or_else(|| Holder::System.describe());
        return format!(
            "{}。这是 RegisterHotKey 的 ERROR_HOTKEY_ALREADY_REGISTERED（1409）—— \
             组合键在系统里是`独占`的，同一个组合在整台机器上只能有一个主人。\
             请换一个组合键，或者提示用户关掉占用它的那个程序",
            taken_message(normalized, &who)
        );
    }

    format!(
        "注册全局热键 {normalized} 失败（RegisterHotKey 返回错误码 {code}）。\
         常见的两种原因是：这个组合被系统保留（例如 Ctrl+Alt+Del 一类由内核处理的键），\
         或者进程已经占满了它自己的热键名额"
    )
}

// ============================================================
// 订阅表
// ============================================================

/// 一个插件想在哪里收到热键触发的通知。
///
/// ============================================================
/// 为什么要分开记三个位置，而不是像剪贴板那样只记一个集合
/// ============================================================
///
/// 剪贴板监测只在**界面**上成立（后台插件没有承载推送的通道），因此那里用
/// `插件 id → 界面名集合` 一张表就够了。热键不一样：它**恰恰是后台插件最需要**
/// 的能力，而三种运行位置的投递方式完全不同（Tauri 事件 / 推 iframe / 派发进
/// Node 子进程）。把"哪几处想收"写成三个具名字段，是为了让"后台插件也能订阅"
/// 这件事在类型上就是平常的，而不是靠一个魔法字面量拼出来。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Subscription {
    /// in-process 插件（宿主这个 realm，走 Tauri 事件）。
    pub in_process: bool,
    /// 后台插件（Node 子进程，走 `plugin.dispatch`）。
    pub background: bool,
    /// 沙箱界面名集合（走 `push_to`）。
    pub surfaces: BTreeSet<String>,
}

impl Subscription {
    fn is_empty(&self) -> bool {
        !self.in_process && !self.background && self.surfaces.is_empty()
    }
}

#[derive(Default)]
struct RegistryState {
    /// 组合键（规范化）→ 持有它的插件 id。**这是"谁占着这个键"的真源。**
    owners: BTreeMap<String, String>,
    /// 插件 id → 它注册的组合键。用于停用/卸载时一次全解绑。
    by_plugin: BTreeMap<String, BTreeSet<String>>,
    /// 插件 id → 它想在哪里收到触发。
    ///
    /// 与 `by_plugin` **分开**：一个插件可以注册组合键却不订阅（那样它只是占着键），
    /// 也可以订阅却没有组合键（永远收不到）。
    subscriptions: BTreeMap<String, Subscription>,
    /// 消息窗口线程。`None` = 还没起来。
    thread: Option<WindowThread>,
}

/// 窗口线程的句柄。
struct WindowThread {
    /// 消息窗口的 `HWND`（存成 `isize`：见平台层 `create_message_window` 的说明）。
    hwnd: isize,
    commands: Sender<Command>,
}

/// 发给窗口线程的一条命令。
enum Command {
    /// 注册一条组合键；窗口线程把结果回执回去。
    Register {
        id: i32,
        combo: String,
        plugin_id: String,
        accelerator: Accelerator,
        reply: Sender<Result<(), u32>>,
    },
    /// 解绑一条组合键。没有回执：解绑失败的唯一后果是"那条键可能还占着"，而那是
    /// 用户重试一次就能自己确认的事。
    Unregister {
        id: i32,
        combo: String,
    },
    /// 退出消息循环。
    Quit,
}

/// 全局热键的宿主状态。由 `lib.rs` 在 `setup` 里托管。
///
/// 与 `ClipboardMonitor` 一样**不是泛型**：它自己不认识 `AppHandle`，窗口线程在
/// 启动时拿到一份克隆。这样 `app.manage(...)` 不需要为每个 `R` 各来一次。
#[derive(Default)]
pub struct HotkeyRegistry {
    state: Mutex<RegistryState>,
}

impl HotkeyRegistry {
    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        // 中毒的锁照样用，理由与 `ClipboardMonitor::lock` 逐字相同：这张表里只有
        // 普通容器与发送端，没有"被写坏一半"的中间态；而 `unwrap()` 会让一次无关的
        // panic 把热键永久变成不可用 —— 那是静默的（插件只是注册不上）。
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 这个平台支不支持全局热键。前端用它做同步特性探测。
    pub fn is_supported() -> bool {
        win::SUPPORTED
    }

    /// 注册一条组合键。成功时返回**规范化之后**的组合键。
    ///
    /// 判定顺序是刻意的，而且每一条都必须在真正调用 `RegisterHotKey` **之前**：
    ///
    ///   1. 语法（不合法的话我们根本不知道要注册什么）；
    ///   2. 数量上限（4 条）；
    ///   3. 这个插件是不是已经注册过它（重复注册是幂等的，不该报冲突）；
    ///   4. **宿主自己的快捷键表** —— 这一条最容易被漏掉，因为宿主的
    ///      `Ctrl+K` / `Ctrl+W` 是 **webview 级**的 keydown 处理，**并没有**调用
    ///      `RegisterHotKey`。也就是说操作系统认为它是空闲的，第 6 步会成功 ——
    ///      而结果是宿主界面里那三个快捷键从此失灵，且没有任何提示。
    ///   5. 别的插件已经注册过的组合；
    ///   6. 最后才是 `RegisterHotKey`，失败即 1409 一类。
    pub fn register<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        plugin_id: &str,
        combo: &str,
    ) -> Result<String, String> {
        if !win::SUPPORTED {
            return Err(UNSUPPORTED_PLATFORM.to_string());
        }

        let normalized = normalize_combo(combo).ok_or_else(|| {
            format!(
                "组合键 `{combo}` 不能解析。语法是 `[mod+][shift+][alt+]<键>`，例如 \
                 `mod+q`、`mod+shift+tab`；修饰符只认 mod / ctrl / cmd / meta、shift、\
                 alt / option，且必须恰好有一个主键"
            )
        })?;
        let accel = accelerator(&normalized)?;

        // 宿主的快捷键表在**锁外**读：那是另一个托管状态，两层锁的嵌套顺序会随着
        // 将来任何一处改动变成死锁的可能。
        if let Some(shortcuts) = app.try_state::<super::shortcuts::PluginShortcuts>() {
            if shortcuts.is_host_combo(&normalized) {
                return Err(format!(
                    "{}。宿主自己的快捷键是 webview 级的键盘处理，它**没有**占用系统的\
                     热键名额 —— 也就是说 RegisterHotKey 会成功，而宿主界面里那个快捷键\
                     从此失灵。它们都在 `shortcuts.rs` 的表里，插件可以用 \
                     `Modulith.shortcuts` 读到整张表",
                    taken_message(&normalized, &Holder::Host.describe())
                ));
            }
        }

        let (id, reply) = {
            let mut state = self.lock();

            if !state
                .by_plugin
                .get(plugin_id)
                .is_some_and(|owned| owned.contains(&normalized))
            {
                let count = state.by_plugin.get(plugin_id).map_or(0, BTreeSet::len);
                if count >= MAX_COMBOS_PER_PLUGIN {
                    return Err(format!(
                        "插件 {plugin_id} 已经注册了 {MAX_COMBOS_PER_PLUGIN} 个全局热键\
                         （上限），无法再注册 {normalized}。先 unregister 掉不再需要的那个"
                    ));
                }
            } else {
                // 重复注册同一条：**当作成功**。抛错会迫使插件自己记账"我注册过没有"，
                // 而那笔账它一定会算错（热重载、界面重挂载都会重跑顶层代码）。
                return Ok(normalized);
            }

            if let Some(other) = state.owners.get(&normalized) {
                return Err(taken_message(
                    &normalized,
                    &Holder::Plugin(other.clone()).describe(),
                ));
            }

            let (commands, hwnd) = self.ensure_thread(&mut state, app)?;
            let id = win::next_id();
            let (reply, wait) = channel::<Result<(), u32>>();

            commands
                .send(Command::Register {
                    id,
                    combo: normalized.clone(),
                    plugin_id: plugin_id.to_string(),
                    accelerator: accel,
                    reply,
                })
                .map_err(|_| "热键窗口线程已经不在了".to_string())?;
            win::wake(hwnd, WM_DRAIN);

            // 记账放在**发送命令之后、等回执之前**：`owners` 表在等待期间对别的
            // 调用方可见，而这一次注册此刻确实已经排上队了 —— 让两个并发的注册
            // 看到同一条空闲组合，才是真正的竞态。
            state
                .owners
                .insert(normalized.clone(), plugin_id.to_string());
            state
                .by_plugin
                .entry(plugin_id.to_string())
                .or_default()
                .insert(normalized.clone());

            (id, wait)
        };

        match reply.recv_timeout(COMMAND_TIMEOUT) {
            Ok(Ok(())) => {
                log::debug!("插件 {plugin_id} 注册了全局热键 {normalized}（id={id}）");
                Ok(normalized)
            }
            Ok(Err(code)) => {
                self.roll_back(plugin_id, &normalized);
                let message = failure_message(&normalized, code, None);
                log::warn!("插件 {plugin_id} 注册全局热键 {normalized} 失败：{message}");
                Err(message)
            }
            Err(_) => {
                self.roll_back(plugin_id, &normalized);
                let message = "注册全局热键没有在 2 秒内得到结果 —— 热键窗口线程可能已经\
                               退出。宿主写了一条日志，重启应用通常能恢复"
                    .to_string();
                log::warn!("插件 {plugin_id} 注册全局热键 {normalized} 失败：{message}");
                Err(message)
            }
        }
    }

    /// 撤销一次**失败**的注册留下的记账。
    fn roll_back(&self, plugin_id: &str, normalized: &str) {
        let mut state = self.lock();
        state.owners.remove(normalized);
        if let Some(owned) = state.by_plugin.get_mut(plugin_id) {
            owned.remove(normalized);
            if owned.is_empty() {
                state.by_plugin.remove(plugin_id);
            }
        }
    }

    /// 解绑一条组合键。
    ///
    /// **没有权限检查**，与 `clipboard::unsubscribe` 同一条规矩：一条解不掉的绑定
    /// 就是一个泄漏 —— 而热键泄漏的后果比订阅泄漏严重得多（它偷的是用户整台机器上
    /// 的一个按键）。"因为权限变了所以拒绝你退订"在这里没有任何好处。
    ///
    /// 不存在的组合键**静默成功**：插件在 `disposables` 里存一次再自己调一次是
    /// 常见写法，多解一次不该报错。
    pub fn unregister(&self, plugin_id: &str, combo: &str) {
        let Some(normalized) = normalize_combo(combo) else {
            // 连解析都过不了的字符串不可能被注册过。报一个错只会让插件以为自己的
            // 清理逻辑有问题，而它其实是对的。
            return;
        };

        {
            let mut state = self.lock();
            // 只能解绑**自己**的组合：`owners` 里记着是谁，别人的一概不动。
            if state.owners.get(&normalized).map(String::as_str) != Some(plugin_id) {
                return;
            }
            state.owners.remove(&normalized);
            if let Some(owned) = state.by_plugin.get_mut(plugin_id) {
                owned.remove(&normalized);
                if owned.is_empty() {
                    state.by_plugin.remove(plugin_id);
                }
            }
        }

        self.send_unregister(&normalized);
    }

    /// 忘掉一个插件的**全部**热键与订阅（停用 / 卸载）。
    ///
    /// 这是本模块最要紧的一条路径：停用插件时它的代码可能一行都不会执行，因此
    /// 指望它自己 `unregister()` 是不成立的。
    pub fn forget_plugin(&self, plugin_id: &str) {
        let combos: Vec<String> = {
            let mut state = self.lock();
            state.subscriptions.remove(plugin_id);
            let combos: Vec<String> = state
                .by_plugin
                .remove(plugin_id)
                .map(|owned| owned.into_iter().collect())
                .unwrap_or_default();
            for combo in &combos {
                state.owners.remove(combo);
            }
            combos
        };

        for combo in &combos {
            self.send_unregister(combo);
        }

        if !combos.is_empty() {
            log::debug!(
                "[hotkey] 插件 {plugin_id} 被停用/卸载，解绑了 {} 个全局热键",
                combos.len()
            );
        }
    }

    /// 这个插件当前注册的组合键（规范化形式，按字典序）。
    pub fn list(&self, plugin_id: &str) -> Vec<String> {
        self.lock()
            .by_plugin
            .get(plugin_id)
            .map(|owned| owned.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 登记"这个插件想在这些位置收到触发"。
    pub fn subscribe<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        plugin_id: &str,
        surface: Option<&str>,
        background: bool,
    ) -> Result<(), String> {
        if !win::SUPPORTED {
            return Err(UNSUPPORTED_PLATFORM.to_string());
        }

        let mut state = self.lock();
        // 线程要起来：**触发是从窗口线程投出来的**，没有线程就没人投。一个只订阅、
        // 还没注册组合键的插件同样要让线程就绪 —— 它注册组合键时走的是同一条线程，
        // 先起来一步省掉一次竞态。
        self.ensure_thread(&mut state, app)?;

        let entry = state
            .subscriptions
            .entry(plugin_id.to_string())
            .or_default();
        match (surface, background) {
            (None, true) => entry.background = true,
            (Some(surface), _) => {
                entry.surfaces.insert(surface.to_string());
            }
            (None, false) => entry.in_process = true,
        }
        Ok(())
    }

    /// 撤一次订阅。**没有权限检查**，理由同 `unregister`。
    pub fn unsubscribe(&self, plugin_id: &str, surface: Option<&str>, background: bool) {
        let mut state = self.lock();
        let Some(entry) = state.subscriptions.get_mut(plugin_id) else {
            return;
        };

        match (surface, background) {
            (None, true) => entry.background = false,
            (Some(surface), _) => {
                entry.surfaces.remove(surface);
            }
            (None, false) => entry.in_process = false,
        }

        if entry.is_empty() {
            state.subscriptions.remove(plugin_id);
        }
    }

    /// 应用退出时停掉窗口线程，并把**全部**组合键还给系统。
    ///
    /// 进程退出本来就会释放这些注册（内核在进程死亡时回收），因此这一条严格来说
    /// 是冗余的。留着的理由是它**先于**进程退出发生：`stop_all` 与
    /// `cleanup_before_exit` 之间还有一个可观测的窗口，而用户在这个窗口里按下的键
    /// 仍然会被投给一个正在拆除的宿主。显式解绑把那个窗口消掉。
    pub fn stop(&self) {
        let (commands, hwnd, combos) = {
            let mut state = self.lock();
            let combos: Vec<String> = state.owners.keys().cloned().collect();
            state.owners.clear();
            state.by_plugin.clear();
            state.subscriptions.clear();
            let Some(thread) = state.thread.take() else {
                return;
            };
            (thread.commands, thread.hwnd, combos)
        };

        for combo in &combos {
            let _ = commands.send(Command::Unregister {
                id: win::id_of(combo),
                combo: combo.clone(),
            });
        }
        let _ = commands.send(Command::Quit);
        win::wake(hwnd, WM_DRAIN);

        if !combos.is_empty() {
            log::debug!("[hotkey] 应用退出，解绑了 {} 个全局热键", combos.len());
        }
    }

    /// 解绑一条组合键：问出它在窗口线程里的 id，再发命令。
    ///
    /// id 由窗口线程分配（只有它知道 `WM_HOTKEY` 里的 `wParam` 是谁），而发起解绑的
    /// 可能是任意线程。`win::id_of` 是一张无锁的旁路表，见平台层里的说明。
    fn send_unregister(&self, normalized: &str) {
        let (commands, hwnd) = {
            let state = self.lock();
            let Some(thread) = state.thread.as_ref() else {
                return;
            };
            (thread.commands.clone(), thread.hwnd)
        };

        if commands
            .send(Command::Unregister {
                id: win::id_of(normalized),
                combo: normalized.to_string(),
            })
            .is_ok()
        {
            win::wake(hwnd, WM_DRAIN);
        }
    }

    /// 保证消息窗口线程已经起来了，返回它的发送端与窗口句柄。
    ///
    /// 调用方**必须已经持有 `state` 的锁**；失败路径上直接返回错误（因此返回
    /// `Result` 而不是 `Option`）。
    fn ensure_thread<R: Runtime>(
        &self,
        state: &mut RegistryState,
        app: &AppHandle<R>,
    ) -> Result<(Sender<Command>, isize), String> {
        if let Some(thread) = state.thread.as_ref() {
            return Ok((thread.commands.clone(), thread.hwnd));
        }

        let (ready_tx, ready_rx) = channel::<Result<isize, String>>();
        let (command_tx, command_rx) = channel::<Command>();
        let handle = app.clone();

        std::thread::spawn(move || pump(handle, command_rx, ready_tx));

        // **不记线程句柄**，与剪贴板轮询线程同一条理由：没有一条路径需要 `join`
        // 它，而存下 `JoinHandle` 只会诱使有人在退出时去 join —— 那正是"卡在一个
        // 阻塞在 `GetMessageW` 上的线程"的来源。停止靠的是 `Command::Quit`。
        match ready_rx.recv_timeout(COMMAND_TIMEOUT) {
            Ok(Ok(hwnd)) => {
                state.thread = Some(WindowThread {
                    hwnd,
                    commands: command_tx.clone(),
                });
                Ok((command_tx, hwnd))
            }
            Ok(Err(message)) => Err(message),
            Err(_) => Err(
                "热键窗口线程没有在 2 秒内就绪 —— 消息窗口建不起来，全局热键在本机不可用"
                    .to_string(),
            ),
        }
    }
}

/// 需要 `global-hotkey` 权限。**与其它能力同一条判据**：没声明就是拒绝。
///
/// 单独摘出来，是因为三个调用方（RPC、命令层、后台派发）都要做这件事，而漏掉
/// 任意一处的后果是"没声明也能占走用户的一个按键"。
pub fn require_permission(
    manager: &super::manager::PluginManager,
    plugin_id: &str,
) -> Result<(), String> {
    manager
        .require_permission(plugin_id, PluginPermission::GlobalHotkey)
        .map_err(|e| e.to_string())
}

// ============================================================
// 触发投递
// ============================================================

/// 一条组合键被按下。
///
/// 投递规则：**只投给订阅过的那一侧**。三处都推是"简单"，代价是每一条触发都会把
/// 消息再送进宿主前端 realm 一份 —— 那份消息在那里没有任何消费者。
fn deliver<R: Runtime>(app: &AppHandle<R>, plugin_id: &str, combo: &str) {
    let subscription = {
        let Some(registry) = app.try_state::<HotkeyRegistry>() else {
            return;
        };
        let state = registry.lock();
        state.subscriptions.get(plugin_id).cloned()
    };
    let Some(subscription) = subscription else {
        return;
    };

    // 负载里带 `combo`：一个插件最多能注册 4 条，处理函数必须能分辨是哪一条。
    // 契约里的 `handler()` 说的是"不要求参数"，多给一个不会让任何现有写法失效。
    let payload = serde_json::json!({ "combo": combo });

    if subscription.in_process {
        use tauri::Emitter;
        if let Err(error) = app.emit(
            super::rpc::HOTKEY_FIRED,
            serde_json::json!({ "pluginId": plugin_id, "combo": combo }),
        ) {
            log::debug!("广播热键触发给 {plugin_id} 失败：{error}");
        }
    }

    if !subscription.surfaces.is_empty() {
        if let Some(registry) = app.try_state::<super::sandbox::SandboxSurfaces>() {
            // 按 `(插件, 界面)` 找令牌。界面数量有界，线性扫一遍比维护第二张反向表
            // 更不容易漂（与 `clipboard.rs::deliver` 同一条取舍）。
            for (token, key) in registry.live() {
                if key.plugin_id != plugin_id {
                    continue;
                }
                if !subscription.surfaces.contains(&key.surface) {
                    continue;
                }
                super::sandbox::push_to(app, &token, PUSH_CHANNEL, payload.clone());
            }
        }
    }

    if subscription.background {
        // 窗口线程不是 async 的，而派发进 Node 子进程要 await。因此这一次是"把任务
        // 丢给 tokio"，不是"在这里等它" —— 等它会把这个线程卡在一条子进程 IPC 上，
        // 而它下一次还要为别的插件投递。
        let app = app.clone();
        let plugin_id = plugin_id.to_string();
        let combo = combo.to_string();
        tauri::async_runtime::spawn(async move {
            let Some(plugins) = app
                .try_state::<crate::modules::desktop::background::plugins::BackgroundPlugins>()
            else {
                return;
            };
            plugins.dispatch_hotkey(&plugin_id, &combo).await;
        });
    }

    log::debug!("全局热键 {combo} 触发（插件 {plugin_id}）");
}

// ============================================================
// 消息窗口线程
// ============================================================

/// 消息窗口的句柄。窗口线程把 `HWND` 记在这里，供 `register` / `unregister` 取用。
///
/// ============================================================
/// 为什么是"进程内一个句柄"而不是把它沿参数传下去
/// ============================================================
///
/// `register` / `unregister` 由 `turn()` 在**窗口线程内**调用，而句柄同时被 `wake()`
/// （任意线程）需要。把它做成参数意味着 `Command` 里也要带上句柄 —— 三处都要传，
/// 而它们本来就是同一个窗口。这个全局量**没有生命周期问题**：窗口与进程同寿
/// （只在退出时 `destroy_message_window`），因此它在任何读取点都必定有效。
static MESSAGE_WINDOW: std::sync::OnceLock<isize> = std::sync::OnceLock::new();

fn set_current_window(hwnd: isize) {
    let _ = MESSAGE_WINDOW.set(hwnd);
}

/// 消息窗口的句柄。`register` / `unregister` 在窗口线程里用它。
fn current_window() -> Option<isize> {
    MESSAGE_WINDOW.get().copied()
}

/// 窗口线程体：建一个消息窗口，然后在 `GetMessageW` 上等。
///
/// ============================================================
/// 这个线程做什么、不做什么
/// ============================================================
///
/// 它**只**做一件事：把 `WM_HOTKEY` 里的 id 翻译成 `(插件, 组合键)` 并投递出去。
/// 注册与解绑的**判定**全部在锁内完成（那里能看到全部状态），线程只执行 Win32
/// 调用并把结果回执回去。这样做的原因是判定要能单测、而 Win32 调用不能 ——
/// 如果把判定也搬进线程，它能被测试的唯一途径就是"真的注册一个热键"，
/// 那需要一个交互式桌面，CI 上永远不会发生。
fn pump<R: Runtime>(
    app: AppHandle<R>,
    commands: Receiver<Command>,
    ready: Sender<Result<isize, String>>,
) {
    // `id → (组合键, 插件 id)` 只属于这一个线程，因此不需要任何锁。
    let mut combo_of: BTreeMap<i32, String> = BTreeMap::new();
    let mut owner_of: BTreeMap<i32, String> = BTreeMap::new();

    let Some(hwnd) = win::create_message_window() else {
        let _ = ready.send(Err(
            "无法创建热键消息窗口（CreateWindowExW 失败），全局热键在本机不可用".to_string(),
        ));
        return;
    };
    set_current_window(hwnd);
    let _ = ready.send(Ok(hwnd));

    loop {
        let Some(message) = win::next_message() else {
            // `GetMessageW` 返回 0（WM_QUIT）或 -1（错误）。两者都退出：-1 之后继续
            // 循环会变成忙等 —— 而一个忙等的线程比一个退出的线程糟得多。
            break;
        };

        match message {
            win::ThreadMessage::Drain => {
                turn(&commands, &mut combo_of, &mut owner_of);
            }
            win::ThreadMessage::Hotkey(id) => {
                // 查不出这个 id 说明它刚被解绑 —— 静默忽略。
                if let (Some(combo), Some(plugin_id)) = (combo_of.get(&id), owner_of.get(&id)) {
                    deliver(&app, plugin_id, combo);
                }
            }
            win::ThreadMessage::Quit => break,
        }
    }

    win::destroy_message_window(hwnd);
}

/// 把通道里排队的命令全部执行掉。
fn turn(
    commands: &Receiver<Command>,
    combo_of: &mut BTreeMap<i32, String>,
    owner_of: &mut BTreeMap<i32, String>,
) {
    while let Ok(command) = commands.try_recv() {
        match command {
            Command::Register {
                id,
                combo,
                plugin_id,
                accelerator,
                reply,
            } => {
                let result = win::register(id, accelerator);
                if result.is_ok() {
                    win::remember(&combo, id);
                    combo_of.insert(id, combo);
                    owner_of.insert(id, plugin_id);
                }
                // 回执的对象可能已经走了（调用方超时）—— 那不是错误。
                let _ = reply.send(result);
            }
            Command::Unregister { id, combo } => {
                win::unregister(id, &combo);
                combo_of.remove(&id);
                owner_of.remove(&id);
            }
            Command::Quit => {
                // 退出由调用方紧接着发 Quit；窗口销毁在 `pump` 的出口做。
            }
        }
    }
}

// ============================================================
// Windows 实现
// ============================================================

#[cfg(windows)]
mod win {
    use std::collections::BTreeMap;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::sync::{Mutex, OnceLock};

    use windows_sys::Win32::Foundation::{GetLastError, HWND};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostMessageW,
        RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WNDCLASSW, WM_HOTKEY,
    };

    use super::{Accelerator, WM_DRAIN};

    pub const SUPPORTED: bool = true;

    /// 热键 id 的下一个取值。从 1 开始。
    ///
    /// 单调递增、进程内唯一即可 —— `RegisterHotKey` 的 id 只要在**同一个窗口内**
    /// 唯一，而本模块只有一个消息窗口。不从 0 开始是因为 0 在 Win32 的习惯里常表示
    /// "没有"，而 `UnregisterHotKey` 传一个不存在的 id 会静默失败。
    static NEXT_ID: AtomicI32 = AtomicI32::new(1);

    pub fn next_id() -> i32 {
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    }

    /// 组合键 → id 的**只读旁路表**，供任意线程发起的解绑反查。
    ///
    /// ============================================================
    /// 为什么可以是一张无锁表，而真源仍然是线程里那张
    /// ============================================================
    ///
    /// 解绑由**任意线程**发起（RPC 线程、停用插件的命令线程），而 `combo_of` 只属于
    /// 消息窗口线程。让调用方去问线程一次（发查询命令、等回执）会把一次解绑变成两跳，
    /// 而解绑**必须在任何情况下都发得出去** —— 它正是"用户拿回那个按键"的唯一途径。
    ///
    /// 查不到时返回 -1：`UnregisterHotKey` 的 id 必须非负，因此那是一次**安全的
    /// 无操作**，而不会误伤别人那条。
    static IDS: OnceLock<Mutex<BTreeMap<String, i32>>> = OnceLock::new();

    fn ids() -> &'static Mutex<BTreeMap<String, i32>> {
        IDS.get_or_init(|| Mutex::new(BTreeMap::new()))
    }

    /// 注册成功后登记 id，供解绑反查。由 `turn()` 在窗口线程里调用。
    pub fn remember(combo: &str, id: i32) {
        ids()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(combo.to_string(), id);
    }

    pub fn id_of(combo: &str) -> i32 {
        ids()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(combo)
            .copied()
            .unwrap_or(-1)
    }

    fn forget(id: i32) {
        ids()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, value| *value != id);
    }

    /// 消息循环里认出的一条消息。
    pub enum ThreadMessage {
        /// 通道里有命令，去处理。
        Drain,
        /// 一条热键触发了。
        Hotkey(i32),
        /// 该退出了。
        Quit,
    }

    /// 建一个消息窗口（`HWND_MESSAGE`）。
    ///
    /// 窗口过程直接用 `DefWindowProcW`：**本模块不需要自定义 wndproc**。`WM_HOTKEY`
    /// 与唤醒消息都在 `GetMessageW` 之后由 `pump` 自己分派 —— 那样做的一个实际好处
    /// 是消息处理全部在一个普通函数里，可以读懂，而不是藏在 `extern "system"` 回调里
    /// （那种回调里能安全做的事很少，因为它在窗口线程上、且不允许 unwind）。
    pub fn create_message_window() -> Option<isize> {
        let class_name: Vec<u16> = "ModulithHotkeyWindow\0".encode_utf16().collect();
        let window_name: Vec<u16> = "Modulith 全局热键\0".encode_utf16().collect();

        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            if instance.is_null() {
                log::warn!("[hotkey] GetModuleHandleW 失败，无法创建消息窗口");
                return None;
            }

            let class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(DefWindowProcW),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };

            // 注册失败**不一定是错误**：同一个类可能已经被注册过
            // （`ERROR_CLASS_ALREADY_EXISTS`），而那种情况下 `CreateWindowExW`
            // 照样能成功。因此这里只看 `CreateWindowExW` 的结果。
            RegisterClassW(&class);

            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                window_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                instance,
                std::ptr::null::<c_void>(),
            );

            if hwnd.is_null() {
                log::warn!(
                    "[hotkey] CreateWindowExW 失败（GetLastError={}），全局热键不可用",
                    GetLastError()
                );
                return None;
            }

            // `HWND` 在 windows-sys 里是 `*mut c_void`，而 `HotkeyRegistry` 要把句柄
            // 存进一个**非泛型**的托管状态里。存成 `isize` 而不是把裸指针带出去：
            // 指针类型会让 `HotkeyRegistry` 自动失去 `Send`/`Sync`（那会让
            // `app.manage` 直接编译不过），而 `isize` 是可发送的普通整数。
            Some(hwnd as isize)
        }
    }

    pub fn destroy_message_window(hwnd: isize) {
        unsafe {
            DestroyWindow(hwnd as HWND);
        }
    }

    /// 从消息队列取一条。返回 `None` 表示该退出了。
    pub fn next_message() -> Option<ThreadMessage> {
        let mut message = MSG::default();
        // 传 `null` 的 hwnd：取**本线程所有窗口**的消息。这里只有一个窗口，而限定
        // hwnd 会让将来多一个窗口时那条消息静默丢失。
        let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };

        if result == 0 {
            // WM_QUIT
            return Some(ThreadMessage::Quit);
        }
        if result == -1 {
            log::warn!("[hotkey] GetMessageW 返回 -1，热键消息循环退出");
            return None;
        }

        match message.message {
            WM_HOTKEY => Some(ThreadMessage::Hotkey(message.wParam as i32)),
            value if value == WM_DRAIN => Some(ThreadMessage::Drain),
            _ => {
                // 其余消息交给默认处理。这里**不能**忽略 TranslateMessage /
                // DispatchMessageW —— 少了它们，窗口消息的常规语义（例如 `WM_CLOSE`
                // 之外的销毁路径）就不再成立。
                unsafe {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                // 处理完一条别的东西之后**顺手把命令排空**：通道里可能已经有活等着，
                // 而再等一条消息才处理会让注册延迟到下一次用户按键。
                Some(ThreadMessage::Drain)
            }
        }
    }

    /// 叫醒阻塞在 `GetMessageW` 上的窗口线程。
    pub fn wake(hwnd: isize, message: u32) {
        unsafe {
            PostMessageW(hwnd as HWND, message, 0, 0);
        }
    }

    /// 注册一条组合键。失败时**只回原始错误码** —— 翻译成人话的那一步在
    /// `failure_message`（纯函数，可单测），而它需要知道是哪个组合键。
    pub fn register(id: i32, accelerator: Accelerator) -> Result<(), u32> {
        let Some(hwnd) = super::current_window() else {
            // 没有窗口句柄时用一个不可能成功的错误码，让调用方走"失败"的分支。
            return Err(0);
        };

        let ok = unsafe {
            RegisterHotKey(
                hwnd as HWND,
                id,
                accelerator.modifiers,
                accelerator.virtual_key,
            )
        };

        if ok != 0 {
            return Ok(());
        }
        Err(unsafe { GetLastError() })
    }

    pub fn unregister(id: i32, _combo: &str) {
        // id 非负是 Win32 的要求；-1 是"这张组合从来没注册成功过"的记号。
        if id < 0 {
            return;
        }
        let Some(hwnd) = super::current_window() else {
            return;
        };
        unsafe {
            UnregisterHotKey(hwnd as HWND, id);
        }
        forget(id);
    }
}

// ============================================================
// 非 Windows 实现
// ============================================================
//
// 保留同一个签名集合，因此上层不需要任何 `cfg`。**它必须"诚实地失败"**：
// `register` / `subscribe` 返回一句说清原因的错误，而不是静默成功 —— 静默成功会
// 让插件以为热键装上了，而用户按了没反应，没有任何线索。
#[cfg(not(windows))]
mod win {
    use super::Accelerator;

    pub const SUPPORTED: bool = false;

    pub fn next_id() -> i32 {
        0
    }

    pub fn id_of(_combo: &str) -> i32 {
        -1
    }

    pub fn remember(_combo: &str, _id: i32) {}

    /// 非 Windows 上窗口线程根本不会起来（`ensure_thread` 之前就被 `SUPPORTED`
    /// 挡下），因此这些函数都不会被调用。
    pub fn wake(_hwnd: isize, _message: u32) {}

    pub fn register(_id: i32, _accelerator: Accelerator) -> Result<(), u32> {
        Err(0)
    }

    pub fn unregister(_id: i32, _combo: &str) {}

    pub fn create_message_window() -> Option<isize> {
        None
    }

    pub fn destroy_message_window(_hwnd: isize) {}

    pub enum ThreadMessage {
        Drain,
        Hotkey(i32),
        Quit,
    }

    pub fn next_message() -> Option<ThreadMessage> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============================================================
    // 组合键语法
    // ============================================================

    /// 语料表就是"两侧必须一致"的那份东西，因此先保证它自己是对的。
    ///
    /// 这一条**不足以**证明前端与 Rust 一致 —— 那件事由
    /// `scripts/check-plugin-runtime.ts` 拿真正的 `normalizeCombo()` 往返验证。
    /// 这里守的是另一半：Rust 侧那份表本身没有被改坏。
    #[test]
    fn the_shared_grammar_cases_hold() {
        for (input, expected) in GRAMMAR_CASES {
            assert_eq!(
                normalize_combo(input).as_deref(),
                *expected,
                "组合键 `{input}` 的规范化结果与共享语料不符"
            );
        }
    }

    #[test]
    fn modifiers_normalize_in_a_fixed_order() {
        // 三个修饰符的每一种书写顺序都得到同一个字符串 —— 否则"同一个组合"会有多种
        // 表示，而冲突检测就会漏判。
        for written in [
            "mod+shift+alt+k",
            "shift+mod+alt+k",
            "alt+shift+mod+k",
            "option+cmd+meta+shift+k",
            "MOD+SHIFT+ALT+K",
        ] {
            assert_eq!(
                normalize_combo(written).as_deref(),
                Some("mod+shift+alt+k"),
                "`{written}` 应当规范化成同一个形式"
            );
        }
    }

    #[test]
    fn the_aliases_are_the_documented_ones() {
        assert_eq!(normalize_combo("ctrl+k").as_deref(), Some("mod+k"));
        assert_eq!(normalize_combo("cmd+k").as_deref(), Some("mod+k"));
        assert_eq!(normalize_combo("meta+k").as_deref(), Some("mod+k"));
        assert_eq!(normalize_combo("option+k").as_deref(), Some("alt+k"));
        assert_eq!(normalize_combo("  Mod + K  ").as_deref(), Some("mod+k"));
    }

    // ============================================================
    // 虚拟键码
    // ============================================================

    #[test]
    fn letters_and_digits_use_their_ascii_codes() {
        assert_eq!(virtual_key_of("a"), Ok(0x41));
        assert_eq!(virtual_key_of("z"), Ok(0x5A));
        assert_eq!(virtual_key_of("0"), Ok(0x30));
        assert_eq!(virtual_key_of("9"), Ok(0x39));
    }

    #[test]
    fn function_keys_are_contiguous() {
        assert_eq!(virtual_key_of("f1"), Ok(0x70));
        assert_eq!(virtual_key_of("f12"), Ok(0x7B));
        assert_eq!(virtual_key_of("f24"), Ok(0x87));
        // 超出范围的、以及"看起来像但其实是别的形状"的一律拒绝
        assert!(virtual_key_of("f25").is_err());
        assert!(virtual_key_of("f0").is_err());
        assert!(virtual_key_of("fx").is_err());
        // `f` 是**字母 F**，不是功能键 —— 单个字母走 ASCII 那一条。
        // 这正是"认不出的形状不许猜"的边界：`f` 与 `f1` 只差一个字符，而它们
        // 是完全不同的两个键。
        assert_eq!(virtual_key_of("f"), Ok(0x46));
        assert_eq!(virtual_key_of("f1"), Ok(0x70));
    }

    /// 认不出的主键**必须报错**，而且错误里要列出支持什么。
    ///
    /// 猜一个默认键的症状是"我按的组合没反应，倒是另一个键在弹窗" —— 用户与作者
    /// 都会往错的方向找。
    #[test]
    fn unknown_keys_are_refused_with_a_list() {
        let error = virtual_key_of("weird").expect_err("不认识的键名应当被拒绝");
        assert!(error.contains("F1..F24"), "错误里要说清支持什么：{error}");
        assert!(error.contains("left"), "{error}");

        assert!(virtual_key_of("f13x").is_err());
        assert!(virtual_key_of("a1").is_err());
    }

    /// 一个**普通键不能单独占用**。
    ///
    /// 这条规则的具体后果是"用户在任何一个程序里都打不出 `a`" —— 那是本模块唯一
    /// 一条会直接损害用户日常输入的路径。
    #[test]
    fn a_bare_key_may_not_be_taken_from_the_whole_machine() {
        for combo in ["a", "1", "space", "tab", "enter", "left"] {
            let error = accelerator(combo).expect_err("不带修饰键的普通键应当被拒绝");
            assert!(
                error.contains("整台机器"),
                "错误要说清后果，而不只是「不合法」：{error}"
            );
        }

        // 功能键是例外：F9 单独占用是常见且无害的用法
        assert!(accelerator("f9").is_ok());
        assert!(accelerator("mod+a").is_ok());
    }

    #[test]
    fn every_combo_carries_mod_norepeat() {
        let accel = accelerator("mod+q").expect("mod+q 应当可以注册");
        assert_eq!(accel.virtual_key, 0x51);
        assert_eq!(accel.modifiers & MOD_CONTROL, MOD_CONTROL);
        assert_eq!(
            accel.modifiers & MOD_NOREPEAT,
            MOD_NOREPEAT,
            "没有 MOD_NOREPEAT，按住不放会让 WM_HOTKEY 连续投递，插件会在一秒里触发十几次"
        );
    }

    /// 自己抄的那几个整数必须与 windows-sys 一模一样。
    ///
    /// 抄错不会有任何编译错误，症状只是"某个组合绑到了另一个键上" —— 那在真机上
    /// 表现为"我按 Ctrl+Q 没反应，倒是别的键会弹窗"。这条测试是唯一能自动发现它的
    /// 地方。
    #[cfg(windows)]
    #[test]
    fn accel_constants_match_windows_sys() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse as km;

        assert_eq!(MOD_ALT, km::MOD_ALT);
        assert_eq!(MOD_CONTROL, km::MOD_CONTROL);
        assert_eq!(MOD_SHIFT, km::MOD_SHIFT);
        assert_eq!(MOD_WIN, km::MOD_WIN);
        assert_eq!(MOD_NOREPEAT, km::MOD_NOREPEAT);

        assert_eq!(virtual_key_of("tab"), Ok(km::VK_TAB as u32));
        assert_eq!(virtual_key_of("escape"), Ok(km::VK_ESCAPE as u32));
        assert_eq!(virtual_key_of("space"), Ok(km::VK_SPACE as u32));
        assert_eq!(virtual_key_of("enter"), Ok(km::VK_RETURN as u32));
        assert_eq!(virtual_key_of("left"), Ok(km::VK_LEFT as u32));
        assert_eq!(virtual_key_of("f1"), Ok(km::VK_F1 as u32));
    }

    // ============================================================
    // 冲突消息
    // ============================================================

    /// 1409 必须变成一句说明"谁占着它"的话，而不是一个裸数字。
    #[test]
    fn a_hotkey_conflict_becomes_a_named_message() {
        let message = failure_message("mod+q", ERROR_HOTKEY_ALREADY_REGISTERED, None);
        assert!(message.contains("1409"), "契约要求点名这个错误码：{message}");
        assert!(message.contains("其它程序或操作系统"), "{message}");

        let held_by_plugin = failure_message(
            "mod+q",
            ERROR_HOTKEY_ALREADY_REGISTERED,
            Some(Holder::Plugin("com.acme.other".to_string())),
        );
        assert!(held_by_plugin.contains("com.acme.other"), "{held_by_plugin}");
        assert!(held_by_plugin.contains("换一个组合键"), "{held_by_plugin}");

        let held_by_host =
            failure_message("mod+k", ERROR_HOTKEY_ALREADY_REGISTERED, Some(Holder::Host));
        assert!(held_by_host.contains("宿主快捷键"), "{held_by_host}");

        // 别的错误码也要有可读的解释，而不是一个裸数字
        let other = failure_message("mod+q", 5, None);
        assert!(other.contains("RegisterHotKey 返回错误码 5"), "{other}");
    }

    #[test]
    fn the_conflict_error_code_is_the_documented_one() {
        assert_eq!(ERROR_HOTKEY_ALREADY_REGISTERED, 1409);
    }

    // ============================================================
    // 上限与订阅表
    // ============================================================

    /// 上限就是文档里写的那个数字。
    ///
    /// 它被文档、权限描述与这份代码同时引用，而改一个数字不会有任何编译错误。
    #[test]
    fn the_documented_cap_is_four() {
        assert_eq!(MAX_COMBOS_PER_PLUGIN, 4);
    }

    /// 订阅表：三个位置分别记账，撤到一个不剩时整条消失。
    ///
    /// 这里不启动线程（那需要一个交互式桌面），只验证那张表的语义。
    #[test]
    fn the_subscription_table_keeps_three_positions_apart() {
        let mut subscription = Subscription::default();
        assert!(subscription.is_empty());

        subscription.in_process = true;
        subscription.surfaces.insert("main".to_string());
        subscription.background = true;
        assert!(!subscription.is_empty());

        subscription.surfaces.remove("main");
        assert!(!subscription.is_empty(), "还有另外两个位置在订阅");

        subscription.in_process = false;
        subscription.background = false;
        assert!(subscription.is_empty());
    }

    /// `stop()` 在窗口线程从来没起来时也必须安全。
    ///
    /// 这条路径是**每次非 Windows 启动**都会走的（`SUPPORTED == false` 时线程永远
    /// 不创建），也是"装了插件但一次都没用过热键就退出"时走的。
    #[test]
    fn stopping_without_a_thread_is_a_no_op() {
        let registry = HotkeyRegistry::default();
        registry.stop();
        assert!(registry.list("any").is_empty());
        registry.forget_plugin("any");
    }

    /// 解绑只能动**自己**的组合。
    ///
    /// 一个插件能解掉另一个插件的热键，等于它能悄悄让对手失效 —— 而那是本模块里
    /// 最不该出现的一类越权。
    #[test]
    fn unregister_only_touches_the_callers_own_combos() {
        let registry = HotkeyRegistry::default();
        {
            let mut state = registry.lock();
            state
                .owners
                .insert("mod+q".to_string(), "someone.else".to_string());
            state
                .by_plugin
                .entry("someone.else".to_string())
                .or_default()
                .insert("mod+q".to_string());
        }

        registry.unregister("me", "mod+q");
        assert_eq!(
            registry.list("someone.else"),
            vec!["mod+q".to_string()],
            "别人的绑定不该被解掉"
        );

        registry.unregister("someone.else", "mod+q");
        assert!(registry.list("someone.else").is_empty());
    }

    /// 停用/卸载时一次忘掉全部：热键与订阅都清掉。
    #[test]
    fn forgetting_a_plugin_clears_combos_and_subscriptions() {
        let registry = HotkeyRegistry::default();
        {
            let mut state = registry.lock();
            for combo in ["mod+q", "mod+shift+q"] {
                state.owners.insert(combo.to_string(), "p".to_string());
            }
            state.by_plugin.insert(
                "p".to_string(),
                ["mod+q", "mod+shift+q"]
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
            );
            state.subscriptions.insert(
                "p".to_string(),
                Subscription {
                    in_process: true,
                    ..Default::default()
                },
            );
        }

        registry.forget_plugin("p");

        assert!(registry.list("p").is_empty());
        assert!(
            registry.lock().owners.is_empty(),
            "所有者表里也一条都不该剩"
        );
        assert!(registry.lock().subscriptions.is_empty());
    }

    /// 组合键的规范化是"冲突检测有唯一表示"的前提。
    ///
    /// 同一个组合的两种写法若得到两个字符串，`owners` 表里就会有两条互不知道的记录
    /// —— 于是第二次注册**成功**，而系统里第一次那条还在，两个插件都以为自己占着它。
    #[test]
    fn every_writing_of_one_combo_maps_to_one_owner_key() {
        let mut seen = BTreeSet::new();
        for written in [
            "mod+shift+tab",
            "Shift+Mod+Tab",
            "shift+ctrl+tab",
            "mod + shift + tab",
        ] {
            seen.insert(normalize_combo(written).expect("这些都该能解析"));
        }
        assert_eq!(seen.len(), 1, "同一个组合的不同写法必须收敛成同一个键");
    }
}
