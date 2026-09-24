// scripts/check-plugin-boundary.ts
//
// 插件与宿主之间那条边界的**门禁**。
//
//   node scripts/check-plugin-boundary.ts
//
// ============================================================
// 它守的是什么
// ============================================================
//
// 插件与宿主现在共享同一个 JS 上下文，因此今天**没有**真正的隔离（见
// docs/02-开发指南/插件开发/插件系统架构.md 第 6.3 节）。真正的隔离要靠把插件挪到
// 独立 realm，而一旦跨 realm，**入口就只剩消息传递** —— 消息只能带结构化克隆能表达的
// 东西：不能带函数、类实例、原型链、DOM 节点。
//
// 所以每一个跨边界成员都必须能回答一句："它跨得过去吗？"
//
// 这个脚本把那份回答（`src/services/pluginBoundary.ts`）**钉在实际接线上**，
// 分四层：
//
//   1. **成员名单**：边界清单 = `createContext()` / `host` 对象 / `ModulithHost` 接口
//      实际暴露的东西。新增成员而没在清单里分类 → 失败。
//   2. **单一真源**：`HOST_CAPABILITIES` 必须从清单派生，不能又变回手写字面量。
//   3. **能力方法**：`ctx` 上每个能力句柄的方法，入参/返回值里**不许有函数** ——
//      除非在下面的豁免表里逐条写明理由。这是"v2 能不能换成消息往返"的唯一前提。
//   4. **文档**：清单与文档里的边界表必须一致。
//
// ============================================================
// 为什么这些断言值得写
// ============================================================
//
// 它们防的不是"今天的 bug"，而是**一种会安静积累的债**：每加一个传引用的 API，
// 就多一块将来要重写的东西，而这件事在本地没有任何症状 —— 代码能跑、检查全绿、
// 插件也能装。等到真去做隔离时，欠的账一次性到期。
//
// 与 `check-contributions.ts` 同一手法：把判据本身钉下来，而不是指望有人记得。
// 那个脚本里原本有一份 `REFERENCE_PASSING` / `VALUE_PASSING` 局部数组，正是本脚本
// 第 1、2 层要取代的东西 —— 它当时只在"宿主表面"上生效，`ctx` 的 17 个成员一个都
// 没被回答过。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectObjectLiterals,
  identifierText,
  interfaceMemberNames,
  objectKeysAt as lookupObjectKeys,
} from './source-ast.ts';

import {
  HOST_CAPABILITIES,
  CONTRIBUTION_KINDS,
  ACTIVATION_EVENT_NAMES,
} from '../src/services/pluginContributions.ts';
import {
  boundaryNames,
  callableMembers,
  capabilityMethods,
  capabilityNames,
  countByKind,
  findMember,
  isValueShaped,
  methodsNeedingWork,
  valueShapedMembers,
  type BoundarySurface,
} from '../src/services/pluginBoundary.ts';

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

function section(title: string): void {
  console.log(`\n${title}：`);
}

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string => readFileSync(resolve(here, relative), 'utf8');

const runtimeSource = readSource('../src/services/pluginRuntime.ts');
const contributionsSource = readSource('../src/services/pluginContributions.ts');
const boundarySource = readSource('../src/services/pluginBoundary.ts');
const architectureDoc = readSource('../docs/02-开发指南/插件开发/插件系统架构.md');
const apiDoc = readSource('../docs/02-开发指南/插件开发/宿主API参考.md');

// ============================================================
// 源码解析：一律走 TypeScript 自己的 parser
// ============================================================
//
// 这里曾经是三段手写文本匹配：`blockFrom`、`keysAtIndent`、`memberNames`。
// 它们连续被真实代码打穿，报出十几条假失败 —— 而假失败的代价是让人连真的那条
// 一起忽略。解析逻辑现在统一在 `scripts/source-ast.ts`，与
// `check-contributions.ts` 共用同一份。

const OBJECT_LITERALS = collectObjectLiterals(runtimeSource);

// ============================================================
// 1. 清单必须覆盖实际接线
// ============================================================
section('边界清单与实际接线');

