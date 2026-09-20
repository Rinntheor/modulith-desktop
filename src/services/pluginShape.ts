// src/services/pluginShape.ts
//
// 插件形态：「这个插件有没有界面」。
//
// ---------------------------------------------------------------------------
// 为什么这是一条**派生**信息，而不是一个让作者填的字段
//
// 形态决定"它会不会占据侧边栏的一行"，是用户判断一个插件会对自己界面做什么的依据。
// 这与权限风险同理 —— **由被审查的一方提供的信息不可信**，因此它从 `contributes`
// 派生，而不是从清单里的 `categories` 读。
//
// `categories` 仍然保留、市场仍然可以用它做筛选，但它承担的是**浏览意图**
// （"我想找效率类工具"），不是**形态判断**。两者混在一起，就会出现"有人把纯命令插件
// 标成界面型"这种事，而用户没有办法分辨。
// ---------------------------------------------------------------------------
//
// 为什么单独成一个纯模块：市场页读的是**索引**（未安装插件），插件管理页读的是
// **清单**（已安装插件），两处数据来源不同、但派生规则必须只有一份，否则两边必然分叉。
//
// 形态只有三档，这是刻意的：**分级一旦超过两档，用户就要先学一套分类法** —— 那和
// "不好分类"是同一个病。种类不做成"混合型"这种第三档，而是做成卡片上的小徽章。

import type { NormalizedContributions } from './pluginContributions';

/**
 * 插件形态。
 *
 * - `ui`      界面型：贡献了模块，会占侧边栏一行
 * - `headless` 功能型：没有模块，但有命令 / 设置 / 右键菜单 / 后台行为
 * - `unknown`  未声明：旧式插件（清单里没有 `contributes`），形态要等它加载后才确定
 */
export type PluginShape = 'ui' | 'headless' | 'unknown';

/** 形态判断的来源 —— 界面上要能说清"这个判断有多可信" */
export type PluginShapeSource = 'manifest' | 'index' | 'runtime' | 'none';

export interface PluginShapeInfo {
  shape: PluginShape;
  /** 贡献了哪些种类（**存在**，不是数量：索引与清单能提供的信息粒度不同） */
  kinds: {
    modules: boolean;
    commands: boolean;
    settings: boolean;
    contextMenus: boolean;
  };
  /** 声明了 `onStartup` —— 它在应用可用之后就会开始工作 */
  background: boolean;
  source: PluginShapeSource;
}

export const SHAPE_LABELS: Record<PluginShape, string> = {
  ui: '界面型',
  headless: '功能型',
  unknown: '形态未知',
};

export const SHAPE_HINTS: Record<PluginShape, string> = {
  ui: '会在侧边栏占用一个条目',
  headless: '不占侧边栏，通过命令、设置或后台运行来工作',
  unknown: '插件没有声明贡献点，形态要等它加载之后才能确定',
};

/**
 * 徽章顺序 = 显示顺序。
 *
 * 顺序按"用户会先注意到什么"排：模块 > 命令 > 设置 > 右键菜单 > 后台。
 */
export const SHAPE_BADGES: ReadonlyArray<{
  key: keyof PluginShapeInfo['kinds'];
  label: string;
}> = [
  { key: 'modules', label: '模块' },
  { key: 'commands', label: '命令' },
  { key: 'settings', label: '设置' },
  { key: 'contextMenus', label: '右键菜单' },
];

const BACKGROUND_LABEL = '后台';

/** 一个形态未知的结果（`source` 说明为什么不知道） */
export function unknownShape(source: PluginShapeSource = 'none'): PluginShapeInfo {
  return {
    shape: 'unknown',
    kinds: { modules: false, commands: false, settings: false, contextMenus: false },
    background: false,
    source,
  };
}

/**
 * 由一个已解析的贡献集派生形态（**权威来源**）。
 *
 * 判据只有一条：有没有 `modules`。其余都是徽章，不参与分级。
 */
