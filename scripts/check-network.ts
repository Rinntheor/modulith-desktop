// scripts/check-network.ts
// 网络设置（直连 / 下载源）的验证脚本
//
//   node scripts/check-network.ts
//
// 这个脚本查两类东西，缺一不可：
//
// 1. **前后端镜像是否漂移。** 网络方式的取值、代理地址的长度上限、GitHub 宿主表
//    在两处各有一份（后端是权威，前端是镜像）。漂移的后果很隐蔽：界面说这条地址
//    「不受下载源影响」，而后端其实会改写它 —— 用户看到的解释与实际行为不一致。
//    因此这里直接读 Rust 源文件做文本核对。
// 2. **校验与拼接的行为。** 界面上的即时校验必须与后端一致，否则会出现
//    「界面放行、后端拒绝」这种最让人困惑的保存失败。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GITHUB_HOSTS,
  MAX_GITHUB_PROXY_LEN,
  NETWORK_MODE_DIRECT,
  NETWORK_MODE_LABELS,
  NETWORK_MODE_PROXY,
  PROXY_PRESETS,
  isGithubHost,
  isLoopbackHost,
  isNetworkMode,
  isProxyEffective,
  joinProxy,
  normalizeProxyBase,
  proxyPreviewOrNull,
  validateProxyBase,
} from '../src/utils/networkSettings.ts';
import {
  jsdelivrUrl,
  pluginIndexSources,
  rawGithubUrl,
  registrySources,
} from '../src/config/pluginRegistry.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function read(relative: string): string {
  return readFileSync(join(PROJECT_ROOT, relative), 'utf-8');
}

// ============================================================
// 1. 与后端的镜像核对
// ============================================================

console.log('与后端 network.rs 的镜像：');

const rustNetwork = read('src-tauri/src/modules/settings/network.rs');
const rustSettings = read('src-tauri/src/modules/settings/settings.rs');
const frontendSettings = read('src/services/appSettings.ts');

function rustStringConst(source: string, name: string): string | null {
  const match = new RegExp(`pub const ${name}: &str = "([^"]+)"`).exec(source);
  return match ? match[1] : null;
}

function rustNumberConst(source: string, name: string): number | null {
  const match = new RegExp(`pub const ${name}: (?:usize|u32|u64) = ([0-9_]+)`).exec(source);
  return match ? Number(match[1].replace(/_/g, '')) : null;
}

check(
  rustStringConst(rustNetwork, 'NETWORK_MODE_DIRECT') === NETWORK_MODE_DIRECT,
  `直连模式取值一致（${NETWORK_MODE_DIRECT}）`
);
check(
  rustStringConst(rustNetwork, 'NETWORK_MODE_PROXY') === NETWORK_MODE_PROXY,
  `代理模式取值一致（${NETWORK_MODE_PROXY}）`
);
check(
  rustNumberConst(rustNetwork, 'MAX_GITHUB_PROXY_LEN') === MAX_GITHUB_PROXY_LEN,
  `代理地址长度上限一致（${MAX_GITHUB_PROXY_LEN}）`
);

const hostsBlock = /const GITHUB_HOSTS: \[&str; (\d+)\] = \[([\s\S]*?)\];/.exec(rustNetwork);
check(hostsBlock !== null, '能在 network.rs 里找到 GITHUB_HOSTS 表');

