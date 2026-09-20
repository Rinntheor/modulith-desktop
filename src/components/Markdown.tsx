// src/components/Markdown.tsx
//
// 把 `utils/markdown.ts` 解析出的 AST 渲染成 React 元素。
//
// ============================================================
// 三条不能改的实现约束
// ============================================================
//
// 1. **不使用 `dangerouslySetInnerHTML`，也不用把 Markdown 拼成 HTML。**
//    README 是远程内容，而插件与宿主共享同一个 JS 上下文。渲染成 React 元素
//    意味着源码里的 HTML 在结构上只能作为**文本**显示出来 —— 这是类型上的保证，
//    不是"记得消毒"的约定。本文件里没有那条通路，将来也不该加。
//
// 2. **链接必须拦截点击并交给系统浏览器。** `<a href>` 在 WebView 里点击会让
//    整个应用导航到那个地址（界面被替换、状态全丢），比打开不了更糟。因此
//    `target` 与 `rel` 只是语义装饰，真正的行为在 `onClick` 里：`preventDefault()`
//    然后交给 `openUrl`。这也是唯一一处能从插件内容触发外部程序的地方，因此
//    协议白名单在解析层（`isSafeLinkTarget`）就完成了，到这里只剩 http/https/mailto。
//
// 3. **只使用深色映射表里已有的工具类。** 项目用一张全局映射表实现深色模式
//    （见 `dark-theme.css`），新写的类名若不在表里，深色下就会退回浅色。
//    `scripts/check-theme.ts` 会扫描本文件里的半透明背景 token，因此写错会直接
//    在 `pnpm check:theme` 里失败。
//
// ============================================================
// 两个刻意的观感取舍
// ============================================================
//
// * **图片渲染成链接，而不是 `<img>`。** 直接渲染会让打开插件详情这个动作**隐式
//   发起一次对第三方主机的请求**（等于告诉对方"这个用户看了这个插件页"）。
//   应用里所有联网都收在 `ctx.http` 与更新检查那两条受控链路上，不该为一张说明
//   图片破例。插件 README 实测没有用到图片，因此代价接近零。
// * **代码块不做语法高亮。** 那需要引入一个高亮库，而 README 里的代码片段多为
//   命令与文件名，等宽字体已经足够辨识。

import React, { useCallback, useMemo } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';

import {
  parseMarkdown,
  type BlockNode,
  type InlineNode,
} from '../utils/markdown';
import { showToast } from '../services/toast';

interface MarkdownProps {
  source: string;
  /** 追加在最外层容器上的类名 */
  className?: string;
}

/** 标题层级 → 字号。抽屉里空间有限，一级标题不该占掉半屏 */
const HEADING_CLASS: Record<number, string> = {
  1: 'text-base font-semibold text-gray-900 mt-4 first:mt-0',
  2: 'text-sm font-semibold text-gray-900 mt-4 first:mt-0',
  3: 'text-xs font-semibold text-gray-800 mt-3 first:mt-0',
  4: 'text-xs font-semibold text-gray-700 mt-3 first:mt-0',
  5: 'text-xs font-medium text-gray-700 mt-2 first:mt-0',
  6: 'text-xs font-medium text-gray-600 mt-2 first:mt-0',
};

/**
 * 打开外部链接。
 *
 * 失败时**必须让用户知道**：点了没反应与"打不开"在用户看来是两件事，而这里
 * 静默失败会让人以为是界面卡了。与项目里其它"不要静默失败"的地方一致。
 */
function useExternalLink(): (href: string) => void {
  return useCallback((href: string) => {
    void openUrl(href).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      showToast({ title: '无法打开链接', body: message, level: 'error' });
    });
  }, []);
}

