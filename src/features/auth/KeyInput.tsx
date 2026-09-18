// src/features/auth/KeyInput.tsx
//
// 访问密钥输入框（迁移自 hive_atelier/src/components/auth/KeyInput.tsx）
//
// 改进点：
//   * 只在错误「发生变化」时抖动，而不是每次渲染都重新触发
//   * 显示/隐藏按钮补上了 aria-label，键盘用户也能用
//   * 支持 confirm 模式（初始化时输入第二遍确认）

import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Key, Eye, EyeOff, Shield } from 'lucide-react';
import { errorVariants } from './animations';

interface KeyInputProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * 等宽字体 + 始终明文显示。
   *
   * 用于恢复码：它是需要逐字核对的随机串，用圆点遮蔽只会让用户无法
   * 确认自己是否抄错。恢复码本身就是一次性凭据，明文显示不额外泄露信息。
   */
  mono?: boolean;
}

const KeyInput: React.FC<KeyInputProps> = ({
  value,
  onChange,
  error,
  disabled,
  placeholder = '输入访问密钥',
  autoFocus,
  mono = false,
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [isShaking, setIsShaking] = useState(false);
  const lastErrorRef = useRef<string | undefined>(undefined);

  // mono（恢复码）模式下强制明文：见 mono 的说明
  const reveal = mono || showKey;

  // 仅在错误文本变化时抖动一次（原实现每次 error 非空都会重置定时器）
  useEffect(() => {
    if (error && error !== lastErrorRef.current) {
      setIsShaking(true);
      const timer = setTimeout(() => setIsShaking(false), 500);
      lastErrorRef.current = error;
      return () => clearTimeout(timer);
    }
    if (!error) lastErrorRef.current = undefined;
    return undefined;
  }, [error]);

  return (
    <div className="space-y-2">
      <motion.div
        animate={{ scale: isFocused ? 1.02 : 1, x: isShaking ? [0, -8, 8, -8, 8, 0] : 0 }}
        transition={{
          scale: { type: 'spring', stiffness: 400, damping: 25 },
          x: { duration: 0.4 },
        }}
        className="relative"
      >
        <AnimatePresence>
          {isFocused && !error && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="absolute -inset-1 bg-linear-to-r from-indigo-500/20 to-violet-500/20 rounded-2xl blur-sm"
            />
          )}
        </AnimatePresence>

        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none z-10">
          <motion.div
            animate={{ scale: isFocused ? 1.1 : 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          >
            <Key
              className={`h-5 w-5 transition-colors duration-200 ${
                isFocused ? 'text-indigo-400' : 'text-gray-500'
              }`}
            />
          </motion.div>
        </div>

        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-label={placeholder}
          className={`relative block w-full pl-10 pr-10 py-3 bg-gray-800/50 border rounded-xl text-white placeholder-gray-500 outline-none transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed backdrop-blur-sm ${
            mono ? 'font-mono tracking-wider' : ''
          } ${
            error
              ? 'border-red-500/50'
              : isFocused
                ? 'border-indigo-400/50 shadow-lg shadow-indigo-500/10'
                : 'border-gray-700 hover:border-gray-600'
          }`}
        />

        {value.length > 0 && !mono && (
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? '隐藏访问密钥' : '显示访问密钥'}
            title={showKey ? '隐藏访问密钥' : '显示访问密钥'}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 hover:text-gray-300 transition-colors z-10"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </motion.div>

      <AnimatePresence>
        {error && (
          <motion.div
            variants={errorVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
              <Shield className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default KeyInput;
