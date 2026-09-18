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

import { pluginIndexSources, registrySources } from '../config/pluginRegistry';
import { getInstalledPlugins } from './pluginRuntime';

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
 * 依次尝试候选地址取回索引。
 *
 * 不做 JS 侧的额外超时：后端 reqwest 客户端已经配了 30 秒超时，前端再加一层只会产生
 * 两处不一致的超时，且先到期的那个会让另一个 promise 悬空。
 */
async function fetchIndex(): Promise<MarketIndex> {
  const failures: string[] = [];

  for (const url of pluginIndexSources()) {
    try {
      const text = await invoke<string>('fetch_registry_text', { url });
      return parseIndex(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${describeSource(url)}：${reason}`);
    }
  }

  fail(`无法获取插件索引。\n${failures.join('\n')}`);
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

/** 本机已安装的版本号；未安装返回 `null`。 */
export function installedVersionOf(pluginId: string): string | null {
  return getInstalledPlugins().find((p) => p.id === pluginId)?.version ?? null;
}

/** 取某个插件在索引里的最新版本条目 */
export function latestVersionOf(plugin: MarketPlugin): MarketVersion {
  const found = plugin.versions.find((v) => v.version === plugin.latest);
  if (!found) fail(`索引里 ${plugin.id} 的 latest（${plugin.latest}）没有对应条目`);
  return found;
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

  for (const url of registrySources(version.tag, version.package.path)) {
    try {
      await invoke('install_plugin_url_verified', { url, sha256: version.package.sha256 });
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${describeSource(url)}：${reason}`);
    }
  }

  fail(`安装 ${plugin.displayName} ${version.version} 失败。\n${failures.join('\n')}`);
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

  for (const url of registrySources(version.tag, `${plugin.source}/README.md`)) {
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