{
  const hostInterfaceKeys = interfaceMemberNames(runtimeSource, 'ModulithHost');
  const hostObjectKeys = lookupObjectKeys(OBJECT_LITERALS, 'installHostGlobals', ['host']);
  const contextKeys = lookupObjectKeys(OBJECT_LITERALS, 'createContextFor', ['return']);

  check(hostInterfaceKeys !== null, '找到 ModulithHost 接口');
  check(hostObjectKeys !== null, '找到 installHostGlobals 里的 host 对象');
  check(contextKeys !== null, '找到 createContext 返回的上下文对象');

  const surfaces: ReadonlyArray<{
    surface: BoundarySurface;
    label: string;
    actual: string[] | null;
  }> = [
    { surface: 'host', label: '宿主表面（Modulith.*）', actual: hostInterfaceKeys },
    { surface: 'context', label: '上下文表面（ctx.*）', actual: contextKeys },
  ];

  for (const item of surfaces) {
    if (item.actual === null) {
      check(false, `${item.label}：解析出了成员列表（解析失败会让下面两条断言变成假通过）`);
      continue;
    }

    const manifest = boundaryNames(item.surface).slice().sort();
    const actual = item.actual.slice().sort();

    check(
      actual.length > 0,
      `${item.label}：解析出了成员列表（解析失败会让下面两条断言变成假通过）`
    );

    const unclassified = actual.filter((name) => !manifest.includes(name));
    const stale = manifest.filter((name) => !actual.includes(name));

    check(
      unclassified.length === 0,
      `${item.label}：实际暴露的每个成员都在边界清单里（未登记：${unclassified.join('、') || '无'}）` +
        ` —— 新增成员必须在 src/services/pluginBoundary.ts 里分类：它传的是值、对象，还是函数？`
    );
    check(
      stale.length === 0,
      `${item.label}：清单里没有已经消失的成员（幽灵条目：${stale.join('、') || '无'}）`
    );
  }

  // host 对象与 ModulithHost 接口必须一致：接口是给插件作者看的契约，
  // 对象是真正注入的东西，两者不一致时"类型说有、运行时没有"。
  if (hostObjectKeys !== null && hostInterfaceKeys !== null) {
    const objectSorted = hostObjectKeys.slice().sort();
    const interfaceSorted = hostInterfaceKeys.slice().sort();
    check(
      objectSorted.join(',') === interfaceSorted.join(','),
      `注入的 host 对象与 ModulithHost 接口逐字一致（对象多：${objectSorted
        .filter((k) => !interfaceSorted.includes(k))
        .join('、') || '无'}；接口多：${interfaceSorted
        .filter((k) => !objectSorted.includes(k))
        .join('、') || '无'}）`
    );
  }
}

// ============================================================
// 2. 能力表必须从清单派生
// ============================================================
section('单一真源');

{
  check(
    HOST_CAPABILITIES.host.join(',') === boundaryNames('host').join(','),
    'HOST_CAPABILITIES.host 等于边界清单的宿主成员（顺序也一致）'
  );
  check(
    HOST_CAPABILITIES.context.join(',') === boundaryNames('context').join(','),
    'HOST_CAPABILITIES.context 等于边界清单的上下文成员（顺序也一致）'
  );

  // 光比较值不够：如果有人把数组字面量抄回 pluginContributions.ts，值可能一时相同，
  // 但两份副本从那一刻起就开始各自漂移。所以这里断言它**确实**在调用派生函数。
  check(
    contributionsSource.includes("boundaryNames('host')") &&
      contributionsSource.includes("boundaryNames('context')"),
    'HOST_CAPABILITIES 确实从 pluginBoundary 派生（不是又抄了一份字面量）'
  );

  // 反向保护：清单本身不许把成员名再抄一遍 —— 它只应该是唯一那份。
  const hostLiteralCount = (boundarySource.match(/const HOST_MEMBERS/g) ?? []).length;
  const contextLiteralCount = (boundarySource.match(/const CONTEXT_MEMBERS/g) ?? []).length;
  check(
    hostLiteralCount === 1 && contextLiteralCount === 1,
    '边界清单里每个表面只有一处成员定义'
  );

  check(
    HOST_CAPABILITIES.api === 1,
    '能力表版本仍是 1（边界清单只是补登记，没有改变对外契约）'
  );
  check(
    HOST_CAPABILITIES.contributions.join(',') === CONTRIBUTION_KINDS.join(','),
    '贡献点名单未受边界清单影响'
  );
  check(
    HOST_CAPABILITIES.activationEvents.join(',') === ACTIVATION_EVENT_NAMES.join(','),
    '激活事件名单未受边界清单影响'
  );
}

// ============================================================
// 3. 清单自身要自洽
// ============================================================
section('清单自洽');