const Inline: React.FC<{ nodes: InlineNode[]; onOpenLink: (href: string) => void }> = ({
  nodes,
  onOpenLink,
}) => (
  <>
    {nodes.map((node, index) => {
      switch (node.kind) {
        case 'text':
          return <React.Fragment key={index}>{node.text}</React.Fragment>;

        case 'code':
          return (
            <code
              key={index}
              className="px-1 py-0.5 rounded bg-gray-100 text-gray-800 font-mono text-[0.95em] break-all"
            >
              {node.text}
            </code>
          );

        case 'strong':
          return (
            <strong key={index} className="font-semibold text-gray-900">
              <Inline nodes={node.children} onOpenLink={onOpenLink} />
            </strong>
          );

        case 'em':
          return (
            <em key={index}>
              <Inline nodes={node.children} onOpenLink={onOpenLink} />
            </em>
          );

        case 'link':
          return (
            <a
              key={index}
              href={node.href}
              rel="noreferrer"
              title={node.href}
              onClick={(event) => {
                // 见文件头第 2 条：不拦截就等于让应用导航走
                event.preventDefault();
                onOpenLink(node.href);
              }}
              className="text-indigo-600 hover:underline cursor-pointer break-all"
            >
              <Inline nodes={node.children} onOpenLink={onOpenLink} />
            </a>
          );

        case 'image':
          // 见文件头：不隐式发起远程请求，降级成一个可点击的链接
          return (
            <a
              key={index}
              href={node.href}
              rel="noreferrer"
              title={node.href}
              onClick={(event) => {
                event.preventDefault();
                onOpenLink(node.href);
              }}
              className="text-indigo-600 hover:underline cursor-pointer break-all"
            >
              {node.alt ? `[图片：${node.alt}]` : '[图片]'}
            </a>
          );
      }
    })}
  </>
);

const Block: React.FC<{ block: BlockNode; onOpenLink: (href: string) => void }> = ({
  block,
  onOpenLink,
}) => {
  switch (block.kind) {
    case 'heading':
      return (
        <p className={HEADING_CLASS[block.level] ?? HEADING_CLASS[6]}>
          <Inline nodes={block.children} onOpenLink={onOpenLink} />
        </p>
      );

    case 'paragraph':
      return (
        <p className="mt-2 first:mt-0 leading-relaxed">
          <Inline nodes={block.children} onOpenLink={onOpenLink} />
        </p>
      );

    case 'code':
      return (
        <div className="mt-2">
          {block.language && (
            <span className="inline-block mb-1 text-[10px] font-mono text-gray-400">
              {block.language}
            </span>
          )}
          <pre className="rounded-lg bg-gray-50 border border-gray-100 p-2.5 overflow-x-auto custom-scrollbar">
            <code className="font-mono text-[0.95em] text-gray-700 whitespace-pre">
              {block.text}
            </code>
          </pre>
        </div>
      );

    case 'list':
      return block.ordered ? (
        <ol className="mt-2 ml-4 list-decimal space-y-1">
          {block.items.map((item, index) => (
            <li key={index} className="leading-relaxed">
              <Inline nodes={item} onOpenLink={onOpenLink} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="mt-2 ml-4 list-disc space-y-1">
          {block.items.map((item, index) => (
            <li key={index} className="leading-relaxed">
              <Inline nodes={item} onOpenLink={onOpenLink} />
            </li>
          ))}
        </ul>
      );

    case 'quote':
      return (
        <blockquote className="mt-2 pl-3 border-l-2 border-gray-200 text-gray-600">
          <Inline nodes={block.children} onOpenLink={onOpenLink} />
        </blockquote>
      );

    case 'table':
      return (
        <div className="mt-2 overflow-x-auto custom-scrollbar">
          <table className="w-full border-collapse text-[0.95em]">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    className="border border-gray-200 bg-gray-50 px-2 py-1 text-left font-medium text-gray-700 whitespace-nowrap"
                  >
                    <Inline nodes={cell} onOpenLink={onOpenLink} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {/* 列数不齐时按表头补齐：缺的留空、多的截断 —— 见 MAX_TABLE_COLUMNS */}
                  {block.header.map((_, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="border border-gray-200 px-2 py-1 align-top text-gray-600"
                    >
                      <Inline nodes={row[cellIndex] ?? []} onOpenLink={onOpenLink} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'rule':
      return <hr className="mt-3 border-gray-200" />;
  }
};

/**
 * Markdown 渲染。
 *
 * 解析结果按 `source` 记忆化：抽屉会因为悬停、加载状态等频繁重渲染，而每次
 * 重新解析一份最长 64 KB 的 README 是纯浪费 —— 内容不变时 AST 也不变。
 */
const Markdown: React.FC<MarkdownProps> = React.memo(({ source, className }) => {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const onOpenLink = useExternalLink();

  if (blocks.length === 0) return null;

  return (
    <div className={`text-xs text-gray-700 ${className ?? ''}`}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} onOpenLink={onOpenLink} />
      ))}
    </div>
  );
});

Markdown.displayName = 'Markdown';

export default Markdown;
