// scripts/harness/plugin-host.ts
//
// 把真实的 `pluginRuntime` 装进一个 Node 进程里，并给它一个**假后端**。
//
// 分工：
//   * `dom-shim.ts` 提供浏览器环境（含真正执行 `<script>`）；
//   * 这里提供 Rust 侧的桩（`list_plugins` / `read_plugin_asset` / `plugin_storage_*` …）
//     以及夹具插件的装载。
//
// 假后端是这套夹具成立的关键。若没有它，要验证「插件未激活时一行代码都没跑」
// 就只能靠读代码推断；有了它，`shim.executedScripts` 是一份**可断言的观测记录**。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDomShim, type DomShim } from './dom-shim.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 夹具根目录：每个子目录是一个"插件包"（manifest.json + index.js） */
export const FIXTURES_ROOT = resolve(here, '..', 'fixtures', 'plugins');

export interface FixturePlugin {
  /** 插件 ID，取自 manifest.name */
  id: string;
  dir: string;
  manifest: Record<string, unknown>;
  /** `main` 指向的代码 */
  code: string;
  /** `style` 指向的样式（没有则为 null） */
  style: string | null;
  iconSvg: string | null;
}

/** 读出全部夹具。目录名只是给人看的，插件 ID 以 manifest.name 为准。 */
export function listFixtures(): FixturePlugin[] {
  if (!existsSync(FIXTURES_ROOT)) return [];

  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = resolve(FIXTURES_ROOT, entry.name);
      const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;

      const readOptional = (rel: unknown): string | null => {
        if (typeof rel !== 'string' || rel.length === 0) return null;
        const path = resolve(dir, rel);
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      };

      return {
        id: String(manifest.name),
        dir,
        manifest,
        code: readOptional(manifest.main ?? 'index.js') ?? '',
        style: readOptional(manifest.style),
        iconSvg: readOptional(manifest.icon),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface PluginHost {
  shim: DomShim;
  /** 真实插件运行时模块 */
  runtime: Record<string, any>;
  /** 真实模块目录 */
  catalog: Record<string, any>;
  /** 真实命令注册表 */
  commands: Record<string, any>;
  /** 夹具索引 */
  fixtures: Map<string, FixturePlugin>;
  /** 桩后端收到过的命令名（按顺序）—— 用来断言"宿主没有做多余的事" */
  backendCalls: string[];
  /** 被捕获的运行时日志（默认不打到终端，见 createPluginHost 里的说明） */
  logs: { info: string[]; warn: string[]; error: string[] };
  /** 清空日志缓冲 */
  clearLogs(): void;
  /** 把 console 换回原样（脚本收尾时调用） */
  restoreConsole(): void;
  /** 插件存储的快照，用来断言设置与清理 */
  storageSnapshot(): Record<string, Record<string, string>>;
  /** 桩后端的剪贴板订阅表快照：谁当前"正在被宿主轮询"。 */
  clipboardSubscriptions(): string[];
  /** 启用/禁用一个夹具插件（下一次 reload 生效） */
  setEnabled(pluginId: string, enabled: boolean): void;
  /**
   * 让「已安装列表」只包含这几个夹具（下一次 reload 生效）。
   *
   * 场景隔离的必需品：假后端的 `list_plugins` 默认返回全部夹具，
   * 于是一个只想测「纯命令插件」的用例会顺带把「顶层抛错」那个也加载进来。
   */
  useOnly(pluginIds: string[]): void;
  /** 让全部夹具重新参与（恢复默认） */
  useAll(): void;
  /** 让某个夹具的清单暂时变成另一份（用于测畸形清单） */
  overrideManifest(pluginId: string, manifest: Record<string, unknown>): void;
  /** 清空观测记录（DOM 侧与后端调用） */
  resetObservations(): void;
}

/**
 * 建一个宿主。
 *
 * 注意 `import` 发生在**垫片安装之后**：`commandRegistry` 在模块顶层会读
 * `localStorage`（有 `typeof window === 'undefined'` 守卫，因此顺序其实不要紧，
 * 但没有理由去依赖那个守卫）。
 */
export async function createPluginHost(): Promise<PluginHost> {
  const shim = installDomShim();
  const fixtures = new Map(listFixtures().map((fixture) => [fixture.id, fixture]));

  const enabled = new Map<string, boolean>();
  for (const fixture of fixtures.values()) enabled.set(fixture.id, true);

  /** 参与「已安装列表」的夹具；`useOnly` 会收窄它 */
  let active = new Set<string>(fixtures.keys());

  const manifestOverrides = new Map<string, Record<string, unknown>>();

  const storage = new Map<string, Map<string, string>>();
  const secrets = new Map<string, Map<string, string>>();
  const backendCalls: string[] = [];

  // ------------------------------------------------------------
  // 控制台捕获
  //
  // 运行时会为每一个预期内的失败打一大段错误日志（"顶层抛错"那个夹具、权限被拒
  // 的那个场景）。它们本身是**预期行为**，直接铺在终端里会把断言结果冲得看不见 ——
  // 而看不见的检查等于没有检查。
  //
  // 因此默认收进缓冲区，由调用方按需断言；`PLUGIN_HARNESS_VERBOSE=1` 时同时照常打印。
  // ------------------------------------------------------------
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const originalConsole = { info: console.info, warn: console.warn, error: console.error };
  const verbose = process.env.PLUGIN_HARNESS_VERBOSE === '1';

  const stringify = (args: unknown[]): string =>
    args
      .map((arg) =>
        typeof arg === 'string'
          ? arg
          : arg instanceof Error
            ? `${arg.name}: ${arg.message}`
            : (() => {
                try {
                  return JSON.stringify(arg) ?? String(arg);
                } catch {
                  return String(arg);
                }
              })()
      )
      .join(' ');

  console.info = (...args: unknown[]) => {
    logs.info.push(stringify(args));
    if (verbose) originalConsole.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    logs.warn.push(stringify(args));
    if (verbose) originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    logs.error.push(stringify(args));
    if (verbose) originalConsole.error(...args);
  };

  const bucket = (pluginId: string): Map<string, string> => {
    const existing = storage.get(pluginId);
    if (existing) return existing;
    const created = new Map<string, string>();
    storage.set(pluginId, created);
    return created;
  };

  /**
   * 密钥与 `ctx.storage` **分开的两张表**，即使夹具里两者都是 Map。
   *
   * 合成一张会让"插件把凭据写进 storage、而不是 secrets"这件事在夹具里看不出来 ——
   * 而那正是这个 API 存在的理由。
   */
  const secretBucket = (pluginId: string): Map<string, string> => {
    const existing = secrets.get(pluginId);
    if (existing) return existing;
    const created = new Map<string, string>();
    secrets.set(pluginId, created);
    return created;
  };

  const installedPlugins = () =>
    [...fixtures.values()]
      .filter((fixture) => active.has(fixture.id))
      .map((fixture) => {
        const manifest = manifestOverrides.get(fixture.id) ?? fixture.manifest;
        return {
          id: fixture.id,
          version: String(manifest.version ?? '1.0.0'),
          path: fixture.dir,
          manifest,
          enabled: enabled.get(fixture.id) ?? true,
          status: 'enabled' as const,
          installedAt: '2026-01-01T00:00:00.000Z',
          source: 'file',
          sizeBytes: fixture.code.length,
          hasStyle: fixture.style !== null,
          readme: null,
        };
      });

  const manifestOf = (pluginId: string): Record<string, any> | undefined =>
    manifestOverrides.get(pluginId) ?? fixtures.get(pluginId)?.manifest;

  /**
   * 与 Rust 侧 `plugin_storage_*` 里的 `require_permission("storage")` 对齐。
   *
   * 桩后端**必须如实拒绝**。一个比真实宿主更宽松的桩会给出错误的安全感：
   * 夹具会显示"没有权限也能读写设置"，而这正是真实运行时不成立的事。
   * 这条纪律对将来接入出站管控同样重要 —— 那时桩要照抄的是网络策略。
   */
  const requireStorage = (pluginId: string): void => {
    const permissions = (manifestOf(pluginId)?.permissions as string[] | undefined) ?? [];
    if (!permissions.includes('storage')) {
      throw new Error(`插件 "${pluginId}" 的清单里没有声明 "storage" 权限，命令被拒绝`);
    }
  };

  /**
   * 与 Rust 侧 `secrets.rs::require_permission` 对齐。
   *
   * 与 `requireStorage` 同一条纪律（桩后端必须如实拒绝），但这里还多一层理由：
   * 密钥的实现在真实宿主里**只有 RPC 与命令层够得着**，因此"没声明就用不了"是
   * 这一项的全部边界 —— 一个不检查权限的桩会让夹具测出"没声明也能存密钥"，
   * 而那正是真实运行时不成立的事。
   */
  const requireSecrets = (pluginId: string): void => {
    const permissions = (manifestOf(pluginId)?.permissions as string[] | undefined) ?? [];
    if (!permissions.includes('secrets')) {
      throw new Error(`插件 "${pluginId}" 的清单里没有声明 "secrets" 权限，命令被拒绝`);
    }
  };

  /**
   * 与 Rust 侧 `clipboard::require_permission` 对齐。
   *
   * 与 `requireSecrets` 同一条纪律，而这一项更该被如实拒绝：它读的是用户在这台
   * 机器上复制的**所有**内容。夹具里还要多记一件事 —— **谁订阅了**（见
   * `clipboardSubscribers`），因为"没有订阅者时宿主不该轮询"这条唯一能被断言的地方
   * 就是那张表。
   */
  const requireClipboardMonitor = (pluginId: string): void => {
    const permissions = (manifestOf(pluginId)?.permissions as string[] | undefined) ?? [];
    if (!permissions.includes('clipboard-monitor')) {
      throw new Error(
        `插件 "${pluginId}" 的清单里没有声明 "clipboard-monitor" 权限，命令被拒绝`
      );
    }
  };

  /**
   * 与 Rust 侧 `hotkey::require_permission` 对齐。
   *
   * 与 `requireSecrets` 同一条纪律，而这一项有个特别之处：它在真实宿主里会**占用
   * 一个系统级独占资源**。夹具里没有真实的 `RegisterHotKey`，因此这里能如实验证的
   * 只有两件可判定的事 —— **权限对不对**、以及**调用形状对不对**。真正的注册/
   * 解绑语义由 `hotkey.rs` 的单测覆盖（冲突消息、4 条上限、只能解绑自己的组合）。
   */
  const requireHotkey = (pluginId: string): void => {
    const permissions = (manifestOf(pluginId)?.permissions as string[] | undefined) ?? [];
    if (!permissions.includes('global-hotkey')) {
      throw new Error(`插件 "${pluginId}" 的清单里没有声明 "global-hotkey" 权限，命令被拒绝`);
    }
  };

  /**
   * 与 Rust 侧 `selection::require_permission` 对齐。
   *
   * 桩**必须如实拒绝**，而且比别的几项更要紧：这一项读的是用户在任何程序里选中的
   * 内容。夹具里没有剪贴板、没有前台窗口，因此"能不能读到"无从验证 —— 但"没声明
   * 权限就拒绝"是这一项在真实运行时**最不该被放宽**的那一条。
   */
  const requireSelection = (pluginId: string): void => {
    const permissions = (manifestOf(pluginId)?.permissions as string[] | undefined) ?? [];
    if (!permissions.includes('read-selection')) {
      throw new Error(`插件 "${pluginId}" 的清单里没有声明 "read-selection" 权限，命令被拒绝`);
    }
  };

  /**
   * 与 Rust 侧 `rpc::require_ui_permission` 对齐（`ctx.ui.popover` 那一族）。
   *
   * 与 `requireSecrets` 同一条纪律：桩后端必须如实拒绝。这一项容易被漏掉 ——
   * 卡片看起来只是"显示一段文本"，但真实宿主把 `ui.popover` 与 `ui.dialog` /
   * `ui.contextMenu` 一起判在了 `notification` 上（三者都会打断用户）。桩里不检查
   * 的话，夹具会替一个没声明权限的插件"成功显示"一张卡片。
   */
  const requireNotification = (pluginId: string): void => {
    const permissions = (manifestOf(pluginId)?.permissions as string[] | undefined) ?? [];
    if (!permissions.includes('notification')) {
      throw new Error(`插件 "${pluginId}" 的清单里没有声明 "notification" 权限，命令被拒绝`);
    }
  };

  /**
   * 夹具的"宿主订阅表"。真实宿主用它决定轮询线程起不起（见
   * `plugins/clipboard.rs` 的"生命周期"一节），而夹具用它回答"这个插件订阅了没有"。
   *
   * **它必须与宿主一样按插件 id 记，而不是按调用次数记**：真实的表是
   * `插件 id → 订阅者集合`，重复订阅是幂等的 —— 一个按次数记的夹具会让
   * "重复订阅"在夹具里看起来有问题、在真机上没有问题。
   */
  const clipboardSubscribers = new Set<string>();

  /**
   * 全局热键在夹具里的两张表：`规范化组合键 → 插件 id`、以及 `谁订阅了触发`。
   *
   * **夹具不做任何真实注册**（没有消息窗口，也没有系统热键名额），因此这两张表
   * 是这一项在夹具里**唯一**能被断言的东西：权限有没有判、组合键有没有被规范化、
   * 解绑是不是只动自己的、订阅有没有登记。真正的注册/解绑语义在 `hotkey.rs` 的
   * 单测里，而"用户按下去有没有反应"只能在真机上验 —— 这里不假装能验它。
   */
  const hotkeys = new Map<string, string>();
  const hotkeySubscribers = new Set<string>();

  /** 设置的可变状态。夹具自己持有；**默认值交给前端的 normalize 补** */
  const appSettings: Record<string, any> = {};

  const handlers: Record<string, (args: Record<string, any>) => unknown> = {
    get_app_info: () => ({ version: '1.2.0', platform: 'windows', tauriVersion: '2.0.0' }),

    // 设置：前端门面的同步判定读的就是它（`netGuard.ts` → `getCachedSettings()`），
    // 因此夹具必须能改这两个值 —— 否则"离线时直接出站会被拒"这条断言根本没法写。
    //
    // 返回空对象让前端自己的 normalize 补默认值：夹具**不复制**一份默认设置，
    // 那正是"同一份名单的第二份副本"。
    get_app_settings: () => ({ ...appSettings }),
    update_app_settings: ({ settings }) => {
      Object.assign(appSettings, settings ?? {});
      return { ...appSettings };
    },

    list_plugins: () => installedPlugins(),

    // 命令归属的判定在**宿主**那一侧（`commands.rs::run_plugin_declared_command`），
    // 前端只消费它的答案（`"sandboxed"` / `"in-process"`）。
    //
    // 桩必须照实现回答，否则"执行一条声明式命令"这条路径在夹具里会走进沙箱分支、
    // 于是一个插件代码都不会被执行 —— 而"执行命令触发了插件代码"正是这门门禁
    // 要盯的东西。它返回 `"sandboxed"` 时前端会**早退**，那对沙箱夹具是对的。
    run_plugin_declared_command: ({ pluginId }) => {
      const fixture = fixtures.get(String(pluginId));
      if (!fixture) throw new Error(`夹具里没有插件 "${pluginId}"`);
      return fixture.manifest.runtime === 'sandboxed' ? 'sandboxed' : 'in-process';
    },

    // 安全模式：夹具里永远是"没开"（没有"上一次启动没走干净"这件事）。
    // 提供它而不是让调用方吃一个 reject，是因为 `getSafeModeState` 会捕获失败并按
    // "没开"处理 —— 那条回落路径本身值得被单独测，不该在这里被意外覆盖。
    safe_mode_state: () => ({ active: false, reason: null }),

    // 夹具里没有标记文件系统，但"前端确实在插件那一步之前报了启动成功"这件事
    // 必须能被喂进去 —— 否则 `boot.ts` 里那句 `invoke('mark_boot_ok')` 会走到
    // 它自己的 catch 分支，测试看到的是"命令不存在"而不是被测的行为。
    // 它没有可观察的返回值（宿主侧也只是写一个标记文件），因此桩是空操作。
    mark_boot_ok: () => undefined,

    list_plugin_permissions: () => [],

    read_plugin_asset: ({ id, rel }) => {
      const fixture = fixtures.get(String(id));
      if (!fixture) throw new Error(`夹具里没有插件 "${id}"`);
      if (rel === (fixture.manifest.main ?? 'index.js')) return fixture.code;
      if (fixture.manifest.style && rel === fixture.manifest.style) return fixture.style ?? '';
      if (fixture.manifest.icon && rel === fixture.manifest.icon) return fixture.iconSvg ?? '';
      throw new Error(`插件 "${id}" 没有资源 "${rel}"`);
    },

    // 夹具的插件都没有 README（磁盘上确实没有那个文件），因此如实返回 null。
    // 详情页那条路径的覆盖留给将来真的需要它的测试 —— 一个"编造一份 README"的桩
    // 只会让测试更容易通过，而不是更可信。
    read_plugin_readme: () => null,

    plugin_storage_get: ({ id, key }) => {
      requireStorage(String(id));
      return bucket(String(id)).get(String(key)) ?? null;
    },

    plugin_storage_set: ({ id, key, value }) => {
      requireStorage(String(id));
      bucket(String(id)).set(String(key), String(value));
      return null;
    },

    plugin_storage_delete: ({ id, key }) => {
      requireStorage(String(id));
      bucket(String(id)).delete(String(key));
      return null;
    },

    plugin_storage_keys: ({ id }) => {
      requireStorage(String(id));
      return [...bucket(String(id)).keys()];
    },

    plugin_storage_clear: ({ id }) => {
      requireStorage(String(id));
      bucket(String(id)).clear();
      return null;
    },

    // 密钥存储（`ctx.secrets`）。夹具里是**明文**的一张表：这里要测的是"权限与调用
    // 形状对不对"，而不是密码学 —— 加解密由 `secrets.rs` 的单测对着真实 crypto
    // 覆盖（包括"解不开时抛错而不是返回 null"那条）。在桩里再造一套假的加密只会
    // 多一处会漂的副本。
    plugin_secrets_get: ({ id, key }) => {
      requireSecrets(String(id));
      return secretBucket(String(id)).get(String(key)) ?? null;
    },

    plugin_secrets_set: ({ id, key, value }) => {
      requireSecrets(String(id));
      secretBucket(String(id)).set(String(key), String(value));
      return null;
    },

    plugin_secrets_delete: ({ id, key }) => {
      requireSecrets(String(id));
      secretBucket(String(id)).delete(String(key));
      return null;
    },

    plugin_secrets_keys: ({ id }) => {
      requireSecrets(String(id));
      return [...secretBucket(String(id)).keys()];
    },

    plugin_secrets_clear: ({ id }) => {
      requireSecrets(String(id));
      secretBucket(String(id)).clear();
      return null;
    },

    // ------------------------------------------------------------
    // 剪贴板监测（`ctx.clipboard` 的订阅 / 读格式 / 读图片）
    // ------------------------------------------------------------
    //
    // 夹具**没有真实剪贴板**，因此这里的桩只回答两件可判定的事：权限对不对、
    // 调用形状对不对。真正的实现（Win32 轮询、隐私标记、64 KiB 截断、8 MiB 上限、
    // DIB 转换）在 `src-tauri/src/modules/plugins/clipboard.rs`，由那边的单测对着
    // 纯函数覆盖 —— 在桩里再造一套假的剪贴板只会多一处会漂的副本。
    //
    // `plugin_clipboard_can_monitor` 返回 `true`：夹具跑在开发机上，而这个值决定
    // 前端的 `ctx.clipboard.canMonitor()`。返回 `false` 会让所有剪贴板订阅在夹具里
    // 走降级分支，于是"订阅确实登记给了宿主"这件事根本没被测到。
    plugin_clipboard_can_monitor: () => true,

    /**
     * 与 Rust 侧 `clipboard::require_permission` 对齐。
     *
     * 与 `requireSecrets` 同一条纪律（桩后端必须如实拒绝），而这里的理由更直接：
     * 这一项读的是用户在这台机器上复制的**所有**内容，一个不检查权限的桩会让
     * 夹具测出"没声明也能订阅"，而那正是真实运行时不成立、也最不该成立的事。
     */
    plugin_clipboard_subscribe: ({ id }) => {
      requireClipboardMonitor(String(id));
      clipboardSubscribers.add(String(id));
      return null;
    },

    // 撤销**不检查权限**（与真实宿主一致）：一条撤不掉的订阅就是一个泄漏。
    plugin_clipboard_unsubscribe: ({ id }) => {
      clipboardSubscribers.delete(String(id));
      return null;
    },

    plugin_clipboard_formats: ({ id }) => {
      requireClipboardMonitor(String(id));
      return [];
    },

    // 夹具里"没有图片"是**唯一如实的答案**：这里没有剪贴板可读。
    // 返回一个编造的 data URL 会让夹具断言通过而真实环境不成立。
    plugin_clipboard_read_image: ({ id }) => {
      requireClipboardMonitor(String(id));
      return null;
    },

    // ------------------------------------------------------------
    // 全局热键（`ctx.hotkey`）
    // ------------------------------------------------------------
    //
    // 夹具里**没有真正的消息窗口、也没有系统热键名额**，因此这里不做任何注册 ——
    // 它只记两张表（每条组合归谁、谁订阅了），让夹具能断言"权限与调用形状对不对"。
    // 在桩里伪造一次注册会让夹具显示"热键装上了"，而那正是真实运行时唯一重要的
    // 那件事（用户按下去有没有反应）—— 伪造成立比不测更糟。
    //
    // `plugin_hotkey_can_register` 返回 `true`：夹具跑在开发机上，而这个值决定前端
    // 的 `ctx.hotkey.isAvailable()`。返回 `false` 会让所有热键调用在夹具里走降级
    // 分支，于是"注册确实交给了宿主"这件事根本没被测到（与剪贴板那条同一个理由）。
    plugin_hotkey_can_register: () => true,

    plugin_hotkey_register: ({ id, combo }) => {
      requireHotkey(String(id));
      const normalized = String(combo).trim().toLowerCase();
      hotkeys.set(normalized, String(id));
      return normalized;
    },

    // 解绑**不检查权限**（与真实宿主一致）：一条解不掉的绑定就是一个泄漏。
    plugin_hotkey_unregister: ({ id, combo }) => {
      const normalized = String(combo).trim().toLowerCase();
      // 只能解自己的 —— 与 `hotkey.rs` 的 `unregister` 同一条判据。
      if (hotkeys.get(normalized) === String(id)) hotkeys.delete(normalized);
      return null;
    },

    plugin_hotkey_list: ({ id }) =>
      [...hotkeys.entries()].filter(([, owner]) => owner === String(id)).map(([combo]) => combo),

    plugin_hotkey_subscribe: ({ id }) => {
      requireHotkey(String(id));
      hotkeySubscribers.add(String(id));
      return null;
    },

    plugin_hotkey_unsubscribe: ({ id }) => {
      hotkeySubscribers.delete(String(id));
      return null;
    },

    // ------------------------------------------------------------
    // 读取选中文本（`ctx.selection`）
    // ------------------------------------------------------------
    //
    // `plugin_selection_can_read` 返回 `false`，而这与上面那条**刻意相反**：
    // 这里没有前台窗口、没有真实剪贴板，一次捕获在夹具里**根本不可能成功** ——
    // 返回 `true` 会让夹具里的 `read()` 走进一条永远失败的路径，而那不是
    // "这项能力可用"的演示，只是一次必然而无意义的报错。返回 `false` 是夹具里
    // 唯一如实的答案（与 `plugin_clipboard_read_image` 返回 null 同一个理由）。
    plugin_selection_can_read: () => false,

    plugin_selection_read: ({ id }) => {
      requireSelection(String(id));
      // 权限判完仍然要说清"夹具里读不到"：返回 null 会被读成"用户没有选中东西"，
      // 而真实原因是这里没有可读的对象。
      throw new Error(
        '检查夹具里没有前台窗口与剪贴板，因此无法读取选中的文本（这不是权限问题）'
      );
    },

    /**
     * `ctx.ui.popover`（宿主渲染的结果卡片）。
     *
     * ============================================================
     * 返回值是 `{ action: null }`，而那是夹具里**唯一如实的答案**
     * ============================================================
     *
     * 卡片要一个真实的浮层窗口与一次真人点击才可能有非空的动作 id。夹具里两样
     * 都没有 —— 于是这里的正确行为就是契约里那个 `null`（"用户没回答"），
     * 而不是编一个按钮 id 出来。编出来的话，夹具会测到一个真实运行时永远不会
     * 出现的结果。
     *
     * 权限判定**必须照做**（与 `requireSecrets` 同一条纪律）：真实宿主把
     * `ui.popover` 判在 `notification` 上，而一个不检查的桩会让夹具替没声明
     * 权限的插件"成功显示"一张卡片。
     */
    plugin_ui_popover: ({ id }) => {
      requireNotification(String(id));
      return { action: null };
    },

    set_plugin_enabled: ({ id, enabled: next }) => {
      enabled.set(String(id), Boolean(next));
      return null;
    },

    uninstall_plugin: ({ id }) => {
      fixtures.delete(String(id));
      return null;
    },
  };

  const internals = (shim.window as Record<string, any>)['__TAURI_INTERNALS__'];
  internals.invoke = async (command: string, args: Record<string, any> = {}) => {
    backendCalls.push(command);
    const handler = handlers[command];
    if (!handler) throw new Error(`[plugin-host] 夹具没有为命令 "${command}" 打桩`);
    return handler(args);
  };

  const runtime = (await import('../../src/services/pluginRuntime.ts')) as Record<string, any>;
  const catalog = (await import('../../src/services/moduleCatalog.ts')) as Record<string, any>;
  const commands = (await import('../../src/services/commandRegistry.ts')) as Record<string, any>;

  return {
    shim,
    runtime,
    catalog,
    commands,
    fixtures,
    backendCalls,
    logs,
    clearLogs() {
      logs.info.length = 0;
      logs.warn.length = 0;
      logs.error.length = 0;
    },
    restoreConsole() {
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    },
    storageSnapshot() {
      const snapshot: Record<string, Record<string, string>> = {};
      for (const [pluginId, entries] of storage) snapshot[pluginId] = Object.fromEntries(entries);
      return snapshot;
    },
    clipboardSubscriptions() {
      return [...clipboardSubscribers].sort();
    },
    setEnabled(pluginId, next) {
      enabled.set(pluginId, next);
    },
    useOnly(pluginIds) {
      active = new Set(pluginIds);
    },
    useAll() {
      active = new Set(fixtures.keys());
    },
    overrideManifest(pluginId, manifest) {
      manifestOverrides.set(pluginId, manifest);
    },
    resetObservations() {
      shim.resetObservations();
      backendCalls.length = 0;
    },
  };
}

/** 全部夹具插件 ID（用来写「装 N 个插件」这类规模断言） */
export function fixtureIds(): string[] {
  return listFixtures().map((fixture) => fixture.id);
}
