// src/components/moduleIconResolver.ts
//
// 模块图标的**解析决策**：纯函数，不含 React、不碰 DOM、不发任何 IPC。
//
// 为什么它单独成一个 `.ts`，而不是继续留在 `ModuleIcon.tsx` 里：
//   仓库的 `scripts/check-*.ts` 用 Node 直接跑 TS，而 Node 的类型擦除
//   **不转换 JSX**（见 `scripts/harness/loader.mjs` 的说明）。因此 `.tsx` 里的
//   判定逻辑没有任何可被脚本钉住的途径 —— 而"路径型 icon 该画什么"恰恰是
//   用户报过一次缺陷的地方（"插件没有使用其自身自带的图标""有的图标直接找不到了"）。
//   把判定抽到这里，`ModuleIcon.tsx` 只剩"按判定画东西"，判定本身可被断言。
//
// 解析顺序（与 `ModuleIcon.tsx` 的文件头注释逐条一致）：
//   1. `iconSvg`（内联 SVG）—— **插件自己的图标**，也是路径型 `icon` 的唯一来源；
//   2. 构建期映射表 `generated/iconMap`（内置模块，静态导入、同步可得）；
//   3. lucide 图标名 → 按需动态加载；
//   4. 兜底：lucide 的 `Box`（保证永远不出现空白）。
//
// ============================================================
// 第 1 条与第 3 条的关系是这块最容易被误解的地方
// ============================================================
//
// `contributes.modules[].icon` 写的是 lucide 图标名（`Rocket`）时，只要插件
// 自己带了 `icon.svg`，宿主会在目录建立后把那张图读进描述符的 `iconSvg`
// （见 pluginRuntime 的 `prefetchDeclaredIcons`）。于是**内联 SVG 优先**：
// 侧边栏显示的是插件自己的图标，而不是宿主的 lucide 图标。
//
// 反过来，`icon` 是插件包内的路径（`icon.svg`）时，它**不是**图标名，绝不该去
// 查 lucide：这张图只能由宿主提前读进 `iconSvg`（渲染路径是同步的，见
// `prefetchPluginIcon` 的说明）。宿主没补上时就落 `Box` 兜底 —— 这是契约的一部分，
// 因为同步渲染路径拿不到异步读来的图。

/** 判定结果：`ModuleIcon` 据此决定"画哪一种" */
export type ModuleIconSource =
  /** 插件自己的内联 SVG（最高优先级） */
  | { kind: 'inline-svg'; svg: string }
  /** 构建期映射表里的内置图标 */
  | { kind: 'builtin'; name: string }
  /** 运行时按需加载的 lucide 图标 */
  | { kind: 'lucide'; name: string }
  /** 兜底：lucide 的 `Box` */
  | { kind: 'fallback' };

export interface ModuleIconInput {
  /** 模块的 `icon` 字段：lucide 图标名、或插件包内的相对路径（`icon.svg`） */
  icon?: string;
  /** 已解析的内联 SVG 源码（`<svg …>` 字符串） */
  iconSvg?: string;
  /**
   * 「这个名字在内置映射表里吗」。
   *
   * 由调用方注入而不是在这里 import `generated/iconMap`：那张表是构建期产物，
   * 只与内置模块有关，注入之后这个模块保持零依赖，check 脚本也能直接拿它做断言。
   */
  hasBuiltinIcon: (name: string) => boolean;
}

/**
 * 判定一个字符串是不是「能安全直接注入的 SVG 标记」。
 *
 * 只接受以 `<svg` 开头的内容：插件资源可以是任意文件，若把一段
 * `<script>` 当 SVG 注入就会变成注入点。这里要求严格的开头匹配，
 * 而不是「包含 <svg」，避免 `<!-- <svg -->…` 这类绕过。
 */
export function isSvgMarkup(value: string | undefined): value is string {
  return typeof value === 'string' && value.trimStart().toLowerCase().startsWith('<svg');
}

/**
 * 这个 `icon` 值看起来是不是「插件包内的一个资源路径」。
 *
 * 判据只有两条：常见图片后缀、或含路径分隔符。它用来把"路径"与"lucide 图标名"
 * 分开 —— 后者只可能是单个标识符（`Rocket`、`ClipboardList`），绝不会带 `.svg`。
 */
export function looksLikeAssetPath(icon: string): boolean {
  return /\.(svg|png|jpe?g|webp|gif)$/i.test(icon) || icon.includes('/');
}

/**
 * `PascalCase` / `camelCase` → `kebab-case`。
 *
 * lucide 的 `dynamicIconImports` 用小写连字符作键（`sticky-note`），
 * 而 module.toml 与插件注册用组件名（`StickyNote`）。
 * 连续的大写字母要合并处理：`LayoutGrid2` → `layout-grid-2`、
 * `FileJson2` → `file-json-2`。
 */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * 唯一的判定入口。
 *
 * 顺序是**契约**，不是实现细节：`iconSvg` 一旦有值就一定赢 —— 那是插件自己的图标，
 * 也是"插件模块用插件自己的图"这句话在代码里的落点。
 */
export function resolveModuleIconSource(input: ModuleIconInput): ModuleIconSource {
  // 1) 内联 SVG（插件加载/目录建立后由宿主补进描述符，同步可得）
  if (isSvgMarkup(input.iconSvg)) return { kind: 'inline-svg', svg: input.iconSvg };

  const icon = typeof input.icon === 'string' ? input.icon.trim() : '';
  if (!icon) return { kind: 'fallback' };

  // 2) 构建期映射表：内置模块的常见路径，零异步开销
  if (input.hasBuiltinIcon(icon)) return { kind: 'builtin', name: icon };

  // 3) 路径型 icon（`icon.svg` / `icons/panel.svg`）。
  //
  //    它不是图标名，因此**明确不去查 lucide**：`toKebabCase('icon.svg')` 得到的
  //    `icon.svg` 在 `dynamicIconImports` 里永远查不到，白搭一次动态 import，
  //    而那次 import 的失败会被当成"图标不存在"混进日志里。

  //    它的图只能来自上面第 1 条 `iconSvg`。走到这里说明宿主没能补上那张图
  //    （例如图标文件读不到）—— 按契约落 `Box` 兜底，绝不空白。
  if (looksLikeAssetPath(icon)) return { kind: 'fallback' };

  // 4) lucide 按需加载（名字是否真的存在，只有异步加载完才知道；
  //    解析不出来时由渲染端落 `Box`，见 `AsyncLucideIcon`）
  return { kind: 'lucide', name: icon };
}
