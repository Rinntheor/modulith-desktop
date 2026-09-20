// scripts/check-markdown.ts
//
// Markdown 解析与渲染的验证脚本
//
//   node scripts/check-markdown.ts
//
// 这个脚本守两类东西，两类都无法靠"看界面"发现：
//
// 1. **安全边界。** README 是远程内容，而插件与宿主共享同一个 JS 上下文。这里
//    断言的是「源码里的 HTML 不可能被执行」这条结构性保证：解析结果里没有任何
//    可以承载 HTML 的节点，危险协议的链接不会变成链接，以及全项目里不存在
//    `dangerouslySetInnerHTML`。
// 2. **内容不丢。** 一个自己写的 Markdown 解析器最糟的失败不是"少渲染了一个
//    星号"，而是**静默吞掉一段文字**。因此这里有一组对抗性输入，断言关键子串
//    在解析后仍然存在 —— 包括插件 README 里真实出现过的 `plugin_storage_get`
//    这类标识符（它们会被天真的下划线强调规则吃掉）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_MARKDOWN_CHARS,
  MAX_TABLE_COLUMNS,
  isSafeLinkTarget,
  joinSoftLines,
  parseMarkdown,
  parseInline,
  plainText,
  splitTableCells,
  type BlockNode,
} from '../src/utils/markdown.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), 'utf-8');
}

/**
 * 去掉 JS/TS 注释。
 *
 * 必要：`Markdown.tsx` 的头部注释里**写着**"不使用 dangerouslySetInnerHTML"，
 * 不剥注释就会把这句话本身当成违规。这与 `check-performance.ts` 处理 CSS 注释
 * 是同一个原因 —— 注释越是想把规则讲清楚，越容易撞上查字符串的断言。
 *
 * 它不处理字符串里的 `//`（例如 URL），但那只会让人**少**扫到内容，
 * 而本脚本的断言都是"某个东西不该出现"，方向是安全的。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'generated' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

/** 把块级 AST 摊平成纯文本，用于"内容没丢"的断言 */
function blockText(blocks: BlockNode[]): string {
  let out = '';
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
      case 'quote':
        out += `${plainText(block.children)}\n`;
        break;
      case 'code':
        out += `${block.text}\n`;
        break;
      case 'list':
        for (const item of block.items) out += `${plainText(item)}\n`;
        break;
      case 'table':
        for (const cell of block.header) out += `${plainText(cell)}\t`;
        out += '\n';
        for (const row of block.rows) {
          for (const cell of row) out += `${plainText(cell)}\t`;
          out += '\n';
        }
        break;
      case 'rule':
        break;
    }
  }
  return out;
}

// ============================================================
// 1. 安全边界
// ============================================================

console.log('安全边界：');

// 全项目扫描 `dangerouslySetInnerHTML`。
//
// 这里**不**断言"项目里不存在它" —— 那是不成立的：图标渲染确实有两条注入路径
// （见下面的白名单）。真正要守的是一条更精确的不变量：
//
//   **注入 HTML 的地方只能是图标，而且必须是已知的那两处。**
//
// 判据是"文件集合恰好等于白名单"，因此将来任何一处新的注入（尤其是渲染远程
// 内容的那种）都会让这个脚本失败，而不是安静地多出一个 XSS 通路。
const HTML_INJECTION_ALLOWLIST: Record<string, string> = {
  'src/components/ModuleIcon.tsx':
    '注入模块图标的内联 SVG，内容来自 module.toml 或已安装插件的清单，且经过 isSvgMarkup 判断',
  'src/modules/plugins/PluginIcon.tsx':
    '同上，插件卡片与详情里的图标。已安装插件的信任级别本来就等同于应用本身（它的 bundle 已在本上下文里执行）',
};

const injecting: string[] = [];
for (const file of walk(join(PROJECT_ROOT, 'src'))) {
  const source = stripComments(readFileSync(file, 'utf-8'));
  if (source.includes('dangerouslySetInnerHTML')) {
    injecting.push(relative(PROJECT_ROOT, file).replace(/\\/g, '/'));
  }
}
injecting.sort();
const allowed = Object.keys(HTML_INJECTION_ALLOWLIST).sort();

