// scripts/check-memory.ts
// 内存回收相关不变量的验证脚本
//
//   node scripts/check-memory.ts
//
// 这个脚本守的是四条**容易被无声改掉**的约定：
//
// 1. 模块组件缓存能在模块不再挂载时被逐条释放（否则它会随「曾经打开过的模块」
//    一直长大）。
// 2. **挂载集合会随关闭而收缩** —— 直接跑 `pruneMountedTabs` 断言行为。
//    这一条曾经缺失：集合只增不减，关闭标签不卸载面板，而当时的文本核对
//    （"setState 里出现了 releaseCachedModuleComponent"）**三项全过**。
//    这是本脚本里唯一必须用行为断言而不是文本核对的理由。
// 3. 那条释放必须挂在 `tabStore` 的唯一写入点上 —— 六条关闭/对账路径都经过它，
//    逐条去调必然漏一个。
// 4. 市场正文与图标缓存必须有上限（它们存的是几十 KB 级的字符串与 base64 文本，
//    而此前一条上限都没有）。
//
// 第 3、4 条只能用文本核对：`tabStore` / `pluginMarket` 会 import Tauri 的 IPC，
// 进不了 `tsconfig.node.json` 这个纯脚本 project（见该文件里的说明）。
// 第 2 条是这条限制的**出口**：把规则放进不依赖 IPC 的纯模块，就能真跑它。

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
import { pruneMountedTabs } from '../src/services/tabMountedPolicy.ts';
import { resolveDropIndex } from '../src/modules/dashboard/dropIndex.ts';
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
// 2. 挂载集合的收缩规则（直接跑纯函数，不做文本核对）
// ============================================================
//
// 这一段的存在理由本身就是一条教训：本规则此前只增不减，导致关闭标签不卸载面板、
// 组件缓存的逐条释放变成死代码。而当时的脚本只做文本核对
// （"setState 里出现了 releaseCachedModuleComponent"），**缺陷代码三项全过**。
// 规则抽进 `tabMountedPolicy.ts`（不 import 任何 Tauri/浏览器 API）之后，
// 这里可以直接调用它断言行为 —— 文本核对查不出的东西，行为断言能查。
console.log('\n标签挂载集合的收缩规则：');

// 场景 A：三个标签都挂载着，关掉其中一个。
// 这是核心缺陷的回归锁：修复前结果里仍有 'b'。
check(
  JSON.stringify(pruneMountedTabs(['a', 'b', 'c'], ['a', 'c'], [], 'a', null)) ===
    JSON.stringify(['a', 'c']),
  '关闭标签会把它从挂载集合里移除'
);

// 场景 B：仍然打开、只是当前未被激活的标签**必须保留** —— 保活是核心体验承诺，
// 与本规则是两件事（后者只管"已经从标签栏消失"的模块）。
check(
  JSON.stringify(pruneMountedTabs(['a', 'b', 'c'], ['a', 'b', 'c'], [], 'a', null)) ===
    JSON.stringify(['a', 'b', 'c']),
  '未被激活但仍然打开着的标签保持挂载（保活不被误伤）'
);

// 场景 C：激活标签必定在结果里，否则 Home 渲染不出面板 → 内容区白屏。
check(
  pruneMountedTabs([], ['a', 'b'], [], 'b', null).includes('b'),
  '激活标签即使不在上一轮的挂载集合里也会被补上'
);

// 场景 D：分屏两组的激活标签都要被补上。
const splitPruned = pruneMountedTabs([], ['a'], ['z'], 'a', 'z');
check(
  splitPruned.includes('a') && splitPruned.includes('z'),
  '分屏时两组的激活标签都被补上'
);

// 场景 E：顺序必须稳定（它决定面板的渲染顺序，跨组拖动时不能抖）。
check(
  JSON.stringify(pruneMountedTabs(['c', 'a', 'b'], ['a', 'b', 'c'], [], 'a', null)) ===
    JSON.stringify(['c', 'a', 'b']),
  '裁剪保持原有的相对顺序'
);

// 场景 F：**先裁剪再补齐**的顺序不能反。反过来的话，被关闭的标签会因为
// "它还是上一个激活项"而把自己救回来 —— 这正是原缺陷的成因之一。
check(
  JSON.stringify(pruneMountedTabs(['a', 'b'], ['a'], [], 'b', null)) ===
    JSON.stringify(['a']),
  '已关闭的标签不会因为仍是激活项而被保留'
);

// 场景 G：不复用传入数组（返回值是新数组，调用方拿不到可变的旧引用）。
const frozenInput = Object.freeze(['a', 'b']);
const frozenOut = pruneMountedTabs(frozenInput, ['a'], [], 'a', null);
check(
  frozenOut !== (frozenInput as unknown) && JSON.stringify(frozenOut) === JSON.stringify(['a']),
  '不修改传入数组，返回新数组'
);

// 场景 H：重复 ID 不重复挂载；空集合与空标签都不炸。
check(
  JSON.stringify(pruneMountedTabs(['a', 'a'], ['a'], [], 'a', null)) ===
    JSON.stringify(['a']),
  '挂载集合去重'
);
check(
  JSON.stringify(pruneMountedTabs([], [], [], null, null)) === JSON.stringify([]),
  '零标签时挂载集合为空（不是残留旧值）'
);

