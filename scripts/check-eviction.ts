// scripts/check-eviction.ts
//
// 标签内存淘汰规则的行为验证脚本
//
//   node scripts/check-eviction.ts
//
// 这个脚本**直接运行**淘汰规则（`src/services/tabEvictionPolicy.ts` 是纯函数，
// 不 import 任何 Tauri / React / 浏览器 API），而不是核对源码文本。
//
// 为什么必须是行为断言：这是整个项目里**唯一会静默关掉用户打开的标签**的机制。
// 文本核对查不出下面这类问题 ——
//
//   · 保护规则写反了（"收藏"被当成"可淘汰"）；
//   · 淘汰选中了用户正在看的那一个（当着用户的面关界面）；
//   · 没有可淘汰对象时返回了一个"随便挑一个"的结果（而不是空）。
//
// 这三种都不会报错、不会崩溃，只会让用户发现"我的标签不见了"。
// 因此它们必须被穷举覆盖，而不是靠读代码相信。

import { isProtectedFromEviction, selectEvictions } from '../src/services/tabEvictionPolicy.ts';

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

/** 构造一份默认输入，测试只覆盖自己关心的字段 */
function input(overrides: Partial<Parameters<typeof selectEvictions>[0]> = {}) {
  return {
    openTabs: ['a', 'b', 'c'],
    splitTabs: [] as string[],
    activeTab: 'a' as string | null,
    splitActive: null as string | null,
    mountedTabs: ['a', 'b', 'c'],
    lastSeen: { a: 3, b: 2, c: 1 },
    pinnedIds: [] as string[],
    favoriteIds: [] as string[],
    needed: 1,
    ...overrides,
  };
}

// ============================================================
// 1. 淘汰的是最久未显示的
// ============================================================
console.log('淘汰顺序：');

check(
  JSON.stringify(
    selectEvictions(input({ lastSeen: { a: 3, b: 2, c: 1 }, activeTab: 'a', needed: 1 }))
  ) === JSON.stringify(['c']),
  '最久未显示的排在最前（lastSeen 越小越久没看过）'
);

check(
  JSON.stringify(
    selectEvictions(input({ lastSeen: { a: 3, b: 2, c: 1 }, activeTab: 'a', needed: 2 }))
  ) === JSON.stringify(['c', 'b']),
  '需要两个位置时按同样顺序多淘汰一个'
);

/// 按"最近一次**显示**"而不是"最近一次打开"。
///
/// 用户开着 A 打字、切到 B 查资料、再切回 A 继续打 —— A 才是在意的那个，
/// 而它按"打开时间"会被当成最旧。这条测试把那个区别钉住。
check(
  JSON.stringify(
    selectEvictions(
      input({
        lastSeen: { a: 2, b: 1 },
        activeTab: 'a',
        openTabs: ['a', 'b'],
        mountedTabs: ['a', 'b'],
        needed: 1,
      })
    )
  ) === JSON.stringify(['b']),
  '刚切回来的标签不会被当成"最旧"（按显示时间而不是打开时间）'
);

// ============================================================
// 2. 保护规则
// ============================================================
console.log('\n保护规则：');

check(
  selectEvictions(input({ activeTab: 'c', lastSeen: { a: 3, b: 2, c: 1 }, needed: 1 })).length === 1 &&
    !selectEvictions(input({ activeTab: 'c', lastSeen: { a: 3, b: 2, c: 1 }, needed: 1 })).includes('c'),
  '正在显示的标签（第一组激活项）永不被淘汰'
);

check(
  !selectEvictions(
    input({ splitActive: 'c', lastSeen: { a: 3, b: 2, c: 1 }, activeTab: 'a', needed: 2 })
  ).includes('c'),
  '分屏那一组的激活项同样永不被淘汰'
);

check(
  JSON.stringify(
    selectEvictions(
      input({ lastSeen: { a: 3, b: 2, c: 1 }, activeTab: 'a', pinnedIds: ['c'], needed: 1 })
    )
  ) === JSON.stringify(['b']),
  '置顶的标签被跳过，淘汰顺延到下一个'
);

check(
  JSON.stringify(
    selectEvictions(
      input({ lastSeen: { a: 3, b: 2, c: 1 }, activeTab: 'a', favoriteIds: ['c'], needed: 1 })
    )
  ) === JSON.stringify(['b']),
  '收藏的标签同样被保护'
);

/// 保护顺序里"激活 > 置顶 > 收藏"。
///
/// 三者叠加时的结果必须确定：最旧的那个即使被收藏也不淘汰，
/// 而淘汰会落在次旧的那个上。
check(
  JSON.stringify(
    selectEvictions(
      input({
        lastSeen: { a: 3, b: 2, c: 1 },
        activeTab: 'a',
        pinnedIds: ['b'],
        favoriteIds: ['c'],
        needed: 1,
      })
    )
  ) === JSON.stringify([]),
  '全部候选都受保护时返回空（不能随便挑一个）'
);

