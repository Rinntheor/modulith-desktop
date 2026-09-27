// src-tauri/src/modules/plugins/surfaces.rs
//
// 一个插件可以声明**多个界面**（`contributes.surfaces`），这里是那份声明的解析器。
//
// ============================================================
// 为什么要有"多界面"这件事
// ============================================================
//
// 单界面插件只能表达"一个面板"。而一个中大型插件真实需要的形态是
// **主列表 + 详情**、**编辑器 + 预览**、**设置窗 + 工具窗** —— 它们各有自己的
// 入口脚本、自己的滚动位置、自己的生命周期，不能被压缩进一个页面里的两个 div。
//
// 更实际的一条：沙箱插件是一个**原生子 webview**，它在窗口里只占一块矩形，
// 由宿主摆位。想同时看见两块界面，就必须有两个 webview —— 一个界面里切来切去
// 做不到那件事。
//
// ============================================================
// 为什么 `main` 是必需的，而不是"第一个就是主界面"
// ============================================================
//
// 界面 id 会进入 **webview 标签**（`plugin-<id>#<界面>`），而标签是宿主用来
// 认人的东西（见 `sandbox.rs` 的文件头："标签不是身份，注册表才是"）。
//
// 如果主界面是"清单里第一个"，那么**调整清单里的顺序就会改变标签**。那不会造成
// 安全问题（身份仍来自注册表），但它会让"同一个界面在两次运行里叫两个名字"——
// 而所有关于标签的推理（日志、断言、驻留表）都建立在"名字是稳定的"之上。
//
// 因此规则被收紧成一条没有歧义的：**声明了 `surfaces` 就必须有一个 `id: "main"`**。
// 主界面因此永远是 `plugin-<id>`，次级界面永远是 `plugin-<id>#<名字>`，
// 与声明顺序无关。
//
// ============================================================
// 没有 `surfaces` 的插件
// ============================================================
//
// 退化成**一个隐式的主界面**，入口就是清单里既有的 `main` / `style`。
// 也就是说：已发布的单界面插件一个字都不用改，它们的标签、入口文档、路由与今天
// 逐字节相同。这条兼容性是刻意的 —— 9 个插件的迁移不该被这一步波及。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::background_manifest::is_safe_relative;

/// 主界面的 id。**它是唯一的保留 id**，且次级界面不得占用。
pub const PRIMARY_SURFACE: &str = "main";

/// 主界面 id 的 `String` 形式，给 `unwrap_or_else` 这类地方用。
///
/// 存在的理由只是省掉一串 `.to_string()` —— 但它的位置有意义：**只有这一处**
/// 允许把"缺省界面"写出来。散在各处的 `"main".to_string()` 会在保留名变化时
/// 留下一半旧值，而那一半的症状是"某个界面打开后是空的"。
pub fn primary_surface() -> String {
    PRIMARY_SURFACE.to_string()
}

/// 一个插件最多能声明多少个界面。
///
/// 上限的理由不是内存（界面是按需创建的，声明本身不建任何东西），而是
/// **可理解性**：界面的入口在宿主里会变成可打开的标签，一个声明了 40 个界面的
/// 插件会让标签栏与命令面板变得没法用。16 是一个"足够表达主列表 / 详情 / 编辑器 /
/// 设置 / 预览"这类真实形态，又明显不是"把每个对话框都当成一个界面"的数字。
pub const MAX_SURFACES: usize = 16;

/// 界面 id 的最大长度。与 webview 标签一起出现在日志与断言里，过长会把它淹掉。
const MAX_ID_LEN: usize = 32;

/// 一个界面（插件自己声明的一块 UI）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceDecl {
    /// 界面 id。进入 webview 标签，因此字符集被限制（见 `is_safe_surface_id`）。
    pub id: String,
    /// 用户可见的名字（标签页标题）
    pub name: String,
    /// 入口脚本，相对插件根目录
    pub entry: String,
    /// 这个界面自己的样式表（相对插件根目录），可省
    pub style: Option<String>,
}

impl SurfaceDecl {
    /// 是不是主界面。主界面拿的是不带 `#` 的那条标签。
    pub fn is_primary(&self) -> bool {
        self.id == PRIMARY_SURFACE
    }
}

/// 一个插件声明的全部界面。
///
/// 保证**至少有一个元素**，且**其中有且只有一个主界面** —— 构造出来就成立，
/// 因此下游（`sandbox.rs`、`surface.rs`）不必各自再判一次。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfaceSet {
    surfaces: Vec<SurfaceDecl>,
}

