// scripts/check-contributions.ts
//
// 插件贡献模型的不变量断言。
//
//   node scripts/check-contributions.ts
//
// 为什么值得单独一个脚本：这一批改动的核心是一条**纯数据**路径 ——
// 清单里的 `contributes` / `activationEvents` 决定插件在**一行代码都没执行**时，
// 侧边栏、命令面板、设置页、右键菜单里有什么。它出错的症状极难从界面上看出来
// （少一条命令、少一个设置项、某个插件永不激活、插件被误判为加载失败），
// 因此把判据本身钉下来比端到端测试更有效 —— 与 check-performance 断言修复点是
// 同一手法。
//
// 最后一节对源码做文本核对，防的是「能力表 / 文档声称的能力」与实际接线漂移。
// 这是本项目已经用过的办法（check-performance 核对 Home.tsx / index.css），
// 因为「看起来对、实际不生效」这类缺陷只有把接线点本身钉住才能防它回来。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';import {
  ACTIVATION_EVENT_NAMES,
  CONTRIBUTION_KINDS,
  HOST_CAPABILITIES,
  activationEventArgument,
  activationEventForCommand,
  activationEventForContextMenu,
  activationEventForModule,
  activationEventName,
  commandFullId,
  commandPrefix,
  emptyContributions,
  hasNoContribution,
  normalizeContributions,
  parseActivationEvents,
  resolveLoadContract,
  settingStorageKey,
} from '../src/services/pluginContributions.ts';
import {
  shapeBadgeLabels,
  shapeFromContributions,
  shapeFromIndexKinds,
  shapeFromInstalled,
} from '../src/services/pluginShape.ts';
import { boundaryNames, findMember } from '../src/services/pluginBoundary.ts';
import { readVersionFile } from './version-manager.ts';
import {
  collectObjectLiterals,
  interfaceMemberNames,
  objectKeysAt,
} from './source-ast.ts';

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

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string =>
  readFileSync(resolve(here, relative), 'utf8');

/**
 * 去掉注释，只留代码。
 *
 * 这一节里有几条断言是"某个读取点用的是哪个键名"。它们最初直接对整个文件跑正则，
 * 于是**注释里的示例把断言喂饱了**：把 `validator.rs` 里真正那一行改成别的键之后，
 * 门禁依然是绿的 —— 因为上面几段说明文字里还写着 `engines.modulith`。
 * （变异 M3 就是这么抓出来的。）
 *
 * 状态机而不是正则：`//` 与 `/*` 出现在字符串里是常事（`"https://…"`），
 * 按正则一刀切会把那一行截断，从而漏掉它后面的真代码。
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  // 0 = 代码，1 = 行注释，2 = 块注释，3 = 字符串（' 或 "），4 = 模板字符串
  let state = 0;
  let quote = '';

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (state === 0) {
      if (current === '/' && next === '/') {
        state = 1;
        index += 2;
        continue;
      }
      if (current === '/' && next === '*') {
        state = 2;
        index += 2;
        continue;
      }
      if (current === '"' || current === "'") {
        state = 3;
        quote = current;
      } else if (current === '`') {
        state = 4;
        quote = current;
      }
      out += current;
    } else if (state === 1) {
      if (current === '\n') {
        state = 0;
        out += current;
      }
    } else if (state === 2) {
      if (current === '*' && next === '/') {
        state = 0;
        index += 2;
        continue;
      }
      if (current === '\n') out += current;
    } else {
      // 字符串/模板里：处理转义，遇到同种引号就出来
      if (current === '\\') {
        out += current + (next ?? '');
        index += 2;
        continue;
      }
      if (current === quote) {
        state = 0;
        quote = '';
      }
      out += current;
    }

    index += 1;
  }

  return out;
}

// 成员核对已改用 `scripts/source-ast.ts` 的 AST 查询。原先这里的 `blockFrom` /
// `keysAtIndent` 是"找标记到下一个行首 `}`、再按缩进猜属性名" —— 它们不会说
// "我解析错了"，只会说"你没接线"，因此上下文工厂一改名就报出 17 条假失败。

// ============================================================
// 1. 贡献点的规范化
// ============================================================
console.log('贡献点的规范化：');

{
  const empty = normalizeContributions(undefined);
  check(empty.present === false, '没有 contributes 时 present 为 false');
  check(hasNoContribution(empty.contributions), '没有 contributes 时贡献集为空');
  check(empty.issues.length === 0, '没有 contributes 时不产生问题');
}

{
  const notObject = normalizeContributions('nope');
  check(notObject.present === true, 'contributes 不是对象时仍然算「声明过」');
  check(
    notObject.issues.some((item) => item.level === 'error'),
    'contributes 不是对象时报 error'
  );
}

{
  const { contributions, issues } = normalizeContributions({
    modules: [
      { id: 'port-inspector', name: '端口占用', sidebar: false, priority: 20 },
      { id: 'port-inspector', name: '重复' },
      { name: '缺 id' },
      'nope',
    ],
  });
  check(contributions.modules.length === 1, '模块：保留唯一一条合法条目，重复与非法被丢弃');
  check(contributions.modules[0].sidebar === false, '模块：sidebar 透传');
  check(contributions.modules[0].priority === 20, '模块：priority 透传');
  check(
    issues.filter((item) => item.kind === 'modules' && item.level === 'error').length === 3,
    '模块：重复 id、缺 id、非对象 各报一条 error'
  );
}

{
  const { contributions } = normalizeContributions({
    modules: [{ id: 'bad id', name: 'x' }],
  });
  check(contributions.modules.length === 0, '模块：id 含空格被拒（它会进标签配置与深链）');
}

{
  const { contributions, issues } = normalizeContributions({
    commands: [
      { id: 'refresh', title: '刷新' },
      { id: 'refresh', title: '重复' },
      { id: 'no-title' },
      { command: 'old-draft-field', title: '旧字段名' },
    ],
  });
  check(contributions.commands.length === 2, '命令：两条合法（含旧字段名兼容）');
  check(
    contributions.commands.some((item) => item.id === 'old-draft-field'),
    '命令：接受旧草案字段名 command 作为 id'
  );
  check(
    issues.some((item) => item.message.includes('旧草案字段名')),
    '命令：使用旧字段名时给出 warning'
  );
  check(
    issues.some((item) => item.kind === 'commands' && item.message.includes('重复')),
    '命令：重复 id 报 error'
  );
}

{
  const { contributions, issues } = normalizeContributions({ themes: [{ id: 't' }] });

  /*
   * 这一组原先写作 `issues.every((item) => item.kind !== 'themes')` ——
   * 那是**恒真**的：`ContributionIssue['kind']` 是闭合联合，`'themes'` 根本不在
   * 其中，所以这条断言永远不可能失败。它之所以一直没被发现，是因为
   * `tsc -p tsconfig.node.json` 早就坏了（它会在这里报 TS2367），而那条门禁
   * 从 1.3.0 起就没有真正跑过。修门禁时它自己就冒了出来。
   *
   * 改写成能失败的判据：未知贡献点既不能变成贡献，也不能产生除
   * 「没有认识的贡献点」之外的任何东西。
   */
  check(
    CONTRIBUTION_KINDS.every((kind) => contributions[kind].length === 0),
    '未知贡献点（themes）不产生任何贡献'
  );
  check(
    issues.length === 1 && issues[0].kind === 'contributes' && issues[0].level === 'warning',
    '未知贡献点只产生一条 warning，没有别的副作用'
  );
  check(
    issues.some((item) => item.message.includes('没有任何宿主认识的贡献点')),
    '只有未知贡献点时给出「没有认识的贡献点」warning'
  );
}

