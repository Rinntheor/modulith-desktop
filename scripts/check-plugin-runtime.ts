// scripts/check-plugin-runtime.ts
//
// 插件运行时的**稳定性夹具**：把真实的 `pluginRuntime` 装进 Node，用一组合成插件
// 去撞它的边界。
//
//   node --import ./scripts/harness/loader.mjs scripts/check-plugin-runtime.ts
//
// 与 `check-contributions.ts` 的分工：那一个断言的是**纯逻辑**（清单怎么被解释成
// 贡献集），这一个断言的是**运行期行为** —— 插件代码到底跑没跑、跑完之后目录与命令
// 面板变成了什么样、卸载有没有把资源收干净。两者的失败模式完全不同：前者的症状是
// "某个插件永远不激活"，后者的症状是"插件明明没用到，代码却已经在跑"和"禁用之后
// 定时器还在"。
//
// 为什么值得为此搭一套环境：`pluginRuntime` 此前只有静态阅读与纯逻辑断言两条验证
// 途径，而它承载的东西（第三方代码的执行、资源生命周期、清单驱动的目录）恰恰是
// 最难从界面看出问题的一层。夹具让"未激活时一行代码都没跑"这类主张变成一条可执行
// 的断言，而不是一句设计说明。

import { createPluginHost, fixtureIds } from './harness/plugin-host.ts';
import { settingStorageKey } from '../src/services/pluginContributions.ts';
import { normalizeCombo } from '../src/services/shortcutRegistry.ts';
import { resolveModuleIconSource } from '../src/components/moduleIconResolver.ts';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let total = 0;

function check(condition: boolean, label: string): void {
  total += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    // 用 stdout 而不是 stderr：夹具会把运行时的错误日志收进缓冲区，
    // 断言结果必须留在一条不会被混淆的通道上。
    console.log(`  ✘ ${label}`);
  }
}

const host = await createPluginHost();
const { runtime, catalog, commands } = host;
const window = host.shim.window as Record<string, unknown>;

// ------------------------------------------------------------
// 脚手架
// ------------------------------------------------------------

/** 夹具自己写的观测日志（与宿主侧的 executedScripts 互为独立证据） */
const fixtureLog = (): string[] => (window['__FIXTURE_LOG__'] as string[]) ?? [];
const executed = (): string[] => host.shim.executedScripts.map((entry) => entry.pluginId);
const loadStateOf = (id: string) => runtime.getLoadStates().get(id);

function resetObservations(): void {
  delete window['__FIXTURE_LOG__'];
  delete window['__FIXTURE_DISPOSED__'];
  host.resetObservations();
}

/** 只建目录、不执行任何 bundle —— 模拟「启动时只同步清单」那一趟 */
async function loadCatalog(pluginIds: string[]): Promise<void> {
  resetObservations();
  host.useOnly(pluginIds);
  await runtime.reloadPluginRuntime(undefined, { listOnly: true });
}

/** 完整加载（会执行 eager 插件）—— 模拟「后台加载」那一趟 */
async function loadAll(pluginIds: string[]): Promise<void> {
  resetObservations();
  host.useOnly(pluginIds);
  await runtime.reloadPluginRuntime();
}

// ============================================================
// 1. 旧式插件：行为必须与 1.2.0 之前逐字一致
// ============================================================
console.log('旧式插件（清单里没有 contributes）：');

{
  const id = 'fixture.legacy-module';
  await loadAll([id]);

  check(loadStateOf(id)?.status === 'loaded', '完整加载后状态为 loaded');
  check(executed().includes(id), 'bundle 被真正执行（真的跑了代码，不是只读了清单）');
  check(fixtureLog().includes('legacy-module:executed'), '夹具自己的日志也记到了执行');
  check(catalog.isDynamicModule('legacy-panel'), '它注册的模块进了目录');
  check(
    catalog.getModuleOwner('legacy-panel') === id,
    '模块归属正确（卸载时能按插件一次性摘掉）'
  );
  check(
    (loadStateOf(id)?.moduleIds ?? []).includes('legacy-panel'),
    '加载状态里记录了它注册的模块 ID'
  );
  check(runtime.getPluginContract(id)?.declarative === false, '装载契约判定为「旧式」');
}

