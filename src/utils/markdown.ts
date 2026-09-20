// src/utils/markdown.ts
//
// Markdown 的**纯解析器**：把文本解析成 AST，不做任何渲染。
//
// ---------------------------------------------------------------------------
// 为什么是自己写，而不是引一个库
//
// 1. **安全。** 插件 README 是从插件仓库按 tag 取回的**远程内容**，而插件与宿主
//    运行在同一个 WebView、同一个 JS 上下文里（见插件系统架构第 6 节）。在这里
//    渲染 HTML 等于给远程内容一个注入点。常见做法是"拼接 HTML 再交给消毒库"，
//    但那意味着一整条「拼接 → 消毒 → 插入」的链路都必须正确。
//    本方案把输出限定成 AST，由 React 渲染成元素：**源码里的 HTML 在结构上不可能
//    被执行**，它只会作为文本显示出来。这不是靠 lint 规则维持的约定，而是类型上
//    就没有那条路。
// 2. **子集是可枚举的。** 解析器只需要覆盖插件 README 真实用到的构造，实测统计
//    （9 个 README、53.7 KB）为：标题 86、粗体 81、行内代码 113、围栏代码块 18、
//    表格 106 行、无序列表 29、有序列表 9、引用 6、链接 11、图片 0，**没有嵌套
//    列表、没有列表续行**。不为用不到的语法付出复杂度。
// 3. 这个文件是纯的（不碰 DOM、不碰 React），因此 `scripts/check-markdown.ts`
//    可以在 Node 里直接断言它的输出 —— 包括"snake_case 不被当成斜体"
//    这类只能靠用例钉住的判断。
//
// ---------------------------------------------------------------------------
// 明确不支持（遇到时**降级为纯文本**，不报错、不吞掉内容）
//
// 嵌套列表、列表续行、引用块内的多段落、引用式链接、脚注、任务列表、内联 HTML。
// 前两项是实测数据里不存在的；内联 HTML 是有意不支持 —— 见上面第 1 条。
// 这些构造在界面上会以原文形式出现，而不是消失。
//
// ---------------------------------------------------------------------------
// 链接的安全边界
//
// 只承认 `http:` / `https:` / `mailto:` 三种协议。其余（`javascript:`、`data:`、
// `vbscript:`、`file:`…）**不生成链接节点**，而是把原文当作纯文本返回 ——
// 这样既能看见作者写了什么，也不可能被点击。

/** 行内节点 */
export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'em'; children: InlineNode[] }
  | { kind: 'link'; href: string; children: InlineNode[] }
  | { kind: 'image'; href: string; alt: string };

/** 块级节点 */
export type BlockNode =
  | { kind: 'heading'; level: number; children: InlineNode[] }
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'list'; ordered: boolean; items: InlineNode[][] }
  | { kind: 'quote'; children: InlineNode[] }
  | { kind: 'table'; header: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: 'rule' };

/**
 * 单次解析的输入上限（字符）。
 *
 * 后端读取 README 时已有 64 KB 的上限（`MAX_README_BYTES`），这里再设一道是
 * 因为解析器也可能被别处调用（例如插件清单里的长描述），而它自身不该依赖
 * "调用方一定会先截断"这个前提。超出部分直接丢弃 —— 截断得越早，越不可能
 * 出现"界面卡住而看不出原因"。
 */
export const MAX_MARKDOWN_CHARS = 200_000;

/** 单次解析产出的块数上限，防止一份病态输入生成海量节点 */
export const MAX_MARKDOWN_BLOCKS = 4_000;

/** 内联嵌套深度上限（`**a *b* c**` 这类） */
const MAX_INLINE_DEPTH = 6;

/** 表格列数上限，防止一行里有几百个 `|` 时把布局撑坏 */
export const MAX_TABLE_COLUMNS = 16;

/** 可被反斜杠转义的字符 */
const ESCAPABLE = '\\`*_{}[]()#+-.!>|~';

// ============================================================
// 入口
// ============================================================