// ============================================================
// 2. 设置项
// ============================================================
console.log('\n设置项：');

{
  const { contributions, issues } = normalizeContributions({
    settings: [
      { id: 'interval', label: '刷新间隔', type: 'number', default: 30, min: 1, max: 600 },
      { id: 'notify', label: '变更时通知', type: 'boolean', default: true },
      { id: 'mode', label: '模式', type: 'select', default: 'fast', options: [{ value: 'fast', label: '快' }] },
      { id: 'broken', label: '坏的下拉', type: 'select' },
      { id: 'weird', label: '未知类型', type: 'object' },
      { id: 'mismatch', label: '默认值类型不符', type: 'number', default: 'abc' },
    ],
  });
  check(
    contributions.settings.length === 4,
    '设置：四条合法条目保留（select 无 options 与未知 type 被拒，default 类型不符只丢缺省值）'
  );
  check(contributions.settings[0].default === 30, '设置：number 的 default 透传');
  check(contributions.settings[2].options?.length === 1, '设置：select 的 options 透传');
  check(
    issues.some((item) => item.message.includes('select 但没有可用的 options')),
    '设置：select 缺 options 报 error'
  );
  check(
    issues.some((item) => item.message.includes('type 必须是')),
    '设置：未知 type 报 error'
  );
  check(
    issues.some((item) => item.message.includes('default 与 type')),
    '设置：default 与 type 不匹配时 warning 并丢弃该缺省值'
  );
}

// ============================================================
// 3. 右键菜单：交叉检查
// ============================================================
console.log('\n右键菜单的交叉检查：');

{
  const { contributions, issues } = normalizeContributions({
    commands: [{ id: 'refresh', title: '刷新' }],
    contextMenus: [
      { id: 'menu-refresh', label: '刷新端口', command: 'refresh' },
      { id: 'menu-typo', label: '打错命令名', command: 'refrsh' },
    ],
  });
  check(contributions.contextMenus.length === 1, '菜单：command 指向已声明命令的那条保留');
  check(
    contributions.contextMenus[0].command === 'refresh',
    '菜单：command 字段原样保留（执行时按本地 ID 查找）'
  );
  check(
    issues.some((item) => item.message.includes('未声明的命令')),
    '菜单：command 指向不存在的命令时报 error（这是最难从界面发现的一类笔误）'
  );
}

// ============================================================
// 4. 激活事件
// ============================================================
console.log('\n激活事件：');

{
  const contributions = normalizeContributions({
    modules: [{ id: 'panel', name: '面板' }],
    commands: [{ id: 'refresh', title: '刷新' }],
    contextMenus: [{ id: 'menu', label: '菜单', command: 'refresh' }],
  }).contributions;

  const parsed = parseActivationEvents(
    ['onStartup', 'onModule:panel', 'onCommand:refresh', 'onContextMenu:menu'],
    contributions
  );
  check(parsed.events.length === 4, '四个受支持的事件全部保留');
  check(parsed.issues.length === 0, '正确的事件不产生问题');

  const bad = parseActivationEvents(
    ['onView:x', 'onFile:y', 'onPlugin:z', 'onRestore', 'onModule:panle', 'onCommand:refrsh', 'onContextMenu:men'],
    contributions
  );
  check(bad.events.length === 0, '草案里未实现的事件一律不保留（写了也不会触发）');
  check(
    bad.issues.filter((item) => item.message.includes('不认识激活事件')).length === 4,
    'onView / onFile / onPlugin / onRestore 各报一条「不认识」warning'
  );
  check(
    bad.issues.filter((item) => item.message.includes('指向了未声明')).length === 3,
    '参数指向不存在的东西时各报一条 error（onModule / onCommand / onContextMenu）'
  );

  const dedup = parseActivationEvents(['onStartup', 'onStartup'], contributions);
  check(dedup.events.length === 1, '重复事件去重');
  check(
    dedup.issues.some((item) => item.level === 'warning'),
    '重复事件给出 warning'
  );

  const notArray = parseActivationEvents('onStartup', contributions);
  check(notArray.events.length === 0, 'activationEvents 不是数组时按空处理');
  check(
    notArray.issues.some((item) => item.level === 'error'),
    'activationEvents 不是数组时报 error'
  );
}

console.log('\n激活事件的命名：');
check(activationEventForModule('panel') === 'onModule:panel', 'onModule:<id> 拼装正确');
check(activationEventForCommand('refresh') === 'onCommand:refresh', 'onCommand:<id> 拼装正确');
check(activationEventForContextMenu('menu') === 'onContextMenu:menu', 'onContextMenu:<id> 拼装正确');
check(activationEventName('onModule:panel') === 'onModule', '取事件名');
check(activationEventName('onStartup') === 'onStartup', '无参数事件的名就是它自己');
check(activationEventArgument('onModule:panel') === 'panel', '取事件参数');
check(activationEventArgument('onStartup') === '', '无参数事件的参数是空串');

// ============================================================
// 5. 装载契约真值表
// ============================================================
console.log('\n装载契约：');

