// src/services/pluginMarket.ts
// 插件市场：拉取索引、校验结构、下载并安装
//
// 分工是刻意的：**后端只负责"取回一段文本"与"下载 + 校验哈希后安装"**，索引的解析、
// 缓存与版本比对本文件负责。后端不该知道索引里有几个字段。
//
// 两处安全约束在这里体现：
//
// 1. **风险等级不由索引提供。** 索引里只有权限标识符，标签与风险等级一律来自宿主的
//    权限注册表（`permissionRegistry.ts`）。若等级来自索引，一个被篡改的索引就能把
//    `process-spawn` 标成低风险。
// 2. **安装必须带哈希。** `install_plugin_url_verified` 强制要求传入 sha256，因此
//    市场这条路径不可能"忘了校验"。哈希挡住的是下载损坏与 CDN 缓存污染。

import { invoke } from '@tauri-apps/api/core';

import { shapeFromIndexKinds, type PluginShapeInfo } from './pluginShape';
import type { PluginRuntimeKind } from '../types/plugin';

import {
  PLUGIN_INDEX_REF,
  pluginIndexSources,
  registrySources,
  type SourcePreference,
} from '../config/pluginRegistry';
import { isNewer } from '../utils/semver';
import { isProxyEffective } from '../utils/networkSettings';
import { getCachedSettings } from './appSettings';
import { logMessage } from './logger';
import { getPermissionDescriptor } from './permissionRegistry';
import { getInstalledPlugins } from './pluginRuntime';

/**
 * 候选地址的优先顺序
 *
 * 选了下载源（且地址非空）时把 GitHub 那条排前面：用户选它就是因为直连不通，
 * 而 CDN 那一步在受限网络里要先等一个连接超时。判断与后端 `network::proxy_base`
 * 用同一套规则（`isProxyEffective`），因此界面上的候选顺序与实际生效的设置一致。
 *
 * **每次调用都重新读**：用户可能刚在设置里改完就切回市场点刷新。
 */
function sourcePreference(): SourcePreference {
  const settings = getCachedSettings();
  return isProxyEffective(settings.networkMode, settings.githubProxy)
    ? 'github-first'
    : 'cdn-first';
}

/** 本应用能理解的索引格式版本。索引里的值高于它时，提示更新应用而不是硬解析。 */
const SUPPORTED_SCHEMA_VERSION = 1;

export interface MarketPackage {
  path: string;
  size: number;
  sha256: string;
}

export interface MarketVersion {
  version: string;
  tag: string;
  /**
   * 兼容的宿主版本范围。**`null` 表示这一版索引里没有声明它。**
   *
   * ============================================================
   * 它为什么是**可选**的（这一条是被一次真实故障逼出来的）
   * ============================================================
   *
   * 它曾经是必填：`engines.modulith` 缺失时整份索引判为非法，市场对所有人
   * 打不开。而这个字段**只用于展示**（详情页的"需要宿主"一行），宿主不据此
   * 做任何决定 —— 已安装那一侧更是明确写着"它只提示、不阻断"
   * （见 `pluginRuntime.ts` 的 `engineAdvisory`）。
   *
   * 于是一个纯展示字段把整个市场弄挂了。触发它的是一次真实的漂移：插件仓库在
   * **项目改名**时换掉了 `engines` 的键名，而那份索引还没推上去 —— 发布出去的
   * 应用拿到旧索引，里面当然没有 `modulith`，于是两道来源（CDN 与 GitHub 直连）
   * 给出同一个错误。旧键名是什么，见
   * `docs/06-项目/已知问题与技术债.md` §7.51（**代码里不写它**：`check:contributions`
   * 第 5 节在扫它，而那条断言要防的正是它被重新读回来）。
   *
   * ============================================================
   * 判据：宿主**据此行事**的字段必须严格，只用于展示的字段不许拖垮整份索引
   * ============================================================
   *
   * 这不是"放宽校验"，是把线划在该划的地方。同一份索引里 `id` / `version` /
   * `tag` / `package.sha256` / `permissions` 仍然一律严格 —— 那几个宿主真的会
   * 用到（装什么、校验哪个哈希、显示什么风险），一个坏了就该整份拒绝。
   * 而 `engines` / `kinds` / `background` 是同一个性质：缺了就如实说"未声明"，
   * 不要为了让一份展示信息合法而让用户装不了任何东西。
   *
   * 界面上因此显示「未声明」而不是 `*`：`*` 是"声明了不限制"，与"没声明"
   * 是两件不同的事，把后者渲染成前者等于替发布者说了一句他没说过的话。
   */
  engines: { modulith: string | null };
  permissions: string[];
  package: MarketPackage;
  /**
   * 这个版本贡献了哪些种类（`modules` / `commands` / `settings` / `contextMenus`）。
   *
   * **可选。** 旧索引没有这个字段，宿主据此显示「形态未知」而不是猜一个 ——
   * 猜错的表现是"标着界面型，装完发现不占侧边栏"，而用户无从分辨。
   *
   * 它由插件仓库在**打包时从清单派生**，不是作者手填的。形态决定"这个插件会不会
   * 占据侧边栏一行"，属于用户判断依据；与权限风险同理，不能由被审查的一方提供。
   * 因此它也不放在插件级、而放在**版本级** —— 与 `permissions` 同一个位置，
   * 因为一个插件的形态可以随版本变化（例如从纯命令插件长出了界面）。
   */
  kinds?: string[];
  /** 是否声明了 `onStartup`：应用可用之后它就会开始工作 */
  background?: boolean;
  /**
   * 这个版本跑在哪里（`sandboxed` / `in-process`）。**由打包时从清单派生。**
   *
   * `undefined` 表示**不知道**：索引比清单旧、或它来自一个还没有这个字段的
   * 构建脚本。与 `kinds` 同一位置、同一性质 —— 但它比 `kinds` 重要得多：
   * `kinds` 只影响"会不会占侧边栏"，而这一项决定**安装策略放不放行**
   * （见 `installGate`）。因此读不出来时按未隔离对待，绝不猜成 `sandboxed`。
   */
  runtime?: PluginRuntimeKind;
}

