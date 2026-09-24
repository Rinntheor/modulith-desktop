// src/services/pluginDevWatch.ts
//
// 插件**开发模式的自动重载**：改完源码 → 构建产物变了 → 宿主自己重新加载插件。
//
// ============================================================
// 它补上的是哪一段
// ============================================================
//
// 在此之前，"开发一个插件"的闭环是：改源码 → `pnpm dev`（插件仓库）重新构建 →
// **在应用里手动让插件重新加载**。最后一步是断的：产物在磁盘上已经是新的，
// 而运行中的宿主还拿着旧代码，作者只能去插件页点一次（或重启应用）。
//
// 这一步把那段接上 —— 于是从"改一行"到"界面变了"不再需要任何手工动作。
//
// 插件仓库那侧的 `pnpm dev` 负责把源码编成产物；这里负责发现产物变了，
// 并让宿主重新读它。两件事分开，是因为它们各自独立有意义：
// 手写单文件的插件不需要构建，但同样希望改完就生效。
//
// ============================================================
// 只对「开发链接」的插件生效
// ============================================================
//
// 判据是清单/注册表里的 `devSource`（从本地目录安装的插件才有）。这不是限制，
// 而是唯一说得通的语义：从 `.lcp` 安装的插件，代码来自安装目录的副本，
// 改任何别的地方都不该影响它。只有开发链接的插件是"从某个目录实时读取"的。
//
// ============================================================
// 为什么是轮询，不是文件系统事件
// ============================================================
//
// 与插件仓库那侧的 `scripts/watch.ts` 同一条理由：Windows 上编辑器
// "先写临时文件再改名"的保存方式会让 `fs.watch` 漏事件，而构建工具写产物
// 恰恰常用这种方式。轮询的代价被控制在一件事上 —— 见下。
//
// 轮询本身**不读文件内容**：一次 IPC 取回所有开发链接插件的
// `(长度, 修改时间)` 指纹（`dev_plugin_fingerprints`）。读一个几百 KB 的产物
// 来比内容，在按秒轮询下是纯浪费。
//
// ============================================================
// 它替换不掉什么
// ============================================================
//
// **插件 bundle 顶层的同步死循环无法被中断。** JS 单线程，宿主救不回卡住的主线程
// （见 docs/06-项目/已知问题与技术债.md §4.4）。自动重载解决不了这一类 ——
// 只有把插件挪进独立进程才能解决，那是 v2.0 的事。
//
// 因此这里的价值是"省掉手工刷新"，不是"任何错误都能恢复"。

import { invoke } from '@tauri-apps/api/core';

import { logMessage } from './logger';
import { devPluginIds, reloadPluginRuntime } from './pluginRuntime';

/**
 * 轮询间隔。
 *
 * 1.5 秒是个折中：比它更短，构建工具还没写完产物就会被看到（于是白重载一次）；
 * 比它更长，作者会开始怀疑"是不是没生效"。这个数字**不试图**看起来更快 ——
 * 一次错误的自动重载比等一秒更烦人。
 */
const POLL_INTERVAL_MS = 1500;

/**
 * 连续失败多少次之后停止轮询。
 *
 * 后端不可用（或命令不存在，例如前端跑在纯 `vite` 预览里）时，无限重试只会
 * 每 1.5 秒往控制台刷一条错误。开发模式的价值不该以"一直报错"为代价。
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 指纹：`插件 ID → 后端给的 (长度:修改时间)` */
type Fingerprints = Record<string, string>;

/**
 * 轮询状态。
 *
 * `baseline` 是**上一次重载之后**的指纹；每次取回新指纹都与它比，
 * 把"自上次重载以来变过"的插件累积到 `dirty`。重载完成后 `baseline` 换成那一轮的
 * 指纹、`dirty` 清空。
 *
 * 为什么用"累积 + 冷静期"而不是"变了就立刻重载"：构建工具写产物通常是
 * "先截断再写"，因此一次保存会在两次轮询之间留下两个不同的指纹。立刻重载会读到
 * 半成品，而半成品的表现是**产物加载失败** —— 作者会以为是自己改坏了。
 *
 * 早先我写成"把 baseline 清掉、下一轮重新发现"，那是错的：清掉之后下一轮只会
 * 重建基线，这次变化被**丢掉**，表现是"改一次没反应、再改一次才行"。
 * 显式累积没有这个问题。
 */
let baseline: Fingerprints | null = null;
let dirty = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let failures = 0;
/** 正在重载：避免一次重载还没跑完，下一次轮询又进来 */
let busy = false;
/** 上次观察到的变化时刻，冷静期从它算起 */
let lastChangeAt = 0;

/**
 * 冷静期：观察到变化之后等这么久再重载。
 *
 * 取两倍轮询间隔，保证"文件正在被写"的窗口至少被跨过一轮 ——
 * 一次保存只重载一次，且读到的不是半成品。
 */
