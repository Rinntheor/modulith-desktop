// scripts/generate-backend-module.ts
//
// 后端模块生成器：维护 src-tauri 侧的模块注册样板代码。
//
//   new <id> [name]   创建 src-tauri/src/modules/<id>/{mod.rs,commands.rs}
//   delete <id>       删除模块目录
//   update            仅重新生成 modules/mod.rs 与 lib.rs
//   list              列出所有后端模块及其命令数
//
// modules/mod.rs 与 lib.rs 是自动生成文件，请勿手工编辑 ——
// 任何手改都会在下次 update 时被覆盖。
//
// 注意：模块顺序取自 readdirSync，即字母序；命令顺序取自文件内的出现顺序。

import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  c,
  symbols,
  printTitle,
  printStep,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printPath,
  printKeyValue,
  printDivider,
} from './colors.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== 配置 ====================

const PROJECT_ROOT = join(__dirname, '..');
const BACKEND_MODULES_DIR = join(PROJECT_ROOT, 'src-tauri', 'src', 'modules');
const BACKEND_MODULES_MOD = join(BACKEND_MODULES_DIR, 'mod.rs');
const LIB_RS = join(PROJECT_ROOT, 'src-tauri', 'src', 'lib.rs');

const GENERATED_BY = 'scripts/generate-backend-module.ts';

// ==================== 工具函数 ====================

function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// ==================== 模板 ====================

const MODULE_MOD_TEMPLATE = (moduleId: string, moduleName: string) => `// src-tauri/src/modules/${moduleId}/mod.rs
pub mod commands;

use crate::prelude::*;
use tauri::Manager;

/// ${moduleName} 模块
pub struct ${toPascalCase(moduleId)}Module;

impl Module for ${toPascalCase(moduleId)}Module {
    fn id(&self) -> &'static str {
        "${moduleId}"
    }

    fn name(&self) -> &'static str {
        "${moduleName}"
    }

    fn version(&self) -> &'static str {
        "0.1.0"
    }

    fn description(&self) -> &'static str {
        "${moduleName} 模块"
    }

    fn setup(&self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        // 初始化模块状态
        app.manage(commands::${toPascalCase(moduleId)}State::new());
        Ok(())
    }
}
`;

const COMMANDS_TEMPLATE = (moduleId: string) => `// src-tauri/src/modules/${moduleId}/commands.rs
use crate::prelude::*;
use tauri::State;
use std::sync::Mutex;

/// ${toPascalCase(moduleId)} 模块的全局状态
pub struct ${toPascalCase(moduleId)}State(pub Mutex<()>);

impl ${toPascalCase(moduleId)}State {
    pub fn new() -> Self {
        Self(Mutex::new(()))
    }
}

/// 示例命令
#[tauri::command]
pub fn ${moduleId}_example_command(
    state: State<'_, ${toPascalCase(moduleId)}State>,
) -> Result<String, String> {
    let _lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok("Hello from ${moduleId} module!".to_string())
}
`;

// ==================== 扫描现有模块 ====================

function scanExistingModules(): string[] {
  if (!existsSync(BACKEND_MODULES_DIR)) {
    return [];
  }

  const modules: string[] = [];

  for (const entry of readdirSync(BACKEND_MODULES_DIR)) {
    const modulePath = join(BACKEND_MODULES_DIR, entry);
    if (!statSync(modulePath).isDirectory()) continue;
    if (entry === 'mod.rs') continue;

    if (existsSync(join(modulePath, 'mod.rs'))) {
      modules.push(entry);
    } else {
      printWarning('Skipping directory without mod.rs', entry);
    }
  }

  return modules;
}

// ==================== 提取命令函数 ====================

/**
 * 从 commands.rs 中提取 #[tauri::command] 标注的函数名。
 * 支持 pub / pub(crate) / async 等修饰，保持文件内的出现顺序。
 *
 * **属性可以带参数**（`#[tauri::command(rename_all = "snake_case")]`），因此参数列表
 * 是可选的。这一点曾经是错的：旧正则只认 `#[tauri::command]` 这一种写法，遇到带参形式
 * **匹配不到也不会报错**，命令就这么静默地漏掉，直到运行期 `invoke` 才表现为
 * "command not found"。现在除了放宽正则，还做一次「属性数 = 解析数」的对账，
 * 让任何没预料到的写法在构建期就失败。
 */
