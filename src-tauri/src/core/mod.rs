// src-tauri/src/core/mod.rs
pub mod lifecycle;
pub mod module;
pub mod registry;
// 只在 debug 构建里编译：它对用户没有价值，却会在每一次正常的长任务上
// 往日志里写 ERROR。理由见该文件的"为什么是 debug-only"。
#[cfg(debug_assertions)]
pub mod watchdog;
pub mod window;