{
  const legacy = resolveLoadContract({});
  check(legacy.declarative === false, '没有 contributes → 非声明式（旧式）');
  check(legacy.eager === true, '没有 contributes → 后台加载期执行（与 1.2.0 前逐字一致）');
  check(legacy.events.length === 0, '没有 contributes → 不解析激活事件');
}

{
  const eager = resolveLoadContract({
    contributes: { modules: [{ id: 'm', name: 'M' }] },
    activationEvents: ['onStartup'],
  });
  check(eager.declarative === true, '有 contributes → 声明式');
  check(eager.eager === true, 'onStartup → 后台加载期激活');
}

{
  const lazy = resolveLoadContract({
    contributes: { modules: [{ id: 'm', name: 'M' }] },
    activationEvents: ['onModule:m'],
  });
  check(lazy.declarative === true, '有 contributes → 声明式');
  check(lazy.eager === false, '有事件且不含 onStartup → 按需激活');
}

{
  // 这一条是兼容性的关键：忘写 activationEvents 只应该损失「懒」，
  // 不应该让插件坏掉。反过来（默认不激活）会把配置疏漏放大成故障。
  const forgotten = resolveLoadContract({
    contributes: { commands: [{ id: 'c', title: 'C' }] },
  });
  check(forgotten.declarative === true, '有 contributes 没有 activationEvents → 仍是声明式');
  check(forgotten.eager === true, '有 contributes 没有 activationEvents → 降级为后台加载期激活');
  check(
    forgotten.issues.some((item) => item.message.includes('退化为')),
    '上述降级给出 warning，而不是静默'
  );
}

{
  const typo = resolveLoadContract({
    contributes: { modules: [{ id: 'm', name: 'M' }] },
    activationEvents: ['onModule:typo'],
  });
  check(typo.eager === true, '全部事件都无效时退化为 eager，而不是永不激活');
  check(typo.events.length === 0, '无效事件不进 events 表');
}

{
  // 功能性插件：只声明激活事件，什么都不贡献。
  const service = resolveLoadContract({
    contributes: {},
    activationEvents: ['onStartup'],
  });
  check(service.declarative === true, '空 contributes + onStartup → 声明式（这就是后台服务插件）');
  check(service.eager === true, '后台服务插件在加载期激活');
  check(hasNoContribution(service.contributions), '后台服务插件可以没有任何界面贡献');
  check(
    service.issues.some((item) => item.message.includes('没有任何宿主认识的贡献点')),
    '空 contributes 仍给出 warning（它是笔误的高发写法）'
  );
}

// ============================================================
// 6. 命名
// ============================================================
console.log('\n命名：');
check(
  commandFullId('com.example.foo', 'refresh') === 'plugin:com.example.foo:refresh',
  '命令全局限定名与 pluginRuntime 的前缀格式一致'
);
check(
  commandFullId('a', 'b').startsWith(commandPrefix('a')),
  '限定名一定落在自己的前缀里（否则批量注销会漏）'
);
check(settingStorageKey('interval') === '__host__.setting.interval', '设置项的存储键带保留前缀');

// ============================================================
// 7. 能力表与源码的一致性
// ============================================================
console.log('\n能力表：');

{
  check(HOST_CAPABILITIES.api === 1, '能力表版本为 1');
  check(
    HOST_CAPABILITIES.contributions.join(',') === CONTRIBUTION_KINDS.join(','),
    'capabilities.contributions 等于宿主真正消费的贡献点名单'
  );
  check(
    HOST_CAPABILITIES.activationEvents.join(',') === ACTIVATION_EVENT_NAMES.join(','),
    'capabilities.activationEvents 等于宿主真正消费的激活事件名单'
  );
  check(
    !Object.prototype.hasOwnProperty.call(HOST_CAPABILITIES, 'permissions'),
    '能力表刻意不含权限名（权限的权威是后端枚举，第二份副本必然漂移）'
  );
  check(
    HOST_CAPABILITIES.host.includes('capabilities'),
    '能力表把自己也列进去（插件可以据此判断这个字段存在）'
  );
}

