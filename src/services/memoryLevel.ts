// src/services/memoryLevel.ts
//
// WebView2 内存目标等级的前端接线。
//
// ============================================================
// 为什么这套策略由前端驱动
// ============================================================
//
// 后端的大多数工作都由 Rust 发起，但**这一件不行**，原因是硬性的：
//
//   `with_webview`（把闭包投递到界面线程并等待执行完）只能在**事件循环之外**
//   的线程上调用。而 Rust 侧的窗口事件回调、托盘菜单回调都跑在事件循环线程上 ——
//   在那里调用它就是"事件循环等闭包、闭包等事件循环"，直接死锁。
//   同理 `Window::is_minimized()` 这类读取也经过事件循环，在事件回调里同样死锁。
//
// 于是 Rust 侧的窗口事件策略先天不可行。而前端本来就有一个恰好合适的信号：
// 窗口被最小化、被隐藏、被切到后台时，webview 都会收到 `visibilitychange`。
// 前端没有这个线程约束，一次 `invoke` 就是普通的后台调用。
//
// 额外的好处：托盘"隐藏到托盘"这个动作由 Rust 发起，但隐藏之后 webview 同样会
// 收到 `visibilitychange` —— 所以无论谁隐藏了窗口，这条策略都会生效，
// 不需要两处各写一遍。
//
// ============================================================
// 为什么只在「不可见」时降级，不在「失焦」时降
// ============================================================
//
// 失焦在桌面应用里太频繁了：用户切到浏览器查一句话、切到编辑器复制一段，
// 窗口仍在屏幕上、仍被看着，下一眼就要用。把"切走一下"当成"不再需要"，
// 换来的是**切回来时的卡顿**，而用户会把这归因成"这个软件很卡"。
//
// 判据因此只有一条：**文档是否可见**。
//
// ============================================================
// 为什么需要"先归零再重试"
// ============================================================
//
// 有一个真实存在的时序问题：应用**启动时是隐藏的**（Tauri 建窗 → 前端加载 →
// 窗口才显示）。那时第一次 `visibilitychange` 会报 hidden，于是我们套用 `Low`；
// 窗口显示后又报 visible，我们套用 `Normal`。这一来一回本身没问题，
// 但如果**第一次调用失败**（例如启动早期界面线程还在忙、投递超时），
// 我们就会停在一个错误的等级上再也不改。
//
// 因此失败时把 `appliedLevel` 归零。下一次任何可见性变化都会重新尝试，
// 而不是因为"上次已经设过 Low 了"而永久跳过。

import { invoke } from '@tauri-apps/api/core';

import { levelForVisibility, type MemoryLevel } from '../utils/memoryLevelPolicy';

export type { MemoryLevel };
export { levelForVisibility };

/** 已套用的等级。`null` 表示"不确定"（尚未套用或上次失败），下次事件必须重试。 */
let appliedLevel: MemoryLevel | null = null;

/** 是否已经装过可见性监听（幂等保护） */
let installed = false;

/** 这套 API 在当前环境是否可用；`null` = 还没探测过 */
let supportedCache: boolean | null = null;

/**
 * 探测当前环境是否支持内存目标等级。
 *
 * 需要 WebView2 Runtime ≥ 114。旧运行时上那个调用是**静默 no-op** ——
 * 不报错，也不生效。因此界面必须如实标注"当前运行时不支持"，
 * 而不是显示一个从未生效的开关。
 */
export async function isMemoryLevelSupported(): Promise<boolean> {
  if (supportedCache !== null) return supportedCache;
  try {
    supportedCache = await invoke<boolean>('webview_memory_level_supported');
  } catch {
    // 命令本身不可用（旧版应用 / 平台不支持）也归入"不支持"。
    supportedCache = false;
  }
  return supportedCache;
}

/**
 * 手动套用一个等级（设置 → 性能的验证入口）。
 *
 * 存在的用途是让用户能主动触发一次降级并立刻观察内存分页里的数字变化，
 * 而不必真的最小化窗口。自动策略出问题时也要靠它区分
 * "策略没触发"与"API 没生效"。
 */
export async function setMemoryLevel(level: MemoryLevel): Promise<boolean> {
  const applied = await invoke<boolean>('set_webview_memory_level', { level });
  appliedLevel = applied ? level : null;
  return applied;
}

/**
 * 按当前可见性套用等级。
 *
 * 已经处于目标等级时**不发请求** —— 可见性事件在窗口拖动、切换标签时可能连续触发，
 * 每次都走一次"投递到界面线程并等待"是没有意义的开销。
 */
