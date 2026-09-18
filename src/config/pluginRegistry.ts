// src/config/pluginRegistry.ts
// 插件仓库与索引的位置
//
// 这是**分发契约**：改了它，已发布的应用就会去别的地方找插件。因此集中放在一处，
// 而不是散落在市场页或服务里。
//
// 索引格式的定义在 docs/08-规划/插件生态设计.md 第 4 节（应用仓库），生产方是
// 插件仓库的 scripts/build.ts。这里只负责"去哪里取"。

/** 插件仓库：源码、.lcp 与索引都在这里 */
export const PLUGIN_REPO = 'Rinntheor/modulith-plugins';

/** 索引在仓库内的路径 */
export const PLUGIN_INDEX_PATH = 'index.json';

/**
 * 索引签名的路径。
 *
 * 与索引放在同一个仓库、同一个目录，因此两者一定来自同一次提交 —— 签名给的是索引的
 * 字节，分开存放迟早会出现"索引换了、签名没换"的错配。
 *
 * 由 `tauri signer sign index.json` 生成（写在同名 `.sig` 文件里）。
 */
export const PLUGIN_INDEX_SIGNATURE_PATH = `${PLUGIN_INDEX_PATH}.sig`;

/** 仓库主页，用于「源码可见」与「报告问题」入口 */
export const PLUGIN_REPO_URL = `https://github.com/${PLUGIN_REPO}`;

/** 索引与包所用的分支引用。索引是可变的，因此取 `main`。 */
export const PLUGIN_INDEX_REF = 'main';

/** jsDelivr 的仓库代理地址。`ref` 可以是分支名，也可以是不可变 tag。 */
export function jsdelivrUrl(ref: string, path: string): string {
  return `https://cdn.jsdelivr.net/gh/${PLUGIN_REPO}@${ref}/${path}`;
}

/** GitHub 原始文件地址，作为 CDN 不可用时的兜底 */
export function rawGithubUrl(ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${PLUGIN_REPO}/${ref}/${path}`;
}

/**
 * 仓库内某个文件（在给定 ref 下）的候选地址。
 *
 * 同时服务于两类内容：
 *
 * - **`.lcp` 包**：`ref` 取版本的不可变 tag，因此内容永不变，CDN 永久缓存是最优解。
 * - **`README.md`**：`ref` 同样取不可变 tag —— 详情页显示"这个版本的说明"，而不是
 *   "当前 main 的说明"。版本号标识一份确定的内容，说明也应当如此。
 *
 * 两条路都保留：CDN 优先，直连兜底。切换来源不会拿到不同内容 —— 包由索引里的 sha256
 * 保证（见 pluginMarket.ts），README 则由不可变 tag 保证。
 */
export function registrySources(ref: string, path: string): string[] {
  return [jsdelivrUrl(ref, path), rawGithubUrl(ref, path)];
}

/**
 * 索引与它的签名，成对返回的候选地址。
 *
 * 为什么成对返回而不是让调用方自己拼 `.sig`：jsDelivr 那条带查询串，直接往后接 `.sig`
 * 会得到 `index.json?t=123.sig` —— 一个既不是索引也不是签名的地址，而它失败的方式是
 * 404，看起来像"索引不存在"。把两件事绑在一起，这类拼接就不可能写错。
 *
 * 三个细节是刻意的：
 *
 * 1. **jsDelivr 那条带 `?t=` 查询串。** jsDelivr 对分支引用的缓存是若干小时，而索引
 *    必须"发布后立刻可见"（新插件、新版本都靠它被发现）。查询串让每次请求构成不同的
 *    缓存键，从而绕过缓存 —— 索引只有几 KB，不需要 CDN 的缓存收益。
 * 2. **保留 GitHub 直连作为兜底。** CDN 可能被墙或临时故障，宁可慢也不要完全不可用。
 * 3. **签名与索引走同一个来源。** 一条源的索引配另一条源的签名没有意义：签名是给那份
 *    具体的字节签的，混搭只会得到一个必然失败的组合。
 *
 * 索引是唯一**可变**的取用对象（它取 `main`），因此只有它需要绕缓存；包与 README 都按
 * 不可变 tag 取，走 registrySources 即可。
 */
export interface PluginIndexSource {
  /** 索引地址 */
  index: string;
  /** 对应签名的地址。签名是给索引的**字节**签的，因此必须与它同源 */
  signature: string;
}

export function pluginIndexSources(now: number = Date.now()): PluginIndexSource[] {
  return [
    {
      index: `${jsdelivrUrl(PLUGIN_INDEX_REF, PLUGIN_INDEX_PATH)}?t=${now}`,
      signature: `${jsdelivrUrl(PLUGIN_INDEX_REF, PLUGIN_INDEX_SIGNATURE_PATH)}?t=${now}`,
    },
    {
      index: rawGithubUrl(PLUGIN_INDEX_REF, PLUGIN_INDEX_PATH),
      signature: rawGithubUrl(PLUGIN_INDEX_REF, PLUGIN_INDEX_SIGNATURE_PATH),
    },
  ];
}
