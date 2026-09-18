// src/services/shortcutRegistry.ts
//
// 快捷键注册表。
//
// 之前快捷键是写死在 `useGlobalShortcuts` 里的一串 if-else。那对宿主自己够用，
// 但有两个问题：插件无法贡献快捷键，而「哪些组合已被占用」也无从查询，只能靠
// 读源码。这里把它变成一张表：宿主内置组合与插件组合走同一条通路，冲突能被检测，
// 卸载时能按来源批量摘除。
//
// 三个刻意的设计决定：
//
//   1. **先注册者优先。** 冲突时后来的注册被忽略（并记录警告），而不是覆盖。
//      理由：宿主的内置组合先注册，若允许覆盖，一个插件就能悄悄把 Ctrl+W 抢走。
//      插件想用已被占用的组合时，得到的是可诊断的警告，而不是无声的行为改变。
//   2. **`allowInInput` 只对插件默认关闭。** 宿主内置组合（Ctrl+K / Ctrl+W /
//      Ctrl+Tab / Ctrl+1..9）在输入框里同样生效，这与浏览器一致；而插件默认
//      不在输入框内触发，否则一个注册了普通字母组合的插件会让用户没法打字。
//   3. **组合键用规范化字符串比较**，而不是解析成一个复杂结构反复比对。
//      规范化后 `Ctrl+Shift+Tab` 与 `mod+shift+tab` 是同一个键，
//      既便于查表，也让「冲突」这件事有唯一表示。

export interface ShortcutDefinition {
  /** 唯一 ID。插件建议用 `plugin:<插件id>:<动作>`，便于按前缀/来源批量注销 */
  id: string;
  /**
   * 组合键，形如 `mod+k`、`mod+shift+tab`、`mod+1`。
   *
   * `mod` 在 Windows / Linux 上是 Ctrl，在 macOS 上是 Cmd。
   * 支持的修饰符：`mod`、`shift`、`alt`。键名用小写，特殊键写 `tab`、`escape`、
   * `enter`、`space`。
   */
  combo: string;
  /** 展示用说明 */
  description: string;
  run: () => void | Promise<void>;
  /** 注册者标识，用于按来源批量注销 */
  source?: string;
  /** 是否在输入框 / 可编辑区域内也生效（宿主内置为 true，插件默认 false） */
  allowInInput?: boolean;
}

export interface RegisteredShortcut extends ShortcutDefinition {
  /** 规范化后的组合键，冲突检测与匹配都用它 */
  normalized: string;
  source: string;
  allowInInput: boolean;
}

interface ParsedCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const registry: RegisteredShortcut[] = [];
const listeners = new Set<() => void>();

/** 已占用组合 → 持有它的快捷键 ID，用于冲突检测 */
const occupied = new Map<string, string>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[shortcutRegistry] 订阅者执行出错:', error);
    }
  });
}

/** 订阅注册表变化 */
export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================================
// 组合键解析
// ============================================================

/**
 * 把组合键字符串解析为可比较的结构。
 *
 * 无法解析时返回 null（例如空串、只有修饰符、含未知修饰符）。
 * 导出它是为了让这套规则可以被独立验证 —— 它是不依赖 React 与浏览器的纯函数。
 */
export function parseCombo(combo: string): ParsedCombo | null {
  if (!combo) return null;

  const parts = combo
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;

  const parsed: ParsedCombo = { mod: false, shift: false, alt: false, key: '' };

  for (const part of parts) {
    switch (part) {
      case 'mod':
      case 'ctrl':
      case 'cmd':
      case 'meta':
        parsed.mod = true;
        break;
      case 'shift':
        parsed.shift = true;
        break;
      case 'alt':
      case 'option':
        parsed.alt = true;
        break;
      default:
        // 已经有主键了说明写成了 `mod+a+b` 这种形式，无法判定意图
        if (parsed.key) return null;
        parsed.key = part;
    }
  }

  // 只有修饰符没有主键的组合是无意义的
  if (!parsed.key) return null;

  return parsed;
}

/** 规范化为 `[mod+][shift+][alt+]<key>` 的稳定形式 */
export function normalizeCombo(combo: string): string | null {
  const parsed = parseCombo(combo);
  if (!parsed) return null;

  const prefix = [
    parsed.mod ? 'mod' : '',
    parsed.shift ? 'shift' : '',
    parsed.alt ? 'alt' : '',
  ]
    .filter(Boolean)
    .join('+');

  return prefix ? `${prefix}+${parsed.key}` : parsed.key;
}

/**
 * 判断一个键盘事件是否命中某个组合键。
 *
 * 要求修饰符**完全一致**：`mod+k` 不会匹配 `mod+shift+k`。这与「包含即命中」的
 * 宽松匹配不同 —— 后者会让 `mod+shift+tab` 同时命中 `mod+tab`，两个动作一起触发。
 */
