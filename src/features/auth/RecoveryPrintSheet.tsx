// src/features/auth/RecoveryPrintSheet.tsx
//
// 恢复码的可打印版本。
//
// 为什么用「应用内打印容器 + window.print()」而不是新开窗口：
//   1. 不引入依赖 —— 项目里没有 PDF 库，装一个（printpdf / genpdf 或
//      pdf-lib）是新的第三方依赖，与「不修改依赖」的前提冲突；
//   2. Print to PDF 由系统提供，用户得到的是真正的 PDF 文件；
//   3. WebView2 对 `window.open` 的支持并不稳定，弹窗还可能被拦截 ——
//      恢复码只在生成的那一刻存在，弹出失败意味着用户永久失去它。
//
// 机制：把这张纸渲染在一个 `.lc-print-sheet` 容器里，默认由 CSS 的
// `@media print` 规则隐藏屏上的一切、只显示它。因此非打印状态下它对用户
// 完全不可见，也不需要管理显隐状态。
//
// 打印样式定义在 `src/styles/global/index.css` 的 @media print 段，
// 那里同时强制浅色（白纸黑字）：深色主题的覆盖规则用属性选择器匹配工具类，
// 在这里会把内容刷成深色底，打出来既费墨又难读。

import React from 'react';
import { APP_INFO } from '../../config/appInfo';

interface RecoveryPrintSheetProps {
  /** 一组恢复码（带分组连字符） */
  codes: string[];
  /** 生成时间（ISO 8601） */
  createdAt?: string | null;
}

/** 本地化的生成时间；解析失败时原样返回，不显示 Invalid Date */
function formatMoment(iso: string | null | undefined): string {
  if (!iso) return new Date().toLocaleString();
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const RecoveryPrintSheet: React.FC<RecoveryPrintSheetProps> = ({ codes, createdAt }) => (
  <div className="lc-print-sheet" aria-hidden="true">
    <header className="lc-print-sheet__header">
      <h1>{APP_INFO.name} 访问密钥恢复码</h1>
      <p className="lc-print-sheet__meta">
        共 {codes.length} 枚 · 生成时间：{formatMoment(createdAt)}
      </p>
    </header>

    <p className="lc-print-sheet__lead">
      下面每一行都是一份<strong>完整且独立</strong>的恢复码，各能使用一次。
      忘记访问密钥时，在解锁界面点击「忘记访问密钥？用恢复码重置」，
      输入其中任意一枚即可。
    </p>

    <ol className="lc-print-sheet__codes">
      {codes.map((code, index) => (
        <li key={`${code}-${index}`}>
          <span className="lc-print-sheet__index">{index + 1}</span>
          <span className="lc-print-sheet__value">{code}</span>
        </li>
      ))}
    </ol>

    <section className="lc-print-sheet__body">
      <h2>请注意</h2>
      <ul>
        <li>这些恢复码<strong>只显示过一次</strong>，{APP_INFO.name} 不保存它们的原文。</li>
        <li>每一枚使用一次后即失效。</li>
        <li>重新生成会使这张纸上的<strong>全部</strong>恢复码作废，只保留最新一批。</li>
        <li>请勿只把这台电脑当作保存位置 —— 设备损坏或重装时它会一起消失。</li>
      </ul>

      <p className="lc-print-sheet__footer">
        {APP_INFO.name} · 作者 {APP_INFO.author} · {APP_INFO.homepage}
      </p>
    </section>
  </div>
);

export default RecoveryPrintSheet;