function extractCommandFunctions(content: string): string[] {
  const commands: string[] = [];
  const regex =
    /#\[tauri::command(?:\s*\([^)]*\))?\]\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    commands.push(match[1]);
  }

  // 对账：文件里出现了几处 `#[tauri::command`，就应当解析出几个函数名。
  // 只放宽正则而不对账的话，下一次 Rust 语法变化仍会以「少一条命令」的形式安静通过。
  const attributeCount = (content.match(/#\[tauri::command\b/g) ?? []).length;
  if (attributeCount !== commands.length) {
    throw new Error(
      `检测到 ${attributeCount} 处 #[tauri::command 属性，但只解析出 ${commands.length} 个函数名。` +
        `请检查 generate-backend-module.ts 的 extractCommandFunctions 是否支持这种写法 —— ` +
        `漏掉的命令不会被注册，且只有在运行期调用时才会暴露。`
    );
  }

  return commands;
}

// ==================== 生成模块 ====================

function generateBackendModule(moduleId: string, moduleName?: string): void {
  const safeName = moduleName || moduleId;
  const moduleDir = join(BACKEND_MODULES_DIR, moduleId);

  if (!/^[a-z][a-z0-9_]*$/.test(moduleId)) {
    printError('Invalid module ID', `${moduleId} (use snake_case: ^[a-z][a-z0-9_]*$)`);
    process.exit(1);
  }

  if (existsSync(moduleDir)) {
    printError('Module already exists', moduleDir);
    process.exit(1);
  }

  mkdirSync(moduleDir, { recursive: true });

  const modFile = join(moduleDir, 'mod.rs');
  const commandsFile = join(moduleDir, 'commands.rs');

  writeFileSync(modFile, MODULE_MOD_TEMPLATE(moduleId, safeName), 'utf-8');
  writeFileSync(commandsFile, COMMANDS_TEMPLATE(moduleId), 'utf-8');

  printStep('Created module', moduleId);
  printPath('mod.rs', modFile);
  printPath('commands.rs', commandsFile);
}

// ==================== 删除模块 ====================

function deleteBackendModule(moduleId: string): void {
  const moduleDir = join(BACKEND_MODULES_DIR, moduleId);

  if (!existsSync(moduleDir)) {
    printError('Module not found', moduleDir);
    process.exit(1);
  }

  rmSync(moduleDir, { recursive: true, force: true });
  printStep('Deleted module', moduleId);
}

// ==================== 更新 modules/mod.rs ====================

function updateModulesMod(): number {
  const modules = scanExistingModules();

  const modDeclarations = modules.map((id) => `pub mod ${id};`).join('\n');

  const registerCalls = modules
    .map((id) => `    registry.register(Box::new(${id}::${toPascalCase(id)}Module))?;`)
    .join('\n');

  const listItems = modules
    .map((id) => `        ${id}::${toPascalCase(id)}Module.id().to_string(),`)
    .join('\n');

  const content = `// src-tauri/src/modules/mod.rs
// 此文件由 ${GENERATED_BY} 自动生成
// 请勿手动编辑 - DO NOT EDIT MANUALLY
//
// 这里**刻意不写生成时间**：本文件已入库，若写入时间戳，每次生成都会产生
// 差异 —— 表现为「构建一次就把工作区弄脏」，且会让「生成器一致性」的 CI
// 检查（生成后 git diff --exit-code）永远失败。生成是可重复的，
// 需要追溯时间时查 git 历史即可。

${modDeclarations}

use crate::core::registry::ModuleRegistry;
use crate::core::module::Module;

/// 注册所有后端模块
pub fn register_all(registry: &mut ModuleRegistry) -> Result<(), crate::core::registry::RegistryError> {
${registerCalls}
    Ok(())
}

/// 获取所有模块 ID 列表
pub fn list_all_module_ids() -> Vec<String> {
    vec![
${listItems}
    ]
}
`;

  writeFileSync(BACKEND_MODULES_MOD, content, 'utf-8');
  printSuccess('modules/mod.rs', `${modules.length} modules`);

  return modules.length;
}

// ==================== 更新 lib.rs ====================

function updateLibRs(): { moduleCount: number; commandCount: number } {
  const modules = scanExistingModules();

  const useStatements = modules.map((id) => `use modules::${id}::commands::*;`).join('\n');

  const allCommands: string[] = [];
  const commandsByModule: Array<[string, number]> = [];

  for (const id of modules) {
    const commandsFile = join(BACKEND_MODULES_DIR, id, 'commands.rs');
    if (!existsSync(commandsFile)) continue;

    const commands = extractCommandFunctions(readFileSync(commandsFile, 'utf-8'));
    allCommands.push(...commands);
    commandsByModule.push([id, commands.length]);
  }

  const commandList =
    allCommands.length > 0
      ? allCommands.map((cmd) => `        ${cmd},`).join('\n')
      : '        greet,';

  const useStatement =
    modules.length > 0 ? useStatements : '// 默认命令（如果没有模块）';

  const content = `// src-tauri/src/lib.rs
// 此文件由 ${GENERATED_BY} 自动生成
// 请勿手动编辑 - DO NOT EDIT MANUALLY
//
// 同 modules/mod.rs：不写生成时间，保证生成可重复（理由见该文件的注释）。

pub mod prelude;
pub mod core;
pub mod modules;

use core::registry::ModuleRegistry;
use tauri::Manager;

${useStatement}

${modules.length === 0 ? `
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
` : ''}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), tauri::Error> {
    let mut registry = ModuleRegistry::new();

    // 注册所有模块
    if let Err(e) = modules::register_all(&mut registry) {
        eprintln!("[ERROR] Failed to register modules: {:?}", e);
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 应用更新器。
        //
        // endpoints 与 pubkey 不在代码里，而在 tauri.conf.json 的 plugins.updater ——
        // 公钥必须随应用一起发布（它是"这个更新包确实由我们签发"的唯一依据），
        // 放进配置文件才能跟着版本走。
        .plugin(tauri_plugin_updater::Builder::new().build());

    // setup 中初始化模块
    builder = builder.setup(move |app| {
        // 窗口居中兜底。
        //
        // tauri.conf.json 里已经写了 "center": true，正常路径由 Tauri 在创建窗口时完成。
        // 但那条路径对「多显示器 / 缩放比例不一致」的组合并不总是可靠 ——
        // 实际观察到过窗口落在主显示器画面中央偏左的位置。
        // 这里再显式居中一次作为兜底：失败只记警告，绝不影响启动。
        #[cfg(desktop)]
        {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.center() {
                    eprintln!("[WARN] Failed to center main window: {e}");
                }
            }
        }

        let handle = app.handle().clone();

        // 设置所有模块
        if let Err(e) = registry.setup_all(&handle) {
            eprintln!("[ERROR] Module setup failed: {:?}", e);
            return Err(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Module setup failed: {:?}", e),
            )));
        }

        // 启动所有模块
        for module in registry.all() {
            if let Err(e) = module.start(&handle) {
                eprintln!("[WARN] Module {} start failed: {}", module.id(), e);
            }
        }

        app.manage(registry);
        Ok(())
    });

    // 集中注册所有命令
    builder = builder.invoke_handler(tauri::generate_handler![
${commandList}
    ]);

    builder.run(tauri::generate_context!())
}
`;

  writeFileSync(LIB_RS, content, 'utf-8');
  printSuccess('lib.rs', `${allCommands.length} commands from ${modules.length} modules`);

  if (commandsByModule.length > 0) {
    console.log(`  ${c.dim('Per module:')}`);
    for (const [id, count] of commandsByModule) {
      console.log(`    ${c.highlight(id.padEnd(16))} ${c.number(count)}`);
    }
  }

  return { moduleCount: modules.length, commandCount: allCommands.length };
}

// ==================== 帮助 ====================

function printUsage(): void {
  console.log();
  console.log(c.bold('Usage:'));
  console.log(`  ${c.info('pnpm gen:backend new <module-id> [module-name]')}  ${c.dim('Create a new backend module')}`);
  console.log(`  ${c.info('pnpm gen:backend delete <module-id>')}             ${c.dim('Delete a backend module')}`);
  console.log(`  ${c.info('pnpm gen:backend update')}                       ${c.dim('Regenerate modules/mod.rs and lib.rs')}`);
  console.log(`  ${c.info('pnpm gen:backend list')}                         ${c.dim('List all modules and their commands')}`);
  console.log();
  console.log(`  ${c.dim('Note: modules/mod.rs and lib.rs are generated files.')}`);
  console.log();
}

// ==================== 主函数 ====================

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  printTitle('Modulith Desktop · Backend Module Generator');
  console.log();

  switch (command) {
    case 'new': {
      const moduleId = args[1];
      const moduleName = args[2];

      if (!moduleId) {
        printError('Missing module ID');
        printUsage();
        process.exit(1);
      }

      generateBackendModule(moduleId, moduleName);
      console.log();
      printStep('Updating registry files');
      console.log();
      updateModulesMod();
      updateLibRs();
      break;
    }

    case 'delete': {
      const moduleId = args[1];
      if (!moduleId) {
        printError('Missing module ID');
        printUsage();
        process.exit(1);
      }

      deleteBackendModule(moduleId);
      console.log();
      printStep('Updating registry files');
      console.log();
      updateModulesMod();
      updateLibRs();
      break;
    }

    case 'update': {
      updateModulesMod();
      console.log();
      updateLibRs();
      break;
    }

    case 'list': {
      const modules = scanExistingModules();
      if (modules.length === 0) {
        printInfo('No backend modules found');
        break;
      }

      printInfo(`Found ${modules.length} backend module(s)`);
      console.log();

      let totalCommands = 0;
      for (const id of modules) {
        const commandsFile = join(BACKEND_MODULES_DIR, id, 'commands.rs');
        const commands = existsSync(commandsFile)
          ? extractCommandFunctions(readFileSync(commandsFile, 'utf-8'))
          : [];
        totalCommands += commands.length;

        console.log(
          `  ${c.dim(symbols.bullet)} ${c.highlight(id.padEnd(16))} ${c.dim(`${commands.length} command(s)`)}`,
        );
        for (const cmd of commands) {
          console.log(`      ${c.dim(cmd)}`);
        }
      }

      console.log();
      printKeyValue('Total modules', modules.length);
      printKeyValue('Total commands', totalCommands);
      break;
    }

    default: {
      if (command !== undefined) {
        printError('Unknown command', command);
      }
      printUsage();
      if (command !== undefined) process.exit(1);
      return;
    }
  }

  console.log();
  printDivider();
  printSuccess('Done');
  printDivider();
  console.log();
}

// ==================== 执行 ====================

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  generateBackendModule,
  deleteBackendModule,
  updateModulesMod,
  updateLibRs,
  scanExistingModules,
  extractCommandFunctions,
};
