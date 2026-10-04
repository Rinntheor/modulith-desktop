// src/services/backendReady.ts
//
// 后端就绪闸门：**前端在它兑现之前不发起任何需要后端状态的 invoke**。
//
// ============================================================
// 它修的是什么
// ============================================================
//
// 发行版冷启动时，主窗口由 Tauri 在**创建阶段**就建好并开始加载前端资源，而各
// 模块的状态是在 Rust 的 `setup` 钩子里注入的（`setup_all` → 各模块的
// `app.manage(...)`）。两者之间没有任何同步，于是出现了一个只在发行版存在、
// 且每次冷启动必现的竞态。打包产物的实测日志（可复现）：
//
//   15:10:54.507 DEBUG [tauri::manager] Asset `favicon.ico` not found; fallback to index.html
//   15:10:54.532 INFO  [...::settings] 应用设置已就绪：默认模块 None，…
//   15:10:54.546 INFO  [...::auth]     授权模块就绪：已设置密钥 true，要求授权 true，…
//
// 也就是说：webview 已经在取嵌入资源时，`SettingsState` / `AuthState` 的注入
// 还分别晚了 25ms 与 39ms。落在那个窗口里的 `invoke` 会收到
//
//   state not managed for field `state` on command `get_auth_status`.
//   You must call `.manage()` before using this command
//
// 启动流程只有第二步（`检查访问授权`，critical）没有把错误吞掉，所以它是唯一的
// 爆点：用户看到「初始化中断」，点「重试初始化」就能进 —— 那时 `setup` 早已跑完，
// 所以一点就过；而下次冷启动照旧。
//
// 开发模式永远看不到它：`devUrl` 那一跳（连 Vite、按需 transform 上百个 ESM 模块）
// 比 `setup_all` 的磁盘 IO 慢一个数量级，竞速恰好被盖住。**这正是它长期存在而
// 所有源码级门禁全绿的原因** —— 没有一条检查覆盖"启动顺序"。
//
// ============================================================
// 为什么不能只给 `get_auth_status` 加保护
// ============================================================
//
// 同一次竞速里还有一批**被吞掉**的失败，它们不报错，只是让启动结果静默变差：
//
//   * `appSettings.ts` 读设置失败 → 回落到内置默认值（用户的自定义设置被无视）；
//   * `notifications.ts` 订阅后端通知失败 → 铃铛永远不亮；
//   * `memoryLevel.ts` 查询内存等级能力失败 → 缓存成"不支持"，降内存永不生效；
//   * `pluginThemeSync.ts` 推主题快照失败 → 插件在深色下白闪。
//
// 给每一条单独加重试只会把同一件事写五遍，而且下一条新命令还会再犯。因此这里
// 给的是**一个显式闸门**：启动流程的第一个动作就是等它。
//
// ============================================================
// 两条路，任意一条到达即放行
// ============================================================
//
//   · 命令 `backend_ready` —— 一问一答，可重试。Rust 侧查的是一个挂在 builder
//     链上的原子布尔量（`core::registry::ReadyState`），因此它在 `setup` 还没
//     跑完时就已经可查询。
//   · 事件 `modulith://backend-ready` —— `setup` 末尾主动广播一次。
//
// 为什么两条都要：事件可能在前端挂上监听之前就发出去了（那时监听器还不存在），
// 而命令要过 ACL 与一次 IPC 往返。两条都留，任何一条到达都放行 —— 这是**唯一**
// 允许冗余的地方，因为它的失败模式是"应用卡在启动界面"，代价太大。
//
// ============================================================
// 它**不**吞掉真正的失败
// ============================================================
//
// 超时后闸门也会放行（否则一个后端真起不来的场景会变成一个永远转圈的启动界面，
// 比现在更难诊断）。放行之后第一步就是 `get_app_settings`，它会如实报错并给出
// 真实原因 —— 也就是说超时路径不会掩盖问题，只是把诊断权交还给真正的那条命令。
// 因此这里刻意**不让 Promise reject**：调用方 await 它不需要 try/catch，
// 也就不会有人用 `.catch(() => {})` 把它悄悄吞掉。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** 与 Rust `core::registry::BACKEND_READY_EVENT` 一字不差 */
export const BACKEND_READY_EVENT = 'modulith://backend-ready';

/** 与 Rust `core::registry::BACKEND_READY_COMMAND` 一字不差 */
export const BACKEND_READY_COMMAND = 'backend_ready';

