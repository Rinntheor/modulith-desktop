// src/config/accentTheme.ts
//
// 主题配色（强调色）的定义表。
//
// 设计：**只声明品牌主色一个色值**，其余深浅档位在运行期由它推导
// （见 `src/services/accent.ts` 的 `buildAccentVariables`）。
//
// 这样做的理由：Tailwind 的 `-50 / -100 / -500 / -600 / -700` 等档位
// 在界面里承担不同职责（浅底、浅底加深、主色、悬停、深色文字），
// 如果每个主题都手写十几档色值，既冗长又极易不一致。只给主色、其余推导，
// 新增配色只需在此表加一行 —— 这是本项目「高自由度」主张在配色上的体现。
//
// 用途约定（决定推导时的明度走向）：
//   · 浅色模式：`-600` 是主色（按钮底、链接文字），需要足够深以在白底上可读；
//     `-50/-100` 是同色相的极浅底。
//   · 深色模式：`-400` 是主色（深底上的文字），需要足够亮；
//     `-500/-600` 用于按钮底；`-800/-900` 是深底。

/** 一个可选的主题配色 */
export interface AccentTheme {
  /** 稳定标识，写入 settings.json */
  id: string;
  /** 界面显示名 */
  label: string;
  /**
   * 品牌主色（十六进制，`#RRGGBB`）。
   *
   * 选取标准是「在白底上作正文色可读、在深色底上作强调色可辨」的中间档，
   * 大致对应 Tailwind 的 `-600`。
   */
  base: string;
  /**
   * 是否为「无彩色」主题。
   *
   * 灰色系没有色相，推导出的浅底会与界面自身的灰阶撞色（例如
   * `bg-accent-50` 与 `bg-gray-50` 几乎一样），因此它的浅底/深底
   * 需要按中性色处理，而不是从主色混白。见 `accent.ts` 的处理。
   */
  neutral?: boolean;
}

/**
 * 内置配色表。
 *
 * 顺序即设置页的展示顺序：默认项在最前。
 *
 * 数量的取舍：这里给出较全的一套（覆盖常见品牌色相），因为需求明确要求
 * 「白/黑/蓝/灰/橙/红等等」。但需注意：**配色越多，视觉一致性越难保证** ——
 * 语义色（红=错误、琥珀=警告、绿=成功）不参与主题，因此选红色主题时，
 * 红色既表示「品牌」又表示「危险」，会削弱语义色的警示作用。这一点在
 * 设置页的提示文案里已向用户说明。
 */
export const ACCENT_THEMES: AccentTheme[] = [
  { id: 'indigo', label: '靛蓝', base: '#4f46e5' },
  { id: 'violet', label: '紫罗兰', base: '#7c3aed' },
  { id: 'blue', label: '蓝色', base: '#2563eb' },
  { id: 'cyan', label: '青色', base: '#0891b2' },
  { id: 'teal', label: '蓝绿', base: '#0d9488' },
  { id: 'emerald', label: '翠绿', base: '#059669' },
  { id: 'amber', label: '琥珀', base: '#d97706' },
  { id: 'orange', label: '橙色', base: '#ea580c' },
  { id: 'rose', label: '玫红', base: '#e11d48' },
  { id: 'gray', label: '灰白', base: '#4b5563', neutral: true },
];

/** 默认配色（与 Rust 端 `settings.rs` 的默认值必须一致） */
export const DEFAULT_ACCENT_ID = 'indigo';

/** 校验任意输入是否为已知配色 id */
export function isAccentId(value: unknown): value is string {
  return typeof value === 'string' && ACCENT_THEMES.some((t) => t.id === value);
}

/** 按 id 取配色定义；未知 id 回退到默认 */
export function getAccentTheme(id: string | null | undefined): AccentTheme {
  return ACCENT_THEMES.find((t) => t.id === id) ?? ACCENT_THEMES[0];
}
