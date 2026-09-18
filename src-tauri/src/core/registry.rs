use std::collections::{HashMap, HashSet};
use tauri::AppHandle;
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
}

pub type RegistryResult<T> = Result<T, RegistryError>;

/// 运行时模块注册表
pub struct ModuleRegistry {
    modules: HashMap<String, Box<dyn Module>>,
    init_order: Vec<String>,
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

    pub fn setup_all(&mut self, app: &AppHandle) -> RegistryResult<()> {
        self.detect_circular_dependencies()?;

        let sorted = self.topological_sort()?;
        let sorted_ids: Vec<String> = sorted.iter().map(|s| s.to_string()).collect();

        for id in sorted_ids {
            if let Some(module) = self.modules.get(&id) {
                module
                    .setup(app)
                    .map_err(|e| RegistryError::SetupFailed(format!("{}: {}", id, e)))?;
                self.init_order.push(id);
            }
        }

        Ok(())
    }

    fn topological_sort(&self) -> Result<Vec<&str>, RegistryError> {
        let mut visited = HashSet::new();
        let mut result = Vec::new();

        for id in self.modules.keys() {
            if !visited.contains(id) {
                self.dfs_topological(id, &mut visited, &mut result)?;
            }
        }

        Ok(result)
    }

    fn dfs_topological<'a>(
        &'a self,
        id: &'a str,
        visited: &mut HashSet<String>,
        result: &mut Vec<&'a str>,
    ) -> Result<(), RegistryError> {
        visited.insert(id.to_string());

        if let Some(module) = self.modules.get(id) {
            for dep in module.dependencies() {
                if !visited.contains(dep) {
                    if self.modules.contains_key(dep) {
                        self.dfs_topological(dep, visited, result)?;
                    } else {
                        return Err(RegistryError::DependencyNotFound(
                            dep.to_string(),
                            id.to_string(),
                        ));
                    }
                }
            }
        }

        result.push(id);
        Ok(())
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
            .finish()
    }
}