{
  const kinds = ['value', 'handle', 'callable', 'host-object'] as const;
  const migrations = ['as-is', 'rpc', 'message', 'pass-data', 'bootstrap-snapshot'] as const;

  let badKind = 0;
  let badMigration = 0;
  let emptyNote = 0;

  for (const surface of ['host', 'context'] as const) {
    const names = boundaryNames(surface);
    if (new Set(names).size !== names.length) {
      check(false, `${surface}：成员名不重复`);
    }
    for (const name of names) {
      const member = findMember(surface, name);
      if (!member) continue;
      if (!kinds.includes(member.kind)) badKind += 1;
      if (!migrations.includes(member.migration)) badMigration += 1;
      if (member.note.trim().length === 0) emptyNote += 1;
    }
  }

  check(badKind === 0, '每个成员的 kind 都是三种取值之一');
  check(badMigration === 0, '每个成员的 migration 都是四种取值之一');
  check(emptyNote === 0, '每个成员都写明了「它是什么」（note 非空）');

  // `as-is` 只对真正的值成立。写错方向恰好是最危险的方向 ——
  // 把一个过不去的东西标成"原样可用"，等于把迁移面藏起来。
  const wrongAsIs = (['host', 'context'] as const).flatMap((surface) =>
    boundaryNames(surface)
      .map((name) => findMember(surface, name))
      .filter((member) => member !== undefined && member.migration === 'as-is')
      .filter((member) => member.kind !== 'value')
      .map((member) => `${surface}.${member.name}`)
  );
  check(
    wrongAsIs.length === 0,
    `标为 as-is 的成员都是纯数据（可疑：${wrongAsIs.join('、') || '无'}）`
  );

  // 反向：值不该被标成需要 RPC/消息。多一层包装是多余的迁移成本。
  const overEngineered = (['host', 'context'] as const).flatMap((surface) =>
    boundaryNames(surface)
      .map((name) => findMember(surface, name))
      .filter((member) => member !== undefined && member.kind === 'value')
      .filter((member) => member.migration !== 'as-is')
      .map((member) => `${surface}.${member.name}`)
  );
  check(
    overEngineered.length === 0,
    `纯数据成员都标为 as-is（可疑：${overEngineered.join('、') || '无'}）`
  );

  // **`callable` 与 `migration: 'as-is'` 不可能同时成立。**
  //
  // 这条是本文件里最值钱的一条断言。它挡的是一种具体而危险的写法：把某个成员标成
  // "原样可用"，而它其实是个函数 —— 于是它的迁移面在清单里彻底消失，等到真去做
  // 隔离时才会浮出来。`React` 与 `Fragment` 当初就是这么被误判成安全的
  // （它们曾被归到"有等价数据形态"那一类里）。
  const callableButAsIs = (['host', 'context'] as const).flatMap((surface) =>
    boundaryNames(surface)
      .map((name) => findMember(surface, name))
      .filter((member) => member !== undefined)
      .filter((member) => member.kind === 'callable' && member.migration === 'as-is')
      .map((member) => `${surface}.${member.name}`)
  );
  check(
    callableButAsIs.length === 0,
    `没有把函数标成"原样可用"（可疑：${callableButAsIs.join('、') || '无'}）`
  );

  // 同一方向上的另一半：**对象形态与宿主对象也不能是"原样可用"**。
  //
  // 一个对象今天就跨不过去（它是个引用），所以把它标成 as-is 与把函数标成 as-is
  // 是同一类错误 —— 迁移面被藏起来了。`React` 当初走的就是这条路。
  const nonValueButAsIs = (['host', 'context'] as const).flatMap((surface) =>
    boundaryNames(surface)
      .map((name) => findMember(surface, name))
      .filter((member) => member !== undefined)
      .filter(
        (member) =>
          member.kind !== 'value' && member.migration === 'as-is'
      )
      .map((member) => `${surface}.${member.name}（${member.kind}）`)
  );
  check(
    nonValueButAsIs.length === 0,
    `只有 value 能标"原样可用"（可疑：${nonValueButAsIs.join('、') || '无'}）` +
      ` —— 对象与函数都是引用，今天跨不过去；它们必须写明 v2 的去处`
  );

  // `isValueShaped` 与 kind 是派生关系，不该出现第三种说法。
  // 这里刻意用"与 kind 的映射一致"来表达，而不是断言某个方向的真值 ——
  // 后者会随分类扩展而变，前者不会。
  const inconsistent = (['host', 'context'] as const).flatMap((surface) =>
    boundaryNames(surface)
      .map((name) => findMember(surface, name))
      .filter((member) => member !== undefined)
      .filter((member) => isValueShaped(member.kind) !== (member.kind === 'value' || member.kind === 'handle'))
      .map((member) => `${surface}.${member.name}`)
  );
  check(inconsistent.length === 0, 'isValueShaped 与 kind 的判断一致（只有 value 与 handle 是值形态）');

  // 五个 migration 取值都该有实际用例。某个取值长期没人用，说明分类里有一样是
  // 为了对称而加的空壳 —— 空壳会让人觉得"这里已经考虑过了"。
  const usedMigrations = new Set(
    (['host', 'context'] as const).flatMap((surface) =>
      boundaryNames(surface)
        .map((name) => findMember(surface, name)?.migration)
        .filter((value): value is (typeof migrations)[number] => value !== undefined)
    )
  );
  const unusedMigrations = migrations.filter((value) => !usedMigrations.has(value));
  check(
    unusedMigrations.length === 0,
    `五个 migration 取值都在使用（未使用：${unusedMigrations.join('、') || '无'}）`
  );
}

