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
  engines: { loopcore: string };
  permissions: string[];
  package: MarketPackage;
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

  const engines = item.engines;
  if (!engines || typeof engines !== 'object') fail(`${where}.engines 缺失`);

  return {
    version: asString(item.version, `${where}.version`),
    tag: asString(item.tag, `${where}.tag`),
    engines: {
      loopcore: asString((engines as Record<string, unknown>).loopcore, `${where}.engines.loopcore`),
    },
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
    needsConfirmation: downgrade || added.some((p) => getPermissionDescriptor(p).risk !== 'low'),
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
      readmeCache.set(key, text);
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

/** 图标缓存（`icon` 路径 → 结果）。与 `readmeCache` 同理，只缓存成功。 */
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

  iconCache.set(iconPath, pending);
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
