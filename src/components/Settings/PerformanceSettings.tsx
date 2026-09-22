// src/components/Settings/PerformanceSettings.tsx
//
// 「性能」分页：把内存占用拆开给用户看，并给出界面侧的几个计数。
//
// ============================================================
// 这一页为什么存在
// ============================================================
//
// 「内存占用高」这个反馈在没有数字之前无法处理：分不清 300 MB 是 WebView2 的
// 固有基线、还是我们自己泄漏出来的，也无法证明任何一次优化真的生效。
// 任务管理器只能给出一个总数，而且**分不清哪些 msedgewebview2 属于哪个应用**。
//
// 这一页把三件事分开呈现：
//   1. **进程明细**：按角色（宿主 / 浏览器主 / 渲染 / GPU / 工具）列出，按私有内存降序。
//      用户能立刻看出"大头在渲染进程"还是"GPU 进程占得多"。
//   2. **界面侧计数**：已挂载标签数、模块组件缓存条目数、DOM 节点数、JS 堆。
//      这些是**我们自己能控制的部分**，也是验收"关闭标签是否真的释放"的地方。
//   3. **口径说明**：私有内存与工作集的区别、"为什么进程多不代表有问题"。
//      不给说明的话，用户会把引擎的固有结构当成缺陷。
//
// ============================================================
// 采样为什么是低频 + 可见才跑
// ============================================================
//
// 排查内存问题的工具不该自己制造负担：`OpenProcess` + `GetProcessMemoryInfo`
// 对每个进程各一次系统调用，遍历一次是几十次调用。因此：
//   · 只在**这一页可见时**采样（组件挂载即这一页被选中）；
//   · 3 秒一次，不是每帧；
//   · 页面不可见（窗口最小化 / 隐藏到托盘）时**停止采样** ——
//     那正是最需要看空闲回落的时候，每秒几十次系统调用会把回落本身搅乱。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

import {
  PROCESS_KIND_HINTS,
  PROCESS_KIND_LABELS,
  getMemorySnapshot,
  type MemorySnapshot,
  type ProcessKind,
} from '../../services/processMemory';
import {
  isMemoryLevelSupported,
  isAutoTrimEnabled,
  levelForVisibility,
  setAutoTrimEnabled,
  setMemoryLevel,
  type MemoryLevel,
} from '../../services/memoryLevel';
import {
  isTrimSupported,
  trimMemoryNow,
  type TrimOutcome,
} from '../../services/memoryTrim';
import { cachedModuleCount } from '../../services/moduleComponentCache';
import { getEvictionCount, getTabState } from '../../services/tabStore';
/** 采样间隔。3 秒足以看出趋势，又不会让面板自己成为负载。 */
const SAMPLE_INTERVAL_MS = 3000;

/**
 * 内存口径的格式化。
 *
 * 不用 `utils/format.ts` 的 `formatBytes`：那个函数按设计**只到 MB**（它服务的是
 * 插件包与 README 的大小），而内存会到 GB。而且它对 `0` 返回"未知" ——
 * 这里"确实是 0"是有意义的（例如没有崩溃处理进程），不该显示成未知。
 */
function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  return `${Math.round(mb)} MB`;
}

/**
 * 界面侧计数。
 *
 * 这些数字的作用是**把"应当下降"变成可观测的事实**：关闭一个标签之后，
 * 挂载数应当下降、组件缓存条目数应当下降、DOM 节点数应当下降。
 * 此前没有任何统一入口能同时看到它们，因此"关闭标签到底有没有释放"只能靠推断。
 */
interface FrontendCounters {
  mountedTabs: number;
  openTabs: number;
  cachedComponents: number;
  domNodes: number;
  /** 本次运行内因长时间未使用被回收的标签数 */
  evictedTabs: number;
  /** JS 堆字节数。**只有 Chromium 系提供**，取不到时为 null（不编一个值） */
  jsHeapBytes: number | null;
}

function readFrontendCounters(): FrontendCounters {
  const tabs = getTabState();

  // `performance.memory` 是 Chromium 的私有扩展，不在标准里，
  // 因此类型上是可选的、运行时也可能缺失。
  const withMemory = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const heap = withMemory.memory?.usedJSHeapSize;

  return {
    mountedTabs: tabs.mountedTabs.length,
    openTabs: tabs.openTabs.length + tabs.splitTabs.length,
    cachedComponents: cachedModuleCount(),
    domNodes: document.querySelectorAll('*').length,
    evictedTabs: getEvictionCount(),
    jsHeapBytes: typeof heap === 'number' && Number.isFinite(heap) ? heap : null,
  };
}

