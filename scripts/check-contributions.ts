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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
 * 取一段从 `marker` 开始、到下一行行首 `}` 为止的源码块。
 *
 * 用于在接口 / 函数体上做成员核对。这些块的闭合花括号都在第 0 列，因此
 * `\n}` 是可靠的终止标记 —— 这个前提写在这里，因为一旦格式变了它就会失效。
 */
function blockFrom(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const end = source.indexOf('\n}', start);
  return end === -1 ? '' : source.slice(start, end);
}

/** 取某段代码里指定缩进层级上的属性名（同时接受 `a: x` 与 `a,` 两种写法） */
function keysAtIndent(block: string, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const keys: string[] = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith(pad)) continue;
    if (line.startsWith(`${pad} `)) continue; // 更深层缩进，不属于这一级
    const match = /^([A-Za-z_$][\w$]*)\s*[,:]/.exec(line.slice(indent));
    if (match) keys.push(match[1]);
  }
  return keys;
}

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
  const { issues } = normalizeContributions({ themes: [{ id: 't' }] });
  check(
    issues.every((item) => item.kind !== 'themes'),
    '未知贡献点（themes）被静默忽略，不产生问题'
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

  const hostInterface = blockFrom(runtime, 'export interface ModulithHost {');
  const hostObject = blockFrom(runtime, 'const host: ModulithHost = {');
  const contextObject = blockFrom(runtime, 'function createContext() {');

  check(hostInterface.length > 0, '找到 ModulithHost 接口');
  check(hostObject.length > 0, '找到 installHostGlobals 里的 host 对象');
  check(contextObject.length > 0, '找到 createContext 函数体');

  const interfaceKeys = keysAtIndent(hostInterface, 2);
  const objectKeys = keysAtIndent(hostObject, 4);
  const contextKeys = keysAtIndent(contextObject, 4);

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
  // 下面这个分类把**哪些成员是传引用的**钉死。新增成员会让断言失败 ——
  // 这不是禁止你加，而是要求你先回答"它将来怎么跨 realm"，并在这里显式登记。
  //
  // 读这份分类时请注意一件容易被低估的事：**共享 React 实例本身就是最深的一处耦合。**
  // React / jsx / jsxs / Fragment 全都过不去 realm 边界，而它们不是"两个函数"那么小 ——
  // 沙箱化之后插件不能再用宿主的 React，界面必须改成"插件交出可序列化的界面描述、
  // 宿主负责渲染"。这才是迁移里最大的一块。
  // ----------------------------------------------------------
  const REFERENCE_PASSING = [
    'React',
    'jsx',
    'jsxs',
    'Fragment',
    'createContext',
    'registerModule',
    'registerCommand',
    'onDeactivate',
    'useModuleActive',
  ];
  /** 传值的：跨 realm 只要序列化，天然安全 */
  const VALUE_PASSING = ['version', 'platform', 'capabilities'];

  /** 取出接口里每个成员的**名字**（成员声明的续行会被折叠掉） */
  const memberNames = (block: string, indent: number): string[] => {
    const pad = ' '.repeat(indent);
    return block
      .split('\n')
      .slice(1)
      .filter((line) => line.startsWith(pad) && !line.startsWith(`${pad} `))
      .map((line) => /^([A-Za-z_$][\w$]*)\s*[?:]/.exec(line.slice(indent))?.[1] ?? '')
      .filter(Boolean);
  };

  const actualHostMembers = memberNames(hostInterface, 2).sort();
  const expectedHostMembers = [...REFERENCE_PASSING, ...VALUE_PASSING].sort();
  const added = actualHostMembers.filter((name) => !expectedHostMembers.includes(name));
  const gone = expectedHostMembers.filter((name) => !actualHostMembers.includes(name));

  check(
    actualHostMembers.length > 0,
    '解析出了 ModulithHost 的成员列表（解析失败会让下面那条断言变成假通过）'
  );
  check(
    added.length === 0 && gone.length === 0,
    `★ 宿主 API 表面未变（新增：${added.join('、') || '无'}；移除：${gone.join('、') || '无'}）` +
      ` —— 新增成员必须在本文件里分类：它传的是值还是引用？传引用的跨不过 realm`
  );
  check(
    REFERENCE_PASSING.every((name) => HOST_CAPABILITIES.host.includes(name)) &&
      VALUE_PASSING.every((name) => HOST_CAPABILITIES.host.includes(name)),
    '分类里的每个成员都在能力表里（否则分类本身已经过期）'
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
    `能力表里的每个上下文成员都由 createContext 返回：${missingFromContext.join('、') || '无缺失'}`
  );

  const unusedContext = contextKeys.filter((name) => !HOST_CAPABILITIES.context.includes(name));
  check(
    unusedContext.length === 0,
    `createContext 返回的每一项都在能力表里（否则插件探测不到它）：${unusedContext.join('、') || '无遗漏'}`
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
    contextObject.includes('activationEvent:'),
    'ctx.activationEvent 已接线（插件能知道自己为什么被激活）'
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

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