/**
 * 轮询间隔。
 *
 * 取 25ms 的理由：要追赶的那个窗口是**几十毫秒**（实测 25–39ms），因此间隔必须
 * 小于它，否则等于没修；而每次轮询只是一次 IPC + 读一个原子量，代价可以忽略。
 * 真正命中的路径通常是**第一次就成功**（实测前端 JS 开始执行时 setup 往往已经
 * 完成，那个窗口是给"恰好更快的那一次"准备的）。
 */
const POLL_INTERVAL_MS = 25;

/**
 * 等待上限。
 *
 * 取 3 秒：正常路径在 100ms 内兑现。给到秒级是为了在极端慢的机器上（首次启动、
 * 杀软扫描、机械盘）仍然不误判；超过它就不是竞速问题而是后端真的有问题，
 * 那时放行、让后续命令如实报错，比在这里编一个"后端没就绪"的错更有用。
 */
const TIMEOUT_MS = 3_000;

/** 闸门 Promise 的兑现/拒绝都由这里控制 */
let resolveReady: (() => void) | null = null;
let readyPromise: Promise<void> | null = null;
let settled = false;

function settle(reason: string): void {
  if (settled) return;
  settled = true;
  resolveReady?.();
  resolveReady = null;
  console.info(`[backendReady] 后端就绪闸门已放行（${reason}）`);
}

/**
 * 安装闸门。**必须在任何 invoke 之前调用**（`main.tsx` 的模块顶层，第一件事）。
 *
 * 它做三件事，顺序是刻意的：
 *   1. 立刻探测一次 —— 若后端已经就绪（绝大多数情况），闸门同步进入就绪，
 *      不会有任何额外延迟；
 *   2. 挂上事件监听 —— 这一次监听是"再也不丢"的保证（Tauri 的事件监听会把
 *      已到达的事件补投给新监听器，因此即使事件先到也不会丢）；
 *   3. 起一个轮询兜底 —— 防的是"事件那条路因为任何原因不可用"。
 */
export function installBackendReadyGate(): Promise<void> {
  if (readyPromise) return readyPromise;

  readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;

    const deadline = Date.now() + TIMEOUT_MS;

    // ---- 2. 事件 ----
    // 不 await：`listen` 本身是一次 IPC，await 它会把"挂监听"排到探测之后，
    // 而探测可能已经放行了 —— 那时监听就没必要了，这里靠 settled 自守。
    void listen(BACKEND_READY_EVENT, () => settle('事件'))
      .then((unlisten) => {
        // 已经放行时立刻拆掉监听：这个事件一次性，留着只会多一个常驻监听器。
        if (settled) unlisten();
      })
      .catch((error) => {
        console.warn('[backendReady] 订阅后端就绪事件失败，改用轮询:', error);
      });

    // ---- 1 + 3. 探测与轮询 ----
    const probe = (): void => {
      if (settled) return;

      void invoke<boolean>(BACKEND_READY_COMMAND)
        .then((ready) => {
          if (settled) return;
          if (ready) {
            settle('命令');
            return;
          }
          if (Date.now() >= deadline) {
            // 见文件头：超时也放行，让后续命令如实报错。
            // 这里用 warn 而不是 error：它本身就是"该看日志了"的信号。
            console.warn(
              `[backendReady] 等待后端就绪超过 ${TIMEOUT_MS}ms，放行启动流程。` +
                '接下来的命令若报错，那才是真正的原因。'
            );
            settle('超时放行');
            return;
          }
          setTimeout(probe, POLL_INTERVAL_MS);
        })
        .catch((error) => {
          // 命令本身失败（ACL 未授权、IPC 未就绪）：不当作"未就绪"而直接放弃 ——
          // 继续按间隔重试，直到上限。真正的失败留给后续命令报清楚。
          if (settled) return;
          if (Date.now() >= deadline) {
            console.warn('[backendReady] 探测后端就绪一直失败，放行启动流程:', error);
            settle('探测失败后放行');
            return;
          }
          setTimeout(probe, POLL_INTERVAL_MS);
        });
    };

    probe();
  });

  return readyPromise;
}

/**
 * 等待后端就绪。调用方**不需要** try/catch（见文件头），但也应当尽量避免在
 * 启动路径之外 await 它 —— 就绪之后它是一个已兑现的 Promise，await 它只是
 * 一个微任务，代价可以忽略。
 */
export function whenBackendReady(): Promise<void> {
  return readyPromise ?? installBackendReadyGate();
}

/** 仅供排查与自检使用：闸门是否已经放行 */
export function isBackendReady(): boolean {
  return settled;
}