// ============================================================
// 2. 声明式模块：目录先到，代码后跑
// ============================================================
console.log('\n声明式模块插件（按需激活）：');

{
  const id = 'fixture.declarative-module';
  await loadCatalog([id]);

  const descriptor = catalog.getCatalogFlatMap().get('port-panel');

  check(Boolean(descriptor), '模块条目在**只读清单**的阶段就已经在目录里');
  check(descriptor?.visible !== false, '模块默认出现在侧边栏（不是隐藏态）');
  check(descriptor?.pluginId === id, '目录条目的 pluginId 指向提供它的插件');
  check(host.shim.executedScripts.length === 0, '★ 此时一个插件 bundle 都没有被执行');
  check(!fixtureLog().includes('declarative-module:executed'), '夹具自己的日志也证明没跑');
  check(
    runtime.getActivationState(id)?.status === 'inactive' ||
      runtime.getActivationState(id) === undefined,
    '激活状态仍是「未激活」'
  );
  check(
    !host.backendCalls.includes('read_plugin_asset'),
    '建立目录的过程没有读取插件代码（只有清单）'
  );

  // 打开这个模块 —— 走的是 ModuleRenderer 用的同一条懒加载路径
  const loaded = await (descriptor?.component as { preload: () => Promise<{ default: unknown }> })
    .preload();

  check(typeof loaded.default === 'function', '★ 打开模块后拿到了组件');
  check(executed().includes(id), '打开模块触发了插件代码执行');
  check(fixtureLog().includes('declarative-module:executed'), '夹具日志确认执行');
  check(runtime.getActivationState(id)?.status === 'active', '激活状态转为 active');
  check(
    runtime.getActivationState(id)?.reason === 'onModule:port-panel',
    '★ 激活原因是 onModule:port-panel（插件能知道自己为什么被唤醒）'
  );

  // 幂等：再打开一次不应该重复执行
  const before = executed().filter((entry) => entry === id).length;
  await (descriptor?.component as { preload: () => Promise<unknown> }).preload();
  check(
    executed().filter((entry) => entry === id).length === before,
    '重复打开不会重复执行 bundle（激活是幂等的）'
  );
}

// ============================================================
// 3. 纯命令插件：1.2.0 解锁的那一类
// ============================================================
console.log('\n纯命令插件（没有任何模块）：');

{
  const id = 'fixture.command-only';
  await loadAll([id]);

  const commandId = `plugin:${id}:ping`;
  const command = commands.getRegisteredCommands().find((item: any) => item.id === commandId);

  check(loadStateOf(id)?.status !== 'error', '★ 没有任何模块也不再被判为加载失败');
  check(Boolean(command), '★ 命令已经在面板里，而插件代码一行都还没跑');
  check(host.shim.executedScripts.length === 0, '完整加载也没有执行它（它不是 eager）');
  check(
    runtime.getPluginContextMenuEntries().some((entry: any) => entry.id === 'menu-ping'),
    '右键菜单项也在清单期就登记好了'
  );

  await command.run();

  check(executed().includes(id), '执行命令触发了插件代码');
  check(fixtureLog().includes('command-only:ran'), '命令的处理函数被真正调用');
  check(runtime.getActivationState(id)?.status === 'active', '激活状态转为 active');
  check(
    runtime.getActivationState(id)?.reason === 'onCommand:ping',
    '激活原因是 onCommand:ping'
  );
}

// ============================================================
// 4. 后台服务插件：收尾的三条保证
// ============================================================
console.log('\n后台服务插件（无界面 + 资源收尾）：');

{
  const id = 'fixture.background-service';
  await loadAll([id]);

  check(loadStateOf(id)?.status === 'loaded', '★ 零界面、零贡献也加载成功');
  check(executed().includes(id), 'onStartup 让它在加载期就执行');
  check(
    (catalog.getPluginModuleIds(id) as string[]).length === 0,
    '它确实没有注册任何模块'
  );
  check(runtime.getPluginContract(id)?.eager === true, '装载契约判定为 eager（onStartup）');

  runtime.unloadPlugin(id);

  const log = fixtureLog();
  const disposeOrder = log.filter((entry) => entry.startsWith('dispose:'));

  check(
    disposeOrder.join(',') === 'dispose:C,dispose:B,dispose:A',
    `★ 清理函数逆序执行且抛错不牵连其余（实际：${disposeOrder.join(' → ') || '无'}）`
  );
  check(
    host.shim.windowErrors.some((error) =>
      String((error as Error)?.message ?? '').includes('清理函数故意抛错')
    ) === false,
    '清理函数的异常被宿主接住，没有冒泡成未处理错误'
  );

  // 再卸载一次：清理函数只应执行一次
  runtime.unloadPlugin(id);
  check(
    fixtureLog().filter((entry) => entry.startsWith('dispose:')).length === 3,
    '★ 重复卸载不会重复执行清理函数'
  );
}

