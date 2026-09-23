// src-tauri/src/core/lifecycle.rs
//
// 模块生命周期的**执行计划**：谁先启动、谁后停止。
//
// ============================================================
// 为什么把"顺序"单独抽出来
// ============================================================
//
// 生命周期里最容易错、也最难在运行期发现的就是**顺序**：
//
//   · `start` 早于它依赖的模块 -> 那个模块自己的 setup 已经跑过（`setup_all`
//     一直是按拓扑序的），但它的 `start` 可能还没做 —— 于是依赖方读到的是
//     半初始化的状态。这种缺陷只在"某个模块的 start 恰好做了别处依赖的事"
//     的时候才显形，平时完全不报错。
//   · `stop` 不是 `start` 的逆序 -> 依赖方比被依赖方先死，或者更糟：
//     一个负责落盘的模块在它依赖的存储/设置已经关掉之后才收到停止通知。
//
// 而这两个顺序此前都没有被验证过：`setup_all` 按拓扑序（`dfs_topological`），
// 但 `start` 是直接遍历 `HashMap::values()` 的 —— 也就是**哈希顺序**；
// `stop` 则从来没有被调用过。
//
// 把它们抽成纯函数（输入是 id 与依赖表，输出是两个有序列表）之后，
// 顺序可以被直接断言，而不必启动一个应用。
//
// ============================================================
// 为什么失败要分成"可定位"与"不可定位"两种
// ============================================================
//
// `setup_all` / `start_all` 需要把"第几个模块失败了"回报给调用方。
// 直接返回 `Vec<&str>` 的话，调用方只知道失败了，不知道是哪一个 ——
// 而"模块启动失败，但不知道是谁"这条信息在排查时几乎没用。
// 因此计划里同时给出**执行顺序**与**每个位置对应的 id**。

/// 一个模块在执行计划里的位置与身份
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedStep {
    pub id: String,
}

/// 一份执行计划
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecyclePlan {
    /// 启动顺序：被依赖的在前
    pub start_order: Vec<String>,
    /// 停止顺序：**启动顺序的严格逆序**，即依赖方先停
    pub stop_order: Vec<String>,
}

