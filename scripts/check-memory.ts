// scripts/check-memory.ts
// 内存回收相关不变量的验证脚本
//
//   node scripts/check-memory.ts
//
// 这个脚本守的是三条**容易被无声改掉**的约定：
//
// 1. 模块组件缓存能在模块不再挂载时被逐条释放（否则它会随「曾经打开过的模块」
//    一直长大）。
// 2. 那条释放必须挂在 `tabStore` 的唯一写入点上 —— 六条关闭/对账路径都经过它，
//    逐条去调必然漏一个。
// 3. 市场正文与图标缓存必须有上限（它们存的是几十 KB 级的字符串与 base64 文本，
//    而此前一条上限都没有）。
//
// 第 2、3 条只能用文本核对：`tabStore` / `pluginMarket` 会 import Tauri 的 IPC，
// 进不了 `tsconfig.node.json` 这个纯脚本 project（见该文件里的说明）。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cachedModuleCount,
  clearModuleComponentCache,
  getCachedModuleComponent,
  releaseCachedModuleComponent,
  setCachedModuleComponent,
} from '../src/services/moduleComponentCache.ts';
import type { ModuleDescriptor } from '../src/types/module.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function read(relative: string): string {
  return readFileSync(join(PROJECT_ROOT, relative), 'utf-8');
}

/** 取出一个函数的函数体（从签名起，括号配平到结束），用于「某调用是否在里面」 */
function functionBody(source: string, signature: string): string | null {
  const start = source.indexOf(signature);
  if (start === -1) return null;

  const open = source.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

// ============================================================
// 1. 组件缓存的逐条释放
// ============================================================

console.log('模块组件缓存：');

clearModuleComponentCache();
check(cachedModuleCount() === 0, '清空后计数为 0');

// 组件本身在测试里不会被渲染，因此用最小的替身即可（只验证缓存的存取语义）
const fakeComponent = (() => null) as unknown as ModuleDescriptor['component'];

setCachedModuleComponent('dashboard', fakeComponent);
setCachedModuleComponent('notes', fakeComponent);
check(cachedModuleCount() === 2, '写入两个模块后计数为 2');
check(getCachedModuleComponent('dashboard') === fakeComponent, '能按 ID 取回同一个组件');
check(getCachedModuleComponent('missing') === null, '没有缓存时返回 null');

releaseCachedModuleComponent('dashboard');
check(cachedModuleCount() === 1, '释放一个之后计数为 1');
check(getCachedModuleComponent('dashboard') === null, '被释放的模块取不到了');
check(getCachedModuleComponent('notes') === fakeComponent, '释放不影响其它模块');

// 释放不存在的条目必须是安全的空操作：它会在「模块已经不在缓存里」时被调用
releaseCachedModuleComponent('dashboard');
check(cachedModuleCount() === 1, '重复释放同一个模块不会出错');

// `setCachedModuleComponent` 是**会覆盖**的：稳定性由调用方的前置判断与
// 「只在 clear / release 时消失」共同保证，不靠 setter 静默忽略写入。
const replacement = (() => null) as unknown as ModuleDescriptor['component'];
setCachedModuleComponent('notes', replacement);
check(getCachedModuleComponent('notes') === replacement, '重复写入会覆盖（set 的语义直白）');
check(cachedModuleCount() === 1, '覆盖不会增加条目数');

setCachedModuleComponent('notes', fakeComponent);

clearModuleComponentCache();
check(cachedModuleCount() === 0, '再次清空后计数归零');

// ============================================================
// 2. 释放必须挂在 tabStore 的唯一写入点
// ============================================================

console.log('\ntabStore 的释放挂钩：');

const tabStore = read('src/services/tabStore.ts');
const setStateBody = functionBody(tabStore, 'function setState(');

check(setStateBody !== null, '能找到 setState 的定义');
check(
  setStateBody !== null && setStateBody.includes('releaseCachedModuleComponent'),
  'setState 里调用了 releaseCachedModuleComponent（六条关闭路径都经过这里）'
);
check(
  setStateBody !== null && setStateBody.includes('state.mountedTabs'),
  '释放依据是比较前后的 mountedTabs，而不是别处传来的列表'
);
check(
  /import\s*\{[^}]*releaseCachedModuleComponent[^}]*\}\s*from\s*'\.\/moduleComponentCache'/.test(
    tabStore
  ),
  'moduleComponentCache 的导入存在'
);

// 释放只应出现在这一处；散落到各转移函数里迟早会漏
const releaseCalls = [...tabStore.matchAll(/releaseCachedModuleComponent\(/g)].length;
check(releaseCalls === 1, `整个 tabStore 里只有一处释放调用（实际 ${releaseCalls} 处）`);

// ============================================================
// 3. 市场缓存的条目上限
// ============================================================

console.log('\n市场缓存的条目上限：');

const market = read('src/services/pluginMarket.ts');

check(market.includes('MAX_CACHED_ENTRIES'), '声明了条目上限常量');

const limitMatch = /const MAX_CACHED_ENTRIES = (\d+)/.exec(market);
check(limitMatch !== null, '上限是一个字面量数字（便于本脚本核对）');
if (limitMatch) {
  const limit = Number(limitMatch[1]);
  check(limit >= 8, `上限不低于 8（实际 ${limit}）—— 太小会让详情页反复重新下载`);
  check(limit <= 256, `上限不高于 256（实际 ${limit}）—— 否则等于没有上限`);
}

check(
  /readmeCache,\s*key,\s*text/.test(market),
  'README 走带淘汰的写入（cacheSet）'
);
check(
  /iconCache,\s*iconPath,\s*pending/.test(market),
  '图标走带淘汰的写入（cacheSet）'
);
check(
  !/readmeCache\.set\(/.test(market) && !/iconCache\.set\(/.test(market),
  '没有残留的裸 .set()（绕过上限的那种写法）'
);
check(
  market.includes('cache.keys().next()'),
  '淘汰按插入顺序取最早的一条'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