async function syncToVisibility(): Promise<void> {
  const level = levelForVisibility(document.visibilityState === 'hidden');
  if (level === appliedLevel) return;

  try {
    const applied = await invoke<boolean>('apply_memory_level_for_visibility', {
      hidden: document.visibilityState === 'hidden',
    });

    if (applied) {
      appliedLevel = level;
      return;
    }

    // 返回 false = 运行时太旧，接口取不到。这不是错误，但也不能算"已套用"：
    // 记下来供界面标注，并把 appliedLevel 归零以免未来误以为自己设过了。
    supportedCache = false;
    appliedLevel = null;
  } catch (error) {
    // 失败时归零：下一次可见性变化会重试，而不是因为"上次设过"而永久跳过。
    // 这是启动早期最容易踩到的路径（界面线程还在忙，投递可能超时）。
    appliedLevel = null;
    console.warn('[memoryLevel] 套用内存目标等级失败，将在下次可见性变化时重试', error);
  }
}

/**
 * 装上可见性监听（幂等）。
 *
 * 在 `main.tsx` 里调用一次即可 —— 这条策略与界面是否挂载无关，
 * 它必须在整个应用生命周期里都生效。
 */
// ============================================================
// 回收工作集（与内存目标等级是两件不同的事，刻意放在一起驱动）
// ============================================================
//
// 两者共用同一个信号（`visibilitychange`），但做的事完全不同：
//
//   · 内存目标等级：让引擎**自己**把能放下的放下（丢缓存、换出内容）。
//     它降低的是引擎将来的分配，可逆、代价小。
//   · 回收工作集：把本进程树**当前驻留在物理内存里的页**交还系统。
//     它降低的是工作集这个数字，恢复时会有一次缺页。
//
// 因此后者必须比前者更保守。判据与 `memory_trim.rs` /
// `services/memoryTrim.ts` 的 `shouldAutoTrim` 一致：只在**真正不可见**时做。
//
// ============================================================
// 为什么要记住"上一次的可见性"
// ============================================================
//
// `visibilitychange` 在窗口拖动、切换标签时会连续触发，而回收工作集是**有代价**的
// （被换出的页要在下次访问时读回来）。若每次事件都回收一次，用户在窗口周围
// 点来点去时会反复触发缺页，表现就是"卡"。
//
// 因此只在**从可见变为不可见**的那一次做。这是一次状态迁移，不是一个状态。

/** 上一次观察到的文档可见性。`null` = 还没观察过。 */
let lastHidden: boolean | null = null;

/** 当前是否正在回收（防止重入） */
let trimming = false;

/** 是否在窗口隐藏时自动回收工作集。默认开启 —— 这是"隐藏后内存才降"的关键。 */
let autoTrimEnabled = true;

export function installMemoryLevelPolicy(): void {
  if (installed) return;
  installed = true;

  document.addEventListener('visibilitychange', () => {
    void syncToVisibility();
    void maybeTrimWorkingSet();
  });

  // 启动时先套一次：应用可能是在隐藏状态下启动的（自启动 + 静默启动），
  // 那时不会有 visibilitychange 事件。
  void syncToVisibility();
}

/**
 * 在"变为不可见"的那一次回收工作集（幂等）。
 *
 * 失败**只记日志**：回收不成功不影响任何功能，只是内存没降下来 ——
 * 把它变成一次界面报错会让"省内存失败"看起来像"功能坏了"。
 */
async function maybeTrimWorkingSet(): Promise<void> {
  const hidden = document.visibilityState === 'hidden';
  const wasHidden = lastHidden;
  lastHidden = hidden;

  // 从可见变为不可见才算一次迁移。`wasHidden === null`（首次观察）时如果已经是
  // hidden（应用在隐藏状态下启动），也算一次 —— 那时客户端确实不需要即时响应。
  const enteredHidden = hidden && wasHidden !== true;
  if (!enteredHidden) return;
  if (trimming) return;

  // 用户可能关掉了自动回收（设置 → 性能）。**默认开启**：这是用户抱怨的那个
  // 数字唯一真正会下降的地方。
  if (!autoTrimEnabled) return;

  trimming = true;
  try {
    const { trimMemoryNow } = await import('./memoryTrim');
    const outcome = await trimMemoryNow();
    if (outcome.supported) {
      console.info(
        `[memoryTrim] 窗口隐藏，已回收工作集：${outcome.trimmed}/${outcome.attempted} 个进程，` +
          `${outcome.beforeWorkingSet} → ${outcome.afterWorkingSet} 字节`
      );
    }
  } catch (error) {
    console.warn('[memoryTrim] 回收工作集失败（不影响功能，只是内存没降下来）', error);
  } finally {
    trimming = false;
  }
}

/**
 * 设置是否在窗口隐藏时自动回收工作集。
 *
 * 关掉它意味着隐藏窗口之后工作集不降 —— 用户可能是为了"切回来更快"而这么选，
 * 那是合理的取舍，因此这个开关存在，而不是写死。
 */
export function setAutoTrimEnabled(enabled: boolean): void {
  autoTrimEnabled = enabled;
}

export function isAutoTrimEnabled(): boolean {
  return autoTrimEnabled;
}