// ============================================================
// 4. 能力方法：逐个登记，并对着运行时实现核对
// ============================================================
//
// 这一层是整份检查里**唯一真正对着 v2 的**：`ctx` 上的 12 个能力对象全部标为
// `handle`，而"换成代理"可行的前提就是"每个方法的参数与返回值都是值"。
//
// 两件事分开做，因为它们会失败的原因不同：
//
//   * **覆盖**：每个能力对象下的方法清单，必须与实际运行时实现里的方法名对得上。
//     新增方法是**允许**的，但不允许"加了却没人登记 io 形态"。
//   * **形态**：`io` 为 `callable` / `host-object` 的方法被逐一列出并计数。
//     它们不是错误，是 v2 的工作量 —— 但必须**可见**，否则会在做隔离时集中爆发。

section('能力方法');

{
  /**
   * `ctx` 上的能力对象 → 它在 `pluginRuntime.ts` 里的工厂函数名。
   *
   * 这张表指向**运行时实现**而不是类型声明：插件真正拿到的是前者，
   * 而两者曾经对不上（例如类型里声明了 `notifications.success`、运行时确实也有，
   * 但类型文件里的方法顺序与运行时不同）。
   */
  const CAPABILITY_FACTORY: ReadonlyArray<{ member: string; factory: string; path: string[] }> = [
    { member: 'storage', factory: 'pluginStorage', path: ['return'] },
    { member: 'http', factory: 'pluginHttp', path: ['return'] },
    { member: 'logger', factory: 'pluginLogger', path: ['return'] },
    { member: 'notifications', factory: 'pluginNotifications', path: ['return'] },
    { member: 'events', factory: 'pluginEvents', path: ['return'] },
    { member: 'launcher', factory: 'pluginLauncher', path: ['return'] },
    { member: 'icons', factory: 'pluginFileIcons', path: ['return'] },
    { member: 'shell', factory: 'pluginShell', path: ['return'] },
    { member: 'fileDrop', factory: 'pluginFileDrop', path: ['return'] },
    { member: 'audio', factory: 'pluginAudio', path: ['return'] },
    { member: 'clipboard', factory: 'pluginClipboard', path: ['return'] },
    { member: 'settings', factory: 'pluginSettingsAPI', path: ['return'] },
    // 唯一一个没有独立工厂的：它是在上下文工厂的返回对象里直接写出来的字面量
    { member: 'disposables', factory: 'createContextFor', path: ['return', 'disposables'] },
  ];

  const registered = capabilityNames().slice().sort();
  const expected = CAPABILITY_FACTORY.map((item) => item.member).slice().sort();

  check(
    registered.join(',') === expected.join(','),
    `登记了方法清单的能力对象与门禁逐一对应（清单：${registered.join('、')}）`
  );

  let totalMethods = 0;
  for (const item of CAPABILITY_FACTORY) {
    const actual = lookupObjectKeys(OBJECT_LITERALS, item.factory, item.path);
    if (actual === null) {
      check(
        false,
        `在 ${item.factory} 的 ${item.path.join('/')} 处找到对象字面量（ctx.${item.member} 的运行时实现）`
      );
      continue;
    }

    const declared = capabilityMethods(item.member);
    check(
      declared.length > 0,
      `${item.member}：登记了方法清单（为空会让下面的覆盖断言变成假通过）`
    );

    const registeredNames = declared.map((method) => method.name);
    const unregistered = actual.filter((name) => !registeredNames.includes(name));
    const stale = registeredNames.filter((name) => !actual.includes(name));

    totalMethods += declared.length;

    check(
      unregistered.length === 0,
      `ctx.${item.member}：运行时每个方法都登记了 io 形态（未登记：${unregistered.join('、') || '无'}）`
    );
    check(
      stale.length === 0,
      `ctx.${item.member}：登记的每个方法在运行时都存在（幽灵：${stale.join('、') || '无'}）`
    );

    // 每个已登记方法的 io 必须是合法取值
    const badIo = declared.filter(
      (method) => !['value', 'handle', 'callable', 'host-object'].includes(method.io)
    );
    check(badIo.length === 0, `ctx.${item.member}：io 取值合法（可疑：${badIo.map((m) => m.name).join('、') || '无'}）`);
  }

  check(totalMethods >= 40, `能力方法总数已登记（当前 ${totalMethods} 个）`);

  // io 与 migration 的方向必须一致：函数形态不能标"原样可用"。
  const methodsCallableButAsIs = methodsNeedingWork()
    .filter((entry) => entry.method.migration === 'as-is')
    .map((entry) => `${entry.capability}.${entry.method.name}`);
  check(
    methodsCallableButAsIs.length === 0,
    `没有把函数形态或宿主对象的方法标成"原样可用"（可疑：${methodsCallableButAsIs.join('、') || '无'}）`
  );
}