export function shapeFromContributions(
  contributions: NormalizedContributions,
  activationEvents: readonly string[] = []
): PluginShapeInfo {
  const kinds = {
    modules: contributions.modules.length > 0,
    commands: contributions.commands.length > 0,
    settings: contributions.settings.length > 0,
    contextMenus: contributions.contextMenus.length > 0,
  };

  const background = activationEvents.includes('onStartup');
  const hasAnything =
    kinds.modules || kinds.commands || kinds.settings || kinds.contextMenus || background;

  return {
    // 没有界面但有别的东西 → 功能型；什么都没有 → 形态未知（那是"贡献集为空"的插件，
    // 它在加载期会被判为失败，因此这里的 unknown 不会被用户看到）
    shape: kinds.modules ? 'ui' : hasAnything ? 'headless' : 'unknown',
    kinds,
    background,
    source: 'manifest',
  };
}

/**
 * 由索引里的 `kinds` 派生形态（用于**未安装**的插件）。
 *
 * 索引是打包时按清单算出来的，精度比清单低（只有种类、没有数量），但对"有没有界面"
 * 这个问题足够 —— 而这正是它存在的唯一目的。
 *
 * 传进来不是数组（旧索引没有这个字段）时返回 `unknown`，界面据此显示「形态未知」，
 * 而不是猜成界面型或功能型。
 */
export function shapeFromIndexKinds(
  kinds: unknown,
  options: { background?: unknown } = {}
): PluginShapeInfo {
  if (!Array.isArray(kinds)) return unknownShape('none');

  const set = new Set(kinds.filter((item): item is string => typeof item === 'string'));

  const info: PluginShapeInfo = {
    shape: 'unknown',
    kinds: {
      modules: set.has('modules'),
      commands: set.has('commands'),
      settings: set.has('settings'),
      contextMenus: set.has('contextMenus'),
    },
    background: options.background === true,
    source: 'index',
  };

  const hasAnything =
    info.kinds.modules ||
    info.kinds.commands ||
    info.kinds.settings ||
    info.kinds.contextMenus ||
    info.background;

  // 索引里很可能**没有**这个插件的形态（旧索引、或打包时字段还没加），
  // 此时 kinds 是空数组 —— 那和"声明了但什么都不贡献"是两件事，不能混为一谈。
  if (kinds.length === 0) return unknownShape('none');

  info.shape = info.kinds.modules ? 'ui' : hasAnything ? 'headless' : 'unknown';
  return info;
}

/**
 * 由**已安装**插件的运行时状态派生形态。
 *
 * 旧式插件（清单里没有 `contributes`）在它加载之前，宿主确实不知道它有没有界面 ——
 * 因为旧式插件的目录条目是它执行时才注册的。此时返回「形态未知」是诚实的；
 * 猜成界面型会在插件加载完之后当场打脸。
 */
export function shapeFromInstalled(
  contract: { declarative: boolean; contributions: NormalizedContributions; events: readonly string[] } | undefined,
  runtimeModuleCount: number
): PluginShapeInfo {
  if (contract?.declarative) {
    return shapeFromContributions(contract.contributions, contract.events);
  }

  if (runtimeModuleCount > 0) {
    return {
      shape: 'ui',
      kinds: { modules: true, commands: false, settings: false, contextMenus: false },
      background: false,
      source: 'runtime',
    };
  }

  return unknownShape('none');
}

/** 徽章文本列表（含后台），供界面直接渲染 */
export function shapeBadgeLabels(info: PluginShapeInfo): string[] {
  const labels = SHAPE_BADGES.filter((badge) => info.kinds[badge.key]).map((badge) => badge.label);
  if (info.background) labels.push(BACKGROUND_LABEL);
  return labels;
}

/** 形态的可信度说明 —— 界面上用一行小字讲清"这个判断是权威的还是推算的" */
export function shapeSourceHint(info: PluginShapeInfo): string | null {
  switch (info.source) {
    case 'manifest':
      return null; // 来自清单，就是权威的，不需要解释
    case 'index':
      return '形态来自索引（打包时按清单生成）';
    case 'runtime':
      return '形态来自它在本次运行中的实际注册';
    default:
      return '尚未加载，形态未知';
  }
}
