// scripts/generate-modules.ts
//
// 扫描 src/modules/*/module.toml，生成前端模块注册表。
//
// 输出（均位于 src/generated/）：
//   moduleRegistry.ts              —— 模块描述符 + lazy 组件引用
//   iconMap.ts                     —— 按需导入的 lucide 图标
//   moduleRegistry.sourceMap.json  —— 模块 ID 与源文件的映射
//   generation.log.json            —— 本次生成的统计与告警
//
// 注意：生成文件的「内容格式」是对外契约，改动会影响 git diff，
// 因此本文件只调整终端输出样式，不改变生成的代码结构。

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import type { ModuleToml, ModuleTomlChild } from '../src/types/module.ts';
import {
  c,
  symbols,
  printTitle,
  printStep,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printDivider,
} from './colors.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== 配置 ====================

const MODULES_DIR = join(__dirname, '..', 'src', 'modules');
const OUTPUT_DIR = join(__dirname, '..', 'src', 'generated');
const REGISTRY_FILE = join(OUTPUT_DIR, 'moduleRegistry.ts');
const ICON_MAP_FILE = join(OUTPUT_DIR, 'iconMap.ts');
const SOURCE_MAP_FILE = join(OUTPUT_DIR, 'moduleRegistry.sourceMap.json');
const DEBUG_LOG_FILE = join(OUTPUT_DIR, 'generation.log.json');

/**
 * lucide-react 图标白名单。
 * 仅用于生成阶段的「拼写检查」告警，不限制实际可用图标；
 * 若引用了未列出的图标，只会打印告警而不会中断构建。
 */
const LUCIDE_ICONS = new Set([
  'LayoutDashboard', 'Code2', 'Database', 'GitBranch', 'Shield',
  'Activity', 'Settings', 'Plug', 'Palette', 'Settings2', 'Info',
  'FolderPlus', 'FolderOpen', 'Clock', 'DollarSign', 'BarChart3',
  'Wallet', 'Receipt', 'PanelLeft', 'PanelLeftClose', 'ChevronDown',
  'FolderTree', 'Copy', 'Download', 'RefreshCw', 'File', 'Folder',
  'ChevronRight', 'Filter', 'FileText', 'FileJson', 'FileCode',
  'X', 'Plus', 'Wrench', 'Package',
]);

// ==================== 类型定义 ====================

interface CollectedModule {
  folderName: string;
  folderPath: string;
  config: ModuleToml;
  hasComponentFile: boolean;
  tomlPath: string;
  componentPath: string;
}

interface ModuleSourceMap {
  moduleId: string;
  tomlPath: string;
  componentPath: string;
  generatedAt: string;
  hash: string;
}

interface GenerationLog {
  timestamp: string;
  modulesScanned: number;
  modulesValid: number;
  errors: string[];
  warnings: string[];
  sourceMap: ModuleSourceMap[];
}

// ==================== 工具函数 ====================

function toRelativeImportPath(absPath: string): string {
  const relativePath = relative(OUTPUT_DIR, absPath);
  return './' + relativePath.split(sep).join('/');
}

function escapeString(str: string): string {
  return JSON.stringify(str);
}

/**
 * 生成一个懒加载组件表达式。
 *
 * 注意函数名是 `lazy`，与文件头部生成的
 * `import { createLazyComponent as lazy } from '../utils/lazyLoad'` 对应 ——
 * 两者是同一个契约的两半：改这里的名字必须同时改导入别名，否则生成的
 * `moduleRegistry.ts` 会引用一个不存在的标识符。
 *
 * 产出的代码文本会影响 git diff，因此模板字符串形式保持不变。
 */
function lazyExpression(importPath: string): string {
  return `lazy(() => import('${importPath}'))`;
}

function calculateFileHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

// ==================== 扫描模块 ====================