// ============================================================
// 3. 没有可淘汰对象时返回空
// ============================================================
//
// 这是这条规则里最容易被"顺手优化"掉的一处：既然要腾位置，
// 那就总能凑出一个来。**不能** —— 硬挤一个的代价是用户丢掉现场，
// 而正确行为是让调用方如实拒绝并说明原因。
console.log('\n无候选：');

check(
  selectEvictions(
    input({ openTabs: ['a', 'b'], splitTabs: [], activeTab: 'a', needed: 1, mountedTabs: ['a'] })
  ).length === 0,
  '除了正在显示的之外都没挂载过时，没有可淘汰对象（淘汰它换不到内存）'
);

check(
  selectEvictions(input({ openTabs: ['a'], splitTabs: [], activeTab: 'a', needed: 1 })).length === 0,
  '只有一个标签且它正在显示时，淘汰集合为空'
);

check(
  selectEvictions(
    input({ openTabs: ['a', 'b'], splitTabs: [], activeTab: 'a', pinnedIds: ['b'], needed: 1 })
  ).length === 0,
  '唯一的候选被置顶时，淘汰集合为空'
);

check(selectEvictions(input({ needed: 0 })).length === 0, 'needed 为 0 时不淘汰任何东西');

check(
  selectEvictions(input({ needed: -3 })).length === 0,
  'needed 为负数时也不淘汰（不能让一个算错的需求量关掉标签）'
);

// ============================================================
// 4. 只在挂载过的标签里选
// ============================================================
console.log('\n只淘汰挂载过的：');

check(
  JSON.stringify(
    selectEvictions(
      input({
        openTabs: ['a', 'b', 'c'],
        mountedTabs: ['a', 'b'],
        lastSeen: { a: 3, b: 2, c: 1 },
        activeTab: 'a',
        needed: 1,
      })
    )
  ) === JSON.stringify(['b']),
  '没挂载过的标签不占内存，因此跳过它去淘汰真正占着的那一个'
);

// ============================================================
// 5. 确定性与分屏
// ============================================================
console.log('\n确定性与分屏：');

/// 同样的输入必须得到同样的输出。
///
/// 不确定的淘汰顺序会让两次淘汰选到不同的标签，而用户看到的是界面在抖 ——
/// 而这种抖动无法复现，因此无法排查。
check(
  JSON.stringify(
    selectEvictions(input({ lastSeen: { a: 3, b: 2, c: 1 }, activeTab: 'a', needed: 4 }))
  ) ===
    JSON.stringify(
      selectEvictions(input({ lastSeen: { a: 3, b: 2, c: 1 }, activeTab: 'a', needed: 4 }))
    ),
  '相同输入得到相同输出（淘汰顺序稳定）'
);

check(
  !selectEvictions(
    input({
      openTabs: ['a'],
      splitTabs: ['x', 'y'],
      activeTab: 'a',
      splitActive: 'x',
      mountedTabs: ['a', 'x', 'y'],
      lastSeen: { a: 3, x: 2, y: 1 },
      needed: 1,
    })
  ).includes('a'),
  '分屏时两组的激活项都被保护'
);

check(
  JSON.stringify(
    selectEvictions(
      input({
        openTabs: ['a'],
        splitTabs: ['x', 'y'],
        activeTab: 'a',
        splitActive: 'x',
        mountedTabs: ['a', 'x', 'y'],
        lastSeen: { a: 3, x: 2, y: 1 },
        needed: 1,
      })
    )
  ) === JSON.stringify(['y']),
  '分屏两组的候选一起参与淘汰（第二组不是"免死金牌"）'
);

// 没有使用记录的标签与已知最旧的那些**并列在最前**（同样按标签顺序）淘汰。
//
// 这一条的初版把期望写反了（我按注释的意图写了 `['c']` 却被实现给出 `['b']`）。
// 核对之后确认**实现是对的、注释是错的**：没有使用记录意味着用户从没看过它，
// 因此它比"有记录但很旧"更该被先回收 —— 那个更旧的标签至少证明用户用过它。
check(
  JSON.stringify(
    selectEvictions(
      input({
        openTabs: ['a', 'b', 'c'],
        activeTab: 'a',
        lastSeen: { b: 1 },
        mountedTabs: ['a', 'b', 'c'],
        needed: 1,
      })
    )
  ) === JSON.stringify(['c']),
  '没有使用记录的标签优先于"有记录但很旧"的（从没看过的最安全）'
);

// 有记录的标签之间仍然严格按记录顺序：上一条里 `b` 有记录，因此它排在 `c` 之后。
check(
  JSON.stringify(
    selectEvictions(
      input({
        openTabs: ['a', 'b', 'c', 'd'],
        activeTab: 'a',
        lastSeen: { b: 2, d: 1 },
        mountedTabs: ['a', 'b', 'c', 'd'],
        needed: 2,
      })
    )
  ) === JSON.stringify(['c', 'd']),
  '先淘汰无记录的，再按记录顺序淘汰最旧的'
);