impl SurfaceSet {
    /// 从清单里读出界面集合。
    ///
    /// `main` / `style` 是清单顶层的既有字段；没有 `contributes.surfaces` 时它们
    /// 就是那个唯一的主界面。给了 `surfaces` 时顶层字段**不再参与**（否则会出现
    /// "主界面的入口到底是哪一个"这种两个来源的问题）。
    ///
    /// 返回 `Err` 的理由都是**插件作者必须去改清单**的那些：id 非法、缺主界面、
    /// 重复 id、入口路径越界、数量超限。这些都不该被静默修正 —— 静默修正的方向是
    /// "插件以为某个界面存在，宿主编出来的是另一个"，而那看起来像宿主坏了。
    pub fn parse(
        contributes: Option<&Value>,
        main_entry: &str,
        main_style: Option<&str>,
        display_name: &str,
    ) -> Result<Self, String> {
        let Some(list) = contributes
            .and_then(|value| value.get("surfaces"))
            .filter(|value| value.is_array())
        else {
            // 隐式单界面。入口取清单顶层的 `main`；它是空的时由 `normalize` 补过默认值，
            // 因此这里不必再兜一次。
            return Ok(Self {
                surfaces: vec![SurfaceDecl {
                    id: PRIMARY_SURFACE.to_string(),
                    name: display_name.to_string(),
                    entry: main_entry.to_string(),
                    style: main_style.map(str::to_string),
                }],
            });
        };

        let items = list.as_array().expect("上面已经判过 is_array");

        if items.is_empty() {
            return Err("contributes.surfaces 是空的：要么去掉它，要么声明至少一个界面".to_string());
        }
        if items.len() > MAX_SURFACES {
            return Err(format!(
                "contributes.surfaces 最多 {MAX_SURFACES} 个界面，当前有 {} 个",
                items.len()
            ));
        }

        let mut surfaces = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            surfaces.push(parse_one(item, index, display_name)?);
        }

        // 主界面必须存在。理由见文件头 —— 它是标签稳定性的前提。
        if !surfaces.iter().any(SurfaceDecl::is_primary) {
            return Err(format!(
                "contributes.surfaces 里必须有一个 id 为 \"{PRIMARY_SURFACE}\" 的主界面\
                 （它是插件在侧边栏/标签栏上的那个界面，也是不带 # 的那条 webview 标签）"
            ));
        }

        // 重复 id：两个界面抢同一条 webview 标签。与 `SandboxSurfaces::claim` 里
        // 那条冲突检测是同一件事，只是在更早、信息更全的地方说出来。
        for (index, surface) in surfaces.iter().enumerate() {
            if surfaces[..index].iter().any(|other| other.id == surface.id) {
                return Err(format!("contributes.surfaces 里有重复的 id：{}", surface.id));
            }
        }

        Ok(Self { surfaces })
    }

    /// 全部界面，主界面**不一定在最前** —— 顺序是清单给的。
    pub fn all(&self) -> &[SurfaceDecl] {
        &self.surfaces
    }

    /// 主界面。构造上一定存在。
    pub fn primary(&self) -> &SurfaceDecl {
        self.surfaces
            .iter()
            .find(|surface| surface.is_primary())
            .expect("SurfaceSet 的构造保证主界面存在")
    }

    pub fn get(&self, id: &str) -> Option<&SurfaceDecl> {
        self.surfaces.iter().find(|surface| surface.id == id)
    }

    /// 界面名列表。给 `ui.listSurfaces` 与错误消息用。
    pub fn ids(&self) -> Vec<String> {
        self.surfaces.iter().map(|s| s.id.clone()).collect()
    }
}

/// 解析一条界面声明。
fn parse_one(item: &Value, index: usize, display_name: &str) -> Result<SurfaceDecl, String> {
    let raw_id = item.get("id").and_then(|value| value.as_str()).unwrap_or("");
    let id = raw_id.trim();

    if !is_safe_surface_id(id) {
        return Err(format!(
            "contributes.surfaces[{index}] 的 id {raw_id:?} 不合法：\
             只允许字母、数字、`-`、`_`，长度 1..={MAX_ID_LEN}，且不能是保留名"
        ));
    }

    let entry = item
        .get("entry")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();

    if !is_safe_relative(entry) {
        return Err(format!(
            "contributes.surfaces[{index}]（{id}）的 entry {entry:?} 不合法：\
             必须是插件目录内的相对路径，不能有 `..`、盘符或盘根"
        ));
    }

    let style = item
        .get("style")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(style) = style {
        if !is_safe_relative(style) {
            return Err(format!(
                "contributes.surfaces[{index}]（{id}）的 style {style:?} 不合法：\
                 必须是插件目录内的相对路径"
            ));
        }
    }

    let name = item
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(if id == PRIMARY_SURFACE { display_name } else { id });

    Ok(SurfaceDecl {
        id: id.to_string(),
        name: name.to_string(),
        entry: entry.to_string(),
        style: style.map(str::to_string),
    })
}

