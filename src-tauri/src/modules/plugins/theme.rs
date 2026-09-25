// src-tauri/src/modules/plugins/theme.rs
//
// 把宿主的主题交给插件。
//
// ============================================================
// 为什么主题必须由宿主"推给"插件
// ============================================================
//
// 沙箱插件的界面跑在**另一个 webview** 里。那个文档与宿主文档没有任何继承关系：
// 它拿不到宿主的 CSS 变量、拿不到宿主的 `class="dark"`、也拿不到 `prefers-color-scheme`
// 背后的那个"用户选的是浅色还是深色"（那个媒体查询反映的是**操作系统**的设置，
// 而用户可以在这个应用里单独覆盖）。
//
// 结果是：如果宿主不管这件事，插件只能自己去猜。猜错的表现是**插件比宿主亮
// 一档或暗一档** —— 用户看到的是"这个插件与整个应用不是一套的"，而插件作者
// 那边什么都看不出来（在他的机器上可能恰好一致）。
//
// 因此宿主把三样东西一起给它：
//
//   1. **全套设计令牌**（CSS 自定义属性的名字与值，原样）；
//   2. 解析后的主题（`light` / `dark`），用于 `color-scheme`，让滚动条、
//      表单控件、`<input>` 的原生外观跟着走；
//   3. 用户的两个偏好（减少动效、毛玻璃）。
//
// ============================================================
// 为什么给的是"全套令牌"而不是"一个颜色映射"
// ============================================================
//
// 一个映射（`--modulith-bg`、`--modulith-fg`…）意味着宿主每加一个令牌就要
// 往那个映射里补一条，而**漏补不会被发现**：插件那边只是拿不到那个变量，
// 表现为某一处颜色退回成浏览器默认值。
//
// 直接传全套则是"宿主有什么、插件就有什么"：宿主的设计系统改了颜色，
// 插件跟着变，不需要任何一侧改代码。名字也保持**原样**（`--accent-500`
// 而不是 `--modulith-accent-500`）—— 这样插件作者从宿主界面里复制一段样式
// 就能直接用，而加前缀会让他每一条都要改名字。
//
// 代价是插件能看到宿主的全部自定义属性。那没有风险：它们是**设计令牌**，
// 本来就显示在用户眼前。

use std::collections::BTreeMap;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

/// 宿主当前的主题快照。
///
/// 由前端在**主题变化时**通过 `set_plugin_theme` 推上来。宿主自己不去读
/// `document` —— 它没有宿主文档（那在另一个 webview 里）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSnapshot {
    /// 解析后的主题。决定 `color-scheme`，也就是滚动条与原生控件的明暗。
    #[serde(default = "default_resolved")]
    pub resolved: String,
    /// 用户是否要求减少动效
    #[serde(default)]
    pub reduce_motion: bool,
    /// 毛玻璃是否可用（用户没关、且没开性能模式）
    #[serde(default = "default_true")]
    pub glass: bool,
    /// 全套设计令牌：CSS 变量名（含 `--`）→ 值
    #[serde(default)]
    pub tokens: BTreeMap<String, String>,
}

/// **手写而不是 `derive(Default)`。**
///
/// `derive` 会给 `resolved` 一个空串，而 `#[serde(default = "…")]` **只作用于
/// 反序列化**，不作用于 `Default::default()`。两者给出的兜底因此不一致：
/// 一份从空 JSON 反序列化来的快照是 `dark`，而 `ThemeSnapshot::default()`
/// 是空串 —— 而 `PluginTheme::new()` 用的正是后者。
///
/// 表现是插件在顶层读到的 `Modulith.theme.current().resolved` 是个空字符串，
/// 而那看起来像宿主没送主题过来。这条是本模块的测试逼出来的，不是推理出来的。
impl Default for ThemeSnapshot {
    fn default() -> Self {
        Self {
            resolved: default_resolved(),
            reduce_motion: false,
            glass: default_true(),
            tokens: BTreeMap::new(),
        }
    }
}

fn default_resolved() -> String {
    "dark".to_string()
}

fn default_true() -> bool {
    true
}

