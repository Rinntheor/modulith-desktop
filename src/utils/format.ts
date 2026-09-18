// src/utils/format.ts
// 通用格式化工具
//
// 放在 `utils/` 而不是某个模块里，是为了让不同的模块都能用而不互相依赖 ——
// 「删除任意模块都不影响其它部分」是这个项目的一条架构约定，一个格式化函数不值得
// 破坏它。此前 `formatBytes` 在插件模块与市场模块里各有一份，那正是这条约定被误用的
// 结果：为避免模块间依赖而复制代码。

/**
 * 字节数格式化。
 *
 * - 非有限值与非正值一律返回 `'未知'`：`0 B` 会让"没数据"和"确实是 0"长得一样。
 * - 只到 MB：插件包与 README 都不会到 GB，多一级单位只是噪音。
 * - 小于 10 时保留一位小数：`1.5 MB` 比 `2 MB` 更有信息量，而 `12.3 MB` 里的那一位
 *   没有意义。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知';

  const units = ['B', 'KB', 'MB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