// ============================================================
// 5. 顶层抛错：只影响自己
// ============================================================
console.log('\n出错的插件：');

{
  const bad = 'fixture.throwing';
  const good = 'fixture.legacy-module';
  await loadAll([bad, good]);

  check(loadStateOf(bad)?.status === 'error', '顶层抛错的插件被标记为 error');
  check(
    String(loadStateOf(bad)?.error ?? '').includes('顶层抛错'),
    '错误信息来自插件自己的异常（不是一句笼统的"加载失败"）'
  );
  check(loadStateOf(good)?.status === 'loaded', '★ 同一批里的其它插件不受影响');
  check(catalog.isDynamicModule('legacy-panel'), '好的插件仍然出现在目录里');
  check(
    executed().includes(bad) && executed().includes(good),
    '两者都被执行过（失败发生在执行期，不是被跳过）'
  );
  check(
    !catalog.isDynamicModule('port-panel'),
    '出错插件的残留没有进目录'
  );
}

{
  const id = 'fixture.no-contribution';
  await loadAll([id]);

  check(loadStateOf(id)?.status === 'error', '★ 旧式且什么都不注册 → 判为失败');
  check(
    String(loadStateOf(id)?.error ?? '').includes('贡献'),
    '错误信息点出了"既没有贡献任何东西，也没有声明激活事件"'
  );
}

// ============================================================
// 6. 模块 ID 冲突
// ============================================================
console.log('\n模块 ID 冲突：');

{
  const owner = 'fixture.declarative-module';
  const intruder = 'fixture.duplicate-module';
  await loadCatalog([owner, intruder]);

  await runtime.activatePlugin(intruder, 'legacy');

  check(catalog.isDynamicModule('shadow-panel'), '它自己声明的模块正常进目录');
  check(
    catalog.getModuleOwner('shadow-panel') === intruder,
    'shadow-panel 归属正确'
  );
  check(
    catalog.getModuleOwner('port-panel') === owner,
    '★ 抢占失败：port-panel 仍然属于原来那个插件'
  );
}

// ============================================================
// 7. 命令声明在卸载后必须留下
// ============================================================
console.log('\n命令声明与卸载：');

{
  const id = 'fixture.command-only';
  const prefix = `plugin:${id}:`;
  const countCommands = () =>
    (commands.getRegisteredCommands() as any[]).filter((item) => item.id.startsWith(prefix)).length;

  await loadCatalog([id]);
  check(countCommands() === 1, '声明期：命令面板里有 1 条');

  await runtime.activatePlugin(id, 'legacy');
  check(countCommands() === 1, '激活后仍然是 1 条（绑定 handler 不新增条目）');

  runtime.unloadPlugin(id);
  check(
    countCommands() === 1,
    '★ 卸载后声明仍在 —— 1.2.0 修掉的正是"禁用再启用就少几条命令"'
  );
  check(
    runtime.getActivationState(id)?.status !== 'active',
    '卸载后激活状态被清掉（下次用到会重新激活）'
  );
}

// ============================================================
// 8. 设置项的读取时机与权限
// ============================================================
console.log('\n插件设置：');

