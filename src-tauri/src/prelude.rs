// 公共导入，方便各个模块使用
pub use crate::core::module::Module;
pub use crate::core::registry::ModuleRegistry;
pub use tauri::AppHandle;
pub use tauri::Manager;
pub use serde::{Deserialize, Serialize};
pub use anyhow::Result;