// ============================================================
// 6. isProtectedFromEviction 与 selectEvictions 判据一致
// ============================================================
//
// 界面上要显示"哪些标签是安全的"，用的是同一个判据。
// 两处不一致的表现是"界面说它安全、它却被淘汰了"。
console.log('\n保护判据一致：');

const protection = {
  activeTab: 'a',
  splitActive: 'x',
  pinnedIds: ['p'],
  favoriteIds: ['f'],
};

check(isProtectedFromEviction('a', protection), '激活项（第一组）受保护');
check(isProtectedFromEviction('x', protection), '激活项（第二组）受保护');
check(isProtectedFromEviction('p', protection), '置顶受保护');
check(isProtectedFromEviction('f', protection), '收藏受保护');
check(!isProtectedFromEviction('z', protection), '普通标签不受保护');

/// 两个接口的判据必须**逐例一致**：对同一批标签，`isProtected` 为真的那些
/// 绝不能出现在 `selectEvictions` 的结果里。
const probe = ['a', 'x', 'p', 'f', 'z'];
const evicted = selectEvictions({
  openTabs: ['a', 'p', 'f', 'z'],
  splitTabs: ['x'],
  mountedTabs: probe,
  lastSeen: { a: 5, x: 4, p: 3, f: 2, z: 1 },
  needed: 5,
  ...protection,
});

check(
  evicted.every((id) => !isProtectedFromEviction(id, protection)),
  'selectEvictions 的结果里不含任何 isProtectedFromEviction 判为受保护的标签'
);

// ============================================================
// 7. 规则真的被接线（而不只是存在）
// ============================================================
//
// 上面全部是"规则本身对不对"。这一段查的是**它有没有被用上** ——
// 而这个项目里最反复出现的缺陷正是"规则写好了、路径没接"。
// 它只能做文本核对（`tabStore.ts` 会 import Tauri 的 IPC，进不了纯脚本 project），
// 因此这里只盯三件最容易在重构中被丢掉的事。
console.log('\n规则被接线：');

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tabStore = readFileSync(join(PROJECT_ROOT, 'src/services/tabStore.ts'), 'utf-8');

/** 取出一个函数的函数体（括号配平），用于"某调用是否在里面" */
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

const openTabBody = functionBody(tabStore, 'export function openTab(');
check(openTabBody !== null, '能找到 openTab 的实现');
check(
  openTabBody !== null && openTabBody.includes('evictToMakeRoom'),
  'openTab 在达到上限时先尝试淘汰（而不是直接拒绝）'
);
check(
  openTabBody !== null && /evictToMakeRoom\([\s\S]{0,40}?=== 0[\s\S]{0,120}?warnLimit/.test(openTabBody),
  '没有可淘汰对象时**如实拒绝**并说明原因（而不是硬挤一个进去）'
);

const evictBody = functionBody(tabStore, 'function evictToMakeRoom(');
check(evictBody !== null, '能找到 evictToMakeRoom 的实现');
check(
  evictBody !== null && evictBody.includes('selectEvictions') && evictBody.includes('lastSeen'),
  '淘汰用的是 selectEvictions 与真实的 lastSeen 记录'
);
check(
  evictBody !== null && evictBody.includes('getPinnedModules') && evictBody.includes('getFavoriteIds'),
  '置顶与收藏都传给了规则（少了任一个，那些标签会被误淘汰）'
);
check(
  evictBody !== null && evictBody.includes('showToast'),
  '淘汰之后如实告知用户（静默关掉标签看起来像故障，而不是策略）'
);

// 最近使用记录必须由唯一写入点维护。散到各切换路径里必然漏，
// 而漏掉的表现是"某个刚看过的标签被优先淘汰"。
const setStateBody = functionBody(tabStore, 'function setState(');
check(
  setStateBody !== null && setStateBody.includes('updateRecency'),
  '最近使用记录在 setState（唯一写入点）里维护'
);
check(
  !/recentTabs/.test(tabStore),
  '没有残留的旧字段名 recentTabs（初版用数组位置表达，已改为 lastSeen 时间戳）'
);

// 达到上限的提示不能再说"不会自动帮你关掉" —— 它现在会。
//
// 只在 `warnLimit` 的**函数体里**查，不查整个文件：那段说明"为什么改"的注释
// 会合法地引用旧文案，而全文件扫描会把它当成违规（本断言的第一版就是这样假失败的）。
const warnLimitBody = functionBody(tabStore, 'function warnLimit(');
check(warnLimitBody !== null, '能找到 warnLimit 的实现');
check(
  warnLimitBody !== null && !/不会自动帮你关掉/.test(warnLimitBody),
  '上限提示的措辞与真实行为一致（不再声称"不会自动关掉"）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);