export function parseMarkdown(source: string): BlockNode[] {
  if (!source) return [];
  const normalized = source.slice(0, MAX_MARKDOWN_CHARS).replace(/\r\n?/g, '\n');
  return parseBlocks(normalized.split('\n'));
}

// ============================================================
// 块级解析
// ============================================================

function parseBlocks(lines: string[]): BlockNode[] {
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length && blocks.length < MAX_MARKDOWN_BLOCKS) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 围栏代码块。**必须排在其它规则之前**：代码块里的 `#`、`|`、`-` 都不是语法。
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      const closing = new RegExp(`^\\s{0,3}\\${marker}{${length},}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      // 跳过收尾的围栏（若存在）
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', language: fence[2] ?? '', text: body.join('\n') });
      continue;
    }

    // ATX 标题
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }

    // 分隔线。放在列表之前：`---` 也是一个合法的无序列表项标记，
    // 但三个以上的横线按约定是分隔线（CommonMark 同此）。
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    // 表格：当前行是表头、下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const header = splitTableRow(line);
      const rows: InlineNode[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    // 引用块：把连续的 `>` 行合并成一个段落。
    //
    // 实测的 6 处引用都是"一个段落、硬折行"，因此不实现引用块内的多段落 ——
    // 那需要递归解析块，而收益是零。折行由 `joinSoftLines` 按 CJK 规则拼接。
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', children: parseInline(joinSoftLines(quoted)) });
      continue;
    }

    // 列表（实测无嵌套、无续行，因此只做扁平解析）
    const listMatch = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const item = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!item) break;
        // 有序与无序不能混进同一个列表
        if (/\d/.test(item[1]) !== ordered) break;
        items.push(parseInline(item[2]));
        i += 1;
        // 缩进的后续行按续行处理（拼到当前项末尾）。
        // 实测数据里没有，但把它当成新段落会让这类内容看起来"掉了"。
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s{0,3}([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const last = items[items.length - 1];
          const text = (last[last.length - 1] as { text?: string })?.text;
          const extra = lines[i].trim();
          if (last.length && typeof text === 'string') {
            last[last.length - 1] = { kind: 'text', text: joinSoftLines([text, extra]) };
          } else {
            last.push({ kind: 'text', text: extra });
          }
          i += 1;
        }
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // 段落：累积到空行或下一个块级构造为止
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length === 0) {
      // 兜底：当前行是个无法识别的构造，按单行段落处理，保证内容不丢
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(joinSoftLines(paragraph)) });
  }

  return blocks;
}

/** 当前行是否会开启一个新的块级构造 */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  if (/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.test(line)) return true;
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(line)) return true;
  if (line.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) return true;
  return false;
}

/**
 * 把硬折行的多行合并成一个逻辑行。
 *
 * **CJK 行之间不插空格。** CommonMark 规定软换行等价于一个空格，那对英文是对的，
 * 但中文段落里会多出可见的空格（「但依据 作者」）。判定规则是：只要相邻两侧有
 * 一侧是 CJK 或全角标点，就直接拼接。
 */
export function joinSoftLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) {
      out = line;
      continue;
    }
    const last = out[out.length - 1];
    const first = line[0];
    out += isCjk(last) || isCjk(first) ? line : ` ${line}`;
  }
  return out;
}

function isCjk(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // 部首扩展 ~ CJK 统一表意文字
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0xff00 && code <= 0xffef) // 全角字符
  );
}

// ============================================================
// 表格
// ============================================================

function isDelimiterRow(line: string): boolean {
  const cells = splitTableCells(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): InlineNode[][] {
  return splitTableCells(line)
    .slice(0, MAX_TABLE_COLUMNS)
    .map((cell) => parseInline(cell.trim()));
}

/**
 * 按未转义、且不在行内代码里的 `|` 切分单元格。
 *
 * 这一条必须实测：README 的表格里写着 `\u{XXXXX}` 与 `a | b` 这类内容，
 * 天真地 `split('|')` 会把它们切成错位的列。
 */
export function splitTableCells(line: string): string[] {
  let text = line.trim();
  // 去掉首尾的边框竖线（只去一层）
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

  const cells: string[] = [];
  let buffer = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < text.length) {
      buffer += ch + text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const run = countRun(text, i, '`');
      const close = text.indexOf('`'.repeat(run), i + run);
      if (close > i + run) {
        buffer += text.slice(i, close + run);
        i = close + run;
        continue;
      }
    }

    if (ch === '|') {
      cells.push(buffer);
      buffer = '';
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }
  cells.push(buffer);

  return cells;
}