impl ThemeSnapshot {
    /// 渲染成一段注入插件文档的 CSS。
    ///
    /// 用 `:root` 而不是 `html`：两者的优先级有差别，而 `:root` 是宿主
    /// 自己那份样式表用的选择器 —— 保持一致才不会出现"插件里的同名变量
    /// 赢了宿主注入的那一份"这种很难解释的现象。
    pub fn to_css(&self) -> String {
        let mut css = String::with_capacity(self.tokens.len() * 48 + 256);

        css.push_str(":root {\n");
        for (name, value) in &self.tokens {
            // 变量名必须长得像变量名。不做这个检查的话，一个带 `}` 的名字
            // 能提前闭合规则块，往文档里注入任意 CSS。
            if !is_safe_custom_property(name) {
                continue;
            }

            // **被拒绝的值整条不写**，而不是写成 `--x: ;`。
            //
            // 空声明在 CSS 里会被解析器丢掉，因此两者"效果一样"—— 但写出来
            // 的那一条会让读日志的人以为这个令牌存在、只是没有值，而它其实
            // 是因为含有危险字符被拒了。少一行比多一行误导好。
            let sanitized = sanitize_value(value);
            if sanitized.is_empty() {
                continue;
            }

            css.push_str("  ");
            css.push_str(name);
            css.push_str(": ");
            css.push_str(&sanitized);
            css.push_str(";\n");
        }
        // `color-scheme` 写在令牌**之后**：同一个块里后面的声明赢，而我们
        // 这一条必须是最终生效的那一个。
        css.push_str(&format!("  color-scheme: {};\n", self.color_scheme()));
        css.push_str(&format!(
            "  --modulith-reduce-motion: {};\n",
            if self.reduce_motion { "1" } else { "0" }
        ));
        css.push_str(&format!(
            "  --modulith-glass: {};\n",
            if self.glass { "1" } else { "0" }
        ));
        css.push_str("}\n");

        // 减少动效时**由宿主**压掉动画，而不是指望每个插件自己判断。
        // 这是无障碍偏好，漏掉它的插件会让用户难受，而作者多半想不到。
        if self.reduce_motion {
            css.push_str(
                "@media (prefers-reduced-motion: no-preference) {\n\
                 \x20 *, *::before, *::after {\n\
                 \x20   animation-duration: 0.001ms !important;\n\
                 \x20   animation-iteration-count: 1 !important;\n\
                 \x20   transition-duration: 0.001ms !important;\n\
                 \x20 }\n\
                 }\n",
            );
        }

        css
    }

    fn color_scheme(&self) -> &'static str {
        if self.resolved == "light" {
            "light"
        } else {
            "dark"
        }
    }
}

/// 主题快照的托管状态。
///
/// `RwLock<Arc<..>>` 而不是 `RwLock<..>`：协议处理器在**每次请求入口文档**时
/// 都要读它，而读到的快照要被克隆进那个文档。用 `Arc` 让"读"这一步只是克隆
/// 一个指针，而不是克隆整张令牌表（几十条）。
#[derive(Default)]
pub struct PluginTheme(RwLock<std::sync::Arc<ThemeSnapshot>>);

impl PluginTheme {
    pub fn new() -> Self {
        Self(RwLock::new(std::sync::Arc::new(ThemeSnapshot::default())))
    }

    /// 换一份快照。返回**是否真的变了** —— 调用方据此决定要不要推给已打开的界面。
    pub fn set(&self, snapshot: ThemeSnapshot) -> bool {
        let mut current = self.0.write().unwrap_or_else(|e| e.into_inner());

        // 逐字段比较而不是比较序列化结果：令牌表是 `BTreeMap`，顺序稳定，
        // 但序列化一次只为了比较是白花的。这里的字段数很少。
        let same = current.resolved == snapshot.resolved
            && current.reduce_motion == snapshot.reduce_motion
            && current.glass == snapshot.glass
            && current.tokens == snapshot.tokens;

        if same {
            return false;
        }

        *current = std::sync::Arc::new(snapshot);
        true
    }

