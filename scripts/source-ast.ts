// scripts/source-ast.ts
//
// 给校验脚本用的**源码结构查询**：一律走 TypeScript 自己的 parser。
//
// ============================================================
// 为什么值得单独一个模块
// ============================================================
//
// 这些查询原先散在各个校验脚本里，而且是手写的文本匹配：按缩进取属性名、
// 找标记到下一个行首 `}`。它们在"格式恰好如预期"时能工作，而边界恰恰是**真的**
// 被测代码改过的地方 —— 两个替代版本连续被真实代码打穿：
//
//   * 按缩进：把方法体里的 `if (...)`、`for (...)` 与解构出来的
//     `title` / `body` / `url` 都当成了方法名；
//   * 按括号深度：被 `invoke<T>(...)` 的泛型尖括号与多行箭头参数表打穿。
//
// 报出十几条假失败。**而假失败的真实代价不是难读：它会让人连真的那一条一起忽略。**
//
// 教训不是"再修一次正则"，而是：手写解析器会给出"看起来检查过了"的假通过与假失败，
// 那比不检查更糟。TypeScript 已经在依赖里，用它做这件唯一正确的事。
//
// 抽成模块而不是在每个脚本里各写一份，理由与项目其它地方一致：**同一份逻辑的第二份
// 副本必然漂移**，而这两个脚本要核对的正是"声明与实际是否一致"。

import ts from 'typescript';

/** 解析一份源码，得到一个可遍历的语法树 */
export function parseSource(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

/** 接口声明的成员名（方法与属性都算）。接口不存在时返回 `null`，让调用方报失败 */
export function interfaceMemberNames(source: string, interfaceName: string): string[] | null {
  const file = parseSource('source.ts', source);
  let found: ts.InterfaceDeclaration | undefined;

  const find = (node: ts.Node): void => {
    if (found) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      found = node;
      return;
    }
    ts.forEachChild(node, find);
  };
  find(file);
  if (!found) return null;

  return found.members.flatMap(nameOf);
}

/** 对象字面量的顶层键（简写属性 `add,` 的 name 也是 Identifier） */
export function literalKeys(literal: ts.ObjectLiteralExpression): string[] {
  return literal.properties.flatMap(nameOf);
}

function nameOf(member: ts.TypeElement | ts.ObjectLiteralElementLike): string[] {
  const name = member.name;
  if (name === undefined) return [];
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return [name.text];
  return [];
}

export interface ObjectLiteralEntry {
  /** 它出现在哪个具名函数里；模块顶层为 `null` */
  functionName: string | null;
  /**
   * 相对该函数体的属性路径。
   *
   * 三种段：
   *   * `return` —— `return { ... }` 的字面量
   *   * 属性名   —— `name: { ... }` 或 `const name = { ... }`
   */
  path: string[];
  keys: string[];
}

/**
 * 收集**所有对象字面量**，每个记下它属于哪个具名函数、以及它相对该函数体的属性路径。
 *
 * 一次遍历同时覆盖 `ctx` 上能力的两种来源：
 *   * 独立工厂：`function pluginStorage() { ... return { get, set, ... }; }` → `['return']`
 *   * 内联对象：上下文工厂的返回里直接写 `disposables: { add, size }` → `['return', 'disposables']`
 *   * 变量声明：`installHostGlobals` 里的 `const host: ModulithHost = { ... }` → `['host']`
 *
 * 三种形状都必须处理。漏掉变量声明那一种时，"注入的 host 对象"那条核对会永远失败 ——
 * 而一个永远失败的断言最后会被人删掉。
 */
export function collectObjectLiterals(source: string): ObjectLiteralEntry[] {
  const file = parseSource('source.ts', source);
  const collected: ObjectLiteralEntry[] = [];

  const walk = (node: ts.Node, functionName: string | null, path: string[]): void => {
    let currentFunction = functionName;
    let currentPath = path;

    // 进入新的具名函数：它内部的对象路径从头算，归属换成它
    if (ts.isFunctionDeclaration(node) && node.name) {
      currentFunction = node.name.text;
      currentPath = [];
    }

    // `return { ... }`
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isObjectLiteralExpression(node.expression)
    ) {
      const nextPath = [...currentPath, 'return'];
      descendInto(node.expression, currentFunction, nextPath);
      return;
    }

    // `name: { ... }`
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '<computed>';
      descendInto(node.initializer, currentFunction, [...currentPath, name]);
      return;
    }

    // `const name: T = { ... }`
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const name = ts.isIdentifier(node.name) ? node.name.text : '<pattern>';
      descendInto(node.initializer, currentFunction, [...currentPath, name]);
      return;
    }

    ts.forEachChild(node, (child) => walk(child, currentFunction, currentPath));
  };

  const descendInto = (
    literal: ts.ObjectLiteralExpression,
    functionName: string | null,
    path: string[]
  ): void => {
    collected.push({ functionName, path, keys: literalKeys(literal) });
    for (const property of literal.properties) walk(property, functionName, path);
  };

  walk(file, null, []);
  return collected;
}

/**
 * 在已收集的结果里按"哪个函数 + 什么路径"取键。
 *
 * 找不到时返回 `null` —— 调用方据此报**失败**。返回空数组会是更糟的选择：
 * 它把"解析没找到"伪装成"这个对象没有成员"。
 */
export function objectKeysAt(
  entries: readonly ObjectLiteralEntry[],
  functionName: string,
  path: readonly string[]
): string[] | null {
  const hit = entries.find(
    (entry) => entry.functionName === functionName && entry.path.join('/') === path.join('/')
  );
  return hit ? hit.keys : null;
}

// ============================================================
// 按文本做的断言：必须先剥掉注释
// ============================================================

/**
 * 用源码里出现的**标识符**拼一份文本，注释被自然排除。
 *
 * 给"这个文件里有没有调用 X"这类按文本判定的断言用。直接对原文做正则是不安全的：
 * 注释里提到 `Modulith.createContext()` 就会被当成一次真实调用 —— 而注释恰恰最可能
 * 出现在**解释为什么不调用它**的地方，于是断言在错误的地方失败。
 *
 * 这不是假想：本项目已经踩过同一类坑（构建脚本按文本统计命令数、对注释视而不见），
 * 这里也真的发生过一次。
 *
 * 实现上取所有标识符即可 —— 断言只关心"某个名字有没有被使用"，
 * 而标识符不会出现在注释里。标点类的匹配请改用别的方式。
 */
export function identifierText(source: string): string {
  const file = parseSource('source.ts', source);
  const names: string[] = [];

  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.push(node.text);
    ts.forEachChild(node, walk);
  };
  walk(file);

  return names.join(' ');
}
