// src/components/NetPromptLayer.tsx
//
// 「默认询问」档的询问对话框。
//
// ============================================================
// 它为什么挂在 main.tsx 而不是 Home 里
// ============================================================
//
// 因为它必须**在任何界面之上都能出现**：
//
//   · 出站请求可能发生在启动阶段（自动检查更新）与解锁界面，而那时 `Home`
//     还没挂载 —— 挂在 Home 里会让那些请求无人可问，只能在 30 秒后超时；
//   · 它必须盖住设置对话框。用户在「设置 → 网络」里点一次网络诊断，
//     诊断自己就会发请求，而对话框如果压在设置面板下面，用户根本点不到它。
//
// 因此：挂在 `BootGate` 外面，层级取 `z-90`（高于全部交互层 —— 设置面板 z-60、
// 插件弹窗 z-70、拖拽幽灵 z-80；低于 AppErrorBoundary 的 z-100，那个界面会整个
// 替换 UI，压在它上面没有意义）。
//
// ============================================================
// 三个交互决定
// ============================================================
//
// 1. **点背景不关闭。** 这不是一条提示，而是一个等待答案的问题；点空白处让它
//    消失，只会让用户以为自己答过了，而请求其实在等（或已经超时）。
// 2. **Esc 等于拒绝。** 键盘用户总要有出路，而"关掉对话框"在这类问题里唯一
//    安全的解释是拒绝 —— 与本项目"不可判定等同于不可信"的取向一致。
// 3. **不给任何按钮自动焦点。** 自动聚焦到一个"允许"上，会让一次无意的回车
//    变成一次对外请求的放行。
//
// 倒计时由后端给的 `timeoutMs` 驱动，前端不写死数字：两处各写一份必然漂移，
// 而漂移的表现是"界面还在倒数，后端已经按超时拒绝了"。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, Ban, Check, Globe, Timer } from 'lucide-react';

import {
  NET_PROMPT_CLOSED_EVENT,
  NET_PROMPT_EVENT,
  answerNetPrompt,
  describeSource,
  type NetPrompt,
} from '../services/netControl';

/** 把剩余毫秒变成"12 秒"这样的短语 */
function remainingLabel(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))} 秒`;
}

const NetPromptLayer: React.FC = () => {
  const [queue, setQueue] = useState<NetPrompt[]>([]);
  const [busy, setBusy] = useState(false);
  /** 递减用的"现在"，每 250ms 更新一次；只用它算倒计时，不参与任何判定 */
  const [now, setNow] = useState(() => Date.now());
  /** 每条询问到达的本地时刻，用来算剩余时间 */
  const arrivedAt = useRef(new Map<number, number>());

  const remove = useCallback((id: number) => {
    arrivedAt.current.delete(id);
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    const subscribe = async () => {
      // 两条监听都是**后端的通知**：一条是新的询问，一条是"这条询问结束了"
      // （超时，或已被别处答过）。少了第二条，界面会停在后端已经放弃的询问上。
      const offPrompt = await listen<NetPrompt>(NET_PROMPT_EVENT, (event) => {
        if (!alive) return;
        const prompt = event.payload;
        arrivedAt.current.set(prompt.id, Date.now());
        setQueue((prev) =>
          prev.some((item) => item.id === prompt.id) ? prev : [...prev, prompt]
        );
      });

      const offClosed = await listen<number>(NET_PROMPT_CLOSED_EVENT, (event) => {
        if (!alive) return;
        remove(event.payload);
      });

      // 订阅是异步建立的：如果组件在 await 期间就卸载了，这两条监听必须立刻
      // 解除，否则它们会一直活下去（StrictMode 下这个窗口是真实存在的）。
      if (!alive) {
        offPrompt();
        offClosed();
        return;
      }
      unlisteners.push(offPrompt, offClosed);
    };

    void subscribe();
    return () => {
      alive = false;
      unlisteners.forEach((off) => off());
    };
  }, [remove]);

  const current = queue[0];

  // 只在真的有询问时跑计时器。常驻定时器会在用户看不见它的时候继续唤醒主线程，
  // 而这个组件是**挂在应用最外层**的 —— 常驻等于给每一次启动都加一份开销。
  useEffect(() => {
    if (!current) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [current]);

  const answer = useCallback(
    async (allow: boolean, rememberHost: boolean) => {
      if (!current || busy) return;
      setBusy(true);
      try {
        await answerNetPrompt(current.id, allow, rememberHost);
      } catch {
        // 后端不可达时**不重试**：这条询问已经无法被回答，而后端会在自己的
        // 超时里按拒绝处理。把错误抛到界面只会让用户看到一个他无法处理的报错。
      } finally {
        setBusy(false);
        remove(current.id);
      }
    },
    [busy, current, remove]
  );

  // Esc = 拒绝。绑在 window 上而不是对话框上：焦点可能还在别处。
  useEffect(() => {
    if (!current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void answer(false, false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [answer, current]);

  if (!current) return null;

  const startedAt = arrivedAt.current.get(current.id) ?? now;
  const left = current.timeoutMs - (now - startedAt);

  return (
    <div
      className="fixed inset-0 z-90 flex items-center justify-center bg-gray-900/50 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="net-prompt-title"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4">
          <Globe className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
          <div className="min-w-0 flex-1">
            <p id="net-prompt-title" className="text-sm font-semibold text-gray-900">
              有程序要联网，要不要放行？
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
              出站策略现在是「默认询问」。放行只作用于这一次，除非你选择记住这个主机。
            </p>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            {describeSource(current.source)}
          </p>
          <p className="mt-1 text-sm text-gray-800">{current.purpose}</p>

          <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5">
            <p className="flex items-center gap-2 text-[11px] text-gray-500">
              <span className="rounded bg-white px-1.5 py-0.5 font-medium text-gray-700">
                {current.method}
              </span>
              <span className="break-all font-mono text-[11px] text-gray-700">
                {current.url}
              </span>
            </p>
            <p className="mt-1.5 text-[11px] text-gray-500">
              主机 <span className="font-medium text-gray-700">{current.host}</span>
            </p>
          </div>

          {current.queued > 1 && (
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-700">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              还有 {current.queued - 1} 条请求在排队等同一个答案。选「本次运行内总是允许」
              可以让它们直接通过。
            </p>
          )}

          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-500">
            <Timer className="h-3.5 w-3.5" />
            {left > 0 ? (
              <>
                <span className="tabular-nums">{remainingLabel(left)}</span>
                后自动按拒绝处理 —— 不回答不会被当成同意。
              </>
            ) : (
              '已超时，正在按拒绝处理。'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(false, false)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            <Ban className="h-3.5 w-3.5" />
            拒绝
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(true, true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            本次运行内总是允许 {current.host}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(true, false)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            只允许这一次
          </button>
        </div>
      </div>
    </div>
  );
};

export default NetPromptLayer;