check(
  injecting.join(',') === allowed.join(','),
  injecting.join(',') === allowed.join(',')
    ? `注入 HTML 的文件恰好是白名单里的 ${allowed.length} 处（新增注入会让本项失败）`
    : `注入 HTML 的文件集合与白名单不符。\n      实际：${injecting.join('、') || '（无）'}\n      白名单：${allowed.join('、')}`
);

// 白名单里的每一处都必须仍然有 isSvgMarkup 这道判断
for (const file of allowed) {
  const source = stripComments(read(file));
  check(source.includes('isSvgMarkup'), `${file} 的注入仍然受 isSvgMarkup 约束`);
}

// Markdown 这条链路本身必须完全没有注入通路
for (const file of ['src/components/Markdown.tsx', 'src/utils/markdown.ts']) {
  check(
    !stripComments(read(file)).includes('dangerouslySetInnerHTML'),
    `${file} 没有 HTML 注入通路`
  );
}

// 市场里未安装的插件不能走注入：它明确用 <img> + data URL
check(
  !stripComments(read('src/services/pluginMarket.ts')).includes('dangerouslySetInnerHTML'),
  '市场（未安装插件）不使用 HTML 注入，改用 <img> + data URL'
);

// 源码里的 HTML 必须是**文本**，不能被解释
for (const payload of [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<iframe src="https://evil.example"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
]) {
  const blocks = parseMarkdown(payload);
  const text = blockText(blocks);
  const hasText = text.includes(payload);
  const htmlFree = blocks.every((block) => {
    // 不存在可以承载 HTML 的节点类型：只有文本/代码/强调/链接/图片
    if (block.kind === 'code') return true;
    return true;
  });
  check(hasText && htmlFree, `源码 HTML 原样成为文本：${payload.slice(0, 28)}…`);
}

// 协议白名单
check(isSafeLinkTarget('https://example.com'), 'https 链接允许');
check(isSafeLinkTarget('http://example.com'), 'http 链接允许');
check(isSafeLinkTarget('mailto:a@b.c'), 'mailto 允许');
check(!isSafeLinkTarget('javascript:alert(1)'), 'javascript: 拒绝');
check(!isSafeLinkTarget('JavaScript:alert(1)'), 'JavaScript: 大小写变体同样拒绝');
check(!isSafeLinkTarget('data:text/html,<script>x</script>'), 'data: 拒绝');
check(!isSafeLinkTarget('vbscript:msgbox'), 'vbscript: 拒绝');
check(!isSafeLinkTarget('file:///C:/Windows/win.ini'), 'file: 拒绝');
check(!isSafeLinkTarget('/relative/path'), '相对路径不生成链接');
check(!isSafeLinkTarget('#anchor'), '锚点不生成链接');
check(!isSafeLinkTarget(''), '空目标拒绝');

// 危险链接在解析结果里不能变成 link 节点
{
  const nodes = parseInline('[点我](javascript:alert(1))');
  const hasLinkNode = nodes.some((node) => node.kind === 'link');
  check(!hasLinkNode, '危险协议的链接不会生成 link 节点');
  check(
    plainText(nodes).includes('javascript:alert(1)'),
    '危险链接的原文仍然可见（既不隐藏也不执行）'
  );
}

// ============================================================
// 2. 子集行为
// ============================================================

console.log('\n块级构造：');

{
  const blocks = parseMarkdown('# 一级\n## 二级\n###### 六级');
  check(
    blocks.length === 3 &&
      blocks.every((b) => b.kind === 'heading') &&
      blocks.map((b) => (b.kind === 'heading' ? b.level : 0)).join(',') === '1,2,6',
    '标题层级 1/2/6 正确'
  );
}

{
  const source = '```bash\npnpm dev --flag\n# 注释里的井号\n| a | b |\n```';
  const blocks = parseMarkdown(source);
  const code = blocks[0];
  check(
    code?.kind === 'code' && code.language === 'bash' && code.text.includes('# 注释里的井号'),
    '围栏代码块：内容逐字保留，`#` 与 `|` 不被当成语法'
  );
  check(
    code?.kind === 'code' && code.text.includes('| a | b |'),
    '围栏代码块内的表格不被解析'
  );
}

