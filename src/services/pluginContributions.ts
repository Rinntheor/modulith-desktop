// src/services/pluginContributions.ts
//
// 插件贡献点的解析、校验与规范化。
//
// 为什么单独成一个**纯模块**（不 import React、不碰 document、不碰 pluginRuntime）：
//
//   1. 它是「读清单即可建立完整界面」这件事的唯一实现点。宿主在**不执行插件代码**
//      的前提下，就能知道这个插件往界面里加了什么 —— 这是按需激活的前提，也是
//      将来强制式沙箱的前提（插件挪到别的 realm 之后，宿主仍然要能画出侧边栏）。
//   2. 纯模块可以被 `scripts/check-contributions.ts` 直接断言真值表。凡是
//      「看起来对、实际不生效」的逻辑，只有把判断本身钉下来才能防它回来 ——
//      与 `utils/motionPreference.ts` 单独成文件是同一个理由。
//
// 后端把 `contributes` 当作**不透明 JSON** 原样保留（`types.rs` 里是
// `serde_json::Value`），所以规范化只发生在这一处，不存在第二份实现。
//
// ---------------------------------------------------------------------------
// 一条贯穿全文件的设计纪律：**声明是数据，行为是代码。**
//
// 目录（侧边栏条目、命令面板条目、设置界面、右键菜单项）全部可以从清单算出来，
// 不需要执行一行插件代码；插件代码只在激活时把「行为」贴到已经声明好的 ID 上。
// 因此「解析失败」与「执行失败」是两件互不牵连的事：前者在安装/列表时就暴露，
// 后者要等到用户真的用到那个功能。
// ---------------------------------------------------------------------------

import type {
  ActivationEvent,
  CommandContribution,
  ContextMenuContribution,
  ModulithCapabilities,
  ModuleContribution,
  SettingContribution,
  SettingOption,
  SettingType,
} from '../types/plugin';

// ============================================================
// 常量
// ============================================================

/**
 * 宿主会消费的贡献点名。
 *
 * 这张表是**冻结的**：`scripts/check-contributions.ts` 与 `Modulith.capabilities`
 * 都对着它断言，增删必须同时改三处，因此它不会悄悄漂移。
 */
export const CONTRIBUTION_KINDS = ['modules', 'commands', 'settings', 'contextMenus'] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

/**
 * 宿主会消费的激活事件名（不含冒号后的参数）。
 *
 * 早期草案里的 `onView` / `onFile` / `onPlugin` / `onRestore` **没有实现**，
 * 因此不在这里 —— 写了它们会得到一条 warning，而不是一个静默永不触发的插件。
 */
export const ACTIVATION_EVENT_NAMES = [
  'onStartup',
  'onModule',
  'onCommand',
  'onContextMenu',
] as const;
export type ActivationEventName = (typeof ACTIVATION_EVENT_NAMES)[number];

/** 设置项的四种取值类型 */
const SETTING_TYPES: readonly SettingType[] = ['boolean', 'string', 'number', 'select'];

/**
 * 模块 ID 的合法形状。
 *
 * 与命令不同，模块 ID **不加插件前缀**：它会被写进标签配置（`tabStore`）、
 * 侧边栏偏好与深链里，加前缀等于让所有存量记录失效。代价是需要跨插件去重 ——
 * 这件事由 `moduleCatalog` 负责（它已经拒绝了内建模块冲突与跨插件重复注册）。
 */
const MODULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 插件内部 ID（命令、设置项、右键菜单项）的合法形状 */
const LOCAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 宿主能力表（`Modulith.capabilities`）。
 *
 * 放在这个纯模块里而不是 `pluginRuntime` 里，有两个理由：
 *   * 它是**契约数据**，与贡献点名单、激活事件名单是同一类东西，应当放在一起；
 *   * `pluginRuntime` 依赖 React 与 `document`，进不了只带 ES2022 的脚本工程，
 *     放进去就意味着 `scripts/check-contributions.ts` 没法断言它。
 *
 * 插件用它做**特性探测**，而不是拿 `Modulith.version` 做字符串比较：
 * `engines.loopcore` 只表达「我要求宿主至少多新」，而且它只提示、不阻断；
 * 真正决定一段代码能不能跑的，是这里列出的东西。
 *
 * `api` 是这张表自身的版本，字段集变化时 +1。
 *
 * **刻意不列权限名。** 权限的权威是后端 `PluginPermission` 枚举，前端已经有一条
 * 取回它的路径（`list_plugin_permissions` / `permissionRegistry`）；在这里再放一份
 * 就是同一份名单的第二个副本，而副本必然漂移 —— 这正是 1.1.x 反复记录过的教训。
 */
