// src/utils/semver.ts
// 版本号比较
//
// 为什么前端需要自己实现：市场页要回答"有没有更新"，而这个问题只能在拿到索引里的最新
// 版本与本机已安装版本之后回答。
//
// 后端也有一份实现（Rust 的 `SemVer`，用于清单校验与引擎范围），**两者必须给出一致的
// 结果**。这不算"同一份事实两处维护"：semver 的优先级规则是一份**公开标准**，不是本项目
// 的约定 —— 真正会出问题的是"其中一份实现写错了"，而不是"规则变了"。因此这里覆盖标准的
// 全部规则，并由 `scripts/check-semver.ts` 用标准里的官方例子逐一验证（前端没有测试框架，
// 那个脚本就是它的测试）。

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识符，`.` 分隔。空数组表示正式版 */
  prerelease: string[];
}

/**
 * 解析 `MAJOR.MINOR.PATCH[-prerelease][+build]`。
 *
 * 按标准，构建元数据（`+` 之后）**不参与比较**，因此直接丢弃。
 * 前导零不报错 —— 与宿主对插件清单的宽松解析保持一致（`01.0.0` 会被当作 `1.0.0`）。
 *
 * 解析不了时返回 `null`，由调用方决定怎么处理，而不是在这里抛错：版本号来自索引与
 * 已安装插件，两者都可能出现意料之外的写法，界面不该因此崩溃。
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    raw.trim()
  );
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/**
 * 预发布标识符的比较规则（标准里的三条）：
 *
 * 1. 只有数字的标识符按**数值**比较（因此 `beta.11 > beta.2`，不是字典序）
 * 2. 数字标识符**小于**字母标识符（因此 `alpha.1 < alpha.beta`）
 * 3. 前缀相同时，段数少的更小（因此 `alpha < alpha.1`）
 */
function comparePrerelease(left: string[], right: string[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);

    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) - Number(b);
      continue;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * 比较两个版本号：`a < b` 返回负数，相等返回 0，`a > b` 返回正数。
 *
 * **解析不了时回退为字符串比较。** 这给出一个确定的顺序（排序结果不会随调用时机变化），
 * 但这个顺序没有语义。需要区分"能比较"与"不能比较"的调用方应当先调 `parseVersion`。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;

  // 同号时，带预发布后缀的**低于**正式版：1.0.0-rc.1 < 1.0.0
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  return comparePrerelease(left.prerelease, right.prerelease);
}

/** `candidate` 是否比 `current` 新。相等或更旧都返回 `false`。 */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