const SETTLE_MS = POLL_INTERVAL_MS * 2;
/** 开发模式自动重载是否在运行 */
export function isPluginDevWatchRunning(): boolean {
  return timer !== null;
}

function stop(reason: string): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  logMessage('warn', `插件开发模式自动重载已停止：${reason}`, 'pluginDevWatch');
  console.warn(`[pluginDevWatch] 自动重载已停止：${reason}`);
}

/** 指纹不同的插件 ID */
function changedPlugins(next: Fingerprints, before: Fingerprints): string[] {
  const changed: string[] = [];
  for (const [id, fingerprint] of Object.entries(next)) {
    if (before[id] !== fingerprint) changed.push(id);
  }
  // 上一次还在、这一次消失了的：插件被卸载或不再是开发链接
  for (const id of Object.keys(before)) {
    if (!(id in next)) changed.push(id);
  }
  return changed;
}

async function tick(): Promise<void> {
  if (busy) return;

  let next: Fingerprints;
  try {
    next = await invoke<Fingerprints>('dev_plugin_fingerprints');
    failures = 0;
  } catch (error) {
    failures += 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      stop(`连续 ${failures} 次取指纹失败（${error instanceof Error ? error.message : String(error)}）`);
    }
    return;
  }

  // 第一轮只建立基线：否则启动那一刻会把所有开发链接插件都当成"刚变过"，
  // 于是应用一打开就无谓地重载一次全部插件。
  if (baseline === null) {
    baseline = next;
    const ids = Object.keys(next);
    console.info(
      ids.length === 0
        ? '[pluginDevWatch] 没有开发链接的插件 —— 自动重载处于待命状态'
        : `[pluginDevWatch] 开始监听 ${ids.length} 个开发链接插件的产物：${ids.join('、')}`
    );
    return;
  }

  const changed = changedPlugins(next, baseline);
  if (changed.length > 0) {
    // 累积而不是立刻重载：构建工具常常"先截断再写"，一次保存会在两次轮询之间
    // 留下两个不同的指纹。立刻重载会读到半成品，而半成品的表现是**加载失败** ——
    // 作者会以为是自己改坏了。
    for (const id of changed) dirty.add(id);
    lastChangeAt = Date.now();
    baseline = next;
    return;
  }

  // 没有新变化，但之前累积的还没到时间 —— 继续等
  if (dirty.size === 0) return;
  if (Date.now() - lastChangeAt < SETTLE_MS) return;

  const touched = [...dirty];
  busy = true;
  try {
    const names = touched.length <= 3 ? touched.join('、') : `${touched.length} 个`;
    console.info(`[pluginDevWatch] 检测到产物变化（${names}），重新加载插件运行时…`);
    logMessage('info', `插件开发模式：产物变化（${names}），自动重载`, 'pluginDevWatch');

    await reloadPluginRuntime();

    // 只有重载成功才清空累积。失败时留着，下一轮再试一次 ——
    // 半成品产物常常在几百毫秒后就变成完整产物，那时重试会成功。
    dirty.clear();
    console.info('[pluginDevWatch] 重载完成');
    logMessage('info', '插件开发模式：自动重载完成', 'pluginDevWatch');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[pluginDevWatch] 自动重载失败：', error);
    logMessage('error', `插件开发模式自动重载失败：${message}`, 'pluginDevWatch');
    // 重载失败通常意味着产物此刻是坏的。把基线重置，让下一轮重新发现变化，
    // 从而在作者修好之后能自动恢复 —— 否则一次失败会让监听永久停在坏指纹上。
    baseline = null;
    dirty.clear();
  } finally {
    busy = false;
  }
}

/**
 * 启动自动重载。重复调用是幂等的。
 *
 * **只有存在开发链接的插件时才真的开始轮询**：一个普通用户装上几个 `.lcp` 插件之后，
 * 不该因为宿主里住着一段每 1.5 秒问一次"变了没"的定时器而付出代价。
 * 判据取自运行时自己的 `devPluginIds()`，因此与"哪些插件真的从目录读取"永远一致。
 */
export function startPluginDevWatch(): void {
  if (timer !== null) return;

  const ids = devPluginIds();
  if (ids.length === 0) {
    // 不启动，也不报错：绝大多数安装都属于这一类
    return;
  }

  baseline = null;
  dirty.clear();
  failures = 0;
  lastChangeAt = 0;
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);

  console.info(
    `[pluginDevWatch] 开发模式自动重载已启动（${POLL_INTERVAL_MS} ms 轮询，${ids.length} 个开发链接插件）`
  );
  logMessage('info', `插件开发模式自动重载已启动（${ids.length} 个开发链接插件）`, 'pluginDevWatch');
}

/** 停止自动重载。用于插件全部卸载后收尾，或测试里复位 */
export function stopPluginDevWatch(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  baseline = null;
  dirty.clear();
  failures = 0;
  busy = false;
}