// ============================================================
// 行内解析
// ============================================================

export function parseInline(source: string): InlineNode[] {
  return parseInlineDepth(source, 0);
}

function parseInlineDepth(source: string, depth: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  if (!source) return nodes;

  let buffer = '';
  let i = 0;

  const flushText = () => {
    if (buffer) {
      nodes.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  while (i < source.length) {
    const ch = source[i];

    // 反斜杠转义
    if (ch === '\\' && i + 1 < source.length && ESCAPABLE.includes(source[i + 1])) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }

    // 行内代码**优先于一切**：它内部的 `*`、`_`、`[` 都是字面量
    if (ch === '`') {
      const run = countRun(source, i, '`');
      const close = source.indexOf('`'.repeat(run), i + run);
      if (close > i + run) {
        flushText();
        nodes.push({ kind: 'code', text: source.slice(i + run, close).trim() });
        i = close + run;
        continue;
      }
    }

    // 图片
    if (ch === '!' && source[i + 1] === '[') {
      const parsed = parseLinkLike(source, i + 1);
      if (parsed) {
        flushText();
        const href = parsed.href;
        if (isSafeLinkTarget(href)) {
          // alt 取标签的**纯文本**：`![**粗**图](...)` 的 alt 应当是「粗图」，
          // 而不是带星号的原文。这里必须先把标签解析成节点 —— 早先直接把它
          // 当字符串传给了 `plainText`，类型上不合法，运行时则静默得到空串。
          nodes.push({
            kind: 'image',
            href,
            alt: plainText(parseInlineDepth(parsed.label, depth + 1)),
          });
        } else {
          // 不安全的协议：按原文显示，既不生成图片也不生成链接
          nodes.push({ kind: 'text', text: source.slice(i, parsed.end) });
        }
        i = parsed.end;
        continue;
      }
    }

    // 链接
    if (ch === '[') {
      const parsed = parseLinkLike(source, i);
      if (parsed) {
        flushText();
        if (isSafeLinkTarget(parsed.href)) {
          nodes.push({
            kind: 'link',
            href: parsed.href,
            children: parseInlineDepth(parsed.label, depth + 1),
          });
        } else {
          nodes.push({ kind: 'text', text: source.slice(i, parsed.end) });
        }
        i = parsed.end;
        continue;
      }
    }

    // 粗体（必须先于斜体判断，否则 `**` 会被当成两个斜体定界符）
    if ((ch === '*' || ch === '_') && source[i + 1] === ch && depth < MAX_INLINE_DEPTH) {
      if (canOpen(source, i, ch)) {
        const marker = ch + ch;
        const close = findClosing(source, i + 2, marker, ch === '_');
        if (close > i + 2) {
          flushText();
          nodes.push({
            kind: 'strong',
            children: parseInlineDepth(source.slice(i + 2, close), depth + 1),
          });
          i = close + 2;
          continue;
        }
      }
    }

    // 斜体
    if ((ch === '*' || ch === '_') && depth < MAX_INLINE_DEPTH) {
      if (canOpen(source, i, ch)) {
        const close = findClosing(source, i + 1, ch, ch === '_');
        if (close > i + 1) {
          const inner = source.slice(i + 1, close);
          // 内容首尾不能是空白（`* 3 *` 不是斜体，`2 * 3 * 4` 也不是）
          if (inner.trim() === inner && inner.length > 0) {
            flushText();
            nodes.push({ kind: 'em', children: parseInlineDepth(inner, depth + 1) });
            i = close + 1;
            continue;
          }
        }
      }
    }

    buffer += ch;
    i += 1;
  }

  flushText();
  return nodes;
}

/** 统计从 `start` 开始连续出现多少个 `ch` */
function countRun(source: string, start: number, ch: string): number {
  let n = 0;
  while (start + n < source.length && source[start + n] === ch) n += 1;
  return n;
}

/**
 * 定界符能否开启一个强调。
 *
 * **下划线要额外要求词边界。** 否则 `plugin_storage_get`、`sidebar_config.json`
 * 这类标识符会被成对的下划线当成斜体吃掉 —— 而插件 README 里到处是这种名字。
 * 星号没有这个问题（标识符里不会出现），因此不额外限制。
 */
function canOpen(source: string, index: number, marker: string): boolean {
  const after = source[index + 1];
  if (after === undefined || /\s/.test(after)) return false;
  if (marker === '_') {
    const before = source[index - 1];
    if (before !== undefined && /[A-Za-z0-9_]/.test(before)) return false;
  }
  return true;
}

/**
 * 找强调的收尾定界符。
 *
 * 扫描时跳过转义字符与行内代码 —— 否则 `**a `b*` c**` 会在代码里的那个 `*` 上
 * 提前收尾，把剩下的内容甩到强调外面。
 */
function findClosing(
  source: string,
  from: number,
  marker: string,
  underscoreBoundary: boolean
): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === '`') {
      const run = countRun(source, i, '`');
      const close = source.indexOf('`'.repeat(run), i + run);
      i = close < 0 ? i + run : close + run;
      continue;
    }

    if (source.startsWith(marker, i)) {
      const before = source[i - 1];
      const after = source[i + marker.length];
      const precededByNonSpace = before !== undefined && !/\s/.test(before);
      // 收尾定界符后面不能再跟同类字符（避免把 `***` 拆错）
      const notFollowedByMarker = after !== marker[0];
      // 下划线收尾后不能紧跟字母数字，否则会吃掉标识符的后半段
      const boundaryOk = !underscoreBoundary || after === undefined || !/[A-Za-z0-9_]/.test(after);
      if (precededByNonSpace && notFollowedByMarker && boundaryOk) return i;
    }

    i += 1;
  }
  return -1;
}

