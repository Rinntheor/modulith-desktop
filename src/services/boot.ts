// src/services/boot.ts
//
// 应用初始化（启动）系统。
//
// 这不是一个「假进度条」：每个步骤都真的做事，进度由**每个步骤上报的真实完成量**
// 按权重折算得出，没有任何 setTimeout 假推进。步骤之间是真实依赖顺序：
//
//   偏好设置 → 授权状态 → 模块管理器 → 插件运行时 → 资源预热
//
// 设计要点：
//   * 单例 + 缓存 Promise：React StrictMode 会把 effect 跑两遍，这里保证初始化只执行一次。
//   * 授权是一个**真实阶段**而不是副作用：未解锁时流程会在此处暂停（awaiting-auth），
//     解锁后从断点继续，而不是 `window.location.reload()` 整页重来。
//   * 每步声明 critical / 非 critical：关键步骤失败会中断并展示可重试的错误界面；
//     非关键步骤（插件、预热）失败只记警告，不阻塞进入应用。
//   * 失败后 retry() 会整体重跑；所有步骤都设计成幂等的（initialize 有 initialized 守卫、
//     插件重载会先清理、预热本身有缓存）。

import { getCachedSettings, loadAppSettings } from './appSettings';
import { getCachedAuth, getAuthStatus, subscribeAuth } from './authStore';
import { whenBackendReady } from './backendReady';
import { getCatalogFlatMap, getCatalogModules, getPluginModuleIds } from './moduleCatalog';
import { moduleManager } from './moduleManager';
import {
  announceSafeMode,
  getInstalledPlugins,
  getLoadStates,
  getSafeModeState,
  loadPluginsInBackground,
  reloadPluginRuntime,
} from './pluginRuntime';
import { computeBootProgress, type BootPhase, type BootStepStatus } from './bootProgress';
import { startPluginDevWatch } from './pluginDevWatch';
import { syncBackgroundPlugins } from './backgroundPlugins';
import { tryAutoLogin } from './auth';

export type { BootPhase, BootStepStatus };

// ============================================================
// 类型
// ============================================================

export interface BootStepState {
  id: string;
  label: string;
  status: BootStepStatus;
  /** 已完成的工作单元数 */
  unitsDone: number;
  /** 总工作单元数（0 表示不可细分） */
  unitsTotal: number;
  /** 面向用户的细节说明（例如「正在加载 xxx 插件」） */
  detail: string;
  /** 失败原因（仅 status === 'failed'） */
  error?: string;
  /** 该步骤耗时（毫秒），完成后才有值 */
  durationMs?: number;
}

export interface BootState {
  phase: BootPhase;
  steps: BootStepState[];
  currentStepId: string | null;
  /** 真实进度（0-100），未完成时不会到 100 */
  progress: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 非关键步骤的告警 */
  warnings: string[];
  /** 致命错误 */
  error: { stepId: string; message: string } | null;
}

/** 初始化完成后交给应用的启动数据 */
export interface BootResult {
  /** 设置里的默认模块 */
  defaultModule: string;
  /** 需要恢复的「上次打开」模块（未开启恢复时为 null） */
  lastModule: string | null;
  /** 实际需要打开的模块 = lastModule ?? defaultModule */
  initialModule: string;
  /** 启动时侧边栏是否折叠 */
  collapsed: boolean;
  /** 已就绪模块数 */
  moduleCount: number;
  /** 成功加载的插件数 */
  pluginCount: number;
  /** 已注册的插件模块数 */
  pluginModuleCount: number;
  warnings: string[];
  /** 整个初始化耗时（毫秒） */
  elapsedMs: number;
}

interface BootStepDefinition {
  id: string;
  label: string;
  /** 权重（相对值），用于把各步骤折算成总进度 */
  weight: number;
  /** 失败是否中断启动 */
  critical: boolean;
  run: (report: BootReporter, ctx: BootContext) => Promise<void>;
}

type BootReporter = (done: number, total: number, detail?: string) => void;

interface BootContext {
  /** 暂停流程直到用户完成解锁 */
  waitForUnlock: () => Promise<void>;
  /** 记录一条非致命告警 */
  warn: (message: string) => void;
}