// ============================================================
// 5. 迁移面是可见的
// ============================================================
//
// 这里**不声明"哪些过不去"**，因为那句话需要一个完整的判断（代理能不能救它），
// 而清单只登记了形态。它声明的是三件可判定的事，且三者要分开看：
//
//   * `callable`    —— 函数形态。**没有代理能救**：结构化克隆明确拒绝函数。要重新设计。
//   * `host-object` —— 宿主对象。有明确出路：把数据剥出来给插件。
//   * `handle`      —— 对象形态。改法是机械的：对象换成代理、方法换成消息往返。
//
// 把它们混成一个"阻塞项"数字会掩盖这件事，所以分栏报。

section('迁移面');

{
  const hostCallables = callableMembers('host');
  const contextCallables = callableMembers('context');
  const hostObjects = (['host', 'context'] as const).flatMap((surface) =>
    boundaryNames(surface)
      .map((name) => findMember(surface, name))
      .filter((member) => member !== undefined && member.kind === 'host-object')
      .map((member) => `${surface === 'host' ? 'Modulith' : 'ctx'}.${member.name}`)
  );
  const hostHandles = valueShapedMembers('host').filter((m) => m.kind === 'handle');
  const contextHandles = valueShapedMembers('context').filter((m) => m.kind === 'handle');

  console.log('  函数形态（要重新设计，代理救不了）：');
  for (const member of [...hostCallables, ...contextCallables]) {
    const surface = hostCallables.includes(member) ? 'Modulith' : 'ctx';
    console.log(`      ${surface}.${member.name} → ${member.migration}`);
  }
  console.log('  宿主对象形态（剥出数据即可）：');
  for (const name of hostObjects) console.log(`      ${name}`);
  console.log('  对象形态（换成代理即可）：');
  for (const member of [...hostHandles, ...contextHandles]) {
    const surface = hostHandles.includes(member) ? 'Modulith' : 'ctx';
    console.log(`      ${surface}.${member.name}`);
  }

  const hostKinds = countByKind('host');
  const contextKinds = countByKind('context');
  console.log(
    `  成员分类：宿主 ${hostKinds.value} 值 / ${hostKinds.handle} 对象 / ${hostKinds.callable} 函数 / ${hostKinds['host-object']} 宿主对象；` +
      `上下文 ${contextKinds.value} 值 / ${contextKinds.handle} 对象 / ${contextKinds.callable} 函数 / ${contextKinds['host-object']} 宿主对象`
  );

  const needWork = methodsNeedingWork();
  console.log(`  方法层面要动的共 ${needWork.length} 条：`);
  for (const entry of needWork) {
    console.log(`      ctx.${entry.capability}.${entry.method.name}（${entry.method.io} → ${entry.method.migration}）`);
  }

  check(
    hostCallables.length + contextCallables.length > 0,
    '函数形态的成员仍被登记（若变成 0，说明清单已过期或判断写错了）'
  );

  // 这几条把"迁移面有多大、在哪"钉住。它们不禁止变化，而是让变化必须是一次
  // 有意识的决定：数字变了就得回来看一眼是不是漏登记了什么。
  check(
    hostCallables.length === 8,
    `宿主表面有 8 个函数形态成员（当前 ${hostCallables.length}）—— 变化时请同步 docs/08-规划/插件架构与API-v1.5范围.md`
  );
  check(
    contextCallables.length === 0,
    `ctx 上没有函数形态的**成员**（当前 ${contextCallables.length} 个）`
  );
  check(
    contextHandles.length === 13,
    `ctx 上有 13 个对象形态成员要换成代理（当前 ${contextHandles.length}）`
  );
  // 这一条是 v1.5 最该被看见的数字：方法层面的真实工作量。
  check(
    needWork.length > 0,
    `方法层面确实存在要动的条目（当前 ${needWork.length} 条）—— 若为 0，说明 io 登记已经失效`
  );
}