export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parsed = parseCombo(combo);
  if (!parsed) return false;

  if (parsed.mod !== (event.ctrlKey || event.metaKey)) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;

  return event.key.toLowerCase() === parsed.key;
}

/** 事件目标是否是一个正在输入的控件 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

// ============================================================
// 注册
// ============================================================

/**
 * 注册一个快捷键。返回是否注册成功。
 *
 * 失败只有一种原因：组合键与已注册的冲突（或组合键本身无法解析）。
 * 两种情况都会记录警告 —— 静默失败会让插件作者以为快捷键生效了。
 */
export function registerShortcut(definition: ShortcutDefinition): boolean {
  const normalized = normalizeCombo(definition.combo);

  if (!normalized) {
    console.warn(
      `[shortcutRegistry] 快捷键 "${definition.id}" 的组合键 "${definition.combo}" 无法解析，已忽略`
    );
    return false;
  }

  const existing = occupied.get(normalized);
  if (existing && existing !== definition.id) {
    console.warn(
      `[shortcutRegistry] 组合键 "${normalized}" 已被 "${existing}" 占用，` +
        `"${definition.id}" 的注册被忽略（先注册者优先，避免插件覆盖宿主快捷键）`
    );
    return false;
  }

  // 同 ID 重复注册视为更新：先摘掉旧条目，避免留下两条同 ID 的记录
  const previousIndex = registry.findIndex((item) => item.id === definition.id);
  if (previousIndex >= 0) {
    const previous = registry[previousIndex];
    occupied.delete(previous.normalized);
    registry.splice(previousIndex, 1);
  }

  registry.push({
    ...definition,
    normalized,
    source: definition.source ?? 'host',
    allowInInput: definition.allowInInput ?? false,
  });

  occupied.set(normalized, definition.id);
  notify();
  return true;
}

/** 批量注册 */
export function registerShortcuts(definitions: ShortcutDefinition[]): void {
  definitions.forEach(registerShortcut);
}

/** 注册是否成功过（供自检） */
export function isShortcutRegistered(id: string): boolean {
  return registry.some((item) => item.id === id);
}

/** 当前全部快捷键（按注册顺序，也是匹配优先级） */
export function getShortcuts(): RegisteredShortcut[] {
  return [...registry];
}

/**
 * 按来源批量注销，返回被移除的数量。
 *
 * 插件禁用 / 卸载时必须调用，否则会留下调用失效代码的快捷键。
 */
export function unregisterShortcutsBySource(source: string): number {
  if (!source) return 0;

  let removed = 0;
  for (let index = registry.length - 1; index >= 0; index -= 1) {
    if (registry[index].source !== source) continue;
    occupied.delete(registry[index].normalized);
    registry.splice(index, 1);
    removed += 1;
  }

  if (removed > 0) notify();
  return removed;
}

/** 按 ID 前缀批量注销 */
export function unregisterShortcutsByPrefix(prefix: string): number {
  let removed = 0;
  for (let index = registry.length - 1; index >= 0; index -= 1) {
    if (!registry[index].id.startsWith(prefix)) continue;
    occupied.delete(registry[index].normalized);
    registry.splice(index, 1);
    removed += 1;
  }
  if (removed > 0) notify();
  return removed;
}

/** 该组合键当前被谁占用（诊断用） */
export function getShortcutOwner(combo: string): string | null {
  const normalized = normalizeCombo(combo);
  return normalized ? occupied.get(normalized) ?? null : null;
}

// ============================================================
// 派发
// ============================================================

/**
 * 按注册顺序查找并执行第一个匹配的快捷键。
 *
 * 返回是否命中了某个快捷键，调用方据此决定要不要再走自己的后备逻辑。
 * 命中时**由本函数调用 `preventDefault()`** —— 不阻止默认行为的话，
 * WebView 可能会同时执行它自己的处理（例如 Ctrl+W 的默认行为）。
 */
export function handleShortcutEvent(event: KeyboardEvent): boolean {
  const inInput = isTypingTarget(event.target);

  // 遍历**副本**：快捷键的处理函数可能会重新注册（例如「切换主题」执行后会刷新
  // 自己的文案），而那会就地修改 registry。直接遍历原数组会遇到「边遍历边修改」，
  // 轻则漏掉后续条目，重则跳过或重复触发。
  for (const shortcut of [...registry]) {
    if (inInput && !shortcut.allowInInput) continue;
    if (!matchesCombo(event, shortcut.combo)) continue;

    event.preventDefault();

    try {
      void shortcut.run();
    } catch (error) {
      console.error(`[shortcutRegistry] 执行快捷键 "${shortcut.id}" 失败:`, error);
    }

    return true;
  }

  return false;
}
