// src/features/auth/RecoveryCodePanel.tsx
//
// 恢复码展示面板（只在生成的那一刻出现一次）。
//
// 形态：**一组互不相干的短恢复码，每枚各用一次**（见后端 `RECOVERY_CODE_COUNT`）。
//
// 为什么是"一组"而不是"一枚长码"—— 这是一处真实的设计修正：
//
//   最初只发一枚 32 字符的长码，界面上按 4 字符分组显示。结果用户把它读成
//   "八个恢复码"，只输入其中一组，于是每次都报错；而且他无法自行判断到底
//   该输整串还是输一组。**歧义的根源是形态本身**：一整串按组分隔的字符
//   既像一个码，也像八个码。
//
//   现在每个恢复码是列表里的**一行**，带序号、各是一份完整凭据：
//     * 不存在"要不要全输"的疑问 —— 一行就是一个码；
//     * 丢了几枚还有其余可用，不必因为抄漏一枚就作废全部；
//     * 与 GitHub / Google 的备份码形态一致，用户已有心智模型。
//
// ---------------------------------------------------------------------------
// 关于配色（一处真实的返工）：
//
// 这个面板最初是给**深色授权界面**写的，用了大量半透明色
// （`bg-white/15`、`border-white/40`、`text-gray-100`）。后来它被复用到
// 「设置 → 安全」里 —— 那里是**浅色卡片**，于是同一套半透明色叠在浅底上
// 变成了灰蒙蒙的一片：文字和按钮的边界都看不清，用户无法辨认信息与按钮位置。
//
// 现在改为**不依赖背景色**的中性配色：
//   * 用实色（`bg-*` 不加透明度）而不是半透明叠加；
//   * 恢复码区域固定深色底 + 白字（无论宿主是深色还是浅色都保证最高对比度，
//     它本来就是全场最该被看清的东西）；
//   * 按钮用实色底 + 实色边框，不再依赖"背景透出来"形成对比。
// ---------------------------------------------------------------------------

import React, { useCallback, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Copy, Printer, TriangleAlert, KeyRound, Loader2 } from 'lucide-react';
import RecoveryPrintSheet from './RecoveryPrintSheet';

interface RecoveryCodePanelProps {
  /** 后端返回的恢复码（形如 `XXXXX-XXXXX-XXXXX-XXXXX`） */
  codes: string[];
  /** 用户确认已保存后继续（解锁 / 进入应用） */
  onContinue: () => void | Promise<void>;
  /**
   * 场景说明，只影响提示条的第一句话。
   *
   *   * `setup`       —— 首次创建访问密钥时一并生成；
   *   * `regenerate`  —— 用户在「设置 → 安全」主动重新生成。
   *
   * 刻意**不再有 `reset`**：重置访问密钥现在只作废用掉的那一枚、
   * 不换发新码，因此不会再从这个入口展示恢复码。
   */
  reason: 'setup' | 'regenerate';
  /** 生成时间，用于打印件的时间戳 */
  createdAt?: string | null;
}