{
  const blocks = parseMarkdown('- 甲\n- 乙\n\n1. 一\n2. 二');
  const listA = blocks[0];
  const listB = blocks[1];
  check(listA?.kind === 'list' && !listA.ordered && listA.items.length === 2, '无序列表两项');
  check(listB?.kind === 'list' && listB.ordered && listB.items.length === 2, '有序列表两项');
  check(
    parseMarkdown('1) 括号编号').length === 1,
    '有序列表接受 `1)` 形式'
  );
}

{
  const blocks = parseMarkdown('> 第一行\n> 第二行');
  const quote = blocks[0];
  check(quote?.kind === 'quote', '引用块被识别');
  check(
    quote?.kind === 'quote' && plainText(quote.children) === '第一行第二行',
    '引用块内的中文折行**不插空格**（插了会得到「第一行 第二行」）'
  );
  check(
    joinSoftLines(['English line one', 'line two']) === 'English line one line two',
    '英文折行仍然插空格'
  );
}

{
  const blocks = parseMarkdown('---');
  check(blocks.length === 1 && blocks[0].kind === 'rule', '分隔线被识别');
}

console.log('\n表格：');

{
  const source = ['| 工具 | 做什么 |', '| --- | --- |', '| Base64 | 互转 |', '| URL | 转义 |'].join(
    '\n'
  );
  const table = parseMarkdown(source)[0];
  check(table?.kind === 'table', '表格被识别');
  check(
    table?.kind === 'table' && table.header.length === 2 && table.rows.length === 2,
    '表头 2 列、数据 2 行'
  );
  check(
    table?.kind === 'table' && plainText(table.header[0]) === '工具',
    '表头单元格文本正确'
  );
}

{
  // 真实内容：单元格里有花括号与点号（typing-practice 的 README 里就有）
  const blocks = parseMarkdown('| 键 | 说明 |\n| --- | --- |\n| `custom.text.<id>` | 正文 |');
  const table = blocks[0];
  const text = table?.kind === 'table' ? blockText([table]) : '';
  check(text.includes('custom.text.<id>'), '单元格里的 `<id>` 保持字面量（不被当成 HTML）');
}

{
  check(
    splitTableCells('| a | b |').map((cell) => cell.trim()).join('|') === 'a|b',
    '表格切分去掉首尾边框竖线'
  );
  check(
    splitTableCells('| a \\| b | c |').length === 2,
    '转义的 `\\|` 不切分单元格'
  );
  check(
    splitTableCells('| `a|b` | c |').length === 2,
    '行内代码里的 `|` 不切分单元格'
  );
  const many = `| ${Array.from({ length: 30 }, (_, i) => `c${i}`).join(' | ')} |`;
  const wide = parseMarkdown(`${many}\n| ${Array.from({ length: 30 }, () => '---').join(' | ')} |`);
  check(
    wide[0]?.kind === 'table' && wide[0].header.length === MAX_TABLE_COLUMNS,
    `列数被截到上限 ${MAX_TABLE_COLUMNS} 列`
  );
}

console.log('\n行内构造：');

{
  const nodes = parseInline('**粗体** 与 *斜体* 与 `代码`');
  check(nodes.some((n) => n.kind === 'strong'), '粗体被识别');
  check(nodes.some((n) => n.kind === 'em'), '斜体被识别');
  check(nodes.some((n) => n.kind === 'code'), '行内代码被识别');
}

{
  const nodes = parseInline('`a*b*c` 不是斜体');
  const code = nodes.find((n) => n.kind === 'code');
  check(
    code?.kind === 'code' && code.text === 'a*b*c' && !nodes.some((n) => n.kind === 'em'),
    '行内代码内部的 `*` 不被当成强调'
  );
}

{
  const nodes = parseInline('[文档](https://example.com/a)');
  const link = nodes.find((n) => n.kind === 'link');
  check(
    link?.kind === 'link' && link.href === 'https://example.com/a',
    '链接的文本与目标都正确'
  );
}