/// 由 id 与依赖表推出执行计划。
///
/// 输入刻意是**数据**而不是 `&ModuleRegistry`：那样这个函数可以被直接测试，
/// 也让它与"模块是怎么存起来的"（`HashMap`）解耦 —— 后者正是原先顺序不确定的
/// 根源，而把顺序寄托在容器的迭代顺序上本身就是错的。
///
/// `dependencies_of` 返回某个 id 的依赖列表。不在表里的依赖**被忽略**而不是报错：
/// 合法性校验（循环依赖、缺失依赖）是 `detect_circular_dependencies` 的职责，
/// 那里能给出更准确的错误；这里只负责"给定一张合法的图，排出顺序"。
pub fn plan_lifecycle(
    ids: &[String],
    dependencies_of: impl Fn(&str) -> Vec<String>,
) -> LifecyclePlan {
    let known: std::collections::HashSet<&str> = ids.iter().map(|id| id.as_str()).collect();

    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut ordered: Vec<String> = Vec::new();

    // 迭代式 DFS 的后序收集。
    //
    // 用显式栈而不是递归：依赖链的深度由模块数量决定，而"某个模块声明了一条
    // 很长的依赖链"是完全合法且不可控的输入 —— 递归会让它变成栈溢出。
    //
    // 顺序的确定性来自"按输入顺序遍历起点 + 每个节点的依赖也按声明顺序遍历"，
    // 而不是哈希顺序。这正是这个函数存在的理由。
    for root in ids {
        if visited.contains(root) {
            continue;
        }

        // 栈里放 (id, 是否已展开依赖)
        let mut stack: Vec<(String, bool)> = vec![(root.clone(), false)];

        while let Some((id, expanded)) = stack.pop() {
            if expanded {
                // 后序：依赖都已经进 `ordered` 了，现在轮到它
                if visited.insert(id.clone()) {
                    ordered.push(id);
                }
                continue;
            }

            if visited.contains(&id) {
                continue;
            }

            stack.push((id.clone(), true));

            // 依赖**逆序**入栈，这样出栈时按声明顺序处理 ——
            // 让结果只取决于输入的书写顺序，不取决于栈的实现细节。
            let mut deps: Vec<String> = dependencies_of(&id)
                .into_iter()
                .filter(|dep| known.contains(dep.as_str()) && dep != &id)
                .collect();
            deps.reverse();

            for dep in deps {
                if !visited.contains(&dep) {
                    stack.push((dep, false));
                }
            }
        }
    }

    let stop_order = ordered.iter().rev().cloned().collect();
    LifecyclePlan {
        start_order: ordered,
        stop_order,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 由 `(id, 依赖...)` 构造测试输入
    fn plan(spec: &[(&str, &[&str])]) -> LifecyclePlan {
        let ids: Vec<String> = spec.iter().map(|(id, _)| id.to_string()).collect();
        let table: std::collections::HashMap<String, Vec<String>> = spec
            .iter()
            .map(|(id, deps)| {
                (
                    id.to_string(),
                    deps.iter().map(|dep| dep.to_string()).collect(),
                )
            })
            .collect();
        plan_lifecycle(&ids, |id| table.get(id).cloned().unwrap_or_default())
    }

    #[test]
    fn a_module_starts_after_its_dependencies() {
        let result = plan(&[("app", &["db"]), ("db", &[])]);
        let position = |id: &str| result.start_order.iter().position(|x| x == id).unwrap();

        assert!(
            position("db") < position("app"),
            "被依赖的必须先启动：{:?}",
            result.start_order
        );
    }

    #[test]
    fn a_module_stops_before_its_dependencies() {
        // 停止顺序是启动顺序的严格逆序：依赖方先停，
        // 这样它在收尾时还能用到被依赖方提供的服务。
        let result = plan(&[("app", &["db"]), ("db", &[])]);
        let position = |id: &str| result.stop_order.iter().position(|x| x == id).unwrap();

        assert!(
            position("app") < position("db"),
            "依赖方必须先停止：{:?}",
            result.stop_order
        );
    }

    #[test]
    fn stop_order_is_the_exact_reverse_of_start_order() {
        let result = plan(&[("a", &[]), ("b", &["a"]), ("c", &["b"])]);
        let mut reversed = result.start_order.clone();
        reversed.reverse();
        assert_eq!(result.stop_order, reversed);
    }

    /// 顺序必须只取决于**输入顺序**，不取决于任何哈希容器的迭代顺序。
    ///
    /// 这是这个模块存在的核心理由：原实现遍历 `HashMap::values()`，
    /// 于是同一份代码在不同运行里可能给出不同的启动顺序。
    #[test]
    fn order_depends_only_on_the_input_order() {
        let first = plan(&[("alpha", &[]), ("beta", &[]), ("gamma", &[])]);
        let second = plan(&[("alpha", &[]), ("beta", &[]), ("gamma", &[])]);

        assert_eq!(first.start_order, second.start_order);
        assert_eq!(
            first.start_order,
            vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()],
            "没有依赖关系时保持输入顺序"
        );
    }

    /// 多个依赖时也按**声明顺序**处理，而不是某个集合的顺序。
    #[test]
    fn multiple_dependencies_follow_declaration_order() {
        let result = plan(&[("app", &["second", "first"]), ("first", &[]), ("second", &[])]);
        let position = |id: &str| result.start_order.iter().position(|x| x == id).unwrap();

        assert!(position("second") < position("app"));
        assert!(position("first") < position("app"));
        // 两个依赖之间的相对顺序跟随声明顺序
        assert!(
            position("second") < position("first"),
            "依赖之间按声明顺序排列：{:?}",
            result.start_order
        );
    }

    /// 菱形依赖：两侧共享同一个被依赖方，它只能出现一次、且在所有依赖方之前。
    #[test]
    fn shared_dependency_appears_exactly_once_and_first() {
        let result = plan(&[("top", &["left", "right"]), ("left", &["base"]), ("right", &["base"]), ("base", &[])]);

        assert_eq!(
            result.start_order.iter().filter(|id| *id == "base").count(),
            1,
            "共享依赖不能重复启动"
        );
        let position = |id: &str| result.start_order.iter().position(|x| x == id).unwrap();
        assert!(position("base") < position("left"));
        assert!(position("base") < position("right"));
        assert!(position("left") < position("top"));
        assert!(position("right") < position("top"));
    }

    /// 指向未知模块的依赖被忽略，而不是让计划失败。
    ///
    /// 合法性由 `detect_circular_dependencies` 负责（它能给出更准确的错误）；
    /// 这里多报一次错只会让同一条问题有两处输出。
    #[test]
    fn unknown_dependencies_are_ignored() {
        let result = plan(&[("app", &["missing"])]);
        assert_eq!(result.start_order, vec!["app".to_string()]);
    }

    /// 自依赖不应造成死循环或重复条目。
    #[test]
    fn self_dependency_is_ignored() {
        let result = plan(&[("app", &["app"])]);
        assert_eq!(result.start_order, vec!["app".to_string()]);
    }

    /// 深链不能爆栈。
    ///
    /// 依赖链的深度由模块数量决定，而"某个模块声明了一条很长的依赖链"是合法输入。
    /// 递归实现会让它变成栈溢出 —— 而栈溢出在应用启动时表现为"闪退且没有日志"。
    #[test]
    fn a_very_deep_chain_does_not_overflow_the_stack() {
        let depth = 5000;
        let ids: Vec<String> = (0..depth).map(|i| format!("m{i}")).collect();
        let table: std::collections::HashMap<String, Vec<String>> = (0..depth)
            .map(|i| {
                let deps = if i == 0 {
                    vec![]
                } else {
                    vec![format!("m{}", i - 1)]
                };
                (format!("m{i}"), deps)
            })
            .collect();

        let result = plan_lifecycle(&ids, |id| table.get(id).cloned().unwrap_or_default());

        assert_eq!(result.start_order.len(), depth);
        // 第一个必须是最底层的依赖
        assert_eq!(result.start_order[0], "m0");
        assert_eq!(result.start_order[depth - 1], format!("m{}", depth - 1));
    }

    /// 全部模块都要出现在两个顺序里，一个不多一个不少。
    #[test]
    fn every_module_appears_in_both_orders() {
        let result = plan(&[("a", &[]), ("b", &["a"]), ("c", &[])]);

        let mut start = result.start_order.clone();
        let mut stop = result.stop_order.clone();
        start.sort();
        stop.sort();

        assert_eq!(start, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
        assert_eq!(start, stop, "两个顺序必须包含同一批模块");
    }

    #[test]
    fn an_empty_registry_yields_empty_plans() {
        let result = plan(&[]);
        assert!(result.start_order.is_empty());
        assert!(result.stop_order.is_empty());
    }
}