    pub fn get(&self) -> std::sync::Arc<ThemeSnapshot> {
        std::sync::Arc::clone(&self.0.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// 给插件读的那一份（`ctx.theme.tokens()`）。
    pub fn describe(&self) -> serde_json::Value {
        let snapshot = self.get();
        serde_json::json!({
            "resolved": snapshot.resolved,
            "reduceMotion": snapshot.reduce_motion,
            "glass": snapshot.glass,
            "tokens": snapshot.tokens,
        })
    }
}

/// 一个 CSS 自定义属性名是否安全到可以拼进样式表。
///
/// 白名单而不是黑名单：允许 `--` 开头 + 字母数字与 `-` `_`。黑名单（"不含 `}`"）
/// 总会漏掉某个能让规则块提前闭合的写法，而白名单漏掉的最多只是一个合法的
/// 变量名被拒绝 —— 那个方向的错误是**可见的**（少一个变量），另一个方向是注入。
fn is_safe_custom_property(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("--") else {
        return false;
    };
    if rest.is_empty() || rest.len() > 128 {
        return false;
    }
    rest.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 一个 CSS 值是否安全到可以拼进样式表。
///
/// 值比名字宽松得多（它可以是 `hsl(243 80% 55%)`、`rgb(from … r g b / 0.1)`、
/// 一串字体名），因此这里拦的是**能改变样式表结构**的那几个字符：`;` `{` `}`
/// 以及换行。它们出现即整条丢弃 —— 丢掉一条颜色比让插件注入一段 CSS 好，
/// 而且这些字符在任何正常的令牌值里都不会出现。
fn sanitize_value(value: &str) -> String {
    if value.len() > 512
        || value.contains(';')
        || value.contains('{')
        || value.contains('}')
        || value.contains('\n')
        || value.contains('\r')
        || value.contains("</")
    {
        return String::new();
    }
    value.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> ThemeSnapshot {
        let mut tokens = BTreeMap::new();
        tokens.insert("--accent-500".to_string(), "hsl(243 80% 55%)".to_string());
        tokens.insert("--surface-0".to_string(), "#0f1117".to_string());
        ThemeSnapshot {
            resolved: "dark".to_string(),
            reduce_motion: false,
            glass: true,
            tokens,
        }
    }

    #[test]
    fn tokens_are_emitted_verbatim_under_root() {
        let css = snapshot().to_css();
        assert!(css.contains(":root {"));
        assert!(css.contains("--accent-500: hsl(243 80% 55%);"));
        assert!(css.contains("--surface-0: #0f1117;"));
        assert!(css.contains("color-scheme: dark;"));
    }

    /// 主题决定 `color-scheme` —— 它管的是滚动条与 `<input>` 的原生外观。
    ///
    /// 少了它，深色主题下插件里的滚动条会是白色的，而那是用户一眼就能看到的
    /// "这个插件不对劲"。
    #[test]
    fn the_resolved_theme_drives_color_scheme() {
        let mut light = snapshot();
        light.resolved = "light".to_string();
        assert!(light.to_css().contains("color-scheme: light;"));

        let mut dark = snapshot();
        dark.resolved = "dark".to_string();
        assert!(dark.to_css().contains("color-scheme: dark;"));

        // 不认识的取值一律当深色（与前端 `applyTheme` 的兜底一致）
        let mut odd = snapshot();
        odd.resolved = "solarized".to_string();
        assert!(odd.to_css().contains("color-scheme: dark;"));
    }

    /// 减少动效由宿主压掉，而不是指望每个插件自己判断。
    #[test]
    fn reduce_motion_is_enforced_by_the_host() {
        let mut quiet = snapshot();
        quiet.reduce_motion = true;
        let css = quiet.to_css();

        assert!(css.contains("--modulith-reduce-motion: 1;"));
        assert!(css.contains("animation-duration: 0.001ms !important"));
        assert!(css.contains("transition-duration: 0.001ms !important"));

        // 没开时**不能**注入那一段：它会把所有插件的动效一起压掉。
        let loud = snapshot().to_css();
        assert!(!loud.contains("animation-duration"));
        assert!(loud.contains("--modulith-reduce-motion: 0;"));
    }

    /// **注入防线。** 一个带 `}` 的令牌名能提前闭合规则块。
    #[test]
    fn a_hostile_token_name_is_dropped() {
        let mut hostile = snapshot();
        hostile
            .tokens
            .insert("--evil}\nbody{display:none".to_string(), "red".to_string());
        hostile
            .tokens
            .insert("color-scheme".to_string(), "light".to_string()); // 少了 --
        hostile.tokens.insert("--ok".to_string(), "1px".to_string());

        let css = hostile.to_css();
        assert!(!css.contains("display:none"), "恶意令牌名不该出现在 CSS 里：{css}");
        assert!(!css.contains("color-scheme: light"), "没有 -- 前缀的名字不该被当成令牌");
        assert!(css.contains("--ok: 1px;"), "合法令牌仍然要保留");
        // 注入没成功：`:root` 块只闭合一次（我们自己的那次）
        assert_eq!(css.matches(":root {").count(), 1);
    }

    /// 值里能改变样式表结构的字符会整条丢弃。
    #[test]
    fn a_hostile_token_value_is_dropped() {
        let mut hostile = snapshot();
        hostile
            .tokens
            .insert("--a".to_string(), "red; } body { display: none".to_string());
        hostile.tokens.insert("--b".to_string(), "red\n}".to_string());
        hostile.tokens.insert("--c".to_string(), "blue".to_string());

        let css = hostile.to_css();
        assert!(!css.contains("display: none"), "恶意值不该出现在 CSS 里");
        assert!(!css.contains("--a:"), "含 ; 的值应当整条丢弃");
        assert!(!css.contains("--b:"), "含换行的值应当整条丢弃");
        assert!(css.contains("--c: blue;"), "干净的值必须保留");
    }

    /// 合法但复杂的值**不能**被误杀 —— 否则上面那条测试可以靠"全部丢弃"通过。
    ///
    /// 这几个是宿主样式表里真实存在的形状（Tailwind 4 的 `rgb(from …)` 与
    /// 带空格的 `hsl()`）。
    #[test]
    fn ordinary_token_values_survive() {
        let mut snapshot = snapshot();
        for (name, value) in [
            ("--accent-50", "hsl(243 80% 97%)"),
            ("--tint", "rgb(from var(--accent-500) r g b / 0.1)"),
            ("--font", "\"Segoe UI\", system-ui, sans-serif"),
            ("--radius", "0.75rem"),
            ("--empty", ""),
        ] {
            snapshot.tokens.insert(name.to_string(), value.to_string());
        }

        let css = snapshot.to_css();
        assert!(css.contains("--accent-50: hsl(243 80% 97%);"));
        assert!(css.contains("--tint: rgb(from var(--accent-500) r g b / 0.1);"));
        assert!(css.contains("--font: \"Segoe UI\", system-ui, sans-serif;"));
        assert!(css.contains("--radius: 0.75rem;"));
    }

    /// `set` 只在**真的变了**的时候返回 true。
    ///
    /// 这条决定的是"要不要把新主题推给所有已打开的插件界面"。前端会因为
    /// 别的理由重推同一份快照（窗口获得焦点、设置页重渲染），而每推一次就是
    /// 一圈 `eval` —— 不判等会让那些无关的动作触发全量重绘。
    #[test]
    fn set_reports_whether_anything_changed() {
        let theme = PluginTheme::new();

        assert!(theme.set(snapshot()), "第一次设置必须算变化");
        assert!(!theme.set(snapshot()), "内容一样时不该算变化");

        let mut different = snapshot();
        different.resolved = "light".to_string();
        assert!(theme.set(different), "解析主题变了必须算变化");

        let mut tokens_changed = snapshot();
        tokens_changed
            .tokens
            .insert("--new".to_string(), "1px".to_string());
        assert!(theme.set(tokens_changed), "令牌表变了必须算变化");

        let mut motion = snapshot();
        motion.reduce_motion = true;
        assert!(theme.set(motion), "减少动效变了必须算变化");
    }

    /// 空快照的兜底必须是深色 —— 而且**两条路径都要**。
    ///
    /// 反过来的表现是：插件文档先按浅色渲染一帧，然后被主题注入改暗 ——
    /// 在深色主题下那是一次刺眼的白闪。
    ///
    /// 两条路径都要断言，是因为它们**曾经不一致**：`derive(Default)` 给的是
    /// 空串，而 `#[serde(default = …)]` 给的是 `dark` —— 后者只作用于反序列化。
    /// 也就是说"从空 JSON 反序列化"是对的，而 `ThemeSnapshot::default()`
    /// （`PluginTheme::new()` 用的那个）是错的。这条测试把它钉住了。
    #[test]
    fn an_empty_snapshot_defaults_to_dark_on_both_paths() {
        let constructed = ThemeSnapshot::default();
        assert_eq!(constructed.resolved, "dark", "Default::default() 的兜底");
        assert!(constructed.glass, "毛玻璃缺省是开着的");
        assert!(constructed.to_css().contains("color-scheme: dark;"));

        let parsed: ThemeSnapshot = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.resolved, "dark", "从空 JSON 反序列化的兜底");
        assert!(parsed.glass);
        assert!(parsed.to_css().contains("color-scheme: dark;"));

        // 两者必须完全一致 —— 分开断言只能证明"各自都不为空"，
        // 证明不了"它们说的是同一件事"。
        assert_eq!(constructed.resolved, parsed.resolved);
        assert_eq!(constructed.glass, parsed.glass);
        assert_eq!(constructed.to_css(), parsed.to_css());
    }

    /// 被拒绝的值**整条不写**，而不是写成 `--x: ;`。
    ///
    /// 空声明在 CSS 里会被解析器丢掉，因此"效果一样" —— 但写出来的那一条
    /// 会让读日志的人以为这个令牌存在、只是没有值，而它其实是因为含有危险
    /// 字符被拒了。少一行比多一行误导好。
    #[test]
    fn a_rejected_value_leaves_no_declaration_behind() {
        let mut snapshot = snapshot();
        snapshot.tokens.clear();
        snapshot
            .tokens
            .insert("--bad-name".to_string(), "red; } body { display: none".to_string());
        snapshot.tokens.insert("--good".to_string(), "1px".to_string());
        // 值为空串同样不写：空的自定义属性没有任何意义
        snapshot.tokens.insert("--empty".to_string(), String::new());

        let css = snapshot.to_css();
        assert!(!css.contains("--bad-name"), "被拒绝的令牌不该留下任何痕迹");
        assert!(!css.contains("--empty:"), "空值不该写成一条空声明");
        assert!(css.contains("--good: 1px;"), "干净的令牌必须保留");
    }
}
