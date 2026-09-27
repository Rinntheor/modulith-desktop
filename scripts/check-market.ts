// scripts/check-market.ts
//
// 插件市场**索引解析**与**安装策略**的夹具。
//
//   node --import ./scripts/harness/loader.mjs scripts/check-market.ts
//
// ============================================================
// 它为什么存在：一次真实的、全量打不开的市场
// ============================================================
//
// 用户报的是"插件市场报错，两道来源（cdn.jsdelivr.net 与 raw.githubusercontent.com）
// 给出同一句话：`plugins[0].versions[0].engines.modulith 必须是非空字符串`"。
//
// 根因不是网络，是**一个只用于展示的字段拖垮了整份索引**：
//
//   * 插件仓库在**项目改名**时换掉了 `engines` 的键名（旧名字见
//     `docs/06-项目/已知问题与技术债.md` §7.51 —— **本文件里不写它**，
//     `check:contributions` 第 5 节在扫那个旧名字，而它扫得对：
//     一个能出现在源码里的旧键名迟早会被谁复制回去当成读取路径）；
//   * 那次改名与重新生成的索引都在本地提交里，**而索引没推上去**；
//   * 已发布的应用拿到的是旧索引，`engines` 里没有 `modulith`；
//   * `parseVersion` 用 `asString` 读 `engines.modulith`，缺失即抛错；
//   * 而 `parseIndex` 的既定策略是"结构错误一律整体失败，不做跳过坏条目" ——
//     于是整份索引判为非法，**市场对所有人打不开**。
//
// 值得写下来的不是那个字段名，而是那条线划错了地方：`engines.modulith` 在
// 已安装那一侧明确写着"只提示、不阻断"（`pluginRuntime.ts` 的 `engineAdvisory`），
// 却在市场这一侧有否决权。**同一个字段在两处有相反的力量**，而它本身只是详情页
// 上的一行字。
//
// ============================================================
// 这一节守的两条线
// ============================================================
//
// 1. **宿主据此行事的字段必须严格。** `id` / `version` / `tag` /
//    `package.sha256` / `permissions` 坏了就该整份拒绝 —— 宿主真的会用它们
//    （装什么、校验哪个哈希、显示什么风险）。
// 2. **只用于展示的字段不许拖垮整份索引。** `engines` / `kinds` / `background`
//    缺了就如实说"未声明"。
//
// 安装策略那一半同理：`runtime` 读不出来时**不能就地拒绝**，因为索引只是一份
// 预测，权威判据是包内清单，而那个只有后端读得到。见 `installGate` 的长说明。
//
// ============================================================
// 为什么是"真的跑一遍"
// ============================================================
//
// 这两件事都是**纯逻辑**（`parseIndex` / `installGate` 不碰 IO），因此用真身跑
// 一组构造出来的索引，比对着源码做文本匹配可靠得多：文本匹配锁住的是"那句话还
// 在不在"，而这里要锁的是"这个输入还抛不抛错"。上面那个缺陷若用文本断言去守，
// 它会是一条关于 `asString` 出现了几次的断言 —— 而它真正要守的是一次真实输入。

import { installDomShim } from './harness/dom-shim.ts';
import {
  installGate,
  marketVersionIsolation,
  parseIndex,
  type MarketIndex,
  type MarketVersion,
} from '../src/services/pluginMarket.ts';

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

function section(title: string): void {
  console.log(`\n${title}：`);
}

// ============================================================
// 桩后端：只需要设置那三条命令
// ============================================================
//
// `installGate` 读的是设置缓存，而缓存来自 `get_app_settings`。给一个只有三条
// 命令的桩，其余一律抛错 —— 桩比真实宿主宽松是比没有桩更糟的事。

const shim = installDomShim();
const internals = (shim.window as Record<string, any>)['__TAURI_INTERNALS__'];

let storedSettings: Record<string, unknown> = {};

internals.invoke = async (command: string, args: Record<string, any> = {}) => {
  switch (command) {
    case 'get_app_settings':
      return { ...storedSettings };
    case 'reload_app_settings':
      return { ...storedSettings };
    case 'update_app_settings':
      storedSettings = { ...(args.settings ?? {}) };
      return { ...storedSettings };
    default:
      throw new Error(`[check-market] 未打桩的后端命令：${command}`);
  }
};

const { loadAppSettings } = await import('../src/services/appSettings.ts');

/** 把"用户有没有允许安装未隔离插件"设成给定值，并等缓存更新 */
async function setAllowUnsandboxed(value: boolean): Promise<void> {
  storedSettings = { allowUnsandboxedPlugins: value };
  await loadAppSettings();
}