function scanModules(): CollectedModule[] {
  printStep('Scanning modules', toPosix(relative(process.cwd(), MODULES_DIR)));
  console.log();

  if (!existsSync(MODULES_DIR)) {
    printError('Modules directory not found', MODULES_DIR);
    process.exit(1);
  }

  const entries = readdirSync(MODULES_DIR);
  const modules: CollectedModule[] = [];

  for (const entry of entries) {
    const folderPath = join(MODULES_DIR, entry);

    if (!statSync(folderPath).isDirectory()) continue;

    const tomlPath = join(folderPath, 'module.toml');
    if (!existsSync(tomlPath)) {
      printWarning('Skipping module', `${entry} (no module.toml)`);
      continue;
    }

    try {
      const rawToml = readFileSync(tomlPath, 'utf-8');
      const config = parse(rawToml) as unknown as ModuleToml;

      const componentPath = join(folderPath, config.module.component);
      const hasComponentFile = existsSync(componentPath);

      modules.push({
        folderName: entry,
        folderPath,
        config,
        hasComponentFile,
        tomlPath,
        componentPath,
      });

      const status = hasComponentFile ? c.success('ready') : c.warning('missing component');
      console.log(
        `  ${c.dim(symbols.bullet)} ${c.highlight(config.module.id)} ${c.dim(symbols.arrow)} ${config.module.name} ${c.dim(`(${status})`)}`,
      );

      if (!hasComponentFile) {
        console.log(`      ${c.dim(`component not found: ${config.module.component}`)}`);
      }
    } catch (err) {
      printError('Failed to parse', tomlPath);
      console.log(`    ${c.dim(String(err))}`);
    }
  }

  console.log();
  printInfo(`Found ${modules.length} module(s)`);
  console.log();

  return modules;
}

// ==================== 校验模块 ====================

function validateModules(modules: CollectedModule[]): { errors: string[]; warnings: string[] } {
  printStep('Validating modules');
  console.log();

  const ids = new Map<string, string>();
  const paths = new Map<string, string>();
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const mod of modules) {
    const m = mod.config.module;

    if (!m.id || !m.name || !m.icon || !m.path || !m.component) {
      const error = `Module in "${mod.folderName}": missing required fields (id, name, icon, path, component)`;
      printError('Missing required fields', mod.folderName);
      errors.push(error);
      continue;
    }

    if (ids.has(m.id)) {
      const error = `Duplicate module ID "${m.id}": found in "${ids.get(m.id)}" and "${mod.folderName}"`;
      printError('Duplicate module ID', `${m.id} (${ids.get(m.id)} vs ${mod.folderName})`);
      errors.push(error);
    } else {
      ids.set(m.id, mod.folderName);
    }

    if (paths.has(m.path)) {
      const error = `Duplicate path "${m.path}": used by "${ids.get(paths.get(m.path)!)}" and "${m.id}"`;
      printError('Duplicate path', `${m.path} (${paths.get(m.path)} vs ${m.id})`);
      errors.push(error);
    } else {
      paths.set(m.path, m.id);
    }

    if (!LUCIDE_ICONS.has(m.icon)) {
      const warning = `Module "${m.id}": icon "${m.icon}" not found in lucide-react icons list`;
      printWarning('Icon not in known list', `${m.id}: ${m.icon}`);
      warnings.push(warning);
    }

    if (mod.config.children) {
      for (const child of mod.config.children) {
        const childFullId = `${m.id}/${child.id}`;

        if (ids.has(childFullId)) {
          const error = `Duplicate sub-module ID "${childFullId}"`;
          printError('Duplicate sub-module ID', childFullId);
          errors.push(error);
        } else {
          ids.set(childFullId, mod.folderName);
        }

        const childPath = child.path || `${m.path}/${child.id}`;
        if (paths.has(childPath)) {
          const error = `Duplicate path "${childPath}"`;
          printError('Duplicate path', childPath);
          errors.push(error);
        } else {
          paths.set(childPath, childFullId);
        }

        if (child.icon && !LUCIDE_ICONS.has(child.icon)) {
          const warning = `Sub-module "${childFullId}": icon "${child.icon}" not found in lucide-react icons list`;
          printWarning('Icon not in known list', `${childFullId}: ${child.icon}`);
          warnings.push(warning);
        }
      }
    }
  }

  if (errors.length > 0) {
    console.log();
    printError('Validation failed', 'Please fix the errors above');
    process.exit(1);
  }

  printSuccess('All modules validated', `${modules.length} modules, ${warnings.length} warnings`);
  console.log();

  return { errors, warnings };
}