export const HOST_CAPABILITIES: ModulithCapabilities = {
  api: 1,
  host: [
    'version',
    'platform',
    'React',
    'jsx',
    'jsxs',
    'Fragment',
    'registerModule',
    'createContext',
    'registerCommand',
    'onDeactivate',
    'useModuleActive',
    'capabilities',
  ],
  context: [
    'pluginId',
    'pluginVersion',
    'manifest',
    'version',
    'activationEvent',
    'storage',
    'http',
    'logger',
    'notifications',
    'events',
    'launcher',
    'icons',
    'shell',
    'fileDrop',
    'audio',
    'settings',
    'disposables',
  ],
  contributions: [...CONTRIBUTION_KINDS],
  activationEvents: [...ACTIVATION_EVENT_NAMES],
};

// ============================================================
// 类型
// ============================================================

/** 规范化之后的贡献集：四个成员恒为数组，调用方不必再判空 */
export interface NormalizedContributions {
  modules: ModuleContribution[];
  commands: CommandContribution[];
  settings: SettingContribution[];
  contextMenus: ContextMenuContribution[];
}

/**
 * 一条清单问题。
 *
 * `level` 只区分「这个插件不能按你写的那样工作」与「它能工作，但你可能没意识到
 * 自己依赖了什么」。**两类都不会阻止安装** —— 与 `engines.loopcore` 一样，
 * 清单问题只提示、不阻断；真正阻断的是后端解析失败（未知权限名那种）。
 */
export interface ContributionIssue {
  level: 'error' | 'warning';
  /** 出问题的位置 */
  kind: ContributionKind | 'activationEvents' | 'contributes';
  /** 条目下标；不针对具体条目时为 -1 */
  index: number;
  /** 相关 ID（没有则空串） */
  id: string;
  message: string;
}

/** 一个插件的装载契约：怎么建目录、什么时候执行代码 */
export interface PluginLoadContract {
  /**
   * 声明式插件：清单里有 `contributes`。
   * 目录从清单建立；代码按 `activationEvents` 激活。
   *
   * 非声明式（旧式）插件：目录条目由加载期的 `registerModule()` 建立，
   * 代码在后台加载阶段执行 —— 与 1.2.0 之前逐字一致。
   */
  declarative: boolean;
  /** 是否在后台加载阶段就激活（`onStartup`、没有激活事件、或旧式插件） */
  eager: boolean;
  /** 规范化后的激活事件 */
  events: ActivationEvent[];
  /** 规范化后的贡献集 */
  contributions: NormalizedContributions;
  /** 清单问题 */
  issues: ContributionIssue[];
}

// ============================================================
// 空的贡献集
// ============================================================

/**
 * 一个空贡献集。
 *
 * 刻意做成工厂而不是共享常量：贡献集会被 `pluginRuntime` 逐插件持有并传进 React，
 * 一个共享的可变对象意味着某个插件的写入会串到所有插件上 —— 那类缺陷只在
 * 恰好两个插件同时存在时才复现。
 */
export function emptyContributions(): NormalizedContributions {
  return { modules: [], commands: [], settings: [], contextMenus: [] };
}

/** 贡献集是否为空（四项全空） */
export function hasNoContribution(contributions: NormalizedContributions): boolean {
  return (
    contributions.modules.length === 0 &&
    contributions.commands.length === 0 &&
    contributions.settings.length === 0 &&
    contributions.contextMenus.length === 0
  );
}

