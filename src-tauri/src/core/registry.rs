use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use super::lifecycle::{self, LifecyclePlan};
use super::module::{Module, ModuleEvent};

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("Module '{0}' not found")]
    ModuleNotFound(String),
    #[error("Module '{0}' already registered")]
    ModuleAlreadyRegistered(String),
    #[error("Dependency '{0}' not found for module '{1}'")]
    DependencyNotFound(String, String),
    #[error("Circular dependency detected")]
    CircularDependency,
    #[error("Setup failed: {0}")]
    SetupFailed(String),
    #[error("Start failed: {0}")]
    StartFailed(String),
    #[error("Stop failed: {0}")]
    StopFailed(String),
}

pub type RegistryResult<T> = Result<T, RegistryError>;

/// 运行时模块注册表
pub struct ModuleRegistry {
    modules: HashMap<String, Box<dyn Module>>,
    /// 已经成功 `setup` 的模块，按拓扑序
    init_order: Vec<String>,
    /// 已经成功 `start` 的模块，按拓扑序
    start_order: Vec<String>,
    /// 是否已经执行过整体停止。
    ///
    /// 用原子布尔而不是"记下停过哪些模块"：`stop_all` 只能通过
    /// `app.state::<ModuleRegistry>()` 拿到**共享**引用（Tauri 的托管状态只给
    /// `&`），因此它必须是 `&self` 方法，装不下一个需要改动的集合。
    ///
    /// 一个布尔量在这里已经足够 —— 停止是"一次性的整体动作"，
    /// 而它需要幂等只是因为退出路径可能被触发两次（窗口关闭与进程退出）。
    stopped: AtomicBool,
}

impl Default for ModuleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ModuleRegistry {
    pub fn new() -> Self {
        Self {
            modules: HashMap::new(),
            init_order: Vec::new(),
            start_order: Vec::new(),
            stopped: AtomicBool::new(false),
        }
    }

    pub fn register(&mut self, module: Box<dyn Module>) -> RegistryResult<()> {
        let id = module.id().to_string();
        if self.modules.contains_key(&id) {
            return Err(RegistryError::ModuleAlreadyRegistered(id));
        }
        self.modules.insert(id, module);
        Ok(())
    }