{
  const runtime = readSource('../src/services/pluginRuntime.ts');
  const types = readSource('../src/types/plugin.ts');

  // 源码解析统一走 `scripts/source-ast.ts`（TypeScript parser），不再按缩进匹配。
  // 这里曾经用 `keysAtIndent` 猜属性名 —— 上下文工厂改名之后它读到的是过期数据，
  // 报出 17 条"createContext 没有返回它们"。手写解析器的失败方式就是这样：
  // 它不会说"我解析错了"，只会说"你没接线"。
  const literals = collectObjectLiterals(runtime);
  const interfaceKeys = interfaceMemberNames(runtime, 'ModulithHost');
  const objectKeys = objectKeysAt(literals, 'installHostGlobals', ['host']);
  const contextKeys = objectKeysAt(literals, 'createContextFor', ['return']);

  check(interfaceKeys !== null, '找到 ModulithHost 接口');
  check(objectKeys !== null, '找到 installHostGlobals 里的 host 对象');
  check(contextKeys !== null, '找到上下文工厂返回的对象');
  if (interfaceKeys === null || objectKeys === null || contextKeys === null) {
    // 解析失败时不再往下走：下面每条断言都会因为空数组而"通过"或"失败"得毫无意义
    console.error('  源码解析未命中，跳过本节的成员核对');
  }

  // ----------------------------------------------------------
  // 执行模型：**过渡**，成本由一条接口纪律压住
  //
  // 插件与宿主现在同处一个 WebView、一个 JS 上下文。这是**过渡状态**，不是永久形态 ——
  // 触发真正隔离的条件必须是可判定的（当前定为「索引里出现第一个非维护者发布的插件」）。
  //
  // 过渡的全部成本只取决于一件事：**新加的宿主 API 会不会给将来添迁移面**。判据是一条：
  //
  //     传值进、传值出；传引用的，将来都得改。
  //
  // 因为跨 realm 之后函数与对象引用过不去，只能变成「按 ID 调用 + 消息传递」。
  // 1.2.0 的声明式贡献正是为此而做：registerModule / registerCommand 从「交出组件、
  // 交出函数」变成了「交出可寻址的行为」。
  //
  // **分类表已经搬走了。** 此前这里是两份局部数组（`REFERENCE_PASSING` /
  // `VALUE_PASSING`），而 ctx 的 17 个成员一个都没被回答过。现在唯一的真源是
  // `src/services/pluginBoundary.ts`：每个跨边界成员登记 kind（值 / 句柄 / 可调用）
  // 与 migration（v2 的去处），由 `scripts/check-plugin-boundary.ts` 对着实际接线断言。
  // 这里只保留一条与它联动的断言，免得两处各自漂移。
  // ----------------------------------------------------------
  const referencePassing = boundaryNames('host').filter(
    (name) => findMember('host', name)?.kind !== 'value'
  );
  const valuePassing = boundaryNames('host').filter(
    (name) => findMember('host', name)?.kind === 'value'
  );

  const actualHostMembers = interfaceKeys.slice().sort();
  const expectedHostMembers = [...referencePassing, ...valuePassing].sort();
  const added = actualHostMembers.filter((name) => !expectedHostMembers.includes(name));
  const gone = expectedHostMembers.filter((name) => !actualHostMembers.includes(name));

  check(
    actualHostMembers.length > 0,
    '解析出了 ModulithHost 的成员列表（解析失败会让下面那条断言变成假通过）'
  );
  check(
    added.length === 0 && gone.length === 0,
    `★ 宿主 API 表面未变（新增：${added.join('、') || '无'}；移除：${gone.join('、') || '无'}）` +
      ` —— 新增成员必须在 src/services/pluginBoundary.ts 里登记：它传的是值、句柄，还是函数？`
  );
  check(
    referencePassing.every((name) => HOST_CAPABILITIES.host.includes(name)) &&
      valuePassing.every((name) => HOST_CAPABILITIES.host.includes(name)),
    '边界清单里的每个宿主成员都在能力表里（否则清单本身已经过期）'
  );

  const missingFromInterface = HOST_CAPABILITIES.host.filter(
    (name) => !interfaceKeys.includes(name)
  );
  check(
    missingFromInterface.length === 0,
    `能力表里的每个宿主成员都在 ModulithHost 上：${missingFromInterface.join('、') || '无缺失'}`
  );

  const missingFromObject = HOST_CAPABILITIES.host.filter((name) => !objectKeys.includes(name));
  check(
    missingFromObject.length === 0,
    `能力表里的每个宿主成员都真的被注入：${missingFromObject.join('、') || '无缺失'}`
  );

  const missingFromContext = HOST_CAPABILITIES.context.filter(
    (name) => !contextKeys.includes(name)
  );
  check(
    missingFromContext.length === 0,
    `能力表里的每个上下文成员都由上下文工厂返回：${missingFromContext.join('、') || '无缺失'}`
  );

  const unusedContext = contextKeys.filter((name) => !HOST_CAPABILITIES.context.includes(name));
  check(
    unusedContext.length === 0,
    `上下文工厂返回的每一项都在能力表里（否则插件探测不到它）：${unusedContext.join('、') || '无遗漏'}`
  );

  // 关键接线点：把「插件现在可以不是一个模块」这件事钉住。
  check(
    runtime.includes('contributed ='),
    '加载成功的判据已改为「至少贡献一样东西」'
  );
  check(
    !/plugins?["'`]?\s*,\s*[\s\S]{0,80}但没有注册任何模块/.test(runtime),
    '旧的「必须注册模块」错误信息已移除'
  );
  check(
    runtime.includes('registerDeclaredCommands'),
    '声明式命令在清单期就登记（未激活也能被搜到）'
  );
  check(
    runtime.includes('buildDeclaredModuleDescriptor'),
    '声明式模块在清单期就进目录（未激活也能出现在侧边栏）'
  );
  check(
    runtime.includes('runDisposables'),
    '卸载路径会执行插件登记的清理函数'
  );
  check(
    contextKeys.includes('activationEvent'),
    'ctx.activationEvent 已接线（插件能知道自己为什么被激活）'
  );
  // `Modulith.run` 是显式引导入口：它去掉"当前正在加载哪个插件"这个隐式全局，
  // 改成把身份作为参数交给插件。这条断言把接线点本身钉住 —— 一个只在注释里
  // 描述过的 API，与一个真的挂在 host 对象上的 API，看起来是一样的。
  check(
    objectKeys.includes('run'),
    'Modulith.run 已挂到注入的 host 对象上（api: 2 的显式引导入口）'
  );
  check(
    runtime.includes('currentBootstrap'),
    '加载路径为每个插件准备了引导数据（run 的回调才有东西可拿）'
  );
  check(
    types.includes('PluginDisposablesAPI') && types.includes('PluginSettingsAPI'),
    'disposables 与 settings 已在类型契约里'
  );
}

{
  const market = readSource('../src/services/pluginMarket.ts');
  check(
    !market.includes('normalizeContributions'),
    '市场没有第二份贡献点解析实现（贡献目录只有 pluginRuntime 一个入口）'
  );
}

// ============================================================
// 8. 真实清单：把相邻插件仓库里的每个 manifest 跑一遍
// ============================================================
//
// 这一节的价值不在"再测一遍纯函数"，而在于**用真实数据**回答一个具体问题：
// 1.2.0 之后，现有的每一个插件会被归类成什么？
//
// 分类错了的症状很隐蔽：一个本该按需激活的插件被当成旧式插件在后台执行
// （白付了代价），或者反过来——某个插件被判定为声明式却又没有任何贡献，
// 于是在加载期被判为失败。两种都不会报错，只会"某天被人发现"。
//
// `modulith-plugins` 是**另一个仓库**，干净 clone 本仓库时并不存在。因此这里
// 显式跳过并打印原因，而不是伪装成通过 —— 与 check-theme 对 dist/ 的处理一致。
console.log('\n真实插件清单：');

{
  const pluginsRoot = resolve(here, '../../modulith-plugins/plugins');

  if (!existsSync(pluginsRoot)) {
    console.log(`  ⏭ 跳过：找不到 ${pluginsRoot}（插件仓库不在旁边时属正常）`);
  } else {
    const dirs = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    check(dirs.length > 0, `发现 ${dirs.length} 个插件目录`);

    for (const dir of dirs) {
      const manifestPath = resolve(pluginsRoot, dir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        check(false, `${dir}: 缺少 manifest.json`);
        continue;
      }

      let manifest: { contributes?: unknown; activationEvents?: unknown };
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
      } catch (error) {
        check(false, `${dir}: manifest.json 不是合法 JSON（${String(error)}）`);
        continue;
      }

      const contract = resolveLoadContract(manifest);
      const errors = contract.issues.filter((item) => item.level === 'error');

      // 不假设每个插件都该是哪种形态：只断言"解释得通"。
      // 一个既没声明 contributes、又没有任何可解析激活事件的插件，只能走旧式路径 ——
      // 那是合法且兼容的，不该被判为问题。
      check(
        errors.length === 0,
        `${dir}: ${contract.declarative ? '声明式' : '旧式'} / ${
          contract.eager ? '加载期执行' : '按需激活'
        }${errors.length > 0 ? ` —— ${errors.map((item) => item.message).join('；')}` : ''}`
      );
    }
  }
}