// ============================================================
// 取值助手
//
// 清单是**外部输入**：字段可能缺失、可能是别的类型、可能带空白。下面这些助手
// 只做一件事 —— 把「看起来像」变成「确实是」，其余一律当作没写。
// 它们不做报错，报错由各 normalize* 负责，因为只有那里知道缺的是什么。
// ============================================================

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalString(value: unknown): string | undefined {
  return asNonEmptyString(value) ?? undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(asNonEmptyString).filter((item): item is string => item !== null);
  return items.length > 0 ? items : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 从一个对象里读一个「可选的数组字段」；不是数组时返回 null（区别于空数组） */
function readArrayField(raw: Record<string, unknown>, key: string): unknown[] | null {
  const value = raw[key];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================
// 各贡献点的规范化
// ============================================================

function normalizeModules(
  entries: unknown[],
  issues: ContributionIssue[]
): ModuleContribution[] {
  const result: ModuleContribution[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      issues.push(issue('error', 'modules', index, '', '条目不是对象，已忽略'));
      return;
    }

    const id = asNonEmptyString(entry.id);
    if (!id) {
      issues.push(issue('error', 'modules', index, '', '缺少 id，已忽略'));
      return;
    }
    if (!MODULE_ID_RE.test(id)) {
      // 模块 ID 会进标签配置与深链，含空格/冒号/斜杠会让它们难以解析
      issues.push(
        issue('error', 'modules', index, id, `id 形状非法（字母数字与 . _ -，1-64 字符）：${id}`)
      );
      return;
    }
    if (seen.has(id)) {
      issues.push(issue('error', 'modules', index, id, `模块 id 重复：${id}`));
      return;
    }
    seen.add(id);

    const name = asNonEmptyString(entry.name);
    if (!name) {
      issues.push(issue('warning', 'modules', index, id, '缺少 name，界面将显示 id'));
    }

    result.push({
      id,
      name: name ?? id,
      displayName: asOptionalString(entry.displayName),
      description: asOptionalString(entry.description),
      icon: asOptionalString(entry.icon),
      sidebar: asOptionalBoolean(entry.sidebar),
      parent: asOptionalString(entry.parent),
      priority: asOptionalNumber(entry.priority),
      category: asOptionalString(entry.category),
      badge: asOptionalString(entry.badge),
    });
  });

  return result;
}

function normalizeCommands(
  entries: unknown[],
  issues: ContributionIssue[]
): CommandContribution[] {
  const result: CommandContribution[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      issues.push(issue('error', 'commands', index, '', '条目不是对象，已忽略'));
      return;
    }

    // 兼容旧草案字段名：`types/plugin.ts` 曾长期把命令 ID 写成 `command`，
    // 而那时 `contributes` 没有消费方，因此没有人真的写过它 —— 但一个照旧文档
    // 抄下来的作者会写。接受它并提示一次，好过让他对着一个不出现的命令找半天。
    const id = asNonEmptyString(entry.id) ?? asNonEmptyString(entry.command);
    if (!id) {
      issues.push(issue('error', 'commands', index, '', '缺少 id，已忽略'));
      return;
    }
    if (entry.id === undefined && entry.command !== undefined) {
      issues.push(
        issue('warning', 'commands', index, id, 'id 写成了旧草案字段名 command，请改用 id')
      );
    }
    if (!LOCAL_ID_RE.test(id)) {
      issues.push(issue('error', 'commands', index, id, `id 形状非法：${id}`));
      return;
    }
    if (seen.has(id)) {
      issues.push(issue('error', 'commands', index, id, `命令 id 重复：${id}`));
      return;
    }
    seen.add(id);

    const title = asNonEmptyString(entry.title);
    if (!title) {
      issues.push(issue('error', 'commands', index, id, '缺少 title，已忽略'));
      // title 缺失时不留条目：命令面板里一条没有标题的项无法使用
      return;
    }

    result.push({
      id,
      title,
      subtitle: asOptionalString(entry.subtitle),
      keywords: asOptionalStringArray(entry.keywords),
      icon: asOptionalString(entry.icon),
    });
  });

  return result;
}

function normalizeSettingOptions(
  value: unknown,
  id: string,
  index: number,
  issues: ContributionIssue[]
): SettingOption[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const options: SettingOption[] = [];
  value.forEach((option, optionIndex) => {
    if (!isPlainObject(option)) {
      issues.push(
        issue('warning', 'settings', index, id, `options[${optionIndex}] 不是对象，已忽略`)
      );
      return;
    }
    const optionValue = asNonEmptyString(option.value);
    if (optionValue === null) {
      issues.push(
        issue('warning', 'settings', index, id, `options[${optionIndex}] 缺少 value，已忽略`)
      );
      return;
    }
    options.push({ value: optionValue, label: asNonEmptyString(option.label) ?? optionValue });
  });

  return options.length > 0 ? options : undefined;
}