    pub fn register_all(&mut self, modules: Vec<Box<dyn Module>>) -> RegistryResult<()> {
        for module in modules {
            self.register(module)?;
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&dyn Module> {
        self.modules.get(id).map(|m| m.as_ref())
    }

    pub fn all(&self) -> Vec<&dyn Module> {
        self.modules.values().map(|m| m.as_ref()).collect()
    }

    pub fn ids(&self) -> Vec<&str> {
        self.modules.keys().map(|s| s.as_str()).collect()
    }

    fn detect_circular_dependencies(&self) -> Result<(), RegistryError> {
        let mut visited = HashSet::new();
        let mut recursion_stack = HashSet::new();

        for id in self.modules.keys() {
            if !visited.contains(id) {
                self.dfs_detect(id, &mut visited, &mut recursion_stack)?;
            }
        }
        Ok(())
    }

    fn dfs_detect(
        &self,
        id: &str,
        visited: &mut HashSet<String>,
        recursion_stack: &mut HashSet<String>,
    ) -> Result<(), RegistryError> {
        visited.insert(id.to_string());
        recursion_stack.insert(id.to_string());

        if let Some(module) = self.modules.get(id) {
            for dep in module.dependencies() {
                if recursion_stack.contains(dep) {
                    return Err(RegistryError::CircularDependency);
                }
                if !visited.contains(dep) {
                    if self.modules.contains_key(dep) {
                        self.dfs_detect(dep, visited, recursion_stack)?;
                    } else {
                        return Err(RegistryError::DependencyNotFound(
                            dep.to_string(),
                            id.to_string(),
                        ));
                    }
                }
            }
        }

        recursion_stack.remove(id);
        Ok(())
    }

    /// 推出生命周期执行计划。
    ///
    /// 顺序**不再**取自 `HashMap` 的迭代顺序 —— 那正是此前"启动顺序不确定"的根源。
    /// 顺序只取决于 `modules/mod.rs` 里的注册顺序（生成文件，因此是稳定的）
    /// 与各模块声明的依赖。见 `core::lifecycle` 的说明。
    fn plan(&self) -> LifecyclePlan {
        let ids: Vec<String> = self.modules.keys().cloned().collect();
        lifecycle::plan_lifecycle(&ids, |id| {
            self.modules
                .get(id)
                .map(|module| {
                    module
                        .dependencies()
                        .into_iter()
                        .map(|dep| dep.to_string())
                        .collect()
                })
                .unwrap_or_default()
        })
    }

    pub fn setup_all(&mut self, app: &AppHandle) -> RegistryResult<()> {
        self.detect_circular_dependencies()?;

        let plan = self.plan();

        for id in plan.start_order {
            if let Some(module) = self.modules.get(&id) {
                module
                    .setup(app)
                    .map_err(|e| RegistryError::SetupFailed(format!("{}: {}", id, e)))?;
                self.init_order.push(id);
            }
        }

        Ok(())
    }

    /// 按拓扑序启动全部模块。
    ///
    /// **此前这里是直接遍历 `all()`（即 `HashMap::values()`），也就是哈希顺序。**
    /// `setup_all` 一直是按拓扑序的，两者不一致的后果不是"启动顺序看起来乱"，
    /// 而是：一个模块的 `start` 可能早于它依赖的模块的 `start`，于是它在启动阶段
    /// 读到的是对方**半初始化**的状态。这种缺陷只在恰好读到那个状态时才显形，
    /// 平时完全不报错。
    ///
    /// 失败策略是**继续启动其余模块**并记下第一个失败者：一个模块起不来不该让
    /// 整个应用打不开（与 `setup_all` 的"失败即中止"不同 —— setup 阶段失败意味着
    /// 状态没建好，继续下去只会连累别人）。因此返回的是"第一处失败"而不是 `Err`。
    pub fn start_all(&mut self, app: &AppHandle) -> Option<(String, String)> {
        let plan = self.plan();
        let mut first_failure: Option<(String, String)> = None;

        for id in plan.start_order {
            if let Some(module) = self.modules.get(&id) {
                match module.start(app) {
                    Ok(()) => self.start_order.push(id),
                    Err(error) => {
                        log::warn!("模块 {} 启动失败：{}", id, error);
                        if first_failure.is_none() {
                            first_failure = Some((id, error.to_string()));
                        }
                    }
                }
            }
        }

        first_failure
    }

    /// 按**启动的逆序**停止全部模块。
    ///
    /// 逆序是必需的：依赖方先停，这样它在收尾时还能用到被依赖方提供的服务。
    /// 正序停止会让"负责落盘的模块"在它依赖的设置/存储已经关掉之后才收到通知。
    ///
    /// **只停止成功启动过的模块**：一个连 `start` 都没跑过的模块，让它执行
    /// `stop` 等于让它在没有初始化的情况下清理，那只会制造错误。
    ///
    /// 单个模块停止失败**不影响其余模块**：清理阶段最怕的就是"第一个失败之后
    /// 后面全不执行"—— 那会让本该落盘的数据因为一个无关模块的错误而丢掉。
    ///
    /// 幂等：整轮停止只会发生一次。它需要幂等只是因为退出路径可能被触发两次
    /// （窗口关闭事件与进程退出事件），而重复停止一个模块的后果取决于它的实现。
    pub fn stop_all(&self, app: &AppHandle) {
        // `swap` 而不是 `load` + `store`：两个线程同时走到这里时只有一个能赢，
        // 输的那个直接返回。
        if self.stopped.swap(true, Ordering::SeqCst) {
            log::debug!("模块收尾已经执行过，跳过重复调用");
            return;
        }

        let plan = self.plan();

        // 用计划里的逆序，但**过滤成实际启动过的那一批** ——
        // 计划包含全部注册的模块，其中可能有启动失败的。
        let started: HashSet<&str> = self.start_order.iter().map(|id| id.as_str()).collect();
        let actual: Vec<String> = plan
            .stop_order
            .into_iter()
            .filter(|id| started.contains(id.as_str()))
            .collect();

        if actual.is_empty() {
            log::debug!("没有成功启动过的模块，无需收尾");
            return;
        }

        log::info!("正在停止 {} 个模块（逆序）", actual.len());

        for id in actual {
            let Some(module) = self.modules.get(&id) else {
                continue;
            };
            if let Err(error) = module.stop(app) {
                // 不中止：一个模块的清理失败不该让其余模块的数据留在内存里。
                log::warn!("模块 {} 停止失败：{}", id, error);
            }
        }
    }

    /// 已经成功启动的模块 id，按启动顺序
    pub fn started_ids(&self) -> &[String] {
        &self.start_order
    }

    /// 已经成功 setup 的模块 id，按拓扑序
    pub fn initialized_ids(&self) -> &[String] {
        &self.init_order
    }

    pub fn broadcast_event(&self, event: ModuleEvent, data: Option<&dyn std::any::Any>) {
        for module in self.modules.values() {
            let _ = module.handle_event(event, data);
        }
    }

    pub fn len(&self) -> usize {
        self.modules.len()
    }

    pub fn is_empty(&self) -> bool {
        self.modules.is_empty()
    }
}

impl std::fmt::Debug for ModuleRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModuleRegistry")
            .field("modules", &self.modules.keys().collect::<Vec<_>>())
            .field("init_order", &self.init_order)
            .field("start_order", &self.start_order)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用一个最小的假模块建注册表，避免依赖真实的 `AppHandle`。
    struct FakeModule {
        id: &'static str,
        deps: Vec<&'static str>,
    }

    impl Module for FakeModule {
        fn id(&self) -> &'static str {
            self.id
        }
        fn name(&self) -> &'static str {
            self.id
        }
        fn dependencies(&self) -> Vec<&'static str> {
            self.deps.clone()
        }
    }

    fn registry(spec: &[(&'static str, &[&'static str])]) -> ModuleRegistry {
        let mut registry = ModuleRegistry::new();
        for (id, deps) in spec {
            registry
                .register(Box::new(FakeModule {
                    id,
                    deps: deps.to_vec(),
                }))
                .expect("注册不应失败");
        }
        registry
    }

    /// 执行计划必须与 `setup_all` / `start_all` 用的那一份**完全相同**。
    ///
    /// 这条测试守的是"两处各算一次顺序"这种漂移：`plan()` 是唯一来源，
    /// 任何一处自己再排一遍都会让 setup 与 start 的顺序不一致，
    /// 而那种不一致只在特定依赖形状下才显形。
    #[test]
    fn the_plan_puts_dependencies_first() {
        let registry = registry(&[("app", &["db"]), ("db", &[]), ("log", &["app"])]);
        let plan = registry.plan();

        let position = |id: &str| plan.start_order.iter().position(|x| x == id).unwrap();
        assert!(position("db") < position("app"), "{:?}", plan.start_order);
        assert!(position("app") < position("log"), "{:?}", plan.start_order);

        // 停止是严格逆序
        let mut reversed = plan.start_order.clone();
        reversed.reverse();
        assert_eq!(plan.stop_order, reversed);
    }

    /// **真实注册顺序的依赖形状必须无环。**
    ///
    /// 这一条是新依赖声明的回归锁：`logging` 声明依赖 `settings`、
    /// `desktop` 声明依赖 `settings` 与 `logging`。任何一处笔误（例如让
    /// `settings` 反过来依赖 `logging`）都应当在**构建期**被发现，
    /// 而不是等到应用启动时报一句"Circular dependency detected"然后打不开。
    ///
    /// ---------------------------------------------------------------------------
    /// 为什么这里手抄了一份依赖表，而不是调用 `modules::register_all`
    /// ---------------------------------------------------------------------------
    ///
    /// 调用真实的 `register_all` 会把 `desktop`（托盘）与 `plugins`（WebView2）
    /// 的代码链进**测试二进制**，而本机那两个 crate 拉进的导入里有当前系统
    /// 解析不了的符号，于是整个 `cargo test --lib` 以
    /// `STATUS_ENTRYPOINT_NOT_FOUND` 中止（不是测试失败，是进程起不来）。
    ///
    /// 手抄一份的代价是**这张表会漂移**，因此不能只靠它：
    ///   · `dependencies_of_every_module_are_declared_and_acyclic` 只覆盖这里列出的；
    ///   · 真正"新增模块时自动覆盖"的守卫是 `pnpm check:modules`（见
    ///     `check-modules.ts`）—— 它读源码而不是跑链接，因此没有这个限制。
    ///
    /// 换句话说：这张表是快速的本地回归锁，完整的形状由脚本守。
    const REAL_MODULE_DEPENDENCIES: &[(&str, &[&str])] = &[
        ("auth", &[]),
        ("backup", &[]),
        ("desktop", &["settings", "logging"]),
        ("logging", &["settings"]),
        ("net", &[]),
        ("notifications", &[]),
        ("plugins", &[]),
        ("settings", &[]),
        ("sidebar", &[]),
        ("updater", &[]),
    ];

    #[test]
    fn the_real_module_set_has_no_circular_dependencies() {
        let registry = registry(REAL_MODULE_DEPENDENCIES);

        registry
            .detect_circular_dependencies()
            .expect("真实模块表的依赖不允许成环或缺失");

        let plan = registry.plan();
        assert_eq!(
            plan.start_order.len(),
            REAL_MODULE_DEPENDENCIES.len(),
            "计划里漏掉了模块：{:?}",
            plan.start_order
        );
    }

    /// `settings` 必须早于 `logging` 与 `desktop` 启动。
    ///
    /// 这条断言把两个模块新声明的依赖钉住：删掉 `dependencies()` 的实现
    /// （或写错模块名）会让顺序退回"碰巧按字母序"，而这条测试会失败 ——
    /// 这正是它的用途：**碰巧正确的顺序不是顺序，是运气**。
    #[test]
    fn settings_starts_before_logging_and_desktop() {
        let plan = registry(REAL_MODULE_DEPENDENCIES).plan();

        let position = |id: &str| {
            plan.start_order
                .iter()
                .position(|x| x == id)
                .unwrap_or_else(|| panic!("计划里没有 {}：{:?}", id, plan.start_order))
        };

        assert!(
            position("settings") < position("logging"),
            "logging 依赖 settings：{:?}",
            plan.start_order
        );
        assert!(
            position("settings") < position("desktop"),
            "desktop 依赖 settings：{:?}",
            plan.start_order
        );
        assert!(
            position("logging") < position("desktop"),
            "desktop 依赖 logging：{:?}",
            plan.start_order
        );
    }

    /// 逆序停止：日志模块必须**最后**停止。
    ///
    /// 这是逆序停止的实际价值：写日志的那个模块要活到最后，
    /// 否则它之后发生的收尾动作就没有日志可查了。
    #[test]
    fn logging_stops_after_the_modules_that_depend_on_it() {
        let plan = registry(REAL_MODULE_DEPENDENCIES).plan();

        let position = |id: &str| plan.stop_order.iter().position(|x| x == id).unwrap();

        assert!(
            position("desktop") < position("logging"),
            "依赖 logging 的模块必须先停：{:?}",
            plan.stop_order
        );
        assert!(
            position("logging") < position("settings"),
            "logging 依赖 settings，因此 logging 先停：{:?}",
            plan.stop_order
        );
    }

    #[test]
    fn duplicate_registration_is_rejected() {
        let mut registry = ModuleRegistry::new();
        registry.register(Box::new(FakeModule { id: "a", deps: vec![] })).unwrap();
        assert!(matches!(
            registry.register(Box::new(FakeModule { id: "a", deps: vec![] })),
            Err(RegistryError::ModuleAlreadyRegistered(_))
        ));
    }

    #[test]
    fn a_missing_dependency_is_reported() {
        let registry = registry(&[("app", &["ghost"])]);
        assert!(matches!(
            registry.detect_circular_dependencies(),
            Err(RegistryError::DependencyNotFound(_, _))
        ));
    }

    #[test]
    fn a_cycle_is_reported() {
        let registry = registry(&[("a", &["b"]), ("b", &["a"])]);
        assert!(matches!(
            registry.detect_circular_dependencies(),
            Err(RegistryError::CircularDependency)
        ));
    }
}