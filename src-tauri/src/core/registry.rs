use super::lifecycle::{self, LifecyclePlan};
use super::module::{Module, ModuleEvent};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

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
    /// **注册顺序**的 id 列表。
    ///
    /// 存在的理由：执行计划的输入顺序必须是确定的，而 `modules` 是 `HashMap`
    /// —— 它的迭代顺序由哈希决定，同一份二进制在不同运行里都可能不同。
    ///
    /// 此前这里直接把 `self.modules.keys()` 交给 `lifecycle::plan_lifecycle`，
    /// 于是"顺序只取决于注册顺序"这句注释是假的：没有任何依赖关系的两个模块
    /// 谁先谁后，取决于哈希。它恰好不会造成崩溃（`plan_lifecycle` 保证被依赖者
    /// 在前），但会让启动顺序在不同运行之间漂移 —— 那种现象最难查：日志里
    /// 顺序不一样，却没有一处报错。
    ///
    /// `Module::setup` 读到别的模块写入的资源时，这个顺序就是它的可见性边界，
    /// 因此它必须是确定的、且等于 `modules/mod.rs` 的书写顺序。
    order: Vec<String>,
    /// 已经成功 `setup` 的模块，按拓扑序
    init_order: Vec<String>,
    /// 已经成功 `start` 的模块，按拓扑序
    start_order: Vec<String>,
    /// 全部模块是否已经启动完成（见 [`ModuleRegistry::is_ready`]）
    ready: AtomicBool,
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
            order: Vec::new(),
            init_order: Vec::new(),
            start_order: Vec::new(),
            ready: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        }
    }

    pub fn register(&mut self, module: Box<dyn Module>) -> RegistryResult<()> {
        let id = module.id().to_string();
        if self.modules.contains_key(&id) {
            return Err(RegistryError::ModuleAlreadyRegistered(id));
        }
        self.order.push(id.clone());
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
    /// 顺序取自**注册顺序**（`self.order`），不是 `HashMap` 的迭代顺序 ——
    /// 那正是此前"启动顺序不确定"的根源。注册顺序来自生成文件
    /// `modules/mod.rs`，因此它是稳定的，且与书写顺序一致。
    /// 见 `core::lifecycle` 的说明。
    fn plan(&self) -> LifecyclePlan {
        let ids: Vec<String> = self.order.clone();
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

        // 启动阶段到此结束 —— 这是"后端就绪"的**唯一**判据，见 `is_ready`。
        //
        // 放在这里而不是 setup 之后：`start` 才是模块真正开始工作的地方
        // （启动定时器、拉起后台任务、装载插件列表），setup 只是把状态登记好。
        // 前端闸门等的正是这件事，因此判据必须与"能安全调用命令"对齐。
        //
        // 有模块启动失败时**依然置位**：单个模块起不来不该把用户永久挡在启动
        // 界面之外（`lib.rs` 里对 `start_all` 的失败策略也是"继续启动其余模块"）。
        // 失败已经被记进日志并上报给调用方。
        self.ready.store(true, Ordering::SeqCst);
        log::debug!(
            "后端就绪：{} 个模块已启动{}",
            self.start_order.len(),
            match &first_failure {
                Some((id, _)) => format!("（{} 启动失败）", id),
                None => String::new(),
            }
        );

        first_failure
    }

    /// 模块是否已经全部启动完成。
    ///
    /// ============================================================
    /// 它为什么存在：这是一次真实故障的修复
    /// ============================================================
    ///
    /// 发行版冷启动时，主窗口由 Tauri 在创建阶段就建好并开始加载前端资源，
    /// 而模块状态是在 `setup` 钩子里（`setup_all` → 各模块的 `app.manage(...)`）
    /// 注入的。两者之间**没有任何同步**：打包产物的实测日志显示，webview 已经在
    /// 取嵌入资源时，`SettingsState` / `AuthState` 的注入还分别晚 25ms / 39ms。
    ///
    /// 于是启动流程第二步（`get_auth_status`，关键步骤）必然失败：
    ///
    ///   state not managed for field `state` on command `get_auth_status`.
    ///   You must call `.manage()` before using this command
    ///
    /// 用户只能点「重试初始化」—— 那时 setup 早已跑完，所以一点就过；而下次
    /// 冷启动照旧。开发模式永远看不到，因为 `devUrl` 那一跳（连 Vite、按需
    /// transform 上百个 ESM 模块）比 `setup_all` 的磁盘 IO 慢一个数量级。
    ///
    /// 同一次竞速里还有几个**被 catch 吞掉**的失败：读设置回落成默认值、通知订阅
    /// 悄悄没装上、WebView 内存等级没生效、插件主题快照没推上去。它们不报错，
    /// 只是让启动结果静默地变差 —— 这正是"只修一条命令"不够、必须给出一个
    /// **显式就绪信号**的理由。
    ///
    /// 因此前端在第一个 `invoke` 之前先等这个信号（`backend_ready` 命令 +
    /// `modulith://backend-ready` 事件，见 `src/services/backendReady.ts`）。
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
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
        registry
            .register(Box::new(FakeModule {
                id: "a",
                deps: vec![],
            }))
            .unwrap();
        assert!(matches!(
            registry.register(Box::new(FakeModule {
                id: "a",
                deps: vec![]
            })),
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

    /// 没有依赖关系的模块之间，顺序必须**等于注册顺序**。
    ///
    /// 这条测试钉住的正是那个只在运行期显形的缺陷：此前计划取自
    /// `HashMap::keys()`，于是这一组断言会随哈希漂移。它不会崩，只是让启动顺序
    /// 在不同运行里不一样 —— 而"顺序不一样却没人报错"是最难归因的一类现象。
    #[test]
    fn registration_order_decides_between_unrelated_modules() {
        let registry = registry(&[("zeta", &[]), ("alpha", &[]), ("mid", &[])]);

        assert_eq!(
            registry.plan().start_order,
            vec!["zeta".to_string(), "alpha".to_string(), "mid".to_string()],
            "没有依赖关系时保持注册顺序（不是字母序，也不是哈希序）"
        );
    }

    /// 注册表新建时未就绪；`start_all` 跑完才算就绪。
    ///
    /// 就绪是前端启动闸门的判据，因此它必须**只在启动真的做完之后**置位：
    /// 早置位等于闸门形同虚设（前端照样会撞上未托管的状态）。
    #[test]
    fn a_fresh_registry_is_not_ready() {
        assert!(!ModuleRegistry::new().is_ready());
    }

    #[test]
    fn ready_state_flips_only_when_marked() {
        let state = ReadyState::new();
        assert!(!state.is_ready(), "新建的就绪信号必须是未就绪");
        state.mark_ready();
        assert!(state.is_ready());
    }
}

// ============================================================
// 后端就绪信号（供 `backend_ready` 命令使用）
// ============================================================

/// 后端就绪信号。**仅供 `backend_ready` 命令使用。**
///
/// 它必须能在 `setup` 完成之前就被托管，因此挂在 builder 链上（与
/// `SandboxSurfaces` 同一个理由与同一个位置），而不是在某个模块的 `setup` 里 ——
/// 那恰好就是它要修的那类缺陷。
///
/// 真源是 [`ModuleRegistry::is_ready`]：那一个原子布尔量是"全部模块已启动"的
/// **唯一**判据。这里这一份存在的理由只是：`ModuleRegistry` 在 `setup` 期间还被
/// `registry` 局部变量持有，`app.manage(registry)` 之前前端拿不到它，而前端
/// 恰恰要在这段时间里问"好了没有"。两份状态不一致的代价是前端白等到超时，
/// 因此 `mark_ready` 只在 `start_all` 返回之后被调用一次，且携带的就是 registry
/// 自己的结论。
pub struct ReadyState {
    ready: AtomicBool,
}

impl Default for ReadyState {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadyState {
    pub fn new() -> Self {
        Self {
            ready: AtomicBool::new(false),
        }
    }

    /// 标记为就绪（由 `setup` 钩子在模块全部启动之后调用一次）
    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
}

/// 后端就绪后广播的事件名。
///
/// 与命令 `backend_ready` 是**两条独立的路**，这是刻意的：命令要过 ACL 检查，
/// 也可能因为前端 `invoke` 的时序而失败；事件则是一条主动推送。任何一条到达
/// 都足以放行启动 —— 见 `src/services/backendReady.ts`。
///
/// 命名沿用仓库里既有的 `modulith://` 前缀（`modulith://tray-action`、
/// `modulith://notifications-changed` 等）。
pub const BACKEND_READY_EVENT: &str = "modulith://backend-ready";

/// 后端就绪命令的名字。前端与 ACL 三处清单引用的是同一个字符串。
pub const BACKEND_READY_COMMAND: &str = "backend_ready";
