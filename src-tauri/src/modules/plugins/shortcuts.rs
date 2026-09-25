// src-tauri/src/modules/plugins/shortcuts.rs
//
// 宿主快捷键表，交给插件界面。
//
// ============================================================
// 要解决的问题
// ============================================================
//
// 沙箱插件的界面跑在**另一个 webview** 里。键盘焦点一旦落进那个 webview，
// keydown 事件就只在**插件自己的文档**里派发 —— 宿主窗口上的监听器什么都收不到。
//
// 结果是：用户在插件界面里按 `Ctrl+K`（宿主的全局搜索）、`Ctrl+W`（关闭标签）、
// `Ctrl+Tab`（切标签），**一点反应都没有**。而同一个按键在宿主界面里是好的。
//
// 这件事无法靠"在宿主窗口上再装一个监听器"解决 —— 事件根本没有到那一层。
// 必须由插件文档那一侧的桥接层接住并转回来。
//
// ============================================================
// 为什么必须把**整张表**注入进去，而不是只给一个"是不是宿主快捷键"的布尔
//
//   1. 桥接层要**自己判断**某个组合该不该转发，而它不能问宿主 ——
//      每一次按键都往返一趟 IPC 是不可接受的（那是每敲一个字一次往返）；
//   2. 插件需要知道**哪些组合被宿主占用了**，才能避免把自己的快捷键绑到
//      同一个组合上（绑了的话，它的处理器永远收不到 —— 因为事件在到达它之前
//      就被桥接层转发走了）。这份表就是它做那个判断的依据；
//   3. 界面要显示提示（"Ctrl+K 搜索"）时不必再问一次。
//
// ============================================================
// 优先级：插件自己的处理器先跑
// ============================================================
//
// 桥接层的监听器挂在**冒泡阶段**（而不是捕获阶段）。插件在元素上注册的处理器
// 冒泡到 window 时已经跑过了；如果它调了 `event.preventDefault()`，桥接层
// 就**不转发**。
//
// 这条是刻意的：一个编辑类插件需要能用 `Ctrl+B` 加粗，而宿主不该把它抢走。
// 挂在捕获阶段的话，宿主永远赢 —— 而那个方向是不可协商的。

use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

/// 一条宿主快捷键。
///
/// 字段与前端 `RegisteredShortcut` 对齐，但**只带桥接层与插件需要的那几个**：
/// `run` 是函数，过不来（也不可能过来），而它本来就不该过来 ——
/// 转发的是"用户按了这个组合"，执行仍然发生在宿主那一侧。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutEntry {
    pub id: String,
    /// 展示用的原始写法（`mod+k`）
    pub combo: String,
    /// 规范化后的组合键。**匹配用这一个** —— 它与宿主注册表里的规范化规则
    /// 必须一致，否则"宿主显示 Ctrl+K、插件按了没反应"。
    pub normalized: String,
    pub description: String,
    /// 是否在输入框 / 可编辑区域里也生效
    #[serde(default)]
    pub allow_in_input: bool,
}

/// 宿主当前的全部快捷键。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutTable {
    #[serde(default)]
    pub entries: Vec<ShortcutEntry>,
}

/// 单条表的长度上限。
///
/// 这张表会被注入**每一个**插件文档，并被推给每一个活着的界面。没有上限的话，
/// 一个注册了几百条快捷键的环境（插件可以贡献快捷键）会让每次注入多出几十 KB，
/// 而这份开销乘在每一个插件界面上。
pub const MAX_ENTRIES: usize = 512;

impl ShortcutTable {
    /// 找出某个规范化组合对应的快捷键。
    ///
    /// 返回的是**第一个**匹配项，与宿主 `handleShortcutEvent` 的"按注册顺序
    /// 取第一个"一致。两边取的不是同一条时，表现是"按了之后执行的是另一个动作"。
    pub fn find(&self, normalized: &str) -> Option<&ShortcutEntry> {
        self.entries
            .iter()
            .find(|entry| entry.normalized == normalized)
    }
}

/// 快捷键表的托管状态。
#[derive(Default)]
pub struct PluginShortcuts(RwLock<Arc<ShortcutTable>>);

impl PluginShortcuts {
    pub fn new() -> Self {
        Self::default()
    }

    /// 换一张表。返回**是否真的变了**。
    ///
    /// 调用方据此决定要不要推给已打开的界面 —— 前端会因为插件注册表变化而
    /// 重推同一张表，而每推一次就是一圈 `eval`。
    pub fn set(&self, table: ShortcutTable) -> bool {
        let mut entries = table.entries;
        if entries.len() > MAX_ENTRIES {
            log::warn!(
                "宿主快捷键表有 {} 条，超过上限 {MAX_ENTRIES}，多出的不注入插件",
                entries.len()
            );
            entries.truncate(MAX_ENTRIES);
        }
        let table = ShortcutTable { entries };

        let mut current = self.0.write().unwrap_or_else(|e| e.into_inner());
        if current.entries == table.entries {
            return false;
        }
        *current = Arc::new(table);
        true
    }