// ==================== 代码生成：moduleRegistry.ts ====================

function generateRegistry(modules: CollectedModule[]): ModuleSourceMap[] {
  printStep('Generating module registry');
  console.log();

  const sortedModules = [...modules].sort((a, b) => {
    const pa = a.config.module.priority ?? 999;
    const pb = b.config.module.priority ?? 999;
    return pa - pb;
  });

  const sourceMap: ModuleSourceMap[] = [];

  const moduleEntries = sortedModules.map((mod) => {
    const m = mod.config.module;

    const componentPath = join(mod.folderPath, m.component);
    const importPath = toRelativeImportPath(componentPath);

    sourceMap.push({
      moduleId: m.id,
      tomlPath: toPosix(relative(process.cwd(), mod.tomlPath)),
      componentPath: toPosix(relative(process.cwd(), componentPath)),
      generatedAt: new Date().toISOString(),
      hash: calculateFileHash(readFileSync(mod.tomlPath, 'utf-8')),
    });

    let childrenStr = 'undefined';
    if (mod.config.children && mod.config.children.length > 0) {
      const childEntries = mod.config.children.map((child: ModuleTomlChild) => {
        const childComponentPath = join(mod.folderPath, child.component);
        const childImportPath = toRelativeImportPath(childComponentPath);

        return [
          `        {`,
          `          id: ${escapeString(`${m.id}/${child.id}`)},`,
          `          name: ${escapeString(child.name)},`,
          `          description: ${escapeString(child.description)},`,
          child.icon ? `          icon: ${escapeString(child.icon)},` : '',
          `          path: ${escapeString(child.path)},`,
          child.badge ? `          badge: ${escapeString(child.badge)},` : '',
          `          disabled: ${child.disabled === true},`,
          `          component: ${lazyExpression(childImportPath)},`,
          `        },`,
        ].filter((line) => line !== '').join('\n');
      });

      childrenStr = `[\n${childEntries.join('\n')}\n      ]`;
    }

    return [
      `    {`,
      `      id: ${escapeString(m.id)},`,
      `      name: ${escapeString(m.name)},`,
      `      description: ${escapeString(m.description)},`,
      `      icon: ${escapeString(m.icon)},`,
      `      path: ${escapeString(m.path)},`,
      `      priority: ${m.priority ?? 999},`,
      m.category ? `      category: ${escapeString(m.category)},` : '',
      `      visible: ${m.visible !== false},`,
      `      disabled: ${m.disabled === true},`,
      m.badge ? `      badge: ${escapeString(m.badge)},` : '',
      `      component: ${lazyExpression(importPath)},`,
      `      children: ${childrenStr},`,
      `    },`,
    ].filter((line) => line !== '').join('\n');
  });

  const fileContent = `// ============================================================
// 此文件由 scripts/generate-modules.ts 自动生成
// 请勿手动编辑 - DO NOT EDIT MANUALLY
// 生成时间：${new Date().toISOString()}
// 源文件映射：moduleRegistry.sourceMap.json
// ============================================================

import { createLazyComponent as lazy } from '../utils/lazyLoad';
import type { ModuleDescriptor } from '../types/module';

/**
 * 获取所有模块的注册表（已按 priority 排序）
 */
export function getModuleRegistry(): ModuleDescriptor[] {
  return [
${moduleEntries.join('\n')}
  ] as ModuleDescriptor[];
}

/**
 * 获取扁平化的模块映射表（包含子模块）
 * key: 模块 ID（一级模块直接用 id，子模块用 "parentId/childId"）
 */
export function getFlatModuleMap(): Map<string, ModuleDescriptor> {
  const registry = getModuleRegistry();
  const map = new Map<string, ModuleDescriptor>();
  
  for (const mod of registry) {
    map.set(mod.id, mod);
    
    if (mod.children) {
      for (const child of mod.children) {
        map.set(child.id, {
          ...child,
          children: undefined,
        } as ModuleDescriptor);
      }
    }
  }
  
  return map;
}

/**
 * 获取按 category 分组的模块列表
 */
export function getGroupedModules(): Map<string, ModuleDescriptor[]> {
  const registry = getModuleRegistry();
  const map = new Map<string, ModuleDescriptor[]>();
  
  for (const mod of registry) {
    if (!mod.visible) continue;
    
    const category = mod.category || 'default';
    if (!map.has(category)) {
      map.set(category, []);
    }
    map.get(category)!.push(mod);
  }
  
  return map;
}
`;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, fileContent, 'utf-8');

  printSuccess('Generated', toPosix(relative(process.cwd(), REGISTRY_FILE)));
  console.log();

  return sourceMap;
}