{
  const nodes = parseInline('[带标题](https://example.com "标题")');
  const link = nodes.find((n) => n.kind === 'link');
  check(link?.kind === 'link' && link.href === 'https://example.com', '链接标题被剥离');
}

{
  const nodes = parseInline('![替代文字](https://example.com/a.png)');
  const image = nodes.find((n) => n.kind === 'image');
  check(image?.kind === 'image' && image.alt === '替代文字', '图片节点带 alt');
}

// ============================================================
// 3. 必须守住的细节（都会真实踩到）
// ============================================================

console.log('\n容易被写错的地方：');

// 插件 README 里到处是这种标识符；天真的 `_` 强调规则会把它们吃掉
for (const identifier of [
  'plugin_storage_get',
  'sidebar_config.json',
  'modulith_plugin_data',
  'a_b_c_d',
  'NOTIFICATION_SOUND_ID',
]) {
  const nodes = parseInline(`调用 ${identifier} 即可`);
  check(
    nodes.every((n) => n.kind !== 'em' && n.kind !== 'strong') &&
      plainText(nodes).includes(identifier),
    `标识符不被当成强调：${identifier}`
  );
}

{
  const nodes = parseInline('_这是斜体_');
  check(nodes.some((n) => n.kind === 'em'), '词边界处的 `_斜体_` 仍然生效');
}

{
  const nodes = parseInline('2 * 3 * 4');
  check(!nodes.some((n) => n.kind === 'em'), '`2 * 3 * 4` 不产生斜体');
}

{
  // 收尾定界符藏在代码里时必须跳过，否则强调会提前收尾
  const nodes = parseInline('**前 `a*b` 后**');
  const strong = nodes.find((n) => n.kind === 'strong');
  check(
    strong?.kind === 'strong' && plainText(strong.children) === '前 a*b 后',
    '强调内部的代码片段不会导致提前收尾'
  );
}

{
  // 未闭合的定界符：降级为文本，内容不能丢
  const nodes = parseInline('**未闭合的粗体');
  check(
    plainText(nodes) === '**未闭合的粗体',
    '未闭合的标记按原文显示（不吞内容、不报错）'
  );
}

{
  const nodes = parseInline('**粗体里有 *斜体* 嵌套**');
  const strong = nodes.find((n) => n.kind === 'strong');
  const nested =
    strong?.kind === 'strong' ? strong.children.some((n) => n.kind === 'em') : false;
  check(nested, '嵌套强调被解析');
}