function normalizeSettings(
  entries: unknown[],
  issues: ContributionIssue[]
): SettingContribution[] {
  const result: SettingContribution[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      issues.push(issue('error', 'settings', index, '', '条目不是对象，已忽略'));
      return;
    }

    const id = asNonEmptyString(entry.id);
    if (!id || !LOCAL_ID_RE.test(id)) {
      issues.push(issue('error', 'settings', index, id ?? '', '缺少或非法的 id，已忽略'));
      return;
    }
    if (seen.has(id)) {
      issues.push(issue('error', 'settings', index, id, `设置项 id 重复：${id}`));
      return;
    }
    seen.add(id);

    const label = asNonEmptyString(entry.label);
    if (!label) {
      issues.push(issue('error', 'settings', index, id, '缺少 label，已忽略'));
      return;
    }

    const type = entry.type as SettingType;
    if (!SETTING_TYPES.includes(type)) {
      issues.push(
        issue(
          'error',
          'settings',
          index,
          id,
          `type 必须是 ${SETTING_TYPES.join(' / ')} 之一，当前：${String(entry.type)}`
        )
      );
      return;
    }

    const options = normalizeSettingOptions(entry.options, id, index, issues);
    if (type === 'select' && !options) {
      // select 没有候选项等于一个永远选不了的下拉框
      issues.push(issue('error', 'settings', index, id, 'type 为 select 但没有可用的 options，已忽略'));
      return;
    }

    const defaultRaw = entry.default;
    let defaultValue: boolean | string | number | undefined;
    if (type === 'boolean') defaultValue = asOptionalBoolean(defaultRaw);
    else if (type === 'number') defaultValue = asOptionalNumber(defaultRaw);
    else defaultValue = asOptionalString(defaultRaw);

    if (defaultRaw !== undefined && defaultValue === undefined) {
      issues.push(
        issue('warning', 'settings', index, id, `default 与 type=${type} 不匹配，已忽略该缺省值`)
      );
    }

    result.push({
      id,
      label,
      description: asOptionalString(entry.description),
      type,
      default: defaultValue,
      options,
      min: asOptionalNumber(entry.min),
      max: asOptionalNumber(entry.max),
      step: asOptionalNumber(entry.step),
      placeholder: asOptionalString(entry.placeholder),
    });
  });

  return result;
}

function normalizeContextMenus(
  entries: unknown[],
  commands: CommandContribution[],
  issues: ContributionIssue[]
): ContextMenuContribution[] {
  const result: ContextMenuContribution[] = [];
  const seen = new Set<string>();
  const commandIds = new Set(commands.map((command) => command.id));

  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      issues.push(issue('error', 'contextMenus', index, '', '条目不是对象，已忽略'));
      return;
    }

    const id = asNonEmptyString(entry.id);
    if (!id || !LOCAL_ID_RE.test(id)) {
      issues.push(issue('error', 'contextMenus', index, id ?? '', '缺少或非法的 id，已忽略'));
      return;
    }
    if (seen.has(id)) {
      issues.push(issue('error', 'contextMenus', index, id, `右键菜单 id 重复：${id}`));
      return;
    }
    seen.add(id);

    const label = asNonEmptyString(entry.label);
    if (!label) {
      issues.push(issue('error', 'contextMenus', index, id, '缺少 label，已忽略'));
      return;
    }

    const command = asNonEmptyString(entry.command);
    if (!command) {
      issues.push(issue('error', 'contextMenus', index, id, '缺少 command，已忽略'));
      return;
    }

    // 菜单项执行的是**一条已声明的命令** —— 这条交叉检查是整份校验里最值钱的一条：
    // 写错命令 ID 的菜单项在旧模型下要到用户点下去、什么都没发生时才暴露。
    if (!commandIds.has(command)) {
      issues.push(
        issue(
          'error',
          'contextMenus',
          index,
          id,
          `command 指向了未声明的命令 "${command}"；菜单项不会出现`
        )
      );
      return;
    }

    result.push({
      id,
      label,
      command,
      icon: asOptionalString(entry.icon),
      group: asOptionalString(entry.group),
    });
  });

  return result;
}

// ============================================================
// 入口：规范化整份 contributes
// ============================================================

function issue(
  level: ContributionIssue['level'],
  kind: ContributionIssue['kind'],
  index: number,
  id: string,
  message: string
): ContributionIssue {
  return { level, kind, index, id, message };
}

/**
 * 把清单里的 `contributes` 规范化成贡献集。
 *
 * 宽容但有判据：
 *   * 未知的**贡献点名称**被静默忽略（`themes` 之类将来才做的，旧宿主不该因此报错）；
 *   * 已知贡献点里**形状不对的条目**被逐条丢弃并给出问题，
 *     而不是让整份 `contributes` 作废 —— 一条坏条目不该带走另外九条好条目。
 *
 * `modules` 先于 `contextMenus` 处理，因为右键菜单的 `command` 要对着命令表交叉校验。
 */
