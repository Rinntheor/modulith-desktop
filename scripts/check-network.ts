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

// ============================================================
// 7. CSP：IPC 的源必须在 connect-src 里
// ============================================================

// 这一节守的是一个"改错了应用直接白屏"的配置。
//
// Tauri v2 的 IPC 在 WebView 里表现为一次对 `ipc:` / `http://ipc.localhost` 的
// 请求，而 **connect-src 一旦列了值就不再回退到 default-src**。漏掉它们，所有
// invoke 一起失败 —— 症状是应用启动即白屏，而那看起来像"应用坏了"，
// 不像"少写了一行配置"。
//
// 同时断言它**没有放开任意外部宿主**：配了 CSP 却把外面放开，等于既拿不到边界、
// 又以为自己有。这条白名单必须与 `netGuard.ts` 的判定口径一致 —— 外部地址在
// 两个层上都被挡，只是理由与可读性不同。
console.log('\nCSP：');

const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json')) as {
  app?: { security?: { csp?: unknown } };
};
const csp = tauriConfig.app?.security?.csp;

function cspDirective(name: string): string[] {
  if (!csp || typeof csp !== 'object') return [];
  const raw = (csp as Record<string, unknown>)[name];
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => String(entry).split(/\s+/).filter(Boolean));
  }
  return [];
}

const ALLOWED_CONNECT_SRC = [
  "'self'",
  'ipc:',
  'http://ipc.localhost',
  'http://localhost:*',
  'http://127.0.0.1:*',
  'ws://localhost:*',
  'ws://127.0.0.1:*',
];
const connectSrc = cspDirective('connect-src');
const joined = (list: string[]) => [...list].sort().join(' ');
check(
  joined(connectSrc) === joined(ALLOWED_CONNECT_SRC),
  joined(connectSrc) === joined(ALLOWED_CONNECT_SRC)
    ? `connect-src 恰好是白名单里的 ${ALLOWED_CONNECT_SRC.length} 项（含 IPC 的两个源，且没有放开任意外部宿主）`
    : `connect-src 与白名单不符。\n      实际：${connectSrc.join(' ')}\n      白名单：${ALLOWED_CONNECT_SRC.join(' ')}`
);

// ============================================================
// 8. 前端镜像：判定常量必须与 Rust 逐字相同
// ============================================================

// WebView 里的 `XMLHttpRequest.send()` 与 `new WebSocket()` 都是**同步**的，
// 等不了一次 IPC 往返，所以 `netGuard.ts` 必须持有一份判定规则的镜像。
//
// 这是全项目**唯一**允许存在的第二份规则。允许它的前提就是这个脚本能把它钉住：
// 逐个常量比对两侧的字面量，任何一处改动漏了对面都会在这里失败。
console.log('\n判定镜像：');

const policyRs = read('src-tauri/src/modules/net/policy.rs');
const netControlTs = read('src/services/netControl.ts');

function rustConst(name: string): string | null {
  const match = policyRs.match(new RegExp(`pub const ${name}: &str =[\\s\\S]*?"([^"]*)"`));
  return match ? match[1] : null;
}
function tsConst(name: string): string | null {
  const match = netControlTs.match(new RegExp(`export const ${name} = '([^']*)'`));
  return match ? match[1] : null;
}

for (const [rustName, tsName] of [
  ['MODE_ALLOW', 'NET_MODE_ALLOW'],
  ['MODE_ASK', 'NET_MODE_ASK'],
  ['MODE_DENY', 'NET_MODE_DENY'],
  ['DENY_OFFLINE', 'NET_DENY_OFFLINE'],
  ['DENY_POLICY', 'NET_DENY_POLICY'],
  ['DENY_PROMPT_REFUSED', 'NET_DENY_PROMPT_REFUSED'],
  ['DENY_PROMPT_TIMEOUT', 'NET_DENY_PROMPT_TIMEOUT'],
  ['DENY_DIRECT', 'NET_DENY_DIRECT'],
] as const) {
  const rust = rustConst(rustName);
  const ts = tsConst(tsName);
  check(
    rust !== null && rust === ts,
    rust !== null && rust === ts
      ? `${tsName} 与 Rust 的 ${rustName} 逐字相同`
      : `${tsName} 与 Rust 的 ${rustName} 不一致。Rust：${JSON.stringify(rust)}／前端：${JSON.stringify(ts)}`
  );
}

// ============================================================
// 「默认询问」的接线
// ============================================================
//
// 这一档的正确性**不取决于一个纯函数**，而取决于四处连接是否都在：策略说它可用、
// 门面在放行之前真的去问、询问模块能暂停与恢复、界面真的挂在看得见的地方。
// 少任何一处，用户看到的现象都是"我选了默认询问，但它要么不问、要么问了没人管"
// —— 而这正是 7.33 节记过的那类失败：判定被手写在调用点上，漏一处不会报错。
console.log('\n「默认询问」的接线：');