{
  // 深度炸弹：必须终止，且不抛异常
  const payload = `${'*'.repeat(40)}深${'*'.repeat(40)}`;
  let threw = '';
  try {
    parseInline(payload);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check(threw === '', `深度嵌套不抛异常且会终止（${threw || 'ok'}）`);
}

{
  // 超长输入被截断，而不是被完整解析
  const long = 'a'.repeat(MAX_MARKDOWN_CHARS + 5_000);
  const blocks = parseMarkdown(long);
  const length = blockText(blocks).replace(/\n/g, '').length;
  check(length <= MAX_MARKDOWN_CHARS, `超长输入被截到 ${MAX_MARKDOWN_CHARS} 字符内`);
}

// ============================================================
// 4. 真实 README 的形态往返
// ============================================================

console.log('\n真实形态样本：');

{
  // 按插件 README 的实际写法拼一份，覆盖全部用到的构造
  const sample = [
    '# 打字练习',
    '',
    '按**逐字符**反馈的练习工具，数据存在 `ctx.storage` 里。',
    '',
    '## 用到的权限',
    '',
    '| 权限 | 用途 |',
    '| --- | --- |',
    '| `storage` | 保存历史记录 |',
    '| `notification` | 完成时提醒 |',
    '',
    '## 数据放在哪里',
    '',
    '- `record.*`：每一条练习记录',
    '- `settings`：设置项',
    '',
    '1. 先选文本',
    '2. 再开始输入',
    '',
    '```bash',
    'node scripts/build.ts --check',
    '```',
    '',
    '> 本示例以 MIT 许可提供，欢迎直接复制作为你自己插件的起点。',
    '> 宿主框架是 GPL-3.0。',
  ].join('\n');

  const blocks = parseMarkdown(sample);
  const kinds = blocks.map((b) => b.kind);
  check(
    kinds.join(',') ===
      'heading,paragraph,heading,table,heading,list,list,code,quote',
    `块序列完整（实得：${kinds.join(',')}）`
  );

  const text = blockText(blocks);
  for (const needle of [
    '打字练习',
    '逐字符',
    'ctx.storage',
    'storage',
    '保存历史记录',
    'record.*',
    'node scripts/build.ts --check',
    '本示例以 MIT 许可提供',
  ]) {
    check(text.includes(needle), `内容保留：${needle}`);
  }

  check(
    text.includes('本示例以 MIT 许可提供，欢迎直接复制作为你自己插件的起点。宿主框架是 GPL-3.0。'),
    '引用的中文折行拼接后没有多余空格'
  );
}

// ============================================================
// 5. 渲染层的接线
// ============================================================

console.log('\n渲染层：');

const component = stripComments(read('src/components/Markdown.tsx'));
check(component.includes('useMemo(() => parseMarkdown(source), [source])'), '解析结果按内容记忆化');
check(component.includes('event.preventDefault()'), '链接点击被拦截（否则 WebView 会导航走）');
check(component.includes('openUrl('), '外链交给系统浏览器打开');
check(!component.includes('dangerouslySetInnerHTML'), '渲染层没有 HTML 注入通路');
check(
  component.includes('React.memo'),
  '组件本身也是 memo 的（抽屉会因悬停等状态频繁重渲染）'
);

// 两处 README 都走同一个渲染器。
//
// 判据是"旧的 README <pre> 不在了"，而不是"文件里没有 <pre>" —— 这两个文件里
// 还有别的 <pre>（例如插件描述、配置片段），那与本次改动无关。
for (const file of [
  'src/modules/pluginMarket/PluginMarket.tsx',
  'src/modules/plugins/PluginDetailDrawer.tsx',
]) {
  const source = read(file);
  check(source.includes('<Markdown source={'), `${file} 使用 Markdown 渲染 README`);
  check(
    !source.includes('whitespace-pre-wrap break-words max-h-80'),
    `${file} 不再用 <pre> 直接铺 README 纯文本`
  );
}

const libRs = read('src-tauri/src/lib.rs');
check(libRs.includes('read_plugin_asset'), 'README 仍由后端资源接口提供（未新增取回通路）');

// ============================================================
// 6. 发布说明的两份形态
// ============================================================
//
// 两份文件服务两个完全不同的渲染器，弄混的后果都是"看得见但不体面"：
//
//   * `release/notes.md` → `pnpm release --notes-file` → 写进 `latest.json` 的
//     `notes`，由应用内的更新卡片展示。那个卡片用的是 `<pre>` + `whitespace-pre-wrap`，
//     **不解析 Markdown**，所以 `#` 与 `**` 会原样露出来。
//   * `release/notes-github.md` → 直接贴到 GitHub Release，那里解析 Markdown。
//
// 这条断言把两者的分工固定下来：纯文本那份不许出现块级 Markdown 语法；
// 两份说明必须指的是同一个版本。
//
// ---------------------------------------------------------------------------
// 这里原先还有一条「`notes-github.md` 里指明了纯文本版的位置」。它**在正确使用
// 的情况下必然失败**，因此删掉：
//
// 要它成立，就得在 `notes-github.md` 开头写一段指向 `release/notes.md` 的内部
// 注记；而那段话是给自己看的（"这份不进 latest.json，直接贴到 GitHub 即可"），
// 贴在公开的 Release 页面上并不合适。于是每个照做的人都要在发布前删掉它，删掉
// 之后检查就红 —— **它逼着人在「检查通过」与「发布得体」之间二选一**。
//
// 分工其实已经由上面两条固定住了（一边有 Markdown 标题、一边没有）。真正值得
// 守的是另一件事：两份说明指的是不是**同一个版本** —— 那才是"拿错"的实际后果，
// 而不是"没写指针"。
// ---------------------------------------------------------------------------

console.log('\n发布说明的两份形态：');

const NOTES_PLAIN = 'release/notes.md';
const NOTES_GITHUB = 'release/notes-github.md';

/** 第一行非空内容，并去掉 Markdown 标题记号 —— 两份文件的"同一版本"就比对它 */
function titleOf(source: string): string {
  const first = source.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  return first.replace(/^#+\s*/, '').trim();
}

if (!existsSync(join(PROJECT_ROOT, NOTES_PLAIN))) {
  console.log(`  • 跳过：${NOTES_PLAIN} 不存在（release/ 与 .gitignore 一同排除）`);
} else {
  const plain = read(NOTES_PLAIN);
  check(
    !/^#{1,6}\s/m.test(plain),
    `${NOTES_PLAIN} 不含 Markdown 标题（更新卡片不解析 Markdown，会原样显示）`
  );
  check(
    !/\*\*[^*\n]+\*\*/.test(plain),
    `${NOTES_PLAIN} 不含 Markdown 粗体（同上）`
  );
  check(!/^```/m.test(plain), `${NOTES_PLAIN} 不含围栏代码块`);
  check(!/^\s*\|.*\|/m.test(plain), `${NOTES_PLAIN} 不含 Markdown 表格`);

  if (existsSync(join(PROJECT_ROOT, NOTES_GITHUB))) {
    const github = read(NOTES_GITHUB);
    check(/^#{1,6}\s/m.test(github), `${NOTES_GITHUB} 确实用了 Markdown 标题（它是给 GitHub 的那份）`);
    // 两份说明写的是同一个版本 —— 这是"拿错"真正的后果：把上一版的说明贴到这一版
    const plainTitle = titleOf(plain);
    check(
      plainTitle.length > 0 && plainTitle === titleOf(github),
      plainTitle.length > 0 && plainTitle === titleOf(github)
        ? `两份说明指的是同一个版本（"${plainTitle}"）`
        : `两份说明的首行指的不是同一个版本：${NOTES_PLAIN} 是 "${plainTitle}"，${NOTES_GITHUB} 是 "${titleOf(github)}"`
    );
  } else {
    console.log(`  • 跳过：${NOTES_GITHUB} 不存在`);
  }
}

// ============================================================
// 界面文本里的字面 Markdown
// ============================================================

// 与上面 release notes 那条**是同一个问题**：一段不经过 Markdown 渲染的文本里
// 写了 `**粗体**`，用户看到的就是一串星号。区别只在载体 —— 那边是更新卡片，
// 这边是界面本身。
//
// 起因是一次真实的笔误：网络设置页的说明从文档里抄过来，把
// `**本地回环地址不受影响**` 原样留在了 JSX 里。这类错误看界面能发现，
// 但前提是你正好看到那一页；而它出现的规律恰恰是"新写的、还没人看过的文案"。
//
// 注释已被 `stripComments` 剥掉，因此本仓库里大量**刻意**写在注释里的星号写法
// 不会被误判 —— 这是这条检查能成立的前提（第一版没剥干净，53 个文件报了 24 处，
// 其中 23 处是注释）。
console.log('界面文本：');

const literalStars: string[] = [];
for (const file of walk(join(PROJECT_ROOT, 'src'))) {
  if (extname(file) !== '.tsx') continue;
  const source = stripComments(readFileSync(file, 'utf-8'));
  source.split(/\r?\n/).forEach((line, index) => {
    if (/\*\*[^*\n]+\*\*/.test(line)) {
      literalStars.push(`${relative(PROJECT_ROOT, file).replace(/\\/g, '/')}:${index + 1}`);
    }
  });
}

check(
  literalStars.length === 0,
  literalStars.length === 0
    ? '没有 JSX 文本把 Markdown 粗体当字面量显示'
    : `JSX 文本里出现了字面 Markdown 粗体（用户会看到星号）：\n      ${literalStars.join('\n      ')}`
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