const RecoveryCodePanel: React.FC<RecoveryCodePanelProps> = ({
  codes,
  onContinue,
  reason,
  createdAt,
}) => {
  /** 已复制的目标：`all` 或某一枚的下标 */
  const [copied, setCopied] = useState<'all' | number | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 全部恢复码拼成一块文本（每行一枚），适合直接粘进密码管理器 */
  const allText = useMemo(() => codes.join('\n'), [codes]);

  const copyText = useCallback(async (text: string, target: 'all' | number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(target);
      setError(null);
      setTimeout(() => setCopied(null), 2500);
    } catch (err) {
      // 剪贴板权限可能被系统拒绝：如实告知，并引导手动抄写
      setError(
        `复制失败（${err instanceof Error ? err.message : String(err)}）。请手动抄写下面的恢复码。`
      );
    }
  }, []);

  /**
   * 存为 PDF。
   *
   * 走系统打印对话框的「另存为 PDF」，不引入 PDF 生成依赖。
   * 打印内容由 `RecoveryPrintSheet` 提供，样式见 index.css 的 @media print 段。
   */
  const handlePrint = useCallback(() => {
    try {
      window.print();
      setError(null);
    } catch (err) {
      setError(
        `无法打开打印对话框（${err instanceof Error ? err.message : String(err)}）。请改用「复制全部」后自行保存。`
      );
    }
  }, []);

  const handleContinue = useCallback(async () => {
    setContinuing(true);
    try {
      await onContinue();
    } finally {
      setContinuing(false);
    }
  }, [onContinue]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* 提示条：实色底 + 实色边框，不依赖背景透出 */}
      <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-amber-50 border border-amber-300">
        <TriangleAlert className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="text-xs text-amber-900 leading-relaxed">
          <p>
            这是你的<span className="font-semibold">恢复码</span>，
            {reason === 'setup'
              ? '在创建访问密钥时一并生成。'
              : '已重新生成，此前那套恢复码全部作废。'}
          </p>
          <p className="mt-1.5">
            一共 {codes.length} 枚，
            <strong>每一枚都是一份完整的恢复码</strong>，各能用一次。
            忘记访问密钥时输入任意一枚即可。
          </p>
          <p className="mt-1.5">
            它们<strong>只显示这一次</strong>
            ：后端只保存哈希，关闭本页面后任何人都无法再取回。
          </p>
        </div>
      </div>

      {/*
        恢复码列表：一枚一行，带序号，各带独立的复制按钮。

        底色固定为深色（gray-900）、文字固定为白色 —— 这样无论面板被放在
        深色授权界面还是浅色设置页里，恢复码本身都是全场对比度最高的内容。
        此前用半透明底时，它在浅色卡片上几乎看不清。
      */}
      <div className="rounded-xl border border-gray-700 bg-gray-900 divide-y divide-gray-700 overflow-hidden">
        {codes.map((code, index) => (
          <div
            key={`${code}-${index}`}
            className="flex items-center gap-2 px-3 py-2.5 hover:bg-gray-800 transition-colors"
          >
            <span className="w-5 shrink-0 text-[11px] font-mono text-gray-400 tabular-nums">
              {index + 1}
            </span>
            <code
              className="flex-1 min-w-0 font-mono text-sm tracking-[0.12em] text-white truncate select-all"
              title={code}
            >
              {code}
            </code>
            <button
              type="button"
              onClick={() => copyText(code, index)}
              title={`复制第 ${index + 1} 枚恢复码`}
              aria-label={`复制第 ${index + 1} 枚恢复码`}
              className="shrink-0 p-1.5 rounded-md text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
            >
              {copied === index ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => copyText(allText, 'all')}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 px-3 py-2.5 text-xs font-semibold text-white transition-colors"
        >
          {copied === 'all' ? (
            <>
              <Check className="w-3.5 h-3.5" />
              已复制全部 {codes.length} 枚
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              复制全部 {codes.length} 枚
            </>
          )}
        </button>
        <button
          type="button"
          onClick={handlePrint}
          title="在打印对话框中选择「另存为 PDF」"
          className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-white border border-gray-300 hover:bg-gray-100 px-3 py-2.5 text-xs font-semibold text-gray-800 transition-colors"
        >
          <Printer className="w-3.5 h-3.5" />
          存为 PDF / 打印
        </button>
      </div>

      {error && <p className="text-[11px] text-red-600 break-all leading-relaxed">{error}</p>}

      {/* 建议的保存位置：给出可执行的选项，而不是一句「请妥善保管」 */}
      <ul className="text-[11px] text-gray-600 space-y-1 leading-relaxed">
        <li>· 用「复制全部 {codes.length} 枚」一次性保存到密码管理器的备注字段</li>
        <li>· 用「存为 PDF / 打印」得到一份文件或纸质件，放在只有你能拿到的地方</li>
        <li>· 不要只存在这台电脑上——设备损坏时它会一起消失</li>
        <li>· 用过一枚就作废一枚；在「设置 → 安全」里可以随时重新生成整套</li>
      </ul>

      <label className="flex items-start gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-400 accent-indigo-600"
        />
        <span className="text-xs text-gray-700 leading-relaxed">
          我已保存好这 {codes.length} 枚恢复码，并理解它们只显示这一次、丢失后无法找回。
        </span>
      </label>

      <button
        type="button"
        disabled={!acknowledged || continuing}
        onClick={handleContinue}
        className="w-full flex items-center justify-center gap-2 rounded-xl bg-linear-to-r from-indigo-600 to-violet-600 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition-all disabled:cursor-not-allowed disabled:opacity-40"
      >
        {continuing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            处理中…
          </>
        ) : (
          <>
            <KeyRound className="h-4 w-4" />
            我已保存，继续
          </>
        )}
      </button>

      {/* 打印视图：屏上不可见，仅 @media print 时呈现 */}
      <RecoveryPrintSheet codes={codes} createdAt={createdAt} />
    </motion.div>
  );
};

export default RecoveryCodePanel;
