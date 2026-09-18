// scripts/check-semver.ts
// 版本比较的验证脚本
//
// 前端没有测试框架，这个脚本就是 src/utils/semver.ts 的测试：
//
//   node scripts/check-semver.ts
//
// 用例取自 **semver.org 的官方优先级链**，而不是自己编的例子。理由与哈希校验一致：
// 拿实现去校验实现，在规则理解错的时候会一起错，测试照样全绿。

import { compareVersions, isNewer, parseVersion } from '../src/utils/semver.ts';

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

// ---------------------------------------------------------------------------
// 官方优先级链：链中每一项都必须严格小于下一项
// 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta
//   < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
// ---------------------------------------------------------------------------
console.log('官方优先级链（链中每项必须严格小于下一项）：');
const chain = [
  '1.0.0-alpha',
  '1.0.0-alpha.1',
  '1.0.0-alpha.beta',
  '1.0.0-beta',
  '1.0.0-beta.2',
  '1.0.0-beta.11',
  '1.0.0-rc.1',
  '1.0.0',
];
for (let i = 0; i + 1 < chain.length; i += 1) {
  const lower = chain[i];
  const upper = chain[i + 1];
  check(compareVersions(lower, upper) < 0, `${lower} < ${upper}`);
  check(compareVersions(upper, lower) > 0, `${upper} > ${lower}`);
}

// ---------------------------------------------------------------------------
// 三段数字
// ---------------------------------------------------------------------------
console.log('\n三段数字：');
check(compareVersions('1.0.0', '1.0.0') === 0, '1.0.0 == 1.0.0');
check(compareVersions('1.0.0', '2.0.0') < 0, '1.0.0 < 2.0.0');
check(compareVersions('2.0.0', '2.1.0') < 0, '2.0.0 < 2.1.0');
check(compareVersions('2.1.0', '2.1.1') < 0, '2.1.0 < 2.1.1');
// 这两条防的是"按字符串比较"的退化实现：字典序会给出一堆错误答案
check(compareVersions('2.0.0', '10.0.0') < 0, '2.0.0 < 10.0.0（按数值，不按字典序）');
check(compareVersions('1.9.0', '1.10.0') < 0, '1.9.0 < 1.10.0（同上）');
check(compareVersions('1.0.9', '1.0.10') < 0, '1.0.9 < 1.0.10（同上）');

// ---------------------------------------------------------------------------
// 预发布段的两条细则
// ---------------------------------------------------------------------------
console.log('\n预发布段的细则：');
check(
  compareVersions('1.0.0-beta.2', '1.0.0-beta.11') < 0,
  'beta.2 < beta.11（数字段按数值，不按字典序）'
);
check(
  compareVersions('1.0.0-1', '1.0.0-alpha') < 0,
  '1.0.0-1 < 1.0.0-alpha（数字段小于字母段）'
);
check(
  compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0,
  'alpha < alpha.1（段数少的更小）'
);
check(compareVersions('1.0.0-rc.1', '1.0.0') < 0, '1.0.0-rc.1 < 1.0.0（预发布低于同号正式版）');

// ---------------------------------------------------------------------------
// 构建元数据不参与比较
// ---------------------------------------------------------------------------
console.log('\n构建元数据（`+` 之后）不参与比较：');
check(compareVersions('1.0.0+a', '1.0.0+b') === 0, '1.0.0+a == 1.0.0+b');
check(compareVersions('1.0.0', '1.0.0+build.5') === 0, '1.0.0 == 1.0.0+build.5');

// ---------------------------------------------------------------------------
// isNewer：市场页实际使用的判断
// ---------------------------------------------------------------------------
console.log('\nisNewer：');
check(isNewer('1.0.1', '1.0.0'), '新版本算更新');
check(!isNewer('1.0.0', '1.0.0'), '同版本不算更新');
check(!isNewer('0.9.9', '1.0.0'), '更旧的版本不算更新');
check(!isNewer('1.0.0-rc.1', '1.0.0'), '预发布不算高于同号正式版');

// ---------------------------------------------------------------------------
// 解析的边界
// ---------------------------------------------------------------------------
console.log('\n解析：');
check(parseVersion('1.2.3')?.major === 1, '解析主版本');
check(parseVersion('1.2.3')?.prerelease.length === 0, '正式版没有预发布段');
check(parseVersion(' 1.2.3 ')?.patch === 3, '容忍首尾空白');
check(parseVersion('1.2.3-rc.1')?.prerelease.join('.') === 'rc.1', '解析预发布段');
check(parseVersion('1.2.3+build')?.prerelease.length === 0, '丢弃构建元数据');
check(parseVersion('1.2') === null, '拒绝两段式');
check(parseVersion('v1.2.3') === null, '拒绝 v 前缀');
check(parseVersion('') === null, '拒绝空串');
// 与宿主对插件清单的宽松解析一致
check(parseVersion('01.02.03') !== null, '接受前导零');
check(
  compareVersions('01.02.03', '1.2.3') === 0,
  '01.02.03 == 1.2.3（前导零不影响比较）'
);
// 解析不了时必须有确定结果，而不是抛错或返回 NaN
check(Number.isFinite(compareVersions('不是版本号', '1.0.0')), '无法解析时仍给出确定结果');

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