    pub fn get(&self) -> Arc<ShortcutTable> {
        Arc::clone(&self.0.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// 某个规范化组合是不是宿主的快捷键。
    ///
    /// **这是唯一的放行判据**：桥接层转发上来的组合由它复核一遍。
    /// 只信任桥接层的判断等于让插件（它能改自己文档里的任何东西）可以
    /// 触发任意一个"看起来像快捷键"的东西。
    pub fn is_host_combo(&self, normalized: &str) -> bool {
        self.get().find(normalized).is_some()
    }

    /// 给插件读的那一份。
    pub fn describe(&self) -> serde_json::Value {
        let table = self.get();
        serde_json::json!({ "entries": table.entries })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, normalized: &str) -> ShortcutEntry {
        ShortcutEntry {
            id: id.to_string(),
            combo: normalized.to_string(),
            normalized: normalized.to_string(),
            description: String::new(),
            allow_in_input: false,
        }
    }

    fn table(entries: Vec<ShortcutEntry>) -> ShortcutTable {
        ShortcutTable { entries }
    }

    #[test]
    fn a_fresh_table_is_empty_and_lets_nothing_through() {
        let shortcuts = PluginShortcuts::new();
        assert!(shortcuts.get().entries.is_empty());
        assert!(
            !shortcuts.is_host_combo("mod+k"),
            "空表下任何组合都不该被当成宿主快捷键"
        );
    }

    /// `set` 只在真的变了时返回 true —— 它决定要不要推给已打开的界面。
    #[test]
    fn set_reports_whether_anything_changed() {
        let shortcuts = PluginShortcuts::new();
        let original = table(vec![entry("host.search", "mod+k")]);

        assert!(shortcuts.set(original.clone()), "第一次设置必须算变化");
        assert!(!shortcuts.set(original.clone()), "内容一样时不该算变化");

        let mut changed = original.clone();
        changed.entries.push(entry("host.close", "mod+w"));
        assert!(shortcuts.set(changed), "多了一条必须算变化");

        // 顺序变了也算变化：`find` 取的是第一个匹配项，顺序决定谁赢
        let mut reordered = table(vec![entry("host.close", "mod+w"), entry("host.search", "mod+k")]);
        assert!(shortcuts.set(reordered.clone()), "顺序变了必须算变化");
        assert_eq!(
            shortcuts.get().find("mod+w").map(|it| it.id.as_str()),
            Some("host.close"),
            "顺序决定谁被取到"
        );
        let _ = &mut reordered;
    }

    /// 超限时截断，而不是让表无限长下去。
    ///
    /// 这张表会被注入**每一个**插件文档，因此它的长度是一份乘数。
    #[test]
    fn an_oversized_table_is_truncated() {
        let shortcuts = PluginShortcuts::new();
        let huge = table(
            (0..MAX_ENTRIES + 50)
                .map(|index| entry(&format!("host.{index}"), &format!("mod+{index}")))
                .collect(),
        );

        assert!(shortcuts.set(huge));
        assert_eq!(shortcuts.get().entries.len(), MAX_ENTRIES);
        assert!(shortcuts.is_host_combo("mod+0"), "保留下来的那一部分仍然可用");
        assert!(
            !shortcuts.is_host_combo(&format!("mod+{}", MAX_ENTRIES + 10)),
            "被截掉的那部分不该被放行"
        );
    }

    /// `find` 取第一个匹配项。
    ///
    /// 与宿主 `handleShortcutEvent` 的"按注册顺序取第一个"必须一致 ——
    /// 两边取的不是同一条时，表现是"按了之后执行的是另一个动作"。
    #[test]
    fn find_returns_the_first_match() {
        let shortcuts = PluginShortcuts::new();
        shortcuts.set(table(vec![
            entry("first", "mod+k"),
            entry("second", "mod+k"),
        ]));

        assert_eq!(shortcuts.get().find("mod+k").map(|it| it.id.as_str()), Some("first"));
        assert_eq!(shortcuts.get().find("mod+j"), None);
    }

    /// 描述里给出的是**插件的规范化键**，不是原始写法。
    ///
    /// 插件拿它做两件事：匹配（必须与宿主一致）与展示（用 `combo`）。
    /// 少给 `normalized` 会逼插件自己实现一遍规范化 —— 而两份规范化规则
    /// 一定会漂，漂开的表现是"某些组合在插件里按了没反应"。
    #[test]
    fn the_described_table_carries_both_forms() {
        let shortcuts = PluginShortcuts::new();
        shortcuts.set(table(vec![ShortcutEntry {
            id: "host.search".to_string(),
            combo: "mod+k".to_string(),
            normalized: "mod+k".to_string(),
            description: "聚焦全局搜索".to_string(),
            allow_in_input: true,
        }]));

        let described = shortcuts.describe();
        let first = &described["entries"][0];
        assert_eq!(first["combo"], "mod+k");
        assert_eq!(first["normalized"], "mod+k");
        assert_eq!(first["description"], "聚焦全局搜索");
        assert_eq!(first["allowInInput"], true);
    }
}
