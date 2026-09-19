// src/utils/networkSettings.ts
//
// 网络访问方式的纯逻辑：取值、校验，以及「前缀式代理」的拼接预览。
//
// 单独抽成 utils 文件是为了能被 `scripts/check-network.ts` 直接断言：
// `tsconfig.node.json` 只包含 `src/utils/*.ts` 这类自身依赖极少的纯模块，
// 放进组件或服务里就进不了脚本的检查范围（见该 tsconfig 里的说明）。
//
// ============================================================
// 与后端的对应关系（两边必须一致）
// ============================================================
//
// 真源在后端：
//
//   * `src-tauri/src/modules/settings/network.rs` —— 模式取值、长度上限、
//     GitHub 宿主表、**地址的拼接规则**（真正生效的是这一份）。
//   * `src-tauri/src/modules/settings/settings.rs` —— 字段名与默认值。
//
// 这个文件里的常量是**镜像**，用途只有两个：界面上的即时校验（不让一个必然被
// 后端拒绝的值提交上去）、以及把「地址会被拼成什么样」提前显示给用户看。
// `scripts/check-network.ts` 会直接读那两个 Rust 文件来核对镜像有没有漂移。
//
// **真正的改写永远由后端完成**（`network::rewrite_url`）。前端不参与构造请求地址，
// 因此这里即便猜错了预览，也不会影响实际行为 —— 但那会让界面撒谎，所以仍然要测。

/** 直连 GitHub（与后端 `NETWORK_MODE_DIRECT` 一致） */
export const NETWORK_MODE_DIRECT = 'direct';

/** 经由下载源（与后端 `NETWORK_MODE_PROXY` 一致） */
export const NETWORK_MODE_PROXY = 'proxy';

export type NetworkMode = typeof NETWORK_MODE_DIRECT | typeof NETWORK_MODE_PROXY;

/** 代理根地址的字符数上限（与后端 `MAX_GITHUB_PROXY_LEN` 一致） */
export const MAX_GITHUB_PROXY_LEN = 200;

/**
 * 走代理时会被改写的宿主（与后端 `GITHUB_HOSTS` 一致）
 *
 * 界面用它来判断「这个设置对某条地址有没有影响」，因此缺一项的后果是
 * 一条本会走代理的地址在界面上被说成「不受影响」。
 */
export const GITHUB_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'gist.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
];

/** 后缀匹配的 GitHub 资产域名（与后端一致） */
const GITHUB_SUFFIX = '.githubusercontent.com';

/**
 * 界面上每种网络方式的文案
 *
 * 放在这里而不是组件里，是为了让检查脚本能断言「每种模式都有文案」——
 * 新增一种模式却忘了给界面文案，会让设置项渲染成一个空白按钮。
 */
export const NETWORK_MODE_LABELS: Record<NetworkMode, { label: string; hint: string }> = {
  [NETWORK_MODE_DIRECT]: {
    label: '直连',
    hint: '直接访问 GitHub 与 CDN。GitHub 在当前网络下可用时选它',
  },
  [NETWORK_MODE_PROXY]: {
    label: '下载源',
    hint: '把 GitHub 地址接到你填的加速源后面再访问。国内网络通常需要',
  },
};

/**
 * 常见的公共加速源
 *
 * **只是输入建议，不是「官方支持列表」。** 这些都是第三方服务，可用性、速度与
 * 可信度由它们自己负责，随时可能失效或改变行为；插件包与更新包的内容完整性
 * 由哈希与签名保证，因此换一个加速源不会改变你装到的东西。
 *
 * 排序不代表推荐程度。
 */
export interface ProxyPreset {
  /** 界面上显示的短名 */
  label: string;
  /** 会直接填进输入框的地址 */
  base: string;
}

export const PROXY_PRESETS: readonly ProxyPreset[] = [
  { label: 'gh-proxy.org', base: 'https://gh-proxy.org' },
  { label: 'v4.gh-proxy.org', base: 'https://v4.gh-proxy.org' },
];

export function isNetworkMode(value: unknown): value is NetworkMode {
  return value === NETWORK_MODE_DIRECT || value === NETWORK_MODE_PROXY;
}

/** 把任意输入收敛成一个字符串（只做类型收敛，不做格式纠正） */
export function normalizeProxyBase(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 校验代理根地址；合法返回 `null`，否则返回一句可以直接显示的原因
 *
 * **中文原因，与后端不同。** 后端返回英文（那是它一贯的风格，且面向开发者），
 * 而这个函数的结果会直接出现在设置界面里 —— 在输入框下面显示一行英文报错
 * 是没必要的折磨。两条校验的规则必须一致，措辞不必。
 *
 * **空串是合法的**（表示还没填）。是否真的走代理由网络方式决定，
 * 「选了下载源却没填地址」由界面拦（那里能说清该做什么）。
 */
export function validateProxyBase(raw: string): string | null {
  if (raw === '') return null;

  if (raw.length > MAX_GITHUB_PROXY_LEN) {
    return `地址过长（上限 ${MAX_GITHUB_PROXY_LEN} 个字符）`;
  }

  // 先查空白：URL 解析器会自动去掉首尾空白，若先解析就会被它悄悄"修好"，
  // 而实际拼接时那个空格会留在字符串里（拼出两个地址）。
  if (/\s/.test(raw)) {
    return '地址中不能有空格或换行';
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '不是合法的地址，需要以 https:// 开头';
  }

  const loopback = isLoopbackHost(parsed.hostname);

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return '必须使用 https（只有本机地址可以用 http）';
  }

  if (!parsed.hostname) {
    return '地址缺少主机名';
  }

  if (parsed.search || parsed.hash) {
    return '地址不要带 ? 查询串或 # 片段';
  }

  if (parsed.username || parsed.password) {
    return '地址不要带用户名或密码';
  }

  return null;
}

/** 是否是本机回环地址（与后端 `is_loopback_host` 覆盖的范围一致） */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (bare === 'localhost' || bare === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * 当前设置是否**真的**会走下载源
 *
 * 两个条件缺一不可，与后端 `network::proxy_base` 完全一致。界面上有一处
 * 必须用同一判断的地方：候选地址的先后顺序（见 `pluginRegistry.ts`）。
 */
export function isProxyEffective(mode: NetworkMode, proxy: string): boolean {
  return mode === NETWORK_MODE_PROXY && normalizeProxyBase(proxy) !== '';
}

/** 是否是「走下载源时会被改写」的宿主（与后端 `is_github_host` 一致） */
export function isGithubHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (GITHUB_HOSTS.includes(normalized)) return true;
  return normalized.endsWith(GITHUB_SUFFIX);
}

/**
 * 把原始地址接到代理根后面（预览用）
 *
 * 与后端 `network::join_proxy` 规则相同：尾部的 `/` 可有可无、可以有多个。
 */
export function joinProxy(base: string, url: string): string {
  return `${base.replace(/\/+$/, '')}/${url}`;
}

/**
 * 用一条真实地址演示「这个下载源会把它变成什么」
 *
 * 演示用的是插件索引的 GitHub 直连地址 —— 它是这条链路里最典型的一个请求，
 * 且一定是 GitHub 宿主，不会因为配置差异而变成「不受影响」的例子。
 */
export function proxyPreview(base: string): string {
  return joinProxy(base, 'https://raw.githubusercontent.com/Rinntheor/modulith-plugins/main/index.json');
}

/** 预览用不到空地址时返回 `null`，让界面可以整段不渲染 */
export function proxyPreviewOrNull(base: string): string | null {
  const normalized = normalizeProxyBase(base);
  if (!normalized) return null;
  return proxyPreview(normalized);
}