export function normalizeContributions(
  raw: unknown
): { contributions: NormalizedContributions; issues: ContributionIssue[]; present: boolean } {
  const issues: ContributionIssue[] = [];
  const contributions = emptyContributions();

  if (raw === undefined || raw === null) {
    return { contributions, issues, present: false };
  }

  if (!isPlainObject(raw)) {
    issues.push(
      issue('error', 'contributes', -1, '', `contributes 必须是对象，当前是 ${typeof raw}`)
    );
    return { contributions, issues, present: true };
  }

  const moduleEntries = readArrayField(raw, 'modules');
  const commandEntries = readArrayField(raw, 'commands');
  const settingEntries = readArrayField(raw, 'settings');
  const menuEntries = readArrayField(raw, 'contextMenus');

  for (const [kind, entries] of [
    ['modules', moduleEntries],
    ['commands', commandEntries],
    ['settings', settingEntries],
    ['contextMenus', menuEntries],
  ] as const) {
    if (entries === null) {
      issues.push(issue('error', kind, -1, '', `${kind} 必须是数组，已按空处理`));
    }
  }

  if (moduleEntries) contributions.modules = normalizeModules(moduleEntries, issues);
  // 命令要在设置/菜单之前规范化：菜单项合法性依赖命令表
  if (commandEntries) contributions.commands = normalizeCommands(commandEntries, issues);
  if (settingEntries) contributions.settings = normalizeSettings(settingEntries, issues);
  if (menuEntries) {
    contributions.contextMenus = normalizeContextMenus(menuEntries, contributions.commands, issues);
  }

  if (hasNoContribution(contributions)) {
    issues.push(
      issue(
        'warning',
        'contributes',
        -1,
        '',
        `contributes 里没有任何宿主认识的贡献点（认识的有：${CONTRIBUTION_KINDS.join(' / ')}）`
      )
    );
  }

  return { contributions, issues, present: true };
}

// ============================================================
// 激活事件
// ============================================================

/** `onModule:<id>` */
export function activationEventForModule(moduleId: string): ActivationEvent {
  return `onModule:${moduleId}`;
}

/** `onCommand:<本地 id>` */
export function activationEventForCommand(localId: string): ActivationEvent {
  return `onCommand:${localId}`;
}

/** `onContextMenu:<本地 id>` */
export function activationEventForContextMenu(localId: string): ActivationEvent {
  return `onContextMenu:${localId}`;
}

/** 取事件名（冒号之前的部分）；没有冒号时为整个字符串 */
export function activationEventName(event: string): string {
  const colon = event.indexOf(':');
  return colon === -1 ? event : event.slice(0, colon);
}

/** 取参数（冒号之后的部分）；没有冒号时为空串 */
export function activationEventArgument(event: string): string {
  const colon = event.indexOf(':');
  return colon === -1 ? '' : event.slice(colon + 1);
}

/**
 * 解析 `activationEvents`。
 *
 * 除了「名字不认识」，「参数指向了不存在的东西」也报出来 —— 后者才是真正难查的
 * 一类：`onModule:panle` 会让插件**永远不激活**，而用户看到的只是「点开是空白」。
 * 把交叉检查放在这里，等于把这类笔误从运行期提前到了清单校验期。
 */