export interface MarketPlugin {
  id: string;
  displayName: string;
  summary: string;
  author: { name: string; url?: string };
  license: string;
  categories?: string[];
  keywords?: string[];
  icon?: string;
  /** 仓库内的源码目录。省略表示只分发 .lcp，源码不公开 */
  source?: string;
  latest: string;
  versions: MarketVersion[];
}

export interface MarketIndex {
  schemaVersion: number;
  plugins: MarketPlugin[];
}

/**
 * 某个市场插件（按它的最新版本）的形态。
 *
 * 索引里没有形态信息时返回 `unknown`，界面显示「形态未知」——
 * 这是诚实的结果，也是推动插件仓库补上这个字段的依据。**不要在这里猜**：
 * 猜成界面型的表现是"标着会占侧边栏，装完发现不占"，而用户无从分辨谁错了。
 */
export function marketPluginShape(plugin: MarketPlugin): PluginShapeInfo {
  const version = latestVersionOf(plugin);
  return shapeFromIndexKinds(version.kinds, { background: version.background });
}

// ============================================================
// 解析
// ============================================================

function fail(message: string): never {
  throw new Error(message);
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where} 必须是非空字符串`);
  }
  return value;
}

/**
 * 读一个**只用于展示**的字符串字段：缺失或形状不对都返回 `null`。
 *
 * 与 `asString` 的分工就是这次划的那条线：宿主据此行事的字段用 `asString`
 * （坏了整份索引失败），只用于展示的字段用这个（缺了如实说"未声明"）。
 * 见 `MarketVersion.engines` 上的长说明。
 */
function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseVersion(raw: unknown, where: string): MarketVersion {
  if (!raw || typeof raw !== 'object') fail(`${where} 不是对象`);
  const item = raw as Record<string, unknown>;

  const pkg = item.package;
  if (!pkg || typeof pkg !== 'object') fail(`${where}.package 缺失`);
  const p = pkg as Record<string, unknown>;

  const sha256 = asString(p.sha256, `${where}.package.sha256`);
  // 在下载之前就先核一遍格式：索引写坏了应当在"点安装之前"就暴露，
  // 而不是等下载完再报一个看起来像篡改的错误。
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
    fail(`${where}.package.sha256 不是 64 位十六进制`);
  }

  const permissions = item.permissions;
  if (!Array.isArray(permissions)) fail(`${where}.permissions 必须是数组`);

  // `engines` 整个缺失、不是对象、或对象里没有 `modulith` —— 三种情况**都不失败**。
  // 它是展示字段，宿主不据此做任何决定（见 `MarketVersion.engines` 的长说明）。
  //
  // 这里刻意**不去兼容改名之前的那个旧键名**：它既不会被读取、也不会报错的意思
  // 正是"看起来声明了兼容范围，实际什么都没声明"，把它当成 `modulith` 等于
  // 替发布者说一句他没说过的话。缺了就是缺了。
  //
  // 收成一个具名的对象（而不是在下面直接 `(engines as ...)`），是为了让
  // `engines.modulith` 这个读取点在源码里以**属性访问**的形式出现 ——
  // `check:contributions` 第 2 节正是按属性访问扫的，它要保证"每一处读这个键的
  // 地方都用同一个键名"。写成一次类型断言会让那条断言看不见这个读取点。
  const rawEngines = item.engines;
  const engines: Record<string, unknown> =
    rawEngines && typeof rawEngines === 'object'
      ? (rawEngines as Record<string, unknown>)
      : {};

  return {
    version: asString(item.version, `${where}.version`),
    tag: asString(item.tag, `${where}.tag`),
    // 形态信息是**可选**的：解析它必须比解析 permissions 宽松。
    // 旧索引缺这两个字段是正常情况，不能让它把整份索引判为非法 ——
    // 那会让市场对所有人打不开，而原因只是一条展示信息。
    kinds: Array.isArray(item.kinds)
      ? item.kinds.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    background: item.background === true ? true : undefined,
    engines: { modulith: asOptionalString(engines.modulith) },
    runtime: parseRuntime(item.runtime),
    permissions: permissions.map((entry, index) =>
      asString(entry, `${where}.permissions[${index}]`)
    ),
    package: {
      path: asString(p.path, `${where}.package.path`),
      size: typeof p.size === 'number' ? p.size : 0,
      sha256: sha256.toLowerCase(),
    },
  };
}

/**
 * 读版本级 `runtime`（"这个版本跑在哪里"）。
 *
 * ============================================================
 * 为什么它必须宽容，而不像清单里的 `runtime` 那样"未知值让整份不合法"
 * ============================================================
 *
 * 清单里那条严格是对的：一个声明了 `sandboxed` 却被旧宿主当成 `in-process`
 * 跑起来的插件，是一次**静默的安全降级**（见 types.rs 的 `PluginRuntime`）。
 * 那里有权威的一侧 —— 清单在插件包里，与它自己的代码一起，没有第二份。
 *
 * 索引不是。索引是**打包时从清单派生**的一份缓存，它可能比清单旧一个版本、
 * 也可能来自一个还没带上这个字段的旧构建脚本。因此这里读不出来时的正确动作
 * 不是"拒绝"，而是**返回 `undefined` 说"不知道"** —— 由安装策略按未隔离对待
 * （见 `pluginMarket.ts` 的 `installGate`）。猜一个 `'sandboxed'` 才是真的危险：
 * 那会让界面标着"已隔离"，而装下来的东西不是。
 *
 * 取值只认两个字面量，别的（拼写错误、数字、对象）一律归为"不知道"。
 */
function parseRuntime(value: unknown): PluginRuntimeKind | undefined {
  return value === 'sandboxed' || value === 'in-process' ? value : undefined;
}

function parsePlugin(raw: unknown, index: number): MarketPlugin {
  const where = `plugins[${index}]`;
  if (!raw || typeof raw !== 'object') fail(`${where} 不是对象`);
  const item = raw as Record<string, unknown>;

  const versions = item.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    fail(`${where}.versions 必须是非空数组`);
  }

  const latest = asString(item.latest, `${where}.latest`);
  const parsedVersions = versions.map((entry, i) => parseVersion(entry, `${where}.versions[${i}]`));
  if (!parsedVersions.some((v) => v.version === latest)) {
    fail(`${where}.latest（${latest}）在 versions 里不存在`);
  }

  const author = item.author;
  const authorName =
    author && typeof author === 'object'
      ? typeof (author as Record<string, unknown>).name === 'string'
        ? ((author as Record<string, unknown>).name as string)
        : ''
      : '';

  return {
    id: asString(item.id, `${where}.id`),
    displayName: asString(item.displayName, `${where}.displayName`),
    summary: typeof item.summary === 'string' ? item.summary : '',
    author: {
      name: authorName,
      ...(author && typeof (author as Record<string, unknown>).url === 'string'
        ? { url: (author as Record<string, unknown>).url as string }
        : {}),
    },
    license: typeof item.license === 'string' ? item.license : '',
    ...(Array.isArray(item.categories) ? { categories: item.categories as string[] } : {}),
    ...(Array.isArray(item.keywords) ? { keywords: item.keywords as string[] } : {}),
    ...(typeof item.icon === 'string' ? { icon: item.icon } : {}),
    ...(typeof item.source === 'string' ? { source: item.source } : {}),
    latest,
    versions: parsedVersions,
  };
}

/**
 * 解析索引文本。
 *
 * **结构错误一律整体失败，不做"跳过坏条目"。** 索引是本仓库的脚本生成的，出现坏条目
 * 说明上游真的坏了；跳过它只会让问题以一个"少了一个插件"的形式安静地存在，而那种现象
 * 会被归因于网络。失败时给出的错误直接指向是哪个插件哪一项，排查成本很低。
 */
export function parseIndex(text: string): MarketIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`索引不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!raw || typeof raw !== 'object') fail('索引不是对象');
  const index = raw as Record<string, unknown>;

  const schemaVersion = index.schemaVersion;
  if (typeof schemaVersion !== 'number') fail('索引缺少 schemaVersion');
  if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    fail(
      `索引的格式版本为 ${schemaVersion}，当前应用只支持到 ${SUPPORTED_SCHEMA_VERSION}。请先更新应用。`
    );
  }

  if (!Array.isArray(index.plugins)) fail('索引缺少 plugins 数组');

  return {
    schemaVersion,
    plugins: index.plugins.map((entry, i) => parsePlugin(entry, i)),
  };
}