// ==================== 代码生成：iconMap.ts ====================

function generateIconMap(modules: CollectedModule[]): void {
  printStep('Generating icon map');
  console.log();

  const iconNames = new Set<string>();

  for (const mod of modules) {
    iconNames.add(mod.config.module.icon);
    if (mod.config.children) {
      for (const child of mod.config.children) {
        if (child.icon) iconNames.add(child.icon);
      }
    }
  }

  const iconList = [...iconNames].sort();
  const importStatement = `import { ${iconList.join(', ')} } from 'lucide-react';`;
  const exportStatement = `export { ${iconList.join(', ')} };`;

  const fileContent = `// ============================================================
// 此文件由 scripts/generate-modules.ts 自动生成
// 请勿手动编辑 - DO NOT EDIT MANUALLY
// 生成时间：${new Date().toISOString()}
// ============================================================

${importStatement}

${exportStatement}
`;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(ICON_MAP_FILE, fileContent, 'utf-8');

  printSuccess('Generated', toPosix(relative(process.cwd(), ICON_MAP_FILE)));
  printInfo('Icons', `${iconList.length}: ${iconList.join(', ')}`);
  console.log();
}

// ==================== 生成源文件映射 ====================

function generateSourceMap(sourceMap: ModuleSourceMap[]): void {
  printStep('Generating source map');
  console.log();

  const mapContent = JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      modules: sourceMap,
    },
    null,
    2,
  );

  writeFileSync(SOURCE_MAP_FILE, mapContent, 'utf-8');
  printSuccess('Generated', toPosix(relative(process.cwd(), SOURCE_MAP_FILE)));
  console.log();
}

// ==================== 生成调试日志 ====================

function generateDebugLog(
  modules: CollectedModule[],
  errors: string[],
  warnings: string[],
  sourceMap: ModuleSourceMap[],
): void {
  printStep('Generating debug log');
  console.log();

  const log: GenerationLog = {
    timestamp: new Date().toISOString(),
    modulesScanned: modules.length,
    modulesValid: modules.filter((m) => m.hasComponentFile).length,
    errors,
    warnings,
    sourceMap,
  };

  writeFileSync(DEBUG_LOG_FILE, JSON.stringify(log, null, 2), 'utf-8');
  printSuccess('Generated', toPosix(relative(process.cwd(), DEBUG_LOG_FILE)));
  console.log();
}

// ==================== 主函数 ====================

function main(): void {
  printTitle('Modulith Desktop · Module Registry Generator');
  console.log();

  const modules = scanModules();

  if (modules.length === 0) {
    printWarning('No modules found', 'the app may not work correctly');
    console.log();
  }

  const { errors, warnings } = validateModules(modules);

  const sourceMap = generateRegistry(modules);
  generateIconMap(modules);
  generateSourceMap(sourceMap);
  generateDebugLog(modules, errors, warnings, sourceMap);

  printDivider();
  printSuccess('Module registry generation complete', `${modules.length} modules`);
  printDivider();
  console.log();
}

// ==================== 导出供 Vite 插件使用 ====================

if (process.argv[1] === __filename) {
  main();
}

export { main as generateModules, scanModules, validateModules };
