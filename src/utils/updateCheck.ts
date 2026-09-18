// src/utils/updateCheck.ts
//
// 自动检查更新的节流判断。
//
// 单独一个模块、且不 import 任何 Tauri API，是为了能被
// `scripts/check-update-throttle.ts` 直接引入断言 —— 与 `utils/semver.ts` 同样的
// 理由：把纯逻辑从宿主环境里摘出来，前端没有测试框架，脚本就是它的测试。
//
// 为什么需要节流：检查一次就是对 GitHub 的一次请求，而「启动应用」是用户一天会做
// 很多次的动作。没有节流的话，频繁开关应用会变成对 release 地址的轮询 ——
// 既没必要，也会让一个纯本地应用在别人的日志里显得可疑。

/** 两次自动检查之间的最小间隔：24 小时 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 现在是否该发起一次自动检查。
 *
 * 四种情况都返回 `true`（即「该查」）：
 *
 * 1. **从没查过**（`null` / `undefined`）—— 首次启动就落在这一条。
 * 2. **时间戳解析不出来**：文件被手工改坏，按「没查过」处理而不是按「刚查过」。
 * 3. **时间戳在未来**：系统时钟被往回调过，或者文件被手工改过。这一条必须检查 ——
 *    把未来的时间戳当成「刚查过」会让自动检查被**永久**跳过，而那恰恰是最需要
 *    检查的情形（时钟错乱往往同时意味着别的东西也不对）。
 * 4. 距上次检查已超过 24 小时。
 *
 * 注意这里判断的是「是否**得到过结论**」，不是「是否尝试过」：失败不写时间戳，
 * 因此一次离线启动不会让自动检查静默失效一整天。
 */
export function isUpdateCheckDue(
  lastCheckAt: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!lastCheckAt) return true;

  const at = new Date(lastCheckAt).getTime();
  if (Number.isNaN(at)) return true;
  if (at > now) return true;

  return now - at >= UPDATE_CHECK_INTERVAL_MS;
}