// ============================================================
// 9. 插件形态的派生
// ============================================================
//
// 形态回答的是"这个插件会不会占我的侧边栏一行"，是用户的判断依据。因此它必须
// **从 contributes 派生**，而不是从作者自填的 categories 读 —— 与风险等级同理，
// 由被审查的一方提供的信息不可信。这一节把这条判据本身钉下来。
console.log('\n插件形态的派生：');

{
  const ui = shapeFromContributions(
    normalizeContributions({ modules: [{ id: 'm', name: 'M' }] }).contributions,
    ['onModule:m']
  );
  check(ui.shape === 'ui', '有模块 → 界面型');
  check(ui.kinds.modules === true, '徽章：模块');
  check(ui.source === 'manifest', '来源标记为清单（权威）');

  const headless = shapeFromContributions(
    normalizeContributions({ commands: [{ id: 'c', title: 'C' }] }).contributions,
    ['onCommand:c']
  );
  check(headless.shape === 'headless', '无模块但有命令 → 功能型');
  check(headless.kinds.modules === false, '功能型没有模块徽章');

  const service = shapeFromContributions(emptyContributions(), ['onStartup']);
  check(service.shape === 'headless', '空贡献 + onStartup → 功能型（后台服务插件）');
  check(service.background === true, '标记为后台');

  check(
    shapeFromContributions(emptyContributions(), []).shape === 'unknown',
    '既无贡献也无激活事件 → 形态未知'
  );
}

{
  const fromIndex = shapeFromIndexKinds(['modules', 'commands']);
  check(fromIndex.shape === 'ui', '索引里含 modules → 界面型');
  check(fromIndex.source === 'index', '来源标记为索引');

  check(
    shapeFromIndexKinds(['settings'], { background: true }).shape === 'headless',
    '索引里只有设置 + 后台 → 功能型'
  );

  const missing = shapeFromIndexKinds(undefined);
  check(missing.shape === 'unknown', '★ 旧索引没有 kinds → 形态未知，而不是猜一个');
  check(missing.source === 'none', '并标明「来源为空」');

  check(
    shapeFromIndexKinds([]).shape === 'unknown',
    'kinds 是空数组 → 同样按未知处理（与"声明了但没有贡献"不同）'
  );
}

{
  const legacyLoaded = shapeFromInstalled(
    { declarative: false, contributions: emptyContributions(), events: [] },
    2
  );
  check(legacyLoaded.shape === 'ui', '旧式插件加载后注册了模块 → 界面型');
  check(legacyLoaded.source === 'runtime', '来源标记为运行期实际注册');

  const legacyPending = shapeFromInstalled(
    { declarative: false, contributions: emptyContributions(), events: [] },
    0
  );
  check(
    legacyPending.shape === 'unknown',
    '★ 旧式插件尚未加载 → 形态未知（猜成界面型会在它加载完当场打脸）'
  );
}

{
  const info = shapeFromContributions(
    normalizeContributions({
      modules: [{ id: 'm', name: 'M' }],
      commands: [{ id: 'c', title: 'C' }],
    }).contributions,
    ['onStartup']
  );
  const labels = shapeBadgeLabels(info).join(',');
  check(labels === '模块,命令,后台', `徽章按固定顺序输出（实际：${labels}）`);
}

{
  const shapeSource = readSource('../src/services/pluginShape.ts');
  // 判据是**属性访问**，不是那个词本身 —— 这个文件的注释里正当地解释了"为什么不读
  // categories"，用裸词匹配会把那段解释本身判成违规。这一行的教训值得记下：
  // 对源码做文本断言时，匹配模式必须收得比"出现的词"更精确。
  const readsCategories =
    /\.\s*categories\b/.test(shapeSource) ||
    shapeSource.includes("'categories'") ||
    shapeSource.includes('"categories"');
  check(
    !readsCategories,
    '★ 形态派生不读作者自填的 categories（它只用于浏览筛选，不承担形态判断）'
  );
  const marketSource = readSource('../src/modules/pluginMarket/PluginMarket.tsx');
  check(marketSource.includes('marketPluginShape'), '市场页用派生形态做分组与筛选');

  const managementSource = readSource('../src/modules/plugins/Plugins.tsx');
  check(
    managementSource.includes('shapeFromInstalled'),
    '插件管理页的形态来自宿主派生（已安装插件不需要索引）'
  );
  check(
    managementSource.includes('由清单派生') && managementSource.includes('作者填写'),
    '★ 管理页把「形态（派生）」与「分类（作者填）」分开标注来源'
  );
}

// ============================================================
// 插件 API 类型包：与能力表对上
// ============================================================

// `modulith-plugins/types/modulith.d.ts` 是给插件作者用的**手写镜像**，而能力表
// 是宿主这一侧的真源 —— 上面的断言已经把它与 `pluginRuntime.ts` 的实际实现对上了，
// 所以这里只需要接上最后一段：类型包。
//
// 为什么值得专门守：**类型说错了比没有类型更糟**。作者会相信自动补全，把参数顺序
// 搞反、或以为某个方法是异步的，而错误要到运行时才暴露，且症状指向插件自己写的
// 代码。这与权限注册表是同一个道理：同一份名单的第二份副本必然漂移，除非有东西
// 钉住它。
console.log('\n插件 API 类型包：');