/** 解析 `[label](href)` 或 `[label](href "title")`，返回标签、目标与结束位置 */
function parseLinkLike(
  source: string,
  start: number
): { label: string; href: string; end: number } | null {
  if (source[start] !== '[') return null;
  const labelEnd = findUnescaped(source, ']', start + 1);
  if (labelEnd < 0 || source[labelEnd + 1] !== '(') return null;

  const hrefEnd = findUnescaped(source, ')', labelEnd + 2);
  if (hrefEnd < 0) return null;

  const rawTarget = source.slice(labelEnd + 2, hrefEnd).trim();
  // 允许 `href "title"` 形式：标题部分丢掉即可，它不影响安全判定
  const href = rawTarget.replace(/\s+"[^"]*"$/, '').trim();
  if (!href) return null;

  return { label: source.slice(start + 1, labelEnd), href, end: hrefEnd + 1 };
}

function findUnescaped(source: string, target: string, from: number): number {
  let i = from;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === target) return i;
    i += 1;
  }
  return -1;
}

/** 允许的链接协议。其余一律不生成链接节点 */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

export function isSafeLinkTarget(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  // 无协议的相对链接与锚点：不生成可点击链接（应用里没有"当前页面"可供相对跳转）
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!scheme) return false;
  return SAFE_SCHEMES.includes(`${scheme[1].toLowerCase()}:`);
}

/** 取一个行内节点序列的纯文本（用于图片的 alt） */
export function plainText(nodes: InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.text;
        break;
      case 'code':
        out += node.text;
        break;
      case 'strong':
      case 'em':
      case 'link':
        out += plainText(node.children);
        break;
      case 'image':
        out += node.alt;
        break;
    }
  }
  return out;
}