export function parseActivationEvents(
  raw: unknown,
  contributions: NormalizedContributions
): { events: ActivationEvent[]; issues: ContributionIssue[] } {
  const issues: ContributionIssue[] = [];
  const events: ActivationEvent[] = [];

  if (raw === undefined || raw === null) return { events, issues };

  if (!Array.isArray(raw)) {
    issues.push(
      issue('error', 'activationEvents', -1, '', `activationEvents 必须是数组，当前是 ${typeof raw}`)
    );
    return { events, issues };
  }

  const moduleIds = new Set(contributions.modules.map((m) => m.id));
  const commandIds = new Set(contributions.commands.map((c) => c.id));
  const menuIds = new Set(contributions.contextMenus.map((m) => m.id));
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const value = asNonEmptyString(entry);
    if (!value) {
      issues.push(issue('error', 'activationEvents', index, '', '事件不是非空字符串，已忽略'));
      return;
    }
    if (seen.has(value)) {
      issues.push(issue('warning', 'activationEvents', index, value, `激活事件重复：${value}`));
      return;
    }
    seen.add(value);

    const name = activationEventName(value);
    const argument = activationEventArgument(value);

    if (!(ACTIVATION_EVENT_NAMES as readonly string[]).includes(name)) {
      issues.push(
        issue(
          'warning',
          'activationEvents',
          index,
          value,
          `宿主不认识激活事件 "${value}"，它永远不会触发（认识的有：${ACTIVATION_EVENT_NAMES.join(' / ')}）`
        )
      );
      return;
    }

    if (name === 'onStartup') {
      if (argument) {
        issues.push(
          issue(
            'warning',
            'activationEvents',
            index,
            value,
            'onStartup 不接受参数，已按 onStartup 处理'
          )
        );
      }
      events.push('onStartup');
      return;
    }

    if (name === 'onModule' && !moduleIds.has(argument)) {
      issues.push(
        issue(
          'error',
          'activationEvents',
          index,
          value,
          `onModule 指向了未声明的模块 "${argument}"，该事件永远不会触发`
        )
      );
      return;
    }

    if (name === 'onCommand' && !commandIds.has(argument)) {
      issues.push(
        issue(
          'error',
          'activationEvents',
          index,
          value,
          `onCommand 指向了未声明的命令 "${argument}"，该事件永远不会触发`
        )
      );
      return;
    }

    if (name === 'onContextMenu' && !menuIds.has(argument)) {
      issues.push(
        issue(
          'error',
          'activationEvents',
          index,
          value,
          `onContextMenu 指向了未声明的菜单项 "${argument}"，该事件永远不会触发`
        )
      );
      return;
    }

    events.push(value as ActivationEvent);
  });

  return { events, issues };
}

// ============================================================
// 装载契约
// ============================================================

/**
 * 从清单算出这个插件的装载契约。
 *
 * 兼容规则是这一整块的核心，写成表就是：
 *
 * | 清单                                   | declarative | eager | 含义                       |
 * | -------------------------------------- | ----------- | ----- | -------------------------- |
 * | 没有 `contributes`                     | false       | true  | 旧式：行为与 1.2.0 前一致   |
 * | 有 `contributes`，有 `onStartup`       | true        | true  | 声明式 + 启动即激活         |
 * | 有 `contributes`，有事件但无 `onStartup` | true      | false | 声明式 + 按需激活           |
 * | 有 `contributes`，没有任何事件          | true        | true  | 声明式，但退化为启动即激活   |
 *
 * 最后一行的取舍值得说明：**忘写 `activationEvents` 只应该损失「懒」，不应该
 * 让插件坏掉。** 反过来（默认不激活）会让一个本来能用的插件变成点开是空白，
 * 而作者要读文档才知道少了什么 —— 那是把配置疏漏放大成了故障。
 */
export function resolveLoadContract(manifest: {
  contributes?: unknown;
  activationEvents?: unknown;
}): PluginLoadContract {
  const { contributions, issues, present } = normalizeContributions(manifest.contributes);

  if (!present) {
    return {
      declarative: false,
      eager: true,
      events: [],
      contributions,
      issues,
    };
  }

  const parsed = parseActivationEvents(manifest.activationEvents, contributions);
  issues.push(...parsed.issues);

  if (parsed.events.length === 0) {
    issues.push(
      issue(
        'warning',
        'activationEvents',
        -1,
        '',
        '声明了 contributes 但没有任何可用的 activationEvents，将退化为「后台加载期激活」'
      )
    );
  }

  return {
    declarative: true,
    eager: parsed.events.length === 0 || parsed.events.includes('onStartup'),
    events: parsed.events,
    contributions,
    issues,
  };
}

// ============================================================
// 命名
// ============================================================

/**
 * 命令在全局面板里的 ID。
 *
 * 前缀格式必须与 `pluginRuntime` 的注册、`commandRegistry` 的
 * `unregisterCommandsByPrefix` 三处一致 —— 因此它只在这里定义一次。
 */
export function commandFullId(pluginId: string, localId: string): string {
  return `plugin:${pluginId}:${localId}`;
}

/** 命令 ID 的前缀（按它批量注销） */
export function commandPrefix(pluginId: string): string {
  return `plugin:${pluginId}:`;
}

/** 设置项在插件存储命名空间里的键 */
export function settingStorageKey(settingId: string): string {
  // 保留前缀，避免与插件自己用 ctx.storage 写的键撞上
  return `__host__.setting.${settingId}`;
}