/** 从 `interface X { ... }` 里抓成员名（含 `readonly` 与方法） */
function typeInterfaceMembers(source: string, name: string): string[] {
  // 按声明**自身的缩进**推算成员缩进，而不是写死两个空格：类型包里的接口在
  // `declare global { }` 内部，比顶层多一层。写死会让它一处都解析不到 —— 而
  // "解析不到"与"真的不一致"在断言里长得一样，那就成了一个永远在误报的门禁。
  const declaration = new RegExp(`^([ \\t]*)interface ${name} \\{`, 'm');
  const found = declaration.exec(source);
  if (!found) return [];

  const baseIndent = found[1].length;
  const open = source.indexOf('{', found.index);

  // 从 `{` 开始按花括号配平找结尾 —— 里面有嵌套的对象字面量与泛型签名，
  // 用"下一个右花括号"会截在半路
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];

  const body = source.slice(open + 1, end);
  const members = new Set<string>();
  // 恰好 `baseIndent + 2` 个空格开头：多行签名的续行缩进更深，注释行以 `*` 开头，
  // 两者都不会命中
  const memberPattern = new RegExp(
    `^[ \\t]{${baseIndent + 2}}(?:readonly\\s+)?([A-Za-z_$][\\w$]*)\\s*[?:(<]`
  );
  for (const line of body.split(/\r?\n/)) {
    const member = line.match(memberPattern);
    if (member) members.add(member[1]);
  }
  return [...members].sort();
}

{
  const typePackage = resolve(here, '../../modulith-plugins/types/modulith.d.ts');

  if (!existsSync(typePackage)) {
    console.log(`  ⏭ 跳过：找不到 ${typePackage}（插件仓库不在旁边时属正常）`);
  } else {
    const dts = readFileSync(typePackage, 'utf8');

    for (const [interfaceName, expected] of [
      ['ModulithHost', [...HOST_CAPABILITIES.host].sort()],
      ['ModulithContext', [...HOST_CAPABILITIES.context].sort()],
    ] as const) {
      const actual = typeInterfaceMembers(dts, interfaceName);
      check(
        actual.join(',') === expected.join(','),
        actual.join(',') === expected.join(',')
          ? `${interfaceName} 的 ${expected.length} 个成员与能力表一致`
          : `${interfaceName} 与能力表不一致。\n      能力表：${expected.join('、')}\n      类型包：${actual.join('、') || '（一处都没解析到 —— 正则或格式变了）'}`
      );
    }
  }
}

// ============================================================
// engines 的键名与下限：宿主 ↔ 清单 ↔ 类型包必须说同一个词
// ============================================================
//
// 这一节是 1.6.0 那次改名的产物。`engines` 的键名曾经是 `loopcore` ——
// 产品改名时漏下的旧名字，多留了六个版本（技术债 §7.6 里那条错误的顾虑）。
//
// 为什么值得单独守：**这个字段写错了不会报任何错**。`PluginEngines` 没有
// `deny_unknown_fields`，因此宿主读 `engines.modulith`、插件写
// `engines.loopcore` 时，两边都当作正常清单解析，只是引擎范围那一条兼容性
// 提示**永远不出现**。一个静默失效的兼容性声明比没有声明更糟 ——
// 用户会以为有人替他核对过版本要求。
//
// 断言分两层：
//   1. 键名从**宿主源码**推导出来，其余每一处都必须与它逐字相同（防漂移）；
//   2. 旧名字不许再出现在任何面向插件的文件里（防复活）。
console.log('\nengines 的键名与下限：');

/** 从 Rust 的 `pub struct X { ... }` 里取出字段名。解析不到时返回空数组 */
function rustStructFields(source: string, structName: string): string[] {
  const found = new RegExp(`pub struct ${structName}\\s*\\{`).exec(source);
  if (!found) return [];
  const open = source.indexOf('{', found.index);
  const close = source.indexOf('\n}', open);
  if (open < 0 || close < 0) return [];
  const fields = new Set<string>();
  for (const line of source.slice(open + 1, close).split(/\r?\n/)) {
    const field = line.match(/^\s*pub\s+([A-Za-z_][\w]*)\s*:/);
    if (field) fields.add(field[1]);
  }
  return [...fields].sort();
}

/**
 * 取出一个 Rust 函数（或方法）的函数体，按花括号配平。
 *
 * 按**函数体**而不是"整个文件"来断言，是因为同一个文件里往往还有单测、
 * 还有别的方法也在读同一个字段 —— 那些会把断言喂饱，让真正那一行的改动
 * 逃过去（变异 M3 的教训）。找不到函数时返回空串，调用方据此报"锚点没了"。
 */
function rustFnBody(source: string, fnName: string): string {
  const found = new RegExp(`fn\\s+${fnName}\\s*[(<]`).exec(source);
  if (!found) return '';
  const open = source.indexOf('{', found.index);
  if (open < 0) return '';

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
}

/** `x.y.z` → 数字三元组；解析不出来返回 null（不猜） */function semverTriple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

const HOST_VERSION = readVersionFile().app.version;