{
  const id = 'fixture.settings-only';

  // 模拟"用户此前改过这个值"：值必须在插件激活**之前**就被读回来
  await host.shim.window['__TAURI_INTERNALS__'] &&
    (await (host.shim.window as any)['__TAURI_INTERNALS__'].invoke('plugin_storage_set', {
      id,
      key: settingStorageKey('interval'),
      value: '5',
    }));

  await loadAll([id]);

  check(executed().includes(id), '声明了 onStartup，加载期就执行');
  check(
    fixtureLog().includes('settings-only:interval=5'),
    '★ ctx.settings 是同步可用的 —— 顶层读到了用户改过的值 5（不是缺省值 30）'
  );
  check(fixtureLog().includes('settings-only:available=true'), '声明了 storage 权限，isAvailable 为真');

  // 去掉 storage 权限：设置应变为不可用，而不是给出一个改了不生效的控件
  const manifest = host.fixtures.get(id)?.manifest ?? {};
  host.overrideManifest(id, { ...manifest, permissions: [] });
  await loadAll([id]);

  const settingsModule = (await import('../src/services/pluginSettings.ts')) as Record<string, any>;
  check(
    settingsModule.isPluginSettingsAvailable(id) === false,
    '★ 没有 storage 权限时设置被标记为不可用'
  );
  check(
    fixtureLog().includes('settings-only:available=false'),
    '插件自己也能从 isAvailable() 看出来'
  );

  host.overrideManifest(id, manifest);
}

// ============================================================
// 9. 规模：装了 N 个插件 ≠ 进 N 段第三方代码
// ============================================================
console.log('\n规模（全部夹具一起装）：');

{
  const all = fixtureIds();
  await loadAll(all);

  const ran = executed();
  const lazyFixtures = [
    'fixture.declarative-module',
    'fixture.command-only',
    'fixture.duplicate-module',
    'fixture.context-menu-icon',
  ];
  const ranLazy = ran.filter((id) => lazyFixtures.includes(id));

  check(all.length === 11, `夹具数量为 11（当前 ${all.length}）`);
  check(
    ranLazy.length === 0,
    `★ 按需激活的插件一个都没执行（实际执行了：${ranLazy.join('、') || '无'}）`
  );
  check(
    ran.length > 0 && ran.length < all.length,
    `★ 只有一部分插件被执行（${ran.length} / ${all.length}）`
  );
  check(
    catalog.isDynamicModule('port-panel') &&
      catalog.isDynamicModule('legacy-panel') &&
      catalog.isDynamicModule('shadow-panel'),
    '声明式与旧式的模块条目都在目录里，与"有没有执行"无关'
  );

  // 全部启用状态下，命令面板里应当同时有声明式命令与旧式插件注册的命令
  check(
    (commands.getRegisteredCommands() as any[]).some(
      (item) => item.id === 'plugin:fixture.command-only:ping'
    ),
    '命令面板里仍然有那条未激活插件的命令'
  );

  host.useAll();
}

// ============================================================
// 9. SVG 图标：目录重建之后必须还在
// ============================================================

// 这一节守的是一个真实缺陷。图标是**后补**进目录的（`setModuleIconSvg`：清单期
// 只知道路径，内容要异步读），而目录在每次重载时都被清空重建。于是"补过一次"
// 被当成了"永远有了"，只有重启（内存清空）才能恢复。
//
// 用户看到的是两句话 —— 「删除重装后图标不能立马加载出来，有时要刷新」与
// 「图标怎么不是它自带的」。两者是同一个根因的两个面：
//   * `reloadPluginRuntime()` 重建目录后不补图标 → 图标不出现；
//   * 卸载时只清执行过的插件，`pluginIcons` 里的残留活到重装之后 → 显示旧的。
console.log('\nSVG 图标在目录重建后的存活：');

{
  const id = 'fixture.declarative-icon';
  const svgOf = (): string | undefined =>
    (catalog.getCatalogFlatMap().get('icon-panel') as { iconSvg?: string } | undefined)?.iconSvg;
  const isSvg = (value: string | undefined): boolean =>
    typeof value === 'string' && value.trimStart().startsWith('<svg');

  await loadAll([id]);
  check(isSvg(svgOf()), '★ 图标在装配完成后被补进了目录');
  check(
    !executed().includes(id),
    '它同时是「按需激活」的 —— 因此图标只能来自补全，不能来自 bundle 执行'
  );

  // 再重载一次：目录被清空重建。这一步以前会丢图标 —— `prefetchDeclaredIcons`
  // 看到缓存里已经有它，就把整个循环体跳过了，重建出来的条目再也拿不到 iconSvg。
  await loadAll([id]);
  check(isSvg(svgOf()), '★ 重载运行时之后图标仍然在（这是它以前会丢的地方）');

  // 卸载路径：插件从列表里消失时，它的图标缓存必须一起清掉。
  // 只遍历 `injectedAssets` 是不够的 —— 这个插件从来没执行过代码，在那里根本
  // 没有条目，而它的图标已经被预取填进了 `pluginIcons`。
  host.setEnabled(id, false);
  await runtime.reloadPluginRuntime();
  check(!catalog.isDynamicModule('icon-panel'), '禁用后模块条目从目录消失');

  host.backendCalls.length = 0;
  host.setEnabled(id, true);
  await loadAll([id]);
  check(isSvg(svgOf()), '禁用再启用之后图标重新补上');
  check(
    host.backendCalls.filter((command) => command === 'read_plugin_asset').length > 0,
    '★ 重新启用后**重新读了图标文件** —— 说明卸载时缓存被清掉了，用的不是上一份'
  );
}