const promptRs = read('src-tauri/src/modules/net/prompt.rs');
const netModRs = read('src-tauri/src/modules/net/mod.rs');
const clientRs = read('src-tauri/src/modules/net/client.rs');
const netCommandsRs = read('src-tauri/src/modules/net/commands.rs');
const libRsForNet = read('src-tauri/src/lib.rs');

check(
  /id: MODE_ASK[\s\S]{0,240}?available: true/.test(policyRs),
  'ask 档宣称可用（反方向——宣称可用却没实现——由 Rust 侧的 every_advertised_mode_is_implemented 守）'
);
check(
  /Decision::AllowPendingPrompt[\s\S]{0,700}?prompt::ask\(/.test(clientRs),
  'client.execute 在 AllowPendingPrompt 分支里**真的去问**，而不是记一条"本应询问"就放行'
);
check(
  /prompt::has_session_grant\(&self\.app, &host\)/.test(clientRs),
  '本会话已放行过的主机不再重复询问（市场一次操作会连发五条请求）'
);
check(
  /PromptOutcome::Refused[\s\S]{0,400}?PromptOutcome::TimedOut/.test(clientRs),
  '拒绝与超时两条都折成拒绝 —— 没有哪一条会悄悄变成放行'
);
check(
  /PROMPT_TIMEOUT: Duration = Duration::from_secs\(\d+\)/.test(promptRs),
  '等待上限是一个具名常量（数字只有一份）'
);
check(
  /tokio::time::timeout\(PROMPT_TIMEOUT/.test(promptRs),
  '等待有超时兜底（没有兜底的"暂停住"会让请求永久挂着，比拒绝更糟）'
);
check(
  /let _gate = state\.gate\.lock\(\)\.await/.test(promptRs),
  '一次只弹一个：其余在队列里等（否则五条请求会盖成五个对话框）'
);
check(
  /has_grant\(host\)[\s\S]{0,160}?PromptOutcome::Allowed/.test(promptRs),
  '拿到队列许可之后要再查一次会话放行 —— 排队期间用户可能刚为同一个主机放过行'
);
check(
  /app\.manage\(prompt::PromptState::new\(\)\)/.test(netModRs),
  'net 模块在 setup 里托管了询问状态（命令与门面都靠它）'
);
for (const command of [
  'net_answer_prompt',
  'net_list_session_grants',
  'net_clear_session_grants',
]) {
  check(netCommandsRs.includes(`pub fn ${command}`), `net/commands.rs 定义了 ${command}`);
  check(libRsForNet.includes(command), `lib.rs 注册了 ${command}（否则前端 invoke 得到"命令不存在"）`);
}

const mainTsx = read('src/main.tsx');
check(mainTsx.includes('<NetPromptLayer />'), 'main.tsx 挂载了询问层');
check(
  mainTsx.indexOf('<NetPromptLayer />') < mainTsx.indexOf('<BootGate>'),
  '询问层在 BootGate **外面** —— 启动阶段与解锁界面的出站请求也要能被问到'
);

const promptLayerTsx = read('src/components/NetPromptLayer.tsx');
const overlayZ = /fixed inset-0 z-(\d+)/.exec(promptLayerTsx);
check(
  overlayZ !== null && Number(overlayZ[1]) > 70,
  `询问层的层级高于插件弹窗（z-70）与设置面板（z-60），实得 z-${overlayZ?.[1] ?? '无'}`
);
check(
  promptLayerTsx.includes('NET_PROMPT_CLOSED_EVENT'),
  '界面订阅了"询问已结束" —— 否则它会停在后端已经放弃的那条询问上'
);
check(
  /answerNetPrompt\(current\.id, allow, rememberHost\)/.test(promptLayerTsx),
  '界面把用户的选择（含是否记住主机）送回后端'
);
check(
  promptLayerTsx.includes('timeoutMs'),
  '倒计时用后端给的 timeoutMs，而不是前端再写一个数字（两处数字必然漂移）'
);

// 回环判定同样是两份（后端 `net/mod.rs` 的 `is_loopback_host`、前端
// `utils/networkSettings.ts` 的 `isLoopbackHost`）。这里用**同一张输入表**：
// Rust 侧在 `net/mod.rs` 的单元测试里，前端侧在这里。
console.log('\n回环判定的输入表：');
const LOOPBACK_TRUE = ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]'];
const LOOPBACK_FALSE = [
  'localhost.evil.tld',
  'notlocalhost',
  '128.0.0.1',
  'example.com',
  '0.0.0.0',
  '',
];
for (const host of LOOPBACK_TRUE) {
  check(isLoopbackHost(host), `前端把 ${JSON.stringify(host)} 判为回环（与 Rust 同一张表）`);
}
for (const host of LOOPBACK_FALSE) {
  check(!isLoopbackHost(host), `前端不把 ${JSON.stringify(host)} 判为回环`);
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