// ============================================================
// 6. 文档与实际一致
// ============================================================
section('文档');

{
  // 架构文档第 6 节是"当前实际强制的限制"，插件作者会照着它判断能不能信任插件。
  // 边界清单是那句话的机器可读版本，两者必须对得上。
  check(
    architectureDoc.includes('同一个 JavaScript 上下文') ||
      architectureDoc.includes('同一个 WebView'),
    '插件系统架构文档仍声明「共享同一个 JS 上下文」'
  );

  // 文档里必须指出"权限只在经由宿主通道时生效"这件事，否则用户会以为它是隔离。
  check(
    /只约束经由它发起的请求|只约束经由|经由宿主通道/.test(architectureDoc),
    '架构文档写明了「权限只约束经由宿主通道的调用」'
  );

  // 边界清单是新增的事实来源，文档必须指向它 —— 否则下一个人只会读到散文。
  check(
    architectureDoc.includes('pluginBoundary') || architectureDoc.includes('边界清单'),
    '架构文档指向了边界清单（pluginBoundary.ts）'
  );

  // 宿主 API 参考是插件作者查签名的地方，它至少要提到 v2 会改的那几处。
  check(
    apiDoc.includes('useModuleActive') || apiDoc.includes('React'),
    '宿主 API 参考确实覆盖宿主表面（解析失败会让上面那条变成假通过）'
  );

  // 计数出现在文档里就一定会漂移，所以只断言"提到了清单"，不断言具体数字。
  const manifestHasAll = (['host', 'context'] as const).every((surface) =>
    boundaryNames(surface).every((name) => boundarySource.includes(`name: '${name}'`))
  );
  check(manifestHasAll, '清单里每个成员都有显式的 name 字段');
}

// ============================================================
// 7. 参考示例必须走显式引导
// ============================================================
//
// `samples/reference` 是仓库里**唯一**逐个示范核心宿主接口的地方，插件作者会照抄它。
// 如果它继续用 `createContext()`（靠"当前正在加载哪个插件"这个隐式全局），
// 那么每一个照抄它的人都会继承那个将来必须改掉的形状 —— 而这正是 `Modulith.run`
// 要消除的东西。
//
// 这条断言是**反"新 API 无人使用"**的：一个只有文档、没有真实调用方的入口，
// 会在有人第一次用它的时候才暴露问题。参考示例是它最低成本的常驻调用方。

section('参考示例');

{
  const referencePath = resolve(here, '../samples/reference/index.js');
  if (!existsSync(referencePath)) {
    check(false, '找到 samples/reference/index.js（它是 api: 2 的常驻调用方）');
  } else {
    const sample = readFileSync(referencePath, 'utf8');
    // **只看标识符，不看原文。** 上面那段说明文字里写着 `Modulith.createContext()`，
    // 而按文本匹配会把它当成一次真实调用 —— 于是"不调用它"这条断言会在
    // **解释为什么不调用它**的地方失败。
    //
    // 这是本项目踩过的同一类坑（构建脚本曾因为"按文本计数、对注释视而不见"而算错过
    // 命令数）。判据要看的是**代码**，不是文件里的字。
    const names = identifierText(sample).split(' ');

    check(
      names.includes('run'),
      '参考示例用 Modulith.run() 取上下文（显式引导，而不是隐式全局）'
    );
    check(
      !names.includes('createContext'),
      '参考示例不再调用 Modulith.createContext()（照抄它的人不该继承隐式全局）'
    );
    // 引导数据里必须真的用上至少一项"只有 run 能给"的东西，
    // 否则这个示例等于换了个写法却什么也没多得到。
    const usedBootstrapFields = [
      'pluginId',
      'pluginVersion',
      'hostVersion',
      'activationEvent',
      'settings',
      'capabilities',
    ];
    check(
      names.includes('bootstrap') && usedBootstrapFields.some((field) => names.includes(field)),
      '参考示例用到了引导数据里的字段（否则 run 对读者没有任何新增信息）'
    );
  }
}

// ============================================================
// 8. clipboard 的强制程度不许被"顺手加固"
// ============================================================
//
// 剪贴板是浏览器 API：`navigator.clipboard` 在页面脚本里本来就可达，所以
// **在 Rust 侧加一道门不会让强制变强**，只会制造一种"更难绕过"的假象。
//
// 这条断言挡的是一个很自然、很善意的改动：有人看到 `clipboard` 是
// `Frontend`，觉得"其它设备级权限都在 Rust 侧，这个也该补上"，于是加一条
// `plugin_clipboard_*` 命令并把它标成 `Host`。
//
// 那样做会让权限表声称一项它并未提供的保障 —— 正是 `sandboxLevel` 被删掉的理由
// （"不要在阶段一就假装拥有了阶段三的保障"）。要真的变强，只能等进程级隔离。