// ============================================================
// 构造索引
// ============================================================

const SHA = 'a'.repeat(64);

/** 一个版本的原始 JSON。默认形状是"今天真实索引里的样子" */
function versionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    tag: 'demo-v1.0.0',
    engines: { modulith: '>=1.6.0' },
    runtime: 'sandboxed',
    permissions: [],
    package: { path: 'dist/demo-1.0.0.lcp', size: 1024, sha256: SHA },
    ...overrides,
  };
}

function indexJson(version: Record<string, unknown> = versionJson()): string {
  return JSON.stringify({
    schemaVersion: 1,
    plugins: [
      {
        id: 'com.modulith.demo',
        displayName: '演示',
        summary: '一句话',
        author: { name: '作者' },
        license: 'MIT',
        latest: '1.0.0',
        versions: [version],
      },
    ],
  });
}

function parseOnce(text: string): { ok: true; index: MarketIndex } | { ok: false; error: string } {
  try {
    return { ok: true, index: parseIndex(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function versionOf(index: MarketIndex): MarketVersion {
  return index.plugins[0].versions[0];
}

// ============================================================
// 1. 那次真实故障的形状
// ============================================================

section('旧索引（engines 里是改名之前的那个键）');

{
  /*
    **这就是发布出去的那份索引的形状**：`engines` 是个合法对象，但里面没有
    `modulith`。键名这里刻意用一个占位（真实的旧名字见 §7.51），因为这一节要
    复现的是**形状**而不是那个字符串 —— 而一个能出现在源码里的旧键名迟早会被谁
    复制回产品代码里当成读取路径，`check:contributions` 第 5 节扫它是对的。
  */
  const result = parseOnce(indexJson(versionJson({ engines: { host: '>=1.0.0' } })));

  check(result.ok, '旧键名（没有 modulith）的索引仍然能解析（整体失败会让市场对所有人打不开）');
  check(
    result.ok && versionOf(result.index).engines.modulith === null,
    '旧键名不被当成 `modulith`（那是替发布者说一句他没说过的话）'
  );
  check(
    result.ok && result.index.plugins.length === 1,
    '**连带的那个后果**：这个插件仍然出现在列表里，而不是随整份索引一起消失'
  );
}

section('引擎字段的其它缺失形态');

{
  const noEngines = parseOnce(indexJson(versionJson({ engines: undefined })));
  check(noEngines.ok, '`engines` 整个缺失时不失败');
  check(noEngines.ok && versionOf(noEngines.index).engines.modulith === null, '读出来是"未声明"');

  const emptyString = parseOnce(indexJson(versionJson({ engines: { modulith: '' } })));
  check(emptyString.ok, '`engines.modulith` 是空字符串时不失败');
  check(
    emptyString.ok && versionOf(emptyString.index).engines.modulith === null,
    '空字符串同样算"未声明"（而不是一个空的范围）'
  );

  const present = parseOnce(indexJson());
  check(
    present.ok && versionOf(present.index).engines.modulith === '>=1.6.0',
    '写了一项时就如实读出来（放宽不等于忽略）'
  );
}

// ============================================================
// 2. 该严格的仍然严格
// ============================================================
//
// 这一节是上一条的**对照**：放宽只针对展示字段。少了它，"宽容"会被下一次改动
// 当成"随便放宽一点也无妨"的许可。

section('宿主据此行事的字段仍然会让整份索引失败');

{
  const cases: Array<[string, string]> = [
    ['sha256 缺失', indexJson(versionJson({ package: { path: 'p', size: 1 } }))],
    [
      'sha256 不是 64 位十六进制',
      indexJson(versionJson({ package: { path: 'p', size: 1, sha256: 'zz' } })),
    ],
    ['permissions 不是数组', indexJson(versionJson({ permissions: 'storage' }))],
    ['version 为空', indexJson(versionJson({ version: '' }))],
    ['tag 缺失', indexJson(versionJson({ tag: undefined }))],
  ];

  for (const [label, text] of cases) {
    check(!parseOnce(text).ok, `${label} → 整份索引失败`);
  }

  // `latest` 指向一个不存在的版本：市场据此算"要不要更新"，
  // 而算不出来时的表现会是"每次打开都显示可更新"。
  const badLatest = JSON.stringify({
    schemaVersion: 1,
    plugins: [
      {
        id: 'com.modulith.demo',
        displayName: '演示',
        summary: '',
        author: { name: '' },
        license: '',
        latest: '9.9.9',
        versions: [versionJson()],
      },
    ],
  });
  check(!parseOnce(badLatest).ok, '`latest` 在 versions 里不存在 → 整份索引失败');

  // 格式版本比自己新：硬解析会得到一堆看不懂的字段，而正确动作是让用户更新应用。
  const future = JSON.stringify({ schemaVersion: 99, plugins: [] });
  check(!parseOnce(future).ok, '索引的 schemaVersion 高于宿主支持的 → 失败并提示更新应用');
}

// ============================================================
// 3. runtime：三档，且"不知道"是其中一档
// ============================================================

section('版本级 runtime');

{
  const cases: Array<[unknown, string | undefined]> = [
    ['sandboxed', 'sandboxed'],
    ['in-process', 'in-process'],
    [undefined, undefined],
    ['Sandboxed', undefined], // 大小写不对 → 不知道，而不是猜
    ['isolated', undefined], // 将来可能出现的第三档 → 同样不猜
  ];

  for (const [raw, expected] of cases) {
    const result = parseOnce(indexJson(versionJson({ runtime: raw })));
    check(
      result.ok && versionOf(result.index).runtime === expected,
      `runtime=${JSON.stringify(raw)} → ${String(expected)}`
    );
  }

  // 取值非法时**不失败**：索引是打包时派生的一份缓存，它可能比清单旧。
  // 这一条的对照是清单那一侧 —— 那里的未知取值必须让整份清单不合法。
  const bogus = parseOnce(indexJson(versionJson({ runtime: 42 })));
  check(bogus.ok, 'runtime 是非字符串时不失败（索引只是预测，权威判据是包内清单）');
}

section('隔离状态的三档说法必须互不相同');

{
  const labels = (['sandboxed', 'in-process', undefined] as const).map((runtime) =>
    marketVersionIsolation({ runtime } as MarketVersion).label
  );
  check(new Set(labels).size === 3, `三档各有各的说法（实际：${labels.join(' / ')}）`);
}

// ============================================================
// 4. 安装策略
// ============================================================

section('安装策略：能确定的就地判，不能确定的留给后端');

await setAllowUnsandboxed(false);

{
  const sandboxed = { runtime: 'sandboxed' } as MarketVersion;
  const gate = installGate(sandboxed);
  check(gate.allowed && !gate.deferred, '已隔离 → 放行（不受那个开关影响）');

  const inProcess = { runtime: 'in-process' } as MarketVersion;
  const blocked = installGate(inProcess);
  check(!blocked.allowed, '明确未隔离 + 设置关闭 → 不放行');
  check(
    blocked.reason.includes('允许') || blocked.reason.includes('设置'),
    '拒绝的原因给出了下一步（去设置里打开那道开关），而不是一句"拒绝安装"'
  );

  const unknown = { runtime: undefined } as MarketVersion;
  const deferred = installGate(unknown);
  check(
    deferred.allowed && deferred.deferred,
    '隔离状态未知 → 放行**并标记为暂定**（索引只是预测，后端读得到包内清单）'
  );
}

await setAllowUnsandboxed(true);

{
  const inProcess = { runtime: 'in-process' } as MarketVersion;
  const gate = installGate(inProcess);
  check(gate.allowed && !gate.deferred, '用户显式允许之后，未隔离插件放行');

  const sandboxed = { runtime: 'sandboxed' } as MarketVersion;
  check(installGate(sandboxed).allowed, '开关打开之后已隔离的仍然放行');
}

// ============================================================
// 5. 设置项的默认值
// ============================================================
//
// 默认值必须是**关**。这一条不放在脚本里跑成"读一次默认值"就够 —— 它要钉的是
// 前端这一侧与 Rust 那一侧（`default_allow_unsandboxed_plugins`）取同一个值。
// 两处不一致时的表现是"全新安装"与"字段缺失的老文件"得到相反的策略，
// 而那件事不会报错。

section('设置项默认值');

{
  storedSettings = {};
  const settings = await loadAppSettings();
  check(
    settings.allowUnsandboxedPlugins === false,
    '前端缺省是"不允许"（与后端 default_allow_unsandboxed_plugins 一致）'
  );

  storedSettings = { allowUnsandboxedPlugins: 'true' };
  const messy = await loadAppSettings();
  check(
    messy.allowUnsandboxedPlugins === false,
    '非布尔值不被当成 true（一个被改坏的文件不该放宽策略）'
  );

  storedSettings = { allowUnsandboxedPlugins: true };
  const on = await loadAppSettings();
  check(on.allowUnsandboxedPlugins === true, '显式 true 才生效');
}

// ============================================================
// 结果
// ============================================================

console.log('');
if (failed > 0) {
  console.error(`共 ${total} 项断言，失败 ${failed} 项。`);
  process.exit(1);
}
console.log(`共 ${total} 项断言，失败 0 项。`);