// ============================================================
// 拉取与缓存
// ============================================================

let cached: MarketIndex | null = null;
let inflight: Promise<MarketIndex> | null = null;

function describeSource(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 依次尝试候选地址取回索引，**验签通过后才解析**。
 *
 * 顺序不能反。索引是插件分发的信任根（它同时给出「装什么」与「校验哪个哈希」），先解析
 * 一份不可信的索引等于让攻击者的内容先进入解析器；而且解析失败与验签失败给出的提示完全
 * 不同，混在一起会让排查方向跑偏。
 *
 * 不做 JS 侧的额外超时：后端 reqwest 客户端已经配了 30 秒超时，前端再加一层只会产生
 * 两处不一致的超时，且先到期的那个会让另一个 promise 悬空。
 */
async function fetchIndex(): Promise<MarketIndex> {
  const failures: string[] = [];

  for (const source of pluginIndexSources(Date.now(), sourcePreference())) {
    try {
      const text = await invoke<string>('fetch_registry_text', { url: source.index });
      const signature = await invoke<string>('fetch_registry_text', {
        url: source.signature,
      });

      await invoke('verify_plugin_index', { index: text, signature });
      return parseIndex(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${describeSource(source.index)}：${reason}`);
    }
  }

  // 两条来源都失败才算市场打不开。这条汇总要进日志：后端记录的是每一次
  // 尝试与它的失败原因，前端记录的是「合起来意味着什么」。
  const message = `无法获取插件索引。\n${failures.join('\n')}`;
  logMessage('error', message, 'pluginMarket');
  fail(message);
}
/**
 * 取回索引。默认命中缓存；`force` 会重新拉取（供"刷新"按钮使用）。
 *
 * 并发调用共用同一个请求：市场页与将来的更新检查可能同时触发，没必要拉两次。
 */
export async function loadIndex(options: { force?: boolean } = {}): Promise<MarketIndex> {
  if (!options.force) {
    if (cached) return cached;
    if (inflight) return inflight;
  }

  inflight = fetchIndex()
    .then((index) => {
      cached = index;
      inflight = null;
      return index;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });

  return inflight;
}

// ============================================================
// 与本机状态对照
// ============================================================

/** 取某个插件在索引里的最新版本条目 */
export function latestVersionOf(plugin: MarketPlugin): MarketVersion {
  const found = plugin.versions.find((v) => v.version === plugin.latest);
  if (!found) fail(`索引里 ${plugin.id} 的 latest（${plugin.latest}）没有对应条目`);
  return found;
}

/** 本机某个插件相对索引最新版本的状态 */
export type UpdateState =
  | { kind: 'not-installed' }
  | { kind: 'up-to-date'; version: string }
  | { kind: 'update-available'; from: string; to: string }
  | { kind: 'local-newer'; version: string }
  | { kind: 'dev-linked'; version: string };

/**
 * 判断本机已安装版本与索引里的最新版本之间的关系。
 *
 * `dev-linked` 单独成一类，因为**市场不该更新开发链接的插件**：那会把它从"实时读取源
 * 目录"换成"安装目录里的副本"，静默丢掉用户刻意选择的工作方式。它本来也不需要更新 ——
 * 改了源码点刷新就生效。
 *
 * `local-newer` 也是一类：用户可能从 `.lcp` 装了比索引里更新的版本（比如索引还没更新）。
 * 这时不该显示"可更新" —— 那会诱导用户降级。
 */
export function updateStateFor(plugin: MarketPlugin): UpdateState {
  const installed = getInstalledPlugins().find((p) => p.id === plugin.id);
  if (!installed) return { kind: 'not-installed' };
  if (installed.devSource) return { kind: 'dev-linked', version: installed.version };

  if (isNewer(plugin.latest, installed.version)) {
    return { kind: 'update-available', from: installed.version, to: plugin.latest };
  }
  if (isNewer(installed.version, plugin.latest)) {
    return { kind: 'local-newer', version: installed.version };
  }
  return { kind: 'up-to-date', version: installed.version };
}

/** 一次更新涉及的权限变化 */
export interface UpdatePlan {
  /** 本机当前版本 */
  from: string;
  version: MarketVersion;
  /** 新版本新增的权限 */
  added: string[];
  /** 新版本不再申请的权限 */
  removed: string[];
  /** 这次「更新」实际是退回到更旧的版本 */
  downgrade: boolean;
  /**
   * 是否需要用户明确确认。
   *
   * 规则见设计文档 3.8：权限变少、或只新增低风险权限时静默；**只要新增了中/高风险权限
   * 就必须确认**，且用户拒绝时保留旧版本（不卸载、不回滚、不部分应用）。
   *
   * 判断依据是**等级而非数量** —— 新增十个低风险权限不该比新增一个高风险权限更受阻拦。
   *
   * 降级也一律确认：权限没变不代表用户想退回旧版本。本机版本比仓库新是可能发生的
   * （从 `.lcp` 装了索引里还没有的版本），此时"重新安装"会被误当成升级。
   */
  needsConfirmation: boolean;
}

/**
 * 规划一次更新。未安装时返回 `null`（那是首次安装，不是更新）。
 *
 * 权限基线取自**本机已安装插件自己的清单**，而不是索引里的历史条目：清单是权威的，
 * 而且它反映的是用户实际同意过的那份权限集合。
 */
export function planUpdate(plugin: MarketPlugin): UpdatePlan | null {
  const installed = getInstalledPlugins().find((p) => p.id === plugin.id);
  if (!installed) return null;

  const version = latestVersionOf(plugin);
  const before = new Set(installed.manifest.permissions ?? []);
  const after = new Set(version.permissions);

  const added = version.permissions.filter((p) => !before.has(p));
  const removed = (installed.manifest.permissions ?? []).filter((p) => !after.has(p));
  const downgrade = isNewer(installed.version, version.version);

  return {
    from: installed.version,
    version,
    added,
    removed,
    downgrade,
    // **"这一版跑在哪里"也必须参与确认。** 权限没变不代表风险没变：一个插件
    // 完全可以保持同样的权限声明，而把 `runtime` 从 `sandboxed` 改成
    // `in-process`（或者干脆删掉那一行 —— 缺省就是 `in-process`）。
    // 只看权限的话那次更新会被判成"无需确认"，于是**一次点击把沙箱插件换成
    // 未隔离插件**，而用户什么都没被告知。
    needsConfirmation:
      downgrade ||
      !isSandboxConfirmed(version) ||
      added.some((p) => getPermissionDescriptor(p).risk !== 'low'),
  };
}

// ============================================================
// 运行位置：展示 + 安装策略
// ============================================================
//
// ============================================================
// 隔离状态有三档，而不是两档
// ============================================================
//
// `sandboxed` / `in-process` 之外必须有第三档 `unknown`：索引里的 `runtime`
// 可能**根本没有**（索引比插件仓库旧，或来自还没带上这个字段的构建脚本）。
// 把"不知道"折进任何一档都是在编：
//
//   · 折成 `sandboxed` → 界面标着"已隔离"，装下来的却可能是未隔离插件 —— 那正是
//     这个策略要防的事，而且是**用户无法察觉**的那种；
//   · 折成 `in-process` → 界面对着一份只是有点旧的索引说"这个插件未隔离"，
//     那是在冤枉一个老老实实写了 `sandboxed` 的插件，用户也无从分辨。
//
// 因此 `unknown` 有自己的说法，并且在**放行判断**上按未隔离对待（安全那一边）。

/** 一个版本隔离状态的三档 */
export type IsolationKind = 'sandboxed' | 'in-process' | 'unknown';

export interface IsolationInfo {
  kind: IsolationKind;
  /** 徽章上的两三个字 */
  label: string;
  /** 这句话要说清"这意味着什么"，而不只是复述徽章 */
  detail: string;
  /** 徽章的配色类（与市场里权限徽章同一套色板） */
  tone: string;
}

/**
 * 判断一个版本"是不是**确认**为沙箱"。只有明确写着 `sandboxed` 才算。
 *
 * 抽成一个函数而不是到处写 `version.runtime === 'sandboxed'`：这个判断同时是
 * **展示**与**放行**的依据，两处各写一遍，将来改了一处就会出现"标着已隔离、
 * 但不放行"这种自相矛盾的界面。
 */
export function isSandboxConfirmed(version: MarketVersion): boolean {
  return version.runtime === 'sandboxed';
}

export function marketVersionIsolation(version: MarketVersion): IsolationInfo {
  switch (version.runtime) {
    case 'sandboxed':
      return {
        kind: 'sandboxed',
        label: '已隔离',
        detail:
          '它跑在自己的来源里（一个跨源 iframe），拿不到宿主的能力 —— 只能通过宿主开放的那几条接口工作。',
        tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      };
    case 'in-process':
      return {
        kind: 'in-process',
        label: '未隔离',
        detail:
          '它与宿主跑在同一个上下文里：权限列表是它的**声明**，不是对它的约束 —— 它做得到的比它申报的多。',
        tone: 'border-red-200 bg-red-50 text-red-700',
      };
    default:
      return {
        kind: 'unknown',
        label: '隔离状态未知',
        detail:
          '这份索引里没有这个版本的运行位置信息（索引可能比插件仓库旧）。安装时宿主会读**包内清单**核实它到底有没有隔离 —— 不是沙箱插件的话，安装会被拒绝。',
        tone: 'border-amber-200 bg-amber-50 text-amber-700',
      };
  }
}

/** 安装策略的判定结果 */
export interface InstallGate {
  /** 是否放行 */
  allowed: boolean;
  /** 不放行时的原因（**直接给用户看**，因此要说清下一步怎么做） */
  reason: string;
  /**
   * 放行是**暂定**的：索引没说这个版本的运行位置，扣下这一点的是后端
   * （它读得到包内清单），而不是这里。
   *
   * 界面据此在确认对话框里多说一句"宿主会在安装时核实"，而不是假装已经知道。
   * 见 `installGate` 里那段"为什么 `unknown` 要放行"。
   */
  deferred: boolean;
}

/**
 * 这个版本能不能装。
 *
 * ============================================================
 * 为什么这是**宿主**的判断，而且必须在后端再判一次
 * ============================================================
 *
 * 这一处只负责**别让用户走到那个错误上去**：按钮换成"不允许安装"、说清原因。
 * 它是体验层，不是安全边界 —— 前端能被插件改（in-process 插件就与宿主共享
 * 上下文）。真正的强制在 `PluginManager::install_from_root`：那一个函数是四条
 * 安装路径（`.lcp` / 目录 / URL / 市场）唯一的汇合点，因此在那里判一次就覆盖了
 * 全部入口，包括"绕过市场直接调命令"。
 *
 * ============================================================
 * 索引是**预测**，包内清单才是**真相**
 * ============================================================
 *
 * 这一条决定了 `runtime` 读不出来时该怎么办，而两种做法都说得通，所以要说清
 * 为什么选这一个：
 *
 *   · **就地拒绝**（把"不知道"当成"未隔离"）听起来最安全，代价却落在一个
 *     无辜的对象上 —— 一份只是旧了点的索引会让**所有**插件都装不了，而其中
 *     绝大多数本来是写明了 `sandboxed` 的。用户看到的是"市场坏了"。
 *   · **放行到下一道门**（这里放行，后端据清单判）：结果要么装上（清单确实是
 *     `sandboxed`，那本来就该装上），要么被后端拒绝并给出一句准确的原因
 *     （"这个插件没有隔离…到设置里打开开关"）。两种结果都是对的。
 *
 * 后者之所以**不比前者弱**，是因为真正的边界不在这份远端索引上：索引可以被换掉，
 * 而包内清单与插件自己的代码在一起，随便换不掉。把"不知道"当成拒绝是把一道
 * 体验层的判断当成了安全边界 —— 那恰好是这一整套设计一直在避免的事。
 *
 * ============================================================
 * 默认**不放行**（对能确定的那一档）
 * ============================================================
 *
 * 索引**明确写着** `in-process` 时，这里在默认设置下拒绝。理由不是"未隔离插件
 * 不能用"，而是**一次点击不该等于一次静默的安全降级**：装了未隔离插件之后，
 * 那套沙箱对这个插件就完全不存在了 —— 而那件事没有任何界面症状。默认关着，
 * 用户要装就显式去打开（那一页写着打开意味着什么）。
 *
 * 已经装上的未隔离插件**不受影响**：这个设置只管安装。做成"关掉就禁用"
 * 会让升级应用变成一次静默的插件下线，那比它要防的问题更糟。
 */
export function installGate(version: MarketVersion): InstallGate {
  if (isSandboxConfirmed(version)) return { allowed: true, reason: '', deferred: false };

  if (version.runtime !== 'in-process') {
    // 索引里没有这一项 —— 放行到后端那一道门，并在界面上说清这一点。
    return { allowed: true, reason: '', deferred: true };
  }

  if (getCachedSettings().allowUnsandboxedPlugins) {
    return { allowed: true, reason: '', deferred: false };
  }

  return {
    allowed: false,
    deferred: false,
    reason:
      '这个版本没有隔离（它与宿主跑在同一个上下文里），而当前设置不允许安装未隔离插件。' +
      '要安装它，请到「设置 → 插件」里打开「允许安装未隔离插件」。',
  };
}

// ============================================================
// 安装
// ============================================================

/**
 * 下载并安装指定版本。
 *
 * 依次尝试候选地址。**来源可以切换是安全的**：两条路都指向同一个不可变 tag，且后端
 * 强制校验索引里记录的 sha256 —— 切换来源不会拿到不同内容。这正是哈希存在的意义之一。
 *
 * 校验失败时**不提供"仍然安装"**：哈希不符意味着下载链路或索引有问题，此时唯一安全的
 * 动作是不装。
 */
export async function installMarketVersion(
  plugin: MarketPlugin,
  version: MarketVersion
): Promise<void> {
  const failures: string[] = [];

  for (const url of registrySources(version.tag, version.package.path, sourcePreference())) {
    try {
      await invoke('install_plugin_url_verified', { url, sha256: version.package.sha256 });
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${describeSource(url)}：${reason}`);
    }
  }

  const message = `安装 ${plugin.displayName} ${version.version} 失败。\n${failures.join('\n')}`;
  logMessage('error', message, 'pluginMarket');
  fail(message);
}

// ============================================================
// 详情页的说明内容
// ============================================================

/**
 * README 的进程内缓存。只缓存成功结果。
 *
 * 不缓存失败：一次网络抖动不该让"取不到说明"变成这个会话里的永久状态 ——
 * 那会让用户以为这个插件根本没有说明。
 */
const readmeCache = new Map<string, string>();

/**
 * 缓存条目上限（README 与图标各自计）
 *
 * 这两个缓存此前**没有任何上限**：每浏览一个新插件/新版本就多一条，而一条
 * README 是几十 KB、一个图标是几十 KB 的 base64 `data:` URL。
 *
 * 取 32 的理由：一次会话里真正会来回看的插件远少于这个数，因此上限不会造成
 * 可感知的重复下载；而它把「浏览一百个插件就留一百份正文」这类增长截断掉。
 * 淘汰策略是**先进先出**（`Map` 的插入顺序）而不是 LRU：这两个缓存的读取
 * 都集中在用户当时停留的那几页，最近插入的恰好就是最可能被读的。
 */
const MAX_CACHED_ENTRIES = 32;

/** 写入一个 Map 缓存，超出上限时丢掉最早插入的那一条 */
function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.set(key, value);

  while (cache.size > MAX_CACHED_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * 取回某个版本的 README 文本。
 *
 * **详情页的说明内容来自发布者写的 `README.md`，而不是索引里的某个描述字段。**
 * 这是刻意的：描述性内容只有一个来源，发布者改它就等于改详情页。若索引里再放一份
 * 长描述，两者必然漂移，而"用户在详情页看到的"和"发布者以为用户看到的"不一致是
 * 最难发现的一类问题。
 *
 * 按该版本**不可变 tag** 取，因此显示的是"这个版本的说明"，不是"当前 main 的说明"。
 *
 * 取不到时返回 `null`（而不是抛错）：说明缺一块不该让整个详情页失败。只对
 * `source` 存在的插件有意义 —— 源码不公开的插件不提供 README。
 */
export async function loadReadme(
  plugin: MarketPlugin,
  version: MarketVersion
): Promise<string | null> {
  if (!plugin.source) return null;

  const key = `${plugin.id}@${version.version}`;
  const cached = readmeCache.get(key);
  if (cached !== undefined) return cached;

  for (const url of registrySources(version.tag, `${plugin.source}/README.md`, sourcePreference())) {
    try {
      const text = await invoke<string>('fetch_registry_text', { url });
      cacheSet(readmeCache, key, text);
      return text;
    } catch {
      // 换下一个来源。两个都失败说明该 tag 下确实没有 README，
      // 或者当前网络取不到 —— 两种情况在界面上都表现为"暂无说明"。
    }
  }

  return null;
}

// ============================================================
// 市场图标
// ============================================================

/**
 * 图标取回结果。
 *
 * 失败是一条**带原因**的结果，而不是 `null`：作者没写图标与图标取不到是两件不同的事，
 * 而两者在界面上都表现为"一个灰方块"。先前这里只有一个布尔量，那个灰方块于是成了唯一
 * 的线索 —— 无法判断该去查插件仓库还是查网络。
 */
export type MarketIconResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: string };

/**
 * 图标缓存（`icon` 路径 → 结果）。与 `readmeCache` 同理：只缓存成功，
 * 且同样受 `MAX_CACHED_ENTRIES` 约束（一个条目就是一份几十 KB 的 base64 文本）。
 */
const iconCache = new Map<string, Promise<MarketIconResult>>();

/** 这段文本是不是 SVG 标记 */
function isSvgMarkup(value: string): boolean {
  return value.trimStart().toLowerCase().startsWith('<svg');
}

/**
 * SVG 文本 → `data:` URL。
 *
 * 用 base64 而不是百分号编码：插件的 SVG 里出现 `#`、`&`、`"`、中文都是正常的，
 * 逐个转义容易漏掉一个，而 base64 的字符集是确定的。
 *
 * 先 UTF-8 编码成字节再逐字节交给 `btoa`：`btoa` 只接受码位小于 256 的字符，
 * 含中文的字符串直接传进去会抛 `InvalidCharacterError`。
 */
function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * 取回市场图标，转成 `data:` URL。
 *
 * **为什么不把 CDN 地址直接写进 `<img src>`。** 图标是市场里唯一取远程内容的地方，
 * 而它此前也是唯一绕过后端通道的那一个。后端通道（索引、签名、安装包、README 都走它）
 * 已经证明可用 —— 市场能列出插件，就说明它把索引取回来了 —— 而 WebView 自己的网络栈
 * 在本项目里没有任何覆盖，失败时只表现为一个灰方块，症状会被归因到插件系统。
 * 统一到同一条通道后，图标同时获得地址白名单（`ALLOWED_REGISTRY_HOSTS`）与
 * CDN → GitHub 的候选切换。
 *
 * **为什么交给 `<img>` 而不是 `dangerouslySetInnerHTML`。** 市场里的插件尚未安装，
 * 它的 SVG 仍是不可信输入，而 innerHTML 会执行 `<svg onload=...>`；作为图片加载时
 * 脚本与事件处理器都不会运行。已安装插件的图标之所以可以内联，是因为那份代码本来
 * 就能执行任意 JS，内联不增加任何能力。
 *
 * 与索引取同一个 `ref`（`main`）：索引里的 `icon` 是仓库内的**路径**，不是某个版本的
 * 产物 —— 一个插件一个图标是有意的，作者改了图标就该立刻生效。
 *
 * 只支持 SVG：后端返回文本，PNG 图标会在 UTF-8 解码处失败并落到通用图标。生成索引的
 * 脚本目前只收录 `.svg`（`modulith-plugins/scripts/build.ts`），所以这不是缺口。
 *
 * **永不 reject**：失败也以 `{ ok: false, reason }` 返回，调用方不必再包一层 try。
 */
export function loadMarketIcon(iconPath: string): Promise<MarketIconResult> {
  const cached = iconCache.get(iconPath);
  if (cached) return cached;

  const pending = fetchMarketIcon(iconPath).then((result) => {
    // 失败不缓存：一次网络抖动不该让这个图标在本次会话里永久变成灰方块
    if (!result.ok) iconCache.delete(iconPath);
    return result;
  });

  cacheSet(iconCache, iconPath, pending);
  return pending;
}

async function fetchMarketIcon(iconPath: string): Promise<MarketIconResult> {
  const failures: string[] = [];

  for (const url of registrySources(PLUGIN_INDEX_REF, iconPath, sourcePreference())) {
    try {
      const text = await invoke<string>('fetch_registry_text', { url });
      if (!isSvgMarkup(text)) {
        failures.push(`${describeSource(url)}：返回的内容不是 SVG`);
        continue;
      }
      return { ok: true, dataUrl: svgToDataUrl(text.trim()) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${describeSource(url)}：${reason}`);
    }
  }

  const reason = failures.join('；') || '没有可用的来源';
  console.warn(`[pluginMarket] 图标 "${iconPath}" 取不到，将使用通用图标：${reason}`);
  logMessage('warn', `市场图标 "${iconPath}" 取不到：${reason}`, 'pluginMarket');
  return { ok: false, reason };
}
