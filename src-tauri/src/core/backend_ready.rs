// src-tauri/src/core/backend_ready.rs
//
// 「后端好了没有」这条命令的实现。
//
// ============================================================
// 它为什么不在 lib.rs 里
// ============================================================
//
// 它最初写在 `lib.rs` 的**crate 根**，而那里编译不过：
//
//   error[E0255]: the name `__cmd__backend_ready` is defined multiple times
//   error[E0255]: the name `__tauri_command_name_backend_ready` is defined multiple times
//     --> src\lib.rs:386:14
//      |
//   385 | #[tauri::command]
//      | ----------------- previous definition of the macro `__cmd__backend_ready` here
//   386 | pub async fn backend_ready(...) -> Result<bool, String> {
//      |              -^^^^^^^^^^^^
//      |              `__cmd__backend_ready` reimported here
//
// 这条报错很难看懂，因此把定位过程记下来。三个原因叠在一起：
//
//   1. `#[tauri::command]` 会生成两个 `macro_rules!`，名字分别是
//      `__cmd__<函数名>` 与 `__tauri_command_name_<函数名>`；
//   2. 函数是 `pub` 时，宏还带上 `#[macro_export]` —— 因为"宏要能被
//      `pub use` 出去就得先导出"。而 `#[macro_export]` 的效果是把这个宏放到
//      **crate 根**；
//   3. 函数本身**就在 crate 根**时，宏被导出到根命名空间这件事与它在原地的定义
//      撞在一起，于是 rustc 报"宏命名空间里重复定义"。`__cmd__` 这种名字完全
//      指向不到"导出到根"这件真正的原因上。
//
// 它被最小化验证过：把实现体换成 `Ok(true)`、去掉参数与函数内导入，报错一模一样
// —— 因此与实现无关，纯粹是**位置**问题。放进一个模块（宏模块化后不再往根上撞）
// 就正常了，这也是 Tauri 命令的常规写法。
//
// 实验同时定住了一条推论：`generate_handler!` 必须用**带模块路径**的名字引用它
// （`core::backend_ready::backend_ready`）。只写函数名会再次把它拉回 crate 根的
// 命名空间，同一个错误会以同样的样子回来。

use crate::core::registry::ReadyState;
use crate::core::registry::{BACKEND_READY_COMMAND, BACKEND_READY_EVENT};
use tauri::Manager;

/// 后端是否已经初始化完成（前端启动闸门的第一道判据）。
///
/// 为什么是"查一个已经托管好的原子布尔量"而不是 `try_state::<ModuleRegistry>()`
/// 然后调 `is_ready()`：`setup` 期间 `ModuleRegistry` 还被局部变量 `registry`
/// 持有，`app.manage(registry)` 要到 setup 末尾才发生 —— 而那段时间恰好就是
/// 前端最想问"好了没有"的那段。`ReadyState` 挂在 builder 链上，因此它在这段
/// 窗口里一定拿得到。
///
/// 它的两条路径都不做任何有副作用的事：查一次原子量、或者读一次已托管的状态。
/// 因此前端可以放心地高频轮询它（实际上只会轮询几次，见
/// `src/services/backendReady.ts`）。
///
/// **ACL**：这条命令注册在应用级清单里，因此必须同时出现在三处 ——
/// `build.rs` 的 `AppManifest::commands`、`lib.rs` 的 `generate_handler!`、
/// `capabilities/app-commands.json` 的 `allow-backend-ready`。
/// 少一处的结果是"命令对所有人不可用"，且只会在运行期显形（`pnpm check:acl` 会拦）。
#[tauri::command]
pub async fn backend_ready(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(state) = app.try_state::<ReadyState>() {
        return Ok(state.is_ready());
    }

    // 理论上到不了这里（`ReadyState` 注册在 builder 链上）。真到了，就退回真源：
    // 已经托管了注册表时以它的结论为准，否则如实回答"还没好"——
    // 这个方向是安全的：前端继续等，而不会拿一个未初始化的后端去跑启动流程。
    match app.try_state::<crate::core::registry::ModuleRegistry>() {
        Some(registry) => Ok(registry.is_ready()),
        None => Ok(false),
    }
}

/// 名字由 `core::registry` 提供，因此这两条常量在编译期就被"用过一次"——
/// 漏改其中之一（例如前端改事件名而后端没改）会在构建期就失败，而不是等到
/// 用户装上之后市场或启动闸门悄悄失效。
#[allow(dead_code)]
const FRONTEND_CONTRACT: (&str, &str) = (BACKEND_READY_COMMAND, BACKEND_READY_EVENT);