// ============================================================
// 9b. 路径型 `icon` 与**启动路径**上的图标补全
// ============================================================
//
// 上一节守的是「插件级 `icon.svg` 在目录重建之后不丢」。这一节守的是用户报过的
// 另外两句话，它们是同一个缺陷的两个面：
//
//   「插件没有使用其自身自带的图标，而是使用宿主的图标库」
//   「有的图标甚至直接找不到了」
//
// 根因是**图标补全之前的那段窗口**。模块描述符建立时 `iconSvg` 必然是空的
// （SVG 内容要异步读，见 `prefetchPluginIcon`），而启动的第一趟是 `listOnly`
// ——它在建完目录后直接 `return`，从前**根本不会走到补图标那一步**。于是启动后
// 第一眼看到的侧边栏里：
//
//   * 模块写 lucide 名（`Rocket`）→ 走宿主的 lucide 图标（第一句话）；
//   * 模块写包内路径（`icon.svg`）→ 查不到名字、也没有 `iconSvg` → `Box`（第二句话）。
//
// 这一节因此断言两件事：
//   (a) 路径型 `icon`（模块自己声明的那张图）**不会**落到 `Box`，而且用的是那个
//       模块自己那张图，不是插件级图标；
//   (b) 图标补全在**启动路径**（`listOnly` 那一趟与后台那一趟）上确实发生了。
console.log('\n路径型模块图标与启动路径：');