// ============================================================
// 步骤定义
// ============================================================

const STEPS: BootStepDefinition[] = [
  {
    id: 'preferences',
    label: '读取应用设置',
    weight: 10,
    critical: true,
    run: async (report) => {
      report(0, 1, '正在读取 settings.json');
      const settings = await loadAppSettings();
      report(
        1,
        1,
        settings.defaultModule ? `默认模块：${settings.defaultModule}` : '使用内置默认模块'
      );
    },
  },
  {
    id: 'authorization',
    label: '检查访问授权',
    weight: 15,
    critical: true,
    run: async (report, ctx) => {
      report(0, 2, '正在读取授权状态');

      const status = await getAuthStatus();
      report(1, 2, status.initialized ? '已设置访问密钥' : '首次使用：需要创建访问密钥');

      /*
       * 「记住我」自动登录。
       *
       * `status.lockedByUser` 为真表示用户在本进程内主动点过「锁定」——
       * 此时**必须**重新输入访问密钥，不做自动登录。
       *
       * 这个判断放在前端只是提前短路（省一次 IPC）；真正的门闩在后端
       * `try_auto_login` 里，即使前端判断被绕过也进不去。
       */
      if (status.lockedByUser) {
        report(1, 2, '已锁定：需要输入访问密钥');
      } else if (!status.authenticated && status.initialized && status.autoLogin) {
        report(1, 2, '正在尝试「记住我」自动解锁');
        try {
          const response = await tryAutoLogin();
          if (response.success) {
            await getAuthStatus();
          } else if (response.securityInfo?.message) {
            ctx.warn(response.securityInfo.message);
          }
        } catch (error) {
          ctx.warn(`自动解锁失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const latest = getCachedAuth();
      if (latest && !latest.authenticated) {
        report(1, 2, '等待解锁…');
        await ctx.waitForUnlock();
      }

      report(2, 2, '已解锁');
    },
  },
  {
    id: 'modules',
    label: '初始化模块管理器',
    weight: 10,
    critical: true,
    run: async (report) => {
      report(0, 1, '正在读取模块偏好');
      await moduleManager.initialize();
      report(1, 1, `可用模块 ${moduleManager.getActiveModules().length} 个`);
    },
  },
  {
    id: 'plugins',
    label: '加载插件运行时',
    weight: 35,
    // 插件加载失败不应把用户挡在应用之外：插件本身是可选扩展
    critical: false,
    run: async (report, ctx) => {
      const settings = getCachedSettings();

      // ============================================================
      // 安全模式：插件一律不执行，但**清单照常同步**
      // ============================================================
      //
      // 宿主在上一次启动没有走干净时打开它（见 `pluginRuntime.ts` 的
      // `getSafeModeState` 与宿主侧 `modules/plugins/safe_mode.rs`）。
      //
      // 关键的一步是**仍然走 `listOnly`**：清单不取的话，「设置 → 插件」会是
      // 空的，于是用户既看不到那个坏插件、也无法禁用它 —— 那样安全模式就只是
      // 把用户关在一个更安静的房间里，不解决问题。
      //
      // `listOnly` 只构建目录与注入宿主 API，**不执行任何插件 bundle**，
      // 正是这里需要的东西。
      const safeMode = await getSafeModeState();
      if (safeMode.active) {
        try {
          await reloadPluginRuntime(undefined, {
            timeoutMs: settings.pluginLoadTimeoutMs,
            listOnly: true,
          });
        } catch (error) {
          ctx.warn(
            `安全模式下读取插件清单失败：${error instanceof Error ? error.message : String(error)}`
          );
        }

        const count = getInstalledPlugins().filter((p) => p.enabled).length;
        report(count, count, `安全模式：已跳过 ${count} 个插件的加载`);
        ctx.warn(`安全模式已启用，插件未被加载：${safeMode.reason ?? '原因未知'}`);

        // 开发模式自动重载**不启动**：它会在文件变化时重新加载插件运行时，
        // 而安全模式的前提正是"不要自动执行插件代码"。
        // 后台插件（`contributes.background`）同理不拉起。
        await announceSafeMode(safeMode.reason);
        return;
      }

      report(0, 0, '正在读取插件列表');

      // 后台加载：只拉取插件清单（构建目录、注入宿主 API），
      // 真正的 bundle 执行留到进入应用之后 —— 见下面对 defer 的说明。
      if (settings.deferPluginLoading) {
        try {
          await reloadPluginRuntime(undefined, {
            timeoutMs: settings.pluginLoadTimeoutMs,
            // 只同步到「拿到清单」为止：不执行任何插件 bundle
            listOnly: true,
          });
        } catch (error) {
          ctx.warn(
            `插件清单读取失败：${error instanceof Error ? error.message : String(error)}`
          );
          report(0, 0, '插件清单读取失败，已跳过');
          return;
        }

        const total = getInstalledPlugins().filter((p) => p.enabled).length;
        report(
          total,
          total,
          total === 0
            ? '没有已启用的插件'
            : `${total} 个插件将在进入应用后于后台加载`
        );

        // 真正的加载：不 await，启动流程立即继续。
        // 每完成一个插件都会通过 moduleCatalog 的通知实时出现在侧边栏。
        //
        // 开发模式自动重载在它**跑完之后**再启动 —— 那时 `installed` 才填好，
        // `devPluginIds()` 才有东西可答。放早了会看到空列表，于是监听根本没起来。
        void loadPluginsInBackground({ timeoutMs: settings.pluginLoadTimeoutMs }).finally(() => {
          startPluginDevWatch();
          // 清单已经在手，现在可以判断"哪些后台插件该跑"了。
          // 放在这里而不是启动更早的地方：那一刻插件列表可能还是空的，
          // 而"该起的没起"会表现成一次随机失败。
          void startBackgroundPlugins();
        });
        return;
      }

      try {
        await reloadPluginRuntime(
          (done, total, detail) => {
            report(done, total, detail ?? '');
          },
          { timeoutMs: settings.pluginLoadTimeoutMs }
        );
      } catch (error) {
        ctx.warn(`插件加载失败：${error instanceof Error ? error.message : String(error)}`);
        report(0, 0, '插件加载失败，已跳过');
      }

      // 开发模式自动重载：清单已在手，可以判断有没有开发链接的插件了。
      // 没有的话它什么都不做（连定时器都不建）—— 见 `startPluginDevWatch`。
      startPluginDevWatch();

      // 拉起清单里声明了 `onStartup` 的后台插件。失败只记警告 ——
      // 一个后台插件起不来不该把用户挡在应用之外。
      void startBackgroundPlugins();
    },
  },
  {
    id: 'preload',
    label: '预热资源与模块',
    weight: 30,
    critical: false,
    run: async (report, ctx) => {
      const targets: Array<{ label: string; run: () => Promise<unknown> }> = [
        {
          label: '图标映射表',
          run: () => import('../generated/iconMap'),
        },
      ];

      // 预热即将打开的模块：避免进入首页时再出现一次 loading
      const initial = resolveInitialModule();
      const descriptor = getCatalogFlatMap().get(initial);
      const preload = (descriptor?.component as { preload?: () => Promise<unknown> } | undefined)
        ?.preload;

      if (descriptor && typeof preload === 'function') {
        targets.push({
          label: `模块「${descriptor.name}」`,
          run: () => preload(),
        });
      }

      let done = 0;
      for (const target of targets) {
        try {
          await target.run();
          done += 1;
          report(done, targets.length, target.label);
        } catch (error) {
          // 预热失败不影响功能（真正打开时会重新加载），只记警告
          done += 1;
          report(done, targets.length, `${target.label} 预热失败`);
          ctx.warn(`预热失败：${target.label}`);
        }
      }
    },
  },
];

/** 步骤权重（与 STEPS 一一对应，供纯函数计算进度） */
const STEP_WEIGHTS = STEPS.map((step) => step.weight);

/** 计算「启动后应该打开哪个模块」 */
export function resolveInitialModule(): string {
  const settings = getCachedSettings();
  const firstVisible =
    getCatalogModules().find((m) => m.visible !== false && !m.disabled)?.id ?? '';

  if (settings.restoreLastModule && settings.lastModule) return settings.lastModule;
  return settings.defaultModule ?? firstVisible;
}

// ============================================================
// 状态
// ============================================================

function initialState(): BootState {
  return {
    phase: 'idle',
    steps: STEPS.map((step) => ({
      id: step.id,
      label: step.label,
      status: 'pending' as BootStepStatus,
      unitsDone: 0,
      unitsTotal: 0,
      detail: '',
    })),
    currentStepId: null,
    progress: 0,
    startedAt: null,
    finishedAt: null,
    warnings: [],
    error: null,
  };
}

// ============================================================
// 管理器
// ============================================================

class BootManager {
  private state: BootState = initialState();
  private listeners = new Set<() => void>();
  private runPromise: Promise<BootState> | null = null;
  private result: BootResult | null = null;

  /** 授权订阅（整个生命周期只订阅一次） */
  private authUnsubscribe: (() => void) | null = null;

  /** 当前是否已确认解锁 */
  private unlocked = false;

  /**
   * 流程挂起点：设置后，下一次 authStore 报告「已解锁」时会调用它。
   * 同时用于两种场景——初始化途中的等待，以及启动完成后被重新锁定。
   */
  private authResume: (() => void) | null = null;

  // ---------- 订阅 ----------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): BootState {
    return this.state;
  }

  getResult(): BootResult | null {
    return this.result;
  }

  private setState(patch: Partial<BootState>): void {
    this.state = { ...this.state, ...patch, progress: this.computeProgress({ ...this.state, ...patch }) };
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch (error) {
        console.error('[boot] 订阅者执行出错:', error);
      }
    });
  }

  // ---------- 进度 ----------

  /**
   * 真实进度：委托给纯函数 computeBootProgress（见 bootProgress.ts），
   * 由各步骤上报的真实完成量按权重折算，没有任何基于时间的模拟。
   */
  private computeProgress(state: BootState): number {
    return computeBootProgress(state.steps, STEP_WEIGHTS, state.phase);
  }

  // ---------- 授权联动 ----------

  private ensureAuthSubscription(): void {
    if (this.authUnsubscribe) return;

    this.authUnsubscribe = subscribeAuth(() => {
      const status = getCachedAuth();
      if (!status) return;

      this.unlocked = status.authenticated;

      if (status.authenticated) {
        // 解锁：执行挂起的续跑动作。
        // 注意阶段切换由「续跑动作」自己决定——初始化途中暂停要回到 running，
        // 而「启动完成后被重新锁定」则应该直接回到 ready，
        // 不能统一在这里设成 running（那会让已完成的流程卡在加载界面）。
        const resume = this.authResume;
        this.authResume = null;
        resume?.();
        return;
      }

      // 被锁定：若初始化已经完成，则退回解锁界面；
      // 重新解锁时直接回到应用，不必重跑整个初始化（插件资源仍在页面上）。
      if (this.state.phase === 'ready') {
        this.setState({ phase: 'awaiting-auth' });
        this.authResume = () => this.setState({ phase: 'ready' });
      }
    });
  }

  private waitForUnlock(): Promise<void> {
    if (this.unlocked) return Promise.resolve();

    this.setState({ phase: 'awaiting-auth' });

    return new Promise<void>((resolve) => {
      // 赋值与判断之间没有 await，不存在竞态窗口
      if (this.unlocked) {
        resolve();
        return;
      }
      this.authResume = () => {
        this.setState({ phase: 'running' });
        resolve();
      };
    });
  }

  // ---------- 执行 ----------

  /** 启动初始化；重复调用返回同一个 Promise（StrictMode 安全） */
  start(): Promise<BootState> {
    if (this.runPromise) return this.runPromise;

    this.ensureAuthSubscription();
    this.runPromise = this.run();
    return this.runPromise;
  }

  /** 失败后重试：整体重跑（所有步骤都是幂等的） */
  retry(): Promise<BootState> {
    this.runPromise = null;
    this.state = initialState();
    return this.start();
  }

  private async run(): Promise<BootState> {
    this.setState({
      phase: 'running',
      startedAt: null,
      finishedAt: null,
      error: null,
      warnings: [],
      steps: initialState().steps,
      currentStepId: null,
    });

    /*
     * 后端就绪闸门 —— **启动流程的第一件事**。
     *
     * 发行版冷启动时，主窗口由 Tauri 在创建阶段就建好并开始加载前端资源，而模块
     * 状态是在 Rust `setup` 钩子里注入的，两者之间没有任何同步：打包产物的实测
     * 日志显示 webview 已经在取资源时，状态注入还晚 25–39ms。落在窗口里的 invoke
     * 会以 "state not managed" 失败 —— 第一步与第二步都落在里面，而第二步是关键
     * 步骤，于是用户看到「初始化中断」，点重试才能进。
     *
     * 闸门在这里等，而不是给 `get_auth_status` 单独加重试：同一窗口里还有几个被
     * `catch` 吞掉的失败（读设置回落默认值等），理由与取舍见 `backendReady.ts`。
     *
     * 它**永不 reject**，因此这里不需要 try/catch；超时也会放行，让第一步如实
     * 报错。计时从闸门放行之后开始：那段等待是后端初始化时间，把它算进"读取应用
     * 设置"的耗时只会让启动性能数据失真。
     */
    await whenBackendReady();

    const startedAt = Date.now();
    this.setState({ startedAt });

    for (let index = 0; index < STEPS.length; index += 1) {
      const definition = STEPS[index];
      const stepStartedAt = Date.now();

      this.updateStep(index, { status: 'running', detail: '', error: undefined });
      this.setState({ currentStepId: definition.id });

      const report: BootReporter = (done, total, detail) => {
        this.updateStep(index, {
          unitsDone: done,
          unitsTotal: total,
          detail: detail ?? this.state.steps[index].detail,
        });
      };

      const ctx: BootContext = {
        waitForUnlock: () => this.waitForUnlock(),
        warn: (message) => {
          this.setState({ warnings: [...this.state.warnings, message] });
        },
      };

      try {
        await definition.run(report, ctx);

        // 等待解锁期间被中断的步骤，恢复后 phase 需要回到 running
        if (this.state.phase === 'awaiting-auth') {
          this.setState({ phase: 'running' });
        }

        this.updateStep(index, {
          status: 'done',
          durationMs: Date.now() - stepStartedAt,
          unitsTotal: Math.max(1, this.state.steps[index].unitsTotal),
          unitsDone: Math.max(1, this.state.steps[index].unitsTotal),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateStep(index, {
          status: 'failed',
          error: message,
          durationMs: Date.now() - stepStartedAt,
        });

        if (definition.critical) {
          this.setState({
            phase: 'failed',
            currentStepId: definition.id,
            finishedAt: Date.now(),
            error: { stepId: definition.id, message },
          });
          console.error(`[boot] 关键步骤「${definition.label}」失败:`, error);
          return this.state;
        }

        this.setState({ warnings: [...this.state.warnings, `${definition.label}失败：${message}`] });
        console.warn(`[boot] 非关键步骤「${definition.label}」失败:`, error);
      }
    }

    const finishedAt = Date.now();
    const pluginStates = this.collectStats();

    this.result = {
      defaultModule: this.resultDefaultModule(),
      lastModule: this.resultLastModule(),
      initialModule: resolveInitialModule(),
      collapsed: getCachedSettings().sidebarCollapsed,
      moduleCount: moduleManager.getActiveModules().length,
      pluginCount: pluginStates.pluginCount,
      pluginModuleCount: pluginStates.pluginModuleCount,
      warnings: this.state.warnings,
      elapsedMs: finishedAt - startedAt,
    };

    this.setState({
      phase: 'ready',
      currentStepId: null,
      finishedAt,
    });

    return this.state;
  }

  private resultDefaultModule(): string {
    const settings = getCachedSettings();
    const firstVisible =
      getCatalogModules().find((m) => m.visible !== false && !m.disabled)?.id ?? '';
    return settings.defaultModule ?? firstVisible;
  }

  private resultLastModule(): string | null {
    const settings = getCachedSettings();
    return settings.restoreLastModule ? settings.lastModule : null;
  }

  /** 统计插件加载结果（真实数据，来自运行时状态） */
  private collectStats(): { pluginCount: number; pluginModuleCount: number } {
    try {
      const loadStates = getLoadStates();
      const loaded = getInstalledPlugins().filter(
        (plugin) => plugin.enabled && loadStates.get(plugin.id)?.status === 'loaded'
      );
      const moduleCount = loaded.reduce(
        (sum, plugin) => sum + getPluginModuleIds(plugin.id).length,
        0
      );
      return { pluginCount: loaded.length, pluginModuleCount: moduleCount };
    } catch (error) {
      console.warn('[boot] 统计插件信息失败:', error);
      return { pluginCount: 0, pluginModuleCount: 0 };
    }
  }

  private updateStep(index: number, patch: Partial<BootStepState>): void {
    const steps = this.state.steps.map((step, i) => (i === index ? { ...step, ...patch } : step));
    this.setState({ steps });
  }
}

/**
 * 拉起清单里声明了 `onStartup` 的后台插件。
 *
 * ============================================================
 * 为什么它**永不抛错**
 * ============================================================
 *
 * 后台插件需要一个用户自己安装的 Node 运行时（应用不随包分发它）。也就是说
 * "没有 Node" 是一个**正常状态**，而不是异常 —— 绝大多数用户第一次装这个应用
 * 时就是那样。
 *
 * 因此这里把失败降级成一条警告：后台功能明确不可用，而应用照常可用。
 * 让一个可选能力把用户挡在启动界面之外，是这里最不该发生的事。
 *
 * 状态不在这里缓存：要显示"哪个后台插件在跑"的地方各自调
 * `backgroundPluginStatus()`（见插件详情）。多存一份必然漂。
 */
async function startBackgroundPlugins(): Promise<void> {
  try {
    const started = await syncBackgroundPlugins();

    if (started.length > 0) {
      console.info(`[boot] 后台插件已就绪：${started.map((item) => item.id).join('、')}`);
    }

    // 降级运行**必须说出来**。`isolated: false` 意味着 Node 的 `--permission`
    // 那一层不存在，只剩 `vm` —— 而 `vm` 不是安全边界（实测一行就能出去）。
    const degraded = started.filter((item) => item.running && !item.isolated);
    if (degraded.length > 0) {
      console.warn(
        `[boot] 这些后台插件在**没有引擎级权限**的情况下运行（Node 版本偏低）：` +
          degraded.map((item) => item.id).join('、')
      );
    }

    // **网络那一项要单独说。** `isolated: true` 只说明权限模型开着，而它管不管
    // 得住网络取决于那个 Node 有没有 `--allow-net` 这个 scope —— 那是版本相关的，
    // 本机 Node 24 就没有，实测网络完全不受管。
    //
    // 合成一句"已隔离"会让用户以为插件连不上网。这两件事分开说。
    const netOpen = started.filter((item) => item.running && !item.netRestricted);
    if (netOpen.length > 0) {
      console.warn(
        `[boot] 这些后台插件的**网络不受管**（当前 Node 的权限模型没有网络那一项）：` +
          `${netOpen.map((item) => item.id).join('、')}。` +
          '它们的 ctx.http 仍然每次判权限，但可以直接 fetch / net.connect 外连。'
      );
    }
  } catch (error) {
    console.warn(
      '[boot] 后台插件未能启动（多半是没有可用的 Node 运行时）：',
      error instanceof Error ? error.message : error
    );
  }
}

/** 全局单例 */
export const bootManager = new BootManager();

/** 同步读取启动结果（BootGate 就绪后保证非空） */
export function getBootResult(): BootResult | null {
  return bootManager.getResult();
}

// ============================================================
// React 订阅辅助
// ============================================================

export function subscribeBoot(listener: () => void): () => void {
  return bootManager.subscribe(listener);
}

export function getBootState(): BootState {
  return bootManager.getState();
}