// ============================================================
// 3. 释放必须挂在 tabStore 的唯一写入点
// ============================================================
//
// 上面那组行为断言保证**规则本身**是对的；这一段保证**规则真的被用上**，
// 而且只在一个地方用 —— 六条关闭/对账路径都经过 setState，散落到各转移函数里迟早会漏。

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
  setStateBody !== null && setStateBody.includes('pruneMountedTabs'),
  'setState 用 pruneMountedTabs 收缩挂载集合（只补齐不收缩就是原缺陷）'
);
check(
  /import\s*\{[^}]*releaseCachedModuleComponent[^}]*\}\s*from\s*'\.\/moduleComponentCache'/.test(
    tabStore
  ),
  'moduleComponentCache 的导入存在'
);
// 收缩不能在别处另写一份：两份实现必然漂移，而漏掉的那一份不报错。
const pruneCalls = [...tabStore.matchAll(/pruneMountedTabs\(/g)].length;
check(
  pruneCalls === 1,
  `pruneMountedTabs 在 tabStore 里只被调用一次（实际 ${pruneCalls} 处）`
);

// 释放只应出现在这一处；散落到各转移函数里迟早会漏
const releaseCalls = [...tabStore.matchAll(/releaseCachedModuleComponent\(/g)].length;
check(releaseCalls === 1, `整个 tabStore 里只有一处释放调用（实际 ${releaseCalls} 处）`);

// ============================================================
// 4. 市场缓存的条目上限
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

// ============================================================
// 侧边栏与模块分类的上限（1.3.2 新增）
// ============================================================
//
// 分类表由前端提交、后端直接落盘，因此"数量上限"必须存在于后端；而前端也有一份
// 用于即时反馈的校验（`validateCategoryName`）。两份规则里**长度那个数字**是唯一
// 会漂移的地方 —— 前端说 24 个字符、后端说 32，用户就会遇到"输入框允许、保存被拒"。
// 这里把两个数字钉在一起。
console.log('\n侧边栏与分类的上限：');

const sidebarConfig = read('src-tauri/src/modules/sidebar/config.rs');
const sidebarCommands = read('src-tauri/src/modules/sidebar/commands.rs');
const validatorsTs = read('src/utils/validators.ts');
const moduleManagerTs = read('src/services/moduleManager.ts');

const rustNumber = (source: string, name: string): number | null => {
  const match = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(source);
  return match ? Number(match[1]) : null;
};

const rustNameChars = rustNumber(sidebarConfig, 'MAX_CATEGORY_NAME_CHARS');
const tsNameChars = Number(
  /export const MAX_CATEGORY_NAME_CHARS = (\d+);/.exec(validatorsTs)?.[1] ?? NaN
);
check(
  rustNameChars !== null && rustNameChars === tsNameChars,
  `分类名长度上限前后端一致（Rust ${rustNameChars} ／ TS ${Number.isNaN(tsNameChars) ? '缺失' : tsNameChars}）`
);
check(
  (rustNumber(sidebarConfig, 'MAX_CATEGORIES') ?? 0) > 0,
  '分类数量上限在后端（前端提交的数据必须由后端设上限）'
);
check(
  /config\.categories\.len\(\) >= MAX_CATEGORIES/.test(sidebarCommands),
  '新建分类时真的检查了数量上限'
);

// 分类随 `get_module_preferences` 一起返回，因此前端不应有第二个加载入口 ——
// 有第二个就会出现"这份数据加载了吗"这样的状态，而那个状态迟早有一处是错的。
check(
  !/invoke<[^>]*>\(\s*'get_module_categories'/.test(moduleManagerTs),
  '分类不单独加载（它随 get_module_preferences 一起回来，只有一个来源）'
);
check(
  /categories: ModuleCategory\[\];/.test(moduleManagerTs),
  'ModulePreferences 里有 categories（否则后端返回的字段会被类型悄悄丢掉）'
);
check(
  /getCategories\(\): ModuleCategory\[\]/.test(moduleManagerTs),
  '分类的读取入口在 moduleManager 上（模块偏好的唯一归属处）'
);

// ------------------------------------------------------------
// 拖动落点的下标换算
// ------------------------------------------------------------
//
// 这一段守的是一个**只在半数方向上错**的缺陷：拖动时算出的下标是按"模块还在
// 原处"数出来的，而后端先摘掉再插入，因此同一个分类内向下拖要减一。手工试两下
// 很容易恰好试到对的那一半。规则本身只有一份实现（`dropIndex.ts`），这里直接跑它。
console.log('\n拖动落点的换算：');

const drop = resolveDropIndex;

// [a,b,c] 把 a 拖到 b 与 c 之间：落点 2 → 摘掉 a 之后应当是 1
check(
  drop({ categoryId: 'cat-1', index: 0 }, { categoryId: 'cat-1', index: 2 }) === 1,
  '同一分类内向下拖：下标减一（不减会得到 [b,c,a] 而不是 [b,a,c]）'
);
// 向上拖不需要换算：[a,b,c] 把 c 拖到 a 之前，落点 0，摘掉后插到 0 仍是对的
check(
  drop({ categoryId: 'cat-1', index: 2 }, { categoryId: 'cat-1', index: 0 }) === 0,
  '同一分类内向上拖：下标不变'
);
check(
  drop({ categoryId: 'cat-1', index: 1 }, { categoryId: 'cat-1', index: 1 }) === 1,
  '原地放手：不变（不是 -1）'
);
check(
  drop({ categoryId: 'cat-1', index: 0 }, { categoryId: 'cat-2', index: 2 }) === 2,
  '跨分类：不换算（源列表与目标列表是两个数组）'
);
check(
  drop({ categoryId: 'cat-1', index: 0 }, { categoryId: null, index: 0 }) === 0,
  '移出所有分类：不换算'
);
check(
  drop(undefined, { categoryId: 'cat-1', index: 3 }) === 3,
  '源位置不可知时原样交给后端（它自己会夹取越界的下标）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