{
  const id = 'fixture.declarative-module-icon';
  /** 目录里的条目只用到这两个字段，这里按用到的形状取，避免 `any` 漏掉拼写错误 */
  const descriptorOf = (moduleId: string): { icon?: string; iconSvg?: string } | undefined =>
    catalog.getCatalogFlatMap().get(moduleId) as { icon?: string; iconSvg?: string } | undefined;
  const svgOf = (moduleId: string): string | undefined => descriptorOf(moduleId)?.iconSvg;

  /**
   * 等图标被补上。
   *
   * `listOnly` 那一趟是**故意不 await 图标补全**的（它的全部意义就是"不等 I/O"），
   * 因此这里必须轮询；轮不到就是缺陷本身，不是测试写法的妥协 —— 上界给足 2 秒，
   * 夹具里一次读盘是 0 毫秒级。
   */
  const waitIcon = async (moduleId: string): Promise<string | undefined> => {
    for (let i = 0; i < 400; i += 1) {
      const svg = svgOf(moduleId);
      if (svg) return svg;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return svgOf(moduleId);
  };

  // --- (b) 启动的第一趟：只读清单，不执行任何 bundle ---
  await loadCatalog([id]);
  check(!executed().includes(id), '启动第一趟没有执行任何插件代码（图标只能来自资源读取）');

  const ownIcon = await waitIcon('own-icon-panel');
  check(
    typeof ownIcon === 'string' && ownIcon.includes('fixture-panel-own'),
    '★ 启动第一趟（listOnly）之后，模块级 icon.svg 已经补进了目录'
  );
  check(
    typeof ownIcon === 'string' && !ownIcon.includes('fixture-plugin-brand'),
    '★ 它用的是**那个模块自己**那张图，而不是插件级图标'
  );

  const brandIcon = await waitIcon('brand-panel');
  check(
    typeof brandIcon === 'string' && brandIcon.includes('fixture-plugin-brand'),
    '★ 没写 icon 的模块回落到插件级图标（清单顶层 icon.svg）'
  );

  // 更精确的一条：模块级那张图必须**按它自己在包内的路径**去读。
  // 只看"补进去了"是不够的 —— 插件级图标恰好也在同一个包里，读错了路径同样能填上值。
  check(
    host.backendCallsWithArgs.some(
      (call) =>
        call.command === 'read_plugin_asset' &&
        call.args.id === id &&
        call.args.rel === 'panels/own.svg'
    ),
    '★ 宿主是按模块自己那个路径（panels/own.svg）读的图'
  );

  // --- (a) `ModuleIcon` 的判定：路径型 icon 不会落到 Box ---
  //
  // 判定被抽到 `moduleIconResolver.ts` 才可能被断言：Node 的类型擦除不转换 JSX，
  // `.tsx` 里的逻辑没有任何脚本能加载（见 scripts/harness/loader.mjs 的说明）。
  const hasBuiltinIcon = (name: string): boolean => name === 'Package';

  const ownDescriptor = descriptorOf('own-icon-panel');
  check(
    ownDescriptor?.icon === 'panels/own.svg',
    '描述符里的 icon 就是清单里那个**包内路径**（不是图标名）'
  );

  const fromCatalog = resolveModuleIconSource({
    icon: ownDescriptor?.icon,
    iconSvg: ownDescriptor?.iconSvg,
    hasBuiltinIcon,
  });
  check(
    fromCatalog.kind === 'inline-svg',
    `★ 目录里的条目（icon 是包内路径）走内联 SVG —— 不会落到 Box（实际：${fromCatalog.kind}）`
  );

  const decisions: Array<[string, string, boolean]> = [
    [
      'icon 是路径且没有 iconSvg → 兜底 Box（宿主没补上时也不空白）',
      resolveModuleIconSource({ icon: 'icon.svg', hasBuiltinIcon }).kind,
      resolveModuleIconSource({ icon: 'icon.svg', hasBuiltinIcon }).kind === 'fallback',
    ],
    [
      'icon 是内置模块用过的名字 → 构建期映射表（内置行为不变）',
      resolveModuleIconSource({ icon: 'Package', hasBuiltinIcon }).kind,
      resolveModuleIconSource({ icon: 'Package', hasBuiltinIcon }).kind === 'builtin',
    ],
    [
      'icon 是 lucide 名 → 按需加载',
      resolveModuleIconSource({ icon: 'Rocket', hasBuiltinIcon }).kind,
      resolveModuleIconSource({ icon: 'Rocket', hasBuiltinIcon }).kind === 'lucide',
    ],
    [
      'iconSvg 在场时压过一切（插件自己的图标优先）',
      resolveModuleIconSource({ icon: 'Package', iconSvg: '<svg/>', hasBuiltinIcon }).kind,
      resolveModuleIconSource({ icon: 'Package', iconSvg: '<svg/>', hasBuiltinIcon }).kind ===
        'inline-svg',
    ],
    [
      'icon 是路径时绝不去查 lucide（它不是图标名）',
      resolveModuleIconSource({ icon: 'icons/a.svg', hasBuiltinIcon }).kind,
      resolveModuleIconSource({ icon: 'icons/a.svg', hasBuiltinIcon }).kind === 'fallback',
    ],
  ];
  for (const [label, actual, ok] of decisions) {
    check(ok, `${label}（实际：${actual}）`);
  }

  // --- (c) 右键菜单项：与侧边栏/仪表盘显示**同一个插件**的那张图 ---
  //
  // 用户报的那句「找不到」在右键菜单里还有第二个落点：`contributes.contextMenus[].icon`
  // 在运行时**不做 svg 路径解析**。写 `icon.svg` 的插件在模块那条路上已经被 9b 的
  // (a) 修好了，而菜单项此前只把 `icon` 交给 `ModuleIcon`、没有 `iconSvg` ——
  // 于是同一个插件在侧边栏有图、在右键菜单里却是 `Box`。
  //
  // 这里断言的是**结果**（菜单项拿得到 `iconSvg`、且判定不会落到 `fallback`），
  // 不是"代码里写了一行"。
  const menuEntry = (menuId: string): { icon?: string; iconSvg?: string } | undefined =>
    runtime.getPluginContextMenuEntries().find((entry) => entry.id === menuId);

  /** 与 `waitIcon` 同理：图标补全不阻塞调用方，这里必须轮询 */
  const waitMenuIcon = async (menuId: string): Promise<string | undefined> => {
    for (let i = 0; i < 400; i += 1) {
      const svg = menuEntry(menuId)?.iconSvg;
      if (svg) return svg;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return menuEntry(menuId)?.iconSvg;
  };

  const brandMenu = await waitMenuIcon('brand-menu');
  check(
    typeof brandMenu === 'string' && brandMenu.includes('fixture-plugin-brand'),
    '★ 插件右键菜单项（没写 icon）也拿到了插件自己的图标（不是 Box）'
  );

  const ownMenu = await waitMenuIcon('own-icon-menu');
  check(
    typeof ownMenu === 'string' && ownMenu.includes('fixture-panel-own'),
    '★ 菜单项自己声明了包内路径时，用的是那一张（与同名模块一致）'
  );
  check(
    host.backendCallsWithArgs.some(
      (call) =>
        call.command === 'read_plugin_asset' &&
        call.args.id === id &&
        call.args.rel === 'panels/own.svg'
    ),
    '菜单项那张图是按它自己声明的包内路径读回来的'
  );

  // 判定层：把菜单项真实的 icon / iconSvg 喂给同一个纯函数，它必须走内联 SVG。
  // 只断言"字段有值"是不够的 —— `ModuleIcon` 认的才是最终结果。
  const menuSource = resolveModuleIconSource({
    icon: menuEntry('own-icon-menu')?.icon,
    iconSvg: menuEntry('own-icon-menu')?.iconSvg,
    hasBuiltinIcon,
  });
  check(
    menuSource.kind === 'inline-svg',
    `★ 右键菜单项的判定走内联 SVG，不会落到 Box（实际：${menuSource.kind}）`
  );

  // 反面判据：**没有** iconSvg 的菜单项仍然按老规矩落 Box，绝不空白。
  // 少了这一条，"菜单项永远画一张图"这种改法也能让上面几条全绿。
  const noIconSource = resolveModuleIconSource({
    icon: 'icon.svg',
    hasBuiltinIcon,
  });
  check(
    noIconSource.kind === 'fallback',
    `★ 拿不到图时仍然落 Box 兜底（绝不空白），实际：${noIconSource.kind}`
  );

  // --- (b) 启动的第二趟：真实的后台加载入口 ---
  //
  // 这一趟会把目录整个清空重建（`clearDynamicModules`），因此它同时证明：
  // 图标不是靠第一趟的残留，而是重建**之后**又补了一次。
  const beforeRebuild = descriptorOf('own-icon-panel');
  host.useOnly([id]);
  await runtime.loadPluginsInBackground();
  const afterRebuild = descriptorOf('own-icon-panel');

  check(
    Boolean(beforeRebuild) && Boolean(afterRebuild) && beforeRebuild !== afterRebuild,
    '后台加载那一趟把目录清空重建了（描述符是新的对象，不是上一趟的残留）'
  );
  check(
    (afterRebuild?.iconSvg ?? '').includes('fixture-panel-own'),
    '★ 后台加载那一趟之后，模块自己的图标重新补在了新条目上'
  );
  check(
    !executed().includes(id),
    '它仍然没有被执行（按需激活）—— 因此上面那些图标只可能来自资源读取'
  );

  // --- (d) 插件级图标**不是** SVG 时，候选过滤必须单独看右键菜单项 ---
  //
  // 上面那个夹具的清单顶层就是 `icon.svg`，因此它无论如何都进候选集 ——
  // 过滤条件里"右键菜单项也声明了 SVG 路径"那一支被删掉也不会有任何一条红。
  // 这个夹具的顶层图标是 lucide 名（`Package`）、没有任何模块带图，
  // `panels/menu.svg` **只被右键菜单项引用**：过滤漏了这一支，这个插件整条被滤掉，
  // 那张图永远不会被读，菜单项于是落 `Box`。
  const menuOnlyId = 'fixture.context-menu-icon';
  await loadCatalog([menuOnlyId]);

  const menuOnlySvg = await waitMenuIcon('menu-only');
  check(
    typeof menuOnlySvg === 'string' && menuOnlySvg.includes('fixture-context-menu-own'),
    '★ 只被右键菜单项引用的那张图也被读回来了（候选过滤不只看插件级与模块图标）'
  );
  check(
    host.backendCallsWithArgs.some(
      (call) =>
        call.command === 'read_plugin_asset' &&
        call.args.id === menuOnlyId &&
        call.args.rel === 'panels/menu.svg'
    ),
    '它是按菜单项自己声明的包内路径读的'
  );
  check(
    resolveModuleIconSource({
      icon: menuEntry('menu-only')?.icon,
      iconSvg: menuEntry('menu-only')?.iconSvg,
      hasBuiltinIcon,
    }).kind === 'inline-svg',
    '★ 这个插件的右键菜单项同样不会落到 Box'
  );
  check(
    !executed().includes(menuOnlyId),
    '它没有被执行（按需激活）—— 图标只能来自资源读取'
  );

  host.useAll();
}

// ------------------------------------------------------------
// 组合键语法：Rust 侧那份实现必须与前端这一份**逐条同义**
// ------------------------------------------------------------
//
// ============================================================
// 这一节存在的理由：`ctx.hotkey.register` 让这套语法有了第二个实现
// ============================================================
//
// 组合键的唯一语法一直是前端这一份（`shortcutRegistry.ts` 的 `parseCombo` /
// `normalizeCombo`）。`ctx.hotkey` 进来之后，Rust 侧**必须**也有一份 ——
// `RegisterHotKey` 拿到的是一个整数，它不知道 `mod+k` 是什么意思。
//
// 两份实现一定会漂，除非有东西钉住它们。钉的方式是：Rust 侧那份语料表
// （`hotkey.rs::GRAMMAR_CASES`）是**公开数据**，这里把它读出来，用**真正的**
// `normalizeCombo()` 逐条重算一遍，两边对不上就点名是哪一条。
//
// 为什么这一条比"两边各写一份单测"强：各自单测只能证明各自内部一致 ——
// 而漂移恰恰是在两边各自都自洽的时候发生的（改了一侧的别名表，那一侧的测试
// 跟着改，全绿）。只有把两份实现放在同一次断言里，漂移才会红。
console.log('\n组合键语法（Rust ↔ 前端）：');

{
  const hotkeyRs = readFileSync(
    resolve(here, '../src-tauri/src/modules/plugins/hotkey.rs'),
    'utf8'
  );

  const start = hotkeyRs.indexOf('pub const GRAMMAR_CASES');
  const end = hotkeyRs.indexOf('\n];', start);
  check(start >= 0 && end > start, '能从 hotkey.rs 定位到 GRAMMAR_CASES');

  // 只认**整行**是 `("输入", Some("输出"))` 或 `("输入", None)` 的那些行 ——
  // 注释行与 `&[(` 那一行都不会命中。宽松的匹配会把注释里举的例子也算成语料，
  // 而那会让这条断言在"文档写了例子、实现没跟上"时给出一个假失败。
  const CASE = /^\s*\("((?:[^"\\]|\\.)*)",\s*(?:None|Some\("((?:[^"\\]|\\.)*)"\))\),\s*$/;
  const cases: Array<[string, string | null]> = [];
  for (const line of hotkeyRs.slice(start, end).split(/\r?\n/)) {
    const match = CASE.exec(line);
    if (match) cases.push([match[1], match[2] ?? null]);
  }

  check(cases.length >= 15, `语料表读到 ${cases.length} 条（少于 15 条说明解析或表被削了）`);

  const mismatched = cases
    .filter(([input, expected]) => normalizeCombo(input) !== expected)
    .map(([input, expected]) => `"${input}" → 前端 ${JSON.stringify(normalizeCombo(input))}，Rust ${JSON.stringify(expected)}`);

  check(
    mismatched.length === 0,
    mismatched.length === 0
      ? `Rust 侧的组合键语法与 shortcutRegistry.ts 逐条一致（${cases.length} 条，含反例）`
      : `★ 组合键语法在两份实现之间漂了 —— 同一个组合在宿主里会被绑成另一个键：\n      ${mismatched.join('\n      ')}`
  );

  // 反例必须真的在表里：只留正例的话，两边同时把 `mod+a+b` 放行也不会有任何一条红。
  check(
    cases.some(([, expected]) => expected === null),
    '语料表里保留了**不合法**的反例（只有正例会让"两边一起放宽"无法被发现）'
  );
}

// ------------------------------------------------------------
host.restoreConsole();

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
