// src/features/boot/BootScreen.tsx
//
// 启动加载界面。
//
// 展示的全是真实数据：
//   * 进度 = 各步骤真实完成量的加权折算（见 services/boot.ts）
//   * 步骤列表来自实际的初始化管线，逐项显示 等待 / 进行中 / 完成 / 跳过 / 失败
//   * 细节行显示真实工作内容（例如「正在加载 xxx 插件」「发现 3 个已启用插件」）
//   * 耗时是真实经过的毫秒数
//   * 失败时给出可读原因并提供重试，不会假装成功

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check,
  ChevronRight,
  Loader2,
  Minus,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import {
  bootManager,
  subscribeBoot,
  type BootState,
  type BootStepState,
} from '../../services/boot';
import AppLogo from '../../components/icons/AppLogo';

/** 步骤状态图标 */
const StepIcon: React.FC<{ step: BootStepState }> = ({ step }) => {
  switch (step.status) {
    case 'done':
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20">
          <Check className="h-2.5 w-2.5 text-emerald-400" />
        </span>
      );
    case 'running':
      return <Loader2 className="h-4 w-4 text-indigo-400 animate-spin" />;
    case 'failed':
      return <TriangleAlert className="h-4 w-4 text-red-400" />;
    case 'skipped':
      return <Minus className="h-4 w-4 text-gray-600" />;
    default:
      return <span className="h-4 w-4 rounded-full border border-gray-700" />;
  }
};

const StepRow: React.FC<{ step: BootStepState; isCurrent: boolean }> = ({ step, isCurrent }) => (
  <div
    className={`flex items-start gap-2.5 py-1.5 transition-opacity ${
      step.status === 'pending' ? 'opacity-40' : 'opacity-100'
    }`}
  >
    <div className="pt-0.5 shrink-0">
      <StepIcon step={step} />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span
          className={`text-xs ${
            isCurrent ? 'text-gray-100 font-medium' : 'text-gray-400'
          }`}
        >
          {step.label}
        </span>
        {step.unitsTotal > 0 && (
          <span className="text-[10px] text-gray-500 font-mono shrink-0">
            {step.unitsDone}/{step.unitsTotal}
          </span>
        )}
        {step.durationMs !== undefined && (
          <span className="text-[10px] text-gray-600 font-mono shrink-0 ml-auto">
            {step.durationMs}ms
          </span>
        )}
      </div>
      {step.detail && (
        <p
          className={`text-[11px] mt-0.5 truncate ${
            step.status === 'failed' ? 'text-red-400' : 'text-gray-500'
          }`}
          title={step.detail}
        >
          {step.detail}
        </p>
      )}
      {step.error && (
        <p className="text-[11px] mt-0.5 text-red-400 break-all">{step.error}</p>
      )}
    </div>
  </div>
);

const BootScreen: React.FC = () => {
  const [state, setState] = useState<BootState>(() => bootManager.getState());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => subscribeBoot(() => setState(bootManager.getState())), []);

  // 只用于展示「已用时」；不参与任何进度计算
  useEffect(() => {
    if (state.phase !== 'running' && state.phase !== 'awaiting-auth') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [state.phase]);

  const elapsed =
    state.startedAt === null
      ? 0
      : (state.finishedAt ?? now) - state.startedAt;

  const failed = state.phase === 'failed';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-linear-to-br from-gray-900 via-gray-800 to-gray-900 overflow-hidden">
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl" />

      {/* pt-10 给顶部的窗口边框（BootChrome，高 2.5rem）留出空间 */}
      <div className="relative w-full max-w-md px-8 pt-10">
        {/* 应用标识 */}
        <div className="mb-8 text-center">
          <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 240, damping: 20 }}
            className="mx-auto mb-5 w-16 h-16"
          >
            <motion.div
              animate={{ scale: [1, 1.06, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            >
              {/* 启动界面本就是深色，用带底板的主视觉版本 */}
              <AppLogo className="w-16 h-16" withSurface shadow />
            </motion.div>
          </motion.div>

          <h1 className="text-xl font-bold text-white">Modulith Desktop</h1>
          <p className="mt-1 text-xs text-gray-500">
            {failed ? '初始化失败' : state.phase === 'ready' ? '初始化完成' : '正在初始化…'}
          </p>
        </div>

        {/* 真实进度条 */}
        <div className="mb-4">
          <div className="h-1 overflow-hidden rounded-full bg-gray-700/70">
            <motion.div
              className={`h-full rounded-full ${
                failed
                  ? 'bg-linear-to-r from-red-500 to-red-400'
                  : 'bg-linear-to-r from-indigo-500 to-violet-500'
              }`}
              animate={{ width: `${state.progress}%` }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
            <span className="flex items-center gap-1.5">
              <Zap className="h-3 w-3" />
              {state.currentStepId ?? (state.phase === 'ready' ? '完成' : '准备中')}
            </span>
            <span className="font-mono">
              {state.progress}% · {elapsed}ms
            </span>
          </div>
        </div>

        {/* 步骤清单 */}
        <div className="rounded-xl border border-gray-700/50 bg-gray-800/40 backdrop-blur-sm px-4 py-3">
          {state.steps.map((step) => (
            <StepRow key={step.id} step={step} isCurrent={state.currentStepId === step.id} />
          ))}
        </div>

        {/* 失败：原因 + 重试 */}
        <AnimatePresence>
          {failed && state.error && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3"
            >
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-red-300">初始化中断</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-red-200/80 break-all">
                    {state.error.message}
                  </p>
                </div>
              </div>
              <button
                onClick={() => void bootManager.retry()}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-2 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/30"
              >
                <RotateCw className="h-3.5 w-3.5" />
                重试初始化
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 非致命告警 */}
        {!failed && state.warnings.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <div className="min-w-0 space-y-0.5">
                <p className="text-[11px] text-amber-200">
                  {state.warnings.length} 项非关键步骤未完成（不影响使用）
                </p>
                {state.warnings.map((warning, index) => (
                  <p key={index} className="text-[10px] text-amber-200/70 break-all">
                    <ChevronRight className="inline h-2.5 w-2.5" /> {warning}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BootScreen;
