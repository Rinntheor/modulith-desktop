// scripts/check-source-ast.ts
//
// `scripts/source-ast.ts` 的自检。
//
//   node scripts/check-source-ast.ts
//
// ============================================================
// 为什么这段逻辑配得上一个测试
// ============================================================
//
// 它是**其它所有校验脚本的眼睛**：`check-plugin-boundary` 与 `check-contributions`
// 都靠它回答"实际接线长什么样"。它出错的方式在真实代码里已经出现过两次：
//
//   * 按缩进猜 → 把方法体里的 `if (...)`、`for (...)` 与解构出的
//     `title` / `body` / `url` 当成了方法名；
//   * 按括号深度猜 → 被 `invoke<T>(...)` 的泛型尖括号与多行箭头参数表打穿。
//
// 两次都报出十几条假失败。**而假失败的真实代价不是难读：它会让人连真的那一条
// 一起忽略。**
//
// 所以这里用**构造出来的、形状已知的**源码把行为钉死。用合成片段而不是真实文件，
// 是因为要测试的是"各种形状能不能认出来"，而真实文件里凑不齐这些形状的组合。
//
// 每个用例都对应一个曾经出错或极易出错的形状。

import { collectObjectLiterals, interfaceMemberNames, objectKeysAt } from './source-ast.ts';

let failed = 0;
let total = 0;

function check(condition: boolean, label: string): void {
  total += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${label}`);
  }
}

/** 取某函数某路径下的键；找不到时返回 `null` 的标记 */
function keysOf(source: string, fn: string, path: string[]): string {
  const entries = collectObjectLiterals(source);
  const keys = objectKeysAt(entries, fn, path);
  return keys === null ? '<未找到>' : keys.join(',');
}

// ============================================================
// 1. 接口成员
// ============================================================
console.log('接口成员：');

{
  const source = `
export interface Host {
  a: string;
  readonly b: number;
  c(): void;
  d<T>(x: T): T;
}
`;
  check(
    interfaceMemberNames(source, 'Host')?.join(',') === 'a,b,c,d',
    '属性、只读属性、方法与泛型方法都算成员'
  );
  check(interfaceMemberNames(source, 'Nope') === null, '接口不存在时返回 null（而不是空数组）');
}

{
  // 行注释与块注释里的 `名字:` 不该被算成成员
  const source = `
export interface Host {
  // e: string;
  /* f: number; */
  a: string;
}
`;
  check(interfaceMemberNames(source, 'Host')?.join(',') === 'a', '注释里的成员声明被忽略');
}

// ============================================================
// 2. 对象字面量：三种形状
// ============================================================
console.log('\n对象字面量形状：');

{
  const source = `
function factory() {
  return {
    get: () => 1,
    set: (v) => v,
  };
}
`;
  check(keysOf(source, 'factory', ['return']) === 'get,set', '工厂函数 return 的字面量键');
}

{
  const source = `
function factory() {
  return {
    a: 1,
    nested: { x: 1, y: 2 },
  };
}
`;
  check(keysOf(source, 'factory', ['return']) === 'a,nested', '顶层键只取本层，不含嵌套对象的键');
  check(keysOf(source, 'factory', ['return', 'nested']) === 'x,y', '嵌套对象按路径可取到');
}

{
  const source = `
function install() {
  const host = {
    version: '1',
    run: () => {},
  };
}
`;
  check(
    keysOf(source, 'install', ['host']) === 'version,run',
    '变量声明形状（`const host = {...}`）—— 漏掉它会让 host 核对永远失败'
  );
}

{
  const source = `
function ctxFactory() {
  return {
    a: 1,
    disposables: {
      add: () => {},
      size: () => 0,
    },
  };
}
`;
  check(
    keysOf(source, 'ctxFactory', ['return', 'disposables']) === 'add,size',
    '返回对象里的内联对象（`disposables: {...}`）'
  );
}

// ============================================================
// 3. 曾经把解析器打穿的那些形状
// ============================================================
console.log('\n曾被误认成方法名的形状：');

{
  // 第一版按缩进猜时，这些全被当成了方法名
  const source = `
function ops() {
  return {
    run(id) {
      if (id) {
        for (const k of []) {
          console.log(k);
        }
      }
    },
    notify(title, body) {
      const level = body;
      return level;
    },
  };
}
`;
  const entries = collectObjectLiterals(source);
  const keys = objectKeysAt(entries, 'ops', ['return']);
  check(
    keys?.join(',') === 'run,notify',
    `方法体里的 if / for / return / 局部变量都不算方法（实际：${keys?.join(',')}）`
  );
}

{
  // 第二版按括号深度猜时，泛型尖括号参与了深度计数，把配对带偏
  const source = `
function call() {
  return {
    one: () => invoke<void>('cmd', { a: 1 }),
    two: (x) => invoke<{ y: number }>('cmd2', { b: x }),
  };
}
`;
  check(keysOf(source, 'call', ['return']) === 'one,two', '泛型尖括号（`invoke<T>(...)`）不影响配对');
}

{
  // 模板字符串里的花括号 / 反引号是手写配对最容易翻车的地方
  const source = `
function templated() {
  return {
    render: () => \`\${ { a: 1 } }\`,
    other: 2,
  };
}
`;
  check(keysOf(source, 'templated', ['return']) === 'render,other', '模板字符串里的花括号不影响配对');
}

{
  // 多行箭头函数的参数表：解构参数曾被认为是键
  const source = `
function multi() {
  return {
    pick: ({
      title,
      body,
    }) => title + body,
    size: () => 0,
  };
}
`;
  check(
    keysOf(source, 'multi', ['return']) === 'pick,size',
    '多行解构参数（`{ title, body }`）不被当成键'
  );
}

// ============================================================
// 4. 归属：路径要按函数分开算
// ============================================================
console.log('\n归属：');

{
  const source = `
function first() {
  return { a: 1 };
}
function second() {
  return { b: 2 };
}
`;
  check(keysOf(source, 'first', ['return']) === 'a', '同名路径在两个函数里各算各的（first）');
  check(keysOf(source, 'second', ['return']) === 'b', '同名路径在两个函数里各算各的（second）');
}

{
  const source = `
function outer() {
  function inner() {
    return { b: 2 };
  }
  return { a: 1 };
}
`;
  check(keysOf(source, 'outer', ['return']) === 'a', '内层函数里的字面量归属内层，不串到外层');
  check(keysOf(source, 'inner', ['return']) === 'b', '内层函数自己的字面量可被取到');
}

{
  const source = `const top = { x: 1, y: 2 };`;
  const entries = collectObjectLiterals(source);
  const root = entries.find((entry) => entry.functionName === null);
  check(root?.keys.join(',') === 'x,y', '模块顶层的字面量归属为 null');
}

// ============================================================
// 5. 没找到 ≠ 空
// ============================================================
console.log('\n失败信号：');

check(
  keysOf('function f() { return { a: 1 }; }', 'f', ['nope']) === '<未找到>',
  '路径不存在时返回 null —— 让调用方报失败，而不是静默给出空数组'
);
check(
  keysOf('function f() { const x = 1; }', 'f', ['return']) === '<未找到>',
  '函数没有返回对象字面量时返回 null'
);

// ============================================================
console.log('');
if (failed > 0) {
  console.error(`${failed} / ${total} 项未通过。`);
  process.exit(1);
}
console.log(`全部通过（${total} 项）。`);