/// 界面 id 是否合法。
///
/// **白名单。** 它现在不再进任何"名字"（webview 标签随 iframe 迁移一起没了），
/// 但它仍然要满足两条：能安全地进日志与错误消息，以及**规范化前后一样** ——
/// 否则 `a.b` 与 `a-b` 会被当成两个界面写进注册表，而它们的语义在读者眼里是同一个。
///
/// 因此这里**拒绝**而不是净化：错在清单里，就说在清单里，不要留到运行期。
pub fn is_safe_surface_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return false;
    }

    // `main` 由常量给出；这里额外挡掉两个会被误用的名字：
    //   · `selftest` —— 宿主内置自检面板的伪插件 id，撞上会让自检面板与真插件
    //     抢同一条标签；
    //   · 全数字与 `-` 开头 —— 不是安全问题，只是让日志里 `plugin-a#1` 这种
    //     东西没法一眼看出哪一段是插件、哪一段是界面。代价为零，收益是日志可读。
    if id == super::sandbox::SELFTEST_ID {
        return false;
    }

    let mut chars = id.chars();
    let first = chars.next().expect("上面判过非空");
    if first == '-' || first == '_' || first.is_ascii_digit() {
        return false;
    }

    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_surfaces(value: Value) -> Result<SurfaceSet, String> {
        SurfaceSet::parse(Some(&value), "dist/index.js", Some("dist/index.css"), "我的插件")
    }

    /// 没有 `surfaces` 的清单退化成**一个隐式主界面**，入口与样式取顶层字段。
    ///
    /// 这是兼容性那一条：已发布的单界面插件一个字都不用改。
    #[test]
    fn a_manifest_without_surfaces_gets_one_implicit_primary() {
        let set = SurfaceSet::parse(None, "dist/index.js", Some("dist/index.css"), "我的插件")
            .expect("应当解析出来");

        assert_eq!(set.all().len(), 1);
        assert_eq!(set.primary().id, PRIMARY_SURFACE);
        assert_eq!(set.primary().entry, "dist/index.js");
        assert_eq!(set.primary().style.as_deref(), Some("dist/index.css"));
        assert_eq!(set.primary().name, "我的插件");
        assert!(set.primary().is_primary());
    }

    /// 形状不对（不是数组）时也退化成隐式主界面，而不是报错。
    ///
    /// 理由：`contributes` 是一整块自由形状的 JSON，写错一个字段的类型不该让
    /// **整个插件**不可用。而"没有可用的界面声明"有一个明确的、可用的兜底。
    #[test]
    fn a_malformed_surfaces_key_falls_back_to_the_implicit_primary() {
        let set = parse_surfaces(json!({ "surfaces": "main" })).unwrap();
        assert_eq!(set.all().len(), 1);
        assert_eq!(set.primary().entry, "dist/index.js");
    }

    #[test]
    fn a_declared_surface_set_is_parsed_with_the_primary_first_class() {
        let set = parse_surfaces(json!({
            "surfaces": [
                { "id": "detail", "name": "详情", "entry": "dist/detail.js" },
                { "id": "main", "name": "笔记", "entry": "dist/index.js", "style": "dist/a.css" }
            ]
        }))
        .unwrap();

        assert_eq!(set.ids(), vec!["detail".to_string(), "main".to_string()]);
        // 主界面不在第一个 —— 这正是不用"顺序"定义主界面的理由
        assert_eq!(set.primary().id, "main");
        assert_eq!(set.primary().entry, "dist/index.js");
        assert_eq!(set.primary().style.as_deref(), Some("dist/a.css"));
        assert_eq!(set.get("detail").unwrap().name, "详情");
        assert!(set.get("nope").is_none());
    }

    /// 缺 `id: "main"` 时必须报错，而不是"拿第一个当主界面"。
    #[test]
    fn a_surface_set_without_a_primary_is_rejected() {
        let error = parse_surfaces(json!({
            "surfaces": [
                { "id": "list", "entry": "a.js" },
                { "id": "detail", "entry": "b.js" }
            ]
        }))
        .expect_err("没有 main 时应当报错");

        assert!(error.contains("main"), "错误消息该说清缺哪一个：{error}");
    }

    #[test]
    fn duplicate_surface_ids_are_rejected() {
        let error = parse_surfaces(json!({
            "surfaces": [
                { "id": "main", "entry": "a.js" },
                { "id": "main", "entry": "b.js" }
            ]
        }))
        .expect_err("重复 id 应当报错");
        assert!(error.contains("重复"), "错误消息该说清是重复：{error}");
    }

    #[test]
    fn an_empty_surfaces_array_is_rejected() {
        let error = parse_surfaces(json!({ "surfaces": [] })).expect_err("空数组应当报错");
        assert!(error.contains("空的"), "实际：{error}");
    }

    #[test]
    fn too_many_surfaces_are_rejected() {
        let many: Vec<Value> = (0..MAX_SURFACES + 1)
            .map(|index| {
                let id = if index == 0 {
                    PRIMARY_SURFACE.to_string()
                } else {
                    format!("s{index}")
                };
                json!({ "id": id, "entry": format!("s{index}.js") })
            })
            .collect();

        let error = parse_surfaces(json!({ "surfaces": many })).expect_err("超限应当报错");
        assert!(error.contains(&MAX_SURFACES.to_string()), "实际：{error}");
    }

    /// **id 的白名单是这一节最重要的断言。**
    ///
    /// 它进 webview 标签，而标签的冲突表现是"两个界面互相覆盖"。
    ///
    /// 注意 `main-detail` 与 `main_detail` **不在**这张表里：它们是合法的，
    /// 而那正是 `main.detail` 必须被拒的理由 —— 净化会把前者变成后者的形状。
    /// 下面 `ordinary_surface_ids_are_accepted` 会正面断言这一点，两条一起
    /// 才排除"全部拒绝也能过"。
    #[test]
    fn surface_ids_that_would_collide_after_sanitizing_are_rejected() {
        for hostile in [
            "",
            "   ",
            "main.detail", // 净化后会变成 main-detail，与那个合法 id 撞
            "a b",
            "a/b",
            "a\\b",
            "a#b", // `#` 是标签里分隔界面名的那个字符
            "详情",
            "-lead",
            "_lead",
            "1st",
            "selftest",
            &"a".repeat(MAX_ID_LEN + 1),
        ] {
            let outcome = parse_surfaces(json!({
                "surfaces": [
                    { "id": "main", "entry": "a.js" },
                    { "id": hostile, "entry": "b.js" }
                ]
            }));
            assert!(
                outcome.is_err(),
                "这个界面 id 不该被接受：{hostile:?}（实际解析成功了）"
            );
        }
    }

    /// 合法 id 必须真的被接受 —— 否则上面那条测试可以靠"全部拒绝"通过。
    #[test]
    fn ordinary_surface_ids_are_accepted() {
        for good in ["detail", "main-detail", "main_detail", "a1", "preview2"] {
            assert!(is_safe_surface_id(good), "这个 id 应当被接受：{good:?}");
        }
        assert!(!is_safe_surface_id(""));

        let set = parse_surfaces(json!({
            "surfaces": [
                { "id": "main", "entry": "a.js" },
                { "id": "main-detail", "entry": "b.js" }
            ]
        }))
        .expect("两个合法 id 应当解析出来");
        assert_eq!(set.all().len(), 2);
    }

    /// 入口路径的越界必须在**解析时**就被拒绝。
    ///
    /// 这一条与 `background_manifest` 里那条同源：入口会被拼到插件根目录后面
    /// 再交给资源服务，一条 `../../` 会读到插件包之外的文件。
    #[test]
    fn entries_that_leave_the_plugin_directory_are_rejected() {
        for hostile in ["../a.js", "/etc/passwd", "C:\\a.js", "", "a//b.js", "a:b.js"] {
            let outcome = parse_surfaces(json!({
                "surfaces": [{ "id": "main", "entry": hostile }]
            }));
            assert!(outcome.is_err(), "这个 entry 不该被接受：{hostile:?}");
        }

        let outcome = parse_surfaces(json!({
            "surfaces": [{ "id": "main", "entry": "a.js", "style": "../x.css" }]
        }));
        assert!(outcome.is_err(), "越界的 style 同样该被拒绝");
    }

    /// 名字缺省时的取值：主界面用插件显示名，次级界面用 id。
    #[test]
    fn a_missing_name_falls_back_to_something_readable() {
        let set = parse_surfaces(json!({
            "surfaces": [
                { "id": "main", "entry": "a.js" },
                { "id": "detail", "entry": "b.js" }
            ]
        }))
        .unwrap();

        assert_eq!(set.primary().name, "我的插件");
        assert_eq!(set.get("detail").unwrap().name, "detail");
    }

    /// 显式声明了 `surfaces` 时，**顶层 `main` 不再参与**。
    ///
    /// 两个来源会漂，而漂开的方向是"清单里写着 a.js、实际加载的是 b.js"。
    #[test]
    fn the_top_level_main_is_ignored_once_surfaces_are_declared() {
        let set = parse_surfaces(json!({
            "surfaces": [{ "id": "main", "entry": "dist/other.js" }]
        }))
        .unwrap();
        assert_eq!(set.primary().entry, "dist/other.js");
        assert_ne!(set.primary().entry, "dist/index.js");
    }
}
