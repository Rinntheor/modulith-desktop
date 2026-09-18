// scripts/check-update-throttle.ts
// 自动检查更新的节流判断的验证脚本
//
// 前端没有测试框架，这个脚本就是 src/utils/updateCheck.ts 的测试：
//
//   node scripts/check-update-throttle.ts
//
// 重点覆盖的是**边界与坏数据**，而不是"24 小时内不查"这一条显然的规则 ——
// 真正会出事的是「时间戳在未来」这类情形：判断写错方向会让自动检查永久失效，
// 而那种故障完全静默（用户只会以为"这个软件从来不发更新"）。

import { isUpdateCheckDue, UPDATE_CHECK_INTERVAL_MS } from '../src/utils/updateCheck.ts';

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

/** 固定「现在」，避免用例随真实时间漂移 */
const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

console.log('应当检查：');
check(isUpdateCheckDue(null, NOW), '从没查过（null）');
check(isUpdateCheckDue(undefined, NOW), '从没查过（undefined）');
check(isUpdateCheckDue('', NOW), '空串按没查过处理');
check(isUpdateCheckDue('不是时间', NOW), '解析不出来按没查过处理');
check(isUpdateCheckDue(iso(60_000), NOW), '时间戳在未来（时钟被回调过）');
check(
  isUpdateCheckDue('2099-01-01T00:00:00Z', NOW),
  '时间戳远在未来（文件被手工改过）'
);
check(
  isUpdateCheckDue(iso(-(UPDATE_CHECK_INTERVAL_MS + 60_000)), NOW),
  '刚过 24 小时'
);

console.log('\n不应当检查：');
check(!isUpdateCheckDue(iso(-60_000), NOW), '一分钟前查过');
check(
  !isUpdateCheckDue(iso(-(UPDATE_CHECK_INTERVAL_MS - 60_000)), NOW),
  '还差一分钟到 24 小时'
);
check(!isUpdateCheckDue(iso(-23 * 60 * 60 * 1000), NOW), '23 小时前查过');

console.log('\n边界：');
check(isUpdateCheckDue(iso(-UPDATE_CHECK_INTERVAL_MS), NOW), '正好 24 小时（含端点，应当检查）');
check(!isUpdateCheckDue(iso(0), NOW), '时间戳等于现在（不晚于现在，按已检查处理）');

// 节流窗口本身是产品约定，写进断言以免被无意改小
check(UPDATE_CHECK_INTERVAL_MS === 24 * 60 * 60 * 1000, '节流窗口为 24 小时');

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