/** 每一类进程的内存合计，用于占比条 */
function totalsByKind(snapshot: MemorySnapshot): Array<{ kind: ProcessKind; bytes: number; count: number }> {
  const map = new Map<ProcessKind, { bytes: number; count: number }>();
  for (const process of snapshot.processes) {
    const current = map.get(process.kind) ?? { bytes: 0, count: 0 };
    current.bytes += process.privateBytes;
    current.count += 1;
    map.set(process.kind, current);
  }
  return [...map.entries()]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * 占比条的配色。
 *
 * 只有**渲染进程**用强调色：那是唯一由我们的前端决定大小的进程，
 * 其余用中性灰。把引擎固有的进程也涂成重点色，会让用户去优化他改不了的东西。
 */
const KIND_BAR_COLOR: Record<ProcessKind, string> = {
  renderer: 'bg-[var(--accent-600,#4f46e5)]',
  browser: 'bg-gray-400',
  gpu: 'bg-gray-400',
  utility: 'bg-gray-300',
  crashpad: 'bg-gray-200',
  host: 'bg-gray-500',
  unknown: 'bg-gray-200',
};

const PerformanceSettings: React.FC = () => {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [counters, setCounters] = useState<FrontendCounters | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /** 降级策略：环境是否支持，以及上一次手动操作的结果 */
  const [levelSupported, setLevelSupported] = useState<boolean | null>(null);
  const [levelResult, setLevelResult] = useState('');
  const [levelBusy, setLevelBusy] = useState(false);

  /** 回收工作集：环境是否支持、上一次的结果、是否自动回收 */
  const [trimSupported, setTrimSupported] = useState<boolean | null>(null);
  const [trimOutcome, setTrimOutcome] = useState<TrimOutcome | null>(null);
  const [trimBusy, setTrimBusy] = useState(false);
  const [autoTrim, setAutoTrim] = useState(isAutoTrimEnabled());

  /** 防止采样重叠：后端那次调用比一次 tick 慢时，不能让请求堆起来 */
  const inFlight = useRef(false);

  useEffect(() => {
    void isMemoryLevelSupported().then(setLevelSupported);
    void isTrimSupported().then(setTrimSupported);
  }, []);

  /**
   * 手动回收一次，并把"回收前 → 回收后"的数字显示出来。
   *
   * 刻意**顺手再采一次快照**：回收会改变上面那个合计，而如果不同步刷新，
   * 用户会看到"本应用的内存占用"与"回收结果"这两个数字互相矛盾。
   */
  const runTrim = useCallback(async () => {
    setTrimBusy(true);
    try {
      const outcome = await trimMemoryNow();
      setTrimOutcome(outcome);
      if (!outcome.supported) setTrimSupported(false);
      setSnapshot(await getMemorySnapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrimBusy(false);
    }
  }, []);

  const manualLevel = useCallback(async (level: MemoryLevel) => {
    setLevelBusy(true);
    setLevelResult('');
    try {
      const applied = await setMemoryLevel(level);
      setLevelResult(
        applied
          ? `已套用「${level === 'low' ? '省内存' : '全速'}」。效果会在上方数字里体现（下一次采样）。`
          : '当前 WebView2 运行时不支持这个设置，调用没有生效。'
      );
      if (!applied) setLevelSupported(false);
    } catch (err) {
      setLevelResult(err instanceof Error ? err.message : String(err));
    } finally {
      setLevelBusy(false);
    }
  }, []);

  const sample = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      // 两者互不依赖，可以并发；界面计数是同步的，放一起只是为了同一帧的值。
      const next = await getMemorySnapshot();
      setSnapshot(next);
      setCounters(readFrontendCounters());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void sample();

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        // 窗口不可见时停止采样：那正是最需要观察"空闲回落"的时刻，
        // 而这个面板自己的系统调用会干扰那个回落。
        if (document.visibilityState === 'visible') void sample();
      }, SAMPLE_INTERVAL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void sample();
        start();
      } else {
        stop();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sample]);

  const byKind = useMemo(() => (snapshot ? totalsByKind(snapshot) : []), [snapshot]);

  const hasProcesses = snapshot !== null && snapshot.processes.length > 0;

  return (
    <div className="px-4 lg:px-6 py-5">
      {/* ── 合计 ───────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <div className="flex items-center justify-between gap-4 pt-3">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            本应用的内存占用
          </h3>
          <button
            type="button"
            onClick={() => void sample()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>

        {error && (
          <p className="py-3 flex items-start gap-1.5 text-[11px] text-red-600 break-words">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            读取失败：{error}
          </p>
        )}

        {!snapshot && !error && <p className="py-4 text-[11px] text-gray-400">（采样中…）</p>}

        {snapshot && !snapshot.supported && (
          <p className="py-3 text-[11px] text-gray-500 leading-relaxed">
            当前平台不支持按进程树统计内存。这一页只在 Windows 上给出进程明细 ——
            与其给一个近似值，不如明确说"这里没有数据"。
          </p>
        )}

        {snapshot && snapshot.supported && (
          <>
            <div className="grid grid-cols-3 gap-4 py-3">
              <div>
                <p className="text-[11px] text-gray-500">私有内存合计</p>
                <p className="mt-0.5 text-lg font-semibold text-gray-800 tabular-nums">
                  {formatMemory(snapshot.totalPrivateBytes)}
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">与任务管理器"内存"列同口径</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-500">工作集合计</p>
                <p className="mt-0.5 text-lg font-semibold text-gray-800 tabular-nums">
                  {formatMemory(snapshot.totalWorkingSet)}
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">物理内存中驻留的部分</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-500">进程数</p>
                <p className="mt-0.5 text-lg font-semibold text-gray-800 tabular-nums">
                  {snapshot.processes.length}
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">含宿主进程本身</p>
              </div>
            </div>

            {/* 占比条：一眼看出大头在哪一类 */}
            {byKind.length > 1 && (
              <div className="pb-3">
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100">
                  {byKind.map((entry) => (
                    <div
                      key={entry.kind}
                      className={KIND_BAR_COLOR[entry.kind]}
                      style={{
                        width: `${Math.max(
                          1,
                          (entry.bytes / Math.max(1, snapshot.totalPrivateBytes)) * 100
                        )}%`,
                      }}
                      title={`${PROCESS_KIND_LABELS[entry.kind]} · ${formatMemory(entry.bytes)}`}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {snapshot?.unreadable ? (
          <p className="pb-3 text-[11px] text-amber-600">
            有 {snapshot.unreadable} 个进程读不到内存（权限不足），因此上面的合计偏小。
          </p>
        ) : null}
      </section>

      {/* ── 进程明细 ───────────────────────────────────────── */}
      {hasProcesses && (
        <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider pt-3 pb-2">
            进程明细
          </h3>

          <div className="divide-y divide-gray-100">
            {snapshot!.processes.map((process) => (
              <div key={process.pid} className="flex items-start justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800">
                    {PROCESS_KIND_LABELS[process.kind]}
                    <span className="ml-2 text-[11px] font-normal text-gray-400 tabular-nums">
                      PID {process.pid}
                    </span>
                  </p>
                  {PROCESS_KIND_HINTS[process.kind] && (
                    <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                      {PROCESS_KIND_HINTS[process.kind]}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium text-gray-800 tabular-nums">
                    {formatMemory(process.privateBytes)}
                  </p>
                  <p className="text-[11px] text-gray-400 tabular-nums">
                    工作集 {formatMemory(process.workingSet)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 界面侧计数 ─────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider pt-3 pb-2">
          界面侧
        </h3>

        {counters ? (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 py-2">
              <Counter
                label="已挂载标签"
                value={String(counters.mountedTabs)}
                hint={`打开着 ${counters.openTabs} 个。关闭标签后这个数字必须下降`}
              />
              <Counter
                label="组件缓存条目"
                value={String(counters.cachedComponents)}
                hint="应当等于已挂载标签数；更大就说明有标签没被释放"
              />
              <Counter label="DOM 节点" value={counters.domNodes.toLocaleString()} />
              <Counter
                label="JS 堆"
                value={counters.jsHeapBytes === null ? '不可用' : formatMemory(counters.jsHeapBytes)}
                hint={counters.jsHeapBytes === null ? '本渲染引擎不提供该数据' : undefined}
              />
              <Counter
                label="已回收标签"
                value={String(counters.evictedTabs)}
                hint="本次运行内因长时间未使用被回收的标签数"
              />
            </div>

            <p className="pb-3 pt-1 text-[11px] text-gray-400 leading-relaxed">
              「已挂载标签」与「组件缓存条目」是同一件事的两个侧面：标签保活意味着
              <strong className="font-medium">切走不卸载</strong>，但
              <strong className="font-medium">关闭必须卸载</strong>
              。两者数字长期不相等，就说明有面板
              与它的组件缓存没有随关闭一起释放。
              <br />
              达到标签上限时，<strong className="font-medium">最久没看过的标签</strong>
              {' '}会被回收以腾出位置（正在显示、置顶与收藏的不会被回收）。
              「已回收标签」就是这件事发生过的次数。
            </p>
          </>
        ) : (
          <p className="py-4 text-[11px] text-gray-400">（采样中…）</p>
        )}
      </section>

      {/* ── 降级策略 ───────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider pt-3 pb-2">
          空闲时的降级
        </h3>

        <div className="flex items-start justify-between gap-4 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800">
              {levelSupported === null
                ? '正在检测…'
                : levelSupported
                  ? '已启用：窗口不可见时降低内存占用'
                  : '当前环境不支持'}
            </p>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              {levelSupported === false
                ? '需要 WebView2 运行时 114 或更高版本。这个设置在当前环境里不会生效 —— 与其显示一个假的开关，不如直说。'
                : '窗口被最小化、隐藏到托盘或切到后台时，渲染引擎会把缓存内容丢弃或换出到磁盘；重新可见时恢复全速。'}
              <br />
              <span className="text-gray-400">
                判据只有「窗口是否可见」。<strong className="font-medium">切到别的窗口不算</strong>
                {' '}—— 那时你还在用，降级只会让切回来变卡。
              </span>
            </p>
          </div>
          <div className="shrink-0 pt-0.5 text-right">
            <p className="text-[11px] text-gray-400">
              当前：{levelForVisibility(document.visibilityState === 'hidden') === 'low' ? '省内存' : '全速'}
            </p>
          </div>
        </div>

        {levelSupported !== false && (
          <div className="flex items-center gap-2 pb-3 pt-1">
            {/* 这里的两个按钮不判断 levelSupported：外层已经排除了 false 的情况，
                再判一次会被 TypeScript 判成"永远为假"的比较（而且它确实永远为假）。
                注意别在 JSX 注释里写 Markdown 粗体的字面写法 —— 那条门禁
                （check:markdown）查的是整行文本，注释块它不认。 */}
            <button
              type="button"
              onClick={() => void manualLevel('low')}
              disabled={levelBusy}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              立即降级试一次
            </button>
            <button
              type="button"
              onClick={() => void manualLevel('normal')}
              disabled={levelBusy}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              恢复全速
            </button>
          </div>
        )}

        {levelResult && (
          <p className="pb-3 text-[11px] text-gray-500 leading-relaxed">{levelResult}</p>
        )}
      </section>

      {/* ── 回收工作集 ─────────────────────────────────────── */}
      {/*
        这一节回答的是「隐藏到托盘之后内存到底降了没有」。

        它必须同时显示私有内存与工作集两个口径，否则用户会得出错误结论：
        只显示私有内存，这个功能看起来完全无效（因为它确实不降低那个数字）；
        只显示工作集，又与任务管理器里看到的对不上。两个一起给，用户才能自己确认。
      */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider pt-3 pb-2">
          回收工作集
        </h3>

        <div className="flex items-start justify-between gap-4 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800">
              {trimSupported === null
                ? '正在检测…'
                : trimSupported
                  ? '可用：把本应用占用的物理内存交还系统'
                  : '当前平台不支持'}
            </p>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              它把本应用全部进程当前
              <strong className="font-medium">驻留在物理内存里的页</strong>
              交还系统。
              <br />
              <span className="text-gray-400">
                代价是这些页要在下次访问时从页面文件读回来 —— 对正被看着的窗口会表现为
                「点一下卡半拍」，因此只在窗口不可见时才自动做。
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 pb-2">
          <button
            type="button"
            onClick={() => void runTrim()}
            disabled={trimBusy || trimSupported === false}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {trimBusy ? '回收中…' : '立即回收一次'}
          </button>
          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoTrim}
              onChange={(e) => {
                setAutoTrimEnabled(e.target.checked);
                setAutoTrim(e.target.checked);
              }}
              className="rounded border-gray-300"
            />
            窗口隐藏时自动回收
          </label>
        </div>

        {trimOutcome && (
          <div className="pb-3">
            <div className="grid grid-cols-2 gap-4 py-2">
              <div>
                <p className="text-[11px] text-gray-500">工作集</p>
                <p className="mt-0.5 text-sm font-medium text-gray-800 tabular-nums">
                  {formatMemory(trimOutcome.beforeWorkingSet)}
                  <span className="mx-1 text-gray-400">→</span>
                  <span
                    className={
                      trimOutcome.afterWorkingSet <= trimOutcome.beforeWorkingSet
                        ? 'text-emerald-600'
                        : 'text-amber-600'
                    }
                  >
                    {formatMemory(trimOutcome.afterWorkingSet)}
                  </span>
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {describeFreed(trimOutcome)}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-gray-500">私有内存</p>
                <p className="mt-0.5 text-sm font-medium text-gray-800 tabular-nums">
                  {formatMemory(trimOutcome.beforePrivateBytes)}
                  <span className="mx-1 text-gray-400">→</span>
                  {formatMemory(trimOutcome.afterPrivateBytes)}
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  这个数字<strong className="font-medium">不会</strong>下降 —— 它统计的是
                  提交的虚拟内存，被换出的页仍然占着它
                </p>
              </div>
            </div>

            <p className="text-[11px] text-gray-500 leading-relaxed">
              回收了 {trimOutcome.trimmed} / {trimOutcome.attempted} 个进程
              {trimOutcome.failed > 0 && `（${trimOutcome.failed} 个打不开，数字因此偏小）`}。
            </p>
          </div>
        )}
      </section>

      <p className="text-[11px] text-gray-400 leading-relaxed">
        这里的数字<strong className="font-medium">只包含本应用拉起的进程</strong>
        （按进程树统计），因此与任务管理器里
        全部 <code className="mx-1 font-mono">msedgewebview2.exe</code> 的总和不相等 ——
        同一台机器上的其它 WebView2 应用不在其中。
        <br />
        界面由 WebView2 渲染，它本身是多进程的：浏览器主进程、GPU 进程、渲染进程
        各司其职。<strong className="font-medium">进程数多是引擎的固有结构，不是缺陷</strong>
        {' '}—— GPU 进程占几十 MB 属于
        正常，关掉它会牺牲全部渲染性能。
        <br />
        <strong className="font-medium">关于任务管理器里的那个数字：</strong>
        它的「内存」列统计的是<strong className="font-medium">私有内存</strong>
        ，而隐藏窗口能降下来的是<strong className="font-medium">工作集</strong>
        。两个口径不一样，因此「隐藏之后任务管理器里的数字没变」并不等于优化没生效
        —— 上面两行就是用来分辨这件事的。
        <br />
        这一页只在打开时采样（3 秒一次），窗口不可见时会停下来。
      </p>
    </div>
  );
};

/**
 * 回收工作集的结果描述。
 *
 * **不降反升要如实说出来**：回收期间别的进程可能刚好在分配内存，
 * 把它说成"已释放 0 字节"会让用户以为操作没执行，而实际是执行了、只是没效果。
 */
function describeFreed(outcome: TrimOutcome): string {
  const freed = outcome.beforeWorkingSet - outcome.afterWorkingSet;
  if (freed > 0) return `已交还系统的物理内存：${formatMemory(freed)}`;
  if (freed === 0) return '没有变化 —— 这些进程本来就没占用多少物理内存';
  return `反而上升了 ${formatMemory(-freed)} —— 回收期间有进程在分配，这不是失败`;
}

const Counter: React.FC<{ label: string; value: string; hint?: string }> = ({
  label,
  value,
  hint,
}) => (
  <div>
    <p className="text-[11px] text-gray-500">{label}</p>
    <p className="mt-0.5 text-base font-semibold text-gray-800 tabular-nums">{value}</p>
    {hint && <p className="text-[10px] text-gray-400 mt-0.5 leading-relaxed">{hint}</p>}
  </div>
);

export default PerformanceSettings;