{
  // ---- 1. 宿主读的是哪个键（真源）----

  const rustTypes = readSource('../src-tauri/src/modules/plugins/types.rs');
  const engineFields = rustStructFields(rustTypes, 'PluginEngines');

  check(
    engineFields.length === 1,
    engineFields.length === 1
      ? `宿主 PluginEngines 恰好一个字段：${engineFields[0]}`
      : `★ 宿主 PluginEngines 的字段数不是 1（实际 ${engineFields.length}）—— 下面每一处都以它为基准，基准没了`
  );

  const engineKey = engineFields[0] ?? '';
  check(
    engineKey !== '' && engineKey !== 'loopcore',
    `★ 宿主读的键名不是旧产品名（实际：${engineKey || '（一处都没解析到）'}）`
  );

  // 推导出来的键必须在文档里出现，否则作者照文档写就会写错。
  //
  // 判据是"**每一处** `engines.<某键>` 都必须用这个键"，不是"文件里能找到一次"。
  // 后者是假的：文档里那个词出现好几次，改掉其中一处（例如正文的那句说明）
  // 断言照样绿 —— 变异 M10 抓出来的正是这个。
  // 范围刻意只圈**面向插件作者的文档**（插件开发文档 + 例外申请），
  // 不是整个 docs/：`engines` 这个词在别处是**另一个字段** ——
  // `package.json` 的 `engines.node` 声明 Node 版本，与插件清单毫不相干。
  // 全域扫描会把 `环境搭建.md` 里那句 `engines.node` 报成违规。
  const engineMention = /\bengines\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  const wronglyMentioned: string[] = [];

  const scanDoc = (absolute: string, label: string): void => {
    if (!existsSync(absolute)) return;
    if (!statSync(absolute).isDirectory()) {
      for (const match of readFileSync(absolute, 'utf8').matchAll(engineMention)) {
        if (engineKey !== '' && match[1] !== engineKey) {
          wronglyMentioned.push(`${label} → engines.${match[1]}`);
        }
      }
      return;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      scanDoc(resolve(absolute, entry.name), `${label}/${entry.name}`);
    }
  };

  scanDoc(resolve(here, '../docs/02-开发指南/插件开发'), 'docs/02-开发指南/插件开发');
  scanDoc(resolve(here, '../PLUGIN-EXCEPTION.md'), 'PLUGIN-EXCEPTION.md');

  check(
    wronglyMentioned.length === 0,
    wronglyMentioned.length === 0
      ? `插件开发文档里每一处 engines.<键> 都是 ${engineKey}`
      : `★ 插件开发文档里出现了别的键名：\n      ${[...new Set(wronglyMentioned)].join('\n      ')}`
  );

  // ---- 2. 前端镜像：类型与读取点 ----

  for (const relative of ['../src/types/plugin.ts', '../src/services/pluginRuntime.ts']) {
    const members = interfaceMemberNames(readSource(relative), 'PluginEngines');
    check(
      members !== null && members.join(',') === engineKey,
      `${relative.replace('../', '')} 的 PluginEngines 成员是 [${engineKey}]（实际 [${members?.join(',') ?? '没找到这个接口'}]）`
    );
  }

  // 所有**读**这个键的地方。用属性访问而不是裸词匹配 ——
  // 注释里正当地解释了"为什么不叫 loopcore"，裸词会把那段解释本身判成违规。
  const readerPattern = /\bengines\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  const readers: Record<string, string[]> = {
    '../src-tauri/src/modules/plugins/types.rs': [],
    '../src-tauri/src/modules/plugins/validator.rs': [],
    '../src/services/pluginMarket.ts': [],
    '../src/modules/plugins/PluginDetailDrawer.tsx': [],
  };

  for (const relative of Object.keys(readers)) {
    // 只看代码：注释里的示例会让这条断言对真正的改动视而不见（见 stripComments）
    const source = stripComments(readSource(relative));
    for (const match of source.matchAll(readerPattern)) readers[relative].push(match[1]);
  }

  const wrongReaders = Object.entries(readers)
    .filter(([, keys]) => keys.length === 0 || keys.some((key) => key !== engineKey))
    .map(([relative, keys]) => `${relative.replace('../', '')} → [${keys.join(',') || '没有读取点'}]`);

  check(
    wrongReaders.length === 0,
    wrongReaders.length === 0
      ? `4 处读取点用的都是 ${engineKey}`
      : `★ 有读取点用的不是 ${engineKey}：\n      ${wrongReaders.join('\n      ')}`
  );

  // 市场索引那条路是 `(engines as Record<string, unknown>).<键>` 与错误消息里的
  // `${where}.engines.<键>` —— 上面的正则覆盖不到 `).<键>`，因此单独看一次。
  const market = readSource('../src/services/pluginMarket.ts');
  check(
    market.includes('engines') && !/\)\s*\.\s*[A-Za-z_$][\w$]*/.test(market.split('engines')[1] ?? ''),
    '市场解析索引里的 engines 时用的也是同一个键'
  );

  // "某个文件里出现过这个键"是不够的 —— 变异 M3 把 `validator.rs` 里真正那一行
  // 改成读别的键之后，门禁仍然是绿的：同一个文件里**另一处**（单测里构造清单的那行）
  // 还写着 `manifest.engines.modulith`，把断言喂饱了。
  // 因此对"版本判定"这条关键链路，直接锚在**函数体**上。
  const evaluateBody = rustFnBody(stripComments(rustTypes), 'normalize');
  check(
    engineKey !== '' && evaluateBody.includes(`self.engines.${engineKey}`),
    `types.rs 的 normalize() 从 self.engines.${engineKey || '?'} 读默认值`
  );

  const validatorSource = stripComments(readSource('../src-tauri/src/modules/plugins/validator.rs'));
  const engineFn = rustFnBody(validatorSource, 'evaluate_engine');
  // 判据写成 `manifest.engines.<键>`（带接收者）而不是裸的 `engines.<键>`：
  // 同一个函数体里还有一条**报错文案** `format!("engines.modulith 非法: …")`，
  // 裸匹配会被那条字符串喂饱 —— 把真正那一行改成读别的键之后它照样是绿的。
  check(
    engineFn.length > 0 && engineKey !== '' && engineFn.includes(`manifest.engines.${engineKey}`),
    engineFn.length > 0
      ? `validator.rs 的 evaluate_engine() 从 manifest.engines.${engineKey || '?'} 取声明范围`
      : '★ 在 validator.rs 里找不到 evaluate_engine 的函数体 —— 锚点没了，这条断言失去意义'
  );

  // ---- 3. 仓库内每一份清单 ----

  const manifestPaths: string[] = [];
  for (const area of ['../samples', '../scripts/fixtures/plugins']) {
    const root = resolve(here, area);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const candidate = resolve(root, name, 'manifest.json');
      if (existsSync(candidate)) manifestPaths.push(candidate);
    }
  }

  check(manifestPaths.length >= 10, `仓库内找到 ${manifestPaths.length} 份清单`);

  const hostTriple = semverTriple(HOST_VERSION);
  const badKeys: string[] = [];
  const badRanges: string[] = [];

  for (const manifestPath of manifestPaths) {
    const label = manifestPath.replace(`${resolve(here, '..')}\\`, '');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      engines?: Record<string, string>;
    };
    const keys = Object.keys(manifest.engines ?? {}).sort();

    if (keys.join(',') !== engineKey) {
      badKeys.push(`${label} → [${keys.join(',') || '没有 engines'}]`);
      continue;
    }

    const range = manifest.engines?.[engineKey] ?? '';
    const lower = /^>=(\d+\.\d+\.\d+)$/.exec(range);
    if (!lower) {
      badRanges.push(`${label} → ${range || '（空）'}`);
      continue;
    }
    const triple = semverTriple(lower[1]);
    // 下限不得高于宿主自己 —— 否则本仓库自带的示例/夹具在自己的版本上
    // 都会挂一条"声明不匹配"提示，那是自相矛盾的清单。
    if (triple && hostTriple && compareSemver(triple, hostTriple) > 0) {
      badRanges.push(`${label} → ${range}（高于宿主 ${HOST_VERSION}）`);
    }
  }

  check(
    badKeys.length === 0,
    badKeys.length === 0
      ? `${manifestPaths.length} 份清单的 engines 都只有 ${engineKey} 一个键`
      : `★ 键名不是 ${engineKey} 的清单：\n      ${badKeys.join('\n      ')}`
  );
  check(
    badRanges.length === 0,
    badRanges.length === 0
      ? `全部只带下界，且下界不高于宿主 ${HOST_VERSION}`
      : `★ 范围写法或下限有问题：\n      ${badRanges.join('\n      ')}`
  );

  // ---- 4. 相邻插件仓库（不在旁边时跳过，与第 8 节同一约定）----

  const pluginsRoot = resolve(here, '../../modulith-plugins');
  if (!existsSync(pluginsRoot)) {
    console.log(`  ⏭ 跳过：找不到 ${pluginsRoot}（插件仓库不在旁边时属正常）`);
  } else {
    const pluginDirs = readdirSync(resolve(pluginsRoot, 'plugins'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const drifting: string[] = [];
    for (const dir of pluginDirs) {
      const manifestPath = resolve(pluginsRoot, 'plugins', dir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        engines?: Record<string, string>;
      };
      const keys = Object.keys(manifest.engines ?? {}).sort();
      if (keys.join(',') !== engineKey) drifting.push(`${dir} → [${keys.join(',')}]`);
    }
    check(
      drifting.length === 0,
      drifting.length === 0
        ? `插件仓库 ${pluginDirs.length} 份清单的 engines 键名与宿主一致（${engineKey}）`
        : `★ 插件仓库里有清单的键名与宿主不一致：\n      ${drifting.join('\n      ')}`
    );

    // 索引里的每一个历史版本也走同一个键 —— 它是市场页真正读的那份数据
    const index = JSON.parse(readFileSync(resolve(pluginsRoot, 'index.json'), 'utf8')) as {
      plugins?: Array<{ id?: string; versions?: Array<{ version?: string; engines?: Record<string, string> }> }>;
    };
    const indexDrift: string[] = [];
    let versionCount = 0;
    for (const entry of index.plugins ?? []) {
      for (const version of entry.versions ?? []) {
        versionCount += 1;
        const keys = Object.keys(version.engines ?? {}).sort();
        if (keys.join(',') !== engineKey) {
          indexDrift.push(`${entry.id}@${version.version} → [${keys.join(',')}]`);
        }
      }
    }
    check(
      indexDrift.length === 0,
      indexDrift.length === 0
        ? `索引里 ${versionCount} 个版本的 engines 键名都一致`
        : `★ 索引里有 ${indexDrift.length} 个版本用了别的键名：${indexDrift.slice(0, 4).join('、')}`
    );
  }

  // ---- 5. 旧名字不许复活 ----

  // 只扫**面向插件**的文件：历史文档（技术债、README 的改名迁移表）里
  // `loopcore` 是在如实记录"当时叫什么"，改掉它等于篡改历史。
  const LEGACY_NAME = 'loopcore';
  const legacyRoots = [
    '../src',
    '../src-tauri/src',
    '../scripts',
    '../samples',
    '../docs/02-开发指南',
    '../docs/03-参考',
    '../docs/07-法务',
    '../docs/08-规划',
    '../PLUGIN-EXCEPTION.md',
  ];

  const extensions = /\.(rs|ts|tsx|js|json|md|css|toml)$/;
  const legacyHits: string[] = [];

  /** 报告里用仓库相对路径：绝对路径带用户名，读起来也长 */
  const relativeTo = (absolute: string, top: string): string =>
    absolute.startsWith(top) ? absolute.slice(top.length + 1) : absolute;

  // 本文件自己必须排除：`LEGACY_NAME` 这个常量的**值**就是那个旧名字，
  // 不排除的话这条断言会永远报自己一次失败。这里刻意用"排除自身"而不是
  // 把常量拆开拼出来 —— 后者会让那个名字在源码里变得不可搜索，
  // 而"能不能搜到旧名字"正是这一节要保证的事。
  const selfPath = fileURLToPath(import.meta.url);

  const scan = (absolute: string, top: string): void => {
    if (!existsSync(absolute)) return;
    if (resolve(absolute) === resolve(selfPath)) return;
    // 入口本身也可能是一个文件（`PLUGIN-EXCEPTION.md` 就是），
    // 不能假定传进来的都是目录 —— 那种假设会以 ENOTDIR 崩掉，而不是给出结论。
    if (!statSync(absolute).isDirectory()) {
      if (extensions.test(absolute)) {
        if (readFileSync(absolute, 'utf8').toLowerCase().includes(LEGACY_NAME)) {
          legacyHits.push(relativeTo(absolute, top));
        }
      }
      return;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = resolve(absolute, entry.name);
      if (resolve(child) === resolve(selfPath)) continue;
      if (entry.isDirectory()) {
        // node_modules / 构建产物 / 生成目录都不是我们要管的
        if (entry.name === 'node_modules' || entry.name === 'target') continue;
        scan(child, top);
      } else if (extensions.test(entry.name)) {
        if (readFileSync(child, 'utf8').toLowerCase().includes(LEGACY_NAME)) {
          legacyHits.push(relativeTo(child, top));
        }
      }
    }
  };

  const projectRoot = resolve(here, '..');
  for (const relative of legacyRoots) scan(resolve(here, relative), projectRoot);

  if (existsSync(resolve(here, '../../modulith-plugins'))) {
    scan(resolve(here, '../../modulith-plugins/plugins'), resolve(here, '../..'));
    scan(resolve(here, '../../modulith-plugins/types'), resolve(here, '../..'));
    scan(resolve(here, '../../modulith-plugins/scripts'), resolve(here, '../..'));
  }

  check(
    legacyHits.length === 0,
    legacyHits.length === 0
      ? `★ 面向插件的文件里已经没有旧产品名 ${LEGACY_NAME}`
      : `${legacyHits.length} 个文件里仍然有 ${LEGACY_NAME}：\n      ${legacyHits.slice(0, 8).join('\n      ')}`
  );
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);