if (hostsBlock) {
  const declared = Number(hostsBlock[1]);
  const rustHosts = [...hostsBlock[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  check(declared === rustHosts.length, `GITHUB_HOSTS 声明的长度与实际条目一致（${declared}）`);
  check(
    rustHosts.length === GITHUB_HOSTS.length,
    `前后端宿主表条目数一致（Rust ${rustHosts.length} / 前端 ${GITHUB_HOSTS.length}）`
  );

  for (const host of rustHosts) {
    check(isGithubHost(host), `Rust 里的 ${host} 在前端也判定为 GitHub 宿主`);
  }
  for (const host of GITHUB_HOSTS) {
    check(rustHosts.includes(host), `前端的 ${host} 也在 Rust 宿主表里`);
  }
}

check(
  rustNetwork.includes('ends_with(".githubusercontent.com")'),
  'Rust 用后缀匹配 githubusercontent.com 子域'
);
check(
  !isGithubHost('githubusercontent.com.evil.tld') && isGithubHost('new.githubusercontent.com'),
  '前端后缀匹配不会误伤 githubusercontent.com.evil.tld'
);

// 设置字段：JSON 键名（camelCase）与默认值必须两边一致
const settingFields: Array<[string, string]> = [
  ['network_mode', 'networkMode'],
  ['github_proxy', 'githubProxy'],
  ['file_logging_enabled', 'fileLoggingEnabled'],
  ['crash_logging_enabled', 'crashLoggingEnabled'],
];

for (const [rustField, camel] of settingFields) {
  check(
    new RegExp(`pub ${rustField}:`).test(rustSettings),
    `settings.rs 里有 ${rustField} 字段`
  );
  check(
    new RegExp(`\\b${camel}\\??:`).test(frontendSettings),
    `appSettings.ts 的接口里有 ${camel}`
  );
  check(
    new RegExp(`\\b${camel}:`).test(frontendSettings),
    `appSettings.ts 的 DEFAULT_APP_SETTINGS / normalize 覆盖了 ${camel}`
  );
  check(
    new RegExp(`\\b${camel}:`).test(rustSettings) === false ||
      new RegExp(`fn default_${rustField}`).test(rustSettings),
    `settings.rs 为 ${rustField} 提供了默认值函数`
  );
}

check(/networkMode: 'direct'/.test(frontendSettings), '前端默认直连');
check(/githubProxy: ''/.test(frontendSettings), '前端默认代理地址为空');
check(/fileLoggingEnabled: true/.test(frontendSettings), '前端默认开启实时记录');
check(/crashLoggingEnabled: true/.test(frontendSettings), '前端默认开启崩溃记录');

// ============================================================
// 2. 代理地址的校验
// ============================================================

console.log('\n应当接受：');
for (const ok of [
  '',
  'https://gh-proxy.org',
  'https://gh-proxy.org/',
  'https://v4.gh-proxy.org/',
  'https://my.mirror.example.com/gh',
  'http://127.0.0.1:8080',
  'http://localhost:1420/',
]) {
  check(validateProxyBase(ok) === null, `接受 ${ok === '' ? '(空)' : ok}`);
}

check(
  validateProxyBase(`https://${'a'.repeat(MAX_GITHUB_PROXY_LEN - 8)}`) === null,
  `长度正好等于上限（${MAX_GITHUB_PROXY_LEN}）时接受`
);

console.log('\n应当拒绝：');
const rejected: Array<[string, string]> = [
  ['gh-proxy.org', '缺少 https://'],
  ['https://', '缺少主机名'],
  ['ftp://gh-proxy.org', '非 http(s) 协议'],
  ['http://gh-proxy.org', '非回环地址用明文 http'],
  ['https://gh-proxy.org/ ', '尾部空格'],
  ['https://gh-pro xy.org', '中间有空格'],
  ['https://gh-proxy.org/?a=1', '带查询串'],
  ['https://gh-proxy.org/#x', '带片段'],
  ['https://user:pw@gh-proxy.org', '带用户名密码'],
  [`https://${'a'.repeat(MAX_GITHUB_PROXY_LEN)}`, '超过长度上限'],
];
for (const [value, why] of rejected) {
  const reason = validateProxyBase(value);
  check(reason !== null, `拒绝 ${why}`);
  check(
    typeof reason === 'string' && reason.length > 0,
    `拒绝 ${why} 时给出可显示的原因`
  );
}

console.log('\n边界与坏数据：');
check(isNetworkMode('direct') && isNetworkMode('proxy'), '两种合法模式都被接受');
check(!isNetworkMode('Proxy') && !isNetworkMode('') && !isNetworkMode('off'), '非法模式被拒绝');
check(!isNetworkMode(null) && !isNetworkMode(undefined), 'null / undefined 不是合法模式');
check(normalizeProxyBase('  https://a.b  ') === 'https://a.b', 'normalize 去掉首尾空白');
check(normalizeProxyBase(undefined) === '', 'normalize 把非字符串收敛成空串');
check(isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost'), '回环地址判定');
check(isLoopbackHost('[::1]') && isLoopbackHost('127.0.0.5'), 'IPv6 / 127.0.0.0-8 都算回环');
check(!isLoopbackHost('example.com'), '普通域名不是回环');

// ============================================================
// 3. 拼接规则（只用于界面预览，真源在后端）
// ============================================================

console.log('\n地址拼接：');
const sample = 'https://github.com/o/r/releases/download/v1/a.exe';
check(
  joinProxy('https://gh-proxy.org', sample) === `https://gh-proxy.org/${sample}`,
  '无尾斜杠时补一个 /'
);
check(
  joinProxy('https://gh-proxy.org/', sample) === `https://gh-proxy.org/${sample}`,
  '有尾斜杠时不重复'
);
check(
  joinProxy('https://my.host/gh//', sample) === `https://my.host/gh/${sample}`,
  '多个尾斜杠只保留分隔用的那一个'
);
check(proxyPreviewOrNull('') === null, '空地址时不产生预览');
check(
  proxyPreviewOrNull(' https://gh-proxy.org/ ')?.startsWith('https://gh-proxy.org/https://raw.githubusercontent.com/') ===
    true,
  '预览把索引的 GitHub 地址接在代理根后面'
);

// ============================================================
// 4. 「选了下载源就优先走它」这条顺序约定
// ============================================================

console.log('\n候选地址顺序：');

check(
  isProxyEffective(NETWORK_MODE_DIRECT, 'https://gh-proxy.org') === false,
  '直连模式下即使填了地址也不算「走下载源」'
);
check(
  isProxyEffective(NETWORK_MODE_PROXY, '') === false,
  '选了下载源但地址为空时不算「走下载源」'
);
check(
  isProxyEffective(NETWORK_MODE_PROXY, '  ') === false,
  '只有空白也等于没填'
);
check(
  isProxyEffective(NETWORK_MODE_PROXY, 'https://gh-proxy.org') === true,
  '选了下载源且填了地址才算生效'
);

const cdnUrl = jsdelivrUrl('main', 'index.json');
const githubUrl = rawGithubUrl('main', 'index.json');

const cdnFirst = registrySources('main', 'index.json');
check(cdnFirst[0] === cdnUrl && cdnFirst[1] === githubUrl, '默认顺序是 CDN 先、GitHub 后');
check(
  registrySources('main', 'index.json', 'github-first')[0] === githubUrl,
  'github-first 时 GitHub 那条排在最前'
);
check(
  registrySources('main', 'index.json', 'github-first').length === 2,
  '重排不会丢掉任何候选'
);

const indexCdnFirst = pluginIndexSources(1);
const indexGithubFirst = pluginIndexSources(1, 'github-first');
check(
  indexCdnFirst[0].index.startsWith('https://cdn.jsdelivr.net/') &&
    indexCdnFirst[1].index.startsWith('https://raw.githubusercontent.com/'),
  '索引候选默认 CDN 先'
);
check(
  indexGithubFirst[0].index.startsWith('https://raw.githubusercontent.com/') &&
    indexGithubFirst[1].index.startsWith('https://cdn.jsdelivr.net/'),
  '选了下载源时索引候选改成 GitHub 先'
);
check(
  indexGithubFirst[0].index.endsWith('index.json') &&
    indexGithubFirst[0].signature.endsWith('index.json.sig'),
  '重排之后索引与签名仍然成对'
);

// ============================================================
// 5. 界面文案与预设
// ============================================================

console.log('\n界面文案与预设：');
for (const mode of [NETWORK_MODE_DIRECT, NETWORK_MODE_PROXY] as const) {
  const copy = NETWORK_MODE_LABELS[mode];
  check(
    Boolean(copy) && copy.label.length > 0 && copy.hint.length > 0,
    `${mode} 有人能看懂的文案`
  );
}

check(PROXY_PRESETS.length > 0, '至少提供一个内置加速源预设');
for (const preset of PROXY_PRESETS) {
  check(validateProxyBase(preset.base) === null, `预设 ${preset.label} 本身就是合法地址`);
  check(preset.label.length > 0, `预设 ${preset.base} 有显示名`);
}

// ============================================================
// 6. 出站收口：所有请求必须经过 net::client
// ============================================================

// 这一节守的是一个**真实发生过的 bug**，而不是一个假想的风险：
//
// 上一版把"出站策略判定 + 流量日志"手写在 `manager.rs` 的 `plugin_http_request`
// 里。结果是同一个文件的 `fetch_once`（插件市场拉索引 / 说明 / 插件包）漏掉了它 ——
// 用户把设置改成「禁止出站」、打开离线模式，刷新后市场照样加载。
//
// 原因不是谁忘了写，而是**那种写法要求每个新调用点都记得写**。现在判定被收进
// `net::client::NetClient`，裸 `reqwest::Client` 只由它持有、且不对外提供。
//
// 于是纪律可以变成一条静态断言：
//   * `reqwest::Client` 这个类型只能出现在 `net/client.rs` 里；
//   * `.send()`（真正的发送动作）同理。
// 任何试图绕过门面的新代码，都会先撞上这里。
console.log('\n出站收口：');

function walkRust(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkRust(full, out);
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

/** 去掉 Rust 注释：注释里提到某个类型名是正常的，不该算违规 */
function stripRustComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const NET_CLIENT = 'src-tauri/src/modules/net/client.rs';
const rustSources = walkRust(join(PROJECT_ROOT, 'src-tauri/src')).map((file) => ({
  path: relative(PROJECT_ROOT, file).replace(/\\/g, '/'),
  source: stripRustComments(readFileSync(file, 'utf-8')),
}));

// 规则 1：裸客户端**只能被门面持有**。
//
// 断言是"恰好一处且就是门面"，而不是"其它地方没有"：后者在有人换成别的 HTTP 库
// （于是门面自己也不再出现这个类型）时会安静通过，检查就空转了。
const clientHolders = rustSources
  .filter((file) => /reqwest::Client\b/.test(file.source))
  .map((file) => file.path);
check(
  clientHolders.length === 1 && clientHolders[0] === NET_CLIENT,
  clientHolders.length === 1 && clientHolders[0] === NET_CLIENT
    ? '裸 reqwest::Client 只被出站门面持有（持有它的文件可以绕开策略与日志）'
    : `裸 reqwest::Client 的持有者应当恰好是 ${NET_CLIENT}，实际：${clientHolders.join('、') || '（无）'}`
);

// 规则 2：`.send()` 在任何地方都不该出现 —— 门面用的是 `Client::execute`。
// 因此它一旦出现，就意味着有人自己建了一个客户端，或者绕过了门面。
const senders = rustSources.filter((file) => /\.send\(\)/.test(file.source)).map((file) => file.path);
check(
  senders.length === 0,
  senders.length === 0
    ? '没有任何地方直接调用 .send()（发送动作只发生在门面里）'
    : `.send() 出现在了：${senders.join('、')} —— 这是真正把请求发出去的动作，绕过门面就意味着绕过策略与日志`
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