section('clipboard 的强制程度');

{
  const permissionsSource = readSource('../src-tauri/src/modules/plugins/permissions.rs');

  // `Self::Clipboard => Spec { ... }` 这一段里的 enforcement
  const clipboardBlock = permissionsSource.slice(
    permissionsSource.indexOf('Self::Clipboard => Spec {')
  );
  const clipboardSpec = clipboardBlock.slice(0, clipboardBlock.indexOf('},'));

  check(
    clipboardSpec.includes('F::Frontend'),
    'clipboard 的 enforcement 是 Frontend —— 它**不能**在 Rust 侧被真正强制'
  );
  check(
    !clipboardSpec.includes('F::Host'),
    'clipboard **不得**被标成 Host（那会让权限表声称一项它没有的保障）'
  );
  check(
    /navigator\.clipboard/.test(clipboardSpec),
    'clipboard 的说明里写明了为什么它强不了（必须提到 navigator.clipboard）'
  );

  // 同一条理由也要出现在权限表文档里，否则读者只看文档会以为它和别的项一样强。
  const manifestDoc = readSource('../docs/02-开发指南/插件开发/清单文件参考.md');
  check(
    manifestDoc.includes('navigator.clipboard'),
    '清单文件参考的权限表里也写明了 clipboard 强制较弱的原因'
  );
}

// ============================================================
// 9. 开发模式自动重载的接线
// ============================================================
//
// 自动重载由三段拼成，任何一段断了它都会**静默地不工作** —— 而"不工作"的表现是
// "改了代码没反应"，与"作者改错了"完全一样。因此把接线点本身钉住。
//
// 三段是：
//   1. 后端能给出产物的指纹（`dev_plugin_fingerprints`）
//   2. 运行时能答"哪些插件是开发链接"（`devPluginIds`）
//   3. 启动流程在**清单已在手之后**真的把它启起来
//
// 第 3 条的时机很关键：`devPluginIds()` 读的是运行时的 `installed`，放早了会看到空列表，
// 于是监听根本不会启动 —— 而这不会有任何报错。

section('开发模式自动重载');

{
  const devWatch = resolve(here, '../src/services/pluginDevWatch.ts');
  const bootSource = readSource('../src/services/boot.ts');
  const commandsSource = readSource('../src-tauri/src/modules/plugins/commands.rs');
  const libSource = readSource('../src-tauri/src/lib.rs');

  check(existsSync(devWatch), '存在 src/services/pluginDevWatch.ts');

  if (existsSync(devWatch)) {
    const watchSource = readFileSync(devWatch, 'utf8');

    check(
      watchSource.includes("invoke<Fingerprints>('dev_plugin_fingerprints')"),
      '监听器用后端指纹命令判断"变了没有"（不把产物读回前端比内容）'
    );
    check(
      watchSource.includes('devPluginIds()'),
      '监听器用运行时的 devPluginIds() 判断要不要启动'
    );
    check(
      /if \(ids\.length === 0\)[\s\S]{0,200}return;/.test(watchSource),
      '没有开发链接插件时**不建定时器**（普通用户不该为开发模式付出代价）'
    );
    check(
      watchSource.includes('SETTLE_MS'),
      '有冷静期，避免一次保存触发两次重载、读到半成品产物'
    );
    check(
      watchSource.includes('dirty'),
      '变化是**累积**的而不是丢弃的（丢掉会让作者以为"改一次没反应"）'
    );
  }

  // 后端命令必须注册，否则 invoke 会在运行期才失败 —— 而失败被 catch 吞掉后
  // 表现就是"自动重载不工作"。
  check(
    commandsSource.includes('pub async fn dev_plugin_fingerprints'),
    '后端定义了 dev_plugin_fingerprints 命令'
  );
  check(
    libSource.includes('dev_plugin_fingerprints'),
    'dev_plugin_fingerprints 已注册进 invoke_handler'
  );
  check(
    commandsSource.includes('dev_source'),
    '指纹命令只处理**开发链接**的插件（其代码才来自源目录）'
  );

  // 启动接线：放晚了会看到空列表，放早了同样 —— 必须在清单到手之后。
  check(
    bootSource.includes('startPluginDevWatch'),
    '启动流程调用了 startPluginDevWatch'
  );
  check(
    bootSource.includes('loadPluginsInBackground') &&
      /loadPluginsInBackground\([^)]*\)[\s\S]{0,200}startPluginDevWatch/.test(bootSource),
    '后台加载路径在**加载完成之后**才启动监听（那时 installed 才填好）'
  );

  // 重载必须忘掉激活状态，否则懒激活插件不会重新执行 ——
  // 这一条既是自动重载能生效的前提，也修掉了"重载后模块空白"这个真实缺陷。
  check(
    /activationStates\.delete\(plugin\.id\)/.test(runtimeSource),
    '重载时清空激活状态（否则懒激活插件在重载后不会重新执行）'
  );
}

