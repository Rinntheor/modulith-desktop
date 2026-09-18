// src/components/Notifications/ToastLayer.tsx
//
// 右下角的浮层提示。
//
// 只负责渲染 `services/toast.ts` 里的队列，不生产提示 —— 通知（持久化那套）
// 在推送时也会往这个队列里放一条，因此插件发来的通知同样会在这里弹出。
//
// 三个必须做对的细节：
//
//   1. **悬停暂停，而不是悬停后重新计时。** 用户把鼠标移上去通常是想读，
//      如果只是「暂停」而移开后又从头计时，等于没暂停。这里记录剩余时间，
//      移开时从剩余量继续。
//   2. **错误的停留时长是 0（不自动消失）。** 见 services/toast.ts 的说明：
//      出错时用户需要读完再决定怎么办。
//   3. **更新提示走 `variant === 'update'` 的另一套外观，且不自动消失。**
//      它表达的不是「发生了一件事」而是「有一件事等你决定」，与其余提示
//      混在一起就失去了意义。见 services/toast.ts 的 `ToastVariant`。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Download, Info, X, XCircle } from 'lucide-react';
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
  onOpenUpdate: () => void;
}> = ({ toast, onDismiss, onOpenCenter, onOpenUpdate }) => {
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

  const isUpdate = toast.variant === 'update';
  const { icon: LevelIcon, iconClass, barClass } = LEVEL_STYLE[toast.level];
  const Icon = isUpdate ? Download : LevelIcon;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={`pointer-events-auto relative w-80 overflow-hidden rounded-xl border shadow-lg ${
        // 更新提示整块用强调色：一条白底卡片和别的提示没有区别，
        // 而它恰恰是最不该被扫过去的一条
        isUpdate ? 'border-indigo-200 bg-indigo-50' : 'border-gray-200 bg-white'
      }`}
    >
      {/* 左侧色条：一眼分辨级别，不必先读文字 */}
      <span className={`absolute inset-y-0 left-0 w-1 ${barClass}`} />

      <div className="flex items-start gap-2.5 py-2.5 pl-4 pr-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${isUpdate ? 'text-indigo-600' : iconClass}`} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p
              className={`text-xs font-medium break-words ${
                isUpdate ? 'text-indigo-900' : 'text-gray-900'
              }`}
            >
              {toast.title}
            </p>
            {isUpdate && (
              <span className="rounded bg-indigo-600 px-1.5 py-[1px] text-[10px] font-medium leading-4 text-white">
                更新
              </span>
            )}
          </div>

          {toast.body && (
            <p
              className={`mt-1 text-[11px] leading-relaxed break-words ${
                isUpdate ? 'text-indigo-800/80' : 'text-gray-500'
              }`}
            >
              {toast.body}
            </p>
          )}

          {isUpdate && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  onOpenUpdate();
                  onDismiss(toast.id);
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-indigo-700"
              >
                <Download className="h-3 w-3" />
                查看更新
              </button>
              {/*
                这条提示不自动消失，因此必须给一个明确的"先放着"出口 ——
                只有一个角落里的 × 会让人不确定该怎么让它走开。
                关掉浮层不会丢失信息：通知中心里那条仍然在。
              */}
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                className="rounded-lg border border-indigo-200 px-2.5 py-1 text-[11px] font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
              >
                稍后
              </button>
            </div>
          )}

          {/* 来自模块的通知给一个去通知中心的入口；宿主自身的提示不需要 */}
          {!isUpdate && toast.source && toast.source !== 'host' && (
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
  /** 「查看更新」的去处：设置 → 关于 的更新卡片 */
  onOpenUpdate: () => void;
}

const ToastLayer: React.FC<ToastLayerProps> = ({ onOpenCenter, onOpenUpdate }) => {
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
            onOpenUpdate={onOpenUpdate}
          />
        ))}
      </AnimatePresence>
    </div>
  );
};

export default ToastLayer;
