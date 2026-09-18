// src/components/Notifications/ToastLayer.tsx
//
// 右下角的浮层提示。
//
// 只负责渲染 `services/toast.ts` 里的队列，不生产提示 —— 通知（持久化那套）
// 在推送时也会往这个队列里放一条，因此插件发来的通知同样会在这里弹出。
//
// 两个必须做对的细节：
//
//   1. **悬停暂停，而不是悬停后重新计时。** 用户把鼠标移上去通常是想读，
//      如果只是「暂停」而移开后又从头计时，等于没暂停。这里记录剩余时间，
//      移开时从剩余量继续。
//   2. **错误的停留时长是 0（不自动消失）。** 见 services/toast.ts 的说明：
//      出错时用户需要读完再决定怎么办。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  dismissToast,
  getToasts,
  subscribeToasts,
  type Toast,
  type ToastLevel,
} from '../../services/toast';

/** 各级别的图标与配色。红/琥珀/翠绿是语义色，不参与主题配色替换 */
const LEVEL_STYLE: Record<
  ToastLevel,
  { icon: React.ComponentType<{ className?: string }>; iconClass: string; barClass: string }
> = {
  info: { icon: Info, iconClass: 'text-indigo-500', barClass: 'bg-indigo-500' },
  success: { icon: CheckCircle2, iconClass: 'text-emerald-500', barClass: 'bg-emerald-500' },
  warning: { icon: AlertTriangle, iconClass: 'text-amber-500', barClass: 'bg-amber-500' },
  error: { icon: XCircle, iconClass: 'text-red-500', barClass: 'bg-red-500' },
};

const ToastItem: React.FC<{
  toast: Toast;
  onDismiss: (id: string) => void;
  onOpenCenter: () => void;
}> = ({ toast, onDismiss, onOpenCenter }) => {
  const [paused, setPaused] = useState(false);
  // 剩余可显示时间。悬停时扣减，移开后从剩余量继续计时
  const remainingRef = useRef(toast.durationMs);

  useEffect(() => {
    if (toast.durationMs <= 0) return;
    if (paused) return;

    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remainingRef.current);

    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [paused, toast.id, toast.durationMs, onDismiss]);

  const { icon: Icon, iconClass, barClass } = LEVEL_STYLE[toast.level];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="pointer-events-auto relative w-80 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg"
    >
      {/* 左侧色条：一眼分辨级别，不必先读文字 */}
      <span className={`absolute inset-y-0 left-0 w-1 ${barClass}`} />

      <div className="flex items-start gap-2.5 py-2.5 pl-4 pr-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconClass}`} />

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-gray-900 break-words">{toast.title}</p>
          {toast.body && (
            <p className="mt-1 text-[11px] leading-relaxed text-gray-500 break-words">
              {toast.body}
            </p>
          )}

          {/* 来自模块的通知给一个去通知中心的入口；宿主自身的提示不需要 */}
          {toast.source && toast.source !== 'host' && (
            <button
              type="button"
              onClick={() => {
                onOpenCenter();
                onDismiss(toast.id);
              }}
              className="mt-1.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
            >
              查看通知中心
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="关闭提示"
          className="shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </motion.div>
  );
};

export interface ToastLayerProps {
  onOpenCenter: () => void;
}

const ToastLayer: React.FC<ToastLayerProps> = ({ onOpenCenter }) => {
  const [toasts, setToasts] = useState<Toast[]>(() => getToasts());

  useEffect(() => subscribeToasts(() => setToasts(getToasts())), []);

  const handleDismiss = useCallback((id: string) => dismissToast(id), []);

  return (
    // `pointer-events-none` 让这一层不挡住下面的界面；单个提示再打开点击
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex flex-col items-end gap-2"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            onDismiss={handleDismiss}
            onOpenCenter={onOpenCenter}
          />
        ))}
      </AnimatePresence>
    </div>
  );
};

export default ToastLayer;