// ============================================================
// 10. 不强制的那几项，原因要说得清
// ============================================================
//
// `permissions.rs` 里有四项 `enforcement: none`，而它们**不强制的原因各不相同**：
//
//   * `filesystem-write` / `filesystem-scoped` —— 有语义、缺检查点（后者还缺授权模型）
//   * `native-module`  —— **这一能力不存在**（Tauri 插件必须随应用编译）
//   * `dev-tools`      —— **这一项是冗余的**（共享页面环境，插件本来就能开控制台）
//
// 后两项的读法**恰好相反**：一个是真的拿不到，一个是不需要授权。把它们都写成"否"
// 就是在抹平这个区别，而用户会据此做出不同判断。
//
// 这一节挡两种退化：
//   1. 描述被改回一句中性的"暂不强制"，于是"为什么"丢失；
//   2. 界面文案重新出现承诺性的措辞（"尚未"），暗示以后会强制。

section('不强制项的说明');

{
  /** 取某个权限枚举值的 `Spec { ... }` 文本 */
  const permissionSpecSource = readSource('../src-tauri/src/modules/plugins/permissions.rs');
  const specOf = (variant: string): string => {
    // 用字符串拼接而不是模板字面量：写模板字面量时 `${variant}` 会在**本文件**
    // 里被当成插值，于是要搜索的模式变成 `Self. => Spec {`，永远找不到。
    // 这正是"判据本身写错"的一类 —— 这里踩过一次，所以留个记号。
    const marker = 'Self::' + variant + ' => Spec {';
    const start = permissionSpecSource.indexOf(marker);
    if (start === -1) return '';
    return permissionSpecSource.slice(start, permissionSpecSource.indexOf('},', start));
  };

  const nativeModule = specOf('NativeModule');
  const devTools = specOf('DevTools');

  check(nativeModule.length > 0, '找到 NativeModule 的描述');
  check(devTools.length > 0, '找到 DevTools 的描述');

  // 各自的原因必须写出来，且不能写成同一句话 —— 原因本来就不一样。
  check(
    /不存在|无法引入|拿不到/.test(nativeModule),
    'native-module 的说明写明了「这一能力不存在」'
  );
  check(
    /冗余|本来就|谁都能/.test(devTools),
    'dev-tools 的说明写明了「这一项是冗余的」'
  );
  check(
    nativeModule !== devTools,
    '两项的说明不是同一句（它们的原因相反，不该被写成一样）'
  );
  check(
    !/可绕过沙箱限制/.test(nativeModule),
    'native-module 不再宣称「可绕过沙箱限制」（那是它做不到的事）'
  );

  // 界面文案不许承诺"以后会强制"。这条最容易被顺手改回去。
  const marketUi = readSource('../src/modules/pluginMarket/PluginMarket.tsx');
  check(
    !/尚未强制/.test(marketUi),
    '安装确认页不再说「尚未强制」（那是在承诺一件对这些项不会发生的事）'
  );
  check(
    /当前不强制/.test(marketUi),
    '安装确认页改用「当前不强制」，并把原因指向具体描述'
  );

  // 文档里要把四个原因分开列，不能只说一句"其余不影响行为"。
  const manifestDocRaw = readSource('../docs/02-开发指南/插件开发/清单文件参考.md');
  check(
    /缺检查点|缺授权模型/.test(manifestDocRaw),
    '清单文件参考把「缺检查点」与「缺授权模型」分开说明'
  );
  check(
    /能力不存在/.test(manifestDocRaw) && /冗余/.test(manifestDocRaw),
    '清单文件参考把「能力不存在」与「冗余」分开说明'
  );
  check(
    /保留/.test(manifestDocRaw),
    '清单文件参考写明了为什么**保留**而不是删除这两项'
  );
}

// ============================================================
// 汇总
// ============================================================
console.log('');
if (failed > 0) {
  console.error(`${failed} / ${total} 项未通过。`);
  process.exit(1);
}
console.log(`全部通过（${total} 项）。`);
