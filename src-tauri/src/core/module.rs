use tauri::AppHandle;
use std::any::Any;

/// 后端模块生命周期事件
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleEvent {
    Loaded,
    Activated,
    Deactivated,
    ConfigUpdated,
}

/// 后端模块接口
pub trait Module: Send + Sync {
    /// 模块 ID
    fn id(&self) -> &'static str;

    /// 模块名称
    fn name(&self) -> &'static str;

    /// 版本号
    fn version(&self) -> &'static str {
        "0.1.0"
    }

    /// 模块描述
    fn description(&self) -> &'static str {
        ""
    }

    /// 依赖的其他模块 ID 列表
    fn dependencies(&self) -> Vec<&'static str> {
        vec![]
    }

    /// 模块初始化
    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let _ = app;
        Ok(())
    }

    /// 模块启动（在 setup 之后调用）
    fn start(&self, _app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    /// 模块停止（在应用关闭前调用）
    fn stop(&self, _app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    /// 处理自定义事件
    fn handle_event(
        &self,
        _event: ModuleEvent,
        _data: Option<&dyn Any>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }
}