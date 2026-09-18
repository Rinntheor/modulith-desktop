// scripts/colors.ts
// 构建脚本统一的终端输出样式：无 emoji，使用 chalk 着色。
// 未使用 emoji 的原因：Windows 传统控制台（GBK/cp936 代码页）无法渲染 emoji，
// 会输出乱码方框；纯符号 + 颜色在所有终端下都稳定。
import chalk from 'chalk';

// ==================== 颜色配置 ====================

export const c = {
  /** 标题 - 亮青色加粗 */
  title: chalk.cyan.bold,
  /** 成功 - 绿色 */
  success: chalk.green,
  /** 错误 - 红色 */
  error: chalk.red,
  /** 警告 - 黄色 */
  warning: chalk.yellow,
  /** 信息 - 蓝色 */
  info: chalk.blue,
  /** 高亮 - 青色 */
  highlight: chalk.cyan,
  /** 路径/文件 - 灰色 */
  path: chalk.gray,
  /** 数字/版本 - 亮黄色 */
  number: chalk.yellow,
  /** 标签 - 紫色 */
  label: chalk.magenta,
  /** 加粗 */
  bold: chalk.bold,
  /** 灰色（次要信息） */
  dim: chalk.gray,
  /** 下划线 */
  underline: chalk.underline,
} as const;

// ==================== 符号（无 emoji） ====================

export const symbols = {
  success: '✔',
  error: '✗',
  info: '›',
  warn: '⚠',
  arrow: '→',
  bullet: '•',
  divider: '─',
  doubleDivider: '═',
} as const;

// ==================== 基础输出 ====================

/** 打印分隔线 */
export function printDivider(char: string = symbols.doubleDivider, length = 60): void {
  console.log(c.dim(char.repeat(length)));
}

/** 打印标题块（上下带分隔线） */
export function printTitle(title: string, detail?: string): void {
  printDivider();
  console.log(`  ${c.title(title)}${detail ? c.dim(`  ${detail}`) : ''}`);
  printDivider();
}

/** 打印步骤标题 */
export function printStep(title: string, detail?: string): void {
  console.log(`${c.info(symbols.info)} ${c.bold(title)}${detail ? c.dim(` ${detail}`) : ''}`);
}

/** 打印成功消息 */
export function printSuccess(message: string, detail?: string): void {
  console.log(`  ${c.success(symbols.success)} ${c.success(message)}${detail ? c.dim(` ${detail}`) : ''}`);
}

/** 打印错误消息 */
export function printError(message: string, detail?: string): void {
  console.error(`  ${c.error(symbols.error)} ${c.error(message)}${detail ? c.dim(` ${detail}`) : ''}`);
}

/** 打印警告消息 */
export function printWarning(message: string, detail?: string): void {
  console.warn(`  ${c.warning(symbols.warn)} ${c.warning(message)}${detail ? c.dim(` ${detail}`) : ''}`);
}

/** 打印信息 */
export function printInfo(message: string, detail?: string): void {
  console.log(`  ${c.dim(symbols.bullet)} ${c.info(message)}${detail ? c.dim(` ${detail}`) : ''}`);
}

/** 打印次要信息（使用 chalk.gray，替代原先的 c.dim()） */
export function printDim(message: string): void {
  console.log(`  ${c.dim(message)}`);
}

/** 打印键值对 */
export function printKeyValue(key: string, value: string | number): void {
  console.log(`  ${c.dim(key)}: ${c.number(value)}`);
}

/** 打印路径 */
export function printPath(label: string, filePath: string): void {
  console.log(`  ${c.dim(label)} ${c.path(filePath)}`);
}

/** 打印字符串列表 */
function printList(header: string, items: string[], indent = '    '): void {
  if (items.length === 0) return;
  console.log(`  ${c.dim(header)}`);
  for (const item of items) {
    console.log(`${indent}${c.highlight(item)}`);
  }
}

/** 打印命令列表 */
export function printCommandList(commands: string[], limit = 0): void {
  const shown = limit > 0 && commands.length > limit ? commands.slice(0, limit) : commands;
  printList('Commands:', shown);
  if (shown.length !== commands.length) {
    console.log(`    ${c.dim(`... and ${commands.length - shown.length} more`)}`);
  }
}

/** 打印模块列表 */
export function printModuleList(modules: string[], limit = 0): void {
  const shown = limit > 0 && modules.length > limit ? modules.slice(0, limit) : modules;
  printList('Modules:', shown);
  if (shown.length !== modules.length) {
    console.log(`    ${c.dim(`... and ${modules.length - shown.length} more`)}`);
  }
}

// ==================== 表格 ====================

/**
 * 打印两列对齐的表格。
 * 宽度按可见字符计算，chalk 的颜色转义序列不计入宽度。
 */
export function printTable(rows: Array<[string, string]>): void {
  if (rows.length === 0) return;
  const width = Math.max(...rows.map(([k]) => stripAnsi(k).length));
  for (const [key, value] of rows) {
    const pad = ' '.repeat(Math.max(0, width - stripAnsi(key).length));
    console.log(`  ${c.dim(key)}${pad}  ${c.number(value)}`);
  }
}

/** 去除 ANSI 转义序列 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

/** 计算字符串的可见宽度（忽略 ANSI 转义序列） */
export function visibleWidth(str: string): number {
  return stripAnsi(str).length;
}
